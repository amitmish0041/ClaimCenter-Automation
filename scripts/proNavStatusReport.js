#!/usr/bin/env node
/**
 * scripts/proNavStatusReport.js — consolidated ProNavigator (CC Cloud FE, Commercial Auto) status report across states:
 * reads every Test Results\ProNav-<date>\<set>\verdicts.json (written by scripts/proNavResultDocs.js) and writes
 * "ProNav Status Report - <date>.docx" next to them: overall totals, per-state table, scenario coverage matrix
 * (state x scenario), findings (FAIL / REVIEW with QA notes) and open items.
 *
 *   node scripts/proNavStatusReport.js [--date 2026-11-25]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const D = require('docx');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const date = arg('date', new Date().toISOString().slice(0, 10));
const DIR = path.join('C:/Users/amitmish/Desktop/CC Cloud - FE/Test Plan/Test Results', `ProNav-${date}`);
const runs = fs.readdirSync(DIR).filter((d) => fs.existsSync(path.join(DIR, d, 'verdicts.json'))).map((d) => JSON.parse(fs.readFileSync(path.join(DIR, d, 'verdicts.json'), 'utf8')));

const TIER1 = ['Pennsylvania', 'Maryland', 'Virginia', 'Delaware', 'North Carolina'];
const ORDER = ['Pennsylvania', 'Maryland', 'Virginia', 'Delaware', 'North Carolina', 'Ohio', 'Indiana', 'Illinois', 'Iowa', 'Michigan', 'Wisconsin', 'Tennessee', 'South Carolina', 'South Dakota', 'Nebraska', 'Texas', 'Utah', 'New Mexico', 'Colorado', 'Arizona'];
// Scenario categories by question id suffix (generic sets) / PA original set ids.
const CAT = (id) => {
  if (/^POL-/.test(id)) return 'Policy wordings';
  const k = id.split('-')[1];
  return ({ '01': 'Acknowledgement deadline', '02': 'Accept/deny deadline', '03': 'UM / UIM', '04': 'Total loss / physical damage', '05': 'Fraud reporting',
    '13': 'UM / UIM', '14': 'Total loss / physical damage', '15': 'Fraud reporting', N1: 'Negative: other-state question', N2: 'Negative: non-existent section' })[k]
    || 'State-specific KMS document';
};
const PA_CAT = { 'PA-01': 'Acknowledgement deadline', 'PA-02': 'Accept/deny deadline', 'PA-03': 'Denial content', 'PA-04': 'Suit limitation', 'PA-05': 'Total loss / physical damage',
  'PA-06': 'Total loss / physical damage', 'PA-07': 'Total loss / physical damage', 'PA-08': 'UM / UIM', 'PA-09': 'First-party benefits', 'PA-10': 'State-specific KMS document' };
const catOf = (set, id) => (set === 'PA' && PA_CAT[id]) || CAT(id);

// Merge sets per state (PA + PA5 re-ask; POLICY is reported separately). Latest verdict per question id wins.
const byState = {};
for (const r of runs.sort((a, b) => a.at.localeCompare(b.at))) {
  const st = r.set === 'POLICY' ? 'Policy wordings (all states)' : r.state;
  const s = byState[st] = byState[st] || { state: st, claims: new Set(), modes: new Set(), items: {} };
  s.claims.add(r.claim); s.modes.add(r.mode.startsWith('manual') ? 'manual filter' : 'claim context');
  for (const it of r.items) s.items[it.id] = { ...it, cat: catOf(r.set, it.id) };
}
const states = Object.values(byState).sort((a, b) => (ORDER.indexOf(a.state) + 1 || 99) - (ORDER.indexOf(b.state) + 1 || 99));
const count = (items, v) => items.filter((i) => i.verdict === v).length;
const all = states.flatMap((s) => Object.values(s.items));
const cats = [...new Set(all.map((i) => i.cat))];

const color = { PASS: '1E7B34', FAIL: 'B00020', REVIEW: 'B26A00' };
const P = (t, o = {}) => new D.Paragraph({ children: [new D.TextRun({ text: String(t ?? ''), ...o })], spacing: { after: 80 } });
const H = (t, l = D.HeadingLevel.HEADING_2) => new D.Paragraph({ text: t, heading: l, spacing: { before: 240, after: 120 } });
const cell = (t, o = {}) => new D.TableCell({ children: [P(t, o)], shading: o.fill ? { fill: o.fill } : undefined });
const tbl = (head, rows) => new D.Table({ width: { size: 100, type: D.WidthType.PERCENTAGE }, rows: [
  new D.TableRow({ tableHeader: true, children: head.map((h) => cell(h, { bold: true, fill: 'DCE6F1' })) }),
  ...rows.map((r) => new D.TableRow({ children: r.map((c) => (typeof c === 'object' ? cell(c.t, c) : cell(c))) })),
] });

(async () => {
  const kids = [
    H('ProNavigator Compliance Assistant: Consolidated Status Report', D.HeadingLevel.HEADING_1),
    P(`CC Cloud FE · Commercial Auto · ClaimCenter cloud TEST · run date ${date}`),
    P(`Scope: the ${ORDER.length} states tagged for Commercial Automobile in the ProNav KMS Document QA Sheet (09_01_26), plus the policy-wording documents shared across states.`),
    H('Overall'),
    tbl(['States run', 'Scenarios run', 'PASS', 'REVIEW', 'FAIL'], [[
      String(states.filter((s) => ORDER.includes(s.state)).length) + ` of ${ORDER.length}`, String(all.length),
      { t: String(count(all, 'PASS')), color: color.PASS, bold: true }, { t: String(count(all, 'REVIEW')), color: color.REVIEW, bold: true }, { t: String(count(all, 'FAIL')), color: color.FAIL, bold: true }]]),
    P('Verdicts are suggested by automated checks (correct KMS source cited, expected key points present, state filter applied) plus QA review notes. The Claims/Legal SME confirms each one in the per-scenario result documents.', { italics: true }),
    H('Status by state'),
    tbl(['State', 'Tier', 'Claim used', 'State set by', 'Run', 'PASS', 'REVIEW', 'FAIL'], states.map((s) => {
      const it = Object.values(s.items);
      return [s.state, TIER1.includes(s.state) ? '1: own docs' : ORDER.includes(s.state) ? '2: shared docs' : '-', [...s.claims].join(', '), [...s.modes].join(', '), String(it.length),
        { t: String(count(it, 'PASS')), color: color.PASS }, { t: String(count(it, 'REVIEW')), color: count(it, 'REVIEW') ? color.REVIEW : undefined }, { t: String(count(it, 'FAIL')), color: count(it, 'FAIL') ? color.FAIL : undefined }];
    })),
    H('Scenario coverage (state × scenario)'),
    P('P = pass, R = review, F = fail, blank = not run for that state.'),
    tbl(['State', ...cats], states.map((s) => [s.state, ...cats.map((c) => {
      const v = Object.values(s.items).filter((i) => i.cat === c);
      if (!v.length) return '';
      const w = v.some((i) => i.verdict === 'FAIL') ? 'FAIL' : v.some((i) => i.verdict === 'REVIEW') ? 'REVIEW' : 'PASS';
      return { t: w[0] + (v.length > 1 ? ` (${v.length})` : ''), color: color[w], bold: true };
    })])),
    H('Findings (FAIL and REVIEW)'),
  ];
  const finds = states.flatMap((s) => Object.values(s.items).filter((i) => i.verdict !== 'PASS').map((i) => ({ ...i, state: s.state })));
  const kinds = finds.reduce((m, f) => ((m[f.kind || 'check'] = (m[f.kind || 'check'] || 0) + 1), m), {});
  if (finds.length) kids.push(P(`By type: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(' · ')}`, { bold: true }),
    P('retrieval gap = ProNav says it has no content for the state although the KMS sheet tags a document with that state; truncated = answer cut off with no sources; harness = our capture issue, re-run; check = answered but a key point or citation needs SME review.', { italics: true }));
  kids.push(finds.length ? tbl(['State', 'ID', 'Question', 'Type', 'Verdict', 'Notes'], finds.map((f) => [f.state, f.id, f.q, f.kind || 'check', { t: f.verdict, color: color[f.verdict], bold: true }, f.note || 'See the result document (automated check details).']))
    : P('None.'));
  kids.push(H('Open items'),
    P('• Claims/Legal SME to confirm the expected answers and the suggested verdicts.'),
    P('• States run with a manually set filter had no open Commercial Auto claim in the scout. Re-run them on a real claim once the claim scout finds or creates one, so the claim-context check (FE-RC-001) is covered.'),
    P('• Claim context defect: on CA-OH-04-08-0053508 ProNav set the state to North Carolina, and on CA-IN-04-15-0520105 it left Region blank. In both cases ProNav would not answer ("Select an option from each filter"). OH and IN were re-run on the PA claim with a manual state filter. Check the loss location and policy state on those claims, then raise a defect if they are Ohio and Indiana.'),
    P('• Business decision: should ProNav answer questions about another state while the claim is in a different state?'),
    P('• KMS hygiene for Donegal: duplicate entries, the "ME Example" chart tagged Maryland, and underwriting guides tagged Commercial Automobile.'),
    H('Evidence'),
    P(`One Word result document per scenario (question, expected answer + KMS source, automated checks, QA notes, full answer, screenshot) in the state folders under ${DIR}.`));
  const doc = new D.Document({ styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
    sections: [{ properties: { page: { size: { orientation: D.PageOrientation.LANDSCAPE } } }, children: kids }] });
  const out = path.join(DIR, `ProNav Status Report - ${date}.docx`);
  fs.writeFileSync(out, await D.Packer.toBuffer(doc));
  console.log(`[ProNav report] ${states.length} state groups, ${all.length} scenarios: ${count(all, 'PASS')} PASS / ${count(all, 'REVIEW')} REVIEW / ${count(all, 'FAIL')} FAIL -> ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
