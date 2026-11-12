/**
 * helpers/oneInc/bulkInvoice.js — Desktop › Bulk Invoices (GCCM-791). The standard TEST login (benjsmit) has the Bulk Invoices
 * desktop page; the admin login does not (CONFIRMED 2026-11-11). Create New opens "Bulk Invoice Details" whose Payment Method
 * radio offers check / oneinc_gc ("…PaymentMethodInputSet-PaymentMethod"). Read-only: the new invoice is cancelled.
 */
'use strict';

const W = require('./wizardDriver');
const { observe } = require('./checkOps');

// Opens a new Bulk Invoice and observes its Payment Method options as "Bulk Invoice Payment Methods".
async function newInvoicePaymentMethods(page) {
  await W.cancelWizard(page).catch(() => {});
  await page.locator('[id="TabBar-DesktopTab"]').first().click();
  await W.settle(page, 3000);
  const link = page.getByText('Bulk Invoices', { exact: true }).first();
  if (!await link.isVisible().catch(() => false)) throw new W.Blocked('this login has no Desktop › Bulk Invoices page');
  await link.click();
  await W.settle(page, 3500);
  const create = page.getByRole('button', { name: 'Create New', exact: true }).first();
  if (!await create.isVisible().catch(() => false)) throw new W.Blocked('Bulk Invoices has no "Create New" for this login');
  await create.click();
  await W.settle(page, 4000);
  const opts = await page.evaluate(() => [...document.querySelectorAll('input[type=radio]')].filter((r) => /PaymentMethodInputSet-PaymentMethod/.test(r.name))
    .map((r) => {
      const lab = (r.labels && r.labels[0] && r.labels[0].innerText.trim()) || (r.closest('div') ? r.closest('div').innerText.trim() : '');
      return `${lab || r.value} (${r.value})`;
    }));
  return observe(page, 'Bulk Invoice Payment Methods', opts.join(' | ') || '(none)');
}

// Leaves the new (unsaved) Bulk Invoice.
async function cancelInvoice(page) {
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
  await W.settle(page, 1500);
  return 'new bulk invoice cancelled';
}

// ── A pending bulk payment on this claim's exposure (VBR.099, GCCM-1013 VBR TC-101; user approval 2026-11-11) ────────
// A $1.00 Draft bulk invoice to the Address Book vendor BAIKOW LEGAL LLC with one item on the claim's open Claim Cost line.
// Every invoice made is written to a ledger on the share BEFORE it is saved and deleted again by deletePending (the
// case's last check; runOneInc also calls it after a BLOCKED case).
const fs = require('fs');
const path = require('path');
const LEDGER = path.join(require('./reportService').RESULTS_DIR, 'TestData', `bulk-invoices-${String(process.env.CC_TIER || 'test').toLowerCase()}.json`);
const readLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (_) { return []; } };
const writeLedger = (l) => { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); };

async function openList(page) {
  await W.cancelWizard(page).catch(() => {});
  await page.locator('[id="TabBar-DesktopTab"]').first().click();
  await W.settle(page, 3000);
  await page.getByText('Bulk Invoices', { exact: true }).first().click();
  await W.settle(page, 3500);
}

