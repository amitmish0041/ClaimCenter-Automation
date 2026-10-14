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

async function emailResults(key, downloaded, to, foundIn) {
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
  const text = `Found and downloaded ${downloaded.length} file(s) under ${foundIn || 'the S3 bucket'} for key "${key}" (Planet: Test):\n\n` +
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

    // Preferred (2026-10-14): the admin UI's own API, across all three places a document's files can be — the
    // archive (emptied by the filing job within seconds), the filing job's processing folder (keeps the PDF +
    // .json — byte-identical to the archive copy), and input (the payload). Downloads everything found, so one
    // run returns PDF + .json + payload. Falls through to the click-through search below if the API isn't usable.
    const objs = await svc.findAllForKey(page, key).catch((e) => { console.log(`[S3] API search failed (${e.message}) — using the folder search.`); return null; });
    if (objs && objs.length) {
      const where = [...new Set(objs.map((o) => o.where))].join(' + ');
      console.log(`[S3] "${key}" → ${objs.length} file(s): ${objs.map((o) => `${o.key.split('/').pop()} [${o.where}]`).join(', ')}`);
      const downloaded = [];
      const failed = [];
      for (const o of objs) {
        try { downloaded.push(await svc._api.apiDownload(page, o.key, outDir)); } catch (err) {
          console.log(`[S3] FAILED to download "${o.key}": ${err.message}`);
          failed.push({ text: o.key, error: err.message });
        }
      }
      if (!downloaded.some((d) => /\.pdf$/i.test(d.fileName))) console.log(`[S3] WARNING: no PDF found for "${key}" (archive or processing folder).`);
      if (!downloaded.length) throw new Error(`all ${objs.length} matched file(s) failed to download`);
      const emailResult = await emailResults(key, downloaded, to, where);
      writeManifest({
        matches: downloaded.map((d) => ({ text: d.text, fileName: d.fileName })),
        failed, foundIn: where, emailed: emailResult.sent, emailReason: emailResult.reason || null, error: null,
      });
      console.log(`[S3] Done — ${downloaded.length} file(s) downloaded to ${outDir}`);
      return;
    }
    if (objs && !objs.length) console.log(`[S3] Nothing for "${key}" in the archive, processing or input folders via the API — trying the folder search as well...`);

    // Completed documents (PDF + .json + email) now live in the archive (output) folder; the original request
    // payloads live in input. Check the archive FIRST — that's where a finished document's files are — and fall
    // back to the input folder so a payload key still resolves. Downloads whatever matched, from whichever one.
    let foundIn = 'ClaimCenter Outbound > smartcomm > output > archive';
    let matches = await svc.searchSmartComm(page, key);
    if (!matches.length) {
      console.log(`[S3] No match for "${key}" in the archive — checking the input (payload) folder...`);
      foundIn = 'ClaimCenter Outbound > smartcomm > input';
      matches = await svc.searchSmartCommPayload(page, key);
    }
    if (!matches.length) {
      console.log(`[S3] No files matched "${key}" in the archive or input folders — nothing downloaded, nothing emailed.`);
      writeManifest({ matches: [], emailed: false, error: `No files matched "${key}"` });
      return;
    }
    console.log(`[S3] "${key}" → ${matches.length} file(s) under ${foundIn}`);
    // One file at a time, so a single failed download (e.g. the PDF) is reported instead of silently leaving
    // only the files that happened to download before it.
    const downloaded = [];
    const failed = [];
    for (const m of matches) {
      try {
        downloaded.push(...await svc.downloadMatches(page, [m], outDir));
      } catch (err) {
        console.log(`[S3] FAILED to download "${m.text}": ${err.message}`);
        failed.push({ text: m.text, error: err.message });
      }
    }
    if (!downloaded.some((d) => /\.pdf$/i.test(d.fileName))) {
      console.log(`[S3] WARNING: none of the downloaded files is a PDF for "${key}".`);
    }
    if (!downloaded.length) throw new Error(`all ${matches.length} matched file(s) failed to download`);
    const emailResult = await emailResults(key, downloaded, to, foundIn);
    writeManifest({
      matches: downloaded.map((d) => ({ text: d.text, fileName: d.fileName })),
      failed, foundIn, emailed: emailResult.sent, emailReason: emailResult.reason || null, error: null,
    });
    console.log(`[S3] Done — ${downloaded.length} file(s) downloaded to ${outDir}`);
  } catch (e) {
    writeManifest({ matches: [], emailed: false, error: e.message });
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('[S3] FAILED:', e.message); process.exit(1); });
