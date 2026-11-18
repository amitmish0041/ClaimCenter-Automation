// node scripts/fnolProbe.js batches | policy <n> [...] : quick look (screenshots + text) at Batch Process Info's FNOL /
// Inbound Chunk rows, or the claims on given TEST policies. Read-only.
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
process.env.CC_ENV = 'cloud'; process.env.CC_TIER = 'test';
const { chromium } = require('playwright');
const B = require('../helpers/claimCenterBase');
const S = require('../helpers/regression/regressionSteps');
const [mode, ...args] = process.argv.slice(2);
const OUT = path.join(__dirname, '..', 'results', 'fnol-intake');
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  page.setDefaultTimeout(30000);
  await B.loginToClaimCenter(page, { username: process.env.CC_ADMIN_USER, password: process.env.CC_ADMIN_PASS });
  if (mode === 'run') {
    process.env.REG_ALLOW_BATCHES = '1'; // user-approved FNOL intake test run (2026-11-17)
    console.log(await S.runBatchProcess(page, 'FNOL Intake').catch((e) => `FNOL Intake: ${e.message.split('\n')[0]}`));
    console.log(await S.runBatchProcess(page, 'Inbound Chunk Work Queue').catch((e) => `Inbound Chunk: ${e.message.split('\n')[0]}`));
  } else if (mode === 'name') {
    // Search › Claims by the insured's last name (a claim created on an unverified / other policy still shows here).
    await page.goto(B.BASE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await B.waitForAllMasksGone(page, 30000);
    await page.locator('[aria-label="Search"]').first().click().catch(() => page.getByRole('menuitem', { name: /^Search$/ }).first().click());
    await page.getByRole('textbox', { name: 'Policy #' }).first().waitFor({ timeout: 45000 });
    const boxes = await page.getByRole('textbox').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.name || e.id));
    console.log('search boxes:', boxes.filter(Boolean).slice(0, 25).join(' | '));
    const last = page.locator('input[name*="GlobalPersonNameInputSet-LastName"], input[id*="GlobalPersonNameInputSet-LastName"]').first();
    await last.fill(args[0]);
    await page.getByRole('button', { name: /^Search$/ }).last().click();
    await page.waitForTimeout(6000);
    const rows = await page.evaluate(() => [...document.querySelectorAll('tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()).filter((t) => /\b[A-Z]{2,4}-[A-Z]{2}-\d{2}-\d{2}-\d{7}\b/.test(t)));
    console.log(rows.slice(0, 20).join('\n') || 'no claims');
    await page.screenshot({ path: path.join(OUT, `name-${args[0]}.png`), fullPage: true });
  } else if (mode === 'inbound') {
    // Administration > Utilities > Inbound Files, Configuration FNOLIntake (user's screenshot, 2026-11-17).
    const tab = page.locator('#TabBar-AdminTab [role="menuitem"]').first();
    await tab.click({ force: true }).catch(() => page.getByText('Administration', { exact: true }).first().click());
    await page.waitForTimeout(4000);
    await page.getByText('Utilities', { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(3000);
    const item = page.getByText('Inbound Files', { exact: true }).first();
    if (!(await item.isVisible().catch(() => false))) {
      await page.screenshot({ path: path.join(OUT, 'admin-utilities.png'), fullPage: true });
      const left = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"], .gw-action--inner')].map((e) => e.innerText.trim()).filter((t) => t && t.length < 40));
      console.log('menu items:', left.join(' | '));
      throw new Error('Inbound Files not in the Utilities menu (see admin-utilities.png)');
    }
    await item.click();
    await page.waitForTimeout(4000);
    const cfg = page.locator('select').first();
    await cfg.selectOption({ label: 'FNOLIntake' }).catch(async () => {
      await page.getByRole('combobox').first().click().catch(() => {});
      await page.getByRole('option', { name: 'FNOLIntake' }).click().catch(() => {});
    });
    await page.getByRole('button', { name: /^Search$/ }).last().click().catch(() => page.getByText('Search', { exact: true }).last().click());
    await page.waitForTimeout(5000);
    const all = [];
    for (let pg = 0; pg < 20; pg++) {
      const rows = await page.evaluate(() => [...document.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.innerText.replace(/\s+/g, ' ').trim()))
        .filter((c) => c.length > 5 && /FNOLIntake/i.test(c.join(' ')) && /pending\//i.test(c.join(' '))));
      for (const r of rows) all.push(r);
      const next = page.getByRole('button', { name: /next/i }).first();
      if (!(await next.isEnabled().catch(() => false)) || !rows.length) break;
      const firstBefore = rows[0].join('|');
      await next.click().catch(() => {});
      await page.waitForTimeout(3000);
      const firstNow = (await page.evaluate(() => { const r = [...document.querySelectorAll('tr')].find((x) => /pending\//i.test(x.innerText)); return r ? [...r.children].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join('|') : ''; }));
      if (firstNow === firstBefore) break;
    }
    // inbound <regex> --errors: every matching file's record status + error message (opens each detail page in turn).
    if (args.includes('--errors')) {
      const re = new RegExp(args[0], 'i');
      const listUrl = page.url();
      const out = [];
      const names = [];
      for (let pg = 0; pg < 20; pg++) {
        const here = await page.evaluate((src) => [...document.querySelectorAll('tr')].map((r) => r.innerText).filter((t) => new RegExp(src, 'i').test(t) && /pending\//i.test(t))
          .map((t) => (t.match(/pending\/FNOLIntake\/([^\s]+?)\.xml/) || [])[1]).filter(Boolean), re.source);
        names.push(...here.filter((n) => !names.includes(n)));
        const nextBtn = page.getByRole('button', { name: /next/i }).first();
        if (!(await nextBtn.isEnabled().catch(() => false))) break;
        const before = here.join();
        await nextBtn.click().catch(() => {});
        await page.waitForTimeout(3000);
        const after = await page.evaluate(() => [...document.querySelectorAll('tr')].map((r) => r.innerText).filter((t) => /pending\//i.test(t)).join('|'));
        if (!after || after.includes(before.split(',')[0] || '§')) { if (!here.length) break; }
      }
      // An explicit list (FNOL_NAMES file, one name per line) beats scraping the paged list.
      if (process.env.FNOL_NAMES) { names.length = 0; names.push(...fs.readFileSync(process.env.FNOL_NAMES, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)); }
      console.log(`${names.length} file(s) to read`);
      for (const n of names) {
        // Each detail is reached from the list: search again from page 1, page to the row, open it.
        await page.goto(listUrl).catch(() => {});
        await page.waitForTimeout(1500);
        const tab = page.locator('#TabBar-AdminTab [role="menuitem"]').first();
        await tab.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2500);
        await page.getByText('Utilities', { exact: true }).first().click().catch(() => {});
        await page.waitForTimeout(1500);
        await page.getByText('Inbound Files', { exact: true }).first().click().catch(() => {});
        await page.waitForTimeout(2500);
        await page.locator('select').first().selectOption({ label: 'FNOLIntake' }).catch(() => {});
        await page.getByRole('button', { name: /^Search$/ }).last().click().catch(() => {});
        await page.waitForTimeout(3500);
        let opened = false;
        for (let pg = 0; pg < 20 && !opened; pg++) {
          const row = page.locator('tr').filter({ hasText: `${n}.xml` }).first();
          if (await row.isVisible().catch(() => false)) {
            const fileStatus = (await row.innerText()).split('\n').map((x) => x.trim()).filter(Boolean)[1] || '';
            await row.locator('a, [role="link"]').first().click().catch(() => {});
            await page.waitForTimeout(3500);
            await page.getByRole('button', { name: /^Search$/ }).last().click().catch(() => {});
            await page.waitForTimeout(3500);
            const recs = await page.evaluate(() => [...document.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.innerText.replace(/\s+/g, ' ').trim()))
              .filter((c) => c.length >= 4 && /^\d+$/.test(c[0] || '')));
            const rec = recs[0] || [];
            out.push({ file: `${n}.xml`, fileStatus, recordStatus: rec[1] || '', error: rec[3] || '' });
            console.log(`${n} | ${fileStatus} | ${rec[1] || '-'} | ${(rec[3] || '').slice(0, 200)}`);
            opened = true;
          } else {
            await page.getByRole('button', { name: /next/i }).first().click().catch(() => {});
            await page.waitForTimeout(2500);
          }
        }
        if (!opened) out.push({ file: `${n}.xml`, fileStatus: '?', recordStatus: '', error: 'row not found' });
      }
      fs.writeFileSync(path.join(OUT, 'inbound-errors.json'), JSON.stringify(out, null, 2));
      await browser.close();
      return;
    }
    // inbound <regex> --open <file text>: open that row's Status link (the per-record detail) and dump it.
    const openIdx = args.indexOf('--open');
    if (openIdx >= 0) {
      const want = args[openIdx + 1];
      // Back to the first page, then page forward until the row shows.
      await page.getByRole('button', { name: /first/i }).first().click().catch(() => {});
      await page.waitForTimeout(2500);
      for (let pg = 0; pg < 20; pg++) {
        const row = page.locator('tr').filter({ hasText: want }).first();
        if (await row.isVisible().catch(() => false)) {
          await row.locator('a, [role="link"], .gw-ValueWidget a').first().click().catch(() => row.getByText(/Loaded|Duplicate|Failed|Error/).first().click());
          await page.waitForTimeout(5000);
          // The record list fills only after its own Search.
          await page.getByRole('button', { name: /^Search$/ }).last().click().catch(() => page.getByText('Search', { exact: true }).last().click().catch(() => {}));
          await page.waitForTimeout(5000);
          await page.screenshot({ path: path.join(OUT, `inbound-detail-${want.replace(/\W+/g, '_')}.png`), fullPage: true });
          // Each record row: line, status, (content skipped), error message, last modified (by).
          const recs = await page.evaluate(() => [...document.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.innerText.replace(/\s+/g, ' ').trim()))
            .filter((c) => c.length >= 4 && /^\d+$/.test(c[0] || '') || (c.length >= 4 && /^\d+$/.test(c[1] || ''))));
          for (const c of recs) console.log(`RECORD | ${c.map((x) => (x.startsWith('<?xml') ? `[xml ${x.length} chars]` : x)).filter(Boolean).join(' | ').slice(0, 1500)}`);
          break;
        }
        await page.getByRole('button', { name: /next/i }).first().click().catch(() => {});
        await page.waitForTimeout(3000);
      }
      await browser.close();
      return;
    }
    const re = new RegExp(args[0] || '.', 'i');
    const mine = all.filter((c) => re.test(c.join(' ')));
    console.log(`${all.length} FNOLIntake row(s); ${mine.length} matching ${re}`);
    for (const c of mine) console.log(c.filter(Boolean).join(' | ').slice(0, 400));
    fs.writeFileSync(path.join(OUT, 'inbound-files.json'), JSON.stringify(all, null, 2));
    await page.screenshot({ path: path.join(OUT, 'inbound-files.png'), fullPage: true });
  } else if (mode === 'batches') {
    await page.keyboard.press('Alt+Shift+T');
    await page.waitForTimeout(4000);
    await page.getByText('Batch Process Info', { exact: true }).first().click();
    await page.waitForTimeout(5000);
    const rows = await page.evaluate(() => [...document.querySelectorAll('tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()).filter((t) => /fnol|inbound chunk|intake/i.test(t) && t.length < 400));
    console.log(rows.join('\n'));
    const r = page.locator('tr').filter({ hasText: /FNOL/i }).first();
    await r.scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: path.join(OUT, 'batch-info.png') });
  } else {
    for (const p of args) {
      const found = await S.searchClaims(page, { policy: p }).catch((e) => ({ rows: [`ERROR ${e.message.split('\n')[0]}`] }));
      console.log(`== ${p}: ${found.rows.length} row(s)`);
      for (const row of found.rows.slice(0, 15)) console.log(`  ${row.replace(/\s+/g, ' ').slice(0, 200)}`);
      await page.screenshot({ path: path.join(OUT, `policy-${p}.png`) });
    }
  }
  await browser.close();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
