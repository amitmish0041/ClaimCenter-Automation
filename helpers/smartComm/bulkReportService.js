/**
 * helpers/smartComm/bulkReportService.js
 * Builds and emails ONE consolidated report across several templates'
 * validateTemplate() results (scripts/bulkValidateSmartComm.js) — a
 * per-template summary table plus cross-template pattern analysis (which
 * requirement failures/blocks recur across multiple templates, which
 * scenarios errored, etc.), instead of reportService.js's one-email-per-
 * template behavior.
 *
 * Deliberately its OWN module rather than extending reportService.js —
 * that file's shape (one templateResult in, one email out) stays exactly as
 * the single-template SmartCOMM Validator Playwright spec already uses it;
 * this one takes an ARRAY of templateResults and produces a different kind
 * of report (aggregated patterns, not per-requirement detail for one run).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const reportService = require('./reportService');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (_) { /* reported lazily in sendBulkReport */ }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATUS_STYLE = {
  PASS: { bg: '#d4edda', fg: '#155724' },
  FAIL: { bg: '#f8d7da', fg: '#721c24' },
  BLOCKED: { bg: '#fff3cd', fg: '#856404' },
  ERROR: { bg: '#f8d7da', fg: '#721c24' },
};

// Groups every FAIL/BLOCKED validation across every scenario of every
// template by its own description text (verbatim — no fuzzy grouping),
// counting how many distinct scenarios and templates each one shows up in.
// A description recurring across MULTIPLE templates is the strongest signal
// of a systemic issue (a heuristic gap, a synonym missing from
// fieldLabelSynonyms.js, etc.) rather than one template's own content bug.
function analyzePatterns(templateResults, result) {
  const byDescription = new Map();
  for (const t of templateResults) {
    for (const s of t.scenarios || []) {
      for (const v of s.validations || []) {
        if (v.result !== result) continue;
        const key = v.description || '(no description)';
        if (!byDescription.has(key)) byDescription.set(key, { description: key, count: 0, templates: new Set(), reasons: new Set() });
        const entry = byDescription.get(key);
        entry.count += 1;
        entry.templates.add(`${t.digNumber} (${t.templateName})`);
        if (v.reason) entry.reasons.add(v.reason);
      }
    }
  }
  return Array.from(byDescription.values())
    .map((e) => ({ ...e, templates: Array.from(e.templates), reasons: Array.from(e.reasons) }))
    .sort((a, b) => b.templates.length - a.templates.length || b.count - a.count);
}

// Template-level (not requirement-level) failures — TEMPLATE_NOT_FOUND,
// GENERATE_FAILED, a raw ERROR reason, etc. Grouped the same way so a
// recurring cause (e.g. several claims all missing the same required data)
// stands out.
function analyzeScenarioReasons(templateResults) {
  const byReason = new Map();
  for (const t of templateResults) {
    for (const s of t.scenarios || []) {
      if (!s.reason) continue;
      // Normalize away the specific claim/scenario id prefix some reasons
      // carry, so "GENERATE_FAILED: ...(claim X)..." from two different
      // claims can still group together on the shared part of the message.
      const key = s.reason.split(/[:\n]/)[0].trim() || s.reason;
      if (!byReason.has(key)) byReason.set(key, { reason: key, count: 0, scenarios: [] });
      const entry = byReason.get(key);
      entry.count += 1;
      entry.scenarios.push(`${t.digNumber}/${s.scenarioId}`);
    }
  }
  return Array.from(byReason.values()).sort((a, b) => b.count - a.count);
}

