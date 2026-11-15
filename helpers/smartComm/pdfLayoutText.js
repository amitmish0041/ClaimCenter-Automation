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

// The page's text row by row with every drawn fill-in line (a horizontal stroke or hairline rectangle on or just under a
// text row) written in as "____" where it sits. Forms draw their blanks as graphics ("Signature of Employer
// Representative" + a stroked line — DIG214, DIG47A "FROM: THROUGH:", DIG109, 2026-11-15); the text layer alone shows no blank.
// pdf.js operator codes (stable across the versions pdf-parse bundles).
const OPS = { save: 10, restore: 11, transform: 12, moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17, rectangle: 19, constructPath: 91 };
async function extractBlankLineText(pdfPath) {
  if (!pdfParse || !pdfPath || !fs.existsSync(pdfPath)) return '';
  const out = [];
  // pdf.js 2.0 directly, fonts off: pdf-parse's default 1.10 build loads fonts for getOperatorList and crashes on `document`.
  let pdfjs;
  try { pdfjs = require('pdf-parse/lib/pdf.js/v2.0.550/build/pdf.js'); } catch (_) { return ''; }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), disableFontFace: true });
  for (let pn = 1; pn <= doc.numPages; pn++) {
    {
      const pageData = await doc.getPage(pn);
      const tc = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }));
      const segs = [];
      try {
        const ops = await pageData.getOperatorList();
        let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
        const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
        const tp = (px, py) => [ctm[0] * px + ctm[2] * py + ctm[4], ctm[1] * px + ctm[3] * py + ctm[5]];
        const add = (xa, xb, y) => { if (Math.abs(xb - xa) > 15) segs.push({ x: Math.min(xa, xb), xEnd: Math.max(xa, xb), y }); };
        ops.fnArray.forEach((fn, k) => {
          const a = ops.argsArray[k];
          if (fn === OPS.save) stack.push(ctm);
          else if (fn === OPS.restore) ctm = stack.pop() || ctm;
          else if (fn === OPS.transform) ctm = mul(ctm, a);
          else if (fn === OPS.constructPath) {
            let ai = 0; let cur = null;
            for (const op of a[0]) {
              if (op === OPS.moveTo) { cur = tp(a[1][ai], a[1][ai + 1]); ai += 2; } else if (op === OPS.lineTo) {
                const n = tp(a[1][ai], a[1][ai + 1]); ai += 2;
                if (cur && Math.abs(n[1] - cur[1]) < 1) add(cur[0], n[0], n[1]);
                cur = n;
              } else if (op === OPS.rectangle) {
                const [rx, ry, w, h] = a[1].slice(ai, ai + 4); ai += 4;
                const p0 = tp(rx, ry); const p1 = tp(rx + w, ry + h);
                if (Math.abs(p1[1] - p0[1]) < 2.5) add(p0[0], p1[0], Math.min(p0[1], p1[1]));
              } else if (op === OPS.curveTo) ai += 6; else if (op === OPS.curveTo2 || op === OPS.curveTo3) ai += 4;
            }
          }
        });
      } catch (_) { /* no operator list: text only */ }
      // A line counts for the text row whose baseline it sits on or just under (0–8 pt), and only where no text covers it
      // (an underlined heading or a table border with words on it is not a blank).
      const rows = [];
      for (const it of items.sort((a, b) => b.y - a.y || a.x - b.x)) {
        const row = rows.find((r) => Math.abs(r.y - it.y) <= 2.5);
        if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
      }
      const seen = new Set();
      for (const s of segs) {
        const key = `${Math.round(s.x)}|${Math.round(s.xEnd)}|${Math.round(s.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row = rows.find((r) => r.y - s.y >= -1 && r.y - s.y <= 8);
        if (!row || row.items.some((it) => it.x < s.xEnd - 4 && it.x + it.w > s.x + 4)) continue;
        row.items.push({ str: '____', x: s.x, y: row.y, w: s.xEnd - s.x });
      }
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        out.push(r.items.map((it) => it.str).join(' ').replace(/(?:_{4}\s*)+/g, '____ ').trim());
      }
    }
  }
  doc.destroy();
  return out.join('\n');
}

module.exports = { extractLayoutText, extractPositionedItems, extractBlankLineText };
