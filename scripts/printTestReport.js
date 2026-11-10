#!/usr/bin/env node
/**
 * scripts/printTestReport.js - one row per template of a print-test run (bulkValidateSmartComm results JSON) as an Excel sheet,
 * so the physical printouts can be compared with what the tool chose in ClaimCenter.
 *   node scripts/printTestReport.js <bulk-results.json> [out.xlsx] [plan.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const [resFile, outArg, planFile] = process.argv.slice(2);
if (!resFile) { console.error('Usage: node scripts/printTestReport.js <bulk-results.json> [out.xlsx] [plan.json]'); process.exit(1); }
const results = JSON.parse(fs.readFileSync(resFile, 'utf8'));
const plan = planFile ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : null;
const yn = (b) => (b === true ? 'Yes' : b === false ? 'No' : '');
const rows = [];
for (const t of results) {
  const sc = (t.scenarios || [])[0];
  if (!sc) { rows.push({ 'Template ID': t.digNumber, 'Template name': t.templateName, 'Result': t.overall, 'Notes': t.reason || '' }); continue; }
  const p = sc.printTest || {};
  const v = sc.variant || {};
  const failed = (sc.validations || []).filter((x) => x.result === 'FAIL').map((x) => x.id).join(', ');
  rows.push({
    'Template ID': t.digNumber, 'Template name': t.templateName, 'Claim number': sc.claimNumber, 'LOB': sc.lob, 'State': sc.state,
    'Primary recipient': p.primaryRecipient || (sc.recipient && sc.recipient.name) || '',
    'Secondary recipient': p.secondaryRecipient || '',
    'Secondary planned': plan && plan.templates[t.digNumber] ? yn(plan.templates[t.digNumber].secondary) : yn(p.secondaryWanted),
    'Delivery channel': p.deliveryChannel || 'Print',
    'Certified mail': yn(p.certifiedMail !== undefined ? p.certifiedMail : v.certifiedMail),
    'Return envelope': yn(p.returnEnvelope !== undefined ? p.returnEnvelope : v.returnEnvelope),
    'Document type': p.documentType || v.documentType || '', 'Document status': p.status || v.status || '', 'Security type': p.securityType || v.securityType || '',
    'Identifier ID': p.identifier || '', 'Document created (local time)': p.createdAt || '',
    'Tool result': sc.status, 'Checks failed': failed, 'Notes': sc.reason ? String(sc.reason).split('\n')[0] : (sc.claimFallbackNote || ''),
    'Printed OK (fill in)': '', 'Print remarks (fill in)': '',
  });
}
const ws = XLSX.utils.json_to_sheet(rows);
ws['!cols'] = Object.keys(rows[0] || {}).map((k) => ({ wch: Math.min(40, Math.max(12, k.length + 2)) }));
const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Print test');
const out = outArg || resFile.replace(/\.json$/i, '') + '-print-test.xlsx';
XLSX.writeFile(wb, out);
console.log(`${rows.length} rows -> ${out}`);
