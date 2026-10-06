/**
 * scripts/buildSweepExcelReport.js
 * Builds an Excel workbook from an already-completed bulk sweep's raw JSON
 * (results/smartComm/bulk/sweep-2.json) — no live run, just reformats what
 * that run already produced into a shareable .xlsx with one row per
 * template, one row per content-requirement failure, and one row per
 * field-editability failure.
 *
 * Usage: node scripts/buildSweepExcelReport.js [sweepJsonPath] [outXlsxPath]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const sweepPath = process.argv[2] || 'results/smartComm/bulk/sweep-2.json';
const outPath = process.argv[3] || 'results/smartComm/bulk/sweep-report.xlsx';

const results = JSON.parse(fs.readFileSync(sweepPath, 'utf8'));

// ── Sheet 1: Summary ────────────────────────────────────────────────────
const totals = results.reduce((acc, t) => {
  acc.scenarios += t.scenarioCount || 0;
  acc.passed += t.passed || 0; acc.failed += t.failed || 0; acc.blocked += t.blocked || 0; acc.errored += t.errored || 0;
  return acc;
}, { scenarios: 0, passed: 0, failed: 0, blocked: 0, errored: 0 });

let cPass = 0, cFail = 0, cBlocked = 0, cSkipped = 0, iPass = 0, iFail = 0;
for (const t of results) {
  for (const s of t.scenarios || []) {
    cPass += s.passed || 0; cFail += s.failed || 0; cBlocked += s.blocked || 0; cSkipped += s.skipped || 0;
    for (const c of s.interactiveChecks || []) { if (c.result === 'PASS') iPass++; else if (c.result === 'FAIL') iFail++; }
  }
}

const summaryRows = [
  ['SmartCOMM Bulk Validation — Summary'],
  [],
  ['Templates swept', results.length],
  ['Template overall: PASS', totals.passed],
  ['Template overall: FAIL', totals.failed],
  ['Template overall: BLOCKED', totals.blocked],
  ['Template overall: ERROR', totals.errored],
  [],
  ['Requirement checks: PASS', cPass],
  ['Requirement checks: FAIL', cFail],
  ['Requirement checks: BLOCKED', cBlocked],
  ['Requirement checks: SKIPPED', cSkipped],
  [],
  ['Interactive field checks: PASS', iPass],
  ['Interactive field checks: FAIL', iFail],
  [],
  ['Common findings (see Findings tab for full detail)'],
  ['1. "Download Payload" unavailable in Test — blocks From Name/Phone/Title/Email checks', '~50 templates'],
  ['2. "RE:"/"Policy No."/"cc:" header labels not found', '12 templates'],
  ['3. Complete Document reverts whole submission on one unedited field', '6 templates (ERROR)'],
  ['4. "Claim No." label punctuation drift (reference doc vs. live template)', '4 templates'],
  ['5. Stale letterhead address in reference docs', '3 templates'],
  ['6. Template not found by name search (possible naming drift)', 'DIG187, DIG143'],
];

// ── Sheet 2: Findings (expected vs actual detail for the recurring ones) ──
const findingsRows = [['Finding', 'DIG', 'Template', 'Requirement ID', 'Expected', 'Actual']];
function addFindingRows(label, matcher) {
  for (const t of results) {
    for (const s of t.scenarios || []) {
      for (const v of s.validations || []) {
        if (v.result === 'FAIL' && matcher(v)) {
          findingsRows.push([label, t.digNumber, t.templateName, v.id || '', v.expected || '', v.actual || '']);
        }
      }
    }
  }
}
addFindingRows('RE:/Policy No./cc: not found', (v) => /^(RE:|Policy No|cc:)/i.test(v.expected || '') && v.actual === 'Not Found');
addFindingRows('Claim No. punctuation drift', (v) => /claim no/i.test(v.expected || '') && v.actual !== 'Not Found' && v.expected !== v.actual);
addFindingRows('Stale letterhead address', (v) => /1195 River Road|www\.donegalgroup\.com/i.test(v.expected || ''));

// ── Sheet 3: Per-template summary ──────────────────────────────────────
const perTemplateRows = [['DIG', 'Template Name', 'Overall', 'Reason (if BLOCKED/ERROR)', 'Content Pass', 'Content Fail', 'Content Blocked', 'Content Skipped', 'Field Pass', 'Field Fail', 'Field Total', 'Top Content Issue']];
for (const t of results) {
  const s = (t.scenarios || [])[0] || {};
  const ic = s.interactiveChecks || [];
  const iP = ic.filter((c) => c.result === 'PASS').length;
  const iF = ic.filter((c) => c.result === 'FAIL').length;
  const firstFail = (s.validations || []).find((v) => v.result === 'FAIL');
  perTemplateRows.push([
    t.digNumber, t.templateName, t.overall, t.reason || s.reason || '',
    s.passed || 0, s.failed || 0, s.blocked || 0, s.skipped || 0,
    iP, iF, ic.length,
    firstFail ? firstFail.description : '',
  ]);
}

// ── Sheet 4: All content requirement failures (every template) ────────
const allFailRows = [['DIG', 'Template Name', 'Req ID', 'Description', 'Expected', 'Actual', 'Reason']];
for (const t of results) {
  for (const s of t.scenarios || []) {
    for (const v of s.validations || []) {
      if (v.result === 'FAIL') {
        allFailRows.push([t.digNumber, t.templateName, v.id || '', v.description || '', v.expected || '', v.actual || '', v.reason || '']);
      }
    }
  }
}

// ── Sheet 5: All field-editability failures (every template) ──────────
// "Preceding text" is the on-page text immediately before the field (e.g. "Date of Loss:") — only present
// for runs made after the 2026-09-30 label-quality fix; older sweep JSON files won't have it captured.
const allFieldFailRows = [['DIG', 'Template Name', 'Field ID', 'Field Label', 'Preceding Text (context)', 'Should Be Editable', 'Edit Took Effect', 'Reason']];
for (const t of results) {
  for (const s of t.scenarios || []) {
    for (const c of s.interactiveChecks || []) {
      if (c.result === 'FAIL') {
        allFieldFailRows.push([
          t.digNumber, t.templateName, c.id || '', c.label || '', c.labelContext || '',
          c.expectedEditable === true ? 'Yes' : c.expectedEditable === false ? 'No' : '',
          c.observedChanged === true ? 'Yes' : c.observedChanged === false ? 'No' : '',
          c.reason || '',
        ]);
      }
    }
  }
}

// ── Build workbook ───────────────────────────────────────────────────
const wb = XLSX.utils.book_new();
const addSheet = (rows, name, colWidths) => {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  if (colWidths) ws['!cols'] = colWidths.map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, name);
};

addSheet(summaryRows, 'Summary', [70, 16]);
addSheet(findingsRows, 'Findings', [32, 10, 32, 12, 45, 45]);
addSheet(perTemplateRows, 'Per-Template', [10, 32, 10, 50, 11, 11, 13, 12, 10, 10, 10, 38]);
addSheet(allFailRows, 'All Content Failures', [10, 32, 8, 34, 45, 45, 45]);
addSheet(allFieldFailRows, 'All Field Failures', [10, 32, 8, 30, 30, 12, 12, 55]);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
XLSX.writeFile(wb, outPath);
console.log(`Wrote ${outPath}`);
console.log(`Sheets: Summary, Findings (${findingsRows.length - 1} rows), Per-Template (${perTemplateRows.length - 1} rows), All Content Failures (${allFailRows.length - 1} rows), All Field Failures (${allFieldFailRows.length - 1} rows)`);
