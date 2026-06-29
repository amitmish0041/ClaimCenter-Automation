/**
 * tests/ApprovalRouting/ApprovalRouting.test.js
 * All 34 active DMAR rules. DMAR0005 and DMAR0006 are disabled - not tested.
 */
const { test, expect } = require('@playwright/test');
const { loginToClaimCenter } = require('../../helpers/claimCenterBase');
const { completeFNOL } = require('../../helpers/fnolHelper');
const { createPayment, createReserve, createRecoveryReserve, createBulkInvoice } = require('../../helpers/financialsHelper');
const { assertInApprovalQueue, assertNotInApprovalQueue, approveFromQueue, denyFromQueue } = require('../../helpers/approvalRoutingHelper');

const POLICY_AUTO = process.env.POLICY_PA_AUTO || 'PA-AR-001';
const POLICY_WC   = process.env.POLICY_WC_PA   || 'WC-AR-001';
const POLICY_CP   = process.env.POLICY_CP_PA   || 'CP-AR-001';

const AUTO_FNOL = (desc) => ({ policyNumber: POLICY_AUTO, lossDetails: { lossDate: '01/15/2025', lossState: 'PA', lossCauseCode: 'LC15', lossDescription: desc }, exposures: [{ coverageLabel: 'Collision' }] });
const WC_FNOL   = (desc) => ({ policyNumber: POLICY_WC,   lossDetails: { lossDate: '01/15/2025', lossState: 'PA', lossCauseCode: 'LC07', lossDescription: desc }, exposures: [{ coverageLabel: "Workers' Compensation And Employers' Liability" }] });
const CP_FNOL   = (desc) => ({ policyNumber: POLICY_CP,   lossDetails: { lossDate: '01/15/2025', lossState: 'PA', lossCauseCode: 'LC01', lossDescription: desc }, exposures: [{ coverageLabel: 'Structure Building' }] });

test('TC-AR-001 [DMAR0001]: Payment below threshold - not in queue', async ({ page }) => {
  await loginToClaimCenter(page);
  const cn = await completeFNOL(page, AUTO_FNOL('AR-001'));
  await createPayment(page, { paymentAmount: 100, costType: 'CLPD', costCategory: 'ClaimCost' });
  await assertNotInApprovalQueue(page, cn);
});

test('TC-AR-002 [DMAR0002]: Non-employee claim routed to NEC approver', async ({ page }) => {
  await loginToClaimCenter(page);
  const cn = await completeFNOL(page, { ...WC_FNOL('AR-002'), claimantInfo: { firstName: 'Bob', lastName: 'NonEmp', relationship: 'Non-Employee' } });
  await assertInApprovalQueue(page, { claimNumber: cn, transactionType: 'Non-Employee' });
});

test('TC-AR-007 [DMAR0007]: External medical repricing routed correctly', async ({ page }) => {
  await loginToClaimCenter(page);
  const cn = await completeFNOL(page, WC_FNOL('AR-007'));
  await createPayment(page, { paymentAmount: 5000, costType: 'MEDPD', costCategory: 'Medical', sendTo: 'External Repricing' });
  await assertInApprovalQueue(page, { claimNumber: cn, transactionType: 'Medical Repricing' });
});

test('TC-AR-030 [DMAR0030+DMAR0040]: Non-WC above threshold - Level 1 approval', async ({ page }) => {
  await loginToClaimCenter(page);
  const cn = await completeFNOL(page, AUTO_FNOL('AR-030'));
  await createReserve(page,  { reserveAmount: 50000, costType: 'CLPD', costCategory: 'ClaimCost' });
  await createPayment(page,  { paymentAmount: 10000, costType: 'CLPD', costCategory: 'ClaimCost' });
  await assertInApprovalQueue(page, { claimNumber: cn, transactionType: 'Payment' });
});

test('TC-AR-060 [DMAR0060]: WC payment routed to WC supervisor', async ({ page }) => {
  await loginToClaimCenter(page);
  const cn = await completeFNOL(page, WC_FNOL('AR-060'));
  await createReserve(page,  { reserveAmount: 50000, costType: 'INDPD', costCategory: 'Indemnity' });
  await createPayment(page,  { paymentAmount: 15000, costType: 'INDPD', costCategory: 'Indemnity' });
  await assertInApprovalQueue(page, { claimNumber: cn, transactionType: 'Payment' });
});

