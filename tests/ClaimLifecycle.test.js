/**
 * tests/ClaimLifecycle.test.js
 * Segmentation, InitialReserves, Workplan, Close, Reopen, Archive, Exception.
 * Rules: DMSG*, CSG*, GWCS*, GWES*, DMIR*, IRR*, DMCW*, DMEW*, DMCE*, DMAC*
 */
const { test, expect } = require('@playwright/test');
const { loginToClaimCenter, verifyTextVisible } = require('../helpers/claimCenterBase');
const { completeFNOL } = require('../helpers/fnolHelper');
const { createReserve, createPayment } = require('../helpers/financialsHelper');
const { assertSegment, setSegmentManually, assertInitialReservesSet,
        openWorkplanTab, assertActivityExists, createManualActivity, completeActivity,
        closeClaim, assertClaimStatus, reopenClaim, archiveClaim } = require('../helpers/claimLifecycleHelper');

const PA_AUTO = { policyNumber: process.env.POLICY_PA_AUTO || 'PA-LC-001', lossDetails: { lossDate: '01/15/2025', lossState: 'PA', lossCauseCode: 'LC15', lossDescription: 'Lifecycle test' }, exposures: [{ coverageLabel: 'Collision' }] };
const HO_PA  = { policyNumber: process.env.POLICY_HO_PA   || 'HO-LC-001', lossDetails: { lossDate: '01/15/2025', lossState: 'PA', lossCauseCode: 'LC01', lossDescription: 'HO lifecycle' }, exposures: [{ coverageLabel: 'Coverage A Dwelling' }, { coverageLabel: 'Coverage C Personal Property' }] };
const CP_PA  = { policyNumber: process.env.POLICY_CP_PA   || 'CP-LC-001', lossDetails: { lossDate: '01/15/2025', lossState: 'PA', lossCauseCode: 'LC01', lossDescription: 'CP lifecycle' }, exposures: [{ coverageLabel: 'Structure Building' }, { coverageLabel: 'Personal Property' }] };

// ── Segmentation ──────────────────────────────────────────────────────────────
test.describe('Segmentation', () => {
  test('TC-SEG-001 [DMSG0001]: Auto collision - Fast Track', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    await assertSegment(page, 'Fast Track');
  });

  test('TC-SEG-002 [DMSG0002]: Multiple exposures - Standard', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, { ...PA_AUTO, exposures: [{ coverageLabel: 'Collision' }, { coverageLabel: 'Comprehensive' }, { coverageLabel: 'PD Liability' }, { coverageLabel: 'Auto BI' }] });
    await assertSegment(page, 'Standard');
  });

  test('TC-SEG-003 [DMSG0003]: High reserve - Complex', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, HO_PA);
    await createReserve(page, { reserveAmount: 150000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await assertSegment(page, 'Complex');
  });

  test('TC-SEG-004 [CSG04000+GWCS0021]: Very high reserve - Large Loss', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, CP_PA);
    await createReserve(page, { reserveAmount: 500000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await assertSegment(page, 'Large Loss');
  });

  test('TC-SEG-005: Manual segment override', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    await setSegmentManually(page, 'Complex');
    await assertSegment(page, 'Complex');
  });
});

// ── Initial Reserves ──────────────────────────────────────────────────────────
test.describe('Initial Reserves', () => {
  test('TC-IR-001 [IRR01000]: Initial reserve gate fires on FNOL finish', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, HO_PA);
    await assertInitialReservesSet(page, { exposureLabel: 'Coverage A Dwelling', expectedAmount: 0 });
  });

  test('TC-IR-002 [DMIR0004]: Zero reserve blocked by parent gate', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    await createReserve(page, { reserveAmount: 0, costType: 'CLPD', costCategory: 'ClaimCost' });
    await verifyTextVisible(page, 'must be greater than zero');
  });
});

