/**
 * tests/Financials/FinancialRules.test.js — CLOUD ClaimCenter.
 * QA workbooks "Financials - 40 cases" + "Remaining rules - V1.0", grouped into combined suites
 * (Desktop\Financial test cases\Financial_OneInc_Coverage_Review.xlsx). Cases OneInc already covers are not here.
 *
 *   A  Reserves & activities  TR-508 TR-514(+DMTA0005) TR-553 TR-554
 *   R  Recovery               TR-623/TR-557 (DMTA0025)
 *
 * Each test files its own claim (VTDMPL61: 2 reserve actions per claim per day). Reserves go in as the LOB's claim
 * rep from the EBT team list when CC_TEAM_PASS is set (the admin bypasses authority limits).
 * Word documents per case: node scripts/financialRulesDocs.js (after the run).
 */
const { test } = require('@playwright/test');
const { IS_CLOUD } = require('../../helpers/e2eSteps');
const { createReserve, createPayment } = require('../../helpers/financialsHelper');
const R = require('../../helpers/financialRules');
const B = require('../../helpers/claimCenterBase');
const E = require('../../helpers/e2eSteps');
const P = require('../../helpers/financialPayments');
const CO = require('../../helpers/oneInc/checkOps');

test.setTimeout(1_200_000);
test.skip(!IS_CLOUD, 'Financial rule suite runs on cloud ClaimCenter (CC_ENV=cloud)');

// Case metadata for the Word document (id, workbook, what QA expects).
const META = {
  'TR-572': { story: 'Financials - 40 cases', storyTitle: 'GCCM-496 Feature - Financials', name: 'TC070_Validate disabled policy-limit approval rules do not trigger (reserve half)', expected: 'No policy-limit approval/activity on an over-limit reserve; authority-based approval still applies' },
  'TR-571': { story: 'Financials - 40 cases', storyTitle: 'GCCM-496 Feature - Financials', name: 'TC069_Validate fallback approval routes to the group supervisor when no specific rule applies', expected: 'First approval assigned to a named group supervisor (not the requester); approval completes' },
  'TR-569': { story: 'Financials - 40 cases', storyTitle: 'GCCM-496 Feature - Financials', name: "TC067_Validate subsequent standard approval routes to the requesting user's supervisor", expected: "Next approval level assigned to the requester's supervisor (stepvarg → Auto supervisor Mallory Redcay)" },
  'TR-541': { story: 'Financials - 40 cases', storyTitle: 'GCCM-496 Feature - Financials', name: 'TC039_Validate Approve/Reject of reserve approval activity in Workplan (Auto)', expected: "Approve and Reject offered; Approve approves; Reject rejects and creates 'Review rejected request' for the requester" },
  'TR-551': { story: 'Financials - 40 cases', storyTitle: 'GCCM-496 Feature - Financials', name: 'TC049_DMTA0007 + DMAR0062: Box Number = NOT APPLICABLE requires supervisor approval', expected: "'If NOT APPLICABLE is selected in the box number field, supervisor must approve.' / check Pending approval routed to a supervisor" },
  'TR-508': { story: 'Financials - 40 cases', storyTitle: 'GCCM-496 Feature - Financials', name: 'TC004_Validate reserve adjustment within authority limits and GL posting', expected: 'Reserve within authority ($1,234) saves with no approval routing' },
  'TR-514': { story: 'Financials - 40 cases + Remaining rules', storyTitle: 'GCCM-496 Feature - Financials', name: 'TC010_Soft warning and DMTA0004 activity when reserve exceeds policy limit (+ DMTA0005)', expected: 'Soft warning only; reserve saves; DMTA0004 Reserve Exceeds Policy Limits activity created' },
  'TR-553': { story: 'Financials - 40 cases', storyTitle: 'GCCM-496 Feature - Financials', name: 'TC051_DMTPO535: WC reserve > $50K within 10 days of report creates major_loss activity', expected: 'major_loss activity created' },
  'TR-554': { story: 'Financials - 40 cases', storyTitle: 'GCCM-496 Feature - Financials', name: 'TC052_DMTP0505: Non-WC reserve >= $50K creates major_loss or complete_DM506 activity', expected: 'major_loss (claim <= 30 days) or complete_DM506 activity created' },
  'TR-623': { story: 'Financials - 40 cases', storyTitle: 'GCCM-496 Feature - Financials', name: 'TC_007 / TC055 (TR-623 = TR-557)_DMTA0025: Recovery >= $10,000 requires approval', expected: "'Recovery amount is greater than $10000.' / recovery Pending Approval" },
};
const RULES = { story: 'Remaining rules - V1.0', storyTitle: 'GCCM-496 Feature - Financials (remaining rules)' };
const FIN40 = { story: 'Financials - 40 cases', storyTitle: 'GCCM-496 Feature - Financials' };
Object.assign(META, {
  'TR-550': { ...FIN40, name: 'TC048_DMTA0006: M0 Expense (Miscellaneous adjuster code) requires supervisor approval (Auto)', expected: "Expense payment with Adjuster Number M01 held for supervisor approval; the same payment with 500 is not; supervisor approves" },
  'TR-556': { ...FIN40, name: 'TC054_DMTA0026 + DMAR0082: All PA Fire Recovery Service payments require Manager approval', expected: 'Payment to PA FIRE RECOVERY SERVICE LLC held and routed to a Manager; the same payment to another vendor is not held' },
  'DMTA0104': { ...RULES, name: 'DMTA0104 Changed PayTo Payment Approval', expected: 'Payment whose Pay To was changed from the payee name is held for approval; an unchanged one is not' },
  'DMTA0101': { ...RULES, name: 'DMTA0101 + DMAR0122 Insured or Secondary Insured only payments / approval routing', expected: 'Payment to the insured only is held for approval and routed; the same payment to a vendor is not' },
  'HIGH-CHECK': { ...FIN40, name: 'TC069 / TC067 approval routing on a high-dollar ($25,000) check', expected: "Each approval level goes only to the requester's supervisor, then the next leader up (Auto: mallredc → daryfili); final level rejected so the check is not released" },
  'DMTA0106': { ...RULES, name: 'DMTA0106 TaxIds Requiring Approval', expected: 'Payment to a vendor whose Tax ID is on Administration › Tax Ids Requiring Approval is held for approval; a vendor not on the list is not' },
  'TAP05000': { ...RULES, name: 'TAP05000 Optionally Check For Duplicate Checks', expected: "Second payment to the same payee for the same amount stops on 'Possible duplicate payment found'" },
});
META['TR-551'].name = 'TC049_DMTA0007 + DMAR0062: Manual (RealTime) Check with Box Number = NOT APPLICABLE requires supervisor approval';
META['TR-551'].expected = 'RealTime (manual) check with Box Number Not Applicable held for supervisor approval; the same check with Box 07 is not; supervisor approves';
const idOf = (title) => title.split(' ')[0].replace(/:$/, '');

