/**
 * helpers/oneInc/recipes/oneIncPortal.js — cases judged on the OneInc side, read from the OneInc staging Admin Portal
 * (helpers/oneInc/portal.js — one signed-in portal window, started with scripts/oneIncPortalSession.js; added 2026-11-11).
 *
 * INT.001 / INT.002 (GCCM-1003 INT TC-197–207, GCCM-803 TC-053–063): PM_Additional_Text_13 = the claim's Underwriting
 * Company and PM_Additional_Text_14 = "<company> and affiliated insurance companies conduct business together as the
 * Donegal Insurance Group®." On the portal these are "Additional Text Field 13 / 14" of the payment (CONFIRMED 2026-11-11:
 * HO-PA-01-26-0749093's checks carry "Southern Insurance Company of Virginia" and its disclaimer). Each case reads the
 * claim's Underwriting Company (Policy screen) and the newest ClaimCenter payment of that claim on the portal; nothing is
 * saved, except on the Le Mars claim, which has no payment on the portal yet: a $1.5x payment is made, sent (Financials
 * Escalation batch) and waited for.
 * Not automatable yet: Sheboygan Falls Insurance Company and Mountain States Commercial Insurance Company — no TEST claim
 * with either Underwriting Company found (caseReasons.js).
 */
'use strict';

module.exports = (api) => {
  const { add, V, VAL, FULL_PAYMENTS } = api;
  const pc = (fn, ...a) => ({ call: [`portalChecks.${fn}`, ...a] });
  const op = (fn, ...a) => ({ call: [`checkOps.${fn}`, ...a] });
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const AT = ['Additional Text Field 13', 'Additional Text Field 14'];

  // [1003 TC, 803 TC, profile, company as the case names it in AT13, the claim's own Underwriting Company, AT14 ends with ® ?]
  const COMPANIES = [
    ['197', '053', 'UW_DMIC', 'Donegal Mutual Insurance Company', /^Donegal Mutual Insurance Company$/, true],
    ['198', '054', 'UW_ASIC', 'Atlantic States Insurance Company', /^Atlantic States Insurance Company$/, true],
    ['199', '055', 'UW_SICV', 'Southern Insurance Company of Virginia', /^Southern Insurance Company of Virginia$/, true],
    ['200', '056', 'UW_LEMARS', 'Le Mars Insurance Company', /^Le Mars Insurance Company$/, true],
    ['201', '057', 'UW_SMIC', 'Southern Mutual Insurance Company', /^Southern Mutual Insurance Company$/, true],
    ['203', '059', 'UW_MICH', 'Michigan Insurance Company', /^Michigan Insurance Company$/, true],
    ['204', '060', 'UW_PIC', 'The Peninsula Indemnity Company', /Peninsula Indemnity/, false],
    ['205', '061', 'UW_TPIC', 'The Peninsula Insurance Company', /^The Peninsula Insurance Company$/, false],
    ['206', '062', 'UW_MSI', 'Mountain States Indemnity Company', /^Mountain States Indemnity/, true],
  ];
  for (const [t1003, t803, profile, company, claimUw, mark] of COMPANIES) {
    const disclaimer = `${company} and affiliated insurance companies conduct business together as the Donegal Insurance Group${mark ? '®' : ''}.`;
    const checks = [V('Claim Underwriting Company', { value: claimUw }), V('OneInc Additional Text Field 13', { value: new RegExp(esc(company)) }),
      V('OneInc Additional Text Field 14', { value: new RegExp(`^${esc(disclaimer)}$`) })];
    for (const [id, amount] of [[`GCCM-1003/INT/TC-${t1003}`, '1.51'], [`GCCM-803/TC/TC-${t803}`, '1.52']]) {
      const lemars = profile === 'UW_LEMARS';
      const steps = lemars
        ? [...VAL([...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Partial Payment', amount } }], null),
          op('escalateChecks', amount), pc('underwritingCompany'), pc('oneIncPayment', { fields: AT, amount, waitMin: 20 })]
        : [pc('underwritingCompany'), pc('oneIncPayment', { fields: AT })];
      add(id, profile, steps, checks,
        `Existing TEST claim underwritten by ${company.replace(/^The /, '')} (profiles/oneIncPortal.js). Reads the claim's Underwriting Company (Policy screen) and `
        + (lemars ? `makes a $${amount} payment, sends it (Financials Escalation batch) and waits for it on the OneInc portal; `
          : 'the newest ClaimCenter payment of that claim on the OneInc staging portal; nothing is saved; ')
        + `PM_Additional_Text_13 / 14 are the payment's "Additional Text Field 13 / 14" there. Expected AT14: "${disclaimer}"`);
    }
  }
};
