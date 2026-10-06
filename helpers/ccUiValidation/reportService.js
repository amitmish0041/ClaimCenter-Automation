/**
 * helpers/ccUiValidation/reportService.js
 * HTML + text report for the ClaimCenter UI-vs-requirements check, saved under
 * results/ccUi/ and optionally emailed with the same EMAIL_* env vars the
 * SmartCOMM template report uses.
 */
'use strict';
const fs = require('fs');
const path = require('path');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (_) { /* reported lazily */ }

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STYLE = {
  PASS: { bg: '#d4edda', fg: '#155724' },
  FAIL: { bg: '#f8d7da', fg: '#721c24' },
  REVIEW: { bg: '#ffe8cc', fg: '#8a4b08' },
  BLOCKED: { bg: '#fff3cd', fg: '#856404' },
};
const SCREEN_ORDER = ['Select Template', 'Recipients', 'Additional Data', 'Create', 'Filter Documents', 'Document Properties', 'Business Rules'];

function counts(validations) {
  const c = { PASS: 0, FAIL: 0, REVIEW: 0, BLOCKED: 0 };
  for (const v of validations) c[v.result] = (c[v.result] || 0) + 1;
  return c;
}

function overall(c) { return c.FAIL ? 'FAIL' : c.REVIEW ? 'REVIEW' : c.BLOCKED ? 'BLOCKED' : 'PASS'; }

function grouped(validations) {
  const by = {};
  for (const v of validations) (by[v.screen] = by[v.screen] || []).push(v);
  return Object.keys(by).sort((a, b) => (SCREEN_ORDER.indexOf(a) + 100) % 100 - (SCREEN_ORDER.indexOf(b) + 100) % 100 || a.localeCompare(b)).map((k) => [k, by[k]]);
}

function buildTextReport(r) {
  const c = counts(r.validations);
  const lines = [
    `ClaimCenter UI vs Requirements — ${overall(c)}`,
    `${r.env} / ${r.tier} | claim ${r.claimNumber} | template ${r.templateDig} | user ${r.user}`,
    `Spec: ${r.specFile}`,
    `PASS ${c.PASS}  FAIL ${c.FAIL}  REVIEW ${c.REVIEW}  BLOCKED ${c.BLOCKED}`, '',
  ];
  for (const [screen, list] of grouped(r.validations)) {
    lines.push(`== ${screen}`);
    for (const v of list) {
      if (v.result === 'PASS') continue;
      lines.push(`  [${v.result}] ${v.id} ${v.description}`, `    Expected: ${v.expected}`, `    Actual:   ${v.actual}`);
      if (v.reason) lines.push(`    Note:     ${v.reason}`);
    }
  }
  if ((r.openItems || []).length) lines.push('', '== Open items — waiting on your input (to be provided later)', ...r.openItems.map((o) => `  - [${o.ref}] ${o.text}`));
  if (r.specObservations.length) lines.push('', '== Spec observations', ...r.specObservations.map((o) => `  - ${o}`));
  return lines.join('\n');
}

function rowHtml(v) {
  const s = STYLE[v.result] || STYLE.BLOCKED;
  const td = 'padding:4px 8px;border:1px solid #ccc;vertical-align:top;font-size:12px;';
  return `<tr style="background:${s.bg};color:${s.fg};">` +
    `<td style="${td}font-family:Consolas,monospace;">${esc(v.id)}</td>` +
    `<td style="${td}font-family:Arial,sans-serif;">${esc(v.description)}</td>` +
    `<td style="${td}font-weight:bold;">${esc(v.result)}</td>` +
    `<td style="${td}font-family:Consolas,monospace;">${esc(v.expected)}</td>` +
    `<td style="${td}font-family:Consolas,monospace;">${esc(v.actual)}</td>` +
    `<td style="${td}font-family:Arial,sans-serif;">${esc(v.reason)}</td></tr>`;
}

