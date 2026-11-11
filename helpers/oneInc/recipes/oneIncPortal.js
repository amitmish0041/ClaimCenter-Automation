/**
 * helpers/oneInc/recipes/oneIncPortal.js — cases judged on the OneInc side, read from the OneInc staging Admin Portal
 * (helpers/oneInc/portal.js — one signed-in portal window, started with scripts/oneIncPortalSession.js; added 2026-11-11).
 *
 * INT.001 / INT.002 (GCCM-1003 INT TC-197–207, GCCM-803 TC-053–063): PM_Additional_Text_13 = the claim's Underwriting
 * Company and PM_Additional_Text_14 = "<company> and affiliated insurance companies conduct business together as the
 * Donegal Insurance Group®." On the portal these are "Additional Text Field 13 / 14" of the payment (CONFIRMED 2026-11-11:
 * HO-PA-01-26-0749093's checks carry "Southern Insurance Company of Virginia" and its disclaimer). Each case reads the
 * claim's Underwriting Company (Policy screen) and the newest ClaimCenter payment of that claim on the portal; nothing is
 * saved, except on the Le Mars claim, which has no payment on the portal yet: a $1.5x payment is made, sent (Financials
 * Escalation batch) and waited for.
 * Not automatable yet: Sheboygan Falls Insurance Company and Mountain States Commercial Insurance Company — no TEST claim
 * with either Underwriting Company found (caseReasons.js).
 */
'use strict';

