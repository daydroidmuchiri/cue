const assert = require('node:assert/strict');
const test = require('node:test');
const { MODES, formatTranscript } = require('../src/prompts');

// Screenshots and live transcripts are far more likely to carry adversarial
// text (a malicious webpage, a meeting participant, a planted code comment)
// than a user's own resume -- which already gets this treatment in
// profile-context.js. Every mode that consumes screen and/or transcript
// content must tell the model to treat it as data, not instructions.
test('every mode\'s system prompt defends against prompt injection from screen/transcript content', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    assert.match(mode.system, /untrusted/i, `mode "${name}" system prompt should mark screen/transcript content as untrusted`);
  }
});

function longTranscript(n) {
  const turns = [];
  for (let i = 0; i < n; i++) turns.push({ channel: i % 2 ? 'them' : 'you', text: 'turn number ' + i });
  return turns;
}

test('formatTranscript(turns, 0) means unlimited (existing contract, unchanged)', () => {
  const turns = longTranscript(5);
  assert.equal(formatTranscript(turns, 0).split('\n').length, 5);
});

test('recap mode does not send an unbounded transcript for a long session', () => {
  // A 12+ hour session can grow up to the transcript cap (500 turns, appendTurn.js).
  // Recap must not forward all 500 raw into a single prompt every time it runs.
  const ctx = { transcript: longTranscript(500), userText: '' };
  const built = MODES.recap.build(ctx);
  const turnCount = built.split('\n').filter((l) => l.startsWith('You: ') || l.startsWith('Them: ')).length;
  assert.ok(turnCount < 500, `expected recap to bound turn count, got ${turnCount}`);
});

test('recap mode still includes the most recent conversation (not the oldest)', () => {
  const ctx = { transcript: longTranscript(500), userText: '' };
  const built = MODES.recap.build(ctx);
  assert.ok(built.includes('turn number 499'), 'most recent turn should be present');
  assert.ok(!built.includes('turn number 0\n'), 'oldest turn should have been dropped once bounded');
});

test('recap mode on a short session is unaffected by the bound', () => {
  const ctx = { transcript: longTranscript(10), userText: '' };
  const built = MODES.recap.build(ctx);
  for (let i = 0; i < 10; i++) assert.ok(built.includes('turn number ' + i));
});
