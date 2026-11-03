/**
 * helpers/oneInc/profiles/needsData.js
 * Claim profile for the former "needs data" cases (recipes/needsData.js, added 2026-11-03).
 * ND_PA_MED: a NEW PA personal auto claim each run (Collision + Comprehensive at FNOL), given a vehicle "Medical Expense"
 * exposure (Cause of Loss Medical Benefits) with a $1,500 Claim Cost reserve — a first-party medical coverage line for
 * VBR.038 (supplemental escalation) and VBR.040 (sp_closed activity negative).
 */
'use strict';

const data = (fn) => ({ enumerable: true, get: () => fn(require('../testData').D) });
module.exports = {
  ND_PA_MED: { label: 'PA personal auto with a Medical Expense exposure + reserve (needs-data cases)', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true,
    fnol: { policyType: 'Personal Auto', state: 'PA', lossCauseCode: 'LC15', lossDescription: 'OneInc automation (needs-data) — PA auto collision with a medical exposure', incidents: ['Add Vehicle'],
      exposures: [{ coverageLabel: 'Collision' }, { coverageLabel: 'Comprehensive' }] } },
};
Object.defineProperty(module.exports.ND_PA_MED, 'data', data((D) => [
  D.vehicleExposure({ coverage: 'Medical Expense', cause: 'Medical Benefits', match: /Medical Expense/i }),
  D.reserve({ exposure: /Medical Expense/i, amount: 1500 }),
]));
