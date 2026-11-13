/**
 * helpers/oneInc/priorPayments.js — builds the EARLIER payment a case's precondition names, on the case's own fresh claim
 * (user direction 2026-11-12: "lets automate everything we can"). Before this, these cases were NEEDS_DATA because no TEST
 * claim carried the state; since 2026-11-12 OneInc acknowledges TEST checks (Requesting → Requested / Issued) and answers a
 * void with Stopped → Voided, so the state can be made:
 *
 *   voidedFirstAndFinal          a First and Final on a new Claim Cost line of exposure (1), issued, voided (Repost No) and
 *                                Voided            — 763 VBR TC-055 / 1003 VBR TC-138 (VBR.019)
 *   rejectedFinal                a Final Payment held "Pending approval", Rejected by its approver
 *                                                  — 763 VBR TC-062 / 1003 VBR TC-145 (VBR.022)
 *   partialWithFinalAwaiting     an issued Partial and a Final left "Awaiting submission" on the same line
 *                                                  — 787 TC-011 (Claim Cost) / TC-012 (Expense) (VBR.002)
 *   supplementalWithFinalPending an issued Supplemental and a Final "Pending approval" on the same line
 *                                                  — 787 TC-013 (Claim Cost) / TC-014 (Expense) (VBR.002)
 *
 * Every step submits a TEST payment (gated by ONEINC_ALLOW_FINISH=1 like Finish). Amounts: ≤ $1.00 goes straight through
 * (fresh claims' adjuster authority), $1.4x is held "Pending approval" (CONFIRMED 2026-11-03 on fresh claims).
 * Rejecting needs the approver's login: CC_TEAM_PASS (shared TEST password) passed INLINE only — never stored.
 *
 * NOT YET RUN END TO END: written 2026-11-12 while every TEST payment was refused "Exposure owner … must have a valid
 * examiner number". Verify on the first run once payments work again.
 */
'use strict';
const W = require('./wizardDriver');
const X = require('./reuseExt');
const K = require('./checkOps');
const { readScreen, findField } = require('./screenReader');

const TIER = (process.env.CC_TIER || 'test').toLowerCase();
const gate = (what) => {
  if (!(process.env.ONEINC_ALLOW_FINISH === '1' && ['test', 'dev'].includes(TIER))) {
    throw new W.Blocked(`${what} submits TEST payments — enable ONEINC_ALLOW_FINISH=1 (test/dev tier) to run it`);
  }
};
const odd = (whole = 0) => `${whole}.${41 + Math.floor(Math.random() * 58)}`; // unique-ish so CC's duplicate check stays quiet
const amt = (s) => String(s || '').replace(/[^0-9.]/g, '');
const claimNo = (page) => page.evaluate(() => ((document.body.innerText || '').match(/Claim:\s*([A-Z]{2,4}-[A-Z]{2}-[\d-]+)/) || [])[1] || '');
const EXPENSE = 'Adjuster Expense';

// Presses Finish and through warnings-only pages; BLOCKED with CC's text when the wizard stays open.
async function finish(page, what) {
  await W.nextFillingServicePeriod(page).catch(() => {});
  await W.answerUnansweredNo(page).catch(() => {});
  for (let r = 0; r < 2; r++) if (!(await W.fillRequiredEmpties(page)).length) break;
  const inv = findField(await readScreen(page), 'Invoice Number/Remarks');
  if (inv && !inv.value) await W.fill(page, 'Invoice Number/Remarks', `ONEINC-${Date.now()}`).catch(() => {});
  // Next refused (a step-1/2 rule): say what CC said instead of "Finish button is not on the screen" (2026-11-13).
  if (!await page.getByRole('button', { name: 'Finish', exact: true }).first().isEnabled().catch(() => false)) {
    const s = await readScreen(page);
    const step = await W.currentStep(page).catch(() => null);
    await W.cancelWizard(page).catch(() => {});
    throw new W.Blocked(`${what} (test data) stopped on step ${step ? `${step.n} "${step.title}"` : '?'}: ${[...s.messages, s.south].filter(Boolean).join(' / ').slice(0, 300) || 'no message'}`);
  }
  await W.clickButton(page, 'Finish');
  let msgs = '';
  for (let t = 0; t < 40 && await W.inWizard(page); t++) {
    const s = await readScreen(page);
    if (s.messages.length || s.south) {
      msgs = [...s.messages, s.south].join(' / ');
      if (!W.warningsOnly(s)) break;
      const notDup = page.getByRole('radio', { name: 'Not a duplicate check', exact: true }).first();
      if (await notDup.isVisible().catch(() => false)) await notDup.click().catch(() => {});
      await W.clickButton(page, 'Finish').catch(() => {});
      await W.settle(page, 2000);
    }
    await page.waitForTimeout(1000);
  }
  if (await W.inWizard(page)) {
    await W.cancelWizard(page).catch(() => {});
    throw new W.Blocked(`${what} (test data) was refused: ${msgs.slice(0, 300) || 'no message'}`);
  }
}

