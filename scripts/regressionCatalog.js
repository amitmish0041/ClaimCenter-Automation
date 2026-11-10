#!/usr/bin/env node
/**
 * scripts/regressionCatalog.js — Regression Test Design V1.0 catalog (helpers/regression/catalog.json) on the command
 * line, plus the last result of each case (results/regression/latest/<TC>.json). Read-only.
 *
 *   node scripts/regressionCatalog.js                 summary by feature
 *   node scripts/regressionCatalog.js --grep "Intake FNOL,Financials"
 *                                                     the --grep for those features' automated cases
 *   node scripts/regressionCatalog.js --json          catalog + last results as JSON (what the Runner reads)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CATALOG = require('../helpers/regression/catalog.json');
const LATEST = path.join(__dirname, '..', 'results', 'regression', 'latest');

function last(id) {
  try { return JSON.parse(fs.readFileSync(path.join(LATEST, `${id}.json`), 'utf8')); } catch (_) { return null; }
}

// Playwright --grep for a set of cases: each automated case's own grep, OR-ed.
function grepFor(cases) {
  const parts = [...new Set(cases.filter((c) => c.status !== 'MANUAL' && c.grep).map((c) => c.grep))];
  return parts.length ? parts.join('|') : null;
}

function withResults() {
  return CATALOG.map((c) => {
    const r = last(c.id);
    return { ...c, last: r ? { status: r.status, reason: r.reason || '', claim: r.claim || '', finishedAt: r.finishedAt, runId: r.runId } : null };
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--json')) { process.stdout.write(JSON.stringify(withResults(), null, 2)); process.exit(0); }
  const gi = args.indexOf('--grep');
  if (gi >= 0) {
    const want = String(args[gi + 1] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const sel = CATALOG.filter((c) => !want.length || want.includes(c.feature.toLowerCase()) || want.includes(c.id.toLowerCase()));
    const g = grepFor(sel);
    if (!g) { console.error('no automated cases in that selection'); process.exit(1); }
    process.stdout.write(g + '\n');
    process.exit(0);
  }
  const by = {};
  for (const c of withResults()) (by[c.feature] = by[c.feature] || []).push(c);
  for (const [f, cs] of Object.entries(by)) {
    const n = (s) => cs.filter((c) => c.status === s).length;
    console.log(`${f.padEnd(44)} ${String(cs.length).padStart(2)} cases  auto ${n('AUTOMATED')}  partial ${n('PARTIAL')}  manual ${n('MANUAL')}`);
    for (const c of cs) console.log(`   ${c.id} ${c.status.padEnd(9)} ${c.last ? c.last.status.padEnd(7) : '-'.padEnd(7)} ${c.name.slice(0, 90)}`);
  }
}

module.exports = { CATALOG, grepFor, withResults };
