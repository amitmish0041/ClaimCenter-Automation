/**
 * helpers/oneInc/recipes/setupE.js — OneInc recipes that need claim/contact setup done by helpers/oneInc/setupE.js
 * (VBR.036 mailing address on an unsent check). Claims: profile E_PA in helpers/oneInc/profiles/setupE.js
 * (automation-owned, TEST). Added 2026-10-21.
 */
'use strict';

module.exports = (api) => {
  const { add } = api;
  const call = (fn, ...args) => ({ call: [`setupE.${fn}`, ...args] });

  // ── VBR.036 — negative: payee NOT linked to the Address Book ───────────────────────────────────────────────────
  // E_PA claim PA-PA-01-26-0748489: PHILIP ADAMS (Covered Party) is a claim-only contact ("This contact is not linked
  // to the Address Book", CONFIRMED 2026-10-21). Address A is set first, a $1.37 payment is finished (check stays
  // "Awaiting submission" = not yet sent), then the contact's primary address is changed to B and the check reopened.
  // The design's "future-dated" check cannot be made: VBR.017 refuses a non-recurring check with a future pay date, so
  // an unsent ("Awaiting submission") check dated today is used.
  const PAYEE = 'PHILIP ADAMS';
  const A_RE = /1103 RICHMONT ST/i;
  const B_RE = /1195 RIVER RD/i;
  // Quick Payment defaults the payee Type to Other, which VBR.031 refuses for a non-Address-Book contact ("…payee type of
  // Vendor or Other. A tax id is required…", CONFIRMED 2026-10-21) — pick a person payee type instead.
  const TYPE_Q = /Additional Claimant|Claimant/;
  const PAY_FULL = [{ open: 'full' }, { payee: PAYEE }, { next: true }, { reserve: 'open' }, { step2: { transactionType: 'Partial Payment', amount: '1.37' } }, { validate: { expect: null } }];
  const PAY_QUICK = [{ open: 'quick', needOpenReserve: true }, { payee: PAYEE }, { select: ['Type', TYPE_Q] }, { step2: { transactionType: 'Partial Payment', amount: '1.37' } }, { validate: { expect: null } }];
  const AFTER = [
    call('openLatestCheck', PAYEE),
    { text: { re: A_RE, present: true } }, { text: { re: /Awaiting submission/i, present: true } },
    call('changeContactAddress', PAYEE, 'B'),
    call('openLatestCheck', PAYEE),
    { text: { re: A_RE, present: true } }, { text: { re: B_RE, present: false } },
  ];
  const NOTE = 'Payee PHILIP ADAMS (claim contact, not linked to the Address Book). Address 1103 Richmont St set, $1.37 payment finished (check "Awaiting submission"), contact address changed to 1195 River Rd, check reopened: its Mailing Address must still show 1103 Richmont St. Needs ONEINC_ALLOW_FINISH=1. No future-dated check possible (VBR.017), so an unsent check dated today is used.';
  add('GCCM-803/TC/TC-046', 'E_PA', [call('changeContactAddress', PAYEE, 'A'), call('noteChecks', PAYEE), ...PAY_FULL], AFTER, NOTE);
  add('GCCM-1003/VBR/TC-191', 'E_PA', [call('changeContactAddress', PAYEE, 'A'), call('noteChecks', PAYEE), ...PAY_QUICK], AFTER, NOTE + ' Quick Payment.');

  // ── CPD.031 — Government / State Agency payee ──────────────────────────────────────────────────────────────────
  // COMMONWEALTH OF PENNSYLVANIA (Address Book, Tax ID 25-1671669) added to the claim with the role "State Agency
  // Payment"; CC then defaults its payee Type to "State Agency Payment" (CONFIRMED 2026-10-21). Read on Step 3 / Quick
  // step 2. API-side values (PM_PaymentType, BUS_*, PMETHOD…) are integration payload — not visible in CC.
  const { V, H } = api;
  const AGENCY = 'COMMONWEALTH OF PENNSYLVANIA';
  const MAILED_ONLY = [V('ClaimsPay Type', { value: /other\s*\/\s*mailed check/i }), V('ClaimsPay Method', { value: /^mailed check$/i }), H('Reason for Check')];
  const NOTE31 = 'Payee = COMMONWEALTH OF PENNSYLVANIA (Address Book vendor, Tax ID 25-1671669) with the claim role "State Agency Payment" (added by setupE.addRoleContact). The API payload values in the Expected Result are integration-side and not checked here.';
  add('GCCM-799/CPD-Joint/TC-85', 'E_PA', [call('addRoleContact', 'stateAgency'), { open: 'full' }, { payee: AGENCY }, { next: true }, { reserve: 'open' }, { step2: {} }, { next: true }, { expectStep: 3 }],
    MAILED_ONLY, NOTE31);
  add('GCCM-1003/CPD-Joint/TC-256', 'E_PA', [call('addRoleContact', 'stateAgency'), { open: 'quick', needOpenReserve: true }, { payee: AGENCY }, { step2: {} }, { next: true }, { expectStep: 2 }],
    MAILED_ONLY, NOTE31 + ' Quick Payment.');

  // ── CPD.030 — Adverse carrier + attorney joint payees ──────────────────────────────────────────────────────────
  // STATE FARM INSURANCE COMPANIES INC (role "Adverse Carrier/Other Insurance Company" → payee Type defaults to it) as
  // the primary payee and BAIKOW LEGAL LLC (role "Plaintiff's Attorney"; payee Type "Vendor" — Cloud offers no "Law
  // Firm"/"Attorney" payee type) as joint payee. A claim-cost partial payment (no separate "subrogation payment"
  // transaction type exists in the wizard).
  const CARRIER = 'STATE FARM INSURANCE COMPANIES INC';
  const ATTY = 'BAIKOW LEGAL LLC';
  const NOTE30 = `Primary payee ${CARRIER} (role Adverse Carrier/Other Insurance Company), joint payee ${ATTY} (role Plaintiff's Attorney), both Address Book vendors added by setupE.addRoleContact. PMA_MailTo / PM_Additional_Text_3 are integration payload — not checked.`;
  const ROLES = [call('addRoleContact', 'adverseCarrier'), call('addRoleContact', 'attorney')];
  add('GCCM-799/CPD-Joint/TC-83', 'E_PA', [...ROLES, { open: 'full' }, { payee: CARRIER }, { joint: [{ who: ATTY }] }, { next: true }, { reserve: 'open' }, { step2: {} }, { next: true }, { expectStep: 3 }],
    [V('ClaimsPay Type', { value: /^contact\(s\)$/i }), V('ClaimsPay Method', { value: /check/i }), { text: { re: /Subro payment including an Attorney/i, present: true } }], NOTE30);
  // Quick Payment Step 1 has no "Add Joint Payees" (CONFIRMED 2026-10-21, same as the other Quick joint cases): checked
  // first; while it is missing the case FAILs (possible pending development).
  add('GCCM-1003/CPD-Joint/TC-254', 'E_PA', [...ROLES, { open: 'quick', needOpenReserve: true }, { payee: CARRIER }],
    [{ button: { name: 'Add Joint Payees', present: true } }], NOTE30 + ' Quick Payment.');
};
