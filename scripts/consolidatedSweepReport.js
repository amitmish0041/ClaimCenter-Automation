/**
 * scripts/consolidatedSweepReport.js
 * One workbook for a full sweep run in lanes (scripts/sweepAllLanes.ps1) plus its reruns: each template's FINAL run
 * (the last tag that ran it wins), every issue mapped to its SMART Jira bug where one exists.
 *
 * Usage: node scripts/consolidatedSweepReport.js <tag[,rerunTag,...]> <out.xlsx> [toolNotes.json]
 *   reads results/smartComm/bulk/<tag>-lane<N>.json; toolNotes.json = [{ problem, fix, templates }]
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const jiraBugService = require('../helpers/smartComm/jiraBugService');

const [tagsArg, outPath, notesPath] = process.argv.slice(2);
if (!tagsArg || !outPath) { console.error('Usage: node scripts/consolidatedSweepReport.js <tag[,rerunTag,...]> <out.xlsx> [toolNotes.json]'); process.exit(1); }
const bulkDir = path.join(__dirname, '..', 'results', 'smartComm', 'bulk');

const final = new Map();
for (const tag of tagsArg.split(',')) {
  for (const f of fs.readdirSync(bulkDir).filter((n) => new RegExp(`^${tag}-lane\\d+\\.json$`).test(n))) {
    for (const t of JSON.parse(fs.readFileSync(path.join(bulkDir, f), 'utf8'))) final.set(t.digNumber, { ...t, finalRun: tag });
  }
}
const digKey = (d) => { const m = /^DIG(\d+)(.*)$/.exec(d) || []; return [Number(m[1] || 0), m[2] || '']; };
const templates = [...final.values()].sort((a, b) => { const [x, p] = digKey(a.digNumber); const [y, q] = digKey(b.digNumber); return x - y || p.localeCompare(q); });

const jiraClass = (item) => (item.jiraUnavailable ? 'Jira lookup unavailable'
  : item.knownBug ? (item.knownBug.open ? 'Existing open bug' : 'Closed bug - still occurs (re-open or new)')
    : item.similarBug ? 'New bug needed (similar open bug on another template)' : 'New bug needed');
const clean = (s) => String(s == null ? '' : s).replace(/\s*\(diagnostic:[^)]*\)/g, '').replace(/\s+/g, ' ').trim().slice(0, 1500);

(async () => {
  const jira = await jiraBugService.annotateTemplateResults(templates, { log: (m) => console.log(m) });
  const issues = []; const notVerified = []; const errors = [];
  for (const t of templates) {
    const s = (t.scenarios || [])[0];
    if (!s) { errors.push({ t, s: {}, reason: t.reason }); continue; }
    if (s.status === 'ERROR' || (t.overall === 'BLOCKED' && s.reason)) errors.push({ t, s, reason: s.reason });
    const seen = new Set();
    for (const v of [...(s.validations || []), ...(s.interactiveChecks || [])]) {
      const result = v.result || v.status;
      if (result !== 'FAIL' && result !== 'BLOCKED') continue;
      const row = { t, s, v, what: clean(v.description || v.label), expected: clean(v.expected != null ? v.expected : v.before), actual: clean(v.actual != null ? v.actual : v.after), reason: clean(v.reason) };
      if (result === 'BLOCKED') { notVerified.push(row); continue; }
      // The same finding reported by two checks (a requirement row and its Data Dictionary xpath row) is one issue.
      const key = `${row.expected}|${row.reason.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(row);
    }
  }

  const wb = new ExcelJS.Workbook();
  const sheet = (name, cols) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map(([header, width]) => ({ header, width }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    return ws;
  };
  const count = (list, fn) => list.reduce((a, x) => { const k = fn(x); a[k] = (a[k] || 0) + 1; return a; }, {});

  const byStatus = count(templates, (t) => t.overall);
  const byJira = count(issues, (r) => jiraClass(r.v));
  const errJira = count(errors.filter((e) => e.s.status === 'ERROR'), (e) => jiraClass(e.s));
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 62 }, { width: 16 }, { width: 90 }];
  const add = (a, b, c) => sum.addRow([a, b, c]);
  const head = (text) => { const r = sum.addRow([text]); r.font = { bold: true }; };
  head('SmartCOMM full sweep - one scenario per template - final run of each template');
  add('Environment', `${(process.env.CC_ENV || 'cloud').toUpperCase()} / ${(process.env.CC_TIER || 'test').toUpperCase()}`);
  add('Runs merged (a rerun replaces the earlier result)', tagsArg);
  add('Templates', templates.length);
  sum.addRow([]);
  head('Templates by final status');
  for (const k of ['PASS', 'FAIL', 'BLOCKED', 'ERROR']) add(k, byStatus[k] || 0, k === 'BLOCKED' ? 'Could not be verified (see "Errors and blocked" and "Not verified")' : k === 'ERROR' ? 'No document produced (see "Errors and blocked")' : '');
  sum.addRow([]);
  head('Issues (failed checks) by Jira status');
  add('Issues in total', issues.length, `on ${new Set(issues.map((r) => r.t.digNumber)).size} templates`);
  for (const k of ['Existing open bug', 'Closed bug - still occurs (re-open or new)', 'New bug needed (similar open bug on another template)', 'New bug needed', 'Jira lookup unavailable']) {
    if (byJira[k]) add(k, byJira[k], `on ${new Set(issues.filter((r) => jiraClass(r.v) === k).map((r) => r.t.digNumber)).size} templates`);
  }
  sum.addRow([]);
  head('Templates with no document (ERROR) by Jira status');
  for (const [k, n] of Object.entries(errJira)) add(k, n);
  sum.addRow([]);
  add('How a bug is matched', '', 'A SMART bug that names the same template and the same subject (field / kind of defect). A match is a pointer - read the bug before relying on it.');
  if (!jira.available) add('Jira', '', `Lookup unavailable: ${jira.reason}`);

  const tpl = sheet('Templates', [['Template', 12], ['Name', 44], ['Final status', 12], ['Claim', 24], ['Issues', 8], ['Open bug', 9], ['Closed bug', 10], ['New bug needed', 14], ['Not verified', 12], ['Final run', 12], ['Note', 100]]);
  for (const t of templates) {
    const s = (t.scenarios || [])[0] || {};
    const mine = issues.filter((r) => r.t === t);
    const n = (re) => mine.filter((r) => re.test(jiraClass(r.v))).length;
    tpl.addRow([t.digNumber, t.templateName, t.overall, s.claimNumber || '', mine.length, n(/^Existing/), n(/^Closed/), n(/^New/), notVerified.filter((r) => r.t === t).length, t.finalRun,
      clean(s.reason || t.reason || (s.originalClaimNumber ? `Ran on a backup claim (${s.originalClaimNumber} could not create the document).` : ''))]);
  }

  const iss = sheet('Issues', [['Template', 12], ['Name', 36], ['Claim', 24], ['Check', 10], ['What was checked', 60], ['Expected', 40], ['Actual', 40], ['Finding', 90], ['Jira status', 34], ['Jira bug', 14], ['Bug status', 16], ['Bug summary', 70]]);
  for (const r of issues) {
    const bug = r.v.knownBug || r.v.similarBug || {};
    iss.addRow([r.t.digNumber, r.t.templateName, r.s.claimNumber, r.v.id, r.what, r.expected, r.actual, r.reason, jiraClass(r.v), bug.key || '', bug.status || '', bug.summary || '']);
  }

  const nv = sheet('Not verified', [['Template', 12], ['Name', 36], ['Claim', 24], ['Check', 10], ['What was checked', 60], ['Why it could not be verified', 120]]);
  for (const r of notVerified) nv.addRow([r.t.digNumber, r.t.templateName, r.s.claimNumber, r.v.id, r.what, r.reason]);

  const er = sheet('Errors and blocked', [['Template', 12], ['Name', 40], ['Final status', 12], ['Claim', 24], ['Reason', 130], ['Jira status', 34], ['Jira bug', 14], ['Bug status', 16]]);
  for (const e of errors) {
    const bug = e.s.knownBug || e.s.similarBug || {};
    er.addRow([e.t.digNumber, e.t.templateName, e.t.overall, e.s.claimNumber || '', clean(e.reason), e.s.status === 'ERROR' ? jiraClass(e.s) : '', bug.key || '', bug.status || '']);
  }

  if (notesPath) {
    const tn = sheet('Tool notes', [['Problem found in the tool', 90], ['Fix', 90], ['Templates rerun', 60]]);
    for (const n of JSON.parse(fs.readFileSync(notesPath, 'utf8'))) tn.addRow([n.problem, n.fix, n.templates]);
  }
  for (const ws of wb.worksheets) ws.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  await wb.xlsx.writeFile(outPath);
  console.log(JSON.stringify({ templates: templates.length, byStatus, issues: issues.length, byJira, errorsByJira: errJira, notVerified: notVerified.length, out: outPath }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
