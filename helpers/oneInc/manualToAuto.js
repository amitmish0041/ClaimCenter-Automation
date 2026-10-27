/**
 * helpers/oneInc/manualToAuto.js
 * Setup / observation steps for the recipes in helpers/oneInc/recipes/manualToAuto.js (cases moved from manual to
 * automated, 2026-10-27): VBR.029 vehicle VIN, VBR.036 mailing address after an Address Book change, VBR.025 expense
 * reserve rows for Quick Payment, and the ContactManager ClaimsPay-section review (GCCM-783 UIF.003). Called from
 * recipes with { call: ['manualToAuto.<fn>', ...args] } → fn(page, ...args). WRITES to the run's own new claims on the
 * TEST tier only.
 */
'use strict';
const W = require('./wizardDriver');
const A = require('./setupA');
const C = require('./checkOps');
const X = require('./reuseExt');
const { readScreen, findField } = require('./screenReader');

const TIER = (process.env.CC_TIER || 'test').toLowerCase();
function testOnly(what) {
  if (TIER !== 'test') throw new W.Blocked(`${what} writes claim data — allowed on the TEST tier only`);
}
const claimNo = (page) => page.evaluate(() => ((document.body.innerText || '').match(/Claim:\s*([A-Z]{2,4}-[A-Z]{2}-[\d-]+)/) || [])[1] || '');

// ── VBR.029 — claim cost payment on an exposure whose vehicle incident has no VIN ─────────────────────────────────
// CONFIRMED 2026-10-27: a policy vehicle's VIN and Year are locked on the vehicle incident edit screen (new FNOL claims
// carry only policy vehicles, e.g. PA-PA-01-26-0748582); a vehicle added by hand ("Automated E2E" on older claims) keeps
// them editable. So the incident either gets its VIN blanked, or — when every vehicle is a policy vehicle — its vehicle
// replaced by a new one ("Select vehicle" › New…: OLDS CUTLASS, Passenger car, no VIN; the newly required "Is there a
// loan on the Vehicle?" answered No). Both save, and Ability to pay still passes. Next on Step 2 does not fire VBR.029 —
// the rule is checked at Finish.
async function openVehicle(page, i) {
  await W.navigate(page, 'lossDetails');
  const make = page.locator(`[id$="EditableVehicleIncidentsLV-${i}-Make_button"]`).first();
  if (!await make.isVisible().catch(() => false)) return false;
  await make.click();
  await W.settle(page, 3000);
  return true;
}
async function cancelEdit(page) {
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
  await W.settle(page, 1500);
}

// Claim Loss Cause / Detailed Loss Cause (Loss Details › Edit) — e.g. 'Theft of Auto' / 'Total' for VBR.029's theft branch.
async function setLossCause(page, lossCause, detailed) {
  testOnly('setLossCause');
  await A.openLossDetailsGeneral(page);
  const cur = findField(await readScreen(page), 'Loss Cause');
  const curD = findField(await readScreen(page), 'Detailed Loss Cause');
  if (cur && cur.value === lossCause && (!detailed || (curD && curD.value === detailed))) return `Loss Cause already ${lossCause}${detailed ? ' / ' + detailed : ''}`;
  await A.editAndSave(page, 'Loss Details Loss Cause', async () => {
    await A.selectByLabel(page, 'Loss Cause', lossCause);
    if (detailed) await A.selectByLabel(page, 'Detailed Loss Cause', detailed);
  });
  // A Loss Details save drops the claim below the Ability-to-pay level (New Payment Error, CONFIRMED 2026-10-27) — revalidate.
  return `claim Loss Cause → ${lossCause}${detailed ? ' / Detailed Loss Cause → ' + detailed : ''}; ${await A.revalidate(page)}`;
}

