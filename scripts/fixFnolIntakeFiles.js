/**
 * scripts/fixFnolIntakeFiles.js
 * Second pass on the prepared FNOL intake files, from the record errors ClaimCenter reported (Administration > Utilities >
 * Inbound Files, 2026-11-18):
 *   - "For input string: "T1117""  -> the file name must END IN A NUMBER: <name><MMDD>.xml (e.g. WEBAGENT_WC_3283631118.xml)
 *   - "Possible duplicate claims detected" -> one loss date per file per policy, not used by any claim already on that
 *     policy (claims seen on the policy + ClaimsCreatedLast3YrsInTest), inside the policy period, not in the future;
 *     every other claim date keeps its distance from the loss date
 *   - "Policy Number not found" (WC 1002241612 / 1002241626) -> the WC DE policies the intake accepted
 *   - "Unable to retrieve Policy" (Farmowners FOS-7234742) -> FOP-9995007
 * Files that already made a claim are left out. Writes <OUT>/test-ready + changes.csv / changes.json.
 *
 *   node scripts/fixFnolIntakeFiles.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PREV = 'V:\\Amit Int\\FNOLIntake-Test\\20261117';
const OUT = 'V:\\Amit Int\\FNOLIntake-Test\\20261118';
const TAG = '1118';
const TODAY = new Date(2026, 10, 18);
const DONE = ['WEBAGENT_PROPERTY_45621', 'WEBAGENT_PROPERTY_849', 'AllianceInvoice_012424031430-00395349259', 'AutoClaim_22533732', 'WorkClaim_22525765'];
// Policy periods (TEST payloads) or one in-force date (a TEST claim's loss date) for policies without a known period.
const POL = {
  1002241712: { period: ['2026-06-25', '2026-12-25'] }, 1002241915: { period: ['2026-06-29', '2026-12-29'] }, 1002241918: { period: ['2026-07-08', '2027-01-08'] },
  1002241856: { period: ['2026-07-02', '2027-07-02'] }, 1002241909: { period: ['2026-07-08', '2027-07-08'] },
  1002092137: { period: ['2026-01-07', '2027-01-07'] }, 1002236067: { period: ['2026-02-19', '2027-02-19'] }, 1002134160: { period: ['2026-03-01', '2027-03-01'] },
  1002239674: { period: ['2026-03-27', '2027-03-27'] }, 1002240903: { period: ['2026-06-01', '2027-06-01'] },
  1002241746: { inForce: '2026-08-06' }, 1002236400: { inForce: '2026-07-17' }, 1002241820: { inForce: '2026-08-06' }, 'FOP-9995007': { inForce: '2026-07-23' },
};
const REMAP = { 1002241612: ['1002239674', '1002240903'], 1002241626: ['1002240903', '1002239674'], 'FOS-7234742': ['FOP-9995007'] };

const ymd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

// Loss dates already used on each policy: claims seen in the last check + TEST claims workbook dump.
const used = {};
const addUsed = (p, d) => { if (p && d) (used[p] = used[p] || new Set()).add(d); };
const lastCheck = fs.readdirSync(path.join(__dirname, '..', 'results', 'fnol-intake')).filter((n) => /^fnol-check-.*\.json$/.test(n)).sort().pop();
if (lastCheck) {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'results', 'fnol-intake', lastCheck), 'utf8'));
  for (const side of [j.before, j.after]) for (const [p, rows] of Object.entries(side || {})) for (const r of rows) addUsed(p, isoOf(r.row));
}
// The policy search lists only part of a policy's claims (1002241712 showed 6, the duplicate check named 5 more), so every
// policy + loss date the first pass got "Possible duplicate claims" on is taken too.
try {
  const errs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'results', 'fnol-intake', 'inbound-errors.json'), 'utf8'));
  const first = JSON.parse(fs.readFileSync(path.join(PREV, 'changes.json'), 'utf8'));
  for (const e of errs.filter((x) => /duplicate claims/i.test(x.error))) {
    const l = first.find((f) => f.file.replace(/^[^_]+__/, '').replace(/\.xml$/i, '_T1117.xml') === e.file);
    if (!l) continue;
    const pol = (l.changes.find((c) => c.field === 'PolicyNumber') || {}).to;
    addUsed(pol, isoOf((l.changes.find((c) => c.note === 'loss date') || {}).to));
  }
} catch (_) { /* first pass not read */ }
try { for (const r of JSON.parse(fs.readFileSync(path.join(process.env.TEMP || '', 'testclaims.json'), 'utf8'))) addUsed(String(r.pol), String(r.loss).slice(0, 10)); } catch (_) { /* optional */ }

function pickDate(policy) {
  const p = POL[policy];
  const taken = used[policy] = used[policy] || new Set();
  const ok = (d) => d <= addDays(TODAY, -1) && !taken.has(iso(d)) && (!p.period || (d >= ymd(p.period[0]) && d < ymd(p.period[1])));
  if (p.period) {
    for (let d = addDays(TODAY, -2); d >= ymd(p.period[0]); d = addDays(d, -1)) if (ok(d)) { taken.add(iso(d)); return d; }
  } else {
    // Only one in-force date is known: stay within a few days of it (annual terms around it).
    for (const off of [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7]) { const d = addDays(ymd(p.inForce), off); if (ok(d)) { taken.add(iso(d)); return d; } }
  }
  throw new Error(`no free loss date left on ${policy}`);
}

