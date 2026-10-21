#!/usr/bin/env node
/**
 * scripts/provisionOneIncClaims.js
 * Creates fresh ClaimCenter Cloud claims for the OneInc suite BEFORE a run, so scenarios use known-good claims
 * instead of hunting through migrated test data (per user direction 2026-10-20). Each claim is created with the SAME
 * completeFNOL call that profile's LOB e2e test uses (tests/lob/*.e2e.test.js — FNOL on cloud also sets the initial
 * reserves), then checked with helpers/oneInc/claimCheck.js (prepare mode: assigns / completes Surcharging / adds a
 * reserve if still needed) and added to the shared claim pool (<ONEINC_DIR>AutomationResultsTestDataaim-pool-<tier>.json), which the claim picker
 * hands out first. Several claims per profile let runs and payment-submitting scenarios spread across claims.
 *
 *   node scripts/provisionOneIncClaims.js [--profiles AUTO_PA,WC_PA,PROP_PA,AUTO_MI] [--count 2] [--headless]
 *   node scripts/provisionOneIncClaims.js --add PROP_PA=HO-PA-01-26-0748434   (add an existing / hand-made claim)
 *
 * TEST tier only — it creates claims.
 */
'use strict';
process.env.CC_ENV = 'cloud';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.CC_ENV = 'cloud';

const base = require('../helpers/claimCenterBase');
const { completeFNOL } = require('../helpers/fnolHelper');
const claimPicker = require('../helpers/oneInc/claimPicker');
const { checkClaim } = require('../helpers/oneInc/claimCheck');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

// Profile -> the FNOL its LOB e2e test performs (policy pool env var, policy type, loss cause, exposures).
const FNOL = {
  AUTO_PA: { policyEnvVar: 'POLICY_PA_AUTO', policyType: 'Personal Auto', state: 'PA', lossCauseCode: 'LC15', lossDescription: 'OneInc automation — PA auto collision', incidents: ['Add Vehicle'],
    exposures: [{ coverageLabel: 'Collision' }, { coverageLabel: 'Comprehensive' }] },
  AUTO_MI: { policyEnvVar: 'POLICY_MI_AUTO', policyType: 'Personal Auto', state: 'MI', lossCauseCode: 'LC15', lossDescription: 'OneInc automation — MI auto collision', incidents: ['Add Vehicle'],
    exposures: [{ coverageLabel: 'Collision' }, { coverageLabel: 'Comprehensive' }] },
  WC_PA: { policyEnvVar: 'POLICY_WC_PA', policyType: "Workers' comp", state: 'PA', lossCauseCode: 'LC07', lossDescription: 'OneInc automation — WC injury', incidents: [],
    exposures: [{ coverageLabel: "Workers' Compensation And Employers' Liability" }] },
  PROP_PA: { policyEnvVar: 'POLICY_HO_PA', policyType: "Homeowner's", state: 'PA', lossCauseCode: 'LC01', lossDescription: 'OneInc automation — HO fire loss', incidents: ['Add Property Damage'],
    exposures: [
      { coverageLabel: ['Coverage A Dwelling', 'Coverage B Other Structures', 'Coverage D Loss of Use'] },
      { coverageLabel: ['Coverage C Personal Property', 'Coverage E - Personal Liability', 'Coverage F - Medical Payments To Others'] },
    ] },
};
// Same FNOL as AUTO_PA; checkClaim then adds the lienholders and the vehicle loan.
// Aged DE / MD claims for the date-of-loss rules: DE needs exposure cause of loss LC50 (VBR.004); MD a PIP / Medical
// Payments exposure (VBR.005, VBR.015). Coverage labels are tried in order (cloud wording not yet confirmed for MD).
FNOL.AUTO_DE_OLD = { policyType: 'Personal Auto', state: 'DE', lossCauseCode: 'LC50', lossDescription: 'OneInc automation — DE auto, aged DoL (VBR.004)', incidents: ['Add Vehicle'],
  exposures: [{ coverageLabel: 'Collision' }] };
FNOL.AUTO_MD_OLD = { policyType: 'Personal Auto', state: 'MD', lossCauseCode: 'LC15', lossDescription: 'OneInc automation — MD auto, aged DoL (VBR.005/015)', incidents: ['Add Vehicle'],
  exposures: [{ coverageLabel: ['Personal Injury Protection', 'PIP', 'Medical Payments', 'Med Pay', 'Medical Benefits'] }, { coverageLabel: 'Collision' }] };
FNOL.PROP_MORT = { ...FNOL.PROP_PA, lossDescription: 'OneInc automation — HO fire loss with mortgagee' };
FNOL.AUTO_LIEN = { ...FNOL.AUTO_PA, lossDescription: 'OneInc automation — PA auto collision with lienholder' };

