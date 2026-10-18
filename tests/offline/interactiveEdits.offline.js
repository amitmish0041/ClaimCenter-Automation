// Offline checks of the interactive-edit values and of how edits are verified in the completed PDF.
// Run with: npm run test:offline
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _test: v } = require('../../helpers/smartComm/validationService');

// No DIG number: skips the Data Dictionary lookup (that file only exists on the team's machines).
const field = (text, extra = {}) => ({ text, stripped: text.replace(/^\[+/, '').replace(/\]+$/, '').trim(), ...extra });
const edit = (text, all = [text], extra) => v.buildEditValue(field(text, extra), 7, undefined, all);

test('a field with a value is edited to that value + "-edited"', () => {
  assert.equal(edit('John Smith'), 'John Smith-edited');
  assert.equal(edit('PA-123456'), 'PA-123456-edited');
  assert.equal(edit('[Jane Doe]'), 'Jane Doe-edited', 'editor brackets are not part of the value');
});

test('trailing punctuation stays at the end', () => {
  assert.equal(edit('Smith,'), 'Smith-edited,');
  assert.equal(edit('John Smith.'), 'John Smith-edited.');
  assert.equal(edit('Hello!?'), 'Hello-edited!?');
});

test('empty or placeholder fields keep QA-EDIT-n', () => {
  for (const t of ['--<<Editable Field>>--', '____', '20__', '-', '']) assert.equal(edit(t), 'QA-EDIT-7', JSON.stringify(t));
});

test('checkboxes are untouched: an empty box gets "X", a lone "X" keeps the old marker', () => {
  assert.equal(edit('[ ]'), 'X');
  assert.equal(edit('☐'), 'X');
  assert.equal(edit('X'), 'QA-EDIT-7');
});

test('"$" amounts keep 900+n', () => {
  assert.equal(edit('1500', ['1500'], { labelContext: 'in the amount of $' }), '907');
});

test('values the checks could confuse keep QA-EDIT-n', () => {
  assert.equal(edit('Vehicle', ['Vehicle', 'Vehicle']), 'QA-EDIT-7', 'same value on two fields');
  assert.equal(edit('Smith', ['Smith', 'John Smith']), 'QA-EDIT-7', 'ends another field\'s value');
  assert.equal(edit('John Smith', ['Smith', 'John Smith']), 'John Smith-edited', 'the longer one is still distinct');
  assert.equal(edit('Smith', ['Smith,', 'Smith']), 'QA-EDIT-7', 'same value apart from punctuation');
  assert.equal(edit('Smith,', ['Smith,', 'Smith']), 'QA-EDIT-7');
  assert.equal(edit('Vehicle [2]'), 'QA-EDIT-7', 'brackets inside the value');
  assert.equal(edit('A'.repeat(81)), 'QA-EDIT-7', 'over 80 characters');
  assert.equal(edit('Claimant Name-edited'), 'QA-EDIT-7', 'already carries a test edit');
  assert.equal(edit('Smithson', ['Smithson', 'Smith']), 'Smithson-edited', '"Smith" is not a whole-word ending of "Smithson"');
});

const check = (id, before, marker, extra = {}) => ({
  id: `INT${id}`, idx: id, label: `field ${id}`, before, after: marker, committedMarker: marker,
  observedChanged: true, expectedEditable: true, technicalName: `t${id}`, dictionaryField: 'Some Field', dictionaryEditable: true, ...extra,
});

test('PDF check: "-edited" values are found even across a line break; a missing one FAILs', () => {
  const checks = [check(1, 'John Smith', 'John Smith-edited'), check(2, 'PA-123456', 'PA-123456-edited'), check(3, '--<<Editable Field>>--', 'QA-EDIT-3'), check(4, 'Jane Doe', 'Jane Doe-edited')];
  v.verifyInteractiveEditsInPdf(checks, 'Dear John Smith-\nedited, policy PA-123456-edited, QA-EDIT-3.', () => {});
  assert.deepEqual(checks.map((c) => c.verifiedInPdf), [true, true, true, false]);
  assert.equal(checks[3].result, 'FAIL');
});

test('PDF check: QA-EDIT-1 is not satisfied by QA-EDIT-10', () => {
  const checks = [check(1, '--<<Editable Field>>--', 'QA-EDIT-1'), check(10, '--<<Editable Field>>--', 'QA-EDIT-10')];
  v.verifyInteractiveEditsInPdf(checks, 'Only QA-EDIT-10 printed.', () => {});
  assert.deepEqual(checks.map((c) => c.verifiedInPdf), [false, true]);
});
