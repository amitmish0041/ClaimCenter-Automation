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
};

function skippedCount(templateResult) {
  return templateResult.scenarios.reduce((sum, s) => sum + (s.skipped || 0), 0);
}

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
  lines.push('This is a plain-text summary — open the HTML version of this email for a full table of every requirement (expected vs. actual, pass/fail/blocked/skipped).');
  lines.push('');

  for (const s of templateResult.scenarios) {
    lines.push(`Scenario ${s.scenarioId} — ${s.status}`);
    lines.push(`LOB: ${s.lob}  State: ${s.state}${s.claimNumber ? '  Claim: ' + s.claimNumber : ''}`);
    if (s.reason) lines.push(`Reason: ${s.reason}`);
    for (const v of s.validations || []) {
      if (v.result === 'PASS') continue; // full detail is the HTML table; keep the text fallback to what needs attention
      lines.push(`  [${v.result}] ${v.id || ''} ${v.description}`);
      if (v.result !== 'SKIPPED') {
        lines.push(`    Expected: ${v.expected}`);
        lines.push(`    Actual:   ${v.actual}`);
      }
      if (v.reason) lines.push(`    Reason:   ${v.reason}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function validationRowHtml(v) {
  const style = RESULT_STYLE[v.result] || RESULT_STYLE.BLOCKED;
  const td = 'padding:4px 8px;border:1px solid #ccc;vertical-align:top;font-family:Consolas,Menlo,monospace;font-size:12px;';
  return `<tr style="background:${style.bg};color:${style.fg};">` +
    `<td style="${td}">${escapeHtml(v.id)}</td>` +
    `<td style="${td}font-family:Arial,sans-serif;">${escapeHtml(v.description)}</td>` +
    `<td style="${td}font-weight:bold;">${escapeHtml(v.result)}</td>` +
    `<td style="${td}">${escapeHtml(v.expected)}</td>` +
    `<td style="${td}">${escapeHtml(v.actual)}</td>` +
    `<td style="${td}font-family:Arial,sans-serif;">${escapeHtml(v.reason || '')}</td>` +
    `</tr>`;
}

function scenarioSectionHtml(s) {
  const headStyle = 'padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;';
  const rows = (s.validations || []).map(validationRowHtml).join('');
  return `
    <h3 style="font-family:Arial,sans-serif;margin:24px 0 4px;">Scenario ${escapeHtml(s.scenarioId)} — <span style="color:${(RESULT_STYLE[s.status] || RESULT_STYLE.BLOCKED).fg}">${escapeHtml(s.status)}</span></h3>
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#333;margin-bottom:8px;">
      LOB: ${escapeHtml(s.lob)} &nbsp; State: ${escapeHtml(s.state)}
      ${s.claimNumber ? ' &nbsp; Claim: ' + escapeHtml(s.claimNumber) : ''}
      ${s.pdfPath ? ' &nbsp; PDF: ' + escapeHtml(s.pdfPath) : ''}
      ${s.reason ? '<br/>Reason: ' + escapeHtml(s.reason) : ''}
    </div>
    ${rows ? `<table style="border-collapse:collapse;width:100%;margin-bottom:8px;">
      <tr>
        <th style="${headStyle}width:40px;">#</th>
        <th style="${headStyle}">Requirement</th>
        <th style="${headStyle}width:70px;">Result</th>
        <th style="${headStyle}width:22%;">Expected</th>
        <th style="${headStyle}width:22%;">Actual</th>
        <th style="${headStyle}width:18%;">Reason</th>
      </tr>
      ${rows}
    </table>` : '<div style="font-family:Arial,sans-serif;color:#888;">No requirements were evaluated for this scenario.</div>'}
  `;
}

function buildHtmlReport(templateResult) {
  const skippedTotal = skippedCount(templateResult);
  const summaryRow = (label, value, color) =>
    `<td style="padding:6px 12px;text-align:center;">
       <div style="font-size:20px;font-weight:bold;color:${color || '#333'};font-family:Arial,sans-serif;">${value}</div>
       <div style="font-size:11px;color:#666;font-family:Arial,sans-serif;">${label}</div>
     </td>`;

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
    ${templateResult.scenarios.map(scenarioSectionHtml).join('')}
  </body></html>`;
}

// One copy of the template's own requirement source (.docx) plus each
// scenario's generated PDF — lets a reviewer compare template vs. output
// without digging through the results\smartComm\downloads folder on the
// machine that ran the automation. Skips anything not on disk (a BLOCKED/
// ERROR scenario never generated a PDF) rather than failing the whole send.
function buildAttachments(templateResult) {
  const attachments = [];
  if (templateResult.sourceFile && fs.existsSync(templateResult.sourceFile)) {
    attachments.push({ filename: path.basename(templateResult.sourceFile), path: templateResult.sourceFile });
  }
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
  const attachments = buildAttachments(templateResult);
  await transporter.sendMail({ from, to, subject, text, html, attachments });
  console.log(`[SmartComm] Report emailed to ${to} with ${attachments.length} attachment(s): ${subject}`);
}

module.exports = { buildTextReport, buildHtmlReport, sendReport, buildAttachments };
