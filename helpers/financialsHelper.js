/**
 * helpers/financialsHelper.js
 * Reserves, Payments, Recovery, Bulk Invoice, Transaction Approval, Validation.
 *
 * Cloud selectors below for openFinancialsTab / editReserve / createPayment were
 * captured via Playwright codegen against a live dev-env claim (see conversation
 * history) - not guessed. Recovery / Bulk Invoice / Approve / Deny are still the
 * original on-prem-style guesses and have NOT been verified against cloud yet.
 */
const { fillTextField, verifyTextVisible, verifyNoValidationErrors,
        selectDropdown, fillIntegerCommaField, fillDateField, clickSave,
        IS_ON_PREM, selectComboboxOnPrem, waitForAllMasksGone,
        openExistingClaim } = require('./claimCenterBase');
const { sweepComboboxesOnPrem, answerCloudRadioGroups,
        answerUnansweredYesNoPairs, completeCloudLossDetails,
        fixCloudInvalidControls } = require('./fnolHelper');

// ── Payment wizard navigation buttons ───────────────────────────────────────
// The check wizard's id PREFIX is not stable. "NormalCreateCheckWizard" is the
// common case, but CC also renders "ApprovalCreateCheckWizard" (and other
// variants) for the same screens - the Finish lookup further down already had
// to use a prefix-agnostic `[id$=":Finish"]` for exactly this reason, while
// Next/Cancel stayed hardcoded to the Normal prefix. When a non-Normal prefix
// came up, the hardcoded locator matched nothing and the run reported
// "on Step 2 of 3 with no Next/Back/Finish rendered" - the buttons were on
// screen the whole time, just under a different id.
//
// Resolve by id SUFFIX, restricted to something actually visible, and fall
// back to the ExtJS inner-text element (these are <span data-ref="btnInnerEl">,
// not native <button>, so getByRole('button') does not match them).
function wizardNavButton(page, name) {
  return page.locator('[id$="Wizard:' + name + '"]:visible').first();
}

// Clicks a wizard nav button, trying the id-suffix locator first and the
// ExtJS button-text element second. Returns true if a click landed.
async function clickWizardNav(page, name) {
  const byId = wizardNavButton(page, name);
  if (await byId.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    await byId.click().catch(() => {});
    return true;
  }
  const byText = page.locator('[data-ref="btnInnerEl"]')
    .filter({ hasText: new RegExp('^' + name + '\\s*>?$') }).first();
  if (await byText.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    await byText.click().catch(() => {});
    return true;
  }
  console.log('clickWizardNav: no "' + name + '" control found on the current wizard screen');
  return false;
}

// Clicks Cancel on the payment wizard and confirms the "Do you really want to
// exit the wizard?" dialog that CC pops up on Step 2 (confirmed via live screenshot).
// Also waits for the server-side cancel to complete before returning — the
// on-prem CC server can take 15-25s to process the cancel, so callers must
// not assume the page is clean until this function returns.
async function cancelPaymentWizard(page) {
  await clickWizardNav(page, 'Cancel');
  // Detect and dismiss the "Do you really want to exit?" confirmation dialog.
  const hasExitDlg = await page.getByText('Do you really want to exit the wizard').first()
    .waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
  if (hasExitDlg) {
    // ExtJS buttons use <span data-ref="btnInnerEl"> not native <button> elements,
    // so getByRole('button') does not match them. Scope to the dialog window and
    // click via the ExtJS inner text element (confirmed via inspect: id="button-1005-btnInnerEl").
    const dlg = page.locator('.x-window').filter({ hasText: 'Do you really want to exit the wizard' }).first();
    await dlg.locator('[data-ref="btnInnerEl"]').filter({ hasText: /^OK$/ }).first().click().catch(() => {});
  }
  // Wait for the wizard to be gone from the DOM — the Cancel button lives
  // inside the wizard panel and disappears once the server finishes the cancel.
  await wizardNavButton(page, 'Cancel')
    .waitFor({ state: 'hidden', timeout: 45000 }).catch(() => {});
  // Wait up to 60s for all .x-mask overlays to clear naturally.
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('.x-mask'))
           .every(m => getComputedStyle(m).display === 'none' ||
                       getComputedStyle(m).visibility === 'hidden' ||
                       m.getBoundingClientRect().width === 0),
    { timeout: 60000 }
  ).catch(() => {});
  // Only remove masks that are still VISIBLY blocking pointer events.
  // Removing already-hidden masks corrupts ExtJS's internal mask-manager state
  // and breaks subsequent navigation (Search tab click silently no-ops).
  await page.evaluate(() => {
    document.querySelectorAll('.x-mask').forEach(el => {
      const rect = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (s.display !== 'none' && s.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
        el.remove();
      }
    });
  }).catch(() => {});
}

// Selects a given value in a <select> found via getByLabel, or - if no value is
// supplied - the first real (non-blank) option. Used for the cloud payment
// wizard's dropdowns (Payee, Reserve Line, Transaction Type, ...), which have
// no on-prem equivalent and thus no natural "default" beyond "whatever's first".
async function selectByLabelOrFirst(page, labelText, value) {
  const el = page.getByLabel(labelText).first();

  // Read the real options first. A plain string passed to selectOption() is
  // matched against the option's VALUE, not its label - so asking for a
  // claimant name ("SANFORD BARNWELL") never matched anything, and the failure
  // surfaced far downstream as a disabled Category field. Match on label, then
  // on a loose contains, then fall back to the first real option.
  // evaluateAll does NOT auto-wait the way selectOption() does, so reading the
  // options straight away reported every dropdown as empty while the wizard
  // step was still rendering. Wait for the control, then poll until its
  // options actually arrive (they populate over a server round-trip).
  await el.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const matches = (o) => o.value === value || norm(o.text) === norm(value) ||
                         norm(o.text).includes(norm(value)) || norm(value).includes(norm(o.text));

  // These lists populate over a server round-trip and arrive PARTIALLY filled.
  // Breaking as soon as the list was non-empty matched against whatever had
  // landed first: asking for the claimant payee silently selected the insured
  // company, which then left Reserve Line empty. When a specific value was
  // asked for, keep polling until it shows up.
  let real = [];
  for (let i = 0; i < 12; i++) {
    const opts = await el.locator('option').evaluateAll(
      (os) => os.map(o => ({ value: o.value, text: (o.textContent || '').trim() }))
    ).catch(() => []);
    real = opts.filter(o => o.text && !/^<?none>?$/i.test(o.text) && o.value !== '');
    if (real.length && (!value || real.some(matches))) break;
    await page.waitForTimeout(500);
  }
  if (!real.length) {
    console.log('selectByLabelOrFirst: "' + labelText + '" has NO selectable options');
    return null;
  }

  let choice = null;
  if (value) {
    choice = real.find(o => o.value === value)
          || real.find(o => norm(o.text) === norm(value))
          || real.find(matches);
    if (!choice) {
      console.log('selectByLabelOrFirst: "' + labelText + '" has no option matching "' + value +
                  '" — using "' + real[0].text + '" (options: ' +
                  real.slice(0, 5).map(o => o.text).join(', ') + ')');
    }
  }
  choice = choice || real[0];
  await el.selectOption(choice.value).catch(() => {});
  await page.waitForTimeout(600);
  return choice.text;
}

async function openFinancialsTab(page) {
  if (IS_ON_PREM) {
    // The on-prem "[id*=FinancialsTab]" guess was never actually verified and
    // just timed out on live use. Neither did the "Claim:MenuLinks:..."
    // guess - confirmed via live screenshot that "Financials" is a TREE
    // node (same ".x-tree-node-text" pattern already confirmed for
    // "Workplan"), not that id convention at all.
    const navItem = page.locator('.x-tree-node-text').filter({ hasText: /^Financials$/ }).first();
    const hasNavItem = await navItem.waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true).catch(() => false);
    if (hasNavItem) {
      await navItem.click();
    } else {
      await page.click('[id*="FinancialsTab"], a:has-text("Financials")');
    }
  } else {
    // Left-side claim nav item, not the top TabBar - a plain accessible label.
    await page.getByLabel('Financials', { exact: true }).click();
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

// ── openExposuresTab (on-prem) ───────────────────────────────────────────────
// Confirmed via live user recording: the left-nav "Exposures" link's real id
// is "Claim:MenuLinks:Claim_ClaimExposures" - clicking it goes straight to the
// Exposures grid, no Actions menu needed, useful for jumping into an already
// existing claim (via openExistingClaim) to create a reserve on an exposure
// that's already there.
// Cloud exposures grid, confirmed by probing a live claim:
//   nav   Claim-MenuLinks-Claim_ClaimExposures
//   cells ...ExposuresLV-<row>-Claimant   (e.g.
//         ClaimSummary-ClaimSummaryScreen-ClaimSummaryExposuresLV-0-Claimant)
// Matching on the id suffix rather than a fixed screen prefix keeps this
// working whether the grid is read from the Summary page or the dedicated
// Exposures page - they carry the same columns under different prefixes.
const CLOUD_EXPOSURE_CLAIMANT_CELLS = '[id*="ExposuresLV-"][id$="-Claimant"]';

async function openExposuresTabCloud(page) {
  const nav = page.locator('[id="Claim-MenuLinks-Claim_ClaimExposures"]').first();
  if (await nav.isVisible().catch(() => false)) {
    await nav.click().catch(() => {});
  } else {
    await page.getByLabel('Exposures', { exact: true }).first().click().catch(() => {});
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  // Wait for a real claimant CELL, not the grid container: the container
  // renders (with headers only) well before its rows do, and sampling it was
  // the mistake that made a two-exposure claim read as zero.
  await page.locator(CLOUD_EXPOSURE_CLAIMANT_CELLS).first()
    .waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
}

async function getAllExposureClaimantsCloud(page) {
  await page.locator(CLOUD_EXPOSURE_CLAIMANT_CELLS).first()
    .waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[id*="ExposuresLV-"]')) {
      // Row cells only: ...LV-<digits>-Claimant. The header cell is
      // ...-ClaimantHeader, and _Cell/_button duplicates repeat the same text.
      if (!/ExposuresLV-\d+-Claimant$/.test(el.id)) continue;
      if (!el.offsetParent) continue;
      const t = (el.innerText || '').trim();
      if (!t || seen.has(el.id)) continue;
      seen.add(el.id);
      out.push(t);
    }
    return out;
  }).catch(() => []);
}

async function openExposuresTab(page) {
  if (!IS_ON_PREM) return openExposuresTabCloud(page);
  // Confirmed via live failure: right after the payment wizard's Finish
  // click, this nav item can still take a while to become clickable again
  // (the page is mid-transition) - wait for the mask to clear and the item
  // to actually be visible before clicking, instead of assuming it's ready.
  const t0 = Date.now();
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  const navItem = page.locator('[id="Claim:MenuLinks:Claim_ClaimExposures"] div').filter({ hasText: /^Exposures$/ });
  const hasNav = await navItem.waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true).catch(() => false);
  if (hasNav) {
    await navItem.click();
  } else {
    // Not every LOB has an Exposures nav item. Confirmed live on WC: its left
    // nav runs Summary / Workplan / Loss Details / Reinsurance / ... with no
    // Exposures entry at all - the exposures grid is a SECTION OF THE SUMMARY
    // page instead. The unconditional click here then burned the full 30s
    // action timeout and failed the reserve step. Fall back to Summary, which
    // carries the same grid (same Coverage / Claimant / Remaining Reserves
    // columns), so the readers below work unchanged.
    console.log('openExposuresTab: no Exposures nav item (WC-style claim) — using the Summary page grid');
    const summary = page.locator('.x-tree-node-text').filter({ hasText: /^Summary$/ }).first();
    if (await summary.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)) {
      await summary.click().catch(() => {});
    }
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  // Wait for either the mask to disappear OR the Claimant header to appear
  // (whichever resolves first) — avoids stalling for the full mask timeout
  // when the grid has already rendered.
  await Promise.race([
    page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }),
    page.locator('.x-column-header-text').filter({ hasText: 'Claimant' }).first()
      .waitFor({ state: 'visible', timeout: 10000 }),
  ]).catch(() => {});
  console.log('[timing] openExposuresTab: ' + (Date.now() - t0) + 'ms');
}

// Reads the Claimant column text off the LAST row of the Exposures grid.
// Confirmed via live failure: addExposureByCoverage's own tracked claimant
// value can diverge from what actually got saved to the exposure (e.g. it
// reported "Emily Jones" while the exposure's real Claimant column showed
// "SKYLINE CONSTRUCTION INC") - reading the grid directly after the fact is
// the reliable source of truth for which exposureRowText/reserveLine to
// target in later reserve/payment steps. Must be called after
// openExposuresTab.
async function getLastExposureClaimant(page) {
  const rows = page.locator('.x-grid-row');
  await rows.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  const headerCells = page.locator('.x-column-header-text');
  const headerTexts = await headerCells.allTextContents().catch(() => []);
  const headerClaimantIndex = headerTexts.findIndex(t => t.trim() === 'Claimant');
  if (headerClaimantIndex === -1) return null;
  // -1: this ExtJS grid splits into a locked section (checkbox + "#") and an
  // unlocked section (Type, Attorney Represent, Coverage, Claimant,
  // Adjuster, Status) as SEPARATE row DOM nodes - .x-grid-row/.x-grid-cell
  // here only walks the unlocked section, which has no "#" column, while
  // headerTexts includes "#" from the locked section's header. Confirmed via
  // two live failures: index+0 landed on Adjuster, index+1 landed on Status
  // - both one column to the right of Claimant - so the real offset is -1.
  const claimantColIndex = headerClaimantIndex - 1;
  const lastRow = rows.last();
  const cell = lastRow.locator('.x-grid-cell').nth(claimantColIndex);
  const text = await cell.textContent().catch(() => null);
  return text ? text.trim() : null;
}

// Returns an array of all claimant name strings from every row in the
// currently-visible Exposures grid. Used to iterate through exposures when
// closing them all (e.g. TC-FIN-012 must close every exposure before closing
// the claim). Same column-offset logic as getLastExposureClaimant.
async function getAllExposureClaimants(page) {
  if (!IS_ON_PREM) return getAllExposureClaimantsCloud(page);
  // Wait for the Claimant column header to appear (grid fully rendered).
  await page.locator('.x-column-header-text').filter({ hasText: 'Claimant' })
    .first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});

  // Read all claimants via a single evaluate() call — avoids per-cell Playwright
  // locator timeouts (5s each) that can stack up to minutes when the DOM has
  // many .x-grid-row elements from other panels left over by prior navigation.
  return await page.evaluate(() => {
    const headers = [...document.querySelectorAll('.x-column-header-text')]
      .map(h => (h.textContent || '').trim());
    const claimantIdx = headers.indexOf('Claimant');
    if (claimantIdx === -1) return [];
    const colIdx = claimantIdx - 1; // -1 for the leading checkbox column
    const claimants = [];
    for (const row of document.querySelectorAll('.x-grid-row')) {
      const cells = row.querySelectorAll('.x-grid-cell');
      const cell = cells[colIdx];
      const text = cell ? (cell.textContent || '').trim() : '';
      if (text) claimants.push(text);
    }
    return claimants;
  }).catch(() => []);
}

// ── getAvailableReserveAmount (on-prem) ─────────────────────────────────────
// Reads the numeric "Remaining Reserves" (available-to-pay) amount for a
// specific claimant's exposure off the Financials > Summary grid, so a
// "final payment" can be sized to exactly what's left instead of guessing an
// amount and hoping it doesn't exceed or under-use the reserve.
async function getAvailableReserveAmount(page, claimantText) {
  const navItem = page.locator('.x-tree-node-text').filter({ hasText: /^Financials$/ }).first();
  const hasNavItem = await navItem.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  if (hasNavItem) {
    await navItem.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  const summaryLink = page.locator('.x-tree-node-text').filter({ hasText: /^Summary$/ }).first();
  if (await summaryLink.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    await summaryLink.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  }

  // Scan ALL rows matching the claimant and return the FIRST one with a positive
  // remaining reserve. Using .first() alone fails when two exposures share the
  // same claimant name (e.g. Comprehensive + Collision for "JESSICA MILLER"):
  // after TC-FIN-011 pays and closes the first, .first() reads that row's $0
  // balance, returning NaN and skipping the payment that the still-open second
  // exposure needs.
  const allRows = claimantText ? page.getByRole('row', { name: claimantText }) : page.locator('.x-grid-row');
  await allRows.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  const rowCount = await allRows.count().catch(() => 0);

  // Fallback: role-based row match can return 0 when the server is slow and the
  // grid hasn't re-rendered after many activity completions. Scan all grid rows
  // by raw text content instead.
  if (rowCount === 0 && claimantText) {
    console.log('getAvailableReserveAmount: no rows for "' + claimantText + '" via role — trying full grid scan');
    const allGridRows = page.locator('.x-grid-row');
    await allGridRows.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const totalRows = await allGridRows.count().catch(() => 0);
    for (let ri = 0; ri < totalRows; ri++) {
      const row = allGridRows.nth(ri);
      const rowText = await row.textContent().catch(() => '');
      if (!rowText.includes(claimantText)) continue;
      // Only read [id*="RemainingReserves"] — .gw-currency-positive also matches
      // Recovery Reserve rows (e.g. Subrogation $2k from TC-FIN-005), which are
      // not payment reserve lines and would cause PMS PL50 if used in createPayment.
      const amountText = await row.locator('[id*="RemainingReserves"]').first().textContent().catch(() => null);
      const numeric = amountText ? Number(amountText.replace(/[^0-9.-]/g, '')) : NaN;
      console.log('getAvailableReserveAmount: fallback row[' + ri + '] raw="' + amountText + '" parsed=' + numeric);
      if (!Number.isNaN(numeric) && numeric > 0) return numeric;
    }
  }

  for (let ri = 0; ri < rowCount; ri++) {
    const row = allRows.nth(ri);
    // Confirmed via live failure: positional column-index matching lands on
    // the wrong cell. Use "RemainingReserves" id fragment directly.
    // Only read [id*="RemainingReserves"] — .gw-currency-positive also matches
    // Recovery Reserve rows which are not payment reserve lines.
    const amountText = await row.locator('[id*="RemainingReserves"]').first().textContent().catch(() => null);
    const numeric = amountText ? Number(amountText.replace(/[^0-9.-]/g, '')) : NaN;
    console.log('getAvailableReserveAmount: row[' + ri + '] raw="' + amountText + '" parsed=' + numeric);
    if (!Number.isNaN(numeric) && numeric > 0) return numeric;
  }

  throw new Error('getAvailableReserveAmount: no positive reserve found across ' + rowCount + ' rows' + (claimantText ? ' for "' + claimantText + '"' : ''));
}

// ── findFirstPositiveReserveLine (on-prem) ───────────────────────────────────
// Iterates Financials Summary rows in display order and returns the FIRST row
// with a positive remaining-reserve balance.  Returns an object with:
//   amount       — numeric remaining reserve
//   rowIndex     — 0-based row position in the grid
//   firstCell    — trimmed text of the first grid cell (coverage/reserve-line
//                  label), used as the reserve-line selector in createPayment
//                  and as the exposure-row text in closeExposureWithOutcome
//
// Using the SAME row position guarantees createPayment (which picks the first
// matching dropdown option) and closeExposureWithOutcome (which finds the row
// by text) both target the identical exposure — avoiding the mismatch seen
// when both Collision and Comprehensive show the same claimant name ("MIKE
// AANRUD") but one has already been paid.
async function findFirstPositiveReserveLine(page) {
  const navItem = page.locator('.x-tree-node-text').filter({ hasText: /^Financials$/ }).first();
  if (await navItem.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    await navItem.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  const summaryLink = page.locator('.x-tree-node-text').filter({ hasText: /^Summary$/ }).first();
  if (await summaryLink.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    await summaryLink.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  }

  // Wait for the Financials Summary grid to render — the "Claim Total" parent
  // row is always the first element with a RemainingReserves cell and a visible
  // button. Give it up to 15s; if not found the evaluate below returns [].
  await page.locator('[id*="FinancialsSummaryLV"]').first()
    .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  await page.locator('[id*="RemainingReserves"]').first()
    .waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

  // The Financials Summary is a tree grid. The top-level node is a "Claim Total"
  // aggregate row; individual reserve line rows are children underneath it.
  // Iterate ALL [role="row"] elements that contain a RemainingReserves cell,
  // skip the aggregate row, and return the first child row with a positive balance.
  const rows = await page.evaluate(() => {
    const results = [];
    for (const row of document.querySelectorAll('[role="row"]')) {
      const reserveEl = row.querySelector('[id*="RemainingReserves"]');
      if (!reserveEl) continue;
      const amountRaw = reserveEl.innerText.trim();
      if (!amountRaw || !/\d/.test(amountRaw)) continue;
      const tds = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim()).filter(t => t);
      const rowId = row.getAttribute('id') || '';
      results.push({ tds, amountRaw, rowId });
    }
    return results;
  }).catch(() => []);

  for (let i = 0; i < rows.length; i++) {
    const { tds, amountRaw, rowId } = rows[i];
    const numeric = Number(amountRaw.replace(/[^0-9.-]/g, ''));
    const firstCell = tds.find(c => c.length > 0) || '';
    console.log('findFirstPositiveReserveLine: row[' + i + '] id=' + rowId.slice(-30) + ' cells=' + JSON.stringify(tds) + ' remaining=' + numeric);

    // Skip the "Claim Total" aggregate row (it sums all exposures — not a real reserve line)
    if (/claim total/i.test(firstCell)) continue;
    if (Number.isNaN(numeric) || numeric <= 0) continue;

    return { amount: numeric, rowIndex: i, firstCell };
  }

  // Fall back to the EXPOSURES grid. The Financials Summary scan above returned
  // zero rows on claims that demonstrably have reserves - PA-PA-01-26-0000385
  // carried $1,200.00 and $600.00 on its exposures (FNOL creates them) yet this
  // logged no rows at all, so its [id*="FinancialsSummaryLV"] / [role="row"]
  // selectors simply do not match this screen. The exposures grid exposes the
  // same "Remaining Reserves" column and IS proven readable - claimSnapshot's
  // reader pulls those exact values - so use it rather than reporting "no
  // reserve" for a claim that has one. Reserves created by FNOL are the normal
  // case here: the same-day rule (VTDMPL61) blocks adding a SECOND one, which
  // means the FNOL reserve is usually the only line a payment can target.
  console.log('findFirstPositiveReserveLine: Financials Summary yielded ' + rows.length +
              ' row(s) — falling back to the Exposures grid');
  await openExposuresTab(page).catch(() => {});
  const expRows = await page.evaluate(() => {
    const headers = [...document.querySelectorAll('.x-column-header-text')]
      .map(h => (h.textContent || '').trim());
    const idxOf = (re) => headers.findIndex(h => re.test(h));
    const remIdx = idxOf(/remaining\s*reserves/i);
    const covIdx = idxOf(/^coverage$/i);
    const clmIdx = idxOf(/^claimant$/i);
    if (remIdx < 0) return { error: 'no Remaining Reserves column', headers, rows: [] };
    const out = [];
    for (const row of document.querySelectorAll('tr.x-grid-row')) {
      if (!row.offsetParent) continue;
      const cells = [...row.querySelectorAll('.x-grid-cell')].map(c => (c.textContent || '').trim());
      if (!cells.some(Boolean)) continue;
      // -1 for the leading checkbox column, same offset the other readers use.
      const val = cells[remIdx - 1] || '';
      if (!/\d/.test(val)) continue;
      out.push({
        remaining: val,
        coverage: cells[covIdx - 1] || '',
        claimant: cells[clmIdx - 1] || '',
      });
    }
    return { headers, rows: out };
  }).catch(() => ({ rows: [] }));

  for (let i = 0; i < (expRows.rows || []).length; i++) {
    const r = expRows.rows[i];
    const numeric = Number(r.remaining.replace(/[^0-9.-]/g, ''));
    console.log('findFirstPositiveReserveLine (exposures): row[' + i + '] ' + JSON.stringify(r) +
                ' remaining=' + numeric);
    if (Number.isNaN(numeric) || numeric <= 0) continue;
    // The payment wizard's Reserve Line dropdown is keyed on the COVERAGE
    // label, which is what firstCell must carry.
    return { amount: numeric, rowIndex: i, firstCell: r.coverage || r.claimant };
  }

  throw new Error('findFirstPositiveReserveLine: no positive remaining reserve found. ' +
    'Financials Summary matched ' + rows.length + ' row(s); Exposures grid matched ' +
    ((expRows.rows || []).length) + ' row(s)' +
    (expRows.error ? ' (' + expRows.error + ')' : '') +
    (expRows.headers ? '. Exposures columns seen: ' + JSON.stringify(expRows.headers) : ''));
}

// ── editReserve (cloud) ─────────────────────────────────────────────────────
// Drills into a Financials Summary row's remaining-reserves $ link, opens that
// reserve's transaction row, clicks Edit, sets the amount, and Saves.
// rowIndex/transactionIndex match the LiveView's positional ids (…LV-0-…), i.e.
// the Nth row as currently displayed - not a stable business key.
async function editReserve(page, { rowIndex = 0, transactionIndex = 0, reserveAmount }) {
  await openFinancialsTab(page);

  const reserveLink = page.locator(
    `#ClaimFinancialsSummary-ClaimFinancialsSummaryScreen-financialsPanel-FinancialsSummaryPanelSet-FinancialsSummaryLV-${rowIndex}-RemainingReserves_button`
  );
  await reserveLink.click();

  const txRow = page.locator(
    `#ClaimFinancialsTransactions-ClaimFinancialsTransactionsScreen-TransactionsLV-${transactionIndex}-TType`
  );
  await txRow.getByRole('link', { name: 'Reserve' }).click();

  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: '$' }).fill(String(reserveAmount));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

