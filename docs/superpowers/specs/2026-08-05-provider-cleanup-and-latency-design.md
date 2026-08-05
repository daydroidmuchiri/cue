# Remove GitHub Models; cut time-to-first-token

**Date:** 2026-08-05
**Status:** Approved, ready for implementation planning

## Problem

Two independent problems, bundled because both were found in the same pass.

### 1. The `github` provider is dead

GitHub Models was retired on **July 30, 2026**. Both endpoints cue uses now return
`410 Gone`, verified 2026-08-05:

```
GET  https://models.github.ai/catalog/models            -> 410
POST https://models.github.ai/inference/chat/completions -> 410
{"error":{"code":"github_models_retirement_brownout",
          "message":"GitHub Models is temporarily unavailable as part of a scheduled retirement brownout."}}
```

The "temporarily" in that payload is stale copy from the pre-retirement brownout
window (July 16 and 23); the retirement itself has already happened. Timeline:
closed to new customers June 16, brownouts July 16/23, full retirement July 30.

cue added this provider in `ddd8847`. It fails badly: `isRetriableOpenRouterError`
(`src/llm.js:41`) covers only 400/404/429 and only when `provider === 'openrouter'`,
so a GitHub user gets a bare `410` with no fallback and no explanation.

### 2. "Wait for the answer" is slow

Measured on this machine (1536x864 @ 1.25x, so a 1920x1080 capture), via
`desktopCapturer` benchmarks:

| Stage | Cost |
|---|---|
| `getSources` first call (cold) | **1590 ms** |
| `getSources` subsequent calls (warm) | **~620 ms** |
| `toDataURL()` PNG encode | 112 ms |
| PNG payload | 0.31 MB base64 |
| resize to 1280 + `toJPEG(80)` | 39 ms, 0.14 MB |

The key measurement: **`getSources` costs ~620 ms regardless of `thumbnailSize`** —
a 1x1 thumbnail costs the same as full resolution. The time is fixed capture-stream
startup, not pixel work. Shrinking the screenshot does not speed up capture.

`assist`, `ask`, and `leetcode` all set `needsScreen: true`, so every interactive
action pays this.

## Non-goals

- **Removing OpenAI / Anthropic / Gemini.** `src/stt.js` can only transcribe via an
  OpenAI (Whisper) or Gemini key; OpenRouter has no audio API. Removing them would
  permanently kill meeting transcription and orphan all the mic/system-audio capture
  code. They are lazily `require`d and cost nothing at runtime when unused.
- **Removing NVIDIA.** Explicitly kept per the user's decision.
- **Fixing free-tier queueing.** On OpenRouter's free tier, queue time dominates and
  no code change touches it. This spec removes ~1–1.5 s of *local* latency and makes
  the remaining wait legible; it does not make free models fast.
- **Changing the fast/smart model defaults.** See "Correction" below.

## Correction to the original proposal

The design review floated changing the Smart defaults on the grounds that
`google/gemma-4-31b-it:free` is "slower without being much smarter" than
`google/gemma-4-26b-a4b-it:free`. That was overstated. The 26b-a4b model is a
mixture-of-experts with ~4B active parameters; the 31b is dense. A dense 31B
genuinely is stronger than a 26B MoE with 4B active — it is slower *because* it is
doing more work. That is the fast/smart trade-off behaving as designed, not a bug.

**Decision: leave the model defaults alone.** Both IDs were verified present in the
live OpenRouter catalog on 2026-08-05, and both are among only five free models that
accept image input — which cue's screen features require. They are good picks.

## Design

### Part 1 — Remove the `github` provider

Straight deletions:

| File | Change |
|---|---|
| `src/llm.js:17` | drop `github` from `PROVIDER_BASE_URLS` |
| `src/llm.js:192` | drop `\|\| provider === 'github'` from the OpenAI-compatible branch |
| `src/store.js:18` | drop `github: ''` from `DEFAULTS.apiKeys` |
| `src/store.js:29-30` | drop the `github` model block and its comment |
| `renderer/index.html:69` | drop the `data-provider="github"` segment button |
| `renderer/index.html:78` | drop the `#key-github` field |
| `renderer/renderer.js:354,386` | drop the `#key-github` fill/save lines |
| `renderer/renderer.js:369` | drop `k.github && 'GitHub'` from `statusText` |
| `test/llm.test.js:64-72` | drop the two `github` assertions/tests |

