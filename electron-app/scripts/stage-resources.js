// electron-app/scripts/stage-resources.js
//
// Build-time step (run before electron-builder packs): vendors a clean copy of
// both sibling repos' runtime code, plus a single pinned Playwright Chromium
// build, into electron-app/.staging/ - electron-builder's extraResources
// config (see ../package.json) then copies that staging tree verbatim into
// the packaged app's resources folder.
//
// Why a copy instead of pointing extraResources straight at the live repos:
// electron-app/ lives INSIDE ClaimCenter-Automation, so a direct "copy my own
// parent directory" mapping is self-referential and fragile to get right with
// glob excludes alone. A small explicit copy step is easier to reason about
// and easier to exclude dev-only cruft (logs, results, .git, node_modules
// caches) from without fighting electron-builder's own file-filtering DSL.
//
// Usage: node scripts/stage-resources.js   (run from electron-app/, see package.json's "prebuild" script)
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ELECTRON_APP_DIR = path.join(__dirname, '..');
const CLAIMS_SRC = path.join(ELECTRON_APP_DIR, '..');                                   // ClaimCenter-Automation (this repo's root)
const POLICY_SRC = path.join(ELECTRON_APP_DIR, '..', '..', 'Commercial Line Performance test');
// Outside both repos - see staging-path.js for why (electron-app/ lives INSIDE ClaimCenter-Automation, so a
// staging folder under electron-app/ is "copy a directory into its own subdirectory" and fs.cpSync refuses it).
const STAGING = require('./staging-path.js');
const POLICY_DEST = path.join(STAGING, 'policy-repo');
const CLAIMS_DEST = path.join(STAGING, 'ClaimCenter-Automation');
const BROWSERS_DEST = path.join(STAGING, 'playwright-browsers');

if (!fs.existsSync(POLICY_SRC)) {
  console.error(`Expected sibling repo not found: ${POLICY_SRC}`);
  console.error('This script assumes both repos sit side by side under the same parent folder.');
  process.exit(1);
}

// Names matched at ANY depth (not just top-level) so e.g. a nested
// tools/pdf-compare/__pycache__ is excluded too, not just a root-level one.
const EXCLUDE_NAMES = new Set([
  '.git', '.gitignore', 'electron-app', // electron-app excluded from the CLAIMS copy to avoid copying this very staging step into itself
  'test-results', 'playwright-report', 'playwright', // 'playwright' here = the project's own playwright/.cache dir pattern, not the npm package inside node_modules
  'results', 'runtime-data', 'reports',
  '__pycache__', '.backup-2026-07-07',
  '.smartcomm-azure-session.json', '.smartcomm-okta-session.json', // per-person SSO session cache - never ship someone else's
  '.env', // real secrets - packaged app gets its own config via the Settings tab, not this repo's dev .env
]);
const EXCLUDE_EXT = new Set(['.log']);

function shouldSkip(srcPath, name) {
  if (EXCLUDE_NAMES.has(name)) return true;
  if (EXCLUDE_EXT.has(path.extname(name))) return true;
  return false;
}

function copyTree(src, dest) {
  // maxRetries/retryDelay: confirmed live - deleting a just-rebuilt staging tree can transiently EPERM/
  // ENOTEMPTY on Windows (something - Search indexing or AV real-time scanning, never pinned down exactly
  // which - holds a brief lock on freshly-written files, observed clearing on its own after roughly 30-60s,
  // NOT within 5s). These are fs.rmSync's own built-in retry knobs for exactly this class of transient lock,
  // not custom retry logic - 10 retries * 3s = up to 30s of backoff before actually giving up.
  fs.rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 3000 });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => !shouldSkip(source, path.basename(source)),
  });
}

console.log('── Staging policy-repo (Commercial Line Performance test) ──');
copyTree(POLICY_SRC, POLICY_DEST);
// runtime-data/ itself is excluded above (stale JSON/log state from dev runs), but server.js expects the
// directory to exist (fs.mkdirSync-on-demand calls would otherwise fail if a PARENT segment is also missing)
// and the packaged build's settings/entitlements cache live under userData instead anyway - an empty folder
// here just keeps any dev-use-only relative reads from throwing.
fs.mkdirSync(path.join(POLICY_DEST, 'runtime-data'), { recursive: true });

console.log('── Staging ClaimCenter-Automation ──');
copyTree(CLAIMS_SRC, CLAIMS_DEST);

console.log('── Installing pinned Playwright Chromium for both repos into a shared bundle ──');
fs.mkdirSync(BROWSERS_DEST, { recursive: true });
const installEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DEST };
for (const cwd of [POLICY_SRC, CLAIMS_SRC]) {
  // Installs into BROWSERS_DEST (not each repo's own global ms-playwright cache) - run from each repo's own
  // cwd so npx resolves THAT repo's own installed @playwright/test version and fetches the matching Chromium
  // revision. Both repos share BROWSERS_DEST, so if they happen to need the same revision it's only
  // downloaded once; if they differ, both revisions end up side by side (Playwright's own cache layout
  // already supports multiple revisions coexisting).
  const r = spawnSync('npx', ['playwright', 'install', 'chromium'], { cwd, env: installEnv, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`playwright install chromium failed for ${cwd}`);
    process.exit(r.status || 1);
  }
}

console.log('── Staging complete ──');
console.log(`  ${POLICY_DEST}`);
console.log(`  ${CLAIMS_DEST}`);
console.log(`  ${BROWSERS_DEST}`);
