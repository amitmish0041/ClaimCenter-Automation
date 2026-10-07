/**
 * helpers/smartComm/templateRequirementService.js
 * Turns a template's own reference Word document (the "Template Mapping
 * Document" column in Claims_Documents_Index.xlsx) into an ordered list of
 * requirements — no per-template authoring. Point this at a different DIG's
 * Word doc and it produces a different requirement list automatically.
 *
 * PRIMARY PATH — comment-driven (used whenever the .docx has word/comments.xml,
 * which is the standard BA-authored "mapping document" convention CONFIRMED
 * live on DIG52): the BA's own Word comments say exactly which text spans are
 * per-instance dynamic values and what ClaimCenter field they come from (e.g.
 * a comment "Claim Number" anchored to "PA-PA-01-20-0736381"), and which are
 * just cross-reference notes about shared/base-template elements (a comment
 * with a highlighted first-line TAG like "Logo"/"Website" — CONFIRMED live:
 * these describe base-template provenance, not per-claim variability, so
 * their anchored text is left as static). Everything NOT covered by a
 * genuine dynamic-value comment is asserted as static text, verbatim — this
 * is authoritative, BA-reviewed ground truth, not a guess.
 *
 * FALLBACK PATH — heuristic (used only when a template's .docx has no
 * comments): the original label/shape/inline-value classifier. Treat its
 * output as a strong starting point, not gospel — see buildRequirements()'s
 * own comment for exactly what it does and doesn't catch.
 */
'use strict';
const fs = require('fs');
const path = require('path');
let AdmZip;
try { AdmZip = require('adm-zip'); } catch (_) { /* reported lazily in extractDocxParagraphs */ }
let WordExtractor;
try { WordExtractor = require('word-extractor'); } catch (_) { /* reported lazily in getRequirements' .doc branch */ }

const synonyms = require('./fieldLabelSynonyms');

// Word's own XML escapes &, <, >, ", ' as entities inside <w:t> text — CONFIRMED live 2026-10-06 (DIG122A,
// "Date &amp; Time of Accident"): raw regex extraction below never decoded these back, so a requirement's own
// expected text carried the LITERAL string "&amp;" instead of a real "&", which the generated PDF (a genuine
// ampersand) could never literally match — a false FAIL on an otherwise-correct document. Also handles
// numeric entities (Word uses those for some punctuation too). "&amp;" is decoded LAST so a double-escaped
// "&amp;amp;" (if Word ever produces one) doesn't get decoded twice into the wrong character.
function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function textOfRuns(xmlFragment) {
  return decodeXmlEntities(Array.from(xmlFragment.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)).map(m => m[1]).join(''));
}

// Like textOfRuns, but also emits a space for every paragraph boundary
// crossed — needed when extracting a comment anchor's own text, since a
// naive replace of "</w:p>" in the RAW xml (before regex-matching just the
// <w:t> runs out of it) has no effect: that replacement lands OUTSIDE every
// <w:t>...</w:t> match, so the extraction regex never sees it (CONFIRMED via
// live failure — DIG52's "MEDICAL BILLS..." anchor, which spans exactly one
// such boundary, kept coming back with no space between "ONLY:" and
// "Donegal" no matter where the replace was applied upstream). Matching
// <w:t> runs and </w:p> markers in one pass, in document order, is the only
// way to interleave the space at the right point in the OUTPUT text.
function textOfRunsWithParagraphBreaks(xmlFragment) {
  let result = '';
  for (const m of xmlFragment.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<\/w:p>/g)) {
    result += m[1] !== undefined ? m[1] : ' ';
  }
  return decodeXmlEntities(result);
}

function paragraphsFromDocumentXml(xml) {
  return xml.split('</w:p>')
    .map(p => textOfRuns(p))
    .map(t => t.trim())
    .filter(Boolean);
}

function extractDocxParagraphs(docxPath) {
  if (!AdmZip) throw new Error('adm-zip is not installed — run npm install in ClaimCenter-Automation');
  const zip = new AdmZip(docxPath);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error(`templateRequirementService: ${docxPath} has no word/document.xml (not a .docx?)`);
  return paragraphsFromDocumentXml(entry.getData().toString('utf8'));
}

// A fillable field is mostly underscores/whitespace once the rest is
// stripped — e.g. "1.  Occupation: ________________________".
function isBlankField(line) {
  const stripped = line.replace(/[_\s]/g, '');
  return line.includes('___') && stripped.length < line.length * 0.3;
}

