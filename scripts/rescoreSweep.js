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
const { extractLayoutText } = require('../helpers/smartComm/pdfLayoutText');
const { _test: { payloadUnavailableCheck } } = require('../helpers/smartComm/validationService');

const ROOT = path.join(__dirname, '..');
const BULK_DIR = path.join(ROOT, 'results', 'smartComm', 'bulk');
const normalizeWs = pdfValidationService.normalizeWs;
const isShort = (v) => typeof v === 'string' && /^\S{1,4}$/.test(normalizeWs(v)) && /[A-Za-z0-9]/.test(v);
// Only the PDF-text checks (mapping-doc R…, Data Dictionary XP…) go through the whole-word rule — not META (the archive
// .json), EDIT, LOCK, LAYOUT or DATA rows, which compare other things.
const PDF_CHECK_ID_RE = /^(R|XP)\d+$/;
const PAYLOAD_MISSING_RE = /payload couldn't be downloaded or parsed/i;

// The PDF's plain text and its layout-aware reading (boxed forms — same fallback the live check uses).
const pdfTextCache = new Map();
async function pdfTexts(pdfPath) {
  if (!pdfPath || !fs.existsSync(pdfPath)) return null;
  if (!pdfTextCache.has(pdfPath)) {
    const [text, layout] = await Promise.all([
      pdfValidationService.extractPdfText(pdfPath).catch(() => ''),
      extractLayoutText(pdfPath).catch(() => ''),
    ]);
    pdfTextCache.set(pdfPath, { text, layout, readable: /[A-Za-z0-9]/.test(`${text}${layout}`) });
  }
  return pdfTextCache.get(pdfPath);
}

// The PDF text around the first place the value occurs inside other text, so a reviewer can judge the change.
function whereFound(value, texts) {
  for (const [name, t] of [['text', texts.text], ['layout', texts.layout]]) {
    const flat = String(t || '').replace(/\s+/g, ' ');
    const i = flat.toLowerCase().indexOf(normalizeWs(value).toLowerCase());
    if (i >= 0) return ` — in the PDF ${name}: "…${flat.slice(Math.max(0, i - 25), i + value.length + 25)}…"`;
  }
  return NOT_IN_PDF;
}
const NOT_IN_PDF = ' — not in the PDF text at all';

// Applies ONLY the 2026-10-18 changes on top of the scenario's saved status — an old run's status isn't recomputed from
// scratch, since it may come from an error/approval path or from older rules this re-score isn't about.
async function rescoreScenario(s) {
  const changes = [];
  const unverified = [];
  if (s.status === 'ERROR' && /reading 'filter'/.test(s.reason || '')) {
    return { status: 'RE-RUN', changes: ['ended in ERROR from the On-Demand status-rollup crash (fixed) — re-run for its real result'], unverified };
  }
  if (!Array.isArray(s.validations) || s.status === 'ERROR') return { status: s.status, changes, unverified };
  const validations = s.validations.map((v) => ({ ...v }));
  let newFail = false;
  let newBlocked = false;

  // 1. Short values as whole words (PDF-text checks only), in the plain text or the layout-aware reading.
  const shortPasses = validations.filter((v) => PDF_CHECK_ID_RE.test(v.id || '') && v.result === 'PASS' && isShort(v.expected) && !/^Before edit/.test(String(v.actual || '')));
  if (shortPasses.length) {
    const texts = await pdfTexts(s.pdfPath);
    for (const v of shortPasses) {
      if (!texts) { unverified.push(`${v.id} "${v.expected}" (PDF not on disk)`); continue; }
      // The live check itself, on this PDF (plain + layout text): whole word, punctuation-blind words, label synonyms.
      const accepted = isShort(v.actual) && normalizeWs(v.actual).toLowerCase() !== normalizeWs(v.expected).toLowerCase() ? [v.actual] : [];
      const [now] = pdfValidationService.evaluateRequirements([{ id: v.id, description: v.description, type: 'requiredText', expectedValue: v.expected, alsoAccept: accepted }], texts.text, { layoutText: texts.layout });
      // The value isn't anywhere in this PDF, not even inside other text: the PDF on disk isn't the one that run checked
      // (downloads are named <DIG>_<claim>_<scenario>.pdf, so a later run of the same scenario replaces it — DIG126 on the
      // team PC, 2026-10-18). The new rule can't be judged on it.
      if (now.result !== 'PASS' && whereFound(v.expected, texts) === NOT_IN_PDF) {
        unverified.push(`${v.id} "${v.expected}" (${texts.readable ? 'not in the PDF on disk at all — replaced by a later run' : 'the PDF on disk has no readable text — image-only or not a real PDF'})`);
        continue;
      }
      if (now.result !== 'PASS') {
        v.result = 'FAIL';
        newFail = true;
        changes.push(`${v.id} "${v.expected}" PASS → FAIL: not printed as a word of its own ("${v.description || ''}")${whereFound(v.expected, texts)}`);
      }
    }
  }
  // 3. Checks that couldn't run.
  for (const v of validations) {
    if (v.id === 'META1' && v.result === 'SKIPPED') {
      v.result = 'BLOCKED';
      newBlocked = true;
      changes.push(`META1 SKIPPED → BLOCKED: filing metadata not checked (${String(v.reason || '').slice(0, 80)})`);
    }
  }
  if (validations.some((v) => PAYLOAD_MISSING_RE.test(v.reason || '')) && !validations.some((v) => v.id === 'PAYLOAD0')) {
    validations.push(payloadUnavailableCheck());
    newBlocked = true;
    changes.push('PAYLOAD0 added (BLOCKED): the payload was missing, so the Data Dictionary value checks never ran');
  }
  // 4. Nothing actually ran.
  const ran = (x) => x.result === 'PASS' || x.result === 'FAIL';
  if (!validations.some(ran) && !(s.interactiveChecks || []).some(ran)) {
    newBlocked = true;
    changes.push('NOCHECK0 added (BLOCKED): no check passed or failed');
  }
  let status = s.status;
  if (newFail && (status === 'PASS' || status === 'BLOCKED')) status = 'FAIL';
  else if (newBlocked && status === 'PASS') status = 'BLOCKED';
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
    console.log(`\n${unverified.length} scenario(s) have short-value PASSes that couldn't be re-checked (PDF gone, or replaced by a later run):`);
    for (const r of unverified) console.log(`  ${r.digNumber} ${r.scenarioId} [${r.file}]: ${r.unverified.join('; ')}`);
  }
  const out = path.join(ROOT, 'results', 'smartComm', `rescore-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ files, matrix, rows }, null, 2));
  console.log(`\nDetails: ${path.relative(ROOT, out)}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { rescoreScenario };
