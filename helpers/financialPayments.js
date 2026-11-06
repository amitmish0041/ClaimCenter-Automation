/**
 * helpers/financialPayments.js — CLOUD ClaimCenter payments for the financial-rule suite (FinancialRules.test.js).
 * Drives the New Payment wizard with the OneInc wizard driver (vendor payees from the Address Book by Tax ID, reserve
 * line, cost type, Adjuster Number, 1099 Box Number, Finish) and reads the result back from Checks/Payments and the
 * check's Approval History — so a rule case can tell "held by THIS rule" from "held because of the user's authority".
 *
 * Address Book vendors used (cloud TEST, CONFIRMED 2026-11-06 via the payee search):
 *   ADJUSTMENT SERVICES INC 58-1623664 (wizardDriver default vendor), PA FIRE RECOVERY SERVICE LLC 27-2990668.
 */
'use strict';
const W = require('./oneInc/wizardDriver');
const CO = require('./oneInc/checkOps');
const { readScreen, findField } = require('./oneInc/screenReader');

const VENDORS = {
  adjustment: { name: 'ADJUSTMENT SERVICES INC', search: 'ADJUSTMENT SERVICES', taxId: '58-1623664' },
  litigation: { name: 'LITIGATION SOLUTIONS LLC', search: 'LITIGATION SOLUTIONS', taxId: '25-1834107' },
  taylor: { name: 'TAYLOR REPORTING SERVICE', search: 'TAYLOR REPORTING', taxId: '58-2338930' },
  // On Administration › Tax Ids Requiring Approval (cloud TEST, 2026-11-06) — DMTA0106.
  zynex: { name: 'ZYNEX MEDICAL', search: 'ZYNEX', taxId: '84-1451963' },
  paFire: { name: 'PA FIRE RECOVERY SERVICE LLC', search: 'PA FIRE RECOVERY', taxId: '27-2990668' },
};

// Odd cents so CC's duplicate-payment check never matches an earlier check (except where a case wants it to).
const uniqueAmount = (dollars = 1) => `${dollars}.${String(11 + Math.floor(Math.random() * 88))}`;
const money = (s) => String(s || '').replace(/[^0-9.]/g, '');

// Picks the option of `label` matching `want` (RegExp) — returns the option text, or throws Blocked listing the options.
async function choose(page, label, want) {
  const opts = ((await W.optionsOf(page, label)) || []).map((o) => o.t).filter(Boolean);
  const hit = opts.find((t) => want.test(t));
  if (!hit) throw new W.Blocked(`"${label}" has no option matching ${want} (options: ${opts.join(' | ') || 'none'})`);
  await W.select(page, label, hit);
  await W.settle(page, 1500);
  return hit;
}

const fieldValue = async (page, label) => ((findField(await readScreen(page), label) || {}).value || '').trim();

/**
 * New Payment wizard, finished. opts:
 *   vendor   { search, taxId } — Address Book vendor; else payee: wizardDriver.selectPayee key ('claimant'|'insured'|…)
 *   payTo    text typed over "Pay To The Order Of" (DMTA0104)
 *   reserveLine 'new' (Expense OR First and Final) | 'open' | 'match:<re>'
 *   costType / costCategory / adjusterNumber / boxNumber  RegExp of the option to pick
 *   txn      Transaction Type (default Partial Payment), amount (default unique $1.xx)
 *   stopOnDuplicate  leave the wizard on CC's "Possible duplicate payment found" page instead of pressing through
 * Returns { amount, finished, messages[], fields{}, payee }. Never leaves a wizard open.
 */
