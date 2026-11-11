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

module.exports = { underwritingCompany, oneIncPayment };
