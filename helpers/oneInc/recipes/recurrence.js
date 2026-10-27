/**
 * helpers/oneInc/recipes/recurrence.js — recurring check sets. The Recurrence select (Single Payment / Weekly / Monthly) and the
 * Payment Date (scheduled send date) are on the Full Check wizard's Instructions step and on the Quick wizard's payment basics
 * step (found 2026-10-26). VBR.020: a recurring set on a WC claim may not be scheduled more than two years out; other lines may.
 * VBR.017: the future-date rule applies to non-recurring checks only. The cases that expect no error submit a $1.37 recurring
 * check set on TEST (Finish). CPD.007/008 (stored-token recurrences) need a token stored by OneInc and stay manual.
 */
'use strict';

module.exports = (api) => {
  const { add, VAL, FULL_PAYMENTS, QUICK_DETAILS } = api;
  const call = (fn, ...args) => ({ call: [`setupA.${fn}`, ...args] });
  const REQ = call('fillRequired'); // WC payments need a Memo Phrase before Next
  const NO_DENY = call('setClaimDenied', 'No');
  // Cloud words it "Recurring payments cannot be scheduled greater than 2 years from today's date" (2026-10-26); the case says "more than two years out".
  const TOO_FAR = /(more than two|greater than 2) years/i;
  // Full Check: Payees → Payments → Instructions, then the recurrence + date on the Instructions step.
  const FULL = (pre, recurrence, date) => [...pre, ...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Partial Payment', amount: '1.37' } }, REQ,
    { next: true }, { expectStep: 3 }, { select: ['Recurrence', recurrence] }, { fill: ['Payment Date', date] }];
  // Quick Payment: both fields are on the payment basics step.
  const QUICK = (pre, recurrence, date) => [...pre, ...QUICK_DETAILS({ transactionType: 'Partial Payment', amount: '1.37' }), REQ, { select: ['Recurrence', recurrence] }, { fill: ['Payment Date', date] }];
  const WC = [NO_DENY];
  const SUB = ' Submits a $1.37 recurring check set on TEST (Finish).';
  const NOTE_WC = 'Recurring check set on the automation WC claim (Claim Denied? = No).';
  // today + 2 years + 1 day ≈ 732 days (731 in a leap span); 735 is safely beyond, 400 safely inside.
  add('GCCM-763/VBR/TC-056', 'WCA_PA', VAL(FULL(WC, 'Weekly', 'TODAY+735'), TOO_FAR), [], NOTE_WC + ' Payment Date = today + 735 days.');
  add('GCCM-763/VBR/TC-057', 'WCA_PA', VAL(FULL(WC, 'Weekly', 'TODAY+400'), null), [], NOTE_WC + SUB);
  add('GCCM-763/VBR/TC-058', 'AUTO_PA', VAL(FULL([], 'Weekly', 'TODAY+1100'), null), [], 'Recurring check on a non-WC (PA auto) claim dated about 3 years out.' + SUB);
  add('GCCM-763/VBR/TC-050', 'AUTO_PA', VAL(FULL([], 'Monthly', 'TODAY+30'), null), [], 'Recurring check with a pay date 30 days out (VBR.017 applies to non-recurring only).' + SUB);
  add('GCCM-1003/VBR/TC-139', 'WCA_PA', VAL(QUICK(WC, 'Weekly', 'TODAY+735'), TOO_FAR), [], NOTE_WC + ' Quick Payment; Payment Date = today + 735 days.');
  add('GCCM-1003/VBR/TC-140', 'WCA_PA', VAL(QUICK(WC, 'Weekly', 'TODAY+400'), null), [], NOTE_WC + ' Quick Payment.' + SUB);
  add('GCCM-1003/VBR/TC-141', 'AUTO_PA', VAL(QUICK([], 'Weekly', 'TODAY+1100'), null), [], 'Quick recurring check on a non-WC claim about 3 years out.' + SUB);
  add('GCCM-1003/VBR/TC-133', 'AUTO_PA', VAL(QUICK([], 'Monthly', 'TODAY+30'), null), [], 'Quick recurring check with a pay date 30 days out.' + SUB);
};
