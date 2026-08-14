/**
 * helpers/claimCenterBase.js
 * Environment-aware orchestrator.
 * Detects on-prem vs cloud from CC_ENV env var and delegates to correct locators.
 *
 * Set in .env:
 *   CC_ENV=onprem   → uses OnPremLocators (ExtJS, ClaimCenter.do)
 *   CC_ENV=cloud    → uses CloudLocators  (React/Jutro, guidewire.com)
 *
 * All helpers (fnolHelper, financialsHelper etc.) call functions from this file
 * and never reference locators directly — so they work on both environments.
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { expect } = require('@playwright/test');

const OnPremLocators = require('./locators/onPremLocators');
const CloudLocators  = require('./locators/cloudLocators');

const ENV         = (process.env.CC_ENV || 'onprem').toLowerCase();
const IS_ON_PREM  = ENV === 'onprem';
const L           = IS_ON_PREM ? OnPremLocators : CloudLocators;

// ── Tier (test | dev) ────────────────────────────────────────────────────────
// CC_ENV picks the PLATFORM (onprem = ExtJS, cloud = gw-action markup);
// CC_TIER picks WHICH INSTANCE of that platform. The two are independent, so
// all four combinations exist:
//   onprem+test  http://test-claimcenter.donegalgroup.com/cc/ClaimCenter.do
//   onprem+dev   http://dev-claimcenter.donegalgroup.com:8080/cc/ClaimCenter.do
//   cloud +test  https://cc-test-dngldev.donegal.beta5-andromeda.guidewire.net/ClaimCenter.do
//   cloud +dev   https://cc-dev-dngldev.donegal.beta5-andromeda.guidewire.net/ClaimCenter.do
// Defaults to "test" so every existing script keeps its previous target.
const TIER = (process.env.CC_TIER || 'test').toLowerCase();

// Resolution order, most specific first:
//   1. CC_BASE_URL            explicit override, wins over everything
//   2. CC_BASE_URL_<PLAT>_<TIER>   e.g. CC_BASE_URL_ONPREM_DEV
//   3. CC_BASE_URL_<PLAT>          legacy, un-tiered (= the test instance)
//   4. built-in default
const PLAT = IS_ON_PREM ? 'ONPREM' : 'CLOUD';
const DEFAULT_URLS = {
  ONPREM_TEST: 'http://test-claimcenter.donegalgroup.com/cc/ClaimCenter.do',
  ONPREM_DEV : 'http://dev-claimcenter.donegalgroup.com:8080/cc/ClaimCenter.do',
  CLOUD_TEST : 'https://cc-test-dngldev.donegal.beta5-andromeda.guidewire.net/ClaimCenter.do',
  CLOUD_DEV  : 'https://cc-dev-dngldev.donegal.beta5-andromeda.guidewire.net/ClaimCenter.do',
};

const BASE_URL =
     process.env.CC_BASE_URL
  || process.env['CC_BASE_URL_' + PLAT + '_' + TIER.toUpperCase()]
  || process.env['CC_BASE_URL_' + PLAT]
  || DEFAULT_URLS[PLAT + '_' + TIER.toUpperCase()]
  || DEFAULT_URLS[PLAT + '_TEST'];

const MAX_POLL_MS = 60_000;
const POLL_INT    = 2_000;

console.log('CC Environment: ' + ENV.toUpperCase() + ' / ' + TIER.toUpperCase() + ' | URL: ' + BASE_URL);

// ── Policy rotation ───────────────────────────────────────────────────────────
// Round-robins through a comma-separated list of policy numbers in a
// POLICY_<KEY> env var (e.g. POLICY_BOP_PA=1002241835,1002241819,...), one
// per call, wrapping back to the start once the list is exhausted. The
// current position per env var is persisted to results/policy-rotation.json
// so consecutive `npx playwright test` invocations continue the rotation
// instead of restarting at index 0 every time. A single value (no comma)
// behaves exactly as before - always returns that same value.
const ROTATION_FILE = path.join(__dirname, '..', 'results', 'policy-rotation.json');

function readRotationState() {
  try { return JSON.parse(fs.readFileSync(ROTATION_FILE, 'utf8')); }
  catch { return {}; }
}

function writeRotationState(state) {
  try {
    fs.mkdirSync(path.dirname(ROTATION_FILE), { recursive: true });
    fs.writeFileSync(ROTATION_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('Could not persist policy-rotation.json:', e.message);
  }
}

// Fixed past dates go stale as real time moves on, causing "zero results" on
// policy search.  Use a date relative to today so tests keep working indefinitely.
// Override via TEST_LOSS_DATE env var (MM/DD/YYYY) when a specific date is needed.
//
// A policy is only in force for its own term, so the "yesterday" default is
// wrong for any policy whose term has already expired (dev instances are
// stocked with fixed, older policies). Pass the policy number as the second
// argument and the date can be pinned per policy via LOSSDATE_<policyNumber>,
// e.g. LOSSDATE_1001002540=05/28/2026. That beats TEST_LOSS_DATE because it is
// the more specific setting; TEST_LOSS_DATE still covers every other policy.
function getTestLossDate(daysAgo = 1, policyNumber) {
  if (policyNumber) {
    const perPolicy = process.env['LOSSDATE_' + String(policyNumber).replace(/[^A-Za-z0-9]/g, '_')];
    if (perPolicy) {
      // "TODAY" resolves at run time. A literal date would be correct only on
      // the day it was written and would silently drift out of the policy term
      // afterwards, which shows up as an unexplained empty policy search.
      if (/^today$/i.test(perPolicy.trim())) {
        const t = new Date();
        const today = String(t.getMonth() + 1).padStart(2, '0') + '/' +
                      String(t.getDate()).padStart(2, '0') + '/' + t.getFullYear();
        console.log('Loss date for policy ' + policyNumber + ': ' + today + ' (LOSSDATE_=TODAY)');
        return today;
      }
      console.log('Loss date for policy ' + policyNumber + ': ' + perPolicy + ' (from LOSSDATE_ env var)');
      return perPolicy;
    }
  }
  if (process.env.TEST_LOSS_DATE) return process.env.TEST_LOSS_DATE;
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return mm + '/' + dd + '/' + d.getFullYear();
}

// Loss state, pinned per policy. Same rationale as the loss date above: the
// specs hardcode 'PA', but the dev instance's policies are written in GA, MI
// and OH, and filing a loss in the wrong jurisdiction changes which coverages
// and validation rules CC applies. Falls back to the spec's own value.
function getLossState(policyNumber, fallback) {
  if (policyNumber) {
    const key = 'LOSSSTATE_' + String(policyNumber).replace(/[^A-Za-z0-9]/g, '_');
    if (process.env[key]) {
      console.log('Loss state for policy ' + policyNumber + ': ' + process.env[key] + ' (from LOSSSTATE_ env var)');
      return process.env[key];
    }
  }
  return fallback;
}

// Tier-aware: a dev instance holds a different policy population than test, so
// POLICY_HO_PA_DEV (when CC_TIER=dev) takes precedence over POLICY_HO_PA. The
// rotation cursor is keyed by the var actually used, so the two tiers rotate
// independently.
function getNextPolicy(envVarName, fallback) {
  const tieredName = envVarName + '_' + TIER.toUpperCase();
  if (process.env[tieredName]) envVarName = tieredName;

  const raw = process.env[envVarName] || fallback;
  if (!raw) throw new Error('No policy configured for ' + envVarName);
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (list.length <= 1) return list[0] || raw;

  const state = readRotationState();
  const idx = state[envVarName] || 0;
  const policy = list[idx % list.length];
  state[envVarName] = (idx + 1) % list.length;
  writeRotationState(state);
  console.log('Policy rotation [' + envVarName + ']: using ' + policy + ' (index ' + idx + '/' + list.length + ')');
  return policy;
}

// ── Used claimant numbers per policy ─────────────────────────────────────────
// A claimant number picked for one exposure genuinely can't be reused for
// ANOTHER exposure on the same policy ("already exists on another claim") -
// confirmed via live validation error. addExposureByCoverage's own
// page._usedClaimantNumbers only lives in memory for the current test run,
// so separate test invocations against the SAME policy could still collide.
// Persist to disk instead, keyed by policy number, same pattern as policy
// rotation above.
const CLAIMANT_NUMBERS_FILE = path.join(__dirname, '..', 'results', 'used-claimant-numbers.json');

function readUsedClaimantNumbers() {
  try { return JSON.parse(fs.readFileSync(CLAIMANT_NUMBERS_FILE, 'utf8')); }
  catch (e) { console.warn('[DEBUG] readUsedClaimantNumbers failed:', e.message); return {}; }
}

function writeUsedClaimantNumbers(state) {
  try {
    fs.mkdirSync(path.dirname(CLAIMANT_NUMBERS_FILE), { recursive: true });
    fs.writeFileSync(CLAIMANT_NUMBERS_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('Could not persist used-claimant-numbers.json:', e.message);
  }
}

// Returns a Set of claimant numbers already used for this policy (across all
// prior test runs, not just the current one).
function getUsedClaimantNumbers(policyNumber) {
  const state = readUsedClaimantNumbers();
  const list = state[policyNumber] || [];
  console.log('[DEBUG] getUsedClaimantNumbers(' + policyNumber + '): JSON has ' + Object.keys(state).length + ' policies, this policy has ' + list.length + ' entries');
  return new Set(list);
}

function addUsedClaimantNumber(policyNumber, claimantNumber) {
  if (!policyNumber || !claimantNumber) return;
  const state = readUsedClaimantNumbers();
  const list = state[policyNumber] || [];
  if (!list.includes(claimantNumber)) {
    list.push(claimantNumber);
    state[policyNumber] = list;
    writeUsedClaimantNumbers(state);
  }
}

// ── Mask helper ───────────────────────────────────────────────────────────────
// Waits until EVERY .x-mask on the page is hidden/zero-size.
// waitForSelector('.x-mask', { state: 'hidden' }) only ever watches the FIRST
// match, so a second mask raised by an async server response sails straight
// past it and then intercepts the next click - confirmed via live failure on
// the Vehicle Type combo, whose call log showed "<div class="x-mask"...>
// intercepts pointer events" followed by "element was detached from the DOM".
// Same all-masks check openExistingClaim already open-codes.
async function waitForAllMasksGone(page, timeout = 15000) {
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('.x-mask'))
           .every(m => getComputedStyle(m).display === 'none' ||
                       getComputedStyle(m).visibility === 'hidden' ||
                       m.getBoundingClientRect().width === 0),
    { timeout }
  ).catch(() => {});
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function loginToClaimCenter(page, { username, password } = {}) {
  // Optional override - per user direction, some actions (e.g. deleting a
  // reserve, which the standard automation user lacks permission for) need
  // a specific admin login ("su") instead of the default CC_USER/CC_PASS.
  const user = (username || process.env.CC_USER || '').trim();
  const pass = (password || process.env.CC_PASS || '').trim();
  if (!user || !pass) throw new Error('Set CC_USER and CC_PASS in .env');

  // Smart-skip: if no specific username was requested (i.e. the default user)
  // and we are already inside the app (the Search nav link is visible), reuse
  // the existing session instead of navigating away and re-authenticating.
  // Check for the Search nav link specifically — it is always present on any
  // post-login page but absent on the login form and on about:blank.
  // When an explicit username is passed (e.g. admin "su"), always do the full
  // login so the correct account is active.
  if (IS_ON_PREM && !username) {
    const inApp = await page.locator('a').filter({ hasText: /^Search$/ })
      .first().waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false);
    if (inApp) {
      console.log('CC Login: already in ClaimCenter, skipping re-login');
      return;
    }
  }

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  if (IS_ON_PREM) {
    // Confirmed via live codegen recording against the on-prem env: despite
    // being ExtJS, the login fields ARE addressable by accessible role/name
    // (same pattern as cloud) - the previously guessed name= selectors were
    // never actually verified.
    const usernameField = page.getByRole('textbox', { name: 'User name' });
    const passwordField = page.getByRole('textbox', { name: 'Password' });

    await usernameField.waitFor({ state: 'visible', timeout: 30_000 });
    await usernameField.fill(user);
    await passwordField.fill(pass);
    await passwordField.press('Enter');
    await usernameField.waitFor({ state: 'hidden', timeout: 30_000 });
  } else {
    // Cloud (Jutro/React): login fields have no stable id/name/type attributes -
    // only exposed via accessible role + name, confirmed via Playwright's own
    // page snapshot (textbox "Username", textbox "Password", button "Log In").
    const usernameField = page.getByRole('textbox', { name: 'Username' });
    const passwordField = page.getByRole('textbox', { name: 'Password' });

    await usernameField.waitFor({ state: 'visible', timeout: 30_000 });
    await usernameField.fill(user);
    await passwordField.fill(pass);
    await page.getByRole('button', { name: 'Log In' }).click();
    // desktop.ready ([id*="TabBar"]) matched 54 elements including a hidden
    // placeholder, so waitForSelector never resolved. The "Search" nav menu
    // item is part of the persistent top nav and confirmed present in the
    // actual post-login snapshot.
    await page.getByRole('menuitem', { name: 'Search' }).waitFor({ state: 'visible', timeout: 30_000 });
  }

  console.log('CC Login successful [' + ENV + '] | URL: ' + page.url());
}

// ── Admin (su) re-login ───────────────────────────────────────────────────────
// Per user direction: activities, closing exposures and closing claims must run
// as the admin account (su), not the standard automation user. The standard
// user only has rights over work assigned to them - once a claim is assigned to
// another adjuster its workplan rows expose no Complete button at all
// (confirmed via live run: completeAllWorkplanActivities looped on
// "no Complete button for ..." until the test timed out).
//
// Cookies are cleared first: loginToClaimCenter navigates to BASE_URL, which
// with a live benjsmit session lands straight back inside the app instead of on
// the login form, so the switch would silently never happen. Same clearCookies
// -> login sequence pollForClaimNumber already uses for its admin fallback.
async function loginAsAdmin(page) {
  const adminUser = process.env.CC_ADMIN_USER;
  const adminPass = process.env.CC_ADMIN_PASS;
  if (!adminUser || !adminPass) {
    throw new Error('Set CC_ADMIN_USER and CC_ADMIN_PASS in .env - admin login is required ' +
                    'for activities / closing exposures / closing claims');
  }
  await page.context().clearCookies();
  await loginToClaimCenter(page, { username: adminUser, password: adminPass });
  console.log('Switched to admin login:', adminUser);
}

// ── Open an existing claim by claim number (on-prem) ──────────────────────────
// Confirmed via a real user-recorded codegen script: search is a plain <a>
// link ("Search"), not a role=menuitem nav item; the Claim # field's submit
// button is itself a LINK named "Search" (not a role=button); the result row
// is opened by clicking its claim-number text/link. Lets tests jump straight
// into further workflow (add exposure, reassign, add reserve, ...) on an
// already-created claim instead of running full FNOL every time - saves both
// time and avoids spending down real policy/claimant test data.
async function openExistingClaim(page, claimNumber) {
  // Clear any masks left by the previous test's server-side operations
  // (void payment, wizard cancel, close exposure, etc.).  waitForSelector with
  // a short timeout is used everywhere in the suite and only watches ONE mask;
  // masks added by async server responses can outlast those waits.  Checking
  // ALL masks here at the entry point of each test's first navigation action
  // prevents the "mask intercepts pointer events" error on the Search tab click.
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('.x-mask'))
           .every(m => getComputedStyle(m).display === 'none' ||
                       getComputedStyle(m).visibility === 'hidden' ||
                       m.getBoundingClientRect().width === 0),
    { timeout: 90000 }
  ).catch(() => {});

  // "Claim: X" appears in some page headers; "Claim (X)" appears in the top
  // nav tab when we're in the claim workspace (e.g. after a wizard cancel).
  // Check both so we skip Search when already on the right claim in any sub-view.
  const alreadyThere =
    await page.locator('text="Claim: ' + claimNumber + '"').first()
      .waitFor({ state: 'visible', timeout: 1000 }).then(() => true).catch(() => false) ||
    await page.locator('text="Claim (' + claimNumber + ')"').first()
      .waitFor({ state: 'visible', timeout: 1000 }).then(() => true).catch(() => false);
  if (alreadyThere) {
    console.log('openExistingClaim: already on ' + claimNumber + ', skipping search');
    return;
  }

  // Hard-navigate to the CC root before clicking Search.  After operations like
  // void payment, CC background compliance/rule jobs keep ext-element-480 masked
  // for 90-120s on the current page even after the initial response.  A goto()
  // tears down the page's JavaScript context and pending XHR/WS ops, so the
  // Search tab click always starts from a clean, unmasked CC landing page.
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // If goto triggered a redirect to the login page (session expired after a
  // long payment-void background job), re-authenticate before proceeding.
  // "Still signed in?" must be checked in a platform-neutral way. This looked
  // only for an <a> reading "Search", which is on-prem markup - on cloud the
  // same nav entry is a role=menuitem, so the check ALWAYS failed, concluded
  // the session had expired, and called loginToClaimCenter on a page with no
  // login form. That produced a 30s wait for a Username textbox and took out
  // both the payment step and claim reuse. Accept any of the signals that mean
  // "an authenticated ClaimCenter page is on screen", and only treat a visible
  // login form as genuinely signed out.
  const stillSignedIn = await Promise.any([
    page.locator('a').filter({ hasText: /^Search$/ }).first()
      .waitFor({ state: 'visible', timeout: 6000 }).then(() => true),
    page.getByRole('menuitem', { name: /^Search$/ }).first()
      .waitFor({ state: 'visible', timeout: 6000 }).then(() => true),
    page.getByRole('link', { name: /^Search$/ }).first()
      .waitFor({ state: 'visible', timeout: 6000 }).then(() => true),
  ]).catch(() => false);

  const loginFormShowing = await page.getByRole('textbox', { name: /Username/i }).first()
    .isVisible().catch(() => false);

  if (!stillSignedIn && loginFormShowing) {
    console.log('openExistingClaim: session expired after goto — re-authenticating');
    await loginToClaimCenter(page);
  } else if (!stillSignedIn) {
    console.log('openExistingClaim: no Search nav found but no login form either — continuing without re-auth');
  }
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('.x-mask'))
           .every(m => getComputedStyle(m).display === 'none' ||
                       getComputedStyle(m).visibility === 'hidden' ||
                       m.getBoundingClientRect().width === 0),
    { timeout: 30000 }
  ).catch(() => {});
  // Same platform split as the session check above: on-prem renders the Search
  // nav as an <a>, cloud as a role=menuitem. Clicking the on-prem-only locator
  // burned the full action timeout on cloud. Try each shape and use whichever
  // this platform actually provides.
  // Cloud markup (confirmed):
  //   <div class="gw-label" aria-label="Search">Searc<div class="gw-shortcutKey">h</div></div>
  // It carries NO role, so getByRole(menuitem|link|button) can never match it,
  // and its visible text is SPLIT by the shortcut-key span ("Searc" + "h") so
  // text matching is unreliable too. The aria-label is the stable handle -
  // check it first, then fall back to the on-prem anchor.
  const searchNav = [
    page.locator('[aria-label="Search"]').first(),
    page.locator('a').filter({ hasText: 'Search' }).first(),
    page.getByRole('menuitem', { name: /^Search$/ }).first(),
    page.getByRole('link', { name: /^Search$/ }).first(),
    page.getByRole('button', { name: /^Search$/ }).first(),
  ];
  let searchClicked = false;
  for (const nav of searchNav) {
    if (!await nav.isVisible().catch(() => false)) continue;
    await nav.click({ timeout: 8000 }).catch(() => {});
    searchClicked = true;
    break;
  }
  if (!searchClicked) {
    throw new Error('openExistingClaim: no Search navigation found (tried <a>, menuitem, link and ' +
                    'button named "Search") — cannot reach the claim search screen');
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const claimField = page.getByRole('textbox', { name: 'Claim #' });
  await claimField.waitFor({ state: 'visible', timeout: 45000 });
  await claimField.fill(claimNumber);
  // The SUBMIT button on the claim-search screen. On-prem it is a link; on
  // cloud it is a div/button like the nav entry. Note there are now TWO things
  // named "Search" on this screen - the top nav and this submit control - and
  // the nav comes first in the DOM, so an aria-label lookup must take the LAST
  // match, not the first, or it just re-clicks the nav and never searches.
  const searchSubmit = [
    page.getByRole('button', { name: /^Search$/ }).last(),
    page.getByRole('link', { name: 'Search', exact: true }).last(),
    page.locator('[aria-label="Search"]').last(),
  ];
  let submitted = false;
  for (const btn of searchSubmit) {
    if (!await btn.isVisible().catch(() => false)) continue;
    await btn.click({ timeout: 8000 }).catch(() => {});
    submitted = true;
    break;
  }
  if (!submitted) {
    throw new Error('openExistingClaim: claim-number entered but no Search submit control found ' +
                    '(tried button, link and [aria-label="Search"])');
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  // The Search Results grid's "Claim" column truncates the full claim number
  // to just "PA-MD-01-..." (confirmed via live screenshot - only 3 hyphen
  // segments are visible before the ellipsis, NOT 4; a 4-segment prefix
  // including "26" doesn't actually appear in the truncated text at all, so
  // that match timed out too). Use only the first 3 segments (LOB-state-
  // branch), which is always shorter than where the grid truncates.
  // Confirmed via live DOM dump: this is a real <a> but tabindex="-1" with no
  // href, so it has no accessible "link" role at all - explains why
  // getByRole('link') never matched regardless of name/prefix length. Use
  // its real, stable id instead - "...ClaimSearchResultsLV:0:ClaimNumber" is
  // positional (row 0), which is reliably correct since searching by an
  // exact claim number returns exactly one result row.
  // First search result. Same colon-vs-dash split as everywhere else, plus a
  // "_button" suffix on cloud (confirmed):
  //   on-prem: ClaimSearch:ClaimSearchScreen:ClaimSearchResultsLV:0:ClaimNumber
  //   cloud  : ClaimSearch-ClaimSearchScreen-ClaimSearchResultsLV-0-ClaimNumber_button
  //            <div role="button" class="gw-ActionValueWidget" ...>CA-OH-...</div>
  // Falls back to matching the claim number's own text, which is what the cell
  // renders either way.
  const resultRow = [
    page.locator('[id="ClaimSearch:ClaimSearchScreen:ClaimSearchResultsLV:0:ClaimNumber"]').first(),
    page.locator('[id="ClaimSearch-ClaimSearchScreen-ClaimSearchResultsLV-0-ClaimNumber_button"]').first(),
    page.locator('[id^="ClaimSearch-ClaimSearchScreen-ClaimSearchResultsLV-"][id$="-ClaimNumber_button"]').first(),
    page.getByRole('button', { name: claimNumber, exact: true }).first(),
    page.getByText(claimNumber, { exact: true }).first(),
  ];
  // WAIT for the results grid to render before probing. The loop below uses
  // isVisible(), which is an INSTANT check - so when the grid painted a moment
  // after the search returned, all candidates reported false at once and this
  // threw "no result row could be clicked" even though the row was about to
  // appear (and did: the search had found the claim). Give it one real wait on
  // whichever id shape this platform uses, then probe.
  await page.locator(
    '[id="ClaimSearch:ClaimSearchScreen:ClaimSearchResultsLV:0:ClaimNumber"],' +
    '[id^="ClaimSearch-ClaimSearchScreen-ClaimSearchResultsLV-"][id$="-ClaimNumber_button"]'
  ).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

  // VERIFY the click actually opened the claim. The previous version swallowed
  // the click error and then set opened=true unconditionally, so a click that
  // failed - or landed on a non-interactive cell - still reported
  // "Opened existing claim". Confirmed via screenshot: the run sat on the
  // Search Claims results page with the claim number visible as an unclicked
  // link while the log claimed success.
  const leftSearchPage = async () => page.evaluate(() =>
    !/Search Claims/i.test(document.body.innerText || '')
  ).catch(() => false);

  let opened = false;
  for (const row of resultRow) {
    if (!await row.isVisible().catch(() => false)) continue;
    await row.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2000);
    if (await leftSearchPage()) { opened = true; break; }
    console.log('openExistingClaim: a result-row candidate was clicked but the search page is ' +
                'still showing — trying the next locator');
  }
  if (!opened) {
    // Last resort: the claim number itself renders as a link in the results grid.
    const asLink = page.getByRole('link', { name: claimNumber, exact: true }).first();
    if (await asLink.isVisible().catch(() => false)) {
      await asLink.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(2000);
      opened = await leftSearchPage();
      if (opened) console.log('openExistingClaim: opened via the claim-number link in the results grid');
    }
  }
  if (!opened) {
    throw new Error('openExistingClaim: search ran but no result row for "' + claimNumber +
                    '" could be clicked (tried on-prem id, cloud id, and the claim number text)');
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  console.log('Opened existing claim:', claimNumber);
}

// ── Navigation ────────────────────────────────────────────────────────────────
async function navigateTo(page, section) {
  const sel = L.nav[section];
  if (!sel) throw new Error('Unknown nav section: ' + section);
  await page.locator(sel).first().click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

// ── Cloud top-nav tab dropdowns (Claim, Search, Address Book, etc.) ───────────
// Every top-nav tab in the cloud UI shares one structure: #TabBar-<tabId> wraps
// a [role="menuitem"] LABEL (data-gw-click="fireEvent id:^" - clicking it just
// SELECTS/switches to that tab, e.g. clicking the Claim label jumps straight to
// whatever claim is already open) plus a separate .gw-action--expand-button
// sibling (data-gw-click="toggleSubMenu", aria-hidden="true" - a decorative
// arrow icon) that actually opens the dropdown/submenu. This was discovered the
// hard way via a live DOM dump while debugging FNOL's "New Claim" navigation -
// see helpers/fnolHelper.js history. Centralizing it here so every other module
// (Financials, Search, Address Book, ...) doesn't have to rediscover it.

// Opens the dropdown submenu for a given top-nav tab (e.g. tabId 'ClaimTab' for
// #TabBar-ClaimTab). Returns true if the submenu is confirmed open.
async function openTabMenu(page, tabId) {
  const expandBtn = page.locator(`#TabBar-${tabId} .gw-action--expand-button`).first();
  await expandBtn.waitFor({ state: 'attached', timeout: 10000 });
  await expandBtn.click({ force: true });

  let opened = await page.waitForFunction((id) => {
    const sub = document.querySelector(`#TabBar-${id} .gw-subMenu`);
    return sub && sub.getAttribute('aria-hidden') === 'false';
  }, tabId, { timeout: 5000 }).then(() => true).catch(() => false);

  if (!opened) {
    await expandBtn.click({ force: true });
    opened = await page.waitForFunction((id) => {
      const sub = document.querySelector(`#TabBar-${id} .gw-subMenu`);
      return sub && sub.getAttribute('aria-hidden') === 'false';
    }, tabId, { timeout: 5000 }).then(() => true).catch(() => false);
  }
  return opened;
}

// Clicks a specific item inside an already-open (or about-to-open) tab dropdown
// by its full element id, e.g. itemId 'ClaimTab-ClaimTab_FNOLWizard' for
// #TabBar-ClaimTab-ClaimTab_FNOLWizard. Opens the menu first if not already open.
async function clickTabMenuItem(page, tabId, itemId) {
  await openTabMenu(page, tabId);
  const item = page.locator(`#TabBar-${itemId} [role="menuitem"]`).first();
  await item.waitFor({ state: 'attached', timeout: 5000 });
  await item.click({ force: true });
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
}

// Clicks a top-nav tab's own LABEL to switch to it directly (e.g. reopen the
// currently-active Claim tab) - distinct from openTabMenu, which opens its
// dropdown instead.
async function selectTab(page, tabId) {
  const label = page.locator(`#TabBar-${tabId} [role="menuitem"]`).first();
  await label.waitFor({ state: 'attached', timeout: 10000 });
  await label.click({ force: true });
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
}

// ── On-prem combobox by accessible label (role-based) ─────────────────────────
// Confirmed via live codegen recording against the on-prem env: despite being
// ExtJS, comboboxes ARE addressable by role="combobox" + accessible label name
// (click to open, click the matching role="option"). This is a DIFFERENT param
// shape from selectDropdown() above (label text vs. field-name substring used
// to build a CSS guess) - kept separate rather than merged in, since
// selectDropdown() is still used by other not-yet-reverified on-prem call
// sites and blindly repointing it could break them silently.
// If value is omitted, picks whatever option is listed first (no safe way to
// guess a "correct" business value for claim-specific fields like Claimant).
// NOTE: some ExtJS combos list a blank "<none>" placeholder as their first
// option (confirmed on the FNOL Basic Info screen) while others don't (e.g.
// Assign Claim's assignee list) - skip any placeholder-looking option rather
// than blindly taking index 0.
// Some screens vary which fields are even present depending on data (e.g. New
// Exposure's field set differs per coverage type - confirmed via live
// screenshot that "Coverage Denied?" simply doesn't exist for some coverages,
// which previously caused a 30s hang here). Existence is checked with a short
// explicit timeout first so a missing field is skipped, not hung on; returns
// false when skipped so callers can log/handle it.
// A mask left up by a PRECEDING field's action can silently swallow the
// click that's supposed to open this combo's dropdown - confirmed via live
// testing (Claimant kept resolving to zero options and staying "<none>" with
// no error, because the click before it never actually opened anything).
// Waiting for the mask before AND after fixes it for every caller at once.
async function selectComboboxOnPrem(page, label, value, { exact = false, random = false, existTimeout = 8000, excludeValues = null, avoidNew = false, skip = 0 } = {}) {
  // BUG FIX: exact was only ever applied to the getByRole('option', ...)
  // lookup below, never to this combobox lookup itself - confirmed via live
  // isolated test that calling this with label='Claimant', exact:true still
  // built a non-exact getByRole('combobox', {name:'Claimant'}), which matches
  // 3 different fields ("Claimant Number", "Claimant", "Is Claimant
  // Employed?"). The resulting strict-mode violation was silently swallowed
  // by the .catch(() => false) below, always returning "field not found"
  // even though it plainly existed and was clickable.
  const combo = page.getByRole('combobox', { name: label, exact });
  // Confirmed via live isolated test: a real, present field ("Claimant" on
  // New Exposure) still failed this existence check at 3000ms - it just
  // needed more time to stabilize after the coverage-selection round-trip
  // (a plain manual click on the same locator, done slightly later in a
  // script, worked immediately). 3s is too tight under real load; 8s matched
  // real behavior in that same test. Default kept at 8s for backward
  // compatibility, but callers making SPECULATIVE calls for fields known to
  // often not exist at all on a given screen (e.g. addExposureByCoverage's
  // per-coverage-varying fields) should pass a much shorter existTimeout -
  // a field that's genuinely absent will never appear no matter how long you
  // wait, so waiting the full 8s per absent field was pure wasted time
  // (confirmed via user report: exposure field-filling was taking too long -
  // up to 7 of these speculative calls per exposure, each burning 8s when
  // the field wasn't on that particular coverage's screen).
  const exists = await combo.waitFor({ state: 'visible', timeout: existTimeout })
    .then(() => true).catch(() => false);
  if (!exists) return false;

  // Per user request: capture what's actually on screen the moment this field
  // is confirmed present, for "Claimant Number" specifically - a diagnostic
  // dump showed it later vanishing to 0 DOM matches entirely (not masked, not
  // covered - genuinely removed) during the click retry loop below, and the
  // user wants to see the real screen rather than another guess at why.
  if (label === 'Claimant Number') {
    // Resolve THIS element directly via combo.evaluate, not document.activeElement
    // (which is not necessarily this field before it has been clicked).
    const before = await combo.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const nearby = [...document.querySelectorAll('input, select, [role="combobox"], label, .x-form-item-label')]
        .filter(o => o.offsetParent && o !== el)
        .map(o => { const or = o.getBoundingClientRect();
          return { el: o, d: Math.hypot(or.x - r.x, or.y - r.y) }; })
        .filter(x => x.d < 300)
        .sort((a, b) => a.d - b.d)
        .slice(0, 10)
        .map(x => ({
          tag: x.el.tagName,
          label: x.el.getAttribute('aria-label') || (x.el.textContent || '').trim().slice(0, 40),
          value: 'value' in x.el ? String(x.el.value).slice(0, 30) : '',
        }));
      return {
        url: location.href.slice(-80),
        thisField: { id: el.id, cls: (el.className || '').toString().slice(0, 100), value: el.value },
        nearbyFields: nearby,
      };
    }).catch(e => ({ error: String(e).slice(0, 150) }));
    console.log('selectComboboxOnPrem: "Claimant Number" confirmed present — ' + JSON.stringify(before));
    await page.screenshot({ path: 'results/claimant-number-before-click.png' }).catch(() => {});
  }

  // ExtJS re-renders this input while masks clear, so a single click can land
  // on a detached node or on a mask that reappeared after the wait. Retry with
  // a short per-attempt timeout instead of burning the whole 30s action
  // timeout on one doomed attempt.
  // Escalate through progressively more forceful strategies rather than
  // repeating one that has already failed. Three identical polite clicks kept
  // losing the same race and failed the whole FNOL ("could not click combobox
  // \"Claimant Number\" after 3 attempts") - a mask can reappear INSIDE the 8s
  // click window, so waiting longer beforehand does not help.
  //   1-2. polite click after waiting for masks (the common case)
  //   3.   force:true - skips actionability/interception checks, the same
  //        escape hatch already used for the inline grid-cell editors here
  //   4.   dispatch a real click event from inside the page, which no overlay
  //        can intercept
  let comboClicked = false;
  for (let attempt = 0; attempt < 4 && !comboClicked; attempt++) {
    await waitForAllMasksGone(page);
    // Re-verify existence before EACH attempt, not just once up front.
    // Confirmed via live diagnostic on "Claimant Number": the element can go
    // from a passing existence check to 0 DOM matches entirely (not masked,
    // not covered - genuinely removed) within the span of this loop. This
    // field lives inside a nested ExtJS DataView (NewClaimVehicleDamageDV)
    // that CC can tear down and rebuild WITHOUT ever showing an .x-mask
    // overlay, so waitForAllMasksGone sees nothing wrong while the panel is
    // mid-rebuild - a plain "click harder" strategy (force, in-page dispatch)
    // cannot help against an element that is not there. Wait for it to
    // reappear instead of immediately escalating against a ghost.
    const stillThere = await combo.waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true).catch(() => false);
    if (!stillThere) {
      console.log('selectComboboxOnPrem: "' + label + '" vanished mid-retry (attempt ' +
                  (attempt + 1) + ') — waiting for it to reappear rather than clicking a ghost');
      continue;
    }
    if (attempt < 2) {
      comboClicked = await combo.click({ timeout: 8000 }).then(() => true).catch(() => false);
    } else if (attempt === 2) {
      comboClicked = await combo.click({ timeout: 8000, force: true }).then(() => true).catch(() => false);
      if (comboClicked) console.log('selectComboboxOnPrem: "' + label + '" needed a force click');
    } else {
      comboClicked = await combo.evaluate(el => {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }).then(() => true).catch(() => false);
      if (comboClicked) console.log('selectComboboxOnPrem: "' + label + '" needed an in-page dispatched click');
    }
  }
  // Last resort, one attempt: some combos are "picker" fields whose real
  // trigger is a SEPARATE sibling element (id + "-trigger-picker"), documented
  // a few lines below for exactly this reason - clicking the input itself can
  // be entirely inert on those, which would explain why even an in-page
  // dispatched click landed on the input and still did nothing.
  if (!comboClicked) {
    comboClicked = await combo.evaluate(el => {
      const trigger = el.parentElement && el.parentElement.querySelector('[id$="-trigger-picker"]');
      if (!trigger) return false;
      trigger.scrollIntoView({ block: 'center' });
      trigger.click();
      return true;
    }).then(v => !!v).catch(() => false);
    if (comboClicked) console.log('selectComboboxOnPrem: "' + label + '" needed its sibling trigger-picker element');
  }
  if (!comboClicked) {
    // Every escalation strategy has failed identically TWICE now on this same
    // field ("Claimant Number") across separate runs, including the in-page
    // dispatched click that no overlay should be able to intercept - that
    // stops looking like a one-off mask race and starts looking like this
    // specific combobox is not a normal clickable element at all (confirmed
    // elsewhere in this function: some combos are "picker" fields whose real
    // trigger is a SEPARATE sibling element, not the input itself). Dump
    // ground truth about what this locator actually resolved to instead of
    // escalating to a 5th click strategy on another guess.
    const diag = await combo.evaluate(el => ({
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 120),
      disabled: !!el.disabled,
      readOnly: !!el.readOnly,
      visible: !!el.offsetParent,
      rect: (() => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; })(),
      siblingTrigger: !!(el.parentElement && el.parentElement.querySelector('[id$="-trigger-picker"]')),
    })).catch(e => ({ evaluateError: String(e).slice(0, 200) }));
    const matchCount = await page.getByRole('combobox', { name: label, exact }).count().catch(() => -1);
    console.log('selectComboboxOnPrem: click-failure diagnostics for "' + label + '" — matches=' +
                matchCount + ' element=' + JSON.stringify(diag));
    await page.screenshot({ path: 'results/combobox-click-failed-' + label.replace(/\W+/g, '_') + '.png' })
      .catch(() => {});
    throw new Error('selectComboboxOnPrem: could not click combobox "' + label +
                    '" after 4 attempts (polite, force and in-page dispatch all failed). ' +
                    'Diagnostics: matches=' + matchCount + ' ' + JSON.stringify(diag));
  }

  // Some combos (confirmed via live DOM dump: "Claimant" on New Exposure) are
  // "picker" fields with a SEPARATE trigger arrow element
  // (id + "-trigger-picker", a sibling of the <input>, not the input itself)
  // that actually opens the dropdown - clicking the input alone focuses it
  // but never opens the list, so selectFirstRealOption always found zero
  // options and the field silently stayed "<none>". Fall back to clicking
  // that trigger if no option list appeared from the plain input click.
  let optionsOpen = await page.getByRole('option').first().waitFor({ state: 'visible', timeout: 1500 })
    .then(() => true).catch(() => false);
  if (!optionsOpen) {
    const comboId = await combo.getAttribute('id').catch(() => null);
    if (comboId) {
      // Confirmed via live DOM dump: the trigger icon's id doesn't always
      // follow the "<id>-trigger-picker" convention - a Vehicle/Claimant
      // lookup field on a vehicle-damage-type New Exposure screen instead
      // used "<id-without-inputEl>:<FieldName>MenuIcon" (colon-joined, not
      // hyphen). Rather than guess every possible suffix convention, find
      // the actual trigger icon by DOM proximity (first img/button sibling
      // within the same form-item container) and click whatever it really
      // is.
      const triggerId = await page.evaluate((id) => {
        const input = document.getElementById(id);
        if (!input) return null;
        const item = input.closest('.x-form-item') || input.closest('.x-field') || input.parentElement;
        if (!item) return null;
        // Priority order matters here (confirmed via live failure): a plain
        // comma-separated CSS selector returns the first DOCUMENT-order
        // match across ALL alternatives, not first-selector-priority - this
        // can pick a "...-triggerWrap" CONTAINER div instead of the real
        // clickable "...MenuIcon" icon nested inside it. Check MenuIcon
        // explicitly first, and exclude "Wrap" containers from the generic
        // trigger fallback.
        const icon = item.querySelector('[id*="MenuIcon"]')
          || item.querySelector('.x-form-trigger')
          || item.querySelector('img')
          || item.querySelector('[id*="trigger"]:not([id*="Wrap"])');
        return icon ? icon.id : null;
      }, comboId).catch(() => null);
      if (triggerId) {
        await page.locator(`[id="${triggerId}"]`).click().catch(() => {});
        optionsOpen = await page.getByRole('option').first().waitFor({ state: 'visible', timeout: 3000 })
          .then(() => true).catch(() => false);
      }
    }
  }

  if (value) {
    // Confirmed via repeated live failure: the requested value can genuinely
    // not be a valid option for THIS particular coverage/exposure combo (the
    // field itself exists, but its option set differs), leaving Playwright's
    // default .click() auto-wait polling the full 30s for an option that will
    // never appear. Bound the wait and fall back to the first real option
    // instead of hanging/failing outright.
    const namedOption = page.getByRole('option', { name: value, exact }).nth(skip);
    const hasNamedOption = await namedOption.waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true).catch(() => false);
    if (hasNamedOption) {
      await namedOption.click();
      // Confirmed via user report: moving on immediately after clicking an
      // option can outrun the app's own commit of the selection - Tab out to
      // force a blur/commit before the caller proceeds.
      await page.keyboard.press('Tab').catch(() => {});
      await page.waitForTimeout(150);
    } else {
      console.log('selectComboboxOnPrem: option "' + value + '" not found for "' + label + '" - falling back to first real option');
      await selectFirstRealOption(page);
    }
  } else if (excludeValues) {
    await selectUnusedRealOption(page, excludeValues);
  } else if (random) {
    await selectRandomRealOption(page, avoidNew);
  } else {
    await selectFirstRealOption(page, avoidNew);
  }
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  return true;
}

// Shared by selectComboboxOnPrem/selectComboboxByIdOnPrem: picks the first
// open role="option" whose text isn't a blank/"<none>"-style placeholder.
async function selectFirstRealOption(page, avoidNew = false) {
  const options = page.getByRole('option');
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const text = (await options.nth(i).textContent() || '').trim();
    if (!text || text === '<none>' || text.toLowerCase() === 'none') continue;
    // Confirmed via live screenshot: a "New..." choice is a real, pickable,
    // non-placeholder option too - landing on it for a field that already
    // has a genuine existing record (e.g. Injury Incident, already created
    // during FNOL Step 3) opens a whole separate create-new screen with its
    // own cascade of required fields instead of just selecting what's there.
    if (avoidNew && /^new\.\.\./i.test(text)) continue;
    // Confirmed via live failure: picking "In Suit (P)" for Litigation Status
    // during FNOL generates a "Create a Matter for Exposure In Suit" workplan
    // activity that blocks every other activity from completing — automation
    // cannot create a legal matter. Skip all "In Suit" options globally.
    if (/in suit/i.test(text)) continue;
    // Confirmed via live failure: the option list can re-render mid-selection
    // (e.g. ExtJS reload after filling a state/location field) causing the
    // click to hang for the full 30s default action timeout before throwing.
    // Bound to 3s and continue to the next candidate if it disappears.
    const clicked = await options.nth(i).click({ timeout: 3000 }).then(() => true).catch(() => false);
    if (!clicked) continue;
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForTimeout(150);
    return text;
  }
  // Fall back to whatever's first if every option looked like a placeholder
  // (or was "New..." while avoiding it).
  if (count > 0) {
    await options.first().click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForTimeout(150);
  }
  return null;
}

// Picks a RANDOM (not first) non-placeholder option - used for fields where
// always picking the alphabetically-first party causes real collisions
// across repeated test runs (confirmed via live validation error: "This
// claimant number already exists on another claim" - the same person/number
// gets reused every run since selectFirstRealOption always lands on the
// same party, e.g. always "MARGARET ANDERSON").
async function selectRandomRealOption(page, avoidNew = false) {
  const options = page.getByRole('option');
  const count = await options.count();
  const real = [];
  for (let i = 0; i < count; i++) {
    const text = (await options.nth(i).textContent() || '').trim();
    if (!text || text === '<none>' || text.toLowerCase() === 'none') continue;
    // Same "New..." avoidance as selectFirstRealOption - a field with a
    // genuine existing record shouldn't randomly land on creating a new one.
    if (avoidNew && /^new\.\.\./i.test(text)) continue;
    real.push(i);
  }
  if (real.length === 0) {
    if (count > 0) {
      await options.first().click({ timeout: 3000 }).catch(() => {});
      await page.keyboard.press('Tab').catch(() => {});
      await page.waitForTimeout(150);
    }
    return null;
  }
  const idx = real[Math.floor(Math.random() * real.length)];
  const text = (await options.nth(idx).textContent() || '').trim();
  await options.nth(idx).click({ timeout: 3000 }).catch(() => {});
  await page.keyboard.press('Tab').catch(() => {});
  await page.waitForTimeout(150);
  return text;
}

// Deterministically picks the first non-placeholder option whose text is NOT
// in excludeSet (e.g. claimant numbers already used on this policy) - used in
// place of selectRandomRealOption for fields backed by a SMALL, FIXED pool of
// real values (like Claimant Number). Random selection there kept re-hitting
// already-used values once a policy's pool got partially exhausted across
// runs (confirmed via repeated live "already exists on another claim"
// failures even with retries) - walking the list and skipping known-used
// values guarantees a fresh one is found whenever one still exists, rather
// than hoping enough random retries eventually land on one.
async function selectUnusedRealOption(page, excludeSet) {
  // Confirmed via live failure: a global, unscoped page.getByRole('option')
  // can include items from a STALE/hidden boundlist left over from an
  // earlier field (same class of bug already fixed for Memo Phrase and
  // Payee Name elsewhere in this codebase) - .nth(i).textContent() on one of
  // those stale/non-rendered items just hangs for the full 30s timeout
  // instead of resolving. Do the whole scan+click inside ONE page.evaluate()
  // call, scoped to the LAST VISIBLE .x-boundlist container only - avoids
  // both the staleness bug and N round-trips through Playwright's locator
  // API for large option lists (a real Claimant Number pool can have 40+
  // entries).
  const excludeArray = excludeSet ? Array.from(excludeSet) : [];
  const pickedText = await page.evaluate((excludeArray) => {
    const containers = Array.from(document.querySelectorAll('.x-boundlist')).filter(c => c.offsetParent !== null);
    const container = containers[containers.length - 1];
    if (!container) return null;
    const real = Array.from(container.querySelectorAll('.x-boundlist-item'))
      .map(li => ({ el: li, text: li.textContent.trim() }))
      .filter(o => o.text && o.text !== '<none>' && o.text.toLowerCase() !== 'none');
    const unused = real.filter(o => !excludeArray.includes(o.text));
    // Per user direction: pick from the TOP of the list (largest numeric
    // value) instead of walking up from the historical low end. Every prior
    // strategy (plain "first real option", "smallest above historical max")
    // still started from the BOTTOM of the range, and years of accumulated
    // test runs have heavily saturated that low end on well-worn policies -
    // confirmed via live failure needing 10+ sequential collisions to find a
    // free number there. The high end is essentially untouched by that same
    // history, so picking the largest unused value collapses the common
    // case to a single attempt instead of a long walk.
    const numericUnused = unused
      .filter(o => !Number.isNaN(Number(o.text)))
      .sort((a, b) => Number(b.text) - Number(a.text));
    const pick = numericUnused[0] || unused[0] || real[0];
    if (!pick) return null;
    pick.el.click();
    return pick.text;
  }, excludeArray);
  if (pickedText) {
    // Confirmed via user report: continuing on immediately after a pick can
    // outrun the app's own commit - Tab out to force the blur/commit.
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForTimeout(150);
  }
  return pickedText;
}

// ── On-prem combobox by element id (for fields with no accessible label) ─────
// Some ExtJS screens (e.g. FNOL Basic Info) render combos with no aria-label
// at all - confirmed via live inspection - so selectComboboxOnPrem's role+name
// lookup can't target them. This targets the input's real id instead.
async function selectComboboxByIdOnPrem(page, inputId, value, { exact = false } = {}) {
  await page.locator(`[id="${inputId}"]`).click();
  if (value) {
    await page.getByRole('option', { name: value, exact }).first().click();
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForTimeout(150);
  } else {
    await selectFirstRealOption(page);
  }
}

// ── Dropdown selection (env-aware) ────────────────────────────────────────────
async function selectDropdown(page, fieldName, value) {
  if (IS_ON_PREM) {
    // ExtJS combo: click trigger arrow then click list item
    const trigger = page.locator(L.combo.trigger(fieldName)).first();
    if (await trigger.count() > 0) {
      await trigger.click();
      await page.waitForTimeout(500);
      const item = page.locator(L.combo.listItem(value)).first();
      await item.waitFor({ state: 'visible', timeout: 10_000 });
      await item.click();
    } else {
      // Fallback: try native select
      await page.selectOption('[name*="' + fieldName + '"], [id*="' + fieldName + '"]', value);
    }
  } else {
    // Cloud: native <select>
    await page.selectOption(L.combo.trigger(fieldName), value);
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

// ── Field helpers ─────────────────────────────────────────────────────────────
async function fillTextField(page, selector, value) {
  const el = page.locator(selector).first();
  await el.click();
  await el.fill('');
  await page.keyboard.type(String(value));
  await el.blur();
}

async function fillIntegerCommaField(page, selector, value) {
  const clean = String(value).replace(/,/g, '');
  const el = page.locator(selector).first();
  await el.click();
  await el.fill('');
  await page.keyboard.type(clean);
  await el.blur();
}

async function fillDateField(page, selector, mmddyyyy) {
  const el = page.locator(selector).first();
  await el.fill('');
  await el.type(mmddyyyy);
  await page.keyboard.press('Tab');
}

// ── Wait helpers ──────────────────────────────────────────────────────────────
async function waitForEnabled(page, selector, timeout = MAX_POLL_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const disabled = await page.$eval(selector,
      el => el.disabled || el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true'
    ).catch(() => true);
    if (!disabled) return;
    await page.waitForTimeout(POLL_INT);
  }
  throw new Error('Element still disabled: ' + selector);
}

// ── Save / Submit ─────────────────────────────────────────────────────────────
async function clickSave(page) {
  await page.locator(L.toolbar.save).first().click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function clickNext(page) {
  await page.locator(L.fnol.nextButton).first().click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

// ── Notification dismissal ────────────────────────────────────────────────────
async function dismissNotification(page) {
  const selectors = [
    'button.wb-bell-btn-ack',
    'button.gw-BannerUIMessages--close',
    '.x-msg-box button:has-text("OK")',   // ExtJS modal OK
    '.x-message-box button',              // ExtJS message box
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

// Guidewire claim number format, e.g. "PA-PA-01-26-0747175",
// "CXL-DE-01-26-0747169", "CPP-TX-90-26-0747163" - 2-5 letters (LOB code),
// 2 letters (state), 2 digits, 2 digits, 6-8 digits. The old /\d{4}-\d+/
// pattern never matched this at all (no 4-digit segment exists in it).
const CLAIM_NUMBER_RE = /[A-Z]{2,5}-[A-Z]{2}-\d{2}-\d{2}-\d{6,8}/;

// ── Claim number polling ──────────────────────────────────────────────────────
async function pollForClaimNumber(page) {
  const deadline = Date.now() + MAX_POLL_MS;

  // A claim number found while the WIZARD IS STILL OPEN is not proof a claim
  // was saved. Confirmed via screenshot: the wizard sat on "Step 1 of 5" with
  // status "St: Draft" and a claimant-number validation error, yet a
  // claim-number-shaped string elsewhere on the page was scraped and reported
  // as "claim created" - a false success that made a failed FNOL look green.
  // Refuse to return one until the wizard is gone and the claim is not Draft.
  const wizardStillOpen = async () => page.evaluate(() => {
    const t = document.body.innerText || '';
    return /New Claim Wizard/i.test(t) || /Step\s*\d+\s*of\s*5/i.test(t) || /\bSt:\s*Draft\b/i.test(t);
  }).catch(() => false);
  const claimSelectors = [
    L.fnol.claimNumber,
    '[id*="ClaimNumber"]', '[id*="claimNumber"]',
    '.gw-label:has-text("Claim #") ~ .gw-label',
    'td:has-text("Claim #") + td',
  ];

  if (IS_ON_PREM) {
    // On-prem's Finish lands synchronously on a static "New Claim Saved"
    // confirmation page (confirmed via live screenshot: "Claim PA-PA-01-26-
    // 0747175 has been successfully saved.") - no async claim-detail load to
    // poll for, and reload()ing this one-time confirmation page is unsafe
    // (it's an action result, not idempotent). Just read the body text once.
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

    // POLL for the claim number rather than reading once. A single read 500ms
    // after the mask cleared is a race: on WC the confirmation page had not
    // finished painting, the number was absent, and FNOL failed outright on a
    // claim the server had already created. Re-reading costs nothing when the
    // page is ready.
    let bodyText = '';
    let match = null;
    for (let attempt = 0; attempt < 12 && !match; attempt++) {
      await page.waitForTimeout(500);
      bodyText = await page.locator('body').innerText().catch(() => '');
      match = bodyText.match(CLAIM_NUMBER_RE);
    }
    if (!match) {
      // Say what WAS on screen - "not found" alone gave nothing to work from.
      const seen = bodyText.replace(/\s+/g, ' ').trim().slice(0, 300) || '(page text unreadable)';
      throw new Error('Claim number not found on confirmation page (on-prem) after 6s. ' +
                      'Page showed: "' + seen + '"');
    }

    // This confirmation page is NOT the claim workspace. Any subsequent action
    // expecting Claim:ClaimMenuActions needs us to navigate there first.
    // Find GoToClaim/ViewClaim/OpenClaim element — exact ID varies by LOB wizard.
    // Do NOT match 'Claim-inputEl' generically: confirmed via live page dump that
    // HO "New Claim Saved" only has CreateNewClaim-inputEl (no GoToClaim element),
    // so the old id.includes('Claim-inputEl') pattern was incorrectly clicking
    // "Create another new claim" instead of navigating to the claim workspace.
    const gotoClaimId = await page.evaluate((claimNum) => {
      for (const el of document.querySelectorAll('[id^="NewClaimSaved"]')) {
        if (!el.offsetParent) continue;
        const id = el.id || '';
        const text = (el.innerText||'').trim();
        if (id.includes('GoToClaim') || id.includes('ViewClaim') || id.includes('OpenClaim')) {
          return id;
        }
        if (text.includes(claimNum) && id.endsWith('-inputEl') && !id.includes('CreateNew')) {
          return id;
        }
      }
      return null;
    }, match[0]).catch(() => null);

    if (gotoClaimId) {
      console.log('GoToClaim: clicking', gotoClaimId);
      await page.locator(`[id="${gotoClaimId}"]`).click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
    } else {
      console.log('GoToClaim: no GoToClaim/ViewClaim element on New Claim Saved page for', match[0]);
    }

    const claimWorkspaceReady = await page.locator('[id="Claim:ClaimMenuActions"]')
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => true).catch(() => false);

    if (claimWorkspaceReady) {
      console.log('Navigated into claim workspace:', match[0]);
    } else {
      // HO FNOL assigns claims to "Bodily Injury" group — the automation user
      // (benjsmit) lacks view access, so no GoToClaim link appears on the
      // "New Claim Saved" page. Clear session and re-login as admin, who has
      // universal claim access, to reach the workspace.
      const adminUser = process.env.CC_ADMIN_USER;
      const adminPass = process.env.CC_ADMIN_PASS;
      if (adminUser && adminPass) {
        console.log('Claim workspace not reached; re-logging as admin to open claim:', match[0]);
        await page.context().clearCookies();
        await loginToClaimCenter(page, { username: adminUser, password: adminPass });
        await openExistingClaim(page, match[0]);
      } else {
        console.log('WARNING: claim workspace not confirmed and CC_ADMIN_USER/CC_ADMIN_PASS not set:', match[0]);
      }
    }
    return match[0];
  }

  // Cloud (React/Jutro): claim number appears in the URL fragment, page title,
  // or body text after Finish navigates to the claim workspace. Reloading is
  // unreliable (the SPA URL may not survive a hard reload), so scan without reload first.
  // First attempt: check URL + title + body without reloading (claim workspace loads fast).
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(3000);
  // Log what we see right after Finish for diagnosis
  const diagUrl = page.url();
  const diagTitle = await page.title().catch(() => '');
  const diagBody = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '').then(t => t.substring(0, 800));
  console.log('pollForClaimNumber (cloud) | URL:', diagUrl);
  console.log('pollForClaimNumber (cloud) | title:', diagTitle);
  console.log('pollForClaimNumber (cloud) | body:', diagBody);

  // Guard against reporting a claim that was never saved (see the note at the
  // top of this function). Give the wizard a chance to close, then refuse to
  // scan while it is still on screen.
  // Cloud lands on a "New Claim Saved" confirmation page, NOT the claim
  // workspace (confirmed via screenshot: "Claim WC-... has been successfully
  // saved. / Assigned Group / Assigned User" plus a list of next actions).
  // Everything claim-level that follows - documents, exposures, reserves -
  // needs the claim actually open, so follow the "View ... the newly saved
  // claim" link the page provides. On-prem already does the equivalent via its
  // GoToClaim element; the cloud path simply never did.
  const viewLink = page.getByRole('link', { name: /View .*newly saved claim/i }).first();
  if (await viewLink.isVisible().catch(() => false)) {
    console.log('pollForClaimNumber (cloud): opening the newly saved claim from the confirmation page');
    await viewLink.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2500);
  }

  for (let w = 0; w < 10 && await wizardStillOpen(); w++) await page.waitForTimeout(1000);
  if (await wizardStillOpen()) {
    const why = await page.evaluate(() => {
      // Include textContent: CC's Validation Results panel can be COLLAPSED, so
      // its text is absent from innerText and the failure looked like it had no
      // explanation at all.
      const t = (document.body.innerText || '') + ' ' + (document.body.textContent || '');
      const step = (t.match(/Step\s*\d+\s*of\s*5[^\n]*/i) || [])[0] || '';
      const errs = [...t.matchAll(/^(.*(?:Missing required field|already exists on another claim)[^\n]*)$/gim)]
        .map(m => m[1].trim()).slice(0, 4);
      return { step, errs };
    }).catch(() => ({ step: '', errs: [] }));
    // A claimant-number collision here means this POLICY has been used for so
    // many claims that its claimant-number pool is exhausted. That is a test-data
    // limit, not an automation defect, and the fix is a fresh policy - so say so
    // plainly instead of burying it in a wall of page text.
    if (why.errs.some(e => /already exists on another claim/i.test(e))) {
      throw new Error(
        'POLICY EXHAUSTED: this policy\'s claimant numbers are all taken, so no new claim can be ' +
        'created on it. ClaimCenter says: "This claimant number already exists on another claim." ' +
        'ACTION REQUIRED: supply a fresh policy number for this LOB (update the POLICY_* entry in ' +
        '.env) and re-run. No code change will get past this.');
    }
    throw new Error('FNOL DID NOT COMPLETE (cloud): the New Claim Wizard is still open' +
      (why.step ? ' on "' + why.step + '"' : '') + ' and the claim is still a Draft. ' +
      (why.errs.length ? 'On-screen validation: ' + why.errs.join(' || ')
                       : 'No validation text found on screen.'));
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (page.isClosed()) throw new Error('Page closed during claim number polling');
    try {
      // 1. URL fragment (e.g. #/claim/PA-PA-26-01-0747175/...)
      const url = page.url();
      const urlMatch = url.match(CLAIM_NUMBER_RE);
      if (urlMatch) { console.log('pollForClaimNumber (cloud): found in URL:', urlMatch[0]); return urlMatch[0]; }

      // 2. Page title
      const title = await page.title().catch(() => '');
      const titleMatch = title.match(CLAIM_NUMBER_RE);
      if (titleMatch) { console.log('pollForClaimNumber (cloud): found in title:', titleMatch[0]); return titleMatch[0]; }

      // 3. DOM selectors
      for (const sel of claimSelectors) {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          const text = (await el.textContent() || '').trim();
          if (CLAIM_NUMBER_RE.test(text)) { console.log('pollForClaimNumber (cloud): found via selector', sel); return text.match(CLAIM_NUMBER_RE)[0]; }
        }
      }

      // 4. Full body text scan (broadest fallback)
      const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      const bodyMatch = bodyText.match(CLAIM_NUMBER_RE);
      if (bodyMatch) { console.log('pollForClaimNumber (cloud): found in body text:', bodyMatch[0]); return bodyMatch[0]; }
    } catch (e) { console.log('pollForClaimNumber (cloud) attempt', attempt, 'error:', String(e).substring(0, 100)); }
    await page.waitForTimeout(POLL_INT);
  }
  // Still not found — try one reload in case SPA needs a nudge
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('Page closed during claim number polling');
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const url = page.url();
      const urlMatch = url.match(CLAIM_NUMBER_RE);
      if (urlMatch) return urlMatch[0];
      const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      const bodyMatch = bodyText.match(CLAIM_NUMBER_RE);
      if (bodyMatch) return bodyMatch[0];
    } catch (_) {}
    await page.waitForTimeout(POLL_INT);
  }
  throw new Error('Claim number not found after timeout');
}

