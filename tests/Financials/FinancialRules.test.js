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
    cn = o.claim || await R.sharedClaim(page, o.kind || 'PA', o.tag, { reserveActions: 0 });
    await R.step(page, ti, `Using ${o.kind || 'PA'} claim ${cn} (shared test claim)`);
    await R.asAdmin(page, cn); who = `su (admin — ${o.admin})`;
    R.setClaim(ti, cn, who);
  } else { cn = await asRequester(page, ti, o.tag); who = REQUESTER; }
  // Only on our own claims: a named claim (o.claim) may belong to another suite (OneInc pool) — never delete its checks.
  if (!o.claim) await clearHeldChecks(page, ti, cn, 'before');
  // A control on another claim (o.control.claim) when every payment on the case's claim is in scope of the rule.
  if (o.control.claim) await B.openExistingClaim(page, o.control.claim);
  const c = await payAndRead(page, ti, o.control.claim || cn, who, `CONTROL — ${o.control.label}`, o.control.opts);
  if (o.control.claim) await B.openExistingClaim(page, cn);
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
  if (/Pending approval/i.test(status)) {
    if (o.admin) await R.asAdmin(page, cn); else await R.asTeam(page, cn, REQUESTER);
    if (o.claim) {
      // Named claim: delete ONLY this case's held check.
      try {
        await CO.openCheck(page, { status: '^Pending approval$', amount: '$' + t.res.amount });
        await R.step(page, ti, `Cleanup: deleted only this case's held check — ${await CO.deleteCheck(page)}`);
      } catch (e) { R.note(ti, 'cleanup', e.message.split('\n')[0]); }
    } else await clearHeldChecks(page, ti, cn, `after — ${topReached ? 'left with the final approver' : 'approval could not be completed'}`);
  }
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
    // Needs a policy WITH a Secondary Named Insured: HO policy 1002228777 (insured Robert Charles, SNI David Thomas —
    // OneInc PROP_PA profile), found by Advanced Search › Policy # (2026-11-06). The PA auto claim had no SNI and the
    // insured payment went through unheld (8200005030), which says nothing about the rule.
    ti.annotations.push({ type: 'note', description: 'Claim HO-PA-01-26-0748434 (insured Robert Charles; Secondary Named Insured David Thomas is a payee on the claim; open Building reserve) from the OneInc claim pool, an already-used claim. Made as su.' });
    await paymentRuleCase(page, ti, {
      tag: 'FR-0101', admin: 'HO claim with a Secondary Named Insured', claim: 'HO-PA-01-26-0748434',
      control: { label: 'claim payment on an open line to a vendor', opts: { vendor: P.VENDORS.adjustment, reserveLine: 'open' } },
      trigger: { label: 'claim payment on the same line to the insured only (no Secondary Named Insured on the check)', opts: { payee: 'insured', reserveLine: 'open' } },
      rule: 'DMTA0101 Insured or Secondary Insured only Payments', expectedHold: 'Pending approval',
      route: (a) => ({ description: 'DMAR0122 routes the approval to a named approver (not the requester su)', expected: 'A named approver', ok: !!a && !/folm/i.test(E.loginIdFor(a)) }),
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

// ── Round 2 (2026-11-06): A / R leftovers + data found in TEST ─────────────────────────────────────────────────────
const W = require('../../helpers/oneInc/wizardDriver');
const SA = require('../../helpers/oneInc/setupA');
const { addExposureByCoverage } = require('../../helpers/fnolHelper');

Object.assign(META, {
  'TR-537': { ...FIN40, name: 'TC035_DMTV0038 blocks claim-level recovery reserve creation for Auto/HO/PU', expected: "Recovery reserve at claim level refused ('Recovery reserves not allowed at claim level.'); nothing saved" },
  'TR-511': { ...FIN40, name: 'TC007_Exposure association to incident and ExposureChanged event (Auto)', expected: 'New exposure linked to an incident; edit saves; change recorded' },
  'TR-513': { ...FIN40, name: 'TC009_DMEC0002 blocks exposure closure when open reserve > $0 (Homeowners)', expected: 'Close Exposure with an open reserve stops on DMEC0002; zeroing the reserve lets the exposure close' },
  'TR-555': { ...FIN40, name: 'TC053_DMTPO522: Final Payment reserve take-down over authority creates Free Form Activity (PA Auto)', expected: "'FP created reserve takedown over authority' activity with the take-down amount" },
  'TR-549': { ...FIN40, name: 'TC047_DMTA0002 + DMAR0069: Employee claim payments require multi-level approval', expected: "Payment on an employee (Sensitive Claims Group) claim held for approval ('Employee claims require approval for payment.'); a payment on a normal claim by the same user is not" },
});

// Actions › Recovery Reserve › Add, leave Exposure at "none (Claim-level)", fill the rest, Save. Returns what CC said and
// whether the screen was left (saved). Cancels the screen when refused — nothing is saved.
async function claimLevelRecoveryReserve(page) {
  await W.openActionsMenu(page);
  await page.getByRole('menuitem', { name: /^Recovery Reserve$/ }).first().click();
  await W.settle(page, 3500);
  // A claim that already has recovery reserves lists them first; Add appends the new row LAST (2026-11-06) — always add
  // one and work on the highest row index.
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await W.settle(page, 3000);
  const ix = await page.evaluate(() => Math.max(-1, ...[...document.querySelectorAll('[name*="EditableRecoveryReservesLV-"]')].map((e) => Number((e.name.match(/EditableRecoveryReservesLV-(\d+)-/) || [])[1])).filter((n) => !Number.isNaN(n))));
  // Plan in the page, set through Playwright: a DOM value change was not taken by CC (the default Subrogation category
  // stayed, 2026-11-06 rerun).
  const plan = await page.evaluate((ix) => {
    const out = [];
    for (const sel of document.querySelectorAll(`[id*="EditableRecoveryReservesLV-${ix}-"] select, select[name*="EditableRecoveryReservesLV-${ix}-"]`)) {
      if (!sel.offsetParent || sel.disabled) continue;
      const opts = [...sel.options];
      let pick;
      if (/Exposure/i.test(sel.name)) pick = opts.find((o) => /claim-level/i.test(o.text));
      // Not Subrogation: CC then refuses for another reason ("Subrogation must be Open on the claim…", 2026-11-06),
      // which hides whether DMTV0038 fires.
      else pick = opts.find((o) => o.value && !/^<?none>?$/i.test(o.text.trim()) && !/subrogation/i.test(o.text)) || opts.find((o) => o.value && !/^<?none>?$/i.test(o.text.trim()));
      if (pick) out.push({ name: sel.name, value: pick.value, text: pick.text.trim() });
    }
    return out;
  }, ix);
  const picked = {};
  for (const p of plan) {
    await page.locator(`select[name="${p.name}"]`).first().selectOption(p.value).catch(() => {});
    await W.settle(page, 1500);
    picked[p.name.split('-').pop()] = p.text;
  }
  await W.settle(page, 2500);
  await page.locator(`[name*="EditableRecoveryReservesLV-${ix}-"][type="text"]:visible:not([name*="Comment" i])`).last().fill('100');
  await W.settle(page, 800);
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await W.settle(page, 3500);
  const onScreen = await page.getByRole('button', { name: 'Save', exact: true }).first().isVisible().catch(() => false);
  const msgs = await R.pageMessages(page);
  if (onScreen) { page.once('dialog', (d) => d.accept().catch(() => {})); await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {}); await W.settle(page, 2000); }
  return { picked, saved: !onScreen, msgs };
}

test.describe('R Recovery - round 2', () => {
  test('TR-537 [TC035 / DMTV0038]: claim-level recovery reserve is blocked (Auto / HO / PU)', async ({ page }, ti) => {
    // The Recovery Reserve Category is fixed at Subrogation, and CC checks "Subrogation must be Open on the claim…"
    // BEFORE DMTV0038 (2026-11-06) — so subrogation is opened first, as the claim's adjuster (only the assignee can
    // answer those activities). The stepvarg claim allows that; the HO / PU claims belong to other adjusters.
    // PA-PA-01-26-0749033 already holds a Subrogation recovery reserve (TR-623, 2026-11-05) — subrogation is open there.
    // Answering the subrogation activities on the stepvarg claim did NOT open it (2026-11-06 rerun).
    const claims = [['Auto', 'PA-PA-01-26-0749033']];
    ti.annotations.push({ type: 'manual', description: 'HO and PU repeats (steps 9-10) not run: subrogation must be opened by those claims\' own adjusters before a recovery reserve can be tried.' });
    let first = true;
    for (const [lob, cn] of claims) {
      const c = cn || await R.stepvargClaim(page, 'FR-537');
      if (first) { await R.asAdmin(page, c); R.setClaim(ti, c, 'su (admin)'); first = false; } else await B.openExistingClaim(page, c);
      const before = (await R.transactionRows(page, c)).filter((r) => /Recovery Reserve/i.test(r));
      await B.openExistingClaim(page, c);
      const r = await claimLevelRecoveryReserve(page);
      await R.step(page, ti, `${lob} claim ${c}: Recovery Reserve row with ${Object.entries(r.picked).map(([k, v]) => `${k} = ${v}`).join('; ')}; amount $100; Save — ${r.saved ? 'SAVED' : 'refused'}${r.msgs.length ? `: ${r.msgs.join(' | ')}` : ''}`);
      await R.check(page, ti, { description: `${lob}: precondition — the row is at claim level`, expected: 'Exposure = none (Claim-level)', actual: Object.entries(r.picked).find(([k]) => /Exposure/i.test(k))?.[1] || '(no exposure select found)', ok: Object.entries(r.picked).some(([k, v]) => /Exposure/i.test(k) && /claim-level/i.test(v)) });
      await R.check(page, ti, { description: `${lob}: DMTV0038 blocks the claim-level recovery reserve`, expected: "Refused with 'Recovery reserves not allowed at claim level.'", actual: r.saved ? 'saved' : r.msgs.join(' | ') || 'refused, no message', ok: !r.saved && /claim level|DMTV0038/i.test(r.msgs.join(' ')) });
      const after = (await R.transactionRows(page, c)).filter((x) => /Recovery Reserve/i.test(x));
      await R.check(page, ti, { description: `${lob}: no recovery reserve transaction was created`, expected: `${before.length} recovery reserve rows (unchanged)`, actual: `${after.length}`, ok: after.length === before.length });
    }
    ti.annotations.push({ type: 'manual', description: 'EMDMRR03 RecoveryReserveAdded is an outbound event message (not shown in ClaimCenter) — "not triggered" follows from no recovery reserve being saved.' });
  });
});

const REQ_CLAIM = () => { try { const r = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'results', 'financialRules_stepvarg_claim.json'), 'utf8')); return r.cn; } catch (_) { return ''; } };

