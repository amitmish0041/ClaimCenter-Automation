/**
 * helpers/oneInc/scenarioRecipes.js
 * The automated OneInc scenarios: for each test case (scenario id from inventoryService), WHICH claim profile it
 * needs, the steps that put the screen into the test case's precondition, and the checks that compare the live
 * screen with the test case's Expected Result. Anything without a recipe here is classified (classifier.js) and
 * reported NOT EXECUTED / BLOCKED with the reason — nothing is silently skipped.
 *
 * Steps (run in order by scenarioRunner.js):
 *   open:'full'|'financials'|'quick'  open the Full Check wizard (Actions › New Payment), the same wizard from the
 *                                     Financials row menu (Create Payment), or the Quick Payment wizard
 *   payee:'claimant'|'insured'|'other' select the Step 1 payee
 *   next:true                          press Next (validation rules fire here)
 *   reserve:'open'|'existing'|'new'    Step 2 Reserve Line
 *   select:[label, value] / fill:[label, value] / answer:[label, 'Yes'|'No']
 *   step2:{transactionType, amount, costType}  fill Step 2 with minimum valid data (to reach Step 3)
 *   menu:'actions'|'financials'        open a menu and keep its items for `menu` checks
 *   nav:'checks'|'transactions'|'parties'|'lossDetails'|'financials'
 *   openFirstRow:true                  open the first contact / row link on the current list screen
 *   validate:{ expect: RegExp|null }   trigger the rule: Next first; Finish only when ONEINC_ALLOW_FINISH=1
 * Checks (evaluated against the screen at that point; a screenshot is taken for each):
 *   field:{label, visible, required, editable, readonly, includes:[...], excludes:[...], equals:[...], value:RegExp,
 *          unlessBlocked:'why'}  — unlessBlocked: if the field is absent, the data precondition (claim/exposure
 *          setup the automation cannot confirm) is reported as BLOCKED instead of FAIL
 *   absent:{label} / header:{name, present} / button:{name, present} / menu:{name, present} / nav:{label, present}
 *   message:{re, present} / text:{re, present}
 *   require:{warning:RegExp, present, reason}  — precondition gate: BLOCKED when the screen says otherwise
 */
'use strict';

// ── Step building blocks ────────────────────────────────────────────────────────────────────────────────────────
const FULL_PAYEES = (who = 'claimant') => [{ open: 'full' }, { payee: who }];
const FULL_PAYMENTS = (who = 'claimant', reserve = 'open') => [...FULL_PAYEES(who), { next: true }, { reserve }];
const FULL_INSTRUCTIONS = (who = 'claimant', step2 = {}) => [...FULL_PAYMENTS(who, 'open'), { step2 }, { next: true }, { expectStep: 3 }];
// who: payee. Expense payments to a non-vendor are refused by VBR.025 ("Payee type … must be vendor or other" —
// CONFIRMED 2026-10-20), so expense scenarios that go on to Next/Finish pass 'vendor'.
const NEW_LINE = (costType, who = 'claimant') => [...FULL_PAYMENTS(who, 'new'), { select: ['Cost Type', costType] }];
const QUICK = () => [{ open: 'quick' }];
const QUICK_DETAILS = (step2 = {}) => [{ open: 'quick', needOpenReserve: true }, { step2 }, { next: true }, { expectStep: 2 }];

const V = (label, extra = {}) => ({ field: { label, visible: true, ...extra } });
const H = (label, extra = {}) => ({ absent: { label, ...extra } });

const TXN_TYPES = ['Partial Payment', 'Final Payment', 'First and Final', 'Supplemental Payment'];
const PAY_DELIVERY = ['Standard', 'Certified', 'Expedite'];
const NOT_IN_PAY_DELIVERY = ['Print Now', 'Send', 'Hold', 'no_check_needed'];

const WC_LOST_WAGES = 'needs a WC claim whose payment line is a Lost Wages (indemnity) exposure — not found/confirmed on the WC test claim';
const PA_TORT = 'needs a PA personal-auto policy with state numeric 37 and cause of loss LC03/LC09/LC90 — not confirmed on the test claim';
const MI_MCCA = 'needs a Michigan auto claim whose check is MCCA RFR eligible — not confirmed on the test claim';
const MED_PAYMENT = 'Service Period is REQUIRED only on medical / WC indemnity payments — the test payment is not one';

// Contact-detail gate for the ClaimsPay default rules: CC shows this warning when the payee has no payment
// contact details (email/phone), which forces CPD.001's Other/Mailed Check default regardless of payee type.
const NO_CONTACT_DETAILS = /payees other than vendor should have the payment contact details/i;

const R = {};
const add = (id, profile, steps, checks, notes) => { R[id] = { profile, steps, checks, notes }; };

// ══ GCCM-759 — Contact/Vendor Single Payee & Common UI Updates Part 1 (Full Check wizard) ═══════════════════════
add('GCCM-759/UIF/TC-001', 'AUTO_PA', [{ menu: 'actions' }], [{ menu: { name: 'New Payment', present: true } }, { menu: { name: 'Payment', present: false, exact: true } }]);
add('GCCM-759/UIF/TC-002', 'AUTO_PA', [{ menu: 'financials' }], [{ menu: { name: 'Create Payment', present: true } }, { menu: { name: 'Create Check', present: false } }]);
add('GCCM-759/UIF/TC-003', 'AUTO_PA', [{ nav: 'financials' }], [{ nav: { label: 'Checks/Payments', present: true } }, { nav: { label: 'Checks', present: false, exact: true } }]);
add('GCCM-759/UIF/TC-006', 'AUTO_PA', FULL_PAYEES('claimant'), [V('Type', { required: true, editable: true, includes: ['Additional Claimant', 'Vendor', 'Other'] })],
  'The ClaimsPay Type part of this case is checked on Step 3 by the CPD cases.');
add('GCCM-759/UIF/TC-007', 'AUTO_PA', FULL_INSTRUCTIONS('claimant'), [{ text: { re: /Tax Reporting/i, present: false } }]);
add('GCCM-759/UIF/TC-009', 'AUTO_PA', FULL_PAYEES('claimant'), [{ button: { name: 'Edit', present: true } }, V('Pay To The Order Of', { readonly: true }),
  { click: 'Edit' }, V('Pay To The Order Of', { editable: true })]);
add('GCCM-759/UIF/TC-010', 'AUTO_PA', FULL_INSTRUCTIONS('claimant'), [V('Payment Delivery', { editable: true, includes: PAY_DELIVERY, excludes: NOT_IN_PAY_DELIVERY })],
  'Payment Delivery renders on Step 3 (Instructions) in Cloud, not on the payee screen named in the test case.');
