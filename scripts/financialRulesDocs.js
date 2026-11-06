/**
 * scripts/financialRulesDocs.js — one Word document per Financial-rules case, same layout as the OneInc case
 * documents (scripts/oneIncCaseReviews.js buildOne).
 *
 * Reads every fr-result.json the last FinancialRules.test.js run left under test-results/, and writes
 *   <FIN_DOCS_DIR>\<yyyy-mm-dd>\<case id>.docx        (default: Desktop\Financial test cases\Results)
 *
 *   node scripts/financialRulesDocs.js [--out <dir>]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildOne } = require('./oneIncCaseReviews');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = arg('--out') || process.env.FIN_DOCS_DIR || path.join(os.homedir(), 'Desktop', 'Financial test cases', 'Results');

function findResults(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findResults(p, out);
    else if (e.name === 'fr-result.json') out.push(p);
  }
  return out;
}

(async () => {
  const files = findResults(path.join(__dirname, '..', 'test-results'));
  if (!files.length) { console.log('No fr-result.json found under test-results/ — run tests/Financials/FinancialRules.test.js first.'); return; }
  const d = new Date(); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const outDir = path.join(ROOT, day);
  fs.mkdirSync(outDir, { recursive: true });
  const runId = `FinancialRules_${day}`;
  const summary = [];
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    const file = path.join(outDir, `${r.scenarioId.replace(/[^A-Za-z0-9_-]+/g, '_')}.docx`);
    fs.writeFileSync(file, await buildOne(r, runId));
    summary.push(`${r.scenarioId}\t${r.status}\t${r.claim || ''}\t${file}`);
  }
  console.log(summary.join('\n'));
  console.log(`${files.length} document(s) in ${outDir}`);
})().catch((e) => { console.error(e); process.exit(1); });
