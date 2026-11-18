// node scripts/s3OpenFolder.js "<parent>" "<folder>" <out.png> : opens <folder> under <parent> in the TEST S3 admin tree (read-only) and screenshots it.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
process.env.SMARTCOMM_OKTA_SESSION_FILE = process.env.SMARTCOMM_OKTA_SESSION_FILE || 'V:\Amit Int\SmartComm\smartcomm-okta-session.json';
process.env.SMARTCOMM_OKTA_SESSION_READONLY = '1';
const { chromium } = require('playwright');
const s3 = require('../helpers/s3Download/s3AdminService');
const [parent, folder, out] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await s3.loginAndEnsureTestPlanet(page, { log: () => {} });
  // The folder row under the given parent: the first match of the folder name after the parent row.
  const parentRow = page.getByText(parent, { exact: true }).first();
  const rows = page.getByText(folder, { exact: true });
  const py = (await parentRow.boundingBox()).y;
  let target = null;
  for (let i = 0; i < await rows.count(); i++) { const b = await rows.nth(i).boundingBox(); if (b && b.y > py) { target = rows.nth(i); break; } }
  await target.click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: out, fullPage: true });
  const main = await page.locator('main, [role="main"]').last().innerText().catch(() => '');
  console.log((main || (await page.locator('body').innerText())).split('\n').filter((l) => l.trim()).slice(0, 80).join('\n'));
  const btns = await page.getByRole('button').allInnerTexts();
  console.log('BUTTONS:', btns.map((b) => b.trim()).filter(Boolean).join(' | '));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
