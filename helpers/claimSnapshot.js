/**
 * helpers/claimSnapshot.js
 *
 * Captures a structured, environment-neutral snapshot of a claim so the SAME
 * claim scenario run on on-prem and on cloud can be diffed field by field.
 * This is the data layer for the paired-environment comparison in the Cloud
 * Upgrade Testing Strategy (Tier 1 / Tier 3 "compareBusinessOutcomes").
 *
 * WHY A FILE-BASED SNAPSHOT RATHER THAN runOnBothEnvironments():
 * IS_ON_PREM is resolved from CC_ENV when claimCenterBase is imported, and the
 * platform branch is baked into every helper at that point. A single process
 * therefore cannot drive both environments - the strategy doc's in-process
 * runOnBothEnvironments(testCase) is not implementable against this codebase
 * without a rewrite of the platform switch. Instead each env run writes its own
 * snapshot and scripts/compareEnvironments.js diffs the two, which is the same
 * shape as the CI pipeline's compareResults.js step.
 *
 * The snapshot deliberately records WHAT WAS OBSERVED, including absences: a
 * field that could not be read is recorded as null with a note, never silently
 * skipped, because a missing value that reads as "match" is worse than no
 * comparison at all.
 */
const fs = require('fs');
const path = require('path');
const { IS_ON_PREM } = require('./claimCenterBase');

const SNAPSHOT_ROOT = path.join(__dirname, '..', 'results', 'snapshots');

// ── readers ─────────────────────────────────────────────────────────────────
// Cloud renders LiveView grids as id-addressed cells (…ExposuresLV-<n>-<Col>);
// on-prem is ExtJS (.x-grid-row / .x-grid-cell). Both are read into the same
// shape so the comparer never has to know which environment produced a file.

async function readExposuresCloud(page) {
  return page.evaluate(() => {
    const rows = {};
    for (const el of document.querySelectorAll('[id*="ExposuresLV-"]')) {
      const m = el.id.match(/ExposuresLV-(\d+)-([A-Za-z]+)$/);
      if (!m || !el.offsetParent) continue;
      const [, idx, col] = m;
      const text = (el.innerText || '').trim();
      if (!text) continue;
      rows[idx] = rows[idx] || {};
      rows[idx][col] = text;
    }
    return Object.keys(rows).sort((a, b) => a - b).map(k => rows[k]);
  }).catch(() => []);
}

async function readExposuresOnPrem(page) {
  return page.evaluate(() => {
    // Scope to the exposures grid. `tr.x-grid-row` unscoped also matches the
    // claim's LEFT NAVIGATION tree, which ExtJS renders as a grid too - every
    // on-prem snapshot captured so far therefore led with 15-18 phantom
    // "exposures" reading {"Name":"Summary"}, {"Name":"Workplan"}, ... before
    // the two real rows. That made exposures.count (17 on-prem vs 5 on cloud)
    // a comparison of navigation menus, and exposures[0..n] diffs pure noise.
    // The real grid is ClaimExposures:ClaimExposuresScreen:ExposuresLV on the
    // Exposures page and ...ClaimSummaryExposuresLV on the WC-style Summary
    // page; both contain "ExposuresLV".
    const grids = [...document.querySelectorAll('[id*="ExposuresLV"]')]
      .filter(g => g.offsetParent && g.querySelector('tr.x-grid-row'));
    // Prefer the innermost matching grid (the outer panel also matches the id).
    const grid = grids.length
      ? grids.reduce((best, g) => (best && best.contains(g) ? g : best || g), null)
      : null;

    const headerScope = grid && grid.closest('[id*="ExposuresLV"]') || document;
    let headers = [...headerScope.querySelectorAll('.x-column-header-text')]
      .map(h => (h.textContent || '').trim()).filter(Boolean);
    if (!headers.length) {
      headers = [...document.querySelectorAll('.x-column-header-text')]
        .map(h => (h.textContent || '').trim()).filter(Boolean);
    }

    const rowScope = grid || document;
    const out = [];
    for (const row of rowScope.querySelectorAll('tr.x-grid-row')) {
      if (!row.offsetParent) continue;
      const cells = [...row.querySelectorAll('.x-grid-cell')]
        .map(c => (c.textContent || '').trim());
      if (!cells.some(Boolean)) continue;
      const rec = {};
      // Rows can carry a leading checkbox cell with no header, so align from
      // the end rather than assuming a 1:1 header/cell mapping.
      const offset = cells.length - headers.length;
      headers.forEach((h, i) => {
        const v = cells[i + (offset > 0 ? offset : 0)];
        if (v) rec[h.replace(/\s+/g, '')] = v;
      });
      // Second guard, independent of the scoping above: a real exposure row
      // always carries at least one of these columns. A nav-tree row yields
      // only {Name: "..."} and is dropped here even if the grid lookup missed.
      if (!('Claimant' in rec || 'Coverage' in rec || 'Type' in rec)) continue;
      if (Object.keys(rec).length) out.push(rec);
    }
    return out;
  }).catch(() => []);
}

async function readFinancialsCloud(page) {
  return page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('[id*="FinancialsSummaryLV-"]')) {
      const m = el.id.match(/FinancialsSummaryLV-(\d+)-([A-Za-z]+)$/);
      if (!m || !el.offsetParent) continue;
      const text = (el.innerText || '').trim();
      if (!/^\$?[\d,.\-]+$/.test(text)) continue;
      out[m[2] + '_row' + m[1]] = text;
    }
    return out;
  }).catch(() => ({}));
}

