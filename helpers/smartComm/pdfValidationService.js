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
// Exact labels (e.g. a bare "D/L:" vs "Date of Loss:", per user direction 2026-09-30), optionally behind an
// "RE:" prefix, which is kept on every synonym. Per user direction 2026-10-16 (DIG239), "RE: Claim No.:"
// printed as "RE: Our Claim No.:" is a match for ALL templates — knowingly reversing the 2026-10-13 call that
// kept it a FAIL, so DIG108's SMART-1434 header difference no longer fails here either.
function findLabelSynonyms(expectedValue) {
  const m = String(expectedValue || '').trim().match(/^(RE\s*:\s*)?(.*?)\.?\s*:?$/i);
  const prefix = m[1] || '';
  const key = m[2].toUpperCase().replace(/\.$/, '');
  for (const labels of LABEL_SYNONYM_GROUPS.values()) {
    if (labels.includes(key)) return labels.filter((l) => l !== key).map((l) => `${prefix}${l}`);
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

// Words with punctuation inside a word removed ("WORKER'S" -> "workers", "V.I.N." -> "vin"), for punctuation-blind
// whole-word matching.
const words = (s) => normalizeTypography(String(s || '')).toLowerCase().replace(/['’.]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
// True when expected's words appear consecutively, as whole words, in the text — optionally with ONE gap of up
// to maxGap words (a merge-field value printed inside a sentence the mapping doc splits around the field).
function wordsInOrder(text, expected, maxGap = 0) {
  const t = words(text); const e = words(expected);
  if (!e.length) return false;
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== e[0]) continue;
    let ti = i + 1; let gapUsed = maxGap === 0; let ok = true;
    for (let k = 1; k < e.length; k++) {
      if (t[ti] === e[k]) { ti++; continue; }
      if (gapUsed) { ok = false; break; }
      const j = t.slice(ti, ti + maxGap + 1).indexOf(e[k]);
      if (j < 0) { ok = false; break; }
      ti += j + 1; gapUsed = true;
    }
    if (ok) return true;
  }
  return false;
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

// The expected text's words, in order, with at most `maxExtra` extra words mixed in — e.g. the template's "Our
// Policy No." printed as "Our Policy Number". Still a FAIL (an added/removed word is what the team files as a
// defect — Jira SMART-1245, SMART-1320; "Claim No."/"Our Claim No." is the exception, matched as a synonym
// above), but shown as the printed wording instead of "Not
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

// "Date of Loss Day/Month/Year" rows share the full loss date's Xpath in the Data Dictionary, but the letter prints
// just that part ("THE 5 DAY OF February, 2024" — DIG27/DIG28, user direction 2026-10-17), so compare the part
// only. Returns { value, accept[], note } or null for any other row / a value that isn't a date.
function dateLossPart(attributeName, value) {
  const which = (String(attributeName || '').match(/\b(day|month|year)\s*$/i) || [])[1];
  if (!which) return null;
  const s = String(value || '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = iso ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const note = `"${attributeName}" is one part of the loss date (${s}).`;
  if (/day/i.test(which)) { const day = d.getDate(); return { value: String(day), accept: [String(day), String(day).padStart(2, '0')], note }; }
  if (/month/i.test(which)) { const m = d.toLocaleString('en-US', { month: 'long' }); return { value: m, accept: [m, d.toLocaleString('en-US', { month: 'short' })], note }; }
  return { value: String(d.getFullYear()), accept: [String(d.getFullYear())], note };
}

// Every contact with the claimant role in the SmartCOMM payload (context.raw), by display name.
function claimantsOf(context) {
  const claim = context && context.raw && context.raw.claim;
  if (!claim) return [];
  const contacts = [].concat(claim.contacts || []).flatMap((x) => (x && x.contacts ? [].concat(x.contacts) : [x])).filter(Boolean);
  const roleCodes = (k) => [].concat(k.roles || []).flatMap((r) => (r && r.roles ? [].concat(r.roles) : [r])).map((r) => r && r.role && r.role.code);
  return [...new Set(contacts.filter((k) => roleCodes(k).includes('claimant')).map((k) => k.displayName).filter(Boolean))];
}

// Printed text that matches the expected wording but for ONE word (an extra or missing word, or one spelled within two
// letters of it). Returns the printed text, or null. Only for 2-12 word phrases, so a short label can't match noise.
function closeWording(haystack, expected) {
  const tok = (s) => String(s || '').replace(/[’']s\b/gi, ' ').toLowerCase().match(/[a-z0-9]+/g) || [];
  const want = tok(expected);
  if (want.length < 2 || want.length > 12) return null;
  const lines = String(haystack || '').split(/\n/);
  const near = (a, b) => {
    if (a === b) return true;
    if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 2) return false;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length] <= 2;
  };
  for (const line of lines) {
    const got = tok(line);
    for (let n = want.length - 1; n <= want.length + 1; n++) {
      for (let st = 0; st + n <= got.length; st++) {
        const win = got.slice(st, st + n);
        // Same words in order, allowing exactly one difference (insert, delete or near-spelling substitution).
        let i = 0; let j = 0; let diffs = 0;
        while (i < want.length && j < win.length && diffs <= 1) {
          if (want[i] === win[j]) { i++; j++; } else if (near(want[i], win[j])) { diffs++; i++; j++; } else if (want.length - i > win.length - j) { diffs++; i++; } else { diffs++; j++; }
        }
        diffs += (want.length - i) + (win.length - j);
        if (diffs === 1) return line.trim();
      }
    }
  }
  return null;
}

// A payload value whose only printed occurrence the interactive-edit test overwrote: judged on what the field showed
// BEFORE the edit (req.editedBefore, from the editor) — it must have been the real value (per user direction
// 2026-10-17: correct before the edit, and the edit itself is verified in the PDF separately). No recorded "before"
// → SKIPPED, as it used to be.
function editedBeforeResult(req, matches) {
  const before = (req.editedBefore || []).filter(Boolean);
  if (!before.length) {
    return { expected: req.expectedValue, actual: 'Not Found', result: 'SKIPPED', reason: 'Not found in the document — this field was overwritten by the test\'s own editable-field check, and its value before the edit wasn\'t recorded.' };
  }
  const ok = before.some((b) => matches(String(b)));
  return ok
    ? { expected: req.expectedValue, actual: `Before edit: "${before.join(' ')}"`, result: 'PASS', reason: 'The field showed this value before the interactive-edit test overwrote it (the edit is verified in the PDF separately) — correct before and after the edit.' }
    : { expected: req.expectedValue, actual: `Before edit: "${before.join(' ')}"`, result: 'FAIL', reason: `Before the interactive-edit test overwrote it, the field showed "${before.join(' ')}" instead of "${req.expectedValue}"${before.some((b) => /editable|<</i.test(b)) ? ' — an empty editable placeholder, i.e. no default value' : ''}.` };
}

function evaluateOne(req, haystack, context) {
  if (req.enabled === false) {
    return { expected: 'N/A', actual: 'SKIPPED', result: 'SKIPPED', reason: req.disabledReason || 'Disabled' };
  }
  const normHaystack = normalizeWs(haystack).toLowerCase();
  switch (req.type) {
    case 'requiredText': {
      // A short value (a date's day/month/year — see validationService.dateLossPart) only counts as a whole word:
      // "5" anywhere in a letter means nothing. `wordValues` lists every accepted spelling ("5", "05").
      if (req.wordValues) {
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hit = req.wordValues.find((w) => new RegExp(`(^|[^A-Za-z0-9])${esc(w)}(?![A-Za-z0-9])`, 'i').test(haystack));
        if (hit) return { expected: req.expectedValue, actual: hit, result: 'PASS', reason: req.wordNote };
        if (req.wasEditedByTest) return editedBeforeResult(req, (b) => req.wordValues.some((w) => new RegExp(`(^|[^A-Za-z0-9])${esc(w)}(?![A-Za-z0-9])`, 'i').test(b)));
        return { expected: req.expectedValue, actual: 'Not Found', result: 'FAIL', reason: `"${req.expectedValue}" doesn't appear as a separate word anywhere in the generated document. ${req.wordNote || ''}`.trim() };
      }
      const found = normHaystack.includes(normalizeWs(req.expectedValue).toLowerCase());
      if (found) return { expected: req.expectedValue, actual: req.expectedValue, result: 'PASS' };
      // The same date in the template's own format — the payload says "August 06, 2026", a form prints 08/06/2026
      // (DIG47, 2026-10-17); dynamicValueMatch already allowed this, payload checks didn't.
      const dateHit = dateVariants(req.expectedValue).find((d) => haystack.includes(d));
      if (dateHit) return { expected: req.expectedValue, actual: dateHit, result: 'PASS', reason: `Same date, printed in the template's format ("${dateHit}").` };
      // An explicitly-allowed alternative value (e.g. the UTC date for "current date" — see payloadXpathService),
      // passed with its own note so the difference stays visible in the report — in any date format, too.
      const alt = (req.alsoAccept || []).flatMap((a) => [a, ...dateVariants(a)]).find((a) => normHaystack.includes(normalizeWs(a).toLowerCase()));
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
          // Check EVERY place this wording prints (DIG49: "DESCRIBE" also opens "5. DESCRIBE AUTOMOBILES…", and the
          // first hit has no line), and accept an editable field in the blank — the line IS the field there, so
          // this run's own "[QA-EDIT-n]" (or the field's value marker "[") sits where the underscores were.
          let hasBlank = false;
          for (let at = haystack.indexOf(fuzzy); at >= 0 && !hasBlank; at = haystack.indexOf(fuzzy, at + 1)) {
            // ...or any value this run typed into an edited field there (an "X" in DIG120A's SSN blank, 2026-10-17).
            const after = haystack.slice(at, at + fuzzy.length + 14);
            const typedHere = ((context && context.interactiveChecks) || []).some((c) => c.observedChanged === true && c.committedMarker
              && new RegExp(`(^|[^A-Za-z0-9])${String(c.committedMarker).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`).test(after.slice(fuzzy.length)));
            if (/_{3,}|\[|QA-EDIT-\d/.test(after) || typedHere) hasBlank = true;
          }
          if (!hasBlank) {
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
      // The accepted alternatives (e.g. the letter's UTC date, one day off — DIG129 2026-10-17) count too.
      if (req.wasEditedByTest) return editedBeforeResult(req, (b) => [req.expectedValue, ...(req.alsoAccept || [])].some((x) => normalizeWs(b).toLowerCase().includes(normalizeWs(x).toLowerCase()) || dateVariants(x).some((d) => b.includes(d))));
      // Fallbacks for text that IS printed but the plain text can't show as one phrase (CONFIRMED 2026-10-15, DIG49
      // Application for Benefits — a boxed form):
      const layout = context && context.layoutText ? context.layoutText : '';
      const expectedNoBlank = req.expectedValue.replace(/_{3,}/g, ' ').trim();
      // 1. Boxed / multi-column layout: side-by-side boxes run together and wrapped questions get split.
      if (layout && !/_{3,}/.test(req.expectedValue) && (normalizeWs(layout).toLowerCase().includes(normalizeWs(req.expectedValue).toLowerCase()) || compactIncludes(layout, req.expectedValue))) {
        return { expected: req.expectedValue, actual: req.expectedValue, result: 'PASS', reason: 'Printed in a boxed / column layout — the plain PDF text reads across the boxes, the layout reading finds it intact.' };
      }
      // 2. Punctuation inside words only ("WORKER'S" vs "WORKERS", "V.I.N." vs "VIN") — passes per user direction.
      if (!/_{3,}/.test(req.expectedValue) && (wordsInOrder(haystack, req.expectedValue) || (layout && wordsInOrder(layout, req.expectedValue)))) {
        return { expected: req.expectedValue, actual: req.expectedValue, result: 'PASS', reason: 'Same words; only punctuation differs (e.g. an apostrophe or full stops).' };
      }
      // 3. A list number from the next item glued onto the last word by the mapping-doc parse ("…COMPLETE AND3.").
      const glued = expectedNoBlank.match(/^(.*[A-Za-z])\d{1,2}\.$/);
      if (glued && (normHaystack.includes(normalizeWs(glued[1]).toLowerCase()) || (layout && wordsInOrder(layout, glued[1])))) {
        return { expected: req.expectedValue, actual: glued[1], result: 'PASS', reason: `The mapping doc's text has the next list number glued on ("${req.expectedValue.slice(glued[1].length)}"); the wording itself is printed.` };
      }
      // 4. A fragment the mapping doc split around a merge field (starts with ":" / ","): the field's value prints
      //    inside it ("Name of Injured Person: [value] (herein after …)").
      if (/^\s*[:;,]/.test(req.expectedValue) && (wordsInOrder(haystack, req.expectedValue, 8) || (layout && wordsInOrder(layout, req.expectedValue, 8)))) {
        return { expected: req.expectedValue, actual: req.expectedValue, result: 'PASS', reason: 'Printed with a merge-field value inside it (the mapping doc splits this sentence around the field).' };
      }
      const near = findNearWording(haystack, req.expectedValue);
      if (near) {
        return {
          expected: req.expectedValue, actual: near, result: 'FAIL',
          reason: `The document prints similar but different wording: "${near.replace(/\s+/g, ' ').trim()}" instead of the template's "${req.expectedValue}" — word(s) added or changed.`,
        };
      }
      // One word off — added, dropped or misspelled ("PATIENT’S NAME (FIRST)" printed "PATIENT NAME (FIRST)", the mapping
      // doc's typo "(MIDDLE INTIAL)" vs printed "(MIDDLE INITIAL)" — DIG219, 2026-10-17): still a FAIL, but say what printed.
      const close = closeWording(haystack, req.expectedValue);
      if (close) {
        return { expected: req.expectedValue, actual: close, result: 'FAIL', reason: `The document prints "${close}" instead of the template's "${req.expectedValue}" — one word differs (added, dropped or spelled differently).` };
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
      // "Date of Loss Day/Month/Year" (DIG27–32): only that part of the loss date prints ("THE 5 DAY OF February,
      // 2024"), so compare the part, as a whole word.
      const part = dateLossPart(req.fieldName, expected);
      if (part) return evaluateOne({ ...req, type: 'requiredText', expectedValue: part.value, wordValues: part.accept, wordNote: part.note }, haystack, context);
      const found = normHaystack.includes(normalizeWs(expected).toLowerCase());
      if (found) return { expected, actual: expected, result: 'PASS' };
      // A claim with several claimants: the letter prints the claimant of the exposure it's about ("Jimmy Claimant"),
      // the claim data's first claimant is another one ("Gary Moore") — DIG30, 2026-10-17. Any claimant on the claim counts.
      if (req.expectedSource === 'testData.claimantName') {
        const other = claimantsOf(context).find((n) => n.toLowerCase() !== String(expected).toLowerCase() && normHaystack.includes(normalizeWs(n).toLowerCase()));
        if (other) return { expected, actual: other, result: 'PASS', reason: `The claim has more than one claimant; the letter prints "${other}" (another claimant on this claim — likely the one on the exposure the letter is about).` };
      }
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
    // DIG26's exposure financials table (see templateRequirementService's exposure-table rule): every exposure in the
    // payload must print its type and amounts; the Total row the claim's sums. Amounts as money ("1193.00" → "$1,193"
    // or "$1,193.00"), never as part of a longer number.
    // Each column's exposure amounts must add up to its Total. The rows are the payload's per-exposure amounts (proven
    // printed by exposureTable) and the Total the claim's sums (proven printed by exposureTotals), so comparing the two
    // sums finds a Total that doesn't add up — DIG26: reserves $0 + $1,200 + $0 printed with a Total of $1,193.
    case 'exposureColumnTotals': {
      const raw = context && context.raw;
      if (!raw || !raw.claim) return { expected: '(from the payload)', actual: 'N/A', result: 'BLOCKED', reason: 'The SmartCOMM payload wasn\'t available for this scenario, so the column totals couldn\'t be checked.' };
      const amount = (a) => { const n = Number(a && a.amount !== undefined ? a.amount : a); return Number.isFinite(n) ? n : null; };
      const fmt = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const exposures = [].concat(raw.claim.exposures || []).flatMap((x) => (x && x.exposures ? [].concat(x.exposures) : [x])).filter(Boolean);
      const COLS = [['Reserves', 'openReserves_Ext', 'sumReserves_Ext'], ['Paid', 'totalPaid_Ext', 'sumPaid_Ext'], ['Expenses', 'totalExpenses_Ext', 'sumExpenses_Ext'], ['Recoveries', 'totalRecoveries_Ext', 'sumRecoveries_Ext'], ['Net Incurred', 'totalIncurred_Ext', 'sumIncurred_Ext']];
      const lines = []; const bad = [];
      for (const [label, field, sumField] of COLS) {
        // A missing amount prints as $0 (DIG26's third exposure has no reserve amount and shows "$0").
        const parts = exposures.map((e) => amount(e[field]) ?? 0);
        const total = amount(raw.claim[sumField]);
        if (!parts.length || total === null) continue;
        const added = Math.round(parts.reduce((t, v) => t + v, 0) * 100) / 100;
        const line = `${label}: ${parts.map(fmt).join(' + ')} = ${fmt(added)}, Total printed ${fmt(total)}`;
        lines.push(line);
        if (Math.abs(added - total) > 0.005) bad.push(`${label} rows add up to ${fmt(added)} but the Total shows ${fmt(total)} (off by ${fmt(Math.abs(added - total))})`);
      }
      if (!lines.length) return { expected: 'Column totals', actual: 'N/A', result: 'SKIPPED', reason: 'No exposure amounts / claim totals in the payload to add up.' };
      return bad.length
        ? { expected: 'Each column\'s rows add up to its Total', actual: lines.join(' | '), result: 'FAIL', reason: `${bad.join('; ')}.` }
        : { expected: 'Each column\'s rows add up to its Total', actual: lines.join(' | '), result: 'PASS' };
    }
    case 'exposureTable':
    case 'exposureTotals': {
      const raw = context && context.raw;
      if (!raw || !raw.claim) return { expected: '(from the payload)', actual: 'N/A', result: 'BLOCKED', reason: 'The SmartCOMM payload wasn\'t available for this scenario, so the exposure amounts couldn\'t be checked.' };
      const money = (amt) => {
        const n = Math.abs(Number(amt && amt.amount !== undefined ? amt.amount : amt));
        if (!Number.isFinite(n)) return null;
        const whole = n.toLocaleString('en-US', { maximumFractionDigits: 2 });
        // With or without thousands separators — DIG26 prints "$1200.00" / "Total$1193.00" (live 2026-10-17).
        const forms = [...new Set([whole, n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), String(Math.round(n * 100) / 100), n.toFixed(2)])]
          .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        return { label: `$${whole}`, re: new RegExp(forms.map((f) => `\\$\\s?${f}${/\./.test(f) ? '' : '(?:\\.0{1,2})?'}(?![\\d,])`).join('|')) };
      };
      const COLS = [['reserves', 'openReserves_Ext', 'sumReserves_Ext'], ['paid', 'totalPaid_Ext', 'sumPaid_Ext'], ['expenses', 'totalExpenses_Ext', 'sumExpenses_Ext'], ['recoveries', 'totalRecoveries_Ext', 'sumRecoveries_Ext'], ['net incurred', 'totalIncurred_Ext', 'sumIncurred_Ext']];
      const missing = []; const shown = [];
      if (req.type === 'exposureTotals') {
        for (const [label, , sumField] of COLS) {
          const m = money(raw.claim[sumField]);
          if (!m) continue;
          shown.push(`${label} ${m.label}`);
          if (!m.re.test(haystack)) missing.push(`total ${label} ${m.label}`);
        }
      } else {
        const exposures = [].concat(raw.claim.exposures || []).flatMap((x) => (x && x.exposures ? [].concat(x.exposures) : [x])).filter(Boolean);
        if (!exposures.length) return { expected: 'One row per exposure', actual: 'No exposures in the payload', result: 'SKIPPED', reason: 'The claim has no exposures in the SmartCOMM payload, so there are no rows to check.' };
        // The type cell is an editable field the interactive check overwrites (QA-EDIT-n, live DIG26), so a missing type
        // isn't counted when this run's edits are in the document. Types also stay out of `expected`, which the
        // "overwritten by the test" annotation compares against — otherwise a real amount problem would be SKIPPED too.
        // A type cell the test overwrote is judged on what it showed BEFORE the edit (the editor's own value, per user
        // direction 2026-10-17): the payload's type must have been there.
        const editedBefores = ((context && context.interactiveChecks) || []).filter((c) => c.observedChanged === true && c.before).map((c) => normalizeWs(c.before).toLowerCase());
        const typeEditedByTest = /QA-EDIT-\d/.test(haystack);
        exposures.forEach((e, k) => {
          const type = e.type && (e.type.name || e.type);
          const row = [];
          const tn = type ? normalizeWs(String(type)).toLowerCase() : '';
          if (type && !normHaystack.includes(tn)) {
            if (!typeEditedByTest) missing.push(`exposure ${k + 1} type "${type}"`);
            else if (editedBefores.length && !editedBefores.some((b) => b.includes(tn))) missing.push(`exposure ${k + 1} type "${type}" (not in the edited type cells before the edit either: ${[...new Set(editedBefores)].slice(0, 4).map((b) => `"${b}"`).join(', ')})`);
          }
          for (const [label, field] of COLS) {
            const m = money(e[field]);
            if (!m) continue;
            row.push(`${label} ${m.label}`);
            if (!m.re.test(haystack)) missing.push(`exposure ${k + 1} ${label} ${m.label}`);
          }
          shown.push(`${k + 1}. ${row.join(', ')}`);
        });
      }
      const expected = shown.join(' | ') || '(no amounts in the payload)';
      return missing.length
        ? { expected, actual: 'Not Found', result: 'FAIL', reason: `Missing from the generated document: ${missing.join('; ')}.` }
        : { expected, actual: expected, result: 'PASS' };
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

module.exports = { extractPdfText, evaluateRequirements, normalizeWs, dateLossPart, claimantsOf };
