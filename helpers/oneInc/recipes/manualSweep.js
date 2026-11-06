/**
 * helpers/oneInc/recipes/manualSweep.js — manual cases moved to automation (review 2026-11-05: the 27 "can be
 * automated now" cases; the ones that stay manual have their reason in caseReasons.js).
 *
 *  - VBR.008 Property Damage (Other Than Vehicle) release warning over $2,500 — GCCM-763 (Full Check) / GCCM-1003 (Quick
 *    Payment). A new PA auto claim carries no such exposure: the data step adds Property Damage Liability › "PD Liability -
 *    Other than Vehicle Damage" (Financials line "3rd Party Property Damage Other Than Vehicle Damage", CONFIRMED
 *    2026-11-05 on PA-PA-01-26-0748936) and reserves it.
 *  - VBR.011 expense cap — the $99,999.99 expense and $150,000 claim cost "no error" cases.
 *  - VBR.013 supplemental payment on an exposure with no reserve history (Full Check only).
 *  - CPD.003 / CPD.004 single Insured / Claimant payee defaults on Quick Payment (no recurrence).
 *  - GCCM-1008 Additional Payment Details upper section for a mailed check and a lienholder payment.
 *
 * Checks over $1,000 need a linked document (VBR.010), so every Finish here goes through workerK.finishWithDocument:
 * Next to the last step, link the claim document, Finish once, and record what CC showed as "Finish outcome". A
 * "no warning / no error" case passes when the payment reached Finish and the rule's own text is not there — another
 * rule refusing the check is reported in the outcome, not taken as this rule firing.
 */
'use strict';
const C = require('../checkOps');
const W = require('../wizardDriver');

// Creates a $0.4x check (createFullCheck options: payee / type / joint) on the claim and opens its Check/Payment Details.
async function openNewCheck(page, opts = {}) {
  const made = await C.createFullCheck(page, opts);
  return `${made}; ${await C.openCheck(page, { amount: page.__createdCheck.amount })}`;
}

