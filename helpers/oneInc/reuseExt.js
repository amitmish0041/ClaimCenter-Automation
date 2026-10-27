/**
 * helpers/oneInc/reuseExt.js
 * Helpers for the "high reuse" OneInc recipes (recipes/reuseB.js) and profiles (profiles/reuseB.js). Called from
 * recipes with { call: ['reuseExt.<fn>', ...args] } → fn(page, ...args), and from claimCheck's prepare hook.
 */
'use strict';
const W = require('./wizardDriver');
const { readScreen } = require('./screenReader');

const firstReal = async (sel) => {
  const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })));
  return opts.find((o) => o.v && o.t && !/^<none>$/i.test(o.t));
};

// AUTO_DE_AGED prepare (TEST only): CC's Ability to pay refused the DE PIP exposure with "Exposure description must
// not be empty" / "Detailed body part must not be null" — the exposure's Injury Incident has no injured person,
// description or body part. Fill them (Exposure › Edit › Injury Incident › Edit Incident Details…), OK, Update.
// Idempotent: does nothing when Ability to pay already passes.
async function prepareAgedPip(page, claim, out = {}) {
  const why = await W.abilityToPay(page).catch((e) => e.message);
  if (!/description must not be empty|body part must not be null/i.test(why || '')) return '';
  await W.openClaim(page, claim);
  await W.navigate(page, 'exposures');
  await page.waitForTimeout(2500);
  // The exposure ATP names — the first PIP/medical one.
  const rows = await page.evaluate(() => [...document.querySelectorAll('[id$="-Type"][id*="ExposuresLV-"]')].map((e) => ({ id: e.id, t: (e.innerText || '').trim() })));
  const row = rows.find((r) => /medical|pip/i.test(r.t)) || rows[0];
  const idx = row ? (/ExposuresLV-(\d+)-Type$/.exec(row.id) || [])[1] : '0';
  await page.locator(`[id="ClaimExposures-ClaimExposuresScreen-ExposuresLV-${idx}-Order_button"]`).click();
  await W.settle(page, 3500);
  await W.clickButton(page, 'Edit');
  await page.locator('[id$="Injury_Incident-Injury_IncidentMenuIcon"]').first().click({ force: true });
  await page.waitForTimeout(1200);
  await page.locator('[id$="Injury_Incident-VehicleDamageDV_EditIncidentMenuItem"]').first().click({ force: true });
  await W.settle(page, 4000);
  if (process.env.REUSEB_DEBUG) await page.screenshot({ path: process.env.REUSEB_DEBUG });
  const P = 'EditInjuryIncidentPopup-EditInjuryIncidentScreen-InjuryIncidentDV';
  const injured = page.locator(`[id="${P}-Injured_Picker_Input"] select`).first();
  if (await injured.isVisible().catch(() => false) && /^$/.test(await injured.inputValue().catch(() => ''))) {
    // NOT W.getParties here — it navigates to the Exposures list and drops the popup. The PIP claimant is the insured
    // on these aged first-party claims (claim header "Ins: NAME").
    const ins = await page.evaluate(() => ((/Ins:\s*([^\n]+?)\s+DoL/.exec((document.body.innerText || '').replace(/\s+/g, ' ')) || [])[1] || '').trim()).catch(() => '');
    const opts = await injured.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })));
    const pick = opts.find((o) => ins && o.t.toUpperCase() === ins.toUpperCase()) || opts.find((o) => o.v && !/^<none>$/i.test(o.t));
    if (pick) { await injured.selectOption(pick.v); await W.settle(page, 2000); }
  }
  const desc = page.locator(`[id="${P}-InjuryIncidentInputSet-InjuryDescription_Input"] textarea, [id="${P}-InjuryIncidentInputSet-InjuryDescription_Input"] input`).first();
  if (await desc.isVisible().catch(() => false) && !(await desc.inputValue().catch(() => ''))) await desc.fill('OneInc automation — medical expense injury');
  // Body Parts grid: Add a row, then Area of Body + Body Part (the "Detailed body part").
  // CONFIRMED 2026-10-21: the grid's Add is the FIRST "Add" button on the popup; row 0 then has selects
  // …EditableBodyPartDetailsLV-0-PrimaryBodyPart (Area of Body) and …-0-DetailedBodyPart (Body Part).
  const LV = `${P}-InjuryIncidentInputSet-EditableBodyPartDetailsLV-0-`;
  const area = page.locator(`select[name="${LV}PrimaryBodyPart"], select[id="${LV}PrimaryBodyPart"]`).first();
  if (!await area.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await W.settle(page, 2500);
  }
  for (const k of ['PrimaryBodyPart', 'DetailedBodyPart']) {
    const s = page.locator(`select[name="${LV}${k}"], select[id="${LV}${k}"]`).first();
    if (!await s.isVisible().catch(() => false) || await s.inputValue().catch(() => 'x')) continue;
    const o = await firstReal(s);
    if (o) { await s.selectOption(o.v); await W.settle(page, 2000); }
  }
  await W.clickButton(page, 'OK');
  const s1 = await readScreen(page);
  if (await page.getByRole('button', { name: 'OK', exact: true }).first().isVisible().catch(() => false)) {
    throw new W.Blocked(`injury incident could not be saved: ${s1.messages.join(' / ').slice(0, 300) || 'no message'}`);
  }
  await W.clickButton(page, 'Update');
  const s2 = await readScreen(page);
  if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
    throw new W.Blocked(`exposure could not be saved: ${s2.messages.join(' / ').slice(0, 300) || 'no message'}`);
  }
  return 'PIP exposure injury incident completed (injured person, description, body part)';
}

