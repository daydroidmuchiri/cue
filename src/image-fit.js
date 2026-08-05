// Aspect-preserving long-edge fit. Split out from screen.js purely so it can be
// unit tested -- screen.js requires('electron'), which isn't available under
// `node --test`. Same reason settings-persistence.js is split out of store.js.

// Returns the target { width, height } for an image capped to `maxEdge` on its
// longer side, or null when the image already fits and should be left alone.
function fitLongEdge(width, height, maxEdge) {
  const longEdge = Math.max(width, height);
  if (!longEdge || longEdge <= maxEdge) return null;
  const k = maxEdge / longEdge;
  // Math.max(1, ...) guards a very wide/tall capture whose short edge would
  // otherwise round to 0 and produce an unusable image.
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k))
  };
}

module.exports = { fitLongEdge };
