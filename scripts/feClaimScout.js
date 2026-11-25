#!/usr/bin/env node
/**
 * scripts/feClaimScout.js — READ-ONLY scout of EXISTING cloud TEST claims for the CC Cloud FE (AI features) test plan
 * (user direction 2026-11-25: use existing claims for each planned scenario instead of creating new ones).
 *
 * Phase 1 (candidates): claim numbers from --list <file> (one per line) + results/regression/migrated-claims-test.json
 *   + Advanced Search by Total Paid (rich files) unless --no-search.
 * Phase 2 (profile): per claim reads header, Documents grid (all pages), Notes count, Policy General, Litigation
 *   matters. Never clicks Edit/New; nothing is written to CC.
 * Phase 3 (match): see scripts/feClaimMatch.js (runs on the JSON this writes; re-runnable offline).
 *
 *   node scripts/feClaimScout.js --list <file> [--max 300] [--headless] [--no-search]
 * Output: results/fe-scout/profiles.json (merged: claims already profiled are skipped, so a stopped run resumes).
 */
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
process.env.CC_ENV = 'cloud'; process.env.CC_TIER = process.env.CC_TIER || 'test';
const { chromium } = require('playwright');
const base = require('../helpers/claimCenterBase');
const W = require('../helpers/oneInc/wizardDriver');
const { openClaimViaSearch, searchClaims } = require('../helpers/financialClaimSearch');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i < 0) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const OUT = path.join(__dirname, '..', 'results', 'fe-scout');
const PROFILES = path.join(OUT, 'profiles.json');
const CLAIM_RE = /\b[A-Z]{2,5}-[A-Z]{2}-\d{2}-\d{2}-\d{7}\b/;

const bodyText = (page) => page.evaluate(() => document.body.innerText.replace(/[ \t]+/g, ' '));
// Empty values are dropped from innerText, so the next label would read as the value: treat known labels as blank.
const LABELS = /^(Policy Number|Policy Mod|Policy Type|Effective Date|Expiration Date|Cancellation Date|Original Effective Date|Underwriting Company|Insured|Name|Claim:|Ins:|DoL:|St:|Adj:)$/;
const field = (t, label) => { const m = new RegExp(`\\n${label}\\n([^\\n]*)`).exec(t); const v = m ? m[1].trim() : ''; return LABELS.test(v) ? '' : v; };

async function menu(page, name) {
  const item = page.locator('[role="menuitem"]', { hasText: new RegExp(`^${name}$`) }).first();
  if (!await item.isVisible().catch(() => false)) return false;
  await item.click(); await W.settle(page, 3500); return true;
}

async function readDocuments(page) {
  if (!await menu(page, 'Documents')) return { docs: [], exposures: [], error: 'no Documents menu' };
  const exposures = (await bodyText(page)).split('\n').map((s) => s.trim()).filter((s) => /^\(\d+\) /.test(s));
  const docs = [];
  for (let p = 0; p < 15; p++) {
    const rows = await page.evaluate(() => [...document.querySelectorAll('[id="ClaimDocuments-Claim_DocumentsScreen"] tr')]
      .filter((r) => r.offsetParent && !r.querySelector('tr'))
      .map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean))
      .filter((c) => c.some((x) => /\d{2}\/\d{2}\/\d{4}/.test(x))));
    for (const c of rows) docs.push({ desc: c[0] || '', type: c[1] || '', status: c[2] || '', author: c[3] || '', uploaded: c[c.length - 1] || '' });
    const next = page.locator('[id="ClaimDocuments-Claim_DocumentsScreen"] [id$="_ListPaging-next"]').first();
    if (!await next.isVisible().catch(() => false) || await next.isDisabled().catch(() => true)) break;
    await next.click().catch(() => {}); await W.settle(page, 2500);
  }
  return { docs, exposures };
}