// One payment, finished. via 'quick' opens Quick Payment from the Financials row of cost type `cost` (regex source) with
// remaining `reserve` ('open' | 'zero' | 'any'); via 'full' runs the Full Check wizard (Actions › New Payment) on line
// `line` ('open' | 'new' — new: Cost Type `costType`, Exposure (1)); via 'row' opens Create Payment from that Financials row.
async function pay(page, { via = 'quick', txn = 'Partial Payment', amount = odd(), cost = 'claim cost', reserve = 'open', line = 'open', costType = 'Claim Cost', payee } = {}) {
  gate(`A ${txn}`);
  if (!page.__oneIncParties) await W.getParties(page).catch(() => {});
  if (via === 'quick' || via === 'row') {
    await X.openQuickOnRow(page, cost, reserve, '', via === 'row' ? 'create' : 'quick');
    if (via === 'row') { await W.selectPayee(page, payee || 'claimant'); await W.nextFillingServicePeriod(page); } else if (payee) await W.selectPayee(page, payee);
  } else {
    await W.openPayment(page, 'actions');
    await W.selectPayee(page, payee || 'claimant');
    await W.nextFillingServicePeriod(page);
    await W.selectReserveLine(page, line);
    if (line === 'new') { await W.select(page, 'Cost Type', costType); await W.select(page, 'Exposure', /^\(1\)/); }
  }
  await W.completePaymentsStep(page, { transactionType: txn, amount, ...(line === 'new' ? { keepExposure: true } : {}) });
  await finish(page, `the $${amount} ${txn}`);
  const row = (await K.checkRows(page)).filter((r) => amt(r.amount) === amt(amount)).slice(-1)[0];
  (page.__prior = page.__prior || []).push({ txn, amount, cost, status: row ? row.status : '' });
  return { amount, status: row ? row.status : 'not listed' };
}

// Polls the claim's check of `amount` until its status matches `re` (runs the Financials Escalation batch once if it sits
// "Awaiting submission"). Returns the last status; BLOCKED after `minutes`.
async function waitStatus(page, amount, re, minutes = 15, what = 'check') {
  let row;
  let escalated = false;
  for (const end = Date.now() + minutes * 60000; ;) {
    row = (await K.checkRows(page)).filter((r) => amt(r.amount) === amt(amount)).slice(-1)[0];
    if (row && re.test(row.status)) return row.status;
    if (Date.now() > end) break;
    if (row && /Awaiting submission/i.test(row.status) && !escalated) { escalated = true; await K.escalateChecks(page, amount).catch(() => {}); continue; }
    await page.waitForTimeout(30000);
    await page.reload().catch(() => {});
  }
  throw new W.Blocked(`the $${amt(amount)} ${what} made as test data is "${row ? row.status : 'not listed'}" after ${minutes} min, not /${re.source}/ (OneInc has not answered yet)`);
}
const VOIDABLE = /^(Requested|Issued)$/i;

// ── VBR.019 — an earlier First and Final in status Voided ────────────────────────────────────────────────────────
async function voidedFirstAndFinal(page) {
  const { amount } = await pay(page, { via: 'full', txn: 'First and Final', line: 'new', amount: odd() });
  await waitStatus(page, amount, VOIDABLE, 15, 'First and Final');
  await K.openCheck(page, { amount });
  await K.openVoid(page);
  const out = await K.submitVoid(page, 'Automation test - VBR.019 precondition (voided First and Final)', 'No');
  if (!/void submitted/i.test(out)) throw new W.Blocked(`the First and Final made as test data could not be voided: ${out}`);
  const st = await waitStatus(page, amount, /^Voided$/i, 20, 'voided First and Final');
  return K.observe(page, 'Earlier First and Final', `$${amount} First and Final on a new Claim Cost line of exposure (1) — ${st}`);
}
// Quick Payment needs a Financials row: the voided First and Final's line (remaining $0 after the void), else any line of
// exposure (1).
async function openQuickOnVoidedLine(page) {
  try { await X.openQuickOnRow(page, 'claim cost', 'zero', '^\\(1\\)'); return 'Quick Payment opened on the $0 Claim Cost line of exposure (1)'; } catch (e) { if (!(e instanceof W.Blocked)) throw e; }
  await X.openQuickOnRow(page, 'claim cost', 'any', '^\\(1\\)');
  return 'Quick Payment opened on a Claim Cost line of exposure (1)';
}

