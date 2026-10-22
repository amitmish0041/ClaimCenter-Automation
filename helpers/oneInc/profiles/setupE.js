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

// Declared test data (helpers/oneInc/testData.js): built at claim creation, checked before cases run (2026-10-21).
const data = (fn) => ({ enumerable: true, get: () => fn(require('../testData').D) });
module.exports = {
  // PA personal auto for VBR.036 (payments + contact address changes), payee-role cases and VBR.002 / VBR.032.
  E_PA: { label: 'PA personal auto (setup E: mailing-address auto-update / payee roles / exposure owner)', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true,
    fnol: AUTO_FNOL('PA auto collision, payee roles / mailing address') },
};
// Payee-role contacts (CPD.030/031) and the claim-only person payee for VBR.036 (not linked to the Address Book).
Object.defineProperty(module.exports.E_PA, 'data', data((D) => [
  D.roleContact('stateAgency'), D.roleContact('adverseCarrier'), D.roleContact('attorney'),
  D.contact('PHILIP ADAMS', 'claim-only person contact (Parties Involved › New Contact › Person, NOT from the Address Book), role Covered Party'),
]));
