/**
 * tests/Regression/Integrations.regression.test.js — Regression Test Design V1.0, the ClaimCenter side of outside
 * integrations: Metro (TC027), Catastrophe display (TC028), ISO (TC056, TC057), Symbility (TC066).
 * Anything that sends to a vendor runs only with REG_ALLOW_EXTERNAL=1. The vendor side is verified by hand.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, B, A } = S;

S.hooks(test);

test('RG-TC027 [Metro]: Request a Metro police report', async ({ page }, ti) => S.blockable(test, async () => {
  S.external(test, 'the Metro reporting vendor');
  const cn = await S.claimFor(page, ti, 'REG_CLAIM_PA', 'PA', 'RG-TC027');
  await S.action(page, /metro/i);
  const s = await S.readScreen(page);
  const type = S.findField(s, 'Report Type') || s.fields.find((f) => f.kind === 'select' && /type/i.test(f.label));
  await R.check(page, ti, { description: 'Metro page with a report-type dropdown', expected: 'report types listed', actual: type ? (type.options || []).join(' | ') : 'no report type dropdown', ok: !!type && (type.options || []).length > 1 });
  await W.select(page, type.label, 0);
  await W.fill(page, (S.findField(await S.readScreen(page), 'City') || {}).label || 'City', 'Harrisburg');
  const st = S.findField(await S.readScreen(page), 'State');
  await R.check(page, ti, { description: 'Investigating agency State is a dropdown of states', expected: 'select with states', actual: st ? `${st.kind}: ${(st.options || []).length} options` : 'missing', ok: !!st && st.kind === 'select' && (st.options || []).length > 40 });
  await W.select(page, st.label, 'Pennsylvania');
  await A.fillRequired(page).catch(() => {});
  await W.clickButton(page, 'Submit').catch(() => W.clickButton(page, 'Update'));
  await A.openLossDetailsGeneral(page);
  const rows = (await R.gridRows(page)).filter((r) => /metro|police/i.test(r));
  await R.check(page, ti, { description: "Request listed under Loss Details › 'Metro Reports' (type, status, date ordered)", expected: 'a Metro report row', actual: rows.join(' | ') || 'none', ok: rows.length > 0 });
  ti.annotations.push({ type: 'manual', description: '"Received" status comes back from the vendor — check later.' });
  R.setClaim(ti, cn);
}));

test('RG-TC028 [Catastrophe]: CAT shown on Loss Details and Summary', async ({ page }, ti) => S.blockable(test, async () => {
  S.need(test, 'REG_CAT_CLAIM');
  await S.claimFor(page, ti, 'REG_CAT_CLAIM', 'PA', 'RG-TC028');
  await A.openLossDetailsGeneral(page);
  const cat = S.findField(await S.readScreen(page), 'Catastrophe') || S.findField(await S.readScreen(page), 'CAT');
  await R.check(page, ti, { description: 'Loss Details › General shows CAT (No – Name – Start – End)', expected: 'e.g. 02-2012: Tornadoes, Wind and Hail – 06/29/2012 to 07/01/2012', actual: cat ? cat.value : 'no Catastrophe field', ok: !!cat && /\d/.test(cat.value) });
  await W.navigate(page, 'summary');
  const body = await S.bodyText(page);
  const line = (body.match(/CAT[^\n]{0,120}/i) || [])[0];
  await R.check(page, ti, { description: 'Summary › Overview › Loss Details shows the CAT entry', expected: 'CAT Loss – <number>: <name> – <dates>', actual: line || 'no CAT text on Summary', ok: !!line });
  ti.annotations.push({ type: 'manual', description: 'Selecting the CAT in FNOL Step 3 and CLV10100/CLV10200 are manual (picker modal; needs an active Donegal CAT event).' });
}));

// ISO status lives on the claim (Loss Details / ISO section): Status SENT, Date Sent, Last Response. Polled — async.
async function isoStatus(page, cn, maxMin = 10) {
  let seen = '';
  let pressed = false;
  for (let t = 0; t < maxMin * 2; t++) {
    const r = await S.isoTab(page, cn, { send: !pressed }); // "None" hours after FNOL on TEST - press Send To ISO once
    pressed = pressed || r.pressed;
    seen = `status=${r.status || '?'}; sent=${r.sent || '?'}; response=${r.resp || '?'}${pressed ? ' (Send To ISO pressed by the test)' : ''}`;
    if (/sent|accepted/i.test(r.status)) return { ok: true, seen, sent: r.sent, resp: r.resp, insights: /Claim ?InSights/i.test(r.body) };
    await page.waitForTimeout(30000);
  }
  return { ok: false, seen };
}

test('RG-TC056 [ISO - The Insurance Services Office]: BOP claim + exposure sent to ISO', async ({ page }, ti) => S.blockable(test, async () => {
  const claim = await S.pooledClaim(page, 'BOP', 'RG-TC056', { assignmentType: 'Bodily Injury', lossCause: 'LC03' });
  R.setClaim(ti, claim.cn, process.env.CC_USER);
  const iso = await isoStatus(page, claim.cn);
  await R.check(page, ti, { description: 'Loss sent to ISO without error', expected: 'Status SENT, Date Sent = today, Last Response NO ERROR', actual: iso.seen, ok: iso.ok && !/error/i.test(String(iso.resp || '').replace(/no error/i, '')) });
  await R.check(page, ti, { description: 'ISO Claim InSights link available', expected: 'link shown', actual: iso.insights ? 'shown' : 'not found', ok: !!iso.insights });
  ti.annotations.push({ type: 'manual', description: 'Steps 2–4 repeat with other exposures — re-run the case; ISO ClaimSearch side is external.' });
}));

test('RG-TC057 [ISO - The Insurance Services Office]: Personal Auto collision exposure sent to ISO', async ({ page }, ti) => S.blockable(test, async () => {
  const claim = await S.pooledClaim(page, 'PA', 'RG-TC057', { assignmentType: 'Casualty', lossCause: 'LC15' });
  R.setClaim(ti, claim.cn, process.env.CC_USER);
  const iso = await isoStatus(page, claim.cn);
  await R.check(page, ti, { description: 'Collision loss sent to ISO without error', expected: 'Status SENT', actual: iso.seen, ok: iso.ok });
  // Steps 2–3 (CC side): a payment, then its void — each change is re-sent to ISO (Date Sent moves, no error).
  await R.asAdmin(page, claim.cn);
  await S.E.repairCloud(page, claim.cn).catch(() => {});
  await S.F.createReserve(page, { reserveAmount: 900, exposure: 'Collision', strict: false });
  process.env.ONEINC_ALLOW_FINISH = process.env.ONEINC_ALLOW_FINISH || (['test', 'dev'].includes(B.TIER) ? '1' : '');
  const said = await S.CO.createFullCheck(page, { payee: 'claimant' });
  await R.step(page, ti, said);
  await S.CO.openNewestCheck(page).catch(() => {});
  await S.CO.submitVoid(page).catch((e) => ti.annotations.push({ type: 'manual', description: `void not submitted: ${e.message}` }));
  const iso2 = await isoStatus(page, claim.cn, 6);
  await R.check(page, ti, { description: 'After payment + void the claim is re-sent to ISO', expected: 'Status SENT, Date Sent updated, no error', actual: `${iso.seen} → ${iso2.seen}`, ok: iso2.ok && iso2.seen !== iso.seen });
  ti.annotations.push({ type: 'manual', description: 'Total Loss indicator inside ISO ClaimSearch (external) and the salvage step — by hand.' });
}));

test('RG-TC066 [Symbility]: Send a property claim to Symbility', async ({ page }, ti) => S.blockable(test, async () => {
  S.external(test, 'Symbility');
  const claim = await S.pooledClaim(page, 'HO', 'RG-TC066', { assignmentType: 'First Party', lossCause: 'LC01' });
  R.setClaim(ti, claim.cn, process.env.CC_USER);
  await B.openExistingClaim(page, claim.cn);
  await A.openLossDetailsGeneral(page);
  await A.editAndSave(page, 'Loss Details (Xactimate = No)', async () => {
    const q = S.findField(await S.readScreen(page), 'Send claim to Xactimate?') || (await S.readScreen(page)).fields.find((f) => f.radios && /xactimate/i.test(f.label));
    if (!q) throw new W.Blocked('no Xactimate question on Loss Details');
    await W.answer(page, q.label, 'No');
  });
  await A.openLossDetailsGeneral(page);
  const s = await S.readScreen(page);
  const btn = s.buttons.find((b) => /symbility/i.test(b));
  await R.check(page, ti, { description: '"Send to Symbility" enabled on Loss Details', expected: 'button shown', actual: btn || 'not shown', ok: !!btn });
  await W.clickButton(page, btn);
  const msgs = await R.pageMessages(page);
  await R.check(page, ti, { description: 'Claim created in Symbility message', expected: 'success message', actual: msgs.join(' | ') || 'no message', ok: msgs.some((m) => /symbility/i.test(m) && !/error|fail/i.test(m)) });
  ti.annotations.push({ type: 'manual', description: 'Search the claim in Symbility; Cause of Loss = Type of Loss; COL change reflected (steps 12–15).' });
}));

// ── Hi Marley (TC036, TC037). External: runs only with REG_ALLOW_EXTERNAL=1. ───────────────────────────────────────
test('RG-TC036 [Hi Marley]: Single sign-on to Hi Marley', async ({ page }, ti) => S.blockable(test, async () => {
  S.external(test, 'Hi Marley');
  const [email] = S.need(test, 'REG_HIMARLEY_EMAIL');
  const url = process.env.REG_HIMARLEY_URL || 'https://chat.uat.himarley.ai';
  const p = await page.context().newPage();
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    const box = p.getByRole('textbox', { name: /email/i }).first();
    await box.waitFor({ state: 'visible', timeout: 30000 });
    await box.fill(email);
    await p.getByRole('button', { name: /^Next$/i }).first().click();
    await p.waitForLoadState('networkidle').catch(() => {});
    await p.waitForTimeout(8000);
    const pwd = await p.locator('input[type="password"]').first().isVisible().catch(() => false);
    if (pwd) throw new W.Blocked('SSO asked for a password / MFA — this machine is not in the trusted network zone; log in by hand');
    const shot = ti.outputPath('himarley-sso.png');
    await p.screenshot({ path: shot });
    const signedIn = !/sign in|log in/i.test((await p.title()) + ' ' + (await p.locator('body').innerText().catch(() => '')).slice(0, 300));
    await R.check(page, ti, { description: `SSO for ${email}`, expected: 'Hi Marley inbox after Next (no password)', actual: `${p.url()} — ${signedIn ? 'signed in' : 'still on sign-in'}`, ok: signedIn });
  } finally { await p.close().catch(() => {}); }
}));

test('RG-TC037 [Hi Marley]: Texting from ClaimCenter — open case, opt-in, send text', async ({ page }, ti) => S.blockable(test, async () => {
  S.external(test, 'Hi Marley (texts a real phone)');
  const [mobile] = S.need(test, 'REG_HIMARLEY_MOBILE');
  const claim = await S.pooledClaim(page, 'PA', 'RG-TC037', { assignmentType: 'Casualty', lossCause: 'LC15' });
  R.setClaim(ti, claim.cn, process.env.CC_USER);
  await B.openExistingClaim(page, claim.cn);
  // Contact with the mobile number (wizardDriver.addClaimPersonContact, then the Mobile field on the same screen).
  const last = `Texting${Date.now().toString().slice(-4)}`;
  await W.addClaimPersonContact(page, { first: 'Regression', last, role: 'Claimant' }).catch(() => {});
  await page.locator('tr').filter({ hasText: last.toUpperCase() }).first().click().catch(() => {});
  await A.editAndSave(page, 'mobile number', async () => { await A.fillByLabel(page, 'Mobile', mobile).catch(() => A.fillByLabel(page, 'Cell Phone', mobile)); });
  const s = await S.readScreen(page);
  await R.check(page, ti, { description: 'No "Enroll in Hi Marley" button', expected: 'absent', actual: s.buttons.filter((b) => /hi ?marley/i.test(b)).join(', ') || 'absent', ok: !s.buttons.some((b) => /enroll in hi ?marley/i.test(b)) });
  if (!(await S.nav(page, /Hi ?Marley/i))) throw new W.Blocked('no Hi Marley Cases section on the claim');
  await W.clickButton(page, 'Open Case');
  const pick = S.findField(await S.readScreen(page), 'Contact') || (await S.readScreen(page)).fields.find((f) => f.kind === 'select');
  if (pick) await A.selectByLabel(page, pick.label, new RegExp(last, 'i')).catch(() => {});
  await W.clickButton(page, 'Update').catch(() => W.clickButton(page, 'Open Case'));
  const msgs = await R.pageMessages(page);
  await R.check(page, ti, { description: 'Hi Marley case opened', expected: 'case row / no error', actual: msgs.join(' | ') || (await R.gridRows(page)).slice(0, 3).join(' || '), ok: !msgs.some((m) => /error|fail/i.test(m)) });
  ti.annotations.push({ type: 'manual', description: `Reply YES on ${mobile}; the case then waits up to 5 minutes for Opt In.` });
  let opted = '';
  for (let t = 0; t < 10 && !/opt.?ed.?in|yes/i.test(opted); t++) {
    await page.waitForTimeout(30000);
    await B.openExistingClaim(page, claim.cn);
    await S.nav(page, /Hi ?Marley/i);
    opted = (await R.gridRows(page)).join(' || ');
  }
  await R.check(page, ti, { description: 'Opt In status changes in ClaimCenter after the reply', expected: 'Opted In', actual: opted || 'no case rows', ok: /opt.?ed.?in/i.test(opted) });
  await W.clickButton(page, 'Send Text');
  await page.locator('textarea').filter({ visible: true }).first().fill(`Regression TC037 ${claim.cn}`);
  await W.clickButton(page, 'Send');
  await R.step(page, ti, `Text sent: ${(await R.pageMessages(page)).join(' | ') || 'no message'} — confirm it arrived on ${mobile}`);
}));
