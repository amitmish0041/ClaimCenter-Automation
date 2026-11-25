#!/usr/bin/env node
/**
 * scripts/proNavResultDocs.js — turns a ProNav golden-question run (results/pronav/<set>-<stamp>/answers.json) into
 * one Word test-result document per scenario + a run summary, saved next to the FE test cases
 * (Desktop\CC Cloud - FE\Test Plan\Test Results\ProNav-<set>-<date>\). User direction 2026-11-25.
 *
 *   node scripts/proNavResultDocs.js [<run folder>]   (default: latest results/pronav/* run)
 *
 * Auto checks (suggested verdict only — the SME confirms): the cited source matches the expected KMS document, and the
 * answer contains the expected key points (and none of the forbidden ones for negative cases).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const D = require('docx');
const SETS = require('../helpers/proNav/goldenQuestions');

const ROOT = path.join(__dirname, '..', 'results', 'pronav');
const run = process.argv[2] || path.join(ROOT, fs.readdirSync(ROOT).filter((d) => /^[A-Z]{2}-\d{4}/.test(d)).sort().pop());
const res = JSON.parse(fs.readFileSync(path.join(run, 'answers.json'), 'utf8'));
const set = SETS[res.set];
const QA = fs.existsSync(path.join(run, 'qa-notes.json')) ? JSON.parse(fs.readFileSync(path.join(run, 'qa-notes.json'), 'utf8')) : {};
const DEST = path.join('C:/Users/amitmish/Desktop/CC Cloud - FE/Test Plan/Test Results', `ProNav-${res.at.slice(0, 10)}`, res.set);
fs.mkdirSync(DEST, { recursive: true });

// Golden question -> FE test case ids (CC_Cloud_FE_Test_Cases_CommercialAuto_AllStates.xlsx).
const T1DOC = { MD: 'FE-RC-016-MD', VA: 'FE-RC-017-VA', DE: 'FE-RC-018-DE', NC: 'FE-RC-019-NC' };
const TIER1 = ['PA', 'MD', 'VA', 'DE', 'NC'];
function TC(id, setName) {
  if (setName === 'POLICY') return { 'POL-01': ['FE-CV-028-PA'], 'POL-02': ['FE-CV-028-PA', 'FE-CV-005'], 'POL-03': ['FE-CV-028-PA'], 'POL-04': ['FE-RC-021'] }[id] || [];
  const [st, k] = id.split('-');
  if (setName === 'PA') return ({ '01': ['FE-RC-005-PA'], '02': ['FE-RC-005-PA'], '03': ['FE-RC-009-PA'], '04': ['FE-RC-006-PA'], '05': ['FE-RC-007'], '06': ['FE-RC-007'], '07': ['FE-RC-007'], '08': ['FE-RC-008-PA'], '09': ['FE-RC-008-PA'], '10': ['FE-RC-015-PA'], N1: ['FE-RC-001-PA'], N2: ['FE-RC-012'] }[k] || []).concat(['FE-RC-010-PA']);
  const base = { '01': [`FE-RC-005-${st}`], '02': [`FE-RC-005-${st}`], '03': [`FE-RC-008-${st}`], '04': ['FE-RC-007'], '05': [`FE-RC-005-${st}`],
    '13': [`FE-RC-008-${st}`], '14': ['FE-RC-007'], '15': [`FE-RC-005-${st}`] }[k] || (T1DOC[st] ? [T1DOC[st]] : []);
  if (k === '05' && setName === 'PA5') base.splice(0, 1, 'FE-RC-007');
  return base.concat([`FE-RC-001-${st}`, `FE-RC-010-${st}`], TIER1.includes(st) ? [] : [`FE-RC-020-${st}`]);
}

function check(a) {
  const q = set.questions.find((x) => x.id === a.id) || {};
  const st = res.state || 'Pennsylvania';
  if (a.error || !a.answer) return { verdict: 'REVIEW', kind: 'harness', notes: [`Test harness: no answer captured (${a.error || 'empty'}); re-run this question`] };
  if (/^(Executing your query|Analyzing results)/i.test(a.answer.trim()) || /^ProNavigator\s+Search/i.test(a.answer.trim())) return { verdict: 'REVIEW', kind: 'harness', notes: ['Test harness: answer captured before ProNav finished; re-run this question'] };
  const body = a.answer.split(/\nSources:\n/)[0];
  const srcText = (a.answer.split(/\nSources:\n/)[1] || '') + ' ' + (a.links || []).map((l) => l.text).join(' ');
  const notes = [];
  if (a.filterWarning) return { verdict: 'REVIEW', kind: 'harness', notes: [`Filter: ${a.filterWarning}; re-run`] };
  if (res.state && a.appliedTags && a.appliedTags.length) notes.push(`Filters on the answer: ${a.appliedTags.join(' / ')}`);
  // ProNav says it could not find the state's content although the KMS sheet tags documents with that state.
  if (/retrieved sources don.?t|sources (do not|don.?t) (contain|cover|address|include)|not (included|covered) in the (retrieved|provided)/i.test(body.slice(0, 400)) && q.cite) {
    notes.push(`Retrieval gap: ProNav reports it has no ${st} content for this question, but the KMS sheet tags "${q.source}" with ${st}. Confirm that document has a ${st} section; if so, ProNav did not retrieve it.`);
    return { verdict: 'FAIL', kind: 'retrieval gap', notes };
  }
  if (!/Sources:/.test(a.answer) && q.cite) {
    notes.push('Answer has no "Sources" section' + (body.length < 700 ? ' and looks cut off (truncated generation)' : ''));
    return { verdict: 'FAIL', kind: body.length < 700 ? 'truncated' : 'no citation', notes };
  }
  let ok = true;
  if (q.cite) {
    const hit = q.cite.test(srcText) || new RegExp(st.replace(/\s+/g, '\s*'), 'i').test(srcText);
    notes.push(`Cited source is the expected KMS doc or a ${st} doc: ${hit ? 'YES' : 'NO'} (${srcText.replace(/\s+/g, ' ').replace(/Answers are from.*$/, '').trim().slice(0, 160)})`);
    ok = ok && hit;
  }
  for (const m of q.must || []) { const hit = m.test(body); notes.push(`Key point ${m}: ${hit ? 'found' : 'MISSING'}`); ok = ok && hit; }
  for (const m of q.mustNot || []) { const hit = m.test(body); notes.push(`Must not contain ${m}: ${hit ? 'PRESENT' : 'ok'}`); ok = ok && !hit; }
  return { verdict: ok ? 'PASS' : 'REVIEW', kind: ok ? 'answered' : 'check', notes };
}

const P = (text, o = {}) => new D.Paragraph({ children: [new D.TextRun({ text: String(text ?? ''), ...o })], spacing: { after: 80 } });
const H = (text, level = D.HeadingLevel.HEADING_2) => new D.Paragraph({ text, heading: level, spacing: { before: 200, after: 100 } });
const row = (k, v, bold) => new D.TableRow({ children: [
  new D.TableCell({ width: { size: 2600, type: D.WidthType.DXA }, children: [P(k, { bold: true })] }),
  new D.TableCell({ width: { size: 6800, type: D.WidthType.DXA }, children: [P(v, bold ? { bold: true, color: bold } : {})] }),
] });
const table = (rows) => new D.Table({ width: { size: 9400, type: D.WidthType.DXA }, rows });
const color = (v) => ({ PASS: '1E7B34', FAIL: 'B00020', REVIEW: 'B26A00' }[v]);

async function write(file, children) {
  const doc = new D.Document({ styles: { default: { document: { run: { font: 'Calibri', size: 21 } } } }, sections: [{ children }] });
  fs.writeFileSync(file, await D.Packer.toBuffer(doc));
}

(async () => {
  const summary = [];
  for (const a of res.answers) {
    const c = check(a);
    const qa = QA[a.id];
    if (qa && qa.verdict) c.verdict = qa.verdict;
    const tcs = TC(a.id, res.set);
    summary.push({ id: a.id, tcs, q: a.q, verdict: c.verdict, kind: qa && qa.kind ? qa.kind : c.kind, note: qa ? qa.note : c.notes.filter((n) => /Retrieval gap|truncated|harness|cut off/i.test(n)).join(' ') });
    
    const kids = [
      H(`Test Result ${a.id}: ProNavigator compliance Q&A (${res.set})`, D.HeadingLevel.HEADING_1),
      table([
        row('Test case(s)', tcs.join(', ')),
        row('Area', 'Regulatory Compliance (ProNavigator, Commercial Auto)'),
        row('Environment', 'ClaimCenter cloud TEST, ProNavigator right panel'),
        row('Claim', res.claim),
        row('State', res.state || res.set),
        row('How the state was set', res.mode || 'claim context'),
        row('Context filters shown', (res.contextFilters || []).join(' | ') + (res.filtersAfterSwitch ? ` → ${res.filtersAfterSwitch.join(' | ')}` : '')),
        row('Run date', res.at.replace('T', ' ').slice(0, 16) + ' UTC'),
        row('Suggested verdict', c.verdict, color(c.verdict)),
        row('Final verdict (SME)', '______'),
      ]),
      H('Question asked'), P(a.q),
      H('Expected (from the KMS source)'), P(`Source: ${a.source}`), P(a.expect),
      H('Automated checks'), ...c.notes.map((n) => P(`• ${n}`)),
      ...(qa ? [H('QA analysis'), P(qa.note)] : []),
      H('Actual answer (as shown in ProNavigator)'), ...String(a.answer || a.error || '').split('\n').filter((l) => l.trim()).map((l) => P(l)),
    ];
    const png = path.join(run, `q${a.n}.png`);
    if (fs.existsSync(png)) {
      kids.push(H('Screenshot'));
      kids.push(new D.Paragraph({ children: [new D.ImageRun({ type: 'png', data: fs.readFileSync(png), transformation: { width: 620, height: 383 } })] }));
    }
    kids.push(H('Tester comments'), P('______'));
    await write(path.join(DEST, `${a.id} - ${a.q.replace(/[\\/:*?"<>|]/g, '').slice(0, 70)}.docx`), kids);
  }
  const n = (v) => summary.filter((s) => s.verdict === v).length;
  await write(path.join(DEST, `_Summary - ProNav ${res.set}.docx`), [
    H(`ProNavigator compliance Q&A: ${res.set} run summary`, D.HeadingLevel.HEADING_1),
    P(`Claim ${res.claim} · cloud TEST · ${res.at.slice(0, 16).replace('T', ' ')} UTC · context filters: ${(res.contextFilters || []).join(' | ')}`),
    P(`Suggested: ${n('PASS')} PASS, ${n('REVIEW')} REVIEW, ${n('FAIL')} FAIL of ${summary.length}. Suggested verdicts come from automated source/key-point checks; the SME confirms each.`, { bold: true }),
    new D.Table({ width: { size: 9400, type: D.WidthType.DXA }, rows: [
      new D.TableRow({ tableHeader: true, children: ['ID', 'Test case(s)', 'Question', 'Suggested'].map((h) => new D.TableCell({ children: [P(h, { bold: true })] })) }),
      ...summary.map((s) => new D.TableRow({ children: [
        new D.TableCell({ children: [P(s.id)] }), new D.TableCell({ children: [P(s.tcs.join(', '))] }),
        new D.TableCell({ children: [P(s.q)] }), new D.TableCell({ children: [P(s.verdict, { bold: true, color: color(s.verdict) })] }),
      ] })),
    ] }),
  ]);
  fs.writeFileSync(path.join(DEST, 'verdicts.json'), JSON.stringify({ set: res.set, state: res.state || 'Pennsylvania', claim: res.claim, mode: res.mode || 'claim context', at: res.at, run, items: summary }, null, 1));
  console.log(`[ProNav docs] ${summary.length} result docs + summary -> ${DEST}`);
  console.log(summary.map((s) => `${s.id} ${s.verdict}`).join('\n'));
})().catch((e) => { console.error(e); process.exit(1); });
