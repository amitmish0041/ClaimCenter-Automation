/**
 * helpers/oneInc/cmCreate.js — NEW ContactManager companies for GCCM-795 INT.001 (CreateVendor trigger), added 2026-11-13
 * (user OK the same day: "lets create a new Vendor or anything to get started with execution for GCCM-795").
 *
 *   createCompany   Actions › New 1099 Record › Vendor (Company)  (Tags: Vendor)            — TC-002 / TC-004
 *                   Actions › New Company › Company               (Tags: Client, Company)   — TC-003 (not a vendor)
 *                   with or without a primary address. Name "ONEINC AUTO <tag> <MMDDHHmm>", Tax ID 99-xxxxxxx (random).
 *   addToClaim      adds that contact to the open claim from the Address Book (role Other) — the ClaimCenter side of the sync
 *   onOneInc        OneInc staging › Business/Vendor Report by the new Tax ID: waits up to `waitMin` for it (positive) or
 *                   watches `waitMin` that it never appears (negative); writes "OneInc Vendor …" observations.
 *
 * New contacts cannot be reverted like the vendor edits in contactManager.js: each one is listed in
 * <TestData>/cm-created-<tier>.json (name, Tax ID, case, time) so they can be found and retired later.
 * CM credentials: CM_USER / CM_PASS inline only (never stored).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const W = require('./wizardDriver');
const { withCM } = require('./contactManager');

const TIER = String(process.env.CC_TIER || 'test').toLowerCase();
const LEDGER = path.join(require('./reportService').RESULTS_DIR, 'TestData', `cm-created-${TIER}.json`);
const ADDRESS = { line1: '1103 Richmont St', city: 'Scranton', county: 'Lackawanna', state: 'Pennsylvania', zip: '18509' };
const sel = (suffix, tag = 'input') => `${tag}[name$="${suffix}"]`;
const pad = (n) => String(n).padStart(2, '0');

async function typeKeys(cm, s, value) {
  const el = cm.locator(s).first();
  await el.click(); await el.fill(''); await el.pressSequentially(value, { delay: 40 }); await el.press('Tab');
  await cm.waitForTimeout(1000);
}
async function pickOption(cm, s, re) {
  const el = cm.locator(s).first();
  if (!await el.isVisible().catch(() => false)) return '';
  const o = (await el.locator('option').allInnerTexts()).find((t) => re.test(t.trim()));
  if (o) { await el.selectOption({ label: o }); await cm.waitForTimeout(1500); }
  return o || '';
}
async function openMenu(cm, items) {
  await cm.getByText('Actions', { exact: true }).first().click();
  await cm.waitForTimeout(1200);
  for (const t of items.slice(0, -1)) { await cm.getByText(t, { exact: true }).first().hover(); await cm.waitForTimeout(1200); }
  await cm.getByText(items.at(-1), { exact: true }).first().click();
  await cm.locator(sel('ContactBasicsDV-OrganizationName')).first().waitFor({ timeout: 20000 });
}

// Test step: creates the company in ContactManager and remembers it (page.__cmNew) for addToClaim / onOneInc.
async function createCompany(page, { vendor = true, address = true, tag = 'VENDOR' } = {}) {
  if (!['test', 'dev'].includes(TIER)) throw new W.Blocked('creating ContactManager contacts is TEST/DEV only');
  const d = new Date();
  const name = `ONEINC AUTO ${tag} ${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
  const taxId = `99-${String(Math.floor(1e6 + Math.random() * 9e6))}`;
  const saved = await withCM(page, async (cm) => {
    await openMenu(cm, vendor ? ['New 1099 Record', 'Vendor (Company)'] : ['New Company', 'Company']);
    const tags = (await cm.locator('body').innerText()).match(/Tags\s+([\s\S]{0,60}?)\s+Name/);
    await cm.locator(sel('ContactBasicsDV-OrganizationName')).first().fill(name);
    // Not masked: CM wants the EIN typed with its hyphen ("a nine-digit employer identification number with a hyphen after
    // the second digit", 2026-11-13).
    await typeKeys(cm, sel('ABCompanyVendorFormInputSet-V_EIN'), taxId);
    await pickOption(cm, sel('ABCompanyVendorFormInputSet-ExtLevy', 'select'), /^Not Applicable$/i);
    if (address) {
      await cm.locator(sel('GlobalAddressInputSet-AddressLine1')).first().fill(ADDRESS.line1);
      await cm.locator(sel('GlobalAddressInputSet-City')).first().fill(ADDRESS.city);
      await cm.locator(sel('GlobalAddressInputSet-County')).first().fill(ADDRESS.county).catch(() => {});
      await pickOption(cm, sel('GlobalAddressInputSet-State', 'select'), new RegExp(`^${ADDRESS.state}$`, 'i'));
      await typeKeys(cm, sel('GlobalAddressInputSet-PostalCode'), ADDRESS.zip);
      await pickOption(cm, sel('AddressOwnerInputSet-Address_AddressType', 'select'), /^Business$/i);
    }
    await cm.getByRole('button', { name: 'Update', exact: true }).first().click();
    const ok = await cm.getByRole('button', { name: 'Edit', exact: true }).first().waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
    const msgs = (await cm.locator('.gw-message, [class*=error], [role=alert]').allInnerTexts().catch(() => [])).join(' / ').replace(/\s+/g, ' ').trim();
    if (!ok) {
      await cm.screenshot({ path: path.join(require('./reportService').RESULTS_DIR, 'Screenshots', `cm-create-${Date.now()}.png`) }).catch(() => {});
      throw new W.Blocked(`ContactManager did not save the new ${vendor ? 'vendor' : 'company'}: ${msgs.slice(0, 300) || 'no message'}`);
    }
    return { tags: tags ? tags[1].replace(/\s+/g, ' ') : '?', msgs };
  });
  page.__cmNew = { name, taxId, vendor, address };
  let l = [];
  try { l = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (_) { /* first one */ }
  l.push({ name, taxId, vendor, address, case: page.__oneIncCase || '', createdAt: d.toISOString() });
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
  return require('./checkOps').observe(page, 'ContactManager contact created',
    `${name} — Tax ID ${taxId}; ${vendor ? 'Vendor (Company)' : 'Company (not a vendor)'}; tags ${saved.tags}; ${address ? `primary address ${ADDRESS.line1}, ${ADDRESS.city} PA ${ADDRESS.zip}` : 'no primary address'}`);
}

