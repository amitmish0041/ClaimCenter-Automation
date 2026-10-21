/**
 * helpers/oneInc/inventoryService.js
 * Reads the OneInc QA test-design workbooks (the BA/QA-maintained "GCCM-xxx ... Test Design" .xlsx files under
 * ONEINC_DIR) into one flat list of test cases. Nothing is hand-copied into code: the workbooks are read fresh on
 * every call, so an edited or newly dropped workbook shows up on the next run.
 *
 * Every test-case sheet in these workbooks shares one 11-column layout (CONFIRMED 2026-10-20 across all 9 files):
 *   Test Case Id | Test Case Name | Description | Pre-condition | Step # | Step Description | Expected Result |
 *   Test Case Type | Test Case Status | Test Case Priority | Test Case Assigned To
 * A test case starts on the row with an Id and continues over the following Id-less rows (one row per step).
 * Sheets without that header (overviews, mock-ups, dropdown lists, screenshots) are reference material, not cases.
 *
 * Scenario ids are "<story>/<sheet code>/<TC id>" (e.g. "GCCM-759/UIF/TC-004") — TC ids repeat across sheets and
 * workbooks (every sheet restarts at TC-001), so the TC id alone is never unique.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// The team share — every teammate's run reads the same workbooks and writes to the same AutomationResults
// (per user direction 2026-10-20: no personal/local drive paths; everything on V:). Override with ONEINC_DIR.
const DEFAULT_DIR = path.join('V:', 'Amit Int', 'OneInc');
const ONEINC_DIR = process.env.ONEINC_DIR || DEFAULT_DIR;
const RESULTS_DIRNAME = 'AutomationResults';

const HEADER = ['test case id', 'test case name', 'description', 'pre-condition', 'step #', 'step description',
  'expected result', 'test case type', 'test case status', 'test case priority', 'test case assigned to'];

// Sheets a later sheet in the same workbook replaces. Both workbooks keep the old sheet next to a "... New" one
// after JRM feedback ("Changes Incorporated" tab); the old cases are still inventoried, but marked superseded so
// they are reported as NOT EXECUTED with that reason rather than silently dropped or run twice.
const SUPERSEDED_SHEETS = {
  'Additional Payment Details TCs': 'Additional Payment Details_New',
  'INT.001 Test Cases': 'INT.001 Test Cases New',
};

const clean = (v) => String(v == null ? '' : v).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

// "GCCM-1003_CC_Test Design_..." -> "GCCM-1003"; the Part 2 workbook has no GCCM key in its name, but its own
// overview names its QA design card (GCCM-799), which is what we key it by.
function storyKeyOf(fileName, overviewRows) {
  const m = /GCCM-\d+/i.exec(fileName);
  if (m) return m[0].toUpperCase();
  for (const r of overviewRows || []) {
    if (/^qa test design/i.test(clean(r[0]))) {
      const k = /GCCM-\d+/i.exec(clean(r[1]));
      if (k) return k[0].toUpperCase();
    }
  }
  return path.basename(fileName, path.extname(fileName)).slice(0, 20);
}

// Short code for a sheet, used in scenario ids: "UIF.001-UIF.070" -> "UIF", "CPD.016 - CPD.022-Leinholder" ->
// "CPD-Lienholder", "Business Rules VBR.001-037" -> "VBR", "GCCM-803 TCs" -> "TC".
function sheetCodeOf(name) {
  const n = name.trim();
  if (/additional payment details_new/i.test(n)) return 'APD';
  if (/additional payment details/i.test(n)) return 'APD-old';
  if (/int\.001 test cases new/i.test(n)) return 'INT';
  if (/int\.001 test cases/i.test(n)) return 'INT-old';
  if (/leinholder|lienholder/i.test(n)) return 'CPD-Lienholder';
  if (/mortgagee/i.test(n)) return 'CPD-Mortgagee';
  if (/joint payment/i.test(n)) return 'CPD-Joint';
  const m = /\b(UIF|VBR|CPD|INT)\b/i.exec(n);
  if (m) return m[1].toUpperCase();
  return 'TC';
}

function overviewFields(rows) {
  const meta = {};
  for (const r of rows.slice(0, 14)) {
    const k = clean(r[0]).replace(/:$/, '').toLowerCase();
    const v = clean(r[1]);
    if (!k || !v) continue;
    if (k === 'description') meta.description = v;
    else if (k === 'story card') meta.storyCard = v;
    else if (k === 'scope') meta.scope = v;
    else if (k === 'prepared by') meta.preparedBy = v;
    else if (k === 'qa test design') meta.qaDesign = v;
    else if (k === 'qa test exec') meta.qaExec = v;
    else if (k === 'analysis') meta.analysis = v;
  }
  return meta;
}

function isTcHeader(row) {
  return HEADER.every((h, i) => clean(row[i]).toLowerCase() === h);
}

// One sheet -> test cases. Exported for the offline tests.
function parseCaseRows(rows) {
  const cases = [];
  let cur = null;
  for (const r of rows.slice(1)) {
    const id = clean(r[0]);
    const stepNo = clean(r[4]);
    const stepText = clean(r[5]);
    const expected = clean(r[6]);
    if (id) {
      cur = {
        tcId: id.replace(/\s+/g, ''),
        name: clean(r[1]),
        description: clean(r[2]),
        precondition: clean(r[3]),
        steps: [],
        type: clean(r[7]),
        designStatus: clean(r[8]),
        priority: clean(r[9]),
        assignedTo: clean(r[10]),
      };
      cases.push(cur);
    } else if (!cur) {
      continue;
    } else {
      // Continuation rows may also carry overflow text in the name/description/precondition columns.
      if (clean(r[3])) cur.precondition = [cur.precondition, clean(r[3])].filter(Boolean).join('\n');
    }
    if (stepNo || stepText || expected) cur.steps.push({ no: stepNo, action: stepText, expected });
  }
  return cases;
}

function listWorkbooks(dir = ONEINC_DIR) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === RESULTS_DIRNAME || e.name.startsWith('~$')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.xlsx$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  // The folder was delivered as "One Inc.zip"; unpack it once (next to itself) when no workbook is there yet.
  if (!out.length && fs.existsSync(dir)) {
    const zips = fs.readdirSync(dir).filter((f) => /\.zip$/i.test(f));
    if (zips.length) {
      const AdmZip = require('adm-zip');
      for (const z of zips) {
        const target = path.join(dir, path.basename(z, '.zip'));
        if (!fs.existsSync(target)) new AdmZip(path.join(dir, z)).extractAllTo(target, false);
      }
      return listWorkbooks(dir);
    }
  }
  return out.sort();
}

/**
 * Loads every test case. Returns { dir, workbooks: [{ file, story, meta, sheets: [...], referenceSheets: [...] }],
 * cases: [{ scenarioId, story, workbook, sheet, sheetCode, tcId, name, description, precondition, steps, ... }] }.
 */
