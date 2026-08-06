// Auto-update decisions, kept free of `electron` and `electron-updater` so they
// can be unit tested -- same split as store.js -> settings-persistence.js.
// main.js injects the real autoUpdater.
//
// Windows only, deliberately. Squirrel.Mac refuses to apply an update unless the
// app is code signed, and cue's macOS builds are unsigned (build.mac.identity is
// null in package.json). A macOS updater could therefore only ever fail, so the
// gate below never opens on darwin rather than shipping a path that errors on
// every launch. If macOS signing lands later, that is the line to revisit.

// electron-updater throws without a dev-app-update.yml, and main.js's
// uncaughtException handler would swallow it invisibly on every `npm start` --
// so development is excluded too.
function shouldAutoUpdate({ platform, isPackaged }) {
  return platform === 'win32' && isPackaged === true;
}

// The single piece of UI this feature has. It goes to the same transient status
// toast as everything else (auto-hides after 11s), never a dialog: cue is
// click-through and sits over screen shares, so a modal would land in the
// user's meeting.
function updateReadyMessage(info) {
  const version = (info && info.version) ? ' ' + info.version : '';
  return 'Update' + version + ' downloaded — it will install the next time you quit cue.';
}

// Wires the updater and kicks off a single check. Returns the check's promise so
// callers can await it in tests; rejections are already handled here.
//
// One check per launch is deliberate: the install only applies on quit, so a
// periodic re-check would find the same pending update and change nothing.
function wireAutoUpdater({ autoUpdater, onStatus, log }) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Attached before checkForUpdates(): an 'error' event with no listener throws,
  // and on the main process that would take the whole overlay down over a
  // failed network call.
  autoUpdater.on('error', (err) => log('[cue] update check failed: ' + ((err && err.message) || err)));

  // Only fires once the bits are on disk, so the message is always actionable.
  // Deliberately nothing on checking-for-update / update-available /
  // update-not-available -- a toast on every launch is noise in an overlay.
  autoUpdater.on('update-downloaded', (info) => onStatus(updateReadyMessage(info)));

  // Called synchronously so the check is genuinely in flight when this returns.
  // The try/catch and the .catch cover the two different ways this can fail:
  // checkForUpdates can throw outright (misconfigured feed) or reject (offline).
  try {
    return Promise.resolve(autoUpdater.checkForUpdates())
      .catch((err) => log('[cue] update check failed: ' + ((err && err.message) || err)));
  } catch (err) {
    log('[cue] update check failed: ' + ((err && err.message) || err));
    return Promise.resolve();
  }
}

module.exports = { shouldAutoUpdate, updateReadyMessage, wireAutoUpdater };
