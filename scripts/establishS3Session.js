#!/usr/bin/env node
/**
 * scripts/establishS3Session.js
 * One-time (or "whenever the cached session expires") setup: opens a real, visible browser on the S3
 * Integration Files admin tool and waits for a human to complete whatever Okta actually asks for (password,
 * MFA, anything), then saves the resulting session cookies via oktaSessionStore.js so every later automated
 * run (s3AdminService.loginAndEnsureTestPlanet) can load them and skip straight past sign-in.
 *
 * Needed because the tool's own "network-zone trust" email-only flow — which used to sign a brand-new,
 * cookie-less browser in silently — now fails immediately with Okta's own 400 "GENERAL_NONSUCCESS" error
 * (CONFIRMED live 2026-10-01), even though the exact same account signs in instantly in a real, already-
 * authenticated browser. A real human completing a real sign-in once, in a real (if automation-launched)
 * browser, sidesteps whatever device/browser trust signal is actually being checked.
 *
 * Usage: node scripts/establishS3Session.js
 */
'use strict';
require('dotenv').config();
const { chromium } = require('playwright');
const { S3_ADMIN_URL } = require('../helpers/s3Download/s3AdminService');
const oktaSessionStore = require('../helpers/s3Download/oktaSessionStore');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  page.setDefaultTimeout(600000);
  try {
    console.log(`Opening ${S3_ADMIN_URL} ...`);
    console.log('Complete whatever Okta asks for (email, password, MFA, etc.) in the browser window now.');
    console.log('Waiting up to 10 minutes for the admin tool to actually load...');
    await page.goto(S3_ADMIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

    const deadline = Date.now() + 600000;
    let landed = false;
    while (Date.now() < deadline) {
      if (page.url().startsWith('https://intadmin-')) {
        const integrationFilesVisible = await page.locator('text=Integration Files').first().isVisible().catch(() => false);
        if (integrationFilesVisible) { landed = true; break; }
      }
      await page.waitForTimeout(1000);
    }

    if (!landed) {
      console.error('Timed out waiting for the admin tool to load (10 minutes). Nothing was saved — rerun when ready.');
      process.exitCode = 1;
      return;
    }

    console.log('Signed in successfully — saving the session...');
    await oktaSessionStore.saveFromContext(page.context(), { log: console.log });
    console.log('Done. Future automated runs will load this session automatically.');
  } finally {
    await browser.close();
  }
})();
