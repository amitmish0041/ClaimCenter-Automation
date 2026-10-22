#!/usr/bin/env node
/**
 * scripts/oneIncQaReview.js
 * QA review of everything the OneInc suite has executed (user direction 2026-10-21: "QA everything tested so far and
 * see if anything needs revalidation"). Offline — reads every OneInc_*_test.json report, takes each case's LATEST
 * executed result and flags the ones whose evidence can't be trusted as-is:
 *
 *   RERUN  - automation exception; "no $x check listed" (pre-fix Checks reader); aggregate-limit warning taken as a
 *            refusal (pre-fix); the recipe's steps changed since that run; ran on a claim whose data was later found
 *            wrong (KNOWN_BAD below); BLOCKED for data the provisioner can now build.
 *   REVIEW - PASS proven only by an ABSENCE (a message / field / button not shown) — true PASS only if the claim really
 *            met the precondition, which earlier runs did not verify; PASS with no checks.
 *   OK     - everything else (incl. product FAILs).
 *
 *   node scripts/oneIncQaReview.js   → <ONEINC_RESULTS_DIR>\Reports\QA_REVIEW.html + .csv, and RERUN ids in
 *                                      QA_RERUN_IDS.txt (feed to: node scripts/runOneInc.js --ids-file <that file>)
 */
'use strict';
process.env.CC_ENV = process.env.CC_ENV || 'cloud';
const fs = require('fs');
const path = require('path');
const { RESULTS_DIR } = require('../helpers/oneInc/reportService');
const { RECIPES } = require('../helpers/oneInc/scenarioRecipes');
const { _test: { describeItem } } = require('../helpers/oneInc/scenarioRunner');
const TD = require('../helpers/oneInc/testData');

// Cases whose last result ran on data later found wrong (2026-10-21 worker reports).
const KNOWN_BAD = {
  'GCCM-763/VBR/TC-013': 'ran on the Bodily Injury line, not the PIP line (MD recipes fixed by worker H)',
  'GCCM-1003/VBR/TC-095': 'ran on the Bodily Injury line, not the PIP line (MD recipes fixed by worker H)',
};
const BAD_PROFILE = {
  C_SURC_MI: 'C_SURC_MI claim PA-PA/MI 0748490 had NO LC50 exposure — the MI LC50 surcharge rule was never exercised',
};

const dir = path.join(RESULTS_DIR, 'Reports');
const files = fs.readdirSync(dir).filter((f) => /^OneInc_\d{8}_\d{6}_test\.json$/.test(f)).sort();
const last = {};
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
  for (const r of j.results || []) if (['PASS', 'FAIL', 'BLOCKED'].includes(r.status)) last[r.scenarioId] = { ...r, runFile: f };
}

const NEG = (c) => /present"?:\s*false|not shown|absent|is hidden|\(\?!|no error/i.test(JSON.stringify([c.description, c.expected])) ;
const rows = [];
for (const r of Object.values(last)) {
  const rec = RECIPES[r.scenarioId];
  const why = { RERUN: [], REVIEW: [] };
  const text = `${r.reason || ''} ${r.actual || ''}`;
  if (r.automationError) why.RERUN.push(`automation error: ${(r.error || '').slice(0, 120)}`);
  if (/no \$[\d.,]+ check (is )?listed|wizard closed but no/i.test(text)) why.RERUN.push('outcome read by the old Checks reader (page 1 only / held payments dropped)');
  if (r.status !== 'PASS' && /aggregate limit/i.test(text)) why.RERUN.push('aggregate-limit warning treated as a refused Finish (fixed)');
  if (KNOWN_BAD[r.scenarioId]) why.RERUN.push(KNOWN_BAD[r.scenarioId]);
  if (rec && BAD_PROFILE[rec.profile]) why.RERUN.push(BAD_PROFILE[rec.profile]);
  if (!rec) why.STALE = 'no longer automated (now MANUAL / needs data / dev pending) — old result, not counted';
  else if ((r.stepsExecuted || []).length) {
    const now = [...(rec.steps || []), ...(rec.checks || [])].filter((i) => !('field' in i) && !('text' in i) && !('button' in i) && !('menu' in i && typeof i.menu === 'object')).map(describeItem);
    const ran = r.stepsExecuted;
    const differs = ran.some((s, k) => now[k] !== undefined && now[k] !== s);
    if (differs) why.RERUN.push('recipe steps changed since this run');
  }
  if (r.status === 'BLOCKED' && /missing test data|reserve line|no .* claim available|open reserve|Available Reserves/i.test(text)) why.RERUN.push('BLOCKED on data the provisioner now builds/verifies');
  if (r.status === 'PASS') {
    const chk = r.checks || [];
    if (!chk.length) why.REVIEW.push('PASS with no recorded checks');
    else if (chk.every(NEG)) why.REVIEW.push(chk.some((c) => /validation error|no error/i.test(c.description + c.expected))
      ? 'negative rule: PASS = no error shown — valid only if the claim met the case precondition (not verified on that run)'
      : 'hidden field/message: PASS = not shown — valid only if the claim met the case precondition (not verified on that run)');
  }
  const verdict = why.STALE ? 'STALE' : why.RERUN.length ? 'RERUN' : why.REVIEW.length ? 'REVIEW' : 'OK';
  rows.push({ id: r.scenarioId, story: r.story, status: r.status, verdict, reasons: why.STALE ? [why.STALE] : [...why.RERUN, ...why.REVIEW], claim: r.claim || '', run: r.runFile.slice(7, 22),
    profile: rec ? rec.profile : '', needs: rec ? TD.deriveNeeds(rec).map((d) => d.label).join('; ') : '' });
}
rows.sort((a, b) => ({ RERUN: 0, REVIEW: 1, OK: 2, STALE: 3 }[a.verdict] - { RERUN: 0, REVIEW: 1, OK: 2, STALE: 3 }[b.verdict]) || a.id.localeCompare(b.id));

