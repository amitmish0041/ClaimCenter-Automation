/**
 * helpers/oneInc/recipes/workerF.js — "needs test data" follow-ups (Worker F, added 2026-10-21). Loaded after
 * reuseB.js / workerD.js (files load alphabetically), so an add() here replaces their recipe for the same id.
 *
 * Helpers used by these recipes and by the profiles in ../profiles/workerF.js are attached to the exported function
 * (module.exports.<fn>) and called with { call: ['recipes/workerF.<fn>', ...args] } (scenarioRunner / claimCheck
 * resolve '<module>.<fn>' as require('./<module>')[fn]). They WRITE to claims on the TEST tier only.
 *
 * VBR.004 (DE, exposure Cause of Loss LC50 "Medical Benefits") — CONFIRMED 2026-10-21 on cloud TEST:
 *   - the DE personal-auto policies of the PA-DE claims (e.g. 1002121635, claim PA-DE-01-24-0744728) offer only
 *     PIP › Funeral Benefits / Medical Payments / Wage Loss Benefits, whose Cause of Loss list is ONLY "Personal Injury
 *     Protection"; the DE commercial-auto "Medical Benefits" coverage (CA-DE-01-24-0744755) offers "Combination First
 *     Party Benefits" / "Personal Injury Protection" — never "Medical Benefits";
 *   - the DE personal-auto policies of the PMF-DE / PAF-DE / PAE-DE / PNF-DE claims carry a vehicle-level "Medical
 *     Benefits" coverage whose New Exposure screen offers Cause of Loss "Medical Benefits" (with Combination First Party
 *     Benefits / Enhanced Coverages / PIP). PMF-DE-01-25-0746339 (policy PMF-3053397, DoL 09/15/2024) got such an
 *     exposure (addMedExposure) + reserve → profile F_DE_LC50.
 *   - PA personal auto: vehicle "Medical Expense" coverage → Cause of Loss "Medical Benefits" (profile F_PA_LC50).
 */
'use strict';
const W = require('../wizardDriver');
const { readScreen, findField } = require('../screenReader');

const TIER = (process.env.CC_TIER || 'test').toLowerCase();
const testOnly = (what) => { if (TIER !== 'test') throw new W.Blocked(`${what} writes claim data — allowed on the TEST tier only`); };
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// <select> inside the gw-InputWidget whose label is exactly `label` (the New Exposure screen has two "Claimant"
// widgets — a section heading and the picker — so findField's first match is not enough). nth: which match.
async function selectIn(page, label, want, nth = 0) {
  const ids = await page.evaluate((label) => [...document.querySelectorAll('.gw-InputWidget')]
    .filter((w) => w.offsetParent && w.querySelector('select') && ((w.querySelector('.gw-label') || {}).innerText || '').replace(/\s+/g, ' ').trim() === label)
    .map((w) => w.id), label);
  const id = ids[nth];
  if (!id) throw new W.Blocked(`"${label}" dropdown is not on the screen`);
  const sel = page.locator(`[id="${id}"] select`).first();
  const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })));
  const real = opts.filter((o) => o.t && !/^<none>$/i.test(o.t));
  const pick = want instanceof RegExp ? real.find((o) => want.test(o.t)) : (real.find((o) => norm(o.t) === norm(want)) || real.find((o) => norm(o.t).includes(norm(want))));
  if (!pick) throw new W.Blocked(`"${label}" has no option ${want} (options: ${real.map((o) => o.t).join(', ')})`);
  await sel.selectOption(pick.v);
  await W.settle(page, 1800);
  return pick.t;
}
async function fillIn(page, label, value) {
  const f = findField(await readScreen(page), label);
  if (!f || !f.id) return false;
  const inp = page.locator(`[id="${f.id}"] textarea, [id="${f.id}"] input:not([type=hidden])`).first();
  if (!await inp.isVisible().catch(() => false)) return false;
  if ((await inp.inputValue().catch(() => '')).trim()) return false;
  await inp.fill(String(value));
  await inp.press('Tab').catch(() => {});
  await W.settle(page, 1000);
  return true;
}
const insuredName = (page) => page.evaluate(() => ((/Ins:\s*(.+?)\s+(Clmt|DoL|St|Adj):/.exec((document.body.innerText || '').replace(/\s+/g, ' ')) || [])[1] || '').trim());
const claimNo = (page) => page.evaluate(() => ((document.body.innerText || '').match(/Claim:\s*([A-Z]{2,3}-[A-Z]{2}-[\d-]+)/) || [])[1] || '');

