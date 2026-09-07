/**
 * helpers/smartComm/fieldLabelSynonyms.js
 * Generic (template-agnostic) map from a field label — a visible document
 * label ("FILE NUMBER") OR a BA-authored Word comment's own field name
 * ("Claim Number", "To Name") — to the evaluation-context path whose value
 * the generated document's text should contain. Values are full dotted
 * paths so both `testData.*` (fixtures/smartComm/testData.js, keyed by the
 * scenario's claim) and `recipient.*` (captured live from whichever party
 * documentService actually selected as primary recipient) can be sourced
 * the same way. `null` means "known field, but shape-only" (e.g. a bare
 * "Date of Letter" just needs a validly-shaped date, not a specific one) —
 * usually because no reliable source for the exact value exists yet.
 *
 * Extend this list — never add per-template code — when another template's
 * Word doc (or its comments) uses a label not covered here.
 */
'use strict';

const LABEL_TO_TESTDATA_FIELD = {
  // Visible-document-label vocabulary (heuristic fallback path — see
  // templateRequirementService's isShortLabel/inline-label-value scanner).
  'DATE': null,
  'OUR POLICYHOLDER': 'testData.insuredName',
  'POLICYHOLDER': 'testData.insuredName',
  'INSURED': 'testData.insuredName',
  'DATE OF ACCIDENT': 'testData.lossDate',
  'DATE OF LOSS': 'testData.lossDate',
  'LOSS DATE': 'testData.lossDate', // catalog scan 2026-09-04 found this exact wording separately from "Date of Loss" on 10 templates
  'D/L': 'testData.lossDate',
  'FILE NUMBER': 'testData.claimNumber',
  'FILE NO': 'testData.claimNumber',
  'CLAIM NO': 'testData.claimNumber',
  'CLAIM NUMBER': 'testData.claimNumber',
  'OUR CLAIM NO': 'testData.claimNumber',
  'CLAIMANT': 'testData.claimantName',
  "EMPLOYEE'S NAME AND ADDRESS": 'testData.claimantName',
  "EMPLOYER'S NAME AND ADDRESS": null, // no employer field in testData yet — recognised so it isn't swallowed as static text; shape-only for now

  // BA Word-comment vocabulary (primary path when a template's .docx has
  // comments.xml — see templateRequirementService's comment-driven parser).
  'INSURED NAME': 'testData.insuredName',
  // Confirmed with the BA (2026-09-04): "Policy Insured" is just the
  // insured person on the claim, same as "Insured Name" — not a separate
  // policy-level concept needing its own data source.
  'POLICY INSURED': 'testData.insuredName',
  'CLAIMANT NAME': 'testData.claimantName',
  'DATE OF LETTER': null,
  'LOSS LOCATION': 'testData.lossLocation', // CONFIRMED live on DIG126 (Witness Report)
  'POLICY NUMBER': 'testData.policyNumber', // captured live off the info bar's "Pol:" field
  'UNDERWRITING COMPANY': 'testData.underwritingCompany', // captured live off Summary > Basics
  // The claim's agent/producer — from the payload's own "agent"-role
  // contact and policy.producerCode (catalog scan 2026-09-04: "cc:
  // 0000988" at the bottom of a real generated letter is exactly this
  // producer code — CONFIRMED live, DIG3).
  'AGENT NAME': 'payload.agentName',
  'AGENT NUMBER': 'payload.agentNumber',
  // Policy term dates, straight off the payload's own policy block.
  'EFFECTIVE DATE': 'payload.policyEffectiveDate',
  'EXPIRATION DATE': 'payload.policyExpirationDate',
  // The claim's own vehicle (payload's policy.vehicleLocation.vehicle —
  // CONFIRMED live, DIG3: year/make/model/vin/style.name).
  'VEHICLE YEAR': 'payload.vehicleYear',
  'VEHICLE MAKE': 'payload.vehicleMake',
  'VEHICLE MODEL': 'payload.vehicleModel',
  'VIN': 'payload.vehicleVin',
  'VEHICLE BODY STYLE': 'payload.vehicleBodyStyle',
  // "Claim Representative" is the same person as the adjuster/"From ..."
  // fields (confirmed with the BA, 2026-09-04) — same sources, not a
  // separate role.
  // Same "document sender, not assigned adjuster" distinction as "From
  // Name" below — see that entry's note.
  'CLAIM REPRESENTATIVE': 'payload.fromName',
  'CLAIM REP NAME': 'payload.fromName',
  'CLAIM REPRESENTATIVE PHONE': 'payload.fromPhone',
  'CLAIM REPRESENTATIVE EMAIL': 'payload.fromEmail',
  // ClaimCenter's own role code for a claimant's attorney is "plaintiffs"
  // (not "attorney") — CONFIRMED live 2026-09-04, added a plaintiff's
  // attorney to a test claim to check. No email captured for this contact
  // type in the payload (none set on the test contact either) — stays
  // shape-only if a template needs it until a real example turns up.
  'ATTORNEY NAME': 'payload.attorneyName',
  'ATTORNEY PHONE': 'payload.attorneyPhone',
  'ATTORNEY ADDRESS': 'payload.attorneyAddress',
  // Medical provider — role code "doctor" (CONFIRMED live 2026-09-04).
  'PROVIDER NAME': 'payload.providerName',
  'PROVIDER PHONE': 'payload.providerPhone',
  'PROVIDER ADDRESS': 'payload.providerAddress',
  // "To ..." = whoever documentService actually picked as primary
  // recipient, captured live from that same selection — not hand-typed
  // test data, so it's correct no matter which claim/recipient a scenario
  // ends up using. The Recipients grid's own Address cell is one
  // comma-joined string, but a letter renders street vs. city/state/zip as
  // two separate lines (CONFIRMED live, DIG3) — documentService splits it
  // into recipient.streetAddress/cityStateZip for exactly that reason, so
  // each half is checked against its own template field instead of the
  // whole joined string producing a false "punctuation differs" FAIL.
  // "To Address" (a single combined-field variant, catalog scan 2026-09-04)
  // still wants the whole thing. Catalog scan also found both a comma and
  // non-comma spelling of the city/state/zip label in the wild.
  'TO NAME': 'recipient.name',
  'TO STREET ADDRESS': 'recipient.streetAddress',
  'TO ADDRESS': 'recipient.address',
  'TO CITY, STATE, ZIP': 'recipient.cityStateZip',
  'TO CITY, STATE ZIP': 'recipient.cityStateZip',
  // "From ..." is the DOCUMENT'S SENDER — whoever is actually logged in and
  // generating it (the payload's own <from_ext> block) — NOT the claim's
  // assigned adjuster (the "Adj:" info-bar field, testData.fromName). Those
  // two are different concepts that only look the same when the account
  // generating a document happens to also be the claim's assigned handler.
  // CONFIRMED live 2026-09-04: switching the automation's login from "su"
  // (which WAS this test claim's assigned adjuster) to "willfolm" (a real
  // user, NOT assigned to this claim) made <from_ext> disappear from the
  // payload entirely, and the real generated letter's "Sincerely," line
  // went completely blank — no name, no title, no phone. testData.fromName
  // still said "Super User" (the assigned adjuster, unchanged) and would
  // have reported a misleading FAIL instead of the correct BLOCKED. Every
  // "From ..." field — Name included — now sources from the payload, so
  // all four fail/block together consistently when the generating user
  // isn't the claim's assigned handler, instead of Name alone doing its
  // own separate, wrong thing.
  'FROM NAME': 'payload.fromName',
  'FROM TITLE': 'payload.fromTitle',
  'FROM PHONE': 'payload.fromPhone',
  'FROM EMAIL': 'payload.fromEmail',
};

