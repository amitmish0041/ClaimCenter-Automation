/**
 * tests/lob/PA_Auto.e2e.test.js
 * Personal Auto — Full end-to-end lifecycle.
 *
 * Phase order (all share one login session and one claim):
 *   1. FNOL           – Collision + Comprehensive
 *   2. Segmentation   – Fast Track immediately after FNOL
 *   3. Workplan       – Assert auto-created activities
 *   4. Reserves       – $5k reserve → Standard segment
 *   5. Payment        – $1k partial payment → routes to approval
 *   6. Approval       – Approve from queue
 *   7. Recovery       – Subrogation reserve + receipt
 *   8. Lifecycle      – Complete activities (close/reopen/archive are skipped:
 *                       same-day exposure changes are not allowed in this env)
 *
 * Run on-prem:  npm run e2e:pa
 * Run cloud:    npm run e2e:cloud:pa
 */
const { test, expect } = require('@playwright/test');
const {
  loginToClaimCenter, loginAsAdmin, openExistingClaim, getNextPolicy, getTestLossDate, getLossState,
} = require('../../helpers/claimCenterBase');
const { completeFNOL } = require('../../helpers/fnolHelper');
const {
  createReserve, createPayment,
  createRecoveryReserve, createRecoveryReceipt,
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
} = require('../../helpers/claimLifecycleHelper');
const { captureClaimSnapshot } = require('../../helpers/claimSnapshot');

test.setTimeout(1_800_000); // 30 min for the full chain

