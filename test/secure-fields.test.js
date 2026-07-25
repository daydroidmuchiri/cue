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
  const { values, failed } = decryptFields(enc, ['apiKey'], cipher);
  assert.equal(values.apiKey, 'sk-12345');
  assert.deepEqual(failed, []);
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
  const { values, failed } = decryptFields({ a: 'plain-legacy-key' }, ['a'], fakeCipher());
  assert.equal(values.a, 'plain-legacy-key');
  assert.deepEqual(failed, []); // never attempted -- not marked as a decrypt failure
});

test('decryptFields blanks a value it cannot decrypt instead of throwing, and reports it as failed', () => {
  const badCipher = { isAvailable: () => true, decrypt: () => { throw new Error('wrong keychain'); } };
  const enc = encryptFields({ a: 'secret' }, ['a'], fakeCipher());
  const { values, failed } = decryptFields(enc, ['a'], badCipher);
  assert.equal(values.a, '');
  assert.deepEqual(failed, ['a']);
});

test('decryptFields blanks an encrypted value when the cipher is currently unavailable, and reports it as failed', () => {
  const enc = encryptFields({ a: 'secret' }, ['a'], fakeCipher());
  const { values, failed } = decryptFields(enc, ['a'], { isAvailable: () => false });
  assert.equal(values.a, '');
  assert.deepEqual(failed, ['a']);
});

test('decryptFields does not report a field as failed when it was never encrypted', () => {
  const { failed } = decryptFields({ a: '', b: 'plain' }, ['a', 'b'], fakeCipher());
  assert.deepEqual(failed, []);
});

test('encryptFields does not mutate the original object', () => {
  const original = { a: 'secret' };
  encryptFields(original, ['a'], fakeCipher());
  assert.equal(original.a, 'secret');
});