// ── Quick Payment from a reserve row of a given cost type ───────────────────────────────────────────────────────
// Core openPayment('quick') takes the first row with open reserve, which is always a Claim Cost row on the test
// claims. Expense-only Quick Payment cases need the row under an "Adjuster Expense" / "Legal Expense" cost-type
// heading. Financials summary rows (CONFIRMED 2026-10-21): exposure row, cost-type row ("Claim Cost",
// "Adjuster Expense - Unallocated"), then the leaf cost-category row ("Other USD") that carries the options button.
// reserve: 'any' | 'open' (remaining > 0) | 'zero' | a number (remaining >= it).
// exposureSource: optional regex on the "(n) Exposure name" heading row, to pick a row under a given exposure.
async function openQuickOnRow(page, costTypeSource = 'expense', reserve = 'any', exposureSource = '') {
  const costRe = new RegExp(costTypeSource, 'i');
  await W.navigate(page, 'financials');
  await page.getByRole('button', { name: 'options', exact: true }).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const found = await page.evaluate(({ src, reserve, expoSrc }) => {
    const re = new RegExp(src, 'i');
    const expoRe = expoSrc ? new RegExp(expoSrc, 'i') : null;
    const rows = [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr'));
    let cost = '';
    let expo = '';
    let pick = -1;
    const seen = [];
    rows.forEach((r, i) => {
      const hasOpt = [...r.querySelectorAll('[role=button]')].some((b) => (b.getAttribute('aria-label') || b.innerText || '').trim() === 'options');
      const t = (r.innerText || '').replace(/\s+/g, ' ').trim();
      if (!hasOpt) {
        const m = /^(Claim Cost|[A-Za-z ]*Expense(?: - (?:Allocated|Unallocated))?)\b/.exec(t);
        if (/^\(\d+\)/.test(t)) expo = t;
        if (m && !/^\(\d+\)/.test(t)) cost = m[1];
        return;
      }
      const b = r.querySelector('[id$="-RemainingReserves_button"]');
      const amt = parseFloat(((b && b.innerText) || '').replace(/[^0-9.-]/g, ''));
      const remaining = Number.isFinite(amt) ? amt : 0;
      seen.push(`${cost} (${remaining})`);
      if (pick >= 0 || !re.test(cost) || (expoRe && !expoRe.test(expo))) return;
      if (reserve === 'open' && !(remaining > 0)) return;
      if (reserve === 'zero' && remaining > 0) return;
      if (typeof reserve === 'number' && !(remaining >= reserve)) return;
      r.setAttribute('data-reuseb-row', 'pick');
      pick = i;
    });
    return { pick, seen };
  }, { src: costTypeSource, reserve, expoSrc: exposureSource });
  if (found.pick < 0) throw new W.Blocked(`no ${typeof reserve === 'number' ? `>= ${reserve} ` : reserve === 'any' ? '' : reserve + ' '}reserve line (Financials row) of cost type /${costTypeSource}/ on this claim (rows: ${found.seen.join(', ') || 'none'})`);
  await page.locator('tr[data-reuseb-row="pick"]').getByRole('button', { name: 'options', exact: true }).first().click();
  await W.settle(page, 1200);
  const mi = page.getByRole('menuitem', { name: /^Quick (Payment|Check)$/ }).first();
  if (!await mi.isVisible().catch(() => false)) { await W.closeMenus(page); throw new W.Blocked('the reserve row menu has no Quick Payment item'); }
  await mi.click();
  const ready = await Promise.race([
    page.getByRole('button', { name: 'Next', exact: true }).first().waitFor({ state: 'visible', timeout: 20000 }).then(() => 'wizard').catch(() => null),
    page.getByText('New Payment Error').first().waitFor({ state: 'visible', timeout: 20000 }).then(() => 'error').catch(() => null),
  ]);
  if (ready !== 'wizard') throw new W.Blocked(`Quick Payment did not open — ${(await W.newPaymentErrorText(page)) || 'no message'}`);
  await W.settle(page, 2500);
}

// ── Reserves (TEST only, used by ad-hoc prepare runs) ───────────────────────────────────────────────────────────
// Adds a reserve of the given cost type on the claim (financialsHelper.createReserve — Actions › Reserve), e.g. a
// Legal Expense / Adjuster Expense row for the expense-only Quick Payment cases, or a fresh Claim Cost reserve on a
// claim whose only line was closed by a Final Payment (claimCheck's prepare now also does this when every line is at
// $0 — it used to only when the claim had NO line, CONFIRMED 2026-10-21 on PA-PA-01-26-0748443). strict: CC must
// offer the requested cost type / exposure, else the error comes back (no silent edit of another reserve).
// Returns '' on success, else the message.
async function addReserve(page, claim, { costType = 'Claim Cost', costCategory, amount = 500, exposure } = {}) {
  await W.cancelWizard(page).catch(() => {});
  await W.openClaim(page, claim);
  page._currentClaimNumber = claim;
  const err = await require('../financialsHelper').createReserve(page, { reserveAmount: amount, costType, costCategory, exposure, strict: true }).catch((e) => e.message);
  await W.openClaim(page, claim).catch(() => {});
  return err || '';
}

// Remaining reserve per Financials leaf row, with its cost-type heading: [{ cost: 'Legal Expense', remaining: 500 }].
async function reserveRows(page) {
  await W.navigate(page, 'financials');
  await page.getByRole('button', { name: 'options', exact: true }).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr'));
    let cost = '';
    let expo = '';
    const out = [];
    for (const r of rows) {
      const t = (r.innerText || '').replace(/\s+/g, ' ').trim();
      const hasOpt = [...r.querySelectorAll('[role=button]')].some((b) => (b.getAttribute('aria-label') || b.innerText || '').trim() === 'options');
      if (!hasOpt) {
        if (/^\(\d+\)/.test(t)) { expo = t.replace(/\s*\$.*$/, ''); continue; }
        const m = /^(Claim Cost|[A-Za-z ]*Expense(?: - (?:Allocated|Unallocated))?)\b/.exec(t); if (m) cost = m[1]; continue;
      }
      const b = r.querySelector('[id$="-RemainingReserves_button"]');
      const n = parseFloat(((b && b.innerText) || '').replace(/[^0-9.-]/g, ''));
      // expo: the "(n) Exposure name" heading the row sits under (added 2026-10-21 for testData reserve checks).
      out.push({ expo, cost, remaining: Number.isFinite(n) ? n : 0, text: t.slice(0, 120) });
    }
    return out;
  });
}

