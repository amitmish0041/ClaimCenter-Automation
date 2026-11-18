/**
 * scripts/fnolFromPool.js — third pass on the FNOL intake files: TEST policies come from the shared PolicyCenter pool
 * (V:\Amit Int\TestData\PolicyPool\pc-policies.json, scripts/harvestPcPolicies.js), one file per policy.
 *
 * Learned from the first two passes (Administration > Utilities > Inbound Files):
 *   - the file name must end in a number that fits an int  -> the ORIGINAL file name is kept
 *   - "Possible duplicate claims detected" is a date WINDOW per policy -> every loss date is >= GAP days (default 5) away
 *     from any claim known on that policy (TEST claims workbook dump, earlier passes, claims made by this harness)
 *   - each policy is used once per pass, so our own new claims can't block one another
 * Files whose kind has no pooled policy yet are listed as "waiting for policy" and not written.
 *
 *   node scripts/fnolFromPool.js [--out=<dir>] [--only=<kind substring>] [--done=<base,...>]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
const SRC = 'V:\\Amit Int\\FNOLIntake-Test\\20261117';           // originals + first-pass log (kind, state, insured)
const POOL = process.env.POLICY_POOL_FILE || 'V:\\Amit Int\\TestData\\PolicyPool\\pc-policies.json';
const OUT = arg('out') || 'V:\\Amit Int\\FNOLIntake-Test\\20261118-pool';
const GAP = Number(process.env.FNOL_DATE_GAP) || 5;
const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
const RES = path.join(__dirname, '..', 'results', 'fnol-intake');
// Files that already made a claim (2026-11-17/18).
const DONE = ['WEBAGENT_PROPERTY_45621', 'WEBAGENT_PROPERTY_849', 'AllianceInvoice_012424031430-00395349259', 'AutoClaim_22533732',
  'WorkClaim_22525765', 'PropertyClaim_22669602', ...arg('done').split(',').filter(Boolean)];
const STATE = { PA: 'Pennsylvania', MI: 'Michigan', DE: 'Delaware', VA: 'Virginia', GA: 'Georgia', MD: 'Maryland', OH: 'Ohio', IA: 'Iowa', IN: 'Indiana', IL: 'Illinois', WI: 'Wisconsin', NC: 'North Carolina', NM: 'New Mexico', NE: 'Nebraska' };
// File kind -> PC products, in order of preference.
const PRODUCTS = {
  'Personal Auto': ['Personal Auto'], 'Commercial Auto': ['Commercial Auto (v7)', 'Commercial Auto'], Homeowners: ['Homeowners'],
  "Workers' Comp": ["Workers' Compensation (v7)", "Workers' Compensation"], 'Commercial Package': ['Commercial Package', 'General Liability (v7)', 'General Liability'],
  'Personal Excess Liability': ['Personal Umbrella'], Farmowners: [],
};
const productsFor = (kind) => (Object.entries(PRODUCTS).find(([k]) => kind.startsWith(k)) || [, []])[1];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ymd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayDiff = (a, b) => Math.round((Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / 864e5);
const isoOf = (s) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})|(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? (m[1] ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : `${m[4]}-${m[5]}-${m[6]}`) : ''; };
function parse(s) {
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return { d: new Date(+m[3], +m[1] - 1, +m[2]), padded: m[1].length === 2 && m[2].length === 2, fmt: 'mdy' };
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? { d: new Date(+m[1], +m[2] - 1, +m[3]), fmt: 'iso' } : null;
}
const fmt = (d, x) => (x.fmt === 'iso' ? iso(d) : x.padded ? `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}` : `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`);
const LOSS_TAGS = ['DateOfInjury', 'DateofLoss', 'DateOfLoss', 'Date'];
const KEEP_TAGS = ['DOB', 'DateOfBirth', 'BirthDate', 'DateOfHire', 'HireDate'];
const DATE_RE = /<([A-Za-z]+)>(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})<\/\1>/g;

// Known claim dates per policy.
const claimDates = {};
const addClaim = (p, d) => { if (p && d) (claimDates[p] = claimDates[p] || []).push(d); };
try { for (const r of JSON.parse(fs.readFileSync(path.join(process.env.TEMP || '', 'testclaims.json'), 'utf8'))) addClaim(String(r.pol), String(r.loss).slice(0, 10)); } catch (_) { /* optional */ }
for (const n of fs.readdirSync(RES).filter((x) => /^(fnol-check-.*|pool-pass-.*)\.json$/.test(x))) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(RES, n), 'utf8'));
    for (const side of [j.before, j.after]) for (const [p, rows] of Object.entries(side || {})) for (const r of rows) addClaim(p, isoOf(r.row));
    for (const f of j.files || []) addClaim(f.policy, f.lossDate); // earlier pool passes
  } catch (_) { /* skip */ }
}
for (const dir of ['20261117', '20261118']) {
  try { for (const l of JSON.parse(fs.readFileSync(`V:\\Amit Int\\FNOLIntake-Test\\${dir}\\changes.json`, 'utf8'))) addClaim(l.policy || (l.changes.find((c) => c.field === 'PolicyNumber') || {}).to, l.lossDate || isoOf((l.changes.find((c) => /^loss date/.test(c.note || '')) || {}).to)); } catch (_) { /* skip */ }
}