// ── createReserveOnPrem ────────────────────────────────────────────────────
// CONFIRMED via a complete real user recording (create exposure w/ incident
// -> assign -> create reserve, all in one session). The real flow is:
// select the exposure row's checkbox in the Exposures grid, then click the
// grid's own "Create Reserve" TOOLBAR button (a real, stable id - this was
// actually my very first guess before several detours through wrong Actions-
// menu-based paths). That opens "New Reserve Set": click the "-" amount
// placeholder, fill it (dynamic input id, targets :focus), blur via
// #centerPanel, pick a Loss, then Update. No Cost Type/Category fields exist
// on this screen at all (unlike what earlier guesses assumed).
async function createReserveOnPrem(page, { reserveAmount, lossOption, exposureRowText }) {
  // Always navigate to Exposures first — callers may leave the page on
  // Financials > Summary (e.g. after getAvailableReserveAmount), and the
  // checkbox locator below is only valid on the Exposures grid.
  await openExposuresTab(page);
  // Select the exposure row's checkbox.
  // exposureRowText (confirmed via live recording): the system blocks adding
  // a second reserve to the SAME exposure on the same day, so tests that
  // already created a reserve on one exposure need to target a DIFFERENT one
  // instead of always grabbing the first checkbox blindly.
  // .last() when matching by exposureRowText - confirmed via live failure
  // that some claims already have their OWN pre-existing exposure with the
  // same coverage text (e.g. a default "Medical Payments" exposure created
  // at FNOL), making a fresh one we just added via addExposureByCoverage a
  // SECOND, ambiguous match. The newly-added one is always the most recent,
  // i.e. the last matching row in the grid - target that instead of
  // requiring the text to be uniquely present.
  const checkbox = exposureRowText
    ? page.getByRole('row', { name: exposureRowText }).getByRole('img').last()
    : page.locator('img.x-grid-checkcolumn').first();
  // .count() does NOT poll/wait (same gotcha hit repeatedly elsewhere in this
  // project with .isVisible()) - it's an instant snapshot, so checking it
  // right after navigating to the Exposures grid can catch the checkbox
  // column before it's actually rendered, wrongly reporting 0 matches even
  // when the checkbox is clearly there a moment later (confirmed via live
  // screenshot). Wait for it to actually appear first.
  await checkbox.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  const checkboxCount = await checkbox.count().catch(() => 0);
  console.log('Reserve checkbox: exposureRowText=' + (exposureRowText || '(none)') + ' matched ' + checkboxCount + ' element(s)');
  const hasCheckbox = checkboxCount > 0;
  let checked = false;
  if (hasCheckbox) {
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    // Confirmed via a real user recording: a genuine Playwright .click()
    // (real synthetic mouse event) checks this exposure-grid checkcolumn
    // reliably - a raw JS-dispatched el.click() was tried here and
    // consistently failed to toggle it (checked stayed false every time),
    // unlike the FNOL wizard's own vehicle/parties checkboxes where the raw
    // approach was needed instead. Different grid, different behavior -
    // don't assume the same fix applies everywhere.
    for (let attempt = 0; attempt < 3 && !checked; attempt++) {
      await checkbox.click();
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(400);
      checked = await checkbox.evaluate(el => el.className.includes('x-grid-checkcolumn-checked')).catch(() => false);
    }
  }
  console.log('Reserve checkbox checked:', checked);

  // The Exposures GRID's "Create Reserve" toolbar button only exists on the
  // dedicated Exposures screen. WC-style claims have no Exposures nav item at
  // all (openExposuresTab falls back to the Summary page's grid), and that
  // grid carries no such toolbar - the unconditional click here then burned the
  // full 30s action timeout. Those claims expose "Reserve" in the claim Actions
  // menu instead, so fall back to it.
  const gridBtn = page.locator('[id="ClaimExposures:ClaimExposuresScreen:ClaimExposures_CreateReserve"]');
  const hasGridBtn = await gridBtn.waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true).catch(() => false);
  if (hasGridBtn) {
    await gridBtn.click();
  } else {
    console.log('createReserveOnPrem: no Exposures-grid "Create Reserve" button — using Actions > Reserve');
    await page.locator('[id="Claim:ClaimMenuActions"]').click();
    await page.getByRole('menuitem', { name: 'Reserve', exact: true }).first().click();
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);

  // For a FRESH exposure (no prior reserve), ClaimCenter may NOT pre-select
  // the Reserve Line from the Exposures tab checkbox click. Explicitly set it
  // so the reserve is properly associated with the target coverage line.
  // This is a no-op when the dropdown is already pre-populated.
  if (exposureRowText) {
    const hasReserveLineCombo = await page.locator('[id*="ReserveLine"]').first()
      .waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
    if (hasReserveLineCombo) {
      await selectComboboxOnPrem(page, 'Reserve Line', exposureRowText, { random: false }).catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(300);
      console.log('Set Reserves: Reserve Line combobox found and set to:', exposureRowText);
    }
  }

  // Confirmed via live screenshot + user clarification: when the exposure
  // ALREADY has a reserve, "Create Reserve" doesn't open a fresh screen - it
  // adds a blank NEW row to the SAME "Set Reserves" grid that already shows
  // the existing reserve line. The blank row is NOT pre-selected - its own
  // checkbox must be checked first to enable "Remove". It's added AFTER the
  // existing row (confirmed via screenshot: existing row first, blank row
  // second), so its checkbox is the LAST checkcolumn image in the grid.
  // Confirmed via live DOM dump: the real, stable id is
  // "NewReserveSet:NewReserveSetScreen:Remove" (a span-based ExtJS button,
  // same "id, not role=button" pattern needed elsewhere in this app) -
  // more reliable than getByRole('button', {name:'Remove'}).
  const removeBtn = page.locator('[id="NewReserveSet:NewReserveSetScreen:Remove"]');
  // Playwright's .isEnabled() checks the HTML disabled/aria-disabled
  // attribute - confirmed via live diagnostic that it always returned true
  // here regardless of the button's real state, because ExtJS toolbar
  // buttons signal disabled purely via a CSS class ("x-btn-disabled" on an
  // ancestor), not via disabled/aria-disabled. Check that class instead.
  async function isExtJsButtonEnabled(locator) {
    return await locator.evaluate(el => {
      const btn = el.closest('.x-btn') || el;
      return !btn.className.includes('x-btn-disabled') && !btn.className.includes('x-item-disabled');
    }).catch(() => false);
  }

  // Scope the row/checkbox counting to the TARGET exposure specifically -
  // confirmed via live failure that this "Set Reserves" grid can show rows
  // for OTHER exposures too (this claim had 7 total data rows across all its
  // exposures), so a page-wide count comparison wrongly concluded "there's
  // an extra row to remove" just because SOME other exposure already had a
  // reserve, and removed the only row for THIS (genuinely fresh) exposure.
  const scopedRows = exposureRowText ? page.getByRole('row', { name: exposureRowText }) : null;
  const scopedCheckboxes = scopedRows ? scopedRows.locator('img.x-grid-checkcolumn') : page.locator('img.x-grid-checkcolumn');

  // Counts the rows of the reserve grid ITSELF (the panel owning the "New
  // Available Reserves" header), excluding summary/total rows. Defined here
  // rather than further down because the remove decision below depends on it.
  const reserveRowCount = async () => page.evaluate(() => {
    for (const headerCt of document.querySelectorAll('.x-grid-header-ct')) {
      if (!/New Available Reserves/i.test(headerCt.innerText || '')) continue;
      let panel = headerCt;
      for (let up = 0; up < 8 && panel && panel.parentElement; up++) {
        panel = panel.parentElement;
        const view = panel.querySelector('.x-grid-view');
        if (!view) continue;
        return [...view.querySelectorAll('tr.x-grid-row')]
          .filter(r => !/x-grid-row-summary/.test((r.className || '').toString())).length;
      }
    }
    return -1;   // grid not found at all
  }).catch(() => -1);

  const removeBtnAlreadyEnabled = await isExtJsButtonEnabled(removeBtn);
  console.log('Set Reserves: Remove button already enabled?', removeBtnAlreadyEnabled);
  if (!removeBtnAlreadyEnabled) {
    const gridCheckboxCount = await scopedCheckboxes.count().catch(() => 0);
    // Without an exposureRowText this used to count `.gw-currency-positive`
    // PAGE-WIDE, which is not a row count at all - it returned 7 on a grid
    // holding exactly one row, so the "row count > checkbox count" test below
    // was true, Remove fired, and it deleted the ONLY row. The grid was then
    // empty, the code Added a fresh row that is not bound to any exposure, and
    // no amount typed into it would ever stick. That is the whole CA/CP/BOP
    // reserve failure: the guard immediately below ("only one fresh row
    // present - filling it in directly") was correct all along and simply
    // never fired. Count the reserve grid's own rows instead.
    const gridRowCount = scopedRows
      ? await scopedRows.count().catch(() => 0)
      : Math.max(await reserveRowCount(), 0);
    console.log('Set Reserves: grid checkbox count =', gridCheckboxCount, '| data row count =', gridRowCount);
    // Confirmed via live diagnostic: only the newly-added BLANK row gets its
    // own checkbox at all - an already-saved existing row has none. BUT if
    // this is a genuinely FRESH exposure with no prior reserve at all,
    // "Create Reserve" adds exactly ONE row total (the one to fill in), and
    // it ALSO gets a checkbox - blindly removing it (as an earlier version
    // did) left the grid completely empty instead of ready to fill in. Only
    // remove when there's an existing (checkbox-less) row ALONGSIDE the new
    // one, i.e. row count is greater than checkbox count, FOR THIS EXPOSURE.
    if (gridCheckboxCount > 0 && gridRowCount > gridCheckboxCount) {
      await scopedCheckboxes.last().click();
      const lastChecked = await scopedCheckboxes.last().evaluate(el => el.className).catch(() => '(unknown)');
      console.log('Set Reserves: last checkbox className after click =', lastChecked);
      for (let i = 0; i < 10; i++) {
        if (await isExtJsButtonEnabled(removeBtn)) break;
        await page.waitForTimeout(200);
      }
    } else {
      console.log('Set Reserves: only one (fresh) row present - filling it in directly, not removing');
    }
  }
  const removeBtnEnabled = await isExtJsButtonEnabled(removeBtn);
  console.log('Set Reserves: Remove button enabled after checkbox click?', removeBtnEnabled);
  if (removeBtnEnabled) {
    await removeBtn.click();
    await page.waitForTimeout(300);
    // Confirmed via live failure: this test's user account can lack the
    // "Delete reserves" permission entirely - clicking Remove then shows
    // "User doesn't have permission: [Delete reserves]" instead of actually
    // removing anything. That's harmless here (the extra blank row just
    // won't be saved since it has no changes, per this screen's own stated
    // behavior: "Any line item with no change...will not be saved") - don't
    // let it block the rest of the flow, just uncheck the row again so it
    // doesn't interfere with the Save click later.
    const permissionDenied = await page.getByText(/doesn't have permission/i)
      .first().waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
    if (permissionDenied) {
      console.log('Set Reserves: user lacks "Delete reserves" permission - leaving blank row unchanged instead');
      await scopedCheckboxes.last().click().catch(() => {});
      await page.waitForTimeout(300);
    } else {
      console.log('Removed blank auto-added reserve row - editing existing row instead');
    }
  }

  // Amount cell: existing reserves show the current value as .gw-currency-positive;
  // fresh reserves (no prior value) show "$0.00" or "-" which may render as
  // .gw-currency-zero. Try .gw-currency-positive first (the proven case for
  // existing reserves); fall back to any [class*="gw-currency"] cell so that
  // a brand-new reserve whose amount displays as zero is also editable.
  // Scope to the LAST matching row first (same reasoning as the checkbox
  // above - our target exposure is always the most recently added when its
  // coverage text collides with a pre-existing exposure), THEN find that
  // specific row's own currency cell.
  // The Set Reserves grid opens EMPTY on a fresh claim - confirmed on BOP:
  // the panel owning the "New Available Reserves" header reported 0 rows, no
  // empty-text message, and the screen's toolbar carries an "Add" button. A
  // reserve row has to be created before any amount cell exists, so the old
  // code went straight to hunting for a currency cell that could never be
  // there and burned the full action timeout on BOP, CA and CP alike.
  let rows = await reserveRowCount();
  if (rows === 0) {
    console.log('Set Reserves: grid is empty - clicking Add to create a reserve row');
    const addById = page.locator('[id="NewReserveSet:NewReserveSetScreen:Add"]');
    if (await addById.isVisible().catch(() => false)) {
      await addById.click().catch(() => {});
    } else {
      // ExtJS toolbar buttons are <span class="x-btn">, which getByRole does
      // not match - the same reason Remove is targeted by id elsewhere here.
      await page.locator('.x-btn').filter({ hasText: /^Add$/ }).first().click().catch(() => {});
    }
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    for (let i = 0; i < 10 && rows <= 0; i++) {
      await page.waitForTimeout(500);
      rows = await reserveRowCount();
    }
    console.log('Set Reserves: reserve rows after Add = ' + rows);
  }

  // Tag the reserve grid's OWN last row so everything below can be scoped to
  // it. Without this, `rowScope` fell back to the whole `page` whenever no
  // exposureRowText was given - which is every commercial LOB (CA/CP/BOP all
  // call createReserve with just an amount). Two things then went wrong at
  // once, and both were silent:
  //   * `.gw-currency-positive` matched a currency cell in some OTHER grid on
  //     the page, so the amount was typed into an unrelated cell.
  //   * `targetRow` stayed null, and fillGridCostCombo opens with
  //     `if (!targetRow) return`, so Cost Type / Cost Category were never
  //     filled at all.
  // The result was a reserve that reported success and saved nothing:
  // E2E-CA-002 "passed" in 6.8s on CA-OH-85-26-0000373 having logged no
  // amount-fill and no save, and the Financials Summary then had no positive
  // reserve line for the payment step to pay against.
  // Same panel-climbing lookup reserveRowCount already uses.
  //
  // Callable more than once ON PURPOSE. ExtJS re-renders the grid row whenever
  // one of its inline editors is used, which destroys these data-* attributes:
  // tagging once up front and then touching the Cost Type cell left the amount
  // lookup with "(no tagged amount candidates in the DOM)". Re-tag immediately
  // before each interaction that depends on the markers.
  const tagReserveGrid = () => page.evaluate(() => {
    for (const headerCt of document.querySelectorAll('.x-grid-header-ct')) {
      if (!/New Available Reserves/i.test(headerCt.innerText || '')) continue;
      let panel = headerCt;
      for (let up = 0; up < 8 && panel && panel.parentElement; up++) {
        panel = panel.parentElement;
        const view = panel.querySelector('.x-grid-view');
        if (!view) continue;
        // Summary/total rows are NOT editable. Recovery reserves elsewhere in
        // this file already exclude ".x-grid-row-summary" for the same reason;
        // tagging "the last row" blindly could land on one, which is a cell
        // that will never enter edit mode no matter how it is clicked.
        const rows = [...view.querySelectorAll('tr.x-grid-row')]
          .filter(r => !/x-grid-row-summary/.test((r.className || '').toString()));
        if (!rows.length) return false;
        for (const r of view.querySelectorAll('[data-e2e-reserve-row]')) {
          r.removeAttribute('data-e2e-reserve-row');
        }
        // Last non-summary row = the one just added, same convention as before.
        rows[rows.length - 1].setAttribute('data-e2e-reserve-row', '1');

        // Tag EVERY candidate cell in the "New Available Reserves" column
        // rather than betting on one row. Which row is editable is not
        // knowable from the DOM up front - a freshly added row can render
        // alongside a placeholder or a total - so the caller clicks each
        // candidate in turn and keeps the one that actually opens an editor.
        // ExtJS stamps cells with "x-grid-cell-<headerId>", so the header's
        // own id maps straight to its column's cells.
        const header = [...document.querySelectorAll('.x-column-header')]
          .find(h => /New Available Reserves/i.test(h.innerText || ''));
        for (const c of document.querySelectorAll('[data-e2e-amount-candidate]')) {
          c.removeAttribute('data-e2e-amount-candidate');
        }
        if (!header || !header.id) return 'row';
        let n = 0;
        for (const row of rows) {
          const cell = [...row.querySelectorAll('*')]
            .find(el => (el.className || '').toString().includes(header.id));
          if (cell) cell.setAttribute('data-e2e-amount-candidate', String(n++));
        }
        return n ? 'row+' + n + 'cells' : 'row';
      }
    }
    return false;
  }).catch(() => false);

  let taggedReserveRow = await tagReserveGrid();
  console.log('Set Reserves: reserve-grid tagging = ' + taggedReserveRow);

  // Falls back to the tagged reserve-grid row so Cost Type / Cost Category are
  // still filled when the caller gave no exposureRowText - previously this
  // stayed null and fillGridCostCombo returned immediately.
  const targetRow = exposureRowText
    ? page.getByRole('row', { name: exposureRowText }).last()
    : (taggedReserveRow ? page.locator('[data-e2e-reserve-row="1"]') : null);

  const rowScope = exposureRowText
    ? page.getByRole('row', { name: exposureRowText }).last()
    : (taggedReserveRow ? page.locator('[data-e2e-reserve-row="1"]') : page);

  // Prefer the cells tagged by COLUMN above - they are the "New Available
  // Reserves" cells by construction. The currency-class heuristics below only
  // run when that tagging did not land, since they cannot tell an editable
  // column from a read-only one.
  let candidateCount = await page.locator('[data-e2e-amount-candidate]').count().catch(() => 0);
  let amountCell = page.locator('[data-e2e-amount-candidate]').first();
  let hasPositiveCell = candidateCount > 0 &&
    await amountCell.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  if (hasPositiveCell) {
    console.log('Set Reserves: ' + candidateCount + ' New Available Reserves cell(s) located by column id');
  } else {
    amountCell = rowScope.locator('.gw-currency-positive').first();
    hasPositiveCell = await amountCell.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
  }
  if (!hasPositiveCell) {
    console.log('Set Reserves: no .gw-currency-positive cell found - falling back to any gw-currency cell (fresh reserve)');
    amountCell = rowScope.locator('[class*="gw-currency"]').first();
  }
  // BOP and CP have no gw-currency cell at all here, so the click below burned
  // the full 30s action timeout with nothing to show for it. Standalone probes
  // could not reproduce the screen (openExistingClaim leaves the page in a
  // different state), so dump what this screen ACTUALLY offers from inside the
  // real flow - the same tactic that turned the opaque Surcharging and
  // close-exposure failures into exact rule codes.
  let hasAnyCurrency = await amountCell.waitFor({ state: 'visible', timeout: 4000 })
    .then(() => true).catch(() => false);

  if (!hasAnyCurrency) {
    // Locate the cell via its COLUMN ID. ExtJS stamps every cell with
    // "x-grid-cell-<headerId>", so the header element's own id maps directly to
    // its cells - no assumption about row structure at all.
    //
    // This is needed because the row-based lookup below fails here: the reserve
    // grid's data rows are not "tr.x-grid-row" on this screen. That selector
    // instead matched the LEFT NAV items ("Summary", "Workplan", "Loss
    // Details"...), so the lookup reported "header found but no visible rows"
    // and the click then burned the full action timeout on BOP, CA and CP.
    const byColumnId = await page.evaluate(() => {
      const header = [...document.querySelectorAll('.x-column-header')]
        .find(h => /New Available Reserves/i.test(h.innerText || ''));
      if (!header || !header.id) return null;
      // Any tag, not just td - this grid does not render its cells as <td>.
      const cells = [...document.querySelectorAll('[class*="' + header.id + '"]')]
        .filter(el => el.offsetParent !== null && el !== header && !header.contains(el));
      if (!cells.length) {
        // Report what the grid's cells DO look like so the next attempt is not
        // another guess.
        const sample = [...document.querySelectorAll('[class*="x-grid-cell"]')]
          .filter(el => el.offsetParent !== null)
          .slice(0, 4)
          .map(el => el.tagName + '.' + (el.className || '').toString().slice(0, 70));
        return { headerId: header.id, cells: 0, sample };
      }
      // Last row = the line just added/selected, same convention as elsewhere.
      const cell = cells[cells.length - 1];
      cell.setAttribute('data-e2e-amount-cell', '1');
      return { headerId: header.id, cells: cells.length };
    }).catch(() => null);

    if (byColumnId && byColumnId.cells) {
      console.log('Set Reserves: located amount cell via column id ' + byColumnId.headerId +
                  ' (' + byColumnId.cells + ' cell(s))');
      amountCell = page.locator('[data-e2e-amount-cell="1"]').first();
      hasAnyCurrency = await amountCell.waitFor({ state: 'visible', timeout: 4000 })
        .then(() => true).catch(() => false);
    } else if (byColumnId) {
      console.log('Set Reserves: column id ' + byColumnId.headerId + ' matched no visible cells. ' +
                  'Grid cells actually look like: ' + JSON.stringify(byColumnId.sample || []));
    }
  }

  if (!hasAnyCurrency) {
    // Fall back to locating the amount cell by COLUMN POSITION instead of by
    // currency class. The gw-currency classes are only applied once the cell
    // holds a value: on a FRESH reserve "New Available Reserves" is empty/"-",
    // so no gw-currency element exists and the class-based lookup finds nothing
    // (confirmed on CP - the grid itself was fine, "data row count = 7" with the
    // row checkbox checked, and the screen dump reported cellClasses: []).
    // PA only worked because its cell already showed $5,000.00.
    const located = await page.evaluate(() => {
      const diag = [];
      for (const headerCt of document.querySelectorAll('.x-grid-header-ct')) {
        const headers = Array.from(headerCt.querySelectorAll('.x-column-header-text'))
          .map(h => (h.innerText || '').trim());
        const idx = headers.findIndex(h => /^New Available Reserves$/i.test(h));
        if (idx < 0) continue;
        // Climb to the GRID PANEL, don't assume headerCt.parentElement holds the
        // rows. ExtJS renders the header container and the row view as separate
        // subtrees, so the previous parentElement lookup found zero rows and
        // this whole fallback silently bailed (confirmed: "located amount cell"
        // never logged while the header was plainly present in the dump).
        let panel = headerCt;
        let rows = [];
        for (let up = 0; up < 6 && panel; up++, panel = panel.parentElement) {
          rows = Array.from(panel.querySelectorAll('tr.x-grid-row'))
            .filter(r => r.offsetParent !== null);
          if (rows.length) break;
        }
        diag.push('hdrs=' + headers.length + ' rows=' + rows.length);
        if (!rows.length) continue;
        // Last row = the line just added/selected, same convention used above.
        const row = rows[rows.length - 1];
        const cells = Array.from(row.querySelectorAll('td'));
        // Rows may carry a leading checkbox cell with no header entry, so align
        // from the end rather than assuming a 1:1 header/cell mapping.
        const cell = cells[cells.length - headers.length + idx] || cells[idx];
        if (!cell) continue;
        cell.setAttribute('data-e2e-amount-cell', '1');
        return { headers: headers.join(' | '), idx, rows: rows.length, cells: cells.length };
      }
      return { failed: true, diag };
    }).catch(() => null);
    if (located && located.failed) {
      console.log('Set Reserves: column lookup found the header but no visible rows under it -> ' +
                  JSON.stringify(located.diag));
    }
    if (located && !located.failed) {
      console.log('Set Reserves: located amount cell by column "New Available Reserves" ' +
                  '(col ' + located.idx + ', ' + located.rows + ' row(s), ' + located.cells + ' cells)');
      amountCell = page.locator('[data-e2e-amount-cell="1"]').first();
      hasAnyCurrency = await amountCell.waitFor({ state: 'visible', timeout: 4000 })
        .then(() => true).catch(() => false);
    }
  }

  if (!hasAnyCurrency) {
    const dump = await page.evaluate(() => {
      const headerCts = Array.from(document.querySelectorAll('.x-grid-header-ct'))
        .map(h => Array.from(h.querySelectorAll('.x-column-header-text'))
          .map(x => (x.innerText || '').trim()).filter(Boolean).join(' | '))
        .filter(Boolean);
      const rows = Array.from(document.querySelectorAll('tr.x-grid-row'))
        .filter(r => r.offsetParent !== null)
        .map(r => (r.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 6);
      const btns = [...new Set(Array.from(document.querySelectorAll('.x-btn'))
        .filter(b => b.offsetParent !== null)
        .map(b => (b.innerText || '').trim()).filter(Boolean))].slice(0, 20);
      const cellClasses = [...new Set(Array.from(document.querySelectorAll('td'))
        .filter(td => td.offsetParent !== null && /\d/.test(td.innerText || ''))
        .map(td => (td.className || '').split(' ').filter(c => /currency|numeric|amount|cell-inner/i.test(c)).join('.'))
        .filter(Boolean))].slice(0, 10);
      // The reserve grid's OWN panel: the generic sweeps above match the left
      // nav tree (its items are also tr.x-grid-row), which made the reserve
      // grid look like it had rows when the rows found belonged to the nav.
      // Read the panel that actually owns the "New Available Reserves" header.
      let panelText = '(panel not found)';
      let panelRows = -1;
      let emptyText = null;
      for (const headerCt of document.querySelectorAll('.x-grid-header-ct')) {
        if (!/New Available Reserves/i.test(headerCt.innerText || '')) continue;
        let panel = headerCt;
        for (let up = 0; up < 8 && panel && panel.parentElement; up++) {
          panel = panel.parentElement;
          if (/x-panel|x-grid/.test(panel.className || '')) {
            const view = panel.querySelector('.x-grid-view');
            if (!view) continue;
            panelRows = view.querySelectorAll('tr.x-grid-row').length;
            panelText = (view.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
            const empty = view.querySelector('.x-grid-empty');
            emptyText = empty ? (empty.innerText || '').trim() : null;
            break;
          }
        }
        break;
      }
      return { headerCts, rows, btns, cellClasses, panelRows, panelText, emptyText };
    }).catch(() => null);
    console.log('Set Reserves: NO currency cell found. Screen dump -> ' + JSON.stringify(dump));
  }

  // Cost Type / Cost Category MUST be set before the amount. On a freshly-added
  // row CC leaves the "New Available Reserves" cell non-editable until the row
  // identifies which reserve it is - clicking it does nothing at all and the
  // activeElement stays TD, which is exactly the observed failure:
  //   Target cell: {"tag":"TD","cls":"...x-grid-cell-gridcolumn-4174","text":"-"}
  // on CA/CP/BOP, all of which Add a blank row. PA only ever worked because its
  // row already existed with a cost type set and an amount showing, so the
  // ordering bug was invisible there. These calls used to run AFTER the amount
  // fill, i.e. always too late for a new row.
  // (fillGridCostCombo is a hoisted function declaration further down.)
  await fillGridCostCombo('Cost Type', 'CostType', 0);
  await fillGridCostCombo('Cost Category', 'CostCategory', 0);
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  // Re-tag: the cost-combo edits above re-render the row and strip the markers
  // set earlier, leaving the amount locators matching nothing.
  taggedReserveRow = await tagReserveGrid();
  console.log('Set Reserves: re-tagged after cost combos = ' + taggedReserveRow);
  candidateCount = await page.locator('[data-e2e-amount-candidate]').count().catch(() => 0);
  if (candidateCount > 0) amountCell = page.locator('[data-e2e-amount-candidate]').first();

  // The editor input carries a STABLE name attribute - "NewAvailableReserves"
  // - confirmed from the live dump. Unlike the injected data-* markers it
  // survives the grid's constant re-rendering, so it is the reliable signal for
  // "the editor is open", far better than activeElement (which came back as an
  // empty string once the row re-rendered mid-check).
  const amountEditor = page.locator('input[name="NewAvailableReserves"]:visible').first();
  const editorIsOpen = () => amountEditor.count().then(n => n > 0).catch(() => false);

  // Re-tag before EVERY attempt: any interaction with this grid can re-render
  // the row and strip the markers, so a marker read even a second old may
  // already match nothing.
  const openEditor = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await editorIsOpen()) return true;
      await tagReserveGrid();
      const cell = page.locator('[data-e2e-amount-candidate]').first();
      if (!await cell.count().then(n => n > 0).catch(() => false)) {
        await page.waitForTimeout(400);
        continue;
      }
      await cell.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
      if (await editorIsOpen()) return true;
      await cell.dblclick({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
      if (await editorIsOpen()) return true;
    }
    return await editorIsOpen();
  };

  const editorOpened = await openEditor();
  const focused = editorOpened ? 'INPUT' : '';
  if (editorOpened) console.log('Set Reserves: amount editor is open (input[name=NewAvailableReserves])');
  if (focused !== 'INPUT' && focused !== 'TEXTAREA') {
    // Report WHICH cell refused to open, so the next attempt is not a guess.
    const cellInfo = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('[data-e2e-amount-candidate]')];
      if (!cells.length) return '(no tagged amount candidates in the DOM)';
      // Report every candidate AND its row, so the next step is informed by
      // what the grid really contains rather than another guess.
      return JSON.stringify(cells.map(c => ({
        cand: c.getAttribute('data-e2e-amount-candidate'),
        cls: (c.className || '').toString().slice(0, 80),
        text: (c.innerText || '').trim().slice(0, 24),
        rowCls: (c.closest('tr') ? (c.closest('tr').className || '').toString() : '').slice(0, 80),
        rowText: (c.closest('tr') ? (c.closest('tr').innerText || '') : '').replace(/\s+/g, ' ').trim().slice(0, 120),
      })));
    }).catch(() => '(unreadable)');
    // NEW failure shape confirmed on PA: zero candidates across all 4 retries,
    // not one bad cell as seen before on CA - i.e. tagReserveGrid() itself
    // never found the "New Available Reserves" header/grid at all this time.
    // This run's reserve step is the first to run immediately after the new
    // Validate Claim + Exposures submenu-drilling (several menu hovers + two
    // Escape presses right before it) - possibly leftover overlay/focus state
    // from that, possibly unrelated. Capture ground truth instead of guessing
    // a connection: what screen is actually on-screen right now.
    const screenState = await page.evaluate(() => ({
      url: location.href.slice(-80),
      title: (document.title || '').slice(0, 80),
      visibleHeaders: [...document.querySelectorAll('.x-column-header-text')]
        .filter(h => h.offsetParent).map(h => h.textContent.trim()).slice(0, 15),
      openMenus: [...document.querySelectorAll('.x-menu')].filter(m => m.offsetParent).length,
      visibleMasks: [...document.querySelectorAll('.x-mask')]
        .filter(m => getComputedStyle(m).display !== 'none' && getComputedStyle(m).visibility !== 'hidden').length,
    })).catch(() => null);
    console.log('Set Reserves: amount-edit failure — screen state -> ' + JSON.stringify(screenState));
    await page.screenshot({ path: 'results/set-reserves-no-candidates.png' }).catch(() => {});
    throw new Error('Reserve amount cell never entered edit mode (activeElement stayed ' + focused +
                    '). Target cell: ' + cellInfo + '. Screen: ' + JSON.stringify(screenState) +
                    '. Screenshot: results/set-reserves-no-candidates.png');
  }
  // Fill the editor by its stable name, not `:focus` - the row can re-render
  // between opening the editor and typing, which moves focus elsewhere and
  // sent the value into whatever happened to be focused instead.
  await amountEditor.fill(String(reserveAmount)).catch(async () => {
    await page.locator(':focus').fill(String(reserveAmount)).catch(() => {});
  });
  // Commit the ExtJS cell editor with Enter. Clicking elsewhere (#centerPanel)
  // does NOT commit it - confirmed from a live dump taken at this exact point:
  //   openEditors: [{"name":"NewAvailableReserves","value":"5000","focused":false}]
  //   row cells:   [..., "New Available Reserves" = "", ...]
  // i.e. the typed value sat in an abandoned editor while the grid cell stayed
  // empty, so Save wrote a reserve of nothing. Enter commits and closes the
  // editor; Tab is a fallback for editors that ignore Enter.
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(300);
  const stillEditing = await page.evaluate(() =>
    [...document.querySelectorAll('input')].some(i => i.offsetParent &&
      /NewAvailableReserves/i.test(i.getAttribute('name') || '') && i.value)
  ).catch(() => false);
  if (stillEditing) {
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForTimeout(300);
  }
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  // Read the amount back. The fill above targets whatever cell happened to be
  // in edit mode, so "we clicked something and typed" is not evidence the
  // reserve amount actually landed - that assumption is what let E2E-CA-002
  // report success on a claim with no reserve at all. Compare on digits only:
  // the cell renders as "$5,000.00" while reserveAmount is 5000.
  const amountLanded = await page.evaluate((expected) => {
    const want = String(expected).replace(/[^0-9]/g, '');
    const row = document.querySelector('[data-e2e-reserve-row="1"]');
    const scope = row || document;
    for (const el of scope.querySelectorAll('[class*="gw-currency"], .x-grid-cell, input')) {
      const raw = el.tagName === 'INPUT' ? (el.value || '') : (el.innerText || '');
      if (!raw.trim()) continue;
      const digits = raw.replace(/[^0-9]/g, '');
      // "$5,000.00" -> "500000"; accept either the exact digits or the
      // digits with a trailing ".00" stripped.
      if (digits === want || digits === want + '00') return raw.trim();
    }
    return null;
  }, reserveAmount).catch(() => null);
  if (amountLanded) {
    console.log('Set Reserves: amount ' + reserveAmount + ' confirmed in the grid as "' + amountLanded + '"');
  } else {
    // Ground truth, not inference. Repeated attempts to reason about why the
    // amount does not stick have each been wrong, so dump what the screen
    // actually contains at this exact moment: every cell of the reserve grid
    // with its column header, plus any editor input still open, plus a
    // screenshot. Cheap, and only on the failure path.
    const dump = await page.evaluate(() => {
      const out = { headers: [], rows: [], openEditors: [], banners: [] };
      for (const headerCt of document.querySelectorAll('.x-grid-header-ct')) {
        if (!/New Available Reserves/i.test(headerCt.innerText || '')) continue;
        out.headers = [...headerCt.querySelectorAll('.x-column-header-text')]
          .map(h => (h.innerText || '').trim()).filter(Boolean);
        let panel = headerCt;
        for (let up = 0; up < 8 && panel && panel.parentElement; up++) {
          panel = panel.parentElement;
          const view = panel.querySelector('.x-grid-view');
          if (!view) continue;
          for (const r of view.querySelectorAll('tr.x-grid-row')) {
            out.rows.push({
              cls: (r.className || '').toString().slice(0, 60),
              cells: [...r.querySelectorAll('.x-grid-cell')].map(c => (c.innerText || '').trim()),
            });
          }
          break;
        }
        break;
      }
      for (const inp of document.querySelectorAll('input')) {
        if (!inp.offsetParent) continue;
        const n = inp.getAttribute('name') || inp.id || '';
        if (/reserve|amount|cost/i.test(n) || inp === document.activeElement) {
          out.openEditors.push({ name: n.slice(0, 60), value: inp.value, focused: inp === document.activeElement });
        }
      }
      out.banners = [...document.querySelectorAll('*')]
        .filter(e => e.offsetParent && /must not be|missing required|not allowed|Rule:/i.test(e.innerText || '') &&
                     (e.innerText || '').length < 200)
        .map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 3);
      return out;
    }).catch(() => null);
    console.log('Set Reserves: WARNING - could not read ' + reserveAmount +
                ' back from the reserve row after filling it. Screen state -> ' + JSON.stringify(dump));
    await page.screenshot({ path: 'results/set-reserves-amount-not-landed.png', fullPage: false }).catch(() => {});
    console.log('Set Reserves: screenshot -> results/set-reserves-amount-not-landed.png');
  }

  // Confirmed via live screenshot: when INCREASING an existing reserve, the
  // "Explanation for Increase"/Loss field can already be auto-populated
  // (e.g. "New Loss - Serious...") with no "<none>" left anywhere on the
  // page at all - the previous unconditional getByText('<none>') then hung
  // for the full 30s timeout waiting for something that no longer exists.
  // Only attempt this when a "<none>" placeholder is actually present.
  const noneField = page.getByText('<none>').first();
  const hasNoneField = await noneField.waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true).catch(() => false);
  if (hasNoneField) {
    await noneField.click();
    await page.waitForTimeout(300);
    const lossOptionLocator = lossOption
      ? page.getByRole('option', { name: lossOption })
      : page.getByRole('option', { name: /New Loss/i }).first();
    const hasLossOption = await lossOptionLocator.waitFor({ state: 'visible', timeout: 2000 })
      .then(() => true).catch(() => false);
    if (hasLossOption) {
      await lossOptionLocator.click();
    } else {
      await page.getByRole('option').first().click();
    }
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  }

  // Two different screens can appear here (confirmed via live screenshot):
  // a simpler "New Reserve Set" popup (submit button "Update"), or a grid-
  // based "Set Reserves" screen (submit button "Save", and which ALSO has
  // its own required Cost Type/Cost Category comboboxes per line - contrary
  // to an earlier assumption that no such fields existed on this screen at
  // all). Handle both instead of assuming one.
  // Confirmed via live failure: on the grid-based "Set Reserves" screen,
  // Cost Type/Cost Category are INLINE-EDIT grid cells, same as the Amount
  // cell above - they don't expose a real role=combobox at all until
  // actually clicked into edit mode first, so a plain getByRole('combobox')
  // existence check silently found nothing and skipped filling them,
  // leaving both "<none>" and blocking Save with "Missing required field".
  // targetRow is defined earlier, just after the reserve-grid tagging - the
  // cost combos have to run BEFORE the amount cell (see the note there).
  // Confirmed via a live DOM dump of the actual row: "Cost Type" and "Cost
  // Category" are the ONLY two "<none>"-showing cells on this row (New
  // Available Reserve / Currently Available etc. all show "-", not
  // "<none>"), left-to-right in that order (gridcolumn-3918 then -3919) -
  // position-based targeting was correct all along. The real gap was
  // matching the OPENED inline editor afterward: it's a real input but
  // exposes NO aria-label, so getByRole('combobox', {name}) never matched
  // it (confirmed via the same DOM dump - ExtJS grid headers don't carry
  // role=columnheader either, so a header-based lookup was a dead end too).
  // The input DOES carry a real `name="CostType"` HTML attribute though -
  // target that directly instead of guessing at accessible names.
  async function fillGridCostCombo(label, inputName, noneCellIndex) {
    if (!targetRow) return;
    const input = page.locator(`input[name="${inputName}"]`).first();
    let hasInput = await input.waitFor({ state: 'visible', timeout: 1000 }).then(() => true).catch(() => false);
    if (!hasInput) {
      // Locate the cell by its COLUMN, not by "the Nth <none> cell in the row".
      // Both callers passed noneCellIndex 0, so both targeted the SAME cell -
      // and on this grid the first "<none>" is "Explanation for
      // Increase/decrease", not Cost Type at all. Confirmed from a live row
      // dump: cells were [..., New Available Reserves "", Explanation "<none>",
      // Cost Type "<none>", Cost Category "<none>", ...], and both Cost fields
      // stayed "<none>" through two full passes. Tag by header id instead,
      // same technique used for the amount cell above.
      const tagged = await page.evaluate((label) => {
        const header = [...document.querySelectorAll('.x-column-header')]
          .find(h => new RegExp('^' + label + '$', 'i').test((h.innerText || '').trim()));
        if (!header || !header.id) return false;
        const row = document.querySelector('[data-e2e-reserve-row="1"]');
        if (!row) return false;
        for (const c of document.querySelectorAll('[data-e2e-cost-cell]')) {
          c.removeAttribute('data-e2e-cost-cell');
        }
        const cell = [...row.querySelectorAll('*')]
          .find(el => (el.className || '').toString().includes(header.id));
        if (!cell) return false;
        cell.setAttribute('data-e2e-cost-cell', '1');
        return true;
      }, label).catch(() => false);
      const noneCell = tagged
        ? page.locator('[data-e2e-cost-cell="1"]').first()
        : targetRow.locator('.x-grid-cell').filter({ hasText: '<none>' }).nth(noneCellIndex);
      const hasNoneCell = await noneCell.waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false);
      if (hasNoneCell) {
        // Confirmed via live failure: the click DOES open the inline editor,
        // but Playwright's own click auto-retry then keeps colliding with
        // that now-open editor overlay sitting on top of the very cell it
        // just clicked, throwing a timeout even though the editor opened
        // successfully on the first real attempt. force:true bypasses that.
        await noneCell.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(300);
        hasInput = await input.waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false);
      }
    }
    if (!hasInput) return;
    const currentValue = await input.inputValue().catch(() => '');
    if (currentValue && currentValue !== '<none>') return;
    // Click the now-focused editor input to open its dropdown, then pick a
    // real (non-placeholder) option via a genuine Playwright click on the
    // actual boundlist item - the same proven pattern used by
    // sweepComboboxesOnPrem elsewhere in this codebase, rather than
    // re-clicking through the generic selectComboboxOnPrem helper (which
    // re-clicks this already-open editor a SECOND time and can close the
    // very dropdown the first click just opened).
    await input.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    const container = page.locator('.x-boundlist').filter({ has: page.locator('.x-boundlist-item') }).last();
    const items = container.locator('.x-boundlist-item');
    const count = await items.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const t = (await items.nth(i).textContent().catch(() => '') || '').trim();
      if (t && t !== '<none>' && t.toLowerCase() !== 'none') {
        await items.nth(i).click().catch(() => {});
        break;
      }
    }
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    const afterValue = await input.inputValue().catch(() => '');
    if (!afterValue || afterValue === '<none>') {
      console.log(label + ' selection did not register after boundlist click');
    }
  }
  // Re-run after the amount fill as well: entering an amount can make CC
  // re-render the row and reset a cell that was set before it.
  await fillGridCostCombo('Cost Type', 'CostType', 0);
  await fillGridCostCombo('Cost Category', 'CostCategory', 0);

  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  const updateBtn = page.locator('[id="NewReserveSet:NewReserveSetScreen:Update"]');
  const saveBtn = page.getByRole('button', { name: 'Save', exact: true });
  const hasUpdateBtn = await updateBtn.waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true).catch(() => false);
  const submitBtn = hasUpdateBtn ? updateBtn : saveBtn;
  await submitBtn.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  // Confirmed via live failure: the reserve amount/fields can silently fail
  // to save with NO thrown error at all - the previous version just clicked
  // Save/Update and moved on, so the caller had no way to know the exposure
  // still showed "Remaining Reserves: -" afterward. Verify the submit button
  // actually disappeared (i.e. we left the Set Reserves screen); if not,
  // surface whatever validation banner is visible instead of silently
  // continuing.
  const stillOnSetReserves = await submitBtn.waitFor({ state: 'hidden', timeout: 8000 })
    .then(() => false).catch(() => true);
  if (stillOnSetReserves) {
    // Confirmed via live screenshot: neither generic CSS-class guesses NOR
    // the "Rule: <code>" pattern matched a plain "Cost Type : Missing
    // required field..." banner (same missing-required-field style seen
    // elsewhere in this app) - use the same reliable text-regex approach
    // already proven for that style, falling back to the "Rule:" pattern
    // for VTDMPL61-style business-rule violations.
    // Setup failures must THROW, not return. The "blocked by validation"
    // return path below is for EXPECTED business blocks that a caller chooses
    // to tolerate - callers ignore the return value, so routing a setup
    // failure through it would turn a real failure into a silent pass with an
    // unsaved reserve. "Please assign claim and exposure to save the reserve."
    // (confirmed via live screenshot on an unassigned claim - header showed
    // "Adj: Pending Assignment") is a setup failure: the claim was never
    // assigned after FNOL. It matched none of the patterns below and isn't a
    // "Rule:" message, so it previously fell through to the generic
    // "silently not saved" throw and hid a plainly-visible on-screen reason.
    const assignBanner = await page.getByText(/please assign claim and exposure/i)
      .first().textContent({ timeout: 2000 }).catch(() => null);
    if (assignBanner && assignBanner.trim()) {
      throw new Error(
        'Set Reserves blocked: claim is not assigned - "' + assignBanner.trim() + '". ' +
        'Call assignClaim(page) after completeFNOL() before creating reserves.'
      );
    }
    let bannerText = await page.getByText(/missing required field|must be|not allowed|exceeds|cannot be|doesn't have permission/i)
      .first().textContent().catch(() => null);
    if (!bannerText || !bannerText.trim()) {
      // Confirmed via live screenshot: rule violations (e.g. VTDMPL61) render
      // in a dedicated "Validation Results" panel below the grid, as
      // "Rule: <code>. <message>" text, not inside any of the generic
      // message-box/error CSS classes above.
      const ruleText = await page.locator('text=/Rule:\\s*\\w+/').first().textContent().catch(() => null);
      if (ruleText && ruleText.trim()) bannerText = ruleText;
    }
    if (bannerText && bannerText.trim()) {
      // A real validation message is on screen (e.g. "Reserve cannot be less
      // than paid amount") - this is an EXPECTED block for some test cases
      // (same-day reserve-below-paid-amount), not a silent-save failure.
      // Surface it via console and return the block reason so callers can
      // distinguish a blocked save (truthy) from a successful save (undefined).
      console.log('Set Reserves blocked by validation:', bannerText.trim());
      // Leaving the blocked Set Reserves screen open poisons the rest of the
      // session: the rejected reserve stays pending in the claim bundle and
      // its validation result then blocks UNRELATED saves further downstream.
      // Confirmed via live run - a reserve blocked by VTDMPL61 here caused the
      // later payment phase to fail with "Please complete the Surcharging
      // screen", and Surcharging's own Update silently refused to save on
      // every retry, while the Validation Results panel still displayed that
      // same VTDMPL61 rule. Probing the same claim on a fresh session showed
      // the Surcharging screen saving cleanly, confirming the carried-over
      // bundle state (not the screen) was at fault. Cancel to discard it.
      // Try role=button first, then the ExtJS .x-btn class. Buttons in this app
      // are inconsistent: Set Reserves' Save exposes role=button, but others
      // (Surcharging's Edit/Update, and Cancel here - confirmed via live log
      // "could not cancel blocked edit") are plain <span class="x-btn"> with no
      // role at all, which getByRole can never match.
      let cancelled = false;
      for (const cancelBtn of [
        page.getByRole('button', { name: 'Cancel', exact: true }).first(),
        page.locator('.x-btn').filter({ hasText: /^Cancel$/ }).first(),
      ]) {
        cancelled = await cancelBtn.waitFor({ state: 'visible', timeout: 3000 })
          .then(() => cancelBtn.click({ timeout: 5000 })).then(() => true).catch(() => false);
        if (cancelled) break;
      }
      if (cancelled) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await waitForAllMasksGone(page);
        console.log('Set Reserves: cancelled blocked edit to clear pending bundle state');
      } else {
        console.log('Set Reserves: WARNING - could not cancel blocked edit; ' +
                    'downstream steps may inherit the rejected reserve');
      }
      return bannerText.trim();
    }
    throw new Error(
      'Set Reserves did not navigate away after Save/Update and no validation banner was found - reserve was likely silently not saved'
    );
  }
}