// ── Precondition gates ──────────────────────────────────────────────────────────────────────────────────────────
// BLOCKED (not FAIL) when the payment line's read-only field (e.g. Cause of Loss, Coverage) doesn't meet the case's
// precondition — the test claim can't be changed to it (e.g. the DE PIP exposure offers only "Personal Injury
// Protection" as Cause of Loss, not Medical Benefits / LC50).
async function requireField(page, label, source, why) {
  const { findField } = require('./screenReader');
  const f = findField(await readScreen(page), label);
  const v = f ? String(f.value || '') : '';
  if (!new RegExp(source, 'i').test(v)) throw new W.Blocked(`${why} (this claim's payment line: ${label} = "${v || 'not shown'}")`);
}

// ── Finish with full observation ────────────────────────────────────────────────────────────────────────────────
// The core `validate` step presses Finish a second time when CC answers with a warnings-only page, which would hide
// exactly the WARNINGS the VBR.004/005/007/015 cases are about (and submit the payment). This step instead:
//  - presses Next until the last step (filling only required blanks such as Memo Phrase), and STOPS at the first
//    warning or error it sees — never clicks through one (except CC's "Possible duplicate payment" page);
//  - presses Finish once on the last step (TEST/DEV + ONEINC_ALLOW_FINISH=1 only);
//  - if the wizard closes, reads the new check number on Financials › Checks (same proof as the core runner);
//  - writes the outcome into a read-only "Finish outcome" field injected at the top of the page, so a normal
//    V('Finish outcome', { value: /…/ }) check records it (and the screenshot shows it).
// Outcomes: "submitted: check N ($x, status)" | "stopped at Next: [warning] …" | "stopped at Finish: [error] …".
const TIER = (process.env.CC_TIER || 'test').toLowerCase();
async function typedMessages(page) {
  return page.evaluate(() => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    const out = [];
    for (const el of document.querySelectorAll('[class*="gw-message-type-"]')) {
      if (!vis(el)) continue;
      const m = /gw-message-type-(\w+)/.exec(el.className) || [];
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      // The VBR.001 "payment contact details" warning shows on every step for most payees — ignored (user direction
      // 2026-10-21: it does not block payments).
      if (t && !/payment contact details/i.test(t) && !out.some((o) => o.t === t)) out.push({ type: (m[1] || 'msg').toLowerCase(), t });
    }
    const south = document.getElementById('gw-south-panel');
    const st = south && vis(south) ? (south.innerText || '').replace(/\s+/g, ' ').trim() : '';
    if (st && !/^Validation Results\s*Clear$/i.test(st) && !/payment contact details/i.test(st)) out.push({ type: 'panel', t: st.slice(0, 400) });
    return out;
  }).catch(() => []);
}
const fmtMsgs = (ms) => ms.map((m) => `[${m.type}] ${m.t}`).join(' / ').slice(0, 600);
async function newestCheck(page, amount) {
  await W.navigate(page, 'checks').catch(() => {});
  await page.locator('tr[id*="ChecksLV-0-"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  // The Checks list pages 15 rows at a time, oldest first — a new check lands on the LAST page. Reading page 1 only
  // reported "no check listed" for payments that were submitted (CONFIRMED 2026-10-21 on 0748435, 24 checks / 2
  // pages; core scenarioRunner.newestCheck has the same gap). Read every page.
  // A check held for approval is listed with NO check number and status "Pending approval" (CONFIRMED 2026-10-21 on
  // PA-MD-01-23-0742279: $2.31 / $2.33 / $2.39 / $2.41 / $2.47 / $2.53 all "Pending approval", number blank) — keep
  // those rows (pending: true) instead of dropping everything without a number.
  const readPage = () => page.evaluate(() => {
    return [...document.querySelectorAll('tr[id*="ChecksLV-"]')].filter((r) => !r.querySelector('tr')).map((r) => {
      const cell = (k) => ((r.querySelector(`[id$="-${k}"]`) || {}).innerText || '').trim();
      return { number: cell('CheckNumber'), amount: cell('GrossAmount'), status: cell('Status') };
    }).filter((x) => /^\d+$/.test(x.number) || (!x.number && /\$\s*[\d,]+\.\d\d/.test(x.amount)));
  });
  // Page-change detection keys on the whole row set (rows held for approval all have an empty number).
  const pageKey = async () => (await readPage()).map((x) => `${x.number}|${x.amount}|${x.status}`).join(';');
  // The list keeps the page it was left on — go back to page 1 first.
  const cur0 = await page.locator('[id$="ChecksLV-_ListPaging-input"]').first().inputValue().catch(() => '1');
  if (Number(cur0) > 1) {
    const before = await pageKey();
    await page.locator('[id$="ChecksLV-_ListPaging-first"]').first().click().catch(() => {});
    for (let t = 0; t < 20 && await pageKey() === before; t++) await page.waitForTimeout(500);
  }
  const rows = await readPage();
  const nextBtn = page.locator('[id$="ChecksLV-_ListPaging-next"]').first();
  for (let p = 0; p < 20; p++) {
    const total = await page.locator('[id$="ChecksLV-_ListPaging-postLabel"]').first().innerText().catch(() => '1');
    const cur = await page.locator('[id$="ChecksLV-_ListPaging-input"]').first().inputValue().catch(() => '1');
    if (!(Number(cur) < Number(total)) || !await nextBtn.isVisible().catch(() => false)) break;
    const first = await pageKey();
    await nextBtn.click().catch(() => {});
    for (let t = 0; t < 20 && await pageKey() === first; t++) await page.waitForTimeout(500);
    rows.push(...await readPage());
  }
  return pickCheck(rows, amount);
}
// Pure part of newestCheck (offline-tested): the LAST row of this amount in list order. The list is in creation order
// across all pages, with checks held for approval (no number) interleaved where they were created (CONFIRMED
// 2026-10-21 on PA-MD-01-23-0742279) — "highest check number" picked an older numbered check over the new held one.
function pickCheck(rows, amount) {
  const want = String(amount || '').replace(/[^0-9.]/g, '');
  const hits = rows.filter((x) => !want || String(x.amount || '').replace(/[^0-9.]/g, '') === want)
    .map((x) => ({ ...x, pending: !/^\d+$/.test(x.number || '') }));
  return hits.slice(-1)[0] || null;
}
// "check 123456 ($1.37, Requesting)" | "Pending approval — no check number yet ($2.47)"
const describeCheck = (c) => (c.pending ? `${c.status || 'Pending approval'} — no check number yet (${c.amount})` : `check ${c.number} (${c.amount}, ${c.status})`);
async function showOutcome(page, text) {
  await page.evaluate((t) => {
    const old = document.getElementById('reuseb-outcome');
    if (old) old.remove();
    const d = document.createElement('div');
    d.id = 'reuseb-outcome';
    d.className = 'gw-InputWidget';
    d.style.cssText = 'display:block;position:relative;z-index:99999;background:#fff8c4;border:2px solid #b58900;padding:6px 10px;font:13px sans-serif;';
    d.innerHTML = '<div class="gw-label" style="font-weight:bold">Finish outcome</div><div class="gw-value"><div class="gw-readonly"></div></div>';
    d.querySelector('.gw-readonly').textContent = t;
    document.body.insertBefore(d, document.body.firstChild);
  }, text).catch(() => {});
}
async function finishObserve(page) {
  if (!(process.env.ONEINC_ALLOW_FINISH === '1' && ['test', 'dev'].includes(TIER))) {
    throw new W.Blocked('confirming this rule needs Finish, which submits the payment — enable ONEINC_ALLOW_FINISH=1 (test/dev tier) to run it');
  }
  let outcome = null;
  for (let round = 0; round < 5 && !outcome; round++) {
    const st = await W.currentStep(page);
    if (!st) { outcome = 'stopped: not on a payment wizard step'; break; }
    if (st.n === st.of) break;
    await W.fillRequiredEmpties(page);
    await W.clickButton(page, 'Next');
    const after = await W.currentStep(page);
    if (after && after.n > st.n) continue;
    const ms = await typedMessages(page);
    const real = ms.filter((m) => !/Missing required field/i.test(m.t));
    if (!real.length && ms.length) {
      // Only "Missing required field" — fill what is blank and try again.
      const filled = await W.fillRequiredEmpties(page);
      if (filled.length) continue;
    }
    outcome = `stopped at Next: ${fmtMsgs(ms) || 'wizard did not advance, no message'}`;
  }
  if (!outcome) {
    await W.answerUnansweredNo(page);
    for (let r = 0; r < 2; r++) if (!(await W.fillRequiredEmpties(page)).length) break;
    const { findField } = require('./screenReader');
    const s0 = await readScreen(page);
    const inv = findField(s0, 'Invoice Number/Remarks');
    if (inv && !inv.value) await W.fill(page, 'Invoice Number/Remarks', `ONEINC-${Date.now()}`).catch(() => {});
    const amount = ((findField(s0, 'Amount') || findField(s0, 'Total Amount of Payment') || {}).value) || '';
    const settle = async () => {
      for (let t = 0; t < 30; t++) {
        if (!await W.inWizard(page)) return;
        if ((await typedMessages(page)).length) return;
        await page.waitForTimeout(1000);
      }
    };
    await W.clickButton(page, 'Finish');
    await settle();
    let ms = await typedMessages(page);
    // Press through only warnings that are never what a rule case is about: CC's duplicate-check page and the
    // claim's "At least one aggregate limit … exceeded" (CONFIRMED 2026-10-21 a warnings-only page that saves on a
    // second Finish). Any other warning stops here and becomes the outcome.
    let passed = '';
    const ignorable = (t) => /duplicate/i.test(t) || (!/\bErrors?\s*:/i.test(t)
      && t.replace(/^Validation Results\s*Clear\s*Warnings:\s*/i, '').split(/(?<=\.)\s+/).every((x) => /aggregate limit/i.test(x)));
    if (await W.inWizard(page) && ms.length && ms.every((m) => ignorable(m.t))) {
      passed = fmtMsgs(ms);
      const notDup = page.getByRole('radio', { name: 'Not a duplicate check', exact: true }).first();
      if (await notDup.isVisible().catch(() => false)) await notDup.click().catch(() => {});
      await W.clickButton(page, 'Finish').catch(() => {});
      await settle();
      ms = await typedMessages(page);
    }
    if (await W.inWizard(page)) outcome = `stopped at Finish: ${fmtMsgs(ms) || 'no message'}`;
    else {
      const chk = await newestCheck(page, amount);
      outcome = (chk ? `submitted: ${describeCheck(chk)}` : `submitted, but no ${amount} check is listed on Financials › Checks`)
        + (passed ? ` — after warning(s) at Finish: ${passed}` : '');
    }
  }
  await showOutcome(page, outcome);
}

// Shows a message-presence observation as a read-only field ("Observed messages"), so the evidence and the report
// carry the actual text (used for VBR.001's contact-details warning, which the core `message` check reads only from
// the wizard message area).
async function showMessages(page) {
  const s = await readScreen(page);
  const t = [...s.messages, s.south].filter(Boolean).join(' / ') || '(none)';
  await page.evaluate((txt) => {
    const d = document.createElement('div');
    d.className = 'gw-InputWidget';
    d.id = 'reuseb-messages';
    d.style.cssText = 'display:block;position:relative;background:#eef;border:1px solid #88a;padding:4px 8px;font:12px sans-serif;';
    d.innerHTML = '<div class="gw-label">Observed messages</div><div class="gw-value"><div class="gw-readonly"></div></div>';
    d.querySelector('.gw-readonly').textContent = txt;
    document.body.insertBefore(d, document.body.firstChild);
  }, t.slice(0, 800));
}

// ── Payees ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Address Book vendor by search text + Tax ID (same picker walk as wizardDriver.selectVendorPayee, for vendors not in
// the default list — e.g. Insurance Auto Auctions for CPD.015).
async function selectVendorByTaxId(page, search, taxId) {
  await W.openPayeeSearch(page);
  await W.settle(page, 3500);
  await W.select(page, 'Type', 'Vendor (Company)').catch(() => {});
  await page.getByLabel('Name', { exact: true }).last().fill(search);
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await W.settle(page, 4500);
  const row = page.locator('tr').filter({ hasText: taxId }).filter({ has: page.getByRole('button', { name: 'Select', exact: true }) }).last();
  if (!await row.isVisible().catch(() => false)) {
    const found = await page.evaluate(() => [...document.querySelectorAll('tr')].filter((r) => !r.querySelector('tr') && /\d\d-\d{7}/.test(r.innerText || '')).map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90)).slice(0, 5)).catch(() => []);
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new W.Blocked(`vendor "${search}" with Tax ID ${taxId} not found in the TEST Address Book${found.length ? ` (search returned: ${found.join(' | ')})` : ' (search returned nothing)'}`);
  }
  await row.getByRole('button', { name: 'Select', exact: true }).first().click();
  await W.settle(page, 3500);
}

