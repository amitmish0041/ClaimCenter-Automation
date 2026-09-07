/**
 * helpers/smartComm/documentService.js
 * ClaimCenter CLOUD "Create New Document" / SmartCOMM on-demand generation
 * workflow: Actions -> New ... -> Create from a template -> Select Template
 * -> Recipients -> Additional Data -> Create -> On-Demand -> Generate ->
 * download the PDF.
 *
 * Reuses openClaimActionsMenu from claimLifecycleHelper and does NOT touch
 * that file's existing createDocumentFromTemplate() — that's a different,
 * on-prem-only, working flow (attaches an existing supporting document to a
 * generic template) used by the LOB E2E suites; this is a new, separate,
 * cloud-only flow.
 *
 * Phase 1 implements generateOnDemand() only; generateInteractive() is a
 * stub so Phase 2 can slot in without callers changing.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { openClaimActionsMenu } = require('../claimLifecycleHelper');
const L = require('../locators/smartCommLocators');

const DOWNLOAD_DIR = path.join(__dirname, '..', '..', 'results', 'smartComm', 'downloads');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function openCreateFromTemplate(page) {
  await openClaimActionsMenu(page, 'smartComm.documentService');
  const newSubmenu = page.getByRole('menuitem', { name: L.menu.newSubmenu }).first();
  await newSubmenu.hover().catch(() => {});
  await newSubmenu.click().catch(() => {});
  await page.getByRole('menuitem', { name: L.menu.createFromTemplate }).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

// templateName must be the exact, full registered name (catalogService's
// template.searchName — "<DIG#> <Document Name>") — CONFIRMED via live
// search that this screen does an exact, case-sensitive match with no
// substring/prefix matching, so a partial name silently returns zero results.
async function selectTemplate(page, templateName) {
  await page.getByRole('tab', { name: L.selectTemplate.tab, exact: true }).click();
  const nameField = page.getByRole('textbox', { name: L.selectTemplate.nameField }).first();
  await nameField.fill(templateName);
  await nameField.press('Tab'); // commits the value before Search reads current form state
  await page.locator(L.selectTemplate.searchButtonId).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  const row = page.getByRole('row', { name: new RegExp(escapeRegExp(templateName), 'i') }).first();
  try {
    await row.waitFor({ state: 'visible', timeout: 10000 });
  } catch (_) {
    // CONFIRMED live (DIG47, DIG124): a template that exists in the catalog
    // spreadsheet but hasn't been released to this environment's SmartCOMM
    // library yet returns zero search results — expected/known, not a
    // crash. TEMPLATE_NOT_FOUND is matched by validationService to report
    // this scenario as BLOCKED rather than ERROR.
    throw new Error(`TEMPLATE_NOT_FOUND: "${templateName}" returned no search results — likely not yet released to this ClaimCenter environment's SmartCOMM library.`);
  }
  const rowText = await row.innerText();
  if (!rowText.toLowerCase().includes(templateName.toLowerCase())) {
    throw new Error(`selectTemplate: search result row did not match requested template "${templateName}" (got "${rowText}")`);
  }
  await row.getByRole('button', { name: L.selectTemplate.selectButtonInRow }).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

// Default = the claim's first party/insured (confirmed default per the
// original screenshots' "WB DEV Test ajh" row) — excludes the carrier's own
// account and the generic Address Book bucket, which are never the right
// default recipient for a claim-generated letter.
//
// Returns { name, address } rather than a bare string — once a recipient is
// picked, the same Recipients-tab grid row that shows their Delivery
// Channel/Name/Phone/Email also shows their Address (CONFIRMED live
// 2026-09-04: role=cell on that row, last cell = the full street/city/
// state/zip as one string, e.g. "21 HONEYSUCKLE DR, MARIETTA, PA
// 17547-8501") — capturing it here means "To Street Address"/"To City,
// State, Zip" requirements can be checked against the real recipient
// instead of staying shape-only.
async function setPrimaryRecipient(page, { explicitName, preferredName } = {}) {
  await page.getByRole('tab', { name: L.recipients.tab, exact: true }).click();
  await page.getByRole('button', { name: L.recipients.setPrimaryRecipientButton }).click();
  const menu = page.getByRole('menu').last();
  await menu.waitFor({ state: 'visible', timeout: 5000 });

  let pick = explicitName;
  if (explicitName) {
    await menu.getByRole('menuitem', { name: explicitName }).click();
  } else {
    const items = await menu.getByRole('menuitem').allInnerTexts();
    const excluded = /DONEGAL DIRECT ACCOUNT|Address Book/i;
    const eligible = items.map(t => t.trim()).filter(t => t && !excluded.test(t));
    if (!eligible.length) throw new Error('setPrimaryRecipient: no eligible recipient found in the list — ' + JSON.stringify(items));
    // Prefer the claim's insured (validationService passes the name it
    // already captured off the Summary screen) over just the first eligible
    // menu item — CONFIRMED live 2026-09-04: once a test claim had more
    // parties than just the insured/claimant (a medical provider and an
    // attorney added for other field mapping), "first eligible" started
    // grabbing whichever of THOSE sorted first in the menu instead, so a
    // letter meant for the insured silently went to the wrong party. Falls
    // back to the old first-eligible behavior when there's no match (or no
    // preferredName given at all, e.g. a manual claim-number override run).
    const preferredMatch = preferredName && eligible.find(t => t.toLowerCase() === preferredName.trim().toLowerCase());
    pick = preferredMatch || eligible[0];
    await menu.getByRole('menuitem', { name: pick }).click();
  }

  let address;
  try {
    // A page-wide role=row search for `pick`'s name is NOT safe to scope by
    // .last() alone — CONFIRMED live (DIG126): the claim's own Parties
    // Involved table (Name/Roles/Phone) also has a row starting with the
    // same recipient name, and on some templates THAT row sorts after this
    // grid's in DOM order, silently grabbing a phone number as the
    // "address". Scope to the specific grid whose header row has both
    // "Delivery Channel" and "Address" columns — a combination unique to
    // this Recipients-tab grid, not shared by Parties Involved.
    const grid = page.locator('[role="grid"], table')
      .filter({ hasText: 'Delivery Channel' })
      .filter({ hasText: 'Address' })
      .last();
    const escaped = pick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const row = grid.getByRole('row', { name: new RegExp(escaped) }).last();
    // The grid re-renders asynchronously right after the menuitem click —
    // CONFIRMED live: reading cells immediately (no wait) intermittently
    // found zero matching rows, since the picked recipient's row hadn't
    // painted into this grid yet.
    await row.waitFor({ state: 'visible', timeout: 5000 });
    const cells = await row.getByRole('cell').allInnerTexts();
    address = cells[cells.length - 1]?.trim() || undefined;
  } catch (_) { /* grid layout not present/visible for this template — leave unset, requirement stays shape-only */ }

  // The grid's Address cell is one comma-joined string ("21 HONEYSUCKLE DR,
  // MARIETTA, PA 17547-8501"), but a generated letter's "To ..." block
  // renders street and city/state/zip as two SEPARATE lines with no comma
  // between them (CONFIRMED live, DIG3) — comparing the whole joined string
  // against either "To Street Address" or "To City, State, Zip" alone
  // reported a false FAIL ("punctuation differs") for content that was
  // actually correct, just split across two template fields instead of
  // one. Split on the first comma so each half matches its own field.
  let streetAddress, cityStateZip;
  if (address) {
    const commaIdx = address.indexOf(',');
    if (commaIdx !== -1) {
      streetAddress = address.slice(0, commaIdx).trim();
      cityStateZip = address.slice(commaIdx + 1).trim();
    } else {
      streetAddress = address;
    }
  }

  return { name: pick, address, streetAddress, cityStateZip };
}

