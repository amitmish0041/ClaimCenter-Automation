/**
 * tests/Regression/Rules.regression.test.js — Regression Test Design V1.0: Additional Rules (TC050, TC051),
 * CAA — claim access (TC052), Reporting Microservice sensitive-claim access (TC085, direct-access half).
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, B, A, E, L } = S;

S.hooks(test);

const REASSIGNED = /REASSIGNED CLAIM/i;

test('RG-TC050 [Additional Rules]: REASSIGNED CLAIM activity on user then group reassignment (DMGA350, DMDA0130)', async ({ page }, ti) => S.blockable(test, async () => {
  const claim = await S.fileClaim(page, 'PA', 'RG-TC050', { assignmentType: 'Casualty', lossCause: 'LC15', pool: false });
  const cn = claim.cn;
  R.setClaim(ti, cn, process.env.CC_USER);
  const user = process.env.REG_REASSIGN_USER || 'Benjamin Smith';
  await B.openExistingClaim(page, cn);
  await L.assignClaim(page, user);
  await B.openExistingClaim(page, cn);
  const header = await S.bodyText(page);
  await R.check(page, ti, { description: `Claim header shows the new adjuster (${user})`, expected: user, actual: (header.match(/Adj:\s*[^\n]+/) || ['no Adj: in header'])[0], ok: header.includes(user) });
  const r1 = await S.activities(page, cn, REASSIGNED);
  await R.check(page, ti, { description: 'First REASSIGNED CLAIM activity (group = claim group, assigned to claim owner)', expected: `REASSIGNED CLAIM assigned to ${user}`, actual: r1.join(' | ') || 'none', ok: r1.some((r) => r.includes(user)) });
  // Group reassignment: Actions › Assign Claim, "Assign to a group" choice by label.
  const group = process.env.REG_REASSIGN_GROUP;
  if (!group) throw new W.Blocked('set REG_REASSIGN_GROUP (a group to reassign the claim to) for the group half — the user half passed');
  await B.openExistingClaim(page, cn);
  await S.action(page, /^Assign/i);
  const s = await S.readScreen(page);
  const grpField = s.fields.find((f) => /group/i.test(f.label) && f.kind === 'select');
  if (!grpField) throw new W.Blocked(`no group picker on the Assign screen (fields: ${s.fields.map((f) => f.label).join(', ').slice(0, 300)})`);
  await A.selectByLabel(page, grpField.label, group);
  await W.clickButton(page, 'Assign');
  const r2 = await S.activities(page, cn, REASSIGNED);
  await R.check(page, ti, { description: 'Second REASSIGNED CLAIM activity: group = new group, assigned to FNOL Queue', expected: `${group} / FNOL Queue`, actual: r2.join(' | '), ok: r2.length > r1.length && r2.some((r) => /FNOL Queue/i.test(r)) });
}));

test('RG-TC051 [Additional Rules]: Loss cause changed after 120 days → warning activity to group supervisor (DMDA0135)', async ({ page }, ti) => S.blockable(test, async () => {
  const [cn] = S.need(test, 'REG_CLAIM_OLD120');
  await B.loginToClaimCenter(page);
  await R.makeViewable(page, cn);
  R.setClaim(ti, cn, process.env.CC_USER);
  await A.openLossDetailsGeneral(page);
  const s = await S.readScreen(page);
  const lossDate = (S.findField(s, 'Date of Loss') || S.findField(s, 'Loss Date') || {}).value || '';
  const ageDays = lossDate ? Math.floor((Date.now() - new Date(lossDate)) / 86400000) : NaN;
  await R.check(page, ti, { description: 'Claim older than 120 days', expected: '> 120 days', actual: `${lossDate} (${ageDays} days)`, ok: ageDays > 120 });
  const cause = S.findField(s, 'Loss Cause');
  await A.editAndSave(page, 'Loss Cause change', async () => {
    const opts = (S.findField(await S.readScreen(page), 'Loss Cause') || {}).options || [];
    const other = opts.find((o) => o && !/^<none>$/i.test(o) && o !== (cause && cause.value));
    if (!other) throw new W.Blocked('no other Loss Cause option');
    await A.selectByLabel(page, 'Loss Cause', other);
  });
  const rows = await S.activities(page, cn, /Loss Cause was changed after 120 days/i);
  await R.check(page, ti, { description: 'Warning activity created and assigned to the claim group supervisor', expected: '"Warning Loss Cause was changed after 120 days" → group supervisor', actual: rows.join(' | ') || 'none', ok: rows.length > 0 });
}));

test('RG-TC052 [CAA]: Claim without permission is refused, history records the attempt', async ({ page }, ti) => S.blockable(test, async () => {
  const [cn] = S.need(test, 'REG_CLAIM_RESTRICTED');
  await B.loginToClaimCenter(page);
  await B.openExistingClaim(page, cn).catch(() => {});
  const denied = await E.cannotView(page);
  await R.check(page, ti, { description: `${process.env.CC_USER} cannot view ${cn}`, expected: 'Cannot View Claim', actual: denied ? 'refused' : 'claim opened', ok: denied });
  await R.asAdmin(page, cn);
  R.setClaim(ti, cn, process.env.CC_ADMIN_USER);
  const hist = await S.CO.history(page);
  await R.check(page, ti, { description: 'History event for the refused view', expected: `${process.env.CC_USER} does not have permission to view the claim`, actual: hist, ok: /permission|not authori[sz]ed|cannot view/i.test(hist) });
}));

test('RG-TC085 [Reporting Microservice CC DB Integrations]: Sensitive claim open only for the role holder', async ({ page }, ti) => S.blockable(test, async () => {
  const [cn, user, pass] = S.need(test, 'REG_SENSITIVE_CLAIM', 'REG_SENSITIVE_USER', 'REG_SENSITIVE_PASS');
  await B.loginToClaimCenter(page, { username: user, password: pass });
  await B.openExistingClaim(page, cn).catch(() => {});
  const okFor = !(await E.cannotView(page));
  await R.check(page, ti, { description: `Role holder ${user} opens sensitive claim ${cn}`, expected: 'claim details shown', actual: okFor ? 'opened' : 'refused', ok: okFor });
  const flag = /sensitive/i.test(await S.bodyText(page));
  await R.step(page, ti, `Sensitive flag visible on the claim: ${flag}`);
  await B.loginToClaimCenter(page);
  await B.openExistingClaim(page, cn).catch(() => {});
  const refused = await E.cannotView(page);
  await R.check(page, ti, { description: `${process.env.CC_USER} (no role) is refused`, expected: 'access denied', actual: refused ? 'refused' : 'claim opened', ok: refused });
  await page.goto(`${B.BASE_URL}?ClaimNumber=${encodeURIComponent(cn)}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const direct = await E.cannotView(page) || !(await S.bodyText(page)).includes(cn);
  await R.check(page, ti, { description: 'Direct URL access refused for the user without the role', expected: 'no claim details', actual: direct ? 'no details shown' : 'claim details shown', ok: direct });
  R.setClaim(ti, cn, `${user} / ${process.env.CC_USER}`);
  ti.annotations.push({ type: 'manual', description: 'Report hyperlinks, invalid-claim links and audit logs (steps 2, 3, 5, 7, 8) are in the reporting microservice — manual.' });
}));
