/**
 * helpers/oneInc/jiraReadiness.js
 * Which OneInc stories are ready for testing, from Jira (read-only). Per user direction 2026-10-20: use the OneInc
 * Jira stories — especially the Test Execution ones — to tell which story is ready, so a failure on a story whose
 * development isn't finished is reported as "development pending" rather than as a defect.
 *
 * The GCCM project names every OneInc feature's cards the same way (CONFIRMED 2026-10-20, 69 issues):
 *   CC_Requirements_OneInc_<feature> | CC_Dev[elopment]_OneInc_<feature> | CC_Test Design_OneInc_<feature> |
 *   CC_Test Execution_OneInc_<feature>
 * Each test-design workbook is keyed by its Test Design card (GCCM-759, GCCM-1003, ...), so the feature name on
 * that card finds the matching Dev and Test Execution cards. OneInc bugs ("CC Cloud-Test-OneInc-...") are loaded too,
 * so a failing check can point at an already-logged bug.
 *
 * Readiness:
 *   READY        Dev card Done and Test Execution card Ready for QA / In Progress / In QA / Done (or no exec card)
 *   DEV_DONE     Dev card Done, Test Execution card still To Do — testable, not yet handed to QA
 *   DEV_PENDING  Dev card not Done (To Do / In Progress / In Review ...) — failures are likely pending development
 *   UNKNOWN      Jira unavailable (no JIRA_EMAIL/JIRA_API_TOKEN, or the lookup failed) or no cards found
 * Override the JQL with ONEINC_JIRA_JQL.
 */
'use strict';
const { jiraConfig, searchJql } = require('../smartComm/jiraBugService');

const DEFAULT_JQL = 'project = GCCM AND (summary ~ "OneInc" OR summary ~ "One Inc") ORDER BY key';
const DONE = (s) => /^(done|closed|resolved)$/i.test(String(s || '').trim());
const EXEC_READY = (s) => /^(ready for qa|in progress|in qa|in testing|qa|done|closed|resolved)$/i.test(String(s || '').trim());
const OPEN = (s) => !/^(closed|rejected|done|retired|resolved|cancell?ed)$/i.test(String(s || '').trim());

// "CC_Test Execution_OneInc_Payment validation rules part 1" -> { kind: 'exec', feature: 'payment validation rules part 1' }
function parseSummary(summary) {
  const m = /^CC[_ ](Requirements|Dev(?:elopment)?|Test Design|Test Execution)[_ ]+One ?Inc[_ ]+(.+)$/i.exec(String(summary || '').trim());
  if (!m) return null;
  const k = m[1].toLowerCase();
  const kind = k.startsWith('req') ? 'req' : k.startsWith('dev') ? 'dev' : k === 'test design' ? 'design' : 'exec';
  return { kind, feature: m[2].replace(/\s*\(.*?\)\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase() };
}

function readinessOf({ dev, exec }) {
  if (!dev && !exec) return 'UNKNOWN';
  if (dev && !DONE(dev.status)) return 'DEV_PENDING';
  if (exec && !EXEC_READY(exec.status)) return 'DEV_DONE';
  return 'READY';
}

let cache = null;
/**
 * Returns { available, reason, jql, stories: { 'GCCM-759': { feature, design, dev, exec, readiness } }, bugs: [...] }.
 * Stories are keyed by the Test Design card key (= the workbook's story key in inventoryService).
 */
async function loadReadiness({ log = () => {} } = {}) {
  if (cache) return cache;
  const jql = process.env.ONEINC_JIRA_JQL || DEFAULT_JQL;
  const cfg = jiraConfig();
  if (!cfg) { cache = { available: false, reason: 'JIRA_EMAIL / JIRA_API_TOKEN not set', jql, stories: {}, bugs: [] }; return cache; }
  try {
    const issues = await searchJql(cfg, jql, ['summary', 'status', 'issuetype', 'updated']);
    const byFeature = {};
    const bugs = [];
    for (const i of issues) {
      const summary = i.fields.summary || '';
      const status = (i.fields.status || {}).name || '';
      const type = (i.fields.issuetype || {}).name || '';
      if (/bug/i.test(type)) { bugs.push({ key: i.key, status, open: OPEN(status), summary }); continue; }
      const p = parseSummary(summary);
      if (!p) continue;
      const f = byFeature[p.feature] || (byFeature[p.feature] = { feature: p.feature });
      // A feature can have two exec cards (GCCM-1004 Task + GCCM-1005 Story for QuickCheck) — prefer the Story.
      const card = { key: i.key, status, summary, type };
      if (!f[p.kind] || (/story/i.test(type) && !/story/i.test(f[p.kind].type || ''))) f[p.kind] = card;
    }
    const stories = {};
    for (const f of Object.values(byFeature)) {
      if (!f.design) continue;
      stories[f.design.key] = { feature: f.feature, design: f.design, dev: f.dev || null, exec: f.exec || null, readiness: readinessOf(f) };
    }
    cache = { available: true, reason: '', jql, stories, bugs, fetchedAt: new Date().toISOString() };
    log(`[OneInc] Jira: ${Object.keys(stories).length} test-design stories, ${bugs.length} OneInc bugs`);
  } catch (e) {
    cache = { available: false, reason: `Jira lookup failed: ${e.message}`, jql, stories: {}, bugs: [] };
  }
  return cache;
}

// Bugs whose summary mentions the field/label a failing check is about (e.g. "Total Amount of Payment").
function matchBugs(readiness, texts) {
  if (!readiness || !readiness.bugs || !readiness.bugs.length) return [];
  const words = texts.filter(Boolean).map((t) => String(t).toLowerCase().replace(/[“”"?]/g, '').trim()).filter((t) => t.length >= 6);
  return readiness.bugs.filter((b) => words.some((w) => b.summary.toLowerCase().includes(w)))
    .map((b) => ({ key: b.key, status: b.status, open: b.open, summary: b.summary }));
}

module.exports = { loadReadiness, matchBugs, _test: { parseSummary, readinessOf, reset: () => { cache = null; } } };