async function createPendingInvoice(page, { amount = '1.00', vendorTaxId = '02-0725566' } = {}) {
  if (!['test', 'dev'].includes(String(process.env.CC_TIER || 'test').toLowerCase())) throw new W.Blocked('bulk invoices are created on TEST/DEV only');
  const claim = await page.evaluate(() => ((document.body.innerText || '').match(/Claim:\s*([A-Z]{2,4}-[A-Z]{2}-[\d-]+)/) || [])[1] || '');
  if (!claim) throw new W.Blocked('no claim number on the screen');
  const inv = `OI${Date.now().toString().slice(-9)}`;
  await openList(page);
  await page.getByRole('button', { name: 'Create New', exact: true }).first().click();
  await W.settle(page, 4500);
  // Payee: Address Book vendor by Tax ID (fills Pay To / Recipient / Mailing Address).
  await page.locator('[id$="Payee-PayeeMenuIcon"]').first().click();
  await page.waitForTimeout(1200);
  await page.getByRole('menuitem', { name: 'Search', exact: true }).last().click();
  await W.settle(page, 4000);
  await page.getByLabel('Tax ID', { exact: true }).last().fill(vendorTaxId);
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await W.settle(page, 4500);
  const row = page.locator('tr').filter({ has: page.getByRole('button', { name: 'Select', exact: true }) }).first();
  if (!await row.isVisible().catch(() => false)) throw new W.Blocked(`vendor Tax ID ${vendorTaxId} not found in the Address Book search`);
  await row.getByRole('button', { name: 'Select', exact: true }).first().click();
  await W.settle(page, 4000);
  await W.fill(page, 'Invoice #', inv);
  await W.fill(page, 'Total Amount', amount);
  await W.select(page, 'Default Cost Type', 'Claim Cost');
  await W.settle(page, 1500);
  await W.select(page, 'Default Cost Category', 'Other').catch(() => W.select(page, 'Default Cost Category', 1));
  await W.fill(page, 'Payment #', inv);
  await W.select(page, 'Approval Workflow', 1);
  // Required ("Missing required field \"Payment Type\"", 2026-11-11): Partial when offered, else the first option.
  await W.select(page, 'Payment Type', 'Partial').catch(() => W.select(page, 'Payment Type', 1)).catch(() => {});
  // Item: this claim, its first Claim Cost reserve line, the amount.
  await page.locator('[id$="BulkInvoiceItemsLV_tb-Add"]').first().click();
  await W.settle(page, 2500);
  const cn = page.locator('input[name$="BulkInvoiceItemsLV-0-BulkInvoiceItemsLV_ClaimNumber"]').first();
  await cn.fill(claim);
  await cn.press('Tab');
  await W.settle(page, 3000);
  const rl = page.locator('select[name$="BulkInvoiceItemsLV-0-BulkInvoiceItemsLV_ReserveLine"]').first();
  const opts = await rl.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));
  const line = opts.find((o) => /claim cost/i.test(o.t)) || opts.find((o) => o.v && !/<none>/i.test(o.t));
  if (!line) throw new W.Blocked(`bulk invoice item: claim ${claim} offers no reserve line (${opts.map((o) => o.t).join(', ')})`);
  await rl.selectOption(line.v);
  await W.settle(page, 2500);
  await page.locator('input[name$="BulkInvoiceItemsLV-0-BulkInvoiceItemsLV_Amount"]').first().fill(amount);
  await page.keyboard.press('Tab');
  await W.settle(page, 1500);
  const expo = await page.locator('select[name$="BulkInvoiceItemsLV-0-BulkInvoiceItemsLV_Exposure"]').first()
    .evaluate((x) => (x.options[x.selectedIndex] || {}).text || '').catch(() => '');
  writeLedger([...readLedger(), { invoice: inv, claim, amount, line: line.t, exposure: expo, createdAt: new Date().toISOString() }]); // before saving
  await W.clickButton(page, 'Update');
  await W.settle(page, 4500);
  if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
    const s = await require('./screenReader').readScreen(page);
    const why = [...s.messages, s.south].join(' / ').slice(0, 400);
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    writeLedger(readLedger().filter((e) => e.invoice !== inv));
    throw new W.Blocked(`the bulk invoice was not saved: ${why || 'no message'}`);
  }
  page.__bulkInvoice = { invoice: inv, exposure: expo, line: line.t };
  await W.openClaim(page, claim);
  return observe(page, 'Pending bulk invoice', `${inv} — $${amount} to BAIKOW LEGAL LLC, item on ${claim} line "${line.t}" (exposure ${expo || '?'})`);
}

// Deletes every bulk invoice in the ledger (Bulk Invoices list › its row › Delete); kept in the ledger if it cannot be.
async function deletePending(page) {
  const pending = readLedger();
  if (!pending.length) return 'no bulk invoice to delete';
  const claim = await page.evaluate(() => ((document.body.innerText || '').match(/Claim:\s*([A-Z]{2,4}-[A-Z]{2}-[\d-]+)/) || [])[1] || '').catch(() => '');
  const done = [];
  for (const e of pending) {
    await openList(page);
    const r = page.locator('tr', { hasText: e.invoice }).first();
    if (!await r.isVisible().catch(() => false)) { done.push(`${e.invoice} (not listed)`); writeLedger(readLedger().filter((x) => x.invoice !== e.invoice)); continue; }
    await r.getByRole('checkbox').first().click().catch(() => {});
    await W.clickButton(page, 'Delete');
    await W.settle(page, 2000);
    const ok = page.getByRole('button', { name: /^(OK|Yes)$/ }).first();
    if (await ok.isVisible().catch(() => false)) await ok.click();
    await W.settle(page, 3000);
    if (!await page.locator('tr', { hasText: e.invoice }).first().isVisible().catch(() => false)) {
      writeLedger(readLedger().filter((x) => x.invoice !== e.invoice));
      done.push(e.invoice);
    }
  }
  if (claim) await W.openClaim(page, claim).catch(() => {});
  return `deleted bulk invoice(s): ${done.join(', ') || 'none'}${readLedger().length ? ` — still in the ledger: ${readLedger().map((x) => x.invoice).join(', ')}` : ''}`;
}

module.exports = { newInvoicePaymentMethods, cancelInvoice, createPendingInvoice, deletePending, readLedger };