// Gives one vehicle incident a vehicle with NO VIN and the given Year, picks an exposure on that vehicle with an open
// Claim Cost reserve and remembers it for selectVinLine / openQuickOnVinLine. opts: { year, lossCause, detailed }.
// Writes the observation "Vehicle incident under test".
async function prepareVinIncident(page, { year = '1987', lossCause, detailed } = {}) {
  testOnly('prepareVinIncident');
  const claim = await claimNo(page);
  const done = [];
  if (lossCause) done.push(await setLossCause(page, lossCause, detailed));
  // 1. A vehicle incident whose VIN is editable, else the first one (its vehicle gets replaced).
  await W.navigate(page, 'lossDetails');
  const n = await page.locator('[id*="EditableVehicleIncidentsLV-"][id$="-Make_button"]').count();
  if (!n) throw new W.Blocked('the claim has no vehicle incident');
  let target = null;
  for (let i = 0; i < n && !target; i++) {
    if (!await openVehicle(page, i)) continue;
    await W.clickButton(page, 'Edit');
    await W.settle(page, 2000);
    const vin = page.getByLabel('VIN', { exact: true }).first();
    // Both VIN and Year must be editable: some policy vehicles lock only the Year (CONFIRMED 2026-10-27, 1989 DODGE
    // D-SERIES on PA-PA-01-26-0748601 kept its year, so the case's Year could not be set) — those get a new vehicle.
    const yr = page.getByLabel('Year', { exact: true }).first();
    if (await vin.isVisible().catch(() => false) && !await vin.isDisabled().catch(() => true) && !await yr.isDisabled().catch(() => true)) {
      target = { i, mode: 'blank', vin: (await vin.inputValue().catch(() => '')).trim(), name: ((findField(await readScreen(page), 'Select vehicle') || {}).value || '').trim() };
    }
    await cancelEdit(page);
  }
  if (!target) target = { i: 0, mode: 'new' };
  // 2. Edit the incident: blank VIN + Year, or a new vehicle without a VIN.
  await W.openClaim(page, claim);
  await openVehicle(page, target.i);
  await W.clickButton(page, 'Edit');
  await W.settle(page, 2000);
  if (target.mode === 'new') {
    target.name = ((findField(await readScreen(page), 'Select vehicle') || {}).value || '').trim();
    await A.selectByLabel(page, 'Select vehicle', /^New|Newly Created/);
    await W.settle(page, 2500);
    await A.fillByLabel(page, 'Make', 'OLDS');
    await A.fillByLabel(page, 'Model', 'CUTLASS');
    await A.selectByLabel(page, 'Style', 'Passenger car').catch(() => {});
  }
  const vin = page.getByLabel('VIN', { exact: true }).first();
  await vin.fill('');
  await vin.press('Tab').catch(() => {});
  await A.fillByLabel(page, 'Year', String(year));
  await W.settle(page, 1200);
  for (let r = 0; r < 2; r++) {
    await W.clickButton(page, 'Update');
    await W.settle(page, 3000);
    if (!await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) break;
    if (r === 0 && (await A.fillRequired(page)).length) continue; // e.g. "Is there a loan on the Vehicle?" on a new vehicle
    const s = await readScreen(page);
    await cancelEdit(page);
    throw new W.Blocked(`vehicle incident without a VIN could not be saved: ${[...s.messages, s.south].join(' / ').slice(0, 300) || 'no message'}`);
  }
  // 3. The exposure(s) on that vehicle: their "Vehicle" now reads "<year> <make> <model> (…)" with no "VIN#:".
  await W.openClaim(page, claim);
  const expoCount = await A.exposureCount(page);
  const onVehicle = [];
  for (let i = 0; i < expoCount; i++) {
    await A.openExposure(page, i);
    const v = ((findField(await readScreen(page), 'Vehicle') || {}).value || '').trim();
    if (v.startsWith(`${year} `) && !/VIN#/.test(v)) {
      await W.navigate(page, 'exposures');
      onVehicle.push((await page.locator(`[id*="ExposuresLV-${i}-Order_button"]`).first().innerText().catch(() => String(i + 1))).trim());
    }
  }
  if (!onVehicle.length) throw new W.Blocked(`no exposure uses the vehicle without a VIN (incident was "${target.name}")`);
  const rows = await X.reserveRows(page).catch(() => []);
  const open = onVehicle.find((num) => rows.some((r) => r.expo.startsWith(`(${num})`) && /claim cost/i.test(r.cost) && r.remaining > 0));
  if (!open) throw new W.Blocked(`exposure(s) ${onVehicle.join(', ')} on the vehicle without a VIN have no open Claim Cost reserve`);
  await W.openClaim(page, claim);
  done.push(await A.revalidate(page));
  await W.openClaim(page, claim);
  page.__vinExposure = open;
  done.unshift(target.mode === 'new'
    ? `vehicle incident "${target.name}" given a new vehicle ${year} OLDS CUTLASS with no VIN; payment on exposure (${open})`
    : `vehicle "${target.name}" (was VIN ${target.vin}): VIN blank, Year ${year}; payment on exposure (${open})`);
  return C.observe(page, 'Vehicle incident under test', done.join('; '));
}
async function selectVinLine(page) {
  if (!page.__vinExposure) throw new W.Blocked('prepareVinIncident did not run');
  return W.selectReserveLine(page, `match:^\\(${page.__vinExposure}\\)`);
}
async function openQuickOnVinLine(page) {
  if (!page.__vinExposure) throw new W.Blocked('prepareVinIncident did not run');
  return X.openQuickOnRow(page, 'claim cost', 'open', `^\\(${page.__vinExposure}\\)`);
}

