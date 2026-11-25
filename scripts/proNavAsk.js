#!/usr/bin/env node
/**
 * scripts/proNavAsk.js — asks the ProNavigator AI panel (cloud TEST CC, #gw-right-panel iframe from ui.expert.pronavigator.ai)
 * a golden question set on one claim and records each answer + cited sources + screenshot. Read-only for CC: it only
 * types into the ProNav search box (new thread per question).
 *
 *   node scripts/proNavAsk.js --claim CA-PA-85-26-0748493 --set PA [--headless] [--only 1,3]
 * Question sets: helpers/proNav/goldenQuestions.js. Output: results/pronav/<set>-<stamp>/answers.json + q<N>.png
 */
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
process.env.CC_ENV = 'cloud'; process.env.CC_TIER = 'test';
const { chromium } = require('playwright');
const base = require('../helpers/claimCenterBase');
const W = require('../helpers/oneInc/wizardDriver');
const { openClaimViaSearch } = require('../helpers/financialClaimSearch');
const SETS = require('../helpers/proNav/goldenQuestions');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i < 0) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };

async function proNavFrame(page) {
  const panel = page.locator('#gw-right-panel');
  const w = await panel.evaluate((e) => e.getBoundingClientRect().width).catch(() => 0);
  if (w < 100) { await page.locator('#gw-right-panel--minmax').first().click().catch(() => {}); await W.settle(page, 3000); }
  for (let i = 0; i < 30; i++) {
    const fr = page.frames().find((f) => /ui\.expert\.pronavigator\.ai/.test(f.url()));
    if (fr && await fr.locator('textarea').first().isVisible().catch(() => false)) return fr;
    await page.waitForTimeout(1000);
  }
  throw new Error('ProNavigator panel did not load');
}

async function filters(fr) {
  return fr.evaluate(() => [...document.querySelectorAll('button')].map((b) => (b.getAttribute('title') || b.innerText || '').trim()).filter((t) => t && !/^(Search|Suggestions|Ask question|clear selection)$/i.test(t)));
}

async function ask(page, fr, q, stateName) {
  await fr.getByRole('button', { name: /Start a new thread/i }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  // A new thread resets the filters to the claim context (2026-11-25): re-apply a manual state filter each time.
  if (stateName) await setStateFilter(page, fr, stateName);
  const box = fr.locator('textarea').first();
  await box.fill(q);
  const before = await fr.evaluate(() => document.body.innerText.length);
  // The arrow button's click didn't submit (2026-11-25 trial): press Enter, then click the button if the text is still there.
  await box.press('Enter');
  await page.waitForTimeout(1500);
  if ((await box.inputValue().catch(() => '')).trim()) {
    await fr.locator('button[aria-label="Ask question"], button[title="Ask question"]').first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  // Done = ProNav's closing footer ("Answers are from official documents…") is shown, no "Executing your query" /
  // "Analyzing results" status is left, and the text has stopped growing (2026-11-25: two answers were saved
  // mid-generation). Up to 180 s.
  const BUSY = /Executing your query|Analyzing results|Searching the|Generating|Thinking/i;
  let last = -1; let stable = 0;
  for (let i = 0; i < 180 && stable < 4; i++) {
    await page.waitForTimeout(1000);
    const t = await fr.evaluate(() => document.body.innerText);
    const done = t.length > before + 20 && /Answers are from official documents|Please confirm they apply/i.test(t) && !BUSY.test(t.slice(-1500));
    stable = done && t.length === last ? stable + 1 : 0; last = t.length;
  }
  return fr.evaluate(() => ({
    text: document.body.innerText,
    links: [...document.querySelectorAll('a')].map((a) => ({ text: (a.innerText || '').trim().slice(0, 120), href: a.href })).filter((l) => l.text || l.href),
  }));
}

// Picks an open Commercial Auto claim in the state from the FE scout profiles (results/fe-scout/profiles.json).
function claimForState(st) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'results', 'fe-scout', 'profiles.json'), 'utf8'));
    const c = Object.values(d).filter((p) => !p.error && new RegExp(`^CA-${st}-`).test(p.claim) && /open/i.test(p.status || ''))
      .sort((a, b) => (b.docs || []).length - (a.docs || []).length)[0];
    if (c) return c.claim;
  } catch (_) { /* fall back below */ }
  // Not profiled yet: first claim from the claim-number prefix search (results/fe-scout/prefix-claims.json).
  try {
    const pre = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'results', 'fe-scout', 'prefix-claims.json'), 'utf8'));
    return (pre[`CA-${st}`] || [])[0] || null;
  } catch (_) { return null; }
}

