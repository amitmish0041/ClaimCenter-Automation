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
const PHONE = 'input[name$="ABPersonVendorInputSet-Work-GlobalPhoneInputSet-NationalSubscriberNumber"]';
const EMAIL = 'input[name$="ABPersonVendorInputSet-Primary"]';

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

// Types a phone number key by key (the field is masked). The page re-renders after a phone/e-mail change and can reset the
// other field, so setBoth re-checks both values until they stick, right before Update.
async function typeInto(cm, sel, val) { const el = cm.locator(sel).first(); await el.click(); await el.fill(''); if (val) await el.pressSequentially(val, { delay: 30 }); await el.press('Tab'); await cm.waitForTimeout(1200); }
async function setBoth(cm, emailSel, phoneSel, email, phone) {
  const digits = (x) => String(x || '').replace(/[^0-9]/g, '');
  const ok = async () => digits(await cm.locator(phoneSel).first().inputValue()) === digits(phone) && await cm.locator(emailSel).first().inputValue() === email;
  for (let i = 0; i < 3; i++) {
    if (digits(await cm.locator(phoneSel).first().inputValue()) !== digits(phone)) await typeInto(cm, phoneSel, phone);
    if (await cm.locator(emailSel).first().inputValue() !== email) await typeInto(cm, emailSel, email);
    if (await ok()) return;
  }
  throw new W.Blocked('ContactManager did not keep the e-mail/phone values on the form (wanted "' + email + '" / "' + phone + '"; form has "' + await cm.locator(emailSel).first().inputValue() + '" / "' + await cm.locator(phoneSel).first().inputValue() + '")');
}

async function saveField(cm, value, field = FIELD) {
  await cm.locator(field).fill(value);
  await cm.keyboard.press('Tab');
  await cm.getByRole('button', { name: 'Update', exact: true }).first().click();
  await cm.getByRole('button', { name: 'Edit', exact: true }).first().waitFor({ timeout: 20000 }).catch(async () => { if (process.env.CM_DEBUG_SHOT) await cm.screenshot({ path: process.env.CM_DEBUG_SHOT }).catch(() => {}); throw new W.Blocked('ContactManager did not save the change: ' + (await cm.locator('.gw-message, [class*=error], [role=alert]').allInnerTexts().catch(() => [])).join(' / ').replace(/s+/g, ' ').slice(0, 300)); });
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
      const ledger = readLedger(); if (ledger.some((e) => !e.kind && e.taxId === taxId)) { /* keep the first original (a retried step must not record the changed value) */ } else
      ledger.push({ name: label, taxId, field: 'Tax ID Valid Until', original: before, changedAt: new Date().toISOString() });
      writeLedger(ledger); // recorded before the edit is saved
    }
    await saveField(cm, value);
    return { before, changed: true };
  });
}


// ── Person contact e-mail (CPD.001: a payee with no e-mail makes ClaimCenter default ClaimsPay to Other / Mailed Check) ──
// The insured/claimant of the automation PA auto claims (DMG LMB TEST, ZIP 18109) is linked to the Address Book and "must be
// changed in PolicyCenter" in ClaimCenter, so it is edited here. who = { name, lastName, zip }.
async function openPersonEdit(cm, who) {
  await cm.getByText('Search', { exact: true }).first().click();
  const sub = cm.locator('select[name$="ContactSubtype"]').first();
  await sub.waitFor({ timeout: 20000 });
  await cm.waitForTimeout(1500);
  await sub.selectOption({ label: 'Person' });
  await cm.locator('input[name$="LastName"]').first().waitFor({ timeout: 20000 }).catch(async () => { throw new W.Blocked('ContactManager Person search form did not load (fields: ' + (await cm.evaluate(() => [...document.querySelectorAll('input,select')].filter((i) => i.offsetParent).map((i) => (i.name || '').replace(/^.*-/, '')).join(','))) + ')'); });
  if (who.lastName) await cm.locator('input[name$="LastName"]').first().fill(who.lastName);
  if (who.zip) await cm.locator('input[name$="PostalCode"]').first().fill(who.zip);
  await cm.getByRole('button', { name: 'Search', exact: true }).click();
  await cm.waitForTimeout(4000);
  const row = cm.locator('tr').filter({ hasText: who.name }).first();
  if (!await row.isVisible().catch(() => false)) throw new W.Blocked(`contact "${who.name}" not found in ContactManager`);
  await row.getByText(who.name, { exact: false }).first().click();
  await cm.waitForTimeout(4500);
  await cm.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await cm.locator(EMAIL).waitFor({ timeout: 20000 }).catch(async () => { throw new W.Blocked('ContactManager person edit has no e-mail field; inputs: ' + (await cm.evaluate(() => [...document.querySelectorAll('input')].filter((i) => i.offsetParent).map((i) => i.name.replace(/^.*ContactDetailScreen-/, '')).join(','))).slice(-450)); });
}

