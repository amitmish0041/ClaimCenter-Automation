/**
 * scripts/emailMergedSweep.js
 * ONE email for a whole lane sweep: merges every lane's results of the given tags (later tags replace earlier ones per
 * template — reruns win) and sends the bulk report (summary in the body, full per-template / per-check detail workbook)
 * plus any extra files (e.g. the consolidated Jira-mapped report). Each lane otherwise emails only its own templates.
 *
 *   node scripts/emailMergedSweep.js all2-1116,rr1-1116 [extra.xlsx ...]
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const nodemailer = require('nodemailer');
const bulk = require('../helpers/smartComm/bulkReportService');

const [tags, ...extras] = process.argv.slice(2);
const dir = path.join(__dirname, '..', 'results', 'smartComm', 'bulk');
const merged = new Map();
for (const tag of tags.split(',')) {
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith(`${tag}-lane`) && /lane\d+\.json$/.test(n)).sort()) {
    for (const t of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) merged.set(t.digNumber, t);
  }
}
const results = [...merged.values()];

(async () => {
  const counts = {};
  for (const t of results) counts[t.overall] = (counts[t.overall] || 0) + 1;
  const subject = `SmartCOMM Validation - all ${results.length} templates - ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`;
  const attachments = [{ filename: `smartcomm_validation_${results.length}templates_details.xlsx`, content: await bulk.buildBulkExcelReport(results).xlsx.writeBuffer() }];
  for (const x of extras) attachments.push({ filename: path.basename(x), path: x });
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_SMTP_HOST,
    port: parseInt(process.env.EMAIL_SMTP_PORT || '587', 10),
    secure: false,
    ...(process.env.EMAIL_SMTP_USER && process.env.EMAIL_SMTP_PASS ? { auth: { user: process.env.EMAIL_SMTP_USER, pass: process.env.EMAIL_SMTP_PASS } } : {}),
    tls: { rejectUnauthorized: false },
  });
  const to = process.env.EMAIL_TO || 'amitmishra@donegalgroup.com';
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_SMTP_USER || 'automation@donegalgroup.com',
    to, subject, text: bulk.buildTextReport(results), html: bulk.buildHtmlReport(results), attachments,
  });
  console.log(`Emailed ${to}: ${subject} (${attachments.length} attachment(s))`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
