/**
 * helpers/oneInc/profiles/setupC.js
 * Claim profiles owned by the "setup C" extension (VBR.037 surcharge, VBR.036 mailing address, payee-role cases,
 * VBR.032 pending approval). Pool-only: claims are created by scripts/provisionOneIncClaims.js with the `fnol` below.
 * Surcharge profiles carry keepSurcharging so claimCheck leaves the Surcharging screen incomplete (the claim is then
 * "not usable" for claimCheck, so helpers/oneInc/setupC.js markUsable() puts it into the pool by hand).
 *
 * CONFIRMED 2026-10-21 (setupE): cloud FNOL IGNORES lossCauseCode (every claim gets Loss Cause "Airbag Accidental
 * Discharge"); the rule reads the EXPOSURE Cause of Loss, which follows the coverage: Collision → LC15 "Collision",
 * Comprehensive → LC22 by default (editable: LC01 "Fire", LC02 "Wind", LC13 "Theft of Auto - Total", …), Medical
 * Expense → LC50 "Medical Benefits". So C_SURC_LC01 / C_SURC_LC50 claims were finished by hand: 0748491 = one
 * Comprehensive exposure set to Fire (LC01); 0748496 = one Medical Expense exposure (+ injury incident via
 * setupE.ensureInjuryIncident). C_SURC_MI 0748490 has Collision/Comprehensive exposures (LC15), NOT an LC50 one.
 */
'use strict';

const AUTO_FNOL = (lossCauseCode, desc, { state = 'PA', policyType = 'Personal Auto', coverage = ['Collision', 'Comprehensive'] } = {}) => ({
  policyType, state, lossCauseCode, lossDescription: `OneInc automation (setupC) — ${desc}`, incidents: ['Add Vehicle'],
  exposures: coverage.map((coverageLabel) => ({ coverageLabel })),
});

module.exports = {
  // VBR.037 positive: PA personal auto, LC15, Surcharging screen NOT completed.
  C_SURC_PA: { label: 'PA personal auto, LC15, Surcharging incomplete (setup C: VBR.037 positive)', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true,
    keepSurcharging: true, fnol: AUTO_FNOL('LC15', 'surcharge positive') },
  // VBR.037 Michigan positive: MI personal auto, LC50.
  C_SURC_MI: { label: 'MI personal auto, LC50, Surcharging incomplete (setup C: VBR.037 Michigan)', lob: 'AUTO', state: 'MI', prefix: /^PA-MI-/, poolOnly: true,
    keepSurcharging: true, fnol: AUTO_FNOL('LC50', 'surcharge MI positive', { state: 'MI' }) },
  // VBR.037 negative: PA personal auto, LC50 (qualifies only for Michigan).
  C_SURC_LC50: { label: 'PA personal auto, LC50, Surcharging incomplete (setup C: VBR.037 non-Michigan negative)', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true,
    keepSurcharging: true, fnol: AUTO_FNOL('LC50', 'surcharge LC50 PA negative') },
  // VBR.037 negative: PA personal auto, LC01 only.
  C_SURC_LC01: { label: 'PA personal auto, LC01, Surcharging incomplete (setup C: VBR.037 no qualifying cause)', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true,
    keepSurcharging: true, fnol: AUTO_FNOL('LC01', 'surcharge LC01 negative', { coverage: ['Collision'] }) },
  // VBR.037 negative: Commercial Auto, LC15.
  C_SURC_CA: { label: 'PA commercial auto, Surcharging incomplete (setup C: VBR.037 non-personal-auto)', lob: 'AUTO', state: 'PA', prefix: /^CA-PA-/, poolOnly: true,
    keepSurcharging: true, fnol: AUTO_FNOL('LC15', 'surcharge commercial auto negative', { policyType: 'Commercial Auto', coverage: ['Collision'] }) },};
