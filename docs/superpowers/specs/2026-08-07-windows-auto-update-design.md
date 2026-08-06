# Windows auto-update

**Date:** 2026-08-07
**Status:** Approved, implemented on branch `windows-auto-update`

## Problem

cue has no update mechanism. There is no `electron-updater`, no `autoUpdater`, and no
`publish` block in the build config. Every user is frozen on whatever version they
installed, and there is no way to reach them.

This is not hypothetical. Two releases in recent history contain changes users cannot
get:

- **v0.6.0** fixes an Anthropic path that was completely non-functional — both shipped
  model defaults pointed at retired models returning 404, and `max_tokens` was being
  sent as `undefined` on a required field.
- **`9cd9ba6`** upgraded Electron from 33.2.1 to 43.2.0, closing **18 disclosed CVEs**.

Anyone still on v0.5.1 has the CVEs and a broken Anthropic provider, permanently.

## Constraints discovered during design

**macOS auto-update is hard-blocked by code signing.** Squirrel.Mac refuses to apply an
update to an unsigned app — a framework-level requirement, not a configuration option.
cue's macOS builds set `build.mac.identity: null` and `hardenedRuntime: false`, so a
macOS updater could only ever fail. The original plan ("auto-update, then signing") had
the dependency backwards for that platform.

**The release pipeline does not publish the update manifest.** `release.yml` uploads only
`dist/*.exe` and `dist/*.zip`. electron-builder generates `latest.yml`, but nothing
uploads it, so electron-updater would have nothing to read. Confirmed against v0.6.0's
published assets: only `cue-0.6.0-arm64-mac.zip` and `cue.Setup.0.6.0.exe`.

## Decisions

**Windows only, permanently.** The user's decision, made with the macOS consequence stated
explicitly: macOS users will not receive updates through this mechanism. Rather than ship a
macOS code path that can only error, the platform gate never opens on `darwin`. If signing
is added later, `shouldAutoUpdate` is the single line to revisit.

**Silent download, install on quit.** cue is a transparent, click-through overlay used
during live meetings and screen shares. A modal update prompt would render into the user's
screen share and cannot be click-through. The update downloads in the background and
`autoInstallOnAppQuit` applies it when the user quits.

**One status line, only after the download completes.** The single piece of UI is a message
on the existing `status` channel (auto-hides after 11s) once the bits are on disk and the
update is genuinely actionable. Nothing is shown for `checking-for-update`,
`update-available`, or `update-not-available` — a toast on every launch is noise in an
overlay.

**One check per launch.** The install only applies on quit, so a periodic re-check would
find the same pending update and change nothing.

## Design

Follows the existing `store.js` → `settings-persistence.js` split: decisions live in a
pure module, Electron is wired in `main.js`.

| File | Change |
|---|---|
| `src/updater.js` | **new** — `shouldAutoUpdate`, `updateReadyMessage`, `wireAutoUpdater`. No `electron` or `electron-updater` import. |
| `main.js` | wire the real `autoUpdater` in `app.whenReady()`, after `createWindow()` |
| `package.json` | `electron-updater` dependency; `build.publish` (github provider); `--publish never` on the dist scripts |
| `.github/workflows/release.yml` | also upload `dist/latest.yml` and `dist/*.blockmap` |
| `test/updater.test.js` | **new** |

### The gate

```js
shouldAutoUpdate({ platform, isPackaged })  // true only for win32 && packaged
```

Development is excluded because electron-updater throws without a `dev-app-update.yml`,
and that throw would be swallowed by `main.js`'s `uncaughtException` handler on every
`npm start` — visible nowhere, since the window is transparent.

`electron-updater` is required **lazily**, inside the gate, so it never loads on platforms
that cannot use it. The whole block is wrapped in `try/catch`: an updater must never be the
reason the overlay fails to start.

### Failure handling

A failed update check is not the user's problem — they cannot act on it, and surfacing it
over a meeting is worse than staying on the current version. Failures are logged, never
toasted.

`wireAutoUpdater` attaches its `error` listener **before** calling `checkForUpdates()`. An
`error` event with no listener throws, and on the main process that would take the whole
overlay down over a failed network call. `checkForUpdates` is called synchronously (so the
check is genuinely in flight when the function returns) inside a `try/catch`, with a
`.catch` on the returned promise — covering both ways it can fail: throwing outright on a
misconfigured feed, or rejecting when offline.

### `--publish never`

`build.publish` is required so the packaged app embeds an `app-update.yml` telling it where
to look for updates. But electron-builder can also *upload* on its own when a tag and
`GH_TOKEN` are present — which is exactly the CI environment. Passing `--publish never`
keeps uploads owned by the workflow's existing `action-gh-release` step, so the release
pipeline behaves exactly as it does today.

### `artifactName` — the bug a config review would have missed

By default electron-builder names the NSIS installer from `productName`, producing
`cue Setup 0.6.0.exe` — **with spaces**. Three different names for one file result:

| Source | Name |
|---|---|
| file on disk | `cue Setup 0.6.0.exe` |
| `latest.yml` (URL-safe form electron-builder writes) | `cue-Setup-0.6.0.exe` |
| GitHub release asset (spaces rewritten to dots on upload) | `cue.Setup.0.6.0.exe` |

electron-updater reads `latest.yml`, requests `cue-Setup-0.6.0.exe`, and gets a **404**
from a release that holds `cue.Setup.0.6.0.exe`. Auto-update would appear wired up and
silently never apply. v0.6.0's published assets confirm the dotted form.

Setting `build.win.artifactName` to `${productName}-Setup-${version}.${ext}` removes the
spaces at the source, so all three names agree and GitHub has nothing to rewrite.

**This is only observable by running a real build.** No unit test can see it: the
filenames are produced by electron-builder and rewritten by GitHub's upload API, neither
of which exists in a test process. A local `npm run dist:win` is therefore part of
verifying this feature, not an optional extra.

### `.blockmap`

Uploading the blockmap enables differential downloads, so a patch release is not a full
107 MB re-download. The project already depends on this working: commit `33c959d` pinned
`@noble/hashes` to 1.8.0 specifically to unbreak electron-builder's blockmap step.

## Testing

Twelve unit tests in `test/updater.test.js`, all Electron-free:

- The gate across the platform × packaged matrix, with the macOS and dev cases each
  carrying the reason they are excluded.
- `updateReadyMessage` names the version, says the install waits for quit, and never
  renders a raw `undefined` when the payload has no version.
- `wireAutoUpdater` sets `autoDownload`/`autoInstallOnAppQuit` and issues exactly one check.
- Status fires **only** on `update-downloaded` — not on `update-available` (not yet
  actionable) and not on `update-not-available` (noise).
- Errors are logged and never toasted; a rejected check is swallowed rather than crashing;
  an `error` listener is always attached.

**Verified manually:** a local `npm run dist:win` produces `dist/latest.yml` and the
`.blockmap`, and the packaged app contains an `app-update.yml` pointing at the GitHub feed.
Without that manifest pair the feature silently does nothing, and no unit test can catch it.

## Out of scope

macOS code signing and notarization; `latest-mac.yml`; staged rollouts; release channels;
in-app "check for updates now"; update UI beyond the single status line.

## Follow-up this does not address

macOS users still cannot receive updates. That is now a known, accepted gap rather than an
oversight — reopening it means adding signing first, then flipping the gate.
