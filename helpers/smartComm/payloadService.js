/**
 * helpers/smartComm/payloadService.js
 * Parses the XML "payload" ClaimCenter itself sends to SmartCOMM for a
 * document generation — downloaded via the Create tab's own "Download
 * Payload" button (documentService.downloadPayload). This is ClaimCenter's
 * own ground truth for what data went into the merge, independent of
 * anything scraped off the Summary screen (claimSummaryService) — used two
 * ways (see validationService): cross-checking the live-captured claim data
 * against it (catches capture drift, not just template-vs-render drift),
 * and as a context source for fields nothing on the claim's own screens
 * exposes (the adjuster's own phone/email — see "From ..." in
 * fieldLabelSynonyms.js).
 *
 * Structure confirmed against a real sample (2026-09-04,
 * "Sample Payload\4cb240da-..."): a <ccDocumentCreationRequest> root holding
 * a huge <claim> (with a <contacts><contacts>...</contacts></contacts>
 * array — CONFIRMED the wrapper tag and each item share the same name, an
 * XML array-serialization convention repeated for <roles>/<editableRoles>
 * too, which is why isArray is needed below rather than a plain object
 * parse) plus, as the request's own direct children (siblings of <claim>,
 * NOT nested inside it): <recipient>, <from_ext> (the sending adjuster's own
 * name/email/phone), <deliveryChannel>, <templateID>.
 */
'use strict';
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const reviewCaseAdapter = require('./reviewCasePayloadAdapter');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function isoToLongDateFormat(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return undefined;
  return `${MONTH_NAMES[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}, ${d.getUTCFullYear()}`;
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// Every activity on the claim carries its own <assignedByUserExpanded>/
// <assignedUserExpanded> block — a full ClaimCenter USER record (not
// claim-specific), one per activity, plus one more pair for the claim's own
// top-level assignment. Per BA/QA input (2026-09-04): unlike <from_ext>
// (sparse — only carries whichever of email/phone/title happen to be set on
// that account AT GENERATION TIME, so it can come back missing either),
// these "*Expanded" user blocks reliably carry the full contact record for
// whoever they name, since they're just serialized user-admin data. Rather
// than hardcode one exact path (which activity, claim- vs. activity-level —
// several exist and any one of them for the same person has the same,
// correct info), search the whole parsed payload for ANY node shaped like a
// user record whose own displayName matches the document's Author
// (<from_ext>'s displayName) and use ITS email/phone as the richer source.
function findUserContactByDisplayName(node, targetName, seen) {
  if (!node || typeof node !== 'object') return undefined;
  seen = seen || new Set();
  if (seen.has(node)) return undefined;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findUserContactByDisplayName(item, targetName, seen);
      if (found) return found;
    }
    return undefined;
  }
  if (node.displayName === targetName && (node.emailAddress1 || node.workPhone)) {
    return {
      email: node.emailAddress1 || undefined,
      phone: (node.workPhone && node.workPhone.displayName) || undefined,
    };
  }
  for (const key of Object.keys(node)) {
    const found = findUserContactByDisplayName(node[key], targetName, seen);
    if (found) return found;
  }
  return undefined;
}

// claim.lossLocation is frequently NOT a real address at all — CONFIRMED live 2026-10-05 (DIG6,
// DFC-AL-03-26-0747922): its own displayName is the literal text "See Policy Tab" with no nested
// <state> property whenever the loss happened at the insured's own premises, so
// claim.lossLocation.state.code comes back undefined even though the claim unambiguously has a real
// state — printed right there in the letter's own recipient address block. The insured contact's
// primaryAddress is that same address (role "insured" — also this claim's root.recipient), so it's
// the right fallback once lossLocation itself has nothing to offer.
function contactStateCode(contact) {
  return (contact && contact.primaryAddress && contact.primaryAddress.state && contact.primaryAddress.state.code) || undefined;
}