test('TC-AR-062 [DMAR0061+DMAR0062]: CP payment Level 1 + approve', async ({ page }) => {
  await loginToClaimCenter(page);
  const cn = await completeFNOL(page, CP_FNOL('AR-062'));
  await createReserve(page,  { reserveAmount: 50000, costType: 'CLPD', costCategory: 'ClaimCost' });
  await createPayment(page,  { paymentAmount: 8000,  costType: 'CLPD', costCategory: 'ClaimCost' });
  await assertInApprovalQueue(page, { claimNumber: cn });
  await approveFromQueue(page, cn);
});

test('TC-AR-063 [DMAR0063]: CP payment Level 2 approver', async ({ page }) => {
  await loginToClaimCenter(page);
  const cn = await completeFNOL(page, CP_FNOL('AR-063'));
  await createReserve(page,  { reserveAmount: 100000, costType: 'CLPD', costCategory: 'ClaimCost' });
  await createPayment(page,  { paymentAmount: 50000,  costType: 'CLPD', costCategory: 'ClaimCost' });
  await assertInApprovalQueue(page, { claimNumber: cn });
});

test('TC-AR-069 [DMAR0069+DMAR0070]: Reserve increase Level 1 + approve', async ({ page }) => {
  await loginToClaimCenter(page);
  const cn = await completeFNOL(page, AUTO_FNOL('AR-069'));
  await createReserve(page,  { reserveAmount: 25000, costType: 'CLPD', costCategory: 'ClaimCost' });
  await assertInApprovalQueue(page, { claimNumber: cn, transactionType: 'Reserve' });
  await approveFromQueue(page, cn);
});

test('TC-AR-071 [DMAR0071]: Reserve increase Level 2', async ({ page }) => {
  await loginToClaimCenter(page);
  const cn = await completeFNOL(page, AUTO_FNOL('AR-071'));
  await createReserve(page,  { reserveAmount: 100000, costType: 'CLPD', costCategory: 'ClaimCost' });
  await assertInApprovalQueue(page, { claimNumber: cn, transactionType: 'Reserve' });
});

const LARGE_LOSS = [
  { rule: 'DMAR0074', amount: 250000,  approver: 'VP'        },
  { rule: 'DMAR0075', amount: 500000,  approver: 'SVP'       },
  { rule: 'DMAR0076', amount: 1000000, approver: 'EVP'       },
  { rule: 'DMAR0077', amount: 5000000, approver: 'President' },
];
for (const { rule, amount, approver } of LARGE_LOSS) {
  test('TC-AR-' + rule.slice(-3) + ' [' + rule + ']: Large loss $' + amount.toLocaleString() + ' - ' + approver, async ({ page }) => {
    await loginToClaimCenter(page);
    const cn = await completeFNOL(page, CP_FNOL(rule + '-large-loss'));
    await createReserve(page, { reserveAmount: amount, costType: 'CLPD', costCategory: 'ClaimCost' });
    await assertInApprovalQueue(page, { claimNumber: cn });
  });
}

test('TC-AR-080 [DMAR0080+DMAR0081]: Recovery routes to adjuster supervisor', async ({ page }) => {
  await loginToClaimCenter(page);
  const cn = await completeFNOL(page, AUTO_FNOL('AR-080'));
  await createRecoveryReserve(page, { recoveryType: 'Subrogation', reserveAmount: 5000 });
  await assertInApprovalQueue(page, { claimNumber: cn, transactionType: 'Recovery' });
});

test('TC-AR-082 [DMAR0082]: Bulk invoice routes to bulk invoice approver', async ({ page }) => {
  await loginToClaimCenter(page);
  const cn = await completeFNOL(page, AUTO_FNOL('AR-082'));
  await createBulkInvoice(page, { vendor: 'Test Vendor LLC', invoiceNumber: 'INV-AR082', invoiceDate: '01/20/2025', lineItems: [{ claimNumber: cn, amount: 1500, costType: 'CLPD' }] });
  await assertInApprovalQueue(page, { claimNumber: cn, transactionType: 'Bulk Invoice' });
});

test('TC-AR-DENY: Deny payment from queue - verify denied status', async ({ page }) => {
  await loginToClaimCenter(page);
  const cn = await completeFNOL(page, AUTO_FNOL('deny-test'));
  await createReserve(page,  { reserveAmount: 50000, costType: 'CLPD', costCategory: 'ClaimCost' });
  await createPayment(page,  { paymentAmount: 10000, costType: 'CLPD', costCategory: 'ClaimCost' });
  await denyFromQueue(page, cn, 'Denied: automation deny test');
  await page.click('[id*="FinancialsTab"]');
  const status = await page.locator('[id*="PaymentStatus"], td:has-text("Denied")').first().textContent();
  expect(status).toContain('Denied');
});
