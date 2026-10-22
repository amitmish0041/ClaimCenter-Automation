#!/usr/bin/env node
/**
 * scripts/oneIncDataRequirements.js
 * Writes the OneInc TEST DATA REQUIREMENTS sheet for the team (user direction 2026-10-21): what every claim profile
 * needs, how it is created (FNOL or an existing aged claim), the declared data items built at claim creation
 * (helpers/oneInc/testData.js), each case's precondition, the current pool claims with their data status, and the data
 * automation cannot create (with what unblocks it).
 *
 *   node scripts/oneIncDataRequirements.js            → <ONEINC_RESULTS_DIR>\TestData\DATA_REQUIREMENTS.html + .csv
 *
 * Offline — reads code, the claim pool and the latest run report; never opens ClaimCenter.
 */
'use strict';
process.env.CC_ENV = process.env.CC_ENV || 'cloud';
const fs = require('fs');
const path = require('path');
const claimPicker = require('../helpers/oneInc/claimPicker');
const TD = require('../helpers/oneInc/testData');
const { RECIPES } = require('../helpers/oneInc/scenarioRecipes');
const reportService = require('../helpers/oneInc/reportService');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const csvCell = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;

// FNOL settings per profile, as the provisioner sees them.
function fnolOf(name, p) {
  const f = p.fnol || null;
  if (f && (f.exposures || []).length) {
    const cov = f.exposures.map((e) => [].concat(e.coverageLabel).join(' / ')).join(' + ');
    return `New FNOL: ${f.policyType} ${f.state}, exposures ${cov}${(f.incidents || []).length ? `, incidents ${f.incidents.join(', ')}` : ''}${p.keepSurcharging ? '; Surcharging left incomplete' : ''}`;
  }
  if (f) return `EXISTING ${p.state} claim (a new FNOL with an old loss date is impossible) — add with --add ${name}=<claim>`;
  if (p.fnolAs) return `New FNOL as ${p.fnolAs}`;
  return 'New FNOL (scripts/provisionOneIncClaims.js FNOL table) or a matching claim from the TEST claim list';
}

const latestResults = (() => {
  try {
    const runs = reportService.listRuns().filter((r) => /_test$/.test(r.runId || r.id || ''));
    const last = runs.sort((a, b) => String(b.runId || b.id).localeCompare(String(a.runId || a.id)))[0];
    return last ? (reportService.loadRun(last.runId || last.id).results || []) : [];
  } catch (_) { return []; }
})();

const pool = claimPicker.readPool();
const byProfile = {};
for (const [id, r] of Object.entries(RECIPES)) (byProfile[r.profile] = byProfile[r.profile] || []).push(id);

const profiles = Object.entries(claimPicker.PROFILES).map(([name, p]) => ({
  name, label: p.label, how: fnolOf(name, p), prepare: p.prepare || '',
  items: (p.data || []).map((d) => ({ id: d.id, label: d.label, auto: !!d.build, manual: d.manual || '' })),
  cases: (byProfile[name] || []).sort(),
  claims: (pool[name] || []).map((e) => ({ claim: e.claim, usable: e.usable, problem: e.problem || '', data: e.data || [], at: e.createdAt })),
})).filter((p) => p.cases.length || p.claims.length || p.items.length);

const caseRows = Object.entries(RECIPES).map(([id, r]) => ({
  id, profile: r.profile, needs: TD.deriveNeeds(r).map((d) => d.label),
})).sort((a, b) => a.id.localeCompare(b.id));

const needsData = latestResults.filter((r) => r.automation === 'NEEDS_DATA').map((r) => ({ id: r.scenarioId, name: r.name, reason: r.reason || r.devNote || '' }));

// ── CSV (one row per profile item / case need / manual item) ─────────────────────────────────────────────────────
const csv = [['Section', 'Profile / Case', 'Requirement', 'Created by automation?', 'How / what unblocks it', 'Cases', 'Pool claims (status)'].map(csvCell).join(',')];
for (const p of profiles) {
  const claims = p.claims.map((c) => `${c.claim} ${c.usable ? 'USABLE' : 'NOT usable'}`).join('; ');
  csv.push(['Profile', p.name, `Claim: ${p.how}`, 'yes', p.prepare ? `prepare hook ${p.prepare}` : '', p.cases.length, claims].map(csvCell).join(','));
  for (const it of p.items) csv.push(['Profile data', p.name, it.label, it.auto ? 'yes' : 'NO', it.manual, p.cases.length, ''].map(csvCell).join(','));
}
for (const c of caseRows) for (const n of c.needs) csv.push(['Case precondition', c.id, n, 'checked before the case', '', '', c.profile].map(csvCell).join(','));
for (const m of TD.MANUAL_DATA) csv.push(['Manual data', m.id, m.label, 'NO', m.unblock, m.cases.join(' '), ''].map(csvCell).join(','));
for (const n of needsData) csv.push(['Not automated (needs data)', n.id, n.name, 'NO', n.reason, '', ''].map(csvCell).join(','));