async function makePayment(page, opts = {}) {
  const { vendor, payee = 'claimant', payTo, reserveLine = 'open', costType, costCategory, adjusterNumber, boxNumber, txn = 'Partial Payment', stopOnDuplicate = false } = opts;
  // An amount no check on the claim already has: a random $1.xx collided with an earlier check (8200004851) and the
  // case then read THAT check (DMTA0101 false read, 2026-11-06).
  let amount = opts.amount;
  if (!amount) {
    const used = new Set((await CO.checkRows(page).catch(() => [])).map((r) => money(r.amount)));
    for (let i = 0; i < 50 && (!amount || used.has(amount)); i++) amount = uniqueAmount(1 + Math.floor(i / 10));
  }
  if (!page.__oneIncParties) await W.getParties(page).catch(() => {});
  // Cloud: "At least one document needs to be linked to checks over $1,000" (VBR.010) — put OneInc's supporting
  // document on the claim first (as e2eSteps.close does); it is linked on step 3 below when CC asks.
  const K = require('./oneInc/recipes/workerK');
  if (Number(amount) > 1000) {
    const docs = await K.documentRows(page).catch(() => []);
    if (!docs.some((t) => t.toLowerCase().includes(K.DOC_NAME.toLowerCase()))) await K.addDocument(page).catch((e) => console.log('makePayment: add document failed — ' + e.message.split('\n')[0]));
  }
  if (opts.via === 'realtime') await openRealTimeCheck(page);
  else await W.openPayment(page, 'actions');
  const res = { amount, finished: false, messages: [], fields: {}, payee: '' };
  try {
    if (vendor) {
      await W.openPayeeSearch(page);
      if (!await W.searchAddressBookVendor(page, vendor.search, vendor.taxId)) throw new W.Blocked(`vendor "${vendor.search}" (Tax ID ${vendor.taxId}) not found in the Address Book`);
      res.payee = `${vendor.name || vendor.search} (${vendor.taxId})`;
    } else res.payee = await W.selectPayee(page, payee);
    // The insured is often also the BI claimant (PA claims: MIKE AANRUD); the reserve lines offered follow the payee
    // Type, so a BI payment needs Type = Claimant (2026-11-06: Type Insured offered only the 1st Party lines).
    if (opts.payeeType) res.fields.Type = await choose(page, 'Type', opts.payeeType);
    if (payTo) {
      // Pay To is read-only after a payee is chosen until the step's "Edit" is pressed (DMTA0104, 2026-11-06).
      await page.getByRole('button', { name: 'Edit', exact: true }).first().click().catch(() => {});
      await W.settle(page, 2000);
      const box = page.locator('.gw-InputWidget').filter({ hasText: /Pay To The Order Of/ }).locator('input, textarea').first();
      if (!await box.isVisible().catch(() => false)) throw new W.Blocked('"Pay To The Order Of" is still read-only after Edit');
      await box.fill(payTo);
      await box.press('Tab').catch(() => {});
      await W.settle(page, 1500);
    }
    res.fields['Pay To The Order Of'] = await fieldValue(page, 'Pay To The Order Of');
    const s1 = await W.nextFillingServicePeriod(page);
    if ((await W.currentStep(page) || {}).n !== 2) throw new W.Blocked(`payee step refused Next: ${[...s1.messages, s1.south].filter(Boolean).join(' / ').slice(0, 300) || 'no message'}`);
    await W.selectReserveLine(page, reserveLine);
    await W.settle(page, 2000);
    if (costType) res.fields['Cost Type'] = await choose(page, 'Cost Type', costType);
    if (costCategory) res.fields['Cost Category'] = await choose(page, 'Cost Category', costCategory);
    // A new expense line needs an Exposure (claim-level is refused: 'Missing required field "Exposure"', 2026-11-06).
    if (opts.exposure && findField(await readScreen(page), 'Exposure')) res.fields.Exposure = await choose(page, 'Exposure', opts.exposure);
    await W.completePaymentsStep(page, { transactionType: txn, amount, keepExposure: !!opts.exposure });
    // completePaymentsStep defaults 1099 Box Number to Not Applicable and Adjuster Number to the first option — set the
    // values the CASE asks for (or a neutral one) AFTER the amount, because the Total Amount refresh resets the box.
    if (findField(await readScreen(page), '1099 Box Number')) res.fields['1099 Box Number'] = await choose(page, '1099 Box Number', boxNumber || /^07/);
    if (findField(await readScreen(page), 'Adjuster Number')) res.fields['Adjuster Number'] = await choose(page, 'Adjuster Number', adjusterNumber || /^500 /);
    // RealTime Check asks for the printed check's number (required; "6 digits starting with a 7 = Real Time check").
    // Two boxes, both labelled "Check Number": a masked ManualCheckNumber and its confirmation RealtimeCheckNumber (the
    // wizard is ManualCheckWizard — cloud's RealTime Check IS the workbook's "Manual Check", CONFIRMED 2026-11-06).
    if (opts.via === 'realtime') {
      res.fields['Check Number'] = opts.checkNumber || `7${String(Date.now()).slice(-9)}`; // "must be a 10-digit number"
      for (const id of ['ManualCheckNumber', 'RealtimeCheckNumber']) {
        const box = page.locator(`input[name$="NewPaymentDetailDV-${id}"]`).first();
        await box.fill(res.fields['Check Number'], { timeout: 8000 });
        await box.press('Tab').catch(() => {});
        await W.settle(page, 1200);
      }
    }
    res.fields['Reserve Line'] = await fieldValue(page, 'Reserve Line');
    res.fields['Cost Type'] = res.fields['Cost Type'] || await fieldValue(page, 'Cost Type');
    res.fields['Transaction Type'] = (await fieldValue(page, 'Transaction Type')) || (await fieldValue(page, 'Payment Type'));
    const s2 = await W.nextFillingServicePeriod(page);
    if ((await W.currentStep(page) || {}).n !== 3) {
      res.messages = [...s2.messages, s2.south].filter(Boolean);
      throw new W.Blocked(`payment step refused Next: ${res.messages.join(' / ').slice(0, 300) || 'no message'}`);
    }
    // Step 3 "Is this payment to an attorney or representative of the insured or claimant AND is the settlement payment
    // or payment of a judgment?" — the check's represented flag (DMTV0050-0053 compliance letters, 2026-11-06).
    if (opts.represented) {
      const q = page.locator('.gw-InputWidget').filter({ hasText: /attorney or representative/i });
      await q.getByRole('radio', { name: 'Yes', exact: true }).first().click({ force: true });
      await W.settle(page, 1500);
      res.fields['Payment to attorney/representative (settlement)?'] = 'Yes';
    }
    await W.answerUnansweredNo(page);
    for (let r = 0; r < 2; r++) if (!(await W.fillRequiredEmpties(page)).length) break;
    const inv = findField(await readScreen(page), 'Invoice Number/Remarks');
    if (inv && !inv.value) await W.fill(page, 'Invoice Number/Remarks', `FR-${Date.now()}`).catch(() => {});
    await W.clickButton(page, 'Finish');
    for (let t = 0; t < 40 && await W.inWizard(page); t++) {
      const s = await readScreen(page);
      const m = [...s.messages, s.south].filter(Boolean);
      if (m.length) {
        res.messages.push(...m.filter((x) => !res.messages.includes(x)));
        if (/document needs to be linked/i.test(m.join(' ')) && !res.docLinked) {
          res.docLinked = true;
          await K.linkDocument(page).catch((e) => res.messages.push('link document failed: ' + e.message.split('\n')[0]));
          // The linked document row adds a required "Send Status" (2026-11-06) — fill required empties again.
          for (let r = 0; r < 2; r++) if (!(await W.fillRequiredEmpties(page)).length) break;
          await W.clickButton(page, 'Finish').catch(() => {});
          await W.settle(page, 3000);
          continue;
        }
        if (!W.warningsOnly(s)) break;
        if (/duplicate/i.test(m.join(' ')) && stopOnDuplicate) { res.duplicatePage = true; break; }
        const notDup = page.getByRole('radio', { name: 'Not a duplicate check', exact: true }).first();
        if (await notDup.isVisible().catch(() => false)) await notDup.click().catch(() => {});
        await W.clickButton(page, 'Finish').catch(() => {});
        await W.settle(page, 2500);
      }
      await page.waitForTimeout(1000);
    }
    res.finished = !await W.inWizard(page);
  } finally {
    await W.cancelWizard(page).catch(() => {});
  }
  return res;
}

