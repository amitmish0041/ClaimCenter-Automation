// electron-app/scripts/copy-to-share.js
//
// Post-build / post-release step: mirror the whole build output (everything in dist/) to the team's shared
// install folder on the V: drive, so the team installs/runs from there without waiting on GitHub. Wired into
// `npm run build` and `npm run release` (see package.json), and runnable on its own via `npm run copy-to-share`.
//
// Safe by design:
//   - Refuses to run unless dist/ actually holds a freshly built installer (guards against mirroring an EMPTY
//     dist/, which with /MIR would wipe the share).
//   - A missing / unreachable share is a loud WARNING, not a failure: on `release` the GitHub publish has
//     already succeeded by the time this runs, so an off-network machine must not flip the whole command to red.
//   - Uses robocopy /MIR so the share ends up an exact copy of this build (last version's leftovers are purged),
//     which is efficient over the network (only changed files move) and resilient (retries, no hang on a lock).
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIST = path.join(__dirname, '..', 'dist');

// Default to the mapped drive, then the UNC path it maps to; override with RUNNER_SHARE_DIR if it ever moves.
const SHARE_CANDIDATES = process.env.RUNNER_SHARE_DIR
  ? [process.env.RUNNER_SHARE_DIR]
  : ['V:\\Amit Int\\Playwright', '\\\\dmi-win-fs1\\Public\\Amit Int\\Playwright'];

function fail(msg) { console.error('copy-to-share: ' + msg); process.exit(1); }
function warnSkip(msg) {
  console.warn('copy-to-share: ' + msg + ' - SKIPPING the share copy (the build/publish itself is unaffected).');
  process.exit(0);
}

// 1) Only mirror a real build. Mirroring an empty/missing dist/ with /MIR would delete the team's files.
if (!fs.existsSync(DIST)) fail('dist/ not found at ' + DIST + ' - nothing to copy (run the build first).');
const hasInstaller = fs.readdirSync(DIST).some((n) => /^ClaimCenter-Runner-Setup-.*\.exe$/i.test(n));
if (!hasInstaller) fail('dist/ has no ClaimCenter-Runner-Setup-*.exe - not a complete build; refusing to mirror.');

// 2) Pick the first share whose drive/root is actually reachable (we create the leaf folder ourselves).
function rootOf(p) {
  if (/^[A-Za-z]:\\/.test(p)) return p.slice(0, 3);                     // "V:\Amit Int\..." -> "V:\"
  const m = p.match(/^(\\\\[^\\]+\\[^\\]+)\\/);                          // "\\server\share\..." -> "\\server\share"
  return m ? m[1] : p;
}
let dest = null;
for (const cand of SHARE_CANDIDATES) {
  try { if (fs.existsSync(rootOf(cand))) { dest = cand; break; } } catch (e) { /* unreachable root reads as absent */ }
}
if (!dest) warnSkip('shared drive not reachable (tried: ' + SHARE_CANDIDATES.join(' , ') + ')');
try { fs.mkdirSync(dest, { recursive: true }); } catch (e) { warnSkip('could not create ' + dest + ' (' + e.message + ')'); }

// 3) Mirror dist/ -> share. robocopy exit codes 0-7 are success (0 nothing to do, 1 copied, 2 extras purged,
//    ...); >= 8 is a real failure.
console.log('copy-to-share: mirroring everything in\n  ' + DIST + '\n  -> ' + dest);
const rc = spawnSync('robocopy', [DIST, dest, '/MIR', '/NFL', '/NDL', '/NJH', '/NP', '/R:1', '/W:2'], { stdio: 'inherit' });
if (rc.error) fail('could not run robocopy (' + rc.error.message + ')');
const code = rc.status == null ? 16 : rc.status;
if (code >= 8) fail('robocopy reported failure (code ' + code + ') - some files may not have copied (e.g. the app was open from the share).');
console.log('copy-to-share: done (robocopy code ' + code + ' = success). Team install folder updated: ' + dest);
process.exit(0);
