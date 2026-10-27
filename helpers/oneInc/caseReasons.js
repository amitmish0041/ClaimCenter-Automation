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
  'GCCM-1013/UIF/TC-002': D('Needs a document linked on Step 3 so the Linked Documents grid has a Send Status dropdown; the test claims have no documents and the suite does not upload one yet (with no document the grid is empty)'),
  'GCCM-1013/UIF/TC-011': M(`Needs a tracking number from OneInc (Expedite / Certified delivery) — ${NO_ONEINC}`),
  'GCCM-1013/UIF/TC-013': M(`Needs a direct-deposit (or recurring debit) check with a ClaimsPay Method Id returned by OneInc — ${NO_ONEINC}`),
  'GCCM-1013/UIF/TC-015': M(`Needs OneInc payment feedback with the payee's preferred payment method — ${NO_ONEINC}`),
  'GCCM-1013/UIF/TC-016': M(`Needs a direct-deposit (or recurring debit) check with an account number returned by OneInc — ${NO_ONEINC}`),
  'GCCM-1013/UIF/TC-018': M(`Needs ClaimsPay comments returned by OneInc — ${NO_ONEINC}`),
  'GCCM-1013/UIF/TC-023': M(`Needs a check print date from OneInc (mailed check printed) — ${NO_ONEINC}`),
  'GCCM-1013/VBR/TC-037': D('Needs 2+ earlier Supplemental payments submitted on one exposure whose coverage is medical / wage / funeral (Auto Med Pay, PIP …) — not built yet'),
  'GCCM-1013/VBR/TC-038': D('Needs 2+ earlier Supplemental payments on a WC "Medical Details" exposure — not built yet'),
  'GCCM-1013/VBR/TC-039': D('Needs 2+ earlier Supplemental payments on one non-medical exposure (each needs a closed reserve) — not built yet'),
  'GCCM-1013/VBR/TC-040': D('Needs a policy carrying one of the listed deductible endorsements (WC Marietta / Lemars, GC forms) with Deductible Status not Paid, and an approved supplemental payment'),
  'GCCM-1013/VBR/TC-041': D('Needs a policy carrying one of the listed deductible endorsements and an approved check WITHOUT a supplemental payment'),
  'GCCM-1013/VBR/TC-044': D('Needs a Supplemental payment on a WC "Medical Details" exposure (closed reserve) — not built yet'),
  'GCCM-1013/VBR/TC-045': D('Needs a Supplemental payment on a medical / wage / funeral coverage exposure (Auto Med Pay, PIP …) with a closed reserve — not built yet'),
  'GCCM-1013/VBR/TC-047': D('Needs a person payee with an empty first name on the claim (Parties Involved will not save such a contact from the UI) — not built yet'),
  'GCCM-1013/VBR/TC-060': D('Needs a non-WC claim with a third-party-liability exposure whose claimant is a Medicare beneficiary (Medicare tab) and no ICD codes — not built yet'),
  'GCCM-1013/VBR/TC-061': D('Needs a non-WC third-party-liability exposure with a Medicare-beneficiary claimant and an ICD code on the Medicare tab — not built yet'),
  'GCCM-1013/VBR/TC-068': D('Needs a Lump Sum Medical Extinguishment Date on the exposure — not set on the test claims'),
  'GCCM-1013/VBR/TC-076': M('Needs an Issued mailed check older than 180 days (BA note on the case: dates cannot be manipulated in Cloud)'),
  'GCCM-1013/VBR/TC-077': D('Needs an Address Book vendor with Levy = "Levy Attached" in ContactManager — the ContactManager helper sets Tax ID Valid Until only, not Levy, yet'),
  'GCCM-1013/VBR/TC-082': D('Needs a claim with no assigned user — the test claims are assigned and unassigning one is not built'),
  'GCCM-1013/VBR/TC-090': D('Needs a policy with aggregate limits plus a third-party-liability exposure with a claim cost payment (the automation aggregate-limit claim has a first-party vehicle exposure)'),
  'GCCM-1013/VBR/TC-091': D('Needs a Lump Sum Medical Extinguishment Date on the exposure — not set on the test claims'),
  'GCCM-1013/VBR/TC-093': D('Needs the claimant flagged "Partial or Full Name Unknown" in Parties Involved — not built yet'),
  'GCCM-1013/VBR/TC-094': D('Needs the claimant flagged "Partial or Full Address Unknown" in Parties Involved — not built yet'),
  'GCCM-1013/VBR/TC-099': M('Needs the EnableWCEmploymentStatusValidation switch (system configuration) and a WC claim with no Employment Status'),
  'GCCM-1013/VBR/TC-100': D('Needs a claim that does not pass the "Ability to Pay" validation level — the test claims are kept passing it'),
  'GCCM-1013/VBR/TC-101': M('Needs bulk payments pending on the exposure (Bulk Invoice) — see GCCM-791'),
  'GCCM-1013/INT/TC-103': D('Needs a Utah workers\' comp claim with an indemnity payment — none in the test claim pool'),
  'GCCM-1013/INT/TC-104': D('Needs a Delaware workers\' comp claim with an indemnity payment — none in the test claim pool'),
  'GCCM-1013/INT/TC-105': M('HiMarley case id sent in the OneInc payload (PM_CaseID) — ' + PAYLOAD),
  'GCCM-1013/INT/TC-106': M(DOC_SEND),
  'GCCM-1013/INT/TC-107': M(DOC_SEND),
  'GCCM-1013/INT/TC-108': M(DOC_SEND + ' (needs a linked document that is not stored in ImageRight)'),
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
};

module.exports = { REASONS };
