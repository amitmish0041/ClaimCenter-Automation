/**
 * helpers/oneInc/profiles/setupA.js
 * Claim profiles owned by the "setup A" extension (claim/exposure state, WC indemnity / Medicare, payee roles).
 * Every profile is pool-only: its claims are created by scripts/provisionOneIncClaims.js with the `fnol` below, and
 * claimCheck's prepare mode runs `prepare` (helpers/oneInc/setupA.js) on them. Claims are kept apart from the core
 * AUTO_PA / WC_PA pools so state changes made here (denials, extra exposures…) never leak into other scenarios.
 */
'use strict';

const AUTO_FNOL = (lossCauseCode, desc, state = 'PA') => ({
  policyType: 'Personal Auto', state, lossCauseCode, lossDescription: `OneInc automation (setupA) — ${desc}`, incidents: ['Add Vehicle'],
  exposures: [{ coverageLabel: 'Collision' }, { coverageLabel: 'Comprehensive' }],
});
const WC_FNOL = (desc) => ({
  policyType: "Workers' comp", state: 'PA', lossCauseCode: 'LC07', lossDescription: `OneInc automation (setupA) — ${desc}`, incidents: [],
  exposures: [{ coverageLabel: "Workers' Compensation And Employers' Liability" }],
});

module.exports = {
  // PA personal auto for the exposure-state rules (VBR.023 exposure denial, VBR.002 / VBR.026 negatives, payee roles).
  AUTOA_PA: { label: 'PA personal auto (setup A: exposure denial / owner / payee roles)', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true,
    fnol: AUTO_FNOL('LC15', 'PA auto collision') },
  // Second PA auto claim for rules that leave lasting state on the claim: aggregate limit (VBR.035), pending-approval
  // transactions (VBR.032), earlier First and Final / Final payments (VBR.019 / VBR.022).
  AUTOA_PA2: { label: 'PA personal auto (setup A: aggregate limit / pending approval / repeat F&F-Final)', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true,
    fnol: AUTO_FNOL('LC15', 'PA auto collision, state-heavy rules') },
  // PA workers comp for the claim-denial rules (VBR.024 / VBR.028): claim-level "Claim Denied" is toggled per scenario.
  WCA_PA: { label: 'PA workers comp (setup A: claim denial)', lob: 'WC', state: 'PA', prefix: /^WC-PA-/, poolOnly: true,
    fnol: WC_FNOL('WC injury, claim denial rules') },
  // PA workers comp with a Lost Wages (indemnity) exposure + reserve, Medicare beneficiary = Yes on that exposure.
  WCA_LW: { label: 'PA workers comp with a Lost Wages exposure (setup A: indemnity / Medicare / MSA fields)', lob: 'WC', state: 'PA', prefix: /^WC-PA-/, poolOnly: true,
    fnol: WC_FNOL('WC injury with lost wages'), prepare: 'setupA.prepareLostWages' },
};
