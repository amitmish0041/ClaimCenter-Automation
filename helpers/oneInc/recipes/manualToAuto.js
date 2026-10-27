/**
 * helpers/oneInc/recipes/manualToAuto.js — cases moved from manual to automated (2026-10-27): VBR.036 mailing address
 * auto-update, VBR.029 VIN on claim cost payments, VBR.025 expense payee validity by Adjuster Number, VBR.003 claim
 * cost + expense on one check, CPD.027/028 Legal Settlement ClaimsPay Type, UIF.025/026 wage fields on Quick Payment,
 * UIF.070 Reason Description, and GCCM-783 UIF.003 (ClaimsPay section hidden in ContactManager).
 * Setup / observation steps live in helpers/oneInc/manualToAuto.js; ContactManager edits go through
 * helpers/oneInc/contactManager.js (restore ledger results/oneInc/cm-restore.json, needs CM_USER / CM_PASS).
 *
 * Every payment case runs on a NEW claim of its own (runOneInc fresh data) and builds its precondition there.
 * Left manual (caseReasons.js): GCCM-803 TC-025 / GCCM-1003 VBR TC-170 (Alliance Glass flag) and GCCM-1003 VBR TC-088
 * (Quick Payment has no Add Payment).
 */
'use strict';

module.exports = (api) => {
  const { add, V, H, VAL, FULL_INSTRUCTIONS, QOPEN_LIEN, VENDOR_NOTE } = api;
  const m = (fn, ...a) => ({ call: [`manualToAuto.${fn}`, ...a] });
  const op = (fn, ...a) => ({ call: [`checkOps.${fn}`, ...a] });
  const cm = (fn, ...a) => ({ call: [`contactManager.${fn}`, ...a] });
  const sa = (fn, ...a) => ({ call: [`setupA.${fn}`, ...a] });
  const vendorByTaxId = (search, taxId) => ({ call: ['reuseExt.selectVendorByTaxId', search, taxId] });

  // ══ VBR.036 — check mailing address follows the payee's Address Book address while the check is unsent ══════════
  // Payee BAIKOW LEGAL LLC (Address Book vendor, Tax ID 02-0725566), picked by Tax ID so the new claim gets it as a
  // linked contact. Address Book contacts are read-only in ClaimCenter (no Edit — CONFIRMED 2026-10-27), so its primary
  // address is changed in ContactManager (to 1195 River Rd, Marietta) and reaches ClaimCenter by the Address Book sync
  // in ~40 s (CONFIRMED 2026-10-27); the original (111 North Cedar Crest Blvd, Allentown) is restored at the end
  // (ledger). The design's "future-dated" check cannot be made — VBR.017 refuses a non-recurring check with a future
  // pay date — so an unsent check dated today ("Awaiting submission") stands for "not yet sent". The negative case runs
  // the Financials Escalation batch first (checkOps.escalateChecks, admin login), which moves the check to Requesting
  // (sent to OneInc); Issued never happens on TEST.
  const PAYEE = 'BAIKOW LEGAL LLC';
  const TAX = '02-0725566';
  const OLD = /111 NORTH CEDAR CREST/i;
  const NEW = /1195 RIVER RD/i;
  const PAY = (quick, amount) => [cm('restoreVendors'), // settle a ledger left by an interrupted run first
    ...(quick ? [{ open: 'quick', needOpenReserve: true }, vendorByTaxId('BAIKOW LEGAL', TAX)] : [{ open: 'full' }, vendorByTaxId('BAIKOW LEGAL', TAX), { next: true }, { reserve: 'open' }]),
    { step2: { transactionType: 'Partial Payment', amount } }, { validate: { expect: null } }];
  const CHECK = (amount) => m('checkMailingAddress', { payee: 'BAIKOW', amount });
  const CHANGE = [cm('setCompanyAddress', PAYEE, TAX, 'B'), m('waitContactAddress', PAYEE, '1195 RIVER RD')];
  const POSITIVE = (amount) => [CHECK(amount), V('Check status', { value: /Awaiting submission/i }), V('Check mailing address', { value: OLD }),
    ...CHANGE, CHECK(amount), V('Check mailing address', { value: NEW }), cm('restoreVendors')];
  const NEGATIVE = (amount) => [op('escalateChecks', amount), CHECK(amount), V('Check status', { value: /^Request(ing|ed)$/i }), V('Check mailing address', { value: OLD }),
    ...CHANGE, CHECK(amount), V('Check mailing address', { value: OLD }), cm('restoreVendors')];
  const N36 = `Payee ${PAYEE} (Address Book vendor by Tax ID ${TAX}); claim cost partial payment submitted (Finish). The vendor's primary address is changed in ContactManager (needs CM_USER / CM_PASS) once Parties Involved shows it, and restored at the end.`;
  add('GCCM-803/TC/TC-044', 'AUTO_PA', PAY(false, '1.43'), POSITIVE('1.43'),
    `${N36} Check left "Awaiting submission" (unsent): its Mailing Address must change to the new address. The "legacy mail-to cleared" half needs a mail-to set on the check first — not built.`);
  add('GCCM-803/TC/TC-045', 'AUTO_PA', PAY(false, '1.44'), NEGATIVE('1.44'),
    `${N36} Financials Escalation batch run first (check → Requesting = sent; needs CC_ADMIN_USER / CC_ADMIN_PASS): its Mailing Address must NOT change.`);
  add('GCCM-1003/VBR/TC-189', 'AUTO_PA', PAY(true, '1.45'), POSITIVE('1.45'), `${N36} Quick Payment; check left "Awaiting submission".`);
  add('GCCM-1003/VBR/TC-190', 'AUTO_PA', PAY(true, '1.46'), NEGATIVE('1.46'), `${N36} Quick Payment; Financials Escalation batch run first (check → Requesting).`);

  // ══ VBR.029 — claim cost payment on an exposure whose vehicle incident has no VIN ═══════════════════════════════
  // manualToAuto.prepareVinIncident blanks the VIN of the FNOL-added vehicle (the policy vehicle's VIN is locked) and
  // sets its Year (and the claim Loss Cause when the case names one); the payment goes on the reserve line of the
  // exposure using that vehicle. Next does not fire the rule (CONFIRMED 2026-10-27) — Finish does; a payment that is not
  // stopped is submitted ($1.37). ExtAllianceGlassClaim is not on any ClaimCenter screen, so FALSE is the new claim's default.
  // Cloud words VBR.029 "The Vehicle Identification Number (VIN) must be present" (Finish, CONFIRMED 2026-10-27; it
  // fires for Year 1987 and not for Year 1985 / Collision, so it is the year-gated rule) — either text is accepted.
  const VIN_RE = /Vehicle Identification Number must be entered before the payment can be issued|The Vehicle Identification Number \(VIN\) must be present/i;
  const VIN_FULL = (o) => [m('prepareVinIncident', o), { open: 'full' }, { payee: 'claimant' }, { next: true }, m('selectVinLine'), { step2: { transactionType: 'Partial Payment', amount: '1.37' } }];
  const VIN_QUICK = (o) => [m('prepareVinIncident', o), m('openQuickOnVinLine'), { step2: { transactionType: 'Partial Payment', amount: '1.37' } }];
  const NV = (o) => `Vehicle incident of the paid exposure: VIN blank, Year ${o.year}${o.lossCause ? `; claim Loss Cause ${o.lossCause}${o.detailed ? ' / Detailed Loss Cause ' + o.detailed : ''}` : ''}. Claimant payee, $1.37 partial claim cost payment.`;
  const Y87 = { year: '1987' };
  const THEFT = { year: '1985', lossCause: 'Theft of Auto', detailed: 'Total' };
  const OLDCAR = { year: '1985', lossCause: 'Collision' };
  add('GCCM-803/TC/TC-021', 'AUTO_PA', VAL(VIN_FULL(Y87), VIN_RE), [], NV(Y87));
  add('GCCM-803/TC/TC-022', 'AUTO_PA', VAL(VIN_FULL(THEFT), VIN_RE), [], NV(THEFT));
  add('GCCM-803/TC/TC-024', 'AUTO_PA', VAL(VIN_FULL(OLDCAR), null), [], NV(OLDCAR) + ' No error expected — submits the payment.');
  add('GCCM-1003/VBR/TC-166', 'AUTO_PA', VAL(VIN_QUICK(Y87), VIN_RE), [], NV(Y87) + ' Quick Payment from that exposure\'s reserve row.');
  add('GCCM-1003/VBR/TC-167', 'AUTO_PA', VAL(VIN_QUICK(THEFT), VIN_RE), [], NV(THEFT) + ' Quick Payment from that exposure\'s reserve row.');
  add('GCCM-1003/VBR/TC-169', 'AUTO_PA', VAL(VIN_QUICK(OLDCAR), null), [], NV(OLDCAR) + ' Quick Payment from that exposure\'s reserve row. No error expected — submits the payment.');

  // ══ VBR.025 — expense payee must be valid unless the Adjuster Number is P01–P03 / M01–M03 ═══════════════════════
  // Adjuster Number options on the PA auto claims (CONFIRMED 2026-10-27): 100/500/600/A00/C00/…/M01/M02/M03/P02/P03/…;
  // there is NO P01, so the excluded-number cases use P02 (same exclusion list). Qualifying number: "100 Property
  // Independent Adjusters". "Expired" payee = TAYLOR REPORTING SERVICE with Tax ID Valid Until in the past (set in
  // ContactManager, restored after) — the record state that gives "This payee is no longer valid" on an expense payment
  // (seen 2026-10-22 on GCCM-803 TC-031). Quick Payment opens from an expense reserve row, which a new claim does not
  // have: manualToAuto.openQuickOnExpenseRow builds it first with a $1.4x vendor First and Final expense payment.
  const TAYLOR = 'TAYLOR REPORTING SERVICE';
  const TTAX = '58-2338930';
  const EXPIRED = cm('setTaxValidUntil', TAYLOR, TTAX, 'past');
  const PICK_T = vendorByTaxId('TAYLOR REPORTING', TTAX);
  const ADJ = (re) => ({ select: ['Adjuster Number', re] }); // after the payment details (filling them re-renders the form)
  const NOT_VALID = /This payee is no longer valid/i;
  const FULL_EXP = (payee) => [{ open: 'full' }, ...payee, { next: true }, { reserve: 'new' }, { select: ['Cost Type', 'Adjuster Expense'] }, { step2: { transactionType: 'First and Final', amount: '1.37' } }];
  const QUICK_EXP = (payee) => [m('openQuickOnExpenseRow'), ...payee, { step2: { transactionType: 'First and Final', amount: '1.37' } }];
  const N25 = `Expense payment (Adjuster Expense). Payee ${TAYLOR} (${TTAX}) with "Tax ID Valid Until" set to a past date in ContactManager (restored afterwards; needs CM_USER / CM_PASS).`;
  const N25N = 'Expense payment (Adjuster Expense) to the claimant — a claim contact, not in the Address Book — with Adjuster Number P02 (P01 is not offered on the claim; P02 is in the same exclusion list). No error expected — submits $1.37.';
  add('GCCM-803/TC/TC-009', 'AUTO_PA', VAL([EXPIRED, ...FULL_EXP([PICK_T]), ADJ(/^100 /)], NOT_VALID), [cm('restoreVendors')], `${N25} Adjuster Number 100 (qualifying).`);
  add('GCCM-803/TC/TC-011', 'AUTO_PA', VAL([...FULL_EXP([{ payee: 'claimant' }]), ADJ(/^P02 /)], null), [], N25N);
  add('GCCM-1003/VBR/TC-154', 'AUTO_PA', VAL([EXPIRED, ...QUICK_EXP([PICK_T]), ADJ(/^100 /)], NOT_VALID), [cm('restoreVendors')], `${N25} Adjuster Number 100 (qualifying). Quick Payment from an Adjuster Expense row.`);
  add('GCCM-1003/VBR/TC-156', 'AUTO_PA', VAL([...QUICK_EXP([{ payee: 'claimant' }]), ADJ(/^P02 /)], null), [], N25N + ' Quick Payment from an Adjuster Expense row.');

  // ══ VBR.003 — a claim cost and an expense on the same check ═════════════════════════════════════════════════════
  // Full Check: claim cost on an open line, Add Payment, an Adjuster Expense payment on a new line (as GCCM-1013
  // TC-059, which showed Next does not stop on the "same exposure" rule). Payee = an Address Book vendor so VBR.025 does
  // not answer first. If the rule does not stop it, Finish submits both payments ($1.37 + $1.38).
  add('GCCM-763/VBR/TC-006', 'AUTO_PA', VAL([{ open: 'full' }, { payee: 'vendor' }, { next: true }, { reserve: 'open' }, { step2: { amount: '1.37' } },
    { click: 'Add Payment' }, { reserve: 'new' }, { select: ['Cost Type', 'Adjuster Expense'] }, { step2: { transactionType: 'First and Final', amount: '1.38' } }],
  /A claim cost and an expense cannot be paid on the same check/i), [], `${VENDOR_NOTE} Claim Cost $1.37 + Adjuster Expense $1.38 (Add Payment) on one check.`);

  // ══ CPD.027 / CPD.028 — "Legal Settlement - Paper Check Required" in ClaimsPay Type ═════════════════════════════
  // CONFIRMED 2026-10-27: with a vendor payee the option is offered; choosing it sets ClaimsPay Method "Mailed Check",
  // Payment Delivery "Standard" (Certified Mail / Expedite Mail / Print Now offered) and hides Reason for Check. The
  // design's "Claim Rep … Legal Settlement" field does not exist on Step 3, and "Business TIN" is payload — not checked.
  const LEGAL = 'Legal Settlement - Paper Check Required';
  const LEGAL_CHECKS = (defaultType) => [V('ClaimsPay Type', { value: defaultType }), V('ClaimsPay Type', { includes: [LEGAL] }),
    { select: ['ClaimsPay Type', /^Legal Settlement/] }, V('ClaimsPay Method', { value: /^mailed check$/i }),
    V('Payment Delivery', { value: /^standard$/i, includes: ['Standard', 'Certified Mail', 'Expedite Mail'] }), H('Reason for Check')];
  const VEND_ONLY = /^vendor$/i;
  const C_AND_V = /contact\(s\)\s*(and|&)\s*vendor/i;
  add('GCCM-799/CPD-Joint/TC-81', 'AUTO_PA', FULL_INSTRUCTIONS('vendor'), LEGAL_CHECKS(VEND_ONLY),
    VENDOR_NOTE + ' The default-type check fails while CC leaves ClaimsPay Type blank for a vendor-only payee (CPD.013 finding); the Legal Settlement checks run regardless.');
  // Quick Payment step 2 with a vendor-only payee shows NO ClaimsPay Type / Method / Payment Delivery at all (CONFIRMED
  // 2026-10-27 on PA-PA-01-26-0748608), so only the field checks run — a select on the missing field would turn the FAIL
  // into BLOCKED. Once the fields exist, add the LEGAL_CHECKS tail (select Legal Settlement → Mailed Check / Standard).
  add('GCCM-1003/CPD-Joint/TC-252', 'AUTO_PA', [QOPEN_LIEN, { payee: 'vendor' }, { step2: {} }, { next: true }, { expectStep: 2 }], LEGAL_CHECKS(VEND_ONLY).slice(0, 2),
    VENDOR_NOTE + ' Quick Payment step 2 (Set Payment Details).');
  // CPD.028 on the HO_SNI claim: its insured (Robert Charles) has e-mail and phone, so CPD.001's Other / Mailed Check
  // does not take over (the PA auto insureds have no e-mail). The joint grid lists claim contacts only, so the vendor is
  // the primary payee (Address Book search by Tax ID) and the insured the joint payee — same payee pair as the design.
  add('GCCM-799/CPD-Joint/TC-82', 'HO_SNI', [{ open: 'full' }, { payee: 'vendor' }, { joint: [{ who: 'insured', type: 'Insured' }] }, { next: true }, { reserve: 'open' },
    { step2: {} }, { next: true }, { expectStep: 3 }], LEGAL_CHECKS(C_AND_V),
  VENDOR_NOTE + ' Joint payee: the HO insured (e-mail + phone), typed Insured.');
  // Quick Payment Step 1 has no "Add Joint Payees" (CONFIRMED 2026-10-21, as for the other Quick joint cases): checked
  // first; while it is missing the case FAILs (possible pending development).
  add('GCCM-1003/CPD-Joint/TC-253', 'AUTO_PA', [QOPEN_LIEN, { payee: 'insured' }], [{ button: { name: 'Add Joint Payees', present: true } }],
    'Insured + vendor joint payees on Quick Payment. Full case flow once the button exists: as GCCM-799 CPD-Joint TC-82 on Quick Payment step 2.');

  // ══ UIF.025 / UIF.026 — Average Weekly Wage / Disability Weekly Rate on Quick Payment "Enter payment basics" ═════
  // WCA_LW claim (Lost Time severity → Indemnity / Lost Wages exposure); exposure wages set first (setupA.setIndemnityExposure),
  // Quick Payment from the Indemnity row, line category 05 (TTD).
  const EXPO = sa('setIndemnityExposure', { 'Average Weekly Wage': '800.00', 'Disability Weekly Rate': '500.00', 'Disability Type': 'TTD', 'Benefit Offset Code': 'None', 'Reason TTD or TPD Ended': '<none>' });
  const LWQ = [EXPO, sa('openQuickOnLine', /Indemnity/), { select: ['Transaction Type', 'Partial Payment'] }, sa('selectLineCategory', '^05')];
  const NLW = 'WC claim with a Lost Time severity: Indemnity (Lost Wages) exposure (Average Weekly Wage 800 / Disability Weekly Rate 500 / TTD); Quick Payment on the Indemnity (claim cost) row, line category 05.';
  add('GCCM-1003/UIF/TC-031', 'WCA_LW', LWQ, [V('Average Weekly Wage', { required: true, editable: true })], NLW);
  add('GCCM-1003/UIF/TC-033', 'WCA_LW', LWQ, [V('Disability Weekly Rate', { required: true, editable: true })], NLW);

  // ══ UIF.070 — Reason Description when the mailed-check reason is OTHER ══════════════════════════════════════════
  // CONFIRMED 2026-10-27: "Reason for Check" (ClaimsPay Type Other / Mailed Check) offers OTHER; choosing it shows a
  // required "Reason Description" text box.
  add('GCCM-799/UIF/TC-059', 'AUTO_PA', [...FULL_INSTRUCTIONS('claimant'), m('chooseMailedCheck'), { select: ['Reason for Check', 'OTHER'] }],
    [V('Reason Description', { required: true, editable: true })],
    'Claimant payee, mailed check: ClaimsPay Type Other / Mailed Check when CC defaults it (payee without e-mail/phone), else Type Contact(s) with Method Mailed Check; Reason for Check = OTHER.');

  // ══ GCCM-783 UIF.003 — no ClaimsPay section in ContactManager ═══════════════════════════════════════════════════
  // manualToAuto.cmClaimsPayReview opens a Person (David Thomas), a Company (BAIKOW LEGAL LLC) and a Financial
  // Institution (ACNB BANK) in ContactManager TEST (read-only; needs CM_USER / CM_PASS), reads every card of the
  // contact screen and the Actions menu for "ClaimsPay", and presses Reset on the search screen first. CONFIRMED
  // 2026-10-27: cards are Basics / Addresses / Related Contacts for all three types. The claim is not used.
  const NO_CP = /^no ClaimsPay section, link or option/;
  add('GCCM-783/TC/TC-001', 'AUTO_PA', [m('cmClaimsPayReview')], [
    V('CM Person contact', { value: NO_CP }), V('CM Company contact', { value: NO_CP }), V('CM Financial Institution contact', { value: NO_CP }),
    V('CM Person search Reset', { value: /^cleared$/ }), V('CM Company search Reset', { value: /^cleared$/ }), V('CM Financial Institution search Reset', { value: /^cleared$/ }),
  ], 'ContactManager TEST, one contact of each type; read-only.');
};
