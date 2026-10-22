// Offline checks of the OneInc suite's building blocks — workbook parsing, Jira readiness, classification, check
// evaluation / roll-up and report summaries. No browser, ClaimCenter or Jira needed. Run with: npm run test:offline
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const inv = require('../../helpers/oneInc/inventoryService');
const jira = require('../../helpers/oneInc/jiraReadiness');
const { classify } = require('../../helpers/oneInc/classifier');
const { RECIPES } = require('../../helpers/oneInc/scenarioRecipes');
const runner = require('../../helpers/oneInc/scenarioRunner');
const report = require('../../helpers/oneInc/reportService');

const HDR = ['Test Case Id', 'Test Case Name', 'Description', 'Pre-condition', 'Step #', 'Step Description', 'Expected Result', 'Test Case Type', 'Test Case Status', 'Test Case Priority', 'Test Case Assigned To'];

test('a test case spans its Id row and the Id-less step rows after it', () => {
  const rows = [HDR,
    ['TC-001', 'Name A', 'Desc', 'Pre A', 1, 'Step one', '', 'Functional', 'New', 'High', ''],
    ['', '', '', '', 2, 'Step two', 'Expected two', '', '', '', ''],
    ['TC-002', 'Name B', '', '', 1, 'Only step', 'Exp B', 'Integration', 'New', '', '']];
  const cases = inv._test.parseCaseRows(rows);
  assert.equal(cases.length, 2);
  assert.equal(cases[0].steps.length, 2);
  assert.equal(cases[0].steps[1].expected, 'Expected two');
  assert.equal(cases[1].type, 'Integration');
  assert.ok(inv._test.isTcHeader(HDR));
});

test('sheet codes and story keys', () => {
  assert.equal(inv._test.sheetCodeOf('UIF.001-UIF.070'), 'UIF');
  assert.equal(inv._test.sheetCodeOf('CPD.016 - CPD.022-Leinholder'), 'CPD-Lienholder');
  assert.equal(inv._test.sheetCodeOf('Business Rules VBR.001-037'), 'VBR');
  assert.equal(inv._test.sheetCodeOf('INT.001 Test Cases New'), 'INT');
  assert.equal(inv._test.sheetCodeOf('INT.001 Test Cases'), 'INT-old');
  assert.equal(inv._test.storyKeyOf('GCCM-1003_CC_Test Design.xlsx'), 'GCCM-1003');
  assert.equal(inv._test.storyKeyOf('CC_OneInc_Part 2.xlsx', [['QA Test Design:', 'https://x/browse/GCCM-799']]), 'GCCM-799');
});

test('Jira summaries map to feature cards; readiness follows Dev + Test Execution status', () => {
  assert.deepEqual(jira._test.parseSummary('CC_Test Execution_OneInc_Payment validation rules part 1'), { kind: 'exec', feature: 'payment validation rules part 1' });
  assert.deepEqual(jira._test.parseSummary('CC_Development_OneInc_QuickCheck'), { kind: 'dev', feature: 'quickcheck' });
  assert.equal(jira._test.parseSummary('CC_Dev_OneInc_Parties Involved_ContactManager_Accelerator Updates ( CC & CM )').feature, 'parties involved_contactmanager_accelerator updates');
  assert.equal(jira._test.parseSummary('CC Cloud-Test-OneInc-Bug'), null);
  const R = jira._test.readinessOf;
  assert.equal(R({ dev: { status: 'In Progress' }, exec: { status: 'To Do' } }), 'DEV_PENDING');
  assert.equal(R({ dev: { status: 'Done' }, exec: { status: 'To Do' } }), 'DEV_DONE');
  assert.equal(R({ dev: { status: 'Done' }, exec: { status: 'Ready for QA' } }), 'READY');
  assert.equal(R({ dev: { status: 'Done' }, exec: null }), 'READY');
  assert.equal(R({}), 'UNKNOWN');
});

test('matchBugs links a failing field to a logged bug by its label', () => {
  const rd = { bugs: [{ key: 'GCCM-1255', status: 'Re-Open', open: true, summary: 'CC Cloud-Test-OneInc-Common UI-Total Amount of Payment-Value entered disappears' }] };
  assert.equal(jira.matchBugs(rd, ['Total Amount of Payment']).length, 1);
  assert.equal(jira.matchBugs(rd, ['VIN']).length, 0, 'labels under 6 chars are too ambiguous to match');
});

const tc = (over) => ({ scenarioId: 'X/Y/TC-1', story: 'GCCM-1', name: '', description: '', precondition: '', steps: [], supersededBy: null, ...over });

