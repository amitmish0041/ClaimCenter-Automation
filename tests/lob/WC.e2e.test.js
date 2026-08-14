/**
 * tests/lob/WC.e2e.test.js
 * Workers Compensation — Full end-to-end lifecycle.
 *
 * Phase order (one login session, one claim):
 *   1. FNOL           – WC & Employers' Liability exposure
 *   2. Workplan       – Request Medical Records activity
 *   3. Reserves       – $5k reserve
 *   4. Payment        – $2k partial payment → approval
 *   5. Approval       – Approve from queue
 *   6. Lifecycle      – Complete activities → Close
 *
 * NOTE: WC cost types in your CC configuration may differ from CLPD.
 *       If reserves fail, check available cost types in CC and update
 *       costType/costCategory below (common WC types: CLMD/Medical, CLLI/Indemnity).
 *
 * Run on-prem:  npm run e2e:wc
 * Run cloud:    npm run e2e:cloud:wc
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
  assertActivityExists,
  completeAllWorkplanActivities,
  // closeClaim/assertClaimStatus retained for when close runs against aged claims.
} = require('../../helpers/claimLifecycleHelper');
const { captureClaimSnapshot } = require('../../helpers/claimSnapshot');

test.setTimeout(1_800_000);

test.describe('Workers Comp — E2E', () => {
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

  test("E2E-WC-001 [FNOL]: Complete WC FNOL — Workers' Comp & Employers' Liability", async () => {
    const policyNumber = getNextPolicy('POLICY_WC_PA', 'WC-E2E-001');
    claimNumber = await completeFNOL(page, {
      policyNumber,
      policyEnvVar : 'POLICY_WC_PA',
      // Explicit: the PolicyType dropdown lists EVERY policy type
      // (<none>, BOP, Commercial auto, Commercial Excess Liability,
      // Commercial Package, Dwelling Fire, Homeowner's, Personal auto,
      // Personal Excess Liability, Workers' comp), so without a request the
      // picker just takes the first loose match.
      policyType   : "Workers' comp",
      lossDetails  : { lossDate: getTestLossDate(1, policyNumber), lossState: getLossState(policyNumber, 'PA'), lossCauseCode: 'LC07', lossDescription: 'E2E WC occupational injury' },
      exposures    : [{ coverageLabel: "Workers' Compensation And Employers' Liability" }],
    });
    expect(claimNumber, 'FNOL must return a claim number').toBeTruthy();
    console.log('E2E-WC-001: claim created —', claimNumber);
    // Paired-environment comparison: record what this environment produced so
    // scripts/compareEnvironments.js can diff on-prem against cloud.
    await captureClaimSnapshot(page, { lob: 'WC', claimNumber, testCase: 'E2E-WC-001' });

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

  // ── Phase 2: Workplan ──────────────────────────────────────────────────────

  test('E2E-WC-002 [DMCW0006]: FNOL creates Request Medical Records activity', async () => {
    // OPTIONAL per user direction: whether DMCW0006 fires depends on the
    // specific coverage, so its absence is not a failure. Still checked and
    // reported, so a genuine regression stays visible rather than being hidden
    // behind a blind skip. Observed absent on a claim whose WC exposure exists
    // (FNOL creates it directly), workplan holding only: NEW LOSS NOTICE |
    // REASSIGNED CLAIM | 3-point contact - Employer / Employee / Medical Provider.
    const found = await assertActivityExists(page, { activitySubject: 'Request Medical Records' })
      .then(() => true).catch(() => false);
    test.info().annotations.push({
      type: found ? 'DMCW0006-present' : 'DMCW0006-absent',
      description: found
        ? '"Request Medical Records" activity was created.'
        : '"Request Medical Records" not created — coverage-dependent, treated as optional.',
    });
    console.log('E2E-WC-002: "Request Medical Records" activity present? ' + found);
  });

  // ── Phase 3: Reserves ──────────────────────────────────────────────────────

  test('E2E-WC-003 [DMIR0001]: Create $5,000 reserve', async () => {
    // costType may need adjustment — check available WC reserve types in your CC config
    // createReserve returns a truthy block reason when CC refused the save.
    // Ignoring it made this test green with no reserve created. Only the known
    // same-day rule (VTDMPL61 — FNOL already created reserves today) is
    // tolerated; anything else is a real failure.
    const blocked = await createReserve(page, { reserveAmount: 5000, costType: 'CLPD', costCategory: 'ClaimCost' });
    if (blocked) {
      expect(blocked, 'unexpected reserve block').toMatch(/VTDMPL61/);
      console.log('E2E-WC-003: reserve refused by expected same-day rule —', blocked);
    }
  });

  // ── Phase 4: Payment ───────────────────────────────────────────────────────

  test('E2E-WC-004 [DMTA0012]: Create $2,000 partial payment — routes to approval', async () => {
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
    console.log('E2E-WC-004: claimant —', claimant, '| reserve line —', line.firstCell, '(remaining $' + line.amount + ')');
    await createPayment(page, {
      paymentAmount  : 2000,
      reserveLine    : line.firstCell,
      transactionType: 'Partial Payment',
    });
  });

  // ── Phase 5: Approval ──────────────────────────────────────────────────────

  test('E2E-WC-005: Approve payment from Approval Queue', async () => {
    await approveLatestCheck(page, claimNumber);
  });

  // ── Phase 6: Lifecycle — Close ─────────────────────────────────────────────

  test('E2E-WC-006: Complete all open workplan activities', async () => {
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
  test('E2E-WC-007: Close exposures, then close claim (Covered - Settled)', async () => {
    test.skip(true, 'Same-day exposure changes not allowed (VTDMPL61/DMTV0039/DMEC0002) — needs an aged claim');
  });
});