async function readClaimHeader(page) {
  return page.evaluate(() => {
    // Scan for label POSITIONS rather than using a regex. The header is one
    // run of text ("Pol: … Claim: … Ins: … DoL: … St: … Adj: …"), some labels
    // are absent per LOB (Clmt: only appears on WC-style claims), and the last
    // field has no following label to anchor on - per-field regexes returned
    // null for claimant and adjuster, and a lookahead pattern swallowed the
    // whole run into the first field. Positions are unambiguous.
    const LABELS = ['Pol', 'Claim', 'Ins', 'Clmt', 'DoL', 'St', 'Adj'];
    const KEY = { Pol: 'policy', Claim: 'claim', Ins: 'insured', Clmt: 'claimant',
                  DoL: 'lossDate', St: 'status', Adj: 'adjuster' };
    // Scan the collapsed body text: on cloud these labels are separate
    // elements and do NOT share one innerText line, so a line-based lookup
    // finds nothing at all. The trailing field is bounded explicitly below.
    const run = (document.body.innerText || '').replace(/\s+/g, ' ');
    const out = {};
    for (const L of LABELS) out[KEY[L]] = null;
    const start = run.indexOf('Pol:');
    if (start < 0) return out;
    const found = [];
    for (const L of LABELS) {
      const i = run.indexOf(L + ':', start);
      if (i >= 0 && i < start + 400) found.push({ label: L, at: i });
    }
    found.sort((x, y) => x.at - y.at);
    for (let k = 0; k < found.length; k++) {
      const { label, at } = found[k];
      // The LAST label has no following label to stop at, so without an
      // explicit bound it swallowed the exposures grid that follows the header.
      let end = k + 1 < found.length ? found[k + 1].at : run.length;
      let value = run.slice(at + label.length + 1, end).trim();
      if (k + 1 === found.length) {
        const stop = ['Summary', 'Exposures', 'Workplan', 'Basics', 'Actions']
          .map(w => value.indexOf(w)).filter(i => i > 0).sort((x, y) => x - y)[0];
        if (stop !== undefined) value = value.slice(0, stop).trim();
        const paren = value.indexOf(')');
        if (paren > 0) value = value.slice(0, paren + 1);
        value = value.slice(0, 60).trim();
      }
      out[KEY[label]] = value || null;
    }
    return out;
  }).catch(() => ({}));
}

// Validation text is a first-class observation: a claim that only differs by
// which rules objected is exactly the kind of divergence this exercise exists
// to surface.
async function readValidation(page) {
  return page.evaluate(() => {
    const p = document.getElementById('gw-south-panel');
    if (p && p.offsetParent) {
      return (p.innerText || '').replace(/\s+/g, ' ')
        .replace(/^\s*Validation Results\s*/i, '').replace(/^\s*Clear\s*/i, '').trim().slice(0, 400);
    }
    const banner = [...document.querySelectorAll('[class*="message"], [class*="error"]')]
      .filter(e => e.offsetParent)
      .map(e => (e.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)[0];
    return banner ? banner.slice(0, 400) : '';
  }).catch(() => '');
}

// ── capture ─────────────────────────────────────────────────────────────────

/**
 * Captures the claim currently open in `page`.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} meta - { lob, claimNumber, policyNumber, testCase }
 * @returns {Promise<object>} the snapshot (also written to disk)
 */
async function captureClaimSnapshot(page, meta = {}) {
  const env = IS_ON_PREM ? 'onprem' : 'cloud';
  const tier = (process.env.CC_TIER || 'test').toLowerCase();

  const header = await readClaimHeader(page);
  const exposures = IS_ON_PREM ? await readExposuresOnPrem(page) : await readExposuresCloud(page);
  // The Financials grid only exists on the Financials page. Capture runs from
  // the claim page, so an empty result here means NOT LOADED, not "no money" -
  // record which it is rather than emitting {} and letting the comparer read
  // that as agreement.
  const financials = IS_ON_PREM ? {} : await readFinancialsCloud(page);
  const financialsLoaded = Object.keys(financials).length > 0;
  const validation = await readValidation(page);

  const snapshot = {
    meta: {
      env, tier,
      lob: meta.lob || 'UNKNOWN',
      testCase: meta.testCase || null,
      claimNumber: meta.claimNumber || header.claim || null,
      policyNumber: meta.policyNumber || header.policy || null,
      capturedAt: new Date().toISOString(),
    },
    header,
    exposures,
    financials,
    validation: validation || null,
    // Anything the reader could not obtain is named here rather than dropped,
    // so the comparer can report "not captured" instead of "identical".
    notCaptured: [
      ...(IS_ON_PREM ? ['financials (on-prem financials grid reader not implemented)'] : []),
      ...(!IS_ON_PREM && !financialsLoaded
        ? ['financials (Financials page was not open at capture time)'] : []),
      'ruleExecutionLog (requires Gosu/server log access - not available to the UI automation)',
      'glPostings (requires DB access to posting_detail / gl_account_balance)',
    ],
  };

  const dir = path.join(SNAPSHOT_ROOT, env + '-' + tier);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, (snapshot.meta.lob || 'UNKNOWN') + '.json');
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log('claimSnapshot: wrote ' + path.relative(process.cwd(), file) +
              ' (' + exposures.length + ' exposure(s))');
  return snapshot;
}

module.exports = { captureClaimSnapshot, SNAPSHOT_ROOT };
