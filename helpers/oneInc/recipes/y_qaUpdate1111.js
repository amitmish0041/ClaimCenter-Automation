/**
 * helpers/oneInc/recipes/y_qaUpdate1111.js — QA's workbook update of 2026-11-11 (the green-marked cases in the updated
 * GCCM-763 / GCCM-799 / GCCM-803 test plans; no test case was marked red). Loaded after the other recipe files, so each
 * add() here replaces the earlier recipe of that case. Claim profiles: profiles/qaUpdate1111.js.
 */
'use strict';

module.exports = (api) => {
  const { add, V, VAL, FULL_PAYMENTS, NEW_LINE, CC, MORT_FULL, JOINT_FULL, INS, LIEN, JOINT_NOTE } = api;
  const X = (fn, ...a) => ({ call: [`reuseExt.${fn}`, ...a] });
  const FINISH = X('finishObserve');
  const OUT = (re) => V('Finish outcome', { value: re });
  const SUBMITTED = OUT(/^submitted: check \d+/);
  const QA = ' (QA update 2026-11-11.)';

  // ════ GCCM-763 VBR.004 — DE, Cause of Loss LC50: the rule goes by the Scheduled Send Date (today), not the service period ══
  const SP = (end) => [{ fill: ['Service Period Start', 'DOL'] }, { fill: ['Service Period End', end] }];
  const LC50 = X('requireField', 'Cause of Loss', 'medical benefits', 'VBR.004 applies to exposures with Cause of Loss LC50 "Medical Benefits"');
  const MED_FULL = (end, amount) => [...FULL_PAYMENTS('claimant', 'match:Medical'), ...SP(end), { step2: { transactionType: 'Partial Payment', amount } }, LC50];
  add('GCCM-763/VBR/TC-008', 'F_DE_LC50', [...MED_FULL('DOL+365', '3.13'), FINISH], [OUT(/proper documentation/i)],
    'DE personal auto claim PMF-DE-01-25-0746339 (DoL 09/15/2024), Medical Benefits exposure with Cause of Loss LC50: the Scheduled Send Date (today) is more than 2 years after the loss date; the service period ends inside the 2 years.' + QA);
  add('GCCM-763/VBR/TC-009', 'QA_DE_LC50_NEW', [...MED_FULL('DOL+30', '3.17'), FINISH], [SUBMITTED],
    'DE personal auto claim with a loss date inside the last 2 years, Medical Benefits exposure with Cause of Loss LC50 (PMF-DE-01-25-0746301, DoL 07/27/2025): the Scheduled Send Date (today) is before loss date + 2 years, so no documentation warning. Submits $3.17 on TEST.' + QA);

  // ════ GCCM-763 VBR.005 — MD, Med Pay exposure, claim older than 3 years ════════════════════════════════════════════
  add('GCCM-763/VBR/TC-012', 'QA_MD_MEDPAY', [...FULL_PAYMENTS('claimant', 'match:Medical Expense'), ...SP('DOL+30'), { step2: { transactionType: 'Partial Payment', amount: '2.31' } }, FINISH],
    [OUT(/more than 3 years after the DOL/i)], 'MD personal auto claim PA-MD-01-23-0742279 (DoL 09/11/2023, more than 3 years ago): claim cost payment from the Medical Payments (Med Pay) coverage exposure — ClaimCenter names it "1st Party Medical Expense".' + QA);

  // ════ Exposure with NO reserve history — a Medical Expense exposure left unreserved (profiles QA_PA_NORES*) ════════
  const NORES = (transactionType, amount) => [...FULL_PAYMENTS('claimant', 'new'), { select: ['Cost Type', 'Claim Cost'] }, { select: ['Exposure', /Medical Expense/i] },
    { step2: { transactionType, amount, keepExposure: true } }, { call: ['setupA.fillRequired'] }]; // medical lines need a Memo Phrase before Next
  const NORES_NOTE = 'New PA auto claim with a "Medical Expense" exposure that never had a reserve (vehicle exposures are reserved automatically on TEST, this one is not). Full Check, new "Expense OR First and Final" line, Cost Type Claim Cost, on that exposure. ';
  add('GCCM-763/VBR/TC-038', 'QA_PA_NORES', VAL(NORES('Supplemental Payment', '1.37'), /Invalid supplemental payment|Supplemental payments allowed only with closed reserve/i), [],
    NORES_NOTE + 'Supplemental Payment: must be refused.' + QA);
  add('GCCM-803/TC/TC-015', 'QA_PA_NORES', VAL(NORES('Supplemental Payment', '1.00'), /Transaction Type must be first and final/i), [],
    NORES_NOTE + 'Supplemental Payment on the new Claim Cost line: must be refused with the VBR.027 text.' + QA);
  add('GCCM-763/VBR/TC-041', 'QA_PA_NORES2', VAL(NORES('First and Final', '1.37'), null), [], NORES_NOTE + 'First and Final: no error. Submits $1.37 on TEST.' + QA);
  add('GCCM-803/TC/TC-016', 'QA_PA_NORES3', VAL(NORES('First and Final', '1.00'), null), [], NORES_NOTE + 'First and Final: no error; the check can be completed. Submits $1.00 on TEST.' + QA);

  // ════ GCCM-763 VBR.018 — claim-level line: CC answers with the required-field text for both transaction types ═══════
  const CLAIM_LEVEL = (transactionType) => VAL([...FULL_PAYMENTS('claimant', 'new'), { select: ['Cost Type', 'Claim Cost'] }, { select: ['Exposure', /claim-level/i] },
    { step2: { transactionType, amount: '1.00', keepExposure: true } }], /Missing required field "?Exposure"?/i);
  add('GCCM-763/VBR/TC-051', 'AUTO_PA', CLAIM_LEVEL('Partial Payment'), [], 'New line left at Exposure = none (Claim-level), Partial Payment.' + QA);
  add('GCCM-763/VBR/TC-052', 'AUTO_PA', CLAIM_LEVEL('First and Final'), [], 'New line left at Exposure = none (Claim-level), First and Final.' + QA);

  // ════ GCCM-763 VBR.019 — second First and Final on the same exposure: either wording is accepted ═══════════════════
  add('GCCM-763/VBR/TC-054', 'EX_FF_ACTIVE', VAL([...FULL_PAYMENTS('claimant', 'new'), { select: ['Cost Type', 'Claim Cost'] }, { select: ['Exposure', /^\(1\)/] },
    { step2: { transactionType: 'First and Final', amount: '1.37' } }],
  /Multiple First (&|and) Final not allowed on same exposure|First and Final payment not allowed with established reserve/i), [],
  'Existing claim whose exposure (1) already has an active First and Final; a second First and Final on a new Claim Cost line of that exposure must be refused at Next (either of the two texts QA lists).' + QA);

  // ════ GCCM-763 VBR.022 — second Final Payment on the same exposure ════════════════════════════════════════════════
  // The first Final Payment is the one that closes the reserve line (checkOps.closeReserveLine, added for fresh claims).
  add('GCCM-763/VBR/TC-061', 'AUTO_PA', VAL(CC('Final Payment', '1.37', 'zero'), /Final Payment not allowed without open reserve/i), [],
    'A Final Payment closes the reserve line first; a second Final Payment on the same line must be refused (cloud text: "PMS PL50 : Final payment not allowed without open reserve for its reseveline").' + QA);

  // ════ GCCM-803 VBR.030 — $0 on a new Claim Cost line, Supplemental Payment ════════════════════════════════════════
  add('GCCM-803/TC/TC-027', 'AUTO_PA', VAL([...NEW_LINE('Claim Cost'), { step2: { transactionType: 'Supplemental Payment', amount: '0.00' } }], /amount greater than \$0/i), [],
    'New "Expense OR First and Final" line, Cost Type Claim Cost, Supplemental Payment, amount $0.' + QA);

  // ════ GCCM-803 VBR.031 — expense payment to a payee whose Tax ID Valid Until is today (still valid) ════════════════
  const NAME = 'TAYLOR REPORTING SERVICE';
  const TAX = '58-2338930';
  add('GCCM-803/TC/TC-031', 'AUTO_PA', VAL([{ call: ['contactManager.setTaxValidUntil', NAME, TAX, 'today'] }, { open: 'full' }, X('selectVendorByTaxId', 'TAYLOR REPORTING', TAX), { next: true },
    { reserve: 'new' }, { select: ['Cost Type', 'Adjuster Expense'] }, { step2: { transactionType: 'First and Final', amount: '1.37' } }], null), [{ call: ['contactManager.restoreVendors'] }],
  `Setup: ContactManager vendor ${NAME} (${TAX}) Tax ID Valid Until set to today (the present date) and restored to its original value (blank) afterwards. Expense payment, so the claim-cost rule must not fire. Submits $1.37.` + QA);

  // ════ GCCM-799 UIF.037 — Benefit Offset Code is mandatory once Disability Weekly Rate is entered on the payment ════
  const BASE_EXPO = { 'Average Weekly Wage': '800.00', 'Disability Weekly Rate': '500.00', 'Disability Type': 'TTD', 'Benefit Offset Code': 'None', 'Reason TTD or TPD Ended': '<none>' };
  const OFFSETS = ['Employer-Paid Disability Plan', 'Multiple Offsets apply', 'Retirement Plan', 'Social Security Disability Insurance', 'Social Security Retirement', 'Unemployment Insurance'];
  add('GCCM-799/UIF/TC-018', 'WCA_LW', [{ call: ['setupA.setIndemnityExposure', BASE_EXPO] }, { open: 'full' }, { payee: 'claimant' }, { next: true }, { select: ['Reserve Line', /Indemnity/] },
    { select: ['Transaction Type', 'Partial Payment'] }, { call: ['setupA.selectLineCategory', '^05'] }, { fill: ['Average Weekly Wage', '800.00'] }, { fill: ['Disability Weekly Rate', '500.00'] }],
  [V('Benefit Offset Code', { required: true, editable: true, includes: OFFSETS })],
  'WC claim with a Lost Time severity: payment on the Indemnity (Lost Wages) line, TTD line category (05); Average Weekly Wage 800 and Disability Weekly Rate 500 are entered on the payment before the field is checked.' + QA);

  // ════ UIF.029 — PA Tort Code: PA auto, Bodily Injury Liability exposure whose Tort Option is not Undetermined ═════════
  const TORT = [V('PA Tort Code', { required: true, editable: true })];
  const TORT_NOTE = 'New PA auto claim with a Bodily Injury Liability exposure (Cause of Loss Bodily Injury Liability), Tort Option Full Tort, and a reserve; the payment is made from the line of that exposure. ';
  add('GCCM-799/UIF/TC-006', 'QA_PA_TORT', FULL_PAYMENTS('claimant', 'match:Bodily Injury'), TORT, TORT_NOTE + 'Full Check, payment information step.');
  add('GCCM-1003/UIF/TC-024', 'QA_PA_TORT', [X('openQuickOnRow', 'claim cost', 'any', 'Bodily Injury')], TORT, TORT_NOTE + 'Quick Payment opened from that reserve line.');

  // ════ GCCM-799 CPD.025 — mortgagee-only payee that is NOT linked to an Address Book contact ════════════════════════
  const CLAIM_MORT = require('../portalChecks').COMPANIES.claimMortgagee.name;
  add('GCCM-799/CPD-Mortgagee/TC-78', 'PROP_MORT', MORT_FULL({ who: CLAIM_MORT, type: 'Mortgagee' }, []),
    [V('ClaimsPay Type', { value: /^vendor$/i }), V('ClaimsPay Method', { value: /^mailed check$/i })],
    `HO claim; mortgagee-only check. Payee = "${CLAIM_MORT}", a claim-only company with the Lienholder/Mortgagee role (NOT linked to the Address Book), payee Type Mortgagee.` + QA);

  // ════ GCCM-799 CPD.026 — 3 or more payees; the insured has payment contact details ═════════════════════════════════
  add('GCCM-799/CPD-Joint/TC-79', 'AUTO_LIEN', JOINT_FULL(INS, [{ who: 'other', type: 'Other' }, LIEN]),
    [V('ClaimsPay Type', { value: /3 or more payees/i }), V('ClaimsPay Method', { value: /^mailed check$/i })],
    JOINT_NOTE + ' The insured has payment contact details (set on every new test claim). The "more than 200 characters in Pay to the order" step is checked by GCCM-1013 VBR TC-084 (the field stops at 150 characters on TEST).' + QA);
};