function buildHtmlReport(r) {
  const c = counts(r.validations);
  const head = 'padding:6px 8px;border:1px solid #ccc;background:#343a40;color:#fff;font-family:Arial,sans-serif;font-size:12px;text-align:left;';
  const stat = (label, n, color) => `<td style="padding:6px 14px;text-align:center;"><div style="font-size:20px;font-weight:bold;color:${color};font-family:Arial,sans-serif;">${n}</div><div style="font-size:11px;color:#666;font-family:Arial,sans-serif;">${label}</div></td>`;
  const sections = grouped(r.validations).map(([screen, list]) => {
    const cc = counts(list);
    return `<h3 style="font-family:Arial,sans-serif;margin:22px 0 4px;">${esc(screen)} <span style="font-size:12px;font-weight:normal;color:#555;">— ${cc.PASS} pass, ${cc.FAIL} fail, ${cc.REVIEW} review, ${cc.BLOCKED} blocked</span></h3>
      <table style="border-collapse:collapse;width:100%;margin-bottom:8px;"><tr>
        <th style="${head}width:90px;">Req</th><th style="${head}">Requirement</th><th style="${head}width:70px;">Result</th>
        <th style="${head}width:22%;">Expected</th><th style="${head}width:22%;">Actual</th><th style="${head}width:20%;">Note</th></tr>
        ${list.map(rowHtml).join('')}</table>`;
  }).join('');
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;">
    <h2 style="margin-bottom:4px;">ClaimCenter UI vs Requirements — <span style="color:${STYLE[overall(c)].fg}">${overall(c)}</span></h2>
    <div style="font-size:13px;margin-bottom:10px;color:#333;">${esc(r.env)} / ${esc(r.tier)} &nbsp;·&nbsp; claim ${esc(r.claimNumber)} &nbsp;·&nbsp; template ${esc(r.templateDig)} &nbsp;·&nbsp; login ${esc(r.user)}<br/>
      Spec: ${esc(r.specFile)}</div>
    <table style="border-collapse:collapse;"><tr>${stat('Passed', c.PASS, STYLE.PASS.fg)}${stat('Failed', c.FAIL, STYLE.FAIL.fg)}${stat('Review', c.REVIEW, STYLE.REVIEW.fg)}${stat('Blocked', c.BLOCKED, STYLE.BLOCKED.fg)}</tr></table>
    <div style="font-size:12px;color:#555;margin:6px 0;">REVIEW = differs from the spec but may be acceptable (needs a human call). BLOCKED = cannot be verified automatically yet, or not safely.</div>
    ${(r.openItems || []).length ? `<div style="margin:14px 0;padding:10px 14px;border:1px solid #f0c36d;background:#fff8e1;border-radius:6px;">
      <div style="font-weight:bold;font-size:13px;margin-bottom:4px;">Open items — waiting on your input (to be provided later)</div>
      <ul style="margin:4px 0 0 18px;padding:0;font-size:12px;color:#333;">${r.openItems.map((o) => `<li style="margin-bottom:3px;"><b>${esc(o.ref)}</b> — ${esc(o.text)}</li>`).join('')}</ul></div>` : ''}
    ${sections}
    <h3 style="font-family:Arial,sans-serif;margin:22px 0 4px;">Spec observations</h3>
    <ul style="font-size:12px;color:#333;">${r.specObservations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>
  </body></html>`;
}

function saveReport(r, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = path.join(dir, name || `ccui_${r.env}_${r.tier}_${r.templateDig}_${stamp}`);
  fs.writeFileSync(`${base}.html`, buildHtmlReport(r));
  fs.writeFileSync(`${base}.json`, JSON.stringify(r, null, 1));
  return `${base}.html`;
}

async function sendReport(r, htmlPath) {
  const host = process.env.EMAIL_SMTP_HOST;
  if (!host) return console.log('[CC-UI] EMAIL_SMTP_HOST not set — skipping email');
  if (!nodemailer) return console.log('[CC-UI] nodemailer not installed — skipping email');
  const to = process.env.EMAIL_TO || 'amitmishra@donegalgroup.com';
  const from = process.env.EMAIL_FROM || process.env.EMAIL_SMTP_USER || 'automation@donegalgroup.com';
  const transporter = nodemailer.createTransport({
    host, port: parseInt(process.env.EMAIL_SMTP_PORT || '587', 10), secure: false,
    ...(process.env.EMAIL_SMTP_USER && process.env.EMAIL_SMTP_PASS ? { auth: { user: process.env.EMAIL_SMTP_USER, pass: process.env.EMAIL_SMTP_PASS } } : {}),
    tls: { rejectUnauthorized: false },
  });
  const c = counts(r.validations);
  const subject = `ClaimCenter UI vs Requirements (${r.templateDig}) - ${overall(c)}`;
  await transporter.sendMail({ from, to, subject, text: buildTextReport(r), html: buildHtmlReport(r), attachments: htmlPath ? [{ filename: path.basename(htmlPath), path: htmlPath }] : [] });
  console.log(`[CC-UI] Report emailed to ${to}: ${subject}`);
}

module.exports = { buildTextReport, buildHtmlReport, saveReport, sendReport, counts, overall };