async function applyEmail(page, who, value, label) {
  return withCM(page, async (cm) => {
    await openPersonEdit(cm, who);
    const [valEmail, valPhone] = String(value).split('|');
    const before = await cm.locator(EMAIL).inputValue();
    const beforePhone = await cm.locator(PHONE).inputValue().catch(() => '');
    const wantPhone = valPhone === undefined ? beforePhone : valPhone;
    if (before === valEmail && beforePhone === wantPhone) { await cm.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {}); return { before, changed: false }; }
    if (label) {
      const ledger = readLedger(); if (ledger.some((e) => e.kind === 'email' && e.who.name === who.name)) { /* keep the first original */ } else
      ledger.push({ kind: 'email', name: label, who, field: 'Main Email', original: before + '|' + beforePhone, changedAt: new Date().toISOString() });
      writeLedger(ledger); // recorded before the edit is saved
    }
    await setBoth(cm, EMAIL, PHONE, valEmail, wantPhone);
    await saveField(cm, valEmail, EMAIL);
    return { before: before + '|' + beforePhone, changed: true };
  });
}

// Test step: sets the person's Main Email (blank = '' ) in ContactManager. Reverted by restoreVendors.
async function setContactEmail(page, name, lastName, zip, email) {
  const r = await applyEmail(page, { name, lastName, zip }, email, name);
  return `${name}: Main Email ${r.before || '<blank>'} → ${email || '<blank>'}${r.changed ? '' : ' (already set)'}`;
}

// ── Company / Financial Institution (e.g. the ACNB BANK lienholder): Main Email + Business phone, found by Tax ID ──
const CO_EMAIL = 'input[name$="ContactBasicsDV-Email1"]';
const CO_PHONE = 'input[name$="ContactBasicsDV-BusinessPhone-GlobalPhoneInputSet-NationalSubscriberNumber"]';
async function applyCompany(page, taxId, value, label) {
  return withCM(page, async (cm) => {
    await openVendorEdit(cm, taxId);
    const [valEmail, valPhone] = String(value).split('|');
    const before = await cm.locator(CO_EMAIL).inputValue();
    const beforePhone = await cm.locator(CO_PHONE).inputValue().catch(() => '');
    const wantPhone = valPhone === undefined ? beforePhone : valPhone;
    if (before === valEmail && beforePhone === wantPhone) { await cm.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {}); return { before: before + '|' + beforePhone, changed: false }; }
    if (label) {
      const ledger = readLedger(); if (ledger.some((e) => e.kind === 'company' && e.taxId === taxId)) { /* keep the first original */ } else
      ledger.push({ kind: 'company', name: label, taxId, field: 'Main Email|Business phone', original: before + '|' + beforePhone, changedAt: new Date().toISOString() });
      writeLedger(ledger); // recorded before the edit is saved
    }
    await setBoth(cm, CO_EMAIL, CO_PHONE, valEmail, wantPhone);
    await saveField(cm, valEmail, CO_EMAIL);
    return { before: before + '|' + beforePhone, changed: true };
  });
}
// Test step: sets a company's Main Email and Business phone ('email|phone'). Reverted by restoreVendors.
async function setCompanyContact(page, name, taxId, value) {
  const r = await applyCompany(page, taxId, value, name);
  return `${name}: Main Email|Business phone ${r.before} → ${value}${r.changed ? '' : ' (already set)'}`;
}

