// Release guard + automatic version: installed apps only update when the version number goes UP, so a release
// must never reuse a published number (2026-10-14: 1.0.10 was republished with new fixes and no installed app
// updated). If package.json's version is already a published GitHub Release, this bumps the patch number to the
// next unpublished one and writes it to package.json before the build reads it (per user direction: "always use
// next version"). Commit the bumped package.json afterwards so the repo matches what was released.
// Reads the public releases API (no token needed); if GitHub can't be reached it warns and keeps the version.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const cfg = require('../electron-builder.config.js');

const PKG = path.join(__dirname, '..', 'package.json');
const pub = [].concat(cfg.publish || [])[0] || {};
const owner = pub.owner || 'amitmish0041';
const repo = pub.repo || 'ClaimCenter-Automation';

// 'published' | 'draft' | 'free' | 'unknown'
function status(version) {
  return new Promise((resolve) => {
    https.get({
      host: 'api.github.com',
      path: `/repos/${owner}/${repo}/releases/tags/v${version}`,
      headers: { 'User-Agent': 'claimcenter-runner-release-guard', Accept: 'application/vnd.github+json' },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve('free');
        if (res.statusCode !== 200) return resolve('unknown');
        try { resolve(JSON.parse(body).draft ? 'draft' : 'published'); } catch (_) { resolve('unknown'); }
      });
    }).on('error', () => resolve('unknown'));
  });
}

const nextPatch = (v) => { const [a, b, c] = v.split('.').map(Number); return `${a}.${b}.${c + 1}`; };

(async () => {
  const text = fs.readFileSync(PKG, 'utf8');
  const original = JSON.parse(text).version;
  let version = original;
  for (let i = 0; i < 50; i++) {
    const s = await status(version);
    if (s === 'unknown') { console.warn(`[check-version] couldn't check GitHub — releasing as v${version}.`); break; }
    if (s !== 'published') break;
    version = nextPatch(version);
  }
  if (version !== original) {
    fs.writeFileSync(PKG, text.replace(`"version": "${original}"`, `"version": "${version}"`));
    console.log(`[check-version] v${original} is already published — using the next version, v${version} (package.json updated; commit it after the release).`);
  } else {
    console.log(`[check-version] releasing v${version}.`);
  }
})();
