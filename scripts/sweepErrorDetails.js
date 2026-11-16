/**
 * scripts/sweepErrorDetails.js
 * Every scenario of a sweep that ended in ERROR (or BLOCKED before any check ran), one row each: template, scenario,
 * claim, error type, ClaimCenter's full message, and the diagnostic screenshot. Later tags replace earlier ones.
 *
 *   node scripts/sweepErrorDetails.js all2-1116,rr1-1116 out.xlsx
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const [tags, out] = process.argv.slice(2);
const dir = path.join(__dirname, '..', 'results', 'smartComm', 'bulk');
const merged = new Map();
for (const tag of tags.split(',')) {
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith(`${tag}-lane`) && /lane\d+\.json$/.test(n)).sort()) {
    for (const t of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) merged.set(t.digNumber, t);
  }
}

// Plain-language type of each error, from ClaimCenter's own message.
const TYPES = [
  [/No suitable Template Edition/i, 'SmartCOMM: no template edition for this date/channel (template set-up)'],
  [/Function 'left'/i, 'SmartCOMM assembly error (Function left - claim data not text)'],
  [/section to region mappings/i, 'SmartCOMM: no section-to-region mapping (template set-up)'],
  [/Resource not found/i, 'SmartCOMM: resource not found (template set-up)'],
  [/Content is not allowed in prolog/i, 'Complete Document failed: Content is not allowed in prolog'],
  [/TEMPLATE_NOT_FOUND/, 'Template not in this ClaimCenter library'],
  [/INTERACTIVE_NEEDS_APPROVAL/, 'Needs document approval'],
  [/Data required to create document not found/i, 'Claim lacks data the template needs'],
  [/No requirements could be derived/i, 'No checkable content in mapping doc'],
  [/Timeout|not found \(tried ids|GENERATE_NO_DOCUMENT/i, 'ClaimCenter/S3 timeout (tool side - rerun)'],
];
const typeOf = (r) => (TYPES.find(([re]) => re.test(r)) || [null, 'Other'])[1];
const clean = (r) => String(r || '').replace(/\u001b\[\d+m/g, '').replace(/Click an error to focus on the associated field, if available\.\s*/g, '').replace(/\s+/g, ' ').trim();

(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Errors (all scenarios)');
  ws.columns = [
    { header: 'Template', key: 'dig', width: 12 }, { header: 'Name', key: 'name', width: 38 },
    { header: 'Template result', key: 'overall', width: 12 }, { header: 'Scenario', key: 'scn', width: 24 },
    { header: 'Claim', key: 'claim', width: 22 }, { header: 'Scenario result', key: 'status', width: 12 },
    { header: 'Error type', key: 'type', width: 44 }, { header: 'Full message from ClaimCenter / tool', key: 'msg', width: 110 },
    { header: 'Screenshot', key: 'shot', width: 60 },
  ];
  let n = 0;
  for (const t of [...merged.values()].sort((a, b) => a.digNumber.localeCompare(b.digNumber, undefined, { numeric: true }))) {
    const scenarios = (t.scenarios || []).length ? t.scenarios : [{ status: t.overall, reason: t.reason }];
    for (const s of scenarios) {
      const checks = (s.validations || []).length;
      if (!(s.status === 'ERROR' || (s.status === 'BLOCKED' && (!checks || /INTERACTIVE_NEEDS_APPROVAL/.test(s.reason || ''))))) continue;
      const msg = clean(s.reason || s.error || t.reason);
      const shot = (msg.match(/(?:diagnostic(?: saved)?:?\s*)([A-Z]:\\[^)]+?\.png)/i) || [])[1] || '';
      ws.addRow({ dig: t.digNumber, name: t.templateName, overall: t.overall, scn: s.scenarioId || '', claim: s.claimNumber || '', status: s.status, type: typeOf(msg), msg, shot });
      n++;
    }
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: 'I1' };
  ws.getColumn('msg').alignment = { wrapText: true, vertical: 'top' };
  const sum = wb.addWorksheet('By error type');
  sum.columns = [{ header: 'Error type', key: 'type', width: 60 }, { header: 'Scenarios', key: 'n', width: 10 }, { header: 'Templates', key: 'tpl', width: 100 }];
  const by = {};
  ws.eachRow((r, i) => { if (i === 1) return; const k = r.getCell('type').value; (by[k] = by[k] || new Set()).add(r.getCell('dig').value); by[k].n = (by[k].n || 0) + 1; });
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1].n - a[1].n)) sum.addRow({ type: k, n: v.n, tpl: [...v].join(', ') });
  sum.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile(out);
  console.log(`${n} scenario rows -> ${out}`);
})();
