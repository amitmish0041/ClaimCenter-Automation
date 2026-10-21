/**
 * helpers/smartComm/pdfLayoutText.js
 * A second, layout-aware reading of a generated PDF for forms laid out in boxes / columns.
 *
 * pdf-parse's plain text reads straight across each line of the page, so on a form like DIG49 (Application for
 * Benefits) side-by-side boxes run together ("11. AMOUNT OF HEALTH BILLSWILL YOU HAVE MORE HEALTH…") and a
 * question that wraps inside its own box is split by its neighbours' text ("…BILLS" … "TO DATE:"). CONFIRMED
 * 2026-10-15: that made correctly printed questions fail as "Not Found".
 *
 * This rebuilds the text from the positioned text items:
 *   1. items on one line separated by a visible gap become separate pieces (a space, or a new block for a wide gap);
 *   2. pieces that start at the same x on consecutive lines (one box/column) are joined into one block.
 * The result (one block per line) is only used as a fallback haystack when a check fails on the normal text.
 */
'use strict';
const fs = require('fs');
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch (_) { pdfParse = null; }

const BLOCK_GAP = 8;   // pt: a gap this wide between items on one line starts a new box/column piece
const WORD_GAP = 1;    // pt: any visible gap inside a piece gets a space
const SAME_X = 4;      // pt: pieces whose left edges agree this closely belong to the same box/column
const LINE_STEP = 20;  // pt: lines closer than this (vertically) are consecutive lines of one box (DIG49 form lines are 16-17pt apart)

async function extractLayoutText(pdfPath) {
  if (!pdfParse || !pdfPath || !fs.existsSync(pdfPath)) return '';
  const out = [];
  await pdfParse(fs.readFileSync(pdfPath), {
    pagerender: async (pageData) => {
      const tc = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      const items = tc.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }))
        .filter((it) => it.str && it.str.trim());
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const rows = [];
      for (const it of items) {
        const row = rows.find((r) => Math.abs(r.y - it.y) <= 2.5);
        if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
      }
      const pieces = [];
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        let cur = null;
        for (const it of r.items) {
          if (cur && it.x - cur.xEnd > BLOCK_GAP) { pieces.push(cur); cur = null; }
          if (!cur) cur = { y: r.y, x: it.x, xEnd: it.x + it.w, text: it.str };
          else { cur.text += (it.x - cur.xEnd > WORD_GAP ? ' ' : '') + it.str; cur.xEnd = Math.max(cur.xEnd, it.x + it.w); }
        }
        if (cur) pieces.push(cur);
      }
      // Join each piece with the piece directly below it in the same column (same left edge, next line).
      const used = new Set();
      pieces.sort((a, b) => b.y - a.y || a.x - b.x);
      for (let i = 0; i < pieces.length; i++) {
        if (used.has(i)) continue;
        let text = pieces[i].text.trim(); let last = pieces[i];
        used.add(i);
        for (let j = i + 1; j < pieces.length; j++) {
          const p = pieces[j];
          if (used.has(j)) continue;
          if (last.y - p.y > LINE_STEP) break; // pieces are sorted by y: nothing further down can be the next line
          if (last.y - p.y > 2.5 && Math.abs(p.x - last.x) <= SAME_X) { text += ` ${p.text.trim()}`; used.add(j); last = p; }
        }
        out.push(text);
      }
      return '';
    },
  });
  return out.join('\n');
}

// Every text item with its position, page by page: [{ viewW, viewH, items: [{ str, x, y, w }] }] in PDF points, y up
// from the bottom (baseline). For checks that need to know WHERE something printed — an "X" typed into one checkbox
// of an overlay form (DIG220) is the same "X" as every other box's, only its position says which box it belongs to.
async function extractPositionedItems(pdfPath) {
  if (!pdfParse || !pdfPath || !fs.existsSync(pdfPath)) return [];
  const pages = [];
  await pdfParse(fs.readFileSync(pdfPath), {
    pagerender: async (pageData) => {
      const tc = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      const [x0, y0, x1, y1] = pageData.view || [0, 0, 612, 792];
      const idx = typeof pageData.pageIndex === 'number' ? pageData.pageIndex : pageData.pageNumber - 1;
      pages[idx >= 0 ? idx : pages.length] = {
        viewW: x1 - x0, viewH: y1 - y0,
        items: tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ str: it.str, x: it.transform[4] - x0, y: it.transform[5] - y0, w: it.width || 0 })),
      };
      return '';
    },
  });
  return pages.map((p) => p || { viewW: 612, viewH: 792, items: [] });
}

module.exports = { extractLayoutText, extractPositionedItems };
