/**
 * helpers/smartComm/fraudLanguageService.js
 * Looks up the state/LOB/loss-cause-specific fraud language text from the
 * "Fraud Language" tab of Claims_Documents_Index.xlsx and exposes it for
 * comparison against a generated document's text.
 *
 * templateRequirementService.js deliberately leaves a template's own "Fraud
 * Language" BA comment SKIPPED — the literal sample text anchored in that
 * comment isn't the real, state-specific required wording, just whatever
 * example the BA had in the doc when they wrote it. The REAL wording is
 * state/LOB/loss-cause dependent and lives only in this spreadsheet tab, so
 * validationService.js calls this module directly (for any template whose
 * derived requirements mention "Fraud Language" at all) rather than trying
 * to make the comment-derived requirement itself carry the right value.
 */
'use strict';
const XLSX = require('xlsx');
const catalogService = require('./catalogService');

// Standard USPS state/territory abbreviations - the spreadsheet's "State"
// column is the full name ("Pennsylvania"); the SmartCOMM payload's own
// claim.lossLocation.state / policy location address.state give back the
// 2-letter code ("PA") - this bridges the two.
const STATE_NAME_TO_CODE = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC',
  'Washington DC': 'DC', // exact spelling CONFIRMED in Claims_Documents_Index's own "Fraud Language" tab
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
  Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR',
  Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD',
  Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA',
  Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
  'Puerto Rico': 'PR_TERRITORY', // distinct from the LOB code "PR" (Property) - not expected in this sheet, kept defensively
};

// The spreadsheet's "Loss Type" wording -> the same LOB codes testDataService
// and the SmartCOMM payload's own claim.lossType.code already use
// (AUTO/GL/PR/WC - CONFIRMED against a real payload sample, 2026-09-22).
function normalizeLossType(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t === 'auto') return 'AUTO';
  if (t === 'workers compensation') return 'WC';
  if (t === 'property') return 'PR';
  if (t === 'general liability') return 'GL';
  return t ? t.toUpperCase() : undefined;
}

let cache = null;
let cachedFilePath = null;

function loadFraudLanguageTable({ refresh = false } = {}) {
  const filePath = catalogService.findFile(catalogService.DATA_DIR, /^Claims_Documents_Index.*\.xlsx$/i);
  if (!filePath) {
    throw new Error(`fraudLanguageService: no Claims_Documents_Index*.xlsx found under "${catalogService.DATA_DIR}"`);
  }
  if (cache && !refresh && cachedFilePath === filePath) return cache;

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Fraud Language'];
  if (!ws) throw new Error(`fraudLanguageService: "${filePath}" has no "Fraud Language" tab`);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  // Header row: S.No. | State | Policy State Code | Fraud Language | Conditions | Effective Date | Location/Size | Citation
  cache = rows.slice(1)
    .map((r) => ({
      stateName: String(r[1] || '').trim(),
      stateCode: STATE_NAME_TO_CODE[String(r[1] || '').trim()],
      fraudLanguage: String(r[3] || '').trim(),
      conditions: String(r[4] || '').trim(),
      citation: String(r[7] || '').trim(),
    }))
    .filter((r) => r.stateName);
  cachedFilePath = filePath;
  return cache;
}

