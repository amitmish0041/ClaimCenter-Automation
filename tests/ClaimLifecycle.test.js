/**
 * tests/ClaimLifecycle.test.js
 * Segmentation, InitialReserves, Workplan, Close, Reopen, Archive.
 *
 * Serial blocks share one login session + one claim per LOB group, eliminating
 * redundant FNOLs.  Tests that require a distinct claim setup remain standalone.
 *
 * Rules: DMSG*, CSG*, GWCS*, IRR*, DMIR*, DMCW*, DMEW*, DMCE*, DMAC*
 */
const { test, expect } = require('@playwright/test');
const { loginToClaimCenter, openExistingClaim, verifyTextVisible, getNextPolicy, getTestLossDate } = require('../helpers/claimCenterBase');
const { completeFNOL } = require('../helpers/fnolHelper');
const { createReserve, createPayment } = require('../helpers/financialsHelper');
const {
  assignClaim,
  assertSegment, setSegmentManually, assertInitialReservesSet,
  openWorkplanTab, assertActivityExists, createManualActivity, completeActivity,
  completeAllWorkplanActivities,
  closeClaim, assertClaimStatus, reopenClaim, archiveClaim,
} = require('../helpers/claimLifecycleHelper');

// ── PA Auto — Serial Lifecycle ─────────────────────────────────────────────────
// One login session and one PA Auto claim shared across all PA Auto tests.
// Order is load-bearing:
//   CL-002 must fire while activities are still open (before WP-010 completes them)
//   CL-004 must fire after completeAllWorkplanActivities clears all blockers
//   CL-001 closes the claim; RO-001 reopens it; ARC-001 closes + archives.
test.describe('PA Auto — Serial Lifecycle', () => {
  test.describe.configure({ mode: 'serial' });

  let page;
  let claimNumber;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await loginToClaimCenter(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('TC-SEG-001 [DMSG0001]: Auto collision - Fast Track', async () => {
    claimNumber = await completeFNOL(page, {
      policyNumber:  getNextPolicy('POLICY_PA_AUTO', 'PA-LC-001'),
      policyEnvVar:  'POLICY_PA_AUTO',
      lossDetails:   { lossDate: getTestLossDate(), lossState: 'PA', lossCauseCode: 'LC15', lossDescription: 'Lifecycle test' },
      exposures:     [{ coverageLabel: 'Collision' }],
    });
    // CC refuses to save a reserve while the claim is still "Pending
    // Assignment" ("Please assign claim and exposure to save the reserve.").
    // Confirmed on-prem: TC-IR-002 failed with exactly that message. Same
    // pairing the LOB E2E specs and Financials.test.js already do after FNOL.
    await assignClaim(page);
    // "Fast Track" OR "BI Claims Division". FNOL now creates an Injury Incident
    // on every LOB (it is required for bodily-injury exposures to be valid at
    // all - without it CC offers no reserve line and the whole payment/approval
    // chain is unreachable), and an injury legitimately routes the claim to the
    // BI Claims Division queue instead of Fast Track. Per user decision that
    // routing is acceptable/correct, so both outcomes pass; assertSegment logs
    // which one occurred so a future change in routing is still visible.
    const segment = await assertSegment(page, ['Fast Track', 'BI Claims Division']);
    test.info().annotations.push({ type: 'segment', description: segment });
  });

  test('TC-ARC-002: Archive option absent on open claim', async () => {
    // Open the Actions menu and confirm Archive is not present while claim is Open
    await page.locator('[id="Claim:ClaimMenuActions"]').click();
    await page.waitForTimeout(500);
    const archiveItem = page.locator('a:has-text("Archive Claim"), a:has-text("Archive"), [id*="ArchiveClaim"]');
    const visible = await archiveItem.isVisible().catch(() => false);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    expect(visible, 'Archive option should not appear on an Open claim').toBe(false);
  });

  test('TC-WP-001 [DMCW0001]: FNOL creates Contact Insured activity', async () => {
    await assertActivityExists(page, { activitySubject: 'Contact Insured' });
  });

  test('TC-WP-002 [DMCW0002]: FNOL creates Set Initial Reserves activity', async () => {
    await assertActivityExists(page, { activitySubject: 'Set Initial Reserves' });
  });

  // Activities are still open here — Close Claim should be blocked.
  test('TC-CL-002 [DMAC0037]: Close with open activities - blocked', async () => {
    await page.locator('[id="Claim:ClaimMenuActions"]').click();
    await page.click('a:has-text("Close Claim"), [id*="CloseClaim"]');
    await verifyTextVisible(page, 'open activities must be completed');
    // Dismiss and return to claim workspace
    await page.locator('.x-btn').filter({ hasText: 'Cancel', exact: true }).first()
      .click().catch(() => {});
    await page.waitForTimeout(500);
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await openExistingClaim(page, claimNumber).catch(() => {});
  });

  test('TC-WP-010 [DMCW0010]: Manual activity creation and completion', async () => {
    await createManualActivity(page, { subject: 'Follow Up with Insured', type: 'General', dueDate: '02/01/2025', note: 'TC-WP-010' });
    await assertActivityExists(page, { activitySubject: 'Follow Up with Insured' });
    await completeActivity(page, 'Follow Up with Insured');
    await verifyTextVisible(page, 'Completed');
  });

  test('TC-WP-EW-001 [DMEW0001]: Payment event creates follow-up activity', async () => {
    await createReserve(page,  { reserveAmount: 5000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await createPayment(page,  { paymentAmount: 1000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await openWorkplanTab(page);
    const activities = page.locator('[id*="ActivityLV"] tr.gw-row, [id*="WorkplanLV"] tr, [id*="Workplan"] tr');
    expect(await activities.count()).toBeGreaterThan(0);
  });

  test('TC-SEG-005: Manual segment override', async () => {
    await openExistingClaim(page, claimNumber);
    await setSegmentManually(page, 'Complex');
    await assertSegment(page, 'Complex');
  });

  // All activities must be clear so the Close Claim popup appears.
  // completeAllWorkplanActivities handles any remaining blockers.
  test('TC-CL-004: Close reason required - validation error', async () => {
    await openExistingClaim(page, claimNumber);
    await completeAllWorkplanActivities(page);
    await page.locator('[id="Claim:ClaimMenuActions"]').click();
    await page.click('a:has-text("Close Claim"), [id*="CloseClaim"]');
    // Wait for Close Claim popup to appear
    await page.waitForSelector(
      '[id*="CloseClaimPopup"], [id*="CloseClaimScreen"], [id*="CloseReason"]',
      { timeout: 10000 },
    );
    // Submit without filling close reason to trigger validation
    await page.locator('[id$="CloseClaimScreen:Update"]').first().click();
    await verifyTextVisible(page, 'Close reason is required');
    // Dismiss popup before proceeding
    await page.locator('.x-btn').filter({ hasText: 'Cancel', exact: true }).first()
      .click().catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  });

  test('TC-CL-001: Close with no open activities - success', async () => {
    await openExistingClaim(page, claimNumber);
    await closeClaim(page, { closeReason: 'Covered - Settled', closingNote: 'TC-CL-001' });
    await assertClaimStatus(page, 'Closed');
  });

  test('TC-RO-001: Reopen closed claim - triggers reassignment (DMGA0350)', async () => {
    await reopenClaim(page, { reopenReason: 'New information received' });
    await assertClaimStatus(page, 'Open');
  });

  test('TC-ARC-001: Archive closed claim', async () => {
    // Reopening may create new open activities — clear them before closing again.
    await completeAllWorkplanActivities(page);
    await closeClaim(page, { closeReason: 'Covered - Settled' });
    await archiveClaim(page);
    await assertClaimStatus(page, 'Archived');
  });
});

// ── HO PA — Serial Lifecycle ──────────────────────────────────────────────────
// One login session and one HO PA claim shared across workplan, initial-reserve,
// and segmentation tests.  IR-001 must run before SEG-003 sets a large reserve.
test.describe('HO PA — Serial Lifecycle', () => {
  test.describe.configure({ mode: 'serial' });

  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await loginToClaimCenter(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  // Creates the shared HO PA claim and asserts the Inspect Damage activity.
  test('TC-WP-005 [DMCW0005]: Property FNOL creates Inspect Damage activity', async () => {
    await completeFNOL(page, {
      policyNumber: getNextPolicy('POLICY_HO_PA', 'HO-LC-001'),
      policyEnvVar: 'POLICY_HO_PA',
      lossDetails:  { lossDate: getTestLossDate(), lossState: 'PA', lossCauseCode: 'LC01', lossDescription: 'HO lifecycle' },
      exposures:    [{ coverageLabel: 'Coverage A Dwelling' }, { coverageLabel: 'Coverage C Personal Property' }],
    });
    // CC refuses to save a reserve while the claim is still "Pending
    // Assignment" ("Please assign claim and exposure to save the reserve.").
    // Confirmed on-prem: TC-IR-002 failed with exactly that message. Same
    // pairing the LOB E2E specs and Financials.test.js already do after FNOL.
    await assignClaim(page);
    await assertActivityExists(page, { activitySubject: 'Inspect Damage' });
  });

  // Must run before SEG-003 inflates the reserve — expects FNOL auto-set of $0.
  test('TC-IR-001 [IRR01000]: Initial reserve gate fires on FNOL finish', async () => {
    await assertInitialReservesSet(page, { exposureLabel: 'Coverage A Dwelling', expectedAmount: 0 });
  });

  test('TC-SEG-003 [DMSG0003]: High reserve - Complex', async () => {
    await createReserve(page, { reserveAmount: 150000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await assertSegment(page, 'Complex');
  });
});

// ── Standalone tests — each runs its own FNOL ─────────────────────────────────

test.describe('Segmentation — Standalone', () => {
  test('TC-SEG-002 [DMSG0002]: Multiple exposures - Standard', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, {
      policyNumber: getNextPolicy('POLICY_PA_AUTO', 'PA-LC-001'),
      policyEnvVar: 'POLICY_PA_AUTO',
      lossDetails:  { lossDate: getTestLossDate(), lossState: 'PA', lossCauseCode: 'LC15', lossDescription: 'Multi-exposure test' },
      exposures:    [{ coverageLabel: 'Collision' }, { coverageLabel: 'Comprehensive' }, { coverageLabel: 'PD Liability' }, { coverageLabel: 'Auto BI' }],
    });
    // CC refuses to save a reserve while the claim is still "Pending
    // Assignment" ("Please assign claim and exposure to save the reserve.").
    // Confirmed on-prem: TC-IR-002 failed with exactly that message. Same
    // pairing the LOB E2E specs and Financials.test.js already do after FNOL.
    await assignClaim(page);
    await assertSegment(page, 'Standard');
  });

  test('TC-SEG-004 [CSG04000+GWCS0021]: Very high reserve - Large Loss', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, {
      policyNumber: getNextPolicy('POLICY_CP_PA', 'CP-LC-001'),
      policyEnvVar: 'POLICY_CP_PA',
      lossDetails:  { lossDate: getTestLossDate(), lossState: 'PA', lossCauseCode: 'LC01', lossDescription: 'CP lifecycle' },
      exposures:    [{ coverageLabel: 'Structure Building' }, { coverageLabel: 'Personal Property' }],
    });
    // CC refuses to save a reserve while the claim is still "Pending
    // Assignment" ("Please assign claim and exposure to save the reserve.").
    // Confirmed on-prem: TC-IR-002 failed with exactly that message. Same
    // pairing the LOB E2E specs and Financials.test.js already do after FNOL.
    await assignClaim(page);
    await createReserve(page, { reserveAmount: 500000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await assertSegment(page, 'Large Loss');
  });
});

test.describe('Initial Reserves — Standalone', () => {
  test('TC-IR-002 [DMIR0004]: Zero reserve blocked by parent gate', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, {
      policyNumber: getNextPolicy('POLICY_PA_AUTO', 'PA-LC-001'),
      policyEnvVar: 'POLICY_PA_AUTO',
      lossDetails:  { lossDate: getTestLossDate(), lossState: 'PA', lossCauseCode: 'LC15', lossDescription: 'Zero reserve test' },
      exposures:    [{ coverageLabel: 'Collision' }],
    });
    // CC refuses to save a reserve while the claim is still "Pending
    // Assignment" ("Please assign claim and exposure to save the reserve.").
    // Confirmed on-prem: TC-IR-002 failed with exactly that message. Same
    // pairing the LOB E2E specs and Financials.test.js already do after FNOL.
    await assignClaim(page);
    await createReserve(page, { reserveAmount: 0, costType: 'CLPD', costCategory: 'ClaimCost' });
    await verifyTextVisible(page, 'must be greater than zero');
  });
});

test.describe('Workplan — WC Standalone', () => {
  test('TC-WP-006 [DMCW0006]: WC FNOL creates Request Medical Records', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, {
      policyNumber: getNextPolicy('POLICY_WC_PA', 'WC-WP-001'),
      policyEnvVar: 'POLICY_WC_PA',
      lossDetails:  { lossDate: getTestLossDate(), lossState: 'PA', lossCauseCode: 'LC07', lossDescription: 'WC workplan' },
      exposures:    [{ coverageLabel: "Workers' Compensation And Employers' Liability" }],
    });
    // CC refuses to save a reserve while the claim is still "Pending
    // Assignment" ("Please assign claim and exposure to save the reserve.").
    // Confirmed on-prem: TC-IR-002 failed with exactly that message. Same
    // pairing the LOB E2E specs and Financials.test.js already do after FNOL.
    await assignClaim(page);
    await assertActivityExists(page, { activitySubject: 'Request Medical Records' });
  });
});

test.describe('Reopen — Standalone', () => {
  test('TC-RO-002: Reopen reason required', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, {
      policyNumber: getNextPolicy('POLICY_PA_AUTO', 'PA-LC-001'),
      policyEnvVar: 'POLICY_PA_AUTO',
      lossDetails:  { lossDate: getTestLossDate(), lossState: 'PA', lossCauseCode: 'LC15', lossDescription: 'Reopen test' },
      exposures:    [{ coverageLabel: 'Collision' }],
    });
    // CC refuses to save a reserve while the claim is still "Pending
    // Assignment" ("Please assign claim and exposure to save the reserve.").
    // Confirmed on-prem: TC-IR-002 failed with exactly that message. Same
    // pairing the LOB E2E specs and Financials.test.js already do after FNOL.
    await assignClaim(page);
    // Complete all open activities so closeClaim can proceed
    await completeAllWorkplanActivities(page);
    await closeClaim(page, { closeReason: 'No Coverage' });
    // Try to reopen without providing a reason
    await page.locator('[id="Claim:ClaimMenuActions"]').click();
    await page.click('a:has-text("Reopen"), [id*="Reopen"]');
    await page.waitForSelector('[id*="ReopenReason"]', { timeout: 15000 });
    await page.locator('[id$="Update"], button:has-text("Update"), button:has-text("OK")').first().click();
    await verifyTextVisible(page, 'Reopen reason is required');
  });
});
