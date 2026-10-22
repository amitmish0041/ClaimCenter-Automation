/**
 * helpers/oneInc/profiles/reuseB.js
 * Claim profiles for the "high reuse" OneInc recipes (recipes/reuseB.js). Pool only — add a claim with
 *   node scripts/provisionOneIncClaims.js --add AUTO_MD_AGED=PA-MD-01-23-0742279
 * Aged claims are EXISTING TEST claims: a new FNOL with an old loss date is impossible (Find Policy won't attach an
 * expired term), so the date-of-loss rules (VBR.004 DE / VBR.005 + VBR.015 MD) run on these.
 */
'use strict';

// fnol is only here so provisionOneIncClaims.js --add accepts the profile; these profiles are never FNOL-created.
const NO_FNOL = (state) => ({ policyType: 'Personal Auto', state, lossCauseCode: 'LC50', lossDescription: 'not used (pool-only aged claim)', incidents: [], exposures: [] });

// Declared test data (helpers/oneInc/testData.js): built at claim creation, checked before cases run (2026-10-21).
const data = (fn) => ({ enumerable: true, get: () => fn(require('../testData').D) });
module.exports = {
  // MD personal auto, DoL 09/11/2023, "(3) 1st Party Medical Expense" PIP exposure with a reserve (VBR.005 / VBR.015).
  AUTO_MD_AGED: { label: 'MD personal auto, DoL 3+ years ago, PIP Medical Expense exposure', lob: 'AUTO', state: 'MD', prefix: /^PA-MD-/, poolOnly: true,
    fnol: NO_FNOL('MD') },
  // DE personal auto, DoL 09/15/2024, PIP "Medical Expense" exposure (cause of loss Medical Benefits / LC50) — VBR.004.
  // prepare fills the exposure fields CC's Ability to pay asks for (description, detailed body part).
  AUTO_DE_AGED: { label: 'DE personal auto, DoL 2+ years ago, PIP Medical Expense exposure (LC50)', lob: 'AUTO', state: 'DE', prefix: /^PA-DE-/, poolOnly: true,
    fnol: NO_FNOL('DE'), prepare: 'reuseExt.prepareAgedPip' },
};
// MD: the PIP Medical Expense line (VBR.005/015 positives) and a Bodily Injury line (non-PIP negatives, $500 added
// 2026-10-21). The PIP reserve on 0742279 needed manager approval ("exceeds the policy limits", approved as keiteise).
Object.defineProperty(module.exports.AUTO_MD_AGED, 'data', data((D) => [
  D.reserve({ exposure: /Medical Expense/i, amount: 2500 }),
  D.reserve({ exposure: /Bodily Injury/i, amount: 500 }),
]));
Object.defineProperty(module.exports.AUTO_DE_AGED, 'data', data((D) => [D.reserve({ exposure: /Medical|PIP/i, amount: 1500 })]));

