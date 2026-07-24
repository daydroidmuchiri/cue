const assert = require('node:assert/strict');
const test = require('node:test');
const { pushCapped, totalBytes, DEFAULT_MAX_BYTES } = require('../src/audio-buffer');

function buf(n) { return Buffer.alloc(n); }

test('pushCapped appends chunks while under the byte cap', () => {
  const chunks = [];
  pushCapped(chunks, buf(10), 100);
  pushCapped(chunks, buf(10), 100);
  assert.equal(chunks.length, 2);
  assert.equal(totalBytes(chunks), 20);
});

test('pushCapped drops the oldest chunks once the cap is exceeded', () => {
  const chunks = [buf(10), buf(10)]; // 20 bytes already buffered
  pushCapped(chunks, buf(90), 50); // pushing 90 more -> 110 total, cap 50
  assert.ok(totalBytes(chunks) <= 50, 'total bytes should not exceed the cap');
});

test('pushCapped keeps the most recent bytes, not the oldest', () => {
  const chunks = [];
  pushCapped(chunks, Buffer.from('AAAA'), 8);
  pushCapped(chunks, Buffer.from('BBBB'), 8);
  pushCapped(chunks, Buffer.from('CCCC'), 8);
  assert.equal(Buffer.concat(chunks).toString(), 'BBBBCCCC');
});

test('pushCapped defaults to DEFAULT_MAX_BYTES when no cap is given', () => {
  const chunks = [];
  pushCapped(chunks, buf(DEFAULT_MAX_BYTES + 1000));
  assert.ok(totalBytes(chunks) <= DEFAULT_MAX_BYTES);
});
