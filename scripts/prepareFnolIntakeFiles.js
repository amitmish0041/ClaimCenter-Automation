/**
 * scripts/prepareFnolIntakeFiles.js
 * Copies external-system FNOL intake files (\\dmi-win-cc9xq1\ClaimCenterData\FNOLIntake) to the V: drive and makes them
 * usable in TEST: up to 6 files per source system; the insured's policy number becomes a TEST policy of the SAME kind
 * as the file (auto → auto, homeowners → homeowners, a business insured's auto → commercial auto …), in the loss state
 * when TEST has one; every claim date moves inside that policy's period. Originals are kept next to the edited copies;
 * changes.csv / changes.json list every edit for review. Nothing is written back to the source share.
 *
 *   node scripts/prepareFnolIntakeFiles.js [perSource=6]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = '\\\\dmi-win-cc9xq1\\ClaimCenterData\\FNOLIntake';
const OUT = 'V:\\Amit Int\\FNOLIntake-Test\\20261117';
const PER_SOURCE = Number(process.argv[2]) || 6;
const TODAY = new Date(2026, 10, 17);

// TEST policies. `period` known from TEST claim payloads (11/10/2026 inside it); otherwise `inForce` = a loss date a
// TEST claim already has on that policy (ClaimsCreatedLast3YrsInTest), which is certainly inside its period.
const POLICIES = {
  personalAuto: { PA: { n: '1002241712', period: ['2026-06-25', '2026-12-25'] }, MD: { n: '1002241918', period: ['2026-07-08', '2027-01-08'] }, DE: { n: '1002241915', period: ['2026-06-29', '2026-12-29'] } },
  commercialAuto: { MI: { n: '1002241856', period: ['2026-07-02', '2027-07-02'] }, DE: { n: '1002241909', period: ['2026-07-08', '2027-07-08'] }, MD: { n: '1002242318', period: ['2026-07-23', '2027-07-23'] }, NC: { n: '1002241890', period: ['2026-06-01', '2027-06-01'] }, OH: { n: '1002241884', period: ['2026-06-01', '2027-06-01'] }, IA: { n: '1002241637', period: ['2026-06-23', '2027-06-23'] }, PA: { n: '1002241820', inForce: '2026-08-06' } },
  homeowners: { PA: { n: '1002092137', period: ['2026-01-07', '2027-01-07'] }, MI: { n: '1002236067', period: ['2026-02-19', '2027-02-19'] }, GA: { n: '1002134160', period: ['2026-03-01', '2027-03-01'] } },
  workersComp: { PA: { n: '1002241612', period: ['2026-04-28', '2027-04-28'] }, MI: { n: '1002241626', period: ['2026-01-01', '2027-01-01'] }, DE: { n: '1002239674', period: ['2026-03-27', '2027-03-27'] } },
  commercialPackage: { PA: { n: '1002241746', inForce: '2026-08-06' } },
  farmowners: { VA: { n: 'FOS-7234742', period: ['2025-11-17', '2026-11-17'] } },
  personalExcess: { VA: { n: '1002236400', inForce: '2026-07-17' }, MI: { n: '1002227909', inForce: '2026-07-05' } },
};
const KIND_LABEL = { personalAuto: 'Personal Auto', commercialAuto: 'Commercial Auto', homeowners: 'Homeowners', workersComp: "Workers' Comp", commercialPackage: 'Commercial Package (property + general liability)', farmowners: 'Farmowners', personalExcess: 'Personal Excess Liability (umbrella)' };
const DEFAULT_STATE = { personalAuto: 'PA', commercialAuto: 'MI', homeowners: 'PA', workersComp: 'PA', commercialPackage: 'PA', farmowners: 'VA', personalExcess: 'VA' };
const NEW_LOSS = '2026-11-10';

const BUSINESS_RE = /\b(INC|LLC|L\.L\.C|CORP|CORPORATION|CO|COMPANY|LTD|LP|LLP|BUILDERS|CONSTRUCTION|SERVICES?|ENTERPRISES|GROUP|TRUCKING|TRANSPORT|FARMS?|CHURCH|SCHOOL|ASSOC|ASSOCIATION|DISTRICT|TOWNSHIP|BOROUGH|COUNTY|AUTHORITY|DEPT|LANDSCAPING|CONTRACTING|EXCAVATING|PLUMBING|ELECTRIC|PIZZA|RESTAURANT|LIGHTING|CLINIC|RECYCLING|SYSTEMS?)\b/i; // "&" alone is a couple, not a business
const tag = (xml, t) => (xml.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1];
const insuredName = (xml) => { const b = (xml.match(/<Insured>[\s\S]*?<\/Name>/) || [''])[0]; return [tag(b, 'First'), tag(b, 'Last')].filter(Boolean).join(' ').trim(); };

// The kind of TEST policy this file needs, from its own schema, policy type and insured.
function kindOf(xml) {
  const root = (xml.match(/<\?xml[^>]*>\s*<([A-Za-z]+)/) || [])[1] || '';
  const type = String(tag(xml, 'PolicyType') || '').trim().toUpperCase();
  const business = BUSINESS_RE.test(insuredName(xml)) && !tag((xml.match(/<Insured>[\s\S]*?<\/Name>/) || [''])[0], 'First');
  if (root === 'WCClaims' || type === 'WORK') return 'workersComp';
  if (root === 'PropertyClaims') return type === 'FARMOWNERS' ? 'farmowners' : type === 'COMMERCIAL' ? 'commercialPackage' : 'homeowners';
  if (root === 'GLClaims') return type === 'PXL' ? 'personalExcess' : type === 'CGL' ? 'commercialPackage' : /AUTO/.test(type) ? 'personalAuto' : 'commercialPackage';
  if (root === 'AutoClaims' || root === 'GlassClaims') return type === 'COMMERCIAL' || (type !== 'PERSONAL' && type !== 'AUTOP' && business) ? 'commercialAuto' : 'personalAuto';
  return null;
}
const lossStateOf = (xml) => tag((xml.match(/<(Accident|Damage|Injury|Loss|Incident)>[\s\S]*?<\/\1>/) || [''])[0], 'State') || tag((xml.match(/<Insured>[\s\S]*?<\/Insured>/) || [''])[0], 'State') || tag(xml, 'State');

const LOSS_TAGS = ['DateOfInjury', 'DateofLoss', 'DateOfLoss', 'Date'];
const KEEP_TAGS = ['DOB', 'DateOfBirth', 'BirthDate', 'DateOfHire', 'HireDate'];
const DAY = 864e5;
const ymd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayDiff = (a, b) => Math.round((Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / DAY);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function parse(s) {
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return { d: new Date(+m[3], +m[1] - 1, +m[2]), padded: m[1].length === 2 && m[2].length === 2, fmt: 'mdy' };
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return { d: new Date(+m[1], +m[2] - 1, +m[3]), fmt: 'iso' };
  return null;
}
const fmt = (d, x) => (x.fmt === 'iso' ? iso(d) : x.padded ? `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}` : `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`);

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const sourceOf = (f) => path.basename(f).replace(/[_-]?\d+(-\d+)?\.xml$/i, '') || 'GlassClaim (numbered file)';

// Up to PER_SOURCE files per source: success first, newest first; for AutoClaim, a mix of commercial and personal.
const all = walk(SRC).filter((f) => /\.xml$/i.test(f));
const bySource = {};
for (const f of all) (bySource[sourceOf(f)] = bySource[sourceOf(f)] || []).push(f);
const rank = (f) => (/\\success\\/i.test(f) ? 0 : /\\error\\/i.test(f) ? 1 : 2);
const picks = [];
for (const [src, files] of Object.entries(bySource)) {
  files.sort((a, b) => rank(a) - rank(b) || b.localeCompare(a));
  const withKind = files.map((f) => ({ f, xml: fs.readFileSync(f, 'utf8') })).map((x) => ({ ...x, kind: kindOf(x.xml) }));
  const kinds = [...new Set(withKind.map((x) => x.kind))];
  const chosen = [];
  for (let i = 0; chosen.length < PER_SOURCE && i < withKind.length * kinds.length; i++) {
    const k = kinds[i % kinds.length];
    // A different insured than the files already picked, when the source has one (Alliance invoices repeat one insured).
    const next = withKind.find((x) => x.kind === k && !chosen.includes(x) && !chosen.some((c) => insuredName(c.xml) === insuredName(x.xml)))
      || withKind.find((x) => x.kind === k && !chosen.includes(x));
    if (next) chosen.push(next);
    if (!withKind.some((x) => !chosen.includes(x))) break;
  }
  picks.push(...chosen.map((x) => ({ ...x, src, available: files.length })));
}

fs.rmSync(OUT, { recursive: true, force: true });
const log = [];
for (const p of picks) {
  const rel = path.relative(SRC, p.f);
  const name = `${rel.split(path.sep)[0] === path.basename(p.f) ? 'root' : rel.split(path.sep)[0]}__${path.basename(p.f)}`;
  const srcDir = p.src.replace(/[^A-Za-z0-9_ ()-]/g, '');
  for (const sub of ['original', 'test-ready']) fs.mkdirSync(path.join(OUT, sub, srcDir), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'original', srcDir, name), p.xml);
  const changes = [];
  const entry = { source: p.src, file: name, from: p.f, kind: p.kind ? KIND_LABEL[p.kind] : '(unknown)', changes };
  log.push(entry);
  if (!p.kind) { changes.push({ field: '-', from: '', to: '', note: 'NOT changed: could not tell which kind of policy this file needs' }); continue; }
  const lossState = lossStateOf(p.xml);
  const set = POLICIES[p.kind];
  const st = set[lossState] ? lossState : DEFAULT_STATE[p.kind];
  const pol = set[st];
  const lossTarget = ymd(pol.period ? NEW_LOSS : pol.inForce);
  const eff = pol.period ? ymd(pol.period[0]) : null;
  const exp = pol.period ? ymd(pol.period[1]) : null;
  let out = p.xml;
  // Insured's policy (the first <PolicyNumber>, inside <Insurance>); another party's insurer policy is left alone.
  const oldPolicy = tag(out, 'PolicyNumber');
  out = out.replace(`<PolicyNumber>${oldPolicy}</PolicyNumber>`, `<PolicyNumber>${pol.n}</PolicyNumber>`);
  changes.push({ field: 'PolicyNumber', from: oldPolicy, to: pol.n, note: `TEST ${KIND_LABEL[p.kind]} policy, ${st}${st !== lossState ? ` (no TEST ${KIND_LABEL[p.kind]} policy in ${lossState || 'the loss state'})` : ''}; ${pol.period ? `period ${pol.period[0]} to ${pol.period[1]}` : `in force on ${pol.inForce} (a TEST claim's loss date on this policy)`}` });
  const extraPolicies = (p.xml.match(/<PolicyNumber>/g) || []).length - 1;
  if (extraPolicies > 0) changes.push({ field: 'PolicyNumber (other party)', from: '', to: '', note: `NOT changed: ${extraPolicies} more policy number(s) in the file belong to another party's insurer` });
  // Dates.
  const dates = [...p.xml.matchAll(/<([A-Za-z]+)>(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})<\/\1>/g)].map((m) => ({ tag: m[1], raw: m[2], ...parse(m[2]) })).filter((x) => x.d);
  const lossEntry = LOSS_TAGS.map((t) => dates.find((x) => x.tag === t)).find(Boolean);
  const shift = lossEntry ? dayDiff(lossTarget, lossEntry.d) : 0;
  for (const x of dates) {
    if (KEEP_TAGS.includes(x.tag)) { changes.push({ field: x.tag, from: x.raw, to: x.raw, note: 'NOT changed: a personal date (birth / hire), not a claim date' }); continue; }
    let nd = addDays(x.d, shift);
    let note = x === lossEntry ? 'loss date' : `moved ${shift} days (same distance from the loss date as before)`;
    if (x !== lossEntry && x.d < lossEntry.d && /Taken|Notice|Notified|Reported/i.test(x.tag)) { nd = addDays(lossTarget, 1); note = 'was before the loss date in the source file; set to the day after the loss'; }
    if (nd > TODAY) { nd = addDays(TODAY, -1); note += '; capped at yesterday (not in the future)'; }
    if (eff && nd < eff) { nd = new Date(eff); note += `; clamped to the policy effective date ${pol.period[0]}`; }
    if (exp && nd >= exp) { nd = addDays(exp, -1); note += `; clamped inside the policy expiration ${pol.period[1]}`; }
    const nv = fmt(nd, x);
    out = out.replace(`<${x.tag}>${x.raw}</${x.tag}>`, `<${x.tag}>${nv}</${x.tag}>`);
    changes.push({ field: x.tag, from: x.raw, to: nv, note });
  }
  if (!lossEntry) changes.push({ field: '-', from: '', to: '', note: 'No loss date found in this file' });
  fs.writeFileSync(path.join(OUT, 'test-ready', srcDir, name), out);
  Object.assign(entry, { insured: insuredName(p.xml), lossState, policyType: tag(p.xml, 'PolicyType') || '' });
}

fs.writeFileSync(path.join(OUT, 'changes.json'), JSON.stringify(log, null, 2));
const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
const csv = ['Source system,File,Policy type in file,Insured,Loss state,TEST policy kind,Field,Original value,New value,Note',
  ...log.flatMap((l) => l.changes.map((c) => [l.source, l.file, l.policyType, l.insured, l.lossState, l.kind, c.field, c.from, c.to, c.note].map(q).join(',')))];
fs.writeFileSync(path.join(OUT, 'changes.csv'), csv.join('\r\n'));
const summary = {};
for (const l of log) { const s = summary[l.source] = summary[l.source] || { files: 0, kinds: {} }; s.files++; s.kinds[l.kind] = (s.kinds[l.kind] || 0) + 1; }
for (const [s, v] of Object.entries(summary)) console.log(`${s}: ${v.files} file(s) of ${bySource[s].length} — ${Object.entries(v.kinds).map(([k, n]) => `${n} ${k}`).join(', ')}`);
console.log(`\n${log.length} files -> ${OUT}`);
