/**
 * helpers/oneInc/needsData.js
 * Setup steps for the OneInc cases that were classified "needs data" (review 2026-11-03): claim states the suite did not
 * build yet — a payee with no first name (VBR.042), a claim that fails Ability to Pay (VBR.098), Medicare ICD codes on a
 * third-party Bodily Injury exposure (VBR.049), the Send Status dropdown of a linked document (UIF.068), and a check's
 * status / approval history after it is submitted (VBR.038 escalation). Called from recipes/needsData.js with
 * { call: ['needsData.<fn>', ...args] } → fn(page, ...args). WRITES to automation-owned claims on the TEST tier only.
 *
 * Screen facts (cloud TEST, CONFIRMED 2026-11-03):
 *  - Parties Involved › New Contact › Person: Last name is the only required name field, so a person with no first name
 *    saves. Neither that form nor the claimant's Edit screen has a "Partial or Full Name/Address Unknown" flag.
 *  - Exposure › Medicare tab (third-party Bodily Injury exposure on PA-MD-01-23-0742279, and the WC Medical exposure):
 *    "Is Claimant a Medicare Beneficiary?" <none>/Yes/No; "ICD Diagnostic Codes (Included for Medicare)" grid whose Add
 *    makes an inline row with an ICD Code box (+ search icon).
 */
'use strict';
const W = require('./wizardDriver');
const A = require('./setupA');
const { readScreen, findField, norm } = require('./screenReader');

const TIER = (process.env.CC_TIER || 'test').toLowerCase();
function testOnly(what) {
  if (TIER !== 'test') throw new W.Blocked(`${what} writes claim data — allowed on the TEST tier only`);
}
const editing = (page) => page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false);
const observe = (page, label, text) => require('./checkOps').observe(page, label, text);

// Update, pressing it again on warnings-only pages; Cancel + Blocked with CC's messages when the save is refused.
async function update(page, what) {
  for (let i = 0; i < 3; i++) {
    await W.clickButton(page, 'Update');
    await page.waitForTimeout(1500);
    if (!await editing(page)) return;
  }
  const s = await readScreen(page);
  const msgs = [...s.messages, s.south].filter(Boolean).join(' / ');
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
  await W.settle(page, 1500);
  throw new W.Blocked(`${what} could not be saved: ${msgs.slice(0, 300) || 'no message'}`);
}

// ── VBR.042 — payee with no first name ──────────────────────────────────────────────────────────────────────────
// A claim-only person contact with a last name only (role Covered Party), to be picked as the payee by that name.
async function addLastNameOnlyContact(page, last = 'NOFIRSTNAME', role = 'Covered Party') {
  testOnly('addLastNameOnlyContact');
  await W.cancelWizard(page).catch(() => {});
  const added = await W.addClaimPersonContact(page, { first: '', last, role });
  return added ? `added person "${last}" (no first name) as ${role}` : `person "${last}" already on the claim`;
}

// ── VBR.098 — claim that does not pass Ability to Pay ───────────────────────────────────────────────────────────
// Ability to Pay fails when the claimant has no primary address line 1 / city ("The claimant's primary address line 1 /
// city / state must not be empty", seen on new WC claims 2026-10-21). Clears Address 1 and City of the contact with the
// Claimant role. The claim is used by this one case only (a payment-type recipe gets its own claim).
async function clearClaimantAddress(page) {
  testOnly('clearClaimantAddress');
  await W.cancelWizard(page).catch(() => {});
  await W.navigate(page, 'parties');
  await page.locator('tr[id*="LV-0-"]:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const found = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr') && r.querySelector('[id$="-Name"]'));
    const r = rows.find((x) => /\bClaimant\b/.test(x.innerText));
    if (r) r.setAttribute('data-nd-claimant', '1');
    return !!r;
  });
  if (!found) throw new W.Blocked('no contact with the Claimant role on Parties Involved');
  await page.locator('tr[data-nd-claimant="1"] [id$="-Name"]').first().click();
  await W.settle(page, 2500);
  await W.clickButton(page, 'Edit');
  for (const k of ['AddressLine1', 'City']) {
    const el = page.locator(`input[name$="GlobalAddressInputSet-${k}"]`).first();
    if (await el.isVisible().catch(() => false)) { await el.fill(''); await el.press('Tab').catch(() => {}); await page.waitForTimeout(500); }
  }
  await update(page, 'claimant address (cleared)');
  return 'claimant Address 1 and City cleared';
}

// Actions › New Payment, leaving CC's answer on the screen ("New Payment Error" page or the wizard). Written to the
// "New Payment outcome" field for the checks.
async function tryNewPayment(page) {
  await require('./setupC').openFromActions(page, 'actions');
  const err = await W.newPaymentErrorText(page);
  const s = await readScreen(page);
  const text = err || [...s.messages, s.south].filter(Boolean).join(' / ') || (await W.inWizard(page) ? 'payment wizard opened' : 'nothing');
  return observe(page, 'New Payment outcome', text);
}

