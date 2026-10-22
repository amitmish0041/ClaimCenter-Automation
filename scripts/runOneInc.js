#!/usr/bin/env node
/**
 * scripts/runOneInc.js
 * Runs the OneInc test designs (ONEINC_DIR workbooks) against ClaimCenter Cloud and writes the HTML / JSON / CSV
 * report + evidence under <ONEINC_DIR>\AutomationResults (see helpers/oneInc/reportService.js). EVERY inventoried
 * test case gets a status: automated ones are run (or marked NOT EXECUTED when not selected), the rest are reported
 * with their category and reason.
 *
 *   node scripts/runOneInc.js --all                       every automated scenario
 *   node scripts/runOneInc.js --story GCCM-759,GCCM-799   automated scenarios of these stories
 *   node scripts/runOneInc.js --ids "GCCM-759/UIF/TC-001,GCCM-799/UIF/TC-066"
 *   node scripts/runOneInc.js --rerun-failed <runId>      the FAIL + BLOCKED scenarios of an earlier run
 *   node scripts/runOneInc.js --list [--out file.json]    inventory + classification + Jira readiness, no browser
 *   options: --headless (browser is visible by default)  --max-claims 4
 *            --provision [--pool-size N]  (TEST only) before executing, create fresh FNOL claims for every claim
 *                                         profile the selected scenarios need, until the pool has N usable each
 *
 * CC_ENV is forced to cloud (OneInc is a Cloud feature); CC_TIER picks test (default) or dev. Read-only by
 * default — the wizards are always cancelled. ONEINC_ALLOW_FINISH=1 lets validation-rule scenarios press Finish on
 * test/dev, which SUBMITS a payment when no error appears.
 * Jira readiness needs JIRA_EMAIL + JIRA_API_TOKEN (this repo's .env, else the sibling Runner repo's .env).
 */
'use strict';
process.env.CC_ENV = 'cloud';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.CC_ENV = 'cloud';
if (!process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
  // Jira credentials live in the Runner repo's .env (Settings tab in the packaged app) — borrow only the JIRA_* keys.
  const runnerEnv = path.join(__dirname, '..', '..', 'Commercial Line Performance test', '.env');
  if (fs.existsSync(runnerEnv)) {
    const parsed = require('dotenv').parse(fs.readFileSync(runnerEnv));
    for (const k of ['JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_SITE']) if (parsed[k] && !process.env[k]) process.env[k] = parsed[k];
  }
}

const { loadInventory } = require('../helpers/oneInc/inventoryService');
const { classify } = require('../helpers/oneInc/classifier');
const { RECIPES } = require('../helpers/oneInc/scenarioRecipes');
const { loadReadiness, matchBugs } = require('../helpers/oneInc/jiraReadiness');
const report = require('../helpers/oneInc/reportService');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function baseResult(tc, cls, story) {
  return {
    scenarioId: tc.scenarioId, story: tc.story, storyTitle: tc.storyTitle, sheet: tc.sheet, tcId: tc.tcId, name: tc.name,
    description: tc.description, precondition: tc.precondition, priority: tc.priority, type: tc.type,
    expected: tc.steps.map((s) => s.expected).filter(Boolean).filter((e) => !/policy is issued|creates a claim/i.test(e)).join('\n'),
    automation: cls.automation, status: cls.automation === 'DEV_PENDING' ? 'BLOCKED' : 'NOT EXECUTED', reason: cls.reason,
    jira: story || null, checks: [], stepsExecuted: [], evidence: [],
  };
}

