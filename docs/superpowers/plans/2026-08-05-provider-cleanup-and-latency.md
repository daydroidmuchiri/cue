# Provider Cleanup & Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the retired GitHub Models provider without stranding existing users, and cut ~1–1.5 s of local latency from every screen-using action.

**Architecture:** Two independent groups. Group A (Tasks 1–3) deletes the `github` provider and adds a settings migration so anyone already on it lands somewhere valid instead of hitting `unknown provider: github`. Group B (Tasks 4–7) attacks time-to-first-token: pre-warm the screen capturer at boot, shrink the screenshot payload, stop over-provisioning output tokens on short modes, and surface the currently-silent rate-limit retry.

**Tech Stack:** Electron 43, CommonJS, Node's built-in test runner (`node --test`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-05-provider-cleanup-and-latency-design.md`

## Global Constraints

- **No new dependencies.** `package.json` deps stay exactly as they are.
- **CommonJS only** (`require` / `module.exports`). No ESM.
- **Unit-tested logic must not `require('electron')`.** Electron is unavailable under `node --test`. Pure logic goes in its own module and the Electron-facing file wires it in — this is the existing pattern (`store.js` → `settings-persistence.js`, `screen.js` → new `image-fit.js`).
- **Run the full suite with `npm test`** (which is `node --test`). Baseline before any change: **90 tests passing, 0 failing.** Never let this go red.
- **Comment the *why*, not the *what*.** This codebase's comments explain reasoning and failure modes; match that density and voice.
- **Do not touch the model defaults** in `src/store.js:28` (`google/gemma-4-26b-a4b-it:free` / `google/gemma-4-31b-it:free`). Both were verified live and are deliberate. See the spec's "Correction" section.
- **Do not remove the `openai`, `anthropic`, `gemini`, or `nvidia` providers.** `src/stt.js` needs an OpenAI or Gemini key for transcription; removing them kills meeting capture.
- **Preserve the `emittedAny` guard** in `shouldRetryWithFreeRouter` (`src/llm.js:50`) exactly as-is.
- Branch: `provider-cleanup-and-latency` (already created, spec already committed as `bf235b2`).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/settings-persistence.js` | Modify | Add retired-provider migration + orphaned-secret prune |
| `src/store.js` | Modify | Drop `github` defaults; pass `knownProviders` |
| `src/llm.js` | Modify | Drop `github` routing; add `onRetry` hook |
| `src/image-fit.js` | **Create** | Pure aspect-preserving long-edge fit math (Electron-free, testable) |
| `src/screen.js` | Modify | Downscale + JPEG encode via `image-fit` |
| `src/prompts.js` | Modify | Per-mode `maxTokens` for short modes |
| `main.js` | Modify | Capturer pre-warm; pass `maxTokens`; wire `onRetry` to status |
| `renderer/index.html` | Modify | Drop GitHub provider button + key field |
| `renderer/renderer.js` | Modify | Drop GitHub key fill/save/status |
| `test/settings-persistence.test.js` | Modify | Migration + prune coverage |
| `test/llm.test.js` | Modify | Drop `github` tests; add `onRetry` + `maxTokens` coverage |
| `test/prompts.test.js` | Modify | Short-mode token cap coverage |
| `test/image-fit.test.js` | **Create** | Fit math coverage |

---

# Group A — Remove the retired GitHub Models provider

## Task 1: Settings migration for retired providers

Land this **before** Task 2. On its own it is a no-op (nothing passes `knownProviders` yet), which means it can be reviewed and merged safely, and it is already in place when Task 2 makes `github` invalid.

**Files:**
- Modify: `src/settings-persistence.js:35` (signature), `:73-82` (load), `:84-97` (save)
- Test: `test/settings-persistence.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createSettingsStore({ ..., knownProviders })` — `knownProviders` is an optional `string[]` of valid provider names. When omitted, behavior is unchanged. Task 2 passes it from `src/store.js`.

- [ ] **Step 1: Write the failing tests**

Append to `test/settings-persistence.test.js`. Note these use their own `DEFAULTS`/`SECRET_FIELDS` including a retired `github` field, since the module-level ones at line 36 only have `openai`/`anthropic`:

```js
const RETIRED_DEFAULTS = { provider: 'openai', apiKeys: { openai: '', anthropic: '' } };
const KNOWN_PROVIDERS = ['openai', 'anthropic'];

