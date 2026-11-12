/**
 * scripts/oneIncPayeePrep.js — builds the ClaimCenter side of the payee-acceptance cases IN ADVANCE (user direction
 * 2026-11-12): one new PA auto claim per slot (contacts' e-mail = QA mailbox, Mobile = ONEINC_CONTACT_MOBILE), a Full
 * Check to the insured (digital payment) submitted and sent to OneInc by the Financials Escalation batch. The payee's
 * part (Accept Payment with the texted code: PayPal / Venmo / Physical check / reject) is done later, per slot, from the
 * ledger <TestData>/payee-prep-<tier>.json.
 *
 *   ONEINC_ALLOW_FINISH=1 ONEINC_CONTACT_MOBILE=<mobile> node scripts/oneIncPayeePrep.js [--only <slot,…>] [--headless]
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
  { slot: 'expedite', accept: 'Physical check', delivery: /expedite|overnight|certified/i, then: 'wait for the Expedite / Certified tracking number', cases: ['GCCM-1013/UIF/TC-011'], amount: '1.88' },
];

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const TIER = (process.env.CC_TIER || 'test').toLowerCase();
const LEDGER = path.join(path.dirname(claimPicker.POOL_FILE), `payee-prep-${TIER}.json`);
const readLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (_) { return []; } };
const saveLedger = (l) => fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
const log = (m) => console.log(`[PayeePrep] ${m}`);

async function payOne(page, claim, s) {
  page.__oneIncParties = null; // getParties caches per page — this is a new claim
  await W.openClaim(page, claim);
  const who = (await W.getParties(page)).insured || 'insured';
  await W.openPayment(page, 'actions');
  await W.selectPayee(page, 'insured');
  if (s.joint) await X.addJoint(page, [{ who: '@person', type: 'Other' }]).catch((e) => log(`${s.slot}: joint payee not added (${e.message.split('\n')[0]})`));
  await W.nextFillingServicePeriod(page);
  await W.selectReserveLine(page, 'open');
  await W.completePaymentsStep(page, { transactionType: 'Partial Payment', amount: s.amount });
  if (s.delivery) {
    await W.nextFillingServicePeriod(page).catch(() => {});
    await W.select(page, 'Delivery Method', s.delivery).catch((e) => log(`${s.slot}: Delivery Method not set (${e.message.split('\n')[0]})`));
  }
  const outcome = (await X.finishObserve(page)) || (page.__observed && page.__observed['Finish outcome']) || '';
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
  log(`${todo.length} slot(s): ${todo.map((s) => s.slot).join(', ')} — filing ${todo.length} new INT_CLEAN claim(s)`);
  await testClaims.provision('INT_CLEAN', todo.length, { log: (m) => console.log(m), headless: !!arg('headless', false), runId });
  const made = (claimPicker.readPool().INT_CLEAN || []).filter((e) => e.usable && e.status === 'Unused' && e.reservedFor === runId).map((e) => e.claim);
  log(`claims: ${made.join(', ') || 'none'}`);
  testClaims.markUsed('INT_CLEAN', made, { runId, scenarios: todo.slice(0, made.length).map((s, i) => ({ claim: made[i], id: `payee-prep:${s.slot}` })) });
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
        entry.check = (/check(s) now: (d+)/.exec(entry.sent) || [])[1] || null;
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
