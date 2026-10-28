// Offline checks that a "text-shaped value" check (a BA field with no known mapping — DIG168's "Appraisal Amount")
// is compared with the payload when the Data Dictionary has that field, instead of reporting BLOCKED.
// The dictionary is stubbed here (the real one only exists on the team's PCs). Run with: npm run test:offline
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dd = require('../../helpers/smartComm/dataDictionaryService');
const { _test: v } = require('../../helpers/smartComm/validationService');
const pdf = require('../../helpers/smartComm/pdfValidationService');

const ROWS = [
  { attributeName: 'Appraisal Amount', templateAttributeName: '', forms: { all: false, digs: ['DIG168'] }, editable: null, xpath: 'ccDocumentCreationRequest.claim.appraisalAmount_ext' },
  { attributeName: 'NADA Value', templateAttributeName: '', forms: { all: false, digs: ['DIG168'] }, editable: null, xpath: 'ccDocumentCreationRequest.claim.nadaValue_ext' },
  { attributeName: 'Damage Modifier', templateAttributeName: '', forms: { all: false, digs: ['DIG168'] }, editable: null, xpath: '' },
];
function withDictionary(rows, fn) {
  const saved = { get: dd.getAttributesForTemplate, match: dd.matchDictionaryRowByCommentFieldName };
  dd.getAttributesForTemplate = () => rows;
  dd.matchDictionaryRowByCommentFieldName = (dig, name) => {
    const row = rows.find((r) => r.attributeName.toLowerCase() === String(name).trim().toLowerCase());
    if (row) return { row, matchedOn: 'attributeNameExact' };
    const loose = rows.find((r) => String(name).toLowerCase().includes(r.attributeName.split(' ')[0].toLowerCase()));
    return loose ? { row: loose, matchedOn: 'wordOverlap' } : null;
  };
  try { return fn(); } finally { dd.getAttributesForTemplate = saved.get; dd.matchDictionaryRowByCommentFieldName = saved.match; }
}
const textCheck = (id, fieldName) => ({ id, type: 'dynamicShape', shape: 'text', fieldName, description: `A text-shaped value must appear for "${fieldName}"` });
const TEMPLATE = { digNumber: 'DIG168' };
const PAYLOAD = { claim: { appraisalAmount_ext: '2450.00' } }; // already inside <ccDocumentCreationRequest>, as validationService passes it

function run(reqs, payload = PAYLOAD) {
  return withDictionary(ROWS, () => {
    const xp = v.buildXpathRequirements(TEMPLATE, payload, reqs, [], () => {});
    return { xp, linked: v.linkTextFieldsToDictionary(TEMPLATE, reqs, xp, payload) };
  });
}

test('a text-shaped field the dictionary maps becomes a payload value check', () => {
  const { xp, linked } = run([textCheck('R5', 'Appraisal Amount')]);
  assert.equal(xp.length, 1, 'an XP check is built for the field even though no other check names it');
  const r = linked[0];
  assert.equal(r.id, 'R5');
  assert.equal(r.expectedValue, '2450.00');
  assert.match(r.description, /Appraisal Amount.*payload.*Data Dictionary "Appraisal Amount"/);
  assert.equal(pdf.evaluateRequirements([r], 'Appraisal amount: 2450.00', {})[0].result, 'PASS');
  assert.equal(pdf.evaluateRequirements([r], 'Appraisal amount: 1000.00', {})[0].result, 'FAIL');
});

test('no value in ClaimCenter passes; fields that cannot be compared stay BLOCKED and say why', () => {
  const { linked } = run([textCheck('R1', 'NADA Value'), textCheck('R2', 'Damage Modifier'), textCheck('R3', 'Both Check Label')]);
  const why = linked.map((r) => pdf.evaluateRequirements([r], 'x', {})[0]);
  // R1: the Xpath reads fine but ClaimCenter has no value — nothing to print, PASS (user direction 2026-10-28).
  assert.deepEqual(why.map((w) => w.result), ['PASS', 'BLOCKED', 'BLOCKED']);
  assert.match(why[0].reason, /ClaimCenter has no value for this field/);
  assert.match(why[1].reason, /"Damage Modifier" has no Xpath/);
  assert.match(why[2].reason, /no matching Data Dictionary row/);
});

test('a loose word-overlap match is not trusted', () => {
  const { xp, linked } = run([textCheck('R1', 'Appraisal Total Override')]);
  assert.equal(xp.length, 0);
  assert.equal(linked[0].type, 'dynamicShape');
});

test('without a payload the reason says so; without a dictionary nothing changes', () => {
  const { linked } = run([textCheck('R1', 'Appraisal Amount')], null);
  assert.match(pdf.evaluateRequirements(linked, 'x', {})[0].reason, /payload couldn't be read/);
  const saved = dd.matchDictionaryRowByCommentFieldName;
  dd.matchDictionaryRowByCommentFieldName = () => { throw new Error('no dictionary file'); };
  try {
    const r = textCheck('R1', 'Appraisal Amount');
    assert.equal(v.linkTextFieldsToDictionary(TEMPLATE, [r], [], PAYLOAD)[0], r);
  } finally { dd.matchDictionaryRowByCommentFieldName = saved; }
});

test('other checks are left alone', () => {
  const others = [{ id: 'R1', type: 'requiredText', expectedValue: 'Mileage of car' }, { ...textCheck('R2', 'Appraisal Amount'), enabled: false, disabledReason: 'conditional' }];
  const { linked } = run(others);
  assert.deepEqual(linked, others);
});

test('a payload number matches its printed form ($2,450.00, 12,500)', () => {
  assert.deepEqual(v.printedNumberForms('2450.00'), ['2,450.00', '$2,450.00', '2,450', '$2,450']);
  assert.deepEqual(v.printedNumberForms('12500'), ['12,500.00', '$12,500.00', '12,500', '$12,500']);
  assert.deepEqual(v.printedNumberForms('45.5'), ['45.50', '$45.50']);
  for (const x of ['250', 'PA-PA-01-26-0746728', '', null, '1/2/2026']) assert.deepEqual(v.printedNumberForms(x), [], String(x));
  const { linked } = run([textCheck('R5', 'Appraisal Amount')]);
  assert.equal(pdf.evaluateRequirements(linked, 'Appraisal amount: $2,450.00', {})[0].result, 'PASS');
  assert.equal(pdf.evaluateRequirements(linked, 'Appraisal amount: $2,540.00', {})[0].result, 'FAIL');
});
