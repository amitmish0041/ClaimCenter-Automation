/**
 * helpers/oneInc/profiles/workerG.js
 * Claim profiles for recipes/workerG.js (VBR.032 pending-approval / VBR.002 exposure owner / CPD.002 payment approver).
 * Pool only — created by scripts/provisionOneIncClaims.js --profiles G_PA (automation-owned, TEST). Added 2026-10-21.
 */
'use strict';

module.exports = {
  // PA personal auto with several vehicle exposures. VBR.032 makes a reserve change on one exposure pend ("Pending
  // approval", raised by a non-admin adjuster above their authority), so the reserve line of that exposure carries a
  // pending transaction; the Final Payment negative case closes another exposure's line.
  G_PA: { label: 'PA personal auto (worker G: pending-approval reserve line / exposure owner / payment approver)', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true,
    fnol: { policyType: 'Personal Auto', state: 'PA', lossCauseCode: 'LC15', lossDescription: 'OneInc automation (worker G) — PA auto collision, pending approval / exposure owner', incidents: ['Add Vehicle'],
      exposures: [{ coverageLabel: 'Collision' }, { coverageLabel: 'Comprehensive' }] } },
};
