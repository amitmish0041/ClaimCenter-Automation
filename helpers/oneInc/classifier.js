/**
 * helpers/oneInc/classifier.js
 * Gives EVERY inventoried OneInc test case an automation category and, when it isn't automated, the specific
 * reason — so the report accounts for all of them (no silent skips).
 *
 *   AUTOMATED   has a recipe in scenarioRecipes.js and is executed
 *   SUPERSEDED  lives on an older sheet a newer one replaces (reported NOT EXECUTED)
 *   DEV_PENDING Jira says the story's development isn't Done and there's no recipe (reported BLOCKED)
 *   NEEDS_DATA  automatable in principle, but needs claim/contact test data the suite can't create read-only
 *               (vendor by Tax ID, lienholder with loan, active recurrence, reinsurance claim, ...) — NOT EXECUTED
 *   MANUAL      needs something outside the ClaimCenter UI (OneInc payload/webhook, Contact Manager, admin
 *               permission changes, a submitted payment) — NOT EXECUTED, to be run by hand
 * The first matching rule wins; rules look at the case's name + precondition + steps.
 */
'use strict';
const { RECIPES } = require('./scenarioRecipes');

const RULES = [
  { cat: 'MANUAL', re: /webhook|payment feedback received|ExtDigitalPaymentWorkflow|workflow history/i, why: 'Needs OneInc to send payment feedback (webhook) for an existing digital payment — not observable or triggerable from the ClaimCenter UI alone' },
  { cat: 'MANUAL', re: /\bINT\.0\d\d\b|disclaimer|##PM_|UW Company|outbound|integration (trigger|message)|CreateVendor/i, why: 'Integration check on the message ClaimCenter sends to OneInc (payload fields / disclaimer mapping / CreateVendor) — needs integration-log or OneInc-side access, not available to UI automation' },
  { cat: 'MANUAL', re: /Contact ?Manager|\bin CM\b/i, why: 'Contact Manager is a separate application; no automation access/credentials are configured for it' },
  { cat: 'MANUAL', re: /permission|security role|bulk invoice/i, why: 'Needs admin changes to roles/permissions and a bulk-invoice submission — writes to system configuration, kept out of unattended automation' },
  { cat: 'MANUAL', re: /recurr(en|ing)|stored token|scheduled check/i, why: 'Manual (user decision 2026-10-21): needs an active check recurrence with a stored OneInc payment token — no OneInc sandbox access for automation' },
  { cat: 'MANUAL', re: /reinsurance|MCCA|legacy polic/i, why: 'Manual (user decision 2026-10-21): needs a legacy (reinsurance-eligible) claim with Loss Details › Reinsurance Status completed' },
  { cat: 'NEEDS_DATA', re: /medicare|\bMSA\b|payout indicator|deposit amount|case control|professional administrator/i, why: 'Needs a WC claim with a Medicare-beneficiary lost-wages exposure and line category 49 (lump sum)' },
  { cat: 'NEEDS_DATA', re: /TTD|TPD|\bMMI\b|permanent (%|impairment)|benefit offset|return(ed)? to work|temporary benefits/i, why: 'Needs a WC indemnity (lost wages) exposure with the matching line category / Loss Details values' },
  { cat: 'NEEDS_DATA', re: /lienholder|mortgagee|loan number|loan account|request type/i, why: 'Needs a Lienholder/Mortgagee contact on the claim and a loan/mortgage recorded on the incident' },
  { cat: 'NEEDS_DATA', re: /IAA|Insurance Auto Auctions|tax id|vendor/i, why: 'Needs a Vendor payee added from the Address Book by Tax ID' },
  { cat: 'NEEDS_DATA', re: /joint|multiple payees|two or more payees|2 or more payees|3 or more|secondary (insured|claimant|contact)|additional insured/i, why: 'Needs a multi-payee (joint) check with specific party roles on the claim' },
  { cat: 'NEEDS_DATA', re: /approver|attorney - adverse|adverse carrier|government agency|state agency|non-US|business contact/i, why: 'Needs a payee/approver with a specific role or contact setup on the claim' },
  { cat: 'NEEDS_DATA', re: /roof|homeowner/i, why: 'Needs a Homeowners claim with a Building Damage exposure and an insured claim-cost payment' },
  { cat: 'NEEDS_DATA', re: /wage payment|wage benefits|PIP|EMB|Med Pay|\bDE PM\b|\bMD\b|2 years|3 years|1 year/i, why: 'Needs a state-specific (DE/MD PIP / Med Pay / aged date-of-loss) claim and exposure' },
  { cat: 'NEEDS_DATA', re: /denial|denied|aggregate limit|surcharge|examiner|pending|exposure owner|address change|mailing address when/i, why: 'Needs claim/exposure state set up first (coverage denial, aggregate limit, surcharge, owner/examiner, pending transactions)' },
  { cat: 'MANUAL', re: /Additional Payment Details|One Inc Payment Number|CR Tracking/i, why: 'Needs an existing OneInc digital payment (with OneInc payment number/status) to open Additional Payment Details' },
  { cat: 'MANUAL', re: /click 'finish'|attempt to finish|\bfinish\b/i, why: 'Rule is checked on Finish and needs claim data this suite does not set up; pressing Finish submits a real payment' },
];

function classify(tc, { readiness } = {}) {
  if (RECIPES[tc.scenarioId]) return { automation: 'AUTOMATED', reason: '' };
  if (tc.supersededBy) return { automation: 'SUPERSEDED', reason: `Superseded by the "${tc.supersededBy}" sheet (newer revision of the same test cases after JRM feedback)` };
  const story = readiness && readiness.stories && readiness.stories[tc.story];
  const devPending = story && story.readiness === 'DEV_PENDING';
  const hay = [tc.name, tc.description, tc.precondition, ...tc.steps.map((s) => `${s.action} ${s.expected}`)].join(' \n ');
  const rule = RULES.find((r) => r.re.test(hay));
  const base = rule ? { automation: rule.cat, reason: rule.why } : { automation: 'MANUAL', reason: 'No automation recipe yet — run manually (add a recipe in helpers/oneInc/scenarioRecipes.js to automate)' };
  if (devPending) return { automation: 'DEV_PENDING', reason: `Development not complete in Jira (${story.dev.key}: ${story.dev.status}). ${base.reason}` };
  return base;
}

module.exports = { classify, RULES };
