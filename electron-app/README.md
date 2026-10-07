# ClaimCenter Runner — packaged Windows app

A self-contained Windows `.exe` wrapping the Playwright Test Runner UI (`../../Commercial Line Performance test/runner/`)
and the scripts it drives in this repo. No Node, npm, Python, or Git required on the installing machine.

**v1 scope:** SmartCOMM Validator (on by default), Policy, Claims, and Jira Sprint Report tabs are fully functional.
Migration Reconciliation, Update Validation, and PDF Compare are visible but show "not available in this build yet"
(they need a third sibling repo + npm, and a bundled Python runtime, respectively — deferred to v2).

## Files changed/added for this

- **`runner/server.js`** (in the sibling `Commercial Line Performance test` repo) — added packaged-runtime
  detection (`RUNNER_PACKAGED`/`RUNNER_NODE_EXEC`), entitlements fetch/cache/enforcement, a `/api/settings`
  endpoint, localhost-only binding, and an explicit dotenv path. Still runs completely unmodified in plain
  `node runner/server.js` dev use — none of this activates unless `electron-app/main.js` sets those env vars first.
- **`runner/index.html`** (same repo) — added a Settings tab (name/email/SmartCOMM data folder) and
  entitlement-aware tab locking (a locked or not-yet-shipped tab shows a shared "blocked" panel instead of its
  real controls).
- **`electron-app/main.js`** — Electron main process: starts `server.js` in-process, opens the window, wires
  auto-update, routes external links (the "Request access" mailto link) to the OS's own handler.
- **`electron-app/package.json`** — app + electron-builder config (NSIS installer, GitHub Releases publishing).
- **`electron-app/scripts/stage-resources.js`** — build-time step: vendors both repos + a pinned Playwright
  Chromium build into `electron-app/.staging/` for electron-builder to package.
- **`electron-app/entitlements/entitlements.json`** — the file you edit to grant tab access (see below).

## Build

```
cd electron-app
npm install
npm run build
```

This runs `stage-resources.js` first (vendors both repos + downloads/copies the pinned Chromium build into
`.staging/` — the first run takes a few minutes; later runs are fast since Playwright skips an already-present
browser revision), then `electron-builder --win`.

**Output:** `electron-app/dist/ClaimCenter Runner Setup <version>.exe` — a one-click NSIS installer (no admin
prompt, installs per-user).

## Publishing a new version

1. Bump `"version"` in `electron-app/package.json` (semver: `1.0.0` → `1.1.0` → `1.1.1` → `2.0.0`, not timestamps).
2. Set a `GH_TOKEN` environment variable with `repo` scope on **your own machine** (never embedded in the app):
   ```
   $env:GH_TOKEN = "ghp_..."
   ```
3. `npm run release` — builds, then uploads the installer + an auto-generated `latest.yml` to a new GitHub
   Release on `amitmish0041/ClaimCenter-Automation`.

**To pull a bad release:** mark it a "pre-release" on GitHub (or delete it). electron-updater only ever offers
the latest *non-prerelease* release, so this takes effect immediately with no code change.

**Code signing is not set up.** An unsigned installer triggers a Windows SmartScreen warning on first run.
Getting a code-signing certificate is a separate decision — flagging it again here since it'll affect how
comfortable people are double-clicking this the first time.

## How updates work

- The installed app's own `package.json` version is what it compares against GitHub's latest release
  (`electron-updater`'s GitHub provider, configured in `package.json`'s `build.publish`).
- On launch, it checks silently, downloads a newer version in the background if found, then shows a small
  "Restart now / Later" prompt — never force-restarts mid-session. If there's no update, or the check fails
  (offline, etc.), the app just keeps running on the current version.
- Existing settings (`%APPDATA%/claimcenter-runner/settings.json`) and the entitlements cache live in Electron's
  `userData` folder, which installers/updates don't touch — nothing is lost across an update.

## Tab-access approval (entitlements)

- `electron-app/entitlements/entitlements.json` in this repo is the source of truth:
  ```json
  { "default": ["smartcomm"], "grants": { "someone@donegalgroup.com": ["smartcomm", "policy", "claims", "jiraReport"] } }
  ```
- Every installed app fetches this (from `raw.githubusercontent.com`, public repo, no token needed) on launch
  and every ~15 minutes, caching the last-good copy locally so it still works offline.
- **To approve someone:** add their email to `grants` with the tab keys they should get (`policy`, `claims`,
  `smartcomm`, `jiraReport` — the only ones that do anything in v1), commit, push. Their app picks it up within
  15 minutes, or immediately on their next launch.
- `smartcomm` is always unlocked for everyone, regardless of what's in this file.
- Enforced both in the UI (locked tabs show a request-access panel instead of their real controls) and
  server-side (`/api/run` rejects a suite the caller isn't entitled to), so this isn't just a hideable button.

## Environment / production configuration

Nothing needs to be set by hand for a normal install — the Settings tab (first launch) is where an installed
user enters their name, email, and SmartCOMM data folder; these are written to
`%APPDATA%/claimcenter-runner/settings.json` and picked up live (no restart needed). The one thing you control
centrally is `electron-app/entitlements/entitlements.json`, above.

## Testing the packaged .exe on a clean machine

1. Copy *only* `dist/ClaimCenter Runner Setup <version>.exe` to a Windows VM/user profile with no Node, Python,
   or Git installed.
2. Install and launch. Confirm: the window opens to `http://127.0.0.1:3100` with no console/terminal visible;
   SmartCOMM is unlocked; Policy/Claims/Jira Report show locked (request-access) until you grant them; Migration
   Reconciliation/Update Validation/PDF Compare show "not available in this build yet."
3. Settings tab: enter a name/email, and a SmartCOMM data folder (ask the repo owner for a copy of
   `Claims_Documents_Index*.xlsx` + the template `.docx` files — this isn't bundled into the installer since it
   changes independently of app releases).
4. Run a real SmartCOMM template validation end-to-end. Check Task Manager while it runs — you should see the
   app's own process tree (no separately-installed system Node or Chrome involved).
5. Grant that test machine's email `policy`/`claims`/`jiraReport` in `entitlements.json`, push, and confirm those
   tabs unlock within 15 minutes (or immediately after relaunching).
6. Bump the version, publish a test release, confirm the installed build offers "Restart now," and that marking
   that release a pre-release makes it stop being offered.