async function exposureRows(page) {
  await W.navigate(page, 'exposures');
  await page.locator('tr[id*="ExposuresLV-0-"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  return page.evaluate(() => [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr'))
    .map((r) => ({ i: Number((/ExposuresLV-(\d+)-/.exec(r.innerHTML) || [])[1]), t: (r.innerText || '').replace(/\s+/g, ' ').trim() }))
    .filter((r) => Number.isFinite(r.i)));
}

// Injury Incident popup (New Incident...): injured person = claimant, description, injury type, one body-part row.
async function fillInjuryPopup(page, claimant) {
  const sels = async () => readScreen(page);
  const s = await sels();
  const inj = s.fields.find((f) => /^Injured Person$/i.test(f.label) && f.kind === 'select');
  if (inj && (!inj.value || /^<none>$/i.test(inj.value))) await selectIn(page, inj.label, claimant ? new RegExp(claimant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : /./).catch(() => selectIn(page, inj.label, /./));
  await fillIn(page, 'Describe Injuries', 'OneInc automation — medical benefits injury');
  await fillIn(page, 'Injury Description', 'OneInc automation — medical benefits injury');
  await selectIn(page, 'General Injury Type', /Specific injury/i).catch(() => {});
  await selectIn(page, 'Detailed Injury Type', /Sprain/i).catch(() => {});
  const area = page.locator('[id*="BodyPart"] select:visible').first();
  if (!await area.isVisible().catch(() => false)) {
    await page.locator('[id*="BodyPart"][id$="_tb-Add"], [id*="BodyParts"][id$="-Add"]').first().click()
      .catch(() => page.getByRole('button', { name: 'Add', exact: true }).first().click());
    await W.settle(page, 2000);
  }
  for (let round = 0; round < 3; round++) {
    const list = page.locator('[id*="BodyPart"] select:visible');
    const n = await list.count();
    let changed = false;
    for (let i = 0; i < n; i++) {
      const sel = list.nth(i);
      if (await sel.inputValue().catch(() => 'x')) continue;
      const v = await sel.locator('option').evaluateAll((os) => (os.find((o) => o.value && !/^<none>$/i.test(o.textContent.trim())) || {}).value);
      if (v) { await sel.selectOption(v); await W.settle(page, 1500); changed = true; }
    }
    if (!changed) break;
  }
  for (let r = 0; r < 3; r++) {
    await W.fillRequiredEmpties(page);
    await W.answerUnansweredNo(page);
    await W.clickButton(page, 'OK');
    await W.settle(page, 2500);
    if (!await page.getByText(/^Return to New Exposure/).first().isVisible().catch(() => false)
      && !await page.getByRole('button', { name: 'OK', exact: true }).first().isVisible().catch(() => false)) return;
  }
  const why = (await readScreen(page)).messages.join(' / ');
  throw new W.Blocked(`injury incident could not be saved: ${why.slice(0, 300) || 'no message'}`);
}

// Adds a medical exposure through Actions › New Exposure › Choose by Coverage › <vehicle> › <coverage> [› <leaf>]
// with the given Cause of Loss (e.g. "Medical Benefits" = LC50), claimant = the insured, a new injury incident, then
// Update. Idempotent: does nothing when an exposure row already matches `existing`.
async function addMedExposure(page, { coverage = 'Medical Benefits', leaf = null, cause = 'Medical Benefits', existing = /Medical/i } = {}) {
  testOnly('addMedExposure');
  const rows = await exposureRows(page);
  const have = rows.find((r) => existing.test(r.t));
  if (have) return `medical exposure already on the claim (${have.t.slice(0, 80)})`;
  await W.openActionsMenu(page);
  await page.getByRole('menuitem', { name: /New Exposure/ }).first().hover(); await page.waitForTimeout(1500);
  await page.getByRole('menuitem', { name: /Choose by Coverage/ }).first().hover(); await page.waitForTimeout(2500);
  const vehs = page.getByRole('menuitem', { name: /VIN#/ });
  let opened = false;
  for (let i = 0, n = await vehs.count(); i < n && !opened; i++) {
    await vehs.nth(i).hover(); await page.waitForTimeout(1500);
    const cov = page.getByRole('menuitem', { name: coverage, exact: true }).first();
    if (!await cov.isVisible().catch(() => false)) continue;
    if (leaf) { await cov.hover(); await page.waitForTimeout(1500); await page.getByRole('menuitem', { name: leaf, exact: true }).first().click(); }
    else await cov.click();
    opened = true;
  }
  if (!opened) { await W.closeMenus(page); throw new W.Blocked(`no vehicle on this policy carries a "${coverage}" coverage`); }
  await W.settle(page, 4000);
  const ins = await insuredName(page);
  await selectIn(page, 'Cause of Loss', cause);
  // The claimant picker is the SECOND "Claimant" widget with a select (the first match is the picker itself when the
  // heading has none) — selectIn only considers widgets that contain a select.
  await selectIn(page, 'Claimant', ins ? new RegExp(`^${ins.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') : /./).catch(() => selectIn(page, 'Claimant', /./));
  await selectIn(page, 'Type', /^Insured$/).catch(() => {});
  await selectIn(page, 'Is Claimant Employed?', /^No$/).catch(() => {});
  await fillIn(page, 'Description', 'OneInc automation — LC50 Medical Benefits exposure');
  await fillIn(page, 'Policy Limit', '10000');
  // Injury incident (required)
  // Same picker walk as fnolHelper.fillCloudNewExposure: the options BUTTON inside *_IncidentMenuIcon, then the
  // visible "New Incident..." item.
  // CONFIRMED 2026-10-21 (DE Medical Benefits screen): the picker is …-Injury_Incident-Injury_IncidentMenuIcon and its
  // items are …-Injury_Incident-VehicleDamageDV_NewIncidentMenuItem / _EditIncidentMenuItem (hidden until toggled).
  // Screen layouts differ per exposure type (PIP Wage Loss uses another DV), so address the picker through the
  // "Injury Incident" widget itself.
  const injW = (findField(await readScreen(page), 'Injury Incident') || {}).id;
  const scope = injW ? page.locator(`[id="${injW}"]`) : page;
  await scope.locator('[id$="MenuIcon"] [role=button]').first().click({ force: true });
  await page.waitForTimeout(1500);
  await scope.locator('[id$="NewIncidentMenuItem"] [role=menuitem]').first().click({ force: true });
  await W.settle(page, 3500);
  if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)
    && !await page.getByRole('button', { name: 'OK', exact: true }).first().isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new W.Blocked('the Injury Incident "New Incident..." popup did not open');
  }
  await fillInjuryPopup(page, ins);
  for (let r = 0; r < 4; r++) {
    await W.fillRequiredEmpties(page);
    await W.answerUnansweredNo(page);
    await W.clickButton(page, 'Update');
    await W.settle(page, 2500);
    if (!await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
      return `added a "${coverage}${leaf ? ' › ' + leaf : ''}" exposure, Cause of Loss ${cause}, claimant ${ins || '(first)'}`;
    }
  }
  const s = await readScreen(page);
  const why = [...s.messages, s.south].join(' / ');
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
  throw new W.Blocked(`new exposure could not be saved: ${why.slice(0, 400) || 'no message'}`);
}


// Ability to pay: "Vehicle incident description must not be empty" — fill every empty textarea on each vehicle
// incident's edit screen (Loss Details › vehicle › Edit › Update). CONFIRMED needed 2026-10-21 on PA-DE-01-25-0746526.
async function fixVehicleIncidentDescriptions(page) {
  const fixed = [];
  await W.navigate(page, 'lossDetails');
  const count = await page.locator('[id*="EditableVehicleIncidentsLV-"][id$="-Make_button"]').count();
  for (let i = 0; i < count; i++) {
    await W.navigate(page, 'lossDetails');
    const make = page.locator(`[id$="EditableVehicleIncidentsLV-${i}-Make_button"]`).first();
    if (!await make.isVisible().catch(() => false)) continue;
    const name = (await make.innerText().catch(() => '')).trim();
    await make.click();
    await W.settle(page, 3000);
    await W.clickButton(page, 'Edit');
    const n = await page.evaluate(() => {
      let k = 0;
      for (const t of document.querySelectorAll('textarea')) {
        if (!t.offsetParent || t.readOnly || t.disabled || t.value.trim()) continue;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(t, 'OneInc automation — vehicle damage');
        t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true }));
        k++;
      }
      return k;
    });
    if (!n) { await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {}); await W.settle(page, 1500); continue; }
    for (let r = 0; r < 3; r++) {
      await W.fillRequiredEmpties(page).catch(() => {});
      await W.answerUnansweredNo(page).catch(() => {});
      await W.clickButton(page, 'Update');
      await W.settle(page, 3000);
      if (!await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) break;
    }
    if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
      const why = (await readScreen(page)).messages.join('; ');
      await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
      throw new W.Blocked(`vehicle "${name}": description not saved — ${why.slice(0, 200)}`);
    }
    fixed.push(name);
  }
  return fixed;
}

// Profile prepare hook: medical exposure with Cause of Loss Medical Benefits + a reserve on it + Ability to pay.
// opts by profile: DE → coverage 'Medical Benefits'; PA → coverage 'Medical Expense'.
function prepareMed(coverage, existing, { leaf = null, cause = 'Medical Benefits', reserveOn = 'Medical', amount = 1500 } = {}) {
  return async (page, claim) => {
    testOnly('prepareMed');
    const done = [];
    done.push(await addMedExposure(page, { coverage, leaf, cause, existing }));
    await W.openClaim(page, claim);
    let why = await W.abilityToPay(page).catch((e) => e.message);
    if (/incident description must not be empty/i.test(why || '')) {
      done.push(`vehicle incident description filled on ${(await fixVehicleIncidentDescriptions(page)).join(', ')}`);
      await W.openClaim(page, claim);
      why = await W.abilityToPay(page).catch((e) => e.message);
    }
    if (why) done.push(`Ability to pay: ${why.slice(0, 200)}`);
    // Reserve on the medical exposure when its row has none (Remaining Reserves "-").
    const rows = await exposureRows(page);
    const med = rows.find((r) => existing.test(r.t));
    if (med && !/\$[\d,]+\.\d\d/.test(med.t.replace(/^.*?(Open|Closed)/, ''))) {
      await W.openClaim(page, claim);
      page._currentClaimNumber = claim;
      const err = await require('../../financialsHelper').createReserve(page, { reserveAmount: amount, costType: 'Claim Cost', costCategory: 'Other', exposure: reserveOn }).catch((e) => e.message);
      done.push(err ? `reserve NOT added: ${String(err).slice(0, 200)}` : `added a ${amount} reserve on the ${reserveOn} exposure`);
      await W.openClaim(page, claim);
      const why2 = await W.abilityToPay(page).catch((e) => e.message);
      if (why2) done.push(`Ability to pay after reserve: ${why2.slice(0, 200)}`);
    }
    return done.join('; ');
  };
}

module.exports = (api) => {
  const { add, V, FULL_PAYMENTS } = api;
  const X = (fn, ...a) => ({ call: [`reuseExt.${fn}`, ...a] });
  const FINISH = X('finishObserve');
  const OUT = (re) => V('Finish outcome', { value: re });
  const SUBMITTED = OUT(/^submitted: check \d+/);
  const SUB = (amt) => `Submits a $${amt} payment on TEST (Finish) when no rule stops it.`;

  // ════ VBR.004 — DE, exposure Cause of Loss LC50 "Medical Benefits", Service Period End >= DoL + 2 years ═════════
  // Pays from the medical exposure's reserve line (Full Check: Reserve Line matching /Medical/; Quick Payment: the
  // Financials Claim Cost row under the "(n) … Medical …" exposure heading). Service Period Start = DoL.
  const SP = (end) => [{ fill: ['Service Period Start', 'DOL'] }, { fill: ['Service Period End', end] }];
  const LC50 = X('requireField', 'Cause of Loss', 'medical benefits', 'VBR.004 applies to exposures with Cause of Loss LC50 "Medical Benefits"');
  const MED_FULL = (end, amount) => [...FULL_PAYMENTS('claimant', 'match:Medical'), ...SP(end), { step2: { transactionType: 'Partial Payment', amount } }, LC50];
  const MED_QUICK = (end, amount) => [X('openQuickOnRow', 'claim cost', 'open', 'Medical'), ...SP(end), { step2: { transactionType: 'Partial Payment', amount } }, LC50];
  const VBR004 = /proper documentation/i;
  const DE = 'DE personal auto claim PMF-DE-01-25-0746339 (policy PMF-3053397, DoL 09/15/2024): "(2) Medical Benefits" exposure, Cause of Loss Medical Benefits (LC50), added for this case 2026-10-21 (the PA-DE policies offer only "Personal Injury Protection").';
  const PA = 'PA personal auto claim PA-PA-01-24-0744903 (DoL 02/01/2024): "Medical Expense" exposure, Cause of Loss Medical Benefits (LC50), added 2026-10-21.';
  add('GCCM-763/VBR/TC-008', 'F_DE_LC50', [...MED_FULL('DOL+730', '3.13'), FINISH], [OUT(VBR004)], DE + ' Service Period End = DoL + 2 years exactly (09/15/2026).');
  add('GCCM-763/VBR/TC-009', 'F_DE_LC50', [...MED_FULL('DOL+365', '3.17'), FINISH], [SUBMITTED], DE + ' End = DoL + 1 year. ' + SUB('3.17'));
  add('GCCM-763/VBR/TC-010', 'F_PA_LC50', [...MED_FULL('DOL+800', '3.19'), FINISH], [SUBMITTED], PA + ' End = DoL + 800 days (> 2 years). ' + SUB('3.19'));
  add('GCCM-1003/VBR/TC-090', 'F_DE_LC50', [...MED_QUICK('DOL+730', '3.23'), FINISH], [OUT(VBR004)], DE + ' Quick Payment; End = DoL + 2 years exactly.');
  add('GCCM-1003/VBR/TC-091', 'F_DE_LC50', [...MED_QUICK('DOL+365', '3.27'), FINISH], [SUBMITTED], DE + ' Quick Payment; End = DoL + 1 year. ' + SUB('3.27'));
  add('GCCM-1003/VBR/TC-092', 'F_PA_LC50', [...MED_QUICK('DOL+800', '3.29'), FINISH], [SUBMITTED], PA + ' Quick Payment; End = DoL + 800 days. ' + SUB('3.29'));
};
Object.assign(module.exports, {
  selectIn, fillIn, fixVehicleIncidentDescriptions, exposureRows, addMedExposure, fillInjuryPopup, claimNo,
  prepareDeMed: prepareMed('Medical Benefits', /Medical Benefits/i),
  preparePaMed: prepareMed('Medical Expense', /Medical Expense/i),
  // PIP › Wage Loss Benefits (Cause of Loss Personal Injury Protection = LC57) with a $2,500 reserve — UIF.061 / UIF.052.
  prepareDeWage: prepareMed('PIP', /Wage/i, { leaf: 'Wage Loss Benefits', cause: 'Personal Injury Protection', reserveOn: 'Wage', amount: 2500 }),
});
