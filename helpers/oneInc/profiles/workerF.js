/**
 * helpers/oneInc/profiles/workerF.js
 * Claim profiles for the "needs test data" follow-ups (recipes/workerF.js). Pool only — EXISTING aged TEST claims that
 * were given the exposure the rule needs (a new FNOL with a 2-year-old loss date is impossible), added with
 *   node scripts/provisionOneIncClaims.js --add F_DE_LC50=PMF-DE-01-25-0746339
 * prepare (TEST only) adds a medical exposure with Cause of Loss "Medical Benefits" (LC50), a reserve on it, and runs
 * Ability to pay. Idempotent.
 */
'use strict';

// fnol is only here so provisionOneIncClaims.js --add accepts the profile; these profiles are never FNOL-created.
const NO_FNOL = (state) => ({ policyType: 'Personal Auto', state, lossCauseCode: 'LC50', lossDescription: 'not used (pool-only aged claim)', incidents: [], exposures: [] });

module.exports = {
  // DE personal auto (policy PMF-3053397), DoL 09/15/2024, "(2) Medical Benefits" exposure, Cause of Loss Medical
  // Benefits (LC50) — VBR.004. The PA-DE policies offer no LC50 cause (PIP only).
  F_DE_LC50: { label: 'DE personal auto, DoL 2+ years ago, Medical Benefits exposure with Cause of Loss LC50', lob: 'AUTO', state: 'DE', prefix: /^PM[FN]-DE-|^PA[EF]-DE-/, poolOnly: true,
    fnol: NO_FNOL('DE'), prepare: 'recipes/workerF.prepareDeMed' },
  // PA personal auto, DoL 2+ years ago, "Medical Expense" exposure (Cause of Loss Medical Benefits / LC50) — VBR.004
  // non-DE negative.
  F_PA_LC50: { label: 'PA personal auto, DoL 2+ years ago, Medical Expense exposure with Cause of Loss LC50', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true,
    fnol: NO_FNOL('PA'), prepare: 'recipes/workerF.preparePaMed' },
  // DE personal auto with a PIP "Wage Loss Benefits" exposure (Cause of Loss Personal Injury Protection = LC57) and a
  // $2,500 reserve — UIF.061 / UIF.052 "Is this a wage Payment?" (shows for wage exposures with LC50/57/58, >= $1,000).
  F_DE_WAGE: { label: 'DE personal auto, PIP Wage Loss Benefits exposure (LC57) with a $2,500 reserve', lob: 'AUTO', state: 'DE', prefix: /^PA-DE-/, poolOnly: true,
    fnol: NO_FNOL('DE'), prepare: 'recipes/workerF.prepareDeWage' },
};
