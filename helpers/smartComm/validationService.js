/**
 * helpers/smartComm/validationService.js
 * Orchestrates one SmartCOMM template validation run: loads the template
 * catalog, derives requirements from the template's own Word doc, filters
 * test data into scenarios by that template's State/LOB applicability,
 * executes each scenario against ClaimCenter, and aggregates the results.
 *
 * Generic — adding a template or a LOB/State scenario never touches this
 * file; it only ever reads catalogService/templateRequirementService/testDataService.
 */
'use strict';
const catalogService = require('./catalogService');
const testDataService = require('./testDataService');
const scenarioService = require('./scenarioService');
const scenarioVariants = require('./scenarioVariants');
const templateRequirementService = require('./templateRequirementService');
const documentService = require('./documentService');
const pdfValidationService = require('./pdfValidationService');
const claimSummaryService = require('./claimSummaryService');
const payloadService = require('./payloadService');
const fraudLanguageService = require('./fraudLanguageService');
const dataDictionaryService = require('./dataDictionaryService');
const payloadXpathService = require('./payloadXpathService');
const interactiveEditService = require('./interactiveEditService');
const livePreviewService = require('./livePreviewService');
const s3AdminService = require('../s3Download/s3AdminService');
const { createS3SessionManager } = require('../s3Download/s3SessionManager');
const { loginAsAdmin, loginAsUser, openExistingClaim } = require('../claimCenterBase');

async function validateTemplate(page, { digNumber, recipientEmail, claimNumberOverride, interactive, singleScenario, s3Session } = {}) {
  const dig = catalogService.normalizeDig(digNumber);
  const template = catalogService.getTemplate(dig);
  if (!template) {
    return blockedTemplateResult(dig, `Template "${dig}" was not found in the SmartCOMM catalog (Claims_Documents_Index.xlsx)`);
  }

  const { requirements, sourceFile, mode, mentionsFraudLanguage } = await templateRequirementService.getRequirements(template, catalogService.DATA_DIR);
  if (!requirements.length) {
    // CONFIRMED live 2026-10-07 (DIG150MIC): this previously always blamed "not found / not a .docx" even
    // when getRequirements had ALREADY found and parsed a real .docx (via resolveLocalTemplatePath's fuzzy
    // fallback — the catalog's OWN mapped path pointed at a ".pdf" that doesn't exist, but a same-stem .docx
    // sits right next to it and resolves fine) — the classifier just derived zero checkable requirements from
    // its actual content. Those are two genuinely different problems with two different fixes (fix the
    // catalog/file location vs. look at why this document's own content yielded nothing), so the reason text
    // now says which one actually happened instead of always guessing the file-location one.
    // CONFIRMED live 2026-10-07 (DIG150MIC): attempted letting an Interactive template with zero derived
    // requirements continue anyway, on the theory that the interactive field-editability check is independent
    // of static content requirements — it IS independent, but this specific document (catalog's own
    // `overlay: "Yes"` flag) turned out to be a genuinely different SmartCOMM rendering mode entirely: its
    // live editor content lives inside a SEPARATE nested preview iframe our field-scanner never looks inside
    // (confirmed via a live DOM dump — the scanned frame's own content area just showed Thunderhead's empty-
    // state "ENTER CONTENT HERE" watermark), and its generated PDF also fails `pdf-parse` ("Invalid PDF
    // structure"). Continuing just traded one clean BLOCKED result for a confusing crash further downstream,
    // with no actual validation gained — reverted per user direction 2026-10-07. An "overlay" template is
    // flagged clearly and immediately instead, rather than attempting a session this tool doesn't support yet.
    if (template.overlay === 'Yes') {
      return blockedTemplateResult(
        dig,
        `${dig} (${template.documentName}) is marked "overlay" in the SmartCOMM catalog — this automation does not ` +
        `support overlay-type templates yet. Confirmed live: its live editor content renders inside a separate ` +
        `nested preview iframe this tool's field-scanner doesn't look inside (0 merge fields found despite the ` +
        `Data Dictionary tracking real fields for it), and its generated PDF also fails text extraction ("Invalid ` +
        `PDF structure"). Not a missing-file or configuration problem — this document type needs its own, not-yet-` +
        `built support.`,
        template
      );
    }
    const reason = sourceFile
      ? `No requirements could be derived for ${dig} (${template.documentName}) — its template file WAS found and parsed ` +
        `(${sourceFile}, mode: ${mode || 'unknown'}), but ${mode === 'heuristic' || mode === 'heuristic-doc' ? 'the heuristic classifier' : 'parsing'} ` +
        `derived zero checkable requirements from its actual content — not a missing-file problem.`
      : `No requirements could be derived for ${dig} (${template.documentName}) — its Word template ` +
        `("${template.templateMappingDoc || 'not set'}") was not found under ${catalogService.DATA_DIR}\\Templates\\ClaimCenter, or is not a .docx.`;
    return blockedTemplateResult(dig, reason, template);
  }
  console.log(`[SmartComm] ${dig}: derived ${requirements.length} requirements from ${sourceFile}`);
  if (templateExpectsAdditionalRecipient(requirements)) {
    console.log(`[SmartComm] ${dig}: template's own requirements reference a "Copy ..."/cc: field — will add an additional recipient on the Recipients tab so those rows actually run instead of staying SKIPPED.`);
  }
  // NOT re-enabled here, unconditionally, for every scenario — see reEnableFieldsMatching's own comment:
  // whether the condition actually held is decided PER SCENARIO, inside runScenario, once this scenario's own
  // additionalRecipient/choicesApplied outcome is actually known.

  // Runner UI's optional manual "Claim #" override — use that one claim
  // directly as a single ad-hoc scenario instead of matching
  // testDataService's real claim inventory by the template's own State/LOB
  // applicability. lob/state are unknown here (no test-data record backs
  // this claim), so they're reported as "manual" rather than guessed — any
  // dynamicValueMatch requirement needing testData.* still correctly comes
  // back BLOCKED, same as a real record with those fields left unset.
  let scenarios = claimNumberOverride
    ? [{
        scenarioId: `${dig}-manual-${claimNumberOverride}`.replace(/\s+/g, ''),
        lob: 'manual', state: 'manual',
        testData: { claimNumber: claimNumberOverride },
      }]
    : scenarioService.getScenariosForTemplate(template, testDataService.getAllRecords());
  // Opt-in: keeps the template's own normal LOB/State-driven scenario matching (unlike claimNumberOverride,
  // which replaces it with one ad-hoc claim), just caps the RESULT to one representative scenario instead of
  // running the full matrix — for a broad sweep across many templates where one real, correctly-matched
  // scenario per template is enough signal and running all 3 would roughly triple total runtime.
  if (singleScenario && !claimNumberOverride) scenarios = scenarios.slice(0, 1);

  if (!scenarios.length) {
    return blockedTemplateResult(
      dig,
      `No SmartCOMM test claims match template ${dig}'s applicability (States: ${template.states.join(',')}, LOB: ${template.lob.join(',')}). ` +
      `Nothing in the Test Data claim inventory matched, and no Claim # override was given.`,
      template
    );
  }

  // Opt-in scenario concurrency (default 1 = today's exact sequential behavior, unchanged). Playwright's own
  // --workers flag parallelizes across separate TEST FILES — both callers of this function (the single-
  // template spec and the bulk script) are a single test/single Node process each, so --workers has nothing
  // to parallelize; this is the actual lever. Each extra worker gets its OWN browser context/page (a fresh
  // context has no cookies of its own, but runScenario already logs in fresh per scenario regardless — see
  // its own comment — so that's not a new constraint). Capped to scenarios.length so a template with fewer
  // scenarios than the requested concurrency never opens idle browser windows.
  const concurrency = Math.max(1, Math.min(scenarios.length, parseInt(process.env.SMARTCOMM_CONCURRENCY || '1', 10) || 1));
  if (concurrency > 1 && interactive) {
    console.log(`[SmartComm] ${dig}: SMARTCOMM_CONCURRENCY=${concurrency} with Interactive enabled — up to ${concurrency} Azure SSO/MFA prompts and native "Complete this draft?" dialogs may appear across separate browser windows AT THE SAME TIME. A warm saved session (azureSessionStore.js) usually clears these silently, but the first run of the day (or after the session expires) may need you to watch more than one window.`);
  }

  // One shared S3 admin session reused across every scenario below (and, when the caller passes its own
  // via options.s3Session — see scripts/bulkValidateSmartComm.js — across every OTHER template in the same
  // run too) instead of each scenario opening, logging into and closing its own S3 browser context. Only
  // owned (and closed) here when nobody handed one in — the single-template spec's own call never does, so
  // it still gets this reuse scoped to just its own scenarios, same as always.
  const ownsS3Session = !s3Session;
  if (ownsS3Session) s3Session = createS3SessionManager(page.context().browser(), { log: (m) => console.log(`[SmartComm] ${dig}: ${m}`) });

  const extraPages = [];
  try {
    const pages = [page];
    for (let i = 1; i < concurrency; i++) {
      const ctx = await page.context().browser().newContext();
      const p = await ctx.newPage();
      extraPages.push(p);
      pages.push(p);
    }

    const scenarioResults = new Array(scenarios.length);
    let next = 0;
    async function worker(workerPage) {
      while (true) {
        const i = next++;
        if (i >= scenarios.length) return;
        const variant = scenarioVariants.getVariantForIndex(i);
        scenarioResults[i] = await runScenario(workerPage, { template, scenario: scenarios[i], requirements, recipientEmail, variant, mentionsFraudLanguage, interactive, s3Session });
      }
    }
    await Promise.all(pages.map(worker));

    return aggregateTemplateResult(template, scenarioResults, sourceFile);
  } finally {
    // Only the EXTRA contexts created here — the original `page`/its context belongs to the caller
    // (the spec's afterAll, or the bulk script's own browser.close()) and must outlive this call.
    for (const p of extraPages) await p.context().close().catch(() => {});
    if (ownsS3Session) await s3Session.close();
  }
}

// ClaimCenter answers a claim the current user can't see with "Sorry, you do
// not have permission to view this claim. Use the tabs above to navigate to
// another claim." — there is then no Actions menu, which used to surface as
// the misleading "claim Actions menu not found". Polls until either that
// message or the claim's own "Claim: <number>" header shows.
async function claimAccessDenied(page, claimNumber) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await page.evaluate((n) => {
      const t = document.body.innerText || '';
      if (/do not have permission to view this claim/i.test(t)) return 'denied';
      if (t.includes('Claim: ' + n)) return 'ok';
      return 'pending';
    }, claimNumber).catch(() => 'pending');
    if (state !== 'pending') return state === 'denied';
    await page.waitForTimeout(250);
  }
  return false;
}

// "Copy Name"/"Copy Address"/"Copy City, State, ZIP"-style requirements are always built as conditional/
// disabled by templateRequirementService (CONDITIONAL_RE matches any field starting with "copy", since no
// scenario used to ever add a second recipient) — permanently SKIPPED, never really exercised. Detects
// whether THIS template's own requirements reference one of those fields at all, so setAdditionalRecipient()
// (documentService.js) only gets called for templates that actually need it.
//
// Interactive mode WAS gated off here entirely (2026-10-01 finding: adding a second recipient made clicking
// "Interactive" silently close the whole wizard). Two likely root causes identified 2026-10-02, NOT yet
// confirmed fixed: (1) setEmail's locator was page-wide (`.first()`), so with a second row present the
// additional recipient's own Email field was simply never filled, left blank; (2) the Return Envelope/
// Certified Mail radios (both REQUIRED fields) were read via a single immediate count() right after Delivery
// Channel was set to Print, before that column had actually rendered — "0 pairs set" for BOTH rows even
// though Delivery Channel was correctly Print on both. Both are fixed in documentService.js (setEmail now
// takes an optional recipientName to scope by row; setRowMailOptions polls briefly for the radios to attach).
// Gate removed here to let a real test exercise them — still needs an actual live re-test with
// setAdditionalRecipient genuinely in the loop before trusting this for real (a prior "confirmed" run turned
// out to have silently skipped setAdditionalRecipient entirely because this gate was still active at the
// time, so its pass proved nothing about the fix).
// Matches both the "Copy Name"/"Copy Address"/"Copy City, State, ZIP" fields themselves AND any OTHER field
// whose own condition is literally "if additional recipient is entered" (e.g. R29: "Only display 'CC:' Name
// and Number and Address if additional recipient is entered Else do not display") — CONFIRMED live 2026-10-02
// that this second kind exists and was being missed: it doesn't start with "Copy", so it stayed permanently
// SKIPPED even on a scenario where R30/R32/R33 (the literal Copy fields) all correctly PASSED, proving an
// additional recipient really was added. Any field gated on this same phrase is, by definition, gated on the
// exact condition this feature satisfies, so it's safe (not overly broad) to catch generically.
// Broadened 2026-10-02 after a full-catalog scan of every template's OWN conditional wording found the same
// underlying condition phrased several different ways across templates (DIG141/DIG179/DIG235): "CC is
// entered", "additional recipient is added in ClaimCenter", "Additional Recipient added" — not just "is
// entered". All mean the same thing this feature satisfies.
const ADDITIONAL_RECIPIENT_CONDITION_RE = /^copy\b|additional recipient (?:is|has been) (?:entered|added)|cc (?:is|has been) entered/i;

