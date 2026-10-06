/**
 * helpers/smartComm/payloadXpathService.js
 * Resolves the Claims_Attributes_Data_Dictionary's "Xpath" column (column H) against a real, downloaded
 * SmartCOMM payload XML — giving a genuine EXPECTED VALUE for a field, straight from ClaimCenter's own data,
 * rather than the presence-only / heuristic matching the rest of this validator relies on elsewhere.
 *
 * CONFIRMED live 2026-09-30: despite its column header, this is NOT executable XPath — it's BA-authored
 * pseudo-code that mixes:
 *   - plain dot-paths                         ccDocumentCreationRequest.claim.policy.producerCode
 *   - "where" filters (optionally chained with "and") on an array, comparing to either a quoted literal or
 *     another dot-path                        ...contacts.contacts.displayName where ...role.code = 'claimant'
 *   - numbered fallback alternatives, tried in order until one resolves
 *                                              1> <expr> 2> <expr>
 *   - if/else and when/when branches, each guarded by its own condition
 *                                              if(<cond>){ <expr> }else{ <expr> }
 *   - "+" concatenation of two or more sub-expressions (each of which may have its own "where")
 *   - the literal keyword "Current Date", and simple date arithmetic ("<expr> + N years")
 * No off-the-shelf XPath library can execute this; this file is a small, purpose-built interpreter for it.
 * It resolves what it can and returns { value: undefined, unsupported: true, reason } for the genuinely
 * ambiguous rows instead of guessing — same "no guess when nothing lines up" convention as the rest of this
 * validator (see dataDictionaryService.matchAttributeForField).
 *
 * Parses the SAME payload XML documentService.downloadPayload() saves and payloadService.js already
 * hand-curates a much smaller, fixed set of fields from — this file is complementary, not a replacement:
 * payloadService.js's curated fields stay the primary source for the handful of things validationService.js
 * already depends on by name (fromName, agentNumber, ...); this file's resolveForTemplate() covers every
 * OTHER Data Dictionary row that has an Xpath, keyed by attribute name, for use in dynamicValueMatch checks
 * built directly from the dictionary.
 */
'use strict';
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const reviewCaseAdapter = require('./reviewCasePayloadAdapter');

// Every wrapper-tag-equals-item-tag collection CONFIRMED live 2026-09-30 across 8 real downloaded payloads
// (contacts/roles/editableRoles already hardcoded in payloadService.js; the rest found by grepping real
// samples for the same "<tag><tag>...” shape). fast-xml-parser only auto-detects an array when 2+ siblings
// are present, so a collection with exactly 0 or 1 real item would otherwise silently collapse to a plain
// object (or vanish) — forcing these tags to always parse as arrays avoids that regardless of item count.
const ARRAY_TAGS = new Set([
  'activities', 'allValidationLevelsReached', 'buildings', 'checkSets', 'checks', 'contacts', 'covTerms',
  'coverages', 'documents', 'dwellingIncidents', 'dwellingRoomDamages', 'editableRoles', 'endorsements',
  'exposures', 'fixedPropertyIncidents', 'injuryIncidents', 'lineItems', 'locationBasedRiskUnits', 'locations',
  'matters', 'notes', 'payees', 'payments', 'policyLocations', 'reserveSets', 'reserves', 'roles',
  'vehicleIncidents', 'vehicleRiskUnits', 'additionalRecipients_ext',
]);

function parseRawPayload(xmlText) {
  // See reviewCasePayloadAdapter.js's header — the S3-fetched payload (ClaimCenter Outbound > smartcomm >
  // input) is a different XML envelope than the Create tab's "Download Payload" button produces, needing a
  // different parse path to reach the same { ccDocumentCreationRequest: {...} } shape everything below reads.
  if (reviewCaseAdapter.isReviewCaseXml(xmlText)) return reviewCaseAdapter.convertReviewCaseXml(xmlText);
  const parser = new XMLParser({ ignoreAttributes: true, isArray: (name) => ARRAY_TAGS.has(name), parseTagValue: false });
  return parser.parse(xmlText);
}
function parseRawPayloadFile(filePath) {
  return parseRawPayload(fs.readFileSync(filePath, 'utf8'));
}

// ── Path resolution ─────────────────────────────────────────────────────────────────────────────────

