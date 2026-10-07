/**
 * helpers/smartComm/reportService.js
 * Builds and emails the scenario-by-scenario SmartCOMM validation report.
 * Reuses the same nodemailer + EMAIL_* env var convention as
 * reporters/emailReporter.js (this repo's generic Playwright-run reporter)
 * rather than routing through it, since that reporter's shape (pass/fail/
 * LOB-tag regex over a whole `npx playwright test` run) doesn't fit one
 * aggregated, multi-scenario, per-requirement expected/actual report — that
 * reporter explicitly skips itself for SmartCOMM runs so only this one email
 * goes out (see its own onEnd()).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (_) { /* reported lazily in sendReport */ }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const RESULT_STYLE = {
  PASS: { bg: '#d4edda', fg: '#155724' },
  FAIL: { bg: '#f8d7da', fg: '#721c24' },
  BLOCKED: { bg: '#fff3cd', fg: '#856404' },
  SKIPPED: { bg: '#e2e3e5', fg: '#383d41' },
  ERROR: { bg: '#f8d7da', fg: '#721c24' },
};

// Same semantic palette as RESULT_STYLE above, as full-opacity ARGB for ExcelJS's own fill/font model (the
// plain `xlsx` package used elsewhere in this repo can only WRITE cell colors in its paid Pro tier, so the
// Excel report uses ExcelJS instead — CONFIRMED 2026-09-30 after the user asked for the same color coding
// the email table already had).
const XL_RESULT_FILL = { PASS: 'FFD4EDDA', FAIL: 'FFF8D7DA', BLOCKED: 'FFFFF3CD', SKIPPED: 'FFE2E3E5', ERROR: 'FFF8D7DA' };
const XL_RESULT_FONT = { PASS: 'FF155724', FAIL: 'FF721C24', BLOCKED: 'FF856404', SKIPPED: 'FF383D41', ERROR: 'FF721C24' };
const XL_HEADER_FILL = 'FF343A40';
const XL_HEADER_FONT = 'FFFFFFFF';

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_HEADER_FILL } };
    cell.font = { color: { argb: XL_HEADER_FONT }, bold: true };
  });
  return row;
}

function styleResultRow(row, result) {
  const fill = XL_RESULT_FILL[result];
  const font = XL_RESULT_FONT[result];
  if (!fill) return row;
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    cell.font = { color: { argb: font } };
  });
  return row;
}

function skippedCount(templateResult) {
  return templateResult.scenarios.reduce((sum, s) => sum + (s.skipped || 0), 0);
}

// Per-scenario/per-requirement detail now lives entirely in the attached Excel workbook (one tab per
// scenario — see buildExcelReport) rather than in the email body itself, so this stays a short summary: the
// top-level counts plus one line per scenario, enough to gauge the run at a glance before opening the
// attachment.
function buildTextReport(templateResult) {
  const lines = [];
  lines.push('SmartCOMM Template Validation Result');
  lines.push('');
  lines.push(`Template: ${templateResult.templateName} (${templateResult.digNumber})`);
  lines.push(`Environment: ${(process.env.CC_ENV || '').toUpperCase()} / ${(process.env.CC_TIER || '').toUpperCase()}`);
  lines.push(`Scenarios: ${templateResult.scenarioCount}`);
  lines.push(`Passed: ${templateResult.passed}`);
  lines.push(`Failed: ${templateResult.failed}`);
  lines.push(`Blocked: ${templateResult.blocked}`);
  const skippedTotal = skippedCount(templateResult);
  if (skippedTotal) lines.push(`Skipped (conditional/not applicable): ${skippedTotal}`);
  if (templateResult.errored) lines.push(`Errored: ${templateResult.errored}`);
  lines.push(`Overall: ${templateResult.overall}`);
  if (templateResult.reason) lines.push(`Reason: ${templateResult.reason}`);
  lines.push('');
  lines.push('Full detail (per-requirement expected/actual, field editability, template vs. payload validation — one tab per scenario) is in the attached Excel workbook.');
  lines.push('');
  for (const s of templateResult.scenarios) {
    lines.push(`  ${s.scenarioId} — ${s.status}  (LOB: ${s.lob}, State: ${s.state}${s.claimNumber ? ', Claim: ' + s.claimNumber : ''})`);
  }
  return lines.join('\n');
}

