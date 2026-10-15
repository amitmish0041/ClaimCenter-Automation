/**
 * helpers/s3Download/s3AdminService.js
 * Drives Guidewire's Jutro-based S3 Integration Files admin UI
 * (https://intadmin-develop-donegal-dngldev-gwjutro.beta5-andromeda.guidewire.net/s3)
 * to find and download a ClaimCenter SmartCOMM output file by (a substring of) its S3 key.
 *
 * Auth: this is a real Okta-federated corporate login (guidewire-hub.okta.com), NOT one of this repo's
 * shared test accounts. CONFIRMED live 2026-09-28: from this network, typing just the corporate email and
 * submitting signs straight in with no password/MFA prompt (Okta network-zone trust, not a saved browser
 * cookie — reproduced across several brand-new, cookie-less browser contexts). If Okta ever DOES challenge
 * for a password/MFA here, loginAndEnsureTestPlanet throws rather than guessing at further steps — this
 * script only ever knows an email address, never a password.
 *
 * Search behaviour CONFIRMED live: the SmartCOMM node appears at more than one place in the left tree
 * (ClaimCenter Inbound Pending, ClaimCenter Outbound, BillingCenter Outbound), and the SAME key substring
 * can match a DIFFERENT, unrelated object in each — e.g. key "...199082294229" matched the real generated
 * PDF ("output/output/12cab220-...pdf", 63 KB) under ClaimCenter Inbound Pending, but a same-substring,
 * unrelated 716 KB "input/..." object with no file extension under ClaimCenter Outbound.
 *
 * CONFIRMED live 2026-09-30: the tree goes one level deeper than originally assumed — "ClaimCenter Inbound
 * Pending > smartcomm" is a PARENT node whose actual generated-PDF files live in its own "output" child
 * (`label-cc/inbound-files/pending/smartcomm/output`), and the same Document Properties Identifier used to
 * fetch the PDF ALSO resolves a genuinely different file — the ORIGINAL PAYLOAD ClaimCenter sent to
 * SmartCOMM — under a completely different branch, "ClaimCenter Outbound > smartcomm > input"
 * (`label-cc/outbound-files/smartcomm/input`). This is what documentService.downloadPayload()'s Create-tab
 * "Download Payload" button was standing in for — CONFIRMED that button is frequently unavailable in this
 * Test environment (see validationService.js's own history), while the SAME payload is reliably retrievable
 * here in S3 by the SAME identifier already being used for the PDF — so fetching it from here instead is
 * both more reliable and lets one S3 visit retrieve both files together, rather than needing a separate trip
 * through the Create tab before Complete Document.
 */
'use strict';
const oktaSessionStore = require('./oktaSessionStore');

// Env-overridable so an admin can point at a different S3 Integration Files admin URL from the Admin tab
// (runner/server.js applies admin-config.s3.adminUrl -> SMARTCOMM_S3_ADMIN_URL) without a rebuild.
const S3_ADMIN_URL = process.env.SMARTCOMM_S3_ADMIN_URL
  || 'https://intadmin-develop-donegal-dngldev-gwjutro.beta5-andromeda.guidewire.net/s3';
// The corporate email typed into Okta on the email-only sign-in fallback. Env-overridable so it isn't a
// single person's address baked into every machine — in the packaged build the automated path never runs
// this anyway (see READONLY_SESSION below), but on a dev machine it fills whoever's own Okta account.
const LOGIN_EMAIL = process.env.SMARTCOMM_OKTA_LOGIN_EMAIL || 'amitmishra@donegalgroup.com';
// Shared-session mode (set by the packaged app - electron-app/main.js): the ONE Okta sign-in lives in a
// shared file on the team drive and is established just once, by the owner. No other machine ever signs in
// to Okta itself - it only loads those cookies. So an automated run here NEVER types an email into Okta and
// NEVER overwrites the shared file; if the loaded session didn't land, it fails with a clear "ask the owner
// to refresh it" message instead. SESSION_OWNER just names who that is in that message.
const READONLY_SESSION = process.env.SMARTCOMM_OKTA_SESSION_READONLY === '1';
const SESSION_OWNER = process.env.SMARTCOMM_OKTA_SESSION_OWNER || 'the tool owner';
// ClaimCenter > Outbound > smartcomm > output > archive (the completed/generated PDFs). CHANGED 2026-10-13
// (per user — the S3 bucket layout moved): the generated documents used to live under ClaimCenter Inbound
// Pending > smartcomm > output > output (full key cc/inbound-files/pending/smartcomm/output/output); they are
// now delivered to Outbound > smartcomm > output > archive (full key cc/outbound-files/smartcomm/output/
// archive). The data-testids follow the UI's own `chevron-<key path>` / `label-<key path>` convention — note
// the "Outbound > smartcomm" parent chevron below is the SAME one INPUT_NODE already uses, which confirms the
// convention holds for this branch. Prior-location notes kept for reference:
// CONFIRMED live 2026-09-30
// this is TWO "output" levels deep, not one: the first "output" is itself a parent of two children, "logs"
// (895 items) and a second, identically-named "output" (104 items, the real PDFs) — its own item count
// exactly equals the parent's, 895+104=999, which is what made the shallower node look plausible at first)
// and Outbound > smartcomm > input (the original payload) — each entry is the full CHAIN of chevrons to
// expand every intermediate parent, plus the label of the final child to select.
const OUTPUT_NODE = { chevrons: ['chevron-cc/outbound-files/smartcomm', 'chevron-cc/outbound-files/smartcomm/output'], label: 'label-cc/outbound-files/smartcomm/output/archive' };
const INPUT_NODE = { chevrons: ['chevron-cc/outbound-files/smartcomm'], label: 'label-cc/outbound-files/smartcomm/input' };
const MAX_MATCHES = 10; // a too-broad key could otherwise bulk-download/email an unbounded number of files

async function currentPlanet(page) {
  const m = (await page.evaluate(() => document.body.innerText)).match(/Planet:\s*(\w+)/);
  return m ? m[1] : null;
}

