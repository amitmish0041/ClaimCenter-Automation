/**
 * helpers/smartComm/pdfValidationService.js
 * Extracts text from a generated PDF and evaluates it against an ordered
 * requirement list (see templateRequirementService) top to bottom. PASS/FAIL
 * is presence-based (case-insensitive match anywhere in the extracted text);
 * each requirement's document position is carried through for reporting, but
 * a requirement is never failed purely for appearing out of order — PDF text
 * extraction can reorder content (columns, tables) for reasons unrelated to
 * an actual document defect.
 */
'use strict';
const fs = require('fs');
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch (_) { /* reported lazily below */ }

const { UNANCHORED_PATTERNS, FAIL_IF_PAYLOAD_MISSING, LABEL_TO_TESTDATA_FIELD } = require('./fieldLabelSynonyms');
const fraudLanguageService = require('./fraudLanguageService');

// Two labels that map to the SAME testData/payload/recipient path (e.g. "D/L" and "DATE OF LOSS" both ->
// testData.lossDate) are synonyms for the same real-world field — reused here rather than a second,
// separately-maintained table, since fieldLabelSynonyms.js already encodes exactly this equivalence for
// dynamicValueMatch's OWN label-to-source lookup. `null`-valued (shape-only) labels are excluded: a shared
// "we don't know the real value" doesn't mean two labels mean the same thing.
function buildLabelSynonymGroups() {
  const byPath = new Map();
  for (const [label, path] of Object.entries(LABEL_TO_TESTDATA_FIELD)) {
    if (!path) continue;
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(label);
  }
  return byPath;
}
const LABEL_SYNONYM_GROUPS = buildLabelSynonymGroups();
// Exact labels only (e.g. a bare "D/L:" vs "Date of Loss:", per user direction 2026-09-30). Deliberately NOT
// widened to wording around a label: a briefly-tried 2026-10-13 change that matched "RE: Claim No.:" to the
// printed "RE: Our Claim No.:" hid a real, open defect — Jira SMART-1434 (DIG108's mapping-doc header vs the
// printed document) — and the team treats an added/removed "Our" as a defect (SMART-1245, DIG158).
function findLabelSynonyms(expectedValue) {
  const key = String(expectedValue || '').trim().toUpperCase().replace(/:$/, '');
  for (const labels of LABEL_SYNONYM_GROUPS.values()) {
    if (labels.includes(key)) return labels.filter((l) => l !== key);
  }
  return [];
}

async function extractPdfText(pdfPath) {
  if (!pdfParse) throw new Error('pdf-parse is not installed — run npm install in ClaimCenter-Automation');
  const buffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(buffer);
  // Page footers ("DIG 58Page 2 of 6") land in the middle of any paragraph that crosses a page break —
  // CONFIRMED live 2026-10-14: DIG58's Pennsylvania fraud notice was printed correctly but read as
  // "...for the purpose of misleading, DIG 58Page 2 of 6 information concerning..." and failed its exact match.
  // Moved to the end instead of dropped, so the body reads continuously and a form-number check still finds them.
  const FOOTER_RE = /^\s*(?:DIG\s*\d+[A-Z]*\s*)?Page\s+\d+\s+of\s+\d+\s*$/i;
  const lines = String(data.text || '').split('\n');
  const footers = lines.filter((l) => FOOTER_RE.test(l));
  return footers.length ? `${lines.filter((l) => !FOOTER_RE.test(l)).join('\n')}\n${footers.join('\n')}` : data.text;
}