test.describe('A Reserves - round 2', () => {
  test('TR-511 [TC007 / EMDMEX02]: new exposure is linked to an incident; edit is saved and recorded', async ({ page }, ti) => {
    const cn = REQ_CLAIM() || await R.stepvargClaim(page, 'FR-511');
    await R.asAdmin(page, cn);
    R.setClaim(ti, cn, 'su (admin)');
    const n0 = await SA.exposureCount(page).catch(() => 0);
    let made = '';
    // Auto: coverages sit under a per-vehicle submenu (Choose by Coverage › <vehicle> › …) — name the vehicle.
    // Cloud menu tree (2026-11-06): Choose by Coverage (by label) › hover <vehicle> › hover Collision › click the
    // Collision leaf. fnolHelper.addExposureByCoverage times out on its first (on-prem) click here.
    try {
      await W.openActionsMenu(page);
      await page.getByLabel('Choose by Coverage', { exact: true }).first().click();
      await W.settle(page, 1500);
      const veh = page.locator('[id*="NewExposureMenuItemSet_ByCoverage-"]').filter({ hasText: /JEEP GRAND CHEROKEE/ }).first();
      const vid = (await veh.getAttribute('id')).replace(/^.*?(NewExposureMenuItemSet_ByCoverage-\d+-item)$/, '$1');
      await veh.hover(); await W.settle(page, 1200);
      await page.locator(`[id$="${vid}-0-item"]`).first().hover(); await W.settle(page, 1200);
      await page.locator(`[id$="${vid}-0-item-0-item"]`).first().click();
      await W.settle(page, 4000);
      const filled = [...await SA.fillRequired(page).catch(() => []), ...await W.fillRequiredEmpties(page).catch(() => [])];
      await page.getByRole('button', { name: 'Update', exact: true }).first().click();
      await W.settle(page, 4000);
      const left = await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false);
      made = `New Exposure (JEEP GRAND CHEROKEE › Collision); filled ${[].concat(filled).join(', ') || 'nothing extra'}; Update ${left ? 'REFUSED: ' + (await R.pageMessages(page)).join(' | ') : 'saved'}`;
      if (left) { page.once('dialog', (d) => d.accept().catch(() => {})); await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {}); }
    } catch (e) { made = 'ERR ' + e.message.split('\n')[0]; }
    await B.openExistingClaim(page, cn);
    const n1 = await SA.exposureCount(page).catch(() => 0);
    await R.step(page, ti, `Actions › New Exposure › Choose by Coverage › Collision — ${made || 'done'}; exposures ${n0} → ${n1}`);
    await R.check(page, ti, { description: 'New exposure created', expected: `${n0 + 1} exposures`, actual: `${n1}`, ok: n1 === n0 + 1 });
    if (n1 !== n0 + 1) return;
    await SA.openExposure(page, n1 - 1);
    const s = await require('../../helpers/oneInc/screenReader').readScreen(page);
    const f = (l) => ((s.fields.find((x) => x.label === l) || {}).value || '').trim();
    await R.step(page, ti, `Opened the new exposure: Primary Coverage ${f('Primary Coverage')}; Vehicle (incident) ${f('Vehicle') || '-'}; Status ${f('Status')}`);
    await R.check(page, ti, { description: 'Exposure is assigned to an incident', expected: 'Vehicle incident shown on the exposure', actual: f('Vehicle') || '(none)', ok: !!f('Vehicle') });
    await CO.historyMark(page);
    await B.openExistingClaim(page, cn);
    await SA.openExposure(page, n1 - 1);
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await W.settle(page, 3000);
    const changed = await P.choose(page, 'Deductible Status', /Requested/).catch((e) => 'ERR ' + e.message.split('\n')[0]);
    // The vehicle incident on the edit screen carries required fields the new exposure left empty (Primary Point of
    // Impact, Is Vehicle Drivable?, Airbags Deployed? — 2026-11-06): fill them so the edit can save.
    for (let r = 0; r < 2; r++) if (!(await W.fillRequiredEmpties(page)).length) break;
    await W.answerUnansweredNo(page).catch(() => {});
    await page.getByRole('button', { name: 'Update', exact: true }).first().click();
    await W.settle(page, 3500);
    const msgs = await R.pageMessages(page);
    const stillEditing = await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false);
    await R.step(page, ti, `Edit › Deductible Status = ${changed} › Update — ${stillEditing ? 'NOT saved' : 'saved'}${msgs.length ? `: ${msgs.join(' | ')}` : ''}`);
    if (stillEditing) {
      // The vehicle INCIDENT on the edit screen demands fields the automation cannot answer reliably (Primary Point of
      // Impact, Is Vehicle Drivable?, Airbags Deployed?) — reported as not done, not as a pass or a defect.
      ti.annotations.push({ type: 'manual', description: `Step 4 (edit the exposure and Update) not completed: ${msgs.join(' | ').slice(0, 300)}` });
      page.once('dialog', (d) => d.accept().catch(() => {}));
      await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    } else await R.check(page, ti, { description: 'Exposure edit saved', expected: 'Update accepted', actual: 'saved', ok: true });
    const hist = await CO.historySince(page);
    await R.step(page, ti, `Claim History after the edit — ${hist}`);
    ti.annotations.push({ type: 'manual', description: 'EMDMEX02 ExposureChanged is an outbound event message — verify in the message/integration log; the UI shows only the History entries recorded above. HO and PU repeats (steps 6-7) use the same flow and were not run.' });
  });

  test('TR-513 [TC009 / DMEC0002]: Close Exposure with an open reserve is stopped (HO)', async ({ page }, ti) => {
    const cn = await R.sharedClaim(page, 'HO', 'FR-513', { reserveActions: 1 });
    await R.asAdmin(page, cn);
    R.setClaim(ti, cn, 'su (admin)');
    await R.step(page, ti, `Using HO claim ${cn} (shared test claim; one reserve action left today for the zeroing)`);
    const n = await SA.exposureCount(page).catch(() => 0);
    let idx = -1;
    let remaining = '';
    for (let i = 0; i < n && idx < 0; i++) {
      await B.openExistingClaim(page, cn);
      await SA.openExposure(page, i);
      const s = await require('../../helpers/oneInc/screenReader').readScreen(page);
      remaining = ((s.fields.find((x) => x.label === 'Remaining Reserves') || {}).value || '');
      if (Number(remaining.replace(/[^0-9.]/g, '')) > 0 && await page.getByRole('button', { name: 'Close Exposure', exact: true }).first().isVisible().catch(() => false)) idx = i;
    }
    await R.check(page, ti, { description: 'Precondition: an open exposure with a positive open reserve', expected: 'Remaining Reserves > $0', actual: idx < 0 ? 'none found' : `exposure ${idx + 1}: ${remaining}`, ok: idx >= 0 });
    if (idx < 0) return;
    await E.completeActivitiesCloud(page).catch(() => {});
    await B.openExistingClaim(page, cn);
    await SA.openExposure(page, idx);
    await page.getByRole('button', { name: 'Close Exposure', exact: true }).first().click();
    await W.settle(page, 2500);
    await page.locator('textarea').first().fill('TR-513 close with open reserve').catch(() => {});
    const sel = page.locator('select[name$="Outcome"]').first();
    const opt = await sel.locator('option').evaluateAll((os) => (os.find((o) => o.value && /payments complete|complete/i.test(o.text)) || os.find((o) => o.value && !/none/i.test(o.text)) || {}).value);
    if (opt) await sel.selectOption(opt);
    await page.getByRole('button', { name: 'Close Exposure', exact: true }).first().click();
    await W.settle(page, 3500);
    const m1 = await R.pageMessages(page);
    const t1 = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const dm = (t1.match(/[^.]*DMEC0002[^.]*\.[^.]*\./) || [])[0] || '';
    await R.step(page, ti, `Close Exposure (Note + Outcome) with ${remaining} open — ClaimCenter said: ${dm || m1.join(' | ') || 'nothing'}`);
    await R.check(page, ti, { description: 'DMEC0002 No Exposure Close with Open Reserve stops the first Close Exposure', expected: 'DMEC0002 message; exposure not closed', actual: dm || m1.join(' | ') || 'no message', ok: /DMEC0002|open reserve/i.test(dm || m1.join(' ')) });
    // Steps 8-10: click Close Exposure again → CC zeroes the reserve and closes.
    await page.getByRole('button', { name: 'Close Exposure', exact: true }).first().click().catch(() => {});
    await W.settle(page, 4000);
    let m2 = await R.pageMessages(page);
    // A separate validation can still stop the close: "There are open activities related to this exposure" — complete
    // them (as the e2e close does) and close again; that rule is not DMEC0002.
    if (/open activities/i.test(m2.join(' '))) {
      await R.step(page, ti, `Second Close Exposure stopped by another validation: ${m2.join(' | ')} — completing the exposure's open activities and closing again`);
      await B.openExistingClaim(page, cn);
      await E.completeActivitiesCloud(page).catch((e) => R.note(ti, 'activities', e.message.split('\n')[0]));
      await B.openExistingClaim(page, cn);
      await SA.openExposure(page, idx);
      if (await page.getByRole('button', { name: 'Close Exposure', exact: true }).first().isVisible().catch(() => false)) {
        await page.getByRole('button', { name: 'Close Exposure', exact: true }).first().click();
        await W.settle(page, 2500);
        await page.locator('textarea').first().fill('TR-513 close after zeroing').catch(() => {});
        const sel2 = page.locator('select[name$="Outcome"]').first();
        const opt2 = await sel2.locator('option').evaluateAll((os) => (os.find((o) => o.value && /payments complete|complete/i.test(o.text)) || os.find((o) => o.value && !/none/i.test(o.text)) || {}).value);
        if (opt2) await sel2.selectOption(opt2);
        for (let k = 0; k < 2; k++) {
          await page.getByRole('button', { name: 'Close Exposure', exact: true }).first().click().catch(() => {});
          await W.settle(page, 3500);
          if (!await page.getByText(/DMEC0002/).first().isVisible().catch(() => false)) break;
        }
        m2 = await R.pageMessages(page);
      }
    }
    await B.openExistingClaim(page, cn);
    await SA.openExposure(page, idx);
    const s2 = await require('../../helpers/oneInc/screenReader').readScreen(page);
    const st = ((s2.fields.find((x) => x.label === 'Status') || {}).value || '');
    const rem2 = ((s2.fields.find((x) => x.label === 'Remaining Reserves') || {}).value || '');
    await R.step(page, ti, `Clicked Close Exposure again${m2.length ? ` — ClaimCenter said: ${m2.join(' | ')}` : ''}; exposure now Status ${st}, Remaining Reserves ${rem2}`);
    if (/Closed/i.test(st)) {
      await R.check(page, ti, { description: 'After zeroing, the exposure closes with no open reserve', expected: 'Status Closed; Remaining Reserves $0 / -', actual: `Status ${st}; Remaining ${rem2}`, ok: !(Number(rem2.replace(/[^0-9.]/g, '')) > 0) });
    } else {
      // Not a DMEC0002 outcome: another validation ("There are open activities related to this exposure") holds the
      // close, and those activities could not be completed by the automation. Reported as NOT DONE, not as a pass.
      ti.annotations.push({ type: 'manual', description: `Steps 8-10 (zero the reserve, close the exposure) NOT completed: the close is held by a separate validation — ${m2.join(' | ').slice(0, 300)}. Complete the exposure's open activities, then close.` });
    }
  });

  test('TR-555 [TC053 / DMTPO522]: Final Payment take-down over authority creates a Free Form Activity', async ({ page }, ti) => {
    const cn = await R.sharedClaim(page, 'PA', 'FR-555', { reserveActions: 0 });
    await R.step(page, ti, `Using PA claim ${cn} (shared test claim with a Bodily Injury reserve)`);
    await R.asTeam(page, cn, REQUESTER);
    R.setClaim(ti, cn, REQUESTER);
    const rows = await R.transactionRows(page, cn);
    const bi = lineTotal(rows, 'Bodily Injury');
    await R.step(page, ti, `Bodily Injury reserve on ${cn}: $${bi.toLocaleString()} (Transactions)`);
    await R.check(page, ti, { description: 'Precondition: open BI reserve >= $5,000', expected: '>= $5,000', actual: `$${bi.toLocaleString()}`, ok: bi >= 5000 });
    if (bi < 5000) return;
    await B.openExistingClaim(page, cn);
    // The BI line is offered only for the BI claimant (paying the insured offered only the 1st Party Vehicle lines,
    // 2026-11-06): pay the claimant named on the BI reserve row.
    const claimant = ((rows.find((r) => /Bodily Injury Liability - /.test(r)) || '').match(/Bodily Injury Liability - (.+?) (Liability|Claim Cost|\$)/) || [])[1] || 'claimant';
    // financialsHelper.createPayment: the path that paid on a BI line before (8200004678, 2026-11-05) — the OneInc wizard
    // driver was offered only the 1st Party lines for the same payee.
    const amt = P.uniqueAmount(50);
    let perr = '';
    await createPayment(page, { payeeName: claimant, reserveLine: 'Bodily Injury', checkAmount: Number(amt), transactionType: 'Final' }).catch((e) => { perr = e.message.split('\n')[0]; });
    await B.openExistingClaim(page, cn);
    const prow = await P.checkRow(page, amt);
    await R.step(page, ti, `As ${REQUESTER}: Final Payment $${amt} to ${claimant} on the Bodily Injury line (take-down ≈ $${(bi - Number(amt)).toLocaleString()})${perr ? ` — ${perr}` : ''} → Checks/Payments: ${prow ? `${prow.number || '(no number)'} ${prow.status}` : 'not listed'}`);
    const pay = { row: prow, err: perr };
    if (!pay.row) { await R.check(page, ti, { description: 'Final Payment entered', expected: 'a check', actual: pay.err || 'none', ok: false }); return; }
    if (/Pending approval/i.test(pay.row.status)) {
      const chain = await R.approveAllLevels(page, cn, PAY_SUBJECT);
      await R.step(page, ti, 'Payment approval: ' + chain.map((c) => `${c.approver || '-'} — ${c.result}`).join(' → '));
    }
    await page.waitForTimeout(5000);
    const act = await R.hasActivity(page, /takedown|take.down|over authority|reserve take/i, cn);
    await R.step(page, ti, 'Opened the claim Workplan');
    const hit = act.rows.find((r) => /takedown|take.down|over authority/i.test(r)) || '';
    await R.check(page, ti, { description: "DMTPO522: 'FP created reserve takedown over authority' Free Form Activity", expected: 'Activity with the take-down amount as currency', actual: hit || 'none', ok: !!hit });
    if (hit) await R.check(page, ti, { description: 'Activity carries the take-down amount formatted as currency', expected: '$#,###.## in the activity', actual: hit, ok: /\$[\d,]+\.\d\d/.test(hit) });
  });
});