test('a retired provider WITH a saved key still migrates (auto-switch alone cannot rescue this)', () => {
  // applyAutoSwitch returns early when apiKeys[provider] is truthy, so a user
  // who saved a key for the retired provider would otherwise stay pinned to it
  // and hit "unknown provider" on every action.
  const fs = fakeFs({
    [FILE]: JSON.stringify({ provider: 'github', apiKeys: { openai: '', anthropic: 'sk-ant-x', github: 'github_pat_x' } })
  });
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: RETIRED_DEFAULTS, secretFields: SECRET_FIELDS,
    autoSwitchProviderKeys: KNOWN_PROVIDERS, knownProviders: KNOWN_PROVIDERS
  });
  assert.equal(store.getSettings().provider, 'anthropic', 'should land on the provider the user actually has a key for');
});

test('a retired provider with no other keys falls back to the shipped default', () => {
  const fs = fakeFs({ [FILE]: JSON.stringify({ provider: 'github', apiKeys: { openai: '', anthropic: '' } }) });
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: RETIRED_DEFAULTS, secretFields: SECRET_FIELDS,
    autoSwitchProviderKeys: KNOWN_PROVIDERS, knownProviders: KNOWN_PROVIDERS
  });
  assert.equal(store.getSettings().provider, 'openai');
});

test('a valid provider is left untouched by the migration', () => {
  const fs = fakeFs({ [FILE]: JSON.stringify({ provider: 'anthropic', apiKeys: { openai: '', anthropic: 'sk-ant-x' } }) });
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: RETIRED_DEFAULTS, secretFields: SECRET_FIELDS,
    autoSwitchProviderKeys: KNOWN_PROVIDERS, knownProviders: KNOWN_PROVIDERS
  });
  assert.equal(store.getSettings().provider, 'anthropic');
});

test('omitting knownProviders leaves provider handling exactly as before', () => {
  const fs = fakeFs({ [FILE]: JSON.stringify({ provider: 'github', apiKeys: { openai: '', anthropic: '' } }) });
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: RETIRED_DEFAULTS, secretFields: SECRET_FIELDS
  });
  assert.equal(store.getSettings().provider, 'github', 'no knownProviders means no migration');
});

test('save() prunes apiKeys entries for providers this build no longer knows', () => {
  // encryptFields starts from {...obj}, so an unknown field is copied through
  // untouched and would sit in cue-data.json forever with no UI to clear it.
  const fs = fakeFs({
    [FILE]: JSON.stringify({ provider: 'openai', apiKeys: { openai: '', anthropic: '', github: 'enc:v1:c3RhbGU=' } })
  });
  const store = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: RETIRED_DEFAULTS, secretFields: SECRET_FIELDS,
    knownProviders: KNOWN_PROVIDERS
  });
  store.setSettings({}); // main.js does exactly this on every boot
  const onDisk = JSON.parse(fs.files.get(FILE));
  assert.equal(onDisk.apiKeys.github, undefined, 'the retired provider key must be gone from disk');
  assert.ok('openai' in onDisk.apiKeys, 'known providers must survive the prune');
});