// Handles every condition phrasing CONFIRMED present in the sheet
// (2026-09-22 scan of all 55 rows): "All", blank (same as All), "Loss Type =
// X", "Loss Type is not equal to X", the compound "Loss Type = Property and
// Loss Cause = Fire", and "All except [...], [...] and [...]" (a list of the
// same bracketed sub-conditions, ANDed as exclusions). An unrecognized
// phrasing conservatively does NOT match, rather than risk silently
// asserting the wrong state's language as a false PASS.
function conditionMatches(conditionsText, { lob, lossCauseName }) {
  const c = String(conditionsText || '').trim();
  if (!c || /^all$/i.test(c)) return true;

  const allExceptMatch = c.match(/^all except\s*(.+)$/i);
  if (allExceptMatch) {
    const subConditions = [...allExceptMatch[1].matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
    return !subConditions.some((sub) => conditionMatches(sub, { lob, lossCauseName }));
  }

  const compoundMatch = c.match(/^loss type\s*=\s*([^,]+?)\s+and\s+loss cause\s*=\s*(.+)$/i);
  if (compoundMatch) {
    const lossTypeOk = normalizeLossType(compoundMatch[1]) === lob;
    const lossCauseOk = String(lossCauseName || '').toLowerCase().includes(compoundMatch[2].trim().toLowerCase());
    return lossTypeOk && lossCauseOk;
  }

  const eqMatch = c.match(/^loss type\s*=\s*(.+)$/i);
  if (eqMatch) return normalizeLossType(eqMatch[1]) === lob;

  const neMatch = c.match(/^loss type is not equal to\s*(.+)$/i);
  if (neMatch) return normalizeLossType(neMatch[1]) !== lob;

  return false;
}

// Returns { fraudLanguage, citation, conditions, stateName } for the first
// row matching both stateCode and the given lob/lossCauseName, or null if
// the state isn't in the sheet at all, or no row's condition matches (e.g.
// an unrecognized loss type for that state - conservatively reported as "no
// match" rather than guessing).
function getExpectedFraudLanguage(stateCode, { lob, lossCauseName } = {}) {
  if (!stateCode) return null;
  const table = loadFraudLanguageTable();
  const stateRows = table.filter((r) => r.stateCode === stateCode);
  if (!stateRows.length) return null;
  return stateRows.find((r) => conditionMatches(r.conditions, { lob, lossCauseName })) || null;
}

// Punctuation/whitespace-insensitive: reduces to lowercase words only, same
// idea as pdfValidationService's word-level matching.
function reduceToWords(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Every row of the sheet (ANY state/condition, "None" rows excluded) whose
// wording appears in `text`. Lets a failed check say "a DIFFERENT variant is
// printed" instead of a bare "Not Found" when the document does carry fraud
// language, just not the one this claim's state/loss type requires.
function findFraudLanguageInText(text) {
  const haystack = ` ${reduceToWords(text)} `;
  return loadFraudLanguageTable().filter((r) => {
    const needle = reduceToWords(r.fraudLanguage);
    return needle && !/^none$/i.test(r.fraudLanguage.trim()) && haystack.includes(` ${needle} `);
  });
}

// Pulls whatever fraud-warning wording the document actually prints, verbatim
// (whitespace-collapsed), whether or not it matches any sheet row — so a
// failed check can show the reader exactly what is in the PDF next to what was
// expected. Works on the PDF's own text lines (the warning sits on its own
// lines, but its neighbours — address block, date, form number — have no
// sentence punctuation to split on): a line carrying fraud-warning vocabulary
// starts a block; the block keeps going through wrapped continuation lines
// (previous line didn't end a sentence) and further flagged lines. Blocks
// containing "fraud"/"misleading"/"knowingly" are kept. Returns '' when
// nothing looks like a fraud warning.
const FRAUD_LINE_RE = /defraud|fraud|misleading|criminal|felony|misdemeanor|imprison|convict|knowingly|conceals|penalt(?:y|ies)|restitution/i;
const FRAUD_CORE_RE = /fraud|misleading|knowingly/i;
const SENTENCE_END_RE = /[.!?]["')]?$/;

function extractFraudLanguageFromText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim());
  const blocks = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) { if (current) { blocks.push(current); current = null; } continue; }
    if (FRAUD_LINE_RE.test(line)) {
      if (!current) {
        current = [line];
        // A flagged line starting lowercase is mid-sentence — pull in the wrapped start.
        for (let j = i - 1; j >= 0 && /^[a-z]/.test(current[0]) && lines[j]; j--) current.unshift(lines[j]);
      } else {
        current.push(line);
      }
    } else if (current && !SENTENCE_END_RE.test(current[current.length - 1])) {
      current.push(line); // wrapped continuation of an unfinished sentence
    } else if (current) {
      blocks.push(current);
      current = null;
    }
  }
  if (current) blocks.push(current);
  const out = blocks.map((b) => b.join(' ')).filter((b) => FRAUD_CORE_RE.test(b)).join(' || ');
  return out.length > 1500 ? `${out.slice(0, 1500)}…` : out;
}

module.exports = { getExpectedFraudLanguage, findFraudLanguageInText, extractFraudLanguageFromText, conditionMatches, normalizeLossType, loadFraudLanguageTable, STATE_NAME_TO_CODE };