// Commercial policies can carry several locations; the one actually used to
// rate the policy isn't in a field literally labeled "rating state" — the
// closest CONFIRMED proxy (2026-09-22 sample) is whichever location carries
// primaryLocation="true" (falls back to policyAddress="true", then just the
// first location if neither flag is present). Flagged clearly as a
// best-effort proxy, not a confirmed "policy rating state" field, per user
// direction to place a marked placeholder here pending further guidance.
function findPolicyState(policy) {
  const outer = asArray(policy && policy.locations)[0];
  const locations = asArray(outer && outer.locations);
  if (!locations.length) return undefined;
  const pick = locations.find((l) => l.primaryLocation === 'true')
    || locations.find((l) => l.policyAddress === 'true')
    || locations[0];
  return pick.address && pick.address.state ? pick.address.state.code : undefined;
}

// The vehicle sits several policy-structure layers deep (policyLocations ->
// ... -> vehicleLocation, CONFIRMED live 2026-09-04) with wrapper tags that
// vary by how many locations/vehicles a policy has — rather than hardcode
// that exact path, search for a node shaped like a vehicle record (has its
// own make/model/vin together, a combination nothing else in the payload
// has). Only the FIRST vehicle found is used — fine for a single-vehicle
// personal auto policy (CONFIRMED: exactly one <vehicle> in the sample);
// a multi-vehicle policy would need picking the one actually involved in
// the loss, not just the first one on the policy — untested, revisit if it
// comes up.
function findVehicle(node, seen) {
  if (!node || typeof node !== 'object') return undefined;
  seen = seen || new Set();
  if (seen.has(node)) return undefined;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findVehicle(item, seen);
      if (found) return found;
    }
    return undefined;
  }
  if (node.make && node.model && node.vin) {
    return {
      year: node.year || undefined,
      make: node.make || undefined,
      model: node.model || undefined,
      vin: node.vin || undefined,
      bodyStyle: (node.style && node.style.name) || undefined,
    };
  }
  for (const key of Object.keys(node)) {
    const found = findVehicle(node[key], seen);
    if (found) return found;
  }
  return undefined;
}

// <roles> and <editableRoles> both wrap themselves the same
// wrapper-tag-equals-item-tag way as <contacts> — CONFIRMED against the
// sample: <roles><roles><role><code>insured</code>...
function roleCodesOf(contact) {
  const rolesList = asArray(contact.roles).flatMap(w => asArray(w && w.roles));
  const editableList = asArray(contact.editableRoles).flatMap(w => asArray(w && w.editableRoles));
  return [...new Set([...rolesList, ...editableList].map(r => r && r.role && r.role.code).filter(Boolean))];
}

function contactSummary(contact) {
  if (!contact) return undefined;
  return {
    name: contact.displayName || undefined,
    email: contact.emailAddress1 || undefined,
    phone: contact.primaryPhone || (contact.workPhone && contact.workPhone.displayName) || undefined,
    address: contact.primaryAddress && contact.primaryAddress.displayName || undefined,
  };
}

