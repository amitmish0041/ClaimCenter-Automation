/**
 * helpers/smartComm/interactiveEditService.js
 * Drives a SmartCOMM "Interactive" document session from ClaimCenter's Create tab: click Interactive,
 * get past the Azure SSO popup, edit/verify merge fields per the Claims_Attributes_Data_Dictionary,
 * Save Changes, Complete Document, and read the Document Properties Identifier (the S3 lookup key —
 * see helpers/s3Download/s3AdminService.js, CONFIRMED live 2026-09-28 that this Identifier is exactly
 * the S3 PDF's filename under ClaimCenter Inbound Pending > smartcomm).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * Field-detection/editing CONFIRMED live 2026-09-28 (DIG103, after a saved Azure session removed the need
 * for a human at login — see azureSessionStore.js): the actual document content is NOT in the main
 * ClaimCenter page at all, but in a same-origin iframe at .../platform/draft-editor/draft-editor.jsp
 * (a "Thunderhead"-branded editor — CONFIRMED by its own "th-*" class names), which itself only finishes
 * populating a moment after the outer "Authenticating..." placeholder clears (CONFIRMED: it shows its own
 * "Loading in progress" text first). Inside that frame:
 *   - a merge field is `<span class="th-data-value">[value]</span>` (LOCKED) or
 *     `<span class="th-data-value-editable">[value]</span>` (editable) — CONFIRMED this distinction is
 *     actually enforced, not just styling: a locked span sits under an overlay (`.th-line-selection`) that
 *     blocks pointer events, and double-clicking one dispatches fine but opens no edit UI and changes
 *     nothing; an editable span's double-click opens `div.th-dataItemInlineEditor` containing a real
 *     `input#th-inlineEditor-string-textbox` (other data types likely get a different inline-editor id —
 *     unconfirmed) whose `aria-label` (e.g. "insuredName string") reveals the field's real, technical
 *     attribute name — filling that input and pressing Enter commits the change (the OLD span element is
 *     then replaced by a new one carrying the updated text, so anything holding a reference to the old
 *     element/id must re-query afterward). Escape closes the popup without committing, confirmed safe for
 *     probing a field's identity without actually changing it.
 *   - That aria-label technical name (e.g. "insuredName") does NOT reliably match the data dictionary's own
 *     "Template Attribute Name" column (e.g. "PolicyInsured" for the dictionary's "Insured Name" row) —
 *     CONFIRMED live, not assumed — so this deliberately does NOT try to auto-map a field to a named
 *     dictionary row. The dictionary's Yes/No is BA intent; the editor's own th-data-value(-editable) class
 *     is implemented reality; the two are reported side by side for a human to reconcile, rather than
 *     forcing a possibly-wrong automatic match.
 *   - Not confirmed yet: how non-text data types (dates, the "Apply Medical Letterhead?" Yes/No choice,
 *     which CONFIRMED live renders in a separate right-hand "Choices" panel with real radio buttons, not
 *     inline in the document body at all) are edited. Only the plain-text `th-inlineEditor-string-textbox`
 *     path is implemented; a field whose double-click doesn't produce that specific input is reported
 *     BLOCKED ("unrecognized editor UI"), not guessed at.
 * Everything from Save Changes onward (this file's sections 4-5) is STILL the original first-draft guess —
 * not yet exercised past a successful field edit.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 */
'use strict';
const fs = require('fs');
const path = require('path');
const azureSessionStore = require('./azureSessionStore');

const DIAG_DIR = path.join(__dirname, '..', '..', 'results', 'smartComm', 'interactive-diagnostics');

