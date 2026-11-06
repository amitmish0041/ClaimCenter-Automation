/**
 * helpers/financialRules.js — shared steps for tests/Financials/FinancialRules.test.js (the "Financials - 40 cases" +
 * "Remaining rules" QA workbooks, grouped per Financial_OneInc_Coverage_Review.xlsx). Cloud ClaimCenter only
 * (user direction 2026-11-05).
 *
 * Every test files its OWN claim: VTDMPL61 allows only 2 reserve actions per claim per day, so one claim cannot carry
 * a whole reserve ladder. A Bodily Injury Liability exposure is used on auto because it gets no initial reserve at FNOL
 * (Collision/Comprehensive/Rental do), leaving both same-day reserve actions for the rule under test.
 * Cloud: the standard user has no Reserve action, so reserves are made as the admin (as the LOB e2e specs do).
 */
'use strict';

const B = require('./claimCenterBase');
const { completeFNOL } = require('./fnolHelper');
const { assignClaim, createDocumentFromTemplate } = require('./claimLifecycleHelper');
const { repairCloud, TEAMS, loginIdFor, cannotView } = require('./e2eSteps');

// The Workplan grid is PAGED: ~15 "Check Returned Error" activities pushed the approval rows off page 1 and every
// reader saw "no approval activity" (PA-PA-01-26-0749042, 2026-11-06). These walk the pages.
const wpNext = (page) => page.locator('[id*="WorkplanLV"][id$="_ListPaging-next"], [id*="WorkplanLV-_ListPaging-next"]').first();
const wpFirst = (page) => page.locator('[id*="WorkplanLV"][id$="_ListPaging-first"], [id*="WorkplanLV-_ListPaging-first"]').first();
async function wpGoNext(page) {
  const n = wpNext(page);
  if (!await n.isVisible().catch(() => false) || await n.isDisabled().catch(() => true) || /disabled/.test((await n.getAttribute('class').catch(() => '')) || '')) return false;
  const before = await page.locator('tr[role="row"]:visible').nth(1).innerText().catch(() => '');
  await n.click().catch(() => {});
  for (let t = 0; t < 20; t++) { await page.waitForTimeout(500); if (await page.locator('tr[role="row"]:visible').nth(1).innerText().catch(() => '') !== before) return true; }
  return false;
}
// Opens the Workplan and leaves the page showing the first OPEN row whose text matches re; false when none on any page.
async function workplanPageWith(page, re) {
  await clickMenu(page, /^Workplan$/);
  await page.locator('tr[role="row"]').nth(1).waitFor({ timeout: 15000 }).catch(() => {});
  if (await wpFirst(page).isVisible().catch(() => false)) { await wpFirst(page).click().catch(() => {}); await page.waitForTimeout(1500); }
  for (let p = 0; p < 15; p++) {
    const hit = await page.locator('tr[role="row"]:visible').filter({ hasText: re }).filter({ hasText: /Open/ }).count();
    if (hit) return true;
    if (!await wpGoNext(page)) return false;
  }
  return false;
}

// The approval activity's "Assigned To" on the claim's Workplan (same read as e2eSteps.approverFor), any page.
async function approverFor(page) {
  await workplanPageWith(page, /approv/i);
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr[role="row"]')].filter((r) => r.offsetParent);
    const head = rows.find((r) => /\bAssigned To\b/.test(r.innerText));
    if (!head) return null;
    const cells = [...head.children].map((c) => (c.innerText || '').trim());
    const subj = cells.findIndex((c) => /^Subject$/.test(c)), to = cells.findIndex((c) => /^Assigned To$/.test(c));
    const row = rows.find((r) => r !== head && /\bOpen\b/.test(r.innerText) && /approv/i.test((r.children[subj] || {}).innerText || ''));
    return row ? ((row.children[to] || {}).innerText || '').replace(/\s+/g, ' ').trim() : null;
  });
}

const AUTO_AVOID = ['Collision', 'Comprehensive', 'Rental Reimbursment', 'Rental Reimbursement'];

