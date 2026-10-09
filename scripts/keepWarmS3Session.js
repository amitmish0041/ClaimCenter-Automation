#!/usr/bin/env node
/**
 * scripts/keepWarmS3Session.js
 * Keeps the SHARED S3 (Okta) sign-in session alive so the team's SmartCOMM runs (Download from S3 + Interactive
 * template validation, both via helpers/s3Download/s3AdminService.js) don't hit S3_SHARED_SESSION_EXPIRED mid-day.
 *
 * The Okta session is short-lived and dies on an idle timeout. This loads the shared session, hits the admin
 * tool once (which resets Okta's idle timer server-side), and — if it still landed — re-saves the (possibly
 * refreshed) cookies back, atomically. Run on a timer (see the scheduled task set up alongside this), it holds
 * the session open as long as the owner's machine is on and logged in.
 *
 * It only MAINTAINS a live session; it cannot resurrect a dead one. If the session has already expired (or the
 * drive isn't reachable), it logs that and leaves the shared file untouched — a human still has to run
 * "Establish S3 Session" once to re-create it. See [[project_cc_s3_shared_session]].
 *
 * Config (all via env, so nothing machine-specific lives here):
 *   SMARTCOMM_OKTA_SESSION_FILE  the shared session file to keep warm (point at the UNC path, not a mapped drive)
 *   PLAYWRIGHT_BROWSERS_PATH     where the bundled Chromium lives (channel:'chromium' uses the full browser)
 *   KEEPWARM_LOG                 optional log file (default: keepwarm.log next to the session file)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const S3_ADMIN_URL = 'https://intadmin-develop-donegal-dngldev-gwjutro.beta5-andromeda.guidewire.net/s3';
const RELEVANT_DOMAIN_RE = /(^|\.)(okta\.com|beta5-andromeda\.guidewire\.net)$/i;
const SESSION_FILE = process.env.SMARTCOMM_OKTA_SESSION_FILE;
const LOG_FILE = process.env.KEEPWARM_LOG || (SESSION_FILE ? path.join(path.dirname(SESSION_FILE), 'keepwarm.log') : null);

function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}`;
  if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* ignore log failures */ } }
  console.log(line);
}

(async () => {
  if (!SESSION_FILE) { log('SKIP: SMARTCOMM_OKTA_SESSION_FILE not set.'); process.exit(0); }
  if (!fs.existsSync(SESSION_FILE)) { log(`SKIP: no session file at ${SESSION_FILE} (drive not reachable, or never established).`); process.exit(0); }
  let data;
  try { data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); }
  catch (e) { log(`SKIP: could not read session file: ${e.message}`); process.exit(0); }

  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chromium' });
    const ctx = await browser.newContext();
    await ctx.addCookies(data.cookies || []);
    const page = await ctx.newPage();
    await page.goto(S3_ADMIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);

    if (!page.url().startsWith('https://intadmin-')) {
      log('EXPIRED: shared session no longer lands on the admin tool — it needs a human "Establish S3 Session". Shared file left unchanged.');
      process.exit(0);
    }
    // Still valid: re-capture the (possibly rotated) cookies and write them back atomically, so the session
    // keeps extending. The goto above already reset Okta's idle timer server-side.
    const relevant = (await ctx.cookies()).filter((c) => RELEVANT_DOMAIN_RE.test(c.domain || ''));
    const tmp = `${SESSION_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), cookies: relevant }, null, 1));
    fs.renameSync(tmp, SESSION_FILE);
    log(`OK: session kept warm, re-saved ${relevant.length} cookie(s).`);
  } catch (e) {
    log(`ERROR: ${String(e.message).split('\n')[0]}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  process.exit(0);
})();
