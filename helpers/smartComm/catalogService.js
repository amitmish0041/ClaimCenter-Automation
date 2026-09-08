/**
 * helpers/smartComm/catalogService.js
 * Reads Claims_Documents_Index.xlsx — the BA/QA-maintained master SmartCOMM
 * template catalog — directly. This repo never copies its rows into JS/JSON;
 * adding a template to the spreadsheet is all that's needed for it to show
 * up here, so this file never changes when the template inventory grows.
 *
 * SMARTCOMM_DATA_DIR points at the folder holding Claims_Documents_Index*.xlsx
 * and Templates/ClaimCenter/*.docx. Defaults to the one live location this
 * was built against; override via .env once the data moves off one person's
 * Desktop.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DATA_DIR = process.env.SMARTCOMM_DATA_DIR || 'C:\\Users\\amitmish\\Desktop\\CC Cloud\\SmartComm';

// "DIG 47", "DIG47", "Dig-47", "dig 23MD" all normalize to "DIG47" / "DIG23MD"
// so the catalog (Form Number), the Word file names, and whatever a caller
// types all line up regardless of which spacing/casing convention was used.
function normalizeDig(raw) {
  return String(raw || '').toUpperCase().replace(/DIG\s*-?\s*/, 'DIG').replace(/\s+/g, '');
}

function findFile(dir, patternRe) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => patternRe.test(f) && !f.startsWith('~$'));
  if (!files.length) return null;
  // Most recently modified wins — handles a re-downloaded "(1)" copy sitting
  // alongside an older original without needing an exact filename match.
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]);
}

function sheetToObjects(ws, headerMustInclude) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  const headerIdx = rows.findIndex(r => r.includes(headerMustInclude));
  if (headerIdx === -1) {
    throw new Error(`catalogService: no header row containing "${headerMustInclude}" found (sheet layout changed?)`);
  }
  const header = rows[headerIdx];
  return rows.slice(headerIdx + 1)
    .filter(r => r[0] || r[1])
    .map(r => {
      const o = {};
      header.forEach((h, i) => { if (h) o[h] = r[i]; });
      return o;
    });
}

// "All" / "" -> ['ALL'] (wildcard); "PA, DE, MD" -> ['PA','DE','MD'].
function splitList(raw) {
  const s = String(raw || '').trim();
  if (!s || /^all$/i.test(s)) return ['ALL'];
  return s.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
}

// Numeric-aware ordering so DIG9 sorts before DIG47 and DIG47 before DIG47A
// — a plain string sort would put DIG47 before DIG9 (and DIG5 after DIG49).
function digSortKey(digNumber) {
  const m = String(digNumber || '').match(/^DIG(\d+)(.*)$/i);
  return m ? [parseInt(m[1], 10), m[2] || ''] : [Infinity, String(digNumber || '')];
}
function compareDigNumbers(a, b) {
  const [na, sa] = digSortKey(a);
  const [nb, sb] = digSortKey(b);
  return na !== nb ? na - nb : sa.localeCompare(sb);
}

let cachedCatalog = null;

function loadTemplateCatalog({ refresh = false } = {}) {
  if (cachedCatalog && !refresh) return cachedCatalog;
  const file = findFile(DATA_DIR, /^Claims_Documents_Index.*\.xlsx$/i);
  if (!file) {
    throw new Error(
      `SmartCOMM template catalog not found under "${DATA_DIR}" (expected a Claims_Documents_Index*.xlsx file). ` +
      `Set SMARTCOMM_DATA_DIR in .env to override.`
    );
  }
  const wb = XLSX.readFile(file);
  const sheetName = wb.SheetNames.find(n => /claims document index/i.test(n)) || wb.SheetNames[0];
  const rows = sheetToObjects(wb.Sheets[sheetName], 'Document Name');

  cachedCatalog = rows.map(o => {
    const digNumber = normalizeDig(o['Form Number']);
    const documentName = String(o['Document Name'] || '').trim();
    const templateMappingDoc = o['Template Mapping Document (Word)'];
    // CONFIRMED via live search 2026-09-03 (cloud/dev): the "Select
    // Template" screen's Name search is an exact, case-sensitive match —
    // no substring/prefix matching — and the registered template name is
    // "<DIG#> <Document Name>" (e.g. "DIG52 Contact Letter"), not just the
    // catalog's Document Name column alone. Every row browsed via a blank
    // search follows this same pattern, so it's generic across templates.
    const searchName = `${digNumber} ${documentName}`.trim();
    // The catalog's own "Document Name" text isn't always byte-for-byte what
    // ClaimCenter actually has registered — CONFIRMED live, DIG172B: the
    // catalog says "Followup to 30 day late notice" but the real registered
    // name is "Followup to 30 Day Late Notice" (different casing/spacing),
    // which the exact-match search above silently misses. The template's own
    // local .docx filename encodes that real display name too, with
    // underscores standing in for spaces (e.g.
    // "DIG172B_Followup_to_30_Day_Late_Notice.docx") — a second,
    // independently-sourced name documentService.selectTemplate can fall
    // back to. Only kept when it actually differs from searchName, so a
    // template with no naming drift doesn't get a pointless duplicate search.
    const mappingStem = path.basename(String(templateMappingDoc || '').trim()).replace(/\.[a-zA-Z0-9]+$/, '');
    const searchNameAlt = mappingStem ? mappingStem.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() : '';
    // Only trust the alt name when its own leading DIG number agrees with
    // this catalog row's — the mapping doc column is occasionally just
    // wrong about which template it names entirely (CONFIRMED live: DIG34's
    // row points at a "DIG35_..." file), and a mismatched-DIG alt is never a
    // useful search candidate for THIS row, just a wasted round-trip at best
    // (same defensive check as templateRequirementService's own
    // exactMatchesOwnDig, for the same reason).
    const altMatchesOwnDig = new RegExp('^' + digNumber + '(?:\\s|$)', 'i').test(searchNameAlt);
    return {
      digNumber,
      documentName,
      searchName,
      searchNameAlt: (searchNameAlt && searchNameAlt !== searchName && altMatchesOwnDig) ? searchNameAlt : undefined,
      states: splitList(o['State(s)']),
      lob: splitList(o['LOB']),
      formType: o['Form Type'],
      overlay: o['Overlay'],
      templateMappingDoc,
      notes: o['Notes'],
      sourceFile: file,
    };
  }).sort((a, b) => compareDigNumbers(a.digNumber, b.digNumber));
  return cachedCatalog;
}

function getTemplate(digNumber) {
  const dig = normalizeDig(digNumber);
  return loadTemplateCatalog().find(t => t.digNumber === dig) || null;
}

module.exports = { DATA_DIR, normalizeDig, loadTemplateCatalog, getTemplate };