// Sets the ProNav state filter chip to `name` (dropdown of KMS states; CONFIRMED 2026-11-25). Returns the chip labels.
async function setStateFilter(page, fr, name) {
  const chipText = async () => fr.evaluate(() => [...document.querySelectorAll('button[class*="selectedFilterDropdown"]')].map((b) => b.innerText.trim()));
  let chips = await chipText();
  const want = name.slice(0, 5).toLowerCase();
  if (chips.some((c) => c.toLowerCase().startsWith(want))) return chips;
  const stateChip = fr.locator('button[class*="selectedFilterDropdown"]').nth(chips.length > 1 ? 1 : 0);
  await stateChip.click(); await page.waitForTimeout(1200);
  await fr.getByText(name, { exact: true }).last().click(); await page.waitForTimeout(1200);
  await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(800);
  chips = await chipText();
  if (!chips.some((c) => c.toLowerCase().startsWith(want))) throw new Error(`state filter did not switch to ${name} (chips: ${chips.join(' | ')})`);
  return chips;
}

async function runSet(page, setName, opts) {
  const set = SETS[setName];
  if (!set) throw new Error(`unknown set ${setName}; have ${Object.keys(SETS).join(', ')}`);
  const st = setName.slice(0, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(__dirname, '..', 'results', 'pronav', `${setName}-${stamp}`);
  fs.mkdirSync(out, { recursive: true });
  const own = set.claim || claimForState(st);
  const claim = opts.claim || own || 'CA-PA-85-26-0748493';
  await openClaimViaSearch(page, claim);
  let fr = await proNavFrame(page);
  const retried = new Set();
  const res = { claim, set: setName, state: set.stateName, at: new Date().toISOString(), contextFilters: await filters(fr), answers: [] };
  res.mode = own ? 'claim context' : `manual filter (no open ${st} Commercial Auto claim found; PA claim used)`;
  if (!own && set.stateName) res.filtersAfterSwitch = await setStateFilter(page, fr, set.stateName);
  console.log(`[ProNav] ${setName} on ${claim}: ${res.mode}; filters ${res.contextFilters.join(' | ')}${res.filtersAfterSwitch ? ` -> ${res.filtersAfterSwitch.join(' | ')}` : ''}`);
  for (let i = 0; i < set.questions.length; i++) {
    const q = set.questions[i];
    if (opts.only && !opts.only.includes(i + 1)) continue;
    try {
      const a = await ask(page, fr, q.q, own ? null : set.stateName);
      const idx = a.text.lastIndexOf(q.q.slice(0, 40));
      const answer = (idx >= 0 ? a.text.slice(idx + q.q.length) : a.text).trim();
      // Filter tags shown above the question in the thread (e.g. "Automobile", "Pennsylvania").
      const tags = idx >= 0 ? a.text.slice(0, idx).trim().split('\n').map((x) => x.trim()).filter(Boolean).slice(-2) : [];
      await page.screenshot({ path: path.join(out, `q${i + 1}.png`) });
      res.answers.push({ n: i + 1, ...q, cite: String(q.cite || ''), must: (q.must || []).map(String), mustNot: (q.mustNot || []).map(String), appliedTags: tags, answer, links: a.links });
      if (!own && set.stateName && !tags.some((t) => t === set.stateName)) res.answers[res.answers.length - 1].filterWarning = `answer tagged ${tags.join('/')} not ${set.stateName}`;
      console.log(`[ProNav] ${setName} q${i + 1}: ${answer.length} chars, tags ${tags.join('/')}`);
    } catch (e) {
      // Stuck panel (click/fill timeouts, 2026-11-25): reopen the claim + panel and retry the question once.
      if (!retried.has(i)) {
        retried.add(i);
        console.log(`[ProNav] ${setName} q${i + 1}: ${e.message.split('\n')[0]} - reopening the claim and retrying`);
        try { await page.goto(base.BASE_URL, { waitUntil: 'domcontentloaded' }); await W.settle(page, 4000); await openClaimViaSearch(page, claim); fr = await proNavFrame(page); } catch (_) { /* recorded below if the retry fails */ }
        i -= 1; continue;
      }
      res.answers.push({ n: i + 1, ...q, cite: String(q.cite || ''), error: e.message.split('\n')[0] });
    }
    fs.writeFileSync(path.join(out, 'answers.json'), JSON.stringify(res, null, 1));
  }
  return out;
}

(async () => {
  const sets = String(arg('sets', arg('set', 'PA'))).split(',');
  const only = arg('only') ? String(arg('only')).split(',').map(Number) : null;
  const b = await chromium.launch({ headless: Boolean(arg('headless', false)) });
  const page = await (await b.newContext({ viewport: { width: 1700, height: 1050 } })).newPage();
  await base.loginToClaimCenter(page);
  for (const s of sets) {
    try { console.log(`[ProNav] done ${s} -> ${await runSet(page, s, { only, claim: arg('claim') === true ? null : arg('claim') })}`); }
    catch (e) { console.log(`[ProNav] ${s} FAILED: ${e.message.split('\n')[0]}`); }
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