// ── createReserveCloud ───────────────────────────────────────────────────────
// Mirrors the on-prem flow (Actions -> Reserve -> fill the reserve row -> Save)
// against the cloud markup, confirmed by probing a live claim rather than
// guessed:
//
//   menu item  Claim-ClaimMenuActions-ClaimMenuActions_NewTransaction-
//              ClaimMenuActions_NewTransaction_ReserveSet         (label "Reserve")
//   row fields NewReserveSet-NewReserveSetScreen-ReservesSummaryDV-
//              EditableReservesLV-<row>-{Exposure,CostType,CostCategory,
//                                        explanation,NewAvailableReserves}
//
// This replaces editReserve, which could never work here: it drills into a
// RemainingReserves_button on the Financials Summary, and that link only exists
// once a reserve is ALREADY present. On a fresh claim the summary grid holds
// nothing but headers, so the click timed out 15s and failed the run.
//
// Returns a block-reason string when CC refuses the save (same contract as
// on-prem, so callers can tolerate known business rules), or undefined on
// success.
const CLOUD_RESERVE_MENU_ITEM =
  'Claim-ClaimMenuActions-ClaimMenuActions_NewTransaction-ClaimMenuActions_NewTransaction_ReserveSet';
const CLOUD_RESERVE_ROW =
  'NewReserveSet-NewReserveSetScreen-ReservesSummaryDV-EditableReservesLV';

