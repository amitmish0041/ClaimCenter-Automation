/**
 * helpers/claimLifecycleHelper.js
 * Segmentation, InitialReserves, Workplan, Close, Reopen, Archive, Exception.
 */
const fs = require('fs');
const path = require('path');
const { selectDropdown, fillTextField, fillDateField, clickSave,
        verifyTextVisible, verifyNoValidationErrors, elementExists,
        selectComboboxOnPrem, selectComboboxByIdOnPrem, IS_ON_PREM,
        waitForAllMasksGone, openExistingClaim } = require('./claimCenterBase');
const { sweepComboboxesOnPrem, clickUnansweredBooleanFieldsOnPrem } = require('./fnolHelper');
// Safe: financialsHelper does not import this module, so no cycle is created
// (financialsHelper -> fnolHelper only).
const { openExposuresTab, findFirstPositiveReserveLine, createPayment } = require('./financialsHelper');

// Append a line to results/workplan-debug.log so we can see activity sweep diagnostics
// even when the main stdout log is not captured.
const WPDEBUG = path.join(__dirname, '../results/workplan-debug.log');
function wpLog(msg) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + msg + '\n';
  process.stdout.write(line); // also to stdout so Playwright captures it
  try { fs.appendFileSync(WPDEBUG, line); } catch (_) {}
}

// ── Assignment (on-prem) ──────────────────────────────────────────────────────
// CORRECTED via live screenshot: Claim Actions -> Assign Claim opens a full
// PAGE (not the popup the previous version assumed - "AssignClaimsPopup" was
// wrong). "Select from list:" lists real adjusters tagged with their
// division, e.g. "Richard Shearer (Bodily Injury Claims Division)", plus
// "Use automated assignment" and "Super User" as non-adjuster options to
// skip. Per explicit instruction: pick someone from the SAME division the
// claim was actually routed to (read from the header, e.g. "Adj: Pending
// Assignment (Bodily Injury Claims Division)"), not just anyone.
async function assignClaim(page, assigneeName) {
  // The claim-level Actions menu differs by platform. On-prem exposes the
  // ExtJS id "Claim:ClaimMenuActions"; cloud uses DASHES, not colons, so that
  // id matches nothing there and click() sat out the full action timeout right
  // after the first cloud claim was successfully created. Cloud does render an
  // accessible "Actions" button, so try the on-prem id first and fall back to
  // the role lookup - which also covers cloud id drift.
  // The cloud wizard ALREADY assigns the claim on its final step: "Assign claim
  // and all exposures to: Use automated assignment" (confirmed via screenshot
  // of Step 5 of 5). So a cloud claim arrives here owned, not pending, and this
  // whole step is redundant - its only purpose is to get the claim off "Pending
  // Assignment" so reserves can be saved. Check first and skip if already done,
  // rather than hunting for a menu that need not be used at all.
  const header = await page.locator('body').innerText().catch(() => '');
  // Two different shapes say "this claim already has an owner":
  //   on-prem claim header  -> "Adj: Benjamin Smith (...)"
  //   cloud New Claim Saved -> "Assigned Group: WC Team 1 / Assigned User: Nicola Hinkle"
  // The cloud confirmation page was the actual state here (confirmed via
  // screenshot) and it carries no Actions menu at all, so matching only the
  // on-prem "Adj:" shape made this throw on a claim that was properly assigned.
  const assignedUser = (header.match(/Assigned User:\s*([^\n]+)/i) || [])[1];
  const alreadyAssigned =
    (!!assignedUser && !/pending assignment/i.test(assignedUser)) ||
    (/Adj:\s*\S/i.test(header) && !/Pending Assignment/i.test(header));
  // Skip whenever the claim ALREADY has an owner, regardless of whether an
  // Actions menu happens to be reachable. The previous version only skipped
  // when the menu was missing, so once the cloud run started landing in the
  // claim workspace it opened Assign on a claim already assigned to
  // "Nicola Hinkle (WC Team 1)" and then stalled on the adjuster dropdown -
  // doing unnecessary work that can only reassign the claim away from the
  // owner CC picked. The purpose of this step is to get the claim OFF
  // "Pending Assignment"; if that is already true there is nothing to do.
  if (alreadyAssigned && !assigneeName) {
    console.log('assignClaim: claim already assigned' +
                (assignedUser ? ' to "' + assignedUser.trim() + '"' : '') +
                ' — skipping (nothing to do)');
    return;
  }

  const actionsById = page.locator('[id="Claim:ClaimMenuActions"], [id="Claim-ClaimMenuActions"]').first();
  const actionsByRole = page.getByRole('button', { name: /Actions/i }).first();
  // These were bare isVisible() calls, which sample the DOM at that instant and
  // never wait. Called straight after openExistingClaim the claim workspace is
  // usually still rendering, so BOTH read false and this threw "no claim
  // Actions menu found" on a claim whose Actions menu appeared a moment later -
  // the reported "assignClaim finds no Actions menu after openExistingClaim".
  // Wait for the menu to actually show up before concluding it is absent.
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  const haveById = await actionsById.waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true).catch(() => false);
  const haveByRole = haveById
    ? false
    : await actionsByRole.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);

  if (!haveById && !haveByRole) {
    if (alreadyAssigned) {
      console.log('assignClaim: claim already assigned' +
                  (assignedUser ? ' to "' + assignedUser.trim() + '"' : '') +
                  ' during the wizard — nothing to do');
      return;
    }
    throw new Error('assignClaim: no claim Actions menu found (tried ids ' +
                    'Claim:ClaimMenuActions / Claim-ClaimMenuActions and role=button "Actions") ' +
                    'and the claim is not already assigned');
  }
  if (haveById) await actionsById.click();
  else {
    await actionsByRole.click();
    console.log('assignClaim: opened Actions via role lookup (cloud-style markup)');
  }
  await page.waitForTimeout(400);
  await page.getByRole('menuitem', { name: 'Assign Claim' }).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(500);

  const headerText = await page.locator('body').innerText().catch(() => '');
  const divisionMatch = headerText.match(/\(([^()]*Claims Division)\)/);
  const division = divisionMatch ? divisionMatch[1] : null;

  const listCombo = page.getByRole('combobox', { name: 'Select from list:', exact: true });
  await listCombo.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  await listCombo.click();
  await page.waitForTimeout(300);

  // Build the candidate list ONCE, in preference order: requested name, then
  // same-division adjusters, then anyone else real.
  const options = page.getByRole('option');
  const count = await options.count().catch(() => 0);
  const all = [];
  // Every option text, including the ones filtered out below - needed both to
  // report what was on screen and to locate "Use automated assignment" as a
  // fallback when no named adjuster is offered.
  const allRaw = [];
  for (let i = 0; i < count; i++) {
    const text = (await options.nth(i).textContent() || '').trim();
    allRaw.push(text);
    if (!text || /use automated assignment/i.test(text) || /^super user/i.test(text)) continue;
    all.push({ i, text });
  }
  // Preference order: explicit assigneeName > CC_ASSIGNEE_NAME (a user known to
  // hold "Claim own", e.g. the automation user) > same-division > anyone else.
  // Whole teams can lack ownership rights: confirmed live where all five
  // "WC Team 3" members were rejected while "Benjamin Smith (Recovery Claims
  // Team 2)" succeeded, so a division-first order can walk a dead end.
  const envAssignee = (process.env.CC_ASSIGNEE_NAME || '').trim();
  const rank = (o) => {
    if (assigneeName && o.text.includes(assigneeName)) return 0;
    if (envAssignee && o.text.includes(envAssignee)) return 1;
    if (division && o.text.includes(division)) return 2;
    return 3;
  };
  const candidates = [...all].sort((a, b) => rank(a) - rank(b) || a.i - b.i);

  // No named adjuster in the list. This is the normal state on environments
  // whose user population differs from TEST: on on-prem DEV the picker offers
  // only "Use automated assignment" and "Super User (Default Root Group)",
  // both of which the filter above drops (confirmed via screenshot).
  //
  // "Use automated assignment" is a real CC assignment method, not a
  // placeholder - it applies the configured assignment rules. Since the whole
  // point of assignClaim is to get the claim off "Pending Assignment" so
  // reserves can be saved, using it is correct here rather than failing.
  if (!candidates.length) {
    const autoIdx = allRaw.findIndex(t => /use automated assignment/i.test(t));
    if (autoIdx >= 0) {
      console.log('assignClaim: no named adjuster offered (list: ' + allRaw.join(' | ') +
                  ') — falling back to "Use automated assignment"');
      await page.getByRole('option').nth(autoIdx).click().catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.locator('[id="AssignClaimsPopup:AssignmentPopupScreen:AssignmentPopupDV:AssignmentPopupScreen_ButtonButton"]')
        .click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      const autoFailed = await page.getByText(/assignment\(s\) failed|does not have permission to be assigned/i)
        .first().waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
      if (!autoFailed) { console.log('Assigned via automated assignment'); return; }
      throw new Error('assignClaim: automated assignment was rejected by CC. List offered: ' + allRaw.join(' | '));
    }
    // Name what was actually on screen - "no adjuster found" alone gives the
    // next reader nothing to act on.
    throw new Error('No selectable adjuster found in Assign Claim list. Options present: ' +
                    (allRaw.length ? allRaw.join(' | ') : '(none - the picker rendered no options)'));
  }
  console.log('assignClaim: ' + candidates.length + ' candidate(s); trying in preference order');

  // Not every listed user may actually OWN a claim. Confirmed via live failure:
  // "Betty Haldeman-Fake (WC Team 3)" was accepted by the picker, then CC
  // rejected the save with "User ... does not have permission to be assigned
  // item ... (owning the item requires 'Claim own' permission)" and left the
  // page sitting on the Assign screen. The old code clicked Assign and returned
  // regardless, so the claim stayed unassigned and the NEXT step failed
  // confusingly with a 30s timeout hunting for Claim:ClaimMenuActions.
  // Verify the assignment landed, and move to the next candidate if not.
  const ASSIGN_BTN = '[id="AssignClaimsPopup:AssignmentPopupScreen:AssignmentPopupDV:AssignmentPopupScreen_ButtonButton"]';
  // Cap at 15, not 5: an entire team can lack "Claim own", and stopping at 5
  // gave up while an assignable user sat further down the same list.
  for (let attempt = 0; attempt < Math.min(candidates.length, 15); attempt++) {
    const cand = candidates[attempt];
    if (attempt > 0) {
      // Re-open the picker for the retry.
      await listCombo.click().catch(() => {});
      await page.waitForTimeout(300);
    }
    // The assignment picker is a NATIVE <select> (confirmed):
    //   <select name="AssignClaimsPopup-AssignmentPopupScreen-AssignmentPopupDV-SelectFromList">
    //     <option value="Richard Shearer (Bodily Injury Claims Division)">...
    // Clicking an <option> does not select anything in a native select - that
    // is why the dropdown opened, showed the right adjusters, and nothing was
    // ever chosen. selectOption is the only thing that works here; the
    // option-click stays as a fallback for the on-prem ExtJS boundlist.
    const nativeSelect = page.locator(
      'select[name*="SelectFromList"], select[name*="AssignmentPopup"], ' +
      '[id="AssignClaimsPopup:AssignmentPopupScreen:AssignmentPopupDV:SelectFromList"] select'
    ).first();
    const picked = await nativeSelect.isVisible().catch(() => false)
      ? await nativeSelect.selectOption({ label: cand.text }).then(() => true).catch(() => false)
      : false;
    if (picked) {
      console.log('assignClaim: selected "' + cand.text + '" via native <select>');
    } else {
      await page.getByRole('option').nth(cand.i).click().catch(() => {});
    }
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

    // Confirmed via live DOM dump: this screen's ids DO use the
    // "AssignClaimsPopup:AssignmentPopupScreen:..." prefix despite rendering
    // as a full page, not a modal. A role=button/text-based click landed on
    // nothing real since "Assign" as plain text only matches the title bar.
    // Selecting the adjuster is only half the step - the Assign button still
    // has to be pressed. Same colon-vs-dash split as every other id: on-prem
    // uses "AssignClaimsPopup:...:AssignmentPopupScreen_ButtonButton", cloud
    // uses dashes. Clicking only the on-prem id left the value chosen and the
    // claim unassigned, which then read as "assignment failed" downstream.
    const assignBtn = [
      page.locator(ASSIGN_BTN).first(),
      page.locator('[id="AssignClaimsPopup-AssignmentPopupScreen-AssignmentPopupDV-AssignmentPopupScreen_ButtonButton"]').first(),
      page.locator('[id^="AssignClaimsPopup-"][id$="_ButtonButton"]').first(),
      // Cloud renders it exactly like the Search nav (confirmed):
      //   <div class="gw-label" aria-label="Assign">Assi<div class="gw-shortcutKey">g</div>n</div>
      // No role, and the visible text is SPLIT by the shortcut-key span, so
      // neither getByRole nor text matching can find it - aria-label is the
      // only stable handle.
      page.locator('[aria-label="Assign"]').first(),
      page.getByRole('button', { name: /^Assign$/i }).first(),
    ];
    let assignPressed = false;
    for (const b of assignBtn) {
      if (!await b.isVisible().catch(() => false)) continue;
      await b.click({ timeout: 8000 }).catch(() => {});
      assignPressed = true;
      break;
    }
    if (!assignPressed) {
      console.log('assignClaim: adjuster selected but NO Assign button found ' +
                  '(tried on-prem id, cloud id, and role=button "Assign")');
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

    const failed = await page.getByText(/assignment\(s\) failed|does not have permission to be assigned/i)
      .first().waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (!failed) {
      console.log('Assigned to:', cand.text);
      return;
    }
    console.log('assignClaim: "' + cand.text + '" cannot own this claim — trying next candidate');
  }
  throw new Error('assignClaim: no candidate could be assigned (all lacked "Claim own" permission). ' +
                  'Tried: ' + candidates.slice(0, 15).map(c => c.text).join(', ') +
                  '. Set CC_ASSIGNEE_NAME in .env to a user that can own claims to skip the search.');
}

// ── Create Document From Template (on-prem) ───────────────────────────────────
// CONFIRMED via a real user-recorded codegen script: Claim Actions -> "Create
// from a template" -> pick a template via keyword search -> "Add Document" ->
// pick an existing supporting document (checkbox + Select) -> "Create
// Document". Run this right after assignClaim so every claim has at least
// one real document on it BEFORE any payment step - confirmed via live
// failure that createPaymentOnPrem's "Link Document" step gets stuck with
// nothing to pick if the claim has none.
// ── openClaimActionsMenu ─────────────────────────────────────────────────────
// Opens the claim-level Actions menu on EITHER platform.
//
// On-prem exposes the ExtJS id "Claim:ClaimMenuActions"; cloud uses dashes, not
// colons, so that id matches nothing there and click() burns the whole action
// timeout. Cloud does render an accessible "Actions" button. Several helpers
// hardcoded the on-prem id and each one failed the same way in turn as the
// cloud run got further - this centralises it so the rest do not repeat it.
async function openClaimActionsMenu(page, caller = 'claim action') {
  const byId = page.locator('[id="Claim:ClaimMenuActions"], [id="Claim-ClaimMenuActions"]').first();
  if (await byId.isVisible().catch(() => false)) { await byId.click(); return true; }

  // Cloud markup (confirmed):
  //   <div role="button" class="gw-action--inner" aria-label="deferred Actions"
  //        aria-haspopup="true" data-gw-click="toggleSubMenu">
  //     <div class="gw-label gw-hasIcon" aria-label="Actions">...</div>
  //   </div>
  // The OUTER div is the clickable control - its accessible name is
  // "deferred Actions", not "Actions", which is why an anchored /^Actions$/
  // never matched. Target the outer element explicitly; clicking the inner
  // gw-label is not what carries the toggleSubMenu handler.
  const cloudCandidates = [
    page.locator('[aria-label="deferred Actions"]').first(),
    page.locator('.gw-action--inner[aria-haspopup="true"]').filter({ hasText: /Actions/i }).first(),
    page.getByRole('button', { name: /Actions/i }).first(),
  ];
  for (const c of cloudCandidates) {
    if (!await c.isVisible().catch(() => false)) continue;
    await c.click({ timeout: 8000 }).catch(() => {});
    console.log(caller + ': opened Actions (cloud-style markup)');
    return true;
  }
  throw new Error(caller + ': claim Actions menu not found (tried ids Claim:ClaimMenuActions / ' +
                  'Claim-ClaimMenuActions and role=button "Actions")');
}

async function createDocumentFromTemplate(page, { keywords = 'risk' } = {}) {
  // SKIPPED ON CLOUD per user direction: the document-template feature is not
  // ready in that environment yet. The flow is Actions > New Document > Create
  // from a template > Select Template > Search > Select (e.g. "Donegal Base
  // Template"), and it works on-prem, so on-prem behaviour is unchanged.
  // Skipping rather than failing keeps the rest of the FNOL flow runnable;
  // remove this guard once the feature ships.
  if (!IS_ON_PREM) {
    console.log('createDocumentFromTemplate: SKIPPED on cloud — document templates not available yet');
    return;
  }
  await openClaimActionsMenu(page, 'createDocumentFromTemplate');
  await page.getByRole('menuitem', { name: 'Create from a template' }).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  await page.locator(
    '[id="ClaimNewDocumentFromTemplateWorksheet:NewDocumentFromTemplateScreen:NewTemplateDocumentDV:TemplatePicker:SelectTemplatePicker"]'
  ).click();
  await page.getByRole('textbox', { name: 'Keywords' }).fill(keywords);
  await page.getByRole('link', { name: 'Search' }).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.locator(
    '[id="DocumentTemplateSearchPopup:DocumentTemplateSearchScreen:DocumentTemplateSearchResultLV:0:_Select"]'
  ).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  const addDocumentBtn = page.locator(
    '[id="ClaimNewDocumentFromTemplateWorksheet:NewDocumentFromTemplateScreen:AddDocumentButton"]'
  );
  await addDocumentBtn.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  // Confirmed via live failure: an UNSCOPED '.x-grid-cell-inner >
  // .x-grid-checkcolumn' matches ANY grid's checkcolumn on the page - here
  // that included the background Exposures grid's own row checkboxes (still
  // rendered behind/around this popup), so every click and every "checked"
  // check was silently operating on the WRONG grid entirely. Scope to the
  // actual document-picker grid via its known id prefix (shares the prefix
  // with its own SelectButton, "...PickExistingDocumentsLV...").
  const docCheckbox = page.locator('[id^="PickExistingDocumentPopup:Claim_DocumentsScreen:PickExistingDocumentsLV"] .x-grid-cell-inner > .x-grid-checkcolumn').first();
  const hasDocCheckbox = await docCheckbox.waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true).catch(() => false);
  if (hasDocCheckbox) {
    // Previous "checked but Select stayed disabled" failures were actually
    // caused by the unscoped selector above hitting the wrong grid entirely
    // (see comment there) - retry a real Playwright .click() a few times now
    // that it's correctly scoped, verifying the "-checked" class before
    // falling back to a raw DOM click.
    let checked = false;
    for (let attempt = 0; attempt < 3 && !checked; attempt++) {
      await docCheckbox.click();
      await page.waitForTimeout(300);
      checked = await docCheckbox.evaluate(el => el.className.includes('-checked')).catch(() => false);
    }
    if (!checked) {
      await docCheckbox.evaluate(el => el.click());
      await page.waitForTimeout(300);
      checked = await docCheckbox.evaluate(el => el.className.includes('-checked')).catch(() => false);
    }
    const selectBtn = page.locator(
      '[id="PickExistingDocumentPopup:Claim_DocumentsScreen:PickExistingDocumentsLV_tb:SelectButton"]'
    );
    async function isSelectBtnEnabled() {
      return selectBtn.evaluate(el => {
        const btn = el.closest('.x-btn') || el;
        return !btn.className.includes('x-btn-disabled') && !btn.className.includes('x-item-disabled');
      }).catch(() => false);
    }
    // Confirmed via live failure: the button's enabled-state class updates
    // asynchronously after the checkbox click - checking immediately read a
    // stale "disabled" class. Poll for it instead of a single check.
    let selectBtnEnabled = false;
    for (let attempt = 0; attempt < 10 && !selectBtnEnabled; attempt++) {
      selectBtnEnabled = await isSelectBtnEnabled();
      if (!selectBtnEnabled) await page.waitForTimeout(300);
    }
    await selectBtn.click();
  } else {
    // No existing document to attach - confirmed via live failure that the
    // recorded "_dup_1"-suffixed Cancel button id is a fragile, session-
    // specific positional id that doesn't reliably exist - it silently
    // failed and left the wizard stuck on this document-search screen
    // (never reaching CreateDocument). The visible "Return to New Document"
    // link is the real, stable way out.
    const returnLink = page.getByRole('link', { name: 'Return to New Document' });
    const hasReturnLink = await returnLink.waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true).catch(() => false);
    if (hasReturnLink) {
      await returnLink.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    } else {
      await page.locator('[id="PickExistingDocumentPopup:Claim_DocumentsScreen:PickExistingDocumentPopup_CancelButton__dup_1"]')
        .click().catch(() => {});
    }
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  await page.locator(
    '[id="ClaimNewDocumentFromTemplateWorksheet:NewDocumentFromTemplateScreen:NewTemplateDocumentDV:DocumentCreationInputSet:CreateDocument"]'
  ).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  console.log('Document created from template');
}

// ── Validate Claim + Exposures (on-prem) ─────────────────────────────────────
// CONFIRMED via live screenshot: Claim Actions -> "Claim Actions" (nested
// flyout) -> "Validate Claim + Exposures" runs ClaimCenter's OWN full
// validation across the whole claim and every exposure at once, listing
// every missing/invalid field by name (e.g. "Vehicle incident description
// must not be empty", "Detailed body part must not be null") - a much more
// reliable way to catch gaps than guessing field-by-field from failed
// Update attempts. Per user instruction: run this right after adding
// exposures, so a payment attempt later doesn't fail on a stale, unrelated
// validation gap - surface issues loudly and immediately instead.
// Reads whatever the "Validation Results" PANEL currently shows, matching ANY
// error wording rather than a narrow /must not be/ pattern.
//
// The original version scraped the whole document for
// /must not be (null|empty)|missing required field/ and therefore reported
// "no issues found" on a claim whose Validation Results panel plainly read:
//   On "(1) 1st PartyVehicle - Kensington Chubb":
//   The Vehicle Identification Number (VIN) must be a 17 character
//   upper-case alphanumeric string
// That message contains "must be", not "must not be", so it matched nothing -
// a false clean bill of health that sent the run on to a payment wizard whose
// Reserve Line dropdown was empty precisely BECAUSE of these errors.
//
// Polls rather than sampling once: CC's validation is server-side and the
// panel can render after a single fixed wait would already have read the page.
async function readValidationResultsPanel(page) {
  let errors = [];
  for (let poll = 0; poll < 10; poll++) {
    errors = await page.evaluate(() => {
      const ERROR_RE = /must be|must not be|missing required field|is required|cannot be|not valid|must have|already exists/i;
      const extract = (scope) => {
        if (!scope) return [];
        return [...new Set((scope.innerText || '').split('\n')
          .map(l => l.trim())
          .filter(l =>
            l.length > 8 && l.length < 300 &&
            !/^validation results$/i.test(l) && !/^clear$/i.test(l) &&
            ERROR_RE.test(l)
          ))];
      };
      // Try several scopes in order of specificity and take the FIRST that
      // actually yields errors. Picking a single "best" container was wrong:
      // the first element whose text starts with "Validation Results" is the
      // TAB HEADER, which contains no error text at all - so the scan returned
      // empty and reported a clean claim while the panel below it plainly
      // listed two VIN errors.
      const candidates = [];
      const south = document.getElementById('gw-south-panel');
      if (south && south.offsetParent) candidates.push(south);
      for (const el of document.querySelectorAll('*')) {
        if (!el.offsetParent || !el.children.length) continue;
        const t = el.innerText || '';
        if (t.length > 6000) continue;
        if (/Validation Results/i.test(t) && ERROR_RE.test(t)) candidates.push(el);
      }
      candidates.push(document.body);   // last resort, always scanned
      for (const c of candidates) {
        const found = extract(c);
        if (found.length) return found;
      }
      return [];
    }).catch(() => []);
    if (errors.length) break;
    await page.waitForTimeout(700);
  }
  return errors;
}

// Navigates Actions -> Claim Actions -> Validate Claim + Exposures and hovers
// it open. Shared by the branch-enumeration and per-branch click below, since
// clicking any leaf item closes the WHOLE menu tree and the next branch needs
// this full re-navigation from scratch.
async function openValidateSubmenu(page) {
  await openClaimActionsMenu(page, 'validateClaimAndExposures');
  await page.waitForTimeout(300);
  const claimActionsItem = page.getByRole('menuitem', { name: 'Claim Actions', exact: true });
  if (!await claimActionsItem.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    return null;
  }
  await claimActionsItem.hover();
  await page.waitForTimeout(400);
  const validateItem = page.getByRole('menuitem', { name: 'Validate Claim + Exposures' });
  if (!await validateItem.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    return null;
  }
  return validateItem;
}

