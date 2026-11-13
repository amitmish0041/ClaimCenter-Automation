/**
 * scripts/oneIncPayeePrep.js — builds the ClaimCenter side of the payee-acceptance cases IN ADVANCE (user direction
 * 2026-11-12): one new PA auto claim per slot (contacts' e-mail = QA mailbox, Mobile = ONEINC_CONTACT_MOBILE), a Full
 * Check to the insured (digital payment) submitted and sent to OneInc by the Financials Escalation batch. The payee's
 * part (Accept Payment with the texted code: PayPal / Venmo / Physical check / reject) is done later, per slot, from the
 * ledger <TestData>/payee-prep-<tier>.json.
 *
 *   ONEINC_ALLOW_FINISH=1 ONEINC_CONTACT_MOBILE=<mobile> node scripts/oneIncPayeePrep.js [--only <slot,…>] [--claim <slot>=<claim>,…] [--headless]
 *   --claim reuses a claim already made for that slot (no new FNOL).
 *
 * Never texts anyone: it stops once the check is with OneInc.
 */
'use strict';
process.env.CC_ENV = process.env.CC_ENV || 'cloud';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { chromium } = require('playwright');
const base = require('../helpers/claimCenterBase');
const W = require('../helpers/oneInc/wizardDriver');
const X = require('../helpers/oneInc/reuseExt');
const checkOps = require('../helpers/oneInc/checkOps');
const claimPicker = require('../helpers/oneInc/claimPicker');
const testClaims = require('../helpers/oneInc/testClaims');

