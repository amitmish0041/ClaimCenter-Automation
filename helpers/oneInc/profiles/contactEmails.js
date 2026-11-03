/**
 * helpers/oneInc/profiles/contactEmails.js
 * Every new test claim gets the QA mailbox on all contacts (helpers/oneInc/contactEmails.js, user direction 2026-11-03).
 * AUTO_PA_NOEMAIL is the same new PA personal auto claim WITHOUT that step, for the cases that need a payee with no
 * payment contact details (CPD.001 "no e-mail on contact", VBR.001 warning) — recipes/zz_contactEmails.js moves them here.
 */
'use strict';

module.exports = {
  AUTO_PA_NOEMAIL: { label: 'PA personal auto, contacts left WITHOUT e-mail / payment contact details (CPD.001, VBR.001)', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true,
    fnolAs: 'AUTO_PA', contactEmails: false },
};
