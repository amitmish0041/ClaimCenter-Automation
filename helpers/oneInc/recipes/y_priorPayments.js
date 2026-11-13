/**
 * helpers/oneInc/recipes/y_priorPayments.js — cases whose precondition is an EARLIER payment in a given state, built on the
 * case's own fresh claim by helpers/oneInc/priorPayments.js (added 2026-11-12; until then NEEDS_DATA — no TEST claim had
 * the state). Every case submits TEST payments (ONEINC_ALLOW_FINISH=1). Replaces 787 TC-011 of recipes/void787.js (same
 * steps, now on a fresh claim through the shared builder).
 *
 * NOT YET RUN END TO END — written while every TEST payment was refused ("Exposure owner … must have a valid examiner
 * number", 2026-11-12 from ~2 PM). Verify on the first run once payments work again.
 */
'use strict';

module.exports = (api) => {
  const { add, V, VAL, FULL_PAYMENTS } = api;
  const pp = (fn, ...a) => ({ call: [`priorPayments.${fn}`, ...a] });
  const op = (fn, ...a) => ({ call: [`checkOps.${fn}`, ...a] });

  // ── VBR.019 — a VOIDED First and Final does not count: a new First and Final on the same exposure is allowed ──────
  const FF = 'Builds a First and Final to a vendor on a new Adjuster Expense line of exposure (1) (a Claim Cost one is refused by PMS PL08 on fresh claims), waits for OneInc to issue it, voids it (Repost No) and waits for "Voided"; then';
  add('GCCM-763/VBR/TC-055', 'PRIOR_PA', VAL([pp('voidedFirstAndFinal'), ...FULL_PAYMENTS('vendor', 'new'), { select: ['Cost Type', 'Adjuster Expense'] }, { select: ['Exposure', /^\(1\)/] },
    { step2: { transactionType: 'First and Final', amount: '1.37' } }], null), [],
  `${FF} a $1.37 vendor First and Final on a new Adjuster Expense line of the same exposure must Finish with no error (TEST).`);
  add('GCCM-1003/VBR/TC-138', 'PRIOR_PA', VAL([pp('voidedFirstAndFinal'), pp('openQuickOnVoidedLine'), { step2: { transactionType: 'First and Final', amount: '1.37' } }], null), [],
    `${FF} a $1.37 First and Final Quick Payment on that exposure must Finish with no error (TEST).`);

  // ── VBR.022 — a REJECTED Final Payment does not count: a new Final Payment the same day is allowed ──────────────────
  const REJ = 'Builds a $1.4x Final Payment to the INSURED without the Secondary Named Insured (policy 1002231610), which CC holds "Pending approval" and has its approver Reject it (approver login, CC_TEAM_PASS passed inline); then';
  add('GCCM-763/VBR/TC-062', 'PRIOR_PA_SNI', VAL([pp('rejectedFinal'), ...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Final Payment', amount: '0.62' } }], null), [],
    `${REJ} a $0.62 Final Payment on the same exposure (Full Check) must Finish with no error (TEST).`);
  add('GCCM-1003/VBR/TC-145', 'PRIOR_PA_SNI', VAL([pp('rejectedFinal'), { open: 'quick', needOpenReserve: true }, { step2: { transactionType: 'Final Payment', amount: '0.63' } }], null), [],
    `${REJ} a $0.63 Final Payment Quick Payment on the same exposure must Finish with no error (TEST).`);

  // ── 787 VBR.002 — void refused while a Final Payment on the same line is not submitted yet ─────────────────────────
  const FINAL_DUE = /^refused.*Final Payment is not submitted yet for this reserve line/i;
  const VOID = [op('openVoid'), op('submitVoid', 'Automation test - final payment not submitted yet', 'No')];
  const CHECKS = [V('Void outcome', { value: FINAL_DUE }), pp('dropFinalDue')];
  const AWAIT = (cost) => `Issued Partial Payment and a Final Payment left "Awaiting submission" (Create Payment from the same row, not escalated) on the ${cost} line; voiding the Partial must be refused. Afterwards the Final is deleted.`;
  const PEND = (cost) => `${cost} line closed (Final ≤ $1 / the expense line's First and Final), an issued Supplemental on it, reserve added back, then a $1.4x Final Payment held "Pending approval"; voiding the Supplemental must be refused. Afterwards the Final is deleted.`;
  add('GCCM-787/TC/TC-011', 'PRIOR_PA', [pp('partialWithFinalAwaiting', 'claim cost'), ...VOID], CHECKS, AWAIT('Claim Cost'));
  add('GCCM-787/TC/TC-013', 'PRIOR_PA_SNI', [pp('supplementalWithFinalPending', 'claim cost'), ...VOID], CHECKS, PEND('Claim Cost'));
  // TC-012 / TC-014 (Expense line) stay manual — see caseReasons.js (no open expense reserve can be made on cloud TEST).

  // ── 1008 APD (UIF.001–032) — Mortgagee/lienholder payment, Monitored = Yes → Mailed Check ──────────────────────────
  // Same check as 1008 APD TC-010 (lienholder named on the vehicle loan, payee Type Lienholder/Mortgagee), now waited on
  // until OneInc issues it so the OneInc-fed fields and the Payment Feedback row (with "Monitored") are there.
  // TC-012 (Monitored = No, contact chose Direct Deposit) stays manual: the lienholder is a company and the OneInc payee
  // portal only completes for a person (project note "pay a person, not a company").
  add('GCCM-1008/APD/TC-011', 'AUTO_LIEN', [{ call: ['recipes/manualSweep.openNewCheck', { payee: 'lienholder', type: 'Lienholder/Mortgagee' }] }, pp('awaitIssued'),
    { call: ['portalChecks.noteField', 'ClaimsPay Method', 'Issued check ClaimsPay Method'] }, op('openAPD'), pp('feedbackValue', 'Monitored'), { call: ['portalChecks.showNotes'] }],
  [V('Issued check ClaimsPay Method', { value: /^Mailed Check$/i }), V('Monitored', { value: /^Yes$/i }), V('One Inc Payment Number', { value: /^\d+$/ }), V('CR Tracking Number', { value: /\S/ }), V('Additional Details'),
    V('Loan Number', { value: /\S/ }), V('Payment Amount', { value: /\$\s?\d/ }), V('Current Payment Status', { value: /issued/i })],
  'PA auto claim with a vehicle loan naming the lienholder: a $0.4x check to the lienholder (Type Lienholder/Mortgagee) is made, OneInc is waited on until it is Issued (Mailed Check), then Additional Payment Details is read — upper-section fields plus the Payment Feedback "Monitored" value.');
};