test.describe('B Approvals - employee claim', () => {
  test('TR-549 [TC047 / DMTA0002 + DMAR0069]: employee claim payment needs multi-level approval', async ({ page }, ti) => {
    // Employee claims are restricted to the Sensitive Claims Group: Advanced Search › Assigned To Group = Sensitive
    // Claims Group found 8 open claims (2026-11-06). DFP-GA-10-24-0743519 has an open reserve and is a GA claim (the
    // DMAR0069 VA/GA chain).
    // A Sensitive Claims Group claim is NOT necessarily an employee claim: DFP-GA-10-24-0743519 has Special Claim
    // Permission blank and Employee Claim blank (2026-11-06), so its unheld payment proved nothing. Flag one of OUR PA
    // claims as an employee claim (Summary › Status › Edit › Special Claim Permission), then pay on it. The claim is
    // retired from the shared pool afterwards (employee claims are restricted).
    const cn = await R.sharedClaim(page, 'PA', 'FR-549', { reserveActions: 0 });
    await R.asAdmin(page, cn);
    await page.locator('[id^="Claim-MenuLinks-Claim_ClaimSummaryGroup"]').first().click().catch(() => {});
    await W.settle(page, 2500);
    await page.getByText(/^Status$/).first().click().catch(() => {});
    await W.settle(page, 3000);
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await W.settle(page, 3000);
    const perm = await P.choose(page, 'Special Claim Permission', /employee/i).catch((e) => 'ERR ' + e.message.split('\n')[0]);
    await page.getByRole('button', { name: 'Update', exact: true }).first().click().catch(() => {});
    await W.settle(page, 3500);
    R.setClaim(ti, cn, 'su (admin)');
    const now = ((require('../../helpers/oneInc/screenReader').findField(await require('../../helpers/oneInc/screenReader').readScreen(page), 'Special Claim Permission') || {}).value || '').trim();
    await R.step(page, ti, `As su: ${cn} › Summary › Status › Edit › Special Claim Permission = ${perm} › Update — field now "${now || '(blank)'}"`);
    await R.check(page, ti, { description: 'Precondition: the claim is flagged as an Employee claim', expected: 'Special Claim Permission = Employee claim', actual: now || perm, ok: /employee/i.test(now) });
    R.releaseClaim(cn, { done: true });
    await paymentRuleCase(page, ti, {
      tag: 'FR-549', admin: 'set the Employee claim permission', claim: cn,
      control: { label: 'the same vendor expense payment on a normal PA claim (PA-PA-01-26-0748998)', claim: 'PA-PA-01-26-0748998', opts: { ...EXPENSE } },
      trigger: { label: 'vendor expense payment on the employee claim', opts: { ...EXPENSE } },
      rule: 'DMTA0002 Employee Claim', expectedHold: "Pending approval ('Employee claims require approval for payment.')",
      route: (a) => ({ description: 'DMAR0069 Employee Claim Routing: VA/GA supervisors → Property Claim Division → Sr. VP', expected: 'A named approver (not the requester)', ok: !!a && !/folm/i.test(E.loginIdFor(a)) }),
    });
  });
});

