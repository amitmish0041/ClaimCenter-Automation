/**
 * helpers/oneInc/setupC.js
 * UI setup steps for the "setup C" OneInc scenarios (VBR.037 surcharge, VBR.036 mailing address, payee roles,
 * VBR.032 pending approval). Called from recipes with { call: ['setupC.<fn>', ...args] } → fn(page, ...args), and from
 * profile prepare hooks (fn(page, claim, out)). WRITES to automation-owned claims on the TEST tier only.
 */
'use strict';
const W = require('./wizardDriver');
const A = require('./setupA');
const { readScreen, findField, norm } = require('./screenReader');

const TIER = (process.env.CC_TIER || 'test').toLowerCase();
function testOnly(what) {
  if (TIER !== 'test') throw new W.Blocked(`${what} writes claim data — allowed on the TEST tier only`);
}

// ── VBR.037 ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Actions › New Payment | Quick Payment, WITHOUT turning CC's "New Payment Error" into an exception: the recipe's
// checks then read the screen (error text present / wizard open). kind = 'actions' (New Payment) | 'quick'.
async function openFromActions(page, kind = 'actions') {
  const quick = kind === 'quick';
  // Cloud has no Actions › Quick Payment item: Quick Payment is on the Financials reserve-row menu (same claim-level gate).
  const items = quick ? await W.openFinancialsRowMenu(page) : await W.openActionsMenu(page);
  const re = quick ? /^Quick (Payment|Check)$/ : /^New Payment/;
  const mi = page.getByRole('menuitem', { name: re }).first();
  if (!await mi.isVisible().catch(() => false)) {
    await W.closeMenus(page);
    throw new W.Blocked(`${quick ? 'Financials row menu has no Quick Payment' : 'Actions menu has no New Payment'} item (items: ${items.slice(0, 40).join(', ')})`);
  }
  await mi.click();
  const ready = await Promise.race([
    page.getByRole('button', { name: 'Next', exact: true }).first().waitFor({ state: 'visible', timeout: 25000 }).then(() => 'wizard').catch(() => null),
    page.getByRole('button', { name: 'Finish', exact: true }).first().waitFor({ state: 'visible', timeout: 25000 }).then(() => 'wizard').catch(() => null),
    page.getByText('New Payment Error').first().waitFor({ state: 'visible', timeout: 25000 }).then(() => 'error').catch(() => null),
  ]);
  await W.settle(page, 2000);
  return ready || 'nothing';
}

// VBR.037 pre-2013 negative: Loss Details › Edit › Loss Date = 12/31/2012 (the FNOL loss date is recent).
async function setLossDate2012(page, claim, out) {
  testOnly('setLossDate2012');
  await A.openLossDetailsGeneral(page);
  const cur = findField(await readScreen(page), 'Date of Loss');
  if (cur && /12\/31\/2012/.test(cur.value || '')) return 'loss date already 12/31/2012';
  await A.editAndSave(page, 'Loss Details Date of Loss', async () => {
    await A.fillByLabel(page, 'Date of Loss', '12/31/2012');
  });
  await A.openLossDetailsGeneral(page);
  const after = findField(await readScreen(page), 'Date of Loss');
  if (!after || !/12\/31\/2012|12\/31\/12/.test(after.value || '')) throw new W.Blocked(`Loss Date did not stick (shows "${after ? after.value : '?'}")`);
  return 'Loss Date set to 12/31/2012';
}

module.exports = { openFromActions, setLossDate2012 };