// CONFIRMED via live run 2026-09-03: this is a native <select> exposed as
// role=combobox — selectOption() sets it directly and doesn't need the
// (closed, so non-clickable) <option> to be independently visible, unlike a
// click-based open-then-click-option approach.
async function setDeliveryChannel(page, channel = 'Print') {
  const byRole = page.getByRole('combobox', { name: /Delivery Channel/i }).first();
  try {
    await byRole.waitFor({ state: 'visible', timeout: 8000 });
    await byRole.selectOption({ label: channel });
    return;
  } catch (_) { /* row not rendered yet under this name — fall back below */ }
  await page.locator(L.recipients.deliveryChannelDropdown).first().selectOption({ label: channel });
}

async function setEmail(page, email) {
  if (!email) return;
  const field = page.locator(L.recipients.emailField).first();
  if (await field.isVisible().catch(() => false)) await field.fill(email);
}

async function setAdditionalData(page, { language = 'English (US)', documentType = 'Other' } = {}) {
  await page.getByRole('tab', { name: L.additionalData.tab, exact: true }).click();

  const langField = page.locator(L.additionalData.languageDropdown).first();
  if (await langField.isVisible().catch(() => false)) {
    await langField.selectOption({ label: language }).catch(() => {});
  } else {
    console.log('setAdditionalData: Language field not present on this screen — skipping (not confirmed present for every template)');
  }

  // Same native-<select>-via-role=combobox pattern as setDeliveryChannel —
  // selectOption() directly rather than click-open-then-click-option.
  const docTypeByRole = page.getByRole('combobox', { name: /Document Type/i }).first();
  try {
    await docTypeByRole.waitFor({ state: 'visible', timeout: 8000 });
    await docTypeByRole.selectOption({ label: documentType });
  } catch (_) {
    await page.locator(L.additionalData.documentTypeDropdown).first().selectOption({ label: documentType }).catch(() => {});
  }

  // "From" — a required field (ClaimCenter marks it with *), a native
  // <select> already defaulted to whoever generated the request is
  // currently logged in as (CONFIRMED live 2026-09-04, willfolm's session:
  // options ["Kevin Burke","Super User","Bill Folmar"], pre-selected to
  // "Bill Folmar"). Left untouched, this is exactly what correlated with
  // the SmartCOMM payload's <from_ext> sender block coming back completely
  // empty and the real generated letter's signature line going blank — a
  // visually-defaulted <select> isn't necessarily a committed one.
  // Re-selecting its own current value forces an explicit change event
  // (Playwright's selectOption always fires one) without needing to know
  // which display name is logged in.
  const fromField = page.getByRole('combobox', { name: /^From$/i }).first();
  if (await fromField.isVisible().catch(() => false)) {
    const currentValue = await fromField.inputValue().catch(() => null);
    if (currentValue) await fromField.selectOption({ value: currentValue }).catch(() => {});
  }
}

