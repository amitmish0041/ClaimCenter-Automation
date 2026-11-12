#!/usr/bin/env node
/**
 * scripts/sendOneIncTeamStatus.js — one e-mail to the OneInc QA team with the latest result of a list of cases (e.g. the
 * cases automated on a given day), so they can review the runs and log bugs for the failures (user request 2026-11-11).
 *
 *   node scripts/sendOneIncTeamStatus.js --ids-file "<share>\TestData\automated-2026-11-11.json" [--to a@x,b@y] [--dry-run]
 *
 * Latest result per case = the newest Reports\OneInc_*_test.json holding a PASS / FAIL / BLOCKED for it. FAILs on the
 * known-findings list are marked as such. A CSV of the same rows is attached. SMTP settings (SMTP_HOST / SMTP_PORT /
 * FROM_EMAIL) come from this repo's .env or, when absent, the Commercial Line Performance test .env (read only).
 * --dry-run writes the HTML next to the reports instead of sending.
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });
if (!process.env.SMTP_HOST) require('dotenv').config({ path: path.join(__dirname, '..', '..', 'Commercial Line Performance test', '.env'), quiet: true });
const { RESULTS_DIR } = require('../helpers/oneInc/reportService');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const TEAM = ['amandahess@donegalgroup.com', 'NarmathaNagaraj@donegalgroup.com', 'DhayaashreePalanisamy@donegalgroup.com', 'amitmishra@donegalgroup.com'];
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const csvq = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;

const ids = JSON.parse(fs.readFileSync(arg('ids-file'), 'utf8'));
const reportsDir = path.join(RESULTS_DIR, 'Reports');
const files = fs.readdirSync(reportsDir).filter((f) => /^OneInc_\d{8}_\d{6}_test\.json$/.test(f)).sort();
const latest = {};
const meta = {};
for (const f of files) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(reportsDir, f), 'utf8')); } catch (_) { continue; }
  for (const r of j.results || []) {
    if (!ids.includes(r.scenarioId)) continue;
    meta[r.scenarioId] = r;
    if (/^(PASS|FAIL|BLOCKED)$/.test(r.status)) latest[r.scenarioId] = { ...r, runId: f.replace(/\.json$/, '') };
  }
}
let known = {};
try { known = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, 'TestData', 'known-findings-test.json'), 'utf8')); } catch (_) {}

const ORDER = { FAIL: 0, BLOCKED: 1, 'NOT RUN': 2, PASS: 3 };
const rows = ids.map((id) => {
  const r = latest[id];
  const m = meta[id] || {};
  const status = r ? r.status : 'NOT RUN';
  const bad = r ? (r.checks || []).filter((c) => c.result && c.result !== 'PASS') : [];
  let detail = '';
  if (status === 'FAIL') detail = bad.map((c) => `${c.description}: expected ${c.expected}; actual ${c.actual}`).join(' | ') || r.reason;
  else if (status === 'BLOCKED') detail = r.reason;
  else if (status === 'NOT RUN') detail = 'Automated today; queued for its first run';
  const k = known[id];
  return {
    id, story: id.split('/')[0], tc: id.split('/').slice(1).join(' '), name: (r || m).name || '', status,
    finding: status === 'FAIL' ? (k ? `Known finding (since ${k.since}): ${k.note}` : 'NEW — please review') : '',
    detail: String(detail || '').replace(/\s+/g, ' ').slice(0, 600),
    claim: r ? r.claim || '' : '', run: r ? r.runId : '', when: r ? (r.finishedAt || r.startedAt || '') : '',
    shot: r ? ((bad[0] && bad[0].screenshot) || (r.evidence || []).find((e) => /\.png$/i.test(e)) || '') : '',
  };
}).sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.id.localeCompare(b.id, undefined, { numeric: true }));

const count = (s) => rows.filter((r) => r.status === s).length;
const day = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const colour = { PASS: '#1e7b34', FAIL: '#b3261e', BLOCKED: '#9a6700', 'NOT RUN': '#57606a' };
const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#1f2328">
<p>Hi team,</p>
<p>Below are the <b>${rows.length} OneInc test cases newly automated on ${esc(day)}</b>, each with its latest automated result on ClaimCenter TEST.
Please review the <b>FAIL</b> rows and log bugs where you agree. Rows marked "Known finding" match an issue already recorded.
<b>BLOCKED</b> means the script could not finish the case (a script or test-data problem, not a product result) and it will be rerun.</p>
<p style="font-size:14px"><b style="color:${colour.PASS}">${count('PASS')} PASS</b> &nbsp;·&nbsp; <b style="color:${colour.FAIL}">${count('FAIL')} FAIL</b> &nbsp;·&nbsp;
<b style="color:${colour.BLOCKED}">${count('BLOCKED')} BLOCKED</b> &nbsp;·&nbsp; <b style="color:${colour['NOT RUN']}">${count('NOT RUN')} NOT RUN YET</b></p>
<table cellpadding="5" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<tr style="background:#f0f3f6;text-align:left"><th>Story</th><th>Case</th><th>Name</th><th>Status</th><th>Details</th><th>Claim</th><th>Run</th></tr>
${rows.map((r) => `<tr style="border-top:1px solid #d0d7de;vertical-align:top"><td>${esc(r.story)}</td><td style="white-space:nowrap">${esc(r.tc)}</td><td>${esc(r.name)}</td>
<td style="color:${colour[r.status]};font-weight:600;white-space:nowrap">${esc(r.status)}</td>
<td>${r.finding ? `<b>${esc(r.finding)}</b><br>` : ''}${esc(r.detail)}${r.shot ? `<br><span style="color:#57606a">Screenshot: ${esc(r.shot)}</span>` : ''}</td>
<td style="white-space:nowrap">${esc(r.claim)}</td><td style="white-space:nowrap">${esc(r.run)}</td></tr>`).join('\n')}
</table>
<p>Full reports, screenshots and evidence: <b>${esc(path.join(RESULTS_DIR, 'Reports'))}</b> (latest.html is the newest run). The same rows are attached as a CSV.</p>
<p>Regards,<br>OneInc automation</p></div>`;

const csv = ['Story,Case,Name,Status,Finding,Details,Claim,Run,Finished,Screenshot',
  ...rows.map((r) => [r.story, r.tc, r.name, r.status, r.finding, r.detail, r.claim, r.run, r.when, r.shot].map(csvq).join(','))].join('\r\n');

(async () => {
  const subject = `OneInc automation status — ${rows.length} cases automated ${day}: ${count('PASS')} pass, ${count('FAIL')} fail, ${count('BLOCKED')} blocked, ${count('NOT RUN')} not run yet`;
  if (arg('dry-run', false)) {
    const out = path.join(RESULTS_DIR, 'Reports', 'team-status-preview.html');
    fs.writeFileSync(out, html);
    console.log(`[TeamStatus] DRY RUN — ${subject}\n[TeamStatus] preview ${out}`);
    return;
  }
  if (!process.env.SMTP_HOST || !process.env.FROM_EMAIL) throw new Error('SMTP_HOST / FROM_EMAIL not set');
  const to = typeof arg('to') === 'string' ? arg('to').split(',') : TEAM;
  const t = require('nodemailer').createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 25, secure: false, tls: { rejectUnauthorized: false } });
  await t.sendMail({ from: process.env.FROM_EMAIL, to, subject, html, attachments: [{ filename: `OneInc_status_${new Date().toISOString().slice(0, 10)}.csv`, content: csv }] });
  console.log(`[TeamStatus] SENT to ${to.join(', ')} — ${subject}`);
})().catch((e) => { console.error('[TeamStatus] failed:', e.message); process.exit(1); });
