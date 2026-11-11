/**
 * helpers/regression/regressionSteps.js — shared steps for tests/Regression/*.regression.test.js, the 85-case
 * "Regression Test Design - V1.0" workbook (Traceability sheet, 36 cards/features). CLOUD ClaimCenter only, like the
 * Runner's Claims tab.
 *
 * This file is glue, not a new framework: every screen action comes from an existing helper —
 *   claimCenterBase (login / search / tabs), fnolHelper.completeFNOL, claimLifecycleHelper (assign, close),
 *   financialsHelper (reserves), financialRules (shared-claim registry, Workplan/Transactions readers, evidence
 *   steps/checks, approval chains), financialPayments.makePayment, e2eSteps (cannotView, recovery, subrogation),
 *   oneInc/wizardDriver + oneInc/screenReader (label-driven fields, menus, Blocked), oneInc/checkOps (void, history).
 * The only thing added here is what no helper had: catalog metadata, result files the Runner reads, claim creation
 * for LOBs financialRules.CLAIM_KINDS doesn't cover, claim search by Policy #, and a batch runner generalised from
 * checkOps.runFinancialsEscalation.
 *
 * Status vocabulary (same as the OneInc / Financial-rules documents): PASS, FAIL, BLOCKED (a prerequisite — test
 * data, permission, configuration — was missing, so the rule was never exercised; recorded as a skip).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('../claimCenterBase');
const R = require('../financialRules');
const E = require('../e2eSteps');
const W = require('../oneInc/wizardDriver');
const { readScreen, findField, norm } = require('../oneInc/screenReader');
const { completeFNOL } = require('../fnolHelper');
const { assignClaim } = require('../claimLifecycleHelper');
const A = require('../oneInc/setupA');

const CATALOG = require('./catalog.json');
const BY_ID = Object.fromEntries(CATALOG.map((c) => [c.id, c]));
const RESULTS_DIR = path.join(__dirname, '..', '..', 'results', 'regression');
const RUN_ID = process.env.REG_RUN_ID || `Regression_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;

// "RG-TC007 [Intake FNOL]: …" → "TC007"
const idOf = (title) => ((String(title).match(/RG-((?:TC|RX)\d{3})\b/) || [])[1]) || null;
const meta = (id) => BY_ID[id] || {};

// ── Results the Runner reads (results/regression/latest/<TC>.json + history.jsonl) ─────────────────────────────────
// financialRules.saveResult already writes fr-result.json (steps, checks, screenshots) next to the test output; the same
// object is copied to a stable place keyed by TC id, so the Regression tab shows a last status without scanning
// test-results/ (Playwright clears that folder on every run).
function saveResult(ti) {
  const id = idOf(ti.title);
  if (!id) return;
  const m = meta(id);
  R.saveResult(ti, { scenarioId: id, tcId: id, story: 'Regression Test Design - V1.0', storyTitle: m.feature, name: m.name, expected: m.limitation ? `Automation scope: ${m.status}. ${m.limitation}` : '' });
  let out = {};
  try { out = JSON.parse(fs.readFileSync(ti.outputPath('fr-result.json'), 'utf8')); } catch (_) { /* saveResult failed — still record status */ }
  const reason = ti.status === 'skipped' ? (ti.annotations.find((a) => a.type === 'skip') || {}).description || '' : out.reason || '';
  const rec = { ...out, tcId: id, feature: m.feature, automation: m.status, status: out.status || (ti.status === 'passed' ? 'PASS' : ti.status === 'skipped' ? 'BLOCKED' : 'FAIL'), reason, runId: RUN_ID, finishedAt: new Date().toISOString(), env: { tier: B.TIER, platform: B.ENV }, outputDir: ti.outputDir };
  fs.mkdirSync(path.join(RESULTS_DIR, 'latest'), { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, 'latest', `${id}.json`), JSON.stringify(rec, null, 2));
  fs.appendFileSync(path.join(RESULTS_DIR, 'history.jsonl'), JSON.stringify({ tcId: id, status: rec.status, reason: String(reason).slice(0, 300), claim: rec.claim || '', runId: RUN_ID, finishedAt: rec.finishedAt, durationMs: ti.duration }) + '\n');
}

// Standard hooks for every regression spec: cloud only, evidence saved, shared claims released.
// Cases that poll (ISO, Hi Marley opt-in), run tier batches, or file several claims / close one: 40 minutes, not 20.
const LONG = /RG-(TC0(29|35|37|40|45|53|54|55|56|57|62|63|69)|RX0(0[6-9]|1[7-9]))\b/;
function hooks(test) {
  test.setTimeout(1_200_000);
  test.skip(!E.IS_CLOUD, 'Regression suite runs on cloud ClaimCenter (CC_ENV=cloud)');
  // Every case files claims, payments or contacts — never anywhere but the TEST / DEV tiers.
  test.skip(!['test', 'dev'].includes(String(B.TIER).toLowerCase()), `Regression suite writes test data — TEST/DEV tiers only (CC_TIER=${B.TIER})`);
  test.beforeEach(async ({}, ti) => { if (LONG.test(ti.title)) ti.setTimeout(2_400_000); });
  test.afterEach(async ({}, ti) => {
    saveResult(ti);
    if (ti._fr && ti._fr.claim) R.releaseClaim(ti._fr.claim);
  });
}

