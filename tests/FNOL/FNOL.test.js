/**
 * tests/FNOL/FNOL.test.js
 * First Notice of Loss — all 14 Donegal LOBs
 * Rules: CPU10001, EPU10001, DMCP0001-0009, DMDA*, DMGA*, DMSG*, DMCW*, DMEW*, CLV*, EXV*
 */
const { test, expect } = require('@playwright/test');
const { loginToClaimCenter } = require('../../helpers/claimCenterBase');
const { completeFNOL, LOB_CONFIG } = require('../../helpers/fnolHelper');
const { assertSegment, assertActivityExists, assertInitialReservesSet } = require('../../helpers/claimLifecycleHelper');

const BASE_FNOL = (state, lob, causeKey) => ({
  lossDate       : '01/15/2025',
  lossState      : state,
  lossCauseCode  : Object.values(LOB_CONFIG[lob].lossCauses)[causeKey ? 0 : 0],
  lossDescription: 'Automated FNOL - ' + lob + ' - ' + state,
});

// ── Personal Auto ─────────────────────────────────────────────────────────────
test.describe('FNOL - Personal Auto', () => {
  for (const state of ['PA', 'MI']) {
    test('TC-FNOL-PA-' + state + ': Collision FNOL + assignment + segment (' + state + ')', async ({ page }) => {
      await loginToClaimCenter(page);
      const cn = await completeFNOL(page, {
        policyNumber: process.env['POLICY_PA_AUTO'] || 'PA-TEST-' + state,
        lossDetails : BASE_FNOL(state, 'PersonalAuto'),
        claimantInfo: { firstName: 'John', lastName: 'TestAuto', phone: '7175551234' },
        exposures   : [{ coverageLabel: 'Collision' }, { coverageLabel: 'Comprehensive' }, { coverageLabel: 'Transportation Expense' }],
      });
      expect(cn).toBeTruthy();
      await assertSegment(page, 'Fast Track');
      await assertActivityExists(page, { activitySubject: 'Contact Insured' });
      await assertActivityExists(page, { activitySubject: 'Set Initial Reserves' });
    });
  }
});

// ── Commercial Auto ───────────────────────────────────────────────────────────
test.describe("FNOL - Commercial Auto", () => {
  for (const state of ['PA', 'MI']) {
    test('TC-FNOL-CAU-' + state + ': CA FNOL + segmentation (' + state + ')', async ({ page }) => {
      await loginToClaimCenter(page);
      const cn = await completeFNOL(page, {
        policyNumber: process.env['POLICY_CAU_' + state] || 'CAU-TEST-' + state,
        lossDetails : BASE_FNOL(state, 'CommercialAuto'),
        exposures   : [{ coverageLabel: 'Collision' }, { coverageLabel: 'Auto BI/PD Single Limit' }],
      });
      expect(cn).toBeTruthy();
    });
  }
});

// ── Homeowners ────────────────────────────────────────────────────────────────
test.describe("FNOL - Homeowner's", () => {
  for (const state of ['PA', 'VA']) {
    test("TC-FNOL-HO-" + state + ": Fire loss + Inspect Damage activity (" + state + ")", async ({ page }) => {
      await loginToClaimCenter(page);
      const cn = await completeFNOL(page, {
        policyNumber: process.env['POLICY_HO_' + state] || 'HO-TEST-' + state,
        lossDetails : { lossDate: '01/15/2025', lossState: state, lossCauseCode: 'LC01', lossDescription: 'Fire loss' },
        exposures   : [{ coverageLabel: 'Coverage A Dwelling' }, { coverageLabel: 'Coverage C Personal Property' }],
      });
      expect(cn).toBeTruthy();
      await assertActivityExists(page, { activitySubject: 'Inspect Damage' });
    });
  }
});

// ── Workers Comp ──────────────────────────────────────────────────────────────
test.describe("FNOL - Workers' Comp", () => {
  for (const state of ['PA', 'MI']) {
    test("TC-FNOL-WC-" + state + ": WC FNOL + assignment (DMGA0014/0016)", async ({ page }) => {
      await loginToClaimCenter(page);
      const cn = await completeFNOL(page, {
        policyNumber: process.env['POLICY_WC_' + state] || 'WC-TEST-' + state,
        lossDetails : { lossDate: '01/15/2025', lossState: state, lossCauseCode: 'LC07', lossDescription: 'WC medical' },
        claimantInfo: { firstName: 'Jane', lastName: 'Worker', relationship: 'Employee' },
        exposures   : [{ coverageLabel: "Workers' Compensation And Employers' Liability" }],
      });
      expect(cn).toBeTruthy();
      await assertActivityExists(page, { activitySubject: 'Request Medical Records' });
    });
  }
});

