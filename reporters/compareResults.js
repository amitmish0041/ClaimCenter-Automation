/**
 * reporters/compareResults.js
 * Compares on-prem vs cloud test results side by side.
 * Run after both environments have been tested:
 *   npm run run:onprem   (saves results/tc_results_onprem.json)
 *   npm run run:cloud    (saves results/tc_results_cloud.json)
 *   node reporters/compareResults.js
 */
const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const RESULTS_DIR   = path.join(process.cwd(), 'results');
const ONPREM_JSON   = path.join(RESULTS_DIR, 'tc_results_onprem.json');
const CLOUD_JSON    = path.join(RESULTS_DIR, 'tc_results_cloud.json');
const TODAY         = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT_PATH      = path.join(RESULTS_DIR, 'CC_Comparison_' + TODAY + '.xlsx');

// Load both result files
function loadResults(filePath, envName) {
  if (!fs.existsSync(filePath)) {
    console.warn('WARNING: ' + filePath + ' not found - run ' + envName + ' tests first');
    return { meta: { summary: { total:0, passed:0, failed:0, skipped:0 }, passRate:'N/A' }, results: [] };
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const onPrem = loadResults(ONPREM_JSON, 'on-prem');
const cloud  = loadResults(CLOUD_JSON,  'cloud');

// Build TC map for comparison
const tcMap = {};
for (const r of onPrem.results) {
  if (!tcMap[r.tcId]) tcMap[r.tcId] = { tcId: r.tcId, featureArea: r.featureArea, description: r.description, rules: r.rules };
  tcMap[r.tcId].onPrem = r.status;
  tcMap[r.tcId].onPremDur = r.duration;
  tcMap[r.tcId].onPremErr = r.errorMessage || '';
}
for (const r of cloud.results) {
  if (!tcMap[r.tcId]) tcMap[r.tcId] = { tcId: r.tcId, featureArea: r.featureArea, description: r.description, rules: r.rules };
  tcMap[r.tcId].cloud = r.status;
  tcMap[r.tcId].cloudDur = r.duration;
  tcMap[r.tcId].cloudErr = r.errorMessage || '';
}

const rows = Object.values(tcMap).sort((a, b) => a.tcId.localeCompare(b.tcId));

// Determine divergence
function divergenceLabel(onPrem, cloud) {
  if (!onPrem || !cloud) return 'ONE ENV ONLY';
  if (onPrem === cloud)  return 'MATCH';
  if (onPrem === 'PASS' && cloud !== 'PASS') return 'CLOUD FAIL';
  if (onPrem !== 'PASS' && cloud === 'PASS') return 'ONPREM FAIL';
  return 'BOTH FAIL';
}

// Build workbook
const wb = XLSX.utils.book_new();

// Summary sheet
const onPremS = onPrem.meta.summary;
const cloudS  = cloud.meta.summary;
const summaryRows = [
  ['CLAIMCENTER ON-PREM vs CLOUD COMPARISON'],
  [''],
  ['',                'ON-PREM',           'CLOUD'],
  ['Total TCs',       onPremS.total,       cloudS.total],
  ['PASS',            onPremS.passed,      cloudS.passed],
  ['FAIL',            onPremS.failed,      cloudS.failed],
  ['SKIPPED',         onPremS.skipped,     cloudS.skipped],
  ['Pass Rate',       onPrem.meta.passRate, cloud.meta.passRate],
  ['Run At',          onPrem.meta.generatedAt || 'N/A', cloud.meta.generatedAt || 'N/A'],
  [''],
  ['DIVERGENCES (tests with different results between environments)'],
  ['TC ID', 'Feature', 'On-Prem', 'Cloud', 'Divergence'],
  ...rows
    .filter(r => divergenceLabel(r.onPrem, r.cloud) !== 'MATCH')
    .map(r => [r.tcId, r.featureArea, r.onPrem || 'NOT RUN', r.cloud || 'NOT RUN', divergenceLabel(r.onPrem, r.cloud)]),
];

const ws1 = XLSX.utils.aoa_to_sheet(summaryRows);
ws1['!cols'] = [{ wch: 28 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 16 }];
XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

// Side-by-side comparison sheet
const compHeaders = ['TC ID', 'Feature', 'Description', 'Rule(s)', 'On-Prem Status', 'On-Prem Duration', 'Cloud Status', 'Cloud Duration', 'Divergence', 'On-Prem Error', 'Cloud Error'];
const compRows = rows.map(r => [
  r.tcId, r.featureArea, r.description, r.rules,
  r.onPrem  || 'NOT RUN', r.onPremDur || '—',
  r.cloud   || 'NOT RUN', r.cloudDur  || '—',
  divergenceLabel(r.onPrem, r.cloud),
  r.onPremErr || '', r.cloudErr || '',
]);

const ws2 = XLSX.utils.aoa_to_sheet([compHeaders, ...compRows]);
ws2['!cols'] = [{ wch:14 },{ wch:18 },{ wch:50 },{ wch:35 },{ wch:16 },{ wch:10 },{ wch:16 },{ wch:10 },{ wch:14 },{ wch:50 },{ wch:50 }];
XLSX.utils.book_append_sheet(wb, ws2, 'Side-by-Side');

// Divergences only
const divRows = rows.filter(r => divergenceLabel(r.onPrem, r.cloud) !== 'MATCH');
const ws3 = XLSX.utils.aoa_to_sheet([
  ['TC ID', 'Feature', 'Description', 'On-Prem', 'Cloud', 'Type', 'On-Prem Error', 'Cloud Error'],
  ...divRows.map(r => [r.tcId, r.featureArea, r.description, r.onPrem||'NOT RUN', r.cloud||'NOT RUN', divergenceLabel(r.onPrem, r.cloud), r.onPremErr||'', r.cloudErr||''])
]);
ws3['!cols'] = [{ wch:14 },{ wch:18 },{ wch:50 },{ wch:16 },{ wch:16 },{ wch:14 },{ wch:50 },{ wch:50 }];
XLSX.utils.book_append_sheet(wb, ws3, 'Divergences');

XLSX.writeFile(wb, OUT_PATH);

// Console summary
const matchCount = rows.filter(r => divergenceLabel(r.onPrem, r.cloud) === 'MATCH').length;
const divCount   = rows.filter(r => divergenceLabel(r.onPrem, r.cloud) !== 'MATCH').length;

console.log('\n' + '='.repeat(60));
console.log('  COMPARISON REPORT GENERATED');
console.log('='.repeat(60));
console.log('  File          : ' + OUT_PATH);
console.log('  On-Prem Rate  : ' + onPrem.meta.passRate);
console.log('  Cloud Rate    : ' + cloud.meta.passRate);
console.log('  Matching TCs  : ' + matchCount);
console.log('  Divergences   : ' + divCount);
console.log('='.repeat(60) + '\n');