test.afterEach(async ({}, ti) => {
  const id = idOf(ti.title);
  await R.saveResult(ti, { scenarioId: id, tcId: id, ...(META[id] || { name: ti.title }) });
  if (ti._fr && ti._fr.claim) R.releaseClaim(ti._fr.claim);
});

const PENDING = /Pending Approval|Awaiting Approval/i;
// Exposure to reserve on per claim type: FNOL already puts initial reserves on the vehicle / Transportation lines,
// so the rule's reserve goes on the coverage the rule is about.
const EXPOSURE = { PA: 'Bodily Injury', WC: 'Workers', HO: 'Dwelling' };

// Current approved/submitted reserve total on the exposure, summed from the Transactions rows (pending/rejected excluded).
function lineTotal(rows, exposure) {
  return rows.filter((r) => r.includes(exposure) && !/Pending|Rejected|Denied/i.test(r))
    .reduce((t, r) => t + Number(((r.match(/\$([\d,]+\.\d\d)/) || [])[1] || '0').replace(/,/g, '')), 0);
}

// A shared claim (registry — reused across cases and runs; a new claim only when none has reserve budget left today),
// then RAISE the reserve on the rule's exposure by `increase` as the line's claim rep — relative, because a reused
// claim may already carry a large reserve. Returns the new transaction row(s) and whatever CC said.
async function claimWithReserve(page, ti, kind, tag, increase, { reserveActions = 1 } = {}) {
  const cn = await R.sharedClaim(page, kind, tag, { reserveActions });
  await R.step(page, ti, `Using ${kind} claim ${cn} (shared test claim — assigned, document added, Ability to pay)`);
  const who = await R.asReserveUser(page, cn, kind);
  R.setClaim(ti, cn, who);
  const before = await R.transactionRows(page, cn);
  await R.step(page, ti, `As ${who}: Financials > Transactions before the reserve`);
  await B.openExistingClaim(page, cn);
  const current = lineTotal(before, EXPOSURE[kind]);
  const amount = current + increase;
  const said = await createReserve(page, { reserveAmount: amount, exposure: EXPOSURE[kind], strict: false });
  const msgs = [said, ...(await R.pageMessages(page))].filter(Boolean);
  await R.step(page, ti, `As ${who}: raised the ${EXPOSURE[kind]} reserve by ${increase.toLocaleString()} (${current.toLocaleString()} → ${amount.toLocaleString()})${msgs.length ? ` — ClaimCenter said: ${msgs.join(' | ')}` : ''}`);
  const after = await R.transactionRows(page, cn);
  const added = R.newRows(before, after);
  await R.step(page, ti, `Financials > Transactions after the reserve — new row(s): ${added.join(' | ') || 'none'}`);
  return { cn, who, added, msgs };
}

// A reserve that landed Pending approval is approved level by level (each approver as themself; admin when their login
// is refused) — DMTA0004 / DMTP0505 / DMTPO535 fire after approval.
async function approveIfPending(page, ti, cn, added) {
  if (!added.some((r) => PENDING.test(r))) return;
  const chain = await R.approveAllLevels(page, cn, /approve reserve change/i);
  await R.step(page, ti, 'Reserve approval chain: ' + chain.map((c) => c.approver + ' — ' + c.result).join(' → '));
  const rows = await R.transactionRows(page, cn);
  await R.step(page, ti, 'Financials > Transactions after approval: ' + rows.filter((r) => /Reserve/.test(r)).join(' | '));
  await page.waitForTimeout(5000);
}

