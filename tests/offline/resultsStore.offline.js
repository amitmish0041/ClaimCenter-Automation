// Offline checks of helpers/smartComm/resultsStore.js (the Runner's Results page reads these).
// Run with: npm run test:offline
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../helpers/smartComm/resultsStore');

const v = (id, result) => ({ id, description: id, result, expected: 'x', actual: 'y' });
const scenario = (scenarioId, status, validations, extra = {}) => ({ scenarioId, status, validations, ...extra });
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'results-'));
  fs.mkdirSync(path.join(root, 'bulk'), { recursive: true });
  return root;
}

test('lists bulk and single runs newest first, with counts', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'bulk', 'ui_bulk_1791000000000.json'), JSON.stringify([
    { digNumber: 'DIG26', templateName: 'Claim Status Report', overall: 'FAIL', scenarios: [scenario('DIG26-AUTO-PA', 'FAIL', [v('R18', 'FAIL'), v('R1', 'PASS')])] },
    { digNumber: 'DIG7', templateName: 'Risk Roof Report', overall: 'BLOCKED', scenarios: [scenario('DIG7-PR-PA', 'BLOCKED', [])] },
  ]));
  const id = store.saveRun([{ digNumber: 'DIG52', templateName: 'Contact Letter', overall: 'PASS', scenarios: [scenario('DIG52-AUTO-PA', 'PASS', [v('R1', 'PASS')])] }], { env: 'cloud/test' }, { root });
  fs.writeFileSync(path.join(root, 'bulk', 'broken.json'), '{ not json');
  const runs = store.listRuns({ root });
  assert.equal(runs.length, 2, 'the unreadable file is left out');
  assert.equal(runs[0].id, id, 'the run saved just now is first');
  assert.equal(runs[0].source, 'single');
  assert.equal(runs[0].env, 'cloud/test');
  assert.deepEqual(runs[1].counts, { PASS: 0, FAIL: 1, BLOCKED: 1, ERROR: 0 });
  assert.equal(runs[1].overall, 'FAIL');
  assert.equal(runs[1].startedAt, new Date(1791000000000).toISOString(), 'time taken from the file name');
});

test('getRun returns the full run; a bad id is refused', () => {
  const root = tempRoot();
  const id = store.saveRun([{ digNumber: 'DIG52', scenarios: [scenario('S1', 'PASS', [v('R1', 'PASS')])] }], {}, { root });
  assert.equal(store.getRun(id, { root }).templates[0].scenarios[0].validations[0].id, 'R1');
  for (const bad of ['../secret.json', 'runs--../../x.json', 'other--a.json', 'runs--a.txt', '']) assert.equal(store.getRun(bad, { root }), null, bad);
});

test('compareWithPrevious marks NEW failures and FIXED checks against the last run of the same scenario', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'bulk', 'ui_bulk_1790000000000.json'), JSON.stringify([
    { digNumber: 'DIG26', scenarios: [scenario('DIG26-AUTO-PA', 'FAIL', [v('R18', 'PASS'), v('INT3', 'FAIL'), v('R2', 'FAIL')])] },
  ]));
  fs.writeFileSync(path.join(root, 'bulk', 'ui_bulk_1791000000000.json'), JSON.stringify([
    { digNumber: 'DIG26', scenarios: [scenario('DIG26-AUTO-PA', 'FAIL', [v('R18', 'FAIL'), v('INT3', 'FAIL'), v('R2', 'PASS'), v('R99', 'FAIL')])] },
    { digNumber: 'DIG7', scenarios: [scenario('DIG7-PR-PA', 'BLOCKED', [])] },
  ]));
  const cmp = store.compareWithPrevious('bulk--ui_bulk_1791000000000.json', { root });
  const c = cmp.scenarios['DIG26|DIG26-AUTO-PA'];
  assert.equal(c.previousRunId, 'bulk--ui_bulk_1790000000000.json');
  assert.equal(c.checks.R18.change, 'NEW', 'passed before, failing now');
  assert.equal(c.checks.INT3.change, null, 'failing before and now: known, not new');
  assert.equal(c.checks.R2.change, 'FIXED');
  assert.equal(c.checks.R99.change, 'NEW', 'a check the last run did not have, failing now');
  assert.equal(cmp.newFailures, 2);
  assert.equal(cmp.fixed, 1);
  assert.equal(cmp.scenarios['DIG7|DIG7-PR-PA'].previousRunId, null, 'no earlier run of that scenario: nothing marked');
  const first = store.compareWithPrevious('bulk--ui_bulk_1790000000000.json', { root });
  assert.equal(first.newFailures, 0, 'the oldest run has nothing to compare with');
});

test('pdfPathFor only hands out a .pdf inside the results folder', () => {
  const root = tempRoot();
  const inside = path.join(root, 'downloads', 'a.pdf');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, '%PDF-1.4');
  const outside = path.join(os.tmpdir(), `outside-${process.pid}.pdf`);
  fs.writeFileSync(outside, '%PDF-1.4');
  const id = store.saveRun([{ digNumber: 'DIG26', scenarios: [
    scenario('IN', 'PASS', [], { pdfPath: inside }),
    scenario('OUT', 'PASS', [], { pdfPath: outside }),
    scenario('TXT', 'PASS', [], { pdfPath: path.join(root, 'runs', 'x.json') }),
  ] }], {}, { root });
  assert.equal(store.pdfPathFor(id, 'DIG26', 'IN', { root }), path.resolve(inside));
  assert.equal(store.pdfPathFor(id, 'DIG26', 'OUT', { root }), null);
  assert.equal(store.pdfPathFor(id, 'DIG26', 'TXT', { root }), null);
  assert.equal(store.pdfPathFor(id, 'DIG26', 'MISSING', { root }), null);
});
