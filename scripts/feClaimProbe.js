#!/usr/bin/env node
/**
 * scripts/feClaimProbe.js — READ-ONLY layout probe for the CC Cloud FE claim scout: opens one claim and dumps the
 * left-menu items and the visible text of the Summary, Documents, Notes and Policy screens.
 *   node scripts/feClaimProbe.js <claim#> [--headless]
 */
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
process.env.CC_ENV = 'cloud'; process.env.CC_TIER = process.env.CC_TIER || 'test';
const { chromium } = require('playwright');
const base = require('../helpers/claimCenterBase');
const W = require('../helpers/oneInc/wizardDriver');
const { openClaimViaSearch } = require('../helpers/financialClaimSearch');

(async () => {
  const cn = process.argv[2];
  const out = path.join(__dirname, '..', 'results', 'fe-scout', 'probe');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: process.argv.includes('--headless') });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  await base.loginToClaimCenter(page);
  await openClaimViaSearch(page, cn);
  const text = () => page.evaluate(() => document.body.innerText.replace(/[ \t]+/g, ' '));
  const menu = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].filter((e) => e.offsetParent).map((e) => `${e.id} | ${e.innerText.trim()}`));
  fs.writeFileSync(path.join(out, 'menu.txt'), menu.join('\n'));
  fs.writeFileSync(path.join(out, 'summary.txt'), await text());
  for (const name of ['Documents', 'Notes', 'Policy', 'Litigation']) {
    const item = page.locator('[role="menuitem"]', { hasText: new RegExp(`^${name}$`) }).first();
    if (!await item.isVisible().catch(() => false)) { fs.writeFileSync(path.join(out, `${name}.txt`), 'MENU ITEM NOT VISIBLE'); continue; }
    await item.click(); await W.settle(page, 4000);
    fs.writeFileSync(path.join(out, `${name}.txt`), await text());
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true }).catch(() => {});
  }
  await browser.close();
  console.log('probe written to', out);
})().catch((e) => { console.error(e); process.exit(1); });
