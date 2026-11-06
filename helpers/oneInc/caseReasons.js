/**
 * helpers/oneInc/caseReasons.js
 * Case-specific reasons for test cases that are NOT automated, where the keyword rules in classifier.js would give a
 * generic or wrong reason (e.g. "DE/MD PIP claim" for a supplemental-payment rule). Checked by classify() after the
 * recipe lookup. Added 2026-10-27 for GCCM-787 (Void/Stop) and GCCM-1013 (Full Check wizard / Check-Payment Details),
 * after probing cloud TEST: every OneInc check stays "Requesting" (OneInc never issues, clears or reports back on TEST)
 * and only non-OneInc "Requested" checks can be voided.
 */
'use strict';

const NO_ONEINC = 'OneInc does not report back on TEST (every OneInc check stays "Requesting": no External Identifier, One Inc Status or feedback)';
const WEBHOOK = `Needs OneInc to return a status for the check (Stopped / Issued / Success / Cancelled / Error / Stop Pending) — ${NO_ONEINC}, and the suite cannot send the webhook itself`;
const PAYLOAD = 'Checks the payload ClaimCenter sends to OneInc (field cleansing / mapping) — needs integration-log or OneInc-side access, not visible in the ClaimCenter UI';
const DOC_SEND = 'Outcome of sending a linked document to OneInc / retrieving it from ImageRight — integration-side; the document flow does not run on TEST';
const ALLIANCE = 'Needs an Alliance Glass claim (ExtAllianceGlassClaim = TRUE). The flag is on no ClaimCenter screen — Loss Details (view and edit) has no Alliance / glass field (CONFIRMED 2026-10-27) — it is set only when the claim comes in through the Alliance Glass FNOL intake, which UI automation cannot create';

const M = (why) => ({ automation: 'MANUAL', reason: why });
const D = (why) => ({ automation: 'NEEDS_DATA', reason: why });

