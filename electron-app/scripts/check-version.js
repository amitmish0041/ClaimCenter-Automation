// Release guard: refuses to publish a version that's already a published GitHub Release. Installed apps only
// update when the version number goes UP — re-publishing the same number replaces the release's files but
// nobody is offered them (2026-10-14: 1.0.10 was republished with new fixes and no installed app updated).
// Reads the public releases API (no token needed); if GitHub can't be reached it warns and lets the release go on.
'use strict';
const https = require('https');
const { version, build } = require('../package.json');
const cfg = require('../electron-builder.config.js');
const pub = [].concat(cfg.publish || (build && build.publish) || [])[0] || {};
const owner = pub.owner || 'amitmish0041';
const repo = pub.repo || 'ClaimCenter-Automation';

https.get({
  host: 'api.github.com',
  path: `/repos/${owner}/${repo}/releases/tags/v${version}`,
  headers: { 'User-Agent': 'claimcenter-runner-release-guard', Accept: 'application/vnd.github+json' },
}, (res) => {
  let body = '';
  res.on('data', (d) => { body += d; });
  res.on('end', () => {
    if (res.statusCode === 404) { console.log(`[check-version] v${version} not released yet — OK to publish.`); return; }
    if (res.statusCode !== 200) { console.warn(`[check-version] couldn't check GitHub (HTTP ${res.statusCode}) — continuing.`); return; }
    const rel = JSON.parse(body);
    if (rel.draft) { console.log(`[check-version] v${version} exists only as a draft — OK to publish.`); return; }
    console.error(`\n[check-version] v${version} is ALREADY published (${rel.published_at}). Installed apps won't see a\n` +
      `re-release of the same number. Bump "version" in electron-app/package.json (e.g. to the next patch) and run again.\n`);
    process.exit(1);
  });
}).on('error', (e) => console.warn(`[check-version] couldn't reach GitHub (${e.message}) — continuing.`));
