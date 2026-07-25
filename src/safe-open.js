// Scheme allowlist for shell.openExternal (see main.js's 'open-pane' handler).
// Nothing user-controlled reaches this today -- the only call sites are
// hardcoded onboarding URLs -- but shell.openExternal with an unvalidated
// scheme is a standing Electron footgun, so this is defense-in-depth against
// a future feature threading untrusted text into it.
const ALLOWED_SCHEMES = ['https:', 'x-apple.systempreferences:'];

function isAllowedExternalUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return ALLOWED_SCHEMES.includes(parsed.protocol);
}

module.exports = { isAllowedExternalUrl };