// Captures a screenshot + a light text/button dump at a named step — Playwright's own end-of-test
// screenshot only reflects whatever the LAST scenario happened to be doing (CONFIRMED live 2026-09-28: a
// 3-scenario run's failure screenshot showed scenario 3's unrelated login timeout, not scenario 1's actual
// "Document Properties never appeared" failure), so anything worth debugging later needs its own capture
// at the moment it happens, tagged with which scenario/step it was.
async function saveDiagnostic(page, label) {
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(DIAG_DIR, `${label}_${stamp}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const dump = await page.evaluate(() => {
      const vis = (e) => e.offsetParent !== null;
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(vis)
        .map((b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      const errorish = Array.from(document.querySelectorAll('*')).filter((e) => vis(e) && e.children.length < 6 &&
        /error|warning|required|invalid/i.test(e.className || '') && (e.textContent || '').trim().length < 400)
        .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      return { bodyText: (document.body.innerText || '').slice(0, 3000), buttons: [...new Set(buttons)], errorish: [...new Set(errorish)] };
    }).catch((e) => ({ error: e.message }));
    fs.writeFileSync(`${base}.json`, JSON.stringify(dump, null, 1));
    return base;
  } catch (e) {
    return null;
  }
}

// CONFIRMED live 2026-09-28: both "Save Changes" and "Complete Document" raise a NATIVE browser
// window.confirm() dialog (e.g. "Complete this draft? Any unsaved changes will be lost." / OK / Cancel) —
// not a DOM-rendered popup, so dismissAnyPopups() (a getByRole('button') search) can never see it.
// Playwright's default behaviour for an unhandled native dialog is to silently DISMISS it (equivalent to
// clicking Cancel) — which is exactly why Save Changes looked like it "did nothing" and Complete Document
// never reached Document Properties: every confirmation was being auto-rejected before this code ever knew
// it existed. Installs one page-level handler that accepts (clicks OK on) every dialog for the rest of this
// page's life; idempotent (removes any prior listener first) so re-entering this flow across scenarios on
// the same shared `page` never stacks duplicate handlers.
function installDialogAutoAccept(page, { log = console.log } = {}) {
  page.removeAllListeners('dialog');
  page.on('dialog', async (dialog) => {
    log(`[Interactive] Native dialog ("${dialog.type()}"): "${dialog.message()}" — accepting.`);
    await dialog.accept().catch((e) => log(`[Interactive] Could not accept the dialog: ${e.message}`));
  });
}

// ── 1. Interactive button -> Azure SSO popup -> wait for a human to finish sign-in ──────────────────
async function clickInteractiveAndWaitForEditor(page, context, { log = console.log, timeoutMs = 360000, scenarioId = 'scenario', onPopup } = {}) {
  installDialogAutoAccept(page, { log });
  // Try a previously-saved session first — if it's still valid, the popup below may resolve on its own
  // without ever showing a login prompt. See azureSessionStore.js for why this is needed at all (each
  // scenario's own ClaimCenter re-login wipes cookies, Azure's session included).
  await azureSessionStore.loadIntoContext(context, { log });

  // CONFIRMED live 2026-09-28: with a valid saved session, the whole OAuth exchange can complete inside
  // this popup in well under a second and it then CLOSES ITSELF (normal behaviour for a popup-based OAuth
  // relay once it has relayed a result) — every popup call below must tolerate that, since the popup
  // closing is a SUCCESS signal here, not an error. The real "did this work" signal was always the MAIN
  // page (checked further down); nothing past this point depends on the popup still being open.
  const popupPromise = context.waitForEvent('page', { timeout: 20000 });
  await page.getByRole('button', { name: 'Interactive', exact: true }).click();
  const popup = await popupPromise.catch(() => null);
  // Optional hook: lets a caller learn about the Microsoft sign-in popup as soon as it opens (this is where the
  // actual email/password/MFA fields render during the sign-in wait, not the main page, which just shows
  // "Authenticating..."). Fired once, here, since the popup reference never changes after this. Currently no
  // caller passes onPopup; kept as a no-cost extension point.
  if (popup && !popup.isClosed() && onPopup) onPopup(popup);
  if (popup && !popup.isClosed()) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    if (!popup.isClosed()) {
      await popup.waitForTimeout(1500).catch(() => {});
    }
  }
  if (popup && !popup.isClosed()) {
    const azureBtn = popup.getByText('AZURE SSO', { exact: true }).first();
    const azureVisible = await azureBtn.isVisible().catch(() => false);
    if (azureVisible) {
      await azureBtn.click().catch((e) => log(`[Interactive] AZURE SSO click didn't land (popup may have just closed on its own): ${e.message}`));
    } else if (!popup.isClosed()) {
      log('[Interactive] No "AZURE SSO" button on the SmartCOMM login screen — it may already be past login, or the page differs from what this was built against.');
    }
  } else {
    log('[Interactive] Popup closed itself almost immediately — likely the saved session let sign-in complete silently. Checking the main page…');
  }

  log(`[Interactive] Waiting up to ${Math.round(timeoutMs / 1000)}s for sign-in to complete in the popup window — ` +
    'complete your Microsoft email/password/MFA there now if prompted.');
  // CONFIRMED live 2026-09-28: the south panel's Close/Save Changes/Complete Document button bar renders
  // IMMEDIATELY on clicking Interactive, well before login finishes — the content area underneath is a
  // same-origin SmartCOMM iframe (.../platform/sso/login/popup?state=...) showing a placeholder
  // "Authenticating... Please ensure that your browser's pop-up blocker is disabled" until the popup's
  // OAuth flow completes, then presumably navigates itself to the real draft-editor page (see that iframe's
  // own "state" query param). So button-visibility on the MAIN page alone is a false-positive "ready"
  // signal, and the "Authenticating..." text lives in that iframe, invisible to a page-level text search —
  // check every frame, not just the main one.
  const completeBtn = page.getByRole('button', { name: 'Complete Document', exact: true });
  const deadline = Date.now() + timeoutMs;
  let lastNudge = Date.now();
  while (Date.now() < deadline) {
    const stillAuthenticating = (await Promise.all(
      page.frames().map((f) => f.evaluate(() => /Authenticating/i.test(document.body ? document.body.innerText || '' : '')).catch(() => false))
    )).some(Boolean);
    if (!stillAuthenticating && await completeBtn.isVisible().catch(() => false)) {
      log('[Interactive] Editor loaded (Complete Document visible, "Authenticating..." gone) — continuing.');
      // Capture whatever cookies just got this scenario in, so the NEXT scenario/template/run can skip
      // the login prompt entirely if Azure's session is still valid by then.
      await azureSessionStore.saveFromContext(context, { log });
      return;
    }
    if (Date.now() - lastNudge > 30000) {
      log(`[Interactive] Still waiting for sign-in… (${Math.round((deadline - Date.now()) / 1000)}s left)`);
      lastNudge = Date.now();
    }
    await page.waitForTimeout(1000);
  }
  const diagPath = await saveDiagnostic(page, `${scenarioId}_loginTimeout`);
  throw new Error(
    `INTERACTIVE_LOGIN_TIMEOUT: still showing "Authenticating..." (or no Complete Document button) ${Math.round(timeoutMs / 1000)}s after clicking Interactive. ` +
    `Either sign-in was not completed in time, or the editor loaded with different markup than expected.${diagPath ? ` Diagnostic saved: ${diagPath}.png / .json` : ''}`
  );
}

// ── 2. Find the draft-editor iframe, wait for it to finish its OWN internal load ────────────────────
// CONFIRMED live: distinct from clickInteractiveAndWaitForEditor's "Authenticating..." wait — this frame
// keeps showing its own "Loading in progress" placeholder for a few more seconds after that.
async function getEditorFrame(page, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => f.url().includes('/draft-editor/'));
    if (frame) {
      const text = await frame.evaluate(() => (document.body ? document.body.innerText || '' : '')).catch(() => '');
      if (text && !/Loading in progress/i.test(text)) return frame;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('INTERACTIVE_EDITOR_FRAME_NOT_FOUND: the draft-editor iframe never appeared or never finished loading.');
}

