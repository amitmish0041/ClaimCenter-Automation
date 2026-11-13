/**
 * helpers/oneInc/profiles/priorPayments.js — fresh PA personal auto claims (AUTO_PA FNOL), one per case: each case builds
 * an earlier payment on it (helpers/oneInc/priorPayments.js — voided First and Final, rejected Final, Final left
 * unsubmitted next to an issued Partial / Supplemental), which spends or closes reserve lines, so no claim is shared.
 */
'use strict';

const base = (label) => ({ label, lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true, fnolAs: 'AUTO_PA' });
module.exports = {
  // A policy with a Secondary Named Insured (VI QUAN): an insured payment without the SNI selected is held "Pending approval"
  // (CC rule, CONFIRMED 2026-11-13) — the cases that need a pending / rejected Final Payment.
  PRIOR_PA_SNI: { ...base('New PA auto claim on policy 1002231610 (Secondary Named Insured VI QUAN) — an insured payment is held Pending approval'), policies: ['1002231610'] },
  PRIOR_PA: base('New PA personal auto claim on which the case builds its earlier payment (voided F&F / rejected Final / unsubmitted Final)'),
};
