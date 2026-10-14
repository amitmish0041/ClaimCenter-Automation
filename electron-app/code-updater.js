// electron-app/code-updater.js
//
// Code-only updates (see scripts/release-code.js). The installer carries the app shell, Chromium, both repos'
// node_modules and a copy of the code; most releases only change the code (a few MB). Those are published as
// GitHub pre-releases tagged code-<build> with:
//   code-manifest.json  { build, sha256, size, depsFingerprint, minShell, ... }
//   code-<build>.json.gz  the code files of both repos
// At launch this module (1) picks which code to run — a downloaded newer build if it fits this install, else
// the installer's own copy — and (2) in the background looks for a newer code build, downloads it, checks its
// SHA-256 against the manifest, unpacks it under userData/code/<build>/ and links that folder's node_modules to
// the install's own (junctions — nothing re-downloaded). It takes effect on the next start ("Restart now").
//
// A build is only used when its package fingerprint equals this install's (code-base.json) and this app version
// is at least its minShell — so a code package never runs against packages it wasn't built for. Deleting a
// code release on GitHub withdraws it: the next launch goes back to the newest remaining build (or the
// installer's own code). Any failure here just means "keep running the current code".
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const OWNER = 'amitmish0041';
const REPO = 'ClaimCenter-Automation';
const REPO_NAMES = ['policy-repo', 'ClaimCenter-Automation'];

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

function semverGte(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return true;
}

function paths(resourcesPath, userDataDir) {
  const codeDir = path.join(userDataDir, 'code');
  return { codeDir, activeFile: path.join(codeDir, 'active.json'), baseFile: path.join(resourcesPath, 'code-base.json') };
}

// A downloaded build folder is usable when its server entry point and node_modules links are in place.
function folderUsable(dir, resourcesPath) {
  if (!fs.existsSync(path.join(dir, 'policy-repo', 'runner', 'server.js'))) return false;
  const meta = readJson(path.join(dir, '.code-meta.json'));
  if (!meta) return false;
  return (meta.links || []).every((l) => fs.existsSync(path.join(dir, l)) && fs.existsSync(path.join(resourcesPath, l)));
}

// Which code to run this launch: { root, build, source: 'update' | 'installer' }.
function activeCodeRoot({ resourcesPath, userDataDir, appVersion }) {
  const p = paths(resourcesPath, userDataDir);
  const base = readJson(p.baseFile);
  const installer = { root: resourcesPath, build: base ? base.build : null, source: 'installer' };
  if (!base) return installer;
  const active = readJson(p.activeFile);
  if (!active || !active.build) return installer;
  const dir = path.join(p.codeDir, active.build);
  if (active.build > base.build && active.depsFingerprint === base.depsFingerprint
    && semverGte(appVersion, active.minShell || '0.0.0') && folderUsable(dir, resourcesPath)) {
    return { root: dir, build: active.build, source: 'update' };
  }
  return installer;
}