// Raises an EXISTING reserve rather than creating a new set. Needed on WC:
// FNOL already creates a reserve there (the exposure shows $1,000 remaining),
// and CC then renders Actions -> Reserve as aria-disabled="true" while leaving
// every other transaction action enabled. Creating one is simply not on offer,
// so the only way to reach the target amount is to edit what is there.
//
// The drill-down steps are the ones editReserve was codegen'd from against a
// live claim; only its precondition was wrong (it assumed a reserve already
// existed, which is false on a fresh CA/CP claim).
async function editReserveCloud(page, { reserveAmount }) {
  await openFinancialsTab(page);

  const links = page.locator('[id*="FinancialsSummaryLV-"][id$="-RemainingReserves_button"]');
  const appeared = await links.first().waitFor({ state: 'visible', timeout: 12000 })
    .then(() => true).catch(() => false);
  if (!appeared) return 'editReserveCloud: no remaining-reserves link on the Financials Summary';

  // Prefer a real reserve line over the "Claim Total" aggregate row.
  const count = await links.count().catch(() => 0);
  let target = links.first();
  for (let i = 0; i < count; i++) {
    const id = await links.nth(i).getAttribute('id').catch(() => '');
    const rowIdx = (id.match(/FinancialsSummaryLV-(\d+)-/) || [])[1];
    const rowText = await page.locator('[id$="FinancialsSummaryLV-' + rowIdx + '-FSRow"]')
      .innerText().catch(() => '');
    if (rowIdx && !/claim total/i.test(rowText)) { target = links.nth(i); break; }
  }
  await target.click().catch(() => {});
  await page.waitForTimeout(3000);

  const txLink = page.getByRole('link', { name: 'Reserve' }).first();
  if (await txLink.isVisible().catch(() => false)) {
    await txLink.click().catch(() => {});
    await page.waitForTimeout(2500);
  }

  const editBtn = page.getByRole('button', { name: 'Edit', exact: true }).first();
  if (!await editBtn.isVisible().catch(() => false)) {
    return 'editReserveCloud: reserve transaction opened but no Edit button was offered';
  }
  await editBtn.click().catch(() => {});
  await page.waitForTimeout(2000);

  const amount = page.getByRole('textbox', { name: '$' }).first();
  if (!await amount.isVisible().catch(() => false)) {
    return 'editReserveCloud: no editable amount field after Edit';
  }
  await amount.fill(String(reserveAmount)).catch(() => {});
  await page.getByRole('button', { name: 'Save', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(3000);


  const validation = await page.evaluate(() => {
    const p = document.getElementById('gw-south-panel');
    if (!p || !p.offsetParent) return '';
    return (p.innerText || '').replace(/\s+/g, ' ')
      .replace(/^\s*Validation Results\s*/i, '').replace(/^\s*Clear\s*/i, '').trim().slice(0, 300);
  }).catch(() => '');
  if (validation) {
    console.log('editReserveCloud: blocked by validation —', validation);
    return validation;
  }
  console.log('editReserveCloud: existing reserve raised to ' + reserveAmount);
  return undefined;
}

async function createReserveCloud(page, { reserveAmount, costType, costCategory }) {
  // Open the Actions menu, trying the same candidates the lifecycle helper
  // uses - a single getByRole attempt is not enough when the previous test
  // left the page mid-transition.
  // The Actions control is a TOGGLE. A menu left open by the previous step
  // means the first click CLOSES it, and the Reserve item then legitimately
  // is not on screen - which is exactly how this failed. Clear any open menu
  // first, and verify the item appeared rather than assuming the click opened
  // something.
  const menuItem = page.locator('[id="' + CLOUD_RESERVE_MENU_ITEM + '"]').first();
  let hasItem = false;
  for (let attempt = 0; attempt < 3 && !hasItem; attempt++) {
    for (let esc = 0; esc < 3; esc++) { await page.keyboard.press('Escape').catch(() => {}); }
    await page.waitForTimeout(400);

    // The claim-level Actions menu only carries "Reserve" while a claim is
    // actually open. Callers can arrive here from the Desktop (the claim-reuse
    // path ends there), where the Actions menu is the DESKTOP one - it opens
    // fine and simply has different items, so this looked like a missing menu
    // entry rather than a missing claim.
    const onClaim = await page.locator('[aria-label="deferred Actions"]').first()
      .isVisible().catch(() => false);
    if ((!onClaim || attempt > 0) && page._currentClaimNumber) {
      await openExistingClaim(page, page._currentClaimNumber).catch(() => {});
      await page.waitForTimeout(1200);
    }

    let clicked = false;
    for (const c of [
      page.locator('[aria-label="deferred Actions"]').first(),
      page.getByRole('button', { name: 'Actions' }).first(),
      page.locator('.gw-action--inner[aria-haspopup="true"]').first(),
    ]) {
      if (!await c.isVisible().catch(() => false)) continue;
      await c.click().catch(() => {});
      await page.waitForTimeout(1200);
      clicked = true;
      break;
    }
    if (!clicked) return 'createReserveCloud: could not find the claim Actions control';

    hasItem = await menuItem.waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true).catch(() => false);

    // Visible is not the same as usable. On WC, CC renders this item with
    // aria-disabled="true" because the claim already has a reserve from FNOL -
    // clicking it does nothing, the menu just closes, and the failure surfaced
    // much later as "no editable reserve row appeared".
    if (hasItem) {
      const disabled = await menuItem.locator('.gw-action--inner').first()
        .getAttribute('aria-disabled').catch(() => null);
      if (disabled === 'true') {
        console.log('createReserveCloud: CC has disabled Actions > Reserve on this claim ' +
                    '(a reserve already exists) — editing the existing reserve instead');
        for (let esc = 0; esc < 2; esc++) await page.keyboard.press('Escape').catch(() => {});
        return editReserveCloud(page, { reserveAmount });
      }
    }
    if (!hasItem) {
      // The New Transaction group may need expanding before its leaves exist.
      const group = page.locator('[id="Claim-ClaimMenuActions-ClaimMenuActions_NewTransaction"]').first();
      if (await group.isVisible().catch(() => false)) {
        await group.hover().catch(() => {});
        await page.waitForTimeout(900);
        hasItem = await menuItem.isVisible().catch(() => false);
      }
    }
  }
  if (!hasItem) {
    const ctx = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('[role="heading"]')]
        .filter(e => e.offsetParent).map(e => (e.textContent || '').trim()).slice(0, 3);
      const items = [...document.querySelectorAll('[role="menuitem"]')]
        .filter(e => e.offsetParent)
        .map(e => { const l = e.querySelector('.gw-label'); return (l && l.getAttribute('aria-label')) || e.id; })
        .slice(0, 15);
      return { url: location.href.slice(-60), heads, items };
    }).catch(() => ({}));
    return 'createReserveCloud: the Actions menu has no "Reserve" item. On screen: ' +
           JSON.stringify(ctx);
  }
  // Expand the New Transaction group BEFORE clicking the leaf. On WC the leaf
  // reports visible while its submenu is still collapsed, so the click landed
  // on an inert element: the menu closed, the page stayed on the claim Summary,
  // and the failure surfaced later as "no editable reserve row appeared".
  // Clicking the inner role="button" is what actually fires the action (same
  // anatomy as the Update button: gw-label inside .gw-action--inner).
  // WAIT for the screen, do not sample for it. An instant isVisible() right
  // after the click reads false while the screen is still rendering, and the
  // recovery path then fired needlessly - clicking Add (adding a second, empty
  // reserve row) and re-opening the menu, which broke a CP reserve that had
  // been saving correctly.
  const waitForReserveScreen = (ms) =>
    page.locator('[name*="EditableReservesLV"]').first()
      .waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);

  let opened = false;
  for (let tries = 0; tries < 2 && !opened; tries++) {
    if (tries > 0) {
      // Only on retry: expand the New Transaction group first. On WC the leaf
      // reports visible while its submenu is still collapsed, so the first
      // click lands on an inert element - the menu closes and the page stays
      // on the claim Summary.
      const group = page.locator('[id="Claim-ClaimMenuActions-ClaimMenuActions_NewTransaction"]').first();
      if (await group.isVisible().catch(() => false)) {
        await group.hover().catch(() => {});
        await page.waitForTimeout(900);
      }
    }
    // The inner role="button" is what fires the action (same anatomy as the
    // Update button: a gw-label inside .gw-action--inner).
    const inner = menuItem.locator('.gw-action--inner').first();
    const target = await inner.isVisible().catch(() => false) ? inner : menuItem;
    await target.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    opened = await waitForReserveScreen(tries === 0 ? 12000 : 8000);

    if (!opened && tries === 0) {
      // Re-open the Actions menu for the retry - the failed click closed it.
      for (let esc = 0; esc < 2; esc++) await page.keyboard.press('Escape').catch(() => {});
      const actions = page.locator('[aria-label="deferred Actions"]').first();
      if (await actions.isVisible().catch(() => false)) {
        await actions.click().catch(() => {});
        await page.waitForTimeout(1000);
      }
    }
  }

  // Wait for the editable row rather than sampling for it - the screen renders
  // asynchronously, and an instant check here would report "no row" while it
  // was still being built.
  // Find the editable row instead of assuming row 0. On a claim that already
  // has a reserve (WC, where FNOL creates one), row 0 is that EXISTING reserve
  // and renders without an Exposure select - the blank row is row 1. Waiting on
  // "-0-Exposure" therefore waited for a control that never exists, clicked Add
  // needlessly, and reported "no editable reserve row appeared" on a screen
  // that was fully open.
  const findEditableRow = async () => page.evaluate(() => {
    const idx = [...document.querySelectorAll('select')]
      .filter(e => e.offsetParent && !e.disabled)
      .map(e => ((e.getAttribute('name') || '').match(/EditableReservesLV-(\d+)-Exposure$/) || [])[1])
      .filter(v => v !== undefined)
      .map(Number);
    return idx.length ? Math.max(...idx) : null;   // newest/blank row
  }).catch(() => null);

  let rowIdx = null;
  for (let i = 0; i < 12 && rowIdx === null; i++) {
    rowIdx = await findEditableRow();
    if (rowIdx === null) await page.waitForTimeout(1000);
  }
  if (rowIdx === null) {
    await page.getByRole('button', { name: 'Add', exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(2500);
    rowIdx = await findEditableRow();
  }
  if (rowIdx === null) return 'createReserveCloud: no editable reserve row appeared on the New Reserve screen';
  console.log('createReserveCloud: editing reserve row ' + rowIdx);

  // Pick the requested cost type/category when CC offers a matching option,
  // otherwise the first real one. The callers pass on-prem codes ('CLPD',
  // 'ClaimCost') while cloud shows display text ('Claim Cost'), so match
  // loosely instead of demanding an exact hit.
  const pickSelect = async (field, wanted) => {
    const sel = page.locator('[name="' + CLOUD_RESERVE_ROW + '-' + rowIdx + '-' + field + '"]');
    // These dropdowns CASCADE, and selecting one RE-RENDERS the row. An
    // isVisible() gate before the wait therefore returned false while the row
    // was being rebuilt, and the field was skipped entirely - Cost Category was
    // left blank (it does have options) and Save was refused with no message.
    // Wait for visible AND populated together.
    let real = [];
    for (let i = 0; i < 16; i++) {
      if (await sel.isVisible().catch(() => false)) {
        const opts = await sel.locator('option').allTextContents().catch(() => []);
        real = opts.map(o => o.trim()).filter(o => o && !/^<?none>?$/i.test(o));
        if (real.length) break;
      }
      await page.waitForTimeout(500);
    }
    if (!real.length) {
      console.log('createReserveCloud: "' + field + '" never offered a selectable option');
      return null;
    }
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
    const match = wanted ? real.find(o => norm(o) === norm(wanted) || norm(o).includes(norm(wanted))) : null;
    const choice = match || real[0];
    await sel.selectOption({ label: choice }).catch(() => {});
    await page.waitForTimeout(500);
    return choice;
  };

  const exposure = await pickSelect('Exposure');
  const type     = await pickSelect('CostType', costType);
  const category = await pickSelect('CostCategory', costCategory);

  // Cost Category is required, and on WC's medical-only exposure CC offers no
  // category at all for the chosen exposure/cost-type combination - so Save can
  // never succeed on this screen. That claim already has a reserve from FNOL,
  // so raise that one instead of leaving a half-filled row behind.
  if (!category) {
    console.log('createReserveCloud: no Cost Category available for exposure "' + exposure +
                '" / cost type "' + type + '" — falling back to editing the existing reserve');
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true }).first();
    if (await cancel.isVisible().catch(() => false)) {
      await cancel.click().catch(() => {});
      await page.waitForTimeout(2500);
    }
    return editReserveCloud(page, { reserveAmount });
  }
  await pickSelect('explanation');
  console.log('createReserveCloud: exposure="' + exposure + '" costType="' + type +
              '" costCategory="' + category + '"');

  const amount = page.locator('[name="' + CLOUD_RESERVE_ROW + '-' + rowIdx + '-NewAvailableReserves"]');
  await amount.fill(String(reserveAmount)).catch(() => {});
  await page.waitForTimeout(400);

  await page.getByRole('button', { name: 'Save', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(3000);

  // A refusal here is often silent - no message, just a control CC has flagged
  // (the Cost Category cascade was one). Fix what the widget state names and
  // press Save once more before reporting failure.
  if (await page.locator('[name="' + CLOUD_RESERVE_ROW + '-' + rowIdx + '-Exposure"]')
        .isVisible().catch(() => false)) {
    const fixed = await fixCloudInvalidControls(page).catch(() => []);
    if (fixed.length) {
      await page.getByRole('button', { name: 'Save', exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(3000);
    }
  }

  // CC states refusals in the docked Validation Results worksheet
  // (#gw-south-panel), not inline on the field and not in a dialog.
  const validation = await page.evaluate(() => {
    const p = document.getElementById('gw-south-panel');
    if (!p || !p.offsetParent) return '';
    return (p.innerText || '').replace(/\s+/g, ' ')
      .replace(/^\s*Validation Results\s*/i, '').replace(/^\s*Clear\s*/i, '').trim().slice(0, 300);
  }).catch(() => '');

  const stillOpen = await page.locator('[name="' + CLOUD_RESERVE_ROW + '-' + rowIdx + '-Exposure"]')
    .isVisible().catch(() => false);

  if (validation && stillOpen) {
    console.log('createReserveCloud: blocked by validation —', validation);
    return validation;
  }
  if (stillOpen) {
    return 'createReserveCloud: Save pressed but the reserve screen is still open with no validation text';
  }
  console.log('createReserveCloud: reserve of ' + reserveAmount + ' saved');
  return undefined;
}

async function createReserve(page, opts) {
  if (!IS_ON_PREM) {
    return createReserveCloud(page, opts);
  }
  // Confirmed via live recording: reserve creation is Actions -> "Reserve",
  // not a per-exposure-row context menu (the old exposureRowText-gated
  // dispatch was based on a wrong assumption) - always use the real flow now.
  return createReserveOnPrem(page, opts);
}

// ── createPayment (cloud) ────────────────────────────────────────────────────
// Not a "Payments sub-tab > New Payment" button - it's the claim-level
// Actions ▾ menu > "New Payment (Formerly System Draft)" wizard, 3 steps:
//   1. Payee (Name dropdown) -> Next
//   2. Reserve Line, Transaction Type, Total Amount, Category, Box Number,
//      Memo Phrase, (re-confirm) Total Amount -> Next
//   3. A Yes/No radio (purpose unconfirmed - recorded as "No") -> Finish
// payeeName/reserveLine/transactionType/category/boxNumber/memoPhrase are all
// optional - any left unset auto-selects the first non-blank dropdown option
// (see selectByLabelOrFirst), since the old on-prem call sites have no concept
// of these fields and there's no safe way to guess a "correct" business value.
// Fills the inline address editor the payment wizard's Payees screen exposes
// behind its Edit button. Field names confirmed against a live wizard:
//   ...GlobalAddressInputSet-{AddressLine1,City,State,PostalCode,Country}
// A claimant created by FNOL has no address, and without one the wizard will
// not advance - silently.
async function addCloudPayeeAddress(page) {
  const edit = page.getByRole('button', { name: 'Edit', exact: true }).first();
  if (await edit.isVisible().catch(() => false)) {
    await edit.click().catch(() => {});
    await page.waitForTimeout(2500);
  }

  const fillIfEmpty = async (suffix, value) => {
    const el = page.locator('[name$="GlobalAddressInputSet-' + suffix + '"]').first();
    if (!await el.isVisible().catch(() => false)) return;
    const cur = await el.inputValue().catch(() => 'x');
    if ((cur || '').trim()) return;
    await el.fill(value).catch(() => {});
    await page.waitForTimeout(300);
  };
  await fillIfEmpty('AddressLine1', '123 Main St');
  await fillIfEmpty('City', 'Columbus');
  await fillIfEmpty('PostalCode', '43004');

  const state = page.locator('[name$="GlobalAddressInputSet-State"]').first();
  if (await state.isVisible().catch(() => false)) {
    const cur = await state.inputValue().catch(() => '');
    if (!cur || cur === '<none>') {
      const opts = await state.locator('option').evaluateAll(
        os => os.map(o => ({ v: o.value, t: (o.textContent || '').trim() }))).catch(() => []);
      // Prefer the claim's own state so the address is at least plausible.
      const want = opts.find(o => /^ohio$/i.test(o.t) || o.v === 'OH')
                || opts.find(o => o.v && !/^<?none>?$/i.test(o.t));
      if (want) await state.selectOption(want.v).catch(() => {});
      await page.waitForTimeout(400);
    }
  }
  console.log('addCloudPayeeAddress: address filled for the payee');
}

// Completes the claim data that CC requires before it will offer ANY reserve
// line to pay against (on-prem).
//
// Confirmed from a live Step 2 screenshot: Reserve Line sat on <none> with an
// empty option list while the Validation Results panel listed
//   On "(N) 3rd Party Bodily Injury Liability - <claimant>":
//     Exposure description must not be empty
//     Detailed body part must not be null
//   On "Contacts":
//     The claimant's primary address must have a street, city and state
// An empty Reserve Line is therefore a SYMPTOM - the payment cannot be made
// until the exposures and the claimant contact are complete. Same shape as the
// cloud "Ability to Pay" failure.
//
// Returns the list of things it fixed.
async function completeOnPremExposureData(page) {
  const fixed = [];

  await openExposuresTab(page).catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  // Open each exposure in turn via its row link and complete the two fields CC
  // names. Row count is read first because opening an exposure re-renders the
  // grid and invalidates any held locators.
  // Address exposures by their OWN ids. "tr.x-grid-row" matches the LEFT NAV
  // on this screen (its items render as grid rows too - confirmed: the rows
  // found were Summary/Workplan/Loss Details/...), so the previous iteration
  // walked nav items and never opened a single exposure. That is why this pass
  // only ever reported "fixed claimant primary address".
  const expLinks = page.locator('[id^="ClaimExposures:ClaimExposuresScreen:ExposuresLV:"][id$=":Type"]');
  const rowCount = await expLinks.count().catch(() => 0);
  console.log('completeOnPremExposureData: ' + rowCount + ' exposure(s) on the claim');
  for (let i = 0; i < rowCount; i++) {
    const link = page.locator('[id="ClaimExposures:ClaimExposuresScreen:ExposuresLV:' + i + ':Type"]').first();
    if (!await link.isVisible().catch(() => false)) continue;
    await link.click().catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(600);

    const edit = page.locator('.x-btn').filter({ hasText: /^Edit$/ }).first();
    if (await edit.isVisible().catch(() => false)) {
      await edit.click().catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    }

    const desc = page.getByRole('textbox', { name: /Exposure Description/i }).first();
    if (await desc.isVisible().catch(() => false)) {
      if (!((await desc.inputValue().catch(() => 'x')) || '').trim()) {
        await desc.fill('Automated E2E exposure description').catch(() => {});
        fixed.push('exposure[' + i + '].Exposure Description');
      }
    }

    // "Detailed body part" is an ExtJS combobox, so it needs the project's own
    // combobox driver rather than selectOption.
    await selectComboboxOnPrem(page, 'Detailed Body Part', undefined, { random: false })
      .then(() => fixed.push('exposure[' + i + '].Detailed Body Part'))
      .catch(() => {});

    const update = page.locator('.x-btn').filter({ hasText: /^Update$/ }).first();
    if (await update.isVisible().catch(() => false)) {
      await update.click().catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    }
    await openExposuresTab(page).catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  }

  // "The claimant's primary address must have a street, city and state" - the
  // lifecycle helper already implements this repair for on-prem.
  try {
    const { fixMissingPartyAddress } = require('./claimLifecycleHelper');
    await fixMissingPartyAddress(page);
    fixed.push('claimant primary address');
  } catch (_) { /* helper unavailable - reported via `fixed` being shorter */ }

  console.log('completeOnPremExposureData: fixed ' + (fixed.length ? fixed.join(', ') : '(nothing found to fix)'));
  return fixed;
}

async function createPaymentCloud(page, {
  payeeName, reserveLine, transactionType, checkAmount,
  category, boxNumber, memoPhrase,
}) {
  await page.getByRole('button', { name: 'deferred Actions' }).click();
  await page.getByLabel('New Payment (Formerly System').click();

  // CC filters the Step 2 "Reserve Line" list BY PAYEE. Letting the payee
  // default to the first option (the insured company) while the reserve sits
  // on a claimant's exposure left Reserve Line empty, which in turn left the
  // line-item Category and Amount fields disabled - the payment then died on a
  // 15s timeout against a control that was never going to enable. When no
  // payee is given, prefer the one matching the reserve line we intend to pay.
  // CC may answer with a "New Payment Error" page (claim has not passed the
  // "Ability to Pay" validation level) instead of the payee form. Detect that
  // and fix the underlying claim data rather than timing out against a form
  // that was never rendered.
  // WAIT for one of the two possible outcomes - the payee form or the error
  // page. Sampling isVisible() straight after the click read false simply
  // because nothing had rendered yet, so the recovery never ran.
  const payeeName_ = page.locator('[name$="PrimaryPayee_Name"]').first();
  const errorText  = page.getByText('New Payment Error', { exact: false }).first();
  await Promise.race([
    payeeName_.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
    errorText.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
  ]);
  const errorPage = await errorText.isVisible().catch(() => false);
  if (errorPage) {
    const why = await page.evaluate(() => {
      const p = document.getElementById('gw-south-panel');
      return p && p.offsetParent ? (p.innerText || '').replace(/\s+/g, ' ').slice(0, 300) : '';
    }).catch(() => '');
    console.log('createPaymentCloud: CC refused to open the wizard — ' + (why || '(no validation text)'));

    if (/injury description/i.test(why)) {
      await completeCloudLossDetails(page);
      // Re-open the wizard now the claim can pass Ability to Pay.
      await page.getByRole('button', { name: 'deferred Actions' }).click().catch(() => {});
      await page.waitForTimeout(1200);
      await page.getByLabel('New Payment (Formerly System').click().catch(() => {});
      await page.waitForTimeout(3000);
    } else {
      throw new Error('createPaymentCloud: claim failed the "Ability to Pay" validation — ' +
                      (why || 'no validation text'));
    }
  }

  const chosenPayee = await selectByLabelOrFirst(page, 'Name', payeeName || reserveLine);
  console.log('createPaymentCloud: payee — ' + chosenPayee);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(2500);

  // Verify we actually LEFT the Payees screen. A claimant with no mailing
  // address makes Next a no-op - no error, no dialog, the wizard just stays
  // put. Every field read after that then reported "no selectable options",
  // which looked like an empty Reserve Line rather than a step that never
  // advanced. CC's own remedy is the Payees screen's Edit button, which opens
  // an inline address editor (Address_Picker defaults to __new).
  const reserveLineSel = page.locator('[name$="ReserveLineInputSet-ReserveLine"]');
  let onStep2 = await reserveLineSel.isVisible().catch(() => false);
  if (!onStep2) {
    console.log('createPaymentCloud: still on the Payees screen — adding the missing payee address');
    await addCloudPayeeAddress(page);
    await page.getByRole('button', { name: 'Next' }).click().catch(() => {});
    await page.waitForTimeout(3000);
    onStep2 = await reserveLineSel.isVisible().catch(() => false);
  }
  if (!onStep2) {
    throw new Error('createPaymentCloud: the wizard would not advance past the Payees screen for payee "' +
                    chosenPayee + '" (payee address still incomplete?)');
  }

  await selectByLabelOrFirst(page, 'Reserve Line', reserveLine);
  await selectByLabelOrFirst(page, 'Transaction Type', transactionType);
  await page.getByRole('textbox', { name: 'Total Amount of Check' }).fill(String(checkAmount));
  // Dismisses the dropdown's click-overlay so subsequent fields are clickable.
  await page.locator('#gw-click-overlay').click().catch(() => {});
  await selectByLabelOrFirst(page, 'CategoryCategory', category);
  await page.getByRole('textbox', { name: '$' }).fill(String(checkAmount));
  await selectByLabelOrFirst(page, 'Box Number', boxNumber);
  await selectByLabelOrFirst(page, 'Memo Phrase', memoPhrase);
  await page.getByRole('textbox', { name: 'Total Amount of Check' }).fill(String(checkAmount));
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 3's question is a gw-radioDiv (role="radio" divs carrying aria-label),
  // not a native radio, and getByRole('radio', {name:'No'}) simply timed out
  // against it for 15s. Reuse the same answering used on the exposure and
  // incident screens, which handles both the role="radiogroup" case and the
  // loose Yes/No pair case.
  await answerCloudRadioGroups(page).catch(() => {});
  await answerUnansweredYesNoPairs(page).catch(() => {});

  // VERIFY the step actually advanced. When CC refuses step 2 the wizard simply
  // stays put, Finish never renders, and the run blamed a missing Finish button
  // instead of the rejection that caused it. Fix what CC flags and retry.
  const finish = page.getByRole('button', { name: 'Finish' }).first();
  let onFinal = await finish.waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true).catch(() => false);

  for (let attempt = 0; attempt < 2 && !onFinal; attempt++) {
    const why = await page.evaluate(() => {
      const p = document.getElementById('gw-south-panel');
      return p && p.offsetParent ? (p.innerText || '').replace(/\s+/g, ' ').slice(0, 300) : '';
    }).catch(() => '');
    console.log('createPaymentCloud: wizard did not reach the final step' +
                (why ? ' — ' + why : ' — no validation text; checking widget state'));

    await fixCloudInvalidControls(page).catch(() => {});
    await answerCloudRadioGroups(page).catch(() => {});
    await answerUnansweredYesNoPairs(page).catch(() => {});
    await page.getByRole('button', { name: 'Next' }).first().click().catch(() => {});
    onFinal = await finish.waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true).catch(() => false);
  }

  if (!onFinal) {
    const why = await page.evaluate(() => {
      const p = document.getElementById('gw-south-panel');
      return p && p.offsetParent ? (p.innerText || '').replace(/\s+/g, ' ').slice(0, 300) : '';
    }).catch(() => '');
    throw new Error('createPaymentCloud: the payment wizard never reached its final step. ' +
                    (why ? 'CC says: ' + why : 'CC reported no validation text.'));
  }

  await finish.click();
}

// ── createPaymentOnPrem ──────────────────────────────────────────────────────
// Same underlying Guidewire wizard as createPaymentCloud (identical screen ids
// like "NormalCreateCheckWizard:Next" and matching field labels), confirmed via
// codegen up through "Total Amount of Check" on step 2 - recording stopped
// there. Everything from Category onward is EXTRAPOLATED from the cloud
// recording of this same wizard (see createPaymentCloud), not independently
// verified on-prem yet.
// ── ensureSurchargingComplete (on-prem) ──────────────────────────────────────
// Per user instruction: check the Surcharging screen before creating a
// payment - if any Yes/No radio group there is unanswered, select "No"
// (default) first, otherwise incomplete surcharging data can block the
// payment wizard. Same left-nav id convention as Exposures/Financials
// (Claim:MenuLinks:Claim_Claim<Section>).
async function ensureSurchargingComplete(page) {
  // Confirmed via live DOM dump: the real id has a "Group" suffix -
  // "Claim:MenuLinks:Claim_ClaimSurchargingGroup" - the previously guessed
  // "Claim:MenuLinks:Claim_ClaimSurcharging" (no "Group") never matched
  // anything, so this whole check was silently skipped every time and the
  // New Payment wizard would later hard-fail with "Please complete the
  // Surcharging screen" instead.
  const navItem = page.locator('[id="Claim:MenuLinks:Claim_ClaimSurchargingGroup"] div').filter({ hasText: /^Surcharging$/ });
  const hasNavItem = await navItem.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (!hasNavItem) {
    console.log('Surcharging nav item not found - skipping pre-payment check');
    return;
  }
  await navItem.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Confirmed via live screenshot: "Surcharge Exceptions" renders READ-ONLY
  // by default (radios not interactive) with an "Edit" button top and
  // bottom - must click Edit first before any radio click can register.
  // Confirmed via live DOM dump: this "Edit" button is a plain <span> with
  // NO role attribute at all (not a real role=button element), so
  // getByRole('button') never matched it - use the real ExtJS button CSS
  // class instead.
  // Timeout increased to 8s: on a loaded claim the Surcharging page renders
  // asynchronously and 3s was not enough for the Edit button to appear.
  const editBtn = page.locator('.x-btn').filter({ hasText: 'Edit' }).first();
  const hasEditBtn = await editBtn.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (hasEditBtn) {
    await editBtn.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    // ExtJS renders radio questions asynchronously after the mask hides;
    // wait for at least one "No" label to appear before counting all of them.
    await page.locator('label').filter({ hasText: /^No$/ }).first()
      .waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  } else {
    console.log('Surcharging: Edit button not found after 8s — may already be in edit mode');
  }

  // Per user instruction: select "No" for every radio group on this screen.
  // Confirmed via live DOM dump: there are NO real <input type="radio">
  // elements at all on this screen (0 matches for both role=radio and a raw
  // input[type=radio] query) - these are ExtJS radio fields whose native
  // input is visually hidden/replaced, exposed only via their visible <label>
  // text ("Yes"/"No"). Click by label text instead.
  // NOTE: clicking "No" for ALREADY-ANSWERED "Yes" questions can cause
  // server-side validation failure (some questions require "Yes" per claim
  // data). Only click "No" for questions NOT yet answered — detected by
  // checking whether a sibling element has the ExtJS checked class. If that
  // heuristic finds nothing, fall back to clicking all "No" labels.
  const noLabels = page.locator('label').filter({ hasText: /^No$/ });
  const noCount = await noLabels.count().catch(() => 0);
  let clickedCount = 0;
  for (let i = 0; i < noCount; i++) {
    const noLabel = noLabels.nth(i);
    // Check if this radio group is already answered: look for a "checked"
    // indicator near this label's parent container. ExtJS marks selected
    // radios with aria-checked or x-form-cb-checked on a sibling element.
    const alreadyAnswered = await noLabel.evaluate(el => {
      // Walk up to find a container that holds both Yes/No labels for this group
      let container = el.parentElement;
      for (let d = 0; d < 6 && container && container.tagName !== 'BODY'; d++) {
        const checked = container.querySelector('[aria-checked="true"], .x-form-cb-checked, input[type="radio"]:checked');
        if (checked) return true;
        container = container.parentElement;
      }
      return false;
    }).catch(() => false);
    if (!alreadyAnswered) {
      await noLabel.click().catch(() => {});
      clickedCount++;
    }
  }
  // Fallback: if nothing was clicked (heuristic found all already answered),
  // but the screen is in edit mode, click all No labels unconditionally so
  // we at least ensure nothing is left blank.
  // Gate on "are we actually in edit mode" rather than on hasEditBtn. When a
  // previous Update failed validation the screen STAYS in edit mode, so on the
  // retry pass there is no Edit button to find (only Update) - the old
  // hasEditBtn guard then skipped this fallback and the retry did literally
  // nothing ("clicked No for 0/12", confirmed via live log), making every
  // subsequent attempt a guaranteed repeat of the same failure.
  const inEditMode = hasEditBtn || await page.locator('.x-btn').filter({ hasText: 'Update' }).first()
    .waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
  if (clickedCount === 0 && inEditMode && noCount > 0) {
    for (let i = 0; i < noCount; i++) {
      await noLabels.nth(i).click().catch(() => {});
    }
    clickedCount = noCount;
  }
  console.log('Surcharging: clicked "No" for ' + clickedCount + '/' + noCount + ' radio group(s)');

  // Give ExtJS time to process all clicks before submitting.
  await page.waitForTimeout(500);

  // Confirmed via live screenshot: the submit button here is "Update", same
  // Edit/Update pattern as the Set Reserves screen - not "Save". Also a
  // plain non-role <span>, same as Edit above.
  // Timeout increased to 5s; if the screen is in view mode (nothing to update)
  // the Update button won't appear and we can safely skip.
  const updateBtn = page.locator('.x-btn').filter({ hasText: 'Update' }).first();
  const hasUpdateBtn = await updateBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (hasUpdateBtn) {
    await updateBtn.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    console.log('Surcharging: Update clicked');
    // Verify save succeeded: if still in edit mode (Update button still visible),
    // the save likely failed with a validation error.
    const updateStillVisible = await page.locator('.x-btn').filter({ hasText: 'Update' }).first()
      .waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
    if (updateStillVisible) {
      // The old dump was body.innerText.substring(0, 300), which only ever
      // captured the top nav + claim header - never the actual reason (see
      // live log: 300 chars of "Desktop|Search|Team|..."). Pull the real
      // validation text: CC renders it either in a "*:_msgs" panel or as
      // inline field errors, both of which sit well below the first 300 chars.
      const why = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('[id$="_msgs"], .x-form-invalid-msg, .message, .gw-message')) {
          const t = (el.innerText || '').trim();
          if (t && el.offsetParent !== null) out.push(t);
        }
        if (!out.length) {
          const body = document.body.innerText || '';
          for (const line of body.split('\n')) {
            const t = line.trim();
            // Skip question labels - this screen is full of Yes/No questions
            // whose text legitimately contains these words ("Underwriter review
            // required?"), and reporting one as the failure reason sends the
            // reader chasing a field that is working fine.
            if (t.endsWith('?')) continue;
            if (/required|must be|missing|invalid|cannot|not allowed|Rule:/i.test(t)) out.push(t);
          }
        }
        return out.slice(0, 15).join(' || ');
      }).catch(() => '');
      console.log('Surcharging: WARNING — Update button still visible after save. Validation text:',
        why || '(none found)');
    } else {
      console.log('Surcharging: saved OK (returned to view mode)');
    }
  } else {
    console.log('Surcharging: no Update button found — screen already in view/complete state');
  }
}

