// Encrypts/decrypts named string fields of a plain object using an injected
// cipher, so the crypto wiring (Electron's safeStorage) stays out of this
// module and this logic can be unit tested without Electron.
// cipher: { isAvailable(): boolean, encrypt(str): Buffer, decrypt(buf): string }

const ENC_PREFIX = 'enc:v1:';

function encryptFields(obj, fields, cipher) {
  const out = { ...obj };
  if (!cipher || !cipher.isAvailable()) return out;
  for (const f of fields) {
    const v = out[f];
    if (typeof v === 'string' && v && !v.startsWith(ENC_PREFIX)) {
      out[f] = ENC_PREFIX + cipher.encrypt(v).toString('base64');
    }
  }
  return out;
}

// Returns { values, failed } — `values` has the same shape as encryptFields'
// input (decrypted where possible, blanked where not), and `failed` lists
// which fields were encrypted-on-disk but couldn't be decrypted this session
// (wrong machine/keychain, or cipher currently unavailable). Callers that
// persist `values` back to disk should special-case `failed` fields rather
// than writing the blanked value over the original ciphertext — see
// src/settings-persistence.js.
function decryptFields(obj, fields, cipher) {
  const values = { ...obj };
  const failed = [];
  for (const f of fields) {
    const v = values[f];
    if (typeof v !== 'string' || !v.startsWith(ENC_PREFIX)) continue;
    if (!cipher || !cipher.isAvailable()) { values[f] = ''; failed.push(f); continue; }
    try {
      values[f] = cipher.decrypt(Buffer.from(v.slice(ENC_PREFIX.length), 'base64'));
    } catch {
      values[f] = ''; // undecryptable (different machine/keychain) -- blank in memory
      failed.push(f);
    }
  }
  return { values, failed };
}

module.exports = { encryptFields, decryptFields, ENC_PREFIX };
