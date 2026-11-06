/**
 * helpers/oneInc/profiles/existingClaims.js — EXISTING TEST claims found by search (helpers/oneInc/ccSearch.js, user direction
 * 2026-11-06: "search for existing claims matching conditions") for cases whose data the suite cannot build: an unassigned
 * claim, a pre-2013 personal auto loss, a Cleared check, WC Utah / Delaware indemnity, and earlier First and Final / Final
 * payments in a given status. No `fnol`, so runOneInc never files a claim for them; seeds are tried in order. Each seed was
 * read on 2026-11-06 (Summary exposures + Financials › Transactions › payment details) — the evidence is in the comment.
 */
'use strict';

const base = (label, lob, state, prefix, seed) => ({ label, lob, state, prefix, poolOnly: true, seed });
module.exports = {
  // Adjuster "Pending Assignment" (Search › Claims, Pending Assignment = Yes, Open).
  EX_UNASSIGNED: base('Existing open claim with no assigned user (Pending Assignment)', 'GL', 'TN', /^[A-Z]{2,4}-/,
    ['CAS-TN-03-21-0736981', 'CAS-TN-03-21-0737876', 'HOC-TN-03-20-0736243']),
  // Personal auto (legacy PAC policies), losses 2007–2009. PAC-GA-03-09-0090735's exposure owner John Tallent has no e-mail/phone, so
  // Quick Payment stops on "Exposure owner … is missing …" (2026-11-06) — the Maria Lopez claims come first.
  EX_PRE2013: base('Existing personal auto claim with a loss date before 1/1/2013', 'AUTO', 'LA', /^PA[A-Z]?-/, ['PAC-LA-03-07-0019034', 'PAC-LA-03-08-0023101', 'PAC-GA-03-09-0090735']),
  // Cleared checks: PA-IN-04-23-0741485 8200001474 ($125) / 8200001488 ($25); WC-PA-01-20-0735633 9638527415 ($200,000 First and Final).
  // Each run voids one, so the seeds run out after three runs. A void is refused while the claim has payments pending approval
  // ("A reserve change cannot be processed now…" — PA-IN-04-23-0741485 has some, 2026-11-06), so the WC claim comes first.
  EX_CLEARED: base('Existing claim holding a Cleared check', 'WC', 'PA', /^[A-Z]{2,4}-/, ['WC-PA-01-20-0735633', 'PA-IN-04-23-0741485']),
  // WC with an Indemnity (Lost Wages) exposure: Utah $4,000 reserve (Raju Mohan, adjuster Benjamin Smith); Delaware $4,000 reserve.
  EX_WC_UT: base('Existing Utah WC claim with an Indemnity exposure', 'WC', 'UT', /^WC-UT-/, ['WC-UT-90-25-0746427', 'WC-UT-90-25-0746412']),
  EX_WC_DE: base('Existing Delaware WC claim with an Indemnity exposure', 'WC', 'DE', /^WC-DE-/, ['WC-DE-01-22-0740712']),
  // An active First and Final on an exposure: PAF-IN-04-25-0746136 BI exposure (1) First and Final 12830176 "Requested";
  // WC-PA-01-20-0735633 Employer Liability (1) First and Final 9638527415 "Cleared".
  EX_FF_ACTIVE: base('Existing claim with an active First and Final on an exposure', 'AUTO', 'IN', /^[A-Z]{2,4}-/, ['PAF-IN-04-25-0746136', 'WC-PA-01-20-0735633']),
  // Reinsurance claims named by the user 2026-11-06; "Reported to Reinsurer?" already Yes on these (read 2026-11-06).
  EX_REINS: base('Reinsurance claim (user-provided) with Reported to Reinsurer? = Yes', 'AUTO', 'PA', /^[A-Z]{2,4}-/,
    ['CAA-PA-01-26-0748098', 'WC-MD-01-18-0734261', 'CXS-VA-02-26-0748111', 'CPR-IL-60-26-0747921', 'PAR-NE-60-17-0640232']),
  // A REJECTED Final Payment: CAA-VA-02-13-0375082 Vehicle (1); PAF-VA-02-16-0571898 Vehicle (4).
  EX_FINAL_REJ: base('Existing claim with a Rejected Final Payment on an exposure', 'AUTO', 'VA', /^[A-Z]{2,4}-/, ['CAA-VA-02-13-0375082', 'PAF-VA-02-16-0571898']),
};