// .env placeholders ("XXXX-000017" - no real policy in the data sheet) count as not set, so the case is BLOCKED instead of
// filing a claim against a made-up policy number.
const envVal = (k) => { const v = String(process.env[k] || '').trim(); return /XXXX/i.test(v) ? '' : v; };

// A missing prerequisite → BLOCKED (skip with the reason), never a false FAIL.
function need(test, ...vars) {
  const missing = vars.filter((v) => !envVal(v));
  test.skip(missing.length > 0, `BLOCKED: set ${missing.join(', ')} (test data / configuration for this case)`);
  return vars.map((v) => process.env[v]);
}
// Cases that send data to an outside system (Metro, Symbility) run only when explicitly allowed.
function external(test, what) {
  test.skip(process.env.REG_ALLOW_EXTERNAL !== '1', `BLOCKED: sends a real request to ${what} — run with REG_ALLOW_EXTERNAL=1`);
}
// Wrap a body so a W.Blocked (prerequisite missing on the screen) becomes BLOCKED instead of FAIL.
async function blockable(test, fn) {
  try { return await fn(); } catch (e) {
    if (e && e.name === 'Blocked') { test.info().annotations.push({ type: 'manual', description: e.message }); test.skip(true, `BLOCKED: ${e.message}`); }
    throw e;
  }
}

// ── Claims ────────────────────────────────────────────────────────────────────────────────────────────────────────
// financialRules.CLAIM_KINDS covers PA/HO/WC; the Intake FNOL cases need every LOB, with a SPECIFIC assignment type and
// loss cause (fnolHelper's opt-in lossDetails.assignmentType / lossCause). policyVar names follow fixtures/testData.js.
// Liability coverages: cloud's New Exposure tree lists "Bodily Injury Liability" under the GL subline, not
// "Premises/Operations" (CPP-PA, 2026-11-10) - the older names stay first for policies that still carry them.
const KINDS = {
  PA_OH: { policyVar: 'POLICY_PA_AUTO_OH', state: 'OH', policyType: 'Personal auto', cause: 'LC15', exposures: [{ coverageLabel: 'Transportation Expense' }] },
  PA_WI: { policyVar: 'POLICY_PA_AUTO_WI', state: 'WI', policyType: 'Personal auto', cause: 'LC15', exposures: [{ coverageLabel: 'Collision' }] },
  PA:    { policyVar: 'POLICY_PA_AUTO', state: 'PA', policyType: 'Personal auto', cause: 'LC15', exposures: [{ coverageLabel: 'Collision' }] },
  CA_DE: { policyVar: 'POLICY_CAU_DE', state: 'DE', policyType: 'Commercial auto', cause: 'LC15', exposures: [{ coverageLabel: ['Silver Series or MicPak', 'Silver Series/MicPak'] }] },
  CA:    { policyVar: 'POLICY_CAU_PA', state: 'PA', policyType: 'Commercial auto', cause: 'LC15', exposures: [{ coverageLabel: 'Collision' }] },
  WC_MI: { policyVar: 'POLICY_WC_MI', state: 'MI', policyType: "Workers' comp", cause: 'LC07', exposures: [{ coverageLabel: "Workers' Compensation And Employers' Liability" }] },
  PEL:   { policyVar: 'POLICY_PEL_PA', state: 'PA', policyType: 'Personal Excess', cause: 'LC03', exposures: [{ coverageLabel: ['Personal Excess Liability', 'Bodily Injury Liability'] }] },
  IM:    { policyVar: 'POLICY_IM_PA', state: 'PA', policyType: 'Inland Marine', cause: 'LC40', exposures: [{ coverageLabel: ['Inland Marine All Other', 'Inland Marine, All Other'] }] },
  GL:    { policyVar: 'POLICY_GL_IA', state: 'IA', policyType: 'General Liability', cause: 'LC03', exposures: [{ coverageLabel: ['Premises/Operations', 'Products/Completed Operations', 'Bodily Injury Liability'] }] },
  FARM:  { policyVar: 'POLICY_FARM_PA', state: 'PA', policyType: "Farmowner's", cause: 'LC01', exposures: [{ coverageLabel: ['Farmowners, Building', 'Farmowners Building'] }] },
  BOAT:  { policyVar: 'POLICY_BOAT_MI', state: 'MI', policyType: "Boatowner's", cause: 'LC40', exposures: [{ coverageLabel: ['Inland Marine, All Other', 'Inland Marine All Other'] }] },
  CP:    { policyVar: 'POLICY_CP_PA', state: 'PA', policyType: 'Commercial Package', cause: 'LC03', exposures: [{ coverageLabel: ['Premises/Operations', 'Bodily Injury Liability'] }] },
  BOP:   { policyVar: 'POLICY_BOP_PA', state: 'PA', policyType: 'BOP', cause: 'LC03', exposures: [{ coverageLabel: ['Business Liability', 'Bodily Injury Liability'] }] },
  HO:    { policyVar: 'POLICY_HO_PA', state: 'PA', policyType: "Homeowner's", cause: 'LC01', exposures: [{ coverageLabel: 'Coverage A Dwelling' }] },
  DF:    { policyVar: 'POLICY_DF_PA', state: 'PA', policyType: 'Dwelling Fire', cause: 'LC01', exposures: [{ coverageLabel: 'Coverage A Dwelling' }] },
  CEL:   { policyVar: 'POLICY_CEL_PA', state: 'PA', policyType: 'Commercial Excess', cause: 'LC03', exposures: [{ coverageLabel: ['Commercial Excess Liability', 'Bodily Injury Liability'] }] },
  WC:    { policyVar: 'POLICY_WC_PA', state: 'PA', policyType: "Workers' comp", cause: 'LC07', exposures: [{ coverageLabel: "Workers' Compensation And Employers' Liability" }] },
};

