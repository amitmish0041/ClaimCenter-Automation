/**
 * helpers/oneInc/recurrence.js — stored-token recurring check sets (CPD.003 / CPD.004 / CPD.007 / CPD.008; 759 CPD TC-036…047,
 * 1003 CPD TC-213…224). Added 2026-11-12.
 *
 * Data (scripts/oneIncPayeePrep.js slots recur-wc / recur-pa): a Weekly set of 8 checks; its FIRST check went to OneInc and
 * the payee accepted it as Direct Deposit with the texted code, which stores the payment token. The later checks of the set
 * are still scheduled (not sent), and their ClaimsPay Method should default to the stored method.
 *
 * NOT YET RUN: no recurring set had been saved on TEST when this was written (server error / examiner-number refusal,
 * 2026-11-12) — the scheduled-check screens are inferred from the Full Check wizard. Verify on the first run.
 */
'use strict';
const W = require('./wizardDriver');
const K = require('./checkOps');
const { readScreen, findField } = require('./screenReader');

const SENT = /^(Issued|Requested|Requesting|Cleared|Voided|Pending void|Stopped)$/i;
const setAmount = (page) => (page.__recur = page.__recur || {});

// The set of `amount` on this claim: rows of the Checks list. BLOCKED until the first check is Issued (accepted by the payee).
async function setRows(page, amount) {
  const want = String(amount).replace(/[^0-9.]/g, '');
  const rows = (await K.checkRows(page)).filter((r) => String(r.amount).replace(/[^0-9.]/g, '') === want);
  if (!rows.length) throw new W.Blocked(`no recurring check set of $${want} on this claim (prepare it: scripts/oneIncPayeePrep.js --only recur-wc,recur-pa)`);
  if (!rows.some((r) => /^Issued$/i.test(r.status))) throw new W.Blocked(`the first $${want} check of the set is "${rows[0].status}", not Issued — the payee has not accepted it on the OneInc payee portal yet (Direct Deposit stores the token)`);
  const scheduled = rows.filter((r) => !SENT.test(r.status));
  if (!scheduled.length) throw new W.Blocked(`no scheduled (unsent) check left in the $${want} set (statuses: ${rows.map((r) => r.status).join(', ')})`);
  return { rows, scheduled };
}

// Opens a scheduled check of the set — `which`: 'first' (the next one), 'last', or a position (negative from the end) — and,
// with edit, its Edit wizard, then moves through the wizard to the step that shows ClaimsPay Method.
async function openScheduled(page, amount, { edit = true, which = 'first' } = {}) {
  const { scheduled } = await setRows(page, amount);
  setAmount(page).amount = amount;
  const at = which === 'first' ? 0 : which === 'last' ? -1 : Number(which);
  if (!scheduled.at(at)) throw new W.Blocked(`the $${amount} set has only ${scheduled.length} scheduled check(s) — none at position ${which}`);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const opened = await K.openCheck(page, { amount, status: `^(${[...new Set(scheduled.map((r) => esc(r.status)))].join('|')})$`, pick: at });
  if (!edit) return opened;
  const b = page.getByRole('button', { name: /^Edit( Check| Payment)?$/ }).first();
  if (!await b.isVisible().catch(() => false)) throw new W.Blocked(`the scheduled check has no Edit button on Check/Payment Details (${opened})`);
  await b.click();
  await W.settle(page, 3500);
  return `${opened}; Edit opened — ${await toClaimsPay(page)}`;
}

// Next through the wizard until ClaimsPay Method is on the screen (max 3 steps).
async function toClaimsPay(page) {
  for (let i = 0; i < 4; i++) {
    const f = findField(await readScreen(page), 'ClaimsPay Method');
    if (f) return `ClaimsPay Method "${f.value || ''}" on step ${JSON.stringify(await W.currentStep(page).catch(() => null))}`;
    if (i === 3 || !await W.inWizard(page)) break;
    await W.nextFillingServicePeriod(page);
  }
  throw new W.Blocked('the scheduled check\'s wizard shows no ClaimsPay Method');
}

// Saves the edited scheduled check (Finish, warnings-only pages pressed through). Writes "Edit outcome".
async function saveEdit(page) {
  if (process.env.ONEINC_ALLOW_FINISH !== '1') throw new W.Blocked('saving the scheduled check changes TEST data — enable ONEINC_ALLOW_FINISH=1');
  for (let i = 0; i < 3 && !await page.getByRole('button', { name: 'Finish', exact: true }).first().isEnabled().catch(() => false); i++) await W.nextFillingServicePeriod(page);
  await W.clickButton(page, 'Finish');
  let msgs = '';
  for (let t = 0; t < 30 && await W.inWizard(page); t++) {
    const s = await readScreen(page);
    if (s.messages.length || s.south) {
      msgs = [...s.messages, s.south].join(' / ');
      if (!W.warningsOnly(s)) break;
      await W.clickButton(page, 'Finish').catch(() => {});
      await W.settle(page, 2000);
    }
    await page.waitForTimeout(1000);
  }
  const ok = !await W.inWizard(page);
  if (!ok) await W.cancelWizard(page).catch(() => {});
  return K.observe(page, 'Edit outcome', ok ? `saved${msgs ? ` (warnings: ${msgs.slice(0, 200)})` : ''}` : `refused: ${msgs.slice(0, 300) || 'no message'}`);
}

// ClaimsPay Method of the scheduled check `which` ('first' | 'last'), opened read-only on Check/Payment Details, kept as a
// note named `as` (portalChecks notes survive navigation; shown again by portalChecks.showNotes).
async function noteScheduledMethod(page, as, which = 'last') {
  const amount = setAmount(page).amount;
  await W.cancelWizard(page).catch(() => {});
  await openScheduled(page, amount, { edit: false, which });
  return require('./portalChecks').noteField(page, 'ClaimsPay Method', as);
}

module.exports = { openScheduled, toClaimsPay, saveEdit, noteScheduledMethod };