add('GCCM-759/UIF/TC-012', 'AUTO_PA', FULL_PAYEES('claimant'), [V('Mailing Address', { editable: true }), { text: { re: /Do you want to edit the Mailing Address\?/i, present: true } }]);
add('GCCM-759/UIF/TC-013', 'AUTO_PA', [...FULL_PAYEES('claimant'), { next: true }], [V('Reserve Line', { required: true, editable: true }),
  { step2: { transactionType: 'Partial Payment' }, skipReserve: true }, { next: true }, { message: { re: /Reserve Line/i, present: true } }]);
add('GCCM-759/UIF/TC-014', 'WC_PA', FULL_PAYMENTS('claimant', 'existing'), [V('Claimant', { readonly: true })]);
add('GCCM-759/UIF/TC-015', 'AUTO_PA', FULL_PAYMENTS('claimant', 'existing'), [H('Claimant')]);
add('GCCM-759/UIF/TC-016', 'AUTO_PA', FULL_PAYMENTS('claimant', 'existing'), [V('Transaction Type', { required: true, editable: true, includes: TXN_TYPES })]);
add('GCCM-759/UIF/TC-017', 'AUTO_PA', NEW_LINE('Adjuster Expense'), [H('Transaction Type')]);
add('GCCM-759/UIF/TC-018', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'existing'), { select: ['Transaction Type', 'Partial Payment'] }], [V('Payment Type', { readonly: true, value: /partial/i })]);
add('GCCM-759/UIF/TC-019', 'AUTO_PA', FULL_PAYMENTS('claimant', 'existing'), [H('Eroding'), H('Eroding?')]);
add('GCCM-759/UIF/TC-020', 'AUTO_PA', FULL_PAYMENTS('claimant', 'existing'), [H('Comments'), { header: { name: 'Comments', present: false } }]);
add('GCCM-759/UIF/TC-021', 'AUTO_PA', NEW_LINE('Adjuster Expense'), [V('Adjuster Number', { required: true, editable: true })],
  'Test case text is self-contradictory (title "Expense", precondition "Claim Cost or null"); checked per the Test Data: CostType != Claim Cost (expense).');
add('GCCM-759/UIF/TC-022', 'AUTO_PA', NEW_LINE('Claim Cost'), [H('Adjuster Number')]);
add('GCCM-759/UIF/TC-023', 'AUTO_PA', [...NEW_LINE('Adjuster Expense'), { select: ['Adjuster Number', 0] }], [V('NAIC Expense Reporting', { value: /allocated|unallocated/i })],
  'Checked for an expense payment, where NAIC Expense Reporting applies (business review: "applicable to Expense type payments not claim cost").');
add('GCCM-759/UIF/TC-024', 'AUTO_PA', NEW_LINE('Claim Cost'), [H('NAIC Expense Reporting')]);
add('GCCM-759/UIF/TC-025', 'AUTO_PA', FULL_PAYMENTS('claimant', 'existing'), [V('Total Amount of Payment', { required: true, editable: true }),
  { fieldKind: { label: 'Total Amount of Payment', kind: 'masked' } }, H('Check Amount'),
  { select: ['Transaction Type', 'Partial Payment'] }, { next: true }, { message: { re: /Total Amount of Payment|amount/i, present: true } }]);
add('GCCM-759/UIF/TC-026', 'AUTO_PA', FULL_PAYMENTS('claimant', 'existing'), [V('Cause of Loss', { readonly: true, value: /\S/ })]);
add('GCCM-759/UIF/TC-027', 'AUTO_PA', FULL_PAYMENTS('claimant', 'existing'), [V('Payment for a total loss?', { required: true, radios: ['Yes', 'No'] })]);
add('GCCM-759/UIF/TC-028', 'AUTO_PA', NEW_LINE('Adjuster Expense'), [H('Payment for a total loss?')]);
add('GCCM-759/UIF/TC-029', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'existing'), { answer: ['Payment for a total loss?', 'Yes'] }],
  [{ text: { re: /SELECT NO IF ADVERSE CARRIER IS HANDLING SALVAGE/i, present: true } }],
  'Checked after answering "Payment for a total loss?" = Yes (the label is not rendered before the question is answered).');
add('GCCM-759/UIF/TC-030', 'AUTO_PA', FULL_PAYMENTS('claimant', 'new'), [V('Cost Type', { editable: true, includes: ['Claim Cost', 'Adjuster Expense', 'Legal Expense'] })]);
add('GCCM-759/UIF/TC-031', 'AUTO_PA', FULL_PAYMENTS('claimant', 'new'), [V('Cost Category', { editable: true })]);
// ClaimsPay defaults (read on Step 3 — where Cloud renders ClaimsPay Type / Method).
const cpd = (who, type, method, gateHasDetails) => ({
  steps: [...FULL_PAYEES(who), { snapshotWarning: NO_CONTACT_DETAILS }, { next: true }, { reserve: 'open' }, { step2: {} }, { next: true }, { expectStep: 3 }],
  // User direction 2026-10-21: the "payment contact details" warning does not stop the payment — run these cases
  // through it and report the ClaimsPay defaults CC actually gives (no BLOCKED gate). The no-details case (TC-032)
  // still requires the warning, since that is its precondition.
  checks: [
    ...(gateHasDetails ? [] : [{ require: { warning: NO_CONTACT_DETAILS, present: true, at: 'payees',
      reason: 'the selected payee HAS payment contact details, so the no-email precondition is not met' } }]),
    V('ClaimsPay Type', { value: type }), V('ClaimsPay Method', { value: method }),
  ],
});
const CPD_NOTE = 'Run through the "payment contact details" warning (user direction 2026-10-21). No TEST claimant/insured payee clears that warning (a Digital Payment Account did not), so CC may apply CPD.001 (Other/Mailed Check) — reported as observed.';
let c = cpd('claimant', /other\s*\/\s*mailed check/i, /^(mailed )?check$/i, false); add('GCCM-759/CPD/TC-032', 'AUTO_PA', c.steps, c.checks);
c = cpd('insured', /^contact\(s\)$/i, /customer choice|let customer pick/i, true); add('GCCM-759/CPD/TC-005', 'AUTO_PA', c.steps, c.checks, CPD_NOTE);
c = cpd('claimant', /^contact\(s\)$/i, /customer choice|let customer pick/i, true); add('GCCM-759/CPD/TC-007', 'AUTO_PA', c.steps, c.checks, CPD_NOTE);
c = cpd('insured', /^contact\(s\)$/i, /./, true); add('GCCM-759/CPD/TC-019', 'AUTO_PA', c.steps, c.checks, CPD_NOTE);
c = cpd('claimant', /^contact\(s\)$/i, /./, true); add('GCCM-759/CPD/TC-021', 'AUTO_PA', c.steps, c.checks, CPD_NOTE);
c = cpd('claimant', /^contact\(s\)$/i, /./, true); add('GCCM-759/CPD/TC-027', 'AUTO_PA', c.steps, c.checks, CPD_NOTE);

