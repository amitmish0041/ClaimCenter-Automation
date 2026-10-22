/**
 * helpers/oneInc/profiles/workerJ.js
 * Claim profile for the VBR.032 pending-approval cases (recipes/workerJ.js). Pool only — an EXISTING claim, added with
 *   node scripts/provisionOneIncClaims.js --add J_DE_PIP=PA-DE-01-25-0746526
 * (the same DE claim as F_DE_WAGE: a PIP › Wage Loss Benefits exposure with an approved $2,500 reserve). Added 2026-10-22.
 *
 * Why a PIP line: on cloud TEST the adjuster benjsmit (default CC_USER) has no NewReserveSet permission (so no reserve
 * change of his can pend) and his PA auto Claim Cost payments land "Submitted"; but his PIP Wage Loss payments are held
 * in "Pending approval" (CONFIRMED 2026-10-22: $1.37 Quick Payment on exposure (3) of PA-DE-01-25-0746526). Provision /
 * verify as benjsmit — an admin (su) payment never pends. The pending payment's approver is the activity's Assigned To
 * user (Keith Eisenhart on this claim); after a run, approve or reject it, then --verify rebuilds the data.
 */
'use strict';

const data = (fn) => ({ enumerable: true, get: () => fn(require('../testData').D) });
module.exports = {
  J_DE_PIP: { label: 'DE personal auto, PIP Wage Loss Benefits line with a payment in "Pending approval" (VBR.032)', lob: 'AUTO', state: 'DE', prefix: /^PA-DE-/, poolOnly: true,
    // fnol only so provisionOneIncClaims.js --add accepts the profile; never FNOL-created.
    fnol: { policyType: 'Personal Auto', state: 'DE', lossCauseCode: 'LC57', lossDescription: 'not used (pool-only existing claim)', incidents: [], exposures: [] } },
};
Object.defineProperty(module.exports.J_DE_PIP, 'data', data((D) => [
  D.vehicleExposure({ coverage: 'PIP', leaf: 'Wage Loss Benefits', cause: 'Personal Injury Protection', match: /Wage/i }),
  D.reserve({ exposure: /Wage/i, amount: 2500 }),
  D.pendingTransaction({ expo: 3, via: 'payment', row: 'Wage', payee: 'MATTHEW SPONG', payAmount: '1.37' }),
]));