// Per-scenario/per-requirement detail now lives entirely in the attached Excel workbook (one tab per
// scenario, template-content and payload-vs-Xpath checks in separate tables within each — see
// buildExcelReport) rather than in the email body. The email body is just the top-level summary plus a
// one-line-per-scenario status list, so a reviewer can tell at a glance whether they need to open the
// attachment at all.
function scenarioStatusRowHtml(s) {
  const style = RESULT_STYLE[s.status] || RESULT_STYLE.BLOCKED;
  const td = 'padding:4px 8px;border:1px solid #ccc;font-family:Arial,sans-serif;font-size:13px;';
  return `<tr style="background:${style.bg};color:${style.fg};">` +
    `<td style="${td}font-weight:bold;">${escapeHtml(s.scenarioId)}</td>` +
    `<td style="${td}">${escapeHtml(s.status)}</td>` +
    `<td style="${td}">${escapeHtml(s.lob)}</td>` +
    `<td style="${td}">${escapeHtml(s.state)}</td>` +
    `<td style="${td}">${escapeHtml(s.claimNumber || '')}</td>` +
    `</tr>`;
}

function buildHtmlReport(templateResult) {
  const skippedTotal = skippedCount(templateResult);
  const summaryRow = (label, value, color) =>
    `<td style="padding:6px 12px;text-align:center;">
       <div style="font-size:20px;font-weight:bold;color:${color || '#333'};font-family:Arial,sans-serif;">${value}</div>
       <div style="font-size:11px;color:#666;font-family:Arial,sans-serif;">${label}</div>
     </td>`;
  const headStyle = 'padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;';

  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;">
    <h2 style="margin-bottom:4px;">SmartCOMM Template Validation Result</h2>
    <div style="font-size:14px;margin-bottom:12px;">
      <strong>${escapeHtml(templateResult.templateName)}</strong> (${escapeHtml(templateResult.digNumber)}) &nbsp;·&nbsp;
      ${escapeHtml((process.env.CC_ENV || '').toUpperCase())} / ${escapeHtml((process.env.CC_TIER || '').toUpperCase())} &nbsp;·&nbsp;
      Overall: <strong style="color:${(RESULT_STYLE[templateResult.overall] || {}).fg || '#721c24'}">${escapeHtml(templateResult.overall)}</strong>
    </div>
    <table style="border-collapse:collapse;margin-bottom:8px;">
      <tr>
        ${summaryRow('Scenarios', templateResult.scenarioCount)}
        ${summaryRow('Passed', templateResult.passed, RESULT_STYLE.PASS.fg)}
        ${summaryRow('Failed', templateResult.failed, RESULT_STYLE.FAIL.fg)}
        ${summaryRow('Blocked', templateResult.blocked, RESULT_STYLE.BLOCKED.fg)}
        ${summaryRow('Skipped', skippedTotal, RESULT_STYLE.SKIPPED.fg)}
        ${templateResult.errored ? summaryRow('Errored', templateResult.errored, RESULT_STYLE.FAIL.fg) : ''}
      </tr>
    </table>
    ${templateResult.reason ? `<div style="margin-bottom:12px;color:${RESULT_STYLE.BLOCKED.fg}">Reason: ${escapeHtml(templateResult.reason)}</div>` : ''}
    <table style="border-collapse:collapse;margin-bottom:12px;">
      <tr>
        <th style="${headStyle}">Scenario</th>
        <th style="${headStyle}">Status</th>
        <th style="${headStyle}">LOB</th>
        <th style="${headStyle}">State</th>
        <th style="${headStyle}">Claim #</th>
      </tr>
      ${templateResult.scenarios.map(scenarioStatusRowHtml).join('')}
    </table>
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#555;">Full detail — per-requirement expected/actual, field editability, and template-content vs. payload validation in separate tables — is in the attached Excel workbook, one tab per scenario.</div>
  </body></html>`;
}

// Excel sheet names: max 31 chars, and "\ / ? * [ ] :" are all rejected outright — a scenario ID is normally
// well inside that (e.g. "DIG52-AUTO-PA"), but this sanitizes/truncates defensively and de-dupes rather than
// letting workbook.addWorksheet throw on some future, longer/odder scenario ID naming.
function sanitizeSheetName(name, used) {
  let base = String(name || 'Scenario').replace(/[\\/?*[\]:]/g, '-').slice(0, 31);
  if (!base) base = 'Scenario';
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) {
    const suffix = ` (${i})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    i += 1;
  }
  used.add(candidate);
  return candidate;
}