// Extension profiles carry their own FNOL settings (helpers/oneInc/profiles/*.js → fnol).
for (const [name, p] of Object.entries(claimPicker.PROFILES)) if (p.fnol && !FNOL[name]) FNOL[name] = p.fnol;

(async () => {
  const tier = String(process.env.CC_TIER || 'test').toLowerCase();
  if (tier !== 'test') { console.error('[Provision] creates claims — TEST tier only'); process.exit(2); }
  const profiles = String(arg('profiles', Object.keys(FNOL).join(','))).split(',').map((s) => s.trim()).filter(Boolean);
  const count = Math.max(1, Math.min(10, Number(arg('count', 2)) || 2));
  const { chromium } = require('playwright');
  let browser = await chromium.launch({ headless: Boolean(arg('headless', false)) || process.env.ONEINC_HEADLESS === '1' }) // headed by default so the run can be watched (user direction 2026-10-20);
  let page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(20000);
  const summary = [];

  // --add PROFILE=CLAIM[,PROFILE=CLAIM...]: put EXISTING claims (e.g. created by hand) into the pool instead of
  // creating new ones — each is prepared (assign / Surcharging / reserve) and checked first. Useful where FNOL
  // automation is fragile for a LOB (HO on cloud TEST, 2026-10-20).
  const adds = String(arg('add', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (adds.length) {
    await base.loginToClaimCenter(page);
    for (const a of adds) {
      const [profile, claim] = a.split('=').map((s) => (s || '').trim());
      if (!FNOL[profile] || !claim) { console.log(`[Provision] --add "${a}" ignored (use PROFILE=CLAIM, profiles: ${Object.keys(FNOL).join(', ')})`); continue; }
      const chk = await checkClaim(page, claim, { prepare: true, lienholders: /^(AUTO_LIEN|PROP_MORT)$/.test(profile), profile });
      const entry = { claim, createdAt: new Date().toISOString(), source: 'added', usable: chk.usable, payees: chk.payees.map((p) => p.name),
        payeeWithDetails: chk.payeeWithDetails, reserveLines: chk.reserveLines, repaired: chk.repaired, problem: chk.problem };
      claimPicker.addToPool(profile, entry);
      summary.push({ profile, ...entry });
      console.log(`[Provision] ${profile} added ${claim}: ${chk.usable ? 'USABLE' : 'NOT usable — ' + chk.problem}${chk.repaired.length ? ` [prepared: ${chk.repaired.join('; ')}]` : ''}`);
    }
    await browser.close();
    for (const s of summary) console.log(`[Provision] ${s.profile}: ${s.claim} ${s.usable ? 'USABLE' : 'not usable'}${s.problem ? ' — ' + s.problem : ''}`);
    console.log(`[Provision] pool: ${claimPicker.POOL_FILE}`);
    return;
  }

  // Fail fast when ClaimCenter itself can't save claims: two FNOLs in a row that die at the final save (Step 5 still
  // open / "An application error occurred") mean an environment problem, not a bad policy — every further attempt
  // would burn several minutes the same way (user report 2026-10-20: a run looked stuck in a loop). Exit code 3 tells
  // runOneInc to stop provisioning and run on existing claims.
  // Only a real server failure counts: CC's "application error" banner, or a Step-5 stall with NO message at all. A
  // named validation ("Date of hire must be before…") is a data problem the next attempt can avoid.
  const ENV_FAILURE = /application error occurred|Exception occurred|No validation text found/i;
  let envFailuresInARow = 0;
  let envDown = false;

  for (const profile of profiles) {
    if (envDown) break;
    const f = FNOL[profile];
    if (!f) { console.log(`[Provision] unknown profile ${profile} — skipped`); continue; }
    // Policies that already have a cloud TEST claim (see claimPicker.policyCandidates); a policy that fails FNOL is
    // skipped and the next one tried — at most one spare attempt per profile.
    const tried = [];
    let made = 0;
    for (let i = 1; made < count && i <= count + 3 && !envDown; i++) {
      const started = Date.now();
      let claim = null;
      const pol = claimPicker.policyCandidates(profile, { exclude: tried })[0];
      if (!pol) { console.log(`[Provision] ${profile}: no unused policy left in the TEST claim list`); break; }
      tried.push(pol.policyNumber);
      try {
        // The browser is visible, so someone may close its window mid-run ("Target page, context or browser has been
        // closed" — 2026-10-20); start a new one rather than failing every remaining attempt.
        if (!browser.isConnected()) {
          console.log('[Provision] browser window was closed — opening a new one');
          browser = await chromium.launch({ headless: Boolean(arg('headless', false)) || process.env.ONEINC_HEADLESS === '1' });
        }
        // Fresh page per claim: FNOL leaves wizard state behind, and the claim check may have switched to admin.
        await page.close().catch(() => {});
        page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
        page.setDefaultTimeout(20000);
        await base.loginToClaimCenter(page);
        const policyNumber = pol.policyNumber;
        console.log(`[Provision] ${profile} ${i}: FNOL on policy ${policyNumber}, loss date ${pol.lossDate} (day after existing claim ${pol.basedOn})`);
        claim = await completeFNOL(page, {
          policyNumber, policyType: f.policyType,
          lossDetails: { lossDate: pol.lossDate, lossState: pol.state || f.state, lossCauseCode: f.lossCauseCode, lossDescription: f.lossDescription },
          exposures: f.exposures,
          // Only the incidents the payable exposure needs — extra injury / property-damage incidents make TEST
          // auto-create exposures that fail on save for want of a claimant number (2026-10-21).
          incidents: f.incidents,
        });
        envFailuresInARow = 0;
        console.log(`[Provision] ${profile} ${i}: claim ${claim} created — checking it`);
        const chk = await checkClaim(page, claim, { prepare: true, lienholders: /^(AUTO_LIEN|PROP_MORT)$/.test(profile), profile });
        const entry = { claim, policy: policyNumber, lossDate: pol.lossDate, basedOn: pol.basedOn, createdAt: new Date().toISOString(), usable: chk.usable, payees: chk.payees.map((p) => p.name),
          payeeWithDetails: chk.payeeWithDetails, reserveLines: chk.reserveLines, repaired: chk.repaired, problem: chk.problem };
        claimPicker.addToPool(profile, entry);
        summary.push({ profile, ...entry });
        if (chk.usable) made++;
        console.log(`[Provision] ${profile} ${i}: ${claim} ${chk.usable ? 'USABLE' : 'NOT usable — ' + chk.problem}` +
          `${chk.repaired.length ? ` [prepared: ${chk.repaired.join('; ')}]` : ''} (${Math.round((Date.now() - started) / 1000)}s)`);
      } catch (e) {
        console.log(`[Provision] ${profile} ${i}: FAILED${claim ? ` (claim ${claim})` : ''} — ${e.message.split('\n')[0].slice(0, 1200)}`);
        // Evidence of the failing screen on the team share, so the reason can be shown to the app team.
        try {
          const shotDir = path.join(require('../helpers/oneInc/reportService').RESULTS_DIR, 'Screenshots', 'provisioning');
          require('fs').mkdirSync(shotDir, { recursive: true });
          const shot = path.join(shotDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${profile}_${pol.policyNumber}.png`);
          await page.screenshot({ path: shot, fullPage: true });
          console.log(`[Provision] ${profile} ${i}: screenshot ${shot}`);
        } catch (_) { /* browser may be gone */ }
        summary.push({ profile, claim, usable: false, problem: e.message.split('\n')[0] });
        if (claim) claimPicker.addToPool(profile, { claim, policy: pol.policyNumber, createdAt: new Date().toISOString(), usable: false, problem: e.message.split('\n')[0] });
        // A POLICY problem (claimant numbers used up, policy not in this tier) — remember it and try the next policy;
        // it says nothing about the environment.
        const policyProblem = /claimant number|POLICY_DATA_ERROR|CLOUD_SEARCH_EMPTY|POLICY EXHAUSTED|CLOUD_FIND_POLICY_STUCK/i.test(e.message);
        if (!claim && policyProblem) {
          claimPicker.markBadPolicy(profile, pol.policyNumber, e.message.split('\n')[0]);
          console.log(`[Provision] ${profile} ${i}: policy ${pol.policyNumber} marked unusable for new claims — trying another`);
        } else if (!claim && ENV_FAILURE.test(e.message)) {
          envFailuresInARow++;
          if (envFailuresInARow >= 2) {
            envDown = true;
            console.log('[Provision] STOPPING — ClaimCenter did not save the last 2 claims at the final step (server-side problem on this tier). No more claims will be attempted in this run.');
          }
        } else envFailuresInARow = 0;
      }
    }
  }
  await browser.close();
  console.log('[Provision] DONE');
  for (const s of summary) console.log(`[Provision] ${s.profile}: ${s.claim || '(no claim)'} ${s.usable ? 'USABLE' : 'not usable'}${s.problem ? ' — ' + s.problem : ''}`);
  console.log(`[Provision] pool: ${claimPicker.POOL_FILE}`);
  if (envDown) process.exit(3);
})().catch((e) => { console.error('[Provision] fatal:', e.stack || e.message); process.exit(1); });