// Actions › RealTime Check — the cloud "Manual Check" (6-digit check numbers starting with 7). Only the admin has the
// item on cloud TEST: every EBT team user (reps, supervisors, managers) lacks it (CONFIRMED 2026-11-06).
async function openRealTimeCheck(page) {
  const items = await W.openActionsMenu(page);
  const mi = page.getByRole('menuitem', { name: /^RealTime Check/ }).first();
  if (!await mi.isVisible().catch(() => false)) {
    await W.closeMenus(page);
    throw new W.Blocked(`Actions menu has no "RealTime Check" for this user (items: ${items.filter((i) => /payment|check/i.test(i)).join(', ')})`);
  }
  await mi.click();
  await page.getByRole('button', { name: 'Next', exact: true }).first().waitFor({ state: 'visible', timeout: 20000 });
  await W.settle(page, 2500);
}

// Checks/Payments row of the given amount (newest) → { number, payee, amount, status } or null.
async function checkRow(page, amount, payee) {
  const rows = await CO.checkRows(page);
  const p = String(payee || '').replace(/\s*\(.*$/, '').trim().toUpperCase();
  return rows.filter((r) => money(r.amount) === money(amount) && (!p || String(r.payee || r.text).toUpperCase().includes(p))).slice(-1)[0] || null;
}

// Opens the newest check of `amount` and reads what a QA would look at: status, 1099 Box Number, Adjuster Number, the
// Approval History (its Issue column carries the approval rule's message).
async function checkDetail(page, amount) {
  await CO.openCheck(page, { amount: `$${money(amount)}` });
  const s = await readScreen(page);
  const body = String(s.body || '').replace(/\s+/g, ' ');
  const between = (a, b) => { const i = body.indexOf(a); if (i < 0) return ''; const j = b ? body.indexOf(b, i + a.length) : -1; return body.slice(i + a.length, j > i ? j : i + a.length + 300).trim(); };
  const hist = await CO.approvalHistory(page);
  return {
    status: (findField(s, 'Status') || {}).value || '',
    box: (findField(s, '1099 Box Number') || {}).value || between('1099 Box Number', 'Memo Phrase'),
    adjuster: (findField(s, 'Adjuster Number') || {}).value || '',
    payTo: (findField(s, 'Pay To The Order Of') || {}).value || '',
    approvalHistory: hist.replace(/^Approval History:\s*/, ''),
    body: body.slice(0, 3000),
  };
}

// Opens the newest open Workplan activity whose subject matches and returns its detail text (subject, description,
// assigned to/by) — the approval activity carries the rule's reason in its description.
async function activityDetail(page, subject = /approve new payment/i) {
  await W.navigate(page, 'workplan').catch(async () => { await page.locator('[id="Claim-MenuLinks-Claim_ClaimWorkplan"]').first().click(); });
  await W.settle(page, 3000);
  const link = page.locator('tr[role="row"]:visible').filter({ hasText: /\bOpen\b/ }).getByText(subject).last();
  if (!await link.isVisible().catch(() => false)) return '';
  await link.click();
  await W.settle(page, 3500);
  const t = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const i = t.search(/Activity Detail|Subject/);
  return t.slice(Math.max(0, i), i + 1500);
}

module.exports = { activityDetail, VENDORS, uniqueAmount, money, makePayment, checkRow, checkDetail, choose };