// Fields conditioned on a "Choices" panel question being answered Yes (e.g. R5: "Display only if Apply
// Medical Letterhead? is selected Yes in SmartCOMM. Otherwise will not be visible.") — CONFIRMED live
// 2026-10-02 this exists and was being missed the exact same way R29 was. interactiveEditService's
// selectAllYesNoChoices always answers every such Choices-panel question "Yes" during an Interactive
// template's editor session, so this condition is always satisfied there — but NEVER for an On-Demand
// template, which has no editor session/Choices panel at all (generateOnDemand never touches one), so this
// must stay scoped to Interactive templates specifically, unlike the additional-recipient case above.
// Broadened 2026-10-02 after a full-catalog scan found a SECOND phrasing of the same underlying condition on
// 10 templates (DIG11/35/36/55/78/95/96/97/156/158): "display claimant name if Claimant Name checkbox is
// selected in SmartCOMM" — a standalone checkbox, not a yes/no radio pair, and no literal word "yes" in the
// condition text at all. selectAllYesNoChoices now also checks any such standalone checkbox.
const CHOICE_SELECTED_YES_RE = /is selected yes\b|checkbox is selected\b/i;

// A selected choice's own captured label (from interactiveEditService's selectAllYesNoChoices) is often the
// generic "(unlabeled choice)"/"(unlabeled checkbox)" placeholder when no real on-page question text could be
// found near it — CONFIRMED live this is the common case, not an edge case. Re-enabling EVERY choice-gated
// requirement whenever ANY choice got selected Yes (the previous behavior) wrongly turns on a requirement
// whose OWN choice was never actually selected — or wasn't even present on this scenario's page — whenever a
// template has more than one independent Choices-panel condition (e.g. "Apply Medical Letterhead?" alongside
// an unrelated "Claimant Name" checkbox — 10 templates per the 2026-10-02 full-catalog scan): CONFIRMED live
// same day, a scenario whose only selected choice was something else still got "Apply Medical Letterhead?"'s
// own boilerplate content check re-enabled and FAILed, even though that letterhead paragraph correctly never
// printed. Only re-enables a requirement when a selected choice's own REAL label shares a significant word
// with that requirement's own condition note; a generic placeholder label can never positively correlate, so
// it's treated as "can't confirm" (stays SKIPPED) rather than guessed — understating coverage for that one
// case is far safer than a confidently-wrong FAIL. (Recovering real labels for these choices so this can
// positively match more often, instead of just conservatively skipping, is a separate follow-up —
// questionTextFor's sibling-walk in interactiveEditService.js isn't finding them for whatever this DOM layout
// actually is, which needs live diagnostics to pin down, not a blind guess.)
function choiceLabelMatchesCondition(disabledReason, choiceLabel) {
  // choiceLabel now carries a trailing ": Yes" (interactiveEditService.js, 2026-10-02 — the Choices Answered
  // report column needed to show what was actually selected, not just the bare question text) — the generic
  // placeholder is a PREFIX now, not the whole string, so this can't be a full-string match any more.
  if (!choiceLabel || /^\(unlabeled (choice|checkbox)\)(:|$)/i.test(choiceLabel)) return false;
  const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z]{4,}/g) || []);
  const reasonWords = words(disabledReason);
  for (const w of words(choiceLabel)) { if (reasonWords.has(w)) return true; }
  return false;
}

function reEnableChoiceGatedRequirements(reqs, re, choicesApplied) {
  reEnableFieldsMatching(reqs, (r) => re.test(r.fieldName || '') && choicesApplied.some((label) => choiceLabelMatchesCondition(r.disabledReason, label)));
}

// Agent Number is, by definition, the additional recipient's OWN agent/producer number — CONFIRMED live
// 2026-10-02 (DIG53/DIG53-GL-PA): it only ever prints when an additional recipient is actually added, same as
// a template's own "Copy Name"/"Copy Address" fields. But several templates' own BA comment on the Agent
// Number field specifically lacks the "if additional recipient is entered" wording that drives
// templateRequirementService's build-time disable — only the SIBLING "Name/Number/Address" paragraph's own
// comment has it — so Agent Number was never being disabled at all, and FAILed unconditionally (a guaranteed
// FAIL whenever no recipient ended up added, exactly like R28 before the RECIPIENT_DEPENDENT_RE fix). Treated
// as additional-recipient-gated here regardless of what the template's own comment on this one field says.
function isAgentNumberRequirement(r) {
  return r.expectedSource === 'payload.agentNumber';
}

function isAdditionalRecipientGated(r) {
  return ADDITIONAL_RECIPIENT_CONDITION_RE.test(r.fieldName || '') || isAgentNumberRequirement(r);
}

function templateExpectsAdditionalRecipient(reqs) {
  return reqs.some(isAdditionalRecipientGated);
}

// CONFIRMED live via a full-catalog scan 2026-10-02: DIG141/DIG226/DIG239's "Agent Number" field only prints
// when the additional recipient specifically has the role "Producer" (e.g. "Agent Number. Will only be
// visible if the Additional Recipient has the role of Producer") — picking the first eligible, non-excluded
// contact regardless of role (the existing default) would usually pick someone else, correctly leaving the
// field blank per the template's own logic, but never actually exercising this content check. Used to decide
// whether to pass a preferredRole into setAdditionalRecipient.
const PRODUCER_ROLE_CONDITION_RE = /role of producer/i;

function templateWantsProducerRole(reqs) {
  return reqs.some((r) => PRODUCER_ROLE_CONDITION_RE.test(r.fieldName || ''));
}

// Flips back on every requirement matching `matcher` — used PER SCENARIO (not once, globally, at the top of
// validateTemplate) because whether a condition actually held is a per-scenario fact: one scenario's only
// eligible additional-recipient contact might have no address and get removed (see
// documentService.setAdditionalRecipient), while another scenario's doesn't — re-enabling unconditionally for
// every scenario of a template would wrongly expect "Copy ..." content on the one where no recipient actually
// ended up added. Mutates a SCENARIO-LOCAL clone of requirements, never the shared template-level array —
// scenarios can run concurrently (SMARTCOMM_CONCURRENCY), so mutating one shared array from multiple scenarios
// at once would be a race. `matcher` is a RegExp tested against fieldName (the original, simple case) or a
// predicate function taking the whole requirement (for a condition like isAdditionalRecipientGated that needs
// to match on more than just fieldName text — e.g. Agent Number, whose own comment never says it's
// conditional at all).
function reEnableFieldsMatching(reqs, matcher) {
  const test = typeof matcher === 'function' ? matcher : (r) => matcher.test(r.fieldName || '');
  for (const r of reqs) {
    if (test(r)) {
      delete r.enabled;
      delete r.disabledReason;
    }
  }
}

// A condition-derived "Name and Number and Address" block (e.g. DIG223's "Only display 'CC:' Name and Number
// and Address if additional recipient is entered") has no direct dictionary/synonym mapping of its own — just
// templateRequirementService's unmapped 'dynamicShape'/text fallback (see RECIPIENT_DEPENDENT_RE there),
// which can only ever report BLOCKED ("presence not verified"), never actually confirm the real content
// printed. Once we KNOW a real additional recipient was added this scenario, we can do better: the
// recipient's own NAME is the single most reliable anchor that the combined block actually rendered for real
// data (its number/address are already checked separately wherever the template tags those individually,
// e.g. "Copy Address"/"Agent Number") — CONFIRMED live 2026-10-02 (DIG223: R28 stayed BLOCKED even though
// R29/R30/R31 — Copy Name/Agent Number/Copy Address — all independently PASSED with the same real recipient's
// data). Upgrades the requirement in place to a real dynamicValueMatch instead of leaving it a permanent
// non-answer.
function upgradeRecipientDependentRequirements(reqs, re, additionalRecipient) {
  if (!additionalRecipient || !additionalRecipient.name) return;
  for (const r of reqs) {
    if (!re.test(r.fieldName || '') || r.type !== 'dynamicShape' || r.shape !== 'text') continue;
    r.type = 'dynamicValueMatch';
    r.expectedSource = 'additionalRecipient.name';
    r.description = `Value for "${r.fieldName}" must match the additional recipient's own name (additionalRecipient.name)`;
    delete r.shape;
  }
}

