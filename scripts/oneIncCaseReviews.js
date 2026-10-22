#!/usr/bin/env node
/**
 * scripts/oneIncCaseReviews.js
 * One Word document (.docx) per OneInc scenario (user request 2026-10-22: Word instead of HTML so the results can be
 * attached in qTest and used elsewhere), from each case's LATEST executed result across all OneInc_*_test.json reports:
 *   case header (story, claim, run, precondition, expected) · test data verified before it ran · every step with its
 *   screenshot · every check (expected / actual / screenshot) · error stack if any.
 * Documents go to <ONEINC_RESULTS_DIR>\Reports\CaseReviews\<id>.docx — self-contained (screenshots embedded), one file
 * per case, so a file can be attached to a qTest test run or a defect as is. index.html in that folder is only a
 * navigation page (filters by story/status, links to the .docx files); it carries no result content.
 *   node scripts/oneIncCaseReviews.js                      (all cases)
 *   node scripts/oneIncCaseReviews.js --only GCCM-763/VBR/TC-013[,id2…]
 * Offline. runOneInc.js regenerates the documents after every run (only cases whose result changed are rewritten).
 */
'use strict';
process.env.CC_ENV = process.env.CC_ENV || 'cloud';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ImageRun, ShadingType, BorderStyle,
  HeadingLevel, AlignmentType, Footer, PageNumber,
} = require('docx');
const { RESULTS_DIR } = require('../helpers/oneInc/reportService');

const safe = (id) => id.replace(/[^A-Za-z0-9_-]+/g, '_');
const COLORS = { PASS: '17692E', FAIL: '9B1C1C', BLOCKED: '8A5A00' };
const FILLS = { PASS: 'E3F6E8', FAIL: 'FDE8E8', BLOCKED: 'FFF3D6' };
const MAX_W = 620; // px at 96 dpi ≈ 6.45 in — fits Letter with 1 in margins
const MAX_H = 760;

// PNG width/height straight from the IHDR chunk (no image library needed).
function pngSize(buf) {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const para = (text, opts = {}) => new Paragraph({ spacing: { after: 80 }, ...opts.p, children: [new TextRun({ text: String(text == null ? '' : text), ...opts.r })] });
const heading = (text, level = HeadingLevel.HEADING_2) => new Paragraph({ heading: level, spacing: { before: 280, after: 100 }, children: [new TextRun({ text, bold: true })] });
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const LINE = { style: BorderStyle.SINGLE, size: 4, color: 'BFC6D0' };
const cell = (children, { w, fill, bold, color } = {}) => new TableCell({
  width: w ? { size: w, type: WidthType.PERCENTAGE } : undefined,
  shading: fill ? { type: ShadingType.CLEAR, fill, color: 'auto' } : undefined,
  margins: { top: 60, bottom: 60, left: 100, right: 100 },
  borders: { top: LINE, bottom: LINE, left: LINE, right: LINE },
  children: (Array.isArray(children) ? children : [children]).map((c) => (typeof c === 'string'
    ? new Paragraph({ children: [new TextRun({ text: c, bold, color })] }) : c)),
});
const kv = (rows) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
  rows: rows.filter(([, v]) => v !== '' && v != null).map(([k, v]) => new TableRow({ children: [cell(k, { w: 20, bold: true, fill: 'F4F6F8' }), cell(String(v), { w: 80 })] })),
});

// Image paragraph scaled to the page (and capped in height); `seen` de-duplicates identical screenshots within one
// document (a check's screenshot is usually the very screen the preceding step captured).
function image(file, seen, label) {
  if (!file) return [];
  if (!fs.existsSync(file)) return [para('(screenshot missing)', { r: { italics: true, color: '667085' } })];
  const buf = fs.readFileSync(file);
  const hash = crypto.createHash('md5').update(buf).digest('hex');
  if (seen.has(hash)) return [para(`Screenshot: same screen as ${seen.get(hash)}.`, { r: { italics: true, color: '667085' } })];
  seen.set(hash, label);
  const sz = pngSize(buf) || { w: 1600, h: 1000 };
  let w = Math.min(MAX_W, sz.w), h = Math.round(sz.h * (w / sz.w));
  if (h > MAX_H) { h = MAX_H; w = Math.round(sz.w * (h / sz.h)); }
  return [new Paragraph({ spacing: { before: 60, after: 160 }, children: [new ImageRun({ type: 'png', data: buf, transformation: { width: w, height: h }, altText: { title: label, description: label, name: label } })] })];
}

