/**
 * helpers/smartComm/azureSessionStore.js
 * Persists the browser cookies established by a successful SmartCOMM Interactive-session Azure SSO login
 * (see interactiveEditService.js) to a local, gitignored file, so a later run — or a later scenario in the
 * SAME run — can restore them instead of forcing a fresh email/password/MFA challenge every time.
 *
 * Why this is needed at all: each scenario calls loginAsUser/loginAsAdmin (claimCenterBase.js), which does
 * `context.clearCookies()` before switching ClaimCenter identities — by design, so each scenario simulates a
 * genuinely different adjuster. That wipes EVERY cookie in the browser context, Azure/Keycloak's SmartCOMM
 * session included, which is why a template with 3 scenarios was asking for 3 separate live logins.
 * CONFIRMED live 2026-09-28 that this is exactly the mechanism (not that Azure re-challenges by choice).
 *
 * Cookie-only (not full storageState/localStorage) — Keycloak/Azure AD SSO continuation is normally
 * cookie-based. If a restored session still keeps re-prompting, some of what these apps need may live in
 * localStorage instead, and this would need extending — flagged here rather than guessed at.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SESSION_FILE = process.env.SMARTCOMM_AZURE_SESSION_FILE
  || path.join(__dirname, '..', '..', '.smartcomm-azure-session.json');

// Only cookies for the domains actually involved in the Interactive login chain — never ClaimCenter's own
// session cookies, which each scenario is SUPPOSED to churn through on its own.
const RELEVANT_DOMAIN_RE = /(^|\.)(theconversation\.cloud|smartcommunications\.cloud|microsoftonline\.com|microsoft\.com|msftauth\.net|msauth\.net|live\.com)$/i;

async function saveFromContext(context, { log = console.log } = {}) {
  try {
    const all = await context.cookies();
    const relevant = all.filter((c) => RELEVANT_DOMAIN_RE.test(c.domain || ''));
    if (!relevant.length) { log('[AzureSession] No SmartCOMM/Azure cookies found to save — nothing persisted.'); return; }
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ savedAt: new Date().toISOString(), cookies: relevant }, null, 1));
    log(`[AzureSession] Saved ${relevant.length} cookie(s) to ${SESSION_FILE} for reuse by later scenarios/runs.`);
  } catch (e) {
    log(`[AzureSession] Could not save session: ${e.message}`);
  }
}

async function loadIntoContext(context, { log = console.log } = {}) {
  if (!fs.existsSync(SESSION_FILE)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (!data.cookies || !data.cookies.length) return false;
    await context.addCookies(data.cookies);
    log(`[AzureSession] Loaded ${data.cookies.length} saved cookie(s) from ${SESSION_FILE} (saved ${data.savedAt}) — will try to skip a fresh sign-in.`);
    return true;
  } catch (e) {
    log(`[AzureSession] Could not load saved session: ${e.message}`);
    return false;
  }
}

function clearSaved({ log = console.log } = {}) {
  if (fs.existsSync(SESSION_FILE)) { fs.unlinkSync(SESSION_FILE); log(`[AzureSession] Deleted ${SESSION_FILE}.`); }
}

module.exports = { SESSION_FILE, saveFromContext, loadIntoContext, clearSaved };
