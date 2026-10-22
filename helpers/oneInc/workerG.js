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
  const norm = (rows) => rows.map(({ cells }) => {
    const i = cells.findIndex((c) => /^(Reserve|Payment|Recovery|Recovery Reserve)$/i.test(c));
    const c = i >= 0 ? cells.slice(i) : cells;
    // Type | Date | Amount | Exposure | Exposure Name | Coverage | Cost Type | Cost Category | Status | User
    return { type: c[0], date: c[1], amount: c[2], exposure: c[3], name: c[4], status: c[8], user: c[9] };
  }).filter((x) => x.type);
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
  await openRowMenu(page, expo);
  const mi = page.getByRole('menuitem', { name: /^Edit Reserve/ }).first();
  if (!await mi.isVisible().catch(() => false)) { await W.closeMenus(page); throw new W.Blocked(`exposure (${expo}) reserve row has no Edit Reserve item`); }
  await mi.click();
  await W.settle(page, 3500);
  // Set Reserve screen: one editable "New Available Reserves" amount per line; the line for this exposure is the
  // only one the row menu opens (CONFIRMED 2026-10-21) — fill the first editable amount input.
  const inp = page.locator('[id*="EditableReservesLV"] input[type=text]:visible, [id*="ReservesLV"] input[type=text]:visible').first();
  if (!await inp.isVisible().catch(() => false)) throw new W.Blocked(`Set Reserves screen has no editable amount (${(await readScreen(page)).messages.join(' / ')})`);
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
  rows = await transactions(page);
  const hits = pendingOn(rows, expo);
  if (!hits.length) throw new W.Blocked(`reserve on exposure (${expo}) raised to ${amount} but it did NOT go to "Pending approval" (the logged-in user has the authority)${msgs ? ` — CC said: ${msgs.slice(0, 200)}` : ''}`);
  await W.navigate(page, 'summary').catch(() => {});
  return `exposure (${expo}) reserve raised to ${amount}: ${hits.map((h) => `${h.type} ${h.amount} ${h.status}`).join('; ')}`;
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

// Quick Payment opened from exposure `expo`'s Claim Cost reserve row.
async function openQuickOn(page, expo) {
  return require('./reuseExt').openQuickOnRow(page, 'Claim Cost', 'any', `^\\(${expo}\\)`);
}

module.exports = { transactions, requirePending, makePendingReserve, openRowMenu, openQuickOn, _test: { pendingOn } };