// ── VBR.022 — an earlier Final Payment in status Rejected (exposure keeps its open reserve) ──────────────────────
async function rejectedFinal(page) {
  const cn = await claimNo(page);
  if (!process.env.CC_TEAM_PASS) throw new W.Blocked('rejecting the Final Payment needs the approver\'s login — pass CC_TEAM_PASS inline (shared TEST password, never stored)');
  // "Pending approval" comes from CC's rule "Approval Required because 'Secondary Named Insured' … not selected for this Insured
  // payment" (CONFIRMED 2026-11-13, policy 1002231610 / VI QUAN) — the adjuster's $100,000 authority never holds a small check.
  const { amount, status } = await pay(page, { via: 'quick', txn: 'Final Payment', payee: 'insured', amount: odd(1) });
  if (!/Pending approval/i.test(status)) throw new W.Blocked(`the $${amount} Final Payment made as test data came out "${status}", not "Pending approval" — the adjuster has the authority, so it cannot be rejected`);
  const FR = require('../financialRules');
  const r = await FR.approveAsAssignee(page, cn, /approv/i, { action: 'Reject' });
  await FR.asStandard(page, cn);
  page.__oneIncUser = undefined;
  const st = (await K.checkRows(page)).filter((x) => amt(x.amount) === amt(amount)).slice(-1)[0];
  if (!st || !/Rejected/i.test(st.status)) throw new W.Blocked(`the $${amount} Final Payment was not rejected (approver ${r.approver || '?'}: ${r.result}; status now "${st ? st.status : 'not listed'}")`);
  return K.observe(page, 'Earlier Final Payment', `$${amount} Final Payment — Rejected by ${r.approver}`);
}

// ── VBR.002 — issued Partial / Supplemental with a Final not yet submitted on the same line ───────────────────────
// Expense lines cannot be reserved on the New Reserve screen as the adjuster (cloud offers only Claim Cost, 2026-11-06):
// the line is made by a vendor First and Final (manualToAuto.buildExpenseRow), then reserved (admin fallback in addReserve).
async function expenseLine(page, { open }) {
  const rows = await X.reserveRows(page).catch(() => []);
  let made = '';
  if (!rows.some((r) => /expense/i.test(r.cost))) made = `${await require('./manualToAuto').buildExpenseRow(page, EXPENSE)}; `;
  if (open && !(await X.reserveRows(page)).some((r) => /expense/i.test(r.cost) && r.remaining > 0)) {
    const err = await X.addReserve(page, await claimNo(page), { costType: EXPENSE, amount: 500 });
    if (err) throw new W.Blocked(`could not reserve the ${EXPENSE} line: ${err}`);
    made += `reserved $500 on the ${EXPENSE} line; `;
  }
  return made;
}
async function reopenLine(page, cost) {
  const rows = await X.reserveRows(page).catch(() => []);
  if (rows.some((r) => new RegExp(cost, 'i').test(r.cost) && r.remaining > 0)) return '';
  const err = await X.addReserve(page, await claimNo(page), { costType: /expense/i.test(cost) ? EXPENSE : 'Claim Cost', amount: 500 });
  if (err) throw new W.Blocked(`could not reserve the ${cost} line back: ${err}`);
  return `reserved $500 back on the ${cost} line; `;
}

// TC-011 / TC-012: issued Partial, then a Final (Create Payment from the same row) left "Awaiting submission". Leaves the
// Partial's Check/Payment Details showing.
async function partialWithFinalAwaiting(page, cost = 'claim cost') {
  let notes = /expense/i.test(cost) ? await expenseLine(page, { open: true }) : await reopenLine(page, cost);
  const partial = await pay(page, { via: 'quick', txn: 'Partial Payment', cost, reserve: 'open' });
  await waitStatus(page, partial.amount, VOIDABLE, 15, 'Partial');
  const final = await pay(page, { via: 'row', txn: 'Final Payment', cost, reserve: 'open', amount: odd() });
  if (!/Awaiting submission/i.test(final.status)) notes += `(the Final came out "${final.status}", not "Awaiting submission") `;
  page.__finalDue = final.amount;
  await K.openCheck(page, { amount: partial.amount });
  return K.observe(page, 'Earlier payments', `${notes}$${partial.amount} Partial (issued) + $${final.amount} Final Payment ${final.status} on the ${cost} line`);
}