// Generate produces a row per recipient in the Create tab's results grid,
// each with its own download icon (screenshot 7) — Generate itself does NOT
// trigger the browser download; clicking that icon does.
async function generateOnDemand(page, { fileNamePrefix = 'SmartComm' } = {}) {
  // exact:true matters here specifically — the outer south-panel tab is
  // named "Create New Document", which a substring match on "Create" would
  // also hit, making the click ambiguous (CONFIRMED via live failure: it
  // silently no-opped under a swallowed .catch(), leaving "Additional Data"
  // active and the Generate button unreachable).
  await page.getByRole('tab', { name: L.create.tab, exact: true }).click();
  await page.getByRole('button', { name: L.create.generateButton }).click();

  const resultRow = page.locator(L.create.resultsGrid)
    .getByRole('row')
    .filter({ has: page.locator(L.create.downloadIcon) })
    .first();
  await resultRow.waitFor({ state: 'visible', timeout: 120000 });

  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await resultRow.locator(L.create.downloadIcon).click();
  const download = await downloadPromise;

  const fileName = `${fileNamePrefix}_${Date.now()}.pdf`;
  const savePath = path.join(DOWNLOAD_DIR, fileName);
  await download.saveAs(savePath);
  return savePath;
}

async function generateInteractive() {
  throw new Error('generateInteractive: not implemented — Phase 2');
}

// The "Development" section's "Download Payload" button — ClaimCenter's own
// ground truth for exactly what data it sent to SmartCOMM for this
// generation, independent of anything scraped off the Summary screen (see
// payloadService). Call after generateOnDemand, while still on the Create
// tab. Not part of the earlier per-recipient results-grid row/download-icon
// flow — this is a single, separate button alongside Save documents/Close.
async function downloadPayload(page, { fileNamePrefix = 'SmartComm' } = {}) {
  const btn = page.getByRole('button', { name: L.create.downloadPayloadButton });
  await btn.waitFor({ state: 'visible', timeout: 15000 });

  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await btn.click();
  const download = await downloadPromise;

  const fileName = `${fileNamePrefix}_payload_${Date.now()}.xml`;
  const savePath = path.join(DOWNLOAD_DIR, fileName);
  await download.saveAs(savePath);
  return savePath;
}

module.exports = {
  openCreateFromTemplate, selectTemplate, setPrimaryRecipient,
  setDeliveryChannel, setEmail, setAdditionalData,
  generateOnDemand, generateInteractive, downloadPayload,
};
