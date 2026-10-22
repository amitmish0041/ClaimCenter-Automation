/**
 * helpers/oneInc/workerG.js
 * Setup / gate steps for recipes/workerG.js (VBR.032 final payment blocked while another transaction on the reserve
 * line is pending approval; VBR.002 exposure owner info; CPD.002 payment approver contact info). Called from recipes
 * with { call: ['workerG.<fn>', ...args] } → fn(page, ...args). WRITES to automation-owned claims on the TEST tier only.
 * Added 2026-10-21.
 */
'use strict';
const W = require('./wizardDriver');
const { readScreen } = require('./screenReader');

const TIER = (process.env.CC_TIER || 'test').toLowerCase();
function testOnly(what) {
  if (TIER !== 'test') throw new W.Blocked(`${what} writes claim data — allowed on the TEST tier only`);
}

// Financials › Transactions rows: [{ type, amount, exposure, status, user }]. The grid pages 15 rows at a time —
// every page is read.
async function transactions(page) {
  await W.navigate(page, 'transactions');
  await page.locator('tr[id*="TransactionsLV-0-"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const read = () => page.evaluate(() => {
    const grid = [...document.querySelectorAll('table')].find((t) => /Exposure Name/.test(t.innerText || '') && /Status/.test(t.innerText || ''));
    if (!grid) return [];
    const heads = [...grid.querySelectorAll('th, [role=columnheader]')].map((h) => (h.innerText || '').trim()).filter(Boolean);
    return [...grid.querySelectorAll('tr')].filter((r) => !r.querySelector('tr') && r.querySelectorAll('td').length > 4).map((r) => {
      const cells = [...r.querySelectorAll('td')].map((td) => (td.innerText || '').replace(/\s+/g, ' ').trim());
      return { cells, heads };
    });
  });
  const norm = (rows) => parseTxnRows(rows.map((r) => r.cells));
  const out = norm(await read());
  const next = page.locator('[id$="TransactionsLV-_ListPaging-next"]').first();
  for (let p = 0; p < 10; p++) {
    if (!await next.isVisible().catch(() => false) || await next.getAttribute('aria-disabled').catch(() => 'true') === 'true') break;
    const key = JSON.stringify(out.slice(-1));
    await next.click().catch(() => {});
    await W.settle(page, 2500);
    const more = norm(await read());
    if (!more.length || JSON.stringify(more.slice(-1)) === key) break;
    out.push(...more);
  }
  return out;
}

// Transactions grid cells → rows. The grid renders an extra, empty cell between Amount and Exposure (CONFIRMED
// 2026-10-22 on PA-PA-01-26-0748501: [Reserve, date, $600.00, '', 2, (2) 1st Party Vehicle…, Comprehensive, Claim Cost,
// Other, Submitted, Benjamin Smith]) — the columns after Amount are therefore read right-aligned against the 10 headers
// Type | Date | Amount | Exposure | Exposure Name | Coverage | Cost Type | Cost Category | Status | User. Pure.
function parseTxnRows(cellRows) {
  return cellRows.map((cells) => {
    const i = cells.findIndex((c) => /^(Reserve|Payment|Recovery|Recovery Reserve)$/i.test(c));
    const c = i >= 0 ? cells.slice(i) : cells;
    const off = Math.max(0, c.length - 10);
    const at = (k) => (k < 3 ? c[k] : c[k + off]);
    return { type: at(0), date: at(1), amount: at(2), exposure: at(3), name: at(4), status: at(8), user: at(9) };
  }).filter((x) => x.type && /^(Reserve|Payment|Recovery|Recovery Reserve)$/i.test(x.type));
}

const pendingOn = (rows, expo) => rows.filter((r) => /pending approval/i.test(r.status || '') && String(r.exposure) === String(expo));

// Precondition gate: exposure `expo`'s reserve line has (want=true) / has no (want=false) transaction in "Pending
// approval". BLOCKED when the claim says otherwise (the rule could not be exercised).
async function requirePending(page, expo, want = true) {
  const rows = await transactions(page);
  const hits = pendingOn(rows, expo);
  if (want && !hits.length) throw new W.Blocked(`exposure (${expo}) has no transaction in "Pending approval" (Financials › Transactions) — VBR.032 precondition not met`);
  if (!want && hits.length) throw new W.Blocked(`exposure (${expo}) still has ${hits.length} transaction(s) in "Pending approval" — the negative precondition (none pending) is not met`);
  await W.navigate(page, 'summary').catch(() => {});
  return want ? `exposure (${expo}) pending: ${hits.map((h) => `${h.type} ${h.amount} ${h.status} by ${h.user}`).join('; ')}` : `exposure (${expo}): no pending transactions`;
}

