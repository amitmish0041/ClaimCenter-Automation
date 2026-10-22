#!/usr/bin/env node
/**
 * scripts/oneIncCaseReviews.js
 * One review page per OneInc scenario (user request 2026-10-22: "the test result document … available on V: for all
 * scenarios"), from each case's LATEST executed result across all OneInc_*_test.json reports:
 *   case header (story, claim, run, precondition, expected) · test data verified before it ran · every step with its
 *   screenshot · every check (expected / actual / screenshot) · error stack if any.
 * Pages go to <ONEINC_RESULTS_DIR>\Reports\CaseReviews\<id>.html (+ index.html with filters by story / status).
 * Images are linked (relative to the share), not embedded — open from V: on a desktop. Pass --embed <id> to write one
 * self-contained page (screenshots inlined) for a phone.
 *   node scripts/oneIncCaseReviews.js            (all cases)
 *   node scripts/oneIncCaseReviews.js --embed GCCM-763/VBR/TC-013
 * Offline. runOneInc.js regenerates the pages after every run.
 */
'use strict';
process.env.CC_ENV = process.env.CC_ENV || 'cloud';
const fs = require('fs');
const path = require('path');
const { RESULTS_DIR } = require('../helpers/oneInc/reportService');

function build({ embed = null, log = console.log } = {}) {
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
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const safe = (id) => id.replace(/[^A-Za-z0-9_-]+/g, '_');
  const img = (p, inline) => {
    if (!p) return '';
    if (!fs.existsSync(p)) return '<p class="m">(screenshot missing)</p>';
    const src = inline ? `data:image/png;base64,${fs.readFileSync(p).toString('base64')}` : path.relative(outDir, p).split(path.sep).join('/');
    return inline ? `<img src="${src}" alt="">` : `<a href="${esc(src)}" target="_blank"><img src="${esc(src)}" alt="" loading="lazy"></a>`;
  };
  const pill = (s) => `<span class="p ${esc(String(s).replace(' ', '-'))}">${esc(s)}</span>`;
  const CSS = `:root{--bg:#fff;--fg:#1d2330;--m:#667;--card:#f5f7fa;--line:#dde2ea}@media(prefers-color-scheme:dark){:root{--bg:#121417;--fg:#e8eaed;--m:#9aa0a6;--card:#1c1f24;--line:#2c3138}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,Segoe UI,Arial,sans-serif;margin:0 auto;padding:16px;max-width:1000px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:17px;margin:24px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:15px;margin:0 0 4px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:10px 0}img{width:100%;height:auto;border:1px solid var(--line);border-radius:6px;margin-top:8px}
.m{color:var(--m)}.p{font-size:12px;padding:1px 8px;border-radius:10px;font-weight:600}.PASS{background:#e3f6e8;color:#17692e}.FAIL{background:#fde8e8;color:#9b1c1c}.BLOCKED{background:#fff3d6;color:#8a5a00}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0}dt{color:var(--m)}dd{margin:0}pre{white-space:pre-wrap;font-size:12px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px;text-align:left;vertical-align:top}a{color:#2f6fd6}`;

  const page = (r, runId, inline) => {
    const stepShots = r.stepShots || [];
    const steps = (r.stepsExecuted || []).map((s, i) => `<section><h3>Step ${i + 1}</h3><p>${esc(s)}</p>${img(stepShots[i], inline)}</section>`).join('');
    const checks = (r.checks || []).map((c, i) => `<section><h3>Check ${i + 1} ${pill(c.result)}</h3><p><b>${esc(c.description)}</b></p><p class="m">Expected: ${esc(c.expected)}</p><p>Actual: ${esc(c.actual)}${c.missing && c.result === 'FAIL' ? ' <i>(possible pending development)</i>' : ''}</p>${img(c.screenshot, inline)}</section>`).join('');
    // Older runs (before step screenshots): show the evidence screenshots that exist.
    const usedShots = new Set([...stepShots, ...(r.checks || []).map((c) => c.screenshot)].filter(Boolean));
    const extra = (r.evidence || []).filter((p) => /\.png$/i.test(p) && !usedShots.has(p)).map((p) => `<section><h3>${esc(path.basename(p, '.png'))}</h3>${img(p, inline)}</section>`).join('');
    const data = (r.testData || []).map((d) => `<li>${d.ok ? '✅' : '❌'} ${esc(d.label)}${d.ok ? '' : ` — ${esc(d.problem)}`}</li>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.scenarioId)}</title><style>${CSS}</style></head><body>
<p class="m"><a href="index.html">← all cases</a></p>
<h1>${esc(r.scenarioId)} ${pill(r.status)}</h1><p class="m">${esc(r.name)}</p>
<section><dl><dt>Story</dt><dd>${esc(r.story)} — ${esc(r.storyTitle)}</dd><dt>Claim</dt><dd>${esc(r.claim || '—')}${r.loginUsed ? ` · login ${esc(r.loginUsed)}` : ''}</dd>
<dt>Run</dt><dd>${esc(runId)} · ${esc(r.startedAt || '')} · ${((r.durationMs || 0) / 1000).toFixed(0)}s</dd><dt>Precondition</dt><dd>${esc(r.precondition)}</dd><dt>Expected</dt><dd>${esc(r.expected)}</dd>
${r.reason ? `<dt>${r.status === 'PASS' ? 'Note' : 'Reason'}</dt><dd>${esc(r.reason)}</dd>` : ''}${r.notes ? `<dt>Automation note</dt><dd>${esc(r.notes)}</dd>` : ''}</dl></section>
<h2>Test data verified before the case ran</h2><section>${data ? `<ul>${data}</ul>` : '<p class="m">Not recorded for this run (ran before the test-data check existed, or the profile declares no data).</p>'}</section>
<h2>Steps${stepShots.length ? ' (screenshot after each)' : ''}</h2>${steps || '<p class="m">No steps recorded.</p>'}
<h2>Checks</h2>${checks || '<p class="m">No checks recorded.</p>'}${extra ? `<h2>Other screenshots</h2>${extra}` : ''}
${r.error ? `<h2>Error</h2><section><pre>${esc(r.stack || r.error)}</pre></section>` : ''}
<p class="m">Source: Reports\\${esc(runId)}.html</p></body></html>`;
  };

  if (embed) {
    const hit = last[embed];
    if (!hit) throw new Error(`no executed result for ${embed}`);
    const f = path.join(outDir, `${safe(embed)}_phone.html`);
    fs.writeFileSync(f, page(hit.r, hit.runId, true));
    log(`[CaseReviews] ${f}`);
    return f;
  }
  const rows = [];
  for (const [id, { r, runId }] of Object.entries(last)) {
    fs.writeFileSync(path.join(outDir, `${safe(id)}.html`), page(r, runId, false));
    rows.push({ id, r, runId, file: `${safe(id)}.html` });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const stories = [...new Set(rows.map((x) => x.r.story))].sort();
  const index = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OneInc case reviews</title><style>${CSS}</style></head><body>
<h1>OneInc — case reviews</h1><p class="m">Latest executed result per case (${rows.length} cases), generated ${new Date().toISOString()}. Each page: test data verified, every step with its screenshot, every check.</p>
<p><select id="st"><option value="">All stories</option>${stories.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
<select id="ss"><option value="">All statuses</option><option>PASS</option><option>FAIL</option><option>BLOCKED</option></select> <input id="q" placeholder="search id / name"></p>
<table><tr><th>Case</th><th>Status</th><th>Name</th><th>Claim</th><th>Run</th></tr>
${rows.map((x) => `<tr data-s="${esc(x.r.story)}" data-t="${esc(x.r.status)}"><td><a href="${esc(x.file)}">${esc(x.id)}</a></td><td>${pill(x.r.status)}</td><td>${esc(x.r.name)}</td><td>${esc(x.r.claim || '')}</td><td class="m">${esc(x.runId)}</td></tr>`).join('')}
</table><script>const f=()=>{const s=st.value,t=ss.value,q=document.getElementById('q').value.toLowerCase();document.querySelectorAll('tr[data-s]').forEach(r=>{r.hidden=(s&&r.dataset.s!==s)||(t&&r.dataset.t!==t)||(q&&!r.innerText.toLowerCase().includes(q))})};[st,ss,document.getElementById('q')].forEach(e=>e.addEventListener('input',f));</script></body></html>`;
  fs.writeFileSync(path.join(outDir, 'index.html'), index);
  log(`[CaseReviews] ${rows.length} case pages → ${path.join(outDir, 'index.html')}`);
  return path.join(outDir, 'index.html');
}

module.exports = { build };
if (require.main === module) {
  const i = process.argv.indexOf('--embed');
  try { build({ embed: i > 0 ? process.argv[i + 1] : null }); } catch (e) { console.error('[CaseReviews]', e.message); process.exit(1); }
}
