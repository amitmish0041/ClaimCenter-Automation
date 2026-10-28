/**
 * helpers/oneInc/recipes/workerJ.js — Worker J (added 2026-10-22): VBR.032 (final payment blocked while another
 * transaction on the reserve line is pending approval) and UIF.061 / UIF.052 ("Is this a wage Payment?").
 *
 * VBR.032 — the cloud adjuster benjsmit (default CC_USER) has no NewReserveSet permission, so no reserve change of his can
 * pend; his PIP Wage Loss payments ARE held in "Pending approval" (CONFIRMED 2026-10-22). So the positives (032 / 177)
 * and the Partial negatives (034 / 179) pay the PIP Wage line (3) of J_DE_PIP (profiles/workerJ.js, PA-DE-01-25-0746526),
 * whose declared data includes a $1.37 pending payment (workerG.makePendingPayment). The Final Payment negatives (033 /
 * 178) pay line (1) Collision of a G_PA claim with nothing pending — closing it, so each uses up one G_PA claim.
 * Run order: 032, 177, 034, 179, 033, 178. Afterwards approve/reject the pending payments as the approver.
 *
 * UIF.061 / UIF.052 — profile F_DE_WAGE (helpers/oneInc/profiles/workerF.js): DE personal auto PA-DE-01-25-0746526,
 * "(3) 1st Party Wage Benefits - MATTHEW SPONG - PIP" exposure (PIP › Wage Loss Benefits, Cause of Loss Personal Injury
 * Protection = LC57) with an approved $2,500 Claim Cost reserve. Payments on that line to MATTHEW SPONG: >= $1,000 shows
 * the question, < $1,000 hides it. Read-only (the wizard is cancelled).
 */
'use strict';

module.exports = (api) => {
  const { add, V, H, VAL } = api;
  const G = (fn, ...a) => ({ call: [`workerG.${fn}`, ...a] });
  const X = (fn, ...a) => ({ call: [`reuseExt.${fn}`, ...a] });

  // ════ VBR.032 ══════════════════════════════════════════════════════════════════════════════════════════════════
  const MSG032 = /final payment cannot be submitted while other transactions on that reserve line are still pending approval/i;
  const SUB = (a) => ` Submits a $${a} payment on TEST (needs ONEINC_ALLOW_FINISH=1).`;
  // Positives + Partial negatives — J_DE_PIP: PIP Wage line (3) of PA-DE-01-25-0746526 carries a payment in "Pending
  // approval" (gate: Financials › Transactions, right before the case). Payee MATTHEW SPONG.
  const PIP = 'MATTHEW SPONG';
  const PFULL = (transactionType, amount) => [G('requirePending', 3, true), { open: 'full' }, { payee: PIP }, { next: true }, { reserve: 'match:Wage' }, { step2: { transactionType, amount } }];
  const PQUICK = (transactionType, amount) => [G('requirePending', 3, true), X('openQuickOnRow', 'claim cost', 'open', 'Wage'), { payee: PIP }, { step2: { transactionType, amount } }];
  const N = 'J_DE_PIP claim PA-DE-01-25-0746526: exposure (3) "1st Party Wage Benefits - MATTHEW SPONG - PIP" has a $1.37 payment by the adjuster in "Pending approval" (benjsmit cannot change reserves on cloud; his PIP payments pend).';
  add('GCCM-803/TC/TC-032', 'J_DE_PIP', VAL(PFULL('Final Payment', '1.31'), MSG032), [], N + ' Final Payment on that line.');
  add('GCCM-1003/VBR/TC-177', 'J_DE_PIP', VAL(PQUICK('Final Payment', '1.32'), MSG032), [], N + ' Quick Payment, Final Payment on that line.');
  add('GCCM-803/TC/TC-034', 'J_DE_PIP', VAL(PFULL('Partial Payment', '1.33'), null), [], N + ' Partial Payment on that line (itself held for approval).' + SUB('1.33'));
  add('GCCM-1003/VBR/TC-179', 'J_DE_PIP', VAL(PQUICK('Partial Payment', '1.34'), null), [], N + ' Quick Payment, Partial Payment on that line (itself held for approval).' + SUB('1.34'));
  // Final Payment negatives — G_PA: line (1) Collision, nothing pending (gate). The Final Payment CLOSES line (1), so
  // 178 moves on to the next G_PA pool claim through its derived "open line (1)" need. Run 033 before 178.
  const LINE1 = 'match:^\\(1\\) ';
  const CLEAN1 = G('requirePending', 1, false);
  const N1 = 'G_PA claim: Final Payment on exposure (1) Collision, whose reserve line has nothing pending (gate: Financials › Transactions). Closes line (1) — uses up the claim for this case.';
  add('GCCM-803/TC/TC-033', 'G_PA', VAL([CLEAN1, { open: 'full' }, { payee: 'claimant' }, { next: true }, { reserve: LINE1 }, { step2: { transactionType: 'Final Payment', amount: '1.35' } }], null), [], N1 + SUB('1.35'));
  add('GCCM-1003/VBR/TC-178', 'G_PA', VAL([CLEAN1, X('openQuickOnRow', 'claim cost', 'open', '^\\(1\\) '), { step2: { transactionType: 'Final Payment', amount: '1.36' } }], null), [], N1 + ' Quick Payment.' + SUB('1.36'));

  // ════ UIF.061 (Full Check, Step 3) / UIF.052 (Quick Payment, Step 2) — "Is this a wage Payment?" ═══════════════
  const WAGE = 'Is this a wage Payment?';
  const PAYEE = 'MATTHEW SPONG';
  const WFULL = (amount) => [{ open: 'full' }, { payee: PAYEE }, { next: true }, { reserve: 'match:Wage' }, { step2: { transactionType: 'Partial Payment', amount } }, { next: true }, { expectStep: 3 }];
  const WQUICK = (amount) => [X('openQuickOnRow', 'claim cost', 'open', 'Wage'), { payee: PAYEE }, { step2: { transactionType: 'Partial Payment', amount } }, { next: true }, { expectStep: 2 }];
  const WN = 'F_DE_WAGE claim PA-DE-01-25-0746526: "(3) 1st Party Wage Benefits - MATTHEW SPONG - PIP" (PIP › Wage Loss Benefits, Cause of Loss Personal Injury Protection = LC57), approved $2,500 Claim Cost reserve; payee MATTHEW SPONG. Wizard cancelled — nothing submitted.';
  add('GCCM-799/UIF/TC-048', 'F_DE_WAGE', WFULL('1000.00'), [V(WAGE, { editable: true, required: true })], WN + ' Amount $1,000.00 (>= $1,000). Updated GCCM-800 plan (2026-10-28): the question is now REQUIRED (Required condition: Check.isWagePayment()).');
  add('GCCM-799/UIF/TC-049', 'F_DE_WAGE', WFULL('999.99'), [H(WAGE)], WN + ' Amount $999.99 (< $1,000).');
  add('GCCM-1003/UIF/TC-065', 'F_DE_WAGE', WQUICK('1000.00'), [V(WAGE, { editable: true, required: true })], WN + ' Quick Payment, amount $1,000.00 (>= $1,000).');
  add('GCCM-1003/UIF/TC-066', 'F_DE_WAGE', WQUICK('999.99'), [H(WAGE)], WN + ' Quick Payment, amount $999.99 (< $1,000).');
};
