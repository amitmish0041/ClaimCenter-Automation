/**
 * helpers/oneInc/profiles/workerG.js
 * Claim profiles for recipes/workerG.js (VBR.032 pending-approval / VBR.002 exposure owner / CPD.002 payment approver).
 * Pool only — created by scripts/provisionOneIncClaims.js --profiles G_PA (automation-owned, TEST). Added 2026-10-21.
 */
'use strict';

// Declared test data (helpers/oneInc/testData.js): built at claim creation, checked before cases run (2026-10-21).
const data = (fn) => ({ enumerable: true, get: () => fn(require('../testData').D) });
module.exports = {
  // PA personal auto with two vehicle exposures: (1) Collision, (2) Comprehensive. Used by the VBR.032 Final Payment
  // negatives (see the data note below); the VBR.032 positives run on J_DE_PIP.
  G_PA: { label: 'PA personal auto (worker G: pending-approval reserve line / exposure owner / payment approver)', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true,
    fnol: { policyType: 'Personal Auto', state: 'PA', lossCauseCode: 'LC15', lossDescription: 'OneInc automation (worker G) — PA auto collision, pending approval / exposure owner', incidents: ['Add Vehicle'],
      exposures: [{ coverageLabel: 'Collision' }, { coverageLabel: 'Comprehensive' }] } },
};
// VBR.032 Final Payment negatives (GCCM-803 TC-033 / GCCM-1003 TC-178, recipes/workerJ.js): exposure (1) Collision has
// an open Claim Cost reserve line with nothing pending; the Final Payment closes it, so each case uses up one G_PA claim.
// The pending-approval POSITIVES moved to profile J_DE_PIP (profiles/workerJ.js): the cloud adjuster benjsmit has no
// NewReserveSet permission, so exposure (2)'s reserve cannot be raised into "Pending approval" here (CONFIRMED
// 2026-10-22, PA-PA-01-26-0748501), and his PA auto Claim Cost payments land "Submitted", not pending (e.g. $1,000.00 on
// PA-PA-01-26-0748443).
Object.defineProperty(module.exports.G_PA, 'data', data((D) => [D.reserveRow({ cost: 'claim cost', state: 'open', expo: '^\\(1\\) ' })]));
