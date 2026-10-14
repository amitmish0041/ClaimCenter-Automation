// electron-app/scripts/stage-filter.js
//
// Which files from the two repos ship, shared by the full build (stage-resources.js) and the code-only
// release (release-code.js) so both always agree on what "the code" is.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Names matched at ANY depth (not just top-level) so e.g. a nested
// tools/pdf-compare/__pycache__ is excluded too, not just a root-level one.
// CONFIRMED LIVE BUG (fixed here): this used to also list bare 'playwright' (intending some repo's own
// playwright/.cache-style dir), but shouldSkip() below only ever checks path.basename() with no path
// context - that single entry silently deleted the entire node_modules/playwright PACKAGE (the actual npm
// dependency @playwright/test's cli.js requires at runtime: 'playwright/lib/program') from every staged
// build, so every packaged SmartCOMM/Policy/Claims run failed with "Cannot find module 'playwright/lib/
// program'" the instant it tried to actually run a test (not caught by the earlier `--version` smoke test,
// which exits before cli.js needs that module). Never match a bare name that could also be a real
// node_modules package without a path check.
const EXCLUDE_NAMES = new Set([
  '.git', '.gitignore', 'electron-app', // electron-app excluded from the CLAIMS copy to avoid copying this very staging step into itself
  'test-results', 'playwright-report',
  'results', 'runtime-data', 'reports',
  '__pycache__', '.backup-2026-07-07',
  '.smartcomm-azure-session.json', '.smartcomm-okta-session.json', // per-person SSO session cache - never ship someone else's
  '.env', // real secrets - packaged app gets its own config via the Settings tab, not this repo's dev .env
]);
const EXCLUDE_EXT = new Set(['.log']);

function shouldSkip(srcPath, name) {
  if (EXCLUDE_NAMES.has(name)) return true;
  if (EXCLUDE_EXT.has(path.extname(name))) return true;
  if (name.startsWith('~$')) return true; // transient Office lock files (e.g. ~$Claims_Documents_Index.xlsx) - not real content
  return false;
}

// A NESTED project's node_modules holding only its devDependencies (2026-10-14: policy-repo/address-helper —
// jest/typescript/ts-jest, 116MB and ~15,000 of the installer's ~25,000 files; the Runner only loads its built
// dist/index.js, which needs none of them). File count is what makes building, uploading, downloading and
// installing slow. Only nested ones — a repo root's own node_modules always ships, even if its packages are
// listed as devDependencies (Playwright is).
function isDevOnlyNestedNodeModules(srcPath, root) {
  if (path.basename(srcPath) !== 'node_modules') return false;
  const owner = path.dirname(srcPath);
  if (path.resolve(owner) === path.resolve(root)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(owner, 'package.json'), 'utf8'));
    return !pkg.dependencies || !Object.keys(pkg.dependencies).length;
  } catch (_) { return false; }
}

// True when the full build copies this path.
function ships(srcPath, root) {
  return !shouldSkip(srcPath, path.basename(srcPath)) && !isDevOnlyNestedNodeModules(srcPath, root);
}

// The code of one repo for a code-only release: every shipped file EXCEPT anything inside a node_modules
// folder. Returns { files: [relPath...], nodeModulesDirs: [relPath...] } (the shipped node_modules folders,
// which an installed app links to from its own copy instead of downloading them again).
function listCode(root) {
  const files = [];
  const nodeModulesDirs = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (!ships(full, root)) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules') { nodeModulesDirs.push(rel); continue; }
        walk(full);
      } else if (ent.isFile()) {
        files.push(rel);
      }
    }
  })(root);
  return { files, nodeModulesDirs };
}

// Fingerprint of everything a code-only update can NOT change: the installed packages of both repos. A code
// package is only applied by an app whose own bundled packages have the same fingerprint.
function depsFingerprint(roots) {
  const h = crypto.createHash('sha256');
  for (const root of roots) {
    for (const f of ['package.json', 'package-lock.json']) {
      const p = path.join(root, f);
      let text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : '';
      // package.json's own "version"/"scripts" don't change what's installed — only dependency fields count.
      if (f === 'package.json' && text) {
        const j = JSON.parse(text);
        text = JSON.stringify({ dependencies: j.dependencies || {}, devDependencies: j.devDependencies || {} });
      }
      h.update(`${path.basename(root)}/${f}\n${text}\n`);
    }
  }
  return h.digest('hex');
}

// Sortable build id for code: UTC yyyymmddHHMMSS.
const buildId = (d = new Date()) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);

module.exports = { shouldSkip, isDevOnlyNestedNodeModules, ships, listCode, depsFingerprint, buildId };
