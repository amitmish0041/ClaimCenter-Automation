/**
 * tests/lob/CP.e2e.test.js
 * Commercial Package — Full end-to-end lifecycle.
 *
 * Phase order (one login session, one claim):
 *   1. FNOL           – Structure Building + Personal Property
 *   2. Reserves       – $15k reserve (above DMAR0062 threshold for Level 1 approval)
 *   3. Payment        – $8k partial payment → routes to Level 1 approval queue (DMAR0062)
 *   4. Approval       – Approve from queue
 *   5. Lifecycle      – Complete activities → Close
 *
 * Run on-prem:  npm run e2e:cp
 * Run cloud:    npm run e2e:cloud:cp
 */
const { test, expect } = require('@playwright/test');
const {
  loginToClaimCenter, loginAsAdmin, openExistingClaim, getNextPolicy, getTestLossDate, getLossState,
} = require('../../helpers/claimCenterBase');
const { completeFNOL } = require('../../helpers/fnolHelper');
const {
  createReserve, createPayment,
  openExposuresTab, getAllExposureClaimants, findFirstPositiveReserveLine,
} = require('../../helpers/financialsHelper');
const {
  // approveLatestCheck is exported by claimLifecycleHelper, NOT
  // financialsHelper - importing it from there yielded undefined and would
  // have thrown "approveLatestCheck is not a function" at the approval phase.
  approveLatestCheck,
  assignClaim, createDocumentFromTemplate, validateAndRepairClaim,
  completeAllWorkplanActivities,
  // closeClaim/assertClaimStatus retained for when close runs against aged claims.
} = require('../../helpers/claimLifecycleHelper');
const { captureClaimSnapshot } = require('../../helpers/claimSnapshot');

test.setTimeout(1_800_000);

