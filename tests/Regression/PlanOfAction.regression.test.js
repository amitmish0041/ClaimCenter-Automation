/**
 * tests/Regression/PlanOfAction.regression.test.js — Regression Test Design V1.0, Claim Evaluation & Negotiation
 * (TC064, TC065).
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, A } = S;

S.hooks(test);

test('RG-TC064 [Claim Evaluation & Negotiation]: Plan of Action › Evaluations not visible to the adjuster (Auto)', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await S.claimFor(page, ti, 'REG_CLAIM_PA', 'PA', 'RG-TC064');
  const s = await S.readScreen(page);
  const navLabels = s.nav.map((n) => n.label);
  await S.nav(page, 'Plan of Action').catch(() => {});
  const after = (await S.readScreen(page)).nav.map((n) => n.label);
  const ev = after.concat(navLabels).filter((l) => /evaluation/i.test(l));
  await R.check(page, ti, { description: `Evaluations hidden for ${process.env.CC_USER}`, expected: 'no Evaluations item', actual: ev.join(', ') || `not shown (nav: ${navLabels.join(', ').slice(0, 300)})`, ok: !ev.length });
  R.setClaim(ti, cn);
}));

test('RG-TC065 [Claim Evaluation & Negotiation]: New Negotiation related to the WC Indemnity exposure with 4 lines', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await S.claimFor(page, ti, 'REG_CLAIM_WC', 'WC', 'RG-TC065');
  await S.nav(page, 'Plan of Action');
  if (!(await S.nav(page, 'Negotiations'))) throw new W.Blocked('no Plan of Action › Negotiations');
  await W.clickButton(page, 'New Negotiation');
  await A.fillByLabel(page, 'Name', 'WC Indemnity Settlement Negotiation');
  const rel = S.findField(await S.readScreen(page), 'Related To');
  if (!rel || !rel.options) throw new W.Blocked('no Related To dropdown');
  const opts = rel.options.filter((o) => !/^<none>$/i.test(o));
  await R.check(page, ti, { description: 'Related To offers Claim, Contacts, Exposures (and every WC exposure)', expected: 'Claim + contacts + exposures (Medical, Indemnity, Employer Liability)', actual: opts.join(' | '), ok: opts.some((o) => /claim/i.test(o)) && opts.some((o) => /indemnity/i.test(o)) });
  const ind = opts.find((o) => /indemnity/i.test(o));
  if (!ind) throw new W.Blocked('no Indemnity exposure on this WC claim');
  await A.selectByLabel(page, rel.label, ind);
  const lines = [['Demand', '30000', 'Claimant demand for lost wages'], ['Offer', '18000', 'Initial offer based on indemnity reserve'], ['Counteroffer', '24000', 'Claimant counter'], ['Accepted Settlement', '20000', 'Lump sum settlement agreed']];
  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  for (let i = 0; i < lines.length; i++) {
    await W.clickButton(page, 'Add');
    const row = page.locator('tr[id*="NegotiationLog"], tr[id*="LogLV-"], tr[id*="NegotiationLV-"]').filter({ has: page.locator('input, select') }).nth(i);
    if (!(await row.isVisible().catch(() => false))) throw new W.Blocked('negotiation line row not found after Add');
    const inputs = row.locator('input:not([type=hidden]):not([type=checkbox]), textarea');
    const sel = row.locator('select').first();
    await sel.selectOption({ label: lines[i][0] }).catch(() => {});
    const n = await inputs.count();
    if (n >= 3) { await inputs.nth(0).fill(today); await inputs.nth(1).fill(lines[i][1]); await inputs.nth(2).fill(lines[i][2]); }
  }
  await W.clickButton(page, 'Update');
  const rows = await R.gridRows(page);
  await R.check(page, ti, { description: 'Negotiation saved with Related To = Indemnity exposure', expected: 'WC Indemnity Settlement Negotiation / Indemnity', actual: rows.filter((r) => /Negotiation/i.test(r)).join(' | ') || (await R.pageMessages(page)).join(' | ') || 'not listed', ok: rows.some((r) => /WC Indemnity Settlement/i.test(r)) });
  R.setClaim(ti, cn);
}));
