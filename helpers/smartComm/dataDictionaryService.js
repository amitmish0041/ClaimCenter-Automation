/**
 * helpers/smartComm/dataDictionaryService.js
 * Reads Claims_Attributes_Data_Dictionary.xlsb ("Claims Attribute" sheet) — the BA-maintained list of every
 * SmartCOMM merge-field attribute, which template(s) it appears on, and whether it is editable in an
 * Interactive session ("Editable in SmartCOMM?", column G). Used to drive the interactive-editing validator
 * (helpers/smartComm/interactiveEditService.js): for a given template, which fields should accept an edit
 * and which should stay locked.
 *
 * CONFIRMED live 2026-09-28: 19 of the sheet's rows apply to DIG52 via "Form(s)" = "ALL" (no row named DIG52
 * specifically) — e.g. Claimant Name/Address, Policy Number, Underwriting Company, Policy Base State and
 * "Apply Medical Letterhead?" are Yes (editable); To/From/Date of Loss/Claim Number/Date of Letter are No.
 * "CC" and "Agency Writing Code" have a BLANK editable column — reported as unspecified, not guessed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { normalizeDig } = require('./catalogService');

const DEFAULT_DIR = 'C:\\Users\\amitmish\\Desktop\\CC Cloud\\SmartComm\\Requirement';

function findFile() {
  const dir = process.env.CC_UI_SPEC_DIR || DEFAULT_DIR;
  if (!fs.existsSync(dir)) throw new Error(`dataDictionaryService: directory not found: ${dir}`);
  const hit = fs.readdirSync(dir).find((n) => /^Claims_Attributes_Data_Dictionary.*\.xlsb$/i.test(n) && !n.startsWith('~$'));
  if (!hit) throw new Error(`dataDictionaryService: no "Claims_Attributes_Data_Dictionary*.xlsb" found in ${dir}`);
  return path.join(dir, hit);
}

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

// "Yes" -> true, "No" -> false, blank -> null (unspecified, not guessed).
function editableFlag(v) {
  const t = clean(v).toLowerCase();
  if (t === 'yes') return true;
  if (t === 'no') return false;
  return null;
}

// "ALL" (any case) -> applies to every template. Otherwise split on comma AND embedded newlines
// (CONFIRMED: some Form(s) cells use "DIG218\nDIG201\nDIG2118" instead of commas) and normalize each DIG.
// MUST split on the RAW value before calling clean() on the whole string — clean() collapses ALL whitespace
// (including the very newlines this split needs) into single spaces, so a newline-separated cell survived as
// one merged garbage token ("DIG218DIG201DIG2118") that matched no real DIG, silently dropping that row from
// 3 templates' applicability scope (CONFIRMED live 2026-10-05, found auditing DIG236: "WC Detailed Injury",
// "WC Detailed Body Part", "Injury County" all affected). clean() still runs per-token, after the split.
function parseForms(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || /^all$/i.test(clean(s))) return { all: true, digs: [] };
  const digs = s.split(/[,\n]/).map((x) => normalizeDig(clean(x))).filter(Boolean);
  return { all: false, digs };
}

let cache = null;
function loadAttributes({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  const file = findFile();
  const wb = XLSX.readFile(file);
  const sheetName = wb.SheetNames.find((n) => /^claims attribute$/i.test(n)) || 'Claims Attribute';
  if (!wb.Sheets[sheetName]) throw new Error(`dataDictionaryService: "${file}" has no "Claims Attribute" tab`);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
  const header = rows[0].map(clean);
  const col = (name) => header.indexOf(name);
  // CONFIRMED live 2026-10-07 (direct read of the raw .xlsb): this sheet's column D header cell literally
  // contains the single character "y", not "Attribute Data Type" — a source-file authoring artifact (its own
  // DATA rows underneath are fine, e.g. D2/D3 = "Text") — so name-based lookup for this one column always
  // failed and `dataType` has been silently blank on every row ever since this field was added. Column D's
  // position is otherwise stable (immediately after "Template Attribute Name", before "Form(s)"), so fall
  // back to it positionally only when the expected header text truly isn't present.
  const dataTypeCol = col('Attribute Data Type') >= 0 ? col('Attribute Data Type') : 3;
  const idx = {
    attributeName: col('Attribute Name'), templateAttributeName: col('Template Attribute Name'),
    dataType: dataTypeCol, forms: col('Form(s)'), sampleValue: col('Target Sample Values'),
    editable: col('Editable in SmartCOMM?'), comments: col('Comments'), ccField: col('ClaimCenter Field Display'),
    xpath: col('Xpath'), status: col('Status'),
  };
  if (idx.attributeName < 0 || idx.forms < 0 || idx.editable < 0) {
    throw new Error(`dataDictionaryService: "${file}" is missing an expected column (Attribute Name / Form(s) / Editable in SmartCOMM?)`);
  }
  cache = { file, rows: rows.slice(1).filter((r) => clean(r[idx.attributeName])).map((r) => ({
    attributeName: clean(r[idx.attributeName]),
    templateAttributeName: clean(r[idx.templateAttributeName]),
    dataType: clean(r[idx.dataType]),
    forms: parseForms(r[idx.forms]),
    sampleValue: r[idx.sampleValue],
    editable: editableFlag(r[idx.editable]),
    comments: clean(r[idx.comments]),
    ccFieldDisplay: clean(r[idx.ccField]),
    xpath: clean(r[idx.xpath]),
    status: clean(r[idx.status]),
  })) };
  return cache;
}

// Every data-dictionary row that applies to `digNumber` (its own row, or an "ALL" row) — i.e. Column E
// ("Form(s)") filtering down to just this template.
function getAttributesForTemplate(digNumber) {
  const dig = normalizeDig(digNumber);
  return loadAttributes().rows.filter((r) => r.forms.all || r.forms.digs.includes(dig));
}

// EXACT-name match against the FULL, unscoped dictionary (every row, regardless of its own Form(s) column) —
// deliberately the only tier allowed to cross the Form(s) scoping boundary, and only for true equality, never
// contains/word-overlap. CONFIRMED live 2026-10-05 (user direction, following the "TO ADDRESS" fix): a wide
// static scan found 128 cases across 22 attributes — "Copy Name", "Copy Address", "Loss Location", "Claimant
// Date of Birth", etc. — where a template's own BA comment names a dictionary row EXACTLY, but that row's own
// Form(s) column simply hasn't been updated to list this DIG (confirmed directly: the row exists, is already
// scoped to dozens of OTHER templates, just not this one). An exact name agreement carries little ambiguity
// risk on its own — unlike the fuzzy tiers (contains/wordOverlap), which stay strictly scoped on purpose,
// since relaxing those too would risk matching a same-ish-named-but-different-context row across templates.
function findExactMatchAnyScope(name, cols) {
  const needle = normalizeForMatch(name);
  if (!needle) return null;
  const { rows } = loadAttributes();
  for (const col of cols) {
    const hit = rows.find((r) => r[col] && normalizeForMatch(r[col]) === needle);
    if (hit) return { row: hit, matchedOn: col + 'ExactUnscoped' };
  }
  return null;
}

// Exact-name attribute lookup (used by the known-value matcher — validationService.js's assignByKnownValue,
// which already knows precisely which business field it means, e.g. "Copy Name") — scoped to this DIG first,
// falling back to the same unscoped-exact rule as findExactMatchAnyScope above when the dictionary's own
// Form(s) column hasn't caught up yet. Returns `scoped: false` so the caller can flag it distinctly.
function getAttributeByExactName(digNumber, attributeName) {
  const needle = normalizeForMatch(attributeName);
  const scopedHit = getAttributesForTemplate(digNumber).find((r) => normalizeForMatch(r.attributeName) === needle);
  if (scopedHit) return { row: scopedHit, scoped: true };
  const unscoped = findExactMatchAnyScope(attributeName, ['attributeName']);
  return unscoped ? { row: unscoped.row, scoped: false } : null;
}

// How many of THIS template's applicable rows actually have an opinion (Yes/No, not blank) on
// editability — i.e. how many merge fields the dictionary itself expects the interactive editor to surface
// for this DIG. Used as a sanity check when the editor reports 0 fields: dictionary-expects-0-too means a
// clean document with nothing to edit; dictionary-expects-some-but-editor-found-0 means something's off
// (detection bug, or the document genuinely didn't render its usual fields this run).
function countApplicableTrackedFields(digNumber) {
  return getAttributesForTemplate(digNumber).filter((r) => r.editable !== null).length;
}

// Reduces to lowercase alphanumeric words, single-space separated — same idea as
// pdfValidationService.reduceToWordsWithMap: punctuation/casing differences ("Claim #:" vs "Claim Number")
// shouldn't block a match, but fusing two real words together would produce a false one.
function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// CONFIRMED live 2026-10-05 (DIG53): the on-page label "Our Claim No.:" never matched dictionary row "Claim
// Number" (nor "Our Policy No.:" against "Policy Number") purely because "No." is a real abbreviation of
// "Number" that normalizeForMatch's own punctuation-stripping can't bridge — it only removes punctuation, it
// doesn't know the two words mean the same thing. Scoped to a trailing "no" specifically (the only confirmed
// case) rather than a general abbreviation dictionary, to avoid guessing at others that haven't been seen.
function normalizeForLabelMatch(s) {
  return normalizeForMatch(s).replace(/\bno$/, 'number');
}

// Picks, from `candidates`, the row whose `field` column's text corresponds to the on-page `label` text —
// longest candidate text first, so a specific match ("Injured Person Name") wins over a shorter one that
// happens to also qualify ("Name"). A max length guards against `field` values that are really prose, not a
// label (see below) — a short on-page label snippet can never legitimately contain a multi-sentence business
// rule verbatim, so there's no point even trying that comparison.
// Checked both directions — CONFIRMED live 2026-10-05 (DIG53) the on-page label is often the SHORTER, more
// abbreviated one ("Claimant:" for dictionary row "Claimant Name"), which only the label-endsWith/includes
// checks below.
function bestLabelMatch(candidates, field, label, maxFieldLen) {
  const normLabel = normalizeForLabelMatch(label);
  const usable = candidates.filter((r) => r[field] && normalizeForMatch(r[field]).length >= 3 && r[field].length <= maxFieldLen);
  // Pass 1: the label contains the candidate ("Date of Loss:" contains "Date of Loss") — longest candidate
  // first, so a specific match ("Injured Person Name") wins over a shorter one that happens to also qualify
  // ("Name").
  const forward = usable
    .slice()
    .sort((a, b) => b[field].length - a[field].length)
    .find((r) => {
      const cand = normalizeForLabelMatch(r[field]);
      return normLabel.endsWith(cand) || normLabel.includes(cand);
    });
  if (forward) return forward;
  // Pass 2: the candidate contains the label ("Claimant Name" contains "Claimant:") — the on-page label is
  // often the shorter, more abbreviated one (CONFIRMED live 2026-10-05, DIG53). Shortest candidate first here
  // instead, so the most specific superset wins — sorting longest-first (pass 1's order) would otherwise let
  // an unrelated LONGER row that merely happens to also contain the label ("Claimant Address" also starts
  // with "Claimant") win over the actual match ("Claimant Name").
  if (normLabel.length < 3) return undefined;
  return usable
    .slice()
    .sort((a, b) => a[field].length - b[field].length)
    .find((r) => normalizeForLabelMatch(r[field]).includes(normLabel));
}

// Identifies which dictionary row (if any) a DOM merge field really corresponds to, tried in order of
// confidence:
//   1. The editor's own technical field name (aria-label) against Column B ("Template Attribute Name").
//   2. The document's own on-page label text immediately before the field against Column I ("ClaimCenter
//      Field Display") — what a ClaimCenter user actually sees the field called, so in principle the best
//      match target for a document-rendered label. In practice CONFIRMED live (DIG15) this column is only
//      sometimes a real short label ("Date of Loss", "Claim Number") — for many rows it's a multi-sentence
//      mapping/business rule instead (e.g. Claimant Name's is 318 characters), which will legitimately never
//      match a short on-page label and is correctly skipped by the length guard rather than forced.
//   3. The same on-page label against Column A ("Attribute Name") — CONFIRMED live this column is short and
//      label-shaped for every DIG15 row (unlike Column I), so it substantially widens how many fields can be
//      identified at all, at the cost of being the BA's own naming rather than the literal on-screen text.
// Step 1 does NOT reliably agree with Column I/A either (CONFIRMED live: "insuredName" in the DOM vs
// "PolicyInsured"/"Insured Name" in the dictionary for what's presumably the same concept) — hence trying
// the label-based steps at all instead of relying on the technical name alone. Scoped to rows already
// filtered to this template via Column E (getAttributesForTemplate), so a same-named field on an unrelated
// template can never be picked by mistake. Returns null rather than a guess when nothing lines up — an
// unmatched field stays honestly unidentified instead of silently attached to the wrong row.
// Splits on camelCase boundaries AND non-alphanumeric characters into lowercase words — "insuredName" ->
// ["insured","name"], "Our Insured:" -> ["our","insured"].
function splitWords(s) {
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
// "to" deliberately excluded — in this domain it's a recipient-role discriminator ("To Name"/"To Address"
// mirror "From Name"/"Copy Name"), not a meaningless preposition. CONFIRMED live 2026-10-05: treating it as
// filler reduced "TO ADDRESS" to the single word "address", which the word-overlap tier's 2+-word guard then
// silently refused to even attempt, so an unmistakable match to "To Street Address" never had a chance — "to"
// is already correctly preserved for "From"/"Copy" (neither was ever in this list), this just makes "To"
// consistent with them.
const FILLER_WORDS = new Set(['our', 'the', 'a', 'an', 'is', 'of', 'for', 'and', 'or', 'on', 'in', 'at']);
// "to" is only 2 characters, so the length>2 guard below was ALSO silently swallowing it even after removing
// it from FILLER_WORDS above (CONFIRMED live 2026-10-05: removing it from FILLER_WORDS alone didn't fix "TO
// ADDRESS" — this separate length filter was still eating it). Special-cased past the length guard since it's
// short but meaningful here, same reasoning as the FILLER_WORDS exclusion above.
function significantWords(s) {
  return splitWords(s).filter((w) => (w.length > 2 || w === 'to') && !FILLER_WORDS.has(w));
}
// Same generic-placeholder pattern validationService.js's pickFieldLabel already treats as "not a real
// name" (editableField1, checkBox3, ...) — its own words (editable/field/number) are meaningless noise that
// would otherwise pollute the combined query below and block an otherwise-good labelContext-only match.
const GENERIC_TECHNICAL_NAME_RE = /^(editableField|checkBox|field|textbox|input)\d*$/i;

// Last-resort fallback for when NEITHER the exact technicalName check NOR the substring label check above
// found anything — accepts a candidate whose own attributeName/templateAttributeName word set fully
// CONTAINS every significant word from the query (the live field's technicalName and/or on-page label
// combined), rather than requiring a literal substring relationship either direction. CONFIRMED live
// 2026-09-30 this is needed for genuine naming mismatches between two independently-authored vocabularies —
// e.g. the live editor's technicalName "insuredName" / on-page label "Our Insured:" vs. the dictionary's own
// "Insured Name" (attributeName) / "PolicyInsured" (templateAttributeName): neither side literally contains
// the other as a substring, but both plainly describe the same concept once reduced to significant words
// ({insured} ⊆ {insured,name}). Picks the candidate with the FEWEST total significant words among those
// satisfying full containment — the most specific match, least likely to be a coincidental one-word overlap.
function bestWordOverlapMatch(candidates, queryWords) {
  let best = null;
  let bestSize = Infinity;
  for (const r of candidates) {
    for (const field of ['attributeName', 'templateAttributeName']) {
      if (!r[field]) continue;
      const candWords = new Set(significantWords(r[field]));
      if (!candWords.size) continue;
      // CONFIRMED live 2026-10-05: a dirty dictionary cell ("CC" row's own Template Attribute Name is the
      // literal garbled text "CopyName Agent Number CopyAddress CopyCity" — several field names mashed into
      // one cell by mistake, not one coherent concept) will otherwise "fully contain" almost any short 2-word
      // query by sheer accident, and since that row is forms.all=true it's a candidate for EVERY template —
      // wrongly claimed "Copy Name"/"Copy Address" away from their own, correctly-scoped rows. A genuine
      // single-concept name is rarely more than a few words longer than the query describing it, so cap how
      // much bigger the candidate's own word set is allowed to be relative to the query.
      if (candWords.size > queryWords.length + 2) continue;
      const allPresent = queryWords.every((w) => candWords.has(w));
      if (allPresent && candWords.size < bestSize) {
        best = r;
        bestSize = candWords.size;
      }
    }
  }
  return best;
}

function matchAttributeForField(digNumber, { labelContext, technicalName } = {}) {
  const candidates = getAttributesForTemplate(digNumber);
  if (!candidates.length) return null;

  if (technicalName) {
    const needle = normalizeForMatch(technicalName);
    const exact = candidates.find((r) => r.templateAttributeName && normalizeForMatch(r.templateAttributeName) === needle);
    if (exact) return { row: exact, matchedOn: 'technicalName' };
    // CONFIRMED live 2026-10-05 (DIG122B): the live editor's own technical name sometimes carries an extra
    // business-context prefix the dictionary's own Column B doesn't ("claimantDOB" in the DOM vs just "DOB"
    // in the dictionary, for the row the dictionary itself names "Injured Person Date of Birth" — yet
    // ANOTHER vocabulary, matching neither the live name nor the template's own "Claimant Date of Birth" BA
    // comment). Same generic-placeholder exclusion as the word-overlap fallback below — this is about real
    // dictionary technical names, not coincidental short-word collisions with a numbered placeholder like
    // "CheckBox1". Shortest dictionary name first, so the most specific contained name wins.
    if (!GENERIC_TECHNICAL_NAME_RE.test(technicalName)) {
      const contains = candidates
        .filter((r) => r.templateAttributeName && normalizeForMatch(r.templateAttributeName).length >= 3)
        .sort((a, b) => a.templateAttributeName.length - b.templateAttributeName.length)
        .find((r) => needle.includes(normalizeForMatch(r.templateAttributeName)));
      if (contains) return { row: contains, matchedOn: 'technicalNameContains' };
    }
  }

  const label = normalizeForMatch(labelContext);
  if (label) {
    const ccHit = bestLabelMatch(candidates, 'ccFieldDisplay', label, 60);
    if (ccHit) return { row: ccHit, matchedOn: 'ccFieldDisplay' };
    const nameHit = bestLabelMatch(candidates, 'attributeName', label, 60);
    if (nameHit) return { row: nameHit, matchedOn: 'attributeName' };
  }

  const technicalWords = technicalName && !GENERIC_TECHNICAL_NAME_RE.test(technicalName) ? significantWords(technicalName) : [];
  const queryWords = [...new Set([...technicalWords, ...significantWords(labelContext)])];
  // CONFIRMED live 2026-10-02 (DIG181/223/236/53/2, "Insured Name" mismatched 12x): a SINGLE query word gives
  // bestWordOverlapMatch's full-containment check no real protection against a coincidental one-word hit —
  // labelContext "Our Policy No.:" reduces to just ["policy"] ("our" is a filler word, "no" is filtered out
  // by the length>2 guard), which then trivially "contains" the Insured Name row's own templateAttributeName
  // "PolicyInsured" (significant words {"policy","insured"}) — wrongly matching the POLICY NUMBER field to
  // the INSURED NAME dictionary row. Requiring 2+ query words keeps the fallback's own documented intent
  // (favor the candidate with the fewest words satisfying full containment, i.e. the most SPECIFIC match)
  // actually meaningful — a lone generic word like "policy" is too weak a signal to trust alone.
  if (queryWords.length >= 2) {
    const wordHit = bestWordOverlapMatch(candidates, queryWords);
    if (wordHit) return { row: wordHit, matchedOn: 'wordOverlap' };
  }

  // Absolute last resort — EXACT name agreement against the UNSCOPED dictionary (see findExactMatchAnyScope's
  // own header). Tried last, after every scoped tier above, so a properly-scoped row always wins first.
  if (technicalName) {
    const hit = findExactMatchAnyScope(technicalName, ['templateAttributeName']);
    if (hit) return hit;
  }
  if (label) {
    const hit = findExactMatchAnyScope(labelContext, ['attributeName', 'ccFieldDisplay']);
    if (hit) return hit;
  }

  return null;
}

// Looks up a dictionary row directly by the TEMPLATE's own BA-comment field name (e.g. "Date Of Loss",
// "Policy Number" — see templateRequirementService.js's comment-anchored requirements) instead of the live
// editor's on-page label text. CONFIRMED live 2026-10-05 (DIG53): this is a dramatically more reliable key
// than the editor's own label/technicalName — 11 of 22 comment field names matched a dictionary row EXACTLY
// on the first try (vs. 2 of 27 live DOM fields matching via the label-based matchAttributeForField above),
// because both sides here are the SAME BA's own vocabulary, not two independently-worded systems. Tries
// Column A (Attribute Name) first, then Column B (Template Attribute Name) — a comment field name containing
// either (or vice versa) counts, same contains-either-direction idea as bestLabelMatch.
// Curated BA-comment-wording -> dictionary Attribute Name synonyms — confirmed correct by the user directly
// (2026-10-06), not inferred, for cases too loosely/differently worded for the generic tiers below to safely
// catch on their own (a single shared word, an irrelevant parenthetical, an abbreviation, or a genuinely
// different term for the same business concept). "Employer Name" -> "Insured Name" specifically follows the
// dictionary's OWN established convention — "Employer Address"/"Employer FEIN"/"Employer Phone" all resolve
// via their own xpath's `role = 'insured'` filter despite their business-facing name saying "Employer", so
// "Employer Name" follows that same precedent. Keys are normalizeForMatch'd so wording/case/spacing variants
// of the same key (e.g. "Date Of Accident" / "DATE OF ACCIDENT") collapse to one entry automatically.
const COMMENT_NAME_SYNONYMS = {
  'named insured': 'Insured Name',
  'employer name': 'Insured Name', // per the dictionary's own role='insured' convention for other Employer-* rows
  'our claim no': 'Claim Number',
  'occupation editable': 'Claimant Occupation',
  'underwriting office': 'Underwriting Company',
  'uw office': 'Underwriting Company',
  'date of accident': 'Date of Loss',
  // CONFIRMED by user 2026-10-06, reviewing DIG2118's unmapped list: "Employer Address" is ALREADY scoped to
  // DIG2118 and editable=Yes, it's just ONE combined concat(street+city+state+zip) row, not 3 separate ones —
  // the template's BA comments split it into 3 names the dictionary never tracks individually, so all 3 point
  // at the same row.
  'employer city': 'Employer Address',
  'employer state': 'Employer Address',
  'employer zip': 'Employer Address',
  // "Claimant Address City/State/Zip" already exist and already work for DIG34401 (same wording) — DIG2118 is
  // just missing from THEIR OWN Form(s) column, and since these are word-overlap-style matches (not exact
  // text), the generic unscoped-exact fallback doesn't reach them on its own.
  'claimant city': 'Claimant Address City',
  'claimant state': 'Claimant Address State',
  'claimant zip': 'Claimant Address Zip',
  // "From Address City/State/Zip" exist but only scoped to DIG208 with a BLANK/unspecified Column G — mapping
  // "From City, State, ZIP" here still SKIPS (nothing to validate against a blank editable flag), but gives it
  // a real identity for the top-down reconciliation report instead of showing as a bare unmatched name. Per
  // user direction 2026-10-06: map despite the blank editable; "From Signature"/"From Designation" (DIG2) stay
  // unmapped — no dictionary row exists for either concept at all, nothing to point them at.
  'from city state zip': 'From Address City',
};

function matchDictionaryRowByCommentFieldName(digNumber, fieldName) {
  const candidates = getAttributesForTemplate(digNumber);
  const name = normalizeForMatch(fieldName);
  if (!name || name.length < 3) return null;
  const synonymTarget = COMMENT_NAME_SYNONYMS[name];
  if (synonymTarget) {
    const found = getAttributeByExactName(digNumber, synonymTarget);
    if (found) return { row: found.row, matchedOn: found.scoped ? 'commentSynonym' : 'commentSynonymUnscoped' };
  }
  for (const col of ['attributeName', 'templateAttributeName']) {
    const exact = candidates.find((r) => r[col] && normalizeForMatch(r[col]) === name);
    if (exact) return { row: exact, matchedOn: col + 'Exact' };
  }
  for (const col of ['attributeName', 'templateAttributeName']) {
    const hit = candidates
      .filter((r) => r[col] && normalizeForMatch(r[col]).length >= 3)
      .sort((a, b) => a[col].length - b[col].length) // shortest first = most specific superset, same reasoning as bestLabelMatch's reverse pass
      .find((r) => {
        const cand = normalizeForMatch(r[col]);
        if (name.includes(cand)) return true; // query contains candidate — candidate is the short/specific side, safe
        // Candidate contains query — only trust this when the candidate isn't a sprawling multi-concept cell,
        // same "CC" row landmine as bestWordOverlapMatch's own guard below: its own Template Attribute Name
        // is the literal garbled text "CopyName Agent Number CopyAddress CopyCity" (several field names mashed
        // into one cell), which trivially "contains" short queries like "Agent Number" by sheer accident —
        // CONFIRMED live 2026-10-06, wrongly claimed "Agent Number" away from its own correctly-scoped row
        // across 22 templates. A genuine single-concept name is rarely much longer, word-wise, than the query
        // describing it.
        return cand.includes(name) && significantWords(r[col]).length <= significantWords(name).length + 2;
      });
    if (hit) return { row: hit, matchedOn: col + 'Contains' };
  }
  // Last resort: same word-overlap technique matchAttributeForField uses for live DOM fields — catches a BA
  // comment phrased in different words than the dictionary's own name for the same concept (CONFIRMED via a
  // full-catalog static scan 2026-10-05: "Loss Date" vs dictionary's "Date of Loss" — neither side is a
  // substring of the other, but both reduce to the same two significant words). Same 2+-word guard as the
  // live-field fallback and for the same reason — a single shared word is too weak a signal to trust alone,
  // so a two-word BA phrase where one word is a filler ("TO ADDRESS" -> just "address") still goes unmatched
  // by design rather than risk a wrong guess among several similarly-worded rows.
  const queryWords = significantWords(fieldName);
  if (queryWords.length >= 2) {
    const wordHit = bestWordOverlapMatch(candidates, queryWords);
    if (wordHit) return { row: wordHit, matchedOn: 'wordOverlap' };
  }
  // Absolute last resort — EXACT name agreement against the UNSCOPED dictionary (see findExactMatchAnyScope's
  // own header). Tried last, after every scoped tier above, so a properly-scoped row always wins first.
  return findExactMatchAnyScope(fieldName, ['attributeName', 'templateAttributeName']);
}

// Top-down list of "business fields this template's own BA comments say should exist, with a real
// editability opinion" — the reverse of matchAttributeForField's bottom-up "which DOM field did I just find"
// approach. Built from templateRequirementService's own comment-derived requirement field names (deduped —
// several comments, e.g. "Date of Loss" and "Date Of Loss", can resolve to the same row) rather than
// re-deriving anything from the live editor, so it exists independently of whatever the interactive session
// does or doesn't find — which is the whole point: a tracked field with NO corresponding live DOM match is
// itself a real finding (see validationService.js), not something that should just silently disappear.
function getTrackedFieldsForTemplate(digNumber, commentFieldNames) {
  const seen = new Set();
  const out = [];
  for (const fieldName of commentFieldNames || []) {
    const match = matchDictionaryRowByCommentFieldName(digNumber, fieldName);
    if (!match || match.row.editable === null || seen.has(match.row.attributeName)) continue;
    seen.add(match.row.attributeName);
    out.push({ fieldName, row: match.row, matchedOn: match.matchedOn });
  }
  return out;
}

module.exports = {
  loadAttributes, getAttributesForTemplate, countApplicableTrackedFields, matchAttributeForField,
  matchDictionaryRowByCommentFieldName, getTrackedFieldsForTemplate, bestLabelMatch, normalizeForLabelMatch,
  findFile, normalizeForMatch, findExactMatchAnyScope, getAttributeByExactName,
};
