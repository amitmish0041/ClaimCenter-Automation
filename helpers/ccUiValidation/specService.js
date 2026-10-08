/**
 * helpers/ccUiValidation/specService.js
 * Parses the "Documents - Create Correspondence" requirement workbook (the
 * SmartCOMM Accelerator user-story card) into structured data:
 *   - uiFields   : "UI Fields" tab   — per-field visible/mandatory/editable/type/default rules
 *   - typelists  : "Typelists" tab   — expected dropdown values (+ retired flags)
 *   - businessRules / activityPatterns : the rule text and activity→template map
 * Independent of helpers/smartComm (template-content validation) on purpose:
 * this drives the ClaimCenter *screen* checks only.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// The spec/dictionary workbooks live in the "Requirement" subfolder of the SmartCOMM data folder. Default to
// the bundled copy's Requirement folder - SMARTCOMM_DATA_DIR is what the packaged app points at its own bundled
// smartcomm-data (same var catalogService.js uses) - so this works on any machine, not just the one it was
// built on. CC_UI_SPEC_DIR still overrides; the literal is only the dev-machine fallback when neither is set.
const DEFAULT_SPEC_DIR = process.env.CC_UI_SPEC_DIR
  || (process.env.SMARTCOMM_DATA_DIR && path.join(process.env.SMARTCOMM_DATA_DIR, 'Requirement'))
  || 'C:\\Users\\amitmish\\Desktop\\CC Cloud\\SmartComm\\Requirement';

function findSpecFile() {
  if (process.env.CC_UI_SPEC_FILE) return process.env.CC_UI_SPEC_FILE;
  const hit = fs.existsSync(DEFAULT_SPEC_DIR)
    ? fs.readdirSync(DEFAULT_SPEC_DIR).find((n) => /^Documents.*Create Correspondence.*\.xlsx$/i.test(n) && !n.startsWith('~$'))
    : null;
  if (!hit) throw new Error(`specService: no "Documents - Create Correspondence*.xlsx" found in ${DEFAULT_SPEC_DIR} (set CC_UI_SPEC_FILE or CC_UI_SPEC_DIR)`);
  return path.join(DEFAULT_SPEC_DIR, hit);
}

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const tri = (v) => {
  const t = clean(v).toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'conditional') return 'conditional';
  return null; // blank / unspecified
};
const SCREEN_ALIASES = { 'filter documetns': 'Filter Documents' };

function sheetRows(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`specService: workbook has no "${name}" tab`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

// UI Fields columns (row 8 header): 0 Req#, 1 DV/LV, 2 Base/New/Modified, 3 Display Key, 4 Label, 5 Label(Loc),
// 6 Path, 7 Table, 8 Field Name, 9 Field Type, 10 Length, 11 Typelist, 12 Editable, 13 Mandatory, 14 Visible,
// 15 Available, 16 Default, 17 Permissions, 18 Notes, 19 Wave, 20 LOB.
function parseUiFields(wb) {
  const rows = sheetRows(wb, 'UI Fields');
  const fields = [];
  let screen = '';
  let section = '';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map(clean);
    const nonEmpty = r.filter(Boolean).length;
    if (r[0] === 'Requirement Number') continue;
    if (nonEmpty === 1 && r[0] && !/^User Story Card|^Track |^Functional Details|Story Card Name|Product Owner/i.test(r[0])) {
      screen = SCREEN_ALIASES[r[0].toLowerCase()] || r[0];
      section = '';
      continue;
    }
    if (nonEmpty === 1 && r[1] && !r[4]) { section = r[1]; continue; }
    if (!r[4] || !screen) continue; // no label (or still in the card header) → not a field row
    fields.push({
      row: i + 1,
      reqId: r[0] || '',
      screen,
      section,
      changeType: r[2] || '',
      label: r[4],
      fieldType: r[9],
      typelist: r[11],
      editable: tri(r[12]),
      mandatory: tri(r[13]),
      visible: tri(r[14]),
      defaultValue: r[16],
      notes: r[18],
    });
  }
  return fields;
}

// Typelists columns: 0 Typelist, 1 New/Modified, 2 Code, 3 Name, 4 Name(Loc), 5 Description, 6 Desc(Loc),
// 7 Priority, 8 Retired, 9 Conditions. A value's display label is Name, else Description, else Code
// (LOB rows only fill Description; DocumentType rows repeat the code as Name).
function parseTypelists(wb) {
  const rows = sheetRows(wb, 'Typelists');
  const lists = {};
  for (const raw of rows) {
    const r = raw.map(clean);
    if (!r[0] || r[0] === 'Name of Typelist') continue;
    if (r.filter(Boolean).length === 1) continue; // typelist header row / titles
    const label = r[3] || r[5] || r[2];
    if (!label || !r[1]) continue;
    (lists[r[0]] = lists[r[0]] || []).push({
      changeType: r[1], code: r[2], label, retired: /^true$/i.test(r[8]), conditions: r[9],
    });
  }
  return lists;
}

function parseBusinessRules(wb) {
  return sheetRows(wb, 'UI Validation & Business Rules').map((r) => r.map(clean))
    .filter((r) => /^\d+$/.test(r[0]) && r.some((c, i) => i > 0 && c))
    .map((r) => ({ id: `BR${r[0]}`, text: r.slice(1).filter(Boolean).join(' — ') }));
}

function parseActivityPatterns(wb) {
  return sheetRows(wb, 'Activity Pattern to Document').map((r) => r.map(clean))
    .filter((r) => /^\d+$/.test(r[0]) && r[1] && r[2])
    .map((r) => ({ id: `AP${r[0]}`, activityPattern: r[1], template: r[2] }));
}

let cached;
function loadSpec({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  const file = findSpecFile();
  const wb = XLSX.readFile(file);
  cached = {
    file,
    uiFields: parseUiFields(wb),
    typelists: parseTypelists(wb),
    businessRules: parseBusinessRules(wb),
    activityPatterns: parseActivityPatterns(wb),
  };
  return cached;
}

module.exports = { loadSpec, findSpecFile };