const prevLog = JSON.parse(fs.readFileSync(path.join(PREV, 'changes.json'), 'utf8'));
fs.rmSync(OUT, { recursive: true, force: true });
const log = [];
const remapTurn = {};
for (const l of prevLog) {
  const base = l.file.replace(/^[^_]+__/, '').replace(/\.xml$/i, '');
  if (DONE.includes(base)) continue;
  const srcDir = l.source.replace(/[^A-Za-z0-9_ ()-]/g, '');
  const original = fs.readFileSync(path.join(PREV, 'original', srcDir, l.file), 'utf8');
  let xml = fs.readFileSync(path.join(PREV, 'test-ready', srcDir, l.file), 'utf8');
  const changes = [];
  // Policy (remap the ones the intake could not find).
  let policy = (xml.match(/<PolicyNumber>([^<]+)<\/PolicyNumber>/) || [])[1];
  const firstPolicy = policy;
  if (REMAP[policy]) {
    const opts = REMAP[policy];
    remapTurn[policy] = (remapTurn[policy] || 0) + 1;
    policy = opts[(remapTurn[policy] - 1) % opts.length];
    xml = xml.replace(`<PolicyNumber>${firstPolicy}</PolicyNumber>`, `<PolicyNumber>${policy}</PolicyNumber>`);
  }
  const origPolicy = (original.match(/<PolicyNumber>([^<]+)<\/PolicyNumber>/) || [])[1];
  changes.push({ field: 'PolicyNumber', from: origPolicy, to: policy, note: firstPolicy !== policy ? `TEST policy changed from ${firstPolicy} (intake: "Policy Number not found" / "Unable to retrieve Policy")` : 'TEST policy (same as first pass)' });
  // Dates from the ORIGINAL file, moved to this file's own loss date.
  const loss = pickDate(policy);
  const p = POL[policy];
  const dates = [...original.matchAll(/<([A-Za-z]+)>(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})<\/\1>/g)].map((m) => ({ tag: m[1], raw: m[2], ...parse(m[2]) })).filter((x) => x.d);
  const lossEntry = LOSS_TAGS.map((t) => dates.find((x) => x.tag === t)).find(Boolean);
  const shift = lossEntry ? dayDiff(loss, lossEntry.d) : 0;
  let out = xml;
  const cur = [...xml.matchAll(/<([A-Za-z]+)>(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})<\/\1>/g)].map((m) => ({ tag: m[1], raw: m[2] }));
  dates.forEach((x, i) => {
    if (KEEP_TAGS.includes(x.tag)) { changes.push({ field: x.tag, from: x.raw, to: x.raw, note: 'NOT changed: a personal date (birth / hire)' }); return; }
    let nd = addDays(x.d, shift);
    let note = x === lossEntry ? 'loss date (own date on this policy - "Possible duplicate claims" otherwise)' : `same distance from the loss date as in the source (${shift} days)`;
    if (x !== lossEntry && lossEntry && x.d < lossEntry.d && /Taken|Notice|Notified|Reported/i.test(x.tag)) { nd = addDays(loss, 1); note = 'was before the loss date in the source; day after the loss'; }
    if (nd > addDays(TODAY, -1)) { nd = addDays(TODAY, -1); note += '; capped at yesterday'; }
    if (p.period && nd < ymd(p.period[0])) { nd = ymd(p.period[0]); note += '; clamped to policy effective date'; }
    if (p.period && nd >= ymd(p.period[1])) { nd = addDays(ymd(p.period[1]), -1); note += '; clamped inside the policy expiration'; }
    const nv = fmt(nd, x);
    const now = cur[i];
    out = out.replace(`<${now.tag}>${now.raw}</${now.tag}>`, `<${now.tag}>${nv}</${now.tag}>`);
    changes.push({ field: x.tag, from: x.raw, to: nv, note });
  });
  // Name: must end in a number.
  const name = `${base}${TAG}.xml`;
  fs.mkdirSync(path.join(OUT, 'test-ready', srcDir), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'test-ready', srcDir, name), out);
  changes.unshift({ field: 'File name', from: `${base}.xml`, to: name, note: 'must end in a number (intake: For input string "T1117")' });
  log.push({ source: l.source, file: name, insured: l.insured, lossState: l.lossState, policyType: l.policyType, kind: l.kind, policy, lossDate: iso(loss), changes });
}
fs.writeFileSync(path.join(OUT, 'changes.json'), JSON.stringify(log, null, 2));
const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
fs.writeFileSync(path.join(OUT, 'changes.csv'), ['Source system,File,Policy type in file,Insured,Loss state,TEST policy kind,Field,Original value,New value,Note',
  ...log.flatMap((l) => l.changes.map((c) => [l.source, l.file, l.policyType, l.insured, l.lossState, l.kind, c.field, c.from, c.to, c.note].map(q).join(',')))].join('\r\n'));
for (const l of log) console.log(`${l.source.padEnd(18)} ${l.file.padEnd(48)} ${String(l.policy).padEnd(12)} ${l.lossDate}`);
console.log(`\n${log.length} files -> ${OUT}`);
