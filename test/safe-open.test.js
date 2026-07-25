const assert = require('node:assert/strict');
const test = require('node:test');
const { isAllowedExternalUrl } = require('../src/safe-open');

test('allows https URLs', () => {
  assert.equal(isAllowedExternalUrl('https://example.com'), true);
});

test('allows the macOS System Settings deep-link scheme used by onboarding', () => {
  assert.equal(isAllowedExternalUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'), true);
});

test('rejects file: URLs', () => {
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false);
});

test('rejects javascript: URLs', () => {
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false);
});

test('rejects plain http (not https)', () => {
  assert.equal(isAllowedExternalUrl('http://example.com'), false);
});

test('rejects an arbitrary/unknown custom protocol', () => {
  assert.equal(isAllowedExternalUrl('ms-settings:privacy-microphone'), false);
});

test('rejects malformed input', () => {
  assert.equal(isAllowedExternalUrl('not a url'), false);
  assert.equal(isAllowedExternalUrl(''), false);
  assert.equal(isAllowedExternalUrl(null), false);
  assert.equal(isAllowedExternalUrl(undefined), false);
});