Note `SECRET_FIELDS` in `src/store.js:37` is derived from `DEFAULTS.apiKeys`, so it
updates itself. That derivation is deliberate (see the comment there) and must stay.

#### The part that is not deletion: a settings migration

Two latent failures for anyone who already selected GitHub Models:

1. **Stuck on a dead provider.** `applyAutoSwitch` (`settings-persistence.js:43`)
   returns early when `data.apiKeys[data.provider]` is truthy. A user with
   `provider: 'github'` *and* a saved PAT therefore never gets auto-switched, and
   `createLLM` falls through to `unknown provider: github` on every action.
   `deepMerge(defaults, parsed)` preserves the on-disk `provider` value even after
   `github` leaves `DEFAULTS`, so this does not self-heal.

2. **An orphaned secret lingering on disk.** `encryptFields` (`secure-fields.js:9`)
   starts from `{ ...obj }`, so keys absent from `secretFields` are copied through
   untouched. Once `github` leaves `SECRET_FIELDS`, the stored PAT stays in
   `cue-data.json` indefinitely with no UI to view or clear it.

Fix both in `src/settings-persistence.js`, which is already unit-testable without
Electron:

- Add a `knownProviders` option to `createSettingsStore`. In `load()`, before
  `applyAutoSwitch()`, reset `data.provider` when it is not in `knownProviders`:
  prefer a provider the user has a key for, else fall back to `defaults.provider`.
  Ordering matters — the migration must run first so `applyAutoSwitch` then sees a
  valid provider.
- In `save()`, drop `apiKeys` entries that are not in `secretFields`, so the orphaned
  PAT is pruned on the next write. `main.js:371` already calls `store.setSettings({})`
  at boot for exactly this kind of migration, so the prune happens on first launch.

`src/store.js` passes `knownProviders: Object.keys(DEFAULTS.apiKeys)` — derived, not
a second hand-maintained list, matching the existing `SECRET_FIELDS` pattern.

### Part 2 — Cut time-to-first-token

#### 2a. Pre-warm the capturer (biggest single win)

The cold/warm gap is ~970 ms and is paid by the first screen action of every session.
In `main.js`, inside `app.whenReady()`, fire one throwaway capture:

```js
desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
  .catch(() => {});
```

Deliberately not awaited — it must not delay `createWindow()`. The 1x1 thumbnail is
discarded; the only goal is paying the capture-stream startup cost off the critical
path.

**macOS caveat:** on macOS the first `getSources` call is what triggers the
Screen-Recording permission prompt. Firing it at boot moves that prompt from "first
time you press Assist" to "app launch", which is arguably better (it lines up with
the onboarding flow that already tells users to grant it) but is a real behavior
change on that platform. Must be verified on macOS before release.

#### 2b. Downscale + JPEG in `src/screen.js`

Does **not** speed up capture (measured: size-independent). It cuts two other things:
upload bytes, and image prefill tokens at the model — the latter being on the slow
side of the wire. 2.2x smaller on this 1080p display; on a 4K or retina display, more
than 10x, since the current code multiplies by `scaleFactor`.

- Keep capturing at native resolution (no gain from asking for less).
- Resize the resulting `nativeImage` to a 1280 px long edge, preserving aspect ratio,
  skipping the resize when already smaller.
- Return `toJPEG(80)` as a `data:image/jpeg;base64,...` URL instead of `toDataURL()`.
- Preserve the existing `null` returns for "no sources" and "empty image".

Constants `MAX_EDGE = 1280` and `JPEG_QUALITY = 80` named at module top with a comment
explaining they trade OCR fidelity against latency — 1280 keeps typical IDE and
LeetCode text legible.

Downstream compatibility: `stripDataUrl` (`llm.js:54`) parses the mime out of the data
URL generically, so Anthropic's `media_type` and Gemini's `mimeType` both follow
automatically. No change needed in either.

#### 2c. Per-mode `maxTokens`

`DEFAULT_MAX_TOKENS = 8192` applies to every call, including `say` (1–3 sentences),
`followup` (2–4 bullets) and `recap` (short bullets).

