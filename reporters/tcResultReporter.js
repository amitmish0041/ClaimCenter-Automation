/**
 * reporters/tcResultReporter.js
 * Playwright custom reporter — captures per-TC results to results/tc_results.json
 * Run generateExcelReport.js after the suite to produce the Excel workbook.
 */
const fs   = require('fs');
const path = require('path');

const OUTPUT_DIR  = path.join(process.cwd(), 'results');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'tc_results.json');

function parseTitle(fullTitle) {
  const tcMatch   = fullTitle.match(/TC[-_][A-Z0-9\-]+/i);
  const ruleMatch = [...fullTitle.matchAll(/\[([A-Z0-9_]+)\]/g)].map(m => m[1]);
  const descMatch = fullTitle.match(/\]:\s*(.+)$/) || fullTitle.match(/TC[-_][A-Z0-9\-]+[:\s]+(.+)$/i);
  const tcId = tcMatch ? tcMatch[0].toUpperCase() : null;

  let featureArea = 'General';
  if (tcId) {
    if (/FNOL|PA-|HO-|WC-|BOP|CP-|CAU|BOAT|SEG|VAL|IR-/i.test(tcId))  featureArea = 'FNOL';
    else if (/FIN/i.test(tcId))                                           featureArea = 'Financials';
    else if (/AR-/i.test(tcId))                                           featureArea = 'ApprovalRouting';
    else if (/SEG|WP-|CL-|RO-|ARC/i.test(tcId))                          featureArea = 'ClaimLifecycle';
  }
  return {
    tcId       : tcId || 'UNKNOWN',
    rules      : ruleMatch.length ? ruleMatch : ['—'],
    description: descMatch ? descMatch[1].trim() : fullTitle,
    featureArea,
  };
}

function fmtDuration(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

class TcResultReporter {
  constructor() {
    this.results   = [];
    this.startTime = Date.now();
  }

  onBegin() {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log('\n TC Result Reporter active -> ' + OUTPUT_JSON + '\n');
  }

  onTestEnd(test, result) {
    const fullTitle = test.titlePath().join(' > ');
    const meta      = parseTitle(fullTitle);

    let errorMessage = '';
    let errorStep    = '';
    if (result.status === 'failed' || result.status === 'timedOut') {
      const err = result.errors?.[0];
      if (err) {
        errorMessage = (err.message || '').split('\n')[0].slice(0, 300);
        const stackLine = (err.stack || '').split('\n').find(l => l.includes('.test.js') || l.includes('Helper'));
        errorStep = stackLine ? stackLine.trim().slice(0, 200) : '';
      }
    }

    const statusMap = { passed: 'PASS', failed: 'FAIL', timedOut: 'FAIL - Timeout', skipped: 'SKIPPED', interrupted: 'SKIPPED' };

    this.results.push({
      tcId        : meta.tcId,
      featureArea : meta.featureArea,
      description : meta.description,
      rules       : meta.rules.join(', '),
      status      : statusMap[result.status] || result.status.toUpperCase(),
      duration    : fmtDuration(result.duration),
      durationMs  : result.duration || 0,
      retries     : result.retry || 0,
      errorMessage,
      errorStep,
      project     : test.parent?.project?.name || '',
      file        : test.location?.file?.split('/').pop() || '',
      runAt       : new Date().toISOString(),
    });
  }

  onEnd() {
    const total   = this.results.length;
    const passed  = this.results.filter(r => r.status === 'PASS').length;
    const failed  = this.results.filter(r => r.status.startsWith('FAIL')).length;
    const skipped = this.results.filter(r => r.status === 'SKIPPED').length;
    const elapsed = fmtDuration(Date.now() - this.startTime);

    const output = {
      meta: {
        suiteName   : 'ClaimCenter Automation - ' + new Date().toLocaleString(),
        generatedAt : new Date().toISOString(),
        totalElapsed: elapsed,
        summary     : { total, passed, failed, skipped },
        passRate    : total > 0 ? Math.round((passed / total) * 100) + '%' : '—',
      },
      results: this.results,
    };

    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));

    console.log('\n' + '='.repeat(55));
    console.log('  TC RESULTS SUMMARY');
    console.log('='.repeat(55));
    console.log('  Total    : ' + total);
    console.log('  PASS     : ' + passed);
    console.log('  FAIL     : ' + failed);
    console.log('  SKIP     : ' + skipped);
    console.log('  Pass Rate: ' + output.meta.passRate);
    console.log('  Duration : ' + elapsed);
    console.log('='.repeat(55));
    console.log('  JSON -> ' + OUTPUT_JSON);
    console.log('  Run: node reporters/generateExcelReport.js');
    console.log('='.repeat(55) + '\n');
  }
}

module.exports = TcResultReporter;