// Additional Payment Details › Workflow History: { headers, rows } of the table under the "Workflow History" caption.
async function readWorkflow(page) {
  return page.evaluate(() => {
    const cap = [...document.querySelectorAll('div, span')].find((e) => e.offsetParent && /^\s*Workflow History\s*$/.test(e.textContent || ''));
    if (!cap) return null;
    let box = cap;
    while (box && !box.querySelector('tr')) box = box.parentElement;
    if (!box) return { headers: [], rows: [] };
    const leaf = [...box.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr'));
    const txt = (r) => (r.innerText || '').replace(/\s+/g, ' ').trim();
    const head = leaf.find((r) => /^Date\b/.test(txt(r)));
    const stop = leaf.findIndex((r) => /Feedback Id/.test(txt(r)));
    const body = leaf.filter((r, i) => r !== head && (stop < 0 || i < stop)).map(txt).filter((t) => /^\d{2}\/\d{2}\/\d{4}/.test(t));
    return { headers: head ? txt(head).split(/\s+(?=Description)/) : [], rows: body };
  });
}
// A check CC has already numbered (so it was handed to OneInc and has Workflow History): the newest numbered check on
// the claim, else a new $0.4x mailed check — BLOCKED when that one is held for approval (no number, nothing sent: 1008
// TC-003 on PA-PA-01-26-0749030, 2026-11-05). Opens its Additional Payment Details and waits (Refresh, up to ~2 min) for
// the first Workflow History entry.
async function openSentCheckAPD(page) {
  let rows = (await C.checkRows(page)).filter((r) => r.number);
  if (!rows.length) {
    await C.createFullCheck(page, { payee: 'claimant' });
    rows = (await C.checkRows(page)).filter((r) => r.number);
    if (!rows.length) throw new W.Blocked('the new check is held for approval (no check number), so CC has not sent it to OneInc and it has no Workflow History');
  }
  const pick = rows.slice(-1)[0];
  await C.openCheck(page, { number: pick.number });
  await C.openAPD(page);
  for (let t = 0; t < 8; t++) {
    const w = await readWorkflow(page);
    if (w && w.rows.length) break;
    await W.clickButton(page, 'Refresh').catch(() => {});
    await W.settle(page, 15000);
  }
  return `opened Additional Payment Details of check ${pick.number} (${pick.amount}, ${pick.status})`;
}

// "Workflow History" observation: shown / columns / entries (1008 APD TC-003).
async function workflowHistory(page) {
  const w = await readWorkflow(page);
  const text = !w ? 'not shown' : `columns: ${w.headers.join(', ') || 'none'}; ${w.rows.length} entr${w.rows.length === 1 ? 'y' : 'ies'}${w.rows.length ? ` — ${w.rows.join(' | ')}` : ''}`;
  return C.observe(page, 'Workflow History', text.slice(0, 600));
}
// Refresh with no workflow event in between: the table must be the same (1008 APD TC-006).
async function workflowUnchanged(page) {
  const before = await readWorkflow(page);
  await W.clickButton(page, 'Refresh');
  await W.settle(page, 3000);
  const after = await readWorkflow(page);
  const same = before && after && JSON.stringify(before.rows) === JSON.stringify(after.rows);
  const text = !before ? 'not shown' : same ? `unchanged after Refresh (${after.rows.length} entr${after.rows.length === 1 ? 'y' : 'ies'})`
    : `changed after Refresh — before: ${before.rows.join(' | ') || 'none'}; after: ${(after && after.rows.join(' | ')) || 'none'}`;
  return C.observe(page, 'Workflow History after Refresh', text.slice(0, 600));
}

// 1013 INT.010–INT.014 document send. The linked document's own "Send Status" dropdown on the check (options "Do Not
// Send - internal use only" / "Send with Payment", CONFIRMED 2026-11-05) decides whether it goes to OneInc; CC sends it
// when the check leaves "Awaiting submission" (Financials Escalation batch) and then shows the outcome in that column
// ("Not an IR document" for a NON-ImageRight document — check 8200004642). Full Check $1.0x to the claimant from an open
// reserve line, claim document linked as "Send with Payment", Finish, escalate, poll the check (~5 min).
async function sendCheckWithDocument(page, { amount = '1.07' } = {}) {
  const amt = amount;
  const K = require('./workerK');
  const docRow = () => page.evaluate((n) => [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr')
    && (r.innerText || '').toLowerCase().includes(n.toLowerCase())).map((r) => r.innerText.replace(/\s+/g, ' ').trim()).join(' || '), K.DOC_NAME);
  await W.openPayment(page, 'actions');
  await W.selectPayee(page, 'claimant');
  await W.clickButton(page, 'Next');
  await W.settle(page, 2500);
  await W.selectReserveLine(page, 'open');
  await W.completePaymentsStep(page, { transactionType: 'Partial Payment', amount: amt });
  await W.clickButton(page, 'Next');
  await W.settle(page, 3000);
  await K.linkDocument(page);
  await page.locator('select[name$="TransactionSetDocumentsLV-0-SendStatus"]').first().selectOption({ label: 'Send with Payment' });
  await W.settle(page, 1500);
  await W.answerUnansweredNo(page).catch(() => {});
  for (let i = 0; i < 3; i++) {
    const fin = page.getByRole('button', { name: 'Finish', exact: true }).first();
    if (!await fin.isVisible().catch(() => false)) break;
    await fin.click();
    await W.settle(page, 4000);
  }
  if (await page.getByRole('button', { name: 'Finish', exact: true }).first().isVisible().catch(() => false)) {
    const s = await require('../screenReader').readScreen(page);
    throw new W.Blocked(`the check with the linked document did not finish: ${[...s.messages, s.south].join(' / ').slice(0, 300)}`);
  }
  page.__createdCheck = { amount: amt };
  const esc = await C.escalateChecks(page, amt);
  let row = '';
  for (let t = 0; t < 10; t++) {
    await C.openCheck(page, { amount: amt });
    row = await docRow();
    if (/Sent Successfully|Not an IR|Failed|Over Size/i.test(row)) break;
    await page.waitForTimeout(30000);
  }
  const m = /Other\s+(.*?)\s+\S+ \S+ \d{2}\/\d{2}\/\d{4}/.exec(row);
  await C.observe(page, 'Document Send Status', (m ? m[1] : row || 'document not listed on the check').slice(0, 200));
  return `${esc}; document row: ${row.slice(0, 200)}`;
}

module.exports = (api) => {
  const { add, V, H, VAL, NEW_LINE, QOPEN, PRIMARY, INS, CLM, CPD_NOTE } = api;
  const FIN = { call: ['recipes/workerK.finishWithDocument'] };
  const OUT = (re) => V('Finish outcome', { value: re });
  // Reached Finish (submitted, or stopped there by something else) and the rule's text is not in what CC showed.
  const NOT_SHOWN = (re) => OUT(new RegExp(`^(?![\\s\\S]*(?:${re.source}))(?:submitted|stopped at Finish)[\\s\\S]*`, 'i'));
  const SUBMITS = 'Finish runs only with ONEINC_ALLOW_FINISH=1; a check no rule stops is SUBMITTED on TEST (amounts over the adjuster authority are held for approval).';

  // ════ VBR.008 — Property Damage (Other Than Vehicle) settlement over $2,500 needs a notarized release ═══════════
  const VBR008 = /signed and notarized release/i;
  const PD = 'Other Than Vehicle';
  const VEH = '1st Party Vehicle';
  const FULL_CC = (amount, line) => [{ open: 'full' }, { payee: 'claimant' }, { next: true }, { reserve: `match:${line}` },
    { step2: { transactionType: 'Partial Payment', amount } }, FIN];
  const QUICK_CC = (amount, line) => [{ call: ['reuseExt.openQuickOnRow', 'claim cost', Math.ceil(Number(amount)) + 1, line] }, { payee: 'claimant' },
    { step2: { transactionType: 'Partial Payment', amount } }, FIN];
  const PD_NOTE = 'New PA auto claim with a third-party "Property Damage Other Than Vehicle Damage" exposure (Property Damage Liability › PD Liability - Other than Vehicle Damage) reserved at $6,000 (profile MS_PA_PD); claim cost Partial Payment to the claimant from that line, a claim document linked (VBR.010). ';
  const VEH_NOTE = 'Claim cost Partial Payment from the first-party Vehicle line (profile MS_PA_BIG: reserved up to $151,000) — an exposure that is not Property Damage Other Than Vehicle; a claim document linked (VBR.010). ';
  add('GCCM-763/VBR/TC-023', 'MS_PA_PD', FULL_CC('2500.01', PD), [OUT(VBR008)], PD_NOTE + 'Stops at the warning (nothing submitted).');
  add('GCCM-1003/VBR/TC-106', 'MS_PA_PD', QUICK_CC('2500.01', PD), [OUT(VBR008)], PD_NOTE + 'Quick Payment from that reserve row. Stops at the warning (nothing submitted).');
  add('GCCM-763/VBR/TC-024', 'MS_PA_PD', FULL_CC('2500.00', PD), [NOT_SHOWN(VBR008)], PD_NOTE + 'Boundary: exactly $2,500.00. ' + SUBMITS);
  add('GCCM-1003/VBR/TC-107', 'MS_PA_PD', QUICK_CC('2500.00', PD), [NOT_SHOWN(VBR008)], PD_NOTE + 'Quick Payment from that reserve row. Boundary: exactly $2,500.00. ' + SUBMITS);
  add('GCCM-763/VBR/TC-025', 'MS_PA_BIG', FULL_CC('3000.00', VEH), [NOT_SHOWN(VBR008)], VEH_NOTE + SUBMITS);
  add('GCCM-1003/VBR/TC-108', 'MS_PA_BIG', QUICK_CC('3000.00', VEH), [NOT_SHOWN(VBR008)], VEH_NOTE + 'Quick Payment from that reserve row. ' + SUBMITS);

  // ════ VBR.011 — expense check cannot exceed $99,999 ("Must do a manual check for full amount") ═══════════════════
  const VBR011 = /manual check for full amount/i;
  const BIG_EXP = '99999.99';
  add('GCCM-763/VBR/TC-032', 'MS_PA_BIG', [...NEW_LINE('Adjuster Expense', 'vendor'), { step2: { transactionType: 'First and Final', amount: BIG_EXP, exact: true } }, FIN],
    [NOT_SHOWN(VBR011)], 'Adjuster Expense First and Final of exactly $99,999.99 on a new "Expense OR First and Final" line to an Address Book vendor, a claim document linked (VBR.010). ' + SUBMITS);
  add('GCCM-1003/VBR/TC-115', 'MS_PA_BIG', [{ call: ['manualToAuto.openQuickOnExpenseRow'] }, { payee: 'vendor' }, { step2: { transactionType: 'First and Final', amount: BIG_EXP, exact: true } }, FIN],
    [NOT_SHOWN(VBR011)], 'Quick Payment from the claim\'s Adjuster Expense row (built first with a $1.4x vendor First and Final when the claim has none): First and Final of exactly $99,999.99 to an Address Book vendor, a claim document linked (VBR.010). ' + SUBMITS);
  const BIG_NOTE = 'Claim cost Partial Payment of $150,000.00 to the claimant from the first-party Vehicle line, reserved up to $151,000 (profile MS_PA_BIG); a claim document linked (VBR.010). ';
  add('GCCM-763/VBR/TC-033', 'MS_PA_BIG', FULL_CC('150000.00', VEH), [NOT_SHOWN(VBR011)], BIG_NOTE + SUBMITS);
  add('GCCM-1003/VBR/TC-116', 'MS_PA_BIG', QUICK_CC('150000.00', VEH), [NOT_SHOWN(VBR011)], BIG_NOTE + 'Quick Payment from that reserve row. ' + SUBMITS);

  // VBR.013 (763 TC-038, supplemental on an exposure with no reserve history) stays manual — caseReasons.js: a new exposure
  // gets a $1,000 Claim Cost reserve as it is created (2026-11-05), so "no reserve history" cannot be built on TEST.

  // ════ CPD.003 / CPD.004 — single Insured / Claimant payee, no recurrence → Contact(s) / Customer Choice (Quick) ══
  const QCPD = (who) => [QOPEN('open'), ...PRIMARY(who), { step2: {} }, { next: true }, { expectStep: 2 }];
  const CONTACTS_CHOICE = [V('ClaimsPay Type', { value: /^contact\(s\)$/i }), V('ClaimsPay Method', { value: /customer choice|let customer pick/i })];
  add('GCCM-1003/CPD/TC-212', 'PROP_PA', QCPD(INS), CONTACTS_CHOICE, CPD_NOTE + ' Quick Payment; single payee = the Insured; no check recurrence.');
  add('GCCM-1003/CPD/TC-214', 'PROP_PA', QCPD(CLM), CONTACTS_CHOICE, CPD_NOTE + ' Quick Payment; single payee = the Claimant; no check recurrence.');

  // ════ GCCM-1008 — Additional Payment Details, upper section ══════════════════════════════════════════════════════
  // CONFIRMED 2026-10-28 (12830404): One Inc Payment Number, CR Tracking Number, Additional Details, Payment Amount,
  // Current Payment Status. On TEST OneInc never reports back, so the "shown when not null" fields fed by OneInc stay empty.
  const NEW_CHECK = (opts) => ({ call: ['recipes/manualSweep.openNewCheck', opts] });
  const APD = { call: ['checkOps.openAPD'] };
  // One Inc Payment Number is "displays when not null" and comes from OneInc: a new TEST check never gets one (2026-11-05,
  // check 8200004618: Workflow History only "Attempting to send payment ... to One Inc"), so it is not asserted.
  const ALWAYS = [V('CR Tracking Number', { value: /\S/ }), V('Additional Details'), V('Payment Amount', { value: /\$\s?\d/ }), V('Current Payment Status')];
  const NO_DIGITAL = [H('ClaimsPay Method Id'), H('Preferred ClaimsPay Method'), H('Account Number')];
  const APD_NV = 'NOT VERIFIED: the fields CC shows only once OneInc returns them (One Inc Payment Number, Expedite/Certified Tracking No., ClaimsPay Method Id, Preferred ClaimsPay Method, the Current Payment Status value) — OneInc does not report back on TEST.';
  add('GCCM-1008/APD/TC-009', 'AUTO_PA_NOEMAIL', [NEW_CHECK({ payee: 'claimant' })],
    [{ text: { re: /Mailed Check/i, present: true } }, APD, ...ALWAYS, ...NO_DIGITAL, H('Loan Number')],
    'Claim whose claimant has no payment contact details, so the check defaults to Other / Mailed Check (CPD.001): a $0.4x check is created, its Check/Payment Details must say Mailed Check, then Additional Payment Details is opened. ' + APD_NV);
  add('GCCM-1008/APD/TC-010', 'AUTO_LIEN', [NEW_CHECK({ payee: 'lienholder', type: 'Lienholder/Mortgagee' })],
    [APD, ...ALWAYS, V('Loan Number', { value: /\S/ }), ...NO_DIGITAL],
    'PA auto claim with a vehicle loan naming the lienholder: a $0.4x check to the lienholder named on the loan (payee Type Lienholder/Mortgagee — the case "payee type is Lienholder"; with the Insured as primary and the lienholder joint, Loan Number was not shown, 2026-11-05 check 8200004625) is created, then its Additional Payment Details is opened; Loan Number must show the loan number. ' + APD_NV);

  // ════ GCCM-1008 — Workflow History (UIF.020–UIF.022) ═════════════════════════════════════════════════════════════
  // A new TEST check gets its own entry ("Attempting to send payment with PMethod 'Mailed Check' to One Inc", CONFIRMED
  // 2026-11-05 on check 8200004618), so no OneInc feedback is needed for these two.
  const WH_NOTE = 'The newest numbered check on the claim (else a new $0.4x mailed check) is opened in Additional Payment Details; the entry CC writes when it sends the check to OneInc is the workflow event. NOT VERIFIED: that the rows come from ExtDigitalPaymentWorkflow (not visible in the UI).';
  add('GCCM-1008/APD/TC-003', 'AUTO_PA_NOEMAIL', [{ call: ['recipes/manualSweep.openSentCheckAPD'] }, { call: ['recipes/manualSweep.workflowHistory'] }],
    [V('Workflow History', { value: /^columns: Date, Description; [1-9]\d* entr/ })], WH_NOTE);
  add('GCCM-1008/APD/TC-006', 'AUTO_PA_NOEMAIL', [{ call: ['recipes/manualSweep.openSentCheckAPD'] }, { call: ['recipes/manualSweep.workflowUnchanged'] }],
    [V('Workflow History after Refresh', { value: /^unchanged after Refresh \([1-9]/ })], WH_NOTE + ' Refresh is pressed with no workflow event in between.');

  // ════ GCCM-1013 INT.010 — Send Status "Not an IR Document" ══════════════════════════════════════════════════════
  add('GCCM-1013/INT/TC-108', 'MS_PA_PD', [{ call: ['recipes/manualSweep.sendCheckWithDocument'] }],
    [V('Document Send Status', { value: /^Not an IR document$/i })],
    'Full Check $1.07 to the claimant with the claim document "OneInc automation - supporting document" (a NON-ImageRight document) linked as "Send with Payment"; the Financials Escalation batch is run (as the admin user) so CC sends the check, then the check\'s document Send Status is read. ' + SUBMITS);
};
Object.assign(module.exports, { openNewCheck, workflowHistory, workflowUnchanged, sendCheckWithDocument, openSentCheckAPD });