test.describe('A Reserves & activities', () => {
  test('TR-508 [TC004]: reserve within authority needs no approval', async ({ page }, ti) => {
    const { cn, added, msgs } = await claimWithReserve(page, ti, 'PA', 'FR-508', 1234);
    await R.check(page, ti, { description: `Reserve change saved on ${cn}`, expected: 'A new reserve transaction row', actual: added.join(' | ') || `none — ${msgs.join(' | ')}`, ok: added.length > 0 });
    await R.check(page, ti, { description: 'No approval routing for a within-authority reserve (DMTA0013/15/19/20/21 do not fire)', expected: 'New row status Submitted, not Pending Approval', actual: added.join(' | '), ok: added.length > 0 && !added.some((r) => PENDING.test(r)) });
    ti.annotations.push({ type: 'manual', description: 'GL posting (step 9) happens downstream of ClaimCenter - verify in the GL.' });
  });

  test('TR-514 [TC010 + DMTA0005]: reserve over policy limit warns and raises activity', async ({ page }, ti) => {
    const { cn, added, msgs } = await claimWithReserve(page, ti, 'PA', 'FR-514', 2000000);
    await approveIfPending(page, ti, cn, added);
    await R.check(page, ti, { description: 'Soft warning only - the over-limit reserve still saves', expected: 'Warning about the policy/coverage limit, and a new reserve row', actual: `new row(s): ${added.join(' | ') || 'none'} || CC said: ${msgs.join(' | ') || 'nothing'}`, ok: added.length > 0 });
    const act = await R.hasActivity(page, /policy limit|exceed/i, cn);
    await R.step(page, ti, 'Opened the claim Workplan');
    await R.check(page, ti, { description: `DMTA0004 Reserve Exceeds Policy Limits activity on ${cn}`, expected: 'Workplan activity mentioning the policy limit', actual: act.rows.join(' | '), ok: act.found });
  });

  test('TR-553 [TC051/DMTPO535]: WC reserve over $50K raises major_loss', async ({ page }, ti) => {
    const { cn, added, msgs } = await claimWithReserve(page, ti, 'WC', 'FR-553', 61234);
    await approveIfPending(page, ti, cn, added);
    await R.check(page, ti, { description: `$61,234 reserve saved on ${cn}`, expected: 'A new reserve transaction row', actual: added.join(' | ') || `none — ${msgs.join(' | ')}`, ok: added.length > 0 });
    const act = await R.hasActivity(page, /major.?loss/i, cn);
    await R.step(page, ti, 'Opened the claim Workplan');
    await R.check(page, ti, { description: `major_loss activity on ${cn}`, expected: 'major_loss activity', actual: act.rows.join(' | '), ok: act.found });
  });

  test('TR-554 [TC052/DMTP0505]: HO reserve over $50K raises major_loss / DM506', async ({ page }, ti) => {
    const { cn, added, msgs } = await claimWithReserve(page, ti, 'HO', 'FR-554', 61234);
    await approveIfPending(page, ti, cn, added);
    await R.check(page, ti, { description: `$61,234 reserve saved on ${cn}`, expected: 'A new reserve transaction row', actual: added.join(' | ') || `none — ${msgs.join(' | ')}`, ok: added.length > 0 });
    const act = await R.hasActivity(page, /major.?loss|DM506|large loss/i, cn);
    await R.step(page, ti, 'Opened the claim Workplan');
    await R.check(page, ti, { description: `major_loss or complete_DM506 activity on ${cn}`, expected: 'major_loss / complete_DM506 activity', actual: act.rows.join(' | '), ok: act.found });
  });
});

test.describe('R Recovery', () => {
  test('TR-623 [TC_007, TC055 / DMTA0025]: recovery >= $10,000 needs approval', async ({ page }, ti) => {
    const { cn, who } = await claimWithReserve(page, ti, 'PA', 'FR-623', 9000, { reserveActions: 2 });
    const before = await R.transactionRows(page, cn);
    // The subrogation activities are assigned to the claim's adjuster (standard user): only the assignee gets Update on
    // them (stepvarg saw Cancel only, PA-PA-01-26-0749026). Answer them as the adjuster, then recover as the rep.
    await R.asStandard(page, cn);
    await E.openSubrogationCloud(page).catch((e) => R.note(ti, 'subrogation', e.message.split('\n')[0]));
    await R.step(page, ti, 'As the claim adjuster: answered the subrogation activities (Subrogation Potential / Review for Subrogation / Referral)');
    if (/^su /.test(who)) await R.asAdmin(page, cn); else await R.asTeam(page, cn, who);
    let err = '';
    await E.recovery(page, 'PA', 10000, { skipSubro: true }).catch((e) => { err = e.message.split('\n')[0]; });
    const msgs = [err, ...(await R.pageMessages(page))].filter(Boolean);
    await R.step(page, ti, `As ${who} (Auto claim rep, no Recovery attribute): Subrogation recovery reserve + $10,000 recovery${msgs.length ? ` — ClaimCenter said: ${msgs.join(' | ')}` : ''}`);
    const after = await R.transactionRows(page, cn);
    const added = R.newRows(before, after);
    await R.step(page, ti, `Financials > Transactions — new row(s): ${added.join(' | ') || 'none'}`);
    const seen = `${msgs.join(' ')} ${added.join(' ')}`;
    await R.check(page, ti, { description: `DMTA0025 Recovery Amount Limit on ${cn}`, expected: "'Recovery amount is greater than $10000.' or the recovery Pending Approval", actual: seen || 'nothing', ok: /greater than \$?10,?000|Pending Approval/i.test(seen) });
  });
});

