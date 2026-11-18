'use strict';
// Read-only PolicyCenter probe: opens Search > Policies (Advanced) and prints the screen text.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { chromium } = require('playwright');
const PC = require('../helpers/regression/policyCenter');
(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const page = await (await b.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  await PC.withPC(page, async (pc) => {
    await pc.getByRole('menuitem', { name: 'Search', exact: true }).click().catch(() => {});
    await pc.waitForTimeout(4000);
    await pc.getByText('Advanced', { exact: true }).first().click();
    await pc.waitForTimeout(3000);
    await pc.screenshot({ path: path.join(__dirname, '..', 'results', 'fnol-intake', 'pc-search.png') });
    const t = await pc.locator('body').innerText();
    console.log(t.replace(/\n(Alabama|Alaska)[\s\S]*?Wyoming/g, ' [states]').slice(0, 3000));
    const ids = await pc.evaluate(() => [...document.querySelectorAll('input,select')].filter((e) => e.offsetParent).map((e) => e.name || e.id));
    console.log(ids.join('\n'));
  });
  await b.close();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
