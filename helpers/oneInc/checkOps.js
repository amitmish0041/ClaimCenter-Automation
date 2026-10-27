/**
 * helpers/oneInc/checkOps.js
 * Check/Payment Details helpers for GCCM-787 (Void/Stop) and GCCM-1013 (Check/Payment Details, Additional Payment
 * Details, check delete): find and open a check, create a throw-away check to act on, open the Void Check screen,
 * submit a void, delete a check, and write what happened onto the screen as a read-only "observation" field so the
 * recipe's checks (and the evidence JSON) carry the actual outcome. Called from recipes with
 * { call: ['checkOps.<fn>', ...args] } → fn(page, ...args).
 *
 * Cloud TEST facts (CONFIRMED 2026-10-27):
 *  - Check statuses seen on the TEST claims: "Requesting" (OneInc check sent, never progresses — no External
 *    Identifier, no One Inc Status, empty Workflow History), "Requested" (non-OneInc check: Payment Method "Check",
 *    no ClaimsPay fields — what the Quick Payment wizard creates), "Pending approval", "Pending void". No Issued or
 *    Cleared check exists on any TEST claim, because OneInc never reports back on TEST.
 *  - Void is enabled only on "Requested" checks (disabled on Requesting / Pending void). Check/Payment Details ›
 *    Void opens "Void Check": Reason for Void (required), "Are you reposting this check with the same check number?"
 *    (required Yes/No, no default), the instructional label, and buttons Void Payment / Stop Pay / Cancel.
 *  - Void Payment and Delete ask a native confirm ("Are you sure that you want to void this check?" / "Deleting this
 *    payment will also delete its payments…"); Playwright dismisses dialogs unless told otherwise, which silently
 *    cancels the action — accept it explicitly.
 */
'use strict';
const W = require('./wizardDriver');
const { readScreen, findField } = require('./screenReader');

const TIER = (process.env.CC_TIER || 'test').toLowerCase();
const ALLOW = () => process.env.ONEINC_ALLOW_FINISH === '1' && ['test', 'dev'].includes(TIER);
const gate = (what) => {
  if (!ALLOW()) throw new W.Blocked(`${what} changes TEST data — enable ONEINC_ALLOW_FINISH=1 (test/dev tier) to run it`);
};

// A read-only "field" at the top of the page (same markup screenReader reads), replacing an earlier one of the label.
async function observe(page, label, text) {
  await page.evaluate(({ label, text }) => {
    const id = 'checkops-' + label.replace(/[^A-Za-z0-9]+/g, '-');
    const old = document.getElementById(id);
    if (old) old.remove();
    const d = document.createElement('div');
    d.id = id;
    d.className = 'gw-InputWidget';
    d.style.cssText = 'display:block;position:relative;z-index:99999;background:#fff8c4;border:2px solid #b58900;padding:4px 10px;font:12px sans-serif;';
    d.innerHTML = '<div class="gw-label" style="font-weight:bold"></div><div class="gw-value"><div class="gw-readonly"></div></div>';
    d.querySelector('.gw-label').textContent = label;
    d.querySelector('.gw-readonly').textContent = text;
    document.body.insertBefore(d, document.body.firstChild);
  }, { label, text: String(text).slice(0, 1500) }).catch(() => {});
  return `${label}: ${String(text).slice(0, 200)}`;
}