async function runScenario(page, { template, scenario, requirements, recipientEmail, variant, mentionsFraudLanguage, interactive, s3Session }) {
  scenario = { ...scenario };
  const base = {
    scenarioId: scenario.scenarioId,
    digNumber: template.digNumber,
    templateName: template.documentName,
    lob: scenario.lob,
    state: scenario.state,
    claimNumber: scenario.testData.claimNumber,
    isFallbackClaim: Boolean(scenario.isFallbackClaim),
    variant: {
      documentType: variant.documentType, status: variant.status, securityType: variant.securityType,
      returnEnvelope: variant.returnEnvelope, certifiedMail: variant.certifiedMail,
      user: variant.user ? variant.user.username : null,
    },
    validations: [],
  };
  if (scenario.isFallbackClaim) {
    console.log(`[SmartComm] ${scenario.scenarioId}: WARNING — no test-data claim actually matches ${template.digNumber}'s own State/LOB applicability; running claim ${scenario.testData.claimNumber} (real LOB/State: ${scenario.lob}/${scenario.state}) anyway as a FALLBACK so this template gets some coverage instead of none. Treat this scenario's content results with that in mind.`);
  }

  try {
    // Each scenario logs in fresh so a template's scenarios can each run as
    // a different real user (scenarioVariants.js) — falls back to the
    // existing single admin login when a variant slot's SMARTCOMM_TEST_USER_n
    // /PASS_n aren't set in .env, so this is backward compatible with a run
    // that hasn't configured multi-user testing at all. Also falls back if
    // the login itself fails (CONFIRMED live: a locked account fails fast
    // with ClaimCenter's own "account has been locked" message, not a crash)
    // — a bad/locked account for one variant slot degrades that one scenario
    // to the admin login rather than erroring out the whole scenario.
    let usingAdmin = !variant.user;
    if (variant.user) {
      try {
        await loginAsUser(page, variant.user.username, variant.user.password);
      } catch (err) {
        usingAdmin = true;
        console.log(`[SmartComm] ${scenario.scenarioId}: login as ${variant.user.username} failed (${err.message}) — falling back to admin login for this scenario`);
        base.variant.user = `${variant.user.username} (FAILED — used admin instead)`;
        await loginAsAdmin(page);
      }
    } else {
      await loginAsAdmin(page);
    }

    console.log(`[SmartComm] ${scenario.scenarioId}: opening claim ${scenario.testData.claimNumber} (user=${variant.user ? variant.user.username : 'admin'}, documentType=${variant.documentType}, status=${variant.status}, securityType=${variant.securityType})`);
    await openExistingClaim(page, scenario.testData.claimNumber);

    // No permission on this claim → (1) same claim as admin, (2) if admin is
    // denied too, the scenario's alternate claims (same LOB/State) as admin.
    if (await claimAccessDenied(page, scenario.testData.claimNumber)) {
      if (!usingAdmin) {
        console.log(`[SmartComm] ${scenario.scenarioId}: ${variant.user.username} has no permission to view claim ${scenario.testData.claimNumber} — retrying the same claim as admin`);
        base.variant.user = `${variant.user.username} (no permission on claim — used admin instead)`;
        await loginAsAdmin(page);
        usingAdmin = true;
        await openExistingClaim(page, scenario.testData.claimNumber);
      }
      let denied = await claimAccessDenied(page, scenario.testData.claimNumber);
      for (const alt of denied ? (scenario.alternates || []) : []) {
        console.log(`[SmartComm] ${scenario.scenarioId}: no permission to view claim ${scenario.testData.claimNumber} even as admin — trying alternate claim ${alt.claimNumber}`);
        await openExistingClaim(page, alt.claimNumber);
        denied = await claimAccessDenied(page, alt.claimNumber);
        if (!denied) {
          scenario.testData = alt;
          base.claimNumber = alt.claimNumber;
          break;
        }
      }
      if (denied) {
        throw new Error(`CLAIM_ACCESS_DENIED: "you do not have permission to view this claim" for ${scenario.testData.claimNumber}${(scenario.alternates || []).length ? ' and its alternates' : ''}, even as admin.`);
      }
    }

    // Capture insured name / loss date / loss location / claimant name
    // straight off the claim's own Summary screen (CONFIRMED live) while
    // it's still showing, before navigating into the document wizard. Live
    // data always wins over testDataService's seeded record when captured —
    // comparisons should be against what THIS claim actually has right now,
    // not a value that can go stale, regardless of whether the claim came
    // from the Runner UI's manual override or a Test Data inventory match.
    // The seeded record's value is only a fallback for whatever live
    // capture couldn't find (e.g. a claim with no separate claimant party).
    const captured = await claimSummaryService.captureClaimSummary(page);
    const effectiveTestData = { ...scenario.testData, ...Object.fromEntries(Object.entries(captured).filter(([, v]) => v !== undefined)) };
    // Every party's own roles (e.g. "Mark Antolick" -> ["Driver", "Covered Party", ...]) — captured once,
    // here, while still on the Summary screen (same table captureClaimSummary just read), for
    // setAdditionalRecipient to optionally prefer a specific role (see templateWantsProducerRole below).
    const partiesRoles = await claimSummaryService.capturePartiesRoles(page);
    console.log(`[SmartComm] ${scenario.scenarioId}: claim data — insuredName=${JSON.stringify(effectiveTestData.insuredName)} lossDate=${JSON.stringify(effectiveTestData.lossDate)} lossLocation=${JSON.stringify(effectiveTestData.lossLocation)} claimantName=${JSON.stringify(effectiveTestData.claimantName)}`);

    await documentService.openCreateFromTemplate(page);
    await documentService.selectTemplate(page, [template.searchName, template.searchNameAlt]);
    const recipient = await documentService.setPrimaryRecipient(page, { preferredName: effectiveTestData.insuredName }); // { name, address }
    const scenarioLog = (m) => console.log(`[SmartComm] ${scenario.scenarioId}: ${m}`);
    // Fully configure the PRIMARY recipient's row — Delivery Channel, Return Envelope/Certified Mail, Email —
    // while it's still the ONLY row in the grid, exactly like the single-recipient flow that's worked
    // reliably for months. CONFIRMED live 2026-10-02: changing an EXISTING row's Delivery Channel to Print
    // AFTER a second recipient already exists never produces Return Envelope/Certified Mail radios for that
    // row (even row-scoped, even with a genuine "" → "Print" change event) — but a row that's Print from the
    // moment it's first inserted (true for a newly-added additional recipient, via setAdditionalRecipient's
    // own row-scoped selectOption) gets them immediately. Finishing primary's setup first sidesteps the whole
    // problem instead of fighting it.
    await documentService.setDeliveryChannel(page, 'Print');
    await documentService.setMailOptions(page, { returnEnvelope: variant.returnEnvelope, certifiedMail: variant.certifiedMail });
    await documentService.setEmail(page, recipientEmail);

    // Scenario-local clone — see reEnableFieldsMatching's own comment: mutating the shared template-level
    // `requirements` array here would race against other concurrently-running scenarios of this same
    // template (SMARTCOMM_CONCURRENCY), and different scenarios can legitimately end up with different
    // additionalRecipient/choicesApplied outcomes anyway.
    const scenarioRequirements = requirements.map((r) => ({ ...r }));
    // Force-disable any Agent Number requirement that templateRequirementService's build-time pass left
    // enabled (its own comment doesn't carry the "if additional recipient is entered" wording — see
    // isAgentNumberRequirement's comment) — otherwise it's never touched by the re-enable below and FAILs
    // unconditionally whenever no recipient ends up added this scenario.
    for (const r of scenarioRequirements) {
      if (isAgentNumberRequirement(r) && r.enabled !== false) {
        r.enabled = false;
        r.disabledReason = 'Agent Number only prints for the additional recipient (the agent/producer being added) — gated here even though this field\'s own template comment doesn\'t say so.';
      }
    }
    let additionalRecipient;
    if (templateExpectsAdditionalRecipient(requirements)) {
      additionalRecipient = await documentService.setAdditionalRecipient(page, {
        excludeName: recipient.name, log: scenarioLog,
        preferredRole: templateWantsProducerRole(requirements) ? 'Producer' : undefined,
        partiesRoles,
      });
      if (additionalRecipient) {
        await documentService.setRowMailOptions(page, additionalRecipient.name, { log: scenarioLog });
        await documentService.setEmail(page, recipientEmail, additionalRecipient.name);
        reEnableFieldsMatching(scenarioRequirements, isAdditionalRecipientGated);
        upgradeRecipientDependentRequirements(scenarioRequirements, ADDITIONAL_RECIPIENT_CONDITION_RE, additionalRecipient);
      }
    }
    const applied = await documentService.setAdditionalData(page, {
      language: 'English (US)', documentType: variant.documentType, status: variant.status, securityType: variant.securityType,
    });
    // Report what was really set, not what was requested (a field can be
    // absent from a template's Additional Data screen).
    const notSet = '(field not on screen)';
    base.variant.documentType = applied.documentType || notSet;
    base.variant.status = applied.status || notSet;
    base.variant.securityType = applied.securityType || notSet;

    // ClaimCenter's own "Download Payload" button (Create tab, Development section) — see the long
    // comment this replaced, still true for both branches below, EXCEPT that for Interactive it must be
    // clicked here, before Interactive navigates the Create tab away into the editor (that button never
    // reappears once the editor has loaded).
    // Populated alongside `payload` whenever the payload downloads successfully — the RAW parsed XML (not
    // payloadService's curated subset), used by payloadXpathService to resolve the Data Dictionary's own
    // "Xpath" column directly, covering ~100 fields instead of just the ~20 payloadService.js hand-curates.
    let rawPayloadRoot;
    async function tryDownloadPayload() {
      try {
        const payloadPath = await documentService.downloadPayload(page, {
          fileNamePrefix: `${template.digNumber}_${scenario.testData.claimNumber}_${scenario.scenarioId}`,
        });
        rawPayloadRoot = payloadXpathService.parseRawPayloadFile(payloadPath).ccDocumentCreationRequest;
        return payloadService.parsePayloadFile(payloadPath);
      } catch (err) {
        console.log(`[SmartComm] ${scenario.scenarioId}: payload download/parse failed — ${err.message} (data-capture cross-check and From Phone/Email skipped for this scenario)`);
        return undefined;
      }
    }

    let pdfPath, payload, interactiveChecks;
    let choicesApplied = [];
    base.creationMode = template.interactiveOrOnDemand;
    if (template.interactiveOrOnDemand === 'Interactive') {
      if (!interactive) {
        throw new Error(
          `INTERACTIVE_NOT_ENABLED: ${template.digNumber} is marked "Interactive" in the template index — the On-Demand ` +
          `Generate button is not the intended path for it. Re-run with the Interactive option enabled (opens a real ` +
          `browser window and needs you to complete Microsoft sign-in once when prompted) to test it properly.`
        );
      }
      // Interactive lives on the Create tab too — generateOnDemand() (On-Demand's own path) navigates there
      // itself before Generate; this path needs the same navigation done explicitly here, since
      // clickInteractiveAndWaitForEditor() doesn't. The payload is fetched from S3 INSIDE
      // runInteractiveGeneration (same visit as the PDF, by the same Document Properties Identifier) rather
      // than via the Create tab's own "Download Payload" button — CONFIRMED live that button is frequently
      // unavailable in this Test environment (0/65 and 20/20 across two full sweeps today), while the S3
      // fetch has been reliable — see runInteractiveGeneration's own comment.
      await page.getByRole('tab', { name: 'Create', exact: true }).click();
      const result = await runInteractiveGeneration(page, {
        template, scenario, effectiveTestData, recipient, additionalRecipient,
        fileNamePrefix: `${template.digNumber}_${scenario.testData.claimNumber}_${scenario.scenarioId}`,
        s3Session,
        commentFieldNames: scenarioRequirements.map((r) => r.fieldName).filter(Boolean),
      });
      pdfPath = result.pdfPath;
      interactiveChecks = result.interactiveChecks;
      base.dictionaryReference = result.dictionaryReference;
      base.trackedDictionaryFields = result.trackedFields;
      base.unmatchedTrackedDictionaryFields = result.unmatchedTrackedFields;
      payload = result.payload;
      rawPayloadRoot = result.rawPayloadRoot;
      choicesApplied = result.choicesApplied || [];
      if (choicesApplied.length) {
        reEnableChoiceGatedRequirements(scenarioRequirements, CHOICE_SELECTED_YES_RE, choicesApplied);
      }
    } else {
      pdfPath = await documentService.generateOnDemand(page, {
        fileNamePrefix: `${template.digNumber}_${scenario.testData.claimNumber}_${scenario.scenarioId}`,
      });
      payload = await tryDownloadPayload();
    }

    const text = await pdfValidationService.extractPdfText(pdfPath);
    if (interactiveChecks) verifyInteractiveEditsInPdf(interactiveChecks, text, (m) => console.log(`[SmartComm] ${scenario.scenarioId}: ${m}`));
    // recipient.{name,address} is who/where documentService actually
    // selected — the source of truth for "To Name"/"To Street Address"/"To
    // City, State, Zip" requirements (see fieldLabelSynonyms.js), correct
    // regardless of which claim/recipient this scenario used. testData here
    // is effectiveTestData (testData.js merged with whatever
    // claimSummaryService captured live) — not the raw scenario.testData.
    const context = {
      testData: effectiveTestData, scenario, template, recipient, additionalRecipient,
      // Spreads every flat field payloadService already returns (claimNumber,
      // lossDate, policyNumber, policyEffectiveDate/ExpirationDate,
      // underwritingCompany, agentNumber, vehicleYear/Make/Model/Vin/
      // BodyStyle, ...) so a new field added there is usable here without
      // an edit in this file — plus the few derived from nested objects
      // (from.*, agent.name) that fieldLabelSynonyms.js's dotted paths need
      // flat.
      payload: payload ? {
        ...payload,
        fromName: payload.from && payload.from.name,
        fromPhone: payload.from && payload.from.phone,
        fromEmail: payload.from && payload.from.email,
        fromTitle: payload.from && payload.from.title,
        agentName: payload.agent && payload.agent.name,
        attorneyName: payload.attorney && payload.attorney.name,
        attorneyPhone: payload.attorney && payload.attorney.phone,
        attorneyAddress: payload.attorney && payload.attorney.address,
        providerName: payload.provider && payload.provider.name,
        providerPhone: payload.provider && payload.provider.phone,
        providerAddress: payload.provider && payload.provider.address,
      } : undefined,
    };

    // The template's own "Fraud Language" BA comment (if any) is left
    // SKIPPED by templateRequirementService — its anchored text is just
    // whatever sample the BA had when authoring the doc, not the real,
    // state-specific required wording. For any template that mentions fraud
    // language at all, resolve and check the REAL text here instead, using
    // this scenario's actual claim (via the payload, not test data — see
    // fraudLanguageService.js).
    let fraudRequirements = [];
    let fraudDetails = {};
    if (payload && (mentionsFraudLanguage || scenarioRequirements.some((r) => /fraud language/i.test(r.fieldName || '')))) {
      const fraudResult = buildFraudLanguageRequirements(payload);
      fraudRequirements = fraudResult.requirements;
      fraudDetails = fraudResult.details;
      context.fraudLanguage = fraudResult.context;
    }

    // Every Data Dictionary row applicable to this template (Column E) that has an Xpath (Column H) and
    // resolves to a real value against THIS scenario's own real payload — genuine ClaimCenter ground truth,
    // not a guess, and covering far more fields than payloadService.js's own hand-curated subset. Only
    // generated when the payload actually downloaded (rawPayloadRoot set) — degrades to zero extra
    // requirements otherwise, same graceful-skip convention as fraudRequirements above.
    const xpathRequirements = rawPayloadRoot ? buildXpathRequirements(template, rawPayloadRoot, scenarioRequirements, interactiveChecks, (m) => console.log(`[SmartComm] ${scenario.scenarioId}: ${m}`)) : [];

    // A Choices-panel question that never got confirmed Yes this scenario (it genuinely wasn't on the page
    // for this claim, or simply defaults to No and nothing selected it) has nothing to validate — its gated
    // content correctly never prints, and there's no real "check" being skipped, just a condition that never
    // applied. CONFIRMED live 2026-10-02 (user direction): unlike the additional-recipient-gated fields (Copy
    // Name/Address/Agent Number — worth keeping visible as SKIPPED, since "no recipient added" is itself a
    // meaningful scenario fact), a never-selected Choices question is noise — drop it from the report
    // entirely rather than show a SKIPPED row for every such condition on every scenario.
    const reportableRequirements = scenarioRequirements.filter((r) => !(CHOICE_SELECTED_YES_RE.test(r.fieldName || '') && r.enabled === false));
    const validations = pdfValidationService.evaluateRequirements([...reportableRequirements, ...fraudRequirements, ...xpathRequirements], text, context);
    explainFraudLanguageFailures(validations, text, fraudDetails);
    annotateInteractiveEditFailures(validations, interactiveChecks);
    // "Data capture" cross-check (Insured / Claimant / Loss Date / Policy Number / Underwriting Company) compares
    // this tool's own Summary-screen scrape with the payload ClaimCenter sent to SmartCOMM. It says nothing about
    // the template, so it is NOT reported or counted — a mismatch (capture drift) is only logged for whoever is
    // watching the run.
    if (payload) {
      const mismatches = payloadService.compareToClaimData(effectiveTestData, payload).filter((v) => v.result === 'FAIL');
      if (mismatches.length) {
        console.log(`[SmartComm] ${scenario.scenarioId}: data-capture self-check mismatch (not in the report): ` +
          mismatches.map((v) => `${v.description.replace('Data capture check: ', '')} expected=${JSON.stringify(v.expected)} actual=${JSON.stringify(v.actual)}`).join('; '));
      }
    }

    const passed = validations.filter(v => v.result === 'PASS').length;
    const failed = validations.filter(v => v.result === 'FAIL').length;
    const blocked = validations.filter(v => v.result === 'BLOCKED').length;
    const skipped = validations.filter(v => v.result === 'SKIPPED').length;
    // A dictionary-vs-live-session disagreement (interactiveChecks FAIL) is just as much a genuine defect as a
    // content-validation FAIL, so it must fail the scenario too — previously only `validations` was consulted
    // here, so a scenario with editable-field defects but clean content checks silently reported PASS (per
    // user direction 2026-10-05: "if there are failures in interactive session table...overall status needs
    // to show as failed").
    const fieldsFailed = interactiveChecks.filter(c => c.result === 'FAIL').length;
    const status = (failed > 0 || fieldsFailed > 0) ? 'FAIL' : blocked > 0 ? 'BLOCKED' : 'PASS';

    console.log(`[SmartComm] ${scenario.scenarioId}: ${status} (${passed} passed, ${failed} failed, ${blocked} blocked, ${skipped} skipped)`);
    // Which of this template's own CONDITIONAL print paths actually got exercised this scenario — surfaced
    // in the report (reportService.js/bulkReportService.js) so a reviewer can see at a glance whether, say,
    // the additional-recipient/CC block or the Medical Letterhead content was genuinely tested here, rather
    // than having to infer it from individual requirement rows.
    const conditionalSummary = {
      additionalRecipientExpected: templateExpectsAdditionalRecipient(requirements),
      additionalRecipientAdded: Boolean(additionalRecipient),
      additionalRecipientName: additionalRecipient ? additionalRecipient.name : null,
      choicesAnswered: choicesApplied,
    };
    return { ...base, status, recipient, pdfPath, validations, interactiveChecks, passed, failed, blocked, skipped, conditionalSummary };
  } catch (err) {
    // A template not yet released to this environment's SmartCOMM library
    // (documentService.selectTemplate's TEMPLATE_NOT_FOUND — CONFIRMED live
    // on DIG47, DIG124) is a known, expected precondition failure, not an
    // automation crash — report it as BLOCKED like any other missing
    // precondition, not ERROR.
    // Same reasoning for documentService.generateOnDemand's GENERATE_FAILED
    // (CONFIRMED live, DIG59/claim CPP-DE-01-26-0000049: ClaimCenter's own
    // "Data required to create document not found..." instead of a
    // document) — this claim is missing something the letter needs (that
    // claim had no claimant party at all), not a script defect, so it's a
    // precondition failure too. GENERATE_TIMEOUT (neither a result nor an
    // error ever showed up) stays an ERROR — that's an unexplained hang, not
    // a confirmed CC-side "can't run this" response.
    if (err.message.startsWith('TEMPLATE_NOT_FOUND') || err.message.startsWith('GENERATE_FAILED') || err.message.startsWith('INTERACTIVE_NOT_ENABLED')) {
      console.log(`[SmartComm] BLOCKED ${scenario.scenarioId}: ${err.message}`);
      return { ...base, status: 'BLOCKED', reason: err.message, passed: 0, failed: 0, blocked: 1, skipped: 0 };
    }
    console.log(`[SmartComm] ERROR ${scenario.scenarioId}: ${err.message}`);
    // err.interactiveChecks/choicesApplied (see runInteractiveGeneration's own completeDocument try/catch)
    // preserve whatever field-editing progress happened before the throw, so a Complete-Document failure's
    // saved report still shows what was/wasn't edited at that point instead of just the raw error text.
    return {
      ...base, status: 'ERROR', reason: err.message, passed: 0, failed: 0, blocked: 0, skipped: 0,
      ...(err.interactiveChecks ? { interactiveChecks: err.interactiveChecks } : {}),
      ...(err.choicesApplied ? { conditionalSummary: { choicesAnswered: err.choicesApplied } } : {}),
    };
  }
}

