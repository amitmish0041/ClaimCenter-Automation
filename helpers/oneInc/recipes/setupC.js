/**
 * helpers/oneInc/recipes/setupC.js — OneInc recipes that need claims built by helpers/oneInc/setupC.js
 * (VBR.037 surcharge, VBR.036 mailing address, payee roles, VBR.032 pending approval). Claims: profiles in
 * helpers/oneInc/profiles/setupC.js (automation-owned, TEST). Added 2026-10-21.
 */
'use strict';

module.exports = (api) => {
  const { add } = api;
  const call = (fn, ...args) => ({ call: [`setupC.${fn}`, ...args] });

  // ── VBR.037 — Surcharging screen must be completed before a payment (Personal Auto, loss >= 2013, qualifying cause) ──
  // Profiles keep the Surcharging screen INCOMPLETE; the recipe only opens Actions › New Payment / Quick Payment and
  // reads what CC shows (error page vs wizard). Nothing is saved.
  const ERR = /Please complete the Surcharging Screen/i;
  const ERROR_SHOWN = [{ text: { re: ERR, present: true } }, { button: { name: 'Next', present: false } }];
  // Negative: no error page AND the wizard actually opened (its Next button is shown) — setupE 2026-10-21.
  const NO_ERROR = [{ text: { re: /New Payment Error|Please complete the Surcharging/i, present: false } }, { button: { name: 'Next', present: true } }];
  const NOTE = ' Claim built by setupC (keepSurcharging: the Surcharging screen is left incomplete). Opened from the Actions menu; nothing saved.';
  const FULL = call('openFromActions', 'actions');
  const QUICK = call('openFromActions', 'quick');
  const CASES = [
    // [803 id, 1003 id, profile, expect error?, note]
    ['GCCM-803/TC/TC-047', 'GCCM-1003/VBR/TC-192', 'C_SURC_PA', true, 'Personal Auto PA, loss date after 2013, exposure cause of loss LC15 (one of LC03/LC04/LC15).'],
    ['GCCM-803/TC/TC-048', null, 'C_SURC_MI', true, 'Personal Auto Michigan, exposure cause of loss LC50.'],
    ['GCCM-803/TC/TC-050', 'GCCM-1003/VBR/TC-194', 'C_SURC_CA', false, 'Commercial Auto policy.'],
    ['GCCM-803/TC/TC-051', 'GCCM-1003/VBR/TC-195', 'C_SURC_LC01', false, 'Personal Auto PA, only exposure = Comprehensive with Cause of Loss "Fire" (code LC01).'],
    ['GCCM-803/TC/TC-052', 'GCCM-1003/VBR/TC-196', 'C_SURC_LC50', false, 'Personal Auto PA (not Michigan), only exposure = Medical Expense with Cause of Loss "Medical Benefits" (code LC50).'],
  ];
  for (const [full, quick, profile, err, why] of CASES) {
    const checks = err ? ERROR_SHOWN : NO_ERROR;
    add(full, profile, [FULL], checks, why + NOTE);
    if (quick) {
      add(quick, profile, [QUICK], checks, why + NOTE + ' Quick Payment.');
      if (quick === 'GCCM-1003/VBR/TC-192') add('GCCM-1003/VBR/TC-192#2', profile, [QUICK], checks, why + NOTE + ' Quick Payment (duplicate row of TC-192 in the workbook).');
    }
  }
  void api;
};
