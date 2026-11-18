'use strict';
// Read-only PolicyCenter Advanced policy search: node scripts/pcPolicySearch.js "<Product>" <State name> [--options]
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { chromium } = require('playwright');
const PC = require('../helpers/regression/policyCenter');
const [product, state, code] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const F = (s) => `select[name$="PolicySearchDV-${s}"]`;
(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const page = await (await b.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  await PC.withPC(page, async (pc) => {
    await pc.getByRole('menuitem', { name: 'Search', exact: true }).click().catch(() => {});
    await pc.waitForTimeout(3000);
    await pc.getByText('Advanced', { exact: true }).first().click();
    await pc.waitForTimeout(3000);
    if (process.argv.includes('--options')) {
      for (const s of ['SearchFor', 'ProductName', 'State']) console.log(s, ':', (await pc.locator(F(s)).locator('option').allInnerTexts()).join(' | '));
      return;
    }
    await pc.locator(F('SearchFor')).selectOption({ label: 'Policy' }).catch(() => {});
    await pc.waitForTimeout(1500);
    await pc.locator(F('ProductName')).selectOption({ label: product });
    await pc.waitForTimeout(1500);
    if (state) { await pc.locator(F('State')).selectOption({ label: state }); await pc.waitForTimeout(1500); }
    if (process.env.PCNUM) { await pc.locator('input[name$="PolicySearchDV-PolicyNumberCriterion"]').fill(process.env.PCNUM); }
    if (process.env.PCNAME) { await pc.locator('input[name$="GlobalContactNameInputSet-Name"]').fill(process.env.PCNAME); }
    if (process.env.PCASOF) { await pc.locator('input[name$="PolicySearchDV-AsOfDate"]').fill(process.env.PCASOF); await pc.keyboard.press('Tab'); }
    if (process.env.PCFOR) { await pc.locator(F('SearchFor')).selectOption({ label: process.env.PCFOR }); await pc.waitForTimeout(1500); }
    if (code) { await pc.locator('input[name$="PolicySearchDV-ProducerCode"]').fill(code); await pc.keyboard.press('Tab'); await pc.waitForTimeout(2000); }
    await pc.getByRole('button', { name: 'Search', exact: true }).first().click().catch(() => pc.getByText('Search', { exact: true }).last().click());
    await pc.waitForTimeout(6000);
    await pc.screenshot({ path: path.join(__dirname, '..', 'results', 'fnol-intake', 'pc-search-result.png'), fullPage: true });
    const rows = await pc.evaluate(() => [...document.querySelectorAll('tr')].filter((r) => r.offsetParent).map((r) => r.innerText.replace(/\s+/g, ' ').trim()).filter((t) => /\d{10}|[A-Z]{3}-\d{7}/.test(t) && t.length < 400));
    console.log(rows.length, 'rows');
    console.log(await pc.evaluate(() => [...document.querySelectorAll('[class*=pag], [class*=Pag]')].filter((e) => e.offsetParent).slice(0, 4).map((e) => e.outerHTML.slice(0, 600)).join('\n----\n'))); rows.slice(0, 15).forEach((r) => console.log(r));
    const msg = (await pc.locator('.gw-message, .message').allInnerTexts().catch(() => [])).join(' | ');
    if (msg) console.log('MSG', msg.slice(0, 900));
  });
  await b.close();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
