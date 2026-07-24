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

function decryptFields(obj, fields, cipher) {
  const out = { ...obj };
  for (const f of fields) {
    const v = out[f];
    if (typeof v !== 'string' || !v.startsWith(ENC_PREFIX)) continue;
    if (!cipher || !cipher.isAvailable()) { out[f] = ''; continue; }
    try {
      out[f] = cipher.decrypt(Buffer.from(v.slice(ENC_PREFIX.length), 'base64'));
    } catch {
      out[f] = ''; // undecryptable (different machine/keychain) -- drop rather than crash
    }
  }
  return out;
}

module.exports = { encryptFields, decryptFields, ENC_PREFIX };
