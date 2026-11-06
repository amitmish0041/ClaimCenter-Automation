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
// A NEGATIVE payment scenario: every validate step expects an error (the rule refuses Finish, so no payment is saved)
// and no step changes the claim (no finish / void / escalate / add / set / clear … call, no Finish click). Those share a
// claim, NEG_PER_CLAIM at a time, instead of one new claim each (user direction 2026-11-03: 76 new claims for
// 763+803 took ~11 min each).
const NEG_PER_CLAIM = Math.max(1, Number(process.env.ONEINC_NEG_PER_CLAIM || 5));
// prepare/change/assign/update/fix/deny/repair also edit the claim (prepareVinIncident left a shared claim failing
// Ability to pay for 803 TC-015/021/022/027, 2026-11-04).
const MUTATES = /finish|void|delete|create|ensure|escalate|clear|add|set|apply|unlink|remove|close|reopen|link|approve|reject|prepare|change|assign|update|fix|deny|repair/i;
function isNegativeOnly(recipe) {
  const all = [...((recipe && recipe.steps) || []), ...((recipe && recipe.checks) || [])].filter(Boolean);
  const vals = all.filter((s) => s.validate);
  if (!vals.length || vals.some((s) => !(s.validate && s.validate.expect))) return false;
  if (all.some((s) => typeof s.click === 'string' && /^finish$/i.test(s.click))) return false;
  // ContactManager vendor edits (reverted from the ledger) and picking a vendor change no claim data.
  const claimSafe = (fn) => /^contactManager\.|selectVendorByTaxId$|restoreVendors$/.test(fn);
  return !all.some((s) => Array.isArray(s.call) && !claimSafe(String(s.call[0])) && MUTATES.test(String(s.call[0])));
}
// A SIMPLE POSITIVE: submits one payment and only checks "no validation error" — no other check, no setup call that
// changes the claim, no Finish-observe / void / escalate. Those share a claim POS_PER_CLAIM at a time, each with its own
// amount (scenarioRunner shiftAmount), so CC's duplicate-payment check never matches (user direction 2026-11-03).
const POS_PER_CLAIM = Math.max(1, Number(process.env.ONEINC_POS_PER_CLAIM || 3));
function isSimplePositive(recipe) {
  const steps = (recipe && recipe.steps) || [];
  const vals = steps.filter((s) => s && s.validate);
  if (vals.length !== 1 || vals[0].validate.expect) return false;
  if (((recipe && recipe.checks) || []).length) return false;
  if (steps.some((s) => s && typeof s.click === 'string' && /^finish$/i.test(s.click))) return false;
  const okCall = (fn) => /^contactManager\.|selectVendorByTaxId$|restoreVendors$|fillRequired$/.test(fn);
  return !steps.some((s) => s && Array.isArray(s.call) && !okCall(String(s.call[0])));
}
// Groups of negative ids, NEG_PER_CLAIM per claim.
const negGroups = (negIds) => { const g = []; for (let i = 0; i < negIds.length; i += NEG_PER_CLAIM) g.push(negIds.slice(i, i + NEG_PER_CLAIM)); return g; };

function plan(ids, RECIPES, isPaymentRecipe) {
  const out = {};
  for (const id of ids) {
    const profile = RECIPES[id].profile;
    const p = out[profile] = out[profile] || { profile, fresh: canFnol(profile), payIds: [], negIds: [], posIds: [], readIds: [] };
    const share = !!(claimPicker.PROFILES[profile] || {}).shareFresh;
    if (share || !isPaymentRecipe(RECIPES[id])) p.readIds.push(id);
    else if (isNegativeOnly(RECIPES[id])) p.negIds.push(id);
    else if (isSimplePositive(RECIPES[id])) p.posIds.push(id);
    else p.payIds.push(id);
  }
  for (const p of Object.values(out)) {
    p.negGroups = negGroups(p.negIds);
    p.posGroups = []; for (let i = 0; i < p.posIds.length; i += POS_PER_CLAIM) p.posGroups.push(p.posIds.slice(i, i + POS_PER_CLAIM));
    p.want = p.payIds.length + p.negGroups.length + p.posGroups.length + (p.readIds.length ? 1 : 0);
    p.unused = unused(p.profile);
    p.toCreate = p.fresh ? Math.max(0, p.want - p.unused.length) : 0;
  }
  return out;
}

// Unused, usable claims of a type, oldest first (so stock does not sit around).
// A claim another run is building for itself (reservedFor, set while it provisions) is not stock for anyone else —
// concurrent runs took each other's new claims ("only 2 of 3 new AUTO_PA claim(s)", 2026-11-03). Reservations older
// than 12 h (a run that died) are released.
function unused(profile, runId = '') {
  const stale = (e) => !e.createdAt || Date.now() - new Date(e.createdAt).getTime() > 12 * 3600000;
  return (claimPicker.readPool()[profile] || [])
    .filter((e) => e.usable && e.status === 'Unused' && (!e.reservedFor || e.reservedFor === runId || stale(e)))
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
// Claims are built by up to ONEINC_PROVISION_WORKERS (default 3) browsers at once, each on its own slice of the policy
// list (~11 min a claim, one at a time made 76 claims a 14-hour job — 2026-11-03). Resolves with the worst exit code.
const PROVISION_WORKERS = Math.max(1, Math.min(4, Number(process.env.ONEINC_PROVISION_WORKERS || 3)));
async function provision(profile, count, opts = {}) {
  const w = Math.min(PROVISION_WORKERS, count);
  if (w <= 1) return provisionOne(profile, count, opts);
  const share = (k) => Math.floor(count / w) + (k < count % w ? 1 : 0);
  const codes = await Promise.all([...Array(w).keys()].map((k) => new Promise((r) => setTimeout(r, k * 20000))
    .then(() => provisionOne(profile, share(k), { ...opts, slice: `${k}/${w}` }))));
  return codes.includes(3) ? 3 : Math.max(...codes.map((c) => Number(c) || 0));
}
function provisionOne(profile, count, { log = console.log, headless = false, slice = '', runId = '' } = {}) {
  const { spawn } = require('child_process');
  const root = path.join(__dirname, '..', '..');
  const dotenvUser = (() => { try { return require('dotenv').parse(fs.readFileSync(path.join(root, '.env'))); } catch (_) { return {}; } })();
  const env = { CC_ASSIGNEE_NAME: 'Benjamin Smith', ...process.env, ...(dotenvUser.CC_USER && dotenvUser.CC_PASS ? { CC_USER: dotenvUser.CC_USER, CC_PASS: dotenvUser.CC_PASS } : {}), ...(slice ? { ONEINC_PROVISION_SLICE: slice } : {}), ...(runId ? { ONEINC_RESERVED_FOR: runId } : {}) };
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
    // A builder that dies says so in the run log: one of three crashed silently and the run got 5 of 8 claims (2026-11-06).
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-2000); });
    child.on('close', (code) => {
      if (code && code !== 3) log(`[Provision] ${profile}${slice ? ` builder ${slice}` : ''}: exited with code ${code}${err.trim() ? ` — ${err.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 600)}` : ''}`);
      resolve(code);
    });
    child.on('error', () => resolve(1));
  });
}

module.exports = { canFnol, plan, unused, markUsed, exportSheet, provision, SHEET_FILE, isNegativeOnly };
