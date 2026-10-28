/**
 * helpers/oneInc/wizardDriver.js
 * Drives the ClaimCenter Cloud payment screens the OneInc test designs cover — the Full Check wizard ("New
 * Payment": Payees › Payments › Instructions), the Quick Payment wizard, the Financials summary row menu, the
 * Checks/Payments and Parties Involved screens — far enough to READ them. It never presses Finish: every scenario
 * ends with cancelWizard(), so no payment, reserve or contact change is ever saved by this suite. Validation rules
 * are exercised through the Next button, which is where CC fires them (CONFIRMED 2026-10-20: "PMS PL50 : Partial
 * payment not allowed without open reserve" and "Missing required field" both appear on Next from Step 2).
 *
 * Screen facts this was built against (cloud/test, claim PA-PA-01-26-0748059, 2026-10-20):
 *  - Actions › New Transaction › "New Payment" opens the Full Check wizard (NormalCreateCheckWizard-*).
 *  - Financials › Summary: each reserve row's "options" button lists Edit Reserve | Quick Payment | Create Payment.
 *  - Step 1 Payees: Name (select), Type (ContactRole), Pay To The Order Of (read-only + Edit), Recipient, Mailing
 *    Address (select), "Do you want to edit the Mailing Address?", Add Joint Payees.
 *  - Step 2 Payments: Reserve Line (existing lines + "Expense OR First and Final", which adds Exposure / Cost Type /
 *    Cost Category), Transaction Type, Payment Type (read-only), Service Period Start/End, Total Amount of Payment
 *    (masked), Line Items grid (Category + Amount), Available Reserves, Cause of Loss, 1099 Box Number, Memo Phrase,
 *    "Payment for a total loss?".
 *  - Step 3 Instructions: Amount, Invoice Number/Remarks, Remarks Line 2, Claim Number, attorney/settlement question,
 *    Linked Documents (incl. Send Status column), ClaimsPay Type, ClaimsPay Method, Payment Delivery, Recurrence...
 */
'use strict';
const { readScreen, findField, norm } = require('./screenReader');
const { openExposuresTabCloud, getAllExposureClaimantsCloud } = require('../financialsHelper');

// A prerequisite the scenario needs isn't there (no open reserve line, no vendor on the claim, ...): the scenario
// is BLOCKED, not FAILED — the business rule was never exercised.
class Blocked extends Error {
  constructor(message) { super(message); this.name = 'Blocked'; }
}

const settle = async (page, ms = 1500) => {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(ms);
};

async function inWizard(page) {
  return page.getByRole('button', { name: 'Cancel', exact: true }).first().isVisible().catch(() => false);
}

// ── Opening a claim ─────────────────────────────────────────────────────────────────────────────────────────────
// Some test claims are restricted for the standard user ("Sorry, you do not have permission to view this claim" —
// CONFIRMED 2026-10-20 on every HO-PA candidate). Same remedy as the SmartCOMM suite: switch to the admin login
// (CC_ADMIN_USER) and stay on it for the rest of the session. page.__oneIncUser records who is logged in.
async function openClaim(page, claimNumber, log = () => {}) {
  const { openExistingClaim, loginAsAdmin } = require('../claimCenterBase');
  const denied = () => page.getByText('do not have permission to view this claim').first().isVisible().catch(() => false);
  await openExistingClaim(page, claimNumber);
  await page.waitForTimeout(800);
  if (!await denied()) return;
  if (page.__oneIncUser === 'admin' || !process.env.CC_ADMIN_USER) {
    throw new Blocked(`no permission to view claim ${claimNumber}${process.env.CC_ADMIN_USER ? ' (even as admin)' : ' and no CC_ADMIN_USER is set'}`);
  }
  log(`[OneInc] claim ${claimNumber}: no permission for ${process.env.CC_USER} — switching to the admin login for the rest of this run`);
  await loginAsAdmin(page);
  page.__oneIncUser = 'admin';
  await openExistingClaim(page, claimNumber);
  if (await denied()) throw new Blocked(`no permission to view claim ${claimNumber} (even as admin)`);
}

// "New Payment Error" page: CC lists why the claim can't be paid (e.g. "Please complete the Surcharging screen",
// claimant address missing). Returns that text, or '' when no such page is showing.
async function newPaymentErrorText(page) {
  return page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ');
    const m = /New Payment Error (.*?)(Return to the claim|$)/.exec(t);
    return m ? m[1].trim().slice(0, 400) : '';
  }).catch(() => '');
}

// Completes the claim's Surcharging screen: Edit, answer every unanswered exception "No", Update. WRITES to the
// claim — used only by the claim scout's prepare mode (scripts/scoutOneIncClaims.js --prepare), approved for TEST.
async function repairSurcharging(page) {
  await page.locator('[id="Claim-MenuLinks-Claim_ClaimSurchargingGroup"]').first().click();
  await settle(page, 3500);
  const edit = page.getByRole('button', { name: 'Edit', exact: true }).first();
  if (!await edit.isVisible().catch(() => false)) throw new Blocked('Surcharging screen has no Edit button');
  await edit.click();
  await settle(page, 2500);
  await answerUnansweredNo(page);
  await clickButton(page, 'Update');
  const s = await readScreen(page);
  if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
    const why = s.messages.join(' / ').slice(0, 300);
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new Blocked(`Surcharging could not be saved: ${why || 'no message'}`);
  }
}

// "Ability to Pay" failures name their cause in the validation panel. CONFIRMED 2026-10-21 on a fresh WC claim:
// "The claimant's primary address line 1 / city / state must not be empty" — FNOL created the injured worker with no
// address. Opens the contact whose Roles include Claimant in Parties Involved, Edit, fills a PA address, Update.
// WRITES — claim prepare mode only (TEST).
async function abilityToPayErrors(page) {
  return page.evaluate(() => { const p = document.getElementById('gw-south-panel'); return ((p && p.innerText) || '').replace(/\s+/g, ' ').slice(0, 1500); }).catch(() => '');
}
// Actions › Validate Claim + Exposures › Ability to pay — CC's own pre-check for financials (user direction
// 2026-10-21: run it before creating reserves/payments; an empty Exposure list on New Reserve was such a validation
// problem). Returns the Validation Results text, '' when CC reports nothing.
async function abilityToPay(page) {
  await openActionsMenu(page);
  const v = page.getByRole('menuitem', { name: /Validate Claim/ }).first();
  await v.hover().catch(() => {});
  await page.waitForTimeout(1500);
  const atp = page.getByRole('menuitem', { name: /^Ability to pay/i }).first();
  if (!await atp.isVisible().catch(() => false)) {
    await closeMenus(page);
    throw new Blocked('Actions › Validate Claim + Exposures has no "Ability to pay" item');
  }
  await atp.click();
  await settle(page, 4000);
  const t = (await abilityToPayErrors(page)).replace(/^\s*Validation Results\s*(Clear\s*)?/i, '').trim();
  return /^(Information:\s*)?No validation errors\.?$/i.test(t) ? '' : t;
}

