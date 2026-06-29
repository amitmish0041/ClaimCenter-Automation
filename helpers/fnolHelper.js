/**
 * helpers/fnolHelper.js
 * First Notice of Loss helper for all 14 Donegal LOBs.
 */
const { selectDropdown, fillTextField, fillDateField, clickSave,
        dismissNotification, pollForClaimNumber } = require('./claimCenterBase');

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

async function searchPolicy(page, policyNumber) {
  await page.click('#NewClaimMenuItemSet-NewClaim, a[id*="NewClaim"]');
  await page.waitForSelector('#fnol-PolicyNumber, input[id*="PolicyNumber"]');
  await fillTextField(page, '#fnol-PolicyNumber', policyNumber);
  await page.click('button:has-text("Search"), input[value="Search"]');
  await page.waitForSelector('.gw-PolicySearchResultsLV, [id*="PolicyResults"]', { timeout: 20_000 });
}

async function selectPolicyResult(page, rowIndex = 0) {
  const rows = page.locator('.gw-PolicySearchResultsLV tr.gw-row, [id*="PolicyResults"] tr');
  await rows.nth(rowIndex).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function fillLossDetails(page, { lossDate, lossTime, lossState, lossCauseCode, lossDescription }) {
  await fillDateField(page, '[id*="LossDate"], #fnol-LossDate', lossDate);
  if (lossTime)        await fillTextField(page, '[id*="LossTime"]', lossTime);
  if (lossState)       await selectDropdown(page, '[id*="LossState"]', lossState);
  if (lossCauseCode)   await selectDropdown(page, '[id*="LossCause"]', lossCauseCode);
  if (lossDescription) await fillTextField(page, '[id*="Description"]', lossDescription);
}

async function fillClaimantInfo(page, { firstName, lastName, phone, relationship }) {
  await fillTextField(page, '[id*="FirstName"]', firstName);
  await fillTextField(page, '[id*="LastName"]', lastName);
  if (phone)        await fillTextField(page, '[id*="Phone"]', phone);
  if (relationship) await selectDropdown(page, '[id*="Relationship"]', relationship);
}

async function addExposure(page, { coverageLabel }) {
  await page.click('button:has-text("Add Exposure"), [id*="AddExposure"]');
  await page.waitForSelector('[id*="CoverageType"]', { timeout: 15_000 });
  await selectDropdown(page, '[id*="CoverageType"]', coverageLabel);
  await clickSave(page);
}

async function finishFNOL(page) {
  const finishBtn = page.locator('button:has-text("Finish"), #Finish').first();
  await finishBtn.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await dismissNotification(page);
}

async function completeFNOL(page, { policyNumber, lossDetails, claimantInfo, exposures = [], assertClaimNumber = true }) {
  await searchPolicy(page, policyNumber);
  await selectPolicyResult(page);
  await fillLossDetails(page, lossDetails);
  if (claimantInfo) await fillClaimantInfo(page, claimantInfo);
  await page.click('button:has-text("Next"), [id*="Next"]').catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  for (const exp of exposures) await addExposure(page, exp);
  await finishFNOL(page);
  if (assertClaimNumber) return await pollForClaimNumber(page);
  return null;
}

module.exports = { LOB_CONFIG, searchPolicy, selectPolicyResult, fillLossDetails, fillClaimantInfo, addExposure, finishFNOL, completeFNOL };
