/**
 * helpers/oneInc/profiles/qaUpdate1111.js
 * Claim profiles for QA's 2026-11-11 workbook update (recipes/y_qaUpdate1111.js).
 *
 * QA_PA_NORES / QA_PA_NORES2 / QA_PA_NORES3: a NEW PA personal auto claim each run with a vehicle "Medical Expense"
 * exposure that is left WITHOUT a reserve — "an exposure with no reserve history". Vehicle exposures get an automatic
 * initial reserve on TEST; an added Medical Expense one does not on every policy (see NORES_POLICIES). Three profiles because a
 * First and Final on that exposure gives it a reserve history: the cases that submit one each get their own claim.
 *
 * QA_DE_LC50_NEW: a DE personal auto claim with a loss date inside the last 2 years on a policy that carries the
 * "Medical Benefits" coverage (Cause of Loss Medical Benefits = LC50) — VBR.004 negative (763 TC-009).
 * Claim PMF-DE-01-25-0746301 (DoL 07/27/2025, policy PMF-3053397) is in the pool. PA-DE-01-25-0746526 does not fit — its policy only has PIP (Funeral Benefits / Medical Payments / Wage
 * Loss Benefits), whose Cause of Loss is Personal Injury Protection (LC57) only. Policy PMF-3053397 (claim
 * PMF-DE-01-25-0746339, DoL 09/15/2024) has the coverage; a claim on it (or a like policy) with a newer loss date is needed:
 *   node scripts/provisionOneIncClaims.js --add QA_DE_LC50_NEW=<claim>
 * QA_MD_MEDPAY: the MD claim older than 3 years (PA-MD-01-23-0742279) given a "Medical Payments" exposure + reserve —
 * VBR.005 on a Med Pay exposure (763 TC-012). Pool only:
 *   node scripts/provisionOneIncClaims.js --add QA_MD_MEDPAY=PA-MD-01-23-0742279
 */
'use strict';

const data = (fn) => ({ enumerable: true, get: () => fn(require('../testData').D) });
const NO_FNOL = (state) => ({ policyType: 'Personal Auto', state, lossCauseCode: 'LC50', lossDescription: 'not used (pool-only claim)', incidents: [], exposures: [] });
// CONFIRMED 2026-11-12: on policy 1002239819 the added Medical Expense exposure stays unreserved (PA-PA-01-26-0749303);
// on 1002239222 it came with a $2,500 reserve (PA-PA-01-26-0749296 / 0749298) — so the policy is pinned and the claim is
// only usable when the exposure really has no reserve (NO_RESERVE below).
const NORES_POLICIES = ['1002239819'];
const NO_RESERVE = { id: 'noreserve:Medical Expense', label: 'The Medical Expense exposure has no reserve (no reserve history)', build: null,
  manual: 'a claim whose Medical Expense exposure never had a reserve',
  check: async (page) => {
    const rows = await require('../reuseExt').reserveRows(page);
    const r = rows.find((x) => /Medical Expense/i.test(x.expo) && Number(String(x.remaining).replace(/[^0-9.]/g, '')) > 0);
    return r ? `the Medical Expense exposure already has a reserve (${r.remaining} on ${r.cost})` : '';
  } };
const NORES = (n) => ({ label: `PA personal auto with a Medical Expense exposure that has NO reserve history (${n})`, lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true, policies: NORES_POLICIES,
  fnol: { policyType: 'Personal Auto', state: 'PA', lossCauseCode: 'LC15', lossDescription: 'OneInc automation (QA update 11/11) — PA auto collision with an unreserved medical exposure', incidents: ['Add Vehicle'],
    exposures: [{ coverageLabel: 'Collision' }, { coverageLabel: 'Comprehensive' }] } });

module.exports = {
  // PA personal auto with a Bodily Injury Liability exposure (Cause of Loss Bodily Injury Liability) whose Tort Option is
  // Full Tort (not Undetermined) and a reserve — UIF.029 PA Tort Code (799 UIF TC-006, 1003 UIF TC-024).
  QA_PA_TORT: { label: 'PA personal auto, Bodily Injury Liability exposure with Tort Option Full Tort', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true, shareFresh: true,
    fnol: { policyType: 'Personal Auto', state: 'PA', lossCauseCode: 'LC15', lossDescription: 'OneInc automation — PA auto collision with a bodily injury liability exposure (Full Tort)', incidents: ['Add Vehicle'],
      exposures: [{ coverageLabel: 'Collision' }] } },
  QA_PA_NORES: NORES('rules that stop the payment'),
  QA_PA_NORES2: NORES('763 TC-041 First and Final'),
  QA_PA_NORES3: NORES('803 TC-016 First and Final'),
  QA_DE_LC50_NEW: { label: 'DE personal auto, DoL inside the last 2 years, Medical Benefits exposure with Cause of Loss LC50', lob: 'AUTO', state: 'DE', prefix: /^PM[FN]-DE-|^PA[EF]?-DE-/, poolOnly: true, fnol: NO_FNOL('DE') },
  QA_MD_MEDPAY: { label: 'MD personal auto, DoL 3+ years ago, Medical Payments (Med Pay) exposure with a reserve', lob: 'AUTO', state: 'MD', prefix: /^PA-MD-/, poolOnly: true, fnol: NO_FNOL('MD') },
};
for (const p of ['QA_PA_NORES', 'QA_PA_NORES2', 'QA_PA_NORES3']) {
  Object.defineProperty(module.exports[p], 'data', data((D) => [D.vehicleExposure({ coverage: 'Medical Expense', cause: 'Medical Benefits', match: /Medical Expense/i }), NO_RESERVE]));
}
Object.defineProperty(module.exports.QA_DE_LC50_NEW, 'data', data((D) => [
  D.vehicleExposure({ coverage: 'Medical Benefits', cause: 'Medical Benefits', match: /Medical Benefits/i }),
  D.reserve({ exposure: /Medical Benefits/i, amount: 500 }),
]));
Object.defineProperty(module.exports.QA_MD_MEDPAY, 'data', data((D) => [
  D.vehicleExposure({ coverage: 'Medical Payments', cause: '.', match: /Med(ical)? ?(Pay|Expense)/i }),
  D.reserve({ exposure: /Medical Expense/i, amount: 500 }),
]));
Object.defineProperty(module.exports.QA_PA_TORT, 'data', data((D) => [
  D.vehicleExposure({ coverage: 'Bodily Injury Liability', cause: 'Bodily Injury', match: /Bodily Injury/i, tort: /^Full Tort$/ }),
  D.reserve({ exposure: /Bodily Injury/i, amount: 500 }),
]));
