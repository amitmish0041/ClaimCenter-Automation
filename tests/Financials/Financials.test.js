/**
 * tests/Financials/Financials.test.js
 * Rules: DMIR0001-6, DMTA0001-0050, BIA01000, DMBI0001/3, DMTV*, TXV*, VTDM*, DMTP*
 */
const { test, expect } = require('@playwright/test');
const { loginToClaimCenter, verifyTextVisible } = require('../../helpers/claimCenterBase');
const { completeFNOL } = require('../../helpers/fnolHelper');
const { createReserve, createPayment, createRecoveryReserve, createRecoveryReceipt, createBulkInvoice, denyTransaction, assertValidationError } = require('../../helpers/financialsHelper');

const BASE = {
  policyNumber: process.env.POLICY_PA_AUTO || 'PA-FIN-001',
  lossDetails : { lossDate: '01/15/2025', lossState: 'PA', lossCauseCode: 'LC15', lossDescription: 'Financials test' },
  exposures   : [{ coverageLabel: 'Collision' }, { coverageLabel: 'Comprehensive' }],
};

test.describe('Reserves', () => {
  test('TC-FIN-001 [DMIR0001]: Initial reserve auto-set on FNOL finish', async ({ page }) => {
    await loginToClaimCenter(page);
    const cn = await completeFNOL(page, BASE);
    expect(cn).toBeTruthy();
  });

  test('TC-FIN-002 [DMIR0002]: Manual reserve - Collision coverage', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createReserve(page, { reserveAmount: 5000, costType: 'CLPD', costCategory: 'ClaimCost' });
  });

  test('TC-FIN-003 [DMIR0003]: Reserve increase triggers approval (DMAR0069)', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createReserve(page, { reserveAmount: 5000,  costType: 'CLPD', costCategory: 'ClaimCost' });
    await createReserve(page, { reserveAmount: 30000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await verifyTextVisible(page, 'Pending Approval');
  });

  test('TC-FIN-004 [DMIR0004]: Recovery reserve creation', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createRecoveryReserve(page, { recoveryType: 'Subrogation', reserveAmount: 2000 });
    await verifyTextVisible(page, 'Recovery Reserve');
  });

  test('TC-FIN-005 [DMIR0005]: Zero-dollar reserve blocked', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createReserve(page, { reserveAmount: 0, costType: 'CLPD', costCategory: 'ClaimCost' });
    await assertValidationError(page, 'Reserve amount must be greater than zero');
  });

  test('TC-FIN-006 [DMIR0006]: Reserve below payments blocked', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createReserve(page,  { reserveAmount: 10000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await createPayment(page,  { paymentAmount: 5000,  costType: 'CLPD', costCategory: 'ClaimCost' });
    await createReserve(page,  { reserveAmount: 2000,  costType: 'CLPD', costCategory: 'ClaimCost' });
    await assertValidationError(page, 'Reserve cannot be less than paid amount');
  });
});

