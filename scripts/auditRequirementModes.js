/**
 * scripts/auditRequirementModes.js
 *
 * Lists, for every template in the catalog, how its checks were read from its mapping doc — no browser, no
 * ClaimCenter, nothing generated:
 *   comments       the BA's Word comments mark the dynamic values (the normal case)
 *   comments (.doc) the same, read from a legacy .doc through a converted .docx copy
 *   heuristic      a .docx with no usable comments — every line not recognised as a label/date/amount/etc.
 *                  becomes "Static content must appear", so sample names and claim numbers are checked verbatim
 *   heuristic-doc  the same, for a legacy .doc with no comments (or when it couldn't be converted)
 *   none           no readable mapping doc found
 * and flags each "Static content must appear" check whose expected text looks like sample data (a claim/policy
 * number, date, amount, email, phone, or an "I, First Last," sworn-statement name) — those fail on every real claim.
 *
 *   node scripts/auditRequirementModes.js              (whole catalog)
 *   node scripts/auditRequirementModes.js DIG39 DIG52  (just these)
 *   node scripts/auditRequirementModes.js --compare-doc [DIG…]
 *        only the templates whose mapping doc is a legacy .doc: each one's checks read the old way (text only) next
 *        to the new way (its Word comments, through a converted .docx copy), and exactly which checks change
 *   node scripts/auditRequirementModes.js --fields DIG168 [DIG…]
 *        each "text-shaped value" check (a BA field with no built-in mapping) and the Data Dictionary row + Xpath it
 *        is compared through at run time — or why it can't be (no row, or a row without an Xpath)
 *
 * Writes: results/smartComm/requirement-audit-<timestamp>.csv
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const catalogService = require('../helpers/smartComm/catalogService');
const templateRequirementService = require('../helpers/smartComm/templateRequirementService');
const { UNANCHORED_PATTERNS } = require('../helpers/smartComm/fieldLabelSynonyms');

const SAMPLE_DATA = [
  ['claim/policy number', /\b[A-Z]{2}-[A-Z]{2,3}-\d{2}-\d{2}-\d{5,}\b/],
  ['date', UNANCHORED_PATTERNS.date],
  ['amount', UNANCHORED_PATTERNS.currency],
  ['email', UNANCHORED_PATTERNS.email],
  ['phone', UNANCHORED_PATTERNS.phone],
  ['person name', /\bI,\s+[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z'-]+\s*,/],
];
const looksLikeSample = (text) => SAMPLE_DATA.filter(([, re]) => re.test(String(text || ''))).map(([name]) => name);
const csvCell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

async function requirementsOf(t, { convert = true } = {}) {
  const prev = process.env.SMARTCOMM_DOC_CONVERT;
  if (!convert) process.env.SMARTCOMM_DOC_CONVERT = '0';
  const log = console.log;
  console.log = () => {}; // getRequirements logs a line per template — keep the report readable
  try { return await templateRequirementService.getRequirements(t, catalogService.DATA_DIR); }
  catch (e) { return { requirements: [], mode: `error: ${e.message}` }; }
  finally {
    console.log = log;
    if (prev === undefined) delete process.env.SMARTCOMM_DOC_CONVERT; else process.env.SMARTCOMM_DOC_CONVERT = prev;
  }
}

// --compare-doc: old vs new checks for every .doc mapping doc. Checks are matched by their description (ids shift).
async function compareDocTemplates(templates) {
  const docs = templates.filter((t) => /\.doc$/i.test(templateRequirementService.resolveLocalTemplatePath(t, catalogService.DATA_DIR) || ''));
  console.log(`\n${docs.length} template(s) with a legacy .doc mapping doc\n`);
  const lines = [['DIG', 'Document', 'Old mode', 'New mode', 'Change', 'Check'].map(csvCell).join(',')];
  for (const t of docs) {
    const before = await requirementsOf(t, { convert: false });
    const after = await requirementsOf(t);
    const newMode = after.convertedFrom ? 'comments (.doc)' : after.mode;
    const label = (r) => `${r.description}${r.enabled === false ? ' [not checked]' : ''}`;
    const was = before.requirements.map(label); const now = after.requirements.map(label);
    const removed = was.filter((d) => !now.includes(d)); const added = now.filter((d) => !was.includes(d));
    console.log(`${t.digNumber}  ${t.documentName}`);
    if (!after.convertedFrom) {
      console.log(`  unchanged — ${after.mode === 'heuristic-doc' ? (/\.docx$/i.test(String(after.sourceFile)) ? 'no change' : "no Word comments, or it couldn't be converted (see the run log)") : after.mode}\n`);
      lines.push([t.digNumber, t.documentName, before.mode, newMode, 'unchanged', ''].map(csvCell).join(','));
      continue;
    }
    console.log(`  ${before.requirements.length} checks (text only) -> ${after.requirements.length} checks (Word comments)`);
    for (const d of removed) { console.log(`  - ${d}`); lines.push([t.digNumber, t.documentName, before.mode, newMode, 'removed', d].map(csvCell).join(',')); }
    for (const d of added) { console.log(`  + ${d}`); lines.push([t.digNumber, t.documentName, before.mode, newMode, 'added', d].map(csvCell).join(',')); }
    const kinds = (rs) => rs.reduce((m, r) => { m[r.type] = (m[r.type] || 0) + 1; return m; }, {});
    const lost = Object.keys(kinds(before.requirements)).filter((k) => !kinds(after.requirements)[k]);
    if (lost.length) console.log(`  ! kinds of check only the old reading had: ${lost.join(', ')}`);
    console.log('');
  }
  const outDir = path.join(__dirname, '..', 'results', 'smartComm');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `doc-compare-${Date.now()}.csv`);
  fs.writeFileSync(out, lines.join('\r\n'));
  console.log(`Wrote ${out}`);
}

// --fields: what each text-shaped field links to (validationService.linkTextFieldsToDictionary does the same at run time).
async function listTextFields(templates) {
  const dd = require('../helpers/smartComm/dataDictionaryService');
  for (const t of templates) {
    const result = await requirementsOf(t);
    const fields = (result.requirements || []).filter((r) => r.type === 'dynamicShape' && r.shape === 'text' && r.enabled !== false && r.fieldName);
    console.log(`\n${t.digNumber}  ${t.documentName} — ${fields.length} text-shaped field(s)`);
    let linked = 0;
    for (const r of fields) {
      const m = dd.matchDictionaryRowByCommentFieldName(t.digNumber, r.fieldName);
      const name = `"${r.fieldName}"`.padEnd(34);
      if (!m || m.matchedOn === 'wordOverlap') console.log(`  ${r.id.padEnd(5)} ${name} no Data Dictionary row${m ? ` (only a loose word match: "${m.row.attributeName}", not used)` : ''}`);
      else if (!m.row.xpath) console.log(`  ${r.id.padEnd(5)} ${name} row "${m.row.attributeName}" has no Xpath`);
      else { linked++; console.log(`  ${r.id.padEnd(5)} ${name} -> "${m.row.attributeName}"  ${m.row.xpath}`); }
    }
    if (fields.length) console.log(`  ${linked} of ${fields.length} compared with the payload at run time; the rest stay BLOCKED with the reason shown`);
  }
}

(async () => {
  const args = process.argv.slice(2);
  const compare = args.includes('--compare-doc');
  const wanted = args.filter((a) => !a.startsWith('--')).map(catalogService.normalizeDig);
  if (args.includes('--fields')) return listTextFields(catalogService.loadTemplateCatalog().filter((t) => !wanted.length || wanted.includes(t.digNumber)));
  if (compare) return compareDocTemplates(catalogService.loadTemplateCatalog().filter((t) => !wanted.length || wanted.includes(t.digNumber)));
  const templates = catalogService.loadTemplateCatalog().filter((t) => !wanted.length || wanted.includes(t.digNumber));
  const rows = [];
  const log = console.log;
  for (const t of templates) {
    const result = await requirementsOf(t);
    const reqs = result.requirements || [];
    const statics = reqs.filter((r) => r.type === 'requiredText' && /^Static content must appear/.test(r.description || ''));
    const suspicious = statics.map((r) => ({ r, kinds: looksLikeSample(r.expectedValue) })).filter((x) => x.kinds.length);
    rows.push({ t, mode: result.convertedFrom ? 'comments (.doc)' : (result.mode || 'none'), total: reqs.length, statics: statics.length, suspicious });
  }

  const heuristic = rows.filter((x) => /^heuristic/.test(x.mode));
  const flagged = rows.filter((x) => x.suspicious.length);
  log(`\n${rows.length} template(s): ${rows.filter((x) => x.mode === 'comments').length} comments, ${rows.filter((x) => x.mode === 'comments (.doc)').length} comments from a .doc, ` +
    `${heuristic.length} heuristic (no BA comments), ${rows.filter((x) => x.mode === 'none').length} no mapping doc\n`);
  log('Templates whose static checks contain sample data (these fail on every real claim):');
  if (!flagged.length) log('  none');
  for (const x of flagged) {
    log(`  ${x.t.digNumber.padEnd(8)} ${x.mode.padEnd(15)} ${x.suspicious.length} of ${x.statics} static check(s)  — ${x.t.documentName}`);
    for (const { r, kinds } of x.suspicious.slice(0, 4)) log(`      ${r.id} [${kinds.join(', ')}] ${String(r.expectedValue).slice(0, 90)}`);
    if (x.suspicious.length > 4) log(`      … ${x.suspicious.length - 4} more in the CSV`);
  }
  log('\nAll heuristic templates (no BA comments — names/sample wording are not detected, review these by hand):');
  log(heuristic.length ? '  ' + heuristic.map((x) => `${x.t.digNumber} (${x.statics} static)`).join(', ') : '  none');

  const outDir = path.join(__dirname, '..', 'results', 'smartComm');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `requirement-audit-${Date.now()}.csv`);
  const lines = [['DIG', 'Document', 'Mode', 'Checks', 'Static checks', 'Check id', 'Looks like', 'Expected text'].map(csvCell).join(',')];
  for (const x of rows) {
    const base = [x.t.digNumber, x.t.documentName, x.mode, x.total, x.statics];
    if (!x.suspicious.length) lines.push([...base, '', '', ''].map(csvCell).join(','));
    for (const { r, kinds } of x.suspicious) lines.push([...base, r.id, kinds.join('; '), r.expectedValue].map(csvCell).join(','));
  }
  fs.writeFileSync(out, lines.join('\r\n'));
  log(`\nWrote ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
