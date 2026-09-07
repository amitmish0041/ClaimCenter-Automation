/**
 * helpers/smartComm/testDataService.js
 * Loads the SmartCOMM claim test-data inventory directly from the BA/QA-
 * maintained "Test Data" spreadsheet under SMARTCOMM_DATA_DIR — a real,
 * SQL-extracted list of claims that actually exist in this environment
 * (its own "SQL Statement" sheet documents the exact query), not hand-typed
 * fixtures. scenarioService filters this list by each template's own
 * State/LOB applicability, same as it always did — this file just changes
 * WHERE the records come from, not the shape callers see.
 *
 * Only claimNumber/policyNumber/lossDate/state/lob are seeded here.
 * insuredName/lossLocation/claimantName etc. are captured live off the
 * claim itself once it's opened (claimSummaryService) and always win over
 * anything seeded here (see validationService's merge), so this file
 * doesn't need to carry them — a bare claim number plus enough to match a
 * template's applicability is the whole job.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const catalogService = require('./catalogService');
const { toLongDateFormat } = require('./claimSummaryService');

const DATA_DIR = catalogService.DATA_DIR;
const TEST_DATA_DIR = path.join(DATA_DIR, 'Test Data');

function findFile(dir, patternRe) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => patternRe.test(f) && !f.startsWith('~$'));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]);
}

// The spreadsheet's own POLICY_TYPE values ("Personal auto", "Dwelling
// Fire", ...) don't match the catalog's LOB codes (ALL/AUTO/GL/PR/PROPERTY/
// WC — CONFIRMED via a catalog scan 2026-09-04) verbatim — mapped by hand
// once here rather than per-record. Property-adjacent lines (Dwelling
// Fire/Homeowner's/Boatowner's/Farmowner's/Inland marine) go to PR, the
// code the catalog itself uses for its own property-line templates (e.g.
// DIG7 Risk Roof Report). BOP/Commercial Package/Excess Liability go to GL
// — the catalog has no separate BOP/CP code, and GL's own example
// templates (compliance/BI-intent/release letters) are the closest match
// for commercial-liability-flavored correspondence; adjust here if a
// review turns up a better fit.
const POLICY_TYPE_TO_LOB = {
  'personal auto': 'AUTO',
  'commercial auto': 'AUTO',
  'dwelling fire': 'PR',
  "homeowner's": 'PR',
  "boatowner's": 'PR',
  "farmowner's": 'PR',
  'inland marine': 'PR',
  "workers' comp": 'WC',
  'bop': 'GL',
  'commercial package': 'GL',
  'commercial excess liability': 'GL',
  'personal excess liability': 'GL',
};

let cachedRecords = null;

function getAllRecords({ refresh = false } = {}) {
  if (cachedRecords && !refresh) return cachedRecords;
  const file = findFile(TEST_DATA_DIR, /\.xlsx$/i);
  if (!file) {
    throw new Error(
      `SmartCOMM test-data inventory not found under "${TEST_DATA_DIR}" (expected an .xlsx file). ` +
      `Set SMARTCOMM_DATA_DIR in .env to override, or provide a Claim # override in the Runner UI.`
    );
  }
  const wb = XLSX.readFile(file);
  const sheetName = wb.SheetNames.find(n => /^sheet ?1$/i.test(n)) || wb.SheetNames[0];
  // raw:false so LOSSDATE (an Excel date serial) comes back as the same
  // "MM/DD/YYYY" string toLongDateFormat expects, instead of a raw number.
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: false });

  cachedRecords = rows
    .filter(r => r.CLAIMNUMBER)
    .map(r => {
      const state = String(r.POLICY_STATE || '').trim().toUpperCase();
      const policyType = String(r.POLICY_TYPE || '').trim();
      const lob = POLICY_TYPE_TO_LOB[policyType.toLowerCase()] || policyType.toUpperCase();
      return {
        claimNumber: String(r.CLAIMNUMBER).trim(),
        policyNumber: String(r.POLICYNUMBER || '').trim() || undefined,
        lossDate: toLongDateFormat(String(r.LOSSDATE || '').trim()) || undefined,
        state,
        lob,
      };
    })
    .filter(r => r.claimNumber && r.state && r.lob);

  return cachedRecords;
}

module.exports = { getAllRecords };
