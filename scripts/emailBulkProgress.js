/**
 * scripts/emailBulkProgress.js
 * Emails ONE consolidated report of what a still-running (or stopped) bulk SmartCOMM run has finished so far.
 * Input: a progress file from V:/Amit Int/SmartComm/run-history/in-progress (newest when omitted), or a Runner's
 * own results/smartComm/bulk/ui_bulk_*.json (a plain array of template results).
 *
 *   node scripts/emailBulkProgress.js [file] [--to=a@x.com,b@y.com]
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const nodemailer = require('nodemailer');
const bulk = require('../helpers/smartComm/bulkReportService');

const args = process.argv.slice(2);
const to = ((args.find((a) => a.startsWith('--to=')) || '').slice(5)) || process.env.EMAIL_TO || 'amitmishra@donegalgroup.com';
let file = args.find((a) => !a.startsWith('--'));
if (!file) {
  const dir = path.join(process.env.SMARTCOMM_SHARED_RUNS_DIR || 'V:/Amit Int/SmartComm/run-history', 'in-progress');
  const f = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) : [];
  if (!f.length) { console.error(`No progress file in ${dir}`); process.exit(1); }
  file = f[0];
}
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const results = Array.isArray(raw) ? raw : raw.templates;
const who = Array.isArray(raw) ? '' : ` (${raw.user}, ${raw.done}/${raw.total} templates, updated ${new Date(raw.updatedAt).toLocaleString()})`;

(async () => {
  const counts = {};
  for (const t of results) counts[t.overall] = (counts[t.overall] || 0) + 1;
  const subject = `SmartCOMM Validation - progress so far: ${results.length} templates done${raw.total ? ` of ${raw.total}` : ''} - ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`;
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_SMTP_HOST || 'smtp.donegalgroup.com', port: parseInt(process.env.EMAIL_SMTP_PORT || '25', 10), secure: false,
    ...(process.env.EMAIL_SMTP_USER && process.env.EMAIL_SMTP_PASS ? { auth: { user: process.env.EMAIL_SMTP_USER, pass: process.env.EMAIL_SMTP_PASS } } : {}),
    tls: { rejectUnauthorized: false },
  });
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'automation@donegalgroup.com', to, subject,
    text: `Run still in progress${who}.\n\n${bulk.buildTextReport(results)}`,
    html: `<p><b>Run still in progress${who}.</b> This covers only the templates finished so far.</p>${bulk.buildHtmlReport(results)}`,
    attachments: [{ filename: `smartcomm_progress_${results.length}templates_details.xlsx`, content: await bulk.buildBulkExcelReport(results).xlsx.writeBuffer() }],
  });
  console.log(`Emailed ${to}: ${subject}`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