// Rolls up every scenario's Interactive Session — field editability results (reportService.js's per-template
// section) across the whole bulk run: how many fields were checked overall, which field LABELS recur as
// FAIL across multiple templates (same idea as analyzePatterns — a label failing on several templates points
// at a shared/systemic issue, e.g. a field type this tool's edit logic doesn't support yet, not one
// template's own defect), which edits the editor accepted but never actually reached the completed PDF
// (verifyInteractiveEditsInPdf in validationService.js), and every case where the Data Dictionary's own
// Column G disagrees with what the editor actually enforced for that field.
function analyzeInteractiveChecks(templateResults) {
  let scenariosWithChecks = 0, totalFields = 0, passed = 0, failed = 0, pdfUnverified = 0;
  const failuresByLabel = new Map();
  const disagreementRows = [];
  for (const t of templateResults) {
    for (const s of t.scenarios || []) {
      if (!s.interactiveChecks || !s.interactiveChecks.length) continue;
      scenariosWithChecks += 1;
      for (const c of s.interactiveChecks) {
        totalFields += 1;
        if (c.result === 'PASS') passed += 1;
        if (c.result === 'FAIL') {
          failed += 1;
          const key = c.label || '(unlabeled)';
          if (!failuresByLabel.has(key)) failuresByLabel.set(key, { label: key, count: 0, templates: new Set() });
          const entry = failuresByLabel.get(key);
          entry.count += 1;
          entry.templates.add(`${t.digNumber} (${t.templateName})`);
        }
        if (c.verifiedInPdf === false) pdfUnverified += 1;
        if (c.dictionaryAgrees === false) {
          disagreementRows.push({
            template: `${t.digNumber} (${t.templateName})`, scenario: s.scenarioId, label: c.label,
            dictionaryEditable: c.dictionaryEditable, observedEditable: c.expectedEditable,
          });
        }
      }
    }
  }
  const failurePatterns = Array.from(failuresByLabel.values())
    .map((e) => ({ ...e, templates: Array.from(e.templates) }))
    .sort((a, b) => b.templates.length - a.templates.length || b.count - a.count);
  return { scenariosWithChecks, totalFields, passed, failed, pdfUnverified, failurePatterns, disagreementRows };
}

