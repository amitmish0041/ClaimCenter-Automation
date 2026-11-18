/**
 * scripts/s3UploadFnol.js
 * Uploads prepared FNOL intake XMLs to the TEST S3 bucket through the S3 admin tool (shared Okta session):
 * Claim Center > <parent> > FNOLIntake > Upload. --probe only opens the Upload dialog and screenshots it.
 *
 *   node scripts/s3UploadFnol.js --probe
 *   node scripts/s3UploadFnol.js <dir with test-ready XMLs> [parent="Inbound Processed"]
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
process.env.SMARTCOMM_OKTA_SESSION_FILE = process.env.SMARTCOMM_OKTA_SESSION_FILE || 'V:\\Amit Int\\SmartComm\\smartcomm-okta-session.json';
process.env.SMARTCOMM_OKTA_SESSION_READONLY = '1';
const { chromium } = require('playwright');
const s3 = require('../helpers/s3Download/s3AdminService');

const probe = process.argv.includes('--probe');
const [dir, parent = 'Inbound Processed'] = process.argv.slice(2).filter((a) => a !== '--probe');
const OUT = path.join(__dirname, '..', 'results', 's3-explore');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

// UPLOAD_KEY_PREFIX (e.g. "FNOLIntake/"): upload into a sub-folder of <parent> that isn't listed yet (an empty folder
// doesn't show in the tree) — the parent itself is opened and the prefix goes in front of the Filename.
const KEY_PREFIX = process.env.UPLOAD_KEY_PREFIX || '';
async function openFolder(page) {
  if (KEY_PREFIX) { await page.getByText(parent, { exact: true }).first().click(); await page.waitForTimeout(4000); return; }
  const py = (await page.getByText(parent, { exact: true }).first().boundingBox()).y;
  const rows = page.getByText('FNOLIntake', { exact: true });
  for (let i = 0; i < await rows.count(); i++) {
    const b = await rows.nth(i).boundingBox();
    if (b && b.y > py) { await rows.nth(i).click(); await page.waitForTimeout(4000); return; }
  }
  throw new Error(`no FNOLIntake folder under ${parent}`);
}
// The key cell of each row (rows start with an empty checkbox cell).
const keysShown = async (page) => (await page.locator('table tbody tr').allInnerTexts())
  .map((t) => t.split(/[\t\n]/).map((x) => x.trim()).find((x) => /\.xml$/i.test(x)) || '').filter(Boolean);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await s3.loginAndEnsureTestPlanet(page, { log: () => {} });
  await openFolder(page);
  const before = await keysShown(page);
  const chooserP = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  const chooser = await chooserP;
  await page.waitForTimeout(2000);
  if (probe) {
    await page.screenshot({ path: path.join(OUT, 'upload-dialog.png'), fullPage: true });
    console.log(`file chooser opened directly: ${!!chooser}; multiple: ${chooser ? chooser.isMultiple() : '-'}`);
    console.log(`file inputs on page: ${await page.locator('input[type=file]').count()}`);
    console.log((await page.locator('[role=dialog]').allInnerTexts()).join('\n---\n').slice(0, 1500));
    await browser.close();
    return;
  }
  const files = walk(dir).filter((f) => /\.xml$/i.test(f));
  // The original file name, without the "<folder>__" prefix the prep step added.
  const staged = path.join(OUT, 'upload-staging');
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(staged, { recursive: true });
  // Unique names (user, 2026-11-17): "<name>_<SUFFIX>.xml", and never a key the folder already has — a same-name
  // upload REPLACES the object (APPLIED_AUTO_324250.xml was overwritten that way on 11/17).
  const SUFFIX = process.env.UPLOAD_SUFFIX || 'T1117';
  const names = files.map((f) => {
    // UPLOAD_SUFFIX=none keeps the file's own name (it must END IN A NUMBER - the intake reads it; "_T1117" failed).
    const n = path.basename(f).replace(/^[^_]+__/, '').replace(/\.xml$/i, SUFFIX === 'none' ? '.xml' : `_${SUFFIX}.xml`);
    fs.copyFileSync(f, path.join(staged, n));
    return path.join(staged, n);
  }).filter((f) => {
    if (!before.some((k) => k === path.basename(f))) return true;
    console.log(`SKIPPED  ${path.basename(f)} — already in the folder (would be overwritten)`);
    return false;
  });
  // The dialog takes ONE file: Choose File -> Filename -> Upload. The first dialog is already open.
  const limit = Number(process.env.UPLOAD_LIMIT) || names.length;
  const results = [];
  for (const [i, f] of names.slice(0, limit).entries()) {
    if (i > 0) { await page.getByRole('button', { name: 'Upload', exact: true }).first().click(); await page.waitForTimeout(1500); }
    const dlg = page.locator('[role=dialog]').last();
    await dlg.locator('input[type=file]').setInputFiles(f);
    await page.waitForTimeout(500);
    const nameBox = dlg.locator('input:not([type=file])').first();
    await nameBox.fill(`${KEY_PREFIX}${path.basename(f)}`);
    await dlg.getByRole('button', { name: 'Upload', exact: true }).click();
    const closed = await dlg.waitFor({ state: 'hidden', timeout: 30000 }).then(() => true).catch(() => false);
    const err = closed ? '' : (await dlg.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    results.push({ file: path.basename(f), ok: closed, err });
    console.log(`${closed ? 'uploaded' : 'FAILED  '} ${path.basename(f)}${err ? ` — ${err}` : ''}`);
    if (!closed) { await dlg.getByRole('button', { name: 'Cancel' }).click().catch(() => {}); }
    await page.waitForTimeout(1500);
  }
  fs.writeFileSync(path.join(OUT, `upload-log-${Date.now()}.json`), JSON.stringify(results, null, 2));
  await page.waitForTimeout(5000);
  await page.getByRole('button', { name: /refresh/i }).first().click().catch(() => {});
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, 'after-upload.png'), fullPage: true });
  const after = await keysShown(page);
  const added = after.filter((k) => !before.includes(k));
  console.log(`uploaded ${names.length} file(s); folder had ${before.length}, now ${after.length}; new keys: ${added.length}`);
  for (const k of added) console.log(`  ${k}`);
  await browser.close();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