// Ability to pay: "Serial number must be present" — a vehicle incident with no VIN (the exposure's own incident when
// it was created from the New Exposure screen, CONFIRMED 2026-10-21). Fill a VIN on every vehicle incident lacking one.
async function repairVehicleVins(page) {
  const fixed = [];
  await navigate(page, 'lossDetails');
  const count = await page.locator('[id*="EditableVehicleIncidentsLV-"][id$="-Make_button"]').count();
  for (let i = 0; i < count; i++) {
    await navigate(page, 'lossDetails');
    const make = page.locator(`[id$="EditableVehicleIncidentsLV-${i}-Make_button"]`).first();
    if (!await make.isVisible().catch(() => false)) continue;
    const name = (await make.innerText().catch(() => '')).trim();
    await make.click();
    await settle(page, 3000);
    await clickButton(page, 'Edit');
    await settle(page, 2000);
    const vin = page.getByLabel('VIN', { exact: true }).first();
    // Empty, or not a 17-character upper-case VIN ("Automated E2E" from an earlier filler) — CC refuses both.
    const needVin = await vin.isVisible().catch(() => false) && !/^[A-Z0-9]{17}$/.test((await vin.inputValue().catch(() => 'x')).trim());
    // Style "Boat" (an earlier filler's first-option pick) also needs a Boat type — "Boat type must be present".
    const style = (await readScreen(page)).fields.find((x) => x.label === 'Style' && x.kind === 'select');
    const boat = style && /^Boat$/i.test(style.value);
    if (!needVin && !boat) {
      await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
      await settle(page, 1500);
      continue;
    }
    if (needVin) { await vin.fill('1HGCM82633A004352'); await vin.press('Tab').catch(() => {}); }
    if (boat) { await select(page, 'Style', 'Other'); await settle(page, 1500); }
    await answerUnansweredNo(page).catch(() => {});
    await clickButton(page, 'Update');
    await settle(page, 3000);
    if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
      const why = (await readScreen(page)).messages.join('; ');
      await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
      await settle(page, 1500);
      throw new Error(`vehicle "${name}": VIN not saved — ${why.slice(0, 200)}`);
    }
    fixed.push(name || `vehicle ${i + 1}`);
  }
  return fixed;
}

// Lienholder/Mortgagee companies (user direction 2026-10-21: any approved Address Book company works once it carries
// the claim role "Lienholder/Mortgagee"). Override with ONEINC_LIENHOLDERS="NAME|TAXID|TYPE;...".
const DEFAULT_LIENHOLDERS = [
  { name: 'ANKER AUTO BODY', taxId: '30-0113926', type: 'Vendor (Company)' },
  { name: 'ANKERS GARAGE', taxId: '20-3932111', type: 'Vendor (Company)' },
];
function lienholders() {
  const env = String(process.env.ONEINC_LIENHOLDERS || '').trim();
  if (!env) return DEFAULT_LIENHOLDERS;
  return env.split(';').map((s) => s.split('|').map((x) => x.trim())).filter((a) => a[0]).map(([name, taxId, type]) => ({ name, taxId, type: type || 'Vendor (Company)' }));
}

// Parties Involved › Address Book/1099 Contacts: search the company by Tax ID, select it and give it `role` on this
// claim. No-op when a contact of that name is already on the claim.
async function addClaimContactWithRole(page, company, role = 'Lienholder/Mortgagee') {
  await navigate(page, 'parties');
  await page.locator('tr[id*="LV-0-"]:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const listed = await page.evaluate(() => [...document.querySelectorAll('[id*="PeopleInvolvedDetailedLV-"][id$="-Name"]')].map((e) => (e.innerText || '').trim().toUpperCase()));
  if (listed.includes(company.name.toUpperCase())) return false;
  await page.locator('[id$="ClaimContacts_AddExistingButton"]').first().click();
  await settle(page, 3500);
  await select(page, 'Type', company.type || 'Vendor (Company)').catch(() => {});
  await settle(page, 1500);
  await page.getByLabel('Tax ID', { exact: true }).last().fill(company.taxId);
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await settle(page, 4500);
  const row = page.locator('tr').filter({ has: page.getByRole('button', { name: 'Select', exact: true }) }).first();
  if (!await row.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new Blocked(`"${company.name}" (Tax ID ${company.taxId}) not found in the Address Book search`);
  }
  await row.getByRole('button', { name: 'Select', exact: true }).first().click();
  await settle(page, 4000);
  return setContactRoleAndUpdate(page, company.name, role);
}

// New-contact screen (Address Book pick or New Contact form): give the contact `role` on this claim and Update.
async function setContactRoleAndUpdate(page, name, role) {
  // New contact screen: Roles grid. A pre-filled role row is re-pointed; otherwise Add one.
  // The Roles grid has two selects per row (Related To, Role) — take the one that offers `role`.
  const markRoleSelect = (anySelect) => page.evaluate(([role, anySelect]) => {
    // The grid's own Role select first (…ClaimContactRolesLV-<n>-Role): a generic role like "Other" is ALSO an Address
    // Type option, and the page-wide match picked that one (CONFIRMED 2026-10-27, "The contact must have at least one role").
    const offers = (x) => [...x.options].some((o) => o.text.trim().toLowerCase() === role.toLowerCase());
    const live = [...document.querySelectorAll('select')].filter((x) => x.offsetParent && !x.disabled);
    const sel = live.find((x) => /RolesLV-\d+-Role$/.test(x.name || x.id) && offers(x)) || (anySelect ? live.find(offers) : null);
    if (sel) sel.setAttribute('data-oneinc-role', '1');
    return !!sel;
  }, [role, anySelect]);
  // Page-wide fallback only AFTER a role row was added (older screens without the RolesLV ids, e.g. Address Book pick).
  if (!await markRoleSelect(false)) {
    await page.locator('[id*="Role"][id$="_tb-Add"]').first().click().catch(() => clickButton(page, 'Add'));
    await settle(page, 2000);
    await markRoleSelect(true);
  }
  const roleSel = page.locator('select[data-oneinc-role="1"]').first();
  if (!await roleSel.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new Blocked(`no Role dropdown offering "${role}" on the new contact screen`);
  }
  const opts = await roleSel.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));
  const want = opts.find((o) => o.t.toLowerCase() === role.toLowerCase());
  if (!want) throw new Blocked(`role "${role}" not offered (${opts.map((o) => o.t).slice(0, 15).join(', ')})`);
  await roleSel.selectOption(want.v);
  await settle(page, 1500);
  // "Related To" defaults to the claim; set it if blank.
  // On the New Contact form the column is …RolesLV-<n>-Owner (first real option = the claim itself).
  const rel = page.locator('select[name*="RelatedTo"]:visible, select[name*="RolesLV"][name$="-Owner"]:visible').first();
  if (await rel.isVisible().catch(() => false) && !(await rel.inputValue().catch(() => ''))) {
    const ro = await rel.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
    if (ro[0]) await rel.selectOption(ro[0]);
  }
  await clickButton(page, 'Update');
  await settle(page, 3500);
  if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
    const why = (await readScreen(page)).messages.join('; ');
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    await settle(page, 1500);
    throw new Error(`adding "${name}" as ${role} was refused — ${why.slice(0, 300)}`);
  }
  return true;
}