test('the prune does not regress ciphertext preservation for a known field', () => {
  // Guards the interaction between the new prune and the existing
  // "never blank a field we could not decrypt this session" guarantee.
  const fs = fakeFs();
  const session1 = createSettingsStore({
    fs, filePath: FILE, cipher: workingCipher(), defaults: RETIRED_DEFAULTS, secretFields: SECRET_FIELDS,
    knownProviders: KNOWN_PROVIDERS
  });
  session1.setSettings({ apiKeys: { openai: 'sk-precious-real-key' } });
  const originalOnDisk = fs.files.get(FILE);

  const session2 = createSettingsStore({
    fs, filePath: FILE, cipher: unavailableCipher(), defaults: RETIRED_DEFAULTS, secretFields: SECRET_FIELDS,
    knownProviders: KNOWN_PROVIDERS
  });
  session2.setSettings({});
  assert.equal(fs.files.get(FILE), originalOnDisk, 'prune must not disturb undecryptable-field preservation');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL. The migration tests fail with `'github' !== 'anthropic'`; the prune test fails because `onDisk.apiKeys.github` is still present.

- [ ] **Step 3: Implement the migration and prune**

In `src/settings-persistence.js`, add `knownProviders` to the destructured options at line 35:

```js
function createSettingsStore({ fs, filePath, cipher, defaults, secretFields, autoSwitchProviderKeys, knownProviders, maxLengths }) {
```

Add this function immediately after `applyAutoSwitch` (line 47):

```js
  // A provider that no longer exists in this build -- e.g. 'github' after
  // GitHub Models' 2026-07-30 retirement -- would otherwise strand the user:
  // createLLM throws "unknown provider" on every action, and applyAutoSwitch
  // can't rescue them because it returns early whenever the configured
  // provider HAS a key, which a former GitHub Models user does.
  function applyRetiredProviderMigration() {
    if (!knownProviders || knownProviders.includes(data.provider)) return;
    data.provider = knownProviders.find((p) => data.apiKeys[p]) || defaults.provider;
  }
```

In `load()`, call it in the merged branch only — the two earlier branches build `data` from `defaults`, whose provider is valid by construction. Change lines 77-80 from:

```js
    data = merged;
    undecryptable = {};
    for (const f of failed) undecryptable[f] = (parsed.apiKeys || {})[f];

    applyAutoSwitch();
```

to:

```js
    data = merged;
    undecryptable = {};
    for (const f of failed) undecryptable[f] = (parsed.apiKeys || {})[f];

    // Order matters: migrate off a retired provider FIRST, so applyAutoSwitch
    // then evaluates a provider that actually exists in this build.
    applyRetiredProviderMigration();
    applyAutoSwitch();
```

In `save()`, insert the prune between the `encryptFields` call and the undecryptable-restore loop (after line 86):

```js
      const encrypted = encryptFields(data.apiKeys, secretFields, cipher);
      // encryptFields copies fields outside `secretFields` through untouched,
      // so a retired provider's stored secret would live in cue-data.json
      // forever with no UI left to view or clear it. Drop it on the next write.
      // Gate this behind knownProviders: pruning deletes a stored secret, so a
      // caller must opt into retired-provider handling to get it. Without that
      // opt-in, preserve the exact behavior this code had before.
      if (knownProviders) {
        for (const f of Object.keys(encrypted)) {
          if (!secretFields.includes(f)) delete encrypted[f];
        }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, 96 tests, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add src/settings-persistence.js test/settings-persistence.test.js
git commit -m "feat: migrate off retired providers and prune their orphaned keys

No-op until a caller passes knownProviders (next commit). applyAutoSwitch
cannot handle this case on its own: it returns early whenever the configured
provider has a key, which a user who saved a GitHub Models PAT does.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Remove the `github` provider from the core

**Files:**
- Modify: `src/llm.js:17`, `src/llm.js:192`
- Modify: `src/store.js:18`, `src/store.js:29-30`, `src/store.js:48-52`
- Test: `test/llm.test.js:64-74`

**Interfaces:**
- Consumes: `knownProviders` option from Task 1.
- Produces: `resolveBaseURL('github') === undefined`; `createLLM({ provider: 'github' }).stream()` rejects with `/unknown provider/`.

- [ ] **Step 1: Update the tests to assert the removal**

In `test/llm.test.js`, replace the test at lines 64-68 with:

```js
test('resolveBaseURL points nvidia and openrouter at their OpenAI-compatible endpoints', () => {
  assert.equal(resolveBaseURL('nvidia'), 'https://integrate.api.nvidia.com/v1');
  assert.equal(resolveBaseURL('openrouter'), 'https://openrouter.ai/api/v1');
});
```

Replace the test at lines 70-74 with:

```js
// GitHub Models was fully retired on 2026-07-30; both endpoints cue used now
// return 410 Gone. Routing to it can only ever produce a confusing hard error.
test('the retired github provider is no longer routable', () => {
  assert.equal(resolveBaseURL('github'), undefined);
  const llm = createLLM({ provider: 'github', apiKeys: { github: 'github_pat_x' }, models: { github: { fast: 'openai/gpt-4o-mini' } }, smart: false });
  return assert.rejects(() => llm.stream({ system: '', turns: [], onToken: () => {} }), /unknown provider/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `resolveBaseURL('github')` still returns the retired URL, and `stream()` resolves instead of rejecting.

- [ ] **Step 3: Remove the provider**

`src/llm.js` — delete the `github` entry (line 17) and the trailing comma issue. The block becomes:

```js
const PROVIDER_BASE_URLS = {
  nvidia: 'https://integrate.api.nvidia.com/v1',
  openrouter: 'https://openrouter.ai/api/v1'
};
```

`src/llm.js:192` — drop `github` from the branch:

```js
        if (provider === 'openai' || provider === 'nvidia' || provider === 'openrouter') {
```

`src/store.js:18` — drop `github` from `DEFAULTS.apiKeys`:

```js
  apiKeys: { openai: '', anthropic: '', gemini: '', nvidia: '', openrouter: '' },
```

`src/store.js:29-30` — delete the two-line `github` comment and its model entry, so `DEFAULTS.models` now ends at the `openrouter` entry:

```js
    openrouter: { fast: 'google/gemma-4-26b-a4b-it:free', smart: 'google/gemma-4-31b-it:free' }
  }
```

`src/store.js:48-52` — pass `knownProviders`. `SECRET_FIELDS` is already derived from `Object.keys(DEFAULTS.apiKeys)`, which is exactly the set of provider names, so reuse it rather than hand-maintaining a third list:

```js
const settingsStore = createSettingsStore({
  fs, filePath: FILE, cipher, defaults: DEFAULTS, secretFields: SECRET_FIELDS,
  autoSwitchProviderKeys: SECRET_FIELDS,
  // Same derived list: every apiKeys field is a provider name. A user sitting
  // on a provider we've dropped gets migrated to a valid one on load.
  knownProviders: SECRET_FIELDS,
  maxLengths: { resumeContext: MAX_RESUME_CONTEXT_CHARS }
});
```

**Do not** touch the `openrouter` model IDs on line 28.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, 96 tests, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add src/llm.js src/store.js test/llm.test.js
git commit -m "fix: remove retired GitHub Models provider

GitHub Models was fully retired 2026-07-30; models.github.ai returns 410 Gone
for both the catalog and inference endpoints. The provider added in ddd8847
cannot work, and failed badly: isRetriableOpenRouterError covers only
400/404/429 and only for openrouter, so users got a bare 410 with no fallback.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Remove the GitHub Models UI

No unit tests — this is DOM wiring with no test harness in the project. Verified manually.

**Files:**
- Modify: `renderer/index.html:69`, `renderer/index.html:78`
- Modify: `renderer/renderer.js:354`, `:369`, `:386`

**Interfaces:**
- Consumes: nothing. Purely removes references to `#key-github` and `data-provider="github"`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Delete the provider button and key field**

In `renderer/index.html`, delete line 69 entirely:

```html
          <button data-provider="github">GitHub Models</button>
```

and line 78 entirely:

```html
        <div class="s-field"><span>GitHub</span><input id="key-github" type="password" placeholder="github_pat_..." autocomplete="off" /></div>
```

- [ ] **Step 2: Delete the renderer references**

In `renderer/renderer.js`, delete line 354:

```js
    $('#key-github').value = settings.apiKeys.github || '';
```

delete line 386:

```js
    settings.apiKeys.github = $('#key-github').value.trim();
```

and change line 369 from:

```js
    const has = [k.openai && 'OpenAI', k.anthropic && 'Anthropic', k.gemini && 'Gemini', k.nvidia && 'Nvidia', k.openrouter && 'OpenRouter', k.github && 'GitHub'].filter(Boolean);
```

to:

```js
    const has = [k.openai && 'OpenAI', k.anthropic && 'Anthropic', k.gemini && 'Gemini', k.nvidia && 'Nvidia', k.openrouter && 'OpenRouter'].filter(Boolean);
```

- [ ] **Step 3: Verify no references remain**

Run: `grep -rn "github" renderer/ src/ main.js --include=*.js --include=*.html -i | grep -v "github.com/daydroidmuchiri"`
Expected: no output. (The only surviving `github.com` reference is the OpenRouter `HTTP-Referer` header in `src/llm.js:22`, which is cue's own repo URL and must stay.)

- [ ] **Step 4: Verify the suite is still green and the app boots**

Run: `npm test 2>&1 | tail -5`
Expected: PASS, 96 tests.

Run: `npm start`
Expected: overlay appears. Open Settings (gear icon, or `Ctrl+,`). Confirm: no "GitHub Models" button in the provider row, no GitHub key field, the provider row still shows OpenAI / Anthropic / Gemini / Nvidia / OpenRouter, and selecting each still swaps the fast/smart model boxes. Close the app.

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html renderer/renderer.js
git commit -m "fix: remove GitHub Models from the settings UI

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Group B — Cut time-to-first-token

## Task 4: Pre-warm the screen capturer at boot

The single biggest measured win. Benchmarked on a 1080p display: the first `getSources` call costs **1590 ms**, every call after costs **~620 ms**. That ~970 ms gap is paid by the first screen action of every session.

**Files:**
- Modify: `main.js:347-377` (inside `app.whenReady()`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Pure side effect.

- [ ] **Step 1: Add the pre-warm**

`desktopCapturer` is already imported at `main.js:2`. In `app.whenReady()`, add this immediately after `createWindow();` (line 373), so the window paints first:

```js
  // The first desktopCapturer.getSources() call of a process pays ~1s of
  // capture-stream startup; later calls cost ~600ms. That cost is independent
  // of thumbnailSize (a 1x1 thumbnail is just as slow), so it can't be
  // optimized away -- only paid early. Do it here, off the critical path, so
  // the user's first Assist doesn't eat it. The image is discarded.
  // Deliberately not awaited: this must never delay startup.
  desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
    .catch(() => { /* pre-warm is best-effort; a real capture will retry later */ });
```

- [ ] **Step 2: Verify the suite is still green**

Run: `npm test 2>&1 | tail -5`
Expected: PASS, 96 tests. (`main.js` has no unit tests — it is the Electron wiring layer.)

- [ ] **Step 3: Verify the latency improvement manually**

Run: `npm start`, wait ~3 seconds for boot to settle, then press `Ctrl+H` (Solve on screen) and time how long until the first token appears.

Expected: noticeably faster to start than before this change. Compare against `git stash` + rerun if you want a direct A/B.

**macOS-only check (skip on Windows/Linux, and flag it in the PR):** on macOS the first `getSources` call is what triggers the Screen-Recording permission prompt. Confirm the prompt still appears and still grants correctly — it now fires at launch rather than on first Assist. This is a real behavior change and needs a macOS pass before release.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "perf: pre-warm the screen capturer at boot

desktopCapturer.getSources costs ~1590ms on its first call and ~620ms after,
measured on a 1080p display. The cost is fixed capture-stream startup and is
independent of thumbnailSize -- a 1x1 thumbnail is exactly as slow as full
res -- so it can only be paid early, not avoided. Moves ~1s off the first
Assist of every session.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Downscale and JPEG-encode the screenshot

This does **not** speed up capture (measured: size-independent). It cuts upload bytes and, more importantly, image prefill tokens at the model — which is on the slow side of the wire. Measured 2.2× smaller on a 1080p display; over 10× on hi-DPI, since the current code multiplies by `scaleFactor`.

**Files:**
- Create: `src/image-fit.js`
- Create: `test/image-fit.test.js`
- Modify: `src/screen.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `fitLongEdge(width, height, maxEdge)` → `{ width, height }` when a resize is needed, or `null` when the image already fits. Used only by `src/screen.js`.

- [ ] **Step 1: Write the failing test**

Create `test/image-fit.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/image-fit.test.js`
Expected: FAIL with `Cannot find module '../src/image-fit'`.

- [ ] **Step 3: Write the implementation**

Create `src/image-fit.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/image-fit.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into `src/screen.js`**

Replace the whole file with:

```js
// Screenshot for the LLM, via desktopCapturer (main process).
// First call triggers the macOS Screen-Recording permission prompt for the app
// -- though main.js now pre-warms the capturer at boot, so that usually
// happens at launch rather than on the first Assist.
const { desktopCapturer, screen } = require('electron');
const { fitLongEdge } = require('./image-fit');

// The screenshot goes straight into an LLM request, so its size is latency:
// image prefill tokens scale with resolution, and a hi-DPI native capture is
// several times larger than any model needs to read a code editor. 1280px on
// the long edge keeps IDE and LeetCode text legible; JPEG at 80 is far smaller
// than PNG for screen content with no legibility cost that matters here.
//
// Note this does NOT make capture faster -- getSources costs the same ~620ms
// regardless of thumbnailSize. It cuts upload time and model prefill only.
const MAX_EDGE = 1280;
const JPEG_QUALITY = 80;

async function captureScreenshot() {
  // Capture the display under the cursor, not always the primary one — on a
  // multi-monitor setup the problem/meeting is usually wherever the user is.
  const target = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = target.size;
  const scale = target.scaleFactor || 1;
  // Still captured at native resolution: thumbnailSize is a bounding box whose
  // exact behavior varies across platforms and multi-monitor setups, and asking
  // for less buys nothing since capture cost is size-independent. Downscale
  // explicitly below instead, where the result is predictable.
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) }
  });
  if (!sources.length) return null;
  const src = sources.find((s) => String(s.display_id) === String(target.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;

  const size = img.getSize();
  const fit = fitLongEdge(size.width, size.height, MAX_EDGE);
  const sized = fit ? img.resize({ ...fit, quality: 'good' }) : img;
  return 'data:image/jpeg;base64,' + sized.toJPEG(JPEG_QUALITY).toString('base64');
}

module.exports = { captureScreenshot };
```

No downstream changes are needed for the mime change from PNG to JPEG: `stripDataUrl` (`src/llm.js:54`) parses the mime out of the data URL generically, so Anthropic's `media_type` and Gemini's `mimeType` both follow automatically, and the OpenAI-compatible path passes the whole data URL through untouched.

- [ ] **Step 6: Run the full suite**

Run: `npm test 2>&1 | tail -5`
Expected: PASS, 102 tests, 0 failing.

- [ ] **Step 7: Verify the screenshot is still readable**

Run: `npm start`. Open a LeetCode problem (or any code editor with a paragraph of text) on screen, press `Ctrl+H`, and confirm the model reads the problem correctly rather than hallucinating. If text is being misread, raise `MAX_EDGE` to 1568 and re-check — do not lower `JPEG_QUALITY` below 80.

- [ ] **Step 8: Commit**

```bash
git add src/image-fit.js src/screen.js test/image-fit.test.js
git commit -m "perf: downscale screenshots to 1280px and encode as JPEG

Measured 0.31MB PNG -> 0.14MB JPEG on a 1080p display, and over 10x on hi-DPI
where the capture is multiplied by scaleFactor. This does not speed up capture
itself (getSources is size-independent) -- it cuts upload bytes and, more
importantly, image prefill tokens at the model.

Fit math lives in src/image-fit.js so it can be unit tested without Electron.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Per-mode output token caps

`DEFAULT_MAX_TOKENS = 8192` currently applies to every call, including `say` (1–3 sentences), `followup` (2–4 bullets) and `recap` (short bullets).

**Files:**
- Modify: `src/prompts.js`
- Modify: `main.js:232-237`
- Test: `test/prompts.test.js`, `test/llm.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `MODES[name].maxTokens` — a number on `say`/`followup`/`recap`, `undefined` on `assist`/`ask`/`leetcode`. `main.js` forwards it as `llm.stream({ maxTokens })`, where `undefined` correctly falls back to `DEFAULT_MAX_TOKENS`.

- [ ] **Step 1: Write the failing tests**

Append to `test/prompts.test.js`:

```js
// The 8192 default in llm.js is sized for a full LeetCode answer (approach +
// code + complexity). The conversational modes produce a few sentences and
// have no business reserving that much.
test('short conversational modes cap their output tokens', () => {
  for (const name of ['say', 'followup', 'recap']) {
    assert.equal(typeof MODES[name].maxTokens, 'number', `mode "${name}" should declare a cap`);
    assert.ok(MODES[name].maxTokens <= 1024, `mode "${name}" cap should be small`);
  }
});

test('code-producing modes leave maxTokens unset so llm.js applies the full default', () => {
  for (const name of ['assist', 'ask', 'leetcode']) {
    assert.equal(MODES[name].maxTokens, undefined, `mode "${name}" must not be capped -- it emits full code answers`);
  }
});
```

Append to `test/llm.test.js` (this pins the contract Task 6 relies on — that a caller-supplied `maxTokens` wins over the module default):

```js
test('a caller-supplied maxTokens overrides DEFAULT_MAX_TOKENS', async () => {
  const OpenAIClient = makeFakeOpenAI([{ choices: [{ delta: { content: 'ok' } }] }]);
  const llm = createLLM(
    { provider: 'openai', apiKeys: { openai: 'sk-x' }, models: { openai: { fast: 'gpt-4o-mini' } }, smart: false },
    { OpenAIClient }
  );
  await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], maxTokens: 1024, onToken: () => {} });
  assert.equal(OpenAIClient.instances[0].lastParams.max_tokens, 1024);
});

test('an unset maxTokens falls back to DEFAULT_MAX_TOKENS', async () => {
  const OpenAIClient = makeFakeOpenAI([{ choices: [{ delta: { content: 'ok' } }] }]);
  const llm = createLLM(
    { provider: 'openai', apiKeys: { openai: 'sk-x' }, models: { openai: { fast: 'gpt-4o-mini' } }, smart: false },
    { OpenAIClient }
  );
  await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(OpenAIClient.instances[0].lastParams.max_tokens, DEFAULT_MAX_TOKENS);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: the two `prompts` tests FAIL (`maxTokens` is `undefined` on the short modes). The two `llm` tests should already PASS — `src/llm.js:190` spreads `...params` last, so caller values already win. That is intentional: they pin an existing contract that Task 6 depends on, so a future refactor can't silently break it.

- [ ] **Step 3: Add the caps**

In `src/prompts.js`, add near the top, just after `RECAP_MAX_TURNS` (line 8):

```js
// llm.js defaults to 8192 output tokens, sized for a full code answer. The
// conversational modes below produce a few sentences or bullets -- reserving
// 8x more than they can use is pure over-provisioning.
const SHORT_MODE_MAX_TOKENS = 1024;
```

Then add `maxTokens: SHORT_MODE_MAX_TOKENS,` to exactly three modes, alongside their existing `small:` property:

- `say` (after `small: false,` on line 46)
- `followup` (after `small: true,` on line 63)
- `recap` (after `small: true,` on line 77)

Leave `assist`, `ask` and `leetcode` untouched — they emit full code answers.

- [ ] **Step 4: Forward it from `main.js`**

In `main.js`, add one line to the `llm.stream()` call at lines 232-237:

```js
    const fullText = await llm.stream({
      system: appendResumeContext(def.system, settings.resumeContext),
      turns: [{ role: 'user', text: built }],
      imageDataUrl,
      maxTokens: def.maxTokens, // undefined for code modes -> llm.js's 8192 default
      onToken: (t) => send('llm:token', { text: t })
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: PASS, 106 tests, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add src/prompts.js main.js test/prompts.test.js test/llm.test.js
git commit -m "perf: cap output tokens on the short conversational modes

say/followup/recap produce a few sentences or bullets but were reserving the
same 8192 output tokens as a full LeetCode answer. Code modes are unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Make the silent rate-limit retry visible

When a free OpenRouter model returns 429, `src/llm.js:208` fires a **second full request** against `openrouter/free`. That roughly doubles the wait and is currently indistinguishable from a hang — the UI shows a caret and nothing else.

**Files:**
- Modify: `src/llm.js:187-212`
- Modify: `main.js:232-237`
- Test: `test/llm.test.js`

**Interfaces:**
- Consumes: the `maxTokens` forwarding added in Task 6 (same `llm.stream()` call site).
- Produces: an optional `onRetry` callback on `stream()` params, invoked as `onRetry({ model, status })` where `model` is the failed model ID string and `status` is the HTTP status number. Called at most once, immediately before the fallback request.

- [ ] **Step 1: Write the failing tests**

Append to `test/llm.test.js`:

```js
test('onRetry fires once, with the failed model, before the free-router fallback', async () => {
  let call = 0;
  class RateLimitedThenFreeClient {
    constructor(opts) { this.opts = opts; }
    get chat() {
      const self = this;
      return { completions: { create: async (params) => {
        self.lastParams = params;
        call++;
        if (call === 1) { const e = new Error('rate limited'); e.status = 429; throw e; }
        return (async function* () { yield { choices: [{ delta: { content: 'fallback ok' } }] }; })();
      } } };
    }
  }
  const llm = createLLM(
    { provider: 'openrouter', apiKeys: { openrouter: 'sk-or-x' }, models: { openrouter: { fast: 'some/model:free' } }, smart: false },
    { OpenAIClient: RateLimitedThenFreeClient }
  );
  const retries = [];
  const full = await llm.stream({
    system: 'sys', turns: [{ role: 'user', text: 'hi' }],
    onRetry: (info) => retries.push(info),
    onToken: () => {}
  });
  assert.equal(full, 'fallback ok');
  assert.equal(retries.length, 1, 'exactly one retry notification');
  assert.equal(retries[0].model, 'some/model:free', 'reports the model that failed, not the fallback');
  assert.equal(retries[0].status, 429);
});

test('onRetry does not fire on a successful first attempt', async () => {
  const OpenAIClient = makeFakeOpenAI([{ choices: [{ delta: { content: 'ok' } }] }]);
  const llm = createLLM(
    { provider: 'openrouter', apiKeys: { openrouter: 'sk-or-x' }, models: { openrouter: { fast: 'some/model:free' } }, smart: false },
    { OpenAIClient }
  );
  let fired = false;
  await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onRetry: () => { fired = true; }, onToken: () => {} });
  assert.equal(fired, false);
});

test('onRetry does not fire on a non-retriable error', async () => {
  class UnauthorizedClient {
    constructor(opts) { this.opts = opts; }
    get chat() {
      return { completions: { create: async () => { const e = new Error('bad key'); e.status = 401; throw e; } } };
    }
  }
  const llm = createLLM(
    { provider: 'openrouter', apiKeys: { openrouter: 'sk-or-x' }, models: { openrouter: { fast: 'some/model:free' } }, smart: false },
    { OpenAIClient: UnauthorizedClient }
  );
  let fired = false;
  await assert.rejects(() => llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onRetry: () => { fired = true; }, onToken: () => {} }));
  assert.equal(fired, false, '401 must surface as-is, not look like a retry');
});

test('onRetry does not fire once tokens have already streamed', async () => {
  // Mirrors the emittedAny guard: a mid-stream failure must not retry at all,
  // so it must not claim to be retrying either.
  class FailsMidStreamClient {
    constructor(opts) { this.opts = opts; }
    get chat() {
      return { completions: { create: async () => (async function* () {
        yield { choices: [{ delta: { content: 'partial' } }] };
        const e = new Error('rate limited'); e.status = 429; throw e;
      })() } };
    }
  }
  const llm = createLLM(
    { provider: 'openrouter', apiKeys: { openrouter: 'sk-or-x' }, models: { openrouter: { fast: 'some/model:free' } }, smart: false },
    { OpenAIClient: FailsMidStreamClient }
  );
  let fired = false;
  await assert.rejects(() => llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onRetry: () => { fired = true; }, onToken: () => {} }));
  assert.equal(fired, false);
});

test('an omitted onRetry does not throw when a retry happens', async () => {
  let call = 0;
  class FlakyClient {
    constructor(opts) { this.opts = opts; }
    get chat() {
      return { completions: { create: async () => {
        call++;
        if (call === 1) { const e = new Error('rate limited'); e.status = 429; throw e; }
        return (async function* () { yield { choices: [{ delta: { content: 'ok' } }] }; })();
      } } };
    }
  }
  const llm = createLLM(
    { provider: 'openrouter', apiKeys: { openrouter: 'sk-or-x' }, models: { openrouter: { fast: 'some/model:free' } }, smart: false },
    { OpenAIClient: FlakyClient }
  );
  const full = await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(full, 'ok');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: the first test FAILS (`retries.length` is 0 — nothing calls `onRetry` yet). The other four should already pass, since they assert `onRetry` is *not* called; keep them, they pin the guard conditions.

- [ ] **Step 3: Invoke the callback**

In `src/llm.js`, inside the `catch` block at lines 203-212, add the call immediately before the fallback:

```js
          } catch (err) {
            // The chosen model is unusable right now (rotated out of the catalog,
            // or its free-tier provider is rate-limited) — retry once against
            // OpenRouter's own free-model router instead of failing outright.
            // Only if nothing has streamed yet -- see shouldRetryWithFreeRouter.
            if (shouldRetryWithFreeRouter({ provider, model, emittedAny, err })) {
              // A second full round trip roughly doubles the wait, and without
              // this the UI shows a caret and nothing else -- indistinguishable
              // from a hang. Tell the caller so it can say what's happening.
              if (typeof args.onRetry === 'function') args.onRetry({ model, status: err.status });
              return await streamOpenAI({ ...openAIArgs, model: OPENROUTER_FREE_MODEL });
            }
            throw err;
          }
```

Note `onRetry` arrives via `...params` into `args` (line 190) and is spread into `openAIArgs`; `streamOpenAI` ignores properties it doesn't destructure, so nothing else changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: PASS, 111 tests, 0 failing.

- [ ] **Step 5: Surface it in the UI**

In `main.js`, add `onRetry` to the same `llm.stream()` call touched in Task 6:

```js
    const fullText = await llm.stream({
      system: appendResumeContext(def.system, settings.resumeContext),
      turns: [{ role: 'user', text: built }],
      imageDataUrl,
      maxTokens: def.maxTokens, // undefined for code modes -> llm.js's 8192 default
      onRetry: ({ model }) => send('status', {
        message: model + ' is rate-limited or unavailable right now — retrying with OpenRouter\'s free router. This one will take longer.'
      }),
      onToken: (t) => send('llm:token', { text: t })
    });
```

The renderer already handles `status` events via `showStatus` (`renderer/renderer.js:324`), so no renderer change is needed.

- [ ] **Step 6: Commit**

```bash
git add src/llm.js main.js test/llm.test.js
git commit -m "feat: surface the free-router fallback instead of retrying silently

A 429 on a free OpenRouter model triggers a second full request, roughly
doubling the wait. The UI showed a caret and nothing else, which is
indistinguishable from a hang. The emittedAny guard is unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Full suite green**

Run: `npm test 2>&1 | tail -8`
Expected: 111 tests, 0 failing.

- [ ] **No lingering references to the retired provider**

Run: `grep -rn "github" src/ renderer/ main.js preload.js test/ -i | grep -v "github.com/daydroidmuchiri" | grep -v "retired"`
Expected: no output.

- [ ] **End-to-end smoke test**

Run: `npm start`. Then:
1. Settings shows five providers, no GitHub.
2. With OpenRouter selected and a key set, `Ctrl+H` on a visible coding problem returns a correct answer, faster than at baseline.
3. `Ctrl+Enter` (Assist) works.
4. Typing a question and pressing Enter works.

- [ ] **Migration check for an existing GitHub Models user**

This is the regression that matters most, and it only reproduces with real on-disk state. With the app **closed**, edit `%APPDATA%/cue/cue-data.json` and set `"provider": "github"`, leaving an OpenRouter key in place. Launch the app.

Expected: cue starts on `openrouter` (not stuck on `github`), no `unknown provider` error appears on the first action, and after boot the `apiKeys.github` entry is gone from `cue-data.json`.

- [ ] **Review the full diff**

Run: `git log --oneline main..HEAD` and `git diff main...HEAD --stat`
Expected: 8 commits (spec + 7 tasks). No changes to `package.json`, and no changes to the `openrouter` model IDs in `src/store.js`.
