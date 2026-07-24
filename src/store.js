// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { encryptFields, decryptFields } = require('./secure-fields');

const FILE = path.join(app.getPath('userData'), 'cue-data.json');
const SECRET_FIELDS = ['openai', 'anthropic', 'gemini', 'nvidia', 'openrouter'];

// API keys are encrypted at rest (OS keychain-backed via Electron's safeStorage)
// so cue-data.json doesn't hold them in plaintext. Falls back to plaintext,
// unchanged, on platforms/setups where OS-level encryption isn't available.
const cipher = {
  isAvailable: () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } },
  encrypt: (str) => safeStorage.encryptString(str),
  decrypt: (buf) => safeStorage.decryptString(buf)
};

const DEFAULTS = {
  provider: 'openai',
  smart: false,
  resumeContext: '',
  shortcuts: { assist: 'CommandOrControl+Return', leetcode: 'CommandOrControl+H' },
  apiKeys: { openai: '', anthropic: '', gemini: '', nvidia: '', openrouter: '' },
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
    nvidia: { fast: 'meta/llama-3.2-11b-vision-instruct', smart: 'meta/llama-3.2-90b-vision-instruct' },
    // Named models for better quality than the random `openrouter/free` router.
    // If either rotates out of the catalog, src/llm.js automatically retries
    // once against `openrouter/free` (see isUnservableModelError) rather than
    // erroring outright.
    openrouter: { fast: 'google/gemma-4-26b-a4b-it:free', smart: 'google/gemma-4-31b-it:free' }
  }
};

let data = null;

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

function load() {
  if (data) return data;
  try {
    data = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8')));
    data.apiKeys = decryptFields(data.apiKeys, SECRET_FIELDS, cipher);
  }
  catch { data = deepMerge(DEFAULTS, {}); }

  // Auto-switch provider if the current one has no key, but another one does.
  if (!data.apiKeys[data.provider]) {
    const validProviders = ['openai', 'anthropic', 'gemini', 'nvidia'];
    const active = validProviders.find(p => data.apiKeys[p]);
    if (active) {
      data.provider = active;
      // We don't save() here so we don't spam disk, it will persist on next save.
    }
  }

  return data;
}
function save() {
  try {
    const onDisk = { ...data, apiKeys: encryptFields(data.apiKeys, SECRET_FIELDS, cipher) };
    fs.writeFileSync(FILE, JSON.stringify(onDisk, null, 2));
  } catch (e) { /* ignore */ }
}

module.exports = {
  getSettings() { return load(); },
  setSettings(patch) { load(); data = deepMerge(data, patch || {}); save(); return data; }
};
