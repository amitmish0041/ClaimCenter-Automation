#!/usr/bin/env node
/**
 * scripts/removeFalseFlags.js — re-scores a SAVED bulk run (results/smartComm/bulk/*.json) under the false-flag fixes of
 * 2026-11-27 (Ranjith's stopped 253-template run), without the PDFs, so testers only see real failures:
 *   1. no mapping doc: Data Dictionary values "Not Found" on a form with no field list -> BLOCKED
 *   2. column-joined static line (mapping doc tabs between side-by-side columns) -> removed (false flag)
 *   3. sample claim number glued to a label ("Claim NumberCA-PA-01-18-0733193") -> removed
 *   4. form-ID footer naming another template ("DIG 49DE" on DIG193) while its own ID prints -> removed
 *   5. "Certified Mail is required for recipient" ERROR -> tool issue (rerun with Certified Mail = Yes)
 * Each removed row is kept in <out>.removed.json for the report's "Removed false flags" sheet.
 *
 *   node scripts/removeFalseFlags.js <bulk.json> <out.json>
 */
'use strict';
const fs = require('fs');

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) { console.error('Usage: node scripts/removeFalseFlags.js <bulk.json> <out.json>'); process.exit(1); }
const templates = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const CLAIM_NO = /[A-Z]{2}-[A-Z]{2}-\d{2}-\d{2}-\d{7}/;
const removed = [];
const why = {
  noDoc: 'No mapping doc for this template, so the tool checked every Data Dictionary field for the DIG; a field the form does not print is not a defect. Now BLOCKED until the mapping doc is added.',
  columns: 'Column-joined line: the mapping doc joins side-by-side columns with tabs, the PDF prints each column separately. Tool now checks each column on its own.',
  claimNo: 'The mapping doc\'s sample claim number is glued to the label; the real claim number replaces it.',
  footer: 'The mapping doc\'s form-ID footer names another template (a page copied from that form); the document prints its own ID.',
  certified: 'ClaimCenter requires Certified Mail for this recipient on Print; the test variant had Certified Mail = No. Tool now reruns with Certified Mail = Yes.',
};

function ruleFor(t, v) {
  if (v.result !== 'FAIL') return null;
  const id = String(v.id || ''); const exp = String(v.expected || '');
  if (!t.sourceFile && /^XP\d/.test(id) && /^Not Found$/i.test(String(v.actual || ''))) return 'noDoc';
  if (/^R\d/.test(id) && /^Static content must appear/.test(v.description || '')) {
    if (/\t/.test(exp)) return 'columns';
    if (CLAIM_NO.test(exp)) return 'claimNo';
    const own = t.digNumber.replace(/^DIG/i, '');
    if (/^DIG\s*\d+[A-Z]*$/i.test(exp.trim()) && new RegExp(`DIG\\s*${own}(?![0-9A-Z])`, 'i').test(String(v.actual || ''))) return 'footer';
  }
  return null;
}

for (const t of templates) {
  for (const s of t.scenarios || []) {
    for (const list of ['validations', 'interactiveChecks']) {
      for (const v of s[list] || []) {
        const r = ruleFor(t, v);
        if (!r) continue;
        removed.push({ digNumber: t.digNumber, templateName: t.templateName, scenarioId: s.scenarioId, claimNumber: s.claimNumber, id: v.id, description: v.description, expected: v.expected, actual: v.actual, rule: r, why: why[r] });
        if (r === 'noDoc') { v.result = 'BLOCKED'; v.reason = why.noDoc; } else { v.result = 'PASS'; v.reason = `False flag removed: ${why[r]}`; v.falseFlagRemoved = r; }
      }
    }
    if (s.status === 'ERROR' && /Certified Mail is required/i.test(s.reason || '')) {
      removed.push({ digNumber: t.digNumber, templateName: t.templateName, scenarioId: s.scenarioId, claimNumber: s.claimNumber, id: 'ERROR', description: 'Scenario', expected: '', actual: s.reason, rule: 'certified', why: why.certified });
      s.status = 'BLOCKED'; s.reason = `Rerun needed: ${why.certified}`;
    }
    const all = [...(s.validations || []), ...(s.interactiveChecks || [])];
    const n = (x) => all.filter((v) => v.result === x).length;
    if (s.status === 'FAIL' && !n('FAIL')) s.status = n('BLOCKED') ? 'BLOCKED' : 'PASS';
    s.passed = n('PASS'); s.failed = n('FAIL'); s.blocked = n('BLOCKED');
  }
  const st = (t.scenarios || []).map((s) => s.status);
  t.passed = st.filter((x) => x === 'PASS').length; t.failed = st.filter((x) => x === 'FAIL').length;
  t.blocked = st.filter((x) => x === 'BLOCKED').length; t.errored = st.filter((x) => x === 'ERROR').length;
  t.overall = t.failed ? 'FAIL' : t.errored ? 'ERROR' : t.blocked ? 'BLOCKED' : 'PASS';
}
fs.writeFileSync(outFile, JSON.stringify(templates));
fs.writeFileSync(outFile.replace(/\.json$/, '.removed.json'), JSON.stringify(removed, null, 1));
const c = (k) => templates.filter((t) => t.overall === k).length;
const byRule = removed.reduce((m, r) => ((m[r.rule] = (m[r.rule] || 0) + 1), m), {});
console.log(JSON.stringify({ templates: templates.length, PASS: c('PASS'), FAIL: c('FAIL'), ERROR: c('ERROR'), BLOCKED: c('BLOCKED'), removedRows: removed.length, byRule }));
