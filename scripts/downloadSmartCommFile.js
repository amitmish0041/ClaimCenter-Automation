#!/usr/bin/env node
/**
 * scripts/downloadSmartCommFile.js
 * Finds a ClaimCenter SmartCOMM file in the Guidewire S3 Integration Files admin UI by (a substring of)
 * its key, downloads every match, and emails them as attachments. See helpers/s3Download/s3AdminService.js
 * for the browser automation and CONFIRMED-live notes on login/branch/matching behaviour.
 *
 *   node scripts/downloadSmartCommFile.js --key <substring or full key> [--email you@donegalgroup.com] [--out-dir DIR] [--headed]
 *
 * Always forces Planet = Test (per instruction — not exposed as an option). Writes a manifest.json into
 * --out-dir (default: results/s3Downloads/<timestamp>) alongside the downloaded file(s), for a caller
 * (e.g. the runner UI) to render without re-parsing console output.
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const svc = require('../helpers/s3Download/s3AdminService');

let nodemailer;
try { nodemailer = require('nodemailer'); } catch (_) { /* reported lazily below */ }

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

async function emailResults(key, downloaded, to) {
  const host = process.env.EMAIL_SMTP_HOST;
  if (!host) { console.log('[S3] EMAIL_SMTP_HOST not set — skipping email'); return { sent: false, reason: 'EMAIL_SMTP_HOST not set' }; }
  if (!nodemailer) { console.log('[S3] nodemailer not installed — skipping email'); return { sent: false, reason: 'nodemailer not installed' }; }
  const from = process.env.EMAIL_FROM || 'automation@donegalgroup.com';
  const transporter = nodemailer.createTransport({
    host, port: parseInt(process.env.EMAIL_SMTP_PORT || '587', 10), secure: false,
    ...(process.env.EMAIL_SMTP_USER && process.env.EMAIL_SMTP_PASS ? { auth: { user: process.env.EMAIL_SMTP_USER, pass: process.env.EMAIL_SMTP_PASS } } : {}),
    tls: { rejectUnauthorized: false },
  });
  const subject = `SmartCOMM S3 file(s) for key "${key}" (${downloaded.length})`;
  const text = `Found and downloaded ${downloaded.length} file(s) under ClaimCenter Inbound Pending > smartcomm > output > output for key "${key}" (Planet: Test):\n\n` +
    downloaded.map((d) => `- ${d.text}`).join('\n');
  await transporter.sendMail({
    from, to, subject, text,
    attachments: downloaded.map((d) => ({ filename: d.fileName, path: d.localPath })),
  });
  console.log(`[S3] Emailed ${downloaded.length} file(s) to ${to}`);
  return { sent: true };
}

(async () => {
  const key = String(arg('key', '')).trim();
  if (!key) throw new Error('--key is required');
  const to = String(arg('email', '')).trim() || process.env.EMAIL_TO || 'amitmishra@donegalgroup.com';
  const outDir = String(arg('out-dir', '')).trim() || path.join(__dirname, '..', 'results', 's3Downloads', String(Date.now()));
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  const writeManifest = (data) => fs.writeFileSync(manifestPath, JSON.stringify({ key, to, ...data }, null, 1));

  // channel:'chromium' runs the full bundled Chromium even when headless, so the packaged app doesn't ship the
  // separate ~270MB chromium-headless-shell build (see electron-app/scripts/stage-resources.js). No behavior
  // change: this stays headless by default, just on the full browser instead of the shell.
  const browser = await chromium.launch({ headless: !arg('headed', false), channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, acceptDownloads: true });
  page.setDefaultTimeout(30000);
  try {
    await svc.loginAndEnsureTestPlanet(page);
    const matches = await svc.searchSmartComm(page, key);
    if (!matches.length) {
      console.log(`[S3] No files matched "${key}" — nothing downloaded, nothing emailed.`);
      writeManifest({ matches: [], emailed: false, error: `No files matched "${key}"` });
      return;
    }
    const downloaded = await svc.downloadMatches(page, matches, outDir);
    const emailResult = await emailResults(key, downloaded, to);
    writeManifest({
      matches: downloaded.map((d) => ({ text: d.text, fileName: d.fileName })),
      emailed: emailResult.sent, emailReason: emailResult.reason || null, error: null,
    });
    console.log(`[S3] Done — ${downloaded.length} file(s) downloaded to ${outDir}`);
  } catch (e) {
    writeManifest({ matches: [], emailed: false, error: e.message });
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('[S3] FAILED:', e.message); process.exit(1); });