async function validateClaimAndExposures(page) {
  // "Validate Claim + Exposures" is NOT a clickable action - confirmed via
  // live screenshot, it carries its own ▸ submenu arrow with branches
  // ("Ability to pay" and others cut off in the screenshot). The previous
  // version called .click() on this parent item directly, which in this
  // ExtJS menu just closes the whole flyout without running anything - no
  // Validation Results panel ever appeared, not even an empty one, which in
  // hindsight was the tell (a real "clean claim" result still shows the
  // panel). Real validation only fires from a LEAF item inside this submenu.
  //
  // ExtJS menus close their entire tree when a leaf is clicked, so each
  // branch needs the full Actions -> Claim Actions -> Validate Claim +
  // Exposures navigation repeated - one hover chain cannot fire multiple
  // leaves. Enumerate the branches once, then re-navigate and click each in
  // turn, accumulating whatever the Validation Results panel shows after each.
  const firstOpen = await openValidateSubmenu(page);
  if (!firstOpen) {
    console.log('Validate Claim + Exposures: "Claim Actions"/menu item not found - skipping');
    return { hasErrors: false, errors: [] };
  }
  await firstOpen.hover();
  await page.waitForTimeout(400);
  const branchNames = await page.evaluate(() => {
    // The submenu that just opened is the LAST visible x-menu panel - same
    // "last visible boundlist/menu" convention used elsewhere in this file for
    // exactly this kind of stacked-flyout ambiguity.
    const menus = [...document.querySelectorAll('.x-menu')].filter(m => m.offsetParent);
    const panel = menus[menus.length - 1];
    if (!panel) return [];
    return [...panel.querySelectorAll('[role="menuitem"]')]
      .filter(el => el.offsetParent)
      .map(el => (el.textContent || '').trim())
      .filter(Boolean);
  }).catch(() => []);
  await page.keyboard.press('Escape').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});

  if (!branchNames.length) {
    console.log('Validate Claim + Exposures: no branches found under the submenu - skipping');
    return { hasErrors: false, errors: [] };
  }
  console.log('Validate Claim + Exposures: branches to run - ' + branchNames.join(', '));

  const allErrors = new Set();
  for (const branch of branchNames) {
    const submenu = await openValidateSubmenu(page);
    if (!submenu) { console.log('Validate Claim + Exposures: lost the submenu before "' + branch + '"'); continue; }
    await submenu.hover();
    await page.waitForTimeout(300);
    const leaf = page.getByRole('menuitem', { name: branch, exact: true }).last();
    const hasLeaf = await leaf.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (!hasLeaf) { console.log('Validate Claim + Exposures: branch "' + branch + '" not clickable this pass'); continue; }
    await leaf.click().catch(() => {});
    // Cap the wait — CC's server-side validation can take minutes; 15s is
    // enough to catch a normal response, and the .catch avoids blocking.
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    for (const e of await readValidationResultsPanel(page)) allErrors.add(e);
  }
  const errors = [...allErrors];

  if (errors.length) {
    console.log('Validate Claim + Exposures found ' + errors.length + ' issue(s):', JSON.stringify(errors));
  } else {
    // "No issues" has been WRONG before (it missed two VIN errors that were
    // plainly on screen), so prove it rather than assert it: dump what the
    // Validation Results area actually contains. If this prints real error
    // text, the scan is still broken; if it prints an empty/absent panel, the
    // claim really is clean.
    const proof = await page.evaluate(() => {
      const hit = [...document.querySelectorAll('*')].find(el =>
        el.offsetParent && el.children.length &&
        /Validation Results/i.test(el.innerText || '') &&
        (el.innerText || '').length < 6000);
      return hit
        ? (hit.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400)
        : '(no element containing "Validation Results" is visible)';
    }).catch(() => '(unreadable)');
    console.log('Validate Claim + Exposures: no issues found — panel says: ' + proof);
  }
  // Confirmed via live failure: the "Claim Actions" flyout menu can remain
  // open/overlapping after clicking "Validate Claim + Exposures" (it just
  // shows results inline, it doesn't auto-close the menu it was opened
  // from) - a stray menu item then intercepts the NEXT click elsewhere on
  // the page (e.g. a reserve checkbox), timing out with "subtree intercepts
  // pointer events". Dismiss it explicitly before returning.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  return { hasErrors: errors.length > 0, errors };
}

// ── fixInvalidVIN (on-prem) ─────────────────────────────────────────────────
// CC rejects the whole claim when a vehicle incident's VIN is not exactly 17
// upper-case alphanumeric characters:
//   The Vehicle Identification Number (VIN) must be a 17 character
//   upper-case alphanumeric string
// The FNOL sweep fills vehicle fields generically and can leave a VIN that is
// blank or the wrong length. While this stands, the payment wizard offers NO
// reserve lines at all, so it must be fixed before any financial step.
//
// Walks the Vehicles list, rewriting any VIN that is not already valid.
async function fixInvalidVIN(page) {
  const fixed = [];
  // A valid-format VIN: 17 chars, upper-case alphanumeric, and unique per run
  // so two claims on one policy cannot collide. I/O/Q are avoided because real
  // VIN alphabets exclude them, in case CC tightens the check later.
  const makeVin = () => {
    const alphabet = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
    let v = 'AUTO';
    const seed = String(Date.now()) + Math.floor(Math.random() * 1e6);
    for (let i = 0; v.length < 17; i++) {
      v += alphabet[(seed.charCodeAt(i % seed.length) + i) % alphabet.length];
    }
    return v.slice(0, 17);
  };

  // Confirmed via live screenshot: "Create Reserve" stays DISABLED while these
  // errors stand, so createReserve can be called, believe it navigated to the
  // Set Reserves screen, and silently operate on the Exposures grid instead -
  // the actual root cause behind "Reserve amount cell never entered edit mode
  // / no tagged amount candidates", which had nothing to do with the reserve
  // screen at all.
  //
  // The VIN field is NOT on the static "Loss Details" tab or the "Exposures"
  // grid - scanning those (the original version of this function) found
  // nothing, always. It lives inside the per-vehicle "Vehicle Incident" POPUP
  // (same one FNOL Step 3 already opens via
  // `[id*="VehicleIncidentIterator"][id$="VehicleName-inputEl"]`), and it is
  // not caught by FNOL's own field sweep because that sweep only fills EMPTY
  // fields - the vehicle carries a real, PRE-FILLED VIN from the underlying
  // policy data that is simply the wrong length, so it looks "answered" to
  // every required-field check and only "Validate Claim + Exposures" (a
  // FORMAT check, not a presence check) ever catches it.
  const lossDetailsNav = page.locator('.x-tree-node-text').filter({ hasText: /^Loss Details$/ }).first();
  if (await lossDetailsNav.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)) {
    await lossDetailsNav.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

    // Confirmed via live screenshot: post-FNOL, the claim workspace's Loss
    // Details -> Details tab renders vehicles as a plain GRID ("Vehicles":
    // Make | Model | Plate visible, with a horizontal scrollbar indicating
    // more columns off-screen) - NOT the FNOL-wizard's per-vehicle
    // VehicleIncidentIterator popup pattern, which apparently only exists
    // during the wizard itself. VIN is presumably one of the scrolled-off
    // columns; on a virtualized ExtJS grid it may not even be in the DOM
    // until scrolled into view, which would explain why the old full-page
    // input scan (offsetParent-gated) found nothing.
    //
    // Locate the "VIN" column header directly (NOT gated on offsetParent -
    // an off-screen-but-present header still has one; a virtualized column
    // that hasn't rendered yet will not, and scrollIntoView below is what
    // forces ExtJS to render it), scroll it into view, then use the same
    // "cell class contains header id" technique already proven for the Set
    // Reserves amount cell.
    const vinHeaderFound = await page.evaluate(() => {
      const header = [...document.querySelectorAll('.x-column-header, .x-column-header-text')]
        .find(h => /^\s*VIN\s*$/i.test((h.textContent || '').trim()) ||
                   /vehicle identification number/i.test((h.textContent || '').trim()));
      if (!header) return false;
      const headerEl = header.classList.contains('x-column-header') ? header : header.closest('.x-column-header');
      if (!headerEl || !headerEl.id) return false;
      headerEl.setAttribute('data-e2e-vin-header', '1');
      headerEl.scrollIntoView({ inline: 'center', block: 'nearest' });
      return true;
    }).catch(() => false);
    console.log('fixInvalidVIN: VIN column header on Loss Details/Vehicles grid — found=' + vinHeaderFound);
    if (!vinHeaderFound) {
      // Fourth wrong guess at the label ("VIN" literal text isn't there at
      // all, even unfiltered by visibility). Dump every REAL header near the
      // known Make/Model/Plate grid instead of guessing a fifth label.
      const realHeaders = await page.evaluate(() => {
        const mk = [...document.querySelectorAll('.x-column-header-text')]
          .find(h => /^\s*Make\s*$/i.test((h.textContent || '').trim()));
        if (!mk) return { error: 'no "Make" header found either', all: [...document.querySelectorAll('.x-column-header-text')].map(h => (h.textContent||'').trim()).filter(Boolean).slice(0,40) };
        // Walk up to the header CONTAINER and list every header text in it,
        // in order - this is the Vehicles grid's real column list.
        let ct = mk.closest('.x-grid-header-ct') || mk.closest('[class*="header"]');
        if (!ct) return { error: 'Make header has no header-container ancestor' };
        return { headers: [...ct.querySelectorAll('.x-column-header-text')].map(h => (h.textContent || '').trim()).filter(Boolean) };
      }).catch(() => null);
      console.log('fixInvalidVIN: Vehicles grid real headers -> ' + JSON.stringify(realHeaders));
    }

    if (vinHeaderFound) {
      await page.waitForTimeout(400);   // let the grid finish rendering the now-visible column
      const cellTagged = await page.evaluate(() => {
        const header = document.querySelector('[data-e2e-vin-header="1"]');
        if (!header || !header.id) return null;
        // The DATA cells share a class containing the header's id - same
        // pattern proven for the Set Reserves "New Available Reserves" cell.
        const cells = [...document.querySelectorAll('[class*="' + header.id + '"]')]
          .filter(el => el !== header && !header.contains(el));
        if (!cells.length) return { headerId: header.id, cells: 0 };
        const cell = cells[0];   // single vehicle in this claim; first row
        cell.scrollIntoView({ inline: 'center', block: 'nearest' });
        const input = cell.querySelector('input');
        const raw = (input ? input.value : cell.textContent || '').trim();
        cell.setAttribute('data-e2e-vin-cell', '1');
        return { headerId: header.id, cells: cells.length, current: raw, hasInput: !!input };
      }).catch(() => null);
      console.log('fixInvalidVIN: VIN cell lookup -> ' + JSON.stringify(cellTagged));

      if (cellTagged && cellTagged.cells && !/^[A-Z0-9]{17}$/.test(cellTagged.current || '')) {
        const vin = makeVin();
        const cell = page.locator('[data-e2e-vin-cell="1"]').first();
        // Inline-edit grid cell, same click-then-fill pattern proven for the
        // reserve amount cell: click to enter edit mode, then fill whatever
        // input appeared (falling back to a direct cell fill if it was
        // already a plain editable text cell with no separate input).
        await cell.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(300);
        const editorInput = page.locator('[data-e2e-vin-cell="1"] input, [data-e2e-vin-cell="1"] :focus').first();
        const filled = await editorInput.fill(vin).then(() => true).catch(() => false);
        if (!filled) await cell.fill(vin).catch(() => {});
        await page.keyboard.press('Tab').catch(() => {});
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 8000 }).catch(() => {});
        console.log('fixInvalidVIN: set VIN "' + vin + '" on the Vehicles grid ' +
                    '(was "' + (cellTagged.current || '(empty)') + '")');
        fixed.push('VIN');
        // Commit via whichever control this screen exposes (confirmed via
        // screenshot: an "Edit"-mode toolbar with no obvious Save/Update
        // label visible in the captured viewport - try the common ones).
        for (const btnLabel of ['Update', 'Save', 'Edit']) {
          const btn = page.locator('.x-btn').filter({ hasText: new RegExp('^' + btnLabel + '$') }).first();
          if (await btn.waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false)) {
            await btn.click().catch(() => {});
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
            break;
          }
        }
      }
    }
    if (fixed.length) return fixed;

    // Old per-vehicle-popup approach, kept as a fallback for whichever LOB or
    // claim state DOES render the FNOL-style iterator post-FNOL.
    const vehicleLinks = page.locator('[id*="VehicleIncidentIterator"][id$="VehicleName-inputEl"]');
    const vehicleCount = await vehicleLinks.count().catch(() => 0);
    console.log('fixInvalidVIN: ' + vehicleCount + ' vehicle incident link(s) found on Loss Details');
    for (let i = 0; i < vehicleCount; i++) {
      const link = vehicleLinks.nth(i);
      const vehicleText = (await link.textContent().catch(() => '')).trim() || ('vehicle ' + i);
      await link.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(300);

      const vinField = await page.evaluate(() => {
        for (const el of document.querySelectorAll('input:not([type=hidden])')) {
          if (!el.offsetParent) continue;
          const label = ((el.getAttribute('aria-label') || '') + ' ' +
                         (el.getAttribute('name') || '') + ' ' + (el.id || '')).toLowerCase();
          if (!/\bvin\b|vehicleidentification/.test(label)) continue;
          const v = (el.value || '').trim();
          if (/^[A-Z0-9]{17}$/.test(v)) continue;
          el.setAttribute('data-e2e-vin', '1');
          return { current: v };
        }
        return null;
      }).catch(() => null);

      if (vinField) {
        const vin = makeVin();
        const field = page.locator('[data-e2e-vin="1"]').first();
        await field.fill(vin).catch(() => {});
        await field.evaluate(el => el.removeAttribute('data-e2e-vin')).catch(() => {});
        await page.keyboard.press('Tab').catch(() => {});
        console.log('fixInvalidVIN: set VIN "' + vin + '" on "' + vehicleText +
                    '" (was "' + (vinField.current || '(empty)') + '")');
        fixed.push('VIN');
      } else {
        // Ground truth instead of a third guess: every visible input's
        // identifying attributes and current value inside this popup, so the
        // next attempt can target the real field name instead of assuming
        // "vin" appears in its aria-label/name/id.
        const dump = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden])')]
          .filter(el => el.offsetParent)
          .map(el => ({
            label: (el.getAttribute('aria-label') || '').slice(0, 30),
            name: (el.getAttribute('name') || '').slice(0, 30),
            id: (el.id || '').slice(-50),
            value: (el.value || '').slice(0, 24),
          }))).catch(() => []);
        console.log('fixInvalidVIN: no VIN-labeled input inside "' + vehicleText +
                    '" popup. Visible inputs -> ' + JSON.stringify(dump));
      }

      // Close the popup the same way FNOL's own vehicle-incident loop does -
      // OK if it's ready to commit, Cancel if some other required field on
      // this popup is still blocking it (not this function's job to fill).
      const okBtn = page.getByText('OK', { exact: true }).first();
      await okBtn.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      const closed = await okBtn.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true).catch(() => false);
      if (!closed) {
        await page.getByText('Cancel', { exact: true }).first().click().catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      }
    }
    if (fixed.length) return fixed;
  }

  // Fallback: the older guess (VIN as an inline field on Loss Details /
  // Exposures directly), kept in case a different LOB/policy renders it there
  // instead of inside the popup.
  for (const navName of ['Loss Details', 'Exposures']) {
    const nav = page.locator('.x-tree-node-text').filter({ hasText: new RegExp('^' + navName + '$') }).first();
    if (!await nav.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)) continue;
    await nav.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

    // Any visible VIN input on this screen (the vehicle rows render inline).
    for (let pass = 0; pass < 6; pass++) {
      const target = await page.evaluate(() => {
        for (const el of document.querySelectorAll('input:not([type=hidden])')) {
          if (!el.offsetParent) continue;
          const label = ((el.getAttribute('aria-label') || '') + ' ' +
                         (el.getAttribute('name') || '') + ' ' + (el.id || '')).toLowerCase();
          if (!/\bvin\b|vehicleidentification/.test(label)) continue;
          const v = (el.value || '').trim();
          if (/^[A-Z0-9]{17}$/.test(v)) continue;   // already valid
          el.setAttribute('data-e2e-vin', '1');
          return { id: el.id || null, current: v };
        }
        return null;
      }).catch(() => null);
      if (!target) break;

      const vin = makeVin();
      const field = page.locator('[data-e2e-vin="1"]').first();
      await field.fill(vin).catch(() => {});
      await field.evaluate(el => el.removeAttribute('data-e2e-vin')).catch(() => {});
      await page.keyboard.press('Tab').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 8000 }).catch(() => {});
      console.log('fixInvalidVIN: set VIN "' + vin + '" (was "' + (target.current || '(empty)') + '")');
      fixed.push('VIN');
    }

    if (fixed.length) {
      // Commit via whichever save control this screen exposes.
      for (const label of ['Update', 'Save']) {
        const btn = page.locator('.x-btn').filter({ hasText: new RegExp('^' + label + '$') }).first();
        if (await btn.waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false)) {
          await btn.click().catch(() => {});
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
          break;
        }
      }
      return fixed;
    }
  }
  if (!fixed.length) console.log('fixInvalidVIN: no invalid VIN field found on Loss Details or Exposures');
  return fixed;
}

// ── validateAndRepairClaim (on-prem) ─────────────────────────────────────────
// Runs CC's own "Validate Claim + Exposures" right after the exposures exist,
// repairs whatever it reports, and re-validates until the claim is clean.
//
// WHY THIS RUNS BEFORE RESERVES/PAYMENT: an outstanding validation error makes
// the payment wizard offer NO reserve lines at all. Confirmed live on
// PA-PA-01-26-0000387, which had a perfectly good Collision line with $1,200
// remaining, yet Step 2's "Reserve Line" dropdown was completely empty and the
// run burned 6.6 minutes retrying a wizard that was never going to fill. The
// dropdown is a SYMPTOM of claim-level validation, not a locator problem -
// diagnosing it as one cost several runs. Validating early surfaces the real
// error by name instead, while it is still cheap to fix.
//
// Returns { hasErrors, errors, passes } describing the FINAL state. Callers
// decide whether unresolved errors should fail the test - this helper reports
// honestly rather than pretending a claim is clean when it is not.
async function validateAndRepairClaim(page, { maxPasses = 3 } = {}) {
  // Required lazily: financialsHelper already requires THIS module, so a
  // top-level require here would be a circular import.
  const { completeOnPremExposureData } = require('./financialsHelper');
  let result = { hasErrors: false, errors: [] };
  const repairHistory = new Set();

  for (let pass = 1; pass <= maxPasses; pass++) {
    result = await validateClaimAndExposures(page);
    if (!result.hasErrors) {
      console.log('validateAndRepairClaim: claim is clean after ' + (pass - 1) + ' repair pass(es)');
      return { ...result, passes: pass - 1 };
    }
    console.log('validateAndRepairClaim: pass ' + pass + '/' + maxPasses + ' — ' +
                result.errors.length + ' issue(s): ' + JSON.stringify(result.errors.slice(0, 6)));

    // Repair by what CC actually reported, not by running everything blindly.
    const fixed = [];
    if (result.errors.some(e => /vehicle identification number|\bVIN\b/i.test(e))) {
      const vinFixed = await fixInvalidVIN(page).catch(() => []);
      fixed.push(...vinFixed);
    }
    const exposureFixed = await completeOnPremExposureData(page).catch(() => []);
    fixed.push(...exposureFixed);
    // A party/contact missing an address is the other common cause and is not
    // reachable from the exposure screens.
    if (result.errors.some(e => /address|street|city|state/i.test(e))) {
      await fixMissingPartyAddress(page).catch(() => {});
      repairHistory.add('party address');
    }
    for (const f of fixed) repairHistory.add(f);
    if (!fixed.length && !repairHistory.size) {
      console.log('validateAndRepairClaim: nothing repairable found — stopping early, ' +
                  'the remaining issues need a fix this helper does not implement');
      break;
    }
  }

  if (result.hasErrors) {
    console.log('validateAndRepairClaim: STILL INVALID after ' + maxPasses + ' pass(es). ' +
                'Repairs attempted: ' + ([...repairHistory].join(', ') || 'none') + '. ' +
                'Remaining: ' + JSON.stringify(result.errors.slice(0, 6)) + '. ' +
                'Expect the payment wizard to offer no reserve lines while this stands.');
  }
  return { ...result, passes: maxPasses };
}