test('classification: recipe > superseded > dev pending > rule > manual default', () => {
  const someRecipeId = Object.keys(RECIPES)[0];
  assert.equal(classify(tc({ scenarioId: someRecipeId })).automation, 'AUTOMATED');
  assert.equal(classify(tc({ supersededBy: 'New sheet' })).automation, 'SUPERSEDED');
  const readiness = { stories: { 'GCCM-1': { readiness: 'DEV_PENDING', dev: { key: 'GCCM-2', status: 'In Progress' } } } };
  const c = classify(tc({ name: 'Webhook update' }), { readiness });
  assert.equal(c.automation, 'DEV_PENDING');
  assert.match(c.reason, /GCCM-2: In Progress/);
  assert.equal(classify(tc({ name: 'Payee is the Lienholder on the vehicle loan' })).automation, 'NEEDS_DATA');
  assert.equal(classify(tc({ name: 'Scheduled recurrence stored token' })).automation, 'MANUAL'); // user decision 2026-10-21
  assert.equal(classify(tc({ name: 'Something new' })).automation, 'MANUAL');
});

const screen = (fields, extra = {}) => ({ fields, headers: [], buttons: [], messages: [], south: '', nav: [], body: '', ...extra });
async function evalOne(item, s, state = { menuItems: [], warningSeen: null }) {
  const rows = [];
  await runner._test.evaluate(item, s, state, async (r) => rows.push(r));
  return rows[0];
}

test('field checks: visible/required/editable/options; a missing field is a FAIL flagged missing, or BLOCKED with unlessBlocked', async () => {
  const s = screen([{ label: 'Transaction Type', kind: 'select', required: true, readonly: false, options: ['<none>', 'Partial Payment', 'Final Payment'], value: '<none>' }]);
  assert.equal((await evalOne({ field: { label: 'Transaction Type', required: true, editable: true, includes: ['Partial Payment'] } }, s)).result, 'PASS');
  const miss = await evalOne({ field: { label: 'Transaction Type', includes: ['Supplemental Payment'] } }, s);
  assert.equal(miss.result, 'FAIL'); assert.equal(miss.missing, true);
  const gone = await evalOne({ field: { label: 'VIN' } }, s);
  assert.equal(gone.result, 'FAIL'); assert.equal(gone.missing, true);
  assert.equal((await evalOne({ field: { label: 'VIN', unlessBlocked: 'needs total loss' } }, s)).result, 'BLOCKED');
  assert.equal((await evalOne({ field: { label: 'Transaction Type', excludes: ['Final Payment'] } }, s)).result, 'FAIL');
});

test('absent / header / menu / nav / message checks', async () => {
  const s = screen([{ label: 'Claimant Number', kind: 'text', readonly: true }], {
    headers: ['Category', 'Amount'], nav: [{ label: 'CPChecks/Payments' }], messages: ['Transaction Type : PMS PL50 : Partial payment not allowed'] });
  assert.equal((await evalOne({ absent: { label: 'Claimant' } }, s)).result, 'PASS', 'absent is an exact label match');
  assert.equal((await evalOne({ header: { name: 'Comments', present: false } }, s)).result, 'PASS');
  assert.equal((await evalOne({ nav: { label: 'Checks/Payments', present: true } }, s)).result, 'PASS');
  assert.equal((await evalOne({ nav: { label: 'Checks', present: false, exact: true } }, s)).result, 'PASS');
  assert.equal((await evalOne({ message: { re: /PL50/, present: true } }, s)).result, 'PASS');
  const st = { menuItems: ['New Payment', 'Reserve'], warningSeen: null };
  assert.equal((await evalOne({ menu: { name: 'New Payment', present: true } }, s, st)).result, 'PASS');
  assert.equal((await evalOne({ menu: { name: 'Payment', present: false, exact: true } }, s, st)).result, 'PASS');
});

test('roll-up: no checks is never a PASS; FAIL beats BLOCKED beats PASS', () => {
  const r = (checks) => runner._test.rollUp({ checks, stepsExecuted: [] }, Date.now()).status;
  assert.equal(r([]), 'BLOCKED');
  assert.equal(r([{ result: 'PASS' }]), 'PASS');
  assert.equal(r([{ result: 'PASS' }, { result: 'BLOCKED', actual: 'x' }]), 'BLOCKED');
  assert.equal(r([{ result: 'BLOCKED', actual: 'x' }, { result: 'FAIL', description: 'd', expected: 'e', actual: 'a' }]), 'FAIL');
});

