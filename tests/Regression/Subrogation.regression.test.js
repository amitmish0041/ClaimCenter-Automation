/**
 * tests/Regression/Subrogation.regression.test.js — Regression Test Design V1.0, Subrogation (TC058, TC059).
 * WI Personal Auto (POLICY_PA_AUTO_WI). The referral chain reuses e2eSteps.openSubrogationCloud's activity handling.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, B, A, L } = S;

S.hooks(test);

// Open a Workplan activity by subject, answer its select/radio, Update (same south-panel shape openSubrogationCloud uses).
async function completeActivity(page, cn, subject, answers = {}) {
  await B.openExistingClaim(page, cn);
  await S.nav(page, 'Workplan');
  const link = page.locator('tr[role="row"]').filter({ hasText: subject }).getByText(subject, { exact: false }).first();
  if (!(await link.count())) throw new W.Blocked(`no "${subject}" activity on ${cn}`);
  await link.click();
  await W.settle(page, 3000);
  for (const [label, value] of Object.entries(answers)) {
    const f = S.findField(await S.readScreen(page), label);
    if (!f) throw new W.Blocked(`"${label}" not on the "${subject}" activity`);
    if (f.radios) await W.answer(page, label, value); else await A.selectByLabel(page, label, value);
  }
  await page.locator('#gw-south-panel').getByRole('button', { name: 'Update', exact: true }).first().click().catch(() => W.clickButton(page, 'Update'));
  await W.settle(page, 3000);
  return R.pageMessages(page);
}

test('RG-TC058 [Subrogation]: Subrogation Potential at FNOL → referral routing → closure blocked until referred', async ({ page }, ti) => S.blockable(test, async () => {
  const claim = await S.fileClaim(page, 'PA_WI', 'RG-TC058', { assignmentType: 'Casualty', lossCause: 'LC15', pool: false });
  const cn = claim.cn;
  R.setClaim(ti, cn, process.env.CC_USER);
  const pot = await S.activities(page, cn, /Subrogation Potential/i);
  await R.check(page, ti, { description: 'DMCW0032: Subrogation Potential activity at FNOL, assigned to the claim rep', expected: 'Subrogation Potential → claim rep / group', actual: pot.join(' | ') || 'none', ok: pot.length > 0 });
  const m = await completeActivity(page, cn, 'Subrogation Potential', { 'Subro Potential': 'Yes' });
  await R.step(page, ti, `Subrogation Potential completed with Subro Potential = Yes ${m.join(' | ')}`);
  const review = await S.activities(page, cn, /Review claim for subrogation/i);
  await R.check(page, ti, { description: "DMGA0085: 'Review claim for subrogation' to the claim rep's supervisor", expected: 'activity assigned to the supervisor', actual: review.join(' | ') || 'none', ok: review.length > 0 });
  // Close attempt BEFORE the referral: DMCCV005
  let closeMsg = '';
  try { await L.closeClaim(page, { closeReason: 'Completed', closingNote: 'Regression TC058' }); closeMsg = 'closed (rule did not block)'; } catch (e) { closeMsg = String(e.message); }
  closeMsg += ' ' + (await R.pageMessages(page)).join(' | ');
  await R.check(page, ti, { description: 'DMCCV005 blocks Close Claim (Subro Potential = Yes, not referred)', expected: 'This claim has not been referred to Subro. Please refer the claim to subro before closing.', actual: closeMsg.slice(0, 400), ok: /not been referred to Subro/i.test(closeMsg) });
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
  if (process.env.CC_TEAM_PASS) {
    const sup = await R.approverFor(page).catch(() => null);
    await R.step(page, ti, `Review activity assignee: ${sup || 'unknown'} — confirming as supervisor`);
    if (sup) await R.asTeam(page, cn, S.E.loginIdFor(sup)).catch(() => {});
    await completeActivity(page, cn, 'Review claim for subrogation', { 'Refer to Subro': 'Yes' }).catch((e) => ti.annotations.push({ type: 'manual', description: `supervisor confirmation not completed: ${e.message}` }));
    const ref = await S.activities(page, cn, /Subrogation Referral/i);
    await R.check(page, ti, { description: 'Subrogation Referral → Recovery Claim Division, queue, due date = created (DMGA0085 / DMDA0013 / DMAPR005)', expected: 'Subrogation Referral in Recovery Claim Division queue', actual: ref.join(' | ') || 'none', ok: ref.some((r) => /Recovery|Queue/i.test(r)) });
  } else ti.annotations.push({ type: 'manual', description: 'Supervisor confirmation + referral routing (steps 5–7) need CC_TEAM_PASS.' });
}));

test('RG-TC059 [Subrogation]: Enable Subrogation on Loss Details → SubrogationSummary, reassignment, review activities', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = process.env.REG_CLAIM_WI_AUTO || (await S.pooledClaim(page, 'PA_WI', 'RG-TC059', { assignmentType: 'Casualty', lossCause: 'LC15' })).cn;
  await B.loginToClaimCenter(page);
  await R.makeViewable(page, cn);
  R.setClaim(ti, cn, process.env.CC_USER);
  await A.openLossDetailsGeneral(page);
  await A.editAndSave(page, 'Referred to Subro = Yes', async () => {
    const s = await S.readScreen(page);
    const ref = s.fields.find((f) => /referred to subro/i.test(f.label));
    if (!ref) throw new W.Blocked('no "Referred to Subro" on Loss Details');
    if (ref.radios) await W.answer(page, ref.label, 'Yes'); else await A.selectByLabel(page, ref.label, 'Yes');
    const rs = (await S.readScreen(page)).fields.find((f) => /recovery status/i.test(f.label));
    if (rs) await A.selectByLabel(page, rs.label, 'Open');
    const adj = (await S.readScreen(page)).fields.find((f) => /subro.*adjuster/i.test(f.label) && f.kind === 'select');
    if (adj) await A.selectByLabel(page, adj.label, /^(?!<none>$).+/);
  });
  await S.nav(page, /^Subrogation$/i);
  const sub = await S.bodyText(page);
  await R.check(page, ti, { description: 'CPU10800: Subrogation screen enabled, status Open', expected: 'Subrogation status Open', actual: (sub.match(/Status[^\n]{0,40}/) || ['no status'])[0], ok: /\bOpen\b/.test(sub) });
  const reassign = await S.activities(page, cn, /Subrogation Reassignment/i);
  await R.check(page, ti, { description: 'CPU32010 / DMGA0107: Subrogation Reassignment → Recovery Claim Division / Subro adjuster', expected: 'Subrogation Reassignment activity', actual: reassign.join(' | ') || 'none', ok: reassign.length > 0 });
  const review = await S.activities(page, cn, /Review Claim for Subrogation/i);
  await R.check(page, ti, { description: 'DMGA0086: Review Claim for Subrogation → claim group supervisor', expected: 'activity assigned to the group supervisor', actual: review.join(' | ') || 'none', ok: review.length > 0 });
}));