// Ensures the admin tool is on Planet = Test, switching from whatever it's on if needed. Extracted so it can
// run BEFORE EVERY search (see searchNode), not only once at login: a search on the wrong planet silently
// returns the WRONG files or none at all, and this Jutro admin app is known to reset its own session UI state
// unprompted (see ensureExpanded's note on the left-nav tree re-collapsing after idle). Cheap when already on
// Test - it just reads the badge and returns; it only pays the multi-click switch cost when it genuinely
// isn't. Retries the switch once before giving up, since every step is a click against the same flaky UI.
async function ensureTestPlanet(page, { log = console.log, maxAttempts = 2 } = {}) {
  // The "Planet: ..." badge can take a beat to (re)paint after a navigation - poll briefly for a non-null
  // reading rather than misreading a mid-render blank as "not Test" and switching needlessly.
  let planet = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    planet = await currentPlanet(page);
    if (planet) break;
    await page.waitForTimeout(400);
  }
  if (planet === 'Test') { log('[S3] Planet already Test'); return; }
  // No "Planet:" badge at all = this isn't the admin tool any more — the shared S3 sign-in lapsed and the page
  // is showing Okta's sign-in (CONFIRMED 2026-10-15: overnight expiry surfaced as "waiting for getByRole(
  // 'menuitem', { name: 'Settings' })" on every run). Say so plainly instead of hunting for a Settings menu.
  if (!planet) {
    const settingsShown = await page.getByRole('menuitem', { name: 'Settings', exact: true }).first().isVisible().catch(() => false);
    if (!settingsShown) {
      throw new Error(
        `S3_SHARED_SESSION_EXPIRED: the S3 admin tool is showing its sign-in page instead of Integration Files (${page.url().slice(0, 60)}) ` +
        `— the shared S3 sign-in session has expired. Ask ${SESSION_OWNER} to renew it ("Establish S3 Session", or node scripts/renewS3Session.js), then retry.`
      );
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`[S3] Planet is "${planet}" — switching to Test (attempt ${attempt}/${maxAttempts})`);
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).first().click();
    await page.waitForTimeout(1000);
    // Card order: Language and Regional format / Theme / Navigation / Planet — Planet's own Edit button is the 4th.
    const planetCard = page.locator('h2', { hasText: 'Planet' }).locator('..').locator('..');
    await planetCard.getByRole('button', { name: 'Edit' }).click();
    await page.waitForTimeout(500);
    await page.locator('button[data-value="test"]').click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(1500);
    await page.getByRole('menuitem', { name: 'Integration Files', exact: true }).first().click();
    await page.waitForTimeout(1500);
    planet = await currentPlanet(page);
    if (planet === 'Test') { log('[S3] Planet switched to Test'); return; }
    log(`[S3] Planet still "${planet}" after switch attempt ${attempt} — retrying.`);
  }
  throw new Error(`S3_PLANET_SWITCH_FAILED: still shows "${planet}" after ${maxAttempts} attempt(s) to switch to Test.`);
}

// Logs in and lands on the Integration Files tab with Planet = Test. CONFIRMED live 2026-10-01: the
// email-only "network-zone trust" flow this originally relied on now fails immediately with Okta's own 400
// "GENERAL_NONSUCCESS" error (not a slow-but-working redirect — confirmed stable/unchanging at both 5s and
// 20s after submitting the email), while the exact same account signs in instantly in a real, already-
// authenticated browser — pointing at a device/browser-trust signal a brand-new Playwright context can't
// replicate, not a URL or timing problem. Tries a saved Okta session (see oktaSessionStore.js, same pattern
// as azureSessionStore.js for the separate SmartCOMM Interactive Azure login) FIRST; only falls back to the
// original email-only attempt if no saved session exists yet or it didn't land on intadmin- either. On any
// path that ends up signed in, (re-)saves the session so the NEXT run can skip straight past this.
async function loginAndEnsureTestPlanet(page, { log = console.log } = {}) {
  const hadSavedSession = await oktaSessionStore.loadIntoContext(page.context(), { log });
  await page.goto(S3_ADMIN_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1200);

  let landed = page.url().startsWith('https://intadmin-');

  // Owner's PC only (SMARTCOMM_OKTA_AUTO_RENEW=1 — set in this repo's .env, which installed copies never get):
  // an expired shared session is renewed on the spot (email + SSO, no password — renewSession.js) and this run
  // carries on, instead of failing with S3_SHARED_SESSION_EXPIRED until someone renews it by hand. Once per process.
  if (!landed && READONLY_SESSION && process.env.SMARTCOMM_OKTA_AUTO_RENEW === '1' && !loginAndEnsureTestPlanet.renewTried) {
    loginAndEnsureTestPlanet.renewTried = true;
    log('[S3] Shared S3 session has expired — renewing it automatically (email + SSO)...');
    const { renewSharedSession } = require('./renewSession');
    if (await renewSharedSession({ log }).catch((e) => { log(`[S3] renewal failed: ${e.message}`); return false; })) {
      // Drop the expired cookies first — left in place (e.g. a stale okta.com "sid" on a different domain/path
      // than the new one) they still get sent and the page stays signed out.
      await page.context().clearCookies();
      await oktaSessionStore.loadIntoContext(page.context(), { log });
      await page.goto(S3_ADMIN_URL, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(1200);
      landed = page.url().startsWith('https://intadmin-');
    }
  }

  // Shared-session mode: this machine must not sign in to Okta itself. A session that didn't land is either
  // missing, expired, or the team drive holding it isn't reachable - fail fast with an actionable message
  // instead of attempting the (now-dead, see below) email-only flow or writing to the shared file.
  if (!landed && READONLY_SESSION) {
    throw new Error(
      `S3_SHARED_SESSION_EXPIRED: the shared S3 sign-in session (${oktaSessionStore.SESSION_FILE}) is missing, ` +
      `expired, or the team drive holding it isn't reachable. Ask ${SESSION_OWNER} to open the SmartCOMM tab ` +
      `and run "Establish S3 Session" once to refresh it (and check your team drive is connected), then retry.`
    );
  }

  if (!landed) {
    if (hadSavedSession) {
      log('[S3] Saved Okta session did not land on the admin tool (likely expired) — falling back to a fresh sign-in attempt.');
    }
    const emailField = page.locator('input[name="identifier"], input[type="email"], input[name="username"]').first();
    if (await emailField.isVisible().catch(() => false)) {
      await emailField.fill(LOGIN_EMAIL);
      await page.locator('input[type="submit"], button[type="submit"]').first().click();
      // Poll rather than a fixed sleep: either we land on the admin app (success), Okta asks for something
      // beyond email (password/MFA, which this script cannot and must not attempt to satisfy), or — CONFIRMED
      // live 2026-10-01 — Okta rejects the attempt outright with its own 400 "GENERAL_NONSUCCESS" error page,
      // checked for explicitly so this fails fast with a clear, actionable message instead of burning the
      // full deadline waiting on a state that's already final.
      const deadline = Date.now() + 15000;
      let landed = false;
      while (Date.now() < deadline) {
        const url = page.url();
        if (url.startsWith('https://intadmin-')) { landed = true; break; }
        const challenged = await page.locator(
          'input[type="password"], text=/verify|push notification|security key|enter a code/i'
        ).first().isVisible().catch(() => false);
        if (challenged) {
          throw new Error(
            'S3_LOGIN_CHALLENGE: Okta asked for more than the corporate email (password/MFA) — this only works when ' +
            'network-zone trust silently signs the account in. Run "node scripts/establishS3Session.js" to complete a ' +
            'one-time manual sign-in and cache the session, then retry.'
          );
        }
        const rejected = await page.getByText(/GENERAL_NONSUCCESS|Login Failed/i).first().isVisible().catch(() => false);
        if (rejected) {
          throw new Error(
            'S3_LOGIN_REJECTED: Okta returned a 400 "GENERAL_NONSUCCESS" error for this sign-in attempt — a brand-new, ' +
            'un-trusted browser context apparently can\'t silently pass whatever device/browser trust check this relies on ' +
            'anymore, even though the same account signs in instantly in an already-authenticated real browser. Run ' +
            '"node scripts/establishS3Session.js" once to complete a real sign-in and cache the resulting session for reuse, ' +
            'then retry.'
          );
        }
        await page.waitForTimeout(500);
      }
      if (!landed) {
        throw new Error(`S3_LOGIN_TIMEOUT: still on "${page.url()}" 15s after submitting the email — login did not complete. Run "node scripts/establishS3Session.js" once to cache a real session, then retry.`);
      }
    }
  } else {
    log('[S3] Saved Okta session landed directly on the admin tool — skipped sign-in entirely.');
  }

  // Never re-save from an automated run in shared-session mode: concurrent QA downloads would otherwise race
  // each other writing the one shared file on the network drive. Only the explicit "Establish S3 Session"
  // flow (establishS3Session.js, run by the owner) writes it, via oktaSessionStore directly.
  if (!READONLY_SESSION) {
    await oktaSessionStore.saveFromContext(page.context(), { log });
  }

  await page.locator('[data-testid], text=Integration Files').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});

  await ensureTestPlanet(page, { log });
}