const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—');

// Writes one scenario's worth of content into `ws`: header/context block, the Interactive Session field-
// editability table (if this was an Interactive template) color-coded by result, then TWO separate
// requirement tables — "Template Content Validation" (everything derived from the template's own Word-doc
// requirements/fraud language) and "Payload Validation" (the XP-prefixed rows built from the Data
// Dictionary's Xpath column against the real SmartCOMM payload — see validationService.buildXpathRequirements)
// — kept apart per user direction 2026-09-30 since they're independent checks against different sources of
// truth and shouldn't be read as one list. Column-label rows get the same dark header styling, and every
// data row gets the same PASS/FAIL/BLOCKED/SKIPPED fill+font as the old email table, per user direction.
function writeScenarioSheet(ws, s) {
  ws.addRow([`Scenario ${s.scenarioId} — ${s.status}`]).font = { bold: true, size: 13 };
  ws.addRow(['LOB', s.lob, 'State', s.state, 'Claim #', s.claimNumber || '']);
  if (s.isFallbackClaim) {
    const warnRow = ws.addRow(['⚠ FALLBACK CLAIM', `No test-data claim actually matches this template's own State/LOB applicability — this scenario ran claim ${s.claimNumber} anyway (real LOB/State: ${s.lob}/${s.state}) so the template gets SOME coverage instead of none. Treat content results below with that in mind.`]);
    warnRow.font = { bold: true, color: { argb: 'FF9C6500' } };
    warnRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
    warnRow.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
  }
  if (s.variant) {
    ws.addRow(['Login', s.variant.user || 'admin', 'Document Type', s.variant.documentType, 'Status', s.variant.status,
      'Security Type', s.variant.securityType, 'Return Envelope', s.variant.returnEnvelope ? 'Yes' : 'No', 'Certified Mail', s.variant.certifiedMail ? 'Yes' : 'No']);
  }
  if (s.creationMode) ws.addRow(['Creation mode', s.creationMode]);
  if (s.pdfPath) ws.addRow(['PDF', s.pdfPath]);
  if (s.reason) ws.addRow(['Reason', s.reason]);
  // Which of this template's own conditional print paths actually got exercised — see
  // validationService.runScenario's own conditionalSummary comment.
  const cs = s.conditionalSummary;
  if (cs && (cs.additionalRecipientExpected || (cs.choicesAnswered && cs.choicesAnswered.length))) {
    const parts = [];
    if (cs.additionalRecipientExpected) {
      parts.push('Additional recipient', cs.additionalRecipientAdded ? `Yes (${cs.additionalRecipientName})` : 'No — not added this scenario');
    }
    if (cs.choicesAnswered && cs.choicesAnswered.length) {
      parts.push('Choices answered', cs.choicesAnswered.join('; '));
    } else if (cs.additionalRecipientExpected) {
      parts.push('Choices answered', '(none this scenario)');
    }
    ws.addRow(['Conditional logic exercised', ...parts]);
  }
  ws.addRow([]);

  const checks = s.interactiveChecks || [];
  if (checks.length) {
    const passed = checks.filter((c) => c.result === 'PASS').length;
    const failed = checks.filter((c) => c.result === 'FAIL').length;
    const skipped = checks.filter((c) => c.result === 'SKIPPED').length;
    // Result here is DICTIONARY-DRIVEN (Column G is the source of truth, per user direction 2026-10-05): PASS
    // only when a tracked dictionary row's own editability agrees with what the live session actually did;
    // FAIL when a tracked row disagrees (even if the field behaved consistently with its own CSS class —
    // that's no longer enough on its own); SKIPPED — not a pass or a fail — for a field with no tracked
    // dictionary row (or an unspecified Column G) to validate it against at all.
    ws.addRow([`Interactive Session — Field Editability (${passed} passed, ${failed} failed, ${skipped} skipped — no dictionary match, ${checks.length - passed - failed - skipped} blocked/unidentified)`]).font = { bold: true };
    // "Dictionary says editable?" comes straight from the Data Dictionary's own Column G (the source of
    // truth) — '—' when no tracked row matched this field, or that row's own Column G is blank/unspecified,
    // so there's nothing to compare against. "Observed in live session?" is the SEPARATE, independent fact
    // of what SmartCOMM itself actually rendered (its own th-data-value(-editable) CSS class) — kept in its
    // own column (not folded into one combined cell) specifically so a disagreement between the two is
    // visible at a glance without reading the Note text (per user direction 2026-10-05).
    styleHeaderRow(ws.addRow(['#', 'Field', 'Result', 'Dictionary says editable?', 'Observed in live session?', 'Edit took effect', 'Dictionary field', 'Note']));
    // A SKIPPED + locked/non-editable row is pure noise — it has no tracked dictionary row AND was never
    // editable, so its own content is already covered by the template's own requirement checks (per user
    // direction 2026-10-05: "we dont have to show those skipped fields...unless the field was editable").
    // A SKIPPED + editable row still needs a human to look, since it's a field someone COULD edit that we
    // couldn't tie back to a dictionary row — that one stays visible.
    const visibleChecks = checks.filter((c) => c.result !== 'SKIPPED' || c.expectedEditable === true);
    for (const c of visibleChecks) {
      const dictSaysCell = c.dictionaryField && c.dictionaryEditable !== null ? yn(c.dictionaryEditable) : '—';
      styleResultRow(ws.addRow([c.id, c.label, c.result, dictSaysCell, yn(c.expectedEditable), yn(c.observedChanged), c.dictionaryField || 'unmatched', c.reason || '']), c.result);
    }
    ws.addRow([]);
  }

  const allValidations = s.validations || [];
  const payloadRows = allValidations.filter((v) => /^XP/i.test(v.id || ''));
  const contentRows = allValidations.filter((v) => !/^XP/i.test(v.id || ''));

  const addValidationTable = (title, list) => {
    ws.addRow([title]).font = { bold: true };
    if (!list.length) {
      ws.addRow(['No requirements were evaluated for this scenario.']);
      ws.addRow([]);
      return;
    }
    styleHeaderRow(ws.addRow(['#', 'Requirement', 'Result', 'Expected', 'Actual', 'Reason']));
    for (const v of list) styleResultRow(ws.addRow([v.id || '', v.description || '', v.result, v.expected, v.actual, v.reason || '']), v.result);
    ws.addRow([]);
  };
  addValidationTable('Template Content Validation (from the template\'s own Word-doc requirements)', contentRows);
  if (payloadRows.length) addValidationTable('Payload Validation (Data Dictionary Xpath vs. SmartCOMM Payload)', payloadRows);
}

