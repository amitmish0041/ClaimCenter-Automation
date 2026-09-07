/**
 * fixtures/smartComm/testData.js
 * SmartCOMM claim test-data inventory — one entry per already-open
 * ClaimCenter claim that scenarioService can match against a template's
 * State/LOB applicability and documentService can search for and open.
 *
 * PLACEHOLDER — replace with the real claim inventory once provided (see
 * ClaimsByLOBAndState_20260617.xlsx for aggregate counts only, NOT claim
 * numbers — an actual claim-number inventory is still needed). Until then,
 * any template whose States/LOB doesn't match a record here correctly comes
 * back BLOCKED ("no matching test claim"), not a crash and not a guess.
 *
 * Shape:
 *   lob           Production LOB, matched case-insensitively against the
 *                 catalog's LOB column (e.g. "Auto", "WC", "Property", "GL")
 *   state          2-letter state code
 *   claimNumber    an existing, already-open claim number in the target CC tier
 *   insuredName, claimantName, lossDate, lossLocation, adjusterEmail
 *                  optional — sourced by templateRequirementService's
 *                  dynamicValueMatch requirements (see fieldLabelSynonyms.js)
 */
module.exports = [
  // insuredName/lossDate confirmed via a live DIG52 run against this claim
  // 2026-09-03 (its own generated PDF: "Our Insured:test_001 account",
  // "Date of Loss:August 27, 2026" — the latter kept in this month-name form
  // since dynamicValueMatch does a literal substring match, not a shape
  // check). lossLocation confirmed via a live DIG126 run 2026-09-04 (its own
  // generated PDF: "21 HONEYSUCKLE DR, MARIETTA, PA 17547-8501" — matches this
  // claim's own Loss Location). claimantName left unset — every live PDF's
  // "Claimant:" line has been blank so far, so there's genuinely nothing to
  // assert yet, not an unknown.
  {
    lob: 'Auto',
    state: 'PA',
    claimNumber: 'PA-PA-01-26-0000209',
    insuredName: 'test_001 account',
    lossDate: 'August 27, 2026',
    lossLocation: '21 HONEYSUCKLE DR, MARIETTA, PA 17547-8501',
  },
];
