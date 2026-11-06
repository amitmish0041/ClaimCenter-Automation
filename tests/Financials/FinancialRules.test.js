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
const idOf = (title) => title.split(' ')[0];

test.afterEach(async ({}, ti) => {
  const id = idOf(ti.title);
  R.saveResult(ti, { scenarioId: id, tcId: id, ...(META[id] || { name: ti.title }) });
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

test.describe('B Approvals - payments', () => {
  test('TR-551 [TC049 / DMTA0007 + DMAR0062]: Box Number NOT APPLICABLE needs supervisor approval', async ({ page }, ti) => {
    const cn = await R.sharedClaim(page, 'PA', 'FR-551', { reserveActions: 0 });
    await R.step(page, ti, `Using PA claim ${cn} (shared test claim with an open BI reserve)`);
    const who = await R.asReserveUser(page, cn, 'PA');
    R.setClaim(ti, cn, who);
    // Pay the BI claimant: left to itself the wizard picked the insurance agency, a Vendor payee CC refuses without a
    // tax id from the Address Book (PA-PA-01-26-0748998, 2026-11-05).
    const txRows = await R.transactionRows(page, cn);
    const claimant = ((txRows.find((r) => /Bodily Injury Liability - /.test(r)) || '').match(/Bodily Injury Liability - (.+?) Liability -/) || [])[1] || '';
    await B.openExistingClaim(page, cn);
    let err = '';
    await createPayment(page, { payeeName: claimant || undefined, reserveLine: 'Bodily Injury', checkAmount: 250, boxNumber: 'NOT APPLICABLE', transactionType: 'Partial' }).catch((e) => { err = e.message.split('\n')[0]; });
    const msgs = [err, ...(await R.pageMessages(page))].filter(Boolean);
    await R.step(page, ti, `As ${who}: New Payment of $250 to ${claimant || 'the default payee'} on the BI line with Box Number = NOT APPLICABLE${msgs.length ? ` — ClaimCenter said: ${msgs.join(' | ')}` : ''}`);
    await B.openExistingClaim(page, cn);
    await R.clickMenu(page, /^Financials$/);
    await R.clickMenu(page, /^Checks\/Payments$|^Checks$/);
    const checks = await R.gridRows(page);
    await R.step(page, ti, 'Opened Financials > Checks/Payments');
    const chk = checks.find((r) => /250\.00/.test(r)) || '';
    await R.check(page, ti, { description: 'DMTA0007 Not App Box Number Approval', expected: "'…supervisor must approve' / check Pending approval", actual: `${chk || 'no $250 check'} || ${msgs.join(' | ')}`, ok: /Pending approval/i.test(chk) || /supervisor must approve/i.test(msgs.join(' ')) });
    const assignee = await R.approverFor(page);
    await R.step(page, ti, `Claim Workplan: approval activity assigned to ${assignee || 'nobody'}`);
    await R.check(page, ti, { description: 'DMAR0062 routes the approval to the adjusting group supervisor', expected: 'A named supervisor (not the requester)', actual: assignee || 'no approval activity', ok: !!assignee && E.loginIdFor(assignee) !== who });
  });
});