// The "New Claim Saved" page completeFNOL leaves showing carries the routing result ("Assigned Group: … / Assigned
// User: …" — CONFIRMED in claimLifecycleHelper.assignClaim). Read it BEFORE navigating anywhere else.
async function savedAssignment(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  let group = ((body.match(/Assigned Group:\s*([^\n]+)/i) || [])[1] || '').trim();
  let user = ((body.match(/Assigned User:\s*([^\n]+)/i) || [])[1] || '').trim();
  // Some LOBs (WC) land on the claim Summary instead of New Claim Saved — read the info bar "Adj: User (Group)".
  if (!group) {
    const adj = body.match(/Adj:\s*([^\n(]+?)\s*\(([^)\n]+)\)/);
    if (adj) { user = user || adj[1].trim(); group = adj[2].trim(); }
  }
  return { group, user };
}

// Policies from the team's claim inventory (the spreadsheet OneInc / SmartCOMM / the E2E pool use): a real claim of the
// same LOB + state proves the policy exists in the cloud tier, and its loss date + 2 days is inside the policy term.
// The .env lists hold many policies the cloud tier doesn't have (legacy numbers, expired terms), so the inventory goes
// first and the .env rotation is the fallback. REG_POLICY_FROM_INVENTORY=0 turns it off.
const INVENTORY_PREFIX = {
  PA_OH: 'PA-OH-', PA_WI: 'PA-WI-', PA: 'PA-PA-', CA_DE: 'CA-DE-', CA: 'CA-PA-', WC_MI: 'WC-MI-', PEL: 'PXL-PA-',
  IM: 'IMP-PA-', GL: 'GL-', FARM: 'FOP-PA-', BOAT: 'BT-MI-', CP: 'CPP-PA-', BOP: 'BOP-PA-', HO: 'HO-PA-', DF: 'DFP-PA-',
  CEL: 'CXL-PA-', WC: 'WC-PA-',
};
let inventoryRows;
function inventoryPolicies(kind) {
  const prefix = INVENTORY_PREFIX[kind];
  if (!prefix || process.env.REG_POLICY_FROM_INVENTORY === '0') return [];
  try { inventoryRows = inventoryRows || require('../smartComm/testDataService').getAllRecords(); } catch (e) {
    console.log(`Claim inventory not readable (${String(e.message).split('\n')[0]}) — using the .env policy list`);
    inventoryRows = [];
  }
  const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const seen = new Set();
  return inventoryRows
    .filter((r) => String(r.claimNumber || '').startsWith(prefix) && r.policyNumber && !isNaN(new Date(r.lossDate)))
    .sort((a, b) => new Date(b.lossDate) - new Date(a.lossDate)) // newest losses first — current terms
    .filter((r) => !seen.has(String(r.policyNumber)) && seen.add(String(r.policyNumber)))
    .map((r) => { const d = new Date(r.lossDate); d.setDate(d.getDate() + 2); return { policy: String(r.policyNumber), lossDate: fmt(d > yesterday ? yesterday : d), basedOn: r.claimNumber }; });
}