// Clicks `chevronTestId` and waits for `revealTestId` (the next chevron down, or the final label) to
// actually become visible — retrying the click itself (not just waiting longer) if it doesn't. CONFIRMED
// live 2026-10-05: a direct repro (one search, ~3 minutes idle, a second search) showed the Jutro admin
// app's own left-nav tree silently RE-COLLAPSES an already-expanded branch on its own after sitting idle —
// not a session/login/Planet problem (all three were still fine) and not a navigation away (URL, filter box
// and the previous search's own results were all still on screen) — just that branch's expand state reset.
// A single blind click (the old behavior here) doesn't verify it actually took effect, so a reset branch
// left this hanging on a label that no longer existed in the DOM at all until the full 30s action timeout.
async function ensureExpanded(page, chevronTestId, revealTestId, { log = console.log, maxAttempts = 3 } = {}) {
  const reveal = page.locator(`[data-testid="${revealTestId}"]`).first();
  if (await reveal.isVisible().catch(() => false)) return true;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.locator(`[data-testid="${chevronTestId}"]`).click().catch(() => {});
    const expanded = await reveal.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (expanded) return true;
    log(`[S3] Chevron "${chevronTestId}" click attempt ${attempt}/${maxAttempts} didn't reveal "${revealTestId}" yet — retrying.`);
  }
  return false;
}

// Opens a folder whose tree level may not exist right now. S3 "folders" are only key prefixes: once the filing
// job takes the last file out of output/archive, "output" and "archive" vanish from the tree entirely (CONFIRMED
// live 2026-10-13 ~23:30 — every later search failed on a 30s click at a label that wasn't there), and come back
// as soon as a file lands. Expanding a level re-reads it; if that level was already expanded (its child just
// wasn't there yet), the first click collapses it and the second expands it again with a fresh listing.
// Returns true once `node.label` is visible, false when the folder doesn't exist at the moment. Fast by design
// (short waits) — callers poll.
async function tryOpenFolder(page, node, { waitMs = 600 } = {}) {
  const label = page.locator(`[data-testid="${node.label}"]`).first();
  if (await label.isVisible().catch(() => false)) return true;
  for (let i = 0; i < node.chevrons.length; i++) {
    const reveal = page.locator(`[data-testid="${node.chevrons[i + 1] || node.label}"]`).first();
    if (await reveal.isVisible().catch(() => false)) continue;
    const chevron = page.locator(`[data-testid="${node.chevrons[i]}"]`).first();
    if (!(await chevron.isVisible().catch(() => false))) return false;
    let shown = false;
    for (let a = 0; a < 2 && !shown; a++) {
      await chevron.click().catch(() => {});
      shown = await reveal.waitFor({ state: 'visible', timeout: waitMs }).then(() => true).catch(() => false);
    }
    if (!shown) return false;
  }
  return label.isVisible().catch(() => false);
}

// The tree caches each level's children once read — collapsing and re-expanding "smartcomm" does NOT pick up
// an "output" folder created after that (CONFIRMED live 2026-10-14: the archive watch and the fallback search
// both kept missing a document that landed while the folder was absent). A page reload re-reads it, and is
// quick: ~1.6s until the tree is back, Planet still Test (CONFIRMED live). The folder view itself can't stand
// in — it lists at most 1,000 keys alphabetically, and input/ + logs/ fill those before output/ is reached.
async function reloadTree(page) {
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.locator('[data-testid="chevron-cc/outbound-files/smartcomm"]').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
}