module.exports = (api) => {
  const { add, V, H, VAL, FULL_PAYMENTS } = api;
  const pc = (fn, ...a) => ({ call: [`portalChecks.${fn}`, ...a] });
  const op = (fn, ...a) => ({ call: [`checkOps.${fn}`, ...a] });
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const AT = ['Additional Text Field 13', 'Additional Text Field 14'];

  // [1003 TC, 803 TC, profile, company as the case names it in AT13, the claim's own Underwriting Company, AT14 ends with ® ?]
  const COMPANIES = [
    ['197', '053', 'UW_DMIC', 'Donegal Mutual Insurance Company', /^Donegal Mutual Insurance Company$/, true],
    ['198', '054', 'UW_ASIC', 'Atlantic States Insurance Company', /^Atlantic States Insurance Company$/, true],
    ['199', '055', 'UW_SICV', 'Southern Insurance Company of Virginia', /^Southern Insurance Company of Virginia$/, true],
    ['200', '056', 'UW_LEMARS', 'Le Mars Insurance Company', /^Le Mars Insurance Company$/, true],
    ['201', '057', 'UW_SMIC', 'Southern Mutual Insurance Company', /^Southern Mutual Insurance Company$/, true],
    ['203', '059', 'UW_MICH', 'Michigan Insurance Company', /^Michigan Insurance Company$/, true],
    ['204', '060', 'UW_PIC', 'The Peninsula Indemnity Company', /Peninsula Indemnity/, false],
    ['205', '061', 'UW_TPIC', 'The Peninsula Insurance Company', /^The Peninsula Insurance Company$/, false],
    ['206', '062', 'UW_MSI', 'Mountain States Indemnity Company', /^Mountain States Indemnity/, true],
  ];
  for (const [t1003, t803, profile, company, claimUw, mark] of COMPANIES) {
    const disclaimer = `${company} and affiliated insurance companies conduct business together as the Donegal Insurance Group${mark ? '®' : ''}.`;
    const checks = [V('Claim Underwriting Company', { value: claimUw }), V('OneInc Additional Text Field 13', { value: new RegExp(esc(company)) }),
      V('OneInc Additional Text Field 14', { value: new RegExp(`^${esc(disclaimer)}$`) })];
    for (const [id, amount] of [[`GCCM-1003/INT/TC-${t1003}`, '1.51'], [`GCCM-803/TC/TC-${t803}`, '1.52']]) {
      const lemars = profile === 'UW_LEMARS';
      const steps = lemars
        ? [...VAL([...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Partial Payment', amount } }], null),
          op('escalateChecks', amount), pc('underwritingCompany'), pc('oneIncPayment', { fields: AT, amount, waitMin: 20 })]
        : [pc('underwritingCompany'), pc('oneIncPayment', { fields: AT })];
      add(id, profile, steps, checks,
        `Existing TEST claim underwritten by ${company.replace(/^The /, '')} (profiles/oneIncPortal.js). Reads the claim's Underwriting Company (Policy screen) and `
        + (lemars ? `makes a $${amount} payment, sends it (Financials Escalation batch) and waits for it on the OneInc portal; `
          : 'the newest ClaimCenter payment of that claim on the OneInc staging portal; nothing is saved; ')
        + `PM_Additional_Text_13 / 14 are the payment's "Additional Text Field 13 / 14" there. Expected AT14: "${disclaimer}"`);
    }
  }

  // ── INT.018–031 payload cleansing (GCCM-1013 INT) ───────────────────────────────────────────────────────────────
  // A Full Check to a claim-only person whose name / address carry characters the request must drop, with a second such
  // person as joint payee (SCON), submitted and sent (Financials Escalation batch); the portal's payment then shows what
  // OneInc received: Insured First/Last Name = PCON, CoInsured First/Last Name = SCON, Payment Mailing Address = PMA.
  const { DIRTY } = require('../portalChecks');
  const P1 = `${DIRTY.primary.first} ${DIRTY.primary.last}`;
  const P2 = `${DIRTY.secondary.first} ${DIRTY.secondary.last}`;
  const NAMES = ['Insured First Name', 'Insured Last Name', 'CoInsured First Name', 'CoInsured Last Name', 'Payment Mailing Address', 'Additional Text Field 3', 'Additional Text Field 8'];
  const DIRTY_PAY = (amount) => [pc('addDirtyContacts'), ...VAL([{ open: 'full' }, { payee: P1 }, { joint: [{ who: P2 }] }, pc('sendTaxIdRow', 0), { next: true }, { reserve: 'open' },
    { step2: { transactionType: 'Partial Payment', amount } }], null), op('escalateChecks', amount), pc('oneIncPayment', { fields: NAMES, amount, waitMin: 20 })];
  const CLEAN_NOTE = `New PA auto claim (shared by the cleansing cases). Payee "${P1}" (claim-only person; address ${JSON.stringify(DIRTY.primary.address)}) with joint payee "${P2}"; the payment is submitted, sent to OneInc (Financials Escalation batch) and read on the OneInc staging portal. `;
  add('GCCM-1013/INT/TC-115', 'INT_CLEAN', DIRTY_PAY('1.61'), [V('OneInc Insured First Name', { value: /^JOHN5$/i }), V('OneInc CoInsured First Name', { value: /^MKE$/i })],
    CLEAN_NOTE + 'PCON / SCON first names "jo#hn$5" / "m!ke%" must arrive as "JOHN5" / "MKE" (only letters, digits, space, hyphen, period and apostrophe kept).');
  add('GCCM-1013/INT/TC-116', 'INT_CLEAN', DIRTY_PAY('1.62'), [V('OneInc Insured Last Name', { value: /^O'BRIEN-X$/i })],
    CLEAN_NOTE + 'PCON last name (a person, PCONBusiness = N) "o’b%ri*en-x" with the plain apostrophe must arrive as "O\'BRIEN-X".'.replace('’', "'"));
  add('GCCM-1013/INT/TC-118', 'INT_CLEAN', DIRTY_PAY('1.63'), [V('OneInc CoInsured Last Name', { value: /^SMITH\.JR$/i })],
    CLEAN_NOTE + 'SCON last name (a person, SCONBusiness = N) "sm~it%h.jr" must arrive as "SMITH.JR".');
  // ClaimCenter itself drops the quotes and < > from a contact's address line when the contact is saved (it stored
  // '12 main st & rear', CONFIRMED 2026-11-11); the "&" reaches the payment, so the check is that none of " & < > is sent.
  add('GCCM-1013/INT/TC-123', 'INT_CLEAN', DIRTY_PAY('1.64'), [V('OneInc Payment Mailing Address', { value: /^(?!.*["&<>]).*12 MAIN ST/i })],
    CLEAN_NOTE + 'PMA street "12 \\"main\\" st & <rear>" (stored by ClaimCenter as "12 main st & rear") must reach OneInc with no quotation marks, ampersands or chevrons.');
  add('GCCM-1013/INT/TC-124', 'INT_CLEAN', DIRTY_PAY('1.65'), [V('OneInc Payment Mailing Address', { value: /,\s*LANCASTER\s*,/i })],
    CLEAN_NOTE + 'City "lan%cas*ter" must arrive as "LANCASTER" (% and * are not in the allowed set).');
  add('GCCM-1013/INT/TC-125', 'INT_CLEAN', DIRTY_PAY('1.66'), ['Insured First Name', 'Insured Last Name', 'CoInsured First Name', 'CoInsured Last Name', 'Payment Mailing Address']
    .map((f) => V(`OneInc ${f}`, { value: /^(?=.*[A-Z])[^a-z]*$/ })), CLEAN_NOTE + 'Every name and address value is entered in lower case on ClaimCenter and must reach OneInc in CAPS.');
  add('GCCM-1013/INT/TC-126', 'INT_CLEAN', DIRTY_PAY('1.67'), [V('OneInc Payment Mailing Address', { value: /\|\s*UNIT 7/i })],
    CLEAN_NOTE + 'The payee address has two lines ("12 main st & rear" / "unit 7"): OneInc must receive them joined by a pipe ("…|UNIT 7").');

  // ── OneInc status / feedback shown in ClaimCenter (existing TEST payments; profiles/oneIncPortal.js) ─────────────────
  // portalChecks.oneIncCheck reads the payment's state on the OneInc portal and opens the ClaimCenter check behind it.
  const OIC = (o) => pc('oneIncCheck', o);
  const ISSUED = OIC({ status: '^Issued$', method: '^Check$' });
  const APD = op('openAPD');
  const PAYPAL = 'PA-MI-70-26-0747959'; // OneInc Issued PayPal payment 2100000097 ($15.00)
  const FEEDBACK_HDR = /Feedback Id\s+Create Date\s+Cleared Date\s+Paid Date\s+Check Print Date\s+Status\s+New Method\s+ClaimsPay Method\s+Monitored/i;
  const ISSUED_ROW = /\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2} [AP]M\s+(\d{2}\/\d{2}\/\d{4}\s+)?\d{2}\/\d{2}\/\d{4}\s+Issued/i;
  const T = (re, present = true) => ({ text: { re, present } });
  const EXN = (what) => `Existing TEST claim whose OneInc payment is ${what} (OneInc staging portal, profiles/oneIncPortal.js); the ClaimCenter check is matched by the OneInc check number (or Payment Identifier = CR Tracking Number). `;
  const RO = 'Read-only: nothing is saved.';

  add('GCCM-1008/APD/TC-001', 'ONEINC_ISSUED', [ISSUED, APD],
    [V('One Inc Payment Number', { value: /^\d+$/ }), V('CR Tracking Number', { value: /\S/ }), V('ClaimsPay Method Id', { value: /\S/ }), V('Preferred ClaimsPay Method', { value: /\S/ }),
      V('Payment Amount', { value: /\$\d/ }), V('Current Payment Status', { value: /issued/i }), { button: { name: 'Refresh', present: true } }, { button: { name: 'Get Payment Status', present: true } },
      T(/Workflow History/), T(FEEDBACK_HDR)], EXN('Issued (mailed check)') + 'Additional Payment Details: upper section fields, Workflow History and Payment Feedback Received. ' + RO);
  add('GCCM-1008/APD/TC-002', 'ONEINC_ISSUED', [OIC({ claim: PAYPAL, status: '^Issued$', method: 'PayPal|Venmo' }), APD],
    [H('One Inc Payment Number'), V('CR Tracking Number', { value: /\S/ }), T(FEEDBACK_HDR)],
    EXN('Issued by PayPal/Venmo') + `Claim ${PAYPAL}: ClaimCenter has no OneInc payment number for its PayPal payment (2100000097), so "One Inc Payment Number" must not display. ` + RO);
  add('GCCM-1008/APD/TC-004', 'ONEINC_ISSUED', [ISSUED, APD],
    [T(/Workflow History/), T(/Attempting to send payment with PMethod '[^']+' to One Inc/), T(/Payment submitted successfully to One Inc/)],
    EXN('Issued') + 'Workflow History lists the on-prem ExtDigitalPaymentWorkflow events (send attempt, submitted). ' + RO);
  add('GCCM-1008/APD/TC-005', 'ONEINC_ISSUED', [ISSUED, APD],
    [V('Current Payment Status', { value: /issued/i }), T(/Payment issued as '[^']+' with ClaimsPay Payment Number '\d+'/)],
    EXN('Issued') + 'The status change to Issued (OneInc) is logged in Workflow History. ' + RO);
  add('GCCM-1008/APD/TC-007', 'ONEINC_ISSUED', [ISSUED, APD], [T(FEEDBACK_HDR), T(ISSUED_ROW)],
    EXN('Issued') + 'Payment Feedback Received carries the webhook entry: create date, paid date, status Issued. ' + RO);
  add('GCCM-1008/APD/TC-008', 'ONEINC_VC_ISSUED', [OIC({ status: '^Issued$', method: 'Virtual Card' }), APD, pc('noteField', 'One Inc Payment Number', 'Digital payment: One Inc Payment Number'),
    pc('noteField', 'Current Payment Status', 'Digital payment: Current Payment Status'), OIC({ claim: PAYPAL, status: '^Issued$', method: 'PayPal|Venmo' }), APD, pc('showNotes')],
  [V('Digital payment: One Inc Payment Number', { value: /^\d+$/ }), V('Digital payment: Current Payment Status', { value: /issued/i }), V('Preferred ClaimsPay Method', { value: /PayPal|Venmo/i })],
  EXN(`Issued as a Virtual Card (digital) and, on ${PAYPAL}, by PayPal`) + 'Upper section of Additional Payment Details for a digital payment (One Inc Payment Number = Check.ExtClaimsPayPaymentNumber) and a PayPal one (Preferred ClaimsPay Method). ' + RO);
  add('GCCM-1013/UIF/TC-015', 'ONEINC_ISSUED', [ISSUED], [V('Preferred Payment Method', { value: /\S/ })],
    EXN('Issued with OneInc feedback (Mailed Check confirmed)') + 'Check/Payment Details must show "Preferred Payment Method" once feedback arrived. ' + RO);
  add('GCCM-1013/APD/TC-134', 'ONEINC_ISSUED', [ISSUED, APD, { click: 'Get Payment Status' }],
    [V('Current Payment Status', { value: /issued/i }), { message: { re: /error|exception|failed/i, present: false } }, T(/Payment Feedback Received/)],
    EXN('Issued') + 'Additional Payment Details › Get Payment Status: the latest OneInc status (Issued) is shown, no error. ' + RO);

  // 787 INT.001 — voiding an Issued OneInc check sends the stop request and leaves it Pending Void (uses up one check per run).
  add('GCCM-787/TC/TC-021', 'ONEINC_VOID_ISSUED', [ISSUED, op('openVoid'), op('submitVoid', 'Automation test - void request to OneInc', 'No'), pc('reopenCheck')],
    [V('Check status', { value: /^Pending void$/i })], EXN('Issued (mailed check)') + 'The check is voided (Repost = No); it must then show Pending Void while OneInc processes the stop.');
  // 787 INT.002 / INT.006 — OneInc Stopped / Cancelled (no payment method chosen) must leave the check Voided in ClaimCenter.
  add('GCCM-787/TC/TC-022', 'ONEINC_STOPPED', [OIC({ status: '^Stopped$', method: '^Check$' })], [V('OneInc Status', { value: /^Stopped$/i }), V('Check status', { value: /^Voided$/i }), op('workplan')],
    EXN('Stopped (mailed check, not PayPal/Venmo)') + 'ClaimCenter must show the check Voided. The Workplan is read for the record (activities digital_payment_stoppending_reminder / digital_payment_reminder have no fixed subject to match). ' + RO);
  add('GCCM-787/TC/TC-028', 'ONEINC_CANCELLED', [OIC({ status: '^Cancelled$', method: 'Undefined|Customer' })], [V('OneInc Status', { value: /^Cancelled$/i }), V('Check status', { value: /^Voided$/i }), op('workplan')],
    EXN('Cancelled before the payee chose a payment method (Undefined - Let Customer PickUp)') + 'ClaimCenter must show the check Voided. ' + RO);
};
