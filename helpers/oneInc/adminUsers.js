/**
 * helpers/oneInc/adminUsers.js — Administration › Users & Security › Users › <user> › Profile (Email / phones), done in a
 * SEPARATE browser context logged in as the Users admin (CC_ADMIN_USER / CC_ADMIN_PASS inline, e.g. su; never stored), so
 * the case's own page stays the standard user. User approval 2026-11-11 (CPD.002 payment approver cases).
 *
 * CONFIRMED 2026-11-11: the payment approver Keith Eisenhart (keiteise) has NO email and NO phone on his Profile.
 * Every change is written to a ledger on the share BEFORE it is saved and put back by restoreUsers (the cases' last check;
 * runOneInc calls it after a BLOCKED case too).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const W = require('./wizardDriver');
const { observe } = require('./checkOps');
const { readScreen, findField } = require('./screenReader');

const LEDGER = path.join(require('./reportService').RESULTS_DIR, 'TestData', `user-restore-${String(process.env.CC_TIER || 'test').toLowerCase()}.json`);
const readLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (_) { return []; } };
const writeLedger = (l) => { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); };

async function withAdmin(page, fn) {
  const ctx = await page.context().browser().newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  try {
    const base = require('../claimCenterBase');
    await base.loginToClaimCenter(p);
    await base.loginAsAdmin(p);
    return await fn(p);
  } finally { await ctx.close().catch(() => {}); }
}
async function openUserProfile(p, username) {
  await p.locator('[id="TabBar-AdminTab"]').first().click();
  await W.settle(p, 3000);
  const users = p.locator('[id="Admin-MenuLinks-Admin_UsersAndSecurity-UsersAndSecurity_AdminUserSearchPage"]').first();
  if (!await users.isVisible().catch(() => false)) throw new W.Blocked('this admin login has no Administration › Users (run with CC_ADMIN_USER = a Users admin, e.g. su)');
  await users.click();
  await W.settle(p, 3500);
  await W.fill(p, 'User name', username);
  await p.getByRole('button', { name: 'Search', exact: true }).last().click();
  await W.settle(p, 3500);
  const row = p.locator('tr', { hasText: username }).first();
  if (!await row.isVisible().catch(() => false)) throw new W.Blocked(`user ${username} not found`);
  await row.locator('a,[role=link],.gw-ActionValueWidget').first().click();
  await W.settle(p, 3500);
  await p.getByText('Profile', { exact: true }).first().click();
  await W.settle(p, 3000);
}
const FIELDS = ['Email', 'Primary Phone', 'Work', 'Mobile', 'Home'];
async function readContact(p) {
  const s = await readScreen(p);
  return Object.fromEntries(FIELDS.map((f) => [f, String((findField(s, f) || {}).value || '').trim()]));
}

// Observed "<username> email/phone" (read-only).
async function userContact(page, username) {
  const c = await withAdmin(page, async (p) => { await openUserProfile(p, username); return readContact(p); });
  return observe(page, `${username} email/phone`, FIELDS.map((f) => `${f}: ${c[f] || '(blank)'}`).join('; '));
}

// Sets the user's Profile Email (only; phones untouched). Ledger first.
async function setUserEmail(page, username, email) {
  if (!['test', 'dev'].includes(String(process.env.CC_TIER || 'test').toLowerCase())) throw new W.Blocked('user edits run on TEST/DEV only');
  return withAdmin(page, async (p) => {
    await openUserProfile(p, username);
    const before = (await readContact(p)).Email;
    if (before === email) return `${username}: Email already "${email || '(blank)'}"`;
    if (!readLedger().some((e) => e.username === username && e.field === 'Email')) writeLedger([...readLedger(), { username, field: 'Email', original: before, changedAt: new Date().toISOString() }]);
    await W.clickButton(p, 'Edit');
    await W.settle(p, 3000);
    await W.fill(p, 'Email', email);
    await W.clickButton(p, 'Update');
    await W.settle(p, 3500);
    if (await p.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
      const s = await readScreen(p);
      await W.clickButton(p, 'Cancel').catch(() => {});
      throw new W.Blocked(`user ${username} not saved: ${[...s.messages, s.south].join(' / ').slice(0, 300) || 'no message'}`);
    }
    return `${username}: Email "${before || '(blank)'}" → "${email || '(blank)'}"`;
  });
}

async function restoreUsers(page) {
  const pending = readLedger();
  for (const e of pending) {
    await setUserEmail(page, e.username, e.original);
    writeLedger(readLedger().filter((x) => !(x.username === e.username && x.field === e.field)));
  }
  return pending.length ? `restored ${pending.map((e) => `${e.username} ${e.field}=${e.original || '(blank)'}`).join('; ')}` : 'nothing to restore';
}

module.exports = { userContact, setUserEmail, restoreUsers, readLedger };