// Raises exposure `expo`'s Claim Cost reserve to `amount` (Financials › row options › Edit Reserve) as the logged-in
// adjuster. Above the adjuster's reserve authority (or the policy limit) CC routes it to "Pending approval" — that is
// the VBR.032 precondition. Idempotent: does nothing when the exposure already has a pending transaction. Verifies on
// Financials › Transactions; BLOCKED when the change saved without pending (user has the authority) or did not save.
async function makePendingReserve(page, expo, amount = 250000) {
  testOnly('makePendingReserve');
  let rows = await transactions(page);
  if (pendingOn(rows, expo).length) { await W.navigate(page, 'summary').catch(() => {}); return `exposure (${expo}) already has a pending transaction`; }
  // Cloud: the Financials row menu offers only Quick Payment / Create Payment and Actions › New Transaction has no
  // Reserve item for an adjuster (CONFIRMED 2026-10-22, benjsmit on PA-PA-01-26-0748501). The reserve is raised on its
  // Reserve Details screen instead: Financials › the line's Remaining Reserves amount › the Reserve transaction › Edit
  // (one "$" amount) › Save. An "Edit Reserve" row-menu item is still used when CC offers one.
  const msgs = await setReserveAmount(page, expo, amount);
  rows = await transactions(page);
  const hits = pendingOn(rows, expo);
  if (!hits.length) throw new W.Blocked(`reserve on exposure (${expo}) raised to ${amount} but it did NOT go to "Pending approval" (the logged-in user has the authority)${msgs ? ` — CC said: ${msgs.slice(0, 200)}` : ''}`);
  await W.navigate(page, 'summary').catch(() => {});
  return `exposure (${expo}) reserve raised to ${amount}: ${hits.map((h) => `${h.type} ${h.amount} ${h.status}`).join('; ')}`;
}

// Sets exposure `expo`'s (1-based Financials heading number) reserve line to `amount` — row menu › Edit Reserve, or
// Reserve Details › Edit — and saves past warnings. Returns CC's messages; BLOCKED when it did not save. Shared by
// makePendingReserve and testData D.reserve (raising an EXISTING line: CC offers no Cost Category for a second line of
// the same cost type on an exposure, CONFIRMED 2026-10-22 on HO-PA-01-26-0747949 Contents).
async function setReserveAmount(page, expo, amount) {
  await openRowMenu(page, expo);
  const mi = page.getByRole('menuitem', { name: /^Edit Reserve/ }).first();
  let inp;
  if (await mi.isVisible().catch(() => false)) {
    await mi.click();
    await W.settle(page, 3500);
    inp = page.locator('[id*="EditableReservesLV"] input[type=text]:visible, [id*="ReservesLV"] input[type=text]:visible').first();
  } else {
    await W.closeMenus(page);
    await openReserveDetails(page, expo);
    const edit = page.getByRole('button', { name: 'Edit', exact: true }).first();
    if (!await edit.isVisible().catch(() => false)) throw new W.Blocked(`exposure (${expo}) Reserve Details has no Edit button`);
    await edit.click();
    await W.settle(page, 2500);
    inp = page.getByRole('textbox', { name: '$' }).first();
  }
  if (!await inp.isVisible().catch(() => false)) throw new W.Blocked(`reserve edit screen has no editable amount (${(await readScreen(page)).messages.join(' / ')})`);
  await inp.fill(String(amount));
  await inp.press('Tab').catch(() => {});
  await W.settle(page, 1200);
  let msgs = '';
  for (let i = 0; i < 3; i++) {
    const save = page.getByRole('button', { name: /^(Save|Update)$/ }).first();
    if (!await save.isVisible().catch(() => false)) break;
    await save.click();
    await W.settle(page, 3500);
    const s = await readScreen(page);
    msgs = [...s.messages, s.south].join(' / ');
    if (/error/i.test(msgs) && !/warning/i.test(msgs)) break;
  }
  if (await page.getByRole('button', { name: /^(Save|Update)$/ }).first().isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    await W.settle(page, 2000);
    throw new W.Blocked(`reserve change on exposure (${expo}) was not saved: ${msgs.slice(0, 300) || 'no message'}`);
  }
  return msgs;
}

