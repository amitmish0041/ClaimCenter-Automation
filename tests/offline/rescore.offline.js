// Offline checks of scripts/rescoreSweep.js (re-scoring saved sweep results under the 2026-10-18 rules).
// Run with: npm run test:offline
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rescoreScenario } = require('../../scripts/rescoreSweep');

const pass = (id, expected) => ({ id, description: id, expected, actual: expected, result: 'PASS' });

test('rescore: metadata SKIPPED, missing payload and nothing-ran scenarios become BLOCKED', async () => {
  assert.equal((await rescoreScenario({ status: 'PASS', validations: [pass('R1', 'Michael Smith'), { id: 'META1', result: 'SKIPPED', reason: 'no json' }] })).status, 'BLOCKED');
  assert.equal((await rescoreScenario({ status: 'PASS', validations: [pass('R1', 'Michael Smith'), { id: 'R9', result: 'BLOCKED', reason: "The SmartCOMM payload couldn't be downloaded or parsed for this scenario" }] })).status, 'BLOCKED');
  assert.equal((await rescoreScenario({ status: 'PASS', validations: [{ id: 'R1', result: 'SKIPPED' }] })).status, 'BLOCKED');
  assert.equal((await rescoreScenario({ status: 'PASS', validations: [pass('R1', 'Michael Smith')] })).status, 'PASS');
});

test('rescore: a short-value PASS whose PDF is gone is listed as not re-checked, not changed', async () => {
  const r = await rescoreScenario({ status: 'PASS', pdfPath: '/no/such.pdf', validations: [pass('XP1', 'MI')] });
  assert.equal(r.status, 'PASS');
  assert.equal(r.unverified.length, 1);
});

test('rescore: the On-Demand rollup crash is flagged for a re-run', async () => {
  assert.equal((await rescoreScenario({ status: 'ERROR', reason: "Cannot read properties of undefined (reading 'filter')" })).status, 'RE-RUN');
  assert.equal((await rescoreScenario({ status: 'ERROR', reason: 'GENERATE_TIMEOUT' })).status, 'ERROR');
});
