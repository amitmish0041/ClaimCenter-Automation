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
  // A menu / validation overlay or a busy screen (Claim Calendar) left the tab unclickable after a screen walk
  // (Migrated RX024 / RX029, 2026-11-15): close menus, reload home, then click.
  const tab = page.locator('[id="TabBar-SearchTab"]').first();
  if (!await tab.click({ timeout: 8000 }).then(() => true).catch(() => false)) {
    await W.closeMenus(page).catch(() => {});
    await page.goto(require('./claimCenterBase').BASE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await W.settle(page, 4000);
    await tab.click({ timeout: 20000 });
  }
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
  // "Include Child Groups" is a Yes/No radio pair (not a checkbox).
  if (criteria.group) {
    await page.locator('.gw-InputWidget').filter({ hasText: /Include Child Groups/ }).getByRole('radio', { name: 'Yes', exact: true }).first().click({ force: true }).catch(() => {});
    await W.settle(page, 1000);
  }
  await sel('Claim Status', criteria.status);
  await sel('Line of Business', criteria.lob);
  await sel('Loss Location State', criteria.lossState);
  await sel('Flagged Type', criteria.flagged);
  // High-Risk Indicators is a SHUTTLE: pick in the left list ("available items"), then "Add to selected" (2026-11-06).
  for (const label of criteria.indicators || []) {
    await page.locator('select[id$="IndicatorSearch_select-left"]').selectOption({ label });
    await page.locator('[id$="IndicatorSearch_add"]').click();
    await W.settle(page, 1200);
  }
  // date: { type: 'Loss date' | 'Reported date' | 'Closed date' | 'Creation date', from, to } (MM/DD/YYYY);
  // money: { type: 'Remaining Reserves' | 'Total Paid' | …, from, to } — the "Optional parameters" ranges (2026-11-15).
  const N = 'ClaimSearch-ClaimSearchScreen-ClaimSearchDV-ClaimSearchAddOptionalInputSet-';
  const box = async (name, v) => { if (v == null || v === '') return; const b = page.locator(`input[name="${N}${name}"]`).first(); await b.fill(String(v)); await b.press('Tab').catch(() => {}); await W.settle(page, 800); };
  const pick = async (name, label) => { await page.locator(`select[name="${N}${name}"]`).first().selectOption({ label }); await W.settle(page, 1500); };
  if (criteria.date) {
    await pick('ArchiveDateSearch-ArchiveDateSearchChosenOption', criteria.date.type || 'Loss date');
    // From/To stay disabled until the second "date search type" radio (a range, not "Since …") is chosen; a forced
    // Playwright check() did not take, a DOM click does (2026-11-15).
    await page.locator('input[name="ClaimSearchCriteria.DateCriterionChoice.DateSearchType_Radio"]').nth(1).evaluate((r) => r.click());
    await W.settle(page, 1500);
    await box('ArchiveDateSearch-ArchiveDateSearchStartDate', criteria.date.from);
    await box('ArchiveDateSearch-ArchiveDateSearchEndDate', criteria.date.to);
  }
  if (criteria.money) {
    await pick('Financial-FinancialCriterionMultiCurrencyChoiceInputSet-FinancialChosenOption', criteria.money.type);
    await box('Financial-FinancialCriterionMultiCurrencyChoiceInputSet-FinancialAmountStart', criteria.money.from);
    await box('Financial-FinancialCriterionMultiCurrencyChoiceInputSet-FinancialAmountEnd', criteria.money.to);
  }
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await W.settle(page, 6000);
  const read = () => page.evaluate(() => [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr'))
    .map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim())
    .map((t) => ({ claim: (t.match(/\b[A-Z]{2,4}-[A-Z]{2}-\d{2}-\d{2}-\d{7}\b/) || [])[0], text: t.slice(0, 200) }))
    .filter((r) => r.claim));
  const out = await read();
  // criteria.pages: also read result pages 2…n (the grid shows 15 a page).
  for (let p = 1; p < (criteria.pages || 1); p++) {
    const next = page.locator('[id^="ClaimSearch-ClaimSearchScreen-ClaimSearchResultsLV"][id$="_ListPaging-next"]').first();
    if (!await next.isVisible().catch(() => false) || await next.isDisabled().catch(() => true)) break;
    const first = out.length ? out[out.length - 1].claim : '';
    await next.click().catch(() => {});
    await W.settle(page, 3000);
    const more = await read();
    if (!more.length || more.some((r) => r.claim === first)) break;
    out.push(...more);
  }
  return out;
}

// Opens a claim from Advanced Search › Claim # — the quick search did not find CLOSED claims (WC-PA-01-08-0053142,
// 2026-11-06); Advanced Search lists them and opens them.
async function openClaimViaSearch(page, cn) {
  await openAdvancedSearch(page);
  await page.locator('.gw-InputWidget').filter({ hasText: /^\s*Claim #/ }).locator('input').first().fill(cn);
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await W.settle(page, 5000);
  await page.locator('tr:visible').getByText(cn, { exact: true }).first().click();
  await W.settle(page, 5000);
  const head = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  if (!head.includes(`Claim: ${cn}`)) throw new Error(`Advanced Search: claim ${cn} did not open`);
  return (head.match(/St: (\w+)/) || [])[1] || '';
}

module.exports = { searchClaims, openAdvancedSearch, openClaimViaSearch };