// Financials summary: open the options menu of the leaf reserve row under the "(expo) …" exposure heading.
async function openRowMenu(page, expo) {
  await W.navigate(page, 'financials');
  await page.getByRole('button', { name: 'options', exact: true }).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const ok = await page.evaluate((expo) => {
    const rows = [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr'));
    let cur = '';
    for (const r of rows) {
      const t = (r.innerText || '').replace(/\s+/g, ' ').trim();
      const m = /^\((\d+)\)/.exec(t);
      if (m) cur = m[1];
      const hasOpt = [...r.querySelectorAll('[role=button]')].some((b) => (b.getAttribute('aria-label') || b.innerText || '').trim() === 'options');
      if (hasOpt && cur === String(expo)) { r.setAttribute('data-workerg-row', 'pick'); return true; }
    }
    return false;
  }, expo);
  if (!ok) throw new W.Blocked(`no Financials reserve row under exposure (${expo})`);
  await page.locator('tr[data-workerg-row="pick"]').getByRole('button', { name: 'options', exact: true }).first().click();
  await W.settle(page, 1200);
}

// A small Partial Payment (Quick Payment from the reserve row whose exposure heading matches `row`, default "(expo) …")
// as the logged-in adjuster that CC holds in "Pending approval" — the VBR.032 precondition where the adjuster cannot
// change reserves. CONFIRMED 2026-10-22: benjsmit has no NewReserveSet permission on cloud ("You do not have the
// permission required to perform this action: NewReserveSet" on Reserve Details › Edit; no Actions › Reserve item),
// but his $1.37 PIP Wage Loss payment on PA-DE-01-25-0746526 exposure (3) went straight to "Pending approval".
// Idempotent; BLOCKED when the payment is submitted without pending (the user has the authority) or is refused.
async function makePendingPayment(page, expo, { row = `^\\(${expo}\\) `, payee = null, amount = '1.37' } = {}) {
  testOnly('makePendingPayment');
  let rows = await transactions(page);
  if (pendingOn(rows, expo).length) { await W.navigate(page, 'summary').catch(() => {}); return `exposure (${expo}) already has a pending transaction`; }
  if (!page.__oneIncParties) await W.getParties(page).catch(() => {});
  await require('./reuseExt').openQuickOnRow(page, 'claim cost', 'open', row);
  try {
    if (payee) await W.selectPayee(page, payee);
    await W.completePaymentsStep(page, { transactionType: 'Partial Payment', amount });
    await W.nextFillingServicePeriod(page);
    await W.answerUnansweredNo(page);
    await W.fillRequiredEmpties(page);
    await W.clickButton(page, 'Finish');
    // Finish may stop on a warnings-only page (e.g. "Policy has been cancelled prior to Loss Date") that saves on a
    // second Finish; an error page leaves the wizard open.
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
    if (await W.inWizard(page)) throw new W.Blocked(`pending-approval payment on exposure (${expo}) was refused: ${msgs.slice(0, 300) || 'no message'}`);
  } finally {
    await W.cancelWizard(page).catch(() => {});
  }
  rows = await transactions(page);
  const hits = pendingOn(rows, expo);
  if (!hits.length) throw new W.Blocked(`the $${amount} payment on exposure (${expo}) was submitted WITHOUT "Pending approval" (the logged-in user has the authority) — no VBR.032 precondition`);
  await W.navigate(page, 'summary').catch(() => {});
  return `exposure (${expo}) $${amount} payment held: ${hits.map((h) => `${h.type} ${h.amount} ${h.status}`).join('; ')}`;
}

// Reserve Details of exposure `expo`'s newest Reserve transaction: Financials › the line's Remaining Reserves amount
// (opens Transactions filtered to that line) › the last "Reserve" link.
async function openReserveDetails(page, expo) {
  // Leave Financials first: a row menu opened there before (Edit Reserve probe) leaves the grid in a state where the
  // amount buttons are not found (CONFIRMED 2026-10-22).
  await W.navigate(page, 'summary').catch(() => {});
  await W.navigate(page, 'financials');
  await page.locator('[id$="-RemainingReserves_button"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const id = await page.evaluate((expo) => {
    let cur = '';
    for (const r of [...document.querySelectorAll('tr')].filter((x) => x.offsetParent && !x.querySelector('tr'))) {
      const m = /^\((\d+)\)/.exec((r.innerText || '').replace(/\s+/g, ' ').trim());
      if (m) cur = m[1];
      const b = r.querySelector('[id$="-RemainingReserves_button"]');
      if (b && cur === String(expo)) return b.id;
    }
    return null;
  }, expo);
  if (!id) throw new W.Blocked(`no Remaining Reserves amount under exposure (${expo}) on Financials`);
  await page.locator(`[id="${id}"]`).click();
  await W.settle(page, 3000);
  const links = page.getByRole('link', { name: 'Reserve', exact: true });
  const n = await links.count();
  if (!n) throw new W.Blocked(`no Reserve transaction listed for exposure (${expo})`);
  await links.nth(n - 1).click();
  await W.settle(page, 3000);
}

// Quick Payment opened from exposure `expo`'s Claim Cost reserve row.
async function openQuickOn(page, expo) {
  return require('./reuseExt').openQuickOnRow(page, 'Claim Cost', 'any', `^\\(${expo}\\)`);
}

module.exports = { transactions, requirePending, makePendingReserve, setReserveAmount, makePendingPayment, openRowMenu, openReserveDetails, openQuickOn, _test: { pendingOn, parseTxnRows } };
