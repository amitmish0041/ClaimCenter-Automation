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

const S3_ADMIN_URL = 'https://intadmin-develop-donegal-dngldev-gwjutro.beta5-andromeda.guidewire.net/s3';
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
// ClaimCenter > Inbound Pending > smartcomm > output > output (generated PDFs — CONFIRMED live 2026-09-30
// this is TWO "output" levels deep, not one: the first "output" is itself a parent of two children, "logs"
// (895 items) and a second, identically-named "output" (104 items, the real PDFs) — its own item count
// exactly equals the parent's, 895+104=999, which is what made the shallower node look plausible at first)
// and Outbound > smartcomm > input (the original payload) — each entry is the full CHAIN of chevrons to
// expand every intermediate parent, plus the label of the final child to select.
const OUTPUT_NODE = { chevrons: ['chevron-cc/inbound-files/pending/smartcomm', 'chevron-cc/inbound-files/pending/smartcomm/output'], label: 'label-cc/inbound-files/pending/smartcomm/output/output' };
const INPUT_NODE = { chevrons: ['chevron-cc/outbound-files/smartcomm'], label: 'label-cc/outbound-files/smartcomm/input' };
const MAX_MATCHES = 10; // a too-broad key could otherwise bulk-download/email an unbounded number of files

async function currentPlanet(page) {
  const m = (await page.evaluate(() => document.body.innerText)).match(/Planet:\s*(\w+)/);
  return m ? m[1] : null;
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

  const landed = page.url().startsWith('https://intadmin-');

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

  // The "Planet: ..." badge can take a beat to paint right after the login redirect — poll briefly
  // rather than reading once, or a fine first run gets misreported as an unexplained "Planet is null".
  let planet = null;
  const planetDeadline = Date.now() + 8000;
  while (Date.now() < planetDeadline) {
    planet = await currentPlanet(page);
    if (planet) break;
    await page.waitForTimeout(400);
  }
  if (planet !== 'Test') {
    log(`[S3] Planet is "${planet}" — switching to Test`);
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
    const confirmed = await currentPlanet(page);
    if (confirmed !== 'Test') throw new Error(`S3_PLANET_SWITCH_FAILED: still shows "${confirmed}" after attempting to switch to Test.`);
  } else {
    log('[S3] Planet already Test');
  }
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

// Returns [{ text, row: Locator }] for every visible row matching `key` under the given tree node
// ({chevron, label} data-testids — see OUTPUT_NODE/INPUT_NODE above). Each chevron expands its own parent
// level, VERIFIED (see ensureExpanded above) rather than a blind click-and-hope, since the tree can silently
// re-collapse on its own after sitting idle; the label then selects the actual child folder to list/filter.
async function searchNode(page, node, key, { log = console.log, folderDescription = node.label } = {}) {
  for (let i = 0; i < node.chevrons.length; i++) {
    const revealTestId = i + 1 < node.chevrons.length ? node.chevrons[i + 1] : node.label;
    const ok = await ensureExpanded(page, node.chevrons[i], revealTestId, { log });
    if (!ok) log(`[S3] WARNING: never confirmed "${node.chevrons[i]}" expanded "${revealTestId}" after retries — continuing anyway, the label click below will surface a clear error if the tree genuinely isn't in the right state.`);
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
  for (let attempt = 0; count === 0 && attempt < 2; attempt++) {
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

// The generated PDF — ClaimCenter Inbound Pending > smartcomm > output > output.
async function searchSmartComm(page, key, { log = console.log } = {}) {
  return searchNode(page, OUTPUT_NODE, key, { log, folderDescription: 'ClaimCenter Inbound Pending > smartcomm > output > output' });
}

// The ORIGINAL payload ClaimCenter sent to SmartCOMM for this same transaction — ClaimCenter Outbound >
// smartcomm > input. Same Document Properties Identifier as the PDF resolves this too (CONFIRMED live
// 2026-09-30), making the Create tab's own "Download Payload" button (frequently unavailable in this Test
// environment) unnecessary — this is fetched in the SAME S3 visit as the PDF instead.
async function searchSmartCommPayload(page, key, { log = console.log } = {}) {
  return searchNode(page, INPUT_NODE, key, { log, folderDescription: 'ClaimCenter Outbound > smartcomm > input' });
}

// Downloads each match into outDir, returns [{ text, fileName, localPath }].
async function downloadMatches(page, matches, outDir, { log = console.log } = {}) {
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const m of matches) {
    const downloadBtn = m.row.getByRole('button', { name: 'Download' })
      .or(m.row.locator('[aria-label="Download"], [title="Download"]')).first();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      downloadBtn.click(),
    ]);
    const fileName = download.suggestedFilename();
    const localPath = path.join(outDir, fileName);
    await download.saveAs(localPath);
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
// genuine upload-delivery lag (the real document hasn't finished landing in S3) — re-searches and retries a
// few times before giving up with a clear, specific error distinguishing "found nothing at all" from "found
// only ClaimCenter's own metadata object, never the real document."
async function downloadFirstValidPdf(page, key, outDir, { log = console.log, maxSearchAttempts = 3 } = {}) {
  const fs = require('fs');
  for (let attempt = 1; attempt <= maxSearchAttempts; attempt++) {
    const matches = await searchSmartComm(page, key, { log });
    if (!matches.length) {
      if (attempt === maxSearchAttempts) {
        return { error: `no S3 object matched Identifier "${key}" under ClaimCenter Inbound Pending > smartcomm > output > output.` };
      }
      await page.waitForTimeout(3000);
      continue;
    }
    for (const m of matches) {
      const [downloaded] = await downloadMatches(page, [m], outDir, { log });
      const buf = fs.readFileSync(downloaded.localPath);
      if (buf.slice(0, 5).toString('latin1') === '%PDF-') {
        return { downloaded };
      }
      log(`[S3] "${downloaded.fileName}" matched Identifier "${key}" but isn't a real PDF (starts with "${buf.slice(0, 60).toString('latin1').replace(/\s+/g, ' ')}") — likely ClaimCenter's own document-indexing metadata object, not the generated document. Discarding and checking the next match.`);
      fs.unlinkSync(downloaded.localPath);
    }
    if (attempt === maxSearchAttempts) {
      return { error: `"${key}" matched ${matches.length} S3 object(s) under ClaimCenter Inbound Pending > smartcomm > output > output, but NONE of them were a real PDF (all looked like ClaimCenter's own document-indexing metadata) after ${maxSearchAttempts} attempt(s) — the actual generated document likely hasn't finished uploading to S3 yet.` };
    }
    log(`[S3] none of the ${matches.length} current match(es) for "${key}" were a real PDF yet — waiting in case the actual document is still uploading, then re-searching (attempt ${attempt}/${maxSearchAttempts})...`);
    await page.waitForTimeout(3000);
  }
}

module.exports = { S3_ADMIN_URL, LOGIN_EMAIL, loginAndEnsureTestPlanet, searchSmartComm, searchSmartCommPayload, downloadMatches, downloadFirstValidPdf };
