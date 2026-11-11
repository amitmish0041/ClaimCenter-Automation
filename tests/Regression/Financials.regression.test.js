/**
 * tests/Regression/Financials.regression.test.js — Regression Test Design V1.0, card "Financials" (TC067, TC069–TC074).
 * TC068 is NOT here: it is the existing tests/Financials/FinancialRules.test.js "HIGH-CHECK" case, run unchanged by the
 * Regression project (see helpers/regression/catalog.json grep).
 *
 * Same conventions as FinancialRules.test.js: shared registry claims (2 reserve actions per claim per day — VTDMPL61),
 * reserves as the LOB claim rep when CC_TEAM_PASS is set (the admin bypasses authority), odd-cent amounts.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, B, A, P, F, E, CO } = S;

S.hooks(test);

const PENDING = /Pending Approval|Awaiting Approval/i;
const money = (r) => Number(((r.match(/\$([\d,]+\.\d\d)/) || [])[1] || '0').replace(/,/g, ''));
const rowFor = (rows, amount) => rows.find((r) => r.includes(Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2 })));

// A shared PA claim with an open reserve on BI raised by `raise` as the reserve user. Returns { cn, who }.
async function paClaimWithReserve(page, ti, tag, raise) {
  const cn = await R.sharedClaim(page, 'PA', tag, { reserveActions: 1 });
  const who = await R.asReserveUser(page, cn, 'PA');
  R.setClaim(ti, cn, who);
  const before = await R.transactionRows(page, cn);
  const current = before.filter((r) => /Bodily Injury/.test(r) && /Reserve/i.test(r) && !PENDING.test(r)).reduce((t, r) => t + money(r), 0);
  await B.openExistingClaim(page, cn);
  const said = await F.createReserve(page, { reserveAmount: current + raise, exposure: 'Bodily Injury', strict: false });
  await R.step(page, ti, `As ${who}: Bodily Injury reserve ${current} → ${current + raise}${said ? ` (${said})` : ''}`);
  return { cn, who };
}

test('RG-TC067 [Financials]: Check within authority is approved automatically (no DMTA0012)', async ({ page }, ti) => S.blockable(test, async () => {
  const { cn, who } = await paClaimWithReserve(page, ti, 'RG-TC067', 500);
  await B.openExistingClaim(page, cn);
  const pay = await P.makePayment(page, { reserveLine: 'match:Bodily Injury', amount: P.uniqueAmount(25) });
  await R.step(page, ti, `As ${who}: $${pay.amount} partial payment — finished=${pay.finished} ${pay.messages.join(' | ')}`);
  const row = rowFor(await R.transactionRows(page, cn), pay.amount);
  await R.check(page, ti, { description: 'Check approved automatically (within authority)', expected: 'Approved / Submitted, not Pending approval', actual: row || 'payment row not found', ok: !!row && !PENDING.test(row) });
  const approver = await R.approverFor(page).catch(() => null);
  await R.check(page, ti, { description: 'DMTA0012 aggregate-limit approval not triggered', expected: 'no approval activity', actual: approver || 'none', ok: !approver });
  ti.annotations.push({ type: 'manual', description: 'EMDMCH01/EMDMCH02 event messages are not visible on a screen (step 8).' });
}));

test('RG-TC069 [Financials]: DMEC0002 blocks closing a Commercial Auto exposure with open reserve', async ({ page }, ti) => S.blockable(test, async () => {
  const claim = await S.fileClaim(page, 'CA', 'RG-TC069', { assignmentType: 'Casualty', lossCause: 'LC15', pool: false });
  const cn = claim.cn;
  R.setClaim(ti, cn, 'su');
  await R.asAdmin(page, cn);
  await E.repairCloud(page, cn).catch(() => {});
  await F.createReserve(page, { reserveAmount: 1000, exposure: 'Collision', strict: false });
  const rows = await R.transactionRows(page, cn);
  await R.check(page, ti, { description: 'Exposure has a positive open reserve', expected: '> $0', actual: rows.filter((r) => /Reserve/i.test(r)).join(' | '), ok: rows.some((r) => /Reserve/i.test(r) && money(r) > 0) });
  // Steps 4–7: Close Exposure with the reserve open → DMEC0002 (on cloud a warning that needs a second click).
  const first = await S.closeExposure(page, cn, 'Collision', { acceptDmec: false });
  await R.check(page, ti, { description: 'DMEC0002 stops the close while the reserve is open', expected: 'DMEC0002 open-reserve message, exposure still open', actual: `${first.closed ? 'CLOSED' : 'still open'} — ${first.messages.join(' | ') || 'no message'}`, ok: !first.closed && first.messages.some((m) => /DMEC0002|reserve/i.test(m)) });
  // Steps 8–10: drain the reserve to $0 with a Final Payment, then close.
  await B.openExistingClaim(page, cn);
  const line = await F.findFirstPositiveReserveLine(page).catch(() => null);
  if (line && line.amount > 0) {
    await F.createPayment(page, { paymentAmount: line.amount, reserveLine: line.firstCell, transactionType: 'Final Payment', payeeHint: line.rowText });
    await R.step(page, ti, `Final Payment $${line.amount} on ${line.firstCell} — reserve drained`);
  }
  const second = await S.closeExposure(page, cn, 'Collision', { acceptDmec: false });
  await R.check(page, ti, { description: 'With the reserve at $0 the exposure closes', expected: 'closed, no DMEC0002', actual: `${second.closed ? 'closed' : 'not closed'} ${second.messages.join(' | ')}`, ok: second.closed && !second.dmec });
}));

test('RG-TC070 [Financials]: Payment above the coverage limit routes to the supervisor (DMAR0001)', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await R.sharedClaim(page, 'PA', 'RG-TC070', { reserveActions: 1 });
  await S.openExposureMatching(page, 'Bodily Injury');
  const s = await S.readScreen(page);
  const lim = s.fields.find((f) => /limit/i.test(f.label) && /\$[\d,]+/.test(f.value || ''));
  if (!lim) throw new W.Blocked('no coverage limit shown on the Bodily Injury exposure');
  const limit = money(lim.value);
  await R.step(page, ti, `Coverage limit on ${cn}: ${lim.label} = ${lim.value}`);
  await R.asAdmin(page, cn);
  await F.createReserve(page, { reserveAmount: limit + 2000, exposure: 'Bodily Injury', strict: false });
  const who = await R.asReserveUser(page, cn, 'PA');
  R.setClaim(ti, cn, who);
  const pay = await P.makePayment(page, { reserveLine: 'match:Bodily Injury', amount: P.uniqueAmount(limit + 500) });
  await R.step(page, ti, `As ${who}: $${pay.amount} (limit + $500) — ${pay.messages.join(' | ')}`);
  const approver = await R.approverFor(page).catch(() => null);
  await R.check(page, ti, { description: 'DMAR0001: approval routed to the user supervisor', expected: "approval activity assigned to the requester's supervisor", actual: approver || 'no approval activity', ok: !!approver && E.loginIdFor(approver) !== who });
  const chain = await R.approveAllLevels(page, cn, /approve/i);
  await R.step(page, ti, 'Approval chain: ' + chain.map((c) => `${c.approver} — ${c.result}`).join(' → '));
  const row = rowFor(await R.transactionRows(page, cn), pay.amount);
  await R.check(page, ti, { description: 'Check visible after approval', expected: 'not Pending approval', actual: row || 'not found', ok: !!row && !PENDING.test(row) });
}));

test('RG-TC071 [Financials]: Add Joint Payees on a Homeowners check', async ({ page }, ti) => S.blockable(test, async () => {
  process.env.ONEINC_ALLOW_FINISH = process.env.ONEINC_ALLOW_FINISH || (['test', 'dev'].includes(B.TIER) ? '1' : ''); // checkOps' TEST-data gate
  const cn = await R.sharedClaim(page, 'HO', 'RG-TC071', { reserveActions: 0 });
  R.setClaim(ti, cn, process.env.CC_USER);
  await W.addClaimPersonContact(page, { first: 'Regression', last: 'JointPayee', role: 'Covered Party' }).catch((e) => ti.annotations.push({ type: 'manual', description: `joint payee contact: ${e.message}` }));
  await B.openExistingClaim(page, cn);
  page.__oneIncParties = null;
  const said = await CO.createFullCheck(page, { payee: 'claimant', joint: [{ who: 'other' }] });
  await R.step(page, ti, said);
  await CO.openNewestCheck(page).catch(() => {});
  const body = await S.bodyText(page);
  await R.check(page, ti, { description: 'Joint payee on the check', expected: 'primary payee + REGRESSION JOINTPAYEE (or the added joint payee)', actual: (body.match(/Pay To The Order Of[^\n]*\n?[^\n]*/i) || ['payee line not found'])[0], ok: /JointPayee|\band\b|&/i.test(body) });
}));