// ── Expense reserve row for Quick Payment expense cases ──────────────────────────────────────────────────────────
// A new claim has only Claim Cost rows, and a vehicle exposure's New Reserve screen offers only Claim Cost (CONFIRMED
// 2026-10-21) — so the row is made the way worker D did: a $1.4x First and Final payment to an Address Book vendor on a
// new "Expense OR First and Final" line with Cost Type Adjuster Expense. Then the Quick Payment opens from that row.
// (Not reuseExt.openQuickOnRow straight from the recipe: testData.deriveNeeds would demand the row before the case
// starts, i.e. before this step can build it.)
async function openQuickOnExpenseRow(page) {
  testOnly('openQuickOnExpenseRow');
  const rows = await X.reserveRows(page).catch(() => []);
  let made = '';
  if (!rows.some((r) => /expense/i.test(r.cost))) {
    if (process.env.ONEINC_ALLOW_FINISH !== '1') throw new W.Blocked('building the expense reserve row submits a payment — enable ONEINC_ALLOW_FINISH=1 (TEST only)');
    const amt = `1.${41 + Math.floor(Math.random() * 58)}`;
    await W.openPayment(page, 'actions');
    try {
      await W.selectPayee(page, 'vendor');
      await W.nextFillingServicePeriod(page);
      await W.selectReserveLine(page, 'new');
      await W.select(page, 'Cost Type', 'Adjuster Expense');
      await W.completePaymentsStep(page, { transactionType: 'First and Final', amount: amt });
      await W.nextFillingServicePeriod(page);
      await W.answerUnansweredNo(page);
      for (let r = 0; r < 2; r++) if (!(await W.fillRequiredEmpties(page)).length) break;
      const inv = findField(await readScreen(page), 'Invoice Number/Remarks');
      if (inv && !inv.value) await W.fill(page, 'Invoice Number/Remarks', `ONEINC-${Date.now()}`).catch(() => {});
      await W.clickButton(page, 'Finish');
      let msgs = '';
      for (let t = 0; t < 40 && await W.inWizard(page); t++) {
        const s = await readScreen(page);
        if (s.messages.length || s.south) {
          msgs = [...s.messages, s.south].join(' / ');
          if (!W.warningsOnly(s)) break;
          await W.clickButton(page, 'Finish').catch(() => {});
          await W.settle(page, 2000);
        }
        await page.waitForTimeout(1000);
      }
      if (await W.inWizard(page)) throw new W.Blocked(`the $${amt} expense payment that builds the expense reserve row was refused: ${msgs.slice(0, 300) || 'no message'}`);
    } finally {
      await W.cancelWizard(page).catch(() => {});
    }
    made = `built an Adjuster Expense reserve row with a $${amt} First and Final vendor payment; `;
  }
  await X.openQuickOnRow(page, 'expense', 'any');
  return `${made}opened Quick Payment on the expense row`;
}