// Parties Involved › New Contact › Person: a claim-only person (NOT linked to the Address Book) with a Pennsylvania
// address and `role` on this claim (VBR.036 payee "PHILIP ADAMS" on E_PA, CONFIRMED form 2026-10-27). No-op when a
// contact of that name is already on the claim.
async function addClaimPersonContact(page, { first, last, role = 'Covered Party', address = {} }) {
  const name = `${first} ${last}`;
  await navigate(page, 'parties');
  await page.locator('tr[id*="LV-0-"]:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const listed = await page.evaluate(() => [...document.querySelectorAll('[id*="PeopleInvolvedDetailedLV-"][id$="-Name"]')].map((e) => (e.innerText || '').trim().toUpperCase()));
  if (listed.includes(name.toUpperCase())) return false;
  await page.locator('[id$="ClaimContacts_CreateNewContactButton"]').first().click();
  await page.waitForTimeout(1500);
  await page.getByRole('menuitem', { name: /^Person$/ }).first().click();
  await settle(page, 4000);
  const a = { line1: '100 Market St', city: 'Harrisburg', state: 'Pennsylvania', zip: '17101', type: 'Home', ...address };
  await fill(page, 'First name', first);
  await fill(page, 'Last name', last);
  await select(page, 'Country', 'United States').catch(() => {});
  await fill(page, 'Address 1', a.line1);
  await fill(page, 'City', a.city);
  await select(page, 'State', a.state);
  await fill(page, 'ZIP Code', a.zip);
  await select(page, 'Address Type', a.type).catch(() => {});
  return setContactRoleAndUpdate(page, name, role);
}

// Incident #index: the loan/mortgage question = Yes with a loan row naming `lienholderName` (same ExtLienholderInformationLV
// grid on both, CONFIRMED 2026-10-21). kind 'vehicle': "Is there a loan on the Vehicle?"; 'property' (HO fixed-property
// incident): "Is there a mortgage on this property?".
const LOAN_INCIDENT = {
  vehicle: { link: (i) => `[id$="EditableVehicleIncidentsLV-${i}-Make_button"]`, question: 'Is there a loan on the Vehicle?' },
  property: { link: (i) => `[id$="EditableFixedPropertyIncidentsLV-${i}-Address1_button"]`, question: 'Is there a mortgage on this property?' },
};
// FNOL-made incidents can lack required values the edit screen enforces ("Property Name" dropdown on HO, CONFIRMED
// 2026-10-21): empty required text gets "Automated E2E", a required dropdown on <none> its first real option.
async function fillIncidentRequired(page) {
  for (const f of (await readScreen(page)).fields) {
    if (!f.required || !f.label || f.readonly) continue;
    if (f.kind === 'input' && !String(f.value || '').trim()) await fill(page, f.label, 'Automated E2E').catch(() => {});
    if (f.kind === 'select' && /^(<none>)?$/i.test(String(f.value || '').trim())) { await select(page, f.label, 0).catch(() => {}); await settle(page, 1500); }
  }
}
async function addVehicleLoan(page, lienholderName, opts = {}) { return addIncidentLoan(page, lienholderName, { ...opts, kind: 'vehicle' }); }
async function addIncidentLoan(page, lienholderName, { kind = 'vehicle', index = 0, loanNumber = 'LN' + Date.now().toString().slice(-8) } = {}) {
  const inc = LOAN_INCIDENT[kind];
  await navigate(page, 'lossDetails');
  await page.locator(inc.link(index)).first().click();
  await settle(page, 3000);
  await clickButton(page, 'Edit');
  await settle(page, 2000);
  await fillIncidentRequired(page); // before the question: filling them re-renders the form
  await answer(page, inc.question, 'Yes');
  await settle(page, 2000);
  const LV = '[id*="ExtLienholderInformationLV"]';
  const already = await page.evaluate((n) => [...document.querySelectorAll('[id*="ExtLienholderInformationLV-"] select')]
    .some((s) => (s.options[s.selectedIndex] || {}).text === n), lienholderName);
  if (!already) {
    await page.locator(`${LV}[id$="_tb-Add"]`).first().click();
    await settle(page, 2000);
    const rows = page.locator(`tr[id*="ExtLienholderInformationLV-"]`);
    const r = rows.last();
    const sel = r.locator('select').first();
    const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));
    const want = opts.find((o) => norm(o.t) === norm(lienholderName));
    if (!want) throw new Blocked(`lienholder "${lienholderName}" not offered on the loan row (${opts.map((o) => o.t).join(', ')})`);
    await sel.selectOption(want.v);
    await settle(page, 1200);
    const inputs = r.locator('input[type="text"]:visible');
    if (await inputs.count()) await inputs.first().fill(loanNumber);
  }
  await answerUnansweredNo(page).catch(() => {});
  // Picking a required dropdown re-renders the form and clears the loan/mortgage answer — re-answer if so.
  await fillIncidentRequired(page);
  const q = findField(await readScreen(page), inc.question);
  if (q && q.radios && !q.radios.some((r) => r.checked && /yes/i.test(r.label))) await answer(page, inc.question, 'Yes');
  await clickButton(page, 'Update');
  await settle(page, 3500);
  if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
    const why = (await readScreen(page)).messages.join('; ');
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    await settle(page, 1500);
    throw new Error(`${kind} loan/mortgage not saved — ${why.slice(0, 300)}`);
  }
  return already ? 'existing' : loanNumber;
}

// "Payment contact details" (wizard warning id …MIssingAccountWarning) = a Digital Payment Account (ContactEFTLV) on
// the payee's claim contact — CONFIRMED 2026-10-21; email/phone do not count. Dummy TEST values approved by the user
// 2026-10-21 (automation-created claims only). Returns false when the contact already has an account.
const DUMMY_EFT = { AccountName: 'OneInc Automation', BankName: 'TEST BANK', BankAccountType: 'Checking', BankAccountNumber: '000123456789', BankRoutingNumber: '011000015' };
async function addDigitalPaymentAccount(page, contactName) {
  await navigate(page, 'parties');
  await page.locator('tr[id*="LV-0-"]:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const cell = page.locator('[id*="PeopleInvolvedDetailedLV-"][id$="-Name"]').filter({ hasText: new RegExp(`^\\s*${contactName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }).first();
  if (!await cell.isVisible().catch(() => false)) throw new Blocked(`contact "${contactName}" is not on Parties Involved`);
  await cell.click();
  await settle(page, 3000);
  const EFT = '[id$="ContactBasicsDV-ContactEFTLV"]';
  if (await page.locator(`[id*="ContactEFTLV-0-"]`).first().isVisible().catch(() => false)) return false;
  await clickButton(page, 'Edit');
  await settle(page, 2500);
  const add = page.locator('[id$="ContactEFTLV_tb-Add"]').first();
  if (!await add.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new Blocked(`no Add on "${contactName}"'s Digital Payment Account grid for this user`);
  }
  await add.click();
  await settle(page, 2000);
  // The id is on the cell <div>; the control inside carries it as its name.
  const row = (f) => page.locator(`[name$="ContactEFTLV-0-${f}"]`).first();
  for (const f of ['AccountName', 'BankName', 'BankAccountNumber', 'BankRoutingNumber']) { await row(f).fill(DUMMY_EFT[f]); await row(f).press('Tab').catch(() => {}); }
  await row('BankAccountType').selectOption({ label: DUMMY_EFT.BankAccountType });
  await settle(page, 1200);
  await clickButton(page, 'Update');
  await settle(page, 3500);
  if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
    const why = (await readScreen(page)).messages.join('; ');
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    await settle(page, 1500);
    throw new Error(`Digital Payment Account not saved on "${contactName}" — ${why.slice(0, 300)}`);
  }
  return true;
}

async function repairClaimantAddress(page) {
  await navigate(page, 'parties');
  const rowIdx = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr') && r.querySelector('[id$="-Name"]'));
    const i = rows.findIndex((r) => /\bClaimant\b/.test(r.innerText));
    if (i >= 0) rows[i].setAttribute('data-oneinc-claimant', '1');
    return i;
  });
  if (rowIdx < 0) throw new Blocked('no contact with the Claimant role on Parties Involved');
  await page.locator('tr[data-oneinc-claimant="1"] [id$="-Name"]').first().click();
  await settle(page, 2500);
  await clickButton(page, 'Edit');
  const set = async (suffix, value) => {
    const el = page.locator(`input[name$="GlobalAddressInputSet-${suffix}"]`).first();
    if (await el.isVisible().catch(() => false) && !(await el.inputValue().catch(() => '')).trim()) { await el.fill(value); await el.press('Tab').catch(() => {}); await page.waitForTimeout(400); }
  };
  await set('AddressLine1', '1195 River Rd');
  await set('City', 'Marietta');
  await set('PostalCode', '17547');
  const state = page.locator('select[name$="GlobalAddressInputSet-State"]').first();
  if (await state.isVisible().catch(() => false)) {
    const opts = await state.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));
    const pa = opts.find((o) => /^pennsylvania$/i.test(o.t) || o.v === 'PA');
    if (pa && !/pennsylvania/i.test(await state.inputValue().catch(() => ''))) await state.selectOption(pa.v).catch(() => {});
  }
  await clickButton(page, 'Update');
  if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
    const why = (await readScreen(page)).messages.join(' / ').slice(0, 300);
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new Blocked(`claimant address could not be saved: ${why || 'no message'}`);
  }
}