// ── 2b. The "Choices" panel: non-inline questions (e.g. "Apply Medical Letterhead?", "Claimant Name") that
// drive which conditional content/header gets applied — CONFIRMED live these exist and render as real radio
// buttons/checkboxes in a separate right-hand panel, NOT as inline merge-field spans in the document body
// (see file header); editing them was never implemented before now. FIRST-DRAFT, not yet exercised live:
// generic radio-group/checkbox scan rather than a selector tied to a specific "Choices" heading, since the
// panel's own DOM hasn't been inspected directly. Two question shapes, both answered "yes"/checked: a
// two-option radio group labeled exactly "Yes"/"No" (clicks "Yes" if not already selected), and a standalone
// checkbox (e.g. a full-catalog scan 2026-10-02 found "Claimant Name" is this shape on 10 templates —
// checked, not a yes/no choice at all) — checked if not already checked. Deliberately caller-choice of `root`
// (the main `page` or the draft-editor `frame`) since it isn't yet confirmed which one actually hosts this
// panel; call with both and let whichever one has no matches be a harmless no-op. Never throws — a template
// with no such panel at all should proceed completely normally.
async function scanChoicesOnce(root) {
  return root.evaluate(() => {
    const clean = (t) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const labelFor = (el) => {
      const aria = el.getAttribute('aria-label');
      if (aria) return clean(aria);
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) return clean(lab.textContent);
      }
      const parentLabel = el.closest('label');
      if (parentLabel) return clean(parentLabel.textContent);
      return clean((el.nextElementSibling && el.nextElementSibling.textContent) || (el.parentElement && el.parentElement.textContent) || '');
    };
    // CONFIRMED live 2026-10-02 (DIG181): the question text isn't rendered as visible DOM text anywhere near
    // the radio group at all — it's embedded directly in each radio input's own `name` attribute (the trailing
    // "-1"/"-2"/etc. is the option index, not a per-question id — every option in the same group carries the
    // same question segment). Far more reliable than the DOM-text fallbacks below, which were guessing at a
    // layout this widget doesn't actually use — tried first, before those.
    // CONFIRMED live 2026-10-06 (DIG36): the real separator is an UNDERSCORE ("th_choice_Apply Medical
    // Letterhead?-1", "th_choice_Select Language to display in Paragraph-2") with the question text already
    // human-readable (spaces and punctuation intact, no camelCase blob to split) — not the hyphenated
    // "th-choice-list-ApplyMedicalLetterhead?-1" this originally assumed, which never matched live and
    // silently fell through to the DOM-text fallback for every single choice. Handles both forms.
    const nameAttrQuestion = (nameAttr) => {
      const m = String(nameAttr || '').match(/^th[_-]choice[_-](?:list[_-])?(.+?)-\d+$/);
      return m ? m[1].replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim() : '';
    };
    const questionTextFor = (containerEl, diag) => {
      let question = '';
      let node = containerEl && containerEl.previousElementSibling;
      let hops = 0;
      while (node && hops < 3 && !question) { question = clean(node.textContent).slice(0, 80); node = node.previousElementSibling; hops++; }
      if (question) return question;
      // Table-row fallback: a Choices-panel question is often laid out as its OWN preceding CELL in the same
      // row, not a plain sibling of the radiogroup/fieldset element (which can be nested a level deeper
      // inside its own cell) — the sibling-walk above only ever finds something sharing the group element's
      // own direct parent. DIAGNOSTIC 2026-10-02: unverified live yet — if this ALSO comes back empty, `diag`
      // (when passed) captures the row's own outerHTML so the real structure can be read off a live run
      // instead of guessed again blind.
      const row = containerEl && containerEl.closest && containerEl.closest('tr, [role="row"]');
      if (row) {
        const cells = Array.from(row.querySelectorAll('td, th, [role="cell"], [role="gridcell"]'));
        const ownCellIdx = cells.findIndex((c) => c.contains(containerEl));
        for (let i = ownCellIdx - 1; i >= 0 && !question; i--) { question = clean(cells[i].textContent).slice(0, 80); }
      }
      if (!question && diag) diag.push((row || containerEl) ? (row || containerEl).outerHTML.slice(0, 1200) : '(no row/container element to dump)');
      return question;
    };
    // Group by the nearest ancestor that plausibly scopes ONE question's options — role=radiogroup for ARIA
    // widgets. For a native <input type="radio">, the real, authoritative grouping signal is its OWN shared
    // `name` attribute (that's what makes a browser treat a set of radios as mutually exclusive at all) — NOT
    // DOM ancestry. CONFIRMED live 2026-10-06 (DIG36): a 6-option group ("Select Language to display in
    // Paragraph") renders each option in its OWN separate wrapper <div> with no shared <fieldset>, so grouping
    // by `el.closest('fieldset') || el.parentElement` split it into six different "groups of 1" instead of one
    // real group of 6 — each got clicked independently rather than treated as one mutually-exclusive choice.
    // Falls back to fieldset/parent only when there's genuinely no name attribute to group by.
    const groupKeyEl = (el) => {
      if (el.getAttribute('role') === 'radio') return el.closest('[role="radiogroup"]') || el.parentElement;
      const name = el.getAttribute('name');
      return name ? `radio-name:${name}` : (el.closest('fieldset') || el.parentElement);
    };
    const radios = Array.from(document.querySelectorAll('[role="radio"], input[type="radio"]'));
    const groups = [];
    const seen = new Map();
    radios.forEach((el, idx) => {
      if (el.offsetParent === null) return; // invisible — skip from grouping, but idx still ties to the full list below
      const key = groupKeyEl(el);
      let g = seen.get(key);
      if (!g) { g = { key, items: [], nameAttr: el.getAttribute('name') || '' }; seen.set(key, g); groups.push(g); }
      g.items.push({ idx, label: labelFor(el), checked: el.getAttribute('aria-checked') === 'true' || el.checked === true });
    });
    const results = [];
    const skipped = [];
    const diag = [];
    for (const g of groups) {
      const labels = g.items.map((it) => it.label);
      const alreadyChecked = g.items.find((it) => it.checked);
      if (g.items.length === 2 && labels.includes('yes') && labels.includes('no')) {
        const yesItem = g.items.find((it) => it.label === 'yes');
        if (yesItem.checked) { skipped.push('already Yes'); continue; }
        results.push({ idx: yesItem.idx, chosenLabel: 'Yes', question: nameAttrQuestion(g.nameAttr) || questionTextFor(g.key, diag) || '(unlabeled choice)' });
        continue;
      }
      // CONFIRMED by user 2026-10-06 (DIG36): a radio group that ISN'T a binary yes/no pair (e.g. DIG36's own
      // 6-way "for bodily injury/property damage per claim" / "...per occurrence" / two garagekeepers variants
      // / etc.) used to be skipped here entirely — generalized to every template, not special-cased to this
      // one: any group with NOTHING already selected gets its FIRST option picked, same reasoning as always
      // picking "Yes" for a binary choice — exercising ONE real content path beats leaving a BA-authored,
      // presumably-required selection blank (which can itself block Complete Document, and leaves every one
      // of that group's conditional paragraphs entirely unvalidated either way). A group that already HAS a
      // selection (the claim/template's own default) is left alone, same as an already-"Yes" pair above.
      if (alreadyChecked) { skipped.push(`group of ${g.items.length} already has a selection (labels: ${labels.join('/')})`); continue; }
      if (!g.items.length) continue;
      const firstItem = g.items[0];
      results.push({ idx: firstItem.idx, chosenLabel: firstItem.label || '(option 1)', question: nameAttrQuestion(g.nameAttr) || questionTextFor(g.key, diag) || '(unlabeled choice)' });
    }
    // Standalone checkboxes — a DIFFERENT question shape from the yes/no radio pairs above (not part of any
    // group at all): just check it if it isn't already checked. Indexed into its OWN separate list
    // (checkboxes), not the radios list above.
    // CONFIRMED live 2026-10-02 (DIG11): the editor's own "Show Choices Inline" view-preference toggle (a
    // switch next to the "All/To Do" tabs atop the Choices panel — editor chrome, not a template business
    // question) matches this same generic selector and got checked by mistake. Excluded by label; a narrow,
    // targeted exclusion for the one false positive actually seen, not a broad heuristic guess.
    const EDITOR_CHROME_RE = /show choices inline/i;
    const checkboxes = Array.from(document.querySelectorAll('[role="checkbox"], input[type="checkbox"]'));
    const checkboxResults = [];
    checkboxes.forEach((el, idx) => {
      if (el.offsetParent === null) return;
      const lbl = labelFor(el);
      if (EDITOR_CHROME_RE.test(lbl)) { skipped.push(`editor chrome, not a business choice (label: ${lbl})`); return; }
      const checked = el.getAttribute('aria-checked') === 'true' || el.checked === true;
      if (checked) { skipped.push(`checkbox already checked (label: ${lbl})`); return; }
      const container = el.closest('[role="row"], tr, td, div') || el.parentElement;
      const nameQuestion = nameAttrQuestion(el.getAttribute('name') || el.id);
      checkboxResults.push({ idx, question: nameQuestion || lbl || questionTextFor(container, diag) || '(unlabeled checkbox)' });
    });
    return { results, checkboxResults, totalRadios: radios.length, totalGroups: groups.length, totalCheckboxes: checkboxes.length, skipped, diag };
  }).catch((e) => ({ results: [], checkboxResults: [], totalRadios: 0, totalGroups: 0, totalCheckboxes: 0, skipped: [], diag: [], scanError: e.message }));
}

