/**
 * helpers/smartComm/claimSummaryService.js
 * Captures known-good field values directly off a ClaimCenter claim's own
 * Summary screen — CONFIRMED live 2026-09-04, right after opening it — so
 * ANY claim (whether matched from testDataService's real claim inventory or
 * typed into the Runner UI's manual Claim # override) has real insured
 * name, loss date, loss location, claimant name, policy number, and
 * underwriting company available for dynamicValueMatch requirements,
 * without needing to be hand-seeded first. Live-captured values always win
 * over a seeded testData record when both exist — see validationService's
 * merge — comparisons should be against what a claim actually has right
 * now, not a value that can go stale.
 *
 * Deliberately does NOT capture the claim's assigned adjuster (the "Adj:"
 * info-bar field) as a stand-in for "From Name"/"Claim Representative" —
 * CONFIRMED live 2026-09-04: those "From ..." template fields are the
 * DOCUMENT'S SENDER (whoever is actually logged in generating it), not the
 * claim's assigned handler. The two only look the same when the account
 * generating a document also happens to be the assigned adjuster (true
 * when testing as "su") — switching the login to a different real user not
 * assigned to the test claim made that assumption visibly wrong (the
 * generated letter's signature line went completely blank). All "From ..."
 * fields, Name included, now source from the SmartCOMM payload's own
 * <from_ext> block instead (payloadService), which tracks the actual
 * sender correctly regardless of who's logged in.
 */
'use strict';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The info bar/Loss Details section render a date as "08/27/2026", but the
// generated PDF itself renders the equivalent date as "August 27, 2026"
// (CONFIRMED live, matches how templateRequirementService's date shape
// already recognizes both forms) — used as a literal dynamicValueMatch
// string, the raw captured form would never actually be found in the
// document. Convert to the long form so the comparison is apples-to-apples.
function toLongDateFormat(mmddyyyy) {
  const m = String(mmddyyyy || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return mmddyyyy;
  const month = MONTH_NAMES[parseInt(m[1], 10) - 1];
  if (!month) return mmddyyyy;
  return `${month} ${String(parseInt(m[2], 10)).padStart(2, '0')}, ${m[3]}`;
}

// The info bar's "Ins:" / "DoL:" and the Loss Details section's "Loss
// Location" all follow the same layout: the label is its own line, the
// value is the line right after it — CONFIRMED live, no colon on Loss
// Details' own labels though the info bar's do have one, so both forms
// are tried.
function extractLabelValue(text, label) {
  const lines = String(text || '').split('\n').map(l => l.trim());
  const idx = lines.findIndex(l => l === label || l === label + ':');
  if (idx === -1 || idx + 1 >= lines.length) return undefined;
  return lines[idx + 1].trim() || undefined;
}

async function captureClaimSummary(page) {
  const bodyText = await page.locator('body').innerText().catch(() => '');

  const insuredName = extractLabelValue(bodyText, 'Ins:');
  const lossDate = toLongDateFormat(extractLabelValue(bodyText, 'DoL:'));

  // "Loss Details" appears twice — once as the left-nav link (first), once
  // as the real section heading (last) — scope the label lookup to
  // whatever follows the LAST occurrence so it reads the actual section,
  // not the nav.
  const lossDetailsIdx = bodyText.lastIndexOf('Loss Details');
  const lossDetailsSection = lossDetailsIdx === -1 ? '' : bodyText.slice(lossDetailsIdx, lossDetailsIdx + 800);
  const lossLocation = extractLabelValue(lossDetailsSection, 'Loss Location');

  const policyNumber = extractLabelValue(bodyText, 'Pol:');

  // "Underwriting Company" sits under Summary > Basics — CONFIRMED live,
  // unlike "Loss Details" this label isn't duplicated by a nav link, so a
  // plain first-occurrence lookup is enough.
  const underwritingCompany = extractLabelValue(bodyText, 'Underwriting Company');

  let claimantName;
  try {
    const table = page.getByRole('table', { name: 'Parties Involved' });
    const rows = await table.getByRole('row').allInnerTexts();
    // Header row's first cell is "Name" — skip it; find the first data row
    // whose Roles cell mentions "Claimant" (CONFIRMED live: a claim's
    // Parties Involved table lists each party's Name/Roles/Phone, e.g. one
    // row "Adams Claimant | Claimant | 515-025-6659").
    const claimantRow = rows.find(r => !/^name\b/i.test(r.trim()) && /\bclaimant\b/i.test(r));
    if (claimantRow) claimantName = claimantRow.split('\n')[0].trim() || undefined;
  } catch (_) { /* Parties Involved table not present/visible on this claim — leave unset */ }

  return { insuredName, lossDate, lossLocation, claimantName, policyNumber, underwritingCompany };
}

module.exports = { captureClaimSummary, extractLabelValue, toLongDateFormat };
