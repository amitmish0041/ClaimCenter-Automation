/**
 * scripts/rescoreSweep.js
 *
 * Re-scores saved sweep results (results/smartComm/bulk/*.json, written by bulkValidateSmartComm.js) under the QA
 * hardening rules of 2026-10-18, without re-running anything, and lists every scenario whose status would change:
 *
 *   - short values (1-4 characters, no space) count only as whole words — re-checked against the scenario's own
 *     downloaded PDF (s.pdfPath); a row whose PDF is no longer on disk is listed as "couldn't re-check";
 *   - filing metadata that couldn't be read (META1 SKIPPED) is BLOCKED;
 *   - a scenario whose payload couldn't be downloaded gets a BLOCKED PAYLOAD0 row;
 *   - a scenario where no check passed or failed gets a BLOCKED NOCHECK0 row;
 *   - an On-Demand scenario that ended in ERROR on "reading 'filter'" (the status-rollup crash) is listed — its real
 *     result needs a re-run.
 * A layout-check crash was only logged, never saved, so it can't be found in old results.
 *
 *   node scripts/rescoreSweep.js                         (every results/smartComm/bulk/*.json)
 *   node scripts/rescoreSweep.js <sweep.json> [more.json ...]
 *
 * Writes: results/smartComm/rescore-<timestamp>.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfValidationService = require('../helpers/smartComm/pdfValidationService');
const { _test: { rollUpScenario, metadataUnavailableCheck, payloadUnavailableCheck } } = require('../helpers/smartComm/validationService');

const ROOT = path.join(__dirname, '..');
const BULK_DIR = path.join(ROOT, 'results', 'smartComm', 'bulk');
const normalizeWs = pdfValidationService.normalizeWs;
const isShort = (v) => typeof v === 'string' && /^\S{1,4}$/.test(normalizeWs(v)) && /[A-Za-z0-9]/.test(v);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asWord = (w, text) => new RegExp(`(^|[^A-Za-z0-9])${esc(normalizeWs(w))}(?![A-Za-z0-9])`, 'i').test(text);
const PAYLOAD_MISSING_RE = /payload couldn't be downloaded or parsed/i;

const pdfTextCache = new Map();
async function pdfText(pdfPath) {
  if (!pdfPath || !fs.existsSync(pdfPath)) return null;
  if (!pdfTextCache.has(pdfPath)) pdfTextCache.set(pdfPath, await pdfValidationService.extractPdfText(pdfPath).catch(() => null));
  return pdfTextCache.get(pdfPath);
}

async function rescoreScenario(s) {
  const changes = [];
  const unverified = [];
  if (s.status === 'ERROR' && /reading 'filter'/.test(s.reason || '')) {
    return { status: 'RE-RUN', changes: ['ended in ERROR from the On-Demand status-rollup crash (fixed) — re-run for its real result'], unverified };
  }
  if (!Array.isArray(s.validations) || s.status === 'ERROR') return { status: s.status, changes, unverified };
  const validations = s.validations.map((v) => ({ ...v }));

  // 1. Short values as whole words.
  const shortPasses = validations.filter((v) => v.result === 'PASS' && isShort(v.expected) && !/^Before edit/.test(String(v.actual || '')));
  if (shortPasses.length) {
    const text = await pdfText(s.pdfPath);
    for (const v of shortPasses) {
      if (text == null) { unverified.push(`${v.id} "${v.expected}" (PDF not on disk)`); continue; }
      const printed = isShort(v.actual) ? v.actual : v.expected;
      if (!asWord(printed, text)) {
        v.result = 'FAIL';
        changes.push(`${v.id} "${v.expected}" PASS → FAIL: only found inside another word ("${v.description || ''}")`);
      }
    }
  }
  // 3. Checks that couldn't run.
  for (let i = 0; i < validations.length; i++) {
    const v = validations[i];
    if (/^META1$/.test(v.id || '') && v.result === 'SKIPPED') {
      validations[i] = { ...metadataUnavailableCheck(v.reason), reason: v.reason };
      changes.push(`META1 SKIPPED → BLOCKED: filing metadata not checked (${String(v.reason || '').slice(0, 80)})`);
    }
  }
  if (validations.some((v) => PAYLOAD_MISSING_RE.test(v.reason || '')) && !validations.some((v) => v.id === 'PAYLOAD0')) {
    validations.push(payloadUnavailableCheck());
    changes.push('PAYLOAD0 added (BLOCKED): the payload was missing, so the Data Dictionary value checks never ran');
  }
  // 4. Nothing actually ran — and the new status.
  const before = validations.length;
  const { status } = rollUpScenario(validations, s.interactiveChecks);
  if (validations.length > before) changes.push('NOCHECK0 added (BLOCKED): no check passed or failed');
  return { status, changes, unverified };
}

async function main() {
  const files = process.argv.slice(2).length ? process.argv.slice(2)
    : (fs.existsSync(BULK_DIR) ? fs.readdirSync(BULK_DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(BULK_DIR, f)) : []);
  if (!files.length) { console.log(`No sweep results found (looked in ${BULK_DIR}). Pass sweep .json files as arguments.`); return; }

  const rows = [];
  for (const file of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log(`skipping ${file}: ${e.message}`); continue; }
    const templates = Array.isArray(data) ? data : (data.templateResults || data.results || []);
    for (const t of templates) {
      for (const s of t.scenarios || []) {
        const r = await rescoreScenario(s);
        rows.push({ file: path.basename(file), digNumber: t.digNumber, scenarioId: s.scenarioId, was: s.status, now: r.status, changes: r.changes, unverified: r.unverified });
      }
    }
  }

  const changed = rows.filter((r) => r.was !== r.now);
  const matrix = {};
  for (const r of rows) matrix[`${r.was} → ${r.now}`] = (matrix[`${r.was} → ${r.now}`] || 0) + 1;
  console.log(`\n${rows.length} scenarios in ${files.length} file(s); ${changed.length} would change status.\n`);
  console.log('Status before → after (count):');
  for (const [k, n] of Object.entries(matrix).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${n}`);
  if (changed.length) {
    console.log('\nScenarios that change:');
    for (const r of changed) {
      console.log(`  ${r.digNumber} ${r.scenarioId}: ${r.was} → ${r.now}  [${r.file}]`);
      for (const c of r.changes) console.log(`      - ${c}`);
    }
  }
  const unverified = rows.filter((r) => r.unverified.length);
  if (unverified.length) {
    console.log(`\n${unverified.length} scenario(s) have short-value PASSes that couldn't be re-checked (PDF no longer on disk):`);
    for (const r of unverified) console.log(`  ${r.digNumber} ${r.scenarioId}: ${r.unverified.join('; ')}`);
  }
  const out = path.join(ROOT, 'results', 'smartComm', `rescore-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ files, matrix, rows }, null, 2));
  console.log(`\nDetails: ${path.relative(ROOT, out)}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { rescoreScenario };