async function selectAllYesNoChoices(root, { log = console.log, label = 'main page' } = {}) {
  let found = await scanChoicesOnce(root);
  if (found.scanError) log(`selectAllYesNoChoices (${label}): scan failed — ${found.scanError}`);
  // CONFIRMED live 2026-10-02 (DIG181-PR-DE/PR-VA): radios can show up in the raw DOM count but form ZERO
  // usable yes/no groups (not just fewer than expected — none at all), the exact same "editor loaded but
  // content hasn't actually mounted into the DOM yet" render race already proven and fixed for merge fields
  // ("0 merge fields found" — see validationService.js's own comment on that fix) rather than evidence this
  // scenario's document genuinely has no Choices panel (THAT case shows 0 radios total, not >0 radios forming
  // 0 groups). One retry after the same 2s wait used for the merge-field fix, keeping whichever scan found
  // more rather than blindly trusting the retry.
  if (found.totalRadios > 0 && found.totalGroups === 0 && found.results.length === 0) {
    await root.waitForTimeout(2000);
    const retryFound = await scanChoicesOnce(root);
    if (retryFound.totalGroups > found.totalGroups || retryFound.checkboxResults.length > found.checkboxResults.length) {
      log(`selectAllYesNoChoices (${label}): retry after a 2s render-wait found ${retryFound.totalGroups} group(s) (was 0) — using the retry scan instead.`);
      found = retryFound;
    } else {
      log(`selectAllYesNoChoices (${label}): retry after a 2s render-wait still found 0 usable group(s) — this scenario's Choices panel genuinely isn't forming valid yes/no pairs, not just a render-timing fluke.`);
    }
  }

  log(`selectAllYesNoChoices (${label}): ${found.totalRadios} radio(s) in ${found.totalGroups} group(s), ${found.totalCheckboxes} checkbox(es) total; ${found.results.length} choice(s) and ${found.checkboxResults.length} standalone checkbox(es) to set` + (found.skipped.length ? `; skipped: ${found.skipped.slice(0, 5).join(' | ')}` : ''));
  if (found.diag && found.diag.length) {
    found.diag.forEach((html, i) => log(`selectAllYesNoChoices (${label}): DIAG — no real question label found for choice #${i + 1}, nearby HTML: ${html}`));
  }
  const applied = [];
  if (!found.results.length && !found.checkboxResults.length) return applied;
  const { results, checkboxResults } = found;
  const radiosLocator = root.locator('[role="radio"], input[type="radio"]');
  for (const item of results) {
    try {
      const radio = radiosLocator.nth(item.idx);
      // CONFIRMED live 2026-10-02 (DIG181-PR-DE): a single click here, same widget family as the additional-
      // recipient "Remove" checkbox, can genuinely fail to register — visually confirmed by the user (the
      // radio still showed "No" after this code logged a "successful" click, with no exception thrown and no
      // DOM state ever flipping). Same 4-attempt click+focus/Space retry already proven reliable for
      // checkboxes below, not a one-shot click+poll.
      let confirmed = false;
      for (let attempt = 1; attempt <= 4 && !confirmed; attempt++) {
        if (attempt > 1) await root.waitForTimeout(300);
        await radio.click({ force: true, timeout: 3000 }).catch(() => {});
        confirmed = await radio.evaluate((el) => el.getAttribute('aria-checked') === 'true' || el.checked === true).catch(() => false);
        if (!confirmed) {
          await radio.focus().catch(() => {});
          await radio.press('Space').catch(() => {});
          confirmed = await radio.evaluate((el) => el.getAttribute('aria-checked') === 'true' || el.checked === true).catch(() => false);
        }
      }
      if (confirmed) {
        log(`selectAllYesNoChoices (${label}): selected "${item.chosenLabel}" for "${item.question}"`);
        applied.push(`${item.question}: ${item.chosenLabel}`);
      } else {
        // Genuinely never took, even after retries — this is OUR automation failing to click, not evidence
        // the choice stayed unselected by the user's/claim's own doing. Don't push it into `applied`: per user
        // direction 2026-10-02, a choice that was never actually confirmed selected shouldn't have its gated
        // content validated (or even shown in the report) — conflating "we couldn't click it" with "it
        // printed and shouldn't have" would be a misleading FAIL, not a real document defect.
        log(`selectAllYesNoChoices (${label}): WARNING — could not get "${item.question}" to register as "${item.chosenLabel}" after 4 attempts; leaving it out so its gated content isn't wrongly expected to print.`);
      }
    } catch (e) {
      log(`selectAllYesNoChoices (${label}): could not click "Yes" for "${item.question}" — ${e.message}`);
    }
  }
  // CONFIRMED live 2026-10-02 (the additional-recipient "Remove" checkbox, same widget family): a single
  // click, and even a single focus+Space keypress, each independently failed to toggle this kind of custom
  // checkbox on at least one live run — genuine flakiness, not a one-off. Retry the whole click-then-Space
  // sequence a few times with a short settle pause rather than trying each strategy only once.
  const checkboxesLocator = root.locator('[role="checkbox"], input[type="checkbox"]');
  for (const item of checkboxResults) {
    try {
      const checkbox = checkboxesLocator.nth(item.idx);
      let confirmed = false;
      for (let attempt = 1; attempt <= 4 && !confirmed; attempt++) {
        if (attempt > 1) await root.waitForTimeout(300);
        await checkbox.click({ force: true, timeout: 3000 }).catch(() => {});
        confirmed = await checkbox.evaluate((el) => el.getAttribute('aria-checked') === 'true' || el.checked === true).catch(() => false);
        if (!confirmed) {
          await checkbox.focus().catch(() => {});
          await checkbox.press('Space').catch(() => {});
          confirmed = await checkbox.evaluate((el) => el.getAttribute('aria-checked') === 'true' || el.checked === true).catch(() => false);
        }
      }
      log(`selectAllYesNoChoices (${label}): checked "${item.question}"${confirmed ? '' : ' — WARNING: never showed as checked after retries; the document may not actually reflect this choice'}`);
      applied.push(`${item.question}: Yes`);
    } catch (e) {
      log(`selectAllYesNoChoices (${label}): could not check "${item.question}" — ${e.message}`);
    }
  }
  // Give the document a moment to regenerate/reflow around the new choice before the caller reads merge
  // fields or proceeds to Save/Complete — CONFIRMED live this isn't instantaneous (see the race noted above).
  await root.waitForTimeout(1000);
  return applied;
}