// ── Finding / opening a check ───────────────────────────────────────────────────────────────────────────────────
// Every row of Financials › Checks/Payments (15 a page, oldest first) → [{ page, i, number, payee, amount, status }].
async function checkRows(page) {
  await W.cancelWizard(page).catch(() => {});
  await W.navigate(page, 'checks');
  await page.locator('tr[id*="ChecksLV-0-"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const readPage = (pg) => page.evaluate((pg) => [...document.querySelectorAll('tr[id*="ChecksLV-"]')]
    .filter((r) => r.offsetParent && !r.querySelector('tr') && /ChecksLV-\d+-/.test(r.id)).map((r) => {
      const cell = (k) => ((r.querySelector(`[id$="-${k}"]`) || {}).innerText || '').trim();
      return { page: pg, i: Number(/ChecksLV-(\d+)-/.exec(r.id)[1]), number: cell('CheckNumber'), payee: cell('PayTo'), amount: cell('GrossAmount'), status: cell('Status'), text: (r.innerText || '').replace(/\s+/g, ' ').trim() };
    }).filter((r) => !/^Check\/Payment Number/.test(r.text)), pg);
  await toPage(page, 1);
  const rows = [...await readPage(1)];
  for (let pg = 2; pg <= 20; pg++) {
    if (!await toPage(page, pg)) break;
    rows.push(...await readPage(pg));
  }
  return rows;
}
const pagingInput = (page) => page.locator('[id$="ChecksLV-_ListPaging-input"]').first();
async function currentPage(page) { return Number(await pagingInput(page).inputValue().catch(() => '1')) || 1; }
async function toPage(page, n) {
  if (await currentPage(page) === n) return true;
  const total = Number(String(await page.locator('[id$="ChecksLV-_ListPaging-postLabel"]').first().innerText().catch(() => '1')).replace(/\D/g, '')) || 1;
  if (n > total) return false;
  const first = await page.locator('tr[id*="ChecksLV-0-"]').first().innerText().catch(() => '');
  if (n === 1) await page.locator('[id$="ChecksLV-_ListPaging-first"]').first().click().catch(() => {});
  else {
    await pagingInput(page).fill(String(n)).catch(() => {});
    await pagingInput(page).press('Enter').catch(() => {});
  }
  for (let t = 0; t < 20; t++) {
    await page.waitForTimeout(500);
    if (await currentPage(page) === n && await page.locator('tr[id*="ChecksLV-0-"]').first().innerText().catch(() => '') !== first) return true;
  }
  return await currentPage(page) === n;
}

