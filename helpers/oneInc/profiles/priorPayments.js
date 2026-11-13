/**
 * helpers/oneInc/profiles/priorPayments.js — fresh PA personal auto claims (AUTO_PA FNOL), one per case: each case builds
 * an earlier payment on it (helpers/oneInc/priorPayments.js — voided First and Final, rejected Final, Final left
 * unsubmitted next to an issued Partial / Supplemental), which spends or closes reserve lines, so no claim is shared.
 */
'use strict';

const base = (label) => ({ label, lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true, fnolAs: 'AUTO_PA' });
module.exports = {
  PRIOR_PA: base('New PA personal auto claim on which the case builds its earlier payment (voided F&F / rejected Final / unsubmitted Final)'),
};
