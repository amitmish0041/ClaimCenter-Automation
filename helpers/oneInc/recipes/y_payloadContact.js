/**
 * helpers/oneInc/recipes/y_payloadContact.js — GCCM-1013 INT.024 (TC-121) and INT.033 (TC-129): the payee's e-mail / mobile
 * in the OneInc payload, judged on the OneInc staging portal (payment › "Insured's Email" / "Primary Contact Phone" = PCON
 * e-mail / phone) instead of the payload itself (user direction 2026-11-14). Needs the portal window signed in
 * (scripts/oneIncPortalSession.js). Each case adds its own claim-only person (role Other) to the shared INT_CLEAN claim,
 * pays them (Additional Claimant, $1.7x), sends the payment (Financials Escalation batch) and reads it on the portal.
 * E-mails stay on the QA mailbox (amitmishra@donegalgroup.com, plus-addressed where a second address is needed); mobiles
 * are dummy 555 numbers.
 */
'use strict';

module.exports = (api) => {
  const { add, V, VAL } = api;
  const pc = (fn, ...a) => ({ call: [`portalChecks.${fn}`, ...a] });
  const op = (fn, ...a) => ({ call: [`checkOps.${fn}`, ...a] });
  const ct = (fn, ...a) => ({ call: [`paymentContact.${fn}`, ...a] });
  const QA = 'amitmishra@donegalgroup.com';
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A single claim-only payee typed "Other" is refused (portalChecks.payeeRowType), so Step 1 Type = Additional Claimant.
  // Sent right after it is made: the payload is built when the check goes to OneInc, so each payment is escalated before
  // the next change.
  const PAY = (who, amount) => [...VAL([{ open: 'full' }, { payee: who }, { select: ['Type', 'Additional Claimant'] }, { next: true }, { reserve: 'open' },
    { step2: { transactionType: 'Partial Payment', amount } }], null), op('escalateChecks', amount)];
  const READ = (amount, as) => pc('oneIncPayment', { fields: ["Insured's Email", 'Primary Contact Phone'], amount, waitMin: 20, as });

  // ── INT.024 — invalid characters removed from the e-mail address ──
  const { PEOPLE } = require('../paymentContact');
  const P121 = PEOPLE.emailClean;
  const N121 = 'PAT EMAILCLEAN';
  const DIRTY_EMAIL = 'amit#mi!shra@donegalgroup.com';
  add('GCCM-1013/INT/TC-121', 'INT_CLEAN', [ct('addPerson', P121),
    ct('setMainEmail', P121, 'Abc$email.com', 'Parties Involved e-mail (Abc$email.com)'),
    ct('setPaymentContact', P121, { email: DIRTY_EMAIL, mobile: '717-555-0142' }, 'Payment Contact Details e-mail with invalid characters'),
    ...PAY(N121, '1.72'), READ('1.72', '')],
  [V('Parties Involved e-mail (Abc$email.com)', { value: /refused:.*(valid email|xxxxxx@xxxx\.xxx)/i }),
    V('Payment Contact Details e-mail with invalid characters', { value: /^saved/i }),
    V("OneInc Insured's Email", { value: new RegExp(`^${esc(QA)}$`, 'i') })],
  `New PA auto claim (shared by the cleansing cases). Claim-only person ${N121}: (1) Parties Involved › Edit › Main e-mail "Abc$email.com" must be refused (Email: must be a valid email address); `
    + `(2) Payment Contact Details e-mail "${DIRTY_EMAIL}" (# and ! are outside [A-Z0-9._'%+-]); a $1.72 payment to them is sent to OneInc and read on the OneInc staging portal: Insured's Email (PCON e-mail) must arrive as "${QA}".`);

  // ── INT.033 — e-mail / phone sent to OneInc change only from Payment Contact Details, and only on new payments ──
  const P129 = PEOPLE.contactUpd;
  const N129 = 'PAT CONTACTUPD';
  const OTHER = 'amitmishra+otherscreen@donegalgroup.com';
  const NEW = 'amitmishra+pcd@donegalgroup.com';
  add('GCCM-1013/INT/TC-129', 'INT_CLEAN', [ct('addPerson', P129),
    ct('setMainEmail', P129, 'amitmishra+start@donegalgroup.com', 'Parties Involved e-mail (start)'),
    ct('setPaymentContact', P129, { email: QA, mobile: '717-555-0142' }, 'Payment Contact Details (start)'), ...PAY(N129, '1.76'), READ('1.76', '$1.76 when sent'),
    ct('setMainEmail', P129, OTHER, 'Parties Involved e-mail changed (other screen)'), ...PAY(N129, '1.77'), READ('1.77', '$1.77 when sent'),
    ct('setPaymentContact', P129, { email: NEW, mobile: '717-555-0143' }, 'Payment Contact Details changed'), ...PAY(N129, '1.78'),
    READ('1.78', '$1.78'), READ('1.76', '$1.76 at the end')],
  [V('Parties Involved e-mail changed (other screen)', { value: /^saved/i }), V('Payment Contact Details changed', { value: /^saved/i }),
    V("OneInc $1.76 when sent Insured's Email", { value: new RegExp(`^${esc(QA)}$`, 'i') }), V('OneInc $1.76 when sent Primary Contact Phone', { value: /717\D*555\D*0142$/ }),
    V("OneInc $1.77 when sent Insured's Email", { value: new RegExp(`^${esc(QA)}$`, 'i') }), V('OneInc $1.77 when sent Primary Contact Phone', { value: /717\D*555\D*0142$/ }),
    V("OneInc $1.78 Insured's Email", { value: new RegExp(`^${esc(NEW)}$`, 'i') }), V('OneInc $1.78 Primary Contact Phone', { value: /717\D*555\D*0143$/ }),
    V("OneInc $1.76 at the end Insured's Email", { value: new RegExp(`^${esc(QA)}$`, 'i') }), V('OneInc $1.76 at the end Primary Contact Phone', { value: /717\D*555\D*0142$/ })],
  `New PA auto claim (shared by the cleansing cases). Claim-only person ${N129} with Payment Contact Details ${QA} / 717-555-0142: $1.76 payment sent and read on OneInc; `
    + `then the contact's own e-mail (Parties Involved › Edit — another screen) changed to ${OTHER}: $1.77 payment sent — OneInc must still get ${QA}; `
    + `then Payment Contact Details changed to ${NEW} / 717-555-0143: $1.78 payment sent — OneInc must get the new e-mail and mobile; $1.76 is read again at the end — `
    + 'the precondition says changes apply to new payments only, NOT existing ones. Finding 2026-11-14 (PA-PA-01-26-0749461, $1.73 / $1.74): changing Payment Contact Details '
    + 'updated the e-mail and mobile on payments already on OneInc (In Progress; OneInc Date Modified = the time of the change).');
};