// CONFIRMED live 2026-09-30: a few Data Dictionary Xpath cells have real typos — "claimcontacts" missing the
// dot every other row has between "claim" and "contacts" (Claimant Date of Birth / First Name / Last Name's
// 2nd alternative, Employer FEIN, Policy Base State), unambiguously meant to be "claim.contacts" (identical
// structure to dozens of correctly-dotted sibling rows) — corrected rather than left to silently fail.
function fixKnownTypos(expr) {
  return expr.replace(/\bclaimcontacts\b/g, 'claim.contacts');
}
function cleanExpr(expr) {
  let e = fixKnownTypos(String(expr || '')).trim();
  // Strips a single stray leading quote ONLY when it's clearly unmatched (no corresponding quote at the very
  // end of the same string) — CONFIRMED live this happens exactly once in the real dictionary (the
  // "Coverage" row has a leading `"` with no closing quote anywhere). A blanket strip of trailing
  // quote/whitespace characters (the original version of this function) corrupts any expression that
  // legitimately ENDS in a quoted literal, e.g. "...role.code == 'insured'" — it silently deletes the
  // closing quote off "'insured'", which then fails the `/^'.*'$/` literal check downstream and makes every
  // such condition resolve against a garbage path instead of the literal string. Only ever trims plain
  // whitespace at the edges now; quote characters are left alone except for that one specific stray case.
  if (/^["']/.test(e) && e[0] !== e[e.length - 1]) e = e.slice(1);
  return e.replace(/\s+/g, ' ');
}
function toSegments(pathStr) {
  const parts = pathStr.trim().split('.').filter(Boolean);
  if (parts[0] === 'ccDocumentCreationRequest') parts.shift();
  return parts;
}
function segmentsStartWith(segments, prefix) {
  if (prefix.length > segments.length) return false;
  return prefix.every((p, i) => segments[i] === p);
}

// Resolves a dot-path to a scalar leaf, auto-unwrapping any array encountered by taking its first element —
// correct for a genuinely single-valued field, and for a where-filtered array already reduced to one match
// before a nested path resolves further into it. Returns undefined for anything that isn't a plain scalar.
function resolvePath(root, pathStr) {
  const segments = toSegments(pathStr);
  let cur = root;
  for (const seg of segments) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[0];
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  if (Array.isArray(cur)) cur = cur[0];
  return cur != null && typeof cur === 'object' ? undefined : cur;
}

// Does ANY element reachable by `segments` from `node` equal `targetValue`, once every array encountered
// along the way is treated as "try each element"? CONFIRMED live this matters for role checks — a contact's
// roles is an array (a person can hold more than one role on a claim), so "roles.roles.role.code = 'insured'"
// must check every role entry, not just the first.
function pathMatchesAny(node, segments, targetValue) {
  // CONFIRMED live 2026-09-30: a genuinely MISSING value must never "match" another missing value — without
  // this guard, two unrelated fields that both happen to be absent (e.g. a payload with no <exposure> node,
  // compared against a contact's own unset relatedTo.id) both stringify to the literal text "undefined" and
  // compare EQUAL, silently matching every contact in the array instead of none — this produced a garbled,
  // multi-contact "Claimant Name" result (several people's names/role-codes/ids all concatenated together).
  if (targetValue === undefined) return false;
  if (!segments.length) return node !== undefined && String(node) === String(targetValue);
  if (Array.isArray(node)) return node.some((item) => pathMatchesAny(item, segments, targetValue));
  if (node == null || typeof node !== 'object') return false;
  return pathMatchesAny(node[segments[0]], segments.slice(1), targetValue);
}

function evalCondition(root, item, arrayPrefixSegments, condText) {
  const m = condText.match(/^(.*?)\s*(!=|==|=)\s*(.*)$/);
  if (!m) return { ok: false, reason: `Could not parse condition "${condText}"` };
  const [, leftRaw, op, rightRaw] = m;
  const rightTrim = rightRaw.trim();
  const rightIsLiteral = /^'.*'$/.test(rightTrim) || /^".*"$/.test(rightTrim);
  const rightValue = rightIsLiteral ? rightTrim.slice(1, -1) : resolvePath(root, rightTrim);
  const leftSegments = toSegments(leftRaw.trim());
  let matches;
  if (rightValue === undefined) {
    matches = false; // see pathMatchesAny's own comment — never let two missing values "match" each other
  } else if (segmentsStartWith(leftSegments, arrayPrefixSegments)) {
    matches = pathMatchesAny(item, leftSegments.slice(arrayPrefixSegments.length), rightValue);
  } else {
    const leftValue = resolvePath(root, leftRaw.trim());
    matches = leftValue !== undefined && String(leftValue) === String(rightValue);
  }
  return { ok: true, matches: op === '!=' ? !matches : matches };
}

// Resolves "<targetPath> where <cond> [and <cond> ...]" — walks targetPath from root until the FIRST array
// is hit (that's the filtering boundary, e.g. claim.contacts.contacts), applies every condition to each
// element of that array (a condition sharing the same prefix as the target resolves relative to the
// element; anything else resolves relative to the whole document — e.g. "...exposure.id"), then pulls the
// remaining path segments off each surviving element. Multiple surviving elements are joined with ", " —
// the dictionary's own "(concatanated)" annotation on several rows confirms multiple matches are expected
// to be combined, not just the first taken.
function resolveWhere(root, targetPath, whereText) {
  const segments = toSegments(targetPath);
  let cur = root;
  let i = 0;
  for (; i < segments.length; i++) {
    if (cur == null) return { value: undefined };
    if (Array.isArray(cur)) {
      // Double-wrap unwrap: "<tag><tag>item</tag></tag>" parses as [{tag: [...]}] — a size-<=1 array whose
      // single element's OWN next-matching-segment property is ALSO an array. CONFIRMED live this is exactly
      // how contacts/roles/etc. always parse (see ARRAY_TAGS) — without unwrapping THIS level too, the
      // filter boundary gets set one level too shallow and every "where" match comes back empty even when
      // the data is really there.
      if (cur.length <= 1 && cur[0] && Array.isArray(cur[0][segments[i]])) {
        cur = cur[0][segments[i]];
        continue;
      }
      break;
    }
    cur = cur[segments[i]];
  }
  if (!Array.isArray(cur)) {
    // No array anywhere on this path — the "where" clause doesn't actually apply to anything; just resolve normally.
    return { value: resolvePath(root, targetPath) };
  }
  const arrayPrefixSegments = segments.slice(0, i);
  const remaining = segments.slice(i);
  const conditions = whereText.split(/\s+and\s+/i).map((c) => c.trim()).filter(Boolean);

  const matchesArr = cur.filter((item) => {
    for (const condText of conditions) {
      const res = evalCondition(root, item, arrayPrefixSegments, condText);
      if (!res.ok || !res.matches) return false;
    }
    return true;
  });
  const values = matchesArr.map((item) => {
    let v = item;
    for (const seg of remaining) {
      if (v == null) return undefined;
      if (Array.isArray(v)) v = v[0];
      v = v[seg];
    }
    if (Array.isArray(v)) v = v[0];
    return v != null && typeof v === 'object' ? undefined : v;
  }).filter((v) => v !== undefined && v !== '');
  if (!values.length) return { value: undefined };
  return { value: values.length === 1 ? values[0] : values.join(', ') };
}

// ── Date helpers ─────────────────────────────────────────────────────────────────────────────────────
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function formatLongDate(d) { return `${MONTH_NAMES[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}, ${d.getUTCFullYear()}`; }
function toDate(v) { const d = new Date(v); return isNaN(d.getTime()) ? null : d; }

// ── Top-level expression evaluator ──────────────────────────────────────────────────────────────────

// Evaluates a single condition string against ROOT ONLY (no current-item context) — used for if/when guards,
// which always test document-level facts ("does this claim have an exposure?"), never a per-item field.
function evalRootCondition(root, condText) {
  const m = condText.match(/^(.*?)\s*(!=|==|=)\s*(.*)$/);
  if (!m) return false;
  const [, leftRaw, op, rightRaw] = m;
  const rightTrim = rightRaw.trim();
  const isNullLiteral = /^null$/i.test(rightTrim);
  const rightIsLiteral = /^'.*'$/.test(rightTrim) || /^".*"$/.test(rightTrim);
  const leftValue = resolvePath(root, leftRaw.trim());
  const rightValue = isNullLiteral ? undefined : rightIsLiteral ? rightTrim.slice(1, -1) : resolvePath(root, rightTrim);
  // Same guard as pathMatchesAny/evalCondition: two genuinely missing values must never compare equal to
  // each other (only the explicit "!= null" form should ever treat "missing" as meaningful).
  const equal = isNullLiteral
    ? (leftValue === undefined || leftValue === null || leftValue === '')
    : (leftValue !== undefined && rightValue !== undefined && String(leftValue) === String(rightValue));
  return op === '!=' ? !equal : equal;
}

// Splits top-level "1> ... 2> ... 3> ..." numbered alternatives (the split point is the digit+">" marker
// itself, never inside a nested if/when/where — CONFIRMED live these markers only ever appear at the very
// start of each alternative in the real dictionary data, never mid-expression).
function splitNumberedAlternatives(expr) {
  const parts = expr.split(/(?:^|\s)\d+>\s*/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts : null;
}

// Splits top-level "when <cond> <expr> when <cond2> <expr2> ..." branches.
function splitWhenBranches(expr) {
  const re = /\bwhen\b/gi;
  if (!re.test(expr)) return null;
  const pieces = expr.split(/\bwhen\b/i).map((s) => s.trim()).filter(Boolean);
  const branches = [];
  for (const piece of pieces) {
    const m = piece.match(/^(.*?==.*?)\s+(.*)$/);
    if (!m) return null; // doesn't fit the "when <cond> <expr>" shape — bail out, let caller try something else
    branches.push({ cond: m[1].trim(), expr: m[2].trim() });
  }
  return branches.length ? branches : null;
}

function evalExpr(root, exprRaw, depth) {
  depth = depth || 0;
  if (depth > 6) return { value: undefined, unsupported: true, reason: 'Expression nested too deeply' };
  const expr = cleanExpr(exprRaw);
  if (!expr) return { value: undefined };

  if (/^current date$/i.test(expr)) return { value: formatLongDate(new Date()) };

  // "Label - <path> (Concat[en]ated) Label2 - <path2>" — CONFIRMED live (From Name, From Phone): a labeled
  // multi-part format distinct from the plain "+"/juxtaposition concatenation forms below. The labels
  // ("Name -", "Designation -") and the "(Concatanated)"/"(Concatenated)" annotation are BA-written narration
  // about what's being combined, not part of the payload structure — extracting every well-formed dot-path
  // anywhere in the cell and resolving+joining just those (ignoring everything else) handles this correctly.
  // Deliberately narrow (requires the actual "Label -" prefix, not just the word "concatenated" anywhere) —
  // CONFIRMED live several unrelated "where"-filtered rows (Claimant Name, Attorney Name/Address) ALSO carry
  // a "(concatanated)" annotation, meaning something different there ("join multiple matched contacts",
  // already handled by resolveWhere's own join) — an earlier, looser version of this check incorrectly
  // intercepted those rows too, extracting the target/condition/comparison paths as if they were all
  // independent values to concatenate and producing garbled output (a contact's name + role code + id all
  // mashed together).
  if (/^[A-Za-z][A-Za-z ]*-\s*ccDocumentCreationRequest\./.test(expr)) {
    const paths = expr.match(/ccDocumentCreationRequest(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g) || [];
    const resolved = paths.map((p) => resolvePath(root, p)).filter((v) => v !== undefined && v !== '');
    // CONFIRMED live 2026-09-30 ("From Phone": "Number - ...workPhone.displayName Extension -
    // ...workPhone.number"): the BA's own dictionary sometimes labels a second segment "Extension" when it's
    // really just the SAME phone number as raw digits, not a real extension — workPhone.displayName already
    // renders the real extension formatted in ("800-877-0600 x7413"), so blindly appending workPhone.number
    // ("8008770600") produced a garbled value no real document ever prints. Drop any later segment whose
    // digits are already fully contained in an earlier segment's digits, rather than concatenating every
    // labeled piece regardless of whether it adds anything new.
    const digitsOf = (v) => String(v).replace(/\D/g, '');
    const values = [];
    for (const v of resolved) {
      const d = digitsOf(v);
      const alreadyCovered = d.length >= 5 && values.some((existing) => digitsOf(existing).includes(d));
      if (!alreadyCovered) values.push(v);
    }
    return { value: values.length ? values.join(' ') : undefined };
  }

  // if(...) { ... } else { ... }
  const ifMatch = expr.match(/^if\s*\((.*?)\)\s*\{(.*)\}\s*else\s*\{(.*)\}$/i);
  if (ifMatch) {
    const [, cond, thenExpr, elseExpr] = ifMatch;
    return evalExpr(root, evalRootCondition(root, cond.trim()) ? thenExpr : elseExpr, depth + 1);
  }

  // when <cond> <expr> when <cond2> <expr2> ...
  const whenBranches = splitWhenBranches(expr);
  if (whenBranches) {
    for (const b of whenBranches) {
      if (evalRootCondition(root, b.cond)) return evalExpr(root, b.expr, depth + 1);
    }
    return { value: undefined };
  }

  // 1> ... 2> ... — try each in order, first one that resolves to a real value wins.
  const alternatives = splitNumberedAlternatives(expr);
  if (alternatives) {
    for (const alt of alternatives) {
      const r = evalExpr(root, alt, depth + 1);
      if (r.value !== undefined && r.value !== '') return r;
    }
    return { value: undefined };
  }

  // "<expr> + N year(s)" date arithmetic — checked before generic "+" concatenation.
  const dateMathMatch = expr.match(/^(.*)\+\s*(\d+)\s*years?$/i);
  if (dateMathMatch) {
    const base = evalExpr(root, dateMathMatch[1], depth + 1);
    const years = parseInt(dateMathMatch[2], 10);
    const d = base.value ? toDate(base.value) : null;
    if (!d) return { value: undefined };
    d.setUTCFullYear(d.getUTCFullYear() + years);
    return { value: formatLongDate(d) };
  }

  // "<expr> + <expr> [+ <expr> ...]" concatenation — each side may itself have its own "where".
  if (expr.includes('+')) {
    const parts = expr.split('+').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      const values = parts.map((p) => evalExpr(root, p, depth + 1).value).filter((v) => v !== undefined && v !== '');
      return { value: values.length ? values.join(' ') : undefined };
    }
  }

  // "<targetPath> where <cond> [and <cond> ...]"
  const whereIdx = expr.search(/\swhere\s/i);
  if (whereIdx !== -1) {
    // CONFIRMED live 2026-09-30: the dictionary's own "(concatanated)"/"(concatenated)" annotation (BA
    // narration, not part of the real path — see the "Label -" comment above) sits directly on the target
    // path here too (e.g. "...displayName (concatanated) where ..."), and since it has no dot in it,
    // toSegments left it glued onto the last real segment as "displayName (concatanated)" — a property no
    // payload actually has, so every match's own remaining-path lookup silently came back undefined even
    // though the where-filter itself found the right contact. Strip it before resolveWhere ever sees it.
    const targetPath = expr.slice(0, whereIdx).trim().replace(/\s*\(concat[ae]nated\)\s*$/i, '');
    const whereText = expr.slice(whereIdx).replace(/^\s*where\s*/i, '').trim();
    return resolveWhere(root, targetPath, whereText);
  }

  // Plain juxtaposition of 2+ full dot-paths with nothing between them (no "+", no "where", no keyword) —
  // CONFIRMED live this notation is genuinely ambiguous in the source data (sometimes clearly meant as
  // concatenation, e.g. "To City, State, Zip"; sometimes clearly meant as a fallback, e.g. "Claim Rep Name"
  // mirrors "Claim Representative"'s explicit if/else with the same two paths). Treated as concatenation of
  // whichever parts actually resolve — correct for the concatenation cases, and degrades harmlessly to "just
  // the one real value" for the fallback cases whenever only one side actually has data (the common case).
  const multiPathParts = expr.split(/\s+(?=ccDocumentCreationRequest\.)/).map((s) => s.trim()).filter(Boolean);
  if (multiPathParts.length > 1) {
    const values = multiPathParts.map((p) => evalExpr(root, p, depth + 1).value).filter((v) => v !== undefined && v !== '');
    return { value: values.length ? values.join(' ') : undefined };
  }

  if (/^ccDocumentCreationRequest\./.test(expr) || /^[a-zA-Z_]+(\.[a-zA-Z_]+)+$/.test(expr)) {
    return { value: resolvePath(root, expr) };
  }

  return { value: undefined, unsupported: true, reason: `Expression shape not recognized: "${expr.slice(0, 80)}"` };
}

// A resolved value that's a raw ISO-8601 timestamp (e.g. "2026-08-06T04:01:00Z") is a payload-internal
// representation SmartCOMM ALWAYS renders in a human-readable long-date form before printing — CONFIRMED
// live (Date Reported, Date Employer Notified, and every other bare date-path row): none of these are ever
// covered by a special-cased path the way "Current Date"/date-arithmetic already are, so without this the
// raw timestamp would never match the actual generated document even when the underlying date is correct.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;
function formatIfIsoDate(value) {
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
    const d = toDate(value);
    if (d) return formatLongDate(d);
  }
  return value;
}

// Public: resolve one Data Dictionary row's Xpath against a parsed (or raw XML) payload.
function resolveXpath(payloadRootOrXml, xpathExpr) {
  const root = typeof payloadRootOrXml === 'string' ? parseRawPayload(payloadRootOrXml).ccDocumentCreationRequest : payloadRootOrXml;
  if (!root) return { value: undefined, unsupported: true, reason: 'Payload has no <ccDocumentCreationRequest> root' };
  try {
    const result = evalExpr(root, xpathExpr, 0);
    return result.value !== undefined ? { ...result, value: formatIfIsoDate(result.value) } : result;
  } catch (e) {
    return { value: undefined, unsupported: true, reason: `Interpreter error: ${e.message}` };
  }
}

module.exports = { parseRawPayload, parseRawPayloadFile, resolveXpath, ARRAY_TAGS };
