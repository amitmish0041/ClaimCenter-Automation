/**
 * scripts/runFnolIntakeAndCheck.js
 * After the prepared FNOL intake XMLs are in S3 (Claim Center > Inbound Pending > FNOLIntake): records the claims already
 * on each TEST policy, runs the FNOL Intake batch then the Inbound Chunk Work Queue (Server Tools > Batch Process Info, as
 * the admin), then re-checks every few minutes — claims appear several minutes after the work queue runs (HO-MI-70-26-
 * 0749529 took ~8 min on 2026-11-17) — and matches each NEW claim to its intake file by policy, loss date and loss ZIP.
 * Each policy search runs in a fresh browser context (a second search in one session showed the first one's rows).
 *
 *   node scripts/runFnolIntakeAndCheck.js [--no-batch] [--skip=<file substring>,...]
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
process.env.CC_ENV = 'cloud'; process.env.CC_TIER = 'test';
const { chromium } = require('playwright');
const B = require('../helpers/claimCenterBase');
const S = require('../helpers/regression/regressionSteps');

const DIR = (process.argv.find((a) => a.startsWith('--dir=')) || '').slice(6) || 'V:\\Amit Int\\FNOLIntake-Test\\20261118';
const noBatch = process.argv.includes('--no-batch');
const skip = ((process.argv.find((a) => a.startsWith('--skip=')) || '').slice(7)).split(',').filter(Boolean);
const OUT = path.join(__dirname, '..', 'results', 'fnol-intake');
const CLAIM_RE = /\b[A-Z]{2,4}-[A-Z]{2}-\d{2}-\d{2}-\d{7}\b/;
const iso = (s) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})|(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? (m[1] ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : `${m[4]}-${m[5]}-${m[6]}`) : ''; };
const zipOf = (xml) => { const blk = (xml.match(/<(Accident|Damage|Injury|Loss|Incident|Invoice)>[\s\S]*?<\/\1>/) || [''])[0]; return ((blk.match(/<Zip>(\d{5})/) || xml.match(/<Zip>(\d{5})/) || [])[1]) || ''; };

const log = JSON.parse(fs.readFileSync(path.join(DIR, 'changes.json'), 'utf8'));
// changes.json of either pass: the second pass (fixFnolIntakeFiles) carries policy / lossDate / the uploaded file name.
const files = log.map((l) => {
  const pol = l.changes.find((c) => c.field === 'PolicyNumber') || {};
  const loss = l.changes.find((c) => /^loss date/.test(c.note || '')) || {};
  const xml = fs.readFileSync(path.join(DIR, 'test-ready', l.source.replace(/[^A-Za-z0-9_ ()-]/g, ''), l.file), 'utf8');
  const file = l.lossDate ? l.file : l.file.replace(/^[^_]+__/, '').replace(/\.xml$/i, '_T1117.xml');
  return { source: l.source, file, insured: l.insured, kind: l.kind, policy: l.policy || pol.to, lossDate: l.lossDate || iso(loss.to), zip: zipOf(xml) };
}).filter((f) => f.policy && !skip.some((s) => f.file.includes(s)));
const policies = [...new Set(files.map((f) => f.policy))];

async function withPage(browser, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  try { await B.loginToClaimCenter(page, { username: process.env.CC_ADMIN_USER, password: process.env.CC_ADMIN_PASS }); return await fn(page); } finally { await ctx.close().catch(() => {}); }
}
// The results page lists the oldest claims first and pages the rest ("Displaying 1 - n"), so recent claims weren't on it
// (1002241712 showed July claims only): sort by Loss Date, newest first, and read that page.
const claimsOn = (browser, policy) => withPage(browser, async (page) => {
  await S.searchClaims(page, { policy }).catch(() => null);
  const firstDate = async () => { const r = await page.evaluate(() => [...document.querySelectorAll('tr[role="row"]')].map((x) => x.innerText).find((t) => /\d\d\/\d\d\/\d{4}/.test(t)) || ''); return iso(r); };
  for (let i = 0; i < 2; i++) {
    const before = await firstDate();
    await page.getByText('Loss Date', { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(3000);
    const rows = await page.evaluate(() => [...document.querySelectorAll('tr[role="row"]')].map((x) => x.innerText).filter((t) => /\d\d\/\d\d\/\d{4}/.test(t)));
    const ds = rows.map(iso).filter(Boolean);
    if (ds.length && ds[0] >= ds[ds.length - 1] && (await firstDate()) >= before) break;
  }
  const rows = await page.evaluate(() => [...document.querySelectorAll('tr[role="row"]')].filter((r) => r.offsetParent).map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()));
  return rows.map((r) => ({ claim: (r.match(CLAIM_RE) || [])[0], row: r })).filter((x) => x.claim && x.row.includes(policy));
});

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const say = (m) => { console.log(m); fs.appendFileSync(path.join(OUT, 'progress.log'), `${new Date().toISOString()} ${m}\n`); };
  const browser = await chromium.launch({ channel: 'chromium' });
  const before = {};
  for (const p of policies) { before[p] = await claimsOn(browser, p); say(`before: ${p} has ${before[p].length} claim(s)`); }
  if (!noBatch) {
    process.env.REG_ALLOW_BATCHES = '1'; // user-approved (2026-11-17)
    await withPage(browser, async (page) => {
      say(await S.runBatchProcess(page, 'FNOL Intake').catch((e) => `FNOL Intake: ${e.message.split('\n')[0]}`));
      say(await S.runBatchProcess(page, 'Inbound Chunk Work Queue').catch((e) => `Inbound Chunk: ${e.message.split('\n')[0]}`));
    });
  }
  // Re-check every 4 minutes until every file has a claim, or nothing new appears for two rounds (max ~40 min).
  let after = {}; let lastCount = -1; let still = 0;
  for (let round = 1; round <= 10; round++) {
    await new Promise((r) => setTimeout(r, 240000));
    for (const p of policies) after[p] = await claimsOn(browser, p);
    const count = policies.reduce((n, p) => n + after[p].filter((x) => !before[p].some((b) => b.claim === x.claim)).length, 0);
    say(`round ${round}: ${count} new claim(s) on the ${policies.length} policies (${files.length} files)`);
    if (count >= files.length) break;
    still = count === lastCount ? still + 1 : 0;
    lastCount = count;
    if (still >= 2) break;
  }
  // Match: same policy, same loss date, then the loss ZIP printed on the claim row.
  const report = [];
  for (const p of policies) {
    const fresh = after[p].filter((x) => !before[p].some((b) => b.claim === x.claim)).map((x) => ({ ...x, loss: iso(x.row) }));
    const onPolicy = files.filter((f) => f.policy === p);
    for (const f of onPolicy) {
      const cands = fresh.filter((x) => !x.used && x.loss === f.lossDate);
      const m = cands.find((x) => f.zip && x.row.includes(f.zip)) || (cands.length === 1 ? cands[0] : null);
      if (m) m.used = true;
      report.push({ ...f, claim: m ? m.claim : '', claimRow: m ? m.row : '', status: m ? 'claim created' : cands.length ? 'claim(s) created on this policy/date — could not tell which file' : 'no new claim' });
    }
    for (const x of fresh.filter((y) => !y.used)) report.push({ source: '(not matched to a file)', file: '', policy: p, lossDate: x.loss, claim: x.claim, claimRow: x.row, status: 'new claim on this policy' });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(OUT, `fnol-check-${stamp}.json`), JSON.stringify({ before, after, report }, null, 2));
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  fs.writeFileSync(path.join(OUT, `fnol-check-${stamp}.csv`), ['Source,File,Insured (file),TEST policy,Policy kind,Loss date,Loss ZIP,Claim,Status,Claim search row',
    ...report.map((r) => [r.source, r.file, r.insured, r.policy, r.kind, r.lossDate, r.zip, r.claim, r.status, r.claimRow].map(q).join(','))].join('\r\n'));
  say(`done: ${report.filter((r) => r.file && r.claim).length} of ${files.length} files matched to a new claim -> fnol-check-${stamp}.csv`);
  await browser.close();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
