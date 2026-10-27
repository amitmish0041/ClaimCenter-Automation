/**
 * helpers/oneInc/recipes/void787.js — GCCM-787 OneInc Void/Stop (Amanda Hess, JRM feedback workbook, added 2026-10-27).
 *
 * The cases act on a "Requested" check (the only kind TEST lets you void — see helpers/oneInc/checkOps.js): the newest
 * one already on the claim, or a $1.4x Quick Payment made for the purpose. Voids are submitted only with
 * ONEINC_ALLOW_FINISH=1 (TEST), like Finish.
 *
 * Not automated (classifier reasons): TC-009 (needs a Cleared check), TC-011–TC-014 (a Final payment awaiting
 * submission / pending approval next to an issued partial or supplemental — see VBR002_NOTE), TC-017–TC-019 (needs a
 * digital_payment_failed_to_send activity), TC-021–TC-033 (OneInc has to issue the check and send a status back, which
 * never happens on TEST).
 */
'use strict';

module.exports = (api) => {
  const { add, V } = api;
  const op = (fn, ...args) => ({ call: [`checkOps.${fn}`, ...args] });
  const VOIDABLE = [op('ensureVoidableCheck'), op('openVoid')];
  const NOTE = 'Check used: the newest "Requested" check on an existing TEST claim (profile VOID_PA). Void is enabled only on Requested checks and a check reaches Requested only when OneInc acknowledges it, which never happens on TEST — so these cases cannot use a freshly created claim (documented exception to fresh test data).';
  const REPOST_Q = 'Are you reposting this check with the same check number?';
  // CC renders both instructional sentences as one read-only label under the question (CONFIRMED 2026-10-27).
  const LABEL_YES = /Answer "Yes" if you are moving the orig(i)?nal check \(same check number\) to a different exposure, claim, payment type, etc\./i;
  const LABEL_NO = /Answer "No" if you are issuing a check with a new check number, i\.e\. lost check, incorrect payee, etc\./i;
  const REPOST_ERR = /A Repost cannot be completed at this time\. A Payment must be in cleared status to repost/i;

  // UIF.001 — Reason for Void
  add('GCCM-787/TC/TC-001', 'VOID_PA', VOIDABLE, [V('Reason for Void', { required: true, editable: true }),
    { fill: ['Reason for Void', 'Issued in error'] }, V('Reason for Void', { value: /Issued in error/ }), op('cancelVoid')], NOTE + ' Nothing is voided (Cancel).');
  add('GCCM-787/TC/TC-002', 'VOID_PA', [...VOIDABLE, op('submitVoid', '', 'No')],
    [V('Void outcome', { value: /^refused.*Missing required field "Reason for Void"/i }), op('cancelVoid')], NOTE + ' Reason left blank, reposting = No; Void Payment pressed and its confirm accepted.');
  // UIF.002 — reposting question
  add('GCCM-787/TC/TC-003', 'VOID_PA', VOIDABLE, [V(REPOST_Q, { required: true, radios: ['Yes', 'No'] }),
    V('Reposting answer when the screen opens', { value: /none selected/i }), op('cancelVoid')],
    NOTE + ' The design asks for the On Prem default; Cloud opens the question with neither answer selected (recorded).');
  add('GCCM-787/TC/TC-004', 'VOID_PA', [...VOIDABLE, op('submitVoid', 'Automation test - reposting left blank', null)],
    [V('Void outcome', { value: /^refused.*(reposting.*required|required.*reposting)/i }), op('cancelVoid')], NOTE + ' Reason entered, reposting question left unanswered.');
  // UIF.003 / UIF.004 — instructional labels (read-only text on the Void Check screen)
  const SPELLING = ' The requirement spells "orignal"; Cloud shows "original" — accepted as the same label (BA to confirm the typo is not intended).';
  add('GCCM-787/TC/TC-005', 'VOID_PA', VOIDABLE, [{ text: { re: LABEL_YES, present: true } }, op('cancelVoid')], NOTE + SPELLING);
  add('GCCM-787/TC/TC-006', 'VOID_PA', VOIDABLE, [{ text: { re: LABEL_NO, present: true } }, op('cancelVoid')], NOTE);

  // VBR.001 — repost = Yes needs a Cleared check
  add('GCCM-787/TC/TC-007', 'VOID_PA', [...VOIDABLE, op('submitVoid', 'Automation test - repost on a non-cleared check', 'Yes')],
    [V('Void outcome', { value: new RegExp(`^refused.*${REPOST_ERR.source}`, 'i') })],
    NOTE + ' The design names an Issued check; no TEST check is ever Issued (OneInc does not respond on TEST), so the not-Cleared check used is "Requested". If CC accepts the void, the check is left Pending void.');
  add('GCCM-787/TC/TC-008', 'VOID_PA', [op('openCheck', { status: '^Pending void$' }), op('voidButtonState')],
    [V('Void button', { value: /^(disabled|not shown)/i })],
    'Check in "Pending void" status. CC disables Void on it, so the VBR.001 message itself can never be reached — the void is prevented (PASS), BA to confirm a disabled button satisfies "error is displayed".');
  add('GCCM-787/TC/TC-010', 'VOID_PA', [...VOIDABLE, op('submitVoid', 'Automation test - void, no repost', 'No')],
    [V('Void outcome', { value: /^void submitted/i }), { message: { re: REPOST_ERR, present: false } }], NOTE + ' Voids the check (status becomes Pending void).');

  // VBR.002 — Final payment pending on the reserve line
  // TC-011: a voidable Partial (Quick Payment, "Requested") and then a OneInc Final Payment on the SAME row (Financials
  // row › Create Payment opens the full wizard on the first open Claim Cost row, which is the row Quick Payment used),
  // left Awaiting submission (OneInc never takes it on TEST). Voiding the partial must be refused. Cleanup: the Final
  // payment check is deleted (reopens the line) and a reserve is added back if none is open.
  const FINAL_DUE = /^refused.*Final Payment is not submitted yet for this reserve line/i;
  add('GCCM-787/TC/TC-011', 'VOID_PA', [op('createQuickCheck', { txn: 'Partial Payment', requireVoidable: true }),
    { open: 'financials' }, { payee: 'claimant' }, { next: true }, { step2: { transactionType: 'Final Payment', amount: '1.37' } }, { validate: { expect: null } },
    op('ensureVoidableCheck', { create: false }), op('openVoid'), op('submitVoid', 'Automation test - final payment awaiting submission', 'No')],
  [V('Void outcome', { value: FINAL_DUE }), op('openCheck', { status: '^(Requesting|Awaiting submission)$', amount: '1.37' }), op('deleteCheck'), op('ensureOpenReserve')],
  'Creates a $1.4x Partial Quick Payment (voidable "Requested" check) and a $1.37 Final Payment (OneInc, stays Awaiting submission on TEST) on the same Claim Cost row, then voids the partial. Afterwards the Final payment check is deleted and a reserve added back if the line is closed.');
  add('GCCM-787/TC/TC-015', 'VOID_PA', [op('createQuickCheck', { txn: 'Final Payment', requireVoidable: true }), op('ensureVoidableCheck', { create: false }), op('openVoid'),
    op('submitVoid', 'Automation test - void of a Final payment', 'No')],
  [V('Void outcome', { value: /^void submitted/i }), { message: { re: /Final Payment is not submitted yet/i, present: false } }, op('ensureOpenReserve')],
  'Creates a $1.4x Final Payment (Quick Payment, so it is a voidable "Requested" check) and voids it; afterwards a $1,000 Claim Cost reserve is added back if the Final Payment closed the only open line.');
  add('GCCM-787/TC/TC-016', 'VOID_PA', [op('createQuickCheck', { txn: 'Partial Payment', requireVoidable: true }), op('ensureVoidableCheck', { create: false }), op('openVoid'),
    op('submitVoid', 'Automation test - void of a Partial payment', 'No')],
  [V('Void outcome', { value: /^void submitted/i }), { message: { re: /Final Payment is not submitted yet/i, present: false } }],
  'Creates a $1.4x Partial Payment (Quick Payment) on a line with no Final payment awaiting submission or pending approval, and voids it.');

  // VBR.003 — the void must not auto-complete unrelated activities
  add('GCCM-787/TC/TC-020', 'VOID_PA', [op('snapshotActivities'), ...VOIDABLE, op('submitVoid', 'Automation test - activity check', 'No')],
    [V('Void outcome', { value: /^void submitted/i }), op('activitiesClosedSince'), V('Open activities no longer open', { value: /^none$/i })],
    NOTE + ' Open Workplan activities are read before and after the void; none may have been completed by it.');
};