async function build(r, runId) {
  const seen = new Map();
  const kids = [];
  kids.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: r.scenarioId, bold: true, size: 36 }), new TextRun({ text: `   ${r.status}`, bold: true, size: 30, color: COLORS[r.status] })] }));
  kids.push(para(r.name, { r: { color: '667085' } }));
  kids.push(kv([
    ['Story', `${r.story} — ${r.storyTitle || ''}`], ['Claim', `${r.claim || '—'}${r.loginUsed ? ` · login ${r.loginUsed}` : ''}`],
    ['Run', `${runId} · ${r.startedAt || ''} · ${Math.round((r.durationMs || 0) / 1000)}s`],
    ['Precondition', r.precondition], ['Expected', r.expected], [r.status === 'PASS' ? 'Note' : 'Reason', r.reason], ['Automation note', r.notes],
  ]));
  kids.push(heading('Test data verified before the case ran'));
  if ((r.testData || []).length) (r.testData).forEach((d) => kids.push(para(`${d.ok ? '[OK]' : '[MISSING]'} ${d.label}${d.ok ? '' : ` — ${d.problem}`}`, { r: { color: d.ok ? '17692E' : '9B1C1C' } })));
  else kids.push(para('Not recorded for this run (it ran before the test-data check existed, or the profile declares no data).', { r: { italics: true, color: '667085' } }));

  const shots = r.stepShots || [];
  kids.push(heading(`Steps${shots.length ? ' (screenshot after each)' : ''}`));
  if (!(r.stepsExecuted || []).length) kids.push(para('No steps recorded.', { r: { italics: true } }));
  (r.stepsExecuted || []).forEach((s, i) => {
    kids.push(new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 160, after: 40 }, keepNext: true, children: [new TextRun({ text: `Step ${i + 1}`, bold: true })] }));
    kids.push(para(s, { p: { keepNext: true } }));
    kids.push(...image(shots[i], seen, `step ${i + 1}`));
  });

  kids.push(heading('Checks'));
  if (!(r.checks || []).length) kids.push(para('No checks recorded.', { r: { italics: true } }));
  (r.checks || []).forEach((c, i) => {
    kids.push(new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 160, after: 40 }, keepNext: true, children: [new TextRun({ text: `Check ${i + 1}  `, bold: true }), new TextRun({ text: c.result, bold: true, color: COLORS[c.result] })] }));
    kids.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [['Check', c.description], ['Expected', c.expected], ['Actual', `${c.actual}${c.missing && c.result === 'FAIL' ? '  (possible pending development)' : ''}`]]
        .map(([k, v]) => new TableRow({ children: [cell(k, { w: 18, bold: true, fill: 'F4F6F8' }), cell(String(v == null ? '' : v), { w: 82, fill: k === 'Actual' ? FILLS[c.result] : undefined })] })),
    }));
    kids.push(...image(c.screenshot, seen, `check ${i + 1}`));
  });

  // Older runs (before step screenshots existed): the evidence screenshots that exist, not already shown.
  const shown = new Set([...shots, ...(r.checks || []).map((c) => c.screenshot)].filter(Boolean));
  const extra = (r.evidence || []).filter((p) => /\.png$/i.test(p) && !shown.has(p));
  if (extra.length) {
    kids.push(heading('Other screenshots'));
    extra.forEach((p) => { kids.push(para(path.basename(p, '.png'), { r: { bold: true } })); kids.push(...image(p, seen, path.basename(p, '.png'))); });
  }
  if (r.error) { kids.push(heading('Error')); kids.push(para(r.stack || r.error, { r: { font: 'Consolas', size: 18 } })); }
  kids.push(para(`Source: Reports\\${runId}.html (run report) · generated ${new Date().toISOString()}`, { r: { color: '667085', size: 18 } }));

  const doc = new Document({
    creator: 'OneInc automation', title: `${r.scenarioId} — ${r.status}`, description: r.name,
    styles: { default: { document: { run: { font: 'Calibri', size: 21 } } } },
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${r.scenarioId} · ${r.status} · page `, size: 16, color: '667085' }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '667085' })] })] }) },
      children: kids,
    }],
  });
  return Packer.toBuffer(doc);
}

async function run({ only = null, log = console.log } = {}) {
  const repDir = path.join(RESULTS_DIR, 'Reports');
  const outDir = path.join(repDir, 'CaseReviews');
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.readdirSync(repDir).filter((f) => /^OneInc_\d{8}_\d{6}_test\.json$/.test(f)).sort();
  const last = {};
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(repDir, f), 'utf8')); } catch (_) { continue; }
    for (const r of j.results || []) if (['PASS', 'FAIL', 'BLOCKED'].includes(r.status)) last[r.scenarioId] = { r, runId: j.run && j.run.runId };
  }
  // The HTML pages this replaces (and the old phone copies) — removed so nobody opens a stale one.
  for (const f of fs.readdirSync(outDir)) if (/\.html$/i.test(f) && f !== 'index.html') fs.unlinkSync(path.join(outDir, f));

  const ids = Object.keys(last).filter((id) => !only || only.includes(id)).sort();
  const stamp = path.join(outDir, '.built.json');
  let built = {};
  try { built = JSON.parse(fs.readFileSync(stamp, 'utf8')); } catch (_) { /* first run */ }
  let wrote = 0;
  for (const id of ids) {
    const { r, runId } = last[id];
    const file = path.join(outDir, `${safe(id)}.docx`);
    // Skip a case whose latest result is the one already written (same run + same finish time) — only new results cost time.
    const key = `${runId}|${r.finishedAt || ''}`;
    if (!only && built[id] === key && fs.existsSync(file)) continue;
    try { fs.writeFileSync(file, await build(r, runId)); built[id] = key; wrote++; } catch (e) { log(`[CaseReviews] ${id}: ${e.message}`); }
  }
  fs.writeFileSync(stamp, JSON.stringify(built));

  // Navigation page (no result content).
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const all = Object.keys(last).sort();
  const stories = [...new Set(all.map((id) => last[id].r.story))].sort();
  const index = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OneInc case documents</title>
<style>body{font:15px/1.5 Segoe UI,Arial,sans-serif;margin:16px auto;max-width:1000px;padding:0 12px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}.p{font-size:12px;padding:1px 8px;border-radius:10px;font-weight:600}.PASS{background:#e3f6e8;color:#17692e}.FAIL{background:#fde8e8;color:#9b1c1c}.BLOCKED{background:#fff3d6;color:#8a5a00}.m{color:#667}</style></head><body>
<h1>OneInc — case documents (Word)</h1><p class="m">Latest executed result per case (${all.length}), generated ${new Date().toISOString()}. Each link downloads a self-contained .docx (steps, screenshots, checks) that can be attached in qTest.</p>
<p><select id="st"><option value="">All stories</option>${stories.map((s) => `<option>${esc(s)}</option>`).join('')}</select> <select id="ss"><option value="">All statuses</option><option>PASS</option><option>FAIL</option><option>BLOCKED</option></select> <input id="q" placeholder="search id / name"></p>
<table><tr><th>Case</th><th>Status</th><th>Name</th><th>Claim</th><th>Run</th></tr>
${all.map((id) => { const { r, runId } = last[id]; return `<tr data-s="${esc(r.story)}" data-t="${esc(r.status)}"><td><a href="${esc(safe(id))}.docx">${esc(id)}</a></td><td><span class="p ${esc(r.status)}">${esc(r.status)}</span></td><td>${esc(r.name)}</td><td>${esc(r.claim || '')}</td><td class="m">${esc(runId)}</td></tr>`; }).join('')}
</table><script>const f=()=>{const s=st.value,t=ss.value,q=document.getElementById('q').value.toLowerCase();document.querySelectorAll('tr[data-s]').forEach(r=>{r.hidden=(s&&r.dataset.s!==s)||(t&&r.dataset.t!==t)||(q&&!r.innerText.toLowerCase().includes(q))})};[st,ss,document.getElementById('q')].forEach(e=>e.addEventListener('input',f));</script></body></html>`;
  fs.writeFileSync(path.join(outDir, 'index.html'), index);
  log(`[CaseReviews] ${wrote} Word document(s) written, ${all.length} cases → ${outDir}`);
  return { dir: outDir, wrote, total: all.length };
}

// Kept for runOneInc.js (build({ log })).
module.exports = { build: (opts) => run(opts), buildOne: build };
if (require.main === module) {
  const i = process.argv.indexOf('--only');
  run({ only: i > 0 ? process.argv[i + 1].split(',') : null }).catch((e) => { console.error('[CaseReviews]', e.stack || e.message); process.exit(1); });
}
