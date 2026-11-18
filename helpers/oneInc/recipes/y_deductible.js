/**
 * helpers/oneInc/recipes/y_deductible.js — GCCM-1013 VBR.039 (deductible activities), automated 2026-11-18 once the
 * PolicyCenter harvest turned up WC policies carrying deductible endorsement WC 07 04 01 (profiles/deductible.js).
 * Same shape as GCCM-1013 VBR TC-044: a $1.00 Final Payment closes the Medical line, a Supplemental Payment goes on it,
 * the Financials Escalation batch moves the check to Requesting (admin login), then the Workplan is read.
 */
'use strict';

module.exports = (api) => {
  const { add, V, VAL, FULL_PAYMENTS } = api;
  const sa = (fn, ...a) => ({ call: [`setupA.${fn}`, ...a] });
  const op = (fn, ...a) => ({ call: [`checkOps.${fn}`, ...a] });
  const PAY = (txn, amount) => VAL([...FULL_PAYMENTS('claimant', 'match:Medical'), { step2: { transactionType: txn, amount } }, sa('fillRequired')], null);
  const DEDUCT = /Collect Deductible[\s\S]*Deductible Collected\?|Deductible Collected\?[\s\S]*Collect Deductible/i;
  const NO_DEDUCT = /^(?![\s\S]*(Collect Deductible|Deductible Collected\?))/i;
  const NOTE = 'New DE workers comp claim on a policy with deductible endorsement WC 07 04 01 (Marietta program; Deductible Status not Paid on a new claim). ';
  add('GCCM-1013/VBR/TC-040', 'WC_DE_DEDUCT', [...PAY('Final Payment', '1.00'), ...PAY('Supplemental Payment', '0.97')],
    [op('escalateChecks', '0.97'), op('workplan'), V('Workplan activities', { value: DEDUCT })],
    NOTE + 'A $1.00 Final Payment closes the Medical line, a $0.97 Supplemental Payment is submitted, the Financials Escalation batch moves it to Requesting; the Workplan must show "Collect Deductible" (90DayDeduct) and "Deductible Collected?" (Sup_Deduct_Diary).');
  add('GCCM-1013/VBR/TC-041', 'WC_DE_DEDUCT2', PAY('Partial Payment', '0.96'),
    [op('escalateChecks', '0.96'), op('workplan'), V('Workplan activities', { value: NO_DEDUCT })],
    NOTE + 'A $0.96 Partial Payment (no supplemental) is submitted and escalated to Requesting; neither deductible activity may appear.');
};
