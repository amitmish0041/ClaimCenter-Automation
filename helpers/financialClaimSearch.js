/**
 * helpers/financialClaimSearch.js — CLOUD ClaimCenter: find EXISTING TEST claims with the data a financial-rule case
 * needs (user direction 2026-11-06: the data is in TEST — search for it, don't build it).
 *
 * Uses Search › Claims › Advanced Search (cloud TEST, CONFIRMED 2026-11-06): Claim Status, Line of Business, Loss
 * Location State, Assigned To Group (e.g. Sensitive Claims Group), High-Risk Indicators (SIU / Reinsurance / Attorney
 * Represented / Large Loss / …), Flagged Type. Read-only: it only searches and reads the result grid.
 */
'use strict';
const W = require('./oneInc/wizardDriver');

async function openAdvancedSearch(page) {
  await page.locator('[id="TabBar-SearchTab"]').first().click();
  await W.settle(page, 3500);
  const adv = page.getByText(/^Advanced Search$/).first();
  if (await adv.isVisible().catch(() => false)) { await adv.click(); await W.settle(page, 3000); }
  // Start from a clean form.
  const reset = page.getByRole('button', { name: 'Reset', exact: true }).first();
  if (await reset.isVisible().catch(() => false)) { await reset.click(); await W.settle(page, 2000); }
}

/**
 * criteria: { status, lob, lossState, group, indicators: [labels], flagged, policy } — all optional (CC needs at least
 * one of its "Specify at least one" fields or a group/indicator). Returns result rows [{ claim, text }].
 */
async function searchClaims(page, criteria = {}) {
  await openAdvancedSearch(page);
  const sel = async (label, value) => { if (value) await W.select(page, label, value).catch((e) => { throw new Error(`Advanced Search: ${label} = ${value}: ${e.message.split('\n')[0]}`); }); };
  if (criteria.policy) await W.fill(page, 'Policy #', criteria.policy);
  await sel('Assigned To Group', criteria.group);
  if (criteria.group) await page.getByRole('checkbox', { name: /Include Child Groups/i }).first().check().catch(() => {});
  await sel('Claim Status', criteria.status);
  await sel('Line of Business', criteria.lob);
  await sel('Loss Location State', criteria.lossState);
  await sel('Flagged Type', criteria.flagged);
  // High-Risk Indicators is a multi-select <select> (not checkboxes): select the labels in it.
  if ((criteria.indicators || []).length) {
    const box = page.locator('.gw-InputWidget').filter({ hasText: /High-Risk Indicators/ }).locator('select').first();
    await box.selectOption(criteria.indicators.map((label) => ({ label })));
    await W.settle(page, 1500);
  }
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await W.settle(page, 6000);
  return page.evaluate(() => [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr'))
    .map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim())
    .map((t) => ({ claim: (t.match(/\b[A-Z]{2,4}-[A-Z]{2}-\d{2}-\d{2}-\d{7}\b/) || [])[0], text: t.slice(0, 200) }))
    .filter((r) => r.claim));
}

module.exports = { searchClaims, openAdvancedSearch };
