// Offline checks of how a scenario's checks roll up to PASS / FAIL / BLOCKED, and of the BLOCKED rows that stand in
// for checks that couldn't run. Run with: npm run test:offline
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _test: v } = require('../../helpers/smartComm/validationService');

const row = (result, id = 'R1') => ({ id, description: id, result });

test('PASS needs at least one check that actually ran', () => {
  assert.equal(v.rollUpScenario([row('PASS')], undefined).status, 'PASS');
  const allSkipped = [row('SKIPPED'), row('SKIPPED', 'R2')];
  const r = v.rollUpScenario(allSkipped, undefined);
  assert.equal(r.status, 'BLOCKED', 'all-skipped used to read PASS');
  assert.equal(allSkipped.at(-1).id, 'NOCHECK0');
  const none = [];
  assert.equal(v.rollUpScenario(none, []).status, 'BLOCKED', 'no checks at all used to read PASS');
  assert.equal(none.length, 1);
});

test('editable-field results count as checks that ran, and their FAILs fail the scenario', () => {
  assert.equal(v.rollUpScenario([row('SKIPPED')], [{ result: 'PASS' }]).status, 'PASS');
  assert.equal(v.rollUpScenario([row('PASS')], [{ result: 'FAIL' }]).status, 'FAIL');
});

test('FAIL beats BLOCKED beats PASS; counts are right', () => {
  const r = v.rollUpScenario([row('PASS'), row('BLOCKED', 'R2'), row('FAIL', 'R3'), row('SKIPPED', 'R4')], undefined);
  assert.deepEqual(r, { passed: 1, failed: 1, blocked: 1, skipped: 1, status: 'FAIL' });
  assert.equal(v.rollUpScenario([row('PASS'), row('BLOCKED', 'R2')], undefined).status, 'BLOCKED');
});

test('On-Demand templates (no editor session, interactiveChecks undefined) roll up without crashing', () => {
  assert.doesNotThrow(() => v.rollUpScenario([row('PASS')], undefined));
});

test('a layout-check crash becomes a BLOCKED LAYOUT0 row; a missing Word doc is still just "no layout checks"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-'));
  const docx = path.join(dir, 'x.docx');
  const notPdf = path.join(dir, 'x.pdf');
  fs.writeFileSync(docx, 'not a real docx');
  fs.writeFileSync(notPdf, 'not a real pdf');
  const rows = await v.runLayoutChecks({ docxPath: docx, pdfPath: notPdf, requirements: [], validations: [] }, () => {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'LAYOUT0');
  assert.equal(rows[0].result, 'BLOCKED');
  assert.deepEqual(await v.runLayoutChecks({ docxPath: path.join(dir, 'missing.docx'), pdfPath: notPdf }, () => {}), []);
});

test('a missing payload or filing metadata is BLOCKED, so the scenario can\'t read PASS', () => {
  const p = v.payloadUnavailableCheck();
  assert.equal(p.result, 'BLOCKED');
  assert.equal(v.rollUpScenario([row('PASS'), p], undefined).status, 'BLOCKED');
  const m = v.metadataUnavailableCheck('no "x.json" found');
  assert.equal(m.id, 'META1');
  assert.equal(m.result, 'BLOCKED');
  assert.equal(m.reason, 'no "x.json" found');
});