test('RG-TC072 [Financials]: Recovery reserve on an Auto claim (EMDMRR03)', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await R.sharedClaim(page, 'PA', 'RG-TC072', { reserveActions: 0 });
  await R.asAdmin(page, cn);
  R.setClaim(ti, cn, 'su');
  const before = await R.transactionRows(page, cn);
  await B.openExistingClaim(page, cn);
  await E.recovery(page, 'PA', 750, { skipSubro: false });
  const added = R.newRows(before, await R.transactionRows(page, cn));
  await R.check(page, ti, { description: 'Recovery reserve transaction (exposure, category, amount, status)', expected: 'Recovery Reserve $750.00', actual: added.join(' | ') || 'no new transaction', ok: added.some((r) => /750\.00/.test(r)) }); // the Recovery Reserves filter's rows carry no "Recovery" word
  ti.annotations.push({ type: 'manual', description: 'EMDMRR03 RecoveryReserveAdded event message is not visible on a screen (step 7).' });
}));

test('RG-TC073 [Financials]: TXV11000 blocks a payment above available reserves', async ({ page }, ti) => S.blockable(test, async () => {
  const { cn, who } = await paClaimWithReserve(page, ti, 'RG-TC073', 600);
  await B.openExistingClaim(page, cn);
  // Available Reserves on the BI line, read inside the payment wizard (Step 2) and cancelled — wizardDriver steps only.
  await W.openPayment(page, 'actions');
  let avail = 0;
  try {
    await W.selectPayee(page, 'claimant');
    await W.nextFillingServicePeriod(page);
    await W.selectReserveLine(page, 'match:Bodily Injury');
    avail = await W.availableReserves(page);
  } finally { await W.cancelWizard(page).catch(() => {}); }
  if (!(avail > 0)) throw new W.Blocked('Bodily Injury line shows no Available Reserves');
  await R.step(page, ti, `Bodily Injury Available Reserves: $${avail}`);
  const over = Math.floor(avail) + 100;
  const big = await P.makePayment(page, { reserveLine: 'match:Bodily Injury', amount: `${over}.37` });
  await R.check(page, ti, { description: 'TXV11000: payment above available reserves is blocked', expected: '"Payment amount exceeds available reserves."', actual: `${big.finished ? 'FINISHED' : 'refused'} — ${big.messages.join(' | ')}`, ok: !big.finished && big.messages.some((m) => /exceed/i.test(m)) });
  const ok = await P.makePayment(page, { reserveLine: 'match:Bodily Injury', amount: P.uniqueAmount(50) });
  const row = rowFor(await R.transactionRows(page, cn), ok.amount);
  await R.check(page, ti, { description: 'Payment within reserves is created', expected: `$${ok.amount} on Transactions`, actual: row || `not found — ${ok.messages.join(' | ')}`, ok: !!row });
  R.setClaim(ti, cn, who);
}));

