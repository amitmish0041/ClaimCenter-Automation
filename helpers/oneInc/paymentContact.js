/**
 * helpers/oneInc/paymentContact.js — a claim-only person's e-mail / mobile, for the OneInc payload cases judged on the
 * OneInc staging portal (GCCM-1013 INT.024 / INT.033 — TC-121 / TC-129; added 2026-11-14, user direction: "validate the
 * same info in OneInc or CC wherever required").
 *
 *   addPerson           Parties Involved › New Contact › Person (role Other) — no-op when already there
 *   setMainEmail        the contact's own Edit screen › Main e-mail ("other screen" — must NOT reach OneInc), Update
 *   setPaymentContact   Parties Involved › contact › Payment Contact Details › Set Up / Edit All (Enter New Email):
 *                       Email + Confirm Email + Mobile, Update (answers CC's "Have you verified…" confirm)
 * Each writes an observation "<label>" = "saved" or CC's messages (the edit is cancelled), so a case can check that CC
 * refused a value. The portal side is portalChecks.oneIncPayment (Insured's Email / Primary Contact Phone).
 */
'use strict';
const W = require('./wizardDriver');
const { readScreen } = require('./screenReader');
const { observe } = require('./checkOps');

const POPUP = 'DigitalPaymentAccountPopup-DigitalPaymentAccountInputSet-';
const NAME_CELLS = '[id*="PeopleInvolvedDetailedLV-"][id$="-Name"]';
const editing = (page) => page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false);
const cancel = async (page) => { await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {}); await W.settle(page, 1500); };
const nameOf = (p) => [p.first, p.last].filter(Boolean).join(' ');
// The claim-only payees of the e-mail / phone cases (testData's contact item builds them on a fresh claim).
const PEOPLE = {
  emailClean: { first: 'PAT', last: 'EMAILCLEAN', role: 'Other' },
  contactUpd: { first: 'PAT', last: 'CONTACTUPD', role: 'Other' },
};

async function openContact(page, name) {
  await W.navigate(page, 'parties');
  await page.locator('tr[id*="LV-0-"]:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const exact = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  await page.locator(NAME_CELLS).filter({ hasText: exact }).filter({ visible: true }).first().click({ timeout: 15000 });
  await W.settle(page, 2500);
}

// Update (again on warnings-only pages). '' when saved, else CC's messages — the edit is then cancelled.
async function save(page) {
  for (let i = 0; i < 3; i++) {
    await W.clickButton(page, 'Update');
    await page.waitForTimeout(1500);
    if (!await editing(page)) return '';
  }
  const s = await readScreen(page);
  const why = [...s.messages, s.south].filter(Boolean).join(' / ').replace(/\s+/g, ' ').slice(0, 300) || 'not saved';
  await cancel(page);
  return why;
}

async function addPerson(page, person) {
  const added = await W.addClaimPersonContact(page, { role: 'Other', ...person });
  return observe(page, 'Claim-only person', `${nameOf(person)} ${added === false ? 'already on the claim' : 'added (role Other)'}`);
}

async function setMainEmail(page, person, email, label = 'Parties Involved e-mail') {
  await openContact(page, nameOf(person));
  await W.clickButton(page, 'Edit');
  await W.settle(page, 2000);
  const s = await readScreen(page);
  const f = s.fields.find((x) => x.kind === 'input' && /^(main|main email|primary email|e-?mail)$/i.test(x.label));
  if (!f) { await cancel(page); throw new W.Blocked(`${nameOf(person)}: no e-mail field on the contact's Edit screen`); }
  const box = page.locator(`[id="${f.id}"] input:not([type=hidden])`).first();
  await box.fill(email);
  await box.press('Tab').catch(() => {});
  await W.settle(page, 800);
  const why = await save(page);
  return observe(page, label, why ? `refused: ${why}` : `saved: ${email}`);
}

async function typeMobile(page, mobile) {
  const box = page.locator(`input[name$="${POPUP}Cell-GlobalPhoneInputSet-NationalSubscriberNumber"]`).first();
  if (!await box.isVisible().catch(() => false)) return;
  const want = String(mobile).replace(/\D/g, '');
  // The mask swallows the first key typed straight after focus (contactEmails.js, 2026-11-03): retype until all digits are there.
  for (let i = 0; i < 3; i++) {
    await box.click();
    await page.waitForTimeout(400);
    await box.press('Control+A').catch(() => {});
    await box.press('Backspace').catch(() => {});
    await page.waitForTimeout(200);
    await box.pressSequentially(want, { delay: 60 });
    await box.press('Tab').catch(() => {});
    await page.waitForTimeout(500);
    if (String(await box.inputValue().catch(() => '')).replace(/\D/g, '') === want) break;
  }
}

async function setPaymentContact(page, person, { email, mobile }, label = 'Payment Contact Details') {
  await openContact(page, nameOf(person));
  const btn = page.getByRole('button', { name: /Payment Contact Details/ }).first();
  if (!await btn.isVisible().catch(() => false)) throw new W.Blocked(`${nameOf(person)}: no Payment Contact Details button`);
  await btn.click();
  await page.waitForTimeout(1200);
  const item = page.getByRole('menuitem', { name: /^(Set Up|Edit All)$/ }).first();
  if (!await item.isVisible().catch(() => false)) { await page.keyboard.press('Escape').catch(() => {}); throw new W.Blocked(`${nameOf(person)}: Payment Contact Details offers neither Set Up nor Edit All`); }
  await item.click();
  await W.settle(page, 2500);
  const newEmail = page.locator(`input[name="${POPUP}newEmail"]`).first();
  if (email && !await newEmail.isVisible().catch(() => false)) {
    // Already set up: Email is a dropdown button holding the current address › "Enter New Email" (CONFIRMED 2026-11-14).
    await page.locator('[role=button], button').filter({ hasText: /@/ }).filter({ visible: true }).first().click().catch(() => {});
    await page.waitForTimeout(1000);
    await page.getByRole('menuitem', { name: 'Enter New Email', exact: true }).first().click().catch(() => {});
    await W.settle(page, 2000);
  }
  if (email) {
    if (!await newEmail.isVisible().catch(() => false)) { await cancel(page); throw new W.Blocked(`${nameOf(person)}: no new-e-mail box on Payment Contact Details`); }
    await newEmail.fill(email);
    await newEmail.press('Tab').catch(() => {});
    const confirm = page.locator(`input[name="${POPUP}newConfirmEmail"]`).first();
    await confirm.fill(email);
    await confirm.press('Tab').catch(() => {});
  }
  if (mobile) await typeMobile(page, mobile);
  await W.settle(page, 1000);
  const verify = async (d) => { if (/verified\/confirmed the insured\/claimant email/i.test(d.message())) await d.accept().catch(() => {}); };
  page.on('dialog', verify);
  let why;
  try { why = await save(page); } finally { page.off('dialog', verify); }
  if (!why) { await page.getByText('Return to Contacts', { exact: true }).first().click().catch(() => {}); await W.settle(page, 1500); }
  const what = [email && `email ${email}`, mobile && `mobile ${mobile}`].filter(Boolean).join(', ');
  return observe(page, label, why ? `refused (${what}): ${why}` : `saved: ${what}`);
}

module.exports = { addPerson, setMainEmail, setPaymentContact, PEOPLE };
