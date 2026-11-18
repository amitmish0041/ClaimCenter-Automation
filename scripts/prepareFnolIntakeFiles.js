/**
 * scripts/prepareFnolIntakeFiles.js
 * Copies external-system FNOL intake files (\\dmi-win-cc9xq1\ClaimCenterData\FNOLIntake) to the V: drive and makes them
 * usable in TEST: the policy number becomes a TEST policy of the same kind, and every date is moved inside that policy's
 * period. Originals are kept next to the edited copies; a change log (JSON + CSV) lists every edit for review.
 * Nothing is written back to the source share.
 *
 *   node scripts/prepareFnolIntakeFiles.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = '\\\\dmi-win-cc9xq1\\ClaimCenterData\\FNOLIntake';
const OUT = 'V:\\Amit Int\\FNOLIntake-Test\\20261117';
const TODAY = new Date(2026, 10, 17);
const LOSS = new Date(2026, 10, 10); // new date of loss: inside every chosen policy's period, a week before today

// One file per source system, with the TEST policy (from this week's TEST claims' payloads) and its period.
const PLAN = [
  { file: 'success\\20250117\\WEBAGENT_AUTO_35961.xml', policy: '1002241856', kind: 'Commercial Auto (MI)', eff: '2026-07-02', exp: '2027-07-02', fromClaim: 'CA-MI-70-26-0747963' },
  { file: 'success\\20250117\\MOBILEAPP_AUTO_45535.xml', policy: '1002241712', kind: 'Personal Auto (PA)', eff: '2026-06-25', exp: '2026-12-25', fromClaim: 'PA-PA-01-26-0748055' },
  { file: 'success\\20250117\\WEBAGENT_PROPERTY_45621.xml', policy: '1002236067', kind: 'Homeowners (MI)', eff: '2026-02-19', exp: '2027-02-19', fromClaim: 'HO-MI-70-26-0748010' },
  { file: 'success\\20230703\\WEBAGENT_WC_328363.xml', policy: '1002241612', kind: 'Workers Comp (PA)', eff: '2026-04-28', exp: '2027-04-28', fromClaim: 'WC-PA-01-26-0748037' },
  { file: 'success\\20230523\\APPLIED_GL_288750.xml', policy: '1002241527', kind: 'Businessowners (DE) - has general liability', eff: '2026-06-20', exp: '2027-06-20', fromClaim: 'BOP-DE-01-26-0747995' },
  { file: 'success\\20240612\\PropertyClaim_230487454.xml', policy: '1002241527', kind: 'Businessowners (DE) - commercial property', eff: '2026-06-20', exp: '2027-06-20', fromClaim: 'BOP-DE-01-26-0747995' },
];

// Which date is the loss date in each file's schema; every other date keeps its distance from the loss date.
const LOSS_TAGS = ['Date', 'DateofLoss', 'DateOfLoss', 'DateOfInjury'];
const p2 = (n) => String(n).padStart(2, '0');
const parse = (s) => {
  let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return { d: new Date(+m[3], +m[1] - 1, +m[2]), fmt: 'mdy' };
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return { d: new Date(+m[1], +m[2] - 1, +m[3]), fmt: 'iso' };
  return null;
};
const fmt = (d, f) => (f === 'iso' ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : `${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${d.getFullYear()}`);
const DAY = 864e5;
// Calendar-day arithmetic (a plain ms shift crosses the November DST change and lands a day early).
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayDiff = (a, b) => Math.round((Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / DAY);
// Personal history dates are not claim dates: an employee's birth or hire date stays as it is.
const KEEP_TAGS = ['DOB', 'DateOfBirth', 'BirthDate', 'DateOfHire', 'HireDate'];

fs.mkdirSync(path.join(OUT, 'original'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'test-ready'), { recursive: true });
const log = [];
for (const p of PLAN) {
  const name = path.basename(p.file);
  const xml = fs.readFileSync(path.join(SRC, p.file), 'utf8');
  fs.writeFileSync(path.join(OUT, 'original', name), xml);
  const eff = new Date(`${p.eff}T00:00:00`);
  const exp = new Date(`${p.exp}T00:00:00`);
  const changes = [];
  // Dates: every <Tag>date</Tag>.
  const dates = [...xml.matchAll(/<([A-Za-z]+)>(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})<\/\1>/g)].map((m) => ({ tag: m[1], raw: m[2], ...parse(m[2]) }));
  const lossEntry = dates.find((x) => LOSS_TAGS.includes(x.tag));
  const shift = lossEntry ? dayDiff(LOSS, lossEntry.d) : 0;
  let out = xml;
  for (const x of dates) {
    if (KEEP_TAGS.includes(x.tag)) { changes.push({ field: x.tag, from: x.raw, to: x.raw, note: 'NOT changed: a personal date (birth / hire), not a claim date' }); continue; }
    let nd = addDays(x.d, shift);
    let note = `moved ${shift} days (same distance from the loss date as before)`;
    if (x.tag === 'DateTaken' && x.d < lossEntry.d) { nd = addDays(LOSS, 1); note = 'was before the loss date in the source file; set to the day after the loss'; }
    if (nd > TODAY) { nd = addDays(TODAY, -1); note += '; capped at yesterday (not in the future)'; }
    if (nd < eff) { nd = new Date(eff); note += `; clamped to the policy effective date ${p.eff}`; }
    if (nd >= exp) { nd = addDays(exp, -1); note += `; clamped inside the policy expiration ${p.exp}`; }
    const nv = fmt(nd, x.fmt);
    out = out.replace(`<${x.tag}>${x.raw}</${x.tag}>`, `<${x.tag}>${nv}</${x.tag}>`);
    changes.push({ field: x.tag, from: x.raw, to: nv, note });
  }
  // Policy number.
  const oldPolicy = (out.match(/<PolicyNumber>([^<]+)<\/PolicyNumber>/) || [])[1];
  out = out.replace(`<PolicyNumber>${oldPolicy}</PolicyNumber>`, `<PolicyNumber>${p.policy}</PolicyNumber>`);
  changes.unshift({ field: 'PolicyNumber', from: oldPolicy, to: p.policy, note: `TEST ${p.kind} policy, period ${p.eff} to ${p.exp} (from TEST claim ${p.fromClaim})` });
  fs.writeFileSync(path.join(OUT, 'test-ready', name), out);
  log.push({ file: name, source: path.join(SRC, p.file), policyKind: p.kind, changes });
}
fs.writeFileSync(path.join(OUT, 'changes.json'), JSON.stringify(log, null, 2));
const csv = ['File,Field,Original value,New value,Note', ...log.flatMap((l) => l.changes.map((c) => [l.file, c.field, c.from, c.to, c.note].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')))];
fs.writeFileSync(path.join(OUT, 'changes.csv'), csv.join('\r\n'));
for (const l of log) {
  console.log(`\n${l.file}  (${l.policyKind})`);
  for (const c of l.changes) console.log(`  ${c.field}: ${c.from} -> ${c.to}   ${c.note}`);
}
