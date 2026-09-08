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
const templateRequirementService = require('./templateRequirementService');
const documentService = require('./documentService');
const pdfValidationService = require('./pdfValidationService');
const claimSummaryService = require('./claimSummaryService');
const payloadService = require('./payloadService');
const { loginAsAdmin, openExistingClaim } = require('../claimCenterBase');

async function validateTemplate(page, { digNumber, recipientEmail, claimNumberOverride }) {
  const dig = catalogService.normalizeDig(digNumber);
  const template = catalogService.getTemplate(dig);
  if (!template) {
    return blockedTemplateResult(dig, `Template "${dig}" was not found in the SmartCOMM catalog (Claims_Documents_Index.xlsx)`);
  }

  const { requirements, sourceFile } = templateRequirementService.getRequirements(template, catalogService.DATA_DIR);
  if (!requirements.length) {
    return blockedTemplateResult(
      dig,
      `No requirements could be derived for ${dig} (${template.documentName}) — its Word template ` +
      `("${template.templateMappingDoc || 'not set'}") was not found under ${catalogService.DATA_DIR}\\Templates\\ClaimCenter, or is not a .docx.`,
      template
    );
  }
  console.log(`[SmartComm] ${dig}: derived ${requirements.length} requirements from ${sourceFile}`);

  // Runner UI's optional manual "Claim #" override — use that one claim
  // directly as a single ad-hoc scenario instead of matching
  // testDataService's real claim inventory by the template's own State/LOB
  // applicability. lob/state are unknown here (no test-data record backs
  // this claim), so they're reported as "manual" rather than guessed — any
  // dynamicValueMatch requirement needing testData.* still correctly comes
  // back BLOCKED, same as a real record with those fields left unset.
  const scenarios = claimNumberOverride
    ? [{
        scenarioId: `${dig}-manual-${claimNumberOverride}`.replace(/\s+/g, ''),
        lob: 'manual', state: 'manual',
        testData: { claimNumber: claimNumberOverride },
      }]
    : scenarioService.getScenariosForTemplate(template, testDataService.getAllRecords());

  if (!scenarios.length) {
    return blockedTemplateResult(
      dig,
      `No SmartCOMM test claims match template ${dig}'s applicability (States: ${template.states.join(',')}, LOB: ${template.lob.join(',')}). ` +
      `Nothing in the Test Data claim inventory matched, and no Claim # override was given.`,
      template
    );
  }

  await loginAsAdmin(page);

  const scenarioResults = [];
  for (const scenario of scenarios) {
    scenarioResults.push(await runScenario(page, { template, scenario, requirements, recipientEmail }));
  }

  return aggregateTemplateResult(template, scenarioResults, sourceFile);
}