// ── Assertions ────────────────────────────────────────────────────────────────
async function verifyTextVisible(page, text) {
  await expect(page.locator('text=' + text).first()).toBeVisible({ timeout: 15_000 });
}

async function verifyNoValidationErrors(page) {
  const errors = page.locator(
    '.gw-validation-error, .error-message, [class*="errorMsg"], .x-form-invalid-msg'
  );
  expect(await errors.count()).toBe(0);
}

async function elementExists(page, selector) {
  return (await page.locator(selector).count()) > 0;
}

// ── Export everything including locators and env flags ────────────────────────
module.exports = {
  BASE_URL, MAX_POLL_MS, POLL_INT,
  ENV, TIER, IS_ON_PREM, L,
  waitForAllMasksGone,
  loginToClaimCenter, loginAsAdmin, openExistingClaim, navigateTo,
  openTabMenu, clickTabMenuItem, selectTab,
  selectDropdown, selectComboboxOnPrem, selectComboboxByIdOnPrem, fillTextField, fillIntegerCommaField, fillDateField,
  waitForEnabled, clickSave, clickNext, dismissNotification,
  pollForClaimNumber, verifyTextVisible, verifyNoValidationErrors, elementExists,
  getTestLossDate, getLossState, getNextPolicy, getUsedClaimantNumbers, addUsedClaimantNumber,
};
