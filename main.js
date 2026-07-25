const DEBUG = false; // Set to false to disable debug logging
const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell } = require('electron');
const path = require('path');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createLLM, withTimeout } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { appendResumeContext, MAX_RESUME_CONTEXT_CHARS } = require('./src/profile-context');
const { rms16 } = require('./src/wav');
const { appendTurn } = require('./src/transcript');
const { pushCapped } = require('./src/audio-buffer');
const { normalizeShortcut, findCollision, createTriggerGuard } = require('./src/shortcuts');

let win = null;
let registeredShortcuts = {}; // action name -> accelerator currently registered

// Both are user-configurable (Settings); defaults preserve existing behavior/docs.
const SHORTCUT_ACTIONS = {
  assist: { default: 'CommandOrControl+Return', label: 'Assist', run: () => runFeature('assist', '') },
  leetcode: { default: 'CommandOrControl+H', label: 'Solve on screen', run: () => runFeature('leetcode', '') }
};
const QUIT_SHORTCUT = 'CommandOrControl+Shift+X';
const QUIT_LABEL = 'Quit';

// Ignores a second trigger for the same shortcut arriving within this window —
// e.g. OS key-repeat, or a global shortcut and an in-app handler both firing
// for the same physical keypress.
const shouldFireShortcut = createTriggerGuard(400);

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts } — capped by appendTurn to bound memory/token growth
const FLUSH_MS = 3500;
const MIN_BYTES = Math.floor(16000 * 2 * 0.6); // ~0.6s
const RMS_GATE = 240;
let flushTimer = null;
// Safety net so a stuck OS permission dialog / desktopCapturer hang (no
// AbortSignal support there) can't leave state.busy true forever.
const SCREENSHOT_TIMEOUT_MS = 15000;

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;
  win = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: workArea.y + 6,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Invisibility + overlay behavior. Set CUE_NO_PROTECT=1 to disable for debugging.
  win.setContentProtection(!process.env.CUE_NO_PROTECT);            // excluded from screen capture (best-effort)
  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);
  } else {
    win.setAlwaysOnTop(true);
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Defense-in-depth: this window only ever shows its own local index.html.
  // Block any attempt to navigate it elsewhere or spawn child windows/popups.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('did-finish-load', () => win.showInactive());
  win.webContents.on('render-process-gone', (_e, d) => console.log('[cue] renderer gone', JSON.stringify(d)));
  // These two are the only signal we get if the window ends up silently blank:
  // it's frameless, transparent, and click-through by default, so a preload or
  // page-load failure otherwise looks exactly like "the app didn't open."
  win.webContents.on('preload-error', (_e, preloadPath, error) => console.log('[cue] preload error', preloadPath, error && error.stack));
  win.webContents.on('did-fail-load', (_e, code, desc) => console.log('[cue] page failed to load', code, desc));
}

// -------- STT flushing --------
async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES) return;
  if (rms16(pcm) < RMS_GATE) return; // silence gate

  state.transcribing[channel] = true;
  try {
    const settings = store.getSettings();
    const stt = createSTT(settings);
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription key set. Add an OpenAI (Whisper) or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
      return;
    }
    const res = await stt.transcribe(pcm);
    if (res.error) {
      handleSttError(res.error, settings);
      return;
    }
    if (res.text && res.text.trim()) {
      const turn = { channel, text: res.text.trim(), ts: Date.now() };
      appendTurn(transcript, turn);
      if (DEBUG) console.log(`[TRANSCRIPT] ${channel === 'you' ? 'You' : 'Them'}:`, turn.text);
      send('transcript', turn);
    }
  } catch (e) {
    console.log('[stt] error', e && e.message);
  } finally {
    state.transcribing[channel] = false;
  }
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  if (sttDisabled) return;
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found';
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: 'Transcription off: your ' + err.provider + ' key has no access to a speech-to-text model (403). Screen + LeetCode still work. To enable listening: give the key Whisper/transcription access, or add a Gemini key in Settings and reopen.' });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
function setCapturing(active) {
  state.capturing = active;
  if (active) {
    // A fresh "start listening" is an implicit "try again" signal -- without
    // this, one transient STT error (a wifi blip, a sleep/wake cycle) leaves
    // listening silently, permanently dead for the rest of the session even
    // after connectivity recovers, since sttDisabled only ever gets cleared
    // by the user happening to open and save Settings.
    sttDisabled = false;
    startFlushLoop();
  } else {
    stopFlushLoop();
    buffers.you = []; buffers.them = [];
  }
  send('capture:state', { active });
  return active;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (DEBUG) console.log('[DEBUG MAIN] runFeature called:', { mode, userText, isBusy: state.busy });
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) {
    if (DEBUG) console.log('[DEBUG MAIN] mode not found:', mode);
    return;
  }
  state.busy = true;
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null);
    if (DEBUG) console.log('[DEBUG MAIN] LLM settings loaded:', { provider: settings.provider, smart: settings.smart });
    send('llm:start', { userBubble, small: !!def.small });

    if (!llm.ready) {
      if (DEBUG) console.log('[DEBUG MAIN] LLM not ready (missing key or model).');
      send('llm:error', { message: 'Add your ' + settings.provider + ' API key in Settings (gear icon) to start. Model: ' + (llm.model || 'unset') + '.' });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      if (DEBUG) console.log('[DEBUG MAIN] Feature needs screen. Capturing screenshot...');
      try {
        imageDataUrl = await withTimeout(captureScreenshot(), SCREENSHOT_TIMEOUT_MS, null);
        if (DEBUG) console.log('[DEBUG MAIN] Screenshot captured successfully (length:', imageDataUrl.length, ')');
      }
      catch (e) {
        if (DEBUG) console.error('[DEBUG MAIN] Screenshot capture failed:', e);
        send('status', { message: 'Screen capture failed or timed out — grant Screen Recording permission to cue in System Settings, then try again.' });
      }
    }

    const built = def.build({ transcript, userText: userText || '' });
    if (DEBUG) console.log('[DEBUG MAIN] Built prompt. Starting LLM stream...');
    const fullText = await llm.stream({
      system: appendResumeContext(def.system, settings.resumeContext),
      turns: [{ role: 'user', text: built }],
      imageDataUrl,
      onToken: (t) => send('llm:token', { text: t })
    });
    if (DEBUG) console.log('[DEBUG MAIN] Full LLM Output:\n', fullText);
    send('llm:done', {});
  } catch (e) {
    send('llm:error', { message: 'Error: ' + (e && e.message ? e.message : String(e)) });
  } finally {
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('resume-context-limit:get', () => MAX_RESUME_CONTEXT_CHARS);
ipcMain.handle('settings:set', (_e, patch) => { sttDisabled = false; return store.setSettings(patch); });
ipcMain.handle('shortcut:set', (_e, payload) => setShortcut(payload && payload.name, payload && payload.accelerator));
ipcMain.handle('capture:toggle', () => setCapturing(!state.capturing));
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) pushCapped(buffers.you, Buffer.from(arrayBuffer)); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) pushCapped(buffers.them, Buffer.from(arrayBuffer)); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
ipcMain.on('open-pane', (_e, url) => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));