// ── 3. Enumerate merge fields inside that iframe ─────────────────────────────────────────────────────
// CONFIRMED live: `span.th-data-value-editable` = editable, `span.th-data-value` (without that modifier)
// = locked — see file header. Each field's locator is a POSITIONAL `.nth(idx)` against this same live
// selector, not a custom attribute tagged onto the element — CONFIRMED live 2026-09-29 (DIG166) that a
// custom attribute doesn't survive: committing an edit doesn't just replace the JUST-edited span (already
// documented below), it can also make Thunderhead regenerate OTHER nearby spans in the same reflowing
// paragraph, and a freshly-generated span never carries an attribute we injected onto the old one — a
// locator built on it then finds nothing and the eventual click times out. `.nth(idx)` instead re-runs the
// CSS selector live at click time, so it keeps finding whatever CURRENTLY sits in that position even after
// Thunderhead swaps the element out, as long as the field COUNT and ORDER stay stable (true here — edits
// change a field's displayed value, never how many merge fields exist or where).
async function readMergeFields(frame) {
  const SELECTOR = 'span.th-data-value, span.th-data-value-editable';
  const raw = await frame.evaluate((selector) => {
    // CONFIRMED live 2026-09-30 (DIG52's table-cell labels): the editor's own DOM carries a literal pilcrow
    // (¶) as a paragraph-end marker inside table cells (e.g. "Our Claim No.:¶") — not whitespace as far as
    // \s is concerned, so it survived into the report as visible junk ("Our Claim No.:¶"). Non-breaking
    // spaces ( ) show up in the same editor content and get the same treatment.
    const clean = (t) => (t || '').replace(/[¶ ]/g, ' ').replace(/\s+/g, ' ').trim();
    const spans = Array.from(document.querySelectorAll(selector));
    // The on-page label immediately before a field (e.g. "Insured Name:", "RE: Claim Number") is what the
    // Data Dictionary's "ClaimCenter Field Display" column (I) is written to match — walks the field's
    // containing block (paragraph/div/table cell) collecting text UP TO the field itself, so it can't
    // accidentally include a label that actually belongs to some other field later in the same block.
    function precedingLabelText(span, maxLen) {
      const block = span.closest('p, div, li, td, th') || span.parentElement;
      if (!block) return '';
      let text = '';
      let stop = false;
      (function walk(node) {
        if (stop) return;
        if (node === span) { stop = true; return; }
        if (node.nodeType === 3) { text += node.textContent; return; }
        for (const child of node.childNodes) { walk(child); if (stop) return; }
      })(block);
      const own = clean(text);
      if (own) return own.slice(-maxLen);
      // CONFIRMED live 2026-09-30 (DIG52's Claim No./Insured/Date of Loss/Claimant rows): a template often
      // lays a label and its field out as ADJACENT table cells ("Our Claim No.:" | the field), not sharing
      // one block, so the field's own cell has no preceding text at all and the walk above comes back empty
      // even though a perfectly good label sits right next to it. Fall back to the nearest earlier sibling
      // cell's own text (skipping any empty spacer cells) before giving up.
      const cell = span.closest('td, th');
      if (cell) {
        let sib = cell.previousElementSibling;
        while (sib) {
          const sibText = clean(sib.textContent || '');
          if (sibText) return sibText.slice(-maxLen);
          sib = sib.previousElementSibling;
        }
      }
      return '';
    }
    // CONFIRMED live 2026-10-06 (DIG36, via a full DOM dump of its "Select Language to display in Paragraph"
    // choice): SmartCOMM renders EVERY option's own paragraph as a live, visible preview simultaneously — all
    // 6 variants' merge fields (including duplicate copies of locked fields like "Claimant Name" and the
    // editable deductible-amount field) sit in the DOM at once, inside their own `.th-choice` wrapper, with
    // ONLY that wrapper's own radio (`.th-choice-input-checked` vs `-unchecked`) distinguishing which one will
    // actually print. Only ONE copy (the selected option's) is real content; the other 5 will never appear in
    // the generated document at all. Without this, every one of those fields gets edited/validated up to 6x
    // over — wasted edit attempts on content that can't survive into the PDF, and the SAME underlying
    // dictionary disagreement (e.g. "Claimant Name" or "Underwriting Company" locked-when-it-should-be-
    // editable) reported as 6 near-duplicate failures instead of 1 (per user direction 2026-10-06).
    function inUnselectedChoice(span) {
      const wrapper = span.closest('.th-choice');
      if (!wrapper) return false; // not part of any choice-option preview at all — unaffected
      const radio = wrapper.querySelector('input[type="radio"], [role="radio"]');
      if (!radio) return false; // no radio found — don't guess, leave it alone
      const checked = radio.classList.contains('th-choice-input-checked') || radio.getAttribute('aria-checked') === 'true' || radio.checked === true;
      return !checked;
    }
    return spans.map((s, i) => ({
      idx: i, text: clean(s.textContent), editable: s.classList.contains('th-data-value-editable'),
      labelContext: precedingLabelText(s, 80), inUnselectedChoice: inUnselectedChoice(s),
    }));
  }, SELECTOR);
  const base = frame.locator(SELECTOR);
  return raw.map((f) => ({
    ...f,
    stripped: f.text.replace(/^\[+/, '').replace(/\]+$/, '').trim(),
    locator: base.nth(f.idx),
  }));
}