// Returns [{ text, row: Locator }] for every visible row matching `key` under the given tree node
// ({chevron, label} data-testids — see OUTPUT_NODE/INPUT_NODE above). Each chevron expands its own parent
// level, VERIFIED (see ensureExpanded above) rather than a blind click-and-hope, since the tree can silently
// re-collapse on its own after sitting idle; the label then selects the actual child folder to list/filter.
async function searchNode(page, node, key, { log = console.log, folderDescription = node.label, retries = 2 } = {}) {
  // Re-verify Planet = Test before every search, not just once at login. A search on the wrong planet silently
  // returns the wrong files or none, and this admin app resets its own session state unprompted (see
  // ensureExpanded's tree-re-collapse note). No-op cost when already on Test (just a badge read).
  await ensureTestPlanet(page, { log });
  for (let i = 0; i < node.chevrons.length; i++) {
    const revealTestId = i + 1 < node.chevrons.length ? node.chevrons[i + 1] : node.label;
    const ok = await ensureExpanded(page, node.chevrons[i], revealTestId, { log });
    if (!ok) log(`[S3] WARNING: never confirmed "${node.chevrons[i]}" expanded "${revealTestId}" after retries — continuing anyway, the label click below will surface a clear error if the tree genuinely isn't in the right state.`);
  }
  if (!(await page.locator(`[data-testid="${node.label}"]`).first().isVisible().catch(() => false))
    && !(await tryOpenFolder(page, node))
    && !(await reloadTree(page).then(() => ensureTestPlanet(page, { log })).then(() => tryOpenFolder(page, node, { waitMs: 1500 })))) {
    // The folder isn't in the tree at all right now — it holds no files at the moment (see tryOpenFolder), so
    // nothing can match yet. 0 matches, not a 30s click timeout; polling callers simply look again.
    log(`[S3] "${folderDescription}" isn't in the S3 tree right now (it has no files at the moment) — 0 matches for "${key}".`);
    return [];
  }
  try {
    await page.locator(`[data-testid="${node.label}"]`).click();
  } catch (err) {
    // CONFIRMED live 2026-10-05: this click has hung its full 30s and failed after the shared page (see
    // s3SessionManager.js) sat idle through a long scenario's field-editing phase — root cause not yet
    // confirmed (session/UI timeout vs. a torn-down tree vs. something else). Captures what was ACTUALLY on
    // screen/in the DOM at the moment of failure instead of guessing, so the next occurrence has evidence.
    const path = require('path');
    const fs = require('fs');
    const diagDir = path.join(__dirname, '..', '..', 'results', 'smartComm', 'interactive-diagnostics');
    fs.mkdirSync(diagDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(diagDir, `s3_labelClick_timeout_${stamp}`);
    const diag = {
      url: page.url(),
      planet: await currentPlanet(page).catch(() => 'ERROR'),
      labelNodeCount: await page.locator(`[data-testid="${node.label}"]`).count().catch(() => -1),
      anyDataTestidCount: await page.locator('[data-testid]').count().catch(() => -1),
      bodyTextSnippet: (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 1000),
    };
    fs.writeFileSync(`${base}.json`, JSON.stringify(diag, null, 2));
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    log(`[S3] Label click failed for "${folderDescription}" — diagnostic saved: ${base}.png / .json (url=${diag.url}, planet=${diag.planet}, label still in DOM=${diag.labelNodeCount})`);
    throw err;
  }
  await page.waitForTimeout(1500);
  const filterBox = page.getByPlaceholder('Filter by key');
  await filterBox.fill(key);
  await page.waitForTimeout(1500);

  const rows = page.locator('table tbody tr, [role="row"]').filter({ hasText: key });
  let count = await rows.count();
  // CONFIRMED live 2026-09-30 (65-template sweep, DIG95): a scenario whose field-editing/Complete Document
  // steps ALL succeeded still errored here on a genuinely empty first search — almost certainly a real
  // upload-delivery lag between ClaimCenter completing the document and it actually landing in the S3
  // admin tool's own index, not a wrong key or a missing file. Re-filtering (not just re-counting the same
  // stale rows) after a short wait gives that lag a couple of chances to resolve before giving up.
  for (let attempt = 0; count === 0 && attempt < retries; attempt++) {
    log(`[S3] "${key}" → 0 matches under ${folderDescription} on attempt ${attempt + 1} — waiting in case of upload-delivery lag, then retrying...`);
    await page.waitForTimeout(3000);
    await filterBox.fill('');
    await page.waitForTimeout(300);
    await filterBox.fill(key);
    await page.waitForTimeout(1500);
    count = await rows.count();
  }
  log(`[S3] "${key}" → ${count} match(es) under ${folderDescription}`);
  if (count > MAX_MATCHES) {
    throw new Error(`S3_TOO_MANY_MATCHES: "${key}" matched ${count} files under ${folderDescription} (cap is ${MAX_MATCHES}) — use a more specific key (e.g. the full GUID).`);
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const text = (await row.innerText()).replace(/\s+/g, ' ').trim();
    out.push({ text, row });
  }
  return out;
}

// The generated PDF — ClaimCenter Outbound > smartcomm > output > archive (moved here 2026-10-13, see OUTPUT_NODE).
async function searchSmartComm(page, key, { log = console.log, retries } = {}) {
  return searchNode(page, OUTPUT_NODE, key, { log, retries, folderDescription: 'ClaimCenter Outbound > smartcomm > output > archive' });
}

// The ORIGINAL payload ClaimCenter sent to SmartCOMM for this same transaction — ClaimCenter Outbound >
// smartcomm > input. Same Document Properties Identifier as the PDF resolves this too (CONFIRMED live
// 2026-09-30), making the Create tab's own "Download Payload" button (frequently unavailable in this Test
// environment) unnecessary — this is fetched in the SAME S3 visit as the PDF instead.
async function searchSmartCommPayload(page, key, { log = console.log } = {}) {
  return searchNode(page, INPUT_NODE, key, { log, folderDescription: 'ClaimCenter Outbound > smartcomm > input' });
}

// Since 057b382 every launcher runs the FULL Chromium (channel:'chromium') instead of chromium-headless-shell.
// Unlike the shell, full Chromium has its built-in PDF viewer, so a PDF served inline (no "Content-Disposition:
// attachment") is RENDERED in a tab instead of firing a download event — the .json siblings still downloaded
// fine, but the PDF's own click just timed out. Forces every top-level PDF navigation in this context to be an
// attachment so Chromium downloads it instead. Only 'document' requests are touched; everything else passes
// straight through. Installed once per context.
const pdfAttachmentContexts = new WeakSet();
async function forcePdfDownloads(context) {
  if (pdfAttachmentContexts.has(context)) return;
  pdfAttachmentContexts.add(context);
  await context.route('**/*', async (route) => {
    const req = route.request();
    if (req.resourceType() !== 'document') return route.continue();
    let response;
    try { response = await route.fetch(); } catch (_) { return route.continue(); }
    const headers = response.headers();
    const isPdf = /application\/pdf/i.test(headers['content-type'] || '') || /\.pdf(\?|$)/i.test(req.url());
    if (isPdf && !/attachment/i.test(headers['content-disposition'] || '')) {
      const name = decodeURIComponent((new URL(req.url()).pathname.split('/').pop()) || 'document.pdf');
      headers['content-disposition'] = `attachment; filename="${name.replace(/"/g, '')}"`;
    }
    return route.fulfill({ response, headers });
  });
}

// Resolves with the first download fired by ANY page in the context — the admin UI may open the file in a new
// tab/popup, whose download event never reaches the original page's own waitForEvent('download').
function waitForAnyDownload(context, timeout) {
  return new Promise((resolve, reject) => {
    const pages = new Set();
    const onDownload = (d) => { cleanup(); resolve(d); };
    const watch = (p) => { if (!pages.has(p)) { pages.add(p); p.on('download', onDownload); } };
    const onPage = (p) => watch(p);
    const timer = setTimeout(() => { cleanup(); reject(new Error(`no download started within ${timeout}ms`)); }, timeout);
    function cleanup() {
      clearTimeout(timer);
      context.off('page', onPage);
      for (const p of pages) p.off('download', onDownload);
    }
    context.pages().forEach(watch);
    context.on('page', onPage);
  });
}

// Downloads each match into outDir, returns [{ text, fileName, localPath }].
async function downloadMatches(page, matches, outDir, { log = console.log } = {}) {
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(outDir, { recursive: true });
  const context = page.context();
  await forcePdfDownloads(context);
  const results = [];
  for (const m of matches) {
    const downloadBtn = m.row.getByRole('button', { name: 'Download' })
      .or(m.row.locator('[aria-label="Download"], [title="Download"]')).first();
    const pagesBefore = new Set(context.pages());
    const [download] = await Promise.all([
      waitForAnyDownload(context, 20000),
      downloadBtn.click(),
    ]);
    let fileName = download.suggestedFilename();
    let localPath = path.join(outDir, fileName);
    await download.saveAs(localPath);
    // Close any popup tab the download came through, so it doesn't linger on the shared S3 page's context.
    for (const p of context.pages()) if (!pagesBefore.has(p)) await p.close().catch(() => {});
    // Name by content, not by whatever the server suggested: a real PDF always gets a .pdf extension.
    const head = Buffer.alloc(5);
    const fd = fs.openSync(localPath, 'r'); fs.readSync(fd, head, 0, 5, 0); fs.closeSync(fd);
    if (head.toString('latin1') === '%PDF-' && !/\.pdf$/i.test(fileName)) {
      const renamed = `${fileName.replace(/\.[^.]*$/, '')}.pdf`;
      fs.renameSync(localPath, path.join(outDir, renamed));
      fileName = renamed;
      localPath = path.join(outDir, renamed);
    }
    log(`[S3] downloaded ${fileName} (${fs.statSync(localPath).size} bytes)`);
    results.push({ text: m.text, fileName, localPath });
  }
  return results;
}

// The generated PDF's own S3 folder (ClaimCenter Inbound Pending > smartcomm > output > output) ALSO holds a
// small per-document INDEXING/metadata object — ClaimCenter's own filing info (Drawer/Folder/DocType/
// Description/DocumentDate), NOT the document itself — that can match the SAME Document Properties
// Identifier. CONFIRMED live 2026-10-07 (DIG181/DIG223/DIG236/DIG36, 12/12 scenarios): every one of these
// downloaded a ~185-byte JSON object ({"Drawer":"CLMS","FileNumber":...,"DocType":"CORO"/"FROI",...}) instead
// of a real PDF, which then failed pdf-parse with "Invalid PDF structure" for every single scenario on every
// one of those templates — not an intermittent flake. `searchSmartComm`'s caller always took `matches[0]`
// (whichever object the admin UI's own table happened to sort first), with no way to tell the two apart —
// and since that ordering doesn't change just because the real PDF later also lands alongside it, re-trying
// the exact same "take the first match" logic can keep grabbing the SAME wrong object forever, not just
// occasionally. Downloads each current match in turn and keeps the first one whose own BYTES start with the
// real PDF magic header ("%PDF-") — content-sniffing instead of trusting position/order, which nothing here
// has ever reliably predicted. If NONE of the current matches are a real PDF yet, that could still just be
// genuine upload-delivery lag (the real document hasn't finished landing in S3) — keeps re-searching until a
// deadline before giving up with a clear, specific error distinguishing "found nothing at all" from "found
// only ClaimCenter's own metadata object, never the real document."
//
// Polls for up to SMARTCOMM_S3_WAIT_MS (default 5 min), not a fixed ~1 min. CONFIRMED live 2026-10-13: the
// archive is only a hand-off point — a downstream filing job picks up each PDF + .json pair and REMOVES it
// (every document fetched earlier that evening was gone ~30 min later). Most documents land within seconds,
// but some intermittently take minutes (same template/claim/user found instantly on one run, absent for a
// full minute on the next), and a late one could be filed away before anyone looked again. Re-checking every
// ~15s for longer catches it in that window instead of reporting a missing document.
async function downloadFirstValidPdf(page, key, outDir, { log = console.log, maxWaitMs = Number(process.env.SMARTCOMM_S3_WAIT_MS) || 300000, pollMs = 15000 } = {}) {
  const fs = require('fs');
  const deadline = Date.now() + maxWaitMs;
  // Through the admin UI's own API when its token is available (see apiList) — a 2s poll instead of a 15s one,
  // and immune to the archive folder vanishing from the tree whenever it's empty.
  const holder = await ensureApiAuth(page, { log }).catch(() => ({}));
  if (holder.authorization) {
    let lastCount = 0;
    for (let attempt = 1; ; attempt++) {
      const objs = await listForKey(page, key, { log });
      lastCount = objs.length;
      const pdf = objs.find((o) => /\.pdf$/i.test(o.key));
      if (pdf) {
        try {
          const d = await apiDownload(page, pdf.key, outDir, { log });
          if (fs.readFileSync(d.localPath).slice(0, 5).toString('latin1') === '%PDF-') { log(`[S3] downloaded ${d.fileName} via the admin API (${pdf.where})`); return { downloaded: d }; }
          fs.rmSync(d.localPath, { force: true });
        } catch (e) { log(`[S3] ${pdf.key.split('/').pop()} listed but its download failed (${e.message})`); }
      }
      if (Date.now() + 2000 > deadline) break;
      if (attempt % 15 === 1) log(`[S3] "${key}": not in the archive yet — polling the admin API every 2s (${Math.round((deadline - Date.now()) / 1000)}s left)...`);
      await page.waitForTimeout(2000);
    }
    const waited = `${Math.round(maxWaitMs / 60000)} min`;
    return lastCount
      ? { error: `"${key}" matched ${lastCount} S3 object(s) under the archive or the processing folder, but NONE of them were a real PDF within ${waited}.` }
      : { error: `no S3 object matched Identifier "${key}" in the archive (cc/outbound-files/smartcomm/output/archive) or the processing folder (${PROCESSING_PREFIX}) within ${waited}.` };
  }
  let lastMatchCount = 0;
  for (let attempt = 1; ; attempt++) {
    // The .pdf first (the .json filing-metadata sibling is fetched separately afterwards) — one download
    // instead of two, and the pair is less likely to be filed away mid-fetch.
    const matches = (await searchSmartComm(page, key, { log, retries: 0 }))
      .sort((a, b) => Number(/\.pdf\b/i.test(b.text)) - Number(/\.pdf\b/i.test(a.text)));
    lastMatchCount = matches.length;
    for (const m of matches) {
      const [downloaded] = await downloadMatches(page, [m], outDir, { log });
      const buf = fs.readFileSync(downloaded.localPath);
      if (buf.slice(0, 5).toString('latin1') === '%PDF-') {
        return { downloaded };
      }
      log(`[S3] "${downloaded.fileName}" matched Identifier "${key}" but isn't a real PDF (starts with "${buf.slice(0, 60).toString('latin1').replace(/\s+/g, ' ')}") — likely ClaimCenter's own document-indexing metadata object, not the generated document. Discarding and checking the next match.`);
      fs.unlinkSync(downloaded.localPath);
    }
    if (Date.now() + pollMs > deadline) break;
    log(`[S3] "${key}": ${matches.length ? `${matches.length} match(es) but no real PDF yet` : 'not in the archive yet'} — re-checking in ${pollMs / 1000}s (attempt ${attempt}, ${Math.round((deadline - Date.now()) / 1000)}s left)...`);
    await page.waitForTimeout(pollMs);
  }
  const waited = `${Math.round(maxWaitMs / 60000)} min`;
  return lastMatchCount
    ? { error: `"${key}" matched ${lastMatchCount} S3 object(s) under ClaimCenter Outbound > smartcomm > output > archive, but NONE of them were a real PDF (all looked like ClaimCenter's own document-indexing metadata) within ${waited} — the actual generated document never finished landing.` }
    : { error: `no S3 object matched Identifier "${key}" under ClaimCenter Outbound > smartcomm > output > archive within ${waited}.` };
}

// The completed document's co-located ClaimCenter filing metadata — "<identifier>.json" in the SAME archive
// folder as the PDF: { Drawer, FileNumber (the claim #), Folder, DocType, Description (DIG number + name),
// DocumentDate }. It's small and, unlike the input review-case payload (only sometimes present), it's ALWAYS
// there alongside the PDF — so it's a reliable source for confirming the fetched document's claim # and
// template identity (see validationService's metadata checks). Returns { metadata } parsed, or { error }.
async function downloadArchiveMetadataJson(page, identifier, outDir, { log = console.log } = {}) {
  const fs = require('fs');
  const holder = await ensureApiAuth(page, { log }).catch(() => ({}));
  if (holder.authorization) {
    const want = `${String(identifier).toLowerCase()}.json`;
    const obj = (await listForKey(page, String(identifier), { log })).find((o) => String(o.key).split('/').pop().toLowerCase() === want);
    if (!obj) return { error: `no "${identifier}.json" filing-metadata object found in the archive or the processing folder for Identifier "${identifier}".` };
    if (obj.where !== 'archive') log(`[S3] filing metadata ${want} taken from the ${obj.where} folder`);
    const d = await apiDownload(page, obj.key, outDir, { log });
    try {
      return { metadata: JSON.parse(fs.readFileSync(d.localPath, 'utf8')), fileName: d.fileName, localPath: d.localPath };
    } catch (e) {
      return { error: `downloaded "${d.fileName}" but could not parse it as JSON: ${e.message}` };
    }
  }
  const matches = await searchSmartComm(page, identifier, { log });
  // Exactly "<identifier>.json" — NOT "<identifier>_Email.json" (the email sibling), NOT the ".pdf".
  const want = `${String(identifier).toLowerCase()}.json`;
  const hit = matches.find((m) => (String(m.text).trim().split(/\s+/)[0] || '').toLowerCase() === want);
  if (!hit) return { error: `no "${identifier}.json" filing-metadata object found in the archive for Identifier "${identifier}".` };
  const [dl] = await downloadMatches(page, [hit], outDir, { log });
  try {
    return { metadata: JSON.parse(fs.readFileSync(dl.localPath, 'utf8')), fileName: dl.fileName, localPath: dl.localPath };
  } catch (e) {
    return { error: `downloaded "${dl.fileName}" but could not parse it as JSON: ${e.message}` };
  }
}

// ── The admin UI's own data API ───────────────────────────────────────────────────────────────────────
// CONFIRMED live 2026-10-14 (recorded the UI's requests): listing a folder is GET <api>/api/s3/list?prefix=<key
// path, no planet> → [{ key, size, lastModified }] (keys come back WITH the planet, "test/cc/..."), and a
// download is GET <api>/api/s3/object?key=<full key>; the API host is per planet (".../donegal-dngl-test-
// igintegrationadmin..."), and every call carries the UI's own bearer token. Calling it directly lets the
// archive be polled every few hundred ms — needed because a finished document now survives there only a second
// or two before the filing job takes it (SmartCOMM job 1629 uploaded a pair at 00:05:45 that a UI-driven watch,
// reloading every ~3s, never saw). The token is read off the UI's own requests and kept in memory only — never
// logged or written anywhere.
const apiAuthByPage = new WeakMap();
function apiHolder(page) {
  if (!apiAuthByPage.has(page)) {
    const holder = { base: null, authorization: null };
    page.on('request', (req) => {
      const m = req.url().match(/^(https:\/\/[^/]+)\/api\/s3\//);
      const authorization = m && req.headers().authorization;
      if (authorization) { holder.base = m[1]; holder.authorization = authorization; }
    });
    apiAuthByPage.set(page, holder);
  }
  return apiAuthByPage.get(page);
}

// Makes the UI issue one API call (listing the always-present input folder) so its current token is captured.
async function ensureApiAuth(page, { log = console.log, force = false } = {}) {
  const holder = apiHolder(page);
  if (holder.authorization && !force) return holder;
  if (force) holder.authorization = null;
  const inputLabel = page.locator(`[data-testid="${INPUT_NODE.label}"]`).first();
  if (!(await inputLabel.isVisible().catch(() => false))) await tryOpenFolder(page, INPUT_NODE, { waitMs: 2000 });
  await inputLabel.click().catch(() => {});
  for (let i = 0; i < 40 && !holder.authorization; i++) await page.waitForTimeout(250);
  if (!holder.authorization) log('[S3] couldn\'t pick up the admin UI\'s API token — falling back to driving the UI.');
  return holder;
}

async function apiGet(page, pathAndQuery, { log } = {}) {
  let holder = await ensureApiAuth(page, { log });
  if (!holder.authorization) throw new Error('S3 API token unavailable');
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${holder.base}${pathAndQuery}`, { headers: { authorization: holder.authorization, accept: '*/*' } });
    if (res.status === 401 || res.status === 403) { holder = await ensureApiAuth(page, { log, force: true }); continue; }
    if (!res.ok) throw new Error(`S3 API ${res.status} for ${pathAndQuery.split('?')[0]}`);
    return res;
  }
  throw new Error('S3 API kept rejecting the token');
}

async function apiList(page, prefix, opts) {
  const res = await apiGet(page, `/api/s3/list?prefix=${encodeURIComponent(prefix)}`, opts);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.items || data.objects || []);
}

// Downloads one object to outDir (file named after the key's last segment). Handles the API answering with the
// bytes themselves or with a JSON pointer to a pre-signed URL.
async function apiDownload(page, key, outDir, opts) {
  const fs = require('fs');
  const path = require('path');
  const res = await apiGet(page, `/api/s3/object?key=${encodeURIComponent(key)}`, opts);
  let buf;
  if (/json/i.test(res.headers.get('content-type') || '')) {
    const data = await res.json();
    const url = data && (data.url || data.presignedUrl || data.downloadUrl);
    if (url) {
      const r2 = await fetch(url);
      if (!r2.ok) throw new Error(`S3 object download ${r2.status}`);
      buf = Buffer.from(await r2.arrayBuffer());
    } else {
      buf = Buffer.from(JSON.stringify(data));
    }
  } else {
    buf = Buffer.from(await res.arrayBuffer());
  }
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = key.split('/').pop();
  const localPath = path.join(outDir, fileName);
  fs.writeFileSync(localPath, buf);
  return { text: key, fileName, localPath };
}

const ARCHIVE_PREFIX = 'cc/outbound-files/smartcomm/output/archive';
// Fallback: where the filing job keeps each PDF + .json pair after collecting it from the archive. CONFIRMED live
// 2026-10-14 (user direction): unlike the archive (emptied within seconds), this folder held 48 documents going
// back hours, and its PDF is byte-identical to the one caught in the archive (DIG238, 2d359bb1-...). So a document
// the archive watch missed is still found here instead of waiting minutes for something that already left.
const PROCESSING_PREFIX = 'cc/inbound-files/pending/smartcomm/output/output/archive/processing';

const INPUT_PREFIX = 'cc/outbound-files/smartcomm/input';

// Every S3 object for a key, for the S3 download tool: the finished document (PDF + .json) from the archive, or
// the processing folder when the archive no longer has it, plus the request payload from input. Each entry gets
// a `where` label. Admin API only — returns null when its token couldn't be picked up (caller uses the UI search).
async function findAllForKey(page, key, { log = console.log } = {}) {
  const holder = await ensureApiAuth(page, { log }).catch(() => ({}));
  if (!holder.authorization) return null;
  const docs = await listForKey(page, key, { log });
  const archive = docs.filter((o) => o.where === 'archive');
  const chosen = archive.length ? archive : docs; // processing only when the archive has none
  const input = (await apiList(page, INPUT_PREFIX, { log }).catch(() => []))
    .filter((o) => String(o.key).includes(key)).map((o) => ({ ...o, where: 'input (payload)' }));
  return [...chosen, ...input];
}

// Objects whose key contains `key`, from the archive first, then the processing fallback.
async function listForKey(page, key, { log } = {}) {
  const [archive, processing] = await Promise.all([ARCHIVE_PREFIX, PROCESSING_PREFIX]
    .map((p) => apiList(page, p, { log }).catch(() => [])));
  const pick = (objs, where) => objs.filter((o) => String(o.key).includes(key)).map((o) => ({ ...o, where }));
  return [...pick(archive, 'archive'), ...pick(processing, 'processing (fallback)')];
}

// Watches output/archive while a document is being completed, and downloads its <identifier>.pdf/.json the
// moment they land. CONFIRMED live 2026-10-13 (watched every ~1s while one DIG108 document completed): the pair
// appeared at 20:07:25 and was GONE at 20:07:40 — a downstream filing job takes each PDF + .json pair ~15s
// after it lands (SmartCOMM's own job log shows the upload succeeding), so searching only AFTER Complete
// Document + reading Document Properties (often >15s later) intermittently found nothing at all. Started just
// BEFORE Complete Document is clicked: takes a baseline listing, then re-opens the folder (which re-fetches the
// listing — confirmed by the same experiment) every ~intervalMs and immediately downloads every NEW GUID-named
// .pdf/.json (the identifier isn't known yet, so it can't be filtered on), keeping only the one whose identifier
// `identifierPromise` later resolves to and deleting any other new document (someone else's) it picked up.
// Resolves to { pdf, json } (each { fileName, localPath } or null) — null when the identifier never arrives
// (null/rejected promise) — so the caller can fall back to the regular search for whatever wasn't caught.
async function watchArchiveForIdentifier(page, identifierPromise, outDir, { log = console.log, maxMs = 120000, afterIdMs = 45000, intervalMs = 700 } = {}) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(outDir, '.archive-watch');
  fs.mkdirSync(dir, { recursive: true });
  let identifier;
  let idSettled = false;
  let idKnownAt = 0;
  Promise.resolve(identifierPromise).then((id) => { identifier = id || null; }, () => { identifier = null; })
    .finally(() => { idSettled = true; idKnownAt = Date.now(); });

  await ensureTestPlanet(page, { log });
  const GUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(pdf|json)$/i;
  const wanted = () => (identifier ? [`${identifier}.pdf`, `${identifier}.json`] : []);
  const got = new Map(); // file name (lower case) -> { fileName, localPath }
  const finish = () => {
    const pick = (ext) => (identifier && got.get(`${identifier}.${ext}`.toLowerCase())) || null;
    const result = identifier ? { pdf: pick('pdf'), json: pick('json') } : null;
    // Anything else caught is another document that happened to complete meanwhile — not ours, drop it.
    for (const [, d] of got) {
      if (!result || ![result.pdf, result.json].includes(d)) fs.rmSync(d.localPath, { force: true });
    }
    if (result && result.pdf && fs.readFileSync(result.pdf.localPath).slice(0, 5).toString('latin1') !== '%PDF-') {
      log(`[S3] archive watch: ${result.pdf.fileName} isn't a real PDF — ignoring it.`);
      fs.rmSync(result.pdf.localPath, { force: true });
      result.pdf = null;
    }
    return result;
  };
  const shouldStop = () => (idSettled && !identifier)
    || (identifier && wanted().every((k) => got.has(k.toLowerCase())))
    || (idSettled && identifier && Date.now() - idKnownAt > afterIdMs);

  // Preferred: poll the admin UI's own list API every few hundred ms (see apiList) — a document can now be gone
  // within a second or two of landing.
  const holder = await ensureApiAuth(page, { log });
  if (holder.authorization) {
    const listNames = async () => (await apiList(page, ARCHIVE_PREFIX, { log })).map((o) => o.key);
    const baseline = new Set(await listNames().catch(() => []));
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline && !shouldStop()) {
      let keys;
      try { keys = await listNames(); } catch (e) { log(`[S3] archive watch: list failed (${e.message}) — retrying.`); await page.waitForTimeout(1000); continue; }
      for (const fullKey of keys) {
        const name = fullKey.split('/').pop();
        const m = name.match(GUID_FILE);
        if (!m || got.has(name.toLowerCase())) continue;
        const isOurs = identifier && m[1].toLowerCase() === identifier.toLowerCase();
        if (!isOurs && (identifier || baseline.has(fullKey))) continue;
        try {
          got.set(name.toLowerCase(), await apiDownload(page, fullKey, dir, { log }));
          log(`[S3] archive watch: caught ${name} as it landed`);
        } catch (e) {
          log(`[S3] archive watch: ${name} listed but its download failed (${e.message}) — likely filed away mid-download.`);
        }
      }
      await page.waitForTimeout(250);
    }
    return finish();
  }

  // Fallback: drive the UI (slower — only when the API token couldn't be picked up).
  const archiveLabel = page.locator(`[data-testid="${OUTPUT_NODE.label}"]`).first();
  const parentLabel = page.locator('[data-testid="label-cc/outbound-files/smartcomm/output"]').first();
  const rowLocator = page.locator('table tbody tr, [role="row"]');
  const filter = page.getByPlaceholder('Filter by key');
  const listKeys = async () => (await rowLocator.allInnerTexts().catch(() => []))
    .map((t) => t.trim().split(/\s+/)[0]).filter(Boolean);
  // The archive folder only exists while it holds files (see tryOpenFolder) — when it's absent, everything that
  // shows up later is new, so the baseline is empty and the loop keeps re-reading the tree until it appears.
  const openArchive = async (waitMs) => {
    if (!(await tryOpenFolder(page, OUTPUT_NODE, { waitMs }))) return false;
    await archiveLabel.click().catch(() => {});
    if (await filter.isVisible().catch(() => false)) await filter.fill('').catch(() => {});
    await page.waitForTimeout(500);
    return true;
  };
  let opened = await openArchive(1500);
  const baseline = new Set(opened ? await listKeys() : []);
  if (!opened) log('[S3] archive watch: output/archive is empty right now (not in the tree) — watching for it to appear.');
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline && !shouldStop()) {
    if (!opened) {
      await reloadTree(page); // see reloadTree — the only way a newly created archive folder shows up
      opened = await openArchive(800);
      if (!opened) { await page.waitForTimeout(intervalMs); continue; }
    }
    for (const key of await listKeys()) {
      const m = key.match(GUID_FILE);
      if (!m || got.has(key.toLowerCase())) continue;
      // Before the identifier is known, only grab what appeared since the baseline; once it IS known, also grab
      // its own pair even if it was already listed in the baseline (it can land before the watch got going).
      const isOurs = identifier && m[1].toLowerCase() === identifier.toLowerCase();
      if (!isOurs && (identifier || baseline.has(key))) continue;
      try {
        const [d] = await downloadMatches(page, [{ text: key, row: rowLocator.filter({ hasText: key }).first() }], dir, { log });
        got.set(key.toLowerCase(), d);
        log(`[S3] archive watch: caught ${key} as it landed`);
      } catch (e) {
        log(`[S3] archive watch: ${key} listed but its download failed (${e.message.split('\n')[0]}) — likely filed away mid-download.`);
      }
    }
    await parentLabel.click().catch(() => {});
    await page.waitForTimeout(150);
    // Emptied by the filing job since the last look → the folder is gone again; re-find it next pass.
    if (!(await archiveLabel.isVisible().catch(() => false))) { opened = false; continue; }
    await archiveLabel.click().catch(() => {});
    await page.waitForTimeout(intervalMs);
  }
  return finish();
}

module.exports = { S3_ADMIN_URL, LOGIN_EMAIL, loginAndEnsureTestPlanet, ensureTestPlanet, searchSmartComm, searchSmartCommPayload, downloadMatches, downloadFirstValidPdf, downloadArchiveMetadataJson, watchArchiveForIdentifier, findAllForKey, _api: { apiList, apiDownload, ensureApiAuth } };