// Assigns an unassigned claim AND its exposures ("Please assign the claim and exposure(s) before payment" —
// CONFIRMED 2026-10-20 on the MI auto candidates). Cloud Assign screen: "Select from list:" <select> + Assign button;
// the Exposures screen has the same flow behind its own Assign button (select-all checkbox first). Prefers
// CC_ASSIGNEE_NAME, then the logged-in adjuster's "Recovery Claims Team" entry, then the first named option. WRITES —
// claim scout --prepare only, approved for TEST.
async function assignFromList(page) {
  const opts = ((await optionsOf(page, 'Select from list:')) || []).map((o) => o.t).filter((t) => t && !/automated assignment/i.test(t));
  if (!opts.length) throw new Blocked('Assign screen offers no named user');
  const want = (process.env.CC_ASSIGNEE_NAME || '').trim();
  const pick = (want && opts.find((t) => t.includes(want))) || opts.find((t) => /Recovery Claims Team/i.test(t)) || opts[0];
  await select(page, 'Select from list:', pick);
  const btn = page.locator('[id^="AssignClaimsPopup-"][id$="_ButtonButton"], [id*="AssignmentPopup"][id$="_ButtonButton"]').first();
  if (await btn.isVisible().catch(() => false)) await btn.click(); else await page.getByRole('button', { name: 'Assign', exact: true }).last().click();
  await settle(page, 3500);
  const failed = await page.getByText(/assignment\(s\) failed|does not have permission to be assigned/i).first().isVisible().catch(() => false);
  if (failed) throw new Blocked(`assignment to "${pick}" was rejected`);
  return pick;
}

async function assignClaimAndExposures(page) {
  const done = [];
  await openActionsMenu(page);
  const item = page.getByRole('menuitem', { name: 'Assign Claim' }).first();
  if (await item.isVisible().catch(() => false)) {
    await item.click();
    await settle(page, 3000);
    done.push(`claim → ${await assignFromList(page)}`);
  } else await closeMenus(page);
  await navigate(page, 'exposures');
  const all = page.locator('[id*="ExposuresLV"] input[type=checkbox], [id*="ExposuresLV"] [role=checkbox]').first();
  const assignBtn = page.getByRole('button', { name: 'Assign', exact: true }).first();
  if (await all.isVisible().catch(() => false) && await assignBtn.isVisible().catch(() => false)) {
    await all.click().catch(() => {});
    await page.waitForTimeout(600);
    await assignBtn.click();
    await settle(page, 3000);
    done.push(`exposures → ${await assignFromList(page)}`);
  }
  return done;
}

// ── Claim parties ───────────────────────────────────────────────────────────────────────────────────────────────
// Insured comes from the claim header ("Ins: NAME"); claimants from the Exposures grid (reused financialsHelper
// reader). Read once per claim and cached on the page object.
async function getParties(page) {
  if (page.__oneIncParties) return page.__oneIncParties;
  const insured = await page.evaluate(() => {
    const m = /Ins:\s*([^\n]+?)\s+(Clmt|DoL|St|Adj|$)/.exec((document.body.innerText || '').replace(/\s+/g, ' '));
    return m ? m[1].trim() : '';
  }).catch(() => '');
  let claimants = [];
  try {
    await openExposuresTabCloud(page);
    claimants = await getAllExposureClaimantsCloud(page);
  } catch (_) { /* reported as "no claimant" by the caller when needed */ }
  page.__oneIncParties = { insured, claimants: [...new Set(claimants)] };
  return page.__oneIncParties;
}

// ── Generic controls ────────────────────────────────────────────────────────────────────────────────────────────
function control(page, label) {
  return page.getByLabel(label, { exact: true }).first();
}

async function optionsOf(page, label) {
  const el = control(page, label);
  if (!await el.isVisible().catch(() => false)) return null;
  return el.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })));
}

// Selects by option text: exact, then case-insensitive contains; a number picks that index among real options.
async function select(page, label, want) {
  const el = control(page, label);
  if (!await el.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)) {
    throw new Blocked(`"${label}" dropdown is not on the screen`);
  }
  let opts = [];
  for (let i = 0; i < 10; i++) {
    opts = await optionsOf(page, label) || [];
    if (opts.some((o) => o.t && !/^<none>$/i.test(o.t))) break;
    await page.waitForTimeout(500);
  }
  const real = opts.filter((o) => o.t && !/^<none>$/i.test(o.t));
  let pick;
  if (typeof want === 'number') pick = real[want];
  else if (want instanceof RegExp) pick = real.find((o) => want.test(o.t));
  else pick = real.find((o) => norm(o.t) === norm(want)) || real.find((o) => norm(o.t).includes(norm(want)));
  if (!pick) throw new Blocked(`"${label}" has no option ${want instanceof RegExp ? want : `"${want}"`} (options: ${real.map((o) => o.t).join(', ') || 'none'})`);
  await el.selectOption(pick.v);
  await settle(page, 2000);
  return pick.t;
}

async function fill(page, label, value) {
  let el = control(page, label);
  const visible = await el.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  // Date fields: the label resolves to the date WIDGET wrapper, not its <input> ("Element is not an <input>" —
  // CONFIRMED 2026-10-21 on Service Period Start / Payment Date), so use the widget's own input then too.
  const fillable = visible && await el.evaluate((n) => /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName) || n.isContentEditable).catch(() => false);
  if (!fillable) {
    // Fallback: the input inside the field's gw-InputWidget (date inputs such as Service Period / Payment Date are
    // not always reachable by label — CONFIRMED 2026-10-20 on the WC claim).
    const f = findField(await readScreen(page), label);
    el = f && f.id ? page.locator(`[id="${f.id}"] input:not([type=hidden]), [id="${f.id}"] textarea`).first() : null;
    if (!el || !await el.isVisible().catch(() => false)) throw new Blocked(`"${label}" field is not on the screen`);
  }
  await el.fill(String(value));
  await el.press('Tab').catch(() => {});
  await settle(page, 1200);
}

// Yes/No questions are role="radio" divs inside the field's gw-InputWidget; find the widget by its label text.
async function answer(page, label, value) {
  const screen = await readScreen(page);
  const f = findField(screen, label);
  if (!f || !f.radios) throw new Blocked(`question "${label}" is not on the screen`);
  const widget = f.id ? page.locator(`[id="${f.id}"]`) : page.locator('.gw-InputWidget', { hasText: label }).first();
  await widget.getByRole('radio', { name: value, exact: true }).first().click();
  await settle(page, 1800);
}

// Any still-unanswered Yes/No question on the screen gets "No" — used only to get PAST a step to the one under test.
async function answerUnansweredNo(page) {
  const screen = await readScreen(page);
  for (const f of screen.fields.filter((x) => x.radios && !x.radios.some((r) => r.checked))) {
    const widget = f.id ? page.locator(`[id="${f.id}"]`) : null;
    if (!widget) continue;
    await widget.getByRole('radio', { name: 'No', exact: true }).first().click().catch(() => {});
    await settle(page, 1200);
  }
}

async function clickButton(page, name) {
  const b = page.getByRole('button', { name, exact: true }).first();
  if (!await b.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) {
    throw new Blocked(`"${name}" button is not on the screen`);
  }
  await b.click();
  await settle(page, 3500);
}

