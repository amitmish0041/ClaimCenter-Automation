// electron-app/scripts/upload-shell-info.js
//
// Runs at the end of `npm run release`: attaches code-base.json (the code build + package fingerprint this
// installer carries, written by stage-resources.js) to the new GitHub release, so `npm run release:code` can
// later check that a code-only release fits the app version people actually have installed.
'use strict';

const fs = require('fs');
const path = require('path');
const gh = require('./github-release.js');
const STAGING = require('./staging-path.js');
const { version } = require('../package.json');

(async () => {
  const file = path.join(STAGING, 'code-base.json');
  if (!fs.existsSync(file)) throw new Error(`${file} not found — run the full release (it stages first)`);
  const rel = await gh.releaseByTag(`v${version}`, { auth: true });
  if (!rel) throw new Error(`release v${version} not found on GitHub`);
  await gh.uploadAsset(rel, 'code-base.json', fs.readFileSync(file), 'application/json');
  console.log(`[shell-info] attached code-base.json to v${version}`);
})().catch((e) => { console.error(`[shell-info] ${e.message}`); process.exit(1); });
