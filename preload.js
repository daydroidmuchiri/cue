const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Sandboxed preload scripts (webPreferences.sandbox: true) can't resolve local
// project requires like './src/profile-context' — only main has full Node
// module resolution. resumeContextLimit is delivered via the settings:get IPC
// response instead (see main.js) rather than required directly here.
contextBridge.exposeInMainWorld('cue', {
  setZoomLevel: (level) => webFrame.setZoomLevel(level),
  getZoomLevel: () => webFrame.getZoomLevel(),
  platform: process.platform,
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  resumeContextLimitGet: () => ipcRenderer.invoke('resume-context-limit:get'),
  encryptionAvailableGet: () => ipcRenderer.invoke('encryption:available'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  shortcutSet: (name, accelerator) => ipcRenderer.invoke('shortcut:set', { name, accelerator }),
  ask: (payload) => ipcRenderer.send('ask', payload),
  captureToggle: () => ipcRenderer.invoke('capture:toggle'),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('mouse:ignore', v),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  log: (msg) => ipcRenderer.send('log', msg),
  on: (channel, cb) => {
    const allowed = ['capture:state', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'status', 'transcript'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