// ── Menus / navigation ──────────────────────────────────────────────────────────────────────────────────────────
async function visibleMenuItems(page) {
  return page.evaluate(() => [...document.querySelectorAll('[role=menuitem]')].filter((e) => e.offsetParent)
    .map((e) => (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
}

async function openActionsMenu(page) {
  await page.getByRole('button', { name: 'deferred Actions' }).click();
  await settle(page, 1200);
  return visibleMenuItems(page);
}

async function closeMenus(page) {
  await page.keyboard.press('Escape').catch(() => {});
  // The click-overlay only exists while a menu/dropdown is open — clicking it blind waited the full action timeout.
  const overlay = page.locator('#gw-click-overlay');
  if (await overlay.isVisible().catch(() => false)) await overlay.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
}

const NAV_IDS = {
  summary: 'Claim-MenuLinks-Claim_ClaimSummaryGroup',
  exposures: 'Claim-MenuLinks-Claim_ClaimExposures',
  lossDetails: 'Claim-MenuLinks-Claim_ClaimLossDetailsGroup',
  parties: 'Claim-MenuLinks-Claim_ClaimPartiesGroup',
  financials: 'Claim-MenuLinks-Claim_ClaimFinancialsGroup',
  checks: 'Claim-MenuLinks-Claim_ClaimFinancialsGroup-ClaimFinancialsGroup_ClaimFinancialsChecks',
  transactions: 'Claim-MenuLinks-Claim_ClaimFinancialsGroup-ClaimFinancialsGroup_ClaimFinancialsTransactions',
};

async function navigate(page, where) {
  const id = NAV_IDS[where];
  if (!id) throw new Error(`unknown screen "${where}"`);
  // Clicking "Financials" again while its summary is already showing toggles the nav group and the grid never
  // re-renders (CONFIRMED 2026-10-20) — stay put instead.
  if (where === 'financials' && await page.locator('[id^="ClaimFinancialsSummary-"]').first().isVisible().catch(() => false)) return;
  // From Checks / Transactions the Financials group is EXPANDED, and clicking its header collapses it instead of
  // opening the Summary (reported 2026-10-21) — click the group's own "Summary" sub-item when it is showing.
  if (where === 'financials') {
    const sub = page.locator(`[id^="${NAV_IDS.financials}-ClaimFinancialsGroup_ClaimFinancialsSummary"]`).first();
    if (await sub.isVisible().catch(() => false)) {
      await sub.click();
      await settle(page, 3500);
      if (await page.locator('[id^="ClaimFinancialsSummary-"]').first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) return;
    }
  }
  const link = page.locator(`[id="${id}"]`).first();
  if (!await link.isVisible().catch(() => false)) {
    // Sub-items only render once their group is expanded.
    if (where === 'checks' || where === 'transactions') await page.locator(`[id="${NAV_IDS.financials}"]`).first().click().catch(() => {});
    await settle(page, 2500);
  }
  if (!await link.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)) {
    throw new Blocked(`left-nav item for "${where}" is not on the claim`);
  }
  await link.click();
  await settle(page, 3500);
}

// Financials summary: leaf reserve rows carry an "options" button (Edit Reserve | Quick Payment | Create Payment).
// Prefer a row with a positive Remaining Reserve, since Partial/Final payments need one.
// needZeroReserve: a reserve line whose Remaining Reserve is $0 (VBR.013/014/021 "zero" cases on Quick Payment).
async function openFinancialsRowMenu(page, { needOpenReserve = false, needZeroReserve = false } = {}) {
  await navigate(page, 'financials');
  // The grid's rows render after the screen itself — wait for a reserve-row options button before reading them.
  await page.getByRole('button', { name: 'options', exact: true }).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const rowIdx = await page.evaluate(() => {
    // INNERMOST rows only: the summary grid sits inside an outer <tr> ("Claim Total …") that also contains every
    // options button — CONFIRMED 2026-10-20 that matching it picked the claim total's positive reserve, then clicked
    // the first options button inside it, which belonged to a line with NO reserve (→ PMS PL50 on Quick Payment).
    const rows = [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr')
      && [...r.querySelectorAll('[role=button]')].some((b) => (b.getAttribute('aria-label') || b.innerText || '').trim() === 'options'));
    const amount = (r) => {
      const b = r.querySelector('[id$="-RemainingReserves_button"]');
      const n = parseFloat(((b && b.innerText) || '').replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    };
    const withRes = rows.findIndex((r) => amount(r) > 0);
    const zero = rows.findIndex((r) => amount(r) === 0);
    rows.forEach((r, i) => r.setAttribute('data-oneinc-row', String(i)));
    return { count: rows.length, withRes, zero };
  });
  if (!rowIdx.count) throw new Blocked('the Financials summary has no reserve rows with an options menu');
  if (needOpenReserve && rowIdx.withRes < 0) throw new Blocked('no reserve line on this claim has an open (positive) remaining reserve');
  if (needZeroReserve && rowIdx.zero < 0) throw new Blocked('no reserve line on this claim has $0 remaining reserve');
  const idx = needZeroReserve ? rowIdx.zero : rowIdx.withRes >= 0 ? rowIdx.withRes : rowIdx.count - 1;
  await page.locator(`tr[data-oneinc-row="${idx}"]`).getByRole('button', { name: 'options', exact: true }).first().click();
  await settle(page, 1200);
  return visibleMenuItems(page);
}

// ── Wizard entry / exit ─────────────────────────────────────────────────────────────────────────────────────────
// via: 'actions' (Actions › New Payment), 'financials' (row › Create Payment), 'quick' (row › Quick Payment).
async function openPayment(page, via = 'actions', opts = {}) {
  if (via === 'actions') {
    const items = await openActionsMenu(page);
    const np = page.getByRole('menuitem', { name: /^New Payment/ }).first();
    if (!await np.isVisible().catch(() => false)) {
      await closeMenus(page);
      throw new Blocked(`Actions menu has no "New Payment" item (items: ${items.slice(0, 40).join(', ')})`);
    }
    await np.click();
  } else {
    const items = await openFinancialsRowMenu(page, opts);
    const name = via === 'quick' ? /^Quick (Payment|Check)$/ : /^Create (Payment|Check)$/;
    const mi = page.getByRole('menuitem', { name }).first();
    if (!await mi.isVisible().catch(() => false)) {
      await closeMenus(page);
      throw new Blocked(`Financials row menu has no ${via === 'quick' ? 'Quick Payment' : 'Create Payment'} item (items: ${items.filter((x) => /payment|check|reserve/i.test(x)).join(', ')})`);
    }
    await mi.click();
  }
  // Either the wizard or CC's "New Payment Error" page (claim fails Ability to Pay) comes back.
  const ready = await Promise.race([
    page.getByRole('button', { name: 'Next', exact: true }).first().waitFor({ state: 'visible', timeout: 20000 }).then(() => 'wizard').catch(() => null),
    page.getByText('New Payment Error').first().waitFor({ state: 'visible', timeout: 20000 }).then(() => 'error').catch(() => null),
  ]);
  if (ready !== 'wizard') {
    const err = await newPaymentErrorText(page);
    const s = await readScreen(page);
    throw new Blocked(`payment wizard did not open — ${(err ? `New Payment Error: ${err}` : '') || (s.south || s.messages.join(' / ') || 'no message').slice(0, 300)}`);
  }
  await settle(page, 2500);
}

// Never saves: Cancel, confirm the exit, and fall back to Close. Safe to call when no wizard is open.
// CONFIRMED 2026-10-20: the wizard's Cancel raises a NATIVE window.confirm() ("exit the wizard?"), which Playwright
// dismisses by default — so the cancel was silently refused and the next scenario found the old wizard still open.
// Accept that one dialog while cancelling.
async function cancelWizard(page) {
  const accept = (d) => d.accept().catch(() => {});
  page.on('dialog', accept);
  try {
    for (let i = 0; i < 3 && await inWizard(page); i++) {
      await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(1500);
      for (const n of ['OK', 'Yes']) {
        const b = page.getByRole('button', { name: n, exact: true }).first();
        if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); break; }
      }
      await settle(page, 2000);
    }
  } finally {
    page.off('dialog', accept);
  }
  await closeMenus(page);
}

// ── Vendor payees ───────────────────────────────────────────────────────────────────────────────────────────────
// Approved Vendor (Company) contacts in the cloud TEST Address Book, supplied by the user 2026-10-20 (found via the
// payee picker's search: Type = Vendor (Company), status Approved). Override with ONEINC_VENDORS as JSON:
//   [{"name":"ADJUSTMENT SERVICES INC","search":"ADJUSTMENT SERVICES","taxId":"58-1623664"}, ...]
const DEFAULT_VENDORS = [
  { name: 'ADJUSTMENT SERVICES INC', search: 'ADJUSTMENT SERVICES', taxId: '58-1623664' },
  { name: 'LITIGATION SOLUTIONS LLC', search: 'LITIGATION SOLUTIONS', taxId: '25-1834107' },
  { name: 'TAYLOR REPORTING SERVICE', search: 'TAYLOR REPORTING', taxId: '58-2338930' },
  { name: 'ESQUIRE DEPOSITION SOLUTIONS LLC', search: 'ESQUIRE DEPOSITION', taxId: '45-3463120' },
];
function vendors() {
  try { return process.env.ONEINC_VENDORS ? JSON.parse(process.env.ONEINC_VENDORS) : DEFAULT_VENDORS; } catch (_) { return DEFAULT_VENDORS; }
}

// Step 1: Name picker (the arrow beside Name) › Search › Vendor (Company) by name › Select the row with that Tax ID.
// The picker's own Search item has a stable id — a role/text lookup hits the top-nav "Search" instead (CONFIRMED).
// Opens the Name picker's Search. On Quick Payment the icon click sometimes leaves the menu closed, and the Search
// item then exists but is hidden ("Element is not visible" — CONFIRMED 2026-10-27, GCCM-1003 CPD-Joint TC-252):
// click the icon again until the item shows.
async function openPayeeSearch(page) {
  const icon = page.locator('[id$="PrimaryPayee_Name-PrimaryPayee_NameMenuIcon"]').first();
  const item = page.locator('[id$="PrimaryPayee_Name-MenuItem_Search"]').first();
  for (let i = 0; i < 4 && !await item.isVisible().catch(() => false); i++) {
    await icon.click({ force: true }).catch(() => {});
    await item.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
  }
  await item.click({ force: true });
}

async function selectVendorPayee(page, index = 0) {
  const v = vendors()[index];
  if (!v) throw new Blocked(`no vendor #${index + 1} configured (ONEINC_VENDORS)`);
  // force: on Quick Payment a plain click on the icon container never opened the menu (CONFIRMED 2026-10-21).
  await openPayeeSearch(page);
  await settle(page, 3500);
  await select(page, 'Type', 'Vendor (Company)').catch(() => {});
  await page.getByLabel('Name', { exact: true }).last().fill(v.search || v.name);
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await settle(page, 4500);
  const row = page.locator('tr').filter({ hasText: v.taxId }).filter({ has: page.getByRole('button', { name: 'Select', exact: true }) }).last();
  if (!await row.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new Blocked(`vendor "${v.name}" (Tax ID ${v.taxId}) not found in the Address Book search`);
  }
  await row.getByRole('button', { name: 'Select', exact: true }).first().click();
  await settle(page, 3500);
  return `${v.name} (${v.taxId})`;
}

// ── Payees step ─────────────────────────────────────────────────────────────────────────────────────────────────
// who: 'insured' | 'claimant' | 'other' (a name that is neither) | 'first' | 'vendor' (Address Book vendor by Tax ID)
// | 'lienholder' / 'lienholder2' (Lienholder/Mortgagee contacts on an AUTO_LIEN claim)
// | an exact contact name.
async function selectPayee(page, who = 'claimant') {
  if (who === 'vendor') return selectVendorPayee(page, 0);
  // The Name list fills over a server round-trip after the wizard renders — poll before calling it empty.
  let names = [];
  for (let i = 0; i < 16 && !names.length; i++) {
    const opts = (await optionsOf(page, 'Name')) || [];
    names = opts.map((o) => o.t).filter((t) => t && !/^<none>$/i.test(t));
    if (!names.length) await page.waitForTimeout(500);
  }
  if (!names.length) throw new Blocked('payee Name list is empty');
  // 'sni': the contact CC itself types "Secondary Named Insured" (from the policy) — try candidates until one comes back so.
  if (who === 'sni') {
    const parties = page.__oneIncParties || { insured: '' };
    for (const cand of names.filter((t) => norm(t) !== norm(parties.insured) && !/donegal|insurance|agency|bank|garage|body|services|\binc\b|\bllc\b/i.test(t))) {
      await select(page, 'Name', cand);
      await settle(page, 1500);
      const typ = await page.evaluate(() => { const x = [...document.querySelectorAll('select')].find((e) => /PayeeType|-Type$/.test(e.name || '') && e.offsetParent); return x ? (x.options[x.selectedIndex] || {}).text : ''; }).catch(() => '');
      if (/secondary named insured/i.test(typ || '')) return cand;
    }
    throw new Blocked(`no contact on this claim is typed "Secondary Named Insured" (${names.join(', ')})`);
  }
  const pick = resolvePayee(page, who, names);
  await select(page, 'Name', pick);
  await settle(page, 1500);
  await setPayeeRoleType(page, who);
  return pick;
}

// CC fills the payee Type from the contact's roles, and a contact that is both the insured and the claimant (every PA auto
// claim: DMG LMB TEST) comes back as "Claimant" — so a case that says "single Insured payee" would silently be run as a
// claimant (QA review 2026-10-26, GCCM-759 CPD TC-005). Set the Type the case names whenever CC offers it.
const ROLE_TYPE = { insured: /^insured$/i, claimant: /^claimant$/i };
async function setPayeeRoleType(page, who) {
  const want = ROLE_TYPE[who];
  if (!want) return;
  const opts = ((await optionsOf(page, 'Type').catch(() => null)) || []).map((o) => o.t);
  const target = opts.find((t) => want.test(t));
  if (!target) return;
  const cur = await page.evaluate(() => { const x = [...document.querySelectorAll('select')].find((e) => /PayeeType|-Type$/.test(e.name || '') && e.offsetParent); return x ? (x.options[x.selectedIndex] || {}).text : ''; }).catch(() => '');
  if (want.test(cur || '')) return;
  await select(page, 'Type', target);
  await settle(page, 1500);
}

// Which of the payee `names` is `who` (see selectPayee). Throws Blocked when the claim has no such contact.
function resolvePayee(page, who, names) {
  const parties = page.__oneIncParties || { insured: '', claimants: [] };
  let pick;
  if (who === 'insured') pick = names.find((n) => norm(n) === norm(parties.insured));
  else if (who === 'claimant') pick = names.find((n) => parties.claimants.some((c) => norm(c) === norm(n)) && norm(n) !== norm(parties.insured))
    || names.find((n) => parties.claimants.some((c) => norm(c) === norm(n)))
    // No exposure claimant listed (property claims, CONFIRMED 2026-10-21) — the insured is the first-party claimant.
    || (!parties.claimants.length ? names.find((n) => norm(n) === norm(parties.insured)) || names.find((n) => !/donegal/i.test(n)) : undefined);
  else if (who === 'other') pick = names.find((n) => norm(n) !== norm(parties.insured) && !parties.claimants.some((c) => norm(c) === norm(n)) && !/donegal/i.test(n));
  else if (who === 'first') pick = names[0];
  // A Lienholder/Mortgagee contact set up by claimCheck's lienholders prepare (AUTO_LIEN): ACNB BANK or a configured one.
  // Order matters (QA review 2026-10-26): the vehicle/property loan is recorded against lienholders()[0] (addIncidentLoan), and the
  // lienholder defaults (CPD.016/017) only apply to the lienholder named on the loan, so that contact comes first.
  else if (/^lienholder(2)?$/.test(who)) pick = [...lienholders().map((l) => l.name), 'ACNB BANK'].map((l) => names.find((n) => norm(n) === norm(l))).filter(Boolean)[who === 'lienholder2' ? 1 : 0];
  else pick = names.find((n) => norm(n) === norm(who));
  if (!pick) throw new Blocked(`no "${who}" payee among this claim's contacts (${names.join(', ')}; insured=${parties.insured || '?'}, claimants=${parties.claimants.join('/') || '?'})`);
  return pick;
}

// Step 1 › Add Joint Payees: a Name/Type grid (…NewCheckPayeeDVPayeesLV-<n>-PayeeName / -PayeeType; row 0 is the
// primary payee, CONFIRMED 2026-10-21). `list` = [{ who, type? }] for the payees AFTER the primary. CC fills Type from
// the contact's role; `type` overrides it (e.g. 'Insured' for a contact that is both insured and claimant).
async function addJointPayees(page, list) {
  const LV = 'NewCheckPayeeDVPayeesLV';
  const sel = (i, k) => page.locator(`select[name$="${LV}-${i}-${k}"]`).first();
  if (!await sel(1, 'PayeeName').isVisible().catch(() => false)) {
    await clickButton(page, 'Add Joint Payees');
    await settle(page, 2500);
  }
  const added = [];
  for (let k = 0; k < list.length; k++) {
    const i = k + 1;
    if (!await sel(i, 'PayeeName').isVisible().catch(() => false)) {
      await page.locator(`[id$="${LV}_tb-Add"]`).first().click().catch(() => clickButton(page, 'Add'));
      await settle(page, 2000);
    }
    const opts = await sel(i, 'PayeeName').locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));
    const already = added.concat([await sel(0, 'PayeeName').evaluate((x) => (x.options[x.selectedIndex] || {}).text).catch(() => '')]);
    const names = opts.map((o) => o.t).filter((t) => t && !/^<none>$/i.test(t) && !already.some((a) => norm(a) === norm(t)));
    let pick;
    if (list[k].who === 'sni') {
      // The contact CC itself types "Secondary Named Insured" (from the policy) — try candidates until one comes back so.
      const lienNames = ['ACNB BANK', ...lienholders().map((l) => l.name)];
      for (const cand of names.filter((t) => !/donegal|insurance|agency/i.test(t) && !lienNames.some((l) => norm(l) === norm(t)))) {
        await sel(i, 'PayeeName').selectOption(opts.find((o) => o.t === cand).v);
        await settle(page, 1800);
        if (/secondary named insured/i.test(await sel(i, 'PayeeType').evaluate((x) => (x.options[x.selectedIndex] || {}).text || '').catch(() => ''))) { pick = cand; break; }
      }
      if (!pick) throw new Blocked(`no contact on this claim is typed "Secondary Named Insured" (${names.join(', ')})`);
    } else {
      pick = resolvePayee(page, list[k].who, names);
      await sel(i, 'PayeeName').selectOption(opts.find((o) => o.t === pick).v);
      await settle(page, 2000);
    }
    const typeSel = sel(i, 'PayeeType');
    const tOpts = await typeSel.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));
    const cur = await typeSel.evaluate((x) => (x.options[x.selectedIndex] || {}).text || '').catch(() => '');
    const wantType = list[k].type || (/^<none>$|^$/.test(cur) ? ({ insured: 'Insured', claimant: 'Claimant', lienholder: 'Lienholder/Mortgagee', lienholder2: 'Lienholder/Mortgagee' })[list[k].who] : null);
    if (wantType) {
      const o = tOpts.find((x) => norm(x.t) === norm(wantType));
      if (!o) throw new Blocked(`joint payee type "${wantType}" not offered for ${pick} (${tOpts.map((x) => x.t).join(', ')})`);
      await typeSel.selectOption(o.v);
      await settle(page, 1500);
    }
    added.push(pick);
  }
  return added;
}

