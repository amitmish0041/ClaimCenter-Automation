/**
 * helpers/oneInc/profiles/payeeAccepted.js — claims whose OneInc payment a payee has already accepted / rejected on the
 * payee portal (scripts/oneIncPayeePrep.js builds them; the payee step is done by hand with the texted code). Ledger:
 * <TestData>/payee-prep-test.json. Each profile is ONE claim; the cases on it only read the check (read-only).
 */
'use strict';

const one = (label, claim) => ({ label, lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true, seed: [claim] });
module.exports = {
  PAYEE_DD: one('Payee accepted the OneInc payment as Direct Deposit ($1.71, 11/12)', 'PA-PA-01-26-0749339'),
  PAYEE_PAYPAL_VOIDED: one('Payee accepted as PayPal, then voided in ClaimCenter → OneInc Stopped ($1.81, 11/12)', 'PA-PA-01-26-0749343'),
  PAYEE_REJECTED: one('Payee rejected the OneInc payment ($1.86, 11/12)', 'PA-PA-01-26-0749347'),
  PAYEE_MAILED: one('Payee accepted as Physical (mailed) check ($1.85, 11/12)', 'PA-PA-01-26-0749346'),
  PAYEE_EXPEDITE: one('Expedited mailed check issued by OneInc ($1.88, 11/12)', 'PA-PA-01-26-0749349'),
};