// Vendor payee (Address Book vendor selected by Tax ID — wizardDriver.selectVendorPayee).
const VENDOR_NOTE = 'Payee = an Approved Vendor (Company) from the TEST Address Book, selected by Tax ID (default: ADJUSTMENT SERVICES INC, 58-1623664).';
add('GCCM-759/CPD/TC-026', 'AUTO_PA', FULL_INSTRUCTIONS('vendor'),
  [V('ClaimsPay Type', { value: /^vendor$/i }), V('ClaimsPay Method', { value: /vendor preferred/i })], VENDOR_NOTE);

// ══ GCCM-799 — Common UI Updates Part 2 (Full Check wizard) ════════════════════════════════════════════════════
add('GCCM-799/UIF/TC-050', 'AUTO_PA', FULL_INSTRUCTIONS('vendor'), [V('Invoice Number/Remarks', { required: true, editable: true }), H('Invoice Number')], VENDOR_NOTE);
add('GCCM-799/UIF/TC-063', 'AUTO_PA', FULL_INSTRUCTIONS('vendor'), [H('Loan Number')], VENDOR_NOTE);
add('GCCM-799/UIF/TC-065', 'AUTO_PA', FULL_INSTRUCTIONS('vendor'), [H('Request Type')], VENDOR_NOTE);
add('GCCM-799/UIF/TC-001', 'AUTO_PA', FULL_PAYEES('claimant'), [V('Pay To The Order Of', { readonly: true }), { click: 'Edit' }, V('Pay To The Order Of', { editable: true })]);
add('GCCM-799/UIF/TC-002', 'AUTO_PA', [...NEW_LINE('Legal Expense'), { select: ['Adjuster Number', /^800/] }],
  [V('Is the legal expense for a legal opinion on coverage or to litigate a coverage issue?', { required: true, radios: ['Yes', 'No'] })]);
add('GCCM-799/UIF/TC-003', 'AUTO_PA', NEW_LINE('Adjuster Expense'), [H('Is the legal expense for a legal opinion on coverage or to litigate a coverage issue?')]);
add('GCCM-799/UIF/TC-004', 'AUTO_MI', FULL_PAYMENTS('claimant', 'existing'), [V('Original Billed Amount', { editable: true, unlessBlocked: MI_MCCA })]);
add('GCCM-799/UIF/TC-005', 'PROP_PA', FULL_PAYMENTS('claimant', 'existing'), [H('Original Billed Amount')]);
add('GCCM-799/UIF/TC-006', 'AUTO_PA', FULL_PAYMENTS('claimant', 'existing'), [V('PA Tort Code', { required: true, editable: true, unlessBlocked: PA_TORT })]);
add('GCCM-799/UIF/TC-007', 'PROP_PA', FULL_PAYMENTS('claimant', 'existing'), [H('PA Tort Code')]);
add('GCCM-799/UIF/TC-008', 'AUTO_PA', [{ open: 'full' }, { payee: 'vendor' }, { next: true }, { reserve: 'new' }, { select: ['Cost Type', 'Adjuster Expense'] }, { select: ['Adjuster Number', 0] }],
  [V('1099 Box Number', { required: true, editable: true, value: /^07/, includes: ['06-Medical Payments to Providers', '07-All Other Taxable Payments', '14-Gross Proceeds Paid to an Attorney'] })],
  VENDOR_NOTE + ' Expense payment (new line, Adjuster Expense) with an adjuster number that is not a "no tax ID" code; expects the Box 7 default.');
add('GCCM-799/UIF/TC-010', 'AUTO_PA', FULL_PAYMENTS('claimant', 'existing'), [{ header: { name: 'Category', present: true } }]);
add('GCCM-799/UIF/TC-014', 'WC_PA', FULL_PAYMENTS('claimant', 'existing'), [V('Average Weekly Wage', { required: true, editable: true, unlessBlocked: WC_LOST_WAGES })]);
add('GCCM-799/UIF/TC-015', 'AUTO_PA', FULL_PAYMENTS('claimant', 'existing'), [H('Average Weekly Wage')]);
add('GCCM-799/UIF/TC-016', 'WC_PA', FULL_PAYMENTS('claimant', 'existing'), [V('Disability Weekly Rate', { required: true, editable: true, unlessBlocked: WC_LOST_WAGES })]);
add('GCCM-799/UIF/TC-017', 'AUTO_PA', FULL_PAYMENTS('claimant', 'existing'), [H('Disability Weekly Rate')]);
add('GCCM-799/UIF/TC-023', 'AUTO_PA', FULL_PAYMENTS('claimant', 'existing'), [V('Service Period Start', { editable: true })], MED_PAYMENT + ' — visibility/editability checked; "required" needs a medical payment.');
add('GCCM-799/UIF/TC-024', 'AUTO_PA', FULL_PAYMENTS('claimant', 'existing'), [V('Service Period End', { editable: true })], MED_PAYMENT + ' — visibility/editability checked; "required" needs a medical payment.');
add('GCCM-799/UIF/TC-027', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'existing'), { answer: ['Payment for a total loss?', 'Yes'] }], [V('VIN', { required: true, editable: true })]);
add('GCCM-799/UIF/TC-028', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'existing'), { answer: ['Payment for a total loss?', 'No'] }], [H('VIN')]);
add('GCCM-799/UIF/TC-029', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'existing'), { answer: ['Payment for a total loss?', 'Yes'] }], [V('Is the owner keeping this Vehicle?', { required: true, radios: ['Yes', 'No'] })]);
add('GCCM-799/UIF/TC-030', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'existing'), { answer: ['Payment for a total loss?', 'No'] }], [H('Is the owner keeping this Vehicle?')]);
add('GCCM-799/UIF/TC-031', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'existing'), { answer: ['Payment for a total loss?', 'Yes'] }], [V('Is this vehicle owned by the Insured?', { required: true, radios: ['Yes', 'No'],
  unlessBlocked: 'shows only when the exposure\'s loss party is the Insured — not confirmed on the test claim\'s first reserve line' })]);
add('GCCM-799/UIF/TC-032', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'existing'), { answer: ['Payment for a total loss?', 'No'] }], [H('Is this vehicle owned by the Insured?')]);
add('GCCM-799/UIF/TC-033', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'existing'), { answer: ['Payment for a total loss?', 'Yes'] }, { answer: ['Is the owner keeping this Vehicle?', 'No'] },
  { answer: ['Is this vehicle owned by the Insured?', 'Yes'] }], [V('Does this vehicle display on the CLAIM CENTER policy page?', { required: true, radios: ['Yes', 'No'] })]);
