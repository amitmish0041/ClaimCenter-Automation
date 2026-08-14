const { chromium } = require('@playwright/test');
require('dotenv').config();
const { loginToClaimCenter } = require('./helpers/claimCenterBase');
const { completeFNOL } = require('./helpers/fnolHelper');
const { createReserve } = require('./helpers/financialsHelper');
const { assignClaim } = require('./helpers/claimLifecycleHelper');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 250 });
  const page = await browser.newPage();
  await loginToClaimCenter(page);

  const cn = await completeFNOL(page, {
    policyNumber: '1002239222',
    lossDetails: { lossDate: '07/09/2026', description: 'Diag headed test' },
    exposures: [{ coverageLabel: 'Collision' }],
  });
  console.log('Claim created:', cn);

  await assignClaim(page);
  console.log('Assign completed');

  await createReserve(page, { reserveAmount: 5000 });
  console.log('Reserve created');

  await page.waitForTimeout(15000);
  await browser.close();
})();
