/**
 * tests/Regression/Search.regression.test.js — Regression Test Design V1.0: Policy Search, Policy Search & Retrieve
 * (TC001–TC004). Cloud ClaimCenter. Run from the Runner's Regression tab, or:
 *   npx playwright test --project "Regression" --grep "RG-TC00[1-4]"
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { clickNewClaimCloud, completeFNOL, searchPolicy, fillBasicInfo } = require('../../helpers/fnolHelper');
const { R, B, W } = S;

S.hooks(test);

// Columns the TC expects in the result grid (header text varies a little: "Claim #", "Loss Date", "Remaining Reserves").
const RESULT_COLUMNS = [/claim/i, /insured/i, /policy/i, /claimant/i, /loss date/i, /county/i, /zip/i, /adjuster/i, /status/i, /remaining reserve/i, /future payment/i, /paid/i];
const missingColumns = (headers) => RESULT_COLUMNS.filter((re) => !headers.some((h) => re.test(h))).map(String);

async function resetCleared(page) {
  await W.clickButton(page, 'Reset').catch(() => {});
  const s = await S.readScreen(page);
  return ['Claim #', 'Policy #'].map((l) => S.findField(s, l)).filter(Boolean).every((f) => !f.value);
}

test('RG-TC001 [Policy Search]: Search by Claim Number — results grid + Reset', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await S.claimFor(page, ti, 'REG_CLAIM_PA', 'PA', 'RG-TC001');
  const res = await S.searchClaims(page, { claim: cn });
  await R.step(page, ti, `Search › Claims: Claim # ${cn} → ${res.rows.length} row(s)`);
  await R.check(page, ti, { description: 'Claim found in the result grid', expected: cn, actual: res.rows.join(' | '), ok: res.rows.some((r) => r.includes(cn)) });
  const miss = missingColumns(res.headers);
  await R.check(page, ti, { description: 'Result grid columns', expected: 'Claim, Insured, Policy, Claimant, Loss Date, County, Zip, Adjuster, Status, Remaining Reserve, Future Payments, Paid', actual: miss.length ? `missing: ${miss.join(', ')} (headers: ${res.headers.join(', ')})` : res.headers.join(', '), ok: !miss.length });
  const cleared = await resetCleared(page);
  await R.check(page, ti, { description: 'Reset clears the search fields', expected: 'Claim # and Policy # empty', actual: cleared ? 'cleared' : 'still filled', ok: cleared });
  if (process.env.REG_CLAIM_PA_LEGACY) {
    const leg = await S.searchClaims(page, { claim: process.env.REG_CLAIM_PA_LEGACY });
    await R.check(page, ti, { description: 'Legacy/Mainframe PA claim found', expected: process.env.REG_CLAIM_PA_LEGACY, actual: leg.rows.join(' | '), ok: leg.rows.some((r) => r.includes(process.env.REG_CLAIM_PA_LEGACY)) });
  } else ti.annotations.push({ type: 'manual', description: 'Legacy/Mainframe claim variant not run — set REG_CLAIM_PA_LEGACY.' });
}));

test('RG-TC002 [Policy Search]: Search by Policy Number — results grid + Reset', async ({ page }, ti) => S.blockable(test, async () => {
  await B.loginToClaimCenter(page);
  const policies = [process.env.REG_POLICY_HO || B.getNextPolicy('POLICY_HO_PA', 'RG-TC002'), process.env.REG_POLICY_HO_LEGACY].filter(Boolean);
  for (const policy of policies) {
    const res = await S.searchClaims(page, { policy });
    await R.step(page, ti, `Search › Claims: Policy # ${policy} → ${res.rows.length} row(s)`);
    await R.check(page, ti, { description: `Claims listed for policy ${policy}`, expected: 'at least one claim row', actual: res.rows.slice(0, 5).join(' | ') || 'no rows', ok: res.rows.length > 0 });
    const miss = missingColumns(res.headers);
    await R.check(page, ti, { description: 'Result grid columns', expected: 'all 12 TC columns', actual: miss.length ? `missing: ${miss.join(', ')}` : 'all present', ok: !miss.length });
  }
  const cleared = await resetCleared(page);
  await R.check(page, ti, { description: 'Reset clears the search fields', expected: 'empty', actual: cleared ? 'cleared' : 'still filled', ok: cleared });
}));

test('RG-TC003 [Policy Search & Retrieve]: PC policy search defaults, Step 3 hard stop, full FNOL creates an assigned claim', async ({ page }, ti) => S.blockable(test, async () => {
  S.need(test, 'POLICY_PA_AUTO');
  await B.loginToClaimCenter(page);
  await clickNewClaimCloud(page);
  const s = await S.readScreen(page);
  const conv = S.findField(s, 'Is this claim being converted from a legacy claim system to ClaimCenter?');
  await R.check(page, ti, { description: 'Converted from legacy system? defaults to No', expected: 'No', actual: conv ? JSON.stringify(conv.radios || conv.value) : 'question not on screen', ok: !!conv && (conv.radios ? conv.radios.some((r) => r.label === 'No' && r.checked) : /^no$/i.test(conv.value)) });
  const fast = S.findField(s, 'Is this a Fast Track claim?');
  await R.step(page, ti, `Fast Track question on Find Policy: ${fast ? JSON.stringify(fast.radios || fast.value) : 'not shown before policy search'}`);
  await W.cancelWizard(page).catch(() => {});

  // Step 9: Steps 1–2 with fnolHelper's own step functions, then Finish with Step 3 left blank → hard stop.
  const p1 = B.getNextPolicy('POLICY_PA_AUTO', 'RG-TC003-neg');
  await searchPolicy(page, p1, B.getTestLossDate(1, p1), 'Personal auto');
  await fillBasicInfo(page);
  for (const name of ['Finish', 'Next']) {
    const b = page.getByRole('button', { name, exact: true }).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); break; }
  }
  await W.settle(page, 3000);
  const stop = await R.pageMessages(page);
  const stillInWizard = await W.inWizard(page);
  await R.check(page, ti, { description: 'Step 3 left blank → hard stop (required-field errors, claim not created)', expected: 'errors listed, still in the wizard', actual: `${stillInWizard ? 'still in wizard' : 'LEFT the wizard'} — ${stop.slice(0, 4).join(' | ') || 'no messages'}`, ok: stillInWizard && stop.length > 0 });
  await W.cancelWizard(page).catch(() => {});

  // Positive: full FNOL.
  const policyNumber = B.getNextPolicy('POLICY_PA_AUTO', 'RG-TC003');
  const cn = await completeFNOL(page, { policyNumber, policyEnvVar: 'POLICY_PA_AUTO', policyType: 'Personal auto', lossDetails: { lossDate: B.getTestLossDate(1, policyNumber), lossState: B.getLossState(policyNumber, 'PA'), lossCauseCode: 'LC15', lossDescription: 'Regression TC003' }, exposures: [{ coverageLabel: 'Collision' }] });
  const routed = await S.savedAssignment(page);
  R.setClaim(ti, cn, process.env.CC_USER);
  await R.step(page, ti, `FNOL finished: ${cn} — Assigned Group "${routed.group}", Assigned User "${routed.user}"`);
  await R.check(page, ti, { description: 'Claim created and assigned', expected: 'claim number + assigned group', actual: `${cn} / ${routed.group || '(none)'}`, ok: !!cn && !!routed.group && !/pending/i.test(routed.user) });
  const f = S.claimNumberFormat(cn);
  await R.check(page, ti, { description: 'Claim number format', expected: 'Prefix-State-Office-YY-Sequence', actual: cn, ok: f.ok });
}));

test('RG-TC004 [Policy Search & Retrieve]: Converted (legacy) claim — legacy fields, Fast Track hidden, full FNOL', async ({ page }, ti) => S.blockable(test, async () => {
  const [legacyClaim, legacyPolicy] = S.need(test, 'REG_LEGACY_CLAIM_NO', 'REG_LEGACY_POLICY_NO');
  const searchPolicyNo = process.env.REG_LEGACY_POLICY_SEARCH || legacyPolicy;
  await B.loginToClaimCenter(page);
  // fnolHelper.searchPolicy calls page._fnolBeforeNext on Find Policy right before Next (after the policy search and the
  // default answers): answer Converted = Yes there, fill the legacy numbers, and record what the screen showed.
  const seen = {};
  page._fnolBeforeNext = async (p) => {
    await W.answer(p, 'Is this claim being converted from a legacy claim system to ClaimCenter?', 'Yes');
    const s = await S.readScreen(p);
    const lc = S.findField(s, 'What is the Legacy System Claim Number?') || s.fields.find((f) => /legacy.*claim/i.test(f.label));
    const lp = S.findField(s, 'What is the Legacy System Policy Number?') || s.fields.find((f) => /legacy.*policy/i.test(f.label));
    seen.fields = `${lc ? 'claim field' : 'NO claim field'}, ${lp ? 'policy field' : 'NO policy field'}`;
    seen.ok = !!lc && !!lp;
    if (lc) await W.fill(p, lc.label, legacyClaim);
    if (lp) await W.fill(p, lp.label, legacyPolicy);
    seen.fastTrack = !!S.findField(await S.readScreen(p), 'Is this a Fast Track claim?');
    seen.rows = (await R.gridRows(p)).filter((r) => r.includes(searchPolicyNo)).slice(0, 2).join(' | ');
  };
  const cn = await completeFNOL(page, { policyNumber: searchPolicyNo, policyType: process.env.REG_LEGACY_POLICY_TYPE || 'Personal auto', lossDetails: { lossDate: B.getTestLossDate(1, searchPolicyNo), lossState: 'PA', lossCauseCode: 'LC15', lossDescription: 'Regression TC004 converted claim' }, exposures: [{ coverageLabel: 'Collision' }] });
  page._fnolBeforeNext = null;
  R.setClaim(ti, cn, process.env.CC_USER);
  await R.check(page, ti, { description: 'Converted = Yes shows both legacy number fields', expected: 'Legacy Claim # and Legacy Policy # fields', actual: seen.fields || 'hook did not run', ok: !!seen.ok });
  await R.check(page, ti, { description: 'Fast Track question hidden for a converted claim', expected: 'not displayed', actual: seen.fastTrack ? 'displayed' : 'not displayed', ok: seen.fastTrack === false });
  await R.check(page, ti, { description: 'Legacy policy retrieved by the search', expected: searchPolicyNo, actual: seen.rows || 'no matching row', ok: !!seen.rows });
  const routed = await S.savedAssignment(page);
  await R.check(page, ti, { description: 'Converted claim created and assigned', expected: 'claim number + group', actual: `${cn} / ${routed.group || '(none)'}`, ok: !!cn && !!routed.group });
  await B.openExistingClaim(page, cn);
  await S.A.openLossDetailsGeneral(page);
  const body = await S.bodyText(page);
  await R.check(page, ti, { description: 'Legacy claim number kept on the claim', expected: legacyClaim, actual: body.includes(legacyClaim) ? 'shown on Loss Details' : 'not shown on Loss Details', ok: body.includes(legacyClaim) });
}));
