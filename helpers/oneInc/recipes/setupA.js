/**
 * helpers/oneInc/recipes/setupA.js — "medium reuse" OneInc recipes that first put the claim/exposure into the test
 * case's state with helpers/oneInc/setupA.js (exposure/claim denial, …). Claims: the setup-A profiles in
 * helpers/oneInc/profiles/setupA.js (automation-owned, TEST). Added 2026-10-21.
 */
'use strict';

module.exports = (api) => {
  const { add, VAL, CC, EXP, QCC } = api;
  const call = (fn, ...args) => ({ call: [`setupA.${fn}`, ...args] });
  const FINISH = call('finishOnce');
  // After finishOnce: the rule's message is on the screen (wizard still open), or the wizard closed (submitted).
  const SHOWN = (re) => [{ message: { re, present: true } }];
  const NOT_SHOWN = (re) => [{ message: { re, present: false } }, { button: { name: 'Finish', present: false } }];

  // ── VBR.023 — no claim cost on an exposure whose Coverage Denied? = Denied in Full (non-WC) ─────────────────────
  const EXP_DENIED = /payment cannot be made because the exposure is denied|exposure is denied/i;
  const OWN = (who) => call('assignExposuresTo', who);
  const BEN = OWN('Benjamin Smith'); // Recovery Claims Team 2 — has an examiner number and full contact info
  const DEN = (v) => call('setExposureCoverageDenied', v);
  const REQ = call('fillRequired'); // WC payments need Memo Phrase etc. before Next (core step2 leaves it blank)
  const NOTE23 = 'Setup: Coverage Denied? set on every exposure of the automation PA auto claim (Exposure › Edit).';
  add('GCCM-803/TC/TC-001', 'AUTOA_PA', VAL([BEN, DEN('Denied in Full'), ...CC('Partial Payment', '1.37')], EXP_DENIED), [], NOTE23);
  add('GCCM-803/TC/TC-002', 'AUTOA_PA', VAL([BEN, DEN('No'), ...CC('Partial Payment', '1.37')], null), [], NOTE23 + ' Submits $1.37.');
  add('GCCM-803/TC/TC-003', 'AUTOA_PA', VAL([BEN, DEN('Denied in Full'), ...EXP('1.37')], null), [], NOTE23 + ' Expense to an Address Book vendor; submits $1.37.');
  add('GCCM-1003/VBR/TC-146', 'AUTOA_PA', VAL([BEN, DEN('Denied in Full'), ...QCC('Partial Payment', '1.37')], EXP_DENIED), [], NOTE23);
  add('GCCM-1003/VBR/TC-147', 'AUTOA_PA', VAL([BEN, DEN('No'), ...QCC('Partial Payment', '1.37')], null), [], NOTE23 + ' Submits a $1.37 Quick Payment.');

  // ── VBR.024 — no claim cost on a WC claim with Claim Denied? = Denied in Full ──────────────────────────────────
  const CLM_DENIED = /payment cannot be made because the claim is denied|claim is denied/i;
  const CDEN = (v) => call('setClaimDenied', v);
  const NOTE24 = 'Setup: Loss Details › Claim Denied? on the automation PA WC claim.';
  add('GCCM-803/TC/TC-004', 'WCA_PA', VAL([CDEN('Denied in Full'), ...CC('Partial Payment', '1.37'), REQ], CLM_DENIED), [], NOTE24);
  add('GCCM-803/TC/TC-005', 'WCA_PA', VAL([CDEN('No'), ...CC('Partial Payment', '1.37'), REQ], null), [], NOTE24 + ' Submits $1.37.');
  add('GCCM-803/TC/TC-006', 'WCA_PA', VAL([CDEN('Denied in Full'), ...EXP('1.37'), REQ], null), [], NOTE24 + ' Expense to an Address Book vendor; submits $1.37.');
  add('GCCM-1003/VBR/TC-149', 'WCA_PA', VAL([CDEN('Denied in Full'), ...QCC('Partial Payment', '1.37'), REQ], CLM_DENIED), [], NOTE24);
  add('GCCM-1003/VBR/TC-150', 'WCA_PA', VAL([CDEN('No'), ...QCC('Partial Payment', '1.37'), REQ], null), [], NOTE24 + ' Submits a $1.37 Quick Payment.');

  // ── VBR.028 — WC denied-in-part WARNING (Finish pressed once so the warning stays on screen) ───────────────────
  const PART = /Claim denied in part/i;
  const NOTE28 = NOTE24 + ' Finish pressed once (setupA.finishOnce) so a warning stays visible; with no warning the payment is submitted.';
  add('GCCM-803/TC/TC-018', 'WCA_PA', [CDEN('Denied in Part'), ...CC('Partial Payment', '1.37'), REQ, FINISH], SHOWN(PART), NOTE28);
  add('GCCM-803/TC/TC-019', 'WCA_PA', [CDEN('No'), ...CC('Partial Payment', '1.37'), REQ, FINISH], NOT_SHOWN(PART), NOTE28);
  add('GCCM-803/TC/TC-020', 'WCA_PA', [CDEN('Denied in Part'), ...EXP('1.37'), REQ, FINISH], NOT_SHOWN(PART), NOTE28);
  add('GCCM-1003/VBR/TC-163', 'WCA_PA', [CDEN('Denied in Part'), ...QCC('Partial Payment', '1.37'), REQ, FINISH], SHOWN(PART), NOTE28);
  add('GCCM-1003/VBR/TC-164', 'WCA_PA', [CDEN('No'), ...QCC('Partial Payment', '1.37'), REQ, FINISH], NOT_SHOWN(PART), NOTE28);

  // ── VBR.026 — exposure owner must have a valid examiner number ─────────────────────────────────────────────────
  // The admin's own group "Inactive Users" has no examiner number (CC: "Exposure owner Bill Folmar must have a valid
  // examiner number", CONFIRMED 2026-10-21); Benjamin Smith (Recovery Claims Team 2) has one.
  const EXAMINER = /Exposure owner .* must have a valid examiner number/i;
  const NOTE26 = 'Setup: exposures (re)assigned on the automation PA auto claim — Bill Folmar (Inactive Users, no examiner number) for the positive case, Benjamin Smith (Recovery Claims Team 2) for the negative.';
  add('GCCM-803/TC/TC-013', 'AUTOA_PA', VAL([OWN('Bill Folmar'), DEN('No'), ...CC('Partial Payment', '1.37')], EXAMINER), [], NOTE26);
  add('GCCM-803/TC/TC-014', 'AUTOA_PA', VAL([BEN, DEN('No'), ...CC('Partial Payment', '1.37')], null), [], NOTE26 + ' Submits $1.37.');
  add('GCCM-1003/VBR/TC-158', 'AUTOA_PA', VAL([OWN('Bill Folmar'), DEN('No'), ...QCC('Partial Payment', '1.37')], EXAMINER), [], NOTE26);
  add('GCCM-1003/VBR/TC-159', 'AUTOA_PA', VAL([BEN, DEN('No'), ...QCC('Partial Payment', '1.37')], null), [], NOTE26 + ' Submits a $1.37 Quick Payment.');

  // ── VBR.002 — exposure owner information complete (negative cases) ─────────────────────────────────────────────
  const NOTE02 = 'Exposure owner Benjamin Smith (First/Last name, email and work phone populated). Next on Step 2 must not raise the owner-information error; the payment is then finished (submits $1.37).';
  const OWNER_INFO = /Exposure owner .* is missing one or more of the following fields/i;
  add('GCCM-763/VBR/TC-005', 'AUTOA_PA', [BEN, DEN('No'), ...CC('Partial Payment', '1.37'), { next: true }, { expectStep: 3 }],
    [{ message: { re: OWNER_INFO, present: false } }], NOTE02.replace('; the payment is then finished (submits $1.37)', ''));
  add('GCCM-1003/VBR/TC-087', 'AUTOA_PA', VAL([BEN, DEN('No'), ...QCC('Partial Payment', '1.37')], null), [], NOTE02 + ' Quick Payment has 2 steps, so "Next on Step 2" is its Finish.');

  // ── CPD.032 — payee is a Business contact with the role Insured (commercial WC policy: insured is a company) ───
  const NOTE32 = 'Payee = the insured of the automation PA WC claim, a company (business contact with role Insured). Claim Denied? reset to No first; WC Memo Phrase filled.';
  const BIZ_STEPS_FULL = [CDEN('No'), { open: 'full' }, call('selectInsuredPayee'), { next: true }, { reserve: 'open' }, { step2: {} }, REQ, { next: true }, { expectStep: 3 }];
  const BIZ_STEPS_QUICK = [CDEN('No'), { open: 'quick', needOpenReserve: true }, call('selectInsuredPayee'), { step2: {} }, REQ, { next: true }, { expectStep: 2 }];
  const CONTACTS_CHOICE = [api.V('ClaimsPay Type', { value: /^contact\(s\)$/i }), api.V('ClaimsPay Method', { value: /customer choice|let customer pick/i })];
  add('GCCM-799/CPD-Joint/TC-86', 'WCA_PA', BIZ_STEPS_FULL, CONTACTS_CHOICE, NOTE32 + ' The PCON_Business / PCON_LastName payload values are integration-side and not checked here. ' + api.CPD_NOTE);
  add('GCCM-1003/CPD-Joint/TC-257', 'WCA_PA', BIZ_STEPS_QUICK, CONTACTS_CHOICE, NOTE32 + ' The PCON_Business / PCON_LastName payload values are integration-side and not checked here. ' + api.CPD_NOTE);
  add('GCCM-1003/UIF/TC-082', 'WCA_PA', BIZ_STEPS_QUICK, [...CONTACTS_CHOICE, api.V('Is this a Claim Payment to a Business?', { required: true })], NOTE32);

  // ── VBR.035 — aggregate limit warning (TXV08000, warning only; claim AUTOA_PA2) ───────────────────────────────────
  // Positive "exceeded" cases use a $1.00 Policy aggregate limit (the claim's incurred already exceeds it); the negative
  // "within remaining limit" cases a $100,000 limit. The stale-calculation cases (TC-041 / TC-186) cannot be forced from the UI.
  const AGG = (amt) => call('setAggregateLimit', amt);
  const AGG_RE = /aggregate/i;
  const NOTE35 = 'Setup: Policy › Aggregate Limits row (Policy / Limit / all incurred costs) on the automation claim; Finish pressed once (setupA.finishOnce) so the warning stays on screen; with no warning the payment is submitted.';
  add('GCCM-803/TC/TC-042', 'AUTOA_PA2', [BEN, AGG(1), ...CC('Partial Payment', '1.37'), FINISH], SHOWN(AGG_RE), NOTE35 + ' Limit $1.00 so the transaction exceeds it.');
  add('GCCM-803/TC/TC-043', 'AUTOA_PA2', [BEN, AGG(100000), ...CC('Partial Payment', '1.37'), FINISH], NOT_SHOWN(AGG_RE), NOTE35 + ' Limit $100,000 (current calculation).');
  add('GCCM-1003/VBR/TC-187', 'AUTOA_PA2', [BEN, AGG(1), ...QCC('Partial Payment', '1.37'), FINISH], SHOWN(AGG_RE), NOTE35 + ' Limit $1.00 so the transaction exceeds it.');
  add('GCCM-1003/VBR/TC-188', 'AUTOA_PA2', [BEN, AGG(100000), ...QCC('Partial Payment', '1.37'), FINISH], NOT_SHOWN(AGG_RE), NOTE35 + ' Limit $100,000 (current calculation).');

  // ── CPD.033 — claimant with a non-US address (WCA_PA claimant set to Toronto, Canada; restored to the US address after the checks) ──
  const MAILED_BOTH = [api.V('ClaimsPay Type', { value: /other\s*\/\s*mailed check/i }), api.V('ClaimsPay Method', { value: /^mailed check$/i })];
  const NONUS = call('setClaimantCountry', 'Canada');
  const RESTORE = call('setClaimantCountry', 'US');
  const NOTE33 = 'Setup: the claimant\'s address Country set to Canada (Parties Involved › Edit) and restored afterwards; payee = that claimant. ' + api.CPD_NOTE;
  add('GCCM-799/CPD-Joint/TC-87', 'WCA_PA', [NONUS, { open: 'full' }, { payee: 'claimant' }, { next: true }, { reserve: 'open' }, { step2: {} }, REQ, { next: true }, { expectStep: 3 }], [...MAILED_BOTH, RESTORE], NOTE33);
  add('GCCM-1003/CPD-Joint/TC-258', 'WCA_PA', [NONUS, { open: 'quick', needOpenReserve: true }, { payee: 'claimant' }, { step2: {} }, REQ, { next: true }, { expectStep: 2 }], [...MAILED_BOTH, RESTORE], NOTE33);

  // ── Quick Payment EXPENSE on a denied claim/exposure (negative: the denial rules are claim-cost only) ──────────────
  const QEXPENSE = [{ call: ['reuseExt.openQuickOnRow', 'expense', 'any'] }, { payee: 'vendor' }, { step2: { amount: '1.37' } }];
  const QEXP_NOTE = 'Quick Payment opened from the Adjuster Expense reserve row; payee = Address Book vendor; $1.37 submitted when no rule stops it.';
  add('GCCM-1003/VBR/TC-148', 'AUTOA_PA', VAL([BEN, DEN('Denied in Full'), ...QEXPENSE], null), [], NOTE23 + ' ' + QEXP_NOTE);
  add('GCCM-1003/VBR/TC-151', 'WCA_PA', VAL([CDEN('Denied in Full'), ...QEXPENSE, REQ], null), [], NOTE24 + ' ' + QEXP_NOTE);
  add('GCCM-1003/VBR/TC-165', 'WCA_PA', [CDEN('Denied in Part'), ...QEXPENSE, REQ, FINISH], NOT_SHOWN(PART), NOTE28 + ' ' + QEXP_NOTE);

  // ── VBR.002 positive — exposure owner with no email/phone (Jacob Erdman, jacoerdm) ─────────────────────────────────
  const JAC = call('assignExposuresTo', 'Jacob Erdman', 'Claims Automation Group');
  const NOTE02P = 'Setup: exposures assigned to Jacob Erdman (jacoerdm), whose user record has no email or phone. Next on Step 2 must raise the exposure-owner error.';
  // CC raises this error as soon as the payment is started (Full Check: on Next of Step 2; Quick Payment: the wizard refuses to open with
  // "New Payment Error"), so the closing check is that the message is on the screen.
  const TRY_QUICK = { call: ['reuseExt.tryOpenQuickOnRow', 'claim cost', 'any'] };
  add('GCCM-763/VBR/TC-004', 'AUTOA_PA', [JAC, DEN('No'), ...CC('Partial Payment', '1.37'), { next: true }],
    [{ message: { re: OWNER_INFO, present: true } }], NOTE02P);
  add('GCCM-1003/VBR/TC-086', 'AUTOA_PA', [JAC, DEN('No'), TRY_QUICK],
    [{ message: { re: OWNER_INFO, present: true } }], NOTE02P + ' Quick Payment shows it as a "New Payment Error" when the wizard is opened.');

  // ── VBR.025 / VBR.034 — expense payment to a claim-only contact (not in the Address Book, no Tax ID) ───────────────
  // Payee = the claimant (a claim contact, not an Address Book vendor). The message is whatever CC raises; a different text FAILs with the actual one.
  const PHIL = 'claimant';
  const PHIL_NEEDS = {};
  const QEXP_PHIL = [BEN, DEN('No'), { call: ['reuseExt.openQuickOnRow', 'expense', 'any'] }, { payee: PHIL }, { step2: { amount: '1.37' } }];
  const FEXP_PHIL = [BEN, DEN('No'), { open: 'full' }, { payee: PHIL }, { next: true }, { reserve: 'new' }, { select: ['Cost Type', 'Adjuster Expense'] },
    { step2: { transactionType: 'First and Final', amount: '1.37' } }];
  const NOT_IN_AB = /does not exist in the address book/i;
  const TAXID_REQ = /TaxId must be entered for Expense Payment/i;
  const NOTE25 = 'Payee = the claimant: a claim contact, not an Address Book vendor, no Tax ID.';
  add('GCCM-1003/VBR/TC-152', 'AUTOA_PA', VAL(QEXP_PHIL, NOT_IN_AB), [], NOTE25, PHIL_NEEDS);
  add('GCCM-803/TC/TC-007', 'AUTOA_PA', VAL(FEXP_PHIL, NOT_IN_AB), [], NOTE25, PHIL_NEEDS);
  add('GCCM-1003/VBR/TC-183', 'AUTOA_PA', VAL(QEXP_PHIL, TAXID_REQ), [], NOTE25, PHIL_NEEDS);
  add('GCCM-803/TC/TC-038', 'AUTOA_PA', VAL(FEXP_PHIL, TAXID_REQ), [], NOTE25, PHIL_NEEDS);

  // VBR.019 / VBR.022 (second First and Final / Final Payment on one exposure) are NOT automated: their precondition is an
  // earlier payment with status "Paid", which the UI cannot produce (payments stay "Awaiting submission"). Tried 2026-10-21:
  // a second expense First and Final ($1.38) was accepted while the first was "Awaiting submission", and a second Final Payment
  // is refused by PMS PL50 (no open reserve) before any "Multiple Final" rule — neither is a verdict on the rule.

  // ══ WC indemnity (Lost Wages) and Medicare / MSA payment fields — claim profile WCA_LW ══════════════════════════
  // WCA_LW claim: Severity "Lost Time" makes CC create an Indemnity exposure + $4,000 reserve; Medical exposure Medicare
  // tab "Is Claimant a Medicare Beneficiary?" = Yes (helpers/oneInc/setupA.js prepareLostWages). Each recipe re-applies
  // the Indemnity exposure state it needs (setIndemnityExposure is idempotent), so run order does not matter.
  const V = api.V;
  const BASE_EXPO = { 'Average Weekly Wage': '800.00', 'Disability Weekly Rate': '500.00', 'Disability Type': 'TTD', 'Benefit Offset Code': 'None', 'Reason TTD or TPD Ended': '<none>' };
  const EXPO = (extra = {}) => call('setIndemnityExposure', { ...BASE_EXPO, ...extra });
  const CAT = (re) => call('selectLineCategory', re);
  const LW_NOTE = 'WC claim with a Lost Time severity: Indemnity (Lost Wages) exposure with Average Weekly Wage 800 / Disability Weekly Rate 500 / Disability Type TTD; payment on the Indemnity reserve line, line category per the case.';
  // Full Check wizard on the Indemnity line / Quick Payment from the Indemnity row, line category chosen on the payment.
  const LW_FULL = (cat, { txn = 'Partial Payment', expo = {}, extra = [] } = {}) =>
    [EXPO(expo), { open: 'full' }, { payee: 'claimant' }, { next: true }, { select: ['Reserve Line', /Indemnity/] }, { select: ['Transaction Type', txn] }, CAT(cat), ...extra];
  const LW_QUICK = (cat, { txn = 'Partial Payment', expo = {}, extra = [] } = {}) =>
    [EXPO(expo), call('openQuickOnLine', /Indemnity/), { select: ['Transaction Type', txn] }, CAT(cat), ...extra];
  const OFFSETS = ['Employer-Paid Disability Plan', 'Multiple Offsets apply', 'Retirement Plan', 'Social Security Disability Insurance', 'Social Security Retirement', 'Unemployment Insurance'];
  const REASONS = ['1 - claimant returned to work', '2 - claimant released to return to work', '3 - maximum medical improvement reached', '4 - maximum statutory duration reached', '5 - medical non-compliance', '6 - all other'];
  const BASIS = ['Impairment percentage based on part of body', 'Impairment percentage based on the whole body'];
  const SSDI = { select: ['Benefit Offset Code', /Social Security Disability/] };
  const WHOLE = { select: ['Permanent % Basis code', /whole body/] };
  const BASIS_NOTE = ' CC offers 2 of the 3 typelist values (the "not based on impairment percentage" one is filtered out for WC, per the design note).';
  // [799 full id, 1003 quick id, category, options, checks, note]
  const LW_CASES = [
    ['GCCM-799/UIF/TC-018', 'GCCM-1003/UIF/TC-035', '^05', {}, [V('Benefit Offset Code', { required: true, editable: true, includes: OFFSETS })], ' Case precondition: exposure Disability Weekly Rate is set.'],
    ['GCCM-799/UIF/TC-019', 'GCCM-1003/UIF/TC-036', '^05', { extra: [SSDI] }, [V('Benefit Offset Weekly Amount', { required: true, editable: true })], ' Benefit Offset Code = Social Security Disability Insurance chosen first.'],
    ['GCCM-799/UIF/TC-020', 'GCCM-1003/UIF/TC-037', '^05', { txn: 'Final Payment' }, [V('Reason TTD or TPD Ended', { required: true, editable: true, includes: REASONS })], ' Final Payment (transaction type 22) with a TTD line.'],
    ['GCCM-799/UIF/TC-021', 'GCCM-1003/UIF/TC-038', '^05', { expo: { 'Reason TTD or TPD Ended': /^1/ } }, [V('Are temporary benefits resuming?', { required: true, radios: ['Yes', 'No'] })], ' Exposure "Reason TTD or TPD Ended" = 1 (not null).'],
    ['GCCM-799/UIF/TC-022', 'GCCM-1003/UIF/TC-039', '^03', {}, [V('MMI Date', { required: true, editable: true })], ' PPD scheduled line category (03).'],
    ['GCCM-799/UIF/TC-025', 'GCCM-1003/UIF/TC-040', '^03', {}, [V('Permanent % Basis code', { required: true, editable: true, includes: BASIS })], BASIS_NOTE],
    ['GCCM-799/UIF/TC-026', 'GCCM-1003/UIF/TC-041', '^03', { extra: [WHOLE] }, [V('Permanent Impairment %', { required: true, editable: true })], ' Permanent % Basis code = whole body chosen first.'],
  ];
  for (const [full, quick, cat, opt, checks, note] of LW_CASES) {
    add(full, 'WCA_LW', LW_FULL(cat, opt), checks, LW_NOTE + note);
    add(quick, 'WCA_LW', LW_QUICK(cat, opt), checks, LW_NOTE + note + ' Quick Payment "Enter payment basics" screen.');
  }
  // 799 UIF TC-014: Average Weekly Wage on the payment is offered on an Indemnity (Lost Wages) line only — the WC_PA claim
  // it ran on has none (BLOCKED 2026-10-27), so it runs on WCA_LW like the other indemnity cases (overrides scenarioRecipes).
  add('GCCM-799/UIF/TC-014', 'WCA_LW', LW_FULL('^05'), [V('Average Weekly Wage', { required: true, editable: true })], LW_NOTE + ' TTD line category (05).');
  // Quick Payment-only return-to-work questions (GCCM-1003 UIF.040-044)
  const RTW = 'Did the claimant return to work?';
  add('GCCM-1003/UIF/TC-052', 'WCA_LW', LW_QUICK('^05'), [V(RTW, { required: true, radios: ['Yes', 'No'] })], LW_NOTE);
  add('GCCM-1003/UIF/TC-053', 'WCA_LW', [EXPO(), call('openQuickOnLine', /Medical/), CAT('^(05|11)')], [api.H(RTW)],
    'Medical (non lost-wages) exposure line; needs a TTD/TPD line category (05/11), which the Medical line may not offer (then BLOCKED).');
  add('GCCM-1003/UIF/TC-054', 'WCA_LW', LW_QUICK('^05', { extra: [{ answer: [RTW, 'Yes'] }] }), [V('Date Returned to Work', { required: true, editable: true })], LW_NOTE + ' Return-to-work answered Yes. The "date before the loss date is blocked" half is not checked.');
  add('GCCM-1003/UIF/TC-055', 'WCA_LW', LW_QUICK('^05', { extra: [{ answer: [RTW, 'Yes'] }] }), [V('Return to Work Type Code', { required: true, editable: true, includes: ['Actual', 'Released'] })], LW_NOTE + ' Return-to-work answered Yes.');
  add('GCCM-1003/UIF/TC-056', 'WCA_LW', LW_QUICK('^05', { extra: [{ answer: [RTW, 'No'] }] }), [V('Has the claim been settled?', { required: true, radios: ['Yes', 'No'] })], LW_NOTE + ' Return-to-work answered No.');
  add('GCCM-1003/UIF/TC-057', 'WCA_LW', LW_QUICK('^05', { extra: [{ answer: [RTW, 'No'] }, { answer: ['Has the claim been settled?', 'Yes'] }] }), [V('What is the settlement date?', { required: true, editable: true })], LW_NOTE + ' Return-to-work No, settled Yes. The "date before the loss date is blocked" half is not checked.');

  // ── Medicare beneficiary / MSA payment fields (line category 49, Medicare = Yes on the claim) ─────────────────────
  const MS_NOTE = 'WC claim, Medical exposure "Is Claimant a Medicare Beneficiary?" = Yes; payment on the Indemnity (Lost Wages) reserve line with line category 49 (Lump Sum Indemnity and Medical).';
  const STRUCT = { select: ['Payout Indicator', /Structured/] };
  const MS_CASES = [
    // [799 id, 1003 id, extra steps, checks]
    ['GCCM-799/UIF/TC-041', 'GCCM-1003/UIF/TC-058', [], [V('Payout Indicator', { required: true, editable: true, includes: ['Structured/Annuity', 'Lump Sum'] })]],
    ['GCCM-799/UIF/TC-042', 'GCCM-1003/UIF/TC-059', [], [V('MSA Amount', { required: true, editable: true })]],
    ['GCCM-799/UIF/TC-043', 'GCCM-1003/UIF/TC-060', [], [V('MSA Period', { required: true, editable: true })]],
    ['GCCM-799/UIF/TC-044', 'GCCM-1003/UIF/TC-061', [STRUCT], [V('Initial Deposit Amount', { required: true, editable: true })]],
    ['GCCM-799/UIF/TC-045', 'GCCM-1003/UIF/TC-062', [STRUCT], [V('Annual Deposit Amount', { required: true, editable: true })]],
    ['GCCM-799/UIF/TC-046', 'GCCM-1003/UIF/TC-063', [], [V('Case Control Number', { editable: true, required: false })]],
    ['GCCM-799/UIF/TC-047', 'GCCM-1003/UIF/TC-064', [], [V('Professional Administrator EIN', { editable: true, required: false })]],
  ];
  for (const [full, quick, extra, checks] of MS_CASES) {
    add(full, 'WCA_LW', LW_FULL('^49', { extra }), checks, MS_NOTE);
    add(quick, 'WCA_LW', LW_QUICK('^49', { extra }), checks, MS_NOTE + ' Quick Payment "Enter payment basics" screen.');
  }
};