// ── createPaymentOnPrem ───────────────────────────────────────────────────────
// CONFIRMED via a real user recording (New Payment wizard, full 3-step flow
// through document linking and Finish). Step 1: payee Name. Step 2: Reserve
// Line, Transaction Type, Total Amount of Check, plus a coverage/cost
// allocation grid row needing its OWN amount filled in too (dynamic input id,
// same :focus-targeting pattern as the Reserves screen's amount cell) and a
// Yes/No radio. Step 3 (Check Instructions): link an existing document via
// "Button_Reserve_LinkDocument", pick a document row, a Send-To-style combo
// ("Do Not Send - internal use"), another Yes/No radio, then Finish.
async function createPaymentOnPrem(page, {
  payeeName, reserveLine, transactionType = 'Partial Payment', checkAmount, expectValidation = false, reserveLineSkipCount = 0, _retries = 0,
}) {
  // Confirmed via live failure: opening New Payment immediately after
  // creating a reserve can show an EMPTY Reserve Line dropdown (only
  // "<none>") - the freshly-created reserve hadn't yet propagated to this
  // wizard's data, even though the reserve itself was verified saved.
  // Reloading the claim page first forces a fresh read.
  // 30s cap: on a loaded claim after many prior test operations the on-prem
  // server can be very slow; without a cap the reload hangs the entire test.
  await page.reload({ timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  await page.locator('[id="Claim:ClaimMenuActions"]').click();
  await page.getByRole('menuitem', { name: 'New Payment (Formerly System' }).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // Reactive fallback for the proactive ensureSurchargingComplete check
  // above: confirmed via live screenshot that New Payment can still land on
  // a hard "New Payment Error - Please complete the Surcharging screen"
  // page. Per user instruction: go complete Surcharging (answer every radio
  // button) and retry opening New Payment, instead of failing outright.
  for (let attempt = 0; attempt < 4; attempt++) {
    // Confirmed via live failure: on the second wizard open (after a cancelled
    // first attempt), the server is slower and the Surcharging error page can
    // take >2000ms to render. A short timeout caused a silent miss, landing on
    // a page where the payee Name combobox was never visible. 8s is enough to
    // catch slow renders while still exiting quickly when the page is clean.
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    const surchargingError = await page.getByText('Please complete the Surcharging screen')
      .waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    if (!surchargingError) break;
    console.log('New Payment blocked by incomplete Surcharging screen - completing it and retrying');
    // Confirmed via live failure: this "Return to the claim (...)" text is
    // not exposed as an accessible role=link (same pattern as other plain
    // <a> elements in this app lacking a real href/role) - getByRole never
    // matched it. Use a plain text locator instead.
    await page.getByText(/Return to the claim/).first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await ensureSurchargingComplete(page);
    // After ensureSurchargingComplete, CC may redirect us back into a stale
    // wizard (left open by a previous expectValidation:true return). Detect
    // Step 2 by checking for the wizard Next/Back buttons. If we're inside the
    // wizard, cancel it so we're on a clean claim view before re-opening.
    const wizardStep2 = wizardNavButton(page, 'Next');
    if (await wizardStep2.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
      console.log('createPaymentOnPrem: detected stale wizard Step 2 after surcharging — cancelling');
      await cancelPaymentWizard(page);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    }
    await page.locator('[id="Claim:ClaimMenuActions"]').click();
    await page.getByRole('menuitem', { name: 'New Payment (Formerly System' }).click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  // Step 1 (payee) lives in a closure rather than inline because the wizard is
  // re-entered from scratch on every reload retry below, and re-entering lands
  // on Step 1 - not Step 2. Confirmed via live failure on CA-OH-85-26-0000371:
  // the retry loop reloaded, reopened New Payment, then looked only for the
  // Step-2 "Reserve Line" field, found nothing, and `continue`d - three times.
  // The run ended sitting on "Step 1 of 3: Enter payee information" with Name,
  // Type, Recipient and Mailing Address all still "<none>", having burned ~6
  // minutes on retries that had nothing to act on and could never have
  // succeeded. Re-running the payee step is what actually makes a retry a retry.
  const reserveLineField = page.getByRole('combobox', { name: 'Reserve Line', exact: true });

  async function fillPayeeStepAndAdvance() {
  // Confirmed via live failure/user feedback: a COMPANY/organization payee
  // (insurance agency, construction co, ...) only offers Vendor-related Type
  // options at all - there's no "Additional Insured" escape, and this small
  // policy's payee pool kept randomly re-landing on the same company every
  // time. Explicitly prefer a person-sounding name (no corporate suffix)
  // over letting generic random selection pick anything.
  const nameCombo = page.getByRole('combobox', { name: 'Name', exact: true });
  if (payeeName) {
    await selectComboboxOnPrem(page, 'Name', payeeName, { exact: true });
  } else {
    // Verify-and-retry, same pattern used elsewhere in this file: confirmed
    // via live failure that this picker can silently select nothing (Name
    // stayed "<none>") and the wizard then advanced to Step 2 anyway with no
    // payee set at all.
    let nameValue = await nameCombo.inputValue().catch(() => '');
    for (let attempt = 0; attempt < 3 && (!nameValue || nameValue === '<none>'); attempt++) {
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await nameCombo.click();
      await page.waitForTimeout(400);
      const picked = await page.evaluate(() => {
        const CORP_SUFFIX = /\b(INC|LLC|CO|CORP|GROUP|AGENCY|AGY|CONSTRUCTION|COMPANY|LTD)\b/i;
        // Scoped to the LAST VISIBLE .x-boundlist container, not just any
        // .x-boundlist-item on the page - same stale/hidden-boundlist bug
        // fixed elsewhere in this file (Memo Phrase) confirmed here too.
        const containers = Array.from(document.querySelectorAll('.x-boundlist')).filter(c => c.offsetParent !== null);
        const container = containers[containers.length - 1];
        if (!container) return null;
        const options = Array.from(container.querySelectorAll('.x-boundlist-item'))
          .filter(li => { const t = li.textContent.trim(); return t && t !== '<none>' && t.toLowerCase() !== 'none'; });
        const person = options.find(li => !CORP_SUFFIX.test(li.textContent));
        const target = person || options[0];
        if (!target) return null;
        const text = target.textContent.trim();
        target.click();
        return text;
      });
      console.log('Payee selected:', picked || '(none found)');
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      nameValue = await nameCombo.inputValue().catch(() => '');
    }
  }

  // Per user instruction: always default Type to "Additional Insured"
  // (rather than only switching away from Vendor/Other conditionally).
  const typeCombo = page.getByRole('combobox', { name: 'Type', exact: true });
  const hasTypeCombo = await typeCombo.waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true).catch(() => false);
  if (hasTypeCombo) {
    // Confirmed via live screenshot: the selection can silently fail to take
    // effect (Type stayed "Other" despite "Additional Insured" being a real,
    // visible option in the open dropdown) - verify and retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      const currentType = await typeCombo.inputValue().catch(() => '');
      if (currentType === 'Additional Insured') break;
      await selectComboboxOnPrem(page, 'Type', 'Additional Insured', { exact: true }).catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    console.log('Payee Type:', await typeCombo.inputValue().catch(() => '(unknown)'));
  }

  // Confirmed via live screenshot: a randomly-selected payee (e.g. a
  // claimant/party rather than a vendor) can be missing full mailing
  // address info, which blocks Step 1 from ever advancing ("Address 1/City/
  // State/ZIP Code: Missing required field") - Next silently does nothing
  // and every downstream field lookup times out waiting for a screen that
  // never arrives. Fill in placeholder address values if these fields are
  // present and required.
  const address1Field = page.getByRole('textbox', { name: 'Address 1', exact: true });
  const hasAddress1 = await address1Field.waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true).catch(() => false);
  if (hasAddress1) {
    await address1Field.fill('123 Main St');
    await page.getByRole('textbox', { name: 'City', exact: true }).fill('Philadelphia').catch(() => {});
    await selectComboboxOnPrem(page, 'State', 'PA', { exact: true }).catch(() => {});
    await page.getByRole('textbox', { name: 'ZIP Code', exact: true }).fill('19102').catch(() => {});
    console.log('Payee address was missing - filled in placeholder address');
  }

  // Confirmed via live screenshot: a DIFFERENT payee screen variant shows
  // "Recipient" (plain textbox) + "Mailing Address" (combobox picking a
  // real address record) instead of raw Address1/City/State/ZIP fields -
  // the Address1 check above doesn't fire for this variant, leaving Next
  // silently blocked ("Recipient"/"Mailing Address": Missing required
  // field).
  const recipientField = page.getByRole('textbox', { name: 'Recipient', exact: true });
  const hasRecipient = await recipientField.waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true).catch(() => false);
  if (hasRecipient) {
    const recipientValue = await recipientField.inputValue().catch(() => '');
    if (!recipientValue) await recipientField.fill(payeeName || 'Payee');
    await selectComboboxOnPrem(page, 'Mailing Address', undefined, { exact: true }).catch(() => {});
    console.log('Payee Recipient/Mailing Address filled (alternate payee screen variant)');
  }

  await clickWizardNav(page, 'Next');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  // Confirmed via live screenshot: Step 1 can silently fail to advance
  // (missing-field validation banners shown, Name/Recipient/Mailing Address
  // still empty) with no thrown error - every downstream Step 2 field
  // lookup then hangs waiting for a screen that never arrives. Verify Step 1
  // actually navigated away before proceeding.
  // Confirmed via TWO separate live failures that waiting for the Next
  // button to become HIDDEN is fundamentally unreliable here - the wizard
  // reuses the SAME "NormalCreateCheckWizard:Next" id on Step 2 too, so this
  // negative check can flip either way right at the transition boundary
  // regardless of the timeout used (8s and 15s both produced false
  // positives on genuinely-successful navigations). Use a POSITIVE check
  // instead - wait for a Step-2-only field ("Reserve Line") to appear.
  return await reserveLineField.waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true).catch(() => false);
  }

  if (!await fillPayeeStepAndAdvance()) {
    const banner = await page.locator('[class*="validation"], [class*="error"]').first()
      .textContent().catch(() => null);
    throw new Error(
      'New Payment Step 1 (payee) did not navigate away - a required field is likely still invalid' +
      (banner ? ' (banner: "' + banner.trim() + '")' : '')
    );
  }

  // Confirmed via live failure: the reserveLine value (a claimant name) can
  // fail to match any option AND the "fall back to first real option" path
  // can ALSO silently fail to actually select anything, leaving Reserve
  // Line on "<none>" - the wizard then let Next proceed anyway into a
  // payment with no reserve line, hitting "Partial payment not allowed
  // without open reserve" further downstream instead of failing loudly
  // right here. Verify and retry.
  let reserveLineValue = await reserveLineField.inputValue().catch(() => '');
  for (let attempt = 0; attempt < 3 && (!reserveLineValue || reserveLineValue === '<none>'); attempt++) {
    await selectComboboxOnPrem(page, 'Reserve Line', reserveLine, { random: !reserveLine, skip: reserveLineSkipCount });
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    reserveLineValue = await reserveLineField.inputValue().catch(() => '');
  }
  // An empty Reserve Line is usually a SYMPTOM, not a timing problem: CC will
  // not offer a line to pay while the exposures or the claimant contact fail
  // validation ("Exposure description must not be empty", "Detailed body part
  // must not be null", "The claimant's primary address must have a street, city
  // and state" - all confirmed from a live Step 2 screenshot). Repair the claim
  // data and re-read before falling through to the reload-and-wait path below,
  // which can only help when the cause really is propagation delay.
  if (!reserveLineValue || reserveLineValue === '<none>') {
    const why = await page.evaluate(() => {
      const t = (document.body.innerText || '') + ' ' + (document.body.textContent || '');
      return [...new Set([...t.matchAll(/([^\n]{0,80}(?:must not be empty|must not be null|must have a street)[^\n]{0,40})/gi)]
        .map(m => m[1].trim()))].slice(0, 4);
    }).catch(() => []);
    // Do NOT gate the repair on validation TEXT being present. At this point in
    // the wizard Next has not been pressed, so CC has not run validation yet and
    // there are no messages on screen - the text-gated version therefore never
    // fired. An empty Reserve Line is itself sufficient evidence that the claim
    // data is incomplete; the messages (when they exist) are only extra detail.
    {
      console.log('createPaymentOnPrem: Reserve Line has no selectable option' +
                  (why.length ? ' — CC reports: ' + why.join(' || ')
                              : ' (no validation text yet; repairing claim data anyway)'));
      await cancelPaymentWizard(page).catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
      const fixed = await completeOnPremExposureData(page).catch(() => []);

      // Only retry if this repair actually changed something NEW. Repeating a
      // repair that fixes the same item every time cannot change the outcome:
      // it fixed "claimant primary address" on all four attempts while the
      // exposure fields stayed untouched, and burned 12 minutes doing it.
      page._onPremRepairHistory = page._onPremRepairHistory || new Set();
      const fresh = fixed.filter(f => !page._onPremRepairHistory.has(f));
      for (const f of fixed) page._onPremRepairHistory.add(f);
      if (!fresh.length) {
        console.log('createPaymentOnPrem: the repair pass found nothing new to fix (' +
                    (fixed.join(', ') || 'nothing') + ') — retrying cannot help. ' +
                    'Reserve Line is still empty, so the claim data CC requires is ' +
                    'something this repair does not reach.');
      }
      if (fresh.length && _retries < 3) {
        console.log('createPaymentOnPrem: claim data repaired — restarting the payment wizard');
        return createPaymentOnPrem(page, {
          payeeName, reserveLine, transactionType, checkAmount, expectValidation,
          reserveLineSkipCount, _retries: _retries + 1,
        });
      }
    }
  }

  if (!reserveLineValue || reserveLineValue === '<none>') {
    // Confirmed via live failure: a JUST-created large reserve (e.g. $50k)
    // can genuinely have ZERO real options in this dropdown for a while -
    // not a mismatched-name issue (the "fall back to first real option"
    // path would have picked ANYTHING if one existed) but a real server-
    // side propagation delay. The 3 quick re-clicks above only re-read
    // already-stale client-side data with no real time gap between them -
    // reload the whole wizard from scratch (same "New Payment" re-entry
    // already used elsewhere in this function for the Surcharging-blocked
    // case) with real waits in between, instead of giving up immediately.
    for (let reloadAttempt = 0; reloadAttempt < 3 && (!reserveLineValue || reserveLineValue === '<none>'); reloadAttempt++) {
      console.log('Reserve Line still empty after Update - reserve may not have propagated yet, reloading and retrying (' + (reloadAttempt + 1) + '/3)');
      await page.waitForTimeout(3000);
      await page.reload();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.locator('[id="Claim:ClaimMenuActions"]').click();
      await page.getByRole('menuitem', { name: 'New Payment (Formerly System' }).click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      // Re-opening New Payment lands on Step 1 (payee), NOT Step 2 - the payee
      // selections do not survive the reload. Re-fill Step 1 and advance;
      // waiting for the Step-2 Reserve Line field here without doing so was a
      // guaranteed miss (see fillPayeeStepAndAdvance's note).
      const backOnStep2 = await fillPayeeStepAndAdvance();
      if (!backOnStep2) continue;
      // Re-answer the Yes/No radio groups and re-select Reserve Line, same
      // as the first pass - reopening the wizard resets Step 2 entirely.
      const retryNoLabels = page.locator('label').filter({ hasText: /^No$/ });
      const retryNoCount = await retryNoLabels.count().catch(() => 0);
      for (let i = 0; i < retryNoCount; i++) await retryNoLabels.nth(i).click().catch(() => {});
      for (let attempt = 0; attempt < 3 && (!reserveLineValue || reserveLineValue === '<none>'); attempt++) {
        await selectComboboxOnPrem(page, 'Reserve Line', reserveLine, { random: !reserveLine, skip: reserveLineSkipCount });
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
        reserveLineValue = await reserveLineField.inputValue().catch(() => '');
      }
    }
  }
  if (!reserveLineValue || reserveLineValue === '<none>') {
    throw new Error('Reserve Line could not be selected for payment (reserveLine="' + reserveLine + '")');
  }
  await selectComboboxOnPrem(page, 'Transaction Type', transactionType, { exact: true });
  const totalAmountField = page.getByRole('textbox', { name: 'Total Amount of Check' });
  await totalAmountField.fill(String(checkAmount));

  // Line Items grid: Category (combobox, starts "<none>") + Amount -
  // confirmed via live screenshot that BOTH are required and were still
  // showing invalid/empty. The recording's own click sequence
  // (gridcolumn-2943 then gridcolumn-2996 then a dynamic textfield) only
  // captured focusing the cells, not actually picking a Category option -
  // reuse the same proven "<none>" grid-cell pattern already used for the
  // Reserves/Exposure sweep loops instead.
  const lineItemCategory = page.getByText('<none>').first();
  const hasLineItemCategory = await lineItemCategory.waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true).catch(() => false);
  if (hasLineItemCategory) {
    await lineItemCategory.click();
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const list = Array.from(document.querySelectorAll('.x-boundlist-item'))
        .filter(li => { const t = li.textContent.trim(); return t && t !== '<none>' && t.toLowerCase() !== 'none'; });
      if (list.length > 0) list[0].click();
    });
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  }

  // Confirmed via live screenshot: there are actually TWO separate blank
  // amount cells here - the exposure summary grid's own "Amount" column AND
  // the Line Items grid's "Amount" column below it - both carry the
  // ".gw-currency-positive" class. Filling only the first (as before) left
  // the second one empty, causing "Amount: Missing required field" and
  // "Line Items: This amount does not match the total amount of the check."
  // Fill every such blank cell, not just the first.
  const allocCells = page.locator('.gw-currency-positive');
  const allocCellCount = await allocCells.count().catch(() => 0);
  for (let i = 0; i < allocCellCount; i++) {
    const cell = allocCells.nth(i);
    const cellText = (await cell.textContent().catch(() => '') || '').trim();
    // Confirmed via live screenshot: the Line Items grid's own Amount cell
    // can render as truly EMPTY (no "-" placeholder text at all), not just
    // "-" like the exposure summary grid's Amount column - the old
    // "!== '-'" check wrongly treated a blank cell as "already has a value"
    // and skipped it, leaving it invalid. Only skip cells that have a REAL
    // (non-blank, non-dash) value already.
    if (cellText && cellText !== '-') continue; // already has a real value - leave it alone
    await cell.click();
    await page.waitForTimeout(300);
    let allocFocused = await page.evaluate(() => document.activeElement.tagName);
    if (allocFocused !== 'INPUT' && allocFocused !== 'TEXTAREA') {
      await cell.click();
      await page.waitForTimeout(300);
      allocFocused = await page.evaluate(() => document.activeElement.tagName);
    }
    if (allocFocused === 'INPUT' || allocFocused === 'TEXTAREA') {
      await page.locator(':focus').fill(String(checkAmount));
      await page.locator('#centerPanel').click().catch(() => {});
      await page.waitForTimeout(200);
    }
  }

  // "Memo Phrase" - confirmed via live screenshot to be a newly-surfaced
  // required combobox (appears once other fields are filled in). Confirmed
  // via TWO separate live failures (both random AND first-option selection)
  // that Playwright's own .click() on this dropdown's option items hangs for
  // the full 30s - not a random-vs-first issue, something about clicking an
  // option in THIS specific list. Bypass Playwright's actionability wait
  // with a raw JS click on the boundlist item instead, same fix already
  // proven for other stubborn dropdowns elsewhere in this project.
  const memoPhraseCombo = page.getByRole('combobox', { name: 'Memo Phrase', exact: true });
  const hasMemoPhrase = await memoPhraseCombo.waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true).catch(() => false);
  if (hasMemoPhrase) {
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    // Confirmed via live failure: a single click + 300ms wait wasn't always
    // enough for this dropdown's options to actually render - retry the
    // click a few times with a longer wait until a real visible boundlist
    // shows up, instead of giving up after one attempt.
    let picked = null;
    for (let attempt = 0; attempt < 4 && !picked; attempt++) {
      await memoPhraseCombo.click();
      await page.waitForTimeout(500);
      // Confirmed via live screenshot: an unscoped ".x-boundlist-item" query
      // matched a stale/hidden boundlist left over from the Category field
      // instead of the currently-open Memo Phrase one ("501-Defense Counsel
      // Fees" was actually the Category value, not a real Memo Phrase option
      // - Memo Phrase stayed "<none>"). Scope to the LAST visible
      // ".x-boundlist" container (the one that's actually open right now).
      picked = await page.evaluate(() => {
        const containers = Array.from(document.querySelectorAll('.x-boundlist'))
          .filter(c => c.offsetParent !== null);
        const container = containers[containers.length - 1];
        if (!container) return null;
        const list = Array.from(container.querySelectorAll('.x-boundlist-item'))
          .filter(li => { const t = li.textContent.trim(); return t && t !== '<none>' && t.toLowerCase() !== 'none'; });
        if (list.length === 0) return null;
        const el = list[0];
        const t = el.textContent.trim();
        el.click();
        return t;
      });
    }
    console.log('Memo Phrase selected via raw click:', picked || '(none found)');
  }

  // Confirmed via live screenshot: "Total Amount of Check" got silently
  // reset to blank after the Line Item Category/Amount interactions above -
  // the same "field reset by a later, unrelated action" pattern hit
  // repeatedly elsewhere in this project (Mobile, Claimant, Type, ...).
  // Re-verify and re-fill right before moving on.
  const totalAmountValue = await totalAmountField.inputValue().catch(() => '');
  if (!totalAmountValue) {
    await totalAmountField.fill(String(checkAmount));
    console.log('Total Amount of Check re-set after being reset:', await totalAmountField.inputValue().catch(() => '(unknown)'));
  }

  // "Payment for a total loss?" / "...adverse carrier handling salvage" -
  // confirmed via live screenshot there can be MULTIPLE separate Yes/No
  // radio groups on this screen ("Payment for a total loss?" plus a
  // salvage-handling question right below it) - a bare .first() only
  // targeted ONE of them, leaving the other(s) unanswered and blocking Next.
  // Answer every unanswered "No" radio group on the page instead.
  // Confirmed via live failure: getByRole('radio', {name:'No'}) consistently
  // found ZERO matches here regardless of settle-retries - these fields are
  // NOT real role=radio inputs, same "radio-looking but actually a <label>-
  // wrapped element" pattern already confirmed elsewhere in this codebase
  // (the Surcharging screen). Click by label text instead.
  const noLabels = page.locator('label').filter({ hasText: /^No$/ });
  let noLabelCount = await noLabels.count().catch(() => 0);
  // Confirmed via live failure: "Payment for a total loss?" can still be
  // unrendered at the instant of this first scan (same late-render race
  // fixed for the FNOL coverage menu) - a single immediate count() can see 0
  // and skip answering a question that appears a moment later, leaving Next
  // blocked by "Payment for a total loss? : Missing required field" with no
  // clue why (our own answer loop never even tried it).
  for (let settleAttempt = 0; noLabelCount === 0 && settleAttempt < 5; settleAttempt++) {
    await page.waitForTimeout(200);
    noLabelCount = await noLabels.count().catch(() => 0);
  }
  console.log('Payment Step 2: answering ' + noLabelCount + ' "No" radio group(s)');
  for (let i = 0; i < noLabelCount; i++) {
    await noLabels.nth(i).click().catch(() => {});
    await page.waitForTimeout(200);
  }

  // Confirmed via live failure: state-specific required dropdowns (e.g. "PA
  // Tort Code" for PA claims) can appear on this screen alongside the Yes/No
  // radio groups above - sweep any still-unfilled comboboxes scoped to this
  // wizard before attempting Next, same pattern already proven for FNOL.
  await sweepComboboxesOnPrem(page, 'NormalCreateCheckWizard');

  // Prefix-agnostic: see wizardNavButton. A hardcoded "NormalCreateCheckWizard"
  // id here is what produced "Step 2 of 3 with no Next/Back/Finish rendered".
  const step2NextBtn = wizardNavButton(page, 'Next');
  await clickWizardNav(page, 'Next');
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // Confirmed via live screenshot: an invalid payment (e.g. amount exceeding
  // the reserve line's available reserves - "PMS SC04: Partial payment
  // exceeds Reserves for its ReserveLine") keeps the wizard on Step 2 with a
  // validation banner instead of throwing - Next silently no-ops. Detect
  // this and return early instead of hanging waiting for Step 3/Finish, so
  // callers can assert on the visible validation message.
  let stillOnStep2 = await step2NextBtn.waitFor({ state: 'hidden', timeout: 5000 })
    .then(() => false).catch(() => true);
  if (stillOnStep2) {
    // Confirmed via live screenshot: the real banner text ("Payment for a
    // total loss? : Missing required field...") didn't match any of
    // "[class*=validation]"/"[class*=error]"/".x-message-box" - same
    // text-regex approach already used elsewhere in this codebase
    // (validateClaimAndExposures) works reliably instead of guessing CSS
    // classes for this app's own notification-bar styling.
    const validationBanner = await page.getByText(/missing required field|must be|not allowed|exceeds|is required|does not match/i)
      .first().textContent().catch(() => null);
    let bannerText = (validationBanner || '').trim();

    // CC can refuse Step 2 with NO banner text at all. The widget state still
    // carries the reason: ExtJS marks the offending controls
    // .x-form-invalid-field and puts the message in their data-errorqtip. Read
    // that rather than reporting "(no banner text found)", which named nothing
    // and left the failure undiagnosable - the same silent-refusal pattern that
    // cost days on the cloud side.
    if (!bannerText) {
      const invalid = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('.x-form-invalid-field, [aria-invalid="true"]')) {
          if (!el.offsetParent) continue;
          const box = el.closest('.x-form-item') || el.parentElement;
          const label = box ? (box.querySelector('.x-form-item-label') || {}).textContent : '';
          out.push(((label || '').trim().replace(/[:\s]+$/, '') || el.name || el.id || 'field') +
                   (el.getAttribute('data-errorqtip') ? ' — ' + el.getAttribute('data-errorqtip') : ''));
        }
        // Empty required fields (ExtJS flags these with x-form-required-field).
        for (const el of document.querySelectorAll('.x-form-required-field')) {
          if (!el.offsetParent || (el.value || '').trim()) continue;
          const box = el.closest('.x-form-item') || el.parentElement;
          const label = box ? (box.querySelector('.x-form-item-label') || {}).textContent : '';
          const name = (label || '').trim().replace(/[:\s]+$/, '') || el.name || 'field';
          if (!out.some(o => o.startsWith(name))) out.push(name + ' — required but empty');
        }
        return [...new Set(out)].slice(0, 8);
      }).catch(() => []);
      if (invalid.length) bannerText = 'invalid/empty fields: ' + invalid.join(' | ');
    }

    // Still nothing? Read the Validation Results panel via textContent. On-prem
    // that panel can be COLLAPSED, which keeps its text out of innerText (and
    // therefore out of getByText) while it is still present in the DOM - the
    // reason this failure kept reporting "(no banner text found)" on a screen
    // CC was actively objecting to.
    if (!bannerText) {
      const hidden = await page.evaluate(() => {
        const t = document.body.textContent || '';
        return [...new Set([...t.matchAll(
          /([^\n]{0,90}(?:must not be empty|must not be null|must have a street|Missing required field|must be)[^\n]{0,50})/gi)]
          .map(m => m[1].replace(/\s+/g, ' ').trim()))].slice(0, 5);
      }).catch(() => []);
      if (hidden.length) bannerText = 'validation panel: ' + hidden.join(' || ');
    }

    if (!bannerText) {
      // Neither banner text nor an invalid widget: verify we are even still on
      // Step 2. "stillOnStep2" is inferred from the Next button not going
      // hidden, which is an assumption, not an observation.
      const where = await page.evaluate(() => ({
        step: ((document.body.innerText || '').match(/Step\s*\d+\s*of\s*\d+[^\n]*/i) || [])[0] || '(no step text)',
        buttons: [...new Set([...document.querySelectorAll('.x-btn')]
          .filter(b => b.offsetParent).map(b => (b.innerText || '').trim()).filter(Boolean))].slice(0, 14),
        body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 260),
      })).catch(() => ({}));
      console.log('Payment Step 2 diagnostic -> step="' + where.step + '" buttons=' +
                  JSON.stringify(where.buttons) + ' body="' + (where.body || '').slice(0, 200) + '"');
    }

    console.log('Payment blocked by validation on Step 2:', bannerText || '(no banner text found)');
    if (expectValidation) {
      // Caller is testing that validation fires — the banner is visible on
      // Step 2. assertValidationError() reads it from the current page; after
      // asserting, callers should cancel the wizard themselves, but we can't
      // cancel here because the banner would disappear before the caller checks.
      // IMPORTANT: callers MUST cancel the wizard after assertValidationError to
      // avoid a stale draft that breaks subsequent New Payment calls.
      return;
    }

    // Confirmed via live failure: when the same claimant has multiple exposures,
    // createPaymentOnPrem may pick a CLOSED reserve line (first dropdown match)
    // and CC blocks "Final payment not allowed without open reserve".
    // Confirmed via live screenshot: switching Reserve Line mid-wizard clears
    // Payment Type (set by CC at Step 2 load per coverage, not on dropdown change)
    // — wizard stays on Step 2 with banner "missing a payment type". The reliable
    // fix: cancel this wizard attempt and restart the whole createPaymentOnPrem
    // call with reserveLineSkipCount+1 so CC auto-populates Payment Type and all
    // other coverage-specific fields correctly on the fresh Step 2 load.
    if (/open reserve/i.test(bannerText) && reserveLine && _retries < 3) {
      // Switching reserve line mid-wizard clears CC's coverage-specific auto-populated
      // fields (Payment Type etc) — CC sets them at Step 2 LOAD only, not when the
      // dropdown changes. Cancel and restart the full wizard with the next skip so CC
      // auto-populates Payment Type and all coverage defaults fresh on the new Step 2.
      console.log('createPaymentOnPrem: "open reserve" — cancelling wizard, restarting with reserve line skip=' + (reserveLineSkipCount + 1));
      await cancelPaymentWizard(page);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
      return createPaymentOnPrem(page, {
        payeeName, reserveLine, transactionType, checkAmount, expectValidation,
        reserveLineSkipCount: reserveLineSkipCount + 1,
        _retries: _retries + 1,
      });
    }

    if (stillOnStep2) {
      // Confirmed via live failure: returning here without exiting the wizard
      // left the browser stuck mid-wizard - the NEXT createPayment call then
      // tried to open a fresh "New Payment" wizard from a screen it couldn't,
      // hanging 30s waiting for a "Name" field that was never going to appear.
      // Cancel out so the claim is back in a clean state for any later call.
      await cancelPaymentWizard(page);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      // Confirmed via live failure: returning silently here left the CALLER
      // (e.g. TC-FIN-014's Void workflow) believing the payment was created
      // and moving on to look for a "Void" button that never existed, hanging
      // the full 30s default timeout before failing with a confusing error far
      // from the real cause. Throw here instead so the failure surfaces
      // immediately at the actual point of failure.
      throw new Error('Payment blocked by validation on Step 2: ' + (bannerText || '(no banner text found)'));
    }
    // stillOnStep2 = false: in-wizard retry succeeded, wizard moved to step 3 — continue.
  }

  // Link an existing document - confirmed via live recording. The recording
  // picked a specific claim's own document by name; pick whichever is FIRST
  // available instead of hardcoding a claim-specific document name.
  const linkDocBtn = page.locator('[id="NormalCreateCheckWizard:CheckWizard_CheckInstructionsScreen:Button_Reserve_LinkDocument"]');
  const hasLinkDocBtn = await linkDocBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (hasLinkDocBtn) {
    await linkDocBtn.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    // Scope to inside the popup element to avoid picking up checkboxes that
    // belong to the parent payment-wizard grid (which can appear on the same page).
    const popup = page.locator('[id="PickExistingDocumentPopup"]');
    const hasPopup = await popup.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    const docRow = hasPopup
      ? popup.locator('img.x-grid-checkcolumn').first()
      : page.locator('img.x-grid-checkcolumn').first();
    const hasDocRow = await docRow.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    if (hasDocRow) {
      await docRow.click();
      await page.locator('[id="PickExistingDocumentPopup:Claim_DocumentsScreen:PickExistingDocumentsLV_tb:SelectButton"]').click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});

      const noneField = page.getByText('<none>').first();
      const hasNoneField = await noneField.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
      if (hasNoneField) {
        await noneField.click();
        await page.waitForTimeout(300);
        const doNotSendOption = page.getByRole('option', { name: 'Do Not Send - internal use' });
        const hasDoNotSend = await doNotSendOption.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
        if (hasDoNotSend) {
          await doNotSendOption.click();
        } else {
          await page.getByRole('option').first().click();
        }
      }
      await page.getByRole('radio', { name: 'No' }).click().catch(() => {});
    } else {
      // Confirmed via live failure: when this claim has NO documents at all,
      // the "Pick Existing Document" popup opens with an empty grid and no
      // row to select - the wizard was left stuck on this popup forever
      // (Step 3's attorney radio/Reason for Check/Finish never got reached)
      // since nothing closed it. Cancel out of the popup instead - linking a
      // document isn't mandatory for a payment.
      // CRITICAL: do NOT fall back to getByRole('button', { name: 'Cancel' })
      // .first() — that matches the WIZARD'S own Cancel button and closes the
      // entire payment wizard, not just the popup (confirmed via live failure:
      // Finish button timed out because the wizard was already gone). Use
      // Escape instead, which closes ExtJS modal popups without affecting the
      // parent wizard step underneath.
      const cancelPopupBtn = page.locator('[id="PickExistingDocumentPopup:Cancel"]');
      const hasCancelPopupBtn = await cancelPopupBtn.waitFor({ state: 'visible', timeout: 3000 })
        .then(() => true).catch(() => false);
      if (hasCancelPopupBtn) {
        await cancelPopupBtn.click();
      } else {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});
      }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      // Give the CheckInstructionsScreen time to re-render after popup cancel
      // before looking for the attorney radio and Finish button.
      await page.waitForTimeout(1500);
      console.log('No documents available to link - skipped Link Document step');
    }
  }

  // Step 3 (Instructions): confirmed via live screenshot - two more required
  // fields surface here regardless of document linking: a Yes/No radio
  // ("Is this payment to an attorney or representative... AND is the
  // settlement payment...") and a "Reason for Check" combobox. Confirmed via
  // live DOM dump: this is NOT a real role=radio - it's a checkbox-styled
  // boolean field (id suffix "..._false-inputEl" for "No"), so
  // getByRole('radio') never matched it at all. Use the exact id instead.
  // Use an id-SUFFIX match so this works whether the wizard is named
  // "NormalCreateCheckWizard" or any other prefix variant (e.g. approval-
  // threshold routing can change the wizard container id).
  const attorneyNoRadio = page.locator('[id$="ExtSettlementRepresentQuest_false-inputEl"]').first();
  const hasAttorneyRadio = await attorneyNoRadio.waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true).catch(() => false);
  if (hasAttorneyRadio) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const isChecked = await attorneyNoRadio.isChecked().catch(() => false);
      if (isChecked) break;
      await attorneyNoRadio.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  const reasonForCheck = page.getByRole('combobox', { name: 'Reason for Check', exact: true });
  const hasReasonForCheck = await reasonForCheck.waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true).catch(() => false);
  if (hasReasonForCheck) {
    const currentReason = await reasonForCheck.inputValue().catch(() => '');
    if (!currentReason || currentReason === '<none>') {
      await selectComboboxOnPrem(page, 'Reason for Check', undefined, { exact: true });
    }
  }

  // Use id-suffix match (same pattern as attorneyNoRadio above) so this
  // works regardless of what prefix the wizard container has — the prefix
  // can vary (e.g. "ApprovalCreateCheckWizard" vs "NormalCreateCheckWizard")
  // based on approval-threshold routing. Confirmed via live failure that
  // the exact-id form timed out when the wizard used a different prefix.
  const finishBtn = page.locator('[id$=":Finish"]').filter({ hasText: 'Finish' }).first();
  await finishBtn.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  // Confirmed via live failure: a stuck sub-dialog (e.g. the Link Document
  // popup left open with nothing to select) can leave Finish never actually
  // dispatched - the wizard stays on Step 3, and the NEXT createPayment call
  // then fails trying to open a fresh "New Payment" wizard that's still
  // blocked by this one. Verify Finish actually closed the wizard.
  // Timeout bumped from 15s to 45s: approval-routed payments (amount >
  // authority limit, e.g. TC-FIN-006's $15,000 Final Payment) route through
  // ApprovalCreateCheckWizard and CC's background approval-routing job can
  // take >15s to complete, tripping the old 15s cap.
  const stillOnStep3 = await finishBtn.waitFor({ state: 'hidden', timeout: 45000 })
    .then(() => false).catch(() => true);
  if (stillOnStep3) {
    // Positive fallback: ExtJS can leave the Finish button ghost-visible in
    // the DOM even after a successful page transition. If the claim grid rows
    // are already visible, the wizard did close successfully.
    const wizardGone = await page.locator('.x-grid-row').first()
      .waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (wizardGone) return;
    const banner = await page.locator('[class*="validation"], [class*="error"]').first()
      .textContent().catch(() => null);
    throw new Error(
      'New Payment Step 3 (Finish) did not navigate away - a required field is likely still invalid' +
      (banner ? ' (banner: "' + banner.trim() + '")' : '')
    );
  }
}