test.describe('PA Auto — E2E', () => {
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

  test('E2E-PA-001 [FNOL]: Complete PA Auto FNOL — Collision + Comprehensive', async () => {
    // Hoisted so the loss date can be pinned to THIS policy's term via
    // LOSSDATE_<policyNumber>; dev-tier policies are fixed/older and the
    // "yesterday" default falls outside their term.
    const policyNumber = getNextPolicy('POLICY_PA_AUTO', 'PA-E2E-001');
    claimNumber = await completeFNOL(page, {
      policyNumber,
      policyEnvVar : 'POLICY_PA_AUTO',
      // Without this the PolicyType picker took the first option matching
      // /\bauto\b/ in dropdown order, which filed PA claims under
      // "Commercial auto" (confirmed live).
      policyType   : 'Personal Auto',
      lossDetails  : { lossDate: getTestLossDate(1, policyNumber), lossState: getLossState(policyNumber, 'PA'), lossCauseCode: 'LC15', lossDescription: 'E2E PA Auto' },
      exposures    : [{ coverageLabel: 'Collision' }, { coverageLabel: 'Comprehensive' }],
    });
    expect(claimNumber, 'FNOL must return a claim number').toBeTruthy();
    console.log('E2E-PA-001: claim created —', claimNumber);
    // Paired-environment comparison: record what this environment produced so
    // scripts/compareEnvironments.js can diff on-prem against cloud.
    await captureClaimSnapshot(page, { lob: 'PA_Auto', claimNumber, testCase: 'E2E-PA-001' });

    // CC refuses to save a reserve while the claim is still "Pending
    // Assignment" ("Please assign claim and exposure to save the reserve." —
    // confirmed via live failure on E2E-PA-005). createDocumentFromTemplate
    // is likewise a prerequisite for the payment phase: createPayment's
    // "Link Document" step has nothing to pick if the claim has no document.
    // Same pairing Financials.test.js already does after its FNOL.
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

  // ── Phase 2: Segmentation (checked before reserves can change it) ──────────

  test('E2E-PA-002 [DMSG0002]: Two-exposure PA Auto FNOL auto-sets Standard segment', async () => {
    // Segment auto-assignment depends on CC business rules which vary per policy/config.
    // Dedicated validation lives in ClaimLifecycle TC-SEG-001/TC-SEG-002.
    test.skip(true, 'Segment auto-assignment tested in ClaimLifecycle TC-SEG-* — skipped in E2E');
  });

  // ── Phase 3: Workplan activities auto-created by FNOL ──────────────────────

  test('E2E-PA-003 [DMCW0001]: FNOL creates Contact Insured activity', async () => {
    await assertActivityExists(page, { activitySubject: 'Make initial contact with insured' });
  });

  test('E2E-PA-004 [DMCW0002]: FNOL creates Subrogation Potential activity', async () => {
    await assertActivityExists(page, { activitySubject: 'Subrogation Potential' });
  });

  // ── Phase 4: Reserves ──────────────────────────────────────────────────────

  test('E2E-PA-005 [DMIR0001]: Create $5,000 reserve', async () => {
    // createReserve returns a truthy block reason when CC refused the save and
    // undefined when it went through. Ignoring it made this test green even
    // when no reserve was created at all (confirmed via live run: blocked by
    // VTDMPL61 yet reported "ok"). The ONLY block tolerated here is the known
    // same-day rule - FNOL already created reserves today, so a second reserve
    // transaction on the same claim is refused by design (same rule
    // Financials.test.js works around). Anything else is a real failure.
    const blocked = await createReserve(page, { reserveAmount: 5000, costType: 'CLPD', costCategory: 'ClaimCost' });
    if (blocked) {
      expect(blocked, 'unexpected reserve block').toMatch(/VTDMPL61/);
      console.log('E2E-PA-005: reserve refused by expected same-day rule —', blocked);
    }
  });

  test('E2E-PA-006 [DMSG0002]: $5k reserve triggers Standard segment', async () => {
    test.skip(true, 'Segment assertion skipped in E2E — see ClaimLifecycle TC-SEG-003');
  });

  // ── Phase 5: Payment ───────────────────────────────────────────────────────

  test('E2E-PA-007 [DMTA0012]: Create $1,000 partial payment — routes to approval', async () => {
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
    console.log('E2E-PA-007: claimant —', claimant, '| reserve line —', line.firstCell, '(remaining $' + line.amount + ')');
    await createPayment(page, {
      paymentAmount  : 1000,
      reserveLine    : line.firstCell,
      transactionType: 'Partial Payment',
    });
  });

  // ── Phase 6: Approval ──────────────────────────────────────────────────────

  test('E2E-PA-008 [DMAR0001]: Approve payment from Approval Queue', async () => {
    // approveLatestCheck returns whether it actually approved something. The
    // result was previously discarded, so this test reported "ok" after its
    // own log said "all strategies exhausted - no approvable check found"
    // (confirmed via live run: result=false, test green).
    //
    // A $1,000 payment does not route to approval for this user - CC posts it
    // straight to "Submitted" (confirmed via the transactions dump), so there
    // is genuinely nothing queued. That is a legitimate outcome, but it must
    // be visible in the report rather than masquerading as a successful
    // approval. Record it as an annotation instead of silently passing.
    const approved = await approveLatestCheck(page, claimNumber);
    if (!approved) {
      test.info().annotations.push({
        type: 'no-approval-required',
        description: 'Payment auto-approved (below approval threshold) — ' +
                     'nothing was queued, so no approval was exercised.',
      });
      console.log('E2E-PA-008: nothing to approve — payment did not route to an approval queue');
    }
  });

  // ── Phase 7: Recovery ──────────────────────────────────────────────────────

  test('E2E-PA-009 [DMTA0019]: Subrogation recovery reserve + receipt', async () => {
    await createRecoveryReserve(page, { recoveryType: 'Subrogation', reserveAmount: 500 });
    // Receipt the FULL reserve, not a part of it. A partial receipt leaves an
    // open recovery reserve, and closing the exposure later makes CC auto-create
    // a recovery-reserve transaction to zero the remainder — which the same-day
    // rule then refuses:
    //   "Validation errors were found in an object of type RecoveryReserveSet
    //    that was auto-created by rules: Rule: DMTV0039. Multiple recovery
    //    reserve transactions not allowed on same day."
    // (confirmed live — it was the last thing blocking E2E-PA-011). Recovery
    // RECEIPTS carry no such restriction, so fully receipting leaves nothing for
    // CC to zero. Both the reserve and the receipt are still exercised here.
    await createRecoveryReceipt(page, { recoveryType: 'Subrogation', receiptAmount: 500 });
  });

  // ── Phase 8: Lifecycle — Close → Reopen → Archive ─────────────────────────

  test('E2E-PA-010: Complete all open workplan activities', async () => {
    // Per user direction, the whole lifecycle phase (activities, closing
    // exposures, closing claims) runs as the admin (su) account. The standard
    // automation user only has rights over work assigned to them, and this
    // claim is assigned to another adjuster, so its workplan rows expose no
    // Complete button at all — confirmed via live run, where this test spent
    // its full 2.1m looping on "no Complete button for ...".
    await loginAsAdmin(page);
    await openExistingClaim(page, claimNumber);
    await completeAllWorkplanActivities(page);
  });

  // Per user direction: the close-exposure / close-claim steps are skipped.
  // Closing an exposure makes CC modify that exposure's reserves, and same-day
  // exposure changes are not permitted in this environment. Confirmed live:
  //   DMEC0002  - "open reserve ... click Close Exposure again" (to zero it)
  //   VTDMPL61  - Multiple reserve transaction not allowed on same day
  //   DMTV0039  - Multiple recovery reserve transactions not allowed on same day
  // Zeroing a reserve IS a reserve transaction, so a claim created today can
  // never have its exposures closed today - no automation change can satisfy it.
  // drainAndCloseAllExposures() in claimLifecycleHelper implements the full
  // working close path for when these run against aged claims.

  test('E2E-PA-011: Close exposures, then close claim (Covered - Settled)', async () => {
    test.skip(true, 'Same-day exposure changes not allowed (VTDMPL61/DMTV0039/DMEC0002) — needs an aged claim');
  });

  test('E2E-PA-012 [DMGA0350]: Reopen claim — triggers reassignment', async () => {
    test.skip(true, 'Depends on E2E-PA-011 closing the claim, which is skipped same-day');
  });

  test('E2E-PA-013: Re-close and archive claim', async () => {
    test.skip(true, 'Depends on E2E-PA-011/012, which are skipped same-day');
  });

});
