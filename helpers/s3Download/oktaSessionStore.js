/**
 * helpers/s3Download/oktaSessionStore.js
 * Persists the browser cookies established by a successful, human-completed Okta sign-in for the S3
 * Integration Files admin tool (see s3AdminService.js) to a local, gitignored file, so later runs can
 * restore them instead of attempting Okta's "network-zone trust" email-only flow — CONFIRMED live
 * 2026-10-01 that flow now fails immediately with a 400 "GENERAL_NONSUCCESS" error (not a slow-but-working
 * redirect — a hard rejection within 5s), while the SAME account signs in instantly in a real, already-
 * trusted browser. Session-cookie reuse sidesteps whatever device/browser-level trust signal Okta is
 * actually keying off, by just presenting it the proof of an already-completed login instead of asking it
 * to silently vouch for a brand-new, untrusted browser each time — same idea as azureSessionStore.js, which
 * already does exactly this for the separate SmartCOMM Interactive Azure SSO login.
 *
 * Cookie-only (not full storageState/localStorage) — Okta sessions are normally cookie-based (the `sid`
 * cookie on *.okta.com in particular). If a restored session still keeps re-prompting, some of what the SP
 * app needs may live in localStorage instead, and this would need extending — flagged here rather than
 * guessed at.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SESSION_FILE = process.env.SMARTCOMM_OKTA_SESSION_FILE
  || path.join(__dirname, '..', '..', '.smartcomm-okta-session.json');

// The IdP (okta.com, any subdomain including guidewire-hub.okta.com) and the SP app's own domain
// (beta5-andromeda.guidewire.net, covers intadmin-...) — never ClaimCenter's own session cookies.
const RELEVANT_DOMAIN_RE = /(^|\.)(okta\.com|beta5-andromeda\.guidewire\.net)$/i;

async function saveFromContext(context, { log = console.log } = {}) {
  try {
    const all = await context.cookies();
    const relevant = all.filter((c) => RELEVANT_DOMAIN_RE.test(c.domain || ''));
    if (!relevant.length) { log('[OktaSession] No Okta/S3-admin cookies found to save — nothing persisted.'); return; }
    // Write-then-rename so a reader on the shared team drive (the packaged build points SESSION_FILE there)
    // never catches a half-written file: readers see either the old complete file or the new one, never a
    // truncated middle. Same-volume rename is atomic/replace on Windows.
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    const tmp = `${SESSION_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), cookies: relevant }, null, 1));
    fs.renameSync(tmp, SESSION_FILE);
    log(`[OktaSession] Saved ${relevant.length} cookie(s) to ${SESSION_FILE} for reuse by later runs.`);
  } catch (e) {
    log(`[OktaSession] Could not save session: ${e.message}`);
  }
}

async function loadIntoContext(context, { log = console.log } = {}) {
  if (!fs.existsSync(SESSION_FILE)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (!data.cookies || !data.cookies.length) return false;
    await context.addCookies(data.cookies);
    log(`[OktaSession] Loaded ${data.cookies.length} saved cookie(s) from ${SESSION_FILE} (saved ${data.savedAt}) — will try to skip a fresh Okta sign-in.`);
    return true;
  } catch (e) {
    log(`[OktaSession] Could not load saved session: ${e.message}`);
    return false;
  }
}

function clearSaved({ log = console.log } = {}) {
  if (fs.existsSync(SESSION_FILE)) { fs.unlinkSync(SESSION_FILE); log(`[OktaSession] Deleted ${SESSION_FILE}.`); }
}

module.exports = { SESSION_FILE, saveFromContext, loadIntoContext, clearSaved };
