/**
 * helpers/oneInc/profiles/void787.js — claim profile for the GCCM-787 Void/Stop cases (added 2026-10-27).
 *
 * Void is enabled only on a "Requested" check, and a check reaches Requested only when OneInc acknowledges it — which
 * OneInc does not do on TEST (user confirmation 2026-10-27; the Financials Escalation batch only takes a new check to
 * "Requesting"). A brand-new claim can therefore never carry a voidable check, so this profile is the documented
 * exception to fresh test data: it runs on the existing TEST claims that still hold Requested checks (and the Pending
 * void checks earlier voids left). No `fnol`, so runOneInc never tries to create one. Seeds are tried in order.
 */
'use strict';

module.exports = {
  VOID_PA: {
    label: 'Existing TEST claim holding a Requested (voidable) check',
    lob: 'AUTO', state: 'PA', prefix: /^PA-/, poolOnly: true,
    seed: ['PA-DE-01-24-0744728', 'HO-PA-01-26-0748434', 'PA-PA-01-26-0748498', 'PA-PA-01-26-0748460', 'PA-PA-01-26-0748443'],
  },
};