function buildExcelReport(templateResult) {
  const wb = new ExcelJS.Workbook();
  const skippedTotal = skippedCount(templateResult);

  const summarySheet = wb.addWorksheet('Summary');
  summarySheet.columns = [22, 22, 10, 8, 20, 12, 12, 14, 14, 10, 10, 22, 30].map((w) => ({ width: w }));
  summarySheet.addRow(['SmartCOMM Template Validation Result']).font = { bold: true, size: 14 };
  summarySheet.addRow([]);
  summarySheet.addRow(['Template', `${templateResult.templateName} (${templateResult.digNumber})`]);
  summarySheet.addRow(['Environment', `${(process.env.CC_ENV || '').toUpperCase()} / ${(process.env.CC_TIER || '').toUpperCase()}`]);
  styleResultRow(summarySheet.addRow(['Overall', templateResult.overall]), templateResult.overall);
  summarySheet.addRow([]);
  summarySheet.addRow(['Scenarios', templateResult.scenarioCount]);
  summarySheet.addRow(['Passed', templateResult.passed]);
  summarySheet.addRow(['Failed', templateResult.failed]);
  summarySheet.addRow(['Blocked', templateResult.blocked]);
  summarySheet.addRow(['Skipped', skippedTotal]);
  if (templateResult.errored) summarySheet.addRow(['Errored', templateResult.errored]);
  if (templateResult.reason) summarySheet.addRow(['Reason', templateResult.reason]);
  summarySheet.addRow([]);
  styleHeaderRow(summarySheet.addRow(['Scenario', 'Status', 'LOB', 'State', 'Claim #', 'Content Pass', 'Content Fail', 'Content Blocked', 'Content Skipped', 'Field Pass', 'Field Fail', 'Additional Recipient', 'Choices Answered']));
  for (const s of templateResult.scenarios) {
    const checks = s.interactiveChecks || [];
    const cs = s.conditionalSummary;
    const addlRecipCell = !cs || !cs.additionalRecipientExpected ? 'N/A — not required'
      : cs.additionalRecipientAdded ? `Yes (${cs.additionalRecipientName})` : 'No — not added this scenario';
    const choicesCell = !cs ? '' : (cs.choicesAnswered && cs.choicesAnswered.length ? cs.choicesAnswered.join('; ') : '(none)');
    styleResultRow(summarySheet.addRow([
      s.isFallbackClaim ? `⚠ ${s.scenarioId} (no LOB/State match — fallback claim)` : s.scenarioId, s.status, s.lob, s.state, s.claimNumber || '',
      s.passed || 0, s.failed || 0, s.blocked || 0, s.skipped || 0,
      checks.filter((c) => c.result === 'PASS').length, checks.filter((c) => c.result === 'FAIL').length,
      addlRecipCell, choicesCell,
    ]), s.status);
  }

  const usedNames = new Set(['Summary']);
  for (const s of templateResult.scenarios) {
    const ws = wb.addWorksheet(sanitizeSheetName(s.scenarioId, usedNames));
    ws.columns = [10, 45, 10, 30, 30, 45, 30, 30].map((w) => ({ width: w }));
    writeScenarioSheet(ws, s);
  }
  return wb;
}