// ── HTML ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const pill = (ok) => `<span class="p ${ok ? 'ok' : 'bad'}">${ok ? 'OK' : 'MISSING'}</span>`;
const profileHtml = profiles.map((p) => `
  <section><h3>${esc(p.name)} <span class="muted">— ${esc(p.label)}</span></h3>
  <p><b>Claim:</b> ${esc(p.how)}${p.prepare ? ` · <b>prepare hook:</b> <code>${esc(p.prepare)}</code>` : ''} · <b>${p.cases.length}</b> automated case(s)</p>
  ${p.items.length ? `<table><tr><th>Test data built at claim creation</th><th>Automated?</th><th>If not: how</th></tr>${p.items.map((i) => `<tr><td>${esc(i.label)}</td><td>${i.auto ? 'yes' : '<b>NO</b>'}</td><td>${esc(i.manual)}</td></tr>`).join('')}</table>` : '<p class="muted">Standard claim — the claim check makes it payable (assignment, Surcharging, Ability to pay, an open reserve).</p>'}
  ${p.claims.length ? `<table><tr><th>Pool claim</th><th>Status</th><th>Data items</th></tr>${p.claims.map((c) => `<tr><td><code>${esc(c.claim)}</code></td><td>${c.usable ? 'USABLE' : `<b>NOT usable</b> — ${esc(c.problem)}`}</td><td>${c.data.length ? c.data.map((d) => `${pill(d.ok)} ${esc(d.label)}${d.ok ? '' : ` — ${esc(d.problem)}`}`).join('<br>') : '<span class="muted">not verified yet (run --verify)</span>'}</td></tr>`).join('')}</table>` : '<p class="bad">No claim in the pool yet.</p>'}
  </section>`).join('');
const needRows = caseRows.filter((c) => c.needs.length).map((c) => `<tr><td><code>${esc(c.id)}</code></td><td>${esc(c.profile)}</td><td>${c.needs.map(esc).join('<br>')}</td></tr>`).join('');
const manualRows = TD.MANUAL_DATA.map((m) => `<tr><td>${esc(m.label)}</td><td>${m.cases.map((x) => `<code>${esc(x)}</code>`).join(' ') || '—'}</td><td>${esc(m.unblock)}</td></tr>`).join('');
const ndRows = needsData.map((n) => `<tr><td><code>${esc(n.id)}</code></td><td>${esc(n.name)}</td><td>${esc(n.reason)}</td></tr>`).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><title>OneInc Test Data Requirements</title>
<style>body{font:14px/1.45 Segoe UI,Arial,sans-serif;margin:24px;color:#222}h1{margin:0 0 4px}h2{margin-top:32px;border-bottom:2px solid #ddd}
table{border-collapse:collapse;margin:8px 0 16px;width:100%}td,th{border:1px solid #ddd;padding:5px 8px;text-align:left;vertical-align:top}th{background:#f4f6f8}
.muted{color:#777;font-weight:normal}.p{font-size:11px;padding:1px 6px;border-radius:8px}.ok{background:#e3f6e8;color:#17692e}.bad{background:#fde8e8;color:#9b1c1c}
section{margin-bottom:18px}code{font-size:12px}</style></head><body>
<h1>OneInc — Test Data Requirements</h1>
<p class="muted">Generated ${new Date().toISOString()} from the automation code and the claim pool (${esc(claimPicker.POOL_FILE)}). Build/verify everything before a run:
<code>node scripts/provisionOneIncClaims.js --verify</code> (existing pool claims) · <code>--all --count 1</code> (fresh claim per profile).</p>
<h2>1. Claim profiles and the data built at claim creation</h2>${profileHtml}
<h2>2. Case-level preconditions (checked before each case; missing → BLOCKED naming it)</h2>
<table><tr><th>Case</th><th>Profile</th><th>Needs</th></tr>${needRows}</table>
<h2>3. Data automation cannot create (needs a person or a decision)</h2>
<table><tr><th>Data</th><th>Cases</th><th>What unblocks it</th></tr>${manualRows}</table>
<h2>4. Cases not automated for lack of data (latest run)</h2>
<table><tr><th>Case</th><th>Name</th><th>Reason</th></tr>${ndRows || '<tr><td colspan="3">none</td></tr>'}</table>
</body></html>`;

const dir = path.join(reportService.RESULTS_DIR, 'TestData');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'DATA_REQUIREMENTS.html'), html);
fs.writeFileSync(path.join(dir, 'DATA_REQUIREMENTS.csv'), csv.join('\r\n'));
console.log(`[DataReq] ${profiles.length} profiles, ${caseRows.filter((c) => c.needs.length).length} cases with case-level needs, ${TD.MANUAL_DATA.length} manual items, ${needsData.length} needs-data cases`);
console.log(`[DataReq] ${path.join(dir, 'DATA_REQUIREMENTS.html')}`);
