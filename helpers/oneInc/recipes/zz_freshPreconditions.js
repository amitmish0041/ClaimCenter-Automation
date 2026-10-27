/**
 * helpers/oneInc/recipes/zz_freshPreconditions.js — loaded LAST (file name), after every recipe file.
 *
 * Fresh-data audit (2026-10-27): every run now files NEW claims, so a recipe may not lean on state an old claim
 * happened to carry. This adds the missing precondition steps to the recipes that did:
 *  - a reserve line with $0 remaining ({ reserve: 'zero' } / a Quick Payment opened on a $0 row): a new claim has none,
 *    so a small Final Payment closes one first (checkOps.closeReserveLine);
 *  - a check already on the claim (openFirstRow 'check'): a new claim has none, so one is created first.
 * Applied by inspecting the recipe, so recipes added later get the same treatment.
 */
'use strict';

module.exports = (api) => {
  const { R } = api;
  const ZERO = { call: ['checkOps.closeReserveLine'] };
  const A_CHECK = { call: ['checkOps.openOrCreateCheck', {}, { payee: 'claimant' }] };
  const usesZero = (s) => (s.reserve === 'zero') || (s.open === 'quick' && s.zeroReserve) || (Array.isArray(s.call) && s.call.includes('zero'));
  // Only claim types runOneInc creates fresh; existing-claim profiles (aged DE/MD, PROP_BLDG, …) keep their own data —
  // closing a line there would break their declared reserves.
  const PROFILES = require('../claimPicker').PROFILES;
  const freshable = (p) => { const P = PROFILES[p] || {}; return ['AUTO_PA', 'AUTO_MI', 'WC_PA', 'PROP_PA', 'PROP_MORT', 'AUTO_LIEN'].includes(p) || !!P.fnolAs || !!(P.fnol && (P.fnol.exposures || []).length); };
  for (const [id, r] of Object.entries(R)) {
    if (!freshable(r.profile)) continue;
    const steps = r.steps || [];
    if (steps.some(usesZero) && !steps.some((s) => Array.isArray(s.call) && s.call[0] === 'checkOps.closeReserveLine')) {
      r.steps = [ZERO, ...steps];
      r.notes = [r.notes, 'Precondition built on the fresh claim: a $1.4x Final Payment closes a Claim Cost line first, so a line with $0 remaining exists.'].filter(Boolean).join(' ');
    }
    if (steps.some((s) => s.openFirstRow === 'check')) {
      r.steps = [A_CHECK, ...r.steps];
      r.notes = [r.notes, 'Precondition built on the fresh claim: a $1.4x check is created first when the claim has none.'].filter(Boolean).join(' ');
    }
    void id;
  }
};
