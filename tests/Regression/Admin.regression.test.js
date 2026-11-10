/**
 * tests/Regression/Admin.regression.test.js — Regression Test Design V1.0: System Administration (TC047, TC048),
 * Review & Team Metrics (TC049), Claim Purge (TC075), WSAP Integration page (TC080). Read-only except TC080's submit.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, B, E } = S;

S.hooks(test);

const list = (env, dflt) => (process.env[env] ? process.env[env].split(',') : dflt).map((s) => s.trim()).filter(Boolean);
const ADL_USERS = ['keiteise', 'defaultowner', 'su', 'sys', 'stevklip', 'samaent', 'thomrich', 'lorikibl', 'davidubo', 'marcvinc', 'kylehain', 'teresher', 'terrcoco', 'keviruiz', 'vernande', 'betthald', 'nancrica', 'joshmanm', 'amanspic'];
const ADL_GROUPS = ['Auto Med/Midwest WC', 'Auto Medical Clerical/PPO', 'Auto Medical Team', 'Auto Medical Unit', 'Bodily Injury Claims Division', 'Bodily Injury Clerical', 'Bodily Injury Mgr 1'];

// Administration › Users & Security › Users|Groups: search each name, keep what the result grid shows.
async function searchAdmin(page, kind, names) {
  await S.openAdmin(page, 'Users & Security', kind);
  const box = kind === 'Users' ? (S.findField(await S.readScreen(page), 'Username') || S.findField(await S.readScreen(page), 'User Name')) : S.findField(await S.readScreen(page), 'Group Name') || S.findField(await S.readScreen(page), 'Name');
  if (!box) throw new W.Blocked(`no search box on Administration › ${kind}`);
  const out = {};
  for (const n of names) {
    await S.A.fillByLabel(page, box.label, n);
    await W.clickButton(page, 'Search');
    const rows = await R.gridRows(page);
    out[n] = rows.find((r) => r.toLowerCase().includes(n.toLowerCase())) || null;
  }
  return out;
}

test('RG-TC047 [System Administration]: User names match the ADL', async ({ page }, ti) => S.blockable(test, async () => {
  S.need(test, 'CC_ADMIN_USER', 'CC_ADMIN_PASS');
  const names = list('REG_ADL_USERS', ADL_USERS);
  const found = await searchAdmin(page, 'Users', names);
  const missing = names.filter((n) => !found[n]);
  await R.check(page, ti, { description: `ADL user names (${names.length}) exist`, expected: names.join(', '), actual: missing.length ? `missing: ${missing.join(', ')}` : 'all found', ok: !missing.length });
  if (!process.env.REG_ADL_USERS) ti.annotations.push({ type: 'manual', description: 'Checked the 19 names listed in the TC; set REG_ADL_USERS to the full ADL list.' });
}));

test('RG-TC048 [System Administration]: Group names match the ADL', async ({ page }, ti) => S.blockable(test, async () => {
  S.need(test, 'CC_ADMIN_USER', 'CC_ADMIN_PASS');
  const names = list('REG_ADL_GROUPS', ADL_GROUPS);
  const found = await searchAdmin(page, 'Groups', names);
  const missing = names.filter((n) => !found[n]);
  await R.check(page, ti, { description: `ADL group names (${names.length}) exist`, expected: names.join(', '), actual: missing.length ? `missing: ${missing.join(', ')}` : 'all found', ok: !missing.length });
}));

test('RG-TC049 [Review & Team Metrics]: Group supervisor sees Team and My Groups', async ({ page }, ti) => S.blockable(test, async () => {
  S.need(test, 'CC_TEAM_PASS');
  const sup = process.env.REG_TEAM_SUPERVISOR || E.TEAMS.Auto.supervisor;
  await B.loginToClaimCenter(page, { username: sup, password: process.env.CC_TEAM_PASS });
  const team = page.locator('#TabBar-TeamTab [role="menuitem"]').first();
  const hasTeam = await team.isVisible().catch(() => false) || await S.nav(page, 'Team');
  await R.check(page, ti, { description: `Team tab visible for supervisor ${sup}`, expected: 'Team tab', actual: hasTeam ? 'shown' : 'not shown', ok: !!hasTeam });
  if (await team.isVisible().catch(() => false)) await team.click({ force: true });
  await W.settle(page, 3000);
  const body = await S.bodyText(page);
  await R.check(page, ti, { description: 'My Groups lists the groups the supervisor manages', expected: 'My Groups with group rows', actual: (body.match(/My Groups[\s\S]{0,300}/) || ['My Groups not shown'])[0].replace(/\s+/g, ' '), ok: /My Groups/i.test(body) });
  ti.annotations.push({ type: 'manual', description: 'Step 4 (on-prem vs cloud dropdowns/columns/buttons) is manual.' });
}));

test('RG-TC075 [Claim Purge]: "Purge claim ISO folders" message queue (ID 33) removed', async ({ page }, ti) => S.blockable(test, async () => {
  S.need(test, 'CC_ADMIN_USER', 'CC_ADMIN_PASS');
  await S.openAdmin(page, 'Monitoring', 'Message Queues');
  const rows = await R.gridRows(page);
  const hit = rows.filter((r) => /purge claim ISO/i.test(r) || /^\s*33\b/.test(r));
  await R.step(page, ti, `Message Queues: ${rows.length} rows`);
  await R.check(page, ti, { description: 'No "Purge claim ISO folders" queue', expected: 'absent', actual: hit.join(' | ') || 'absent', ok: !hit.length && rows.length > 0 });
}));

test('RG-TC080 [WSAP Integration]: ClaimSurvey through the WSAP Integration testing page', async ({ page }, ti) => S.blockable(test, async () => {
  const [procId, param, input] = S.need(test, 'CC_ADMIN_USER', 'REG_WSAP_PROC_ID', 'REG_WSAP_PROC_PARAM', 'REG_WSAP_INPUT').slice(1);
  await S.openAdmin(page, 'Testing', /WSAP/i);
  await S.A.fillByLabel(page, 'PROC ID', procId).catch(() => S.A.fillByLabel(page, 'Proc ID', procId));
  await S.A.fillByLabel(page, 'PROC PRAM', param).catch(() => S.A.fillByLabel(page, 'Proc Param', param));
  await S.A.fillByLabel(page, 'Input', input);
  await W.clickButton(page, 'Submit');
  const s = await S.readScreen(page);
  await R.check(page, ti, { description: 'WSAP data retrieved', expected: 'response populated, no error', actual: (s.messages.join(' | ') || s.body.slice(0, 400)), ok: !s.messages.some((m) => /error|exception/i.test(m)) && s.body.length > 200 });
}));

// TC084: a transaction that used to send an individual legacy email no longer does. ClaimCenter side: the payment's
// History / Documents show no per-transaction email, and no new outbound email message is queued for the claim.
// Mailbox / mail-log / consolidated report checks stay manual (no mailbox access from the framework).
test('RG-TC084 [Notifications]: No individual email per transaction', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await R.sharedClaim(page, 'PA', 'RG-TC084', { reserveActions: 1 });
  R.setClaim(ti, cn, process.env.CC_USER);
  await S.CO.historyMark(page);
  await B.openExistingClaim(page, cn);
  const pay = await S.P.makePayment(page, { amount: S.P.uniqueAmount(15) });
  await R.step(page, ti, `Transaction: payment $${pay.amount} (${pay.finished ? 'finished' : pay.messages.join(' | ')})`);
  const hist = await S.CO.historySince(page);
  await R.check(page, ti, { description: 'History: no email-sent event for the transaction', expected: 'no "email" history entry', actual: hist, ok: !/e-?mail (sent|notification)/i.test(hist) });
  await S.nav(page, 'Documents').catch(() => {});
  const docs = (await R.gridRows(page)).filter((r) => /e-?mail/i.test(r) && r.includes(new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })));
  await R.check(page, ti, { description: 'Documents: no per-transaction email document today', expected: 'none', actual: docs.join(' | ') || 'none', ok: !docs.length });
  if (process.env.CC_ADMIN_USER) {
    const ctx = await page.context().browser().newContext();
    const p = await ctx.newPage();
    try {
      await S.openAdmin(p, 'Monitoring', 'Message Queues');
      const rows = (await R.gridRows(p)).filter((r) => /e-?mail/i.test(r));
      await R.step(page, ti, `Email destinations on Message Queues: ${rows.join(' || ') || 'none listed'}`);
    } finally { await ctx.close().catch(() => {}); }
  }
  ti.annotations.push({ type: 'manual', description: 'Steps 2–3: test mailbox / outbound mail log show no per-notice email, and the consolidated report email arrives on schedule.' });
}));
