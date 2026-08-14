/**
 * helpers/fnolHelper.js
 * First Notice of Loss helper for all 14 Donegal LOBs.
 */
const { pollForClaimNumber, IS_ON_PREM, BASE_URL,
  clickTabMenuItem, selectComboboxOnPrem, selectComboboxByIdOnPrem,
  getUsedClaimantNumbers, addUsedClaimantNumber, getNextPolicy,
  openExistingClaim, waitForAllMasksGone } = require('./claimCenterBase');

// Extracts the policy number from the claim header (e.g. "Pol: 1002241918",
// visible on every claim workspace screen per every screenshot in this
// project) so per-policy claimant-number dedup can be keyed correctly
// without the caller having to thread policyNumber through explicitly.
// ── FNOL wizard "Next" ───────────────────────────────────────────────────────
// Every step of the on-prem FNOL wizard advances via the SAME button id, and
// several call sites used a bare `.click()`. A bare click there is a latent
// 15s failure: right after CC re-renders a step (closing an incident popup,
// saving a contact) the button is briefly unclickable, the full action timeout
// burns, and the entire FNOL fails. Confirmed live on PA twice in a row - at
// Step 3, then at Step 4 once Step 3 was guarded - on a spec that had
// completed both steps cleanly minutes earlier, i.e. pure timing.
//
// Retries with a POSITIVE check that the button actually went away, re-running
// an optional repair between attempts (CC blanks required comboboxes when it
// re-renders, which makes Next legitimately refuse).
async function clickFnolNext(page, stepName, { attempts = 4, repair = null } = {}) {
  const next = page.locator('[id="FNOLWizard:Next"]');
  for (let attempt = 0; attempt < attempts; attempt++) {
    await waitForAllMasksGone(page, 20000).catch(() => {});
    await next.click({ timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const advanced = await next.waitFor({ state: 'hidden', timeout: 6000 })
      .then(() => true).catch(() => false);
    if (advanced) return true;
    console.log('clickFnolNext: still on ' + stepName + ' after Next (attempt ' +
                (attempt + 1) + '/' + attempts + ')');
    if (repair) await repair().catch(() => {});
  }
  const why = await page.evaluate(() => {
    const t = (document.body.innerText || '') + ' ' + (document.body.textContent || '');
    return [...new Set([...t.matchAll(/([^\n]{0,90}(?:Missing required field|must not be|is required)[^\n]{0,40})/gi)]
      .map(m => m[1].trim()))].slice(0, 4);
  }).catch(() => []);
  throw new Error('FNOL "' + stepName + '" would not advance after ' + attempts + ' attempts' +
    (why.length ? ' — CC reports: ' + why.join(' || ') : ' and reported no validation text'));
}

async function getPolicyNumberFromPage(page) {
  if (page._currentPolicyNumber) return page._currentPolicyNumber;
  const headerText = await page.locator('body').innerText().catch(() => '');
  const match = headerText.match(/Pol:\s*(\S+)/);
  return match ? match[1] : null;
}

const LOB_CONFIG = {
  PersonalAuto: { topStates: ['PA', 'MI'], topCoverages: ['Collision', 'Comprehensive', 'Transportation Expense', 'PD Liability', 'Auto BI'], lossCauses: { collision: 'LC15', glass: 'LC14', animal: 'LC8A', theft: 'LC13' } },
  CommercialAuto: { topStates: ['PA', 'MI'], topCoverages: ['Auto BI/PD Single Limit', 'Collision', 'Comprehensive', 'Silver Series/MicPak'], lossCauses: { collision: 'LC15', liability: 'LC03' } },
  Homeowners: { topStates: ['PA', 'VA'], topCoverages: ['Coverage A Dwelling', 'Coverage C Personal Property', 'Coverage B Other Structures'], lossCauses: { fire: 'LC01', wind: 'LC02', hail: 'LC33', water: 'LC35' } },
  WorkersComp: { topStates: ['PA', 'MI'], topCoverages: ["Workers' Compensation And Employers' Liability"], lossCauses: { indemnity: 'LC06', medical: 'LC07' } },
  BOP: { topStates: ['PA', 'DE'], topCoverages: ['Business Liability', 'BOP Coverage Level', 'Building Coverage'], lossCauses: { liability: 'LC03', property: 'LC01' } },
  CommercialPackage: { topStates: ['PA', 'MI'], topCoverages: ['Premises/Operations', 'Structure Building', 'Personal Property'], lossCauses: { liability: 'LC03', fire: 'LC01' } },
  Farmowners: { topStates: ['PA', 'VA'], topCoverages: ['Farmowners Building', 'Contents', 'Liability'], lossCauses: { fire: 'LC01', theft: 'LC08' } },
  DwellingFire: { topStates: ['PA', 'GA'], topCoverages: ['Coverage A Dwelling', 'Coverage L Premises Liability'], lossCauses: { fire: 'LC01', wind: 'LC02' } },
  Boatowners: { topStates: ['MI', 'PA'], topCoverages: ['Inland Marine All Other', 'Towing Limit', 'Liability'], lossCauses: { collision: 'LC15', theft: 'LC13' } },
  CommercialExcessLiability: { topStates: ['PA', 'MD'], topCoverages: ['Commercial Excess Liability'], lossCauses: { liability: 'LC03' } },
  PersonalExcessLiability: { topStates: ['PA', 'VA'], topCoverages: ['Personal Excess Liability'], lossCauses: { liability: 'LC03' } },
  GL: { topStates: ['IA', 'IN'], topCoverages: ['Premises/Operations', 'Products/Completed Operations'], lossCauses: { liability: 'LC03', advertising: 'LC88' } },
  InlandMarine: { topStates: ['PA', 'DE'], topCoverages: ['Inland Marine All Other'], lossCauses: { property: 'LC40', theft: 'LC08' } },
  FarmFire: { topStates: ['PA', 'VA'], topCoverages: ['Farmowners Building', 'Liability'], lossCauses: { fire: 'LC01' } },
};

// ── Helper: select first non-none option from a native <select> ───────────────
// NOTE: isVisible() is always immediate (Playwright ignores the timeout param
// on isVisible). Use waitFor({state:'visible'}) to actually poll.
async function selectFirstOption(page, selector, waitMs = 5000) {
  const el = page.locator(selector).first();
  const isVis = await el.waitFor({ state: 'visible', timeout: waitMs })
    .then(() => true).catch(() => false);
  if (!isVis) return;
  const firstVal = await el.locator('option:not([value=""]):not([value="none"])').first()
    .getAttribute('value').catch(() => null);
  if (firstVal) {
    await el.selectOption(firstVal);
    console.log(selector + ' => ' + firstVal);
    await page.waitForTimeout(300);
  }
}


//Helper for randon text generation for loss description
// Generate random text
function randomText(length = 25) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ';
  let text = '';
  for (let i = 0; i < length; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

// ── clickNewClaimCloud ────────────────────────────────────────────────────────
async function clickNewClaimCloud(page) {
  await clickTabMenuItem(page, 'ClaimTab', 'ClaimTab-ClaimTab_FNOLWizard');
  console.log('New Claim clicked');

  await page.getByRole('textbox', { name: 'Policy #' }).waitFor({ state: 'visible', timeout: 15000 });
  console.log('Find Policy screen confirmed');
}

// ── clickNewClaimOnPrem ───────────────────────────────────────────────────────
// This on-prem env is genuine classic ExtJS (x-btn-split class), NOT the Jutro
// UI cloud uses, despite looking visually similar. #TabBar:ClaimTab is an ExtJS
// SPLIT BUTTON: a single <a> element that does double duty - clicking its
// center switches to whatever claim tab is already open (same trap as cloud's
// label click), while clicking specifically on the right-edge arrow zone opens
// the dropdown (New Claim + recently viewed claims). Playwright's default
// .click() hits dead center, which is why plain clicks never opened this menu -
// confirmed via live codegen session getting stuck here. Fixed by clicking at
// an explicit position near the right edge instead of using the default center.
async function clickNewClaimOnPrem(page) {
  const baseUrl = BASE_URL;

  // Retry up to 3 times: the CC server occasionally fails to render the Find
  // Policy screen after the FNOLWizard dropdown click (mask timeout, session
  // redirect, or ExtJS split-button timing issue on retry runs).
  for (let attempt = 0; attempt < 3; attempt++) {
    // Navigate to CC root to tear down the page's JS context and clear any
    // ExtJS masks left over from a prior failed FNOL attempt.
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('.x-mask'))
             .every(m => getComputedStyle(m).display === 'none' ||
                         getComputedStyle(m).visibility === 'hidden' ||
                         m.getBoundingClientRect().width === 0),
      { timeout: 30000 }
    ).catch(() => {});

    const claimTab = page.locator('[id="TabBar:ClaimTab"]');
    const box = await claimTab.boundingBox().catch(() => null);
    if (!box) {
      console.log('clickNewClaimOnPrem: ClaimTab not found on attempt ' + (attempt + 1) + ', retrying...');
      continue;
    }
    // force:true bypasses the "element intercepted by mask" check so the click
    // reaches the split-button's right-edge arrow zone regardless of overlays.
    await claimTab.click({ position: { x: box.width - 5, y: box.height / 2 }, force: true });

    // Wait for the dropdown item to render before clicking it.
    const fnolItem = page.locator('[id="TabBar:ClaimTab:ClaimTab_FNOLWizard"]');
    const fnolVisible = await fnolItem.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (!fnolVisible) {
      console.log('clickNewClaimOnPrem: FNOLWizard dropdown not visible on attempt ' + (attempt + 1) + ', retrying...');
      continue;
    }
    await fnolItem.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const lossDateField = page.getByRole('textbox', { name: /Loss Date/i });
    // Increased from 15s to 30s: slow on-prem server can take 20+ seconds to
    // render the Find Policy screen after the FNOLWizard navigation.
    const lossDateVisible = await lossDateField.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
    if (lossDateVisible) {
      console.log('New Claim clicked (on-prem)');
      console.log('Find Policy screen confirmed (on-prem)');
      return;
    }
    // Also accept: CC restored a prior FNOL session (Loss Date is now a
    // read-only text display, not a textbox). Confirmed via repeated runs:
    // after a failed attempt, re-clicking FNOLWizard restores the session to
    // Step 1 with search results shown. The Search button is always present
    // and stable on Find Policy regardless of session state.
    const searchBtnVisible = await page.locator(
      '[id="FNOLWizard:FNOLWizard_FindPolicyScreen:FNOLWizardFindPolicyPanelSet:Search"]'
    ).waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (searchBtnVisible) {
      console.log('New Claim clicked (on-prem)');
      console.log('Find Policy screen confirmed (on-prem) [restored FNOL session]');
      return;
    }
    console.log('clickNewClaimOnPrem: Find Policy screen not reached on attempt ' + (attempt + 1) + ', retrying...');
  }

  throw new Error('clickNewClaimOnPrem: Find Policy screen not reached after 3 attempts');
}

// ── findFirstVisibleId ───────────────────────────────────────────────────────
// Returns the first id in `ids` that is currently visible, or null.
//
// This replaces the "probe each candidate with waitFor({state:'visible'})" loop
// that used to sit at every one of these decision points. That pattern pays the
// FULL timeout for every id that is ABSENT, which is the common case: the
// wizard shows exactly one of these buttons, so 4 of 5 probes always time out.
// At 5 ids x 3s that is 15s per call, and the main caller sits inside a
// 15-iteration loop - up to ~225s per FNOL spent waiting for elements that were
// never going to appear. One DOM query answers the question for every id at
// once, in a single round-trip.
//
// The one short retry preserves the only real benefit the old waits had: giving
// a still-rendering panel a moment to paint. Callers already wait for .x-mask
// to clear first, so a second pass is enough.
async function findFirstVisibleId(page, ids, retryMs = 1200) {
  const probe = () => page.evaluate((list) => {
    for (const id of list) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      return id;
    }
    return null;
  }, ids).catch(() => null);

  const first = await probe();
  if (first) return first;
  await page.waitForTimeout(retryMs);
  return probe();
}

// ── fillRequiredAcrossTabsCloud ──────────────────────────────────────────────
// Fills REQUIRED-and-unset fields on the current cloud step, visiting every tab
// on the screen. CC validates all tabs on Next but only renders one at a time,
// so a screen can look complete while a hidden tab still blocks the wizard.
//
// Only required fields are touched. Filling optional ones would fabricate data
// that has no on-prem counterpart and would surface as a false difference in
// the eventual cross-environment claim comparison.
async function fillRequiredAcrossTabsCloud(page) {
  const fillVisible = () => page.evaluate(() => {

    const out = [];
    const today = new Date();
    const mmddyyyy = String(today.getMonth() + 1).padStart(2, '0') + '/' +
                     String(today.getDate()).padStart(2, '0') + '/' + today.getFullYear();

    // A field is required if CC marks it so, or its label carries the asterisk.
    const isRequired = (el) => {
      if (el.required || el.getAttribute('aria-required') === 'true') return true;
      const box = el.closest('.jut__FieldComponent__fieldComponent, .jut__FieldComponent__field, div');
      return !!(box && /\*/.test((box.querySelector('label, span')?.textContent) || ''));
    };
    const label = (el) => {
      const box = el.closest('div');
      return ((box && box.querySelector('label, span')?.textContent) || el.name || el.id || 'field')
        .replace(/\*/g, '').trim().slice(0, 40);
    };

    for (const sel of document.querySelectorAll('select')) {
      if (!sel.offsetParent || !isRequired(sel)) continue;
      const cur = (sel.options[sel.selectedIndex]?.text || '').trim();
      if (!/^<?none>?$/i.test(cur)) continue;
      const opt = [...sel.options].find(o => o.text && !/^<?none>?$/i.test(o.text.trim()));
      if (!opt) continue;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      out.push(label(sel) + ' -> ' + opt.text.trim());
    }

    for (const inp of document.querySelectorAll('input[type="text"], input:not([type])')) {
      if (!inp.offsetParent || inp.readOnly || inp.disabled) continue;
      if (inp.value.trim() || !isRequired(inp)) continue;
      const ph = (inp.placeholder || '').toLowerCase();
      let val = null;
      if (ph.includes('mm/dd/yyyy')) val = mmddyyyy;
      else if (ph.includes('hh:mm'))  val = '09:00';
      else if (ph === 'aa')           val = 'AM';
      if (!val) continue;             // unknown shape - leave it for a human
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, val);          // React-safe: bypasses the value tracker
      inp.dispatchEvent(new Event('input',  { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      out.push(label(inp) + ' -> ' + val);
    }
    return out;
  }).catch(() => []);

  // Time + meridiem pairs need REAL TYPING, in order.
  //
  // "Time Employee Began Work" is two controls: an hh:mm box and a separate
  // "aa" box that only accepts AM/PM once a time has been entered (confirmed
  // via screenshot - the field stays required/red until BOTH are set). Setting
  // .value programmatically fills the first box but leaves the pair invalid,
  // because the meridiem control never receives the keystrokes it listens for.
  // pressSequentially drives it the way a person would.
  const fillTimePairs = async () => {
    const done = [];
    const hhmm = page.locator('input.gw-DateValueWidget--timeInput:visible');
    const n = await hhmm.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const t = hhmm.nth(i);

      // Fill this widget's DATE half if it is empty. A date/time widget with a
      // time but no date stays invalid - the probe caught exactly that on
      // "Date Employer Notified" (time 04:25, date blank).
      const dateInput = t.locator('xpath=../..//input[contains(@class,"gw-DateValueWidget--dateInput")]').first();
      if (await dateInput.isVisible().catch(() => false)) {
        if (!((await dateInput.inputValue().catch(() => 'x')) || '').trim()) {
          const d = new Date();
          const today = String(d.getMonth() + 1).padStart(2, '0') + '/' +
                        String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
          await dateInput.click().catch(() => {});
          await dateInput.pressSequentially(today, { delay: 30 }).catch(() => {});
          await dateInput.press('Tab').catch(() => {});
          done.push('date#' + (i + 1) + ' -> ' + today);
        }
      }

      if ((await t.inputValue().catch(() => 'x')).trim()) continue;   // time already set
      await t.click().catch(() => {});
      await t.pressSequentially('04:25', { delay: 40 }).catch(() => {});
      await page.waitForTimeout(250);
      // The meridiem box sits immediately after this one in the DOM.
      // The "aa" control is a CLICK-TO-SET meridiem toggle, not a text box: it
      // shows the literal "aa" until clicked, then flips to AM/PM. Typing into
      // it leaves it reading "aa" and the field stays required (confirmed via
      // screenshots of the empty vs filled state). Click it, then verify it
      // actually reads AM/PM rather than assuming the click landed.
      // The meridiem toggle, identified by in-flow DOM probe:
      //   <input type="button" class="gw-DateValueWidget--ampm-button" value="aa">
      // It carries NO placeholder - the label lives in its `value`, which is why
      // input[placeholder="aa"] matched nothing, the click never fired, and the
      // field silently stayed unset. Clicking cycles aa -> AM -> PM; the
      // committed value lands in a sibling hidden .gw-DateValueWidget--ampm.
      // Scoped to THIS widget rather than an index into a page-wide list, so it
      // cannot drift onto another row's control.
      const aa = t.locator('xpath=../..//input[contains(@class,"gw-DateValueWidget--ampm-button")]').first();
      let meridiem = 'aa';
      const aaExists = await aa.isVisible().catch(() => false);
      if (!aaExists) {
        // The locator found nothing, so the click never happened - that alone
        // explains MERIDIEM-NOT-SET. Dump what actually sits beside the hh:mm
        // box so the real control can be targeted instead of guessed at.
        const nbrs = await t.evaluate((el) => {
          const out = [];
          const row = el.closest('div')?.parentElement || el.parentElement;
          for (const n of (row ? row.querySelectorAll('*') : [])) {
            const txt = (n.textContent || '').trim();
            if (n.children.length > 2) continue;
            out.push({
              tag: n.tagName,
              type: n.getAttribute('type') || '',
              ph: n.getAttribute('placeholder') || '',
              role: n.getAttribute('role') || '',
              cls: (n.className || '').toString().slice(0, 60),
              txt: txt.slice(0, 20),
              val: n.value !== undefined ? String(n.value).slice(0, 10) : '',
            });
          }
          return out.slice(0, 14);
        }).catch(() => []);
        console.log('MERIDIEM PROBE (no input[placeholder="aa"]) neighbours of hh:mm #' +
                    (i + 1) + ': ' + JSON.stringify(nbrs));
      }
      if (aaExists) {
        for (let attempt = 0; attempt < 3; attempt++) {
          await aa.click().catch(() => {});
          await page.waitForTimeout(200);
          meridiem = ((await aa.inputValue().catch(() => '')) || '').trim().toUpperCase();
          if (/^(AM|PM)$/.test(meridiem)) break;
          // Some builds accept a keystroke instead of a click-cycle.
          await aa.press('a').catch(() => {});
          await page.waitForTimeout(200);
          meridiem = ((await aa.inputValue().catch(() => '')) || '').trim().toUpperCase();
          if (/^(AM|PM)$/.test(meridiem)) break;
        }
        await aa.press('Tab').catch(() => {});
      }
      done.push('time#' + (i + 1) + ' -> 04:25 ' + (/^(AM|PM)$/.test(meridiem) ? meridiem : 'MERIDIEM-NOT-SET'));
    }
    return done;
  };

  const all = [...await fillVisible(), ...await fillTimePairs()];

  // Only walk tabs INSIDE the current step, and verify each click didn't
  // navigate. Confirmed on BOP: a role="tab" on that screen was a wizard
  // navigation control, so clicking it jumped the flow back to "Step 1: Search
  // or Create Policy" - the run then tried to fill Loss Details while the Find
  // Policy screen was showing, and the wizard never completed. Snapshot the
  // step heading and bail out the moment it changes.
  const stepHeading = () => page.evaluate(() =>
    ((document.body.innerText || '').match(/Step\s*\d+\s*of\s*5[^\n]*/i) || [''])[0].trim()
  ).catch(() => '');
  const startingStep = await stepHeading();

  const tabs = page.getByRole('tab');
  const tabCount = await tabs.count().catch(() => 0);
  for (let i = 0; i < tabCount; i++) {
    const tab = tabs.nth(i);
    const name = (await tab.textContent().catch(() => '') || '').trim();
    if (!await tab.isVisible().catch(() => false)) continue;
    await tab.click().catch(() => {});
    await page.waitForTimeout(700);
    const nowStep = await stepHeading();
    if (startingStep && nowStep && nowStep !== startingStep) {
      console.log('cloud Step 3: tab "' + name + '" navigated away (' + startingStep + ' -> ' +
                  nowStep + ') — it is wizard navigation, not a form tab. Returning.');
      const backBtn = page.getByRole('button', { name: /^Back$/i }).first();
      for (let b = 0; b < 4 && (await stepHeading()) !== startingStep; b++) {
        if (!await backBtn.isVisible().catch(() => false)) break;
        await backBtn.click().catch(() => {});
        await page.waitForTimeout(1200);
      }
      break;
    }
    const filled = [...await fillVisible(), ...await fillTimePairs()];
    if (filled.length) console.log('cloud Step 3 [' + name + ']: ' + filled.join(' | '));
    all.push(...filled);
  }
  if (all.length) console.log('cloud Step 3: filled ' + all.length + ' required field(s)');
  else console.log('cloud Step 3: no unset required fields detected');

  // Confirm this pass did not move the wizard. On BOP the run reached Step 3,
  // ran this function, and the very next diagnostic showed Find Policy controls
  // - i.e. something here navigated backwards, and the tab guard did not fire,
  // so it was not a tab click. Report the actual before/after and walk forward
  // again rather than silently filling later steps into the wrong screen.
  const endStep = await stepHeading();
  if (startingStep && endStep && endStep !== startingStep) {
    console.log('cloud Step 3: WIZARD MOVED during required-field fill: "' +
                startingStep + '" -> "' + endStep + '" — recovering');
    for (let fwd = 0; fwd < 5; fwd++) {
      const cur = await stepHeading();
      if (cur === startingStep) break;
      const nextBtn = page.getByRole('button', { name: 'Next', exact: true }).first();
      if (!await nextBtn.isVisible().catch(() => false)) break;
      await nextBtn.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
    console.log('cloud Step 3: after recovery we are on "' + (await stepHeading()) + '"');
  }
  return all;
}

// ── satisfyNamedRequiredFields ───────────────────────────────────────────────
// Reads the fields ClaimCenter itself reports as missing ('X : Missing required
// field "X"') and fills each one BY ACCESSIBLE NAME. Returns the names handled.
//
// Driving off CC's own message is what makes this reliable: the wording carries
// the exact accessible name of the control, so there is no DOM-shape guessing.
// Earlier attempts that keyed on a red asterisk, on a ":_msgs" element, and on
// <label> text all matched nothing, because these screens label fields with
// plain <div>/<span> while the inputs carry proper accessible names.
//
// Handles the three shapes these required fields take:
//   radio  - confirmation questions ("Is the year selected ... correct?") -> Yes
//   combo  - pickers that display a value without committing it -> re-select it
//   text   - free text -> a generic value
async function satisfyNamedRequiredFields(page) {
  const names = await page.evaluate(() => {

    const t = document.body.innerText || document.body.textContent || '';
    return [...new Set([...t.matchAll(/Missing required field\s*"([^"]+)"/gi)].map(m => m[1]))];
  }).catch(() => []);
  if (!names.length) return [];

  const done = [];
  for (const name of names) {
    // ORDER MATTERS. The radio branch used to run FIRST and matched by "a group
    // containing this field's name", which is far too loose: the group holding
    // the required TEXT field "Occupation" also holds the neighbouring question
    // "Lost time from work? Yes/No", so it clicked THAT question's Yes, logged
    // "Occupation=Yes", and left Occupation empty - silently setting an
    // unrelated WC field while the wizard stayed stuck (confirmed via
    // screenshot + five identical retries in the log).
    // Exact-name text and combobox matches are unambiguous, so try them first
    // and only fall back to a radio when the field is itself a question.

    // 1. Plain text field.
    const tb = page.getByRole('textbox', { name, exact: true }).first();
    if (await tb.isVisible().catch(() => false)) {
      const value = /occupation/i.test(name) ? 'Laborer' : 'Automated E2E';
      await tb.fill(value).catch(() => {});
      await tb.press('Tab').catch(() => {});
      done.push(name + '=' + value); continue;
    }

    // 2. Combobox showing a value CC has not accepted - re-pick it so the
    //    model commits (confirmed on cloud Basic Info: "Name" displayed
    //    "DONEGAL DIRECT ACCOUNT" while flagged invalid).
    const cb = page.getByRole('combobox', { name, exact: true }).first();
    if (await cb.isVisible().catch(() => false)) {
      const opts = await cb.locator('option').allTextContents().catch(() => []);
      const real = opts.find(o => o && !/^<?none>?$/i.test(o.trim()));
      if (real) {
        const ok = await cb.selectOption({ label: real }).then(() => true).catch(() => false);
        if (ok) { done.push(name + '=' + real.trim()); continue; }
      }
      await cb.click().catch(() => {});
      const opt = page.getByRole('option').filter({ hasNotText: /^<?none>?$/i }).first();
      if (await opt.isVisible().catch(() => false)) {
        const txt = (await opt.textContent().catch(() => '') || '').trim();
        await opt.click().catch(() => {});
        done.push(name + '=' + txt); continue;
      }
    }

    // 3. Yes/No — ONLY when the required field is itself a question. Without
    //    this guard the radio branch hijacks a neighbouring question's answer
    //    (see the ordering note above).
    if (!/\?\s*$/.test(name)) {
      console.log('satisfyNamedRequiredFields: no text/combobox control named "' + name +
                  '" and it is not a Yes/No question — leaving it for a human');
      continue;
    }
    const grp = page.getByRole('group').filter({ hasText: name }).first();
    const yes = grp.getByRole('radio', { name: /^Yes$/i }).first();
    if (await yes.isVisible().catch(() => false)) {
      await yes.check({ force: true }).catch(() => yes.click({ force: true }).catch(() => {}));
      done.push(name + '=Yes');
    }
  }
  return done;
}


// ── Cloud exposure helpers ───────────────────────────────────────────────────
// All three transcribed from a codegen recording of the live flow — see
// docs/cloud-exposure-flow.recorded.md. Do not "improve" these into
// aria-label/DOM-scoping variants: the recording proves plain role+name works,
// and the earlier hand-rolled versions all failed.

// The New Exposure screen is identified by its Update button - the only
// dependable signal that a coverage click actually opened a form rather than
// expanding another submenu.
async function onCloudNewExposureScreen(page, timeout = 8000) {
  // WAIT for the form rather than sampling instantly. The whole menu chain was
  // clicking correctly, but this returned false while the New Exposure screen
  // was still rendering, so the walk concluded "not a leaf" and moved on to the
  // next grouper - the classic instant-check-after-a-fixed-pause mistake.
  return page.getByRole('button', { name: 'Update' }).first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true).catch(() => false);
}

async function openCloudActionsMenu(page) {
  const btn = page.getByRole('button', { name: 'deferred Actions' }).first();
  if (!await btn.isVisible().catch(() => false)) return false;
  await btn.click().catch(() => {});
  await page.waitForTimeout(900);
  return true;
}

// Walks Choose by Coverage -> grouper -> leaf and returns the coverage actually
// selected, or null. Menu entries are clicked ONE LEVEL AT A TIME.
//
// Leaves and groupers do not share a role: groupers resolve as menuitem, while
// the deepest entry resolved via getByLabel in the recording
// ("Business Income (including"). Try both at every level.
async function pickCloudCoverage(page, labels) {
  // Walk the coverage tree by ID INDEX, not by name.
  //
  // The New Exposure menu ids encode the whole path (from a codegen recording,
  // see docs/cloud-exposure-flow.recorded.md):
  //   ...NewExposureMenuItemSet_ByCoverage-<grouper>-item-<coverage>-item-<leaf>-item
  //   Collision     -> ByCoverage-2-item-1-item-0-item
  //   Comprehensive -> ByCoverage-4-item-2-item-0-item
  //
  // Name matching cannot work here and every attempt to make it work failed:
  // "Collision" exists as BOTH a grouper and its own leaf, the vehicle label is
  // "FORD F350 (VIN#: 31138)" while the menu displays "2022 FORD F350", and
  // groupers/leaves do not share a role. Indices are unambiguous.
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = labels.map(norm);
  const matches = t => wanted.some(w => norm(t) === w || norm(t).includes(w) || w.includes(norm(t)));

  pickCloudCoverage._opened = new Set();   // per-call, not shared across exposures

  const cbc = page.getByLabel('Choose by Coverage', { exact: true }).first();
  if (!await cbc.isVisible().catch(() => false)) {
    console.log('CLOUD exposure: "Choose by Coverage" not available');
    return null;
  }
  await cbc.click().catch(() => {});
  await page.waitForTimeout(1000);

  // Every ByCoverage node currently in the DOM, with its depth and text.
  const nodes = async () => page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[id*="NewExposureMenuItemSet_ByCoverage-"]')) {
      const m = el.id.match(/ByCoverage((?:-\d+-item)+)$/);
      if (!m) continue;
      const depth = (m[1].match(/-item/g) || []).length;
      // Read the node's OWN label, not innerText. A container's innerText
      // concatenates every descendant ("CoCollisionCoCollisionTETransportation
      // Expense - Rental Reimbursement"), so a PARENT matches the target before
      // its real leaf does - which is why the walk kept stopping one level short.
      const own = el.querySelector(':scope > .gw-label[aria-label]')
               || el.querySelector(':scope > * > .gw-label[aria-label]');
      const text = own
        ? (own.getAttribute('aria-label') || own.textContent || '').trim()
        : (el.getAttribute('aria-label') || '').replace(/^deferred\s+/, '').trim();
      // The DOM says outright whether an entry opens a submenu or fires an
      // action, so leaf-vs-grouper needs no guessing:
      //   grouper: aria-haspopup="true"  data-gw-click="toggleSubMenu"
      //   leaf   : aria-haspopup="false" data-gw-click="fireEvent id:^"
      const isLeaf = el.getAttribute('aria-haspopup') === 'false' ||
                     /fireEvent/.test(el.getAttribute('data-gw-click') || '');
      out.push({ id: el.id, depth, text, isLeaf });
    }
    return out;
  }).catch(() => []);

  // Click the INNER .gw-label, not the outer container. Clicking the container
  // was accepted but expanded nothing: "-2-item -> clicked" was followed by
  // "-2-item-1-item -> NOT VISIBLE" on every pass. The recording drives these
  // with getByLabel('FORD F350 (VIN#: 31138)'), which resolves to the label div
  // — that is what carries the expand behaviour.
  // Use the SAME locator forms the recording used, in the same order:
  //   getByLabel('FORD F350 (VIN#: 31138)')                  -> grouper
  //   locator('#<id>').getByRole('menuitem', { name })       -> leaf
  // Clicking the id container (or its .gw-label) reported "clicked" but expanded
  // nothing, so the child never rendered. getByLabel resolves whatever element
  // actually owns that label, which is what the recording proves works.
  // ancestors EXPAND (hover), leaves ACTIVATE (click).
  //
  // Observed live: clicking a vehicle moves the selection between vehicles but
  // never opens the branch — "-2-item -> clicked" followed by
  // "-2-item-1-item -> NOT VISIBLE" on every pass. That is standard desktop
  // menu behaviour: hover opens a submenu, click only selects. The top-level
  // Actions button is the exception (data-gw-click="toggleSubMenu"), which is
  // what misled the earlier click-everything approach.
  const clickNode = async (node, mode = 'select') => {
    if (node.text) {
      // SCOPED FIRST, exactly as the recording does:
      //   locator('#<id>').getByRole('menuitem', { name: 'Collision' })
      // A global getByLabel('Collision').first() matches the GROUPER, because
      // the same name exists at two levels - so the leaf click kept re-opening
      // the branch instead of activating it. Same principle as the on-prem
      // walk: scope to the panel, never match across the whole page.
      const scoped = page.locator('[id="' + node.id + '"]')
        .getByRole('menuitem', { name: node.text, exact: false }).first();
      if (await scoped.isVisible().catch(() => false)) {
        if (mode === 'expand') {
          await scoped.hover().catch(() => {});
          await page.waitForTimeout(1100);
          return true;
        }
        await scoped.click().catch(() => {});
        await page.waitForTimeout(1200);
        return true;
      }

      const byLabel = page.getByLabel(node.text, { exact: true }).first();
      if (await byLabel.isVisible().catch(() => false)) {
        if (mode === 'expand') {
          await byLabel.hover().catch(() => {});
          await page.waitForTimeout(1100);
          return true;
        }
        await byLabel.click().catch(() => {});
        await page.waitForTimeout(1000);
        return true;
      }
    }
    const container = page.locator('[id="' + node.id + '"]').first();
    if (!await container.isVisible().catch(() => false)) return false;
    await container.click().catch(() => {});
    await page.waitForTimeout(1000);
    return true;
  };
  // Ancestors are known only by id; look up their text from the current tree.
  const clickId = async (id, mode = 'select') => {
    const node = (await nodes()).find(n => n.id === id) || { id, text: null };
    return clickNode(node, mode);
  };

  // Ancestors of ByCoverage-2-item-1-item-0-item are
  // ByCoverage-2-item and ByCoverage-2-item-1-item.
  const ancestorsOf = (id) => {
    const head = id.slice(0, id.indexOf('ByCoverage') + 'ByCoverage'.length);
    const tail = id.slice(head.length);
    const parts = tail.split('-item').filter(Boolean);   // ['-2','-1','-0']
    const out = [];
    let acc = head;
    for (let i = 0; i < parts.length - 1; i++) { acc += parts[i] + '-item'; out.push(acc); }
    return out;
  };

  // The tree renders lazily, so open groupers until a matching leaf appears.
  for (let pass = 0; pass < 40; pass++) {
    const all = await nodes();
    // Take the DEEPEST match. "Collision" exists at depth 2 (grouper) and
    // depth 3 (leaf, -2-item-1-item-0-item); clicking the depth-2 one only
    // expands the submenu, so .find() stalled one level short of the form.
    // A real LEAF is the only thing that opens the New Exposure screen. The DOM
    // flags it (aria-haspopup="false" / data-gw-click="fireEvent"), so prefer a
    // flagged leaf and fall back to the deepest match only if none is flagged.
    const named = all.filter(n => n.text && matches(n.text));
    const leaf = named.filter(n => n.isLeaf).sort((a, b) => b.depth - a.depth)[0]
              || named.filter(n => n.depth >= 2).sort((a, b) => b.depth - a.depth)[0];
    if (leaf) {
      console.log('CLOUD exposure: target leaf "' + leaf.text + '" at ' + leaf.id.split('ByCoverage')[1]);
      // Report each hop. clickId's result was being discarded, so a failed
      // ancestor click looked identical to a successful one and the walk moved
      // on to the next grouper with no indication of which step broke.
      for (const a of ancestorsOf(leaf.id)) {
        const ok = await clickId(a, 'expand');
        console.log('CLOUD exposure:   ancestor ' + a.split('ByCoverage')[1] + ' -> ' + (ok ? 'clicked' : 'NOT VISIBLE'));
      }
      const leafOk = await clickId(leaf.id);
      console.log('CLOUD exposure:   leaf ' + leaf.id.split('ByCoverage')[1] + ' -> ' + (leafOk ? 'clicked' : 'NOT VISIBLE'));
      if (await onCloudNewExposureScreen(page)) {
        console.log('CLOUD exposure: selected coverage "' + leaf.text + '" (New Exposure screen open)');
        return leaf.text;
      }
      // Some coverages need one more level (e.g. Collision > Collision).
      const deeper = (await nodes())
        .filter(n => n.id.startsWith(leaf.id) && n.depth > leaf.depth)
        .sort((a, b) => a.depth - b.depth);
      if (deeper.length && await clickId(deeper[0].id) && await onCloudNewExposureScreen(page, 6000)) {
        console.log('CLOUD exposure: selected sub-coverage "' + deeper[0].text + '"');
        return deeper[0].text;
      }
    }

    // No match visible yet - open the next unopened grouper.
    const openedIds = pickCloudCoverage._opened || (pickCloudCoverage._opened = new Set());
    const next = all.find(n => n.depth === 1 && !n.isLeaf && !openedIds.has(n.id))
              || all.find(n => n.depth === 1 && !openedIds.has(n.id));
    if (!next) { console.log('CLOUD exposure: every grouper opened, no matching coverage found'); break; }
    openedIds.add(next.id);
    console.log('CLOUD exposure: opening grouper "' + next.text + '"');
    if (!await clickId(next.id, 'expand')) break;
  }
  pickCloudCoverage._opened = null;
  return null;
}

// Fills the New Exposure screen and presses Update. The form is native
// <select>s addressed by label; their values are per-claim codes (Person:5829,
// Address:6407, LC03), so options are chosen at RUN TIME rather than hardcoded.
async function fillCloudNewExposure(page, coverageLabel) {
  const update = page.getByRole('button', { name: 'Update' }).first();
  if (!await update.isVisible().catch(() => false)) {
    console.log('CLOUD exposure: New Exposure screen did not open for "' + coverageLabel + '"');
    return false;
  }

  // Every visible required <select> still on "<none>" gets its first real
  // option. Covers Claimant Number / Cause of Loss / Claimant / Type /
  // Litigation Status / Location without hardcoding claim-specific codes.
  // Claimant Number must be UNIQUE across the exposures on a claim. Taking the
  // first real option gave every exposure 150, so the second Update was refused
  // - and refused SILENTLY: nothing was marked aria-invalid, no modal opened,
  // and the failure looked like a missing required field. The recording shows
  // the same rejection ("first number rejected, changed, retry"). Track what
  // this claim has already consumed and skip those.
  // Seed from the PERSISTED per-policy store, not just this run: CC rejects a
  // number used on any other claim for the policy, so a fresh claim that starts
  // again at 150 is refused by every claim created before it.
  if (!page._cloudUsedClaimantNumbers) {
    page._cloudUsedClaimantNumbers = page._policyNumber
      ? new Set(getUsedClaimantNumbers(page._policyNumber)) : new Set();
  }
  const usedClaimants = [...page._cloudUsedClaimantNumbers];

  const result = await page.evaluate((used) => {
    const usedSet = new Set(used);
    const done = [];
    let claimantPicked = null;
    for (const sel of document.querySelectorAll('select')) {
      if (!sel.offsetParent || sel.disabled) continue;
      const cur = (sel.options[sel.selectedIndex] || {}).text || '';
      const name = (sel.getAttribute('aria-label') || sel.name || '');
      const isClaimantNumber = /claimant\s*number/i.test(name) ||
        /claimant\s*number/i.test(
          ((sel.closest('[id$="_Input"]') || {}).querySelector
            ? (sel.closest('[id$="_Input"]').querySelector('.gw-label') || {}).textContent || '' : ''));

      // A claimant number that is already taken must be CHANGED even though it
      // is not "<none>" - the generic skip-if-set rule is what let 150 stand.
      const isNone = !cur || /^<?none>?$/i.test(cur.trim());
      if (!isNone && !(isClaimantNumber && usedSet.has(cur.trim()))) continue;

      const opt = [...sel.options].find(o => {
        const t = (o.text || '').trim();
        if (!t || /^<?none>?$/i.test(t)) return false;
        return !(isClaimantNumber && usedSet.has(t));
      });
      if (!opt) continue;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      if (isClaimantNumber) claimantPicked = (opt.text || '').trim();
      done.push((name || 'field').slice(0, 30) + '=' + opt.text.trim().slice(0, 24));
    }
    return { done, claimantPicked };
  }, usedClaimants).catch(() => ({ done: [], claimantPicked: null }));

  const filled = result.done || [];
  if (result.claimantPicked) {
    page._cloudUsedClaimantNumbers.add(result.claimantPicked);
    if (page._policyNumber) addUsedClaimantNumber(page._policyNumber, result.claimantPicked);
  }
  if (filled.length) {
    console.log('CLOUD exposure: set ' + filled.join(' | ') +
                (result.claimantPicked ? '  [claimant# ' + result.claimantPicked + ']' : ''));
  }

  // Required free-text (e.g. Description on property coverages).
  const desc = page.getByRole('textbox', { name: 'Description', exact: true }).first();
  if (await desc.isVisible().catch(() => false)) {
    if (!((await desc.inputValue().catch(() => 'x')) || '').trim()) {
      await desc.fill('Automated E2E exposure').catch(() => {});
    }
  }

  // Incident sub-popup. Coverage-dependent, exactly as on-prem: Collision needs
  // a Vehicle Incident, Bodily Injury needs an Injury Incident, property
  // coverages need none. From the recording:
  //   #...-Vehicle_Incident-Vehicle_IncidentMenuIcon -> options -> New Incident...
  //   fill the popup -> OK
  // Without this the exposure cannot save and Update simply stays on screen.
  // Check the OPTIONS BUTTON, not its wrapper. The *_IncidentMenuIcon element
  // is a zero-size container, so isVisible() on it returned false and the whole
  // incident step was skipped silently - the same "checked the wrong element"
  // mistake as the claim-search row. The recording targets the button inside it.
  {
    const optionsBtn = page.locator('[id*="_IncidentMenuIcon"]')
      .getByRole('button', { name: 'options' }).first();
    if (await optionsBtn.isVisible().catch(() => false)) {
      await optionsBtn.click().catch(() => {});
      await page.waitForTimeout(800);
      const newIncident = page.getByLabel('New Incident...').first();
      if (await newIncident.isVisible().catch(() => false)) {
        await newIncident.click().catch(() => {});
        await page.waitForTimeout(1800);
        console.log('CLOUD exposure: Incident popup opened — filling');

        // Same run-time approach as the main form: every required <select>
        // still on "<none>" takes its first real option, required text gets a
        // value. Popup field sets differ per coverage (vehicle vs injury), so
        // nothing is hardcoded.
        const popupFilled = await page.evaluate(() => {
          const done = [];
          for (const sel of document.querySelectorAll('select')) {
            if (!sel.offsetParent || sel.disabled) continue;
            const cur = (sel.options[sel.selectedIndex] || {}).text || '';
            if (cur && !/^<?none>?$/i.test(cur.trim())) continue;
            const opt = [...sel.options].find(o => o.text && !/^<?none>?$/i.test(o.text.trim()));
            if (!opt) continue;
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            done.push(opt.text.trim().slice(0, 20));
          }
          for (const inp of document.querySelectorAll('textarea, input[type="text"]')) {
            if (!inp.offsetParent || inp.readOnly || inp.disabled || inp.value.trim()) continue;
            const ph = (inp.placeholder || '').toLowerCase();
            if (ph.includes('mm/dd/yyyy') || ph.includes('hh:mm') || ph === 'aa') continue;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            try { setter.call(inp, 'Automated E2E'); } catch (_) { inp.value = 'Automated E2E'; }
            inp.dispatchEvent(new Event('input',  { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }
          // Unanswered Yes/No questions default to No, matching the recording.
          for (const rg of document.querySelectorAll('[role="radiogroup"]')) {
            if (!rg.offsetParent) continue;
            const radios = [...rg.querySelectorAll('[role="radio"], input[type="radio"]')];
            if (radios.some(r => r.checked || r.getAttribute('aria-checked') === 'true')) continue;
            const no = radios.find(r => /^no$/i.test(r.getAttribute('aria-label') || r.value || ''));
            if (no) no.click();
          }
          return done;
        }).catch(() => []);
        if (popupFilled.length) console.log('CLOUD exposure: incident popup set ' + popupFilled.join(' | '));

        const ok = page.getByRole('button', { name: 'OK' }).first();
        if (await ok.isVisible().catch(() => false)) {
          await ok.click().catch(() => {});
          await page.waitForTimeout(2000);
          console.log('CLOUD exposure: incident popup OK clicked');
        }
      }
    }
  }

  // FILL -> UPDATE -> READ CC'S VALIDATION -> FIX -> RETRY, the same loop that
  // made incidents work. One Update press with a single retry left the exposure
  // half-built and the run moved to the next coverage; CC usually needs several
  // rounds because fixing one field reveals the next.
  let saved = false;
  let lastState = null;
  for (let round = 0; round < 8 && !saved; round++) {
    // Answer radios on EVERY round, including the first. "Reserve Required?" is
    // required from the moment the New Exposure screen opens, so gating this on
    // round > 0 guaranteed the first Update was always rejected. The incident
    // loop already does it this way.
    await answerCloudRadioGroups(page);

    // Yes/No questions CC names WITHOUT a "field : problem" form. Its message
    // for these is just the question text ("Reserve Required?"), so
    // fixFieldsFromValidation's "<field> : <problem>" regex never matched and
    // the question was never answered - the exposure failed on the same item
    // for eight rounds. Pull anything ending in "?" out of the validation area
    // and answer it directly.
    await answerUnansweredYesNoPairs(page);

    let bumped = null;
    if (round > 0) {
      // Read CC's actual complaint first. The claimant-number pool is shared
      // across claims on a policy, so a number free on THIS claim can still be
      // refused - and the refusal is only ever stated here.
      const vtext = await readCloudValidation(page);
      if (/claimant number/i.test(vtext)) {
        bumped = await bumpCloudClaimantNumber(page, page._cloudUsedClaimantNumbers);
        if (bumped) {
          page._cloudUsedClaimantNumbers.add(bumped);
          if (page._policyNumber) addUsedClaimantNumber(page._policyNumber, bumped);
          console.log('CLOUD exposure: claimant number rejected — retrying with ' + bumped);
        } else {
          console.log('CLOUD exposure: claimant number rejected but no unused number remains');
        }
      } else if (vtext) {
        console.log('CLOUD exposure: CC validation — ' + vtext);
      }

      const fixedFields = await fixFieldsFromValidation(page);
      const named = await satisfyNamedRequiredFields(page);
      if (fixedFields.length || named.length) {
        console.log('CLOUD exposure: round ' + (round + 1) + ' fixed ' +
                    [...fixedFields, ...named].slice(0, 5).join(', '));
      }
    }

    // Do not press Update against unchanged data - it just re-renders the same
    // errors and burns a round. Radio state is part of "changed" here: answering
    // a question alters no input value, so a value-only signature made the loop
    // conclude "changed nothing" right after a successful radio answer.
    const stateNow = await page.evaluate(() =>
      [...document.querySelectorAll('input[type="text"], textarea, select')]
        .filter(e => e.offsetParent).map(e => e.value).join('|') + '#' +
      [...document.querySelectorAll('[aria-checked="true"], input:checked')]
        .filter(e => e.offsetParent).map(e => e.id || e.getAttribute('aria-label') || '1').join('|')
    ).catch(() => '');
    if (round > 0 && stateNow === lastState && !bumped) {
      console.log('CLOUD exposure: round ' + (round + 1) + ' changed nothing — stopping');
      break;
    }
    lastState = stateNow;

    await page.waitForTimeout(500);
    await update.click().catch(() => {});
    await page.waitForTimeout(2500);
    saved = !(await update.isVisible().catch(() => false));
  }

  if (saved) {
    console.log('CLOUD exposure: "' + coverageLabel + '" SAVED');
  } else {
    const vtext = await readCloudValidation(page);
    const bad = await cloudInvalidFields(page);
    console.log('CLOUD exposure: "' + coverageLabel + '" NOT saved. CC says: ' +
                (vtext || '(Validation Results panel empty)') +
                (bad.length ? ' | invalid fields: ' + bad.map(b => b.label + ' [' + b.reason + ']').join(', ') : ''));

    // With no invalid field to explain the rejection, the next candidate is a
    // modal sitting over the screen and eating the Update clicks: these radio
    // widgets declare data-gw-change="gwRadioDiv.radioDivChangeConfirmWrapper",
    // so answering one can raise a confirmation dialog.
    const modal = await page.evaluate(() => {
      const d = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .gw-modal, [class*="Modal"], [class*="popup"]')]
        .filter(e => e.offsetParent);
      return d.map(e => ({
        id: e.id || '', cls: (e.className || '').toString().slice(0, 60),
        text: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      })).slice(0, 3);
    }).catch(() => []);
    if (modal.length) {
      for (const m of modal) console.log('CLOUD exposure: MODAL OPEN id="' + m.id + '" class="' + m.cls + '" — ' + m.text);
    } else {
      console.log('CLOUD exposure: no modal open');
    }

    // Where are we actually? "Update still visible" is an inference, not an
    // observation - if the exposure saved and the next screen also carries an
    // Update button, this reports failure on a success.
    const whereNow = await page.evaluate(() => {
      const onNewExposure = [...document.querySelectorAll('[id^="NewExposure-NewExposureScreen"]')]
        .some(e => e.offsetParent);
      const heading = [...document.querySelectorAll('[role="heading"], h1, h2, .gw-title')]
        .filter(e => e.offsetParent).map(e => (e.textContent || '').trim()).slice(0, 4).join(' / ');
      return { onNewExposure, heading: heading.slice(0, 160) };
    }).catch(() => ({}));
    console.log('CLOUD exposure: still on New Exposure screen? ' + whereNow.onNewExposure +
                ' | headings: ' + (whereNow.heading || '(none)'));

    if (process.env.CC_DEBUG) {
    const msgs = await page.evaluate(() => {
      const out = [];
      for (const e of document.querySelectorAll('*')) {
        const key = (e.id || '') + ' ' + (e.className || '').toString();
        if (!/rror|essage|otification|arning|alida/i.test(key)) continue;
        const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 400) continue;
        out.push({ id: e.id || '', cls: (e.className || '').toString().slice(0, 45),
                   vis: !!e.offsetParent, text: t.slice(0, 200) });
      }
      return out.slice(0, 10);
    }).catch(() => []);
    console.log('CLOUD exposure: message-ish elements -> ' +
                (msgs.length ? JSON.stringify(msgs, null, 1) : '(none)'));

    const updates = await page.evaluate(() => {
      const lbl = [...document.querySelectorAll('.gw-label')]
        .find(e => e.offsetParent && /^update$/i.test((e.textContent || '').trim()));
      if (!lbl) return [];
      const chain = [];
      let e = lbl;
      for (let i = 0; i < 4 && e; i++, e = e.parentElement) {
        chain.push({
          lvl: i, tag: e.tagName, id: e.id || '(no id)',
          role: e.getAttribute('role') || '', cls: (e.className || '').toString().slice(0, 55),
          click: e.getAttribute('data-gw-click') || '',
          aria: e.getAttribute('aria-label') || '',
          disabled: e.getAttribute('aria-disabled') || '',
          visible: !!e.offsetParent,
        });
      }
      return chain;
    }).catch(() => []);
    console.log('CLOUD exposure: Update candidates -> ' +
                (updates.length ? JSON.stringify(updates) : '(none found)'));

    const screenText = await page.evaluate(() => {
      // Take the LARGEST NewExposure container, not the first: the first match
      // is the title widget, whose innerText is just the coverage name.
      const all = [...document.querySelectorAll('[id^="NewExposure"]')].filter(e => e.offsetParent);
      const s = all.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0];
      return s ? (s.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2000) : '(screen not found)';
    }).catch(() => '(unreadable)');
    console.log('CLOUD exposure: SCREEN TEXT -> ' + screenText);
    }

    if (process.env.CC_DEBUG) {
      const dump = await page.evaluate(() => {
        const hits = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          if (!/Reserve Required/i.test(n.textContent || '')) continue;
          // Anchor on the field wrapper. Every field on this screen is a
          // <div id="...<Field>_Input" class="gw-InputWidget">; walking a fixed
          // number of ancestors instead landed on the whole DetailView body and
          // the dump truncated before reaching the control itself.
          const el = n.parentElement.closest('[id$="_Input"]') || n.parentElement.parentElement;
          hits.push((el.outerHTML || '').slice(0, 1800));
          if (hits.length >= 2) break;
        }
        return hits;
      }).catch(() => []);
      for (const [i, h] of dump.entries()) console.log('--- RESERVE REQUIRED DOM #' + i + ' ---\n' + h);
    }
  }
  return saved;
}


// ── addCloudIncidents ────────────────────────────────────────────────────────
// Clicks Add Vehicle / Add Injury / Add Property Damage on cloud FNOL Step 3,
// filling each popup. Mirrors the on-prem approach of creating incidents during
// Loss Details instead of from the exposure screen.
//
// Only the buttons this LOB actually renders are used, so an auto claim gets a
// vehicle, a WC claim an injury, and a property claim property damage - without
// the caller needing to know which.
async function addCloudIncidents(page) {
  const created = [];
  for (const name of ['Add Vehicle', 'Add Injury', 'Add Property Damage']) {
    const btn = page.getByRole('button', { name, exact: true }).first();
    if (!await btn.isVisible().catch(() => false)) continue;

    await btn.click().catch(() => {});
    await page.waitForTimeout(1800);

    const filled = await page.evaluate(() => {
      const done = [];
      for (const sel of document.querySelectorAll('select')) {
        if (!sel.offsetParent || sel.disabled) continue;
        const cur = (sel.options[sel.selectedIndex] || {}).text || '';
        if (cur && !/^<?none>?$/i.test(cur.trim())) continue;
        const opt = [...sel.options].find(o => o.text && !/^<?none>?$/i.test(o.text.trim()));
        if (!opt) continue;
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        done.push(opt.text.trim().slice(0, 18));
      }
      // Date/time fields were being SKIPPED here. That exclusion was copied
      // from a context where dates are handled separately, but on an incident
      // popup a required date is simply left blank - CC reports it and the
      // incident never saves. Fill them like any other required field.
      const d = new Date();
      const today = String(d.getMonth() + 1).padStart(2, '0') + '/' +
                    String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
      for (const inp of document.querySelectorAll('textarea, input[type="text"]')) {
        if (!inp.offsetParent || inp.readOnly || inp.disabled || inp.value.trim()) continue;
        const ph = (inp.placeholder || '').toLowerCase();
        let val = 'Automated E2E';
        if (ph.includes('mm/dd/yyyy')) val = today;
        else if (ph.includes('hh:mm'))  val = '09:00';
        else if (ph === 'aa')           continue;   // meridiem toggle, clicked below
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        try { setter.call(inp, val); } catch (_) { inp.value = val; }
        inp.dispatchEvent(new Event('input',  { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        done.push((ph || 'text') + '=' + val);
      }
      // Meridiem toggles: click-to-set, same control as the FNOL date widgets.
      for (const b of document.querySelectorAll('input.gw-DateValueWidget--ampm-button')) {
        if (!b.offsetParent) continue;
        if (/^(AM|PM)$/i.test((b.value || '').trim())) continue;
        b.click();
      }
      for (const rg of document.querySelectorAll('[role="radiogroup"]')) {
        if (!rg.offsetParent) continue;
        const radios = [...rg.querySelectorAll('[role="radio"], input[type="radio"]')];
        if (radios.some(r => r.checked || r.getAttribute('aria-checked') === 'true')) continue;
        const no = radios.find(r => /^no$/i.test(r.getAttribute('aria-label') || r.value || ''));
        if (no) no.click();
      }
      return done;
    }).catch(() => []);

    // VERIFY the detail view actually closed. Clicking OK and assuming it
    // worked left the Vehicle Incident screen open ("VehIncidentDetailDV...
    // Vehicle_Picker" was still on screen right after "incident created"), and
    // the rest of Loss Details was then filled into the wrong form.
    // "Back on Loss Details" is the reliable signal, not "no incident element
    // on the page": [id*="IncidentDV"] also matches the incident LIST that
    // lives on Loss Details permanently, so that check could never return true
    // and reported failure even when OK had worked.
    const detailGone = async () =>
      page.getByRole('button', { name: 'Add Vehicle', exact: true }).first()
        .isVisible().catch(() => false);

    // FILL -> OK, REPEATEDLY. Confirmed by recording: "Add Vehicle" needs TWO
    // OK presses - the first commits the vehicle details, then a SECOND panel
    // appears asking for Damage Description and needs its own OK. Pressing OK
    // once and treating "still open" as failure is what made the run skip the
    // incident and move on. Each round re-fills whatever new fields appeared.
    let saved = false;
    let lastState = null;
    for (let round = 0; round < 10 && !saved; round++) {
      if (round > 0) {
        const more = await fillIncidentFields(page);
        if (more.length) console.log('cloud Step 3: ' + name + ' round ' + (round + 1) + ' filled ' + more.slice(0, 4).join(', '));
      }
      // Known numeric fields, set explicitly by accessible name.
      //
      // The generic filler kept writing "Automated E2E" into these, CC rejected
      // and cleared them, and the next round wrote the same bad value again -
      // a loop that burned all 10 rounds (confirmed via the validation panel:
      // "Loss Estimate: must be a numeric value", "Number of Occupants: must be
      // an integer", "Vehicle Valuation: must be a numeric value"). Playwright's
      // accessible-name lookup resolves these reliably, so name them directly
      // rather than inferring numeric-ness from the DOM.
      await answerCloudRadioGroups(page);
      await fixFieldsFromValidation(page);
      // Skip the OK press when nothing changed since the last round - pressing
      // it against identical data just burns a round and re-renders the same
      // errors. If two consecutive rounds fix nothing, stop and report.
      const stateNow = await page.evaluate(() =>
        [...document.querySelectorAll('input[type="text"], textarea, select')]
          .filter(e => e.offsetParent).map(e => e.value).join('|')
      ).catch(() => '');
      if (round > 0 && stateNow === lastState) {
        console.log('cloud Step 3: ' + name + ' round ' + (round + 1) +
                    ' changed nothing — not pressing OK again');
        break;
      }
      lastState = stateNow;

      let pressed = false;
      for (const label of ['OK', 'Update', 'Add', 'Done']) {
        const btn = page.getByRole('button', { name: label, exact: true }).first();
        if (!await btn.isVisible().catch(() => false)) continue;
        await btn.click().catch(() => {});
        await page.waitForTimeout(1800);
        pressed = true;
        break;
      }
      if (!pressed) break;
      if (await detailGone()) {
        saved = true;
        console.log('cloud Step 3: ' + name + ' -> incident created (' + (round + 1) + ' round(s))' +
                    (filled.length ? ' [' + filled.slice(0, 4).join(', ') + ']' : ''));
      }
    }
    if (saved) { created.push(name.replace(/^Add /, '')); continue; }

    // NO CANCEL FALLBACK. Cancelling discarded the part-built incident and
    // moved on, which is what looked like "ignoring the validation". Leave the
    // screen exactly as it is and report what CC is actually complaining about,
    // so the next run has something to act on rather than a clean page.
    const why = await page.evaluate(() => {
      const t = (document.body.innerText || '') + ' ' + (document.body.textContent || '');
      const msgs = [...t.matchAll(/([^.\n]{0,80}(?:required|invalid|must be|cannot|not a valid|numeric)[^.\n]{0,80})/gi)]
        .map(m => m[1].trim());
      return [...new Set(msgs)].slice(0, 5);
    }).catch(() => []);
    console.log('cloud Step 3: ' + name + ' NOT saved after 10 rounds — leaving the screen open. ' +
                (why.length ? 'CC says: ' + why.join(' || ') : 'CC reported no validation text.'));
    break;   // do not start another incident on top of an unfinished one
  }
  if (!created.length) console.log('cloud Step 3: no incident Add buttons on this screen');
  return created;
}


// Answers unanswered Yes/No questions using PLAYWRIGHT locators.
//
// The in-page version used raw DOM .click() on [role="radio"] elements, which
// does not register with the framework - CC kept reporting
// 'Missing required field "Is there a loan on the Vehicle?"' even though the
// clicks appeared to happen. The recording drives these as
//   getByRole('radiogroup', { name }).getByLabel('No', { exact: true }).click()
// which is a real user-style click and does take effect.
async function answerCloudRadioGroups(page) {
  const answered = [];
  const groups = page.getByRole('radiogroup');
  const count = await groups.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const grp = groups.nth(i);
    if (!await grp.isVisible().catch(() => false)) continue;

    // Skip groups that already have a selection.
    const checked = await grp.locator('[aria-checked="true"], input:checked').count().catch(() => 0);
    if (checked > 0) continue;

    const label = ((await grp.getAttribute('aria-label').catch(() => '')) ||
                   (await grp.innerText().catch(() => '')) || '').split(String.fromCharCode(10))[0].trim();
    // "No" is the safe default for these incident questions (loan, extra
    // coverage, towing, ambulance, lost wages), matching the recorded flow.
    for (const answer of ['No', 'Yes']) {
      const opt = grp.getByLabel(answer, { exact: true }).first();
      if (!await opt.isVisible().catch(() => false)) continue;
      await opt.click().catch(() => {});
      await page.waitForTimeout(300);
      answered.push((label || 'question').slice(0, 40) + '=' + answer);
      break;
    }
  }
  if (answered.length) console.log('cloud Step 3: radios answered — ' + answered.join(' | '));
  return answered;
}

// Answers a Yes/No question that CC named in its validation message but that is
// NOT exposed as role="radiogroup" - "Reserve Required?" on the New Exposure
// screen is the case that forced this.
//
// This is deliberately NARROW. An earlier version scanned every radio on the
// page and grouped them by name attribute; these controls have no name, so each
// radio became its own group, no "No" was found, and it clicked the last option
// in each - setting Yes on 22 unrelated questions and flip-flopping them every
// round. Only questions CC explicitly complains about are touched, and only
// when a genuine Yes/No pair sits under one container.
// Pulls question-style items ("Reserve Required?") out of CC's validation area.
// Scoped to the message container rather than the whole body: the exposure form
// itself renders every question caption, so a body-wide sweep would return each
// one and we would answer questions CC never complained about.
// Creates every exposure on the claim currently open. Lifted out of completeFNOL
// so the CC_EXISTING_CLAIM reuse path can run it too - reuse used to return
// straight after opening the claim, which meant the fast iteration loop skipped
// the exact step being debugged and every "fix" had to be proven through a full
// 2-minute FNOL.
// Counts exposures on the claim from the cloud grid. countExposuresOnClaim is
// ExtJS-only (.x-grid-row / .x-column-header-text), so on cloud it always
// returned -1 and could not distinguish "no exposure" from "one already made
// at FNOL".
async function countCloudExposures(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[id*="ExposuresLV-"]')]
      .filter(e => e.offsetParent && /ExposuresLV-\d+-(Coverage|CoverageType)$/.test(e.id) &&
                   /\S/.test(e.innerText || ''))
      .length
  ).catch(() => 0);
}

async function addCloudExposures(page, exposures) {
  let cloudAdded = 0;
  for (const exposure of exposures) {
    const labels = Array.isArray(exposure.coverageLabel)
      ? exposure.coverageLabel : [exposure.coverageLabel];

    // Reset to the claim before each exposure. Exposure 1 leaves the page
    // mid-menu (or on a half-open New Exposure screen) when it fails, and
    // exposure 2 then reported "no Actions menu on this screen" - not a
    // regression, just a missing reset.
    for (let esc = 0; esc < 3; esc++) { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(200); }
    const cancel0 = page.getByRole('button', { name: 'Cancel' }).first();
    if (await cancel0.isVisible().catch(() => false)) {
      await cancel0.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    let opened = await openCloudActionsMenu(page);
    if (!opened) {
      const claimNo = page._currentClaimNumber || null;
      if (claimNo) {
        console.log('CLOUD exposure: Actions menu missing — re-opening claim ' + claimNo);
        await openExistingClaim(page, claimNo).catch(() => {});
        opened = await openCloudActionsMenu(page);
      }
    }
    if (!opened) { console.log('CLOUD exposure: no Actions menu on this screen'); break; }

    const chosen = await pickCloudCoverage(page, labels);
    if (!chosen) {
      for (let esc = 0; esc < 4; esc++) await page.keyboard.press('Escape').catch(() => {});

      // Some LOBs create their exposure during FNOL and then offer no New
      // Exposure menu at all - WC is one: its Actions menu has no
      // ClaimMenuActions_NewExposure grouper, and the claim already carries
      // "Workers' Compensation And Employers' Liability". Reporting "0 of 1
      // created" there was a reporting bug, not a missing exposure, and it
      // made every downstream step look broken for the wrong reason.
      const existing = await countCloudExposures(page);
      if (existing > 0) {
        console.log('CLOUD exposure: no New Exposure menu on this claim, but it already has ' +
                    existing + ' exposure(s) from FNOL — nothing to add for [' + labels.join(', ') + ']');
        cloudAdded++;
        continue;
      }
      console.log('CLOUD exposure: none of [' + labels.join(', ') + '] could be selected ' +
                  '(and the claim has no exposures)');
      continue;
    }

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2000);

    const saved = await fillCloudNewExposure(page, chosen);
    if (saved) {
      cloudAdded++;
    } else {
      // An exposure must be saved before the next is started. Leaving a
      // half-built one on screen made the NEXT exposure open from a broken
      // state and fail for an unrelated-looking reason.
      console.log('CLOUD exposure: "' + chosen + '" did not save — cancelling before the next coverage');
      const cancel = page.getByRole('button', { name: 'Cancel', exact: true }).first();
      if (await cancel.isVisible().catch(() => false)) {
        await cancel.click().catch(() => {});
        await page.waitForTimeout(1800);
      }
    }
  }
  console.log('CLOUD exposure: ' + cloudAdded + ' of ' + exposures.length + ' exposure(s) created');
  return cloudAdded;
}

// Answers every UNANSWERED Yes/No pair on the current screen and reports what it
// touched. "Reserve Required?" is not exposed as role="radiogroup", and CC names
// it in its message without the "field : problem" form, so neither
// answerCloudRadioGroups nor fixFieldsFromValidation could reach it - the
// exposure failed on that same item every round. Scoping to CC's message
// container was tried first and matched nothing, so this works off the FORM.
//
// The safety property the earlier broken version lacked: a candidate must be a
// container holding BOTH a "Yes" and a "No" with NO current selection. Grouping
// loose radios by their (absent) name attribute made every radio its own group,
// so nothing looked like a pair and the fallback clicked the last option in each
// - setting Yes on 22 unrelated questions and flip-flopping them every round.
// Reports which fields CC is actually rejecting, read from the WIDGET STATE
// rather than from page text.
//
// The previous reporter grepped document.body for /required|must be|invalid/
// and so matched the form's own captions: it reported "Reserve Required?" as an
// outstanding problem when that field was a role="radiogroup" already showing
// aria-checked="true" on "No". Four fixes were written against that phantom.
// The cloud widgets carry the truth directly - aria-invalid="true" when CC has
// flagged the value, and class gw-required on widgets that must be non-empty.
// CC's real validation text on cloud lives in the "Validation Results"
// worksheet docked in #gw-south-panel - NOT inline on the field and NOT in a
// modal. Missing this is what made the New Exposure failures look silent:
// aria-invalid was clean, no dialog was open, and scraping document.body only
// returned the form's own captions.
async function readCloudValidation(page) {
  return page.evaluate(() => {
    const p = document.getElementById('gw-south-panel');
    if (!p || !p.offsetParent) return '';
    return (p.innerText || '').replace(/\s+/g, ' ').replace(/^\s*Validation Results\s*/i, '')
      .replace(/^\s*Clear\s*/i, '').trim().slice(0, 400);
  }).catch(() => '');
}

// Selects the next Claimant Number not already consumed. The pool is shared
// ACROSS CLAIMS on a policy ("This claimant number already exists on another
// claim"), so a per-run set is not enough - the persisted per-policy store is
// the same one the on-prem flow uses.
async function bumpCloudClaimantNumber(page, usedSet) {
  const picked = await page.evaluate((used) => {
    const usedArr = new Set(used);
    for (const sel of document.querySelectorAll('select')) {
      if (!sel.offsetParent || sel.disabled) continue;
      const wrap = sel.closest('[id$="_Input"]');
      const lbl  = wrap && wrap.querySelector('.gw-label');
      const name = (sel.getAttribute('aria-label') || sel.name || '') + ' ' +
                   ((lbl && lbl.textContent) || '');
      if (!/claimant\s*number/i.test(name)) continue;
      const cur = ((sel.options[sel.selectedIndex] || {}).text || '').trim();
      const opt = [...sel.options].find(o => {
        const t = (o.text || '').trim();
        return t && !/^<?none>?$/i.test(t) && t !== cur && !usedArr.has(t);
      });
      if (!opt) return null;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return (opt.text || '').trim();
    }
    return null;
  }, [...usedSet]).catch(() => null);
  if (picked) await page.waitForTimeout(400);
  return picked;
}

async function cloudInvalidFields(page) {
  return page.evaluate(() => {
    const labelOf = (w) => {
      const byId = w.getAttribute('aria-labelledby');
      if (byId) {
        const l = document.getElementById(byId);
        if (l) return (l.textContent || '').trim();
      }
      const wrap = w.closest('[id$="_Input"]');
      const lbl  = wrap && wrap.querySelector('.gw-label');
      return ((lbl && lbl.textContent) || w.getAttribute('aria-label') || w.id || '?').trim();
    };
    const out = [];
    for (const w of document.querySelectorAll('[aria-invalid="true"]')) {
      if (!w.offsetParent) continue;
      out.push({ label: labelOf(w).slice(0, 50), reason: 'aria-invalid', id: w.id || '' });
    }
    for (const w of document.querySelectorAll('.gw-required')) {
      if (!w.offsetParent) continue;
      const ctl = w.querySelector('select, input[type="text"], textarea');
      const hasRadio = w.querySelector('[role="radio"][aria-checked="true"], input:checked');
      const empty = ctl ? !(ctl.value || '').trim() : !hasRadio;
      if (!empty) continue;
      const label = labelOf(w).slice(0, 50);
      if (out.some(o => o.label === label)) continue;
      out.push({ label, reason: 'required but empty', id: w.id || '' });
    }
    return out.slice(0, 10);
  }).catch(() => []);
}

async function answerUnansweredYesNoPairs(page) {
  const targets = await page.evaluate(() => {
    const txt  = (e) => (e.getAttribute('aria-label') || e.textContent || '').trim();
    const isYN = (e) => /^(yes|no)$/i.test(txt(e));

    const seen = new Set();
    const out  = [];
    for (const el of document.querySelectorAll('input[type="radio"], [role="radio"], label, .gw-label, span')) {
      if (!el.offsetParent || !/^no$/i.test(txt(el))) continue;

      // Walk up to the smallest container that also holds a "Yes".
      let row = el.parentElement;
      for (let i = 0; i < 5 && row; i++, row = row.parentElement) {
        const opts = [...row.querySelectorAll('input[type="radio"], [role="radio"], label, .gw-label, span')]
          .filter(e => e.offsetParent && isYN(e));
        if (!opts.some(e => /^yes$/i.test(txt(e)))) continue;
        if (opts.length > 6) break;                 // too broad - a panel, not one question
        if (seen.has(row)) break;
        seen.add(row);

        const checked = [...row.querySelectorAll('[aria-checked="true"], input:checked')]
          .some(e => e.offsetParent);
        if (checked) break;                         // already answered

        const caption = (row.innerText || '').replace(/\byes\b|\bno\b/gi, '').trim()
          .split(String.fromCharCode(10)).filter(Boolean).pop() || '(unlabelled)';
        if (!el.id) el.id = 'e2e-yn-' + Math.random().toString(36).slice(2, 8);
        out.push({ id: el.id, caption: caption.slice(0, 50) });
        break;
      }
    }
    return out.slice(0, 8);
  }).catch(() => []);

  const done = [];
  for (const { id, caption } of targets) {
    const el = page.locator('[id="' + id + '"]').first();
    if (!await el.isVisible().catch(() => false)) continue;
    await el.click().catch(() => {});
    await page.waitForTimeout(300);
    done.push(caption + '=No');
  }
  if (done.length) console.log('cloud: Yes/No answered — ' + done.join(' | '));
  return done;
}

async function answerNamedYesNoQuestion(page, question) {
  const target = await page.evaluate((q) => {
    const wanted = q.trim().toLowerCase();
    const leaves = [...document.querySelectorAll('div, span, label')]
      .filter(e => e.children.length === 0 &&
                   (e.textContent || '').trim().toLowerCase().replace(/\s*\*$/, '') === wanted &&
                   e.offsetParent);
    for (const lbl of leaves) {
      let row = lbl.parentElement;
      for (let i = 0; i < 6 && row; i++, row = row.parentElement) {
        const opts = [...row.querySelectorAll(
          'input[type="radio"], [role="radio"], label, .gw-label, span')]
          .filter(e => e.offsetParent && /^(yes|no)$/i.test((e.getAttribute('aria-label') ||
                                                             e.textContent || '').trim()));
        const yes = opts.find(e => /^yes$/i.test((e.getAttribute('aria-label') || e.textContent || '').trim()));
        const no  = opts.find(e => /^no$/i.test((e.getAttribute('aria-label') || e.textContent || '').trim()));
        if (!yes || !no) continue;                       // not a Yes/No pair - keep walking up
        const already = [...row.querySelectorAll('[aria-checked="true"], input:checked')]
          .some(e => e.offsetParent);
        if (already) return { done: true };
        if (!no.id) no.id = 'e2e-yn-' + Math.random().toString(36).slice(2, 8);
        return { id: no.id };
      }
    }
    return null;
  }, question).catch(() => null);

  if (!target) return false;
  if (target.done) return true;

  const el = page.locator('[id="' + target.id + '"]').first();
  if (!await el.isVisible().catch(() => false)) return false;
  await el.click().catch(() => {});
  await page.waitForTimeout(300);
  console.log('cloud: answered "' + question + '" -> No');
  return true;
}

// Numeric fields CC validates strictly, addressed by accessible name.
// Extend this list as new ones surface rather than trying to infer numeric-ness
// from surrounding DOM text - that inference failed repeatedly because the
// caption sits outside the input and the field's own value reads back first.
const CLOUD_NUMERIC_FIELDS = [
  ['Loss Estimate',       '1000'],
  ['Number of Occupants', '2'],
  ['Vehicle Valuation',   '5000'],
  ['PPD Percentage',      '15'],
  ['Property Damage Estimate', '1000'],
];

// Fills ONLY what ClaimCenter says is wrong, using the type its own message
// implies. This replaces blanket-filling every text box with "Automated E2E",
// which was the root of the churn here: it put words into numeric fields, CC
// rejected them, and each fix attempt only added more guessing about which
// fields were numeric. CC already states both the field and the problem.
async function fixFieldsFromValidation(page) {
  const problems = await page.evaluate(() => {
    const t = (document.body.innerText || '') + ' ' + (document.body.textContent || '');
    const out = [];
    for (const m of t.matchAll(/([A-Z][^:\n]{2,60}?)\s*:\s*(must be a numeric value|must be an integer[^\n]{0,40}|Missing required field[^\n]{0,60})/g)) {
      out.push({ field: m[1].trim(), problem: m[2].trim() });
    }
    return out.slice(0, 12);
  }).catch(() => []);
  if (!problems.length) return [];

  // Locate each field IN THE DOM by its caption and write with the native
  // setter. getByRole('textbox', { name: 'Loss Estimate' }) does not match a
  // "$" money box - its accessible name is the adornment, not the caption - so
  // fill() threw and the swallowed error made it look like the value was set.
  // The DOM route demonstrably reaches these inputs: it is how "Automated E2E"
  // ended up in them in the first place.
  const done = await page.evaluate((items) => {
    const out = [];
    const setNative = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur',   { bubbles: true }));
    };
    for (const { field, numeric } of items) {
      // Start from the LABEL ELEMENT, not from each input. Walking 5 ancestors
      // up from an input reaches the whole panel, whose text contains EVERY
      // caption - so searching for "Loss Estimate" matched the panel and took
      // the first input in it. That is how "Property Description" ended up
      // holding 1000 while "Loss Estimate" kept the text value.
      const wanted = field.trim().toLowerCase();
      let target = null;
      // CONTAINS, not equals. CC's message yields "Stories" for a field whose
      // caption is "# of Stories" (the name capture starts at a letter), so an
      // exact match reported FIELD NOT FOUND. Matching on leaf elements only
      // keeps this safe - it is the caption itself, never a whole panel.
      const labels = [...document.querySelectorAll('div, span, label')]
        .filter(e => {
          if (e.children.length !== 0) return false;
          const t = (e.textContent || '').trim().toLowerCase().replace(/\s*\*$/, '');
          return t.length > 0 && t.length < 60 && (t === wanted || t.includes(wanted));
        })
        .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      // Look for a SELECT as well as a text box. "Cause of Loss Description" is
      // a dropdown (the recording uses selectOption('all_other')), so writing
      // text into it left CC still reporting the field as missing even though
      // the value visibly changed.
      for (const lbl of labels) {
        let row = lbl.parentElement;
        for (let i = 0; i < 4 && row && !target; i++, row = row.parentElement) {
          const el = row.querySelector('select, input[type="text"], textarea');
          if (el && el.offsetParent && !el.readOnly && !el.disabled) target = el;
        }
        if (target) break;
      }
      if (!target) { out.push(field + ' -> FIELD NOT FOUND'); continue; }

      // Dropdowns take an OPTION, not typed text.
      if (target.tagName === 'SELECT') {
        const opt = [...target.options].find(o => o.text && !/^<?none>?$/i.test(o.text.trim()));
        if (!opt) { out.push(field + ' -> select has no selectable option'); continue; }
        target.value = opt.value;
        target.dispatchEvent(new Event('change', { bubbles: true }));
        out.push(field + ' -> selected "' + opt.text.trim().slice(0, 24) + '"');
        continue;
      }

      // Small-integer fields: 1000 is silly for "# of Dependents Under 18" and
      // some of these cap the value, so prefer a low number for counts.
      const isCount = /\bno\.|number of|# of|dependents|occupants|stories|children/i.test(field);
      const want = numeric ? (isCount ? '2' : '1000') : 'Automated E2E';
      setNative(target, want);
      // READ IT BACK. Reporting "filled" without checking is why ten identical
      // rounds went by with the value unchanged - each round claimed success
      // and pressed OK against the same bad data.
      const got = (target.value || '').trim();
      out.push(field + ' -> wrote "' + want + '", now reads "' + got + '"' +
               (got === want ? '' : '  <-- WRITE DID NOT STICK'));
    }
    return out;
  }, problems.map(p => ({ field: p.field, numeric: /numeric|integer/i.test(p.problem) })))
    .catch(() => []);
  if (done.length) console.log('cloud Step 3: fixed from validation — ' + done.join(', '));
  return done;
}

async function fixKnownNumericFields(page) {
  const fixed = [];
  for (const [label, value] of CLOUD_NUMERIC_FIELDS) {
    const box = page.getByRole('textbox', { name: label, exact: false }).first();
    if (!await box.isVisible().catch(() => false)) continue;
    const cur = ((await box.inputValue().catch(() => '')) || '').trim();
    if (/^[\d,.]+$/.test(cur) && cur.length) continue;   // already numeric
    await box.fill(value).catch(() => {});
    await box.press('Tab').catch(() => {});
    fixed.push(label + '=' + value);
  }
  // MONEY fields expose "$" as their accessible name, not their caption -
  // confirmed by the recording: getByRole('textbox', { name: '$' }).fill(...).
  // That is why "Number of Occupants" (a plain box) was fixed by name while
  // "Loss Estimate" and "Vehicle Valuation" kept their bad text: those lookups
  // matched nothing. Fill every "$" box that is not already numeric.
  // Target the attribute directly. getByRole({ name: '$' }) matched on one run
  // and not the next - accessible-name resolution for a "$" adornment is not
  // dependable - whereas the aria-label is always present on these inputs.
  const money = page.locator('input[aria-label="$"]');
  const moneyCount = await money.count().catch(() => 0);
  console.log('cloud Step 3: money fields found = ' + moneyCount);
  for (let i = 0; i < moneyCount; i++) {
    const box = money.nth(i);
    if (!await box.isVisible().catch(() => false)) continue;
    const cur = ((await box.inputValue().catch(() => '')) || '').trim();
    if (cur && /^[\d,.]+$/.test(cur)) continue;
    await box.fill('1000').catch(() => {});
    await box.press('Tab').catch(() => {});
    fixed.push('$#' + (i + 1) + '=1000');
  }

  if (fixed.length) console.log('cloud Step 3: numeric fields set — ' + fixed.join(', '));
  return fixed;
}

// Fills every visible unset field in an incident popup and returns what it set.
// Called once per fill->OK round because these popups reveal further panels
// after each OK (Add Vehicle: details -> OK -> Damage Description -> OK).
async function fillIncidentFields(page) {
  return page.evaluate(() => {
    const done = [];
    // Known answers first (from the recorded flow). Picking blindly chose
    // "Boat" for Select vehicle on an auto claim, which pulls in a different
    // required-field set than a car and made the cascade longer than it needs
    // to be. Anything not listed still falls through to first-real-option.
    const PREFERRED = {
      'was the vehicle parked?': /^yes$/i,
      'driver type'           : /listed/i,
      'is this loss:'         : /collision/i,
      'general injury type'   : /specific/i,
      'select vehicle'        : /car|sedan|truck|suv|van|20\d\d/i,
      'property name'         : /new/i,
    };
    for (const sel of document.querySelectorAll('select')) {
      if (!sel.offsetParent || sel.disabled) continue;
      const label = (sel.getAttribute('aria-label') ||
                     (sel.closest('div')?.innerText || '').split(String.fromCharCode(10))[0] ||
                     '').trim().toLowerCase();
      const want = PREFERRED[label];
      if (!want) continue;
      const cur = (sel.options[sel.selectedIndex] || {}).text || '';
      if (cur && !/^<?none>?$/i.test(cur.trim())) continue;
      const opt = [...sel.options].find(o => want.test(o.text || ''));
      if (!opt) continue;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      done.push(label + '=' + opt.text.trim().slice(0, 16));
    }
    for (const sel of document.querySelectorAll('select')) {
      if (!sel.offsetParent || sel.disabled) continue;
      const cur = (sel.options[sel.selectedIndex] || {}).text || '';
      if (cur && !/^<?none>?$/i.test(cur.trim())) continue;
      const opt = [...sel.options].find(o => o.text && !/^<?none>?$/i.test(o.text.trim()));
      if (!opt) continue;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      done.push(opt.text.trim().slice(0, 18));
    }
    const d = new Date();
    const today = String(d.getMonth() + 1).padStart(2, '0') + '/' +
                  String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
    for (const inp of document.querySelectorAll('textarea, input[type="text"]')) {
      if (!inp.offsetParent || inp.readOnly || inp.disabled || inp.value.trim()) continue;
      // Only TEXTAREAS get a default value. Filling every text input with
      // "Automated E2E" put words into numeric boxes (Loss Estimate, Vehicle
      // Valuation), which CC rejected - and no amount of detecting which ones
      // were numeric fixed the underlying mistake of writing to fields nobody
      // asked us to fill. Anything genuinely required is reported by CC and
      // handled by fixFieldsFromValidation().
      if (inp.tagName !== 'TEXTAREA') continue;
      const ph = (inp.placeholder || '').toLowerCase();
      // Read the label from further up the tree - for "$"-prefixed money fields
      // the caption lives outside the input's immediate parent, which is why
      // "Loss Estimate" and "Vehicle Valuation" were not recognised as numeric.
      // ACCUMULATE ancestor text; do not stop at the first non-empty line. The
      // previous version halted as soon as it had 3+ characters, and the
      // immediate parent's first line is the field's OWN VALUE
      // ("Automated E2E"), so it kept reading back what it had just written
      // instead of the caption - leaving Loss Estimate / Vehicle Valuation /
      // Number of Occupants unrecognised as numeric.
      let lbl = (inp.getAttribute('aria-label') || '').toLowerCase();
      let anc = inp.parentElement;
      for (let i = 0; i < 5 && anc; i++, anc = anc.parentElement) {
        lbl += ' ' + (anc.innerText || '').slice(0, 120).toLowerCase();
      }
      // A "$" adornment next to the box marks a money field outright.
      const isMoney = /\$/.test(lbl) || (inp.previousElementSibling &&
                      /\$/.test(inp.previousElementSibling.textContent || ''));

      // DEFAULT TO NUMERIC. CC rejected "Automated E2E" on Loss Estimate,
      // Number of Occupants and Vehicle Valuation (confirmed via validation
      // panel), and guessing which fields are numeric kept missing new ones.
      // A digit string is accepted by free-text fields too, so only fields that
      // are clearly prose get words.
      const isTextArea = inp.tagName === 'TEXTAREA';
      // Money fields are never prose, whatever else the surrounding text says.
      const prose = !isMoney && (isTextArea ||
        /descript|comment|explain|remark|note|name|address|city|county|street/.test(lbl));
      let val = prose ? 'Automated E2E' : '100';
      if (isMoney) val = '1000';
      if (/occupant/.test(lbl))       val = '1';
      else if (/valuation|estimate|amount|value/.test(lbl)) val = '1000';
      if (ph.includes('mm/dd/yyyy')) val = today;
      else if (ph.includes('hh:mm'))  val = '09:00';
      else if (ph === 'aa')           continue;
      else if (ph.includes('#####') || /zip|postal/.test(lbl)) val = '17601';
      else if (/percent/.test(lbl))   val = '15';
      else if (/year/.test(lbl))      val = String(d.getFullYear());
      else if (/phone/.test(lbl))     val = '6105551234';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      try { setter.call(inp, val); } catch (_) { inp.value = val; }
      inp.dispatchEvent(new Event('input',  { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      done.push(val.slice(0, 18));
    }
    for (const rg of document.querySelectorAll('[role="radiogroup"]')) {
      if (!rg.offsetParent) continue;
      const radios = [...rg.querySelectorAll('[role="radio"], input[type="radio"]')];
      if (radios.some(r => r.checked || r.getAttribute('aria-checked') === 'true')) continue;
      const no = radios.find(r => /^no$/i.test(r.getAttribute('aria-label') || r.value || ''));
      if (no) no.click();
    }
    return done;
  }).catch(() => []);
}

// ── coverageMaybeAvailable ───────────────────────────────────────────────────
// True when `label` could still match one of the coverage leaves already seen
// on this claim's menu (or when none have been seen yet, so we don't know).
// Uses the SAME normalised comparison addExposureByCoverage uses to match, so
// it can never rule out a label the matcher would have accepted.
function coverageMaybeAvailable(page, label) {
  const cache = page._coverageLeafCache;
  if (!cache || cache.size === 0) return true;   // nothing observed yet - must try
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(label);
  for (const leaf of cache) {
    if (leaf === label) return true;
    const n = norm(leaf);
    if (n === target || n.includes(target) || target.includes(n)) return true;
  }
  return false;
}

// The wizard's terminal button varies by LOB: auto uses Finish, property/WC use
// "Save & Assign Claim". Declared once so the three probe sites cannot drift.
const FINISH_BUTTON_IDS = [
  'FNOLWizard:Finish', 'FNOLWizard:SaveAndAssign', 'FNOLWizard:SaveAndAssignClaim',
  'FNOLWizard:Submit', 'FNOLWizard:FinishWizard',
];

// Verbose DOM dumps (every visible FNOLWizard id - ~475 entries) are diagnostic
// only. Set CC_DEBUG=1 to re-enable them.
const CC_DEBUG = process.env.CC_DEBUG === '1';

// ── searchPolicy ──────────────────────────────────────────────────────────────
// policyType: optional preferred PolicyType dropdown value (e.g. 'Personal Auto',
// 'Commercial auto'). Threaded from the spec because searchPolicy has no other
// way to know the LOB, and picking the wrong entry files the claim under the
// wrong policy type.
// ── clickCloudAction ─────────────────────────────────────────────────────────
// Clicks a CLOUD gw-action control, but fails fast and explains itself when the
// control is DISABLED rather than missing.
//
// Cloud renders buttons as <div role="button" aria-disabled="true|false"
// data-gw-click="..."> - Playwright's click() waits for "enabled", so a disabled
// button burns the full 30s action timeout and then reports only
// "locator.click: Timeout 30000ms exceeded", which says nothing about WHY.
// Confirmed live on cloud FNOL: '#FNOLWizard-Next [role="button"]' resolved fine
// but carried aria-disabled="true" - the wizard could not advance because a
// required field upstream was unsatisfied. Surfacing the on-screen validation
// text turns a 30s mystery into an actionable message, the same tactic that
// resolved the on-prem Surcharging and close-exposure failures.
async function clickCloudAction(page, selector, label, timeout = 15000) {
  const el = page.locator(selector).first();
  const appeared = await el.waitFor({ state: 'visible', timeout })
    .then(() => true).catch(() => false);
  if (!appeared) {
    throw new Error('CLOUD_UI: "' + label + '" control not found (' + selector + ')');
  }

  const disabled = await el.evaluate(node => {
    const self = node.getAttribute('aria-disabled');
    if (self === 'true') return true;
    // The disabled flag can sit on an ancestor wrapper rather than the inner
    // role=button div, so walk up a few levels before declaring it enabled.
    let p = node.parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      if (p.getAttribute && p.getAttribute('aria-disabled') === 'true') return true;
    }
    return false;
  }).catch(() => false);

  if (disabled) {
    const why = await page.evaluate(() => {

      const out = [];
      for (const el of document.querySelectorAll(
        '[class*="error"], [class*="Error"], [role="alert"], [id$="_msgs"], [class*="validation"]')) {
        const t = (el.innerText || '').trim();
        if (t && el.offsetParent !== null) out.push(t);
      }
      if (!out.length) {
        for (const line of (document.body.innerText || '').split('\n')) {
          const t = line.trim();
          if (t && !t.endsWith('?') &&
              /required|must be|missing|invalid|cannot|not allowed/i.test(t)) out.push(t);
        }
      }
      return [...new Set(out)].slice(0, 8);
    }).catch(() => []);

    // An empty results grid is the single most common reason a wizard Next is
    // disabled, and it produces NO validation text at all - so the generic
    // message above reported "(none found)" and sent the reader hunting for a
    // missing field when the DOM plainly said "No data to display" (confirmed
    // on cloud DEV: the policy simply is not in that instance). Detect the
    // empty-grid state explicitly and name it.
    // Scoped to the Search Results group only. A page-wide scan matched the
    // Claims History grid's own empty state and produced a false
    // "policy does not exist" on a screen where the policy WAS found.
    const emptyGrid = await page.getByRole('group', { name: /Search Results/i }).first()
      .getByText(/No data to display|No results found|No records found/i).first()
      .isVisible().then(v => (v ? 'No data to display' : null)).catch(() => null);
    if (emptyGrid) {
      // Tagged POLICY_DATA_ERROR so completeFNOL's existing retry rotates to the
      // NEXT policy in the env var instead of failing the suite outright. A
      // policy that is absent from this particular instance is bad test DATA,
      // not an automation fault, and the rotation was built for exactly that.
      throw new Error('POLICY_DATA_ERROR: CLOUD_SEARCH_EMPTY - "' + label + '" is disabled because ' +
                      'the search returned no rows ("' + emptyGrid + '"). This policy does not ' +
                      'exist in this environment, or the loss date falls outside its term.');
    }
    throw new Error('CLOUD_UI: "' + label + '" is DISABLED (aria-disabled=true) - the screen is ' +
                    'not satisfied yet, so the wizard cannot advance. On-screen validation: ' +
                    (why.length ? why.join(' || ') : '(none found)'));
  }

  await el.click({ timeout });
}

async function searchPolicy(page, policyNumber, lossDate, policyType) {
  if (IS_ON_PREM) {
    await clickNewClaimOnPrem(page);

    // Loss Date and Policy # ARE role-accessible here (confirmed via codegen -
    // this ExtJS instance renders proper labels, same as the login fields).
    // IMPORTANT: filling Policy # immediately after Loss Date without a
    // Tab+settle first was observed to silently lose the Policy # value - the
    // Loss Date's change handler seems to trigger a partial re-render that
    // wipes an in-flight fill in the next field. Tab+wait after each field
    // avoids that race.
    //
    // If CC restored a prior FNOL session (Loss Date is now a read-only text
    // display), skip refilling and go straight to the sweep + Next click.
    const lossDateField = page.getByRole('textbox', { name: /Loss Date/i });
    const lossDateEditable = await lossDateField.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);

    if (lossDateEditable) {
      await lossDateField.fill(lossDate);
      await lossDateField.press('Tab');
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});
      console.log('Loss Date filled: ' + lossDate);

      const policyField = page.locator(
        '[id="FNOLWizard:FNOLWizard_FindPolicyScreen:FNOLWizardFindPolicyPanelSet:policyNumber-inputEl"]'
      );
      await policyField.click();
      await policyField.fill(policyNumber);
      await policyField.press('Tab');
      console.log('Policy # filled: ' + policyNumber);

      await page.locator(
        '[id="FNOLWizard:FNOLWizard_FindPolicyScreen:FNOLWizardFindPolicyPanelSet:Search"]'
      ).click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      // Policy search can trigger slow AJAX on on-prem servers — wait up to 30s
      // (was 10s, which caused Next click to race with a still-active mask).
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 30000 }).catch(() => {});
      console.log('Policy search submitted (on-prem)');

      // GL LOB (and potentially others) expose a required LossType combobox on the
      // Find Policy screen that Auto LOBs don't have. Fill it before Next or CC
      // silently blocks the wizard on Step 1 with no visible validation message.
      // NOTE: WC/property policies can render LossType as a read-only display field
      // (div.x-form-display-field) that CC pre-fills — the element starts as an input
      // but transforms to a div once the policy-search AJAX settles. Re-check after
      // an extra mask wait so we don't attempt a click on a display-only field.
      const lossTypeId = 'FNOLWizard:FNOLWizard_FindPolicyScreen:FNOLWizardFindPolicyPanelSet:LossType-inputEl';
      const hasLossType = await page.locator(`[id="${lossTypeId}"]`)
        .waitFor({ state: 'visible', timeout: 1000 }).then(() => true).catch(() => false);
      if (hasLossType) {
        // WC and property LOBs trigger a secondary AJAX after the policy results load
        // that transforms LossType from an editable INPUT to a read-only display DIV.
        // Wait for the first mask, then 1s (time for secondary AJAX to start), then
        // wait for any secondary mask to also clear before evaluating the final element type.
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(300);
        const lossTypeTag = await page.evaluate(id => {
          const el = document.getElementById(id);
          return el ? el.tagName : null;
        }, lossTypeId).catch(() => null);
        if (lossTypeTag === 'INPUT') {
          // Secondary AJAX can convert LossType from INPUT→DIV even after the initial
          // mask clears. Poll up to 2.5s more before deciding the element is editable.
          let lossTypeTagFinal = lossTypeTag;
          for (let _poll = 0; _poll < 5 && lossTypeTagFinal === 'INPUT'; _poll++) {
            await page.waitForTimeout(500);
            lossTypeTagFinal = await page.evaluate(id => {
              const el = document.getElementById(id);
              return el ? el.tagName : null;
            }, lossTypeId).catch(() => null);
          }
          if (lossTypeTagFinal !== 'INPUT') {
            const displayVal = await page.locator(`[id="${lossTypeId}"]`).textContent().catch(() => '');
            console.log('searchPolicy: LossType auto-settled after poll (tag: ' + lossTypeTagFinal + ', value: "' + displayVal.trim() + '") — skipping fill');
          } else {
            const ltVal = await page.locator(`[id="${lossTypeId}"]`).inputValue().catch(() => '');
            if (!ltVal || ltVal === '<none>') {
              // Short timeout: if AJAX fires during the click (converts INPUT→DIV), fail fast.
              const _ltClicked = await page.locator(`[id="${lossTypeId}"]`)
                .click({ timeout: 5000 }).then(() => true).catch(() => false);
              if (_ltClicked) {
                await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});
                console.log('searchPolicy: LossType filled on Find Policy (GL LOB)');
              } else {
                const _ltNow = await page.evaluate(id => {
                  const el = document.getElementById(id); return el ? el.tagName : null;
                }, lossTypeId).catch(() => null);
                console.log('searchPolicy: LossType click failed (nowTag: ' + _ltNow + ') — auto-converted by AJAX, skipping');
              }
            }
          }
        } else {
          const displayVal = await page.locator(`[id="${lossTypeId}"]`).textContent().catch(() => '');
          console.log('searchPolicy: LossType settled (tag: ' + lossTypeTag + ', value: "' + displayVal.trim() + '") — skipping fill');
        }
      }
    } else {
      // Restored FNOL session: CC remembered the prior attempt's search results.
      // Loss Date is now a read-only text display, not a textbox. Skip refilling.
      console.log('searchPolicy: restored FNOL session detected — skipping policy search fill');
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 30000 }).catch(() => {});
    }

    // PolicyType field: CC recently added a required "Policy Type" dropdown on
    // the Find Policy screen. For PA auto policies this must be set to
    // "Personal Auto" (or the corresponding auto option). If the dropdown only
    // has commercial options (BOP, Commercial Excess, etc.), the policy is
    // not a PA auto policy and we should skip it via POLICY_DATA_ERROR.
    const policyTypeInputEl = page.locator('[id$="PolicyType-inputEl"]').first();
    const hasPolicyType = await policyTypeInputEl.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (hasPolicyType) {
      const ptVal = await policyTypeInputEl.inputValue().catch(() => '');
      if (!ptVal || ptVal === '<none>') {
        // Open the dropdown to inspect available options.
        // Wait for at least one item to appear — ExtJS lazy-loads the option list.
        await policyTypeInputEl.click({ timeout: 3000 }).catch(() => {});
        await page.waitForSelector('.x-boundlist-item', { state: 'visible', timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(200);  // brief settle for all items to render
        const ptOptions = page.locator('.x-boundlist-item');
        const ptCount = await ptOptions.count().catch(() => 0);
        const allPtOptions = [];
        for (let i = 0; i < ptCount; i++) {
          const t = (await ptOptions.nth(i).textContent().catch(() => '') || '').trim();
          allPtOptions.push(t);
        }
        // Pick in PREFERENCE order, not document order. The old single test
        // `/personal\s*auto|\bauto\b/` took whichever option appeared FIRST in
        // the dropdown that matched either branch, so a PA policy whose list
        // happens to show "Commercial auto" above "Personal Auto" was filed
        // under the commercial type - confirmed live, which logged
        // 'PolicyType set to Personal Auto option "Commercial auto"'.
        // An explicit policyType (threaded from the spec) wins; otherwise
        // prefer Personal Auto, and only then fall back to any auto option so
        // Commercial Auto policies still resolve.
        const findIdx = (re) => allPtOptions.findIndex(t => t && re.test(t));
        let autoIdx = -1;
        if (policyType) autoIdx = findIdx(new RegExp(policyType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
        if (autoIdx < 0) autoIdx = findIdx(/personal\s*auto/i);
        if (autoIdx < 0) autoIdx = findIdx(/\bauto\b/i);
        if (autoIdx >= 0) {
          await ptOptions.nth(autoIdx).click().catch(() => {});
          await page.keyboard.press('Tab').catch(() => {});
          // CC fires an AJAX after PolicyType selection (loads LOB-specific screens).
          // On slow on-prem server this can take several seconds.
          await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
          // Log the full option list, not just the pick. Without it there is no
          // way to tell from a run whether the chosen type was the right one for
          // the LOB or merely the first thing that matched - e.g. an HO policy
          // resolving to "Personal auto" looks fine in a one-value log line.
          console.log('searchPolicy: PolicyType set to "' + allPtOptions[autoIdx] + '"' +
                      (policyType ? ' (requested: ' + policyType + ')' : ' (no policyType requested)') +
                      ' | options: ' + allPtOptions.filter(Boolean).join(', '));
        } else {
          // No Personal Auto option — this policy is a commercial/non-auto policy
          // that snuck into POLICY_PA_AUTO test data. Close the dropdown and
          // rotate to the next policy via POLICY_DATA_ERROR.
          await page.keyboard.press('Escape').catch(() => {});
          const optsSummary = allPtOptions.slice(0, 5).join(', ');
          console.log('searchPolicy: PolicyType has no auto option for policy ' + policyNumber + ' (options: ' + optsSummary + ') — skipping');
          throw new Error('POLICY_DATA_ERROR [' + policyNumber + ']: PolicyType dropdown has no Personal Auto option (got: ' + optsSummary + ')');
        }
      }
    }

    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

    // Timeout 90s: CC may take >30s to activate the Next button after search
    // results load (loading mask, secondary PolicyType AJAX, etc.).
    // force:true bypasses any residual mask/overlay interception.
    await page.locator('[id="FNOLWizard:Next"]').click({ force: true, timeout: 90000 });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    console.log('Policy search Next clicked → Step 2 (on-prem)');

    // Dump any validation messages that appear on FindPolicyScreen after Next click
    const msgsText = await page.locator('[id="FNOLWizard:FNOLWizard_FindPolicyScreen:_msgs"]')
      .textContent({ timeout: 1500 }).catch(() => null);
    if (msgsText && msgsText.trim()) {
      console.log('FindPolicyScreen validation msgs after Next:', msgsText.trim().substring(0, 300));
      // Transient server errors (Connection reset, network failure) leave the
      // wizard stuck on Step 1 with no way forward. Throw POLICY_DATA_ERROR so
      // completeFNOL retries with the next policy in rotation instead of
      // continuing with a corrupted wizard state.
      // Network/infra errors (Connection refused, connect timeout) mean the backend
      // is down — throw immediately without burning the policy rotation.
      if (/Connection refused|connect timed out|connection timed out/i.test(msgsText)) {
        throw new Error('INFRA_ERROR: backend unreachable — ' + msgsText.trim().substring(0, 150));
      }
      if (/Connection reset|failed to connect|server error|policy search failed|zero results|no results found/i.test(msgsText)) {
        throw new Error('POLICY_DATA_ERROR [' + policyNumber + ']: ' + msgsText.trim().substring(0, 200));
      }
    }

    // Confirmed via live failure: a genuinely BROKEN policy record on the
    // server (e.g. an address shared between two contacts) surfaces here as
    // a real backend banner - "IllegalStateException: Bundle invariants
    // violated..." - not an automation bug, but it leaves the wizard stuck
    // on "Step 1 of 5: Search or Create Policy" with Next still clickable
    // but useless. Detect this specific case and throw a tagged error so the
    // caller (completeFNOL) can report it distinctly and retry with the next
    // policy in rotation instead of failing the whole test on bad test data.
    const backendErrorBanner = await page.getByText(/IllegalStateException|Bundle invariants violated/i)
      .first().textContent({ timeout: 1500 }).catch(() => null);
    if (backendErrorBanner) {
      throw new Error('POLICY_DATA_ERROR [' + policyNumber + ']: ' + backendErrorBanner.trim());
    }
  } else {
    await clickNewClaimCloud(page);

    let lossDateField = page.getByRole('textbox', { name: /Loss Date/i });
    let lossDateVisible = await lossDateField.waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true).catch(() => false);
    if (!lossDateVisible) {
      lossDateField = page.getByPlaceholder('MM/DD/YYYY');
      await lossDateField.waitFor({ state: 'visible', timeout: 20000 });
    }
    await lossDateField.fill(lossDate);
    console.log('Loss Date filled: ' + lossDate);

    const policyField = page.getByRole('textbox', { name: 'Policy #' });
    await policyField.fill(policyNumber);
    console.log('Policy # filled: ' + policyNumber);

    // Policy Type is deliberately NOT set on cloud by default.
    //
    // It looked like a parity gap with on-prem (which does set it), but a live
    // screenshot of a WORKING cloud search shows Policy Type sitting at
    // "<none>" while the results grid returns the policy - and setting it to
    // "Workers' comp"/"BOP" produced "No data to display" for those exact same
    // policies. On this screen it acts as an extra filter that excludes the
    // very rows we want, rather than as the disambiguator it is on-prem.
    // Opt in with CC_CLOUD_SET_POLICY_TYPE=1 if a future LOB genuinely needs it.
    if (policyType && process.env.CC_CLOUD_SET_POLICY_TYPE === '1') {
      const typeCombo = page.getByRole('combobox', { name: /Policy Type/i }).first();
      if (await typeCombo.isVisible().catch(() => false)) {
        await typeCombo.selectOption({ label: policyType })
          .then(() => console.log('Policy Type set to "' + policyType + '" (cloud)'))
          .catch(async () => {
            // Not a native <select> - fall back to click-then-pick.
            await typeCombo.click().catch(() => {});
            await page.getByRole('option', { name: policyType, exact: false }).first()
              .click({ timeout: 3000 })
              .then(() => console.log('Policy Type picked from list: "' + policyType + '" (cloud)'))
              .catch(() => console.log('Policy Type "' + policyType + '" could not be set on cloud - continuing'));
          });
      }
    }

    // CC DISABLES Search once a search has succeeded and a result row is
    // selected (confirmed via screenshot: the row shows "Unselect" and the
    // Search button greys out). Clicking a disabled control makes Playwright
    // wait out the whole action timeout, so only click when it is actually
    // enabled - and treat "already disabled" as "the search has already run".
    const searchBtn = page.getByRole('button', { name: 'Search', exact: true }).first();
    const searchUsable = await searchBtn.isEnabled().catch(() => false);
    if (searchUsable) {
      await searchBtn.click();
      console.log('Policy search submitted');
    } else {
      console.log('Search button already disabled — a search has already been run on this screen');
    }

    // Wait for the SEARCH to actually come back before judging the grid.
    // waitForLoadState('domcontentloaded') was used here, but on an
    // already-loaded SPA it resolves immediately - so Next was clicked while
    // the search AJAX was still in flight, the grid was legitimately empty at
    // that instant, and the failure was reported as "this policy does not exist
    // in this environment". It does exist: on-prem DEV creates claims from the
    // very same policy numbers and loss date.
    // SCOPED to the Search Results group. A page-wide "No data to display"
    // match was hitting the CLAIMS HISTORY grid that sits directly below the
    // results - legitimately empty for a policy with no prior claims - and so
    // reported "policy does not exist" while the policy was displayed, selected
    // ("Unselect" showing) and Next was enabled. Confirmed via screenshot.
    // Wait for the ROW first, and only call it empty if the row never arrives.
    //
    // Racing "row appears" against "No data to display" resolved instantly as
    // empty every time: that message is the grid's INITIAL state, on screen
    // before the search returns, so the race was decided before the AJAX even
    // completed. Ordering matters here - the row appearing is the only positive
    // signal; absence of it is what has to be waited out.
    const resultsRegion = page.getByRole('group', { name: /Search Results/i }).first();
    const rowAppeared = await resultsRegion.getByRole('row').filter({ hasText: policyNumber }).first()
      .waitFor({ state: 'visible', timeout: 25000 }).then(() => true).catch(() => false);
    const resultsSettled = rowAppeared ? 'rows' : 'empty';
    console.log('Policy search results: ' + resultsSettled);

    // Answer the required Yes/No questions that live on the Find Policy screen
    // itself, BEFORE Next. Confirmed via screenshot: below the Search button sit
    // "Converted Claims", "Date of Loss Confirmation" and "Fast Track Auto
    // Claims". CC pre-answers the first and last with No, but leaves
    // "Is the year selected for the date of loss correct?" BLANK and outlined
    // red - so Next stays disabled until it is answered. It was being reported
    // later, from Step 3, which is why it looked like a Loss Details problem.
    const answered = await page.evaluate(() => {

      const out = [];
      for (const grp of document.querySelectorAll('div, fieldset, tr')) {
        const radios = grp.querySelectorAll('input[type="radio"], [role="radio"]');
        if (radios.length !== 2) continue;                       // Yes/No pairs only
        const text = (grp.innerText || '').trim();
        if (!/\?/.test(text) || text.length > 200) continue;     // must be a question
        const isOn = r => r.checked || r.getAttribute('aria-checked') === 'true';
        if ([...radios].some(isOn)) continue;                    // already answered
        // "…correct?" confirmations must be affirmed for the wizard to proceed;
        // anything else takes the conservative No that CC itself defaults to.
        const wantYes = /correct\?/i.test(text);
        for (const r of radios) {
          const label = (r.getAttribute('aria-label') ||
                         (r.id && document.querySelector('label[for="' + r.id + '"]')?.textContent) ||
                         r.value || '').trim();
          if ((wantYes && /^yes$/i.test(label)) || (!wantYes && /^no$/i.test(label))) {
            r.click();
            out.push(text.split('\n')[0].slice(0, 60) + ' -> ' + (wantYes ? 'Yes' : 'No'));
            break;
          }
        }
      }
      return out;
    }).catch(() => []);
    if (answered.length) {
      console.log('Find Policy required question(s) answered: ' + answered.join(' | '));
      await page.waitForTimeout(600);
    }

    // Loss Type sits at the TOP of the Find Policy screen, above the fold in
    // every BOP screenshot we have, and starts at "<none>". BOP's Next was a
    // silent no-op with a selected row, no insured on the claim and NO
    // validation text anywhere (checked innerText, textContent, and the
    // Validation Results panel expanded) - an unsatisfied required field that CC
    // does not narrate is the remaining explanation. Set it if it is still unset.
    // Harmless for the LOBs that already work: they leave it alone once it has
    // a value.
    const lossTypeCombo = page.getByRole('combobox', { name: /Loss Type/i }).first();
    if (await lossTypeCombo.isVisible().catch(() => false)) {
      const cur = ((await lossTypeCombo.inputValue().catch(() => '')) || '').trim();
      if (!cur || /^<?none>?$/i.test(cur)) {
        const opts = await lossTypeCombo.locator('option').allTextContents().catch(() => []);
        const real = opts.find(o => o && !/^<?none>?$/i.test(o.trim()));
        if (real) {
          const ok = await lossTypeCombo.selectOption({ label: real }).then(() => true).catch(() => false);
          console.log('searchPolicy: Loss Type was unset — set to "' + real.trim() + '"' +
                      (ok ? '' : ' (selectOption failed)'));
          await page.waitForTimeout(1200);
        } else {
          console.log('searchPolicy: Loss Type is unset but offers no selectable option');
        }
      } else {
        console.log('searchPolicy: Loss Type already set to "' + cur + '"');
      }
    }

    // Click Next after search results — no row selection needed
    await clickCloudAction(page, '#FNOLWizard-Next [role="button"]', 'Find Policy → Next');
    await page.waitForLoadState('domcontentloaded');

    // VERIFY we actually left Step 1. This used to log "→ Step 2"
    // unconditionally, and on BOP the click was a silent no-op: the run
    // continued on Find Policy, filled Basic Info fields into that screen, and
    // only failed much later with "wizard still open on Step 1" and no
    // validation text anywhere. An unverified navigation makes every subsequent
    // symptom misleading.
    const stepAfterNext = async () => page.evaluate(() =>
      ((document.body.innerText || '').match(/Step\s*\d+\s*of\s*5[^\n]*/i) || [''])[0].trim()
    ).catch(() => '');
    let step = await stepAfterNext();
    if (/Step\s*1\s*of\s*5/i.test(step)) {
      // The wizard's own left-nav entry is an alternative route once Find Policy
      // is satisfied - try it before giving up.
      const basicInfoNav = page.getByRole('menuitem', { name: /^Basic Info$/i }).first();
      const navUsable = await basicInfoNav.isVisible().catch(() => false);
      console.log('searchPolicy: Next did NOT leave Step 1' +
                  (navUsable ? ' — trying the "Basic Info" left-nav entry' : ' and no Basic Info nav entry is available'));
      if (navUsable) {
        await basicInfoNav.click().catch(() => {});
        await page.waitForTimeout(2000);
        step = await stepAfterNext();
      }
    }
    if (/Step\s*1\s*of\s*5/i.test(step) || !step) {
      // CC's Validation Results panel is a COLLAPSED tab at the edge of the
      // screen and its content is not in the DOM until opened - which is why
      // scanning innerText AND textContent both came back empty while a red
      // indicator was plainly visible. Open it before reading.
      for (const label of [/Validation Results/i, /Errors/i]) {
        const tab = page.getByText(label).first();
        if (await tab.isVisible().catch(() => false)) {
          await tab.click().catch(() => {});
          await page.waitForTimeout(900);
          break;
        }
      }
      const panelText = await page.evaluate(() => {
        const t = (document.body.innerText || '') + ' ' + (document.body.textContent || '');
        return [...t.matchAll(/([A-Z][^.\n]{0,120}(?:required|invalid|must be|cannot|not allowed|already exists)[^.\n]{0,120})/g)]
          .map(m => m[1].trim()).filter(Boolean).slice(0, 5);
      }).catch(() => []);
      if (panelText.length) console.log('searchPolicy: validation panel says: ' + panelText.join(' || '));
      else console.log('searchPolicy: validation panel produced no text even after expanding');

      const detail = await page.evaluate(() => {
        const t = (document.body.innerText || '') + ' ' + (document.body.textContent || '');
        const ins = (t.match(/Ins:\s*([^\n]{0,40})/) || [])[1] || '';
        const nextBtn = [...document.querySelectorAll('[role="button"],button,input[type="button"]')]
          .find(b => /^Next$/i.test((b.textContent || b.value || '').trim()));
        return {
          insured: ins.trim(),
          nextDisabled: nextBtn ? (nextBtn.getAttribute('aria-disabled') === 'true' || !!nextBtn.disabled) : null,
          selectedRow: /Unselect/i.test(t),
        };
      }).catch(() => ({}));
      throw new Error('CLOUD_FIND_POLICY_STUCK: Next did not advance past "Step 1 of 5". ' +
        'Insured on claim: "' + (detail.insured || '(empty)') + '" | Next disabled: ' + detail.nextDisabled +
        ' | a result row is selected: ' + detail.selectedRow + '. ' +
        'An empty Insured with a selected row means the policy did not attach to the claim.');
    }
    console.log('Policy search Next clicked → ' + step);
  }
}

// ── fillBasicInfoOnPrem (Step 2) ──────────────────────────────────────────────
// This ExtJS screen uses combo widgets with NO accessible label (aria-label is
// null on all of them, confirmed via live inspection) - unlike login/search,
// selectComboboxOnPrem's role+name lookup can't target these. Uses the real,
// stable element ids instead (selectComboboxByIdOnPrem). The wizard step-set
// prefix in these ids ("AutoWorkersCompWizardStepSet") is LOB-specific - this
// has only been confirmed for Personal Auto; other LOBs may use a different
// step-set name and need re-verification.
async function fillBasicInfoOnPrem(page) {
  console.log('FNOL Step 2: Basic Info (on-prem)...');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  // Detect the LOB-specific wizard step-set prefix dynamically — "AutoWorkersCompWizardStepSet"
  // only applies to Auto LOBs; property/WC/other LOBs don't have a HowReported combobox at all.
  // When HowReported isn't present, skip all ID-based fills (the sweep logic later handles required
  // fields for those LOBs, and their Step 2 has a simpler/different structure).
  let prefix = null;
  try {
    // 5s is plenty for Auto LOBs; non-Auto LOBs (BOP, Property, WC) don't
    // have this field at all and the old 20s wait was pure wasted time.
    await page.waitForSelector('[id$="HowReported-inputEl"]', { timeout: 5000 });
    const fullId = await page.locator('[id$="HowReported-inputEl"]').first().getAttribute('id');
    if (fullId) prefix = fullId.replace('HowReported-inputEl', '');
  } catch {
    const stepHdr = await page.locator('.x-panel-header-text, [class*="WizardStepGroup"] .x-panel-header-text').first().textContent({ timeout: 2000 }).catch(() => '?');
    console.log('No HowReported combobox found for this LOB (step header: ' + stepHdr.trim() + ') — skipping ID-based BasicInfo fills');
  }

  if (prefix) {
    await selectComboboxByIdOnPrem(page, prefix + 'HowReported-inputEl');
    await selectComboboxByIdOnPrem(page, prefix + 'ReportedBy_Name-inputEl');
    await selectComboboxByIdOnPrem(page, prefix + 'Claim_ReportedByType-inputEl');
    await selectComboboxByIdOnPrem(page, prefix + 'MainContact_Name-inputEl');
    await selectComboboxByIdOnPrem(page, prefix + 'Claim_MainContactType-inputEl');
    // The chosen contact may have no address, which blocks every later payment.
    await ensureMainContactAddress().catch((e) =>
      console.log('ensureMainContactAddress failed (continuing): ' + e.message));
    // WC (and other LOBs) may show additional required comboboxes (e.g. "Injured Worker Name")
    // after the known fields are filled. A generic sweep catches them without needing hardcoded IDs.
    await sweepComboboxesOnPrem(page, null, 5);
  }

  // Ensures the Main Contact has a postal address before FNOL leaves Step 2.
  //
  // A contact picked here (e.g. SANFORD BARNWELL) can have phone numbers but no
  // address at all. CC still accepts the claim, but every later payment is
  // refused with "The claimant's primary address must have a street, city and
  // state" - and because that message sits in a COLLAPSED validation panel, the
  // payment step reported only "(no banner text found)". Fixing it here, where
  // the contact is chosen, is far cheaper than repairing every claim later.
  //
  // Path (from live screenshots): the chevron beside Main Contact > Name opens
  // a menu with "New Person" / "View Contact Details"; that screen has
  // Basics / Addresses / Related Contacts tabs and an Edit button; its header
  // carries a "Return to Step 2 of 5: Basic information" link back.
  async function ensureMainContactAddress() {
    const chevron = page.locator('[id*="MainContact_Name"]').locator('img, .x-form-arrow-trigger').last();
    if (!await chevron.isVisible().catch(() => false)) {
      console.log('Main Contact: no contact-menu chevron found - address left as-is');
      return false;
    }
    await chevron.click().catch(() => {});
    await page.waitForTimeout(700);

    const viewDetails = page.getByText('View Contact Details', { exact: false }).first();
    if (!await viewDetails.isVisible().catch(() => false)) {
      console.log('Main Contact: "View Contact Details" not offered - address left as-is');
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }
    await viewDetails.click().catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(900);

    await page.getByText('Addresses', { exact: true }).first().click().catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.locator('.x-btn').filter({ hasText: /^Edit$/ }).first().click().catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

    const fillIfEmpty = async (namePart, value) => {
      const el = page.locator('input[name*="' + namePart + '"]').first();
      if (!await el.isVisible().catch(() => false)) return false;
      if (((await el.inputValue().catch(() => 'x')) || '').trim()) return false;
      await el.fill(value).catch(() => {});
      return true;
    };
    const filled = [];
    if (await fillIfEmpty('AddressLine1', '1437 Seneca Blvd')) filled.push('Address 1');
    if (await fillIfEmpty('City', 'Broadview Heights')) filled.push('City');
    if (await fillIfEmpty('PostalCode', '44147')) filled.push('Zip');
    await selectComboboxOnPrem(page, 'State', undefined, { random: false })
      .then(() => filled.push('State')).catch(() => {});

    await page.locator('.x-btn').filter({ hasText: /^(Update|OK|Save)$/ }).first().click().catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
    console.log('Main Contact address: filled ' + (filled.join(', ') || '(nothing was empty)'));

    const back = page.getByText(/Return to Step 2 of 5/i).first();
    if (await back.isVisible().catch(() => false)) {
      await back.click().catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
    }
    return filled.length > 0;
  }

  function randomPhoneNumber() {
    const area = Math.floor(200 + Math.random() * 800);
    const prefixNum = Math.floor(200 + Math.random() * 800);
    const line = Math.floor(1000 + Math.random() * 9000);
    return `${area}${prefixNum}${line}`;
  }
  // NOTE: .isVisible() does NOT poll/wait in Playwright - it's an immediate,
  // non-blocking check (a known gotcha in this codebase) - use .waitFor().
  async function fillPhoneAndVerify(locator, label) {
    const visible = await locator.waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true).catch(() => false);
    if (!visible) { console.log(label + ': field not visible, skipped'); return false; }

    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    let value = '';
    for (let attempt = 0; attempt < 3 && !value; attempt++) {
      await locator.fill(randomPhoneNumber());
      await locator.press('Tab');
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(400);
      value = await locator.inputValue().catch(() => '');
    }
    console.log(label + ': filled =', !!value);
    return !!value;
  }

  const reporterMobile = page.locator(`[id="${prefix}reporter_mobile:GlobalPhoneInputSet:NationalSubscriberNumber-inputEl"]`);
  const mainContactMobile = page.locator(`[id="${prefix}MainContact_CellPhone:GlobalPhoneInputSet:NationalSubscriberNumber-inputEl"]`);

  // Select the first involved vehicle (required - confirmed via screenshot
  // that Next silently fails validation with none checked). This is an ExtJS
  // grid "checkcolumn" - the checkbox is rendered as an <img class=
  // "x-grid-checkcolumn">, NOT a real <input type="checkbox"> at all (confirmed
  // via live DOM dump), which is why input[type="checkbox"] found zero matches.
  // Playwright's own .click() on this tiny image never actually toggled the
  // ExtJS checkcolumn's internal state (confirmed via live testing - the class
  // never changed to "-checked" and Next kept silently failing validation).
  // A raw DOM .click() via evaluate() DOES trigger it correctly (confirmed:
  // triggers a loading mask + adds the "-checked" class), so used here instead.
  // IMPORTANT: this runs BEFORE the Mobile fills below (order was flipped) -
  // confirmed via live screenshot that selecting the vehicle triggers a
  // re-render that silently wipes an already-filled Main Contact Mobile value,
  // even though fillPhoneAndVerify's own inputValue() check had passed right
  // after filling it. Filling Mobile LAST, right before Next, avoids that.
  const vehicleCheckboxExists = await page.locator('img.x-grid-checkcolumn').count().catch(() => 0) > 0;
  if (vehicleCheckboxExists) {
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    let checked = false;
    for (let attempt = 0; attempt < 3 && !checked; attempt++) {
      await page.evaluate(() => document.querySelector('img.x-grid-checkcolumn').click());
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
      checked = await page.evaluate(() =>
        document.querySelector('img.x-grid-checkcolumn').className.includes('x-grid-checkcolumn-checked')
      );
    }
    console.log('First vehicle selected (on-prem):', checked);
  } else {
    console.log('WARNING: no vehicle checkcolumn found to select');
  }

  // Selecting a real Name (above) reveals a "Confirm Contact Info" mini-panel
  // for BOTH Reported By and Main Contact, each with its own required Mobile
  // field (confirmed red/invalid when left empty in a live screenshot) - fill
  // both with a random number, same approach as the cloud MainContact phone
  // fill. Done LAST (after the vehicle checkbox) and re-verified once more
  // right before Next, since two different prior actions (selecting Relation,
  // selecting the vehicle) were each independently observed to wipe this
  // field back to empty after a successful fill.
  await fillPhoneAndVerify(reporterMobile, 'reporter mobile');
  await fillPhoneAndVerify(mainContactMobile, 'main contact mobile');
  const mainMobileFinal = await mainContactMobile.inputValue().catch(() => '');
  if (!mainMobileFinal) {
    console.log('WARNING: main contact mobile empty right before Next - retrying once more');
    await fillPhoneAndVerify(mainContactMobile, 'main contact mobile (final retry)');
  }

  // Fallback for non-auto LOBs (WC, BOP, etc.) where phone fields use different
  // IDs — scan all visible empty NationalSubscriberNumber inputs and fill them.
  const emptyPhoneIds = await page.evaluate(() => {

    return Array.from(document.querySelectorAll('input[id$="NationalSubscriberNumber-inputEl"]'))
      .filter(el => el.offsetParent !== null && !el.value)
      .map(el => el.id);
  }).catch(() => []);
  for (const pid of emptyPhoneIds) {
    const pField = page.locator(`[id="${pid}"]`);
    const label = pid.includes('Mobile') || pid.includes('CellPhone') ? 'mobile (fallback)' : 'phone (fallback)';
    await fillPhoneAndVerify(pField, label);
  }

  // Wait for any in-flight CC AJAX (contact record fetch, validation round-trip) to
  // settle BEFORE the final pre-Next check - a CC AJAX triggered by the fill's blur
  // event can repopulate the panel from the contact record, wiping the phone value.
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  // Re-verify AFTER the mask clears (in case the panel was repopulated by that AJAX)
  const mainMobilePostMask = await mainContactMobile.inputValue().catch(() => '');
  if (!mainMobilePostMask) {
    console.log('WARNING: main contact mobile wiped by post-fill AJAX - filling again after mask');
    await fillPhoneAndVerify(mainContactMobile, 'main contact mobile (post-mask retry)');
  }
  const reporterMobilePostMask = await reporterMobile.inputValue().catch(() => '');
  if (!reporterMobilePostMask) {
    console.log('WARNING: reporter mobile wiped by post-fill AJAX - filling again after mask');
    await fillPhoneAndVerify(reporterMobile, 'reporter mobile (post-mask retry)');
  }
  // Final fallback sweep for any phone field still empty after mask wait.
  // Includes a label-based scan for LOBs (WC, etc.) whose phone inputs don't
  // use the NationalSubscriberNumber ID pattern (e.g. Work Phone on WC policies).
  const stillEmptyPhoneIds = await page.evaluate(() => {

    const byId = Array.from(document.querySelectorAll('input[id$="NationalSubscriberNumber-inputEl"]'))
      .filter(el => el.offsetParent !== null && !el.value)
      .map(el => el.id);
    const byLabel = Array.from(document.querySelectorAll('input[type="text"]'))
      .filter(el => {
        if (el.offsetParent === null || el.value) return false;
        const item = el.closest('.x-form-item') || el.closest('.x-field');
        const label = item && (item.querySelector('.x-form-item-label') || item.querySelector('label'));
        return label && /\bphone\b|\bmobile\b|\bcell\b/i.test(label.textContent.trim());
      })
      .map(el => el.id)
      .filter(id => id && !byId.includes(id));
    return [...byId, ...byLabel];
  }).catch(() => []);
  for (const pid of stillEmptyPhoneIds) {
    const pField = page.locator(`[id="${pid}"]`);
    await fillPhoneAndVerify(pField, 'phone post-mask (fallback)');
  }
  await page.locator('[id="FNOLWizard:Next"]').click({ timeout: 8000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // Confirmed via live screenshot: this policy's pre-existing contact record
  // can carry an invalid Work Phone (e.g. a 9-digit number), which blocks
  // Next with "Work Phone : Must be a 10-digit phone number..." - not a
  // field we normally fill (it's pre-populated from Confirm Contact Info),
  // so react to the specific error banner and overwrite it instead.
  const workPhoneError = await page.getByText(/Work Phone\s*:\s*Must be a 10-digit phone number/i)
    .waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
  if (workPhoneError) {
    // Confirmed via live failure: an id-substring guess ("WorkPhone") never
    // matched this screen's REAL field id, so the fix silently never ran.
    // Find the input by its actual visible LABEL text instead (same
    // label-scan approach used elsewhere in this file, e.g.
    // fillEmptyTextboxesByLabel) - reliable regardless of the underlying id
    // convention.
    const workPhoneId = await page.evaluate(() => {

      const labels = Array.from(document.querySelectorAll('.x-form-item-label'));
      const label = labels.find(l => l.textContent.trim() === 'Work Phone');
      if (!label) return null;
      const item = label.closest('.x-form-item') || label.closest('.x-field');
      if (!item) return null;
      const input = item.querySelector('input[id$="NationalSubscriberNumber-inputEl"]') || item.querySelector('input[type="text"]');
      return input ? input.id : null;
    }).catch(() => null);
    if (workPhoneId) {
      const workPhoneField = page.locator(`[id="${workPhoneId}"]`);
      await fillPhoneAndVerify(workPhoneField, 'work phone (fixing invalid pre-filled value)');
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.locator('[id="FNOLWizard:Next"]').click({ timeout: 8000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      console.log('Next clicked again after fixing invalid Work Phone');
    } else {
      console.log('WARNING: Work Phone validation error shown but field could not be located by label');
    }
  }

  // A "Possible Duplicate Claims" panel can dock at the bottom of the screen
  // here - confirmed via live screenshot, but ALSO confirmed non-deterministic
  // (depends on how many prior duplicate test claims already exist server-side
  // for this policy/date, which varies run to run) - so this must tolerate
  // "never appears" as the common case. Real Close button id confirmed via
  // live inspect element: the underlying screen id
  // ("NewClaimDuplicatesWorksheet_CloseButton") is literally identical to
  // what the cloud version already targets - same app, just rendered
  // differently. Two earlier guesses (text-scoped ancestor walk, bigButton
  // class search) were both wrong; this is the confirmed real id.
  const duplicatesHeading = page.getByText('Possible Duplicate Claims', { exact: true });
  const hasDuplicatesPanel = await duplicatesHeading.waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true).catch(() => false);
  if (hasDuplicatesPanel) {
    // Confirmed by the user: the first Next click, when duplicates exist,
    // only SURFACES this panel - it does not navigate. Closing the panel
    // dismisses it but does NOT auto-submit either; a second Next click is
    // required to actually advance to Step 3. This was the real remaining
    // bug - every previous attempt closed the panel and then just checked
    // whether navigation had happened, instead of clicking Next again.
    console.log('Duplicate Claims panel detected - closing it');
    await page.locator(
      '[id="NewClaimDuplicatesWorksheet:NewClaimDuplicatesScreen:NewClaimDuplicatesWorksheet_CloseButton"]'
    ).click();
    await page.waitForTimeout(500);
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.locator('[id="FNOLWizard:Next"]').click({ timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    console.log('Next clicked again after closing duplicates panel');
  }

  // Verify we actually left Basic Info instead of trusting the click blindly -
  // a validation failure here leaves the wizard on the same screen with no
  // thrown error, which previously caused fillLossDetailsCloud to be called
  // against the wrong screen and fail with a confusing timeout.
  // Using .waitFor({state:'hidden'}) here (not .isVisible(), which doesn't
  // poll - same gotcha as elsewhere in this function) so a brief in-flight
  // transition isn't mistaken for a stuck screen.
  const leftBasicInfo = await page.locator(`[id="${prefix}HowReported-inputEl"]`)
    .waitFor({ state: 'hidden', timeout: 10000 }).then(() => true).catch(() => false);
  if (!leftBasicInfo) {
    // Log CC's own validation messages so we know which field is still required.
    const stepMsgs = await page.evaluate(() => {

      const sel = '.x-form-invalid-field, .x-form-error-msg, [id$="_msgs"] .x-component, ' +
                  '[class*="validationMsg"], [class*="errorMsg"], .gw-validation-error';
      return Array.from(document.querySelectorAll(sel))
        .map(el => el.textContent?.trim()).filter(Boolean).join(' | ');
    }).catch(() => '');
    const stepHdr = await page.locator('.x-panel-header-text, [class*="WizardStepGroup"] .x-panel-header-text')
      .first().textContent({ timeout: 2000 }).catch(() => '?');
    console.log('fillBasicInfoOnPrem: STUCK on step:', stepHdr.trim(), '| CC validation msgs:', stepMsgs || '(none found in DOM)');
    throw new Error('Basic Info did not advance to Step 3 - a required field is likely still invalid (check Mobile/phone fields).');
  }
  console.log('Basic Info done → Step 3 (on-prem)');
}

// ── fillBasicInfo (Step 2, cloud) ─────────────────────────────────────────────
async function fillBasicInfo(page) {
  console.log('FNOL Step 2: Basic Info...');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000);
  await page.waitForSelector('select', { timeout: 10000 }).catch(() => { });

  await page.waitForTimeout(500);

  // Position-based select filling is unreliable — different policies render
  // different numbers of selects initially, so nth(0) is NOT always HowReported.
  // Use name-pattern selectors instead (each field has a unique name substring).
  // selectFirstOption uses waitFor internally so dynamic fields are caught.
  const selCount = await page.locator('select').count().catch(() => 0);
  console.log('Total selects found on load: ' + selCount);

  // How Reported — always the first required select
  await selectFirstOption(page, '[name*="HowReported"]', 5000);

  // Reported By Name — person/company who reported the loss
  await selectFirstOption(page, '[name*="ReportedBy_Name"]', 3000);

  // Relation to Insured — relationship of the reporter to the policy insured
  await selectFirstOption(page, '[name*="Claim_ReportedByType"]', 3000);

  // Main Contact Name — who CC should contact about this claim
  await selectFirstOption(page, '[name*="MainContact_Name"]', 3000);

  // Main Contact Relation Type — appears DYNAMICALLY after MainContact_Name is
  // selected; if left empty, CC validation blocks Next and the wizard stays on Step 2.
  await selectFirstOption(page, '[name*="Claim_MainContactType"]', 4000);

  // Phone
  function randomPhoneNumber() {
    const area = Math.floor(200 + Math.random() * 800);
    const prefix = Math.floor(200 + Math.random() * 800);
    const line = Math.floor(1000 + Math.random() * 9000);
    return `${area}${prefix}${line}`;
  }

  // Reporter Phone Type — defaults to "work" in cloud, which makes business phone
  // the required field. Explicitly set to "cell" so reporter_mobile satisfies validation.
  const phoneTypeEl = page.locator('[name*="reporter_primarytype"]').first();
  const phoneTypeVis = await phoneTypeEl.waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true).catch(() => false);
  if (phoneTypeVis) {
    const curPhoneType = await phoneTypeEl.inputValue().catch(() => '');
    if (curPhoneType !== 'cell') {
      await phoneTypeEl.selectOption('cell').catch(() => {});
      console.log('fillBasicInfo: reporter_primarytype set to cell (was:', curPhoneType + ')');
    } else {
      console.log('fillBasicInfo: reporter_primarytype already cell');
    }
  }

  // Date Reported — may be empty in cloud (not auto-filled). Fill today's date if blank.
  const reportedDateEl = page.locator('[name*="Notification_ReportedDate"]').first();
  const rdVis = await reportedDateEl.waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true).catch(() => false);
  if (rdVis) {
    const rdVal = await reportedDateEl.inputValue().catch(() => '');
    if (!rdVal) {
      const now = new Date();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const yyyy = now.getFullYear();
      const todayStr = `${mm}/${dd}/${yyyy}`;
      await reportedDateEl.fill(todayStr);
      await reportedDateEl.press('Tab');
      console.log('fillBasicInfo: Notification_ReportedDate filled:', todayStr);
    } else {
      console.log('fillBasicInfo: Notification_ReportedDate already set:', rdVal);
    }
  }

  // Phone fields.  GW Cloud Step 2 has two separate phone sections:
  //   1. Reporter phone (reporter_mobile, reporter_businessphone)
  //   2. Main Contact phone (MainContact_CellPhone) — REQUIRED by CC validation

  // 1. Main Contact CellPhone — required; fill it first
  const mainContactPhone = page.locator(
    'input[name*="MainContact_CellPhone"][name*="NationalSubscriberNumber"],' +
    'input[name*="MainContact"][name*="CellPhone"]'
  ).first();
  const mainContactPhoneVis = await mainContactPhone.waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true).catch(() => false);
  if (mainContactPhoneVis) {
    const existingMain = await mainContactPhone.inputValue().catch(() => '');
    if (!existingMain) {
      await mainContactPhone.fill(randomPhoneNumber());
      await mainContactPhone.press('Tab');
      console.log('fillBasicInfo: Main Contact cell phone filled');
    } else {
      console.log('fillBasicInfo: Main Contact cell phone already set to', existingMain);
    }
  } else {
    console.log('fillBasicInfo: Main Contact cell phone not found — may not be required for this LOB');
  }

  // 2. Reporter mobile (cell) phone
  const reporterMobile = page.locator('input[name*="reporter_mobile"][name*="NationalSubscriberNumber"]').first();
  const mobVis = await reporterMobile.waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true).catch(() => false);
  if (mobVis) {
    const mobVal = await reporterMobile.inputValue().catch(() => '');
    if (!mobVal) {
      await reporterMobile.fill(randomPhoneNumber());
      await reporterMobile.press('Tab');
      console.log('fillBasicInfo: reporter_mobile filled');
    } else {
      console.log('fillBasicInfo: reporter_mobile already set');
    }
  }

  // 3. Reporter business phone — fill if visible and empty (covers primarytype=work)
  const reporterBiz = page.locator('input[name*="reporter_businessphone"][name*="NationalSubscriberNumber"]').first();
  const bizVis = await reporterBiz.waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true).catch(() => false);
  if (bizVis) {
    const bizVal = await reporterBiz.inputValue().catch(() => '');
    if (!bizVal) {
      await reporterBiz.fill(randomPhoneNumber());
      await reporterBiz.press('Tab');
      console.log('fillBasicInfo: reporter_businessphone filled');
    }
  }

  // Select first vehicle checkbox — only present for Auto/WC LOBs.
  // Non-vehicle LOBs (BOP, CP, HO) skip vehicle selection entirely.
  const vehicleCheckboxes = page.locator('input[type="checkbox"]');
  const cbCount = await vehicleCheckboxes.count().catch(() => 0);

  if (cbCount > 0) {
    const checkbox = vehicleCheckboxes.first();
    // Click the visible parent/container instead of the hidden input
    try {
      await checkbox.locator('..').click({ force: true });
      console.log('First vehicle selected via checkbox parent');
    } catch (e1) {
      try {
        await checkbox.locator('../..').click({ force: true });
        console.log('First vehicle selected via grandparent');
      } catch (e2) {
        try {
          await checkbox.locator('xpath=ancestor::div[1]').click({ force: true });
          console.log('First vehicle selected via ancestor div');
        } catch (e3) {
          const vinLabel = page.locator('text=/VIN#/').first();
          if (await vinLabel.isVisible().catch(() => false)) {
            await vinLabel.click({ force: true });
            console.log('First vehicle selected via VIN label');
          } else {
            console.log('fillBasicInfo: no vehicle selection possible — skipping (non-Auto LOB)');
          }
        }
      }
    }
  } else {
    // No vehicle checkboxes — non-Auto LOB, skip vehicle selection
    const vinLabel = page.locator('text=/VIN#/').first();
    if (await vinLabel.isVisible({ timeout: 1000 }).catch(() => false)) {
      await vinLabel.click({ force: true });
      console.log('First vehicle selected via VIN label');
    } else {
      console.log('fillBasicInfo: no vehicle checkbox or VIN — non-Auto LOB, skipping vehicle selection');
    }
  }

  // Re-check HowReported still has a value — vehicle checkbox click can trigger
  // React re-renders that reset form state; re-fill if cleared.
  const howRepEl = page.locator('[name*="HowReported"]').first();
  const howRepVal = await howRepEl.inputValue().catch(() => '');
  if (!howRepVal) {
    console.log('fillBasicInfo: HowReported was reset after vehicle click, re-filling...');
    await selectFirstOption(page, '[name*="HowReported"]', 3000);
  } else {
    console.log('fillBasicInfo: HowReported still set to', howRepVal);
  }

  // Next → Step 3 (Loss Details)
  await page.getByRole('button', { name: 'Next', exact: true }).first().click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);

  // Where did that Next actually land? On BOP the run ended up on "Step 1 of 5:
  // Search or Create Policy" - CC jumps to whichever page holds errors, and
  // "Errors located on another page: <name>" names it. This was invisible before
  // because the later "Step 2 unloaded" check only proves Step 2 is gone, which
  // Step 1 also satisfies, so a backwards jump read as forward progress.
  const landed = await page.evaluate(() => {
    // innerText EXCLUDES collapsed/hidden content, and CC's Validation Results
    // panel sits collapsed at the right edge - which is why the diagnostics kept
    // reporting "No validation text found on screen" while a validation error
    // was in fact present. textContent includes it.
    const t = (document.body.innerText || '') + ' ' + (document.body.textContent || '');
    return {
      step: ((t.match(/Step\s*\d+\s*of\s*5[^\n]*/i) || [''])[0] || '').trim(),
      other: ((t.match(/Errors located on another page:[^\n]*/i) || [''])[0] || '').trim(),
      errs: [...t.matchAll(/^(.*(?:Missing required field|already exists on another claim|must be)[^\n]*)$/gim)]
        .map(m => m[1].trim()).slice(0, 4),
    };
  }).catch(() => ({ step: '', other: '', errs: [] }));
  console.log('fillBasicInfo: after Next → "' + landed.step + '"' +
              (landed.other ? ' | ' + landed.other : '') +
              (landed.errs.length ? ' | validation: ' + landed.errs.join(' || ') : ''));
  if (/Step\s*1\s*of\s*5/i.test(landed.step)) {
    // Walk forward again so Loss Details is not typed into Find Policy.
    console.log('fillBasicInfo: Next went BACKWARDS to Step 1 — walking forward again');
    for (let f = 0; f < 3; f++) {
      const nb = page.getByRole('button', { name: 'Next', exact: true }).first();
      if (!await nb.isVisible().catch(() => false)) break;
      await nb.click().catch(() => {});
      await page.waitForTimeout(1800);
      const cur = await page.evaluate(() =>
        ((document.body.innerText || '').match(/Step\s*\d+\s*of\s*5[^\n]*/i) || [''])[0].trim()
      ).catch(() => '');
      console.log('fillBasicInfo: forward walk now on "' + cur + '"');
      if (!/Step\s*1\s*of\s*5/i.test(cur)) break;
    }
  }

  // Handle "Possible Duplicate Claims" panel — appears at BOTTOM of Step 2 in cloud
  // (same as on-prem). If present, clicking Next shows the panel but does NOT advance
  // the wizard. Must click "Close" first, then click Next again.
  const step2StillForDup = await page.locator('[name*="HowReported"]').first()
    .waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
  if (step2StillForDup) {
    // Dup panel always contains Refresh+Close buttons — that pair is unique on the page.
    const step2RefreshVisible = await page.getByRole('button', { name: 'Refresh', exact: true })
      .waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
    if (step2RefreshVisible) {
      const step2CloseBtns = page.getByRole('button', { name: 'Close', exact: true });
      const step2CloseCount = await step2CloseBtns.count().catch(() => 0);
      const step2CloseBtn = step2CloseCount > 1 ? step2CloseBtns.last() : step2CloseBtns.first();
      const step2CloseVisible = await step2CloseBtn.waitFor({ state: 'visible', timeout: 2000 })
        .then(() => true).catch(() => false);
      if (step2CloseVisible) {
        await step2CloseBtn.click({ force: true });
        console.log('fillBasicInfo: Duplicate Claims panel closed (Playwright Refresh+Close, count=' + step2CloseCount + ')');
        await page.waitForTimeout(1000);
        await page.getByRole('button', { name: 'Next', exact: true }).first().click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        console.log('fillBasicInfo: Refresh visible but Close not found in dup panel');
      }
    } else {
      const errBody = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')
        .then(t => t.substring(0, 2000));
      console.log('fillBasicInfo: STILL ON STEP 2 after Next (no dup panel Refresh)! Body:', errBody);

      // Fill required comboboxes still sitting at "<none>", then retry Next.
      //
      // Confirmed via screenshot: the field CC rejects is "Injured Worker >
      // Name" on the RIGHT of the screen, at "<none>" and outlined red - NOT
      // "Reported By > Name", which is populated. Three comboboxes on this
      // screen are labelled "Name", so selecting by accessible name alone picks
      // the wrong one; the reliable discriminator is the unset "<none>" value
      // on a REQUIRED field. Injured Worker is a WC-shaped section that only
      // some LOBs render, which is why this never surfaced on-prem.
      const picked = await page.evaluate(() => {

        const out = [];
        for (const sel of document.querySelectorAll('select')) {
          if (!sel.offsetParent) continue;
          const cur = (sel.options[sel.selectedIndex]?.text || '').trim();
          if (!/^<?none>?$/i.test(cur)) continue;               // already answered
          const required = sel.required || sel.getAttribute('aria-required') === 'true' ||
                           /required|invalid|error/i.test(sel.className || '') ||
                           /required|invalid|error/i.test(sel.closest('div')?.className || '');
          if (!required) continue;
          const opt = [...sel.options].find(o => o.text && !/^<?none>?$/i.test(o.text.trim()));
          if (!opt) continue;
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          out.push((sel.getAttribute('aria-label') || sel.name || 'field') + ' -> ' + opt.text.trim());
        }
        return out;
      }).catch(() => []);

      if (picked.length) {
        console.log('fillBasicInfo: filled required <none> field(s): ' + picked.join(' | ') + ' — retrying Next');
        await page.waitForTimeout(800);
        await page.getByRole('button', { name: 'Next', exact: true }).first()
          .click({ timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // Filling Injured Worker lets Next through, which then surfaces the
        // "Possible Duplicate Claims" panel - the same panel the on-prem path
        // closes ("Duplicate Claims panel detected - closing it"). The existing
        // cloud dup handling runs BEFORE this retry, so it never sees a panel
        // that only appears after it. Close it and advance again.
        // Its message is advisory ("you can safely cancel out ... if it IS a
        // duplicate"), so closing and continuing is the intended path for a
        // deliberately-new claim.
        for (let dup = 0; dup < 2; dup++) {
          const dupOpen = await page.getByText(/Possible [Dd]uplicate [Cc]laims/).first()
            .isVisible().catch(() => false);
          if (!dupOpen) break;
          const closeBtn = page.getByRole('button', { name: 'Close', exact: true }).last();
          if (!await closeBtn.isVisible().catch(() => false)) break;
          await closeBtn.click({ timeout: 5000 }).catch(() => {});
          console.log('fillBasicInfo: closed "Possible Duplicate Claims" panel — advancing');
          await page.waitForTimeout(1000);
          await page.getByRole('button', { name: 'Next', exact: true }).first()
            .click({ timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1500);
        }
      } else {
        console.log('fillBasicInfo: no required "<none>" combobox found to fill');
      }
    }
  }

  // Report ACTUAL state, not intent. This used to log unconditionally, so a
  // wizard stuck on Step 2 still printed "Basic Info done → Step 3" and every
  // later log line read as progress that had not happened.
  const stillStep2 = await page.getByText(/Step 2 of 5/i).first().isVisible().catch(() => false);
  console.log(stillStep2 ? 'Basic Info INCOMPLETE — still on Step 2' : 'Basic Info done → Step 3');
}

// ── fillLossDetailsOnPrem (Step 3) ────────────────────────────────────────────
// Per explicit instruction: sweep every dropdown on the screen and select its
// first real (non-"<none>") option, skipping any that already have a value
// (e.g. Country defaults to "United States"). Location defaults to "New..."
// (i.e. "type in a brand new address manually", which is why City/State/Zip/
// Jurisdiction show required) - re-selecting it to an existing policy address
// instead auto-populates all of those, so City never needs manual typing.
async function fillLossDetailsOnPrem(page, { whatHappened = 'Automated FNOL test submission.', lossState = 'PA', lossCauseCode = '', skipInjuryIncident = false } = {}) {
  console.log('FNOL Step 3: Loss Details (on-prem)...');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  // For property/WC LOBs the FNOL wizard skips Steps 3 and 4 entirely, jumping
  // directly from Step 2 (Basic Info) to Step 5 (Save & Assign Claim). Detect
  // this by checking if the Loss Details Location combobox is actually visible.
  // If not visible, we are on the wrong step — return without clicking Next,
  // which would wrap the wizard back to Step 1 and create a draft with no claim#.
  const locationDetect = page.getByRole('combobox', { name: /^Location/i });
  const hasLossLocation = await locationDetect.waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true).catch(() => false);
  if (!hasLossLocation) {
    // HO-style Loss Details uses radio buttons for Location (no Location combobox).
    // Detect this by checking for "What Happened?" textarea — present = we ARE on
    // a Loss Details step, just with a different layout from Auto LOBs.
    const whatHappenedDetect = page.getByRole('textbox', { name: /What Happened/i }).first();
    const hasWhatHappened = await whatHappenedDetect.waitFor({ state: 'visible', timeout: 2000 })
      .then(() => true).catch(() => false);
    // Also check for raw <textarea> elements — ExtJS sometimes renders the
    // "What Happened?" field as a plain <textarea> without ARIA role="textbox".
    const hasAnyTextarea = !hasWhatHappened &&
      await page.locator('textarea:visible').count().then(c => c > 0).catch(() => false);
    if (!hasWhatHappened && !hasAnyTextarea) {
      console.log('fillLossDetailsOnPrem: no Location combobox and no What Happened textbox — not on Loss Details step, skipping');
      return;
    }
    console.log('fillLossDetailsOnPrem: HO-style Loss Details detected (no Location combobox, has What Happened textbox)');
  }

  const locationField = page.getByRole('combobox', { name: /^Location/i });
  const locationVisible = await locationField.waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true).catch(() => false);
  if (locationVisible) {
    await locationField.click();
    await page.waitForTimeout(300);
    const options = page.getByRole('option');
    const count = await options.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const text = (await options.nth(i).textContent() || '').trim();
      if (text && text !== 'New...' && text.toLowerCase() !== 'none') {
        await options.nth(i).click();
        console.log('Loss Location set to existing address:', text);
        break;
      }
    }
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  const combos = await page.getByRole('combobox').all();
  for (const combo of combos) {
    // Skip disabled comboboxes (e.g. City/State in a pre-filled address block)
    const isEnabled = await combo.isEnabled().catch(() => false);
    if (!isEnabled) continue;
    // Skip GlobalAddressInputSet fields (address sub-fields with no fixed pick-list)
    const comboId = await combo.getAttribute('id').catch(() => '');
    if (/GlobalAddressInputSet|QuickJump/i.test(comboId || '')) continue;
    const current = await combo.inputValue().catch(() => '');
    if (current && current !== '<none>' && current.trim() !== '') continue;

    const clicked = await combo.click({ timeout: 3000 }).then(() => true).catch(() => false);
    if (!clicked) continue;
    await page.waitForTimeout(300);
    const options = page.getByRole('option');
    const count = await options.count().catch(() => 0);
    let picked = false;
    for (let i = 0; i < count; i++) {
      const text = (await options.nth(i).textContent() || '').trim();
      if (text && text !== '<none>' && text.toLowerCase() !== 'none') {
        await options.nth(i).click();
        picked = true;
        break;
      }
    }
    if (!picked && count > 0) await options.first().click().catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  // Required free-text fields: "What Happened?" (textarea) and "City" (Loss
  // Location, required since Location shows "New..." i.e. entering a fresh
  // location manually).
  const whatHappenedField = page.getByRole('textbox', { name: /What Happened/i });
  const whatHappenedVisible = await whatHappenedField.waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true).catch(() => false);
  if (whatHappenedVisible) {
    await whatHappenedField.fill(whatHappened);
  } else {
    // Fallback: this screen likely has only one <textarea>.
    const textarea = page.locator('textarea').first();
    if (await textarea.count().catch(() => 0) > 0) await textarea.fill(whatHappened);
  }

  // HO-style Loss Details: handle Damage Type checkbox group and Property
  // checkbox group (Dwelling etc.) — these are multi-select checkboxes that
  // are NOT handled by sweepComboboxesOnPrem (comboboxes only) or by
  // clickUnansweredBooleanFieldsOnPrem (only handles Yes/No _true/_false pairs).
  if (!hasLossLocation) {
    const LC_TO_DAMAGE_TYPE = { LC01: 'Fire', LC02: 'Wind', LC33: 'Wind', LC35: 'Water', LC08: 'Theft', LC13: 'Theft' };
    const damageTypeTarget = LC_TO_DAMAGE_TYPE[lossCauseCode] || 'Fire';
    // ExtJS checkbox buttons are input[type="button"][role="checkbox"] — NOT input[type="checkbox"].
    // A label[for="..."] often exists but has EMPTY text (the label content is in a sibling span);
    // if we use the truthy-but-empty label as `lbl`, the fallback to parentElement never runs.
    // Fix: use a txt() helper that treats empty/whitespace as absent, chaining until non-empty.
    const dtResult = await page.evaluate((target) => {
      function txt(el) { return (el?.textContent || '').trim(); }
      const seen = new Set();
      const candidates = [
        ...Array.from(document.querySelectorAll('[role="checkbox"]')),
        ...Array.from(document.querySelectorAll('input[type="checkbox"]')),
        ...Array.from(document.querySelectorAll('input[type="button"].x-form-checkbox')),
        ...Array.from(document.querySelectorAll('.x-form-checkbox')),
      ].filter(el => { if (seen.has(el)) return false; seen.add(el); return true; });
      for (const inp of candidates) {
        const t = txt(inp.id ? document.querySelector('label[for="' + inp.id + '"]') : null)
          || txt(inp.closest('.x-form-cb-wrap, .x-form-check-wrap')?.querySelector('label,.x-form-cb-label'))
          || txt(inp.closest('.x-form-type-checkbox, .x-field')?.querySelector('label'))
          || inp.getAttribute('aria-label') || ''
          || txt(inp.parentElement)
          || inp.id || '';
        if (!t || !new RegExp(target, 'i').test(t)) continue;
        const alreadyOn = inp.getAttribute('aria-checked') === 'true'
          || inp.classList?.contains('x-form-cb-checked')
          || !!inp.parentElement?.classList?.contains('x-form-cb-checked');
        if (!alreadyOn) { inp.click(); return 'clicked:' + t.substring(0, 40); }
        return 'already-on:' + t.substring(0, 40);
      }
      return 'not-found:' + target;
    }, damageTypeTarget);
    console.log('HO Damage Type [' + damageTypeTarget + ']:', dtResult);
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);

    // Property checkboxes: check "Dwelling" — applicable to virtually every HO
    // fire/water/wind loss. Checking it reveals occupancy radio buttons; re-run
    // boolean sweep to capture those before proceeding.
    const propResult = await page.evaluate(() => {

      function txt(el) { return (el?.textContent || '').trim(); }
      const seen = new Set();
      const candidates = [
        ...Array.from(document.querySelectorAll('[role="checkbox"]')),
        ...Array.from(document.querySelectorAll('input[type="checkbox"]')),
        ...Array.from(document.querySelectorAll('input[type="button"].x-form-checkbox')),
        ...Array.from(document.querySelectorAll('.x-form-checkbox')),
        ...Array.from(document.querySelectorAll('[id*="Dwelling"],[id*="dwelling"]')),
      ].filter(el => { if (seen.has(el)) return false; seen.add(el); return true; });
      for (const inp of candidates) {
        const t = txt(inp.id ? document.querySelector('label[for="' + inp.id + '"]') : null)
          || txt(inp.closest('.x-form-cb-wrap, .x-form-check-wrap')?.querySelector('label,.x-form-cb-label'))
          || txt(inp.closest('.x-form-type-checkbox, .x-field')?.querySelector('label'))
          || inp.getAttribute('aria-label') || ''
          || txt(inp.parentElement)
          || inp.id || '';
        if (!/Dwelling/i.test(t)) continue;
        const alreadyOn = inp.getAttribute('aria-checked') === 'true'
          || inp.classList?.contains('x-form-cb-checked')
          || !!inp.parentElement?.classList?.contains('x-form-cb-checked');
        if (!alreadyOn) { inp.click(); return 'clicked:' + t.substring(0, 40); }
        return 'already-on:' + t.substring(0, 40);
      }
      return 'not-found-Dwelling';
    });
    console.log('HO Property [Dwelling]:', propResult);
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    await clickUnansweredBooleanFieldsOnPrem(page, null);
    await sweepComboboxesOnPrem(page, null);
  }

  const STATE_DEFAULTS = {
    PA: { city: 'Harrisburg',  county: 'Dauphin',    zip: '17101' },
    MI: { city: 'Lansing',     county: 'Ingham',     zip: '48906' },
    VA: { city: 'Richmond',    county: 'Richmond',   zip: '23219' },
    DE: { city: 'Wilmington',  county: 'New Castle', zip: '19801' },
    IA: { city: 'Des Moines',  county: 'Polk',       zip: '50301' },
    IN: { city: 'Indianapolis',county: 'Marion',     zip: '46201' },
    GA: { city: 'Atlanta',     county: 'Fulton',     zip: '30301' },
  };
  const stateDefaults = STATE_DEFAULTS[lossState] || STATE_DEFAULTS.PA;

  const cityField = page.getByRole('textbox', { name: /^City/i });
  const cityVisible = await cityField.waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true).catch(() => false);
  if (cityVisible) {
    const existingCity = await cityField.inputValue().catch(() => '');
    if (!existingCity) {
      await cityField.fill(stateDefaults.city);
      await cityField.press('Tab');
    }
  }

  // Per user instruction: "Vehicles, People, & Property" has THREE add
  // buttons ("Add Vehicle" / "Add Injury" / "Add Property Damage") -
  // confirmed via live screenshot that skipping Vehicle/Property Damage
  // (only Injury was ever handled) left those records missing, which later
  // causes problems during exposure creation (e.g. the Vehicle Incident
  // popup's "Select vehicle" having nothing real to pick, or a coverage
  // needing a linked property-damage record that doesn't exist). Click
  // each, and since there's no recorded codegen for Vehicle/Property
  // Damage's own field sets, use the generic sweep helpers (unscoped - no
  // known id prefix for these inline forms) to fill whatever they need.
  async function fillEmptyTextboxesByLabel() {
    // Confirmed via live screenshot: a blind "Automated test entry" string
    // broke NUMERIC-only fields ("Year: must be a four-digit year between
    // 1000 and 2999", "Loss Estimate: must be a numeric value.") - inspect
    // each field's own label first and pick an appropriate value instead of
    // one-size-fits-all text.
    const emptyTextboxInfo = await page.evaluate(() => {

      const boxes = Array.from(document.querySelectorAll('input[type="text"], textarea'))
        .filter(el => el.offsetParent !== null && !el.value);
      return boxes.map(el => {
        const item = el.closest('.x-form-item') || el.closest('.x-field');
        const labelEl = item ? item.querySelector('.x-form-item-label') : null;
        const label = (labelEl ? labelEl.textContent : (el.getAttribute('aria-label') || '')).trim();
        return { id: el.id, label };
      });
    }).catch(() => []);
    // Confirmed via user report: a "Date" field (e.g. a repair/inspection
    // date on the Vehicle/Property Damage incident popups) was ALSO getting
    // the same blind "Automated test entry" string - a date PICKER field
    // rejects free text outright, so the field stayed invalid no matter how
    // many sweep passes ran, and the caller's own OK-verify-retry loop (3
    // attempts, each re-typing the same bad value) burned a long time before
    // finally giving up. Same MM/DD/YYYY format already used for Loss Date.
    function formattedDate(daysOffset) {
      const d = new Date();
      d.setDate(d.getDate() + daysOffset);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return mm + '/' + dd + '/' + d.getFullYear();
    }
    for (const { id, label } of emptyTextboxInfo) {
      if (!id) continue;
      let value = 'Automated test entry';
      // Confirmed via live screenshot: "When to Inspect" is a FUTURE-dated
      // appointment, not a past loss/incident date - a general "date" fill
      // using yesterday's date failed its own validation ("must be a valid
      // date in the format ..."). Schedule/appointment-style labels need a
      // date ahead of today instead; everything else "date"-labeled is
      // treated as a past incident/loss-related date.
      if (/inspect|schedule|appointment/i.test(label)) value = formattedDate(7);
      else if (/date/i.test(label)) value = formattedDate(-1);
      else if (/^#\s*of\s+stories$/i.test(label) || /number of/i.test(label)) value = '2';
      else if (/year/i.test(label)) value = '2020';
      else if (/estimate|amount|value|cost|price/i.test(label)) value = '1000';
      // Confirmed via live screenshot: a blind "Automated test entry" string
      // also broke ADDRESS fields - ZIP Code flagged invalid (non-numeric),
      // and City/Address held garbage text instead of a real-looking value.
      // Use a plausible fake address instead for these specific labels.
      else if (/^address\s*1$/i.test(label)) value = '123 Main St';
      else if (/^address\s*2$/i.test(label)) value = '';
      else if (/^city$/i.test(label)) value = stateDefaults.city;
      else if (/^county$/i.test(label)) value = stateDefaults.county;
      else if (/zip\s*code/i.test(label)) value = stateDefaults.zip;
      if (value === '') continue;
      const box = page.locator(`[id="${id}"]`);
      await box.fill(value).catch(() => {});
      // Confirmed via user report: moving to the next field too fast after
      // typing can outrun the app's own commit of the value - Tab out to
      // force a blur/commit before continuing to the next field.
      await box.press('Tab').catch(() => {});
      await page.waitForTimeout(150);
    }
  }

  async function addRecordAtStep3(buttonLabel) {
    const btn = page.getByText(buttonLabel, { exact: true }).first();
    const hasBtn = await btn.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (!hasBtn) return false;
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await btn.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(250);

    // Confirmed via live screenshot: for "Add Vehicle", a generic random
    // pick on "Select vehicle" landed on "New..." (create a brand-new
    // vehicle), which then cascades into MANY more required fields
    // (Year/Make/Model/VIN/License/etc.) - pick an EXISTING real vehicle
    // instead when one is available, same "New..." avoidance already used
    // for Loss Location.
    const selectVehicleCombo = page.getByRole('combobox', { name: 'Select vehicle', exact: true });
    const hasSelectVehicle = await selectVehicleCombo.waitFor({ state: 'visible', timeout: 2000 })
      .then(() => true).catch(() => false);
    if (hasSelectVehicle) {
      await selectVehicleCombo.click();
      await page.waitForTimeout(150);
      const options = page.getByRole('option');
      const count = await options.count().catch(() => 0);
      let pickedExisting = false;
      for (let i = 0; i < count; i++) {
        const text = (await options.nth(i).textContent() || '').trim();
        if (text && text !== '<none>' && !/^new/i.test(text)) {
          await options.nth(i).click();
          pickedExisting = true;
          break;
        }
      }
      if (!pickedExisting && count > 0) await options.first().click();
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(150);
    }

    // Verify-and-retry: sweep, fill textboxes, click OK, and check whether
    // it actually closed (no more validation banners) before assuming
    // success - confirmed via live failure that clicking OK with fields
    // still missing just re-shows the SAME popup with validation errors,
    // and the caller then hangs trying to click "Next" from a screen it
    // never actually left.
    let closed = false;
    for (let attempt = 0; attempt < 3 && !closed; attempt++) {
      await sweepComboboxesOnPrem(page, null);
      await clickUnansweredBooleanFieldsOnPrem(page, null);
      await fillEmptyTextboxesByLabel();
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      const okBtn = page.getByText('OK', { exact: true }).first();
      await okBtn.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      closed = await okBtn.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true).catch(() => false);
    }
    if (!closed) {
      // Bail out via Cancel rather than leaving the wizard stuck on this
      // popup - the subsequent "Next" click would otherwise hang
      // indefinitely waiting for a screen it never left.
      await page.getByText('Cancel', { exact: true }).first().click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    }
    console.log(buttonLabel + (closed ? ' added during FNOL Step 3, back on Loss Details' : ' - could NOT close popup after 3 attempts, cancelled instead'));
    return closed;
  }

  // Per user instruction: do NOT use the "Add Vehicle" button - a vehicle
  // Incident record is already auto-created for every vehicle selected as
  // "involved" back on FNOL Step 2 (confirmed via live screenshot: a yellow
  // "2023 CADILLAC ESCALADE" card already sits here with no button click at
  // all). Clicking "Add Vehicle" instead created a bogus brand-new fictional
  // vehicle, cascading into a wall of extra required fields that our
  // generic sweep couldn't reliably clear. Open each EXISTING vehicle card
  // instead and just fill in ITS remaining required fields.
  const vehicleNameLinks = page.locator('[id*="VehicleIncidentIterator"][id$="VehicleName-inputEl"]');
  const vehicleCount = await vehicleNameLinks.count().catch(() => 0);
  for (let i = 0; i < vehicleCount; i++) {
    const link = vehicleNameLinks.nth(i);
    const vehicleText = await link.textContent().catch(() => '(unknown vehicle)');
    await link.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(250);

    let closed = false;
    for (let attempt = 0; attempt < 3 && !closed; attempt++) {
      await sweepComboboxesOnPrem(page, null);
      await clickUnansweredBooleanFieldsOnPrem(page, null);
      await fillEmptyTextboxesByLabel();
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      const okBtn = page.getByText('OK', { exact: true }).first();
      await okBtn.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      closed = await okBtn.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true).catch(() => false);
    }
    if (!closed) {
      await page.getByText('Cancel', { exact: true }).first().click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    }
    console.log('Vehicle Incident for "' + vehicleText.trim() + '"' +
      (closed ? ' completed during FNOL Step 3' : ' - could NOT close popup after 3 attempts, cancelled instead'));
  }

  await addRecordAtStep3('Add Property Damage');

  // Create the Injury Incident on EVERY LOB, not just WC.
  //
  // This was previously gated to WC because on auto/property LOBs the incident
  // routes the claim to BI Claims Division rather than Fast Track, which broke
  // the segment assertions. That trade was the wrong way round: a claim whose
  // exposures are Bodily Injury Liability genuinely needs injury data, and
  // without it CC holds the exposures invalid ("Exposure description must not
  // be empty", "Detailed body part must not be null"), offers NO reserve line,
  // and payment/approval/close can never run at all - confirmed on
  // CA-OH-85-26-0000369, which had no injury incident and blank body parts.
  // Per user decision: create every incident FNOL offers and let the segment
  // expectations follow CC's real behaviour instead of avoiding it.
  const createInjuryIncident = true;   // was: !skipInjuryIncident
  if (createInjuryIncident) {
  const addInjuryBtn = page.locator('[id$="AddInjuryIncidentButton-btnInnerEl"]').first();
  const hasAddInjuryBtn = await addInjuryBtn.count().catch(() => 0) > 0
    ? await addInjuryBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)
    : false;
  if (hasAddInjuryBtn) {
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await addInjuryBtn.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);

    await selectComboboxOnPrem(page, 'Injured Person', undefined, { exact: true, random: true });

    const describeField = page.getByRole('textbox', { name: 'Describe Injuries', exact: true });
    if (await describeField.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
      await describeField.fill('Automated test - injury description');
    }

    // Confirmed via live failure: an Injury Incident created here with NO
    // Body Part row at all passes THIS popup's own OK click cleanly, but
    // later fails claim-wide validation with "Detailed body part must not
    // be null" - the incident record itself is genuinely incomplete without
    // one. Click "Add" under Body Parts (same id suffix confirmed on the
    // exposure-flow's own Injury Incident edit popup) and sweep its
    // required Area of Body / Body Part comboboxes before OK.
    const addBodyPartBtn = page.locator('[id$="EditableBodyPartDetailsLV_tb:Add-btnInnerEl"]').first();
    const hasAddBodyPartBtn = await addBodyPartBtn.waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true).catch(() => false);
    if (hasAddBodyPartBtn) {
      await addBodyPartBtn.click();
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(300);
      // Confirmed via live screenshot: "Area of Body"/"Body Part" are
      // INLINE-EDIT grid cells (same class of bug as the Set Reserves Cost
      // Type/Category cells) - sweepComboboxesOnPrem only finds pre-existing
      // role=combobox elements already in the DOM, not cells that need a
      // click to reveal one, so it silently skipped both and they stayed
      // "<none>". Click each cell (by position: Area of Body then Body
      // Part, the only two "<none>" cells on this new row) and pick a real
      // boundlist option directly.
      // Confirmed via live screenshot: re-scanning "first remaining <none>
      // cell" after each pick is racy - Area of Body filled fine but Body
      // Part's turn never landed. Target FIXED column indices instead
      // (checkbox=0, Area of Body=1, Body Part=2, confirmed via the same
      // screenshot's header order) and verify+retry each one independently.
      // Confirmed via live diagnostic: `.filter({ hasText: '<none>' })` is
      // re-evaluated fresh EVERY time bodyPartRow is used - once a cell
      // fill actually succeeds and no cell on the row still says "<none>",
      // this filter stops matching the row at all, so the "did it work?"
      // re-check silently reads from a non-existent element (caught by
      // .catch(() => ''), a falsy value that looks identical to "still
      // blank"). This made every successful fill look like a failure,
      // wasting 2 extra retry passes every single time (contributing to
      // the reported slowness) and printing a false "WARNING" even though
      // the row was actually filled correctly. Capture the row by its
      // fixed position (it's the newly-added, always-last row) instead of
      // a content filter that invalidates itself.
      const bodyPartRowIndex = await page.locator('.x-grid-row').count().catch(() => 1) - 1;
      const bodyPartRow = page.locator('.x-grid-row').nth(bodyPartRowIndex);
      async function fillBodyPartCell(columnIndex, label) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const cellText = await bodyPartRow.locator('.x-grid-cell').nth(columnIndex).textContent().catch(() => '');
          if (cellText && !cellText.includes('<none>')) return;
          const cell = bodyPartRow.locator('.x-grid-cell').nth(columnIndex);
          await cell.click({ force: true, timeout: 5000 }).catch(() => {});
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
        }
        const finalCellText = await bodyPartRow.locator('.x-grid-cell').nth(columnIndex).textContent().catch(() => '(read failed)');
        console.log('WARNING: ' + label + ' body part cell may not have registered after 3 attempts - final cell text: "' + finalCellText + '"');
      }
      await fillBodyPartCell(1, 'Area of Body');
      await fillBodyPartCell(2, 'Body Part');
      // Column 3 is "Body Part Detail" - the field CC later reports as
      // "Detailed body part must not be null". Only columns 1 and 2 were being
      // filled, so every BI exposure carried a null detailed body part, the
      // claim failed validation, and the payment wizard then offered NO reserve
      // line at all - a failure three screens away from this cause.
      await fillBodyPartCell(3, 'Body Part Detail');
      const bodyPartRowText = await bodyPartRow.innerText().catch(() => '');
      console.log('Injury Incident: Body Part row -> ' +
                  (bodyPartRowText || '(unreadable)').replace(/\s+/g, ' ').trim().slice(0, 90));
    }

    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    // Confirmed via live DOM dump: "OK"/"Cancel" here are plain clickable
    // <generic> elements, NOT role=button - getByRole('button') never
    // matches them, which is why the click silently timed out despite the
    // incident's own fields (Injured Person, Describe Injuries) having
    // filled in successfully just before this.
    await page.getByText('OK', { exact: true }).first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    console.log('Injury Incident added during FNOL Step 3, back on Loss Details');
  }
  } // end skipInjuryIncident guard

  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  // Final pass after all popups closed: CC re-renders the Loss Details form when a
  // popup record is saved, resetting previously filled comboboxes (AssignmentType,
  // MultiClaimants, etc.) back to empty. Re-sweep NOW so they're filled before Next.
  await clickUnansweredBooleanFieldsOnPrem(page, null).catch(() => {});
  await sweepComboboxesOnPrem(page, null).catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 20000 }).catch(() => {});
  // Retry-with-verification instead of a single bare click. An unguarded click
  // here burned the full 15s action timeout and failed the whole FNOL when a
  // mask was still settling after the incident popups - confirmed live on PA,
  // which had completed this same step cleanly minutes earlier, so it is a
  // timing flake rather than a missing button. Re-sweep between attempts too:
  // CC re-renders this form when a popup record is saved, which can blank a
  // required combobox and make Next legitimately refuse to advance.
  await clickFnolNext(page, 'Loss Details', {
    repair: async () => {
      await clickUnansweredBooleanFieldsOnPrem(page, null).catch(() => {});
      await sweepComboboxesOnPrem(page, null).catch(() => {});
    },
  });
  console.log('Loss Details done → Step 4 (on-prem)');
}

// ── fillLossDetailsCloud (Step 3) ─────────────────────────────────────────────
// Completes required fields on the claim's Loss Details page AFTER FNOL.
//
// The Injury section ("Injury Description" and friends) is NOT part of the FNOL
// wizard - confirmed on a live WC claim - so it cannot be filled during Step 3.
// Left empty, FNOL still completes, but the claim fails CC's "Ability to Pay"
// validation level and the payment wizard later renders a "New Payment Error"
// page with no payee form. That surfaced three steps from the cause, as an
// empty Name dropdown.
//
// Fills EVERY required-but-empty control on the page rather than just the one
// field CC happened to name, since the next missing field would otherwise cost
// another full run to discover.
// Fills whatever CC has flagged with aria-invalid="true".
//
// On WC's Loss Details, pressing Update leaves the page in edit mode with the
// Validation Results panel EMPTY and a single aria-invalid control -
// EmploymentData_HireDate. Nothing names the problem in text, so a
// message-driven fix cannot see it, and a .gw-required sweep misses it too
// because the field is not marked required. The widget state is the only
// signal there is.
async function fixCloudInvalidControls(page) {
  const targets = await page.evaluate(() => {
    const out = [];
    for (const flagged of document.querySelectorAll('[aria-invalid="true"]')) {
      if (!flagged.offsetParent) continue;
      const wrap = flagged.closest('[id$="_Input"]');
      const lbl = wrap && wrap.querySelector('.gw-label');
      const caption = ((lbl && lbl.textContent) || '').trim().replace(/\s*\*$/, '');
      const ctl = /^(INPUT|TEXTAREA|SELECT)$/.test(flagged.tagName)
        ? flagged
        : (wrap && wrap.querySelector('input[type="text"], textarea, select'));
      if (!ctl || ctl.disabled || ctl.readOnly) continue;
      if (!ctl.id) ctl.id = 'e2e-inv-' + Math.random().toString(36).slice(2, 8);
      const key = caption + ' ' + (ctl.getAttribute('name') || '');
      out.push({
        id: ctl.id, caption: caption || key.slice(-30), tag: ctl.tagName,
        isDate: /date/i.test(key),
        options: ctl.tagName === 'SELECT'
          ? [...ctl.options].filter(o => o.value && !/^<?none>?$/i.test((o.text || '').trim()))
              .map(o => o.value).slice(0, 1)
          : null,
      });
    }
    return out.slice(0, 8);
  }).catch(() => []);

  const fixed = [];
  for (const t of targets) {
    const el = page.locator('[id="' + t.id + '"]').first();
    if (!await el.isVisible().catch(() => false)) continue;
    if (t.tag === 'SELECT') {
      if (!t.options || !t.options.length) continue;
      await el.selectOption(t.options[0]).catch(() => {});
    } else if (t.isDate) {
      // Well before any plausible loss date - a hire date after the injury
      // date would just be rejected again.
      await el.fill('01/01/2020').catch(() => {});
    } else {
      await el.fill('Automated E2E').catch(() => {});
    }
    await page.waitForTimeout(400);
    fixed.push(t.caption);
  }
  if (fixed.length) console.log('fixCloudInvalidControls: fixed ' + fixed.join(' | '));
  return fixed;
}

async function completeCloudLossDetails(page) {
  await page.getByLabel('Loss Details', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(2500);

  // Enter edit mode and VERIFY it. The required-field detection below only sees
  // editable controls, so if Edit never opened, the page reads as "nothing to
  // fill" - which is exactly what was reported on a claim CC was actively
  // complaining about.
  const updateBtn = () => page.getByRole('button', { name: 'Update', exact: true }).first();
  let inEditMode = await updateBtn().isVisible().catch(() => false);
  if (!inEditMode) {
    const edit = page.getByRole('button', { name: 'Edit', exact: true }).first();
    if (await edit.isVisible().catch(() => false)) {
      await edit.click().catch(() => {});
      inEditMode = await updateBtn().waitFor({ state: 'visible', timeout: 10000 })
        .then(() => true).catch(() => false);
    }
  }
  if (!inEditMode) {
    console.log('completeCloudLossDetails: could not enter edit mode on Loss Details');
    return false;
  }

  // Locate the required-but-empty controls, then drive them through PLAYWRIGHT.
  // A raw DOM value setter does update the element - the field reads back as
  // populated - but the framework never registers the change, so CC kept
  // reporting "Injury description must not be empty" against a box that
  // visibly had text in it. Same lesson as the Yes/No radios: real
  // user-style events are required here.
  const targets = await page.evaluate(() => {
    const out = [];
    for (const wrap of document.querySelectorAll('[id$="_Input"]')) {
      if (!wrap.offsetParent) continue;
      if (!wrap.querySelector('.gw-required')) continue;     // not a required field
      const lbl = wrap.querySelector('.gw-label');
      const caption = ((lbl && lbl.textContent) || '').trim().replace(/\s*\*$/, '');

      const sel = wrap.querySelector('select');
      if (sel && !sel.disabled) {
        const cur = ((sel.options[sel.selectedIndex] || {}).text || '').trim();
        if (cur && !/^<?none>?$/i.test(cur)) continue;
        const opt = [...sel.options].find(o => o.text && !/^<?none>?$/i.test(o.text.trim()));
        if (!opt) continue;
        if (!sel.id) sel.id = 'e2e-ld-' + Math.random().toString(36).slice(2, 8);
        out.push({ kind: 'select', id: sel.id, caption, value: opt.value, text: opt.text.trim() });
        continue;
      }

      const el = wrap.querySelector('textarea, input[type="text"]');
      if (!el || el.disabled || el.readOnly) continue;
      if ((el.value || '').trim()) continue;
      if (!el.id) el.id = 'e2e-ld-' + Math.random().toString(36).slice(2, 8);
      out.push({ kind: 'text', id: el.id, caption });
    }
    return out;
  }).catch(() => []);

  const filled = [];
  for (const t of targets) {
    const el = page.locator('[id="' + t.id + '"]').first();
    if (!await el.isVisible().catch(() => false)) continue;
    if (t.kind === 'select') {
      await el.selectOption(t.value).catch(() => {});
      filled.push(t.caption + '=' + t.text.slice(0, 24));
    } else {
      await el.fill('Automated E2E - injury sustained in the reported incident').catch(() => {});
      const got = (await el.inputValue().catch(() => '')).trim();
      filled.push(t.caption + '=' + (got ? 'filled' : 'WRITE DID NOT STICK'));
    }
    await page.waitForTimeout(300);
  }

  if (!filled.length) {
    console.log('completeCloudLossDetails: no required-but-empty fields on Loss Details');
    return true;
  }
  console.log('completeCloudLossDetails: filled ' + filled.join(' | '));

  // Commit, and confirm the commit ACTUALLY HAPPENED before moving on. The
  // page leaving edit mode (the Update button disappearing) is the signal;
  // previously this clicked Update, glanced at the validation panel and
  // reported "saved" while the edit was still pending, so the next step ran
  // against a claim that had not been updated at all.
  let committed = false;
  for (let attempt = 0; attempt < 3 && !committed; attempt++) {
    const btn = updateBtn();
    if (!await btn.isVisible().catch(() => false)) { committed = true; break; }
    await btn.click().catch(() => {});
    committed = await btn.waitFor({ state: 'hidden', timeout: 12000 })
      .then(() => true).catch(() => false);

    if (!committed) {
      // Still in edit mode - CC rejected the update. Fix what it names and retry.
      const why = await page.evaluate(() => {
        const p = document.getElementById('gw-south-panel');
        return p && p.offsetParent ? (p.innerText || '').replace(/\s+/g, ' ').slice(0, 250) : '';
      }).catch(() => '');
      console.log('completeCloudLossDetails: Update did not commit (attempt ' + (attempt + 1) +
                  ')' + (why ? ' — ' + why : ' — no validation text; checking widget state'));
      await fixCloudInvalidControls(page).catch(() => {});
      await answerUnansweredYesNoPairs(page).catch(() => {});
      await fixFieldsFromValidation(page).catch(() => {});
    }
  }

  if (!committed) {
    console.log('completeCloudLossDetails: FAILED to save Loss Details — leaving the page in edit mode');
    return false;
  }

  const remaining = await page.evaluate(() => {
    const p = document.getElementById('gw-south-panel');
    if (!p || !p.offsetParent) return '';
    return (p.innerText || '').replace(/\s+/g, ' ')
      .replace(/^\s*Validation Results\s*/i, '').replace(/^\s*Clear\s*/i, '').trim().slice(0, 250);
  }).catch(() => '');
  if (/injury description|must not be empty|missing required/i.test(remaining)) {
    console.log('completeCloudLossDetails: saved, but CC still reports — ' + remaining);
    return false;
  }
  console.log('completeCloudLossDetails: saved and committed');
  return true;
}

async function fillLossDetailsCloud(page, {
  lossState = 'PA',
  lossCauseCode = '',
  whatHappened = 'Automated FNOL test submission.',
} = {}) {
  console.log('FNOL Step 3: Loss Details...');
  await page.waitForLoadState('domcontentloaded');

  // Wait for the wizard to actually advance from Step 2 to Step 3.
  // We can't rely on the page title text ("Add claim information") because the
  // wizard navigation shows ALL step names in a breadcrumb visible on every step.
  // Instead, wait until the Step 2 "HowReported" select becomes hidden — that
  // confirms Step 2 content has unloaded and Step 3 content is being shown.
  // Allow up to 25 seconds for the cloud server round-trip.
  const step2Gone = await page.locator('[name*="HowReported"]').first()
    .waitFor({ state: 'hidden', timeout: 25000 }).then(() => true).catch(() => false);
  if (!step2Gone) {
    // Dump body snippet so we can see what's on screen if Step 2 is still showing
    const bodySnip = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '(err)')
      .then(t => t.substring(0, 2000));
    console.log('fillLossDetailsCloud: Step 2 still visible after 25s! Body snippet:', bodySnip);
  } else {
    console.log('fillLossDetailsCloud: Step 2 unloaded, Step 3 rendering...');
  }
  // Extra settle time for React to render the Step 3 form fields
  await page.waitForTimeout(2000);

  // Short settle pause after the wizard renders Step 3 content
  await page.waitForTimeout(1000);

  // WC Loss Details carries required fields the other LOBs don't, spread across
  // an "Injury" / "Employment Data" TAB PAIR - and CC only validates the tab
  // you can see, so filling the visible one and pressing Next leaves the other
  // tab's required fields silently unsatisfied. Confirmed via screenshots:
  //   Incident Location -> Date Employer Notified*, Time Employee Began Work*
  //   Employment Data   -> Occupational Class Code*, Employment Status*
  // Walk every tab and fill only what is marked REQUIRED and still unset.
  // Deliberately not touching optional fields (Date of Hire, State of Hire,
  // Employee Supervisor): populating those would invent data and show up later
  // as a bogus on-prem/cloud difference.
  await fillRequiredAcrossTabsCloud(page);

  // Create incidents HERE, on Loss Details, exactly as on-prem does ("Add
  // Property Damage added during FNOL Step 3"). The screen offers Add Vehicle /
  // Add Injury / Add Property Damage under "Vehicles, People, & Property".
  //
  // Doing it here rather than from the exposure screen matters: an exposure
  // cannot save without its incident, and creating one mid-exposure means a
  // half-built exposure is abandoned when that fails. With incidents already on
  // the claim, the exposure screen only has to SELECT one.
  await addCloudIncidents(page);

  // The Duplicate Claims panel may appear at the bottom of Step 3.
  // The "Close" button in GW Cloud might be a <div> or <button>; try both.
  // Use evaluate() to find by text content regardless of element type.
  const dupClosed = await page.evaluate(() => {

    // Look for "Possible Duplicate Claims" or "Duplicate Claims" tab
    const allEls = [...document.querySelectorAll('*')];
    for (const el of allEls) {
      if (el.children.length > 0) continue;
      if ((el.textContent || '').trim() !== 'Close') continue;
      // Walk up to find an ancestor with "Duplicate" text
      let anc = el.parentElement;
      for (let d = 0; d < 15 && anc; d++) {
        if (/Duplicate/i.test(anc.textContent || '')) {
          el.click();
          return 'clicked Close inside Duplicate panel (depth ' + d + ')';
        }
        anc = anc.parentElement;
      }
    }
    return null;
  }).catch(() => null);
  if (dupClosed) {
    console.log('fillLossDetailsCloud: duplicate claims panel closed:', dupClosed);
    await page.waitForTimeout(800);
  }

  // Dump ALL visible form field names on Step 3 for diagnosis.
  // Filter by getBoundingClientRect so we only capture rendered elements.
  const formDiag = await page.evaluate(() => {

    function isVis(el) {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    const selects = [...document.querySelectorAll('select')]
      .filter(isVis)
      .map(s => ({ name: s.name.slice(-60), opts: s.options.length,
        firstOpt: s.options[1] ? (s.options[1].value + ':' + s.options[1].text.slice(0, 20)) : '?' }));
    const inputs = [...document.querySelectorAll('input:not([type="hidden"])')]
      .filter(isVis)
      .map(i => ({ name: i.name.slice(-60), type: i.type, ph: i.placeholder.slice(0, 20) }));
    const textareas = [...document.querySelectorAll('textarea')]
      .filter(isVis)
      .map(ta => ({ name: ta.name.slice(-60), id: ta.id.slice(-40) }));
    return { selects, inputs, textareas };
  }).catch(() => ({}));
  console.log('fillLossDetailsCloud DIAG visible-selects:', JSON.stringify(formDiag.selects || []));
  console.log('fillLossDetailsCloud DIAG visible-inputs:', JSON.stringify(formDiag.inputs || []));
  console.log('fillLossDetailsCloud DIAG visible-textareas:', JSON.stringify(formDiag.textareas || []));

  // Fill the selects. selectFirstOption now uses waitFor internally (polls up
  // to 5s by default) so transient render delays won't cause silent skips.

  // Occurrence Number
  await selectFirstOption(page, '[name*="Policy_OccurNum"],[name*="OccurNum"],[name*="occurrenceNum"]');

  // Assignment Type
  await selectFirstOption(page, '[name*="Claim_AssignmentTypeCode"],[name*="AssignmentTypeCode"],[name*="assignmentType"]');

  // Loss Cause
  await selectFirstOption(page, '[name*="LossCause"],[name*="lossCause"]');

  // Detailed Loss Cause (optional — may not exist for all LOBs)
  await selectFirstOption(page, '[name*="detailedLossCause"],[name*="DetailedLossCause"]', 2000);

  // Description / "What Happened?" — textarea or text input
  const descSelectors = [
    '[name*="LossDetailsAddressDV-Description"]',
    '[name*="LossDetails"][name*="Description"]',
    '[name*="Description"]',
  ];
  let descFilled = false;
  for (const ds of descSelectors) {
    const dEl = page.locator(ds).first();
    const dVis = await dEl.waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true).catch(() => false);
    if (dVis) {
      await dEl.fill(whatHappened);
      console.log('fillLossDetailsCloud: description filled via', ds);
      descFilled = true;
      break;
    }
  }
  if (!descFilled) {
    const textarea = page.locator('textarea').first();
    const taVis = await textarea.waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true).catch(() => false);
    if (taVis) {
      await textarea.fill(whatHappened);
      console.log('fillLossDetailsCloud: description filled via first textarea');
      descFilled = true;
    }
  }
  if (!descFilled) {
    console.log('fillLossDetailsCloud: WARNING description not filled — field not found');
  }

  // Address Picker — selects a policy location, auto-filling City/State/Jurisdiction
  await selectFirstOption(page, '[name*="Address_Picker"],[name*="addressPicker"],[name*="LossLocation"]');

  // Next → Step 4 (Parties Involved) — only one click here.
  // finishFNOL handles Step 4→5 and the Step 5 "Save & Assign" submission.
  const nextButton = page.getByRole('button', { name: 'Next', exact: true }).first();
  await nextButton.waitFor({ state: 'visible' });
  await nextButton.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  console.log('Loss Details done → advancing to Step 4');
}


// ── handlePartiesInvolvedOnPrem (Step 4) ──────────────────────────────────────
// Already auto-populated from the policy (Insured, drivers, agent, etc. -
// confirmed via live screenshot showing pre-filled parties with no invalid/
// required markers).
// Confirmed via live screenshot (user-provided): the row checkbox column
// here is just a bulk-action ROW SELECTOR for the grid's own "Delete"
// button (grayed out until a row is checked) - it is NOT a per-party
// "included/notified" flag and has no bearing on whether the wizard can
// proceed. An earlier version of this function spent 3 retry attempts per
// row trying to check every single one, which never actually registered
// (confirmed: class stayed unchecked every attempt, every run) yet Next
// always advanced fine regardless - pure wasted time contributing to this
// step being slow. Do nothing here and just click Next.
async function handlePartiesInvolvedOnPrem(page) {
  console.log('FNOL Step 4: Parties Involved (on-prem)...');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  // For property/WC LOBs the wizard may skip Step 4 entirely and land directly
  // on Step 5 ("Save & Assign Claim"). Detect the active step header so we
  // don't click Next past the last step and loop back to Step 1.
  const stepTitle = await page.evaluate(() => {

    for (const el of document.querySelectorAll('*')) {
      if (el.children.length === 0) {
        const t = el.textContent?.trim();
        if (t && /^Step \d+:\s/.test(t)) return t;
      }
    }
    return null;
  });
  console.log('handlePartiesInvolvedOnPrem: current step header =', stepTitle);

  // Only click Next if we are genuinely on Step 4 (Parties Involved).
  // For property/WC LOBs the wizard skips to Step 5 directly after Basic Info;
  // if stepTitle is non-null and does NOT mention Step 4 / Parties Involved we
  // are on the wrong step (Step 5, or even Step 1 if a wrap already occurred).
  if (stepTitle && !/Step 4|Parties Involved/i.test(stepTitle)) {
    console.log('Not on Step 4 (got: ' + stepTitle + ') — skipping Next, letting finishFNOL handle submit');
    return;
  }

  await clickFnolNext(page, 'Parties Involved', {
    repair: async () => {
      await clickUnansweredBooleanFieldsOnPrem(page, null).catch(() => {});
      await sweepComboboxesOnPrem(page, null).catch(() => {});
    },
  });
  console.log('Parties Involved done → Step 5 (on-prem)');
}

async function finishFNOL(page, assertClaimNumber = true) {
  console.log('FNOL Step 5: Finish...');

  if (IS_ON_PREM) {
    // Auto LOBs use FNOLWizard:Finish; property/WC/other LOBs use a different
    // button (e.g. "Save & Assign Claim"). Detect which is present dynamically.
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 20000 }).catch(() => {});

    let finishId = await findFirstVisibleId(page, FINISH_BUTTON_IDS);

    if (!finishId) {
      if (CC_DEBUG) {
        const allFnolIds = await page.evaluate(() =>
          [...document.querySelectorAll('[id^="FNOLWizard:"]')]
            .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
            .map(el => el.id)
        );
        console.log('FNOLWizard visible IDs on Step 5:', allFnolIds);
      }

      // Only match actual wizard-level ExtJS button elements. Two guards:
      // 1) class contains "x-btn" (not panel containers or info-bar icons)
      // 2) ID has exactly 2 colon-separated parts ("FNOLWizard:ButtonName") —
      //    deeply nested buttons like FNOLWizard:StepSet:Screen:AddVehicleButton
      //    have 4 parts and are step-panel controls, not the wizard submit button.
      const exclude = /Next|Prev|Cancel|Back|Previous|ClaimInfoBar|FNOLMenuActions/i;
      finishId = await page.evaluate((excludeRe) => {
        const re = new RegExp(excludeRe, 'i');
        for (const el of document.querySelectorAll('[id^="FNOLWizard:"][class*="x-btn"]')) {
          if (re.test(el.id)) continue;
          if (el.id.split(':').length !== 2) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return el.id;
        }
        return null;
      }, exclude.source);
    }

    // If no finish button yet but Next is still visible, the wizard has extra
    // policy-specific steps (e.g. PolicyWizardStepGroup:PolicyGeneral /
    // PolicyDetails seen on some PA policies). Click through them until Finish
    // appears — sweep any required fields on each intermediate screen first.
    // Confirmed via run-31 (policy 1002241916): after Parties Involved, CC
    // rendered extra wizard tabs and only showed Next >, not Finish.
    if (!finishId) {
      // Compute a fill date (yesterday) for WC date fields (Date Employer Notified, etc.)
      const _fillDateObj = new Date(); _fillDateObj.setDate(_fillDateObj.getDate() - 1);
      const _fillDate = String(_fillDateObj.getMonth() + 1).padStart(2, '0') + '/' +
                        String(_fillDateObj.getDate()).padStart(2, '0') + '/' +
                        _fillDateObj.getFullYear();
      // Limit raised from 6→15: some PA policies render PolicyGeneral + PolicyDetails +
      // Documents + Notes + (additional sub-steps) before the Summary/Finish screen —
      // 6 was not always sufficient. Confirmed via run-32.
      for (let extraStep = 0; extraStep < 15 && !finishId; extraStep++) {
        const nextStillVisible = await page.locator('[id="FNOLWizard:Next"]')
          .waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
        if (!nextStillVisible) break;
        // HO incident screens: click "Add" in any visible editable rooms table that
        // has no rows — CC requires at least one room before Next will advance.
        const emptyRoomsAdds = await page.evaluate(() => {

          const results = [];
          for (const el of document.querySelectorAll('[id$="EditableRoomsLV_tb:Add"]')) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const bodyId = el.id.replace(/_tb:Add$/, '-body');
            const body = document.getElementById(bodyId);
            if (!body || body.querySelectorAll('.x-grid-row').length === 0) results.push(el.id);
          }
          return results;
        }).catch(() => []);
        for (const btnId of emptyRoomsAdds) {
          console.log('finishFNOL step', extraStep + 1, ': adding rooms row ->', btnId.slice(-50));
          await page.locator(`[id="${btnId}"]`).click({ timeout: 2000 }).catch(() => {});
          await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(400); // allow ELV row to render after store update
        }
        // Set ELV Rooms row values via ExtJS store API — bypasses click-to-edit UI.
        // Runs every step: the row persists after failed Next but fields remain at defaults.
        const elvApiResult = await page.evaluate(() => {

          try {
            if (typeof Ext === 'undefined') return { ok: false, reason: 'Ext not defined' };
            // Find the EditableRoomsLV grid component by DOM id
            let elvGrid = null;
            for (const comp of (Ext.ComponentQuery.query('grid') || [])) {
              try {
                const did = comp.el && comp.el.dom ? comp.el.dom.id : '';
                if (did.includes('EditableRoomsLV')) { elvGrid = comp; break; }
              } catch(e) {}
            }
            if (!elvGrid) {
              // Also try panel/container
              for (const comp of (Ext.ComponentQuery.query('panel,container') || [])) {
                try {
                  const did = comp.el && comp.el.dom ? comp.el.dom.id : '';
                  if (did.includes('EditableRoomsLV') && !did.includes('_tb') && !did.includes('-body')) {
                    elvGrid = comp; break;
                  }
                } catch(e) {}
              }
            }
            if (!elvGrid) return { ok: false, reason: 'ELV component not found' };
            const store = elvGrid.getStore ? elvGrid.getStore() : null;
            if (!store) return { ok: false, reason: 'no store' };
            if (store.getCount() === 0) return { ok: false, reason: 'store empty' };
            const rec = store.last();
            // Use Object.keys(rec.data) — rec.fields.each() does not exist in ExtJS 5/6
            const recData = rec.data || {};
            const fieldNames = Object.keys(recData);
            let numField = null, typeField = null;
            for (const fn of fieldNames) {
              const lo = fn.toLowerCase();
              if (!numField && (lo.includes('num') || lo.includes('room') || lo === 'count' || lo.includes('qty'))) numField = fn;
              if (!typeField && lo.includes('type')) typeField = fn;
            }
            const set = {};
            // Always set NumberOfRooms to 3 — default may be 1 (truthy) but CC still rejects
            if (numField) { rec.set(numField, 3); set[numField] = 3; }
            // For RoomType: get first valid code from the column editor's store
            if (typeField) {
              let typeCode = null;
              const col = (elvGrid.columns || []).find(c => c.dataIndex === typeField);
              if (col) {
                const ed = col.editor || (col.getEditor ? col.getEditor() : null);
                const edStore = ed && (ed.store || (ed.getStore ? ed.getStore() : null));
                if (edStore) {
                  const items = (edStore.data && edStore.data.items) ? edStore.data.items : [];
                  for (const r of items) {
                    const code = r.get ? r.get((ed && ed.valueField) || 'code') : null;
                    if (code) { typeCode = code; break; }
                  }
                  if (!typeCode && edStore.each) {
                    edStore.each(r => {
                      if (!typeCode) { const c = r.get((ed && ed.valueField) || 'code'); if (c) typeCode = c; }
                    });
                  }
                }
              }
              // If store empty/unavailable, keep current value (may already be a valid code like "Garage")
              if (typeCode) { rec.set(typeField, typeCode); set[typeField] = typeCode; }
              else { set[typeField] = '(kept:' + String(recData[typeField]).substring(0, 20) + ')'; }
            }
            // Activate the row: _Checkbox must be true for CC to include the row in Next submission
            if ('_Checkbox' in recData) {
              rec.set('_Checkbox', true);
              set['_Checkbox'] = true;
            }
            // Full data dump for diagnosis
            const dataStr = JSON.stringify(recData).substring(0, 500);
            return { ok: true, fieldNames, numField, typeField, set, dataStr };
          } catch(e) {
            return { ok: false, reason: String(e && e.message) };
          }
        }).catch(e => ({ ok: false, reason: String(e && e.message) }));
        console.log('finishFNOL step', extraStep + 1, ': ELV API:', JSON.stringify(elvApiResult).substring(0, 300));
        // Diagnostic: if ELV API found the component but didn't match field names, dump all field names
        if (elvApiResult && elvApiResult.ok && elvApiResult.fieldNames && !elvApiResult.numField) {
          console.log('finishFNOL step', extraStep + 1, ': ELV field names (no match):', elvApiResult.fieldNames.join(', '));
        }
        // UI fallback: if ExtJS API failed or didn't set anything, attempt dblclick + inline input
        if (!elvApiResult || !elvApiResult.ok || !Object.keys(elvApiResult.set || {}).length) {
          const elvBodyIds = await page.evaluate(() => {

            const ids = [];
            for (const el of document.querySelectorAll('[id$="EditableRoomsLV-body"]')) {
              if (el.offsetParent !== null && el.querySelectorAll('.x-grid-row').length > 0) ids.push(el.id);
            }
            return ids;
          }).catch(() => []);
          for (const bodyId of elvBodyIds) {
            const lvBdy = page.locator(`[id="${bodyId}"]`);
            const firstCell = lvBdy.locator('.x-grid-row .x-grid-cell').first();
            if (!await firstCell.isVisible({ timeout: 800 }).catch(() => false)) continue;
            // Dump DOM inputs inside ELV body for diagnosis (first step only)
            if (extraStep === 0) {
              const elvInputs = await page.evaluate((bid) => {
                const body = document.getElementById(bid);
                if (!body) return [];
                return Array.from(body.querySelectorAll('input,select,textarea')).map(el => ({
                  id: el.id.slice(-40), type: el.type, val: el.value,
                  vis: el.offsetParent !== null,
                  display: getComputedStyle(el).display
                }));
              }, bodyId).catch(() => []);
              console.log('finishFNOL step', extraStep + 1, ': ELV DOM inputs:', JSON.stringify(elvInputs).substring(0, 400));
            }
            const cellTxt = (await firstCell.textContent({ timeout: 400 }).catch(() => '')).trim();
            if (cellTxt && cellTxt !== '0' && cellTxt !== '<none>') continue;
            await firstCell.dblclick({ timeout: 1000 }).catch(() => {});
            await page.waitForTimeout(400);
            let numIn = firstCell.locator('input:visible').first();
            if (!await numIn.isVisible({ timeout: 600 }).catch(() => false)) {
              numIn = lvBdy.locator('input:visible').first();
            }
            if (await numIn.isVisible({ timeout: 600 }).catch(() => false)) {
              await numIn.fill('3', { timeout: 1000 }).catch(() => {});
              await numIn.press('Tab').catch(() => {});
              await page.waitForTimeout(400);
              console.log('finishFNOL step', extraStep + 1, ': filled # of Rooms via dblclick fallback');
            }
          }
        }
        // Fill empty text/numeric/number fields (label-based).
        // Includes input[type="number"] so "# of Rooms" numeric inputs are also caught.
        const textFills = await page.evaluate((fd) => {
          const res = [];
          for (const el of document.querySelectorAll('input[type="text"], input[type="number"], textarea')) {
            if (el.offsetParent === null || el.value) continue;
            const item = el.closest('.x-form-item') || el.closest('.x-field');
            const labelEl = item && item.querySelector('.x-form-item-label');
            const lbl = (labelEl ? labelEl.textContent : (el.getAttribute('aria-label') || '')).trim();
            if (!lbl || !el.id) continue;
            let v = '';
            if (/damage.desc|description/i.test(lbl)) v = 'Automated incident description';
            else if (/what\s*happened/i.test(lbl)) v = 'Automated FNOL test submission.';
            else if (/^#\s*of\s+rooms/i.test(lbl) || /num.*room|room.*num/i.test(lbl)) v = '3';
            else if (/^#\s*of\s+stories/i.test(lbl)) v = '2';
            else if (/number\s+of/i.test(lbl)) v = '2';
            else if (/year/i.test(lbl)) v = '2000';
            else if (/estimate|amount|cost/i.test(lbl)) v = '5000';
            else if (/stay/i.test(lbl)) v = 'Staying with family';
            else if (/source.*fire|how.*discovered/i.test(lbl)) v = 'Unknown';
            else if (/date.*employer|employer.*notif|when.*employer|employer.*reported/i.test(lbl)) v = fd;
            else if (/^occupation\b/i.test(lbl)) v = 'General Worker';
            else if (/occurrence\s*(num|#|no)/i.test(lbl)) v = '1';
            else if (/claimant\s*(num|#|no)/i.test(lbl)) v = '1';
            if (v) res.push({ id: el.id, label: lbl, v });
          }
          return res;
        }, _fillDate).catch(() => []);
        for (const { id, label, v } of textFills) {
          console.log('finishFNOL step', extraStep + 1, ': filling [' + label + '] =', v);
          const box = page.locator(`[id="${id}"]`);
          await box.fill(v, { timeout: 1000 }).catch(() => {});
          await box.press('Tab').catch(() => {});
          await page.waitForTimeout(150);
        }
        // Also fill any ELV inline-edit cells inside the rooms table that don't have
        // a form-item label (column header labels are in the grid header, not adjacent).
        const elvFills = await page.evaluate(() => {

          const res = [];
          for (const el of document.querySelectorAll('[id*="EditableRoomsLV"] input')) {
            if (el.offsetParent === null || el.value || el.type === 'hidden') continue;
            const aria = el.getAttribute('aria-label') || '';
            const idL = el.id.toLowerCase();
            let v = '';
            if (/num|count|#|room/i.test(aria) || /num|count|nroom/i.test(idL)) v = '3';
            else if (/desc|damage/i.test(aria) || /desc|damage/i.test(idL)) v = 'Fire damage';
            if (!v) continue;
            res.push({ id: el.id, aria, v });
          }
          return res;
        }).catch(() => []);
        for (const { id, aria, v } of elvFills) {
          console.log('finishFNOL step', extraStep + 1, ': ELV cell [' + (aria || id.slice(-20)) + '] =', v);
          const box = page.locator(`[id="${id}"]`);
          await box.fill(v, { timeout: 1000 }).catch(() => {});
          await box.press('Tab').catch(() => {});
          await page.waitForTimeout(150);
        }
        // Pass 1: sweep comboboxes + standard booleans
        await sweepComboboxesOnPrem(page, null).catch(() => {});
        await clickUnansweredBooleanFieldsOnPrem(page, null).catch(() => 0);
        // HO Loss Details re-presented at Step 5 (some PA HO policies): the GW wizard
        // re-shows NewLossDetailsHomeownersDV as an extra wizard sub-step. The Damage
        // Type and Property fields are ExtJS checkbox buttons (not comboboxes), so they
        // are NOT swept by sweepComboboxesOnPrem. Re-click them here so GW's server
        // model gets the values via proper AJAX (Step 5 sub-form has live listeners).
        const _hoLDVVisible = await page.locator('[id*="NewLossDetailsHomeownersDV"]')
          .first().isVisible().catch(() => false);
        if (_hoLDVVisible) {
          const _hoDTResult = await page.evaluate(() => {

            function txt(el) { return (el?.textContent || '').trim(); }
            const seen = new Set();
            const candidates = [
              ...Array.from(document.querySelectorAll('[role="checkbox"]')),
              ...Array.from(document.querySelectorAll('input[type="checkbox"]')),
              ...Array.from(document.querySelectorAll('input[type="button"].x-form-checkbox')),
              ...Array.from(document.querySelectorAll('.x-form-checkbox')),
            ].filter(el => { if (seen.has(el)) return false; seen.add(el); return true; });
            // Find Damage Type section: detect any already-checked button to determine type
            let anyChecked = false;
            for (const inp of candidates) {
              if (!inp.offsetParent) continue;
              const checked = inp.getAttribute('aria-checked') === 'true'
                || inp.classList?.contains('x-form-cb-checked')
                || !!inp.parentElement?.classList?.contains('x-form-cb-checked');
              if (checked) { anyChecked = true; break; }
            }
            if (anyChecked) return 'already-checked';
            // No type checked → click Fire (default for HO fire loss, LC01)
            for (const inp of candidates) {
              if (!inp.offsetParent) continue;
              const t = txt(inp.id ? document.querySelector('label[for="' + inp.id + '"]') : null)
                || txt(inp.closest('.x-form-cb-wrap, .x-form-check-wrap')?.querySelector('label,.x-form-cb-label'))
                || txt(inp.closest('.x-form-type-checkbox, .x-field')?.querySelector('label'))
                || inp.getAttribute('aria-label') || ''
                || txt(inp.parentElement)
                || inp.id || '';
              if (/\bfire\b/i.test(t)) { inp.click(); return 'clicked-Fire:' + t.substring(0, 40); }
            }
            return 'not-found';
          }).catch(() => 'eval-err');
          console.log('finishFNOL: HO Loss Details DamageType re-click:', _hoDTResult);
          await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 3000 }).catch(() => {});
          // Also re-click Dwelling property checkbox
          const _hoPropResult = await page.evaluate(() => {

            function txt(el) { return (el?.textContent || '').trim(); }
            const seen = new Set();
            const candidates = [
              ...Array.from(document.querySelectorAll('[role="checkbox"]')),
              ...Array.from(document.querySelectorAll('input[type="checkbox"]')),
              ...Array.from(document.querySelectorAll('input[type="button"].x-form-checkbox')),
              ...Array.from(document.querySelectorAll('.x-form-checkbox')),
              ...Array.from(document.querySelectorAll('[id*="Dwelling"],[id*="dwelling"]')),
            ].filter(el => { if (seen.has(el)) return false; seen.add(el); return true; });
            for (const inp of candidates) {
              if (!inp.offsetParent) continue;
              const t = txt(inp.id ? document.querySelector('label[for="' + inp.id + '"]') : null)
                || txt(inp.closest('.x-form-cb-wrap, .x-form-check-wrap')?.querySelector('label,.x-form-cb-label'))
                || txt(inp.closest('.x-form-type-checkbox, .x-field')?.querySelector('label'))
                || inp.getAttribute('aria-label') || ''
                || txt(inp.parentElement)
                || inp.id || '';
              if (!/Dwelling/i.test(t)) continue;
              const alreadyOn = inp.getAttribute('aria-checked') === 'true'
                || inp.classList?.contains('x-form-cb-checked')
                || !!inp.parentElement?.classList?.contains('x-form-cb-checked');
              if (!alreadyOn) { inp.click(); return 'clicked:' + t.substring(0, 40); }
              return 'already-on';
            }
            return 'not-found';
          }).catch(() => 'eval-err');
          console.log('finishFNOL: HO Loss Details Dwelling re-click:', _hoPropResult);
          await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 3000 }).catch(() => {});
        }
        // Pass 2: label-based HO "Fire Questions" booleans (Yes/No/Unknown radio
        // groups that use _option2/_option3 IDs, not _true/_false). One targeted
        // pass is enough — no retry loop needed once we click with Playwright
        // trusted events. "No" is identified via sibling label text or option2.
        // HO "Fire Questions" radio buttons are rendered by ExtJS as
        // <input type="button" role="radio" componentid="..."> elements.
        // Clicking the DOM element fires browser events but does NOT update
        // ExtJS's internal form model — CC validation still sees the field as
        // empty. The only reliable method is Ext.ComponentManager.get(id).setValue(true)
        // which triggers ExtJS's own change pipeline and persists the value.
        // The componentid attribute on each input element IS the ExtJS component ID.
        // Collect and click HO "Fire Questions" radio buttons in two passes.
        // Pass 1 triggers any CC server-side panel refresh (e.g. showing
        // "Where staying?" when Habitable=No); pass 2 re-clicks everything
        // after that refresh settles so no field is left in a reset state.
        // Component IDs are re-evaluated before each pass because a server
        // refresh may replace the DOM with fresh elements.
        // Collect fire-question radio buttons (both Yes and No options).
        const collectLabelBools = async () => page.evaluate(() => {

          const KEYS = ['Injur', 'Smoke', 'Habitable', 'Secure', 'Fire Dep'];
          const YES_VALUES = ['Yes', 'yes', 'true', true];
          const res = [];
          for (const lbl of document.querySelectorAll('.x-form-item-label')) {
            if (!lbl.offsetParent) continue;
            const text = lbl.textContent.trim();
            if (!KEYS.some(k => text.includes(k))) continue;
            const item = lbl.closest('.x-form-item') || lbl.parentElement;
            if (!item || !item.offsetParent) continue;
            const radios = Array.from(item.querySelectorAll('input[role="radio"]'));
            if (!radios.length) continue;
            let noBtn = null, yesBtn = radios[0];
            // Find the "No" button by visual label
            for (const r of radios) {
              const cid = r.getAttribute('componentid') || '';
              const labelEl = cid && document.getElementById(cid + '-labelEl');
              if (!labelEl) continue;
              const t = labelEl.textContent.trim();
              if (/^no$/i.test(t)) noBtn = r;
              if (/^yes$/i.test(t)) yesBtn = r;
            }
            // If no label match, fall back via ExtJS inputValue
            if (!noBtn && window.Ext && Ext.ComponentManager) {
              for (const r of radios) {
                const cid = r.getAttribute('componentid') || '';
                if (!cid) continue;
                const c = Ext.ComponentManager.get(cid);
                if (c && !YES_VALUES.includes(c.inputValue) && c.inputValue !== 'Unknown') { noBtn = r; break; }
              }
              if (!noBtn) {
                // pick the non-Yes option
                for (const r of radios) {
                  const cid = r.getAttribute('componentid') || '';
                  const c = cid && Ext.ComponentManager.get(cid);
                  if (c && !YES_VALUES.includes(c.inputValue)) { noBtn = r; break; }
                }
              }
            }
            if (!noBtn) noBtn = radios[1] || radios[0];
            const componentId = noBtn.getAttribute('componentid') || noBtn.id.replace(/-inputEl$/, '');
            const yesComponentId = yesBtn.getAttribute('componentid') || yesBtn.id.replace(/-inputEl$/, '');
            res.push({ label: text.substring(0, 30), componentId, yesComponentId, isHabitable: /habitable/i.test(text) });
          }
          res.sort((a, b) => (b.isHabitable ? 1 : 0) - (a.isHabitable ? 1 : 0));
          return res;
        }).catch(() => []);

        // The fire questions are CONDITIONAL: CC only renders "Is Anyone
        // Injured?" / "Smoke Damage Only?" / "Is The Home Habitable?" after
        // Damage Type = Fire has been applied and the panel has redrawn. On the
        // first pass they are usually not in the DOM yet, so collectLabelBools
        // returned [] , nothing was filled, and Next came back with
        //   'Missing required field "Is Anyone Injured?"' ...
        // forcing the whole extra-wizard-step pass to run again. That cost one
        // full redundant pass on every HO FNOL. Poll briefly for them to appear
        // instead - they show up as soon as the redraw lands, so this normally
        // returns on the first or second check rather than waiting the cap.
        let labelBools = await collectLabelBools();
        if (!labelBools.length) {
          // Just ONE short settle, not a long poll. Measured on DEV: at extra
          // step 1 these fields are not in the DOM at all, and no amount of
          // waiting makes them appear - CC only renders them after the Next
          // click triggers its server-side redraw, which is why step 1 always
          // comes back with 'Missing required field "Is Anyone Injured?"' and
          // step 2 then fills them successfully. A 10-iteration poll therefore
          // only ever ran in the case where it could not possibly succeed.
          // The extra pass is CC's own flow requirement, not a defect to fix.
          await page.waitForTimeout(400);
          labelBools = await collectLabelBools();
          if (!labelBools.length) {
            console.log('finishFNOL: no fire questions on this screen yet (CC renders them after the next redraw)');
          }
        }
        // Declared here so the unroute call after the Next click can reference it
        let _ffInjectFn = null;
        if (labelBools.length) {
          // Interceptor: for every CC POST that contains fire question fields, replace
          // any Unknown or empty secondary values with No.  The Yes→No toggle loop
          // below fires dedicated AJAXs for each field; this ensures non-primary
          // fields in each AJAX are also No so CC's session stays consistent.
          const _ffFields = ['IsAnyoneInjured', 'SmokeDamageOnly', 'IsHomeHabitable', 'IsHomeSecure', 'FireDeptResponded'];
          _ffInjectFn = async (route) => {
            const req = route.request();
            if (req.method() !== 'POST') { await route.continue(); return; }
            const body = req.postData() || '';
            // Skip static resources; only handle CC action POSTs.
            if (!body) { await route.continue(); return; }
            const before = _ffFields.map(f => {
              const m = body.match(new RegExp(f + '=([^&%]*)'));
              return m ? f.replace(/^.*?(IsHome|IsAny|Smoke|IsHome|Fire)/, '$1') + ':' + (m[1] || '(empty)') : null;
            }).filter(Boolean).join(', ');
            let newBody = body;
            for (const f of _ffFields) {
              // Replace Unknown OR empty-string values with No
              newBody = newBody.replace(new RegExp(f + '=Unknown', 'g'), f + '=No');
              newBody = newBody.replace(new RegExp(f + '=(?=&|$)', 'g'), f + '=No');
              // Add fire field if entirely absent from this POST (covers the Next
              // button POST which doesn't naturally include fire question fields —
              // CC's wizard-step validation for "Required" checks the submitted
              // form data, so these must be present in the Next POST itself).
              if (!newBody.includes(f + '=')) newBody += '&' + f + '=No';
            }
            if (before || newBody !== body) {
              console.log('finishFNOL: CC POST fire fields:', before || '(none)', newBody !== body ? '→ injected No' : '(already No)');
            }
            await route.continue({ postData: newBody });
          };
          await page.route(/ClaimCenter\.do/, _ffInjectFn);

          // Yes→No toggle per field: each fire question gets its own dedicated AJAX.
          // CC validates each field only when it was explicitly changed in its own AJAX event.
          // Habitable is sorted first so "Where staying?" is revealed then stays visible.
          // Use Ext.ComponentManager.get(id).setValue(true) — DOM clicks on ExtJS
          // <input type="button" role="radio"> elements don't update ExtJS's form model
          // or trigger CC's per-field AJAX for fields that have no pre-existing value.
          // setValue goes through ExtJS's change pipeline (fires 'change' event → CC AJAX).
          // Re-collect componentIds before each field's toggle since CC may re-render
          // the DOM (new component instances with different IDs) after each AJAX round-trip.
          const FIRE_KEYS = ['Habitable', 'Injur', 'Smoke', 'Secure', 'Fire Dep'];
          for (const { label, componentId: origNoId, yesComponentId: origYesId } of labelBools) {
            const freshBools = await collectLabelBools();
            const matchKey = FIRE_KEYS.find(k => label.includes(k) || label.replace(' ', '').includes(k.replace(' ', '')));
            const fresh = matchKey ? freshBools.find(b => b.label.includes(matchKey) || b.label.replace(' ', '').includes(matchKey.replace(' ', ''))) : null;
            const yid = fresh ? fresh.yesComponentId : origYesId;
            const nid = fresh ? fresh.componentId : origNoId;

            // Set Yes via Ext API to force a state change, triggering CC field-change AJAX
            const yesResult = await page.evaluate(cid => {
              try {
                const c = window.Ext && Ext.ComponentManager && Ext.ComponentManager.get(cid);
                if (!c) return 'not-found';
                c.setValue(true);
                return 'ok';
              } catch (e) { return 'err:' + e.message; }
            }, yid).catch(() => 'eval-err');
            await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(400);

            // Set No via Ext API — dedicated per-field AJAX registers this field as answered
            const noResult = await page.evaluate(cid => {
              try {
                const c = window.Ext && Ext.ComponentManager && Ext.ComponentManager.get(cid);
                if (!c) return 'not-found';
                c.setValue(true);
                return 'ok';
              } catch (e) { return 'err:' + e.message; }
            }, nid).catch(() => 'eval-err');
            await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(400);
            console.log('finishFNOL: fire Q [' + label + '] Yes→No (Ext API yes:' + yesResult + ' no:' + noResult + ')');
          }
        }
        // Let ExtJS finish rendering any conditional fields revealed by the booleans
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        // Pass 3: re-sweep comboboxes + fill any text fields newly revealed by
        // the boolean answers above (e.g. "Where is the insured/family staying
        // now?" appears only after "Is The Home Habitable?" = No is clicked).
        await sweepComboboxesOnPrem(page, null).catch(() => {});
        // Re-fill text fields AFTER the combobox sweep — AJAX triggered by sweep
        // selections can wipe previously filled text fields (e.g. Accident Description).
        const condTexts = await page.evaluate((fd) => {
          const fills = [];
          for (const el of document.querySelectorAll('input[type="text"], textarea')) {
            if (el.offsetParent === null || el.value) continue;
            const item = el.closest('.x-form-item') || el.closest('.x-field');
            const lbl = ((item && item.querySelector('.x-form-item-label'))?.textContent || el.getAttribute('aria-label') || '').trim();
            if (!lbl || !el.id) continue;
            let v = '';
            if (/stay/i.test(lbl)) v = 'Staying with family';
            else if (/source.*fire/i.test(lbl)) v = 'Unknown';
            else if (/how.*discover/i.test(lbl)) v = 'Unknown';
            else if (/accident.*desc|injury.*desc|description/i.test(lbl)) v = 'Automated incident description';
            else if (/date.*employer|employer.*notif|when.*employer|employer.*reported/i.test(lbl)) v = fd;
            else if (/^occupation\b/i.test(lbl)) v = 'General Worker';
            else if (/occurrence\s*(num|#|no)/i.test(lbl)) v = '1';
            else if (/claimant\s*(num|#|no)/i.test(lbl)) v = '1';
            if (v) fills.push({ id: el.id, label: lbl.substring(0, 40), v });
          }
          return fills;
        }, _fillDate).catch(() => []);
        for (const { id, label, v } of condTexts) {
          console.log('finishFNOL step', extraStep + 1, ': conditional text [' + label + '] =', v);
          const box = page.locator(`[id="${id}"]`);
          await box.fill(v, { timeout: 1000 }).catch(() => {});
          await box.press('Tab').catch(() => {});
        }
        // Post-sweep explicit fills for WC time-picker fields and severity.
        // These are filled LAST so AJAX from the sweep cannot wipe them.
        // InjuryStartTime and LossTime: time-picker comboboxes where el.value stays
        // empty after boundlist selection — fill by typing directly.
        for (const timePart of ['InjuryStartTime', 'LossTime']) {
          const timeVal = await page.locator(`[id*="${timePart}-inputEl"]`).first()
            .inputValue().catch(() => null);
          if (timeVal === '') {
            await page.locator(`[id*="${timePart}-inputEl"]`).first().fill('10:00 AM').catch(() => {});
            await page.locator(`[id*="${timePart}-inputEl"]`).first().press('Tab').catch(() => {});
            await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});
            console.log('finishFNOL step', extraStep + 1, ': filled', timePart, 'via text input');
          }
        }
        // ExtSeverity: combobox filled AFTER all AJAX so AJAX can't wipe it.
        const extSevLocator = page.locator('[id*="ExtSeverity-inputEl"]').first();
        if (await extSevLocator.isVisible().catch(() => false)) {
          const extSevVal = await extSevLocator.inputValue().catch(() => null);
          if (!extSevVal || extSevVal === '<none>') {
            const extSevId = await extSevLocator.getAttribute('id').catch(() => '');
            if (extSevId) {
              await selectComboboxByIdOnPrem(page, extSevId);
              await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});
              console.log('finishFNOL step', extraStep + 1, ': ExtSeverity filled explicitly (post-sweep)');
            }
          }
        }
        // Do not assume Next exists on every extra step. On HO this click timed
        // out for 15s and failed the whole FNOL: once the wizard reaches its
        // final step the control is Finish, not Next, so waiting for Next is
        // waiting for something that will never appear. Check, and stop
        // stepping when the wizard has run out of Next buttons - the loop's own
        // finishId condition then takes over.
        const extraNext = page.locator('[id="FNOLWizard:Next"]');
        const hasExtraNext = await extraNext.waitFor({ state: 'visible', timeout: 5000 })
          .then(() => true).catch(() => false);
        if (!hasExtraNext) {
          const onFinish = await page.locator('[id="FNOLWizard:Finish"], [id*="Finish"]').first()
            .isVisible().catch(() => false);
          console.log('finishFNOL step', extraStep + 1,
                      ': no Next button on this step' +
                      (onFinish ? ' — a Finish button is present, so the wizard is at its final step'
                                : ' and no Finish button either') + '; stopping the step loop');
          break;
        }
        await extraNext.click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 6000 }).catch(() => {});
        // Unroute the fire-question interceptor now that the Next POST has landed
        if (_ffInjectFn) { await page.unroute(/ClaimCenter\.do/, _ffInjectFn).catch(() => {}); _ffInjectFn = null; }
        console.log('finishFNOL: clicked Next through extra wizard step', extraStep + 1);
        // Log any validation messages returned by CC so we can see exactly what's blocking
        const stepValidMsgs = await page.evaluate(() => {

          const items = [];
          for (const el of document.querySelectorAll('[id$="_msgs"]')) {
            if (el.offsetParent !== null) {
              const t = el.textContent.trim();
              if (t) items.push(t.substring(0, 200));
            }
          }
          return items;
        }).catch(() => []);
        if (stepValidMsgs.length) {
          console.log('finishFNOL step', extraStep + 1, ': CC validation msgs:', stepValidMsgs.join(' | ').substring(0, 500));
          // CC policy plugin failure is a server-side integration error — looping won't help.
          if (stepValidMsgs.some(m => /policy plugin has failed/i.test(m))) {
            throw new Error('finishFNOL: CC policy plugin failed — PolicyCenter integration unavailable for this LOB. Cannot complete FNOL.');
          }
        }
        // No retry pause here: this runs once per iteration of a 15-step loop
        // that already waits for masks, so the extra settle time is pure cost.
        finishId = await findFirstVisibleId(page, FINISH_BUTTON_IDS, 0);
      }
      // Last resort: if loop exhausted without finding Finish, jump directly to
      // the Summary tab (it's always a visible tab in the left nav).
      if (!finishId) {
        const summaryTab = page.locator('[id="FNOLWizard:Summary"]');
        const summaryVisible = await summaryTab.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
        if (summaryVisible) {
          console.log('finishFNOL: jumping directly to Summary tab');
          await summaryTab.click();
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
          finishId = await findFirstVisibleId(page, FINISH_BUTTON_IDS);
        }
      }
    }

    // Text-based fallback: look for any visible button/link with Submit/Save/Assign/Finish text
    let usedTextBtn = false;
    if (!finishId) {
      console.log('No ID-based finish button found — trying text-based fallback');
      if (CC_DEBUG) {
        const xBtnIds = await page.evaluate(() =>
          [...document.querySelectorAll('[class*="x-btn"]')]
            .filter(el => el.id && el.id.startsWith('FNOLWizard:'))
            .map(el => ({ id: el.id, text: el.textContent?.trim().substring(0, 40) }))
        );
        console.log('x-btn elements with FNOLWizard IDs:', JSON.stringify(xBtnIds));
      }

      // Try several selectors from most to least specific
      const candidates = [
        page.locator('.x-btn-text, .x-btn-inner').filter({ hasText: /Save.*Assign|Assign.*Claim|Finish|Submit/i }).first(),
        page.locator('button, input[type="submit"]').filter({ hasText: /Save.*Assign|Finish|Submit/i }).first(),
        page.getByRole('button', { name: /Save.*Assign|Assign.*Claim|Finish|Submit/i }).first(),
        page.getByRole('link', { name: /Save.*Assign|Assign.*Claim|Finish/i }).first(),
      ];
      // One settle for the whole list, then instant isVisible() checks - the old
      // per-candidate waitFor paid 3s for each of the 3 selectors that miss.
      await page.waitForTimeout(1200);
      for (const textBtn of candidates) {
        const found = await textBtn.isVisible().catch(() => false);
        if (found) {
          console.log('Using text-based finish button');
          await textBtn.click();
          usedTextBtn = true;
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
          break;
        }
      }
      if (!usedTextBtn) throw new Error('No FNOL finish/submit button found on Step 5');
    }

    let advanced = false;
    if (!usedTextBtn) {
      console.log('Using finish button:', finishId);
      // A mask was observed staying up and intercepting pointer events — bypass
      // actionability with a raw DOM click via evaluate(), then verify + retry.
      for (let attempt = 0; attempt < 3 && !advanced; attempt++) {
        await page.evaluate((id) => {
          const btn = document.getElementById(id);
          if (btn) btn.click();
        }, finishId);
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);
        advanced = await page.locator(`[id="${finishId}"]`).waitFor({ state: 'hidden', timeout: 8000 })
          .then(() => true).catch(() => false);
      }
      console.log('Finish clicked, advanced:', advanced);
      if (!advanced) {
        // Finish didn't advance wizard — read validation messages to diagnose why
        const finishValidMsgs = await page.evaluate(() => {

          const items = [];
          for (const el of document.querySelectorAll('[id$="_msgs"]')) {
            if (el.offsetParent !== null) {
              const t = el.textContent.trim();
              if (t) items.push(t.substring(0, 300));
            }
          }
          return items;
        }).catch(() => []);
        if (finishValidMsgs.length) {
          console.log('finishFNOL: Finish blocked by validation:', finishValidMsgs.join(' | ').substring(0, 600));
          // Sweep any newly exposed required fields and retry Finish once
          await sweepComboboxesOnPrem(page, null).catch(() => {});
          await clickUnansweredBooleanFieldsOnPrem(page, null).catch(() => 0);
          await page.evaluate((id) => { const btn = document.getElementById(id); if (btn) btn.click(); }, finishId);
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(1000);
          advanced = await page.locator(`[id="${finishId}"]`).waitFor({ state: 'hidden', timeout: 8000 })
            .then(() => true).catch(() => false);
          console.log('finishFNOL: Finish retry after validation sweep, advanced:', advanced);
        } else {
          console.log('finishFNOL: Finish not advanced and no validation messages found — Finish click may not have registered');
        }
      }
    } else {
      advanced = true;
    }
  } else {
    // Cloud wizard: 5 steps — Find Policy, Basic Info, Loss Details,
    // Parties Involved (Step 4), Save & Assign Claim (Step 5).
    // fillLossDetailsCloud leaves us on Step 4 (Parties Involved).
    // Loop: click Next through any remaining intermediate steps until
    // the "Finish" button appears (Step 5: Save & Assign Claim).
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1000);

    // The "Finish" element on Step 5 is a div with data-gw-shortcut, NOT a <button>.
    // Check for both the role-based button AND the shortcut element.
    async function isFinishVisible() {
      const byRole = await page.getByRole('button', { name: 'Finish', exact: true })
        .waitFor({ state: 'visible', timeout: 1000 }).then(() => true).catch(() => false);
      if (byRole) return true;
      return await page.locator('[data-gw-shortcut*="FNOLWizard-Finish"]')
        .waitFor({ state: 'visible', timeout: 1000 }).then(() => true).catch(() => false);
    }
    for (let step = 0; step < 5; step++) {
      if (await isFinishVisible()) {
        console.log('finishFNOL cloud: Finish button found after', step, 'Next click(s)');
        break;
      }
      const nextNow = page.getByRole('button', { name: 'Next', exact: true }).first();
      const nextIsVisible = await nextNow.waitFor({ state: 'visible', timeout: 3000 })
        .then(() => true).catch(() => false);
      if (!nextIsVisible) {
        console.log('finishFNOL cloud: neither Next nor Finish found at step', step, '— stopping loop');
        break;
      }
      console.log('finishFNOL cloud: clicking Next (step', step + 1, 'to reach Finish)');
      await nextNow.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1000);

      // If the wizard refused to advance, satisfy whatever CC named and retry
      // once. Without this the loop clicked Next five times against a page that
      // was never going to move - confirmed via screenshot, where the run
      // reported reaching step 5 while still sitting on "Step 2 of 5: Basic
      // information" with 'Name : Missing required field "Name"' on screen.
      // Claimant-number collision. CC refuses the claim with "This claimant
      // number already exists on another claim" whenever a prior claim on the
      // SAME policy used that number - so the first successful cloud claim is
      // exactly what blocks the next run (confirmed: WC-MI-70-26-0000153 took
      // claimant 1, the following run then failed on claimant 1).
      // On-prem avoids this in the exposure flow via _usedClaimantNumbers, but
      // the cloud wizard asks for it on this screen, where nothing tracked it.
      // Advance to the next available number and retry.
      // The error is RAISED on Step 5, but the "Claimant Number" control lives
      // back on Step 3 - so this has to walk BACK to that screen, change the
      // number, then walk forward again. Repeat until the validation clears:
      // each prior run consumes one number, so the next one can be taken too.
      for (let bumpTry = 0; bumpTry < 10; bumpTry++) {
        const collision = await page.evaluate(() =>
          /claimant number already exists on another claim/i.test(document.body.innerText || '')
        ).catch(() => false);
        if (!collision) break;

        // Walk back until the Claimant Number field is actually on screen.
        const claimantVisible = () => page.evaluate(() => {

          for (const sel of document.querySelectorAll('select')) {
            if (!sel.offsetParent) continue;
            if (((sel) => { const idish = ((sel.id || '') + ' ' + (sel.name || '')).replace(/[^a-z0-9]/gi, '').toLowerCase(); if (/claimant(number|num)/.test(idish)) return true; let el = sel.parentElement; for (let i = 0; i < 5 && el; i++, el = el.parentElement) { const t = el.innerText || ''; if (t.length < 400 && /claimant\s*number/i.test(t)) return true; } return false; })(sel)) return true;
          }
          return false;
        }).catch(() => false);

        let steppedBack = 0;
        while (!(await claimantVisible()) && steppedBack < 4) {
          const backBtn = page.getByRole('button', { name: /^Back$/i }).first();
          if (!await backBtn.isVisible().catch(() => false)) break;
          await backBtn.click().catch(() => {});
          await page.waitForTimeout(1500);
          steppedBack++;
        }
        if (!(await claimantVisible())) {
          console.log('finishFNOL cloud: claimant collision reported but the Claimant Number field ' +
                      'could not be reached after ' + steppedBack + ' Back click(s)');
          break;
        }

        const bumped = await page.evaluate(() => {

          for (const sel of document.querySelectorAll('select')) {
            if (!sel.offsetParent) continue;
            if (!((sel) => { const idish = ((sel.id || '') + ' ' + (sel.name || '')).replace(/[^a-z0-9]/gi, '').toLowerCase(); if (/claimant(number|num)/.test(idish)) return true; let el = sel.parentElement; for (let i = 0; i < 5 && el; i++, el = el.parentElement) { const t = el.innerText || ''; if (t.length < 400 && /claimant\s*number/i.test(t)) return true; } return false; })(sel)) continue;
            const next = sel.selectedIndex + 1;
            if (next >= sel.options.length) return 'EXHAUSTED';
            sel.selectedIndex = next;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return sel.options[next].text.trim();
          }
          return 'NO_CONTROL';
        }).catch(() => 'NO_CONTROL');

        if (bumped === 'EXHAUSTED') {
          throw new Error('CLAIMANT_POOL_EXHAUSTED (cloud): every claimant number on this policy is ' +
                          'already used by another claim — this policy needs fresh claimants or cleanup.');
        }
        if (bumped === 'NO_CONTROL') break;

        console.log('finishFNOL cloud: claimant collision — went back ' + steppedBack +
                    ' step(s), set Claimant Number to "' + bumped + '" (attempt ' + (bumpTry + 1) + ')');
        await page.waitForTimeout(800);

        // Walk forward again to where the claim gets saved.
        for (let fwd = 0; fwd <= steppedBack; fwd++) {
          const fwdNext = page.getByRole('button', { name: 'Next', exact: true }).first();
          if (!await fwdNext.isVisible().catch(() => false)) break;
          await fwdNext.click().catch(() => {});
          await page.waitForTimeout(1500);
        }
      }

      const fixed = await satisfyNamedRequiredFields(page);
      if (fixed.length) {
        console.log('finishFNOL cloud: satisfied required field(s) [' + fixed.join(', ') + '] — retrying Next');
        await nextNow.click().catch(() => {});
        await page.waitForTimeout(1000);
      }
    }

    // Helper: close a Duplicate Claims panel using Playwright locators.
    // The dup panel always contains a "Refresh" button alongside "Close" — that
    // pair is unique on the page, so Refresh visible = panel is present.
    async function closeDupPanel() {
      const refreshVisible = await page.getByRole('button', { name: 'Refresh', exact: true })
        .waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
      if (!refreshVisible) return null;
      const closeBtns = page.getByRole('button', { name: 'Close', exact: true });
      const closeCount = await closeBtns.count().catch(() => 0);
      if (closeCount === 0) return null;
      const closeBtn = closeCount > 1 ? closeBtns.last() : closeBtns.first();
      const closeVisible = await closeBtn.waitFor({ state: 'visible', timeout: 2000 })
        .then(() => true).catch(() => false);
      if (!closeVisible) return null;
      await closeBtn.click({ force: true });
      await page.waitForTimeout(500);
      return 'Playwright: Refresh+Close buttons in dup panel, clicked Close (count=' + closeCount + ')';
    }

    // Wait for Step 5 to fully settle before interacting — React event handlers must
    // be attached before Suppress / Finish clicks register properly.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // On Step 5 (Save & Assign Claim): handle "Suppress Agency Notice?" radio.
    // Jutro renders this as a custom div-based radio group with NO <input type="radio">.
    // Find and click the "No" option within the Suppress Agency Notice field container.
    const suppressResult = await page.evaluate(() => {

      const allEls = [...document.querySelectorAll('*')];
      // Strategy 1: find a leaf "No" node whose ancestor contains "Suppress Agency Notice"
      for (const el of allEls) {
        if (el.children.length > 0) continue;
        if ((el.textContent || '').trim() !== 'No') continue;
        let anc = el.parentElement;
        for (let d = 0; d < 10 && anc; d++) {
          if (/Suppress Agency Notice/i.test(anc.textContent || '')) {
            el.click();
            return 'clicked No within Suppress Agency Notice container (depth ' + d + ')';
          }
          anc = anc.parentElement;
        }
      }
      // Strategy 2: first leaf "No" node appearing AFTER the "Suppress Agency Notice" label
      let passedLabel = false;
      for (const el of allEls) {
        if (!passedLabel && /Suppress Agency Notice/i.test((el.textContent || '').trim())) {
          passedLabel = true;
        }
        if (passedLabel && el.children.length === 0 && (el.textContent || '').trim() === 'No') {
          el.click();
          return 'clicked first No after Suppress Agency Notice label';
        }
      }
      return null;
    }).catch(() => null);
    if (suppressResult) {
      console.log('finishFNOL cloud: Suppress Agency Notice =', suppressResult);
    } else {
      console.log('finishFNOL cloud: Suppress Agency Notice not found — proceeding anyway');
    }

    // Allow page to settle after Suppress Agency Notice selection before clicking Finish.
    await page.waitForTimeout(2000);

    // Helper to click Finish button. Logs button state for diagnosis.
    async function clickFinish() {
      // Diagnose button state before clicking
      const btnState = await page.evaluate(() => {

        const allBtns = [...document.querySelectorAll('button')];
        const finishBtns = allBtns.filter(b => b.textContent.trim() === 'Finish');
        if (finishBtns.length === 0) return 'NO Finish button in DOM';
        return finishBtns.map(b =>
          'disabled=' + b.disabled +
          ' aria-disabled=' + b.getAttribute('aria-disabled') +
          ' class=' + (b.className || '').substring(0, 80)
        ).join(' | ');
      }).catch(() => 'evaluate error');
      console.log('finishFNOL cloud: Finish button state:', btnState);

      // Try evaluate click (same approach as Suppress Agency Notice)
      const evalClicked = await page.evaluate(() => {

        const allBtns = [...document.querySelectorAll('button')];
        const finishBtns = allBtns.filter(b => b.textContent.trim() === 'Finish');
        if (finishBtns.length === 0) return false;
        finishBtns[finishBtns.length - 1].click();
        return true;
      }).catch(() => false);

      if (evalClicked) {
        console.log('Finish clicked (evaluate)');
        return true;
      }

      // Fallback: Playwright role-based click.
      // The terminal button is NOT always called "Finish" - property and WC
      // LOBs end on "Save & Assign Claim" (visible as the last step in the
      // cloud wizard's own left nav). The on-prem path already handles this via
      // FINISH_BUTTON_IDS; cloud only ever looked for "Finish", so a WC claim
      // walked all five steps and then reported "NO Finish button in DOM" while
      // the real terminal button sat on screen under a different name.
      for (const name of [/^Finish$/i, /Save\s*&?\s*Assign\s*Claim/i, /^Save and Assign/i, /^Submit$/i]) {
        const btn = page.getByRole('button', { name }).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ force: true });
          console.log('Finish clicked (by role): ' + name);
          return true;
        }
      }
      console.log('finishFNOL cloud: WARNING — no terminal button (Finish / Save & Assign Claim / Submit) found');
      return false;
    }

    await clickFinish();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    // Claimant-number collision is only raised AFTER Finish, on Step 5, as
    // "Errors located on another page: Loss Details". The earlier handling sat
    // inside the Next-clicking loop, which exits as soon as Finish is found -
    // so it never ran at the moment the error actually appears. Resolve it here
    // and press Finish again, repeating while the number stays taken (each
    // previous run consumes one).
    for (let attempt = 0; attempt < 8; attempt++) {
      await page.waitForTimeout(1200);
      const collision = await page.evaluate(() =>
        /claimant number already exists on another claim/i.test(document.body.innerText || '')
      ).catch(() => false);
      if (!collision) break;

      // CC offers a direct link to the offending page - far more reliable than
      // guessing how many Back clicks are needed.
      const jump = page.getByText(/Click here to navigate directly to the location/i).first();
      if (await jump.isVisible().catch(() => false)) {
        await jump.click().catch(() => {});
        await page.waitForTimeout(1500);
      }
      let onClaimantPage = await page.evaluate(() => [...document.querySelectorAll('select')]
        .some(s => s.offsetParent && ((sel) => { const idish = ((sel.id || '') + ' ' + (sel.name || '')).replace(/[^a-z0-9]/gi, '').toLowerCase(); if (/claimant(number|num)/.test(idish)) return true; let el = sel.parentElement; for (let i = 0; i < 5 && el; i++, el = el.parentElement) { const t = el.innerText || ''; if (t.length < 400 && /claimant\s*number/i.test(t)) return true; } return false; })(s))
      ).catch(() => false);
      for (let back = 0; !onClaimantPage && back < 4; back++) {
        const backBtn = page.getByRole('button', { name: /^Back$/i }).first();
        if (!await backBtn.isVisible().catch(() => false)) break;
        await backBtn.click().catch(() => {});
        await page.waitForTimeout(1500);
        onClaimantPage = await page.evaluate(() => [...document.querySelectorAll('select')]
          .some(s => s.offsetParent && ((sel) => { const idish = ((sel.id || '') + ' ' + (sel.name || '')).replace(/[^a-z0-9]/gi, '').toLowerCase(); if (/claimant(number|num)/.test(idish)) return true; let el = sel.parentElement; for (let i = 0; i < 5 && el; i++, el = el.parentElement) { const t = el.innerText || ''; if (t.length < 400 && /claimant\s*number/i.test(t)) return true; } return false; })(s))
        ).catch(() => false);
      }
      if (!onClaimantPage) {
        console.log('finishFNOL cloud: claimant collision, but the Claimant Number field could not be reached');
        break;
      }

      const bumped = await page.evaluate(() => {

        for (const sel of document.querySelectorAll('select')) {
          if (!sel.offsetParent) continue;
          if (!((sel) => { const idish = ((sel.id || '') + ' ' + (sel.name || '')).replace(/[^a-z0-9]/gi, '').toLowerCase(); if (/claimant(number|num)/.test(idish)) return true; let el = sel.parentElement; for (let i = 0; i < 5 && el; i++, el = el.parentElement) { const t = el.innerText || ''; if (t.length < 400 && /claimant\s*number/i.test(t)) return true; } return false; })(sel)) continue;
          const next = sel.selectedIndex + 1;
          if (next >= sel.options.length) return 'EXHAUSTED';
          sel.selectedIndex = next;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return sel.options[next].text.trim();
        }
        return 'NO_CONTROL';
      }).catch(() => 'NO_CONTROL');
      if (bumped === 'EXHAUSTED') {
        throw new Error('CLAIMANT_POOL_EXHAUSTED (cloud): every claimant number on this policy is ' +
                        'already used by another claim — needs fresh claimants or cleanup.');
      }
      if (bumped === 'NO_CONTROL') break;
      console.log('finishFNOL cloud: claimant collision — set Claimant Number to "' + bumped +
                  '" (attempt ' + (attempt + 1) + '), returning to Finish');

      // Repeated collisions mean the policy's claimant pool is used up. Retrying
      // cannot fix that, so stop early and let the caller report it as a
      // test-data problem instead of grinding through every attempt.
      if (attempt >= 2) {
        throw new Error(
          'POLICY EXHAUSTED: ' + (attempt + 1) + ' claimant numbers in a row were rejected as ' +
          'already used on another claim. This policy cannot take another claim. ' +
          'ACTION REQUIRED: supply a fresh policy number for this LOB (update the POLICY_* entry ' +
          'in .env) and re-run.');
      }

      // Forward to the end again, then re-submit.
      for (let fwd = 0; fwd < 5; fwd++) {
        const fwdNext = page.getByRole('button', { name: 'Next', exact: true }).first();
        if (!await fwdNext.isVisible().catch(() => false)) break;
        await fwdNext.click().catch(() => {});
        await page.waitForTimeout(1200);
      }
      await clickFinish();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }

    // Finish disappearing IS the signal that the claim was created, so waiting
    // on it returns as soon as that happens instead of always burning 5s. The
    // 5s cap keeps the old worst case for the "click didn't register" branch
    // handled immediately below.
    const finishGone = page.getByRole('button', { name: 'Finish', exact: true });
    await finishGone.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

    // If Finish is still visible after 5s: either dup panel appeared, or the click
    // didn't register (can happen if page was still settling). Handle both cases.
    const finishStillVisible = await page.getByRole('button', { name: 'Finish', exact: true })
      .waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (finishStillVisible) {
      const dupResult = await closeDupPanel();
      if (dupResult) {
        console.log('finishFNOL cloud: dup panel appeared after Finish, closed:', dupResult);
        await page.waitForTimeout(1000);
        await clickFinish();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await finishGone.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      } else {
        // No dup panel — Finish click may not have registered; retry once with extra wait.
        console.log('finishFNOL cloud: Finish still visible, no dup panel — retrying Finish click');
        await page.waitForTimeout(2000);
        await clickFinish();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await finishGone.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      }
    }

    // Wait for the wizard to navigate away to the claim workspace.
    // Allow up to 60s — the app can be slow to generate the claim number.
    await page.getByRole('button', { name: 'Finish', exact: true })
      .waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3000);
    console.log('finishFNOL cloud: wizard complete, claim workspace should be loading');
  }

  if (assertClaimNumber) {
    return await pollForClaimNumber(page);
  }

  return null;
}

// Generic combobox sweep scoped to any id prefix (e.g. a popup or tab panel)
// - same approach as the New Exposure sweep loop further down, extracted so
// it can be reused for OTHER screens with their own arbitrary required-field
// sets (the Vehicle Incident popup, a coverage's "Medicare" tab, etc.)
// confirmed via live screenshot to have MANY more required fields than any
// hand-enumerated list could keep up with.
async function sweepComboboxesOnPrem(page, idPrefix, maxPasses = 10) {
  for (let pass = 0; pass < maxPasses; pass++) {
    const targetId = await page.evaluate((prefix) => {
      // `[id^=""]` matches nothing (an empty prefix isn't a valid "starts
      // with" filter) - fall back to an unscoped combobox query when no
      // prefix is given (e.g. sweeping a plain inline panel with no known
      // id convention, like FNOL's Add Vehicle/Add Property Damage forms).
      const combos = prefix
        ? document.querySelectorAll(`[id^="${prefix}"] [role="combobox"]`)
        : document.querySelectorAll('[role="combobox"]');
      for (const el of combos) {
        // Address sub-fields (City/County/etc. inside GlobalAddressInputSet)
        // expose role="combobox" for typeahead but have no real fixed
        // pick-list - clicking them can land on an unrelated stale boundlist
        // left open from a previous field, "picking" something while this
        // field's own value never changes, causing an endless retry loop.
        // Skip these here and let fillEmptyTextboxesByLabel type into them
        // as plain text instead.
        if (/GlobalAddressInputSet/.test(el.id)) continue;
        // Confirmed via live failure: the top navbar's "Go to (Alt+/)"
        // QuickJump search box also exposes role="combobox" (it's a
        // typeahead, not a real fixed pick-list) and is ALWAYS empty by
        // design - an unscoped sweep (idPrefix=null) picked it up as a
        // "required field" and burned through every retry pass trying to
        // fill it, on a completely unrelated screen (Close Claim).
        if (/QuickJump/.test(el.id)) continue;
        // Catastrophe field opens a picker modal, not a standard boundlist
        // dropdown — the sweep loop can't select from it and just retries up to
        // maxPasses times, burning the full test timeout. Skip it; the field is
        // optional in normal FNOL flows (no declared catastrophe in test env).
        if (/Catastrophe_CatastropheNumber/.test(el.id)) continue;
        // Cat Code (catastrophe category code) is an optional classification field
        // in the Loss Details Categorization section — per user direction, leave it
        // as <none> and do not select a value during automated FNOL creation.
        if (/CatCode|Cat_Code/.test(el.id)) continue;
        // WC InjuryStartTime is a time-spinner combobox where ExtJS stores the
        // value internally in a way that el.value and rawValue both return empty
        // after a boundlist pick — the sweep retries indefinitely. Fill it as a
        // plain text input instead (handled in finishFNOL after the sweep).
        if (/InjuryStartTime|LossTime/.test(el.id)) continue;
        // Activity note section fields (Topic, RelatedTo, etc.) are optional — user
        // confirmed no notes should be entered on activities. Sweeping Topic with no
        // Subject filled causes a CC notes-validation warning that doesn't appear
        // when activities are completed manually.
        if (/ActivityNoteInputSet/.test(el.id)) continue;
        const val = (el.value ?? el.textContent ?? '').trim();
        if (!val || val === '<none>') return el.id;
      }
      return null;
    }, idPrefix).catch(() => null);
    if (!targetId) break;
    const target = page.locator(`[id="${targetId}"]`);
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    // Confirmed via live failure: this click had NEITHER a bounded timeout
    // NOR a .catch() at all - a stale/covered target (e.g. re-rendered out
    // from under us by an earlier field's own selection in this same pass)
    // didn't just silently hang for 30s, it threw UNCAUGHT and crashed the
    // whole FNOL flow. Bound it and treat a failed click as "nothing useful
    // to do this pass" instead of a fatal error.
    const clicked = await target.click({ timeout: 2000 }).then(() => true).catch(() => false);
    if (!clicked) break;
    await page.waitForTimeout(100);

    // Confirmed via live screenshot: a synthetic el.click() (dispatched from
    // inside page.evaluate) on a boundlist item can update its VISIBLE
    // display text without actually firing ExtJS's real "select" handler -
    // the field then LOOKS filled ("Loss Party: Third-party loss") but
    // ClaimCenter's own validation still reports it missing. Use a real
    // Playwright click (genuine trusted mouse event) on the actual boundlist
    // item locator instead, and verify the target's value actually changed
    // before considering this field done.
    async function pickFromLastVisibleBoundlist() {
      const container = page.locator('.x-boundlist').filter({ has: page.locator('.x-boundlist-item') }).last();
      const items = container.locator('.x-boundlist-item');
      const count = await items.count().catch(() => 0);
      const candidates = [];
      for (let i = 0; i < count; i++) {
        const t = (await items.nth(i).textContent().catch(() => '') || '').trim();
        if (!t || t === '<none>' || t.toLowerCase() === 'none') continue;
        // Confirmed via live failure: picking "In Suit (P)" for Litigation Status
        // during FNOL generates a "Create a Matter for Exposure In Suit" workplan
        // activity that blocks every other activity from completing — skip globally.
        if (/in suit/i.test(t)) continue;
        // US non-state territories trigger slow CC AJAX (county lookup) and can
        // cause the mask to stay up long enough that the next click times out.
        // Confirmed via live failure: "Guam" and "Federated States of Micronesia"
        // both left the vehicle-incident-popup mask up for 30+ seconds.
        if (/^(guam|puerto rico|american samoa|u\.?s\.? virgin islands|virgin islands|northern mariana|federated states of micronesia|marshall islands|palau|u\.?s\.? minor)$/i.test(t)) continue;
        // Confirmed via live failure: "Employee claim" and "Relative of Employee"
        // (and any employee-related variant) trigger the CC rule "Employee claims
        // require approval for payment" — this routes ALL payments on the claim to
        // Kevin Burke's queue and disables the Void button in Pending Approval state.
        if (/employee/i.test(t)) continue;
        candidates.push(i);
      }
      if (candidates.length === 0) return null;
      const idx = candidates[Math.floor(Math.random() * candidates.length)];
      const text = (await items.nth(idx).textContent().catch(() => '') || '').trim();
      await items.nth(idx).click().catch(() => {});
      // Confirmed via user report: clicking a boundlist item and immediately
      // moving on to the next field can outrun ExtJS's own commit of the
      // selection - it visually looks picked but the app hasn't registered
      // it yet. Tab out to force focus-out/blur commit before continuing.
      await page.keyboard.press('Tab').catch(() => {});
      await page.waitForTimeout(80);
      return text;
    }

    let picked = await pickFromLastVisibleBoundlist();
    if (!picked) {
      const triggerId = await page.evaluate((id) => {
        const input = document.getElementById(id);
        if (!input) return null;
        const item = input.closest('.x-form-item') || input.closest('.x-field') || input.parentElement;
        if (!item) return null;
        const icon = item.querySelector('[id*="MenuIcon"]') || item.querySelector('.x-form-trigger')
          || item.querySelector('img') || item.querySelector('[id*="trigger"]:not([id*="Wrap"])');
        return icon ? icon.id : null;
      }, targetId).catch(() => null);
      if (triggerId) {
        await page.locator(`[id="${triggerId}"]`).click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(100);
        picked = await pickFromLastVisibleBoundlist();
      }
    }
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(100);
    if (!picked) break;

    // Verify the real click actually registered - re-check this exact field's value.
    // Some ExtJS pickers (time, date) set the component's rawValue but leave
    // el.value empty — check both to avoid an infinite retry loop.
    const actualValue = await target.evaluate(el => {
      const raw = (el.value ?? '').trim();
      if (raw && raw !== '<none>') return raw;
      const cid = el.getAttribute('componentid');
      const comp = cid && window.Ext && Ext.ComponentManager && Ext.ComponentManager.get(cid);
      if (comp) {
        const extVal = comp.rawValue || (comp.getValue ? String(comp.getValue() ?? '') : '');
        if (extVal && extVal !== '<none>' && extVal !== 'null') return extVal;
      }
      return (el.textContent ?? '').trim();
    }).catch(() => '');
    if (!actualValue || actualValue === '<none>') {
      console.log('Swept field (' + idPrefix + ') click did not register, will retry next pass ->', targetId);
      continue;
    }
    console.log('Swept remaining required field (' + idPrefix + ') ->', picked);
  }
}

// Confirmed via live screenshot (Vehicle Incident popup): checkbox-styled
// boolean fields (Collision/Deer Hit/Fire/Flood/Vandalism/Early Tow
// Candidate/"Is there a loan on the Vehicle?", etc. - id pairs ending
// "_true-inputEl"/"_false-inputEl") are NOT comboboxes, so the sweep above
// never touches them, and they were all being left unanswered. Default any
// unanswered pair to "No"/false, same convention used elsewhere in this file.
async function clickUnansweredBooleanFieldsOnPrem(page, idPrefix) {
  const targetIds = await page.evaluate((prefix) => {
    // CC activities use two boolean radio conventions:
    //   _true-inputEl / _false-inputEl  (standard CC fields)
    //   Yes-inputEl   / No-inputEl      (some activity question types)
    const all = prefix
      ? Array.from(document.querySelectorAll(`[id^="${prefix}"]`))
      : Array.from(document.querySelectorAll('[id$="_true-inputEl"], [id$="_false-inputEl"], [id$="Yes-inputEl"], [id$="No-inputEl"]'));
    const bases = new Set();
    all.forEach(el => {
      if (/_true-inputEl$/.test(el.id)) bases.add(el.id.replace(/_true-inputEl$/, '') + '|std');
      if (/_false-inputEl$/.test(el.id)) bases.add(el.id.replace(/_false-inputEl$/, '') + '|std');
      if (/Yes-inputEl$/.test(el.id)) bases.add(el.id.replace(/Yes-inputEl$/, '') + '|yn');
      if (/No-inputEl$/.test(el.id)) bases.add(el.id.replace(/No-inputEl$/, '') + '|yn');
    });
    const toClick = [];
    for (const baseKey of bases) {
      const [base, type] = baseKey.split('|');
      // Never answer Activity_ExtDup ("Create a copy?") — clicking it fires an AJAX
      // request that causes GW to send a replaceItems response, which destroys and
      // recreates the entire activity form section. All ExtJS fieldUpdate AJAX
      // listeners on the new components are NOT re-registered, so subsequent
      // setFieldYes / answerNoForQuestion calls for WasCM, ExtClaimClosing, and
      // ExtDEFR1 fire zero AJAX — the server never sees those values and Complete
      // fails "Missing required field". Activity_ExtDup is not itself required;
      // the server treats null as No. Safe to skip across all call sites.
      if (base.includes('Activity_ExtDup')) continue;
      // Never answer ExtClaimClosing ("Are you closing this claim?") here — for the
      // same reason as Activity_ExtDup. Clicking the No radio first changes the
      // server-side value which can trigger a replaceItems, and the recreated
      // component loses its GW AJAX listener so the subsequent setFieldYes(Yes)
      // sets the visual state but never reaches the server. setFieldYes handles
      // this field directly on the original (AJAX-listener-intact) component.
      if (base.includes('ExtClaimClosing')) continue;
      const t = type === 'yn' ? document.getElementById(base + 'Yes-inputEl') : document.getElementById(base + '_true-inputEl');
      const f = type === 'yn' ? document.getElementById(base + 'No-inputEl') : document.getElementById(base + '_false-inputEl');
      const tChecked = t && t.className.includes('-checked');
      const fChecked = f && f.className.includes('-checked');
      if (!tChecked && !fChecked && f) toClick.push(f.id);
    }
    return toClick;
  }, idPrefix).catch(() => []);
  // Confirmed via live failure: this click had NO timeout override, so
  // Playwright's default 30s actionability wait applied to EACH one - a
  // single stale/covered checkbox (e.g. hidden behind a still-settling
  // panel re-render from the sweep calls just before this) silently ate a
  // full 30s with zero console output, and with ~15-22 pairs typical here,
  // even a couple of bad ones compounded into the multi-minute silent hang
  // reported by the user. A short bounded timeout fails fast instead.
  for (const id of targetIds) {
    await page.locator(`[id="${id}"]`).check({ force: true, timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(100);
  }
  if (targetIds.length) console.log('Answered ' + targetIds.length + ' unanswered boolean field(s) (' + idPrefix + ')');
  return targetIds.length;
}

// ── Vehicle Incident popup (on-prem) ───────────────────────────────────────────
// CONFIRMED via a real user-recorded codegen script against "PD Liability -
// Vehicle Damage" (and likely any other vehicle-damage-type coverage): the
// "Vehicle" field on New Exposure is NOT a simple dropdown - its companion
// icon ("...Vehicle_IncidentMenuIcon") opens a MENU (role=menuitem "New
// Incident..."), which opens a SEPARATE modal ("NewVehicleIncidentPopup")
// with its own vehicle/loss-party/parked/relation/damage-description fields
// plus a few checkbox-style boolean fields, submitted via a first "Update"
// that then reveals one more field ("Vehicle Type") needing a SECOND
// "Update" to actually close the popup. Only after this popup closes does
// "Vehicle" back on New Exposure actually get a value.
async function handleVehicleIncidentIfPresent(page) {
  const vehicleCombo = page.getByRole('combobox', { name: 'Vehicle', exact: true });
  const hasVehicle = await vehicleCombo.waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true).catch(() => false);
  if (!hasVehicle) return;
  const currentValue = await vehicleCombo.inputValue().catch(() => '');
  if (currentValue && currentValue !== '<none>') return;

  await vehicleCombo.click();
  const comboId = await vehicleCombo.getAttribute('id').catch(() => null);
  if (!comboId) return;
  const triggerId = await page.evaluate((id) => {
    const input = document.getElementById(id);
    if (!input) return null;
    const item = input.closest('.x-form-item') || input.closest('.x-field') || input.parentElement;
    if (!item) return null;
    // Priority order matters here (confirmed via live failure): a plain
    // comma-separated CSS selector returns the first DOCUMENT-order match
    // across ALL alternatives, not first-selector-priority - this picked a
    // "...-triggerWrap" CONTAINER div (matches [id*="trigger"] as a
    // substring) instead of the real clickable "...MenuIcon" icon nested
    // inside it, and clicking the wrapper didn't open anything. Check
    // MenuIcon explicitly first, and exclude "Wrap" containers from the
    // generic trigger fallback.
    const icon = item.querySelector('[id*="MenuIcon"]')
      || item.querySelector('.x-form-trigger')
      || item.querySelector('img')
      || item.querySelector('[id*="trigger"]:not([id*="Wrap"])');
    return icon ? icon.id : null;
  }, comboId).catch(() => null);
  if (!triggerId) return;
  await page.locator(`[id="${triggerId}"]`).click().catch(() => {});
  await page.waitForTimeout(400);

  const newIncidentItem = page.getByRole('menuitem', { name: 'New Incident...' });
  const hasNewIncident = await newIncidentItem.waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true).catch(() => false);
  if (!hasNewIncident) return;
  await newIncidentItem.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(500);

  const SPEC = { existTimeout: 2000 };
  await selectComboboxOnPrem(page, 'Select vehicle', undefined, { exact: true, ...SPEC });
  await selectComboboxOnPrem(page, 'Loss Party', "Insured's loss", { exact: true, ...SPEC });
  await selectComboboxOnPrem(page, 'Was the vehicle parked?', undefined, { exact: true, ...SPEC });
  await selectComboboxOnPrem(page, 'Relation to Insured', undefined, { exact: true, ...SPEC });
  await selectComboboxOnPrem(page, 'Is this loss:', undefined, { exact: true, ...SPEC });

  // Confirmed via live screenshot: this popup has MANY more required fields
  // than the codegen's own recorded path covered - a full "Early Tow
  // Questions" section (Collision/Deer Hit/Fire/Flood/Vandalism/Recovered
  // Theft/Early Tow Candidate, all checkbox-styled Yes/No pairs) plus
  // "Is there a loan on the Vehicle?" were all left unanswered, and neither
  // is a combobox the sweep below alone would catch. Answer every
  // unanswered boolean pair first, then sweep any remaining comboboxes.
  await clickUnansweredBooleanFieldsOnPrem(page, 'NewVehicleIncidentPopup');
  await sweepComboboxesOnPrem(page, 'NewVehicleIncidentPopup');

  // Confirmed via live screenshot: Damage Description can still show empty/
  // invalid even after a .fill() - possibly a timing issue with the field
  // not existing yet when first attempted. Verify and retry right before
  // Update.
  const damageDesc = page.getByRole('textbox', { name: 'Damage Description' });
  const hasDamageDesc = await damageDesc.waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true).catch(() => false);
  if (hasDamageDesc) {
    let damageDescValue = await damageDesc.inputValue().catch(() => '');
    for (let attempt = 0; attempt < 3 && !damageDescValue; attempt++) {
      await damageDesc.fill('Automated test - vehicle damage').catch(() => {});
      damageDescValue = await damageDesc.inputValue().catch(() => '');
    }
  }

  const popupUpdate = page.locator('[id="NewVehicleIncidentPopup:NewVehicleIncidentScreen:Update"]');
  const hasPopupUpdate = await popupUpdate.waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true).catch(() => false);
  if (!hasPopupUpdate) return;
  // Wait for any AJAX triggered by field sweeps (e.g. state-change loading counties)
  // before clicking Update, otherwise the click hits a masked element and times out.
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 30000 }).catch(() => {});
  await popupUpdate.click().catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

  // First Update can reveal one more required field ("Vehicle Type") that
  // needs a SECOND Update to actually close the popup - confirmed via live
  // codegen recording. Sweep again first in case anything else got revealed
  // too.
  await selectComboboxOnPrem(page, 'Vehicle Type', undefined, { exact: true, existTimeout: 3000 });
  await clickUnansweredBooleanFieldsOnPrem(page, 'NewVehicleIncidentPopup');
  await sweepComboboxesOnPrem(page, 'NewVehicleIncidentPopup');
  const stillOpen = await popupUpdate.waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true).catch(() => false);
  if (stillOpen) {
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 15000 }).catch(() => {});
    await popupUpdate.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  console.log('Vehicle Incident popup completed');
}

// ── addExposureByCoverage (on-prem) ───────────────────────────────────────────
// Exposures are NOT added inside the FNOL wizard - confirmed via live codegen
// recording, exposures get added AFTERWARD on the already-created claim via
// Claim Actions -> "Choose by Coverage" -> pick a specific coverage from the
// menu -> fill the New Exposure screen -> Update. lossParty/coverageDenied/
// claimantType have sensible recorded defaults; causeOfLoss/causeOfLossDescription/
// coverageLocation/claimant are claim-specific and auto-select the first
// available option when not given (see selectComboboxOnPrem).
async function addExposureByCoverage(page, {
  coverageLabel,
  vehicleLabel, // optional - Auto LOBs nest coverages under a per-vehicle submenu
  lossParty = "Insured's loss",
  causeOfLoss,
  causeOfLossDescription,
  coverageDenied = 'No',
  coverageLocation,
  claimant,
  claimantType = 'Insured',
  propertyDescription = 'Automated test - property description',
  damageDescription = 'Automated test - damage description',
  // Coverage labels to actively avoid falling back to when the requested
  // coverageLabel isn't available on this policy (e.g. already used by an
  // earlier exposure on this same claim today) - confirmed via live failure
  // that the old "just take index 0" fallback silently landed on a coverage
  // that ALREADY had its own reserve set today, so the new "reserve-free"
  // exposure this call was supposed to create wasn't actually reserve-free,
  // and the caller's later reserve action hit VTDMPL61 unexpectedly.
  avoidLabels = [],
  // Which depth-0 GROUPER to drill into when the menu shows groupers rather
  // than coverage names (property LOBs: "Policy Level Coverage" + one entry per
  // insured location). 0 = policy-level, 1+ = the address entries. completeFNOL
  // walks these until the requested coverage is found.
  groupSkip = 0,
}) {
  // Timing instrumentation per user request - pinpoint which phase of adding
  // an exposure is actually slow instead of guessing again.
  const __t0 = Date.now();
  let __tLast = __t0;
  const __lap = (label) => {
    const now = Date.now();
    console.log('  [timing] ' + label + ': ' + (now - __tLast) + 'ms (total ' + (now - __t0) + 'ms)');
    __tLast = now;
  };

  // Confirmed via live run: reopening "Choose by Coverage" for a SECOND
  // exposure on the same claim can silently fail to actually open the
  // coverage submenu (landed back on the top-level Actions menu instead -
  // its first item, "New Activity", got wrongly treated as the fallback
  // pick). Verify the submenu really opened (a new ".x-menu" panel appeared)
  // and retry the whole click sequence if not, instead of trusting it blindly.
  let menuOpened = false;
  for (let attempt = 0; attempt < 3 && !menuOpened; attempt++) {
    const beforeCount = await page.locator('.x-menu:visible').count().catch(() => 0);
    await page.locator('[id="Claim:ClaimMenuActions"]').click();
    await page.waitForTimeout(300);
    const chooseByCoverage = page.getByRole('menuitem', { name: 'Choose by Coverage' });
    const hasChoose = await chooseByCoverage.waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true).catch(() => false);
    if (!hasChoose) {
      // Diagnostic: log all visible menu items so we know what IS available
      const menuItems = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[role="menuitem"]'))
          .filter(el => el.offsetParent)
          .map(el => el.textContent.trim().substring(0, 60))
      ).catch(() => []);
      console.log('addExposureByCoverage: Actions menu items (attempt ' + attempt + '):', menuItems.join(' | '));
      await page.keyboard.press('Escape').catch(() => {}); continue;
    }
    await chooseByCoverage.click();
    await page.waitForTimeout(400);
    const afterCount = await page.locator('.x-menu:visible').count().catch(() => 0);
    if (afterCount > beforeCount) {
      menuOpened = true;
    } else {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    }
  }
  if (!menuOpened) {
    // "Choose by Coverage" is absent from the Actions menu for some LOBs (e.g.
    // HO/property claims) where the FNOL wizard auto-creates exposures — confirmed
    // via live menu dump: HO claim Actions has no "Choose by Coverage" at all.
    // Check if the Exposures tab already lists the requested coverage; if so,
    // the FNOL wizard handled it and we can skip without failing.
    const hasExistingExposure = await (async () => {
      try {
        await page.locator('[id*="ExposuresTab"], [id*=":Exposures"]').click({ timeout: 3000 });
        await page.waitForTimeout(500);
        const bodyText = await page.locator('body').innerText({ timeout: 5000 });
        return bodyText.includes(coverageLabel);
      } catch { return false; }
    })();
    if (hasExistingExposure) {
      console.log('addExposureByCoverage: coverage "' + coverageLabel + '" already on claim (FNOL auto-created) — skipping');
      return;
    }
    console.log('addExposureByCoverage: "Choose by Coverage" not in Actions menu and coverage not found — skipping "' + coverageLabel + '"');
    return;
  }

  // Confirmed via live screenshot: this menu can nest THREE levels deep even
  // when coverageLabel matches directly at the top - e.g. "Collision" (top)
  // -> "Collision" again / "Transportation Expense..." (a second, more
  // specific coverage level) -> a per-vehicle leaf ("2007 CHEVROLET
  // SILVERADO (VIN#: ...)"). The previous version assumed one click was
  // enough for a direct match and one hover+click for the Auto vehicle-first
  // case, so it silently stopped one level too early and the New Exposure
  // screen never actually opened. Now: hover into whatever matches first,
  // then keep drilling via a single unified loop until a real leaf (no
  // further popup) is reached, at every level preferring (in order) an exact
  // vehicleLabel match, then a VIN# item, then a repeated coverageLabel
  // match, and only falling back to "any leaf" if none of those are present
  // (i.e. the requested coverage truly isn't bound on this policy).
  // Real Playwright .hover() (confirmed working - a prior diagnostic run
  // showed 49 genuinely-expanded menu items after hovering, so ExtJS's
  // hover-intent/delayed-show logic DOES need a real, trusted mouse event;
  // a synthetic dispatchEvent('mouseover') was tried and confirmed NOT to
  // trigger it at all, landing back in the top-level Actions menu instead).
  // The actual bug wasn't the hover mechanism - it was searching for the
  // next item across the ENTIRE page instead of just the newly-opened
  // submenu panel (see currentMenuItems() below).
  async function dispatchHover(locator) {
    await locator.hover().catch(() => {});
  }

  // Scoped to the freshly-opened top panel (not the whole page) and
  // exact:true - confirmed this is the same "substring match ambiguity
  // silently swallowed by .catch(() => false)" bug hit repeatedly elsewhere
  // in this file: on the 2nd exposure, "Comprehensive" genuinely IS a
  // top-level item (confirmed via the very first screenshot of this menu),
  // but an unscoped/non-exact getByRole('menuitem', {name: 'Comprehensive'})
  // can match more than one element at once (this menu tree pre-renders many
  // branches simultaneously - confirmed earlier via the 49-item diagnostic),
  // causing a strict-mode violation that was silently treated as "not
  // found," wrongly falling back to Collision every time instead.
  // Confirmed via live failure: requesting the SAME coverage twice on one
  // claim (a single-entry rotation list literally re-requesting "Bodily
  // Injury Liability") matched directly here every time, bypassing
  // avoidLabels entirely - it only steers the FALLBACK path below, never a
  // successful direct match. That left a claim with two duplicate-type
  // exposures, which got it auto-flagged "High-Risk" (confirmed via live
  // screenshot) and blocked the Reserve Line list in New Payment. Treat an
  // avoided coverageLabel as "not directly available" so it's forced
  // through the same avoid-aware fallback as a genuinely-unavailable one.
  const isAvoided = avoidLabels.includes(coverageLabel);
  const coveragePanel = page.locator('.x-menu:visible').last();
  const directCoverage = coveragePanel.getByRole('menuitem', { name: coverageLabel, exact: true });
  const hasDirect = !isAvoided && await directCoverage.waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true).catch(() => false);
  if (hasDirect) {
    await dispatchHover(directCoverage);
  } else {
    const vehicleItem = vehicleLabel
      ? page.getByRole('menuitem', { name: vehicleLabel })
      : page.locator('[role="menuitem"]').filter({ hasText: 'VIN#' }).first();
    await dispatchHover(vehicleItem);
  }
  await page.waitForTimeout(400);

  // Each submenu level renders as its own separate floating ".x-menu" panel
  // (confirmed: this build uses ".x-menu-item" elsewhere in onPremLocators.js,
  // standard ExtJS menu markup) - a plain page-wide "[role=menuitem]:visible"
  // search matches items from EVERY currently-open branch at once (confirmed
  // via live diagnostic: 49 visible items after a single hover, and it picked
  // a vehicle leaf from an unrelated sibling coverage instead of the one
  // actually under "Collision"). Scope the search to only the LAST (i.e.
  // deepest/newest) visible ".x-menu" panel each pass so only the current
  // branch's own items are considered.
  async function currentMenuItems() {
    const menus = page.locator('.x-menu:visible');
    const menuCount = await menus.count().catch(() => 0);
    const scope = menuCount > 0 ? menus.last() : page;
    return scope.locator('[role="menuitem"]:visible');
  }

  let picked = false;
  let pickedCoverageText = null;
  let menuPanelCount = await page.locator('.x-menu:visible').count().catch(() => 0);
  // Sticky across the whole descent: once we have taken a speculative grouper
  // guess, every level below it is speculative too, so a leaf may only be
  // clicked if it genuinely matches the requested coverage.
  let usedGrouperFallback = false;
  // The mirror image of the above. The requested coverage is often a GROUPER,
  // not a clickable leaf: "Coverage E - Personal Liability" opens a submenu of
  // Bodily Injury / Personal Injury / Property Damage Liability, and only those
  // deepest entries actually create an exposure (confirmed via screenshot of
  // the live menu). Once we have drilled into an item that genuinely matched
  // the requested coverage, everything below it IS that coverage, so its first
  // child is a correct pick rather than a speculative one - without this the
  // drill reaches the last level and refuses every leaf, creating no exposure.
  let insideRequestedCoverage = false;
  for (let depth = 0; depth < 6 && !picked; depth++) {
    let items = await currentMenuItems();
    let count = await items.count().catch(() => 0);
    // Confirmed via live failure: right after the "Choose by Coverage"
    // submenu panel first opens, its own menu items can still be mid-render
    // (the panel itself already counts as "visible" but role=menuitem
    // children haven't attached yet) - a single immediate scan can see 0
    // items and wrongly conclude no coverage is selectable at all. Give it a
    // few short retries before giving up, same defensive pattern as the
    // top-level menuOpened retry above.
    for (let settleAttempt = 0; count === 0 && settleAttempt < 5; settleAttempt++) {
      await page.waitForTimeout(200);
      items = await currentMenuItems();
      count = await items.count().catch(() => 0);
    }
    if (count === 0) break;

    // aria-haspopup was confirmed via live diagnostic to NOT reliably reflect
    // whether an item actually opens a further submenu (a "Collision" item
    // with a real visible "▸" arrow still reported hasPopup=null and got
    // clicked as if it were a leaf, ending the drill one level too early).
    // Instead: pick the best-matching item, hover it, and check whether the
    // number of visible ".x-menu" panels actually increased - that's the
    // real signal for "this had a submenu", independent of any ARIA attribute.
    // Read every item's text ONCE, up front. The loops below used to call
    // items.nth(i).textContent() per index, which re-resolves the locator each
    // time and carries the full 15s action timeout. `count` is sampled before
    // the loops, so any menu re-render that shrinks the list leaves the tail
    // indexes pointing at items that no longer exist - and each one then hangs
    // for 15s before failing the whole FNOL. Confirmed live: CA died on
    // `.x-menu:visible').last().locator('[role="menuitem"]:visible').nth(5)`
    // after four consecutive clean runs, i.e. an intermittent re-render, not a
    // missing coverage. allTextContents() takes a single consistent snapshot.
    const itemTextsSnapshot = (await items.allTextContents().catch(() => []))
      .map(t => (t || '').trim());
    // Trust the snapshot's own length over the earlier `count` sample.
    if (itemTextsSnapshot.length && itemTextsSnapshot.length !== count) {
      console.log('addExposureByCoverage: menu re-rendered while reading it (count=' + count +
                  ' -> ' + itemTextsSnapshot.length + ') — using the fresh snapshot');
      count = itemTextsSnapshot.length;
    }
    const itemTextAt = (i) => itemTextsSnapshot[i] || '';

    let matchIndex = -1;
    if (vehicleLabel) {
      for (let i = 0; i < count && matchIndex < 0; i++) {
        if (itemTextAt(i) === vehicleLabel) matchIndex = i;
      }
    }
    if (matchIndex < 0 && !vehicleLabel) {
      for (let i = 0; i < count && matchIndex < 0; i++) {
        if (/VIN#/.test(itemTextAt(i))) matchIndex = i;
      }
    }
    // IMPORTANT: this must NOT be gated on hasDirect. Confirmed via live
    // screenshot: once a claim already has one exposure, "Choose by
    // Coverage" switches from a coverage-first top level (hasDirect=true,
    // 0 exposures yet) to a vehicle-first one (hasDirect=false) - but EITHER
    // way, the coverage list (and its own repeated sub-level, e.g.
    // "Comprehensive" -> "Comprehensive"/"Transportation Expense...") still
    // needs to be matched by coverageLabel text. Gating this on hasDirect
    // meant the vehicle-first path never matched coverageLabel at all and
    // always fell through to "first item in the list" (Collision), adding
    // the same coverage twice instead of the one actually requested.
    if (matchIndex < 0 && !isAvoided) {
      const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normTarget = norm(coverageLabel);
      const itemTexts = [];
      for (let i = 0; i < count; i++) {
        const text = itemTextAt(i);
        itemTexts.push(text);
        if (matchIndex >= 0) continue;
        if (text === coverageLabel) { matchIndex = i; continue; }
        // Normalized match: strips hyphens/spaces so "Coverage A - Dwelling"
        // matches search label "Coverage A Dwelling" (and vice versa).
        const normText = norm(text);
        if (normText === normTarget || normText.includes(normTarget) || normTarget.includes(normText)) matchIndex = i;
      }
      if (depth > 0) {
        console.log('addExposureByCoverage depth ' + depth + ' items:', itemTexts.join(' | '), '— searching for "' + coverageLabel + '" → matchIndex=' + matchIndex);
        // Remember the real coverage leaves this policy offers. Once we have
        // seen them, retrying other groupSkip branches for a coverage that is
        // simply not on the policy is guaranteed to fail - and each retry costs
        // a full menu open + drill + escape. See coverageMaybeAvailable().
        if (!page._coverageLeafCache) page._coverageLeafCache = new Set();
        for (const t of itemTexts) if (t) page._coverageLeafCache.add(t);
      }
    }
    // Fallback: requested coverage/vehicle isn't actually present in this
    // branch (confirmed via live screenshot - some test policies have no
    // Collision/Comprehensive at all, only liability/medical/UM coverages).
    // Prefer the first item NOT in avoidLabels (so it doesn't silently
    // re-land on a coverage already used earlier today) before falling back
    // to plain index 0.
    let fallbackIndex = -1;
    if (matchIndex < 0 && avoidLabels.length) {
      for (let i = 0; i < count && fallbackIndex < 0; i++) {
        const text = itemTextAt(i);
        // Substring match: avoidLabel 'Property Damage Liability' should block
        // 'Property Damage Liability - Other than Vehicle Damage' too.
        if (text && !avoidLabels.some(avoid => text.includes(avoid))) fallbackIndex = i;
      }
      // All items at this depth are in avoidLabels — throw so the caller's
      // retry loop can try a different policy instead of silently picking
      // an avoided coverage (e.g. PD Liability when all 8 items are
      // non-auto-reserve and Collision is unavailable on this policy).
      if (fallbackIndex < 0 && matchIndex < 0) {
        throw new Error('ALL_COVERAGES_AVOIDED: all ' + count + ' menu items at depth ' + depth + ' are in avoidLabels (target="' + coverageLabel + '")');
      }
    }
    // When count===1, always pick it (need to drill in to reach coverage level).
    // When count>1 and no label match, check for a "Policy Level Coverage"
    // navigation item (HO PA claims use this as a top-level grouper; actual
    // coverages A/B/C/D live one level deeper inside it).  Fall back to skip
    // rather than picking the wrong coverage — confirmed via live failure:
    // falling back to index 0 on MH policies picks "Bodily Injury Liability"
    // when "Coverage A Dwelling" was requested.
    let target = matchIndex >= 0 ? matchIndex : (fallbackIndex >= 0 ? fallbackIndex : (count === 1 ? 0 : -1));
    // True when `target` is a speculative grouper guess rather than a real
    // match - such a pick must never be clicked as a leaf (see below).
    let chosenViaGrouperFallback = false;
    // Inside the coverage we asked for, the label will not appear again (the
    // children are its sub-coverages), so "no match" here is expected, not a
    // miss. Take the first child: any of them creates an exposure under the
    // requested coverage.
    if (target < 0 && count > 0 && insideRequestedCoverage) {
      target = 0;
      // The chosen item's own text is logged a few lines below as `text`;
      // allItemTexts is not declared until then, so don't reference it here.
      console.log('addExposureByCoverage: inside "' + coverageLabel + '" — selecting the first ' +
                  'of its ' + count + ' sub-coverages');
    }
    // Applies at ANY depth, not just depth 0. Groupers nest: BOP's menu runs
    // Choose by Coverage -> "Policy Level Coverage" -> "BOP Coverage Level" ->
    // the real coverages (Building, Contents, ...), so a depth-0-only walk
    // stopped one level short and never reached them (confirmed via screenshot).
    if (target < 0 && count > 1) {
      // Depth 0 on property LOBs lists GROUPERS, not coverage names: "Policy
      // Level Coverage" plus one entry per insured location. Only POLICY-level
      // coverages (E - Personal Liability, F - Medical Payments) live under the
      // first; LOCATION-level ones (Coverage A Dwelling, Coverage C Personal
      // Property, Structure Building, ...) live under the address entries.
      //
      // This used to always drill into "Policy Level Coverage" and give up when
      // the coverage wasn't there, so Coverage A/C were never reachable at all -
      // confirmed on two different HO policies, each yielding a claim with ZERO
      // exposures. groupSkip lets the caller walk the groupers: 0 = policy-level
      // first (cheapest, and correct for E/F), then each address entry.
      const groupers = [];
      let policyLevelIdx = -1;
      for (let i = 0; i < count; i++) {
        const t = (await items.nth(i).textContent().catch(() => '') || '').trim();
        if (/policy level coverage/i.test(t)) policyLevelIdx = i;
        groupers.push({ i, t });
      }

      // The scoped panel sometimes still holds the ROOT ACTIONS MENU rather than
      // the coverage submenu (confirmed live: depth 0 listed "New Activity |
      // Approval | Check Handling | ... | Choose by Coverage | Close Claim").
      // Those are fixed Actions commands, never coverage groupers, so drilling
      // them is guaranteed-wasted work: the caller retries groupSkip 0..3 for
      // every coverage label, each one opening a menu and escaping back out.
      // Detect the root menu by its own signature entry and stop.
      const looksLikeActionsMenu = groupers.some(g => /^choose by coverage$/i.test(g.t));
      if (looksLikeActionsMenu) {
        console.log('addExposureByCoverage: depth ' + depth + ' is still the root Actions menu, ' +
                    'not the coverage list — the "Choose by Coverage" submenu did not open. ' +
                    'Not drilling its ' + count + ' command entries.');
        target = -1;
      }

      const ordered = policyLevelIdx >= 0
        ? [groupers[policyLevelIdx], ...groupers.filter(g => g.i !== policyLevelIdx)]
        : groupers;
      // Tell the caller how many DISTINCT branches exist at the top level so it
      // can stop once they have all been tried. groupSkip indexes this list and
      // is CLAMPED below, so out-of-range values silently re-run the last
      // branch: on a 2-grouper policy the caller's 4 iterations drilled
      // branch 1, then branch 2 three times over, identically.
      if (depth === 0 && !looksLikeActionsMenu) page._coverageGrouperCount = ordered.length;
      const pick = looksLikeActionsMenu ? null : ordered[Math.min(groupSkip, ordered.length - 1)];
      if (pick) {
        target = pick.i;
        chosenViaGrouperFallback = true;
        usedGrouperFallback = true;
        console.log('addExposureByCoverage: no direct match at depth 0 — drilling grouper ' +
                    '[' + groupSkip + '/' + (ordered.length - 1) + '] "' + pick.t + '"');
      }
    }
    if (target < 0) {
      console.log('addExposureByCoverage: "' + coverageLabel + '" not available at depth ' + depth + ' (' + count + ' items) — closing menus and skipping');
      // Press Escape multiple times to close all nested menu layers then the root
      for (let esc = 0; esc < depth + 2; esc++) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(200);
      }
      await page.waitForSelector('.x-menu:visible', { state: 'hidden', timeout: 3000 }).catch(() => {});
      return;
    }
    const text = (await items.nth(target).textContent() || '').trim();

    // Capture the item names BEFORE hovering. dispatchHover opens a submenu and
    // `items` then re-resolves to the NEW panel's contents, so reading them
    // afterwards logged the child menu while labelling it as this level - which
    // is exactly how an earlier read mistook depth-1 "Coverage E/F" for the
    // depth-0 item list.
    const allItemTexts = [];
    for (let li = 0; li < count; li++) {
      allItemTexts.push(((await items.nth(li).textContent().catch(() => '')) || '').trim());
    }

    await dispatchHover(items.nth(target));
    await page.waitForTimeout(400);
    const newPanelCount = await page.locator('.x-menu:visible').count().catch(() => 0);
    console.log('Coverage menu depth ' + depth + ' (scoped panel, ' + count + ' items): target="' + text +
                '" panels ' + menuPanelCount + ' -> ' + newPanelCount +
                ' | items: ' + allItemTexts.filter(Boolean).join(' | '));

    if (newPanelCount > menuPanelCount) {
      // Drilling into a GENUINE match means everything below is a refinement of
      // the requested coverage - remember that so the levels below are allowed
      // to pick a leaf even though the label itself won't appear again.
      if (matchIndex >= 0 && target === matchIndex) {
        insideRequestedCoverage = true;
        console.log('addExposureByCoverage: "' + text + '" matched but is a grouper — ' +
                    'descending into its sub-coverages');
      }
      menuPanelCount = newPanelCount;
      continue; // a new submenu opened - drill into it next pass
    }
    // No new panel appeared - this is a leaf.
    // Refuse to click a leaf that is not the coverage we were asked for, once
    // we are anywhere inside a speculative branch.
    //
    // Two ways to get here wrongly:
    //  a) this level's pick was itself a grouper guess that turned out to be a
    //     leaf (chosenViaGrouperFallback);
    //  b) we drilled into a grouper guess on an EARLIER pass and this level has
    //     exactly one item, which the `count === 1` rule takes unconditionally.
    // (b) is what produced 'clicked leaf "Accounts Receivable Coverage Form"
    // (matched: false)' on CP when "Structure Building" was requested - a wrong
    // exposure created silently. usedGrouperFallback persists across passes, so
    // the whole speculative descent now requires a real match to click.
    // insideRequestedCoverage exempts the descent: we are under an item that DID
    // match, so this leaf is a sub-coverage of it, not a wrong branch.
    if ((chosenViaGrouperFallback || usedGrouperFallback) && matchIndex < 0 && !insideRequestedCoverage) {
      console.log('addExposureByCoverage: refusing to click non-matching leaf "' + text +
                  '" inside a speculative branch (wanted "' + coverageLabel + '") — backing out');
      for (let esc = 0; esc < depth + 2; esc++) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(200);
      }
      await page.waitForSelector('.x-menu:visible', { state: 'hidden', timeout: 3000 }).catch(() => {});
      return;
    }
    await items.nth(target).click();
    picked = true;
    pickedCoverageText = text;
    console.log('Coverage menu: clicked leaf "' + text + '" (matched: ' + (matchIndex >= 0) + ')');
  }
  if (!picked) {
    console.log('addExposureByCoverage: "' + coverageLabel + '" — no leaf found after full menu drill; skipping');
    return;
  }
  __lap('coverage menu drill');

  // The New Exposure field set varies per coverage type (confirmed via live
  // screenshot: "Underinsured Motorist" has no "Coverage Denied?" at all, but
  // DOES have "Injury Incident" - a field the original Commercial Property
  // recording never showed). selectComboboxOnPrem now no-ops (returns false)
  // for any field that isn't present instead of hanging, so it's safe to
  // attempt all of them regardless of coverage type.
  // existTimeout: 1500 - these fields are frequently ABSENT depending on
  // coverage type (per the comment below), and an absent field will never
  // appear no matter how long we wait, so there's no reason to pay the full
  // 8s default existence-check timeout per field here.
  const SPECULATIVE = { existTimeout: 1500 };
  // Confirmed via repeated live failure: right after the coverage-menu leaf
  // click, the New Exposure screen's mask can still be up for a bit, and a
  // combobox click landing mid-transition can leave the dropdown open with
  // no options rendered yet - causing the very next option-click to hang
  // for the full 30s default action timeout instead of failing fast. Wait
  // for the mask to clear first.
  await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
  await selectComboboxOnPrem(page, 'Loss Party', lossParty, SPECULATIVE);
  // exact:true - "Cause of Loss" would otherwise substring-match "Cause of
  // Loss Description" too (Playwright's default name matching is substring).
  await selectComboboxOnPrem(page, 'Cause of Loss', causeOfLoss, { exact: true, ...SPECULATIVE });
  await selectComboboxOnPrem(page, 'Cause of Loss Description', causeOfLossDescription, SPECULATIVE);
  await selectComboboxOnPrem(page, 'Coverage Denied?', coverageDenied, { exact: true, ...SPECULATIVE });
  await selectComboboxOnPrem(page, 'Coverage Location', coverageLocation, SPECULATIVE);

  // Vehicle-damage-type coverages (e.g. "PD Liability - Vehicle Damage")
  // need this dedicated nested-popup flow - confirmed via live codegen
  // recording, the "Vehicle" field never gets a value through any simple
  // dropdown interaction, and the recording filled Claimant Number/Cause of
  // Loss FIRST, Vehicle LAST - moved here (after the fields above, before
  // the generic sweep) to match that real order and give the screen time to
  // fully settle after the coverage-menu transition.
  await handleVehicleIncidentIfPresent(page);
  __lap('vehicle incident popup');

  // Injury Incident is now created earlier, during FNOL Step 3 (Loss Details,
  // via the "Add Injury" button - see fillLossDetailsOnPrem), per user
  // clarification. Here on the exposure screen there's no "create new" flow
  // at all - just select the already-created incident from a plain dropdown
  // wherever the field is present. selectComboboxOnPrem no-ops (returns
  // false) if the field isn't on this coverage's screen, so it's safe to
  // always attempt it.
  // avoidNew: true - confirmed via live screenshot that landing on "New..."
  // here opens a full "Injury Incident" edit popup (Body Parts grid needing
  // its own "Add" click, Treatment Type, etc.) instead of just selecting the
  // incident already created during FNOL Step 3.
  await selectComboboxOnPrem(page, 'Injury Incident', undefined, { exact: true, random: true, avoidNew: true, ...SPECULATIVE });
  await selectComboboxOnPrem(page, 'Is Claimant Employed?', 'Yes', { exact: true, ...SPECULATIVE });
  __lap('optional coverage-type fields');

  // Claimant is required and was observed staying "<none>" (invalid) after a
  // single selection attempt in a live screenshot, which then silently
  // blocked Update (stayed on the same New Exposure screen with no thrown
  // error) - verify the value actually stuck and retry if not, same pattern
  // used for the Basic Info Mobile fields.
  // getByRole('combobox', {name:'Claimant'}) without exact:true was confirmed
  // via live error to ambiguously match 3 different fields on some coverage
  // types ("Claimant Number", "Claimant", "Is Claimant Employed?") - a strict-
  // mode violation. Must use exact:true here.
  let resolvedClaimant = '';
  const claimantCombo = page.getByRole('combobox', { name: 'Claimant', exact: true });
  // 8s, not 3s - confirmed via isolated live test that this field can take
  // longer than 3s to stabilize after the coverage-selection round-trip.
  const hasClaimant = await claimantCombo.waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true).catch(() => false);
  if (hasClaimant) {
    let claimantValue = '';
    for (let attempt = 0; attempt < 3 && !claimantValue; attempt++) {
      // Wait for any mask BEFORE clicking too, not just after - a mask still
      // up from the preceding field (Injury Incident) can silently swallow
      // the click that's supposed to open this dropdown, leaving
      // selectFirstRealOption() with zero options to pick from (count=0 ->
      // no-op, field stays "<none>" with no error at all).
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      // random:true (same reasoning as Injured Person above) - avoids always
      // reselecting the same over-used party/claimant-number combo.
      await selectComboboxOnPrem(page, 'Claimant', claimant, { exact: true, random: true });
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(250);
      claimantValue = await claimantCombo.inputValue().catch(() => '');
      if (claimantValue === '<none>') claimantValue = '';
    }
    console.log('Claimant set:', claimantValue || '(still empty)');
    resolvedClaimant = claimantValue;

    // "Claimant Number" is a distinct required field (confirmed via live
    // screenshot) that likely auto-derives from Claimant once it resolves -
    // give it a moment to auto-populate before forcing a value into it,
    // rather than fighting an auto-calculation that keeps resetting a forced
    // value back to "<none>" (the behavior observed in the generic sweep
    // below before this wait was added).
    if (claimantValue) {
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(600);
      const claimantNumberCombo = page.getByRole('combobox', { name: 'Claimant Number', exact: true });
      const hasClaimantNumber = await claimantNumberCombo.waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true).catch(() => false);
      if (hasClaimantNumber) {
        // Each exposure on the same POLICY must land on a DIFFERENT claimant
        // number - confirmed via live validation error ("already exists on
        // another claim"), and this applies across SEPARATE test runs too,
        // not just multiple exposures within one run. page._usedClaimantNumbers
        // is seeded from the persisted per-policy list (results/used-claimant-
        // numbers.json) so a number used in a prior, different test
        // invocation against the same policy is also avoided, not just ones
        // used earlier in this same run.
        const policyNumber = await getPolicyNumberFromPage(page);
        page._usedClaimantNumbers = page._usedClaimantNumbers ||
          (policyNumber ? getUsedClaimantNumbers(policyNumber) : new Set());
        let claimantNumberValue = await claimantNumberCombo.inputValue().catch(() => '');
        if (claimantNumberValue === '<none>') claimantNumberValue = '';
        // Deterministic exclusion pick instead of random+retry - the
        // Claimant Number dropdown is backed by a SMALL, FIXED pool of real
        // values per policy, and random selection kept re-landing on
        // already-used ones once that pool got partially exhausted across
        // runs (confirmed via repeated live "already exists on another
        // claim" failures even with 5 random retries).
        for (let attempt = 0; attempt < 3 && (!claimantNumberValue || page._usedClaimantNumbers.has(claimantNumberValue)); attempt++) {
          await selectComboboxOnPrem(page, 'Claimant Number', undefined, { exact: true, excludeValues: page._usedClaimantNumbers });
          await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(200);
          claimantNumberValue = await claimantNumberCombo.inputValue().catch(() => '');
          if (claimantNumberValue === '<none>') claimantNumberValue = '';
        }
        if (claimantNumberValue) {
          page._usedClaimantNumbers.add(claimantNumberValue);
          if (policyNumber) addUsedClaimantNumber(policyNumber, claimantNumberValue);
        }
        console.log('Claimant Number:', claimantNumberValue || '(unknown)');
      }
    }
  }
  __lap('claimant + claimant number');
  // "Type" was observed (live screenshot: "Type: Missing required field
  // 'Type'") getting set then silently reset back to "<none>" before Update -
  // same reset-after-later-action pattern hit repeatedly elsewhere in this
  // flow. Verify the value actually stuck and retry, same as Claimant above.
  const typeCombo = page.getByRole('combobox', { name: 'Type', exact: true });
  const hasType = await typeCombo.waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true).catch(() => false);
  if (hasType) {
    let typeValue = '';
    for (let attempt = 0; attempt < 3 && !typeValue; attempt++) {
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await selectComboboxOnPrem(page, 'Type', claimantType, { exact: true });
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(250);
      typeValue = await typeCombo.inputValue().catch(() => '');
      if (typeValue === '<none>') typeValue = '';
    }
    console.log('Type set:', typeValue || '(still empty)');
  }
  __lap('type');

  // The exact set of required fields varies per coverage type (confirmed via
  // live screenshot: "Underinsured Motorist" also requires "Claimant Number",
  // a field distinct from "Claimant" that none of the named calls above
  // handle) - rather than keep enumerating every coverage type's field list
  // by hand, sweep any dropdown still showing a red/invalid "<none>" and set
  // it to its first real option, mirroring fillLossDetailsOnPrem's sweep.
  // IMPORTANT: re-query comboboxes FRESH each pass, one at a time - a frozen
  // .all() snapshot went stale after the form re-rendered mid-sweep (confirmed
  // via live run: it kept re-selecting the same already-set field 9 times
  // instead of moving to the next one).
  for (let pass = 0; pass < 10; pass++) {
    // Scoped to "NewExposure*" ids only - confirmed via live failure that the
    // unscoped page.getByRole('combobox') was matching the header's global
    // "QuickJump" search box too (always empty, since nobody typed into it),
    // which then hung for 30s on its trigger-picker (never actually visible,
    // since QuickJump isn't a real dropdown field at all).
    // Performance: this used to fetch every combobox via .all() and call
    // .inputValue() on each ONE AT A TIME (a separate round-trip per field,
    // up to ~10 fields x up to 10 passes = 100+ round-trips just to find
    // which one was still empty). Do that same scan in a single
    // page.evaluate() instead - one round-trip per pass regardless of field
    // count.
    const targetId = await page.evaluate(() => {

      const combos = document.querySelectorAll('[id^="NewExposure"] [role="combobox"]');
      for (const el of combos) {
        const val = (el.value ?? el.textContent ?? '').trim();
        if (!val || val === '<none>') return el.id;
      }
      return null;
    }).catch(() => null);
    if (!targetId) break;
    const target = page.locator(`[id="${targetId}"]`);

    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await target.click();
    await page.waitForTimeout(200);
    // Random, not always-first - same "already exists on another claim"
    // collision risk as Claimant/Injured Person above applies to whatever
    // field ends up here too. EXCEPT for "Claimant Number" specifically:
    // confirmed via live failure that this generic sweep can be the one that
    // actually lands on it (e.g. when a named-handling block above set it
    // then a later interaction silently reset it back to "<none>"), and pure
    // random there re-introduces the exact same-policy collision risk the
    // named Claimant Number block above already guards against with
    // page._usedClaimantNumbers - deterministically exclude already-used
    // values here too instead.
    const targetLabel = await page.evaluate((id) => {
      const el = document.getElementById(id);
      if (!el) return '';
      const item = el.closest('.x-form-item') || el.closest('.x-field');
      const labelEl = item ? item.querySelector('.x-form-item-label') : null;
      return (labelEl ? labelEl.textContent : (el.getAttribute('aria-label') || '')).trim();
    }, targetId).catch(() => '');
    const excludeSet = targetLabel === 'Claimant Number' ? (page._usedClaimantNumbers || new Set()) : null;
    // Confirmed via live failure: "Litigation Status" landed on a
    // "... - Recovery Only" variant (Installment/Restitution/Litigation/
    // Judgment/Fraud/Auxiliary, etc. all follow this pattern) in every
    // single observed run - a recovery-only litigation status appears to
    // exclude the exposure's reserve from the New Payment wizard's Reserve
    // Line list entirely (it showed up completely empty afterward). Avoid
    // this whole family of options for this specific field, same as the
    // Claimant Number exclusion above.
    const avoidRecoveryOnly = targetLabel === 'Litigation Status';
    // Scoped to the LAST VISIBLE .x-boundlist container, not just any
    // .x-boundlist-item on the page - confirmed via live failure (Claimant
    // Number left on "<none>" while Update was clicked anyway) that a stale/
    // hidden boundlist from an EARLIER field in this same sweep loop can
    // still be present in the DOM and get picked from instead of the one
    // actually just opened for THIS field (same root cause as the Memo
    // Phrase bug fixed earlier in financialsHelper.js).
    let picked = await page.evaluate(({ exclude, avoidRecoveryOnly }) => {
      const containers = Array.from(document.querySelectorAll('.x-boundlist')).filter(c => c.offsetParent !== null);
      const container = containers[containers.length - 1];
      if (!container) return null;
      const list = Array.from(container.querySelectorAll('.x-boundlist-item'))
        .filter(li => { const t = li.textContent.trim(); return t && t !== '<none>' && t.toLowerCase() !== 'none'; });
      if (list.length === 0) return null;
      let pool = list;
      if (exclude && exclude.length) {
        const unused = list.filter(li => !exclude.includes(li.textContent.trim()));
        if (unused.length > 0) pool = unused;
      }
      if (avoidRecoveryOnly) {
        // avoidRecoveryOnly is set specifically for the "Litigation Status" field.
        // Confirmed via live failure: ANY litigation value ("In Suit", "Litigation
        // complete", "Judgment", ...) either auto-creates an uncompletable activity
        // OR creates a Litigation record that CC requires resolution before exposure
        // close. Only "Not In..." style options are safe. Prefer those first, then
        // fall back through progressively weaker filters before giving up.
        const nonRecovery = pool.filter(li => !/recovery only/i.test(li.textContent));
        if (nonRecovery.length > 0) pool = nonRecovery;
        // Strongly prefer "Not in ..." options (e.g. "Not In litigation", "Not In Suit")
        const notLitigated = pool.filter(li => /\bnot\b/i.test(li.textContent));
        if (notLitigated.length > 0) {
          pool = notLitigated;
        } else {
          // No "Not" options — avoid any value that implies active or completed litigation
          const noLitigationWord = pool.filter(li =>
            !/\bin suit\b|\blitigation\b|\bjudgment\b|\bjudgement\b|\bsuit\b/i.test(li.textContent)
          );
          if (noLitigationWord.length > 0) pool = noLitigationWord;
        }
      }
      // Globally avoid "In Suit" options regardless of field — same root cause.
      const nonInSuit = pool.filter(li => !/in suit/i.test(li.textContent));
      if (nonInSuit.length > 0) pool = nonInSuit;
      const el = exclude ? pool[0] : pool[Math.floor(Math.random() * pool.length)];
      const t = el.textContent.trim();
      el.click();
      return t;
    }, { exclude: excludeSet ? Array.from(excludeSet) : null, avoidRecoveryOnly });
    if (!picked) {
      // Same "picker" field pattern as Claimant (confirmed via live DOM
      // dump): a separate trigger icon element actually opens the list,
      // clicking the input alone just focuses it. Confirmed via a DIFFERENT
      // live failure that the icon's id doesn't always follow the
      // "-trigger-picker" convention - a Vehicle/Claimant lookup field on a
      // vehicle-damage coverage screen instead used a colon-joined
      // "<id>:<FieldName>MenuIcon" id. Find the real trigger by DOM
      // proximity instead of guessing a specific suffix.
      const triggerId = await page.evaluate((id) => {
        const input = document.getElementById(id);
        if (!input) return null;
        const item = input.closest('.x-form-item') || input.closest('.x-field') || input.parentElement;
        if (!item) return null;
        // Priority order matters here (confirmed via live failure): a plain
    // comma-separated CSS selector returns the first DOCUMENT-order match
    // across ALL alternatives, not first-selector-priority - this picked a
    // "...-triggerWrap" CONTAINER div (matches [id*="trigger"] as a
    // substring) instead of the real clickable "...MenuIcon" icon nested
    // inside it, and clicking the wrapper didn't open anything. Check
    // MenuIcon explicitly first, and exclude "Wrap" containers from the
    // generic trigger fallback.
    const icon = item.querySelector('[id*="MenuIcon"]')
      || item.querySelector('.x-form-trigger')
      || item.querySelector('img')
      || item.querySelector('[id*="trigger"]:not([id*="Wrap"])');
        return icon ? icon.id : null;
      }, targetId).catch(() => null);
      const trigger = triggerId ? page.locator(`[id="${triggerId}"]`) : null;
      // count() only proves the trigger EXISTS in the DOM. Confirmed live on
      // the New Exposure address input set: the City trigger is present but
      // NOT visible, and click() then retried "waiting for element to be
      // visible, enabled and stable" for the full 30s action timeout before
      // failing the entire FNOL. Require visibility, and bound the click so a
      // mid-render trigger can never stall the run for 30s either.
      const triggerVisible = trigger ? await trigger.isVisible().catch(() => false) : false;
      if (trigger && triggerVisible) {
        await trigger.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(200);
        picked = await page.evaluate(() => {

          const containers = Array.from(document.querySelectorAll('.x-boundlist')).filter(c => c.offsetParent !== null);
          const container = containers[containers.length - 1];
          if (!container) return null;
          const list = Array.from(container.querySelectorAll('.x-boundlist-item'));
          const safe = list.filter(li => {
            const t = li.textContent.trim();
            return t && t !== '<none>' && t.toLowerCase() !== 'none' && !/in suit/i.test(t);
          });
          const target = safe.length > 0 ? safe[0] : null;
          if (target) { target.click(); return target.textContent.trim(); }
          return null;
        });
      }
    }
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(200);
    if (picked) {
      console.log('Swept remaining required field ->', picked);
      if (targetLabel === 'Claimant Number') {
        const policyNumber = await getPolicyNumberFromPage(page).catch(() => null);
        if (!page._usedClaimantNumbers) {
          // Seed from the persisted JSON so prior-run numbers are excluded;
          // a bare new Set() would be truthy and short-circuit the || in the
          // collision-retry block, causing getUsedClaimantNumbers to never run.
          page._usedClaimantNumbers = policyNumber ? getUsedClaimantNumbers(policyNumber) : new Set();
        }
        page._usedClaimantNumbers.add(picked);
        if (policyNumber) addUsedClaimantNumber(policyNumber, picked);
      }
    } else {
      // No real option in this one either (or it's the same stuck field) -
      // stop rather than spin forever.
      break;
    }
  }
  __lap('sweep loop');

  // NOTE: .isVisible() does NOT poll/wait in Playwright (same gotcha hit
  // repeatedly elsewhere in this file) - use .waitFor() instead.
  // Shortened 3000ms -> 1200ms: these text fields are absent on most
  // coverage types (same "never appears no matter how long you wait"
  // reasoning as the speculative combobox calls above).
  const propDesc = page.getByRole('textbox', { name: 'Property Description' });
  const hasPropDesc = await propDesc.waitFor({ state: 'visible', timeout: 1200 })
    .then(() => true).catch(() => false);
  if (hasPropDesc) await propDesc.fill(propertyDescription);

  const damageDesc = page.getByRole('textbox', { name: 'Damage Description' });
  const hasDamageDesc = await damageDesc.waitFor({ state: 'visible', timeout: 1200 })
    .then(() => true).catch(() => false);
  if (hasDamageDesc) await damageDesc.fill(damageDescription);

  // "Damages Claimed" (confirmed via live screenshot - e.g. Medical Payments/
  // Advertising Injury Liability coverage screens) is a required plain
  // TEXTBOX, not a combobox - the generic sweep loop above only handles
  // comboboxes, so this was being silently left empty and failing Update's
  // validation with no error at all.
  const damagesClaimed = page.getByRole('textbox', { name: 'Damages Claimed' });
  const hasDamagesClaimed = await damagesClaimed.waitFor({ state: 'visible', timeout: 1200 })
    .then(() => true).catch(() => false);
  if (hasDamagesClaimed) await damagesClaimed.fill('1000');
  __lap('description/damages text fields');

  // Final re-check: the sweep loop above touches other fields after Type was
  // set, and this flow has repeatedly shown fields getting silently reset by
  // a later, unrelated interaction (Mobile, Claimant, now Type). Re-verify
  // Type still holds a real value right before Update and re-set if not.
  if (hasType) {
    const finalTypeValue = await typeCombo.inputValue().catch(() => '');
    if (!finalTypeValue || finalTypeValue === '<none>') {
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await selectComboboxOnPrem(page, 'Type', claimantType, { exact: true });
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      console.log('Type re-set after sweep reset it:', await typeCombo.inputValue().catch(() => '(unknown)'));
    }
  }

  // Confirmed via live screenshot: some coverage types (Bodily Injury
  // Liability) render a separate "Medicare" TAB on this same New Exposure
  // screen, with its own required fields the main sweep above never sees
  // (a different tab's contents aren't in the DOM's visible/id-scoped set
  // until the tab is actually clicked). Click it if present and sweep it
  // too, before the final Update.
  const medicareTab = page.locator('[id*="MedicareCardTab"]').first();
  const hasMedicareTab = await medicareTab.waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true).catch(() => false);
  if (hasMedicareTab) {
    await medicareTab.click();
    await page.waitForTimeout(300);
    await clickUnansweredBooleanFieldsOnPrem(page, 'ExposureDetail');
    await sweepComboboxesOnPrem(page, 'ExposureDetail');
    console.log('Medicare tab swept');
  }

  let stillOnExposureScreen = true;
  // Confirmed via live failure: this test policy's persisted used-claimant-
  // numbers history only had scattered/incomplete records (numbers 150-156
  // were already used on OTHER claims for this policy but were never
  // recorded via addUsedClaimantNumber before now), so the numeric max-jump
  // optimization could only skip ahead of what it had personally already
  // learned about - a well-worn policy can still need several sequential
  // collisions before reaching a genuinely free number. 20, not 6.
  // Confirmed via live failure: a heavily-reused test policy can genuinely
  // exhaust its entire claimant number pool - 20 attempts, each paying a
  // 15s "did the screen navigate away" verification wait, silently burned
  // ~6 minutes before finally reporting it, consuming nearly the whole
  // 480s test timeout. Cut to 8 attempts so a truly-exhausted pool fails
  // fast with a clear, distinctly-tagged error instead of hanging.
  for (let updateAttempt = 0; updateAttempt < 8 && stillOnExposureScreen; updateAttempt++) {
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    // Fill any required FREE-TEXT field still empty on this screen. Which ones
    // exist varies by coverage: "Coverage D Loss of Use" renders a required
    // Damage > Description that Collision/Comprehensive do not, and leaving it
    // blank made Update bounce with 'Description : Missing required field
    // "Description"' until the 8 attempts ran out (confirmed via screenshot).
    // Driven off the required marker in the DOM rather than a hardcoded id, so
    // a different coverage's required text field is handled the same way.
    // Driven off CC's OWN validation text rather than guessing which fields are
    // required. An earlier attempt keyed on a red asterisk inside the label and
    // matched nothing - ExtJS renders that marker outside the label's
    // textContent - so the Description field stayed empty through all 8
    // attempts. CC states the field by name ('Description : Missing required
    // field "Description"'), which is unambiguous and needs no DOM guesswork.
    // Read the fields CC itself says are missing, then fill them BY ACCESSIBLE
    // NAME. Earlier versions matched on a red asterisk, then on a ":_msgs"
    // element, then on <label>/.x-form-item-label text - all three found
    // nothing, because on this screen the labels are plain <div>/<span>
    // ("generic" in the a11y tree) while the inputs carry proper accessible
    // names (textbox "City", textbox "Description"). Role locators read exactly
    // what CC names in its message, so the two always line up.
    const missingNames = await page.evaluate(() => {

      const t = document.body.innerText || document.body.textContent || '';
      return [...new Set([...t.matchAll(/Missing required field\s*"([^"]+)"/gi)].map(m => m[1]))];
    }).catch(() => []);

    // Coverage D Loss of Use adds a required Temporary Location (City/State) on
    // top of the required Description. Reuse the address already shown on the
    // claim rather than inventing one, so the exposure stays consistent with
    // the policy's own location.
    let addrCity = null, addrState = null;
    if (missingNames.some(n => /^(city|state)$/i.test(n))) {
      const m = await page.evaluate(() => {

        const t = document.body.innerText || '';
        return t.match(/,\s*([A-Za-z .'-]+),\s*([A-Z]{2})\s+\d{5}/);
      }).catch(() => null);
      if (m) { addrCity = m[1].trim(); addrState = m[2].trim(); }
    }

    const filledText = [];
    for (const name of missingNames) {
      const value = /description/i.test(name) ? 'Automated E2E exposure description'
                  : /^city$/i.test(name)      ? addrCity
                  : /^state$/i.test(name)     ? addrState
                  : 'Automated E2E';
      if (!value) continue;   // nothing sensible to put here - leave it to CC

      const tb = page.getByRole('textbox', { name, exact: true }).first();
      if (await tb.isVisible().catch(() => false)) {
        await tb.fill(String(value)).catch(() => {});
        await tb.press('Tab').catch(() => {});
        filledText.push(name + '=' + value);
        continue;
      }
      const cb = page.getByRole('combobox', { name, exact: true }).first();
      if (await cb.isVisible().catch(() => false)) {
        const ok = await cb.selectOption({ label: String(value) }).then(() => true).catch(() => false);
        if (ok) { filledText.push(name + '=' + value); continue; }
        await cb.click().catch(() => {});
        const opt = page.getByRole('option', { name: String(value), exact: false }).first();
        if (await opt.isVisible().catch(() => false)) {
          await opt.click().catch(() => {});
          filledText.push(name + '=' + value);
        }
      }
    }
    if (filledText.length) {
      console.log('addExposureByCoverage: filled required text field(s) on New Exposure: ' + filledText.join(', '));
      await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});
    }
    // Tolerant click, not bare - confirmed live that a bare click here can hit
    // a transient mask/re-render and throw before the poll loop just below
    // ever runs, failing the whole FNOL ("waiting for locator
    // '[id=\"NewExposure:NewExposureScreen:Update\"]'" after 15s). The loop
    // below already re-verifies whether the screen actually advanced, so a
    // swallowed click failure surfaces there instead of as an opaque timeout.
    await waitForAllMasksGone(page, 15000).catch(() => {});
    await page.locator('[id="NewExposure:NewExposureScreen:Update"]').click({ timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});

    // Verify Update actually left the New Exposure screen instead of trusting
    // the click blindly - a validation failure (e.g. Claimant still empty)
    // leaves it sitting on the same screen with no thrown error, which
    // previously caused the NEXT addExposureByCoverage call to fail trying to
    // open Claim:ClaimMenuActions from a screen it doesn't exist on.
    // Confirmed via live screenshot: this was a FALSE POSITIVE at 8000ms -
    // the exposure had genuinely saved and the page had already moved on to
    // the Exposures grid, but the transition just took a bit longer than 8s
    // this time. Bumped to 15000ms, then to 30000ms: run-31 showed the
    // Collision exposure Update took 80s (claimant-number saturation on the
    // policy), leaving CC in a slow state so the subsequent Comprehensive
    // Update also took > 15s — increased to 30s to tolerate this.
    // Fast-poll every 2s for either outcome instead of blocking a single 30s
    // wait — a claimant-number collision error appears in 2-5s, so the old
    // approach wasted ~25s per collision waiting for an inevitable timeout.
    // Also detects success (button hidden) within 2s of CC responding.
    stillOnExposureScreen = true;
    for (let tick = 0; tick < 20 && stillOnExposureScreen; tick++) {
      // Check BEFORE sleeping: on a clean save the button is already gone by
      // the time the mask wait above returns, so the old sleep-first order paid
      // a flat 2s on every successful exposure.
      const btnGone = await page.locator('[id="NewExposure:NewExposureScreen:Update"]')
        .waitFor({ state: 'hidden', timeout: 300 }).then(() => true).catch(() => false);
      if (btnGone) { stillOnExposureScreen = false; break; }
      // ANY validation message means CC has already rejected the save - the
      // screen will never navigate away, so polling on is pure dead time.
      // This used to match only claimant-collision text, so a "Missing required
      // field" (e.g. the Description that Coverage D Loss of Use requires) ran
      // all 20 ticks = 40s, times 8 update attempts = ~320s, which was the bulk
      // of the whole FNOL. The retry at the top of the loop fills the named
      // field and tries again immediately instead.
      const hasError = await page.getByText(
        /already exists on another claim|Claimant number must be unique|Missing required field|must be a numeric value|must be between|is required/i)
        .first().isVisible().catch(() => false);
      if (hasError) break; // validation failure — exit poll loop, handle below
      await page.waitForTimeout(2000);
    }
    if (!stillOnExposureScreen) break;

    // Confirmed via live screenshot: a real business validation error, not an
    // automation bug - either "This claimant number already exists on
    // another claim" (cross-claim, same policy) or "Claimant number must be
    // unique" (within THIS claim - e.g. the coverage-menu fallback landing
    // on a coverage that already has its own exposure/claimant number on
    // this same claim). Per user instruction: on either message, go back to
    // the exposure screen and change the Claimant Number until it works,
    // rather than failing outright.
    const claimantNumberCollision = await page.getByText(/already exists on another claim|Claimant number must be unique/i)
      .first().isVisible().catch(() => false);
    if (claimantNumberCollision) {
      const claimantNumberCombo = page.getByRole('combobox', { name: 'Claimant Number', exact: true });
      const hasClaimantNumberField = await claimantNumberCombo.waitFor({ state: 'visible', timeout: 3000 })
        .then(() => true).catch(() => false);
      if (hasClaimantNumberField) {
        const policyNumber = await getPolicyNumberFromPage(page);
        page._usedClaimantNumbers = page._usedClaimantNumbers ||
          (policyNumber ? getUsedClaimantNumbers(policyNumber) : new Set());
        const priorValue = await claimantNumberCombo.inputValue().catch(() => '');
        if (priorValue) {
          page._usedClaimantNumbers.add(priorValue);
          if (policyNumber) addUsedClaimantNumber(policyNumber, priorValue);
        }
        console.log('[DEBUG] claimant collision: policyNumber=' + policyNumber + ' excludeSet.size=' + page._usedClaimantNumbers.size + ' excludeSample=' + Array.from(page._usedClaimantNumbers).slice(0, 5).join(','));
        await selectComboboxOnPrem(page, 'Claimant Number', undefined, { exact: true, excludeValues: page._usedClaimantNumbers });
        await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
        const newValue = await claimantNumberCombo.inputValue().catch(() => '');
        if (newValue && newValue !== '<none>') {
          page._usedClaimantNumbers.add(newValue);
          if (policyNumber) addUsedClaimantNumber(policyNumber, newValue);
        }
        console.log('Claimant number collision - retrying with:', newValue || '(unknown)');
      }
    } else {
      break; // some other validation issue - retrying Update won't help, stop and report it
    }
  }
  if (stillOnExposureScreen) {
    // Confirmed via live screenshot: a genuinely EXTERNAL concurrency
    // conflict can hit here too - a background "Integrations User" process
    // (e.g. the ImageRight document-linking integration seen elsewhere on
    // these claims) modified the claim while our own edit was in flight,
    // and ClaimCenter's optimistic-locking check rejects the Update with
    // "...was changed by Integrations User... Please cancel and retry your
    // change." This is transient and unrelated to field validity - Cancel
    // out and throw a distinctly-tagged error so the caller can retry the
    // whole operation fresh instead of treating it as a real validation bug.
    const conflictBanner = await page.getByText(/was changed by .* Please cancel and retry/i)
      .first().textContent().catch(() => null);
    if (conflictBanner) {
      await page.locator('[id="NewExposure:NewExposureScreen:Cancel"]').click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      throw new Error('EXPOSURE_CONCURRENCY_CONFLICT: ' + conflictBanner.trim());
    }
    // Confirmed via live failure: the poll loop (20×2s = 40s) can time out on a
    // slow server even though the Update DID succeed and the page has already
    // navigated to the Exposures grid. The error-context screenshot showed the
    // Exposures grid with the new exposure present. Final sanity check: if the
    // Update button is no longer visible right now, the save succeeded — treat
    // it as success rather than throwing a false-positive failure.
    const updateStillVisible = await page.locator('[id="NewExposure:NewExposureScreen:Update"]')
      .isVisible().catch(() => false);
    if (!updateStillVisible) {
      console.log('addExposureByCoverage: poll timed out but Update is gone — treating as success for "' + coverageLabel + '"');
      stillOnExposureScreen = false;
    }
  }
  if (stillOnExposureScreen) {
    // Per user instruction: don't just warn and silently continue - a failed
    // Update here previously let the NEXT addExposureByCoverage call run
    // against a broken/stale page state and fail with a confusing, unrelated
    // error instead. Fail loudly right where the actual problem is.
    const claimantPoolExhausted = await page.getByText(/already exists on another claim|Claimant number must be unique/i)
      .first().waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
    // "a required field is likely still invalid" tells nobody WHICH field, and
    // the Playwright artifacts for this failure are wiped by the next run - so
    // capture the screen's own account of the problem inline, in the thrown
    // message. Same tactic that turned the opaque Set Reserves failure into an
    // exact cause. Empty/absent fields are reported as such rather than
    // omitted, so "no validation text at all" is itself a usable finding.
    const state = await page.evaluate(() => {
      const t = (document.body.innerText || '') + ' ' + (document.body.textContent || '');
      const named = [...new Set([...t.matchAll(/Missing required field\s*"([^"]+)"/gi)].map(m => m[1]))];
      const messages = [...new Set([...t.matchAll(
        /([^\n]{0,90}(?:must not be|must be|Missing required field|is required|not allowed|cannot be|Rule:)[^\n]{0,60})/gi
      )].map(m => m[1].trim()))].slice(0, 6);
      // Every visible field with a value, so a field CC rejects silently (no
      // message) is still visible in the record.
      const fields = [];
      for (const el of document.querySelectorAll('input:not([type=hidden]), textarea')) {
        if (!el.offsetParent) continue;
        const name = el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '';
        if (!name) continue;
        fields.push({ name: name.slice(0, 40), value: (el.value || '').slice(0, 30) });
      }
      // ExtJS marks offending controls and stashes the reason in data-errorqtip.
      const invalid = [...document.querySelectorAll('.x-form-invalid-field')]
        .filter(e => e.offsetParent)
        .map(e => ({
          name: (e.getAttribute('aria-label') || e.getAttribute('name') || e.id || '').slice(0, 40),
          tip: (e.getAttribute('data-errorqtip') || '').slice(0, 80),
        })).slice(0, 6);
      return { named, messages, invalid, fields: fields.slice(0, 25) };
    }).catch(() => null);
    console.log('addExposureByCoverage: Update blocked for "' + coverageLabel +
                '" — screen state -> ' + JSON.stringify(state));
    await page.screenshot({ path: 'results/exposure-update-blocked.png' }).catch(() => {});
    throw new Error(
      claimantPoolExhausted
        ? 'CLAIMANT_POOL_EXHAUSTED: no unused claimant number found for coverage "' + coverageLabel + '" on this policy after repeated attempts'
        : 'New Exposure Update did not navigate away for coverage "' + coverageLabel + '". ' +
          (state && state.named.length ? 'CC says these fields are missing: ' + state.named.join(', ') + '. ' : '') +
          (state && !state.named.length && state.invalid.length
            ? 'Invalid controls: ' + state.invalid.map(i => i.name + (i.tip ? ' (' + i.tip + ')' : '')).join('; ') + '. '
            : '') +
          (state && !state.named.length && !state.invalid.length
            ? 'No validation text and no invalid-marked control on screen. ' : '') +
          'Screenshot: results/exposure-update-blocked.png'
    );
  }
  __lap('update click + verify');
  // Return the claimant this exposure ended up with, so callers (Financials
  // tests) can target the exact same claimant/reserve line for later
  // reserve/payment steps instead of matching by ambiguous text (multiple
  // exposures can share the same Type, e.g. "1st PartyAdvertising Injury
  // Liability", with DIFFERENT claimants - confirmed via live failure that
  // text-only matching picked an unrelated, unfunded reserve line).
  return { claimant: resolvedClaimant, coverageLabel: pickedCoverageText };
}

// Counts exposure rows on the claim. Deliberately self-contained rather than
// reusing financialsHelper.openExposuresTab: financialsHelper already imports
// THIS module, so importing it back would create a require cycle.
// Returns -1 when the grid could not be read at all, which callers must not
// treat as "zero exposures".
async function countExposuresOnClaim(page) {
  try {
    const nav = page.locator('.x-tree-node-text').filter({ hasText: /^Exposures$/ }).first();
    if (!await nav.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)) return -1;
    await nav.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('.x-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
    // Wait for the grid to paint - reading immediately after the nav click
    // returns zero rows on a claim that plainly has exposures.
    await page.locator('.x-column-header-text').filter({ hasText: /^Coverage$/ }).first()
      .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await page.locator('tr.x-grid-row').first()
      .waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    return await page.evaluate(() => Array.from(document.querySelectorAll('tr.x-grid-row'))
      .filter(r => r.offsetParent !== null && /\S/.test(r.innerText || '')).length);
  } catch (_) {
    return -1;
  }
}

async function completeFNOL(page, {
  policyNumber,
  policyEnvVar, // optional - e.g. 'POLICY_PA_AUTO'. Lets a POLICY_DATA_ERROR
                // (a genuinely broken policy record on the server, not an
                // automation bug - confirmed via live "IllegalStateException:
                // Bundle invariants violated" failure) be reported and
                // retried with the NEXT policy in that env var's rotation
                // instead of failing the whole test on bad test data.
  policyType,    // optional preferred PolicyType dropdown value, e.g.
                 // 'Personal Auto' / 'Commercial auto'. Without it the picker
                 // falls back to Personal Auto first, then any auto option.
  lossDetails = {},
  claimantInfo = {},
  exposures = [],
  assertClaimNumber = true
}) {

  // ── Claim reuse (development aid) ──────────────────────────────────────────
  // While the post-FNOL flow is being stabilised, running the whole wizard
  // again costs ~2 minutes per iteration and tells us nothing new once FNOL is
  // known good. Set CC_EXISTING_CLAIM (or CC_EXISTING_CLAIM_<POLICY_ENV_VAR>
  // when several LOBs run at once) to open that claim instead and go straight
  // to the step being worked on.
  //
  // Deliberately loud, and deliberately opt-in: a run that skipped FNOL has NOT
  // exercised FNOL, and a green result from it must never be read as a full
  // end-to-end pass. Leave the variable unset for any real run.
  // Keyed store for claimant numbers: CC refuses one already used on ANOTHER
  // claim for the same policy, so the pool has to be tracked per policy and
  // persisted between runs.
  page._policyNumber = policyNumber || page._policyNumber || null;

  const reuseKey = policyEnvVar ? 'CC_EXISTING_CLAIM_' + policyEnvVar.replace(/^POLICY_/, '') : null;
  const reuseClaim = (reuseKey && process.env[reuseKey]) || process.env.CC_EXISTING_CLAIM;
  if (reuseClaim) {
    console.log('==================================================================');
    console.log('completeFNOL: REUSING EXISTING CLAIM ' + reuseClaim + ' — FNOL SKIPPED');
    console.log('  (set via ' + (process.env[reuseKey] ? reuseKey : 'CC_EXISTING_CLAIM') + ')');
    console.log('  THIS RUN DOES NOT EXERCISE FNOL — not a valid end-to-end result.');
    console.log('==================================================================');
    await openExistingClaim(page, reuseClaim);
    page._currentClaimNumber = reuseClaim;
    // Still run the exposure step. Returning here made reuse useless for the
    // thing it was added for: exposures are what needs iterating, and skipping
    // them meant every candidate fix had to be proven through a full FNOL.
    if (!IS_ON_PREM && exposures && exposures.length) {
      await addCloudExposures(page, exposures);
    }
    return reuseClaim;
  }

  console.log('========== Starting FNOL ==========');

  // Per-claim, not per-page: ClaimLifecycle.test.js runs seven FNOLs on one
  // page, and a cache carried over from the previous policy would wrongly
  // suppress grouper retries for coverages this policy does have.
  page._coverageLeafCache = new Set();
  page._usedCoverageLabels = new Set();
  page._coverageMenuFullySwept = false;
  page._coverageGrouperCount = 0;

  // Step 1: Search Policy
  let activePolicyNumber = policyNumber;
  const maxPolicyAttempts = policyEnvVar ? 5 : 1;
  for (let attempt = 0; attempt < maxPolicyAttempts; attempt++) {
    try {
      await searchPolicy(page, activePolicyNumber, lossDetails.lossDate, policyType);
      page._currentPolicyNumber = activePolicyNumber;
      break;
    } catch (e) {
      if (!/^POLICY_DATA_ERROR/.test(e.message) || attempt === maxPolicyAttempts - 1) throw e;
      // Reported here (not swallowed) so it shows up in the test run's own
      // console/report output, then retry with the next rotated policy.
      console.error('REPORTED - bad policy data, skipping and retrying with next policy:', e.message);
      if (IS_ON_PREM) {
        await page.goto(BASE_URL).catch(() => {});
      } else {
        await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
      }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      activePolicyNumber = getNextPolicy(policyEnvVar);
    }
  }

  // Step 2: Basic Information
  if (IS_ON_PREM) {
    await fillBasicInfoOnPrem(page);
  } else {
    await fillBasicInfo(page);
  }

  // Step 3: Loss Details
  if (IS_ON_PREM) {
    const isWcLob = (exposures || []).some(e => /Workers.*Compensation|Employers.*Liability/i.test(e.coverageLabel || ''));
    await fillLossDetailsOnPrem(page, {
      whatHappened: lossDetails.lossDescription || 'Automation FNOL test',
      lossState: lossDetails.lossState || 'PA',
      lossCauseCode: lossDetails.lossCauseCode || '',
      skipInjuryIncident: !isWcLob,
    });
  } else {
    await fillLossDetailsCloud(page, {
      lossState: lossDetails.lossState || 'PA',
      lossCauseCode: lossDetails.lossCauseCode || '',
      whatHappened: lossDetails.lossDescription || 'Automation FNOL test'
    });
  }

  // Step 4: Parties Involved (on-prem only - cloud flow doesn't have this
  // as a separate step in the current wizard implementation)
  if (IS_ON_PREM) {
    await handlePartiesInvolvedOnPrem(page);
  }

  // Step 5: Finish
  const claimNumber = await finishFNOL(
    page,
    assertClaimNumber
  );

  // Exposures were previously silently dropped here (the param existed on
  // call sites like FNOL.test.js but wasn't wired up after the cloud rework).
  // On-prem: confirmed via codegen that exposures are added AFTER claim
  // creation via Actions > Choose by Coverage, so that only runs here.
  // Cloud: this flow has not been recorded/verified yet - skipped for now
  // rather than calling an on-prem-only locator pattern against cloud DOM.
  if (IS_ON_PREM) {
    // Track which requested coverages the policy actually offered.
    // addExposureByCoverage deliberately SKIPS a coverage it can't find rather
    // than picking a wrong one, which is right - but it left the caller unable
    // to tell the difference between "two exposures created" and "none".
    // Confirmed live on HO: policy 1002229301 offers only Coverage E/F, so both
    // requested coverages were skipped, FNOL still reported success, and the
    // run then failed 10 minutes later with a baffling
    // 'Activity "Inspect Damage" not found'. Fail here instead, naming the
    // cause, when the policy offered NONE of them.
    // addExposureByCoverage returns {claimant, coverageLabel} on success and
    // undefined when it skipped.
    const skipped = [];
    for (const exposure of exposures) {
      // coverageLabel may be a STRING or an ARRAY of acceptable alternatives,
      // tried in order. Per user direction: coverage availability varies from
      // policy to policy inside the same rotation (BOP's first policy offered
      // "Business Liability", the next did not), so pinning one exact name
      // makes a spec flaky through no fault of the automation.
      const labels = Array.isArray(exposure.coverageLabel)
        ? exposure.coverageLabel : [exposure.coverageLabel];
      let added = null;
      let usedLabel = null;
      for (const label of labels) {
        // Walk the depth-0 groupers: on property LOBs the coverage may sit
        // under an address entry rather than "Policy Level Coverage".
        let sweptAllBranches = false;
        for (let groupSkip = 0; groupSkip < 4 && !added; groupSkip++) {
          // Every distinct top-level branch has now been tried. Further
          // iterations would re-drill the last one (groupSkip is clamped to the
          // final index), producing the identical result at full cost.
          if (groupSkip > 0 && page._coverageGrouperCount && groupSkip >= page._coverageGrouperCount) {
            sweptAllBranches = true;
            break;
          }
          // Skip the remaining branches only once the menu has been swept end
          // to end at least once, so the cache is a COMPLETE picture of the
          // policy's coverages. Gating on _coverageMenuFullySwept is essential:
          // the cache fills branch by branch, and a partial cache says nothing
          // about the branches not yet visited. Without this gate the first
          // sweep bailed after the policy-level branch and declared "Coverage C
          // Personal Property" unavailable - it actually lives under the
          // ADDRESS grouper, one branch later (DEV policy 1001002540).
          if (groupSkip > 0 && page._coverageMenuFullySwept && !coverageMaybeAvailable(page, label)) {
            console.log('addExposureByCoverage: "' + label + '" is not among the coverages this ' +
                        'policy offers (' + [...page._coverageLeafCache].join(' | ') + ') — ' +
                        'skipping the remaining grouper branches');
            break;
          }
          added = await addExposureByCoverage(page, { ...exposure, coverageLabel: label, groupSkip });
          if (!added && groupSkip === 3) sweptAllBranches = true;
        }
        // One label paid for the full sweep; every later label reuses its result.
        if (sweptAllBranches) page._coverageMenuFullySwept = true;
        if (added) { usedLabel = label; break; }
        if (labels.length > 1) console.log('  (coverage "' + label + '" unavailable, trying next alternative)');
      }
      // Last resort: none of the requested names exist on this policy. Rather
      // than skip the exposure entirely, take a coverage the policy DOES offer
      // - the sweep above already enumerated them into _coverageLeafCache, so
      // this costs no extra searching.
      //
      // Deliberately a FALLBACK, not the default. Picking "whatever is first"
      // up front is what silently produced an "Accounts Receivable Coverage
      // Form" exposure on CP when "Structure Building" was asked for - a wrong
      // exposure inside a passing test. Reaching here means the requested names
      // genuinely are not on the policy, and the substitution is logged by name
      // so it is never silent.
      if (!added && page._coverageLeafCache && page._coverageLeafCache.size) {
        if (!page._usedCoverageLabels) page._usedCoverageLabels = new Set();
        for (const leaf of page._coverageLeafCache) {
          if (page._usedCoverageLabels.has(leaf)) continue;   // one exposure each
          console.log('addExposureByCoverage: none of [' + labels.join(', ') + '] exist on this ' +
                      'policy — falling back to an available coverage: "' + leaf + '"');
          for (let gs = 0; gs < 2 && !added; gs++) {
            added = await addExposureByCoverage(page, { ...exposure, coverageLabel: leaf, groupSkip: gs });
          }
          if (added) { usedLabel = leaf; page._usedCoverageLabels.add(leaf); break; }
        }
      }
      if (added && usedLabel) page._usedCoverageLabels?.add(usedLabel);
      if (added && usedLabel !== labels[0]) {
        console.log('Exposure created using ALTERNATIVE coverage "' + usedLabel +
                    '" (preferred "' + labels[0] + '" not offered by this policy)');
      }
      if (!added) skipped.push(labels.join(' / '));
    }
    if (exposures.length && skipped.length === exposures.length) {
      // Every add was skipped - but that does NOT prove the claim has no
      // exposures. Some LOBs create theirs during FNOL and expose no "Choose by
      // Coverage" action at all: confirmed on WC, whose claim already carried
      // "Medical / Workers' Compens... / $1,000.00" while every add attempt
      // reported the coverage missing. Inferring failure from the add attempt
      // alone wrongly failed a perfectly good claim, so check what is actually
      // on the claim before declaring a data problem.
      const actualExposures = await countExposuresOnClaim(page);
      if (actualExposures > 0) {
        console.log('Exposures were not addable via "Choose by Coverage", but the claim already has ' +
                    actualExposures + ' exposure(s) (created during FNOL) - continuing.');
      } else if (actualExposures < 0) {
        // Could not read the grid. Not evidence of absence - don't fail the run
        // on it; the downstream steps assert on exposures anyway.
        console.log('WARNING: could not verify exposures on the claim after all adds were skipped (' +
                    skipped.join(', ') + ') - continuing without failing.');
      } else {
        throw new Error(
          'POLICY_DATA_ERROR [' + (page._currentPolicyNumber || '?') + ']: none of the requested ' +
          'coverages could be added (' + skipped.join(', ') + ') and the claim has NO exposures, ' +
          'so reserves/payments/exposure-driven activities cannot run. Check the policy list for this LOB.'
        );
      }
    }
    if (skipped.length) {
      console.log('WARNING: coverage(s) not offered by this policy and skipped: ' + skipped.join(', '));
    }
  } else if (exposures.length) {
    // CLOUD add-exposure — transcribed from a Playwright codegen recording of
    // the real flow (docs/cloud-exposure-flow.recorded.md), NOT inferred.
    //
    //   Actions > Choose by Coverage > <grouper> > <coverage leaf>
    //   -> New Exposure screen (native <select>s) -> Update
    //
    // Earlier attempts here failed for one reason: the walk stopped on a
    // GROUPER (e.g. "Auto BI/PD Single Limit"), so the New Exposure screen
    // never opened and the missing Update button was a symptom, not the cause.
    // The recording also shows plain getByRole('menuitem'/'button', {name})
    // works - Playwright derives the accessible name from the child .gw-label -
    // so none of the aria-label/column-scoping machinery is needed.
    await addCloudExposures(page, exposures);

  } else if (false) {
    // Do NOT silently continue. The cloud add-exposure flow is unimplemented, so
    // the claim is created with ZERO exposures and every downstream step
    // (reserve, payment, approval, recovery) then fails with an unrelated-looking
    // error far from the real cause. That is the same "reports success while
    // doing nothing" pattern that hid eight separate defects on the on-prem
    // suites. Verify against the claim before deciding - some LOBs (WC) create
    // their exposure during FNOL and need no add step at all.
    const actual = await countExposuresOnClaim(page);
    if (actual > 0) {
      console.log('CLOUD: add-exposure flow is unimplemented, but the claim already has ' +
                  actual + ' exposure(s) created during FNOL - continuing.');
    } else if (actual < 0) {
      console.log('CLOUD: WARNING - add-exposure flow is unimplemented and the exposure grid ' +
                  'could not be read to verify. Downstream steps may fail.');
    } else {
      throw new Error(
        'CLOUD_NOT_IMPLEMENTED: the cloud add-exposure flow does not exist, and this claim has ' +
        'NO exposures (requested: ' + exposures.map(e => Array.isArray(e.coverageLabel)
          ? e.coverageLabel[0] : e.coverageLabel).join(', ') + '). Reserves, payments, approvals ' +
        'and recovery all operate on an exposure, so the rest of this suite cannot run on cloud ' +
        'until addExposureByCoverage has a cloud implementation.'
      );
    }
  }

  // Loss Details carries required fields the wizard never shows (WC's Injury
  // section). Complete them here, while we are still on the claim, so that
  // reserve/payment/close all start from a claim that passes validation.
  if (!IS_ON_PREM) {
    await completeCloudLossDetails(page).catch(() => {});
  }

  console.log('========== FNOL Completed ==========');
  console.log('Claim Number:', claimNumber);

  // Downstream helpers need to be able to get BACK to this claim: later steps
  // can leave the browser on the Desktop, where the Actions menu is a different
  // menu entirely and the claim-level items simply are not present.
  page._currentClaimNumber = claimNumber;

  return claimNumber;
}

module.exports = {
  LOB_CONFIG,
  selectFirstOption,
  randomText,
  clickNewClaimCloud,
  clickNewClaimOnPrem,
  searchPolicy,
  fillBasicInfo,
  fillBasicInfoOnPrem,
  fillLossDetailsCloud,
  fillLossDetailsOnPrem,
  handlePartiesInvolvedOnPrem,
  finishFNOL,
  addExposureByCoverage,
  completeFNOL,
  sweepComboboxesOnPrem,
  clickUnansweredBooleanFieldsOnPrem,
  answerCloudRadioGroups,
  answerUnansweredYesNoPairs,
  completeCloudLossDetails,
  fixCloudInvalidControls,
};