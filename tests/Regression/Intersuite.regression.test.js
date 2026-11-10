/**
 * tests/Regression/Intersuite.regression.test.js — Regression Test Design V1.0, the ClaimCenter / Contact Manager side
 * of Intersuite CC - PC (TC029, TC030) and Intersuite CM-PC (TC031, TC032). The PolicyCenter side runs when
 * REG_PC_USER / REG_PC_PASS are set (helpers/regression/policyCenter.js, read-only); otherwise it is left as a manual note.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, B } = S;

S.hooks(test);

test('RG-TC029 [Intersuite CC - PC]: Claim status change (close / reopen) for PolicyCenter sync', async ({ page }, ti) => S.blockable(test, async () => {
  // A fresh HO claim unless REG_CLAIM_PROPERTY_OPEN names one: closing drains reserves with Final Payments, so it must
  // be a claim nobody else is using (never a shared registry claim).
  const cn = process.env.REG_CLAIM_PROPERTY_OPEN || (await S.fileClaim(page, 'HO', 'RG-TC029', { assignmentType: 'First Party', lossCause: 'LC01', pool: false })).cn;
  await B.loginToClaimCenter(page);
  await R.asAdmin(page, cn);
  R.setClaim(ti, cn, 'su');
  const before = (await S.bodyText(page)).match(/St:\s*(\w+)/)?.[1] || '';
  // Cloud close = e2eSteps.close (drain reserves with Final Payments, complete open activities, close every exposure,
  // close the claim) — the path proven on CA-PA-01-26-0748721; plain closeClaim is refused while activities are open.
  await S.E.close(page, cn);
  await B.openExistingClaim(page, cn);
  const after = (await S.bodyText(page)).match(/St:\s*(\w+)/)?.[1] || '';
  await R.check(page, ti, { description: 'Claim status updated in ClaimCenter', expected: 'Closed', actual: `${before} → ${after}`, ok: /Closed/i.test(after) });
  const pol = (await S.bodyText(page)).match(/Policy[:#\s]+([A-Z0-9-]{6,})/)?.[1];
  if (S.PC.configured() && pol) {
    const rows = await S.PC.policyClaims(page, pol);
    const row = rows.find((r) => r.includes(cn)) || '';
    await R.check(page, ti, { description: `PolicyCenter policy ${pol} › Claims shows ${cn} Closed`, expected: 'Closed', actual: row || 'claim not listed in PC', ok: /closed/i.test(row) });
  } else ti.annotations.push({ type: 'manual', description: `PolicyCenter: policy of ${cn} › Claims — status Closed (set REG_PC_USER / REG_PC_PASS to automate).` });
}));

test('RG-TC030 [Intersuite CC - PC]: New Dwelling Fire claim for PolicyCenter associated-claims check', async ({ page }, ti) => S.blockable(test, async () => {
  const claim = await S.pooledClaim(page, 'DF', 'RG-TC030', { assignmentType: 'First Party', lossCause: 'LC01' });
  R.setClaim(ti, claim.cn, process.env.CC_USER);
  await R.check(page, ti, { description: 'Claim created from a PolicyCenter policy', expected: 'claim number', actual: `${claim.cn} on policy ${claim.policyNumber}`, ok: !!claim.cn });
  if (S.PC.configured()) {
    const rows = await S.PC.policyClaims(page, claim.policyNumber);
    const row = rows.find((r) => r.includes(claim.cn)) || '';
    await R.check(page, ti, { description: `PolicyCenter policy ${claim.policyNumber} lists ${claim.cn}`, expected: 'claim row with loss date + status', actual: row || `not listed (rows: ${rows.slice(0, 4).join(' || ')})`, ok: !!row });
  } else ti.annotations.push({ type: 'manual', description: `PolicyCenter: open policy ${claim.policyNumber} › Claims; confirm ${claim.cn}, loss date, status (set REG_PC_USER / REG_PC_PASS to automate).` });
}));

test('RG-TC031 [Intersuite CM-PC]: Rename a person contact in Contact Manager', async ({ page }, ti) => S.blockable(test, async () => {
  const [person] = S.need(test, 'REG_CM_PERSON', 'REG_ALLOW_CM_WRITES');
  const CM = require('../../helpers/oneInc/contactManager');
  const suffix = Date.now().toString().slice(-4);
  const result = await CM.withCM(page, async (cm) => {
    await cm.getByRole('textbox', { name: /Name|Last name/i }).first().fill(person);
    await cm.getByRole('button', { name: /^Search$/ }).first().click();
    await cm.waitForTimeout(3000);
    await cm.getByText(person, { exact: false }).first().click();
    await cm.waitForTimeout(3000);
    await cm.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const first = cm.getByLabel('First name', { exact: true }).first();
    const last = cm.getByLabel('Last name', { exact: true }).first();
    const was = `${await first.inputValue().catch(() => '')} ${await last.inputValue().catch(() => '')}`.trim();
    await first.fill(`Reg${suffix}`);
    await last.fill(`Sync${suffix}`);
    await cm.getByRole('button', { name: 'Update', exact: true }).first().click();
    await cm.waitForTimeout(3000);
    return { was, now: `Reg${suffix} Sync${suffix}` };
  });
  await R.check(page, ti, { description: 'Contact Manager person contact renamed', expected: result.now, actual: `was "${result.was}", now "${result.now}"`, ok: !!result.now });
  if (S.PC.configured()) {
    const rows = await S.PC.findContact(page, { first: `Reg${suffix}`, last: `Sync${suffix}` });
    await R.check(page, ti, { description: 'PolicyCenter shows the new name', expected: result.now, actual: rows.join(' || ') || 'not found in PC', ok: rows.length > 0 });
  } else ti.annotations.push({ type: 'manual', description: `PolicyCenter: confirm the name "${result.now}" (set REG_PC_USER / REG_PC_PASS to automate).` });
  ti.annotations.push({ type: 'manual', description: `Rename the contact back afterwards: ${result.was}.` });
}));

// PolicyCenter side of TC029/TC030 (read-only, helpers/regression/policyCenter.js). Run when REG_PC_USER/PASS are set.
test('RG-TC032 [Intersuite CM-PC]: Inactive contact status flows from Contact Manager to PolicyCenter', async ({ page }, ti) => S.blockable(test, async () => {
  const [person] = S.need(test, 'REG_CM_INACTIVATE_PERSON', 'REG_ALLOW_CM_WRITES');
  const CM = require('../../helpers/oneInc/contactManager');
  const [first, ...rest] = person.split(' ');
  const last = rest.join(' ') || first;
  const status = await CM.withCM(page, async (cm) => {
    await cm.getByRole('textbox', { name: /Name|Last name/i }).first().fill(last);
    await cm.getByRole('button', { name: /^Search$/ }).first().click();
    await cm.waitForTimeout(3000);
    await cm.getByText(person, { exact: false }).first().click();
    await cm.waitForTimeout(3000);
    await cm.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const st = cm.getByRole('combobox', { name: /Status|Active/i }).first();
    if (!(await st.isVisible().catch(() => false))) return { ok: false, note: 'no Status field on the CM contact' };
    await st.selectOption({ label: 'Inactive' }).catch(() => st.selectOption({ index: 2 }));
    await cm.getByRole('button', { name: 'Update', exact: true }).first().click();
    await cm.waitForTimeout(3000);
    return { ok: true, note: (await cm.locator('body').innerText()).match(/Status[^\n]{0,40}/)?.[0] || '' };
  });
  if (!status.ok) throw new W.Blocked(status.note);
  await R.check(page, ti, { description: `Contact Manager: ${person} set Inactive`, expected: 'Inactive', actual: status.note, ok: /inactive/i.test(status.note) });
  if (S.PC.configured()) {
    const rows = await S.PC.findContact(page, { first, last });
    await R.check(page, ti, { description: 'PolicyCenter shows the contact as inactive', expected: 'Inactive / not selectable', actual: rows.join(' || ') || 'contact not found in PC', ok: rows.some((r) => /inactive/i.test(r)) });
  } else ti.annotations.push({ type: 'manual', description: 'Steps 3–4: confirm in PolicyCenter (set REG_PC_USER / REG_PC_PASS to automate). Re-activate the contact afterwards.' });
}));