async function createPayment(page, opts) {
  if (!IS_ON_PREM) {
    // Map the on-prem-shaped test call onto the cloud wizard's fields.
    //
    // reserveLine/transactionType used to be dropped here because passing an
    // on-prem free-text value to selectOption() crashed when it matched no
    // <option value>. selectByLabelOrFirst now matches on LABEL and falls back
    // to the first option instead of throwing, so these can be forwarded - and
    // they must be: without reserveLine the payee defaulted to the insured
    // company, and CC filters the Reserve Line list by payee, so the payment
    // could never find a line to pay. costType/costCategory remain on-prem-only
    // (the cloud wizard has no equivalent field).
    const { paymentAmount, checkAmount, reserveLine, transactionType,
            payeeName, category, boxNumber, memoPhrase } = opts;
    return createPaymentCloud(page, {
      checkAmount: checkAmount ?? paymentAmount,
      reserveLine, transactionType, payeeName, category, boxNumber, memoPhrase,
    });
  }

  // Per user instruction: check Surcharging for unanswered radio groups
  // before creating any payment - incomplete surcharging data can otherwise
  // block the payment wizard downstream.
  await ensureSurchargingComplete(page);

  // createPaymentOnPrem now handles a missing payeeName/reserveLine itself
  // (random selection) - always route through the confirmed real wizard
  // instead of the old unverified CSS-guess fallback.
  return createPaymentOnPrem(page, { ...opts, checkAmount: opts.checkAmount ?? opts.paymentAmount });
}

