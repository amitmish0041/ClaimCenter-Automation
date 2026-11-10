#!/usr/bin/env node
/**
 * scripts/printTestPlan.js - the physical print test (templates marked X in the "Print test" column of Templates_Approved_for_SMT_dev.xlsx).
 *   node scripts/printTestPlan.js <workbook.xlsx> [outPlan.json] [--seed <text>]
 * Writes a plan: one scenario per template, each with its own random Recipients-tab choices -
 *   secondary: primary recipient only, or primary + a secondary (additional) recipient (mixed ACROSS templates, about half each;
 *              a template whose own mapping doc prints "Copy/cc" lines always gets the secondary, or those lines could not be checked)
 *   certifiedMail / returnEnvelope: shuffled so all four Yes/No combinations are spread over the templates
 * Delivery channel is always Print. Run it with: SMARTCOMM_PRINT_PLAN=<plan.json> SMARTCOMM_INTERACTIVE=1 node scripts/bulkValidateSmartComm.js <digs from the plan>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const catalogService = require('../helpers/smartComm/catalogService');

const args = process.argv.slice(2);
const seedAt = args.indexOf('--seed');
const seed = seedAt >= 0 ? args.splice(seedAt, 2)[1] : new Date().toISOString();
const [book, outArg] = args;
if (!book) { console.error('Usage: node scripts/printTestPlan.js <workbook.xlsx> [outPlan.json] [--seed <text>]'); process.exit(1); }

// small seeded generator, so a plan can be reproduced from its seed
let h = 1779033703;
for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
const rand = () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const rows = XLSX.utils.sheet_to_json(XLSX.readFile(book).Sheets['DIG master'] || XLSX.readFile(book).Sheets[XLSX.readFile(book).SheetNames[0]], { header: 1, defval: '' });
const picked = rows.filter((r) => /^x$/i.test(String(r[0]).trim())).map((r) => ({ digNumber: catalogService.normalizeDig(r[1]), name: String(r[4]).trim(), lob: String(r[2]).trim(), state: String(r[3]).trim() }));
const unique = [...new Map(picked.map((p) => [p.digNumber, p])).values()];

const known = [], missing = [];
for (const p of unique) (catalogService.getTemplate(p.digNumber) ? known : missing).push(p);

const combos = [[true, true], [true, false], [false, true], [false, false]];
const mail = []; while (mail.length < known.length) mail.push(...shuffle(combos));
const sec = shuffle(known.map((_, i) => i % 2 === 0));

const plan = { seed, createdAt: new Date().toISOString(), source: path.basename(book), deliveryChannel: 'Print', templates: {} };
known.forEach((p, i) => {
  plan.templates[p.digNumber] = { name: p.name, secondary: sec[i], certifiedMail: mail[i][0], returnEnvelope: mail[i][1] };
});
plan.notFoundInCatalog = missing;
const out = outArg || path.join(__dirname, '..', 'results', 'smartComm', `print-test-plan-${Date.now()}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(plan, null, 2));
const v = Object.values(plan.templates);
console.log(`${known.length} templates planned (${missing.length} not in the catalog: ${missing.map((m) => m.digNumber).join(', ') || 'none'})`);
console.log(`secondary recipient: ${v.filter((x) => x.secondary).length} yes / ${v.filter((x) => !x.secondary).length} primary only; certified ${v.filter((x) => x.certifiedMail).length}/${v.length}; return envelope ${v.filter((x) => x.returnEnvelope).length}/${v.length}`);
console.log(out);
