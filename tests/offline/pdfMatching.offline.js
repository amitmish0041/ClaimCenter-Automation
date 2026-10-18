// Offline checks of pdfValidationService's matching rules — no browser, SmartCOMM or catalog needed.
// Run with: npm run test:offline
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pdf = require('../../helpers/smartComm/pdfValidationService');

const run = (reqs, text, context = {}) => pdf.evaluateRequirements(reqs.map((r, i) => ({ id: r.id || `R${i + 1}`, description: r.id || 'check', ...r })), text, context);
const one = (req, text, context) => run([req], text, context)[0];

const LETTER = 'Claim for Michael Smith. Yesterday we wrote to you. Policy PA-12345, loss state MI. Amount $900.00. Total 15000. Answer: N/A';

test('short values only count as whole words (QA review 2026-10-18)', () => {
  assert.equal(one({ type: 'requiredText', expectedValue: 'MI' }, LETTER).result, 'PASS', '"MI" printed as its own word');
  assert.equal(one({ type: 'requiredText', expectedValue: 'MI' }, 'Claim for Michael Smith.').result, 'FAIL', '"MI" inside "Michael" is not a match');
  assert.equal(one({ type: 'requiredText', expectedValue: 'Yes' }, LETTER).result, 'FAIL', '"Yes" inside "Yesterday" is not a match');
  assert.equal(one({ type: 'requiredText', expectedValue: '1500' }, LETTER).result, 'FAIL', '"1500" inside "15000" is not a match');
  assert.equal(one({ type: 'requiredText', expectedValue: 'PA' }, LETTER).result, 'PASS', '"PA" followed by a dash still counts');
  assert.equal(one({ type: 'requiredText', expectedValue: '900' }, LETTER).result, 'PASS', '"900" in "$900.00" still counts');
  assert.equal(one({ type: 'requiredText', expectedValue: 'N/A' }, LETTER).result, 'PASS');
});

test('whole-word edges: a boundary is needed only where the value starts/ends with a letter or digit (re-score 2026-10-18)', () => {
  assert.equal(one({ type: 'requiredText', expectedValue: 'D/L:' }, 'D/L:08/06/2026').result, 'PASS', 'DIG52 label run into its date');
  assert.equal(one({ type: 'requiredText', expectedValue: '#1' }, 'VEH#1 VEH#2').result, 'PASS', 'DIG126 "#1" right after VEH');
  assert.equal(one({ type: 'requiredText', expectedValue: '#1' }, 'VEH #12').result, 'FAIL', '"#1" inside "#12" is not a match');
  assert.equal(one({ type: 'requiredText', expectedValue: 'VEH' }, 'VEHICLE').result, 'FAIL');
});

test('short labels: a known synonym or the same words with inner punctuation still match (DIG52 "D/L:")', () => {
  const r = one({ type: 'requiredText', expectedValue: 'D/L:' }, 'Date of Loss: 08/06/2026');
  assert.equal(r.result, 'PASS');
  assert.match(r.reason, /synonym/);
  assert.equal(one({ type: 'requiredText', expectedValue: 'VIN' }, 'V.I.N. 1HGCM82633A004352').result, 'PASS');
  assert.equal(one({ type: 'requiredText', expectedValue: 'VIN' }, 'VINTAGE car').result, 'FAIL');
});

test('short values on a boxed form: also found in the layout-aware reading (DIG126)', () => {
  assert.equal(one({ type: 'requiredText', expectedValue: 'YES' }, 'VEHYES NO', { layoutText: 'VEH   YES   NO' }).result, 'PASS');
  assert.equal(one({ type: 'requiredText', expectedValue: 'YES' }, 'VEHYES NO', {}).result, 'FAIL');
  assert.equal(one({ type: 'requiredText', expectedValue: 'YES' }, 'VEHYES NO', { layoutText: 'YESTERDAY' }).result, 'FAIL');
});

test('short values: accepted alternatives keep their note; test-data values follow the same rule', () => {
  const alt = one({ type: 'requiredText', expectedValue: 'TX', alsoAccept: ['MI'], alsoAcceptNote: 'UTC note' }, LETTER);
  assert.equal(alt.result, 'PASS');
  assert.equal(alt.actual, 'MI');
  assert.equal(alt.reason, 'UTC note');
  const ctx = { testData: { state: 'MI', policyState: 'PA' } };
  assert.equal(one({ type: 'dynamicValueMatch', expectedSource: 'testData.state' }, 'Claim for Michael Smith.', ctx).result, 'FAIL');
  assert.equal(one({ type: 'dynamicValueMatch', expectedSource: 'testData.policyState' }, LETTER, ctx).result, 'PASS');
});

test('a short value the test edited is judged on what the field showed before the edit', () => {
  const r = one({ type: 'requiredText', expectedValue: 'OH', wasEditedByTest: true, editedBefore: ['OH'] }, LETTER);
  assert.equal(r.result, 'PASS');
  assert.match(r.actual, /Before edit/);
  assert.equal(one({ type: 'requiredText', expectedValue: 'OH', wasEditedByTest: true, editedBefore: ['KY'] }, LETTER).result, 'FAIL');
});

test('longer values still match as text, anywhere in the document', () => {
  assert.equal(one({ type: 'requiredText', expectedValue: 'Michael Smith' }, LETTER).result, 'PASS');
  assert.equal(one({ type: 'requiredText', expectedValue: 'Michael Smyth' }, LETTER).result, 'FAIL');
});

test('fixed wording: a dropped "not" or a changed word FAILs; punctuation-only differences PASS', () => {
  const text = 'Please return the enclosed forms within thirty days. You must drive the vehicle. Workers compensation applies.';
  assert.equal(one({ type: 'requiredText', expectedValue: 'You must not drive the vehicle.' }, text).result, 'FAIL');
  assert.equal(one({ type: 'requiredText', expectedValue: 'Please return the enclosed form within thirty days.' }, text).result, 'FAIL');
  assert.equal(one({ type: 'requiredText', expectedValue: "Worker's compensation applies." }, text).result, 'PASS');
  assert.equal(one({ type: 'requiredText', expectedValue: 'This paragraph is not printed at all anywhere.' }, text).result, 'FAIL');
});

test('dates match in the template\'s own format', () => {
  assert.equal(one({ type: 'requiredText', expectedValue: 'August 06, 2026' }, 'Date of loss: 08/06/2026').result, 'PASS');
  assert.equal(one({ type: 'requiredText', expectedValue: 'August 07, 2026' }, 'Date of loss: 08/06/2026').result, 'FAIL');
});

test('salutation: a fixed honorific that is not part of the recipient\'s name FAILs', () => {
  const req = { type: 'salutation' };
  assert.equal(one(req, 'Dear ROBERT CHARLES:', { recipient: { name: 'ROBERT CHARLES' } }).result, 'PASS');
  assert.equal(one(req, 'Dear Mrs. ROBERT CHARLES:', { recipient: { name: 'ROBERT CHARLES' } }).result, 'FAIL');
  assert.equal(one(req, 'No greeting here.', {}).result, 'FAIL');
});

test('a disabled requirement is SKIPPED, never PASS', () => {
  assert.equal(one({ type: 'requiredText', expectedValue: 'anything', enabled: false, disabledReason: 'not this scenario' }, LETTER).result, 'SKIPPED');
});