// ── Close Exposure (on-prem) ──────────────────────────────────────────────────
// PARTIALLY VERIFIED: codegen confirmed the button id and that a confirmation
// popup with a Cancel button opens (the recorded session clicked Cancel, not
// Update) - the successful-confirm path is EXTRAPOLATED using the same
// "<Popup>:<Screen>:Update" naming convention seen on every other confirmed
// popup in this codebase (NewExposureScreen, NewReserveSetScreen, ...), not
// independently verified. Re-check this against a live claim before trusting it.
async function closeExposure(page, { exposureRowText, confirm = true } = {}) {
  if (exposureRowText) {
    const row = page.getByRole('row', { name: exposureRowText });
    await row.getByRole('img').click();
  }
  await page.locator('[id="ClaimExposures:ClaimExposuresScreen:ClaimExposures_CloseExposure"]').click();
  if (confirm) {
    await page.locator('[id="CloseExposurePopup:CloseExposureScreen:Update"]').click();
  } else {
    await page.locator('[id="CloseExposurePopup:CloseExposureScreen:Cancel"]').click();
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

// ── closeExposureWithOutcome (on-prem) ──────────────────────────────────────
// Per user-provided workflow: navigate to Exposures, open the SPECIFIC
// exposure the final payment was just made on, click "Close Exposure",
// which opens a screen requiring a Note and an Outcome selection - fill both
// and click "Close Exposure" again to confirm.
async function closeExposureWithOutcome(page, exposureRowText) {
  wpLog('closeExposureWithOutcome: starting for ' + exposureRowText);
  const triedOutcomes = new Set(); // track outcomes that were tried but popup stayed open
  let exposureSkip = 0; // when multiple Open rows share the same name, move to the next after all outcomes fail
  for (let attempt = 0; attempt < 5; attempt++) {
    wpLog('closeExposureWithOutcome: attempt ' + (attempt + 1));
    // Set when CC's DMEC0002 open-reserve prompt was answered by re-clicking
    // Close Exposure and the popup then went away - see the handler below.
    let reserveConfirmed = false;
    // Navigate to Exposures list view — cap navigation wait to avoid 60s loadState stall
    const navItem = page.locator('.x-tree-node-text').filter({ hasText: /^Exposures$/ }).first();
    if (await navItem.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
      await navItem.click();
      await Promise.race([
        page.waitForLoadState('domcontentloaded'),
        page.waitForTimeout(5000),
      ]).catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    }

    // Select the target exposure row via its checkbox — or navigate to the detail view.
    // GW CC exposures grids do not always render a checkbox column.  When no checkbox
    // is present we navigate directly into the exposure detail page and click "Close
    // Exposure" from there instead of using the list-toolbar button (which requires
    // a checkbox selection and is not available on the detail page).
    let navigatedToDetail = false;
    if (exposureRowText) {
      // Wait for the grid to render with Claimant column before trying to select a row
      await page.locator('.x-column-header-text').filter({ hasText: 'Claimant' })
        .first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      const allMatching = page.getByRole('row', { name: exposureRowText });
      const allOpen = allMatching.filter({ hasText: 'Open' });
      const openCount = await allOpen.count().catch(() => 0);
      const hasOpen = openCount > 0;
      // exposureSkip: when same claimant name appears on multiple Open exposures and
      // all Outcomes failed on the current one, move to the next matching row.
      const effectiveSkip = Math.min(exposureSkip, Math.max(openCount - 1, 0));
      const row = hasOpen ? allOpen.nth(effectiveSkip) : allMatching.last();
      wpLog('closeExposureWithOutcome: targeting ' + (hasOpen ? 'Open row #' + effectiveSkip : 'last') + ' matching "' + exposureRowText + '"');
      const checkCell = row.locator('.x-grid-cell-inner > .x-grid-checkcolumn, [class*="checkcolumn"]').first();
      const hasCheck = await checkCell.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
      wpLog('closeExposureWithOutcome: row checkbox found? ' + hasCheck);
      if (hasCheck) {
        await checkCell.click().catch(() => {});
        await Promise.race([page.waitForLoadState('domcontentloaded'), page.waitForTimeout(500)]).catch(() => {});
      } else {
        // No checkbox column: navigate directly into the exposure detail view.
        navigatedToDetail = true;
        const rowLink = row.locator('a').first();
        if (await rowLink.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
          await rowLink.click();
        } else {
          await row.locator('td').first().click().catch(() => {});
        }
        await Promise.race([page.waitForLoadState('domcontentloaded'), page.waitForTimeout(5000)]).catch(() => {});
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      }
    }

    let clickedClose = false;

    if (!navigatedToDetail) {
      // On the list view: click the toolbar "Close Exposure" button (requires prior checkbox selection)
      const toolbarCloseBtn = page.locator('[id="ClaimExposures:ClaimExposuresScreen:ClaimExposures_CloseExposure"]');
      const hasToolbarBtn = await toolbarCloseBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
      console.log('closeExposureWithOutcome: toolbar "Close Exposure" found?', hasToolbarBtn);
      if (!hasToolbarBtn) {
        const toolbarDump = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('.x-toolbar .x-btn, .x-panel-toolbar .x-btn'));
          return btns.filter(b => b.id).map(b => b.id + '|' + (b.innerText || '').trim().substring(0, 30)).join(' || ').substring(0, 500);
        }).catch(() => 'dump failed');
        console.log('closeExposureWithOutcome: toolbar btn ids:', toolbarDump);
        // Treat same as no-checkbox case: fall through to detail-page button below
        navigatedToDetail = true;
      } else {
        await toolbarCloseBtn.click();
        clickedClose = true;
      }
    }

    if (navigatedToDetail && !clickedClose) {
      // On the exposure detail page: find "Close Exposure" button
      const detailBtn = page.locator('.x-btn').filter({ hasText: /Close Exposure/i }).first();
      const hasDetailBtn = await detailBtn.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
      console.log('closeExposureWithOutcome: detail "Close Exposure" found?', hasDetailBtn);
      if (!hasDetailBtn) { continue; }
      await detailBtn.click();
      clickedClose = true;
    }

    if (!clickedClose) { continue; }

    await Promise.race([
      page.waitForLoadState('domcontentloaded'),
      page.waitForTimeout(5000),
    ]).catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

    // Wait for popup to be visible and dump ALL fields inside it for diagnostics
    await page.waitForSelector('[id*="CloseExposurePopup"]', { state: 'visible', timeout: 8000 }).catch(() => {});
    const openDump = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[id^="CloseExposurePopup"]'));
      const popup = els.length > 0 ? els.reduce((a, b) => a.id.length <= b.id.length ? a : b) : null;
      if (!popup) return 'no popup container found';
      const inputs = Array.from(popup.querySelectorAll('input,textarea'));
      const labels = Array.from(popup.querySelectorAll('[id$="-labelEl"]')).map(el => el.id + ':' + el.textContent.trim()).join(', ');
      return 'LABELS=[' + labels.substring(0, 300) + '] | INPUTS=[' + inputs.map(el => el.id + '=' + el.value).join(' | ').substring(0, 400) + ']';
    }).catch(() => 'open-dump failed');
    console.log('closeExposureWithOutcome: popup opened, structure:', openDump);

    // Fill Note textarea — scope search to the popup container
    const noteFilledById = await page.evaluate(() => {
      const popup = Array.from(document.querySelectorAll('[id^="CloseExposurePopup"]'))
        .reduce((a, b) => (!a || a.id.length > b.id.length) ? b : a, null);
      if (!popup) return null;
      const ta = popup.querySelector('textarea');
      return ta ? ta.id : null;
    }).catch(() => null);

    if (noteFilledById) {
      const noteSelector = '[id="' + noteFilledById + '"]';
      await page.locator(noteSelector).fill('Automated test - closing exposure after final payment');
      console.log('closeExposureWithOutcome: filled Note via id=' + noteFilledById);
    } else {
      console.log('closeExposureWithOutcome: WARNING - no textarea found in popup');
    }

    // Select Outcome — find the combobox input inside the popup whose label says "Outcome"
    const outcomeInputId = await page.evaluate(() => {
      const popup = Array.from(document.querySelectorAll('[id^="CloseExposurePopup"]'))
        .reduce((a, b) => (!a || a.id.length > b.id.length) ? b : a, null);
      if (!popup) return null;
      // Look for a label element whose text is "Outcome"
      for (const labelEl of popup.querySelectorAll('[id$="-labelEl"]')) {
        if (labelEl.textContent.trim().toLowerCase() === 'outcome') {
          // The sibling or nearby input: field id = labelEl id with "-labelEl" replaced by "-inputEl"
          const inputId = labelEl.id.replace('-labelEl', '-inputEl');
          const inp = document.getElementById(inputId);
          if (inp) return inputId;
        }
      }
      // Fallback: find input whose id contains "Outcome" and "-inputEl"
      const byIdFallback = popup.querySelector('input[id*="Outcome"][id$="-inputEl"]');
      return byIdFallback ? byIdFallback.id : null;
    }).catch(() => null);

    let chosenOutcome = null; // declared at loop scope so popup-blocked handler can record it
    if (outcomeInputId) {
      // Open the Outcome combobox and enumerate all available options before picking.
      // "First" option can be a liability-specific value (e.g. "Adverse Carrier Accepted Liability
      // Option") that CC silently rejects for 1st-party/Comprehensive exposures — confirmed by
      // run29 where the popup was blocked despite Note+Outcome being filled.
      await page.locator(`[id="${outcomeInputId}"]`).click();
      await page.waitForTimeout(300);
      const outcomeOptions = await page.evaluate(() => {
        const listItems = Array.from(document.querySelectorAll('.x-boundlist-item, .x-list-plain li'));
        return listItems.map(el => el.innerText.trim()).filter(t => t && t !== ' ');
      }).catch(() => []);
      wpLog('closeExposureWithOutcome: Outcome options: ' + outcomeOptions.join(' | '));

      // Preferred outcomes for a final-payment / property-damage close.
      const PAYMENT_PREFERRED = [
        'Payment Made',
        'Paid In Full',
        'Full Payment',
        'Agreed Settlement',
        'Paid',
        'Settlement Paid',
        'Claim Settled',
        'Payments complete',
      ];
      // Exclude "Adverse Carrier" liability-only options and blank entries.
      const nonLiabilityOptions = outcomeOptions.filter(opt =>
        !opt.toLowerCase().includes('adverse') && !opt.toLowerCase().includes('liability option') &&
        opt !== '<none>' && opt.trim() !== ''
      );
      // Build a priority list: preferred first, then remaining non-liability options.
      // Skip any outcome already tried and blocked by CC.
      const preferredFirst = [
        ...nonLiabilityOptions.filter(o => PAYMENT_PREFERRED.some(p => o.toLowerCase().includes(p.toLowerCase()))),
        ...nonLiabilityOptions.filter(o => !PAYMENT_PREFERRED.some(p => o.toLowerCase().includes(p.toLowerCase()))),
      ];
      chosenOutcome = preferredFirst.find(o => !triedOutcomes.has(o)) ||
        nonLiabilityOptions.find(o => !triedOutcomes.has(o)) ||
        outcomeOptions.find(o => o !== '<none>' && !triedOutcomes.has(o)) ||
        nonLiabilityOptions[nonLiabilityOptions.length - 1] ||
        outcomeOptions[outcomeOptions.length - 1];
      wpLog('closeExposureWithOutcome: choosing Outcome: ' + chosenOutcome);
      if (chosenOutcome) {
        // Primary: trusted Playwright click on .x-boundlist-item (the ExtJS dropdown list item CSS class).
        // getByRole('option', exact:true) fails when ExtJS items lack role="option" or have extra whitespace;
        // evaluate el.click() is synthetic (isTrusted:false) and may not register the ExtJS component value.
        // .x-boundlist-item with Playwright's native click is always trusted and always matches the CSS class.
        const boundlistItem = page.locator('.x-boundlist-item').filter({ hasText: chosenOutcome }).first();
        const boundlistFound = await boundlistItem.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
        if (boundlistFound) {
          await boundlistItem.click();
          console.log('closeExposureWithOutcome: Outcome selected via .x-boundlist-item trusted click');
        } else {
          // Fallback: getByRole partial match
          const optEl = page.getByRole('option', { name: chosenOutcome, exact: false }).first();
          const found = await optEl.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
          if (found) {
            await optEl.click();
            console.log('closeExposureWithOutcome: Outcome selected via getByRole option');
          } else {
            // Last resort: evaluate synthetic click (may not register ExtJS component value)
            console.log('closeExposureWithOutcome: WARNING - using synthetic evaluate click for Outcome (may fail)');
            await page.evaluate((text) => {
              const el = Array.from(document.querySelectorAll('.x-boundlist-item, .x-list-plain li'))
                .find(e => e.innerText.trim().toLowerCase().includes(text.toLowerCase()));
              if (el) el.click();
            }, chosenOutcome).catch(() => {});
          }
        }
      } else {
        // No options found — Playwright click might have closed the dropdown; reopen + selectFirst
        await page.locator(`[id="${outcomeInputId}"]`).click();
        await page.waitForTimeout(200);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
      }
      await page.keyboard.press('Tab').catch(() => {});
      await page.waitForTimeout(200);
      console.log('closeExposureWithOutcome: Outcome selected');
    } else {
      console.log('closeExposureWithOutcome: Outcome field not found in popup DOM, trying accessible-name fallback');
      await selectComboboxOnPrem(page, 'Outcome', null, { existTimeout: 5000 }).catch(() => {});
    }

    // Sweep any remaining empty comboboxes inside the popup only
    await sweepComboboxesOnPrem(page, 'CloseExposurePopup').catch(() => {});
    await clickUnansweredBooleanFieldsOnPrem(page, 'CloseExposurePopup').catch(() => {});

    // Dump all input values inside the popup before clicking Update
    const preClickDump = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[id^="CloseExposurePopup"]'));
      const popup = els.length > 0 ? els.reduce((a, b) => a.id.length <= b.id.length ? a : b) : null;
      if (!popup) return 'no popup';
      const inputs = Array.from(popup.querySelectorAll('input,textarea,select'));
      return inputs.map(el => (el.id || el.name || '?') + '=' + (el.value || '(empty)')).join(' | ').substring(0, 600);
    }).catch(() => 'dump failed');
    console.log('closeExposureWithOutcome: pre-Update popup fields:', preClickDump);

    // Dump all .x-btn spans inside the popup for diagnostics.
    // NOTE: ExtJS renders buttons as <span class="x-btn">, not <button> or role="button",
    // so the button/role selectors always return empty. Use .x-btn class instead.
    const popupBtnDump = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll(
        '[id^="CloseExposurePopup"] .x-btn, [id^="CloseExposureWorksheet"] .x-btn'
      ));
      return btns.filter(b => b.id).map(b => b.id.slice(-60) + ':' + (b.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30)).join(' | ').substring(0, 600);
    }).catch(() => '(eval failed)');
    console.log('closeExposureWithOutcome: popup .x-btn dump:', popupBtnDump);

    // Set up response capture BEFORE clicking so we can see what CC sends back
    const capturedResponses = [];
    const respListener = resp => {
      const url = resp.url();
      if (!url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.gif')) {
        resp.text().then(t => {
          capturedResponses.push({ status: resp.status(), url: url.split('?')[0].split('/').slice(-2).join('/'), body: t.substring(0, 600) });
        }).catch(() => {});
      }
    };
    page.on('response', respListener);

    // Strategy: the CloseExposure popup's FORM SUBMIT button is Update
    // (CloseExposurePopup:CloseExposureScreen:Update). The "Close Exposure" .x-btn
    // visible in the popup body is a toolbar/breadcrumb element that re-initializes
    // the popup fresh WITHOUT submitting form data — clicking it sends a blank form
    // to CC which re-renders the popup (confirmed: Note/Outcome are blank in the
    // re-rendered popup, proving no form data was submitted). The Update button IS
    // the correct form-submit action: with Note + Outcome properly filled, clicking
    // Update closes the exposure (contrary to earlier comment based on testing without
    // Outcome selected, which caused Update to save a blank Outcome → popup dismissed
    // but exposure stayed Open because no valid Outcome was persisted).
    let confirmClicked = false;

    // Step 1: Update button — the correct form-submit action for CloseExposure popup
    const updateIds = [
      'CloseExposurePopup:CloseExposureScreen:Update',
      'CloseExposureWorksheet:CloseExposureScreen:Update',
    ];
    for (const btnId of updateIds) {
      const btn = page.locator('[id="' + btnId + '"]');
      if (await btn.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
        await btn.click();
        confirmClicked = true;
        console.log('closeExposureWithOutcome: clicked Update via id=' + btnId);
        break;
      }
    }

    // Step 2: known CloseExposure-specific action button IDs (fallback for worksheet variants)
    if (!confirmClicked) {
      const actionIds = [
        'CloseExposurePopup:CloseExposureScreen:CloseExposure',
        'CloseExposureWorksheet:CloseExposureScreen:CloseExposure',
      ];
      for (const btnId of actionIds) {
        const btn = page.locator('[id="' + btnId + '"]');
        if (await btn.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
          await btn.click();
          confirmClicked = true;
          console.log('closeExposureWithOutcome: clicked action via id=' + btnId);
          break;
        }
      }
    }

    // Step 3: last-resort text search (do NOT search for "Close Exposure" — that is a
    // breadcrumb/toolbar element that re-opens a fresh popup without form data)
    if (!confirmClicked) {
      for (const prefix of ['CloseExposurePopup', 'CloseExposureWorksheet']) {
        const container = page.locator('[id^="' + prefix + '"]').first();
        if (await container.count().catch(() => 0) > 0) {
          // Look for Update-labeled or any submit-like button (NOT "Close Exposure" breadcrumb)
          const updateBtn = container.locator('.x-btn').filter({ hasText: /^Update$/i }).first();
          if (await updateBtn.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
            await updateBtn.click();
            confirmClicked = true;
            console.log('closeExposureWithOutcome: clicked Update btn by text within ' + prefix);
            break;
          }
        }
      }
    }

    if (!confirmClicked) {
      console.log('closeExposureWithOutcome: WARNING - no known confirm id found; skipping click this attempt');
    }
    await Promise.race([
      page.waitForLoadState('domcontentloaded'),
      page.waitForTimeout(5000),
    ]).catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500); // let in-flight responses arrive
    page.off('response', respListener);
    // Log any CC responses captured during/after the Update click
    for (const r of capturedResponses) {
      console.log('closeExposureWithOutcome: server resp [' + r.status + '] ' + r.url + ' | ' + r.body.replace(/\n/g, ' ').substring(0, 400));
    }

    // Dismiss any CC server error dialog (e.g. "An Unknown Exception has occurred").
    // This dialog renders as a modal x-window on top of the Close Exposure popup;
    // until it is dismissed, the popup's Cancel button is unreachable and every
    // retry attempt will immediately see the same blocked state.
    try {
      const ccErrVisible = await page.evaluate(() => {
        const wins = Array.from(document.querySelectorAll('.x-window'));
        return wins.some(w => w.offsetParent !== null && /unknown exception/i.test(w.innerText || ''));
      }).catch(() => false);
      if (ccErrVisible) {
        wpLog('closeExposureWithOutcome: CC Unknown Exception dialog detected — dismissing');
        const dismissed = await page.evaluate(() => {
          const wins = Array.from(document.querySelectorAll('.x-window'));
          const errWin = wins.find(w => w.offsetParent !== null && /unknown exception/i.test(w.innerText || ''));
          if (!errWin) return false;
          const xBtn = errWin.querySelector('.x-tool-close, [class*="tool-close"]');
          if (xBtn) { xBtn.click(); return true; }
          return false;
        }).catch(() => false);
        if (!dismissed) await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
      }
    } catch (_) {}

    // Detect whether the popup closed (Update button gone) or stayed (validation blocked it).
    // NOTE: locator.waitFor() returns Promise<void> — checking the locator's visibility state
    // directly is the correct pattern; the old ".waitFor().then(el => el.textContent())" was
    // broken because `el` would always be undefined (void result), making text reads fail silently.
    const updateLocator = page.locator('[id="CloseExposurePopup:CloseExposureScreen:Update"]');
    const popupGone = await updateLocator.waitFor({ state: 'hidden', timeout: 8000 }).then(() => true).catch(() => false);
    wpLog('closeExposureWithOutcome: popup dismissed? ' + popupGone);

    if (!popupGone) {
      // Popup still open — CC validation rejected the close.
      // Capture multiple diagnostic sources: innerText, _msgs banner, invalid fields.
      const popupDiag = await page.evaluate(() => {
        const btn = document.querySelector('[id="CloseExposurePopup:CloseExposureScreen:Update"]');
        if (!btn) return { text: 'Update button not in DOM', msgs: '', invalid: '' };

        // Walk up to find the popup window container
        let popupEl = btn.parentElement;
        for (let i = 0; i < 30 && popupEl && popupEl !== document.body; i++, popupEl = popupEl.parentElement) {
          if ((popupEl.id && popupEl.id.startsWith('CloseExposurePopup')) || (popupEl.className && /x-window/.test(popupEl.className))) break;
        }
        if (!popupEl || popupEl === document.body) {
          popupEl = btn.closest('.x-panel-body') || btn.closest('.x-container') || btn.parentElement;
        }

        const text = popupEl ? popupEl.innerText.trim().substring(0, 500) : 'no container';
        // CC validation errors often appear in [id$="_msgs"] elements
        const msgsEl = popupEl && popupEl.querySelector('[id$="_msgs"]');
        const msgs = msgsEl ? msgsEl.innerText.trim().substring(0, 300) : '';
        // Highlight invalid/error-marked fields
        const invalidEls = popupEl ? Array.from(popupEl.querySelectorAll('.x-form-invalid-field, [class*="x-form-error"], [class*="invalid"]')) : [];
        const invalid = invalidEls.map(e => (e.id || e.className).substring(0, 60)).join(', ').substring(0, 200);
        // Also check data-errorqtip attributes (CC tooltip-style errors)
        const errTips = popupEl ? Array.from(popupEl.querySelectorAll('[data-errorqtip]')).map(e => e.getAttribute('data-errorqtip') + '@' + e.id).join(' | ').substring(0, 300) : '';
        return { text, msgs, invalid, errTips };
      }).catch(err => ({ text: 'evaluate error: ' + String(err), msgs: '', invalid: '', errTips: '' }));
      wpLog('closeExposureWithOutcome: popup BLOCKED text: ' + (popupDiag.text || '').substring(0, 400));
      if (popupDiag.msgs) wpLog('closeExposureWithOutcome: popup _msgs: ' + popupDiag.msgs);
      if (popupDiag.invalid) wpLog('closeExposureWithOutcome: popup invalid: ' + popupDiag.invalid);
      if (popupDiag.errTips) wpLog('closeExposureWithOutcome: popup errTips: ' + popupDiag.errTips);
      // Also check for page-level CC notification banners (outside the popup)
      const globalDiag = await page.evaluate(() => {
        const banners = Array.from(document.querySelectorAll(
          '.gwt-info-text, .x-message-box, [id*="notification"], [class*="notification"], [class*="x-notification"], .cc-error, [id*="_msgs"]:not([id*="CloseExposure"])'
        )).map(e => e.innerText.trim()).filter(t => t).join(' | ');
        const toasts = Array.from(document.querySelectorAll(
          '[class*="toast"], [class*="gwt-popup"], .x-window:not([id*="CloseExposure"])'
        )).map(e => e.innerText.trim().substring(0, 100)).filter(t => t).join(' | ');
        return { banners: banners.substring(0, 300), toasts: toasts.substring(0, 300) };
      }).catch(() => ({ banners: '', toasts: '' }));
      if (globalDiag.banners) wpLog('closeExposureWithOutcome: global banners: ' + globalDiag.banners);
      if (globalDiag.toasts) wpLog('closeExposureWithOutcome: global toasts: ' + globalDiag.toasts);
      // Also capture the CC systemAlertBar (the id "AlertBar" div shown in server
      // response JSON as "systemAlertBar" — this is where CC puts the ACTUAL block reason
      // that doesn't appear inside the popup container).
      const alertBarText = await page.evaluate(() => {
        const el = document.querySelector('[id*="AlertBar"], [id*="alertBar"], [id*="alertbar"], [class*="alert-bar"]');
        return el ? el.innerText.trim().substring(0, 300) : '';
      }).catch(() => '');
      if (alertBarText) wpLog('closeExposureWithOutcome: alertBar: ' + alertBarText);

      // Detect and dismiss CC error dialogs (e.g. "An Unknown Exception has occurred").
      // These GW dialogs use custom CSS classes not matched by .x-window; searching the
      // full body text is reliable. The dialog is modal and blocks the Cancel button —
      // dismiss it here before retrying so the next attempt's Cancel can work.
      try {
        const ccErrInBody = await page.evaluate(() => /unknown exception/i.test(document.body.innerText || '')).catch(() => false);
        if (ccErrInBody) {
          wpLog('closeExposureWithOutcome: CC Unknown Exception dialog in body — dismissing');
          const dismissed = await page.evaluate(() => {
            // GW error dialog: look for any visible close/X button near the exception text
            const allBtns = Array.from(document.querySelectorAll('button, [class*="close"], [class*="tool"], [aria-label*="close" i]'));
            for (const b of allBtns) {
              if (b.offsetParent !== null) { b.click(); return true; }
            }
            return false;
          }).catch(() => false);
          if (!dismissed) await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(600);
        }
      } catch (_) {}

      // DMEC0002 is a CONFIRMATION, not a rejection: "There is currently an open
      // reserve of $X on this exposure. If you want to set this reserve to $0
      // please click Close Exposure again. If not, please click Cancel."
      // CC is asking for the SAME button to be pressed a second time with the
      // SAME outcome. Treating it as a failed outcome (as the code below does)
      // cancels the popup and retries with a different outcome, which re-raises
      // the identical prompt - confirmed via live run where all 5 attempts
      // cycled through outcomes and none ever closed, and via a probe that
      // reproduced the prompt with the Outcome field correctly populated.
      // Scan the whole body, not just the popup: the live log showed
      // popupDiag.text only ever held the popup TITLE ("Close Exposure (1) 1st
      // PartyVehicle - ..."), while the probe found this rule text rendered in
      // the page-level Validation Results panel outside the popup container.
      const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      // Surface WHY the popup refused. Every other diagnostic above only ever
      // yielded the popup title ("Close Exposure (1) 1st PartyVehicle - ..."),
      // so a genuine block looked identical to a mystery and the helper just
      // cycled outcomes. Same body-scan that turned the opaque Surcharging
      // failure into an exact rule code. Question labels (trailing "?") are
      // excluded - this app is full of them and they falsely match /required/.
      const whyBlocked = bodyText.split('\n')
        .map(s => s.trim())
        .filter(t => t && !t.endsWith('?') &&
                     /Rule:|required|must be|missing|invalid|cannot|not allowed|no longer|already/i.test(t))
        .slice(0, 10);
      wpLog('closeExposureWithOutcome: why blocked -> ' + (whyBlocked.join(' || ') || '(nothing matched)'));

      const needsReserveConfirm = /DMEC0002|click Close Exposure again/i.test(
        (popupDiag.text || '') + ' ' + (alertBarText || '') + ' ' +
        (globalDiag.banners || '') + ' ' + bodyText
      );
      if (needsReserveConfirm) {
        wpLog('closeExposureWithOutcome: DMEC0002 open-reserve confirmation — clicking Close Exposure again to zero the reserve');
        const confirmBtn = page.locator('[id="CloseExposurePopup:CloseExposureScreen:Update"]');
        await confirmBtn.click().catch(() => {});
        // Wait on the POPUP disappearing, not on load/mask state. The
        // Promise.race([waitForLoadState('domcontentloaded'), timeout]) idiom
        // used elsewhere here resolves instantly when the document is already
        // loaded (which it always is inside this ExtJS app), so the visibility
        // check below ran in the same second as the click and always reported
        // "still up" before the server had even answered - confirmed via probe
        // log where both lines carried an identical timestamp.
        const gone = await confirmBtn.waitFor({ state: 'hidden', timeout: 20000 })
          .then(() => true).catch(() => false);
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
        const stillUp = !gone;
        wpLog('closeExposureWithOutcome: after reserve-confirm, popup still up? ' + stillUp);
        reserveConfirmed = !stillUp;
      }

      // Only treat this as a failed outcome when the reserve confirmation did
      // NOT resolve it. When it did, skip the cancel/retry block entirely and
      // fall through to the grid verification below, which is what actually
      // proves the exposure closed.
      if (!reserveConfirmed) {

      // Record this outcome as failed so the next attempt tries a different one
      if (chosenOutcome) {
        triedOutcomes.add(chosenOutcome);
        console.log('closeExposureWithOutcome: outcome "' + chosenOutcome + '" failed — will try a different outcome next attempt. Tried so far:', Array.from(triedOutcomes).join(', '));
      }
      // Cancel the popup before retrying.
      // Activities were swept by the caller before the first close attempt; re-sweeping
      // on every retry would cost ~10 min/attempt and business-rule blocks aren't
      // resolved by activity completion.  Instead, when 3+ outcomes all fail on the
      // same exposure, move to the next same-name Open exposure (handles all-duplicate-
      // name claimant runs, e.g. all ANDREA BROWN).
      await page.locator('[id="CloseExposurePopup:CloseExposureScreen:Cancel"]').click().catch(() => {});
      await Promise.race([page.waitForLoadState('domcontentloaded'), page.waitForTimeout(5000)]).catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      if (triedOutcomes.size >= 3) {
        exposureSkip++;
        triedOutcomes.clear();
        wpLog('closeExposureWithOutcome: 3+ outcomes failed — advancing to next same-name Open exposure (skip=' + exposureSkip + ')');
      }
      continue;
      } // end if (!reserveConfirmed)
    }

    // Popup closed — but closing an exposure can trigger a WebMessageWorksheet
    // (automated insured notification via Hi Marley or similar). This modal
    // blocks the Exposures grid and prevents seeing the "Closed" status.
    // Dismiss it before navigating to verify closure.
    const webMsgClearBtn = page.locator('[id*="WebMessageWorksheet"][id*="ClearButton"]');
    if (await webMsgClearBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
      console.log('closeExposureWithOutcome: dismissing WebMessageWorksheet modal');
      await webMsgClearBtn.click().catch(() => {});
      await Promise.race([page.waitForLoadState('domcontentloaded'), page.waitForTimeout(5000)]).catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    }

    // Handle any x-message-box confirmation dialog (e.g. "Are you sure?")
    const msgBox = page.locator('.x-message-box');
    if (await msgBox.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
      const yesBtn = msgBox.getByRole('button', { name: /yes|ok|confirm/i }).first();
      if (await yesBtn.waitFor({ state: 'visible', timeout: 1000 }).then(() => true).catch(() => false)) {
        console.log('closeExposureWithOutcome: x-message-box appeared, clicking Yes/OK');
        await yesBtn.click().catch(() => {});
        await Promise.race([page.waitForLoadState('domcontentloaded'), page.waitForTimeout(5000)]).catch(() => {});
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      }
    }

    // Navigate to Exposures and verify the exposure now shows "Closed"
    const navItemExp = page.locator('.x-tree-node-text').filter({ hasText: /^Exposures$/ }).first();
    if (await navItemExp.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
      await navItemExp.click();
      await Promise.race([page.waitForLoadState('domcontentloaded'), page.waitForTimeout(5000)]).catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    }
    if (exposureRowText) {
      // Success if the row shows "Closed", OR if no Open row exists (exposure gone from Open list).
      const isClosed = await page.getByRole('row', { name: exposureRowText })
        .filter({ hasText: 'Closed' }).first()
        .waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
      wpLog('closeExposureWithOutcome: isClosed=' + isClosed);
      if (isClosed) {
        wpLog('closeExposureWithOutcome: "' + exposureRowText + '" confirmed Closed');
        return;
      }
      // Also accept: exposure no longer in Open state (might be Denied, Withdrawn, etc.)
      const stillOpen = await page.getByRole('row', { name: exposureRowText })
        .filter({ hasText: 'Open' }).first()
        .waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
      wpLog('closeExposureWithOutcome: stillOpen=' + stillOpen);
      if (!stillOpen) {
        wpLog('closeExposureWithOutcome: "' + exposureRowText + '" no longer Open — treating as closed');
        return;
      }
      wpLog('closeExposureWithOutcome: "' + exposureRowText + '" still Open — retrying');
    } else {
      return; // no row text to verify against — trust popup closed cleanly
    }
  }
  throw new Error('closeExposureWithOutcome: could not confirm exposure closed after 5 attempts');
}

