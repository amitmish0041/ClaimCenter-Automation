/**
 * helpers/smartComm/jiraBugService.js
 * Maps each failure a validation run finds to an EXISTING Jira bug in the SMART project, so a tester can see
 * "already logged as SMART-1424 (Re-Open)" instead of logging a duplicate — and, just as useful, which failures
 * have NO matching bug yet ("NEW — log a bug"). Per user direction 2026-10-13.
 *
 * A bug is a candidate for a template when its summary/description names that DIG number, or when the
 * template's own "<DIG> - <name>_Test_Execution" story links to it. A failure matches a candidate when they
 * share a SUBJECT (underwriting company, fraud language, claimant, "Enclosure", alignment, ...) — and, for
 * editability failures, both are about editing. Open bugs are preferred over closed ones; a closed bug that
 * matches is reported as such (the issue was supposedly fixed — possible regression).
 *
 * Read-only against Jira. Needs JIRA_EMAIL + JIRA_API_TOKEN (the runner's Settings tab or .env; JIRA_SITE
 * defaults to donegalgroup.atlassian.net) — without them every helper here is a no-op that says so.
 */
'use strict';

const OPEN = (status) => !/^(closed|rejected|done|retired|resolved|cancell?ed)$/i.test(String(status || '').trim());

function jiraConfig() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!email || !token) return null;
  const site = String(process.env.JIRA_SITE || 'donegalgroup.atlassian.net').replace(/^https?:\/\//i, '').replace(/[\/?#].*$/, '');
  return { site, auth: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
}

function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  const inner = (node.content || []).map(adfToText).join(' ');
  return ['paragraph', 'heading', 'listItem', 'tableRow'].includes(node.type) ? `${inner}\n` : inner;
}

