#!/usr/bin/env node
/**
 * scripts/proNavProbe.js — READ-ONLY layout probe of the ProNavigator AI panel (#gw-right-panel) in cloud TEST CC.
 * Opens a claim, expands the panel and dumps its DOM outline, iframes, inputs and text + a screenshot.
 *   node scripts/proNavProbe.js <claim#> [--headless]
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

(async () => {
  const out = path.join(__dirname, '..', 'results', 'pronav', 'probe');
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch({ headless: process.argv.includes('--headless') });
  const page = await (await b.newContext({ viewport: { width: 1700, height: 1000 } })).newPage();
  await base.loginToClaimCenter(page);
  await openClaimViaSearch(page, process.argv[2]);
  const panel = page.locator('#gw-right-panel');
  const w = await panel.evaluate((e) => e.getBoundingClientRect().width).catch(() => 0);
  if (w < 100) { await page.locator('#gw-right-panel--minmax').first().click().catch(() => {}); await W.settle(page, 4000); }
  await page.screenshot({ path: path.join(out, 'panel.png') });
  const info = await panel.evaluate((e) => ({
    text: e.innerText.slice(0, 3000),
    iframes: [...e.querySelectorAll('iframe')].map((f) => ({ src: f.src, id: f.id, name: f.name })),
    inputs: [...e.querySelectorAll('input,textarea,[contenteditable="true"],button')].map((x) => `${x.tagName} id=${x.id} name=${x.name || ''} aria=${x.getAttribute('aria-label') || ''} ph=${x.placeholder || ''} text=${(x.innerText || '').slice(0, 40)}`),
    html: e.outerHTML.slice(0, 4000),
  })).catch((err) => ({ error: String(err) }));
  fs.writeFileSync(path.join(out, 'panel.json'), JSON.stringify(info, null, 1));
  for (const fr of page.frames()) if (fr !== page.mainFrame()) {
    const t = await fr.evaluate(() => ({ url: location.href, text: document.body ? document.body.innerText.slice(0, 2000) : '', inputs: [...document.querySelectorAll('input,textarea,[contenteditable="true"],button')].map((x) => `${x.tagName} ${x.id} ${x.getAttribute('aria-label') || ''} ${x.placeholder || ''} ${(x.innerText || '').slice(0, 30)}`) })).catch((err) => ({ url: fr.url(), error: String(err) }));
    fs.appendFileSync(path.join(out, 'frames.json'), JSON.stringify(t, null, 1) + '\n');
  }
  await b.close();
  console.log('ProNav probe ->', out);
})().catch((e) => { console.error(e); process.exit(1); });
