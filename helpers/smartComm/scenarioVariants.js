/**
 * helpers/smartComm/scenarioVariants.js
 * Assigns each of a template's scenarios a different combination of
 * safe-to-vary "Create New Document" fields (Document Type, Status,
 * Security Type, Return Envelope, Certified Mail) plus a different login
 * user, so a template's (up to
 * MAX_SCENARIOS_PER_TEMPLATE, default 3 — see scenarioService.js) scenarios
 * collectively exercise more of the wizard than always leaving every field
 * at its one hardcoded default.
 *
 * Deliberately NOT combinatorial (every field x every value) — mirrors
 * scenarioService.js's own stated design choice not to test every
 * theoretical combination. Each scenario gets ONE fixed combination from
 * VARIANTS below, cycling by index if a template ever has more scenarios
 * than entries here.
 *
 * Delivery Channel is intentionally left OUT of this rotation — its real
 * options are Email/Fax/SMS/Print (CONFIRMED live), and Email/Fax/SMS can
 * actually contact a real person/number on the claim. Every scenario stays
 * on 'Print' (documentService.setDeliveryChannel's own default), which only
 * ever generates a downloadable PDF with no external side effect.
 *
 * Recipient-party selection (insured vs. claimant vs. attorney) is also
 * left out for now — not every test claim has every party type, so forcing
 * a specific role would spuriously BLOCK/ERROR scenarios on claims that
 * simply don't have that party, rather than testing anything real.
 * documentService.setPrimaryRecipient's existing preferredName/first-
 * eligible logic is unchanged.
 */
'use strict';

// Confirmed live (see the wizard's Additional Data tab) real values for
// each field — picking from the actual option lists, not invented ones.
// returnEnvelope/certifiedMail (Recipients tab, Print-only - see
// documentService.setMailOptions) rotate independently of each other so all
// four Yes/No combinations get covered across the 3 slots, not just the two
// "both same" corners.
const VARIANTS = [
  { documentType: 'Other', status: 'Draft', securityType: 'Unrestricted document', returnEnvelope: true, certifiedMail: true },
  { documentType: 'Letter sent', status: 'Final', securityType: 'Sensitive document', returnEnvelope: false, certifiedMail: true },
  { documentType: 'Form sent', status: 'Approved', securityType: 'Unrestricted document', returnEnvelope: true, certifiedMail: false },
];

// One login per variant slot, read from .env as SMARTCOMM_TEST_USER_<n> /
// SMARTCOMM_TEST_PASS_<n> (1-indexed to match how they'd be listed in
// .env.example). Returns null if a slot isn't configured, so callers can
// fall back to the existing admin login rather than hard-failing a run
// someone hasn't fully set up yet — purely additive/backward compatible.
function userForIndex(index) {
  const n = index + 1;
  const username = process.env[`SMARTCOMM_TEST_USER_${n}`];
  const password = process.env[`SMARTCOMM_TEST_PASS_${n}`];
  if (username && password) return { username, password };
  return null;
}

function getVariantForIndex(index) {
  const base = VARIANTS[index % VARIANTS.length];
  return { ...base, user: userForIndex(index) };
}

module.exports = { getVariantForIndex, VARIANTS };
