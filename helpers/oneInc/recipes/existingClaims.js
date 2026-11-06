/**
 * helpers/oneInc/recipes/existingClaims.js — cases run on EXISTING TEST claims found by search (profiles/existingClaims.js,
 * user direction 2026-11-06). The steps reuse the suite's own builders and helpers (setupC.openFromActions, checkOps void
 * operations, the WC lost-wages payment of recipes/fullCheck1013.js); only the claim differs.
 */
'use strict';

module.exports = (api) => {
  const { add, V, VAL, FULL_PAYMENTS, QCC } = api;
  const op = (fn, ...args) => ({ call: [`checkOps.${fn}`, ...args] });
  const sa = (fn, ...args) => ({ call: [`setupA.${fn}`, ...args] });
  const sc = (fn, ...args) => ({ call: [`setupC.${fn}`, ...args] });
  const EX = (claimNote) => `Existing TEST claim found by search (${claimNote}) — documented exception to fresh test data: this state cannot be built on TEST. `;

  // ── VBR.065 — payment on a claim with no assigned user ──────────────────────────────────────────────────────────
  add('GCCM-1013/VBR/TC-082', 'EX_UNASSIGNED', [sc('openFromActions', 'actions')],
    [{ text: { re: /Please assign the claim and exposure\(s\) before payment/i, present: true } }],
    EX('adjuster "Pending Assignment"') + 'Actions › New Payment is opened and the error read; nothing is saved.');

  // ── VBR.037 — surcharge rule does not apply before 1/1/2013 ─────────────────────────────────────────────────────
  const NO_ERROR = [{ text: { re: /New Payment Error|Please complete the Surcharging/i, present: false } }, { button: { name: 'Next', present: true } }];
  const OLD = EX('personal auto, loss 07/03/2009') + 'Opened from the Actions menu; nothing saved.';
  add('GCCM-803/TC/TC-049', 'EX_PRE2013', [sc('openFromActions', 'actions')], NO_ERROR, OLD);
  // Quick Payment checks the exposure OWNER first: every pre-2013 claim's owner (Maria Lopez / John Tallent, legacy users) has no
  // e-mail/phone ("Exposure owner … is missing …", 2026-11-06), so the exposures are assigned to Benjamin Smith first (setupA).
  add('GCCM-1003/VBR/TC-193', 'EX_PRE2013', [sa('assignExposuresTo', 'Benjamin Smith', 'Recovery Claims Team 2'), sc('openFromActions', 'quick')], NO_ERROR,
    OLD + ' Quick Payment; the exposures are first assigned to Benjamin Smith (the legacy owner has no e-mail/phone).');

  // ── 787 VBR.001 — void with repost = Yes on a Cleared check ─────────────────────────────────────────────────────
  const REPOST_ERR = /A Repost cannot be completed at this time\. A Payment must be in cleared status to repost/i;
  // A WC claim's void needs Loss Details › Employment Status ("Employment Status must be selected", 2026-11-06) — set if empty.
  add('GCCM-787/TC/TC-009', 'EX_CLEARED', [sa('setLossDetailAnswers', { 'Employment Status': /./ }), op('openCheck', { status: '^Cleared$' }), op('openVoid'), op('submitVoid', 'Automation test - repost of a cleared check', 'Yes')],
    [V('Void outcome', { value: /^void submitted/i }), { message: { re: REPOST_ERR, present: false } }],
    EX('a Cleared check') + 'Opens a Cleared check, Void Payment with reposting = Yes, submitted (TEST). Each run voids one Cleared check.');

  // ── INT.004 / INT.005 — state fraud-language PDF linked to a WC indemnity check ────────────────────────────────
  // Same Indemnity (Lost Wages) payment as recipes/fullCheck1013.js (WCA_LW), then Finish and read the check's Linked Documents.
  const BASE_EXPO = { 'Average Weekly Wage': '800.00', 'Disability Weekly Rate': '500.00', 'Disability Type': 'TTD', 'Benefit Offset Code': 'None', 'Reason TTD or TPD Ended': '<none>' };
  const LW = [sa('setIndemnityExposure', BASE_EXPO), { open: 'full' }, { payee: 'claimant' }, { next: true }, { select: ['Reserve Line', /Indemnity/] },
    { select: ['Transaction Type', 'Partial Payment'] }, sa('selectLineCategory', '^05'), { step2: { transactionType: 'Partial Payment', amount: '1.37' } }, sa('fillRequired'),
    // These claims' payment step asks for the wages again ("Missing required field Disability Weekly Rate" — 2026-11-06).
    { fill: ['Average Weekly Wage', '800.00'] }, { fill: ['Disability Weekly Rate', '500.00'] }];
  // The check's Linked Documents row: "<ST>FraudLanguage.pdf Statutory Language Final <Send Status> Auto-generated". On TEST the
  // Send Status reads "Failed Retrieval from IR" (2026-11-06, UT check 8200005055 / DE $1.37) — recorded, and checked against
  // the expected "Send with Payment".
  const FRAUD = (st) => [op('openCheck', { amount: '1.37' }), { call: ['recipes/existingClaims.fraudDocStatus', st] },
    V(`${st}FraudLanguage.pdf Send Status`, { value: /^Send with Payment$/i })];
  const WC_NOTE = (st) => EX(`${st} WC claim with an Indemnity exposure`) + 'Indemnity (Lost Wages) exposure wages set (AWW 800 / DWR 500 / TTD), $1.37 Partial Payment, line category 05, Finish (TEST); the check\'s Linked Documents are read.';
  add('GCCM-1013/INT/TC-103', 'EX_WC_UT', VAL(LW, null), FRAUD('UT'), WC_NOTE('Utah'));
  add('GCCM-1013/INT/TC-104', 'EX_WC_DE', VAL(LW, null), FRAUD('DE'), WC_NOTE('Delaware'));
  // INT.013 / INT.007 — a linked document that cannot be retrieved from ImageRight: on TEST the auto-linked UTFraudLanguage.pdf of
  // a Utah WC indemnity check ends "Failed Retrieval from IR" (2026-11-06). The Financials Escalation batch sends the check.
  // CC words it "* INDEMNITY *: Document(s) failed to be sent for Digital Payment: <check>" (the case: "…for Payment: <check>") — 2026-11-06.
  const FAILED_ACT = /Document\(s\) failed to be sent for (Digital )?Payment/i;
  const IR_FAIL = [op('escalateChecks', '1.37'), ...FRAUD('UT').slice(0, 2)];
  add('GCCM-1013/INT/TC-111', 'EX_WC_UT', VAL(LW, null), [...IR_FAIL, V('UTFraudLanguage.pdf Send Status', { value: /^Failed Retrieval from IR$/i }), op('workplan'),
    V('Workplan activities', { value: FAILED_ACT })], WC_NOTE('Utah') + ' Its UTFraudLanguage.pdf cannot be retrieved from ImageRight on TEST: Send Status must read "Failed Retrieval from IR" and the digital_payment_failed_to_send activity be created.');
  add('GCCM-1013/INT/TC-106', 'EX_WC_UT', VAL(LW, null), [...IR_FAIL, op('workplan'), V('Workplan activities', { value: FAILED_ACT })],
    WC_NOTE('Utah') + ' The linked UTFraudLanguage.pdf fails to be sent (Failed Retrieval from IR on TEST); the digital_payment_failed_to_send activity "Document(s) failed to be sent for Payment: <check>" must be created.');

  // ── VBR.019 — second First and Final on an exposure that already has an active one ─────────────────────────────
  // A First and Final closes its reserve, so the new one is paid on that ZERO-remaining line.
  const FF_ERR = /Multiple First (&|and) Final not allowed on same exposure/i;
  const FF_NOTE = EX('an exposure with an active First and Final') + 'A $1.37 First and Final on the same (closed) line; the rule must stop Finish.';
  // Full Check: a NEW Claim Cost line on the same exposure — a First and Final on the closed line is refused first by PMS PL08
  // "First and Final payment not allowed with established reserve" (2026-11-06), before VBR.019 is evaluated.
  add('GCCM-763/VBR/TC-054', 'EX_FF_ACTIVE', VAL([...FULL_PAYMENTS('claimant', 'new'), { select: ['Cost Type', 'Claim Cost'] }, { select: ['Exposure', /^\(1\)/] },
    { step2: { transactionType: 'First and Final', amount: '1.37' } }], FF_ERR), [], FF_NOTE + ' Paid on a new Claim Cost line of exposure (1).');
  add('GCCM-1003/VBR/TC-137', 'EX_FF_ACTIVE', VAL(QCC('First and Final', '1.37', 'zero'), FF_ERR), [], FF_NOTE + ' Quick Payment.');

  // VBR.022 Rejected-Final cases (763 TC-062 / 1003 TC-145) are NOT here: the claims found with a Rejected Final Payment
  // (CAA-VA-02-13-0375082, PAF-VA-02-16-0571898) have every exposure closed and a reserve cannot be added back (2026-11-06).

  // ── UIF.032–034 (Full) / UIF.022–024 (Quick) — reinsurance payment fields ─────────────────────────────────────
  // Claims named by the user 2026-11-06 as reinsurance claims; the fields show only when Loss Details › Reinsurance Status has
  // BOTH "Reported to Reinsurer?" and "Is Reinsurance being collected?" = Yes (the cases' precondition), so the setup sets them
  // (CONFIRMED on CAA-PA-01-26-0748098: Post to Reinsurance? → Yes shows Post Partial Amount… → Yes shows Amount to be posted?).
  const REINS = sa('setLossDetailAnswers', { 'Reported to Reinsurer?': 'Yes', 'Is Reinsurance being collected?': 'Yes' });
  const POST = 'Post to Reinsurance?';
  const PARTIAL = 'Post Partial Amount to Reinsurance?';
  const AMOUNT = 'Amount to be posted?';
  const RFULL = [REINS, ...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Partial Payment', amount: '1.37' } }];
  const RQUICK = [REINS, ...QCC('Partial Payment', '1.37')];
  const REQ = (label) => V(label, { required: true, editable: true });
  const R_NOTE = EX('reinsurance claim provided by the user') + 'Loss Details › Reported to Reinsurer? = Yes and Is Reinsurance being collected? = Yes (set if not), then a $1.37 Partial Payment is entered; nothing is submitted.';
  for (const [full, quick, checks, what] of [
    ['GCCM-799/UIF/TC-011', 'GCCM-1003/UIF/TC-028', [REQ(POST)], ''],
    ['GCCM-799/UIF/TC-012', 'GCCM-1003/UIF/TC-029', [{ answer: [POST, 'Yes'] }, REQ(PARTIAL)], ` "${POST}" = Yes.`],
    ['GCCM-799/UIF/TC-013', 'GCCM-1003/UIF/TC-030', [{ answer: [POST, 'Yes'] }, { answer: [PARTIAL, 'Yes'] }, REQ(AMOUNT)], ` "${POST}" = Yes, "${PARTIAL}" = Yes.`],
  ]) {
    add(full, 'EX_REINS', RFULL, checks, R_NOTE + ' Full Check.' + what);
    add(quick, 'EX_REINS', RQUICK, checks, R_NOTE + ' Quick Payment.' + what);
  }
};

// Records the Send Status of the check's <ST>FraudLanguage.pdf linked document (observation "<ST>FraudLanguage.pdf Send Status").
async function fraudDocStatus(page, st) {
  const C = require('../checkOps');
  const row = await page.evaluate((n) => [...document.querySelectorAll('tr[id*="TransactionSetDocumentsLV-"]')].filter((r) => r.offsetParent && !r.querySelector('tr')
    && (r.innerText || '').includes(n)).map((r) => r.innerText.replace(/\s+/g, ' ').trim())[0] || '', `${st}FraudLanguage`);
  const m = /\b(Send with Payment|Do Not Send[^|]*?|Sent Successfully|Failed to Send|Failed Retrieval from IR|Over Size Limit|Not an IR document)\b/i.exec(row);
  return C.observe(page, `${st}FraudLanguage.pdf Send Status`, row ? (m ? m[1] : `unknown (${row.slice(0, 120)})`) : 'not linked to the check');
}
Object.assign(module.exports, { fraudDocStatus });