// Picks the most human-identifiable name for a field, in order of trust. CONFIRMED live 2026-09-30 (65-
// template sweep): Thunderhead's own aria-label technical name is very often a GENERIC, auto-generated
// placeholder ("editableField4", "checkBox1", "field12") — useless for telling one field apart from another
// in a report, and this was the majority of what showed up in the field-failures export. Priority: a Data
// Dictionary match (most authoritative — truncated so a long Column I business-rule description doesn't
// blow out a report row) → a genuinely non-generic technical name → the on-page text immediately before the
// field (labelContext — already captured for dictionary matching in readMergeFields, e.g. "Date of Loss:";
// far more useful for a human than a generated ID) → the generic technical name anyway (still better than
// nothing) → the field's own raw value as the last resort.
const GENERIC_TECHNICAL_NAME_RE = /^(editableField|checkBox|field|textbox|input)\d*$/i;
function truncateLabel(s, max) { return s && s.length > max ? s.slice(0, max - 1) + '…' : s; }
function pickFieldLabel(n, field, outcome, dictRow) {
  const dictLabel = dictRow && (dictRow.ccFieldDisplay || dictRow.attributeName);
  const technicalNameIsGeneric = outcome.technicalName && GENERIC_TECHNICAL_NAME_RE.test(outcome.technicalName);
  const labelContext = field.labelContext && field.labelContext.trim();
  return truncateLabel(dictLabel, 70)
    || (!technicalNameIsGeneric && outcome.technicalName)
    || labelContext
    || outcome.technicalName
    || `(field #${n}: "${(field.stripped || field.text || '').slice(0, 60) || '(empty)'}")`;
}