function resolvePath(obj, dotted) {
  return String(dotted || '').split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

// Form checkboxes (a "YES / NO" pair) are commonly embedded as symbol-font
// glyphs mapped into Unicode's Private Use Area (0xE000-0xF8FF) — CONFIRMED
// live via char code 61608 sitting literally between "yes" and "no" in a
// generated PDF's extracted text, an all-but-invisible character neither
// side of a comparison was accounting for. Built from numeric char codes
// rather than typed as literal characters/escapes in this file, so the
// range stays visible and editable instead of embedding the same kind of
// invisible glyph it's meant to strip.
const PUA_GLYPH_RE = new RegExp('[' + String.fromCharCode(0xE000) + '-' + String.fromCharCode(0xF8FF) + ']', 'g');

// SmartCOMM/Word render "smart"/typographic punctuation (curly quotes, en/em
// dashes, ellipsis) even when the .doc source we extract requirements from
// has plain ASCII punctuation — CONFIRMED live: DIG15's source has a straight
// `"health plan"`, the rendered PDF has curly `“health plan”`,
// otherwise character-for-character identical. That's a typesetting
// substitution, not a content difference, so fold both sides to the same
// ASCII punctuation before comparing rather than letting it fall through to
// a "punctuation differs" FAIL.
const TYPOGRAPHIC_MAP = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[–—]/g, '-'],
  [/…/g, '...'],
  [/[   ]/g, ' '],
];
function normalizeTypography(s) {
  let out = String(s || '');
  for (const [re, replacement] of TYPOGRAPHIC_MAP) out = out.replace(re, replacement);
  return out;
}

// The reference Word doc lays fields out with tab stops that collapse to
// multiple spaces once extracted, while the generated PDF may line-wrap the
// same content differently (a run of spaces here, a newline there) — collapse
// all whitespace to single spaces on both sides before comparing, or a
// perfectly-correct document fails purely on spacing (CONFIRMED via live
// run). Also strips PUA checkbox glyphs and folds smart/typographic
// punctuation to ASCII first (see above) so their mere presence, or a
// different representation between source and rendered PDF, never fails an
// otherwise word-for-word identical sentence.
function normalizeWs(s) { return normalizeTypography(String(s || '').replace(PUA_GLYPH_RE, ' ')).replace(/\s+/g, ' ').trim(); }

// Whitespace-blind containment: every letter must match in order, only spacing may differ.
const compact = (s) => normalizeWs(s).replace(/\s+/g, '').toLowerCase();
function compactIncludes(haystack, needle) {
  const n = compact(needle);
  return n.length >= 8 && compact(haystack).includes(n);
}

// Other ways the same calendar date can print: "August 06, 2026" <-> "08/06/2026", "8/6/2026", "August 6, 2026".
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function dateVariants(value) {
  const s = String(value || '').trim();
  let y; let m; let d;
  let r = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (r) { m = MONTHS.findIndex((x) => x.toLowerCase().startsWith(r[1].toLowerCase().slice(0, 3))) + 1; d = +r[2]; y = r[3]; }
  r = r || s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (r && !m) { m = +r[1]; d = +r[2]; y = r[3]; }
  if (!m || !d || !y || m > 12 || d > 31) return [];
  const p = (n) => String(n).padStart(2, '0');
  return [...new Set([`${p(m)}/${p(d)}/${y}`, `${m}/${d}/${y}`, `${p(m)}-${p(d)}-${y}`, `${MONTHS[m - 1]} ${p(d)}, ${y}`, `${MONTHS[m - 1]} ${d}, ${y}`])].filter((v) => v !== s);
}

function shapeRegex(shape) {
  return UNANCHORED_PATTERNS[shape] || /\S+/;
}

// Reduces text to just its words (letters/digits), lowercased, single-space
// separated — every other character (periods, colons, commas, hyphens...)
// becomes a word boundary rather than vanishing, so punctuation differences
// disappear without accidentally fusing two separate words together. Also
// returns a position map so a match found in the reduced form can be traced
// back to the real substring (with its real punctuation) in `text`.
function reduceToWordsWithMap(text) {
  let reduced = '';
  const map = [];
  let atBoundary = true; // true until a word char is emitted, so leading punctuation adds no leading space
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/[a-zA-Z0-9]/.test(ch)) {
      reduced += ch.toLowerCase();
      map.push(i);
      atBoundary = false;
    } else if (!atBoundary) {
      reduced += ' ';
      map.push(i);
      atBoundary = true;
    }
  }
  return { reduced: reduced.trim(), map };
}

