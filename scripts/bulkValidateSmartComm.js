/**
 * scripts/bulkValidateSmartComm.js
 * Runs helpers/smartComm/validationService.validateTemplate for a list of
 * templates, ONE shared browser/page across all of them (each template's own
 * scenarios still each log in fresh per scenarioVariants.js — this just
 * avoids restarting the browser per template), and emails ONE consolidated
 * report instead of the per-template SmartCOMM Validator Playwright spec's
 * one-email-per-template behavior. Also shares ONE S3 admin session (see
 * helpers/s3Download/s3SessionManager.js) across every scenario of every
 * template, instead of each Interactive scenario opening, logging into and
 * closing its own S3 browser context.
 *
 * Not a Playwright test — this is a plain Node script (its own browser via
 * the `playwright` package directly) so a long multi-template run isn't
 * bound by Playwright's own test timeout.
 *
 * Set SMARTCOMM_CONCURRENCY=2 (or higher) to run each template's own scenarios concurrently across separate
 * browser contexts instead of one at a time — see validateTemplate()'s own comment in validationService.js.
 * This script still validates one TEMPLATE at a time in sequence; only the scenarios WITHIN each template
 * parallelize.
 *
 * Usage:
 *   node scripts/bulkValidateSmartComm.js <digNumbersCsvOrFile> [outPath]
 *     - digNumbersCsvOrFile: comma-separated DIG numbers (DIG3,DIG25,...),
 *       OR a path to a JSON file shaped like discovery output
 *       ({ found: [{digNumber, ...}, ...] }) — the list this repo's
 *       template-discovery pass produces.
 *     - outPath: where to write the consolidated JSON results (default:
 *       results/smartComm/bulk/<timestamp>.json). The HTML/text summary is
 *       always also emailed (EMAIL_* env vars, same as reportService.js).
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const validationService = require('../helpers/smartComm/validationService');
const { createS3SessionManager } = require('../helpers/s3Download/s3SessionManager');
const bulkReportService = require('../helpers/smartComm/bulkReportService');
const catalogService = require('../helpers/smartComm/catalogService');
const { loginAsAdmin } = require('../helpers/claimCenterBase');

function resolveDigList(arg) {
  if (!arg) throw new Error('Usage: node scripts/bulkValidateSmartComm.js <digNumbersCsvOrFile> [outPath]');
  if (fs.existsSync(arg)) {
    const data = JSON.parse(fs.readFileSync(arg, 'utf8'));
    const list = Array.isArray(data.found) ? data.found : Array.isArray(data) ? data : [];
    return list.map((t) => (typeof t === 'string' ? t : t.digNumber)).filter(Boolean);
  }
  return arg.split(',').map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const digList = resolveDigList(process.argv[2]);
  const outPath = process.argv[3] || path.join(__dirname, '..', 'results', 'smartComm', 'bulk', `bulk-${Date.now()}.json`);
  const recipientEmail = process.env.SMARTCOMM_EMAIL || process.env.EMAIL_TO;
  // Opt-in: templates the index marks "Interactive" are skipped (BLOCKED) unless this is set — that flow
  // needs a real visible browser and a human to clear an Azure SSO/MFA prompt, so it can't run unattended.
  const interactive = /^(1|true|yes)$/i.test(process.env.SMARTCOMM_INTERACTIVE || '');
  // Opt-in: one representative scenario per template instead of the full LOB/State matrix — see
  // validateTemplate()'s own comment. For a sweep across MANY templates this cuts total runtime roughly
  // 3x while still exercising every template's content and field-editability at least once.
  const singleScenario = /^(1|true|yes)$/i.test(process.env.SMARTCOMM_SINGLE_SCENARIO || '');

  console.log(`[Bulk] Validating ${digList.length} templates: ${digList.join(', ')}${interactive ? ' (Interactive templates enabled — a browser window may need your sign-in)' : ''}`);
  const browser = await chromium.launch({ headless: !interactive });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  // One login up front so the very first template's own per-scenario login
  // (scenarioVariants.js) has an authenticated session to clearCookies() from
  // — matches how the single-template Playwright spec always starts cold too.
  await loginAsAdmin(page);

  // ONE S3 admin session shared across EVERY scenario of EVERY template in this run (see
  // s3SessionManager.js) — the same "one shared browser across templates" idea this script already applies
  // to the ClaimCenter `browser`/`page` above, just extended to the Interactive flow's S3 fetch too. Passed
  // into validateTemplate() so it reuses this instead of creating its own per-template session.
  const s3Session = createS3SessionManager(browser, { log: (m) => console.log(`[Bulk] ${m}`) });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Resumable: if outPath already has results (this exact path passed again after an earlier run was
  // interrupted — a crash, a killed process, an expired Azure session with no one there to re-auth), pick up
  // from there instead of re-running everything already done. Only meaningful when the SAME outPath is
  // passed on retry — a fresh default (timestamped) path always starts clean.
  const templateResults = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : [];
  const alreadyDone = new Set(templateResults.map((r) => r.digNumber));
  if (alreadyDone.size) console.log(`[Bulk] Resuming ${outPath} — ${alreadyDone.size} template(s) already done, skipping those.`);

  const startedAt = Date.now();
  for (let i = 0; i < digList.length; i++) {
    const dig = digList[i];
    if (alreadyDone.has(catalogService.normalizeDig(dig))) {
      console.log(`[Bulk] (${i + 1}/${digList.length}) ${dig} — already done, skipping.`);
      continue;
    }
    console.log(`\n[Bulk] (${i + 1}/${digList.length}) ${dig} — starting...`);
    try {
      const result = await validationService.validateTemplate(page, { digNumber: dig, recipientEmail, interactive, singleScenario, s3Session });
      templateResults.push(result);
      console.log(`[Bulk] (${i + 1}/${digList.length}) ${dig}: ${result.overall} (${result.scenarioCount} scenarios, ${result.passed} passed, ${result.failed} failed, ${result.blocked} blocked, ${result.errored} errored)`);
    } catch (err) {
      console.log(`[Bulk] (${i + 1}/${digList.length}) ${dig}: CRASHED — ${err.message}`);
      templateResults.push({
        digNumber: dig, templateName: dig, scenarios: [], scenarioCount: 0,
        passed: 0, failed: 0, blocked: 0, errored: 1, overall: 'ERROR', reason: err.message,
      });
    }
    // Written after EVERY template, not just at the end — a run across dozens of templates (each involving
    // a real login, document generation, and for Interactive ones a full edit/complete/S3-fetch cycle) can
    // run for hours; without this, killing or crashing partway through (a browser crash, a machine restart,
    // an Azure session finally expiring with no one there to re-auth) would silently lose every result
    // gathered so far. The file at outPath always reflects "everything completed up to this point".
    fs.writeFileSync(outPath, JSON.stringify(templateResults, null, 2));
    const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`[Bulk] Elapsed: ${elapsedMin} min — progress saved to ${outPath}`);
  }

  await s3Session.close();
  await browser.close();
  console.log(`\n[Bulk] Raw results written to ${outPath}`);

  await bulkReportService.sendBulkReport(templateResults);
}

main().catch((e) => { console.error('[Bulk] FAILED:', e); process.exit(1); });