// FNOL for any KIND. opts: { assignmentType, lossCause, exposures, withExposures=true }. Returns { cn, group, user }.
// Tries inventory policies first, then the env-var rotation, like financialRules.newClaim.
async function fileClaim(page, kind, tag, opts = {}) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown claim kind ${kind}`);
  const inv = inventoryPolicies(kind);
  if (!inv.length && !(envVal(k.policyVar) || envVal(`${k.policyVar}_${B.TIER.toUpperCase()}`))) {
    throw new W.Blocked(`no ${kind} policy — none in the claim inventory (${INVENTORY_PREFIX[kind] || 'n/a'}) and ${k.policyVar} not set in ClaimCenter-Automation/.env`);
  }
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await B.loginToClaimCenter(page);
      const fromInv = inv[attempt];
      if (!fromInv && !(envVal(k.policyVar) || envVal(`${k.policyVar}_${B.TIER.toUpperCase()}`))) throw last || new W.Blocked(`no more ${kind} policies to try`);
      const policyNumber = fromInv ? fromInv.policy : B.getNextPolicy(k.policyVar, tag);
      if (fromInv) console.log(`${tag}: policy ${fromInv.policy} from claim inventory (${fromInv.basedOn}), loss date ${fromInv.lossDate}`);
      const cn = await completeFNOL(page, {
        policyNumber, policyEnvVar: k.policyVar, policyType: k.policyType,
        lossDetails: {
          lossDate: fromInv ? fromInv.lossDate : B.getTestLossDate(1, policyNumber), lossState: B.getLossState(policyNumber, k.state),
          lossCauseCode: k.cause, lossDescription: `Regression ${tag}`,
          assignmentType: opts.assignmentType || '', lossCause: opts.lossCause || '',
        },
        exposures: opts.withExposures === false ? [] : (opts.exposures || k.exposures),
      });
      if (!cn) throw new Error('FNOL returned no claim number');
      const routed = await savedAssignment(page);
      await assignClaim(page).catch(() => {});
      await R.makeViewable(page, cn);
      console.log(`${tag}: ${kind} claim ${cn} — routed to ${routed.group || '?'} / ${routed.user || '?'}`);
      // Every freshly filed claim is offered to the pool, so later read-mostly cases reuse it instead of filing again.
      // opts.pool === false keeps it out (claims a case is going to close, drain or otherwise use up).
      if (opts.pool !== false) poolAdd(opts.poolKey || kind, { cn, policyNumber, ...routed });
      return { cn, policyNumber, ...routed };
    } catch (e) {
      last = e;
      if (e && e.name === 'Blocked') throw e;
      console.log(`${tag}: FNOL attempt ${attempt + 1} failed (${String(e.message).split('\n')[0].slice(0, 140)}) — next policy`);
      // A draft wizard left open made the next page.goto hang for 60 s, so attempts 2-3 died on navigation, not the
      // policy (2026-11-10). Cancel the wizard (accepting its "unsaved work" confirm) before navigating.
      const accept = (d) => d.accept().catch(() => {});
      page.on('dialog', accept);
      await page.getByRole('button', { name: /^Cancel$/i }).first().click({ timeout: 3000 }).catch(() => {});
      await page.getByRole('button', { name: /^(OK|Yes)$/i }).first().click({ timeout: 2000 }).catch(() => {});
      // A legacy policy lookup still running server-side holds the session, so every navigation queues behind it (TC011
      // IMP-9400001 / TC013 FOP-0011661, 2026-11-10). Start a fresh session; the next attempt logs in again.
      await page.context().clearCookies().catch(() => {});
      await page.goto(B.BASE_URL, { waitUntil: 'commit', timeout: 90000 }).catch(() => {});
      page.off('dialog', accept);
    }
  }
  throw last;
}

// ── Claim pool: one FNOL per LOB, shared by the scenarios that only read or add to a claim ─────────────────────────
// results/regression/claim-pool.json: { "<tier>": { "<key>": [{ cn, policyNumber, group, user, created }] } }.
// key = claim kind (PA, HO, CP …) unless a case needs something special (poolKey 'CA:BI' = Commercial Auto with a BI
// exposure). A filed FNOL takes ~4–6 minutes, so the Intake FNOL cases (which MUST file) feed the pool and everything
// read-mostly draws from it. Entries expire after REG_CLAIM_POOL_DAYS (default 5); REG_CLAIM_POOL=0 turns reuse off.
// Cases that close / drain / reassign a claim, or assert "a NEW activity appeared", file their own with pool:false.
const POOL_FILE = path.join(RESULTS_DIR, 'claim-pool.json');
const poolRead = () => { try { return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); } catch (_) { return {}; } };
const poolWrite = (o) => { fs.mkdirSync(RESULTS_DIR, { recursive: true }); fs.writeFileSync(POOL_FILE, JSON.stringify(o, null, 2)); };
function poolAdd(key, rec) {
  const o = poolRead(); const t = (o[B.TIER] = o[B.TIER] || {});
  (t[key] = t[key] || []).unshift({ ...rec, created: new Date().toISOString() });
  t[key] = t[key].slice(0, 5);
  poolWrite(o);
}
function poolDrop(key, cn) {
  const o = poolRead(); const t = o[B.TIER] || {};
  if (t[key]) { t[key] = t[key].filter((x) => x.cn !== cn); poolWrite(o); }
}
function poolFresh(key) {
  if (process.env.REG_CLAIM_POOL === '0') return [];
  const maxAge = (Number(process.env.REG_CLAIM_POOL_DAYS) || 5) * 86400000;
  return (((poolRead()[B.TIER] || {})[key]) || []).filter((x) => Date.now() - new Date(x.created) < maxAge);
}
// A claim of `kind` from the pool (opened and made viewable), else a fresh FNOL that joins the pool.
// Returns { cn, policyNumber, group, user, reused }.
async function pooledClaim(page, kind, tag, opts = {}) {
  const key = opts.poolKey || kind;
  for (const rec of poolFresh(key)) {
    try {
      await B.loginToClaimCenter(page);
      await R.makeViewable(page, rec.cn);
      const closed = /St:\s*Closed/i.test(await page.locator('body').innerText().catch(() => ''));
      if (closed) { poolDrop(key, rec.cn); continue; }
      console.log(`${tag}: reusing ${key} claim ${rec.cn} (regression pool, filed ${rec.created.slice(0, 10)})`);
      return { ...rec, reused: true };
    } catch (e) {
      console.log(`${tag}: pooled ${key} claim ${rec.cn} unusable (${String(e.message).split('\n')[0].slice(0, 100)}) — dropped`);
      poolDrop(key, rec.cn);
    }
  }
  return { ...(await fileClaim(page, kind, tag, opts)), reused: false };
}

// A claim to work on: the env var's claim when set, else a shared registry claim (PA/HO/WC), else a fresh FNOL.
async function claimFor(page, ti, envVar, kind, tag) {
  const given = envVal(envVar);
  let cn;
  if (given) {
    await B.loginToClaimCenter(page);
    await R.makeViewable(page, given);
    cn = given;
    await R.step(page, ti, `Opened existing claim ${cn} (${envVar})`);
  } else if (R.CLAIM_KINDS[kind]) {
    cn = await R.sharedClaim(page, kind, tag);
    await R.step(page, ti, `Using shared ${kind} test claim ${cn}`);
  } else {
    const c = await pooledClaim(page, kind, tag);
    cn = c.cn;
    await R.step(page, ti, c.reused ? `Using pooled ${kind} claim ${cn}` : `Filed a new ${kind} claim ${cn}`);
  }
  R.setClaim(ti, cn, process.env.CC_USER || '');
  return cn;
}

// Policy Prefix – Jurisdiction State – Office Code – YY reported – sequence (e.g. WC-IA-60-16-0005719).
function claimNumberFormat(cn, reported = new Date()) {
  const m = String(cn || '').match(/^([A-Z]{2,4})-([A-Z]{2})-(\d{2})-(\d{2})-(\d{7})$/);
  return { ok: !!m && m[4] === String(reported.getFullYear()).slice(-2), parts: m ? { prefix: m[1], state: m[2], office: m[3], year: m[4], seq: m[5] } : null };
}

// ── Screens ───────────────────────────────────────────────────────────────────────────────────────────────────────
const nav = (page, label) => R.clickMenu(page, label instanceof RegExp ? label : new RegExp(`^${label}$`, 'i'));
const bodyText = (page) => page.locator('body').innerText().catch(() => '');
const field = async (page, label) => findField(await readScreen(page), label);

// Actions menu item by text (W.openActionsMenu lists them). Throws Blocked with what WAS offered.
async function action(page, re) {
  const items = await W.openActionsMenu(page);
  const hit = items.find((t) => re.test(t));
  if (!hit) { await W.closeMenus(page); throw new W.Blocked(`Actions menu has no ${re} (offered: ${items.join(' | ').slice(0, 400)})`); }
  await page.locator('[role=menuitem]').filter({ hasText: hit }).first().click();
  await W.settle(page, 3000);
  return hit;
}

// Edit → (fn) → Update on a detail screen; Cancel + Blocked with CC's messages if Update is refused.
async function editAndUpdate(page, fn, what = 'screen') {
  await W.clickButton(page, 'Edit');
  await fn();
  for (let i = 0; i < 3; i++) {
    await W.clickButton(page, 'Update').catch(() => {});
    const editing = await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false);
    if (!editing) return { saved: true, messages: await R.pageMessages(page) };
  }
  const msgs = await R.pageMessages(page);
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
  return { saved: false, messages: msgs, what };
}

// Search › Claims with Claim # or Policy #. Same Search-nav candidates claimCenterBase.openExistingClaim uses (cloud
// exposes only aria-label="Search" in some builds). Returns { headers, rows, screen }.
async function searchClaims(page, { claim, policy }) {
  await page.goto(B.BASE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await B.waitForAllMasksGone(page, 30000);
  for (const nav of [page.locator('[aria-label="Search"]').first(), page.getByRole('menuitem', { name: /^Search$/ }).first(), page.getByRole('link', { name: /^Search$/ }).first()]) {
    if (await nav.isVisible().catch(() => false)) { await nav.click({ timeout: 8000 }).catch(() => {}); break; }
  }
  const box = page.getByRole('textbox', { name: claim ? 'Claim #' : 'Policy #' }).first();
  if (!(await box.waitFor({ state: 'visible', timeout: 45000 }).then(() => true).catch(() => false))) throw new W.Blocked(`Search Claims screen has no "${claim ? 'Claim #' : 'Policy #'}" box`);
  await box.fill(claim || policy);
  await page.getByRole('button', { name: /^Search$/ }).last().click().catch(() => page.locator('[aria-label="Search"]').last().click());
  await W.settle(page, 4000);
  const screen = await readScreen(page);
  const rows = await R.gridRows(page);
  return { headers: screen.headers, rows: rows.filter((r) => !/^Claim\s+Insured/i.test(r)), screen };
}

// Server Tools › Batch Process Info › Run <name>, as the admin in a separate context — the flow checkOps
// .runFinancialsEscalation proved on cloud TEST, with the batch name as a parameter (Bulk Invoice Escalation …).
// `name` may be a string (row starts with it) or a RegExp (batch names differ slightly between tiers:
// /Bank of America.*Intake/i). A REG_BATCH_<KEY> env var can override the name a case asks for (see batchName).
async function runBatchProcess(page, name) {
  const user = process.env.CC_ADMIN_USER, pass = process.env.CC_ADMIN_PASS;
  if (!user || !pass) throw new W.Blocked(`run the "${name}" batch first — CC_ADMIN_USER / CC_ADMIN_PASS are not set`);
  // Batches act on the whole tier (every pending inbound file / bulk invoice), so they only run when allowed.
  if (process.env.REG_ALLOW_BATCHES !== '1') throw new W.Blocked(`running the "${name}" batch affects the whole tier — set REG_ALLOW_BATCHES=1 to allow it`);
  const rowRe = name instanceof RegExp ? name : new RegExp(`^\\s*${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const ctx = await page.context().browser().newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  try {
    await B.loginToClaimCenter(p, { username: user, password: pass });
    await p.keyboard.press('Alt+Shift+T');
    await W.settle(p, 4000);
    const info = p.getByText('Batch Process Info', { exact: true }).first();
    if (!await info.isVisible().catch(() => false)) throw new W.Blocked(`Server Tools did not open for ${user}`);
    await info.click();
    await W.settle(p, 4000);
    const row = p.locator('tr').filter({ hasText: rowRe }).first();
    if (!await row.isVisible().catch(() => false)) {
      const names = await p.evaluate(() => [...document.querySelectorAll('tr')].map((r) => (r.innerText || '').split('\n')[0].trim()).filter((t) => t && t.length < 60).slice(0, 80));
      throw new W.Blocked(`no batch matching ${rowRe} on Batch Process Info (rows: ${names.join(' | ').slice(0, 500)})`);
    }
    const lastRun = async () => ((await row.innerText().catch(() => '')).match(/(\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d [AP]M)\s+(\w+)/) || []).slice(1).join(' ');
    const before = await lastRun();
    await row.getByRole('button', { name: 'Run', exact: true }).first().click();
    for (let t = 0; t < 60; t++) {
      await p.waitForTimeout(3000);
      await p.getByRole('button', { name: 'Refresh', exact: true }).first().click().catch(() => {});
      await W.settle(p, 1500);
      const now = await lastRun();
      if (now && now !== before && /Completed|Failed/i.test(now)) return `${name} batch run as ${user}: ${now}`;
    }
    return `${name} batch started as ${user} (completion not confirmed within 3 minutes)`;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// Batch name a case uses, overridable per tier: batchName('BOA_INTAKE', /Bank of America.*Intake/i) reads REG_BATCH_BOA_INTAKE.
const batchName = (key, dflt) => (process.env[`REG_BATCH_${key}`] ? process.env[`REG_BATCH_${key}`] : dflt);

// Administration › Monitoring › Message Queues: Suspend / Resume the destination matching `re` (as admin, separate
// context so the caller's claim page is untouched). Returns the row text after the action.
async function messageQueue(page, re, action /* 'Suspend' | 'Resume' */) {
  const ctx = await page.context().browser().newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  try {
    await openAdmin(p, 'Monitoring', 'Message Queues');
    const row = p.locator('tr[role="row"], tr').filter({ hasText: re }).first();
    if (!(await row.isVisible().catch(() => false))) throw new W.Blocked(`no message queue matching ${re}`);
    await row.locator('input[type="checkbox"]').first().check().catch(() => row.click());
    const btn = p.getByRole('button', { name: action, exact: true }).first();
    if (!(await btn.isVisible().catch(() => false))) throw new W.Blocked(`no ${action} button on Message Queues`);
    await btn.click();
    await W.settle(p, 3000);
    return (await row.innerText().catch(() => '')).replace(/\s+/g, ' ');
  } finally { await ctx.close().catch(() => {}); }
}

// Administration › Utilities › Inbound Files: rows (file name, type, status, date) as text, newest first as CC lists them.
async function inboundFiles(page, re = /./) {
  await openAdmin(page, 'Utilities', /Inbound Files/i);
  return (await R.gridRows(page)).filter((r) => re.test(r));
}

// S3 Integration Files admin (helpers/s3Download/s3AdminService — Okta email-only login, confirmed 2026-09-28):
// list a prefix to prove an intake file is (or is no longer) where the batch reads it. Returns object keys.
async function s3Keys(page, prefix) {
  const S3 = require('../s3Download/s3AdminService');
  const ctx = await page.context().browser().newContext();
  const p = await ctx.newPage();
  try {
    await S3.loginAndEnsureTestPlanet(p);
    const items = await S3._api.apiList(p, prefix);
    return items.map((x) => x.key || x.Key || x.name || String(x));
  } catch (e) {
    if (e.name === 'Blocked') throw e;
    throw new W.Blocked(`S3 admin listing for ${prefix} failed: ${String(e.message).split('\n')[0]}`);
  } finally { await ctx.close().catch(() => {}); }
}

// Key validations for a claim that arrived from OUTSIDE the FNOL wizard (website, mobile app, FNOL XML intake, UAC,
// Alliance Glass): the same things the wizard-created claims are checked for, so an intake channel that drops a piece
// (no policy, nobody assigned, no workplan) fails here instead of in production. Every check is recorded; returns facts.
async function validateIntakeClaim(page, ti, cn, { channel, policy, expectExposure = true } = {}) {
  await B.loginToClaimCenter(page);
  const found = await searchClaims(page, { claim: cn });
  await R.check(page, ti, { description: `${channel} claim ${cn} found in Search › Claims`, expected: cn, actual: found.rows.join(' | ') || 'not found', ok: found.rows.some((r) => r.includes(cn)) });
  await R.makeViewable(page, cn);
  R.setClaim(ti, cn, process.env.CC_USER);
  const sum = await readScreen(page);
  const head = await bodyText(page);
  const pol = (head.match(/Policy[:#\s]+([A-Z0-9-]{6,})/) || [])[1] || (findField(sum, 'Policy Number') || {}).value || '';
  await R.check(page, ti, { description: 'Policy attached (verified policy, not "Unverified")', expected: policy || 'a policy number', actual: pol || 'none', ok: !!pol && (!policy || head.includes(policy)) && !/unverified/i.test(head.slice(0, 1500)) });
  const adj = (head.match(/Adj:\s*([^\n]+)/) || [])[1] || '';
  await R.check(page, ti, { description: 'Claim assigned to an adjuster/group (not pending assignment)', expected: 'adjuster in the header', actual: adj || 'no adjuster', ok: !!adj && !/pending|unassigned/i.test(adj) });
  await A.openLossDetailsGeneral(page).catch(() => {});
  const ld = await readScreen(page);
  const lossDate = (findField(ld, 'Date of Loss') || findField(ld, 'Loss Date') || {}).value || '';
  const desc = (findField(ld, 'Description') || findField(ld, 'What happened') || {}).value || '';
  const how = (findField(ld, 'How Reported') || findField(ld, 'Reported By') || findField(ld, 'Source') || {}).value || '';
  await R.check(page, ti, { description: 'Loss details carried over (loss date, description)', expected: 'both populated', actual: `date "${lossDate}", description "${desc.slice(0, 60)}"`, ok: !!lossDate && !!desc });
  await R.step(page, ti, `How reported / source: ${how || '(not shown)'}`);
  await W.navigate(page, 'parties');
  const parties = (await R.gridRows(page)).filter((r) => !/^Name\s+Roles?/i.test(r));
  await R.check(page, ti, { description: 'Contacts created (insured at least)', expected: 'an Insured contact', actual: parties.slice(0, 6).join(' || ') || 'none', ok: parties.some((r) => /Insured/i.test(r)) });
  const { rows } = await R.hasActivity(page, /./, cn);
  await R.check(page, ti, { description: 'Workplan generated (FNOL rules fired)', expected: '≥ 1 activity', actual: `${rows.length} activit(ies): ${rows.slice(0, 4).join(' || ')}`, ok: rows.length > 0 });
  if (expectExposure) {
    const n = await A.exposureCount(page).catch(() => 0);
    await R.check(page, ti, { description: 'Exposure(s) created', expected: '≥ 1', actual: String(n), ok: n > 0 });
  }
  return { policy: pol, adjuster: adj, lossDate, how, parties, activities: rows };
}

// Administration tab (cloud TabBar id AdminTab) → left nav path, as the admin.
async function openAdmin(page, ...navPath) {
  await B.loginAsAdmin(page);
  const tab = page.locator('#TabBar-AdminTab [role="menuitem"]').first();
  if (await tab.isVisible().catch(() => false)) await tab.click({ force: true });
  else if (!(await nav(page, 'Administration'))) throw new W.Blocked('no Administration tab for the admin login');
  await W.settle(page, 3000);
  for (const p of navPath) if (!(await nav(page, p))) throw new W.Blocked(`Administration has no "${p}" item`);
}

// Close ONE exposure on cloud the way e2eSteps.closeCloud does (it closes all of them): open exposures' activities
// completed first (they block Close Exposure — 2026-11-02), then Close Exposure › Note + Outcome › Close Exposure.
// `acceptDmec` = click again on the DMEC0002 open-reserve warning (zeroes the reserve). Returns { closed, messages }.
async function closeExposure(page, cn, match, { acceptDmec = false } = {}) {
  await B.openExistingClaim(page, cn);
  await E.completeActivitiesCloud(page);
  await B.openExistingClaim(page, cn);
  await require('../oneInc/needsData')._openExposureMatching(page, match);
  const btn = page.getByRole('button', { name: 'Close Exposure', exact: true }).first();
  if (!(await btn.isVisible().catch(() => false))) throw new W.Blocked(`exposure ${match} has no Close Exposure button (already closed?)`);
  await btn.click();
  await page.waitForTimeout(2500);
  await page.locator('textarea[name$="Note"], textarea').first().fill('Regression close').catch(() => {});
  const sel = page.locator('select[name$="Outcome"]').first();
  const opt = await sel.locator('option').evaluateAll((os) => {
    const real = os.filter((o) => o.value && !/^<?none>?$/i.test(o.text.trim()));
    return (real.find((o) => /Payments Complete|Settle|Complete|Paid/i.test(o.text)) || real[0] || {}).value;
  }).catch(() => null);
  if (opt) await sel.selectOption(opt);
  await page.getByRole('button', { name: 'Close Exposure', exact: true }).first().click();
  await page.waitForTimeout(3500);
  const messages = await R.pageMessages(page);
  const dmec = await page.getByText(/DMEC0002/).first().isVisible().catch(() => false);
  if (dmec && acceptDmec) { await page.getByRole('button', { name: 'Close Exposure', exact: true }).first().click(); await page.waitForTimeout(3500); }
  const still = await page.getByRole('button', { name: 'Close Exposure', exact: true }).first().isVisible().catch(() => false);
  if (still) await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
  return { closed: !still, dmec, messages: messages.concat(dmec ? ['DMEC0002'] : []) };
}

// Activity rows matching `re` (Workplan text incl. Assigned To). Thin wrapper over financialRules.hasActivity.
async function activities(page, cn, re) {
  const { rows } = await R.hasActivity(page, re, cn);
  return rows.filter((r) => re.test(r));
}

// ISO is a card TAB on Loss Details (Details | ISO), not a left-nav item - findField never saw it (2026-11-10). Opens it
// and reads "Status / Date sent to ISO / Last response from ISO"; with send=true presses "Send To ISO" when Status is None.
async function isoTab(page, cn, { send = false } = {}) {
  await B.openExistingClaim(page, cn);
  await A.openLossDetailsGeneral(page);
  const id = await page.evaluate(() => { const e = [...document.querySelectorAll('[id]')].filter((x) => x.offsetParent && (x.innerText || '').trim() === 'ISO' && !/MenuLinks/.test(x.id)); return e.length ? e[e.length - 1].id : null; });
  if (id) { await page.locator(`[id="${id}"]`).click(); await page.waitForTimeout(3000); }
  const body = await bodyText(page);
  // Tab text reads "ISO\nStatus\nStatus\nNone\nDate sent to ISO\n<date>\nLast response from ISO\n<resp>" (blank values
  // simply leave the next label on the following line).
  const LABELS = /^(Status|Date sent to ISO|Last response from ISO)$/i;
  const after = (re) => { const m = body.match(re); const v = m ? m[1].trim() : ''; return LABELS.test(v) ? '' : v; };
  const r = { status: after(/Status\s*\n\s*Status\s*\n\s*([^\n]*)/), sent: after(/Date sent to ISO\s*\n\s*([^\n]*)/i), resp: after(/Last response from ISO\s*\n\s*([^\n]*)/i), body, pressed: false };
  if (send && /^none$/i.test(r.status)) {
    const b = page.getByRole('button', { name: /^Send To ISO$/i }).first();
    if (await b.isVisible().catch(() => false)) { await b.click(); await page.waitForTimeout(4000); r.pressed = true; }
  }
  return r;
}

module.exports = {
  isoTab,
  CATALOG, BY_ID, RESULTS_DIR, RUN_ID, idOf, meta, saveResult, hooks, need, external, blockable,
  KINDS, fileClaim, pooledClaim, poolFresh, claimFor, savedAssignment, claimNumberFormat,
  nav, bodyText, field, action, editAndUpdate, searchClaims, runBatchProcess, openAdmin, activities,
  batchName, messageQueue, inboundFiles, s3Keys, validateIntakeClaim, closeExposure,
  // re-exported so specs import one module
  B, R, E, W, readScreen, findField, norm,
  A,                                              // oneInc/setupA: openLossDetailsGeneral, editAndSave, selectByLabel, fillByLabel, openExposure
  openExposureMatching: require('../oneInc/needsData')._openExposureMatching,
  CO: require('../oneInc/checkOps'),              // history, createFullCheck, openVoid/submitVoid
  P: require('../financialPayments'),             // makePayment, uniqueAmount, VENDORS
  F: require('../financialsHelper'),              // createReserve
  L: require('../claimLifecycleHelper'),          // assignClaim, closeClaim, reopenClaim, closeExposure
  PC: require('./policyCenter'),                  // read-only PolicyCenter checks
  API: require('./soapClient'),                   // SOAP/JSON calls for the API cases
};