test.describe('Commercial Package — E2E', () => {
  test.describe.configure({ mode: 'serial' });

  let page;
  let claimNumber;
  let claimant;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await loginToClaimCenter(page);
  });

  test.afterAll(async () => { await page.close(); });

  // ── Phase 1: FNOL ──────────────────────────────────────────────────────────

  test('E2E-CP-001 [FNOL]: Complete CP FNOL — Structure Building + Personal Property', async () => {
    const policyNumber = getNextPolicy('POLICY_CP_PA', 'CP-E2E-001');
    claimNumber = await completeFNOL(page, {
      policyNumber,
      policyEnvVar : 'POLICY_CP_PA',
      // Explicit: the PolicyType dropdown lists EVERY policy type
      // (<none>, BOP, Commercial auto, Commercial Excess Liability,
      // Commercial Package, Dwelling Fire, Homeowner's, Personal auto,
      // Personal Excess Liability, Workers' comp), so without a request the
      // picker just takes the first loose match.
      policyType   : 'Commercial Package',
      lossDetails  : { lossDate: getTestLossDate(1, policyNumber), lossState: getLossState(policyNumber, 'PA'), lossCauseCode: 'LC01', lossDescription: 'E2E CP fire loss' },
      // Alternatives per user direction — CP coverage names differ per policy.
      exposures    : [
        { coverageLabel: ['Structure Building', 'Building', 'Structure'] },
        { coverageLabel: ['Personal Property', 'Business Personal Property', 'Contents'] },
      ],
    });
    expect(claimNumber, 'FNOL must return a claim number').toBeTruthy();
    console.log('E2E-CP-001: claim created —', claimNumber);
    // Paired-environment comparison: record what this environment produced so
    // scripts/compareEnvironments.js can diff on-prem against cloud.
    await captureClaimSnapshot(page, { lob: 'CP', claimNumber, testCase: 'E2E-CP-001' });

    // CC refuses to save a reserve while the claim is still "Pending
    // Assignment"; createPayment's "Link Document" step needs a document to
    // exist. Same pairing Financials.test.js does after its FNOL.
    await assignClaim(page);
    await createDocumentFromTemplate(page);
    // Run ClaimCenter's OWN "Validate Claim + Exposures" now that the exposures
    // exist, and repair whatever it reports, BEFORE any reserve or payment work.
    // An outstanding validation error makes the payment wizard offer NO reserve
    // lines at all - confirmed on PA-PA-01-26-0000387, which had a healthy
    // Collision line with $1,200 remaining yet an entirely empty "Reserve Line"
    // dropdown, and burned 6.6 minutes retrying a wizard that could never fill.
    const validation = await validateAndRepairClaim(page);
    if (validation.hasErrors) {
      test.info().annotations.push({
        type: 'claim-validation',
        description: validation.errors.slice(0, 6).join(' || '),
      });
      console.log('claim still has validation errors after repair —', validation.errors);
    }
  });

  // ── Phase 2: Reserves ──────────────────────────────────────────────────────

  test('E2E-CP-002 [DMIR0001]: Create $15,000 reserve', async () => {
    // createReserve returns a truthy block reason when CC refused the save.
    // Ignoring it made this test green with no reserve created. Only the known
    // same-day rule (VTDMPL61 — FNOL already created reserves today) is
    // tolerated; anything else is a real failure.
    const blocked = await createReserve(page, { reserveAmount: 15000, costType: 'CLPD', costCategory: 'ClaimCost' });
    if (blocked) {
      expect(blocked, 'unexpected reserve block').toMatch(/VTDMPL61/);
      console.log('E2E-CP-002: reserve refused by expected same-day rule —', blocked);
    }
  });

  // ── Phase 3: Payment ($8k triggers DMAR0062 Level 1 approval) ─────────────

  test('E2E-CP-003 [DMAR0062]: Create $8,000 partial payment — routes to Level 1 approval', async () => {
    await openExistingClaim(page, claimNumber);
    await openExposuresTab(page);
    const claimants = await getAllExposureClaimants(page);
    expect(claimants.length, 'Must have at least one exposure').toBeGreaterThan(0);
    claimant = claimants[0];
    // The payment wizard's "Reserve Line" dropdown lists RESERVE LINES
    // (coverage labels such as "Collision"), never claimant names. Passing the
    // claimant matched no option, and the "<none>" that resulted was then
    // misdiagnosed downstream as "the reserve has not propagated yet",
    // triggering three full wizard reloads before failing. Confirmed live:
    // reserveLine="SANFORD BARNWELL" failed on CA-OH-85-26-0000371 while the
    // claim had a perfectly good reserve line available the whole time.
    // findFirstPositiveReserveLine reads the Financials Summary and returns the
    // label of the first line with a positive balance - i.e. exactly what the
    // dropdown offers, and the same row closeExposureWithOutcome later targets.
    const line = await findFirstPositiveReserveLine(page);
    console.log('E2E-CP-003: claimant —', claimant, '| reserve line —', line.firstCell, '(remaining $' + line.amount + ')');
    await createPayment(page, {
      paymentAmount  : 8000,
      reserveLine    : line.firstCell,
      transactionType: 'Partial Payment',
    });
  });

  // ── Phase 4: Approval ──────────────────────────────────────────────────────

  test('E2E-CP-004 [DMAR0062]: Approve payment from Level 1 Approval Queue', async () => {
    await approveLatestCheck(page, claimNumber);
  });

  // ── Phase 5: Lifecycle — Close ─────────────────────────────────────────────

  test('E2E-CP-005: Complete all open workplan activities', async () => {
    // Per user direction, the lifecycle phase (activities, closing exposures,
    // closing claims) runs as the admin (su) account. The standard automation
    // user only has rights over work assigned to them, so once the claim is
    // assigned to another adjuster its workplan rows expose no Complete button.
    await loginAsAdmin(page);
    await openExistingClaim(page, claimNumber);
    await completeAllWorkplanActivities(page);
  });

  // Per user direction: the close-exposure / close-claim steps are skipped.
  // Closing an exposure makes CC modify that exposure's reserves, and same-day
  // exposure changes are not permitted in this environment. Confirmed live on
  // PA: DMEC0002 asks you to zero the open reserve, but zeroing IS a reserve
  // transaction, which VTDMPL61 (reserves) / DMTV0039 (recovery reserves) then
  // refuse on the claim's creation day. drainAndCloseAllExposures() in
  // claimLifecycleHelper implements the full working path for aged claims.
  test('E2E-CP-006: Close exposures, then close claim (Covered - Settled)', async () => {
    test.skip(true, 'Same-day exposure changes not allowed (VTDMPL61/DMTV0039/DMEC0002) — needs an aged claim');
  });
});