function interactiveSummaryHtml(templateResults) {
  const a = analyzeInteractiveChecks(templateResults);
  if (!a.scenariosWithChecks) return '';
  const td = 'padding:5px 8px;border:1px solid #ccc;font-family:Arial,sans-serif;font-size:12px;vertical-align:top;';
  const headStyle = 'padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;';
  const failureTable = a.failurePatterns.length ? `
    <div style="font-family:Arial,sans-serif;font-size:12px;color:#666;margin:8px 0 6px;">Field labels that failed editability/lock checks, sorted by how many DIFFERENT templates hit the same one — recurring across templates points at a shared gap (e.g. a field type this tool's edit logic doesn't support yet), not one template's own defect.</div>
    <table style="border-collapse:collapse;width:100%;margin-bottom:8px;">
      <tr><th style="${headStyle}">Field</th><th style="${headStyle}">Templates affected</th><th style="${headStyle}">Occurrences</th><th style="${headStyle}">Which templates</th></tr>
      ${a.failurePatterns.map((p) => `<tr><td style="${td}">${escapeHtml(p.label)}</td><td style="${td}text-align:center;font-weight:bold;color:${p.templates.length > 1 ? '#c0392b' : '#333'};">${p.templates.length}</td><td style="${td}text-align:center;">${p.count}</td><td style="${td}">${p.templates.map(escapeHtml).join('<br/>')}</td></tr>`).join('')}
    </table>` : '';
  const disagreementTable = a.disagreementRows.length ? `
    <div style="font-family:Arial,sans-serif;font-size:12px;color:#666;margin:8px 0 6px;">Fields where the Data Dictionary's own "Editable in SmartCOMM?" (Column G) disagrees with what the editor actually enforced — worth a BA/dictionary review.</div>
    <table style="border-collapse:collapse;width:100%;margin-bottom:8px;">
      <tr><th style="${headStyle}">Template</th><th style="${headStyle}">Scenario</th><th style="${headStyle}">Field</th><th style="${headStyle}">Dictionary says</th><th style="${headStyle}">Editor enforces</th></tr>
      ${a.disagreementRows.map((r) => `<tr><td style="${td}">${escapeHtml(r.template)}</td><td style="${td}">${escapeHtml(r.scenario)}</td><td style="${td}">${escapeHtml(r.label)}</td><td style="${td}">${r.dictionaryEditable ? 'Editable' : 'Locked'}</td><td style="${td}">${r.observedEditable ? 'Editable' : 'Locked'}</td></tr>`).join('')}
    </table>` : '';
  return `
    <h3 style="font-family:Arial,sans-serif;margin:24px 0 4px;">Interactive Session — cross-template summary</h3>
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#333;margin-bottom:6px;">
      ${a.scenariosWithChecks} interactive scenario(s) checked &nbsp;·&nbsp; ${a.totalFields} field(s) total &nbsp;·&nbsp;
      <span style="color:${STATUS_STYLE.PASS.fg}">${a.passed} passed</span> &nbsp;·&nbsp;
      <span style="color:${STATUS_STYLE.FAIL.fg}">${a.failed} failed</span>
      ${a.pdfUnverified ? ` &nbsp;·&nbsp; <span style="color:${STATUS_STYLE.FAIL.fg}">${a.pdfUnverified} edit(s) didn't survive into the completed PDF</span>` : ''}
    </div>
    ${failureTable}
    ${disagreementTable}`;
}

// Per-template rollup of the conditional print-logic this run actually exercised (additional recipient
// added for Copy/CC content, which Choices-panel questions got answered Yes) — added 2026-10-02 per user
// request for "a quick summary for each template" so a reviewer can see WHICH conditional paths were covered
// without opening every per-scenario tab. Rolls up across all of a template's scenarios since a template can
// run 1-3 scenarios and they don't always hit the same conditional path (e.g. one scenario's additional
// recipient lacked an address and got removed, another's didn't).
function summarizeConditional(t) {
  const scenarios = t.scenarios || [];
  const withAddl = scenarios.filter((s) => s.conditionalSummary && s.conditionalSummary.additionalRecipientExpected);
  let addlRecipCell = 'N/A — not required';
  if (withAddl.length) {
    const added = withAddl.filter((s) => s.conditionalSummary.additionalRecipientAdded);
    const names = Array.from(new Set(added.map((s) => s.conditionalSummary.additionalRecipientName).filter(Boolean)));
    addlRecipCell = `${added.length}/${withAddl.length} scenario(s)` + (names.length ? ` (${names.join(', ')})` : '');
  }
  const allChoices = new Set();
  let anyConditionalSummary = false;
  for (const s of scenarios) {
    const cs = s.conditionalSummary;
    if (!cs) continue;
    anyConditionalSummary = true;
    if (cs.choicesAnswered && cs.choicesAnswered.length) cs.choicesAnswered.forEach((c) => allChoices.add(c));
  }
  const choicesCell = allChoices.size ? Array.from(allChoices).join('; ') : (anyConditionalSummary ? '(none)' : '');
  return { addlRecipCell, choicesCell };
}

function buildHtmlReport(templateResults) {
  const totals = templateResults.reduce((acc, t) => {
    acc.scenarios += t.scenarioCount || 0;
    acc.passed += t.passed || 0;
    acc.failed += t.failed || 0;
    acc.blocked += t.blocked || 0;
    acc.errored += t.errored || 0;
    return acc;
  }, { scenarios: 0, passed: 0, failed: 0, blocked: 0, errored: 0 });

  const summaryRow = (label, value, color) =>
    `<td style="padding:6px 12px;text-align:center;">
       <div style="font-size:20px;font-weight:bold;color:${color || '#333'};font-family:Arial,sans-serif;">${value}</div>
       <div style="font-size:11px;color:#666;font-family:Arial,sans-serif;">${label}</div>
     </td>`;

  const templateRows = templateResults.map((t) => {
    const style = STATUS_STYLE[t.overall] || STATUS_STYLE.BLOCKED;
    const td = 'padding:5px 8px;border:1px solid #ccc;font-family:Arial,sans-serif;font-size:12px;';
    const { addlRecipCell, choicesCell } = summarizeConditional(t);
    const anyFallback = (t.scenarios || []).some((s) => s.isFallbackClaim);
    return `<tr style="background:${style.bg};color:${style.fg};">` +
      `<td style="${td}">${escapeHtml(t.digNumber)}${anyFallback ? ' <span title="No test-data claim matches this template\'s own State/LOB applicability — ran a fallback claim instead" style="color:#856404;font-weight:bold;">⚠ fallback claim</span>' : ''}</td>` +
      `<td style="${td}">${escapeHtml(t.templateName)}</td>` +
      `<td style="${td}font-weight:bold;">${escapeHtml(t.overall)}</td>` +
      `<td style="${td}text-align:center;">${t.scenarioCount}</td>` +
      `<td style="${td}text-align:center;">${t.passed}</td>` +
      `<td style="${td}text-align:center;">${t.failed}</td>` +
      `<td style="${td}text-align:center;">${t.blocked}</td>` +
      `<td style="${td}text-align:center;">${t.errored}</td>` +
      `<td style="${td}">${escapeHtml(addlRecipCell)}</td>` +
      `<td style="${td}">${escapeHtml(choicesCell)}</td>` +
      `<td style="${td}">${escapeHtml(t.reason || '')}</td>` +
      `</tr>`;
  }).join('');

  const failPatterns = analyzePatterns(templateResults, 'FAIL');
  const blockedPatterns = analyzePatterns(templateResults, 'BLOCKED');
  const scenarioReasons = analyzeScenarioReasons(templateResults);

  const patternTable = (title, patterns, resultKind) => {
    if (!patterns.length) return '';
    const style = STATUS_STYLE[resultKind] || STATUS_STYLE.BLOCKED;
    const rows = patterns.map((p) => {
      const td = 'padding:5px 8px;border:1px solid #ccc;font-family:Arial,sans-serif;font-size:12px;vertical-align:top;';
      return `<tr>` +
        `<td style="${td}">${escapeHtml(p.description)}</td>` +
        `<td style="${td}text-align:center;font-weight:bold;color:${p.templates.length > 1 ? '#c0392b' : '#333'};">${p.templates.length}</td>` +
        `<td style="${td}text-align:center;">${p.count}</td>` +
        `<td style="${td}">${p.templates.map(escapeHtml).join('<br/>')}</td>` +
        `<td style="${td}">${p.reasons.map(escapeHtml).join('<br/>')}</td>` +
        `</tr>`;
    }).join('');
    return `
      <h3 style="font-family:Arial,sans-serif;margin:24px 0 4px;color:${style.fg};">${title}</h3>
      <div style="font-family:Arial,sans-serif;font-size:12px;color:#666;margin-bottom:6px;">Sorted by how many DIFFERENT templates hit the same requirement description — a description appearing across multiple templates points at a systemic gap (a synonym, heuristic, or shared field mapping), not one template's own content bug.</div>
      <table style="border-collapse:collapse;width:100%;margin-bottom:8px;">
        <tr>
          <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;">Requirement description</th>
          <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;">Templates affected</th>
          <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;">Occurrences</th>
          <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;">Which templates</th>
          <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;">Reason(s)</th>
        </tr>
        ${rows}
      </table>`;
  };

  const scenarioReasonTable = scenarioReasons.length ? `
    <h3 style="font-family:Arial,sans-serif;margin:24px 0 4px;">Scenario-level failures (couldn't generate/validate at all)</h3>
    <table style="border-collapse:collapse;width:100%;margin-bottom:8px;">
      <tr>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;">Reason</th>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;">Count</th>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;">Scenarios</th>
      </tr>
      ${scenarioReasons.map((r) => {
        const td = 'padding:5px 8px;border:1px solid #ccc;font-family:Arial,sans-serif;font-size:12px;vertical-align:top;';
        return `<tr><td style="${td}">${escapeHtml(r.reason)}</td><td style="${td}text-align:center;">${r.count}</td><td style="${td}">${r.scenarios.map(escapeHtml).join(', ')}</td></tr>`;
      }).join('')}
    </table>` : '';

  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;">
    <h2 style="margin-bottom:4px;">SmartCOMM Bulk Validation — ${templateResults.length} templates</h2>
    <div style="font-size:14px;margin-bottom:12px;">
      ${escapeHtml((process.env.CC_ENV || '').toUpperCase())} / ${escapeHtml((process.env.CC_TIER || '').toUpperCase())}
    </div>
    <table style="border-collapse:collapse;margin-bottom:16px;">
      <tr>
        ${summaryRow('Templates', templateResults.length)}
        ${summaryRow('Scenarios', totals.scenarios)}
        ${summaryRow('Passed', totals.passed, STATUS_STYLE.PASS.fg)}
        ${summaryRow('Failed', totals.failed, STATUS_STYLE.FAIL.fg)}
        ${summaryRow('Blocked', totals.blocked, STATUS_STYLE.BLOCKED.fg)}
        ${summaryRow('Errored', totals.errored, STATUS_STYLE.ERROR.fg)}
      </tr>
    </table>

    <h3 style="font-family:Arial,sans-serif;margin:0 0 4px;">Per-template results</h3>
    <table style="border-collapse:collapse;width:100%;margin-bottom:8px;">
      <tr>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;">DIG</th>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;">Template</th>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;">Overall</th>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;">Scenarios</th>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;">Pass</th>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;">Fail</th>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;">Blocked</th>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;">Errored</th>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;">Additional Recipient</th>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;">Choices Answered</th>
        <th style="padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;">Reason</th>
      </tr>
      ${templateRows}
    </table>

    ${patternTable('Common FAIL patterns (content validation)', failPatterns, 'FAIL')}
    ${patternTable('Common BLOCKED patterns (couldn’t evaluate)', blockedPatterns, 'BLOCKED')}
    ${scenarioReasonTable}
    ${interactiveSummaryHtml(templateResults)}
  </body></html>`;
}

function buildTextReport(templateResults) {
  const lines = [`SmartCOMM Bulk Validation — ${templateResults.length} templates`, ''];
  for (const t of templateResults) {
    const { addlRecipCell, choicesCell } = summarizeConditional(t);
    const conditionalBits = [];
    if (addlRecipCell !== 'N/A — not required') conditionalBits.push(`Additional Recipient: ${addlRecipCell}`);
    if (choicesCell) conditionalBits.push(`Choices: ${choicesCell}`);
    lines.push(`${t.digNumber} - ${t.templateName}: ${t.overall} (${t.scenarioCount} scenarios, ${t.passed}P/${t.failed}F/${t.blocked}B/${t.errored}E)${t.reason ? ' — ' + t.reason : ''}${conditionalBits.length ? ' [' + conditionalBits.join('; ') + ']' : ''}`);
  }
  const ia = analyzeInteractiveChecks(templateResults);
  if (ia.scenariosWithChecks) {
    lines.push('', `Interactive Session — cross-template summary: ${ia.scenariosWithChecks} scenario(s), ${ia.totalFields} field(s) (${ia.passed} passed, ${ia.failed} failed)${ia.pdfUnverified ? `, ${ia.pdfUnverified} edit(s) didn't survive into the completed PDF` : ''}`);
  }
  lines.push('', 'Open the HTML version of this email for the full per-template table and cross-template pattern analysis.');
  return lines.join('\n');
}

// One workbook covering the whole bulk run: a "Summary" tab with one color-coded row per TEMPLATE (so the
// run's overall health is visible at a glance), plus one tab per SCENARIO across every template — reusing
// reportService.js's own per-scenario sheet layout/styling exactly, so a bulk run's detail looks identical to
// a single-template report, just consolidated into one file instead of needing N separate emails to compare
// across templates. Scenario IDs already carry their own DIG prefix (e.g. "DIG181-AUTO-PA"), so sheet names
// stay unique across templates without needing an extra prefix.
// Second sheet in the workbook (right after Summary, before the per-scenario detail tabs) — the same
// cross-template pattern analysis already shown in the email body (analyzePatterns/analyzeScenarioReasons/
// analyzeInteractiveChecks above), now also as an Excel tab per user direction 2026-10-02: a description
// recurring across MULTIPLE templates points at a systemic gap (a missing synonym, a heuristic, a shared
// field mapping) rather than one template's own content defect, so seeing it consolidated — not re-derived
// by eye from N separate per-template tabs — is the point of this sheet.
function writeCommonIssuesSheet(ws, templateResults) {
  ws.columns = [50, 16, 10, 50, 50].map((w) => ({ width: w }));
  ws.addRow(['Common Issues Across Templates']).font = { bold: true, size: 14 };
  ws.addRow(['A description/field recurring across multiple templates points at a systemic gap, not one template\'s own content defect.']);
  ws.addRow([]);

  const writePatternTable = (title, patterns, resultKey) => {
    ws.addRow([title]).font = { bold: true, size: 12 };
    if (!patterns.length) { ws.addRow(['None.']); ws.addRow([]); return; }
    reportService.styleHeaderRow(ws.addRow(['Requirement description', 'Templates affected', 'Occurrences', 'Which templates', 'Reason(s)']));
    for (const p of patterns) {
      reportService.styleResultRow(ws.addRow([p.description, p.templates.length, p.count, p.templates.join('; '), p.reasons.join('; ')]), resultKey);
    }
    ws.addRow([]);
  };
  writePatternTable('Common FAIL patterns (content validation)', analyzePatterns(templateResults, 'FAIL'), 'FAIL');
  writePatternTable('Common BLOCKED patterns (could not evaluate)', analyzePatterns(templateResults, 'BLOCKED'), 'BLOCKED');

  const scenarioReasons = analyzeScenarioReasons(templateResults);
  ws.addRow(['Scenario-level failures (could not generate/validate at all)']).font = { bold: true, size: 12 };
  if (!scenarioReasons.length) {
    ws.addRow(['None.']);
  } else {
    reportService.styleHeaderRow(ws.addRow(['Reason', 'Count', 'Scenarios', '', '']));
    for (const r of scenarioReasons) {
      reportService.styleResultRow(ws.addRow([r.reason, r.count, r.scenarios.join(', ')]), 'ERROR');
    }
  }
  ws.addRow([]);

  const ia = analyzeInteractiveChecks(templateResults);
  if (ia.scenariosWithChecks) {
    ws.addRow([`Interactive Session — cross-template summary: ${ia.scenariosWithChecks} scenario(s), ${ia.totalFields} field(s), ${ia.passed} passed, ${ia.failed} failed` +
      (ia.pdfUnverified ? `, ${ia.pdfUnverified} edit(s) didn't survive into the completed PDF` : '')]).font = { bold: true, size: 12 };
    if (ia.failurePatterns.length) {
      reportService.styleHeaderRow(ws.addRow(['Field', 'Templates affected', 'Occurrences', 'Which templates', '']));
      for (const p of ia.failurePatterns) {
        reportService.styleResultRow(ws.addRow([p.label, p.templates.length, p.count, p.templates.join('; ')]), 'FAIL');
      }
      ws.addRow([]);
    }
    if (ia.disagreementRows.length) {
      ws.addRow(['Dictionary vs. editor editability disagreements']).font = { bold: true };
      reportService.styleHeaderRow(ws.addRow(['Template', 'Scenario', 'Field', 'Dictionary says', 'Editor enforces']));
      for (const r of ia.disagreementRows) {
        ws.addRow([r.template, r.scenario, r.label, r.dictionaryEditable ? 'Editable' : 'Locked', r.observedEditable ? 'Editable' : 'Locked']);
      }
    }
  }
}

function buildBulkExcelReport(templateResults) {
  const wb = new ExcelJS.Workbook();

  const summarySheet = wb.addWorksheet('Summary');
  summarySheet.columns = [12, 36, 10, 10, 10, 10, 10, 10, 10, 22, 30, 50].map((w) => ({ width: w }));
  summarySheet.addRow([`SmartCOMM Bulk Validation — ${templateResults.length} template(s)`]).font = { bold: true, size: 14 };
  summarySheet.addRow(['Environment', `${(process.env.CC_ENV || '').toUpperCase()} / ${(process.env.CC_TIER || '').toUpperCase()}`]);
  summarySheet.addRow([]);

  const totals = templateResults.reduce((acc, t) => {
    acc.scenarios += t.scenarioCount || 0;
    acc.passed += t.passed || 0;
    acc.failed += t.failed || 0;
    acc.blocked += t.blocked || 0;
    acc.errored += t.errored || 0;
    return acc;
  }, { scenarios: 0, passed: 0, failed: 0, blocked: 0, errored: 0 });
  summarySheet.addRow(['Templates', templateResults.length, 'Scenarios', totals.scenarios, 'Passed', totals.passed, 'Failed', totals.failed, 'Blocked', totals.blocked]);
  summarySheet.addRow([]);

  reportService.styleHeaderRow(summarySheet.addRow(['DIG', 'Template', 'Overall', 'Scenarios', 'Passed', 'Failed', 'Blocked', 'Skipped', 'Errored', 'Additional Recipient', 'Choices Answered', 'Reason']));
  for (const t of templateResults) {
    const skipped = reportService.skippedCount(t);
    const { addlRecipCell, choicesCell } = summarizeConditional(t);
    // CONFIRMED per user direction 2026-10-05: a template whose own State/LOB applicability matches nothing
    // in the real test-data inventory now runs a FALLBACK claim instead of reporting a hard BLOCKED with zero
    // coverage (see scenarioService.getScenariosForTemplate) — flagged here so it's obvious at a glance which
    // templates' results came from a non-matching claim rather than a genuine applicability match.
    const anyFallback = (t.scenarios || []).some((s) => s.isFallbackClaim);
    reportService.styleResultRow(summarySheet.addRow([
      anyFallback ? `⚠ ${t.digNumber} (fallback claim)` : t.digNumber, t.templateName, t.overall, t.scenarioCount || 0, t.passed || 0, t.failed || 0, t.blocked || 0, skipped, t.errored || 0, addlRecipCell, choicesCell, t.reason || '',
    ]), t.overall);
  }

  writeCommonIssuesSheet(wb.addWorksheet('Common Issues'), templateResults);

  const usedNames = new Set(['Summary', 'Common Issues']);
  for (const t of templateResults) {
    for (const s of t.scenarios || []) {
      const ws = wb.addWorksheet(reportService.sanitizeSheetName(s.scenarioId, usedNames));
      ws.columns = [10, 45, 10, 30, 30, 45, 30, 30].map((w) => ({ width: w }));
      reportService.writeScenarioSheet(ws, s);
    }
  }
  return wb;
}

// Each individual template's own report (reportService.buildAttachments) attaches the template's source
// .docx (the mapping/requirement document) and every scenario's generated PDF — bulk runs went out WITHOUT
// any of that, just the consolidated Excel, until now (per user direction 2026-10-05: "works fine when
// individual templates are run" — bulk should match). Replicated here, but a bulk run can span dozens or
// hundreds of templates (e.g. a full-catalog scan) where attaching every PDF + every source .docx would
// produce an email far past any real SMTP server's size limit — capped at MAX_BULK_ATTACHMENT_BYTES total;
// once that's reached, the REST are left off (the Excel report — the actual data — always stays regardless)
// and the caller is told how many were skipped so that's visible, not a silent, possibly-bounced oversized
// send. Override via SMARTCOMM_BULK_ATTACHMENT_MAX_MB for a run where a bigger (or smaller) cap makes sense.
const MAX_BULK_ATTACHMENT_BYTES = Number(process.env.SMARTCOMM_BULK_ATTACHMENT_MAX_MB || 20) * 1024 * 1024;

async function buildBulkAttachments(templateResults) {
  const attachments = [];
  let totalBytes = 0;
  let skippedCount = 0;
  const addIfRoom = (filename, filePath) => {
    let size;
    try { size = fs.statSync(filePath).size; } catch (_) { return; }
    if (totalBytes + size > MAX_BULK_ATTACHMENT_BYTES) { skippedCount++; return; }
    attachments.push({ filename, path: filePath });
    totalBytes += size;
  };
  for (const t of templateResults) {
    // Prefixed with the DIG number: different templates' source docs can otherwise share a similar/colliding
    // basename, and this also makes it obvious which template each requirement doc belongs to in a flat
    // email attachment list (unlike a single-template email, where that's already implicit).
    if (t.sourceFile && fs.existsSync(t.sourceFile)) addIfRoom(`${t.digNumber}_${path.basename(t.sourceFile)}`, t.sourceFile);
    for (const s of t.scenarios || []) {
      if (s.pdfPath && fs.existsSync(s.pdfPath)) addIfRoom(`${s.scenarioId}.pdf`, s.pdfPath);
    }
  }
  return { attachments, skippedCount, totalBytes };
}

async function sendBulkReport(templateResults) {
  const smtpHost = process.env.EMAIL_SMTP_HOST;
  if (!smtpHost) {
    console.log('[SmartComm Bulk] EMAIL_SMTP_HOST not set — skipping email notification');
    return;
  }
  if (!nodemailer) {
    console.log('[SmartComm Bulk] nodemailer not installed — skipping email notification');
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

  const overall = templateResults.some((t) => t.overall === 'ERROR') ? 'ERROR'
    : templateResults.some((t) => t.overall === 'FAIL') ? 'FAIL'
    : templateResults.some((t) => t.overall === 'BLOCKED') ? 'BLOCKED' : 'PASS';
  const subject = `SmartCOMM Bulk Validation - ${templateResults.length} templates - ${overall}`;
  const text = buildTextReport(templateResults);
  const html = buildHtmlReport(templateResults);
  const excelBuffer = await buildBulkExcelReport(templateResults).xlsx.writeBuffer();
  const attachments = [{ filename: `smartcomm_bulk_validation_${templateResults.length}templates.xlsx`, content: excelBuffer }];
  const { attachments: fileAttachments, skippedCount, totalBytes } = await buildBulkAttachments(templateResults);
  attachments.push(...fileAttachments);
  const sizeNote = skippedCount
    ? `\n\n(${skippedCount} PDF/requirement-doc attachment(s) left off this email — past the ${(MAX_BULK_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0)}MB attachment cap. Every PDF is still in results/smartComm/downloads/ locally; raise SMARTCOMM_BULK_ATTACHMENT_MAX_MB to attach more next time.)`
    : '';
  await transporter.sendMail({ from, to, subject, text: text + sizeNote, html: html + (sizeNote ? `<p style="font-family:Arial,sans-serif;font-size:12px;color:#856404;">${escapeHtml(sizeNote.trim())}</p>` : ''), attachments });
  console.log(`[SmartComm Bulk] Report emailed to ${to} with ${attachments.length} attachment(s) (${(totalBytes / 1024 / 1024).toFixed(1)}MB of PDFs/docs${skippedCount ? `, ${skippedCount} skipped past the size cap` : ''}): ${subject}`);
}

module.exports = {
  sendBulkReport, buildHtmlReport, buildTextReport, buildBulkExcelReport, buildBulkAttachments,
  analyzePatterns, analyzeScenarioReasons, analyzeInteractiveChecks,
};
