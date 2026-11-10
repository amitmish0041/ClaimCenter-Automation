/**
 * tests/Regression/ClaimHandling.regression.test.js — Regression Test Design V1.0: Claim Handling (TC024–TC026),
 * VindicateRecallListAPI (TC033), CCC (TC041, TC042). Cloud ClaimCenter.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, B, A } = S;

S.hooks(test);

test('RG-TC024 [Claim Handling]: Post-FNOL vehicle incident with all vehicle details', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await S.claimFor(page, ti, 'REG_CLAIM_PA', 'PA', 'RG-TC024');
  await A.openLossDetailsGeneral(page);
  await W.clickButton(page, 'Edit');
  // Vehicles list-view toolbar "Add" on Loss Details (same LV EditableVehicleIncidentsLV wizardDriver.addIncidentLoan opens).
  const add = page.locator('[id*="EditableVehicleIncidentsLV_tb-Add"], [id*="VehicleIncidents"][id$="-Add"]').first();
  if (!(await add.isVisible().catch(() => false))) throw new W.Blocked('no Add button in the Vehicles section of Loss Details');
  await add.click();
  await W.settle(page, 3500);
  const v = { Year: '2021', Make: 'Honda', Model: 'Accord', Color: 'Blue', VIN: '1HGCV1F34MA000301', 'License Plate': `RG${Date.now().toString().slice(-5)}`, 'Damage Description': 'Regression TC024 rear bumper damage' };
  for (const [label, value] of Object.entries(v)) await W.fill(page, label, value).catch(() => ti.annotations.push({ type: 'manual', description: `"${label}" field not found on the vehicle incident screen` }));
  for (const label of ['Loss Party', 'Driver Name', 'Owner']) await W.select(page, label, 0).catch(() => {});
  await A.fillRequired(page).catch(() => {});
  await R.step(page, ti, `Vehicle incident entered: ${JSON.stringify(v)}`);
  await W.clickButton(page, 'OK');
  const saved = await S.editAndUpdate(page, async () => {}, 'Loss Details').catch(() => ({ saved: false, messages: [] }));
  const rows = await R.gridRows(page);
  await R.check(page, ti, { description: 'Vehicle incident saved on Loss Details', expected: `2021 Honda Accord (${v.VIN})`, actual: rows.filter((r) => /Honda|Accord/i.test(r)).join(' | ') || `not listed — ${saved.messages.join(' | ')}`, ok: rows.some((r) => /Accord/i.test(r)) });
  R.setClaim(ti, cn);
}));

test('RG-TC025 [Claim Handling]: DWF Loss Details — loss location, loss cause, incident types', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await S.claimFor(page, ti, 'REG_CLAIM_DF', 'DF', 'RG-TC025');
  await A.openLossDetailsGeneral(page);
  const s = await S.readScreen(page);
  const loc = S.findField(s, 'Loss Location') || S.findField(s, 'Location'), cause = S.findField(s, 'Loss Cause');
  await R.check(page, ti, { description: 'Loss Location and Loss Cause on Loss Details', expected: 'both fields shown', actual: `Location: ${loc ? loc.value || '(empty)' : 'missing'}; Loss Cause: ${cause ? cause.value || '(empty)' : 'missing'}`, ok: !!loc && !!cause });
  await W.clickButton(page, 'Edit');
  const addBtn = page.getByRole('button', { name: /^Add$/ }).first();
  await addBtn.click().catch(() => {});
  await W.settle(page, 1500);
  const items = await W.visibleMenuItems(page);
  await R.check(page, ti, { description: 'Loss Items › Add offers multiple incident types', expected: '2+ incident types', actual: items.join(' | ') || 'no menu', ok: items.length >= 2 });
  await W.closeMenus(page);
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
  R.setClaim(ti, cn);
}));

test('RG-TC026 [Claim Handling]: Notes at FNOL and post-FNOL (CPP)', async ({ page }, ti) => S.blockable(test, async () => {
  const claim = await S.pooledClaim(page, 'CP', 'RG-TC026', { assignmentType: 'Bodily Injury', lossCause: 'LC03' });
  R.setClaim(ti, claim.cn, process.env.CC_USER);
  const addNote = async (text) => {
    await S.action(page, /^Note$|New Note/i);
    await A.selectByLabel(page, 'Topic', /^(?!<none>$).+/).catch(() => {});
    const body = page.locator('textarea').filter({ visible: true }).first();
    await body.fill(text);
    await W.clickButton(page, 'Update');
  };
  const t1 = `Regression TC026 note at FNOL ${Date.now()}`;
  await B.openExistingClaim(page, claim.cn);
  await addNote(t1);
  await R.step(page, ti, `Note 1 added right after FNOL: ${t1}`);
  await page.goto(B.BASE_URL, { waitUntil: 'domcontentloaded' });
  await B.openExistingClaim(page, claim.cn);
  const t2 = `Regression TC026 post-FNOL note ${Date.now()}`;
  await addNote(t2);
  await S.nav(page, 'Notes');
  const body = await S.bodyText(page);
  await R.check(page, ti, { description: 'Both notes listed on Notes', expected: `${t1} and ${t2}`, actual: `${body.includes(t1) ? 'note 1 shown' : 'note 1 missing'}, ${body.includes(t2) ? 'note 2 shown' : 'note 2 missing'}`, ok: body.includes(t1) && body.includes(t2) });
  ti.annotations.push({ type: 'manual', description: 'A note inside the FNOL wizard itself is not driven — note 1 is added right after Finish.' });
}));

test('RG-TC033 [VindicateRecallListAPI]: Vehicle Recall on a vehicle exposure', async ({ page }, ti) => S.blockable(test, async () => {
  // Its own claim (the exposure gets closed) — never the shared registry claim.
  const cn = process.env.REG_CLAIM_PA_RECALL || (await S.fileClaim(page, 'PA', 'RG-TC033', { assignmentType: 'Casualty', lossCause: 'LC15', pool: false })).cn;
  await B.loginToClaimCenter(page);
  await R.makeViewable(page, cn);
  await S.openExposureMatching(page, 'Collision|Comprehensive');
  const s = await S.readScreen(page);
  const btn = s.buttons.find((b) => /vehicle recall/i.test(b));
  await R.check(page, ti, { description: 'Vehicle Recall button on the vehicle exposure', expected: 'Vehicle Recall', actual: btn || `buttons: ${s.buttons.join(', ').slice(0, 300)}`, ok: !!btn });
  await W.clickButton(page, btn);
  const after = await S.bodyText(page);
  await R.check(page, ti, { description: 'Vehicle Recall page shows decoded status and recall list', expected: 'decode status + recall list', actual: after.slice(0, 400), ok: /recall/i.test(after) && /decod|status/i.test(after) });
  // Steps 6–7: close the exposure (open activities completed first, DMEC0002 accepted) and re-open Vehicle Recall.
  const c = await S.closeExposure(page, cn, 'Collision|Comprehensive', { acceptDmec: true });
  await R.check(page, ti, { description: 'Vehicle exposure closed', expected: 'closed', actual: `${c.closed ? 'closed' : 'not closed'} ${c.messages.join(' | ')}`, ok: c.closed });
  await S.openExposureMatching(page, 'Collision|Comprehensive');
  const s2 = await S.readScreen(page);
  const btn2 = s2.buttons.find((b) => /vehicle recall/i.test(b));
  if (btn2) await W.clickButton(page, btn2);
  const after2 = await S.bodyText(page);
  await R.check(page, ti, { description: 'Vehicle Recall still shows decoded status + recall list on the closed exposure', expected: 'recall details', actual: btn2 ? after2.slice(0, 300) : 'no Vehicle Recall button on the closed exposure', ok: !!btn2 && /recall/i.test(after2) });
  R.setClaim(ti, cn);
}));

test('RG-TC041 [CCC]: Appraisal tab on an existing claim vehicle incident; Point of Impact required', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await S.claimFor(page, ti, 'REG_CLAIM_PA', 'PA', 'RG-TC041');
  await S.openExposureMatching(page, 'Collision|Comprehensive');
  await page.getByText('Appraisal', { exact: true }).first().click().catch(() => {});
  await W.settle(page, 2000);
  const body = await S.bodyText(page);
  await R.check(page, ti, { description: 'Appraisal tab available', expected: 'Appraisal tab opens', actual: /Point of Impact/i.test(body) ? 'Appraisal content shown' : body.slice(0, 200), ok: /Point of Impact/i.test(body) });
  await W.clickButton(page, 'Edit');
  const poi = S.findField(await S.readScreen(page), 'Primary Point of Impact') || S.findField(await S.readScreen(page), 'Point of Impact');
  await R.check(page, ti, { description: 'Point of Impact is required', expected: 'required', actual: poi ? `required=${poi.required}` : 'field not found', ok: !!poi && poi.required });
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
  R.setClaim(ti, cn);
}));

test('RG-TC042 [CCC]: CCC Claim View button launches CCC', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await S.claimFor(page, ti, 'REG_CLAIM_PA', 'PA', 'RG-TC042');
  await S.openExposureMatching(page, 'Collision|Comprehensive');
  const s = await S.readScreen(page);
  const btn = s.buttons.find((b) => /CCC/i.test(b));
  await R.check(page, ti, { description: 'CCC Claim View button on the vehicle exposure', expected: 'CCC Claim View', actual: btn || `buttons: ${s.buttons.join(', ').slice(0, 300)}`, ok: !!btn });
  const popup = page.waitForEvent('popup', { timeout: 20000 }).catch(() => null);
  await page.getByRole('button', { name: btn, exact: true }).first().click();
  const p = await popup;
  await R.step(page, ti, `CCC launch: ${p ? `new window ${p.url()}` : 'no new window within 20s'}`);
  ti.annotations.push({ type: 'manual', description: 'Confirm by hand that CCC shows the claim after SSO (external site).' });
  if (p) await p.close().catch(() => {});
  R.setClaim(ti, cn);
}));
