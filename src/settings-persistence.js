// JSON-file settings persistence, with fs/cipher injected so this is unit
// testable without Electron. Two data-safety properties this guarantees that
// the original inline version in store.js did not:
//
//  1. A field that fails to decrypt this session (locked keychain, wrong
//     machine, transient failure) is never overwritten with a blank value on
//     the next save -- the original on-disk ciphertext is preserved so it can
//     still be recovered in a later session where decryption succeeds.
//  2. Writes are atomic (temp file + rename) and a corrupt/unparseable
//     settings file is backed up before being replaced, instead of being
//     silently discarded and overwritten with fresh defaults.

const { encryptFields, decryptFields } = require('./secure-fields');

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

// fs: { readFileSync, writeFileSync, renameSync } (same shapes as Node's fs)
// cipher: { isAvailable, encrypt, decrypt } -- see secure-fields.js
// autoSwitchProviderKeys: optional list of apiKeys keys to consider when the
//   configured provider has no key but another one does.
// maxLengths: optional { fieldName: number } -- top-level string fields are
//   truncated to this length on save. The UI enforces this too (e.g. an
//   <textarea maxlength>), but that's not a trust boundary -- any direct
//   settings:set IPC call bypasses it, so it has to be enforced here as well.
// knownProviders: optional list of provider names this build supports. When
//   supplied, any provider not in this list is migrated to one with a key or
//   the shipped default.
function createSettingsStore({ fs, filePath, cipher, defaults, secretFields, autoSwitchProviderKeys, knownProviders, maxLengths }) {
  let data = null;
  let undecryptable = {}; // field -> raw on-disk string we couldn't decrypt this session

  function backupCorruptFile() {
    try { fs.renameSync(filePath, filePath + '.corrupt-' + Date.now()); } catch (_) { /* best effort */ }
  }

  function applyAutoSwitch() {
    if (!autoSwitchProviderKeys || data.apiKeys[data.provider]) return;
    const active = autoSwitchProviderKeys.find((p) => data.apiKeys[p]);
    if (active) data.provider = active; // not saved here -- persists on next save
  }

  // A provider that no longer exists in this build -- e.g. 'github' after
  // GitHub Models' 2026-07-30 retirement -- would otherwise strand the user:
  // createLLM throws "unknown provider" on every action, and applyAutoSwitch
  // can't rescue them because it returns early whenever the configured
  // provider HAS a key, which a former GitHub Models user does.
  function applyRetiredProviderMigration() {
    if (!knownProviders || knownProviders.includes(data.provider)) return;
    data.provider = knownProviders.find((p) => data.apiKeys[p]) || defaults.provider;
  }

  function load() {
    if (data) return data;

    let raw = null;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch (_) { raw = null; } // no file yet -- benign, first run

    if (raw === null) {
      data = deepMerge(defaults, {});
      undecryptable = {};
      applyAutoSwitch();
      return data;
    }

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) {
      backupCorruptFile();
      data = deepMerge(defaults, {});
      undecryptable = {};
      applyAutoSwitch();
      return data;
    }

    const merged = deepMerge(defaults, parsed);
    const { values, failed } = decryptFields(merged.apiKeys, secretFields, cipher);
    merged.apiKeys = values;
    data = merged;
    undecryptable = {};
    for (const f of failed) undecryptable[f] = (parsed.apiKeys || {})[f];

    // Order matters: migrate off a retired provider FIRST, so applyAutoSwitch
    // then evaluates a provider that actually exists in this build.
    applyRetiredProviderMigration();
    applyAutoSwitch();
    return data;
  }

  function save() {
    try {
      const encrypted = encryptFields(data.apiKeys, secretFields, cipher);
      // encryptFields copies fields outside `secretFields` through untouched,
      // so a retired provider's stored secret would live in cue-data.json
      // forever with no UI left to view or clear it. Drop it on the next write.
      // Gate this behind knownProviders: pruning deletes a stored secret, so a
      // caller must opt into retired-provider handling to get it. Without that
      // opt-in, preserve the exact behavior this code had before.
      if (knownProviders) {
        for (const f of Object.keys(encrypted)) {
          if (!secretFields.includes(f)) delete encrypted[f];
        }
      }
      // Never let a field we couldn't decrypt this session get overwritten
      // with a blank/re-encrypted-empty value -- keep whatever was on disk.
      for (const f of Object.keys(undecryptable)) {
        if (undecryptable[f] !== undefined) encrypted[f] = undecryptable[f];
      }
      const onDisk = { ...data, apiKeys: encrypted };
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (e) { /* ignore -- best-effort persistence */ }
  }

  return {
    getSettings() { return load(); },
    setSettings(patch) {
      load();
      // A deliberate new value for a field always wins over "preserve stale
      // ciphertext" -- otherwise a user who retypes a key that failed to
      // decrypt this session would have their edit silently discarded (see
      // test/settings-persistence.test.js).
      const incomingApiKeys = (patch && patch.apiKeys) || {};
      for (const f of Object.keys(incomingApiKeys)) {
        if (typeof incomingApiKeys[f] === 'string' && incomingApiKeys[f]) delete undecryptable[f];
      }
      data = deepMerge(data, patch || {});
      if (maxLengths) {
        for (const f of Object.keys(maxLengths)) {
          if (typeof data[f] === 'string' && data[f].length > maxLengths[f]) data[f] = data[f].slice(0, maxLengths[f]);
        }
      }
      save();
      return data;
    }
  };
}

module.exports = { createSettingsStore, deepMerge };