// -------- shortcuts --------
// Bindings currently in effect, keyed the same way findCollision expects
// (action name -> accelerator), plus the fixed Quit binding.
function currentBindings() {
  const bindings = { quit: QUIT_SHORTCUT };
  for (const name of Object.keys(SHORTCUT_ACTIONS)) {
    bindings[name] = registeredShortcuts[name] || SHORTCUT_ACTIONS[name].default;
  }
  return bindings;
}

function registerShortcut(name, accelerator) {
  const def = SHORTCUT_ACTIONS[name];
  if (!def) return { ok: false, error: 'Unknown shortcut.' };

  const next = normalizeShortcut(accelerator) || def.default;
  if (next.length > 80) return { ok: false, error: 'That shortcut is too long.' };

  const collision = findCollision(next, name, currentBindings());
  if (collision) {
    const label = collision === 'quit' ? QUIT_LABEL : (SHORTCUT_ACTIONS[collision] && SHORTCUT_ACTIONS[collision].label) || collision;
    return { ok: false, error: 'That shortcut is already used by ' + label + '.' };
  }

  const previous = registeredShortcuts[name];
  const handler = () => { if (shouldFireShortcut(name)) def.run(); };
  if (previous) globalShortcut.unregister(previous);

  try {
    if (!globalShortcut.register(next, handler)) {
      if (previous) globalShortcut.register(previous, handler);
      return { ok: false, error: 'That shortcut is already in use by another application.' };
    }
  } catch (_) {
    if (previous) globalShortcut.register(previous, handler);
    return { ok: false, error: 'That key combination is not a valid global shortcut.' };
  }

  registeredShortcuts[name] = next;
  return { ok: true, accelerator: next };
}

function setShortcut(name, accelerator) {
  const result = registerShortcut(name, accelerator);
  if (result.ok) store.setSettings({ shortcuts: { [name]: result.accelerator } });
  return result;
}

function registerShortcuts() {
  globalShortcut.register(QUIT_SHORTCUT, () => app.quit());

  const settings = store.getSettings();
  for (const name of Object.keys(SHORTCUT_ACTIONS)) {
    const def = SHORTCUT_ACTIONS[name];
    const configured = settings.shortcuts && settings.shortcuts[name];
    const result = registerShortcut(name, configured || def.default);
    if (!result.ok && configured && configured !== def.default) {
      console.log('[cue] unable to register', name, 'shortcut:', result.error, 'Falling back to default.');
      const fallback = registerShortcut(name, def.default);
      if (fallback.ok) store.setSettings({ shortcuts: { [name]: def.default } });
    }
  }
}

// -------- lifecycle --------
app.whenReady().then(() => {
  if (app.dock) app.dock.hide();

  // Scoped to cue's own window, not just the permission type -- otherwise any
  // WebContents that ever shares the default session (a future <webview>,
  // devtools, an accidental remote navigation) would get mic/screen access
  // with zero prompt, regardless of where it came from.
  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture';
  const isOwnWindow = (wc) => !!(win && wc && wc.id === win.webContents.id);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(isOwnWindow(wc) && allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => isOwnWindow(wc) && allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length) callback({ video: sources[0], audio: 'loopback' });
      else callback();
    }).catch(() => callback());
  }, { useSystemPicker: false });

  // Force a resave through store.setSettings so any API keys still sitting in
  // plaintext from before at-rest encryption existed get migrated immediately,
  // rather than staying plaintext until the user happens to change a setting.
  store.setSettings({});

  createWindow();
  registerShortcuts();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => app.quit());
