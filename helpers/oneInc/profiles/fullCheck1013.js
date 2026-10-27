/**
 * helpers/oneInc/profiles/fullCheck1013.js — claim profile for the GCCM-1013 missing-payee / Secondary Named Insured
 * cases (VBR.044, VBR.064, VBR.069–074, UIF.078/079/096/101–106; added 2026-10-27).
 *
 * The cases need an HO claim whose policy carries BOTH an Insured and a Secondary Named Insured. Policy 1002228777
 * (TEST) does (Insured Robert Charles, SNI David Thomas — CONFIRMED 2026-10-27), so fresh claims are filed on it
 * (`policies`), with the PROP_PA FNOL. `shareFresh`: one new claim per run serves every HO case — they look at
 * warnings / the worksheet / one check, and a policy's claimant numbers run out if each case files its own claim.
 */
'use strict';

module.exports = {
  HO_SNI: {
    label: 'PA homeowners claim on a policy with an Insured and a Secondary Named Insured',
    lob: 'PR', state: 'PA', prefix: /^HO-PA-/, poolOnly: true, fnolAs: 'PROP_PA', policies: ['1002228777'], shareFresh: true,
    seed: ['HO-PA-01-26-0748434'],
  },
};
