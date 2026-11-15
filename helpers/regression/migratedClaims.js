/**
 * helpers/regression/migratedClaims.js — claims MIGRATED from on-prem ClaimCenter into cloud (the Cloud migration
 * project's other half: new claims must work, and so must the data that came across). Used by
 * tests/Regression/Migrated.regression.test.js (RX024…).
 *
 * A migrated claim is recognised by its claim number: the 4th segment is the year the claim was opened, and cloud has
 * only filed claims since 2026 ("PA-PA-01-26-0749461"), so anything before 26 came from on-prem ("CCJ-MI-70-16-0568221").
 * Claims are FOUND, never hard-coded: Search › Claims › Advanced Search per Assigned To Group (CC needs a group or user)
 * × Open/Closed (financialClaimSearch.searchClaims), cached per tier for 3 days in
 * results/regression/migrated-claims-<tier>.json. REG_MIGRATED_OPEN / REG_MIGRATED_CLOSED (comma lists) override.
 * Each run takes a different slice of the cache (rotates by day), one claim per claim-number prefix first, so the suite
 * walks across LOBs and branches over time instead of re-reading the same claims.
 *
 * Readers here are read-only. Writes (notes, Edit → Update, reserve, payment, reopen) live in the spec, through the
 * same helpers the new-claim cases use.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('../claimCenterBase');
const W = require('../oneInc/wizardDriver');
const R = require('../financialRules');
const FS = require('../financialClaimSearch');
const { readScreen } = require('../oneInc/screenReader');

const TIER = String(B.TIER || 'test').toLowerCase();
const CACHE = path.join(__dirname, '..', '..', 'results', 'regression', `migrated-claims-${TIER}.json`);
const CLAIM_RE = /\b[A-Z]{2,4}-[A-Z]{2}-\d{2}-\d{2}-\d{7}\b/;
const FIRST_CLOUD_YEAR = 26;

const isMigrated = (cn) => { const y = Number(String(cn).split('-')[3]); return Number.isFinite(y) && y < FIRST_CLOUD_YEAR; };
const prefixOf = (cn) => String(cn).split('-')[0];

function readCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (_) { return null; } }

// Every Assigned To Group × Open / Closed → migrated claim rows. Read-only.
async function scout(page, log = () => {}) {
  await FS.openAdvancedSearch(page);
  const g = (await readScreen(page)).fields.find((f) => f.label === 'Assigned To Group');
  const groups = ((g && g.options) || []).filter((o) => o && !/^<none>$/i.test(o));
  const out = { at: new Date().toISOString(), tier: TIER, open: [], closed: [] };
  for (const group of groups) {
    for (const status of ['Open', 'Closed']) {
      const rows = await FS.searchClaims(page, { group, status }).catch((e) => { log(`migrated scout ${group}/${status}: ${e.message.split('\n')[0]}`); return []; });
      for (const r of rows) {
        if (!isMigrated(r.claim)) continue;
        const list = out[status.toLowerCase()];
        if (!list.some((x) => x.claim === r.claim)) list.push({ claim: r.claim, group, text: r.text });
      }
    }
  }
  if (out.open.length + out.closed.length) {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(out, null, 1));
  }
  log(`migrated scout: ${out.open.length} open, ${out.closed.length} closed across ${groups.length} groups`);
  return out;
}

// n migrated claims of a status ('open' | 'closed'), spread over prefixes, rotating daily. exclude: claims to skip
// (already used this run, or known unusable). Throws Blocked when none are found.
async function pick(page, status, n = 1, { exclude = [], prefix = null, log = () => {} } = {}) {
  const env = process.env[`REG_MIGRATED_${status.toUpperCase()}`];
  let list;
  if (env) list = env.split(',').map((s) => s.trim()).filter(Boolean).map((claim) => ({ claim }));
  else {
    let c = readCache();
    if (!c || Date.now() - Date.parse(c.at) > 3 * 86400e3 || !(c[status] || []).length) c = await scout(page, log);
    list = c[status] || [];
  }
  list = list.filter((x) => !exclude.includes(x.claim) && (!prefix || prefix.test(prefixOf(x.claim))));
  if (!list.length) throw new W.Blocked(`no migrated ${status} claim found on cloud ${TIER}${prefix ? ` with prefix ${prefix}` : ''} (Advanced Search by group; set REG_MIGRATED_${status.toUpperCase()})`);
  const day = Math.floor(Date.now() / 86400e3);
  const rot = list.map((_, i) => list[(i + day * 7) % list.length]);
  // One claim per prefix first (CCJ, PAK, BOP, HP …), then the rest in rotated order.
  const seen = new Set();
  const firsts = [];
  const rest = [];
  for (const x of rot) { const p = prefixOf(x.claim); (seen.has(p) ? rest : firsts).push(x.claim); seen.add(p); }
  return [...new Set([...firsts, ...rest])].slice(0, n);
}

// The NEWEST migrated open claims that still hold money: Advanced Search per group, loss date from `since` (default
// 01/01/2023) and Remaining Reserves between minReserve and maxReserve — newest claim year first (2025 → 2024 → 2023).
// Not cached: a claim a lifecycle case closes or drains drops out of the next search by itself. exclude: claims already
// used this run.
async function pickRecent(page, n = 1, { since = '01/01/2023', minReserve = 5, maxReserve = '', exclude = [], log = () => {} } = {}) {
  await FS.openAdvancedSearch(page);
  const g = (await readScreen(page)).fields.find((f) => f.label === 'Assigned To Group');
  const groups = ((g && g.options) || []).filter((o) => o && !/^<none>$/i.test(o));
  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const found = new Map();
  for (const group of groups) {
    const rows = await FS.searchClaims(page, { group, status: 'Open', date: { type: 'Loss date', from: since, to: today }, money: { type: 'Remaining Reserves', from: String(minReserve), to: String(maxReserve) }, pages: 4 })
      .catch((e) => { log(`recent migrated ${group}: ${e.message.split('\n')[0]}`); return []; });
    for (const r of rows) if (isMigrated(r.claim) && !exclude.includes(r.claim) && !found.has(r.claim)) found.set(r.claim, { ...r, group });
  }
  const seq = (cn) => { const p = String(cn).split('-'); return Number(p[3]) * 1e8 + Number(p[4]); };
  const list = [...found.values()].sort((a, b) => seq(b.claim) - seq(a.claim));
  log(`recent migrated open claims with $${minReserve}${maxReserve ? '–$' + maxReserve : '+'} reserves since ${since}: ${list.length} (${list.slice(0, 8).map((x) => x.claim).join(', ')})`);
  if (!list.length) throw new W.Blocked(`no migrated open claim since ${since} with remaining reserves $${minReserve}${maxReserve ? '–$' + maxReserve : '+'} on cloud ${TIER}`);
  return list.slice(0, n).map((x) => x.claim);
}

// Opens a claim through Advanced Search (the quick search does not open CLOSED claims). Returns the header status.
async function open(page, cn) {
  const st = await FS.openClaimViaSearch(page, cn);
  return st;
}

const header = (page) => page.evaluate(() => {
  const run = (document.body.innerText || '').replace(/\s+/g, ' ');
  const m = run.match(/Pol: (.*?) Claim: (\S+) Ins: (.*?) DoL: (\S+) St: (\w+)(?: Adj: (.*?\)))?/);
  return m ? { policy: m[1], claim: m[2], insured: m[3], lossDate: m[4], status: m[5], adjuster: m[6] || '' } : null;
});

// Every top-level left-nav screen of the open claim: its title, and any error / exception text CC showed on it.
const ERR_RE = /(An? (unexpected )?error (has )?occurred|Server error|NullPointer|Exception:|Problem loading|could not be (loaded|displayed)|unable to display)/i;
async function walk(page) {
  const navs = await page.evaluate(() => [...document.querySelectorAll('[id^="Claim-MenuLinks-Claim_"]')]
    .filter((e) => e.offsetParent && /^Claim-MenuLinks-Claim_[A-Za-z]+$/.test(e.id))
    .map((e) => ({ id: e.id, label: (e.innerText || '').trim().split('\n')[0] })));
  const out = [];
  for (const n of navs) {
    await page.locator(`[id="${n.id}"]`).first().click().catch(() => {});
    await W.settle(page, 2500);
    const info = await page.evaluate((src) => {
      const re = new RegExp(src, 'i');
      const t = document.body.innerText || '';
      const title = [...document.querySelectorAll('.gw-TitleBar--title')].filter((e) => e.offsetParent).map((e) => e.innerText.trim())[0] || '';
      const m = t.match(new RegExp(`.{0,80}${src}.{0,120}`, 'i'));
      return { title, error: re.test(t) && m ? m[0].replace(/\s+/g, ' ') : '' };
    }, ERR_RE.source);
    const msgs = (await R.pageMessages(page)).filter((m) => /error|exception|fail|cannot|unable/i.test(m));
    out.push({ screen: n.label, title: info.title, error: info.error || msgs.join(' / ') });
  }
  return out;
}

// The first visible header-carrying table whose header includes `col` — { head, rows: [[cell…]] }, every page of its
// list pager (…_ListPaging-next). Rows are kept per page, not de-duplicated: two same-day same-amount transactions are
// two rows.
async function table(page, col, { lv = '' } = {}) {
  const read = () => page.evaluate(({ col }) => {
    const vis = (e) => !!e.offsetParent;
    const t = [...document.querySelectorAll('table')].filter(vis).find((x) => !x.querySelector('table') && [...x.querySelectorAll('th, [role=columnheader]')].some((h) => h.innerText.trim() === col));
    if (!t) return null;
    const head = [...t.querySelectorAll('th, [role=columnheader]')].filter(vis).map((h) => h.innerText.trim());
    const rows = [...t.querySelectorAll('tr')].filter((r) => vis(r) && r.querySelector('td'))
      .map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()))
      .filter((cells) => cells.join('') && cells.join('|') !== head.join('|'));
    return { head, rows };
  }, { col });
  await page.locator('th, [role=columnheader]').filter({ hasText: col }).first().waitFor({ timeout: 15000 }).catch(() => {});
  const first = page.locator(`[id*="${lv}"][id$="_ListPaging-first"]`).first();
  if (lv && await first.isVisible().catch(() => false) && await first.isEnabled().catch(() => false)) { await first.click().catch(() => {}); await W.settle(page, 1500); }
  const got = await read();
  if (!got) return { head: [], rows: [] };
  for (let p = 0; lv && p < 40; p++) {
    const next = page.locator(`[id*="${lv}"][id$="_ListPaging-next"]`).first();
    if (!await next.isVisible().catch(() => false) || await next.isDisabled().catch(() => true) || /disabled/.test((await next.getAttribute('class').catch(() => '')) || '')) break;
    const before = JSON.stringify((await read() || {}).rows || []).slice(0, 600);
    await next.click().catch(() => {});
    let moved = false;
    for (let t = 0; t < 20 && !moved; t++) { await page.waitForTimeout(500); moved = JSON.stringify((await read() || {}).rows || []).slice(0, 600) !== before; }
    if (!moved) break;
    got.rows.push(...(await read()).rows);
  }
  return got;
}

// "$1,234.56" → 1234.56, "($1,234.56)" / "-$1.00" → negative, "-" / "" → 0.
const money = (s) => { const t = String(s || '').trim(); if (!t || t === '-') return 0; const m = t.match(/(\()?(-)?\$?([\d,]+\.\d\d)\)?/); return m ? ((m[1] || m[2]) ? -1 : 1) * Number(m[3].replace(/,/g, '')) : 0; };
const r2 = (x) => Math.round(x * 100) / 100;

// Financials › Summary: { head, total: {col: n}, lines: [{ label, values: {col: n} }] } — lines are the exposure rows
// "(1) 1st Party Vehicle - … - Collision" (cost type / category rows below them are not lines).
async function financialSummary(page) {
  await W.navigate(page, 'financials');
  const t = await table(page, 'Net Total Incurred');
  const obj = (r) => Object.fromEntries(t.head.map((h, i) => [h, r[i]]).filter(([h]) => h).map(([h, v]) => [h, money(v)]));
  const tot = t.rows.find((r) => r[0] === 'Claim Total');
  return { head: t.head, total: tot ? obj(tot) : null, lines: t.rows.filter((r) => /^\(\d+\)/.test(r[0])).map((r) => ({ label: r[0], values: obj(r) })), raw: t.rows };
}

// Financials › Transactions (All transaction types), every page: [{ Type, Date, Amount (number), Exposure, Status, … }].
async function transactions(page) {
  await W.navigate(page, 'transactions').catch(async () => { await R.clickMenu(page, /^Financials$/); await R.clickMenu(page, /^Transactions$/); });
  await W.settle(page, 2000);
  const sel = page.locator('select[name$="TransactionsLVRangeInput"]').first();
  if (await sel.isVisible().catch(() => false)) { await sel.selectOption({ label: 'All transaction types' }).catch(() => {}); await W.settle(page, 2000); }
  const t = await table(page, 'Cost Category', { lv: 'TransactionsLV' });
  return t.rows.map((r) => { const o = Object.fromEntries(t.head.map((h, i) => [h || `c${i}`, r[i]])); o.Amount = money(o.Amount); return o; });
}

// Statuses that never reach Total Paid / Recoveries (not yet approved, or refused). "Awaiting submission" DOES count:
// a $1.86 payment in that status was in CCJ-MI-70-16-0568221's Total Paid (2026-11-15); "Pending approval" does not
// (BOP-PA-01-22-0740894's $10.00).
const NOT_POSTED = /^(Pending approval|Rejected|Denied|Draft)$/i;

/**
 * The checks a migrated claim's money must pass. Each: { rule, expected, actual, ok }.
 *  1. Net Total Incurred = Remaining Reserves + Future Payments + Total Paid − Recoveries (claim total and each line).
 *  2. The claim total equals the sum of its exposure lines, column by column.
 *  3. Total Paid = the posted Payment transactions; Recoveries = the posted Recovery transactions (summary vs ledger).
 *  4. No exposure line carries a negative Remaining Reserve.
 *  closed: also Remaining Reserves and Future Payments are 0.
 */