function parsePayload(xmlText) {
  // Two real source formats reach this function — see reviewCasePayloadAdapter.js's own header for the
  // CONFIRMED-live structural difference: the Create tab's "Download Payload" button produces direct XML
  // (<ccDocumentCreationRequest><claim>...), while the S3-fetched payload (ClaimCenter Outbound > smartcomm
  // > input) is a Thunderhead "review-case" transaction log using a generic <object>/<property> vocabulary
  // for the same data. The adapter converts the latter into the exact shape this function already expects
  // from the former, so everything below (and every *Ext/find* helper in this file) is format-agnostic.
  let doc;
  if (reviewCaseAdapter.isReviewCaseXml(xmlText)) {
    doc = reviewCaseAdapter.convertReviewCaseXml(xmlText);
  } else {
    const parser = new XMLParser({
      ignoreAttributes: true,
      isArray: (name) => name === 'contacts' || name === 'roles' || name === 'editableRoles',
      // Without this, fast-xml-parser auto-coerces numeric-looking tag text
      // (policyNumber, postalCode, phone numbers) to JS numbers — CONFIRMED:
      // "1001002576" came back as the number 1001002576, which then throws in
      // pdfValidationService's normalizeWs(expected).toLowerCase() the moment
      // it's used as an expected value. Every field here is text as far as
      // this service cares, so keep it all as strings.
      parseTagValue: false,
    });
    doc = parser.parse(xmlText);
  }
  const root = doc.ccDocumentCreationRequest;
  if (!root) throw new Error('payloadService: not a recognized SmartCOMM payload — no <ccDocumentCreationRequest> root element');
  const claim = root.claim || {};

  const contactsOuter = asArray(claim.contacts)[0];
  const contactList = asArray(contactsOuter && contactsOuter.contacts);

  const byRole = {};
  for (const contact of contactList) {
    for (const code of roleCodesOf(contact)) {
      if (!byRole[code]) byRole[code] = contact; // first contact wins a given role, matching how these roles are normally 1:1 on a claim
    }
  }

  const policy = claim.policy || {};
  // policy.effectiveDate/expirationDate are the policy's OWN top-level term
  // dates — CONFIRMED live 2026-09-04: the same tag names recur dozens of
  // times inside policy.endorsements/coverages (one pair per endorsement/
  // coverage line, same values as the policy term in every case checked),
  // but those are nested under their own parent objects and don't collide
  // with the direct policy.effectiveDate/expirationDate properties here.
  const vehicle = findVehicle(claim);

  return {
    claimNumber: claim.claimNumber || undefined,
    lossDate: isoToLongDateFormat(claim.lossDate),
    // CONFIRMED live 2026-09-22 (claim.lossType.code): matches the same
    // AUTO/GL/PR/WC vocabulary testDataService's own lob column already
    // uses, and claim.lossLocation.state.code the same 2-letter codes
    // (PA/NC/OH/...) everywhere else in this payload uses — both used by
    // fraudLanguageService to resolve the state/LOB-specific required text.
    // Falls back to the insured contact's own address state (see
    // contactStateCode above) whenever lossLocation itself has no state —
    // "See Policy Tab" claims still need a real state for the fraud-language
    // check, and the insured's address is the same one the letter prints.
    lossState: (claim.lossLocation && claim.lossLocation.state && claim.lossLocation.state.code) || contactStateCode(byRole.insured) || undefined,
    lossType: (claim.lossType && claim.lossType.code) || undefined,
    lossCauseName: (claim.lossCause && claim.lossCause.name) || undefined,
    // See findPolicyState's own comment above — best-effort proxy for
    // "policy rating state", not a field ClaimCenter itself labels as such.
    policyState: findPolicyState(policy),
    policyNumber: policy.policyNumber || undefined,
    policyEffectiveDate: isoToLongDateFormat(policy.effectiveDate),
    policyExpirationDate: isoToLongDateFormat(policy.expirationDate),
    underwritingCompany: (policy.underwritingCo && policy.underwritingCo.name) || undefined,
    // "cc: 0000988" appears at the very bottom of a real generated letter
    // (CONFIRMED live, DIG3) — matches policy.producerCode exactly, and is
    // this claim's agent's own number (the "agent" role contact below is
    // that same producer, e.g. "DONEGAL DIRECT ACCOUNT").
    agentNumber: policy.producerCode || undefined,
    vehicleYear: vehicle && vehicle.year,
    vehicleMake: vehicle && vehicle.make,
    vehicleModel: vehicle && vehicle.model,
    vehicleVin: vehicle && vehicle.vin,
    vehicleBodyStyle: vehicle && vehicle.bodyStyle,
    insured: contactSummary(byRole.insured),
    claimant: contactSummary(byRole.claimant),
    agent: contactSummary(byRole.agent),
    underwriter: contactSummary(byRole.underwriter),
    // ClaimCenter's own role code for a claimant's attorney is "plaintiffs"
    // (not "attorney") — CONFIRMED live 2026-09-04 after a plaintiff's
    // attorney was added to a test claim. A medical provider's role code is
    // "doctor".
    attorney: contactSummary(byRole.plaintiffs),
    provider: contactSummary(byRole.doctor),
    recipient: root.recipient ? {
      name: root.recipient.displayName || undefined,
      address: root.recipient.primaryAddress && root.recipient.primaryAddress.addressLine1
        ? `${root.recipient.primaryAddress.addressLine1}, ${root.recipient.primaryAddress.city || ''}`.trim()
        : undefined,
    } : undefined,
    // CONFIRMED live (2026-09-04): <from_ext> only includes whichever of
    // name/email/phone/title the sending user's OWN ClaimCenter profile
    // currently has set — a run captured with jobTitle="Technician" had NO
    // emailAddress1/workPhone at all, while an earlier run against the same
    // claim (same "Super User" login) had both email and phone but no
    // jobTitle. That's real variance in that user's profile between runs,
    // not a parsing bug — email/phone fall back to whatever
    // findUserContactByDisplayName finds elsewhere in the payload for the
    // same Author (per BA/QA input), since those "*Expanded" user blocks
    // are reliably complete where <from_ext> itself can be sparse.
    from: root.from_ext ? (() => {
      const authorName = root.from_ext.displayName || undefined;
      const richContact = authorName ? findUserContactByDisplayName(doc, authorName) : undefined;
      return {
        name: authorName,
        email: root.from_ext.emailAddress1 || (richContact && richContact.email) || undefined,
        phone: (root.from_ext.workPhone && root.from_ext.workPhone.displayName) || (richContact && richContact.phone) || undefined,
        title: root.from_ext.jobTitle || undefined,
      };
    })() : undefined,
    deliveryChannel: root.deliveryChannel || undefined,
    templateID: root.templateID || undefined,
  };
}

