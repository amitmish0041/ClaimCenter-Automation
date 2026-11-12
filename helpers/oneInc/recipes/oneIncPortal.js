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
  const DIRTY_PAY = (amount) => [pc('addDirtyContacts'), ...VAL([{ open: 'full' }, { payee: P1 }, { joint: [{ who: P2, type: 'Additional Claimant' }] }, pc('payeeRowType', 0, 'Additional Claimant'), { next: true }, { reserve: 'open' },
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
  // ── CPD.029 — payee = Adverse Carrier / Other Insurance Company (subrogation outbound), single payee ─────────────
  // Not an integration case (classifier matched "Subro Outbound"): the ClaimsPay defaults are on the payment screen.
  // The carrier is a claim-only company (NOT in the Address Book) added to the new claim (portalChecks.COMPANIES).
  const SUBRO = require('../portalChecks').COMPANIES.subroCarrier.name;
  const ADVERSE = 'Adverse Carrier/Other Insurance Company';
  const SUBRO_CHECKS = [V('ClaimsPay Type', { value: /Subrogation.*not in address book/i }), V('ClaimsPay Method', { value: /^Mailed Check$/i })];
  const SUBRO_NOTE = `New PA auto claim; payee = claim-only company "${SUBRO}" (not in the Address Book), payee Type "${ADVERSE}". `;
  add('GCCM-799/CPD-Joint/TC-84', 'AUTO_PA', [{ open: 'full' }, { payee: SUBRO }, { select: ['Type', ADVERSE] }, { next: true }, { reserve: 'open' }, { step2: {} }, { next: true }, { expectStep: 3 }],
    SUBRO_CHECKS, SUBRO_NOTE + 'Full Check, Step 3.');
  add('GCCM-1003/CPD-Joint/TC-255', 'AUTO_PA', [{ open: 'quick', needOpenReserve: true }, { payee: SUBRO }, { select: ['Type', ADVERSE] }, { step2: {} }, { next: true }, { expectStep: 2 }],
    SUBRO_CHECKS, SUBRO_NOTE + 'Quick Payment, Step 2.');
  // ── CreateVendor / business cleansing on OneInc's Business/Vendor Report (ContactManager vendor BAIKOW LEGAL LLC) ────
  // ContactManager edits are TEST-only, recorded in the shared restore ledger first and reverted at the end (contactManager.js,
  // user authorization 2026-10-22); runOneInc also restores after a BLOCKED case. CreateVendor carried BAIKOW's address change
  // to OneInc on 11/06 (DateModified 11:59 PST) — the case waits up to 20 min for it.
  const cmv = (fn, ...a) => ({ call: [`contactManager.${fn}`, ...a] });
  const BAIKOW = 'BAIKOW LEGAL LLC';
  const BAIKOW_TAX = '02-0725566';
  const VENDOR_NOTE2 = `ContactManager vendor ${BAIKOW} (Tax ID ${BAIKOW_TAX}; OneInc BusinessID ab:145846), read on OneInc's Business/Vendor Report. `;
  add('GCCM-795/INT/TC-001', 'ONEINC_ISSUED', [cmv('restoreVendors'), cmv('setCompanyAddress', BAIKOW, BAIKOW_TAX, 'B'),
    pc('oneIncVendor', { tin: '020725566', until: { field: 'BillingStreet', re: '1195 RIVER' }, waitMin: 20 })],
  [V('OneInc Vendor BillingStreet', { value: /1195 RIVER RD/i }), V('OneInc Vendor City', { value: /MARIETTA/i }), cmv('restoreVendors')],
  VENDOR_NOTE2 + 'Its primary address is changed in ContactManager (1195 River Rd, Marietta); the update must reach OneInc (CreateVendor) with the new address. Restored afterwards.');
  add('GCCM-1013/INT/TC-127', 'ONEINC_ISSUED', [cmv('restoreVendors'), cmv('setCompanyAddress', BAIKOW, BAIKOW_TAX, '1195 "River" Rd & <B>||Marietta|Lancaster|PA|17547'),
    pc('oneIncVendor', { tin: '020725566', until: { field: 'BillingStreet', re: '1195' }, waitMin: 20 })],
  [V('OneInc Vendor BillingStreet', { value: /^(?!.*["&<>]).*1195s+RIVERs+RD/i }), cmv('restoreVendors')],
  VENDOR_NOTE2 + 'BUS_Street set in ContactManager to 1195 "River" Rd & <B>: OneInc must receive it without quotation marks, ampersands or chevrons. Restored afterwards.');
  add('GCCM-1013/INT/TC-122', 'ONEINC_ISSUED', [pc('oneIncVendor', { tin: '020725566' })], [V('OneInc Vendor Tin', { value: /^020725566$/ })],
    VENDOR_NOTE2 + `Its Tax ID is "${BAIKOW_TAX}" in ContactManager; OneInc must hold it with the hyphen removed (020725566). Read-only. (OneInc's own "BusinessID" column holds the Address Book id ab:145846, which has no spaces/hyphens/commas either.)`);

  // ── GCCM-791 UIF.001 — OneInc payment method on a new Bulk Invoice (user with the Create OneInc Bulk Invoice permission) ──
  // The standard TEST login has Desktop › Bulk Invoices and its new invoice offers OneInc (oneinc_gc, CONFIRMED 2026-11-11).
  // The permission itself cannot be viewed or changed with the TEST logins (the admin login has no Roles screen), so
  // TC-001 / 002 / 004 stay manual (caseReasons.js).
  add('GCCM-791/TC/TC-003', 'ONEINC_ISSUED', [{ call: ['bulkInvoice.newInvoicePaymentMethods'] }],
    [V('Bulk Invoice Payment Methods', { value: /oneinc/i }), { call: ['bulkInvoice.cancelInvoice'] }],
    'Logged in as the standard TEST user (Bulk Invoices on the Desktop): Bulk Invoices › Create New › Check Details › Payment Method must offer OneInc. Read-only: the new invoice is cancelled.');

  // ── INT.020 / INT.022 — business payee names (PCON / SCON last name when PCONBusiness / SCONBusiness = Y) ─────────────
  const CO = require('../portalChecks').COMPANIES;
  const BIZ_FIELDS = ['Insured First Name', 'Insured Last Name', 'CoInsured First Name', 'CoInsured Last Name', 'Vendor Name', 'Additional Text Field 3', 'Additional Text Field 8'];
  const BIZ_PAY = (amount) => [pc('addDirtyCompanies'), ...VAL([{ open: 'full' }, { payee: CO.dirtyBiz1.name }, { joint: [{ who: CO.dirtyBiz2.name, type: 'Additional Claimant' }] }, pc('payeeRowType', 0, 'Additional Claimant'),
    { next: true }, { reserve: 'open' }, { step2: { transactionType: 'Partial Payment', amount } }], null), op('escalateChecks', amount), pc('oneIncPayment', { fields: BIZ_FIELDS, amount, waitMin: 20 })];
  const BIZ_NOTE = `New PA auto claim (shared by the cleansing cases). Payee = claim-only company "${CO.dirtyBiz1.name}" with joint payee claim-only company "${CO.dirtyBiz2.name}" (both businesses), submitted and sent to OneInc; read on the OneInc staging portal. `;
  add('GCCM-1013/INT/TC-117', 'INT_CLEAN', BIZ_PAY('1.68'), [V('OneInc Insured Last Name', { value: /^ACME ROOFING CO$/i })],
    BIZ_NOTE + 'PCON last name of a business payee: "%", "~" and "< >" are not in the business set and must be removed — "ACME ROOFING CO".');
  add('GCCM-1013/INT/TC-119', 'INT_CLEAN', BIZ_PAY('1.69'), [V('OneInc CoInsured Last Name', { value: /^BETA PAVING LLC$/i })],
    BIZ_NOTE + 'SCON last name of a business joint payee: "|" and "`" must be removed — "BETA PAVING LLC".');

  // ── VBR.099 — a payment on an exposure with bulk payments pending (GCCM-1013 VBR TC-101; admin-type change approved 2026-11-11) ──
  // A $1.00 Draft bulk invoice with one item on the claim's Claim Cost line is created (bulkInvoice.createPendingInvoice,
  // ledger on the share) and deleted at the end (and by runOneInc after a BLOCKED case).
  const BULK = /There are bulk payments currently pending for this exposure/i;
  add('GCCM-1013/VBR/TC-101', 'AUTO_PA', [{ call: ['bulkInvoice.createPendingInvoice'] }, { open: 'full' }, { payee: 'claimant' }, { next: true }, { reserve: 'open' }, { step2: {} }, { click: 'Next' }],
    [{ message: { re: BULK, present: true } }, { call: ['bulkInvoice.deletePending'] }],
    'New PA auto claim: a $1.00 Draft bulk invoice (Desktop › Bulk Invoices, payee BAIKOW LEGAL LLC) gets one item on the Claim Cost line of the claim; a Full Check on that line must stop on Next with the pending-bulk-payments error. The bulk invoice is deleted afterwards.');

  // ── GCCM-791 UIF.001 — the "Create OneInc Bulk Invoice" permission (Roles admin: run with CC_ADMIN_USER = su) ───────────
  // Bulk Invoice Payer holds it today; TC-002 removes it and adds it back through the UI (the role ends as it started);
  // TC-004 removes it, reads the standard user's new bulk invoice, and puts it back. Ledger + restore (adminRoles.js).
  const ar = (fn, ...a) => ({ call: [`adminRoles.${fn}`, ...a] });
  const ROLE = 'Bulk Invoice Payer';
  const PERM = 'Create OneInc Bulk Invoice';
  const RN = 'Administration › Users & Security › Roles, as the Roles admin login (su). ';
  add('GCCM-791/TC/TC-001', 'ONEINC_ISSUED', [ar('addRolePermissionOptions')], [V('New Role permission options', { value: /Create OneInc Bulk Invoice/ })],
    RN + 'Add Role › permissions › Add: the Permission dropdown must offer "Create OneInc Bulk Invoice". The new role is cancelled.');
  add('GCCM-791/TC/TC-002', 'ONEINC_ISSUED', [ar('restoreRoles'), ar('removePermission', ROLE, PERM), ar('addPermission', ROLE, PERM), ar('rolePermissions', ROLE)],
    [V(`${ROLE} permissions`, { value: /Create OneInc Bulk Invoice/ }), ar('restoreRoles')],
    RN + `"${PERM}" (already on ${ROLE}) is removed and then added back through Edit › Add › Permission › Update; the saved role must list it. The role ends as it started.`);
  add('GCCM-791/TC/TC-004', 'ONEINC_ISSUED', [ar('restoreRoles'), ar('removePermission', ROLE, PERM), ar('standardUserBulkInvoiceMethods')],
    [V('Standard user: Bulk Invoice Payment Methods', { value: /^(?![sS]*oneinc)/i }), ar('restoreRoles')],
    RN + `"${PERM}" is removed from ${ROLE} for the check, then the standard TEST user (a Bulk Invoice Payer) opens Bulk Invoices › Create New: OneInc must not be offered. The permission is put back right after.`);

  // ── CPD.002 — payment approver with / without email & phone (Admin › Users, as su in a separate session) ───────────────
  // The approver of the standard user's payments, Keith Eisenhart (keiteise), has NO email and NO phone (Profile, CONFIRMED
  // 2026-11-11), so the positive cases need no change; the negative ones give him the case's test e-mail (approver@example.com)
  // for the check and blank it again (adminUsers ledger + restore). $5.00 is over the standard user's $1.00 authority, so
  // the payment needs the approver.
  const au = (fn, ...a) => ({ call: [`adminUsers.${fn}`, ...a] });
  const APPROVER = 'keiteise';
  const OTHER_MAILED = /Other.*Mailed Check/i;
  const QUICK5 = [{ open: 'quick', needOpenReserve: true }, { payee: 'claimant' }, { step2: { transactionType: 'Partial Payment', amount: '5.00' } }, { next: true }, { expectStep: 2 }];
  const FULL5 = [{ open: 'full' }, { payee: 'claimant' }, { next: true }, { reserve: 'open' }, { step2: { transactionType: 'Partial Payment', amount: '5.00' } }, { next: true }, { expectStep: 3 }];
  const NO_CONTACT = V(`${APPROVER} email/phone`, { value: /Email: (blank).*Primary Phone: (blank).*Work: (blank).*Mobile: (blank)/ });
  const APN = 'New PA auto claim; claimant payee, $5.00 (over the standard user’s $1.00 authority, so the payment needs the approver Keith Eisenhart). ';
  add('GCCM-1003/CPD/TC-210', 'AUTO_PA', QUICK5, [V('ClaimsPay Type', { value: OTHER_MAILED }), V('ClaimsPay Method', { value: /check/i }), au('userContact', APPROVER), NO_CONTACT],
    APN + 'Approver has no email and no phone: ClaimsPay Type must default to Other / Mailed Check and Method to Check. Quick Payment.');
  add('GCCM-759/CPD/TC-033', 'AUTO_PA', FULL5, [V('ClaimsPay Type', { value: OTHER_MAILED }), V('ClaimsPay Method', { value: /check/i }), au('userContact', APPROVER), NO_CONTACT],
    APN + 'Approver has no email and no phone: ClaimsPay Type must default to Other / Mailed Check and Method to Check. Full Check.');
  add('GCCM-1003/CPD/TC-211', 'AUTO_PA', [au('restoreUsers'), au('setUserEmail', APPROVER, 'approver@example.com'), ...QUICK5],
    [V('ClaimsPay Type', { value: /^(?![sS]*Other.*Mailed Check)/i }), au('restoreUsers')],
    APN + 'Approver given the email approver@example.com for the check (blanked again after): ClaimsPay Type must NOT default to Other / Mailed Check by this rule. Quick Payment.');
  add('GCCM-759/CPD/TC-034', 'AUTO_PA', [au('restoreUsers'), au('setUserEmail', APPROVER, 'approver@example.com'), ...FULL5],
    [V('ClaimsPay Type', { value: /^(?![sS]*Other.*Mailed Check)/i }), au('restoreUsers')],
    APN + 'Approver given the email approver@example.com for the check (blanked again after): ClaimsPay Type must NOT default to Other / Mailed Check by this rule. Full Check.');

  // ── VBR.097 — WC payment with no Employment Status while EnableWCEmploymentStatusValidation = Yes ───────────────────────
  // The switch is already Yes on TEST (Admin › Utilities › Script Parameters, read 2026-11-11), so nothing is changed.
  add('GCCM-1013/VBR/TC-099', 'WC_PA', [{ call: ['setupA.setLossDetailAnswers', { 'Employment Status': '<none>' }] },
    ...VAL([...FULL_PAYMENTS('claimant', 'open'), { step2: { transactionType: 'Partial Payment', amount: '1.37' } }], /Employment Status must be selected in Loss Details/i)], [],
  'New PA WC claim with Employment Status left blank (Loss Details); EnableWCEmploymentStatusValidation is Yes on TEST (read 2026-11-11). A Full Check must stop at Finish with "Employment Status must be selected in Loss Details."');
};
