/**
 * scripts/s3Explore.js
 * Read-only look at the TEST S3 bucket through the S3 admin tool (shared Okta session): lists folders under each prefix
 * given (default: the top level), searching for FNOL folders two levels down, and saves a screenshot of the admin tool.
 *
 *   node scripts/s3Explore.js [prefix ...]
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
process.env.SMARTCOMM_OKTA_SESSION_FILE = process.env.SMARTCOMM_OKTA_SESSION_FILE || 'V:\\Amit Int\\SmartComm\\smartcomm-okta-session.json';
process.env.SMARTCOMM_OKTA_SESSION_READONLY = '1';
const { chromium } = require('playwright');
const s3 = require('../helpers/s3Download/s3AdminService');

(async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await s3.loginAndEnsureTestPlanet(page, { log: console.log });
  const out = path.join(__dirname, '..', 'results', 's3-explore');
  require('fs').mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, 'top.png'), fullPage: true });
  const prefixes = process.argv.slice(2).length ? process.argv.slice(2) : [''];
  const show = async (prefix, depth) => {
    const res = await s3._api.apiList(page, prefix, { log: () => {} }).catch((e) => ({ error: e.message }));
    const items = Array.isArray(res) ? res : (res && (res.items || res.contents || res.folders || res.objects)) || [];
    if (res && res.error) { console.log(`${prefix || '(top)'}: ERROR ${res.error.split('\n')[0]}`); return; }
    const names = items.map((x) => (typeof x === 'string' ? x : x.key || x.prefix || x.name || JSON.stringify(x)));
    console.log(`${'  '.repeat(depth)}${prefix || '(top)'}: ${names.length} item(s)`);
    for (const n of names.slice(0, 60)) console.log(`${'  '.repeat(depth + 1)}${n}`);
    if (depth < 2) for (const n of names.filter((x) => /\/$/.test(x) && /claim|fnol|intake|cc/i.test(x))) await show(n, depth + 1);
  };
  for (const p of prefixes) await show(p, 0);
  console.log(`screenshot: ${path.join(out, 'top.png')}`);
  await browser.close();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });

// node scripts/s3Explore.js --open "Inbound Processed/FNOLIntake" ... : clicks the tree path and screenshots the file list.
module.exports.openPath = async (page, segs, file) => {
  let scope = page;
  for (const s of segs) {
    await page.getByText(s, { exact: true }).nth(segs[0] === s ? 0 : 0).click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: file, fullPage: true });
  return (await page.locator('body').innerText()).replace(/\s+\n/g, '\n');
};
