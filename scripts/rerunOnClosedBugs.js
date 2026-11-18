#!/usr/bin/env node
/**
 * scripts/rerunOnClosedBugs.js — keep re-validating OneInc cases as their defects get fixed.
 *
 * 1. Reads OneInc bugs from Jira (project GCCM, text ~ OneInc) closed/resolved since the last time this ran
 *    (state: <results>/TestData/closed-bug-watch-<tier>.json).
 * 2. When MORE THAN --min (default 5) newly closed bugs have piled up, finds every case whose latest result
 *    (newest report JSON per case) is FAIL/BLOCKED and that mentions one of those bugs, and that failed BEFORE
 *    the bug was closed — then runs just those cases (runOneInc --ids). Otherwise it keeps the bugs pending
 *    for the next check.
 * 3. The bugs are marked processed only after the rerun was started, so nothing is lost on a failed check.
 *
 *   node scripts/rerunOnClosedBugs.js            check, rerun when > 5 new closed bugs
 *   node scripts/rerunOnClosedBugs.js --dry      list bugs + cases, no run, state untouched
 *   node scripts/rerunOnClosedBugs.js --min 0    run for any newly closed bug
 * Scheduled daily by Windows task "OneInc Closed-Bug Rerun" (added 2026-11-17 at the user's request).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { jiraConfig, searchJql } = require('../helpers/smartComm/jiraBugService');
const { RESULTS_DIR } = require('../helpers/oneInc/reportService');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry');
const MIN = Number(arg('--min', 5));
const TIER = String(process.env.CC_TIER || 'test').toLowerCase();
const STATE = path.join(RESULTS_DIR, 'TestData', `closed-bug-watch-${TIER}.json`);
const REPORTS = path.join(RESULTS_DIR, 'Reports');
const log = (...a) => console.log('[ClosedBugs]', ...a);

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return { processed: {}, since: '2026-11-01' }; }
}

// Latest result per case across every report: { id: { status, at, text } }
function latestResults() {
  const out = {};
  const files = fs.readdirSync(REPORTS).filter((f) => new RegExp(`^OneInc_\\d{8}_\\d{6}_${TIER}\\.json$`).test(f)).sort();
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(REPORTS, f), 'utf8')); } catch (_) { continue; }
    const m = /_(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)/.exec(f);
    const at = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
    for (const r of j.results || []) {
      if (!r.scenarioId || !/^(PASS|FAIL|BLOCKED)$/.test(r.status)) continue;
      out[r.scenarioId] = { status: r.status, at, text: JSON.stringify(r) };
    }
  }
  return out;
}

(async () => {
  const cfg = jiraConfig();
  if (!cfg) { log('Jira not configured (JIRA_EMAIL / JIRA_API_TOKEN) — nothing to do'); return; }
  const st = readState();
  const jql = `project = GCCM AND issuetype = Bug AND (text ~ "OneInc" OR text ~ "One Inc") AND status in (Closed, Done, Resolved) AND updated >= "${st.since}" ORDER BY updated DESC`;
  const bugs = (await searchJql(cfg, jql, ['summary', 'status', 'resolutiondate', 'updated']))
    .map((i) => ({ key: i.key, closed: (i.fields.resolutiondate || i.fields.updated || '').slice(0, 16), summary: i.fields.summary }))
    .filter((b) => !st.processed[b.key]);
  log(`${bugs.length} newly closed OneInc bug(s) not yet re-validated:`, bugs.map((b) => b.key).join(', ') || '-');
  if (bugs.length <= MIN && !DRY) { log(`waiting until more than ${MIN} have closed`); return; }

  const res = latestResults();
  const ids = [];
  for (const [id, r] of Object.entries(res)) {
    if (r.status === 'PASS') continue;
    const hit = bugs.find((b) => r.text.includes(`${b.key}`) && !id.startsWith(`${b.key}/`) && r.at < b.closed);
    if (hit) ids.push(id);
  }
  log(`${ids.length} failing case(s) linked to those bugs:`, ids.join(', ') || '-');
  if (DRY) return;
  if (ids.length) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'runOneInc.js'), '--ids', ids.join(','), '--headless'], { cwd: ROOT, stdio: 'inherit' });
    log('rerun finished, exit', r.status);
  }
  const now = new Date().toISOString();
  for (const b of bugs) st.processed[b.key] = { closed: b.closed, rerunAt: now, cases: ids.filter((id) => (res[id].text.includes(b.key))) };
  st.lastRun = now;
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
})().catch((e) => { console.error('[ClosedBugs] failed:', e.message); process.exit(1); });
