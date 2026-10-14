/**
 * helpers/smartComm/layoutValidationService.js
 * Layout checks between a template's Word mapping doc and the generated PDF — defects the text-content checks
 * can't see, taken from real Jira bugs: the date of letter printed with the wrong alignment (SMART-1240,
 * SMART-1250), a paragraph run into the preceding text instead of starting its own line (SMART-1343), and the
 * RE block's labels printed in a different order than the mapping doc (SMART-1245).
 *
 * Uses real text positions from the PDF (pdf-parse's per-page hook exposes pdf.js text items with x/y) and the
 * Word paragraphs' own alignment (<w:jc>, or the paragraph style's). Deliberately narrow, to stay low-noise:
 *   LAYOUT1 alignment     — only paragraphs the mapping doc explicitly right-aligns or centres, plus the date line.
 *   LAYOUT2 paragraph breaks — only fully-static body paragraphs of 8+ words, by their first words.
 *   LAYOUT3 header order  — only the short "Label:" lines above the salutation, each printed exactly once.
 * Anything that can't be located confidently is left out rather than guessed at.
 */
'use strict';
const fs = require('fs');
const AdmZip = require('adm-zip');
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch (_) { /* reported by the caller's own PDF text extraction */ }

const DATE_RE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b/;
const words = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").split(/[^a-z0-9]+/).filter(Boolean);

// ── PDF: positioned line segments ────────────────────────────────────────────────────────────────────
// Items on (nearly) the same baseline form a line; a horizontal gap of 30pt+ splits it into separate segments,
// so a left-hand address and a right-hand date that happen to share a baseline aren't read as one wide line.
async function readPdfSegments(pdfPath) {
  if (!pdfParse) throw new Error('pdf-parse is not installed');
  const pages = [];
  await pdfParse(fs.readFileSync(pdfPath), {
    pagerender: async (pageData) => {
      const vp = pageData.getViewport(1.0);
      const tc = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      const items = tc.items
        .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }))
        .filter((it) => it.str && it.str.trim());
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const rows = [];
      for (const it of items) {
        const row = rows.find((r) => Math.abs(r.y - it.y) <= 2.5);
        if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
      }
      const segments = [];
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        let cur = null;
        for (const it of r.items) {
          if (cur && it.x - cur.xEnd > 30) { segments.push(cur); cur = null; }
          if (!cur) cur = { page: pages.length + 1, y: r.y, xStart: it.x, xEnd: it.x + it.w, text: it.str };
          else { cur.text += (it.x - cur.xEnd > 1 ? ' ' : '') + it.str; cur.xEnd = Math.max(cur.xEnd, it.x + it.w); }
        }
        if (cur) segments.push(cur);
      }
      segments.sort((a, b) => b.y - a.y || a.xStart - b.xStart);
      pages.push({ width: vp.width, height: vp.height, segments });
      return '';
    },
  });
  // Text block edges per page: the most common left edge, and where full-width body lines end.
  for (const p of pages) {
    const lefts = {};
    for (const s of p.segments) { const k = Math.round(s.xStart); lefts[k] = (lefts[k] || 0) + 1; }
    p.left = Number(Object.entries(lefts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 54);
    const wide = p.segments.filter((s) => s.xEnd - s.xStart > p.width * 0.45).map((s) => s.xEnd).sort((a, b) => a - b);
    p.right = wide.length ? wide[Math.floor(wide.length * 0.9)] : p.width - p.left;
  }
  return pages;
}

function alignmentOf(seg, page) {
  const span = page.right - page.left;
  if (Math.abs(seg.xEnd - page.right) <= 14 && seg.xStart > page.left + span * 0.3) return 'right';
  if (Math.abs((seg.xStart + seg.xEnd) / 2 - (page.left + page.right) / 2) <= 16 && seg.xStart > page.left + 20) return 'center';
  if (Math.abs(seg.xStart - page.left) <= 14) return 'left';
  return 'indented';
}

