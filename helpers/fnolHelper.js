/**
 * helpers/fnolHelper.js
 * First Notice of Loss helper for all 14 Donegal LOBs.
 */
const { selectDropdown, fillTextField, fillDateField, clickSave,
        dismissNotification, pollForClaimNumber, IS_ON_PREM } = require('./claimCenterBase');

const LOB_CONFIG = {
  PersonalAuto:             { topStates: ['PA','MI'], topCoverages: ['Collision','Comprehensive','Transportation Expense','PD Liability','Auto BI'], lossCauses: { collision:'LC15', glass:'LC14', animal:'LC8A', theft:'LC13' } },
  CommercialAuto:           { topStates: ['PA','MI'], topCoverages: ['Auto BI/PD Single Limit','Collision','Comprehensive','Silver Series/MicPak'], lossCauses: { collision:'LC15', liability:'LC03' } },
  Homeowners:               { topStates: ['PA','VA'], topCoverages: ['Coverage A Dwelling','Coverage C Personal Property','Coverage B Other Structures'], lossCauses: { fire:'LC01', wind:'LC02', hail:'LC33', water:'LC35' } },
  WorkersComp:              { topStates: ['PA','MI'], topCoverages: ["Workers' Compensation And Employers' Liability"], lossCauses: { indemnity:'LC06', medical:'LC07' } },
  BOP:                      { topStates: ['PA','DE'], topCoverages: ['Business Liability','BOP Coverage Level','Building Coverage'], lossCauses: { liability:'LC03', property:'LC01' } },
  CommercialPackage:        { topStates: ['PA','MI'], topCoverages: ['Premises/Operations','Structure Building','Personal Property'], lossCauses: { liability:'LC03', fire:'LC01' } },
  Farmowners:               { topStates: ['PA','VA'], topCoverages: ['Farmowners Building','Contents','Liability'], lossCauses: { fire:'LC01', theft:'LC08' } },
  DwellingFire:             { topStates: ['PA','GA'], topCoverages: ['Coverage A Dwelling','Coverage L Premises Liability'], lossCauses: { fire:'LC01', wind:'LC02' } },
  Boatowners:               { topStates: ['MI','PA'], topCoverages: ['Inland Marine All Other','Towing Limit','Liability'], lossCauses: { collision:'LC15', theft:'LC13' } },
  CommercialExcessLiability:{ topStates: ['PA','MD'], topCoverages: ['Commercial Excess Liability'], lossCauses: { liability:'LC03' } },
  PersonalExcessLiability:  { topStates: ['PA','VA'], topCoverages: ['Personal Excess Liability'], lossCauses: { liability:'LC03' } },
  GL:                       { topStates: ['IA','IN'], topCoverages: ['Premises/Operations','Products/Completed Operations'], lossCauses: { liability:'LC03', advertising:'LC88' } },
  InlandMarine:             { topStates: ['PA','DE'], topCoverages: ['Inland Marine All Other'], lossCauses: { property:'LC40', theft:'LC08' } },
  FarmFire:                 { topStates: ['PA','VA'], topCoverages: ['Farmowners Building','Liability'], lossCauses: { fire:'LC01' } },
};

// ── Helper: select first non-none option from a <select> ─────────────────────
async function selectFirstOption(page, selector) {
  const el = page.locator(selector).first();
  if (!await el.isVisible({ timeout: 3000 }).catch(() => false)) return;
  const firstVal = await el.locator('option:not([value=""]):not([value="none"])').first()
    .getAttribute('value').catch(() => null);
  if (firstVal) {
    await el.selectOption(firstVal);
    console.log(selector + ' => ' + firstVal);
    await page.waitForTimeout(300);
  }
}

