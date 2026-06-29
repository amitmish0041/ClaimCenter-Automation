/**
 * helpers/financialsHelper.js
 * Reserves, Payments, Recovery, Bulk Invoice, Transaction Approval, Validation.
 */
const { selectDropdown, fillTextField, fillIntegerCommaField, fillDateField,
        clickSave, verifyTextVisible, verifyNoValidationErrors } = require('./claimCenterBase');

async function openFinancialsTab(page) {
  await page.click('[id*="FinancialsTab"], a:has-text("Financials")');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function createReserve(page, { exposureLabel, reserveAmount, costType, costCategory, note }) {
  await openFinancialsTab(page);
  await page.click('[id*="ReservesTab"], a:has-text("Reserves")');
  await page.click('button:has-text("Edit"), [id*="Edit"]');
  if (exposureLabel) {
    const row = page.locator('tr:has-text("' + exposureLabel + '")').first();
    const id = await row.locator('input[id*="ReserveAmount"]').getAttribute('id').catch(() => null);
    if (id) await fillIntegerCommaField(page, '#' + id, reserveAmount);
  } else {
    await fillIntegerCommaField(page, '[id*="ReserveAmount"]', reserveAmount);
  }
  if (costType)     await selectDropdown(page, '[id*="CostType"]',     costType);
  if (costCategory) await selectDropdown(page, '[id*="CostCategory"]', costCategory);
  if (note)         await fillTextField(page,  '[id*="Note"]',         note);
  await clickSave(page);
  await verifyNoValidationErrors(page);
}

async function createPayment(page, { payee, checkType = 'Draft', paymentAmount, costType, costCategory, sendTo, note }) {
  await openFinancialsTab(page);
  await page.click('[id*="PaymentsTab"], a:has-text("Payments")');
  await page.click('button:has-text("New Payment"), [id*="NewPayment"]');
  await page.waitForSelector('[id*="PaymentAmount"], [id*="CheckAmount"]', { timeout: 15_000 });
  if (payee) await fillTextField(page, '[id*="Payee"]', payee);
  await selectDropdown(page, '[id*="CheckType"]', checkType);
  await fillIntegerCommaField(page, '[id*="PaymentAmount"], [id*="CheckAmount"]', paymentAmount);
  if (costType)     await selectDropdown(page, '[id*="CostType"]',     costType);
  if (costCategory) await selectDropdown(page, '[id*="CostCategory"]', costCategory);
  if (sendTo)       await selectDropdown(page, '[id*="SendTo"]',       sendTo);
  if (note)         await fillTextField(page,  '[id*="Note"]',         note);
  await clickSave(page);
  await verifyNoValidationErrors(page);
}

async function createRecoveryReserve(page, { recoveryType, reserveAmount }) {
  await openFinancialsTab(page);
  await page.click('[id*="RecoveryTab"], a:has-text("Recovery")');
  await page.click('button:has-text("New Recovery Reserve"), [id*="NewRecoveryReserve"]');
  await selectDropdown(page, '[id*="RecoveryType"]', recoveryType);
  await fillIntegerCommaField(page, '[id*="ReserveAmount"]', reserveAmount);
  await clickSave(page);
  await verifyNoValidationErrors(page);
}

async function createRecoveryReceipt(page, { recoveryType, receiptAmount, receivedDate }) {
  await openFinancialsTab(page);
  await page.click('[id*="RecoveryTab"], a:has-text("Recovery")');
  await page.click('button:has-text("New Recovery"), [id*="NewRecovery"]');
  await selectDropdown(page, '[id*="RecoveryType"]', recoveryType);
  await fillIntegerCommaField(page, '[id*="Amount"]', receiptAmount);
  if (receivedDate) await fillDateField(page, '[id*="ReceivedDate"]', receivedDate);
  await clickSave(page);
  await verifyNoValidationErrors(page);
}

async function createBulkInvoice(page, { vendor, invoiceNumber, invoiceDate, lineItems = [] }) {
  await page.click('[id*="BulkInvoiceTab"], a:has-text("Bulk Invoice")');
  await page.click('button:has-text("New"), [id*="NewBulkInvoice"]');
  if (vendor)        await fillTextField(page, '[id*="Vendor"]',        vendor);
  if (invoiceNumber) await fillTextField(page, '[id*="InvoiceNumber"]', invoiceNumber);
  if (invoiceDate)   await fillDateField(page, '[id*="InvoiceDate"]',   invoiceDate);
  for (const item of lineItems) {
    await page.click('button:has-text("Add Line"), [id*="AddLine"]');
    await fillTextField(page, '[id*="ClaimNumber"]', item.claimNumber);
    await fillIntegerCommaField(page, '[id*="Amount"]', item.amount);
    if (item.costType) await selectDropdown(page, '[id*="CostType"]', item.costType);
  }
  await clickSave(page);
  await verifyNoValidationErrors(page);
}

async function approveTransaction(page, transactionId) {
  await openFinancialsTab(page);
  const row = page.locator('tr:has-text("' + transactionId + '")').first();
  await row.locator('button:has-text("Approve"), [id*="Approve"]').click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function denyTransaction(page, transactionId, reason) {
  await openFinancialsTab(page);
  const row = page.locator('tr:has-text("' + transactionId + '")').first();
  await row.locator('button:has-text("Deny"), [id*="Deny"]').click();
  if (reason) await fillTextField(page, '[id*="DenyReason"]', reason);
  await clickSave(page);
}

async function assertValidationError(page, expectedMessage) {
  await verifyTextVisible(page, expectedMessage);
}

module.exports = { openFinancialsTab, createReserve, createPayment, createRecoveryReserve, createRecoveryReceipt, createBulkInvoice, approveTransaction, denyTransaction, assertValidationError };
