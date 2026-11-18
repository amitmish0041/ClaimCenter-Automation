/**
 * helpers/oneInc/profiles/deductible.js — WC claims on Delaware policies that carry a deductible endorsement
 * (WC 07 04 01, Marietta program), for GCCM-1013 VBR.039 (TC-040 / TC-041). Policies found 2026-11-18 by scanning the
 * PolicyCenter harvest (V:\Amit Int\TestData\PolicyPool\deductible-endorsements.json) — Forms screen of every WC /
 * Commercial Package / Commercial Auto policy. They have no cloud claim yet, so they come from extra-policies-<tier>.json.
 */
'use strict';
const DEDUCT_WC_DE = ['1002236709', '1002239674', '1002239817'];
const fnol = (desc) => ({
  policyType: "Workers' comp", state: 'DE', lossCauseCode: 'LC07', lossDescription: `OneInc automation (deductible) — ${desc}`, incidents: [],
  exposures: [{ coverageLabel: "Workers' Compensation And Employers' Liability" }],
});
module.exports = {
  WC_DE_DEDUCT: { label: 'DE workers comp on a policy with a deductible endorsement (WC 07 04 01)', lob: 'WC', state: 'DE', prefix: /^WC-DE-/,
    poolOnly: true, policies: DEDUCT_WC_DE, fnol: fnol('VBR.039 supplemental payment') },
  WC_DE_DEDUCT2: { label: 'DE workers comp on a policy with a deductible endorsement — no supplemental payment', lob: 'WC', state: 'DE', prefix: /^WC-DE-/,
    poolOnly: true, policies: DEDUCT_WC_DE, fnol: fnol('VBR.039 negative, no supplemental') },
};
