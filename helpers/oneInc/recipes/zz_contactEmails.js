/**
 * helpers/oneInc/recipes/zz_contactEmails.js — loaded after the recipe files (name), before zz_freshPreconditions.
 *
 * Every new test claim now has the QA mailbox on all contacts (helpers/oneInc/contactEmails.js, 2026-11-03), so the
 * "Payees other than vendor should have the payment contact details" warning no longer shows on them. Recipes that need
 * that warning (a payee WITHOUT payment contact details: CPD.001, VBR.001) move from AUTO_PA to AUTO_PA_NOEMAIL, the same
 * claim without the e-mail step. Detected from the recipe (a `require`/`text` check that the warning IS present), so
 * recipes added later get the same treatment.
 */
'use strict';

module.exports = (api) => {
  const { R, NO_CONTACT_DETAILS } = api;
  const needsWarning = (s) => s && ((s.require && s.require.warning && s.require.warning.source === NO_CONTACT_DETAILS.source && s.require.present !== false)
    || (s.text && s.text.re && s.text.re.source === NO_CONTACT_DETAILS.source && s.text.present));
  for (const r of Object.values(R)) {
    if (r.profile !== 'AUTO_PA') continue;
    if (![...(r.steps || []), ...(r.checks || [])].some(needsWarning)) continue;
    r.profile = 'AUTO_PA_NOEMAIL';
    r.notes = [r.notes, 'Claim made WITHOUT the QA e-mail step, so the payee has no payment contact details.'].filter(Boolean).join(' ');
  }
};