function annotate(r, story, readiness) {
  r.jira = story || null;
  const labels = (r.checks || []).filter((c) => c.result !== 'PASS').map((c) => (/"([^"]+)"/.exec(c.description) || [])[1]).filter(Boolean);
  r.bugs = r.status === 'FAIL' || r.status === 'BLOCKED' ? matchBugs(readiness, labels) : [];
  const jiraTxt = story ? ` (Jira: dev ${story.dev ? `${story.dev.key} ${story.dev.status}` : 'n/a'}, test exec ${story.exec ? `${story.exec.key} ${story.exec.status}` : 'n/a'})` : '';
  if (r.status === 'FAIL') {
    if (story && story.readiness === 'DEV_PENDING') r.devNote = `Story development is not Done in Jira — this failure is likely pending development${jiraTxt}.`;
    else if (r.missingElement) r.devNote = `An expected field/option/message is not on the screen — may be pending development${jiraTxt}; confirm with the dev team before logging a defect.`;
  } else if (r.status === 'BLOCKED' && story && story.readiness === 'DEV_PENDING') {
    r.devNote = `Story development is not Done in Jira${jiraTxt}.`;
  }
  if (r.bugs.length) r.devNote = `${r.devNote ? r.devNote + ' ' : ''}Related logged bug(s): ${r.bugs.map((b) => `${b.key} (${b.status})`).join(', ')}.`;
  return r;
}