// ── Payments step ───────────────────────────────────────────────────────────────────────────────────────────────
// kind: 'open' (a line with Available Reserves > 0), 'existing' (first existing line), 'new' ("Expense OR First and
// Final", which opens Exposure / Cost Type / Cost Category).
async function selectReserveLine(page, kind = 'open') {
  const opts = (await optionsOf(page, 'Reserve Line')) || [];
  const real = opts.filter((o) => o.t && !/^<none>$/i.test(o.t));
  if (!real.length) throw new Blocked('Reserve Line has no options');
  const isNew = (o) => /expense or first and final|new/i.test(o.t);
  if (kind === 'new') {
    const n = real.find(isNew);
    if (!n) throw new Blocked(`Reserve Line has no new-line option (options: ${real.map((o) => o.t).join(', ')})`);
    return select(page, 'Reserve Line', n.t);
  }
  const existing = real.filter((o) => !isNew(o));
  if (!existing.length) throw new Blocked('claim has no existing reserve line');
  if (kind === 'existing') return select(page, 'Reserve Line', existing[0].t);
  // 'match:<regex>' picks the first existing line whose text matches (e.g. 'match:Bodily Injury').
  if (typeof kind === 'string' && kind.startsWith('match:')) {
    const re = new RegExp(kind.slice(6), 'i');
    const hit = existing.find((o) => re.test(o.t));
    if (!hit) throw new Blocked(`no Reserve Line matches /${kind.slice(6)}/ (options: ${existing.map((o) => o.t).join(', ')})`);
    return select(page, 'Reserve Line', hit.t);
  }
  // 'open' wants Available Reserves > 0; 'zero' wants a line with none left (shown as "-" or $0.00).
  for (const o of existing) {
    await select(page, 'Reserve Line', o.t);
    const amt = await availableReserves(page);
    if (kind === 'open' ? amt > 0 : !(amt > 0)) return o.t;
  }
  throw new Blocked(kind === 'open' ? 'no reserve line on this claim has open Available Reserves'
    : 'every reserve line on this claim still has an open reserve (needs one at $0)');
}

