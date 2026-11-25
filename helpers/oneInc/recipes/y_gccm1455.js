/**
 * helpers/oneInc/recipes/y_gccm1455.js — GCCM-1455 "Get Payment Status Updates" (UIF.034–038, INT.002/004; workbook
 * added 2026-11-24). Each case files a joint check (insured + Secondary Named Insured / Additional Insured, ClaimsPay
 * Type Contact(s)) on an HO claim whose policy carries both (HO_SNI, one shared fresh claim per run) and reads
 * Additional Payment Details — helpers/oneInc/signatureStatus.js.
 */
'use strict';

module.exports = (api) => {
  const { add, V } = api;
  const S = (fn, ...a) => ({ call: [`signatureStatus.${fn}`, ...a] });
  const JOINT = (second = 'sni') => [S('createJointCheckAPD', { second }), S('observeSection')];
  const CONTACTS = V('ClaimsPay Type', { value: /^Contact\(s\)$/i });
  const BUTTON = V('Get Payment Signature Status button', { value: /^visible$/ });
  const SECTION = V('Multi-Party Signature Status section', { value: /^shown, between Workflow History and Payment Feedback Received; read-only/ });
  const N = 'HO claim on a policy with an Insured and a Secondary Named Insured; new Full Check to the insured (type Insured) with the ';
  const SNI = `${N}Secondary Named Insured as joint payee (ClaimsPay Type Contact(s)); Additional Payment Details of that check.`;
  const QA_EX = { claim: 'HO-PA-01-26-0748044', number: '8200009199' }; // QA's example in the workbook (Issued, Insured + SNI)
  const CALL_OK = V('Signature status call', { value: /^answered$/ });

  add('GCCM-1455/TC/TC-001', 'HO_SNI', JOINT(), [CONTACTS, BUTTON], SNI);
  add('GCCM-1455/TC/TC-002', 'HO_SNI', JOINT('ai'), [CONTACTS, BUTTON],
    `${N}policy's Additional Insured as joint payee (ClaimsPay Type Contact(s)); Additional Payment Details of that check.`);
  add('GCCM-1455/TC/TC-003', 'HO_SNI', JOINT(), [CONTACTS, SECTION], SNI + ' Section must sit between Workflow History and Payment Feedback Received and have no input fields.');
  add('GCCM-1455/TC/TC-004', 'HO_SNI', JOINT(), [SECTION, V('Multi-Party Signature Status columns', { value: /^Date\b/ })], SNI + ' Date must be the first (left-most) column; read-only list.');
  add('GCCM-1455/TC/TC-005', 'HO_SNI', JOINT(), [SECTION, V('Multi-Party Signature Status columns', { value: /^Date \| Primary Contact\b/ })], SNI + ' Primary Contact must be right of Date; read-only list.');
  add('GCCM-1455/TC/TC-006', 'HO_SNI', JOINT(), [SECTION, V('Multi-Party Signature Status columns', { value: /^Date \| Primary Contact \| Secondary Contact$/ })], SNI + ' Secondary Contact must be right of Primary Contact; read-only list.');
  add('GCCM-1455/TC/TC-007', 'HO_SNI', [...JOINT(), S('requestStatus', { fallback: QA_EX })], [BUTTON, CALL_OK],
    SNI + ' "Get Payment Signature Status" clicked: the real-time GetPaymentStatus call must succeed (no OneInc error, a row comes back). The outbound request itself is not visible in the UI; CC\'s answer is the evidence.');
  add('GCCM-1455/TC/TC-008', 'HO_SNI', [...JOINT(), S('requestStatus', { fallback: QA_EX })],
    [CALL_OK, V('Signature status rows added', { value: /^1$/ }), V('Newest signature row is today', { value: /^true$/ }), V('Signature values contain an e-mail', { value: /^false$/ })],
    SNI + ' One click: one new row dated today; Primary / Secondary Contact show the status text after the e-mail (e-mail not shown).');
  add('GCCM-1455/TC/TC-009', 'HO_SNI', [...JOINT(), S('requestStatus', { times: 2, fallback: QA_EX })],
    [CALL_OK, V('Signature status rows added', { value: /^2$/ }), V('Earlier rows kept', { value: /^true$/ })],
    SNI + ' Two clicks: two rows, the first one kept.');
  add('GCCM-1455/TC/TC-010', 'HO_SNI', [...JOINT(), S('requestStatus', { fallback: QA_EX })],
    [CALL_OK, V('Newest Primary Contact', { value: /\S/ }), V('Newest Secondary Contact', { value: /\S/ }), V('Signature values contain an e-mail', { value: /^false$/ })],
    SNI + ' Neither payee has signed on a new check, so both read "unsigned"; a PCON-signed / SCON-unsigned split needs the primary payee to act in the OneInc customer portal first — judged on separate, unswapped values.');
};
