/**
 * helpers/oneInc/portal.js — the OneInc (ProcessOne) staging Admin Portal, read-only, for the OneInc-side half of the
 * OneInc cases: what ClaimCenter sent (payload fields) and what OneInc did with it (status, paid date, method, tracking…).
 *
 * The portal sits behind Cloudflare Access + OneInc's Microsoft sign-in and an e-mailed one-time link, so a PERSON signs
 * in once in the long-lived window started by scripts/oneIncPortalSession.js; everything here attaches to that window
 * over its DevTools port (ONEINC_PORTAL_CDP_PORT, default 9333) — no login, no credentials (user direction 2026-11-11).
 *
 * CONFIRMED 2026-11-11 (merchant "Donegal Mutual Insurance Company"): ClaimCenter TEST payments are on the portal from the
 * moment they are sent (Created Date = CC send time), keyed by CR Tracking Number = the CC check's "Payment Identifier"
 * (cc-<uuid>); Issued came back to ClaimCenter after OneInc's release run (11/06 checks → Issued 11/09 00:30 PST).
 * The detail panel ("General Info") is read-only — no stop / cancel actions.
 *
 *   const P = require('./portal');
 *   await P.payments({ claim: 'HO-PA-01-26-0749093' })     → [{ crTracking, status, amount, claim, … }]
 *   await P.payment({ crTracking: 'cc-…' })                → { 'Status': 'Issued', 'Additional Text Field 14': '…', … }
 */
'use strict';

const PORT = Number(process.env.ONEINC_PORTAL_CDP_PORT || 9333);
const HOME = 'https://processonestg.processonepayments.com/UI/Reports';

class PortalUnavailable extends Error {}