// TC-013 / TC-014: close the line (Final ≤ $1 / the expense line's First and Final), issue a Supplemental on it, reserve it
// back, then a $1.4x Final that is held "Pending approval". Leaves the Supplemental's Check/Payment Details showing.
async function supplementalWithFinalPending(page, cost = 'claim cost') {
  let notes = '';
  if (/expense/i.test(cost)) notes += await expenseLine(page, { open: false });
  else {
    await reopenLine(page, cost);
    const closing = await pay(page, { via: 'quick', txn: 'Final Payment', cost, reserve: 'open' });
    notes += `$${closing.amount} Final closed the line; `;
  }
  const supp = await pay(page, { via: 'quick', txn: 'Supplemental Payment', cost, reserve: 'zero' });
  await waitStatus(page, supp.amount, VOIDABLE, 15, 'Supplemental');
  notes += await reopenLine(page, cost);
  const final = await pay(page, { via: 'quick', txn: 'Final Payment', cost, reserve: 'open', payee: 'insured', amount: odd(1) }); // SNI rule → Pending approval
  if (!/Pending approval/i.test(final.status)) throw new W.Blocked(`the $${final.amount} Final Payment came out "${final.status}", not "Pending approval" (the adjuster has the authority)`);
  page.__finalDue = final.amount;
  await K.openCheck(page, { amount: supp.amount });
  return K.observe(page, 'Earlier payments', `${notes}$${supp.amount} Supplemental (issued) + $${final.amount} Final Payment Pending approval on the ${cost} line`);
}

// Cleanup after the VBR.002 cases: delete the Final that was left unsubmitted (reopens nothing it closed) and make sure an
// open Claim Cost reserve remains for the next case.
async function dropFinalDue(page) {
  if (!page.__finalDue) return 'no Final Payment to drop';
  const a = page.__finalDue;
  page.__finalDue = null;
  await K.openCheck(page, { amount: a });
  await K.deleteCheck(page).catch((e) => K.observe(page, 'Cleanup', `could not delete the $${a} Final: ${e.message}`));
  return K.ensureOpenReserve(page);
}

// The check this case just made (checkOps.createFullCheck / manualSweep.openNewCheck → page.__createdCheck) once OneInc has
// issued it; leaves its Check/Payment Details showing. 1008 APD TC-011.
async function awaitIssued(page, minutes = 20) {
  const a = (page.__createdCheck || {}).amount;
  if (!a) throw new Error('awaitIssued: no check was created by this case');
  const st = await waitStatus(page, a, /^Issued$/i, minutes, 'check');
  await K.openCheck(page, { amount: a });
  const s = await readScreen(page);
  const method = (findField(s, 'Confirmed Payment Method') || {}).value || (findField(s, 'ClaimsPay Method') || {}).value || '';
  return K.observe(page, 'Issued check payment method', `${method || '(none shown)'} — $${amt(a)} check ${st}`);
}
// Additional Payment Details › Payment Feedback Received: the newest row's value in `column` (e.g. "Monitored"), written
// as an observation of the same name.
async function feedbackValue(page, column) {
  const v = await page.evaluate((col) => {
    const tables = [...document.querySelectorAll('table')].filter((t) => t.offsetParent && /Feedback Id/.test(t.innerText) && new RegExp(`\\b${col}\\b`).test(t.innerText));
    const t = tables.slice(-1)[0];
    if (!t) return null;
    const rows = [...t.querySelectorAll('tr')].filter((r) => !r.querySelector('tr'));
    const head = rows.find((r) => /Feedback Id/.test(r.innerText));
    if (!head) return null;
    const idx = [...head.children].findIndex((c) => (c.innerText || '').trim() === col);
    const data = rows.filter((r) => r !== head && r.children.length > idx && (r.innerText || '').trim());
    const last = data.slice(-1)[0];
    return last ? ((last.children[idx] || {}).innerText || '').trim() : '';
  }, column);
  return K.observe(page, column, v === null ? 'no Payment Feedback Received table' : v || '(empty — no feedback row yet)');
}

module.exports = { awaitIssued, feedbackValue, pay, waitStatus, voidedFirstAndFinal, openQuickOnVoidedLine, rejectedFinal, partialWithFinalAwaiting, supplementalWithFinalPending, dropFinalDue };
