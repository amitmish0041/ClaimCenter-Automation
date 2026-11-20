/**
 * scripts/refreshBcDocsAndPayloads.js
 * One refresh for the Runner's "BillingCenter documents" view: sorted PDFs (sortBcSmartCommPdfs.js) and then the
 * request payloads (sortBcPayloadsByEvent.js), so both folders on V: are always from the same pull.
 * A payload failure is reported but does not undo the PDF refresh; the exit code is non-zero if either failed.
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

let failed = 0;
for (const [label, script] of [['documents', 'sortBcSmartCommPdfs.js'], ['payloads', 'sortBcPayloadsByEvent.js']]) {
  console.log(`\n=== BillingCenter ${label} ===`);
  const r = spawnSync(process.execPath, [...process.execArgv, path.join(__dirname, script)], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) { failed++; console.log(`[${label}] failed (exit ${r.status})`); }
}
process.exit(failed ? 1 : 0);