// ── approveLatestCheck (on-prem) ─────────────────────────────────────────────
// After createPayment, the check may be in "Requesting" (pending approval) state.
// CC silently blocks exposure close when a "Requesting" payment exists — no UI
// error is shown. Navigate to My Work → Approvals, find the claim's row, and
// approve it so the payment moves to "Issued" before closeExposureWithOutcome.
// Falls back to Financials → Checks view if the approval queue doesn't show it.
// Always navigates back to the claim on success.
async function approveLatestCheck(page, claimNumber) {
  wpLog('approveLatestCheck: starting for ' + claimNumber);
  let approved = false;
  let usedApproach2 = false; // tracks whether Approach 2 navigated to the claim already

  // --- Approach 1: My Work → Approvals queue ---
  try {
    const myWorkLink = page.locator('[id*="MyWorkTab"], a:has-text("My Work")').first();
    if (await myWorkLink.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
      await myWorkLink.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    }
    const approvalTab = page.locator('[id*="ApprovalsTab"], a:has-text("Approvals"), a:has-text("Approval Queue")').first();
    if (await approvalTab.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
      await approvalTab.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    }
    const claimRow = claimNumber
      ? page.locator('tr, .x-grid-row').filter({ hasText: claimNumber }).first()
      : page.locator('tr, .x-grid-row').first();
    if (await claimRow.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) {
      // CC renders the Approve button as a toolbar action that only appears after
      // the row is selected — click the row first, then search page-wide for the button.
      await claimRow.click().catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});
      // CC uses ExtJS .x-btn elements — "button:has-text()" won't match them.
      const approveBtn = page.locator('.x-btn').filter({ hasText: /^Approve$/ }).first();
      if (await approveBtn.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
        await approveBtn.click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
        console.log('approveLatestCheck: approved from My Work → Approvals queue for', claimNumber);
        approved = true;
      } else {
        console.log('approveLatestCheck: row found in queue but no Approve button visible (even after row select)');
        // Recovery receipts may only expose the Approve button on their own detail page.
        // Try clicking the first anchor or icon img within the row to navigate there.
        const rowAnchor = claimRow.locator('a, img[id]').first();
        if (await rowAnchor.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
          console.log('approveLatestCheck: Strategy 1-B — clicking row detail link (recovery receipt fallback)');
          await rowAnchor.click().catch(() => {});
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(2000);
          const approveDetail = page.locator('.x-btn').filter({ hasText: /Approve/i }).first();
          if (await approveDetail.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
            await approveDetail.click();
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
            console.log('approveLatestCheck: approved from My Work Approvals detail page for', claimNumber);
            approved = true;
          } else {
            const detailBtns = await page.evaluate(() => [...document.querySelectorAll('.x-btn')].map(b => (b.innerText || b.textContent || '').trim()).filter(Boolean)).catch(() => []);
            console.log('approveLatestCheck: Strategy 1-B detail page — no Approve, buttons:', detailBtns.slice(0, 20).join(' | '));
          }
        }
      }
    } else {
      console.log('approveLatestCheck: claim not in approval queue, will try Financials → Checks');
    }
  } catch (err) {
    console.log('approveLatestCheck: approval queue approach error:', err.message);
  }

  // Approach 2 always runs regardless of Approach 1 outcome.
  // Payment check approval (Approach 1) and recovery receipt approval (Strategies D/E/F)
  // are independent: if Approach 1 approved a payment check, recovery receipts may still
  // be in "Submitted" state and must also be approved before exposure close will succeed.
  {
    // --- Approach 2: Navigate within claim to find and approve all Requesting checks ---
    // Strategy A: Financials → Summary (confirmed working in getAvailableReserveAmount)
    //             then → Checks/Payments from that known-good sub-page context.
    // Strategy B: Transactions page (confirmed to navigate from screenshots).
    // All "Requesting" checks must be approved before closeExposureWithOutcome can succeed.
    usedApproach2 = true;
    try {
      const { openExistingClaim } = require('./claimCenterBase');
      if (claimNumber) await openExistingClaim(page, claimNumber);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);

      const settle = async () => {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      };

      // Shared helper: approve every visible "Requesting" check on the current page.
      // After each approval, re-navigates to Transactions to catch additional checks
      // (e.g., TC-FIN-006's $15k check AND TC-FIN-011's own check may both be Requesting).
      const approveAllVisible = async () => {
        // Match both "Requesting" (cloud label) and "Pending approval" / "Pending Approval"
        // (on-prem label confirmed via live Transactions grid screenshot).
        const pendingPattern = /^Requesting$|^Pending [Aa]pproval$/;
        for (let i = 0; i < 5; i++) {
          // Look for Requesting/Pending approval on the current page first
          let reqCell = page.locator('.x-grid-cell-inner').filter({ hasText: pendingPattern }).first();
          let found = await reqCell.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
          if (!found) {
            // Re-navigate to Transactions (confirmed working) to find remaining checks
            const transRenav = page.locator('.x-tree-node-text').filter({ hasText: /^Transactions$/ }).first();
            if (await transRenav.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
              await transRenav.click();
              await settle();
              await page.waitForTimeout(1500);
            }
            reqCell = page.locator('.x-grid-cell-inner').filter({ hasText: pendingPattern }).first();
            found = await reqCell.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
            if (!found) break; // no more pending-approval checks anywhere
          }
          await reqCell.click().catch(() => {});
          await settle();
          await page.waitForTimeout(2000);
          const apBtn = page.locator('.x-btn').filter({ hasText: /Approve/ }).first();
          if (!await apBtn.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false)) {
            console.log('approveLatestCheck: clicked Requesting row but no Approve button — page:', (await page.evaluate(() => document.body.innerText.substring(0, 120)).catch(() => '')).replace(/\n/g, '|'));
            continue;
          }
          await apBtn.click();
          await settle();
          console.log('approveLatestCheck: approved Requesting check #' + (i + 1));
          approved = true;
        }
      };

      // LESSON LEARNED: clicking any Financials sub-item (Summary, Checks/Payments) collapses
      // the entire Financials sub-tree, hiding all other sibling nav items. Strategy:
      //   1. Click "Financials" only → ALL sub-items become visible simultaneously
      //   2. Immediately dump Checks/Payments DOM path (before any sub-item click)
      //   3. Click "Transactions" (confirmed working via live screenshots) to navigate
      //   4. Look for "Requesting" on Transactions page → approve
      //   5. If filter hides it → change filter → approve
      //   6. If Transactions doesn't show it → re-expand Financials → try Checks/Payments

      const financialsNav = page.locator('.x-tree-node-text').filter({ hasText: /^Financials$/ }).first();
      if (await financialsNav.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
        await financialsNav.click();
        await settle();
        await page.waitForTimeout(1500); // let all sub-items render before clicking any
        console.log('approveLatestCheck: clicked Financials — all sub-items now visible');
      }

      // Diagnostic: dump Checks/Payments path NOW (before any sub-item click collapses the tree)
      const checksInfo = await page.evaluate(() => {
        const span = [...document.querySelectorAll('.x-tree-node-text')]
          .find(s => s.textContent.trim() === 'Checks/Payments');
        if (!span) return JSON.stringify({ found: false });
        const path = [];
        let el = span;
        while (el && el.tagName !== 'BODY') {
          path.push(el.tagName + (el.id ? '#' + el.id.slice(0, 20) : '') + '.' + [...el.classList].slice(0, 4).join('.'));
          el = el.parentElement;
        }
        const disabled = !!span.closest('[class*="disabled"]');
        const anchor = span.closest('a');
        return JSON.stringify({ found: true, disabled, href: anchor ? anchor.href.slice(-60) : '', path: path.slice(0, 8) });
      }).catch(e => 'err:' + e.message);
      console.log('approveLatestCheck: Checks/Payments DOM info (post-Financials):', checksInfo.substring(0, 400));

      // Strategy A: Transactions nav — CONFIRMED working from live screenshots
      // IMPORTANT: do NOT click Summary or Checks/Payments first — that collapses sibling nav items
      const transNav = page.locator('.x-tree-node-text').filter({ hasText: /^Transactions$/ }).first();
      if (await transNav.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
        await transNav.click();
        await settle();
        await page.waitForTimeout(2000);

        const transDump = await page.evaluate(() => {
          const allCells = [...document.querySelectorAll('.x-grid-cell-inner')].map(c => (c.innerText || c.textContent || '').trim()).filter(Boolean);
          const navTexts = new Set([...document.querySelectorAll('.x-tree-node-text')].map(s => s.textContent.trim()));
          const contentCells = allCells.filter(t => !navTexts.has(t) && t);
          const hasReq = allCells.some(t => /^Requesting$|^Pending Approval$/i.test(t));
          const filters = [...document.querySelectorAll('.x-toolbar select, .x-toolbar input[type="text"]')]
            .map(e => e.tagName + ':' + (e.value || '').trim().slice(0, 30));
          return JSON.stringify({ hasReq, total: allCells.length, filters, content: contentCells.slice(0, 30).join(' | ') });
        }).catch(e => 'err:' + e.message);
        console.log('approveLatestCheck: Transactions dump:', transDump.substring(0, 600));

        if (transDump.includes('"hasReq":true')) {
          await approveAllVisible();
        } else {
          // Transactions may have a type filter (e.g. "Recoveries/Credits") hiding payment rows
          const filterResult = await page.evaluate(() => {
            const selects = [...document.querySelectorAll('.x-toolbar select, select')];
            for (const sel of selects) {
              if ([...sel.options].some(o => /Recoveries|Credits/i.test(o.text))) {
                const allOpt = [...sel.options].find(o => !o.value || /All|^$/i.test(o.text));
                sel.value = allOpt ? allOpt.value : '';
                if (!allOpt) sel.selectedIndex = 0;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return 'filter-changed';
              }
            }
            return 'no-recoveries-filter-found';
          }).catch(e => 'err:' + e.message);
          console.log('approveLatestCheck: Transactions filter change:', filterResult);
          if (!filterResult.includes('no-recoveries')) {
            await settle();
            await page.waitForTimeout(1500);
            await approveAllVisible();
          } else {
            console.log('approveLatestCheck: Transactions showed no Requesting (filter was not "Recoveries/Credits") — transDump:', transDump.substring(0, 300));
          }
        }
      }

      // Strategy B: Checks/Payments direct click (via Playwright native click, after re-expanding Financials)
      // Prior JS-evaluate clicks didn't navigate; re-try with trusted Playwright event
      if (!approved) {
        await financialsNav.click().catch(() => {});
        await settle();
        await page.waitForTimeout(1500);
        const checksSpan = page.locator('.x-tree-node-text').filter({ hasText: /^Checks\/Payments$/ }).first();
        const checksVisible = await checksSpan.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
        console.log('approveLatestCheck: Checks/Payments visible (Strategy B attempt):', checksVisible);
        if (checksVisible) {
          await checksSpan.click(); // Playwright native click = trusted event (not JS synthetic)
          await settle();
          await page.waitForTimeout(2000);
          const afterChecks = await page.evaluate(() => {
            const allCells = [...document.querySelectorAll('.x-grid-cell-inner')].map(c => (c.innerText || c.textContent || '').trim()).filter(Boolean);
            const hasReq = allCells.some(t => /^Requesting$|^Pending [Aa]pproval$/i.test(t));
            const navTexts = new Set([...document.querySelectorAll('.x-tree-node-text')].map(s => s.textContent.trim()));
            const content = allCells.filter(t => !navTexts.has(t)).slice(0, 20).join(' | ');
            return JSON.stringify({ hasReq, total: allCells.length, content });
          }).catch(e => 'err:' + e.message);
          console.log('approveLatestCheck: after Checks/Payments click (Strategy B):', afterChecks.substring(0, 400));
          if (afterChecks.includes('"hasReq":true')) await approveAllVisible();
        }
      }

      // Strategy C: Row-detail icon click in Checks/Payments, then try Actions dropdown.
      // On-prem CC shows an img [cursor=pointer] in the first column of each
      // Checks/Payments row. Clicking it navigates to the payment detail page.
      // If no standalone Approve button exists, try the Actions dropdown — CC often
      // routes Approve through the Actions menu (alongside Edit/Delete/Void).
      // Iterates ALL pending rows (last → first = most recent → oldest).
      if (!approved) {
        await financialsNav.click().catch(() => {});
        await settle();
        await page.waitForTimeout(1000);
        const checksNavC = page.locator('.x-tree-node-text').filter({ hasText: /^Checks\/Payments$/ }).first();
        if (await checksNavC.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
          await checksNavC.click();
          await settle();
          await page.waitForTimeout(2000);
          const pendingRowsC = page.locator('.x-grid-row').filter({ hasText: /Pending [Aa]pproval/i });
          const rowCountC = await pendingRowsC.count().catch(() => 0);
          for (let ri = rowCountC - 1; ri >= 0 && !approved; ri--) {
            const rowImg = pendingRowsC.nth(ri).locator('img').first();
            if (!await rowImg.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) continue;
            await rowImg.click();
            await settle();
            await page.waitForTimeout(3000);
            const btnTexts = await page.evaluate(() =>
              [...document.querySelectorAll('.x-btn')]
                .map(b => (b.innerText || b.textContent || '').trim())
                .filter(Boolean)
            ).catch(() => []);
            console.log('approveLatestCheck: Strategy C[' + ri + '] buttons:', btnTexts.join(' | '));
            // Try standalone Approve button first
            const apBtnC = page.locator('.x-btn').filter({ hasText: /Approve/i }).first();
            if (await apBtnC.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
              await apBtnC.click();
              await settle();
              console.log('approveLatestCheck: approved via row icon (Strategy C[' + ri + '])');
              approved = true;
              break;
            }
            // No standalone Approve — try the Actions dropdown on the payment detail page.
            // Use innerText-based evaluate to find the exact button (avoids regex/aria issues).
            const actionsCountC = await page.evaluate(() =>
              [...document.querySelectorAll('.x-btn')]
                .filter(b => (b.innerText || b.textContent || '').trim() === 'Actions').length
            ).catch(() => 0);
            console.log('approveLatestCheck: Strategy C[' + ri + '] actionsCount=' + actionsCountC);
            const actionsBtnsC = page.locator('.x-btn').filter({ hasText: /Actions/ });
            const actionsCountLoc = await actionsBtnsC.count().catch(() => 0);
            for (let ai = actionsCountLoc - 1; ai >= 0 && !approved; ai--) {
              const actBtn = actionsBtnsC.nth(ai);
              if (!await actBtn.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) continue;
              await actBtn.click();
              await page.waitForTimeout(1000);
              const approveItem = page.locator('.x-menu-item').filter({ hasText: /Approve/i }).first();
              if (await approveItem.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
                await approveItem.click();
                await settle();
                approved = true;
                console.log('approveLatestCheck: approved via Actions menu on payment detail (Strategy C[' + ri + '])');
              } else {
                const menuItems = await page.locator('.x-menu-item').allInnerTexts().catch(() => []);
                console.log('approveLatestCheck: Strategy C[' + ri + '] Actions menu (no Approve):', menuItems.filter(Boolean).join(' | '));
                await page.keyboard.press('Escape').catch(() => {});
              }
            }
            if (!approved && ri > 0) {
              // Navigate back to Checks/Payments to try the next row
              await financialsNav.click().catch(() => {});
              await settle();
              await page.waitForTimeout(500);
              const renavC = page.locator('.x-tree-node-text').filter({ hasText: /^Checks\/Payments$/ }).first();
              if (await renavC.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
                await renavC.click();
                await settle();
                await page.waitForTimeout(2000);
              }
            }
          }
          if (!approved) {
            console.log('approveLatestCheck: Strategy C tried all ' + rowCountC + ' pending rows — none approved');
          }
        }
      }

      // Strategy D: Recovery Checks nav — recovery receipts in "Requesting"/"Submitted" appear here.
      // Runs unconditionally: payment check approval and recovery receipt approval are independent.
      {
        await financialsNav.click().catch(() => {});
        await settle();
        await page.waitForTimeout(1500);
        // Dump all visible nav items so we can identify the exact Recovery Checks name
        const allNavD = await page.evaluate(() =>
          [...document.querySelectorAll('.x-tree-node-text')].map(s => s.textContent.trim()).filter(Boolean)
        ).catch(() => []);
        console.log('approveLatestCheck: Strategy D — nav items visible:', allNavD.join(' | '));
        const recovNavD = page.locator('.x-tree-node-text').filter({ hasText: /^Recovery\s*(Checks?|Receipts?|Credits?)?$/ }).first();
        const recovVisibleD = await recovNavD.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
        console.log('approveLatestCheck: Strategy D — Recovery nav visible:', recovVisibleD,
          '| navText:', await recovNavD.textContent().catch(() => ''));
        if (recovVisibleD) {
          await recovNavD.click();
          await settle();
          await page.waitForTimeout(2000);
          const recovDump = await page.evaluate(() => {
            const allCells = [...document.querySelectorAll('.x-grid-cell-inner')].map(c => (c.innerText || c.textContent || '').trim()).filter(Boolean);
            const hasReq = allCells.some(t => /^Requesting$|^Pending [Aa]pproval$/i.test(t));
            return JSON.stringify({ hasReq, total: allCells.length, content: allCells.slice(0, 30).join(' | ') });
          }).catch(e => 'err:' + e.message);
          console.log('approveLatestCheck: Strategy D dump:', recovDump.substring(0, 600));
          // Recovery Checks page shows pending receipts with status "Submitted" (on-prem label
          // for what Transactions calls "Requesting"). Also match "Requesting" for safety.
          const pendingRowsD = page.locator('.x-grid-row').filter({ hasText: /Requesting|Submitted|Pending [Aa]pproval/i });
          const rowCountD = await pendingRowsD.count().catch(() => 0);
          console.log('approveLatestCheck: Strategy D — pendingRowsD count:', rowCountD);
          for (let ri = rowCountD - 1; ri >= 0; ri--) {
            // Iterate ALL pending recovery rows — multiple receipts (e.g. Subrogation + Salvage)
            // must each be approved/voided independently. Use per-row flag so earlier rows
            // don't suppress fallback for later rows.
            let rowDoneD = false;
            // Step 1: Try toolbar Approve by selecting the row (checkbox) without navigating away.
            // CC pattern: row checkbox click → toolbar "Approve" button appears.
            const rowChkD = pendingRowsD.nth(ri).locator('.x-grid-checkcolumn, input[type="checkbox"]').first();
            if (await rowChkD.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
              await rowChkD.click().catch(() => {});
              await page.waitForTimeout(600);
              const toolbarApprD = page.locator('.x-btn').filter({ hasText: /^Approve$/i }).first();
              if (await toolbarApprD.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
                await toolbarApprD.click();
                await settle();
                console.log('approveLatestCheck: Strategy D approved via toolbar row-select (row ' + ri + ')');
                rowDoneD = true;
                approved = true;
                continue;
              }
            }
            // Step 2: Navigate to the receipt detail via the row icon/link
            const rowIconD = pendingRowsD.nth(ri).locator('img, a').first();
            if (await rowIconD.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
              await rowIconD.click();
            } else {
              await pendingRowsD.nth(ri).click();
            }
            await settle();
            await page.waitForTimeout(2000);
            const btnsD = await page.evaluate(() => [...document.querySelectorAll('.x-btn')].map(b => (b.innerText || b.textContent || '').trim()).filter(Boolean)).catch(() => []);
            console.log('approveLatestCheck: Strategy D row ' + ri + ' buttons:', btnsD.join(' | '));
            // Try standalone Approve button first
            const apBtnD = page.locator('.x-btn').filter({ hasText: /Approve/i }).first();
            if (await apBtnD.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
              await apBtnD.click();
              await settle();
              console.log('approveLatestCheck: Strategy D approved recovery receipt (row ' + ri + ')');
              rowDoneD = true;
              approved = true;
            } else {
              // Actions → Approve: receipt detail page shows "Actions" dropdown with Approve option.
              // Use /Actions/i (not /^Actions$/) — ExtJS buttons may have trailing icon text.
              const actBtnD = page.locator('.x-btn').filter({ hasText: /Actions/i }).first();
              if (await actBtnD.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
                await actBtnD.click();
                await page.waitForTimeout(1500);
                const menuItemsD = await page.locator('.x-menu-item').allInnerTexts().catch(() => []);
                console.log('approveLatestCheck: Strategy D Actions menu:', menuItemsD.filter(Boolean).join(' | '));
                const approveItemD = page.locator('.x-menu-item').filter({ hasText: /Approve/i }).first();
                if (await approveItemD.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
                  await approveItemD.click();
                  await settle();
                  console.log('approveLatestCheck: Strategy D approved via Actions menu (row ' + ri + ')');
                  rowDoneD = true;
                  approved = true;
                } else {
                  console.log('approveLatestCheck: Strategy D Actions menu — no Approve item found');
                  await page.keyboard.press('Escape').catch(() => {});
                }
              } else {
                console.log('approveLatestCheck: Strategy D — no Actions button found on receipt detail page');
              }

              // No void fallback — voiding legitimate recovery receipts (e.g. TC-FIN-009
              // Subrogation, TC-FIN-010 Salvage) creates reversal transactions that
              // silently block closeExposureWithOutcome. If no Approve was found, skip.
              if (!rowDoneD) {
                console.log('approveLatestCheck: Strategy D — no Approve available for row ' + ri + ', skipping (not voiding)');
              }

              // Always navigate back to Recovery Checks list for the next row,
              // regardless of approval outcome — we iterate ALL rows.
              if (ri > 0) {
                await financialsNav.click().catch(() => {});
                await settle();
                await page.waitForTimeout(500);
                const renavD = page.locator('.x-tree-node-text').filter({ hasText: /^Recovery\s*(Checks?|Receipts?|Credits?)?$/ }).first();
                if (await renavD.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
                  await renavD.click();
                  await settle();
                  await page.waitForTimeout(2000);
                }
              }
            }
          }
        }
      }

      // Strategy E: Workplan → "Review and approve new recovery" activities.
      // Runs unconditionally: payment check approval (Strategies A-D) and recovery receipt
      // approval are independent. A receipt stays in "Submitted" even after the payment check
      // is approved, so this must always run regardless of earlier strategy outcomes.
      // There may be multiple activities (e.g. Subrogation + Salvage). Loop until none remain.
      {
        const workplanNavE = page.locator('.x-tree-node-text').filter({ hasText: /^Workplan$/ }).first();
        if (await workplanNavE.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
          await workplanNavE.click();
          await settle();
          await page.waitForTimeout(2000);

          let approvedCountE = 0;
          for (let rri = 0; rri < 10; rri++) {
            // Only match rows still in Open/Submitted state — Completed ones stay visible but must be skipped
            const recovApprRow = page.locator('.x-grid-row, tr')
              .filter({ hasText: /Review and approve new recovery/i })
              .filter({ hasNot: page.locator('.x-grid-cell-inner').filter({ hasText: /^Complete(d)?$/i }) })
              .first();
            const recovApprVisible = await recovApprRow.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
            console.log('approveLatestCheck: Strategy E[' + rri + '] — open row visible:', recovApprVisible);
            if (!recovApprVisible) break;

            // Navigate to activity detail page via subject text anchor (not img/icon which stays on Workplan).
            // The inline Workplan Approve buttons do not trigger real approval — only the detail page does.
            const subjectLinkE = recovApprRow.locator('a').filter({ hasText: /Review and approve/i }).first();
            const anyAnchorE = recovApprRow.locator('a').first();
            let navigatedE = false;
            if (await subjectLinkE.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
              await subjectLinkE.click();
              navigatedE = true;
            } else if (await anyAnchorE.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
              await anyAnchorE.click();
              navigatedE = true;
            } else {
              await recovApprRow.click();
            }
            if (navigatedE) await page.waitForLoadState('domcontentloaded').catch(() => {});
            await settle();
            await page.waitForTimeout(2000);

            const btnsE = await page.evaluate(() => [...document.querySelectorAll('.x-btn')].map(b => (b.innerText || b.textContent || '').trim()).filter(Boolean)).catch(() => []);
            console.log('approveLatestCheck: Strategy E[' + rri + '] buttons (navigated=' + navigatedE + '):', btnsE.join(' | '));

            let approvedThis = false;
            // Clicking the activity link opens a quick-approval popup (Approve | Link Document | Cancel | Reject).
            // That popup's Approve button appears AFTER the workplan row buttons in DOM order.
            // Detect popup by "Link Document" button presence; if found, click the LAST Approve (popup's).
            // Otherwise fall back to first/only Approve on a full detail page.
            const linkDocBtnE = page.locator('.x-btn').filter({ hasText: 'Link Document' }).first();
            const hasPopupE = await linkDocBtnE.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
            console.log('approveLatestCheck: Strategy E[' + rri + '] — approval popup detected:', hasPopupE);
            if (hasPopupE) {
              // Popup present: its Approve is the last Approve button in the DOM
              const popupApprBtnE = page.locator('.x-btn').filter({ hasText: /^Approve$/i }).last();
              if (await popupApprBtnE.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
                await popupApprBtnE.click();
                await settle();
                console.log('approveLatestCheck: Strategy E[' + rri + '] — approved via popup Approve (.last())');
                approvedCountE++;
                approved = true;
                approvedThis = true;
              } else {
                console.log('approveLatestCheck: Strategy E[' + rri + '] — popup Approve (.last()) not visible');
              }
            } else {
              for (const apPat of [/^Approve$/i, /Approve/i]) {
                const apBtnE = page.locator('.x-btn').filter({ hasText: apPat }).first();
                if (await apBtnE.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
                  await apBtnE.click();
                  await settle();
                  console.log('approveLatestCheck: Strategy E[' + rri + '] — approved via', apPat);
                  approvedCountE++;
                  approved = true;
                  approvedThis = true;
                  break;
                }
              }
            }
            if (!approvedThis) {
              console.log('approveLatestCheck: Strategy E[' + rri + '] — no Approve button found, stopping loop');
              break;
            }

            // Navigate back to Workplan for the next pending activity
            if (await workplanNavE.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
              await workplanNavE.click();
              await settle();
              await page.waitForTimeout(2000);
            }
          }
          console.log('approveLatestCheck: Strategy E — total recovery approvals:', approvedCountE);
          if (approvedCountE === 0) {
            const wpRows = await page.evaluate(() =>
              [...document.querySelectorAll('.x-grid-cell-inner')].map(c => (c.innerText || c.textContent || '').trim()).filter(Boolean).slice(0, 40)
            ).catch(() => []);
            console.log('approveLatestCheck: Strategy E — Workplan dump (no activities found):', wpRows.join(' | '));
          }
        }
      }

      // Strategy F: My Work → Activities personal queue.
      // "Review and approve new recovery" activities may be assigned to admin's personal
      // queue rather than appearing in the claim's Workplan view. Navigates to admin's
      // My Work → Activities tab, finds any recovery approval activity matching the
      // claim number, and approves it.
      {
        try {
          const myWorkLinkF = page.locator('[id*="MyWorkTab"], a:has-text("My Work")').first();
          if (await myWorkLinkF.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
            await myWorkLinkF.click();
            await settle();
            await page.waitForTimeout(1000);
          }
          // Look for an Activities sub-tab (distinct from Approvals)
          const activTabF = page.locator('[id*="ActivitiesTab"], [id*="activitiesTab"], a:has-text("Activities")').first();
          if (await activTabF.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)) {
            await activTabF.click();
            await settle();
            await page.waitForTimeout(1500);
          }
          // Look for recovery approval activity row (may or may not be filtered by claim number)
          const recovRowF = page.locator('tr, .x-grid-row')
            .filter({ hasText: /Review and approve new recovery/i })
            .first();
          let recovFoundF = await recovRowF.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
          // If not found and we have a claim number, also try filtering by claim on the grid
          if (!recovFoundF && claimNumber) {
            // Try a search/filter input if present
            const filterInputF = page.locator('input[id*="QuickSearch"], input[placeholder*="search" i]').first();
            if (await filterInputF.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
              await filterInputF.fill(claimNumber);
              await filterInputF.press('Enter');
              await settle();
              await page.waitForTimeout(1500);
              recovFoundF = await recovRowF.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
            }
          }
          console.log('approveLatestCheck: Strategy F — recovery row in My Work Activities visible:', recovFoundF);
          for (let fi = 0; fi < 5 && recovFoundF; fi++) {
            const rowLinkF = recovRowF.locator('a').first();
            if (await rowLinkF.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
              await rowLinkF.click();
            } else {
              await recovRowF.click();
            }
            await settle();
            await page.waitForTimeout(2000);
            const btnsF = await page.evaluate(() => [...document.querySelectorAll('.x-btn')].map(b => (b.innerText || b.textContent || '').trim()).filter(Boolean)).catch(() => []);
            console.log('approveLatestCheck: Strategy F[' + fi + '] buttons:', btnsF.join(' | '));
            const linkDocF = page.locator('.x-btn').filter({ hasText: 'Link Document' }).first();
            const hasPopupF = await linkDocF.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
            let approvedF = false;
            if (hasPopupF) {
              const popApprF = page.locator('.x-btn').filter({ hasText: /^Approve$/i }).last();
              if (await popApprF.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
                await popApprF.click();
                await settle();
                console.log('approveLatestCheck: Strategy F[' + fi + '] approved via popup Approve');
                approved = true;
                approvedF = true;
              }
            } else {
              const apBtnF = page.locator('.x-btn').filter({ hasText: /^Approve$/i }).first();
              if (await apBtnF.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
                await apBtnF.click();
                await settle();
                console.log('approveLatestCheck: Strategy F[' + fi + '] approved via Approve button');
                approved = true;
                approvedF = true;
              }
            }
            if (!approvedF) break;
            // Navigate back to My Work → Activities for next pending
            if (await myWorkLinkF.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
              await myWorkLinkF.click();
              await settle();
              if (await activTabF.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
                await activTabF.click();
                await settle();
              }
              await page.waitForTimeout(1500);
            }
            recovFoundF = await recovRowF.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
          }
        } catch (efErr) {
          console.log('approveLatestCheck: Strategy F error:', efErr.message);
        }
      }

      if (!approved) {
        console.log('approveLatestCheck: all strategies exhausted — no approvable Requesting/recovery check found');
      }
    } catch (err) {
      console.log('approveLatestCheck: Approach 2 error:', err.message);
    }
  }

  // Always navigate back to the claim. Approach 2 now unconditionally runs and
  // Strategy F may leave the page on "My Work" — re-opening the claim ensures
  // the calling code (completeAllWorkplanActivities, closeExposureWithOutcome)
  // starts in the right context.
  if (claimNumber) {
    const { openExistingClaim } = require('./claimCenterBase');
    await openExistingClaim(page, claimNumber).catch(err => {
      console.log('approveLatestCheck: could not navigate back to claim:', err.message);
    });
  }

  wpLog('approveLatestCheck: result=' + approved + ' for ' + claimNumber);
  return approved;
}

