/**
 * reporters/emailReporter.js
 * Playwright reporter — sends an HTML summary email after every test run.
 *
 * Required env vars (skip email silently if missing):
 *   EMAIL_SMTP_HOST   SMTP server hostname  (e.g. smtp.office365.com)
 *   EMAIL_SMTP_USER   SMTP auth username
 *   EMAIL_SMTP_PASS   SMTP auth password
 *
 * Optional env vars:
 *   EMAIL_SMTP_PORT   Default: 587
 *   EMAIL_TO          Comma-separated recipients  (default: amitmishra@donegalgroup.com)
 *   EMAIL_FROM        Sender address (default: EMAIL_SMTP_USER)
 *   CC_ENV            Shown in the email subject (onprem | cloud)
 */

'use strict';

let nodemailer;
try { nodemailer = require('nodemailer'); } catch (_) { /* not installed */ }

// ── LOB tag helpers ───────────────────────────────────────────────────────────

const LOB_PATTERNS = [
  { tag: 'PA Auto',       re: /PA.Auto|E2E-PA|FNOL-PA-PA|FNOL-PA-MI|TC-FIN|TC-SEG|TC-WP|TC-CL|TC-RO|TC-ARC|TC-AR-0[0136]/i },
  { tag: 'Homeowners',    re: /Homeowners|HO.E2E|E2E-HO|FNOL-HO|TC-WP-005|TC-IR-001|TC-SEG-003/i },
  { tag: 'Workers Comp',  re: /Workers.Comp|WC.E2E|E2E-WC|FNOL-WC|TC-AR-002|TC-AR-060/i },
  { tag: 'BOP',           re: /BOP.E2E|E2E-BOP|FNOL-BOP/i },
  { tag: 'Comm. Package', re: /Commercial.Package|CP.E2E|E2E-CP|FNOL-CP|TC-AR-06[23]|TC-AR-07[4567]/i },
  { tag: 'Comm. Auto',    re: /Commercial.Auto|CA.E2E|E2E-CA|FNOL-CAU/i },
];

function lobTag(title) {
  for (const { tag, re } of LOB_PATTERNS) {
    if (re.test(title)) return tag;
  }
  return 'General';
}

function phaseTag(suitePath) {
  const s = suitePath.join(' > ');
  if (/FNOL/i.test(s))             return 'FNOL';
  if (/Financials/i.test(s))       return 'Financials';
  if (/Approval.Routing/i.test(s)) return 'Approval';
  if (/Lifecycle/i.test(s))        return 'Lifecycle';
  if (/E2E/i.test(s))              return 'E2E';
  return 'Other';
}

// ── Colour constants ──────────────────────────────────────────────────────────

const C = {
  pass  : '#2f855a',
  fail  : '#c53030',
  skip  : '#718096',
  bg    : '#f7fafc',
  hdr   : '#1a365d',
  border: '#e2e8f0',
  row   : '#ffffff',
  rowAlt: '#f7fafc',
};

// ── HTML email builder ────────────────────────────────────────────────────────

