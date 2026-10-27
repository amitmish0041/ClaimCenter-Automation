/**
 * helpers/oneInc/recipes/fullCheck1013.js — GCCM-1013 Full Check wizard / Check-Payment Details (Dhayaashree
 * Palanisamy, JRM feedback workbook, added 2026-10-27).
 *
 * Claims: AUTO_PA (OneInc checks already on the claim for the Check/Payment Details fields), HO_SNI (a NEW HO claim each run, on a policy
 * with an Insured and a Secondary Named Insured — the VBR.044 / VBR.069–074 missing-payee rules; names read from the claim),
 * WCA_LW (WC lost-wages exposure — the indemnity rules), WCA_PA (business insured — UIF.080).
 *
 * Rules that only fire on a submitted payment use the core `validate` step (Finish only with ONEINC_ALLOW_FINISH=1).
 * Rules that fire on Next and could submit a large payment if they DON'T fire ($10M, exceeding reserves) use a plain
 * Next and a message check — the wizard is cancelled afterwards, so nothing is submitted.
 *
 * Not automated (classifier reasons): fields/actions that need OneInc to have issued or reported on the check
 * (tracking number, direct-deposit account, preferred method, ClaimsPay comments, print date, aggregate-limit
 * feedback, payment status refresh), document send-status cases (no ImageRight / OneInc document flow on TEST), the
 * payload (INT) cases, and rules needing claim states the suite does not build yet (unassigned claim, Medicare ICD
 * codes, medical extinguishment date, deductible endorsements, bulk payments, ability-to-pay failures).
 */
'use strict';