async function availableReserves(page) {
  const f = findField(await readScreen(page), 'Available Reserves');
  const n = parseFloat(String((f && f.value) || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

async function fillLineItem(page, amount = '1.00') {
  // The line-item grid renders one editable row; its Category is a select inside the grid, its amount a "$" box.
  // Both stay DISABLED until a reserve line is chosen (CONFIRMED 2026-10-20 — selectOption then hung 20s), so skip
  // them when disabled: a scenario that deliberately leaves Reserve Line blank still gets to press Next.
  const cat = page.locator('[id*="LineItemsLV"] select').first();
  if (await cat.isVisible().catch(() => false) && await cat.isEnabled().catch(() => false)) {
    const vals = await cat.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));
    const real = vals.filter((o) => o.v && !/^<none>$/i.test(o.t));
    if (real.length && !(await cat.inputValue().catch(() => ''))) { await cat.selectOption(real[0].v, { timeout: 5000 }).catch(() => {}); await settle(page, 1500); }
  }
  const amt = page.locator('[id*="LineItemsLV"] input[type=text]').last();
  if (await amt.isVisible().catch(() => false) && await amt.isEnabled().catch(() => false)) {
    await amt.fill(String(amount), { timeout: 5000 }).catch(() => {});
    await amt.press('Tab').catch(() => {});
    await settle(page, 1200);
  }
}

// Fills Step 2 with the minimum valid data so Next can reach Step 3. Nothing is saved — Step 3 still needs Finish.
// amount 'AVAILABLE' = the reserve line's Available Reserves (VBR.009). keepExposure leaves a new line's Exposure as
// set by the scenario (claim-level for VBR.018); skipAdjuster leaves Adjuster Number blank (VBR.033).
// Default amount is deliberately odd: CC's duplicate-check flags a new check matching an earlier one's payee+amount
// ("Possible duplicate payment found"), and the test claims already carry earlier $1.00 checks.
// amount 'EXCEED' = Available Reserves + $100 (VBR.050 PMS SC04); lineAmount puts a different amount on the line item than
// the Total Amount of Payment (VBR.051).
async function completePaymentsStep(page, { transactionType = 'Partial Payment', amount = '1.37', costType, keepExposure = false, skipAdjuster = false, lineAmount } = {}) {
  if (costType) await select(page, 'Cost Type', costType);
  const exposure = findField(await readScreen(page), 'Exposure');
  if (exposure && exposure.kind === 'select' && !keepExposure && /claim-level|<none>/i.test(exposure.value || '')) {
    const ex = (await optionsOf(page, 'Exposure')) || [];
    const real = ex.filter((o) => o.t && !/claim-level|<none>/i.test(o.t));
    if (real.length) await select(page, 'Exposure', real[0].t);
  }
  const costTypeField = findField(await readScreen(page), 'Cost Type');
  if (costTypeField && costTypeField.kind === 'select' && /<none>|^$/i.test(costTypeField.value || '')) await select(page, 'Cost Type', 'Claim Cost').catch(() => {});
  if (findField(await readScreen(page), 'Transaction Type')) await select(page, 'Transaction Type', transactionType).catch(() => {});
  let amt = amount;
  if (amount === 'AVAILABLE' || amount === 'EXCEED') {
    const a = await availableReserves(page);
    if (!(a > 0)) throw new Blocked('reserve line has no open Available Reserves to match');
    amt = (amount === 'EXCEED' ? a + 100 : a).toFixed(2);
  }
  for (const label of ['Total Amount of Payment', 'Confirm Total Amount of Payment']) {
    if (findField(await readScreen(page), label)) await fill(page, label, amt).catch(() => {});
  }
  await fillLineItem(page, lineAmount || amt);
  // Service Period is REQUIRED on WC indemnity and medical payments (CONFIRMED on the WC claim 2026-10-20: "Missing
  // required field Service Period Start/End"). Fill only when required and empty, with today's date — never before
  // the loss date (VBR.012).
  for (const label of ['Service Period Start', 'Service Period End']) {
    const f = findField(await readScreen(page), label);
    if (f && f.required && !f.value) {
      const d = new Date();
      await fill(page, label, `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`).catch(() => {});
    }
  }
  if (findField(await readScreen(page), '1099 Box Number')) await select(page, '1099 Box Number', /not applicable/i).catch(() => {});
  if (!skipAdjuster && findField(await readScreen(page), 'Adjuster Number')) await select(page, 'Adjuster Number', 0).catch(() => {});
  await answerUnansweredNo(page);
  return amt;
}

// Test step (recipes: { call: ['wizardDriver.fillTotalAmount', amt] }): types the Total Amount of Payment and, when Cloud
// shows it, its Confirm box (Cloud TEST 2026-10-28 shows ONE masked box on the Expense step), then lets the page refresh.
async function fillTotalAmount(page, amt) {
  if (!findField(await readScreen(page), 'Total Amount of Payment')) throw new Blocked('"Total Amount of Payment" is not on the screen');
  for (const label of ['Total Amount of Payment', 'Confirm Total Amount of Payment']) {
    if (findField(await readScreen(page), label)) await fill(page, label, String(amt));
  }
  await settle(page, 2000);
}

async function next(page) {
  await clickButton(page, 'Next');
  return readScreen(page);
}

// Fills every REQUIRED field still empty on the screen: dropdowns take their first real option, date-like inputs
// (Service Period Start/End, …) take today. Fields are addressed by their gw-InputWidget id — a label lookup missed
// the WC Service Period inputs (CONFIRMED 2026-10-20). Masked/amount inputs are left alone. Returns what it filled.
async function fillRequiredEmpties(page) {
  const d = new Date();
  const today = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  const filled = [];
  const s = await readScreen(page);
  for (const f of s.fields) {
    if (!f.required || !f.id || f.disabled || f.readonly) continue;
    const root = page.locator(`[id="${f.id}"]`);
    if (f.kind === 'select' && (!f.value || /^<none>$/i.test(f.value))) {
      const sel = root.locator('select').first();
      const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() }))).catch(() => []);
      // ClaimsPay Type is left blank for vendor payees (the CPD.013 finding) — choose "Vendor" there, matching the
      // payee, rather than the first option ("Contact(s)").
      const preferred = /ClaimsPay Type/i.test(f.label) ? opts.find((o) => /^vendor$/i.test(o.t)) : null;
      const pick = preferred || opts.find((o) => o.v && !/^<none>$/i.test(o.t));
      if (pick) { await sel.selectOption(pick.v).catch(() => {}); filled.push(`${f.label}=${pick.t}`); await settle(page, 1200); }
    } else if (f.kind === 'input' && !f.value && /date|period|start|end/i.test(f.label)) {
      const inp = root.locator('input').first();
      await inp.fill(today).catch(() => {});
      await inp.press('Tab').catch(() => {});
      filled.push(`${f.label}=${today}`);
      await settle(page, 1000);
    }
  }
  return filled;
}