function isShortLabel(line) {
  if (line.length > 60) return false;
  // A line recognised in fieldLabelSynonyms is a label regardless of case
  // ("Employee's Name and Address" is Title Case, not ALL-CAPS, but is a
  // real label with a dynamic value following it) — check that first so the
  // ALL-CAPS-only heuristic below doesn't miss it.
  if (synonyms.lookup(line) !== undefined) return true;
  // Letters only, deliberately no digits — a claim/policy number like
  // "PA-PA-01-23-0741389" is also all-uppercase-and-hyphens and would
  // otherwise false-positive as a structural label instead of a value.
  return line.length <= 45
    && /^[A-Z][A-Z ,.'’()/&-]*$/.test(line)
    && /[A-Z]{2,}/.test(line);
}

// "Static content must appear" was the SAME, bare description on every one of these checks regardless of
// WHICH content — a cross-template pattern scan (2026-10-04 full-catalog run, 238 templates) found it was the
// single biggest FAIL bucket (38 templates) purely because every genuinely-different missing string got
// lumped under one identical label, hiding the fact that these are 38 unrelated single-template issues, not
// one shared defect. A short quoted snippet of the actual expected text turns this back into something a
// cross-template report can usefully group by description.
function staticContentDescription(value) {
  const snippet = String(value || '').trim().slice(0, 60);
  return `Static content must appear: "${snippet}${value && value.length > 60 ? '…' : ''}"`;
}

function classifyDynamicShape(line) {
  if (synonyms.PATTERNS.date.test(line)) return 'date';
  if (synonyms.PATTERNS.currency.test(line)) return 'currency';
  if (synonyms.PATTERNS.email.test(line)) return 'email';
  if (synonyms.PATTERNS.phone.test(line)) return 'phone';
  return null;
}

// Page-break/table-artifact dots ("." or ".    .              .") that the
// simple <w:t> extraction sometimes yields, OR a lone trailing-punctuation
// fragment left behind once a mid-sentence dynamic value is cut out (e.g.
// "Dear {NAME}," splits into "Dear" + "," once {NAME} is removed — CONFIRMED
// live: without this, "," became its own "must appear" requirement that's
// trivially true of nearly any document, silently losing the one genuinely
// meaningful check — that "Dear" is followed by a comma, not a colon — by
// diluting it into two checks, one of which verifies nothing). Not real,
// assertable content either way. "|" added CONFIRMED live 2026-09-30 (65-
// template sweep, DIG78/DIG54/DIG5/others): a table-cell border/divider
// character extracted as its own standalone "static content" requirement,
// always FAILing since it's a layout artifact of the reference .docx's own
// table structure, never real rendered text in the generated document.
function isNoiseLine(line) {
  return /^[\s.,:;!?'"()|-]+$/.test(line) && line.replace(/\s/g, '').length <= 3;
}

// Some templates put label+value on the SAME line, sometimes several pairs
// per line, e.g. "RE:Our Claim No.:PA-PA-01-26-0000209" — used by the
// heuristic fallback path only (the comment-driven path doesn't need this;
// the BA's own comment ranges already say exactly where each value is).
const INLINE_LABEL_KEYS = Object.keys(synonyms.LABEL_TO_TESTDATA_FIELD).sort((a, b) => b.length - a.length);
const INLINE_LABEL_RE = new RegExp(
  '(' + INLINE_LABEL_KEYS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|') + ')\\.?\\s*:\\s*',
  'gi'
);

function extractInlineLabelValues(line) {
  const matches = [...line.matchAll(INLINE_LABEL_RE)];
  if (!matches.length) return null;
  const pairs = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : line.length;
    const value = line.slice(start, end).split(/\s{2,}/)[0].trim();
    if (value) pairs.push({ label: m[1], value });
  }
  return pairs.length ? pairs : null;
}

// Conditional content gated on an ADDITIONAL RECIPIENT being entered is, by construction, that recipient's
// own name/number/address — inherently per-claim data (whoever happens to get added that scenario), never
// fixed boilerplate — unlike e.g. a letterhead paragraph gated on a Choices-panel Yes/No, which prints the
// exact same text every time. CONFIRMED live 2026-10-02 (DIG223): "Only display 'CC:' Name and Number and
// Address if additional recipient is entered" anchors on the reference .docx's own SAMPLE name/address
// ("John Thompson ... Denver, CO 80205") — the real additional recipient (a different contact per claim)
// will never match that sample text, so useLiteralText below must not fire for these; they're a guaranteed
// FAIL otherwise regardless of whether the real recipient's own name/address correctly prints elsewhere.
const RECIPIENT_DEPENDENT_RE = /\badditional recipient\b|\bcc\b.*\b(?:name|address|number)\b|^copy\b/i;

// Some BA comments describe the EDITOR'S OWN mechanics ("Checkboxes are editable", "Checkboxes selected
// manually", "Free Form Editable") rather than real document content — CONFIRMED live 2026-10-04 (full-
// catalog scan, 238 templates): these can never resolve to an actual expected VALUE (there's no "correct
// answer" for whether a checkbox is editable — it's not a fact about the claim), so they sat permanently
// BLOCKED ("no shape or test-data field known") rather than being genuinely-unmapped per-claim content.
// Whether a field is actually editable is ALREADY verified separately by this tool's own interactiveChecks
// (dictionary-declared vs. observed editability) — this was the same fact being described twice, once as a
// real check and once as a dead-end content requirement.
const BEHAVIORAL_COMMENTARY_RE = /\b(?:is|are)\s+editable\b|selected manually|free form editable/i;

