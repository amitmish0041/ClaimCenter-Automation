#!/usr/bin/env node
/**
 * scripts/scoutOneIncClaims.js
 * Finds usable test claims for the OneInc suite, read-only. For each claim profile (helpers/oneInc/claimPicker.js)
 * it walks candidate claims and records, per claim: does it open, does the New Payment wizard open (no "Ability to
 * Pay" validation errors), which payees it offers, whether each payee has payment contact details (CC shows "Payees
 * other than vendor should have the payment contact details set up" when not — that decides the ClaimsPay default
 * scenarios), and whether any reserve line has open Available Reserves. The best claim per profile is remembered for
 * the next OneInc run (<ONEINC_DIR>AutomationResultsTestDataaims-<tier>.json) and the full findings are written next to it.
 *
 *   node scripts/scoutOneIncClaims.js [--profiles AUTO_PA,WC_PA,PROP_PA,AUTO_MI] [--per 10] [--prepare] [--headless]
 *
 * Read-only by default: every wizard is cancelled. --prepare (TEST tier only, approved 2026-10-20) also completes a
 * claim's unfinished Surcharging screen (each exception answered "No") when that is what blocks New Payment.
 * Claims the standard user may not view are opened with the admin login (CC_ADMIN_USER).
 */
'use strict';
process.env.CC_ENV = 'cloud';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.CC_ENV = 'cloud';

const base = require('../helpers/claimCenterBase');
const claimPicker = require('../helpers/oneInc/claimPicker');
const { checkClaim } = require('../helpers/oneInc/claimCheck');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

// The per-claim check lives in helpers/oneInc/claimCheck.js (shared with scripts/provisionOneIncClaims.js).
const scoutClaim = (page, claim, opts) => checkClaim(page, claim, opts);

(async () => {
  const tier = String(process.env.CC_TIER || 'test').toLowerCase();
  const profiles = String(arg('profiles', Object.keys(claimPicker.PROFILES).join(','))).split(',').map((s) => s.trim()).filter(Boolean);
  const per = Number(arg('per', 8)) || 8;
  // --prepare WRITES to TEST claims (completes Surcharging). Never on another tier.
  const prepare = Boolean(arg('prepare', false));
  if (prepare && tier !== 'test') { console.error('[Scout] --prepare is only allowed on the TEST tier'); process.exit(2); }
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: Boolean(arg('headless', false)) || process.env.ONEINC_HEADLESS === '1' }) // headed by default so the run can be watched (user direction 2026-10-20);
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(20000);
  await base.loginToClaimCenter(page);

  const report = { tier, scoutedAt: new Date().toISOString(), profiles: {} };
  for (const profile of profiles) {
    const cands = claimPicker.candidates(profile, per, { ignorePinned: true });
    console.log(`[Scout] ${profile}: ${cands.length} candidate claim(s)`);
    const rows = [];
    for (const claim of cands) {
      const r = await scoutClaim(page, claim, { prepare });
      rows.push(r);
      console.log(`[Scout] ${profile} ${claim}: ${r.usable ? 'USABLE' : 'not usable'}${r.repaired.length ? ` [prepared: ${r.repaired.join('; ')}]` : ''} — payees ${r.payees.length}` +
        ` (with contact details: ${r.payees.filter((p) => p.contactDetails).map((p) => p.name).join(', ') || 'none'})` +
        `, open reserve ${r.openReserve ? 'yes' : 'no'}${r.problem ? ' — ' + r.problem : ''}`);
      // Enough once we have a usable claim that also has a payee with contact details.
      if (r.usable && r.payeeWithDetails) break;
    }
    const best = rows.find((r) => r.usable && r.payeeWithDetails) || rows.find((r) => r.usable) || null;
    report.profiles[profile] = { best: best ? best.claim : null, payeeWithDetails: best ? best.payeeWithDetails : null, claims: rows };
    if (best) claimPicker.remember(profile, best.claim);
    console.log(`[Scout] ${profile}: BEST ${best ? best.claim + (best.payeeWithDetails ? ` (payee with contact details: ${best.payeeWithDetails})` : ' (no payee with contact details)') : 'none found'}`);
  }
  await browser.close();
  const file = path.join(path.dirname(claimPicker.CACHE_FILE), `scout-${tier}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`[Scout] findings: ${file}`);
  for (const [p, v] of Object.entries(report.profiles)) console.log(`[Scout] ONEINC_CLAIM_${p}=${v.best || '(none)'}`);
})().catch((e) => { console.error('[Scout] fatal:', e.stack || e.message); process.exit(1); });