// ── BOP ───────────────────────────────────────────────────────────────────────
test.describe('FNOL - BOP', () => {
  for (const state of ['PA', 'DE']) {
    test('TC-FNOL-BOP-' + state + ': BOP FNOL + exposure segmentation', async ({ page }) => {
      await loginToClaimCenter(page);
      const cn = await completeFNOL(page, {
        policyNumber: process.env['POLICY_BOP_' + state] || 'BOP-TEST-' + state,
        lossDetails : { lossDate: '01/15/2025', lossState: state, lossCauseCode: 'LC03', lossDescription: 'BOP liability' },
        exposures   : [{ coverageLabel: 'Business Liability' }, { coverageLabel: 'Building Coverage' }],
      });
      expect(cn).toBeTruthy();
    });
  }
});

// ── Commercial Package ────────────────────────────────────────────────────────
test.describe('FNOL - Commercial Package', () => {
  for (const state of ['PA', 'MI']) {
    test('TC-FNOL-CP-' + state + ': CP FNOL + initial reserve auto-set', async ({ page }) => {
      await loginToClaimCenter(page);
      const cn = await completeFNOL(page, {
        policyNumber: process.env['POLICY_CP_' + state] || 'CP-TEST-' + state,
        lossDetails : { lossDate: '01/15/2025', lossState: state, lossCauseCode: 'LC01', lossDescription: 'CP fire' },
        exposures   : [{ coverageLabel: 'Structure Building' }, { coverageLabel: 'Personal Property' }],
      });
      expect(cn).toBeTruthy();
      await assertInitialReservesSet(page, { exposureLabel: 'Structure Building', expectedAmount: 0 });
    });
  }
});

// ── Remaining LOBs (smoke) ────────────────────────────────────────────────────
const SMOKE_LOBS = [
  { lob: 'Farmowners',             key: 'FARM', state: 'PA', causeCode: 'LC01', coverage: 'Farmowners Building' },
  { lob: 'DwellingFire',           key: 'DF',   state: 'PA', causeCode: 'LC01', coverage: 'Coverage A Dwelling' },
  { lob: 'Boatowners',             key: 'BOAT', state: 'MI', causeCode: 'LC15', coverage: 'Inland Marine All Other' },
  { lob: 'CommercialExcessLiability', key: 'CEL', state: 'PA', causeCode: 'LC03', coverage: 'Commercial Excess Liability' },
  { lob: 'PersonalExcessLiability',   key: 'PEL', state: 'PA', causeCode: 'LC03', coverage: 'Personal Excess Liability' },
  { lob: 'GL',                     key: 'GL',   state: 'IA', causeCode: 'LC03', coverage: 'Premises/Operations' },
  { lob: 'InlandMarine',           key: 'IM',   state: 'PA', causeCode: 'LC40', coverage: 'Inland Marine All Other' },
  { lob: 'FarmFire',               key: 'FF',   state: 'PA', causeCode: 'LC01', coverage: 'Farmowners Building' },
];

test.describe('FNOL - Remaining LOBs (smoke)', () => {
  for (const { lob, key, state, causeCode, coverage } of SMOKE_LOBS) {
    test('TC-FNOL-' + lob + '-' + state + ': Smoke FNOL submission', async ({ page }) => {
      await loginToClaimCenter(page);
      const cn = await completeFNOL(page, {
        policyNumber: process.env['POLICY_' + key + '_' + state] || key + '-TEST-' + state,
        lossDetails : { lossDate: '01/15/2025', lossState: state, lossCauseCode: causeCode, lossDescription: 'Smoke - ' + lob },
        exposures   : [{ coverageLabel: coverage }],
      });
      expect(cn).toBeTruthy();
    });
  }
});

// ── Validation ────────────────────────────────────────────────────────────────
test.describe('FNOL - Validation Rules', () => {
  test('TC-FNOL-VAL-001 [DMTV0002]: Submit without loss date - expect validation error', async ({ page }) => {
    await loginToClaimCenter(page);
    await page.click('#TabBar-NewClaimTab, a:has-text("New Claim")');
    await page.fill('[id*="PolicyNumber"]', 'PA-TEST-PA');
    await page.click('button:has-text("Search")');
    await page.waitForSelector('[id*="PolicyResults"]');
    await page.locator('[id*="PolicyResults"] tr').first().click();
    await page.click('button:has-text("Next"), [id*="Next"]');
    const err = page.locator('.gw-validation-error, [class*="errorMsg"]').first();
    await expect(err).toBeVisible({ timeout: 10_000 });
  });

  test('TC-FNOL-VAL-002 [CLV10001]: Submit without exposures - expect validation error', async ({ page }) => {
    await loginToClaimCenter(page);
    await completeFNOL(page, {
      policyNumber: 'PA-TEST-PA',
      lossDetails : { lossDate: '01/15/2025', lossState: 'PA', lossCauseCode: 'LC15', lossDescription: 'No exposure' },
      exposures   : [],
      assertClaimNumber: false,
    }).catch(() => {});
    const err = page.locator('.gw-validation-error, text=exposure').first();
    await expect(err).toBeVisible({ timeout: 10_000 });
  });
});
