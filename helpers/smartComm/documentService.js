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
 * Implements the On-Demand generation flow (generateOnDemand). The Interactive flow — click Interactive,
 * edit fields, Save Changes, Complete Document — lives in interactiveEditService.js instead, since it's a
 * materially different, multi-step session rather than a single button click.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { openClaimActionsMenu } = require('../claimLifecycleHelper');
const { installDialogAutoAccept, saveDiagnostic } = require('./interactiveEditService');
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

async function searchTemplateByName(page, templateName) {
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
    return null; // no results for this exact candidate — caller decides whether to try another
  }
  return row;
}

// Bare-ID fallback for when every full-name candidate above fails (CONFIRMED live, DIG15: the catalog's
// mapping-doc name and the registered template name had drifted enough that neither candidate matched, even
// though the template was genuinely present under a name simply containing "DIG15"). The Name field is a
// "Contains" search (see UIF.004 in the ccUiValidation spec), so searching the bare digNumber alone finds it
// regardless of naming drift — but that same "contains" behaviour means "DIG15" also matches "DIG150MI",
// "DIG151", "DIG15S", etc. (CONFIRMED against the live catalog — real neighbours of DIG15). A plain substring
// check on the result row is NOT safe here; the row must contain digNumber as its own whole token (not
// immediately followed by another letter/digit) to rule those out.
async function searchTemplateById(page, digNumber) {
  await page.getByRole('tab', { name: L.selectTemplate.tab, exact: true }).click();
  const nameField = page.getByRole('textbox', { name: L.selectTemplate.nameField }).first();
  await nameField.fill(digNumber);
  await nameField.press('Tab');
  await page.locator(L.selectTemplate.searchButtonId).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // CONFIRMED live (DIG15): searching "dig15" genuinely returns DIG158/DIG153/DIG156/DIG159 alongside
  // "DIG15 HIPPA Authorization" too — a real contains-match, not a fluke — so the boundary lookahead is load
  // -bearing, not defensive-only. First version of this function counted rows immediately after clicking
  // Search with no wait for the grid to actually render, so it usually saw zero/stale rows and fell straight
  // through to "not found" even when the template WAS there — fixed by reusing searchTemplateByName's own
  // proven getByRole('row', { name: regex }) + waitFor idiom, which lets Playwright poll for the match instead
  // of taking one snapshot too early.
  const boundary = new RegExp(`${escapeRegExp(digNumber)}(?![0-9A-Za-z])`, 'i');
  const row = page.getByRole('row', { name: boundary }).first();
  try {
    await row.waitFor({ state: 'visible', timeout: 10000 });
  } catch (_) {
    return null;
  }
  return row;
}

