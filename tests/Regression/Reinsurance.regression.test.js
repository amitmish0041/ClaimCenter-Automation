/**
 * tests/Regression/Reinsurance.regression.test.js — Regression Test Design V1.0, Reinsurance (TC043, TC044).
 * Needs legacy claims with RI data (REG_RI_LEGACY_*); a LOB without one is reported in the result, not failed.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, B, A } = S;

S.hooks(test);

const RI_Q = ['Reported to Reinsurer?', 'Is Reinsurance being collected?'];
async function riFields(page, cn) {
  await B.openExistingClaim(page, cn);
  await A.openLossDetailsGeneral(page);
  const s = await S.readScreen(page);
  return RI_Q.map((q) => S.findField(s, q));
}

test('RG-TC043 [Reinsurance]: Legacy RI fields visible on legacy claims, hidden on PC claims', async ({ page }, ti) => S.blockable(test, async () => {
  const pc = await S.claimFor(page, ti, 'REG_CLAIM_PA', 'PA', 'RG-TC043');
  const onPc = await riFields(page, pc);
  await R.check(page, ti, { description: `PC claim ${pc}: legacy RI fields not displayed`, expected: 'hidden', actual: onPc.filter(Boolean).map((f) => f.label).join(', ') || 'hidden', ok: onPc.every((f) => !f) });
  const legacy = { WC: 'REG_RI_LEGACY_WC', 'Commercial Auto': 'REG_RI_LEGACY_CA', 'Commercial Property': 'REG_RI_LEGACY_CP', 'Commercial Umbrella': 'REG_RI_LEGACY_UMB' };
  let checked = 0;
  for (const [lob, v] of Object.entries(legacy)) {
    if (!process.env[v]) { ti.annotations.push({ type: 'manual', description: `${lob} legacy RI claim not configured (${v}).` }); continue; }
    const f = await riFields(page, process.env[v]);
    checked++;
    await R.check(page, ti, { description: `${lob} legacy claim ${process.env[v]}: both RI fields visible`, expected: RI_Q.join(' + '), actual: f.map((x, i) => (x ? `${RI_Q[i]}=${x.value || x.radios && JSON.stringify(x.radios)}` : `${RI_Q[i]} missing`)).join('; '), ok: f.every(Boolean) });
  }
  if (!checked) throw new W.Blocked('no legacy RI claim configured — set REG_RI_LEGACY_WC / _CA / _CP / _UMB (the PC half passed)');
}));

test('RG-TC044 [Reinsurance]: Reported to Reinsurer = Yes → High Risk indicator; RI collected = Yes → required fields', async ({ page }, ti) => S.blockable(test, async () => {
  const [cn] = S.need(test, 'REG_RI_LEGACY_EDIT');
  await B.loginToClaimCenter(page);
  await R.makeViewable(page, cn);
  R.setClaim(ti, cn, process.env.CC_USER);
  await A.openLossDetailsGeneral(page);
  await A.editAndSave(page, 'Reported to Reinsurer = Yes', async () => { await W.answer(page, RI_Q[0], 'Yes'); });
  const top = await S.bodyText(page);
  await R.check(page, ti, { description: 'High Risk Indicator on the banner / Summary (DMCPU3653 Reinsurance Claim Indicator)', expected: 'High Risk / Reinsurance indicator', actual: (top.match(/High Risk[^\n]{0,60}|Reinsurance[^\n]{0,40}indicator/i) || ['not shown'])[0], ok: /High Risk|Reinsurance.{0,20}indicator/i.test(top) });
  await W.clickButton(page, 'Edit');
  await W.answer(page, RI_Q[1], 'Yes');
  const s = await S.readScreen(page);
  const need = ['Retention Value', 'Reinsurance Company', 'Does Annual Aggregate Deductible apply?', 'Ceded Percent'];
  const found = need.map((l) => S.findField(s, l));
  await R.check(page, ti, { description: 'RI collected = Yes shows the required fields', expected: need.join(', ') + ', Recoveries Received table', actual: need.map((l, i) => `${l}: ${found[i] ? (found[i].required ? 'required' : 'shown') : 'missing'}`).join('; ') + (/Recoveries Received/i.test(s.body) ? '; Recoveries Received table shown' : '; no Recoveries Received table'), ok: found.every(Boolean) && /Recoveries Received/i.test(s.body) });
  const ret = found[0], ced = found[3];
  await A.fillByLabel(page, ret.label, 'abc');
  const retVal = (S.findField(await S.readScreen(page), ret.label) || {}).value || '';
  await R.check(page, ti, { description: 'Retention Value accepts numbers only', expected: 'non-numeric rejected', actual: `shows "${retVal}" ${(await R.pageMessages(page)).join(' | ')}`, ok: !/abc/i.test(retVal) || (await R.pageMessages(page)).length > 0 });
  for (const v of ['150', '-5']) {
    await A.fillByLabel(page, ced.label, v);
    await W.clickButton(page, 'Update').catch(() => {});
    const msgs = await R.pageMessages(page);
    await R.check(page, ti, { description: `Ceded Percent ${v} rejected (0–100 only)`, expected: 'validation message', actual: msgs.join(' | ') || 'saved without a message', ok: msgs.some((m) => /ceded|percent|100|range/i.test(m)) });
  }
  const co = found[1];
  await R.step(page, ti, `Reinsurance Company options: ${(co.options || []).join(', ')}`);
  const agg = found[2];
  await R.check(page, ti, { description: 'Annual Aggregate Deductible shows Yes/No', expected: 'Yes / No', actual: agg.radios ? agg.radios.map((r) => r.label).join('/') : (agg.options || []).join('/'), ok: (agg.radios || []).some((r) => r.label === 'Yes') || (agg.options || []).includes('Yes') });
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
}));