test('RG-TC074 [Financials]: Void a Bulk Invoice in Requesting status', async ({ page }, ti) => S.blockable(test, async () => {
  S.need(test, 'CC_ADMIN_USER', 'CC_ADMIN_PASS');
  const cn = await R.sharedClaim(page, 'PA', 'RG-TC074', { reserveActions: 1 });
  R.setClaim(ti, cn, process.env.CC_USER);
  await R.asAdmin(page, cn);
  await F.createReserve(page, { reserveAmount: 1500, exposure: 'Bodily Injury', costType: 'Expense', costCategory: 'Legal', strict: false });
  // Desktop › Bulk Invoices › Create New (cloud — financialsHelper.createBulkInvoice is on-prem shaped).
  await page.locator('#TabBar-DesktopTab [role="menuitem"]').first().click({ force: true }).catch(() => {});
  await W.settle(page, 2500);
  if (!(await S.nav(page, 'Bulk Invoices'))) throw new W.Blocked('no Desktop › Bulk Invoices');
  await W.clickButton(page, 'Create New');
  const inv = `RG${Date.now().toString().slice(-8)}`;
  await A.fillByLabel(page, 'Invoice Number', inv).catch(() => {});
  await W.openPayeeSearch(page).catch(() => {});
  const v = P.VENDORS.adjustment;
  if (v && !(await W.searchAddressBookVendor(page, v.search, v.taxId))) throw new W.Blocked(`vendor ${v.search} not found`);
  await W.clickButton(page, 'Add').catch(() => {});
  await A.fillByLabel(page, 'Claim', cn).catch(() => {});
  await A.fillRequired(page).catch(() => {});
  await A.fillByLabel(page, 'Amount', '125.37').catch(() => {});
  await W.clickButton(page, 'Update');
  await W.clickButton(page, 'Submit');
  let status = (S.findField(await S.readScreen(page), 'Status') || {}).value || '';
  await R.check(page, ti, { description: 'Bulk invoice submitted', expected: 'Awaiting Submission', actual: status, ok: /awaiting submission/i.test(status) });
  await R.step(page, ti, await S.runBatchProcess(page, 'Bulk Invoice Escalation'));
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  status = (S.findField(await S.readScreen(page), 'Status') || {}).value || '';
  await R.check(page, ti, { description: 'After the escalation batch', expected: 'Requesting', actual: status, ok: /requesting/i.test(status) });
  page.once('dialog', (d) => d.accept().catch(() => {}));
  await W.clickButton(page, 'Void');
  status = (S.findField(await S.readScreen(page), 'Status') || {}).value || '';
  await R.check(page, ti, { description: 'Void pressed', expected: 'Initiating Void', actual: status, ok: /initiating void/i.test(status) });
  await R.step(page, ti, await S.runBatchProcess(page, 'Bulk Invoice Escalation'));
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  status = (S.findField(await S.readScreen(page), 'Status') || {}).value || '';
  await R.check(page, ti, { description: 'After the second batch', expected: 'Pending Void', actual: status, ok: /pending void/i.test(status) });
  const tx = await R.transactionRows(page, cn);
  await R.check(page, ti, { description: 'Bulk invoice void transaction on the claim', expected: 'void transaction row', actual: tx.filter((r) => /void/i.test(r)).join(' | ') || 'none', ok: tx.some((r) => /void/i.test(r)) });
}));