// ── VBR.036 — check mailing address vs the payee's Address Book address ───────────────────────────────────────────
async function partiesRow(page, name) {
  await W.navigate(page, 'parties');
  await page.locator('tr[id*="LV-0-"]:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  return page.evaluate((name) => ([...document.querySelectorAll('tr[id*="PeopleInvolvedDetailedLV-"]')].filter((r) => r.offsetParent && !r.querySelector('tr'))
    .map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()).find((t) => t.toUpperCase().startsWith(name.toUpperCase())) || ''), name);
}
// Polls the claim's Parties Involved row of `name` until its address matches `re` — i.e. the ContactManager change has
// reached ClaimCenter (about 40 s on TEST, CONFIRMED 2026-10-27 on BAIKOW LEGAL LLC). Writes "Contact address in ClaimCenter".
async function waitContactAddress(page, name, re, timeoutMs = 300000) {
  const want = re instanceof RegExp ? re : new RegExp(re, 'i');
  const claim = await claimNo(page);
  const t0 = Date.now();
  let row = '';
  for (;;) {
    if (claim) await W.openClaim(page, claim);
    row = await partiesRow(page, name);
    if (want.test(row)) break;
    if (Date.now() - t0 > timeoutMs) throw new W.Blocked(`the Address Book change of ${name} did not reach ClaimCenter within ${Math.round(timeoutMs / 60000)} min (Parties Involved still shows: ${row || 'no such contact'})`);
    await page.waitForTimeout(15000);
  }
  return C.observe(page, 'Contact address in ClaimCenter', `${row} (after ${Math.round((Date.now() - t0) / 1000)} s)`);
}
// Opens the newest check matching spec (checkOps.openCheck) and writes its address fields and status as observations
// "Check mailing address" / "Check status".
async function checkMailingAddress(page, spec) {
  const opened = await C.openCheck(page, spec);
  const s = await readScreen(page);
  const own = (f) => !/^checkops-/.test(String(f.id || ''));
  const addr = s.fields.filter((f) => own(f) && /mail|address/i.test(f.label) && String(f.value || '').trim()).map((f) => `${f.label}: ${String(f.value).replace(/\s+/g, ' ').trim()}`);
  const status = (findField(s, 'Status') || {}).value || (page.__check || {}).status || '';
  await C.observe(page, 'Check status', status);
  return C.observe(page, 'Check mailing address', `${addr.join(' | ') || 'no address field on Check/Payment Details'} (${opened})`);
}

// ── Step 3: a mailed check (where "Reason for Check" lives) ───────────────────────────────────────────────────────
// "Reason for Check" (and its "Reason Description") appear for a mailed check. CC defaults ClaimsPay Type "Other / Mailed
// Check" (read-only) when the payee has no e-mail/phone (CPD.001); a payee WITH contact details gets Type "Contact(s)"
// (read-only) and Method Customer Choice | Mailed Check — choosing Mailed Check shows the same Reason for Check
// (CONFIRMED 2026-10-27 on PA-PA-01-26-0748582). Either way the case does not depend on which policy the claim landed on.
async function chooseMailedCheck(page) {
  const s = await readScreen(page);
  const type = findField(s, 'ClaimsPay Type');
  const method = findField(s, 'ClaimsPay Method');
  if (!type) throw new W.Blocked('Step 3 has no ClaimsPay Type');
  if (/other\s*\/\s*mailed check/i.test(type.value || '')) return `ClaimsPay Type already "${type.value}"`;
  if (method && method.kind === 'select' && (method.options || []).some((o) => /^mailed check$/i.test(o))) {
    if (!/^mailed check$/i.test(method.value || '')) { await W.select(page, 'ClaimsPay Method', /^Mailed Check$/i); await W.settle(page, 2500); }
    return `ClaimsPay Type "${type.value}", Method → Mailed Check`;
  }
  if (type.kind === 'select') { await W.select(page, 'ClaimsPay Type', /Other\s*\/\s*Mailed Check/i); await W.settle(page, 2500); return `ClaimsPay Type "${type.value}" → Other / Mailed Check`; }
  throw new W.Blocked(`no mailed-check choice: ClaimsPay Type "${type.value}", Method options ${(method && method.options || []).join(', ')}`);
}

