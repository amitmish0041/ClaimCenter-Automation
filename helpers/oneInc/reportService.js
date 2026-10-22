/**
 * helpers/oneInc/reportService.js
 * Folder layout, run ids and reports for the OneInc suite. Everything lands under ONEINC_RESULTS_DIR (default
 * <ONEINC_DIR>\AutomationResults):
 *   Reports\     OneInc_<runId>.html / .json / .csv, plus latest.html|json (copy of the newest run)
 *   Screenshots\ <runId>\<scenario>\NN-*.png
 *   Logs\        <runId>.log (full console log of the run)
 *   Evidence\    <runId>\<scenario>\NN-*.json (what the screen showed at each check: fields, options, messages)
 *   TestData\    <runId>-claims.json (which existing claim each scenario used — claim numbers only, no credentials)
 *   RunHistory\  <runId>.json (summary) + history.csv (one line per run)
 * Run ids are "OneInc_<yyyymmdd>_<hhmmss>_<tier>", so runs never overwrite each other.
 * No credentials are ever written: results carry only claim numbers, screen text and file paths.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ONEINC_DIR, RESULTS_DIRNAME } = require('./inventoryService');

const RESULTS_DIR = process.env.ONEINC_RESULTS_DIR || path.join(ONEINC_DIR, RESULTS_DIRNAME);
const SUBDIRS = ['Reports', 'Screenshots', 'Logs', 'Evidence', 'TestData', 'RunHistory'];
const STATUSES = ['PASS', 'FAIL', 'BLOCKED', 'NOT EXECUTED'];

function newRunId(tier, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `OneInc_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}_${tier}`;
}

function prepareDirs(runId, root = RESULTS_DIR) {
  for (const d of SUBDIRS) fs.mkdirSync(path.join(root, d), { recursive: true });
  const dirs = {
    root,
    reports: path.join(root, 'Reports'),
    screenshots: path.join(root, 'Screenshots', runId),
    evidence: path.join(root, 'Evidence', runId),
    logs: path.join(root, 'Logs'),
    testData: path.join(root, 'TestData'),
    history: path.join(root, 'RunHistory'),
  };
  fs.mkdirSync(dirs.screenshots, { recursive: true });
  fs.mkdirSync(dirs.evidence, { recursive: true });
  return dirs;
}

// "Executed" = attempted (PASS + FAIL + BLOCKED). Pass % = PASS / executed. "Decided" pass % = PASS / (PASS + FAIL).
function summarize(results) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const passed = count('PASS'); const failed = count('FAIL'); const blocked = count('BLOCKED'); const notExecuted = count('NOT EXECUTED');
  const executed = passed + failed + blocked;
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const byStory = {};
  for (const r of results) {
    const s = byStory[r.story] || (byStory[r.story] = { story: r.story, title: r.storyTitle, total: 0, PASS: 0, FAIL: 0, BLOCKED: 0, 'NOT EXECUTED': 0, jira: r.jira || null });
    s.total++; s[r.status]++;
  }
  const byAutomation = {};
  for (const r of results) byAutomation[r.automation] = (byAutomation[r.automation] || 0) + 1;
  return {
    discovered: results.length, executed, passed, failed, blocked, notExecuted,
    passPct: pct(passed, executed), decidedPassPct: pct(passed, passed + failed),
    pendingDevFailures: results.filter((r) => r.status === 'FAIL' && r.devNote).length,
    byStory: Object.values(byStory).sort((a, b) => a.story.localeCompare(b.story, undefined, { numeric: true })),
    byAutomation,
  };
}

const csvCell = (v) => {
  const s = Array.isArray(v) ? v.join(' ; ') : String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(results) {
  const cols = ['scenarioId', 'story', 'sheet', 'tcId', 'name', 'automation', 'status', 'reason', 'devNote', 'jiraReadiness', 'knownBugs',
    'claim', 'expected', 'actual', 'stepsExecuted', 'startedAt', 'finishedAt', 'durationMs', 'evidence'];
  const lines = [cols.join(',')];
  for (const r of results) {
    lines.push(cols.map((c) => {
      if (c === 'jiraReadiness') return csvCell(r.jira ? r.jira.readiness : '');
      if (c === 'knownBugs') return csvCell((r.bugs || []).map((b) => `${b.key} (${b.status})`));
      return csvCell(r[c]);
    }).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rel = (from, p) => path.relative(from, p).split(path.sep).join('/');

function toHtml(run, results, reportsDir) {
  const S = run.summary;
  const pill = (s) => `<span class="pill ${esc(s.replace(' ', '-'))}">${esc(s)}</span>`;
  const readinessPill = (j) => (j ? `<span class="rd ${esc(j.readiness)}">${esc(j.readiness.replace('_', ' '))}</span>` : '<span class="rd UNKNOWN">UNKNOWN</span>');
  const jiraLink = (card) => (card ? `<a href="https://${esc(run.jira.site || 'donegalgroup.atlassian.net')}/browse/${esc(card.key)}" target="_blank">${esc(card.key)}</a> ${esc(card.status)}` : '—');
  const storyRows = S.byStory.map((s) => `<tr><td><b>${esc(s.story)}</b><div class="muted">${esc(s.title)}</div></td>
    <td>${readinessPill(s.jira)}</td><td>${jiraLink(s.jira && s.jira.dev)}</td><td>${jiraLink(s.jira && s.jira.exec)}</td>
    <td class="n">${s.total}</td><td class="n p">${s.PASS}</td><td class="n f">${s.FAIL}</td><td class="n b">${s.BLOCKED}</td><td class="n x">${s['NOT EXECUTED']}</td></tr>`).join('');
  const rows = results.map((r, i) => {
    const ev = (r.evidence || []).filter((p) => /\.png$/i.test(p)).map((p, k) => `<a href="${esc(rel(reportsDir, p))}" target="_blank">shot ${k + 1}</a>`).join(' · ');
    const dumps = (r.evidence || []).filter((p) => /\.json$/i.test(p)).length;
    const checks = (r.checks || []).map((c) => `<tr><td>${pill(c.result)}</td><td>${esc(c.description)}${c.screenshot ? ` <a href="${esc(rel(reportsDir, c.screenshot))}" target="_blank">screenshot</a>` : ''}</td><td>${esc(c.expected)}</td><td>${esc(c.actual)}${c.missing && c.result === 'FAIL' ? ' <span class="dev">possible pending dev</span>' : ''}</td></tr>`).join('');
    return `<tr class="row s-${esc(r.status.replace(' ', '-'))}" data-status="${esc(r.status)}" data-story="${esc(r.story)}" data-auto="${esc(r.automation)}">
      <td class="mono">${esc(r.scenarioId)}</td><td>${esc(r.name)}${r.devNote ? `<div class="dev">${esc(r.devNote)}</div>` : ''}</td>
      <td>${esc(r.automation)}</td><td>${pill(r.status)}</td><td class="mono">${esc(r.claim || '')}</td><td class="n">${r.durationMs ? (r.durationMs / 1000).toFixed(1) + 's' : ''}</td>
      <td><button class="tg" data-i="${i}">details</button></td></tr>
      <tr class="det" id="d${i}" hidden><td colspan="7">
        <div class="grid2"><div><h4>Expected</h4><pre>${esc(r.expected)}</pre></div><div><h4>Actual</h4><pre>${esc(r.actual || r.reason)}</pre></div></div>
        ${r.reason ? `<p><b>${r.status === 'PASS' ? 'Note' : 'Reason'}:</b> ${esc(r.reason)}</p>` : ''}
        ${r.notes ? `<p class="muted"><b>Automation note:</b> ${esc(r.notes)}</p>` : ''}
        ${(r.bugs || []).length ? `<p><b>Related OneInc bugs:</b> ${r.bugs.map((b) => `<a href="https://${esc(run.jira.site || 'donegalgroup.atlassian.net')}/browse/${esc(b.key)}" target="_blank">${esc(b.key)}</a> (${esc(b.status)}) ${esc(b.summary)}`).join('<br>')}</p>` : ''}
        ${r.precondition ? `<p class="muted"><b>Pre-condition:</b> ${esc(r.precondition)}</p>` : ''}
        ${(r.stepsExecuted || []).length ? `<h4>Steps executed</h4><ol>${r.stepsExecuted.map((s, k) => `<li>${esc(s)}${(r.stepShots || [])[k] ? ` — <a href="${esc(rel(reportsDir, r.stepShots[k]))}" target="_blank">screenshot</a>` : ''}</li>`).join('')}</ol>` : ''}
        ${checks ? `<h4>Checks</h4><table class="chk"><tr><th>Result</th><th>Check</th><th>Expected</th><th>Actual</th></tr>${checks}</table>` : ''}
        ${r.error ? `<h4>Error</h4><pre>${esc(r.stack || r.error)}</pre>` : ''}
        <p class="muted">${r.startedAt ? `Start ${esc(r.startedAt)} · End ${esc(r.finishedAt)} · ` : ''}Claims tried: ${esc((r.claimsTried || []).join(', ') || '—')}
        ${ev ? `<br>Evidence: ${ev}${dumps ? ` (+${dumps} screen dump${dumps > 1 ? 's' : ''} in Evidence\\)` : ''}` : ''}</p>
      </td></tr>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OneInc Automation Report</title><style>
:root{--bg:#f7f8fa;--fg:#1d2330;--muted:#667085;--card:#fff;--line:#e3e6eb;--p:#1f7a3d;--f:#b42318;--b:#b54708;--x:#667085;--acc:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--fg:#e6e8ec;--muted:#98a2b3;--card:#1b2029;--line:#2c3340;--p:#4ade80;--f:#f87171;--b:#fbbf24;--x:#98a2b3;--acc:#7aa2ff}}
body{margin:0;font:14px/1.45 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}main{max-width:1400px;margin:0 auto;padding:20px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 8px}h4{margin:10px 0 4px}.muted{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:14px 0}.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.tile b{display:block;font-size:22px}.tile.p b{color:var(--p)}.tile.f b{color:var(--f)}.tile.b b{color:var(--b)}.tile.x b{color:var(--x)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}.n{text-align:right;white-space:nowrap}.n.p{color:var(--p)}.n.f{color:var(--f)}.n.b{color:var(--b)}.mono{font-family:Consolas,monospace;font-size:12px;white-space:nowrap}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;color:#fff}.pill.PASS{background:var(--p)}.pill.FAIL{background:var(--f)}.pill.BLOCKED{background:var(--b)}.pill.NOT-EXECUTED{background:var(--x)}
.rd{font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px;border:1px solid var(--line)}.rd.READY{color:var(--p)}.rd.DEV_PENDING{color:var(--f)}.rd.DEV_DONE{color:var(--acc)}.rd.UNKNOWN{color:var(--x)}
.dev{color:var(--b);font-size:12px;margin-top:2px}pre{white-space:pre-wrap;margin:0;font:12px Consolas,monospace;background:var(--bg);padding:6px;border-radius:6px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media (max-width:760px){.grid2{grid-template-columns:1fr}.mono{white-space:normal}}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.filters select,.filters input{padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
button.tg{border:1px solid var(--line);background:var(--card);color:var(--acc);border-radius:6px;padding:2px 8px;cursor:pointer}.chk td{font-size:12px}.wrap{overflow-x:auto}a{color:var(--acc)}
</style></head><body><main>
<h1>OneInc Automation Report</h1>
<div class="muted">Run <b>${esc(run.runId)}</b> · ${esc(run.env.platform)}/${esc(run.env.tier)} · ${esc(run.env.url)} · started ${esc(run.startedAt)} · finished ${esc(run.finishedAt)} · duration ${(run.durationMs / 60000).toFixed(1)} min</div>
<div class="muted">Scope: ${esc(run.scope)} · Finish (payment submission) ${run.allowFinish ? '<b>ENABLED</b>' : 'disabled — nothing was saved'} · Jira: ${run.jira.available ? `${esc(run.jira.fetchedAt || '')}` : esc(run.jira.reason)}</div>
<div class="tiles">
<div class="tile"><span class="muted">Discovered</span><b>${S.discovered}</b></div>
<div class="tile"><span class="muted">Executed</span><b>${S.executed}</b></div>
<div class="tile p"><span class="muted">Passed</span><b>${S.passed}</b></div>
<div class="tile f"><span class="muted">Failed</span><b>${S.failed}</b></div>
<div class="tile b"><span class="muted">Blocked</span><b>${S.blocked}</b></div>
<div class="tile x"><span class="muted">Not executed</span><b>${S.notExecuted}</b></div>
<div class="tile"><span class="muted">Pass % (of executed)</span><b>${S.passPct}%</b></div>
<div class="tile"><span class="muted">Pass % (PASS+FAIL only)</span><b>${S.decidedPassPct}%</b></div>
</div>
<p class="muted">Executed = attempted this run (PASS + FAIL + BLOCKED). Pass % = PASS ÷ executed. Failures marked <span class="dev">possible pending dev</span> are expected elements that are not on the screen yet — check the story's Jira status before logging a defect.</p>
<h2>By story (Jira readiness from the OneInc Test Execution / Dev cards)</h2>
<div class="wrap"><table><tr><th>Story</th><th>Readiness</th><th>Dev card</th><th>Test Execution card</th><th class="n">Total</th><th class="n">Pass</th><th class="n">Fail</th><th class="n">Blocked</th><th class="n">Not exec.</th></tr>${storyRows}</table></div>
<h2>Scenarios</h2>
<div class="filters"><select id="fs"><option value="">All statuses</option>${STATUSES.map((s) => `<option>${s}</option>`).join('')}</select>
<select id="fst"><option value="">All stories</option>${S.byStory.map((s) => `<option>${esc(s.story)}</option>`).join('')}</select>
<select id="fa"><option value="">All categories</option>${Object.keys(S.byAutomation).map((a) => `<option>${esc(a)}</option>`).join('')}</select>
<input id="fq" placeholder="Search id / name"></div>
<div class="wrap"><table id="t"><tr><th>Scenario</th><th>Name</th><th>Category</th><th>Status</th><th>Claim</th><th class="n">Time</th><th></th></tr>${rows}</table></div>
</main><script>
document.querySelectorAll('button.tg').forEach(function(b){b.onclick=function(){var d=document.getElementById('d'+b.dataset.i);d.hidden=!d.hidden;b.textContent=d.hidden?'details':'hide';};});
function f(){var s=document.getElementById('fs').value,st=document.getElementById('fst').value,a=document.getElementById('fa').value,q=document.getElementById('fq').value.toLowerCase();
document.querySelectorAll('tr.row').forEach(function(r){var ok=(!s||r.dataset.status===s)&&(!st||r.dataset.story===st)&&(!a||r.dataset.auto===a)&&(!q||r.textContent.toLowerCase().indexOf(q)>=0);r.hidden=!ok;var d=r.nextElementSibling;if(!ok)d.hidden=true;});}
['fs','fst','fa'].forEach(function(id){document.getElementById(id).onchange=f;});document.getElementById('fq').oninput=f;
</script></body></html>`;
}

function writeRun(run, results, dirs) {
  run.summary = summarize(results);
  const base = path.join(dirs.reports, run.runId);
  const json = { run, results };
  fs.writeFileSync(`${base}.json`, JSON.stringify(json, null, 2));
  fs.writeFileSync(`${base}.csv`, toCsv(results));
  fs.writeFileSync(`${base}.html`, toHtml(run, results, dirs.reports));
  fs.copyFileSync(`${base}.html`, path.join(dirs.reports, 'latest.html'));
  fs.copyFileSync(`${base}.json`, path.join(dirs.reports, 'latest.json'));
  fs.writeFileSync(path.join(dirs.testData, `${run.runId}-claims.json`), JSON.stringify(
    results.filter((r) => r.claim || (r.claimsTried || []).length).map((r) => ({ scenarioId: r.scenarioId, profile: r.profile, claim: r.claim, claimsTried: r.claimsTried })), null, 2));
  const hist = { runId: run.runId, startedAt: run.startedAt, finishedAt: run.finishedAt, durationMs: run.durationMs, env: run.env, scope: run.scope, summary: run.summary,
    complete: run.complete !== false, planned: run.planned, done: run.done,
    report: `${base}.html`, failed: results.filter((r) => r.status === 'FAIL').map((r) => r.scenarioId), blocked: results.filter((r) => r.status === 'BLOCKED').map((r) => r.scenarioId) };
  fs.writeFileSync(path.join(dirs.history, `${run.runId}.json`), JSON.stringify(hist, null, 2));
  const hcsv = path.join(dirs.history, 'history.csv');
  if (!fs.existsSync(hcsv)) fs.writeFileSync(hcsv, 'runId,startedAt,tier,scope,discovered,executed,passed,failed,blocked,notExecuted,passPct,report\r\n');
  const S = run.summary;
  fs.appendFileSync(hcsv, [run.runId, run.startedAt, run.env.tier, csvCell(run.scope), S.discovered, S.executed, S.passed, S.failed, S.blocked, S.notExecuted, S.passPct, csvCell(`${base}.html`)].join(',') + '\r\n');
  return { html: `${base}.html`, json: `${base}.json`, csv: `${base}.csv` };
}

// ── History by Jira story ─────────────────────────────────────────────────────────────────────────────────────
// Per user direction 2026-10-20: run-by-run history isn't what people need — they need "what is the latest state of
// story GCCM-759". aggregate() reads every saved run (Reports\OneInc_*.json, oldest first) and returns:
//   latest: { scenarioId: { status, reason, devNote, runId, at, story, name, claim } } — the newest ATTEMPTED result
//   runs:   [{ runId, startedAt, durationMs, scope, complete, counts:{PASS,FAIL,BLOCKED}, byStory:{story:{PASS,FAIL,BLOCKED}} }]
//           counting only scenarios that run actually attempted (not the dev-pending / not-selected ones every run
//           lists), newest first.
// Cached until a run file is added or rewritten.
const ATTEMPTED = (r) => r.automation === 'AUTOMATED' && ['PASS', 'FAIL', 'BLOCKED'].includes(r.status)
  && !/^Queued|not selected for this run/i.test(r.reason || '');
let aggCache = { key: '', value: null };
function aggregate(root = RESULTS_DIR) {
  const dir = path.join(root, 'Reports');
  if (!fs.existsSync(dir)) return { latest: {}, runs: [] };
  const files = fs.readdirSync(dir).filter((f) => /^OneInc_\d{8}_\d{6}_\w+\.json$/.test(f)).sort();
  const key = files.map((f) => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`).join('|');
  if (aggCache.key === key && aggCache.value) return aggCache.value;
  const latest = {};
  const runs = [];
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
    const byStory = {};
    for (const r of d.results || []) {
      if (!ATTEMPTED(r)) continue;
      counts[r.status]++;
      const s = byStory[r.story] || (byStory[r.story] = { PASS: 0, FAIL: 0, BLOCKED: 0 });
      s[r.status]++;
      latest[r.scenarioId] = { status: r.status, reason: r.reason || '', devNote: r.devNote || '', runId: d.run.runId,
        at: r.finishedAt || d.run.startedAt, story: r.story, name: r.name, claim: r.claim || '' };
    }
    runs.push({ runId: d.run.runId, startedAt: d.run.startedAt, durationMs: d.run.durationMs, scope: d.run.scope,
      // A stopped run never writes complete=true: no update for 30 min = not running (2026-10-22).
      complete: d.run.complete !== false || Date.now() - Date.parse(d.run.finishedAt || d.run.startedAt) > 30 * 60 * 1000, tier: (d.run.env || {}).tier, counts, byStory });
  }
  runs.reverse();
  aggCache = { key, value: { latest, runs } };
  return aggCache.value;
}

function listRuns(root = RESULTS_DIR, limit = 50) {
  const dir = path.join(root, 'RunHistory');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^OneInc_.*\.json$/.test(f)).sort().reverse().slice(0, limit)
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; } }).filter(Boolean);
}

function loadRun(runId, root = RESULTS_DIR) {
  if (!/^OneInc_[\w-]+$/.test(String(runId || ''))) return null;
  const p = path.join(root, 'Reports', `${runId}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

module.exports = { RESULTS_DIR, STATUSES, newRunId, prepareDirs, summarize, toCsv, toHtml, writeRun, listRuns, loadRun, aggregate };