// ── clickNewClaimCloud ────────────────────────────────────────────────────────
async function clickNewClaimCloud(page) {
  // The dropdown only opens via the aria-hidden expand button (.gw-action--expand-button)
  // NOT via the [role="menuitem"] inner div (that switches to an already-open claim tab).
  const expandBtn = page.locator('#TabBar-ClaimTab .gw-action--expand-button').first();
  await expandBtn.waitFor({ state: 'attached', timeout: 10000 });
  await expandBtn.click({ force: true });
  console.log('Claim dropdown expand button clicked');

  const opened = await page.waitForFunction(() => {
    const sub = document.querySelector('#TabBar-ClaimTab .gw-subMenu');
    return sub && sub.getAttribute('aria-hidden') === 'false';
  }, { timeout: 5000 }).then(() => true).catch(() => false);

  if (!opened) {
    console.log('WARNING: Claim submenu still hidden, retrying expand...');
    await expandBtn.click({ force: true });
    await page.waitForFunction(() => {
      const sub = document.querySelector('#TabBar-ClaimTab .gw-subMenu');
      return sub && sub.getAttribute('aria-hidden') === 'false';
    }, { timeout: 5000 }).catch(() => {});
  }

  // New Claim is the first uniquely-identified item in the submenu
  const newClaimInner = page.locator('#TabBar-ClaimTab-ClaimTab_FNOLWizard [role="menuitem"]').first();
  await newClaimInner.waitFor({ state: 'attached', timeout: 5000 });
  await newClaimInner.click({ force: true });
  console.log('New Claim clicked');

  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});

  // Confirm we landed on Find Policy step (not an existing claim)
  await page.getByRole('textbox', { name: 'Policy #' }).waitFor({ state: 'visible', timeout: 15000 });
  console.log('Find Policy screen confirmed');
}

// ── searchPolicy ──────────────────────────────────────────────────────────────
async function searchPolicy(page, policyNumber, lossDate) {
  if (IS_ON_PREM) {
    await page.click('#NewClaimMenuItemSet-NewClaim, a[id*="NewClaim"]');
    await page.waitForSelector('#fnol-PolicyNumber, input[id*="PolicyNumber"]');
    await fillTextField(page, '#fnol-PolicyNumber', policyNumber);
    await page.click('button:has-text("Search"), input[value="Search"]');
    await page.waitForSelector('.gw-PolicySearchResultsLV, [id*="PolicyResults"]', { timeout: 20000 });
  } else {
    await clickNewClaimCloud(page);

    // Loss Date is required for search
    let lossDateField = page.getByRole('textbox', { name: /Loss Date/i });
    let lossDateVisible = await lossDateField.waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true).catch(() => false);
    if (!lossDateVisible) {
      lossDateField = page.getByPlaceholder('MM/DD/YYYY');
      await lossDateField.waitFor({ state: 'visible', timeout: 20000 });
    }
    await lossDateField.fill(lossDate);
    console.log('Loss Date filled: ' + lossDate);

    const policyField = page.getByRole('textbox', { name: 'Policy #' });
    await policyField.fill(policyNumber);
    console.log('Policy # filled: ' + policyNumber);

    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    console.log('Policy search submitted');
  }
}

// ── selectPolicyResult ────────────────────────────────────────────────────────
async function selectPolicyResult(page, rowIndex = 0) {
  // Target the policy number button by GW ID pattern
  const policyBtn = page.locator('[id*="PolicyResultLV-' + rowIndex + '-PolicyNumber_button"]').first();

  if (await policyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    const policyNum = await policyBtn.innerText().catch(() => '');
    await policyBtn.evaluate(el => el.click());
    console.log('Policy selected (row ' + rowIndex + '): ' + policyNum);
  } else {
    // Fallback: any policy number button
    const anyPolicyBtn = page.locator('[id*="PolicyResultLV"][id*="PolicyNumber_button"]').first();
    if (await anyPolicyBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      const policyNum = await anyPolicyBtn.innerText().catch(() => '');
      await anyPolicyBtn.evaluate(el => el.click());
      console.log('Policy selected (fallback): ' + policyNum);
    } else {
      // Last resort: row click
      const rows = page.locator('.gw-PolicySearchResultsLV tr.gw-row, [id*="PolicyResults"] tr');
      await rows.nth(rowIndex).click();
      console.log('Policy selected via row click');
    }
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
}

// ── fillBasicInfo (Step 2) ────────────────────────────────────────────────────
async function fillBasicInfo(page) {
  console.log('FNOL Step 2: Basic Info...');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);

  // How Reported — first non-none
  await selectFirstOption(page, '[id*="HowReported"], [id*="howReported"]');

  // Reported By Name — first non-none
  await selectFirstOption(page, '[id*="ReportedBy"][id*="Name"], [id*="reportedByName"]');

  // Relation to Insured — first non-none
  await selectFirstOption(page, '[id*="RelationToInsured"]:not([id*="MainContact"]), [id*="Relationship"]:not([id*="MainContact"])');

  // Mobile Phone
  const phoneField = page.locator('[id*="Phone"], [id*="phone"]').first();
  if (await phoneField.isVisible({ timeout: 3000 }).catch(() => false)) {
    await phoneField.fill('7175551234');
    console.log('Phone: 7175551234');
  }

  // Main Contact Name — first non-none
  await selectFirstOption(page, '[id*="MainContact"][id*="Name"]');

  // Main Contact Relation to Insured — first non-none
  await selectFirstOption(page, '[id*="MainContact"][id*="Relation"]');

  // Select first vehicle from right panel (checkboxes next to VIN# entries)
  const vehicleCheckboxes = page.locator('input[type="checkbox"]');
  const cbCount = await vehicleCheckboxes.count().catch(() => 0);
  if (cbCount > 0) {
    await vehicleCheckboxes.first().check({ force: true });
    console.log('First vehicle checkbox checked');
  } else {
    // Try clicking first VIN label
    const vinLabel = page.locator('text=/VIN#:/').first();
    if (await vinLabel.isVisible({ timeout: 2000 }).catch(() => false)) {
      await vinLabel.click({ force: true });
      console.log('First vehicle selected via VIN label');
    }
  }

  // Next → Step 3
  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForLoadState('domcontentloaded');
  console.log('Basic Info done → Step 3');
}

