// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
// Persistence logic (atomic writes, corrupt-file backup, safe handling of
// fields that fail to decrypt) lives in settings-persistence.js, which is unit
// tested without Electron. This file only wires in the real fs/app/safeStorage.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { createSettingsStore } = require('./settings-persistence');
const { MAX_RESUME_CONTEXT_CHARS } = require('./profile-context');

const FILE = path.join(app.getPath('userData'), 'cue-data.json');

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
    // once against `openrouter/free` (see isRetriableOpenRouterError) rather
    // than erroring outright.
    openrouter: { fast: 'google/gemma-4-26b-a4b-it:free', smart: 'google/gemma-4-31b-it:free' }
  }
};

// Every apiKeys field is a secret; derived rather than duplicated so a new
// provider can't silently land in plaintext by being added to one list and
// not the other (see test/store.test.js).
const SECRET_FIELDS = Object.keys(DEFAULTS.apiKeys);

// API keys are encrypted at rest (OS keychain-backed via Electron's safeStorage)
// so cue-data.json doesn't hold them in plaintext. Falls back to plaintext,
// unchanged, on platforms/setups where OS-level encryption isn't available.
const cipher = {
  isAvailable: () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } },
  encrypt: (str) => safeStorage.encryptString(str),
  decrypt: (buf) => safeStorage.decryptString(buf)
};

const settingsStore = createSettingsStore({
  fs, filePath: FILE, cipher, defaults: DEFAULTS, secretFields: SECRET_FIELDS,
  autoSwitchProviderKeys: SECRET_FIELDS,
  maxLengths: { resumeContext: MAX_RESUME_CONTEXT_CHARS }
});

module.exports = {
  getSettings: settingsStore.getSettings,
  setSettings: settingsStore.setSettings,
  isEncryptionAvailable: cipher.isAvailable,
  DEFAULTS,
  SECRET_FIELDS
};
