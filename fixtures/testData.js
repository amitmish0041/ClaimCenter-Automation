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

module.exports = { POLICIES, THRESHOLDS };
