/**
 * fixtures/testData.js
 * Central policy number registry and test constants.
 * Set real policy numbers in .env before running.
 */
const POLICIES = {
  AUTO_PA : process.env.POLICY_PA_AUTO  || 'AUTO-PA-TEST',
  AUTO_MI : process.env.POLICY_MI_AUTO  || 'AUTO-MI-TEST',
  HO_PA   : process.env.POLICY_HO_PA   || 'HO-PA-TEST',
  HO_VA   : process.env.POLICY_HO_VA   || 'HO-VA-TEST',
  WC_PA   : process.env.POLICY_WC_PA   || 'WC-PA-TEST',
  WC_MI   : process.env.POLICY_WC_MI   || 'WC-MI-TEST',
  BOP_PA  : process.env.POLICY_BOP_PA  || 'BOP-PA-TEST',
  BOP_DE  : process.env.POLICY_BOP_DE  || 'BOP-DE-TEST',
  CP_PA   : process.env.POLICY_CP_PA   || 'CP-PA-TEST',
  CP_MI   : process.env.POLICY_CP_MI   || 'CP-MI-TEST',
  CAU_PA  : process.env.POLICY_CAU_PA  || 'CAU-PA-TEST',
  CAU_MI  : process.env.POLICY_CAU_MI  || 'CAU-MI-TEST',
  FARM_PA : process.env.POLICY_FARM_PA || 'FARM-PA-TEST',
  FARM_VA : process.env.POLICY_FARM_VA || 'FARM-VA-TEST',
  DF_PA   : process.env.POLICY_DF_PA   || 'DF-PA-TEST',
  DF_GA   : process.env.POLICY_DF_GA   || 'DF-GA-TEST',
  BOAT_MI : process.env.POLICY_BOAT_MI || 'BOAT-MI-TEST',
  BOAT_PA : process.env.POLICY_BOAT_PA || 'BOAT-PA-TEST',
  CEL_PA  : process.env.POLICY_CEL_PA  || 'CEL-PA-TEST',
  PEL_PA  : process.env.POLICY_PEL_PA  || 'PEL-PA-TEST',
  GL_IA   : process.env.POLICY_GL_IA   || 'GL-IA-TEST',
  IM_PA   : process.env.POLICY_IM_PA   || 'IM-PA-TEST',
  FF_PA   : process.env.POLICY_FF_PA   || 'FF-PA-TEST',
};

const THRESHOLDS = {
  DMAR0030_nonWC : 5000,
  DMAR0062_L1    : 10000,
  DMAR0063_L2    : 50000,
  DMAR0069_res   : 20000,
  DMAR0074_vp    : 250000,
  DMAR0075_svp   : 500000,
  DMAR0076_evp   : 1000000,
  DMAR0077_pres  : 5000000,
};

// Top coverages per LOB by real production exposure volume - source:
// CC_Prod_Coverage_Volume_by_LOB.xlsx (trailing 60 months, PolicyCenter
// sheet per LOB where present), ranked highest-volume first. Lets any LOB's
// test suite rotate through realistic, high-traffic coverages instead of
// guessing/always reusing the same one or two. NOTE: these are the raw
// production coverage-type names - a given on-prem test env's actual
// "Choose by Coverage" menu may use slightly different labels or not offer
// every one of these (confirmed for Personal Auto: the live menu only
// exposed 9 of these; verify against the real menu via a live dump before
// wiring a new LOB's rotation off this list rather than assuming a name
// here matches exactly).
const COVERAGE_VOLUME_BY_LOB = {
  'Personal auto': [
    'Comprehensive', 'Collision', 'Transportation Expense',
    'Property Damage Liability', 'Liability - Auto bodily injury',
    'First Party Medical Expense Benefits', 'Medical Payments',
    'Uninsured Motorist - Property Damage', 'Uninsured Motorist Bodily Injury', 'PIP',
  ],
  'Commercial auto': [
    'Auto BI/PD Single Limit', 'Collision', 'Comprehensive',
    'Silver Series or MicPak', 'Garage Comprehensive', 'Medical Benefits',
    'Property Protection Insurance', 'Uninsured Motorist - Vehicle Level',
    'Mini-Tort', 'Garagekeepers Collision',
  ],
  "Homeowner's": [
    'Coverage A Dwelling', 'Coverage C Personal Property', 'Coverage B Other Structures',
    'Limited Loss Settlement for Roof Surfacing Windstorm or Hail Losses',
    'Coverage D Loss of Use', 'Limited Water Back-Up and Sump Discharge or Overflow',
    'Coverage E - Personal Liability', 'Service Line', 'Equipment Breakdown',
    'Scheduled Personal Property',
  ],
  "Workers' comp": [
    "Workers' Compensation And Employers' Liability Insurance Policy (Section 3B)",
  ],
  'Commercial Package': [
    'Premises/Operations', 'Structure Building', 'Products/Completed Operations',
    'Personal Property', 'Silver Series Property Coverage Enhancement',
    'Owned and Borrowed Contractors Tools and Equipment - Unscheduled',
    'Contractors Tools and Equipment - Scheduled', 'IM Contractor Silver Series',
    'Silver Series GL Coverage Enhancement', 'Systems Breakdown/Equipment Breakdown',
  ],
  BOP: [
    'Business Liability', 'BOP Coverage Level', 'Building Coverage',
    'Business Personal Property', 'Equipment Breakdown Protection',
    'Business Income Coverage', 'Garagekeepers Coverage',
    'Liability And Medical Expenses (Lessors Liability)',
    'Owned & Borrowed Contractors Tools & Equipment - Blanket Basis',
    'Contractors Tools & Equipment - Scheduled Basis',
  ],
  "Farmowner's": [
    'Farmowners, Building', 'Farmowners, Contents', 'Basic Farmowners Endorsement',
    'Farmowners Liability', 'Farmowners, Time Element',
    'Systems Breakdown/Equipment Breakdown', 'Inland Marine, All other',
    'Farmowners Medical Payments', 'Water Damage-Sewers, Drains and Sumps',
    'Farmowners, user defined',
  ],
  'Dwelling Fire': [
    'Coverage A Dwelling', 'Coverage B Other Structures', 'Coverage L - Premises Liability',
    'Coverage D - Fair Rental value/Coverage E - Additional Living Expense',
    'Coverage C Personal Property', 'Limited Water Back-Up and Sump Discharge or Overflow',
    'Building Items Condo Unit-Owner', 'Other Perils Coverage, Building',
    'Fire, Building', 'Extended Coverage, Building',
  ],
  'Commercial Excess Liability': ['Commercial Excess Liability'],
  "Boatowner's": [
    'Inland Marine, All Other', 'Inland Marine, All Other Towing Limit',
    'Inland Marine, All Other Liability',
  ],
  'Personal Excess Liability': ['Personal Excess Liability'],
};

module.exports = { POLICIES, THRESHOLDS, COVERAGE_VOLUME_BY_LOB };