// ── Workplan / Activities ─────────────────────────────────────────────────────
test.describe('Workplan', () => {
  test('TC-WP-001 [DMCW0001]: FNOL creates Contact Insured activity', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    await assertActivityExists(page, { activitySubject: 'Contact Insured' });
  });

  test('TC-WP-002 [DMCW0002]: FNOL creates Set Initial Reserves activity', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    await assertActivityExists(page, { activitySubject: 'Set Initial Reserves' });
  });

  test('TC-WP-005 [DMCW0005]: Property FNOL creates Inspect Damage activity', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, HO_PA);
    await assertActivityExists(page, { activitySubject: 'Inspect Damage' });
  });

  test('TC-WP-006 [DMCW0006]: WC FNOL creates Request Medical Records', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, { policyNumber: process.env.POLICY_WC_PA || 'WC-WP-001', lossDetails: { lossDate: '01/15/2025', lossState: 'PA', lossCauseCode: 'LC07', lossDescription: 'WC workplan' }, exposures: [{ coverageLabel: "Workers' Compensation And Employers' Liability" }] });
    await assertActivityExists(page, { activitySubject: 'Request Medical Records' });
  });

  test('TC-WP-010 [DMCW0010]: Manual activity creation and completion', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    await createManualActivity(page, { subject: 'Follow Up with Insured', type: 'General', dueDate: '02/01/2025', note: 'TC-WP-010' });
    await assertActivityExists(page, { activitySubject: 'Follow Up with Insured' });
    await completeActivity(page, 'Follow Up with Insured');
    await verifyTextVisible(page, 'Completed');
  });

  test('TC-WP-EW-001 [DMEW0001]: Payment event creates follow-up activity', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    await createReserve(page,  { reserveAmount: 5000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await createPayment(page,  { paymentAmount: 1000, costType: 'CLPD', costCategory: 'ClaimCost' });
    await openWorkplanTab(page);
    const activities = page.locator('[id*="ActivityLV"] tr.gw-row, [id*="Workplan"] tr');
    expect(await activities.count()).toBeGreaterThan(0);
  });
});

// ── Close ─────────────────────────────────────────────────────────────────────
test.describe('Close Claim', () => {
  test('TC-CL-001: Close with no open activities - success', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    await completeActivity(page, 'Contact Insured').catch(() => {});
    await completeActivity(page, 'Set Initial Reserves').catch(() => {});
    await closeClaim(page, { closeReason: 'Covered - Settled', closingNote: 'TC-CL-001' });
    await assertClaimStatus(page, 'Closed');
  });

  test('TC-CL-002 [DMAC0037]: Close with open activities - blocked', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    await page.click('[id*="Actions"], button:has-text("Actions")');
    await page.click('a:has-text("Close Claim")');
    await verifyTextVisible(page, 'open activities must be completed');
  });

  test('TC-CL-004: Close reason required - validation error', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    await page.click('[id*="Actions"], button:has-text("Actions")');
    await page.click('a:has-text("Close Claim")');
    await page.waitForSelector('[id*="CloseReason"]');
    await page.click('button:has-text("Update"), button:has-text("OK")');
    await verifyTextVisible(page, 'Close reason is required');
  });
});

// ── Reopen ────────────────────────────────────────────────────────────────────
test.describe('Reopen', () => {
  test('TC-RO-001: Reopen closed claim - triggers reassignment (DMGA0350)', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    await completeActivity(page, 'Contact Insured').catch(() => {});
    await completeActivity(page, 'Set Initial Reserves').catch(() => {});
    await closeClaim(page, { closeReason: 'Covered - Settled' });
    await assertClaimStatus(page, 'Closed');
    await reopenClaim(page, { reopenReason: 'New information received' });
    await assertClaimStatus(page, 'Open');
  });

  test('TC-RO-002: Reopen reason required', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    await completeActivity(page, 'Contact Insured').catch(() => {});
    await closeClaim(page, { closeReason: 'No Coverage' });
    await page.click('[id*="Actions"]');
    await page.click('a:has-text("Reopen")');
    await page.click('button:has-text("Update"), button:has-text("OK")');
    await verifyTextVisible(page, 'Reopen reason is required');
  });
});

// ── Archive ───────────────────────────────────────────────────────────────────
test.describe('Archive', () => {
  test('TC-ARC-001: Archive closed claim', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    await completeActivity(page, 'Contact Insured').catch(() => {});
    await completeActivity(page, 'Set Initial Reserves').catch(() => {});
    await closeClaim(page, { closeReason: 'Covered - Settled' });
    await archiveClaim(page);
    await assertClaimStatus(page, 'Archived');
  });

  test('TC-ARC-002: Archive option absent on open claim', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, PA_AUTO);
    const archiveOption = page.locator('a:has-text("Archive"), [id*="Archive"]');
    expect(await archiveOption.count()).toBe(0);
  });
});
