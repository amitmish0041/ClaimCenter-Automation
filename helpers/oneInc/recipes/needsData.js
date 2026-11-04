/**
 * helpers/oneInc/recipes/needsData.js — cases that were classified "needs data" and are automatable once the suite
 * builds the claim state itself (review 2026-11-03, user direction "lets automate whatever we can").
 *
 * Setup steps: helpers/oneInc/needsData.js (no-first-name payee, claimant address cleared, Medicare ICD codes, Send
 * Status options, check status), contactManager.setLevy (ContactManager vendor Levy, reverted afterwards),
 * setupA.setIndemnityExposure (Lump Sum Medical Extinguishment), setupA.setAggregateLimit, recipes/workerK (claim
 * document + Link Document). Claims: AUTO_PA / WC_PA / WCA_LW (new each run), ND_PA_MED (new PA auto with a Medical
 * Expense exposure, profiles/needsData.js), AUTO_MD_AGED (existing MD claim with a third-party Bodily Injury exposure).
 */
'use strict';

module.exports = (api) => {
  const { add, V, H, VAL, CC, QCC, FULL_PAYMENTS, FULL_INSTRUCTIONS, QUICK_DETAILS } = api;
  const nd = (fn, ...a) => ({ call: [`needsData.${fn}`, ...a] });
  const sa = (fn, ...a) => ({ call: [`setupA.${fn}`, ...a] });
  const op = (fn, ...a) => ({ call: [`checkOps.${fn}`, ...a] });
  const wk = (fn, ...a) => ({ call: [`recipes/workerK.${fn}`, ...a] });
  const msg = (re, present = true) => ({ message: { re, present } });
  const REQ = sa('fillRequired'); // WC payments need Memo Phrase etc. before Next

  // ── VBR.016 negatives — exposure whose Primary Coverage is not Extraordinary/Extended Medical Benefits ──────────
  const EMB_NOTE = 'Payment on the claim\'s first-party vehicle (Collision) line: Primary Coverage is not Extraordinary/Extended Medical Benefits and there is no "Date Yearly EMB Period Begins", so no EMB error may appear (the case\'s "Liability" is one example of a non-EMB coverage). Submits $1.37.';
  add('GCCM-763/VBR/TC-047', 'AUTO_PA', VAL(CC('Partial Payment', '1.37'), null), [msg(/Date Yearly EMB Period/i, false)], EMB_NOTE);
  add('GCCM-1003/VBR/TC-130', 'AUTO_PA', VAL(QCC('Partial Payment', '1.37'), null), [msg(/Date Yearly EMB Period/i, false)], EMB_NOTE + ' Quick Payment.');

  // ── UIF.056 (Quick Payment) — the attorney/settlement question is hidden on WC claims ─────────────────────────
  // Same rule as GCCM-799 UIF TC-055 (Full Check, passing on a PA WC claim): LossType = WC hides it in every state.
  const ATTY = 'Is this payment to an attorney or representative of the insured or claimant AND is the settlement payment or payment of a judgment?';
  add('GCCM-1003/UIF/TC-072', 'WC_PA', QUICK_DETAILS(), [H(ATTY)],
    'Uses a PA WC claim: the visible condition is LossType != WC AND state in VA/GA/PA/MD (or DE with reportable amount >= $5,000), so a WC loss type hides the question whatever the state — the same reasoning as GCCM-799 UIF TC-055.');

  // ── VBR.042 — payee without a first name ───────────────────────────────────────────────────────────────────────
  const NOFIRST = 'NOFIRSTNAME';
  add('GCCM-1013/VBR/TC-047', 'AUTO_PA', VAL([nd('addLastNameOnlyContact', NOFIRST), { open: 'full' }, { select: ['Name', NOFIRST] }, { next: true }, { reserve: 'open' },
    // CC's wording (CONFIRMED 2026-11-03, at Next on Step 1): "Payee NOFIRSTNAME must have a first name and last name."
    { step2: { transactionType: 'Partial Payment', amount: '1.37' } }], /must have (a )?first (name )?and last name/i), [],
  `Setup: a claim-only person "${NOFIRST}" with a last name and NO first name (Parties Involved › New Contact › Person, role Covered Party — only Last name is required there), picked as the payee.`);

  // ── VBR.098 — claim that has not passed Ability to Pay ─────────────────────────────────────────────────────────
  add('GCCM-1013/VBR/TC-100', 'WC_PA', [nd('clearClaimantAddress'), nd('tryNewPayment')],
    [V('New Payment outcome', { value: /has not passed the .?Ability to Pay.? validation level/i })],
    'New PA WC claim (its injured-worker claimant is a claim-only contact; a PA auto claimant is an Address Book contact with no Edit). Setup: the claimant\'s Address 1 and City cleared (Parties Involved › Edit), which fails Ability to Pay ("claimant\'s primary address … must not be empty"); then Actions › New Payment. The claim is used by this case only.');

  // ── VBR.060 — vendor payee with a levy attached (ContactManager) ───────────────────────────────────────────────
  const LEVY_VENDOR = 'ESQUIRE DEPOSITION SOLUTIONS LLC';
  const LEVY_TAX = '45-3463120';
  add('GCCM-1013/VBR/TC-077', 'AUTO_PA', VAL([{ call: ['contactManager.setLevy', LEVY_VENDOR, LEVY_TAX, 'LEVY ATTACHED'] }, { open: 'full' },
    { call: ['reuseExt.selectVendorByTaxId', 'ESQUIRE DEPOSITION', LEVY_TAX] }, { next: true }, { reserve: 'open' },
    { step2: { transactionType: 'Partial Payment', amount: '1.37' } }], /levy attached to this payee/i), [{ call: ['contactManager.restoreVendors'] }],
  `Setup: ContactManager vendor ${LEVY_VENDOR} (${LEVY_TAX}) Levy set to "LEVY ATTACHED" and restored to its original value afterwards (contactManager.js ledger); payee = that vendor from the Address Book. Needs CM_USER / CM_PASS.`);

  // ── VBR.053 / VBR.090 — service period after the Lump Sum Medical Extinguishment date (WC lost wages) ───────────
  const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); };
  const EXT_DATE = daysAgo(3);
  const BASE_EXPO = { 'Average Weekly Wage': '800.00', 'Disability Weekly Rate': '500.00', 'Disability Type': 'TTD', 'Benefit Offset Code': 'None', 'Reason TTD or TPD Ended': '<none>' };
  const EXTINGUISHED = sa('setIndemnityExposure', { ...BASE_EXPO, 'Lump Sum Medical Extinguishment': 'Medical payments are extinguished', 'Date of Extinguishment': EXT_DATE });
  const LW = (start, end) => [EXTINGUISHED, { open: 'full' }, { payee: 'claimant' }, { next: true }, { select: ['Reserve Line', /Indemnity/] },
    { select: ['Transaction Type', 'Partial Payment'] }, sa('selectLineCategory', '^05'), { step2: { transactionType: 'Partial Payment', amount: '1.37' } }, REQ,
    { fill: ['Service Period Start', start] }, { fill: ['Service Period End', end] }];
  const EXT_RE = /Cannot be later than Lump Sum Medical Extinguishment Date/i;
  const EXT_NOTE = `Setup: the WC claim's Indemnity (Lost Wages) exposure gets "Lump Sum Medical Extinguishment" = Medical payments are extinguished, Date of Extinguishment ${EXT_DATE} (3 days before the run); WC indemnity (TTD, line category 05) payment on that line.`;
  add('GCCM-1013/VBR/TC-068', 'WCA_LW', VAL(LW('TODAY-1', 'TODAY'), EXT_RE), [], EXT_NOTE + ' Service Period Start (yesterday) is after the extinguishment date.');
  add('GCCM-1013/VBR/TC-091', 'WCA_LW', VAL(LW('TODAY-5', 'TODAY'), EXT_RE), [], EXT_NOTE + ' Service Period Start (5 days ago) is before, Service Period End (today) after the extinguishment date.');

  // ── VBR.049 — Medicare ICD codes on a third-party Bodily Injury exposure (non-WC) ─────────────────────────────
  const BI = 'Bodily Injury';
  const MEDICARE = (icd) => nd('setExposureMedicare', BI, { beneficiary: 'Yes', icd });
  const MEDICARE_RESET = nd('setExposureMedicare', BI, { beneficiary: '<none>', icd: null });
  const BI_PAY = [...FULL_PAYMENTS('claimant', `match:${BI}`), { step2: { transactionType: 'Partial Payment', amount: '1.37' } }];
  const ICD = 'S13.4XXA';
  const MED_NOTE = 'MD personal auto claim (existing, AUTO_MD_AGED): exposure "(1) 3rd Party Bodily Injury Liability" (Loss Party third-party, Primary Coverage Liability - Auto bodily injury). Setup on its Medicare tab, put back to <none> / no ICD codes afterwards; Claim Cost payment on that line.';
  add('GCCM-1013/VBR/TC-060', 'AUTO_MD_AGED', VAL([MEDICARE(null), ...BI_PAY], /Please enter at least one included ICD diagnostic code/i), [MEDICARE_RESET],
    MED_NOTE + ' "Is Claimant a Medicare Beneficiary?" = Yes, no included ICD code.');
  add('GCCM-1013/VBR/TC-061', 'AUTO_MD_AGED', VAL([MEDICARE(ICD), ...BI_PAY], null), [msg(/included ICD diagnostic code/i, false), MEDICARE_RESET],
    MED_NOTE + ` "Is Claimant a Medicare Beneficiary?" = Yes, included ICD code ${ICD}. Submits $1.37.`);

  // ── VBR.089 — "Please review Aggregate Limits" (policy aggregate limit + claim cost on a third-party exposure) ──
  add('GCCM-1013/VBR/TC-090', 'AUTO_MD_AGED', [sa('setAggregateLimit', 100000), ...BI_PAY, sa('finishOnce')],
    [msg(/Please review Aggregate Limits/i), sa('closeWizard'), sa('setAggregateLimit', null)],
    'MD personal auto claim (existing): Policy › Aggregate Limits gets a $100,000 Policy limit (removed afterwards); the claim already has Claim Cost payments on its third-party "(1) 3rd Party Bodily Injury Liability" exposure, and a new $1.37 one is made there with Finish pressed once so the warning stays on screen. With no warning the payment is submitted.');

  // ── UIF.068 — Send Status options of a linked document ─────────────────────────────────────────────────────────
  add('GCCM-1013/UIF/TC-002', 'AUTO_PA', [wk('addDocument'), ...FULL_INSTRUCTIONS('claimant'), wk('linkDocument'), nd('sendStatusOptions')],
    [V('Send Status options', { value: /^(?![\s\S]*Send by Email)[\s\S]*Send with Payment/i })],
    'Setup: a claim document record ("Indicate the existence of NON-ImageRight document/media", no file — cloud TEST has no upload), linked on Step 3 with "Link Document"; the Send Status dropdown of that row is read. The wizard is cancelled (nothing submitted).');

  // ── VBR.038 — escalation after 2+ earlier Supplemental payments on the same exposure ─────────────────────────────
  // Supplemental payments need a closed reserve: a Final Payment closes the line, then three Supplemental payments are
  // submitted on it; the third is the one under test (two earlier ones exist). Escalated = held "Pending approval".
  const PAY = (line, txn, amount, wc) => VAL([...FULL_PAYMENTS('claimant', line), { step2: { transactionType: txn, amount } }, ...(wc ? [REQ] : [])], null);
  const SUPP3 = (line, wc = false) => [...PAY(line, 'Final Payment', '1.00', wc), ...PAY(line, 'Supplemental Payment', '0.51', wc),
    ...PAY(line, 'Supplemental Payment', '0.52', wc), ...PAY(line, 'Supplemental Payment', '0.53', wc)];
  const ESCALATED = [nd('checkStatus', '0.53'), V('Check status', { value: /Pending approval/i })];
  const NOT_ESCALATED = [nd('checkStatus', '0.53'), V('Check status', { value: /^(?!Pending approval)/i })];
  const SUPP_NOTE = 'A $1.00 Final Payment closes the line, then Supplemental payments of $0.51 and $0.52 are submitted (the two earlier ones) and the $0.53 Supplemental is the payment under test; its status and Approval History are read from Check/Payment Details (escalated = held "Pending approval"). Submits 4 payments, all at or under $1.00: on some new claims the adjuster\'s authority holds any payment over $1.00 for approval ("The amount of the payment exceeds $1.00", 2026-11-03), which would keep the Final Payment from closing the line.';
  const MED_LINE = 'match:Medical Expense';
  add('GCCM-1013/VBR/TC-037', 'ND_PA_MED', SUPP3(MED_LINE), ESCALATED,
    'New PA auto claim with a "Medical Expense" exposure (first-party medical coverage, not WC). ' + SUPP_NOTE);
  add('GCCM-1013/VBR/TC-038', 'WC_PA', SUPP3('match:Medical', true), ESCALATED,
    'New PA WC claim: the Medical exposure (Coverage Subtype Workers\' Comp - Medical Details). ' + SUPP_NOTE);
  add('GCCM-1013/VBR/TC-039', 'AUTO_PA', SUPP3('match:Collision|Vehicle'), NOT_ESCALATED,
    'New PA auto claim: the first-party vehicle (Collision) line — neither a medical coverage nor WC Medical Details. ' + SUPP_NOTE);

  // ── VBR.040 — "Supplemental Issued on Closed File" activity (sp_closed) ─────────────────────────────────────────
  // Same shape as GCCM-1013 VBR TC-043 (vehicle line): Final Payment closes the line, a Supplemental is paid on it, the
  // Financials Escalation batch moves it to Requesting (admin login), then the Workplan is read.
  const SUPP1 = (line, wc = false) => [...PAY(line, 'Final Payment', '1.00', wc), ...PAY(line, 'Supplemental Payment', '0.98', wc)];
  const SP_CLOSED = /Supplemental Issued on Closed File/i;
  const SPC_NOTE = 'A $1.00 Final Payment closes the line, then a $0.98 Supplemental Payment is submitted on it; the Financials Escalation batch is run (Server Tools, admin login) so the check moves to Requesting, then the Workplan is read.';
  add('GCCM-1013/VBR/TC-044', 'WC_PA', SUPP1('match:Medical', true), [op('escalateChecks', '0.98'), op('workplan'), V('Workplan activities', { value: SP_CLOSED })],
    'New PA WC claim, Medical exposure (Workers\' Comp - Medical Details). ' + SPC_NOTE);
  add('GCCM-1013/VBR/TC-045', 'ND_PA_MED', SUPP1(MED_LINE), [op('escalateChecks', '0.98'), op('workplan'), V('Workplan activities', { value: /^(?![\s\S]*Supplemental Issued on Closed File)/i })],
    'New PA auto claim, "Medical Expense" exposure (first-party medical coverage, not WC Medical Details), so no sp_closed activity may appear. ' + SPC_NOTE);
};
