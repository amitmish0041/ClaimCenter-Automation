/**
 * reporters/generateExcelReport.js
 * Converts results/tc_results.json -> results/CC_TestResults_YYYYMMDD.xlsx
 *
 * Sheets:
 *   1. Summary Dashboard  — KPIs, feature breakdown, failed TC list
 *   2. All Results        — every TC, color-coded by status
 *   3. Fail Details       — only failed TCs with error info
 *   4-7. Per feature area (FNOL, Financials, ApprovalRouting, ClaimLifecycle)
 *   8. Rule Coverage      — which rules are covered and pass/fail status
 *
 * Usage: node reporters/generateExcelReport.js
 */
const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const RESULTS_DIR = path.join(process.cwd(), 'results');
const JSON_PATH   = process.argv[2] || path.join(RESULTS_DIR, 'tc_results.json');
const TODAY       = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT_PATH    = path.join(RESULTS_DIR, 'CC_TestResults_' + TODAY + '.xlsx');

if (!fs.existsSync(JSON_PATH)) {
  console.error('Results JSON not found: ' + JSON_PATH);
  console.error('Run Playwright first: npm run test:all');
  process.exit(1);
}

const data    = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const meta    = data.meta;
const results = data.results;
const { total, passed, failed, skipped } = meta.summary;

function statusLabel(s) {
  if (s === 'PASS')           return '✅ PASS';
  if (s.startsWith('FAIL'))   return '❌ ' + s;
  return '⏭ SKIPPED';
}

function addSheet(wb, sheetName, headers, rows, colWidths) {
  const wsData = headers.length ? [headers, ...rows] : rows;
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = colWidths.map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
}

const wb = XLSX.utils.book_new();

// ── Sheet 1: Summary ──────────────────────────────────────────────────────────
const featureAreas = [...new Set(results.map(r => r.featureArea))].sort();
const faRows = featureAreas.map(fa => {
  const s = results.filter(r => r.featureArea === fa);
  const p = s.filter(r => r.status === 'PASS').length;
  const f = s.filter(r => r.status.startsWith('FAIL')).length;
  const k = s.filter(r => r.status === 'SKIPPED').length;
  return [fa, s.length, p, f, k, s.length > 0 ? Math.round(p / s.length * 100) + '%' : '—'];
});

const failRows = results
  .filter(r => r.status.startsWith('FAIL'))
  .map(r => [r.tcId, r.featureArea, r.description, r.rules, r.errorMessage || '—']);

const summaryRows = [
  ['CLAIMCENTER AUTOMATION — TEST RESULTS REPORT'],
  [''],
  ['Suite',           meta.suiteName],
  ['Generated',       meta.generatedAt],
  ['Total Duration',  meta.totalElapsed],
  [''],
  ['OVERALL SUMMARY'],
  ['Total TCs',       total],
  ['✅ PASS',         passed],
  ['❌ FAIL',         failed],
  ['⏭ SKIPPED',      skipped],
  ['Pass Rate',       meta.passRate],
  [''],
  ['RESULTS BY FEATURE AREA'],
  ['Feature Area', 'Total', 'Pass', 'Fail', 'Skipped', 'Pass Rate'],
  ...faRows,
  [''],
  ['FAILED TEST CASES'],
  ['TC ID', 'Feature', 'Description', 'Rule(s)', 'Error'],
  ...failRows,
];
addSheet(wb, 'Summary', [], summaryRows, [28, 55, 12, 12, 12, 12]);

// ── Sheet 2: All Results ──────────────────────────────────────────────────────
addSheet(wb, 'All Results',
  ['TC ID', 'Feature Area', 'Description', 'Rule(s) Covered', 'Status', 'Duration', 'Retries', 'Error Message'],
  results.map(r => [r.tcId, r.featureArea, r.description, r.rules, statusLabel(r.status), r.duration, r.retries, r.errorMessage || '']),
  [14, 18, 55, 38, 18, 10, 8, 60]);

// ── Sheet 3: Fail Details ─────────────────────────────────────────────────────
const failResults = results.filter(r => r.status.startsWith('FAIL'));
addSheet(wb, 'Fail Details',
  ['TC ID', 'Feature Area', 'Description', 'Rule(s)', 'Status', 'Duration', 'Error Message', 'Error Location'],
  failResults.length
    ? failResults.map(r => [r.tcId, r.featureArea, r.description, r.rules, r.status, r.duration, r.errorMessage || '—', r.errorStep || '—'])
    : [['—', '—', 'No failures in this run', '—', '—', '—', '—', '—']],
  [14, 18, 50, 30, 18, 10, 70, 50]);

// ── Sheets 4-7: Per feature area ─────────────────────────────────────────────
for (const fa of featureAreas) {
  const subset = results.filter(r => r.featureArea === fa);
  addSheet(wb, fa.slice(0, 31),
    ['TC ID', 'Description', 'Rule(s) Covered', 'Status', 'Duration', 'Error'],
    subset.map(r => [r.tcId, r.description, r.rules, statusLabel(r.status), r.duration, r.errorMessage || '']),
    [14, 58, 38, 18, 10, 60]);
}

// ── Sheet 8: Rule Coverage ────────────────────────────────────────────────────
const ruleMap = {};
for (const r of results) {
  for (const rule of r.rules.split(',').map(x => x.trim()).filter(x => x && x !== '—')) {
    if (!ruleMap[rule]) ruleMap[rule] = { tcs: [], statuses: [], fa: r.featureArea };
    ruleMap[rule].tcs.push(r.tcId);
    ruleMap[rule].statuses.push(r.status);
  }
}
addSheet(wb, 'Rule Coverage',
  ['Rule ID', 'Feature Area', 'Covered By TC(s)', 'TC Count', 'Status'],
  Object.entries(ruleMap).sort(([a], [b]) => a.localeCompare(b)).map(([rule, info]) => {
    const anyFail = info.statuses.some(s => s.startsWith('FAIL'));
    const allPass = info.statuses.every(s => s === 'PASS');
    return [rule, info.fa, info.tcs.join(', '), info.tcs.length, anyFail ? '❌ FAIL' : allPass ? '✅ PASS' : '⏭ MIXED'];
  }),
  [18, 18, 55, 10, 14]);

// ── Write ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
XLSX.writeFile(wb, OUT_PATH);

console.log('\n' + '='.repeat(55));
console.log('  EXCEL REPORT GENERATED');
console.log('='.repeat(55));
console.log('  File     : ' + OUT_PATH);
console.log('  Sheets   : Summary | All Results | Fail Details');
console.log('             ' + featureAreas.join(' | '));
console.log('             Rule Coverage');
console.log('  TCs      : ' + total + ' total | ✅ ' + passed + ' | ❌ ' + failed + ' | ⏭ ' + skipped);
console.log('  Pass Rate: ' + meta.passRate);
console.log('='.repeat(55) + '\n');