const RTW = 'shows only when the WC claim has Return To Work set — not confirmed on the WC test claim';
add('GCCM-799/UIF/TC-037', 'WC_PA', FULL_PAYMENTS('claimant', 'existing'), [V('Date Returned to Work', { editable: true, required: true, unlessBlocked: RTW })]);
add('GCCM-799/UIF/TC-038', 'WC_PA', FULL_PAYMENTS('claimant', 'existing'), [V('Return to Work Type Code', { editable: true, required: true, includes: ['Actual', 'Released'], unlessBlocked: RTW })]);
add('GCCM-799/UIF/TC-039', 'WC_PA', FULL_PAYMENTS('claimant', 'existing'), [V('Has the claim been settled?', { required: true, unlessBlocked: 'shows only when the WC claim\'s Return To Work = No — not confirmed on the WC test claim' })]);
add('GCCM-799/UIF/TC-040', 'WC_PA', [...FULL_PAYMENTS('claimant', 'existing'), { answer: ['Has the claim been settled?', 'Yes'] }], [V('What is the settlement date?', { required: true, editable: true })]);
add('GCCM-799/UIF/TC-051', 'AUTO_PA', FULL_INSTRUCTIONS('claimant'), [V('Invoice Number/Remarks', { required: false, editable: true }), H('Invoice Number')]);
add('GCCM-799/UIF/TC-052', 'AUTO_PA', FULL_INSTRUCTIONS('claimant'), [V('Remarks Line 2', { required: false, editable: true })]);
add('GCCM-799/UIF/TC-053', 'AUTO_PA', FULL_INSTRUCTIONS('claimant'), [V('Claim Number', { readonly: true, required: false }), H('Memo')]);
add('GCCM-799/UIF/TC-054', 'AUTO_PA', FULL_INSTRUCTIONS('claimant'), [V('Is this payment to an attorney or representative of the insured or claimant AND is the settlement payment or payment of a judgment?', { required: true, radios: ['Yes', 'No'] })]);
add('GCCM-799/UIF/TC-055', 'WC_PA', FULL_INSTRUCTIONS('claimant'), [H('Is this payment to an attorney or representative of the insured or claimant AND is the settlement payment or payment of a judgment?')],
  'Uses a PA WC claim: the rule hides the question for loss type WC regardless of state.');
add('GCCM-799/UIF/TC-057', 'AUTO_PA', FULL_INSTRUCTIONS('claimant'), [{ header: { name: 'Send Status', present: true } }]);
add('GCCM-799/UIF/TC-061', 'AUTO_PA', FULL_INSTRUCTIONS('insured'), [H('Approval Required')]);
add('GCCM-799/UIF/TC-066', 'AUTO_PA', FULL_PAYEES('claimant'), [{ button: { name: 'Add Payee', present: false } }]);
add('GCCM-799/UIF-001/TC-067', 'AUTO_PA', [{ nav: 'checks' }, { openFirstRow: 'check' }], [
  { button: { name: 'Transfer', present: false } }, { button: { name: 'Reissue', present: false } }, { button: { name: 'Clone', present: false } },
  { nav: 'transactions' }, { button: { name: 'Recode', present: false } }],
  'Uses an existing payment on the test claim instead of creating one (this suite never saves a payment).');

// ══ GCCM-1003 — Quick Check / Quick Payment ════════════════════════════════════════════════════════════════════
add('GCCM-1003/UIF/TC-001', 'AUTO_PA', [{ menu: 'financials' }], [{ menu: { name: 'Quick Payment', present: true } }, { menu: { name: 'Quick Check', present: false } }]);
add('GCCM-1003/UIF/TC-002', 'AUTO_PA', QUICK(), [{ text: { re: /Tax Reporting/i, present: false } }]);
add('GCCM-1003/UIF/TC-003', 'AUTO_PA', QUICK(), [V('Transaction Type', { required: true, editable: true, includes: TXN_TYPES })]);
add('GCCM-1003/UIF/TC-005', 'AUTO_PA', [...QUICK(), { select: ['Transaction Type', 'Partial Payment'] }], [V('Payment Type', { readonly: true, value: /partial/i })]);
add('GCCM-1003/UIF/TC-006', 'AUTO_PA', QUICK(), [V('Type', { required: true, includes: ['Additional Claimant'] })]);
add('GCCM-1003/UIF/TC-008', 'AUTO_PA', QUICK(), [V('Mailing Address'), { text: { re: /Do you want to edit the Mailing Address\?/i, present: true } }]);
add('GCCM-1003/UIF/TC-009', 'AUTO_PA', QUICK(), [V('Pay To The Order Of', { readonly: true })]);
add('GCCM-1003/UIF/TC-011', 'AUTO_PA', QUICK(), [H('Adjuster Number')], 'Quick Payment opened from a Claim Cost reserve row.');
add('GCCM-1003/UIF/TC-012', 'AUTO_PA', QUICK(), [{ button: { name: 'Edit', present: true } }, { click: 'Edit' }, V('Pay To The Order Of', { editable: true })]);
add('GCCM-1003/UIF/TC-013', 'AUTO_PA', QUICK(), [V('Reserve Line', { required: true, value: /\S/ })]);
add('GCCM-1003/UIF/TC-015', 'AUTO_PA', QUICK(), [H('Is the legal expense for a legal opinion on coverage or to litigate a coverage issue?')]);
add('GCCM-1003/UIF/TC-017', 'AUTO_PA', QUICK(), [H('NAIC Expense Reporting')]);
add('GCCM-1003/UIF/TC-018', 'AUTO_PA', QUICK(), [V('Total Amount of Payment', { required: true }), { fieldKind: { label: 'Total Amount of Payment', kind: 'masked' } }, H('Blind Check Amount')]);
add('GCCM-1003/UIF/TC-019', 'AUTO_PA', QUICK(), [V('Service Period Start', { editable: true })]);
add('GCCM-1003/UIF/TC-020', 'AUTO_PA', QUICK(), [V('Service Period End', { editable: true })]);
add('GCCM-1003/UIF/TC-021', 'AUTO_PA', QUICK(), [V('Cause of Loss', { readonly: true, value: /\S/ })]);
add('GCCM-1003/UIF/TC-023', 'PROP_PA', QUICK(), [H('Original Billed Amount')]);
add('GCCM-1003/UIF/TC-025', 'PROP_PA', QUICK(), [H('PA Tort Code')]);
add('GCCM-1003/UIF/TC-027', 'AUTO_PA', QUICK(), [{ header: { name: 'Category', present: true } }]);
add('GCCM-1003/UIF/TC-032', 'AUTO_PA', QUICK(), [H('Average Weekly Wage')]);
add('GCCM-1003/UIF/TC-034', 'AUTO_PA', QUICK(), [H('Disability Weekly Rate')]);
add('GCCM-1003/UIF/TC-042', 'AUTO_PA', QUICK(), [V('Payment for a total loss?', { required: true, radios: ['Yes', 'No'] })]);
add('GCCM-1003/UIF/TC-044', 'AUTO_PA', [...QUICK(), { answer: ['Payment for a total loss?', 'Yes'] }], [V('VIN', { required: true, editable: true })]);
add('GCCM-1003/UIF/TC-045', 'AUTO_PA', [...QUICK(), { answer: ['Payment for a total loss?', 'No'] }], [H('VIN')]);
add('GCCM-1003/UIF/TC-046', 'AUTO_PA', [...QUICK(), { answer: ['Payment for a total loss?', 'Yes'] }], [V('Is the owner keeping this Vehicle?', { required: true })]);
add('GCCM-1003/UIF/TC-047', 'AUTO_PA', [...QUICK(), { answer: ['Payment for a total loss?', 'No'] }], [H('Is the owner keeping this Vehicle?')]);
add('GCCM-1003/UIF/TC-049', 'AUTO_PA', [...QUICK(), { answer: ['Payment for a total loss?', 'No'] }], [H('Is this vehicle owned by the Insured?')]);
add('GCCM-1003/UIF/TC-068', 'AUTO_PA', QUICK_DETAILS(), [V('Invoice Number/Remarks', { required: false })],
  'Test case expects NOT visible for non-vendor ClaimsPay types; Full Check (GCCM-799 TC-051) expects visible/not required — reported as observed.');