function normalizeForCompare(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function compareField(id, description, payloadValue, capturedValue) {
  if (payloadValue === undefined) return null; // nothing in the payload to check this against
  const match = normalizeForCompare(payloadValue) === normalizeForCompare(capturedValue);
  return {
    id, description,
    result: match ? 'PASS' : 'FAIL',
    expected: payloadValue,
    actual: capturedValue === undefined ? 'Not captured' : capturedValue,
    reason: match ? undefined :
      `ClaimCenter's own SmartCOMM payload for this claim says "${payloadValue}", but this automation's live capture off the claim's Summary screen has ` +
      `"${capturedValue === undefined ? '(nothing)' : capturedValue}" — a data-capture bug in this tool, not a template rendering issue.`,
  };
}

// Cross-checks the claim data this tool captured (claimSummaryService, off
// the Summary screen) against what ClaimCenter itself actually sent to
// SmartCOMM for THIS generation — a second, independent source of truth
// that catches capture drift (a mis-scraped label, a stale selector) that
// template-vs-PDF comparisons alone can't see, since both would be
// comparing against the same wrong captured value. Returned entries use the
// exact same {id, description, result, expected, actual, reason} shape as a
// requirement validation, so validationService can append them straight
// into the same list the report already renders as one table — "DC" ids so
// they're visually distinct from a template's own "R" requirement ids.
function compareToClaimData(effectiveTestData, payload) {
  return [
    compareField('DC1', 'Data capture check: Insured Name', payload.insured && payload.insured.name, effectiveTestData.insuredName),
    compareField('DC2', 'Data capture check: Claimant Name', payload.claimant && payload.claimant.name, effectiveTestData.claimantName),
    compareField('DC3', 'Data capture check: Loss Date', payload.lossDate, effectiveTestData.lossDate),
    compareField('DC4', 'Data capture check: Policy Number', payload.policyNumber, effectiveTestData.policyNumber),
    compareField('DC5', 'Data capture check: Underwriting Company', payload.underwritingCompany, effectiveTestData.underwritingCompany),
  ].filter(Boolean);
}

function parsePayloadFile(filePath) {
  return parsePayload(fs.readFileSync(filePath, 'utf8'));
}

module.exports = { parsePayload, parsePayloadFile, compareToClaimData };