// Test step: the new contact added to the open claim from Address Book / 1099 Contacts (Type Vendor (Company) or Company).
async function addToClaim(page, role = 'Other') {
  const c = page.__cmNew;
  if (!c) throw new Error('addToClaim: no contact was created by this case');
  const claim = await page.evaluate(() => ((document.body.innerText || '').match(/Claim:\s*([A-Z]{2,4}-[A-Z]{2}-[\d-]+)/) || [])[1] || '');
  let out;
  try {
    const added = await W.addClaimContactWithRole(page, { name: c.name, taxId: c.taxId, type: c.vendor ? 'Vendor (Company)' : 'Company' }, role);
    out = `${c.name} ${added === false ? 'already on' : 'added to'} claim ${claim} (role ${role})`;
  } catch (e) {
    // A negative case still runs on: the point is what reaches OneInc.
    out = `${c.name} NOT added to claim ${claim}: ${e.message.split('\n')[0].slice(0, 250)}`;
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    if (c.vendor && c.address) throw new W.Blocked(out);
  }
  if (claim) await W.openClaim(page, claim).catch(() => {});
  return require('./checkOps').observe(page, 'ClaimCenter contact', out);
}

// Test step: the new contact on OneInc's Business/Vendor Report. expect 'present' waits up to waitMin for it; 'absent'
// watches the whole waitMin. Observations: "OneInc Vendor" (found / not on the report), plus Name / Street / City when found.
async function onOneInc(page, { expect = 'present', waitMin = 20 } = {}) {
  const c = page.__cmNew;
  if (!c) throw new Error('onOneInc: no contact was created by this case');
  const P = require('./portal');
  const tin = c.taxId.replace(/-/g, '');
  const end = Date.now() + waitMin * 60e3;
  let v = null;
  for (;;) {
    let rows;
    try { rows = await P.vendors({ tin }); } catch (e) { throw new W.Blocked(e.message); }
    v = rows[0] || null;
    if (v && expect === 'present') break;
    if (v && expect === 'absent') break;
    if (Date.now() > end) break;
    await page.waitForTimeout(60000);
  }
  const R = require('./checkOps');
  const mins = Math.round((Date.now() - (end - waitMin * 60e3)) / 60e3);
  if (!v) return R.observe(page, 'OneInc Vendor', `not on the report (Tax ID ${tin}, watched ${mins} min)`);
  await R.observe(page, 'OneInc Vendor Name', v.BusinessName || '(blank)');
  await R.observe(page, 'OneInc Vendor BillingStreet', v.BillingStreet || '(blank)');
  await R.observe(page, 'OneInc Vendor City', v.City || '(blank)');
  return R.observe(page, 'OneInc Vendor', `on the report after ${mins} min: ${v.BusinessName} (${v.BusinessID}), modified ${v.DateModified || '?'}`);
}

module.exports = { createCompany, addToClaim, onOneInc, LEDGER };
