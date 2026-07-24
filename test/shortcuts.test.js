const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeShortcut, findCollision, createTriggerGuard } = require('../src/shortcuts');

test('normalizeShortcut trims and strips internal whitespace', () => {
  assert.equal(normalizeShortcut('  CommandOrControl + Return '), 'CommandOrControl+Return');
});

test('normalizeShortcut returns empty string for non-string input', () => {
  assert.equal(normalizeShortcut(undefined), '');
  assert.equal(normalizeShortcut(null), '');
  assert.equal(normalizeShortcut(42), '');
});

test('findCollision reports the other action bound to the same accelerator', () => {
  const bindings = { assist: 'CommandOrControl+Return', leetcode: 'CommandOrControl+H' };
  assert.equal(findCollision('commandorcontrol+h', 'assist', bindings), 'leetcode');
});

test('findCollision ignores the action being checked against itself', () => {
  const bindings = { assist: 'CommandOrControl+Return', leetcode: 'CommandOrControl+H' };
  assert.equal(findCollision('CommandOrControl+Return', 'assist', bindings), null);
});

test('findCollision returns null when nothing else uses the accelerator', () => {
  const bindings = { assist: 'CommandOrControl+Return', leetcode: 'CommandOrControl+H' };
  assert.equal(findCollision('CommandOrControl+K', 'assist', bindings), null);
});

test('createTriggerGuard allows the first trigger for a key', () => {
  const shouldFire = createTriggerGuard(300);
  assert.equal(shouldFire('assist', 1000), true);
});

test('createTriggerGuard blocks a second trigger for the same key inside the window', () => {
  const shouldFire = createTriggerGuard(300);
  assert.equal(shouldFire('assist', 1000), true);
  assert.equal(shouldFire('assist', 1100), false);
});

test('createTriggerGuard allows a trigger once the window has elapsed', () => {
  const shouldFire = createTriggerGuard(300);
  assert.equal(shouldFire('assist', 1000), true);
  assert.equal(shouldFire('assist', 1301), true);
});

test('createTriggerGuard tracks keys independently', () => {
  const shouldFire = createTriggerGuard(300);
  assert.equal(shouldFire('assist', 1000), true);
  assert.equal(shouldFire('leetcode', 1050), true);
});