// Next, and if CC answers ONLY with "Missing required field" messages (WC indemnity / medical payments need Service
// Period dates and a Memo Phrase), fill those and press Next once more. Rule messages (PMS…, "must…", "not allowed")
// are left for the caller — they are what the scenarios test.
async function nextFillingServicePeriod(page) {
  await clickButton(page, 'Next');
  let s = await readScreen(page);
  const msgs = s.messages.join(' / ');
  const onlyMissing = /Missing required field/i.test(msgs) && !/: (PMS|must|not allowed)/i.test(msgs.replace(/[^/]*Missing required field "[^"]*"/gi, ''));
  if (onlyMissing) {
    const filled = await fillRequiredEmpties(page);
    if (filled.length) {
      await clickButton(page, 'Next');
      s = await readScreen(page);
    }
  }
  return s;
}

// ClaimCenter's own server failure ("An application error occurred … Exception occurred at …") — an environment
// problem, never a verdict on the scenario. Callers turn it into BLOCKED.
function serverError(screen) {
  const t = [...(screen.messages || []), screen.south || ''].join(' / ');
  const m = /An application error occurred[^/]*/i.exec(t);
  return m ? m[0].trim().slice(0, 200) : '';
}

// A warnings-only page: CC stopped Finish/Update to show WARNINGS but nothing that blocks the save — pressing the
// same button again goes through. CC's Validation Results worksheet (#gw-south-panel) heads its blocks "Errors:" /
// "Warnings:" (CONFIRMED 2026-10-21: "Validation Results Clear Warnings: At least one aggregate limit on this claim
// has been exceeded." refused nothing, yet the old "duplicate|warning" text test reported it as a refused Finish).
// Without a worksheet, fall back to the message text: known warning texts and no field-level / PMS error.
const WARNING_TEXT = /duplicate|warning|aggregate limit|payment contact details/i;
const ERROR_TEXT = /Missing required field|: PMS [A-Z]{2}\d+|PMS [A-Z]{2}\d+ :|not allowed|must be|must not|Invalid payee|Validation errors on current page|An application error occurred/i;
function warningsOnly(screen) {
  const south = String((screen && screen.south) || '');
  const msgs = ((screen && screen.messages) || []).join(' / ');
  if (/\bErrors?\s*:/i.test(south) || /Validation errors on current page/i.test(msgs)) return false;
  if (/\bWarnings?\s*:/i.test(south)) return true;
  return WARNING_TEXT.test(msgs) && !ERROR_TEXT.test(msgs.replace(/[^/]*payment contact details[^/]*/gi, ''));
}

// Which wizard step is showing ("Step 2 of 3: Enter payment information").
async function currentStep(page) {
  return page.evaluate(() => {
    const m = /Step (\d) of (\d):\s*([^\n]+)/.exec(document.body.innerText || '');
    return m ? { n: Number(m[1]), of: Number(m[2]), title: m[3].trim() } : null;
  }).catch(() => null);
}

module.exports = {
  Blocked, fillTotalAmount, settle, inWizard, openClaim, newPaymentErrorText, repairSurcharging, assignClaimAndExposures, abilityToPayErrors, abilityToPay, repairVehicleVins, lienholders, addClaimContactWithRole, addClaimPersonContact, addVehicleLoan, addIncidentLoan, addDigitalPaymentAccount, repairClaimantAddress, getParties, optionsOf, select, fill, answer, answerUnansweredNo, clickButton,
  visibleMenuItems, openActionsMenu, closeMenus, navigate, openFinancialsRowMenu,
  openPayment, cancelWizard, selectPayee, addJointPayees, selectVendorPayee, openPayeeSearch, vendors, selectReserveLine, availableReserves, fillLineItem, completePaymentsStep, next, nextFillingServicePeriod, fillRequiredEmpties, serverError, currentStep,
  warningsOnly,
};