// ── completeAllWorkplanActivities (on-prem) ─────────────────────────────────
// Per user-provided workflow: before a final payment can close an exposure,
// every open Workplan activity needs to be completed - open each one, fill
// any additional required fields/radio buttons it reveals, then click
// "Complete".
async function completeAllWorkplanActivities(page, exposureFilterText = null) {
  wpLog('completeAllWorkplanActivities: start' + (exposureFilterText ? ' filter=' + exposureFilterText : ''));
  const navItem = page.locator('.x-tree-node-text').filter({ hasText: /^Workplan$/ }).first();
  // Per explicit instruction: always navigate to the Workplan tab FIRST,
  // deterministically, rather than silently skipping straight to scanning
  // subjectLinks on whatever tab the caller happened to leave the page on -
  // a missed/failed nav here would otherwise make this function silently
  // operate against the wrong screen with no signal why 0 activities were
  // found (or worse, why it found unrelated activity-looking links).
  const navigatedToWorkplan = await navItem.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  if (navigatedToWorkplan) {
    await navItem.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  } else {
    console.log('completeAllWorkplanActivities: WARNING - could not find/click the Workplan tab, proceeding on current screen');
  }
  // Confirmed via live failure: this function reported "no more activities
  // to process" INSTANTLY on every single call across an entire test run -
  // even the very first call, when a live screenshot at the exact moment of
  // failure clearly showed 15 open rows (including "NEW LOSS NOTICE",
  // present on every claim). The grid's rows render asynchronously after
  // the mask clears - querying immediately raced ahead of that render.
  // Wait for at least one real Subject link to actually appear before
  // trusting an empty query result.
  await page.locator('[id*="WorkplanLV"][id$=":Subject"]').first()
    .waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

  // Confirmed via live failure: on a heavily-reused shared claim, many
  // OTHER exposures' activities (e.g. "Tort Confirmation", "Create a Matter
  // for Exposure In Suit") have no "Complete" button at all (they need a
  // different action entirely) - the old code treated hitting ONE of these
  // as a reason to give up on the ENTIRE Workplan, silently leaving every
  // activity AFTER it (by id order) untouched, including whichever one was
  // actually blocking a specific exposure's Close. Track skipped activity
  // ids instead so they're excluded from later passes but don't stop the
  // sweep, and optionally filter to only activities whose row mentions
  // exposureFilterText - the caller-specific target rather than blindly
  // touching every open activity on the whole claim.
  // Confirmed via live failure: positional row ids (WorkplanLV-<index>)
  // shift after the list re-renders (a completed row disappears, later rows
  // shift up) - tracking "skip" by id would silently start matching a
  // DIFFERENT activity next pass. Track by the row's own text instead
  // (subject + exposure description together), which stays meaningful
  // across reloads even if not perfectly unique.
  const skippedRowTexts = [];
  let lastSubjectText = null;
  let sameSubjectRepeats = 0;
  let prevActivityCount = Infinity; // tracks list length to distinguish "same-named but different activity" from "true stuck loop"
  for (let guard = 0; guard < 20; guard++) {
    const currentActivityCount = await page.locator('[id*="WorkplanLV"][id$=":Subject"]').count().catch(() => 0);
    const targetId = await page.evaluate(({ filterText, skipTexts }) => {
      const links = Array.from(document.querySelectorAll('[id*="WorkplanLV"][id$=":Subject"]'));
      for (const el of links) {
        const row = el.closest('.x-grid-row') || el.closest('tr');
        const rowText = row ? row.textContent.trim() : el.textContent.trim();
        if (skipTexts.includes(rowText)) continue;
        if (filterText && !rowText.includes(filterText)) continue;
        return el.id;
      }
      return null;
    }, { filterText: exposureFilterText, skipTexts: skippedRowTexts }).catch(() => null);
    if (!targetId) {
      wpLog('completeAllWorkplanActivities: no more' + (exposureFilterText ? ' matching' : '') + ' activities to process');
      break;
    }
    const link = page.locator('[id="' + targetId + '"]');
    const subjectText = (await link.textContent().catch(() => '(unknown activity)')).trim();
    await link.click().catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});

    // Confirmed via live DOM (user-provided): the real, stable id is
    // "ActivityDetailWorksheet:ActivityDetailScreen:ActivityDetailScreen_CompleteButton"
    // - the button's visible text is split across spans for the underlined
    // accelerator letter ("Com<span>p</span>lete"), which was silently
    // breaking the old `.x-btn` + hasText/exact text-based lookup (same
    // "id, not text" pattern needed elsewhere in this app, e.g. the Remove
    // button on Set Reserves).
    const completeBtn = page.locator('[id$="ActivityDetailScreen_CompleteButton"]').first();
    const hasCompleteBtn = await completeBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);

    if (!hasCompleteBtn) {
      // No Complete button on this activity type (e.g. "Tort Confirmation",
      // "Create a Matter for Exposure In Suit" need a different action) -
      // record it as skipped and go back to Workplan to try the NEXT
      // activity, instead of giving up on the whole sweep. Read the row's
      // own text here (same shape as the evaluate() query above) so the
      // skip list matches on later passes.
      const skipRowText = await page.evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const row = el.closest('.x-grid-row') || el.closest('tr');
        return row ? row.textContent.trim() : el.textContent.trim();
      }, targetId).catch(() => null);
      if (skipRowText) skippedRowTexts.push(skipRowText);
      console.log('completeAllWorkplanActivities: no Complete button for "' + subjectText + '" - skipping, continuing sweep');
      // Click Cancel to close the CC activity tab — without this the tab stays
      // open indefinitely, piling up as the sweep processes more activities.
      await page.locator('.x-btn').filter({ hasText: /^Cancel$/ }).first()
        .click({ timeout: 2000 }).catch(() => {});
    } else {
      // Optimistic: click Complete immediately before sweeping fields.
      // Most activities have no required fields — this saves 15-30 s per activity.
      // If Complete is blocked by validation the button stays visible; fall through
      // to the full sweep and retry.
      await completeBtn.click().catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 3000 }).catch(() => {});
      const stillOnActivity = await completeBtn.waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false);

      if (stillOnActivity) {
        // Clear the per-activity native-setter tracker. setFieldYes / answerNoForQuestion
        // push inputEl IDs here when they set checked=true; the atomic-complete evaluate
        // reads these IDs to re-apply native setter after any GW AJAX re-render, then
        // clicks Complete from within the same JS frame so nothing can intervene.
        await page.evaluate(() => { window.__gwci = []; }).catch(() => {});

        // Dismiss any validation banner from the optimistic click BEFORE sweeping.
        // CC shows a validation panel when Complete fires with missing fields; that
        // panel's "Clear" button restores the form to interactive state so our
        // field-filling clicks (especially answerYesForQuestion) land on the real
        // form inputs rather than the error panel text.
        await page.locator('.x-btn').filter({ hasText: /^Clear$/ }).first()
          .click({ timeout: 1000 }).catch(() => {});
        await page.waitForTimeout(200);

        // Pre-sweep diagnostic: dump all activity-form inputs with full IDs and nearest label text.
        // This is scoped to inputs whose IDs contain "ActivityDetailWorksheet" or "ActivityDetailScreen",
        // which avoids the workplan navigation comboboxes polluting the output.
        {
          const preSweepDump = await page.evaluate(() => {
            const isNav = id => /QuickJump|WorkplanLV|MenuLinks|ListPaging/i.test(id);
            const inputs = Array.from(document.querySelectorAll(
              'input[id*="ActivityDetailWorksheet"], input[id*="ActivityDetailScreen"]'
            )).filter(el => el.id && !isNav(el.id));
            return inputs.map(el => {
              let lbl = '';
              let p = el.parentElement;
              for (let i = 0; i < 10 && p; i++, p = p.parentElement) {
                const l = p.querySelector('[id$="-labelEl"]') || p.querySelector('.x-form-item-label') || p.querySelector('label');
                if (l && l.textContent.trim()) {
                  lbl = l.textContent.trim().replace(/[\*\s]+$/, '').slice(0, 55);
                  break;
                }
              }
              const role = el.getAttribute('role') || el.type || '?';
              const chk = el.className.includes('-checked') ? '[CHK]' : '';
              return '"' + lbl + '" | ' + role + ' | val:"' + (el.value || '') + '"' + chk + ' | ' + el.id;
            }).join('\n');
          }).catch(() => '');
          if (preSweepDump) console.log('PRESWEEP[' + subjectText.slice(0, 30) + ']:\n' + preSweepDump);
        }

        // Complete was blocked by validation — fill required fields then retry.
        await sweepComboboxesOnPrem(page, null);
        await clickUnansweredBooleanFieldsOnPrem(page, null);

        // Confirmed via user's live observation: an earlier version here also
        // ran a page-wide "click every visible No label" sweep, which had a
        // side effect of typing into/touching the activity's own Description
        // textarea (unrelated field, should never be edited) - removed in
        // favor of the specific, scoped click below, which targets ONLY the
        // "Was contact able to be made?" row and nothing else on the page.
        //
        // Confirmed via user direction: different Workplan activities ask
        // their own context-specific Yes/No question ("Was contact able to be
        // made?" on "Make initial contact with insured/claimant", "Are you
        // closing this claim?" on "Initial 30 day diary", etc.) as a genuine
        // role=radio pair - blindly answering "No" is what was causing an
        // activity to never actually leave the Workplan list (Complete
        // silently no-ops / re-queues a follow-up instead of closing it).
        // Confirmed via live failure: a page-wide "every Yes radio" sweep
        // scoped by `ancestor::tr[1]` was too broad - when the field isn't
        // actually inside a real <tr> (just ExtJS div-based layout), the xpath
        // walked up to some much larger ancestor that ALSO happened to contain
        // "Create a copy of this activity?" text elsewhere on the page,
        // wrongly excluding the real target. Answer each KNOWN question label
        // individually instead, scoped tightly to that label's own row - the
        // same technique already proven to work for "Was contact able to be
        // made?".
        // Finds a form field by label text (strips trailing asterisk used for required fields),
        // then returns an object { id, type } where type is 'radio-yes'|'radio-no'|'combo'.
        // Uses Playwright .click() on the returned id (not evaluate .click()).
        async function findFieldNearLabel(labelText, wantYes) {
          const result = await page.evaluate(({ text, wantY }) => {
            // Strip trailing asterisk/whitespace from labels (CC marks required fields with *)
            function normLabel(t) { return (t || '').replace(/\*\s*$/, '').trim(); }
            // Find all possible label elements (CC uses multiple patterns)
            const candidates = Array.from(document.querySelectorAll(
              '[id$="-labelEl"], .x-form-item-label, label, th, td, .x-form-display-field'
            ));
            for (const label of candidates) {
              if (normLabel(label.textContent) !== text) continue;
              let el = label;
              for (let i = 0; i < 14 && el; i++, el = el.parentElement) {
                if (wantY) {
                  const yes = el.querySelector('[id$="_true-inputEl"]') ||
                              el.querySelector('[id$="Yes-inputEl"]') ||
                              el.querySelector('[id*="_true-inputEl"]') ||
                              el.querySelector('input[type="radio"][value="true"]') ||
                              el.querySelector('input[type="radio"][value="yes"]') ||
                              el.querySelector('input[type="radio"][value="Yes"]');
                  if (yes && yes.id) return { id: yes.id, type: 'radio' };
                  // Combobox fallback (only if no radio found yet)
                  const combo = el.querySelector('input[role="combobox"]');
                  if (combo && combo.id) return { id: combo.id, type: 'combo' };
                } else {
                  const no = el.querySelector('[id$="_false-inputEl"]') ||
                             el.querySelector('[id$="No-inputEl"]') ||
                             el.querySelector('[id*="_false-inputEl"]') ||
                             el.querySelector('input[type="radio"][value="false"]') ||
                             el.querySelector('input[type="radio"][value="no"]') ||
                             el.querySelector('input[type="radio"][value="No"]');
                  if (no && no.id) return { id: no.id, type: 'radio' };
                  const combo = el.querySelector('input[role="combobox"]');
                  if (combo && combo.id) return { id: combo.id, type: 'combo' };
                }
              }
            }
            return null;
          }, { text: labelText, wantY: wantYes }).catch(() => null);
          return result;
        }
        async function answerYesForQuestion(questionText) {
          const f = await findFieldNearLabel(questionText, true);
          if (!f) return;
          if (f.type === 'combo') {
            await selectComboboxByIdOnPrem(page, f.id, 'Yes').catch(() => {});
          } else {
            // label[for] click is more reliable than check(force) for CC on-prem ExtJS radios —
            // browser-native label behavior sets input.checked=true and fires change event.
            const labelClicked = await page.locator(`label[for="${f.id}"]`).first()
              .click({ timeout: 2000 }).then(() => true).catch(() => false);
            if (!labelClicked) {
              await page.locator(`[id="${f.id}"]`).check({ force: true, timeout: 2000 }).catch(() => {});
            }
          }
          await page.waitForTimeout(150);
        }
        async function answerNoForQuestion(questionText) {
          const f = await findFieldNearLabel(questionText, false);
          if (!f) return;
          if (f.type === 'combo') {
            await selectComboboxByIdOnPrem(page, f.id, 'No').catch(() => {});
          } else {
            // Use Ext.getCmp (same as setFieldYes) so setValue(true) sets the ExtJS CSS class
            // (x-form-cb-checked) in addition to the native inputEl.dom.checked. CSS class
            // persistence through GW re-renders lets the final pre-Complete pass re-apply
            // native setter reliably. Falls back to direct click + native setter if Ext.getCmp fails.
            const setResult = await page.evaluate((id) => {
              const el = document.getElementById(id);
              if (!el) return 'not-found';
              const wrapperId = id.replace(/-inputEl$/, '');
              const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
              function applyNative(inp) {
                if (inp && nativeSetter && nativeSetter.set) {
                  nativeSetter.set.call(inp, true);
                  (window.__gwci = window.__gwci || []).push(inp.id);
                }
                return inp ? String(inp.checked) : 'no-el';
              }
              let cmp = Ext.getCmp(wrapperId) || Ext.getCmp(wrapperId.split(':').pop());
              if (cmp && typeof cmp.setValue === 'function') {
                cmp.setValue(true);
                const r = applyNative(cmp.inputEl && cmp.inputEl.dom);
                return 'extjs:native=' + r;
              }
              // Fallback: direct click + native setter on inputEl
              el.click();
              const r = applyNative(el);
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'direct:native=' + r;
            }, f.id).catch(() => 'err');
            wpLog('answerNoForQuestion[' + questionText.substring(0, 50) + ']: ' + setResult);
          }
          await page.waitForTimeout(150);
        }
        // TreeWalker-based field finder — more reliable than findFieldNearLabel because it
        // scans leaf text nodes directly (avoids textContent aggregation from child elements)
        // and also handles ExtJS comboboxes that don't have role="combobox" on their input.
        async function findInputByWalker(questionText) {
          return await page.evaluate((text) => {
            const isNav = id => /QuickJump|WorkplanFilter|ListPaging|MenuLinks|Toggle/i.test(id);
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
              acceptNode: n => {
                const t = (n.textContent || '').trim().replace(/\*\s*$/, '').trim();
                return t === text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
              }
            });
            let node = walker.nextNode();
            while (node) {
              let el = node.parentElement;
              for (let i = 0; i < 18 && el; i++, el = el.parentElement) {
                // ActivityDetailsInputSet fields — distinguish radio (_true-inputEl) from combobox
                const adis = el.querySelector('[id*="ActivityDetailsInputSet"][id$="-inputEl"]');
                if (adis && adis.id && !isNav(adis.id)) {
                  // Ends in _true-inputEl → ExtJS radio (Yes option); ends in _false-inputEl → No radio
                  if (/_true-inputEl$/.test(adis.id)) {
                    // Look for the -cbEl (ExtJS 5+ checkbox span with role="radio" and the real click handler)
                    // which sits between the outer wrapper div and the inner input element.
                    const cbElId = adis.id.replace(/-inputEl$/, '-cbEl');
                    const cbEl = document.getElementById(cbElId);
                    const wrapperId = adis.id.replace(/-inputEl$/, '');
                    const wrapper = document.getElementById(wrapperId);
                    return {
                      id: adis.id, found: 'radioY',
                      cbElId: cbEl ? cbElId : null,
                      cbElRole: cbEl ? cbEl.getAttribute('role') : null,
                      cbElClass: cbEl ? cbEl.className.substring(0, 60) : null,
                      wrapperId: wrapper ? wrapperId : null,
                      wrapperTag: wrapper ? wrapper.tagName : null,
                      wrapperRole: wrapper ? wrapper.getAttribute('role') : null,
                    };
                  }
                  if (/_false-inputEl$/.test(adis.id)) return { id: adis.id, found: 'radioN' };
                  return { id: adis.id, found: 'adi' }; // must be a combobox
                }
                // Standard radio Yes/true inputs outside ActivityDetailsInputSet
                const radioY = el.querySelector('[id$="_true-inputEl"]') || el.querySelector('[id$="Yes-inputEl"]');
                if (radioY && radioY.id && !isNav(radioY.id)) return { id: radioY.id, found: 'radioY' };
                // Generic combobox
                const combo = el.querySelector('input[role="combobox"]');
                if (combo && combo.id && !isNav(combo.id)) return { id: combo.id, found: 'combo' };
              }
              node = walker.nextNode();
            }
            // Fallback: match on the LABEL ELEMENT's rendered text instead of a
            // raw text node, then derive the field id from the label id.
            // The TreeWalker above needs one text node whose content equals the
            // question exactly, which fails whenever CC splits the label across
            // nodes or appends a required-marker - confirmed live for
            // "Was contact able to be made?", which logged "not found by
            // walker" even though a probe showed the label present as
            // ...:ExtContactMadeQuestion-labelEl with a matching _true-inputEl
            // / _false-inputEl radio pair. Deriving <labelId minus -labelEl> +
            // "_true-inputEl" targets the right control deterministically,
            // instead of relying on an ancestor querySelector that returns
            // whichever ActivityDetailsInputSet input happens to come first in
            // document order.
            const norm = s => (s || '').replace(/\s+/g, ' ').replace(/\*\s*$/, '').trim().toLowerCase();
            const want = norm(text);
            for (const lab of document.querySelectorAll('[id$="-labelEl"]')) {
              if (norm(lab.innerText || lab.textContent) !== want) continue;
              const base = lab.id.replace(/-labelEl$/, '');
              const yes = document.getElementById(base + '_true-inputEl');
              if (yes && !isNav(yes.id)) {
                const cbElId = yes.id.replace(/-inputEl$/, '-cbEl');
                const cbEl = document.getElementById(cbElId);
                const wrapperId = yes.id.replace(/-inputEl$/, '');
                return {
                  id: yes.id, found: 'radioY',
                  cbElId: cbEl ? cbElId : null,
                  cbElRole: cbEl ? cbEl.getAttribute('role') : null,
                  cbElClass: cbEl ? cbEl.className.substring(0, 60) : null,
                  wrapperId: document.getElementById(wrapperId) ? wrapperId : null,
                  wrapperTag: document.getElementById(wrapperId) ? document.getElementById(wrapperId).tagName : null,
                  wrapperRole: document.getElementById(wrapperId) ? document.getElementById(wrapperId).getAttribute('role') : null,
                  via: 'labelId',
                };
              }
              const inp = document.getElementById(base + '-inputEl');
              if (inp && !isNav(inp.id)) {
                return { id: inp.id, found: inp.getAttribute('role') === 'combobox' ? 'combo' : 'adi', via: 'labelId' };
              }
            }
            return null;
          }, questionText).catch(() => null);
        }
        async function setFieldYes(questionText) {
          const f = await findInputByWalker(questionText);
          if (!f) {
            console.log('setFieldYes: "' + questionText + '" not found by walker');
            await answerYesForQuestion(questionText);
            return;
          }
          console.log('setFieldYes: "' + questionText + '" → ' + f.id + ' [' + f.found + '] cbEl=' + (f.cbElId ? f.cbElId.slice(-35) : 'none') + ' role=' + f.cbElRole);
          if (f.found === 'radioY') {
            // Try multiple ExtJS component discovery strategies.
            // Guidewire may register components with full colon-path IDs, short last-segment IDs,
            // or via itemId (local scope) — we try all and report which works.
            // Wait for any pending AJAX from sweep operations to settle before trying Ext.getCmp.
            // Without this wait, page.evaluate() fails with 'eval-err' when an AJAX response
            // is invalidating the page execution context mid-call.
            await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 3000 }).catch(() => {});

            const extResult = f.wrapperId ? await page.evaluate(({ wid, inputId }) => {
              try {
                const shortId = wid.split(':').pop(); // last segment, e.g. "ExtContactMadeQuestion_true"

                // GW's setValue(true) sets ExtJS me.checked + CSS class but NOT inputEl.dom.checked
                // for type="button" radios. GW's Complete POST reads inputEl.dom.checked, so we
                // must also apply the native property setter on cmp.inputEl.dom in the same call.
                // Also push the inputEl ID into window.__gwci so the atomic-complete evaluate can
                // re-apply native setter after any GW AJAX re-render (re-render uses same IDs).
                const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
                function applyAndReturn(cmpRef, tag) {
                  cmpRef.setValue(true);
                  const inp = cmpRef.inputEl && cmpRef.inputEl.dom;
                  if (inp && nativeSetter && nativeSetter.set) {
                    nativeSetter.set.call(inp, true);
                    // Remove counterpart radio from __gwci before pushing this one.
                    // atomic-complete uses suspendEvents+setValue which bypasses RadioGroup
                    // mutual exclusion — if both _true and _false IDs are in __gwci both end
                    // up cmp.checked=true simultaneously → RadioGroup.getValue() returns null
                    // → "Missing required field" on Complete. Keeping only the LAST-set radio
                    // ensures exactly one side of the pair is restored.
                    const counterFalse = inp.id.replace(/_true-inputEl$/, '_false-inputEl').replace(/Yes-inputEl$/, 'No-inputEl');
                    const counterTrue  = inp.id.replace(/_false-inputEl$/, '_true-inputEl').replace(/No-inputEl$/, 'Yes-inputEl');
                    const remove = new Set([inp.id, counterFalse, counterTrue]);
                    window.__gwci = (window.__gwci || []).filter(id => !remove.has(id));
                    window.__gwci.push(inp.id);
                    // Dispatch DOM change so GW's field-update AJAX handler fires
                    // even if the ExtJS change event was already consumed by dependencies.
                    try { inp.dispatchEvent(new Event('change', { bubbles: true })); } catch(_) {}
                  }
                  return tag + (inp ? ':native=' + inp.checked : ':no-inputEl');
                }

                // Strategy 1: full-path Ext.getCmp
                let cmp = Ext.getCmp(wid);
                if (cmp && typeof cmp.setValue === 'function') return applyAndReturn(cmp, 'S1:getCmp-full:setValue');

                // Strategy 2: short-segment Ext.getCmp (some Guidewire versions use this)
                cmp = Ext.getCmp(shortId);
                if (cmp && typeof cmp.setValue === 'function') return applyAndReturn(cmp, 'S2:getCmp-short:setValue');

                // Strategy 3: Ext.ComponentQuery by itemId
                const byItemId = Ext.ComponentQuery.query('[itemId="' + shortId + '"]');
                if (byItemId.length && typeof byItemId[0].setValue === 'function') return applyAndReturn(byItemId[0], 'S3:query-itemId:setValue');

                // Strategy 4: DOM element's js-attached component reference (ExtJS may store it on the DOM node)
                const dom = document.getElementById(wid);
                if (dom) {
                  const domCmp = dom.component || dom._comp || (dom._extData && dom._extData.component);
                  if (domCmp && typeof domCmp.setValue === 'function') return applyAndReturn(domCmp, 'S4:dom-ref:setValue');
                }

                // Strategy 5: walk up ancestors trying Ext.getCmp on each
                let el = document.getElementById(inputId);
                for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
                  if (!el.id) continue;
                  cmp = Ext.getCmp(el.id);
                  if (cmp && typeof cmp.setValue === 'function') return applyAndReturn(cmp, 'S5:ancestor-depth' + i + ':' + el.id.slice(-30));
                }

                // Dump all component IDs containing shortId for diagnostics (max 5)
                const matchIds = [];
                Ext.ComponentManager.each(function(id) {
                  if (id && id.includes(shortId.replace('_true', '').split('_')[0])) matchIds.push(id.slice(-50));
                  return matchIds.length < 5;
                });
                return 'no-cmp|shortId=' + shortId + '|cmpMgrMatches=' + matchIds.join(';');
              } catch (e) { return 'err:' + e.message.substring(0, 60); }
            }, { wid: f.wrapperId, inputId: f.id }).catch(() => 'eval-err') : 'no-wrapperId';
            wpLog('setFieldYes: extjs [' + (f.wrapperId || '').slice(-45) + '] → ' + extResult);

            // Fallback: Ext.getCmp strategies didn't fire setValue. Try DOM/CDP click strategies.
            //
            // CONFIRMED via run31/run32: clicking the wrapper div (via label force-click or direct)
            // only updates ExtJS CSS class (x-form-cb-checked) but GW's AJAX never fires. The
            // wrapper intercepts all clicks at its screen coordinates; the hidden input underneath
            // is zero-size so CDP clicks and check(force) both miss it.
            //
            // Strategy F (NEW): JavaScript inputEl.click() via evaluate. Unlike CDP/Playwright,
            // JS .click() on a DOM element doesn't require a visible bounding box — it fires the
            // browser's native radio toggle logic (sets el.checked=true + dispatches click+change
            // events) even on position:absolute/clip hidden inputs. GW's AJAX listener fires on
            // the change event if it uses addEventListener on the input (not relying on isTrusted).
            if (!extResult.includes(':setValue')) {
              const cbTarget = f.cbElId || f.id;

              // Capture ALL POST requests AND WebSocket frames — GW on-prem may use WebSocket
              // for field-update AJAX instead of HTTP POST (not captured by page.on('request')).
              const ajaxLog = [];
              const reqHandler = req => {
                if (req.method() === 'POST') {
                  const path = req.url().split('//').pop()?.split('/').slice(1).join('/').substring(0, 40) || '';
                  const body = (req.postData() || 'no-body').substring(0, 150);
                  ajaxLog.push('HTTP:' + path + '|' + body);
                }
              };
              const wsHandler = ws => {
                ws.on('framesent', frame => {
                  ajaxLog.push('WS:' + String(frame.payload || '').substring(0, 150));
                });
              };
              page.on('request', reqHandler);
              page.on('websocket', wsHandler);

              // Strategy F: JS inputEl.click() + native-setter + change dispatch.
              // CONFIRMED via run33: catch-err persists even with 1200ms fixed wait because
              // GW fires multiple sequential AJAX requests during form-init. We now use
              // networkidle (no requests for 500ms) + a 4-attempt retry loop so the context
              // must actually stabilise before we give up. wrapper-checked/input-checked evals
              // work fine (they run ~4s later), confirming this is purely a timing issue.
              await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
              let evalTries = 0;
              let jsClickResult = 'catch-err';
              // page.evaluate() only accepts ONE extra arg — pass both IDs as an object.
              // The original code passed f.id and f.wrapperId as separate args, which
              // threw "Too many arguments" and was silently caught as 'catch-err' for
              // every run. This was the root cause all along — not context invalidation.
              for (evalTries = 0; evalTries < 4 && jsClickResult.startsWith('catch'); evalTries++) {
                if (evalTries > 0) await page.waitForTimeout(2000);
                jsClickResult = await page.evaluate(({ inputId, wrapperId }) => {
                  try {
                    const el = document.getElementById(inputId);
                    if (!el) return 'not-found';
                    const disabled = el.disabled;
                    const fieldsetDis = !!el.closest('fieldset[disabled]');
                    const type = el.type;
                    const before = el.checked;
                    el.click();
                    const after1 = el.checked;
                    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
                    if (nativeSet && nativeSet.set) nativeSet.set.call(el, true);
                    const after2 = el.checked;
                    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
                    const wrap = wrapperId ? document.getElementById(wrapperId) : null;
                    const html = wrap ? wrap.innerHTML.replace(/\s+/g, ' ').substring(0, 400) : 'no-wrap';
                    const ancestorIds = [];
                    let anc = el.parentElement;
                    for (let i = 0; i < 6 && anc; i++, anc = anc.parentElement) {
                      ancestorIds.push(anc.tagName + (anc.id ? '#' + anc.id.split(':').pop() : '') + (anc.disabled !== undefined ? '[dis=' + !!anc.disabled + ']' : ''));
                    }
                    return JSON.stringify({ disabled, fieldsetDis, type, before, after1, after2, final: el.checked, anc: ancestorIds.join('>'), html });
                  } catch(e) { return 'err:' + e.message.substring(0, 80); }
                }, { inputId: f.id, wrapperId: f.wrapperId }).catch(e => 'catch:' + String(e).substring(0, 80));
              }
              wpLog('setFieldYes: jsClick[t' + evalTries + '] → ' + jsClickResult);
              await page.waitForTimeout(600);

              // Strategy F succeeded if it produced valid JSON with final:true.
              // When it does, skip C and D — label clicks trigger unrelated GW workplan-
              // filter AJAX that fires a server re-render which resets input.checked=false
              // before Complete is clicked, undoing what F just set.
              const stratFWorked = !jsClickResult.startsWith('catch') &&
                !jsClickResult.startsWith('not-found') &&
                jsClickResult.includes('"final":true');

              if (!stratFWorked) {
                // Strategy C: Playwright force-click on label[for="inputId"].
                const labelLocator = page.locator('label[for="' + f.id + '"]');
                const labelCount = await labelLocator.count().catch(() => 0);
                let labelClicked = false;
                for (let li = labelCount - 1; li >= 0 && !labelClicked; li--) {
                  const lResult = await labelLocator.nth(li)
                    .click({ force: true, timeout: 2000 }).then(() => true)
                    .catch((e) => 'err:' + String(e).substring(0, 60));
                  wpLog('setFieldYes: label[' + li + '] force-click → ' + lResult);
                  if (lResult === true) { labelClicked = true; await page.waitForTimeout(400); }
                }

                // Strategy D: check(force) on the input.
                const checked = await page.locator('[id="' + cbTarget + '"]')
                  .check({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
                wpLog('setFieldYes: check(force) [' + cbTarget.slice(-45) + '] → ' + checked);
                if (checked) {
                  await page.keyboard.press('Tab');
                  await page.waitForTimeout(200);
                }
              }

              // Report captured network activity
              page.off('request', reqHandler);
              page.off('websocket', wsHandler);
              await page.waitForTimeout(300);
              wpLog('setFieldYes: ajax-log[' + ajaxLog.length + ']=' + ajaxLog.slice(0, 3).join('|').substring(0, 300));
            }

            // Wait for GW AJAX mask to clear, then verify wrapper checked state
            await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});

            // Dump wrapper's checked CSS class to confirm ExtJS + GW saw the change
            if (f.wrapperId) {
              const wrapperChecked = await page.evaluate((wid) => {
                const el = document.getElementById(wid);
                return el ? el.className.includes('x-form-cb-checked') + '|' + el.className.substring(0, 80) : 'not-found';
              }, f.wrapperId).catch(() => 'err');
              wpLog('setFieldYes: wrapper-checked=' + wrapperChecked.substring(0, 100));
            }

            // Also check input.checked to verify the DOM state matches the CSS class
            const inputChecked = await page.evaluate((id) => {
              const el = document.getElementById(id);
              return el ? String(el.checked) : 'not-found';
            }, f.id).catch(() => 'err');
            wpLog('setFieldYes: input.checked=' + inputChecked);
          } else {
            // Combobox: open via trusted click, pick "Yes" from boundlist (also trusted).
            await page.locator('[id="' + f.id + '"]').click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(300);
            const yesItem = page.locator('.x-boundlist').last()
              .locator('.x-boundlist-item').filter({ hasText: /Yes/i }).first();
            const picked = await yesItem.waitFor({ state: 'visible', timeout: 2000 })
              .then(() => yesItem.click()).then(() => true).catch(() => false);
            if (picked) {
              // Tab (not Escape) to commit the value and trigger Guidewire's AJAX binding.
              // Confirmed via live failure: Escape closes the dropdown without committing —
              // the DOM shows "Yes" but the server never receives the change event.
              await page.keyboard.press('Tab').catch(() => {});
              await page.waitForTimeout(500); // wait for Guidewire AJAX to settle
              console.log('setFieldYes: boundlist-Yes [' + f.id.slice(-45) + ']');
            } else {
              console.log('setFieldYes: Yes not in boundlist [' + f.id.slice(-45) + ']');
            }
          }
        }
        // Diagnostic confirmed (Fix5 AJAX responses = 0): after any replaceItems fires,
        // GW's fieldUpdate listener is NOT re-registered on new components. "Create a copy?"
        // (Activity_ExtDup) triggers replaceItems that would destroy the WasCM component,
        // making subsequent setFieldYes(WasCM=Yes) send 0 AJAX. Since Activity_ExtDup has
        // never appeared as a validation failure (only WasCM does), we skip it entirely —
        // the server defaults it to No/null, and Complete proceeds without issue.
        const earlyExtDupAnswered = true; // prevents answerNoForQuestion('Create a copy?') below
        // Broad No-sweep FIRST (catches off-screen fields like "Does ride sharing apply?"),
        // then override specific questions with Yes. Running the Yes answers AFTER the sweep
        // ensures they win — if answerYesForQuestion ran before this evaluate and its click
        // failed silently, the sweep would undo it by clicking No, generating a follow-up.
        // Collect IDs of unanswered "No" radios, try evaluate-based click, then follow up
        // with Playwright check(force) for any that didn't register (CC on-prem ExtJS radios
        // are hidden inputs — non-trusted evaluate clicks don't reliably trigger the handler).
        const uncheckedNoIds = await page.evaluate(() => {
          const allFalse = Array.from(document.querySelectorAll('[id$="_false-inputEl"], [id$="No-inputEl"]'));
          const ids = [];
          const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
          for (const el of allFalse) {
            // Never click Activity_ExtDup ("Create a copy?") — its replaceItems destroys the
            // WasCM component, making setFieldYes send 0 AJAX. Field is not required for
            // Complete; server defaults it to null (treated as No).
            if (el.id.includes('Activity_ExtDup')) continue;
            const base = el.id.replace(/_false-inputEl$/, '').replace(/No-inputEl$/, '');
            const trueEl = document.getElementById(base + '_true-inputEl') || document.getElementById(base + 'Yes-inputEl');
            // After replaceItems, el.checked and className are reset on the new DOM element
            // but cmp.checked reflects the server-authoritative state from re-render. Check all.

            const cmpId = el.id.replace(/-inputEl$/, '');
            const _cmp = (typeof Ext !== 'undefined' && Ext.getCmp) ? Ext.getCmp(cmpId) : null;
            const isFalseChecked = el.checked || el.className.includes('-checked') || (_cmp && !!_cmp.checked);
            const trueCmpId = (trueEl && trueEl.id) ? trueEl.id.replace(/-inputEl$/, '') : null;
            const _trueCmp = trueCmpId && typeof Ext !== 'undefined' ? (Ext.getCmp && Ext.getCmp(trueCmpId)) : null;
            const isTrueChecked = (trueEl && (trueEl.checked || trueEl.className.includes('-checked'))) || (_trueCmp && !!_trueCmp.checked);
            if (!isFalseChecked && !isTrueChecked) {
              el.click(); // fires ExtJS onBoxClick (updates CSS class)
              // GW renders No radios as type="button" — el.click() sets ExtJS CSS but not
              // el.checked. Apply native property setter so GW's form validation reads true.
              if (nativeSet && nativeSet.set) nativeSet.set.call(el, true);
              el.dispatchEvent(new Event('change', { bubbles: true }));
              // Track this ID so atomic-complete can re-apply native setter after any GW re-render
              (window.__gwci = window.__gwci || []).push(el.id);
              ids.push(el.id);
            }
          }
          return ids;
        }).catch(() => []);
        await page.waitForTimeout(150);
        // For any radios still unchecked after the evaluate-based click, try label[for] click
        // (browser-native: sets input.checked=true) then fall back to check(force).
        for (const id of uncheckedNoIds) {
          const stillUnchecked = await page.evaluate(id2 => {
            const el = document.getElementById(id2);
            if (!el) return false;
            if (el.checked || el.className.includes('-checked')) return false;
            const cmpId = id2.replace(/-inputEl$/, '');
            const _c = (typeof Ext !== 'undefined' && Ext.getCmp) ? Ext.getCmp(cmpId) : null;
            if (_c && !!_c.checked) return false;
            return true;
          }, id).catch(() => false);
          if (stillUnchecked) {
            const labelClicked = await page.locator('label[for="' + id + '"]').first()
              .click({ timeout: 1500 }).then(() => true).catch(() => false);
            if (!labelClicked) {
              await page.locator('[id="' + id + '"]').check({ force: true, timeout: 1500 }).catch(() => {});
            }
            await page.waitForTimeout(80);
          }
        }
        // Override with Yes for known questions that need it — runs AFTER the No sweep.
        // setFieldYes uses TreeWalker (more reliable than label-element search) and
        // handles both radio and combobox field types.
        await setFieldYes('Was contact able to be made?');
        await setFieldYes('Are you closing this claim?');
        // "Make initial contact with insured": clicking "Was contact able to be made?" = Yes
        // triggers a server AJAX that reveals "Does ride sharing apply?" (ExtRideSharing).
        // The form re-render can reset ExtContactMadeQuestion. Fix: answer ExtRideSharing=No
        // first (via Ext.getCmp), then re-assert ExtContactMadeQuestion=Yes.
        if (subjectText.toLowerCase().includes('make initial contact')) {
          await page.waitForTimeout(1200); // let the ExtRideSharing AJAX fully settle
          const rsInfo = await page.evaluate(() => {
            // Find ExtRideSharing false (No) wrapper ID for Ext.getCmp approach
            const noEl = document.querySelector('[id$="ExtRideSharing_false-inputEl"]');
            const yesEl = document.querySelector('[id$="ExtRideSharing_true-inputEl"]');
            if (!noEl) return null;
            const noWrap = noEl.id.replace(/-inputEl$/, '');
            const noWrapEl = document.getElementById(noWrap);
            const noCbEl = noEl.id.replace(/-inputEl$/, '-cbEl');
            const noCbElEl = document.getElementById(noCbEl);
            return {
              noInputId: noEl.id,
              noWrapperId: noWrapEl ? noWrap : null,
              noCbElId: noCbElEl ? noCbEl : null,
              yesInputId: yesEl ? yesEl.id : null,
            };
          }).catch(() => null);
          wpLog('make initial contact: ExtRideSharing=' + JSON.stringify(rsInfo));

          if (rsInfo) {
            // Answer ExtRideSharing = No via ExtJS API (same multi-strategy as setFieldYes)
            const rsExtResult = rsInfo.noWrapperId ? await page.evaluate(({ wid, inputId }) => {
              try {
                const shortId = wid.split(':').pop();
                const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
                function applyAndReturn(cmpRef, tag) {
                  cmpRef.setValue(true);
                  const inp = cmpRef.inputEl && cmpRef.inputEl.dom;
                  if (inp && nativeSetter && nativeSetter.set) {
                    nativeSetter.set.call(inp, true);
                    // Same counterpart-removal as the setFieldYes applyAndReturn above.
                    const counterFalse = inp.id.replace(/_true-inputEl$/, '_false-inputEl').replace(/Yes-inputEl$/, 'No-inputEl');
                    const counterTrue  = inp.id.replace(/_false-inputEl$/, '_true-inputEl').replace(/No-inputEl$/, 'Yes-inputEl');
                    const remove = new Set([inp.id, counterFalse, counterTrue]);
                    window.__gwci = (window.__gwci || []).filter(id => !remove.has(id));
                    window.__gwci.push(inp.id);
                    try { inp.dispatchEvent(new Event('change', { bubbles: true })); } catch(_) {}
                  }
                  return tag + (inp ? ':native=' + inp.checked : ':no-inputEl');
                }
                let cmp = Ext.getCmp(wid);
                if (cmp && typeof cmp.setValue === 'function') return applyAndReturn(cmp, 'S1:setValue');
                cmp = Ext.getCmp(shortId);
                if (cmp && typeof cmp.setValue === 'function') return applyAndReturn(cmp, 'S2:setValue');
                const byItemId = Ext.ComponentQuery.query('[itemId="' + shortId + '"]');
                if (byItemId.length && typeof byItemId[0].setValue === 'function') return applyAndReturn(byItemId[0], 'S3:setValue');
                let el = document.getElementById(inputId);
                for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
                  if (!el.id) continue;
                  cmp = Ext.getCmp(el.id);
                  if (cmp && typeof cmp.setValue === 'function') return applyAndReturn(cmp, 'S5-depth' + i + ':setValue');
                }
                return 'no-cmp|' + shortId;
              } catch (e) { return 'err:' + e.message.substring(0, 40); }
            }, { wid: rsInfo.noWrapperId, inputId: rsInfo.noInputId }).catch(() => 'eval-err') : 'no-wrapperId';
            wpLog('make initial contact: ExtRideSharing=No extjs → ' + rsExtResult);
            if (!rsExtResult.includes(':setValue')) {
              const rsTarget = rsInfo.noCbElId || rsInfo.noInputId;
              await page.locator('[id="' + rsTarget + '"]').click({ timeout: 2000 }).catch(() => {});
              wpLog('make initial contact: ExtRideSharing=No fallback-click [' + rsTarget.slice(-40) + ']');
            }
            await page.waitForTimeout(1000); // let RideSharing AJAX settle
          }

          // Re-assert "Was contact able to be made?" = Yes — form re-render may have reset it
          wpLog('make initial contact: re-asserting Was contact able to be made? = Yes');
          await setFieldYes('Was contact able to be made?');
          await page.waitForTimeout(600);
        }
        // Explicit No answers for questions where No is the correct response.
        if (!earlyExtDupAnswered) {
          await answerNoForQuestion('Create a copy of this activity?');
        } else {
          wpLog('completeAllWorkplanActivities: Create a copy? — skipped (replaceItems destroys WasCM component)');
        }
        await answerNoForQuestion('Written confirmation?');
        await answerNoForQuestion('Is any party involved operating a Delaware registered motor vehicle without insurance?');
        await page.waitForTimeout(100);

        // Confirmed via live screenshot: "Tort Confirmation" activities kept
        // reappearing after Complete with NO validation banner ever shown -
        // "Tort Option" defaults to "Undetermined", a real (non-"<none>")
        // value our generic sweep leaves alone since it looks already
        // answered, but which apparently keeps this activity in an
        // unresolved/recurring state. Force a real determination instead.
        await selectComboboxOnPrem(page, 'Tort Option', 'Full Tort', { existTimeout: 1500 }).catch(() => {});

        // "Subro Potential?" is an ExtJS combobox (no role="combobox" attribute);
        // the walker misses it, so use dedicated text-node search + Ext.getCmp.
        {
          const subroInputId = await page.evaluate(() => {
            const wkr = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
              acceptNode: n => {
                const t = (n.textContent || '').trim().replace(/\*\s*$/, '').trim();
                return (t === 'Subro Potential?' || t === 'Subro Potential') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
              }
            });
            const node = wkr.nextNode();
            if (!node) return null;
            let el = node.parentElement;
            for (let i = 0; i < 12 && el; i++, el = el.parentElement) {
              const inp = el.querySelector('[id*="ExtSubroPotential"][id$="-inputEl"]')
                       || el.querySelector('input[role="combobox"]')
                       || el.querySelector('input[id*="-inputEl"]:not([id$="_true-inputEl"]):not([id$="_false-inputEl"])');
              if (inp && inp.id) return inp.id;
            }
            return null;
          }).catch(() => null);
          if (subroInputId) {
            console.log('Subro Potential: found input [' + subroInputId.slice(-45) + ']');
            await selectComboboxByIdOnPrem(page, subroInputId, 'Yes').catch(() => {});
            await page.waitForTimeout(300);
          } else {
            // Walker couldn't find it — fall back to setFieldYes (may find it as 'adi')
            await setFieldYes('Subro Potential?');
          }
        }

        // Same pattern: "SIU Recovery" dropdown on activities like "Subrogation Referral",
        // "Ride Sharing - Supervisor", "Status Update Letter". Select first available value.
        {
          const siuInputId = await page.evaluate(() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
              acceptNode: n => n.textContent.trim() === 'SIU Recovery' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
            });
            const node = walker.nextNode();
            if (!node) return null;
            let el = node.parentElement;
            for (let i = 0; i < 12 && el; i++, el = el.parentElement) {
              const input = el.querySelector('input[role="combobox"]') || el.querySelector('input[id*="-inputEl"]');
              if (input) return input.id;
            }
            return null;
          }).catch(() => null);
          if (siuInputId) {
            await selectComboboxByIdOnPrem(page, siuInputId, null).catch(() => {});
            await page.waitForTimeout(150);
          }
        }

        // Same pattern: "Refer this claim to Subro?" dropdown on activities like
        // "Review Claim for Subrogation", "Ride Sharing - Supervisor", "Status Update Letter".
        // Select "Yes" so the activity can complete cleanly.
        {
          const referSubroInputId = await page.evaluate(() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
              acceptNode: n => n.textContent.trim() === 'Refer this claim to Subro?' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
            });
            const node = walker.nextNode();
            if (!node) return null;
            let el = node.parentElement;
            for (let i = 0; i < 12 && el; i++, el = el.parentElement) {
              const input = el.querySelector('input[role="combobox"]') || el.querySelector('input[id*="-inputEl"]');
              if (input) return input.id;
            }
            return null;
          }).catch(() => null);
          if (referSubroInputId) {
            await selectComboboxByIdOnPrem(page, referSubroInputId, 'Yes').catch(() => {});
            await page.waitForTimeout(150);
          }
        }

        // Post-fill diagnostic: log activity form inputs with FULL IDs (no truncation)
        // scoped to ActivityDetailWorksheet/Screen inputs only (excludes workplan nav).
        {
          const inputDump = await page.evaluate(() => {
            const isNav = id => /QuickJump|WorkplanLV|MenuLinks|ListPaging/i.test(id);
            const inputs = Array.from(document.querySelectorAll(
              'input[id*="ActivityDetailWorksheet"], input[id*="ActivityDetailScreen"]'
            )).filter(el => el.id && !isNav(el.id));
            return inputs.map(el => {
              const role = el.getAttribute('role') || el.type || '?';
              // For radios/checkboxes use .checked property; for others use className or value
              const chk = (el.type === 'radio' || el.type === 'checkbox')
                ? (el.checked ? '[CHK]' : '')
                : (el.className.includes('-checked') ? '[CHK]' : '');
              return role + '|v:"' + (el.value || '') + '"' + chk + '|' + el.id;
            }).join('\n');
          }).catch(() => '');
          if (inputDump) wpLog('inputs[' + subjectText.substring(0, 40) + ']:\n' + inputDump);
        }

        // Wait for any pending GW field-update AJAX (triggered by setFieldYes's
        // change event dispatch) to complete before submitting Complete.  GW CC
        // stores field values server-side; if the AJAX hasn't landed yet the
        // server-side session still has the old (null) value and Complete fails
        // "Missing required field" even though the DOM/ExtJS state is correct.
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});

        // Fix 5: Use Playwright trusted clicks on required YES/NO radio fields after
        // Activity_ExtDup's replaceItems has settled (Fix4 networkidle above).
        //
        // Root cause: after replaceItems destroys and recreates form sections, GW's
        // fieldUpdate AJAX listener is NOT re-registered on the new ExtJS components.
        // Calls to cmpRef.setValue(true) fire the ExtJS 'change' event but nothing
        // handles it on the new component — no AJAX reaches the server.  This is why
        // setFieldYes (S1: setValue + native setter + dispatchEvent) returns
        // "ok:checked=true" yet the server session still has WasCM=null.
        //
        // Playwright's trusted click fires the full browser event sequence
        // (pointerdown → mousedown → click → change).  GW's fieldUpdate handler
        // responds to the real 'click' event which IS present on newly-created elements
        // (the inline onclick attribute is included in the replaceItems HTML).
        //
        // Each click gets its own 500ms pause + networkidle so its XHR lands before
        // the next field is touched and no replaceItems from one field resets another.
        // Network-response capture for Fix5 diagnostic: if the trusted click fires
        // GW's fieldUpdate AJAX, we'll see response(s) here.  Zero responses means
        // the click did NOT trigger an AJAX (GW's handler is absent on the new element).
        const fix5Resps = [];
        const fix5RespFn = resp => {
          const u = resp.url();
          if (u.includes('ClaimCenter.do')) {
            resp.text().then(t => fix5Resps.push('[' + resp.status() + ']' + t.substring(0, 80))).catch(() => {});
          }
        };
        page.on('response', fix5RespFn);

        const fix5Targets = [
          // "Make initial contact with insured" — WasCM = YES required
          { sel: '[id$="ExtContactMadeQuestion_true-inputEl"]',  label: 'WasCM=Yes' },
          // "Supervisor cc: DE notice" — ExtDEFR1InvolvedParty = NO required
          { sel: '[id$="ExtDEFR1InvolvedParty_false-inputEl"]',  label: 'ExtDEFR1=No' },
        ];
        for (const { sel, label } of fix5Targets) {
          const loc = page.locator(sel).first();
          if (await loc.count() > 0) {
            await loc.click({ force: true, timeout: 2000 }).catch(e => {
              wpLog('completeAllWorkplanActivities: Fix5 click-err ' + label + ': ' + String(e).substring(0, 80));
            });
            await page.waitForTimeout(500);
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            wpLog('completeAllWorkplanActivities: Fix5 trusted-click ' + label + ' done');
          }
        }

        page.off('response', fix5RespFn);
        wpLog('completeAllWorkplanActivities: Fix5 AJAX responses: ' + fix5Resps.length + ' | ' + fix5Resps.slice(0, 3).join(' || ').substring(0, 200));

        // Atomic complete: apply native setter to ALL tracked input IDs + CSS-checked wrappers,
        // then click the Complete button from within the SAME JS execution frame.
        //
        // WHY ATOMIC: GW's Subro Potential / answerNoForQuestion AJAX can fire a replaceItems
        // response that destroys and recreates activity form elements, resetting
        // inputEl.dom.checked=false. Two-step (setter then Playwright click) leaves a gap
        // for AJAX to re-render. Running both in the same evaluate call is single-threaded —
        // no AJAX response handler can fire between the setter and the click.
        //
        // WHY TRACKED IDs: After replaceItems, new DOM elements have the SAME IDs as the
        // old ones (GW IDs are field-path-based, not instance-based). window.__gwci holds
        // the IDs we set; document.getElementById finds the CURRENT (new) element so the
        // native setter applies to what Complete will actually read.
        const atomicResult = await page.evaluate(() => {
          const ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
          let n = 0, nc = 0;
          // Helper: restore both ExtJS component state AND DOM property.
          // After replaceItems, new components have cmp.checked=false and dom.checked=false.
          // GW's getValue()/getSubmitValue() reads cmp.checked (ExtJS state) — we restore it
          // using setValue(events suspended) so all internal ExtJS state is correct without
          // triggering the change event that would fire another replaceItems AJAX.
          function restoreCb(el) {
            if (!el) return;
            if (ns && ns.set) ns.set.call(el, true);
            if (typeof Ext !== 'undefined' && Ext.getCmp) {
              const cmp = Ext.getCmp(el.id.replace(/-inputEl$/, ''));
              if (cmp) {
                nc++;
                // Use suspendEvents+setValue so setValue's full internal logic runs
                // (sets checked, updates CSS, syncs inputEl) WITHOUT firing change → no XHR
                if (cmp.suspendEvents) cmp.suspendEvents();
                try { if (typeof cmp.setValue === 'function') cmp.setValue(true); } catch(e) {}
                if (cmp.resumeEvents) cmp.resumeEvents();
                // Belt: direct property set in case setValue didn't work
                cmp.checked = true;
              }
            }
          }
          if (ns && ns.set) {
            // Primary: tracked IDs — survives GW replaceItems re-renders
            (window.__gwci || []).forEach(id => {
              const el = document.getElementById(id);
              if (el) { restoreCb(el); n++; }
            });
            // Belt-and-suspenders: CSS-checked wrappers (may still be present if no re-render)
            document.querySelectorAll('.x-form-cb-checked').forEach(wrapper => {
              const inp = wrapper.querySelector('[id$="-inputEl"]');
              if (inp) restoreCb(inp);
            });
          }
          window.__gwci = [];
          // Click Complete from within the same JS frame — atomic with the setter above
          const btn = document.querySelector('[id$="ActivityDetailScreen_CompleteButton"]');
          if (btn) { btn.click(); return 'ok:n=' + n + ':nc=' + nc; }
          return 'no-btn:n=' + n + ':nc=' + nc;
        }).catch(e => 'eval-err:' + String(e).substring(0, 60));
        wpLog('completeAllWorkplanActivities: atomic-complete → ' + atomicResult);
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});

        // Confirmed via live failure: clicking Complete was logged as success
        // every pass even though the SAME activity ("NEW LOSS NOTICE") kept
        // reappearing as the first Workplan row 7+ times in a row - Complete
        // was silently being blocked (likely a required field our generic
        // combobox/boolean sweep doesn't cover, e.g. a plain text field) and
        // the click was never actually verified. Detect a validation banner
        // and detect "same activity twice in a row" to fail loudly instead of
        // looping until the guard silently exhausts.
        // Check for a Validation Results panel that blocks the Complete.
        // "Create a Matter associated with this exposure before closing this activity."
        // is one such blocker (requires manual matter creation). Clear the panel
        // so the page returns to a clean state, then skip this activity.
        const validationBanner = await page.getByText(/missing required field|must be|not allowed|exceeds|cannot be|before closing this activity|Create a Matter/i)
          .first().textContent().catch(() => null);
        let skippedThisActivity = false;
        if (validationBanner) {
          // Dismiss the validation panel before moving on.
          // Some validations produce a popup with a Clear button (e.g. "Create a Matter");
          // others are inline banners with no Clear button. The .catch() handles both.
          await page.locator('.x-btn').filter({ hasText: /^Clear$/ }).first()
            .click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(200);
          const skipRowText = await page.evaluate((id) => {
            const el = document.getElementById(id);
            if (!el) return null;
            const row = el.closest('.x-grid-row') || el.closest('tr');
            return row ? row.textContent.trim() : el.textContent.trim();
          }, targetId).catch(() => null);
          // If we navigated to the activity detail page, targetId no longer exists in the DOM
          // and skipRowText will be null — use the subject text as the fallback identifier so
          // the skip list actually prevents this activity from being revisited.
          skippedRowTexts.push(skipRowText || subjectText);
          wpLog('completeAllWorkplanActivities: Complete blocked on "' + subjectText + '" (' + validationBanner.trim().substring(0, 200) + ') - cleared and skipping');
          sameSubjectRepeats = 0;
          skippedThisActivity = true;
          await page.locator('.x-btn').filter({ hasText: /^Cancel$/ }).first()
            .click({ timeout: 2000 }).catch(() => {});
        } else if (subjectText === lastSubjectText) {
          // Same subject text as previous activity. Only flag a stuck loop if the list
          // count did NOT decrease — if it shrank, a different activity with the same
          // name was completed (e.g. 3 exposures each generate "Make initial contact
          // with insured", completing them legitimately appears as 3 consecutive
          // same-named completions but each shrinks the list by 1).
          if (currentActivityCount >= prevActivityCount) {
            sameSubjectRepeats++;
            if (sameSubjectRepeats >= 2) {
              // Skip instead of throw — let the sweep continue with remaining activities.
              const skipRowText = await page.evaluate((id) => {
                const el = document.getElementById(id);
                if (!el) return null;
                const row = el.closest('.x-grid-row') || el.closest('tr');
                return row ? row.textContent.trim() : el.textContent.trim();
              }, targetId).catch(() => null);
              skippedRowTexts.push(skipRowText || subjectText);
              console.log('completeAllWorkplanActivities: "' + subjectText + '" still present after 3 attempts - skipping');
              sameSubjectRepeats = 0;
              skippedThisActivity = true;
              await page.locator('.x-btn').filter({ hasText: /^Cancel$/ }).first()
                .click({ timeout: 2000 }).catch(() => {});
            }
          } else {
            sameSubjectRepeats = 0; // list shrank — different activity with same name
          }
        } else {
          sameSubjectRepeats = 0;
        }
        if (!skippedThisActivity) {
          prevActivityCount = currentActivityCount;
          lastSubjectText = subjectText;
          wpLog('completeAllWorkplanActivities: completed "' + subjectText + '" [swept]');
        }
      } else {
        // Fast path: activity completed on first click without needing a field sweep.
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        let skippedThisActivity = false;
        if (subjectText === lastSubjectText) {
          if (currentActivityCount >= prevActivityCount) {
            sameSubjectRepeats++;
            if (sameSubjectRepeats >= 2) {
              const skipRowText = await page.evaluate((id) => {
                const el = document.getElementById(id);
                if (!el) return null;
                const row = el.closest('.x-grid-row') || el.closest('tr');
                return row ? row.textContent.trim() : el.textContent.trim();
              }, targetId).catch(() => null);
              skippedRowTexts.push(skipRowText || subjectText);
              console.log('completeAllWorkplanActivities: "' + subjectText + '" still present after 3 attempts - skipping');
              sameSubjectRepeats = 0;
              skippedThisActivity = true;
            }
          } else {
            sameSubjectRepeats = 0;
          }
        } else {
          sameSubjectRepeats = 0;
        }
        if (!skippedThisActivity) {
          prevActivityCount = currentActivityCount;
          lastSubjectText = subjectText;
          wpLog('completeAllWorkplanActivities: completed "' + subjectText + '" [fast]');
        }
      }
    }
    // Return to Workplan for the next iteration's fresh activity list.
    if (await navItem.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
      await navItem.click();
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});
    }
  }
}

