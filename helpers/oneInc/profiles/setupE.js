/**
 * helpers/oneInc/profiles/setupE.js
 * Claim profiles owned by the "setup E" extension (VBR.036 mailing address, payee-role ClaimsPay defaults, VBR.002
 * exposure-owner info, VBR.032 pending approval). Pool-only: created by scripts/provisionOneIncClaims.js with the `fnol`
 * below (automation-owned, TEST). Added 2026-10-21.
 */
'use strict';

const AUTO_FNOL = (desc) => ({
  policyType: 'Personal Auto', state: 'PA', lossCauseCode: 'LC15', lossDescription: `OneInc automation (setupE) — ${desc}`, incidents: ['Add Vehicle'],
  exposures: [{ coverageLabel: 'Collision' }, { coverageLabel: 'Comprehensive' }],
});

module.exports = {
  // PA personal auto for VBR.036 (payments + contact address changes), payee-role cases and VBR.002 / VBR.032.
  E_PA: { label: 'PA personal auto (setup E: mailing-address auto-update / payee roles / exposure owner)', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true,
    fnol: AUTO_FNOL('PA auto collision, payee roles / mailing address') },
};
