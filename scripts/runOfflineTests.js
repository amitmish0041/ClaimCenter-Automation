/**
 * scripts/runOfflineTests.js
 * Runs every offline check in tests/offline/*.offline.js with Node's built-in test runner — no browser, SmartCOMM,
 * S3 or catalog needed, so it takes seconds. Run it before every push of a SmartCOMM validation change:
 *
 *   npm run test:offline
 *
 * The files are named *.offline.js (not *.test.js / *.spec.js) so Playwright's projects never pick them up.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'tests', 'offline');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.offline.js')).sort().map((f) => path.join(dir, f));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, SMARTCOMM_SAVE_REGRESSION_CASE: '' } });
process.exit(result.status === null ? 1 : result.status);