const REASONS = {

  // ── Former "needs data" cases that stay manual (review 2026-11-03) ──
  ...Object.fromEntries(['GCCM-763/VBR/TC-045', 'GCCM-763/VBR/TC-046', 'GCCM-1003/VBR/TC-128', 'GCCM-1003/VBR/TC-129'].map((id) => [id, D('Needs a TEST policy carrying Extraordinary / Extended Medical Benefits (EMB) coverage, so an exposure can have that Primary Coverage — none is known on TEST (the negatives without EMB are automated)')])),
  ...Object.fromEntries(['GCCM-763/VBR/TC-054', 'GCCM-763/VBR/TC-061', 'GCCM-1003/VBR/TC-137', 'GCCM-1003/VBR/TC-144'].map((id) => [id, D('Needs an earlier First and Final / Final Payment in status "Paid" on the exposure — on TEST payments never get past Awaiting submission / Requesting (OneInc does not report back). BA decision needed on whether "Awaiting submission" counts as active (2026-10-21: a second First and Final was accepted while the first was Awaiting submission)')])),
  ...Object.fromEntries(['GCCM-763/VBR/TC-055', 'GCCM-1003/VBR/TC-138'].map((id) => [id, D('Needs an earlier First and Final in status "Voided" — Void is enabled only on "Requested" checks, and a new check becomes Requested only after OneInc acknowledges it, which OneInc does not do on TEST')])),
  ...Object.fromEntries(['GCCM-763/VBR/TC-062', 'GCCM-1003/VBR/TC-145'].map((id) => [id, D('Needs an earlier Final Payment in status "Rejected" — rejecting needs the approver\'s own login (the pending payment\'s activity assignee), whose password the automation does not hold')])),
  ...Object.fromEntries(['GCCM-1003/VBR/TC-193', 'GCCM-803/TC/TC-049'].map((id) => [id, D('Needs a Personal Auto policy in force on a loss date before 1/1/2013 — no such policy on TEST, so the Loss Date cannot be moved to 12/31/2012')])),
  ...Object.fromEntries(['GCCM-1003/CPD/TC-210', 'GCCM-1003/CPD/TC-211', 'GCCM-759/CPD/TC-033', 'GCCM-759/CPD/TC-034'].map((id) => [id, D('Needs to know who the "Payment Approver" is on a payment and an active TEST user in that role with NO email and NO phone (candidate: Jacob Erdman) — ask the BA how the approver is determined')])),
  // ── GCCM-787 Void/Stop ──
  'GCCM-787/TC/TC-009': D(`Needs a Cleared check to repost — ${NO_ONEINC}, so no check on TEST is ever Cleared`),
  'GCCM-787/TC/TC-012': D('Same as TC-011 on an Expense line: an issued Partial expense check plus a Final expense payment Awaiting Submission — not built yet'),
  'GCCM-787/TC/TC-013': D('Needs an issued Supplemental check plus a Final payment Pending Approval on the same line; a Supplemental needs a closed reserve and a Final payment an open one, so the pair needs the approval workflow — not built yet'),
  'GCCM-787/TC/TC-014': D('Same as TC-013 for the Expense cost type — not built yet'),
  'GCCM-787/TC/TC-017': M(`Needs an open digital_payment_failed_to_send activity, which CC creates only when sending a linked document to OneInc fails — ${DOC_SEND}`),
  'GCCM-787/TC/TC-018': M('Needs a completed digital_payment_failed_to_send activity (document send failure) — see TC-017'),
  'GCCM-787/TC/TC-019': M('Needs a digital_payment_failed_to_send activity on another check — see TC-017'),
  'GCCM-787/TC/TC-021': M(`Needs a check issued by OneInc (status Issued) — ${NO_ONEINC}, and Void is disabled on Requesting checks`),
  ...Object.fromEntries(['022', '023', '024', '025', '026', '027', '028', '029', '030', '031', '032', '033'].map((n) => [`GCCM-787/TC/TC-${n}`, M(WEBHOOK)])),

  // ── GCCM-1013 Full Check wizard / Check-Payment Details ──
  'GCCM-1013/UIF/TC-011': M(`Needs a tracking number from OneInc (Expedite / Certified delivery) — ${NO_ONEINC}`),
  'GCCM-1013/UIF/TC-013': M(`Needs a direct-deposit (or recurring debit) check with a ClaimsPay Method Id returned by OneInc — ${NO_ONEINC}`),
  'GCCM-1013/UIF/TC-015': M(`Needs OneInc payment feedback with the payee's preferred payment method — ${NO_ONEINC}`),
  'GCCM-1013/UIF/TC-016': M(`Needs a direct-deposit (or recurring debit) check with an account number returned by OneInc — ${NO_ONEINC}`),
  'GCCM-1013/UIF/TC-018': M(`Needs ClaimsPay comments returned by OneInc — ${NO_ONEINC}`),
  'GCCM-1013/UIF/TC-023': M(`Needs a check print date from OneInc (mailed check printed) — ${NO_ONEINC}`),
  'GCCM-1013/VBR/TC-040': D('Needs a policy carrying one of the listed deductible endorsements (WC Marietta / Lemars, GC forms) with Deductible Status not Paid, and an approved supplemental payment'),
  'GCCM-1013/VBR/TC-041': D('Needs a policy carrying one of the listed deductible endorsements and an approved check WITHOUT a supplemental payment'),
  'GCCM-1013/VBR/TC-076': M('Needs an Issued mailed check older than 180 days (BA note on the case: dates cannot be manipulated in Cloud)'),
  'GCCM-1013/VBR/TC-082': D('Needs a claim with no assigned user — the test claims are assigned and unassigning one is not built'),
  'GCCM-1013/VBR/TC-093': M('The claimant\'s "Partial or Full Name Unknown" flag is on no cloud screen — Parties Involved › claimant › Edit and New Contact › Person have no such field (CONFIRMED 2026-11-03), so the precondition cannot be set'),
  'GCCM-1013/VBR/TC-094': M('The claimant\'s "Partial or Full Address Unknown" flag is on no cloud screen — Parties Involved › claimant › Edit and New Contact › Person have no such field (CONFIRMED 2026-11-03), so the precondition cannot be set'),
  'GCCM-1013/VBR/TC-099': M('Needs the EnableWCEmploymentStatusValidation switch (system configuration) and a WC claim with no Employment Status'),
  'GCCM-1013/VBR/TC-101': M('Needs bulk payments pending on the exposure (Bulk Invoice) — see GCCM-791'),
  'GCCM-1013/INT/TC-103': D('Needs a Utah workers\' comp claim with an indemnity payment — none in the test claim pool'),
  'GCCM-1013/INT/TC-104': D('Needs a Delaware workers\' comp claim with an indemnity payment — none in the test claim pool'),
  'GCCM-1013/INT/TC-105': M('HiMarley case id sent in the OneInc payload (PM_CaseID) — ' + PAYLOAD),
  'GCCM-1013/INT/TC-106': M(DOC_SEND),
  'GCCM-1013/INT/TC-107': M(DOC_SEND),
  'GCCM-1013/INT/TC-109': M(DOC_SEND),
  'GCCM-1013/INT/TC-110': M(DOC_SEND),
  'GCCM-1013/INT/TC-111': M(DOC_SEND),
  'GCCM-1013/INT/TC-112': M(DOC_SEND),
  ...Object.fromEntries(['113', '114', '115', '116', '117', '118', '119', '120', '121', '122', '123', '124', '125', '126', '127'].map((n) => [`GCCM-1013/INT/TC-${n}`, M(PAYLOAD)])),
  'GCCM-1013/INT/TC-128': M(WEBHOOK.replace('a status', 'a ClaimsPay Data Change webhook')),
  'GCCM-1013/INT/TC-129': M('Compares the e-mail / phone sent to OneInc on new vs existing payments after editing the payment contact details — ' + PAYLOAD),
  'GCCM-1013/APD/TC-134': M(`"Get Payment Status" must pull the latest status from OneInc — ${NO_ONEINC} (and Cloud shows a "Refresh" button instead, see TC-133)`),
  'GCCM-1013/APD/TC-135': M(WEBHOOK.replace('a status', 'a ClaimsPay Data Change webhook')),

  // ── Manual → automated sweep 2026-10-27 (recipes/manualToAuto.js): the cases of those groups that stay manual ──
  'GCCM-803/TC/TC-025': M(ALLIANCE),
  'GCCM-1003/VBR/TC-170': M(ALLIANCE),
  'GCCM-1003/VBR/TC-088': M('Quick Payment pays ONE reserve line (the Financials row it is opened from) and has no "Add Payment" (CONFIRMED 2026-10-27), so a claim cost and an expense cannot be put on one Quick check and VBR.003 cannot be reached there — BA: confirm the case does not apply to Quick Payment. The rule itself is automated on the Full Check wizard (GCCM-763 VBR TC-006)'),
  // ── Manual → automated sweep 2026-11-05 (recipes/manualSweep.js): the cases of those groups that stay manual ──
  // Quick Payment opens from an existing Financials reserve row, so it cannot pay an exposure with no reserve, a claim-level
  // line, or a NEW reserve line — the Full Check versions of these rules are automated (GCCM-763 / GCCM-803).
  'GCCM-763/VBR/TC-038': M('Every new exposure on TEST gets a $1,000 Claim Cost reserve as it is created (PD Liability - Other than Vehicle Damage, 4 claims on 2026-11-05: PA-PA-01-26-0749019/21/24/27), so an exposure with NO reserve history cannot be built; needs an existing exposure that has never been reserved, or BA confirmation of how to create one.'),
  'GCCM-1003/VBR/TC-121': M('Quick Payment opens only from an existing Financials reserve row, so it cannot pay an exposure with NO prior reserve history (the precondition). The Full Check case (GCCM-763 TC-038) is automated — BA: confirm whether this Quick Payment case applies'),
  'GCCM-1003/VBR/TC-134': M('Quick Payment opens only from an exposure reserve row — there is no claim-level row to open it from, and the Full Check refuses a claim-level line with "Missing required field Exposure" (GCCM-763 TC-051/052 finding). BA: confirm whether this Quick Payment case applies'),
  'GCCM-1003/VBR/TC-135': M('Quick Payment opens only from an exposure reserve row — there is no claim-level row to open it from, and the Full Check refuses a claim-level line with "Missing required field Exposure" (GCCM-763 TC-051/052 finding). BA: confirm whether this Quick Payment case applies'),
  'GCCM-1003/VBR/TC-160': M('Quick Payment has no new-reserve-line option (it pays the Financials row it is opened from), so VBR.027 "new reserve line within the wizard" cannot be reached. The Full Check case (GCCM-803 TC-015) is automated — BA: confirm whether this Quick Payment case applies'),
  'GCCM-1003/VBR/TC-161': M('Quick Payment has no new-reserve-line option (it pays the Financials row it is opened from), so VBR.027 "new reserve line within the wizard" cannot be reached. The Full Check case (GCCM-803 TC-016) is automated — BA: confirm whether this Quick Payment case applies'),
  ...Object.fromEntries(['GCCM-1003/CPD/TC-213', 'GCCM-1003/CPD/TC-215', 'GCCM-759/CPD/TC-036', 'GCCM-759/CPD/TC-038'].map((id) => [id,
    M('Needs the payment to be part of an ACTIVE check recurrence with a stored OneInc payment token (CPD.007) — a stored token comes from OneInc, which does not report back on TEST. The no-recurrence default (TC-212/214, TC-035/037) is automated')])),
  'GCCM-1008/APD/TC-008': M(`Needs a DIGITAL payment (ACH / debit / prepaid / virtual card) and a PayPal or Venmo one — the method is chosen by the payee on OneInc's side; ${NO_ONEINC}`),
  'GCCM-1008/APD/TC-011': M(`Needs a mortgagee payment with Monitored = Yes — "Monitored" comes back in OneInc's Payment Feedback (Additional Payment Details › Payment Feedback Received › Monitored); ${NO_ONEINC}`),
  'GCCM-1008/APD/TC-012': M(`Needs a mortgagee payment with Monitored = No where the contact chose Direct Deposit / Direct to Debit on OneInc's side; ${NO_ONEINC}`),
};

module.exports = { REASONS };
