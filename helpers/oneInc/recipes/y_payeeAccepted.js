/**
 * helpers/oneInc/recipes/y_payeeAccepted.js — cases judged on checks a payee accepted / rejected on the OneInc payee portal
 * (claims built by scripts/oneIncPayeePrep.js, payee steps done by hand 2026-11-12; profiles/payeeAccepted.js). Each case
 * finds the claim's payment on the OneInc staging portal, opens the ClaimCenter check and reads it. Read-only.
 */
'use strict';

module.exports = (api) => {
  const { add, V } = api;
  const pc = (fn, ...a) => ({ call: [`portalChecks.${fn}`, ...a] });
  const op = (fn, ...a) => ({ call: [`checkOps.${fn}`, ...a] });
  const OIC = (amount) => pc('oneIncCheck', { amount });
  const RO = ' Read-only.';

  // 787 INT.003 — PayPal check voided in ClaimCenter (Repost No) → OneInc Stopped → Voided + manual void/reissue activity.
  add('GCCM-787/TC/TC-025', 'PAYEE_PAYPAL_VOIDED', [OIC('1.81')],
    [V('OneInc Status', { value: /^Stopped$/i }), V('Check status', { value: /^Voided$/i }), V('Confirmed Payment Method', { value: /paypal/i }),
      op('workplan'), V('Workplan activities', { value: /final status of Voided|require.?manual.?void/i })],
    'Payee accepted the $1.81 payment as PayPal on the OneInc payee portal; the Issued check was then voided in ClaimCenter (Repost No) and OneInc answered Stopped. The require_manual_void activity reads "Reminder: payment … has reached its final status of Voided. Please take appropriate action."' + RO);

  // 787 INT.007 / 1013 UIF.085 — payee rejected the payment → Cancelled, Voided, digital_payment_cancel activity; ClaimsPay Comments.
  add('GCCM-787/TC/TC-029', 'PAYEE_REJECTED', [OIC('1.86')],
    [V('OneInc Status', { value: /^Cancelled$/i }), V('Check status', { value: /^Voided$/i }), op('workplan'), V('Workplan activities', { value: /payee rejected|reject/i })],
    'Payee rejected the $1.86 single-payee payment on the OneInc payee portal (Other reason: "incorrect info").' + RO);
  add('GCCM-1013/UIF/TC-018', 'PAYEE_REJECTED', [OIC('1.86')], [V('ClaimsPay Comments', { value: /\S/ })],
    'Check whose payee rejected it on the OneInc payee portal — OneInc returns the reject reason as ClaimsPay Comments.' + RO);

  // 1013 UIF.084 — Account Number on a Direct Deposit check.
  add('GCCM-1013/UIF/TC-016', 'PAYEE_DD', [OIC('1.71')], [V('Confirmed Payment Method', { value: /direct deposit/i }), V('Account Number', { value: /\S/ })],
    'Payee accepted the $1.71 payment as Direct Deposit (bank account) on the OneInc payee portal. OneInc HOLDS the account (portal 2026-11-12: Payment Method Last 4 3298, JPMORGAN CHASE BANK, Personal_Checking) — a blank Account Number in ClaimCenter is a ClaimCenter-side (feedback mapping) defect.' + RO);

  // 1013 UIF.089 / UIF.081 — print date / tracking number come back from OneInc once the mailed check is printed / shipped.
  add('GCCM-1013/UIF/TC-023', 'PAYEE_MAILED', [OIC('1.85')], [V('Check Print Date', { value: /\S/, unlessBlocked: 'OneInc has not reported a print date for this mailed check yet (it arrives once OneInc prints it)' })],
    'Payee accepted the $1.85 payment as a Physical (mailed) check on the OneInc payee portal; the print date arrives when OneInc prints it.' + RO);
  add('GCCM-1013/UIF/TC-011', 'PAYEE_EXPEDITE', [OIC('1.88')], [V('Expedite / Certified Tracking No.', { value: /\S/, unlessBlocked: 'OneInc has not reported a tracking number for this expedited check yet (it arrives once OneInc ships it)' })],
    'Mailed check with Payment Delivery = Expedite Mail, issued by OneInc; the tracking number arrives when OneInc ships it.' + RO);
};