function reconcile(fin, tx, { closed = false } = {}) {
  const out = [];
  if (!fin.total) {
    const empty = !tx.length;
    out.push({ rule: 'Financials summary', expected: empty ? 'no money (no transactions)' : 'a Claim Total row', actual: empty ? 'no Claim Total row — and no transactions' : `no Claim Total row, but ${tx.length} transactions`, ok: empty });
    return out;
  }
  const net = (v) => r2((v['Remaining Reserves'] || 0) + (v['Future Payments'] || 0) + (v['Total Paid'] || 0) - (v.Recoveries || 0));
  const bad = [fin.total, ...fin.lines.map((l) => l.values)].map((v, i) => ({ who: i ? fin.lines[i - 1].label.slice(0, 60) : 'Claim Total', want: net(v), got: r2(v['Net Total Incurred'] || 0) })).filter((x) => Math.abs(x.want - x.got) > 0.009);
  out.push({ rule: 'Net Total Incurred = Remaining + Future + Paid − Recoveries', expected: 'holds on the claim total and every exposure line', actual: bad.length ? bad.map((x) => `${x.who}: ${x.got} vs ${x.want}`).join('; ') : `holds (net ${r2(fin.total['Net Total Incurred'] || 0)})`, ok: !bad.length });
  const cols = Object.keys(fin.total);
  const sumDiff = cols.map((c) => ({ c, tot: r2(fin.total[c] || 0), sum: r2(fin.lines.reduce((s, l) => s + (l.values[c] || 0), 0)) })).filter((x) => Math.abs(x.tot - x.sum) > 0.009);
  // Claim-level money (no exposure) has no "(n)" line, so a difference is only a finding when the ledger has no
  // claim-level transaction to explain it.
  const claimLevel = tx.some((t) => !String(t.Exposure || '').trim());
  out.push({ rule: 'Claim Total = sum of exposure lines', expected: 'equal in every column', actual: sumDiff.length ? sumDiff.map((x) => `${x.c}: total ${x.tot} vs lines ${x.sum}`).join('; ') + (claimLevel ? ' (claim has claim-level transactions)' : '') : `equal across ${fin.lines.length} line(s)`, ok: !sumDiff.length || claimLevel });
  const posted = (type) => r2(tx.filter((t) => t.Type === type && !NOT_POSTED.test(String(t.Status || '').trim())).reduce((s, t) => s + t.Amount, 0));
  const paid = posted('Payment');
  const recovered = posted('Recovery');
  out.push({ rule: 'Total Paid = posted Payment transactions', expected: `$${r2(fin.total['Total Paid'] || 0)}`, actual: `$${paid} over ${tx.filter((t) => t.Type === 'Payment').length} payment row(s)`, ok: Math.abs(paid - r2(fin.total['Total Paid'] || 0)) < 0.01 });
  out.push({ rule: 'Recoveries = posted Recovery transactions', expected: `$${r2(fin.total.Recoveries || 0)}`, actual: `$${recovered} over ${tx.filter((t) => t.Type === 'Recovery').length} recovery row(s)`, ok: Math.abs(recovered - r2(fin.total.Recoveries || 0)) < 0.01 });
  const neg = fin.lines.filter((l) => (l.values['Remaining Reserves'] || 0) < 0);
  out.push({ rule: 'No negative Remaining Reserve on an exposure', expected: 'none', actual: neg.length ? neg.map((l) => `${l.label.slice(0, 60)}: ${l.values['Remaining Reserves']}`).join('; ') : 'none', ok: !neg.length });
  if (closed) {
    const open = r2((fin.total['Remaining Reserves'] || 0) + (fin.total['Future Payments'] || 0));
    out.push({ rule: 'Closed claim holds no open reserve / future payment', expected: '$0', actual: `$${open}`, ok: open === 0 });
  }
  return out;
}

module.exports = { CACHE, CLAIM_RE, isMigrated, prefixOf, scout, pick, pickRecent, open, header, walk, table, money, financialSummary, transactions, reconcile, NOT_POSTED };