const reOf = (v) => (v instanceof RegExp ? v : v ? new RegExp(v, 'i') : null);
// spec: { status, payee, amount, number } (strings are case-insensitive regexes; amount "$1.41" exact) — the NEWEST
// matching check is opened (list order is creation order). Leaves its Check/Payment Details showing.
async function openCheck(page, spec = {}) {
  const rows = await checkRows(page);
  const st = reOf(spec.status);
  // '@insured' = the claim's insured (fresh claims carry different people).
  const py = spec.payee === '@insured' ? new RegExp(((page.__oneIncParties || {}).insured || '^$').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : reOf(spec.payee);
  const want = String(spec.amount || '').replace(/[^0-9.]/g, '');
  const hits = rows.filter((r) => (!st || st.test(r.status)) && (!py || py.test(r.payee || r.text))
    && (!want || String(r.amount).replace(/[^0-9.]/g, '') === want) && (!spec.number || r.number === String(spec.number)));
  const pick = hits.slice(-1)[0];
  if (!pick) {
    const seen = [...new Set(rows.map((r) => r.status))].join(', ') || 'no checks';
    throw new W.Blocked(`no check${spec.status ? ` with status /${st.source}/` : ''}${spec.payee ? ` to /${py.source}/` : ''}${want ? ` for $${want}` : ''} on this claim (statuses on the claim: ${seen})`);
  }
  await toPage(page, pick.page);
  // A check held for approval has no number: its CheckNumber "button" is empty (zero size, CONFIRMED 2026-10-27 — the
  // click timed out), so open it from its Gross Amount link instead.
  const link = page.locator(`[id*="ChecksLV-${pick.i}-CheckNumber_button"]`).first();
  if (pick.number && await link.isVisible().catch(() => false)) await link.click();
  else await page.locator(`tr[id*="ChecksLV-${pick.i}-"]`).first().getByText(pick.amount, { exact: true }).first().click();
  await W.settle(page, 3500);
  page.__check = pick;
  return `opened ${pick.number ? `check ${pick.number}` : 'check (no number yet)'} — ${pick.payee} ${pick.amount}, ${pick.status}`;
}
const openNewestCheck = (page) => openCheck(page, {});

// A "Requested" (non-OneInc) check to act on: the newest one already on the claim that is still Requested, else a new
// $1.4x Quick Payment from an open Claim Cost reserve row (that is what creates them on TEST).
async function ensureVoidableCheck(page, { create = true, txn = 'Partial Payment' } = {}) {
  try {
    return await openCheck(page, { status: '^Requested$' });
  } catch (e) {
    if (!(e instanceof W.Blocked) || !create) throw e;
  }
  const made = await createQuickCheck(page, { txn, requireVoidable: true });
  return `${made}; ${await openCheck(page, { status: '^Requested$', amount: page.__createdCheck.amount })}`;
}

// Quick Payment from a Claim Cost reserve row with remaining reserve, finished (warnings-only pages pressed through).
// Unique odd amount so CC's duplicate-check does not stop it. Records page.__createdCheck = { amount }.
// requireVoidable: the new check must come out "Requested" (voidable); otherwise BLOCKED, naming its status. Whether CC
// sends a Quick Payment to OneInc (Requesting) or not (Requested), or holds it for approval, depends on the claim
// (CONFIRMED 2026-10-27: Requested on PA-PA-01-26-0748443, Requesting / Pending approval on PA-PA-01-26-0748460) —
// deliberately not a claim-level retry, so a case does not leave test checks on every claim of the pool.
async function createQuickCheck(page, { txn = 'Partial Payment', costType = 'claim cost', amount, requireVoidable = false } = {}) {
  gate('Creating a check');
  // A new check reaches "Requested" (voidable) only once OneInc acknowledges it — never on TEST (user confirmation
  // 2026-10-27). Stop before creating a payment that could not be used; ONEINC_VOIDABLE_NEW=1 once OneInc does respond.
  if (requireVoidable && process.env.ONEINC_VOIDABLE_NEW !== '1') {
    throw new W.Blocked('needs a NEW voidable check: a check becomes "Requested" only after OneInc acknowledges it, which OneInc does not do on TEST (the Financials Escalation batch takes it only to Requesting). Set ONEINC_VOIDABLE_NEW=1 once OneInc processes TEST payments.');
  }
  const amt = amount || `1.${41 + Math.floor(Math.random() * 58)}`;
  if (!page.__oneIncParties) await W.getParties(page).catch(() => {});
  if (/claim cost/i.test(costType)) await ensureOpenReserve(page);
  await require('./reuseExt').openQuickOnRow(page, costType, 'open');
  let msgs = '';
  try {
    await W.completePaymentsStep(page, { transactionType: txn, amount: amt });
    await W.nextFillingServicePeriod(page);
    await W.answerUnansweredNo(page);
    for (let r = 0; r < 2; r++) if (!(await W.fillRequiredEmpties(page)).length) break;
    const inv = findField(await readScreen(page), 'Invoice Number/Remarks');
    if (inv && !inv.value) await W.fill(page, 'Invoice Number/Remarks', `ONEINC-${Date.now()}`).catch(() => {});
    await W.clickButton(page, 'Finish');
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
    if (await W.inWizard(page)) throw new W.Blocked(`the $${amt} Quick Payment used as test data was refused: ${msgs.slice(0, 300) || 'no message'}`);
  } finally {
    await W.cancelWizard(page).catch(() => {});
  }
  let row = (await checkRows(page)).filter((r) => String(r.amount).replace(/[^0-9.]/g, '') === amt).slice(-1)[0];
  // A new check waits in "Awaiting submission" until the Financials Escalation batch runs (then it becomes Requested).
  if (requireVoidable && row && /Awaiting submission/i.test(row.status)) {
    await escalateChecks(page, amt);
    row = (await checkRows(page)).filter((r) => String(r.amount).replace(/[^0-9.]/g, '') === amt).slice(-1)[0];
  }
  page.__createdCheck = { amount: amt, txn, status: row ? row.status : '' };
  if (requireVoidable && (!row || !/^Requested$/i.test(row.status))) {
    throw new W.Blocked(`the ${amt} ${txn} Quick Payment made as test data came out "${row ? row.status : 'not listed'}", not "Requested", so it cannot be voided on this claim (needs a claim whose Quick Payments are not sent to OneInc, and a user with the authority)`);
  }
  return `created a ${amt} ${txn} Quick Payment as test data (status ${row ? row.status : '?'})`;
}

// Full Check wizard payment to a claim contact, finished: payee (wizardDriver.selectPayee key) + optional payee Type and
// joint payees, open reserve line, minimum payment details, Finish (warnings-only pages pressed through). Used to make
// a OneInc check to look at on Check/Payment Details. Records page.__createdCheck = { amount }.
async function createFullCheck(page, { payee = 'claimant', type, joint, amount } = {}) {
  gate('Creating a check');
  const amt = amount || `1.${41 + Math.floor(Math.random() * 58)}`;
  if (!page.__oneIncParties) await W.getParties(page).catch(() => {});
  await W.openPayment(page, 'actions', { needOpenReserve: true });
  let msgs = '';
  try {
    await W.selectPayee(page, payee);
    if (type) await W.select(page, 'Type', type);
    if (joint) await W.addJointPayees(page, joint);
    await W.nextFillingServicePeriod(page);
    await W.selectReserveLine(page, 'open');
    await W.completePaymentsStep(page, { amount: amt });
    await W.nextFillingServicePeriod(page);
    await W.answerUnansweredNo(page);
    for (let r = 0; r < 2; r++) if (!(await W.fillRequiredEmpties(page)).length) break;
    await W.clickButton(page, 'Finish');
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
    if (await W.inWizard(page)) throw new W.Blocked(`the $${amt} payment used as test data was refused: ${msgs.slice(0, 300) || 'no message'}`);
  } finally {
    await W.cancelWizard(page).catch(() => {});
  }
  page.__createdCheck = { amount: amt };
  return `created a $${amt} Full Check payment to the ${payee}${joint ? ' with joint payee(s)' : ''} as test data${msgs ? ` (warnings at Finish: ${msgs.slice(0, 200)})` : ''}`;
}

// Opens the newest check matching spec; when there is none, creates one with createFullCheck(createOpts) and opens it.
async function openOrCreateCheck(page, spec, createOpts = {}) {
  try {
    return await openCheck(page, spec);
  } catch (e) {
    if (!(e instanceof W.Blocked)) throw e;
  }
  const made = await createFullCheck(page, createOpts);
  return `${made}; ${await openCheck(page, { ...spec, status: undefined, amount: page.__createdCheck.amount })}`;
}

// After a test that paid a Final Payment: when no Claim Cost reserve row has money left, add $1,000 back so the claim
// stays usable for the cases that need an open reserve.
async function ensureOpenReserve(page) {
  const claim = await page.evaluate(() => ((document.body.innerText || '').match(/Claim:\s*([A-Z]{2,4}-[A-Z]{2}-[\d-]+)/) || [])[1] || '');
  const rows = await require('./reuseExt').reserveRows(page).catch(() => []);
  if (rows.some((r) => /claim cost/i.test(r.cost) && r.remaining > 0)) return 'an open Claim Cost reserve remains';
  gate('Adding a reserve');
  const err = await require('./reuseExt').addReserve(page, claim, { costType: 'Claim Cost', amount: 1000 });
  return err ? `could not add a reserve back: ${err}` : 'added a $1,000 Claim Cost reserve back (the Final Payment closed the line)';
}

// Clicks a checkbox by its accessible name (e.g. "Do you want to edit the Mailing Address?").
async function toggle(page, name) {
  await page.getByRole('checkbox', { name, exact: true }).first().click();
  await W.settle(page, 2500);
  return `toggled "${name}"`;
}

// ── Batch: Financials Escalation ────────────────────────────────────────────────────────────────────────────────
// New checks sit in "Awaiting submission" until the "Financials Escalation" batch (Server Tools › Batch Process Info —
// "escalates checks from Awaiting-submission status to Requesting status so that the downstream system will be
// alerted") runs; after it, a non-OneInc check reaches "Requested" and only then can it be voided (user direction
// 2026-10-27: run the batch before the cases that need it). On TEST the batch has no schedule, so it is run here: in a
// separate browser context logged in as the admin user (CC_ADMIN_USER / CC_ADMIN_PASS — Server Tools needs it), then the
// claim's checks are polled until none of the given amount is still Awaiting submission.
async function runFinancialsEscalation(page) {
  gate('Running the Financials Escalation batch');
  const user = process.env.CC_ADMIN_USER;
  const pass = process.env.CC_ADMIN_PASS;
  if (!user || !pass) throw new W.Blocked('run the "Financials Escalation" batch first (Server Tools › Batch Process Info) — CC_ADMIN_USER / CC_ADMIN_PASS are not set, so the automation cannot run it');
  const ctx = await page.context().browser().newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  try {
    await require('../claimCenterBase').loginToClaimCenter(p, { username: user, password: pass });
    await p.keyboard.press('Alt+Shift+T');
    await W.settle(p, 4000);
    const info = p.getByText('Batch Process Info', { exact: true }).first();
    if (!await info.isVisible().catch(() => false)) throw new W.Blocked(`run the "Financials Escalation" batch first — Server Tools did not open for ${user}`);
    await info.click();
    await W.settle(p, 4000);
    const row = p.locator('tr').filter({ hasText: /^\s*Financials Escalation/ }).first();
    const lastRun = async () => ((await row.innerText().catch(() => '')).match(/(\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d [AP]M)\s+(\w+)/) || []).slice(1).join(' ');
    const before = await lastRun();
    await row.getByRole('button', { name: 'Run', exact: true }).first().click();
    for (let t = 0; t < 60; t++) {
      await p.waitForTimeout(3000);
      await p.getByRole('button', { name: 'Refresh', exact: true }).first().click().catch(() => {});
      await W.settle(p, 1500);
      const now = await lastRun();
      if (now && now !== before && /Completed|Failed/i.test(now)) return `Financials Escalation batch run as ${user}: ${now}`;
    }
    return `Financials Escalation batch started as ${user} (completion not confirmed within 3 minutes; last run ${await lastRun()})`;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// Runs the batch, then polls the claim's checks until the one(s) of `amount` (default: the check this case created)
// leave "Awaiting submission". Leaves the Checks list showing.
async function escalateChecks(page, amount) {
  const msg = await runFinancialsEscalation(page);
  const want = String(amount || (page.__createdCheck || {}).amount || '').replace(/[^0-9.]/g, '');
  let rows = [];
  for (let t = 0; t < 12; t++) {
    rows = (await checkRows(page)).filter((r) => !want || String(r.amount).replace(/[^0-9.]/g, '') === want);
    if (rows.length && !rows.some((r) => /Awaiting submission/i.test(r.status))) break;
    await page.waitForTimeout(10000);
  }
  return `${msg}; check(s) now: ${rows.map((r) => `${r.number || '(no number)'} ${r.amount} ${r.status}`).join(', ') || 'none found'}`;
}

// Writes "<label> length" = number of characters the field holds now (e.g. whether an input caps Pay To at 200).
async function fieldLength(page, label) {
  const f = findField(await readScreen(page), label);
  return observe(page, `${label} length`, f ? String((f.value || '').length) : 'field not on the screen');
}

// ── Void / Stop ─────────────────────────────────────────────────────────────────────────────────────────────────
const voidBtn = (page) => page.getByRole('button', { name: 'Void', exact: true }).first();
const onVoidScreen = (page) => page.getByRole('button', { name: 'Void Payment', exact: true }).first().isVisible().catch(() => false);

// Writes "Void button" = enabled | disabled | not shown (Check/Payment Details) for a check.
async function voidButtonState(page) {
  const b = voidBtn(page);
  const state = !await b.isVisible().catch(() => false) ? 'not shown' : (await b.isDisabled().catch(() => false)) ? 'disabled' : 'enabled';
  const status = (findField(await readScreen(page), 'Status') || {}).value || '';
  return observe(page, 'Void button', `${state} (check status "${status}")`);
}

async function openVoid(page) {
  const b = voidBtn(page);
  if (!await b.isVisible().catch(() => false)) throw new W.Blocked('Check/Payment Details has no Void button');
  if (await b.isDisabled().catch(() => false)) {
    const status = (findField(await readScreen(page), 'Status') || {}).value || '?';
    throw new W.Blocked(`Void is disabled for this check (status "${status}")`);
  }
  await b.click();
  await W.settle(page, 3500);
  // The Void Check screen can take a while on TEST (CONFIRMED 2026-10-27: still on Check/Payment Details after 3.5s).
  await page.getByRole('button', { name: 'Void Payment', exact: true }).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  if (!await onVoidScreen(page)) throw new Error('Void did not open the Void Check screen within 20s');
  const s = await readScreen(page);
  const q = s.fields.find((f) => /reposting this check/i.test(f.label));
  const checked = q && (q.radios || []).find((r) => r.checked);
  await observe(page, 'Reposting answer when the screen opens', checked ? checked.label : 'none selected');
  return 'opened the Void Check screen';
}

// Fills the Void Check screen and presses Void Payment (accepting CC's confirm). reason '' leaves it blank; repost
// 'Yes' | 'No' | null (null = leave unanswered). Writes "Void outcome": refused + messages, or the new check status.
async function submitVoid(page, reason = 'Automation test - issued in error', repost = 'No') {
  gate('Submitting a void');
  if (!await onVoidScreen(page)) await openVoid(page);
  const box = page.locator('.gw-InputWidget').filter({ hasText: 'Reason for Void' }).locator('input, textarea').first();
  await box.fill(reason || '').catch(() => {});
  if (repost) await page.getByRole('radio', { name: repost, exact: true }).first().click().catch(() => {});
  await W.settle(page, 1000);
  let dialog = '';
  const accept = async (d) => { dialog = d.message(); await d.accept().catch(() => {}); };
  page.once('dialog', accept);
  await page.getByRole('button', { name: 'Void Payment', exact: true }).first().click();
  await W.settle(page, 4500);
  page.off('dialog', accept);
  let outcome;
  if (await onVoidScreen(page)) {
    const s = await readScreen(page);
    const text = [...s.messages, s.south].filter(Boolean).join(' / ');
    // An authority limit of the logged-in user is not a verdict on any void rule (CONFIRMED 2026-10-27 on check
    // 12830413: "You don't have the authority to submit this item for approval").
    if (/don't have the authority/i.test(text)) throw new W.Blocked(`the logged-in user may not void this check: ${text.slice(0, 200)}`);
    outcome = `refused — still on Void Check: ${text || 'no message'}`;
  } else {
    const s = await readScreen(page);
    outcome = `void submitted — check status now "${(findField(s, 'Status') || {}).value || '?'}"${s.messages.length ? `; messages: ${s.messages.join(' / ')}` : ''}`;
  }
  return observe(page, 'Void outcome', `${outcome}${dialog ? ` (confirm: "${dialog.replace(/\s+/g, ' ')}")` : ''}`);
}

async function cancelVoid(page) {
  if (await onVoidScreen(page)) await W.clickButton(page, 'Cancel');
  return 'left the Void Check screen with Cancel';
}

// ── Delete / Additional Payment Details / Approval History ──────────────────────────────────────────────────────
async function deleteCheck(page) {
  gate('Deleting a check');
  const s0 = await readScreen(page);
  const who = (findField(s0, 'Pay To The Order Of') || {}).value || '';
  const amt = (findField(s0, 'Amount') || {}).value || '';
  const num = (findField(s0, 'Payment Number') || {}).value || '';
  page.__deleted = { payee: who, amount: amt, number: num, at: new Date().toISOString() };
  let dialog = '';
  const accept = async (d) => { dialog = d.message(); await d.accept().catch(() => {}); };
  page.once('dialog', accept);
  await W.clickButton(page, 'Delete');
  await W.settle(page, 3000);
  page.off('dialog', accept);
  const still = await page.getByRole('button', { name: 'Delete', exact: true }).first().isVisible().catch(() => false);
  return observe(page, 'Delete outcome', `${still ? 'NOT deleted (still on Check/Payment Details)' : 'deleted'} — ${who} ${amt}${num ? ` check ${num}` : ' (no check number)'}${dialog ? ` (confirm: "${dialog.replace(/\s+/g, ' ')}")` : ''}`);
}

async function openAPD(page) {
  await W.clickButton(page, 'Additional Payment Details');
  return 'opened Additional Payment Details';
}

async function approvalHistory(page) {
  const s = await readScreen(page);
  const i = s.body.indexOf('Approval History');
  const j = s.body.indexOf('Payments Date', i);
  return observe(page, 'Approval History', i < 0 ? 'section not shown' : s.body.slice(i + 'Approval History'.length, j > i ? j : i + 400).replace(/^\s*Date User Action Issue Rationale\s*/, '').trim() || 'empty');
}

// ── Workplan / History ──────────────────────────────────────────────────────────────────────────────────────────
async function listRows(page) {
  return page.evaluate(() => [...document.querySelectorAll('tr[id*="LV-"]')].filter((r) => r.offsetParent && !r.querySelector('tr'))
    .map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
}
async function openNav(page, id) {
  await W.cancelWizard(page).catch(() => {});
  await page.locator(`[id="${id}"]`).first().click();
  await W.settle(page, 4000);
}
// Workplan rows (Due Priority Status Subject …) → observation "Workplan activities".
async function workplan(page) {
  await openNav(page, 'Claim-MenuLinks-Claim_ClaimWorkplan');
  const rows = (await listRows(page)).filter((r) => !/^Due Priority/.test(r));
  page.__workplan = rows;
  return observe(page, 'Workplan activities', rows.join(' | ') || 'none');
}
// Remembers the open activities now; activitiesClosedSince() reports which of them are no longer open.
async function snapshotActivities(page) {
  await workplan(page);
  page.__openActivities = page.__workplan.filter((r) => /\bOpen\b/.test(r));
  return `${page.__openActivities.length} open activities noted`;
}
async function activitiesClosedSince(page) {
  await workplan(page);
  const now = page.__workplan;
  const gone = (page.__openActivities || []).filter((r) => !now.includes(r));
  return observe(page, 'Open activities no longer open', gone.join(' | ') || 'none');
}
// Claim History (newest first) → observation "Claim history".
async function history(page) {
  await openNav(page, 'Claim-MenuLinks-Claim_ClaimHistory');
  const rows = (await listRows(page)).filter((r) => !/^Type Related To/.test(r));
  return observe(page, 'Claim history', rows.slice(0, 25).join(' | ') || 'none');
}

// History rows now (remembered) / rows that appeared since historyMark → observation "New history events". The list is
// newest first and has no ids, so "new" = rows whose text was not in the snapshot.
async function historyMark(page) {
  await openNav(page, 'Claim-MenuLinks-Claim_ClaimHistory');
  page.__historyRows = (await listRows(page)).filter((r) => !/^Type Related To/.test(r));
  return `${page.__historyRows.length} History rows noted`;
}
async function historySince(page) {
  await openNav(page, 'Claim-MenuLinks-Claim_ClaimHistory');
  const before = new Set(page.__historyRows || []);
  const rows = (await listRows(page)).filter((r) => !/^Type Related To/.test(r) && !before.has(r) && !/^Viewed\b/.test(r));
  return observe(page, 'New history events', rows.join(' | ') || 'none');
}

// Cleanup after a case that pressed Finish once: deletes held (Pending approval) checks to the given payee(s) created
// in the last 30 minutes of this session's run; does nothing when there is none. Never fails the case.
async function deletePendingIfAny(page, payee) {
  try {
    await W.cancelWizard(page).catch(() => {});
    const rows = (await checkRows(page)).filter((r) => /^Pending approval$/i.test(r.status) && new RegExp(payee, 'i').test(r.payee || r.text));
    if (!rows.length) return 'no held check to clean up';
    await openCheck(page, { status: '^Pending approval$', payee });
    const created = (findField(await readScreen(page), 'Created On') || {}).value || '';
    const t = Date.parse(created);
    if (Number.isFinite(t) && Date.now() - t > 30 * 60 * 1000) return `newest held check was created ${created} — not this case's, left alone`;
    if (!ALLOW()) return 'held check left (ONEINC_ALLOW_FINISH not set)';
    return await deleteCheck(page);
  } catch (e) {
    return `cleanup skipped: ${e.message.split('\n')[0]}`;
  }
}

module.exports = {
  historyMark, historySince, deletePendingIfAny,
  observe, checkRows, openCheck, openNewestCheck, ensureVoidableCheck, createQuickCheck, createFullCheck, openOrCreateCheck,
  ensureOpenReserve, toggle, fieldLength, runFinancialsEscalation, escalateChecks, voidButtonState, openVoid, submitVoid,
  cancelVoid, deleteCheck, openAPD, approvalHistory, workplan, snapshotActivities, activitiesClosedSince, history,
};