// ── E Reinsurance (Legacy RI claims supplied by the user 2026-11-06; one claim per line) ──────────────────────────────
// Legacy claims are the ones whose reserve screen asks "Post to Reinsurance?" (probe 2026-11-06): WC-MD-01-18-0734261,
// CPR-IL-60-26-0747921, CAA-PA-01-26-0748098, CXS-VA-02-26-0748111 (PAR-NE-60-17-0640232 spare). Each case makes ONE
// reserve change (VTDMPL61: 2 a day per claim): +$100 on the first reserve line, Post to Reinsurance = Yes, Post Partial =
// Yes, Amount to Post = $50 — and walks the payment wizard (cancelled) for the RI question.
const RI_CLAIMS = {
  'TR-300': ['WC Legacy', 'WC-MD-01-18-0734261'],
  'TR-301': ['WC Legacy', 'WC-MD-01-18-0734261'],
  'TR-303': ['Property Legacy', 'CPR-IL-60-26-0747921'],
  'TR-305': ['Auto Legacy', 'CAA-PA-01-26-0748098'],
  'TR-307': ['Umbrella Legacy', 'CXS-VA-02-26-0748111'],
};
Object.assign(META, {
  'TR-300': { story: 'Reinsurance', storyTitle: 'GCCM-497 Feature - Reinsurance', name: 'RI-007 Post to Reinsurance on WC Legacy reserve and payment: Yes/No, partial, full', expected: "Reserve and payment screens ask 'Post to Reinsurance?'; Yes asks 'Post Partial Amount to Reinsurance?'; partial requires 'Amount to Post'; values posted downstream" },
  'TR-301': { story: 'Reinsurance', storyTitle: 'GCCM-497 Feature - Reinsurance', name: 'RI-008 All financial transaction types show RI fields when Post to RI = Yes — WC Legacy', expected: 'RI fields on reserve and payment transactions' },
  'TR-303': { story: 'Reinsurance', storyTitle: 'GCCM-497 Feature - Reinsurance', name: 'RI-010 All financial transaction types — Property Legacy', expected: 'RI fields on reserve and payment transactions' },
  'TR-305': { story: 'Reinsurance', storyTitle: 'GCCM-497 Feature - Reinsurance', name: 'RI-012 All financial transaction types — Auto Legacy', expected: 'RI fields on reserve and payment transactions' },
  'TR-307': { story: 'Reinsurance', storyTitle: 'GCCM-497 Feature - Reinsurance', name: 'RI-014 All financial transaction types — Umbrella Legacy', expected: 'RI fields on reserve and payment transactions' },
});

