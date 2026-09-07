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

function appliesToTemplate(template, record) {
  const states = template.states; // array of codes, or ['ALL']
  const lobs = template.lob;      // array of codes, or ['ALL']
  const stateOk = states.includes('ALL') || states.some(s => norm(s) === norm(record.state));
  const lobOk = lobs.includes('ALL') || lobs.some(l => norm(l) === norm(record.lob));
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
  return scenarios;
}

module.exports = { getScenariosForTemplate, appliesToTemplate };
