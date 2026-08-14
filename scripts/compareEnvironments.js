/**
 * scripts/compareEnvironments.js
 *
 * Diffs the on-prem and cloud claim snapshots produced by
 * helpers/claimSnapshot.js and classifies every difference RED / YELLOW /
 * GREEN, per the Cloud Upgrade Testing Strategy's success criteria.
 *
 *   npm run compare:envs                 (defaults to the dev tier)
 *   npm run compare:envs -- --tier=test
 *
 * Reads : results/snapshots/onprem-<tier>/<LOB>.json
 *         results/snapshots/cloud-<tier>/<LOB>.json
 * Writes: results/comparison/<tier>-comparison.json
 *         results/comparison/<tier>-comparison.html
 *
 * CLASSIFICATION (from the strategy doc's tolerances):
 *   RED    - a business-outcome divergence: monetary amounts differing by more
 *            than $0.01, a different adjuster/approver, a different claim
 *            status, or a different exposure count.
 *   YELLOW - a difference that is expected or tolerable: claim-number format
 *            (prefixes legitimately differ per environment), loss date//text
 *            formatting, validation wording.
 *   GREEN  - identical, within tolerance.
 *
 * A field captured on one side but not the other is reported as NOT_COMPARED,
 * never as a match. Reporting "identical" for something never read is the
 * failure mode this whole exercise is meant to catch.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'results');
const SNAPSHOTS = path.join(ROOT, 'snapshots');
const OUT = path.join(ROOT, 'comparison');

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : dflt;
};
const TIER = (arg('tier', process.env.CC_TIER || 'dev')).toLowerCase();

// Only treat a value as money when it is unambiguously money: a currency
// symbol, or a bare number. Without this, claim numbers like "CA-OH-85-26-0001"
// parsed as amounts and a claim-number difference was reported as a monetary
// divergence.
const money = (s) => {
  if (typeof s !== 'string') return null;
  const t = s.replace(/,/g, '').trim();
  const m = t.match(/^-?\$\s*(-?\d+(?:\.\d+)?)$/) || t.match(/^\(?\$?\s*(-?\d+(?:\.\d+)?)\)?$/);
  return m ? parseFloat(m[1]) : null;
};

// Fields whose value is expected to differ between environments by design.
const FORMAT_ONLY = [/^claim$/i, /^claimNumber$/i];

function compareField(name, a, b) {
  if (a === undefined || a === null || a === '' ||
      b === undefined || b === null || b === '') {
    return { name, onprem: a ?? null, cloud: b ?? null, verdict: 'NOT_COMPARED',
             note: 'captured on one environment only' };
  }
  if (String(a).trim() === String(b).trim()) {
    return { name, onprem: a, cloud: b, verdict: 'GREEN' };
  }
  // Format-only fields first: a claim number legitimately differs by
  // environment and must never be graded as a value divergence.
  const leaf = name.split('.').pop();
  if (FORMAT_ONLY.some(rx => rx.test(leaf))) {
    return { name, onprem: a, cloud: b, verdict: 'YELLOW',
             note: 'claim-number format differs by environment (expected)' };
  }

  const [ma, mb] = [money(a), money(b)];
  if (ma !== null && mb !== null) {
    const delta = +Math.abs(ma - mb).toFixed(2);   // round BEFORE comparing
    const withinTolerance = delta <= 0.01;
    return {
      name, onprem: a, cloud: b, delta,
      verdict: withinTolerance ? 'GREEN' : 'RED',
      note: withinTolerance ? 'within $0.01 tolerance' : 'monetary divergence',
    };
  }
  return { name, onprem: a, cloud: b, verdict: 'RED', note: 'value differs' };
}

function compareSnapshots(onprem, cloud) {
  const findings = [];

  // Header: adjuster/status divergences are business outcomes (RED by default
  // via compareField); claim number is format-only (YELLOW).
  const headerKeys = new Set([...Object.keys(onprem.header || {}), ...Object.keys(cloud.header || {})]);
  for (const k of headerKeys) {
    findings.push(compareField('header.' + k, (onprem.header || {})[k], (cloud.header || {})[k]));
  }

  // Exposure COUNT is a business outcome in its own right - a claim with two
  // exposures on one environment and one on the other is a real divergence
  // regardless of what the rows contain.
  const oc = (onprem.exposures || []).length;
  const cc = (cloud.exposures || []).length;
  findings.push({
    name: 'exposures.count', onprem: oc, cloud: cc,
    verdict: oc === cc ? 'GREEN' : 'RED',
    note: oc === cc ? undefined : 'different number of exposures',
  });

  // Compare exposures pairwise on the columns both environments captured.
  const n = Math.min(oc, cc);
  for (let i = 0; i < n; i++) {
    const a = onprem.exposures[i] || {};
    const b = cloud.exposures[i] || {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      findings.push(compareField('exposures[' + i + '].' + key, a[key], b[key]));
    }
  }

  for (const k of new Set([...Object.keys(onprem.financials || {}), ...Object.keys(cloud.financials || {})])) {
    findings.push(compareField('financials.' + k, (onprem.financials || {})[k], (cloud.financials || {})[k]));
  }

  // Validation wording differs freely between platforms; only its PRESENCE is
  // meaningful, so grade that rather than the text.
  const ov = !!(onprem.validation || '').trim();
  const cv = !!(cloud.validation || '').trim();
  findings.push({
    name: 'validation.present', onprem: ov, cloud: cv,
    verdict: ov === cv ? 'GREEN' : 'YELLOW',
    note: ov === cv ? undefined : 'one environment reported validation messages and the other did not',
    detail: { onprem: onprem.validation || null, cloud: cloud.validation || null },
  });

  return findings;
}

function main() {
  const onpremDir = path.join(SNAPSHOTS, 'onprem-' + TIER);
  const cloudDir  = path.join(SNAPSHOTS, 'cloud-' + TIER);

  for (const d of [onpremDir, cloudDir]) {
    if (!fs.existsSync(d)) {
      console.error('compareEnvironments: no snapshots at ' + path.relative(process.cwd(), d) +
                    '\n  Run the suite on BOTH environments first, e.g.:' +
                    '\n    cross-env CC_ENV=onprem CC_TIER=' + TIER + ' npx playwright test --project="E2E - All LOBs"' +
                    '\n    cross-env CC_ENV=cloud  CC_TIER=' + TIER + ' npx playwright test --project="E2E - All LOBs"');
      process.exit(1);
    }
  }

  const lobs = [...new Set([
    ...fs.readdirSync(onpremDir).filter(f => f.endsWith('.json')),
    ...fs.readdirSync(cloudDir).filter(f => f.endsWith('.json')),
  ])].sort();

  const report = { tier: TIER, generatedAt: new Date().toISOString(), lobs: [] };
  let red = 0, yellow = 0, green = 0, notCompared = 0;

  for (const file of lobs) {
    const lob = file.replace(/\.json$/, '');
    const oPath = path.join(onpremDir, file);
    const cPath = path.join(cloudDir, file);
    if (!fs.existsSync(oPath) || !fs.existsSync(cPath)) {
      report.lobs.push({
        lob, status: 'MISSING',
        note: 'snapshot present only on ' + (fs.existsSync(oPath) ? 'on-prem' : 'cloud') +
              ' - that environment\'s run did not reach the capture point',
        findings: [],
      });
      continue;
    }
    const onprem = JSON.parse(fs.readFileSync(oPath, 'utf8'));
    const cloud  = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    const findings = compareSnapshots(onprem, cloud);
    for (const f of findings) {
      if (f.verdict === 'RED') red++;
      else if (f.verdict === 'YELLOW') yellow++;
      else if (f.verdict === 'GREEN') green++;
      else notCompared++;
    }
    report.lobs.push({
      lob, status: 'COMPARED',
      claims: { onprem: onprem.meta.claimNumber, cloud: cloud.meta.claimNumber },
      notCaptured: [...new Set([...(onprem.notCaptured || []), ...(cloud.notCaptured || [])])],
      findings,
    });
  }

  report.summary = { red, yellow, green, notCompared };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, TIER + '-comparison.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, TIER + '-comparison.html'), html(report), 'utf8');

  console.log('\n=======================================================');
  console.log('  ON-PREM vs CLOUD COMPARISON (' + TIER + ')');
  console.log('=======================================================');
  for (const l of report.lobs) {
    if (l.status === 'MISSING') { console.log('  ' + l.lob.padEnd(6) + ' MISSING — ' + l.note); continue; }
    const r = l.findings.filter(f => f.verdict === 'RED');
    console.log('  ' + l.lob.padEnd(6) + ' ' + (r.length ? 'RED x' + r.length : 'no RED') +
                '   (' + l.claims.onprem + ' vs ' + l.claims.cloud + ')');
    for (const f of r.slice(0, 6)) {
      console.log('      ! ' + f.name + ': on-prem="' + f.onprem + '" cloud="' + f.cloud + '"');
    }
  }
  console.log('-------------------------------------------------------');
  console.log('  RED ' + red + ' | YELLOW ' + yellow + ' | GREEN ' + green + ' | NOT COMPARED ' + notCompared);
  console.log('  Report -> ' + path.relative(process.cwd(), path.join(OUT, TIER + '-comparison.html')));
  console.log('=======================================================\n');

  // Non-zero exit on RED so CI can gate on it (the doc's "No-go if any").
  process.exit(red > 0 ? 2 : 0);
}

function html(report) {
  const colour = { RED: '#c0392b', YELLOW: '#b7791f', GREEN: '#2f855a', NOT_COMPARED: '#718096' };
  const rows = report.lobs.map(l => {
    if (l.status === 'MISSING') {
      return '<h2>' + l.lob + ' <small style="color:#718096">MISSING</small></h2><p>' + l.note + '</p>';
    }
    const body = l.findings.filter(f => f.verdict !== 'GREEN').map(f =>
      '<tr><td>' + f.name + '</td><td>' + esc(f.onprem) + '</td><td>' + esc(f.cloud) + '</td>' +
      '<td style="color:' + (colour[f.verdict] || '#000') + ';font-weight:600">' + f.verdict + '</td>' +
      '<td>' + esc(f.note || '') + '</td></tr>').join('');
    return '<h2>' + l.lob + '</h2>' +
      '<p>on-prem <code>' + esc(l.claims.onprem) + '</code> vs cloud <code>' + esc(l.claims.cloud) + '</code></p>' +
      (l.notCaptured.length ? '<p><em>Not captured: ' + l.notCaptured.map(esc).join('; ') + '</em></p>' : '') +
      '<table><tr><th>Field</th><th>On-prem</th><th>Cloud</th><th>Verdict</th><th>Note</th></tr>' +
      (body || '<tr><td colspan="5">No differences outside tolerance.</td></tr>') + '</table>';
  }).join('');
  return '<meta charset="utf-8"><title>On-prem vs Cloud — ' + report.tier + '</title>' +
    '<style>body{font:14px system-ui,sans-serif;margin:2rem;max-width:1100px}' +
    'table{border-collapse:collapse;width:100%;margin-bottom:2rem}' +
    'td,th{border:1px solid #e2e8f0;padding:6px 8px;text-align:left;vertical-align:top}' +
    'th{background:#f7fafc}code{background:#edf2f7;padding:1px 4px}</style>' +
    '<h1>On-prem vs Cloud comparison — ' + report.tier + '</h1>' +
    '<p>Generated ' + report.generatedAt + '</p>' +
    '<p><strong>RED ' + report.summary.red + '</strong> | YELLOW ' + report.summary.yellow +
    ' | GREEN ' + report.summary.green + ' | NOT COMPARED ' + report.summary.notCompared + '</p>' + rows;
}
const esc = (v) => String(v === undefined || v === null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

if (require.main === module) main();
module.exports = { compareSnapshots };
