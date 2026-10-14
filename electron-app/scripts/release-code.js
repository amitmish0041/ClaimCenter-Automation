// electron-app/scripts/release-code.js — `npm run release:code`
//
// Code-only update: packs just the code of both repos (no node_modules, no Chromium — a few MB instead of the
// ~320MB installer) and publishes it as a GitHub PRE-release tagged code-<build>. Installed apps check for it at
// launch, verify its SHA-256 against the manifest, unpack it next to their install and offer a quick restart —
// no download of the full installer, no reinstall (see code-updater.js).
//
// Refuses when a code-only update can't work, so those changes go out with `npm run release` instead:
//   - the packages (package.json / package-lock.json of either repo) differ from the installed app's, or
//   - the latest installed app predates code-only updates (no code-base.json on its release).
// Changes to electron-app itself (main.js etc.) also need `npm run release` — they aren't in the code package.
//
// Pre-release + make_latest=false matters: the installer updater (electron-updater) reads GitHub's "latest"
// release, which must stay the installer release.
//
// Usage: npm run release:code            (needs GH_TOKEN, like npm run release)
//        npm run release:code -- --dry-run   (builds the package into dist/code/ only; no token, no upload)
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { listCode, depsFingerprint, buildId } = require('./stage-filter.js');
const gh = require('./github-release.js');

const ELECTRON_APP_DIR = path.join(__dirname, '..');
const CLAIMS_SRC = path.join(ELECTRON_APP_DIR, '..');
const POLICY_SRC = path.join(ELECTRON_APP_DIR, '..', '..', 'Commercial Line Performance test');
const REPOS = { 'policy-repo': POLICY_SRC, 'ClaimCenter-Automation': CLAIMS_SRC };
const DRY = process.argv.includes('--dry-run');

const gitHead = (dir) => { try { return execSync('git rev-parse --short HEAD', { cwd: dir }).toString().trim(); } catch (_) { return null; } };
const gitDirty = (dir) => { try { return execSync('git status --porcelain -- . ":!results" ":!logs" ":!electron-app"', { cwd: dir }).toString().split('\n').filter((l) => /^\s*M|^\?\?/.test(l) && /\.(js|ts|html|json|css)$/.test(l)).length; } catch (_) { return 0; } };

(async () => {
  const fingerprint = depsFingerprint([POLICY_SRC, CLAIMS_SRC]);

  // The app version people have installed = GitHub's latest (installer) release.
  let minShell = require('../package.json').version;
  if (!DRY) {
    const shell = await gh.latestRelease();
    if (!shell) throw new Error('no installer release found on GitHub — run npm run release first');
    const baseBuf = await gh.downloadAsset(shell, 'code-base.json');
    if (!baseBuf) {
      throw new Error(`the installed app (${shell.tag_name}) predates code-only updates. Run "npm run release" once ` +
        '(bump the version first); after that, code changes can go out with "npm run release:code".');
    }
    const base = JSON.parse(baseBuf.toString('utf8'));
    if (base.depsFingerprint !== fingerprint) {
      throw new Error(`packages changed since ${shell.tag_name} (package.json / package-lock.json of a repo), so ` +
        'this needs the full installer: bump the version and run "npm run release".');
    }
    minShell = shell.tag_name.replace(/^v/, '');
  }

  const build = buildId();
  const bundle = { format: 1, build, repos: {} };
  let fileCount = 0;
  for (const [name, root] of Object.entries(REPOS)) {
    const { files, nodeModulesDirs } = listCode(root);
    bundle.repos[name] = {
      nodeModulesDirs,
      emptyDirs: name === 'policy-repo' ? ['runtime-data'] : [],
      files: files.map((rel) => [rel, fs.readFileSync(path.join(root, rel)).toString('base64')]),
    };
    fileCount += files.length;
    const dirty = gitDirty(root);
    if (dirty) console.warn(`[release:code] note: ${name} has ${dirty} uncommitted code file(s) — they ARE included (the package is built from the working folder).`);
  }
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 });
  const sha256 = crypto.createHash('sha256').update(gz).digest('hex');
  const manifest = {
    build, sha256, size: gz.length, fileCount, depsFingerprint: fingerprint, minShell,
    createdAt: new Date().toISOString(),
    commits: { 'policy-repo': gitHead(POLICY_SRC), 'ClaimCenter-Automation': gitHead(CLAIMS_SRC) },
  };
  const bundleName = `code-${build}.json.gz`;
  console.log(`[release:code] build ${build}: ${fileCount} files, ${(gz.length / 1048576).toFixed(1)} MB, sha256 ${sha256.slice(0, 16)}…, for app ${minShell}+`);

  if (DRY) {
    const out = path.join(ELECTRON_APP_DIR, 'dist', 'code');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, bundleName), gz);
    fs.writeFileSync(path.join(out, 'code-manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`[release:code] dry run — written to ${out}, nothing uploaded`);
    return;
  }

  const rel = await gh.createRelease({
    tag_name: `code-${build}`,
    name: `Code update ${build} (app ${minShell})`,
    body: `Code-only update for ClaimCenter Runner ${minShell}+. Installed apps pick this up at launch (no reinstall).\n\n` +
      `Commits: policy-repo ${manifest.commits['policy-repo']}, ClaimCenter-Automation ${manifest.commits['ClaimCenter-Automation']}\n` +
      'To withdraw it, delete this release — apps go back to the previous code on their next launch.',
    prerelease: true,
    make_latest: 'false',
  });
  await gh.uploadAsset(rel, 'code-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');
  await gh.uploadAsset(rel, bundleName, gz, 'application/gzip');
  console.log(`[release:code] published ${rel.html_url}`);
})().catch((e) => { console.error(`[release:code] ${e.message}`); process.exit(1); });
