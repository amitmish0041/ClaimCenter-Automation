/**
 * helpers/oneInc/adminRoles.js — Administration › Users & Security › Roles on ClaimCenter TEST, as the admin login that has
 * it (su — passed inline as CC_ADMIN_USER / CC_ADMIN_PASS, never stored; the default admin login has no Roles screen,
 * CONFIRMED 2026-11-11). User approval 2026-11-11 for the GCCM-791 permission cases.
 *
 * "Bulk Invoice Payer" holds "Create OneInc Bulk Invoice" (code useoneincbulkinvoice_ext) — CONFIRMED 2026-11-11.
 * Every permission removed is written to a ledger on the share BEFORE the role is saved and added back by restoreRoles
 * (the cases' last check; runOneInc calls it after a BLOCKED case too), so a role never stays changed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const W = require('./wizardDriver');
const { observe } = require('./checkOps');

const LEDGER = path.join(require('./reportService').RESULTS_DIR, 'TestData', `role-restore-${String(process.env.CC_TIER || 'test').toLowerCase()}.json`);
const readLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (_) { return []; } };
const writeLedger = (l) => { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); };
const testOnly = () => { if (!['test', 'dev'].includes(String(process.env.CC_TIER || 'test').toLowerCase())) throw new W.Blocked('role changes run on TEST/DEV only'); };

async function asAdmin(page) {
  if (page.__oneIncUser !== 'admin') {
    await require('../claimCenterBase').loginAsAdmin(page);
    page.__oneIncUser = 'admin';
  }
}
async function openRoles(page) {
  await asAdmin(page);
  await W.cancelWizard(page).catch(() => {});
  await page.locator('[id="TabBar-AdminTab"]').first().click();
  await W.settle(page, 3000);
  const roles = page.locator('[id="Admin-MenuLinks-Admin_UsersAndSecurity-UsersAndSecurity_Roles"]').first();
  if (!await roles.isVisible().catch(() => false)) throw new W.Blocked('this admin login has no Administration › Roles (run with CC_ADMIN_USER = a Roles admin, e.g. su)');
  await roles.click();
  await W.settle(page, 4000);
}
async function openRole(page, role) {
  await openRoles(page);
  const link = page.getByText(role, { exact: true }).first();
  if (!await link.isVisible().catch(() => false)) throw new W.Blocked(`role "${role}" is not on the Roles list`);
  await link.click();
  await W.settle(page, 4000);
}
async function permissionsOf(page) {
  return page.evaluate(() => [...document.querySelectorAll('[id*="RolePrivilegesLV-"][id$="-Permission"]')].map((e) => (e.innerText || e.value || '').trim()).filter(Boolean));
}

// Observed "<role> permissions" (the list as saved).
async function rolePermissions(page, role) {
  await openRole(page, role);
  return observe(page, `${role} permissions`, (await permissionsOf(page)).join(' | ') || '(none)');
}

// Roles › Add Role › permissions grid › Add: the new row's Permission dropdown options → observed "New Role permission options".
async function addRolePermissionOptions(page) {
  await openRoles(page);
  await W.clickButton(page, 'Add Role');
  await W.settle(page, 3500);
  await page.locator('[id$="RolePrivilegesLV_tb-Add"]').first().click();
  await W.settle(page, 2000);
  const sel = page.locator('select[name*="RolePrivilegesLV-"][name$="-Permission"]').last();
  const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => o.textContent.trim()).filter((t) => t && !/<none>/i.test(t))).catch(() => []);
  await W.clickButton(page, 'Cancel').catch(() => {});
  await W.settle(page, 2000);
  return observe(page, 'New Role permission options', `${opts.length} options: ${opts.join(' | ')}`);
}

async function saveRole(page, role) {
  await W.clickButton(page, 'Update');
  await W.settle(page, 4000);
  if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
    const s = await require('./screenReader').readScreen(page);
    await W.clickButton(page, 'Cancel').catch(() => {});
    throw new W.Blocked(`role "${role}" was not saved: ${[...s.messages, s.south].join(' / ').slice(0, 300) || 'no message'}`);
  }
}

// Removes `perm` from `role` (no-op when absent). Ledger first. In Edit mode the Permission cell is a dropdown, whose
// innerText is every option — read its selected option (2026-11-11, GCCM-791 TC-002/004 blocked on that).
async function removePermission(page, role, perm) {
  testOnly();
  await openRole(page, role);
  if (!(await permissionsOf(page)).includes(perm)) return `${role}: "${perm}" not on the role`;
  if (!readLedger().some((e) => e.role === role && e.perm === perm)) writeLedger([...readLedger(), { role, perm, removedAt: new Date().toISOString() }]);
  await W.clickButton(page, 'Edit');
  await W.settle(page, 3000);
  const i = await page.evaluate((p) => [...document.querySelectorAll('[id*="RolePrivilegesLV-"][id$="-Permission"]')].findIndex((e) => (() => { const sel = e.tagName === 'SELECT' ? e : e.querySelector('select'); if (sel) return (sel.selectedOptions[0] || {}).text || ''; return e.querySelector('input') ? e.querySelector('input').value : (e.innerText || e.value || ''); })().trim() === p), perm);
  if (i < 0) { await W.clickButton(page, 'Cancel').catch(() => {}); throw new W.Blocked(`"${perm}" row not found in Edit mode`); }
  const box = page.locator(`input[name$="RolePrivilegesLV-${i}-_Checkbox"]`).first();
  await box.evaluate((e) => { if (!e.checked) e.click(); });
  await W.clickButton(page, 'Remove');
  await W.settle(page, 1500);
  await saveRole(page, role);
  return `${role}: removed "${perm}"`;
}

// Adds `perm` to `role` through the UI (Edit › Add › Permission › Update). Clears its ledger entry once saved.
async function addPermission(page, role, perm) {
  testOnly();
  await openRole(page, role);
  if ((await permissionsOf(page)).includes(perm)) { writeLedger(readLedger().filter((e) => !(e.role === role && e.perm === perm))); return `${role}: "${perm}" already on the role`; }
  await W.clickButton(page, 'Edit');
  await W.settle(page, 3000);
  await page.locator('[id$="RolePrivilegesLV_tb-Add"]').first().click();
  await W.settle(page, 2000);
  const sel = page.locator('select[name*="RolePrivilegesLV-"][name$="-Permission"]').last();
  const o = (await sel.locator('option').evaluateAll((os) => os.map((x) => ({ v: x.value, t: x.textContent.trim() })))).find((x) => x.t === perm);
  if (!o) { await W.clickButton(page, 'Cancel').catch(() => {}); throw new W.Blocked(`"${perm}" is not offered in the Permission dropdown`); }
  await sel.selectOption(o.v);
  await W.settle(page, 1500);
  await saveRole(page, role);
  writeLedger(readLedger().filter((e) => !(e.role === role && e.perm === perm)));
  return `${role}: added "${perm}"`;
}

// Puts back every permission the ledger says was removed.
async function restoreRoles(page) {
  const pending = readLedger();
  for (const e of pending) await addPermission(page, e.role, e.perm);
  return pending.length ? `restored ${pending.map((e) => `${e.role} + "${e.perm}"`).join('; ')}` : 'nothing to restore';
}

// The standard TEST user's view (CC_USER), in a separate browser context so this admin session is untouched: Bulk Invoices ›
// Create New › Payment Method options → observed "Standard user: Bulk Invoice Payment Methods".
async function standardUserBulkInvoiceMethods(page) {
  const ctx = await page.context().browser().newContext({ viewport: { width: 1600, height: 1000 } });
  const p2 = await ctx.newPage();
  try {
    await require('../claimCenterBase').loginToClaimCenter(p2);
    await require('./bulkInvoice').newInvoicePaymentMethods(p2);
    const v = await p2.evaluate(() => { const e = document.getElementById('checkops-Bulk-Invoice-Payment-Methods'); return e ? e.querySelector('.gw-readonly').textContent : ''; });
    await require('./bulkInvoice').cancelInvoice(p2);
    return observe(page, 'Standard user: Bulk Invoice Payment Methods', v || '(none)');
  } finally { await ctx.close().catch(() => {}); }
}

module.exports = { rolePermissions, addRolePermissionOptions, removePermission, addPermission, restoreRoles, standardUserBulkInvoiceMethods, readLedger };
