/**
 * scripts/fnolClaimLookup.js — finds the claim each processed FNOL intake file created: claim search by the file's TEST
 * policy (fresh browser context per search), the claim whose loss date is the file's loss date.
 * Pool passes put one file on one policy, so policy + loss date identifies the claim.
 *
 *   node scripts/fnolClaimLookup.js <changes.json dir> [<dir> ...]   -> results/fnol-intake/claims-<stamp>.json/.csv
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
process.env.CC_ENV = 'cloud'; process.env.CC_TIER = 'test';
const { chromium } = require('playwright');
const B = require('../helpers/claimCenterBase');
const S = require('../helpers/regression/regressionSteps');

const OUT = path.join(__dirname, '..', 'results', 'fnol-intake');
const CLAIM_RE = /\b[A-Z]{2,4}-[A-Z]{2}-\d{2}-\d{2}-\d{7}\b/;
const mdy = (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
const files = process.argv.slice(2).flatMap((d) => JSON.parse(fs.readFileSync(path.join(d, 'changes.json'), 'utf8')).map((f) => ({ ...f, dir: d })));
// Inbound Files outcome per file (fnolProbe --errors output of each pass).
const status = {};
for (const n of fs.readdirSync(OUT).filter((x) => /^inbound-errors\d*\.json$/.test(x)).sort()) {
  try { for (const e of JSON.parse(fs.readFileSync(path.join(OUT, n), 'utf8'))) status[e.file] = e; } catch (_) { /* skip */ }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  const rows = [];
  for (const f of files) {
    const base = f.file.replace(/\.xml$/i, '');
    const st = status[base] || {};
    let claim = ''; let row = '';
    if (!st.recordStatus || /Processed/i.test(st.recordStatus)) {
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      const page = await ctx.newPage();
      page.setDefaultTimeout(30000);
      try {
        await B.loginToClaimCenter(page, { username: process.env.CC_ADMIN_USER, password: process.env.CC_ADMIN_PASS });
        await S.searchClaims(page, { policy: f.policy }).catch(() => null);
        await page.waitForTimeout(2500);
        const all = await page.evaluate(() => [...document.querySelectorAll('tr[role="row"]')].filter((r) => r.offsetParent).map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()));
        const hit = all.find((r) => CLAIM_RE.test(r) && r.includes(mdy(f.lossDate)));
        if (hit) { claim = hit.match(CLAIM_RE)[0]; row = hit; }
      } catch (e) { row = `lookup error: ${e.message.split('\n')[0]}`; } finally { await ctx.close().catch(() => {}); }
    }
    rows.push({ source: f.source, file: f.file, insured: f.insured, kind: f.kind, product: f.product || '', policy: f.policy, policyState: f.policyState || '', lossDate: f.lossDate,
      inbound: [st.fileStatus, st.recordStatus].filter(Boolean).join(' / '), error: st.error || '', claim, claimRow: row });
    console.log(`${base.padEnd(42)} ${f.policy} ${f.lossDate} ${claim || st.error || '(no claim found)'}`);
  }
  await browser.close();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(OUT, `claims-${stamp}.json`), JSON.stringify(rows, null, 2));
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const cols = ['source', 'file', 'insured', 'kind', 'product', 'policy', 'policyState', 'lossDate', 'inbound', 'error', 'claim', 'claimRow'];
  fs.writeFileSync(path.join(OUT, `claims-${stamp}.csv`), [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n'));
  console.log(`\n${rows.filter((r) => r.claim).length} of ${rows.length} files have a claim -> claims-${stamp}.csv`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
