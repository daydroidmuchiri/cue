const assert = require('node:assert/strict');
const test = require('node:test');
const { createSettingsStore } = require('../src/settings-persistence');

// In-memory fake fs — enough surface for settings-persistence.js's atomic
// write (temp file + rename) and corrupt-file backup (rename aside).
function fakeFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  return {
    files,
    readFileSync(path, _enc) {
      if (!files.has(path)) { const e = new Error('ENOENT: ' + path); e.code = 'ENOENT'; throw e; }
      return files.get(path);
    },
    writeFileSync(path, data) { files.set(path, data); },
    renameSync(oldPath, newPath) {
      if (!files.has(oldPath)) { const e = new Error('ENOENT: ' + oldPath); e.code = 'ENOENT'; throw e; }
      files.set(newPath, files.get(oldPath));
      files.delete(oldPath);
    }
  };
}

function workingCipher() {
  return {
    isAvailable: () => true,
    encrypt: (str) => Buffer.from(str, 'utf8').reverse(),
    decrypt: (buf) => Buffer.from(buf).reverse().toString('utf8')
  };
}

function unavailableCipher() {
  return { isAvailable: () => false, encrypt: () => { throw new Error('unavailable'); }, decrypt: () => { throw new Error('unavailable'); } };
}

const DEFAULTS = { provider: 'openai', apiKeys: { openai: '', anthropic: '' } };
const SECRET_FIELDS = ['openai', 'anthropic'];
const FILE = '/fake/cue-data.json';

test('getSettings returns defaults when no file exists yet', () => {
  const store = createSettingsStore({ fs: fakeFs(), filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS });
  assert.deepEqual(store.getSettings().apiKeys, DEFAULTS.apiKeys);
});

test('setSettings persists a key, encrypted at rest', () => {
  const fs = fakeFs();
  const store = createSettingsStore({ fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS });
  store.setSettings({ apiKeys: { openai: 'sk-live-key' } });
  const onDisk = JSON.parse(fs.files.get(FILE));
  assert.ok(onDisk.apiKeys.openai.startsWith('enc:v1:'));
});

test('CRITICAL: a field that fails to decrypt this session is NOT destroyed by the next save', () => {
  // Session 1: key saved successfully while the cipher is available.
  const fs = fakeFs();
  const session1 = createSettingsStore({ fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS });
  session1.setSettings({ apiKeys: { openai: 'sk-precious-real-key' } });
  const originalOnDisk = fs.files.get(FILE);
  assert.ok(JSON.parse(originalOnDisk).apiKeys.openai.startsWith('enc:v1:'));

  // Session 2: a fresh process starts with the cipher unavailable (locked
  // keychain / different machine) and, like main.js does on every boot,
  // immediately triggers a save (e.g. a no-op settings patch).
  const session2 = createSettingsStore({ fs, filePath: FILE, cipher: unavailableCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS });
  session2.setSettings({});

  // The on-disk ciphertext must be untouched -- NOT blanked to "".
  assert.equal(fs.files.get(FILE), originalOnDisk, 'save() must not overwrite ciphertext it could not decrypt this session');

  // Session 3: the cipher becomes available again (keychain unlocked) --
  // the original key must still be recoverable.
  const session3 = createSettingsStore({ fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS });
  assert.equal(session3.getSettings().apiKeys.openai, 'sk-precious-real-key');
});

test('a field that never had a value is unaffected by an unavailable cipher', () => {
  const fs = fakeFs();
  const store = createSettingsStore({ fs, filePath: FILE, cipher: unavailableCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS });
  store.setSettings({ provider: 'anthropic' });
  assert.equal(store.getSettings().apiKeys.openai, '');
});

test('a corrupt (unparseable) settings file is backed up, not silently discarded', () => {
  const fs = fakeFs({ [FILE]: '{not valid json!!' });
  const store = createSettingsStore({ fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS });
  const settings = store.getSettings();
  assert.deepEqual(settings.apiKeys, DEFAULTS.apiKeys); // falls back to defaults, doesn't throw

  const backupPaths = [...fs.files.keys()].filter((p) => p.startsWith(FILE + '.corrupt-'));
  assert.equal(backupPaths.length, 1, 'the corrupt original should be preserved under a backup path');
  assert.equal(fs.files.get(backupPaths[0]), '{not valid json!!');
});

test('a missing file (first run) is not treated as corruption -- no backup created', () => {
  const fs = fakeFs();
  const store = createSettingsStore({ fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS });
  store.getSettings();
  const backupPaths = [...fs.files.keys()].filter((p) => p.startsWith(FILE + '.corrupt-'));
  assert.equal(backupPaths.length, 0);
});

test('save() writes via a temp file then renames into place (atomic write)', () => {
  const writes = [];
  const renames = [];
  const fs = fakeFs();
  const realWrite = fs.writeFileSync.bind(fs);
  const realRename = fs.renameSync.bind(fs);
  fs.writeFileSync = (p, d) => { writes.push(p); return realWrite(p, d); };
  fs.renameSync = (o, n) => { renames.push([o, n]); return realRename(o, n); };

  const store = createSettingsStore({ fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS });
  store.setSettings({ provider: 'anthropic' });

  assert.equal(writes.length, 1);
  assert.notEqual(writes[0], FILE, 'must write to a temp path, not the real file, to avoid partial writes');
  assert.equal(renames.length, 1);
  assert.deepEqual(renames[0], [writes[0], FILE]);
});

test('auto-switches provider to one with a key when the configured provider has none', () => {
  const fs = fakeFs({
    [FILE]: JSON.stringify({ provider: 'openai', apiKeys: { openai: '', anthropic: 'sk-ant-x' } })
  });
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS,
    autoSwitchProviderKeys: ['openai', 'anthropic']
  });
  assert.equal(store.getSettings().provider, 'anthropic');
});