const CLAIM_KINDS = {
  PA: (tag) => {
    const policyNumber = B.getNextPolicy('POLICY_PA_AUTO', tag);
    return {
      policyNumber, policyEnvVar: 'POLICY_PA_AUTO', policyType: 'Personal auto',
      lossDetails: { lossDate: B.getTestLossDate(1, policyNumber), lossState: B.getLossState(policyNumber, 'PA'), lossCauseCode: 'LC15', lossDescription: 'Financial rules ' + tag },
      exposures: [{ coverageLabel: 'Bodily Injury Liability', avoidLabels: AUTO_AVOID }],
    };
  },
  HO: (tag) => {
    const policyNumber = B.getNextPolicy('POLICY_HO_PA', tag);
    return {
      policyNumber, policyEnvVar: 'POLICY_HO_PA', policyType: "Homeowner's",
      lossDetails: { lossDate: B.getTestLossDate(1, policyNumber), lossState: B.getLossState(policyNumber, 'PA'), lossCauseCode: 'LC01', lossDescription: 'Financial rules ' + tag },
      exposures: [{ coverageLabel: ['Coverage A Dwelling', 'Coverage B Other Structures', 'Coverage C Personal Property', 'Coverage D Loss of Use'] }],
    };
  },
  WC: (tag) => {
    const policyNumber = B.getNextPolicy('POLICY_WC_PA', tag);
    return {
      policyNumber, policyEnvVar: 'POLICY_WC_PA', policyType: "Workers' comp",
      lossDetails: { lossDate: B.getTestLossDate(1, policyNumber), lossState: B.getLossState(policyNumber, 'PA'), lossCauseCode: 'LC07', lossDescription: 'Financial rules ' + tag },
      exposures: [{ coverageLabel: "Workers' Compensation And Employers' Liability" }],
    };
  },
};

// FNOL + assign + document + repair to Ability to pay — the set-up the LOB e2e specs do before any money step.
// Retries with the next policy (claimant-number pools and stuck wizards, as in TC-FIN-001).
async function newClaim(page, kind, tag) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await B.loginToClaimCenter(page);
      const cn = await completeFNOL(page, CLAIM_KINDS[kind](tag));
      if (!cn) throw new Error('FNOL returned no claim number');
      await assignClaim(page);
      await makeViewable(page, cn);
      await createDocumentFromTemplate(page);
      await repairCloud(page, cn);
      console.log(`${tag}: ${kind} claim ${cn}`);
      register(kind, cn);
      return cn;
    } catch (e) {
      lastError = e;
      console.log(`${tag}: FNOL attempt ${attempt + 1} failed (${String(e.message).split('\n')[0].slice(0, 120)}) — next policy`);
      await page.goto(B.BASE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }
  throw lastError;
}

// HO claims route to a group even the standard user can't see ("Cannot View Claim", HO-PA-01-26-0749028): assign the
// claim to Benjamin Smith as the admin, as e2eSteps.gate does for existing claims.
async function makeViewable(page, cn) {
  await B.openExistingClaim(page, cn).catch(() => {});
  if (!(await cannotView(page))) return;
  console.log(`${cn}: Cannot View Claim — assigning to Benjamin Smith as the admin`);
  await B.loginAsAdmin(page);
  await B.openExistingClaim(page, cn);
  await assignClaim(page, 'Benjamin Smith').catch((e) => console.log('assign failed — ' + String(e.message).split('\n')[0]));
  await B.loginToClaimCenter(page);
  await B.openExistingClaim(page, cn);
}