// ── 4. Double-click a field to open its inline editor; read its real technical name; optionally edit ──
// Always resolves (never throws) — every outcome (including "not a recognized editor UI") is reported in
// the return value, since a BLOCKED classification for one odd field shouldn't abort the whole scenario.
async function inspectAndMaybeEdit(frame, page, field, { newValue, log = console.log } = {}) {
  const before = field.text;
  try {
    // CONFIRMED live 2026-09-29 (DIG166, a 26-field template — DIG15/DIG7's much shorter templates never hit
    // this): scrollIntoViewIfNeeded can burn its FULL default ~15s timeout and still fail, specifically on
    // fields that render with a hover-name tooltip badge (e.g. "editableField1") visible right over the
    // target in a diagnostic screenshot taken mid-hang — consistent with that tooltip repositioning on every
    // frame and never letting Playwright's stability check see two consecutive settled frames. Scrolling
    // accurately isn't actually required for a headless-style automation click (only for a real user's
    // mouse), so this no longer waits on it: a short best-effort scroll, swallowed if it fails, followed by
    // a FORCED double-click that skips Playwright's own visibility/stability/receives-events actionability
    // checks entirely (the exact checks that were the ones hanging). A field this lands on incorrectly (e.g.
    // truly hidden, 0-size) still fails safely below via "no popup appeared" — force only skips the
    // pre-click waiting, not the verification of what actually happened after.
    // Marks every input/select/textarea already visible BEFORE this click, so the fallback lookup below (for
    // a field type that edits via a bare inline <input> rather than a `.th-dataItemInlineEditor` popup — see
    // its own comment) can tell a genuinely NEW element apart from some other, unrelated, always-present
    // control elsewhere on the page. CONFIRMED live 2026-09-29 (DIG52): without this, an unscoped "any
    // visible input" fallback matched an always-present "Show Choices" control (a real Thunderhead UI
    // element, unrelated to any specific field) on EVERY locked field's double-click, so all 12 of that
    // template's locked fields wrongly reported as "changed" (FAIL) instead of correctly resisting the edit
    // (PASS) — a regression from the fallback added for DIG166's date fields.
    await frame.evaluate(() => {
      document.querySelectorAll('input, select, textarea').forEach((el) => {
        if (el.offsetParent !== null) el.setAttribute('data-th-preexisting-input', '1');
      });
    }).catch(() => {});
    await field.locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await field.locator.dblclick({ timeout: 5000, force: true });
  } catch (e) {
    return { attempted: false, changed: null, technicalName: null, before, after: before, note: `Could not double-click: ${e.message.split('\n')[0]}` };
  }
  await page.waitForTimeout(300);

  let popupInput = frame.locator('.th-dataItemInlineEditor input, .th-dataItemInlineEditor select, .th-dataItemInlineEditor textarea').first();
  let popupVisible = await popupInput.isVisible().catch(() => false);
  if (!popupVisible) {
    // CONFIRMED live 2026-09-29 (DIG166's date-component fields, e.g. the "20__" year field in "day of __,
    // 20__") — a user double-clicking these gets a plain <input> that replaces the field IN PLACE, directly
    // in the document flow, with no `.th-dataItemInlineEditor` wrapper popup at all — a real user confirmed
    // this edits and completes fine manually. Falls back to a NEWLY-appeared visible input/select/textarea
    // (excluding anything tagged as already-present above) rather than ANY visible one anywhere in the frame
    // — CONFIRMED live this matters: DIG52 has an always-present "Show Choices" control elsewhere on the
    // page that an unscoped fallback matched for every field regardless of which one was actually clicked.
    const fallback = frame.locator('input:visible:not([data-th-preexisting-input]), select:visible:not([data-th-preexisting-input]), textarea:visible:not([data-th-preexisting-input])').first();
    if (await fallback.isVisible().catch(() => false)) {
      popupInput = fallback;
      popupVisible = true;
    }
  }
  if (!popupVisible) {
    // Locked fields land here too (CONFIRMED live: dblclick dispatches fine, no popup ever appears).
    return { attempted: false, changed: false, technicalName: null, before, after: before, note: field.editable ? 'Double-click did not open a recognized editor UI (may be a non-text field type not yet supported).' : 'No edit popup appeared (expected for a locked field).' };
  }

  const ariaLabel = await popupInput.getAttribute('aria-label').catch(() => null);
  const technicalName = ariaLabel ? ariaLabel.replace(/\s+\S+$/, '') : null; // "insuredName string" -> "insuredName"
  const inputTag = await popupInput.evaluate((el) => el.tagName).catch(() => null);

  if (newValue === undefined) {
    // Identify only — cancel without committing (CONFIRMED live safe: Escape leaves the field unchanged).
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
    if (await popupInput.isVisible().catch(() => false)) await frame.locator('body').click({ position: { x: 2, y: 2 } }).catch(() => {});
    return { attempted: false, changed: null, technicalName, before, after: before, note: '' };
  }

  if (inputTag !== 'INPUT' && inputTag !== 'TEXTAREA') {
    await page.keyboard.press('Escape').catch(() => {});
    return { attempted: false, changed: null, technicalName, before, after: before, note: `Inline editor is a <${inputTag}>, not a plain-text <input>/<textarea> this supports yet — left untouched.` };
  }

  await popupInput.fill(newValue).catch((e) => log(`[Interactive] Could not fill the inline editor for "${field.stripped}": ${e.message}`));
  // CONFIRMED live 2026-09-30 (65-template sweep, DIG239): a <textarea>-based field is otherwise identical
  // to the <input> one, but Enter there inserts a newline instead of committing — every unedited required
  // field breaks Complete Document entirely (see the retry-pass comment in validationService.js), so this
  // isn't just a cosmetic miss. Blurring (clicking elsewhere in the frame) commits it instead, same as how a
  // real user tabbing/clicking away from a textarea would.
  if (inputTag === 'TEXTAREA') {
    await frame.locator('body').click({ position: { x: 2, y: 2 } }).catch(() => {});
  } else {
    await page.keyboard.press('Enter').catch(() => {});
  }
  await page.waitForTimeout(400);

  const plain = newValue.replace(/[[\]]/g, '');
  const after = await frame.evaluate((needle) => {
    const hit = Array.from(document.querySelectorAll('span.th-data-value-editable')).find((s) => s.textContent.includes(needle));
    return hit ? hit.textContent.replace(/\s+/g, ' ').trim() : null;
  }, plain).catch(() => null);
  // `after` is the LIVE EDITOR's own display text, which CONFIRMED live double-wraps an already-bracketed
  // committed value in its own bracket decoration (typing "[QA-EDIT-2]" renders here as "[[QA-EDIT-2]]") —
  // that decoration is a live-editing-only UI affordance, not part of the real stored value: the completed
  // PDF later renders the plain committed value with none of that doubling ("[QA-EDIT-2]", exactly what was
  // typed). Anything cross-checking this edit against the final PDF (see validationService.js's
  // verifyInteractiveEditsInPdf) must search for `committedMarker` (the stable, undecorated needle already
  // used to find this span), never `after` — searching for `after` false-FAILed every real, successful edit.
  //
  // CONFIRMED live 2026-10-04 (DIG53's generic "CheckBox1/2/3..."-named fields — a plain <input type="text">
  // popup, not a real checkbox; that theory was tested and disproven): when `after` comes back null, the
  // typed value isn't just misplaced into a locked span — searching the WHOLE page for it finds ZERO
  // occurrences anywhere. That's consistent with a field whose underlying data type rejects arbitrary free
  // text (the framework silently discards the edit), and whose generic aria-label (no real business name) is
  // itself a sign of a non-text widget being presented through the same plain-<input> popup as every real
  // text field. Retrying this exact field with the same fill-text strategy can never succeed — `vanished`
  // lets the caller stop re-attempting it instead of burning 3 more retry passes for nothing.
  let vanished = false;
  if (after == null) {
    const anywhereCount = await frame.evaluate((needle) => document.body.innerText.split(needle).length - 1, plain).catch(() => -1);
    vanished = anywhereCount === 0;
  }
  return {
    attempted: true, changed: after != null, technicalName, before, after: after || before, committedMarker: plain, vanished,
    note: after == null
      ? (vanished
        ? `Committed (Enter pressed) but the value never appeared anywhere on the page afterward — likely a non-text-typed field (generic "${technicalName}" name) that silently rejects free text; retrying won't help.`
        : 'Committed (Enter pressed) but no span with the new value was found afterward.')
      : '',
  };
}

