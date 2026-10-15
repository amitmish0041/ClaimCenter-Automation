/**
 * helpers/s3Download/renewSession.js
 * Unattended renewal of the shared S3 (Okta) session: email + Next/SSO in a fresh browser, then save the cookies
 * via oktaSessionStore (to SMARTCOMM_OKTA_SESSION_FILE). Used by scripts/renewS3Session.js and, on the owner's
 * PC (SMARTCOMM_OKTA_AUTO_RENEW=1), by s3AdminService.loginAndEnsureTestPlanet when the shared session has
 * expired. Never enters a password; returns false if Okta asks for more than the email.
 */
'use strict';
const { chromium } = require('playwright');
const oktaSessionStore = require('./oktaSessionStore');

const S3_ADMIN_URL = 'https://intadmin-develop-donegal-dngldev-gwjutro.beta5-andromeda.guidewire.net/s3';
const LOGIN_EMAIL = process.env.SMARTCOMM_OKTA_LOGIN_EMAIL || 'amitmishra@donegalgroup.com';

async function renewSharedSession({ log = console.log, headed = false, timeoutMs = 120000 } = {}) {
  const browser = await chromium.launch({ headless: !headed, channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    log(`[S3 renew] Signing in to the S3 admin tool as ${LOGIN_EMAIL} (email + SSO, no password)...`);
    await page.goto(S3_ADMIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1500);
      if (page.url().startsWith('https://intadmin-') && await page.locator('text=Integration Files').first().isVisible().catch(() => false)) {
        await oktaSessionStore.saveFromContext(page.context(), { log });
        log(`[S3 renew] Renewed — shared session saved to ${oktaSessionStore.SESSION_FILE}`);
        return true;
      }
      if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)
        || await page.getByText(/verify|push notification|security key|enter a code/i).first().isVisible().catch(() => false)) {
        log('[S3 renew] Okta asked for a password/MFA — can\'t renew unattended. Run "node scripts/establishS3Session.js" at the desk.');
        return false;
      }
      if (await page.getByText(/GENERAL_NONSUCCESS|Login Failed/i).first().isVisible().catch(() => false)) {
        log('[S3 renew] Okta rejected the email-only sign-in (GENERAL_NONSUCCESS). Run "node scripts/establishS3Session.js" at the desk.');
        return false;
      }
      const email = page.locator('input[name="identifier"], input[type="email"], input[name="username"], input[name*="email" i]').first();
      if (await email.isVisible().catch(() => false) && !(await email.inputValue().catch(() => ''))) await email.fill(LOGIN_EMAIL);
      const btn = page.getByRole('button', { name: /sso|single sign|next|sign in|log ?in|continue|submit/i })
        .or(page.locator('input[type="submit"], button[type="submit"]')).first();
      if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(2500);
      }
    }
    log(`[S3 renew] Timed out (still at ${page.url().slice(0, 80)}) — not renewed.`);
    return false;
  } finally {
    await browser.close();
  }
}

module.exports = { renewSharedSession };