// ── Word: paragraphs with their alignment ────────────────────────────────────────────────────────────
function readDocxParagraphs(docxPath) {
  const zip = new AdmZip(docxPath);
  const xml = zip.readAsText('word/document.xml');
  const stylesXml = zip.getEntry('word/styles.xml') ? zip.readAsText('word/styles.xml') : '';
  const styleJc = {};
  const styleBase = {};
  for (const m of stylesXml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const jc = m[2].match(/<w:pPr>[\s\S]*?<w:jc w:val="([^"]+)"/);
    if (jc) styleJc[m[1]] = jc[1];
    const based = m[2].match(/<w:basedOn w:val="([^"]+)"/);
    if (based) styleBase[m[1]] = based[1];
  }
  const jcOfStyle = (id) => { for (let i = 0; id && i < 10; i++, id = styleBase[id]) if (styleJc[id]) return styleJc[id]; return null; };
  const ranges = (re) => Array.from(xml.matchAll(re)).map((m) => [m.index, m.index + m[0].length]);
  const tables = ranges(/<w:tbl>[\s\S]*?<\/w:tbl>/g);
  const boxes = ranges(/<w:txbxContent>[\s\S]*?<\/w:txbxContent>/g);
  const inside = (rs, i) => rs.some(([a, b]) => i >= a && i < b);
  const out = [];
  for (const m of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const body = m[1];
    if (/<w:p\b/.test(body)) continue; // a paragraph wrapping a text box — its inner paragraphs are read on their own
    const pPr = (body.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
    const jc = (pPr.match(/<w:jc w:val="([^"]+)"/) || [])[1] || jcOfStyle((pPr.match(/<w:pStyle w:val="([^"]+)"/) || [])[1]) || 'left';
    const align = /^(right|end)$/.test(jc) ? 'right' : jc === 'center' ? 'center' : 'left';
    const text = body.replace(/<w:tab\/>/g, ' ').replace(/<w:br\/>/g, ' ').replace(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<[^>]+>/g, (all, t) => (t !== undefined ? t : ''))
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({ text, align, inTable: inside(tables, m.index), inTextbox: inside(boxes, m.index), order: out.length });
  }
  return out;
}

// Finds `want` (array of words) as consecutive words in a segment; returns { seg, atStart, before } or null.
function locateWords(pages, want, { pageLimit = Infinity } = {}) {
  const hits = [];
  for (const p of pages.slice(0, pageLimit)) {
    for (const seg of p.segments) {
      const w = words(seg.text);
      for (let i = 0; i + want.length <= w.length; i++) {
        if (want.every((x, k) => w[i + k] === x)) hits.push({ seg, page: p, atStart: i === 0, before: w.slice(0, i) });
      }
    }
  }
  return hits;
}

const LIST_MARKER = /^(?:\d{1,2}|[a-z]|[ivx]{1,4})$/; // "1.", "a)", "iv." — a list marker before a paragraph isn't a run-on