// ── fillLossDetailsCloud (Step 3) ─────────────────────────────────────────────
async function fillLossDetailsCloud(page, {
  lossState      = 'PA',
  lossCauseCode  = '',
  whatHappened   = 'Automated FNOL test submission.',
} = {}) {
  console.log('FNOL Step 3: Loss Details...');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);

  // Assignment Type — first non-none
  await selectFirstOption(page, '[id*="AssignmentType"]');

  // Coverage in Question — No
  const coverageNoLabel = page.locator('label').filter({ hasText: /^No$/ })
    .locator('xpath=preceding::*[contains(@id,"CoverageInQuestion")][1]/following::label[1]').first();
  // Simpler approach: find radio group for CoverageInQuestion and click No
  const coverageNoRadio = page.locator('[id*="CoverageInQuestion"]').getByLabel('No').first();
  if (await coverageNoRadio.isVisible({ timeout: 3000 }).catch(() => false)) {
    await coverageNoRadio.click({ force: true });
    console.log('Coverage in Question: No');
  } else {
    // Fallback: find any No radio near CoverageInQuestion
    const noRadios = page.locator('[id*="CoverageInQuestion"] [type="radio"][value="false"], [id*="CoverageInQuestion"] [type="radio"]').last();
    if (await noRadios.isVisible({ timeout: 2000 }).catch(() => false)) {
      await noRadios.click({ force: true });
      console.log('Coverage in Question: No (fallback)');
    }
  }

  // What Happened
  const whatHappenedField = page.locator('textarea[id*="Description"], textarea[id*="description"], [id*="WhatHappened"]').first();
  if (await whatHappenedField.isVisible({ timeout: 3000 }).catch(() => false)) {
    await whatHappenedField.fill(whatHappened);
    console.log('What Happened filled');
  }

  // Weather Related — No
  const weatherNoRadio = page.locator('[id*="WeatherRelated"]').getByLabel('No').first();
  if (await weatherNoRadio.isVisible({ timeout: 3000 }).catch(() => false)) {
    await weatherNoRadio.click({ force: true });
    console.log('Weather Related: No');
  }

  // Driver Type — first non-none
  await selectFirstOption(page, '[id*="DriverType"]');

  // Loss Location State
  const locationState = page.locator('[id*="LossLocation"][id*="State"], [id*="lossLocation"][id*="State"]').first();
  if (await locationState.isVisible({ timeout: 3000 }).catch(() => false)) {
    await locationState.selectOption(lossState);
    console.log('Loss Location State: ' + lossState);
    await page.waitForTimeout(500);
  }

  // Loss Location City
  const locationCity = page.locator('[id*="LossLocation"][id*="City"]').first();
  if (await locationCity.isVisible({ timeout: 3000 }).catch(() => false)) {
    await locationCity.fill('Philadelphia');
    console.log('Loss Location City: Philadelphia');
  }

  // Loss Location ZIP
  const locationZip = page.locator('[id*="LossLocation"][id*="Zip"]').first();
  if (await locationZip.isVisible({ timeout: 3000 }).catch(() => false)) {
    await locationZip.fill('19101');
    console.log('Loss Location ZIP: 19101');
  }

  // Jurisdiction — first non-none
  await selectFirstOption(page, '[id*="Jurisdiction"]');

  // Scroll down to Vehicles/People/Property section
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);

  // Add Vehicle
  const addVehicleBtn = page.getByRole('button', { name: 'Add Vehicle' });
  if (await addVehicleBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await addVehicleBtn.click();
    await page.waitForTimeout(1000);
    console.log('Add Vehicle clicked');

    // Select vehicle from incident popup — first non-none
    const vehicleSelect = page.locator('[id*="VehicleIncident"][id*="Vehicle"]').first();
    if (await vehicleSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      const firstVal = await vehicleSelect.locator('option:not([value=""]):not([value="none"])').first()
        .getAttribute('value').catch(() => null);
      if (firstVal) {
        await vehicleSelect.selectOption(firstVal);
        console.log('Vehicle incident selected: ' + firstVal);
      }
    }

    // Save vehicle incident if button appears
    const saveVehicleBtn = page.locator('button:has-text("Update"), button:has-text("OK"), button:has-text("Save")').first();
    if (await saveVehicleBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await saveVehicleBtn.click();
      await page.waitForTimeout(500);
      console.log('Vehicle incident saved');
    }
  }

  // Categorization — Weather, Cat Code, Special Claim Permission (all first non-none)
  await selectFirstOption(page, '[id*="Weather"]:not([id*="WeatherRelated"]):not([id*="weather_related"])');
  // Cat Code and Special Claim Permission — optional, skip if not visible

  // Next → Step 4 Parties Involved
  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForLoadState('domcontentloaded');
  console.log('Loss Details done → Step 4');
}