// Paths that pdfValidationService.js reports as FAIL (not BLOCKED) when the
// payload downloaded/parsed fine but this specific value is absent from it.
// Normally a missing payload.* value is genuinely unverifiable (BLOCKED) —
// this is the one confirmed exception. Per the CONFIRMED live finding above
// (willfolm vs. su, 2026-09-04): when the generating user's own ClaimCenter
// profile is missing one of these, SmartCOMM's <from_ext> block omits it and
// the real letter's signature block renders with that field genuinely
// blank — a real, reproducible document defect (an incomplete/blank
// "Sincerely," block going out to a recipient), not an unverifiable
// environmental condition, so it should count as a failure, not a block.
const FAIL_IF_PAYLOAD_MISSING = new Set([
  'payload.fromName', 'payload.fromTitle', 'payload.fromPhone', 'payload.fromEmail',
]);

function lookup(label) {
  // Word's smart quotes (‘/’) render as curly apostrophes in the
  // extracted text ("Employer’s Name and Address") while this
  // dictionary is written with a plain one — normalize both to the same
  // form before matching, or every apostrophe'd label silently misses.
  const key = String(label || '').replace(/[‘’]/g, "'").trim().toUpperCase().replace(/:$/, '');
  return Object.prototype.hasOwnProperty.call(LABEL_TO_TESTDATA_FIELD, key)
    ? LABEL_TO_TESTDATA_FIELD[key]
    : undefined; // undefined = not a known label; null = known, shape-only
}

const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';

// Unanchored sources shared by both an anchored form (PATTERNS below —
// "is this whole line a date?" during requirement classification) and an
// unanchored form (pdfValidationService's shapeRegex — "does a date appear
// somewhere in this text?" during evaluation) so the two never drift apart.
// CONFIRMED via live run: ClaimCenter renders dates as "September 03, 2026",
// not just MM/DD/YYYY — both forms are common across templates.
const PATTERN_SOURCES = {
  date: `\\d{1,2}/\\d{1,2}/\\d{2,4}|(?:${MONTH_NAMES})\\s+\\d{1,2},?\\s+\\d{4}`,
  currency: `\\$[\\d,]+(?:\\.\\d{2})?`,
  email: `[^\\s@]+@[^\\s@]+\\.[^\\s@]+`,
  phone: `\\(?\\d{3}\\)?[-.\\s]?\\d{3}[-.\\s]?\\d{4}`,
};

const PATTERNS = Object.fromEntries(
  Object.entries(PATTERN_SOURCES).map(([k, src]) => [k, new RegExp(`^(?:${src})$`, 'i')])
);
const UNANCHORED_PATTERNS = Object.fromEntries(
  Object.entries(PATTERN_SOURCES).map(([k, src]) => [k, new RegExp(src, 'i')])
);

module.exports = { LABEL_TO_TESTDATA_FIELD, lookup, PATTERNS, UNANCHORED_PATTERNS, FAIL_IF_PAYLOAD_MISSING };
