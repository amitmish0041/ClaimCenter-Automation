/**
 * helpers/oneInc/setupE.js
 * UI setup steps for the "setup E" OneInc scenarios (VBR.037 negatives data fixes, VBR.036 mailing address, payee
 * roles). Called from recipes with { call: ['setupE.<fn>', ...args] } → fn(page, ...args), and from profile prepare
 * hooks (fn(page, claim, out)). WRITES to automation-owned claims on the TEST tier only. Added 2026-10-21.
 */
'use strict';
const W = require('./wizardDriver');
const A = require('./setupA');
const { readScreen, findField } = require('./screenReader');

const TIER = (process.env.CC_TIER || 'test').toLowerCase();
function testOnly(what) {
  if (TIER !== 'test') throw new W.Blocked(`${what} writes claim data — allowed on the TEST tier only`);
}

// A Medical Expense / PIP exposure created after FNOL has no injury incident, so it fails the exposure-level Ability
// to Pay ("Exposure description must not be empty", "Detailed body part must not be null" — CONFIRMED 2026-10-21 on
// PA-PA-01-26-0748496; Quick Payment on that reserve line then shows "New Payment Error"). Exposure #index › Edit ›
// Injury Incident › New Incident…: injured person = the exposure claimant, injury description, a body-part row; OK, Update.
async function ensureInjuryIncident(page, index = 0) {
  testOnly('ensureInjuryIncident');
  await A.openExposure(page, index);
  await W.clickButton(page, 'Edit');
  // Read the select in edit mode (the view-mode value is the "View Incident Details..." link text).
  const cur = findField(await readScreen(page), 'Injury Incident');
  if (cur && cur.value && !/^<none>$/i.test(cur.value)) {
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    await W.settle(page, 1500);
    return `injury incident already set (${cur.value})`;
  }
  const icon = page.locator('[id$="Injury_Incident-Injury_IncidentMenuIcon"]').first();
  if (!await icon.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new W.Blocked('exposure has no Injury Incident picker');
  }
  await icon.click({ force: true });
  await page.waitForTimeout(1200);
  await page.getByText('New Incident...', { exact: true }).last().click();
  await W.settle(page, 3500);
  const claimant = await page.evaluate(() => ((document.body.innerText || '').match(/Ins:\s*([^\n]+?)\s+(Clmt|DoL|St|Adj)/) || [])[1] || '');
  await A.selectByLabel(page, 'Injured Person', claimant ? new RegExp(claimant.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : /^(?!<none>)./)
    .catch(() => A.selectByLabel(page, 'Injured Person', /^(?!<none>)./));
  await A.fillByLabel(page, 'Describe Injuries', 'OneInc automation — neck sprain');
  await A.selectByLabel(page, 'General Injury Type', 'Specific injury').catch(() => {});
  await A.selectByLabel(page, 'Detailed Injury Type', /Sprain/).catch(() => {});
  // Body Parts grid: Add a row, then pick the first real option of each empty select in it (Area first, Body Part next).
  await page.locator('[id*="BodyPart"][id$="_tb-Add"], [id*="BodyParts"][id$="-Add"]').first().click()
    .catch(() => page.getByRole('button', { name: 'Add', exact: true }).first().click());
  await W.settle(page, 2000);
  for (let round = 0; round < 3; round++) {
    const sels = page.locator('[id*="BodyPart"] select:visible');
    const n = await sels.count();
    let changed = false;
    for (let i = 0; i < n; i++) {
      const s = sels.nth(i);
      if (await s.inputValue().catch(() => 'x')) continue;
      const v = await s.locator('option').evaluateAll((os) => (os.find((o) => o.value && !/^<none>$/i.test(o.textContent.trim())) || {}).value);
      if (v) { await s.selectOption(v); await W.settle(page, 1500); changed = true; }
    }
    if (!changed) break;
  }
  await W.clickButton(page, 'OK');
  await W.settle(page, 3000);
  if (await page.getByRole('button', { name: 'OK', exact: true }).first().isVisible().catch(() => false)) {
    const why = (await readScreen(page)).messages.join(' / ');
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    await W.settle(page, 1500);
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new W.Blocked(`injury incident could not be saved: ${why.slice(0, 300) || 'no message'}`);
  }
  await A.editAndSave(page, 'exposure injury incident', async () => {});
  return `injury incident added; ${await A.revalidate(page)}`;
}

// ── VBR.036 — check mailing address vs the payee contact's primary address ────────────────────────────────────────
// Two fixed PA addresses so a recipe can set A before paying and B afterwards, then look for B on the check.
const ADDRESSES = {
  A: { line1: '1103 Richmont St', city: 'Scranton', state: 'Pennsylvania', zip: '18509' },
  B: { line1: '1195 River Rd', city: 'Marietta', state: 'Pennsylvania', zip: '17547' },
};

// Parties Involved › contact `name` › Edit › primary address = ADDRESSES[which] › Update. Refuses a contact that is
// linked to the Address Book and maintained in PolicyCenter ("All changes to this contact must be made in
// PolicyCenter" — CONFIRMED 2026-10-21: the insured / policy drivers have no Edit button).
async function changeContactAddress(page, name, which = 'B') {
  testOnly('changeContactAddress');
  const addr = ADDRESSES[which];
  if (!addr) throw new Error(`unknown address "${which}"`);
  await W.cancelWizard(page);
  await W.navigate(page, 'parties');
  await page.locator('tr[id*="LV-0-"]:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const found = await page.evaluate((name) => {
    const cells = [...document.querySelectorAll('[id*="PeopleInvolvedDetailedLV-"][id$="-Name"]')].filter((e) => e.offsetParent);
    const c = cells.find((e) => (e.innerText || '').trim().toUpperCase() === name.toUpperCase());
    if (c) c.setAttribute('data-setupe-contact', '1');
    return !!c;
  }, name);
  if (!found) throw new W.Blocked(`contact "${name}" is not on Parties Involved`);
  await page.locator('[data-setupe-contact="1"]').first().click();
  await W.settle(page, 2500);
  const body = (await readScreen(page)).body;
  if (/must be made in PolicyCenter/i.test(body)) throw new W.Blocked(`"${name}" is maintained in PolicyCenter — its address cannot be changed in ClaimCenter`);
  const linked = /linked to the Address Book and is in sync/i.test(body);
  await W.clickButton(page, 'Edit');
  const fill = async (suffix, v) => {
    const el = page.locator(`input[name$="GlobalAddressInputSet-${suffix}"]`).first();
    if (await el.isVisible().catch(() => false)) { await el.fill(v); await el.press('Tab').catch(() => {}); await page.waitForTimeout(400); }
  };
  await fill('AddressLine1', addr.line1);
  await fill('AddressLine2', '');
  await fill('City', addr.city);
  const st = page.locator('select[name$="GlobalAddressInputSet-State"]').first();
  if (await st.isVisible().catch(() => false)) {
    const o = await st.locator('option').evaluateAll((os) => os.map((x) => ({ v: x.value, t: x.textContent.trim() })));
    const m = o.find((x) => x.t === addr.state);
    if (m) { await st.selectOption(m.v); await W.settle(page, 1200); }
  }
  await fill('PostalCode', addr.zip);
  for (let i = 0; i < 2; i++) {
    await W.clickButton(page, 'Update');
    await page.waitForTimeout(2000);
    if (!await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) break;
  }
  if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
    const msgs = (await readScreen(page)).messages.join(' / ');
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new W.Blocked(`address of "${name}" could not be saved: ${msgs.slice(0, 300) || 'no message'}`);
  }
  return `${name}${linked ? ' (Address Book linked)' : ' (not linked to the Address Book)'} primary address → ${addr.line1}, ${addr.city}`;
}