add('GCCM-1003/UIF/TC-069', 'AUTO_PA', QUICK_DETAILS(), [V('Remarks Line 2', { required: false, editable: true })]);
add('GCCM-1003/UIF/TC-070', 'AUTO_PA', QUICK_DETAILS(), [V('Claim Number', { readonly: true }), H('Memo')]);
add('GCCM-1003/UIF/TC-071', 'AUTO_PA', QUICK_DETAILS(), [V('Is this payment to an attorney or representative of the insured or claimant AND is the settlement payment or payment of a judgment?', { required: true })]);
add('GCCM-1003/UIF/TC-074', 'AUTO_PA', QUICK_DETAILS(), [{ header: { name: 'Send Status', present: true } }]);
add('GCCM-1003/UIF/TC-075', 'AUTO_PA', QUICK_DETAILS(), [V('ClaimsPay Type')]);
add('GCCM-1003/UIF/TC-076', 'AUTO_PA', QUICK_DETAILS(), [V('ClaimsPay Method', { required: true })]);
add('GCCM-1003/UIF/TC-080', 'AUTO_PA', QUICK_DETAILS(), [V('Payment Delivery', { editable: true, includes: PAY_DELIVERY, excludes: NOT_IN_PAY_DELIVERY })]);
add('GCCM-1003/UIF/TC-081', 'AUTO_PA', QUICK_DETAILS(), [H('Date of Service')]);