// One copy of the template's own requirement source (.docx), the Excel workbook (Summary tab plus one tab
// per scenario — see buildExcelReport), and each scenario's generated PDF — lets a reviewer compare template
// vs. output without digging through the results\smartComm\downloads folder on the machine that ran the
// automation. Skips anything not on disk (a BLOCKED/ERROR scenario never generated a PDF) rather than
// failing the whole send.
async function buildAttachments(templateResult) {
  const attachments = [];
  if (templateResult.sourceFile && fs.existsSync(templateResult.sourceFile)) {
    attachments.push({ filename: path.basename(templateResult.sourceFile), path: templateResult.sourceFile });
  }
  const excelBuffer = await buildExcelReport(templateResult).xlsx.writeBuffer();
  attachments.push({ filename: `${templateResult.digNumber}_validation_report.xlsx`, content: excelBuffer });
  for (const s of templateResult.scenarios || []) {
    if (s.pdfPath && fs.existsSync(s.pdfPath)) {
      attachments.push({ filename: `${s.scenarioId}.pdf`, path: s.pdfPath });
    }
  }
  return attachments;
}

async function sendReport(templateResult) {
  const smtpHost = process.env.EMAIL_SMTP_HOST;
  if (!smtpHost) {
    console.log('[SmartComm] EMAIL_SMTP_HOST not set — skipping email notification');
    return;
  }
  if (!nodemailer) {
    console.log('[SmartComm] nodemailer not installed — skipping email notification');
    return;
  }
  const to = process.env.EMAIL_TO || 'amitmishra@donegalgroup.com';
  const from = process.env.EMAIL_FROM || process.env.EMAIL_SMTP_USER || 'automation@donegalgroup.com';
  const smtpUser = process.env.EMAIL_SMTP_USER;
  const smtpPass = process.env.EMAIL_SMTP_PASS;
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(process.env.EMAIL_SMTP_PORT || '587', 10),
    secure: false,
    ...(smtpUser && smtpPass ? { auth: { user: smtpUser, pass: smtpPass } } : {}),
    tls: { rejectUnauthorized: false },
  });

  const text = buildTextReport(templateResult);
  const html = buildHtmlReport(templateResult);
  const subject = `SmartCOMM Template Validation - ${templateResult.templateName} - ${templateResult.overall}`;
  const attachments = await buildAttachments(templateResult);
  await transporter.sendMail({ from, to, subject, text, html, attachments });
  console.log(`[SmartComm] Report emailed to ${to} with ${attachments.length} attachment(s): ${subject}`);
}

module.exports = {
  buildTextReport, buildHtmlReport, buildExcelReport, sendReport, buildAttachments,
  // Exported for bulkReportService.js to reuse the exact same per-scenario sheet layout/styling in a
  // multi-template consolidated workbook, instead of duplicating this logic.
  writeScenarioSheet, sanitizeSheetName, styleHeaderRow, styleResultRow, skippedCount,
};
