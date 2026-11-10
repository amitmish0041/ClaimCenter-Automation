/**
 * tests/Regression/SIU.regression.test.js — Regression Test Design V1.0, Special Investigations (TC045, TC046).
 * Rules are verified through what they produce on the Workplan (activity, Assigned To / group) and History.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, B, A, P } = S;

S.hooks(test);

const SIU_REVIEW = /SIU.{0,6}file review|SIU_file_review/i;

// Exposure › Edit › Cause of Loss = <code/text> › Update. Returns CC's messages.
async function setExposureCol(page, match, col) {
  await S.openExposureMatching(page, match);
  let msgs = [];
  await A.editAndSave(page, `exposure cause of loss ${col}`, async () => {
    await A.selectByLabel(page, 'Cause of Loss', new RegExp(col, 'i'));
  }).catch((e) => { msgs = [e.message]; });
  return msgs.concat(await R.pageMessages(page));
}

test('RG-TC045 [Special Investigations]: Fire COL on Auto / Property exposure creates and routes SIU file review', async ({ page }, ti) => S.blockable(test, async () => {
  // Auto: DMEPU0016
  const auto = await S.claimFor(page, ti, 'REG_CLAIM_PA', 'PA', 'RG-TC045-PA');
  const before = (await S.activities(page, auto, SIU_REVIEW)).length;
  const m1 = await setExposureCol(page, '.', 'Fire|LC01');
  await R.step(page, ti, `Auto ${auto}: exposure Cause of Loss → Fire (LC01) ${m1.join(' | ')}`);
  const autoRows = await S.activities(page, auto, SIU_REVIEW);
  await R.check(page, ti, { description: 'DMEPU0016: SIU file review activity on the Auto exposure', expected: 'one new SIU file review activity', actual: autoRows.join(' | ') || 'none', ok: autoRows.length > before });
  await R.check(page, ti, { description: 'DMDA0101 / DMGA0407: assigned to the SIU File Reviewer / SIU group', expected: 'Assigned To = SIU file reviewer (SIU group)', actual: autoRows[autoRows.length - 1] || 'none', ok: autoRows.some((r) => /SIU/i.test(r.replace(SIU_REVIEW, ''))) });
  // De-duplication: change the COL again → no second activity
  await setExposureCol(page, '.', 'Fire|LC24');
  const again = await S.activities(page, auto, SIU_REVIEW);
  await R.check(page, ti, { description: 'No duplicate SIU file review after a second fire COL change (hasMatch)', expected: `${autoRows.length} activity(ies)`, actual: `${again.length}`, ok: again.length === autoRows.length });
  // Negative: non-fire COL
  const neg = await S.claimFor(page, ti, 'REG_CLAIM_PA_NEG', 'PA', 'RG-TC045-NEG');
  const n0 = (await S.activities(page, neg, SIU_REVIEW)).length;
  await setExposureCol(page, '.', 'Collision|LC15');
  const n1 = (await S.activities(page, neg, SIU_REVIEW)).length;
  await R.check(page, ti, { description: 'Non-fire COL (LC15) creates no SIU activity', expected: `${n0}`, actual: `${n1}`, ok: n1 === n0 });
  // Property: DMEPU0017 + DMTP010065 on an approved payment
  const prop = await S.claimFor(page, ti, 'REG_CLAIM_HO', 'HO', 'RG-TC045-HO');
  await setExposureCol(page, 'Dwelling|Coverage', 'Fire|LC01');
  const propRows = await S.activities(page, prop, SIU_REVIEW);
  await R.check(page, ti, { description: 'DMEPU0017: SIU file review on the Property fire exposure', expected: 'SIU file review activity', actual: propRows.join(' | ') || 'none', ok: propRows.length > 0 });
  await B.openExistingClaim(page, prop);
  const pay = await P.makePayment(page, {});
  await R.step(page, ti, `Property payment $${pay.amount}: finished=${pay.finished} ${pay.messages.join(' | ')}`);
  if (pay.finished) await R.approveAllLevels(page, prop, /approve/i).catch(() => {});
  const loss = await S.activities(page, prop, /SIU.{0,10}Property Loss/i);
  await R.check(page, ti, { description: 'DMTP010065: SIU Property Loss activity after the approved payment', expected: 'SIU Property Loss activity', actual: loss.join(' | ') || 'none', ok: loss.length > 0 });
  ti.annotations.push({ type: 'manual', description: 'Step 8 (LostPropertyType = Jewelry) depends on configuration — run by hand.' });
  R.setClaim(ti, `${auto}, ${prop}`);
}));

test('RG-TC046 [Special Investigations]: SIU Referral (fraud_review) with no user routes to the SIU Supervisor (DMDA0102)', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await S.claimFor(page, ti, 'REG_CLAIM_PA', 'PA', 'RG-TC046');
  await S.CO.historyMark(page);
  await S.action(page, /^New Activity|Activity/i).catch(async () => { await S.nav(page, 'Workplan'); await W.clickButton(page, 'New Activity'); });
  const items = await W.visibleMenuItems(page);
  const siu = items.find((t) => /SIU Referral|fraud/i.test(t));
  if (siu) { await page.locator('[role=menuitem]').filter({ hasText: siu }).first().click(); await W.settle(page, 3000); }
  else {
    const subj = S.findField(await S.readScreen(page), 'Subject');
    if (!subj) throw new W.Blocked(`no SIU Referral activity pattern offered (menu: ${items.join(' | ').slice(0, 300)})`);
    await A.fillByLabel(page, subj.label, 'SIU Referral');
  }
  const assignee = S.findField(await S.readScreen(page), 'Assigned to') || S.findField(await S.readScreen(page), 'Assign To');
  if (assignee && assignee.kind === 'select') await A.selectByLabel(page, assignee.label, /^<none>$|^$/).catch(() => {});
  await A.fillRequired(page).catch(() => {});
  await W.clickButton(page, 'Update');
  const rows = await S.activities(page, cn, /SIU Referral|fraud/i);
  await R.check(page, ti, { description: 'Activity assigned to the SIU Supervisor of Special Investigation Division', expected: 'Assigned To = SIU supervisor (not unassigned)', actual: rows.join(' | ') || 'no SIU Referral activity', ok: rows.some((r) => !/unassigned/i.test(r) && /SIU|Special Investigation/i.test(r.replace(/SIU Referral/i, ''))) });
  await A.openLossDetailsGeneral(page);
  const status = S.findField(await S.readScreen(page), 'SIU Status');
  await R.check(page, ti, { description: "Loss Details SIU Status = 'Referred to SIU'", expected: 'Referred to SIU', actual: status ? status.value : 'no SIU Status field', ok: !!status && /referred/i.test(status.value) });
  const hist = await S.CO.historySince(page);
  await R.check(page, ti, { description: 'CPU06002 custom history event', expected: 'an SIU history event', actual: hist, ok: /SIU/i.test(hist) });
}));
