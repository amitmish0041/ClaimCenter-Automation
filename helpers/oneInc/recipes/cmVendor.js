/**
 * helpers/oneInc/recipes/cmVendor.js — VBR.031 (payee Tax ID Valid Until) recipes. The payee is the Address Book vendor
 * TAYLOR REPORTING SERVICE (Tax ID 58-2338930); contactManager.setTaxValidUntil sets its "Tax ID Valid Until" in
 * ContactManager before the payment and the closing check restores it (original value: blank). Needs CM_USER / CM_PASS.
 * Added 2026-10-22.
 */
'use strict';

module.exports = (api) => {
  const { add, VAL, QOPEN } = api;
  const NAME = 'TAYLOR REPORTING SERVICE';
  const TAX = '58-2338930';
  const SET = (when) => ({ call: ['contactManager.setTaxValidUntil', NAME, TAX, when] });
  const RESTORE = { call: ['contactManager.restoreVendors'] };
  const PICK = { call: ['reuseExt.selectVendorByTaxId', 'TAYLOR REPORTING', TAX] };
  const NOT_VALID = /This payee is no longer valid/i;
  const NOTE = `Setup: ContactManager vendor ${NAME} (${TAX}) Tax ID Valid Until set per the case and restored to its original value (blank) afterwards (contactManager.js; ledger results/oneInc/cm-restore.json).`;

  // Claim cost: Full Check on an open reserve line / Quick Payment from an open reserve row.
  const FULL_CC = (when) => [SET(when), { open: 'full' }, PICK, { next: true }, { reserve: 'open' }, { step2: { transactionType: 'Partial Payment', amount: '1.37' } }];
  const QUICK_CC = (when) => [SET(when), QOPEN('open'), PICK, { step2: { transactionType: 'Partial Payment', amount: '1.37' } }];
  // Expense: Full Check on a new Adjuster Expense line / Quick Payment from the expense row.
  const FULL_EXP = (when) => [SET(when), { open: 'full' }, PICK, { next: true }, { reserve: 'new' }, { select: ['Cost Type', 'Adjuster Expense'] },
    { step2: { transactionType: 'First and Final', amount: '1.37' } }];
  const QUICK_EXP = (when) => [SET(when), { call: ['reuseExt.openQuickOnRow', 'expense', 'any'] }, PICK, { step2: { amount: '1.37' } }];

  add('GCCM-803/TC/TC-029', 'AUTO_PA', VAL(FULL_CC('past'), NOT_VALID), [{ call: RESTORE.call }], NOTE);
  add('GCCM-803/TC/TC-030', 'AUTO_PA', VAL(FULL_CC('future'), null), [{ call: RESTORE.call }], NOTE + ' Submits $1.37.');
  add('GCCM-803/TC/TC-031', 'AUTO_PA', VAL(FULL_EXP('past'), null), [{ call: RESTORE.call }], NOTE + ' Expense payment, so the claim-cost rule must not fire. Submits $1.37.');
  add('GCCM-1003/VBR/TC-174', 'AUTO_PA', VAL(QUICK_CC('past'), NOT_VALID), [{ call: RESTORE.call }], NOTE);
  add('GCCM-1003/VBR/TC-175', 'AUTO_PA', VAL(QUICK_CC('future'), null), [{ call: RESTORE.call }], NOTE + ' Submits a $1.37 Quick Payment.');
  add('GCCM-1003/VBR/TC-176', 'AUTO_PA', VAL(QUICK_EXP('past'), null), [{ call: RESTORE.call }], NOTE + ' Expense Quick Payment, so the claim-cost rule must not fire. Submits $1.37.');
};
