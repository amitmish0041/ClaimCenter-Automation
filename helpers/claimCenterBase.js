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
const { expect } = require('@playwright/test');

const OnPremLocators = require('./locators/onPremLocators');
const CloudLocators  = require('./locators/cloudLocators');

const ENV         = (process.env.CC_ENV || 'onprem').toLowerCase();
const IS_ON_PREM  = ENV === 'onprem';
const L           = IS_ON_PREM ? OnPremLocators : CloudLocators;

const BASE_URL    = process.env.CC_BASE_URL ||
  (IS_ON_PREM
    ? 'http://test-claimcenter.donegalgroup.com/cc/ClaimCenter.do'
    : 'https://donegal-cc.guidewire.net/cc/');

const MAX_POLL_MS = 60_000;
const POLL_INT    = 2_000;

console.log('CC Environment: ' + ENV.toUpperCase() + ' | URL: ' + BASE_URL);

// ── Login ─────────────────────────────────────────────────────────────────────
async function loginToClaimCenter(page) {
  const user = process.env.CC_USER;
  const pass = process.env.CC_PASS;
  if (!user || !pass) throw new Error('Set CC_USER and CC_PASS in .env');

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  // Wait for login form
  await page.waitForSelector(L.login.username, { timeout: 30_000 });
  await page.locator(L.login.username).first().fill(user);
  await page.locator(L.login.password).first().fill(pass);

  if (IS_ON_PREM) {
    // ExtJS: click the inner span, then confirm navigation away from login page
    await page.locator(L.login.submit).first().click();
    await page.waitForFunction(() =>
      !document.querySelector('input[name="Login:LoginScreen:LoginDV:username"]'),
      { timeout: 30_000 }
    );
  } else {
    // Cloud: standard submit
    await page.locator(L.login.submit).first().click();
    await page.waitForSelector(L.desktop.ready, { timeout: 30_000 });
  }

  console.log('CC Login successful [' + ENV + '] | URL: ' + page.url());
}

// ── Navigation ────────────────────────────────────────────────────────────────
async function navigateTo(page, section) {
  const sel = L.nav[section];
  if (!sel) throw new Error('Unknown nav section: ' + section);
  await page.locator(sel).first().click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
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

// ── Claim number polling ──────────────────────────────────────────────────────
async function pollForClaimNumber(page) {
  const deadline = Date.now() + MAX_POLL_MS;
  const claimSelectors = [
    L.fnol.claimNumber,
    '[id*="ClaimNumber"]', '[id*="claimNumber"]',
    '.gw-label:has-text("Claim #") ~ .gw-label',
    'td:has-text("Claim #") + td',
  ];

  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('Page closed during claim number polling');
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      for (const sel of claimSelectors) {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          const text = (await el.textContent() || '').trim();
          if (/\d{4}-\d+/.test(text)) return text;
        }
      }
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
  ENV, IS_ON_PREM, L,
  loginToClaimCenter, navigateTo,
  selectDropdown, fillTextField, fillIntegerCommaField, fillDateField,
  waitForEnabled, clickSave, clickNext, dismissNotification,
  pollForClaimNumber, verifyTextVisible, verifyNoValidationErrors, elementExists,
};