// When the exact expected text isn't in the haystack, checks whether the
// same WORDS are — just with different punctuation around/between them
// (CONFIRMED live: "Our Insured.:" in the template vs. "Our Insured:" in the
// actual generated document — SmartCOMM drops/changes punctuation some
// templates' Word source specifies). Returns the real, literally-rendered
// substring so a FAIL can show exactly what's there instead of "Not Found",
// or null if not even the words line up (genuinely missing, not just
// reworded). The returned span is extended through any punctuation
// immediately following the last matched word (up to the next whitespace) —
// reduceToWordsWithMap trims a needle's own trailing punctuation (e.g.
// "...relationship:" reduces to just "...relationship"), so without this a
// trailing colon/period genuinely present right after the match would
// otherwise be silently cut from the reconstructed "actual" text (CONFIRMED
// live — DIG126's form-question labels all really do end with a colon; the
// first version of this function was dropping it from the display only).
function findPunctuationRelaxedMatch(haystack, expectedValue) {
  const needle = reduceToWordsWithMap(String(expectedValue || '')).reduced;
  if (!needle) return null;
  const { reduced, map } = reduceToWordsWithMap(haystack);
  const idx = reduced.indexOf(needle);
  if (idx === -1) return null;
  const startIdx = map[idx];
  let endIdx = map[Math.min(idx + needle.length - 1, map.length - 1)] + 1;
  while (endIdx < haystack.length && /[^\sa-zA-Z0-9]/.test(haystack[endIdx])) endIdx++;
  return haystack.slice(startIdx, endIdx);
}

// The expected text's words, in order, with at most `maxExtra` extra words mixed in — e.g. the template's "RE:
// Claim No.:" printed as "RE:Our Claim No.:". Still a FAIL (an added/removed word is exactly what the team files
// as a defect — Jira SMART-1434, SMART-1245, SMART-1320), but shown as the printed wording instead of "Not
// Found", so the report says what actually differs. Returns the literal printed substring, or null.
function findNearWording(haystack, expectedValue, maxExtra = 2) {
  const want = reduceToWordsWithMap(String(expectedValue || '')).reduced.split(' ').filter(Boolean);
  if (want.length < 2) return null;
  // One CHANGED word too ("Our Policy No." printed as "Our Policy Number" — SMART-1320), only for phrases of 3+
  // words so a 2-word label can't "nearly match" an unrelated pair.
  const maxSubst = want.length >= 3 ? 1 : 0;
  const { reduced, map } = reduceToWordsWithMap(haystack);
  const words = [];
  let pos = 0;
  for (const w of reduced.split(' ')) { words.push({ w, start: pos, end: pos + w.length }); pos += w.length + 1; }
  for (let i = 0; i < words.length; i++) {
    if (words[i].w !== want[0]) continue;
    let j = i;
    let k = 1;
    let extra = 0;
    let subst = 0;
    while (k < want.length && j + 1 < words.length && extra <= maxExtra) {
      j++;
      if (words[j].w === want[k]) k++;
      else if (subst < maxSubst && (k === want.length - 1 || (words[j + 1] && words[j + 1].w === want[k + 1]))) { k++; subst++; }
      else extra++;
    }
    if (k === want.length && (extra > 0 || subst > 0) && extra <= maxExtra) {
      const startIdx = map[words[i].start];
      let endIdx = map[words[j].end - 1] + 1;
      while (endIdx < haystack.length && /[^\sa-zA-Z0-9]/.test(haystack[endIdx])) endIdx++;
      return haystack.slice(startIdx, endIdx);
    }
  }
  return null;
}

