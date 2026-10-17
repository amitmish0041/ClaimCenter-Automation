/**
 * helpers/smartComm/scenarioService.js
 * Turns a template's LOB/State applicability (from Claims_Documents_Index.xlsx,
 * via catalogService) plus the available claim test-data records (now the
 * real, thousands-of-rows claim inventory in testDataService, not a
 * hand-typed fixture) into the list of scenarios to execute.
 *
 * Adding a scenario is therefore purely a testDataService data change; this
 * file never changes. A template marked States="All"/LOB="All" matches
 * every test-data record — deliberately: which state/LOB pairs actually get
 * tested for an "All" template is controlled by what test data exists, not
 * by enumerating every theoretical combination (see
 * SmartCOMM_QA_Approach_Final.pptx slide 5 — "cannot realistically be tested
 * for every combination").
 */
'use strict';

function norm(s) { return String(s || '').trim().toLowerCase(); }

// testDataService's real claim inventory runs to thousands of rows — every
// one of them matches an "ALL"/"ALL" template, so picking every match would
// spawn thousands of live ClaimCenter round-trips off one Runner UI click.
// Bounded to one scenario per distinct (LOB, State) pair the template
// actually matched — a template naming several explicit states/LOBs still
// gets one real scenario per combination, same as before this file read
// from a thousands-of-rows source — capped at MAX_SCENARIOS_PER_TEMPLATE
// total. Override via SMARTCOMM_MAX_SCENARIOS_PER_TEMPLATE if deeper
// coverage is worth the longer run. testDataRecords already comes back
// newest-claim-first (testDataService's source sheet is itself sorted
// "order by clm.createtime desc"), so among several matches for the same
// (LOB, State) pair, the most recently created claim wins — more likely to
// still be valid/testable in a dev environment than an old one.
const MAX_SCENARIOS_PER_TEMPLATE = Number(process.env.SMARTCOMM_MAX_SCENARIOS_PER_TEMPLATE) || 3;

// Backups also serve validationService's search for a claim whose claimant and insured are different people
// (a template printing both can't catch a claimant/insured swap otherwise) — hence 6, not just enough for the
// rare no-permission fallback.
const MAX_ALTERNATE_CLAIMS = 6;
const MAX_OTHER_LOB_ALTERNATES = 3;

// The catalog is hand-kept and doesn't always use the inventory's codes (2026-10-14: DIG238's LOB "PROPERTY"
// matched no claim, so it only ever got the single FALLBACK scenario below even when 3 were asked for).
const LOB_ALIASES = { PROPERTY: 'PR', 'PERSONAL AUTO': 'AUTO', 'COMMERCIAL AUTO': 'AUTO', 'GENERAL LIABILITY': 'GL', 'WORKERS COMP': 'WC', "WORKERS' COMPENSATION": 'WC', 'WORKERS COMPENSATION': 'WC' };
const lobCode = (l) => LOB_ALIASES[String(l || '').trim().toUpperCase()] || l;

function stateMatches(states, recordState) {
  const st = norm(recordState);
  return states.some((s) => {
    const v = String(s || '').trim().toUpperCase();
    if (v === 'ALL') return true;
    // "ALL (EXCEPT MI)" — every state but the listed ones.
    const except = v.match(/^ALL\s*\(\s*EXCEPT\s+([A-Z ,]+)\)$/);
    if (except) return !except[1].split(/[\s,]+/).filter(Boolean).map(norm).includes(st);
    // Not a state code at all (DIG174's catalog says "3") — no real restriction to apply, so any state.
    if (!/^[A-Z]{2}$/.test(v)) return true;
    return norm(v) === st;
  });
}

function appliesToTemplate(template, record) {
  const states = template.states; // array of codes, or ['ALL']
  const lobs = template.lob;      // array of codes, or ['ALL']
  const stateOk = stateMatches(states, record.state);
  const lobOk = lobs.includes('ALL') || lobs.some(l => norm(lobCode(l)) === norm(record.lob));
  return stateOk && lobOk;
}

