/**
 * helpers/oneInc/recipes/y_qaUpdate1118.js — QA's workbook update of 2026-11-18 (green-marked cases in the updated
 * GCCM-1003 / GCCM-1013 test plans). Red-marked cases/steps are dropped by inventoryService (red Id/Name cell = case
 * row deleted, red step cell = step deleted). Loaded after the other recipe files, so each add() here replaces the
 * earlier recipe of that case. Mirrors the GCCM-763/799 changes of y_qaUpdate1111.js for the Quick Payment cases.
 */
'use strict';

module.exports = (api) => {
  const { add, R, V, VAL, FULL_PAYMENTS, QUICK_DETAILS, QCC, QOPEN_LIEN, PRIMARY } = api;
  const X = (fn, ...a) => ({ call: [`reuseExt.${fn}`, ...a] });
  const FINISH = X('finishObserve');
  const OUT = (re) => V('Finish outcome', { value: re });
  const SUBMITTED = OUT(/^submitted: check \d+/);
  const QA = ' (QA update 2026-11-18.)';

  // UIF.053 — Invoice Number/Remarks is now expected visible and not required.
  add('GCCM-1003/UIF/TC-068', 'AUTO_PA', QUICK_DETAILS(), [V('Invoice Number/Remarks', { required: false })], 'Quick Payment, Set Payment Details screen.' + QA);

  // UIF.040 — no TTD/TPD line items in the precondition any more: Medical (non lost-wages) line, question must be hidden.
  if (R['GCCM-1003/UIF/TC-053']) {
    const r = R['GCCM-1003/UIF/TC-053'];
    add('GCCM-1003/UIF/TC-053', r.profile, r.steps.slice(0, -1), r.checks, 'Medical (non lost-wages) exposure line, no line category chosen.' + QA);
  }

  // VBR.004 / VBR.005 — the rule goes by the Scheduled Send Date (today), not the service period.
  const SP = (end) => [{ fill: ['Service Period Start', 'DOL'] }, { fill: ['Service Period End', end] }];
  const LC50 = X('requireField', 'Cause of Loss', 'medical benefits', 'VBR.004 applies to exposures with Cause of Loss LC50 "Medical Benefits"');
  const MEDQ = (row, amount) => [X('openQuickOnRow', 'claim cost', 'open', row), ...SP('DOL+30'), { step2: { transactionType: 'Partial Payment', amount } }];
  add('GCCM-1003/VBR/TC-090', 'F_DE_LC50', [...MEDQ('Medical', '3.31'), LC50, FINISH], [OUT(/proper documentation/i)],
    'DE personal auto claim with DoL more than 2 years ago, Medical Benefits exposure (LC50): Scheduled Send Date (today) is 2+ years after the loss date. Quick Payment.' + QA);
  add('GCCM-1003/VBR/TC-091', 'QA_DE_LC50_NEW', [...MEDQ('Medical', '3.37'), LC50, FINISH], [SUBMITTED],
    'DE personal auto claim with a loss date inside the last 2 years, Medical Benefits exposure (LC50): no documentation warning. Quick Payment, submits $3.37 on TEST.' + QA);
  add('GCCM-1003/VBR/TC-094', 'QA_MD_MEDPAY', [...MEDQ('Medical Expense', '2.33'), FINISH], [OUT(/more than 3 years after the DOL/i)],
    'MD personal auto claim with DoL more than 3 years ago, Med Pay exposure ("1st Party Medical Expense"). Quick Payment.' + QA);

  // VBR.014 — First and Final on an exposure with no reserve history: allowed.
  const NORES = (transactionType, amount) => [...FULL_PAYMENTS('claimant', 'new'), { select: ['Cost Type', 'Claim Cost'] }, { select: ['Exposure', /Medical Expense/i] },
    { step2: { transactionType, amount, keepExposure: true } }, { call: ['setupA.fillRequired'] }];
  add('GCCM-1003/VBR/TC-124', 'QA_PA_NORES2', VAL(NORES('First and Final', '1.39'), null), [],
    'PA auto claim with a Medical Expense exposure that never had a reserve; First and Final on a new Claim Cost line of it (Quick Payment cannot open without a reserve row, so the Full Check line is used). Submits $1.39 on TEST.' + QA);

  // VBR.018 — claim-level payment: CC answers "Missing required field Exposure" for both transaction types.
  const CLAIM_LEVEL = (transactionType) => VAL([...FULL_PAYMENTS('claimant', 'new'), { select: ['Cost Type', 'Claim Cost'] }, { select: ['Exposure', /claim-level/i] },
    { step2: { transactionType, amount: '1.00', keepExposure: true } }], /Missing required field "?Exposure"?/i);
  const CL_NOTE = 'New line left at Exposure = none (claim level). Quick Payment opens only from an exposure row, so the Full Check line is used. ';
  add('GCCM-1003/VBR/TC-134', 'AUTO_PA', CLAIM_LEVEL('Partial Payment'), [], CL_NOTE + 'Partial Payment.' + QA);
  add('GCCM-1003/VBR/TC-135', 'AUTO_PA', CLAIM_LEVEL('First and Final'), [], CL_NOTE + 'First and Final.' + QA);

  // VBR.019 — second First and Final on the same exposure: either wording is accepted (at Next).
  add('GCCM-1003/VBR/TC-137', 'EX_FF_ACTIVE', VAL([...FULL_PAYMENTS('claimant', 'new'), { select: ['Cost Type', 'Claim Cost'] }, { select: ['Exposure', /^\(1\)/] },
    { step2: { transactionType: 'First and Final', amount: '1.41' } }],
  /Multiple First (&|and) Final not allowed on same exposure|First and Final payment not allowed with established reserve/i), [],
  'Existing claim whose exposure (1) already has a First and Final; a second one must be refused at Next.' + QA);

  // VBR.022 — second Final Payment: "Final Payment not allowed without open reserve".
  add('GCCM-1003/VBR/TC-144', 'AUTO_PA', VAL(QCC('Final Payment', '1.43', 'zero'), /Final Payment not allowed without open reserve/i), [],
    'Quick Payment Final Payment on a reserve line already closed by a Final Payment.' + QA);

  // VBR.030 — negative amount now answered with the line-item total mismatch at Next.
  add('GCCM-1003/VBR/TC-172', 'AUTO_PA', VAL(QCC('Partial Payment', '-50.00'), /does not match the total amount of the check|amount greater than \$0/i), [],
    'Quick Payment, Partial Payment of -$50.00.' + QA);

  // VBR.031 — expense payment, excluded Adjuster Number, expired Tax ID: no error, payment goes to pending approval.
  if (R['GCCM-1003/VBR/TC-176']) {
    const r = R['GCCM-1003/VBR/TC-176'];
    const steps = r.steps.slice();
    steps.splice(steps.length - 1, 0, { select: ['Adjuster Number', /^P0[123] |^M0[123] /] });
    // VAL puts { validate } last; insert the adjuster number just before it.
    add('GCCM-1003/VBR/TC-176', r.profile, steps, r.checks, (r.notes || '') + ' Adjuster Number P02 (P01 not offered on TEST; same exclusion list).' + QA);
  }

  // CPD.025 — mortgagee payee NOT linked to an Address Book contact.
  const CLAIM_MORT = require('../portalChecks').COMPANIES.claimMortgagee.name;
  add('GCCM-1003/CPD-Mortgagee/TC-249', 'PROP_MORT', [QOPEN_LIEN, ...PRIMARY({ who: CLAIM_MORT, type: 'Mortgagee' }), { step2: {} }, { next: true }, { expectStep: 2 }],
    [V('ClaimsPay Type', { value: /^other ?\/ ?mailed check$/i }) /* QA updated plan 2026-11-25: was Vendor */, V('ClaimsPay Method', { value: /^mailed check$/i })],
    `HO claim; Quick Payment to "${CLAIM_MORT}", a claim-only company with the Mortgagee role (not linked to the Address Book).` + QA);
  // ════ GCCM-1013 ════
  // UIF.078/079 — Cell Phone / Email of a joint payee whose Payment Contact Details are set, checked on Enter Payee Information.
  const JOINT_SNI = [{ open: 'full' }, { payee: 'insured' }, { select: ['Type', 'Insured'] }, { joint: [{ who: 'sni' }] }];
  const JN = 'HO claim: Full Check, Enter Payee Information; insured as payee and the Secondary Named Insured (Payment Contact Details set on every new test claim) added as joint payee.';
  add('GCCM-1013/UIF/TC-005', 'HO_SNI', JOINT_SNI, [{ text: { re: /Cell Phone/i, present: true } }], JN + ' Checked as text anywhere on the screen (joint-payee grid columns included).' + QA);
  add('GCCM-1013/UIF/TC-007', 'HO_SNI', JOINT_SNI, [{ text: { re: /E-?mail/i, present: true } }], JN + ' Checked as text anywhere on the screen (joint-payee grid columns included).' + QA);

  // UIF.080 — joint payee: Adverse Carrier (claim-only business) + an Address Book vendor; field on Step 3.
  const SUBRO = require('../portalChecks').COMPANIES.subroCarrier.name;
  add('GCCM-1013/UIF/TC-009', 'E_PA', [{ call: ['setupE.addRoleContact', 'attorney'] }, { open: 'full' }, { payee: SUBRO }, { select: ['Type', 'Adverse Carrier/Other Insurance Company'] }, { joint: [{ who: 'BAIKOW LEGAL LLC' }] },
    { next: true }, { reserve: 'open' }, { step2: {} }, { call: ['setupA.fillRequired'] }, { next: true }, { expectStep: 3 }],
  [V('Is this a Claim Payment to a Business?', { required: true, editable: true })],
  `New PA auto claim; payee "${SUBRO}" (business, type Adverse Carrier/Other Insurance Company) with an Address Book vendor as joint payee; Step 3 of 3.` + QA);

  // VBR.089 — Aggregate Limits warning at Step 2 (after the payment information is entered, Next).
  const sa = (fn, ...a) => ({ call: [`setupA.${fn}`, ...a] });
  const BI_PAY = [...FULL_PAYMENTS('claimant', 'match:3rd Party Bodily Injury'), { step2: { transactionType: 'Partial Payment', amount: String((1.5 + Math.floor(Math.random() * 40) / 100).toFixed(2)) } }];
  add('GCCM-1013/VBR/TC-090', 'AUTO_MD_AGED', [sa('setAggregateLimit', 100000), ...BI_PAY, { next: true }],
    [{ message: { re: /Please review Aggregate Limits/i, present: true } }, sa('closeWizard'), sa('setAggregateLimit', null)],
    'MD personal auto claim (existing): $100,000 Policy aggregate limit added (removed afterwards); claim cost payment on the third-party Bodily Injury exposure; warning read at Step 2 (Next pressed, no Finish).' + QA);
  // UIF.006 — Mailing Address editable only after "Do you want to edit the Mailing Address?" is ticked.
  add('GCCM-1003/UIF/TC-008', 'AUTO_PA', [...QUICK_DETAILS().slice(0, 1), { call: ['checkOps.toggle', 'Do you want to edit the Mailing Address?'] }],
    [V('Address 1', { editable: true }), V('City', { editable: true }), V('ZIP Code', { editable: true })], 'Quick Payment; the edit checkbox is ticked first, then the mailing address fields (Address 1 / City / ZIP) must be editable.' + QA);
  // UIF.027 — Benefit Offset Code mandatory once Disability Weekly Rate is entered on the payment.
  if (R['GCCM-1003/UIF/TC-035']) {
    const r = R['GCCM-1003/UIF/TC-035'];
    add('GCCM-1003/UIF/TC-035', r.profile, [...r.steps, { fill: ['Average Weekly Wage', '800.00'] }, { fill: ['Disability Weekly Rate', '500.00'] }], r.checks,
      (r.notes || '') + ' Average Weekly Wage 800 and Disability Weekly Rate 500 entered on the payment first.' + QA);
  }
  // UIF.061 — Reason for Check: on a payee with no default condition (claimant) it must be required and editable; the
  // lienholder (non total loss) payee gets it defaulted and read-only, which QA's 11/18 note says is expected.
  add('GCCM-1003/UIF/TC-077', 'AUTO_PA', QUICK_DETAILS(), [V('Reason for Check', { required: true, editable: true })],
    'Quick Payment to the claimant (no default condition), Set Payment Details screen.' + QA);
};