module.exports = (api) => {
  const { add, V, H, VAL, FULL_PAYEES, FULL_PAYMENTS, FULL_INSTRUCTIONS } = api;
  const op = (fn, ...a) => ({ call: [`checkOps.${fn}`, ...a] });
  const sa = (fn, ...a) => ({ call: [`setupA.${fn}`, ...a] });
  const NEXT = { click: 'Next' };
  const msg = (re, present = true) => ({ message: { re, present } });

  // ── Check/Payment Details of an existing OneInc check (AUTO_PA) ────────────────────────────────────────────────
  const ONEINC = op('openCheck', { status: '^(Requesting|Awaiting submission)$' });
  const DET = 'Opens the newest OneInc check on the claim (status Requesting — on TEST OneInc never moves a check past Requesting, so OneInc-returned values such as External Identifier stay empty).';
  add('GCCM-1013/UIF/TC-004', 'AUTO_PA', [ONEINC], [V('CR Tracking Number', { readonly: true, required: false, value: /\S/ })], DET);
  add('GCCM-1013/UIF/TC-012', 'AUTO_PA', [ONEINC], [H('Expedite / Certified Tracking No.')], DET + ' No tracking number on the check.');
  add('GCCM-1013/UIF/TC-014', 'AUTO_PA', [ONEINC], [H('ClaimsPay Method Id')], DET + ' Not a direct-deposit / recurring check.');
  add('GCCM-1013/UIF/TC-017', 'AUTO_PA', [ONEINC], [H('Account Number')], DET + ' Not a direct-deposit / recurring check.');
  add('GCCM-1013/UIF/TC-019', 'AUTO_PA', [ONEINC], [H('ClaimsPay Comments')], DET + ' No ClaimsPay comments on the check.');
  add('GCCM-1013/UIF/TC-020', 'AUTO_PA', [ONEINC], [H('HiMarley Case ID')], DET);
  add('GCCM-1013/UIF/TC-022', 'AUTO_PA', [ONEINC], [V('One Inc Status', { readonly: true })], DET);
  add('GCCM-1013/UIF/TC-024', 'AUTO_PA', [ONEINC], [H('Stale Date')], DET);
  add('GCCM-1013/UIF/TC-025', 'AUTO_PA', [ONEINC], [H('Escheat Date')], DET);
  add('GCCM-1013/UIF/TC-026', 'AUTO_PA', [ONEINC], [V('Payment Identifier', { readonly: true, value: /\S/ })], DET);
  add('GCCM-1013/UIF/TC-027', 'AUTO_PA', [ONEINC], [V('External Identifier', { readonly: true })], DET + ' The field is checked for presence; its value is filled only once OneInc accepts the payment.');
  add('GCCM-1013/UIF/TC-028', 'AUTO_PA', [ONEINC], [V('Void Identifier', { readonly: true })], DET);
  add('GCCM-1013/UIF/TC-029', 'AUTO_PA', [ONEINC], [V('Aggregate ID', { unlessBlocked: 'shows only when OneInc returned an Aggregate ID — none on TEST' })], DET);
  // Vendor payee linked to the Address Book → no Cell Phone / Email (UIF.078 / UIF.079 negative)
  const VENDOR_CHECK = op('openCheck', { status: '^(Requesting|Awaiting submission)$', payee: 'ADJUSTMENT SERVICES' });
  const VEN = 'Opens the newest OneInc check to ADJUSTMENT SERVICES INC (an Address Book vendor) on the claim.';
  add('GCCM-1013/UIF/TC-006', 'AUTO_PA', [VENDOR_CHECK], [H('Cell Phone')], VEN);
  add('GCCM-1013/UIF/TC-008', 'AUTO_PA', [VENDOR_CHECK], [H('Email')], VEN);
  // Non-vendor payee with e-mail + phone (the HO insured; joint Secondary Named Insured so the check is not held)
  const RC_CHECK = op('openOrCreateCheck', { status: '^(Requesting|Awaiting submission)$', payee: '@insured' }, { payee: 'insured', type: 'Insured', joint: [{ who: 'sni' }] });
  const RC = 'HO claim: opens the newest OneInc check to the insured (who has e-mail and phone in Parties Involved), or creates one (insured + the Secondary Named Insured as joint payee, $1.4x) when there is none.';
  add('GCCM-1013/UIF/TC-005', 'HO_SNI', [RC_CHECK], [V('Cell Phone', { readonly: true, required: false })], RC);
  add('GCCM-1013/UIF/TC-007', 'HO_SNI', [RC_CHECK], [V('Email', { readonly: true, required: false })], RC);
  add('GCCM-1013/UIF/TC-030', 'HO_SNI', [RC_CHECK], [V('Requested ClaimsPay Method', { value: /customer choice/i }), { button: { name: 'Resend Email', present: true } }],
    RC + ' ClaimsPay Method = Customer Choice; the check is in Requesting (OneInc never confirms on TEST).');
  add('GCCM-1013/VBR/TC-081', 'HO_SNI', [RC_CHECK], [{ text: { re: /Joint Payees\s+Payee\s+EMail\s+Phone\s+Type\s+Payee Tax ID\s+\S.*?\s\S+@\S+\.\w+/i, present: true } }],
    RC + ' Checks that the Joint Payees grid of Check/Payment Details carries the payee\'s e-mail (from the Parties Involved payment contact details).');

  // ── Additional Payment Details (AUTO_PA OneInc check) ─────────────────────────────────────────────────────────
  add('GCCM-1013/APD/TC-131', 'AUTO_PA', [ONEINC, op('openAPD')], [H('Funding Details'), { header: { name: 'Escheat Date', present: false } }], DET);
  add('GCCM-1013/APD/TC-132', 'AUTO_PA', [ONEINC, op('openAPD')], [{ header: { name: 'Check Print Date', present: true } }], DET + ' Payment Feedback Received column list.');
  add('GCCM-1013/APD/TC-133', 'AUTO_PA', [ONEINC, op('openAPD')], [{ button: { name: 'Get Payment Status', present: true } }], DET + ' Cloud shows a "Refresh" button on this screen.');

  // ── Wizard fields (AUTO_PA) ───────────────────────────────────────────────────────────────────────────────────
  add('GCCM-1013/UIF/TC-001', 'AUTO_PA', FULL_INSTRUCTIONS('claimant'), [H('Memo/Claim Number'), H('Memo')]);
  add('GCCM-1013/UIF/TC-003', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'open'), { step2: {} }],
    [V('Date of Service'), { next: true }, { expectStep: 3 }, H('Date of Service')], 'Step 2 (Enter payment information) must show Date of Service; Step 3 (instructions) must not.');
  add('GCCM-1013/UIF/TC-010', 'AUTO_PA', FULL_INSTRUCTIONS('claimant'), [H('Is this a Claim Payment to a Business?')], 'Payee = an individual claimant.');
  add('GCCM-1013/UIF/TC-021', 'AUTO_PA', FULL_PAYEES('claimant'), [H('Report Type'), { text: { re: /Tax Reporting/i, present: false } }]);
  add('GCCM-1013/UIF/TC-031', 'AUTO_PA', VAL([op('ensureOpenReserve'), ...FULL_INSTRUCTIONS('claimant')], null), [{ text: { re: /Make This Payment Faster/i, present: false } }, { button: { name: 'Make This Payment Faster', present: false } }],
    'Submits a $1.37 payment (Finish), then checks the screen CC shows after Finish.');
  add('GCCM-1013/UIF/TC-032', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'open'), { step2: {} }, { answer: ['Payment for a total loss?', 'No'] }], [H('VIN')],
    'The OOTB accelerator VIN field is not shown on Enter payment information (only the UIF.107 VIN, which needs total loss = Yes).');
  const TL_YES = [{ answer: ['Payment for a total loss?', 'Yes'] }, { answer: ['Is the owner keeping this Vehicle?', 'No'] }, { answer: ['Is this vehicle owned by the Insured?', 'Yes'] },
    { answer: ['Does this vehicle display on the CLAIM CENTER policy page?', 'Yes'] }];
  add('GCCM-1013/UIF/TC-036', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'open'), { step2: {} }, TL_YES[0]], [V('VIN', { required: true, editable: true })],
    'Total loss answered after the payment details (filling them re-renders the form).');
  // UIF.080 — business-contact payee (the WC policy's insured is a company)
  add('GCCM-1013/UIF/TC-009', 'WCA_PA', [sa('setClaimDenied', 'No'), { open: 'full' }, sa('selectInsuredPayee'), { next: true }, { reserve: 'open' }, { step2: {} }, sa('fillRequired'), { next: true }, { expectStep: 3 }],
    [V('Is this a Claim Payment to a Business?', { required: true, editable: true })], 'Payee = the insured of the automation PA WC claim, a company (business contact).');

  // ── Payee rules on Next from Step 1 (AUTO_PA) ─────────────────────────────────────────────────────────────────
  const FIRST_LAST = /must have first and last name/i;
  add('GCCM-1013/VBR/TC-048', 'AUTO_PA', [...FULL_PAYEES('claimant'), NEXT], [msg(FIRST_LAST, false), { expectStep: 2 }], 'Payee = a person with first and last name.');
  const TAXID_AB = /has a payee type of Vendor or Other\. A tax id is required and this payee must be pulled from the address book/i;
  add('GCCM-1013/VBR/TC-049', 'AUTO_PA', [{ open: 'full' }, { payee: 'claimant' }, { select: ['Type', 'Other'] }, NEXT], [msg(TAXID_AB)],
    'Payee = the claimant (a claim contact, not in the Address Book, no Tax ID) with payee Type set to Other.');
  add('GCCM-1013/VBR/TC-050', 'AUTO_PA', [{ open: 'full' }, { payee: 'vendor' }, NEXT], [msg(TAXID_AB, false), { expectStep: 2 }], api.VENDOR_NOTE);
  // VBR.045 / VBR.046 / VBR.068 — Pay To The Order Of
  const EDIT_WARN = /When the 'pay to the order of' field is edited please ensure additional payees are added to the joint payee table/i;
  add('GCCM-1013/VBR/TC-054', 'AUTO_PA', [...FULL_PAYEES('claimant'), { click: 'Edit' }], [msg(EDIT_WARN)], 'Edit pressed on "Pay To The Order Of" with no additional payee.');
  const LONG = 'A'.repeat(201);
  add('GCCM-1013/VBR/TC-055', 'AUTO_PA', [...FULL_PAYEES('claimant'), { click: 'Edit' }, { fill: ['Pay To The Order Of', LONG] }, op('fieldLength', 'Pay To The Order Of'), NEXT], [V('Pay To The Order Of length', { value: /d/ }), msg(/Pay To may only contain 200 characters/i)], '201 characters entered.');
  add('GCCM-1013/VBR/TC-084', 'AUTO_PA', [...FULL_PAYEES('claimant'), { click: 'Edit' }, { fill: ['Pay To The Order Of', LONG] }, op('fieldLength', 'Pay To The Order Of'), NEXT], [V('Pay To The Order Of length', { value: /d/ }), msg(/"?Pay to the Order Of"? may not exceed 200 characters/i)], '201 characters entered.');
  // VBR.062 — Edit Mailing Address with a required part blank
  add('GCCM-1013/VBR/TC-079', 'AUTO_PA', [...FULL_PAYEES('claimant'), op('toggle', 'Do you want to edit the Mailing Address?'), { fill: ['Address 1', ''] }, NEXT],
    [msg(/Required fields on Address missing/i), msg(/Missing required field "Address 1"/i)],
    '"Do you want to edit the Mailing Address?" ticked and Address 1 cleared. The design expects "Required fields on Address missing." for the edited address and the per-field messages for a New address; both are checked.');

  // ── Payment amount rules on Next from Step 2 (AUTO_PA; never Finish) ──────────────────────────────────────────
  const PAY = (step2, pre = []) => [...FULL_PAYMENTS('claimant', 'open'), ...pre, { step2 }, NEXT];
  const TEN_M = /consult your Claim Supervisor for instructions on issuing payments in excess of \$10M/i;
  add('GCCM-1013/VBR/TC-056', 'AUTO_PA', PAY({ transactionType: 'Final Payment', amount: '10000001.00' }), [msg(TEN_M)], 'Gross amount $10,000,001.00 (Final Payment, so the partial-payment reserve rule does not answer first). Next only — never Finish.');
  add('GCCM-1013/VBR/TC-057', 'AUTO_PA', PAY({ amount: '1.37' }), [msg(TEN_M, false)], 'Gross amount $1.37. Next only.');
  const SC04 = /PMS SC04\s*:\s*Partial payment exceeds Reserves for its ReserveLine/i;
  add('GCCM-1013/VBR/TC-062', 'AUTO_PA', PAY({ transactionType: 'Partial Payment', amount: 'EXCEED' }), [msg(SC04)], 'Partial Payment of the line\'s Available Reserves + $100. Next only.');
  add('GCCM-1013/VBR/TC-063', 'AUTO_PA', PAY({ transactionType: 'Final Payment', amount: 'EXCEED' }), [msg(SC04, false)], 'Final Payment of the line\'s Available Reserves + $100. Next only — never Finish.');
  const MISMATCH = /This amount does not match the total amount of the check/i;
  add('GCCM-1013/VBR/TC-064', 'AUTO_PA', PAY({ amount: '1.37', lineAmount: '1.00' }), [msg(MISMATCH)], 'Total Amount of Payment $1.37, line item $1.00.');
  add('GCCM-1013/VBR/TC-065', 'AUTO_PA', PAY({ amount: '1.37' }), [msg(MISMATCH, false)], 'Total Amount of Payment = line item = $1.37.');
  // VBR.048 — two Claim Cost payments on one exposure; VBR.063 — 1099 Box # carried to the next payment (vendor check)
  const SAME_EXPO = /The same exposure .* is selected on multiple payments/i;
  add('GCCM-1013/VBR/TC-058', 'AUTO_PA', [{ open: 'full' }, { payee: 'vendor' }, { next: true }, { reserve: 'open' }, { step2: { amount: '1.37' } },
    { click: 'Add Payment' }, { reserve: 'open' }, { step2: { amount: '1.38' } }, NEXT], [msg(SAME_EXPO)],
  'Two Claim Cost payments on the same reserve line (Add Payment). Payee = an Address Book vendor.');
  add('GCCM-1013/VBR/TC-059', 'AUTO_PA', [{ open: 'full' }, { payee: 'vendor' }, { next: true }, { reserve: 'open' }, { step2: { amount: '1.37' } },
    { click: 'Add Payment' }, { reserve: 'new' }, { select: ['Cost Type', 'Adjuster Expense'] }, { step2: { transactionType: 'First and Final', amount: '1.38' } }, NEXT], [msg(SAME_EXPO, false)],
  'Claim Cost payment + an Adjuster Expense payment (new line on the first exposure) on one check. Payee = an Address Book vendor.');
  add('GCCM-1013/VBR/TC-080', 'AUTO_PA', [{ open: 'full' }, { payee: 'vendor' }, { next: true }, { reserve: 'new' }, { select: ['Cost Type', 'Adjuster Expense'] },
    { step2: { transactionType: 'First and Final', amount: '1.37' } }, { select: ['1099 Box Number', /^06/] }, { click: 'Add Payment' }, { reserve: 'new' }, { select: ['Cost Type', 'Adjuster Expense'] }],
  [V('1099 Box Number', { value: /^06/ })], 'Vendor check: 1099 Box Number 06 chosen on the first payment; the second payment (Add Payment) must default to it.');
  // VBR.055 — VIN format (total loss = Yes)
  const VIN_RE = /The VIN should display 17 alpha numeric characters with uppercase letters/i;
  add('GCCM-1013/VBR/TC-072', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'open'), { step2: {} }, ...TL_YES, { fill: ['VIN', 'abc123-xyz'] }, NEXT],
    [msg(VIN_RE), { fill: ['VIN', '1HGCM82633A004352'] }, NEXT, msg(VIN_RE, false)], 'Lower-case / short VIN, then a valid 17-character upper-case VIN. Next only.');

  // ── HO claim: Insured + Secondary Named Insured (PROP_PA) ─────────────────────────────────────────────────────
  const HO = 'New HO claim (this run) on a policy with an Insured and a Secondary Named Insured (from the policy).';
  const INS1 = [{ open: 'full' }, { payee: 'insured' }, { select: ['Type', 'Insured'] }];
  const SNI1 = [{ open: 'full' }, { payee: 'sni' }, { select: ['Type', 'Secondary Named Insured'] }];
  const TO3 = [{ next: true }, { reserve: 'open' }, { step2: {} }, { next: true }, { expectStep: 3 }];
  const WARN_SNI = /Please select 'Secondary Named Insured' '[^']+' if applicable for this Insured payment/i;
  const WARN_INS = /Please select 'Insured' '[^']+' if applicable for this Insured payment/i;
  // VBR.044 — warning on Next from Step 1
  add('GCCM-1013/VBR/TC-051', 'HO_SNI', [...INS1, NEXT], [msg(WARN_SNI)], HO + ' Only the insured selected.');
  add('GCCM-1013/VBR/TC-052', 'HO_SNI', [...SNI1, NEXT], [msg(WARN_INS)], HO + ' Only the secondary named insured selected.');
  add('GCCM-1013/VBR/TC-053', 'HO_SNI', [...INS1, { joint: [{ who: 'sni' }] }, NEXT], [msg(/Please select '(Secondary Named Insured|Insured)'/i, false), { expectStep: 2 }], HO + ' Both selected.');
  // VBR.069–VBR.074 / UIF.101–106 — Missing Payee worksheet at Finish (Finish pressed once; a pending check made by it is deleted)
  const MISSING = { text: { re: /Missing Payee/i, present: true } };
  const QUESTION = { text: { re: /Should contact be added to payment\?/i, present: true } };
  // Finish pressed once: CC either stops on a warnings page (nothing saved) or holds the payment for approval — a held
  // check made by the case is deleted afterwards so the claim does not pile up pending approvals.
  const CLEAN = op('deletePendingIfAny', '.');
  const WS = HO + ' Finish pressed once (setupA.finishOnce); if CC holds the payment for approval instead of showing the worksheet, the held check is deleted afterwards.';
  add('GCCM-1013/VBR/TC-085', 'HO_SNI', [...INS1, ...TO3, sa('finishOnce')], [MISSING, { text: { re: /Please add 'Secondary Named Insured' '[^']+'/i, present: true } }, QUESTION, CLEAN], WS);
  add('GCCM-1013/VBR/TC-086', 'HO_SNI', [...INS1, ...TO3, sa('finishOnce')], [MISSING, QUESTION, CLEAN], WS + ' The Yes → "Payee Must Be Added" error half needs the worksheet first.');
  add('GCCM-1013/VBR/TC-087', 'HO_SNI', [...SNI1, ...TO3, sa('finishOnce')], [MISSING, { text: { re: WARN_INS, present: true } }, QUESTION, CLEAN], WS);
  add('GCCM-1013/VBR/TC-089', 'HO_SNI', [...INS1, ...TO3, sa('finishOnce')], [MISSING, { button: { name: 'Refresh', present: true } }, CLEAN], WS + ' The Refresh half needs the worksheet first.');
  add('GCCM-1013/UIF/TC-033', 'HO_SNI', [...INS1, ...TO3, sa('finishOnce')], [MISSING, QUESTION, CLEAN], WS + ' Later steps (hard stop on Yes, escalation on No) are covered by VBR TC-086 / TC-088.');
  add('GCCM-1013/UIF/TC-034', 'HO_SNI', [...INS1, ...TO3, sa('finishOnce')], [MISSING, QUESTION, CLEAN], WS);
  // VBR.071 / VBR.073 — the payment is escalated with a supervisor approval activity (Finish pressed through the warning)
  add('GCCM-1013/VBR/TC-088', 'HO_SNI', VAL([...INS1, ...TO3], null), [op('openCheck', { status: '^Pending approval$', payee: '@insured' }), op('approvalHistory'),
    V('Approval History', { value: /Secondary Named Insured'? '[^']+'? not selected/i }), op('workplan'), V('Workplan activities', { value: /Review and approve new payment/i }),
    op('openCheck', { status: '^Pending approval$', payee: '@insured' }), op('deleteCheck')],
  HO + ' Only the insured selected; Finish pressed through CC\'s warning page. Expects the check held for approval with the missing-payee reason and a "Review and approve new payment" activity; the held check is deleted afterwards. CC shows no Missing Payee worksheet (so "No" cannot be answered) — see TC-085.');

  // ── Delete a check → history event (VBR.067 / CHE.001) ──────────────────────────────────────────────────────
  const OTHER_VENDOR = VAL([op('ensureOpenReserve'), { open: 'full' }, { payee: 'vendor' }, { select: ['Type', 'Other'] }, { next: true }, { reserve: 'open' }, { step2: {} }, { next: true }, { expectStep: 3 }], null);
  const DELETED = /Check to .+ for \$[\d,.]+ deleted\.? \(Check Number:/i;
  const DEL_NOTE = 'Payment to an Address Book vendor with payee Type "Other", submitted ($1.37, Finish), then deleted from Check/Payment Details (confirm accepted); Claim History is read afterwards.';
  // History is noted after the payment, before the delete; only rows that are new after the delete count.
  const DEL = [op('historyMark'), op('openNewestCheck'), op('deleteCheck'), V('Delete outcome', { value: /^deleted/i }), op('historySince')];
  add('GCCM-1013/VBR/TC-083', 'AUTO_PA', OTHER_VENDOR, [...DEL, V('New history events', { value: /Check Deleted|deleted\.? \(Check Number/i })], DEL_NOTE);
  add('GCCM-1013/CHE/TC-130', 'AUTO_PA', OTHER_VENDOR, [...DEL, V('New history events', { value: DELETED })],
    DEL_NOTE + ' The History snapshot taken after the payment (before the delete) is the "event not created yet" half: only rows added after it are counted.');

  // ── After Finish: workflow history / document-required activity ─────────────────────────────────────────────
  add('GCCM-1013/VBR/TC-046', 'AUTO_PA', VAL([op('ensureOpenReserve'), ...FULL_INSTRUCTIONS('claimant')], null), [op('escalateChecks', '1.37'), op('openNewestCheck'), op('openAPD'),
    { text: { re: /Workflow History\s+Date\s+Description\s+No data to display/i, present: false } }],
  'Submits a $1.37 payment (Finish), then opens its Additional Payment Details: the Workflow History table must have entries.');
  add('GCCM-1013/INT/TC-102', 'AUTO_PA', VAL([{ open: 'full' }, { payee: 'vendor' }, { next: true }, { reserve: 'new' }, { select: ['Cost Type', 'Adjuster Expense'] },
    { step2: { transactionType: 'First and Final', amount: '1.37' } }, { select: ['1099 Box Number', /^06/] }, { next: true }, { expectStep: 3 }], null),
  [op('escalateChecks', '1.37'), op('workplan'), V('Workplan activities', { value: /Document is required for Payment/i })],
  'Vendor expense payment with 1099 Box 06 (Medical Payments to Providers) and no linked document, submitted ($1.37, Finish); the Workplan must then carry the digital_payment_send_doc activity. Sending the document to OneInc (second half) is integration-side.');

  // ── VBR.039 / VBR.040 — activities after a Supplemental payment (AUTO_PA line with $0 remaining = closed reserve) ──
  // Supplemental payments need a CLOSED reserve: a Final Payment closes the line first, then the Supplemental is paid on it.
  const SUPP = [...VAL([...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Final Payment', amount: '1.37' } }], null),
    ...VAL([...FULL_PAYMENTS('claimant', 'zero'), { step2: { transactionType: 'Supplemental Payment', amount: '1.38' } }], null)];
  const SUPP_NOTE = 'The Financials Escalation batch is run (Server Tools, admin login) so the checks move to Requesting before the Workplan is read. On a first-party vehicle (non-medical) line: a $1.37 Final Payment closes the reserve, then a $1.38 Supplemental Payment is submitted on it (Finish both times); the Workplan is read afterwards. Needs a user whose payments are not held for approval (the activities are created when the check moves to Requesting).';
  add('GCCM-1013/VBR/TC-042', 'AUTO_PA', SUPP, [op('escalateChecks', '1.38'), op('workplan'), V('Workplan activities', { value: /^(?![\s\S]*(Collect Deductible|Deductible Collected\?))/i })],
    SUPP_NOTE + ' The policy carries none of the listed deductible endorsements, so no "Collect Deductible" / "Deductible Collected?" activity may appear.');
  add('GCCM-1013/VBR/TC-043', 'AUTO_PA', SUPP, [op('escalateChecks', '1.38'), op('workplan'), V('Workplan activities', { value: /Supplemental Issued on Closed File/i })], SUPP_NOTE + ' Expects the sp_closed activity "Supplemental Issued on Closed File".');

  // ── WC lost wages (WCA_LW) ───────────────────────────────────────────────────────────────────────────────────
  const BASE_EXPO = { 'Average Weekly Wage': '800.00', 'Disability Weekly Rate': '500.00', 'Disability Type': 'TTD', 'Benefit Offset Code': 'None', 'Reason TTD or TPD Ended': '<none>' };
  const EXPO = (extra = {}) => sa('setIndemnityExposure', { ...BASE_EXPO, ...extra });
  const CAT = (re) => sa('selectLineCategory', re);
  const LW = (cat, { expo = {}, extra = [], txn = 'Partial Payment' } = {}) => [EXPO(expo), { open: 'full' }, { payee: 'claimant' }, { next: true }, { select: ['Reserve Line', /Indemnity/] },
    { select: ['Transaction Type', txn] }, CAT(cat), { step2: { transactionType: txn, amount: '1.37' } }, sa('fillRequired'), ...extra]; // case values AFTER the details (filling them re-renders the form)
  const LWN = 'WC claim with a Lost Time severity: Indemnity (Lost Wages) exposure (Average Weekly Wage 800 / Disability Weekly Rate 500 / TTD unless the case sets otherwise); payment on the Indemnity reserve line. Next only — never Finish.';
  const RTW = 'Did the claimant return to work?';
  add('GCCM-1013/UIF/TC-035', 'WCA_LW', LW('^05'), [V(RTW, { required: true, radios: ['Yes', 'No'] }), CAT('^0[1-4]'), H(RTW)], LWN + ' Line category 05 (TTD), then 01–04.');
  add('GCCM-1013/VBR/TC-066', 'WCA_LW', [...LW('^05', { extra: [{ fill: ['Average Weekly Wage', '400.00'] }, { fill: ['Disability Weekly Rate', '500.00'] }] }), NEXT], [msg(/Average Weekly Wage cannot be less than Disability Weekly Rate/i)],
    LWN + ' Average Weekly Wage 400 < Disability Weekly Rate 500 entered on the payment (the exposure screen refuses that pair itself: "Disability weekly rate must be equal to or less than the average weekly wage").');
  add('GCCM-1013/VBR/TC-067', 'WCA_LW', [...LW('^05'), NEXT], [msg(/Average Weekly Wage cannot be less than Disability Weekly Rate/i, false)], LWN + ' Average Weekly Wage 800 >= Disability Weekly Rate 500.');
  const SP_END = /Cannot be prior to Service Period Start date/i;
  const SP = (start, end) => [{ fill: ['Service Period Start', start] }, { fill: ['Service Period End', end] }];
  add('GCCM-1013/VBR/TC-069', 'WCA_LW', [...LW('^05', { extra: SP('TODAY', 'TODAY-3') }), NEXT], [msg(SP_END)], LWN + ' Service Period End 3 days before Start.');
  add('GCCM-1013/VBR/TC-092', 'WCA_LW', [...LW('^05', { extra: SP('TODAY', 'TODAY-3') }), NEXT], [msg(SP_END)], LWN + ' Service Period End 3 days before Start.');
  add('GCCM-1013/VBR/TC-070', 'WCA_LW', [...LW('^05', { extra: SP('DOL+1', 'TODAY') }), NEXT], [msg(SP_END, false), msg(/Lump Sum Medical Extinguishment Date/i, false)],
    LWN + ' Service Period Start after the loss date, End today (no medical extinguishment date on the exposure).');
  const PAST = /Date must be in the past/i;
  add('GCCM-1013/VBR/TC-071', 'WCA_LW', [...LW('^03', { extra: [{ fill: ['MMI Date', 'TODAY+5'] }] }), NEXT], [msg(PAST), { fill: ['MMI Date', 'TODAY-1'] }, NEXT, msg(PAST, false)],
    LWN + ' Line category 03 (PPD scheduled): MMI Date 5 days ahead, then yesterday.');
  const RTW_DOL = /Return to work date cannot be prior to the date of loss/i;
  add('GCCM-1013/VBR/TC-073', 'WCA_LW', [...LW('^05', { extra: [{ answer: [RTW, 'Yes'] }, { select: ['Return to Work Type Code', 'Actual'] }, { fill: ['Date Returned to Work', 'DOL-5'] }] }), NEXT],
    [msg(RTW_DOL), { fill: ['Date Returned to Work', 'DOL+1'] }, NEXT, msg(RTW_DOL, false)], LWN + ' Returned to work = Yes; date 5 days before the loss, then the day after.');
  const SETTLE = /Settlement date must be after the date of loss/i;
  add('GCCM-1013/VBR/TC-074', 'WCA_LW', [...LW('^05', { extra: [{ answer: [RTW, 'No'] }, { answer: ['Has the claim been settled?', 'Yes'] }, { fill: ['What is the settlement date?', 'DOL-5'] }] }), NEXT],
    [msg(SETTLE), { fill: ['What is the settlement date?', 'DOL+1'] }, NEXT, msg(SETTLE, false)], LWN + ' Returned to work = No, settled = Yes; settlement date 5 days before the loss, then the day after.');
  const MSA = /Please enter MSA Period values between 0-99/i;
  add('GCCM-1013/VBR/TC-075', 'WCA_LW', [...LW('^49', { extra: [{ select: ['Payout Indicator', /Structured/] }, { fill: ['MSA Period', '150'] }, { fill: ['MSA Amount', '1000.00'] }, { fill: ['Initial Deposit Amount', '100.00'] }, { fill: ['Annual Deposit Amount', '100.00'] }] }), NEXT],
    [msg(MSA), { text: { re: /Step 2 of 3/i, present: true } }], LWN + ' Line category 49, Medical exposure Medicare beneficiary = Yes, Payout Indicator Structured/Annuity, MSA / deposit amounts filled; MSA Period 150 must stop Next on Step 2. (The "0–99 accepted" half is only meaningful once the rule fires; with every other field valid CC moved on to Step 3 — CONFIRMED 2026-10-27.)');
  const DWR10M = /Disability Weekly Rate must be less than 10 Million/i;
  add('GCCM-1013/VBR/TC-095', 'WCA_LW', [...LW('^05', { extra: [{ fill: ['Average Weekly Wage', '20000000.00'] }, { fill: ['Disability Weekly Rate', '10000000.00'] }] }), NEXT], [msg(DWR10M)],
    LWN + ' Disability Weekly Rate $10,000,000 entered on the payment (Average Weekly Wage $20,000,000 so VBR.052 does not answer first).');
  add('GCCM-1013/VBR/TC-096', 'WCA_LW', [...LW('^05'), NEXT], [msg(DWR10M, false)], LWN + ' Disability Weekly Rate 500.');
  const OFFSET = /Benefit Offset Weekly Amount must be less than Disability Weekly Rate/i;
  const SSDI = { select: ['Benefit Offset Code', /Social Security Disability/] };
  const WAGES = [{ fill: ['Average Weekly Wage', '800.00'] }, { fill: ['Disability Weekly Rate', '500.00'] }]; // required on the payment screen
  add('GCCM-1013/VBR/TC-097', 'WCA_LW', [...LW('^05', { extra: [...WAGES, SSDI, { fill: ['Benefit Offset Weekly Amount', '600.00'] }] }), NEXT], [msg(OFFSET)], LWN + ' Benefit Offset SSDI, weekly amount 600 >= Disability Weekly Rate 500.');
  add('GCCM-1013/VBR/TC-098', 'WCA_LW', [...LW('^05', { extra: [...WAGES, SSDI, { fill: ['Benefit Offset Weekly Amount', '100.00'] }] }), NEXT], [msg(OFFSET, false)], LWN + ' Benefit Offset SSDI, weekly amount 100 < Disability Weekly Rate 500.');

  // ── VBR.061 — vendor marked Do Not Use (Tax ID Valid Until in the past, set in ContactManager and restored) ────
  const TAYLOR = 'TAYLOR REPORTING SERVICE';
  const TAX = '58-2338930';
  add('GCCM-1013/VBR/TC-078', 'AUTO_PA', VAL([{ call: ['contactManager.setTaxValidUntil', TAYLOR, TAX, 'past'] }, { open: 'full' }, { call: ['reuseExt.selectVendorByTaxId', 'TAYLOR REPORTING', TAX] },
    { next: true }, { reserve: 'open' }, { step2: { transactionType: 'Partial Payment', amount: '1.37' } }], /You selected a payee that is no longer valid|This payee is no longer valid/i),
  [{ call: ['contactManager.restoreVendors'] }],
  `ContactManager vendor ${TAYLOR} (${TAX}) Tax ID Valid Until set to a past date and restored afterwards (needs CM_USER / CM_PASS). Cloud words the message "This payee is no longer valid. Please select another payee." (GCCM-803 TC-029); the design text is "You selected a payee that is no longer valid. Please return to the search screen…" — either is accepted and the actual text recorded.`);
};