// Financials › Checks/Payments: the newest check paid to `payee` → { i: row index, num: check number } (or null).
async function latestCheck(page, payee) {
  await W.cancelWizard(page);
  await W.navigate(page, 'checks');
  await page.locator('tr[id*="LV-0-"]:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const idx = await page.evaluate((payee) => {
    const rows = [...document.querySelectorAll('tr[id*="LV-"]')].filter((r) => r.offsetParent && !r.querySelector('tr'));
    let best = null;
    for (const r of rows) {
      const t = r.innerText.replace(/\s+/g, ' ');
      const m = /LV-(\d+)-/.exec(r.id);
      const num = Number((/^\s*(\d{5,})/.exec(t) || [])[1] || 0);
      if (m && t.toUpperCase().includes(payee.toUpperCase()) && (!best || num > best.num)) best = { i: m[1], num };
    }
    return best;
  }, payee);
  return idx;
}

// Remember the newest existing check to `payee` (before a recipe pays), so openLatestCheck only accepts a NEWER one.
async function noteChecks(page, payee) {
  const b = await latestCheck(page, payee);
  page.__setupE_checkFloor = b ? b.num : 0;
  // Leave the Financials group: from Checks/Payments, Quick Payment's navigate('financials') collapses the group
  // instead of showing the summary ("no reserve rows with an options menu", CONFIRMED 2026-10-21).
  // Re-open the claim (resets the left nav).
  const claim = await page.evaluate(() => ((document.body.innerText || '').match(/Claim:\s*([A-Z]{2,3}-[A-Z]{2}-[\d-]+)/) || [])[1] || '');
  if (claim) await W.openClaim(page, claim); else await W.navigate(page, 'exposures').catch(() => {});
  return `existing newest check to ${payee}: ${b ? b.num : 'none'}`;
}