function makeDynamicRequirement(n, fieldName, value, { conditional = false, conditionReason = '' } = {}) {
  const field = synonyms.lookup(fieldName);
  const shape = classifyDynamicShape(value) || 'text';
  // A CONDITIONAL field with no dictionary mapping and a generic "text" shape is very likely a static,
  // toggleable content block (e.g. a letterhead paragraph shown only when a Choices-panel question is Yes)
  // rather than an unrecognized PER-CLAIM placeholder sample value — CONFIRMED live 2026-10-02 (DIG52's
  // medical-letterhead block): the BA comment itself ("Display only if Apply Medical Letterhead? is selected
  // Yes...") is the display CONDITION, while the paragraph it's anchored on (this `value`) is the actual
  // literal text that prints once the condition is met — real, checkable content, not a vague unmapped
  // shape that can only ever report BLOCKED. Scoped to conditional fields only: a NON-conditional unmapped
  // field could still legitimately be an unrecognized per-claim-varying sample value, where a literal match
  // would be wrong. Additional-recipient-dependent content (see RECIPIENT_DEPENDENT_RE) is excluded even
  // though it's conditional and text-shaped — it's per-claim data, not boilerplate.
  const useLiteralText = !field && conditional && shape === 'text' && value && value.trim().length > 3 && !RECIPIENT_DEPENDENT_RE.test(fieldName);
  const req = {
    id: `R${n}`,
    description: field
      ? `Value for "${fieldName}" must match ${field}`
      : useLiteralText
        ? `The template's own literal text must appear for "${fieldName}"`
        : `A ${shape}-shaped value must appear for "${fieldName}"`,
    type: field ? 'dynamicValueMatch' : (useLiteralText ? 'requiredText' : 'dynamicShape'),
    expectedSource: field || undefined,
    ...(useLiteralText ? { expectedValue: value.trim() } : {}),
    shape,
    fieldName, // raw BA-comment/label text — lets tooling audit field-name coverage across the whole catalog without re-parsing descriptions
  };
  if (conditional) {
    req.enabled = false;
    req.disabledReason = conditionReason;
  } else if (!field && BEHAVIORAL_COMMENTARY_RE.test(fieldName)) {
    req.enabled = false;
    req.disabledReason = `Describes the editor's own mechanics ("${fieldName}"), not document content — already covered by this tool's own interactive-field editability checks.`;
  }
  return req;
}

// ── Heuristic fallback (no comments.xml) ────────────────────────────────────
function buildRequirementsHeuristic(paragraphs) {
  const requirements = [];
  let n = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const line = paragraphs[i];
    if (isBlankField(line) || isNoiseLine(line)) continue;

    const inlinePairs = extractInlineLabelValues(line);
    if (inlinePairs) {
      for (const { label, value } of inlinePairs) {
        const req = makeDynamicRequirement(++n, label, value);
        req.docOrder = i;
        requirements.push(req);
      }
      continue;
    }

    if (isShortLabel(line)) {
      requirements.push({
        id: `R${++n}`, description: `Label "${line}" must appear`,
        type: 'requiredText', expectedValue: line, docOrder: i,
      });
      const next = paragraphs[i + 1];
      const nextIsUsable = next !== undefined && !isShortLabel(next) && !isBlankField(next) && !isNoiseLine(next);
      if (synonyms.lookup(line) !== undefined && nextIsUsable) {
        const req = makeDynamicRequirement(++n, line, next);
        req.docOrder = i + 1;
        requirements.push(req);
        i++; // consumed the value line as part of this label
      }
      continue;
    }

    const shape = classifyDynamicShape(line);
    if (shape) {
      requirements.push({
        id: `R${++n}`, description: `A ${shape}-shaped value must appear`,
        type: 'dynamicShape', shape, docOrder: i,
      });
      continue;
    }

    requirements.push({
      id: `R${++n}`, description: staticContentDescription(line),
      type: 'requiredText', expectedValue: line, docOrder: i,
    });
  }
  return requirements;
}

// ── Comment-driven (comments.xml present) ───────────────────────────────────

function parseComments(commentsXml) {
  const blocks = [...commentsXml.matchAll(/<w:comment w:id="(\d+)"[^>]*w:author="([^"]*)"[^>]*>([\s\S]*?)<\/w:comment>/g)];
  const comments = {};
  for (const [, id, author, body] of blocks) {
    // A highlighted first run is a short TAG ("Logo", "Website") marking a
    // cross-reference note about a shared/base-template element — CONFIRMED
    // live these are NOT per-instance dynamic-value indicators, unlike every
    // other (untagged) comment, which names the actual ClaimCenter field.
    const highlightMatch = body.match(/<w:highlight[^>]*\/>[\s\S]*?<w:t>([^<]*)<\/w:t>/);
    comments[id] = {
      author,
      fullText: textOfRuns(body).trim(),
      highlightedTag: highlightMatch ? decodeXmlEntities(highlightMatch[1]).trim() : null,
    };
  }
  return comments;
}