function loadInventory({ dir = ONEINC_DIR } = {}) {
  const workbooks = [];
  const cases = [];
  for (const file of listWorkbooks(dir)) {
    const wb = XLSX.readFile(file);
    const rowsOf = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false, defval: '' });
    const overviewRows = rowsOf(wb.SheetNames[0]);
    const story = storyKeyOf(path.basename(file), overviewRows);
    const wbInfo = { file, fileName: path.basename(file), story, meta: overviewFields(overviewRows), sheets: [], referenceSheets: [] };
    const usedCodes = new Set();
    for (const sheet of wb.SheetNames) {
      const rows = rowsOf(sheet);
      if (!rows.length || !isTcHeader(rows[0])) { wbInfo.referenceSheets.push(sheet); continue; }
      // Two sheets of one workbook can share a code (GCCM-799 has "UIF.026 - UIF.075" and "UIF.001-UIF.004"):
      // the later one gets its first requirement number appended ("UIF-001") so ids stay unique.
      let sheetCode = sheetCodeOf(sheet);
      if (usedCodes.has(sheetCode)) sheetCode += '-' + ((/(\d{3})/.exec(sheet) || [])[1] || String(usedCodes.size + 1));
      usedCodes.add(sheetCode);
      const parsed = parseCaseRows(rows);
      wbInfo.sheets.push({ name: sheet, code: sheetCode, cases: parsed.length });
      const seen = {};
      for (const c of parsed) {
        // A handful of sheets reuse an id twice; keep both, disambiguated, instead of letting one overwrite the other.
        seen[c.tcId] = (seen[c.tcId] || 0) + 1;
        const suffix = seen[c.tcId] > 1 ? `#${seen[c.tcId]}` : '';
        cases.push({
          scenarioId: `${story}/${sheetCode}/${c.tcId}${suffix}`,
          story,
          workbook: path.basename(file),
          storyTitle: wbInfo.meta.description || '',
          sheet,
          sheetCode,
          supersededBy: SUPERSEDED_SHEETS[sheet.trim()] && wb.SheetNames.some((s) => s.trim() === SUPERSEDED_SHEETS[sheet.trim()])
            ? SUPERSEDED_SHEETS[sheet.trim()] : null,
          ...c,
        });
      }
    }
    workbooks.push(wbInfo);
  }
  return { dir, workbooks, cases };
}

module.exports = { ONEINC_DIR, RESULTS_DIRNAME, loadInventory, listWorkbooks, _test: { parseCaseRows, sheetCodeOf, storyKeyOf, isTcHeader } };
