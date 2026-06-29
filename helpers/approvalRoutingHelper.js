/**
 * helpers/approvalRoutingHelper.js
 * DMAR approval queue verification, approve/deny flows.
 * Routing tree: DMAR0030→0040/0060-WC; DMAR0061→0062/0063/0070/0060-Prop;
 *               DMAR0073→0074-0077; DMAR0080→0081; NEC→DMAR0002/0007/GWAR0002
 * Disabled: DMAR0005, DMAR0006
 */
const { clickSave } = require('./claimCenterBase');

async function openApprovalQueue(page) {
  await page.click('[id*="MyWorkTab"], a:has-text("My Work")');
  await page.click('[id*="ApprovalsTab"], a:has-text("Approvals")').catch(async () => {
    await page.click('[id*="Approval"], a:has-text("Approval Queue")');
  });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function assertInApprovalQueue(page, { claimNumber, transactionType, approver }) {
  await openApprovalQueue(page);
  const row = page.locator('tr:has-text("' + claimNumber + '")').first();
  if (transactionType) await row.locator('td:has-text("' + transactionType + '")').waitFor({ state: 'visible', timeout: 15_000 });
  if (approver)        await row.locator('td:has-text("' + approver + '")').waitFor({ state: 'visible', timeout: 15_000 });
}

async function assertNotInApprovalQueue(page, claimNumber) {
  await openApprovalQueue(page);
  const count = await page.locator('tr:has-text("' + claimNumber + '")').count();
  if (count > 0) throw new Error('Claim ' + claimNumber + ' unexpectedly found in approval queue');
}

async function approveFromQueue(page, claimNumber) {
  await openApprovalQueue(page);
  const row = page.locator('tr:has-text("' + claimNumber + '")').first();
  await row.locator('button:has-text("Approve"), a:has-text("Approve")').click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function denyFromQueue(page, claimNumber, reason = 'Denied by automation') {
  await openApprovalQueue(page);
  const row = page.locator('tr:has-text("' + claimNumber + '")').first();
  await row.locator('button:has-text("Deny"), a:has-text("Deny")').click();
  await page.fill('[id*="DenyReason"]', reason);
  await clickSave(page);
}

const DMAR_RULES = {
  DMAR0001: 'No routing needed — below all thresholds',
  DMAR0002: 'Non-employee claim routing',
  DMAR0007: 'External medical repricing routing',
  DMAR0030: 'Initial payment threshold gate',
  DMAR0040: 'Non-WC payment routing Level 1',
  DMAR0060: 'WC payment routing',
  DMAR0061: 'Property/GL payment sub-routing gate',
  DMAR0062: 'Property payment Level 1 approver',
  DMAR0063: 'Property payment Level 2 approver',
  DMAR0069: 'Reserve change routing gate',
  DMAR0070: 'Reserve change Level 1 approver',
  DMAR0071: 'Reserve change Level 2 approver',
  DMAR0073: 'Large loss routing gate',
  DMAR0074: 'Large loss VP approval',
  DMAR0075: 'Large loss SVP approval',
  DMAR0076: 'Large loss EVP approval',
  DMAR0077: 'Large loss President approval',
  DMAR0080: 'Recovery routing gate',
  DMAR0081: 'Recovery adjuster supervisor',
  DMAR0082: 'Bulk invoice routing',
  DMAR0005: 'DISABLED',
  DMAR0006: 'DISABLED',
};

module.exports = { DMAR_RULES, openApprovalQueue, assertInApprovalQueue, assertNotInApprovalQueue, approveFromQueue, denyFromQueue };