// ── Company primary address (VBR.036: an Address Book payee's address change must reach its unsent checks) ──────────
// Address Book vendors are read-only in ClaimCenter ("This contact is linked to the Address Book and is in sync", no
// Edit button — CONFIRMED 2026-10-27 on BAIKOW LEGAL LLC), so the change is made here and reaches ClaimCenter through the
// Address Book sync. value = 'line1|line2|city|county|state code|zip' (the ledger keeps the original in the same form).
const ADDR_KEYS = ['AddressLine1', 'AddressLine2', 'City', 'County', 'State', 'PostalCode'];
const addrSel = (k) => `${k === 'State' ? 'select' : 'input'}[name$="PrimaryAddressInputSet-AddressOwnerInputSet-globalAddressContainer-GlobalAddressInputSet-${k}"]`;
async function readAddress(cm) {
  const v = [];
  for (const k of ADDR_KEYS) v.push(String(await cm.locator(addrSel(k)).first().inputValue().catch(() => '')).replace(/-#+$/, ''));
  return v.join('|');
}
async function applyAddress(page, taxId, value, label) {
  return withCM(page, async (cm) => {
    await openVendorEdit(cm, taxId);
    const before = await readAddress(cm);
    if (before === value) { await cm.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {}); return { before, changed: false }; }
    if (label) {
      const ledger = readLedger(); if (ledger.some((e) => e.kind === 'address' && e.taxId === taxId)) { /* keep the first original */ } else
      ledger.push({ kind: 'address', name: label, taxId, field: 'Primary Address', original: before, changedAt: new Date().toISOString() });
      writeLedger(ledger); // recorded before the edit is saved
    }
    const want = String(value).split('|');
    for (let i = 0; i < ADDR_KEYS.length; i++) {
      const k = ADDR_KEYS[i];
      const el = cm.locator(addrSel(k)).first();
      if (!await el.isVisible().catch(() => false)) continue;
      if (k === 'State') { await el.selectOption(want[i] || '').catch(() => {}); await cm.waitForTimeout(1500); continue; }
      // The ZIP box is masked ("18104-####") — type it key by key, like the phone numbers.
      if (k === 'PostalCode') { await typeInto(cm, addrSel(k), want[i] || ''); continue; }
      await el.fill(want[i] || ''); await el.press('Tab').catch(() => {}); await cm.waitForTimeout(600);
    }
    await cm.getByRole('button', { name: 'Update', exact: true }).first().click();
    await cm.getByRole('button', { name: 'Edit', exact: true }).first().waitFor({ timeout: 20000 }).catch(async () => {
      throw new W.Blocked('ContactManager did not save the address: ' + (await cm.locator('.gw-message, [class*=error], [role=alert]').allInnerTexts().catch(() => [])).join(' / ').replace(/\s+/g, ' ').slice(0, 300));
    });
    return { before, changed: true };
  });
}
// Test step: sets a vendor's primary address (found by Tax ID) — `which` is a setupE.ADDRESSES key ('A' | 'B') or an
// explicit 'line1|line2|city|county|state|zip'. Reverted by restoreVendors.
const CM_ADDRESSES = { A: '1103 Richmont St||Scranton|Lackawanna|PA|18509', B: '1195 River Rd||Marietta|Lancaster|PA|17547' };
async function setCompanyAddress(page, name, taxId, which = 'B') {
  const value = CM_ADDRESSES[which] || which;
  const r = await applyAddress(page, taxId, value, name);
  return `${name}: primary address ${r.before} → ${value}${r.changed ? '' : ' (already set)'}`;
}

async function restoreVendors(page) {
  const pending = readLedger();
  for (const e of pending) {
    if (e.kind === 'email') await applyEmail(page, e.who, e.original, null);
    else if (e.kind === 'company') await applyCompany(page, e.taxId, e.original, null);
    else if (e.kind === 'address') await applyAddress(page, e.taxId, e.original, null);
    else await applyDate(page, e.taxId, e.original, null);
    writeLedger(readLedger().filter((x) => x !== undefined && JSON.stringify(x) !== JSON.stringify(e)));
  }
  return pending.length ? `restored ${pending.map((e) => `${e.name} ${e.field}=${e.original || '<blank>'}`).join('; ')}` : 'nothing to restore';
}

// Test step: sets the vendor's Tax ID Valid Until to 'past' | 'future' | 'none' (or a date). Reverted by restoreVendors.
async function setTaxValidUntil(page, label, taxId, when) {
  if (readLedger().length) await restoreVendors(page); // settle leftovers from an interrupted run first
  const value = dateFor(when);
  const r = await applyDate(page, taxId, value, label);
  return `${label}: Tax ID Valid Until ${r.before || '<blank>'} → ${value || '<blank>'}${r.changed ? '' : ' (already set)'}`;
}

module.exports = { setContactEmail, setCompanyContact, setTaxValidUntil, setCompanyAddress, restoreVendors, readLedger, dateFor, withCM, CM_ADDRESSES };

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