// ── GCCM-783 UIF.003 — ClaimsPay section hidden in ContactManager ────────────────────────────────────────────────
// Opens a Person, a Company and a Financial Institution contact in ContactManager (TEST, CM_USER / CM_PASS) and records,
// per contact type, whether "ClaimsPay" appears anywhere on the contact screen (every card/tab of it, and the Actions
// menu), and whether the search screen's Reset clears the criteria. Read-only in ContactManager.
const CM_SAMPLES = [
  { type: 'Person', fill: { LastName: 'Thomas', PostalCode: '19073' } },
  { type: 'Company', fill: { 'Tax ID': '02-0725566' } },
  { type: 'Financial Institution', fill: { '-Name': 'ACNB BANK' } },
];
async function cmClaimsPayReview(page) {
  const CM = require('./contactManager');
  const results = await CM.withCM(page, async (cm) => {
    const out = [];
    for (const smp of CM_SAMPLES) {
      await cm.getByText('Search', { exact: true }).first().click();
      const sub = cm.locator('select[name$="ContactSubtype"]').first();
      await sub.waitFor({ timeout: 20000 });
      await cm.waitForTimeout(1500);
      await sub.selectOption({ label: smp.type });
      await cm.waitForTimeout(2500);
      for (const [k, v] of Object.entries(smp.fill)) {
        const byName = cm.locator(`input[name$="${k}"]:visible`).first();
        if (await byName.isVisible().catch(() => false)) await byName.fill(v); else await cm.getByLabel(k, { exact: true }).first().fill(v);
      }
      // Reset (UIF.003 step "Click the Reset button → all information should be cleared"), then the real search.
      let reset = 'no Reset button';
      const rb = cm.getByRole('button', { name: 'Reset', exact: true }).first();
      if (await rb.isVisible().catch(() => false)) {
        await rb.click();
        await cm.waitForTimeout(2500);
        const left = await cm.evaluate(() => [...document.querySelectorAll('input[type=text], input:not([type])')].filter((i) => i.offsetParent && i.value && !/QuickJump/.test(i.name)).map((i) => i.name.replace(/^.*-/, '') + '=' + i.value));
        reset = left.length ? `NOT cleared (${left.join(', ')})` : 'cleared';
        if (await sub.inputValue().catch(() => '') !== '') await sub.selectOption({ label: smp.type }).catch(() => {});
        await cm.waitForTimeout(1500);
        for (const [k, v] of Object.entries(smp.fill)) {
          const byName = cm.locator(`input[name$="${k}"]:visible`).first();
          if (await byName.isVisible().catch(() => false)) await byName.fill(v); else await cm.getByLabel(k, { exact: true }).first().fill(v);
        }
      }
      await cm.getByRole('button', { name: 'Search', exact: true }).click();
      await cm.waitForTimeout(4500);
      const rows = await cm.evaluate(() => [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr')).map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length > 10));
      if (rows.length < 2) { out.push({ type: smp.type, result: `no ${smp.type} contact found (search ${JSON.stringify(smp.fill)})`, reset }); continue; }
      // First result's Name cell (the header row is rows[0]).
      const first = await cm.evaluate(() => { const r = [...document.querySelectorAll('tr')].filter((x) => x.offsetParent && !x.querySelector('tr') && x.querySelector('td') && (x.innerText || '').trim().length > 10)[1]; const td = r && [...r.querySelectorAll('td')].find((c) => /[A-Za-z]{3}/.test(c.innerText || '')); if (td) td.setAttribute('data-m2a-first', '1'); return td ? td.innerText.trim() : ''; });
      await cm.locator('[data-m2a-first="1"]').first().locator('a, .gw-label, div').filter({ hasText: first }).last().click().catch(() => cm.locator('[data-m2a-first="1"]').first().click());
      await cm.waitForTimeout(4500);
      const name = ((await cm.evaluate(() => (/Contact Details:\s*([^\n]+)/.exec(document.body.innerText) || [])[1] || '')) || '').trim();
      // Every card of the contact screen (Basics / Addresses / Related Contacts …) and the Actions menu.
      const tabs = await cm.evaluate(() => [...document.querySelectorAll('[role=tab]')].filter((e) => e.offsetParent).map((e) => (e.innerText || '').trim()).filter(Boolean));
      const seen = [];
      let text = await cm.evaluate(() => document.body.innerText);
      for (const t of tabs) {
        await cm.getByRole('tab', { name: t, exact: true }).first().click().catch(() => {});
        await cm.waitForTimeout(1500);
        text += '\n' + await cm.evaluate(() => document.body.innerText);
      }
      const actions = cm.getByText('Actions', { exact: true }).first();
      if (await actions.isVisible().catch(() => false)) {
        await actions.click().catch(() => {});
        await cm.waitForTimeout(1000);
        const items = await cm.evaluate(() => [...document.querySelectorAll('[role=menuitem]')].filter((e) => e.offsetParent).map((e) => (e.innerText || '').trim()));
        seen.push(`Actions menu: ${items.join(', ') || 'none'}`);
        text += '\n' + items.join('\n');
        await cm.keyboard.press('Escape').catch(() => {});
      }
      const hit = /claims\s*pay/i.exec(text);
      out.push({ type: smp.type, result: `${hit ? 'ClaimsPay SHOWN' : 'no ClaimsPay section, link or option'} — ${name || 'contact'} (cards: ${tabs.join(', ') || 'none'}; ${seen.join('; ')})`, reset });
    }
    return out;
  });
  for (const r of results) {
    await C.observe(page, `CM ${r.type} contact`, r.result);
    await C.observe(page, `CM ${r.type} search Reset`, r.reset);
  }
  return results.map((r) => `${r.type}: ${r.result}`).join(' | ');
}

module.exports = { chooseMailedCheck, setLossCause, prepareVinIncident, selectVinLine, openQuickOnVinLine, openQuickOnExpenseRow, waitContactAddress, checkMailingAddress, cmClaimsPayReview };