// ── 4. Save / Complete / handle any confirmation popups along the way ───────────────────────────────
// CONFIRMED live 2026-09-28 this was BROKEN: "Close" is one of the THREE PERMANENT buttons on this screen
// (Close | Save Changes | Complete Document) — including it here as a generic "dismiss" word meant this
// function found and clicked that permanent button over and over (never actually stopping — the 10s
// deadline kept getting outrun because a real, "successfully" clicked button reappears every ~500ms as a
// fresh match), instead of ever finding a real transient popup. Fixed two ways: (1) drop every word broad
// enough to collide with a real primary action on this screen — keep only words that are implausible as a
// primary button name; (2) a hard attempt cap independent of elapsed time, so a similar collision in the
// future degrades to "stopped after N clicks", never a silent runaway loop.
const NEVER_AUTO_CLICK = /^(Close|Save Changes|Complete Document|Interactive|Generate|Cancel)$/i;
const MAX_DISMISS_ATTEMPTS = 3;

async function dismissAnyPopups(page, { log = console.log, maxSeconds = 10 } = {}) {
  const deadline = Date.now() + maxSeconds * 1000;
  let attempts = 0;
  let dismissedAny = false;
  while (Date.now() < deadline && attempts < MAX_DISMISS_ATTEMPTS) {
    const btn = page.getByRole('button', { name: /^(OK|Yes|Confirm|Got it|Acknowledge)$/i })
      .filter({ hasNotText: NEVER_AUTO_CLICK }).first();
    const label = await btn.innerText().catch(() => null);
    if (label && !NEVER_AUTO_CLICK.test(label.trim()) && await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      log(`[Interactive] Dismissing a popup ("${label}")`);
      await btn.click().catch(() => {});
      attempts += 1;
      dismissedAny = true;
      await page.waitForTimeout(500);
      continue;
    }
    if (dismissedAny) break; // one clean pass with nothing left
    await page.waitForTimeout(500);
  }
  if (attempts >= MAX_DISMISS_ATTEMPTS) log(`[Interactive] Stopped dismissing popups after ${MAX_DISMISS_ATTEMPTS} clicks (safety cap) — there may still be one open.`);
}