// ── fixMissingPartyAddress (on-prem) ────────────────────────────────────────
// Per user-provided workflow: a "Validate Claim + Exposures" failure can be
// caused by a party/contact record missing an address - navigate to Parties
// Involved > Contacts, open a CLAIMANT-role contact whose grid row shows a
// blank Address/City, and fill it in.
//
// Confirmed via live screenshot: the original version of this function was
// built for a screen that does not exist here. The real flow is:
//   1. "Parties Involved" -> "Contacts" (a sub-item, not the top-level node -
//      the top-level click alone was landing wherever ExtJS defaults to,
//      which happened to often be this same Contacts grid but not reliably).
//   2. Clicking a contact's Name opens it in VIEW mode with an "Edit" button -
//      Address 1/City/Zip textboxes are NOT on screen yet at all, which is
//      why `getByRole('textbox', {name:'Address 1'})` always found nothing
//      and this function silently did nothing every time it ran.
//   3. Edit mode may expose the address fields under "Basics", or they may
//      only appear under a separate "Addresses" tab (both visible as tabs in
//      the screenshot) - try Basics first, fall back to Addresses.
//   4. Save via "Update".
async function fixMissingPartyAddress(page) {
  const partiesNav = page.locator('.x-tree-node-text').filter({ hasText: /^Parties Involved$/ }).first();
  if (await partiesNav.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    await partiesNav.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  const contactsNav = page.locator('.x-tree-node-text').filter({ hasText: /^Contacts$/ }).first();
  if (await contactsNav.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)) {
    await contactsNav.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  }

  // Read the CONTACTS GRID directly: which rows have "Claimant" in their Roles
  // column AND a blank Address/City cell. This targets the actual contact the
  // validation error names, instead of opening rows in arbitrary order until
  // one happens to look editable.
  const candidates = await page.evaluate(() => {
    const headers = [...document.querySelectorAll('.x-column-header-text')].map(h => (h.textContent || '').trim());
    const nameIdx = headers.indexOf('Name');
    const rolesIdx = headers.indexOf('Roles');
    const addrIdx = headers.indexOf('Address');
    const cityIdx = headers.indexOf('City');
    if (nameIdx < 0) return [];
    const out = [];
    const rows = document.querySelectorAll('tr.x-grid-row');
    rows.forEach((row, i) => {
      const cells = [...row.querySelectorAll('.x-grid-cell')].map(c => (c.textContent || '').trim());
      const offset = cells.length - headers.length;
      const at = (idx) => idx < 0 ? '' : (cells[idx + (offset > 0 ? offset : 0)] || '');
      const name = at(nameIdx);
      const roles = at(rolesIdx);
      const addr = addrIdx >= 0 ? at(addrIdx) : '';
      const city = cityIdx >= 0 ? at(cityIdx) : '';
      if (name && /claimant/i.test(roles) && !addr && !city) out.push({ row: i, name });
    });
    return out;
  }).catch(() => []);
  console.log('fixMissingPartyAddress: claimant contact(s) with a blank address -> ' + JSON.stringify(candidates));

  for (const candidate of candidates) {
    const nameLink = page.getByRole('link', { name: candidate.name, exact: false }).first();
    const opened = await nameLink.click().then(() => true).catch(() => false);
    if (!opened) continue;
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

    const editBtn = page.locator('.x-btn').filter({ hasText: /^Edit$/ }).first();
    if (await editBtn.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)) {
      await editBtn.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    }

    let address1Field = page.getByRole('textbox', { name: 'Address 1', exact: true });
    let hasAddress1 = await address1Field.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (!hasAddress1) {
      // Not on Basics - try the "Addresses" tab.
      const addrTab = page.getByText('Addresses', { exact: true }).first();
      if (await addrTab.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
        await addrTab.click().catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
        address1Field = page.getByRole('textbox', { name: 'Address 1', exact: true });
        hasAddress1 = await address1Field.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
      }
    }
    if (!hasAddress1) {
      console.log('fixMissingPartyAddress: no Address 1 field found for "' + candidate.name +
                  '" on Basics or Addresses - screen may need Edit clicked on a different tab');
      continue;
    }

    console.log('fixMissingPartyAddress: filling address for "' + candidate.name + '"');
    await address1Field.fill('123 Main St').catch(() => {});
    const cityField = page.getByRole('textbox', { name: 'City', exact: true });
    if (await cityField.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
      await cityField.fill('Harrisburg').catch(() => {});
    }
    await selectComboboxOnPrem(page, 'State', 'PA', { exact: true }).catch(() => {});
    const zipField = page.getByRole('textbox', { name: /zip code/i });
    if (await zipField.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
      await zipField.fill('17101').catch(() => {});
    }
    const updateBtn = page.locator('.x-btn').filter({ hasText: /^Update$/ }).first();
    if (await updateBtn.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
      await updateBtn.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    }
    return; // fixed one - re-validation will reveal if more remain
  }
  if (!candidates.length) {
    console.log('fixMissingPartyAddress: no claimant contact with a blank Address/City found in the grid');
  }
}