const riRow = (page) => page.locator('tr:visible').filter({ hasText: /Post to Reinsurance\?/ }).first();
const riText = async (page) => (await riRow(page).innerText().catch(() => '')).replace(/\s+/g, ' ');

// Reserve screen with the RI questions. Returns what appeared at each answer and whether the save went through.
async function riReserveChange(page, { delta = 100, partial = true, amountToPost = '50' } = {}) {
  const seen = {};
  await W.openActionsMenu(page);
  await page.getByRole('menuitem', { name: /^Reserve$/ }).first().click();
  await W.settle(page, 4000);
  seen.question = await riText(page);
  const amt = page.locator('input[name$="EditableReservesLV-0-NewAvailableReserves"]').first();
  const cur = Number(String(await amt.inputValue().catch(() => '0')).replace(/[^0-9.]/g, '')) || 0;
  seen.row0 = (await page.locator('tr[id*="LV-0-"]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
  await amt.fill(String((cur + delta).toFixed(2)));
  await amt.press('Tab').catch(() => {});
  await W.settle(page, 2000);
  const radios = () => riRow(page).getByRole('radio');
  await radios().nth(0).click({ force: true });
  await W.settle(page, 2500);
  seen.afterYes = await riText(page);
  if (partial !== null) {
    // The Partial radio is a styled control: a role click did not select it (checked=false in the probe, 2026-11-06).
    // Click the underlying input in the page, then confirm it is checked.
    await page.evaluate((v) => { const i = [...document.querySelectorAll('input[type=radio]')].find((x) => /0-ExtPartialToExcess$/.test(x.name) && x.value === v); if (i) i.click(); }, partial ? 'true' : 'false');
    await W.settle(page, 3000);
    seen.partialChecked = await page.evaluate((v) => !!([...document.querySelectorAll('input[type=radio]')].find((x) => /0-ExtPartialToExcess$/.test(x.name) && x.value === v) || {}).checked, partial ? 'true' : 'false');
    seen.afterPartial = await riText(page);
    const box = riRow(page).locator('input[type=text]').first();
    seen.amountBox = await box.isVisible().catch(() => false);
    if (partial && seen.amountBox) { await box.fill(amountToPost); await box.press('Tab').catch(() => {}); await W.settle(page, 1500); }
  }
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await W.settle(page, 4000);
  let msgs = await R.pageMessages(page);
  let still = await page.getByRole('button', { name: 'Save', exact: true }).first().isVisible().catch(() => false);
  if (still && msgs.length && msgs.every((m) => /warning/i.test(m))) { await page.getByRole('button', { name: 'Save', exact: true }).first().click(); await W.settle(page, 4000); msgs = await R.pageMessages(page); still = await page.getByRole('button', { name: 'Save', exact: true }).first().isVisible().catch(() => false); }
  if (still) { page.once('dialog', (d) => d.accept().catch(() => {})); await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {}); await W.settle(page, 2000); }
  return { seen, saved: !still, msgs, from: cur, to: cur + delta };
}

test.describe('E Reinsurance', () => {
  for (const id of ['TR-300', 'TR-303', 'TR-305', 'TR-307']) {
    const [lob, cn] = RI_CLAIMS[id];
    test(`${id} [${META[id].name.split(' ')[0]}]: Post to Reinsurance on ${lob} reserve (Yes / partial) and payment`, async ({ page }, ti) => {
      await R.asAdmin(page, cn);
      R.setClaim(ti, cn, 'su (admin)');
      await R.step(page, ti, `${lob} claim ${cn} (Legacy RI claim supplied by the team)`);
      const before = await R.transactionRows(page, cn);
      await B.openExistingClaim(page, cn);
      const r = await riReserveChange(page, { delta: 100, partial: true, amountToPost: '50' });
      await R.step(page, ti, `Actions › Reserve: first line ${r.seen.row0}`);
      await R.check(page, ti, { description: "Reserve screen asks 'Post to Reinsurance?' (Yes/No)", expected: 'Post to Reinsurance? Yes No', actual: r.seen.question || '(not shown)', ok: /Post to Reinsurance\?\s*Yes\s*No/i.test(r.seen.question || '') });
      await R.check(page, ti, { description: "Yes → 'Post Partial Amount to Reinsurance?' appears", expected: 'Post Partial Amount to Reinsurance? Yes No', actual: r.seen.afterYes || '-', ok: /Post Partial Amount to Reinsurance\?/i.test(r.seen.afterYes || '') });
      await R.check(page, ti, { description: 'Precondition: Post Partial Amount = Yes is actually selected', expected: 'radio checked', actual: String(!!r.seen.partialChecked), ok: !!r.seen.partialChecked });
      await R.check(page, ti, { description: "Partial = Yes → 'Amount to Post' is shown and required", expected: 'Amount to Post input', actual: `${r.seen.afterPartial || '-'} (input shown: ${r.seen.amountBox})`, ok: !!r.seen.amountBox && /Amount to Post/i.test(r.seen.afterPartial || '') });
      await R.step(page, ti, `Reserve ${r.from.toFixed(2)} → ${r.to.toFixed(2)}, Post to Reinsurance = Yes, Partial = Yes, Amount to Post = $50 › Save — ${r.saved ? 'saved' : 'NOT saved'}${r.msgs.length ? `: ${r.msgs.join(' | ')}` : ''}`);
      await R.check(page, ti, { description: 'Reserve change with partial RI posting saves', expected: 'Saved', actual: r.saved ? 'saved' : r.msgs.join(' | ') || 'not saved', ok: r.saved });
      const after = await R.transactionRows(page, cn);
      const added = R.newRows(before, after);
      await R.step(page, ti, `Financials › Transactions — new row(s): ${added.join(' | ') || 'none'}`);
      // Payment screen: does it ask Post to Reinsurance? (QA 2026-09: "not available on the Payment screen in Cloud").
      await B.openExistingClaim(page, cn);
      let payQ = '';
      try {
        await W.openPayment(page, 'actions');
        await W.selectPayee(page, 'claimant').catch(() => W.selectPayee(page, 'first'));
        await W.nextFillingServicePeriod(page);
        const t2 = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
        payQ = (t2.match(/Post to Reinsurance\?[^.]{0,60}/i) || [''])[0];
        if (!payQ) {
          await W.selectReserveLine(page, 'open').catch(() => {});
          await W.completePaymentsStep(page, { amount: '1.37' }).catch(() => {});
          await W.nextFillingServicePeriod(page);
          const t3 = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
          payQ = (t3.match(/Post to Reinsurance\?[^.]{0,60}/i) || [''])[0];
        }
      } catch (e) { payQ = 'ERR ' + e.message.split('\n')[0]; }
      await W.cancelWizard(page).catch(() => {});
      await R.step(page, ti, `New Payment wizard (steps 2-3, cancelled — no payment made): RI question ${payQ ? `"${payQ}"` : 'not shown'}`);
      await R.check(page, ti, { description: "Payment screen asks 'Post to Reinsurance?'", expected: 'Post to Reinsurance? on the payment', actual: payQ || 'not shown on steps 2 or 3', ok: /^Post to Reinsurance/i.test(payQ) });
      ti.annotations.push({ type: 'manual', description: 'Not automated: Reserve Decrease, Final / Supplemental / Multi-exposure payments, Void, RI = No (claim setting), and the downstream RI values (DMTP0001 Legacy RI fields — verify in the RI feed).' });
    });
  }
});

test.describe('E Reinsurance - WC activity', () => {
  test('TR-564 [TC062 / DMTPS526]: WC reserve on a claim with an RE company creates the reinsurance_reserve activity', async ({ page }, ti) => {
    const cn = 'WC-MD-01-18-0734261';
    await R.asAdmin(page, cn);
    R.setClaim(ti, cn, 'su (admin)');
    const actRe = /Reinsurance Reserve/i;
    const before = (await R.workplanRows(page, cn)).filter((r) => actRe.test(r));
    await R.step(page, ti, `WC Legacy claim ${cn} (RE company 0035 per its existing "Reinsurance Reserve … to 0035" activity) — Reinsurance Reserve activities before: ${before.length}`);
    await B.openExistingClaim(page, cn);
    const r = await riReserveChange(page, { delta: 100, partial: false });
    await R.step(page, ti, `Reserve ${r.from.toFixed(2)} → ${r.to.toFixed(2)} on the first line, Post to Reinsurance = Yes (full) › Save — ${r.saved ? 'saved' : 'NOT saved'}${r.msgs.length ? `: ${r.msgs.join(' | ')}` : ''}`);
    await R.check(page, ti, { description: 'Reserve change saved (goes to Submitting / Notifying)', expected: 'Saved', actual: r.saved ? 'saved' : r.msgs.join(' | '), ok: r.saved });
    await page.waitForTimeout(8000);
    const after = (await R.workplanRows(page, cn)).filter((x) => actRe.test(x));
    const added = after.filter((x) => !before.includes(x));
    await R.step(page, ti, `Workplan Reinsurance Reserve activities after: ${after.length} — new: ${added.join(' | ') || 'none'}`);
    await R.check(page, ti, { description: "DMTPS526 creates a 'reinsurance_reserve' activity", expected: 'A new Reinsurance Reserve activity', actual: added.join(' | ') || 'none', ok: added.length > 0 });
    if (added.length) await R.check(page, ti, { description: 'Subject shows exposure type, amount and RE company number', expected: 'Reinsurance Reserve <exposure type> for $<amount> to <RE company>', actual: added[0], ok: /Reinsurance Reserve .+ for \$[\d,.]+ to \d+/i.test(added[0]) });
  });
});Object.assign(META, { 'TR-564': { ...FIN40, name: 'TC062_DMTPS526: Reinsurance reserve activity for WC claims with an RE company', expected: 'reinsurance_reserve activity whose subject shows exposure type, amount and RE company number' } });
