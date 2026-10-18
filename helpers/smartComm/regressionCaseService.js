/**
 * helpers/smartComm/regressionCaseService.js
 * Saved regression cases for the PDF checks: everything pdfValidationService.evaluateRequirements was given for one
 * real scenario (the requirements, the PDF's text and layout text, the claim/payload context) plus what it returned.
 * Replaying a case re-runs evaluateRequirements on the saved inputs and lists every check whose result changed — so a
 * change to the matching rules can be checked against real templates offline, in seconds, before it's pushed.
 *
 * Capture: run a template with SMARTCOMM_SAVE_REGRESSION_CASE=1 — each scenario writes
 *          results/smartComm/regression-cases/<DIG>_<scenario>.json (see validationService).
 * Keep:    review the case's results, then copy the file into fixtures/smartComm/regression/.
 * Replay:  npm run test:offline (tests/offline/regressionCases.offline.js replays every kept case).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfValidationService = require('./pdfValidationService');
const fraudLanguageService = require('./fraudLanguageService');

const CAPTURE_DIR = path.join(__dirname, '..', '..', 'results', 'smartComm', 'regression-cases');
const FIXTURE_DIR = path.join(__dirname, '..', '..', 'fixtures', 'smartComm', 'regression');

// What a case remembers about each check's outcome.
const outcomeOf = (v) => ({ id: v.id || '', description: v.description || '', result: v.result, actual: v.actual === undefined ? null : String(v.actual) });

// Re-runs a case and returns every check whose result or actual value differs from the saved one.
function replayCase(kase) {
  const run = () => pdfValidationService.evaluateRequirements(kase.requirements, kase.text, kase.context).map(outcomeOf);
  const got = kase.fraudTable ? fraudLanguageService.withFraudLanguageTable(kase.fraudTable, run) : run();
  const diffs = [];
  const n = Math.max(got.length, kase.expected.length);
  for (let i = 0; i < n; i++) {
    const want = kase.expected[i];
    const now = got[i];
    if (!want || !now) { diffs.push({ index: i, id: (want || now).id, was: want || null, now: now || null }); continue; }
    if (want.result !== now.result || want.actual !== now.actual) diffs.push({ index: i, id: want.id, description: want.description, was: want, now });
  }
  return diffs;
}

// Writes the case for one scenario (validations = evaluateRequirements' own output, before any later annotation), then
// replays it straight away: saved inputs that don't reproduce their own results would make a useless case.
function saveCase({ digNumber, scenarioId, requirements, text, context, validations, dir = CAPTURE_DIR, log = console.log }) {
  const kase = JSON.parse(JSON.stringify({
    digNumber, scenarioId, capturedAt: new Date().toISOString(), requirements, text, context, expected: validations.map(outcomeOf),
    // The fraud "None" check reads the Fraud Language sheet — keep the rows it was judged against.
    ...(requirements.some((r) => r.type === 'fraudLanguageAbsent') ? { fraudTable: fraudLanguageService.loadFraudLanguageTable() } : {}),
  }));
  const diffs = replayCase(kase);
  if (diffs.length) kase.replayMismatch = diffs.map((d) => d.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${digNumber}_${scenarioId}.json`.replace(/[^\w.-]+/g, '_'));
  fs.writeFileSync(file, JSON.stringify(kase, null, 1));
  log(diffs.length
    ? `regression case saved to ${file}, but ${diffs.length} check(s) don't reproduce when replayed (${kase.replayMismatch.join(', ')}) — don't keep this case as is`
    : `regression case saved to ${file} (replays identically)`);
  return file;
}

function loadFixtureCases(dir = FIXTURE_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ file: f, kase: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

module.exports = { replayCase, saveCase, loadFixtureCases, CAPTURE_DIR, FIXTURE_DIR };
