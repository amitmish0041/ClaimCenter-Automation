/**
 * helpers/oneInc/profiles/oneIncPortal.js — EXISTING TEST claims, one per Underwriting Company, for INT.001/002 (company name
 * and disclaimer in the OneInc payload, PM_Additional_Text_13/14). Each seed has a ClaimCenter payment already on the OneInc
 * staging portal whose Additional Text Field 13 names that company (portal search 2026-11-11, newest first); its Policy
 * screen's Underwriting Company was read the same day for the ones marked "read".
 */
'use strict';

const base = (label, seed) => ({ label, lob: 'ANY', state: 'ANY', prefix: /^[A-Z]{2,4}-/, poolOnly: true, seed });
module.exports = {
  UW_DMIC: base('Claim underwritten by Donegal Mutual Insurance Company', ['WC-DE-01-26-0748953', 'PA-PA-01-26-0747704', 'CA-IN-04-26-0748758']),
  UW_ASIC: base('Claim underwritten by Atlantic States Insurance Company', ['CA-IL-60-26-0749170', 'PA-PA-01-26-0749097', 'CPP-DE-01-25-0745771']),
  // read: PA-PA-01-26-0748662.
  UW_SICV: base('Claim underwritten by Southern Insurance Company of Virginia', ['PA-PA-01-26-0748998', 'PA-DE-01-26-0748386', 'PA-PA-01-26-0748662']),
  // read: CPR-IL-60-26-0747921 and PAR-NE-60-17-0640232 are Le Mars; no Le Mars TEST payment is on the portal yet, so the
  // Le Mars cases make one ($1.5x) and wait for it.
  UW_LEMARS: base('Claim underwritten by Le Mars Insurance Company', ['CPR-IL-60-26-0747921', 'PAR-NE-60-17-0640232']),
  UW_SMIC: base('Claim underwritten by Southern Mutual Insurance Company', ['DFP-GA-10-24-0743519']),
  // read: CA-MI-70-23-0742539.
  UW_MICH: base('Claim underwritten by Michigan Insurance Company', ['CA-MI-70-23-0742539']),
  UW_PIC: base('Claim underwritten by Peninsula Indemnity Company', ['WC-PA-01-26-0749192', 'WC-PA-01-26-0749156']),
  UW_TPIC: base('Claim underwritten by The Peninsula Insurance Company', ['WC-PA-85-26-0749162', 'CA-IN-85-26-0749114', 'CA-IN-85-26-0749113']),
  // read: CPP-AZ-90-26-0748071 / 0748070 show "Mountain States Indemnity" (no "Company") as the claim's Underwriting Company.
  UW_MSI: base('Claim underwritten by Mountain States Indemnity', ['WC-UT-90-25-0746427']),
};