// templateNameOrNames is the exact, full registered name (catalogService's
// template.searchName — "<DIG#> <Document Name>"), or an array of candidate
// names to try in order — CONFIRMED via live search that this screen does an
// exact, case-sensitive match with no substring/prefix matching, so even a
// casing/spacing difference silently returns zero results. The catalog's own
// "Document Name" text isn't always byte-for-byte what's actually
// registered (CONFIRMED live, DIG172B: catalog text is "...30 day late
// notice", real registered name is "...30 Day Late Notice") — callers pass
// [template.searchName, template.searchNameAlt] so the template's own local
// filename (underscores standing in for spaces) gets a shot before this
// gives up. As a last resort, searchTemplateById tries the bare DIG number
// (derived from the first candidate, which is always template.searchName —
// "<DIG#> <Document Name>" — by convention).
async function selectTemplate(page, templateNameOrNames) {
  const candidates = [...new Set((Array.isArray(templateNameOrNames) ? templateNameOrNames : [templateNameOrNames]).filter(Boolean))];
  for (const templateName of candidates) {
    const row = await searchTemplateByName(page, templateName);
    if (!row) continue;
    const rowText = await row.innerText();
    if (!rowText.toLowerCase().includes(templateName.toLowerCase())) {
      throw new Error(`selectTemplate: search result row did not match requested template "${templateName}" (got "${rowText}")`);
    }
    await row.getByRole('button', { name: L.selectTemplate.selectButtonInRow }).click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    return;
  }

  const digNumber = (candidates[0] || '').match(/^\S+/);
  if (digNumber) {
    const row = await searchTemplateById(page, digNumber[0]);
    if (row) {
      await row.getByRole('button', { name: L.selectTemplate.selectButtonInRow }).click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return;
    }
  }

  // CONFIRMED live (DIG47, DIG124): a template that exists in the catalog
  // spreadsheet but hasn't been released to this environment's SmartCOMM
  // library yet returns zero search results for every candidate name —
  // expected/known, not a crash. TEMPLATE_NOT_FOUND is matched by
  // validationService to report this scenario as BLOCKED rather than ERROR.
  throw new Error(`TEMPLATE_NOT_FOUND: none of [${candidates.map(c => `"${c}"`).join(', ')}]${digNumber ? ` or a bare "${digNumber[0]}" search` : ''} returned search results — likely not yet released to this ClaimCenter environment's SmartCOMM library.`);
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
    // NOTE 2026-10-02: tried theorizing this menu ALSO carries the 2-char avatar-initials prefix documented
    // on setAdditionalRecipient's menu — DISPROVEN live (stripping 2 chars from "ANDREA BROWN" produced the
    // visibly wrong "DREA BROWN", which still failed to locate the row) — this menu's items are the clean
    // name as-is. Left as substring containment anyway (harmless, and marginally more tolerant than exact
    // equality) rather than reverting to the original === check.
    const preferredMatch = preferredName && eligible.find(t => t.toLowerCase().includes(preferredName.trim().toLowerCase()));
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
    // Raw rendered text (hasText), not getByRole('row', {name}) — a defensive, more robust row lookup (this
    // runs while the primary is still the only row, so it's not working around anything specific here).
    const row = grid.locator('tr, [role="row"]').filter({ hasText: new RegExp(escaped) }).last();
    // The grid re-renders asynchronously right after the menuitem click —
    // CONFIRMED live: reading cells immediately (no wait) intermittently
    // found zero matching rows, since the picked recipient's row hadn't
    // painted into this grid yet.
    await row.waitFor({ state: 'visible', timeout: 5000 });
    // Locate the Address cell by its COLUMN HEADER, not "last cell": the grid now carries a trailing
    // address-picker (dropdown button) cell, and — once Delivery Channel = Print — Return Envelope /
    // Certified Mail cells after that, so "last cell" came back blank (CONFIRMED live 2026-09-26: both
    // "To Street Address" and "To City, State, Zip" were reported BLOCKED although the row showed the
    // address). Header and body cells share td indexes (the leading checkbox column has a header cell too).
    address = await row.evaluate((tr) => {
      const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
      const scope = tr.closest('[id="GC_NewDocumentWorksheet-GC_NewDocumentScreen"]') || document;
      const headers = Array.from(scope.querySelectorAll('[role="columnheader"]')).filter((h) => h.offsetParent !== null);
      const idx = headers.findIndex((h) => clean(h.textContent) === 'Address');
      const tds = Array.from(tr.querySelectorAll('td'));
      const byHeader = idx >= 0 && tds[idx] ? clean(tds[idx].innerText) : '';
      if (byHeader) return byHeader;
      // Fallback for a layout without a matching header: the last cell that reads like "street, city, ST zip".
      const looksLikeAddress = tds.map((td) => clean(td.innerText)).filter((t) => /,/.test(t) && /\d/.test(t));
      return looksLikeAddress.length ? looksLikeAddress[looksLikeAddress.length - 1] : '';
    }) || undefined;
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

// Adds a second recipient via the Recipients tab's "Additional Recipient" control — CONFIRMED live this sits
// right next to "Set Primary Recipient" once a primary is chosen, opening the same kind of menu (every other
// eligible contact on the claim, plus a generic "Address Book/1099 Contacts" bucket). Only called when the
// template's own requirements actually reference a "Copy Name"/"Copy Address"/"cc:"-style field (see
// validationService.templateExpectsAdditionalRecipient) — those rows were otherwise permanently SKIPPED
// (conditional on "if additional recipient is entered"), since no scenario used to ever add one. WHO
// specifically gets picked usually doesn't matter for validation — only that a real second party is added so
// the letter's own "cc:" block has something genuine to check against — so by default this just takes the
// FIRST eligible menu item that isn't the generic Address Book bucket and isn't the primary recipient already
// picked. Mirrors setPrimaryRecipient's own address-capture (same grid, same column-header lookup), returning
// the same { name, address, streetAddress, cityStateZip } shape so fieldLabelSynonyms.js's
// additionalRecipient.* paths resolve exactly like recipient.* does for the primary.

// Reads every eligible (non-excluded) menu item's own index + raw (prefix-still-attached) text — a LIST, not
// just the first match, so a caller can choose among them (see pickBestCandidate) rather than always taking
// whichever sorts first.
async function findEligibleMenuCandidates(menu, excludeName) {
  return menu.evaluate((el, excludeNorm) => {
    const items = Array.from(el.querySelectorAll('[role="menuitem"]'));
    const eligible = [];
    items.forEach((it, idx) => {
      const raw = (it.textContent || '').trim();
      if (!raw) return;
      if (/address book/i.test(raw)) return;
      // DONEGAL DIRECT ACCOUNT excluded the same way setPrimaryRecipient already excludes it (the carrier's
      // own account, never the right party for a courtesy copy either).
      if (/donegal direct account/i.test(raw)) return;
      // CONFIRMED live: each item's own text is a 2-character initials "avatar" glued directly onto the real
      // name with no separator ("MAMARK ANTOLICK", "DCDENISE CHARLTON", "MCMary Claimant" — the first letter
      // of each of the name's first two words) — so an EXACT-equality check against excludeNorm (the clean
      // primary-recipient name) would never match; substring containment does.
      if (excludeNorm && raw.toLowerCase().includes(excludeNorm)) return;
      eligible.push({ idx, text: raw });
    });
    return eligible;
  }, (excludeName || '').trim().toLowerCase());
}

// Picks which eligible candidate to actually add — the FIRST one by default (existing, long-standing
// behavior: who gets picked usually doesn't matter), or one whose OWN Parties-Involved role matches
// `preferredRole` if given, falling back to first-eligible if no candidate has that role. CONFIRMED live via
// a full-catalog scan 2026-10-02: DIG141/DIG226/DIG239's "Agent Number" field only prints when the additional
// recipient specifically has the role "Producer" — picking an arbitrary eligible contact would usually pick
// someone else, correctly leaving the field blank per the template's own logic but never actually exercising
// this content check.
function pickBestCandidate(candidates, { preferredRole, partiesRoles, log = console.log } = {}) {
  const withCleanNames = candidates.map((c) => ({ ...c, name: c.text.length > 2 ? c.text.slice(2) : c.text }));
  if (preferredRole && partiesRoles && partiesRoles.length) {
    const match = withCleanNames.find((c) => {
      const party = partiesRoles.find((p) => p.name.toLowerCase() === c.name.toLowerCase());
      return party && party.roles.some((r) => r.toLowerCase() === preferredRole.toLowerCase());
    });
    if (match) {
      log(`setAdditionalRecipient: preferring "${match.name}" — has role "${preferredRole}"`);
      return match;
    }
    log(`setAdditionalRecipient: no eligible candidate has role "${preferredRole}" (checked: ${withCleanNames.map((c) => c.name).join(', ') || '(none)'}) — falling back to first eligible`);
  }
  return withCleanNames[0];
}

async function setAdditionalRecipient(page, { excludeName, preferredRole, partiesRoles, log = console.log } = {}) {
  // CONFIRMED live 2026-09-30 (diagnostic screenshot + DOM dump): unlike "Set Primary Recipient", this
  // button carries its own `data-gw-confirm` warning ("The document will be sent to the primary recipient
  // and additional recipients will receive a courtesy copy...") — a NATIVE browser confirm(), not a DOM
  // modal (a page screenshot taken right after the click showed the page completely unchanged, since a
  // native dialog renders outside the page surface entirely). Playwright auto-DISMISSES an unhandled native
  // dialog by default (same root cause documented in interactiveEditService.installDialogAutoAccept's own
  // comment) — which silently cancelled the whole action before the real recipient-picker menu (confirmed
  // present in the DOM, just never shown) could ever open, and `page.getByRole('menu').last()` then grabbed
  // an unrelated, always-present left-nav menu instead (its first item happened to read "Overview"). This
  // runs earlier in the flow than clickInteractiveAndWaitForEditor's own call to the same installer, so it
  // has to be installed here too — idempotent, so calling it again there later is harmless.
  installDialogAutoAccept(page, { log });
  // A short settle wait before opening this menu — the primary recipient's own Delivery Channel/Mail
  // Options/Email setup (validationService.js) now runs immediately before this call, and a couple of live
  // attempts right after that reordering saw this menu fail to open at all, suggesting a brief pending
  // re-render was still in flight. Diagnosed no further yet (see the saveDiagnostic calls below, now wired
  // up to capture a screenshot the moment this fails, instead of debugging blind from logs alone).
  await page.waitForTimeout(500);
  const btn = page.getByRole('button', { name: L.recipients.additionalRecipientButton });
  await btn.click();
  // CONFIRMED live 2026-09-30, across many rounds of live diagnostics:
  //   1. `page.getByRole('menu').last()` is NOT reliable here — "Set Primary Recipient" and "Additional
  //      Recipient" each have their OWN structurally-identical gw-subMenu ALWAYS present in the DOM (toggled
  //      via aria-hidden, not added/removed), both containing the exact same contact list including "Address
  //      Book/1099 Contacts" — so neither DOM-order (.last()) nor text-content search can tell them apart;
  //      both picked up the WRONG one at least once (a stale left-nav menu, an address-type sub-dropdown,
  //      the PRIMARY button's own hidden submenu). The reliable fix: scope to the submenu INSIDE this
  //      button's own gw-ToolbarButtonWidget ancestor specifically.
  //   2. A JS-synthetic `el.click()` inside page.evaluate() resolves without error but does NOT reliably
  //      register with the app (confirmed live: the menu stayed open, no row was added) — some widgets
  //      appear to need a real, OS-level "trusted" click, which only Playwright's own `.click()` provides.
  //      Reading the eligible item's INDEX via evaluate (fast, read-only) and then clicking it via a real,
  //      precisely-scoped Playwright locator combines correct targeting with a click that actually works.
  const container = btn.locator('xpath=ancestor::div[contains(@class,"gw-ToolbarButtonWidget")][1]');
  const menu = container.locator('.gw-subMenu, [role="menu"]').first();
  try {
    await menu.waitFor({ state: 'visible', timeout: 5000 });
  } catch (e) {
    // CONFIRMED live 2026-10-02: this menu intermittently never opens, and NOT because of a lack of eligible
    // contacts — ruled out live on a claim with 5+ eligible parties visible in the dropdown when opened by
    // hand, which still hit this exact timeout via automation. A diagnostic screenshot at the exact moment
    // showed a completely normal, idle page: no native dialog, no error, nothing obstructing the button — so
    // the real cause is still unknown (one candidate, untested: claims with a longer contact list may need
    // more than 5s to render the dropdown). Root-causing this further was deprioritized in favor of not
    // crashing the whole scenario over it — treated the same as "no eligible recipient found" below (log and
    // return undefined): the template's "Copy ..." requirements just stay unverified for that one scenario.
    const diagPath = await saveDiagnostic(page, 'setAdditionalRecipient_menuTimeout').catch(() => null);
    log(`setAdditionalRecipient: submenu never opened (cause unknown — continuing without an additional recipient) — ${e.message}${diagPath ? ` Diagnostic saved: ${diagPath}.png / .json` : ''}`);
    return undefined;
  }
  const candidates = await findEligibleMenuCandidates(menu, excludeName);
  if (!candidates.length) {
    log('setAdditionalRecipient: no eligible additional recipient found in the menu — "Copy ..." requirements will stay unverified for this scenario.');
    await page.keyboard.press('Escape').catch(() => {});
    return undefined;
  }
  const found = pickBestCandidate(candidates, { preferredRole, partiesRoles, log });
  try {
    await menu.locator('[role="menuitem"]').nth(found.idx).click({ timeout: 3000 });
  } catch (e) {
    // Unlike the menu-never-opened case above, an eligible item WAS genuinely found here, so this is the
    // long-documented race (menu closing before the click lands) rather than "nothing to add" — worth one
    // quick retry (re-open, re-find, re-click) before giving up, since the underlying recipient IS there.
    log(`setAdditionalRecipient: menu item click failed, retrying once — ${e.message}`);
    try {
      await btn.click();
      await menu.waitFor({ state: 'visible', timeout: 5000 });
      const retryCandidates = await findEligibleMenuCandidates(menu, excludeName);
      if (!retryCandidates.length) throw new Error('no eligible item on retry');
      const retryFound = pickBestCandidate(retryCandidates, { preferredRole, partiesRoles, log });
      await menu.locator('[role="menuitem"]').nth(retryFound.idx).click({ timeout: 3000 });
      found.idx = retryFound.idx;
      found.text = retryFound.text;
    } catch (e2) {
      const diagPath = await saveDiagnostic(page, 'setAdditionalRecipient_itemClickFailed').catch(() => null);
      log(`setAdditionalRecipient: retry also failed — ${e2.message}${diagPath ? ` Diagnostic saved: ${diagPath}.png / .json` : ''} — continuing without an additional recipient.`);
      await page.keyboard.press('Escape').catch(() => {});
      return undefined;
    }
  }
  const rawPick = found.text;
  // Strip that same 2-character initials prefix before using the name anywhere else (the Recipients grid's
  // own Name column, and the final returned value additionalRecipient.name compares against, are both the
  // clean name with no such prefix).
  const pick = rawPick.length > 2 ? rawPick.slice(2) : rawPick;
  log(`setAdditionalRecipient: menu item "${rawPick}" resolved to recipient "${pick}"`);

  let address;
  let deliveryChannelSet = false;
  try {
    const grid = page.locator('[role="grid"], table')
      .filter({ hasText: 'Delivery Channel' })
      .filter({ hasText: 'Address' })
      .last();
    const escaped = pick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Raw rendered text (hasText), not getByRole('row', {name}) — a defensive, more robust row lookup.
    const row = grid.locator('tr, [role="row"]').filter({ hasText: new RegExp(escaped) }).last();
    await row.waitFor({ state: 'visible', timeout: 5000 });
    // CONFIRMED live 2026-09-30 (screenshot): a freshly-added additional recipient's OWN row defaults its
    // Delivery Channel to "<none>", same as the primary recipient's row does before setDeliveryChannel()
    // runs on it — ClaimCenter likely only prints a "cc:" block for a recipient it considers actually
    // addressed. Scoped to THIS row specifically (not setDeliveryChannel's own page-wide .first(), which
    // would hit the PRIMARY recipient's dropdown instead).
    try {
      await row.getByRole('combobox', { name: /Delivery Channel/i }).selectOption({ label: 'Print' });
      deliveryChannelSet = true;
    } catch (_) { /* row's own combobox not found this way — leave unset, logged below either way */ }
    address = await row.evaluate((tr) => {
      const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
      const scope = tr.closest('[id="GC_NewDocumentWorksheet-GC_NewDocumentScreen"]') || document;
      const headers = Array.from(scope.querySelectorAll('[role="columnheader"]')).filter((h) => h.offsetParent !== null);
      const idx = headers.findIndex((h) => clean(h.textContent) === 'Address');
      const tds = Array.from(tr.querySelectorAll('td'));
      const byHeader = idx >= 0 && tds[idx] ? clean(tds[idx].innerText) : '';
      if (byHeader) return byHeader;
      const looksLikeAddress = tds.map((td) => clean(td.innerText)).filter((t) => /,/.test(t) && /\d/.test(t));
      return looksLikeAddress.length ? looksLikeAddress[looksLikeAddress.length - 1] : '';
    }) || undefined;
  } catch (_) { /* grid layout not present/visible for this additional recipient — leave unset */ }

  // CONFIRMED live 2026-10-02 (screenshot): some eligible contacts (e.g. an Underwriter/Main Contact-type
  // party) have no address on file at all — Address is a REQUIRED field on this grid, so leaving the row
  // unaddressed would only surface as a validation error later (same class of issue as the Return
  // Envelope/Certified Mail required-field gap fixed earlier). Remove the row and continue without an
  // additional recipient instead, same outcome as "no eligible recipient found" below.
  if (!address) {
    log(`setAdditionalRecipient: "${pick}" has no address on file — removing the row and continuing without an additional recipient.`);
    try {
      const grid = page.locator('[role="grid"], table')
        .filter({ hasText: 'Delivery Channel' })
        .filter({ hasText: 'Address' })
        .last();
      const escaped = pick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const row = grid.locator('tr, [role="row"]').filter({ hasText: new RegExp(escaped) }).last();
      // CONFIRMED live 2026-10-02: the row has 2 checkbox-like elements, and Playwright's .check() on
      // whichever matched first failed with "Clicking the checkbox did not change its state" — same class
      // of bug already hit and fixed for the Return Envelope/Certified Mail radios elsewhere in this file: a
      // custom `role="checkbox"` div is the real interactive surface, while a same-row native
      // input[type="checkbox"] can be a decorative/non-driving element .check()'s own verification reads
      // instead. A plain, real click on the role="checkbox" element specifically (not .check(), not the
      // combined/ambiguous selector) is what actually registers.
      const roleCheckboxCount = await row.locator('[role="checkbox"]').count().catch(() => 0);
      const checkbox = roleCheckboxCount > 0 ? row.locator('[role="checkbox"]').first() : row.locator('input[type="checkbox"]').first();
      log(`setAdditionalRecipient: DIAG removal — row has ${roleCheckboxCount} [role="checkbox"] element(s), using ${roleCheckboxCount > 0 ? 'role="checkbox"' : 'input[type="checkbox"]'}`);
      const structDump = await checkbox.evaluate((el) => {
        const describe = (e, depth) => e ? `<${e.tagName.toLowerCase()} role="${e.getAttribute('role') || ''}" class="${e.className || ''}" aria-checked="${e.getAttribute('aria-checked') || ''}" tabindex="${e.getAttribute('tabindex') || ''}">` + (depth > 0 ? ` / parent: ${describe(e.parentElement, depth - 1)}` : '') : '(none)';
        return describe(el, 3);
      }).catch((e) => `eval failed: ${e.message}`);
      log(`setAdditionalRecipient: DIAG removal — checkbox element chain: ${structDump}`);
      // CONFIRMED live 2026-10-02: neither a forced click nor a focus+Space keypress reliably toggles this
      // widget on the first try — one live run succeeded with focus+Space after click failed, another run
      // had BOTH fail outright. This is genuine flakiness (a real race, not a one-off), so retry the whole
      // click-then-space sequence a few times with a short settle pause, rather than trying each strategy
      // only once.
      let checkedAfterClick = 'false';
      for (let attempt = 1; attempt <= 4 && checkedAfterClick !== 'true'; attempt++) {
        if (attempt > 1) await page.waitForTimeout(300);
        await checkbox.click({ force: true, timeout: 3000 }).catch(() => {});
        checkedAfterClick = await checkbox.evaluate((el) => el.getAttribute('aria-checked')).catch(() => 'false');
        if (checkedAfterClick !== 'true') {
          await checkbox.focus().catch(() => {});
          await checkbox.press('Space').catch(() => {});
          checkedAfterClick = await checkbox.evaluate((el) => el.getAttribute('aria-checked')).catch(() => 'false');
        }
        log(`setAdditionalRecipient: DIAG removal — checkbox toggle attempt ${attempt}/4: aria-checked=${checkedAfterClick}`);
      }
      const removeBtn = page.getByRole('button', { name: 'Remove' });
      // The button is disabled until ClaimCenter's own app-state registers the row selection — poll briefly
      // rather than trust the click alone, same render-lag pattern hit repeatedly elsewhere today.
      let removeEnabled = false;
      const enabledDeadline = Date.now() + 2000;
      while (Date.now() < enabledDeadline) {
        removeEnabled = await removeBtn.first().isEnabled().catch(() => false);
        if (removeEnabled) break;
        await page.waitForTimeout(150);
      }
      log(`setAdditionalRecipient: DIAG removal — "Remove" button enabled after checkbox click: ${removeEnabled}`);
      await removeBtn.click({ timeout: 5000 });
      // Verify the row is actually gone, not just that the click resolved without error — CONFIRMED live
      // 2026-10-02 that ClaimCenter later rejected this unaddressed recipient with its own required-field
      // validation error, meaning a "successful" click here was NOT reliable proof the row was truly removed.
      // Poll briefly rather than check once immediately — a single check right after the click caught the
      // row still mid-removal (the diagnostic screenshot taken at that exact "failure" showed an already-
      // empty grid a moment later, consistent with a render lag, not a genuine failure).
      let stillThere = true;
      const removeDeadline = Date.now() + 2000;
      while (Date.now() < removeDeadline) {
        stillThere = await row.isVisible().catch(() => false);
        if (!stillThere) break;
        await page.waitForTimeout(150);
      }
      log(`setAdditionalRecipient: DIAG removal — row still visible after Remove click: ${stillThere}`);
      if (stillThere) throw new Error('row is still present after clicking Remove');
    } catch (e) {
      const diagPath = await saveDiagnostic(page, 'setAdditionalRecipient_removeFailed').catch(() => null);
      log(`setAdditionalRecipient: could not remove the unaddressed row — ${e.message}${diagPath ? ` Diagnostic saved: ${diagPath}.png / .json` : ''} (continuing anyway, without using it as the additional recipient)`);
    }
    return undefined;
  }

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
  log(`setAdditionalRecipient: picked "${pick}" (address: ${address || '(not captured)'}, Delivery Channel set to Print: ${deliveryChannelSet ? 'yes' : 'no'})`);

  return { name: pick, address, streetAddress, cityStateZip };
}

// CONFIRMED live 2026-09-30: once a SECOND recipient row exists, setMailOptions/setOneMailOption's own
// ID-based lookup (`[id*="PrimaryRecipient${field}_Ext"]`) stops finding anything at all, even for the
// PRIMARY row — ClaimCenter evidently re-keys these widgets' ids once more than one recipient exists
// (presumably to an indexed scheme, to disambiguate multiple rows). validationService.js now avoids this
// entirely for the primary row by finishing its whole setup (via the plain ID-based setMailOptions) BEFORE
// a second recipient is ever added — this row-scoped-by-name function is only needed for the ADDITIONAL
// recipient's own row, added after the primary already exists. Each field defaults to "No" unless explicitly
// requested Yes — a reasonable default for a courtesy copy, and not a field any of today's requirements
// compare against either way.
async function setRowMailOptions(page, recipientName, { returnEnvelope, certifiedMail, log = console.log } = {}) {
  if (!recipientName) return;
  try {
    const grid = page.locator('[role="grid"], table')
      .filter({ hasText: 'Delivery Channel' })
      .filter({ hasText: 'Address' })
      .last();
    const escaped = recipientName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Raw rendered text (hasText), not getByRole('row', {name}) — a defensive choice, not the actual fix for
    // the PRIMARY row's radios never rendering (that turned out to be a call-order issue, now fixed in
    // validationService.js — see its own long comment). This is just a more robust row-lookup regardless.
    if (process.env.SMARTCOMM_DIAG_MAILOPTIONS) {
      const diag = await grid.evaluate((gridEl) => {
        const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
        const rows = Array.from(gridEl.querySelectorAll('tr, [role="row"]'));
        const allRadios = Array.from(gridEl.querySelectorAll('[role="radio"]'));
        return {
          totalRowEls: rows.length,
          totalRadios: allRadios.length,
          rows: rows.map((r, i) => ({ idx: i, ownRadios: r.querySelectorAll('[role="radio"]').length, text: clean(r.innerText).slice(0, 100) })),
          radios: allRadios.map((r, i) => {
            let p = r.parentElement;
            while (p && p !== gridEl && !(p.matches('tr') || p.getAttribute('role') === 'row')) p = p.parentElement;
            return { idx: i, nearestRowText: p && p !== gridEl ? clean(p.innerText).slice(0, 80) : '(no row ancestor within grid)' };
          }),
        };
      }).catch((e) => ({ error: e.message }));
      log(`setRowMailOptions: DIAG full grid dump for "${recipientName}": ${JSON.stringify(diag)}`);
    }
    const matchingRows = grid.locator('tr, [role="row"]').filter({ hasText: new RegExp(escaped) });
    const row = matchingRows.last();
    const radios = row.locator('[role="radio"]');
    // CONFIRMED live 2026-10-02: a single immediate radios.count() read found 0 for BOTH rows even though
    // each row's own Delivery Channel had just been set to Print (required for these columns to render at
    // all — see the comment below) — the column's own render evidently lags a beat behind the selectOption()
    // call that set Delivery Channel. Poll briefly instead of trusting one synchronous read, since leaving
    // these REQUIRED (*) fields with no selection at all, rather than merely defaulted, is a likely
    // contributor to the Interactive-transition instability documented in templateExpectsAdditionalRecipient.
    let radioCount = 0;
    const radioDeadline = Date.now() + 5000;
    while (Date.now() < radioDeadline) {
      radioCount = await radios.count().catch(() => 0);
      if (radioCount > 0) break;
      await page.waitForTimeout(250);
    }
    const wants = [returnEnvelope, certifiedMail];
    for (let pairIdx = 0; pairIdx * 2 < radioCount; pairIdx++) {
      const base = pairIdx * 2;
      const target = radios.nth(wants[pairIdx] ? base : base + 1);
      await target.click({ force: true, timeout: 3000 }).catch(() => {});
    }
    log(`setRowMailOptions: set ${Math.floor(radioCount / 2)} mail-option pair(s) for "${recipientName}"`);
  } catch (e) {
    log(`setRowMailOptions: could not set mail options for "${recipientName}" — ${e.message}`);
  }
}

// CONFIRMED via live run 2026-09-03: this is a native <select> exposed as
// role=combobox — selectOption() sets it directly and doesn't need the
// (closed, so non-clickable) <option> to be independently visible, unlike a
// click-based open-then-click-option approach.
// CONFIRMED live 2026-10-02: row-scoping this call (so it targets the primary recipient's own combobox once
// a second recipient exists) was tried and DISPROVEN — even a genuine "" to "Print" value change (confirmed
// via inputValue() before/after, no exception) still left the Return Envelope/Certified Mail columns with 0
// radios for that row. The real fix is in validationService.js's call order instead: finish the primary
// recipient's whole Recipients-tab setup (this call included) BEFORE setAdditionalRecipient ever adds a
// second row — these columns evidently render their per-row content once, at the moment a row first needs
// them, and an EXISTING row changing to Print later doesn't get revisited, while a brand-new row inserted
// with Print already set (true for setAdditionalRecipient's own row-scoped selectOption) does.
async function setDeliveryChannel(page, channel = 'Print') {
  const byRole = page.getByRole('combobox', { name: /Delivery Channel/i }).first();
  try {
    await byRole.waitFor({ state: 'visible', timeout: 8000 });
    await byRole.selectOption({ label: channel });
    return;
  } catch (_) { /* row not rendered yet under this name — fall back below */ }
  await page.locator(L.recipients.deliveryChannelDropdown).first().selectOption({ label: channel });
}

// "Return Envelope" / "Certified Mail" — two Yes/No fields on the
// Recipients-tab row. CONFIRMED live 2026-09-23: these columns don't exist
// in the DOM at all until Delivery Channel is set to 'Print' (they're
// physical-mail-only options, absent for Email/Fax/SMS/<none>) — call this
// AFTER setDeliveryChannel(page, 'Print'), never before.
//
// Each option is a `<div class="gw-radioDiv" role="radio">` (a real,
// genuinely clickable widget for a real user — CONFIRMED live both by the
// user manually toggling it and by this function's own click reliably
// flipping the underlying <input>'s checked state) — but a PARENT wrapper
// (`.gw-cell-inner`) carries `aria-hidden="true"`, which hides every
// descendant from the accessibility tree regardless of its own role
// (standard ARIA inheritance). That's why Playwright's role-aware
// getByRole('radio') finds nothing here even though the field is fully
// usable — a first version of this function trusted that absence and wrongly
// concluded the field was permission-locked for non-admin users; it isn't.
// Fixed by matching the raw `role="radio"` HTML attribute directly
// (`locator('[role="radio"]')`, which — unlike getByRole — does NOT consult
// the accessibility tree or respect an ancestor's aria-hidden) and using a
// real simulated mouse click (`locator.click()`), not a JS-level
// `element.click()` (confirmed live NOT to register with this widget, which
// listens for actual pointer events, not a synthetic click).
//
// Each field's two role="radio" options render in a fixed, CONFIRMED-live
// document order: index 0 = "Yes", index 1 = "No" (verified by reading the
// underlying <input>'s value/checked state after each click, not assumed).
// Scoped per field by its
// id containing "PrimaryRecipient<FieldName>_Ext" — a standard, reusable
// Guidewire PCF widget id (not template-specific), and "PrimaryRecipient"
// in the id keeps this naturally scoped away from any "Additional Recipient"
// row if that flow is ever wired up.
async function setOneMailOption(page, fieldIdFragment, wantYes) {
  const container = page.locator(`[id*="PrimaryRecipient${fieldIdFragment}_Ext"]`).first();
  try {
    await container.waitFor({ state: 'attached', timeout: 8000 });
  } catch (_) {
    console.log(`setMailOptions: "${fieldIdFragment}" field not found — Delivery Channel may not be set to Print for this template`);
    return;
  }
  const options = container.locator('[role="radio"]');
  const target = options.nth(wantYes ? 0 : 1);
  await target.click({ force: true });
}

async function setMailOptions(page, { returnEnvelope, certifiedMail } = {}) {
  if (returnEnvelope !== undefined) await setOneMailOption(page, 'ReturnEnvelope', returnEnvelope);
  if (certifiedMail !== undefined) await setOneMailOption(page, 'CertifiedMail', certifiedMail);
}

// CONFIRMED live 2026-10-02: emailField's own locator is page-wide, not row-scoped — with a second
// recipient present, `.first()` always lands on whichever row is topmost in the grid (the PRIMARY row),
// so the additional recipient's own Email field was NEVER actually filled, left blank regardless of what
// was passed here. recipientName scopes to that specific row (same grid/row pattern setRowMailOptions
// uses) — omit it for the single-recipient case, where the old page-wide behaviour is still correct.
async function setEmail(page, email, recipientName) {
  if (!email) return;
  if (recipientName) {
    try {
      const grid = page.locator('[role="grid"], table')
        .filter({ hasText: 'Delivery Channel' })
        .filter({ hasText: 'Address' })
        .last();
      const escaped = recipientName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Raw rendered text (hasText), not getByRole('row', {name}) — a defensive, more robust row lookup.
      // recipientName is only ever passed for the ADDITIONAL recipient's own row (validationService.js sets
      // the primary's email with the unscoped call below, before a second row ever exists).
      const row = grid.locator('tr, [role="row"]').filter({ hasText: new RegExp(escaped) }).last();
      const field = row.locator(L.recipients.emailField).first();
      if (await field.isVisible().catch(() => false)) {
        await field.fill(email);
        return;
      }
    } catch (_) { /* row-scoped lookup failed — fall back to the page-wide one below */ }
  }
  const field = page.locator(L.recipients.emailField).first();
  if (await field.isVisible().catch(() => false)) await field.fill(email);
}

// status/securityType default to whatever the wizard itself defaults them
// to (Draft / Unrestricted document, CONFIRMED live) — only selected when a
// caller passes a different value (scenarioVariants.js rotates these across
// a template's scenarios). Neither field is referenced anywhere in
// requirement/merge-field matching (fieldLabelSynonyms.js, payloadService.js
// — confirmed by search), so varying them doesn't touch generated PDF
// content, only the ClaimCenter document record's own metadata.
// Returns what was ACTUALLY applied ({documentType,status,securityType}: the
// value set, or null when the field isn't on this template's screen / the
// select failed) so the report never claims a dropdown value that was never
// set — e.g. DIG52 on Cloud Test has no Security Type or Language field.
async function setAdditionalData(page, { language = 'English (US)', documentType = 'Other', status, securityType } = {}) {
  const applied = { documentType: null, status: null, securityType: null };
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
    applied.documentType = documentType;
  } catch (_) {
    await page.locator(L.additionalData.documentTypeDropdown).first().selectOption({ label: documentType })
      .then(() => { applied.documentType = documentType; }).catch(() => {});
  }

  if (status) {
    const statusField = page.getByRole('combobox', { name: /^Status$/i }).first();
    if (await statusField.isVisible().catch(() => false)) {
      await statusField.selectOption({ label: status })
        .then(() => { applied.status = status; })
        .catch((e) => {
          console.log(`setAdditionalData: could not set Status to "${status}" — ${e.message}`);
        });
    } else {
      console.log('setAdditionalData: Status field not present on this screen — skipping');
    }
  }

  if (securityType) {
    const securityField = page.getByRole('combobox', { name: /Security Type/i }).first();
    if (await securityField.isVisible().catch(() => false)) {
      await securityField.selectOption({ label: securityType })
        .then(() => { applied.securityType = securityType; })
        .catch((e) => {
          console.log(`setAdditionalData: could not set Security Type to "${securityType}" — ${e.message}`);
        });
    } else {
      console.log('setAdditionalData: Security Type field not present on this screen — skipping');
    }
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
  return applied;
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
  // Generate can also fail server-side with CC's own inline error instead of
  // ever producing a results row (CONFIRMED live, DIG59/claim
  // CPP-DE-01-26-0000049: "Data required to create document not found...").
  // Racing both means a real CC-side failure surfaces immediately, with its
  // own message, instead of masquerading as a generic 120s locator timeout —
  // the row and the error are mutually exclusive outcomes of the same click,
  // so whichever becomes visible first is the real one.
  const errorBanner = page.getByRole('group', { name: L.create.errorsGroup });
  // Each branch swallows its own eventual rejection (rather than letting
  // Promise.race's overall .catch do it) so the LOSING wait — still running
  // in the background for up to 120s after the other one already settled —
  // never produces an unhandled promise rejection once its own timeout hits.
  const winner = await Promise.race([
    resultRow.waitFor({ state: 'visible', timeout: 120000 }).then(() => 'row').catch(() => 'row-timeout'),
    errorBanner.waitFor({ state: 'visible', timeout: 120000 }).then(() => 'error').catch(() => 'error-timeout'),
  ]);

  if (winner === 'error') {
    const message = (await errorBanner.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    throw new Error(`GENERATE_FAILED: ClaimCenter reported an error instead of producing a document — ${message || '(error text unavailable)'}`);
  }
  if (winner !== 'row') {
    // Neither the row nor an error banner showed up inside 120s.
    throw new Error('GENERATE_TIMEOUT: neither a results row nor a ClaimCenter error message appeared within 120s of clicking Generate.');
  }

  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await resultRow.locator(L.create.downloadIcon).click();
  const download = await downloadPromise;

  const fileName = `${fileNamePrefix}_${Date.now()}.pdf`;
  const savePath = path.join(DOWNLOAD_DIR, fileName);
  await download.saveAs(savePath);
  return savePath;
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
  DOWNLOAD_DIR, openCreateFromTemplate, selectTemplate, searchTemplateByName, setPrimaryRecipient,
  setAdditionalRecipient, setRowMailOptions, setDeliveryChannel, setMailOptions, setEmail,
  setAdditionalData, generateOnDemand, downloadPayload,
};