function normForKnownValueMatch(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

const EDIT_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

// Builds a real, validly-formatted calendar date, offset by `n` days from the dictionary's own sample date
// (or a fixed base if the sample isn't MM/DD/YYYY-shaped) so every field still gets its own distinct value —
// same reasoning as the dollar-amount fix below, just for Date-typed fields instead of numeric ones. This
// closes a gap verifyInteractiveEditsInPdf already flagged in its own comments: a synthetic non-date marker
// risks being silently reformatted/rejected downstream even where the editor itself accepts it.
function buildDateValue(sampleValue, n) {
  const m = EDIT_DATE_RE.exec(String(sampleValue || '').trim());
  const base = m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : new Date(2026, 0, 1);
  base.setDate(base.getDate() + n);
  const mm = String(base.getMonth() + 1).padStart(2, '0');
  const dd = String(base.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${base.getFullYear()}`;
}

const EDIT_TIME_RE = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;

// Builds a plausible "H:MMAM/PM"-shaped time, offset by `n` minutes from the dictionary's own sample time (or
// 3:30PM if the sample isn't in that shape) so it stays unique per field. Works in minutes-since-midnight
// throughout so AM/PM actually flips correctly once the offset crosses noon/midnight — an earlier version
// tracked only a 12-hour span and could never produce PM, since "hour" could then never reach 12.
function buildTimeValue(sampleValue, n) {
  const m = EDIT_TIME_RE.exec(String(sampleValue || '').trim());
  let totalMinutes = 15 * 60 + 30; // 3:30 PM fallback, in 24-hour minutes-since-midnight
  if (m) {
    let hour24 = Number(m[1]) % 12;
    if (/pm/i.test(m[3])) hour24 += 12;
    totalMinutes = hour24 * 60 + Number(m[2]);
  }
  totalMinutes = (totalMinutes + n) % (24 * 60);
  const hour24 = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')}${ampm}`;
}

// A field immediately preceded by "$" (e.g. "...in the amount of $[--<<EditableField>>--]") almost certainly
// expects a numeric dollar amount, not free text — CONFIRMED live 2026-10-06 (DIG36): typing the usual
// "[QA-EDIT-N]" bracketed TEXT marker into one of these is the same kind of "non-text-typed field silently
// rejects free text" failure already seen for checkboxes, just triggered by a numeric-only field instead of a
// checkbox. `900 + n` keeps the value plainly numeric while still unique per field (so the PDF-survival check
// can't mistake one field's edit for a different field's) — field counts never get anywhere near 100 per
// document, so collisions aren't a real risk.
//
// Per user direction 2026-10-07: the Data Dictionary's own "Attribute Data Type" column (Date/Money/Number/
// Time/Text/...) is now consulted BEFORE falling back to the "$"-prefix heuristic above — a far more general
// signal than guessing from surrounding text, and it covers every Date-typed field, not just ones immediately
// preceded by a dollar sign. The dictionary match here is necessarily looked up by labelContext ALONE (the
// live editor's own technicalName isn't known until the field is actually double-clicked, inside
// inspectAndMaybeEdit — a chicken-and-egg ordering this sidesteps rather than restructures, since
// matchAttributeForField's label-matching tier alone already resolves the large majority of fields; the final,
// fuller match recorded on interactiveChecks after the edit can still use technicalName too). A field that
// doesn't resolve to a dictionary row at all, or resolves to "Text"/blank, keeps the exact prior behavior
// (dollar heuristic, else the bracketed marker) — this only changes behavior for fields the dictionary
// positively identifies as Date/Money/Number/Time.
function buildEditValue(field, n, digNumber) {
  const match = digNumber && dataDictionaryService.matchAttributeForField(digNumber, { labelContext: field.labelContext });
  const dataType = match && match.row && match.row.dataType;
  if (dataType === 'Date') return buildDateValue(match.row.sampleValue, n);
  if (dataType === 'Money' || dataType === 'Number') return String(900 + n);
  if (dataType === 'Time') return buildTimeValue(match.row.sampleValue, n);
  return /\$\s*\[?\s*$/.test(field.labelContext || '') ? String(900 + n) : `[QA-EDIT-${n}]`;
}

// Claims a still-unmatched interactiveChecks entry by comparing its OWN captured value (`before` — the
// field's initial, pre-edit rendered text) against a list of {attributeName, value} pairs this scenario
// already knows to be true (who was picked as Primary/Additional Recipient, the 'From' contact's own
// name/phone/email/title — see call sites). `attributeName` must be the dictionary's own exact Column A text
// (looked up directly, not fuzzy — the caller already knows precisely which business field this is).
// Each known value claims AT MOST ONE field (the first match, in field order) — CONFIRMED live 2026-10-05
// (DIG122B): the insured/recipient's own name legitimately appears more than once in some documents (e.g.
// also as a separately-tracked "Insured Name" merge field, or repeated elsewhere), and without this a
// single known value wrongly tagged every one of those as the SAME dictionary row ("To Name" matched 4
// different fields in one scenario), reporting false "editability disagrees" findings that were really just
// over-eager matching, not real defects.
function assignByKnownValue(interactiveChecks, digNumber, knownValues) {
  if (!knownValues.length) return;
  const claimed = new Set();
  for (const c of interactiveChecks) {
    if (c.dictionaryField) continue; // already matched (label-based pass runs first)
    const beforeNorm = normForKnownValueMatch(c.before);
    if (!beforeNorm) continue;
    // CONFIRMED live 2026-10-06 (DIG162): finding the first NOT-YET-CLAIMED match (the original approach) lets
    // a field whose text equally matches an EARLIER-priority, ALREADY-claimed value (e.g. "To Name" — already
    // claimed by the address block) fall through and settle for a LATER, lower-priority value that happens to
    // share the same text (e.g. "Claimant Name") — wrongly relabeling a salutation that repeats the recipient's
    // own name as the claimant instead. Find the single BEST match first (array priority order, regardless of
    // claimed status), and only act on it if that best match is still free — if it's already taken, this field
    // is genuinely ambiguous between two coincidentally-same-valued concepts, so it's safer to leave it
    // unmatched (flagged for manual review) than to guess a worse-priority concept just because it's unclaimed.
    const best = knownValues.find((kv) => {
      const vNorm = normForKnownValueMatch(kv.value);
      return vNorm.length >= 3 && (beforeNorm === vNorm || beforeNorm.includes(vNorm) || vNorm.includes(beforeNorm));
    });
    if (!best || claimed.has(best.attributeName)) continue;
    const hit = best;
    claimed.add(hit.attributeName);
    // Scoped-first, falling back to an exact-name-only match beyond the dictionary's own Form(s) column (see
    // dataDictionaryService.getAttributeByExactName's header) — `hit.attributeName` here is a literal,
    // caller-known dictionary Column A name ("Copy Name", "Underwriting Company"...), not a guess, so an exact
    // agreement is trustworthy even when Form(s) hasn't been kept in sync for this DIG.
    const found = dataDictionaryService.getAttributeByExactName(digNumber, hit.attributeName);
    if (!found) continue;
    const row = found.row;
    c.dictionaryField = row.attributeName;
    c.dictionaryEditable = row.editable;
    c.dictionaryMatchedOn = found.scoped ? 'knownValue' : 'knownValueUnscoped';
    c.dictionaryAgrees = row.editable !== null ? row.editable === c.expectedEditable : null;
  }
}

// Runs the Interactive editing session for one scenario: click Interactive, wait for a human to clear the
// Azure SSO popup, edit every field the data dictionary marks editable (and confirm every other field
// resists editing), Save Changes, Complete Document, then fetch the completed PDF from S3 by the
// Document Properties Identifier (see helpers/s3Download/s3AdminService.js — CONFIRMED live that this
// Identifier is exactly the S3 object's filename). See interactiveEditService.js's own header for what in
// here is still a first-draft guess vs. actually confirmed live.
async function runInteractiveGeneration(page, { template, scenario, effectiveTestData, recipient, additionalRecipient, fileNamePrefix, s3Session, commentFieldNames }) {
  const log = (m) => console.log(`[SmartComm] ${scenario.scenarioId}: ${m}`);

  // Live preview for the Runner UI (Commercial Line Performance test/runner) — a read-only, auto-refreshing
  // screenshot a person watching that UI can poll, independent of whether they have desktop access to
  // whichever machine is actually running this headed browser. `activePage` starts as the main page and
  // swings over to the Azure sign-in popup for as long as one is open (see onPopup below and
  // livePreviewService.js's own header for why that redirect matters) — stopped unconditionally in `finally`
  // so a thrown error from anywhere below still cleans up its screenshot file.
  let activePage = page;
  const stopLivePreview = livePreviewService.startLivePreview(page, scenario.scenarioId, { getActivePage: () => activePage });
  try {
    await interactiveEditService.clickInteractiveAndWaitForEditor(page, page.context(), {
      log, scenarioId: scenario.scenarioId,
      onPopup: (popup) => { activePage = popup; popup.once('close', () => { activePage = page; }); },
    });
    const frame = await interactiveEditService.getEditorFrame(page);

  // "Apply Medical Letterhead?"-style choices (a separate right-hand panel, not inline merge fields — see
  // interactiveEditService's own header) drive conditional content/headers, so they need to be set BEFORE
  // reading merge fields/generating the document, not after. Not yet confirmed whether this panel lives on
  // the main page or inside the draft-editor frame — try both; whichever has no matches is a harmless no-op.
  const choicesApplied = [
    ...(await interactiveEditService.selectAllYesNoChoices(page, { log, label: 'main page' })),
    ...(await interactiveEditService.selectAllYesNoChoices(frame, { log, label: 'editor frame' })),
  ];
  if (choicesApplied.length) {
    log(`made ${choicesApplied.length} choice selection(s): ${choicesApplied.join('; ')}`);
  }
  if (process.env.DEBUG_CHOICES_HTML) {
    const html = await frame.evaluate(() => {
      const header = Array.from(document.querySelectorAll('*')).find((e) => (e.textContent || '').trim() === 'Select Language to display in Paragraph' && e.children.length === 0);
      if (!header) return '(header not found)';
      let node = header;
      for (let i = 0; i < 10 && node.parentElement; i++) {
        node = node.parentElement;
        if ((node.textContent || '').includes('garagekeepers comprehensive')) break;
      }
      return node.outerHTML.slice(0, 30000);
    }).catch((e) => `(eval failed: ${e.message})`);
    require('fs').writeFileSync(require('path').join(__dirname, '..', '..', 'results', 'smartComm', 'DEBUG_choices_html.html'), html);
    log(`DEBUG_CHOICES_HTML: dumped to results/smartComm/DEBUG_choices_html.html (${html.length} chars)`);
  }

  // CONFIRMED live 2026-09-30 (65-template sweep: 22 of 65 hit this) — "0 merge fields found" is usually NOT
  // a real empty document, it's a genuine render race: the diagnostic screenshot at the moment of the first
  // scan shows the document pane completely blank, even though getEditorFrame's own "Loading in progress"
  // text check had already cleared — that loading indicator disappearing evidently doesn't guarantee the
  // real paragraph/merge-field content has actually mounted into the DOM yet, especially under the sustained
  // load a long multi-template run puts on the browser. A single retry after a short wait resolves this in
  // practice; only treated as a genuine empty document after that retry ALSO comes back empty.
  let fields = await interactiveEditService.readMergeFields(frame);
  if (fields.length === 0) {
    await page.waitForTimeout(2000);
    fields = await interactiveEditService.readMergeFields(frame);
  }
  log(`interactive editor: ${fields.length} merge field(s) found (${fields.filter((f) => f.editable).length} editable, ${fields.filter((f) => !f.editable).length} locked)`);

  // A successfully-loaded editor (Complete Document visible, "Authenticating..." gone) that STILL shows 0
  // merge fields after the retry above is ambiguous on its own — could be a genuinely field-free document,
  // or some OTHER detection/timing issue the retry didn't happen to catch. Cross-checking against how many
  // fields the Data Dictionary itself expects for this DIG (Column E applicability + a non-blank Column G)
  // turns that ambiguity into an actual signal, and a diagnostic capture preserves the DOM state for later
  // inspection either way, matching the existing convention of capturing state at the moment something looks
  // wrong rather than only at final failure.
  if (fields.length === 0) {
    const expectedTracked = dataDictionaryService.countApplicableTrackedFields(template.digNumber);
    const diagPath = await interactiveEditService.saveDiagnostic(page, `${scenario.scenarioId}_zeroMergeFields`);
    log(`WARNING: 0 merge fields found in the editor despite it loading successfully. Data Dictionary tracks ${expectedTracked} field(s) as applicable to ${template.digNumber} — ` +
      (expectedTracked > 0
        ? `since that's > 0, this looks like a real detection gap or a document that rendered without its usual fields this run, not an expected empty document.`
        : `the dictionary also has nothing tracked for this DIG, so an empty result here is plausible, not clearly a bug.`) +
      (diagPath ? ` Diagnostic saved: ${diagPath}.png / .json` : ' (diagnostic capture failed)'));
  }

  // Ground truth for PASS/FAIL here is still the EDITOR'S OWN th-data-value(-editable) classification
  // (CONFIRMED live — see interactiveEditService.js's header): an editable field must actually accept an
  // edit, a locked one must not. What's new is matching each field to its real Data Dictionary row via
  // dataDictionaryService.matchAttributeForField — Column B (Template Attribute Name) against the editor's
  // own technical field name first, then Column I (ClaimCenter Field Display) against the on-page label
  // text immediately before the field, since Column B alone does NOT reliably match (CONFIRMED live:
  // "insuredName" in the DOM vs "PolicyInsured" in the dictionary for what's presumably the same concept,
  // but Column I text like "Insured Name" printed right before the field does match up). A match gives a
  // human-readable label AND lets a genuine BA-intent-vs-observed-behavior disagreement (dictionary says
  // Yes, editor renders it locked, or vice versa) surface as its own signal instead of staying invisible.
  const interactiveChecks = [];
  let n = 0;
  let skippedUnselectedChoiceCount = 0;
  for (const field of fields) {
    n += 1;
    // This field is a duplicate copy living inside a Choices-panel option that ISN'T the one we selected (see
    // readMergeFields' own `inUnselectedChoice` — CONFIRMED live 2026-10-06, DIG36: SmartCOMM previews every
    // option's paragraph simultaneously). It can never survive into the actual generated document, so editing
    // or validating it would just waste time and duplicate-report whatever the SELECTED copy already finds —
    // skip it entirely rather than double-click it or give it its own interactiveChecks entry.
    if (field.inUnselectedChoice) { skippedUnselectedChoiceCount += 1; continue; }
    // inspectAndMaybeEdit's own internal timeouts (5s dblclick, 15s default action timeout) bound EVERY
    // individual Playwright call it makes — but CONFIRMED live 2026-09-29 (DIG166, 26 fields) the whole
    // call can still sit with ZERO progress far longer than any of those could explain, which points at
    // something outside Playwright's own timeout machinery entirely — most likely a native, OS-level modal
    // (e.g. a file picker, a print dialog) that freezes the renderer process itself, which no page-level
    // action timeout can preempt. This watchdog doesn't try to recover from that (can't, safely) — it just
    // fires a screenshot WHILE the real call is still pending, so the frozen on-screen state is actually
    // visible afterward instead of guessed at. If saveDiagnostic's own screenshot call also hangs, that
    // itself is the answer: the whole tab is frozen, not just this one Playwright call.
    const watchdog = setTimeout(() => {
      log(`WARNING: field #${n} edit has not completed after 15s — capturing a live screenshot of the current (possibly frozen) state...`);
      interactiveEditService.saveDiagnostic(page, `${scenario.scenarioId}_field${n}_stuck`)
        .then((diagPath) => log(`[Interactive] Stuck-field diagnostic ${diagPath ? `saved: ${diagPath}.png / .json` : 'capture FAILED (page may be fully frozen, not just this one action)'}`));
    }, 15000);
    const outcome = await interactiveEditService.inspectAndMaybeEdit(frame, page, field, {
      newValue: field.editable ? buildEditValue(field, n, template.digNumber) : undefined, log,
    }).finally(() => clearTimeout(watchdog));
    // A locked field's "identify only" double-click (newValue left undefined, see inspectAndMaybeEdit) returns
    // changed:null — not false — whenever the double-click unexpectedly opens SOME editor popup anyway (a
    // locked field is usually expected to open nothing at all, but CONFIRMED live 2026-10-06, DIG53: a real
    // checkbox-type control can still pop one open on double-click despite being CSS-locked). The strict
    // `=== false` check below treated that null the same as a genuine resist-editing failure, wrongly FAILing
    // a field nothing ever actually tried to change. The only real failure for a locked field is its text
    // ACTUALLY changing (changed === true) — anything else (false, null, undefined) means it correctly
    // resisted, regardless of which path produced that non-change.
    const result = field.editable
      ? (outcome.attempted && outcome.changed ? 'PASS' : 'FAIL')
      : (outcome.changed !== true ? 'PASS' : 'FAIL');
    // CONFIRMED live 2026-09-29 (DIG166) the watchdog screenshots showed a normally-rendering page (no
    // native dialog, no frozen renderer) — so the earlier "OS-level modal" theory above is very likely
    // wrong for THIS failure mode; a slow-but-not-infinite per-field delay is far more consistent with a
    // WYSIWYG editor reflow/repagination race (each committed edit changes that field's text length,
    // reflowing everything after it — scrollIntoViewIfNeeded's actionability wait can plausibly never see
    // 2 consecutive stable frames while that's still settling, burning its own ~15s default before giving
    // up). Logging every FAILED field's real note immediately (not just the final tally) so the next run
    // shows the actual Playwright error text instead of this having to be re-diagnosed blind again.
    if (result === 'FAIL' && outcome.note) log(`field #${n} FAILED: ${outcome.note}`);
    const match = dataDictionaryService.matchAttributeForField(template.digNumber, {
      labelContext: field.labelContext, technicalName: outcome.technicalName,
    });
    const dictRow = match && match.row;
    interactiveChecks.push({
      id: `INT${n}`,
      label: pickFieldLabel(n, field, outcome, dictRow),
      labelContext: field.labelContext || null, technicalName: outcome.technicalName || null,
      expectedEditable: field.editable, observedChanged: outcome.changed, result,
      before: outcome.before, after: outcome.after, committedMarker: outcome.committedMarker, reason: outcome.note,
      dictionaryField: dictRow ? dictRow.attributeName : null,
      dictionaryEditable: dictRow ? dictRow.editable : null,
      dictionaryMatchedOn: match ? match.matchedOn : null,
      dictionaryAgrees: dictRow && dictRow.editable !== null ? dictRow.editable === field.editable : null,
    });
  }
  // Known-value matching: several dictionary-tracked fields render with NO preceding label at all, so no
  // amount of label-text matching above can ever connect them — CONFIRMED by user direction 2026-10-05 (real
  // Data Dictionary rows read directly): To Name/To Street Address/To City-State-Zip come straight from
  // whichever contact was picked as the Primary Recipient, and Copy Name/Copy Address/Copy City-State-Zip
  // from whichever contact was picked as the Additional Recipient — both already captured by this very
  // scenario (recipient/additionalRecipient, same { name, address, streetAddress, cityStateZip } shape
  // documentService.js returns for either). Comparing a still-unmatched field's own captured value against
  // these known values is a far more reliable key than a label that was never going to be there.
  assignByKnownValue(interactiveChecks, template.digNumber, [
    recipient && recipient.name && { attributeName: 'To Name', value: recipient.name },
    recipient && recipient.streetAddress && { attributeName: 'To Street Address', value: recipient.streetAddress },
    recipient && recipient.cityStateZip && { attributeName: 'To City, State, Zip', value: recipient.cityStateZip },
    additionalRecipient && additionalRecipient.name && { attributeName: 'Copy Name', value: additionalRecipient.name },
    additionalRecipient && additionalRecipient.streetAddress && { attributeName: 'Copy Address', value: additionalRecipient.streetAddress },
    additionalRecipient && additionalRecipient.cityStateZip && { attributeName: 'Copy City, State, Zip', value: additionalRecipient.cityStateZip },
    // Already scraped off the claim's own Parties Involved screen earlier this scenario (same value this
    // run's own console log already prints as "claimantName=..." — see runScenario) — sometimes undefined
    // when that screen's roles render blank (a pre-existing, unrelated capture gap), in which case this
    // entry is simply filtered out below, same graceful degradation as every other known-value source here.
    effectiveTestData && effectiveTestData.claimantName && { attributeName: 'Claimant Name', value: effectiveTestData.claimantName },
  ].filter(Boolean));

  const passedChecks = interactiveChecks.filter((c) => c.result === 'PASS').length;
  const failedChecks = interactiveChecks.filter((c) => c.result === 'FAIL').length;
  log(`interactive field checks: ${passedChecks} passed, ${failedChecks} failed (${interactiveChecks.length} total)` +
    (skippedUnselectedChoiceCount ? ` — ${skippedUnselectedChoiceCount} more field(s) skipped entirely (duplicate copies inside a non-selected Choices-panel option)` : ''));

  const dictionaryReference = dataDictionaryService.getAttributesForTemplate(template.digNumber)
    .map((a) => `${a.attributeName} (${a.templateAttributeName || 'n/a'}): editable=${a.editable === null ? 'unspecified' : a.editable}`);

  // Second pass: re-scan for any editable field that STILL doesn't carry one of our own edit markers —
  // catches anything the first pass missed (timing, or a field type inspectAndMaybeEdit has since learned to
  // handle). CONFIRMED live 2026-09-29 (DIG166, user-suggested): leaving even ONE required field unedited
  // doesn't just fail that one field — Complete Document rejects the whole submission and the editor reloads
  // back to its ORIGINAL unedited state, discarding every other field's edit too (a real user confirmed
  // manually filling every single field completes cleanly). Bounded to 3 rounds total (not per field) so a
  // field that's genuinely never going to accept an edit can't loop forever.
  //
  // CONFIRMED live 2026-10-06 (DIG200): `.nth(idx)` positional re-location, trusted here since
  // readMergeFields' own header documented it as stable "as long as the field COUNT and ORDER stay stable",
  // turned out to be the ROOT CAUSE of fields that looked permanently stuck — committing an edit can make
  // Thunderhead regenerate/re-split NEARBY spans (a field's content moving between one "th__split-line" piece
  // and two, or back), shifting what sits at a given numeric position without changing the total field COUNT
  // at all. A later retry round then grabbed whatever ucconnected, often already-resolved (frequently locked)
  // element now happened to occupy that position — confirmed by a live DOM dump showing a "retry" target
  // resolve to a locked address-continuation span that was never the intended field. Re-identifying each
  // stuck field by its own STABLE labelContext (the on-page text immediately before it — unaffected by a
  // DIFFERENT field's internal reflow, only by edits to text earlier in the SAME block) fixes this; position
  // is now only a same-editable-only fallback, specifically so a field that's now locked at the old position
  // (the exact drift symptom) is never wrongly mistaken for the real target.
  let retryRound = 0;
  // CONFIRMED live 2026-10-04 (DIG53): a field whose committed value shows up NOWHERE on the page afterward
  // (interactiveEditService's own `vanished` flag — a non-text-typed field silently rejecting free text, not
  // a timing fluke) can never pass by retrying the exact same fill-text strategy. Keyed by this field's OWN
  // position in `interactiveChecks` (stable — that array is built once, in order, during the first pass, and
  // never reordered) rather than by a live DOM idx, which is exactly what can no longer be trusted round to
  // round.
  const hopelessIdx = new Set();
  const normalizeLabelForRematch = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // The authoritative "what still needs work" list, driven entirely by OUR OWN interactiveChecks state (never
  // by a live DOM read) — same reasoning as the user-confirmed fix above it: trust what we already recorded,
  // don't re-derive it from a page that may have reflowed.
  function pendingRetryTargets() {
    return interactiveChecks
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => !hopelessIdx.has(i) && c.expectedEditable === true && c.result !== 'PASS');
  }
  let targets = pendingRetryTargets();
  while (targets.length && retryRound < 3) {
    retryRound += 1;
    const freshFields = await interactiveEditService.readMergeFields(frame);
    const claimed = new Set();
    const relocated = [];
    const stillMissing = [];
    for (const t of targets) {
      const wantLabel = normalizeLabelForRematch(t.c.labelContext);
      let field = wantLabel
        ? freshFields.find((f) => f.editable && !claimed.has(f.idx) && normalizeLabelForRematch(f.labelContext) === wantLabel)
        : null;
      if (!field) {
        // No labelContext to match on (or no match found) — fall back to the original position, but ONLY if
        // it's STILL editable there. A locked field at the old position is exactly the drift symptom, not a
        // legitimate same-field match.
        const positional = freshFields.find((f) => f.idx === t.i && !claimed.has(f.idx));
        if (positional && positional.editable) field = positional;
      }
      if (field) { claimed.add(field.idx); relocated.push({ field, target: t }); } else { stillMissing.push(t); }
    }
    log(`Second pass #${retryRound}: ${targets.length} editable field(s) still not edited (${relocated.length} relocated, ${stillMissing.length} could not be relocated this round) — retrying: ${relocated.map(({ target }) => `#${target.i + 1}`).join(', ')}`);
    for (const { field, target } of relocated) {
      const n2 = target.i + 1;
      const outcome = await interactiveEditService.inspectAndMaybeEdit(frame, page, field, { newValue: buildEditValue(field, n2, template.digNumber), log });
      const existing = target.c; // same object reference as interactiveChecks[target.i]
      if (outcome.attempted && outcome.changed) {
        existing.result = 'PASS';
        existing.observedChanged = outcome.changed;
        existing.after = outcome.after;
        existing.committedMarker = outcome.committedMarker;
        existing.reason = `Succeeded on retry pass #${retryRound} (first attempt: ${existing.reason || 'no popup opened'})`;
        log(`field #${n2}: retry pass #${retryRound} succeeded`);
      } else if (outcome.note) {
        existing.reason = `Still failing after retry pass #${retryRound}: ${outcome.note}`;
        if (outcome.vanished) {
          hopelessIdx.add(target.i);
          log(`field #${n2}: giving up after this attempt — value vanishes completely, not just a timing/retry issue.`);
        }
      }
    }
    targets = pendingRetryTargets();
  }
  if (retryRound) {
    const passedAfterRetry = interactiveChecks.filter((c) => c.result === 'PASS').length;
    const failedAfterRetry = interactiveChecks.filter((c) => c.result === 'FAIL').length;
    log(`interactive field checks after ${retryRound} retry pass(es): ${passedAfterRetry} passed, ${failedAfterRetry} failed (${interactiveChecks.length} total)`);
  }
  // `targets` here is the FINAL post-loop pendingRetryTargets() result — still-authoritative, driven by our
  // own interactiveChecks state, not a live DOM read. Genuinely unedited for THIS purpose either way: Complete
  // Document doesn't care why a field never got filled, only that it didn't.
  const trulyUneditedCount = targets.length + hopelessIdx.size;
  if (trulyUneditedCount) {
    log(`WARNING: ${trulyUneditedCount} editable field(s) remain unedited after ${retryRound} retry pass(es) (${hopelessIdx.size} given up on as unfillable, ${targets.length} still genuinely pending) — Complete Document will very likely fail and revert ALL edits (CONFIRMED live: even one unedited required field does this).`);
    if (process.env.DEBUG_STUCK_FIELD_HTML) {
      const stuckChecks = [...targets.map((t) => t.i), ...hopelessIdx].map((i) => ({ i, c: interactiveChecks[i] }));
      const freshFields = await interactiveEditService.readMergeFields(frame);
      const dumps = [];
      for (const { i, c } of stuckChecks) {
        const wantLabel = normalizeLabelForRematch(c.labelContext);
        const field = (wantLabel && freshFields.find((f) => normalizeLabelForRematch(f.labelContext) === wantLabel)) || freshFields[i];
        const html = field
          ? await field.locator.evaluate((el) => (el.closest('p, div, li, td, th') || el.parentElement).outerHTML.slice(0, 4000)).catch((e) => `(eval failed: ${e.message})`)
          : '(could not relocate this field in the current DOM at all)';
        dumps.push(`=== interactiveChecks #${i + 1} (label: "${c.label}") ===\n${html}`);
      }
      require('fs').writeFileSync(
        require('path').join(__dirname, '..', '..', 'results', 'smartComm', 'DEBUG_stuck_fields.html'),
        dumps.join('\n\n')
      );
      log(`DEBUG_STUCK_FIELD_HTML: dumped ${stuckChecks.length} stuck field(s) to results/smartComm/DEBUG_stuck_fields.html`);
    }
  }

  // CONFIRMED live 2026-09-30: skipping "Save Changes" (an earlier attempt to cut wall-clock time — Complete
  // Document looked like it should save-and-complete in one step) reliably reproduced INT5's own known
  // failure mode ("edit accepted in-editor but missing from the completed PDF") on EVERY scenario across two
  // templates, whereas that same field previously passed with Save Changes in the flow. Complete Document
  // evidently does not itself commit a pending field edit the way Save Changes does — Save Changes is back,
  // clicked before Complete Document, so an edit is actually persisted before the document is finalized.
  await interactiveEditService.saveChanges(page, { log });
  try {
    await interactiveEditService.completeDocument(page, { log, scenarioId: scenario.scenarioId });
  } catch (err) {
    // CONFIRMED live 2026-10-06 (DIG200, "Content is not allowed in prolog"): this throw previously lost
    // every field this scenario had already edited/validated up to this exact point — runScenario's own
    // catch block only had err.message to save, so a Complete-Document failure left NOTHING to diagnose WHY
    // beyond the raw ClaimCenter error text (not our own values, not which fields were touched). Attaching
    // the in-progress interactiveChecks (and choicesApplied) to the error itself lets the ERROR result still
    // carry them through to the saved report, instead of this scenario's whole edit history vanishing.
    err.interactiveChecks = interactiveChecks;
    err.choicesApplied = choicesApplied;
    throw err;
  }
  const identifier = await interactiveEditService.readDocumentPropertiesIdentifier(page);
  log(`Document Properties Identifier: ${identifier}`);

  // S3 is a fully separate origin/login from ClaimCenter (see s3AdminService.js) — `s3Session` (see
  // s3SessionManager.js) owns ONE browser context/page for it, reused across every scenario (and, when the
  // caller shares one across a whole bulk run, across every template too) instead of this function opening,
  // logging into and closing its own context every single time it runs — CONFIRMED live 2026-09-28 that
  // used to be necessary only because `page` here comes from the test spec's own `browser.newPage()`, which
  // internally "owns" its context (Playwright refuses `page.context().newPage()` on an owned context); a
  // genuinely separate context is still the right isolation, just one that now outlives a single call.
  const path = require('path');
  const fs = require('fs');
  return s3Session.withPage(async (s3Page) => {
    // CONFIRMED live 2026-10-07: the naive "take the first match" approach this used to use can silently grab
    // ClaimCenter's own document-indexing metadata object (same folder, same Identifier) instead of the real
    // PDF — see downloadFirstValidPdf's own header for the full story (12/12 scenarios across 4 templates,
    // 100% reproducible, not a flake).
    const pdfResult = await s3AdminService.downloadFirstValidPdf(s3Page, identifier, documentService.DOWNLOAD_DIR, { log });
    if (pdfResult.error) throw new Error(`INTERACTIVE_S3_NOT_FOUND: ${pdfResult.error}`);
    const finalPath = path.join(path.dirname(pdfResult.downloaded.localPath), `${fileNamePrefix}_interactive.pdf`);
    fs.renameSync(pdfResult.downloaded.localPath, finalPath);

    // CONFIRMED live 2026-09-30: the SAME identifier that finds the PDF above also resolves the ORIGINAL
    // payload ClaimCenter sent to SmartCOMM, under a different branch (Outbound > smartcomm > input) — this
    // replaces the Create tab's own "Download Payload" button for the Interactive flow, which is frequently
    // unavailable in this Test environment (CONFIRMED: 0/65 and 20/20 downloads succeeded via that button
    // across two full sweeps today), by fetching it here in the SAME S3 visit instead. A missing payload
    // still degrades gracefully — everything downstream already treats `payload`/`rawPayloadRoot` as
    // optional (BLOCKED dynamicValueMatch checks, no Xpath-derived checks), same as a failed button click did.
    let payload, rawPayloadRoot;
    try {
      const payloadMatches = await s3AdminService.searchSmartCommPayload(s3Page, identifier, { log });
      if (payloadMatches.length) {
        const payloadDownloaded = await s3AdminService.downloadMatches(s3Page, payloadMatches.slice(0, 1), documentService.DOWNLOAD_DIR, { log });
        const payloadFinalPath = path.join(path.dirname(payloadDownloaded[0].localPath), `${fileNamePrefix}_payload.xml`);
        fs.renameSync(payloadDownloaded[0].localPath, payloadFinalPath);
        payload = payloadService.parsePayloadFile(payloadFinalPath);
        rawPayloadRoot = payloadXpathService.parseRawPayloadFile(payloadFinalPath).ccDocumentCreationRequest;
      } else {
        log(`WARNING: no payload found under ClaimCenter Outbound > smartcomm > input for Identifier "${identifier}" — From Name/Phone/Email/Title and Xpath-derived checks will be BLOCKED for this scenario, same as a failed "Download Payload" button click.`);
      }
    } catch (err) {
      log(`WARNING: payload fetch from S3 failed (${err.message}) — continuing without it, same graceful degradation as a failed "Download Payload" button click.`);
    }

    // Known-value matching, part 2: the 'From' contact's name/phone/email/title (signature block) ALSO
    // renders with no preceding label (same reasoning as the recipient/additionalRecipient pass above), but
    // this one can only run here — payload.from isn't available until the payload is fetched, just above.
    // Underwriting Company and Date of Loss join this same pass per user direction 2026-10-05 (Underwriting
    // Company: Policy > General screen; Date of Loss: claim Summary/Overview screen) — both already parsed
    // onto `payload` by payloadService.js for the data-capture cross-check, so no new parsing needed here.
    if (payload) {
      assignByKnownValue(interactiveChecks, template.digNumber, [
        payload.from && payload.from.name && { attributeName: 'From Name', value: payload.from.name },
        payload.from && payload.from.phone && { attributeName: 'From Phone', value: payload.from.phone },
        payload.from && payload.from.email && { attributeName: 'From Email', value: payload.from.email },
        payload.from && payload.from.title && { attributeName: 'From Title', value: payload.from.title },
        payload.underwritingCompany && { attributeName: 'Underwriting Company', value: payload.underwritingCompany },
        payload.lossDate && { attributeName: 'Date of Loss', value: payload.lossDate },
      ].filter(Boolean));
    }

    // The Data Dictionary is the source of truth (per user direction 2026-10-05), which cuts both ways:
    //   1. A field the editor was internally self-consistent about (CSS class said editable, the edit
    //      worked; or CSS said locked, it correctly resisted) still used to PASS even when the dictionary's
    //      own Column G disagreed with that observed behavior — that hid a real defect behind a green PASS
    //      (CONFIRMED live: "Insured Name" editable when the dictionary says it must be locked, on 3+
    //      templates). Now FAILs instead, since the dictionary outranks the editor's own self-consistency.
    //   2. The reverse also matters: a field with NO tracked dictionary row at all (never matched, or
    //      matched a row whose own Column G is blank/unspecified) has nothing to validate it AGAINST — the
    //      editor's self-consistency PASS/FAIL computed above for it isn't checking against any real
    //      requirement, just noise, and this field's own CONTENT/value (if it has one worth checking) is
    //      already covered separately by the template's own BA-comment-driven requirement checks, not here.
    //      SKIPPED instead, not a pass or a fail — except an EDITABLE unmatched field still gets flagged
    //      with its own note (not a failure) so a human can glance at whether that's expected, since nothing
    //      else in this tool will ever look at it otherwise.
    // Both run here, now that every known-value/label matching pass above has had its chance to run, so this
    // reflects the FINAL dictionary attribution, not a partial one from mid-way through matching.
    for (const c of interactiveChecks) {
      if (!c.dictionaryField || c.dictionaryEditable === null) {
        c.result = 'SKIPPED';
        c.reason = c.expectedEditable
          ? 'This field is editable in the live session but could not be matched to any tracked Data Dictionary row (or that row\'s own editability is unspecified) — not counted as a pass or fail; please validate manually whether this is expected.'
          : 'No tracked Data Dictionary row (with a stated editability) matched this field — not validated here; this field\'s own content/value, if any, is already covered by the template\'s own requirement checks.';
      } else if (c.dictionaryAgrees === false) {
        c.result = 'FAIL';
        c.reason = `Data Dictionary says "${c.dictionaryField}" should be ${c.dictionaryEditable ? 'editable' : 'locked'}, but the live document has it ${c.expectedEditable ? 'editable' : 'locked'} — the dictionary is the source of truth, so this is a genuine defect, not just an internal inconsistency.`;
      }
      // Flag an exact-name-but-unscoped match distinctly (per user direction 2026-10-05) — the match itself
      // is trusted (see findExactMatchAnyScope/getAttributeByExactName), but the dictionary's own Form(s)
      // column hasn't caught up for this DIG, which a reviewer going back to the spreadsheet should know.
      if (c.dictionaryMatchedOn && c.dictionaryMatchedOn.endsWith('Unscoped')) {
        const note = `Matched "${c.dictionaryField}" by exact name only — this DIG isn't yet listed in that row's own Form(s) column in the dictionary; consider updating the dictionary.`;
        c.reason = c.reason ? `${c.reason} ${note}` : note;
      }
    }

    const disagreements = interactiveChecks.filter((c) => c.dictionaryAgrees === false);
    if (disagreements.length) {
      log(`WARNING: ${disagreements.length} field(s) where the Data Dictionary's editability disagrees with what the editor actually enforces: ` +
        disagreements.map((c) => `${c.label} (dictionary=${c.dictionaryEditable ? 'Yes' : 'No'}, observed=${c.expectedEditable ? 'editable' : 'locked'})`).join('; '));
    }

    // Top-down reconciliation: this template's own BA comments name specific business fields with a real
    // editability opinion (Column G) — the REVERSE direction from the per-field loop above, which started from
    // whatever the live editor happened to render and tried to guess a dictionary row for it. A tracked field
    // that no live DOM field above ever claimed (dictionaryField never got set to its name) is a real finding
    // in its own right — the live editor may genuinely be missing it, OR the matching above still couldn't
    // connect it — either way it's unverified, and silently dropping it (the old behavior: only loop over what
    // the editor found) hid that. CONFIRMED live 2026-10-05 (DIG53): doing this surfaced that only 2 of 27 live
    // fields had EVER been connecting to a dictionary row before the matching fixes above, even though the
    // template's own comments name 13 real tracked business fields for this one template.
    const trackedFields = dataDictionaryService.getTrackedFieldsForTemplate(template.digNumber, commentFieldNames || []);
    const matchedRowNames = new Set(interactiveChecks.map((c) => c.dictionaryField).filter(Boolean));
    // A "Foo?: Yes/No"-style tracked field (e.g. "Apply Medical Letterhead?") is a right-hand Choices-panel
    // radio, not an inline merge field at all (see selectAllYesNoChoices above) — it will never appear among
    // interactiveChecks no matter how good the matching gets, but it WAS already verified (choicesApplied),
    // just through that separate mechanism. Reporting it as "could not be located" would be a false alarm.
    const choiceVerifiedNames = new Set((choicesApplied || []).map((label) => dataDictionaryService.normalizeForMatch(label.split(':')[0])));
    const unmatchedTrackedFields = trackedFields.filter((t) =>
      !matchedRowNames.has(t.row.attributeName) && !choiceVerifiedNames.has(dataDictionaryService.normalizeForMatch(t.row.attributeName)));
    if (unmatchedTrackedFields.length) {
      log(`WARNING: ${unmatchedTrackedFields.length} of ${trackedFields.length} dictionary-tracked field(s) (named in this template's own BA comments) could not be located among the ${interactiveChecks.length} live editor field(s) found this run — their editability could not be verified: ` +
        unmatchedTrackedFields.map((t) => `${t.row.attributeName} (dictionary=${t.row.editable ? 'Yes' : 'No'})`).join('; '));
    }

    return { pdfPath: finalPath, interactiveChecks, dictionaryReference, payload, rawPayloadRoot, choicesApplied, trackedFields, unmatchedTrackedFields };
  });
  } finally {
    stopLivePreview();
  }
}

// interactiveEditService.inspectAndMaybeEdit only proves the EDITOR accepted an edit (a new span with the
// new value appeared in that iframe's DOM at edit time) — it says nothing about whether that edit actually
// survived Save Changes / Complete Document / SmartCOMM's own rendering into the final PDF that gets
// downloaded from S3. Re-checks each edit that the editor reported as successful against the REAL PDF text
// and downgrades any that didn't make it through to a genuine FAIL, so this tool can no longer report an
// edit as verified purely on the editor's own say-so (closing the gap flagged 2026-09-29: "validate
// downloaded copy to ensure the edit performed in interactive session matches with downloaded PDF").
// A date-shaped `before` value is a plausible, NOT YET CONFIRMED explanation for several of these — worth
// flagging distinctly rather than lumping in with every other "accepted in editor but missing from PDF"
// case, since a date-type field would plausibly reformat/reject a literal non-date marker like "[QA-EDIT-2]"
// at some later validation stage even though the live editor accepted it. Scoped to JUST improving the
// diagnostic message: no behavior change here, since this hasn't been live-verified the way the checkbox
// fields' "vanishes completely" signature was — changing the actual test VALUE for suspected date fields
// without confirming that's really the mechanism risks fixing nothing while adding untested complexity.
const DATE_SHAPED_RE = /\d{1,2}\/\d{1,2}\/\d{2,4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/i;

function verifyInteractiveEditsInPdf(interactiveChecks, pdfText, log) {
  if (!interactiveChecks || !interactiveChecks.length) return;
  const haystack = pdfValidationService.normalizeWs(pdfText).toLowerCase();
  for (const c of interactiveChecks) {
    // Checks the raw observed fact (an edit genuinely took), not `result` — which, since the Data
    // Dictionary reclassification above, no longer means "this field was successfully edited" for an
    // unmatched field (SKIPPED there instead of PASS, see runInteractiveGeneration). Whether a real edit
    // survived into the PDF is still worth verifying regardless of dictionary-tracking status.
    if (c.observedChanged !== true || c.expectedEditable !== true) continue;
    // `committedMarker` (the plain, undecorated value actually typed — e.g. "[QA-EDIT-2]") is the right
    // needle here, NOT `after` (the live editor's own display text, which CONFIRMED live double-wraps an
    // already-bracketed value in its own UI decoration — "[[QA-EDIT-2]]" — that never actually appears in
    // the rendered PDF and would false-FAIL every real, successful edit). See interactiveEditService.js's
    // inspectAndMaybeEdit for the full explanation.
    const needle = pdfValidationService.normalizeWs(c.committedMarker || c.after || '').toLowerCase();
    const found = !!needle && haystack.includes(needle);
    c.verifiedInPdf = found;
    if (!found) {
      const looksLikeDate = DATE_SHAPED_RE.test(c.before || '');
      const note = `Edit was accepted in the interactive editor (showed "${c.after}") but this text was NOT found anywhere in the downloaded, completed PDF — the edit did not survive into the final document.` +
        (looksLikeDate ? ` This field's original value ("${c.before}") looks date-shaped — a synthetic non-date marker may get silently reformatted/rejected downstream even though the editor accepted it; worth checking with a real date-shaped test value instead.` : '');
      // A dictionary-tracked field with a stated expectation: this is a genuine, reportable defect — FAIL.
      // An unmatched field (SKIPPED by the Data Dictionary reclassification above, nothing to validate it
      // against): still worth knowing the edit didn't stick, but stays SKIPPED per user direction — appended
      // to its existing note rather than reported as a failure.
      if (c.dictionaryField && c.dictionaryEditable !== null) {
        c.result = 'FAIL';
        c.reason = note;
      } else {
        c.reason = `${note} (${c.reason})`;
      }
      log(`WARNING: ${c.id} ${c.label} — edit accepted in-editor but missing from the completed PDF (expected "${c.committedMarker || c.after}")${looksLikeDate ? ' [date-shaped field]' : ''}`);
    }
  }
}

// A requirement whose field was just intentionally overwritten with a "[QA-EDIT-n]" marker as part of the
// interactive edit test will legitimately not find the real value (it's gone on purpose) — that is NOT a
// template defect, so it doesn't belong in the FAIL count, and "Not Found" is misleading when the field
// plainly does have a value, just not the expected one. Re-point Actual at what's really there and reclassify
// as SKIPPED (same status already used elsewhere for "not applicable to this run", not a content problem).
// Only reaches an edit already CONFIRMED (via verifyInteractiveEditsInPdf, above) to be in the real PDF —
// an edit that didn't survive stays a genuine FAIL instead of being explained away.
function annotateInteractiveEditFailures(validations, interactiveChecks) {
  // Checks the raw observed facts (a real edit, confirmed present in the PDF by verifyInteractiveEditsInPdf
  // above), not `result` — which no longer means "successfully edited" for an unmatched field (SKIPPED by
  // the Data Dictionary reclassification regardless of whether its edit survived, per user direction), so a
  // dictionary-unmatched-but-genuinely-edited-and-verified field still needs to be excluded from the FAIL
  // count below exactly like a tracked one would be.
  const edited = (interactiveChecks || []).filter((c) => c.observedChanged === true && c.verifiedInPdf === true && c.expectedEditable === true);
  if (!edited.length) return;
  // CONFIRMED live 2026-10-07 (DIG226): matching only on the field's display label appearing inside the
  // requirement's description missed most real overwrites — label-less fields (Claimant Name printed after
  // "Employee:", and the Copy Name/Address/City block, identified only later by known-value matching) never
  // have a label that appears in "Value for "Copy Name" must match additionalRecipient.name". The field's own
  // ORIGINAL pre-edit value (`before`) is the reliable link: it's exactly what that requirement expected to
  // find before we overwrote it. Containment both ways, since one requirement's expected value can span
  // several separately-editable fields (e.g. "BIRMINGHAM, MI 48009-6571" = city + state + zip fields).
  const minLen = 4;
  for (const v of validations) {
    if (v.result !== 'FAIL') continue;
    const desc = (v.description || '').toLowerCase();
    const expectedNorm = normForKnownValueMatch(v.expected);
    const hits = edited.filter((c) => {
      if (c.label && desc.includes(c.label.toLowerCase())) return true;
      if (c.dictionaryField && desc.includes(`"${c.dictionaryField.toLowerCase()}"`)) return true;
      const beforeNorm = normForKnownValueMatch(c.before);
      return expectedNorm.length >= minLen && beforeNorm.length >= minLen
        && (expectedNorm.includes(beforeNorm) || beforeNorm.includes(expectedNorm));
    });
    if (!hits.length) continue;
    // committedMarker is the plain value actually typed; `after` carries the live editor's own extra bracket
    // decoration ("[[QA-EDIT-18]]") that never appears in the real PDF.
    const editedValue = hits.map((h) => h.committedMarker || h.after).join(' ');
    v.actual = editedValue;
    v.result = 'SKIPPED';
    v.intentionalEdit = true; // report renderers: still show Expected/Actual for this one, unlike a plain SKIPPED
    v.reason = `Intentionally overwritten with "${editedValue}" (${hits.map((h) => h.id).join(', ')}) as part of the interactive-editable-field test (see the Interactive Session section) — not a template defect.${v.reason ? ` (Original reason: ${v.reason})` : ''}`;
  }
}

// Builds the fraud-language check(s) for one scenario, using the CLAIM's own
// live lossState/lossType/lossCauseName (from the payload — ground truth for
// THIS generation, not the test-data record) to resolve the real required
// wording via fraudLanguageService. Checks the loss state's language always;
// if the policy's own (best-effort proxy) state differs from the loss state,
// ALSO checks that state's language appears — per user direction, a document
// should carry fraud language for both when they differ. Either lookup
// resolving to nothing (state not in the sheet, or no condition matched)
// naturally reports BLOCKED via pdfValidationService's existing
// dynamicValueMatch handling — no special-casing needed here.
// A matched row whose Fraud Language column is literally "None" means the
// BA/legal team determined that state genuinely requires no fraud warning
// text at all (CONFIRMED: 10 states — CA/HI/IL/IA/MI/NE/NC/SC/SD/WI — all
// carry an explicit "None" row rather than simply having no row) — that's a
// real, meaningful "nothing to check here", not a value to search the PDF
// for literally. Treated the same as "no match" (the check is omitted
// entirely) rather than a false FAIL/BLOCKED either way.
function isNoFraudLanguageRequired(match) {
  return !match || /^none$/i.test(match.fraudLanguage.trim());
}

// Builds one "requiredText" check per Data Dictionary row applicable to this template (Column E) that has an
// Xpath (Column H), resolves to a real value against THIS scenario's own real payload, AND is a field the
// TEMPLATE'S OWN requirement set (baseRequirements — the BA's Word-doc comments, see
// templateRequirementService.buildRequirementsFromComments) actually references — genuine ClaimCenter ground
// truth via payloadXpathService, cross-checked against fields this template's own author actually claims to
// use, not every Column-E-applicable row regardless of whether this specific template ever mentions it.
//
// CONFIRMED live 2026-09-30 (DIG52): without this cross-reference, dictionary rows like "Policy Number" and
// "Claim Rep Name" — which DIG52's own Word doc never comments on anywhere — still generated an XP check,
// which then always failed "Not Found" since a short contact letter like this one was never going to print
// them; not a real defect, just an over-broad check the template's own spec never asked for. Restricting to
// fields the template's own R-rows reference (matched by Column A "Attribute Name"/Column B "Template
// Attribute Name" appearing inside an R-row's raw BA-comment `fieldName` text — same substring-match idea as
// dataDictionaryService.matchAttributeForField, just in the opposite direction: a short dictionary name
// found inside a longer prose comment, not the other way around) keeps a field like "Agent Number" in scope
// (DIG52's own R31 comes from a real BA comment naming it — its own "Not Found" is a genuine template-vs-
// render discrepancy worth a human's attention) while dropping ones the template's spec never mentions.
//
// Naturally self-scoping beyond that too: a field that's in scope here but genuinely irrelevant to this
// claim's LOB (e.g. Vehicle Make on a Homeowners claim, which has no exposure/vehicle node at all) simply has
// nothing to resolve, so no check gets generated for it either — only fields with REAL, resolved data AND a
// real template reference become an assertion.
function buildXpathRequirements(template, rawPayloadRoot, baseRequirements, interactiveChecks, log) {
  const templateFieldNames = (baseRequirements || [])
    .map((r) => dataDictionaryService.normalizeForMatch(r.fieldName))
    .filter(Boolean);
  const referencedByTemplate = (row) => {
    const attrNorm = dataDictionaryService.normalizeForMatch(row.attributeName);
    const tmplAttrNorm = dataDictionaryService.normalizeForMatch(row.templateAttributeName);
    return templateFieldNames.some((fn) =>
      (attrNorm && attrNorm.length >= 3 && fn.includes(attrNorm)) ||
      (tmplAttrNorm && tmplAttrNorm.length >= 3 && fn.includes(tmplAttrNorm)));
  };
  const rows = dataDictionaryService.getAttributesForTemplate(template.digNumber)
    .filter((r) => r.xpath && r.xpath.trim())
    .filter(referencedByTemplate);
  const requirements = [];
  let n = 0;
  let fieldScoped = 0;
  for (const row of rows) {
    const result = payloadXpathService.resolveXpath(rawPayloadRoot, row.xpath);
    if (result.unsupported || result.value === undefined || result.value === '') continue;
    n += 1;
    // CONFIRMED live 2026-09-30 (user direction): for an Interactive template, this SAME field was already
    // captured individually during the editing session (interactiveChecks — each entry's own
    // committedMarker/after/before IS that field's real, specific rendered value, matched to this exact
    // dictionary row via dictionaryField). Comparing against THAT one field's own value, instead of
    // searching the whole PDF text for the expected value anywhere, is a precise field-to-field check rather
    // than a presence-anywhere-in-the-document one — falls back to the whole-document search (same as
    // before) whenever no matching interactive field was found, which keeps On-Demand templates (no
    // interactiveChecks at all) and any field the interactive-side matcher didn't identify working exactly
    // as before.
    //
    // CONFIRMED live 2026-09-30 (DIG52, "Insured Name"): excludes a field this SAME run deliberately edited
    // (observedChanged === true) — inspectAndMaybeEdit intentionally overwrites every editable field with a
    // "[QA-EDIT-N]" marker purely to verify the editor itself accepts edits, so a match on THAT field's own
    // committed value is comparing the test's own injected marker against the payload's real value, which
    // will always mismatch for reasons that have nothing to do with the document being wrong. Falls back to
    // the whole-document search instead, same as no match at all — correct for an edited field since the
    // real, pre-edit value this Xpath expects should still appear elsewhere (e.g. the letterhead, signature
    // block) even though this one specific editable merge field no longer shows it.
    const matchedCheck = (interactiveChecks || []).find((c) => c.dictionaryField === row.attributeName && c.observedChanged !== true);
    if (matchedCheck) fieldScoped += 1;
    // This run's OWN interactive-field check overwrote this exact attribute (observedChanged===true) even
    // though it's excluded from matchedCheck above — if the fallback whole-document search below still can't
    // find the original value anywhere, pdfValidationService needs to know it was this test's own edit that
    // did that, not a real template defect (per user direction 2026-10-06, DIG236).
    const editedByTest = (interactiveChecks || []).some((c) => c.dictionaryField === row.attributeName && c.observedChanged === true);
    requirements.push({
      id: `XP${n}`,
      description: `Value for "${row.attributeName}" must match the SmartCOMM payload (via Data Dictionary Xpath)`,
      type: matchedCheck ? 'fieldValueMatch' : 'requiredText',
      expectedValue: String(result.value),
      fieldValue: matchedCheck ? (matchedCheck.committedMarker || matchedCheck.after || matchedCheck.before) : undefined,
      fieldLabel: matchedCheck ? matchedCheck.label : undefined,
      wasEditedByTest: !matchedCheck && editedByTest,
      docOrder: Number.MAX_SAFE_INTEGER,
    });
  }
  if (requirements.length) log(`${requirements.length} additional expected-value check(s) built from the Data Dictionary's Xpath column against this scenario's real payload (scoped to fields this template's own requirements reference${fieldScoped ? `; ${fieldScoped} compared directly against their own captured interactive field value` : ''}).`);
  return requirements;
}

function buildFraudLanguageRequirements(payload) {
  const { lossState, lossType, lossCauseName, policyState } = payload;
  const lossMatch = fraudLanguageService.getExpectedFraudLanguage(lossState, { lob: lossType, lossCauseName });

  const requirements = [];
  const context = {};
  const details = {};
  const conditionNote = (m) => (m ? ` — Fraud Language sheet row: "${m.conditions || 'All'}"` : '');
  const statesDiffer = policyState && lossState && policyState !== lossState;
  const policyMatch = statesDiffer ? fraudLanguageService.getExpectedFraudLanguage(policyState, { lob: lossType, lossCauseName }) : null;
  const requiredWording = (m) => (m && !isNoFraudLanguageRequired(m) ? [m.fraudLanguage] : []);

  // Per user direction 2026-10-07 (DIG120B, MI): a "None" state used to drop the fraud check silently, so the
  // report gave no sign it was evaluated at all. Now an explicit check that the document prints NO fraud
  // wording for that state (aside from wording the other state on the claim genuinely requires).
  if (lossMatch && isNoFraudLanguageRequired(lossMatch)) {
    requirements.push({
      id: 'FL1',
      description: `No fraud language for loss state (${lossState}, loss type ${lossType || 'unknown'}) — Fraud Language sheet says "None"${conditionNote(lossMatch)}`,
      type: 'fraudLanguageAbsent',
      stateLabel: `${lossMatch.stateName} [${lossMatch.conditions || 'All'}]`,
      allowedFraudLanguage: requiredWording(policyMatch),
      docOrder: Number.MAX_SAFE_INTEGER,
    });
  }

  if (!isNoFraudLanguageRequired(lossMatch) || !lossMatch) {
    // Still emit the check even when lossMatch is null (state not in the
    // sheet / no condition matched) - that case SHOULD show as BLOCKED
    // ("presence not verified"), distinct from a confirmed "None" required.
    requirements.push({
      id: 'FL1',
      description: `Fraud language for loss state (${lossState || 'unknown'}, loss type ${lossType || 'unknown'}) must appear${conditionNote(lossMatch)}`,
      type: 'dynamicValueMatch',
      expectedSource: 'fraudLanguage.lossStateText',
      docOrder: Number.MAX_SAFE_INTEGER,
    });
    context.lossStateText = lossMatch ? lossMatch.fraudLanguage : undefined;
    details.FL1 = { state: lossState, lossType, match: lossMatch };
  }

  if (statesDiffer) {
    if (policyMatch && isNoFraudLanguageRequired(policyMatch)) {
      requirements.push({
        id: 'FL2',
        description: `No fraud language for policy state (${policyState}) — Fraud Language sheet says "None" (loss state ${lossState} and policy state ${policyState} differ)${conditionNote(policyMatch)}`,
        type: 'fraudLanguageAbsent',
        stateLabel: `${policyMatch.stateName} [${policyMatch.conditions || 'All'}]`,
        allowedFraudLanguage: requiredWording(lossMatch),
        docOrder: Number.MAX_SAFE_INTEGER,
      });
    } else {
      requirements.push({
        id: 'FL2',
        description: `Fraud language for policy state (${policyState}) must also appear (loss state ${lossState} and policy state ${policyState} differ)${conditionNote(policyMatch)}`,
        type: 'dynamicValueMatch',
        expectedSource: 'fraudLanguage.policyStateText',
        docOrder: Number.MAX_SAFE_INTEGER,
      });
      context.policyStateText = policyMatch ? policyMatch.fraudLanguage : undefined;
      details.FL2 = { state: policyState, lossType, match: policyMatch };
    }
  }

  return { requirements, context, details };
}

// A failed FL check used to read just "Not Found … either genuinely missing or
// the test-data value doesn't match", even when the document DID carry fraud
// language — just a different Fraud Language sheet row than this claim's
// state/loss type requires (CONFIRMED live: DIG52 prints Pennsylvania's
// "Loss Type = Auto" wording on Property/GL claims too, which the sheet says
// need the "not equal to Auto" wording). Say which wording was actually found.
function explainFraudLanguageFailures(validations, pdfText, details) {
  const found = fraudLanguageService.findFraudLanguageInText(pdfText);
  const printed = fraudLanguageService.extractFraudLanguageFromText(pdfText);
  for (const v of validations) {
    // Only the presence checks carry `details`; a "None"-state absence check already explains itself.
    if (!/^FL[12]$/.test(v.id || '') || v.result !== 'FAIL' || !details[v.id]) continue;
    const d = details[v.id];
    const label = (r) => `${r.stateName} [${r.conditions || 'All'}]`;
    const required = `${d.state || 'state'}, loss type ${d.lossType || 'unknown'} → ${d.match ? label(d.match) : 'n/a'}`;
    // Actual = the fraud wording exactly as printed in the PDF.
    v.actual = printed || 'No fraud language found in the document';
    if (!printed) {
      v.reason = `The generated document contains no fraud-warning wording at all. Required for this claim: ${required}.`;
    } else if (found.length) {
      v.reason = `Fraud language IS printed (see Actual), but it is the sheet's ${found.map(label).join(' ; ')} wording, not the one required for this claim (${required}). ` +
        `The template likely prints one fixed wording rather than choosing by state/loss type.`;
    } else {
      v.reason = `Fraud language IS printed (see Actual) but its text matches no row of the Fraud Language sheet, and differs from the wording required for this claim (${required}).`;
    }
  }
}

function aggregateTemplateResult(template, scenarioResults, sourceFile) {
  const passed = scenarioResults.filter(s => s.status === 'PASS').length;
  const failed = scenarioResults.filter(s => s.status === 'FAIL').length;
  const blocked = scenarioResults.filter(s => s.status === 'BLOCKED').length;
  const errored = scenarioResults.filter(s => s.status === 'ERROR').length;
  let overall = 'PASS';
  if (errored > 0) overall = 'ERROR';
  else if (failed > 0) overall = 'FAIL';
  else if (blocked > 0) overall = 'BLOCKED';
  return {
    digNumber: template.digNumber,
    templateName: template.documentName,
    scenarios: scenarioResults,
    scenarioCount: scenarioResults.length,
    passed, failed, blocked, errored, overall,
    sourceFile, // the template's own local .docx — reportService attaches it alongside each scenario's generated PDF
  };
}

function blockedTemplateResult(dig, reason, template) {
  console.log(`[SmartComm] BLOCKED template ${dig}: ${reason}`);
  return {
    digNumber: dig,
    templateName: template ? template.documentName : dig,
    scenarios: [], scenarioCount: 0, passed: 0, failed: 0, blocked: 1, errored: 0,
    overall: 'BLOCKED', reason,
  };
}

module.exports = { validateTemplate };