// Open the newest check paid to `payee` (highest Check/Payment Number) and leave its detail screen showing (Mailing
// Address, Tracking Status) for the recipe's text checks. After noteChecks, it must be newer than the noted one.
async function openLatestCheck(page, payee) {
  const b = await latestCheck(page, payee);
  if (!b) throw new W.Blocked(`no check paid to "${payee}" on this claim`);
  if (page.__setupE_checkFloor != null && b.num <= page.__setupE_checkFloor) throw new W.Blocked(`no new check to "${payee}" was created (newest is still ${b.num})`);
  await page.locator(`[id*="LV-${b.i}-"][id$="_button"]:visible`).first().click();
  await W.settle(page, 3500);
  return `opened check ${b.num} paid to ${payee}`;
}

// ── Payee roles (CPD.030 / CPD.031) ─────────────────────────────────────────────────────────────────────────────
// Approved Address Book companies on cloud TEST (Address Book/1099 Contacts search, 2026-10-21) and the claim role each
// case needs. Roles offered on the new-contact Roles grid include "Adverse Carrier/Other Insurance Company",
// "Plaintiff's Attorney", "Primary Plaintiff's Attorney", "Insured's Attorney", "State Agency Payment".
const ROLE_CONTACTS = {
  stateAgency: { name: 'COMMONWEALTH OF PENNSYLVANIA', taxId: '25-1671669', type: 'Vendor (Company)', role: 'State Agency Payment' },
  adverseCarrier: { name: 'STATE FARM INSURANCE COMPANIES INC', taxId: '37-0533100', type: 'Vendor (Company)', role: 'Adverse Carrier/Other Insurance Company' },
  attorney: { name: 'BAIKOW LEGAL LLC', taxId: '02-0725566', type: 'Vendor (Company)', role: "Plaintiff's Attorney" },
};

// Adds ROLE_CONTACTS[key] to the claim with its role (no-op when already on the claim), then re-opens the claim.
async function addRoleContact(page, key) {
  testOnly('addRoleContact');
  const c = ROLE_CONTACTS[key];
  if (!c) throw new Error(`unknown role contact "${key}"`);
  const claim = await page.evaluate(() => ((document.body.innerText || '').match(/Claim:\s*([A-Z]{2,3}-[A-Z]{2}-[\d-]+)/) || [])[1] || '');
  await W.cancelWizard(page);
  const added = await W.addClaimContactWithRole(page, c, c.role);
  if (claim) await W.openClaim(page, claim);
  page.__oneIncParties = null;
  return `${c.name} ${added ? 'added' : 'already on the claim'} (role ${c.role})`;
}

module.exports = { ensureInjuryIncident, changeContactAddress, noteChecks, openLatestCheck, ADDRESSES, ROLE_CONTACTS, addRoleContact };
