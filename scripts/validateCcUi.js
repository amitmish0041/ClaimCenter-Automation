#!/usr/bin/env node
/**
 * scripts/validateCcUi.js
 * Validates the ClaimCenter "Create New Document" SCREENS against the
 * "Documents - Create Correspondence" requirement workbook (UI fields,
 * typelist values, conditional behaviour, document screens, business rules).
 * Separate from the SmartCOMM template-content validator (helpers/smartComm) on
 * purpose — a runner option can later pick "CC UI" vs "Template" and launch the
 * matching script.
 *
 *   node scripts/validateCcUi.js [--claim PA-PA-01-26-0748059] [--template DIG52] [--user 1]
 *        [--writes] [--br2-claims A,B] [--br2-states MD,DE,VA,GA,TN] [--no-br2] [--email] [--report-name NAME] [--headed]
 *
 * CC_ENV / CC_TIER select the environment (npm run ccui:test = cloud/test).
 * Default run is READ-ONLY: it opens the wizard, reads screens, flips the Delivery
 * Channel dropdown (Print only is ever generated) and cancels — nothing is saved or
 * sent. --writes additionally saves ONE document on the claim (Business Rule 1).
 */
'use strict';
require('dotenv').config();
const path = require('path');
const { chromium } = require('playwright');
const { loginAsUser, loginAsAdmin, openExistingClaim } = require('../helpers/claimCenterBase');
const testDataService = require('../helpers/smartComm/testDataService');
const spec = require('../helpers/ccUiValidation/specService');
const { validateWizardUi } = require('../helpers/ccUiValidation/wizardValidator');
const report = require('../helpers/ccUiValidation/reportService');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

// "Sorry, you do not have permission to view this claim" → retry as admin (same idea as the SmartCOMM validator).
async function claimAccessDenied(page, claimNumber) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await page.evaluate((n) => {
      const t = document.body.innerText || '';
      if (/do not have permission to view this claim/i.test(t)) return 'denied';
      return t.includes(`Claim: ${n}`) ? 'ok' : 'pending';
    }, claimNumber).catch(() => 'pending');
    if (state !== 'pending') return state === 'denied';
    await page.waitForTimeout(250);
  }
  return false;
}

(async () => {
  const templateDig = String(arg('template', 'DIG52')).toUpperCase();
  const userSlot = String(arg('user', '1'));
  const username = process.env[`SMARTCOMM_TEST_USER_${userSlot}`];
  const password = process.env[`SMARTCOMM_TEST_PASS_${userSlot}`];
  const writes = !!arg('writes', false);
  const records = testDataService.getAllRecords();
  let claimNumber = arg('claim', process.env.CC_UI_CLAIM);
  if (!claimNumber) {
    const pick = records.find((r) => r.state === 'PA' && /auto/i.test(r.lob)) || records[0];
    claimNumber = pick && pick.claimNumber;
  }
  if (!claimNumber) throw new Error('No claim to use — pass --claim <number> or set CC_UI_CLAIM');

  if (writes && String(process.env.CC_TIER || 'test').toLowerCase() !== 'test') {
    throw new Error('--writes is only allowed on the test tier (CC_TIER=test)');
  }

  const specData = spec.loadSpec();
  console.log(`[CC-UI] spec: ${specData.file} (${specData.uiFields.length} UI field rows, ${Object.keys(specData.typelists).length} typelists)`);

  const browser = await chromium.launch({ headless: !arg('headed', false) });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1300 } });
  page.setDefaultTimeout(30000);
  let loginName = username || 'admin';
  let asAdmin = !(username && password);

  // Opens a claim as the current login, falling back to admin once if it isn't viewable.
  const openClaim = async (number) => {
    await openExistingClaim(page, number);
    if (await claimAccessDenied(page, number)) {
      if (asAdmin) throw new Error(`CLAIM_ACCESS_DENIED: ${number} is not viewable even as admin`);
      console.log(`[CC-UI] ${loginName} cannot view ${number} — switching to admin`);
      await loginAsAdmin(page);
      asAdmin = true;
      loginName = `${loginName} → admin`;
      await openExistingClaim(page, number);
      if (await claimAccessDenied(page, number)) throw new Error(`CLAIM_ACCESS_DENIED: ${number} is not viewable even as admin`);
    }
  };

  try {
    if (asAdmin) await loginAsAdmin(page); else await loginAsUser(page, username, password);
    await openClaim(claimNumber);

    // Claims whose New Activity menus are scanned for Business Rule 2 (main claim + any requested extras).
    const extra = new Set();
    String(arg('br2-claims', '')).split(',').map((s) => s.trim()).filter(Boolean).forEach((c) => extra.add(c));
    String(arg('br2-states', '')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).forEach((st) => {
      const rec = records.find((r) => r.state === st && r.claimNumber !== claimNumber);
      if (rec) extra.add(rec.claimNumber); else console.log(`[CC-UI] no test-data claim for state ${st} — skipped for BR2`);
    });
    const br2Claims = arg('no-br2', false) ? [] : [claimNumber, ...extra].map((n) => ({ claimNumber: n, open: () => openClaim(n) }));

    const result = await validateWizardUi(page, { spec: specData, templateDig, writes, br2Claims });
    // Wizard/activity screens leave the claim; make sure the report shows who ran it.
    const full = {
      env: (process.env.CC_ENV || 'onprem').toUpperCase(), tier: (process.env.CC_TIER || 'test').toUpperCase(),
      claimNumber, templateDig, user: loginName, specFile: specData.file, writes, ...result,
    };
    const c = report.counts(full.validations);
    const htmlPath = report.saveReport(full, path.join(__dirname, '..', 'results', 'ccUi'), typeof arg('report-name', false) === 'string' ? arg('report-name') : undefined);
    console.log(`[CC-UI] ${report.overall(c)} — PASS ${c.PASS} / FAIL ${c.FAIL} / REVIEW ${c.REVIEW} / BLOCKED ${c.BLOCKED}`);
    console.log(`[CC-UI] report: ${htmlPath}`);
    for (const v of full.validations.filter((x) => x.result === 'FAIL')) console.log(`  FAIL ${v.id} ${v.description}\n       expected: ${v.expected}\n       actual:   ${v.actual}${v.reason ? `\n       note:     ${v.reason}` : ''}`);
    if (arg('email', false)) await report.sendReport(full, htmlPath);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('[CC-UI] FAILED:', e.message); process.exit(1); });