async function searchJql(cfg, jql, fields) {
  const out = [];
  let nextPageToken;
  for (let page = 0; page < 20; page++) {
    const body = { jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) };
    const res = await fetch(`https://${cfg.site}/rest/api/3/search/jql`, {
      method: 'POST', headers: { Authorization: cfg.auth, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jira search failed (${res.status}) for "${jql.slice(0, 60)}"`);
    const data = await res.json();
    out.push(...(data.issues || []));
    if (!data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return out;
}

const DIG_RE = /\bDIG\s*-?\s*(\d+[A-Z]{0,3})\b/gi;
const digsIn = (text) => Array.from(String(text || '').matchAll(DIG_RE)).map((m) => `DIG${m[1].toUpperCase()}`);

let cache = null;
// { available, reason, bugs: [{ key, status, open, summary, text, digs:Set }] } — fetched once per process.
async function loadKnownBugs({ log = () => {} } = {}) {
  if (cache) return cache;
  const cfg = jiraConfig();
  if (!cfg) { cache = { available: false, reason: 'JIRA_EMAIL / JIRA_API_TOKEN not set', bugs: [] }; return cache; }
  try {
    const bugs = await searchJql(cfg, 'project = SMART AND issuetype = Bug ORDER BY key DESC', ['summary', 'status', 'description']);
    const stories = await searchJql(cfg, 'project = SMART AND issuetype = Story AND summary ~ "Test_Execution"', ['summary', 'issuelinks']);
    const linkedDigs = new Map(); // bug key -> Set of DIGs whose Test_Execution story links to it
    for (const s of stories) {
      const sd = digsIn(s.fields.summary);
      for (const l of s.fields.issuelinks || []) {
        const o = l.inwardIssue || l.outwardIssue;
        if (!o || !o.fields || !/bug/i.test((o.fields.issuetype || {}).name || '')) continue;
        if (!linkedDigs.has(o.key)) linkedDigs.set(o.key, new Set());
        sd.forEach((d) => linkedDigs.get(o.key).add(d));
      }
    }
    const list = bugs.map((b) => {
      const text = `${b.fields.summary || ''}\n${adfToText(b.fields.description)}`;
      const digs = new Set([...digsIn(b.fields.summary), ...digsIn(adfToText(b.fields.description).slice(0, 400)), ...(linkedDigs.get(b.key) || [])]);
      const status = (b.fields.status || {}).name || '';
      return { key: b.key, status, open: OPEN(status), summary: b.fields.summary || '', text, digs };
    });
    cache = { available: true, bugs: list };
    log(`[Jira] loaded ${list.length} SMART bug(s) (${list.filter((b) => b.open).length} open) for finding-to-bug mapping`);
  } catch (err) {
    cache = { available: false, reason: err.message, bugs: [] };
    log(`[Jira] couldn't load SMART bugs (${err.message}) — findings won't be mapped to existing bugs this run`);
  }
  return cache;
}

// Subjects a failure and a bug can share. `edit` is the editability axis, not a subject on its own.
const SUBJECTS = [
  ['uw', /underwrit|\bUW\b/i], ['fraud', /fraud/i], ['enclosure', /enclosure/i], ['claimant', /claimant|injured party/i],
  ['insured', /\binsured\b/i], ['dol', /date of loss|\bD\/L\b/i], ['policy', /policy\s*(no|number|type)/i],
  ['copy', /copy (name|address|city)|additional recipient|\bcc\b/i], ['address', /1195 river|river r(oa)?d/i],
  ['website', /website|donegalgroup\.com/i], ['phone', /phone|extension|contact number|\bx\d{3,5}\b/i],
  ['signature', /signature|from (name|title|phone|email)|designation|sincerely/i], ['header', /claim no|header|\bRE\b section|\bRE:/i],
  ['date_letter', /date of letter/i], ['agent', /agent number/i], ['loss_location', /loss location/i],
  ['align', /align|LAYOUT1/i], ['paragraph', /paragraph|merged|run.?on|LAYOUT2/i], ['order', /\border\b|LAYOUT3|printed \d(st|nd|rd|th)/i],
  ['choice', /letterhead|choices? (panel|option)|CHOICE\d/i],
  ['generate', /fail(ed)? to (generate|load)|unable to generate|error (when|during|generating)|GENERATE_FAILED|COMPLETE_FAILED|prolog/i],
];
const EDIT_RE = /editable|not able to edit|unable to edit|able to (edit|delete)|should (not )?be (editable|locked)|can delete|LOCK1/i;
const topicsOf = (text) => new Set(SUBJECTS.filter(([, re]) => re.test(text)).map(([k]) => k));

function matchFinding(dig, findingText, known, { anyTemplate = false } = {}) {
  if (!known || !known.available) return null;
  const fTopics = topicsOf(findingText);
  if (!fTopics.size) return null;
  const fEdit = EDIT_RE.test(findingText);
  let best = null;
  for (const b of known.bugs) {
    if (anyTemplate ? !b.open : !b.digs.has(String(dig).toUpperCase())) continue;
    const bTopics = topicsOf(b.text);
    const shared = [...fTopics].filter((t) => bTopics.has(t));
    if (!shared.length) continue;
    if (fEdit && !EDIT_RE.test(b.text)) continue; // an editability failure only matches an editability bug
    const score = shared.length * 2 + (b.open ? 3 : 0) + (fEdit === EDIT_RE.test(b.text) ? 1 : 0);
    if (!best || score > best.score) best = { score, bug: b, shared };
  }
  return best ? { key: best.bug.key, status: best.bug.status, open: best.bug.open, summary: best.bug.summary, on: best.shared } : null;
}

// Annotates every FAIL validation, FAIL interactive check and ERROR scenario in bulk/template results with
// `knownBug` ({ key, status, open, summary } | null). Returns a summary { available, reason, known, newFindings }.
async function annotateTemplateResults(templateResults, { log = () => {} } = {}) {
  const known = await loadKnownBugs({ log });
  const summary = { available: known.available, reason: known.reason, known: 0, newFindings: 0 };
  if (!known.available) {
    // Say why in every failure's Jira cell — a silently blank column read as "Jira mapping is broken" (2026-10-19).
    log(`[Jira] lookup unavailable: ${known.reason}`);
    for (const t of templateResults || []) {
      for (const s of t.scenarios || []) {
        for (const item of [s, ...(s.validations || []), ...(s.interactiveChecks || [])]) {
          if (item && (item.result === 'FAIL' || item.status === 'ERROR')) item.jiraUnavailable = known.reason;
        }
      }
    }
    return summary;
  }
  for (const t of templateResults || []) {
    for (const s of t.scenarios || []) {
      const tag = (item, text) => {
        item.knownBug = matchFinding(t.digNumber, text, known);
        if (item.knownBug) { summary.known++; return; }
        summary.newFindings++;
        // Not logged for THIS template — but the same defect may already be open on another one (e.g. the fraud
        // notice editable everywhere, logged once as SMART-1313 on DIG15): point at it instead of a blank "new".
        const similar = matchFinding(t.digNumber, text, known, { anyTemplate: true });
        if (similar) item.similarBug = similar;
      };
      if (s.status === 'ERROR') tag(s, `${s.reason || ''}`);
      for (const v of s.validations || []) if (v.result === 'FAIL') tag(v, `${v.id} ${v.description} ${v.expected || ''} ${v.actual || ''} ${v.reason || ''}`);
      for (const c of s.interactiveChecks || []) if (c.result === 'FAIL') tag(c, `${c.label || ''} ${c.dictionaryField || ''} ${c.reason || ''} editable`);
    }
  }
  log(`[Jira] findings mapped to existing bugs: ${summary.known} known, ${summary.newFindings} new (no matching bug)`);
  return summary;
}

// "SMART-1424 (Re-Open)" / "NEW — no matching bug" for a report cell; '' for anything that isn't a failure.
function jiraCell(item) {
  if (!item) return '';
  if (item.jiraUnavailable) {
    return `Jira lookup unavailable (${/not set/i.test(item.jiraUnavailable) ? 'no Jira email / API token — add them on the Settings tab' : String(item.jiraUnavailable).slice(0, 80)})`;
  }
  if (item.knownBug) {
    return item.knownBug.open ? `${item.knownBug.key} (${item.knownBug.status})`
      : `${item.knownBug.key} (${item.knownBug.status}) — closed but still occurs: possible regression, re-open or log new`;
  }
  if (item.knownBug !== null) return '';
  return item.similarBug
    ? `NEW for this template — similar open ${item.similarBug.key} (${item.similarBug.status}) on another template`
    : 'NEW — no matching bug';
}

// jiraConfig/searchJql are also used by the OneInc suite's story-readiness lookup (helpers/oneInc/jiraReadiness.js).
module.exports = { loadKnownBugs, matchFinding, annotateTemplateResults, jiraCell, jiraConfig, searchJql };