// Add Joint Payees with an extra resolver: who '@person' = a PERSON contact on the claim who is neither the insured
// nor an exposure claimant (companies, agencies, banks, body shops are skipped) — the "secondary claimant" the
// CPD.006/012/022 cases need, whatever the claim's contact names are. Other entries are passed to W.addJointPayees.
const COMPANY = /insurance|agency|donegal|bank|auto body|garage|\bllc\b|\binc\b|corp|company|services|solutions|reporting|& /i;
async function addJoint(page, list) {
  const names = ((await W.optionsOf(page, 'Name')) || []).map((o) => o.t).filter((t) => t && !/^<none>$/i.test(t));
  const parties = page.__oneIncParties || { insured: '', claimants: [] };
  const up = (s) => String(s || '').trim().toUpperCase();
  const used = new Set();
  const out = list.map((p) => {
    if (p.who !== '@person') return p;
    const pick = names.find((n) => !used.has(n) && up(n) !== up(parties.insured) && !(parties.claimants || []).some((c) => up(c) === up(n)) && !COMPANY.test(n));
    if (!pick) throw new W.Blocked(`no second person contact (not insured / claimant / company) on this claim to add as a joint payee (${names.join(', ')})`);
    used.add(pick);
    return { ...p, who: pick };
  });
  return W.addJointPayees(page, out);
}

// Like openQuickOnRow, but a wizard that refuses to open ("New Payment Error") is not an error here: the message stays on the
// screen for the case's own check (rules that fire when the payment is started, e.g. VBR.002).
async function tryOpenQuickOnRow(page, cost, reserve, exposureSource) {
  try { await openQuickOnRow(page, cost, reserve, exposureSource); } catch (e) { if (!/did not open/i.test(String(e.message))) throw e; }
}

module.exports = { prepareAgedPip, tryOpenQuickOnRow, openQuickOnRow, addReserve, reserveRows, newestCheck, describeCheck, requireField, finishObserve, showMessages, selectVendorByTaxId, addJoint, _test: { fmtMsgs, pickCheck } };