async function checkLayout({ docxPath, pdfPath, requirements = [], validations = [] }) {
  if (!docxPath || !pdfPath || !fs.existsSync(docxPath) || !fs.existsSync(pdfPath) || !/\.docx$/i.test(docxPath)) return [];
  const pages = await readPdfSegments(pdfPath);
  const paras = readDocxParagraphs(docxPath);
  const checks = [];
  const salutationIdx = paras.findIndex((p) => /^dear\b/i.test(p.text));
  const headerParas = salutationIdx === -1 ? paras.slice(0, 15) : paras.slice(0, salutationIdx);

  // LAYOUT1 — alignment.
  const alignProblems = [];
  let alignChecked = 0;
  const dateLine = headerParas.find((p) => !p.inTable && !p.inTextbox && DATE_RE.test(p.text) && words(p.text).length <= 4);
  if (dateLine) {
    const page = pages[0];
    const seg = page && page.segments.find((s) => DATE_RE.test(s.text) && words(s.text).length <= 4);
    if (seg) {
      alignChecked++;
      const got = alignmentOf(seg, page);
      if (got !== dateLine.align) alignProblems.push(`Date of letter "${seg.text.trim()}" prints ${got}-aligned, but the mapping doc has it ${dateLine.align}-aligned`);
    }
  }
  for (const p of paras) {
    if (p === dateLine || p.inTable || p.inTextbox || p.align === 'left') continue;
    const want = words(p.text);
    if (want.length < 2 || DATE_RE.test(p.text)) continue;
    const hits = locateWords(pages, want);
    if (hits.length !== 1 || words(hits[0].seg.text).length !== want.length) continue; // only a confident, whole-line match
    const got = alignmentOf(hits[0].seg, hits[0].page);
    // "indented" = somewhere in between (e.g. centred inside a signature-block column rather than the page) —
    // inconclusive for these, so not counted; only a clear left/right/centre disagreement is reported.
    if (got === 'indented') continue;
    alignChecked++;
    if (got !== p.align) alignProblems.push(`"${p.text.slice(0, 60)}" prints ${got}-aligned, but the mapping doc has it ${p.align}-aligned`);
  }
  if (alignChecked) {
    checks.push(alignProblems.length
      ? { id: 'LAYOUT1', description: 'Alignment matches the mapping doc (date line, right-aligned/centred text)', expected: 'Same alignment as the mapping doc', actual: alignProblems.join(' | '), result: 'FAIL', reason: `${alignProblems.length} of ${alignChecked} aligned line(s) print differently from the mapping doc (same kind of defect as Jira SMART-1240/SMART-1250).` }
      : { id: 'LAYOUT1', description: 'Alignment matches the mapping doc (date line, right-aligned/centred text)', expected: 'Same alignment as the mapping doc', actual: `${alignChecked} line(s) checked, all aligned as mapped`, result: 'PASS' });
  }

  // LAYOUT2 — every fully-static body paragraph (8+ words) starts its own line.
  const passedStatic = new Set(validations.filter((v) => v.result === 'PASS').map((v) => v.id));
  const staticTexts = requirements.filter((r) => r.type === 'requiredText' && passedStatic.has(r.id) && r.expectedValue).map((r) => words(r.expectedValue).join(' '));
  const runOns = [];
  let breaksChecked = 0;
  for (const p of paras) {
    if (p.inTable || p.inTextbox || p.align !== 'left') continue;
    const w = words(p.text);
    if (w.length < 8) continue;
    const joined = w.join(' ');
    if (!staticTexts.some((s) => s.startsWith(w.slice(0, 6).join(' ')) || joined.startsWith(s) && s.split(' ').length >= 6)) continue;
    const hits = locateWords(pages, w.slice(0, 4));
    if (!hits.length) continue;
    breaksChecked++;
    if (hits.some((h) => h.atStart || (h.before.length === 1 && LIST_MARKER.test(h.before[0])))) continue;
    const h = hits[0];
    runOns.push(`"${p.text.slice(0, 50)}…" runs on after "${h.seg.text.slice(0, Math.max(0, h.seg.text.toLowerCase().indexOf(w[0]))).trim().slice(-50)}" on the same line`);
  }
  if (breaksChecked) {
    checks.push(runOns.length
      ? { id: 'LAYOUT2', description: 'Each paragraph starts on its own line (not merged into the text before it)', expected: 'Paragraph breaks as in the mapping doc', actual: runOns.join(' | '), result: 'FAIL', reason: `${runOns.length} paragraph(s) are printed run-on with the preceding text instead of as their own paragraph (same kind of defect as Jira SMART-1343).` }
      : { id: 'LAYOUT2', description: 'Each paragraph starts on its own line (not merged into the text before it)', expected: 'Paragraph breaks as in the mapping doc', actual: `${breaksChecked} paragraph(s) checked, all start their own line`, result: 'PASS' });
  }

  // LAYOUT3 — header labels ("Claim No.:", "Insured:", "Date of Loss:") print in the mapping doc's order.
  const labels = [];
  for (const p of headerParas) {
    for (const m of p.text.matchAll(/(?:^|\s)((?:[A-Za-z][A-Za-z./']*\s){0,3}[A-Za-z][A-Za-z./']*):/g)) {
      const w = words(m[1]);
      if (!w.length || w.length > 4 || /^re$/.test(w.join(' '))) continue;
      if (labels.some((l) => l.key === w.join(' '))) continue;
      const hits = locateWords(pages, w, { pageLimit: 1 });
      if (hits.length !== 1) continue;
      labels.push({ key: w.join(' '), label: m[1], order: labels.length, y: hits[0].seg.y, x: hits[0].seg.xStart });
    }
  }
  if (labels.length >= 2) {
    const printed = [...labels].sort((a, b) => b.y - a.y || a.x - b.x);
    const swapped = labels.filter((l, i) => printed[i] !== l);
    checks.push(swapped.length
      ? { id: 'LAYOUT3', description: 'Header labels print in the mapping doc\'s order', expected: labels.map((l) => l.label).join(' → '), actual: printed.map((l) => l.label).join(' → '), result: 'FAIL', reason: 'The header lines are printed in a different order than the mapping doc lists them (same kind of defect as Jira SMART-1245).' }
      : { id: 'LAYOUT3', description: 'Header labels print in the mapping doc\'s order', expected: labels.map((l) => l.label).join(' → '), actual: printed.map((l) => l.label).join(' → '), result: 'PASS' });
  }
  return checks;
}

module.exports = { checkLayout, readPdfSegments, readDocxParagraphs };