// ── fillLossDetails (on-prem legacy) ──────────────────────────────────────────
async function fillLossDetails(page, { lossDate, lossTime, lossState, lossCauseCode, lossDescription }) {
  await fillDateField(page, '[id*="LossDate"], #fnol-LossDate', lossDate);
  if (lossTime)        await fillTextField(page, '[id*="LossTime"]', lossTime);
  if (lossState)       await selectDropdown(page, '[id*="LossState"]', lossState);
  if (lossCauseCode)   await selectDropdown(page, '[id*="LossCause"]', lossCauseCode);
  if (lossDescription) await fillTextField(page, '[id*="Description"]', lossDescription);
}

// ── fillClaimantInfo ──────────────────────────────────────────────────────────
async function fillClaimantInfo(page, { firstName, lastName, phone, relationship }) {
  await fillTextField(page, '[id*="FirstName"]', firstName);
  await fillTextField(page, '[id*="LastName"]', lastName);
  if (phone)        await fillTextField(page, '[id*="Phone"]', phone);
  if (relationship) await selectDropdown(page, '[id*="Relationship"]', relationship);
}

// ── addExposure ───────────────────────────────────────────────────────────────
async function addExposure(page, { coverageLabel }) {
  await page.click('button:has-text("Add Exposure"), [id*="AddExposure"]');
  await page.waitForSelector('[id*="CoverageType"]', { timeout: 15000 });
  await selectDropdown(page, '[id*="CoverageType"]', coverageLabel);
  await clickSave(page);
}

// ── finishFNOL ────────────────────────────────────────────────────────────────
async function finishFNOL(page) {
  const finishBtn = page.locator('button:has-text("Finish"), #Finish').first();
  await finishBtn.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await dismissNotification(page);
}

// ── completeFNOL ──────────────────────────────────────────────────────────────
async function completeFNOL(page, { policyNumber, lossDetails, claimantInfo, exposures = [], assertClaimNumber = true }) {
  // Step 1 — Find Policy
  await searchPolicy(page, policyNumber, lossDetails && lossDetails.lossDate);
  await selectPolicyResult(page);

  // Step 2 — Basic Info
  await fillBasicInfo(page);

  // Step 3 — Loss Details
  await fillLossDetailsCloud(page, {
    lossState    : (lossDetails && lossDetails.lossState)    || 'PA',
    lossCauseCode: (lossDetails && lossDetails.lossCauseCode)|| '',
    whatHappened : (lossDetails && lossDetails.lossDescription) || 'Automated FNOL test submission.',
  });

  // Step 4 — Parties Involved (navigate through)
  await page.getByRole('button', { name: 'Next' }).click().catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  console.log('Parties Involved → Next');

  // Step 5 — Save & Assign Claim
  await finishFNOL(page);

  if (assertClaimNumber) return await pollForClaimNumber(page);
  return null;
}

module.exports = {
  LOB_CONFIG,
  clickNewClaimCloud,
  searchPolicy,
  selectPolicyResult,
  fillBasicInfo,
  fillLossDetailsCloud,
  fillLossDetails,
  fillClaimantInfo,
  addExposure,
  finishFNOL,
  completeFNOL,
};
