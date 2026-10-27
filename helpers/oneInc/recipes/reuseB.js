/**
 * helpers/oneInc/recipes/reuseB.js — "high reuse" OneInc recipes, added 2026-10-21:
 *   1. vendor-payee cases (Address Book vendor by Tax ID) incl. contact + vendor joint checks;
 *   2. GCCM-1003 Quick Payment mirrors of rules already automated for the Full Check (GCCM-763/803);
 *   3. DE / MD aged date-of-loss rules (VBR.004 / 005 / 015) on the aged pool claims (profiles/reuseB.js);
 *   4. lienholder / mortgagee / joint-payee leftovers and the HO building-damage (roof) cases.
 * Helpers live in ../reuseExt.js and are called with { call: ['reuseExt.<fn>', ...args] }.
 *
 * Warning rules (VBR.004/005/007/015) use reuseExt.finishObserve instead of the core `validate` step: core presses
 * Finish a second time on a warnings-only page, which would hide the very warning under test and submit the payment.
 * finishObserve stops at the first warning/error (Next or Finish) and writes what happened into a read-only
 * "Finish outcome" field that the checks below read: "submitted: check N (…)" | "stopped at Next/Finish: [type] text".
 */
'use strict';

module.exports = (api) => {
  const { add, V, H, VAL, FULL_PAYEES, FULL_PAYMENTS, FULL_INSTRUCTIONS, NEW_LINE, QUICK, QOPEN, QCC, CC, PRIMARY, JOINT_FULL,
    QOPEN_LIEN, MAILED, INS, CLM, LIEN, MORT, SNI_REAL, MORT_FULL, VENDOR_NOTE, JOINT_NOTE, MORT_NOTE, NO_CONTACT_DETAILS } = api;

  const X = (fn, ...a) => ({ call: [`reuseExt.${fn}`, ...a] });
  const FINISH = X('finishObserve');
  const OUT = (re) => V('Finish outcome', { value: re });
  const SUBMITTED = OUT(/^submitted: check \d+/);
  const SUB = (amt) => `Submits a $${amt} payment on TEST (Finish) when no rule stops it.`;
  const VENDOR = { who: 'vendor' };
  const PERSON2 = { who: '@person', type: 'Additional Claimant' }; // a second person contact typed as secondary claimant

  // ════ 2. GCCM-1003 Quick Payment mirrors of the GCCM-763 / GCCM-803 rules ═════════════════════════════════════
  // Expense Quick Payments open from a reserve row under an expense cost-type heading (reuseExt.openQuickOnRow); the
  // payee must then be a vendor (VBR.025). Claim cost ones use the core QCC builder (row with open reserve).
  const QEXP = (amount, extra = {}, payee = 'vendor') => [X('openQuickOnRow', 'expense', 'any'), { payee }, { step2: { amount, ...extra } }];
  const QEXP_NOTE = 'Quick Payment opened from the claim\'s Adjuster Expense reserve row (Financials); payee = Address Book vendor.';
  // VBR.030 — amount must be > $0 (mirrors GCCM-803 TC-026/027/028)
  add('GCCM-1003/VBR/TC-171', 'AUTO_PA', VAL(QCC('Partial Payment', '0.00'), /amount greater than \$0/i), []);
  add('GCCM-1003/VBR/TC-172', 'AUTO_PA', VAL(QCC('Partial Payment', '-50.00'), /amount greater than \$0/i), []);
  add('GCCM-1003/VBR/TC-173', 'AUTO_PA', VAL(QCC('Partial Payment', '0.01'), null), [], SUB('0.01'));
  // VBR.010 — document over $1,000 (claim cost on a row with enough open reserve that VBR.009 cannot fire)
  const QROW = (min) => X('openQuickOnRow', 'claim cost', min);
  add('GCCM-1003/VBR/TC-111', 'AUTO_PA', VAL([QROW(1100), { step2: { transactionType: 'Partial Payment', amount: '1000.01' } }],
    /At least one document needs to be linked to checks over \$1,000/i), []);
  add('GCCM-1003/VBR/TC-113', 'AUTO_PA', VAL([QROW(1100), { step2: { transactionType: 'Partial Payment', amount: '1000.00' } }], null), [],
    'Submits a $1,000.00 Quick Payment on TEST (no document linked — exactly $1,000 is allowed).');
  // VBR.011 — expense over $99,999 (TC-115 / TC-116 stay manual, as for GCCM-763 TC-032/033)
  add('GCCM-1003/VBR/TC-114', 'AUTO_PA', VAL(QEXP('100000.00'), /Must do a manual check for full amount/i), [], QEXP_NOTE);
  // VBR.025 — payee valid for expense payments
  add('GCCM-1003/VBR/TC-153', 'AUTO_PA', VAL(QEXP('1.57', {}, 'claimant'), /Invalid payee|must be vendor or other/i), [], 'Expense Quick Payment to an individual (claimant).');
  add('GCCM-1003/VBR/TC-155', 'AUTO_PA', VAL(QEXP('1.59'), null), [], QEXP_NOTE + ' ' + SUB('1.59'));
  add('GCCM-1003/VBR/TC-157', 'AUTO_PA', VAL(QCC('Partial Payment', '1.61'), null), [], 'Claim cost to a non-vendor contact. ' + SUB('1.61'));
  // VBR.033 — adjuster number for expense payments
  add('GCCM-1003/VBR/TC-180', 'AUTO_PA', VAL(QEXP('1.63', { skipAdjuster: true }), /Adjuster number must be entered|Adjuster Number : Missing required field/i), [],
    QEXP_NOTE + ' Cloud may enforce VBR.033 as a required field ("Adjuster Number : Missing required field"); the actual text is recorded.');
  add('GCCM-1003/VBR/TC-181', 'AUTO_PA', VAL(QEXP('1.67'), null), [], QEXP_NOTE + ' ' + SUB('1.67'));
  add('GCCM-1003/VBR/TC-182', 'AUTO_PA', VAL(QCC('Partial Payment', '1.69'), null), [], 'Claim cost Quick Payment, no Adjuster Number. ' + SUB('1.69'));
  // VBR.034 — Tax ID for expense payments
  add('GCCM-1003/VBR/TC-184', 'AUTO_PA', VAL(QEXP('1.71'), null), [], QEXP_NOTE + ' Vendor has a Tax ID. ' + SUB('1.71'));
  add('GCCM-1003/VBR/TC-185', 'AUTO_PA', VAL(QCC('Partial Payment', '1.73'), null), [], 'Claim cost to the claimant (no Tax ID). ' + SUB('1.73'));
  // Claim-cost "no error" cases that are a plain claim cost payment on an existing line with a specific exposure
  const VIN_NOTE = 'The vehicle incident has a VIN (filled by the claim prepare step).';
  add('GCCM-1003/VBR/TC-168', 'AUTO_PA', VAL(QCC('Partial Payment', '1.77'), null), [], VIN_NOTE + ' ' + SUB('1.77'));
  add('GCCM-803/TC/TC-023', 'AUTO_PA', VAL(CC('Partial Payment', '1.79'), null), [], VIN_NOTE + ' ' + SUB('1.79'));
  add('GCCM-1003/VBR/TC-136', 'AUTO_PA', VAL(QCC('Partial Payment', '1.81'), null), [], 'Partial payment on a specific exposure. ' + SUB('1.81'));
  add('GCCM-763/VBR/TC-053', 'AUTO_PA', VAL(CC('Partial Payment', '1.83'), null), [], 'Partial payment on a specific exposure. ' + SUB('1.83'));
  add('GCCM-1003/VBR/TC-162', 'AUTO_PA', VAL(QCC('Partial Payment', '1.87'), null), [], 'Existing Claim Cost reserve line, Partial Payment. ' + SUB('1.87'));
  add('GCCM-803/TC/TC-017', 'AUTO_PA', VAL(CC('Partial Payment', '1.89'), null), [], 'Existing Claim Cost reserve line, Partial Payment. ' + SUB('1.89'));
  add('GCCM-1003/VBR/TC-089', 'AUTO_PA', VAL(QCC('Partial Payment', '1.91'), null), [], 'Check with only a claim cost payment. ' + SUB('1.91'));
  add('GCCM-763/VBR/TC-007', 'AUTO_PA', VAL(CC('Partial Payment', '1.93'), null), [], 'Check with only a claim cost payment. ' + SUB('1.93'));

  // ── GCCM-1003 UI fields on Quick Payment (mirrors of GCCM-759/799 Full Check recipes) ──
  const QX = [X('openQuickOnRow', 'expense', 'any')];
  add('GCCM-1003/UIF/TC-004', 'AUTO_PA', QX, [H('Transaction Type')], QEXP_NOTE);
  add('GCCM-1003/UIF/TC-010', 'AUTO_PA', QX, [V('Adjuster Number', { required: true, editable: true })], QEXP_NOTE);
  add('GCCM-1003/UIF/TC-043', 'AUTO_PA', QX, [H('Payment for a total loss?')], QEXP_NOTE);
  add('GCCM-1003/UIF/TC-026', 'AUTO_PA', [...QX, { payee: 'vendor' }, { select: ['Adjuster Number', 0] }],
    [V('1099 Box Number', { required: true, editable: true, value: /^07/, includes: ['06-Medical Payments to Providers', '07-All Other Taxable Payments', '14-Gross Proceeds Paid to an Attorney'] })],
    QEXP_NOTE + ' Mirrors GCCM-799 TC-008 (expects the Box 7 default).');
  const LEGAL = 'needs a Legal Expense reserve row to open Quick Payment from — the test claims have none (Quick Payment cannot change the row\'s cost type)';
  add('GCCM-1003/UIF/TC-014', 'AUTO_PA', [X('openQuickOnRow', 'legal expense', 'any'), { select: ['Adjuster Number', /^800/] }],
    [V('Is the legal expense for a legal opinion on coverage or to litigate a coverage issue?', { required: true, radios: ['Yes', 'No'] })], LEGAL);
  add('GCCM-1003/UIF/TC-016', 'AUTO_PA', [X('openQuickOnRow', 'legal expense', 'any'), { select: ['Adjuster Number', /^400/] },
    { answer: ['Is the legal expense for a legal opinion on coverage or to litigate a coverage issue?', 'Yes'] }],
  [V('NAIC Expense Reporting', { value: /unallocated/i }), { answer: ['Is the legal expense for a legal opinion on coverage or to litigate a coverage issue?', 'No'] },
    V('NAIC Expense Reporting', { value: /^allocated/i })], LEGAL);
  add('GCCM-1003/UIF/TC-007', 'AUTO_PA', [...QUICK(), { payee: 'claimant' }], [V('Type', { required: true, editable: true, includes: ['Additional Claimant'] })]);
  add('GCCM-1003/UIF/TC-024', 'AUTO_PA', QUICK(), [V('PA Tort Code', { required: true, editable: true,
    unlessBlocked: 'needs a PA personal-auto policy with state numeric 37 and cause of loss LC03/LC09/LC90 — not confirmed on the test claim' })]);
  const TL = (owned) => [{ answer: ['Payment for a total loss?', 'Yes'] }, { answer: ['Is the owner keeping this Vehicle?', 'No'] }, { answer: ['Is this vehicle owned by the Insured?', owned] }];
  add('GCCM-1003/UIF/TC-048', 'AUTO_PA', [...QUICK(), { answer: ['Payment for a total loss?', 'Yes'] }], [V('Is this vehicle owned by the Insured?', { required: true, radios: ['Yes', 'No'],
    unlessBlocked: 'shows only when the exposure\'s loss party is the Insured — not confirmed on the test claim\'s reserve line' })]);
  add('GCCM-1003/UIF/TC-050', 'AUTO_PA', [...QUICK(), ...TL('Yes')], [V('Does this vehicle display on the CLAIM CENTER policy page?', { required: true, radios: ['Yes', 'No'] })]);
  add('GCCM-1003/UIF/TC-051', 'AUTO_PA', [...QUICK(), ...TL('No')], [H('Does this vehicle display on the CLAIM CENTER policy page?')]);
  add('GCCM-799/UIF/TC-034', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'existing'), ...TL('No')], [H('Does this vehicle display on the CLAIM CENTER policy page?')]);
  add('GCCM-1003/UIF/TC-067', 'AUTO_PA', [QOPEN_LIEN, { payee: 'vendor' }, { step2: {} }, { next: true }, { expectStep: 2 }],
    [V('Invoice Number/Remarks', { required: true, editable: true })], VENDOR_NOTE + ' Mirrors GCCM-799 TC-050.');

  // ════ 1. Vendor payee / ClaimsPay defaults ═════════════════════════════════════════════════════════════════════
  // VBR.001 — "Payees other than vendor should have the payment contact details…" warning, checked on every step.
  const WARN = (present) => ({ text: { re: NO_CONTACT_DETAILS, present } }); // the warning is page text, not a .gw-message block (CONFIRMED 2026-10-21)
  const SHOW = X('showMessages');
  const VBR001_FULL = (who) => [{ open: 'full' }, { payee: who }, SHOW, WARN(who !== 'vendor' && who !== 'David Thomas'), { next: true }, { reserve: 'open' }, { step2: {} }, { next: true }, { expectStep: 3 }, SHOW];
  const VBR001_QUICK = (who) => [QOPEN_LIEN, { payee: who }, SHOW, WARN(who !== 'vendor' && who !== 'David Thomas'), { step2: {} }, { next: true }, { expectStep: 2 }, SHOW];
  const DETAILS = 'Payee = David Thomas on the HO pool claim — the only TEST payee the claim check found WITH payment contact details (no warning).';
  add('GCCM-763/VBR/TC-001', 'AUTO_PA', VBR001_FULL('claimant'), [WARN(true)], 'Claimant payee without payment contact details; checked on Step 1 and Step 3.');
  add('GCCM-763/VBR/TC-002', 'PROP_PA', VBR001_FULL('David Thomas'), [WARN(false)], DETAILS);
  add('GCCM-763/VBR/TC-003', 'AUTO_PA', VBR001_FULL('vendor'), [WARN(false)], VENDOR_NOTE);
  add('GCCM-1003/VBR/TC-083', 'AUTO_PA', VBR001_QUICK('claimant'), [WARN(true)], 'Claimant payee without payment contact details; checked on both Quick Payment steps.');
  add('GCCM-1003/VBR/TC-084', 'PROP_PA', VBR001_QUICK('David Thomas'), [WARN(false)], DETAILS);
  add('GCCM-1003/VBR/TC-085', 'AUTO_PA', VBR001_QUICK('vendor'), [WARN(false)], VENDOR_NOTE);

  // ClaimsPay defaults — Full Check (Step 3) with a vendor in the payees
  const CT = (re) => V('ClaimsPay Type', { value: re });
  const CM = (re) => V('ClaimsPay Method', { value: re });
  const C_AND_V = /contact\(s\)\s*(and|&)\s*vendor/i;
  const CONTACTS = /^contact\(s\)$/i;
  const CHOICE = /customer choice|let customer pick/i;
  const NOT_MAILED = /^(?!.*other\s*\/\s*mailed).+/i;
  const VJ_NOTE = VENDOR_NOTE + ' The vendor is the primary payee (Address Book search) and the contact(s) are added with "Add Joint Payees".';
  // AUTO_PA vehicle line: JOINT_FULL also answers "Payment for a total loss?" = No.
  const VJ = (joint) => JOINT_FULL(VENDOR, joint, 'No');
  // HO claim (PROP_MORT) where a real Secondary Named Insured exists: MORT_FULL(primary, joint).
  // QA review 2026-10-26: the PA auto insured/claimant (DMG LMB TEST) has no e-mail, so CPD.001 forces Other/Mailed Check; these run on
  // the HO claim whose insured/claimant Robert Charles has an e-mail and phone.
  const HO_NOTE = ' Run on the HO claim (PROP_PA): Robert Charles has an e-mail and phone, so CPD.001 does not override the defaults.';
  const SET_DT = { call: ['contactManager.setContactEmail', 'David Thomas', 'Thomas', '19073', 'davidthomas@example.com|7175550142'] };
  const REST = { call: ['contactManager.restoreVendors'] };
  const HOJ = (primary, joint, setDT) => [...(setDT ? [SET_DT] : []), { open: 'full' }, ...PRIMARY(primary), { joint }, { next: true }, { reserve: 'open' }, { step2: {} }, { next: true }, { expectStep: 3 }];
  const DT = { who: 'David Thomas', type: 'Additional Claimant' };
  add('GCCM-759/CPD/TC-018', 'PROP_PA', HOJ(VENDOR, [INS]), [CT(C_AND_V)], VJ_NOTE + HO_NOTE);
  add('GCCM-759/CPD/TC-020', 'PROP_PA', HOJ(VENDOR, [CLM]), [CT(C_AND_V)], VJ_NOTE + HO_NOTE);
  add('GCCM-799/UIF/TC-060', 'AUTO_PA', VJ([INS]), [CT(C_AND_V), V('Approval Required', { required: true, editable: true })], VJ_NOTE);
  const SNI_NOTE = MORT_NOTE + ' Secondary insured = the contact CC types "Secondary Named Insured" (from the policy).';
  add('GCCM-759/CPD/TC-009', 'PROP_MORT', MORT_FULL(INS, [SNI_REAL]), [CT(CONTACTS), CM(CHOICE)], SNI_NOTE + ' ' + 'CPD.001 (no email → Other/Mailed Check) may take precedence; reported as observed.');
  add('GCCM-759/CPD/TC-023', 'PROP_MORT', MORT_FULL(INS, [SNI_REAL]), [CT(CONTACTS)], SNI_NOTE);
  add('GCCM-759/CPD/TC-010', 'PROP_MORT', MORT_FULL(VENDOR, [INS, SNI_REAL]), [CT(C_AND_V)], SNI_NOTE + ' ' + VJ_NOTE);
  add('GCCM-759/CPD/TC-022', 'PROP_MORT', MORT_FULL(VENDOR, [INS, SNI_REAL]), [CT(C_AND_V), V('Approval Required')],
    SNI_NOTE + ' ' + VJ_NOTE + ' PCON/SCON_Approval_Reqd are payload flags (not on screen); the visible "Approval Required" field is checked instead.');
  add('GCCM-799/CPD-Joint/TC-80', 'PROP_MORT', MORT_FULL(VENDOR, [INS, SNI_REAL]), [CT(C_AND_V), { text: { re: /3 or more payees/i, present: false } }],
    SNI_NOTE + ' ' + VJ_NOTE + ' Test text says "less than 3 payees (i.e.) 2 insured contacts and a vendor" — the exempt 3-payee combination; checked as written (Contact(s) and Vendor, not "3 or more payees").');
  // Primary claimant + a second person contact (typed Additional Claimant) [+ vendor] — AUTO_PA vehicle line.
  const PJ = (primary, joint) => [{ open: 'full' }, ...PRIMARY(primary), X('addJoint', joint), { next: true }, { reserve: 'open' },
    { answer: ['Payment for a total loss?', 'No'] }, { step2: {} }, { next: true }, { expectStep: 3 }];
  const PJ_NOTE = 'Secondary claimant = a second PERSON contact on the claim (not the insured / exposure claimant), typed "Additional Claimant" in the joint payee grid.';
  const DT_NOTE = ' Secondary claimant = David Thomas (typed Additional Claimant); his Main Email/phone are set in ContactManager for the case and restored afterwards.' + HO_NOTE;
  add('GCCM-759/CPD/TC-011', 'PROP_PA', HOJ(CLM, [DT], true), [CT(CONTACTS), CM(CHOICE), REST], PJ_NOTE + DT_NOTE);
  add('GCCM-759/CPD/TC-025', 'PROP_PA', HOJ(CLM, [DT], true), [CT(CONTACTS), REST], PJ_NOTE + DT_NOTE);
  add('GCCM-759/CPD/TC-012', 'PROP_PA', HOJ(VENDOR, [CLM, DT], true), [CT(C_AND_V), REST], PJ_NOTE + DT_NOTE + ' ' + VJ_NOTE);
  add('GCCM-759/CPD/TC-024', 'PROP_PA', HOJ(VENDOR, [CLM, DT], true), [CT(C_AND_V), V('Approval Required'), REST], PJ_NOTE + DT_NOTE + ' ' + VJ_NOTE);
  // CPD.001 negative (QA review 2026-10-26): BOTH the primary and the secondary payee must have an e-mail. Primary = the insured
  // Robert Charles (has one); secondary = David Thomas, whose Address Book record has none — his Main Email is set in ContactManager
  // for the case and put back afterwards (contactManager.js ledger).
  add('GCCM-759/CPD/TC-002', 'PROP_PA', [{ call: ['contactManager.setContactEmail', 'David Thomas', 'Thomas', '19073', 'davidthomas@example.com|7175550142'] },
    ...FULL_PAYEES('insured'), { joint: [{ who: 'David Thomas' }] }, { next: true }, { reserve: 'open' }, { step2: {} }, { next: true }, { expectStep: 3 }],
    [CT(NOT_MAILED), { call: ['contactManager.restoreVendors'] }], 'Primary Robert Charles (insured, has e-mail) + joint payee David Thomas (Secondary Named Insured, e-mail set in ContactManager for this case and restored after).');
  // CPD.014 — vendor Mailed Check → Certified delivery
  add('GCCM-759/CPD/TC-028', 'AUTO_PA', [...FULL_INSTRUCTIONS('vendor'), { select: ['ClaimsPay Method', /mailed check/i] }],
    [V('Payment Delivery', { value: /certified/i, includes: ['Certified', 'Expedite'], excludes: ['Standard'] })], VENDOR_NOTE);
  add('GCCM-759/CPD/TC-029', 'AUTO_PA', FULL_INSTRUCTIONS('vendor'), [CM(/vendor preferred/i), V('Payment Delivery', { value: /^(?!certified$)/i })], VENDOR_NOTE);
  // CPD.015 — Insurance Auto Auctions (Tax ID 95-3790111, an in-network IAA ID)
  const IAA = (tl, quick) => [quick ? QOPEN_LIEN : { open: 'full' }, X('selectVendorByTaxId', 'INSURANCE AUTO AUCTIONS', '95-3790111'),
    ...(quick ? [] : [{ next: true }, { reserve: 'open' }]), { answer: ['Payment for a total loss?', tl] }, { step2: {} }, { next: true }, { expectStep: quick ? 2 : 3 }];
  const IAA_NOTE = 'Payee = Insurance Auto Auctions Inc. from the TEST Address Book by Tax ID 95-3790111.';
  add('GCCM-759/CPD/TC-030', 'AUTO_PA', IAA('Yes'), [CT(/^vendor$/i), CM(/vendor preferred/i)], IAA_NOTE);
  add('GCCM-759/CPD/TC-031', 'AUTO_PA', IAA('No'), [CT(/^vendor$/i), CM(/vendor preferred/i)], IAA_NOTE + ' Standard vendor default (CPD.013) expected.');
  // 1099 Box on a medical cause of loss (DE PIP line), vendor, claim cost → Box 6
  add('GCCM-799/UIF/TC-009', 'AUTO_DE_AGED', [{ open: 'full' }, { payee: 'vendor' }, { next: true }, { reserve: 'open' }],
    [V('Cause of Loss', { value: /personal injury protection|medical/i }), V('1099 Box Number', { required: true, editable: true, value: /^06/ })],
    VENDOR_NOTE + ' Claim cost on the DE claim\'s PIP (Personal Injury Protection) exposure — a medical-related cause of loss.');

  // ClaimsPay defaults — Quick Payment. Quick Payment shows no ClaimsPay Type/Method fields and has no "Add Joint
  // Payees" (CONFIRMED 2026-10-21): single-payee cases check the fields (a FAIL = the known finding); joint cases check
  // for the button first, as the core GCCM-1003 joint recipes do.
  const QSINGLE = (who) => [QOPEN_LIEN, { payee: who }, { step2: {} }, { next: true }, { expectStep: 2 }];
  const QJOINT = (primary) => [QOPEN_LIEN, ...PRIMARY(primary)];
  const JB = [{ button: { name: 'Add Joint Payees', present: true } }];
  const QJ_NOTE = 'Quick Payment Step 1 has no "Add Joint Payees" (CONFIRMED 2026-10-21) — checked first; while it is missing the case FAILs (possible pending development).';
  add('GCCM-1003/CPD/TC-208', 'AUTO_PA', [QOPEN_LIEN, { payee: 'claimant' }, { snapshotWarning: NO_CONTACT_DETAILS }, { step2: {} }, { next: true }, { expectStep: 2 }],
    [{ require: { warning: NO_CONTACT_DETAILS, present: true, reason: 'the selected payee HAS payment contact details, so the no-email precondition is not met' } },
      CT(/other\s*\/\s*mailed check/i), CM(/^(mailed )?check$/i)]);
  add('GCCM-1003/CPD/TC-209', 'PROP_PA', QSINGLE('David Thomas'), [CT(NOT_MAILED)], DETAILS);
  add('GCCM-1003/CPD/TC-225', 'AUTO_PA', QSINGLE('insured'), [CT(CONTACTS)]);
  add('GCCM-1003/CPD/TC-227', 'AUTO_PA', QSINGLE('claimant'), [CT(CONTACTS)]);
  add('GCCM-1003/CPD/TC-233', 'AUTO_PA', QSINGLE('claimant'), [CT(CONTACTS)]);
  add('GCCM-1003/CPD/TC-232', 'AUTO_PA', QSINGLE('vendor'), [CT(/^vendor$/i), CM(/vendor preferred/i)], VENDOR_NOTE);
  add('GCCM-1003/CPD/TC-234', 'AUTO_PA', QSINGLE('vendor'), [V('ClaimsPay Method', { editable: true, includes: ['Mailed Check'] }), V('Payment Delivery')],
    VENDOR_NOTE + ' The manual change to Mailed Check needs the ClaimsPay Method field — checked first.');
  add('GCCM-1003/CPD/TC-235', 'AUTO_PA', QSINGLE('vendor'), [CM(/vendor preferred/i), V('Payment Delivery', { value: /^(?!certified$)/i })], VENDOR_NOTE);
  add('GCCM-1003/CPD/TC-236', 'AUTO_PA', IAA('Yes', true), [CT(/^vendor$/i), CM(/vendor preferred/i)], IAA_NOTE);
  add('GCCM-1003/CPD/TC-237', 'AUTO_PA', IAA('No', true), [CT(/^vendor$/i), CM(/vendor preferred/i)], IAA_NOTE);
  for (const [id, primary] of [['GCCM-1003/CPD/TC-216', INS], ['GCCM-1003/CPD/TC-217', INS], ['GCCM-1003/CPD/TC-218', CLM], ['GCCM-1003/CPD/TC-219', CLM],
    ['GCCM-1003/CPD/TC-224#2', INS], ['GCCM-1003/CPD/TC-226', CLM], ['GCCM-1003/CPD/TC-228', INS], ['GCCM-1003/CPD/TC-229', INS], ['GCCM-1003/CPD/TC-230', CLM],
    ['GCCM-1003/CPD/TC-231', CLM], ['GCCM-1003/CPD-Joint/TC-251', INS], ['GCCM-1003/CPD-Joint/TC-250', INS]]) add(id, 'AUTO_PA', QJOINT(primary), JB, QJ_NOTE);
  add('GCCM-1003/CPD-Lienholder/TC-246', 'AUTO_LIEN', QJOINT(CLM), JB, QJ_NOTE);

  // ════ 4. Lienholder / mortgagee / joint leftovers, HO building damage ══════════════════════════════════════════
  const JSTEP1 = (primary, joint) => [{ open: 'full' }, ...PRIMARY(primary), { joint }];
  add('GCCM-759/UIF/TC-004', 'AUTO_LIEN', JSTEP1(INS, [LIEN]), [{ header: { name: 'Type', present: true } }], JOINT_NOTE + ' The joint-payee grid Type column is checked (its per-row dropdown is not addressable by label).');
  add('GCCM-759/UIF/TC-008', 'AUTO_LIEN', JSTEP1(INS, [LIEN]), [{ header: { name: 'Type', present: true } }, { header: { name: 'ClaimsPay Payee Type', present: false } }], JOINT_NOTE);
  // Updated 759 sheet (QA review 2026-10-26): with nothing selected in the Name, Type displays <none>.
  add('GCCM-759/UIF/TC-005', 'AUTO_PA', [{ open: 'full' }], [V('Type', { value: /^<none>$/i })], 'Checked with no payee selected: Type is shown with <none> (updated sheet).');
  add('GCCM-799/CPD-Lienholder/TC-075', 'AUTO_LIEN', [{ open: 'full' }, ...PRIMARY(CLM), X('addJoint', [PERSON2, LIEN]), { next: true }, { reserve: 'open' },
    { answer: ['Payment for a total loss?', 'No'] }, { step2: {} }, { next: true }, { expectStep: 3 }], MAILED, JOINT_NOTE + ' ' + PJ_NOTE);
  add('GCCM-799/UIF/TC-064', 'PROP_MORT', MORT_FULL(INS, [MORT]), [V('Request Type', { required: true, editable: true, includes: ['Loss Payment', 'Recoverable Depreciation', 'Supplemental Payment'] })], MORT_NOTE);
  const ROOF = 'Does this transaction include payment for repairs or replacement to at least half of the roof?';
  const ROOF_WHY = 'shows only for a claim cost to the Insured on a Building Damage exposure with a qualifying cause of loss — the HO test claim\'s cause of loss may not qualify';
  add('GCCM-799/UIF/TC-056', 'PROP_PA', FULL_INSTRUCTIONS('insured'), [V(ROOF, { required: true, editable: true, unlessBlocked: ROOF_WHY })], 'HO claim, claim cost to the Insured on the 1st Party Building exposure.');
  add('GCCM-1003/UIF/TC-073', 'PROP_PA', QSINGLE('insured'), [V(ROOF, { required: true, editable: true, unlessBlocked: ROOF_WHY })], 'HO claim, claim cost to the Insured on the 1st Party Building exposure.');
  // VBR.007 — loss payee / additional insured warning on property claim cost payments
  const VBR007 = /Loss payee\/additional insured must appear on check/i;
  add('GCCM-763/VBR/TC-020', 'PROP_PA', [...FULL_PAYMENTS('insured', 'open'), { step2: { transactionType: 'Partial Payment', amount: '1.97' } }, FINISH], [OUT(VBR007)],
    'Property claim cost payment; stops at the warning (no payment) — ' + SUB('1.97'));
  add('GCCM-763/VBR/TC-021', 'AUTO_PA', [...CC('Partial Payment', '1.99'), FINISH], [SUBMITTED], 'Auto claim cost payment. ' + SUB('1.99'));
  add('GCCM-763/VBR/TC-022', 'PROP_PA', [...NEW_LINE('Adjuster Expense', 'vendor'), { step2: { transactionType: 'First and Final', amount: '2.03' } }, FINISH], [SUBMITTED],
    'Property expense payment to an Address Book vendor on a new expense line. ' + SUB('2.03'));
  add('GCCM-1003/VBR/TC-103', 'PROP_PA', [QOPEN('open'), { payee: 'insured' }, { step2: { transactionType: 'Partial Payment', amount: '2.07' } }, FINISH], [OUT(VBR007)],
    'Property claim cost Quick Payment; stops at the warning — ' + SUB('2.07'));
  add('GCCM-1003/VBR/TC-104', 'AUTO_PA', [...QCC('Partial Payment', '2.09'), FINISH], [SUBMITTED], 'Auto claim cost Quick Payment. ' + SUB('2.09'));
  add('GCCM-1003/VBR/TC-105', 'PROP_PA', [X('openQuickOnRow', 'expense', 'any'), { payee: 'vendor' }, { step2: { amount: '2.11' } }, FINISH], [SUBMITTED],
    'Property expense Quick Payment from the HO claim\'s expense reserve row (created by GCCM-763 TC-022). ' + SUB('2.11'));

  // ════ 3. DE / MD aged date-of-loss rules ═══════════════════════════════════════════════════════════════════════
  // Service Period Start = DoL; End = DoL + n days. Memo Phrase (required on these medical lines) is filled by
  // finishObserve with the first option.
  const SP = (end) => [{ fill: ['Service Period Start', 'DOL'] }, { fill: ['Service Period End', end] }];
  const AGED_FULL = (end, amount, reserve = 'open') => [...FULL_PAYMENTS('claimant', reserve), ...SP(end), { step2: { transactionType: 'Partial Payment', amount } }];
  const AGED_QUICK = (end, amount) => [QOPEN('open'), ...SP(end), { step2: { transactionType: 'Partial Payment', amount } }];
  // MD: pay from the PIP "(3) 1st Party Medical Expense" line BY NAME. Once the Bodily Injury line got its $500 reserve,
  // "first line with open reserve" picked BI (Coverage "Liability - Auto bodily injury") and the VBR.005/015 cases
  // tested the wrong exposure (CONFIRMED 2026-10-21 rerun).
  const MD_FULL = (end, amount) => [...FULL_PAYMENTS('claimant', 'match:Medical'), ...SP(end), { step2: { transactionType: 'Partial Payment', amount } }];
  const MD_QUICK = (end, amount) => [X('openQuickOnRow', 'claim cost', 'open', 'Medical'), ...SP(end), { step2: { transactionType: 'Partial Payment', amount } }];
  const LC50 = X('requireField', 'Cause of Loss', 'medical benefits',
    'VBR.004 applies to exposures with Cause of Loss LC50 "Medical Benefits"; the DE test claim\'s PIP exposure offers only "Personal Injury Protection" and no DE/PA claim with a Medical Benefits exposure is available');
  const NOT_LC50 = V('Cause of Loss', { value: /^(?!.*medical benefits).+/i });
  const VBR004 = /proper documentation/i;
  const VBR005 = /more than 3 years after the DOL/i;
  const VBR015 = /application for benefits must be received within 1 year/i;
  const DE_NOTE = 'DE claim PA-DE-01-24-0744728 (DoL 09/15/2024), PIP "Medical Expense" exposure, Cause of Loss = Personal Injury Protection.';
  const MD_NOTE = 'MD claim PA-MD-01-23-0742279 (DoL 09/11/2023), "(3) 1st Party Medical Expense" PIP exposure.';
  // VBR.004 (DE, LC50, Service Period End >= DoL + 2 years)
  add('GCCM-763/VBR/TC-008', 'AUTO_DE_AGED', [...AGED_FULL('DOL+731', '2.13'), LC50, FINISH], [OUT(VBR004)], DE_NOTE);
  add('GCCM-763/VBR/TC-009', 'AUTO_DE_AGED', [...AGED_FULL('DOL+365', '2.17'), LC50, FINISH], [SUBMITTED], DE_NOTE);
  add('GCCM-763/VBR/TC-010', 'AUTO_PA', [...FULL_PAYMENTS('claimant', 'open'), LC50], [SUBMITTED], 'Needs a PA (non-DE) exposure with Cause of Loss Medical Benefits (LC50).');
  add('GCCM-763/VBR/TC-011', 'AUTO_DE_AGED', [...AGED_FULL('DOL+731', '2.19'), NOT_LC50, FINISH], [SUBMITTED], DE_NOTE + ' COL != LC50, End = DoL + 2 years + 1 day. ' + SUB('2.19'));
  add('GCCM-1003/VBR/TC-090', 'AUTO_DE_AGED', [...AGED_QUICK('DOL+731', '2.23'), LC50, FINISH], [OUT(VBR004)], DE_NOTE);
  add('GCCM-1003/VBR/TC-091', 'AUTO_DE_AGED', [...AGED_QUICK('DOL+365', '2.27'), LC50, FINISH], [SUBMITTED], DE_NOTE);
  add('GCCM-1003/VBR/TC-092', 'AUTO_PA', [QOPEN('open'), LC50], [SUBMITTED], 'Needs a PA (non-DE) exposure with Cause of Loss Medical Benefits (LC50).');
  add('GCCM-1003/VBR/TC-093', 'AUTO_DE_AGED', [...AGED_QUICK('DOL+731', '2.29'), NOT_LC50, FINISH], [SUBMITTED], DE_NOTE + ' COL != LC50. ' + SUB('2.29'));
  // VBR.005 (MD, PIP / Med Pay, Service Period End >= DoL + 3 years). MD payments may also raise VBR.015 — a
  // negative case is only about the VBR.005 text, so its outcome must not contain it (and must not be blocked by it).
  const PIP = V('Coverage', { value: /PIP|personal injury|medical/i });
  const NOT_PIP = X('requireField', 'Coverage', '^(?!.*(PIP|personal injury|medical)).+',
    'needs a reserve on the MD claim\'s non-PIP exposure (Bodily Injury / Liability) — only the PIP Medical Expense exposure has a reserve');
  // Non-PIP negatives pay from the "(1) 3rd Party Bodily Injury Liability" Claim Cost line ($500 reserve added 2026-10-21).
  const BI_LINE = 'match:Bodily Injury';
  const BI_QUICK = X('openQuickOnRow', 'claim cost', 'open', 'Bodily Injury');
  const BI_NOTE = ' Non-PIP: pays from the Bodily Injury exposure line.';
  add('GCCM-763/VBR/TC-012', 'AUTO_MD_AGED', [...MD_FULL('DOL+1096', '2.31'), PIP, FINISH], [OUT(VBR005)], MD_NOTE);
  add('GCCM-763/VBR/TC-013', 'AUTO_MD_AGED', [...MD_FULL('DOL+730', '2.33'), PIP, FINISH], [OUT(/^(?![\s\S]*3 years after the DOL)/i)], MD_NOTE + ' Passes when the VBR.005 text is absent (VBR.015\'s own MD warning may still show).');
  add('GCCM-763/VBR/TC-014', 'AUTO_DE_AGED', [...AGED_FULL('DOL+1096', '2.37'), PIP, FINISH], [SUBMITTED], DE_NOTE + ' PIP coverage on a non-MD (DE) policy, End = DoL + 3 years. ' + SUB('2.37'));
  add('GCCM-763/VBR/TC-015', 'AUTO_MD_AGED', [...FULL_PAYMENTS('claimant', BI_LINE), NOT_PIP, ...SP('DOL+1096'), { step2: { transactionType: 'Partial Payment', amount: '2.61' } }, FINISH], [SUBMITTED], MD_NOTE + BI_NOTE);
  add('GCCM-1003/VBR/TC-094', 'AUTO_MD_AGED', [...MD_QUICK('DOL+1096', '2.39'), PIP, FINISH], [OUT(VBR005)], MD_NOTE);
  add('GCCM-1003/VBR/TC-095', 'AUTO_MD_AGED', [...MD_QUICK('DOL+730', '2.41'), PIP, FINISH], [OUT(/^(?![\s\S]*3 years after the DOL)/i)], MD_NOTE);
  add('GCCM-1003/VBR/TC-096', 'AUTO_DE_AGED', [...AGED_QUICK('DOL+1096', '2.43'), PIP, FINISH], [SUBMITTED], DE_NOTE + ' PIP on a non-MD policy. ' + SUB('2.43'));
  add('GCCM-1003/VBR/TC-097', 'AUTO_MD_AGED', [BI_QUICK, NOT_PIP, ...SP('DOL+1096'), { step2: { transactionType: 'Partial Payment', amount: '2.67' } }, FINISH], [SUBMITTED], MD_NOTE + BI_NOTE);
  // VBR.015 (MD Medical Benefits exposure — warning on any payment)
  add('GCCM-763/VBR/TC-042', 'AUTO_MD_AGED', [...MD_FULL('DOL+30', '2.47'), FINISH], [OUT(VBR015)], MD_NOTE);
  add('GCCM-763/VBR/TC-043', 'AUTO_DE_AGED', [...AGED_FULL('DOL+30', '2.51'), FINISH], [SUBMITTED], DE_NOTE + ' Same Medical Expense (PIP) exposure type on a non-MD policy. ' + SUB('2.51'));
  add('GCCM-763/VBR/TC-044', 'AUTO_MD_AGED', [...FULL_PAYMENTS('claimant', BI_LINE), NOT_PIP, { step2: { transactionType: 'Partial Payment', amount: '2.63' } }, FINISH], [SUBMITTED], MD_NOTE + BI_NOTE);
  add('GCCM-1003/VBR/TC-125', 'AUTO_MD_AGED', [...MD_QUICK('DOL+30', '2.53'), FINISH], [OUT(VBR015)], MD_NOTE);
  add('GCCM-1003/VBR/TC-126', 'AUTO_DE_AGED', [...AGED_QUICK('DOL+30', '2.57'), FINISH], [SUBMITTED], DE_NOTE + ' Non-MD policy. ' + SUB('2.57'));
  add('GCCM-1003/VBR/TC-127', 'AUTO_MD_AGED', [BI_QUICK, NOT_PIP, { step2: { transactionType: 'Partial Payment', amount: '2.69' } }, FINISH], [SUBMITTED], MD_NOTE + BI_NOTE);
};