// slot → what the payee does later, the cases it serves, amount (distinct, so e-mails and checks are told apart).
const SLOTS = [
  { slot: 'paypal', accept: 'PayPal', then: 'void the Issued check (Repost No) → OneInc Stopped', cases: ['GCCM-787/TC/TC-025'], amount: '1.81' },
  { slot: 'venmo', accept: 'Venmo', then: 'void the Issued check (Repost No) → OneInc Stopped', cases: ['GCCM-787/TC/TC-023', 'GCCM-787/TC/TC-024'], amount: '1.82' },
  { slot: 'issued-void-1', accept: 'Physical check', then: 'void → Pending Void; OneInc answers Issued (stop failure)', cases: ['GCCM-787/TC/TC-026'], amount: '1.83' },
  { slot: 'issued-void-2', accept: 'Physical check', then: 'void → Pending Void; OneInc answers Success (cleared)', cases: ['GCCM-787/TC/TC-027'], amount: '1.84' },
  { slot: 'issued-mailed', accept: 'Physical check', then: 'wait for print date / Stop Pending from OneInc', cases: ['GCCM-787/TC/TC-033', 'GCCM-1013/INT/TC-128', 'GCCM-1013/APD/TC-135', 'GCCM-1013/UIF/TC-023'], amount: '1.85' },
  { slot: 'reject-single', accept: 'Reject', then: 'OneInc Cancelled (PM_Selection Customer) → Voided + Payee Rejected Payment activity', cases: ['GCCM-787/TC/TC-029'], amount: '1.86' },
  { slot: 'reject-joint', accept: 'Reject', joint: true, then: 'as reject-single, multi-payee check', cases: ['GCCM-787/TC/TC-030'], amount: '1.87' },
  { slot: 'expedite', accept: 'Physical check', delivery: /^Expedite Mail$/, then: 'wait for the Expedite / Certified tracking number', cases: ['GCCM-1013/UIF/TC-011'], amount: '1.89' },
  // Stored-token recurrences (CPD.003/004/007/008, added 2026-11-12): a Weekly set of 8 checks whose FIRST check (Payment
  // Date today) goes to OneInc now; the payee accepts it as Direct Deposit with the texted code, which stores the token the
  // later (scheduled) checks of the set default to. The cases then open those scheduled checks (recipes/y_recurrenceToken.js).
  { slot: 'recur-wc', profile: 'WCA_LW', payee: 'claimant', wc: true, recur: { every: 'Weekly', checks: '8' }, accept: 'Direct Deposit',
    then: 'stored token → open the next scheduled check of the set', amount: '1.91',
    cases: ['GCCM-759/CPD/TC-043', 'GCCM-759/CPD/TC-046',
      'GCCM-1003/CPD/TC-215', 'GCCM-1003/CPD/TC-220', 'GCCM-1003/CPD/TC-221', 'GCCM-1003/CPD/TC-223', 'GCCM-1003/CPD/TC-224'] },
  { slot: 'recur-pa', payee: 'insured', recur: { every: 'Weekly', checks: '8' }, accept: 'Direct Deposit',
    then: 'stored token → open the next scheduled check of the set', amount: '1.92',
    cases: ['GCCM-1003/CPD/TC-213', 'GCCM-1003/CPD/TC-222'] },
];
const today = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`; };
// WC indemnity (Lost Wages) payment, as recipes/existingClaims.js LW: wages on the exposure, Indemnity line, category 05.
const WC_EXPO = { 'Average Weekly Wage': '800.00', 'Disability Weekly Rate': '500.00', 'Disability Type': 'TTD', 'Benefit Offset Code': 'None', 'Reason TTD or TPD Ended': '<none>' };

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const TIER = (process.env.CC_TIER || 'test').toLowerCase();
const LEDGER = path.join(path.dirname(claimPicker.POOL_FILE), `payee-prep-${TIER}.json`);
const readLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (_) { return []; } };
const saveLedger = (l) => fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
const log = (m) => console.log(`[PayeePrep] ${m}`);

async function payOne(page, claim, s) {
  page.__oneIncParties = null; // getParties caches per page — this is a new claim
  await W.openClaim(page, claim);
  const parties = await W.getParties(page);
  const c0 = (parties.claimants || [])[0];
  const who = (s.payee === 'claimant' ? (c0 && (c0.name || c0.claimant || String(c0))) : parties.insured) || s.payee || 'insured';
  const A = require('../helpers/oneInc/setupA');
  // Examiner-number workaround (2026-11-13), as scenarioRunner: the exposure owner must not be Benjamin Smith / Kevin Burke.
  const owner = process.env.ONEINC_EXPOSURE_OWNER === undefined ? 'Stephanie Varga|GC Team 2' : process.env.ONEINC_EXPOSURE_OWNER;
  if (owner && owner !== '0') {
    const [o, g] = owner.split('|');
    log(`${s.slot}: ${await A.assignExposuresTo(page, o, g).catch((e) => `exposure owner not changed: ${e.message.split('\n')[0]}`)}`);
    await W.openClaim(page, claim);
  }
  if (s.wc) await A.setIndemnityExposure(page, WC_EXPO);
  await W.openPayment(page, 'actions');
  await W.selectPayee(page, s.payee || 'insured');
  // type Other needs a Tax ID + Address Book payee, so the joint payee is an Additional Claimant.
  if (s.joint) await W.addJointPayees(page, [{ who: process.env.PREP_JOINT_WHO || 'other', type: 'Additional Claimant' }]).catch((e) => log(`${s.slot}: joint payee not added (${e.message.split('\n')[0]})`));
  await W.nextFillingServicePeriod(page);
  if (s.wc) {
    await W.select(page, 'Reserve Line', /Indemnity/);
    await W.select(page, 'Transaction Type', 'Partial Payment');
    await A.selectLineCategory(page, '^05');
  } else {
    await W.selectReserveLine(page, 'open');
    await W.answer(page, 'Payment for a total loss?', 'No').catch(() => {});
  }
  await W.completePaymentsStep(page, { transactionType: 'Partial Payment', amount: s.amount });
  if (s.wc) {
    await A.fillRequired(page);
    await W.fill(page, 'Average Weekly Wage', '800.00').catch(() => {});
    await W.fill(page, 'Disability Weekly Rate', '500.00').catch(() => {});
  }
  if (s.delivery || s.recur) await W.nextFillingServicePeriod(page).catch(() => {});
  // Payment Delivery shows only once ClaimsPay Method = Mailed Check, which also asks for a Reason for Check (2026-11-13).
  if (s.delivery) {
    await W.select(page, 'ClaimsPay Method', 'Mailed Check');
    await W.settle(page, 2500);
    await W.select(page, 'Reason for Check', /No ability to access portal/).catch((e) => log(`${s.slot}: Reason for Check not set (${String(e.message).split(String.fromCharCode(10))[0]})`));
    await W.select(page, 'Payment Delivery', s.delivery);
  }
  // Recurrence Weekly re-renders the step with Due Date of First Check / Subsequent Checks / Frequency / Day of Week /
  // Total Number of Checks / Total Recurrence Amount (replacing Payment Date) — wait for them before filling (2026-11-13).
  if (s.recur) {
    await W.select(page, 'Recurrence', s.recur.every);
    const { readScreen: rs, findField: ff } = require('../helpers/oneInc/screenReader');
    // Choosing Weekly alone does not redraw the step; a ClaimsPay Method change does, and the recurrence fields then stay
    // when it is set back to Customer Choice (CONFIRMED 2026-11-13 on PA-PA-01-26-0749407) — so toggle it.
    if (!ff(await rs(page), 'Total Number of Checks')) {
      await W.select(page, 'ClaimsPay Method', 'Mailed Check').catch(() => {});
      await W.settle(page, 2500);
      await W.select(page, 'ClaimsPay Method', 'Customer Choice').catch(() => {});
      await W.settle(page, 2500);
    }
    for (let t = 0; t < 15 && !ff(await rs(page), 'Total Number of Checks'); t++) await page.waitForTimeout(1000);
    if (ff(await rs(page), 'Due Date of First Check')) await W.fill(page, 'Due Date of First Check', today()).catch(() => {});
    await W.fill(page, 'Total Number of Checks', s.recur.checks);
    await W.settle(page, 1500);
    await W.fillRequiredEmpties(page).catch(() => {});
    if (s.wc) await A.fillRequired(page);
  }
  let outcome = (await X.finishObserve(page)) || (page.__observed && page.__observed['Finish outcome']) || '';
  if (await W.inWizard(page)) { const sc = await require('../helpers/oneInc/screenReader').readScreen(page); outcome = `Finish refused: ${[...sc.messages, sc.south].filter(Boolean).join(' / ')}`; await W.cancelWizard(page).catch(() => {}); }
  const sent = await checkOps.escalateChecks(page, s.amount).catch((e) => `escalation: ${e.message.split('\n')[0]}`);
  return { payee: who, outcome: String(outcome).slice(0, 300), sent: String(sent).slice(0, 300) };
}

(async () => {
  if (process.env.ONEINC_ALLOW_FINISH !== '1') throw new Error('set ONEINC_ALLOW_FINISH=1 (the prep submits TEST payments)');
  if (!process.env.ONEINC_CONTACT_MOBILE) throw new Error('pass ONEINC_CONTACT_MOBILE inline (the payee mobile that receives the code later)');
  const only = arg('only', '') ? String(arg('only')).split(',') : null;
  const ledger = readLedger();
  const todo = SLOTS.filter((s) => (!only || only.includes(s.slot)) && !ledger.some((e) => e.slot === s.slot && e.status !== 'failed'));
  if (!todo.length) { log('nothing to prepare — every slot is in the ledger'); return; }
  const runId = `PayeePrep_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const prof = (s) => s.profile || 'INT_CLEAN';
  log(`${todo.length} slot(s): ${todo.map((s) => `${s.slot} (${prof(s)})`).join(', ')}`);
  const given = Object.fromEntries(String(arg('claim', '') || '').split(',').filter(Boolean).map((x) => x.split('=')));
  const fresh = {};
  for (const p of [...new Set(todo.filter((t) => !given[t.slot]).map(prof))]) {
    const n = todo.filter((t) => !given[t.slot] && prof(t) === p).length;
    log(`filing ${n} new ${p} claim(s)`);
    await testClaims.provision(p, n, { log: (m) => console.log(m), headless: !!arg('headless', false), runId });
    fresh[p] = (claimPicker.readPool()[p] || []).filter((e) => e.usable && e.status === 'Unused' && e.reservedFor === runId).map((e) => e.claim);
  }
  const made = todo.map((t) => given[t.slot] || (fresh[prof(t)] || []).shift());
  log(`claims: ${made.join(', ') || 'none'}`);
  for (const p of [...new Set(todo.map(prof))]) {
    const idx = todo.map((t, i) => i).filter((i) => prof(todo[i]) === p && made[i] && !given[todo[i].slot]); // given claims: already in the pool, not re-marked
    if (idx.length) testClaims.markUsed(p, idx.map((i) => made[i]), { runId, scenarios: idx.map((i) => ({ claim: made[i], id: `payee-prep:${todo[i].slot}` })) });
  }
  const browser = await chromium.launch({ headless: !!arg('headless', false) });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  page.setDefaultTimeout(20000);
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await base.loginToClaimCenter(page);
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    const claim = made[i];
    const entry = { slot: s.slot, cases: s.cases, accept: s.accept, then: s.then, amount: s.amount, claim: claim || null, preparedAt: new Date().toISOString(), runId };
    if (!claim) { Object.assign(entry, { status: 'failed', problem: 'no new claim' }); }
    else {
      try { Object.assign(entry, await payOne(page, claim, s)); // finishObserve records its outcome on the page (no return value): judge by the check the escalation found.
        entry.check = (/check\(s\) now: (\d+)/.exec(entry.sent) || [])[1] || null;
        entry.status = entry.check ? 'awaiting acceptance' : 'failed'; }
      catch (e) { Object.assign(entry, { status: 'failed', problem: e.message.split('\n')[0].slice(0, 300) }); await W.cancelWizard(page).catch(() => {}); }
    }
    log(`${s.slot}: ${entry.status} — ${claim || '-'} $${s.amount} ${entry.outcome || entry.problem || ''}`.slice(0, 400));
    const l = readLedger().filter((e) => !(e.slot === s.slot && e.status === 'failed'));
    l.push(entry);
    saveLedger(l);
  }
  await browser.close();
  log(`ledger: ${LEDGER}`);
})().catch((e) => { console.error('[PayeePrep] FAILED', e.message.split('\n')[0]); process.exit(1); });
