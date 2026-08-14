/**
 * tests/lob/HO.e2e.test.js
 * Homeowners — Full end-to-end lifecycle.
 *
 * Phase order (one login session, one claim):
 *   1. FNOL           – Coverage A Dwelling + Coverage C Personal Property
 *   2. Workplan       – Inspect Damage activity
 *   3. Initial Reserves – $0 auto-set after FNOL (IRR01000 gate)
 *   4. Reserves       – $150k reserve → Complex segment
 *   5. Segmentation   – Assert Complex
 *   6. Payment        – $5k partial payment → approval
 *   7. Approval       – Approve from queue
 *   8. Lifecycle      – Complete activities → Close
 *
 * Run on-prem:  npm run e2e:ho
 * Run cloud:    npm run e2e:cloud:ho
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
  assertInitialReservesSet,
  assertActivityExists,
  completeAllWorkplanActivities,
  // closeClaim/assertClaimStatus retained for when close runs against aged claims.
} = require('../../helpers/claimLifecycleHelper');
const { captureClaimSnapshot } = require('../../helpers/claimSnapshot');

test.setTimeout(1_800_000);

test.describe('Homeowners — E2E', () => {
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

  test('E2E-HO-001 [FNOL]: Complete HO FNOL — Coverage A Dwelling + Coverage C', async () => {
    // Hoisted so the loss date can be pinned to THIS policy's term via
    // LOSSDATE_<policyNumber>; dev-tier policies are fixed/older and the
    // "yesterday" default falls outside their term.
    const policyNumber = getNextPolicy('POLICY_HO_PA', 'HO-E2E-001');
    claimNumber = await completeFNOL(page, {
      policyNumber,
      policyEnvVar : 'POLICY_HO_PA',
      // Explicit: the PolicyType dropdown lists EVERY policy type
      // (<none>, BOP, Commercial auto, Commercial Excess Liability,
      // Commercial Package, Dwelling Fire, Homeowner's, Personal auto,
      // Personal Excess Liability, Workers' comp), so without a request the
      // picker just takes the first loose match.
      policyType   : "Homeowner's",
      lossDetails  : { lossDate: getTestLossDate(1, policyNumber), lossState: getLossState(policyNumber, 'PA'), lossCauseCode: 'LC01', lossDescription: 'E2E HO fire loss' },
      // Alternatives per user direction — HO policies vary; Coverage B/E/F were
      // seen on policies lacking A/C.
      // 'Coverage D Loss of Use' added after the on-prem DEV policy 1001002540
      // turned out to offer only "Coverage C Personal Property | Coverage D
      // Loss of Use" at its location grouper — no Coverage A/B at all.
      exposures    : [
        { coverageLabel: ['Coverage A Dwelling', 'Coverage B Other Structures', 'Coverage D Loss of Use'] },
        { coverageLabel: ['Coverage C Personal Property', 'Coverage E - Personal Liability',
                          'Coverage F - Medical Payments To Others'] },
      ],
    });
    expect(claimNumber, 'FNOL must return a claim number').toBeTruthy();
    console.log('E2E-HO-001: claim created —', claimNumber);
    // Paired-environment comparison: record what this environment produced so
    // scripts/compareEnvironments.js can diff on-prem against cloud.
    await captureClaimSnapshot(page, { lob: 'HO', claimNumber, testCase: 'E2E-HO-001' });

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

  test('E2E-HO-002 [DMCW0005]: FNOL creates Inspect Damage activity', async () => {
    // OPTIONAL per user direction: whether DMCW0005 fires depends on the
    // specific coverage, so its absence is not a failure. Still checked, and
    // still reported, so a genuine regression is visible rather than skipped
    // blind - a hard skip would have hidden the rule breaking entirely.
    // Observed absent on a claim WITH a valid Coverage A Dwelling exposure,
    // whose workplan held only: NEW LOSS NOTICE | Supervisor Notification |
    // Make initial contact with insured | Initial 30 day diary | Supervisor Diary.
    const found = await assertActivityExists(page, { activitySubject: 'Inspect Damage' })
      .then(() => true).catch(() => false);
    test.info().annotations.push({
      type: found ? 'DMCW0005-present' : 'DMCW0005-absent',
      description: found
        ? '"Inspect Damage" activity was created.'
        : '"Inspect Damage" not created — coverage-dependent, treated as optional.',
    });
    console.log('E2E-HO-002: "Inspect Damage" activity present? ' + found);
  });

  // ── Phase 3: Initial Reserves (rule IRR01000 — gate fires on FNOL finish) ──

  test('E2E-HO-003 [IRR01000]: Initial reserve auto-set to $0 on Coverage A Dwelling', async () => {
    await assertInitialReservesSet(page, { exposureLabel: 'Coverage A Dwelling', expectedAmount: 0 });
  });

  // ── Phase 4: Reserves ──────────────────────────────────────────────────────

  test('E2E-HO-004 [DMIR0001]: Create $150,000 reserve on Coverage A Dwelling', async () => {
    // createReserve returns a truthy block reason when CC refused the save.
    // Ignoring it made this test green with no reserve created. Only the known
    // same-day rule (VTDMPL61 — FNOL already created reserves today) is
    // tolerated; anything else is a real failure.
    const blocked = await createReserve(page, { reserveAmount: 150000, costType: 'CLPD', costCategory: 'ClaimCost' });
    if (blocked) {
      expect(blocked, 'unexpected reserve block').toMatch(/VTDMPL61/);
      console.log('E2E-HO-004: reserve refused by expected same-day rule —', blocked);
    }
  });

  // ── Phase 5: Segmentation ──────────────────────────────────────────────────

  test('E2E-HO-005 [DMSG0003]: $150k reserve triggers Complex segment', async () => {
    test.skip(true, 'Segment assertion skipped in E2E — see ClaimLifecycle TC-SEG-003');
  });

  // ── Phase 6: Payment ───────────────────────────────────────────────────────

  test('E2E-HO-006 [DMTA0012]: Create $5,000 partial payment — routes to approval', async () => {
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
    console.log('E2E-HO-006: claimant —', claimant, '| reserve line —', line.firstCell, '(remaining $' + line.amount + ')');
    await createPayment(page, {
      paymentAmount  : 5000,
      reserveLine    : line.firstCell,
      transactionType: 'Partial Payment',
    });
  });

  // ── Phase 7: Approval ──────────────────────────────────────────────────────

  test('E2E-HO-007: Approve payment from Approval Queue', async () => {
    await approveLatestCheck(page, claimNumber);
  });

  // ── Phase 8: Lifecycle — Close ─────────────────────────────────────────────

  test('E2E-HO-008: Complete all open workplan activities', async () => {
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
  test('E2E-HO-009: Close exposures, then close claim (Covered - Settled)', async () => {
    test.skip(true, 'Same-day exposure changes not allowed (VTDMPL61/DMTV0039/DMEC0002) — needs an aged claim');
  });
});