function getScenariosForTemplate(template, testDataRecords) {
  const seen = new Set();
  const scenarios = [];
  for (const r of testDataRecords) {
    if (!appliesToTemplate(template, r)) continue;
    const key = `${norm(r.lob)}|${norm(r.state)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scenarios.push({
      scenarioId: `${template.digNumber}-${r.lob}-${r.state}`.replace(/\s+/g, ''),
      lob: r.lob,
      state: r.state,
      testData: r,
    });
    if (scenarios.length >= MAX_SCENARIOS_PER_TEMPLATE) break;
  }
  // Fewer distinct (LOB, State) pairs than scenarios asked for (2026-10-14: a single-state/LOB template such as
  // an MI-only WC letter ran ONE scenario although the team picked 3) — fill up with other matching claims,
  // so each extra scenario is a different real claim of the same kind (different parties, addresses, dates).
  if (scenarios.length && scenarios.length < MAX_SCENARIOS_PER_TEMPLATE) {
    const used = new Set(scenarios.map((sc) => sc.testData.claimNumber));
    for (const r of testDataRecords) {
      if (scenarios.length >= MAX_SCENARIOS_PER_TEMPLATE) break;
      if (used.has(r.claimNumber) || !appliesToTemplate(template, r)) continue;
      used.add(r.claimNumber);
      const n = scenarios.filter((sc) => sc.lob === r.lob && sc.state === r.state).length + 1;
      scenarios.push({
        scenarioId: `${template.digNumber}-${r.lob}-${r.state}-${n}`.replace(/\s+/g, ''),
        lob: r.lob,
        state: r.state,
        testData: r,
      });
    }
  }
  // Same-LOB/State backups, used if the scenario's own claim can't be opened even as admin ("you do not have
  // permission to view this claim") or ClaimCenter throws an application error on it. Claims no other scenario
  // of this template already uses come first, so a fallback still tests a different claim.
  const usedByScenarios = new Set(scenarios.map((sc) => sc.testData.claimNumber));
  for (const sc of scenarios) {
    const key = `${norm(sc.lob)}|${norm(sc.state)}`;
    sc.alternates = testDataRecords
      .filter(r => appliesToTemplate(template, r) && `${norm(r.lob)}|${norm(r.state)}` === key && r.claimNumber !== sc.testData.claimNumber)
      .sort((a, b) => Number(usedByScenarios.has(a.claimNumber)) - Number(usedByScenarios.has(b.claimNumber)))
      .slice(0, MAX_ALTERNATE_CLAIMS);
    // Claims of OTHER LOBs (same state first, one per LOB) — for when ClaimCenter throws its application error on
    // the scenario's claim: CONFIRMED 2026-10-17 every WC-DE backup claim failed the same way, so per user
    // direction the fallback moves to a different LOB instead of working through more claims of the same one.
    const seenLob = new Set();
    sc.otherLobAlternates = testDataRecords
      .filter((r) => norm(r.lob) !== norm(sc.lob) && !usedByScenarios.has(r.claimNumber))
      .sort((a, b) => Number(norm(a.state) !== norm(sc.state)) - Number(norm(b.state) !== norm(sc.state)))
      .filter((r) => !seenLob.has(norm(r.lob)) && seenLob.add(norm(r.lob)))
      .slice(0, MAX_OTHER_LOB_ALTERNATES);
  }
  if (scenarios.length) return scenarios;

  // FALLBACK (per user direction 2026-10-05): nothing in the real test-data inventory actually carries the
  // State/LOB codes a template's own catalog entry names (e.g. DIG238 wants LOB "PROPERTY", but the live
  // inventory's own LOB column never literally says that — a naming-convention mismatch between the BA's
  // index and the real claim data, not evidence the template is untestable). Reporting a hard BLOCKED with
  // ZERO coverage for that is worse than running ONE real, clearly-flagged non-matching claim instead — some
  // content validation beats none, as long as it's obvious in the report that this scenario's LOB/State don't
  // actually match what the template claims to need. Only engages when there's SOME test data to fall back
  // to at all; a genuinely empty inventory still reports BLOCKED (nothing to run).
  if (!testDataRecords.length) return [];
  const r = testDataRecords[0];
  return [{
    scenarioId: `${template.digNumber}-FALLBACK-${r.lob}-${r.state}`.replace(/\s+/g, ''),
    lob: r.lob,
    state: r.state,
    testData: r,
    isFallbackClaim: true,
    alternates: testDataRecords.slice(1, 1 + MAX_ALTERNATE_CLAIMS),
  }];
}

module.exports = { getScenariosForTemplate, appliesToTemplate };
