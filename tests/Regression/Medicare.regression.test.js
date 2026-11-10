/**
 * tests/Regression/Medicare.regression.test.js — Regression Test Design V1.0, MSP Navigator - Medicare (TC038, TC039).
 * Exposure › Medicare tab facts are the ones oneInc/needsData.js confirmed on cloud TEST (2026-11-03).
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, A } = S;

S.hooks(test);

async function medicareTab(page) {
  await page.getByText('Medicare', { exact: true }).first().click();
  await W.settle(page, 2500);
  return S.readScreen(page);
}
const medicareEmpty = (s) => s.fields.filter((f) => /medicare|ICD|ORM|SSN|Date of Birth/i.test(f.label)).every((f) => !String(f.value || '').replace(/<none>/i, '').trim() || /SSN|Date of Birth/i.test(f.label));

test('RG-TC038 [MSP Navigator - Medicare]: Medicare tab on WC Medical and Auto PIP exposures', async ({ page }, ti) => S.blockable(test, async () => {
  const wc = await S.claimFor(page, ti, 'REG_CLAIM_WC', 'WC', 'RG-TC038-WC');
  await S.openExposureMatching(page, 'Medical');
  let s = await medicareTab(page);
  await R.check(page, ti, { description: `WC ${wc}: Medicare tab on the Medical exposure`, expected: '"Is Claimant a Medicare Beneficiary?" shown', actual: S.findField(s, 'Is Claimant a Medicare Beneficiary?') ? 'shown' : 'not shown', ok: !!S.findField(s, 'Is Claimant a Medicare Beneficiary?') });
  await R.check(page, ti, { description: 'No Medicare data populated', expected: 'empty', actual: s.fields.filter((f) => /medicare|ICD|ORM/i.test(f.label)).map((f) => `${f.label}=${f.value}`).join('; '), ok: medicareEmpty(s) });
  const pa = await S.claimFor(page, ti, 'REG_CLAIM_PA_PIP', 'PA', 'RG-TC038-PIP');
  try { await S.openExposureMatching(page, 'PIP|Personal Injury Protection|First Party Medical'); } catch (e) {
    if (e.name !== 'Blocked') throw e;
    throw new W.Blocked(`${pa} has no PIP exposure — set REG_CLAIM_PA_PIP to a PA claim with a PIPSUMMARY exposure (the WC half passed)`);
  }
  s = await medicareTab(page);
  await R.check(page, ti, { description: `Auto ${pa}: Medicare tab on the PIP exposure, no data`, expected: 'tab shown, empty', actual: S.findField(s, 'Is Claimant a Medicare Beneficiary?') ? 'shown' : 'not shown', ok: !!S.findField(s, 'Is Claimant a Medicare Beneficiary?') && medicareEmpty(s) });
}));

test('RG-TC039 [MSP Navigator - Medicare]: SSN and DOB on the Medicare tab follow the claimant contact', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await S.claimFor(page, ti, 'REG_CLAIM_WC', 'WC', 'RG-TC039');
  await S.openExposureMatching(page, 'Medical');
  let s = await medicareTab(page);
  const ssn = S.findField(s, 'SSN') || S.findField(s, 'Social Security Number'), dob = S.findField(s, 'Date of Birth');
  await R.check(page, ti, { description: 'SSN and DOB present on the Medicare tab and not required', expected: 'both shown, required=false', actual: `SSN ${ssn ? `required=${ssn.required}` : 'missing'}, DOB ${dob ? `required=${dob.required}` : 'missing'}`, ok: !!ssn && !!dob && !ssn.required && !dob.required });
  const testSsn = `900-${String(10 + Math.floor(Math.random() * 89))}-${String(1000 + Math.floor(Math.random() * 8999))}`; // 900-series: never issued
  await A.editAndSave(page, 'Medicare SSN/DOB', async () => {
    await A.fillByLabel(page, ssn.label, testSsn);
    await A.fillByLabel(page, dob.label, '01/15/1950');
  });
  await R.step(page, ti, `Medicare tab: set SSN ${testSsn.replace(/\d{4}$/, 'xxxx')}, DOB 01/15/1950`);
  await W.navigate(page, 'parties');
  const body = await S.bodyText(page);
  await R.check(page, ti, { description: 'Change on the Medicare tab is on the claimant contact', expected: 'DOB 01/15/1950 on the claimant', actual: /01\/15\/1950/.test(body) ? 'DOB shown on Parties Involved' : 'DOB not on Parties Involved', ok: /01\/15\/1950/.test(body) });
  ti.annotations.push({ type: 'manual', description: 'Step 2 (edit SSN/DOB on the contact tab → Medicare tab) is the reverse direction of the same link; run by hand if needed.' });
  R.setClaim(ti, cn);
}));

// TC040: Medicare = Yes, no ICD code, claim cost > $0 → "ICD code missing" activity from the batch; cost $0 → none.
// Uses needsData.setExposureMedicare (TEST tier only — it writes claim data). Step 3 (re-generation after the script
// parameter is shortened and 2 days pass) stays manual.
test('RG-TC040 [MSP Navigator - Medicare]: ICD code missing activity (cost > $0 yes, cost $0 no)', async ({ page }, ti) => S.blockable(test, async () => {
  S.need(test, 'CC_ADMIN_USER', 'CC_ADMIN_PASS');
  const N = require('../../helpers/oneInc/needsData');
  const ICD = /ICD/i;
  // Claim A: cost > $0
  const a = (await S.fileClaim(page, 'WC', 'RG-TC040-A', { pool: false })).cn;
  await N.setExposureMedicare(page, 'Medical', { beneficiary: 'Yes', icd: null });
  await R.asAdmin(page, a);
  await S.E.repairCloud(page, a).catch(() => {});
  await S.F.createReserve(page, { reserveAmount: 800, exposure: 'Medical', strict: false });
  await R.asStandard(page, a);
  const pay = await S.P.makePayment(page, { amount: S.P.uniqueAmount(60) });
  await R.step(page, ti, `Claim A ${a}: Medicare Yes, no ICD, payment $${pay.amount} (${pay.finished ? 'finished' : pay.messages.join(' | ')})`);
  // Claim B: cost $0
  const b = (await S.fileClaim(page, 'WC', 'RG-TC040-B', { pool: false })).cn;
  await N.setExposureMedicare(page, 'Medical', { beneficiary: 'Yes', icd: null });
  await R.step(page, ti, `Claim B ${b}: Medicare Yes, no ICD, no payments`);
  R.setClaim(ti, `${a}, ${b}`, process.env.CC_USER);
  await R.step(page, ti, await S.runBatchProcess(page, S.batchName('ICD_MISSING', /ICD|MSP|Medicare/i)));
  const ra = await S.activities(page, a, ICD);
  await R.check(page, ti, { description: `Claim A ${a} (cost > $0): ICD code missing activity`, expected: 'one ICD-missing activity per Medicare exposure', actual: ra.join(' | ') || 'none', ok: ra.length > 0 });
  const rb = await S.activities(page, b, ICD);
  await R.check(page, ti, { description: `Claim B ${b} (cost $0): no ICD activity`, expected: 'none', actual: rb.join(' | ') || 'none', ok: rb.length === 0 });
  ti.annotations.push({ type: 'manual', description: 'Step 3: complete the activity without an ORM, shorten the script parameter to 1 day and check it regenerates after 2 days.' });
}));