async function runScenario(page, { template, scenario, requirements, recipientEmail }) {
  const base = {
    scenarioId: scenario.scenarioId,
    digNumber: template.digNumber,
    templateName: template.documentName,
    lob: scenario.lob,
    state: scenario.state,
    claimNumber: scenario.testData.claimNumber,
    validations: [],
  };

  try {
    console.log(`[SmartComm] ${scenario.scenarioId}: opening claim ${scenario.testData.claimNumber}`);
    await openExistingClaim(page, scenario.testData.claimNumber);

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
    console.log(`[SmartComm] ${scenario.scenarioId}: claim data — insuredName=${JSON.stringify(effectiveTestData.insuredName)} lossDate=${JSON.stringify(effectiveTestData.lossDate)} lossLocation=${JSON.stringify(effectiveTestData.lossLocation)} claimantName=${JSON.stringify(effectiveTestData.claimantName)}`);

    await documentService.openCreateFromTemplate(page);
    await documentService.selectTemplate(page, [template.searchName, template.searchNameAlt]);
    const recipient = await documentService.setPrimaryRecipient(page, { preferredName: effectiveTestData.insuredName }); // { name, address }
    await documentService.setDeliveryChannel(page, 'Print');
    await documentService.setEmail(page, recipientEmail);
    await documentService.setAdditionalData(page, { language: 'English (US)', documentType: 'Other' });
    const pdfPath = await documentService.generateOnDemand(page, {
      fileNamePrefix: `${template.digNumber}_${scenario.testData.claimNumber}_${scenario.scenarioId}`,
    });

    // ClaimCenter's own "Download Payload" button (Create tab, Development
    // section) gives back the exact XML it sent to SmartCOMM for this
    // generation — a second, independent source of truth, used two ways
    // below: cross-checked against what claimSummaryService scraped off the
    // Summary screen (catches THIS TOOL's own capture bugs, not just
    // template-vs-render ones), and as a context source for "From Phone"/
    // "From Email" (see fieldLabelSynonyms.js) — the adjuster's own contact
    // details, unreachable from any claim/Settings/Team screen but present
    // right in this payload's own <from_ext> block. Best-effort: not every
    // template has been confirmed to expose this button, so a failure here
    // degrades to "no cross-check, From Phone/Email stay BLOCKED" rather
    // than failing the whole scenario.
    let payload;
    try {
      const payloadPath = await documentService.downloadPayload(page, {
        fileNamePrefix: `${template.digNumber}_${scenario.testData.claimNumber}_${scenario.scenarioId}`,
      });
      payload = payloadService.parsePayloadFile(payloadPath);
    } catch (err) {
      console.log(`[SmartComm] ${scenario.scenarioId}: payload download/parse failed — ${err.message} (data-capture cross-check and From Phone/Email skipped for this scenario)`);
    }

    const text = await pdfValidationService.extractPdfText(pdfPath);
    // recipient.{name,address} is who/where documentService actually
    // selected — the source of truth for "To Name"/"To Street Address"/"To
    // City, State, Zip" requirements (see fieldLabelSynonyms.js), correct
    // regardless of which claim/recipient this scenario used. testData here
    // is effectiveTestData (testData.js merged with whatever
    // claimSummaryService captured live) — not the raw scenario.testData.
    const context = {
      testData: effectiveTestData, scenario, template, recipient,
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
    const validations = pdfValidationService.evaluateRequirements(requirements, text, context);
    if (payload) validations.push(...payloadService.compareToClaimData(effectiveTestData, payload));

    const passed = validations.filter(v => v.result === 'PASS').length;
    const failed = validations.filter(v => v.result === 'FAIL').length;
    const blocked = validations.filter(v => v.result === 'BLOCKED').length;
    const skipped = validations.filter(v => v.result === 'SKIPPED').length;
    const status = failed > 0 ? 'FAIL' : blocked > 0 ? 'BLOCKED' : 'PASS';

    console.log(`[SmartComm] ${scenario.scenarioId}: ${status} (${passed} passed, ${failed} failed, ${blocked} blocked, ${skipped} skipped)`);
    return { ...base, status, recipient, pdfPath, validations, passed, failed, blocked, skipped };
  } catch (err) {
    // A template not yet released to this environment's SmartCOMM library
    // (documentService.selectTemplate's TEMPLATE_NOT_FOUND — CONFIRMED live
    // on DIG47, DIG124) is a known, expected precondition failure, not an
    // automation crash — report it as BLOCKED like any other missing
    // precondition, not ERROR.
    if (err.message.startsWith('TEMPLATE_NOT_FOUND')) {
      console.log(`[SmartComm] BLOCKED ${scenario.scenarioId}: ${err.message}`);
      return { ...base, status: 'BLOCKED', reason: err.message, passed: 0, failed: 0, blocked: 1, skipped: 0 };
    }
    console.log(`[SmartComm] ERROR ${scenario.scenarioId}: ${err.message}`);
    return { ...base, status: 'ERROR', reason: err.message, passed: 0, failed: 0, blocked: 0, skipped: 0 };
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