function buildHtml({ results, totals, suiteSummary, lobSummary, durationMs, env, runAt }) {
  const duration = formatDuration(durationMs);
  const passRate  = totals.total > 0 ? Math.round((totals.passed / totals.total) * 100) : 0;
  const barColor  = passRate >= 90 ? C.pass : passRate >= 70 ? '#d69e2e' : C.fail;
  // Platform alone is ambiguous now that each platform has a test AND a dev
  // instance - a report saying only "ONPREM" doesn't say which one ran.
  const envLabel  = (env || process.env.CC_ENV || 'onprem').toUpperCase()
                  + ' / ' + (process.env.CC_TIER || 'test').toUpperCase();

  const chipStyle = (bg) =>
    `display:inline-block;padding:3px 10px;border-radius:12px;font-size:13px;font-weight:700;color:#fff;background:${bg};margin-right:6px;`;

  const thStyle = `padding:8px 12px;background:${C.hdr};color:#fff;font-size:12px;text-transform:uppercase;letter-spacing:.5px;text-align:left;`;
  const td      = (val, color) =>
    `<td style="padding:7px 12px;border-bottom:1px solid ${C.border};${color ? `color:${color};font-weight:700;` : ''}">${val}</td>`;

  // Suite breakdown rows
  const suiteRows = Object.entries(suiteSummary)
    .sort(([, a], [, b]) => (b.failed - a.failed))
    .map(([name, s], i) => {
      const bg = i % 2 === 0 ? C.row : C.rowAlt;
      const failColor = s.failed > 0 ? C.fail : '';
      return `<tr style="background:${bg}">
        ${td(name)}
        ${td(s.passed, s.passed > 0 ? C.pass : '')}
        ${td(s.failed, failColor)}
        ${td(s.skipped, s.skipped > 0 ? C.skip : '')}
      </tr>`;
    }).join('');

  // LOB breakdown rows
  const lobRows = Object.entries(lobSummary)
    .sort(([, a], [, b]) => (b.failed - a.failed))
    .map(([lob, s], i) => {
      const bg = i % 2 === 0 ? C.row : C.rowAlt;
      const status = s.failed > 0 ? '❌ FAIL' : s.passed > 0 ? '✅ PASS' : '⏭ SKIP';
      const statusColor = s.failed > 0 ? C.fail : s.passed > 0 ? C.pass : C.skip;
      return `<tr style="background:${bg}">
        ${td(`<strong>${lob}</strong>`)}
        ${td(s.passed, s.passed > 0 ? C.pass : '')}
        ${td(s.failed, s.failed > 0 ? C.fail : '')}
        ${td(s.skipped, s.skipped > 0 ? C.skip : '')}
        ${td(status, statusColor)}
      </tr>`;
    }).join('');

  // Failed test cards
  const failCards = results
    .filter(r => r.status === 'failed' || r.status === 'timedOut')
    .map(r => {
      const err = (r.error || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `
      <div style="background:#fff5f5;border-left:4px solid ${C.fail};padding:10px 14px;margin-bottom:10px;border-radius:0 4px 4px 0;">
        <div style="font-weight:700;color:${C.fail};margin-bottom:4px;">${escHtml(r.title)}</div>
        <div style="font-size:11px;color:#718096;margin-bottom:6px;">${r.suitePath.slice(1).join(' › ')}</div>
        ${err ? `<pre style="margin:0;font-size:11px;color:#744210;white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow:hidden;">${err}</pre>` : ''}
      </div>`;
    }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>CC Test Run — ${envLabel}</title></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#edf2f7;">
<div style="max-width:720px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.12);">

  <!-- Header -->
  <div style="background:${C.hdr};padding:24px 28px;">
    <div style="font-size:20px;font-weight:700;color:#fff;letter-spacing:.5px;">ClaimCenter Automation</div>
    <div style="font-size:13px;color:#90cdf4;margin-top:4px;">Test Run Report · ${envLabel} · ${runAt}</div>
  </div>

  <!-- Summary bar -->
  <div style="padding:20px 28px 0;">
    <div style="margin-bottom:12px;">
      <span style="${chipStyle(C.pass)}">${totals.passed} PASS</span>
      <span style="${chipStyle(C.fail)}">${totals.failed} FAIL</span>
      <span style="${chipStyle(C.skip)}">${totals.skipped} SKIP</span>
      <span style="font-size:13px;color:#4a5568;">${passRate}% · ${duration} · ${totals.total} total</span>
    </div>
    <div style="background:${C.border};border-radius:4px;height:8px;overflow:hidden;">
      <div style="height:100%;width:${passRate}%;background:${barColor};transition:width .3s;"></div>
    </div>
  </div>

  <!-- LOB Breakdown -->
  <div style="padding:20px 28px 0;">
    <div style="font-size:14px;font-weight:700;color:${C.hdr};margin-bottom:10px;">LOB Coverage</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr>
        <th style="${thStyle}">LOB</th>
        <th style="${thStyle}">Pass</th>
        <th style="${thStyle}">Fail</th>
        <th style="${thStyle}">Skip</th>
        <th style="${thStyle}">Status</th>
      </tr></thead>
      <tbody>${lobRows || '<tr><td colspan="5" style="padding:8px 12px;color:#718096;">No LOB data</td></tr>'}</tbody>
    </table>
  </div>

  <!-- Suite Breakdown -->
  <div style="padding:20px 28px 0;">
    <div style="font-size:14px;font-weight:700;color:${C.hdr};margin-bottom:10px;">Suite Breakdown</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr>
        <th style="${thStyle}">Suite</th>
        <th style="${thStyle}">Pass</th>
        <th style="${thStyle}">Fail</th>
        <th style="${thStyle}">Skip</th>
      </tr></thead>
      <tbody>${suiteRows || '<tr><td colspan="4" style="padding:8px 12px;color:#718096;">No data</td></tr>'}</tbody>
    </table>
  </div>

  ${failCards ? `
  <!-- Failures -->
  <div style="padding:20px 28px 0;">
    <div style="font-size:14px;font-weight:700;color:${C.fail};margin-bottom:10px;">Failed Tests (${totals.failed})</div>
    ${failCards}
  </div>` : ''}

  <!-- Footer -->
  <div style="padding:20px 28px;margin-top:16px;border-top:1px solid ${C.border};text-align:center;">
    <div style="font-size:11px;color:#a0aec0;">
      Generated by Playwright Automation · Donegal Group ClaimCenter<br>
      ${runAt} · Workers: ${process.env.npm_config_workers || '2'} · Retries: 0
    </div>
  </div>

</div>
</body>
</html>`;
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function formatDuration(ms) {
  if (ms < 60000)  return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

// ── Reporter class ────────────────────────────────────────────────────────────

class EmailReporter {
  constructor(options = {}) {
    this._to      = options.to      || process.env.EMAIL_TO   || 'amitmishra@donegalgroup.com';
    this._from    = options.from    || process.env.EMAIL_FROM  || process.env.EMAIL_SMTP_USER || 'automation@donegalgroup.com';
    this._results = [];
    this._start   = null;
  }

  onBegin() {
    this._start = Date.now();
  }

  onTestEnd(test, result) {
    const err = result.error
      ? (result.error.message || '') + (result.error.stack ? '\n' + result.error.stack.split('\n').slice(0, 5).join('\n') : '')
      : null;
    this._results.push({
      title    : test.title,
      suitePath: test.titlePath(),
      status   : result.status,    // passed | failed | timedOut | skipped | interrupted
      duration : result.duration,
      error    : err ? err.slice(0, 600) : null,
    });
  }

  async onEnd() {
    const smtpHost = process.env.EMAIL_SMTP_HOST;
    if (!smtpHost) {
      console.log('[EmailReporter] EMAIL_SMTP_HOST not set — skipping email notification');
      return;
    }
    if (!nodemailer) {
      console.warn('[EmailReporter] nodemailer not installed — run: npm install nodemailer');
      return;
    }

    const results = this._results;
    const durationMs = Date.now() - (this._start || Date.now());

    // Totals
    const totals = { total: results.length, passed: 0, failed: 0, skipped: 0 };
    for (const r of results) {
      if (r.status === 'passed')                       totals.passed++;
      else if (r.status === 'failed' || r.status === 'timedOut') totals.failed++;
      else                                             totals.skipped++;
    }

    // Suite summary — keyed by top describe name
    const suiteSummary = {};
    for (const r of results) {
      // titlePath: [file, ...describes, testTitle] — use first describe as suite name
      const suite = r.suitePath[1] || r.suitePath[0] || 'Root';
      if (!suiteSummary[suite]) suiteSummary[suite] = { passed: 0, failed: 0, skipped: 0 };
      const s = suiteSummary[suite];
      if (r.status === 'passed')                              s.passed++;
      else if (r.status === 'failed' || r.status === 'timedOut') s.failed++;
      else                                                    s.skipped++;
    }

    // LOB summary
    const lobSummary = {};
    for (const r of results) {
      const lob = lobTag(r.suitePath.join(' > ') + ' ' + r.title);
      if (!lobSummary[lob]) lobSummary[lob] = { passed: 0, failed: 0, skipped: 0 };
      const l = lobSummary[lob];
      if (r.status === 'passed')                              l.passed++;
      else if (r.status === 'failed' || r.status === 'timedOut') l.failed++;
      else                                                    l.skipped++;
    }

    const env    = process.env.CC_ENV || 'onprem';
    const tier   = process.env.CC_TIER || 'test';
    const runAt  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
    // Tier in the subject: four instances now exist, and two reports reading
    // "ONPREM" could otherwise be from different environments.
    const subject = `[${totals.failed > 0 ? 'FAIL' : 'PASS'}] CC Automation — ${env.toUpperCase()}/${tier.toUpperCase()} · ${totals.passed}/${totals.total} · ${runAt}`;

    const html = buildHtml({ results, totals, suiteSummary, lobSummary, durationMs, env, runAt });

    try {
      // Only send an auth block when credentials actually exist. The internal
      // relay (smtp.donegalgroup.com:25) accepts unauthenticated mail and
      // advertises no AUTH, so passing auth:{user:undefined,pass:undefined}
      // makes nodemailer attempt authentication and fail. The Commercial Line
      // project's reporter omits auth entirely for this same relay.
      const smtpUser = process.env.EMAIL_SMTP_USER;
      const smtpPass = process.env.EMAIL_SMTP_PASS;
      const transporter = nodemailer.createTransport({
        host  : smtpHost,
        port  : parseInt(process.env.EMAIL_SMTP_PORT || '587', 10),
        secure: false,
        ...(smtpUser && smtpPass ? { auth: { user: smtpUser, pass: smtpPass } } : {}),
        tls   : { rejectUnauthorized: false },
      });

      await transporter.sendMail({
        from   : this._from,
        to     : this._to,
        subject,
        html,
      });

      console.log(`[EmailReporter] Report sent to ${this._to} — "${subject}"`);
    } catch (err) {
      console.error('[EmailReporter] Failed to send email:', err.message);
    }
  }
}

module.exports = EmailReporter;
