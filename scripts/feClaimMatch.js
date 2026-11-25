#!/usr/bin/env node
/**
 * scripts/feClaimMatch.js — OFFLINE: matches scouted claim profiles (results/fe-scout/profiles.json, from
 * scripts/feClaimScout.js) to the CC Cloud FE test cases — Commercial Auto, all 20 KMS-tagged states (scope set 2026-11-25).
 *
 *   node scripts/feClaimMatch.js [--workbook "<CC_Cloud_FE_Test_Cases_CommercialAuto_PA_MD.xlsx>"] [--per 3]
 *
 * Row-driven: each Test Cases row's base id (FE-SS-004 from FE-SS-004-PA) picks a rule; its State column (PA / MD /
 * PA/MD) filters claims by the claim number's state segment. Fills "Existing claim(s)" and rewrites the sheets
 * "Existing Claims" and "Claim Profiles". SmartCOMM letters (DIG### …) don't count as source documents.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i < 0) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const WB = arg('workbook', 'C:\\Users\\amitmish\\Desktop\\CC Cloud - FE\\Test Plan\\CC_Cloud_FE_Test_Cases_CommercialAuto_AllStates.xlsx');
const PER = Number(arg('per', 3));
const all = Object.values(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'results', 'fe-scout', 'profiles.json'), 'utf8')));

const RX = {
  police: /police|crash report|accident report|incident report|\bmsp\b|ud-?10|aa-?600|trooper/i,
  damage: /estimate|apprais|damage|repair|photo|supplement|total loss|ccc|mitchell|salvage/i,
  medical: /medical|hospital|physician|doctor|clinic|therap|rehab|hcfa|ub-?0?4|\bime\b|records|chiro|surgery|mri|x-?ray|pharm|diagnos/i,
  attorney: /attorney|legal|counsel|letter of rep|\blor\b|summons|complaint|suit|demand|subpoena|deposition|court/i,
};
const toDate = (s) => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || ''); return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null; };
const days = (a, b) => (a && b ? Math.round((a - b) / 864e5) : null);

const P = all.filter((p) => !p.error && (/commercial auto/i.test((p.policyInfo || {}).type || '') || /^(CA|CAA|CAS)-/.test(p.claim))).map((p) => {
  const real = (p.docs || []).filter((d) => !/^DIG\d+/i.test(d.desc));
  const has = (k) => real.filter((d) => RX[k].test(`${d.desc} ${d.type}`)).length;
  const loss = toDate(p.lossDate); const eff = toDate((p.policyInfo || {}).effective); const exp = toDate((p.policyInfo || {}).expiration);
  const subs = (p.policyInfo || {}).subScreens || [];
  const exps = p.exposures || [];
  return {
    ...p, state: p.claim.split('-')[1], open: /open/i.test(p.status || ''),
    realDocs: real.length, smartcommDocs: (p.docs || []).length - real.length,
    police: has('police'), damage: has('damage'), medical: has('medical') + exps.filter((e) => /medical|pip|first party|bodily|injury/i.test(e)).length,
    um: exps.filter((e) => /uninsured|underinsured|\bum\b|uim|first party|pip|medical/i.test(e)).length,
    bi: exps.filter((e) => /bodily|injury/i.test(e)).length,
    attorney: has('attorney'), litigation: p.matters && p.matters.count !== 0 ? 1 : 0,
    notesN: p.notes || 0, exposuresN: exps.length, vehicleExps: exps.filter((e) => /vehicle/i.test(e)).length,
    sinceEff: days(loss, eff), toExp: days(exp, loss), cancelled: Boolean((p.policyInfo || {}).cancellation),
    vehicles: subs.includes('Vehicles'), endorsements: subs.includes('Endorsements'),
  };
});
const denied = all.filter((p) => p.error && /permission/i.test(p.error));
const rich = (c) => c.realDocs * 2 + c.notesN + c.exposuresN * 3;
const near = (c) => Math.min(Math.abs(c.toExp ?? 999), Math.abs(c.sinceEff ?? 999));
const T = (f, s, why) => ({ f, s, why });
const any = T((c) => c.open, rich, (c) => `open; ${c.realDocs} docs, ${c.notesN} notes`);
const forms = T((c) => c.endorsements, rich, () => 'policy carries endorsements: confirm this form is on it (Policy > Endorsements)');

const R = {
  'FE-SS-001': T((c) => c.open, (c) => c.police * 10 + rich(c), (c) => (c.police ? `${c.police} police doc(s) already` : 'open claim to upload a police report')),
  'FE-SS-002': T((c) => c.open && c.realDocs >= 3, rich, (c) => `${c.realDocs} ImageRight docs (check one is scanned)`),
  'FE-SS-003': any,
  'FE-SS-004': T((c) => c.notesN >= 5 && c.realDocs >= 3, rich, (c) => `${c.notesN} notes, ${c.realDocs} docs, ${c.exposuresN} exposures`),
  'FE-SS-005': T((c) => c.notesN >= 5 && c.realDocs >= 3, rich, (c) => `${c.notesN} notes, ${c.realDocs} docs, ${c.exposuresN} exposures`),
  'FE-SS-006': T((c) => c.vehicleExps >= 2 || c.exposuresN >= 3, (c) => c.vehicleExps * 5 + c.exposuresN, (c) => `${c.vehicleExps} vehicle / ${c.exposuresN} exposures`),
  'FE-SS-007': T((c) => c.notesN >= 2, rich, (c) => `${c.notesN} notes`),
  'FE-SS-008': T((c) => c.police, (c) => c.police * 10 + rich(c), (c) => `${c.police} police doc(s)`),
  'FE-SS-009': T((c) => c.damage, (c) => c.damage * 10 + rich(c), (c) => `${c.damage} damage/estimate doc(s)`),
  'FE-SS-010': T((c) => c.medical, (c) => c.medical * 10 + rich(c), (c) => `${c.medical} medical doc(s)/exposure(s)`),
  'FE-SS-011': T((c) => c.attorney || c.litigation, (c) => c.attorney + c.litigation * 10, (c) => `${c.attorney} legal doc(s)${c.litigation ? ', litigation matter' : ''}`),
  'FE-SS-012': T((c) => c.open && c.realDocs >= 1, (c) => -c.realDocs, (c) => `open, ${c.realDocs} doc(s)`),
  'FE-SS-013': T((c) => c.open && c.realDocs >= 1, (c) => -c.realDocs, (c) => `open, ${c.realDocs} doc(s)`),
  'FE-SS-014': T((c) => c.open && c.realDocs >= 2, rich, () => 'open claim with docs'),
  'FE-SS-015': T((c) => c.realDocs >= 2 && c.notesN >= 2, rich, (c) => `${c.realDocs} docs, ${c.notesN} notes`),
  'FE-SS-016': T((c) => c.notesN >= 3 && (c.police || c.realDocs >= 3), rich, (c) => `${c.notesN} notes + docs (add a conflicting note)`),
  'FE-SS-017': T((c) => c.realDocs + c.notesN >= 60, (c) => c.realDocs + c.notesN, (c) => `${c.realDocs} docs + ${c.notesN} notes`),
  'FE-SS-018': T((c) => c.open && c.realDocs === 0 && c.notesN === 0, () => 0, () => 'no docs, no notes'),
  'FE-CV-001': T((c) => c.vehicles, rich, () => 'CA policy (symbols)'),
  'FE-CV-002': T((c) => c.vehicles, rich, () => 'CA policy with Vehicles (check fleet size)'),
  'FE-CV-003': T((c) => c.endorsements, rich, () => 'policy has endorsements'),
  'FE-CV-004': T((c) => c.endorsements, rich, () => 'policy forms list'),
  'FE-CV-022': T((c) => near(c) <= 45, (c) => -near(c), (c) => `loss ${c.sinceEff}d after effective / ${c.toExp}d before expiration`),
  'FE-CV-023': T((c) => c.exposuresN >= 1, rich, (c) => `${c.exposuresN} exposure(s)`),
  'FE-CV-024': T((c) => c.exposuresN >= 1, rich, () => 'check the loss fits an exclusion scenario'),
  'FE-CV-025': T((c) => c.exposuresN >= 1, rich, () => 'covered example; pair with an excluded one'),
  'FE-CV-026': T((c) => c.cancelled || (c.sinceEff != null && c.sinceEff >= 0 && c.sinceEff <= 30), (c) => (c.cancelled ? 100 : 0) - (c.sinceEff ?? 99), (c) => (c.cancelled ? 'policy has a cancellation date' : `loss ${c.sinceEff}d after inception`)),
  'FE-RC-001': any,
  'FE-RC-002': T((c) => !['PA', 'MD'].includes(c.state), rich, (c) => `loss state ${c.state} (out of scope)`),
  'FE-RC-004': T(() => true, rich, () => 'check policy state vs loss state on Loss Details'),
  'FE-RC-005': any,
  'FE-RC-006': T((c) => c.bi || c.exposuresN, (c) => c.bi * 10 + rich(c), (c) => `${c.bi} BI exposure(s)`),
  'FE-RC-007': T((c) => c.damage || c.vehicleExps, (c) => c.damage * 5 + c.vehicleExps, () => 'physical damage claim'),
  'FE-RC-008': T((c) => c.um, (c) => c.um * 10 + rich(c), (c) => `${c.um} UM/UIM/first-party exposure(s)`),
  'FE-RC-009': any, 'FE-RC-010': any, 'FE-RC-011': any,
  'FE-RC-015': any, 'FE-RC-016': any, 'FE-RC-017': any, 'FE-RC-018': any, 'FE-RC-020': any, 'FE-RC-021': any, 'FE-RC-022': any,
  'FE-RC-019': T((c) => c.um || c.exposuresN, (c) => c.um * 10 + rich(c), () => 'NC claim (UM/UIM selection)'),
  'FE-CV-028': T((c) => c.endorsements, rich, () => 'check the policy has Silver Series Plus'),
  'FE-RG-002': T((c) => /^(CAA|CAS)-/.test(c.claim) || +c.claim.split('-')[3] < 20, rich, () => 'migrated CA claim'),
};
for (let i = 5; i <= 21; i++) R[`FE-CV-${String(i).padStart(3, '0')}`] = forms;
const NOTE = {
  'FE-RC-003': 'Use a PA personal auto or WC claim (not CA).', 'FE-RC-012': 'No claim needed.', 'FE-RC-013': 'KB admin: no claim needed.',
  'FE-RC-014': 'Not delivered.', 'FE-CV-027': 'Not delivered.', 'FE-IF-001': 'NEW CA Voice FNOL claim required.', 'FE-IF-002': 'NEW CA Voice FNOL claim required.',
  'FE-RG-001': 'CA E2E suite builds its own claims.', 'FE-RG-003': 'Existing SmartCOMM / OneInc sweeps.',
};
// States beyond PA/MD are only used where a rule asks for them (out-of-scope case, migrated claims).
const ANY_STATE = new Set(['FE-RC-002', 'FE-RG-002', 'FE-SS-017']);

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WB);
  for (const n of ['Existing Claims', 'Claim Profiles']) { const s = wb.getWorksheet(n); if (s) wb.removeWorksheet(s.id); }
  const tcs = wb.getWorksheet('Test Cases');
  let col = 0; tcs.getRow(1).eachCell((c, i) => { if (c.value === 'Existing claim(s)') col = i; });
  const ex = wb.addWorksheet('Existing Claims');
  ex.columns = [{ header: 'TC ID', width: 15 }, { header: 'State', width: 7 }, { header: 'Claim #', width: 24 }, { header: 'Status', width: 9 }, { header: 'Loss date', width: 11 }, { header: 'Why it fits', width: 64 }];
  const used = new Map(); const gaps = [];
  tcs.eachRow((row, i) => {
    if (i === 1) return;
    const id = String(row.getCell(1).value); const base = id.replace(/-[A-Z]{2}$/, ''); const st = String(row.getCell(6).value || ''); const rot = /rotating/.test(st); const code = st.slice(0, 2);
    const r = R[base];
    if (!r) { row.getCell(col).value = NOTE[base] || ''; if (NOTE[base]) ex.addRow([id, st, '', '', '', NOTE[base]]); return; }
    const states = ANY_STATE.has(base) ? null : [code];
    let list = P.filter((c) => (!states || states.includes(c.state)) && r.f(c)).sort((a, b) => r.s(b) - r.s(a)).slice(0, PER);
    // Rotating rows (state-neutral cases) fall back to any state when the rotated state has no fit.
    if (!list.length && rot) list = P.filter((c) => r.f(c)).sort((a, b) => r.s(b) - r.s(a)).slice(0, PER);
    if (!list.length) { gaps.push(id); row.getCell(col).value = 'none found: create / upload'; ex.addRow([id, st, '', '', '', 'NO EXISTING CLAIM FOUND: create one or upload documents']); return; }
    row.getCell(col).value = list.map((c) => c.claim).join('\n');
    for (const c of list) { ex.addRow([id, c.state, c.claim, c.status, c.lossDate, r.why(c)]); used.set(c.claim, (used.get(c.claim) || 0) + 1); }
    if (base === 'FE-SS-014') for (const d of denied.slice(0, 3)) ex.addRow([id, d.claim.split('-')[1], d.claim, '', '', 'restricted for the scout user: use for the no-access check']);
    row.getCell(col).alignment = { wrapText: true, vertical: 'top' };
  });
  ex.getRow(1).font = { bold: true }; ex.views = [{ state: 'frozen', ySplit: 1 }]; ex.autoFilter = 'A1:F1';

  const pr = wb.addWorksheet('Claim Profiles');
  pr.columns = ['Claim #', 'State', 'Status', 'Loss date', 'Policy #', 'Policy eff', 'Policy exp', 'Cancelled', 'Real docs', 'SmartCOMM docs', 'Notes', 'Exposures', 'Vehicle exp', 'BI', 'UM/1st party', 'Police', 'Damage', 'Medical', 'Legal', 'Litigation', 'Used by # cases'].map((h) => ({ header: h, width: h === 'Claim #' ? 24 : 10 }));
  for (const c of P.sort((a, b) => a.state.localeCompare(b.state) || rich(b) - rich(a))) {
    const pi = c.policyInfo || {};
    pr.addRow([c.claim, c.state, c.status, c.lossDate, pi.number || c.policy, pi.effective, pi.expiration, c.cancelled ? 'Y' : '', c.realDocs, c.smartcommDocs, c.notesN, c.exposuresN, c.vehicleExps, c.bi, c.um, c.police, c.damage, c.medical, c.attorney, c.litigation ? 'Y' : '', used.get(c.claim) || 0]);
  }
  pr.getRow(1).font = { bold: true }; pr.views = [{ state: 'frozen', ySplit: 1 }]; pr.autoFilter = 'A1:U1';
  await wb.xlsx.writeFile(WB);
  const byState = P.reduce((m, c) => ((m[c.state] = (m[c.state] || 0) + 1), m), {});
  console.log(`[FE match] CA claims profiled: ${P.length} ${JSON.stringify(byState)}; restricted: ${denied.length}; rows without a claim: ${gaps.length}`);
  if (gaps.length) console.log(gaps.join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