`src/llm.js:190` already builds `const args = { apiKey, model, maxTokens, signal, ...params }`
with `params` spread last, so a caller-supplied `maxTokens` already wins. The change
is therefore additive and small:

- Add `maxTokens` to the mode definitions in `src/prompts.js`: `1024` for `say`,
  `followup`, `recap`; leave `assist`, `ask`, `leetcode` on the 8192 default, since
  those produce full code answers.
- `main.js` passes `maxTokens: def.maxTokens` in the `llm.stream()` call. Undefined
  for the code modes, which correctly falls back to `DEFAULT_MAX_TOKENS`.

#### 2d. Make the silent fallback retry visible

When a free model returns 429, `llm.js:208` fires a **second full request** against
`openrouter/free`. This roughly doubles the wait, and today it is indistinguishable
from a hang — the UI shows a caret and nothing else.

- Add an optional `onRetry` callback to the `stream()` params. Call it immediately
  before the fallback `streamOpenAI` call.
- `main.js` wires it to the existing `send('status', ...)` channel with a message like
  `"<model> is rate-limited right now — retrying with OpenRouter's free router."`
- The renderer already renders `status` events via `showStatus` (`renderer.js:324`),
  so no renderer change is needed.

The existing `emittedAny` guard in `shouldRetryWithFreeRouter` stays exactly as-is —
its reasoning (never concatenate two models' output into one bubble) is sound and
unrelated.

## Testing

Existing suite is `node --test` over `test/`. All new logic lands in already-tested,
Electron-free modules.

**Unit — `test/settings-persistence.test.js`:**
- `provider: 'github'` **with** a saved github key migrates to a provider the user has
  a key for (the case `applyAutoSwitch` cannot handle today).
- `provider: 'github'` with no keys at all falls back to `defaults.provider`.
- A valid provider is left untouched by the migration.
- The migration runs before auto-switch, not after.
- `save()` prunes `apiKeys` entries absent from `secretFields`.
- An undecryptable field that *is* in `secretFields` is still preserved — the prune
  must not regress the existing ciphertext-preservation guarantee.

**Unit — `test/llm.test.js`:**
- `resolveBaseURL('github')` is now `undefined`.
- `createLLM({ provider: 'github', ... }).stream()` rejects with `unknown provider`.
- `onRetry` fires exactly once on a 429 that triggers the free-router fallback, and
  does not fire on success, on 401/403, or when `emittedAny` is true.

**Unit — `test/prompts.test.js`:**
- The three small modes declare `maxTokens: 1024`; the three code modes leave it unset.

**Manual (not unit-testable — needs a real display):**
- Re-run the capture benchmark after 2b; confirm first-Assist latency drops by roughly
  the cold/warm gap and the payload shrinks as predicted.
- Confirm the screenshot still reads clearly enough at 1280 px for a LeetCode problem
  to be solved correctly.
- macOS: confirm the pre-warm does not break or badly reorder the Screen-Recording
  permission prompt.

## Sequencing

Two commits, in order. Part 1 is small, self-contained, and fixes something that is
actively broken today; it should not wait on Part 2.

1. `fix: remove retired GitHub Models provider, with settings migration`
2. `perf: cut time-to-first-token (capturer pre-warm, JPEG downscale, per-mode caps)`

## Expected outcome

- First screen action of a session: ~1.6 s of capture becomes ~0.6 s.
- Image payload: 2.2x smaller on 1080p, 10x+ on hi-DPI, with a matching cut in image
  prefill tokens.
- Small modes stop over-provisioning 8192 output tokens.
- Rate-limit retries read as "retrying" instead of as a hang.
- Nobody is stranded on a dead provider, and no orphaned PAT is left on disk.

Free-tier queue time is unchanged and will still dominate on a bad draw.

## References

- [GitHub Models is being fully retired on July 30, 2026](https://github.blog/changelog/2026-07-01-github-models-is-being-fully-retired-on-july-30-2026/)
- [GitHub Models is now retired](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/)
- [GitHub Models is no longer available to new customers](https://github.blog/changelog/2026-06-16-github-models-is-no-longer-available-to-new-customers/)
