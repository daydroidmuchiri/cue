const assert = require('node:assert/strict');
const test = require('node:test');
const { encryptFields, decryptFields, ENC_PREFIX } = require('../src/secure-fields');

function fakeCipher() {
  return {
    isAvailable: () => true,
    encrypt: (str) => Buffer.from(str, 'utf8').reverse(),
    decrypt: (buf) => Buffer.from(buf).reverse().toString('utf8')
  };
}

test('encryptFields wraps plaintext values with the encrypted marker', () => {
  const out = encryptFields({ a: 'secret', b: 'keep' }, ['a'], fakeCipher());
  assert.ok(out.a.startsWith(ENC_PREFIX));
  assert.equal(out.b, 'keep'); // untouched field left alone
});

test('encryptFields + decryptFields round-trip back to the original value', () => {
  const cipher = fakeCipher();
  const enc = encryptFields({ apiKey: 'sk-12345' }, ['apiKey'], cipher);
  const dec = decryptFields(enc, ['apiKey'], cipher);
  assert.equal(dec.apiKey, 'sk-12345');
});

test('encryptFields skips empty strings', () => {
  const out = encryptFields({ a: '' }, ['a'], fakeCipher());
  assert.equal(out.a, '');
});

test('encryptFields is a no-op when the cipher is unavailable, preserving plaintext', () => {
  const cipher = { isAvailable: () => false, encrypt: () => { throw new Error('should not be called'); } };
  const out = encryptFields({ a: 'secret' }, ['a'], cipher);
  assert.equal(out.a, 'secret');
});

test('decryptFields leaves legacy plaintext values (no marker) untouched', () => {
  const out = decryptFields({ a: 'plain-legacy-key' }, ['a'], fakeCipher());
  assert.equal(out.a, 'plain-legacy-key');
});

test('decryptFields blanks a value it cannot decrypt instead of throwing', () => {
  const badCipher = { isAvailable: () => true, decrypt: () => { throw new Error('wrong keychain'); } };
  const enc = encryptFields({ a: 'secret' }, ['a'], fakeCipher());
  const out = decryptFields(enc, ['a'], badCipher);
  assert.equal(out.a, '');
});

test('decryptFields blanks an encrypted value when the cipher is currently unavailable', () => {
  const enc = encryptFields({ a: 'secret' }, ['a'], fakeCipher());
  const out = decryptFields(enc, ['a'], { isAvailable: () => false });
  assert.equal(out.a, '');
});

test('encryptFields does not mutate the original object', () => {
  const original = { a: 'secret' };
  encryptFields(original, ['a'], fakeCipher());
  assert.equal(original.a, 'secret');
});
