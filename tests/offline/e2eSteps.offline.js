// Offline checks of the Claims-tab step switches (helpers/e2eSteps.js). Run with: npm run test:offline
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../helpers/e2eSteps');

const withEnv = (vars, fn) => {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { fn(); } finally { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } }
};

test('default steps are everything except close', () => withEnv({ CC_E2E_STEPS: null }, () => {
  assert.deepEqual(E.steps(), ['reserve', 'payment', 'approval', 'recovery']);
}));

test('approval is dropped without a payment; "none" runs no steps', () => {
  withEnv({ CC_E2E_STEPS: 'approval,close' }, () => assert.deepEqual(E.steps(), ['close']));
  withEnv({ CC_E2E_STEPS: 'none' }, () => assert.deepEqual(E.steps(), []));
});

test('test titles map to the right step', () => {
  assert.equal(E.stepOf('E2E-PA-009 [DMTA0019]: Subrogation recovery reserve + receipt'), 'recovery');
  assert.equal(E.stepOf('E2E-CA-004: Approve payment from Approval Queue'), 'approval');
  assert.equal(E.stepOf('E2E-CA-003 [DMTA0012]: Create $1,000 partial payment — routes to approval'), 'payment');
  assert.equal(E.stepOf('E2E-HO-005 [DMSG0003]: $150k reserve triggers Complex segment'), 'reserve');
  assert.equal(E.stepOf('E2E-BOP-006: Close exposures, then close claim (Covered - Settled)'), 'close');
  assert.equal(E.stepOf('E2E-HO-002 [DMCW0005]: FNOL creates Inspect Damage activity'), 'fnol');
  assert.equal(E.stepOf('E2E-CA-005: Complete all open workplan activities'), null);
});

test('gate skips FNOL only for an existing claim, and unselected steps', () => {
  const calls = [];
  const fake = { skip: (cond, why) => calls.push([cond, why]) };
  withEnv({ CC_E2E_CLAIM: 'CA-OH-85-26-0000371', CC_E2E_STEPS: 'reserve' }, () => {
    E.gate(fake, { title: 'E2E-CA-001 [FNOL]: Complete CA FNOL' });
    E.gate(fake, { title: 'E2E-CA-002 [DMIR0001]: Create $5,000 reserve' });
    E.gate(fake, { title: 'E2E-CA-REC [DMTA0019]: Subrogation recovery reserve + receipt' });
  });
  assert.deepEqual(calls.map(c => c[0]), [true, false, true]);
});
