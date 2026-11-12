/**
 * helpers/oneInc/caseReasons.js
 * Case-specific reasons for test cases that are NOT automated, where the keyword rules in classifier.js would give a
 * generic or wrong reason (e.g. "DE/MD PIP claim" for a supplemental-payment rule). Checked by classify() after the
 * recipe lookup. Added 2026-10-27 for GCCM-787 (Void/Stop) and GCCM-1013 (Full Check wizard / Check-Payment Details),
 * after probing cloud TEST: every OneInc check stays "Requesting" (OneInc never issues, clears or reports back on TEST)
 * and only non-OneInc "Requested" checks can be voided.
 */
'use strict';

const NO_ONEINC = 'OneInc reports back on TEST only after the payee acts on the payee portal (texted code to the payee mobile — see scripts/oneIncPayeePrep.js) or a check is printed/shipped'; // was "never reports back" until 2026-11-12
const WEBHOOK = `Needs OneInc to return a status for the check (Stopped / Issued / Success / Cancelled / Error / Stop Pending) — ${NO_ONEINC}, and the suite cannot send the webhook itself`;
const PAYLOAD = 'Checks the payload ClaimCenter sends to OneInc (field cleansing / mapping) — needs integration-log or OneInc-side access, not visible in the ClaimCenter UI';
const DOC_SEND = 'Needs a linked document whose send to OneInc FAILS (Failed to Send / Failed Retrieval from IR / Over Size Limit). The document flow runs on TEST (CONFIRMED 2026-11-06): a NON-ImageRight document or a SmartCOMM letter gives "Not an IR document", an ImageRight document "Sent Successfully" (TC-108 / TC-109 automated) — no failing document is known yet (e.g. an ImageRight document over the OneInc size limit, or one missing from ImageRight)';
const ALLIANCE = 'Needs an Alliance Glass claim (ExtAllianceGlassClaim = TRUE). The flag is on no ClaimCenter screen — Loss Details (view and edit) has no Alliance / glass field (CONFIRMED 2026-10-27) — it is set only when the claim comes in through the Alliance Glass FNOL intake, which UI automation cannot create';

const M = (why) => ({ automation: 'MANUAL', reason: why });
const D = (why) => ({ automation: 'NEEDS_DATA', reason: why });

const REASONS = {

  // ── GCCM-791 / 1013 VBR.097 — admin access the TEST logins do not have (checked 2026-11-11, user approved the changes) ──
  ...Object.fromEntries(['GCCM-791/TC/TC-001', 'GCCM-791/TC/TC-002'].map((id) => [id, M('Needs a ClaimCenter login with Administration › Users and Security › Roles (add/edit roles and permissions). The TEST admin login has no Roles screen (Administration offers only Requiring Approval, Business Settings, Utilities, Testing Pages — checked 2026-11-11). Give such a login and the case is automated with the permission change reverted afterwards.')])),
  'GCCM-791/TC/TC-004': M('Needs a TEST login that HAS the Bulk Invoice Payer role but NOT the "Create OneInc Bulk Invoice" permission (or a Roles-admin login to remove it temporarily). The standard TEST user has the permission (OneInc is offered — TC-003).'),
  'GCCM-1013/VBR/TC-099': M('Needs the EnableWCEmploymentStatusValidation script parameter switched to Yes. Script parameters are not on the Administration menu of the TEST admin login (checked 2026-11-11) — needs a login with Script Parameters access (the switch is reverted afterwards).'),

  // ── INT.001/002 company name + disclaimer: automated on the OneInc portal (recipes/oneIncPortal.js) except these two companies ──
  ...Object.fromEntries(['GCCM-1003/INT/TC-202', 'GCCM-803/TC/TC-058', 'GCCM-1003/INT/TC-207', 'GCCM-803/TC/TC-063'].map((id) => [id, D('Needs a TEST claim whose policy has the Underwriting Company is Sheboygan Falls Insurance Company (TC-202 / TC-058) or Mountain States Commercial Insurance Company (TC-207 / TC-063) — none found 2026-11-11 (OneInc portal payments + Policy screens of WI / AZ / NM / UT claims). Give a policy or claim number and the case runs like the other companies (recipes/oneIncPortal.js).')])),

  // ── Former "needs data" cases that stay manual (review 2026-11-03) ──
  ...Object.fromEntries(['GCCM-763/VBR/TC-045', 'GCCM-763/VBR/TC-046', 'GCCM-1003/VBR/TC-128', 'GCCM-1003/VBR/TC-129'].map((id) => [id, D('Needs a TEST policy carrying Extraordinary / Extended Medical Benefits (EMB) coverage, so an exposure can have that Primary Coverage — none is known on TEST (the negatives without EMB are automated)')])),
  ...Object.fromEntries(['GCCM-1003/VBR/TC-137', 'GCCM-1003/VBR/TC-144'].map((id) => [id, D('Needs an earlier First and Final / Final Payment in status "Paid" on the exposure — on TEST payments never get past Awaiting submission / Requesting (OneInc does not report back). BA decision needed on whether "Awaiting submission" counts as active (2026-10-21: a second First and Final was accepted while the first was Awaiting submission)')])),
  ...Object.fromEntries(['GCCM-763/VBR/TC-055', 'GCCM-1003/VBR/TC-138'].map((id) => [id, D('Needs an earlier First and Final in status "Voided" (none found searching TEST Voided checks 2026-11-06 — only voided Partial / Final / Supplemental payments) — Void is enabled only on "Requested" checks, and a new check becomes Requested only after OneInc acknowledges it, which OneInc does not do on TEST')])),
  ...Object.fromEntries(['GCCM-763/VBR/TC-062', 'GCCM-1003/VBR/TC-145'].map((id) => [id, D('Needs an earlier Final Payment in status "Rejected" on an exposure that still has an OPEN reserve. Searched TEST 2026-11-06 (Search › Checks/Payments, Status Rejected): the claims with a Rejected Final Payment (CAA-VA-02-13-0375082, PAF-VA-02-16-0571898) have every exposure closed and a reserve cannot be added back; a new one needs the approver login to reject a pending Final Payment')])),
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
  // Venmo (TC-023/024): OneInc UAT refuses a Venmo acceptance ("invalid credentials or the bank not allowing this transaction", 2026-11-12,
  // screenshot Evidence/payee-portal) and the business note says there is no Venmo sandbox — covered by the PayPal case TC-025.
  ...Object.fromEntries(['023', '024'].map((n) => [`GCCM-787/TC/TC-${n}`, M('Venmo cannot be accepted on the OneInc UAT payee portal (refused 2026-11-12; business note: no Venmo sandbox, only PayPal, same setup) — covered by GCCM-787 TC-025 (PayPal Stopped → Voided)')])),
  // TC-026/027: after a ClaimCenter void OneInc UAT always answers Stopped (3 voids 2026-11-12) — the Issued / Success stop-failure replies need OneInc.
  'GCCM-787/TC/TC-030': M('A multi-payee (joint) check defaults to ClaimsPay Type "Other / Mailed Check" — OneInc issues it as a mailed check with no payee e-mail, so no payee can reject it on the payee portal (PA-PA-01-26-0749348, check 8200007500, 2026-11-12). Needs a multi-payee DIGITAL payment, which ClaimCenter does not offer'),
  ...Object.fromEntries(['026', '027'].map((n) => [`GCCM-787/TC/TC-${n}`, M('Needs OneInc to answer a void with a stop FAILURE (Issued / Success) — OneInc UAT stopped every voided check on 2026-11-12; ask OneInc to send that status')])),

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