test.describe('Payments', () => {
  test('TC-FIN-010 [DMTA0001]: Draft payment - no approval needed', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createReserve(page,  { reserveAmount: 10000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await createPayment(page,  { paymentAmount: 500,   checkType: 'Draft', costType: 'CLPD', costCategory: 'ClaimCost' });
    await verifyTextVisible(page, 'Draft');
  });

  test('TC-FIN-011 [DMTA0002]: Payment exceeds reserve - validation error (DMTV0040)', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createReserve(page,  { reserveAmount: 1000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await createPayment(page,  { paymentAmount: 5000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await assertValidationError(page, 'Payment exceeds available reserve');
  });

  test('TC-FIN-012 [DMTA0004]: Final payment closes exposure (DMTP)', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createReserve(page,  { reserveAmount: 5000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await createPayment(page,  { paymentAmount: 5000, checkType: 'Final', costType: 'CLPD', costCategory: 'ClaimCost' });
    await verifyTextVisible(page, 'Closed');
  });

  test('TC-FIN-013 [DMTA0006]: Payment on closed claim blocked (DMTV0050)', async ({ page }) => {
    const { closeClaim } = require('../../helpers/claimLifecycleHelper');
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await closeClaim(page, { closeReason: 'Covered - Settled' });
    await createPayment(page, { paymentAmount: 500, costType: 'CLPD', costCategory: 'ClaimCost' }).catch(() => {});
    await assertValidationError(page, 'Cannot create payment on closed claim');
  });

  test('TC-FIN-014 [DMTA0007/0008]: Void payment workflow', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createReserve(page,  { reserveAmount: 5000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await createPayment(page,  { paymentAmount: 1000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await page.locator('button:has-text("Void"), a:has-text("Void")').first().click();
    await page.click('button:has-text("Confirm"), button:has-text("OK")');
    await verifyTextVisible(page, 'Void');
  });

  test('TC-FIN-015 [DMTA0012]: Payment above threshold goes to approval queue', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createReserve(page,  { reserveAmount: 50000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await createPayment(page,  { paymentAmount: 15000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await verifyTextVisible(page, 'Pending Approval');
  });
});

test.describe('Recovery', () => {
  test('TC-FIN-020 [DMTA0019]: Subrogation recovery receipt', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createRecoveryReserve(page,  { recoveryType: 'Subrogation', reserveAmount: 5000 });
    await createRecoveryReceipt(page,  { recoveryType: 'Subrogation', receiptAmount: 2500, receivedDate: '02/01/2025' });
    await verifyTextVisible(page, 'Recovery Receipt');
  });

  test('TC-FIN-021 [DMTA0020]: Salvage recovery receipt', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createRecoveryReserve(page,  { recoveryType: 'Salvage', reserveAmount: 3000 });
    await createRecoveryReceipt(page,  { recoveryType: 'Salvage', receiptAmount: 1500 });
    await verifyTextVisible(page, 'Recovery Receipt');
  });

  test('TC-FIN-022 [DMTA0021]: Recovery receipt exceeds reserve - validation', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createRecoveryReserve(page,  { recoveryType: 'Subrogation', reserveAmount: 1000 });
    await createRecoveryReceipt(page,  { recoveryType: 'Subrogation', receiptAmount: 5000 });
    await assertValidationError(page, 'Recovery receipt exceeds recovery reserve');
  });
});

test.describe('Bulk Invoice', () => {
  test('TC-FIN-030 [BIA01000]: Bulk invoice single line item', async ({ page }) => {
    await loginToClaimCenter(page);
    const cn = await completeFNOL(page, BASE);
    await createBulkInvoice(page, { vendor: 'Repair Vendor LLC', invoiceNumber: 'BIA-TC030', invoiceDate: '01/20/2025', lineItems: [{ claimNumber: cn, amount: 2000, costType: 'CLPD' }] });
    await verifyTextVisible(page, 'BIA-TC030');
  });

  test('TC-FIN-031 [DMBI0001]: Bulk invoice approval routing triggered', async ({ page }) => {
    await loginToClaimCenter(page);
    const cn = await completeFNOL(page, BASE);
    await createBulkInvoice(page, { vendor: 'Big Vendor Inc', invoiceNumber: 'BIA-TC031', invoiceDate: '01/20/2025', lineItems: [{ claimNumber: cn, amount: 25000, costType: 'CLPD' }] });
    await verifyTextVisible(page, 'Pending Approval');
  });
});

test.describe('Validation Rules', () => {
  test('TC-FIN-040 [DMTV0001]: Missing cost type - validation error', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createPayment(page, { paymentAmount: 500 });
    await assertValidationError(page, 'Cost type is required');
  });

  test('TC-FIN-043 [VTDM0024]: Negative payment amount blocked', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, BASE);
    await createPayment(page, { paymentAmount: -500, costType: 'CLPD', costCategory: 'ClaimCost' });
    await assertValidationError(page, 'Amount must be positive');
  });
});