let cached = null;
async function page() {
  if (cached && !cached.isClosed()) return cached;
  const { chromium } = require('playwright');
  let browser;
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 10000 }); } catch (e) {
    throw new PortalUnavailable(`OneInc portal window not running — start it (node scripts/oneIncPortalSession.js) and sign in once (${e.message.split('\n')[0]})`);
  }
  const ctx = browser.contexts()[0];
  const pg = ctx && ctx.pages().find((p) => /processone(stg)?\.processonepayments\.com\/UI\//i.test(p.url()));
  if (!pg) {
    const any = ctx && ctx.pages()[0];
    if (any) { await any.goto(HOME, { waitUntil: 'domcontentloaded' }).catch(() => {}); await any.waitForTimeout(3000); }
    if (!any || !/\/UI\//.test(any.url())) throw new PortalUnavailable(`OneInc portal is not signed in (window at ${any ? any.url() : 'no page'}) — sign in again in the portal window`);
    cached = any;
  } else cached = pg;
  return cached;
}

const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

// Disbursements › Payments search. Any of claim / crTracking / checkNumber; every method and status; Created Date from
// `since` (at most 90 days back — the portal's limit is 93). Returns the grid rows as { header: value } objects (header text as the portal shows it).
async function payments({ claim = '', crTracking = '', checkNumber = '', since } = {}) {
  const p = await page();
  if (!/\/UI\//.test(p.url())) await p.goto(HOME, { waitUntil: 'domcontentloaded' });
  await p.getByText('CLOSE', { exact: true }).first().click({ timeout: 1000 }).catch(() => {});
  // The search form is a modal: open it unless it already is (EDIT SEARCH on a results page, else the header button).
  if (!await p.locator('#PaymentsWidgetClaimNumber').isVisible().catch(() => false)) {
    const edit = p.locator('#EditSearchButton');
    if (await edit.isVisible().catch(() => false)) await edit.click(); else await p.locator('#search-widget-button').click();
  }
  await p.locator('#PaymentsWidgetClaimNumber').waitFor({ state: 'visible', timeout: 15000 });
  // The portal refuses a range over 93 days ("Duration between Date From and Date To cannot exceed 93 calendar days") and
  // then silently keeps the previous results — 90 days back at most (CONFIRMED 2026-11-11).
  const floor = Date.now() - 90 * 864e5;
  const from = fmt(new Date(Math.max(floor, since ? new Date(since).getTime() : floor)));
  // Text criteria must be TYPED — a value set from script is ignored by the search (CONFIRMED 2026-11-11: 586 rows back).
  // Filling one of Claim # / CR Tracking # / Check # disables the others, so clear every enabled one first (repeat: a
  // cleared box re-enables its siblings), then type the one(s) given.
  const boxes = [['#PaymentsWidgetClaimNumber', claim], ['#PaymentsWidgetCrTracking', crTracking], ['#PaymentsWidgetTransactionIdCheckNumber', checkNumber]];
  const type = async (id, v) => { await p.fill(id, v); await p.press(id, 'Tab').catch(() => {}); }; // Tab fires the box's change
  for (let r = 0; r < 2; r++) for (const [id] of boxes) if (await p.locator(id).isEnabled().catch(() => false)) await type(id, '');
  for (const [id, v] of boxes) if (v) await type(id, v);
  await p.evaluate(({ from }) => {
    const $ = window.jQuery;
    const date = document.querySelector('#PaymentsWidgetDateFrom');
    const dp = $ && $(date).data('kendoDatePicker'); if (dp) dp.value(from); date.value = from; date.dispatchEvent(new Event('change', { bubbles: true }));
    for (const id of ['PaymentsWidgetPaymentMethods', 'PaymentsWidgetPaymentStatuses']) {
      const s = document.getElementById(id); for (const o of s.options) o.selected = true;
      const ms = $ && $(s).data('kendoMultiSelect'); if (ms) ms.value([...s.options].map((o) => o.value));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, { from });
  // SEARCH reloads the results page — wait for that load, or the previous search's grid is read (CONFIRMED 2026-11-11).
  await Promise.all([p.waitForEvent('load', { timeout: 60000 }).catch(() => {}), p.locator('button.widget-search-button:visible').first().click()]);
  await p.waitForFunction(() => window.jQuery && jQuery('.k-grid').data('kendoGrid') && !document.querySelector('.k-loading-mask'), null, { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(2500);
  return p.evaluate(() => {
    const g = jQuery('.k-grid').data('kendoGrid');
    if (!g) return [];
    const hdr = [...g.thead.find('th')].map((th) => th.innerText.trim());
    return [...g.tbody.find('tr')].map((tr) => {
      const td = [...tr.querySelectorAll('td')].map((x) => x.innerText.trim());
      const o = {}; hdr.forEach((h, i) => { if (h) o[h] = td[i] || ''; }); return o;
    }).filter((o) => o['CR TRACKING NUMBER']);
  });
}

// One payment's "General Info" panel as { label: value }. Finds it by CR Tracking (preferred) / check number / claim
// (+ amount to pick among several on the claim).
async function payment({ crTracking = '', checkNumber = '', claim = '', amount = '' } = {}) {
  const rows = await payments({ crTracking, checkNumber, claim });
  const want = String(amount || '').replace(/[^0-9.]/g, '');
  const row = rows.find((r) => (!crTracking || r['CR TRACKING NUMBER'] === crTracking) && (!want || String(r.AMOUNT).replace(/[^0-9.]/g, '') === Number(want).toFixed(2)));
  if (!row) return null;
  const p = await page();
  await p.locator('tr', { hasText: row['CR TRACKING NUMBER'] }).first().locator('td').last().click();
  await p.getByText('General Info', { exact: true }).first().waitFor({ timeout: 20000 });
  await p.waitForTimeout(1200);
  const info = await p.evaluate(() => {
    // Label/value pairs of the detail panel: each label element is followed by its value.
    const out = {};
    const panel = [...document.querySelectorAll('div,section')].filter((d) => d.offsetParent && /General Info/.test(d.innerText || '') && /CR Tracking Number/.test(d.innerText || ''))
      .sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!panel) return out;
    const lines = panel.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
    const labels = ['CR Tracking Number', 'Created Date', 'Release Date', 'Paid Date', 'Cleared Date', 'Stale Date', 'Escheat Date', 'Date Modified', 'Payment Method',
      'Original Payment Method', 'Payment Type', 'Selection Type', 'System Instance', 'Insured First Name', 'Insured Last Name', 'CoInsured First Name', 'CoInsured Last Name',
      'Lienholder Mortgagee Name', 'Status', 'Bank Account', 'Carrier ID', 'Amount', 'Claim Number', 'Non-Claim Id', 'Policy Number', 'Payment Method Last 4',
      'Transaction ID/Check #', 'Routing Number', 'Vendor Name', 'Vendor TIN', 'Business ID', 'Vendor Email', 'Vendor Payment Delivery Method', 'Reject Payee ID',
      'Reject Reason', 'Monitored', 'Mail Tracking Number', 'Error Code', 'Error Message', 'Merchant', 'Adjuster ID', 'Adjuster',
      ...Array.from({ length: 15 }, (_, i) => `Additional Text Field ${i + 1}`), 'Expedite', 'Certified', 'PrintNow', 'Invoice Number', "Insured's Email",
      "Coinsured's Email", 'Payment Mailing Address', 'Primary Contact Phone', 'Secondary Contact Phone', 'Account Type', 'Bank Name'];
    const isLabel = new Set(labels);
    for (let i = 0; i < lines.length; i++) {
      if (!isLabel.has(lines[i])) continue;
      out[lines[i]] = lines[i + 1] && !isLabel.has(lines[i + 1]) && !/^(CLOSE|Print PDF)$/.test(lines[i + 1]) ? lines[i + 1] : '';
    }
    return out;
  });
  await p.getByText('CLOSE', { exact: true }).first().click().catch(() => {});
  return info;
}

// Reports › Business/Vendor Report (UI/BusinessVendorReport): vendors OneInc received through CreateVendor (ContactManager
// vendors — BAIKOW LEGAL LLC is BusinessID "ab:145846", Tin "020725566", CONFIRMED 2026-11-11). Opened in its own tab of
// the signed-in window so a payment search in progress is not disturbed. Returns the raw rows ({ BusinessName, Tin,
// BusinessID, BillingStreet, City, BillingState, BillingPostalCode, DateModified, … }).
async function vendors({ name = '', tin = '' } = {}) {
  const main = await page();
  const tab = await main.context().newPage();
  try {
    await tab.goto(HOME.replace(/\/UI\/Reports$/, '/UI/BusinessVendorReport'), { waitUntil: 'domcontentloaded' });
    await tab.locator('#SearchButton').waitFor({ timeout: 30000 });
    await tab.fill('#BusinessName', name);
    await tab.fill('#Tin', tin);
    await tab.click('#SearchButton');
    await tab.waitForTimeout(3000);
    await tab.waitForFunction(() => window.jQuery && jQuery('.k-grid').data('kendoGrid') && !document.querySelector('.k-loading-mask'), null, { timeout: 60000 }).catch(() => {});
    return await tab.evaluate(() => { const g = jQuery('.k-grid').data('kendoGrid'); return g ? g.dataSource.data().toJSON() : []; });
  } finally { await tab.close().catch(() => {}); }
}

module.exports = { page, payments, payment, vendors, PortalUnavailable };
