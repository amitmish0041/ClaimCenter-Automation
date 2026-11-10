/**
 * tests/Regression/Contacts.regression.test.js — Regression Test Design V1.0: Contact Manager (TC005, TC006) and
 * Intersuite CC - CM (TC022, TC023). Cloud ClaimCenter.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, B } = S;

S.hooks(test);

const PHONE_FMT = /\(\d{3}\) \d{3}-\d{4}/;

// Parties Involved › Contacts grid rows (name / roles / phone / address), read as text rows.
async function contactRows(page) {
  await W.navigate(page, 'parties');
  await S.nav(page, 'Contacts').catch(() => {});
  return (await R.gridRows(page)).filter((r) => !/^Name\s+Roles?/i.test(r));
}

test('RG-TC005 [Contact Manager]: FNOL auto-populates Insured, Agent, Underwriter, Driver with roles and phone format', async ({ page }, ti) => S.blockable(test, async () => {
  const claim = await S.pooledClaim(page, 'PA', 'RG-TC005', { assignmentType: 'Casualty', lossCause: 'LC15' });
  R.setClaim(ti, claim.cn, process.env.CC_USER);
  await B.openExistingClaim(page, claim.cn);
  const rows = await contactRows(page);
  await R.step(page, ti, `Parties Involved › Contacts on ${claim.cn}: ${rows.join(' || ')}`);
  for (const role of ['Insured', 'Agent', 'Underwriter', 'Driver']) {
    const hit = rows.find((r) => new RegExp(`\\b${role}\\b`, 'i').test(r));
    await R.check(page, ti, { description: `${role} contact auto-populated`, expected: `a row with role ${role}`, actual: hit || 'none', ok: !!hit });
    const want = process.env[`REG_PC_${role.toUpperCase()}`];
    if (want) await R.check(page, ti, { description: `${role} name matches PolicyCenter`, expected: want, actual: hit || 'none', ok: !!hit && hit.toUpperCase().includes(want.toUpperCase()) });
  }
  const phones = rows.map((r) => (r.match(/\(?\d{3}\)?[ .-]?\d{3}-?\d{4}/) || [])[0]).filter(Boolean);
  await R.check(page, ti, { description: 'Phone numbers display as (XXX) XXX-XXXX', expected: '(XXX) XXX-XXXX', actual: phones.join(', ') || 'no phone numbers in the grid', ok: phones.length > 0 && phones.every((p) => PHONE_FMT.test(p)) });
  // Names vs PolicyCenter: read the policy's Summary / Contacts in PC (read-only) and look for each CC contact's surname.
  if (S.PC.configured()) {
    const pc = await S.PC.policyParties(page, claim.policyNumber);
    const pcText = (pc.summary + '\n' + pc.contacts).toUpperCase();
    for (const role of ['Insured', 'Agent', 'Underwriter', 'Driver']) {
      const row = rows.find((r) => new RegExp(`\\b${role}\\b`, 'i').test(r));
      if (!row) continue;
      const surname = row.trim().split(/\s+/).filter((w) => /^[A-Z][A-Za-z'-]{2,}$/.test(w)).slice(-1)[0] || '';
      await R.check(page, ti, { description: `${role} matches PolicyCenter (${claim.policyNumber})`, expected: row.slice(0, 60), actual: surname && pcText.includes(surname.toUpperCase()) ? `${surname} found in PC` : `${surname || '?'} not found in PC`, ok: !!surname && pcText.includes(surname.toUpperCase()) });
    }
  } else if (!['INSURED', 'AGENT', 'UNDERWRITER', 'DRIVER'].some((r) => process.env[`REG_PC_${r}`])) ti.annotations.push({ type: 'manual', description: 'PolicyCenter name match not checked — set REG_PC_USER / REG_PC_PASS (or REG_PC_INSURED / _AGENT / _UNDERWRITER / _DRIVER).' });
}));

test('RG-TC006 [Contact Manager]: Person contact phone number and extension validation', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await S.claimFor(page, ti, 'REG_CLAIM_PA', 'PA', 'RG-TC006');
  await W.navigate(page, 'parties');
  await page.locator('[id$="ClaimContacts_CreateNewContactButton"]').first().click(); // same control wizardDriver.addClaimPersonContact uses
  await page.waitForTimeout(1500);
  await page.getByRole('menuitem', { name: /^Person$/ }).first().click();
  await W.settle(page, 4000);
  await W.fill(page, 'First name', 'Regression');
  await W.fill(page, 'Last name', `Phone${Date.now().toString().slice(-5)}`);
  const phoneLabel = (S.findField(await S.readScreen(page), 'Work Phone') || S.findField(await S.readScreen(page), 'Primary Phone') || S.findField(await S.readScreen(page), 'Home Phone') || {}).label;
  if (!phoneLabel) throw new W.Blocked('no Work/Primary/Home Phone field on the New Person contact screen');
  const extLabel = (S.findField(await S.readScreen(page), `${phoneLabel} Ext`) || S.findField(await S.readScreen(page), 'Extension') || S.findField(await S.readScreen(page), 'Ext') || {}).label;
  const tryPhone = async (value) => { await W.fill(page, phoneLabel, value); const f = await S.field(page, phoneLabel); return { shown: f ? f.value : '', msgs: (await R.pageMessages(page)).filter((m) => /phone|digit|invalid/i.test(m)) }; };
  const cases = [
    { v: '12345', desc: 'fewer than 10 digits', ok: (r) => r.msgs.length > 0 || r.shown.replace(/\D/g, '').length !== 5 },
    { v: '123456789012', desc: 'more than 10 digits', ok: (r) => r.msgs.length > 0 || r.shown.replace(/\D/g, '').length <= 10 },
    { v: 'ABCDEFGHIJ', desc: 'alphabetic', ok: (r) => r.msgs.length > 0 || !/[A-Z]/i.test(r.shown) },
    { v: '8005551234', desc: 'valid 10 digits', ok: (r) => PHONE_FMT.test(r.shown) || /^\d{3}-\d{3}-\d{4}$/.test(r.shown) },
  ];
  for (const c of cases) {
    const r = await tryPhone(c.v);
    await R.check(page, ti, { description: `Phone ${c.desc} (${c.v})`, expected: c.desc === 'valid 10 digits' ? 'accepted, formatted (XXX) XXX-XXXX' : 'rejected or truncated', actual: `shows "${r.shown}"${r.msgs.length ? ` — ${r.msgs.join(' | ')}` : ''}`, ok: c.ok(r) });
  }
  if (extLabel) {
    await W.fill(page, extLabel, '7318');
    await R.check(page, ti, { description: 'Extension 1–4 digits accepted', expected: '7318', actual: (await S.field(page, extLabel) || {}).value, ok: /7318/.test((await S.field(page, extLabel) || {}).value || '') });
    await W.fill(page, extLabel, '73189');
    const v = (await S.field(page, extLabel) || {}).value || '';
    const m = (await R.pageMessages(page)).filter((x) => /ext/i.test(x));
    await R.check(page, ti, { description: 'Extension over 4 digits rejected or truncated', expected: 'error or ≤ 4 digits', actual: `"${v}" ${m.join(' | ')}`, ok: v.replace(/\D/g, '').length <= 4 || m.length > 0 });
    await W.fill(page, extLabel, '');
  } else ti.annotations.push({ type: 'manual', description: 'No Extension field next to the phone on this screen — extension steps 7–9 by hand.' });
  if (process.env.REG_SAVE_CONTACTS === '1') {
    await W.fill(page, phoneLabel, '8005551234');
    await W.clickButton(page, 'Update');
    await R.step(page, ti, `Saved the contact: ${(await R.pageMessages(page)).join(' | ') || 'no messages'}`);
  } else {
    await W.clickButton(page, 'Cancel').catch(() => {});
    ti.annotations.push({ type: 'manual', description: 'Contact cancelled, not saved (set REG_SAVE_CONTACTS=1 to save it).' });
  }
  R.setClaim(ti, cn);
}));

// Insured / Covered Party on a PolicyCenter claim: Edit is refused with "All changes to this contact must be made in PolicyCenter".
async function editBlocked(page, ti, role) {
  const rows = await contactRows(page);
  const row = rows.find((r) => new RegExp(`\\b${role}\\b`, 'i').test(r));
  if (!row) throw new W.Blocked(`no ${role} contact on this claim (contacts: ${rows.join(' || ').slice(0, 300)})`);
  const name = row.split(/\s{2,}|\t/)[0].split(' ').slice(0, 3).join(' ');
  await page.locator('tr[role="row"]').filter({ hasText: role }).first().click();
  await W.settle(page, 2500);
  const editBtn = page.getByRole('button', { name: 'Edit', exact: true }).first();
  const editable = await editBtn.isVisible().catch(() => false) && await editBtn.isEnabled().catch(() => false);
  if (editable) { await editBtn.click(); await W.settle(page, 2500); }
  const text = (await R.pageMessages(page)).concat(await S.bodyText(page).then((b) => (b.match(/All changes to this contact must be made in PolicyCenter[^\n]*/i) || [])));
  const msg = text.find((t) => /must be made in PolicyCenter/i.test(t));
  await R.check(page, ti, { description: `Edit of the PC ${role} contact (${name}) is blocked`, expected: '"All changes to this contact must be made in PolicyCenter"', actual: msg || (editable ? 'Edit opened with no PolicyCenter message' : 'Edit not offered, no message'), ok: !!msg });
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
}

test('RG-TC022 [Intersuite CC - CM]: Edits on PC insured contacts are blocked', async ({ page }, ti) => S.blockable(test, async () => {
  await S.claimFor(page, ti, 'REG_CLAIM_PA', 'PA', 'RG-TC022');
  await editBlocked(page, ti, 'Insured');
}));

test('RG-TC023 [Intersuite CC - CM]: Edits on Covered Party contacts are blocked', async ({ page }, ti) => S.blockable(test, async () => {
  S.need(test, 'REG_CLAIM_COVERED_PARTY');
  await S.claimFor(page, ti, 'REG_CLAIM_COVERED_PARTY', 'PA', 'RG-TC023');
  await editBlocked(page, ti, 'Covered Party');
}));