// ── B Approvals ───────────────────────────────────────────────────────────────────────────────────────────────────────
// One $2,000,000 BI reserve by stepvarg (Auto claim rep) — over the policy limit AND over his authority — carries
// TR-572 → TR-571 → TR-569 → TR-541 (approve) in order; a second over-authority reserve carries TR-541's Reject path.
// Serial: each test continues the same reserve's approval chain.
test.describe.serial('B Approvals', () => {
  const S = { cn: '', requester: '', level1: null };

  test('TR-572 [TC070]: disabled policy-limit rules do not trigger, authority routing still applies', async ({ page }, ti) => {
    const { cn, who, added, msgs } = await claimWithReserve(page, ti, 'PA', 'FR-572', 2000000);
    Object.assign(S, { cn, requester: who });
    await R.check(page, ti, { description: 'Over-limit reserve is submitted for approval by authority (active routing)', expected: 'New reserve row in Pending approval', actual: added.join(' | ') || `none — ${msgs.join(' | ')}`, ok: added.some((r) => PENDING.test(r)) });
    const act = await R.hasActivity(page, /policy limit|exceeds? (the )?(policy|coverage)/i, cn);
    await R.step(page, ti, 'Opened the claim Workplan');
    await R.check(page, ti, { description: 'Disabled reserve-over-policy-limit rule (DMTA0004) created no activity', expected: 'No policy-limit activity on the Workplan', actual: act.found ? act.rows.filter((r) => /policy limit|exceed/i.test(r)).join(' | ') : 'none present', ok: !act.found });
    ti.annotations.push({ type: 'manual', description: 'Payment-over-policy-limit half (steps 2-3) not automated yet: needs an over-limit check on the cloud payment wizard.' });
  });

  test('TR-571 [TC069]: first approval goes to the group supervisor', async ({ page }, ti) => {
    test.skip(!S.cn, 'needs the TR-572 reserve');
    R.setClaim(ti, S.cn, S.requester);
    await B.loginToClaimCenter(page);
    await B.openExistingClaim(page, S.cn);
    const assignee = await R.approverFor(page);
    await R.step(page, ti, `Claim ${S.cn} Workplan: "Review and approve reserve change" assigned to ${assignee || 'nobody'} (requested by ${S.requester})`);
    await R.check(page, ti, { description: 'Approval assigned to a named supervisor, not left on a group queue or the requester', expected: 'A named user other than the requester', actual: assignee || 'no approval activity', ok: !!assignee && E.loginIdFor(assignee) !== S.requester });
    const r = await R.approveAsAssignee(page, S.cn, /approve reserve change/i);
    S.level1 = r;
    await R.step(page, ti, `As ${r.approver}: ticked the approval activity — toolbar offered ${(r.offered || []).join(' + ') || 'nothing'}; pressed Approve — ${r.result}`);
    await R.check(page, ti, { description: 'Group supervisor approves the transaction', expected: 'approved', actual: r.result, ok: r.result === 'approved' });
  });

  test("TR-569 [TC067]: subsequent approval routes to the requesting user's supervisor", async ({ page }, ti) => {
    test.skip(!S.level1 || S.level1.result !== 'approved', 'needs the TR-571 first-level approval');
    R.setClaim(ti, S.cn, S.requester);
    await B.loginToClaimCenter(page);
    await B.openExistingClaim(page, S.cn);
    const next = await R.approverFor(page);
    const sup = (E.TEAMS.Auto || {}).supervisor;
    await R.step(page, ti, `After ${S.level1.approver} approved: next approval activity assigned to ${next || 'nobody'}`);
    await R.check(page, ti, { description: `Subsequent approval routed to the requester's supervisor (${S.requester} → Auto supervisor ${sup})`, expected: sup, actual: next ? `${next} (${E.loginIdFor(next)})` : 'no further approval level', ok: !!next && E.loginIdFor(next) === sup });
    const chain = await R.approveAllLevels(page, S.cn, /approve reserve change/i);
    await R.step(page, ti, 'Approved the remaining levels: ' + chain.map((c) => `${c.approver} — ${c.result}`).join(' → '));
    const rows = await R.transactionRows(page, S.cn);
    const big = rows.find((r) => /1,9\d\d,\d{3}\.00|2,000,000\.00/.test(r)) || '';
    await R.check(page, ti, { description: 'Transaction proceeds after supervisor approval', expected: 'Reserve row Submitted', actual: big || rows.join(' | '), ok: /Submitted/.test(big) });
  });

  test('TR-541 [TC039]: Approve / Reject of the reserve approval activity', async ({ page }, ti) => {
    test.skip(!S.level1, 'needs the TR-571 approval');
    R.setClaim(ti, S.cn, S.requester);
    await R.step(page, ti, `Approve path (claim ${S.cn}): ${S.level1.approver} saw ${(S.level1.offered || []).join(' + ')} and approved — ${S.level1.result}`);
    await R.check(page, ti, { description: 'Approve and Reject both offered on the approval activity', expected: 'Approve + Reject', actual: (S.level1.offered || []).join(' + ') || 'none', ok: ['Approve', 'Reject'].every((b) => (S.level1.offered || []).includes(b)) });
    await R.check(page, ti, { description: 'Approve approves the reserve change', expected: 'approved', actual: S.level1.result, ok: S.level1.result === 'approved' });
    // Reject path: a second over-authority reserve on a shared claim, rejected by its first approver.
    const { cn, who, added } = await claimWithReserve(page, ti, 'PA', 'FR-541', 150000);
    await R.check(page, ti, { description: 'Second over-authority reserve awaits approval', expected: 'New reserve row in Pending approval', actual: added.join(' | ') || 'none', ok: added.some((r) => PENDING.test(r)) });
    const rj = await R.approveAsAssignee(page, cn, /approve reserve change/i, { action: 'Reject' });
    await R.step(page, ti, `As ${rj.approver}: pressed Reject on claim ${cn} — ${rj.result}`);
    const rows = await R.transactionRows(page, cn);
    const rejected = rows.find((r) => /Reject/i.test(r)) || '';
    await R.check(page, ti, { description: 'Reserve change rejected', expected: 'Reserve row Rejected', actual: rejected || rows.filter((r) => /Reserve|Pending|Reject/i.test(r)).join(' | '), ok: !!rejected });
    const act = await R.hasActivity(page, /reject/i, cn);
    await R.step(page, ti, 'Opened the claim Workplan');
    await R.check(page, ti, { description: `'Review rejected request' activity for the requester (${who})`, expected: 'Workplan activity mentioning the rejection', actual: act.rows.filter((r) => /reject/i.test(r)).join(' | ') || act.rows.join(' | '), ok: act.found });
  });
});

