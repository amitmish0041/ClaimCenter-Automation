/**
 * helpers/smartComm/resultsStore.js
 * The SmartCOMM run history the Runner's Results page reads: every saved run under results/smartComm —
 *   bulk/*.json  bulk runs (scripts/bulkValidateSmartComm.js — a plain array of template results)
 *   runs/*.json  single-template runs (tests/smartComm/SmartCommValidator.spec.js, via saveRun below)
 * listRuns() summarises them newest first, getRun() returns one in full, compareWithPrevious() marks each check
 * NEW (failing now, not before) or FIXED (failing before, passing now) against the previous run of the same
 * scenarios, and pdfPathFor() hands out a scenario's PDF only when it sits inside the results folder.
 * Run ids are "<folder>--<file name>"; anything else is refused, so an id can never point outside these folders.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join(__dirname, '..', '..', 'results', 'smartComm');
const FOLDERS = ['runs', 'bulk'];
const ID_RE = /^(runs|bulk)--([\w.-]+\.json)$/;
const STATUSES = ['PASS', 'FAIL', 'BLOCKED', 'ERROR'];

function idOf(folder, file) { return `${folder}--${file}`; }
function fileOf(id, root) {
  const m = ID_RE.exec(String(id || ''));
  return m ? path.join(root, m[1], m[2]) : null;
}

// A run's time: saved in the file (runs/), else the epoch in its name ("ui_bulk_1791203145627.json", seconds or
// milliseconds), else the file's own modified time.
function startedAtOf(file, data, stat) {
  if (data && data.savedAt) return data.savedAt;
  const m = /(\d{10,13})/.exec(path.basename(file));
  if (m) return new Date(m[1].length === 13 ? Number(m[1]) : Number(m[1]) * 1000).toISOString();
  return stat.mtime.toISOString();
}

function read(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const templates = Array.isArray(raw) ? raw : (raw.templates || raw.templateResults || []);
  return { raw, templates: templates.filter((t) => t && typeof t === 'object'), meta: (!Array.isArray(raw) && raw.meta) || {} };
}

// Cached per file by size + modified time — a bulk file is rewritten after every template, so it stays current.
const cache = new Map();
function summaryOf(file, folder, root) {
  const stat = fs.statSync(file);
  const key = `${file}|${stat.size}|${stat.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  let s;
  try {
    const { raw, templates, meta } = read(file);
    const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, ERROR: 0 };
    let scenarioCount = 0;
    for (const t of templates) for (const sc of t.scenarios || []) { scenarioCount++; if (counts[sc.status] !== undefined) counts[sc.status]++; }
    const overall = counts.ERROR ? 'ERROR' : counts.FAIL ? 'FAIL' : counts.BLOCKED ? 'BLOCKED' : scenarioCount ? 'PASS'
      : (templates.some((t) => t.overall === 'BLOCKED') ? 'BLOCKED' : 'ERROR');
    s = {
      id: idOf(folder, path.basename(file)),
      source: folder === 'bulk' ? 'bulk' : 'single',
      startedAt: startedAtOf(file, Array.isArray(raw) ? null : raw, stat),
      env: meta.env || null,
      requestedBy: meta.requestedBy || null,
      templates: templates.map((t) => ({ digNumber: t.digNumber, templateName: t.templateName, overall: t.overall })),
      scenarioCount, counts, overall,
    };
  } catch (e) {
    s = { id: idOf(folder, path.basename(file)), source: folder, startedAt: stat.mtime.toISOString(), unreadable: e.message, templates: [], scenarioCount: 0, counts: {}, overall: 'ERROR' };
  }
  cache.set(key, s);
  return s;
}

function listRuns({ root = DEFAULT_ROOT, limit = 50 } = {}) {
  const out = [];
  for (const folder of FOLDERS) {
    const dir = path.join(root, folder);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/^[\w.-]+\.json$/.test(f)) continue;
      out.push(summaryOf(path.join(dir, f), folder, root));
    }
  }
  return out.filter((s) => !s.unreadable).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit);
}

function getRun(id, { root = DEFAULT_ROOT } = {}) {
  const file = fileOf(id, root);
  if (!file || !fs.existsSync(file)) return null;
  const { templates, meta } = read(file);
  const folder = ID_RE.exec(id)[1];
  return { ...summaryOf(file, folder, root), meta, templates };
}

const scenarioKey = (t, sc) => `${t.digNumber || sc.digNumber}|${sc.scenarioId}`;
const checkKey = (v) => v.id || v.description || '';

// NEW / FIXED per check against the most recent earlier run that has the same scenario. A scenario no earlier
// run has is left unmarked — there's nothing to compare it with.
function compareWithPrevious(id, { root = DEFAULT_ROOT } = {}) {
  const run = getRun(id, { root });
  if (!run) return null;
  const earlier = listRuns({ root, limit: 1000 }).filter((r) => r.id !== id && String(r.startedAt) < String(run.startedAt));
  const loaded = new Map();
  const load = (rid) => { if (!loaded.has(rid)) loaded.set(rid, getRun(rid, { root })); return loaded.get(rid); };
  const scenarios = {};
  let newFailures = 0; let fixed = 0;
  for (const t of run.templates) {
    for (const sc of t.scenarios || []) {
      const key = scenarioKey(t, sc);
      let prev = null; let prevRun = null;
      for (const r of earlier) {
        if (!r.templates.some((x) => x.digNumber === t.digNumber)) continue;
        const pr = load(r.id);
        const pt = pr && pr.templates.find((x) => x.digNumber === t.digNumber);
        const ps = pt && (pt.scenarios || []).find((x) => x.scenarioId === sc.scenarioId);
        if (ps) { prev = ps; prevRun = r; break; }
      }
      if (!prev) { scenarios[key] = { previousRunId: null, checks: {} }; continue; }
      const before = new Map((prev.validations || []).map((v) => [checkKey(v), v.result]));
      const checks = {};
      for (const v of sc.validations || []) {
        const was = before.has(checkKey(v)) ? before.get(checkKey(v)) : null;
        let change = null;
        if (v.result === 'FAIL' && was !== 'FAIL') change = 'NEW';
        else if (was === 'FAIL' && v.result === 'PASS') change = 'FIXED';
        if (change === 'NEW') newFailures++;
        if (change === 'FIXED') fixed++;
        checks[checkKey(v)] = { was, now: v.result, change };
      }
      scenarios[key] = { previousRunId: prevRun.id, previousStartedAt: prevRun.startedAt, previousStatus: prev.status, checks };
    }
  }
  return { runId: id, newFailures, fixed, scenarios };
}

// A scenario's own generated PDF — only a .pdf that exists inside the results folder (the path comes from a results
// file, which is data, so it's never trusted to point anywhere else).
function pdfPathFor(id, dig, scenarioId, { root = DEFAULT_ROOT } = {}) {
  const run = getRun(id, { root });
  if (!run) return null;
  const t = run.templates.find((x) => x.digNumber === dig);
  const sc = t && (t.scenarios || []).find((x) => x.scenarioId === scenarioId);
  if (!sc || !sc.pdfPath) return null;
  const p = path.resolve(String(sc.pdfPath));
  const base = path.resolve(root);
  if (!p.toLowerCase().startsWith((base + path.sep).toLowerCase()) || !/\.pdf$/i.test(p) || !fs.existsSync(p)) return null;
  return p;
}

// Saves one run (an array of template results) under runs/, for the Results page.
function saveRun(templates, meta = {}, { root = DEFAULT_ROOT } = {}) {
  const dir = path.join(root, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const savedAt = new Date();
  const file = path.join(dir, `run_${savedAt.getTime()}.json`);
  fs.writeFileSync(file, JSON.stringify({ format: 1, savedAt: savedAt.toISOString(), meta, templates }, null, 1));
  return idOf('runs', path.basename(file));
}

module.exports = { listRuns, getRun, compareWithPrevious, pdfPathFor, saveRun, STATUSES, DEFAULT_ROOT };
