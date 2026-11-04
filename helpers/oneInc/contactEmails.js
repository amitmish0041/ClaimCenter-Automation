/**
 * helpers/oneInc/contactEmails.js — every new OneInc test claim: all claim contacts get the QA mailbox as their e-mail, so
 * OneInc payment notifications never go to a real customer (user direction 2026-11-03, standing step for all tests).
 *
 * Per contact on Parties Involved (contacts linked to the Address Book are read-only in ClaimCenter and are skipped):
 *  1. Edit › E-mail "Main" (person) / "Main Email" (company) = QA_EMAIL, Update;
 *  2. Payment Contact Details › Set Up (DigitalPaymentAccountPopup: Email, Confirm Email, Mobile — all required) =
 *     QA_EMAIL / QA_EMAIL / QA_MOBILE (dummy 555 number), Update.
 * Run by claimCheck's prepare mode on every claim it builds, except profiles with `contactEmails: false` (cases that need
 * a payee WITHOUT payment contact details — CPD.001 / VBR.001, profile AUTO_PA_NOEMAIL). Idempotent. TEST tier only.
 */
'use strict';
const W = require('./wizardDriver');
const { readScreen, norm } = require('./screenReader');

const QA_EMAIL = process.env.ONEINC_CONTACT_EMAIL || 'amandahess@donegalgroup.com';
const QA_MOBILE = process.env.ONEINC_CONTACT_MOBILE || '717-555-0142';
const TIER = (process.env.CC_TIER || 'test').toLowerCase();
const NAME_CELLS = '[id*="PeopleInvolvedDetailedLV-"][id$="-Name"]';
const POPUP = 'DigitalPaymentAccountPopup-DigitalPaymentAccountInputSet-';
const PARTY_ROLES = /\b(Insured|Claimant|Secondary Named Insured|Named Insured)\b/i;
const KEEP_LINKED = /\b(Vendor|Agent|Lienholder|Mortgagee|Attorney|Agency|Repair|Doctor|Medical Provider)\b/i;
const editing = (page) => page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false);
const cancel = async (page) => { await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {}); await W.settle(page, 1500); };

