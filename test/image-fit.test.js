const assert = require('node:assert/strict');
const test = require('node:test');
const { fitLongEdge } = require('../src/image-fit');

test('returns null when the image already fits (no pointless re-encode)', () => {
  assert.equal(fitLongEdge(1024, 768, 1280), null);
  assert.equal(fitLongEdge(1280, 720, 1280), null, 'exactly at the cap counts as fitting');
});

test('scales a landscape image down by its long edge, preserving aspect ratio', () => {
  assert.deepEqual(fitLongEdge(1920, 1080, 1280), { width: 1280, height: 720 });
});

test('scales a portrait image by its long edge too, not blindly by width', () => {
  assert.deepEqual(fitLongEdge(1080, 1920, 1280), { width: 720, height: 1280 });
});

test('handles a hi-DPI capture (the case that motivated this)', () => {
  // A 1440p display at scaleFactor 2 -- what src/screen.js asks the capturer for.
  assert.deepEqual(fitLongEdge(5120, 2880, 1280), { width: 1280, height: 720 });
});

test('never returns a zero dimension for an extreme aspect ratio', () => {
  const fit = fitLongEdge(8000, 3, 1280);
  assert.equal(fit.width, 1280);
  assert.ok(fit.height >= 1, 'a rounded-to-zero height would produce an unusable image');
});

test('degenerate sizes are treated as needing no resize rather than throwing', () => {
  assert.equal(fitLongEdge(0, 0, 1280), null);
});
