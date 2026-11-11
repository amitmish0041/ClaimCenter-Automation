/**
 * helpers/oneInc/portalChecks.js — recipe steps that put OneInc-side facts (helpers/oneInc/portal.js, the signed-in staging
 * Admin Portal) on the ClaimCenter page as read-only observed fields (checkOps.observe), so ordinary V() checks judge
 * them and the case screenshot carries the evidence. Read-only on both sides.
 */
'use strict';

const W = require('./wizardDriver');
const P = require('./portal');
const { observe } = require('./checkOps');

const claimNo = (page) => page.evaluate(() => ((document.body.innerText || '').match(/Claim:\s*([A-Z]{2,4}-[A-Z]{2}-[\d-]+)/) || [])[1] || '');

// Claim › Policy › "Underwriting Company" → observed field "Claim Underwriting Company".
async function underwritingCompany(page) {
  await W.cancelWizard(page).catch(() => {});
  await page.locator('[id="Claim-MenuLinks-Claim_ClaimPolicyGroup"]').first().click();
  await W.settle(page, 2500);
  const v = await page.evaluate(() => {
    const m = /Underwriting Company\s+(.+?)\s+(Insured Name|Insured|Address|Policy Type|$)/.exec((document.body.innerText || '').replace(/\s+/g, ' '));
    return m ? m[1].trim() : '';
  });
  if (!v) throw new W.Blocked('the claim\'s Policy screen shows no Underwriting Company');
  page.__oneIncUwCompany = v;
  return observe(page, 'Claim Underwriting Company', v);
}

// The claim's ClaimCenter payment on the OneInc portal (CR Tracking cc-…), newest first, optionally the one for `amount`;
// waits up to `waitMin` minutes for a just-sent payment to appear. Each of `fields` (portal labels, e.g. "Additional Text
// Field 13") becomes an observed field "OneInc <label>"; "OneInc payment" summarises which payment was read.
async function oneIncPayment(page, { fields = [], amount = '', waitMin = 0 } = {}) {
  const claim = await claimNo(page);
  if (!claim) throw new W.Blocked('no claim number on the screen');
  const want = String(amount || '').replace(/[^0-9.]/g, '');
  const deadline = Date.now() + waitMin * 60e3;
  let rows = [];
  for (;;) {
    try { rows = await P.payments({ claim }); } catch (e) { throw new W.Blocked(e.message); }
    rows = rows.filter((r) => /^cc-/.test(r['CR TRACKING NUMBER']) && (!want || String(r.AMOUNT).replace(/[^0-9.]/g, '') === Number(want).toFixed(2)));
    if (rows.length || Date.now() > deadline) break;
    await page.waitForTimeout(60000);
  }
  if (!rows.length) throw new W.Blocked(`no ClaimCenter payment${want ? ` of $${want}` : ''} for ${claim} on the OneInc portal${waitMin ? ` after ${waitMin} min` : ''}`);
  rows.sort((a, b) => new Date(b['CREATED DATE'] || 0) - new Date(a['CREATED DATE'] || 0));
  const row = rows[0];
  let info;
  try { info = await P.payment({ crTracking: row['CR TRACKING NUMBER'] }); } catch (e) { throw new W.Blocked(e.message); }
  if (!info) throw new W.Blocked(`OneInc portal: payment ${row['CR TRACKING NUMBER']} could not be opened`);
  page.__oneIncPayment = info;
  await observe(page, 'OneInc payment', `${info['CR Tracking Number']} — ${info.Amount}, ${info.Status}, created ${info['Created Date']}, claim ${info['Claim Number']}`);
  for (const f of fields) await observe(page, `OneInc ${f}`, info[f] || '(blank)');
  return `OneInc payment ${info['CR Tracking Number']} (${info.Status})`;
}

// INT.018–031 payload cleansing: two claim-only people whose names / address carry characters the OneInc request must not
// (names: only [A-Za-z0-9 -.'] survive; street: no quotes, &, < >; city: no % * & / ~ |), in lower case (INT.029 CAPS) and
// with two address lines (INT.030 pipe). Created once per claim (no-op when already there). Role Covered Party (payable).
const DIRTY = {
  primary: { first: 'jo#hn$5', last: "o'b%ri*en-x", role: 'Covered Party', address: { line1: '12 "main" st & <rear>', line2: 'unit 7', city: 'lan%cas*ter', zip: '17603' } },
  secondary: { first: 'm!ke%', last: 'sm~it&h.jr', role: 'Covered Party', address: { line1: '12 main st', city: 'lancaster', zip: '17603' } },
};
async function addDirtyContacts(page) {
  for (const k of ['primary', 'secondary']) await W.addClaimPersonContact(page, DIRTY[k]);
  return `payees "${DIRTY.primary.first} ${DIRTY.primary.last}" + joint "${DIRTY.secondary.first} ${DIRTY.secondary.last}"`;
}

