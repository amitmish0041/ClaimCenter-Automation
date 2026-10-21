/**
 * helpers/oneInc/claimPicker.js
 * Chooses the existing ClaimCenter Cloud claim each OneInc scenario runs against. Every OneInc test design starts
 * with "create the policy in PolicyCenter and create a claim"; this suite satisfies that precondition with a real
 * existing claim of the right line/state instead (it never creates claims), and every result records which claim
 * it used.
 *
 * Candidates: claims the suite created (the shared claim pool, scripts/provisionOneIncClaims.js), then claims from the
 * SQL-extracted TEST claim list (helpers/smartComm/testDataService.js), filtered per profile. A claim that worked is
 * remembered and tried first next time. The pool and the remembered claims live on the TEAM SHARE
 * (<ONEINC_DIR>\AutomationResults\TestData) so every teammate uses the same claims; the claim list is read from
 * V:\Amit Int\SmartComm\data unless SMARTCOMM_DATA_DIR says otherwise. Pin a claim per profile with
 * ONEINC_CLAIM_<PROFILE> (e.g. ONEINC_CLAIM_WC_PA=WC-PA-01-26-0748037).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PROFILES = {
  AUTO_PA: { label: 'PA personal auto (vehicle exposure, open reserve)', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, seed: ['PA-PA-01-26-0748059'] },
  AUTO_MI: { label: 'MI auto', lob: 'AUTO', state: 'MI', prefix: /^(PA|CA)-MI-/ },
  WC_PA: { label: 'PA workers comp', lob: 'WC', state: 'PA', prefix: /^WC-PA-/ },
  PROP_PA: { label: 'PA homeowners / property', lob: 'PR', state: 'PA', prefix: /^HO-PA-/ },
  // PA auto claim carrying two Lienholder/Mortgagee contacts and a loan on the vehicle (set up by claimCheck's
  // `lienholders` prepare). Pool only — an arbitrary claim from the test-data sheet has no lienholder.
  AUTO_LIEN: { label: 'PA personal auto with lienholders + vehicle loan', lob: 'AUTO', state: 'PA', prefix: /^PA-PA-/, poolOnly: true, fnolAs: 'AUTO_PA' },
};

const TIER = (process.env.CC_TIER || 'test').toLowerCase();
// Shared state on the team share (no per-machine paths): <ONEINC_RESULTS_DIR>TestData.
const STATE_DIR = path.join(require('./reportService').RESULTS_DIR, 'TestData');
const CACHE_FILE = path.join(STATE_DIR, `claims-${TIER}.json`);

function readCache() { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { return {}; } }
function remember(profile, claim) {
  const c = readCache();
  c[profile] = claim;
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));
}
function forget(profile, claim) {
  const c = readCache();
  if (c[profile] === claim) { delete c[profile]; fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); }
}

let records = null;
function allRecords() {
  if (records) return records;
  // The TEST claim list lives on the team share; SmartCOMM's own default is a personal folder, so point it at V: for
  // OneInc runs unless the environment already says where it is.
  if (!process.env.SMARTCOMM_DATA_DIR) process.env.SMARTCOMM_DATA_DIR = path.join('V:', 'Amit Int', 'SmartComm', 'data');
  try { records = require('../smartComm/testDataService').getAllRecords(); } catch (_) { records = []; }
  return records;
}

// ── Claim pool ──────────────────────────────────────────────────────────────────────────────────────────────────
// Claims created for the suite by scripts/provisionOneIncClaims.js (fresh FNOL per profile, verified usable). They
// come first, so runs use known-good claims instead of hunting through migrated data (per user direction 2026-10-20:
// create the claims the scenarios need upfront).
const POOL_FILE = path.join(STATE_DIR, `claim-pool-${TIER}.json`);
function readPool() { try { return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); } catch (_) { return {}; } }
function addToPool(profile, entry) {
  const pool = readPool();
  const prev = (pool[profile] || []).find((e) => e.claim === entry.claim) || {};
  pool[profile] = (pool[profile] || []).filter((e) => e.claim !== entry.claim).concat({ ...prev, ...entry }); // keep policy/lossDate on re-check
  fs.mkdirSync(path.dirname(POOL_FILE), { recursive: true });
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
}
// A policy FNOL can't use (claimant numbers exhausted, not in this environment, …) — remembered on the share so no
// later run tries it again.
function markBadPolicy(profile, policy, reason) {
  const pool = readPool();
  pool._badPolicies = (pool._badPolicies || []).filter((b) => b.policy !== policy).concat({ profile, policy, reason: String(reason).slice(0, 300), at: new Date().toISOString() });
  fs.mkdirSync(path.dirname(POOL_FILE), { recursive: true });
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
}
function poolClaims(profile) {
  return (readPool()[profile] || []).filter((e) => e.usable).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((e) => e.claim);
}

// Policies to file NEW claims on (scripts/provisionOneIncClaims.js). Per user direction 2026-10-20: use policies from
// the TEST claim list (SMARTCOMM_DATA_DIR\Test Data\ClaimsCreatedLast3YrsInTest_*.xlsx) — they already carry a cloud
// claim, so they exist in this environment — and file the new claim the day after that claim's loss date, which keeps
// the loss inside the policy term (never later than today). One entry per policy, newest claim first, skipping
// policies the pool already used. Returns [{ policyNumber, lossDate: 'MM/DD/YYYY', state, basedOn }].
function policyCandidates(profile, { exclude = [] } = {}) {
  const p = PROFILES[profile];
  if (!p) throw new Error(`unknown claim profile "${profile}"`);
  const pool = readPool();
  const used = new Set([...exclude, ...(pool[profile] || []).map((e) => e.policy), ...(pool._badPolicies || []).map((b) => b.policy)].filter(Boolean));
  const seen = new Set();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  // Policies with the FEWEST existing claims first. CONFIRMED 2026-10-21: busy test policies fail FNOL at the final
  // save with "Please enter a claimant number for this exposure" (their claimant numbers are used up — claimant
  // numbers are unique per policy), while a lightly used policy saved fine.
  const claimsPerPolicy = {};
  for (const r of allRecords()) claimsPerPolicy[r.policyNumber] = (claimsPerPolicy[r.policyNumber] || 0) + 1;
  // Only policies whose existing claim is recent (loss date within the last year) — an older one's term has likely
  // ended and Find Policy won't attach it (CONFIRMED 2026-10-21 with a 2021 loss date).
  const yearAgo = new Date(today); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  return allRecords()
    .filter((r) => r.lob === p.lob && r.state === p.state && p.prefix.test(r.claimNumber || '') && r.policyNumber && r.lossDate
      && new Date(r.lossDate) >= yearAgo)
    .sort((a, b) => (claimsPerPolicy[a.policyNumber] - claimsPerPolicy[b.policyNumber]) || String(b.claimNumber).localeCompare(String(a.claimNumber)))
    .filter((r) => { if (seen.has(r.policyNumber) || used.has(r.policyNumber)) return false; seen.add(r.policyNumber); return true; })
    .map((r) => {
      const d = new Date(r.lossDate);
      if (Number.isNaN(d.getTime())) return null;
      d.setDate(d.getDate() + 1);
      return { policyNumber: r.policyNumber, lossDate: fmt(d > today ? today : d), state: r.state, basedOn: `${r.claimNumber} (DoL ${r.lossDate})` };
    })
    .filter(Boolean);
}

// Ordered candidate claims for a profile (pinned > provisioned pool > remembered > seeds > newest test-data claims).
function candidates(profile, limit = 4, { ignorePinned = false } = {}) {
  const p = PROFILES[profile];
  if (!p) throw new Error(`unknown claim profile "${profile}"`);
  const pinned = process.env[`ONEINC_CLAIM_${profile}`];
  if (pinned && !ignorePinned) return [pinned];
  const out = [];
  const push = (c) => { if (c && !out.includes(c)) out.push(c); };
  poolClaims(profile).forEach(push);
  push(readCache()[profile]);
  (p.seed || []).forEach(push);
  if (p.poolOnly) return out.slice(0, limit);
  allRecords().filter((r) => r.lob === p.lob && r.state === p.state && p.prefix.test(r.claimNumber || ''))
    .sort((a, b) => String(b.claimNumber).localeCompare(String(a.claimNumber)))
    .forEach((r) => push(r.claimNumber));
  return out.slice(0, limit);
}

module.exports = { PROFILES, candidates, remember, forget, CACHE_FILE, POOL_FILE, readPool, addToPool, poolClaims, policyCandidates, markBadPolicy };