async function get(url, accept) {
  const res = await fetch(url, { headers: { 'User-Agent': 'claimcenter-runner', ...(accept ? { Accept: accept } : {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Code release tags, newest first. Uses the releases Atom feed + direct download URLs, not the REST API — the
// API's 60-requests/hour limit is per IP, and the whole office shares one.
async function listCodeTags(baseUrl) {
  const feed = (await get(`${baseUrl}/releases.atom`, 'application/atom+xml')).toString('utf8');
  const tags = [...new Set([...feed.matchAll(/releases\/tag\/(code-\d{14})/g)].map((m) => m[1]))];
  return tags.sort().reverse();
}
const GITHUB = `https://github.com/${OWNER}/${REPO}`;
const assetUrl = (baseUrl, tag, name) => `${baseUrl}/releases/download/${tag}/${name}`;

function safeJoin(root, rel) {
  const target = path.resolve(root, rel);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error(`unsafe path in code package: ${rel}`);
  return target;
}

function removeBuildDir(dir) {
  const meta = readJson(path.join(dir, '.code-meta.json'));
  for (const l of (meta && meta.links) || []) { try { fs.unlinkSync(path.join(dir, l)); } catch (_) { /* gone */ } }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
}

async function install(manifest, tag, { resourcesPath, codeDir, log, baseUrl }) {
  const final = path.join(codeDir, manifest.build);
  if (folderUsable(final, resourcesPath)) return final;
  const gz = await get(assetUrl(baseUrl, tag, `code-${manifest.build}.json.gz`));
  const sha = crypto.createHash('sha256').update(gz).digest('hex');
  if (gz.length !== manifest.size || sha !== manifest.sha256) {
    throw new Error(`code ${manifest.build}: download doesn't match its manifest (sha256/size) — not used`);
  }
  const bundle = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  if (bundle.format !== 1 || bundle.build !== manifest.build) throw new Error(`code ${manifest.build}: unexpected package format`);
  const partial = `${final}.partial`;
  if (fs.existsSync(partial)) removeBuildDir(partial);
  const links = [];
  for (const name of REPO_NAMES) {
    const repo = bundle.repos[name];
    if (!repo) throw new Error(`code ${manifest.build}: ${name} missing from package`);
    const root = path.join(partial, name);
    for (const [rel, b64] of repo.files) {
      const target = safeJoin(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(b64, 'base64'));
    }
    for (const rel of repo.emptyDirs || []) fs.mkdirSync(safeJoin(root, rel), { recursive: true });
    // node_modules come from this install — linked, not downloaded.
    for (const rel of repo.nodeModulesDirs || []) {
      const from = path.join(resourcesPath, name, rel);
      if (!fs.existsSync(from)) continue;
      const link = safeJoin(root, rel);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(from, link, 'junction');
      links.push(`${name}/${rel}`);
    }
  }
  fs.writeFileSync(path.join(partial, '.code-meta.json'), JSON.stringify({ build: manifest.build, tag, links }, null, 2));
  // Junctions are absolute, so renaming the folder keeps them valid.
  fs.renameSync(partial, final);
  log(`[code-update] code ${manifest.build} downloaded and verified (${manifest.fileCount} files)`);
  return final;
}

// Background check. Resolves { ready: true, build } when a different code build has been installed and will be
// used from the next start; { ready: false } otherwise.
// baseUrl: tests only (a local stand-in for GitHub); the app always uses GitHub.
async function checkForCodeUpdate({ resourcesPath, userDataDir, appVersion, log = () => {}, baseUrl = GITHUB }) {
  const p = paths(resourcesPath, userDataDir);
  const base = readJson(p.baseFile);
  if (!base) return { ready: false };
  fs.mkdirSync(p.codeDir, { recursive: true });
  const current = activeCodeRoot({ resourcesPath, userDataDir, appVersion });

  // Newest code build that fits this install.
  let target = null;
  for (const tag of await listCodeTags(baseUrl)) {
    const build = tag.slice(5);
    if (build <= base.build) break; // older than (or same as) the code this installer already has
    let manifest;
    try { manifest = JSON.parse((await get(assetUrl(baseUrl, tag, 'code-manifest.json'))).toString('utf8')); } catch (_) { continue; }
    if (manifest.build !== build || manifest.depsFingerprint !== base.depsFingerprint || !semverGte(appVersion, manifest.minShell)) continue;
    target = { tag, manifest };
    break;
  }

  const wantBuild = target ? target.manifest.build : base.build;
  if (wantBuild === current.build) return { ready: false };

  if (target) {
    await install(target.manifest, target.tag, { resourcesPath, codeDir: p.codeDir, log, baseUrl });
    fs.writeFileSync(p.activeFile, JSON.stringify({
      build: target.manifest.build, depsFingerprint: target.manifest.depsFingerprint, minShell: target.manifest.minShell,
    }, null, 2));
  } else {
    // The build in use was withdrawn (its release deleted) — back to the installer's code.
    fs.rmSync(p.activeFile, { force: true });
    log(`[code-update] code ${current.build} is no longer published — going back to the installer's code (${base.build})`);
  }

  // Tidy up: keep the build in use now and the one about to be used.
  for (const name of fs.readdirSync(p.codeDir)) {
    if (!/^\d{14}(\.partial)?$/.test(name) || name === current.build || name === wantBuild) continue;
    try { removeBuildDir(path.join(p.codeDir, name)); } catch (_) { /* in use or locked — next time */ }
  }
  return { ready: true, build: wantBuild, rollback: !target };
}

module.exports = { activeCodeRoot, checkForCodeUpdate, semverGte };