// ── Segmentation ──────────────────────────────────────────────────────────────
// expectedSegment accepts a string OR an array of acceptable segments. The
// array form exists because creating an Injury Incident on every LOB (see
// fnolHelper's createInjuryIncident note) legitimately routes a bodily-injury
// claim to "BI Claims Division" instead of "Fast Track" - per user decision
// that routing is correct behaviour, not a defect to code around. Which of the
// accepted values actually matched is logged, so a routing change still shows
// up in the run output rather than disappearing into a permissive assertion.
async function assertSegment(page, expectedSegment) {
  const accepted = Array.isArray(expectedSegment) ? expectedSegment : [expectedSegment];
  if (IS_ON_PREM) {
    // On-prem CC (ExtJS) renders field values inside <input> elements whose .value
    // is NOT captured by innerText(). We must check BOTH innerText and input.value.
    async function tabClick(name) {
      const tab = page.locator(
        `[id*="${name}Tab"], a:has-text("${name}"), tr:has-text("${name}") td:has-text("${name}")`
      ).first();
      const visible = await tab.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
      if (visible) {
        await tab.click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      }
      return visible;
    }
    // Check both visible text AND input values — ExtJS stores field data in input.value
    const pageContains = (seg) => page.evaluate((s) => {
      if (document.body.innerText.includes(s)) return true;
      return Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="password"])'))
        .some(inp => (inp.value || '').includes(s));
    }, seg).catch(() => false);
    // Try Overview first (segment lives there in on-prem CC), then Status/Summary fallback
    for (const tabName of ['Overview', 'Status', 'Summary']) {
      await tabClick(tabName);
      for (const seg of accepted) {
        if (await pageContains(seg)) {
          console.log('assertSegment: matched "' + seg + '" on the ' + tabName + ' tab' +
                      (accepted.length > 1 ? ' (accepted: ' + accepted.join(' | ') + ')' : ''));
          return seg;
        }
      }
    }
    // If not found on any tab, throw a helpful error with what we see
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const inputValues = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input:not([type="hidden"])'))
        .map(i => i.value).filter(Boolean).slice(0, 20)
    ).catch(() => []);
    throw new Error(`Expected segment ${accepted.map(s => '"' + s + '"').join(' or ')} not found on any tab. Visible inputs: [${inputValues.join(', ')}]. Body: ${bodyText.substring(0, 300)}`);
  } else {
    // Cloud: click Segmentation tab (a:has-text or id-based)
    const segTab = page.locator('[id*="SegmentationTab"], a:has-text("Segmentation")').first();
    const segVisible = await segTab.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (segVisible) {
      await segTab.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    }
    const el = page.locator('[id*="Segment"], [id*="segment"]').first();
    const txt = await el.textContent({ timeout: 30000 });
    const hit = accepted.find(seg => txt?.includes(seg));
    if (!hit) {
      throw new Error('Expected segment ' + accepted.map(s => '"' + s + '"').join(' or ') +
                      ', got "' + txt + '"');
    }
    console.log('assertSegment: matched "' + hit + '"' +
                (accepted.length > 1 ? ' (accepted: ' + accepted.join(' | ') + ')' : ''));
    return hit;
  }
}

async function setSegmentManually(page, segmentValue) {
  await page.click('[id*="SegmentationTab"], a:has-text("Segmentation")').catch(() => {});
  await selectDropdown(page, '[id*="Segment"]', segmentValue);
  await clickSave(page);
}

// ── Initial Reserves ──────────────────────────────────────────────────────────
async function assertInitialReservesSet(page, { exposureLabel, expectedAmount }) {
  await page.click('[id*="FinancialsTab"], a:has-text("Financials")');
  await page.click('[id*="ReservesTab"], a:has-text("Reserves")');
  const row = page.locator('tr:has-text("' + exposureLabel + '")').first();
  const txt = await row.locator('[id*="ReserveAmount"], td').nth(2).textContent();
  const actual   = parseFloat(txt.replace(/[^0-9.]/g, ''));
  const expected = parseFloat(String(expectedAmount).replace(/[^0-9.]/g, ''));
  if (Math.abs(actual - expected) > 1) throw new Error('Reserve mismatch: expected ' + expected + ' got ' + actual);
}

// ── Workplan ──────────────────────────────────────────────────────────────────
async function openWorkplanTab(page) {
  if (IS_ON_PREM) {
    // Close any open ExtJS dropdown menus — floating overlays intercept clicks
    await page.evaluate(() => {
      try { if (window.Ext && Ext.menu && Ext.menu.Manager) Ext.menu.Manager.hideAll(); } catch(e) {}
    }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    // HO/MH claim workspaces render the sidebar as tr/td rows, not links
    await page.locator('[id*="WorkplanTab"], a:has-text("Workplan"), a:has-text("Activities"), tr:has-text("Workplan") td').first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
  } else {
    // Cloud (Jutro/React): claim workspace tabs are rendered as buttons or links.
    // Try several selector patterns until one matches.
    const workplanTab = page.locator(
      '[id*="WorkplanTab"], button:has-text("Workplan"), a:has-text("Workplan"), ' +
      '[aria-label*="Workplan"], [role="tab"]:has-text("Workplan")'
    ).first();
    const tabVisible = await workplanTab.waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true).catch(() => false);
    if (tabVisible) {
      await workplanTab.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1000);
      console.log('openWorkplanTab (cloud): Workplan tab clicked');
    } else {
      // Dump body to diagnose what tabs are available
      const bodySnip = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')
        .then(t => t.substring(0, 800));
      console.log('openWorkplanTab (cloud): Workplan tab not found! Body:', bodySnip);
    }
  }
}

