// Replays every saved regression case in fixtures/smartComm/regression/ (see regressionCaseService) and fails on any
// check whose result or printed value changed. Run with: npm run test:offline
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cases = require('../../helpers/smartComm/regressionCaseService');

const describeDiff = (d) => `${d.id || `#${d.index}`} ${d.description || ''}: was ${d.was ? `${d.was.result} "${d.was.actual}"` : '(none)'}, now ${d.now ? `${d.now.result} "${d.now.actual}"` : '(none)'}`;

const kept = cases.loadFixtureCases();
test('at least one regression case is kept', () => assert.ok(kept.length > 0, `no cases in ${cases.FIXTURE_DIR}`));
for (const { file, kase } of kept) {
  test(`regression case ${file} (${kase.digNumber} ${kase.scenarioId}) replays unchanged`, () => {
    assert.ok(!kase.replayMismatch, `${file} didn't reproduce when it was captured (${kase.replayMismatch}) — re-capture it`);
    const diffs = cases.replayCase(kase);
    assert.equal(diffs.length, 0, `${diffs.length} check(s) changed:\n  ${diffs.map(describeDiff).join('\n  ')}`);
  });
}

test('a replay catches a changed result', () => {
  const { kase } = kept[0];
  const tampered = JSON.parse(JSON.stringify(kase));
  const i = tampered.expected.findIndex((e) => e.result === 'PASS');
  tampered.expected[i].result = 'FAIL';
  const diffs = cases.replayCase(tampered);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].index, i);
});

test('saving a case writes it and confirms it replays identically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-'));
  const requirements = [{ id: 'R1', description: 'state', type: 'requiredText', expectedValue: 'MI' }];
  const text = 'Loss state MI.';
  const validations = require('../../helpers/smartComm/pdfValidationService').evaluateRequirements(requirements, text, {});
  const file = cases.saveCase({ digNumber: 'DIG0', scenarioId: 'S1', requirements, text, context: {}, validations, dir, log: () => {} });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(path.dirname(file), dir);
  assert.equal(saved.replayMismatch, undefined);
  assert.deepEqual(saved.expected.map((e) => e.result), ['PASS']);
});
