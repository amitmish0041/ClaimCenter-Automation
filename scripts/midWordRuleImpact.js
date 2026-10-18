/**
 * scripts/midWordRuleImpact.js
 *
 * Catalog-wide impact check for a change to templateRequirementService (first
 * written for bc57ef5's mid-word comment-range rule): builds every catalog
 * template's mapping-doc requirements with the BASE version of the service and
 * with the current one, and lists exactly which requirements appeared or went
 * away. Nothing runs against SmartCOMM — it only reads the Word docs.
 *
 *   node scripts/midWordRuleImpact.js                    (base = bc57ef5~1)
 *   node scripts/midWordRuleImpact.js --base=<git rev>
 *
 * Reads : SMARTCOMM_DATA_DIR (Claims_Documents_Index*.xlsx + Templates/ClaimCenter)
 * Writes: results/midWordRuleImpact.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const catalogService = require('../helpers/smartComm/catalogService');
const current = require('../helpers/smartComm/templateRequirementService');

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : dflt;
};
const BASE = arg('base', 'bc57ef5~1');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'results', 'midWordRuleImpact.json');

// The base version is loaded from a temp copy NEXT TO the real file, so its own
// relative requires (./fieldLabelSynonyms) resolve exactly as they do in the app.
function loadBase() {
  const src = execFileSync('git', ['show', `${BASE}:helpers/smartComm/templateRequirementService.js`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tmp = path.join(ROOT, 'helpers', 'smartComm', `.impactBase.${process.pid}.js`);
  fs.writeFileSync(tmp, src);
  try { return require(tmp); } finally { fs.unlinkSync(tmp); }
}

// One requirement's identity for the diff — the R<n> id is left out, since a
// single added/removed requirement renumbers every one after it.
const keyOf = (r) => JSON.stringify([r.type, r.fieldName || '', r.expectedValue || '', r.shape || '', r.description || '']);
const show = (r) => `${r.type}${r.fieldName ? ` [${r.fieldName}]` : ''}: ${r.expectedValue != null ? JSON.stringify(r.expectedValue) : r.description}`;

// Multiset difference: each requirement in xs that ys doesn't also have.
function minus(xs, ys) {
  const left = ys.reduce((m, r) => m.set(keyOf(r), (m.get(keyOf(r)) || 0) + 1), new Map());
  return xs.filter((r) => {
    const n = left.get(keyOf(r)) || 0;
    if (n) left.set(keyOf(r), n - 1);
    return !n;
  });
}

async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
}

(async () => {
  const base = loadBase();
  const dataDir = catalogService.DATA_DIR;
  const catalog = catalogService.loadTemplateCatalog();
  console.log(`Base ${BASE} vs working tree — ${catalog.length} catalog templates under ${dataDir}\n`);

  const changed = [];
  let compared = 0, noDoc = 0, errors = 0;
  for (const template of catalog) {
    let before, after;
    try {
      before = await quietly(() => base.getRequirements(template, dataDir));
      after = await quietly(() => current.getRequirements(template, dataDir));
    } catch (e) {
      errors++;
      console.log(`${template.digNumber}: ERROR ${e.message}`);
      continue;
    }
    if (!after.sourceFile) { noDoc++; continue; }
    compared++;
    const removed = minus(before.requirements, after.requirements);
    const added = minus(after.requirements, before.requirements);
    if (!removed.length && !added.length) continue;
    changed.push({ digNumber: template.digNumber, sourceFile: path.basename(after.sourceFile), mode: after.mode, removed, added });
    console.log(`${template.digNumber}  (${path.basename(after.sourceFile)}, ${after.mode})`);
    for (const r of removed) console.log(`   - ${show(r)}`);
    for (const r of added) console.log(`   + ${show(r)}`);
  }

  console.log(`\n${compared} mapping docs compared, ${changed.length} changed, ${noDoc} without a local doc, ${errors} errors.`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ base: BASE, ranAt: new Date().toISOString(), dataDir, compared, noDoc, errors, changed }, null, 2));
  console.log(`Details: ${path.relative(ROOT, OUT)}`);
})().catch((e) => { console.error(e); process.exit(1); });
