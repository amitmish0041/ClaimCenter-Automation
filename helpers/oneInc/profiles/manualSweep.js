/**
 * helpers/oneInc/profiles/manualSweep.js
 * Claim profiles for the cases moved from manual to automated on 2026-11-05 (recipes/manualSweep.js). Each is a NEW PA
 * personal auto claim (same FNOL as AUTO_PA), given its data by the "Create test data" step before any case runs:
 *  - MS_PA_PD:    a third-party Property Damage Other Than Vehicle Damage exposure reserved at $6,000 + a claim document
 *                 (VBR.008 release warning over $2,500; VBR.010 needs a linked document over $1,000).
 *  - MS_PA_BIG:   the first-party Vehicle line reserved up to $151,000 + a claim document (VBR.008 non-PD $3,000 and the
 *                 VBR.011 $150,000 claim cost / $99,999.99 expense "no error" cases).
 * (VBR.013's never-reserved exposure is not buildable: a new exposure gets a $1,000 reserve as it is created — 2026-11-05.)
 */
'use strict';

const data = (fn) => ({ enumerable: true, get: () => fn(require('../testData').D) });
const base = (label) => ({ label, lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true, fnolAs: 'AUTO_PA' });
module.exports = {
  MS_PA_PD: base('PA personal auto + reserved Property Damage Other Than Vehicle Damage exposure + claim document (VBR.008)'),
  MS_PA_BIG: base('PA personal auto, Vehicle line reserved to $151,000 + claim document (VBR.008 / VBR.011)'),
  // Pool only — an EXISTING claim with an ImageRight document (INT.011 "Sent Successfully"), added 2026-11-06 with
  //   node scripts/provisionOneIncClaims.js --add MS_DE_IRDOC=PA-DE-01-25-0746526
  // ("Surcharge Worksheet", Author Image Right). Its policy was cancelled before the loss date, so checks hold for approval.
  MS_DE_IRDOC: { label: 'Existing DE personal auto claim with an ImageRight document (INT.011)', lob: 'AUTO', state: 'DE', prefix: /^PA-DE-/, poolOnly: true,
    // fnol only so provisionOneIncClaims.js --add accepts the profile; never FNOL-created.
    fnol: { policyType: 'Personal Auto', state: 'DE', lossCauseCode: 'LC57', lossDescription: 'not used (pool-only existing claim)', incidents: [], exposures: [] } },
};
Object.defineProperty(module.exports.MS_DE_IRDOC, 'data', data((D) => [D.irDocument()]));
Object.defineProperty(module.exports.MS_PA_PD, 'data', data((D) => [
  D.pdExposure(),
  D.reserve({ exposure: /Other Than Vehicle/i, amount: 6000, min: 3001 }),
  D.document(),
]));
Object.defineProperty(module.exports.MS_PA_BIG, 'data', data((D) => [
  D.reserve({ exposure: /1st Party Vehicle/i, amount: 151000, min: 150001 }),
  D.document(),
]));
