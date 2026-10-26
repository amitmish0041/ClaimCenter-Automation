#!/usr/bin/env node
/**
 * scripts/reviewRunHistory.js
 * Summarises the team's shared SmartCOMM run history (resultsStore.shareRun → V:/Amit Int/SmartComm/run-history) so
 * the tool itself can be reviewed regularly: which checks fail or block most, on how many templates and runs, by whom,
 * on which code version — recurring patterns across many templates are the first place to look for false flags.
 *
 *   node scripts/reviewRunHistory.js [--days 7] [--dir <run-history>] [--out <file.json>]
 *
 * Prints a ranked list of failure/blocked patterns (check type + reason with values masked), each with example
 * template/check ids, and per-user / per-code-version run counts. Read only.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const days = Number(arg('days', 7));
const dir = arg('dir', process.env.SMARTCOMM_SHARED_RUNS_DIR || 'V:/Amit Int/SmartComm/run-history');
const since = Date.now() - days * 864e5;

// A reason with its specifics masked, so the same problem on different templates groups together.
const pattern = (s) => String(s || '').replace(/"[^"]*"/g, '"…"').replace(/\b(INT|EDIT|R|XP|OVL-[A-Z]|META|LOCK|LAYOUT)\d+\b/g, '$1#')
  .replace(/\d+/g, 'n').replace(/\s+/g, ' ').trim().slice(0, 160);
const kind = (id) => String(id || '').replace(/\d+$/, '#');

function files(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const month of fs.readdirSync(root)) {
    const m = path.join(root, month);
    if (!fs.statSync(m).isDirectory()) continue;
    for (const f of fs.readdirSync(m)) if (f.endsWith('.json')) out.push(path.join(m, f));
  }
  return out;
}

const groups = new Map();
const byUser = {};
const byCode = {};
let runs = 0;
for (const file of files(dir)) {
  let run;
  try { run = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
  if (Date.parse(run.savedAt) < since) continue;
  runs++;
  byUser[run.user] = (byUser[run.user] || 0) + 1;
  byCode[run.codeVersion || '?'] = (byCode[run.codeVersion || '?'] || 0) + 1;
  for (const t of run.templates || []) {
    for (const s of t.scenarios || []) {
      const rows = [...(s.validations || []), ...(s.interactiveChecks || []).map((c) => ({ ...c, id: c.id || 'INT', description: c.label }))];
      if (s.status === 'ERROR') rows.push({ id: 'ERROR', result: 'ERROR', reason: s.reason });
      for (const v of rows) {
        if (!/FAIL|BLOCKED|ERROR/.test(v.result || '')) continue;
        const key = `${v.result} ${kind(v.id)} | ${pattern(v.reason)}`;
        if (!groups.has(key)) groups.set(key, { count: 0, templates: new Set(), runs: new Set(), examples: [] });
        const g = groups.get(key);
        g.count++;
        g.templates.add(t.digNumber);
        g.runs.add(file);
        if (g.examples.length < 3) g.examples.push(`${t.digNumber} ${s.scenarioId || ''} ${v.id}`);
      }
    }
  }
}

const ranked = [...groups.entries()].map(([key, g]) => ({ key, count: g.count, templates: g.templates.size, runs: g.runs.size, examples: g.examples }))
  .sort((a, b) => b.templates - a.templates || b.count - a.count);
console.log(`Run history: ${dir} — last ${days} day(s): ${runs} run(s)`);
console.log(`By user: ${JSON.stringify(byUser)}   By code version: ${JSON.stringify(byCode)}`);
console.log('\nFailure / blocked patterns (most templates first) — patterns on many templates are the likeliest tool issues:');
for (const r of ranked.slice(0, 40)) console.log(`  [${r.templates} templates, ${r.count}x, ${r.runs} runs] ${r.key}\n      e.g. ${r.examples.join(' ; ')}`);
const out = arg('out', null);
if (out) { fs.writeFileSync(out, JSON.stringify({ dir, days, runs, byUser, byCode, patterns: ranked }, null, 1)); console.log(`\nWritten: ${out}`); }