// ── VBR.049 — Medicare ICD codes on a (non-WC) exposure ─────────────────────────────────────────────────────────
// Exposure whose row matches `match` (Exposures list): Medicare tab › "Is Claimant a Medicare Beneficiary?" = beneficiary
// ('Yes' | 'No' | '<none>'), and the Included ICD codes = [icd] (or none). Idempotent.
async function openExposureMatching(page, match) {
  await W.navigate(page, 'exposures');
  await page.locator('tr[id*="ExposuresLV-0-"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const re = new RegExp(match, 'i');
  const i = await page.evaluate((src) => {
    const r = new RegExp(src, 'i');
    const rows = [...document.querySelectorAll('tr[id*="ExposuresLV-"]')].filter((x) => x.offsetParent && /ExposuresLV-\d+-/.test(x.id) && !x.querySelector('tr'));
    const hit = rows.find((x) => r.test(x.innerText || ''));
    return hit ? Number(/ExposuresLV-(\d+)-/.exec(hit.id)[1]) : -1;
  }, re.source);
  if (i < 0) throw new W.Blocked(`no exposure matching /${match}/ on this claim`);
  await A.openExposure(page, i);
}
const ICD_ROWS = '[id*="includedICDLVI"] tr[id*="MedicalDiagnosisLV-"]';
async function includedIcds(page) {
  return page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((r) => r.offsetParent && /LV-\d+-/.test(r.id) && !r.querySelector('tr'))
    .map((r) => { const i = r.querySelector('input:not([type=hidden]):not([type=checkbox])'); return ((i && i.value) || r.innerText || '').replace(/\s+/g, ' ').trim(); }).filter(Boolean), ICD_ROWS);
}
async function setExposureMedicare(page, match = 'Bodily Injury', { beneficiary = 'Yes', icd = null } = {}) {
  testOnly('setExposureMedicare');
  await W.cancelWizard(page).catch(() => {});
  await openExposureMatching(page, match);
  await page.getByText('Medicare', { exact: true }).first().click();
  await W.settle(page, 2500);
  const cur = findField(await readScreen(page), 'Is Claimant a Medicare Beneficiary?');
  const have = await includedIcds(page);
  const wantVal = beneficiary === '<none>' ? '' : beneficiary;
  const sameIcd = icd ? have.length === 1 && norm(have[0]).startsWith(norm(icd)) : have.length === 0;
  if (cur && norm(cur.value) === norm(wantVal) && sameIcd) return `Medicare already ${beneficiary || '<none>'}, ICD ${icd || 'none'}`;
  await W.clickButton(page, 'Edit');
  await W.settle(page, 2000);
  await A.selectByLabel(page, 'Is Claimant a Medicare Beneficiary?', beneficiary === '<none>' ? /^<none>$/ : beneficiary);
  // Included ICD codes: remove every row, then add the wanted one.
  const boxes = page.locator(`${ICD_ROWS} input[type=checkbox]`);
  if (await boxes.count()) {
    for (let i = 0, n = await boxes.count(); i < n; i++) await boxes.nth(i).check({ force: true }).catch(() => {});
    await page.locator('[id$="includedICDs_toolbar-Remove"]').first().click().catch(() => {});
    await W.settle(page, 1500);
  }
  if (icd) {
    await page.locator('[id$="includedICDs_toolbar-Add"]').first().click();
    await W.settle(page, 1500);
    // The new row's ICD Code box (no type attribute — `input[type=text]` timed out, 2026-11-03).
    const box = page.locator('[id*="includedICDLVI"] input:not([type=hidden]):not([type=checkbox])').filter({ visible: true }).last();
    await box.fill(icd);
    await box.press('Tab').catch(() => {});
    await W.settle(page, 2500);
  }
  const orm = findField(await readScreen(page), 'Is There ORM?');
  if (orm && beneficiary === 'Yes' && !orm.value.replace(/<none>/i, '')) await A.selectByLabel(page, 'Is There ORM?', 'No').catch(() => {});
  await update(page, `Medicare (${beneficiary}, ICD ${icd || 'none'})`);
  await page.getByText('Medicare', { exact: true }).first().click().catch(() => {});
  await W.settle(page, 1500);
  const after = findField(await readScreen(page), 'Is Claimant a Medicare Beneficiary?');
  const icds = await includedIcds(page);
  if (!after || norm(after.value) !== norm(wantVal)) throw new W.Blocked(`Medicare beneficiary did not stick (shows "${after ? after.value : '?'}")`);
  if (icd && !icds.some((x) => norm(x).includes(norm(icd)))) throw new W.Blocked(`ICD code ${icd} did not stick (included codes: ${icds.join(', ') || 'none'})`);
  return `exposure /${match}/ Medicare beneficiary → ${beneficiary}, included ICD codes → ${icds.join(', ') || 'none'}`;
}

// ── UIF.068 — Send Status options of a linked document (payment wizard Step 3, Linked Documents grid) ──────────────
async function sendStatusOptions(page) {
  const opts = await page.evaluate(() => {
    const grid = [...document.querySelectorAll('[id*="LinkedDocument"], [id*="DocumentsLV"]')].find((e) => e.offsetParent && e.querySelector('select'));
    const sel = grid ? [...grid.querySelectorAll('select')].find((s) => s.offsetParent && [...s.options].some((o) => /send/i.test(o.text))) : null;
    return sel ? [...sel.options].map((o) => o.text.trim()).filter(Boolean) : null;
  });
  if (!opts) throw new W.Blocked('no Send Status dropdown in the Linked Documents grid');
  return observe(page, 'Send Status options', opts.join(' | '));
}

// ── VBR.038 — status / approval history of the check of `amount` (after the Financials Escalation batch) ────────────
async function checkStatus(page, amount) {
  const C = require('./checkOps');
  await C.openCheck(page, { amount });
  const st = findField(await readScreen(page), 'Status');
  await C.approvalHistory(page);
  return observe(page, 'Check status', (st && st.value) || 'unknown');
}

module.exports = { addLastNameOnlyContact, clearClaimantAddress, tryNewPayment, setExposureMedicare, sendStatusOptions, checkStatus };