async function readNotesCount(page) {
  if (!await menu(page, 'Notes')) return null;
  // The notes list renders after the search block; wait for its "Displaying" line (or an empty grid) to appear.
  for (let i = 0; i < 12; i++) {
    const t = await bodyText(page);
    const m = /Displaying \d+ - \d+ of (\d+)/.exec(t);
    if (m) return Number(m[1]);
    // One page or less: no "Displaying" line — count the note cards (each has Edit / Print / Author).
    const tail = t.split(/\nReset\nNotes\n/)[1];
    if (tail != null) {
      const cards = (tail.match(/\nPrint\nAuthor\n/g) || []).length;
      if (cards || /No data to display/.test(tail)) return cards;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function readPolicy(page) {
  if (!await menu(page, 'Policy')) return {};
  const t = await bodyText(page);
  const subs = await page.evaluate(() => {
    const names = [...document.querySelectorAll('[role="menuitem"]')].filter((e) => e.offsetParent).map((e) => e.innerText.trim());
    const i = names.indexOf('Policy'); const j = names.indexOf('Financials');
    return i >= 0 && j > i ? names.slice(i + 1, j) : [];
  });
  return {
    number: field(t, 'Policy Number'), type: field(t, 'Policy Type'), effective: field(t, 'Effective Date'),
    expiration: field(t, 'Expiration Date'), cancellation: field(t, 'Cancellation Date'),
    originalEffective: field(t, 'Original Effective Date'), underwriting: field(t, 'Underwriting Company'), subScreens: subs,
  };
}

async function readLitigation(page) {
  if (!await menu(page, 'Litigation')) return null;
  const t = await bodyText(page);
  const grid = (t.split(/\nResolution\n/)[1] || '').trim();
  if (!grid || /^No data to display/.test(grid)) return { count: 0, text: '' };
  return { count: null, text: grid.replace(/\s+/g, ' ').slice(0, 300) };
}

async function profile(page, cn) {
  await openClaimViaSearch(page, cn);
  const head = await bodyText(page);
  const p = {
    claim: cn, scoutedAt: new Date().toISOString(),
    policy: field(head, 'Pol:'), insured: field(head, 'Ins:'), lossDate: field(head, 'DoL:'), status: field(head, 'St:'), adjuster: field(head, 'Adj:'),
  };
  Object.assign(p, await readDocuments(page));
  p.notes = await readNotesCount(page);
  p.policyInfo = await readPolicy(page);
  p.matters = await readLitigation(page);
  return p;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const done = fs.existsSync(PROFILES) ? JSON.parse(fs.readFileSync(PROFILES, 'utf8')) : {};
  const cands = new Set();
  const list = arg('list');
  if (list && list !== true) for (const l of fs.readFileSync(list, 'utf8').split(/\r?\n/)) { const m = CLAIM_RE.exec(l); if (m) cands.add(m[0]); }
  try {
    const mig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'results', 'regression', 'migrated-claims-test.json'), 'utf8'));
    for (const k of Object.keys(mig)) if (Array.isArray(mig[k])) mig[k].forEach((x) => cands.add(x.claim));
  } catch (_) { /* optional */ }

  const browser = await chromium.launch({ headless: Boolean(arg('headless', false)) });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  await base.loginToClaimCenter(page);

  // --states Pennsylvania,Maryland --prefix CA,CAA,CAS: search by Loss Location State (open + closed, last ~10 years)
  // and keep only claim numbers with those prefixes (Commercial Auto scope, user direction 2026-11-25).
  const states = arg('states');
  if (states && states !== true) {
    const keep = new RegExp(`^(${String(arg('prefix', 'CA,CAA,CAS')).split(',').join('|')})-`);
    const to = new Date(); const mdy = `${String(to.getMonth() + 1).padStart(2, '0')}/${String(to.getDate()).padStart(2, '0')}/${to.getFullYear()}`;
    for (const st of String(states).split(',')) for (const status of ['Open', 'Closed']) {
      try {
        // CC needs a group/user/policy/claim criterion; the scout user sees only casualty groups (2026-11-25).
        const rows = [];
        for (const group of String(arg('groups', 'Casualty Claim Division,Branch Offices Virginia Unit')).split(',')) {
          rows.push(...await searchClaims(page, { group, status, lob: 'Auto', lossState: st, date: { type: 'Loss date', from: '01/01/2015', to: mdy }, pages: Number(arg('pages', 20)) }).catch((e) => { console.log(`[FE scout] ${group}/${st}/${status}: ${e.message.split('\n')[0]}`); return []; }));
        }
        const ca = rows.filter((r) => keep.test(r.claim));
        ca.forEach((r) => cands.add(r.claim));
        console.log(`[FE scout] ${st} ${status}: ${rows.length} claims, ${ca.length} commercial auto`);
      } catch (e) { console.log(`[FE scout] ${st} ${status} search failed: ${e.message.split('\n')[0]}`); }
    }
  }
  // --policies <file>: one PC policy number per line → Advanced Search by Policy # (the reliable way to reach claims
  // outside the scout user's groups). Writes results/fe-scout/policy-claims.json (policy → claims).
  const pol = arg('policies');
  if (pol && pol !== true) {
    const map = {};
    for (const p of fs.readFileSync(pol, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      const rows = await searchClaims(page, { policy: p }).catch(() => []);
      map[p] = rows.map((r) => r.claim); rows.forEach((r) => cands.add(r.claim));
    }
    fs.writeFileSync(path.join(OUT, 'policy-claims.json'), JSON.stringify(map, null, 1));
    console.log(`[FE scout] policies: ${Object.keys(map).length}, with claims: ${Object.values(map).filter((x) => x.length).length}, claims: ${Object.values(map).flat().length}`);
  }
  if (arg('only-prefix')) { const keep = new RegExp(`^(${String(arg('prefix', 'CA,CAA,CAS')).split(',').join('|')})-`); for (const c of [...cands]) if (!keep.test(c)) cands.delete(c); }

  if (!arg('no-search', false)) {
    for (const status of ['Open', 'Closed']) {
      try {
        // CC needs a "specify at least one" criterion besides the amount range: a loss-date range does it.
        const to = new Date(); const mdy = `${String(to.getMonth() + 1).padStart(2, '0')}/${String(to.getDate()).padStart(2, '0')}/${to.getFullYear()}`;
        const rows = await searchClaims(page, { status, date: { type: 'Loss date', from: '01/01/2010', to: mdy }, money: { type: 'Total Paid', from: 25000, to: 99999999 }, pages: 6 });
        rows.forEach((r) => cands.add(r.claim));
        console.log(`[FE scout] search Total Paid >= 25k (${status}): ${rows.length} claims`);
      } catch (e) { console.log(`[FE scout] search (${status}) failed: ${e.message.split('\n')[0]}`); }
    }
  }

  const todo = [...cands].filter((c) => !done[c]).slice(0, Number(arg('max', 400)));
  console.log(`[FE scout] ${cands.size} candidates, ${Object.keys(done).length} already profiled, ${todo.length} to do`);
  let n = 0;
  for (const cn of todo) {
    try { done[cn] = await profile(page, cn); }
    catch (e) {
      done[cn] = { claim: cn, error: e.message.split('\n')[0].slice(0, 200), scoutedAt: new Date().toISOString() };
      await page.goto(base.BASE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {}); await W.settle(page, 3000);
    }
    if (++n % 5 === 0 || n === todo.length) { fs.writeFileSync(PROFILES, JSON.stringify(done, null, 1)); console.log(`[FE scout] ${n}/${todo.length}`); }
  }
  fs.writeFileSync(PROFILES, JSON.stringify(done, null, 1));
  await browser.close();
  console.log(`[FE scout] done -> ${PROFILES}`);
})().catch((e) => { console.error(e); process.exit(1); });