async function saveChanges(page, { log = console.log } = {}) {
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await dismissAnyPopups(page, { log });
}

async function completeDocument(page, { log = console.log, scenarioId = 'scenario' } = {}) {
  await page.getByRole('button', { name: 'Complete Document', exact: true }).click();
  await dismissAnyPopups(page, { log });

  // Case-insensitive substring, not exact — the same drift risk (wording/casing changing under a heading)
  // has bitten other exact-text matches elsewhere in this codebase (see documentService.js's own notes).
  // Races against a possible validation error banner too, so a real "can't complete this" reason surfaces
  // on its own instead of a generic timeout with no explanation.
  const propsHeading = page.getByText(/Document Properties/i).first();
  const errorBanner = page.getByRole('group', { name: /^Errors/i }).first();
  const winner = await Promise.race([
    propsHeading.waitFor({ state: 'visible', timeout: 60000 }).then(() => 'props').catch(() => 'timeout'),
    errorBanner.waitFor({ state: 'visible', timeout: 60000 }).then(() => 'error').catch(() => 'timeout'),
  ]);
  if (winner === 'props') return;
  const diagPath = await saveDiagnostic(page, `${scenarioId}_completeDocument_${winner}`);
  if (winner === 'error') {
    const msg = (await errorBanner.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    throw new Error(`INTERACTIVE_COMPLETE_FAILED: ClaimCenter reported an error instead of completing the document — ${msg || '(error text unavailable)'}${diagPath ? ` (diagnostic: ${diagPath}.png)` : ''}`);
  }
  throw new Error(`INTERACTIVE_COMPLETE_TIMEOUT: neither "Document Properties" nor an error banner appeared within 60s of clicking Complete Document.${diagPath ? ` Diagnostic saved: ${diagPath}.png / .json` : ''}`);
}

// ── 5. Read the Identifier off Document Properties — the S3 lookup key ─────────────────────────────
async function readDocumentPropertiesIdentifier(page) {
  const row = page.locator('div, tr').filter({ hasText: /^Identifier$/ }).last();
  const text = await row.locator('..').innerText().catch(() => '');
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) throw new Error(`INTERACTIVE_NO_IDENTIFIER: could not find a GUID-shaped Identifier on Document Properties (row text: "${text.slice(0, 200)}")`);
  return m[0];
}

module.exports = {
  clickInteractiveAndWaitForEditor, getEditorFrame, readMergeFields, inspectAndMaybeEdit,
  saveChanges, completeDocument, dismissAnyPopups, readDocumentPropertiesIdentifier, saveDiagnostic,
  installDialogAutoAccept, selectAllYesNoChoices,
};