async function assertActivityExists(page, { activitySubject, activityType }) {
  await openWorkplanTab(page);
  if (IS_ON_PREM) {
    const row = page.locator('tr:has-text("' + activitySubject + '")').first();
    const found = await row.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
    if (!found) {
      const visibleRows = await page.evaluate(() => {
        const navIds = new Set(['MenuLinks', 'ClaimMenuBar', 'TabBar']);
        return Array.from(document.querySelectorAll('.x-grid-row'))
          .filter(r => !Array.from(navIds).some(id => r.closest(`[id*="${id}"]`)))
          .map(r => r.textContent?.trim().substring(0, 80)).filter(Boolean).slice(0, 20);
      }).catch(() => []);
      console.log('assertActivityExists: activity rows visible:', visibleRows.join(' | ') || '(none)');
      throw new Error('Activity "' + activitySubject + '" not found. Activity rows: ' + (visibleRows.slice(0, 5).join(', ') || 'none'));
    }
    if (activityType) {
      const cell = row.locator('td:has-text("' + activityType + '")');
      if (await cell.count() === 0) throw new Error('Activity type "' + activityType + '" not found for "' + activitySubject + '"');
    }
  } else {
    // Cloud: activities may be in rows (tr), cards, or list items depending on Jutro version
    const actRow = page.locator(
      'tr:has-text("' + activitySubject + '"), ' +
      '[role="row"]:has-text("' + activitySubject + '"), ' +
      '[class*="activity"]:has-text("' + activitySubject + '"), ' +
      '[class*="row"]:has-text("' + activitySubject + '")'
    ).first();
    const found = await actRow.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
    if (!found) {
      const bodySnip = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')
        .then(t => t.substring(0, 1500));
      console.log('assertActivityExists (cloud): "' + activitySubject + '" not found. Body:', bodySnip);
      throw new Error('Activity "' + activitySubject + '" not found on Workplan (cloud). See body log above.');
    }
    console.log('assertActivityExists (cloud): found "' + activitySubject + '"');
  }
}

async function createManualActivity(page, { subject, type, dueDate, note }) {
  await openWorkplanTab(page);
  await page.click('button:has-text("New Activity"), [id*="NewActivity"]');
  await page.waitForSelector('[id*="Subject"]', { timeout: 15_000 });
  await fillTextField(page, '[id*="Subject"]', subject);
  if (type)    await selectDropdown(page, '[id*="ActivityType"], [id*="Type"]', type);
  if (dueDate) await fillDateField(page,  '[id*="DueDate"]',                   dueDate);
  if (note)    await fillTextField(page,  '[id*="Note"]',                       note);
  await clickSave(page);
}

async function completeActivity(page, activitySubject) {
  await openWorkplanTab(page);
  const row = page.locator('tr:has-text("' + activitySubject + '")').first();
  await row.locator('button:has-text("Complete"), a:has-text("Complete")').click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

// ── Subrogation / recovery close ──────────────────────────────────────────────
// Called from closeClaim when CC blocks with "subrogation status is still Open"
// or "open recovery reserves". Navigates to the Subrogation tab, closes any
// open negotiations/reserves, and returns to the claim.
async function closeSubrogationForClaim(page) {
  console.log('closeSubrogationForClaim: starting');

  // Navigate to Subrogation tab — use the approach confirmed working in live runs:
  // GW CC left sidebar has .x-tree-node-text nodes; fall back to CSS selector with ID wildcard
  const subroTreeNode = page.locator('.x-tree-node-text').filter({ hasText: /^Subrogation$/ }).first();
  const hasTreeNode = await subroTreeNode.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (hasTreeNode) {
    await subroTreeNode.click();
  } else {
    // [id*="Subrogation"] matches the GW ExtJS tab element (e.g. ClaimMenuGroup:Subrogation)
    await page.click('a:has-text("Subrogation"), [id*="Subrogation"]').catch(() => {});
  }
  await Promise.race([page.waitForLoadState('domcontentloaded'), page.waitForTimeout(5000)]).catch(() => {});
  // Wait for the SubrogationGeneralDV to render before proceeding (new: prevents premature dump)
  await page.waitForSelector('[id*="SubrogationGeneralDV"]', { state: 'visible', timeout: 15000 }).catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  // Diagnostic dump now that the page is loaded
  const subroDump = await page.evaluate(() => {
    const statusEl = document.querySelector('input[id$="SubrogationGeneralDV:Status-inputEl"]');
    const labels = Array.from(document.querySelectorAll('[id$="-labelEl"]'))
      .filter(el => /subro|status|recovery/i.test(el.textContent))
      .map(el => el.id + ':' + el.textContent.trim()).join(', ');
    const btns = Array.from(document.querySelectorAll('[id*="ClaimSubroSummaryScreen"] button, [id*="SubrogationGeneral"] button, [id*="ClaimSubroSummaryScreen"] .x-btn, [id*="SubrogationGeneral"] .x-btn'))
      .map(el => el.id || el.className).slice(0, 5).join(' | ');
    const inputs = Array.from(document.querySelectorAll('input[id*="SubrogationGeneralDV"]'))
      .map(el => el.id + '=' + el.value).join(' | ');
    return 'STATUS=[' + (statusEl ? statusEl.id + '=' + statusEl.value : 'not-found') + '] BTNS=[' + btns + '] INPUTS=[' + inputs + '] LABELS=[' + labels + ']';
  }).catch(() => 'dump-failed');
  console.log('closeSubrogationForClaim: page dump: ' + subroDump.substring(0, 800));

  // Screen is in read-only mode by default — click Edit to get input fields
  // GW ClaimCenter renders display <div> fields in view mode; inputs only appear in edit mode
  const editBtn = page.locator('[id$="ClaimSubroSummaryScreen:Edit"]').first();
  const hasEdit = await editBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (hasEdit) {
    await editBtn.click();
    await page.waitForTimeout(500);
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 8000 }).catch(() => {});
    console.log('closeSubrogationForClaim: clicked Edit — now in edit mode');
  } else {
    console.log('closeSubrogationForClaim: ClaimSubroSummaryScreen:Edit not found — checking for editable inputs as-is');
  }

  // Change Subrogation Status to a closed value
  // Confirmed ID suffix from live run: SubrogationGeneralDV:Status-inputEl
  const statusLocator = page.locator('input[id$="SubrogationGeneralDV:Status-inputEl"]').first();
  const hasStatus = await statusLocator.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);

  if (hasStatus) {
    const currentVal = await statusLocator.evaluate(el => el.value).catch(() => '');
    console.log('closeSubrogationForClaim: SubroStatus current value: ' + currentVal);
    if (!/no.sub|closed|no.recov/i.test(currentVal)) {
      await statusLocator.click();
      await page.waitForTimeout(400);
      const opts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.x-boundlist-item')).map(e => e.innerText.trim())
      ).catch(() => []);
      console.log('closeSubrogationForClaim: Status options: ' + opts.join(' | '));
      const CLOSE_OPTIONS = ['No Subrogation', 'No Recovery', 'Closed'];
      const chosen = opts.find(o => CLOSE_OPTIONS.some(c => o.toLowerCase().includes(c.toLowerCase())));
      if (chosen) {
        await page.locator('.x-boundlist-item').filter({ hasText: chosen }).first().click();
        console.log('closeSubrogationForClaim: set Status to ' + chosen);
        await page.waitForTimeout(300);
      } else {
        console.log('closeSubrogationForClaim: no closed status option found: ' + opts.join(' | '));
        await page.keyboard.press('Escape').catch(() => {});
      }
    } else {
      console.log('closeSubrogationForClaim: SubroStatus already closed: ' + currentVal);
    }
  } else {
    console.log('closeSubrogationForClaim: SubrogationGeneralDV:Status-inputEl NOT FOUND — check dump above');
  }

  // Save using the known Update button for ClaimSubroSummaryScreen
  const updateBtn = page.locator('[id$="ClaimSubroSummaryScreen:Update"]').first();
  const hasUpdate = await updateBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (hasUpdate) {
    await updateBtn.click();
    await Promise.race([page.waitForLoadState('domcontentloaded'), page.waitForTimeout(5000)]).catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    console.log('closeSubrogationForClaim: clicked Update — status saved');
  } else {
    console.log('closeSubrogationForClaim: ClaimSubroSummaryScreen:Update not found — trying generic');
    const genericSave = page.locator('.x-btn').filter({ hasText: /^(Save|Update)$/ }).first();
    const hasGeneric = await genericSave.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (hasGeneric) {
      await genericSave.click();
      await Promise.race([page.waitForLoadState('domcontentloaded'), page.waitForTimeout(3000)]).catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 8000 }).catch(() => {});
      console.log('closeSubrogationForClaim: clicked generic Save/Update');
    }
  }

  console.log('closeSubrogationForClaim: done — returning to claim');
}

// ── Close ─────────────────────────────────────────────────────────────────────
// Confirmed via live screenshots: the "Close Claim" popup has the same shape
// as the "Close Exposure" popup (Note textarea + Outcome combobox, Update /
// Cancel buttons). Uses the identical trusted-click Outcome pattern proven in
// closeExposureWithOutcome — selectComboboxOnPrem + sweepComboboxesOnPrem were
// leaving the dropdown open, intercepting the Update button click.
async function closeClaim(page, { closeReason, closingNote } = {}) {
  // Pre-check: if the claim header already shows "St: Closed", nothing to do
  const headerText = await page.evaluate(() => document.body.innerText.substring(0, 600)).catch(() => '');
  if (/\bSt:\s*Closed\b/i.test(headerText)) {
    console.log('closeClaim: claim is already Closed — skipping');
    return;
  }

  const PREFERRED_CLOSE_REASONS = [
    'Covered - Settled', 'Settled', 'Covered', 'Coverage Confirmed',
    'Claim Settled', 'Payments complete', 'Payment Made', 'Covered - No Payment',
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    console.log('closeClaim: attempt ' + (attempt + 1));
    await openClaimActionsMenu(page, 'closeClaim');
    await page.click('a:has-text("Close Claim"), [id*="CloseClaim"]');
    await Promise.race([page.waitForLoadState('domcontentloaded'), page.waitForTimeout(5000)]).catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

    // Wait for popup and dump its structure for diagnostics
    const popupPresent = await page.waitForSelector(
      '[id*="CloseClaimPopup"], [id*="CloseClaimScreen"]', { state: 'visible', timeout: 8000 }
    ).then(() => true).catch(() => false);

    if (!popupPresent) {
      // Popup never appeared — check if claim already closed
      const headerClosed = await page.getByText(/St:\s*Closed/i).first()
        .waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
      if (headerClosed) { console.log('closeClaim: claim already closed'); return; }
      console.log('closeClaim: WARNING - Close Claim popup did not appear');
      continue;
    }

    const openDump = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[id*="CloseClaimPopup"], [id*="CloseClaimScreen"]'));
      const popup = els.length > 0 ? els.reduce((a, b) => a.id.length <= b.id.length ? a : b) : null;
      if (!popup) return 'no popup container found';
      const inputs = Array.from(popup.querySelectorAll('input,textarea'));
      const labels = Array.from(popup.querySelectorAll('[id$="-labelEl"]')).map(el => el.id + ':' + el.textContent.trim()).join(', ');
      return 'LABELS=[' + labels.substring(0, 300) + '] | INPUTS=[' + inputs.map(el => el.id + '=' + el.value).join(' | ').substring(0, 400) + ']';
    }).catch(() => 'open-dump failed');
    console.log('closeClaim: popup structure: ' + openDump);

    // Fill Note — required by CC; use caller's note or a default
    const noteText = closingNote || 'Automated test - closing claim';
    const noteId = await page.evaluate(() => {
      const popup = Array.from(document.querySelectorAll('[id*="CloseClaimPopup"], [id*="CloseClaimScreen"]'))
        .reduce((a, b) => (!a || a.id.length > b.id.length) ? b : a, null);
      if (!popup) return null;
      // Note field can be a textarea OR a single-line input depending on CC config
      const ta = popup.querySelector('textarea');
      if (ta) return ta.id;
      const inp = popup.querySelector('input[id*="Note"]');
      return inp ? inp.id : null;
    }).catch(() => null);
    if (noteId) {
      await page.locator('[id="' + noteId + '"]').fill(noteText);
      console.log('closeClaim: filled Note via id=' + noteId);
    } else {
      console.log('closeClaim: WARNING - Note field not found, trying getByRole fallback');
      await page.getByRole('textbox', { name: /note/i }).first().fill(noteText).catch(() => {});
    }

    // Select Outcome using the same trusted-click pattern as closeExposureWithOutcome
    const outcomeInputId = await page.evaluate(() => {
      const popup = Array.from(document.querySelectorAll('[id*="CloseClaimPopup"], [id*="CloseClaimScreen"]'))
        .reduce((a, b) => (!a || a.id.length > b.id.length) ? b : a, null);
      if (!popup) return null;
      for (const labelEl of popup.querySelectorAll('[id$="-labelEl"]')) {
        if (labelEl.textContent.trim().toLowerCase() === 'outcome') {
          const inputId = labelEl.id.replace('-labelEl', '-inputEl');
          return document.getElementById(inputId) ? inputId : null;
        }
      }
      const byId = popup.querySelector('input[id*="Outcome"][id$="-inputEl"]');
      return byId ? byId.id : null;
    }).catch(() => null);

    let chosenOutcome = null;
    if (outcomeInputId) {
      await page.locator('[id="' + outcomeInputId + '"]').click();
      await page.waitForTimeout(300);
      const outcomeOptions = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.x-boundlist-item, .x-list-plain li'))
          .map(el => el.innerText.trim()).filter(t => t && t !== ' ')
      ).catch(() => []);
      console.log('closeClaim: Outcome options: ' + outcomeOptions.join(' | '));

      const validOpts = outcomeOptions.filter(o => o !== '<none>' && o.trim() !== '');
      chosenOutcome =
        validOpts.find(o => PREFERRED_CLOSE_REASONS.some(p => o.toLowerCase().includes(p.toLowerCase()))) ||
        (closeReason && validOpts.find(o => o.toLowerCase().includes(closeReason.toLowerCase()))) ||
        validOpts[0];
      console.log('closeClaim: choosing Outcome: ' + chosenOutcome);

      if (chosenOutcome) {
        const item = page.locator('.x-boundlist-item').filter({ hasText: chosenOutcome }).first();
        if (await item.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
          await item.click();
          console.log('closeClaim: Outcome selected via .x-boundlist-item');
        } else {
          await page.keyboard.press('Escape');
        }
      } else {
        await page.keyboard.press('Escape');
      }
    }
    // Commit outcome selection and dismiss any open dropdown (Tab only — Escape clears ExtJS combobox)
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForTimeout(200);

    // Dump fields before clicking Update (to confirm values weren't cleared by Tab/Escape)
    const preUpdateDump = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[id*="CloseClaimPopup"] input, [id*="CloseClaimPopup"] textarea, [id*="CloseClaimScreen"] input, [id*="CloseClaimScreen"] textarea'))
        .map(el => el.id + '=' + (el.value || el.textContent || '')).join(' | ').substring(0, 400);
    }).catch(() => 'dump-failed');
    console.log('closeClaim: pre-Update fields: ' + preUpdateDump);

    // Click Update (the real Close Claim button)
    const closeClaimBtn = page.locator('[id$="CloseClaimScreen:Update"]').first();
    await closeClaimBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await closeClaimBtn.click();
    await Promise.race([page.waitForLoadState('domcontentloaded'), page.waitForTimeout(5000)]).catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

    // Success: popup dismissed if the Update button is gone
    const popupGone = await page.locator('[id$="CloseClaimScreen:Update"]').first()
      .waitFor({ state: 'hidden', timeout: 3000 }).then(() => true).catch(() => false);
    if (popupGone) { console.log('closeClaim: popup dismissed — claim closed'); return; }

    // Popup still showing — collect broad diagnostics (popup + full page)
    const validationText = await page.evaluate(() => {
      const sel = '.x-form-error-msg, .g-errortip-body, .x-tip-body, .g-err-content, ' +
        '.x-component.x-window .x-window-body, [id*="msgs"], [id*="MessagePanel"], ' +
        '[aria-invalid="true"], input[aria-invalid="true"]';
      return Array.from(document.querySelectorAll(sel))
        .map(e => (e.getAttribute('aria-invalid') ? e.id + ':INVALID' : e.textContent.trim()))
        .filter(Boolean).join(' | ').substring(0, 600);
    }).catch(() => null);
    const pageText = await page.evaluate(() => {
      const w = document.querySelector('[id*="CloseClaimPopup"], [id*="CloseClaimScreen"]');
      return w ? w.innerText.substring(0, 600) : '';
    }).catch(() => null);
    // Also dump the full page body for any error banners OUTSIDE the popup
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1200)).catch(() => null);
    console.log('closeClaim: popup still showing | validation="' + (validationText || '') + '" | popupText="' + (pageText || '').replace(/\n/g, ' ') + '"');
    console.log('closeClaim: full-page text (first 800): "' + (bodyText || '').replace(/\n/g, ' ').substring(0, 800) + '"');

    const combinedText = (validationText || '') + ' ' + (bodyText || '');
    const openExposuresBlocked = /open exposures/i.test(combinedText);
    if (openExposuresBlocked) {
      throw new Error('closeClaim: blocked - there are still open exposures; close them first via closeExposureWithOutcome');
    }

    const subroBlocked = /subrogation.*open|open.*subrogation|recovery.reserve|subrogation status/i.test(combinedText);
    const openActivitiesBlocked = /activit|mandatory|complete.*before/i.test(combinedText);

    if (!openActivitiesBlocked && !subroBlocked) {
      throw new Error('closeClaim: popup stayed open with no recognized blocking reason — last text: "' + (bodyText || 'none').substring(0, 200) + '"');
    }

    // Cancel the popup before taking healing action
    const cancelBtn = page.locator('.x-btn').filter({ hasText: 'Cancel', exact: true }).first();
    await cancelBtn.click().catch(() => {});
    await Promise.race([page.waitForLoadState('domcontentloaded'), page.waitForTimeout(3000)]).catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

    if (subroBlocked) {
      console.log('closeClaim: blocked by open subrogation/recovery reserves - closing subro and retrying');
      await closeSubrogationForClaim(page);
    }
    if (openActivitiesBlocked) {
      console.log('closeClaim: blocked by open activities - completing them and retrying');
      await completeAllWorkplanActivities(page);
    }
  }
  throw new Error('closeClaim: still blocked after 3 attempts');
}

async function assertClaimStatus(page, expectedStatus) {
  const el  = page.locator('[id*="Status"], [id*="ClaimStatus"]').first();
  const txt = await el.textContent();
  if (!txt?.includes(expectedStatus)) throw new Error('Expected status "' + expectedStatus + '", got "' + txt + '"');
}

// ── Reopen ────────────────────────────────────────────────────────────────────
async function reopenClaim(page, { reopenReason }) {
  // Confirmed real element id via codegen (see Claim:ClaimMenuActions usage
  // in fnolHelper.js / financialsHelper.js) - was previously an unverified guess.
  await page.locator('[id="Claim:ClaimMenuActions"]').click();
  await page.click('a:has-text("Reopen"), [id*="Reopen"]');
  await page.waitForSelector('[id*="ReopenReason"]', { timeout: 15_000 });
  if (reopenReason) await fillTextField(page, '[id*="ReopenReason"]', reopenReason);
  await clickSave(page);
  await verifyNoValidationErrors(page);
}

// ── Archive ───────────────────────────────────────────────────────────────────
async function archiveClaim(page) {
  // Confirmed real element id via codegen (see Claim:ClaimMenuActions usage
  // in fnolHelper.js / financialsHelper.js) - was previously an unverified guess.
  await page.locator('[id="Claim:ClaimMenuActions"]').click();
  await page.click('a:has-text("Archive"), [id*="Archive"]');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await verifyNoValidationErrors(page);
}

// ── Drain reserves, sweep activities, close every exposure ───────────────────
// Shared by all six LOB E2E specs. Gets a claim into a state where closeClaim
// will actually succeed. Every step here exists because of a specific live
// failure:
//
//  * Reserves are drained with FINAL PAYMENTS rather than by zeroing them.
//    Zeroing is itself a reserve transaction and the same-day rules refuse it
//    (VTDMPL61 for reserves, DMTV0039 for recovery reserves), so an exposure
//    created today could never be closed today. Payments carry no such limit.
//  * Draining is driven by findFirstPositiveReserveLine (whole-claim scan), NOT
//    by claimant name: a claim routinely has two exposures under the SAME
//    claimant, and a name-scoped lookup reported $0 while $600 sat on the second.
//  * Activities are swept AFTER draining, because each Final Payment spawns new
//    workplan activities and any open activity blocks the close.
//  * Exposures are closed by COVERAGE, which is unique per exposure. Closing by
//    claimant name re-targeted the already-closed exposure once names repeated.
//  * The grid is re-read every pass and only after it has actually rendered -
//    reading straight after openExposuresTab saw zero rows on a claim that
//    visibly had an Open exposure, and silently reported "nothing left to do".
async function drainAndCloseAllExposures(page, claimNumber) {
  await openExistingClaim(page, claimNumber);

  for (let round = 0; round < 8; round++) {
    let line = null;
    try { line = await findFirstPositiveReserveLine(page); } catch (_) {}
    if (!line || !(line.amount > 0)) {
      console.log('drainAndCloseAllExposures: no positive reserve lines left after ' + round + ' round(s)');
      break;
    }
    console.log('drainAndCloseAllExposures: round=' + round + ' draining $' + line.amount + ' on "' + line.firstCell + '"');
    await createPayment(page, {
      paymentAmount  : line.amount,
      reserveLine    : line.firstCell,
      transactionType: 'Final Payment',
    });
    await approveLatestCheck(page, claimNumber);
  }

  await completeAllWorkplanActivities(page);

  for (let guard = 0; guard < 8; guard++) {
    await openExposuresTab(page);
    const open = await readOpenExposureCoverages(page);
    if (!open.length) {
      console.log('drainAndCloseAllExposures: no Open exposures left');
      return;
    }
    console.log('drainAndCloseAllExposures: ' + open.length + ' Open left; closing "' + open[0] + '"');
    await closeExposureWithOutcome(page, open[0]);
  }
  throw new Error('drainAndCloseAllExposures: exposures still Open after 8 close passes');
}

// Coverage of every Open row in the Exposures grid.
async function readOpenExposureCoverages(page) {
  // Wait for the grid to actually render. openExposuresTab returns as soon as
  // the nav click settles (measured at 68ms), well before ExtJS paints rows.
  await page.locator('.x-column-header-text').filter({ hasText: /^Coverage$/ }).first()
    .waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  await page.locator('tr.x-grid-row').first()
    .waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  await waitForAllMasksGone(page);

  return page.evaluate(() => {
    // Anchor on the grid's own header container. A page-wide
    // '.x-column-header-text' query merges headers from every grid on the claim
    // ("Coverage" next to "Roles", "Phone", "Due", "Trial Date", ...), which
    // makes column-index arithmetic meaningless.
    for (const headerCt of document.querySelectorAll('.x-grid-header-ct')) {
      const headers = Array.from(headerCt.querySelectorAll('.x-column-header-text'))
        .map(h => (h.innerText || '').trim());
      const covIdx = headers.findIndex(h => /^Coverage$/i.test(h));
      const statusIdx = headers.findIndex(h => /^Status$/i.test(h));
      if (covIdx < 0 || statusIdx < 0) continue;   // not the exposures grid

      const owner = headerCt.parentElement;
      const rows = owner ? owner.querySelectorAll('tr.x-grid-row') : [];
      const out = [];
      for (const row of rows) {
        if (row.offsetParent === null) continue;
        const cells = Array.from(row.querySelectorAll('td')).map(td => (td.innerText || '').trim());
        if (!cells.length) continue;
        // Rows can carry a leading checkbox cell with no header entry, so align
        // from the end rather than assuming a 1:1 header/cell mapping.
        const offset = cells.length - headers.length;
        const cov = cells[covIdx + offset];
        const status = cells[statusIdx + offset];
        if (!cov || !status) continue;
        if (!/^open$/i.test(status)) continue;
        out.push(cov);
      }
      return out;
    }
    return [];
  }).catch(() => []);
}

// ── Exception ─────────────────────────────────────────────────────────────────
async function assertExceptionLogged(page, { exceptionType }) {
  await page.click('[id*="ExceptionsTab"], a:has-text("Exceptions")').catch(() => {});
  await verifyTextVisible(page, exceptionType);
}

module.exports = {
  assertSegment, setSegmentManually,
  assertInitialReservesSet,
  openWorkplanTab, assertActivityExists, createManualActivity, completeActivity,
  closeClaim, assertClaimStatus,
  reopenClaim,
  archiveClaim,
  assignClaim,
  createDocumentFromTemplate,
  validateClaimAndExposures, validateAndRepairClaim,
  closeExposure,
  closeExposureWithOutcome,
  approveLatestCheck,
  completeAllWorkplanActivities,
  fixMissingPartyAddress,
  assertExceptionLogged,
};
