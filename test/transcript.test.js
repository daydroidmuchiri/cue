const assert = require('node:assert/strict');
const test = require('node:test');
const { appendTurn, DEFAULT_MAX_TURNS } = require('../src/transcript');

test('appendTurn pushes the turn onto the array and returns it', () => {
  const transcript = [];
  const turn = { channel: 'you', text: 'hi', ts: 1 };
  const result = appendTurn(transcript, turn, 10);
  assert.equal(result, transcript);
  assert.deepEqual(transcript, [turn]);
});

test('appendTurn trims the oldest turns once the cap is exceeded', () => {
  const transcript = [];
  for (let i = 0; i < 5; i++) appendTurn(transcript, { channel: 'you', text: String(i), ts: i }, 3);
  assert.deepEqual(transcript.map((t) => t.text), ['2', '3', '4']);
});

test('appendTurn keeps exactly maxTurns entries, not fewer', () => {
  const transcript = [];
  for (let i = 0; i < 3; i++) appendTurn(transcript, { channel: 'you', text: String(i), ts: i }, 3);
  assert.equal(transcript.length, 3);
});

test('appendTurn defaults to DEFAULT_MAX_TURNS when no cap is given', () => {
  const transcript = [];
  for (let i = 0; i < DEFAULT_MAX_TURNS + 10; i++) appendTurn(transcript, { channel: 'you', text: String(i), ts: i });
  assert.equal(transcript.length, DEFAULT_MAX_TURNS);
  assert.equal(transcript[0].text, '10');
});