// ── B Approvals - payments ────────────────────────────────────────────────────────────────────────────────────────
// Every payment rule runs a CONTROL payment beside the TRIGGER payment on the same claim, as the same user, changing
// only the rule's condition. "Pending approval" alone is not evidence (the user's own authority can hold a check):
// the case passes only when the control goes through and the trigger is held — then the hold is the rule's.
// Payments: Address Book vendors by Tax ID through the OneInc wizard driver (helpers/financialPayments.js).
const PAY_SUBJECT = /approve new payment/i;
const TOP_APPROVER = 'keviburk';
const MANAGERS = Object.values(E.TEAMS).map((t) => t.manager).filter(Boolean);
// The requester's leaders from the EBT team list: level 1 must be the supervisor, the next level the manager (user
// direction 2026-11-06: only the supervisor or the next leader up may get the approval request).
// ClaimCenter's own group setup wins over the EBT slide: scotshen's Team tab shows "GC Team 2: Scott Shenk
// (Supervisor)" with Stephanie Vargas and Mallory Redcay as members (cloud TEST, 2026-11-06); the reserve chain
// stepvarg → Scott Shenk → Mallory Redcay (2026-11-05) gives the next leader up.
const CC_LEADERS = { stepvarg: { supervisor: 'scotshen', manager: 'mallbuoh', source: "ClaimCenter Team tab (scotshen): GC Team 2 supervisor Scott Shenk; next level Mallory Redcay" } };
const leadersOf = (who) => {
  if (CC_LEADERS[who]) return CC_LEADERS[who];
  const t = Object.values(E.TEAMS).find((x) => (x.rep || []).includes(who)) || {};
  return { supervisor: t.supervisor, manager: t.manager, source: 'EBT team list' };
};
const leaderRoute = (label) => (a, who) => {
  const L = leadersOf(who);
  const id = a ? E.loginIdFor(a) : '';
  return { description: `${label}: approval goes to ${who}'s supervisor (${L.supervisor}) or the next leader up (${L.manager}) — nobody else`, expected: `${L.supervisor} or ${L.manager}`, ok: !!id && [L.supervisor, L.manager].includes(id) };
};

async function payAndRead(page, ti, cn, who, label, opts) {
  let res;
  let err = '';
  try { res = await P.makePayment(page, opts); } catch (e) { err = e.message.split('\n')[0]; }
  await B.openExistingClaim(page, cn);
  if (!res) {
    await R.step(page, ti, `As ${who}: ${label} — could not be entered: ${err}`);
    return { err };
  }
  const row = await P.checkRow(page, res.amount, res.payee);
  const f = res.fields;
  await R.step(page, ti, `As ${who}: ${label} — $${res.amount} to ${res.payee}; ${Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k} = ${v}`).join('; ')}${res.messages.length ? ` — ClaimCenter said: ${res.messages.join(' | ')}` : ''} → Checks/Payments: ${row ? `${row.number || '(no number)'} ${row.status}` : 'not listed'}`);
  return { res, row };
}

// Control + trigger + routing + approval. o: { kind, tag, admin, control: {label, opts}, trigger: {label, opts},
// rule, expectedHold, route(assignee, who) → {description, expected, ok}, precondition(detail, res) → {expected, actual, ok} }
// Payment routing cases: the check is entered by stepvarg (Auto claim rep) on a claim ASSIGNED to stepvarg, so the
// approval follows the real Auto chain (user direction 2026-11-06). No fallback user: a refused login fails the case.
const REQUESTER = 'stepvarg';
async function asRequester(page, ti, tag) {
  const cn = await R.stepvargClaim(page, tag);
  await R.asTeam(page, cn, REQUESTER);
  const head = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  await R.step(page, ti, `Logged in as ${REQUESTER} (Stephanie Vargas, Auto claim rep); claim ${cn} — ${(head.match(/Adj: [^)]*\)/) || ['adjuster not shown'])[0]}`);
  R.setClaim(ti, cn, REQUESTER);
  return cn;
}
// The approver of the approval the trigger created: open "Review and approve new payment" assignees after minus before.
function newAssignee(before, after) {
  const left = [...before];
  const added = after.filter((a) => { const i = left.indexOf(a); if (i >= 0) { left.splice(i, 1); return false; } return true; });
  return added;
}

// ClaimCenter keeps ONE open "Review and approve new payment" activity per exposure and adds each held check to it
// (PA-PA-01-26-0749042, 2026-11-06: 7 held checks, 1 activity). So a case can only attribute an approval to its own
// check when no other check is held: delete held checks first (and after), as setup, logged.
async function clearHeldChecks(page, ti, cn, when) {
  const gone = [];
  for (let i = 0; i < 15; i++) {
    await B.openExistingClaim(page, cn);
    const held = (await CO.checkRows(page)).filter((r) => /^Pending approval$/i.test(r.status));
    if (!held.length) break;
    const h = held[held.length - 1];
    try {
      await CO.openCheck(page, { status: '^Pending approval$', amount: h.amount });
      const out = await CO.deleteCheck(page);
      gone.push(`${h.payee} ${h.amount}: ${out.replace(/^Delete outcome:\s*/, '').slice(0, 60)}`);
      if (/NOT deleted/i.test(out)) break;
    } catch (e) { gone.push(`${h.payee} ${h.amount}: ${e.message.split('\n')[0].slice(0, 80)}`); break; }
  }
  await B.openExistingClaim(page, cn);
  const left = await R.openApprovalAssignees(page, PAY_SUBJECT);
  await R.step(page, ti, `Setup (${when}): deleted held checks on ${cn} so the case's approval is the only one — ${gone.join('; ') || 'none held'}; open payment approvals now: ${left.join(', ') || 'none'}`);
  return left;
}