// ══ GCCM-763 / GCCM-803 — Payment validation rules (fired at Next; Finish only with ONEINC_ALLOW_FINISH=1) ════════
const VAL = (prefix, expectRe) => [...prefix, { validate: { expect: expectRe } }];
add('GCCM-763/VBR/TC-026', 'AUTO_PA', VAL([...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Partial Payment', amount: 'AVAILABLE' } }],
  /increase your reserve if exposure will remain open/i), []);
add('GCCM-763/VBR/TC-027', 'AUTO_PA', VAL([...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Partial Payment', amount: '1.00' } }], null), []);
add('GCCM-763/VBR/TC-040', 'AUTO_PA', VAL([...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'First and Final', amount: '1.00' } }],
  // Cloud words this rule "PMS PL08 : First and Final payment not allowed with ESTABLISHED reserve" (2026-10-20) —
  // same rule as the design's "…with open reserve"; the actual wording is recorded in the check.
  /First and Final Payment not allowed with (open|established) reserve/i), []);
add('GCCM-763/VBR/TC-051', 'AUTO_PA', VAL([...FULL_PAYMENTS('claimant', 'new'), { select: ['Cost Type', 'Claim Cost'] }, { select: ['Exposure', /claim-level/i] },
  { step2: { transactionType: 'Partial Payment', amount: '1.00', keepExposure: true } }], /not allowed at claim level/i), []);
add('GCCM-763/VBR/TC-052', 'AUTO_PA', VAL([...FULL_PAYMENTS('claimant', 'new'), { select: ['Cost Type', 'Claim Cost'] }, { select: ['Exposure', /claim-level/i] },
  { step2: { transactionType: 'First and Final', amount: '1.00', keepExposure: true } }], null), []);
add('GCCM-763/VBR/TC-059', 'AUTO_PA', VAL([...FULL_PAYMENTS('claimant', 'zero'), { step2: { transactionType: 'Final Payment', amount: '1.00' } }],
  /Final Payment not allowed without open reserve|PL50|not allowed without open reserve/i), []);
add('GCCM-763/VBR/TC-060', 'AUTO_PA', VAL([...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Final Payment', amount: '1.00' } }], null), []);
add('GCCM-803/TC/TC-015', 'AUTO_PA', VAL([...NEW_LINE('Claim Cost'), { step2: { transactionType: 'Partial Payment', amount: '1.00' } }], /Transaction Type must be first and final/i), []);
add('GCCM-803/TC/TC-016', 'AUTO_PA', VAL([...NEW_LINE('Claim Cost'), { step2: { transactionType: 'First and Final', amount: '1.00' } }], null), []);
add('GCCM-803/TC/TC-026', 'AUTO_PA', VAL([...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Partial Payment', amount: '0.00' } }], /amount greater than \$0/i), []);
add('GCCM-803/TC/TC-027', 'AUTO_PA', VAL([...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Partial Payment', amount: '-50.00' } }], /amount greater than \$0/i), []);
add('GCCM-803/TC/TC-028', 'AUTO_PA', VAL([...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Partial Payment', amount: '0.01' } }], null), []);
add('GCCM-803/TC/TC-035', 'AUTO_PA', VAL([...NEW_LINE('Adjuster Expense', 'vendor'), { step2: { transactionType: 'First and Final', amount: '1.00', skipAdjuster: true } }], /Adjuster number must be entered|Adjuster Number : Missing required field/i), [], 'Cloud enforces VBR.033 as a required field ("Adjuster Number : Missing required field") rather than the design message; the actual text is recorded.');
add('GCCM-803/TC/TC-036', 'AUTO_PA', VAL([...NEW_LINE('Adjuster Expense', 'vendor'), { step2: { transactionType: 'First and Final', amount: '1.00' } }], null), []);
add('GCCM-803/TC/TC-037', 'AUTO_PA', VAL([...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Partial Payment', amount: '1.00' } }], null), []);

// ── GCCM-763 / GCCM-803 rules runnable on the PA claim pool + an Address Book vendor (added 2026-10-21) ──────────
// Expense payments go to a vendor (VBR.025) on a new "Expense OR First and Final" line; claim-cost ones to the
// claimant on a line with open reserve. Dates use DOL±n / TODAY±n (resolved from the claim header).
const EXP = (amount, extra = {}) => [...NEW_LINE('Adjuster Expense', 'vendor'), { step2: { transactionType: 'First and Final', amount, ...extra } }];
const CC = (transactionType, amount, reserve = 'open') => [...FULL_PAYMENTS('claimant', reserve), { step2: { transactionType, amount } }];
const DOC_NOTE = 'Checks over $1,000 also need a linked document (VBR.010); the automation does not link one.';
// VBR.010 — document required over $1,000
add('GCCM-763/VBR/TC-028', 'AUTO_PA', VAL(EXP('1000.01'), /At least one document needs to be linked to checks over \$1,000/i), []);
add('GCCM-763/VBR/TC-030', 'AUTO_PA', VAL(EXP('1000.00'), null), [], 'Submits a $1,000.00 expense payment on TEST (Finish).');
// VBR.011 — expense over $99,999 (the $99,999.99 / $150,000 "no error" cases are left manual: without a linked document
// they are refused by VBR.010, and with one they would submit a ~$100k payment).
add('GCCM-763/VBR/TC-031', 'AUTO_PA', VAL(EXP('100000.00'), /Must do a manual check for full amount/i), [], DOC_NOTE);
// VBR.012 — service period start vs loss date
const SVC = (start) => [...FULL_PAYMENTS('claimant', 'open'), { fill: ['Service Period Start', start] }, { fill: ['Service Period End', 'TODAY'] }, { step2: { transactionType: 'Partial Payment', amount: '1.37' } }];
add('GCCM-763/VBR/TC-034', 'AUTO_PA', VAL(SVC('DOL-5'), /Service Period Start Date must be later than or equal to the Loss Date/i), []);
add('GCCM-763/VBR/TC-035', 'AUTO_PA', VAL(SVC('DOL'), null), [], 'Submits a $1.37 payment on TEST (Finish).');
add('GCCM-763/VBR/TC-036', 'AUTO_PA', VAL(SVC('DOL+1'), null), [], 'Submits a $1.37 payment on TEST (Finish).');
// VBR.013 — supplemental payment
// Cloud words VBR.013 "Supplemental payments allowed only with closed reserve" (2026-10-21) — same rule as the design's
// "Invalid supplemental payment"; the actual text is recorded in the check.
add('GCCM-763/VBR/TC-037', 'AUTO_PA', VAL(CC('Supplemental Payment', '1.37', 'open'), /Invalid supplemental payment|Supplemental payments allowed only with closed reserve/i), []);
add('GCCM-763/VBR/TC-039', 'AUTO_PA', VAL(CC('Supplemental Payment', '1.37', 'zero'), null), [], 'Needs a reserve line with history and $0 remaining; submits a $1.37 payment.');
// VBR.014 — First and Final with $0 remaining
add('GCCM-763/VBR/TC-041', 'AUTO_PA', VAL(CC('First and Final', '1.37', 'zero'), null), [], 'Submits a $1.37 payment on TEST (Finish).');
// VBR.017 — non-recurring check with a future pay date (Payment Date is on Step 3)
const PAYDATE = (d) => [...FULL_INSTRUCTIONS('claimant'), { fill: ['Payment Date', d] }];
add('GCCM-763/VBR/TC-048', 'AUTO_PA', VAL(PAYDATE('TODAY+5'), /cannot be issued with future schedule to pay date/i), []);
add('GCCM-763/VBR/TC-049', 'AUTO_PA', VAL(PAYDATE('TODAY'), null), [], 'Submits a $1.37 payment on TEST (Finish).');

// ── Lienholder payee (AUTO_LIEN claim: Lienholder/Mortgagee contacts + a vehicle loan, set up by claimCheck) ──────
// Single-payee cases only; joint (insured/claimant + lienholder) cases need "Add Joint Payees" (not automated yet).
const LIEN_NOTE = 'Payee = an Address Book company with the claim role Lienholder/Mortgagee (ACNB BANK); the vehicle incident has "Is there a loan on the Vehicle?" = Yes with that lienholder.';
const LIEN_FULL = (totalLoss) => [{ open: 'full' }, { payee: 'lienholder' }, { next: true }, { reserve: 'open' },
  { answer: ['Payment for a total loss?', totalLoss] }, { step2: {} }, { next: true }, { expectStep: 3 }];
const LIEN_QUICK = (totalLoss) => [QOPEN_LIEN, { payee: 'lienholder' }, { answer: ['Payment for a total loss?', totalLoss] }, { step2: {} }, { next: true }, { expectStep: 2 }];
const QOPEN_LIEN = { open: 'quick', needOpenReserve: true };
const LIEN_TL = [V('ClaimsPay Type', { value: /^lienholder$/i }), H('ClaimsPay Method')];
const LIEN_NTL = [V('ClaimsPay Type', { value: /other\s*\/\s*mailed check/i }), V('ClaimsPay Method', { value: /^mailed check$/i }),
  { text: { re: /Non Total Loss Lienholder payments requ/i, present: true } }];
// GCCM-799 (Full Check)
add('GCCM-799/CPD-Lienholder/TC-068', 'AUTO_LIEN', LIEN_FULL('Yes'), LIEN_TL, LIEN_NOTE);
add('GCCM-799/CPD-Lienholder/TC-070', 'AUTO_LIEN', LIEN_FULL('No'), LIEN_NTL, LIEN_NOTE);
add('GCCM-799/UIF/TC-058', 'AUTO_LIEN', LIEN_FULL('No'), [V('Reason for Check', { required: true, editable: true })],
  LIEN_NOTE + ' Cloud shows the reason as "Reason Details" (read-only) — reported as observed.');
add('GCCM-799/UIF/TC-062', 'AUTO_LIEN', LIEN_FULL('Yes'), [V('Loan Number', { required: true, editable: true }), H('Loan Account Number')], LIEN_NOTE);
// GCCM-1003 (Quick Payment)
add('GCCM-1003/CPD-Lienholder/TC-239', 'AUTO_LIEN', LIEN_QUICK('Yes'), LIEN_TL, LIEN_NOTE);
add('GCCM-1003/CPD-Lienholder/TC-241', 'AUTO_LIEN', LIEN_QUICK('No'), LIEN_NTL, LIEN_NOTE);
add('GCCM-1003/UIF/TC-077', 'AUTO_LIEN', LIEN_QUICK('No'), [V('Reason for Check', { required: true, editable: true })],
  LIEN_NOTE + ' Cloud shows the reason as "Reason Details" (read-only) — reported as observed.');
add('GCCM-1003/UIF/TC-078', 'AUTO_LIEN', LIEN_QUICK('Yes'), [V('Loan Number', { required: true, editable: true }), H('Loan Account Number')], LIEN_NOTE);
add('GCCM-1003/UIF/TC-079', 'AUTO_PA', [QOPEN_LIEN, { payee: 'vendor' }, { step2: {} }, { next: true }, { expectStep: 2 }], [H('Loan Number')], VENDOR_NOTE);

// ── Joint payees (Step 1 › Add Joint Payees) on the AUTO_LIEN claim ─────────────────────────────────────────────
// primary = { who, type } is the first payee; joint = [{ who, type }]. On claim 0748430 the insured is also the
// exposure claimant, so 'insured' vs 'claimant' differ only by the payee Type set here.
const JOINT_NOTE = LIEN_NOTE + ' Joint payees added with "Add Joint Payees"; payee Types set explicitly (Insured / Claimant / Lienholder/Mortgagee / Secondary Named Insured).';
const PRIMARY = (p) => [{ payee: p.who }, ...(p.type ? [{ select: ['Type', p.type] }] : [])];
const JOINT_FULL = (primary, joint, totalLoss = 'No') => [{ open: 'full' }, ...PRIMARY(primary), { joint }, { next: true }, { reserve: 'open' },
  { answer: ['Payment for a total loss?', totalLoss] }, { step2: {} }, { next: true }, { expectStep: 3 }];
const JOINT_QUICK = (primary, joint, totalLoss = 'No') => [QOPEN_LIEN, ...PRIMARY(primary), { joint }, { answer: ['Payment for a total loss?', totalLoss] },
  { step2: {} }, { next: true }, { expectStep: 2 }];
const MAILED = [V('ClaimsPay Type', { value: /other\s*\/\s*mailed check/i }), V('ClaimsPay Method', { value: /^mailed check$/i })];
const INS = { who: 'insured', type: 'Insured' };
const CLM = { who: 'claimant', type: 'Claimant' };
const LIEN = { who: 'lienholder', type: 'Lienholder/Mortgagee' };
const LIEN2 = { who: 'lienholder2', type: 'Lienholder/Mortgagee' };
const SNI = { who: 'other', type: 'Secondary Named Insured' };
const JOINT_CASES = [
  // [799 id, 1003 id, primary, joint, totalLoss, checks]
  ['GCCM-799/CPD-Lienholder/TC-069', 'GCCM-1003/CPD-Lienholder/TC-240', INS, [LIEN], 'Yes', [...MAILED, { text: { re: /^lienholder$/i, present: false } }]],
  ['GCCM-799/CPD-Lienholder/TC-071', 'GCCM-1003/CPD-Lienholder/TC-242', LIEN, [LIEN2], 'No', MAILED],
  ['GCCM-799/CPD-Lienholder/TC-072', 'GCCM-1003/CPD-Lienholder/TC-243', INS, [LIEN], 'No', MAILED],
  ['GCCM-799/CPD-Lienholder/TC-073', 'GCCM-1003/CPD-Lienholder/TC-244', CLM, [LIEN], 'No', MAILED],
  ['GCCM-799/CPD-Lienholder/TC-074', 'GCCM-1003/CPD-Lienholder/TC-245', INS, [SNI, LIEN], 'No', MAILED],
];
for (const [full, quick, primary, joint, tl, checks] of JOINT_CASES) {
  add(full, 'AUTO_LIEN', JOINT_FULL(primary, joint, tl), checks, JOINT_NOTE);
  // Quick Payment Step 1 has no Add Joint Payees (CONFIRMED 2026-10-21) — check for it first; while it is missing the
  // case is a FAIL (possible pending development), not BLOCKED. Once it exists, the rest of the case runs.
  add(quick, 'AUTO_LIEN', [QOPEN_LIEN, ...PRIMARY(primary)], [{ button: { name: 'Add Joint Payees', present: true } }], JOINT_NOTE + ' Full case flow once the button exists: ' + JOINT_QUICK(primary, joint, tl).map((x) => Object.keys(x)[0]).join(' → '));
}
// ── Mortgagee (PROP_MORT: HO claim with Lienholder/Mortgagee contacts + a mortgage on the fixed-property incident) ──
const MORT_NOTE = 'HO claim; mortgagee = an Address Book company with the claim role Lienholder/Mortgagee, named on the property incident\'s mortgage ("Is there a mortgage on this property?" = Yes).';
const MORT = { who: 'lienholder', type: 'Mortgagee' }; // HO payee Type "Mortgagee" (also offered: Lienholder/Mortgagee)
const SNI_REAL = { who: 'sni' };
const MORT_FULL = (primary, joint) => [{ open: 'full' }, ...PRIMARY(primary), ...(joint.length ? [{ joint }] : []), { next: true }, { reserve: 'open' },
  { step2: {} }, { next: true }, { expectStep: 3 }];
const CONTACTS_MORT = [V('ClaimsPay Type', { value: /contact\(s\)\s*(and|&)\s*mortgagee/i }), V('ClaimsPay Method', { value: /customer choice|let customer pick/i })];
add('GCCM-799/CPD-Mortgagee/TC-76', 'PROP_MORT', MORT_FULL(INS, [MORT]), CONTACTS_MORT, MORT_NOTE);
add('GCCM-799/CPD-Mortgagee/TC-77', 'PROP_MORT', MORT_FULL(INS, [SNI_REAL, MORT]), CONTACTS_MORT, MORT_NOTE);
add('GCCM-799/CPD-Mortgagee/TC-78', 'PROP_MORT', MORT_FULL(MORT, []), [V('ClaimsPay Type', { value: /^vendor$/i }), V('ClaimsPay Method', { value: /^mailed check$/i })], MORT_NOTE);
// Quick Payment: joint cases need Add Joint Payees (missing on Quick Payment); mortgagee-only runs the full flow.
add('GCCM-1003/CPD-Mortgagee/TC-247', 'PROP_MORT', [QOPEN_LIEN, ...PRIMARY(INS)], [{ button: { name: 'Add Joint Payees', present: true } }], MORT_NOTE);
add('GCCM-1003/CPD-Mortgagee/TC-248', 'PROP_MORT', [QOPEN_LIEN, ...PRIMARY(INS)], [{ button: { name: 'Add Joint Payees', present: true } }], MORT_NOTE);
add('GCCM-1003/CPD-Mortgagee/TC-249', 'PROP_MORT', [QOPEN_LIEN, ...PRIMARY(MORT), { step2: {} }, { next: true }, { expectStep: 2 }],
  [V('ClaimsPay Type', { value: /^vendor$/i }), V('ClaimsPay Method', { value: /^mailed check$/i })], MORT_NOTE);

// CPD.026 — 3 or more payees (not the exempt insured/secondary-insured/vendor combinations)
add('GCCM-799/CPD-Joint/TC-79', 'AUTO_LIEN', JOINT_FULL(INS, [{ who: 'other', type: 'Other' }, LIEN]),
  [V('ClaimsPay Type', { value: /3 or more payees/i }), V('ClaimsPay Method', { value: /^mailed check$/i })], JOINT_NOTE);

// ── GCCM-1003 Quick Payment mirrors of the GCCM-763 rules above (same rule, same expected text; Quick Payment is
// opened from a Financials reserve row, so the reserve line comes from that row: 'open' = positive remaining, 'zero'
// = $0 remaining). Added 2026-10-21.
const QOPEN = (reserve = 'open') => (reserve === 'zero' ? { open: 'quick', zeroReserve: true } : { open: 'quick', needOpenReserve: true });
const QCC = (transactionType, amount, reserve = 'open', pre = []) => [QOPEN(reserve), ...pre, { step2: { transactionType, amount } }];
const QSUB = 'Submits a $1.37 Quick Payment on TEST (Finish).';
// VBR.009
add('GCCM-1003/VBR/TC-109', 'AUTO_PA', VAL(QCC('Partial Payment', 'AVAILABLE'), /increase your reserve if exposure will remain open/i), []);
add('GCCM-1003/VBR/TC-110', 'AUTO_PA', VAL(QCC('Partial Payment', '1.37'), null), [], QSUB);
// VBR.012
const QSVC = (start) => QCC('Partial Payment', '1.37', 'open', [{ fill: ['Service Period Start', start] }, { fill: ['Service Period End', 'TODAY'] }]);
add('GCCM-1003/VBR/TC-117', 'AUTO_PA', VAL(QSVC('DOL-5'), /Service Period Start Date must be later than or equal to the Loss Date/i), []);
add('GCCM-1003/VBR/TC-118', 'AUTO_PA', VAL(QSVC('DOL'), null), [], QSUB);
add('GCCM-1003/VBR/TC-119', 'AUTO_PA', VAL(QSVC('DOL+1'), null), [], QSUB);
// VBR.013
add('GCCM-1003/VBR/TC-120', 'AUTO_PA', VAL(QCC('Supplemental Payment', '1.37'), /Invalid supplemental payment|Supplemental payments allowed only with closed reserve/i), []);
add('GCCM-1003/VBR/TC-122', 'AUTO_PA', VAL(QCC('Supplemental Payment', '1.37', 'zero'), null), [], 'Needs a reserve line with history and $0 remaining; ' + QSUB);
// VBR.014
add('GCCM-1003/VBR/TC-123', 'AUTO_PA', VAL(QCC('First and Final', '1.37'), /First and Final Payment not allowed with (open|established) reserve/i), []);
add('GCCM-1003/VBR/TC-124', 'AUTO_PA', VAL(QCC('First and Final', '1.37', 'zero'), null), [], QSUB);
// VBR.017 — Payment Date is on Quick Payment step 2
const QPAYDATE = (d) => [...QUICK_DETAILS(), { fill: ['Payment Date', d] }];
add('GCCM-1003/VBR/TC-131', 'AUTO_PA', VAL(QPAYDATE('TODAY+5'), /cannot be issued with future schedule to pay date/i), []);
add('GCCM-1003/VBR/TC-132', 'AUTO_PA', VAL(QPAYDATE('TODAY'), null), [], QSUB);
// VBR.021
add('GCCM-1003/VBR/TC-142', 'AUTO_PA', VAL(QCC('Final Payment', '1.37', 'zero'), /Final Payment not allowed without open reserve|PL50|not allowed without open reserve/i), []);
add('GCCM-1003/VBR/TC-143', 'AUTO_PA', VAL(QCC('Final Payment', '1.37'), null), [], 'Closes the reserve line it pays (Final Payment) — runs last. ' + QSUB);
// VBR.025 — payee must be valid for expense payments
// TC-007 (payee NOT in the Address Book) and TC-038 (vendor WITHOUT a Tax ID) need payees the test claims don't have —
// a claim contact trips the payee-TYPE check ("Invalid payee…") first (CONFIRMED 2026-10-21) — so they stay needs-data.
add('GCCM-803/TC/TC-008', 'AUTO_PA', VAL(NEW_LINE('Adjuster Expense', 'claimant').concat({ step2: { transactionType: 'First and Final', amount: '1.37' } }),
  /Invalid payee|must be vendor or other/i), [], 'Payee = an individual (claimant) — not a Vendor/Other.');
add('GCCM-803/TC/TC-010', 'AUTO_PA', VAL(EXP('1.37'), null), [], 'Active Address Book vendor; submits a $1.37 expense payment.');
add('GCCM-803/TC/TC-012', 'AUTO_PA', VAL(CC('Partial Payment', '1.37'), null), [], 'Claim cost to a non-vendor contact; submits $1.37.');
// VBR.034 — Tax ID required for expense payments
add('GCCM-803/TC/TC-039', 'AUTO_PA', VAL(EXP('1.37'), null), [], 'Vendor with a Tax ID; submits a $1.37 expense payment.');
add('GCCM-803/TC/TC-040', 'AUTO_PA', VAL(CC('Partial Payment', '1.37'), null), [], 'Claim cost to the claimant (no Tax ID); submits $1.37.');

// ══ GCCM-783 — Parties Involved / Contact Manager accelerator (ClaimsPay section hidden in CC) ═══════════════════
add('GCCM-783/TC/TC-002', 'AUTO_PA', [{ nav: 'parties' }, { openFirstRow: 'contact' }], [{ text: { re: /ClaimsPay/i, present: false } }, { button: { name: 'ClaimsPay', present: false } }],
  'Checks the contacts present on the test claim (first contact opened); Company/Vendor/Legal contact types are covered only if present.');
add('GCCM-783/TC/TC-003', 'AUTO_PA', [{ nav: 'lossDetails' }], [{ text: { re: /ClaimsPay/i, present: false } }]);

// ── Extension recipe files (added 2026-10-21 for parallel work) ──────────────────────────────────────────────────
// Every helpers/oneInc/recipes/*.js exports (api) => void and registers recipes with api.add(...). Builders below are
// shared so extension files read like this one. A later add() for the same id replaces the earlier recipe.
const BUILDERS = { add, R, V, H, VAL, FULL_PAYEES, FULL_PAYMENTS, FULL_INSTRUCTIONS, NEW_LINE, QUICK, QUICK_DETAILS, QOPEN, QCC, QSVC, QPAYDATE, QSUB,
  EXP, CC, SVC, PAYDATE, DOC_NOTE, PRIMARY, JOINT_FULL, JOINT_QUICK, LIEN_FULL, LIEN_QUICK, QOPEN_LIEN, MAILED, INS, CLM, LIEN, LIEN2, SNI, MORT,
  SNI_REAL, MORT_FULL, CONTACTS_MORT, VENDOR_NOTE, LIEN_NOTE, JOINT_NOTE, MORT_NOTE, CPD_NOTE, TXN_TYPES, PAY_DELIVERY, NOT_IN_PAY_DELIVERY, cpd,
  NO_CONTACT_DETAILS };
{
  const dir = require('path').join(__dirname, 'recipes');
  const files = require('fs').existsSync(dir) ? require('fs').readdirSync(dir).filter((f) => f.endsWith('.js')).sort() : [];
  for (const f of files) require(require('path').join(dir, f))(BUILDERS);
}

module.exports = { RECIPES: R, NO_CONTACT_DETAILS, BUILDERS };
