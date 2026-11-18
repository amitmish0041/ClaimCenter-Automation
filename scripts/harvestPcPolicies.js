/**
 * scripts/harvestPcPolicies.js — read-only PolicyCenter (TEST) harvest of IN-FORCE policies into one shared pool every
 * automation tool can read:  V:\Amit Int\TestData\PolicyPool\pc-policies.json (+ .csv)
 *
 * PC Advanced policy search needs a producer code (or a name/ID), so:
 *   1. producers = the producer of record on each TEST policy listed in .env POLICY_* (plus PC_EXTRA_PRODUCERS=a,b)
 *   2. for each product x producer: Search For = Policy, As of Date = today → rows (falls back to per-state when PC says
 *      "More than 300 results").
 * Existing pool rows are kept (merged by policy number); each row records when it was last seen in force.
 * PC dates are dd/mm/yyyy (UK locale) — stored as ISO.
 *
 *   node scripts/harvestPcPolicies.js [--products="Personal Auto,Homeowners"] [--producers=0008707,4500496]
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { chromium } = require('playwright');
const PC = require('../helpers/regression/policyCenter');

const POOL_DIR = process.env.POLICY_POOL_DIR || 'V:\\Amit Int\\TestData\\PolicyPool';
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
const PRODUCTS = arg('products') ? arg('products').split(',') : ['Personal Auto', 'Commercial Auto', 'Commercial Auto (v7)', 'Homeowners',
  "Workers' Compensation", "Workers' Compensation (v7)", 'Commercial Package', 'General Liability', 'General Liability (v7)',
  'Businessowners', 'Businessowners (v7)', 'Commercial Property', 'Commercial Property (v7)', 'Dwelling Fire', 'Personal Umbrella',
  'Commercial Umbrella', 'Inland Marine [CommInlandMarine]', 'Inland Marine [InlandMarine]'];
const STATES = process.env.PC_STATES ? process.env.PC_STATES.split(',') : ['Pennsylvania', 'Michigan', 'Delaware', 'Virginia', 'Georgia', 'Ohio', 'Maryland', 'Iowa', 'Nebraska', 'Wisconsin',
  'Indiana', 'Illinois', 'South Dakota', 'North Dakota', 'Minnesota', 'Tennessee', 'North Carolina', 'South Carolina', 'New York', 'Vermont', 'New Hampshire', 'Maine'];
const F = (s) => `[name$="PolicySearchDV-${s}"]`;
const dmy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const isoOf = (s) => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
const settle = (pc, ms = 1500) => pc.waitForTimeout(ms);

async function openSearch(pc) {
  await pc.getByRole('menuitem', { name: 'Search', exact: true }).click();
  await settle(pc, 3000);
  await pc.getByText('Advanced', { exact: true }).first().click();
  await settle(pc, 2500);
}

// One search; returns { rows, tooMany }. Reads every page of the result list.
async function search(pc, { product, state, code }) {
  await openSearch(pc);
  await pc.locator(F('SearchFor')).selectOption({ label: 'Policy' }).catch(() => {});
  await settle(pc);
  await pc.locator(F('ProductName')).selectOption({ label: product });
  await settle(pc);
  // PC keeps the last search's criteria: always set State (to <none> when not splitting) or the previous state sticks.
  await pc.locator(F('State')).selectOption({ label: state || '<none>' }); await settle(pc);
  await pc.locator(F('ProducerCode')).fill(code);
  await pc.locator(F('AsOfDate')).fill(dmy(new Date()));
  await pc.keyboard.press('Tab');
  await settle(pc);
  await pc.getByRole('button', { name: 'Search', exact: true }).first().click();
  await settle(pc, 5000);
  const body = await pc.locator('body').innerText();
  if (/More than \d+ results/.test(body)) return { rows: [], tooMany: true };
  const rows = [];
  for (let p = 0; p < 30; p++) {
    const page = await pc.evaluate(() => [...document.querySelectorAll('tr')].filter((r) => r.offsetParent)
      .map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim())).filter((c) => c.some((x) => /^\d{10}$/.test(x))));
    const before = rows.length;
    for (const c of page) if (!rows.some((r) => r.join() === c.join())) rows.push(c);
    if (rows.length === before && p) break;
    // GW paging toolbar: "(1 - 15 of 26)"; the next button is a div with aria-disabled.
    const next = pc.locator('.gw-paging--button-next').first();
    if (!(await next.isVisible().catch(() => false)) || (await next.getAttribute('aria-disabled').catch(() => 'true')) === 'true') break;
    await next.click().catch(() => {});
    await settle(pc, 3000);
  }
  return { rows, tooMany: false };
}

// Row cells → record. Columns (seen 2026-11-18): Policy #, Insured, Account #, Product, Status, Effective, Expiration, Producer …
function toRecord(cells, product, state, code) {
  const c = cells.filter(Boolean);
  const i = c.findIndex((x) => /^\d{10}$/.test(x));
  const dates = c.filter((x) => /^\d{2}\/\d{2}\/\d{4}$/.test(x));
  return { policy: c[i], insured: c[i + 1] || '', account: c[i + 2] || '', product, status: c.find((x) => /In Force|Scheduled|Expired|Canceled/.test(x)) || '',
    effective: isoOf(dates[0] || ''), expiration: isoOf(dates[1] || ''), producer: c.find((x) => /INS|AGENCY|GROUP|INC|LLC/i.test(x) && x !== c[i + 1]) || '', producerCode: code, state: state || '' };
}

(async () => {
  fs.mkdirSync(POOL_DIR, { recursive: true });
  const poolFile = path.join(POOL_DIR, 'pc-policies.json');
  const pool = fs.existsSync(poolFile) ? JSON.parse(fs.readFileSync(poolFile, 'utf8')) : { policies: {} };
  const say = (m) => { console.log(m); fs.appendFileSync(path.join(POOL_DIR, 'harvest.log'), `${new Date().toISOString()} ${m}\n`); };
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  await PC.withPC(page, async (pc) => {
    let producers = arg('producers') ? arg('producers').split(',') : [];
    if (!producers.length) {
      // Producer of record on one policy per .env POLICY_* list.
      const envPols = Object.keys(process.env).filter((k) => /^POLICY_[A-Z_]+$/.test(k) && !/_DEV$/.test(k))
        .flatMap((k) => process.env[k].split(',').map((x) => x.trim()).filter(Boolean).slice(0, 2));
      const codes = new Set((process.env.PC_EXTRA_PRODUCERS || '0008707,4500496').split(','));
      for (const p of [...new Set(envPols)].filter((x) => /^\d{10}$/.test(x))) {
        try {
          const box = pc.locator('input[name*="PolicyTab_PolicyRetrievalItem"]').first();
          if (!(await box.isVisible().catch(() => false))) { await pc.locator('#TabBar-PolicyTab > .gw-action--expand-button > .gw-icon').click().catch(() => {}); await settle(pc); }
          await box.fill(p); await box.press('Enter'); await settle(pc, 4000);
          const m = /Producer:\s*\n?\s*(\d{7})/.exec(await pc.locator('body').innerText());
          if (m) codes.add(m[1]);
        } catch { /* skip */ }
      }
      producers = [...codes];
    }
    say(`producers: ${producers.join(', ')}`);
    const seen = new Date().toISOString().slice(0, 10);
    let added = 0;
    for (const code of producers) {
      for (const product of PRODUCTS) {
        let res = await search(pc, { product, code }).catch((e) => ({ rows: [], err: e.message }));
        const batches = [];
        // Result rows carry no state, so any product with hits is re-run per state (also the way past "More than 300").
        if (res.tooMany || res.rows.length) { for (const st of STATES) batches.push({ st, res: await search(pc, { product, state: st, code }).catch(() => ({ rows: [] })) }); }
        else batches.push({ st: '', res });
        for (const { st, res: r } of batches) for (const cells of r.rows) {
          const rec = toRecord(cells, product, st, code);
          if (!rec.policy) continue;
          if (!pool.policies[rec.policy]) added++;
          pool.policies[rec.policy] = { ...(pool.policies[rec.policy] || {}), ...rec, lastSeenInForce: seen };
        }
        const n = batches.reduce((s, b) => s + b.res.rows.length, 0);
        if (n || res.err) say(`${code} ${product}: ${n} in force${res.tooMany ? ' (split by state)' : ''}${res.err ? ` ERR ${res.err.split('\n')[0]}` : ''}`);
        fs.writeFileSync(poolFile, JSON.stringify({ updated: new Date().toISOString(), source: 'PolicyCenter TEST advanced search, in force as of harvest date', policies: pool.policies }, null, 2));
      }
    }
    const all = Object.values(pool.policies);
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const cols = ['policy', 'product', 'state', 'insured', 'account', 'status', 'effective', 'expiration', 'producer', 'producerCode', 'lastSeenInForce'];
    fs.writeFileSync(path.join(POOL_DIR, 'pc-policies.csv'), [cols.join(','), ...all.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n'));
    say(`done: ${added} new, ${all.length} policies in pool -> ${poolFile}`);
  });
  await browser.close();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