async function contactNames(page) {
  await W.navigate(page, 'parties');
  await page.locator('tr[id*="LV-0-"]:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  // [{ name, roles }] — roles = the row's Roles cell text.
  return page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent).map((e) => {
    const row = e.closest('tr');
    // textContent: innerText drops letters on this grid ("Secondary Named In ured", 2026-11-03).
    const roles = row ? ((row.querySelector('[id$="-Roles"]') || {}).textContent || row.textContent || '') : '';
    return { name: e.innerText.trim(), roles: roles.replace(/\s+/g, ' ').trim() };
  }).filter((c) => c.name), NAME_CELLS);
}
async function openContact(page, name) {
  await W.navigate(page, 'parties');
  await page.locator('tr[id*="LV-0-"]:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const exact = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  await page.locator(NAME_CELLS).filter({ hasText: exact }).filter({ visible: true }).first().click({ timeout: 15000 });
  await W.settle(page, 2500);
}

// Update, pressing again on warnings-only pages. Returns '' when saved, else CC's messages (the edit is cancelled).
async function save(page) {
  for (let i = 0; i < 3; i++) {
    await W.clickButton(page, 'Update');
    await page.waitForTimeout(1500);
    if (!await editing(page)) return '';
  }
  const s = await readScreen(page);
  const why = [...s.messages, s.south].filter(Boolean).join(' / ').slice(0, 200) || 'not saved';
  await cancel(page);
  return why;
}

// 1. The contact's own e-mail (Edit screen).
async function setMainEmail(page) {
  await W.clickButton(page, 'Edit');
  await W.settle(page, 2000);
  const s = await readScreen(page);
  const field = s.fields.find((x) => x.kind === 'input' && /^(main|main email|primary email|e-?mail)$/i.test(x.label));
  if (!field) { await cancel(page); return 'no e-mail field on Edit'; }
  if (norm(field.value) === norm(QA_EMAIL)) { await cancel(page); return 'e-mail already set'; }
  const box = page.locator(`[id="${field.id}"] input:not([type=hidden])`).first();
  await box.fill(QA_EMAIL);
  await box.press('Tab').catch(() => {});
  await W.settle(page, 800);
  const why = await save(page);
  return why ? `e-mail not saved (${why})` : 'e-mail set';
}

// 2. Payment Contact Details › Set Up.
async function setPaymentContactDetails(page) {
  const btn = page.getByRole('button', { name: /Payment Contact Details/ }).first();
  if (!await btn.isVisible().catch(() => false)) return 'no Payment Contact Details button';
  if (await btn.evaluate((e) => e.getAttribute('aria-disabled') === 'true' || !!e.querySelector('[aria-disabled="true"]') || !!e.closest('[aria-disabled="true"]')).catch(() => false)) return 'Payment Contact Details disabled for this contact';
  await btn.click();
  await page.waitForTimeout(1200);
  const setUp = page.getByRole('menuitem', { name: /^Set Up$/ }).first();
  if (!await setUp.isVisible().catch(() => false)) { await page.keyboard.press('Escape').catch(() => {}); return 'payment contact details already set up'; }
  await setUp.click();
  await W.settle(page, 3000);
  const email = page.locator(`input[name="${POPUP}newEmail"]`).first();
  if (!await email.isVisible().catch(() => false)) { await cancel(page); return 'Payment Contact Details screen did not open'; }
  await email.fill(QA_EMAIL);
  await email.press('Tab').catch(() => {});
  const confirm = page.locator(`input[name="${POPUP}newConfirmEmail"]`).first();
  await confirm.fill(QA_EMAIL);
  await confirm.press('Tab').catch(() => {});
  // Masked phone box: type it key by key; keep an existing mobile only when it is the dummy one.
  const mobile = page.locator(`input[name$="${POPUP}Cell-GlobalPhoneInputSet-NationalSubscriberNumber"]`).first();
  // The mask swallows the first key typed straight after focus ("175550142", CONFIRMED 2026-11-03): wait for it to
  // initialise, then check the digits and retype until all 10 are there.
  if (await mobile.isVisible().catch(() => false)) {
    const want = QA_MOBILE.replace(/\D/g, '');
    for (let i = 0; i < 3; i++) {
      await mobile.click();
      await page.waitForTimeout(400);
      await mobile.press('Control+A').catch(() => {});
      await mobile.press('Backspace').catch(() => {});
      await page.waitForTimeout(200);
      await mobile.pressSequentially(want, { delay: 60 });
      await mobile.press('Tab').catch(() => {});
      await page.waitForTimeout(500);
      if (String(await mobile.inputValue().catch(() => '')).replace(/\D/g, '') === want) break;
    }
  }
  // Masked e-mail box (password type): confirm it kept the value, retype otherwise.
  if (!await email.inputValue().catch(() => '')) { await email.fill(QA_EMAIL); await email.press('Tab').catch(() => {}); }
  await W.settle(page, 1000);
  // Update asks a native confirm "Have you verified/confirmed the insured/claimant email address by calling them back
  // using the number in the file?" (CONFIRMED 2026-11-03) — unanswered, Playwright dismisses it and nothing is saved.
  const verify = async (d) => { if (/verified\/confirmed the insured\/claimant email/i.test(d.message())) await d.accept().catch(() => {}); };
  page.on('dialog', verify);
  let why;
  try { why = await save(page); } finally { page.off('dialog', verify); }
  if (why) return `payment contact details not saved (${why})`;
  await page.getByText('Return to Contacts', { exact: true }).first().click().catch(() => {});
  await W.settle(page, 1500);
  return 'payment contact details set';
}

// Prepare-mode step: every editable contact on the claim gets QA_EMAIL. Never throws for one contact — the summary
// names what was done and what was skipped.
async function setAllContactEmails(page) {
  if (TIER !== 'test') return 'contact e-mails left as they are (not the TEST tier)';
  await W.cancelWizard(page).catch(() => {});
  const contacts = await contactNames(page);
  const done = [];
  for (const { name, roles } of contacts) {
    // Agents / vendors / lienholders / attorneys: never a person payee needing payment contact details (the warning is
    // "payees other than vendor"), an agency's e-mail cannot even be saved ("Tax ID (EIN) missing"), and each one costs
    // ~1 min of claim setup — skipped (2026-11-03, setup time 11 min/claim).
    if (KEEP_LINKED.test(roles) && !PARTY_ROLES.test(roles)) { done.push(`${name}: skipped (${roles.slice(0, 40)})`); continue; }
    try {
      await openContact(page, name);
      const body = await page.evaluate(() => document.body.innerText || '');
      // Address Book contacts: their own e-mail is read-only here (synced from the Address Book / PolicyCenter), but people
      // like the HO insured still have Payment Contact Details — and since 2026-11-03 cloud CC defaults ClaimsPay to
      // Other / Mailed Check for a payee without them (GCCM-759 CPD team run), so those are still set up.
      let linked = /This contact is linked to the Address Book/i.test(body);
      // A linked insured / claimant / Secondary Named Insured has Payment Contact Details DISABLED (CONFIRMED 2026-11-03,
      // HO insured Robert Charles) — Unlink (the claim's copy only; the Address Book record is untouched) enables Edit and
      // Payment Contact Details. Vendors, agents, lienholders stay linked: the vendor rules depend on the Address Book link.
      let note = '';
      if (linked && PARTY_ROLES.test(roles) && !KEEP_LINKED.test(roles)) {
        const unlink = page.getByRole('button', { name: 'Unlink', exact: true }).filter({ visible: true }).first();
        if (await unlink.click({ timeout: 8000 }).then(() => true, () => false)) {
          await W.settle(page, 3000);
          linked = /This contact is linked to the Address Book/i.test(await page.evaluate(() => document.body.innerText || ''));
          note = linked ? 'Unlink did not take; ' : 'unlinked from the Address Book (claim copy); ';
        }
      }
      if (linked && !note) note = `Address Book contact (roles: ${roles.slice(0, 60) || '?'}); `;
      const a = note + (linked ? 'own e-mail read-only (Address Book contact)' : await setMainEmail(page));
      await openContact(page, name);
      const b = await setPaymentContactDetails(page);
      done.push(`${name}: ${a}; ${b}`);
    } catch (e) {
      await cancel(page);
      done.push(`${name}: ${String(e.message).split('\n')[0].slice(0, 120)}`);
    }
  }
  return `contact e-mails → ${QA_EMAIL} (${done.join(' | ') || 'no contacts'})`;
}

module.exports = { setAllContactEmails, QA_EMAIL, QA_MOBILE };
