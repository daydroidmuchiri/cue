// Pure helpers for global-shortcut bookkeeping, kept separate from Electron's
// globalShortcut API so the collision/debounce logic can be unit tested.

function normalizeShortcut(accelerator) {
  return typeof accelerator === 'string' ? accelerator.trim().replace(/\s+/g, '') : '';
}

// Returns the name of the other action already bound to `accelerator`, or null.
function findCollision(accelerator, actionName, bindings) {
  const target = normalizeShortcut(accelerator).toLowerCase();
  for (const [name, bound] of Object.entries(bindings || {})) {
    if (name === actionName) continue;
    if (normalizeShortcut(bound).toLowerCase() === target) return name;
  }
  return null;
}

// Guards against the same logical action firing twice within `minIntervalMs`,
// regardless of which trigger path (OS-level global shortcut vs. renderer IPC)
// got there first.
function createTriggerGuard(minIntervalMs) {
  const last = new Map();
  return function shouldFire(key, now = Date.now()) {
    const prev = last.get(key);
    if (prev !== undefined && now - prev < minIntervalMs) return false;
    last.set(key, now);
    return true;
  };
}

module.exports = { normalizeShortcut, findCollision, createTriggerGuard };