// ── Shared claims (user direction 2026-11-05: reuse claims, don't file one per case) ──────────────────────────────────
// Registry on disk so every worker and every later run reuses the same claims. Per claim: reserve actions used per day
// (VTDMPL61: 2 per claim per day) and whether a case changed it irreversibly (close / void). A case asks for a claim of
// a kind with N reserve actions left today; only when none has budget is a new claim filed.
const REG_FILE = require('path').join(__dirname, '..', 'results', 'financialRules_claims.json');
const LOCK = REG_FILE + '.lock';
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function withRegistry(fn) {
  const fsx = require('fs');
  for (let i = 0; i < 200; i++) {
    try { fsx.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  try {
    const reg = fsx.existsSync(REG_FILE) ? JSON.parse(fsx.readFileSync(REG_FILE, 'utf8')) : {};
    const out = fn(reg);
    fsx.writeFileSync(REG_FILE, JSON.stringify(reg, null, 2));
    return out;
  } finally { try { fsx.unlinkSync(LOCK); } catch {} }
}
function register(kind, cn, { reserveActionsToday = 1 } = {}) {
  withRegistry((reg) => {
    reg[kind] = reg[kind] || [];
    if (!reg[kind].some((e) => e.claim === cn)) reg[kind].push({ claim: cn, created: today(), reserves: { [today()]: reserveActionsToday }, done: false });
  });
}
// Take a claim of `kind` with `reserveActions` left today (claimed for this worker until released), else file one.
async function sharedClaim(page, kind, tag, { reserveActions = 0 } = {}) {
  const pick = withRegistry((reg) => {
    // Free = not irreversibly changed, not held by another worker (holds older than 3 h are from a dead run), and
    // enough same-day reserve budget left.
    const free = (reg[kind] || []).filter((e) => !e.done && (!e.busy || Date.now() - (e.busyAt || 0) > 3 * 3600000)
      && 2 - ((e.reserves || {})[today()] || 0) >= reserveActions);
    const e = free[0];
    if (!e) return null;
    e.busy = String(process.pid); e.busyAt = Date.now();
    e.reserves = e.reserves || {}; e.reserves[today()] = (e.reserves[today()] || 0) + reserveActions;
    return e.claim;
  });
  if (pick) {
    console.log(`${tag}: reusing ${kind} claim ${pick} (registry)`);
    await B.loginToClaimCenter(page);
    await makeViewable(page, pick);
    return pick;
  }
  const cn = await newClaim(page, kind, tag);
  withRegistry((reg) => { const e = (reg[kind] || []).find((x) => x.claim === cn); if (e) { e.busy = String(process.pid); e.busyAt = Date.now(); e.reserves[today()] += reserveActions; } });
  return cn;
}
function releaseClaim(cn, { done = false } = {}) {
  withRegistry((reg) => { for (const k of Object.keys(reg)) for (const e of reg[k]) if (e.claim === cn) { delete e.busy; delete e.busyAt; if (done) e.done = true; } });
}

async function asAdmin(page, cn) { await B.loginAsAdmin(page); await B.openExistingClaim(page, cn); }
async function asStandard(page, cn) { await B.loginToClaimCenter(page); await B.openExistingClaim(page, cn); }

// Team users from the EBT team list (e2eSteps TEAMS). The admin bypasses authority limits, so a reserve made as su
// proves nothing about approval rules — reserves go in as the LOB's claim rep when CC_TEAM_PASS (shared TEST password,
// environment only) is set; otherwise the admin, and the test says so.
const KIND_TEAM = { PA: 'Auto', HO: 'Property', WC: 'Workers Comp' };
const teamPass = () => process.env.CC_TEAM_PASS || '';
async function asTeam(page, cn, username) {
  await B.loginToClaimCenter(page, { username, password: teamPass() });
  await B.openExistingClaim(page, cn);
  console.log(`Team login: ${username} on ${cn}`);
}
// Log in as the claim rep for the claim's line to make a reserve; returns who it ran as.
// Reps first, then the supervisor: tomdavi's login never reached the Search menu on cloud TEST (2026-11-05).
async function asReserveUser(page, cn, kind) {
  const t = TEAMS[KIND_TEAM[kind]] || {};
  const users = teamPass() ? [...(t.rep || []), t.supervisor].filter(Boolean) : [];
  for (const u of users) {
    try {
      await asTeam(page, cn, u);
      // mikekrau logged in but landed on the Desktop — the claim wasn't viewable for him (HO-PA-01-26-0749023,
      // 2026-11-05). Same check e2eSteps uses; move on to the next team user.
      // Read the page text, not a locator: getByText(cn) matched a hidden copy and turned stepvarg away from a claim he
      // can open (PA-PA-01-26-0749029).
      if (await cannotView(page) || !(await page.evaluate((c) => document.body.innerText.includes(c), cn).catch(() => false))) {
        console.log(`Team login ${u}: cannot view ${cn} — next user`);
        continue;
      }
      return u;
    } catch (e) { console.log(`Team login ${u} failed — ${String(e.message).split('\n')[0]}`); }
  }
  await asAdmin(page, cn);
  return users.length ? `su (admin - team logins ${users.join('/')} failed; authority limits bypassed)` : 'su (admin - CC_TEAM_PASS not set, authority limits bypassed)';
}
// Approve (or Reject) the claim's open approval activity ("Review and approve reserve change", …) as whoever it is
// assigned to (first4+last4 login id — Scott Shenk → scotshen). Returns { approver, assignee, offered, result } or
// { approver: null, result: why }. offered = which of Approve / Reject the toolbar enabled for the ticked row.
async function approveAsAssignee(page, cn, subject = /approve/i, { action = 'Approve' } = {}) {
  await B.openExistingClaim(page, cn);
  const name = await approverFor(page).catch(() => null);
  if (!name) return { approver: null, assignee: null, result: 'no open approval activity on the Workplan' };
  if (!teamPass()) return { approver: null, result: `approval activity assigned to ${name}; CC_TEAM_PASS not set` };
  const id = loginIdFor(name);
  // Some team accounts are refused on cloud TEST with the shared password (mallredc, tomdavi, chenrema — "user
  // name/password is invalid", 2026-11-05): approve as the admin instead and say so in the result.
  let approver = id;
  try { await asTeam(page, cn, id); } catch (e) {
    console.log(`Approver login ${id} (${name}) refused — approving as the admin`);
    await asAdmin(page, cn);
    approver = `su (admin, for ${name} — ${id} login refused)`;
  }
  // Workplan toolbar Approve acts on the ticked rows (cloud TEST, 2026-11-05): tick the approval row, then Approve.
  await workplanPageWith(page, subject);
  // :visible — cloud keeps hidden copies of grid rows, and .first() landed on one (2026-11-05).
  const row = page.locator('tr[role="row"]:visible').filter({ hasText: subject }).first();
  if (!(await row.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false))) return { approver, result: `no open activity matching ${subject} for ${id}` };
  // The row checkbox is a styled control over a hidden input: .check() on the input never ticked it. Click the
  // visible control in the row's first cell, then confirm Approve enabled.
  const firstCell = row.locator('td').first();
  const visibleBox = firstCell.locator(':visible').last();
  await (await visibleBox.count() ? visibleBox : firstCell).click({ timeout: 8000 }).catch(() => firstCell.click({ force: true }).catch(() => {}));
  await page.waitForTimeout(1000);
  const offered = [];
  for (const b of ['Approve', 'Reject']) {
    if (await page.getByRole('button', { name: b, exact: true }).first().isEnabled().catch(() => false)) offered.push(b);
  }
  const btn = page.getByRole('button', { name: action, exact: true }).first();
  if (!offered.includes(action)) return { approver, assignee: name, offered, result: `approval row ticked but the ${action} button stayed disabled` };
  await btn.click();
  await page.waitForTimeout(3000);
  // Approve / Reject can open a short comment form with its own confirm button.
  const confirm = page.getByRole('button', { name: new RegExp(`^(${action}|Update|OK)$`) }).first();
  if (await confirm.isVisible().catch(() => false)) {
    const noteBox = page.locator('textarea:visible').first();
    if (await noteBox.isVisible().catch(() => false)) await noteBox.fill(`${action}d by automation (Financial rules suite)`).catch(() => {});
    await confirm.click().catch(() => {});
    await page.waitForTimeout(3000);
  }
  const msgs = await pageMessages(page);
  return { approver, assignee: name, offered, result: msgs.length ? msgs.join(' | ') : (action === 'Approve' ? 'approved' : 'rejected') };
}

// Every message ClaimCenter is showing right now: the validation panel (#gw-south-panel) plus inline messages.
async function pageMessages(page) {
  return page.evaluate(() => {
    const out = new Set();
    for (const el of document.querySelectorAll('#gw-south-panel, .gw-message, .gw-WebMessage, [class*="message--"]')) {
      if (!el.offsetParent) continue;
      for (const line of (el.innerText || '').split('\n')) { const t = line.trim(); if (t.length > 3) out.add(t); }
    }
    return [...out];
  }).catch(() => []);
}

// Left-nav item by its exact label. The role/class match alone left Financials > Summary on screen when
// "Transactions" was asked for (2026-11-05, PA-PA-01-26-0748998) — fall back to the visible label text.
async function clickMenu(page, re) {
  const cands = [
    page.locator('[role="menuitem"], .gw-action--inner').filter({ hasText: re }),
    page.locator('.gw-label, a, span, div').filter({ hasText: re }),
  ];
  for (const c of cands) {
    const n = await c.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 6); i++) {
      const el = c.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const txt = ((await el.innerText().catch(() => '')) || '').trim();
      if (!re.test(txt)) continue;
      await el.click({ timeout: 5000 }).catch(() => el.dispatchEvent('click').catch(() => {}));
      await page.waitForTimeout(1500);
      return true;
    }
  }
  console.log(`clickMenu: no visible item for ${re}`);
  return false;
}

