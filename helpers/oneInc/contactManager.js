/**
 * helpers/oneInc/contactManager.js — temporary edits of Address Book vendors in ContactManager (TEST), for the payee
 * validity rules (VBR.031 "Tax ID Valid Until"). Every change is written to a restore ledger BEFORE it is made and put back
 * by restoreVendors (recipes call it as their last step; setTaxValidUntil also settles any leftover ledger entries first, and
 * `node helpers/oneInc/contactManager.js --restore` does it by hand), so a crashed run never leaves a vendor changed.
 *
 * Credentials come only from the environment (CM_USER / CM_PASS, passed inline); nothing is stored. Without them the case
 * is BLOCKED. ContactManager saves a vendor edit directly (no pending-change approval), CONFIRMED 2026-10-22.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const W = require('./wizardDriver');

const CM_URL = process.env.CM_URL || 'https://cm-test-dngldev.donegal.beta5-andromeda.guidewire.net/ContactManager.do';
const LEDGER = path.join(__dirname, '..', '..', 'results', 'oneInc', 'cm-restore.json');
const FIELD = 'input[name$="ExtTINValidDate"]';

const readLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (_) { return []; } };
const writeLedger = (l) => { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); };
const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

// 'past' | 'future' | 'none' | an explicit MM/DD/YYYY
function dateFor(when) {
  if (when === 'past') return '01/01/2020';
  if (when === 'future') { const d = new Date(); d.setFullYear(d.getFullYear() + 2); return fmt(d); }
  if (when === 'none') return '';
  return String(when);
}

async function login(cm) {
  if (!process.env.CM_USER || !process.env.CM_PASS) throw new W.Blocked('ContactManager credentials not provided (set CM_USER / CM_PASS in the environment)');
  await cm.goto(CM_URL, { waitUntil: 'domcontentloaded' });
  await cm.getByLabel('Username').waitFor({ timeout: 30000 });
  await cm.getByLabel('Username').fill(process.env.CM_USER);
  await cm.getByLabel('Password').fill(process.env.CM_PASS);
  await cm.getByRole('button', { name: 'Log In', exact: true }).click();
  await cm.getByText('Merge Contacts', { exact: true }).first().waitFor({ timeout: 30000 }).catch(() => { throw new W.Blocked('ContactManager login was rejected'); });
}

// Opens the vendor (by Tax ID) in Edit mode.
async function openVendorEdit(cm, taxId) {
  await cm.getByText('Search', { exact: true }).first().click();
  await cm.getByLabel('Tax ID', { exact: true }).first().waitFor({ timeout: 20000 });
  await cm.getByLabel('Tax ID', { exact: true }).first().fill(taxId);
  await cm.getByRole('button', { name: 'Search', exact: true }).click();
  await cm.waitForTimeout(4000);
  const row = cm.locator('tr').filter({ hasText: taxId }).first();
  if (!await row.isVisible().catch(() => false)) throw new W.Blocked(`vendor with Tax ID ${taxId} not found in ContactManager`);
  await row.locator('a, .gw-label, td').filter({ hasText: /[A-Za-z]{3}/ }).first().click();
  await cm.waitForTimeout(4500);
  await cm.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await cm.locator(FIELD).waitFor({ timeout: 20000 });
}

async function saveField(cm, value) {
  await cm.locator(FIELD).fill(value);
  await cm.keyboard.press('Tab');
  await cm.getByRole('button', { name: 'Update', exact: true }).first().click();
  await cm.getByRole('button', { name: 'Edit', exact: true }).first().waitFor({ timeout: 20000 }).catch(() => { throw new W.Blocked('ContactManager did not save the vendor change'); });
}

// Runs fn(cmPage) in its own browser context (separate cookies; the ClaimCenter page is left alone).
async function withCM(page, fn) {
  const ctx = await page.context().browser().newContext({ viewport: { width: 1600, height: 900 } });
  try { const cm = await ctx.newPage(); await login(cm); return await fn(cm); } finally { await ctx.close().catch(() => {}); }
}

async function applyDate(page, taxId, value, label) {
  return withCM(page, async (cm) => {
    await openVendorEdit(cm, taxId);
    const before = await cm.locator(FIELD).inputValue();
    if (before === value) { await cm.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {}); return { before, changed: false }; }
    if (label) {
      const ledger = readLedger().filter((e) => e.taxId !== taxId);
      ledger.push({ name: label, taxId, field: 'Tax ID Valid Until', original: before, changedAt: new Date().toISOString() });
      writeLedger(ledger); // recorded before the edit is saved
    }
    await saveField(cm, value);
    return { before, changed: true };
  });
}

async function restoreVendors(page) {
  const pending = readLedger();
  for (const e of pending) {
    await applyDate(page, e.taxId, e.original, null);
    writeLedger(readLedger().filter((x) => x.taxId !== e.taxId));
  }
  return pending.length ? `restored ${pending.map((e) => `${e.name} Tax ID Valid Until=${e.original || '<blank>'}`).join('; ')}` : 'nothing to restore';
}

// Test step: sets the vendor's Tax ID Valid Until to 'past' | 'future' | 'none' (or a date). Reverted by restoreVendors.
async function setTaxValidUntil(page, label, taxId, when) {
  if (readLedger().length) await restoreVendors(page); // settle leftovers from an interrupted run first
  const value = dateFor(when);
  const r = await applyDate(page, taxId, value, label);
  return `${label}: Tax ID Valid Until ${r.before || '<blank>'} → ${value || '<blank>'}${r.changed ? '' : ' (already set)'}`;
}

module.exports = { setTaxValidUntil, restoreVendors, readLedger, dateFor };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: false });
  const { chromium } = require('playwright');
  (async () => {
    const b = await chromium.launch({ headless: false });
    const page = await (await b.newContext()).newPage();
    try { console.log(await restoreVendors(page)); } catch (e) { console.error(e.message); process.exitCode = 1; }
    await b.close();
  })();
}
