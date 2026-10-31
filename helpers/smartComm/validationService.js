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
const fs = require('fs');
const path = require('path');
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
const synonyms = require('./fieldLabelSynonyms');
const interactiveEditService = require('./interactiveEditService');
const layoutValidationService = require('./layoutValidationService');
const s3AdminService = require('../s3Download/s3AdminService');
const { createS3SessionManager } = require('../s3Download/s3SessionManager');
const { loginAsAdmin, loginAsUser, openExistingClaim } = require('../claimCenterBase');

async function validateTemplate(page, { digNumber, recipientEmail, claimNumberOverride, interactive, singleScenario, s3Session } = {}) {
  const dig = catalogService.normalizeDig(digNumber);
  const template = catalogService.getTemplate(dig);
  if (!template) {
    return blockedTemplateResult(dig, `Template "${dig}" was not found in the SmartCOMM catalog (Claims_Documents_Index.xlsx)`);
  }

  const { requirements, sourceFile, mode, mentionsFraudLanguage, freeFormFields = [] } = await templateRequirementService.getRequirements(template, catalogService.DATA_DIR);
  // Overlay forms (catalog Overlay = "Yes", e.g. DIG150MIC): the mapping doc is scanned page images — no text,
  // so no static-wording requirements can be derived (CONFIRMED 2026-10-14: DIG150MIC's .docx has 0 text runs,
  // only images). They're still validated on DATA: every Data Dictionary field with an Xpath for this DIG is
  // checked against the real payload and the generated PDF (buildXpathRequirements, unscoped), plus the
  // archive filing metadata. The earlier "Invalid PDF structure" was the pre-archive download grabbing the
  // filing .json instead of the PDF (results/smartComm/downloads, 2026-10-07: a 176-byte JSON) — fixed since.
  if (!requirements.length && template.overlay === 'Yes') {
    template.overlayMode = true;
    console.log(`[SmartComm] ${dig}: overlay form — mapping doc has no text, so validating data fields (Data Dictionary Xpaths vs payload/PDF) and filing metadata only; static wording isn't checked.`);
  } else if (!requirements.length) {
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
    // flagged clearly and immediately instead. (Superseded 2026-10-14: overlay forms now run in data-only mode — see above.)
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
  // Interactive documents are fetched from S3's transient archive — sign in now, in parallel with the
  // ClaimCenter steps, so the watch is live before Complete Document (see s3SessionManager.warmUp).
  if (s3Session.warmUp) s3Session.warmUp(); // On-Demand too: some of those land in S3 instead of the results grid

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
        scenarioResults[i] = await runScenario(workerPage, { template, scenario: scenarios[i], requirements, recipientEmail, variant, mentionsFraudLanguage, freeFormFields, interactive, s3Session, sourceFile });
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

// One EDITn row per field the interactive test edited, checked on its own (per user direction 2026-10-17 — the
// content/payload rows only compared a field's pre-edit value when they FAILED, so a value repeated elsewhere in the
// letter hid a wrong field):
//   1. its label in the editor appears in the mapping doc (a leading "Our" tolerated, as for R2-style labels);
//   2. BEFORE the edit it showed the real value — the recipient / claim data, else the Data Dictionary's payload value;
//   3. AFTER the edit the edited value is in the completed PDF (verifyInteractiveEditsInPdf).
// FAIL if any fails; BLOCKED when there's no ClaimCenter/payload value to compare the pre-edit value with.
function buildEditedFieldChecks(interactiveChecks, { rawPayloadRoot, payload, recipient, additionalRecipient, testData, digNumber, sourceFile, requirements }) {
  const edited = (interactiveChecks || []).filter((c) => c.observedChanged === true);
  if (!edited.length) return [];
  const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const docCompact = compact(`${mappingDocText(sourceFile)} ${(requirements || []).map((r) => [r.expectedValue, r.sampleValue].filter(Boolean).join(' ')).join(' ')}`);
  const td = testData || {};
  const known = {
    'To Name': recipient && recipient.name, 'To Street Address': recipient && recipient.streetAddress, 'To City, State, Zip': recipient && recipient.cityStateZip,
    'Copy Name': additionalRecipient && additionalRecipient.name, 'Copy Address': additionalRecipient && additionalRecipient.streetAddress, 'Copy City, State, Zip': additionalRecipient && additionalRecipient.cityStateZip,
    'Claimant Name': td.claimantName, 'Insured Name': td.insuredName, 'Claim Number': td.claimNumber, 'Date of Loss': td.lossDate,
    'Loss Location': td.lossLocation, 'Underwriting Company': td.underwritingCompany,
  };
  const dictRows = dataDictionaryService.getAttributesForTemplate(digNumber) || [];
  const claim = (rawPayloadRoot && rawPayloadRoot.claim) || {};
  // The claim's own values, for a field with no dictionary source whose pre-edit value is one of them.
  const knownValues = [
    ['insured name', td.insuredName], ['claimant name', td.claimantName], ['claim number', td.claimNumber], ['loss location', td.lossLocation],
    ['underwriting company', td.underwritingCompany], ['recipient', recipient && recipient.name],
    ['policy number', claim.policy && claim.policy.policyNumber], ['policy type', claim.policy && claim.policy.policyType && claim.policy.policyType.name],
    ['loss type', claim.lossType && claim.lossType.name], ['loss description', claim.description],
  ].filter(([, v]) => v && String(v).trim().length >= 3).map(([name, value]) => ({ name, value: String(value) }));
  const exposures = [].concat(claim.exposures || []).flatMap((x) => (x && x.exposures ? [].concat(x.exposures) : [x])).filter(Boolean);
  const nameOf = (o) => (o && (o.name || (typeof o === 'string' ? o : ''))) || '';
  const addr = additionalRecipient || {};
  // The real value(s) a field must have shown before the edit. `values` may hold several acceptable values (a CC line is
  // one of the additional recipient's name/street/city; an exposure-type cell one of the claim's exposure types).
  const sourceOf = (c, label) => {
    const field = c.dictionaryField;
    const one = (value, from) => (value ? { values: [String(value)], value: String(value), from } : null);
    // A field whose own technical name says it's the additional recipient's ("current_additionalRecipients_ext.
    // primaryAddress.state.code" → "[DE]") is that recipient's, whatever dictionary row it was paired with — DIG57's was
    // judged against "Claimant Name" (false FAIL, QA review 2026-10-26).
    if (/additionalRecipient/i.test(c.technicalName || '')) {
      const vals = [addr.name, addr.streetAddress, addr.cityStateZip, ...String(addr.cityStateZip || '').split(/[\s,]+/)].filter(Boolean).map(String);
      if (vals.length) return { values: vals, value: vals.slice(0, 3).join(' / '), from: 'ClaimCenter (additional recipient)' };
    }
    if (field && known[field]) return one(known[field], 'ClaimCenter');
    if (/^underco$/i.test(c.technicalName || '')) return one(td.underwritingCompany, 'ClaimCenter'); // signature-block company
    // CC block: the Data Dictionary's "CC" / "Copy …" rows, or a field whose technical name is the additional
    // recipient's ("current_additionalRecipients_ext.primaryAddress.state" — DIG242's "[VA]").
    if (field === 'CC' || /^copy\b/i.test(field || '') || /additionalRecipient/i.test(c.technicalName || '')) {
      const vals = [addr.name, addr.streetAddress, addr.cityStateZip, ...String(addr.cityStateZip || '').split(/[\s,]+/)].filter(Boolean).map(String);
      if (vals.length) return { values: vals, value: vals.slice(0, 3).join(' / '), from: 'ClaimCenter (additional recipient)' };
    }
    // Exposure type cells: the dictionary's "Type" / "Exposure Type" rows (DIG26), or a label/description naming the
    // exposure TYPE ("…under expsousre/ type") — not any text that merely mentions an exposure (DIG219's "Primary
    // Doctor field on the exposure" is a provider field).
    if ((/^(exposure\s+)?type$/i.test(field || '') || /exp\w*\s*\/?\s*type/i.test(`${field || ''} ${c.label || ''}`)) && exposures.length) {
      const vals = [...new Set(exposures.flatMap((e) => [nameOf(e.type), nameOf(e.coverageSubtype), nameOf(e.primaryCoverage)]).filter(Boolean))];
      if (/line of business/i.test(label)) return one(nameOf(claim.lossType) || nameOf(claim.lobCode), 'payload');
      return { values: vals, value: vals.join(' / '), from: 'payload (exposures)' };
    }
    if (/^line of business:?$/i.test(label)) return one(nameOf(claim.lossType) || nameOf(claim.lobCode), 'payload');
    // A known label ("Our Insured:", "Policyholder:") → its claim / recipient / payload value.
    const path = label ? synonyms.lookup(label.replace(/^(?:re:\s*)?our\s+/i, '')) : undefined;
    if (path) {
      const v = String(path).split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), { testData: td, recipient: recipient || {}, raw: rawPayloadRoot || {} });
      if (v !== undefined && v !== null && v !== '') return one(v, path.startsWith('raw.') ? 'payload' : 'ClaimCenter');
    }
    // The row by exact name even when the dictionary's Form(s) column doesn't list this DIG — "Agent Number" (Producer
    // Code, 19 BLOCKED edits across 12 templates on 2026-10-23) resolves fine from claim.policy.producerCode.
    const unscoped = field && !dictRows.some((r) => r.attributeName === field) ? dataDictionaryService.getAttributeByExactName(digNumber, field) : null;
    const row = (field && dictRows.find((r) => r.attributeName === field && r.xpath)) || (unscoped && unscoped.row.xpath ? unscoped.row : null);
    if (!row || !rawPayloadRoot) return null;
    const r = payloadXpathService.resolveXpath(rawPayloadRoot, row.xpath);
    return r.unsupported || r.value === undefined || r.value === '' ? null : one(r.value, 'payload');
  };
  // incl. "--Editable--" (DIG179) and any "--instruction--" ("--Please update Yes or No--" DIG74, "--case assessment--" DIG152)
  const isPlaceholder = (b) => /<<|editable|^-+$|^\s*$|^\s*-{2,}.*-{2,}\s*$/i.test(String(b || '').replace(/[[\]]/g, ''));
  // Every text value in the payload, read once — for payloadValueMatching below.
  let payloadStrings = null;
  const allPayloadStrings = () => {
    if (payloadStrings) return payloadStrings;
    const out = new Set();
    (function walk(o, depth) {
      if (o == null || depth > 40 || out.size > 50000) return;
      if (typeof o === 'string' || typeof o === 'number') { const s = String(o).trim(); if (s.length >= 4 && s.length <= 200) out.add(s); return; }
      if (typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], depth + 1);
    })(rawPayloadRoot, 0);
    payloadStrings = [...out];
    return payloadStrings;
  };
  const payloadValueMatching = (text) => {
    const t = String(text || '').trim();
    if (!rawPayloadRoot || t.length < 4) return null;
    const tn = normForKnownValueMatch(t);
    const td0 = /\d{4}/.test(t) ? new Date(t) : null;
    // An ISO timestamp's own date part, not converted to local time: "1954-09-13T00:00:00.000Z" is Sep 13, though in
    // US time that instant is the evening of Sep 12.
    const dateOf = (s) => { const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(s); return iso ? new Date(+iso[1], +iso[2] - 1, +iso[3]) : new Date(s); };
    return allPayloadStrings().find((s) => normForKnownValueMatch(s) === tn
      || (td0 && !Number.isNaN(td0.getTime()) && /\d{4}/.test(s) && /^[\d\-/T:.Z ]+$|^[A-Za-z]+ \d{1,2}, \d{4}$/.test(s) && dateOf(s).toDateString() === td0.toDateString())) || null;
  };
  const sameValue = (a, b) => {
    const x = normForKnownValueMatch(String(a || '').replace(/[[\]]/g, '')); const y = normForKnownValueMatch(b);
    if (!x || !y) return false;
    // "MI" = "Michigan" (DIG201/DIG203 state fields, 2026-10-27); "Wilkinson, Kelly" = "Kelly Wilkinson" (DIG203/DIG210).
    if (stateName(x) && stateName(x) === stateName(y)) return true;
    const swap = (s) => { const m = /^\s*([^,]+),\s*([^,]+)\s*$/.exec(String(s || '').replace(/[[\]]/g, '')); return m ? normForKnownValueMatch(`${m[2]} ${m[1]}`) : null; };
    if ((swap(a) && swap(a) === y) || (swap(b) && swap(b) === x)) return true;
    if (x === y || (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x)))) return true;
    const da = new Date(String(a).replace(/[[\]]/g, '')); const db = new Date(b);
    if (!Number.isNaN(da.getTime()) && !Number.isNaN(db.getTime()) && /\d{4}/.test(a) && /\d{4}/.test(b)) return da.toDateString() === db.toDateString();
    const na = Number(String(a).replace(/[$,\s[\]]/g, '')); const nb = Number(String(b).replace(/[$,\s]/g, ''));
    return Number.isFinite(na) && Number.isFinite(nb) && String(a).match(/\d/) && na === nb;
  };
  // The label right in front of the field: plain text after the last other field (a "[value]" or placeholder) in the
  // editor's preceding text, last clause only ("Our Policy No.:"). Nothing left = the field follows another field
  // directly (address lines) — no label of its own.
  const labelOf = (c) => {
    let t = String(c.labelContext || '').replace(/\[\s*$/, '');
    const lastField = Math.max(t.lastIndexOf(']'), t.lastIndexOf('>>'));
    if (lastField >= 0) t = t.slice(lastField + (t[lastField] === ']' ? 1 : 2)).replace(/^[\s\-\]>,;]+/, '');
    t = t.trim();
    if (!t || !/[A-Za-z]{2}/.test(t)) return '';
    const parts = t.split(/(?<=[.!?])\s+(?=[A-Z])/);
    return parts[parts.length - 1].slice(-70).trim();
  };
  return edited.map((c, i) => {
    const label = labelOf(c);
    // A "label" of 8+ words is the tail of the paragraph before the field, not a label (DIG12 2026-10-29: "…provides
    // coverage in accordance with the Ohio law." before a state-specific paragraph) — the static-text checks cover it.
    const labelOk = !label || label.trim().split(/\s+/).length >= 8 || docCompact.includes(compact(label)) || docCompact.includes(compact(label.replace(/^(?:re:\s*)?our\s+/i, '')));
    // A field that holds ONE part of a date ("Date of Loss Day" → "6", DIG28/DIG30 "which occurred on or about the [6]
    // day of [August]") is compared with that part of the source date, not the whole "August 06, 2026" (false FAIL
    // 2026-10-23) — the same narrowing the PDF checks already do (pdfValidationService.dateLossPart).
    const whole = sourceOf(c, label);
    const part = whole && pdfValidationService.dateLossPart(c.dictionaryField || '', whole.value);
    const src = part ? { values: part.accept, value: part.value, from: whole.from } : whole;
    const before = String(c.before || '');
    const placeholder = isPlaceholder(before);
    // No ClaimCenter/payload value behind the field: its text only has to match the mapping doc (per user direction
    // 2026-10-17 — template wording / fixed values like DIG26's row labels pass when they're in the requirement doc).
    const beforeText = before.replace(/[[\]]/g, '').trim();
    const inTemplate = !!beforeText && compact(beforeText).length >= 2 && docCompact.includes(compact(beforeText));
    // A field the mapping doc makes CONDITIONAL ("display claimant name if Claimant Name checkbox is selected" — DIG55,
    // 2026-10-17) may correctly be empty: an empty placeholder then isn't "no default value".
    const condReq = c.dictionaryField && (requirements || []).find((r) => r.enabled === false && r.fieldName && compact(r.fieldName).includes(compact(c.dictionaryField)));
    // A value split over neighbouring pieces of one field (DIG200's loss location: "[490 CRAIG RD, NORTH ABINGTON" +
    // "TOWNSHIP, PA 18414-7703]", both "Accident Zip") is compared as the whole.
    const run = c.dictionaryField ? edited.filter((o) => o.dictionaryField === c.dictionaryField && Math.abs(o.idx - c.idx) <= 2) : [c];
    const joined = run.length > 1 ? [...run].sort((x, y) => x.idx - y.idx).map((o) => String(o.before || '').replace(/[[\]]/g, '')).join(' ') : before;
    const fieldMatches = (v) => sameValue(before, v) || (run.length > 1 && sameValue(joined, v));
    // No dictionary source: is the pre-edit value one of the claim's own values (insured, claimant, policy number,
    // policy type, loss location, underwriting company…)? "[MARTHA ANTOLICK]", "[Homeowner's]" (DIG200/DIG179).
    const knownValue = !src && !placeholder ? knownValues.find((k) => sameValue(before, k.value)) : null;
    // Nothing names this field's source, but its own pre-edit value is in the payload exactly (a date in any format) —
    // "[03/23/2026]" effDate, "[09/13/1954]" date of birth, "[29-Fall, slip, or trip injury" (DIG209/DIG15/DIG2118,
    // BLOCKED before 2026-10-23). Exact only, 4+ characters, so a common short value can't match by accident.
    const payloadHit = !src && !placeholder && !knownValue && !inTemplate ? payloadValueMatching(beforeText) : null;
    let beforeState = src ? (placeholder ? 'no default' : src.values.some(fieldMatches) ? 'match' : 'mismatch')
      : (placeholder ? 'free-form' : knownValue ? 'known' : inTemplate ? 'template' : payloadHit ? 'payload' : 'unverifiable');
    if (beforeState === 'no default' && condReq) beforeState = 'conditional';
    // The field shows ANOTHER of the claim's values (the agency name, the adjuster, a phone, the vehicle year): the
    // dictionary row was paired with the neighbouring field, not this one — a pairing slip in this tool, not a
    // template defect (2026-10-30 bulk run: DIG12/DIG96 "cc:" rows, DIG75 MAKE = "2002", DIG54217 Insured = adjuster).
    let mispairedWith = null;
    if (beforeState === 'mismatch' && !(String(c.committedMarker || '') === 'X' && /^\[?\s*\]?$/.test(before.trim()))) {
      const other = [...knownValues, { name: 'additional recipient', value: addr.name }, { name: 'agent number', value: claim.policy && claim.policy.producerCode }]
        .find((k) => k.value && !src.values.some((v) => sameValue(k.value, v)) && sameValue(before, k.value));
      const shape = /^\[?\s*(?:\(?\d{3}\)?[\s.-]?\d{3}-\d{4}(?:\s*x\d+)?|(?:19|20)\d{2})\s*\]?$/i.test(before.trim()) && !/\d/.test(src.value) ? 'a phone number / year' : null;
      const inPayload = !other && !shape ? payloadValueMatching(beforeText) : null;
      mispairedWith = other ? `the claim's ${other.name}` : shape || (inPayload && !src.values.some((v) => sameValue(inPayload, v)) ? `another payload value ("${inPayload}")` : null);
      if (mispairedWith) beforeState = 'mispaired';
    }
    // A checkbox ("[ ]" ticked with "X" — DIG219's "Return to work" boxes) has no ClaimCenter value; whatever its label
    // matched in the dictionary, only the label and the X in the PDF apply.
    const isCheckbox = String(c.committedMarker || '') === 'X' && /^\[?\s*\]?$/.test(before.trim());
    if (isCheckbox) beforeState = 'checkbox';
    const inPdf = c.verifiedInPdf === true;
    // The value the field held right before Complete Document — what the PDF must show (a later edit of a shared
    // value can replace what was typed; see verifyInteractiveEditsInPdf).
    const finalShown = c.finalShownInPdf ? `${c.finalShownInPdf} (typed ${c.committedMarker || c.after}; replaced by a later edit of the same field)` : (c.committedMarker || c.after);
    const problems = [];
    if (!labelOk) problems.push(`its label "${label}" isn't in the mapping doc`);
    if (beforeState === 'mismatch' && !isCheckbox) problems.push(`before the edit it showed "${before}", not the ${src.from} value "${src.value}"`);
    if (beforeState === 'no default') problems.push(`before the edit it was an empty placeholder ("${before}") instead of the ${src.from} value "${src.value}" — no default value`);
    if (!inPdf && !c.lostInEditor) problems.push(`the edited value "${finalShown}" is not in the completed PDF${c.replacedBy ? ` — that spot printed "${c.replacedBy}" (another row's edit of the same field) instead` : ''}`);
    // An edit another test edit typed over before Complete (c.lostInEditor) can't be confirmed by the PDF: BLOCKED.
    const result = problems.length ? 'FAIL' : (beforeState === 'unverifiable' || beforeState === 'mispaired' || c.lostInEditor) ? 'BLOCKED' : beforeState === 'conditional' ? 'SKIPPED' : 'PASS';
    return {
      id: `EDIT${i + 1}`, description: `Edited field ${c.id} "${label || c.label}"${c.dictionaryField ? ` (${c.dictionaryField})` : ''}: label, value before edit, value after edit`,
      expected: isCheckbox ? '(checkbox — no default)' : src ? src.value : (beforeState === 'free-form' ? '(free-form — no default)' : beforeState === 'payload' ? `${payloadHit} (payload, found by value)` : '(no ClaimCenter/payload value)'),
      actual: `Before edit: "${before}" → after edit: "${finalShown}"`,
      result,
      reason: problems.length ? `${problems.join('; ')}.`
        : c.lostInEditor ? `This field's edit ("${c.committedMarker}") was typed over by another test edit in the editor before Complete Document (field positions shifted while editing), so the PDF can't confirm it — not verifiable, not a template defect.`
        : beforeState === 'mispaired' ? `Before the edit it showed "${before}", which is ${mispairedWith}, not the ${src.from} "${c.dictionaryField || label}" value "${src.value}" — this tool matched the "${c.dictionaryField || label}" row to the neighbouring field, so this field's value can't be judged here. The edited value is in the PDF. Not a template defect.`
        : beforeState === 'known' ? `Label is fine; before the edit it showed "${before}", the claim's ${knownValue.name}; the edited value is in the PDF.`
        : beforeState === 'payload' ? `Before the edit it showed "${before}", which is this claim's value in the SmartCOMM payload ("${payloadHit}" — found by value; the Data Dictionary names no source for this field); the edited value is in the PDF.`
        : beforeState === 'unverifiable' ? `Label is in the mapping doc and the edit is in the PDF, but this field has no ClaimCenter/payload value to compare its pre-edit value "${before}" with.`
        : beforeState === 'checkbox' ? `A checkbox (no ClaimCenter value): it was empty before the edit and the "X" it was ticked with is in the PDF.`
        : beforeState === 'conditional' ? `Empty before the edit, which the mapping doc allows: this field is conditional ("${String(condReq.fieldName).slice(0, 140)}") and the condition wasn't met this run. Label and the edited value in the PDF are fine.`
        : `Label${label ? ` "${label}"` : ''} is in the mapping doc; ${beforeState === 'match' ? `before the edit it showed the ${src.from} value` : beforeState === 'template' ? `before the edit it showed "${beforeText}", which is in the mapping doc (no ClaimCenter/payload value for this field)` : 'it was a free-form field with no default'}; the edited value is in the PDF.`,
      editDetail: { field: c.label, label, labelOk, dictionaryField: c.dictionaryField, expected: isCheckbox ? '(checkbox)' : src ? `${src.value} (${src.from})` : '', before, beforeState, after: finalShown, inPdf },
    };
  });
}

// A mapping doc's full text (body + BA comments), read once per file — for the CHOICE checks in runScenario.
const mappingDocTextCache = new Map();
function mappingDocText(docPath) {
  if (docPath && /\.doc$/i.test(docPath)) return templateRequirementService.getLegacyDocText(docPath); // legacy .doc — text kept by getRequirements
  if (!docPath || !/\.docx$/i.test(docPath)) return '';
  if (!mappingDocTextCache.has(docPath)) {
    let text = '';
    try {
      const zip = new (require('adm-zip'))(docPath);
      text = ['word/document.xml', 'word/comments.xml'].filter((n) => zip.getEntry(n))
        .map((n) => zip.readAsText(n).replace(/<[^>]+>/g, ' ')).join(' ').replace(/\s+/g, ' ');
    } catch (_) { /* unreadable — the requirements text is still used */ }
    mappingDocTextCache.set(docPath, text);
  }
  return mappingDocTextCache.get(docPath);
}

// ClaimCenter's generic server-side failure banner ("An application error occurred. Contact your administrator
// if the problem persists.") — shown in place of a screen that couldn't be built.
async function hasApplicationError(page) {
  return page.getByText(/An application error occurred/i).filter({ visible: true }).first().isVisible().catch(() => false);
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

async function runScenario(page, { template, scenario, requirements, recipientEmail, variant, mentionsFraudLanguage, freeFormFields = [], interactive, s3Session, sourceFile }) {
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
    let captured = await claimSummaryService.captureClaimSummary(page);
    // A template that prints BOTH the claimant and the insured can't catch a claimant/insured swap (Jira
    // SMART-1349: "Claimant field populated with the Insured Name") on a claim where they're the same person —
    // common in this test data. Try the scenario's same-LOB/State backup claims for one where they differ.
    const samePerson = (c) => Boolean(c.claimantName && c.insuredName && c.claimantName.trim().toLowerCase() === c.insuredName.trim().toLowerCase());
    const printsClaimantName = (requirements || []).some((r) => r.expectedSource === 'testData.claimantName');
    const needsDistinctParties = printsClaimantName && (requirements || []).some((r) => r.expectedSource === 'testData.insuredName');
    // Also a claim with NO claimant party at all — a template printing the claimant has nothing to check there
    // (CONFIRMED live 2026-10-14, DIG86 on a Michigan claim: BLOCKED "no claimantName for this claim").
    const unsuitable = (c) => (printsClaimantName && !c.claimantName) || (needsDistinctParties && samePerson(c));
    // (A manual Claim # override scenario carries no backup claims, so it's never switched away from.)
    if (unsuitable(captured)) {
      const original = { testData: scenario.testData, captured };
      let switched = false;
      for (const alt of scenario.alternates || []) {
        await openExistingClaim(page, alt.claimNumber);
        if (await claimAccessDenied(page, alt.claimNumber)) continue;
        const altCaptured = await claimSummaryService.captureClaimSummary(page);
        if (!unsuitable(altCaptured)) {
          console.log(`[SmartComm] ${scenario.scenarioId}: claim ${original.testData.claimNumber} ${captured.claimantName ? `has the same person as claimant and insured ("${captured.insuredName}")` : 'has no claimant party'} — switched to ${alt.claimNumber} (claimant "${altCaptured.claimantName}", insured "${altCaptured.insuredName}") so the claimant can be checked.`);
          scenario.testData = alt;
          base.claimNumber = alt.claimNumber;
          captured = altCaptured;
          switched = true;
          break;
        }
      }
      if (!switched) {
        if ((scenario.alternates || []).length) await openExistingClaim(page, original.testData.claimNumber);
        base.partiesNote = captured.claimantName
          ? `Claimant and insured are the same person ("${captured.insuredName}") on ${original.testData.claimNumber}${(scenario.alternates || []).length ? ` and on its ${(scenario.alternates || []).length} backup claim(s)` : ''} — a claimant/insured swap couldn't be detected on this scenario.`
          : `No claimant party on ${original.testData.claimNumber}${(scenario.alternates || []).length ? ` or a usable one among its ${(scenario.alternates || []).length} backup claim(s)` : ''} — the claimant couldn't be checked on this scenario.`;
        console.log(`[SmartComm] ${scenario.scenarioId}: ${base.partiesNote}`);
      }
    }
    const withCaptured = (td, c) => ({ ...td, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) });
    let effectiveTestData = withCaptured(scenario.testData, captured);
    // Every party's own roles (e.g. "Mark Antolick" -> ["Driver", "Covered Party", ...]) — captured once,
    // here, while still on the Summary screen (same table captureClaimSummary just read), for
    // setAdditionalRecipient to optionally prefer a specific role (see templateWantsProducerRole below).
    let partiesRoles = await claimSummaryService.capturePartiesRoles(page);
    console.log(`[SmartComm] ${scenario.scenarioId}: claim data — insuredName=${JSON.stringify(effectiveTestData.insuredName)} lossDate=${JSON.stringify(effectiveTestData.lossDate)} lossLocation=${JSON.stringify(effectiveTestData.lossLocation)} claimantName=${JSON.stringify(effectiveTestData.claimantName)}`);

    // ClaimCenter can throw "An application error occurred" on Create from template for one specific claim, every
    // time (CONFIRMED 2026-10-16/17: WC-DE-01-26-0747131, DIG23DE's third scenario — and then every WC-DE backup claim
    // too). Per user direction, retry on claims of OTHER LOBs (scenarioService's otherLobAlternates) instead.
    try {
      await documentService.openCreateFromTemplate(page);
    } catch (err) {
      if (!/CREATE_FROM_TEMPLATE_NOT_OPENED/.test(err.message) || !(await hasApplicationError(page))) throw err;
      const failedClaim = scenario.testData.claimNumber;
      let opened = false;
      const otherLob = scenario.otherLobAlternates || [];
      for (const alt of otherLob) {
        console.log(`[SmartComm] ${scenario.scenarioId}: ClaimCenter application error on Create from template for claim ${failedClaim} — trying claim ${alt.claimNumber} of another LOB (${alt.lob}/${alt.state})`);
        await openExistingClaim(page, alt.claimNumber);
        if (await claimAccessDenied(page, alt.claimNumber)) continue;
        const altCaptured = await claimSummaryService.captureClaimSummary(page);
        if (unsuitable(altCaptured)) continue;
        const altRoles = await claimSummaryService.capturePartiesRoles(page);
        if (!(await documentService.openCreateFromTemplate(page).then(() => true, () => false))) continue;
        scenario.testData = alt;
        base.claimNumber = alt.claimNumber;
        base.originalClaimNumber = failedClaim;
        base.lob = alt.lob;
        base.state = alt.state;
        base.claimFallbackNote = `ClaimCenter threw an application error on Create from template for claim ${failedClaim} (${scenario.lob}/${scenario.state}); this scenario ran on claim ${alt.claimNumber} of another LOB (${alt.lob}/${alt.state}) instead, so LOB-specific content may not apply to it.`;
        captured = altCaptured;
        effectiveTestData = withCaptured(alt, altCaptured);
        partiesRoles = altRoles;
        console.log(`[SmartComm] ${scenario.scenarioId}: ${base.claimFallbackNote}`);
        opened = true;
        break;
      }
      if (!opened) {
        err.message += ` ClaimCenter showed "An application error occurred" on claim ${failedClaim}${otherLob.length ? ` and on ${otherLob.length} claim(s) of other LOBs` : ' (no claims of other LOBs to try)'}.`;
        throw err;
      }
    }
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
    // A template that prints the claimant gets the document related to the claimant's own exposure, as a real
    // claimant letter is (see setAdditionalData) — otherwise its Claimant line prints blank.
    const printsClaimant = (requirements || []).some((r) => r.expectedSource === 'testData.claimantName');
    // A template whose fields the Data Dictionary sources from the EXPOSURE ("…from associated Vehicle incident for the
    // exposure selected under 'Related To'" — Vehicle Year/Make/Model, DIG37/DIG75) needs an exposure in Related To too:
    // related to the claim, those fields correctly print blank and every vehicle check was a false FAIL (2026-10-23).
    const fieldKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const usedFields = new Set((requirements || []).map((r) => fieldKey(r.fieldName)).filter(Boolean));
    const exposureRows = dataDictionaryService.getAttributesForTemplate(template.digNumber)
      .filter((r) => /ccDocumentCreationRequest\.exposure\./i.test(r.xpath || '') && usedFields.has(fieldKey(r.attributeName)));
    const needsVehicle = exposureRows.some((r) => /vehicleIncident/i.test(r.xpath || ''));
    const applied = await documentService.setAdditionalData(page, {
      language: 'English (US)', documentType: variant.documentType, status: variant.status, securityType: variant.securityType,
      relatedToName: printsClaimant ? effectiveTestData.claimantName : (exposureRows.length ? '*' : undefined),
      preferVehicleExposure: needsVehicle,
      insuredName: effectiveTestData.insuredName,
    });
    if (applied.relatedTo) {
      console.log(`[SmartComm] ${scenario.scenarioId}: Related To set to "${applied.relatedTo}" (${printsClaimant ? 'the claimant\'s exposure' : `an exposure — ${exposureRows.length} field(s) come from it${needsVehicle ? ', incl. its vehicle' : ''}`})`);
      // The letter's Claimant line fills from that exposure — expect its claimant.
      if (applied.relatedToClaimant && applied.relatedToClaimant.toLowerCase() !== String(effectiveTestData.claimantName || '').toLowerCase()) {
        console.log(`[SmartComm] ${scenario.scenarioId}: expected claimant now "${applied.relatedToClaimant}" (was "${effectiveTestData.claimantName}", which has no exposure on this claim)`);
        effectiveTestData.claimantName = applied.relatedToClaimant;
      }
    }
    // Report what was really set, not what was requested (a field can be
    // absent from a template's Additional Data screen).
    const notSet = '(field not on screen)';
    base.variant.documentType = applied.documentType || notSet;
    base.variant.status = applied.status || notSet;
    base.variant.securityType = applied.securityType || notSet;
    if (printsClaimant) base.variant.relatedTo = applied.relatedTo || 'Claim';

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

    let pdfPath, payload, interactiveChecks, metadataChecks = [];
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
        s3Session, claimNumber: base.claimNumber,
        commentFieldNames: scenarioRequirements.map((r) => r.fieldName).filter(Boolean), freeFormFields,
        freeFormSamples: scenarioRequirements.filter((r) => /free\s*form/i.test(r.fieldName || '') && r.sampleValue).map((r) => r.sampleValue),
      });
      pdfPath = result.pdfPath;
      interactiveChecks = result.interactiveChecks;
      metadataChecks = [...(result.lockChecks || []), ...(result.metadataChecks || [])];
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
      // Some On-Demand templates (DIG4/DIG14 Risk Reports, CONFIRMED live 2026-10-30) never show a results row:
      // Generate closes the wizard and the PDF goes straight to S3's archive. Watch the archive from just before
      // Generate and recognize the document by its filing .json (this DIG + this claim) — see
      // s3AdminService.watchArchiveForMetadata. Stopped as soon as the classic results row shows up instead.
      const fileNamePrefix = `${template.digNumber}_${scenario.testData.claimNumber}_${scenario.scenarioId}`;
      const dig = String(template.digNumber).toUpperCase().replace(/\s+/g, '');
      const claimNo = String(base.claimNumber || scenario.testData.claimNumber).replace(/\s+/g, '');
      let rowArrived = false;
      const s3Log = (m) => console.log(`[SmartComm] ${scenario.scenarioId}: ${m}`);
      const watch = s3Session.withPage((s3Page) => s3AdminService.watchArchiveForMetadata(s3Page, (meta) => {
        // "DIG14 Risk Report||OnDemand": the DIG number as its own word, so DIG14 never takes DIG141's or DIG14S's.
        const desc = String(meta.Description || '').toUpperCase();
        return String(meta.FileNumber || '').replace(/\s+/g, '') === claimNo && new RegExp(`^${dig.replace(/^DIG/, 'DIG\\s*')}\\b`).test(desc.trim());
      }, documentService.DOWNLOAD_DIR, { log: s3Log, abort: () => rowArrived })).catch((e) => { s3Log(`on-demand S3 watch failed: ${e.message}`); return null; });
      await page.waitForTimeout(1500); // let the watch take its baseline before Generate
      try {
        pdfPath = await documentService.generateOnDemand(page, { fileNamePrefix });
        rowArrived = true;
        payload = await tryDownloadPayload();
      } catch (err) {
        if (!/^GENERATE_NO_DOCUMENT/.test(err.message)) { rowArrived = true; throw err; }
        s3Log('Generate closed the wizard (no results row) — waiting for the PDF in S3\'s archive instead...');
        const found = await watch;
        if (!found || !found.pdf) {
          throw new Error(`GENERATE_NO_DOCUMENT: Generate closed the wizard and no ${template.digNumber} PDF for claim ${claimNo} reached S3's archive within 3 minutes. ClaimCenter/SmartCOMM side - not an automation failure.`);
        }
        pdfPath = path.join(documentService.DOWNLOAD_DIR, `${fileNamePrefix}.pdf`);
        fs.renameSync(found.pdf.localPath, pdfPath);
        s3Log(`On-Demand PDF taken from S3 (Identifier ${found.identifier})`);
        metadataChecks = buildMetadataChecks(found.metadata, { template, claimNumber: base.claimNumber });
        try {
          const hits = await s3Session.withPage((s3Page) => s3AdminService.searchSmartCommPayload(s3Page, found.identifier, { log: s3Log }));
          if (hits.length) {
            const [dl] = await s3Session.withPage((s3Page) => s3AdminService.downloadMatches(s3Page, hits.slice(0, 1), documentService.DOWNLOAD_DIR, { log: s3Log }));
            const payloadPath = path.join(documentService.DOWNLOAD_DIR, `${fileNamePrefix}_payload.xml`);
            fs.renameSync(dl.localPath, payloadPath);
            payload = payloadService.parsePayloadFile(payloadPath);
            rawPayloadRoot = payloadXpathService.parseRawPayloadFile(payloadPath).ccDocumentCreationRequest;
          }
        } catch (e) { s3Log(`payload fetch from S3 failed (${e.message}) — continuing without it.`); }
      }
    }

    const text = await pdfValidationService.extractPdfText(pdfPath);
    if (interactiveChecks) verifyInteractiveEditsInPdf(interactiveChecks, text, (m) => console.log(`[SmartComm] ${scenario.scenarioId}: ${m}`));
    // recipient.{name,address} is who/where documentService actually
    // selected — the source of truth for "To Name"/"To Street Address"/"To
    // City, State, Zip" requirements (see fieldLabelSynonyms.js), correct
    // regardless of which claim/recipient this scenario used. testData here
    // is effectiveTestData (testData.js merged with whatever
    // claimSummaryService captured live) — not the raw scenario.testData.
    // Layout-aware second reading (boxed / column forms) — a fallback for checks the plain text reads across.
    const layoutText = await require('./pdfLayoutText').extractLayoutText(pdfPath).catch(() => '');
    // Claimant name parts ("Claimant First Name" / "Middle Initial" / "Last Name" — DIG219 2026-10-17, were BLOCKED):
    // first word, last word, and the initial of a middle word when there is one.
    if (effectiveTestData.claimantName && !effectiveTestData.claimantFirstName) {
      const parts = String(effectiveTestData.claimantName).trim().split(/\s+/);
      effectiveTestData.claimantFirstName = parts[0];
      if (parts.length > 1) effectiveTestData.claimantLastName = parts[parts.length - 1];
      if (parts.length > 2) effectiveTestData.claimantMiddleInitial = parts[1].charAt(0);
    }
    const context = {
      layoutText,
      testData: effectiveTestData, scenario, template, recipient, additionalRecipient,
      // The SmartCOMM payload itself (ccDocumentCreationRequest) — "raw.*" sources (fieldLabelSynonyms) and the
      // exposure-table checks read it directly.
      raw: rawPayloadRoot,
      interactiveChecks, // what each edited field showed before the edit — the exposure-table type check uses it
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
    const xpathRequirements = rawPayloadRoot ? buildXpathRequirements(template, rawPayloadRoot, scenarioRequirements, interactiveChecks, (m) => console.log(`[SmartComm] ${scenario.scenarioId}: ${m}`), { additionalRecipientAdded: Boolean(additionalRecipient) }) : [];

    // A Choices-panel question that never got confirmed Yes this scenario (it genuinely wasn't on the page
    // for this claim, or simply defaults to No and nothing selected it) has nothing to validate — its gated
    // content correctly never prints, and there's no real "check" being skipped, just a condition that never
    // applied. CONFIRMED live 2026-10-02 (user direction): unlike the additional-recipient-gated fields (Copy
    // Name/Address/Agent Number — worth keeping visible as SKIPPED, since "no recipient added" is itself a
    // meaningful scenario fact), a never-selected Choices question is noise — drop it from the report
    // entirely rather than show a SKIPPED row for every such condition on every scenario.
    const reportableRequirements = linkTextFieldsToDictionary(template, scenarioRequirements, xpathRequirements, rawPayloadRoot)
      .filter((r) => !(CHOICE_SELECTED_YES_RE.test(r.fieldName || '') && r.enabled === false));
    const evaluated = [...reportableRequirements, ...fraudRequirements, ...xpathRequirements];
    const validations = pdfValidationService.evaluateRequirements(evaluated, text, context);
    // Opt-in: save this scenario as an offline regression case (see regressionCaseService) — never fails the run.
    if (/^(1|true|yes)$/i.test(process.env.SMARTCOMM_SAVE_REGRESSION_CASE || '')) {
      try {
        require('./regressionCaseService').saveCase({ digNumber: template.digNumber, scenarioId: scenario.scenarioId, requirements: evaluated, text, context, validations, log: (m) => console.log(`[SmartComm] ${scenario.scenarioId}: ${m}`) });
      } catch (err) { console.log(`[SmartComm] ${scenario.scenarioId}: couldn't save the regression case (${err.message})`); }
    }
    // No payload means none of the Data Dictionary value checks above were even built — previously that just meant fewer
    // checks, with nothing in the report (QA review 2026-10-18). Reported as BLOCKED so the scenario can't read PASS.
    if (!rawPayloadRoot) validations.push(payloadUnavailableCheck());
    explainFraudLanguageFailures(validations, text, fraudDetails);
    annotateInteractiveEditFailures(validations, interactiveChecks);
    // An overlay form can be pure page images with no text layer (CONFIRMED live 2026-10-14, DIG150MIC: the
    // 2-page Michigan "Rights and Responsibilities" pamphlet, 6 characters of extractable text, no claim data
    // printed — same as its mapping doc's page images). Text checks can't say anything about such a document:
    // report them as not verifiable rather than as missing content.
    if (template.overlayMode && String(text || '').replace(/\s+/g, '').length < 50) {
      for (const v of validations) {
        if (v.result !== 'FAIL') continue;
        v.result = 'BLOCKED';
        v.reason = 'Overlay form printed as page images only (no text layer), so this value can\'t be read from the PDF — not verifiable, not a defect.';
      }
    }
    // Michigan claims print the Michigan Insurance letterhead: "www.michiganinsurance.com" in place of the mapping doc's
    // "www.donegalgroup.com" (DIG109-AUTO-MI/GL-MI, 2026-10-31) — the right website for that letterhead, not a defect.
    if (/michiganinsurance\.com/i.test(text || '')) {
      for (const v of validations) {
        if (v.result === 'FAIL' && /^www\.donegalgroup\.com$/i.test(String(v.expected || '').trim())) {
          v.result = 'PASS';
          v.reason = 'Michigan Insurance letterhead prints www.michiganinsurance.com in place of www.donegalgroup.com — expected for a Michigan claim.';
        }
      }
    }
    // A form whose PRINTED wording is images, not text (CONFIRMED 2026-10-17, DIG47 Wage and Salary Verification: the
    // page renders the whole form, but as 10 embedded images — the text layer holds only the filled-in values). Most
    // fixed-wording checks then "fail" without telling anything. When at least 60% of 8+ fixed-wording checks fail while
    // filled-in values ARE found as text, those are reported BLOCKED (can't be read) with one summary row asking for a
    // visual check — a genuinely blank form still stands out there, instead of being buried in dozens of FAILs.
    {
      const isFixed = (v) => /^R\d/.test(v.id || '') && /^(Static content must appear|Label ")/.test(v.description || '');
      const fixed = validations.filter(isFixed);
      const fixedFailed = fixed.filter((v) => v.result === 'FAIL');
      const valuesFound = validations.filter((v) => /^R\d/.test(v.id || '') && /^Value for /.test(v.description || '') && v.result === 'PASS').length;
      if (fixed.length >= 8 && fixedFailed.length / fixed.length >= 0.6 && valuesFound >= 2) {
        // Read the page by OCR (Windows' own renderer + OCR engine — pdfOcrService): wording it finds is confirmed;
        // wording it can't find stays BLOCKED (an OCR miss isn't proof the wording is missing). No OCR → all BLOCKED.
        const ocrText = await require('./pdfOcrService').ocrPdfText(pdfPath).catch(() => null);
        const { ocrContains } = require('./pdfOcrService');
        let ocrConfirmed = 0;
        for (const v of fixedFailed) {
          if (ocrText && ocrContains(ocrText, v.expected)) {
            ocrConfirmed++;
            v.result = 'PASS';
            v.actual = `${v.expected} (read by OCR)`;
            v.reason = 'Confirmed by OCR: the form draws its printed wording as graphics, not text, so it was read from a rendered image of the page.';
            continue;
          }
          v.result = 'BLOCKED';
          v.reason = ocrText
            ? 'This fixed wording isn\'t in the PDF\'s text layer (the form\'s wording is drawn as graphics) and OCR couldn\'t confirm it either — check this line visually. See DATA3.'
            : 'This fixed wording isn\'t in the PDF\'s text layer — the form\'s printed wording is drawn as graphics, so it can\'t be checked as text. See DATA3: check the form visually.';
        }
        const ocrLeft = fixedFailed.length - ocrConfirmed;
        validations.push({
          id: 'DATA3', description: 'The form\'s fixed wording can be read from the PDF', expected: 'Fixed wording present',
          actual: `${fixedFailed.length} of ${fixed.length} fixed-wording lines are drawn as graphics, not text; ${ocrText ? `${ocrConfirmed} confirmed by OCR, ${ocrLeft} not` : 'OCR not available'}`,
          result: ocrText && !ocrLeft ? 'PASS' : 'BLOCKED',
          reason: ocrText
            ? `Most of the form's printed wording is drawn as graphics in the PDF (only the filled-in values are text), so it was read by OCR: ${ocrConfirmed} of ${fixedFailed.length} lines confirmed${ocrLeft ? `; ${ocrLeft} couldn't be confirmed and are BLOCKED — check those visually` : ''}.`
            : `Most of the form's printed wording is drawn as graphics in the PDF (only the filled-in values are text) and OCR wasn't available, so ${fixedFailed.length} wording checks are BLOCKED instead of FAIL. Open the PDF and confirm the form wording is printed.`,
        });
      } else if (fixedFailed.length) {
        // A page where only SOME phrases are drawn as graphics (CONFIRMED 2026-10-20, DIG122A's HIPAA page: "…the issuance
        // or sale of prescription drugs…" prints, but the text layer jumps from "the issuance" to "pharmacy records").
        // OCR confirms a phrase only when it reads it word-for-word, so a real wording difference stays a FAIL. Fill-in
        // lines ("____") can't be seen by OCR, so those keep their text-layer result.
        const candidates = fixedFailed.filter((v) => !/_{3,}/.test(v.expected || '') && !/fill-in line/i.test(v.reason || ''));
        const ocrText = candidates.length ? await require('./pdfOcrService').ocrPdfText(pdfPath).catch(() => null) : null;
        const { ocrContains } = require('./pdfOcrService');
        for (const v of ocrText ? candidates : []) {
          if (ocrContains(ocrText, v.expected, { exact: true })) {
            v.result = 'PASS';
            v.actual = `${v.expected} (read by OCR)`;
            v.reason = 'Confirmed by OCR: this wording is printed on the page but drawn as graphics, so the PDF\'s text layer doesn\'t contain it.';
          } else if (v.actual === 'Not Found' && ocrContains(ocrText, v.expected)) {
            // Most of the words are on the page — not "missing entirely". DIG122A: the claimant's name prints over the end
            // of the HIPAA paragraph, so that line can't be read. Still a FAIL, with a reason that sends someone to look.
            v.reason = 'Most of this wording is printed (read by OCR) but not all of it can be read word-for-word — part of it is drawn as graphics or has something printed over it. Check this passage visually.';
          }
        }
      }
    }
    validations.push(...await buildPageAndFraudChecks(pdfPath, text, { mentionsFraudLanguage: mentionsFraudLanguage || scenarioRequirements.some((r) => /fraud language/i.test(r.fieldName || '')) }));
    // Append the archive .json filing-metadata checks (META*) so they count toward the scenario result and
    // render in their own report table (see reportService). A wrong claim #/template here is a real failure.
    if (metadataChecks && metadataChecks.length) validations.push(...metadataChecks);
    if (base.partiesNote) {
      validations.push({ id: 'DATA1', description: 'Claimant and insured are different people on the test claim (so a claimant/insured swap would be caught)', expected: 'Different claimant and insured', actual: 'Same person', result: 'SKIPPED', reason: base.partiesNote });
    }
    // Every edited field checked on its own — label, value before the edit, value after the edit (buildEditedFieldChecks).
    validations.push(...buildEditedFieldChecks(interactiveChecks, {
      rawPayloadRoot, payload, recipient, additionalRecipient, testData: effectiveTestData, digNumber: template.digNumber, sourceFile, requirements,
    }));
    if (base.claimFallbackNote) {
      validations.push({ id: 'DATA2', description: 'The scenario ran on its own test claim', expected: `Claim ${base.originalClaimNumber}`, actual: `Backup claim ${base.claimNumber}`, result: 'SKIPPED', reason: base.claimFallbackNote });
    }
    // A Choices-panel question the editor offers ("Apply Medical Letterhead?") that the mapping doc never defines —
    // per user direction 2026-10-17 a defect: DIG27/DIG28 have no medical-letterhead option in their requirements,
    // yet the editor offers it (and answering Yes prints the medical-bills letterhead). Defined = the question's
    // significant words appear in the mapping doc's own comments or text (e.g. DIG239's "Display only if Apply
    // Medical Letterhead? is selected Yes").
    // The question only — choicesApplied entries are "<question>: <answer>", and a paragraph choice's answer is the
    // chosen paragraph's own text ("Select Language to display in Paragraph: for bodily injury…", DIG36).
    // One per question: the editor can show the same question twice, once with its words run together
    // ("Select paragraph based on Department" / "Selectparagraphbasedon Department" — DIG55); the spaced one is kept.
    const choiceQuestions = [...new Map((choicesApplied || []).map((c) => String(c).split(':')[0].trim()).filter((q) => q && !/^\(unlabeled/i.test(q))
      .sort((x, y) => (x.match(/ /g) || []).length - (y.match(/ /g) || []).length).map((q) => [q.toLowerCase().replace(/[^a-z]/g, ''), q])).values()];
    if (choiceQuestions.length) {
      // The whole mapping doc (body + comments), not just the derived requirements: DIG11 describes its "PACE notice
      // language" option in body text that never becomes a requirement.
      const docText = `${mappingDocText(sourceFile)} ${(requirements || []).map((r) => [r.fieldName, r.expectedValue, r.sampleValue, r.disabledReason].filter(Boolean).join(' ')).join(' ')}`.toLowerCase();
      choiceQuestions.forEach((q, i) => {
        const words = (q.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !['apply', 'display', 'show', 'select', 'include'].includes(w));
        // Also with spaces removed: the editor sometimes runs a label's words together ("PACEnoticelanguagerequired?", DIG11).
        const compact = (x) => x.toLowerCase().replace(/[^a-z]/g, '');
        // Run-together labels can't be split into words, so take the longest start of the label found in the doc.
        const cq = compact(q);
        const cd = compact(docText);
        let prefix = 0;
        while (prefix < cq.length && cd.includes(cq.slice(0, prefix + 1))) prefix++;
        // The significant words together, as a phrase ("medical letterhead") — separately they turn up in unrelated
        // places (DIG28: "See Base Template/Letterhead", medical wording in the release text).
        const defined = (words.length > 0 && cd.includes(words.join('')))
          || (cq.length >= 8 && prefix >= Math.max(10, Math.ceil(cq.length * 0.6)));
        validations.push({
          id: `CHOICE${i + 1}`, description: `Choices option "${q}" is defined in the mapping doc`,
          expected: 'Defined in the mapping doc', actual: defined ? 'Defined' : 'Offered in the editor, not in the mapping doc',
          result: defined ? 'PASS' : 'FAIL',
          ...(defined ? {} : { reason: `The interactive editor offers the "${q}" choice, but this template's mapping doc has no such option — the template shows a choice (and its content) that wasn't specified.` }),
        });
      });
    }
    // Layout against the Word mapping doc — alignment, paragraph breaks, header order (layoutValidationService).
    validations.push(...await runLayoutChecks({ docxPath: sourceFile, pdfPath, requirements: reportableRequirements, validations }, (m) => console.log(`[SmartComm] ${scenario.scenarioId}: ${m}`)));
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

    const { passed, failed, blocked, skipped, status } = rollUpScenario(validations, interactiveChecks);

    console.log(`[SmartComm] ${scenario.scenarioId}: ${status} (${passed} passed, ${failed} failed, ${blocked} blocked, ${skipped} skipped)`);
    // The report is an in-memory buffer, so log each failed check's detail too — otherwise a FAIL count in the
    // console can't be traced back to WHICH check failed without re-running and opening the report.
    for (const v of validations.filter((x) => x.result === 'FAIL')) {
      console.log(`[SmartComm] ${scenario.scenarioId}: FAILED CHECK ${v.id || ''} "${v.description || ''}" | expected=${JSON.stringify(v.expected)} actual=${JSON.stringify(v.actual)} | ${v.reason || ''}`);
    }
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
    if (err.message.startsWith('TEMPLATE_NOT_FOUND') || err.message.startsWith('GENERATE_FAILED') || err.message.startsWith('GENERATE_NO_DOCUMENT') || err.message.startsWith('INTERACTIVE_NOT_ENABLED') || err.message.startsWith('INTERACTIVE_NEEDS_APPROVAL')) {
      console.log(`[SmartComm] BLOCKED ${scenario.scenarioId}: ${err.message}`);
      // An approval-gated document still had its editor checked (fields, locked text) before the block — keep
      // those results; a failure among them is a real finding even without a completed PDF.
      // (Field results here haven't been through the Data Dictionary pass yet — that runs after completion — so
      // only the locked-text check decides FAIL; the field list is kept for reference.)
      const lockFails = (err.lockChecks || []).filter((v) => v.result === 'FAIL').length;
      return {
        ...base, status: lockFails ? 'FAIL' : 'BLOCKED', reason: err.message,
        passed: (err.lockChecks || []).filter((v) => v.result === 'PASS').length, failed: lockFails, blocked: 1, skipped: 0,
        ...(err.lockChecks ? { validations: err.lockChecks } : {}),
        ...(err.interactiveChecks ? { interactiveChecks: err.interactiveChecks } : {}),
        ...(err.choicesApplied ? { conditionalSummary: { choicesAnswered: err.choicesApplied } } : {}),
      };
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

// Layout checks (layoutValidationService), or one BLOCKED row when they crash: a crash used to be logged only, and the
// scenario could still read PASS with its layout never checked (QA review 2026-10-18).
async function runLayoutChecks(args, log = console.log) {
  try {
    return await layoutValidationService.checkLayout(args);
  } catch (err) {
    const msg = err.message.split('\n')[0];
    log(`layout checks could not run (${msg})`);
    return [{ id: 'LAYOUT0', description: 'Layout checks against the Word mapping doc', expected: 'Layout checks run', actual: 'Not run', result: 'BLOCKED', reason: `The layout checks crashed, so alignment / paragraph breaks / header order were not checked: ${msg}` }];
  }
}

// No payload means none of the Data Dictionary value checks were even built — previously that just meant fewer checks,
// with nothing in the report (QA review 2026-10-18). Reported as BLOCKED so the scenario can't read PASS.
function payloadUnavailableCheck() {
  return { id: 'PAYLOAD0', description: 'Data Dictionary value checks (payload vs. PDF)', expected: 'SmartCOMM payload available', actual: 'Not available', result: 'BLOCKED', reason: 'The SmartCOMM payload couldn\'t be downloaded or parsed for this scenario, so the Data Dictionary (Xpath) value checks were not run.' };
}

// The archive filing metadata couldn't be found or read. BLOCKED, not SKIPPED (QA review 2026-10-18): SKIPPED doesn't
// count toward the scenario's status, so a document whose filing was never checked still read PASS.
function metadataUnavailableCheck(reason) {
  return { id: 'META1', description: 'ClaimCenter filing metadata (.json)', result: 'BLOCKED', expected: 'Filing metadata checked', actual: 'Not checked', reason };
}

// A scenario's counts and status from its checks. Nothing actually checked — no check passed or failed (all SKIPPED, or
// none built at all) and no editable field tested — adds a BLOCKED NOCHECK0 row: that used to roll up to PASS with
// 0 passed / 0 failed (QA review 2026-10-18).
// A dictionary-vs-live-session disagreement (interactiveChecks FAIL) is just as much a genuine defect as a content
// FAIL, so it fails the scenario too (per user direction 2026-10-05: "if there are failures in interactive session
// table...overall status needs to show as failed"). interactiveChecks is undefined for an On-Demand template.
function rollUpScenario(validations, interactiveChecks) {
  const ran = (x) => x.result === 'PASS' || x.result === 'FAIL';
  if (!validations.some(ran) && !(interactiveChecks || []).some(ran)) {
    validations.push({ id: 'NOCHECK0', description: 'At least one check ran against the generated document', expected: 'One or more checks PASS or FAIL', actual: `${validations.length} check(s), none of them run (all skipped or blocked)`, result: 'BLOCKED', reason: 'No check actually ran against this document, so it can\'t be called a PASS — see the skipped/blocked rows for why.' });
  }
  const count = (r) => validations.filter((v) => v.result === r).length;
  const passed = count('PASS'); const failed = count('FAIL'); const blocked = count('BLOCKED'); const skipped = count('SKIPPED');
  const fieldsFailed = (interactiveChecks || []).filter((c) => c.result === 'FAIL').length;
  const status = (failed > 0 || fieldsFailed > 0) ? 'FAIL' : blocked > 0 ? 'BLOCKED' : 'PASS';
  return { passed, failed, blocked, skipped, status };
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

const US_STATES = { al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut', de: 'delaware', dc: 'district of columbia', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming' };
// A normalized state code or name → the state's full name, else null.
function stateName(norm) { return US_STATES[norm] || (Object.values(US_STATES).includes(norm) ? norm : null); }

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
function buildEditValue(field, n, digNumber, editableValues = []) {
  // An empty checkbox ("[ ]" / "☐") gets an "X" (user direction 2026-10-17); inspectAndMaybeEdit also switches
  // to "X" for any field whose technical name turns out to be checkBoxN.
  if (/^\[\s*\]$|^[☐□]$/.test(String(field.text || '').trim())) return 'X';
  const match = digNumber && dataDictionaryService.matchAttributeForField(digNumber, { labelContext: field.labelContext });
  const dataType = match && match.row && match.row.dataType;
  if (dataType === 'Date') return buildDateValue(match.row.sampleValue, n);
  if (dataType === 'Money' || dataType === 'Number') return String(900 + n);
  if (dataType === 'Time') return buildTimeValue(match.row.sampleValue, n);
  if (/\$\s*\[?\s*$/.test(field.labelContext || '')) return String(900 + n);
  // A year-only field ("[2026]", DIG27's Year of the Date of Loss) takes a number only: "2026-edited" was reverted to
  // "2026" by the editor and the edit came out BLOCKED (2026-10-27). A distinct far-future year stays a valid, unique
  // year the PDF check can find.
  if (/^\[?\s*(19|20)\d\d\s*\]?$/.test(String(field.stripped || field.text || '').trim())) return String(2090 + n);
  // A field already showing a DATE ("[09/13/1954]", "[March 23, 2026]") is a date-typed field even when the
  // dictionary row wasn't matched by label: "09/13/1954-edited" is rejected (DIG15S date of birth, DIG84 policy
  // effective date — "value never appeared", 2026-10-30). Type another valid date in the same format instead.
  const shown = String(field.stripped || field.text || '').replace(/[[\]]/g, '').trim();
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(shown)) return buildDateValue(shown, n);
  // A field that already shows a value gets that value + "-edited" ("John Smith" -> "John Smith-edited"), so the
  // edited letter reads like real data (user direction 2026-10-18). No brackets (user direction 2026-10-17): they were
  // typed as part of the value and printed in the completed PDF ("RECEIVED OF [QA-EDIT-4] HEREINAFTER…").
  return editedCopyOf(field, editableValues) || `QA-EDIT-${n}`;
}

// The field's own value + "-edited" (before any trailing punctuation), or null when the field has no real value to copy or the copy couldn't be told
// apart from another field's edit — those keep the QA-EDIT-n marker:
// - an empty/placeholder field ("--<<Editable Field>>--", "____", "20__", "-"), or a lone "X" (a checkbox);
// - a value already carrying a test edit (a retry pass re-reading a field that took another field's edit);
// - a value with a bracket in it ("Vehicle [2]"): the typed value is recorded with brackets stripped (inspectAndMaybeEdit's
//   committedMarker), so the copy would never be found as typed;
// - a value longer than 80 characters (a whole editable paragraph — too long to find reliably in the PDF text);
// - a value another editable field also shows, or that ends another field's value ("Smith" / "John Smith"): both
//   edits would read "...Smith-edited", and the PDF/editor checks find an edit by its text, so they'd mix them up
//   (DIG26's exposure rows all show the same type).
function editedCopyOf(field, editableValues) {
  const value = String(field.stripped != null ? field.stripped : field.text || '').replace(/\s+/g, ' ').trim();
  if (!/[A-Za-z0-9]/.test(value) || /<<|>>|editable\s*field|_{2,}/i.test(value) || /^x$/i.test(value)) return null;
  if (/-edited[.,;:!?]*$|QA-EDIT-\d|[[\]]/i.test(value) || value.length > 80) return null;
  // Compared without trailing punctuation: "Smith," and "Smith" would both become "...Smith-edited".
  const [, core, punct] = value.match(/^(.*?)([.,;:!?]*)$/);
  const key = (v) => String(v || '').replace(/\s+/g, ' ').trim().replace(/[.,;:!?]+$/, '').toLowerCase();
  const lc = key(core);
  const others = editableValues.map(key);
  // The field's own value is in the list once, so a second identical one is a clash.
  const sameCount = others.filter((o) => o === lc).length;
  const endsAnother = others.some((o) => o.length > lc.length && o.endsWith(lc) && !/[a-z0-9]/.test(o[o.length - lc.length - 1]));
  if (sameCount > 1 || endsAnother) return null;
  // Trailing punctuation stays at the end ("Smith," -> "Smith-edited,", user direction 2026-10-18).
  return `${core}-edited${punct}`;
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
// A merge field's OWN technical name already says which recipient block it belongs to — e.g.
// "current_additionalRecipients_ext.primaryAddress.city" is unambiguously the ADDITIONAL ("Copy") recipient,
// never the primary ("To") one. Matching purely on VALUE (below) can't see that, so when the additional and
// primary recipients happen to share a value (same city/state/ZIP, or the same name), a Copy field would be
// claimed by the earlier-listed "To ..." known value instead — mislabeling it and flipping its editable
// expectation. CONFIRMED live: INT18 ("current_additionalRecipients_ext.primaryAddress...") matched "To City,
// State, Zip" (editable=No -> false FAIL) in a scenario where the two addresses coincided, but "Copy City,
// State, ZIP" (editable=Yes -> PASS) in one where they differed — same field, same dictionary, inconsistent
// result. Deriving the role here lets assignByKnownValue refuse a known value whose role contradicts the
// field's own name, so the match is driven by identity, not by a value coincidence.
function recipientRoleFromTechnicalName(technicalName) {
  const s = String(technicalName || '').toLowerCase();
  if (s.includes('additionalrecipient')) return 'copy';                               // ...additionalRecipients... -> "Copy" block
  if (/\bfrom\b/.test(s) || /from(name|phone|email|title)/.test(s)) return 'from';     // signature block
  if (s.includes('primaryrecipient') || /(^|[^a-z])recipient([^a-z]|$)/.test(s)) return 'to';
  return null; // no role signal in the name -> don't restrict (unchanged behavior)
}
// The role a known value's dictionary Column-A name implies. Role-less concepts (Claimant Name, Underwriting
// Company, Date of Loss) return null and are never restricted by a field's role.
function knownValueRole(attributeName) {
  const s = String(attributeName || '').toLowerCase();
  if (s.startsWith('copy')) return 'copy';
  if (s.startsWith('to ')) return 'to';
  if (s.startsWith('from ')) return 'from';
  return null;
}

// What a field says it IS, from its own technical name or the label in front of it — 'insured' / 'claimant' / null.
// A field that names its concept may only take a known value of that same concept: the insured is very often the
// letter's recipient too, so "insuredName" / "getInsName" / "Policyholder:" / "Our Insured:" held exactly the To Name
// value and was judged against "To Name" (locked) — a false "should be locked" FAIL (DIG26/DIG49, 2026-10-21; 8
// templates in saved runs, incl. DIG217's insured address judged as "To Street Address"). Claimant fields had the
// same guard since DIG89 (2026-10-14); this generalises it.
function fieldConcept(c) {
  const tech = String(c.technicalName || '');
  const label = String(c.labelContext || '');
  if (/insured|policy\s*holder|insname/i.test(tech) || /(policy\s*holder|insured)\s*:?\s*$/i.test(label)) return 'insured';
  if (/cl(a)?imant|injured/i.test(tech) || /(claimant|injured\s+(?:party|person))(?:'s)?\s*(?:name)?\s*:?\s*$/i.test(label)) return 'claimant';
  return null;
}
const knownValueConcept = (attributeName) => (/insured/i.test(attributeName) ? 'insured' : /claimant/i.test(attributeName) ? 'claimant' : null);

function assignByKnownValue(interactiveChecks, digNumber, knownValues) {
  if (!knownValues.length) return;
  const claimed = new Set();
  for (const c of interactiveChecks) {
    if (c.dictionaryField) continue; // already matched (label-based pass runs first)
    const beforeNorm = normForKnownValueMatch(c.before);
    if (!beforeNorm) continue;
    // What recipient block this field's OWN technical name says it is (see recipientRoleFromTechnicalName) —
    // used just below to refuse a known value from a different block even when the values coincide.
    const fieldRole = recipientRoleFromTechnicalName(c.technicalName);
    const concept = fieldConcept(c);
    // CONFIRMED live 2026-10-06 (DIG162): finding the first NOT-YET-CLAIMED match (the original approach) lets
    // a field whose text equally matches an EARLIER-priority, ALREADY-claimed value (e.g. "To Name" — already
    // claimed by the address block) fall through and settle for a LATER, lower-priority value that happens to
    // share the same text (e.g. "Claimant Name") — wrongly relabeling a salutation that repeats the recipient's
    // own name as the claimant instead. Find the single BEST match first (array priority order, regardless of
    // claimed status), and only act on it if that best match is still free — if it's already taken, this field
    // is genuinely ambiguous between two coincidentally-same-valued concepts, so it's safer to leave it
    // unmatched (flagged for manual review) than to guess a worse-priority concept just because it's unclaimed.
    const best = knownValues.find((kv) => {
      // Never claim a value from a different recipient block than this field's own technical name says it
      // belongs to — this is what stops a "Copy" (additional-recipient) field from grabbing the identically-
      // valued "To ..." row (and vice versa). Role-less known values (Claimant Name, etc.) are never filtered.
      const kvRole = knownValueRole(kv.attributeName);
      if (fieldRole && kvRole && kvRole !== fieldRole) return false;
      // A field that names its concept (insured / claimant — see fieldConcept) only takes a value of that concept.
      // CONFIRMED live 2026-10-14 (DIG89, "climantName" judged as "To Name") and 2026-10-21 (DIG26 "insuredName").
      if (concept && knownValueConcept(kv.attributeName) !== concept) return false;
      // A "City, State, Zip" field holds a ZIP — CONFIRMED live 2026-10-14 (DIG6-WC-AL): a street line
      // ("105 S CLINTON ST") was claimed for "To City, State, Zip" by loose containment against the recipient's
      // address text, then reported as a mismatch against the payload's real city/state/zip.
      if (/city.*state.*zip/i.test(kv.attributeName) && !/\b\d{5}(?:-\d{4})?\b/.test(String(c.before || ''))) return false;
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
async function runInteractiveGeneration(page, { template, scenario, effectiveTestData, recipient, additionalRecipient, fileNamePrefix, s3Session, commentFieldNames, claimNumber, freeFormSamples = [], freeFormFields = [] }) {
  const log = (m) => console.log(`[SmartComm] ${scenario.scenarioId}: ${m}`);

  // Live preview for the Runner UI (Commercial Line Performance test/runner) — a read-only, auto-refreshing
  // The live browser preview (per-scenario screenshots the Runner UI used to poll) was removed: the
  // Interactive browser is now visible on the user's own machine, so a thumbnail is redundant. Kept as a
  // no-op so the unconditional cleanup in the `finally` below stays unchanged.
  const stopLivePreview = () => {};
  try {
    await interactiveEditService.clickInteractiveAndWaitForEditor(page, page.context(), {
      log, scenarioId: scenario.scenarioId,
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

  // Template text a user could edit or delete (outside a locked fragment — see readUnlockedContent). Wording the
  // BA marked "Free Form Editable" is meant to be editable, so it's excluded; anything else is a defect (Jira
  // SMART-1313 fraud language editable, SMART-1339 paragraphs deletable). Read before any field is edited.
  const lockChecks = [];
  let unlockedParagraphCount = 0; // editable paragraphs — free-form areas count toward FREE1's live total
  try {
    const { total, unlocked } = await interactiveEditService.readUnlockedContent(frame);
    unlockedParagraphCount = unlocked.length;
    const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const intended = (t) => freeFormSamples.some((s) => squash(s).length >= 8 && (squash(s).includes(squash(t)) || squash(t).includes(squash(s))));
    const candidates = unlocked.filter((t) => !intended(t));
    // Each candidate (no locked fragment around it in the editor's markup) is then PROVEN by typing into it — one
    // character, deleted again straight away (interactiveEditService.probeParagraphEditable). Only paragraphs that
    // really accepted the typing count as a defect; per user direction 2026-10-17 the markup alone wasn't evidence.
    const short = (t) => `"${t.length > 90 ? `${t.slice(0, 89)}…` : t}"`;
    const confirmed = []; const resisted = []; const unverified = [];
    // Self-check: "typing had no effect" only means something if the probe CAN type. A free-form area the BA made
    // editable on purpose must accept the probe; if it doesn't, the "resisted" results can't be trusted.
    const freeForm = unlocked.filter((t) => intended(t));
    let probeWorks = null;
    if (freeForm.length) {
      const self = await interactiveEditService.probeParagraphEditable(frame, page, freeForm[0]);
      probeWorks = self.typed;
      log(`LOCK1: probe self-check on the free-form area "${freeForm[0].slice(0, 50)}" — ${self.typed ? 'typing worked' : `typing did NOT work (${self.error || 'no effect'}) — "no effect" results below can't be trusted`}`);
    }
    for (const t of candidates.slice(0, 100)) {
      const p = await interactiveEditService.probeParagraphEditable(frame, page, t);
      // Typing that landed somewhere else means the editor wouldn't put the cursor in this paragraph — it didn't change.
      if (p.typed) confirmed.push(t); else if (p.error && !/another part of the document/.test(p.error)) unverified.push(`${t} (${p.error})`); else resisted.push(t);
      if (p.typed && !p.restored) log(`LOCK1: WARNING — typed a test character into ${short(t)} and couldn't confirm it was removed; check the draft.`);
    }
    unverified.push(...candidates.slice(100).map((t) => `${t} (not probed — more than 100 candidates)`));
    if (probeWorks === false) unverified.push(...resisted.splice(0).map((t) => `${t} (no effect, but the probe couldn't type into the free-form area either)`));
    const how = `Checked by clicking into each paragraph that has no locked section around it in the editor and typing one character (removed again immediately).`;
    const notes = [
      resisted.length ? `${resisted.length} more sit outside a locked section but typing into them had no effect, so they're not counted: ${resisted.map(short).join(' | ')}.` : '',
      unverified.length ? `Couldn't verify: ${unverified.map(short).join(' | ')}.` : '',
    ].filter(Boolean).join(' ');
    lockChecks.push(confirmed.length
      ? {
        id: 'LOCK1', description: 'Template text is locked (users can\'t edit or delete it)', expected: 'All template paragraphs locked',
        actual: `Editable: ${confirmed.map(short).join(' | ')}`, result: 'FAIL',
        reason: `${confirmed.length} of ${total} template paragraph(s) accepted typing in the SmartCOMM editor, so a user can change or delete them${confirmed.some((t) => fraudLanguageService.findFraudLanguageInText(t).length || /fraud notice/i.test(t)) ? ' — including fraud language' : ''} (same defect as Jira SMART-1313 / SMART-1339). ${how}${notes ? ` ${notes}` : ''}`,
      }
      : {
        id: 'LOCK1', description: 'Template text is locked (users can\'t edit or delete it)', expected: 'All template paragraphs locked',
        actual: `${total} paragraphs, none editable${unlocked.length - candidates.length ? ` (plus ${unlocked.length - candidates.length} intended free-form area(s))` : ''}`, result: unverified.length ? 'BLOCKED' : 'PASS',
        ...(candidates.length ? { reason: `${how} ${notes}`.trim() } : {}),
      });
    log(`LOCK1: ${candidates.length} paragraph(s) outside a locked section — ${confirmed.length} accepted typing, ${resisted.length} didn't, ${unverified.length} not verified.${confirmed.length ? ` Editable: ${confirmed.map((t) => t.slice(0, 50)).join(' | ')}` : ''}${unverified.length ? ` Not verified: ${unverified.map((t) => t.slice(0, 80)).join(' | ')}` : ''}`);
  } catch (err) {
    log(`LOCK1: couldn't read the editor's fragment locks (${err.message.split('\n')[0]}) — skipped.`);
  }
  if (process.env.DEBUG_EDITOR_DOM) {
    const dump = await frame.evaluate(() => {
      const classes = {};
      document.querySelectorAll('*').forEach((e) => { String(e.className || '').split(/\s+/).filter(Boolean).forEach((c) => { classes[c] = (classes[c] || 0) + 1; }); });
      const editableEls = Array.from(document.querySelectorAll('[contenteditable], [data-editable], [aria-readonly], [readonly]'))
        .slice(0, 80).map((e) => ({ tag: e.tagName, attrs: Array.from(e.attributes).map((a) => `${a.name}=${String(a.value).slice(0, 60)}`), text: (e.textContent || '').replace(/\s+/g, ' ').slice(0, 100) }));
      return { designMode: document.designMode, bodyIsContentEditable: document.body.isContentEditable, classes, editableEls, html: document.body.outerHTML.slice(0, 800000) };
    }).catch((e) => ({ error: e.message }));
    const dumpPath = require('path').join(__dirname, '..', '..', 'results', 'smartComm', 'interactive-diagnostics', `${scenario.scenarioId}_editorDom.json`);
    require('fs').writeFileSync(dumpPath, JSON.stringify(dump, null, 1));
    log(`DEBUG_EDITOR_DOM: dumped the editor DOM to ${dumpPath}`);
  }

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
  let skippedUnselectedChoiceCount = 0;
  // Edit fields LAST-to-FIRST: committing an edit makes Thunderhead re-split/merge the spans at and after that
  // field, shifting every LATER field's position — so with the old first-to-last order a later field's
  // pre-captured positional locator (base.nth(idx)) drifted onto the wrong element (CONFIRMED live 2026-10-13,
  // DIG108: field #13's locator landed on the LOCKED "Benjamin Smith, BDSP" signature span after the earlier
  // fields were edited), and the label-based retry couldn't recover it because the "--<<Editable Field>>--"
  // placeholders all share the same text/label. Going high-index-first means no edit ever disturbs a field we
  // haven't reached yet (an edit only moves elements at/after its own position, which are already done).
  // interactiveChecks is re-sorted back into field order right after the loop, so everything downstream (the
  // known-value passes, the report, the retry loop) sees the exact same ordered array as the old order did.
  // Every editable field's value as first read — buildEditValue copies a field's value into its edit only when no other
  // field shows the same text (the first pass and the retry passes both judge against these original values).
  // Runs once for the page the editor opens on and once per further Document Map page (`encl` set — see
  // editOtherDocumentPages below). A further page's fields are numbered from encl.no * 100 so their QA-EDIT
  // markers never repeat the first page's (INT2.3 types QA-EDIT-203).
  let editableValues = []; // the current page's — the retry pass that follows each first pass reads it too
  const editFieldsFirstPass = async (fields, checks, encl = null) => {
  const base = encl ? encl.no * 100 : 0;
  editableValues = fields.filter((f) => f.editable && !f.inUnselectedChoice).map((f) => f.stripped);
  for (let fi = fields.length - 1; fi >= 0; fi--) {
    const field = fields[fi];
    const n = base + field.idx + 1;
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
      newValue: field.editable ? buildEditValue(field, n, template.digNumber, editableValues) : undefined,
      fallbackValue: `QA-EDIT-${n}`, log,
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
    let match = dataDictionaryService.matchAttributeForField(template.digNumber, {
      labelContext: field.labelContext, technicalName: outcome.technicalName,
    });
    // The label pass can pair a bare "Name:" with "To Name" (DIG37 "insuredName", 2026-10-23) — a field that names
    // itself insured/claimant (fieldConcept) never keeps a recipient-block row; the known-value pass then matches it.
    const concept = fieldConcept({ technicalName: outcome.technicalName, labelContext: field.labelContext });
    if (match && match.row && concept && knownValueConcept(match.row.attributeName) !== concept && /^(to|copy|from)\b/i.test(match.row.attributeName)) match = null;
    // A technical name that ends in an address part ("InsuredState") never keeps a row without that part ("Insured
    // Name" — DIG203, 2026-10-27).
    const addrPart = /(state|city|zip|address)$/i.exec(String(outcome.technicalName || ''));
    if (match && match.row && addrPart && !new RegExp(addrPart[1], 'i').test(match.row.attributeName)) match = null;
    // A "...State" row never keeps a field that shows something other than a state (DIG71 2026-10-28: "Insured:" showing
    // "MARTHA ANTOLICK" paired with "Policy Base State" by the mapping doc's label, then failed on that row's editability).
    const shown = String(outcome.before || '').replace(/[[\]]/g, '').trim().toLowerCase();
    if (match && match.row && /state$/i.test(match.row.attributeName) && shown && !stateName(shown)) match = null;
    const dictRow = match && match.row;
    checks.push({
      id: encl ? `INT${encl.no}.${field.idx + 1}` : `INT${n}`,
      idx: base + field.idx, // unique across pages — the PDF checks pair neighbouring fields by idx
      ...(encl ? { documentPage: encl.title } : {}),
      label: `${encl ? `[${encl.title}] ` : ''}${pickFieldLabel(n, field, outcome, dictRow)}`,
      labelContext: field.labelContext || null, technicalName: outcome.technicalName || null,
      expectedEditable: field.editable, observedChanged: outcome.changed, result,
      before: outcome.before, after: outcome.after, committedMarker: outcome.committedMarker, reason: outcome.note,
      dictionaryField: dictRow ? dictRow.attributeName : null,
      dictionaryEditable: dictRow ? dictRow.editable : null,
      dictionaryMatchedOn: match ? match.matchedOn : null,
      dictionaryAgrees: dictRow && dictRow.editable !== null ? dictRow.editable === field.editable : null,
    });
  }
  // Built last-to-first above (to beat Thunderhead's span drift) — restore natural field order so the
  // known-value passes' "first match wins" logic, the report, and the retry loop all see fields in order.
  checks.sort((a, b) => a.idx - b.idx);
  };
  await editFieldsFirstPass(fields, interactiveChecks);
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
    // The claim's insured — after the To rows on purpose: a label-less field holding the same name as the recipient
    // is the address block (To Name); a field that names itself insured skips the To rows (fieldConcept) and lands here.
    effectiveTestData && effectiveTestData.insuredName && { attributeName: 'Insured Name', value: effectiveTestData.insuredName },
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
  const normalizeLabelForRematch = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // Same per-page split as editFieldsFirstPass: `checks` is one page's own checks, `base` its field numbering.
  const retryUneditedFields = async (checks, base = 0) => {
  let retryRound = 0;
  // CONFIRMED live 2026-10-04 (DIG53): a field whose committed value shows up NOWHERE on the page afterward
  // (interactiveEditService's own `vanished` flag — a non-text-typed field silently rejecting free text, not
  // a timing fluke) can never pass by retrying the exact same fill-text strategy. Keyed by this field's OWN
  // position in `interactiveChecks` (stable — that array is built once, in order, during the first pass, and
  // never reordered) rather than by a live DOM idx, which is exactly what can no longer be trusted round to
  // round.
  const hopelessIdx = new Set();
  // The authoritative "what still needs work" list, driven entirely by OUR OWN interactiveChecks state (never
  // by a live DOM read) — same reasoning as the user-confirmed fix above it: trust what we already recorded,
  // don't re-derive it from a page that may have reflowed.
  function pendingRetryTargets() {
    return checks
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
        // ...and only while it still shows this field's own original value: DIG27's loss-location retry (2026-10-27)
        // took the old position, now the year field, and typed over its edit.
        const positional = freshFields.find((f) => f.idx === t.i && !claimed.has(f.idx));
        const sameValueThere = positional && normalizeLabelForRematch(String(positional.stripped || positional.text || '').replace(/[[\]]/g, ''))
          === normalizeLabelForRematch(String(t.c.before || '').replace(/[[\]]/g, ''));
        if (positional && positional.editable && sameValueThere) field = positional;
      }
      if (field) { claimed.add(field.idx); relocated.push({ field, target: t }); } else { stillMissing.push(t); }
    }
    log(`Second pass #${retryRound}: ${targets.length} editable field(s) still not edited (${relocated.length} relocated, ${stillMissing.length} could not be relocated this round) — retrying: ${relocated.map(({ target }) => `#${base + target.i + 1}`).join(', ')}`);
    for (const { field, target } of relocated) {
      const n2 = base + target.i + 1;
      // A field that swallowed the text edit and looks numeric (SSN / ZIP / phone / amount, or a number-only value) is
      // retried with digits — DIG15's Claimant SSN rejected "QA-EDIT-4" every time ("value never appeared", a false FAIL
      // 2026-10-23). Four digits, so a last-4 / short field accepts it too.
      const prior = target.c;
      const looksNumeric = /ssn|social|zip|postal|phone|fax|amount|number|count|digits|year/i.test(`${prior.technicalName || ''} ${prior.label || ''} ${prior.dictionaryField || ''}`)
        || /^\[?\s*[\d\s().-]*\]?$/.test(String(prior.before || ''));
      const rejectedText = /never appeared|vanish/i.test(prior.reason || '');
      // A time field ("timeBeganWork", DIG201) rejects text too — it gets a time.
      const looksTime = /time(?!s)/i.test(`${prior.technicalName || ''} ${prior.dictionaryField || ''}`);
      const retryValue = rejectedText && looksTime ? buildTimeValue(null, n2) : rejectedText && looksNumeric ? String(1000 + n2).slice(-4) : buildEditValue(field, n2, template.digNumber, editableValues);
      const outcome = await interactiveEditService.inspectAndMaybeEdit(frame, page, field, { newValue: retryValue, fallbackValue: `QA-EDIT-${n2}`, log });
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
          // A typed-field that silently drops even a correctly-shaped value (DIG84 policy effectiveDate took
          // "04/13/2026" and showed nothing, 2026-10-30) can't be edited by this tool — that's unverified, not a
          // template defect.
          existing.result = 'BLOCKED';
          existing.reason += ' — this tool can\'t edit this field type, so its editability isn\'t verified (not counted as a template defect).';
          hopelessIdx.add(target.i);
          log(`field #${n2}: giving up after this attempt — value vanishes completely, not just a timing/retry issue.`);
        }
      }
    }
    targets = pendingRetryTargets();
  }
  return { retryRound, targets, hopelessIdx };
  };
  const { retryRound, targets, hopelessIdx } = await retryUneditedFields(interactiveChecks);

  // A template made of several pages (enclosures) shows them one at a time; the Document Map lists them all
  // (per user direction 2026-10-29, DIG122A: 5 pages). Every further page is opened, left to load fully, and
  // edited exactly like the first (same first pass + retries, plus its free-form boxes); each page's own
  // edits are checked as still there before moving on, since the editor only shows one page's fields at a
  // time. Ends back on the first page, so the steps below (free-form boxes, final read, Save/Complete) see
  // the page they always have. A single-page document lists one entry (or none) and skips all of this.
  const otherPageOverlayEdits = [];
  const otherPageUnedited = [];
  const docPages = await interactiveEditService.listDocumentMapEntries(frame);
  if (docPages.length > 1) {
    log(`Document Map: ${docPages.length} pages — ${docPages.join(' | ')}`);
    for (let p = 1; p < docPages.length; p++) {
      const encl = { no: p + 1, title: docPages[p] };
      if (!await interactiveEditService.openDocumentMapEntry(frame, page, p)) {
        log(`Document Map: page ${encl.no} "${encl.title}" never finished loading — its fields are not edited.`);
        interactiveChecks.push({ id: `INT${encl.no}`, idx: -1, documentPage: encl.title, label: `[${encl.title}] page`, expectedEditable: null, result: 'BLOCKED', reason: `Page ${encl.no} of the document ("${encl.title}") didn't finish loading from the Document Map, so its fields couldn't be edited.` });
        continue;
      }
      let pageFields = await interactiveEditService.readMergeFields(frame);
      if (!pageFields.length) { await page.waitForTimeout(2000); pageFields = await interactiveEditService.readMergeFields(frame); }
      log(`Document Map page ${encl.no} "${encl.title}": ${pageFields.length} merge field(s) (${pageFields.filter((f) => f.editable).length} editable)`);
      const pageChecks = [];
      await editFieldsFirstPass(pageFields, pageChecks, encl);
      const r = await retryUneditedFields(pageChecks, encl.no * 100);
      otherPageUnedited.push(...r.targets.map((t) => t.c), ...[...r.hopelessIdx].map((i) => pageChecks[i]));
      otherPageOverlayEdits.push(...(await editOverlayFields(frame, page, log, encl.no * 100)).map((e) => ({ ...e, documentPage: encl.title })));
      // Still there after the whole page is done (same test as the final read further down does for page 1).
      const finalTexts = (await interactiveEditService.readMergeFields(frame)).map((x) => String(x.stripped || x.text || ''));
      for (const c of pageChecks) {
        const m = String(c.committedMarker || c.after || '').replace(/[[\]]/g, '').trim();
        if (c.observedChanged === true && m && !finalTexts.some((t) => t.includes(m))) c.goneBeforeComplete = true;
      }
      interactiveChecks.push(...pageChecks);
      log(`Document Map page ${encl.no}: ${pageChecks.filter((c) => c.result === 'PASS').length} passed, ${pageChecks.filter((c) => c.result === 'FAIL').length} failed (${pageChecks.length} field(s))`);
    }
    if (!await interactiveEditService.openDocumentMapEntry(frame, page, 0)) log('Document Map: the first page did not finish reloading — continuing anyway.');
  }
  // Still failing after every retry for a reason that's about the TEST's own editing, not the template — the typed value
  // landed in another field, or no editor opened — is BLOCKED (not verifiable), not FAIL: DIG161's Claimant Name was
  // reported as a defect when the test simply couldn't edit it (QA review 2026-10-26). A field that took the edit but
  // the value vanished stays FAIL — that can be a real non-editable field.
  for (const c of interactiveChecks) {
    if (c.result !== 'FAIL' || !/landed in a different field|did not open a recognized editor/i.test(c.reason || '')) continue;
    c.result = 'BLOCKED';
    c.reason = `${c.reason} — the test couldn't edit this field, so its editability isn't verified (not a template defect by itself; check it by hand).`;
  }
  if (retryRound) {
    const passedAfterRetry = interactiveChecks.filter((c) => c.result === 'PASS').length;
    const failedAfterRetry = interactiveChecks.filter((c) => c.result === 'FAIL').length;
    log(`interactive field checks after ${retryRound} retry pass(es): ${passedAfterRetry} passed, ${failedAfterRetry} failed (${interactiveChecks.length} total)`);
  }
  // `targets` here is the FINAL post-loop pendingRetryTargets() result — still-authoritative, driven by our
  // own interactiveChecks state, not a live DOM read. Genuinely unedited for THIS purpose either way: Complete
  // Document doesn't care why a field never got filled, only that it didn't.
  const trulyUneditedCount = targets.length + hopelessIdx.size + otherPageUnedited.length;
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
  // The completed PDF + .json survive in the S3 archive only ~15s before a downstream filing job takes them
  // (CONFIRMED live 2026-10-13 — see s3AdminService.watchArchiveForIdentifier), often less time than Complete
  // Document + reading Document Properties takes. So the archive is watched from just BEFORE Complete Document,
  // on the shared S3 page, and handed the identifier once it's known; whatever the watch didn't catch still
  // falls back to the regular search below.
  const overlayEdits = [...await editOverlayFields(frame, page, log), ...otherPageOverlayEdits];
  let resolveIdentifier;
  const identifierKnown = new Promise((resolve) => { resolveIdentifier = resolve; });
  const archiveWatch = s3Session.withPage((s3Page) => s3AdminService.watchArchiveForIdentifier(s3Page, identifierKnown, documentService.DOWNLOAD_DIR, { log }))
    .catch((err) => { log(`[S3] archive watch failed (${err.message.split('\n')[0]}) — falling back to searching after completion.`); return null; });
  let identifier;
  // The FINAL value of every field, read right before Save / Complete Document (per user direction 2026-10-17): a later
  // edit can replace an earlier one — DIG26's exposure rows share one value, and fields are edited last-to-first, so
  // row 1's edit (QA-EDIT-8) replaced rows 2-3's (QA-EDIT-10..13) in the editor. The PDF is checked against these.
  // Matched by CONTENT, never by position: editing changes a field's spans, so positions shift (a first version paired
  // fields with their neighbours' values). A field was replaced only if its own typed value is in NO field any more;
  // the value that replaced it then comes from the fields sharing its technical name whose values are still there.
  try {
    const finalFields = await interactiveEditService.readMergeFields(frame);
    const finalTexts = finalFields.map((x) => String(x.stripped || x.text || ''));
    const holds = (marker) => {
      const m = String(marker || '').replace(/[[\]]/g, '').trim();
      if (!m) return true;
      const re = /^qa-edit-\d+$/i.test(m) ? new RegExp(`${m}(?!\\d)`, 'i') : null;
      return finalTexts.some((t) => (re ? re.test(t) : t.includes(m)));
    };
    for (const c of interactiveChecks) {
      if (c.documentPage || c.observedChanged !== true || holds(c.committedMarker || c.after)) continue; // other pages: checked on their own page above
      c.goneBeforeComplete = true;
      const kin = interactiveChecks.filter((o) => o !== c && o.observedChanged === true && o.technicalName && o.technicalName === c.technicalName && holds(o.committedMarker || o.after));
      c.replacedBeforeComplete = kin.length ? kin.map((o) => String(o.committedMarker || o.after).replace(/[[\]]/g, '')) : null;
      // No same-named field: what the field with this SAME label holds now (DIG108 "…storage charges starting" /
      // DIG36 "…deductible in the amount of $" — a later edit typed into this spot as positions shifted while editing).
      if (!c.replacedBeforeComplete && String(c.labelContext || '').length >= 8) {
        const sameSpot = finalFields.find((x) => x.labelContext === c.labelContext && x.editable && x.stripped && !/<<|editable/i.test(x.stripped));
        if (sameSpot) c.replacedBeforeComplete = [String(sameSpot.stripped).replace(/[[\]]/g, '').trim()];
      }
      log(`${c.id}: its edit "${c.committedMarker}" is no longer in the editor before completing${c.replacedBeforeComplete ? ` — that spot now holds ${c.replacedBeforeComplete.join(' / ')}${kin.length ? ' (same field)' : ' (same label — a later edit typed here)'}` : ' — no field holds a replacement'}`);
    }
  } catch (e) { log(`couldn't re-read the fields' final values before completing (${e.message.split('\n')[0]})`); }
  try {
    await interactiveEditService.saveChanges(page, { log });
    await interactiveEditService.completeDocument(page, { log, scenarioId: scenario.scenarioId });
    identifier = await interactiveEditService.readDocumentPropertiesIdentifier(page);
  } catch (err) {
    resolveIdentifier(null);
    await archiveWatch;
    // CONFIRMED live 2026-10-06 (DIG200, "Content is not allowed in prolog"): this throw previously lost
    // every field this scenario had already edited/validated up to this exact point — runScenario's own
    // catch block only had err.message to save, so a Complete-Document failure left NOTHING to diagnose WHY
    // beyond the raw ClaimCenter error text (not our own values, not which fields were touched). Attaching
    // the in-progress interactiveChecks (and choicesApplied) to the error itself lets the ERROR result still
    // carry them through to the saved report, instead of this scenario's whole edit history vanishing.
    err.interactiveChecks = interactiveChecks;
    err.choicesApplied = choicesApplied;
    err.lockChecks = lockChecks;
    throw err;
  }
  resolveIdentifier(identifier);
  log(`Document Properties Identifier: ${identifier}`);
  const watched = await archiveWatch;

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
    const pdfResult = watched && watched.pdf
      ? { downloaded: watched.pdf }
      : await s3AdminService.downloadFirstValidPdf(s3Page, identifier, documentService.DOWNLOAD_DIR, { log });
    if (pdfResult.error) {
      // Tell "SmartCOMM got the request" apart from "nothing reached S3 at all" — CONFIRMED live 2026-10-13
      // (DIG5-GL-TN, DIG5-AUTO-TN): the input payload landed but no PDF/.json was seen in output/archive, which is
      // only a hand-off point (a downstream filing job removes each PDF + .json pair once it picks it up).
      const inputHits = await s3AdminService.searchSmartCommPayload(s3Page, identifier, { log }).catch(() => []);
      const where = inputHits.length
        ? ' SmartCOMM DID receive this document\'s request (its input payload is in S3 > smartcomm > input), but the completed PDF never showed up in output/archive while the tool was polling — either it wasn\'t produced, or it arrived late and the downstream filing job took it first. Check the claim\'s documents in ClaimCenter.'
        : ' Its input payload isn\'t in S3 > smartcomm > input either.';
      throw new Error(`INTERACTIVE_S3_NOT_FOUND: ${pdfResult.error}${where}`);
    }
    const finalPath = path.join(documentService.DOWNLOAD_DIR, `${fileNamePrefix}_interactive.pdf`);
    fs.renameSync(pdfResult.downloaded.localPath, finalPath);
    if (overlayEdits.length) lockChecks.push(...await buildOverlayChecks(overlayEdits, finalPath, log, freeFormFields));

    // Co-located filing metadata (<identifier>.json, the SAME archive folder as the PDF) — per user direction
    // 2026-10-13. Unlike the input review-case payload fetched below (only sometimes present — ~2/7 of recent
    // docs in a live spot-check), this .json is ALWAYS alongside the PDF, so it's a reliable confirm of the
    // fetched document's template identity (Description carries the DIG) and claim # (FileNumber). See
    // s3AdminService.downloadArchiveMetadataJson + buildMetadataChecks.
    let metadataChecks = [];
    try {
      const metaResult = watched && watched.json
        ? { metadata: JSON.parse(fs.readFileSync(watched.json.localPath, 'utf8')), fileName: watched.json.fileName }
        : await s3AdminService.downloadArchiveMetadataJson(s3Page, identifier, documentService.DOWNLOAD_DIR, { log });
      if (metaResult.error) {
        log(`archive filing metadata: ${metaResult.error}`);
        metadataChecks = [metadataUnavailableCheck(metaResult.error)];
      } else {
        log(`archive filing metadata: ${JSON.stringify(metaResult.metadata)}`);
        metadataChecks = buildMetadataChecks(metaResult.metadata, { template, claimNumber });
      }
    } catch (err) {
      log(`archive filing metadata fetch failed (${err.message}) — metadata checks BLOCKED for this scenario.`);
      metadataChecks = [metadataUnavailableCheck(err.message)];
    }

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
      } else if (c.dictionaryAgrees === false && !c.dictionaryEditable && c.expectedEditable && /^policy\s*(number|no\.?)$/i.test(String(c.dictionaryField).trim())) {
        // QA's own bugs say Policy Number must be editable (SMART-1417 DIG9, DIG40, DIG47, DIG58, DIG79) — the
        // dictionary's "locked" for it is stale. 2026-10-30 bulk run: 14 templates FAILed on this alone.
        c.result = 'PASS';
        c.reason = 'Policy Number is editable. The Data Dictionary still says locked, but QA\'s Jira bugs (SMART-1417 and others) require it to be editable, so editable is correct.';
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
      // Fraud language must never be editable (Jira SMART-1313, re-opened 2026-10). It has no Data Dictionary
      // row, so an editable fraud paragraph would otherwise sit above as an unmatched SKIPPED field.
      if (c.expectedEditable && String(c.before || '').length >= 40
        && fraudLanguageService.findFraudLanguageInText(String(c.before)).length) {
        c.result = 'FAIL';
        c.reason = 'This field holds fraud-notice wording (Fraud Language sheet) and is EDITABLE in the live session — fraud language must be locked (same defect as Jira SMART-1313).';
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

    // Overlay forms compare their blanks row by row (OVL-M, buildOverlayChecks); every other template here.
    if (!overlayEdits.length) {
      const free = freeFormBlanksCheck(freeFormFields, interactiveChecks, unlockedParagraphCount);
      if (free) lockChecks.push(free);
    }

    return { pdfPath: finalPath, interactiveChecks, metadataChecks, lockChecks, dictionaryReference, payload, rawPayloadRoot, choicesApplied, trackedFields, unmatchedTrackedFields };
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

// ── Whole-document checks QA found by eye (Jira SMART-1522, DIG220, 2026-10-21) ─────────────────────────────
// PAGE1: a blank page — DIG220 prints "Fraud Language Continued on Next Page..." and then an empty page 2. A page with
// no text layer may still be a picture of text (overlay/scanned pages), so it only counts as blank when OCR of the
// rendered page reads nothing either. (pdf.js's getOperatorList would tell drawn-vs-empty directly, but under Node it
// loads fonts through `document` and crashes the process from a worker callback no try/catch can reach.)
// FRAUD0: fraud language printed although the mapping doc never asks for it. The fraud checks only ran when the doc
// mentioned fraud language, so wording the doc doesn't specify printed unchecked (QA: "Fraud Language is not listed
// in the mapping document but is showing up").
// OCR output ("=== page N" then its lines, see ocr/ocr-pdf.ps1) → the recognised text of each page.
function ocrPages(ocrText) {
  const out = [];
  let cur = null;
  for (const line of String(ocrText || '').split(/\r?\n/)) {
    const m = /^=== page (\d+)/.exec(line);
    if (m) { cur = Number(m[1]) - 1; out[cur] = ''; } else if (cur !== null) out[cur] += `${line} `;
  }
  return out.map((t) => (t || '').trim());
}
async function buildPageAndFraudChecks(pdfPath, text, { mentionsFraudLanguage }) {
  const checks = [];
  const pages = (await require('./pdfLayoutText').extractPositionedItems(pdfPath).catch(() => []))
    .map((p, i) => ({ n: i + 1, text: p.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim() }));
  const noText = pages.filter((p) => !p.text);
  if (pages.length && noText.length < pages.length) {
    const ocr = noText.length ? ocrPages(await require('./pdfOcrService').ocrPdfText(pdfPath).catch(() => null)) : [];
    const ocrRan = noText.length > 0 && ocr.length > 0;
    const blank = ocrRan ? noText.filter((p) => !(ocr[p.n - 1] || '').replace(/[^A-Za-z0-9]/g, '')) : [];
    const why = blank.map((b) => {
      const prev = pages[b.n - 2];
      return prev && /continued on (?:the )?next page/i.test(prev.text)
        ? `page ${b.n} is blank, though page ${b.n - 1} says "Continued on Next Page"` : `page ${b.n} is blank`;
    });
    const unconfirmed = noText.length && !ocrRan;
    checks.push({
      id: 'PAGE1', description: 'Every page of the document has content (no blank pages)',
      expected: 'No blank pages',
      actual: blank.length ? why.join('; ') : unconfirmed ? `page(s) ${noText.map((p) => p.n).join(', ')} have no text` : `${pages.length} page(s), none blank`,
      result: blank.length ? 'FAIL' : unconfirmed ? 'BLOCKED' : 'PASS',
      reason: blank.length ? `The generated PDF has an empty page — ${why.join('; ')} (same defect as Jira SMART-1522).`
        : unconfirmed ? 'These pages have no text layer and OCR wasn\'t available to tell a blank page from a picture — check them visually.' : '',
    });
  }
  if (!mentionsFraudLanguage) {
    const found = fraudLanguageService.findFraudLanguageInText(String(text || ''));
    // A Fraud Language sheet row (any state) printed word-for-word — the sheet match decides, the extractor shows it.
    if (found.length) {
      const what = fraudLanguageService.extractFraudLanguageFromText(String(text || '')) || found[0].fraudLanguage;
      checks.push({
        id: 'FRAUD0', description: 'Fraud language prints only where the mapping doc calls for it',
        expected: 'No fraud language (the mapping doc doesn\'t mention it)', actual: `Printed: "${String(what).slice(0, 120)}…"`,
        result: 'FAIL',
        reason: 'The PDF prints fraud language, but this template\'s mapping doc doesn\'t list it — either the doc is missing it or the template shouldn\'t print it (same question as Jira SMART-1522).',
      });
    }
  }
  return checks;
}

// ── PDF-overlay forms: checkboxes and blank lines (DIG220, per user direction 2026-10-21) ─────────────
// readMergeFields only sees merge spans, so on an overlay form (a page image with typed-into boxes on top) every
// checkbox and blank line went untouched — DIG220 has 162 checkboxes and 24 free-form lines its mapping doc marks
// editable ("Checkboxes are editable" / "Free Form/Editable"), and the run edited 3 fields. Each unlocked overlay box
// gets a value: "X" in a checkbox-sized box, a short unique marker ("OV7") in a text line — short because the Height/
// Distance cells are ~40pt wide. Typed before Save Changes, so the values are committed with everything else.
const OVERLAY_CHECKBOX_MAX_PX = 16;
const isOverlayCheckbox = (f) => f.width <= OVERLAY_CHECKBOX_MAX_PX && f.height <= OVERLAY_CHECKBOX_MAX_PX;
// `textStart`: a further Document Map page numbers its lines from encl.no * 100 (OV401…), so values never repeat across pages.
async function editOverlayFields(frame, page, log, textStart = 0) {
  const fields = await interactiveEditService.readOverlayTextFields(frame);
  if (!fields.length) return [];
  const edits = [];
  let textN = textStart;
  for (const f of fields) {
    const kind = isOverlayCheckbox(f) ? 'checkbox' : 'text';
    const value = kind === 'checkbox' ? 'X' : `OV${++textN}`;
    const r = await interactiveEditService.typeIntoOverlayField(frame, page, f, value);
    edits.push({ ...f, kind, value, typed: r.typed, landedInNeighbour: !!r.landedInNeighbour, error: r.error || null });
  }
  const sum = (k) => { const all = edits.filter((e) => e.kind === k); return `${all.filter((e) => e.typed).length}/${all.length}`; };
  log(`overlay form: typed into ${sum('checkbox')} checkbox(es) ("X") and ${sum('text')} free-form line(s) ("OVn")`);
  return edits;
}

// An overlay box in PDF points (y up from the bottom), from its box in the overlay image's pixels.
function overlayBoxInPdf(pg, e) {
  const sx = pg.viewW / (e.pageW || 816);
  const sy = pg.viewH / (e.pageH || 1056);
  return { x0: e.left * sx, x1: (e.left + e.width) * sx, yTop: pg.viewH - e.top * sy, yBottom: pg.viewH - (e.top + e.height) * sy };
}
// Did the value print inside its own box? Text items whose start and baseline fall in the box (a few points of slack
// for font metrics), joined left to right.
function overlayValuePrinted(pg, e) {
  if (!pg) return false;
  const b = overlayBoxInPdf(pg, e);
  const inBox = pg.items.filter((it) => it.x >= b.x0 - 3 && it.x <= b.x1 + 3 && it.y >= b.yBottom - 4 && it.y <= b.yTop + 2);
  return inBox.sort((a, c) => a.x - c.x).map((it) => it.str).join('').replace(/\s+/g, '').includes(e.value);
}
// The printed label for a box's row: the nearest run of text to its left on the same line ("Sitting", "0-10 lbs",
// "COMPLETED BY:"). The PDF splits labels into letter fragments ("Si|tt|i|n|g"), so touching fragments are joined
// and a gap wider than 8pt starts a new piece; our own typed values never count as a label.
const isOurValue = (it) => /^(X|OV\d+)$/.test(it.str.trim());
// Items on ONE printed line — the line nearest `targetY` among `candidates` (rows are ~12pt apart, so a fixed
// tolerance alone mixed two rows: "1126--2550 lbslbs").
function nearestLine(candidates, targetY) {
  if (!candidates.length) return [];
  const y = candidates.reduce((best, it) => (Math.abs(it.y - targetY) < Math.abs(best - targetY) ? it.y : best), candidates[0].y);
  return candidates.filter((it) => Math.abs(it.y - y) <= 1.5).sort((a, c) => a.x - c.x);
}
// Joins one line's fragments; a gap wider than 8pt starts a new piece. `last` keeps only the final piece.
function joinFragments(items, { last = false } = {}) {
  const pieces = [];
  let end = -Infinity;
  for (const it of items) {
    if (!pieces.length || it.x - end > 8) pieces.push('');
    pieces[pieces.length - 1] += (pieces[pieces.length - 1] && it.x - end > 1 ? ' ' : '') + it.str;
    end = it.x + it.w;
  }
  const out = last ? pieces.slice(-1) : pieces;
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
// Same rule as the PDF mapping doc's own blanks (templateRequirementService.labelLeftOfBox), so a doc line and its
// live box get the same name: text running into the box ("VACATION: ____ days per year", DIG217) is cut at the box,
// and a tall box is named by its top line ("FACTS:", DIG209).
function overlayRowLabel(pg, e) {
  if (!pg) return '';
  const b = overlayBoxInPdf(pg, e);
  return templateRequirementService.labelLeftOfBox(pg.items, b.x0, b.yBottom, b.yTop, isOurValue);
}
// The column header above a box ("Height", "Distance"): the nearest printed line above it that overlaps its width.
function overlayColumnHeader(pg, e) {
  if (!pg) return '';
  const b = overlayBoxInPdf(pg, e);
  // Text starting inside the box's own column only — a sentence that merely runs across above it isn't a header.
  const above = pg.items.filter((it) => it.y > b.yTop && it.y - b.yTop < 120 && it.x >= b.x0 - 4 && it.x < b.x1 + 2 && !isOurValue(it));
  return joinFragments(nearestLine(above, b.yTop));
}

// A row label reduced for comparing the mapping doc's wording with the printed form's: letters/digits only, first 20
// (the printed label can be cut at a line wrap — "j. Working with biohazards such as blood borne pathogens,").
const labelKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);

// FREE1 — the letter-template counterpart of OVL-M: the mapping doc's "Free Form/Editable" blanks need somewhere to
// type in the live session. A missing DATA field already fails its own "Value for …" check against the PDF; a missing
// blank has no value to look for, so nothing caught it (Jira SMART-1522 Issue #2). Lenient on purpose: in letters a
// free-form item can be a pre-filled editable field ("Type of Loss:") or a whole editable paragraph ("We are denying
// your claim because…"), so the live total is every editable field + every unlocked paragraph, and only a doc with
// MORE free-form items than that fails. Measured 2026-10-21 on 62 templates' saved runs: a stricter "empty fields
// only" count failed 27 of them, nearly all false; this one flags only overlay forms with whole sets of lines missing.
// Labels only NAME the likely-missing items; they don't decide the result.
function freeFormBlanksCheck(mappingFreeForm, interactiveChecks, unlockedParagraphs = 0) {
  if (!mappingFreeForm || !mappingFreeForm.length) return null;
  const live = (interactiveChecks || []).filter((c) => c.expectedEditable);
  const liveTotal = live.length + unlockedParagraphs;
  const tail = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(-15);
  const unseen = mappingFreeForm.filter((f) => tail(f.label) && !live.some((c) => tail(c.labelContext) && (tail(c.labelContext).endsWith(tail(f.label)) || tail(f.label).endsWith(tail(c.labelContext)))));
  const missing = mappingFreeForm.length - liveTotal;
  const names = (missing > 0 ? (unseen.length ? unseen : mappingFreeForm) : []).map((f) => `"${truncateLabel(f.label || '(unlabelled)', 60)}"`);
  return {
    id: 'FREE1',
    description: 'Every "Free Form/Editable" item in the mapping doc has an editable place in the live session',
    expected: `${mappingFreeForm.length} editable item(s)`, actual: `${liveTotal} editable item(s) (${live.length} field(s), ${unlockedParagraphs} paragraph(s))`,
    result: missing > 0 ? 'FAIL' : 'PASS',
    reason: missing > 0
      ? `The mapping doc has ${mappingFreeForm.length} free-form item(s) but the live session has only ${liveTotal} editable place(s) — at least ${missing} missing, likely among: ${names.slice(0, 8).join('; ')}${names.length > 8 ? '; …' : ''} (same kind of defect as Jira SMART-1522).`
      : '',
  };
}

async function buildOverlayChecks(edits, pdfPath, log, mappingFreeForm = []) {
  const pages = await require('./pdfLayoutText').extractPositionedItems(pdfPath).catch(() => []);
  // A further Document Map page (e.documentPage) numbers its pages from 0 again, while the PDF runs all of them
  // in one sequence — so its PDF page is the one where the value printed in this box (DIG122A 2026-10-29: every
  // enclosure's boxes were checked against PDF page 1). Not printed anywhere: its own number, as before.
  for (const e of edits) {
    e.pdfPage = e.page;
    if (e.documentPage && e.typed) {
      const hit = pages.findIndex((pg, p) => p >= e.page && overlayValuePrinted(pg, e));
      if (hit >= 0) e.pdfPage = hit;
    }
    e.pageKey = `${e.documentPage || ''}#${e.pdfPage}`;
    e.label = overlayRowLabel(pages[e.pdfPage], e);
    e.printed = e.typed && overlayValuePrinted(pages[e.pdfPage], e);
  }
  // "Sitting, box 3 of 4" — boxes sharing a row (same top) are numbered left to right.
  for (const e of edits.filter((x) => x.kind === 'checkbox')) {
    const row = edits.filter((x) => x.kind === 'checkbox' && x.pageKey === e.pageKey && Math.abs(x.top - e.top) <= 2).sort((a, c) => a.left - c.left);
    e.where = `${e.label || `row at ${Math.round(e.top)}px`}, box ${row.indexOf(e) + 1} of ${row.length}`;
  }
  const checks = [];
  edits.filter((e) => e.kind === 'text').forEach((e, i) => {
    // A field sitting in a table column ("0-10 lbs" under "Height") is named by both; a lone line by its label.
    const header = overlayColumnHeader(pages[e.pdfPage], e);
    const label = [e.label, header && header !== e.label && !/^_+$/.test(header) ? header : ''].filter(Boolean).join(' / ')
      || `line at ${Math.round(e.left)},${Math.round(e.top)}px`;
    checks.push({
      id: `OVL-T${i + 1}`,
      description: `Free-form line "${label}" (${e.documentPage ? `${e.documentPage}, ` : ''}page ${e.pdfPage + 1}) can be typed into and prints what was typed`,
      expected: e.value,
      actual: !e.typed ? (e.landedInNeighbour ? 'Typed text went into the next box' : 'Could not type into it') : e.printed ? e.value : 'Not printed in its box',
      result: e.typed && e.printed ? 'PASS' : !e.typed && e.landedInNeighbour ? 'BLOCKED' : 'FAIL',
      reason: !e.typed && e.landedInNeighbour
        ? `The click landed in a neighbouring box (they sit very close), so "${e.value}" went there — the test's own click, not a template defect; check this line by hand.`
        : !e.typed
        ? `The mapping doc marks this line "Free Form/Editable", but typing into it in the editor didn't take${e.error ? ` (${e.error})` : ''}.`
        : e.printed ? '' : `"${e.value}" was typed into this line in the editor but isn't printed inside its box in the generated PDF.`,
    });
  });
  // Lines the mapping doc has but the live form doesn't (Jira SMART-1522: no "If yes, please describe" line after DIG220
  // question j). Counted per row label — the Height and Distance blanks share "0-10 lbs".
  const liveByKey = {};
  for (const e of edits.filter((x) => x.kind === 'text')) liveByKey[labelKey(e.label)] = (liveByKey[labelKey(e.label)] || 0) + 1;
  const docByKey = {};
  // Only when the live lines could be named (their labels come from the PDF) — otherwise every doc line would "miss".
  const liveText = edits.filter((x) => x.kind === 'text');
  const named = liveText.filter((x) => labelKey(x.label)).length;
  if (liveText.length && named / liveText.length >= 0.5) {
    for (const f of mappingFreeForm) (docByKey[labelKey(f.label)] = docByKey[labelKey(f.label)] || { label: f.label, n: 0 }).n++;
  }
  Object.values(docByKey).filter((d) => labelKey(d.label) && d.n > (liveByKey[labelKey(d.label)] || 0)).forEach((d, i) => {
    const live = liveByKey[labelKey(d.label)] || 0;
    checks.push({
      id: `OVL-M${i + 1}`,
      description: `Free-form line "${truncateLabel(d.label, 70)}" from the mapping doc is on the live form`,
      expected: `${d.n} line(s)`, actual: `${live} line(s)`, result: 'FAIL',
      reason: `The mapping doc has ${d.n} "Free Form/Editable" blank(s) for "${d.label}", but the live form has ${live} — the user has nowhere to write it (same defect as Jira SMART-1522).`,
    });
  });
  const pagesWithBoxes = [...new Set(edits.filter((e) => e.kind === 'checkbox').map((e) => e.pageKey))];
  for (const [gi, key] of pagesWithBoxes.entries()) {
    const boxes = edits.filter((e) => e.kind === 'checkbox' && e.pageKey === key);
    const p = boxes[0].pdfPage;
    const where = boxes[0].documentPage ? `${boxes[0].documentPage}, page ${p + 1}` : `page ${p + 1}`;
    const notTyped = boxes.filter((e) => !e.typed);
    const notPrinted = boxes.filter((e) => e.typed && !e.printed);
    const list = (xs) => xs.slice(0, 15).map((e) => e.where).join('; ') + (xs.length > 15 ? `; +${xs.length - 15} more` : '');
    checks.push({
      id: `OVL-C${gi + 1}`,
      description: `Checkboxes on ${where} (${boxes.length}) accept an "X" and print it in the right box`,
      expected: `${boxes.length} of ${boxes.length} printed`,
      actual: `${boxes.length - notTyped.length - notPrinted.length} of ${boxes.length} printed`,
      result: notTyped.length || notPrinted.length ? 'FAIL' : 'PASS',
      reason: [
        notTyped.length ? `Couldn't type an "X" into ${notTyped.length} (the mapping doc marks them editable): ${list(notTyped)}.` : '',
        notPrinted.length ? `"X" typed but not printed in its box for ${notPrinted.length}: ${list(notPrinted)}.` : '',
      ].filter(Boolean).join(' '),
    });
  }
  const failed = checks.filter((c) => c.result === 'FAIL').length;
  log(`overlay form: ${checks.length} check(s) — ${checks.length - failed} passed, ${failed} failed`);
  return checks;
}

function verifyInteractiveEditsInPdf(interactiveChecks, pdfText, log) {
  if (!interactiveChecks || !interactiveChecks.length) return;
  const haystack = pdfValidationService.normalizeWs(pdfText).toLowerCase();
  // PDF text extraction line-wraps long tokens, inserting a space at the break (CONFIRMED live 2026-10-13,
  // DIG108: the edit "[QA-EDIT-10]" rendered in the completed PDF as "[QA- EDIT-10]"), which a plain substring
  // search misses even though the edit DID survive into the document — every other marker on the same page
  // (QA-EDIT-5/8/9/12/...) was found; only the two that happened to wrap were reported "missing". A
  // whitespace-stripped copy of the page lets the wrap-tolerant fallback below still find them.
  const haystackNoWs = haystack.replace(/\s+/g, '');
  const usedMarkers = new Set((interactiveChecks || []).map((c) => String(c.committedMarker || '').toLowerCase()).filter((m) => /^qa-edit-\d+$/.test(m)));
  const foundInPdf = (marker) => {
    const needle = pdfValidationService.normalizeWs(marker || '').toLowerCase();
    if (!needle) return false;
    // "qa-edit-1" must not match inside "qa-edit-10" (no brackets around the marker any more to separate them) — but a
    // PDF can run a box's value straight into the next box's date ("10/18/2026QA-EDIT-208/06/2026", DIG47 2026-10-17),
    // so trailing digits only disqualify a hit when together they form another marker this run actually typed.
    if (/^qa-edit-\d+$/.test(needle)) {
      const re = new RegExp(`${needle}(\\d*)`, 'g');
      const ok = (hay) => [...hay.matchAll(re)].some((m) => !m[1] || ![...Array(m[1].length)].some((_, k) => usedMarkers.has(`${needle}${m[1].slice(0, k + 1)}`)));
      return ok(haystack) || ok(haystackNoWs);
    }
    return haystack.includes(needle) || haystackNoWs.includes(needle.replace(/\s+/g, ''));
  };
  // One SmartCOMM field whose placeholder wraps across lines renders as MULTIPLE editable spans sharing the
  // SAME technical name (CONFIRMED live 2026-10-13, DIG108: editableField3 split into INT10 "--" + INT11
  // "<<Editable Field>>--" — same aria-label, same paragraph). Each span gets edited to its own marker, but
  // only ONE survives into the single rendered field — so a sibling fragment whose own marker didn't make it is
  // NOT a lost edit, as long as some span of that same field (same technical name) IS present in the PDF.
  // Collect those technical names first. (Safe because SmartCOMM numbers editable fields uniquely — the same
  // editableFieldN appearing on more than one span means they're pieces of ONE field, not two distinct ones.)
  // Kept per field POSITION (idx), not just technical name: a repeated table row reuses the same technical name
  // (DIG26's exposure-type cell on every row, 2026-10-17) and must not count as a "split fragment" of another row —
  // there, row 1's edit was printed in every row and rows 2-3's edits were lost, yet they were reported verified.
  // A split placeholder's pieces sit next to each other (consecutive idx), so only a neighbour verifies a fragment.
  const foundPositions = interactiveChecks
    .filter((c) => c.observedChanged === true && c.expectedEditable === true && foundInPdf(c.committedMarker || c.after))
    .map((c) => ({ tech: c.technicalName, idx: c.idx }));
  // ...and only for a genuine placeholder FRAGMENT ("-", "<<EditableField>>--" — DIG108/DIG242): a field that held a
  // real value ("[Vehicle]") is never another field's fragment, so a repeated row can't borrow a neighbour's edit.
  // "--Editable--" too (DIG36's split deductible field printed its first piece's "$911"), and a piece whose technical
  // name didn't come back counts when it's the DIRECT neighbour (DIG108's "storage charges starting QA-EDIT-11", where
  // INT12 had no technical name) — still only for placeholder pieces, never for a field that held a real value.
  const isFragment = (c) => /^\[?\s*(-+|-*<*<?\s*editable(\s*field)?\s*>*>?-*|-*<<.*|.*>>-*)\s*\]?$/i.test(String(c.before || '').trim());
  const neighbourFound = (c) => isFragment(c) && foundPositions.some((p) => p.idx !== c.idx
    && ((p.tech === c.technicalName && c.technicalName && Math.abs(p.idx - c.idx) <= 2) || (!c.technicalName && Math.abs(p.idx - c.idx) === 1)));
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
    // Match either as-is OR with ALL whitespace removed from both sides, so a PDF line-wrap inside the marker
    // (e.g. "QA- EDIT-10") can't false-FAIL an edit that really is in the document.
    // What the field held right before Complete Document (c.finalValue, re-read then): if a LATER edit of the same
    // value replaced this one (DIG26's rows share one value), the PDF must show that final value, not what was typed.
    const typed = String(c.committedMarker || c.after || '').replace(/[[\]]/g, '').trim();
    const replacement = (c.replacedBeforeComplete || []).find((m) => foundInPdf(m));
    const found = replacement ? true : foundInPdf(c.committedMarker || c.after);
    if (replacement) {
      c.finalShownInPdf = replacement;
      c.reason = `${c.reason ? `${c.reason} ` : ''}(Typed "${typed}", but before Complete Document that spot held "${replacement}" (a later edit of the same shared field, or a later edit typed into this spot while field positions shifted) — that final value is in the PDF.)`;
    }
    // Split-line sibling: this exact marker isn't in the PDF, but another span of the SAME field (same technical
    // name) is — the field WAS edited; this fragment just lost the merge into the single rendered field.
    const siblingVerified = !found && neighbourFound(c);
    c.verifiedInPdf = found || siblingVerified;
    if (siblingVerified) {
      c.reason = `${c.reason ? `${c.reason} ` : ''}(Field placeholder split across lines into multiple editable spans sharing technical name "${c.technicalName}"; another span's edit is present in the completed PDF, so this fragment's own marker not appearing is expected — the field was edited.)`;
      continue;
    }
    // The edit was already GONE from the editor right before Complete Document and nothing replaced it there: another
    // test edit typed over it while field positions shifted (DIG200: #37 landed in witness line 2, over #39). The PDF
    // matches the editor, so it can't say anything about this field — not verifiable, not a template defect. (An edit
    // still in the editor before Complete but missing from the PDF stays a real FAIL below.)
    if (!found && c.goneBeforeComplete) {
      c.lostInEditor = true;
      c.reason = `${c.reason ? `${c.reason} ` : ''}(This edit was already gone from the editor before Complete Document — another test edit typed over it while field positions shifted; the PDF matches the editor, so this field couldn't be verified. Not a template defect.)`;
      log(`${c.id} ${c.label}: edit overwritten in the editor by another test edit before completing — not verifiable`);
      continue;
    }
    if (!found) {
      const looksLikeDate = DATE_SHAPED_RE.test(c.before || '');
      // A repeated row whose own edit is missing while another row's edit of the same field is printed (DIG26).
      const otherShown = c.technicalName ? interactiveChecks.find((o) => o !== c && o.technicalName === c.technicalName && o.observedChanged === true && foundInPdf(o.committedMarker || o.after)) : null;
      if (otherShown) c.replacedBy = otherShown.committedMarker || otherShown.after;
      const note = `Edit was accepted in the interactive editor (showed "${c.after}") but this text was NOT found anywhere in the downloaded, completed PDF — the edit did not survive into the final document.` +
        (c.replacedBy ? ` The same field elsewhere (another row) printed "${c.replacedBy}" instead — this row's edit was replaced by that one (the rows share one field).` : '') +
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
    // "A date-shaped value must appear" with no date left because the test overwrote every date field (DIG129,
    // 2026-10-17): judged on the edited fields' values BEFORE the edit — one of them must have shown a date.
    if (v.expected === '<date>') {
      const dated = edited.filter((c) => DATE_SHAPED_RE.test(String(c.before || '').replace(/[[\]]/g, '').trim()));
      if (dated.length) {
        v.intentionalEdit = true;
        v.result = 'PASS';
        v.actual = `Before edit: "${dated.map((c) => c.before).join(' ')}" → after edit: "${dated.map((c) => c.committedMarker).join(' ')}"`;
        v.reason = `No date is left in the PDF because the interactive-edit test overwrote the date field(s) (${dated.map((c) => c.id).join(', ')}); before the edit they showed a date, and the edits are in the PDF.`;
      }
      continue;
    }
    const desc = (v.description || '').toLowerCase();
    const expectedNorm = normForKnownValueMatch(v.expected);
    const hits = edited.filter((c) => {
      // A ticked checkbox ("[ ]" → "X") holds no value — never this row's field (DIG201/203/210 "Claimant Address", 2026-10-27).
      if (String(c.committedMarker || '') === 'X' && /^\[?\s*\]?$/.test(String(c.before || '').trim())) return false;
      if (c.label && desc.includes(c.label.toLowerCase())) return true;
      if (c.dictionaryField && desc.includes(`"${c.dictionaryField.toLowerCase()}"`)) return true;
      const beforeNorm = normForKnownValueMatch(c.before);
      // A short value ("911", "GMC") held EXACTLY, in a field whose technical name carries the row's last word
      // ("vehModel" for "Vehicle Model") — DIG128MI 2026-10-31: "911" reported missing after the test edited it.
      const lastWord = (desc.match(/"([^"]+)"/) || [])[1]?.split(/\s+/).pop();
      if (expectedNorm && beforeNorm === expectedNorm && lastWord && lastWord.length >= 3
        && (c.technicalName || '').toLowerCase().includes(lastWord.toLowerCase())) return true;
      return expectedNorm.length >= minLen && beforeNorm.length >= minLen
        && (expectedNorm.includes(beforeNorm) || beforeNorm.includes(expectedNorm));
    });
    if (!hits.length) {
      // The value lived in a field whose own test edit was typed over by a neighbouring edit before Complete Document
      // (c.lostInEditor — its EDIT row is BLOCKED): neither the original value nor the edit can be in the PDF, so a
      // "not found" here is the test's own collision, not a template defect (DIG28-AUTO-OH "Date of Loss Month",
      // 2026-10-23). BLOCKED like that EDIT row — only when the field really showed the expected value first.
      const lost = (interactiveChecks || []).filter((c) => c.observedChanged === true && c.lostInEditor && (
        (c.dictionaryField && desc.includes(`"${c.dictionaryField.toLowerCase()}"`))
        || (expectedNorm.length >= 3 && normForKnownValueMatch(c.before).includes(expectedNorm))));
      if (lost.length && lost.some((c) => expectedNorm.length >= 3 && normForKnownValueMatch(c.before).includes(expectedNorm))) {
        v.result = 'BLOCKED';
        v.actual = `Before edit: "${lost.map((c) => c.before).join(' ')}" (its test edit was typed over before Complete Document)`;
        v.reason = `The field showed "${v.expected}" before the test edited it (${lost.map((c) => c.id).join(', ')}), but that edit was typed over by another test edit before Complete Document, so the PDF can't confirm this field — the test's own collision, not a template defect.`;
      }
      continue;
    }
    // committedMarker is the plain value actually typed; `after` carries the live editor's own extra bracket
    // decoration ("[[QA-EDIT-18]]") that never appears in the real PDF.
    const editedValue = hits.map((h) => h.committedMarker || h.after).join(' ');
    // Before AND after the edit (per user direction 2026-10-17): the field must have shown the real value before the
    // test overwrote it — then the edit must be in the PDF (already established: `edited` only holds verified edits).
    // Matching what was there before is the same containment as the hit test above.
    const beforeValues = hits.map((h) => h.before).filter(Boolean);
    const beforeOk = beforeValues.some((b) => {
      const bn = normForKnownValueMatch(b);
      // A short value equal to what the field showed ("GMC" / "[GMC]" — DIG128 2026-10-29) is a match too.
      if (bn && bn === expectedNorm) return true;
      return expectedNorm.length >= minLen && bn.length >= minLen && (expectedNorm.includes(bn) || bn.includes(expectedNorm));
    });
    // A fixed LABEL row ("Static content must appear: "Our Policy Number:"") is about the wording, not the field after
    // it — DIG40 2026-10-30 was judged on the policy number the field held. Leave it to the static-text verdict.
    if (/^(static content must appear|label ")/i.test(v.description || '') && !beforeOk) continue;
    v.intentionalEdit = true; // report renderers: still show Expected/Actual for this one
    v.actual = `Before edit: "${beforeValues.join(' ')}" → after edit: "${editedValue}"`;
    // The field was picked by its label, but what it held has the wrong SHAPE for this value — a year/number/state code
    // where a name or make was expected (DIG75 "Vehicle Make" = "[2002]", DIG57 "Claimant Name" = "[DE]", 2026-10-30):
    // the label sits next to a different field. BLOCKED, as for the EDIT row — a pairing slip in this tool.
    const clash = !beforeOk && /[a-z]{3}/i.test(v.expected || '') && !/\d/.test(v.expected || '')
      && beforeValues.every((b) => /^[\d\s()./x-]+$|^[A-Z]{2}$/i.test(String(b).replace(/[[\]]/g, '').trim()));
    if (clash) {
      v.result = 'BLOCKED';
      v.reason = `The field next to this label showed "${beforeValues.join(' ')}" before the edit — a number/code, not a "${v.expected}"-type value — so this tool paired the label with the neighbouring field. Can't be judged here; not a template defect.`;
      continue;
    }
    v.result = beforeOk ? 'PASS' : 'FAIL';
    v.reason = beforeOk
      ? `Showed the expected value before the interactive-edit test overwrote it with "${editedValue}" (${hits.map((h) => h.id).join(', ')}), and the edited value is in the completed PDF — correct before and after the edit.`
      : `Before the interactive-edit test overwrote it (${hits.map((h) => h.id).join(', ')}), the field showed "${beforeValues.join(' ')}" instead of the expected "${v.expected}"${beforeValues.some((b) => /editable|<</i.test(b)) ? ' — an empty editable placeholder, i.e. no default value' : ''}. The edit itself ("${editedValue}") is in the PDF.`;
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
// The ways a plain payload number prints: "2450.00" as "2,450.00", "$2,450.00", "2,450", "$2,450" (DIG168's
// appraisal / NADA amounts, 2026-10-19 — the payload carries the bare number, the letter the formatted one, and a
// literal search for "2450.00" never finds "$2,450.00"). Only for numbers that can carry formatting: 1,000 or more,
// or with decimals.
function printedNumberForms(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return [];
  const n = Number(raw);
  if (!Number.isFinite(n) || (Math.abs(n) < 1000 && !raw.includes('.'))) return [];
  const cents = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const forms = [cents, `$${cents}`];
  if (Number.isInteger(n)) { const whole = n.toLocaleString('en-US'); forms.push(whole, `$${whole}`); }
  return [...new Set(forms)].filter((f) => f !== raw);
}

// A "text-shaped value must appear for <field>" check (a BA comment naming a field with no known test-data mapping or
// shape — DIG168's "Appraisal Amount", "NADA Value", "Mileage Amount", 2026-10-19) always reported BLOCKED, even when
// the Data Dictionary has that field with an Xpath into the payload. Its dictionary row, when the BA's field name
// names one by its own name or a known synonym (not the loose word-overlap match: a wrong row here would be a false
// FAIL where today there is an honest BLOCKED).
function textFieldDictionaryRow(digNumber, req) {
  if (!req || req.type !== 'dynamicShape' || req.shape !== 'text' || req.enabled === false || !req.fieldName) return null;
  let match;
  try { match = dataDictionaryService.matchDictionaryRowByCommentFieldName(digNumber, req.fieldName); } catch (_) { return undefined; } // no dictionary file
  return match && match.matchedOn !== 'wordOverlap' ? match.row : null;
}

// Each such check becomes the payload comparison its dictionary row's XP check makes (same expected value, same
// edited-field handling), under the BA's own field name; one that can't be linked says why it stays BLOCKED.
function linkTextFieldsToDictionary(template, requirements, xpathRequirements, rawPayloadRoot) {
  return requirements.map((r) => {
    if (r.type !== 'dynamicShape' || r.shape !== 'text' || r.enabled === false || !r.fieldName) return r;
    const row = textFieldDictionaryRow(template.digNumber, r);
    if (row === undefined) return r; // the Data Dictionary couldn't be read: nothing to say about this field
    // A BA note that only says the spot is free text ("Free Form/Editable" — DIG18875 R30) names no data field: the user
    // types there, nothing to compare — SKIPPED with that reason, not BLOCKED as an unknown field (QA review 2026-10-26).
    // ...and a formatting note like "(redact all numbers with X except last 4)" (DIG201 R54, 2026-10-28) is about how a
    // neighbouring field prints, not a field of its own.
    if (!row && /^\s*\(?\s*(redact|mask)\b/i.test(r.fieldName)) return { ...r, enabled: false, disabledReason: `"${r.fieldName}" is a formatting note for a neighbouring field, not a data field of its own.` };
    // ...and a BA sentence describing behaviour ("PACE notice language will be able to be dynamically added and removed
    // in SmartCOMM." DIG12 R24; "“Occurrence” value is written on every letter" DIG152 R34 — 2026-10-29): a statement,
    // not a field name.
    if (!row && r.fieldName.trim().split(/\s+/).length >= 6 && /\b(will be|is written|are written|able to|dynamically|should be|on every)\b/i.test(r.fieldName)) {
      return { ...r, enabled: false, disabledReason: `"${r.fieldName}" is a note in the mapping doc describing how the letter behaves, not a data field.` };
    }
    if (!row && /^\s*free\s*form/i.test(r.fieldName)) return { ...r, enabled: false, disabledReason: `"${r.fieldName}" marks a free-text spot the user fills in — no data field behind it to compare.` };
    if (!row) return { ...r, unmappedReason: `"${r.fieldName}" has no matching Data Dictionary row for ${template.digNumber}, so there's no payload value to compare it with — presence not verified.` };
    const xp = xpathRequirements.find((x) => x.dictionaryAttribute === row.attributeName);
    if (xp) {
      const { id: _id, description: _d, docOrder: _o, ...expectation } = xp;
      return { ...r, ...expectation, fieldName: r.fieldName, description: `Value for "${r.fieldName}" must match the SmartCOMM payload (Data Dictionary "${row.attributeName}")` };
    }
    const why = !row.xpath || !row.xpath.trim() ? `its Data Dictionary row "${row.attributeName}" has no Xpath`
      : !rawPayloadRoot ? "this scenario's payload couldn't be read"
      : `its Data Dictionary row "${row.attributeName}" Xpath found no value in this scenario's payload`;
    // ClaimCenter holds no value for this field on this claim (the Xpath reads fine, just empty): nothing to print, so
    // the document showing nothing matches the source — PASS (user direction 2026-10-28, all templates).
    if (row.xpath && row.xpath.trim() && rawPayloadRoot && !payloadXpathService.resolveXpath(rawPayloadRoot, row.xpath).unsupported) {
      return { ...r, noSourceValue: true, unmappedReason: `"${r.fieldName}": ClaimCenter has no value for this field on this claim (Data Dictionary "${row.attributeName}" Xpath is empty in the payload), so the document correctly has nothing to show.` };
    }
    return { ...r, unmappedReason: `"${r.fieldName}": ${why}, so there's nothing to compare it with — presence not verified.` };
  });
}

function buildXpathRequirements(template, rawPayloadRoot, baseRequirements, interactiveChecks, log, { additionalRecipientAdded = false } = {}) {
  const templateFields = (baseRequirements || [])
    .map((r) => ({ req: r, fn: dataDictionaryService.normalizeForMatch(r.fieldName) }))
    .filter((t) => t.fn);
  const referencingRequirements = (row) => {
    const attrNorm = dataDictionaryService.normalizeForMatch(row.attributeName);
    const tmplAttrNorm = dataDictionaryService.normalizeForMatch(row.templateAttributeName);
    return templateFields.filter(({ fn }) =>
      (attrNorm && attrNorm.length >= 3 && fn.includes(attrNorm)) ||
      (tmplAttrNorm && tmplAttrNorm.length >= 3 && fn.includes(tmplAttrNorm))).map((t) => t.req);
  };
  // ...plus the rows a "text-shaped" check's own field name resolves to (see textFieldDictionaryRow) — those are
  // linked to the XP check below instead of reporting BLOCKED with nothing compared.
  const textFieldRefs = new Map();
  for (const r of baseRequirements || []) {
    const row = textFieldDictionaryRow(template.digNumber, r);
    if (row) textFieldRefs.set(row.attributeName, [...(textFieldRefs.get(row.attributeName) || []), r]);
  }
  const referencedByTemplate = (row) => referencingRequirements(row).length > 0 || textFieldRefs.has(row.attributeName);
  const rows = dataDictionaryService.getAttributesForTemplate(template.digNumber)
    .filter((r) => r.xpath && r.xpath.trim())
    // An overlay form whose mapping doc names NO fields (scanned images) has nothing to scope by — check every
    // dictionary field for this DIG. One whose mapping doc does name its fields (a PDF mapping doc's notes, read since
    // 2026-10-21) is scoped like any other template: DIG1043 was checked for From Name / Claim Number / Policy Number /
    // From Email… — dictionary rows that list DIG1043 but aren't on the form (QA review 2026-10-26).
    .filter((r) => (template.overlayMode && !templateFields.length) || referencedByTemplate(r));
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
    // ...or an edited field that wasn't matched to this row by label but HELD exactly this value before the edit
    // (CONFIRMED 2026-10-17, DIG27/DIG28: "RECEIVED OF [QA-EDIT-5] HEREINAFTER CALLED THE COMPANY" — the
    // Underwriting Company field, whose label "RECEIVED OF" matches no dictionary row, reported as a FAIL).
    const sameText = (a, b) => pdfValidationService.normalizeWs(a || '').replace(/[[\]]/g, '').trim().toLowerCase() === pdfValidationService.normalizeWs(b || '').trim().toLowerCase();
    const editedByTest = (interactiveChecks || []).some((c) => c.observedChanged === true
      && (c.dictionaryField === row.attributeName || [result.value, ...(result.alsoAccept || [])].some((x) => (String(x).length >= 4 || (c.technicalName || '').toLowerCase().includes(String(row.attributeName || '').split(/s+/).pop().toLowerCase())) && sameText(c.before, x))));
    const datePart = pdfValidationService.dateLossPart(row.attributeName, result.value);
    // Every template field this attribute belongs to is switched off for THIS scenario (e.g. Agent Number,
    // which prints only for an added additional recipient — DIG239 2026-10-16, user direction): the payload
    // still carries the value, but the document correctly doesn't print it, so skip with the same reason.
    // Still checked once a recipient really was added: a role-gated field like DIG239's "Agent Number … role of
    // Producer" is never re-enabled itself, and this payload check is the only thing exercising it then.
    const refs = template.overlayMode ? [] : [...new Set([...referencingRequirements(row), ...(textFieldRefs.get(row.attributeName) || [])])];
    const recipientGated = refs.some((r) => /additional recipient|^copy\b/i.test(r.fieldName || ''));
    const conditionallyOff = (r) => r.enabled === false && !/editor's own mechanics/.test(r.disabledReason || '');
    const gatedOff = refs.length > 0 && refs.every(conditionallyOff) && !(additionalRecipientAdded && recipientGated);
    requirements.push({
      ...(gatedOff ? { enabled: false, disabledReason: refs[0].disabledReason || 'Conditional field, not printed in this scenario.' } : {}),
      id: `XP${n}`,
      dictionaryAttribute: row.attributeName,
      description: `Value for "${row.attributeName}" must match the SmartCOMM payload (via Data Dictionary Xpath)`,
      type: matchedCheck ? 'fieldValueMatch' : 'requiredText',
      expectedValue: datePart ? datePart.value : String(result.value),
      ...(datePart ? { wordValues: datePart.accept, wordNote: datePart.note, alsoAccept: datePart.accept }
        // "Claimant Name" on a claim with several claimants: any of them (DIG30 prints the exposure's "Jimmy Claimant").
        : /claimant name/i.test(row.attributeName) && pdfValidationService.claimantsOf({ raw: rawPayloadRoot }).length > 1
          ? { alsoAccept: pdfValidationService.claimantsOf({ raw: rawPayloadRoot }), alsoAcceptNote: 'The claim has more than one claimant; the letter prints another claimant on this claim (likely the one on the exposure the letter is about).' }
          // An ISO date in the payload ("1978-04-01") prints as 04/01/1978 or April 01, 1978 (DIG4 Driver DOB, 2026-10-30).
          : /^\d{4}-\d{2}-\d{2}(T|$)/.test(String(result.value))
            ? (() => {
              const [y, m, d] = String(result.value).slice(0, 10).split('-');
              const month = new Date(Number(y), Number(m) - 1, 1).toLocaleString('en-US', { month: 'long' });
              return { alsoAccept: [...(result.alsoAccept || []), `${m}/${d}/${y}`, `${Number(m)}/${Number(d)}/${y}`, `${month} ${d}, ${y}`, `${month} ${Number(d)}, ${y}`], alsoAcceptNote: 'Same date as the payload\'s ISO date, in the printed format.' };
            })()
          : printedNumberForms(result.value).length
            ? { alsoAccept: [...(result.alsoAccept || []), ...printedNumberForms(result.value)], alsoAcceptNote: result.alsoAcceptNote || 'Same number as the payload, printed with thousands separators / a dollar sign / cents.' }
            : { alsoAccept: result.alsoAccept, alsoAcceptNote: result.alsoAcceptNote }),
      // The field's own shown value. Never the marker we typed: matchedCheck excludes edits that took, so a marker here is
      // one that did NOT land (DIG201 2026-10-28: "QA-EDIT-25" compared with Time Began Work while the field showed 12:00).
      fieldValue: matchedCheck ? (matchedCheck.before || matchedCheck.after) : undefined,
      fieldLabel: matchedCheck ? matchedCheck.label : undefined,
      wasEditedByTest: !matchedCheck && editedByTest,
      // What the edited field(s) showed BEFORE the test's edit — checked against the payload value when the edit consumed
      // the only printed occurrence (pdfValidationService.editedBeforeResult).
      editedBefore: !matchedCheck && editedByTest ? (interactiveChecks || []).filter((c) => c.observedChanged === true && !(String(c.committedMarker || '') === 'X' && /^\[?\s*\]?$/.test(String(c.before || '').trim())) && (c.dictionaryField === row.attributeName || [result.value, ...(result.alsoAccept || [])].some((x) => (String(x).length >= 4 || (c.technicalName || '').toLowerCase().includes(String(row.attributeName || '').split(/s+/).pop().toLowerCase())) && sameText(c.before, x)))).map((c) => c.before).filter(Boolean) : undefined,
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

// Builds PASS/FAIL checks from the completed document's co-located filing metadata (<identifier>.json in the
// S3 archive — see s3AdminService.downloadArchiveMetadataJson). META1 confirms the fetched document is for the
// right template (its Description carries the DIG number); META2 confirms the right claim (FileNumber == the
// claim under test); META3 records the remaining filing fields for the record. Reliable even when the input
// review-case payload is absent, since this .json is always alongside the PDF.
function buildMetadataChecks(meta, { template, claimNumber }) {
  const norm = (s) => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, ' ');
  const checks = [];
  const dig = String(template.digNumber || '');
  // "DIG 102 Auto Affidavit Theft" names DIG102 too (2026-10-29) — a space after "DIG" is allowed.
  const digPattern = dig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/^DIG/i, 'DIG\\s*');
  const digOk = !!dig && new RegExp(`\\b${digPattern}\\b`, 'i').test(meta.Description || '');
  checks.push({
    id: 'META1',
    description: 'Archive .json Description identifies this template (DIG number present)',
    result: digOk ? 'PASS' : 'FAIL',
    expected: dig || '(template DIG)',
    actual: meta.Description || '(none)',
    reason: digOk ? '' : `Filing Description "${meta.Description || ''}" does not contain ${dig || 'the template DIG'} — the fetched document may be for a different template.`,
  });
  if (claimNumber) {
    const claimOk = norm(meta.FileNumber) === norm(claimNumber);
    checks.push({
      id: 'META2',
      description: 'Archive .json FileNumber matches the claim under test',
      result: claimOk ? 'PASS' : 'FAIL',
      expected: claimNumber,
      actual: meta.FileNumber || '(none)',
      reason: claimOk ? '' : `Filing claim # "${meta.FileNumber || ''}" != claim under test "${claimNumber}".`,
    });
  }
  checks.push({
    id: 'META3',
    description: 'Archive .json filing details captured (Drawer / Folder / DocType / DocumentDate)',
    result: 'PASS',
    expected: '—',
    actual: `Drawer=${meta.Drawer || ''}, Folder=${meta.Folder || ''}, DocType=${meta.DocType || ''}, DocumentDate=${meta.DocumentDate || ''}`,
    reason: '',
  });
  return checks;
}

module.exports = {
  validateTemplate,
  _test: {
    recipientRoleFromTechnicalName, knownValueRole, assignByKnownValue, fieldConcept, buildMetadataChecks, buildEditValue, verifyInteractiveEditsInPdf,
    annotateInteractiveEditFailures, runLayoutChecks, payloadUnavailableCheck, metadataUnavailableCheck, rollUpScenario,
    buildXpathRequirements, linkTextFieldsToDictionary, printedNumberForms,
    buildEditedFieldChecks, overlayValuePrinted, overlayRowLabel, overlayColumnHeader, buildPageAndFraudChecks, buildOverlayChecks, freeFormBlanksCheck,
  },
};
