/**
 * helpers/oneInc/profiles/workerK.js
 * PROP_BLDG — a DEDICATED PA homeowners claim for VBR.006 (mortgagee on building checks > $5,000) and the roof question
 * (UIF.057 / UIF.067), so the shared HO claim (PROP_PA / PROP_MORT, HO-PA-01-26-0748434, Cause of Loss "All Other
 * Losses…") is not changed.
 *
 * Pool only, EXISTING claim: a new HO FNOL fails on cloud TEST at Step 3 ("Damage Type : Missing required field",
 * witness "Name : Missing required field" — CONFIRMED 2026-10-22 on 4 policies), so the profile is filled with
 *   node scripts/provisionOneIncClaims.js --add PROP_BLDG=HO-PA-01-26-0747949
 * (Building / Coverage A Dwelling exposure, Cause of Loss Fire, insured claimant Charlotte Banks) and claimCheck builds
 * the declared data below (--verify --profiles PROP_BLDG re-checks it).
 */
'use strict';

// fnol is only here so provisionOneIncClaims.js --add accepts the profile; no exposures = never FNOL-created.
const NO_FNOL = { policyType: "Homeowner's", state: 'PA', lossCauseCode: 'LC01', lossDescription: 'not used (pool-only existing HO claim)', incidents: [], exposures: [] };

const data = (fn) => ({ enumerable: true, get: () => fn(require('../testData').D) });
module.exports = {
  PROP_BLDG: {
    label: 'PA homeowners: Building (Coverage A Dwelling) exposure with Cause of Loss Fire + $5,000+ reserve, Contents exposure with reserve, mortgagee + mortgage, a claim document',
    lob: 'PR', state: 'PA', prefix: /^HO-PA-/, poolOnly: true, fnol: NO_FNOL,
  },
};
// Building exposure: Cause of Loss Fire (a roof-question weather/peril cause), reserve big enough for a $5,000.01
// payment plus the $5,000.00 boundary checks the VBR.006 negatives submit; a Contents (Coverage C) exposure with a
// reserve for the $6,000 "not Building Damage" cases; the mortgagee + mortgage (VBR.006 is about the mortgagee); a claim
// document for the payment to link (VBR.010: checks over $1,000 need one).
Object.defineProperty(module.exports.PROP_BLDG, 'data', data((D) => [
  D.causeOfLoss({ exposure: /Building|Dwelling/i, cause: '^Fire$' }),
  D.propertyExposure({ coverage: 'Coverage C Personal Property', cause: /^Fire-Contents$/i, match: /Contents|Personal Property/i }),
  D.exposureOwner({ who: 'Benjamin Smith' }),
  D.reserve({ exposure: /Building/i, amount: 40000, min: 10000.02 }),
  // Contents reserve ≥ $6,000.01 is a CASE need of GCCM-763 TC-018 / GCCM-1003 TC-101 only (recipes/workerK.js) — not
  // profile-wide, or every PROP_BLDG case is blocked when it is missing (2026-10-22).
  D.lienholders({ kind: 'property' }),
  D.document(),
]));