// ── createRecoveryReserve (on-prem) ──────────────────────────────────────────
// CONFIRMED via a live user walkthrough (real screenshots of a completed
// flow): Recovery Reserve is NOT directly creatable on a fresh claim -
// Actions > "Recovery Reserve" opens a real but EMPTY, unusable grid until
// THREE Workplan activities (auto-created by ClaimCenter's own business
// rules - not something this helper creates) are completed first, in order:
//   1. "Subrogation Potential" - set "Subro Potential?" to Yes, Update.
//   2. "Review Claim for Subrogation" - set "Refer this claim to Subro?" to
//      Yes, Update.
//   3. "Subrogation Referral" - fill Subro Office / Subro Adjuster, set
//      "SIU Recovery" to Yes, Update.
// Only then does Actions > "Recovery Reserve" open a grid where "Add" +
// Exposure/Cost Type/Recovery Type selection + an amount actually works.
async function openWorkplanTabOnPrem(page) {
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
  // Confirmed via live DOM dump: the left-nav here is a TREE component
  // (`<span class="x-tree-node-text">Workplan</span>`), not the
  // "Claim:MenuLinks:Claim_Claim<Section>" id pattern used by Exposures/
  // Financials - different nav widget, don't assume the same convention.
  const navItem = page.locator('.x-tree-node-text').filter({ hasText: /^Workplan$/ }).first();
  await navItem.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  await navItem.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
}

async function openActivityBySubject(page, subjectText) {
  // Confirmed via live DOM dump: real id pattern is
  // "ClaimWorkplan:ClaimWorkplanScreen:WorkplanLV:<row index>:Subject" - a
  // LiveView grid with positional (unstable) row indices, so match by id
  // SUFFIX + text content instead of a specific index.
  const link = page.locator('[id*="WorkplanLV"][id$=":Subject"]').filter({ hasText: subjectText }).first();
  const hasLink = await link.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (!hasLink) return false;
  await link.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  return true;
}

async function clickActivityUpdate(page) {
  // Set Status to Complete so the activity is closed, not just saved.
  // Required before "Recovery Reserve" appears in the Actions menu.
  await selectComboboxOnPrem(page, 'Status', 'Complete', { exact: true }).catch(() => {});
  const updateBtn = page.locator('.x-btn').filter({ hasText: 'Update', exact: true }).first();
  const hasUpdateBtn = await updateBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (!hasUpdateBtn) return;
  await updateBtn.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
}