test('report summary: executed = PASS+FAIL+BLOCKED, pass % of executed; CSV escapes; run ids are timestamped', () => {
  const res = [{ status: 'PASS', story: 'S', automation: 'AUTOMATED' }, { status: 'FAIL', story: 'S', automation: 'AUTOMATED' },
    { status: 'BLOCKED', story: 'S', automation: 'AUTOMATED' }, { status: 'NOT EXECUTED', story: 'S', automation: 'MANUAL' }];
  const S = report.summarize(res);
  assert.equal(S.discovered, 4); assert.equal(S.executed, 3); assert.equal(S.passPct, 33.3); assert.equal(S.decidedPassPct, 50);
  const csv = report.toCsv([{ scenarioId: 'a', name: 'x, "y"', status: 'PASS', checks: [] }]);
  assert.match(csv, /"x, ""y"""/);
  assert.match(report.newRunId('test', new Date(2026, 9, 20, 9, 5, 7)), /^OneInc_20261020_090507_test$/);
});

test('every recipe points at a real test case (when the OneInc workbooks are on this machine)', { skip: !fs.existsSync(inv.ONEINC_DIR) }, () => {
  const ids = new Set(inv.loadInventory().cases.map((c) => c.scenarioId));
  assert.deepEqual(Object.keys(RECIPES).filter((k) => !ids.has(k)), []);
});

test('warnings-only pages: Validation Results "Warnings:" without "Errors:" press through; errors never do', () => {
  const W = require('../../helpers/oneInc/wizardDriver');
  const sc = (south, messages = []) => ({ south, messages });
  assert.equal(W.warningsOnly(sc('Validation Results Clear Warnings: At least one aggregate limit on this claim has been exceeded.')), true);
  assert.equal(W.warningsOnly(sc('Validation Results Clear Errors: Payee type for X must be vendor or other. Warnings: At least one aggregate limit on this claim has been exceeded.')), false);
  assert.equal(W.warningsOnly(sc('', ['Possible duplicate payment found'])), true, 'no worksheet: known warning text');
  assert.equal(W.warningsOnly(sc('', ['Transaction Type : PMS PL50 : Partial payment not allowed without open reserve'])), false);
  assert.equal(W.warningsOnly(sc('', ['Payees other than vendor should have the payment contact details set up on the parties involved.', 'Exposure : Missing required field "Exposure"'])), false);
  assert.equal(W.warningsOnly(sc('', [])), false, 'nothing shown is not a warnings page');
});

test('newest check: the last row of the amount in list (creation) order, incl. held-for-approval rows with no number', () => {
  const { pickCheck } = require('../../helpers/oneInc/reuseExt')._test;
  const { describeCheck } = require('../../helpers/oneInc/reuseExt');
  // Order as CC lists them on PA-MD-01-23-0742279 (2026-10-21): held, numbered, then held again.
  const rows = [
    { number: '', amount: '$2.39', status: 'Pending approval' },
    { number: '10000123', amount: '$1.37', status: 'Issued' },
    { number: '12830492', amount: '$2.39', status: 'Awaiting submission' },
    { number: '10000999', amount: '$1.37', status: 'Requesting' },
    { number: '', amount: '$2.39', status: 'Pending approval' },
  ];
  assert.equal(pickCheck(rows, '$1.37').number, '10000999');
  const held = pickCheck(rows, '2.39');
  assert.equal(held.pending, true, 'the newest $2.39 is the held one, not the older numbered check');
  assert.match(describeCheck(held), /^Pending approval — no check number yet \(\$2\.39\)$/);
  assert.match(describeCheck(pickCheck(rows, '1.37')), /^check 10000999 \(\$1\.37, Requesting\)$/);
  assert.equal(pickCheck(rows, '$9.99'), null);
});

test('payment recipes (run one at a time) include finishObserve steps, not only validate', () => {
  const { isPaymentRecipe } = runner;
  assert.equal(isPaymentRecipe({ steps: [{ open: 'quick' }, { validate: { expect: null } }] }), true);
  assert.equal(isPaymentRecipe({ steps: [{ open: 'quick' }, { call: ['reuseExt.finishObserve'] }] }), true);
  assert.equal(isPaymentRecipe({ steps: [{ click: 'Finish' }] }), true);
  assert.equal(isPaymentRecipe({ steps: [{ open: 'quick' }, { call: ['reuseExt.openQuickOnRow', 'expense'] }], checks: [{ field: { label: 'Amount' } }] }), false);
  const finishRecipes = Object.values(RECIPES).filter((r) => (r.steps || []).some((s) => s.call && /finishObserve/.test(s.call[0])));
  assert.ok(finishRecipes.every(isPaymentRecipe));
});