async function paymentRuleCase(page, ti, o) {
  let cn;
  let who;
  if (o.admin) {
    cn = await R.sharedClaim(page, o.kind || 'PA', o.tag, { reserveActions: 0 });
    await R.step(page, ti, `Using ${o.kind || 'PA'} claim ${cn} (shared test claim)`);
    await R.asAdmin(page, cn); who = `su (admin — ${o.admin})`;
    R.setClaim(ti, cn, who);
  } else { cn = await asRequester(page, ti, o.tag); who = REQUESTER; }
  await clearHeldChecks(page, ti, cn, 'before');
  const c = await payAndRead(page, ti, cn, who, `CONTROL — ${o.control.label}`, o.control.opts);
  await R.check(page, ti, { description: `Control: ${o.control.label} is NOT held (shows the user's authority is not what holds the trigger)`, expected: 'Check created, status not Pending approval', actual: c.row ? `${c.row.number} ${c.row.status}` : c.err || 'no check', ok: !!c.row && !/Pending approval/i.test(c.row.status) });
  const before = await R.openApprovalAssignees(page, PAY_SUBJECT);
  await B.openExistingClaim(page, cn);
  const t = await payAndRead(page, ti, cn, who, `TRIGGER — ${o.trigger.label}`, o.trigger.opts);
  if (!t.row) {
    await R.check(page, ti, { description: `${o.rule}: trigger payment`, expected: o.expectedHold, actual: t.err || 'trigger check not created', ok: false });
    return { cn, who };
  }
  const d = await P.checkDetail(page, t.res.amount);
  await R.step(page, ti, `Opened trigger check ${t.row.number}: status ${d.status}; 1099 Box Number ${d.box || '-'}; Pay To ${d.payTo || '-'}`);
  if (o.precondition) await R.check(page, ti, { description: 'Precondition: the trigger check really carries the rule condition', ...o.precondition(d, t.res) });
  await R.check(page, ti, { description: `${o.rule}: trigger payment held for approval`, expected: o.expectedHold, actual: `${t.row.number} ${t.row.status}`, ok: /Pending approval/i.test(t.row.status) });
  if (!/Pending approval/i.test(t.row.status)) return { cn, who };
  await B.openExistingClaim(page, cn);
  const act = await P.activityDetail(page, PAY_SUBJECT);
  await R.step(page, ti, `Workplan: approval activity — ${act.slice(0, 600) || 'not found'}`);
  // The approval activity can land on the Workplan a little after the check (2026-11-06: read once, none new) —
  // re-read for up to ~60 s before concluding there is none.
  let after = [];
  let added = [];
  for (let i = 0; i < 6 && !added.length; i++) {
    if (i) await page.waitForTimeout(10000);
    await B.openExistingClaim(page, cn);
    after = await R.openApprovalAssignees(page, PAY_SUBJECT);
    added = newAssignee(before, after);
  }
  const assignee = added.length === 1 ? added[0] : null;
  await R.step(page, ti, `Workplan "Review and approve new payment" activities — before the trigger: ${before.join(', ') || 'none'}; after: ${after.join(', ') || 'none'} → the trigger's approval is assigned to ${assignee ? `${assignee} (${E.loginIdFor(assignee)})` : added.length ? `ambiguous (${added.join(', ')})` : 'nobody (no new approval activity)'}`);
  const r = o.route && o.route(assignee, who);
  if (r) await R.check(page, ti, { description: r.description, expected: r.expected, actual: assignee ? `${assignee} (${E.loginIdFor(assignee)})` : 'no approval activity', ok: r.ok });
  // Approve as the assignee until THIS check leaves Pending approval (other held checks on a shared claim are
  // approved on the way and logged).
  let status = t.row.status;
  const chain = [];
  let topReached = false;
  for (let i = 0; i < 5 && /Pending approval/i.test(status); i++) {
    await B.openExistingClaim(page, cn);
    const cur = await R.approverFor(page);
    // Kevin Burke (keviburk) is the LAST approver in the chain and has no TEST password: an approval assigned to him
    // counts as the chain completed (user direction 2026-11-06).
    if (cur && E.loginIdFor(cur) === TOP_APPROVER) { chain.push(`${cur} (${TOP_APPROVER}) — final approver reached; not logged in (no TEST password)`); topReached = true; break; }
    const a = await R.approveAsAssignee(page, cn, PAY_SUBJECT);
    chain.push(`${a.approver || '-'}: ${a.result}`);
    if (!a.approver) break;
    await B.openExistingClaim(page, cn);
    status = ((await P.checkRow(page, t.res.amount, t.res.payee)) || {}).status || '?';
  }
  await R.step(page, ti, `Approval chain: ${chain.join(' → ') || 'none'}; trigger check now "${status}"`);
  if (/Pending approval/i.test(status)) { if (o.admin) await R.asAdmin(page, cn); else await R.asTeam(page, cn, REQUESTER); await clearHeldChecks(page, ti, cn, `after — ${topReached ? 'left with the final approver' : 'approval could not be completed'}`); }
  await R.check(page, ti, {
    description: 'Approval chain completes — approved and released, or reached the final approver (Kevin Burke)',
    expected: 'Status no longer Pending approval, or the approval assigned to Kevin Burke (keviburk)',
    actual: topReached ? `assigned to Kevin Burke (${TOP_APPROVER}) — final approver` : status,
    ok: topReached || !/Pending approval|\?/.test(status),
  });
  return { cn, who, assignee };
}

// First real exposure (the stepvarg claim has only 1st Party Vehicle exposures — no BI, 2026-11-06).
const EXPENSE = { vendor: P.VENDORS.adjustment, reserveLine: 'new', exposure: /^\(\d+\) /, costType: /^Adjuster Expense$/ };