// Waits for a real data row (one carrying a $ amount or a date), not just the header: an early read came back empty
// and a "raise by $9,000" turned into lowering BI $16,000 → $9,000 (PA-PA-01-26-0749032, 2026-11-05).
async function gridRows(page) {
  await page.locator('tr[role="row"]:visible').filter({ hasText: /\$[\d,]+\.\d\d|\d\d\/\d\d\/\d{4}/ }).first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  return page.evaluate(() => [...document.querySelectorAll('tr[role="row"]')]
    .filter((r) => r.offsetParent).map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean)).catch(() => []);
}

// Workplan rows (subject, status, assigned to …) of the claim. Reopens the claim first: after a team login the left
// nav can be off the claim, and the Desktop's activity list was read instead (HO-PA-01-26-0749008, 2026-11-05).
async function workplanRows(page, cn) {
  if (cn) await B.openExistingClaim(page, cn);
  await clickMenu(page, /^Workplan$/);
  return gridRows(page);
}

async function hasActivity(page, re, cn) {
  const rows = await workplanRows(page, cn);
  return { found: rows.some((r) => re.test(r)), rows };
}

// Financials > Transactions rows (date, amount, exposure, coverage, cost type/category, status, user).
async function transactionRows(page, cn) {
  if (cn) await B.openExistingClaim(page, cn);
  await clickMenu(page, /^Financials$/);
  await clickMenu(page, /^Transactions$/);
  return gridRows(page);
}