// Anchors are returned in document order with their raw start/end offsets
// into documentXml — buildRequirementsFromComments re-locates each one's
// text within the joined-paragraph string separately (offsets don't carry
// over once <w:p>/<w:r> markup is stripped out for that step). A </w:p>
// inside the range becomes a space in the anchor's own text — CONFIRMED
// live: DIG52's "MEDICAL BILLS..." conditional block spans a paragraph
// break, and matching it later requires that break to line up with the
// "\n" paragraphsFromDocumentXml() would produce for the same content.
function parseCommentAnchors(documentXml) {
  const anchors = [];
  const startRe = /<w:commentRangeStart w:id="(\d+)"\/>/g;
  let m;
  while ((m = startRe.exec(documentXml))) {
    const id = m[1];
    const endMarker = `<w:commentRangeEnd w:id="${id}"/>`;
    const endIdx = documentXml.indexOf(endMarker, m.index);
    if (endIdx === -1) continue;
    const text = textOfRunsWithParagraphBreaks(documentXml.slice(m.index, endIdx)).trim();
    anchors.push({ id, startIdx: m.index, text });
  }
  anchors.sort((a, b) => a.startIdx - b.startIdx);
  return anchors;
}

// Catalog-wide scan (2026-09-04, 240 templates) of every BA comment text
// found real conditional phrasing this pattern was missing: "Only display X
// if Y" (subject/verb before "only", not after — DIG2/DIG226), a bare "only
// if" (DIG235), "if <field> is entered/added" (DIG124/DIG2/DIG226/DIG230),
// "Else do not display/print" (DIG124/DIG2/DIG226), "Otherwise will not
// display" (DIG230 — "will not" without the literal word "visible"), a
// state-branch note like "If Policy State = MD, print X. Otherwise print Y"
// (DIG38/DIG129 — one of several state-specific variants always renders, so
// there's no single literal string to require; treated as conditional since
// there's no per-state expected-text source to check it against), and
// "Fraud Language" (DIG22/DIG32 — explicitly out of current validation
// scope per the QA deck, not a real dynamic/static field).
//
// "Copy Name"/"Copy Address"/"Copy City, State, ZIP" (DIG51/DIG83) are the
// CC recipient's own name/address block — by definition only present when
// a CC/additional recipient exists — but their OWN comment anchors carry no
// conditional wording; the actual "only if additional recipient entered"
// note sits on a SEPARATE, earlier sibling comment (its own anchor range
// ends before "Copy Name"'s begins — CONFIRMED live, not a nested/wrapping
// range, so an ancestor-containment check finds nothing to inherit from).
// Matched directly by name instead: every "Copy ..." field found across the
// full catalog (2026-09-04 scan) is one of these three, with no unrelated
// field sharing that prefix, so it's safe as a direct, unscoped match.
const CONDITIONAL_RE = /display only if|only (?:visible|shown|displayed) if|\bonly\b[^.]{0,40}\bif\b|otherwise[^.]*(?:not[^.]*visible|will not|do not)|will not (?:be )?(?:visible|display|print|show)|if\b.*\b(?:is selected|is entered|is added)\b|if\b.*\bcheckbox|else\b.*\bdo not\b|^fraud language\b|if\b.*\bstate\s*=|^copy\b/i;