const count = (v, s) => rows.filter((r) => r.verdict === v && (!s || r.status === s)).length;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const csvCell = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
const csv = [['Case', 'Story', 'Last status', 'QA verdict', 'Why', 'Profile', 'Claim', 'Run', 'Case preconditions'].map(csvCell).join(','),
  ...rows.map((r) => [r.id, r.story, r.status, r.verdict, r.reasons.join(' | '), r.profile, r.claim, r.run, r.needs].map(csvCell).join(','))];
const html = `<!doctype html><html><head><meta charset="utf-8"><title>OneInc QA Review</title><style>body{font:14px Segoe UI,Arial;margin:24px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}th{background:#f4f6f8}
.RERUN{background:#fde8e8}.REVIEW{background:#fff6dd}</style></head><body><h1>OneInc — QA review of executed cases</h1>
<p>Generated ${new Date().toISOString()} from ${files.length} run reports. ${rows.length} cases with an executed result:
<b>${count('RERUN')}</b> RERUN, <b>${count('REVIEW')}</b> REVIEW, ${count('OK')} OK, ${count('STALE')} STALE (no longer automated).</p>
<table><tr><th>Case</th><th>Last status</th><th>QA verdict</th><th>Why</th><th>Profile / claim</th><th>Run</th></tr>
${rows.map((r) => `<tr class="${r.verdict}"><td><code>${esc(r.id)}</code></td><td>${r.status}</td><td><b>${r.verdict}</b></td><td>${r.reasons.map(esc).join('<br>')}</td><td>${esc(r.profile)}<br><code>${esc(r.claim)}</code></td><td>${esc(r.run)}</td></tr>`).join('')}
</table></body></html>`;
fs.writeFileSync(path.join(dir, 'QA_REVIEW.html'), html);
fs.writeFileSync(path.join(dir, 'QA_REVIEW.csv'), csv.join('\r\n'));
fs.writeFileSync(path.join(dir, 'QA_RERUN_IDS.txt'), rows.filter((r) => r.verdict === 'RERUN').map((r) => r.id).join('\n'));
fs.writeFileSync(path.join(dir, 'QA_REVIEW_IDS.txt'), rows.filter((r) => r.verdict === 'REVIEW').map((r) => r.id).join('\n'));
console.log(`[QA] ${rows.length} executed cases: RERUN ${count('RERUN')} (PASS ${count('RERUN', 'PASS')}, FAIL ${count('RERUN', 'FAIL')}, BLOCKED ${count('RERUN', 'BLOCKED')}), REVIEW ${count('REVIEW')}, OK ${count('OK')}, STALE ${count('STALE')}`);
const why = {};
for (const r of rows) for (const w of r.reasons) { const k = w.replace(/:.*$/, '').slice(0, 90); why[k] = (why[k] || 0) + 1; }
for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`[QA]   ${n} × ${k}`);
console.log(`[QA] ${path.join(dir, 'QA_REVIEW.html')}`);
