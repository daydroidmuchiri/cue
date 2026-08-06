const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { shouldAutoUpdate, updateReadyMessage, wireAutoUpdater } = require('../src/updater');

// Stands in for electron-updater's autoUpdater, which is an EventEmitter with a
// couple of config flags and a promise-returning check.
function fakeAutoUpdater({ checkRejects = null } = {}) {
  const u = new EventEmitter();
  u.checkCalls = 0;
  u.checkForUpdates = () => {
    u.checkCalls++;
    return checkRejects ? Promise.reject(checkRejects) : Promise.resolve({});
  };
  return u;
}

test('shouldAutoUpdate runs only on packaged Windows builds', () => {
  assert.equal(shouldAutoUpdate({ platform: 'win32', isPackaged: true }), true);
});

// electron-updater throws without a dev-app-update.yml, and that throw would hit
// main.js's uncaughtException handler on every `npm start`.
test('shouldAutoUpdate stays off in development', () => {
  assert.equal(shouldAutoUpdate({ platform: 'win32', isPackaged: false }), false);
});

// Squirrel.Mac requires a signed app. cue's macOS builds set identity: null, so a
// macOS updater could only ever fail -- the gate must not open there.
test('shouldAutoUpdate stays off on macOS, where unsigned builds cannot update', () => {
  assert.equal(shouldAutoUpdate({ platform: 'darwin', isPackaged: true }), false);
});

test('shouldAutoUpdate stays off on platforms with no release artifact', () => {
  assert.equal(shouldAutoUpdate({ platform: 'linux', isPackaged: true }), false);
});

test('updateReadyMessage names the version and says when it applies', () => {
  const msg = updateReadyMessage({ version: '0.6.1' });
  assert.match(msg, /0\.6\.1/, 'the user should know which version is staged');
  assert.match(msg, /quit/i, 'and that nothing happens until they quit');
});

test('updateReadyMessage degrades gracefully when the payload has no version', () => {
  const msg = updateReadyMessage({});
  assert.equal(typeof msg, 'string');
  assert.ok(msg.length > 0);
  assert.doesNotMatch(msg, /undefined/, 'never render a raw undefined at the user');
});

test('wireAutoUpdater downloads in the background and defers the install to quit', () => {
  const autoUpdater = fakeAutoUpdater();
  wireAutoUpdater({ autoUpdater, onStatus: () => {}, log: () => {} });
  assert.equal(autoUpdater.autoDownload, true);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true, 'installing mid-meeting is the thing we are avoiding');
  assert.equal(autoUpdater.checkCalls, 1);
});

test('wireAutoUpdater tells the user once, only after the download has landed', () => {
  const autoUpdater = fakeAutoUpdater();
  const seen = [];
  wireAutoUpdater({ autoUpdater, onStatus: (m) => seen.push(m), log: () => {} });

  autoUpdater.emit('checking-for-update');
  autoUpdater.emit('update-available', { version: '0.6.1' });
  assert.deepEqual(seen, [], 'an update that has not finished downloading is not actionable yet');

  autoUpdater.emit('update-downloaded', { version: '0.6.1' });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /0\.6\.1/);
});

// The overlay is transparent and sits over screen shares. A toast on every launch
// that says "you're up to date" is pure noise.
test('wireAutoUpdater stays silent when there is nothing to install', () => {
  const autoUpdater = fakeAutoUpdater();
  const seen = [];
  wireAutoUpdater({ autoUpdater, onStatus: (m) => seen.push(m), log: () => {} });
  autoUpdater.emit('update-not-available', { version: '0.6.0' });
  assert.deepEqual(seen, []);
});

// A failed update check is our problem, not the user's -- they cannot act on it,
// and surfacing it over a meeting is worse than staying on the current version.
test('wireAutoUpdater logs failures instead of surfacing them', () => {
  const autoUpdater = fakeAutoUpdater();
  const seen = [];
  const logged = [];
  wireAutoUpdater({ autoUpdater, onStatus: (m) => seen.push(m), log: (m) => logged.push(m) });

  autoUpdater.emit('error', new Error('ENOTFOUND api.github.com'));
  assert.deepEqual(seen, [], 'never toast an update failure');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /ENOTFOUND/);
});

test('wireAutoUpdater swallows a rejected check rather than crashing the app', async () => {
  const autoUpdater = fakeAutoUpdater({ checkRejects: new Error('offline') });
  const logged = [];
  await wireAutoUpdater({ autoUpdater, onStatus: () => {}, log: (m) => logged.push(m) });
  assert.equal(logged.length, 1, 'the rejection is reported once, to the log');
  assert.match(logged[0], /offline/);
});

// An unhandled 'error' event on an EventEmitter throws. wireAutoUpdater always
// attaches a listener, so this can never take the main process down.
test('wireAutoUpdater attaches an error listener before the check runs', () => {
  const autoUpdater = fakeAutoUpdater();
  wireAutoUpdater({ autoUpdater, onStatus: () => {}, log: () => {} });
  assert.equal(autoUpdater.listenerCount('error'), 1);
});