// Collapses whitespace to single spaces while recording, for each character
// kept, its index in the ORIGINAL string — lets anchor text be located in
// fullText regardless of exactly how much/what kind of whitespace (a run of
// spaces from a tab stop, a "\n" paragraph break) separates its words there,
// then maps the match straight back to real fullText coordinates for removal.
function normalizeWithPositionMap(text) {
  let normalized = '';
  const map = [];
  let inWhitespace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!inWhitespace) { normalized += ' '; map.push(i); inWhitespace = true; }
    } else {
      normalized += ch; map.push(i); inWhitespace = false;
    }
  }
  return { normalized, map };
}
function normalizeWs(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// Re-classifies whatever text is LEFT after every dynamic-comment span has
// been removed — the same static/label logic the heuristic path uses, just
// applied to residual fragments (e.g. "Our Insured.:" left behind once its
// own comment-anchored value "Insured Person" is stripped out).
//
// Returns an ARRAY (zero or more requirements) rather than one-or-null —
// see the inline-label-pairs case below, which can emit several from a
// single fragment.
function classifyResidualFragment(fragment, docOrder) {
  const line = fragment.trim();
  if (!line || isBlankField(line) || isNoiseLine(line)) return [];
  // CONFIRMED live 2026-09-30 (DIG52's own "See Fraud Language sheet for details..."): a plain BODY
  // paragraph (not a tracked comment, so makeDynamicRequirement's own CONDITIONAL_RE never sees it) can
  // ALSO just be the BA's note-to-self pointing at the Fraud Language reference sheet, rather than literal
  // print content — the SAME phrase docxMentionsFraudLanguage already watches for, to trigger the REAL
  // state-specific check validationService builds separately (see buildFraudLanguageRequirements). Treating
  // this sentence itself as "static content must appear" always failed, since it's instructional text never
  // meant to print — excluded here the same way blank/noise lines are, not turned into a requirement at all.
  if (/fraud\s+language/i.test(line)) return [];

  // A recognized label glued directly to its value on the SAME line (e.g.
  // "Date of Loss:May 03,") — left over because the BA's own comments never
  // anchored this field at all, not because it's genuinely static. Without
  // this check it fell straight through to the plain "Static content must
  // appear" case below, pinned verbatim to whatever example date/value the
  // source Word doc happened to be authored with — CONFIRMED live: every
  // scenario across DIG24/DIG25/DIG34/DIG35 failed on exactly this, "Date of
  // Loss:May 03," never matching any real claim's actual loss date. The
  // heuristic fallback path already solves this via extractInlineLabelValues
  // (built from the same fieldLabelSynonyms.js catalog "DATE OF LOSS" ->
  // testData.lossDate entry) — reusing it here gives a residual fragment the
  // same dynamic-value treatment the heuristic path already gets, instead of
  // needing a second, separate fix.
  const inlinePairs = extractInlineLabelValues(line);
  if (inlinePairs) {
    return inlinePairs.map(({ label, value }) => ({ ...makeDynamicRequirement(0, label, value), docOrder }));
  }

  if (isShortLabel(line)) {
    return [{ id: 'R0', description: `Label "${line}" must appear`, type: 'requiredText', expectedValue: line, docOrder }];
  }
  const shape = classifyDynamicShape(line);
  if (shape) {
    return [{ id: 'R0', description: `A ${shape}-shaped value must appear`, type: 'dynamicShape', shape, docOrder }];
  }

  // A residual fragment can still contain an EMBEDDED gap — a merge field the BA's own comments never
  // anchored at all (CONFIRMED live: DIG166 has only 21 BA-annotated fields for a 26-merge-field document),
  // which document.xml extraction renders as plain empty space between two genuinely static runs (e.g. "of
  //         Dollars ($        )" — two un-commented currency fields sitting inside an otherwise fully
  // static sentence). Treating the WHOLE fragment as one literal "static" string means it can never match
  // again once a real value fills that gap — CONFIRMED live: this exact fragment FAILs 100% of the time on
  // any scenario with real data, even though the wording on either side of the gap never changes. Splits
  // around any interior run of 2+ whitespace characters and asserts each surrounding piece separately
  // instead, so filling the gap with real content no longer breaks the (still genuinely static) wording
  // around it. Safe even for a fragment whose double-space is just an unrelated formatting artifact, not an
  // un-annotated field — each split piece is still a real, findable substring of the document either way.
  const rawPieces = line.split(/\s{2,}/);
  if (rawPieces.length > 1) {
    // A genuine gap WAS found (that's what matters here, not how many pieces survive next) — CONFIRMED live
    //2026-09-30 (DIG158): "This is in response to your request dated      ." splits into the real sentence
    // plus a lone ".", and that trailing "." correctly gets dropped as noise by the SAME filter used
    // elsewhere in this file — but the ORIGINAL bug used `pieces.length > 1` (i.e. requiring at least 2
    // pieces to SURVIVE the filter) as the trigger, so a gap with only one meaningful side fell through to
    // the unsplit `line` below, silently undoing the split it just did. Whatever survives the filter (even
    // just one piece) is what must be asserted — never the original gap-containing string.
    const pieces = rawPieces.map((p) => p.trim()).filter((p) => p && !isNoiseLine(p));
    if (pieces.length) {
      return pieces.map((p) => ({ id: 'R0', description: staticContentDescription(p), type: 'requiredText', expectedValue: p, docOrder }));
    }
    return [];
  }

  return [{ id: 'R0', description: staticContentDescription(line), type: 'requiredText', expectedValue: line, docOrder }];
}

function buildRequirementsFromComments(paragraphs, anchors, comments) {
  const requirements = [];
  let n = 0;

  // Only genuinely dynamic/conditional anchors — an empty anchor text means
  // it wraps a non-text element (e.g. an inline logo image), nothing to
  // assert; a highlighted-tag comment is a base-template cross-reference,
  // not a per-instance value (see parseComments) — leave that text static.
  // A plain-text "See Base Template/Letterhead for ... Requirements" note
  // (CONFIRMED catalog-wide 2026-09-04: 27 templates each for "Logo (in
  // header)..." and "Website (in header)...", always this exact phrasing)
  // is the SAME kind of cross-reference, just not highlighted — without
  // this it was landing as an unclassified shape:'text' dynamicShape
  // requirement, which always reports BLOCKED (54 templates' worth of pure
  // noise, nothing a reviewer could act on).
  const isBaseTemplateCrossRef = (comment) => /see base template/i.test(comment.fullText || '');
  const dynamicAnchors = anchors
    .map(a => ({ ...a, comment: comments[a.id] }))
    .filter(a => a.text && a.comment && !a.comment.highlightedTag && !isBaseTemplateCrossRef(a.comment));

  // Work on one big string so an anchor spanning a paragraph break (CONFIRMED
  // live: DIG52's "MEDICAL BILLS..." conditional block does exactly this)
  // still matches — paragraph boundaries become plain "\n" here.
  const fullText = paragraphs.join('\n');
  const { normalized, map } = normalizeWithPositionMap(fullText);

  // Pass 1 — locate each anchor in fullText, whitespace-insensitively (the
  // anchor's own extracted text may have a single space where fullText has a
  // "\n", or a run of spaces from a tab stop the PDF later renders as a
  // plain single space) and forward-only, so a value repeated verbatim (the
  // recipient's name in both the address block and the "Dear ..." line)
  // resolves each of its two separate comment anchors to its own, in-order
  // occurrence instead of both matching the first.
  const matches = [];
  let normCursor = 0;
  for (const a of dynamicAnchors) {
    const needle = normalizeWs(a.text);
    if (!needle) continue;
    const foundAt = normalized.indexOf(needle, normCursor);
    if (foundAt === -1) continue; // not found from here on — leave as static downstream
    const startIdx = map[foundAt];
    const endIdx = map[Math.min(foundAt + needle.length - 1, map.length - 1)] + 1;
    matches.push({ startIdx, endIdx, anchor: a });
    normCursor = foundAt + needle.length;
  }

  // Pass 1.5 — a label-only anchor (its own text ends with ":", e.g. "Claimant:"
  // — CONFIRMED live: id=9's comment anchors just the label, not the sample
  // value "Max Claimant" that follows it on the same line) implicitly governs
  // whatever unclaimed text immediately follows it, up to the next match or a
  // real boundary (a big gap or a newline). Absorb that trailing text into the
  // SAME match — inheriting the same field/condition — rather than leaving it
  // to fall through as a bogus "static, must match this one sample verbatim"
  // requirement. Only label-ending anchors qualify: one whose own text IS the
  // value (e.g. a claim number) has nothing further to claim.
  matches.sort((x, y) => x.startIdx - y.startIdx);
  matches.forEach((match, i) => {
    if (!match.anchor.text.trim().endsWith(':')) return;
    const boundary = i + 1 < matches.length ? matches[i + 1].startIdx : fullText.length;
    const after = fullText.slice(match.endIdx, boundary);
    const trailing = after.match(/^\s?([^\n]*?)(?=\s{2,}|\n|$)/);
    if (trailing && trailing[1].trim()) {
      match.endIdx += trailing[0].length;
    }
  });

  // Pass 2 — emit one requirement per match, then cut every matched range
  // out of fullText (reverse order, so earlier ranges' indices stay valid).
  for (const { startIdx, anchor } of matches) {
    const fieldName = anchor.comment.fullText;
    const isConditional = CONDITIONAL_RE.test(fieldName);
    const req = makeDynamicRequirement(++n, fieldName, anchor.text, {
      conditional: isConditional,
      conditionReason: isConditional ? `Conditional per template author's note: "${fieldName}"` : undefined,
    });
    req.docOrder = startIdx;
    requirements.push(req);
  }

  // Splitting at "\n" rather than concatenating the two sides directly
  // matters: a value removed from mid-sentence ("...in the area of
  // {LOCATION}.") would otherwise glue its neighbours into "...in the area
  // of." — a string that never actually appears anywhere in the real
  // document, since the real document has the actual location sitting right
  // there between them (CONFIRMED live on DIG126 — the trailing period IS
  // present immediately after the rendered address; this false-glued
  // residual was reporting it as a punctuation mismatch that isn't real). A
  // stray "\n" left over where two fragments now sit on their own line each
  // is harmless — classifyResidualFragment already drops blank fragments,
  // and a lone leftover "." is caught by isNoiseLine.
  let residual = fullText;
  for (const { startIdx, endIdx } of [...matches].sort((x, y) => y.startIdx - x.startIdx)) {
    residual = residual.slice(0, startIdx) + '\n' + residual.slice(endIdx);
  }

  // Character offset into the residual text, matching the scale dynamic
  // anchors' docOrder was recorded in — an array index here would put every
  // static fragment before every dynamic field regardless of where either
  // actually falls in the document.
  let offset = 0;
  for (const frag of residual.split('\n')) {
    for (const req of classifyResidualFragment(frag, offset)) {
      req.id = `R${++n}`;
      requirements.push(req);
    }
    offset += frag.length + 1; // +1 for the '\n' consumed by split
  }

  // Preserve document order in the final list (dynamic requirements were
  // appended by anchor position, static ones by residual-fragment order —
  // interleave by docOrder so a report reads top-to-bottom like the letter).
  requirements.sort((x, y) => x.docOrder - y.docOrder);
  requirements.forEach((r, i) => { r.id = `R${i + 1}`; });
  return requirements;
}

// Catalog-wide audit (240 templates, 2026-09-04) found the exact-basename
// match below missing real, present files for three reasons — an index
// over every file actually in Templates/ClaimCenter, looked up by a
// normalized stem, catches all three generically instead of hand-coding a
// fix per template:
//   1. A stale download-duplicate suffix in the spreadsheet's mapped path
//      that isn't in the real filename (CONFIRMED: DIG11 mapped to
//      "...(3).docx", the real file has no suffix at all).
//   2. The file is old-format .doc, not .docx (CONFIRMED: DIG15, DIG26,
//      DIG125, DIG167, DIG168, DIG175 and others) — genuinely present, just
//      out of scope for this parser; the caller still needs to actually
//      FIND it to correctly report "not a .docx" rather than "missing".
//   3. Repeated underscores/whitespace differ between the mapped path and
//      the real filename (CONFIRMED: DIG25 — index vs. actual file).
function normalizeFilenameStem(stem) {
  return String(stem || '').toLowerCase()
    .replace(/\s*\(\d+\)\s*$/, '') // trailing " (3)" version-duplicate suffix
    .replace(/[_\s]+/g, '_')
    .trim();
}

let templatesDirIndexCache = null;
function buildTemplatesDirIndex(templatesDir) {
  if (templatesDirIndexCache) return templatesDirIndexCache;
  templatesDirIndexCache = new Map();
  if (!fs.existsSync(templatesDir)) return templatesDirIndexCache;
  for (const file of fs.readdirSync(templatesDir)) {
    const full = path.join(templatesDir, file);
    if (!fs.statSync(full).isFile()) continue;
    const ext = path.extname(file);
    const key = normalizeFilenameStem(file.slice(0, file.length - ext.length));
    const existing = templatesDirIndexCache.get(key);
    // Prefer .docx over any other extension if a normalized stem collides.
    if (!existing || (ext.toLowerCase() === '.docx' && path.extname(existing).toLowerCase() !== '.docx')) {
      templatesDirIndexCache.set(key, full);
    }
  }
  return templatesDirIndexCache;
}

// Every file's OWN leading "DIGnnn..." token, keyed for an O(1) lookup by a
// template's own catalog digNumber — used when the spreadsheet's mapped
// path names a DIFFERENT template's file entirely, not just a typo'd
// filename (CONFIRMED live twice: DIG40's mapping points at the real, existing
// "DIG37_Vehicle_Theft_Loss_Questionnaire.docx" — DIG37's file, not DIG40's;
// DIG236's points at DIG226's "Authorization_to_Treat.docx". Both templates
// have their own genuine, differently-named file sitting right there in the
// same folder, findable only by its own DIG-number prefix, since the rest of
// the filename has nothing in common with the (wrong) mapped one).
let digPrefixIndexCache = null;
function buildDigPrefixIndex(templatesDir) {
  if (digPrefixIndexCache) return digPrefixIndexCache;
  digPrefixIndexCache = new Map();
  if (!fs.existsSync(templatesDir)) return digPrefixIndexCache;
  for (const file of fs.readdirSync(templatesDir)) {
    const full = path.join(templatesDir, file);
    if (!fs.statSync(full).isFile()) continue;
    const m = file.match(/^(DIG\d+[A-Z0-9]*)/i);
    if (!m) continue;
    const key = m[1].toUpperCase();
    const list = digPrefixIndexCache.get(key) || [];
    list.push(full);
    digPrefixIndexCache.set(key, list);
  }
  return digPrefixIndexCache;
}

// The catalog's "Template Mapping Document" column is an S:\ share path
// (e.g. "S:\...\HPExstream Document Mapping\ClaimCenter\DIG47_PA_Wage_
// Verification.docx"); the local mirror under Templates/ClaimCenter/ uses
// the identical file name in the common case, so resolving is normally just
// a basename swap — the indexes above only matter for the exceptions.
function resolveLocalTemplatePath(template, dataDir) {
  const mapped = String(template.templateMappingDoc || '').trim();
  const baseName = path.basename(mapped);
  if (!baseName) return null;
  const templatesDir = path.join(dataDir, 'Templates', 'ClaimCenter');

  const exact = [path.join(templatesDir, baseName), path.join(templatesDir, baseName + '.docx')];
  const exactHit = exact.find(p => fs.existsSync(p));
  // An exact hit whose OWN filename disagrees with the catalog row it came
  // from (a different DIG number at the front) is a sign of a wrong
  // reference, not a preference to defer to — see buildDigPrefixIndex.
  const exactMatchesOwnDig = exactHit
    && new RegExp('^' + template.digNumber + '(?:[_\\s.]|$)', 'i').test(path.basename(exactHit));
  if (exactHit && exactMatchesOwnDig) return exactHit;

  const ownDigMatches = buildDigPrefixIndex(templatesDir).get(template.digNumber.toUpperCase()) || [];
  if (ownDigMatches.length === 1) return ownDigMatches[0];

  // Fuzzy basename match — handles a stale version-duplicate suffix, an old
  // .doc extension, or repeated underscores (CONFIRMED live: DIG11's "(3)"
  // suffix, DIG15/DIG26/DIG125/DIG167/DIG168/DIG175's .doc files, DIG25's
  // double underscore) before finally giving up.
  const index = buildTemplatesDirIndex(templatesDir);
  const ext = path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  const fuzzyHit = index.get(normalizeFilenameStem(stem));
  if (fuzzyHit) return fuzzyHit;

  return exactHit || null;
}

// True when a "Fraud Language" instruction appears ANYWHERE in the Word
// template — body, comments, or (the case that mattered) the header/footer,
// which requirement extraction never reads. DIG52's footer, for one, holds
// only the BA note "See Fraud Language sheet for details of language to
// include by state", which is what tells us this letter must carry the
// state-specific wording from the Claims_Documents_Index "Fraud Language" tab.
function docxMentionsFraudLanguage(zip) {
  return zip.getEntries().some((e) =>
    /^word\/(document|comments|footer\d*|header\d*)\.xml$/i.test(e.entryName) &&
    /fraud\s+language/i.test(textOfRuns(e.getData().toString('utf8'))));
}

async function getRequirements(template, dataDir) {
  const localPath = resolveLocalTemplatePath(template, dataDir);
  if (!localPath) {
    console.log(`[SmartComm] templateRequirementService: no local Word doc found for ${template.digNumber} (mapped: "${template.templateMappingDoc}")`);
    return { requirements: [], sourceFile: null, mode: null };
  }
  // A legacy .doc (pre-2007 binary Word format — CONFIRMED live for DIG15/DIG26/DIG125/DIG167/DIG168/DIG175,
  // see resolveLocalTemplatePath's own note) is a REAL, readable template, not an overlay PDF form — it was
  // previously lumped in with genuinely-unparseable files and silently produced zero requirements. AdmZip
  // can't read it (.doc isn't a ZIP), so it goes through word-extractor instead, straight into the SAME
  // heuristic classifier a comments-less .docx already uses — .doc has no BA-comment equivalent, so the
  // comment-driven path is never available for it.
  if (localPath.toLowerCase().endsWith('.doc')) {
    if (!WordExtractor) throw new Error('word-extractor is not installed — run npm install in ClaimCenter-Automation');
    let extracted;
    try {
      extracted = await new WordExtractor().extract(localPath);
    } catch (e) {
      console.log(`[SmartComm] templateRequirementService: ${localPath} could not be read as a .doc file (${e.message}) — skipping`);
      return { requirements: [], sourceFile: localPath, mode: null };
    }
    const paragraphs = extracted.getBody().split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
    const mentionsFraudLanguage = /fraud\s+language/i.test(`${extracted.getHeaders() || ''} ${extracted.getFooters() || ''} ${extracted.getBody() || ''}`);
    console.log(`[SmartComm] templateRequirementService: ${template.digNumber} is a legacy .doc — using word-extractor + the heuristic classifier (${paragraphs.length} paragraphs)`);
    return { requirements: buildRequirementsHeuristic(paragraphs), sourceFile: localPath, mode: 'heuristic-doc', mentionsFraudLanguage };
  }
  if (!localPath.toLowerCase().endsWith('.docx')) {
    console.log(`[SmartComm] templateRequirementService: ${localPath} is not a .docx (likely an overlay PDF form) — generic parsing doesn't apply yet; skipping`);
    return { requirements: [], sourceFile: localPath, mode: null };
  }
  if (!AdmZip) throw new Error('adm-zip is not installed — run npm install in ClaimCenter-Automation');

  const zip = new AdmZip(localPath);
  const mentionsFraudLanguage = docxMentionsFraudLanguage(zip);
  const documentEntry = zip.getEntry('word/document.xml');
  if (!documentEntry) throw new Error(`templateRequirementService: ${localPath} has no word/document.xml (not a .docx?)`);
  const documentXml = documentEntry.getData().toString('utf8');
  const paragraphs = paragraphsFromDocumentXml(documentXml);

  const commentsEntry = zip.getEntry('word/comments.xml');
  if (commentsEntry) {
    const comments = parseComments(commentsEntry.getData().toString('utf8'));
    const anchors = parseCommentAnchors(documentXml);
    if (anchors.length) {
      console.log(`[SmartComm] templateRequirementService: ${template.digNumber} using comment-driven requirements (${anchors.length} BA-annotated fields)`);
      return { requirements: buildRequirementsFromComments(paragraphs, anchors, comments), sourceFile: localPath, mode: 'comments', mentionsFraudLanguage };
    }
  }

  console.log(`[SmartComm] templateRequirementService: ${template.digNumber} has no usable Word comments — using heuristic classifier`);
  return { requirements: buildRequirementsHeuristic(paragraphs), sourceFile: localPath, mode: 'heuristic', mentionsFraudLanguage };
}

module.exports = {
  getRequirements,
  extractDocxParagraphs,
  buildRequirements: buildRequirementsHeuristic, // back-compat name
  resolveLocalTemplatePath,
};
