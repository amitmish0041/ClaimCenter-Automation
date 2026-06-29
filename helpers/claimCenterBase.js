/**
 * helpers/claimCenterBase.js
 * Core login, navigation, field helpers and wait utilities for GW ClaimCenter Cloud.
 */
require('dotenv').config();
const { expect } = require('@playwright/test');

const BASE_URL    = process.env.CC_BASE_URL || 'https://donegal-cc.guidewire.net/cc/';
const MAX_POLL_MS = 60_000;
const POLL_INT    = 2_000;

async function loginToClaimCenter(page) {
  const user = process.env.CC_USER;
  const pass = process.env.CC_PASS;
  if (!user || !pass) throw new Error('Set CC_USER and CC_PASS in .env');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.fill('#USERNAME', user);
  await page.fill('#PASSWORD', pass);
  await page.click('input[type="submit"]');
  await page.waitForSelector('#TabBar', { timeout: 30_000 });
  console.log('CC Login successful');
}

async function waitForEnabled(page, selector, timeout = MAX_POLL_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const disabled = await page.$eval(selector,
      el => el.disabled || el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true'
    ).catch(() => true);
    if (!disabled) return;
    await page.waitForTimeout(POLL_INT);
  }
  throw new Error('Element still disabled after ' + timeout + 'ms: ' + selector);
}

async function selectDropdown(page, selector, value) {
  await waitForEnabled(page, selector);
  await page.selectOption(selector, value);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function fillTextField(page, selector, value) {
  await page.click(selector);
  await page.fill(selector, '');
  await page.keyboard.type(String(value));
  await page.locator(selector).blur();
}

async function fillIntegerCommaField(page, selector, value) {
  const clean = String(value).replace(/,/g, '');
  await page.click(selector);
  await page.fill(selector, '');
  await page.keyboard.type(clean);
  await page.locator(selector).blur();
}

async function fillDateField(page, selector, mmddyyyy) {
  await page.fill(selector, '');
  await page.type(selector, mmddyyyy);
  await page.keyboard.press('Tab');
}

async function dismissNotification(page) {
  const btn = page.locator('button.wb-bell-btn-ack, button.gw-BannerUIMessages--close').first();
  if (await btn.count() > 0) await btn.click().catch(() => {});
}

async function clickSave(page) {
  await page.click('button[id$="-Update"], button[id$="-Finish"], #Update, #Finish').catch(async () => {
    await page.click('button:has-text("Update"), button:has-text("Finish")');
  });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function pollForClaimNumber(page) {
  const deadline = Date.now() + MAX_POLL_MS;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('Page closed during claim number polling');
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const el = page.locator('[id*="ClaimNumber"], [id*="claimNumber"]').first();
      if (await el.count() > 0) {
        const text = await el.textContent();
        if (text && /\d{4}-\d+/.test(text)) return text.trim();
      }
    } catch (_) {}
    await page.waitForTimeout(POLL_INT);
  }
  throw new Error('Claim number not available after timeout');
}

async function verifyTextVisible(page, text) {
  await expect(page.locator('text=' + text).first()).toBeVisible({ timeout: 15_000 });
}

async function verifyNoValidationErrors(page) {
  const errors = page.locator('.gw-validation-error, .error-message, [class*="errorMsg"]');
  expect(await errors.count()).toBe(0);
}

async function elementExists(page, selector) {
  return (await page.locator(selector).count()) > 0;
}

module.exports = {
  BASE_URL, MAX_POLL_MS, POLL_INT,
  loginToClaimCenter, waitForEnabled, selectDropdown,
  fillTextField, fillIntegerCommaField, fillDateField,
  dismissNotification, clickSave, pollForClaimNumber,
  verifyTextVisible, verifyNoValidationErrors, elementExists,
};