const pool = Object.values(JSON.parse(fs.readFileSync(POOL, 'utf8')).policies)
  .filter((p) => /In Force/i.test(p.status) && p.effective && p.expiration && ymd(p.effective) <= addDays(TODAY, -GAP - 2));
const usedPolicies = new Set(Object.keys(claimDates).filter((p) => (claimDates[p] || []).some((d) => d >= iso(addDays(TODAY, -60)))));

function pickPolicy(kind, st) {
  for (const product of productsFor(kind)) {
    const c = pool.filter((p) => p.product === product && !usedPolicies.has(p.policy));
    const best = c.find((p) => p.state === STATE[st]) || c[0];
    if (best) { usedPolicies.add(best.policy); return best; }
  }
  return null;
}
// Latest date before yesterday that is inside the term and GAP+ days from every known claim on the policy.
function pickDate(p) {
  const taken = (claimDates[p.policy] || []).map(ymd);
  for (let d = addDays(TODAY, -2); d >= ymd(p.effective); d = addDays(d, -1)) {
    if (d >= ymd(p.expiration)) continue;
    if (taken.every((t) => Math.abs(dayDiff(d, t)) >= GAP)) { addClaim(p.policy, iso(d)); return d; }
  }
  return null;
}

const first = JSON.parse(fs.readFileSync(path.join(SRC, 'changes.json'), 'utf8'));
fs.rmSync(OUT, { recursive: true, force: true });
const files = []; const waiting = [];
for (const l of first) {
  const base = l.file.replace(/^[^_]+__/, '').replace(/\.xml$/i, '');
  if (DONE.includes(base)) continue;
  if (arg('only') && !l.kind.includes(arg('only'))) continue;
  const srcDir = l.source.replace(/[^A-Za-z0-9_ ()-]/g, '');
  const original = fs.readFileSync(path.join(SRC, 'original', srcDir, l.file), 'utf8');
  const prepared = fs.readFileSync(path.join(SRC, 'test-ready', srcDir, l.file), 'utf8');
  const pol = pickPolicy(l.kind, l.lossState);
  if (!pol) { waiting.push({ source: l.source, file: `${base}.xml`, kind: l.kind, lossState: l.lossState, reason: productsFor(l.kind).length ? 'waiting for a pooled policy of this product' : 'no PolicyCenter product for this kind' }); continue; }
  const loss = pickDate(pol);
  if (!loss) { waiting.push({ source: l.source, file: `${base}.xml`, kind: l.kind, reason: `no free date on ${pol.policy}` }); continue; }
  const changes = [];
  const prevPol = (prepared.match(/<PolicyNumber>([^<]+)<\/PolicyNumber>/) || [])[1];
  const origPol = (original.match(/<PolicyNumber>([^<]+)<\/PolicyNumber>/) || [])[1];
  let out = prepared.replace(`<PolicyNumber>${prevPol}</PolicyNumber>`, `<PolicyNumber>${pol.policy}</PolicyNumber>`);
  changes.push({ field: 'PolicyNumber', from: origPol, to: pol.policy, note: `PC ${pol.product}, ${pol.state}, in force ${pol.effective} to ${pol.expiration} (${pol.insured})` });
  // Dates from the ORIGINAL file, shifted to the new loss date; personal dates kept.
  const dates = [...original.matchAll(DATE_RE)].map((m) => ({ tag: m[1], raw: m[2], ...parse(m[2]) })).filter((x) => x.d);
  const lossEntry = LOSS_TAGS.map((t) => dates.find((x) => x.tag === t)).find(Boolean);
  const shift = lossEntry ? dayDiff(loss, lossEntry.d) : 0;
  const cur = [...out.matchAll(DATE_RE)].map((m) => ({ tag: m[1], raw: m[2] }));
  dates.forEach((x, i) => {
    if (KEEP_TAGS.includes(x.tag)) { changes.push({ field: x.tag, from: x.raw, to: x.raw, note: 'NOT changed: a personal date (birth / hire)' }); return; }
    let nd = addDays(x.d, shift);
    let note = x === lossEntry ? `loss date (${GAP}+ days from any known claim on the policy)` : `same distance from the loss date as in the source (${shift} days)`;
    if (x !== lossEntry && lossEntry && x.d < lossEntry.d && /Taken|Notice|Notified|Reported/i.test(x.tag)) { nd = addDays(loss, 1); note = 'was before the loss date in the source; day after the loss'; }
    if (nd > addDays(TODAY, -1)) { nd = addDays(TODAY, -1); note += '; capped at yesterday'; }
    if (nd < ymd(pol.effective)) { nd = ymd(pol.effective); note += '; clamped to policy effective date'; }
    if (nd >= ymd(pol.expiration)) { nd = addDays(ymd(pol.expiration), -1); note += '; clamped inside the policy expiration'; }
    const nv = fmt(nd, x);
    const now = cur[i];
    if (now) out = out.replace(`<${now.tag}>${now.raw}</${now.tag}>`, `<${now.tag}>${nv}</${now.tag}>`);
    changes.push({ field: x.tag, from: x.raw, to: nv, note });
  });
  const name = `${base}.xml`; // original name (ends in the source's own number)
  fs.mkdirSync(path.join(OUT, 'test-ready', srcDir), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'test-ready', srcDir, name), out);
  files.push({ source: l.source, file: name, insured: l.insured, lossState: l.lossState, kind: l.kind, policy: pol.policy, product: pol.product, policyState: pol.state, policyInsured: pol.insured, lossDate: iso(loss), changes });
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'changes.json'), JSON.stringify(files, null, 2));
fs.writeFileSync(path.join(OUT, 'waiting.json'), JSON.stringify(waiting, null, 2));
const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
fs.writeFileSync(path.join(OUT, 'changes.csv'), ['Source system,File,Insured (file),Loss state,Kind,TEST policy,PC product,Policy state,Field,Original value,New value,Note',
  ...files.flatMap((l) => l.changes.map((c) => [l.source, l.file, l.insured, l.lossState, l.kind, l.policy, l.product, l.policyState, c.field, c.from, c.to, c.note].map(q).join(',')))].join('\r\n'));
for (const f of files) console.log(`${f.source.padEnd(18)} ${f.file.padEnd(44)} ${f.policy} ${f.policyState.padEnd(13)} ${f.lossDate}`);
console.log(`\n${files.length} files ready -> ${OUT}; ${waiting.length} waiting (${[...new Set(waiting.map((w) => w.kind))].join('; ')})`);
