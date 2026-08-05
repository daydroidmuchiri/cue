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
const KNOWN_PROVIDERS = ['openai', 'anthropic'];
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

test('CRITICAL: a user-supplied new value for an undecryptable field is NOT discarded', () => {
  // Session 1: original key saved successfully while the cipher is available.
  const fs = fakeFs();
  const session1 = createSettingsStore({ fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS });
  session1.setSettings({ apiKeys: { openai: 'sk-OLD-KEY' } });

  // Session 2: cipher unavailable this session (locked keychain / rebuilt
  // app identity) -- the field decrypts to blank. The user notices, retypes
  // a working key in Settings, and saves.
  const session2 = createSettingsStore({ fs, filePath: FILE, cipher: unavailableCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS });
  assert.equal(session2.getSettings().apiKeys.openai, '', 'field appears blank this session');
  session2.setSettings({ apiKeys: { openai: 'sk-BRAND-NEW-KEY-USER-JUST-TYPED' } });

  // Session 3: cipher available again -- the user's deliberate new value
  // must win, not the stale ciphertext from session 1.
  const session3 = createSettingsStore({ fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS });
  assert.equal(session3.getSettings().apiKeys.openai, 'sk-BRAND-NEW-KEY-USER-JUST-TYPED');
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

test('setSettings truncates a field to its configured max length', () => {
  const fs = fakeFs();
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: { ...DEFAULTS, resumeContext: '' }, secretFields: SECRET_FIELDS,
    maxLengths: { resumeContext: 10 }
  });
  store.setSettings({ resumeContext: 'a'.repeat(20) });
  assert.equal(store.getSettings().resumeContext, 'a'.repeat(10));
});

test('a field with no configured max length is left alone', () => {
  const fs = fakeFs();
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: { ...DEFAULTS, resumeContext: '' }, secretFields: SECRET_FIELDS,
    maxLengths: { resumeContext: 10 }
  });
  store.setSettings({ provider: 'anthropic' });
  assert.equal(store.getSettings().provider, 'anthropic');
});

test('a retired provider WITH a saved key still migrates (auto-switch alone cannot rescue this)', () => {
  // applyAutoSwitch returns early when apiKeys[provider] is truthy, so a user
  // who saved a key for the retired provider would otherwise stay pinned to it
  // and hit "unknown provider" on every action.
  const fs = fakeFs({
    [FILE]: JSON.stringify({ provider: 'github', apiKeys: { openai: '', anthropic: 'sk-ant-x', github: 'github_pat_x' } })
  });
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS,
    autoSwitchProviderKeys: KNOWN_PROVIDERS, knownProviders: KNOWN_PROVIDERS
  });
  assert.equal(store.getSettings().provider, 'anthropic', 'should land on the provider the user actually has a key for');
});

test('a retired provider with no other keys falls back to the shipped default', () => {
  const fs = fakeFs({ [FILE]: JSON.stringify({ provider: 'github', apiKeys: { openai: '', anthropic: '' } }) });
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS,
    autoSwitchProviderKeys: KNOWN_PROVIDERS, knownProviders: KNOWN_PROVIDERS
  });
  assert.equal(store.getSettings().provider, 'openai');
});

test('a valid provider is left untouched by the migration', () => {
  const fs = fakeFs({ [FILE]: JSON.stringify({ provider: 'anthropic', apiKeys: { openai: '', anthropic: 'sk-ant-x' } }) });
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS,
    autoSwitchProviderKeys: KNOWN_PROVIDERS, knownProviders: KNOWN_PROVIDERS
  });
  assert.equal(store.getSettings().provider, 'anthropic');
});

test('omitting knownProviders leaves provider handling exactly as before', () => {
  const fs = fakeFs({ [FILE]: JSON.stringify({ provider: 'github', apiKeys: { openai: '', anthropic: '' } }) });
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS
  });
  assert.equal(store.getSettings().provider, 'github', 'no knownProviders means no migration');
});

test('save() prunes apiKeys entries for providers this build no longer knows', () => {
  // encryptFields starts from {...obj}, so an unknown field is copied through
  // untouched and would sit in cue-data.json forever with no UI to clear it.
  const fs = fakeFs({
    [FILE]: JSON.stringify({ provider: 'openai', apiKeys: { openai: '', anthropic: '', github: 'enc:v1:c3RhbGU=' } })
  });
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS,
    knownProviders: KNOWN_PROVIDERS
  });
  store.setSettings({}); // main.js does exactly this on every boot
  const onDisk = JSON.parse(fs.files.get(FILE));
  assert.equal(onDisk.apiKeys.github, undefined, 'the retired provider key must be gone from disk');
  assert.ok('openai' in onDisk.apiKeys, 'known providers must survive the prune');
});

test('the prune does not regress ciphertext preservation for a known field', () => {
  // Guards the interaction between the new prune and the existing
  // "never blank a field we could not decrypt this session" guarantee.
  const fs = fakeFs();
  const session1 = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS,
    knownProviders: KNOWN_PROVIDERS
  });
  session1.setSettings({ apiKeys: { openai: 'sk-precious-real-key' } });
  const originalOnDisk = fs.files.get(FILE);

  const session2 = createSettingsStore({
    fs, filePath: FILE, cipher: unavailableCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS,
    knownProviders: KNOWN_PROVIDERS
  });
  session2.setSettings({});
  assert.equal(fs.files.get(FILE), originalOnDisk, 'prune must not disturb undecryptable-field preservation');
});

test('the prune is completely inert when knownProviders is omitted', () => {
  // Omitting knownProviders means no retired-provider handling, so unknown
  // apiKeys fields must NOT be deleted. This exercises the save path to verify
  // the prune does not run when not asked for.
  const fs = fakeFs({
    [FILE]: JSON.stringify({ provider: 'openai', apiKeys: { openai: '', anthropic: '', github: 'enc:v1:c3RhbGU=' } })
  });
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: DEFAULTS, secretFields: SECRET_FIELDS
    // NOTE: knownProviders is deliberately omitted
  });
  store.setSettings({}); // trigger save
  const onDisk = JSON.parse(fs.files.get(FILE));
  assert.equal(onDisk.apiKeys.github, 'enc:v1:c3RhbGU=', 'unknown field must survive when knownProviders is not supplied');
});