// A ClaimCenter check whose OneInc payment is in a given state: the claim's portal payments filtered by `status` /
// `method` (regex sources on the portal's STATUS / PAYMENT METHOD), newest first; observed fields "OneInc Status",
// "OneInc Payment Method", "OneInc check #", "OneInc payment"; then the ClaimCenter check with that number is opened
// (Check/Payment Details) and its status observed as "Check status". A payment OneInc never numbered (Cancelled before
// a method was chosen) is matched by amount — the newest ClaimCenter check of that amount (+ "match: amount").
async function oneIncCheck(page, { status = '.', method = '.', amount = '', claim: other = '' } = {}) {
  const K = require('./checkOps');
  const { readScreen, findField } = require('./screenReader');
  // `claim`: read a second claim's check in the same case (1008 APD TC-008 compares a digital and a PayPal payment).
  const claim = other || await claimNo(page);
  let rows;
  try { rows = await P.payments({ claim }); } catch (e) { throw new W.Blocked(e.message); }
  const st = new RegExp(status, 'i');
  const me = new RegExp(method, 'i');
  const want = String(amount || '').replace(/[^0-9.]/g, '');
  rows = rows.filter((r) => /^cc-/.test(r['CR TRACKING NUMBER']) && st.test(r.STATUS) && me.test(r['PAYMENT METHOD'] || '')
    && (!want || String(r.AMOUNT).replace(/[^0-9.]/g, '') === Number(want).toFixed(2)));
  if (!rows.length) throw new W.Blocked(`no OneInc payment of ${claim} with status /${status}/ and method /${method}/ on the portal`);
  rows.sort((a, b) => new Date(b['CREATED DATE'] || 0) - new Date(a['CREATED DATE'] || 0));
  const info = await P.payment({ crTracking: rows[0]['CR TRACKING NUMBER'] });
  if (!info) throw new W.Blocked(`OneInc portal: payment ${rows[0]['CR TRACKING NUMBER']} could not be opened`);
  page.__oneIncPayment = info;
  const num = /^\d+$/.test(info['Transaction ID/Check #'] || '') ? info['Transaction ID/Check #'] : '';
  await W.openClaim(page, claim);
  let opened = '';
  if (num) opened = await K.openCheck(page, { number: num });
  else {
    // Matched exactly by the check's "Payment Identifier" (= the portal's CR Tracking Number), newest same-amount check first.
    const amt = String(info.Amount).replace(/[^0-9.]/g, '');
    const cands = (await K.checkRows(page)).filter((r) => String(r.amount).replace(/[^0-9.]/g, '') === amt).reverse();
    for (const c of cands) {
      await W.openClaim(page, claim);
      const o = await K.openCheck(page, c.number ? { number: c.number } : { amount: amt, status: `^${c.status.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` });
      if (((findField(await readScreen(page), 'Payment Identifier') || {}).value || '').trim() === info['CR Tracking Number']) { opened = o; break; }
    }
    if (!opened) throw new W.Blocked(`no ClaimCenter check on ${claim} carries Payment Identifier ${info['CR Tracking Number']} (OneInc ${info.Status} ${info.Amount})`);
  }
  const ccStatus = (findField(await readScreen(page), 'Status') || {}).value || '';
  await observe(page, 'OneInc Status', info.Status || '(blank)');
  await observe(page, 'OneInc Payment Method', info['Payment Method'] || '(blank)');
  await observe(page, 'OneInc check #', num || '(none)');
  await observe(page, 'OneInc payment', `${info['CR Tracking Number']} — ${info.Amount}, ${info.Status}, created ${info['Created Date']}, modified ${info['Date Modified']}${num ? '' : ' (no OneInc check #: ClaimCenter check matched by amount)'}`);
  await observe(page, 'Check status', ccStatus || '(blank)');
  return `${opened}; OneInc ${info.Status}`;
}

// After a void: re-open the check this case was working on (page.__check.number) and observe its status again.
async function reopenCheck(page) {
  const K = require('./checkOps');
  const { readScreen, findField } = require('./screenReader');
  const num = page.__check && page.__check.number;
  if (!num) throw new W.Blocked('no check number to re-open');
  await W.openClaim(page, await claimNo(page));
  await K.openCheck(page, { number: num });
  const v = (findField(await readScreen(page), 'Status') || {}).value || '';
  return observe(page, 'Check status', v || '(blank)');
}

// Copies a field shown now into an observed field `as`; showNotes re-adds every noted field after a later step of the
// same case opened another screen (navigation removes observed fields).
const notes = new WeakMap();
async function noteField(page, label, as) {
  const { readScreen, findField } = require('./screenReader');
  const f = findField(await readScreen(page), label);
  const v = f ? (f.value || '(blank)') : '(not on the screen)';
  const m = notes.get(page) || {};
  m[as] = v;
  notes.set(page, m);
  return observe(page, as, v);
}
async function showNotes(page) {
  const m = notes.get(page) || {};
  for (const [k, v] of Object.entries(m)) await observe(page, k, v);
  return `${Object.keys(m).length} noted field(s) shown`;
}

module.exports = { underwritingCompany, oneIncPayment, addDirtyContacts, DIRTY, oneIncCheck, reopenCheck, noteField, showNotes };
