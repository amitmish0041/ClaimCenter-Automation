/**
 * helpers/oneInc/recipes/y_recurrenceToken.js — stored-token recurring check sets (CPD.003 / CPD.004 / CPD.007 / CPD.008):
 * 759 CPD (Check/Payment wizard) and 1003 CPD (Quick Check wizard) mirrors. Until 2026-11-12 MANUAL ("needs an active
 * recurrence with a stored OneInc token — OneInc does not report back on TEST"); OneInc now does, so the set is prepared
 * by scripts/oneIncPayeePrep.js (recur-wc / recur-pa) and the payee accepts its first check as Direct Deposit.
 *
 * The cases edit a SCHEDULED check of the set (helpers/oneInc/recurrence.js). Positions are kept apart so the cases do not
 * disturb each other: CPD.008 "change to Customer Choice" edits the first scheduled check, CPD.008 "leave it" the last;
 * everything else only opens the first scheduled check's Edit wizard and cancels.
 *
 * NOT YET RUN — written before any recurring set could be saved on TEST (2026-11-12). Verify on the first run.
 */
'use strict';

module.exports = (api) => {
  const { add, V } = api;
  const rc = (fn, ...a) => ({ call: [`recurrence.${fn}`, ...a] });
  const WC = '1.91';
  const PA = '1.92';
  const OPEN = (amount, which = 'first') => rc('openScheduled', amount, { which });
  const STORED = /^(?!Customer Choice$)\S/i; // a stored (prior preferred) method, i.e. not Customer Choice
  const CC = ['ClaimsPay Method', 'Customer Choice'];
  const SHOW = { call: ['portalChecks.showNotes'] };
  const NOTE_WC = 'PA workers comp claim (profile REC_WC): Weekly recurring set of 8 $1.91 checks to the claimant; the first check was accepted on the OneInc payee portal as Direct Deposit (stored token). ';
  const NOTE_PA = 'PA auto claim (profile REC_PA): Weekly recurring set of 8 $1.92 checks to the insured; the first check was accepted on the OneInc payee portal as Direct Deposit (stored token). ';
  const RO = 'The next scheduled check\'s Edit wizard is opened and cancelled — nothing saved.';
  // n759 null: the 759 case was deleted by QA review 2026-11-13 (TC-036/038/044/045/047); its 1003 mirror stays.
  const both = (n759, n1003, ...rest) => { if (n759) add(`GCCM-759/CPD/TC-${n759}`, ...rest); add(`GCCM-1003/CPD/TC-${n1003}`, ...rest); };

  // CPD.003 / CPD.004 — single insured / single claimant payee on a check that is part of a stored-token recurrence.
  // CPD.007 scopes the stored-token default to WC indemnity, and CPD.003's "single Insured" is checked on the auto set
  // (a WC claim's insured is the employer — a company cannot complete the payee portal); CPD.007 TC-045/222 expect the
  // OPPOSITE on the same kind of claim, so one of the two pairs fails by design until the BA settles which applies.
  both(null, '213', 'REC_PA', [OPEN(PA)], [V('ClaimsPay Method', { value: STORED })],
    NOTE_PA + 'CPD.003: ClaimsPay Method must not default to Customer Choice. (Conflicts with CPD.007 TC-045 / TC-222 on a non-WC claim — BA to confirm.) ' + RO);
  both(null, '215', 'REC_WC', [OPEN(WC)], [V('ClaimsPay Method', { value: STORED })], NOTE_WC + 'CPD.004: ClaimsPay Method must not default to Customer Choice. ' + RO);

  // CPD.007 — WC indemnity: ClaimsPay Type Contact(s), ClaimsPay Method = the stored method; a manual Customer Choice sticks.
  both('043', '220', 'REC_WC', [OPEN(WC)], [V('ClaimsPay Type', { value: /^Contact\(s\)$/i }), V('ClaimsPay Method', { value: STORED })],
    NOTE_WC + 'ClaimsPay Type must default to Contact(s) and ClaimsPay Method to the stored (Direct Deposit) method. ' + RO);
  both(null, '221', 'REC_WC', [OPEN(WC), { select: CC }], [V('ClaimsPay Method', { value: /^Customer Choice$/i })],
    NOTE_WC + 'ClaimsPay Method changed by hand to Customer Choice must stay Customer Choice (the stored token is bypassed for this check). Cancelled — nothing saved.');
  // CPD.007 — not WC: the stored-token default does not apply → the standard (non-recurrence) default, Customer Choice.
  both(null, '222', 'REC_PA', [OPEN(PA)], [V('ClaimsPay Method', { value: /^Customer Choice$/i })],
    NOTE_PA + 'CPD.007 is scoped to WC indemnity: on an auto claim the standard default (Customer Choice) applies. ' + RO);

  // CPD.008 — mid-recurrence change to Customer Choice (saved) vs left alone (saved). The "newly stored token" of TC-046/223
  // comes only after the payee accepts the changed check — NOT VERIFIED; the later check is checked to still carry a stored method.
  both('046', '223', 'REC_WC', [OPEN(WC, 'first'), { select: CC }, rc('saveEdit'), rc('noteScheduledMethod', 'Changed check ClaimsPay Method', 'first'),
    rc('noteScheduledMethod', 'Later check ClaimsPay Method', 'last'), SHOW],
  [V('Edit outcome', { value: /^saved/i }), V('Changed check ClaimsPay Method', { value: /^Customer Choice$/i }), V('Later check ClaimsPay Method', { value: STORED })],
  NOTE_WC + 'The first scheduled check is edited to Customer Choice and saved (TEST); it must keep Customer Choice and the last check of the set must still carry a stored method. NOT VERIFIED: the later checks taking the NEW token once the payee accepts the changed check.');
  both(null, '224', 'REC_WC', [OPEN(WC, 'last'), rc('saveEdit'), rc('noteScheduledMethod', 'Saved check ClaimsPay Method', 'last'),
    rc('noteScheduledMethod', 'Other scheduled check ClaimsPay Method', 1), SHOW],
  [V('Edit outcome', { value: /^saved/i }), V('Saved check ClaimsPay Method', { value: STORED }), V('Other scheduled check ClaimsPay Method', { value: STORED })],
  NOTE_WC + 'The last scheduled check is opened in Edit and saved unchanged (TEST); it and another scheduled check of the set must still carry the stored method.');
};