test.describe('B Approvals - payments', () => {
  test('TR-551 [TC049 / DMTA0007 + DMAR0062]: Manual (RealTime) check with Box Number NOT APPLICABLE needs supervisor approval', async ({ page }, ti) => {
    ti.annotations.push({ type: 'note', description: 'Cloud "Manual Check" = Actions › RealTime Check (wizard ManualCheckWizard). Only the admin has it on cloud TEST — no EBT team user (rep, supervisor or manager) does — so the checks are made as su. A regular One Inc New Payment with Box Number Not Applicable is not held (8200004732, 2026-11-06): the rule applies to manual checks.' });
    await paymentRuleCase(page, ti, {
      tag: 'FR-551', admin: 'only user with RealTime Check',
      control: { label: 'RealTime Check, 1099 Box Number 07', opts: { ...EXPENSE, via: 'realtime', boxNumber: /^07/ } },
      trigger: { label: 'RealTime Check, 1099 Box Number NOT APPLICABLE', opts: { ...EXPENSE, via: 'realtime', boxNumber: /not applicable/i } },
      rule: 'DMTA0007 Not App Box Number Approval', expectedHold: 'Pending approval (supervisor must approve)',
      precondition: (d) => ({ expected: 'Not Applicable', actual: d.box || '(blank)', ok: /not applicable/i.test(d.box) }),
      route: (a) => ({ description: 'DMAR0062 First Approval Manual: routed to a named supervisor, not the requester', expected: 'A named user other than the requester (su / Bill Folmar)', ok: !!a && !/folm/i.test(E.loginIdFor(a)) }),
    });
  });

  test('TR-550 [TC048 / DMTA0006]: M0 miscellaneous expense needs supervisor approval', async ({ page }, ti) => {
    await paymentRuleCase(page, ti, {
      tag: 'FR-550',
      control: { label: 'expense payment, Adjuster Number 500', opts: { ...EXPENSE, adjusterNumber: /^500 / } },
      trigger: { label: 'expense payment, Adjuster Number M01 (Misc Property, no Tax ID)', opts: { ...EXPENSE, adjusterNumber: /^M01 / } },
      rule: 'DMTA0006 M0 Expenses Approval', expectedHold: "Pending approval ('Miscellaneous expense payments must be approved by a supervisor.')",
      precondition: (d, res) => ({ expected: 'Adjuster Number M01 on the check', actual: `${res.fields['Adjuster Number'] || '-'} (check shows M01: ${/\bM01\b/.test(d.body)})`, ok: /^M01/.test(res.fields['Adjuster Number'] || '') && /\bM01\b/.test(d.body) }),
      route: leaderRoute('DMTA0006 supervisor approval'),
    });
  });

  test('TR-556 [TC054 / DMTA0026 + DMAR0082]: PA Fire Recovery Service payments need Manager approval', async ({ page }, ti) => {
    await paymentRuleCase(page, ti, {
      tag: 'FR-556',
      control: { label: 'expense payment to ADJUSTMENT SERVICES INC', opts: { ...EXPENSE } },
      trigger: { label: 'expense payment to PA FIRE RECOVERY SERVICE LLC (Tax ID 27-2990668)', opts: { ...EXPENSE, vendor: P.VENDORS.paFire } },
      rule: 'DMTA0026 PA Fire Recovery', expectedHold: "Pending approval ('All payments made to PA Fire Recovery Service require Manager approval.')",
      precondition: (d) => ({ expected: 'Pay To PA FIRE RECOVERY SERVICE LLC', actual: d.payTo || '-', ok: /PA FIRE RECOVERY/i.test(d.payTo) }),
      route: (a) => ({ description: `DMAR0082: routed to a user with the Manager attribute (EBT managers: ${MANAGERS.join(', ')})`, expected: 'an EBT team manager', ok: !!a && MANAGERS.includes(E.loginIdFor(a)) }),
    });
  });

  test('DMTA0106: payment to a Tax ID on the approval list needs approval', async ({ page }, ti) => {
    ti.annotations.push({ type: 'note', description: 'Administration › Tax Ids Requiring Approval on cloud TEST lists 51-0395711 (Smith testing for approvals), 46-0962075 (Anderson Medical Supplies), 84-1451963 (Zynex Medical).' });
    await paymentRuleCase(page, ti, {
      tag: 'FR-0106',
      control: { label: 'expense payment to ADJUSTMENT SERVICES INC (58-1623664, not on the list)', opts: { ...EXPENSE } },
      trigger: { label: 'expense payment to ZYNEX MEDICAL (84-1451963, on Tax Ids Requiring Approval)', opts: { ...EXPENSE, vendor: P.VENDORS.zynex } },
      rule: 'DMTA0106 TaxIds Requiring Approval', expectedHold: 'Pending approval',
      precondition: (d) => ({ expected: 'Payee tax ID 84-1451963', actual: /84-1451963/.test(d.body) ? 'check shows 84-1451963' : 'tax ID not on the check', ok: /84-1451963/.test(d.body) }),
      route: leaderRoute('DMTA0106 approval routing'),
    });
  });

  test('DMTA0104: changed Pay To needs approval', async ({ page }, ti) => {
    await paymentRuleCase(page, ti, {
      tag: 'FR-0104',
      control: { label: 'expense payment, Pay To left as the vendor name', opts: { ...EXPENSE } },
      trigger: { label: 'expense payment, Pay To changed to "ADJUSTMENT SERVICES INC C/O FR TEST"', opts: { ...EXPENSE, payTo: 'ADJUSTMENT SERVICES INC C/O FR TEST' } },
      rule: 'DMTA0104 Changed PayTo Payment Approval', expectedHold: 'Pending approval',
      precondition: (d) => ({ expected: 'Pay To = the changed text', actual: d.payTo || '-', ok: /C\/O FR TEST/i.test(d.payTo) }),
      route: leaderRoute('DMTA0104 approval routing'),
    });
  });

  test('DMTA0101 + DMAR0122: insured-only payment needs approval', async ({ page }, ti) => {
    await paymentRuleCase(page, ti, {
      tag: 'FR-0101',
      control: { label: 'claim payment on the 1st Party Vehicle line to a vendor', opts: { vendor: P.VENDORS.adjustment, reserveLine: 'match:1st Party Vehicle' } },
      trigger: { label: 'claim payment on the 1st Party Vehicle line to the insured only', opts: { payee: 'insured', reserveLine: 'match:1st Party Vehicle' } },
      rule: 'DMTA0101 Insured or Secondary Insured only Payments', expectedHold: 'Pending approval',
      route: leaderRoute('DMAR0122 approval routing'),
    });
  });

  // High-dollar check: the approval chain must climb the requester's own leaders only (supervisor, then manager).
  // Each level is approved as its assignee; the LAST level is Rejected so no $25,000 check is released to One Inc.
  test('HIGH-CHECK [TR-571 / TR-569 routing, high-dollar check]: approvals go only to the supervisor and the next leader up', async ({ page }, ti) => {
    const cn = await asRequester(page, ti, 'FR-HIGH');
    const who = REQUESTER;
    const L = leadersOf(who);
    const c = await payAndRead(page, ti, cn, who, 'CONTROL — small expense check', { ...EXPENSE });
    await R.check(page, ti, { description: 'Control: a small check by the same user is not held', expected: 'not Pending approval', actual: c.row ? `${c.row.number} ${c.row.status}` : c.err || 'no check', ok: !!c.row && !/Pending approval/i.test(c.row.status) });
    let before = await R.openApprovalAssignees(page, PAY_SUBJECT);
    await B.openExistingClaim(page, cn);
    const t = await payAndRead(page, ti, cn, who, 'TRIGGER — $25,000 expense check (over the rep\'s authority)', { ...EXPENSE, amount: '25000.00' });
    await R.check(page, ti, { description: 'High-dollar check held for approval', expected: 'Pending approval', actual: t.row ? `${t.row.number} ${t.row.status}` : t.err || 'no check', ok: !!t.row && /Pending approval/i.test(t.row.status) });
    if (!t.row || !/Pending approval/i.test(t.row.status)) return;
    const ladder = [L.supervisor, L.manager];
    let floor = 0; // index in the ladder the next approver may not go below
    for (let level = 1; level <= 4; level++) {
      await B.openExistingClaim(page, cn);
      const after = await R.openApprovalAssignees(page, PAY_SUBJECT);
      const added = newAssignee(before, after);
      await R.step(page, ti, `Level ${level}: open payment approvals before: ${before.join(', ') || 'none'}; now: ${after.join(', ') || 'none'}`);
      const a = added.length === 1 ? added[0] : null;
      const id = a ? E.loginIdFor(a) : '';
      if (!a) { await R.step(page, ti, `Level ${level}: ${added.length ? 'ambiguous new approvals: ' + added.join(', ') : 'no new approval activity'}`); if (added.length) await R.check(page, ti, { description: `Level ${level}: one approval request`, expected: '1 new approval activity', actual: added.join(', '), ok: false }); break; }
      if (id === TOP_APPROVER && level > 1) {
        await R.check(page, ti, { description: `Level ${level}: chain reaches the final approver`, expected: 'Kevin Burke (keviburk) — last person in the chain', actual: `${a} (${id})`, ok: true });
        break;
      }
      const pos = ladder.indexOf(id);
      await R.check(page, ti, {
        description: `Level ${level}: approval request goes only to ${who}'s ${level === 1 ? 'supervisor (or the next leader up)' : 'next leader up'}`,
        expected: ladder.slice(floor).join(' or ') || `a leader above ${ladder[ladder.length - 1]}`,
        actual: `${a} (${id})`,
        ok: pos >= floor || (floor >= ladder.length && !Object.values(E.TEAMS).some((x) => (x.rep || []).includes(id))),
      });
      floor = pos >= 0 ? pos + 1 : ladder.length;
      // Peek: is there a level above this one? Approve if the ladder continues, else Reject (keeps $25K unreleased).
      const last = floor >= ladder.length && level > 1;
      before = after.filter((x, i) => i !== after.lastIndexOf(a));
      const r = await R.approveAsAssignee(page, cn, PAY_SUBJECT, { action: last ? 'Reject' : 'Approve' });
      await R.step(page, ti, `Level ${level}: ${r.approver} pressed ${last ? 'Reject' : 'Approve'} — ${r.result}`);
      await B.openExistingClaim(page, cn);
      const st = ((await P.checkRow(page, t.res.amount, t.res.payee)) || {}).status || '?';
      await R.step(page, ti, `Check ${t.row.number} now "${st}"`);
      if (!/Pending approval/i.test(st)) {
        if (!last) {
          await R.check(page, ti, { description: 'Released after approval (no further level)', expected: 'not Pending approval', actual: st, ok: true });
          ti.annotations.push({ type: 'note', description: `The $25,000 check ${t.row.number} was released after level ${level} — it is TEST data on ${cn}.` });
        }
        break;
      }
    }
  });

  test('TAP05000: duplicate check is flagged', async ({ page }, ti) => {
    const cn = await asRequester(page, ti, 'FR-TAP05000');
    const who = REQUESTER;
    const first = await payAndRead(page, ti, cn, who, 'first expense payment', { ...EXPENSE });
    await R.check(page, ti, { description: 'First payment created', expected: 'A new check', actual: first.row ? `${first.row.number} ${first.row.status}` : first.err, ok: !!first.row });
    if (!first.row) return;
    let dup;
    let err = '';
    try { dup = await P.makePayment(page, { ...EXPENSE, amount: first.res.amount, stopOnDuplicate: true }); } catch (e) { err = e.message.split('\n')[0]; }
    const said = dup ? dup.messages.join(' | ') : err;
    await R.step(page, ti, `As ${who}: second payment, same payee ${first.res.payee}, same amount $${first.res.amount}, same line — ClaimCenter said: ${said || 'nothing'}${dup && dup.duplicatePage ? ' (stopped on the duplicate page and cancelled — no second check made)' : ''}`);
    await B.openExistingClaim(page, cn);
    const rows = (await CO.checkRows(page)).filter((r) => P.money(r.amount) === P.money(first.res.amount) && /ADJUSTMENT SERVICES/i.test(r.payee || r.text));
    await R.step(page, ti, `Checks/Payments: ${rows.length} check(s) to ADJUSTMENT SERVICES INC for $${first.res.amount}: ${rows.map((r) => `${r.number} ${r.status}`).join(', ')}`);
    await R.check(page, ti, { description: 'TAP05000 Optionally Check For Duplicate Checks', expected: "'Possible duplicate payment found' on the second payment (and no second check)", actual: `message: ${said || 'none'}; checks for that payee/amount: ${rows.length}`, ok: /duplicate/i.test(said) && rows.length === 1 });
  });
});
