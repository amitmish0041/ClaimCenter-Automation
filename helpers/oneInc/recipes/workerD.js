/**
 * helpers/oneInc/recipes/workerD.js — follow-ups to recipes/reuseB.js (added 2026-10-21). Loaded after reuseB.js
 * (files load alphabetically), so an add() here replaces that file's recipe for the same id.
 *
 * Claim data these rely on (prepared 2026-10-21 on PA-PA-01-26-0748435 — run with ONEINC_CLAIM_AUTO_PA pinned to it):
 *   - a "Legal Expense - Allocated" and an "Adjuster Expense - Unallocated" reserve row, created by small First and
 *     Final expense payments to the Address Book vendor on a new line (the vehicle exposure's New Reserve screen offers
 *     only Cost Type "Claim Cost", so an expense row cannot be added through Actions › Reserve);
 *   - an open Claim Cost reserve (no exceeded aggregate limit, unlike PA-PA-01-26-0748460).
 */
'use strict';

module.exports = (api) => {
  const { add, V, VAL, QCC, FULL_INSTRUCTIONS, VENDOR_NOTE } = api;
  const X = (fn, ...a) => ({ call: [`reuseExt.${fn}`, ...a] });
  const SUB = (amt) => `Submits a $${amt} payment on TEST (Finish) when no rule stops it.`;

  // VBR.030 negative amount. CONFIRMED 2026-10-21 (Quick Payment and Full Check): "Total Amount of Payment" is a
  // blind-amount (password-type) input that silently DROPS the minus sign — "-50.00" is stored as $50.00 (Step 2
  // then shows Amount $50.00 when the line item is 50.00). The line-item Amount does keep "-50.00", so the payment is
  // refused by "Line Items : This amount does not match the total amount of the check", never by the VBR.030 text.
  // The automation fills both fields with -50.00 as the design says; the FAIL is the product behaviour, for the BA.
  const NEG_NOTE = 'Total Amount of Payment drops the "-" sign (blind-amount field: "-50.00" is stored as $50.00, CONFIRMED 2026-10-21), so the negative line item is refused only by the line-item/total mismatch rule — VBR.030\'s "amount greater than $0" text never shows. Confirm with the BA whether that satisfies the rule.';
  add('GCCM-1003/VBR/TC-172', 'AUTO_PA', VAL(QCC('Partial Payment', '-50.00'), /amount greater than \$0/i), [], NEG_NOTE);

  // VBR.025 valid payee, expense Quick Payment to a vendor — on a claim with no exceeded aggregate limit (the earlier
  // FAIL on 0748460 was CC's "At least one aggregate limit on this claim has been exceeded" warning, a claim-state
  // side effect that core validate does not recognise as warnings-only).
  const QEXP = (amount) => [X('openQuickOnRow', 'expense', 'any'), { payee: 'vendor' }, { step2: { amount } }];
  const QEXP_NOTE = 'Quick Payment opened from the claim\'s Adjuster Expense reserve row (Financials); payee = Address Book vendor.';
  add('GCCM-1003/VBR/TC-155', 'AUTO_PA', VAL(QEXP('1.59'), null), [], QEXP_NOTE + ' ' + SUB('1.59'));

  // CPD.014 — vendor Mailed Check → Certified. ClaimsPay Type is left BLANK for a vendor payee (the CPD.013 finding),
  // and ClaimsPay Method has no options until a Type is chosen ("options: none", 2026-10-21) — so set Type = Vendor
  // first. With Type = Vendor, Method offers ONLY "Vendor Preferred" (CONFIRMED 2026-10-21), so the manual change to
  // Mailed Check the case starts from is impossible: checked as an option first (FAIL = finding), and only when it
  // exists is it chosen and Payment Delivery checked.
  add('GCCM-759/CPD/TC-058', 'AUTO_PA', [...FULL_INSTRUCTIONS('vendor'), { select: ['ClaimsPay Type', /^vendor$/i] }],
    [V('ClaimsPay Method', { editable: true, includes: ['Mailed Check'] })],
    VENDOR_NOTE + ' ClaimsPay Type is set to Vendor first (CC leaves it blank for a vendor payee and Method has no options until it is set). Payment Delivery = Certified is checked once Mailed Check is offered.');

  // "No error" mirrors: Finish via reuseExt.finishObserve, whose check lookup reads EVERY page of Financials › Checks.
  // Core validate reads page 1 only and reported "wizard closed after Finish, but no $x check is listed" for payments
  // that WERE submitted (claim 0748435 has > 15 checks — CONFIRMED 2026-10-21, run OneInc_20261021_165908_test).
  const FINISH = X('finishObserve');
  const SUBMITTED = V('Finish outcome', { value: /^submitted: check \d+/ });
  const { CC } = api;
  const QE = (amount) => [X('openQuickOnRow', 'expense', 'any'), { payee: 'vendor' }, { step2: { amount } }, FINISH];
  add('GCCM-1003/VBR/TC-173', 'AUTO_PA', [...QCC('Partial Payment', '0.01'), FINISH], [SUBMITTED], SUB('0.01'));
  add('GCCM-1003/VBR/TC-181', 'AUTO_PA', QE('1.68'), [SUBMITTED], QEXP_NOTE + ' ' + SUB('1.68'));
  add('GCCM-1003/VBR/TC-182', 'AUTO_PA', [...QCC('Partial Payment', '1.70'), FINISH], [SUBMITTED], 'Claim cost Quick Payment, no Adjuster Number. ' + SUB('1.70'));
  add('GCCM-1003/VBR/TC-184', 'AUTO_PA', QE('1.72'), [SUBMITTED], QEXP_NOTE + ' Vendor has a Tax ID. ' + SUB('1.72'));
  add('GCCM-1003/VBR/TC-185', 'AUTO_PA', [...QCC('Partial Payment', '1.74'), FINISH], [SUBMITTED], 'Claim cost to the claimant (no Tax ID). ' + SUB('1.74'));
  add('GCCM-803/TC/TC-023', 'AUTO_PA', [...CC('Partial Payment', '1.80'), FINISH], [SUBMITTED], 'The vehicle incident has a VIN (filled by the claim prepare step). ' + SUB('1.80'));
  add('GCCM-763/VBR/TC-053', 'AUTO_PA', [...CC('Partial Payment', '1.84'), FINISH], [SUBMITTED], 'Partial payment on a specific exposure. ' + SUB('1.84'));
  add('GCCM-803/TC/TC-017', 'AUTO_PA', [...CC('Partial Payment', '1.90'), FINISH], [SUBMITTED], 'Existing Claim Cost reserve line, Partial Payment. ' + SUB('1.90'));
  add('GCCM-763/VBR/TC-007', 'AUTO_PA', [...CC('Partial Payment', '1.94'), FINISH], [SUBMITTED], 'Check with only a claim cost payment. ' + SUB('1.94'));
};