(async () => {
  const tier = String(process.env.CC_TIER || 'test').toLowerCase();
  const inv = loadInventory();
  const readiness = await loadReadiness();
  const cases = inv.cases.map((tc) => ({ tc, cls: classify(tc, { readiness }), story: readiness.stories[tc.story] || null }));

  if (arg('list', false)) {
    const out = {
      dir: inv.dir, jira: { available: readiness.available, reason: readiness.reason, jql: readiness.jql, fetchedAt: readiness.fetchedAt },
      workbooks: inv.workbooks.map((w) => ({ story: w.story, file: w.fileName, title: w.meta.description, sheets: w.sheets, referenceSheets: w.referenceSheets, jira: readiness.stories[w.story] || null })),
      scenarios: cases.map(({ tc, cls }) => ({ scenarioId: tc.scenarioId, story: tc.story, sheet: tc.sheet, tcId: tc.tcId, name: tc.name, description: tc.description,
        automation: cls.automation, reason: cls.reason, profile: RECIPES[tc.scenarioId] ? RECIPES[tc.scenarioId].profile : null })),
    };
    const target = arg('out', null);
    if (target && target !== true) fs.writeFileSync(target, JSON.stringify(out, null, 2)); else process.stdout.write(JSON.stringify(out));
    return;
  }

  // ── selection ────────────────────────────────────────────────────────────────────────────────────────────────
  let selected;
  let scope;
  if (arg('ids-file', false)) {
    // The Runner passes long selections through a file (one id per line) rather than the command line.
    const f = arg('ids-file');
    selected = new Set(fs.readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    fs.unlink(f, () => {});
    scope = `${selected.size} selected scenario(s)`;
  } else if (arg('ids', false)) { selected = new Set(list(arg('ids'))); scope = `ids: ${[...selected].join(', ')}`; }
  else if (arg('story', false)) { const st = new Set(list(arg('story')).map((s) => s.toUpperCase())); selected = new Set(cases.filter((c) => st.has(c.tc.story)).map((c) => c.tc.scenarioId)); scope = `stories: ${[...st].join(', ')}`; }
  else if (arg('rerun-failed', false)) {
    const prev = report.loadRun(arg('rerun-failed'));
    if (!prev) { console.error(`[OneInc] run ${arg('rerun-failed')} not found`); process.exit(2); }
    selected = new Set(prev.results.filter((r) => r.status === 'FAIL' || r.status === 'BLOCKED').map((r) => r.scenarioId));
    scope = `rerun of FAIL/BLOCKED from ${prev.run.runId}`;
  } else { selected = new Set(cases.map((c) => c.tc.scenarioId)); scope = 'all automated scenarios'; }
  // Order: read-only scenarios first, then validation scenarios (which may press Finish and SUBMIT a payment when
  // ONEINC_ALLOW_FINISH=1), and last the ones that pay a line's whole Available Reserve (VBR.009) — a submitted
  // payment uses up the open reserve every other scenario on that claim relies on.
  const weight = (id) => {
    const steps = (RECIPES[id] && RECIPES[id].steps) || [];
    const v = steps.find((s) => s.validate);
    if (!v) return 0;
    if (steps.some((s) => s.step2 && s.step2.amount === 'AVAILABLE')) return 3;
    // A Final Payment that goes through closes its reserve line too.
    if (!v.validate.expect && steps.some((s) => s.step2 && s.step2.transactionType === 'Final Payment')) return 3;
    return v.validate.expect ? 1 : 2;
  };
  const toRun = cases.filter((c) => c.cls.automation === 'AUTOMATED' && selected.has(c.tc.scenarioId))
    .map((c, i) => ({ c, i, w: weight(c.tc.scenarioId) })).sort((a, b) => a.w - b.w || a.i - b.i).map((x) => x.c);
  const unknown = [...selected].filter((id) => !cases.some((c) => c.tc.scenarioId === id));
  if (unknown.length) console.log(`[OneInc] WARNING — unknown scenario id(s) ignored: ${unknown.join(', ')}`);

  // ── run setup ────────────────────────────────────────────────────────────────────────────────────────────────
  const runId = report.newRunId(tier);
  const dirs = report.prepareDirs(runId);
  const logFile = path.join(dirs.logs, `${runId}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const log = (line) => { console.log(line); logStream.write(`${new Date().toISOString()} ${line}\n`); };
  const base = require('../helpers/claimCenterBase');
  const { runScenario, ALLOW_FINISH, isPaymentRecipe } = require('../helpers/oneInc/scenarioRunner');
  const run = {
    // complete stays false until the last save, so the Runner can show a run in progress (even one started here
    // from the command line) by re-reading this file — it is rewritten after every scenario.
    runId, startedAt: new Date().toISOString(), scope, complete: false, planned: 0, done: 0,
    env: { platform: 'cloud', tier, url: base.BASE_URL, user: process.env.CC_USER ? '(CC_USER from settings)' : '(not set)' },
    allowFinish: ALLOW_FINISH, logFile,
    jira: { available: readiness.available, reason: readiness.reason, jql: readiness.jql, fetchedAt: readiness.fetchedAt, site: String(process.env.JIRA_SITE || 'donegalgroup.atlassian.net').replace(/^https?:\/\//, '').replace(/\/.*$/, '') },
  };
  log(`[OneInc] run ${runId} — ${inv.cases.length} test cases discovered in ${inv.workbooks.length} workbooks; ${toRun.length} automated scenario(s) selected (${scope})`);
  log(`[OneInc] Jira readiness: ${readiness.available ? Object.entries(readiness.stories).map(([k, s]) => `${k}=${s.readiness}`).join(', ') : readiness.reason}`);
  log(`[OneInc] TOTAL ${toRun.length}`);
  run.planned = toRun.length;

  const results = new Map();
  for (const { tc, cls, story } of cases) {
    const r = baseResult(tc, cls, story);
    if (cls.automation === 'AUTOMATED') r.reason = selected.has(tc.scenarioId) ? 'Queued — run did not reach this scenario (stopped or crashed)' : 'Automated, not selected for this run';
    results.set(tc.scenarioId, annotate(r, story, readiness));
  }
  const save = () => {
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    return report.writeRun(run, [...results.values()], dirs);
  };
  save();

  // ── Test data upfront (--provision) ────────────────────────────────────────────────────────────────────────
  // Work out which claim profiles the SELECTED scenarios need and make sure the claim pool has --pool-size usable
  // claims for each, creating the missing ones with scripts/provisionOneIncClaims.js (fresh FNOL per claim) BEFORE
  // anything executes — per user direction 2026-10-20. TEST tier only (it creates claims).
  if (arg('provision', false) || process.env.ONEINC_PROVISION === '1') {
    const claimPicker = require('../helpers/oneInc/claimPicker');
    const poolSize = Math.max(1, Math.min(10, Number(arg('pool-size', process.env.ONEINC_POOL_SIZE || 1)) || 1));
    const needed = [...new Set(toRun.map(({ tc }) => RECIPES[tc.scenarioId].profile))];
    if (tier !== 'test') log(`[OneInc] --provision ignored: claims are only created on the TEST tier (this run is ${tier})`);
    else {
      log(`[OneInc] provisioning: selected scenarios need claim profiles ${needed.join(', ')} (pool size ${poolSize} each)`);
      run.provisioned = {};
      // Test data first (helpers/oneInc/testData.js, 2026-10-21): the pool claims of every needed profile that declares
      // data are re-checked and whatever is missing is BUILT before anything runs; claims that still miss data drop
      // out of the pool (usable=false) and new claims are created below to make up the count.
      const withData = needed.filter((p) => (claimPicker.PROFILES[p] || {}).data && claimPicker.PROFILES[p].data.length);
      if (withData.length) {
        log(`[OneInc] provisioning: verifying / building test data on the pool claims of ${withData.join(', ')}`);
        await new Promise((resolve) => {
          const { spawn } = require('child_process');
          const child = spawn(process.execPath, [path.join(__dirname, 'provisionOneIncClaims.js'), '--verify', '--profiles', withData.join(','),
            ...(arg('headless', false) ? ['--headless'] : [])], { cwd: path.join(__dirname, '..'), env: process.env });
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
      for (const profile of needed) {
        const have = claimPicker.poolClaims(profile).length;
        if (have >= poolSize) { log(`[OneInc] provisioning: ${profile} — ${have} usable claim(s) already in the pool`); continue; }
        log(`[OneInc] provisioning: ${profile} — creating ${poolSize - have} new claim(s) (each FNOL takes a few minutes)`);
        // ASYNC with live output. It used to be spawnSync, which blocked this process: nothing reached the run log
        // or the Runner's console until every FNOL had finished, so a long provisioning looked like a hang/loop
        // (user report 2026-10-20).
        const code = await new Promise((resolve) => {
          const { spawn } = require('child_process');
          const child = spawn(process.execPath, [path.join(__dirname, 'provisionOneIncClaims.js'), '--profiles', profile, '--count', String(poolSize - have),
            ...(arg('headless', false) ? ['--headless'] : [])], { cwd: path.join(__dirname, '..'), env: process.env });
          let buf = '';
          child.stdout.on('data', (d) => {
            buf += d.toString();
            const lines = buf.split(/\r?\n/);
            buf = lines.pop();
            for (const line of lines) if (/^\[Provision\]/.test(line)) log(line);
          });
          child.stderr.on('data', () => {});
          child.on('close', resolve);
          child.on('error', () => resolve(1));
        });
        run.provisioned[profile] = claimPicker.poolClaims(profile);
        log(`[OneInc] provisioning: ${profile} — pool now ${claimPicker.poolClaims(profile).join(', ') || '(empty — scenarios fall back to existing test-data claims)'}`);
        // The provisioner exits 3 when ClaimCenter can't save claims at all (environment problem) — don't try the
        // remaining profiles; they would fail the same way.
        if (code === 3) { log('[OneInc] provisioning: ClaimCenter TEST is not saving new claims right now — skipping the remaining profiles; the run uses existing claims'); break; }
      }
    }
  }

  let browser;
  let page;
  if (toRun.length) {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: Boolean(arg('headless', false)) || process.env.ONEINC_HEADLESS === '1' }) // headed by default so the run can be watched (user direction 2026-10-20);
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(20000);
    try {
      await base.loginToClaimCenter(page);
    } catch (e) {
      log(`[OneInc] BLOCKED — ClaimCenter login failed: ${e.message.split('\n')[0]}`);
      for (const { tc } of toRun) Object.assign(results.get(tc.scenarioId), { status: 'BLOCKED', reason: `ClaimCenter ${tier} login failed: ${e.message.split('\n')[0]}` });
      run.complete = true;
      const paths = save();
      log(`[OneInc] REPORT ${paths.html}`);
      await browser.close();
      process.exit(1);
    }
  }

  // ── Execution: --workers N (default 1) ─────────────────────────────────────────────────────────────────────────
  // Phase 1 — read-only screen checks — runs on N browsers in parallel (each its own login; a profile with several
  // pool claims gives each worker a different one). Phase 2 — the validation scenarios, which may press Finish and
  // submit payments that use up a claim's reserve — always runs one at a time afterwards, on worker 1.
  const workers = Math.max(1, Math.min(4, Number(arg('workers', process.env.ONEINC_WORKERS || 1)) || 1));
  // validate steps AND finishObserve-style steps submit payments — both run one at a time (scenarioRunner.isPaymentRecipe).
  const isPaymentScenario = (id) => isPaymentRecipe(RECIPES[id]);
  const phase1 = toRun.filter(({ tc }) => !isPaymentScenario(tc.scenarioId));
  const phase2 = toRun.filter(({ tc }) => isPaymentScenario(tc.scenarioId));
  const ctxs = [{ dirs, log, maxClaims: Number(arg('max-claims', 4)) || 4, worker: 0 }];
  const pages = [page];
  const extraBrowsers = [];
  if (workers > 1 && phase1.length > 1) {
    const { chromium } = require('playwright');
    for (let w = 1; w < workers; w++) {
      const b = await chromium.launch({ headless: Boolean(arg('headless', false)) || process.env.ONEINC_HEADLESS === '1' });
      const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
      p.setDefaultTimeout(20000);
      try { await base.loginToClaimCenter(p); } catch (e) { log(`[OneInc] worker ${w + 1}: login failed (${e.message.split('\n')[0]}) — running with fewer workers`); await b.close().catch(() => {}); break; }
      extraBrowsers.push(b);
      pages.push(p);
      ctxs.push({ ...ctxs[0], worker: w });
    }
    log(`[OneInc] ${pages.length} worker(s) for ${phase1.length} screen-check scenario(s); ${phase2.length} payment scenario(s) run one at a time afterwards`);
  }
  let i = 0;
  const runOne = async ({ tc, story }, w) => {
    const n = ++i;
    log(`[OneInc] (${n}/${toRun.length}) ${tc.scenarioId} — starting${pages.length > 1 ? ` [worker ${w + 1}]` : ''}: ${tc.name.slice(0, 100)}`);
    let r;
    try {
      r = await runScenario(pages[w], tc, RECIPES[tc.scenarioId], ctxs[w]);
    } catch (e) {
      r = { ...results.get(tc.scenarioId), status: 'FAIL', reason: `automation crashed: ${e.message.split('\n')[0]}`, error: e.message, stack: e.stack, automationError: true };
    }
    results.set(tc.scenarioId, annotate({ ...r, automation: 'AUTOMATED' }, story, readiness));
    log(`[OneInc] (${n}/${toRun.length}) ${tc.scenarioId}: ${r.status}${r.reason ? ' — ' + String(r.reason).slice(0, 220) : ''}`);
    run.done = (run.done || 0) + 1;
    save();
  };
  // Phase 1: a shared queue drained by every worker.
  const queue = phase1.slice();
  await Promise.all(pages.map(async (_, w) => { while (queue.length) await runOne(queue.shift(), w); }));
  for (const b of extraBrowsers) await b.close().catch(() => {});
  // Phase 2: one at a time.
  for (const item of phase2) await runOne(item, 0);
  if (browser) await browser.close().catch(() => {});

  run.complete = true;
  const paths = save();
  const S = run.summary;
  log(`[OneInc] DONE — discovered ${S.discovered}, executed ${S.executed}: ${S.passed} PASS, ${S.failed} FAIL, ${S.blocked} BLOCKED; ${S.notExecuted} NOT EXECUTED; pass ${S.passPct}% of executed`);
  log(`[OneInc] REPORT ${paths.html}`);
  log(`[OneInc] JSON ${paths.json}`);
  log(`[OneInc] CSV ${paths.csv}`);
  logStream.end();
})().catch((e) => { console.error('[OneInc] fatal:', e.stack || e.message); process.exit(1); });
