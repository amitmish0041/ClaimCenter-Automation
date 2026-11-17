/**
 * scripts/sortBcSmartCommPdfs.js
 * Pulls every BillingCenter SmartCOMM PDF from S3 (Inbound Pending > smartcomm > output > output > archive >
 * processing), reads its text, works out which BC template it is, and copies it into one folder per template:
 *   V:\Amit Int\SmartComm\BillingCenter-Templates\<NN - Template>\<guid>.pdf
 * Anything that matches no template goes to "_Unclassified" (with its subject line in index.csv) so rules can be added.
 *
 *   node scripts/sortBcSmartCommPdfs.js            download (cached) + classify + copy
 *   node scripts/sortBcSmartCommPdfs.js --classify-only   re-classify the local cache, no S3
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const OUT_ROOT = process.env.BC_SORT_OUT || 'V:\\Amit Int\\SmartComm\\BillingCenter-Templates';
const CACHE = path.join(OUT_ROOT, '_cache');
const PREFIXES = [
  'bc/inbound-files/pending/smartcomm/output/output/archive/processing',
  'billingcenter/inbound-files/pending/smartcomm/output/output/archive/processing',
];

// Order matters: first match wins. Tested against the "Re:" subject + the first lines of text.
const TEMPLATES = [
  ['03 - Missed Installment Notices', /missed installment/],
  ['05 - Returned Check Reasons', /returned check reason/],
  ['04 - Returned Payment Notices', /returned (payment|check)|payment (was )?returned|non-?sufficient|insufficient funds/],
  ['06 - Debit Notice', /debit notice/],
  ['07 - Returned Mail Free Form', /returned mail/],
  ['08 - Pre-collection Reminder Notices', /pre-?collection|final reminder|collection/],
  ['09 - EFT-ACH Welcome Letters', /welcome.*(eft|ach|automatic|electronic)|(eft|ach|automatic|electronic).*welcome/],
  ['10 - EFT-ACH Deactivation Notices', /deactivat|(eft|ach|automatic|electronic).*(cancel|terminat|discontinu|removed)/],
  ['11 - EFT-ACH Expiration Notices', /expir/],
  ['12 - Due Diligence Letter', /due diligence|unclaimed/],
  ['13 - Agency Bill Dunning Notices', /dunning|agency bill.*(past due|overdue|notice)/],
  ['14 - Agency Bill Statement', /agency bill statement|agency statement/],
  ['16 - List Bill Statement', /list bill/],
  ['15 - Statement of Account', /statement of account|account statement/],
  ['19 - Deposit Email', /deposit/],
  ['20 - Misapplied Money', /misapplied|suspense/],
  ['02 - Account Invoices', /invoice|amount due|installment (due|notice)|payment due/],
  ['01 - Blank Letter', /^$/], // placeholder; blank letters are judged below
];

// Body phrases confirmed on real BC output 2026-11-17 — checked before the subject-line rules.
const BODY_RULES = [
  ['05 - Returned Check Reasons', /not able to accept the enclosed payment/],
  ['09 - EFT-ACH Welcome Letters', /thank you for registering for automated payment/],
  ['20 - Misapplied Money', /re: recent payment applied to your account/],
  ['01 - Blank Letter', /\bre:\s*(edit\s*\d*\s*)*sincerely/],
];

function classify(text) {
  const t = text.replace(/\s+/g, ' ').toLowerCase();
  for (const [name, rx] of BODY_RULES) if (rx.test(t)) return { name, re: (t.match(/\bre:\s*([^.]{0,80})/) || [])[1] || '' };
  const re = (t.match(/\bre:\s*([^.]{0,80})/) || [])[1] || '';
  const head = t.slice(0, 1500);
  for (const [name, rx] of TEMPLATES) if (rx.source !== '^$' && (rx.test(re) || (!re && rx.test(head)))) return { name, re };
  for (const [name, rx] of TEMPLATES) if (rx.source !== '^$' && rx.test(head)) return { name, re };
  if (re === '' && t.length < 800) return { name: '01 - Blank Letter', re };
  return { name: '_Unclassified', re };
}

async function download() {
  const { chromium } = require('playwright');
  const { createS3SessionManager } = require('../helpers/s3Download/s3SessionManager');
  const { _api } = require('../helpers/s3Download/s3AdminService');
  const browser = await chromium.launch({ headless: false });
  const s3 = createS3SessionManager(browser);
  fs.mkdirSync(CACHE, { recursive: true });
  try {
    await s3.withPage(async (page) => {
      let prefix = null;
      for (const p of PREFIXES) {
        const items = await _api.apiList(page, p).catch(() => []);
        console.log(`[list] ${p} -> ${items.length}`);
        if (items.length) { prefix = p; break; }
      }
      if (!prefix) throw new Error('BillingCenter processing folder not found under any known prefix');
      const keys = new Set();
      for (const c of '0123456789abcdef') {
        const items = await _api.apiList(page, `${prefix}/${c}`);
        items.forEach((o) => /\.pdf$/i.test(o.key) && keys.add(o.key));
      }
      console.log(`[list] ${keys.size} PDFs`);
      let n = 0;
      for (const key of keys) {
        if (fs.existsSync(path.join(CACHE, key.split('/').pop()))) continue;
        await _api.apiDownload(page, key, CACHE).catch((e) => console.log(`[dl] ${key}: ${e.message}`));
        if (++n % 50 === 0) console.log(`[dl] ${n}`);
      }
    });
  } finally { await s3.close(); await browser.close(); }
}

async function sortCache() {
  for (const d of fs.readdirSync(OUT_ROOT)) if (/^(\d\d - |_Un)/.test(d)) fs.rmSync(path.join(OUT_ROOT, d), { recursive: true, force: true });
  const rows = [['file', 'template', 're_line']];
  const counts = {};
  for (const f of fs.readdirSync(CACHE).filter((x) => /\.pdf$/i.test(x))) {
    let res;
    try { res = classify((await pdfParse(fs.readFileSync(path.join(CACHE, f)))).text); }
    catch (e) { res = { name: '_Unreadable', re: e.message }; }
    const dir = path.join(OUT_ROOT, res.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(CACHE, f), path.join(dir, f));
    counts[res.name] = (counts[res.name] || 0) + 1;
    rows.push([f, res.name, `"${res.re.replace(/"/g, "'")}"`]);
  }
  fs.writeFileSync(path.join(OUT_ROOT, 'index.csv'), rows.map((r) => r.join(',')).join('\n'));
  console.log(JSON.stringify(counts, null, 1));
}

(async () => {
  if (!process.argv.includes('--classify-only')) await download();
  await sortCache();
})().catch((e) => { console.error(e); process.exit(1); });
