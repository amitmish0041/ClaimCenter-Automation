/**
 * scripts/reproInteractiveError.js
 * Reproduces a SmartCOMM "Interactive" error by hand-equivalent steps on one claim, screenshotting every step
 * (for a step-by-step defect write-up): login -> open claim -> Actions > New > Create from template -> template ->
 * Recipients -> Additional Data -> Create > Interactive -> read the red error banner.
 *
 *   node scripts/reproInteractiveError.js <DIG> <claim> <outDir>
 */
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { chromium } = require('playwright');
const B = require('../helpers/claimCenterBase');
const ds = require('../helpers/smartComm/documentService');
const catalog = require('../helpers/smartComm/catalogService');

const [dig, claim, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const steps = [];
(async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: false });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  let n = 0;
  const shot = async (title, detail = '') => {
    n++;
    const file = `${String(n).padStart(2, '0')}.png`;
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(outDir, file) });
    steps.push({ n, title, detail, file });
    console.log(`step ${n}: ${title}`);
  };
  const slot = process.env.REPRO_USER_SLOT || '1';
  const user = process.env[`SMARTCOMM_TEST_USER_${slot}`];
  await B.loginAsUser(page, user, process.env[`SMARTCOMM_TEST_PASS_${slot}`]);
  await shot(`Log in to ClaimCenter TEST as ${user}`);
  await B.openExistingClaim(page, claim);
  await shot(`Open claim ${claim}`, 'Search > Claims > Claim # > open the claim.');
  await ds.openCreateFromTemplate(page);
  await shot('Actions > New > Create from template', 'The Create New Document panel opens on the Select Template tab.');
  const t = catalog.getTemplate ? catalog.getTemplate(dig) : null;
  const name = (t && (t.searchName || t.templateName)) || dig;
  await ds.selectTemplate(page, [t && t.searchName, t && t.searchNameAlt].filter(Boolean));
  await shot(`Search for template ${dig} and select it`, `Template: ${name}`);
  const insured = ((await page.locator('body').innerText().catch(() => '')).match(/Ins:\s*([^\n]+?)\s+DoL:/) || [])[1];
  await ds.setPrimaryRecipient(page, { preferredName: insured }).catch((e) => console.log('recipient:', e.message.split('\n')[0]));
  await ds.setDeliveryChannel(page, 'Print').catch(() => {});
  const mail = { returnEnvelope: process.env.REPRO_RETURN_ENVELOPE === '1', certifiedMail: process.env.REPRO_CERTIFIED === '1' };
  await ds.setMailOptions(page, mail).catch((e) => console.log('mail options:', e.message.split('\n')[0]));
  if (process.env.REPRO_EMAIL) await ds.setEmail(page, process.env.REPRO_EMAIL).catch((e) => console.log('email:', e.message.split('\n')[0]));
  await shot(`Recipients tab: Set Primary Recipient = ${insured}; Delivery Channel Print; Certified Mail ${mail.certifiedMail ? 'Yes' : 'No'}; Return Envelope ${mail.returnEnvelope ? 'Yes' : 'No'}`);
  if (process.env.REPRO_ADDITIONAL_RECIPIENT === '1') {
    const added = await ds.setAdditionalRecipient(page, { excludeName: insured }).catch((e) => { console.log('additional recipient:', e.message.split('\n')[0]); return null; });
    await shot('Recipients tab: Add Additional Recipient', added ? `Added ${added.name}` : 'The only other contact ("NAME NOT AVAILABLE") has no address, so it was added and then removed (select its row, Remove).');
  }
  await page.getByRole('tab', { name: 'Additional Data', exact: true }).click().catch(() => {});
  const extra = JSON.parse(process.env.REPRO_ADDITIONAL_DATA || '{}');
  await ds.setAdditionalData(page, { insuredName: insured, ...extra }).catch((e) => console.log('additional data:', e.message.split('\n')[0]));
  await shot(`Additional Data tab: Language English (US)${Object.entries(extra).map(([k, v]) => `, ${k} = ${v}`).join('')}`);
  await page.getByRole('tab', { name: 'Create', exact: true }).click().catch(() => {});
  await shot('Create tab');
  // The tool's own Interactive step: clicks Interactive and completes the SmartCOMM (Azure) sign-in with the saved session.
  const ies = require('../helpers/smartComm/interactiveEditService');
  let toolError = '';
  await ies.clickInteractiveAndWaitForEditor(page, page.context(), { scenarioId: `repro_${dig}` }).catch((e) => { toolError = e.message.split('\n')[0]; });
  console.log('interactive step:', toolError || 'editor opened');
  await page.waitForTimeout(5000);
  const banner = ((await page.getByRole('group', { name: /^Errors/i }).first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  // The error text: scroll the red banner into view so the screenshot shows the message itself (user, 2026-11-16).
  const errGroup = page.getByRole('group', { name: /^Errors/i }).first();
  await errGroup.scrollIntoViewIfNeeded().catch(() => {});
  await shot('Click Interactive', banner ? `ClaimCenter shows: ${banner}` : 'No error banner appeared.');
  if (banner) { await errGroup.screenshot({ path: path.join(outDir, 'error-banner.png') }).catch(() => {}); await page.screenshot({ path: path.join(outDir, 'error-fullpage.png'), fullPage: true }).catch(() => {}); }
  fs.writeFileSync(path.join(outDir, 'steps.json'), JSON.stringify({ dig, claim, user, template: name, at: new Date().toISOString(), error: banner, steps }, null, 2));
  console.log(banner ? `REPRODUCED: ${banner}` : 'NOT reproduced');
  await browser.close();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