async function createRecoveryReserve(page, { recoveryType = 'Subrogation', reserveAmount, exposureRowText } = {}) {
  await openWorkplanTabOnPrem(page);
  if (await openActivityBySubject(page, 'Subrogation Potential')) {
    await selectComboboxOnPrem(page, 'Subro Potential?', 'Yes', { exact: true }).catch(() => {});
    await clickActivityUpdate(page);
    console.log('Recovery Reserve prep: "Subrogation Potential" set to Yes');
  }

  await openWorkplanTabOnPrem(page);
  if (await openActivityBySubject(page, 'Review Claim for Subrogation')) {
    await selectComboboxOnPrem(page, 'Refer this claim to Subro?', 'Yes', { exact: true }).catch(() => {});
    await clickActivityUpdate(page);
    console.log('Recovery Reserve prep: "Review Claim for Subrogation" set to Yes');
  }

  await openWorkplanTabOnPrem(page);
  if (await openActivityBySubject(page, 'Subrogation Referral')) {
    await selectComboboxOnPrem(page, 'Subro Office', undefined, { exact: true, random: true }).catch(() => {});
    await selectComboboxOnPrem(page, 'Subro Adjuster', undefined, { exact: true, random: true }).catch(() => {});
    const siuYes = page.locator('label').filter({ hasText: /^Yes$/ }).first();
    await siuYes.click().catch(() => {});
    await clickActivityUpdate(page);
    console.log('Recovery Reserve prep: "Subrogation Referral" completed');
  }

  // Actions > "Recovery Reserve" - only usable now that the 3 activities
  // above are done.
  await page.locator('[id="Claim:ClaimMenuActions"]').click();
  await page.getByRole('menuitem', { name: 'Recovery Reserve', exact: true }).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  // Confirmed via live DOM dump: the unscoped ".x-btn" text-match for "Add"
  // was matching some OTHER, unrelated global "Add" control on the page -
  // clicking it silently navigated away to Address Book Search instead of
  // adding a row here. The real, stable id is
  // "NewRecoveryReserveSet:NewReserveSetScreen:Add".
  const addBtn = page.locator('[id="NewRecoveryReserveSet:NewReserveSetScreen:Add"]');
  await addBtn.click();
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(300);

  // Confirmed via live screenshot: after "Add", Exposure shows a real
  // placeholder ("none (Clai...)") and Cost Type shows literal "<none>" -
  // getByRole('combobox', {name}) never actually filled either one (the
  // test still "passed" only because ClaimCenter silently skips saving a
  // line item with no real change/amount, not because anything was
  // genuinely set). Since Exposure isn't filled YET, a row lookup BY
  // exposureRowText can't work here either - target the newly-added row
  // positionally (it's the only data row before Save) and fill its cells by
  // COLUMN INDEX using the same real-boundlist-click pattern already proven
  // reliable on the Set Reserves screen's Cost Type/Cost Category cells.
  //
  // ROOT CAUSE of the intermittent "cell may not have registered" failures,
  // confirmed via a live DOM dump: ".x-grid-row" is a GENERIC ExtJS class
  // shared by the left-nav TREE too, and its "Summary" tree node sits
  // FIRST in raw DOM order - an unscoped ".first()" was silently grabbing
  // that nav tree node instead of the actual Recovery Reserves grid row,
  // so every click/fill landed on nothing meaningful. Scope to the real
  // grid container (confirmed id prefix "NewRecoveryReserveSet" from the
  // "Add" button's own id above).
  // Confirmed via live screenshot: reusing the same claim across multiple
  // test runs (for fast local iteration) leaves an EARLIER run's already-
  // filled reserve row still in this grid - ".first()" grabbed that OLD row
  // instead of the new blank one "Add" just created. The new row is always
  // the LAST one (added at the bottom).
  // Confirmed via live DOM dump: ".last()" was landing on the grid's own
  // SUMMARY/totals row ("x-grid-row-summary" class, showing aggregated
  // "$5,000.00" totals), not a real data row at all - exclude it.
  const targetRow = page.locator('[id^="NewRecoveryReserveSet"] .x-grid-row:not(.x-grid-row-summary)').last();
  async function fillGridCellByIndex(columnIndex, pickText) {
    const cell = targetRow.locator('.x-grid-cell').nth(columnIndex);
    await cell.click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const container = page.locator('.x-boundlist').filter({ has: page.locator('.x-boundlist-item') }).last();
    const items = container.locator('.x-boundlist-item');
    const count = await items.count().catch(() => 0);
    // Confirmed via live failure: the Exposure dropdown's real option text
    // is a full descriptive string (e.g. "(1) 1st PartyBodily Injury
    // Liability - Jim Bruster"), not the bare claimant name passed in as
    // pickText - an EXACT match never found anything, and since pickText
    // was truthy the "fall back to first real option" branch never kicked
    // in either, so NOTHING got clicked at all. Use a CONTAINS match
    // instead, and always fall back to the first real option if pickText
    // doesn't match any (rather than only when pickText is absent).
    let pickedIndex = -1;
    const realIndexes = [];
    for (let i = 0; i < count; i++) {
      const t = (await items.nth(i).textContent().catch(() => '') || '').trim();
      // Confirmed via live failure: the Exposure dropdown's placeholder
      // option isn't just literal "<none>"/"none" - it's "none (Claim-
      // level)", a catch-all that passed the old exact-match check and got
      // picked as if it were a real exposure. Exclude any "none"-PREFIXED
      // option too, not just an exact match.
      if (!t || t === '<none>' || t.toLowerCase().startsWith('none')) continue;
      realIndexes.push(i);
      if (pickText && t.includes(pickText)) { pickedIndex = i; break; }
    }
    if (pickedIndex < 0 && realIndexes.length > 0) pickedIndex = realIndexes[0];
    if (pickedIndex >= 0) await items.nth(pickedIndex).click().catch(() => {});
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  // Confirmed via live failure: the cell-click + boundlist-pick approach is
  // INTERMITTENT here (worked cleanly on one run, silently left both fields
  // "<none>" on a later run) - verify each field's own cell no longer shows
  // "<none>" afterward and retry the fill (not just the click) if it didn't
  // register, same defensive pattern already used for the FNOL sweep.
  async function fillAndVerifyCell(columnIndex, pickText, label) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cellText = (await targetRow.locator('.x-grid-cell').nth(columnIndex).textContent().catch(() => '') || '').trim();
      // Confirmed via user report: this check is CASE-SENSITIVE and can
      // wrongly conclude an unfilled "None (Claim-level)"-style placeholder
      // (capitalized differently than assumed) is already a real value,
      // returning immediately without ever attempting a fill and without
      // logging any warning - silent, undetected failure. Compare
      // case-insensitively.
      const lower = cellText.toLowerCase();
      if (cellText && !lower.includes('<none>') && !lower.startsWith('none')) return;
      await fillGridCellByIndex(columnIndex, pickText);
    }
    console.log('WARNING: ' + label + ' cell may not have registered after 3 attempts');
    // DIAGNOSTIC (temporary): dump the real row HTML so the actual failure
    // can be inspected directly instead of guessing again.
    const rowHtml = await targetRow.evaluate(el => el.outerHTML).catch(e => 'ERROR: ' + e.message);
    console.log('DIAGNOSTIC row HTML for "' + label + '":', rowHtml);
  }
  // Column order confirmed via live screenshot: [checkbox, Exposure,
  // Coverage, Cost Type, Cost Category, Recovery Type, Open Recovery
  // Reserves, New Open Recovery Reserves, Change, Comments].
  await fillAndVerifyCell(1, exposureRowText || null, 'Exposure');
  await fillAndVerifyCell(3, null, 'Cost Type');

  // Confirmed via live screenshot: Cost Category and Recovery Type DID get
  // filled correctly by the plain selectComboboxOnPrem call (showed "Other"
  // / "Subrogation") - only Exposure/Cost Type needed the cell-click
  // workaround above. Keep these as-is.
  await selectComboboxOnPrem(page, 'Recovery Type', recoveryType, { exact: true }).catch(() => {});
  await selectComboboxOnPrem(page, 'Cost Category', undefined, { exact: true, random: true }).catch(() => {});

  // "New Open Recovery Reserves" amount cell - same inline-grid-edit "-"
  // placeholder pattern confirmed on the Set Reserves screen.
  const amountCell = targetRow.locator('.x-grid-cell').filter({ hasText: '-' }).last();
  await amountCell.click({ force: true, timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.locator(':focus').fill(String(reserveAmount)).catch(() => {});
  await page.locator('#centerPanel').click().catch(() => {});

  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  // Same unscoped-match risk as "Add" above - scope "Save" to the grid's own
  // toolbar (confirmed via live diagnostic: identifiable as the toolbar that
  // also contains "Link Document") instead of a bare page-wide text match.
  const recoveryToolbar = page.locator('.x-toolbar').filter({ has: page.getByText('Link Document', { exact: true }) }).first();
  const saveBtn = recoveryToolbar.locator('.x-btn').filter({ hasText: 'Save', exact: true }).first();
  await saveBtn.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  // Confirmed via live failure: verifyNoValidationErrors's generic CSS-class
  // guesses ('.gw-validation-error' etc.) never matched this app's actual
  // "Cost Type : Missing required field..." banner style, so a genuinely
  // failed Save silently passed as "success". This screen stays on "Set
  // Recovery Reserves" even after a SUCCESSFUL save (confirmed via the
  // original working screenshot) - a "did we leave the screen" check would
  // always false-positive here, so check for the actual banner TEXT instead.
  const bannerText = await page.getByText(/missing required field|must be|not allowed|exceeds|cannot be/i)
    .first().textContent({ timeout: 3000 }).catch(() => null);
  if (bannerText && bannerText.trim()) {
    throw new Error('Recovery Reserve Save blocked by validation - banner: "' + bannerText.trim() + '"');
  }
}

async function createRecoveryReceipt(page, { recoveryType, receiptAmount, exposureRowText, netRecovery = false }) {
  // receivedDate: no such field was visible on the real "Create Recovery"
  // screen (confirmed via live screenshot) - dropped from use here, kept
  // out of the destructure so callers passing it don't break.
  // Confirmed via live screenshot: Actions > "Recovery/Credit" opens a
  // "Create Recovery" screen with its own top-level required fields (Payer,
  // Payer Check Number, Total Amount of Check, two Yes/No radio groups) AND
  // a separate "Recoveries" grid (Reserve Line / Coverage / Recovery/Credit
  // Category / Cause of Loss / Claimant / Comments / Amount) needing its
  // own "Add" + cell-fill - NOT a single-form screen like first assumed.
  const menuBtn = page.locator('[id="Claim:ClaimMenuActions"]');
  await menuBtn.click();
  const recoveryCreditItem = page.getByRole('menuitem', { name: 'Recovery/Credit', exact: true });
  await recoveryCreditItem.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  await selectComboboxOnPrem(page, 'Payer', undefined, { exact: true, random: true }).catch(() => {});
  const checkNumberField = page.getByRole('textbox', { name: 'Payer Check Number', exact: true });
  if (await checkNumberField.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    // Confirmed via live screenshot: "Check number should be less than or
    // equal to 9 digits" - purely numeric, no prefix.
    await checkNumberField.fill(String(Math.floor(100000 + Math.random() * 900000)));
  }
  const totalAmountField = page.getByRole('textbox', { name: 'Total Amount of Check', exact: true });
  if (await totalAmountField.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    await totalAmountField.fill(String(receiptAmount));
  }
  // Confirmed via live screenshot: two Yes/No radio groups appear in this
  // order - "Are you reposting this recovery check with the same check
  // number?" (always "No" here) then "Is this a Net Recovery?" (per user
  // direction, the exceeds-reserve validation may only trigger when this is
  // "Yes" instead of the default "No"). Click by position rather than
  // guessing a structural relationship to each question's own label text.
  const noLabels = page.locator('label').filter({ hasText: /^No$/ });
  const yesLabels = page.locator('label').filter({ hasText: /^Yes$/ });
  await noLabels.first().click().catch(() => {}); // reposting? -> No
  if (netRecovery) {
    await yesLabels.last().click().catch(() => {}); // net recovery? -> Yes
    // Confirmed via live screenshot: choosing "Yes" here reveals a new
    // required "Amount Retained" field at the top level of the screen -
    // give it a moment to actually render before looking for it (a
    // previous attempt's 3s waitFor may have timed out before the field
    // ever appeared, silently skipping the fill entirely).
    await page.waitForTimeout(500);
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    const amountRetainedField = page.getByRole('textbox', { name: 'Amount Retained', exact: true });
    const hasAmountRetained = await amountRetainedField.waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true).catch(() => false);
    console.log('Amount Retained field found:', hasAmountRetained);
    if (hasAmountRetained) {
      await amountRetainedField.scrollIntoViewIfNeeded().catch(() => {});
      await amountRetainedField.click().catch(() => {});
      await amountRetainedField.fill('100');
      const verifyValue = await amountRetainedField.inputValue().catch(() => '');
      console.log('Amount Retained value after fill:', verifyValue);
    }
  } else {
    const noCount = await noLabels.count().catch(() => 0);
    for (let i = 1; i < noCount; i++) await noLabels.nth(i).click().catch(() => {});
  }

  // "Add" here is unambiguous - this screen has only one grid ("Recoveries")
  // with its own Add button, unlike Set Reserves/Recovery Reserves which
  // needed careful scoping to avoid an unrelated global "Add" elsewhere.
  const addBtn = page.locator('.x-btn').filter({ hasText: 'Add', exact: true }).last();
  await addBtn.click();
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(300);

  // Confirmed via live screenshot: clicking "Add" reveals a plain "Details"
  // panel BELOW the grid with regular, directly-fillable fields - Reserve
  // Line, Exposure, Cost Type, Cost Category, Recovery/Credit Category,
  // Adjuster Number, Comments, Amount (more required fields than first
  // assumed) - the new grid row updates automatically as these are filled,
  // no inline-grid-cell editing needed at all (unlike Set Reserves/Recovery
  // Reserves).
  //
  // Confirmed via live screenshot: "Expense Recovery" is a generic
  // catch-all option (same class of trap as "none (Claim-level)" on the
  // Recovery Reserve screen) that appears in BOTH the Reserve Line and
  // Recovery/Credit Category dropdowns - a real Reserve Line looks like
  // "(1) 1st PartyVehicle - ...; Claim Cost/Other". Avoid it for Reserve
  // Line specifically (a real exposure-backed reserve line should exist
  // here since this test creates one moments earlier); allow it as a last
  // resort for Recovery/Credit Category since "Subrogation"/"Salvage" may
  // genuinely not be valid choices in this specific dropdown.
  async function selectAvoidingExpenseRecovery(label, value) {
    const combo = page.getByRole('combobox', { name: label, exact: true });
    const hasCombo = await combo.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (!hasCombo) return;
    await combo.click();
    await page.waitForTimeout(300);
    const options = page.getByRole('option');
    const count = await options.count().catch(() => 0);
    let pickedIndex = -1;
    const realIndexes = [];
    for (let i = 0; i < count; i++) {
      const t = (await options.nth(i).textContent().catch(() => '') || '').trim();
      if (!t || t === '<none>' || t.toLowerCase().startsWith('none')) continue;
      if (t.toLowerCase() === 'expense recovery') continue;
      realIndexes.push(i);
      if (value && t.includes(value)) { pickedIndex = i; break; }
    }
    if (pickedIndex < 0 && realIndexes.length > 0) pickedIndex = realIndexes[0];
    if (pickedIndex >= 0) {
      await options.nth(pickedIndex).click().catch(() => {});
    } else {
      // Nothing but "Expense Recovery" (or none) available - accept it as
      // the only real choice rather than leaving the field empty.
      await selectFirstRealOptionFallback();
    }
    async function selectFirstRealOptionFallback() {
      const opts = page.getByRole('option');
      const c = await opts.count().catch(() => 0);
      for (let i = 0; i < c; i++) {
        const t = (await opts.nth(i).textContent().catch(() => '') || '').trim();
        if (t && t !== '<none>' && !t.toLowerCase().startsWith('none')) { await opts.nth(i).click().catch(() => {}); return; }
      }
    }
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  // Prefer the specific exposure's own Reserve Line when known (e.g.
  // TC-FIN-022 needs THIS exposure's freshly-created reserve, not a random
  // pre-existing one with unrelated headroom) - falls back to first real
  // option if not provided or not found.
  await selectAvoidingExpenseRecovery('Reserve Line', exposureRowText || null);
  await selectComboboxOnPrem(page, 'Exposure', undefined, { exact: true, random: true }).catch(() => {});
  await selectComboboxOnPrem(page, 'Cost Type', undefined, { exact: true, random: true }).catch(() => {});
  await selectComboboxOnPrem(page, 'Cost Category', undefined, { exact: true, random: true }).catch(() => {});
  await selectAvoidingExpenseRecovery('Recovery/Credit Category', recoveryType);
  await selectComboboxOnPrem(page, 'Adjuster Number', undefined, { exact: true, random: true }).catch(() => {});
  const detailsAmountField = page.getByRole('textbox', { name: 'Amount', exact: true });
  if (await detailsAmountField.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    await detailsAmountField.fill(String(receiptAmount));
  }
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  const updateBtn = page.locator('.x-btn').filter({ hasText: 'Update', exact: true }).first();
  await updateBtn.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  // Confirmed via live screenshot: a randomly-picked Reserve Line that
  // doesn't correspond to the exposure with an actual paid amount can
  // trigger a "Validation errors were found in an object of type
  // RecoverySet ... Warning: ... Recovery will result in a negative Total
  // Paid ..." banner - clicking Update a second time confirms past it. BUT
  // this same "Validation errors were found" wrapper text can ALSO wrap a
  // genuine BLOCKING error (e.g. "Recovery receipt exceeds recovery
  // reserve") - confirmed via live failure that auto-confirming on the
  // wrapper text alone swallowed that intended validation error too. Only
  // auto-confirm when the banner specifically contains "Warning:" - a real
  // blocking error doesn't use that word.
  const warningBannerText = await page.getByText(/Validation errors were found/i)
    .first().textContent({ timeout: 3000 }).catch(() => null);
  if (warningBannerText && /warning:/i.test(warningBannerText)) {
    console.log('Recovery Receipt: warning banner shown, confirming with a second Update click');
    await updateBtn.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  } else if (warningBannerText) {
    console.log('Recovery Receipt blocked by validation:', warningBannerText.trim());
  }

  const bannerText = await page.getByText(/missing required field|must be|not allowed|exceeds|cannot be/i)
    .first().textContent({ timeout: 3000 }).catch(() => null);
  if (bannerText && bannerText.trim()) {
    console.log('Recovery Receipt blocked by validation:', bannerText.trim());
  }
}

async function createBulkInvoice(page, { vendor, invoiceNumber, invoiceDate, lineItems = [] }) {
  await page.click('[id*="BulkInvoiceTab"], a:has-text("Bulk Invoice")');
  await page.click('button:has-text("New"), [id*="NewBulkInvoice"]');
  if (vendor)        await fillTextField(page, '[id*="Vendor"]',        vendor);
  if (invoiceNumber) await fillTextField(page, '[id*="InvoiceNumber"]', invoiceNumber);
  if (invoiceDate)   await fillDateField(page, '[id*="InvoiceDate"]',   invoiceDate);
  for (const item of lineItems) {
    await page.click('button:has-text("Add Line"), [id*="AddLine"]');
    await fillTextField(page, '[id*="ClaimNumber"]', item.claimNumber);
    await fillIntegerCommaField(page, '[id*="Amount"]', item.amount);
    if (item.costType) await selectDropdown(page, '[id*="CostType"]', item.costType);
  }
  await clickSave(page);
  await verifyNoValidationErrors(page);
}

async function approveTransaction(page, transactionId) {
  await openFinancialsTab(page);
  const row = page.locator('tr:has-text("' + transactionId + '")').first();
  await row.locator('button:has-text("Approve"), [id*="Approve"]').click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function denyTransaction(page, transactionId, reason) {
  await openFinancialsTab(page);
  const row = page.locator('tr:has-text("' + transactionId + '")').first();
  await row.locator('button:has-text("Deny"), [id*="Deny"]').click();
  if (reason) await fillTextField(page, '[id*="DenyReason"]', reason);
  await clickSave(page);
}

async function assertValidationError(page, expectedMessage) {
  await verifyTextVisible(page, expectedMessage);
}

// Ensures the named contact (typically a claimant) has a primary address with
// street, city, and state filled in — required by ClaimCenter before a payment
// can be issued against an exposure with that claimant. Called after creating
// a fresh exposure so the payment wizard never hits the address validation wall.
async function ensureContactHasPrimaryAddress(page, contactName) {
  const mask = () => page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  const load = () => page.waitForLoadState('domcontentloaded').catch(() => {});

  // Navigate to the Contacts sub-page (under Parties Involved in left nav).
  const contactsNav = page.locator('.x-tree-node-text').filter({ hasText: /^Contacts$/ }).first();
  if (await contactsNav.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    await contactsNav.click();
    await load(); await mask();
  }

  // Check the Address column in the contacts grid — if it has content, we're done.
  const contactRow = page.locator('.x-grid-row').filter({ hasText: new RegExp(contactName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
  if (!await contactRow.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    console.log('ensureContactHasPrimaryAddress: contact not found in grid:', contactName);
    return;
  }
  // Address is typically the 5th column (0-indexed 4)
  const addressCell = contactRow.locator('td').nth(4);
  const addressText = await addressCell.textContent().catch(() => '');
  if (addressText && addressText.trim()) {
    console.log('ensureContactHasPrimaryAddress: ' + contactName + ' already has address, skipping');
    return;
  }

  // Select the contact row so the detail panel loads below.
  await contactRow.click();
  await load(); await mask();

  // Click Edit to enter edit mode for this contact.
  const editBtn = page.locator('.x-btn').filter({ hasText: /^Edit$/ }).first();
  if (!await editBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    console.log('ensureContactHasPrimaryAddress: Edit button not visible, skipping');
    return;
  }
  await editBtn.click();
  await load(); await mask();

  // Address 1 may be directly visible on Basics tab, or require clicking Addresses tab.
  let address1 = page.getByRole('textbox', { name: /Address 1/i }).first();
  if (!await address1.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    // Not visible on current tab — click Addresses tab.
    const addressesTab = page.getByRole('cell', { name: /^Addresses$/ }).first();
    if (await addressesTab.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
      await addressesTab.click();
      await load(); await mask();
    }
    address1 = page.getByRole('textbox', { name: /Address 1/i }).first();
  }

  if (await address1.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    const current = await address1.inputValue().catch(() => '');
    if (!current) await address1.fill('123 Main St');
  } else {
    console.log('ensureContactHasPrimaryAddress: Address 1 field not found in edit mode, skipping');
    const cancelBtn = page.locator('.x-btn').filter({ hasText: /^Cancel$/ }).first();
    await cancelBtn.click().catch(() => {});
    await load(); await mask();
    return;
  }

  const cityField = page.getByRole('textbox', { name: /^City$/i }).first();
  if (await cityField.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
    const c = await cityField.inputValue().catch(() => '');
    if (!c) await cityField.fill('Harrisburg');
  }

  await selectComboboxOnPrem(page, 'State', 'PA').catch(() => {});

  const updateBtn = page.locator('.x-btn').filter({ hasText: /^Update$/ }).first();
  if (await updateBtn.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    await updateBtn.click();
    await load(); await mask();
  }
  console.log('ensureContactHasPrimaryAddress: added primary address for ' + contactName);
}

module.exports = {
  openFinancialsTab, openExposuresTab, getLastExposureClaimant, getAllExposureClaimants, getAvailableReserveAmount, findFirstPositiveReserveLine, editReserve, createReserve, createReserveOnPrem,
  // Exported so validateAndRepairClaim can drive it. Without this the lazy
  // require there resolved to undefined and every repair silently no-opped.
  completeOnPremExposureData,
  createPayment, createPaymentCloud, createPaymentOnPrem, ensureSurchargingComplete,
  createRecoveryReserve, createRecoveryReceipt, createBulkInvoice,
  approveTransaction, denyTransaction, assertValidationError, ensureContactHasPrimaryAddress,
  cancelPaymentWizard,
};