// Rows present now that weren't before (the transaction a step just created). Header row excluded.
function newRows(before, after) {
  const left = [...before];
  return after.filter((r) => { const i = left.indexOf(r); if (i >= 0) { left.splice(i, 1); return false; } return !/^Date Amount/.test(r); });
}

// Evidence for the report: one annotation per observation, so a pass/fail can be traced to what CC actually showed.
function note(testInfo, type, value) {
  const description = typeof value === 'string' ? value : JSON.stringify(value);
  testInfo.annotations.push({ type, description: description.slice(0, 1500) });
  console.log(`[${type}] ${description.slice(0, 400)}`);
}

// ── Evidence in the OneInc case-document shape (scripts/oneIncCaseReviews.js buildOne) ─────────────────────────────
// Each step / check gets a screenshot; afterEach writes fr-result.json next to the test's output, and
// scripts/financialRulesDocs.js turns those into one Word document per case.
const fs = require('fs');
function rec(ti) { return (ti._fr = ti._fr || { steps: [], shots: [], checks: [], claim: '', login: '' }); }
async function snap(page, ti, label) {
  const file = ti.outputPath(`${label.replace(/[^A-Za-z0-9_-]+/g, '_')}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return fs.existsSync(file) ? file : null;
}
async function step(page, ti, text) {
  const r = rec(ti);
  r.steps.push(text);
  r.shots.push(await snap(page, ti, `step-${r.steps.length}`));
  console.log(`[step ${r.steps.length}] ${text}`);
}
// Records the check (with what CC actually showed) BEFORE asserting, so a failing check still lands in the document.
async function check(page, ti, { description, expected, actual, ok }) {
  const r = rec(ti);
  const shot = await snap(page, ti, `check-${r.checks.length + 1}`);
  r.checks.push({ description, expected, actual: String(actual == null ? '' : actual).slice(0, 1500), result: ok ? 'PASS' : 'FAIL', screenshot: shot });
  require('@playwright/test').expect(ok, `${description} — expected: ${expected}; actual: ${String(actual).slice(0, 300)}`).toBeTruthy();
}
function setClaim(ti, claim, login) { const r = rec(ti); if (claim) r.claim = claim; if (login) r.login = login; }
function saveResult(ti, meta) {
  const r = rec(ti);
  const status = ti.status === 'passed' ? 'PASS' : ti.status === 'skipped' ? 'BLOCKED' : 'FAIL';
  const out = {
    ...meta, status, claim: r.claim, loginUsed: r.login, startedAt: new Date(Date.now() - ti.duration).toISOString(), durationMs: ti.duration,
    stepsExecuted: r.steps, stepShots: r.shots, checks: r.checks,
    notes: ti.annotations.filter((a) => a.type === 'manual').map((a) => a.description).join(' '),
    error: ti.error ? String(ti.error.message || '').split('\n')[0] : '', stack: ti.error ? String(ti.error.message || '').slice(0, 3000) : '',
    reason: ti.error ? String(ti.error.message || '').split('\n')[0] : '',
  };
  fs.writeFileSync(ti.outputPath('fr-result.json'), JSON.stringify(out, null, 2));
  return writeDoc(out).catch((e) => console.log(`Word document for ${out.scenarioId} not written: ${String(e.message).split('\n')[0]}`));
}

// The case's Word document, written AS THE CASE ENDS (screenshots still on disk): the next Playwright run wipes
// test-results/, which lost the run-7 passes on 2026-11-06. Latest run of a case overwrites its document; the result
// JSON is kept beside it. FIN_DOCS_DIR overrides the Desktop folder.
async function writeDoc(out) {
  const os = require('os');
  const path = require('path');
  const root = process.env.FIN_DOCS_DIR || path.join(os.homedir(), 'Desktop', 'Financial test cases', 'Results');
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dir = path.join(root, day);
  fs.mkdirSync(dir, { recursive: true });
  const base = String(out.scenarioId || 'case').replace(/[^A-Za-z0-9_-]+/g, '_');
  const { buildOne } = require('../scripts/oneIncCaseReviews');
  fs.writeFileSync(path.join(dir, `${base}.docx`), await buildOne(out, `FinancialRules_${day}`));
  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(out, null, 2));
  console.log(`Word document: ${path.join(dir, base + '.docx')} (${out.status})`);
}

// Approve level after level until no approval activity is left (Scott Shenk → Mallory Redcay for a $1.98M BI reserve,
// cloud TEST 2026-11-05). Returns the chain, e.g. [{approver:'scotshen',result:'approved'}, …].
async function approveAllLevels(page, cn, subject = /approve/i, max = 6, opts = {}) {
  const chain = [];
  for (let i = 0; i < max; i++) {
    const r = await approveAsAssignee(page, cn, subject);
    if (!r.approver) { if (!chain.length) chain.push(r); break; }
    chain.push(r);
    if (r.result !== 'approved') break;
    if (opts.onLevel) await opts.onLevel(r, chain.length);
    await page.waitForTimeout(4000);
  }
  return chain;
}

// One PA claim per day ASSIGNED TO stepvarg (Stephanie Vargas, Auto claim rep) for the payment-routing cases: approval
// routing follows the claim's owner/group, so checks entered by stepvarg on Benjamin Smith's claims went to Benjamin's
// group (Kevin Burke, 2026-11-06) — not a test of the Auto team chain (user direction 2026-11-06).
const SV_FILE = require('path').join(__dirname, '..', 'results', 'financialRules_stepvarg_claim.json');
async function stepvargClaim(page, tag) {
  const today = new Date().toLocaleDateString('en-CA');
  let rec = {};
  try { rec = JSON.parse(fs.readFileSync(SV_FILE, 'utf8')); } catch (_) {}
  if (rec.date === today && rec.cn && rec.assigned) return rec.cn;
  // Record the claim BEFORE assigning, so a failed assign never files a second claim (six were filed 2026-11-06).
  const cn = rec.date === today && rec.cn ? rec.cn : await newClaim(page, 'PA', tag);
  fs.mkdirSync(require('path').dirname(SV_FILE), { recursive: true });
  fs.writeFileSync(SV_FILE, JSON.stringify({ date: today, cn }, null, 2));
  await asAdmin(page, cn);
  await assignToUsername(page, 'stepvarg');
  await B.openExistingClaim(page, cn);
  const head = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (!/Adj: Stephanie Vargas/i.test(head)) throw new Error(`${cn} could not be assigned to Stephanie Vargas (header: ${(head.match(/Adj: [^)]*\)/) || ['?'])[0]})`);
  fs.writeFileSync(SV_FILE, JSON.stringify({ date: today, cn, assigned: true }, null, 2));
  console.log(`${tag}: PA claim ${cn} assigned to Stephanie Vargas`);
  return cn;
}

// Actions › Assign Claim › "Find a user or group" › Username search › Assign on the user's row. The "Select from list"
// dropdown only offers a handful of users (Stephanie Vargas is not in it); the search finds her in GC Team 2
// (parent General Casualty Mgr 1), CONFIRMED 2026-11-06.
async function assignToUsername(page, username) {
  const W = require('./oneInc/wizardDriver');
  await W.openActionsMenu(page);
  await page.getByRole('menuitem', { name: /^Assign Claim$/ }).first().click();
  await W.settle(page, 4000);
  await page.getByRole('radio').nth(1).click({ force: true });
  await W.settle(page, 2500);
  await page.locator('.gw-InputWidget').filter({ hasText: /^\s*Username/ }).locator('input').first().fill(username);
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await W.settle(page, 4000);
  const row = page.locator('tr:visible').filter({ has: page.getByRole('button', { name: 'Assign', exact: true }) }).filter({ hasNotText: /Select from list/ }).last();
  if (!await row.isVisible().catch(() => false)) throw new Error(`Assign Claim: username "${username}" not found`);
  console.log(`assignToUsername: ${(await row.innerText()).replace(/\s+/g, ' ').trim()}`);
  await row.getByRole('button', { name: 'Assign', exact: true }).first().click();
  await W.settle(page, 4000);
}

// Assigned To of every OPEN Workplan activity whose subject matches (e.g. /approve new payment/i), in list order.
async function openApprovalAssignees(page, subject = /approve new payment/i) {
  await workplanPageWith(page, /$^/); // opens the Workplan on page 1 (matches nothing, so it stops on the last page)
  if (await wpFirst(page).isVisible().catch(() => false)) { await wpFirst(page).click().catch(() => {}); await page.waitForTimeout(1500); }
  const all = [];
  for (let p = 0; p < 15; p++) {
    all.push(...await readAssignees(page, subject));
    if (!await wpGoNext(page)) break;
  }
  return all;
}
async function readAssignees(page, subject) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const rows = [...document.querySelectorAll('tr[role="row"]')].filter((r) => r.offsetParent);
    const head = rows.find((r) => /\bAssigned To\b/.test(r.innerText));
    if (!head) return [];
    const cells = [...head.children].map((c) => (c.innerText || '').trim());
    const subj = cells.findIndex((c) => /^Subject$/.test(c)), to = cells.findIndex((c) => /^Assigned To$/.test(c));
    return rows.filter((r) => r !== head && /\bOpen\b/.test(r.innerText) && re.test((r.children[subj] || {}).innerText || ''))
      .map((r) => ((r.children[to] || {}).innerText || '').replace(/\s+/g, ' ').trim());
  }, subject.source);
}

module.exports = { stepvargClaim, openApprovalAssignees, clickMenu, gridRows, sharedClaim, releaseClaim, register, makeViewable, approveAllLevels, step, check, setClaim, saveResult, newRows, CLAIM_KINDS, newClaim, asAdmin, asStandard, asTeam, asReserveUser, approveAsAssignee, approverFor, pageMessages, workplanRows, hasActivity, transactionRows, note };
