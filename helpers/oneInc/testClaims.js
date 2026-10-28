/**
 * helpers/oneInc/testClaims.js — the team's stock of NEW test claims (user direction 2026-10-27).
 *
 *  - Every claim scripts/provisionOneIncClaims.js creates lands in the claim pool as status "Unused".
 *  - The Runner's "Create test data" step (runOneInc.js --data-only) creates, ahead of time, the claims the selected
 *    scenarios will need — minus the Unused ones already in stock — without running any test.
 *  - A test run takes Unused claims first (oldest first) and marks them "Used" (run id, scenarios, who, when); it files
 *    new claims only for the shortfall. Payment / void / delete scenarios still get one claim each, read-only screen
 *    checks of a profile share one — so no claim is ever paid on twice.
 *  - The pool is mirrored to an Excel sheet on the share (TestData/OneInc_TestClaims_<tier>.xlsx) so the team can see
 *    which claims exist and which are free.
 * Claims made before this (no status) count as Used: they carry earlier payments.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const claimPicker = require('./claimPicker');

const SHEET_FILE = path.join(path.dirname(claimPicker.POOL_FILE), `OneInc_TestClaims_${(process.env.CC_TIER || 'test').toLowerCase()}.xlsx`);

// Claim types a new FNOL can produce; the rest (aged loss dates, checks OneInc already acknowledged) use existing claims.
function canFnol(profile) {
  const P = claimPicker.PROFILES[profile] || {};
  const f = P.fnol;
  return ['AUTO_PA', 'AUTO_MI', 'WC_PA', 'PROP_PA', 'PROP_MORT', 'AUTO_LIEN'].includes(profile) || !!P.fnolAs || !!(f && (f.exposures || []).length > 0);
}

// What the selected scenarios need, per claim type: payment scenarios one claim each, read-only ones one shared claim
// (shareFresh types: one claim for everything).
function plan(ids, RECIPES, isPaymentRecipe) {
  const out = {};
  for (const id of ids) {
    const profile = RECIPES[id].profile;
    const p = out[profile] = out[profile] || { profile, fresh: canFnol(profile), payIds: [], readIds: [] };
    const share = !!(claimPicker.PROFILES[profile] || {}).shareFresh;
    (share || !isPaymentRecipe(RECIPES[id]) ? p.readIds : p.payIds).push(id);
  }
  for (const p of Object.values(out)) {
    p.want = p.payIds.length + (p.readIds.length ? 1 : 0);
    p.unused = unused(p.profile);
    p.toCreate = p.fresh ? Math.max(0, p.want - p.unused.length) : 0;
  }
  return out;
}

// Unused, usable claims of a type, oldest first (so stock does not sit around).
function unused(profile) {
  return (claimPicker.readPool()[profile] || [])
    .filter((e) => e.usable && e.status === 'Unused')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((e) => e.claim);
}

// Mark claims Used by a run (re-read + write at once: the pool is shared by the team's Runners).
function markUsed(profile, claims, { runId, scenarios = [] } = {}) {
  if (!claims.length) return;
  const pool = claimPicker.readPool();
  const by = process.env.USERNAME || process.env.USER || '';
  for (const e of pool[profile] || []) {
    if (!claims.includes(e.claim)) continue;
    Object.assign(e, { status: 'Used', usedAt: new Date().toISOString(), usedBy: by, usedRun: runId, usedFor: scenarios.filter((s) => s.claim === e.claim).map((s) => s.id) });
  }
  fs.writeFileSync(claimPicker.POOL_FILE, JSON.stringify(pool, null, 2));
  exportSheet().catch(() => {});
}

// Excel mirror of the pool for the team (one row per claim). Never fails a run.
async function exportSheet() {
  try {
    const ExcelJS = require('exceljs');
    const pool = claimPicker.readPool();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Test claims');
    ws.columns = [
      { header: 'Claim', key: 'claim', width: 22 }, { header: 'Claim type', key: 'profile', width: 14 },
      { header: 'Status', key: 'status', width: 10 }, { header: 'Usable', key: 'usable', width: 8 },
      { header: 'Policy', key: 'policy', width: 13 }, { header: 'Loss date', key: 'lossDate', width: 11 },
      { header: 'Created', key: 'createdAt', width: 20 }, { header: 'Used at', key: 'usedAt', width: 20 },
      { header: 'Used by', key: 'usedBy', width: 12 }, { header: 'Run', key: 'usedRun', width: 28 },
      { header: 'Scenarios', key: 'usedFor', width: 40 }, { header: 'Problem', key: 'problem', width: 60 },
    ];
    const rows = [];
    for (const [profile, list] of Object.entries(pool)) {
      if (profile.startsWith('_') || !Array.isArray(list)) continue;
      for (const e of list) rows.push({ ...e, profile, status: e.status || 'Used', usable: e.usable ? 'Yes' : 'No', usedFor: (e.usedFor || []).join(', '), problem: e.usable ? '' : (e.problem || '') });
    }
    rows.sort((a, b) => (a.status === 'Unused' ? 0 : 1) - (b.status === 'Unused' ? 0 : 1) || a.profile.localeCompare(b.profile) || String(b.createdAt).localeCompare(String(a.createdAt)));
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = { from: 'A1', to: 'L1' };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    await wb.xlsx.writeFile(SHEET_FILE);
    return SHEET_FILE;
  } catch (e) { return null; }
}

// Create `count` new claims of a type (FNOL + declared data). Always as the .env adjuster (a claim created under su is
// owned by Super User — no examiner number, payments refused), assigned to Benjamin Smith unless CC_ASSIGNEE_NAME says
// otherwise. Resolves with the provisioner's exit code (3 = TEST is not filing claims right now).
function provision(profile, count, { log = console.log, headless = false } = {}) {
  const { spawn } = require('child_process');
  const root = path.join(__dirname, '..', '..');
  const dotenvUser = (() => { try { return require('dotenv').parse(fs.readFileSync(path.join(root, '.env'))); } catch (_) { return {}; } })();
  const env = { CC_ASSIGNEE_NAME: 'Benjamin Smith', ...process.env, ...(dotenvUser.CC_USER && dotenvUser.CC_PASS ? { CC_USER: dotenvUser.CC_USER, CC_PASS: dotenvUser.CC_PASS } : {}) };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'provisionOneIncClaims.js'), '--profiles', profile, '--count', String(count),
      ...(headless ? ['--headless'] : [])], { cwd: root, env });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) if (/^\[(Provision|TestData)\]/.test(line)) log(line);
    });
    child.stderr.on('data', () => {});
    child.on('close', resolve);
    child.on('error', () => resolve(1));
  });
}

module.exports = { canFnol, plan, unused, markUsed, exportSheet, provision, SHEET_FILE };