function evaluateOne(req, haystack, context) {
  if (req.enabled === false) {
    return { expected: 'N/A', actual: 'SKIPPED', result: 'SKIPPED', reason: req.disabledReason || 'Disabled' };
  }
  const normHaystack = normalizeWs(haystack).toLowerCase();
  switch (req.type) {
    case 'requiredText': {
      const found = normHaystack.includes(normalizeWs(req.expectedValue).toLowerCase());
      if (found) return { expected: req.expectedValue, actual: req.expectedValue, result: 'PASS' };
      // An explicitly-allowed alternative value (e.g. the UTC date for "current date" — see payloadXpathService),
      // passed with its own note so the difference stays visible in the report.
      const alt = (req.alsoAccept || []).find((a) => normHaystack.includes(normalizeWs(a).toLowerCase()));
      if (alt) return { expected: req.expectedValue, actual: alt, result: 'PASS', reason: req.alsoAcceptNote || `Accepted alternative value "${alt}".` };
      // Some PDFs' text layer splits words at certain glyphs (CONFIRMED 2026-10-14, DIG47B: "benef its",
      // "f ormer", "SALARY  YES") — the printed page reads correctly. Ignoring all whitespace is still an exact
      // letter-for-letter match, so it counts (spacing-only differences pass, per user direction).
      if (compactIncludes(haystack, req.expectedValue) && !/_{3,}/.test(req.expectedValue)) {
        return { expected: req.expectedValue, actual: req.expectedValue, result: 'PASS', reason: 'Same text; only spacing differs in the PDF text.' };
      }
      const fuzzy = findPunctuationRelaxedMatch(haystack, req.expectedValue);
      if (fuzzy) {
        // Per user direction 2026-10-14: spacing/punctuation-only differences pass — EXCEPT a missing fill-in
        // line. When the template has a blank to write on ("____"), the printed text must still have one right
        // where the wording ends (the relaxed match ignores underscores, so look at the text that follows it).
        if (/_{3,}/.test(req.expectedValue)) {
          const at = haystack.indexOf(fuzzy);
          const span = at >= 0 ? haystack.slice(at, at + fuzzy.length + 12) : '';
          if (!/_{3,}/.test(span)) {
            return {
              expected: req.expectedValue, actual: fuzzy, result: 'FAIL',
              reason: 'Same wording is printed, but the fill-in line ("____") the template has here is missing — the recipient has nowhere to write.',
            };
          }
        }
        // CONFIRMED live 2026-09-30 (user direction): the SAME words are genuinely present, just punctuated/
        // spaced differently than the reference — a template choosing its own punctuation for a value
        // (comma placement, line-wrap, etc.) is a legitimate rendering choice, not a defect. Reporting this
        // as PASS (rather than FAIL-with-explanation) avoids flagging every such business-level formatting
        // choice as a failure; `actual` still shows the real literal text so the difference stays visible.
        return {
          expected: req.expectedValue, actual: fuzzy, result: 'PASS',
          reason: `Same wording is present but punctuation/spacing differs from the template — treated as a match.`,
        };
      }
      // CONFIRMED live 2026-09-30 (user direction, "D/L" vs "Date of Loss"): the template's own reference
      // label and the rendered document can genuinely spell out the SAME field differently (an abbreviation
      // vs. the full name) — fieldLabelSynonyms.js already groups known equivalents by the real-world field
      // they both mean, so check each one before giving up, rather than treating a reworded-but-correct
      // label as missing content.
      for (const synonym of findLabelSynonyms(req.expectedValue)) {
        const synMatch = findPunctuationRelaxedMatch(haystack, synonym);
        if (synMatch) {
          return {
            expected: req.expectedValue, actual: synMatch, result: 'PASS',
            reason: `The template's own label "${req.expectedValue}" wasn't found verbatim, but its known synonym "${synonym}" was found as "${synMatch}" — same field, worded differently in the rendered document. Treated as a match.`,
          };
        }
      }
      // CONFIRMED live 2026-10-06 (user direction, DIG236): a field this SAME run's own interactive-field
      // check intentionally overwrote with a "[QA-EDIT-N]" marker (see validationService.buildXpathRequirements'
      // `wasEditedByTest` flag) usually still passes here because the real value repeats elsewhere in the
      // document (a letterhead, a signature block) — but for a template where this field's value genuinely
      // only ever appears in that ONE merge field (no such repeat), the test's own edit is what erased it, not
      // a real template defect. Nothing a human could act on, so SKIPPED rather than FAIL.
      if (req.wasEditedByTest) {
        return {
          expected: req.expectedValue, actual: 'Not Found', result: 'SKIPPED',
          reason: `Not found anywhere in the document — but this field was itself intentionally overwritten by this test's own editable-field check (see the Interactive Session section), and this template doesn't appear to repeat the value elsewhere. Not a template defect, just this test's own edit consuming the only occurrence.`,
        };
      }
      const near = findNearWording(haystack, req.expectedValue);
      if (near) {
        return {
          expected: req.expectedValue, actual: near, result: 'FAIL',
          reason: `The document prints similar but different wording: "${near.replace(/\s+/g, ' ').trim()}" instead of the template's "${req.expectedValue}" — word(s) added or changed.`,
        };
      }
      return {
        expected: req.expectedValue, actual: 'Not Found', result: 'FAIL',
        reason: `No similar wording found anywhere in the generated document — this content appears to be missing entirely, not just reworded.`,
      };
    }
    // "Dear <recipient>:" — the name itself is checked by its own To Name requirement; this asserts the
    // salutation is there and carries NO fixed honorific. Per user direction 2026-10-13: a hard-coded "Mrs."
    // (the Word mock-ups' sample "Dear Mrs. DONNA BRANDT") is a bug for a male or business recipient —
    // CONFIRMED live, DIG59's letters go to "ROBERT CHARLES" and "JOHNS AND SONS". An honorific that is part
    // of the recipient's own name in ClaimCenter is fine.
    case 'salutation': {
      const expected = 'Dear <recipient> (no fixed Mr./Mrs./Ms.)';
      const line = ((normalizeTypography(haystack).match(/^[ \t]*Dear\b.*$/im) || [])[0] || '').trim();
      if (!line) return { expected, actual: 'Not Found', result: 'FAIL', reason: 'No "Dear ..." salutation line found anywhere in the generated document.' };
      const m = line.match(/^Dear\s+(Mr|Mrs|Ms|Miss)\b\.?/i);
      if (!m) return { expected, actual: line, result: 'PASS' };
      const recipientName = String(resolvePath(context, 'recipient.name') || '').trim();
      if (new RegExp(`^${m[1]}\\b`, 'i').test(recipientName)) {
        return { expected, actual: line, result: 'PASS', reason: `The "${m[1]}." is part of the recipient's own name in ClaimCenter ("${recipientName}").` };
      }
      return {
        expected, actual: line, result: 'FAIL',
        reason: `The salutation prints a fixed "${m[1]}." that isn't part of the recipient's name${recipientName ? ` ("${recipientName}")` : ''} — wrong whenever the recipient is male or a business.`,
      };
    }
    // CONFIRMED live 2026-09-30 (user direction): for an Interactive template, the SAME dictionary field was
    // already captured individually during the editing session (see validationService.buildXpathRequirements)
    // — comparing against THAT field's own specific value is a precise field-to-field check, rather than
    // asking "does this value appear ANYWHERE in the whole document" the way 'requiredText' does. `fieldValue`
    // is attached directly on the requirement (no haystack/context lookup needed) since it was already
    // resolved when the requirement was built.
    case 'fieldValueMatch': {
      if (req.fieldValue === undefined) {
        return { expected: req.expectedValue, actual: 'N/A', result: 'BLOCKED', reason: 'No captured interactive field value to compare against for this requirement.' };
      }
      const normField = normalizeWs(req.fieldValue).toLowerCase();
      const normExpected = normalizeWs(req.expectedValue).toLowerCase();
      if (normField === normExpected || (normField && normExpected && (normField.includes(normExpected) || normExpected.includes(normField)))) {
        return { expected: req.expectedValue, actual: req.fieldValue, result: 'PASS' };
      }
      if ((req.alsoAccept || []).some((a) => normField && normField.includes(normalizeWs(a).toLowerCase()))) {
        return { expected: req.expectedValue, actual: req.fieldValue, result: 'PASS', reason: req.alsoAcceptNote || 'Accepted alternative value.' };
      }
      const fieldDate = dateVariants(req.expectedValue).find((d) => String(req.fieldValue || '').includes(d));
      if (fieldDate) return { expected: req.expectedValue, actual: req.fieldValue, result: 'PASS', reason: `Same date, printed in the template's format ("${fieldDate}").` };
      const fuzzy = findPunctuationRelaxedMatch(req.fieldValue, req.expectedValue) || findPunctuationRelaxedMatch(req.expectedValue, req.fieldValue);
      if (fuzzy) {
        return {
          expected: req.expectedValue, actual: req.fieldValue, result: 'PASS',
          reason: `Same wording is present but punctuation/spacing differs — treated as a match.`,
        };
      }
      return {
        expected: req.expectedValue, actual: req.fieldValue, result: 'FAIL',
        reason: `The interactive field "${req.fieldLabel || 'this field'}" is captured as "${req.fieldValue}", which doesn't match the payload-derived expected value above.`,
      };
    }
    // A state whose Fraud Language sheet row is literally "None" (e.g. MI, IL, CA...) — the document must NOT
    // print any of the sheet's fraud wordings. Matches only real sheet wording (findFraudLanguageInText), not
    // loose vocabulary like "penalty", so ordinary legal text elsewhere in a letter can't trip it. Wording that
    // the OTHER state on this claim legitimately requires (loss vs policy state differ) is excluded.
    case 'fraudLanguageAbsent': {
      const allowed = new Set((req.allowedFraudLanguage || []).map((t) => normalizeWs(t).toLowerCase()));
      const printed = fraudLanguageService.findFraudLanguageInText(haystack)
        .filter((r) => !allowed.has(normalizeWs(r.fraudLanguage).toLowerCase()));
      const expected = `No fraud language (Fraud Language sheet: ${req.stateLabel} → "None")`;
      if (!printed.length) return { expected, actual: 'No fraud language printed', result: 'PASS' };
      return {
        expected,
        actual: printed.map((r) => `${r.stateName} [${r.conditions || 'All'}]: ${r.fraudLanguage}`).join(' || '),
        result: 'FAIL',
        reason: `The Fraud Language sheet says ${req.stateLabel} requires no fraud language, but the document prints another state's/condition's fraud wording (see Actual).`,
      };
    }
    case 'forbiddenText': {
      const found = normHaystack.includes(normalizeWs(req.forbiddenValue).toLowerCase());
      return {
        expected: `Absence of "${req.forbiddenValue}"`, actual: found ? req.forbiddenValue : 'Not Found', result: found ? 'FAIL' : 'PASS',
        reason: found ? `This text must NOT appear, but it does — likely wrong-state or wrong-scenario content leaking into the document.` : undefined,
      };
    }
    case 'dynamicShape': {
      // An unclassified "text" shape has no real pattern to check —
      // /\S+/ would just match the document's first word regardless of
      // where this field actually is, a false PASS that verifies nothing.
      // Report it honestly as unverified rather than a misleading pass.
      if (req.shape === 'text') {
        return { expected: '<unspecified — no shape or test-data field known>', actual: 'N/A', result: 'BLOCKED', reason: 'No specific shape or test-data field mapped for this dynamic value — presence not verified' };
      }
      const m = haystack.match(shapeRegex(req.shape));
      return {
        expected: `<${req.shape}>`, actual: m ? m[0] : 'Not Found', result: m ? 'PASS' : 'FAIL',
        reason: m ? undefined : `No ${req.shape}-shaped value (e.g. ${req.shape === 'date' ? '"09/03/2026" or "September 3, 2026"' : req.shape === 'currency' ? '"$1,200.00"' : req.shape === 'email' ? '"name@domain.com"' : '"(800) 555-1234"'}) found anywhere in the generated document.`,
      };
    }
    case 'dynamicValueMatch': {
      const expected = resolvePath(context, req.expectedSource);
      if (expected === undefined || expected === null || expected === '') {
        const field = req.expectedSource.split('.').pop();
        // The payload downloaded/parsed fine (so this isn't an unverifiable
        // environmental condition) and this specific field is one we've
        // CONFIRMED live goes genuinely blank in the rendered letter itself
        // — a real document defect, not a test-data gap. See
        // FAIL_IF_PAYLOAD_MISSING in fieldLabelSynonyms.js for the evidence.
        if (context.payload && FAIL_IF_PAYLOAD_MISSING.has(req.expectedSource)) {
          return {
            expected: `(from ${req.expectedSource})`, actual: 'Not Found', result: 'FAIL',
            reason: `The SmartCOMM payload downloaded fine for this scenario, but has no "${field}" value this run — the generating user's own ClaimCenter profile doesn't currently have this field set, so the letter's signature block renders with "${field}" genuinely blank. CONFIRMED live: this is a real document defect (an incomplete signature block goes out to the recipient), not a test-data or environment limitation.`,
          };
        }
        const reason = req.expectedSource.startsWith('recipient.')
          ? `The selected recipient has no "${field}" value on this claim (not present on its Recipients-tab row) — presence not verified.`
          : req.expectedSource.startsWith('payload.')
          ? (context.payload
              ? `The SmartCOMM payload downloaded fine for this scenario, but has no "${field}" value this run — presence not verified.`
              : `The SmartCOMM payload couldn't be downloaded or parsed for this scenario, so "${field}" wasn't available — presence not verified.`)
          : `Neither the live claim data nor the Test Data claim inventory has a "${field}" value for this claim — presence not verified.`;
        return { expected: `(from ${req.expectedSource})`, actual: 'N/A', result: 'BLOCKED', reason };
      }
      const found = normHaystack.includes(normalizeWs(expected).toLowerCase());
      if (found) return { expected, actual: expected, result: 'PASS' };
      // The same date in the template's own format (DIG47B prints the loss date as 08/06/2026; the claim data
      // reads "August 06, 2026") — per user direction 2026-10-14 that's a match, not a missing value.
      const dateAlt = dateVariants(expected).find((d) => haystack.includes(d));
      if (dateAlt) return { expected, actual: dateAlt, result: 'PASS', reason: `Same date, printed in the template's format ("${dateAlt}").` };
      if (compactIncludes(haystack, expected)) return { expected, actual: expected, result: 'PASS', reason: 'Same text; only spacing differs in the PDF text.' };
      const fuzzy = findPunctuationRelaxedMatch(haystack, expected);
      if (fuzzy) {
        // See the same change in the 'requiredText' case above for the reasoning — a punctuation/spacing-only
        // difference is treated as a match now, not a failure.
        return {
          expected, actual: fuzzy, result: 'PASS',
          reason: `Same wording is present but punctuation/spacing differs from the test-data value — treated as a match.`,
        };
      }
      return {
        expected, actual: 'Not Found', result: 'FAIL',
        reason: req.expectedSource.startsWith('payload.')
          ? `"${expected}" is this sender's real value (confirmed elsewhere in the SmartCOMM payload, not guessed), but it does not appear anywhere in the generated document — likely a blank/missing merge field in the letter (e.g. a sentence with the value left out, like "please contact me at ."), not a wrong expected value.`
          : `The value from ${req.expectedSource} does not appear anywhere in the generated document — either it's genuinely missing, or the test-data value itself doesn't match what this claim actually contains.`,
      };
    }
    case 'regexMatch': {
      const m = haystack.match(new RegExp(req.pattern));
      return {
        expected: req.pattern, actual: m ? m[0] : 'Not Found', result: m ? 'PASS' : 'FAIL',
        reason: m ? undefined : `No text matching pattern /${req.pattern}/ found anywhere in the generated document.`,
      };
    }
    default:
      return { expected: 'N/A', actual: 'N/A', result: 'BLOCKED', reason: `Unknown requirement type "${req.type}"` };
  }
}

function evaluateRequirements(requirements, text, context) {
  const haystack = text || '';
  return requirements.map(req => ({
    id: req.id,
    description: req.description,
    docOrder: req.docOrder,
    ...evaluateOne(req, haystack, context),
  }));
}

module.exports = { extractPdfText, evaluateRequirements, normalizeWs };
