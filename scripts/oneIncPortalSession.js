#!/usr/bin/env node
/**
 * scripts/oneIncPortalSession.js — ONE long-lived, signed-in browser on the OneInc (ProcessOne) staging portal that the
 * OneInc-side checks attach to, so the portal's login + verification step is done once, by a person, not per case
 * (user direction 2026-11-11).
 *
 *   ONEINC_PORTAL_USER=… ONEINC_PORTAL_PASS=… node scripts/oneIncPortalSession.js
 *
 * - Opens a visible Chromium with a persistent profile (results/oneInc/portal-profile — local to this PC, never shared:
 *   it holds the portal session) and a DevTools port (ONEINC_PORTAL_CDP_PORT, default 9333).
 * - Fills the username/password (from the environment only — nothing is stored) and waits up to 15 min for the person
 *   to finish the portal's verification step; then prints "[Portal] READY" and stays open until the window is closed.
 * - Other scripts attach with helpers/oneInc/portal.js → connect(), which reuses this browser's signed-in page.
 */
'use strict';

const path = require('path');
const { chromium } = require('playwright');

// The portal sits behind Cloudflare Access + OneInc's Microsoft sign-in (CONFIRMED 2026-11-11); its /IdentityProvider/auth/login
// link alone answers 404, so start at the root and let the redirects run.
const URL = process.env.ONEINC_PORTAL_URL || 'https://stgportalone.processonepayments.com/';
const PORT = Number(process.env.ONEINC_PORTAL_CDP_PORT || 9333);
const PROFILE = path.join(__dirname, '..', 'results', 'oneInc', 'portal-profile');

const signedIn = (u) => /stgportalone\.processonepayments\.com/i.test(u) && !/\/auth\/login|IdentityProvider\/auth|\/error\//i.test(u);

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false, viewport: { width: 1500, height: 950 }, args: [`--remote-debugging-port=${PORT}`],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  if (!signedIn(page.url())) {
    const user = process.env.ONEINC_PORTAL_USER;
    const pass = process.env.ONEINC_PORTAL_PASS;
    if (!user || !pass) { console.log('[Portal] ONEINC_PORTAL_USER / ONEINC_PORTAL_PASS not set — sign in by hand in the window'); }
    else {
      const userBox = page.locator('input[type=email], input[name*=user i], input[id*=user i], input[name*=email i], input[type=text]').first();
      await userBox.waitFor({ timeout: 30000 }).catch(() => {});
      await userBox.fill(user).catch(() => {});
      const passBox = page.locator('input[type=password]').first();
      if (!await passBox.isVisible().catch(() => false)) { // two-step form: username first
        await page.getByRole('button', { name: /next|continue/i }).first().click().catch(() => {});
        await passBox.waitFor({ timeout: 15000 }).catch(() => {});
      }
      await passBox.fill(pass).catch(() => {});
      await page.getByRole('button', { name: /sign in|log ?in|submit|continue/i }).first().click().catch(() => passBox.press('Enter'));
      console.log('[Portal] credentials entered — complete the verification step in the browser window');
    }
  }
  const t0 = Date.now();
  while (!signedIn(page.url()) || /verif|mfa|code|otp|challenge/i.test(page.url())) {
    if (Date.now() - t0 > 15 * 60e3) { console.log(`[Portal] still not signed in after 15 min (at ${page.url()})`); break; }
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000);
  console.log(`[Portal] READY — ${page.url()} (DevTools port ${PORT}); leave this window open`);
  await new Promise((r) => ctx.on('close', r));
  console.log('[Portal] closed');
})().catch((e) => { console.error('[Portal] fatal:', e.message); process.exit(1); });
