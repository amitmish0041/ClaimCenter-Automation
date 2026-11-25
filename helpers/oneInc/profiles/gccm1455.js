/**
 * helpers/oneInc/profiles/gccm1455.js — GCCM-1455 TC-002 (Insured + Additional Insured joint payees, 2026-11-25).
 * No policy in the team's Test_Data_Policy_and_Claims list shows an "Additional Insured" role on its claims; the nearest
 * is Commercial Auto WI 1002057877 (claim CA-WI-60-26-0748966: Scott Adams + Ricky Hughes, "Additional Named Insured").
 */
'use strict';
module.exports = {
  CA_WI_ANI: {
    label: 'WI commercial auto on a policy with Additional Named Insureds', lob: 'AUTO', state: 'WI', prefix: /^CA-WI-/, poolOnly: true,
    policies: ['1002057877'], shareFresh: true,
    // Expired 03/27/2026 (term 03/27/2025–03/27/2026, PolicyCenter TEST 2026-11-25): claims are filed with a loss date in that term.
    allowOldTerm: true,
    seed: ['CA-WI-60-26-0749699'], // TC-002 PASS 2026-11-25 (a 2nd FNOL on this policy stuck at Find Policy — rerun with --reuse-claims)
    fnol: { policyType: 'Commercial Auto', state: 'WI', lossCauseCode: 'LC15', lossDescription: 'OneInc automation — GCCM-1455 insured + additional named insured',
      incidents: ['Add Vehicle'], exposures: [{ coverageLabel: 'Collision' }] },
  },
};
