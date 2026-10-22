/**
 * helpers/oneInc/recipes/workerK.js — Worker K (added 2026-10-22): VBR.006 (mortgagee on building checks > $5,000) and
 * the HO roof question (UIF.057 / UIF.067), on the dedicated HO claim profile PROP_BLDG (../profiles/workerK.js).
 *
 * Helpers used by these recipes and by testData's `document` item are attached to the exported function and called
 * with { call: ['recipes/workerK.<fn>', ...args] }. They WRITE to claims on the TEST tier only (a claim document).
 *
 * Screen facts (cloud TEST, HO-PA-01-26-0748434, 2026-10-22):
 *  - Claim › Documents › "New Document" menu: "Indicate the existence of NON-ImageRight document/media" (a document
 *    record with no file: Document Description*, Related To* (Claim), Document Type* …, Update) and "Create from a
 *    template". There is no file upload on cloud TEST.
 *  - Payment wizard Step 3 (Full Check) has a "Link Document" button above the "Linked Documents" grid.
 */
'use strict';
const W = require('../wizardDriver');
const { readScreen, findField } = require('../screenReader');

const TIER = (process.env.CC_TIER || 'test').toLowerCase();
const testOnly = (what) => { if (TIER !== 'test') throw new W.Blocked(`${what} writes claim data — allowed on the TEST tier only`); };
const DOC_NAME = 'OneInc automation - supporting document';

// ── Claim documents ─────────────────────────────────────────────────────────────────────────────────────────────
async function openDocuments(page) {
  await page.locator('[role="menuitem"]', { hasText: /^Documents$/ }).first().click();
  await W.settle(page, 3000);
  await page.locator('[id*="DocumentsLV"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
}
// Text of each row of the claim's Documents list (Search Results).
async function documentRows(page) {
  await openDocuments(page);
  return page.evaluate(() => [...document.querySelectorAll('tr[id*="DocumentsLV-"]')].filter((r) => r.offsetParent && !r.querySelector('tr'))
    .map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()).filter((t) => t && !/No data to display/i.test(t)));
}
// Adds a document record (no file) through New Document › "Indicate the existence of NON-ImageRight document/media".
async function addDocument(page, { name = DOC_NAME, type = 'Other' } = {}) {
  testOnly('addDocument');
  const have = (await documentRows(page)).find((t) => t.toLowerCase().includes(name.toLowerCase()));
  if (have) return `document already on the claim (${have.slice(0, 80)})`;
  await page.getByRole('button', { name: 'New Document', exact: true }).first().click();
  await W.settle(page, 1500);
  await page.getByText('Indicate the existence of NON-ImageRight document/media', { exact: true }).first().click();
  await W.settle(page, 3000);
  await W.fill(page, 'Document Description', name);
  // "Related To" defaults to Claim.
  await W.select(page, 'Document Type', type);
  await W.answerUnansweredNo(page).catch(() => {});
  await W.fillRequiredEmpties(page).catch(() => {});
  await W.clickButton(page, 'Update');
  await W.settle(page, 3000);
  if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
    const s = await readScreen(page);
    const why = [...s.messages, s.south].filter(Boolean).join(' / ');
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new W.Blocked(`document could not be saved: ${why.slice(0, 300) || 'no message'}`);
  }
  return `added document "${name}" (type ${type})`;
}

// ── Property exposures ──────────────────────────────────────────────────────────────────────────────────────────
// Actions › New Exposure › Choose by Coverage › <location n> › <coverage> (CONFIRMED 2026-10-22 on HO-PA-01-26-0747949:
// "1 (1179 WALLACE ST…)" › Coverage A Dwelling / B Other Structures / C Personal Property / D Loss of Use). The Coverage C
// screen needs Cause of Loss, Claimant + Type, Damage Description (the "Damaged/Stolen Item" incident is created with it).
async function addPropertyExposure(page, { coverage = 'Coverage C Personal Property', cause = /^Fire-Contents$/i, existing = /Personal Property|Contents/i } = {}) {
  testOnly('addPropertyExposure');
  const rows = await require('./workerF').exposureRows(page);
  const have = rows.find((r) => existing.test(r.t));
  if (have) return `exposure already on the claim (${have.t.slice(0, 80)})`;
  await W.openActionsMenu(page);
  await page.getByRole('menuitem', { name: /New Exposure/ }).first().hover(); await page.waitForTimeout(1500);
  await page.getByRole('menuitem', { name: /Choose by Coverage/ }).first().hover(); await page.waitForTimeout(2500);
  const locs = page.getByRole('menuitem', { name: /^\d+ \(/ });
  let opened = false;
  for (let i = 0, n = await locs.count(); i < n && !opened; i++) {
    await locs.nth(i).hover(); await page.waitForTimeout(1800);
    const cov = page.getByRole('menuitem', { name: coverage, exact: true }).first();
    if (!await cov.isVisible().catch(() => false)) continue;
    await cov.click();
    opened = true;
  }
  if (!opened) { await W.closeMenus(page); throw new W.Blocked(`no policy location carries a "${coverage}" coverage`); }
  await W.settle(page, 4000);
  const ins = await page.evaluate(() => ((/Ins:\s*(.+?)\s+(Clmt|DoL|St|Adj):/.exec((document.body.innerText || '').replace(/\s+/g, ' ')) || [])[1] || '').trim());
  await W.select(page, 'Cause of Loss', cause);
  const sel = await page.evaluate(() => [...document.querySelectorAll('.gw-InputWidget')].filter((w) => w.offsetParent && w.querySelector('select')
    && ((w.querySelector('.gw-label') || {}).innerText || '').trim() === 'Claimant').map((w) => w.id)[0]);
  if (!sel) throw new W.Blocked('New Exposure: no Claimant picker');
  const claimantSel = page.locator(`[id="${sel}"] select`).first();
  const opts = await claimantSel.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })));
  const pick = opts.find((o) => ins && o.t.toLowerCase() === ins.toLowerCase()) || opts.find((o) => o.v && !/^<none>$/i.test(o.t));
  await claimantSel.selectOption(pick.v);
  await W.settle(page, 2000);
  await W.select(page, 'Type', /^Insured$/).catch(() => {});
  await W.fill(page, 'Damage Description', 'OneInc automation — contents damage').catch(() => {});
  for (let r = 0; r < 3; r++) {
    await W.fillRequiredEmpties(page);
    await W.clickButton(page, 'Update');
    await W.settle(page, 3000);
    if (!await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
      return `added a "${coverage}" exposure, Cause of Loss ${String(cause)}, claimant ${pick.t}`;
    }
  }
  const s = await readScreen(page);
  const why = [...s.messages, s.south].filter(Boolean).join(' / ');
  await W.cancelWizard(page).catch(() => {});
  throw new W.Blocked(`new exposure could not be saved: ${why.slice(0, 400) || 'no message'}`);
}

// ── Payment wizard: link a claim document, then Finish (VBR.010 needs a linked document on checks over $1,000) ────
// Presses Next to the last step (Instructions on the Full Check, Payment details on Quick Payment) — a step that
// does not advance is left to reuseExt.finishObserve, which records "stopped at Next: …". On the last step:
// "Link Document" › pick the claim document `name` › back on the step, then reuseExt.finishObserve (Finish once,
// stop at the first warning/error, write the "Finish outcome" field).
async function finishWithDocument(page, name = DOC_NAME) {
  for (let round = 0; round < 4; round++) {
    const st = await W.currentStep(page);
    if (!st || st.n === st.of) break;
    await W.fillRequiredEmpties(page);
    await W.clickButton(page, 'Next');
    const after = await W.currentStep(page);
    if (!after || after.n <= st.n) break; // stopped — finishObserve reports why
  }
  const st = await W.currentStep(page);
  if (st && st.n === st.of) await linkDocument(page, name);
  await require('../reuseExt').finishObserve(page);
}

async function linkDocument(page, name = DOC_NAME) {
  const linked = async () => page.evaluate((n) => [...document.querySelectorAll('tr')].some((r) => r.offsetParent && !r.querySelector('tr')
    && /LinkedDocuments|DocumentsLV/i.test(r.id || r.innerHTML.slice(0, 400)) && (r.innerText || '').toLowerCase().includes(n.toLowerCase())), name);
  if (await linked()) return;
  await W.clickButton(page, 'Link Document');
  await W.settle(page, 2500);
  // Document picker: one row per claim document with a "Select" action.
  const row = page.locator('tr', { hasText: name }).filter({ has: page.getByRole('button', { name: 'Select', exact: true }) }).last();
  if (!await row.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)) {
    const s = await readScreen(page);
    await page.getByRole('button', { name: /^(Cancel|Return to.*)$/ }).first().click().catch(() => {});
    throw new W.Blocked(`Link Document: claim document "${name}" is not offered (${(s.body || '').slice(0, 300)})`);
  }
  await row.getByRole('button', { name: 'Select', exact: true }).first().click();
  await W.settle(page, 3000);
  if (!await linked()) throw new W.Blocked(`Link Document: "${name}" did not appear under Linked Documents`);
}

module.exports = (api) => {
  const { add, V } = api;
  const D = () => require('../testData').D;
  const X = (fn, ...a) => ({ call: [`recipes/workerK.${fn}`, ...a] });
  const OUT = (re) => V('Finish outcome', { value: re });
  const PROFILE = 'PROP_BLDG';
  const BLDG = 'Building';
  const OTHER = 'Contents'; // the claim's non-building (Coverage C Personal Property) exposure

  // ════ VBR.006 — Mortgagee must appear on $5,000+ Building checks ════════════════════════════════════════════════
  // Claim cost to the Insured (single payee — the mortgagee is NOT on the check) on the Building exposure's reserve line;
  // a claim document is linked on the last step so VBR.010 (> $1,000 needs a document) cannot stop the check first.
  // Negatives must not show the VBR.006 text: a check other rules stop (e.g. VBR.007 "Loss payee/additional insured
  // must appear on check", which fires on property claim cost checks) still passes when VBR.006's text is absent.
  const VBR006 = /Mortgagee must appear on checks over \$?5,?000/i;
  const NO_VBR006 = OUT(/^(?![\s\S]*Mortgagee must appear on checks over)[\s\S]+/i);
  const FIN = X('finishWithDocument');
  const needs = (min, expo = BLDG) => ({ needs: [D().reserve({ exposure: new RegExp(expo, 'i'), min }), D().document()] });
  const FULL_CC = (amount, line = BLDG) => [{ open: 'full' }, { payee: 'insured' }, { next: true }, { reserve: `match:${line}` },
    { step2: { transactionType: 'Partial Payment', amount } }, FIN];
  const QUICK_CC = (amount, line = BLDG) => [{ call: ['reuseExt.openQuickOnRow', 'claim cost', Number(amount) + 1, line] }, { payee: 'insured' },
    { step2: { transactionType: 'Partial Payment', amount } }, FIN];
  // Expense on the Building exposure: new "Expense OR First and Final" line (Exposure = the claim's first exposure,
  // Building), Adjuster Expense, First and Final, Address Book vendor payee (VBR.025).
  const FULL_EXP = (amount) => [{ open: 'full' }, { payee: 'vendor' }, { next: true }, { reserve: 'new' }, { select: ['Exposure', /Building/i] }, { select: ['Cost Type', 'Adjuster Expense'] },
    { step2: { transactionType: 'First and Final', amount } }, FIN];
  const NOTE = 'Dedicated HO claim (profile PROP_BLDG): Building (Coverage A Dwelling) exposure, mortgagee ANKER AUTO BODY on the property incident mortgage, '
    + 'payee = the Insured only; a claim document is linked on the last step (VBR.010). Finish runs only with ONEINC_ALLOW_FINISH=1; a check no rule stops is SUBMITTED on TEST.';
  // GCCM-763 (Full Check) / GCCM-1003 (Quick Payment)
  add('GCCM-763/VBR/TC-016', PROFILE, FULL_CC('5000.01'), [OUT(VBR006)], NOTE + ' Stops at the warning (nothing submitted).', needs(5000.02));
  add('GCCM-1003/VBR/TC-098', PROFILE, QUICK_CC('5000.01'), [OUT(VBR006)], NOTE + ' Stops at the warning (nothing submitted).', needs(5000.02));
  add('GCCM-763/VBR/TC-017', PROFILE, FULL_CC('5000.00'), [NO_VBR006], NOTE + ' Boundary: exactly $5,000.00 — may submit a $5,000.00 check.', needs(5000.01));
  add('GCCM-1003/VBR/TC-100', PROFILE, QUICK_CC('5000.00'), [NO_VBR006], NOTE + ' Boundary: exactly $5,000.00 — may submit a $5,000.00 check.', needs(5000.01));
  add('GCCM-763/VBR/TC-018', PROFILE, FULL_CC('6000.00', OTHER), [V('Finish outcome', { value: /\S/ }), NO_VBR006],
    NOTE + ' Pays $6,000 claim cost from the claim\'s NON-building exposure line (the HO FNOL\'s Coverage C/E/F exposure — the test design names Bodily Injury).', needs(6000.01, OTHER));
  add('GCCM-1003/VBR/TC-101', PROFILE, QUICK_CC('6000.00', OTHER), [NO_VBR006],
    NOTE + ' Pays $6,000 claim cost from the claim\'s NON-building exposure line.', needs(6000.01, OTHER));
  add('GCCM-763/VBR/TC-019', PROFILE, FULL_EXP('6000.00'), [NO_VBR006], NOTE + ' $6,000 Adjuster Expense (First and Final) on a new Building line, Address Book vendor payee.',
    { needs: [D().document()] });
  // The Building expense row TC-019 leaves at $0 (First and Final) — First and Final again (VBR.014 allows it at $0).
  add('GCCM-1003/VBR/TC-102', PROFILE, [{ call: ['reuseExt.openQuickOnRow', 'expense', 'zero', BLDG] }, { payee: 'vendor' }, { step2: { transactionType: 'First and Final', amount: '6000.00' } }, FIN], [NO_VBR006],
    NOTE + ' $6,000 expense Quick Payment (First and Final) from the Building exposure\'s $0 expense reserve row (created by GCCM-763 TC-019), Address Book vendor payee.',
    { needs: [D().document()] }); // + the derived $0 Building expense row

  // ════ Roof question (UIF.067 Full Check Step 3 / UIF.057 Quick Payment details) ══════════════════════════════════
  // Claim cost to the Insured on the Building exposure whose Cause of Loss is Fire (one of the listed weather/peril
  // causes). Read-only: the wizard is cancelled.
  const ROOF = 'Does this transaction include payment for repairs or replacement to at least half of the roof?';
  const ROOF_NOTE = 'Dedicated HO claim (profile PROP_BLDG): claim cost to the Insured on the Building (Coverage A Dwelling) exposure, Cause of Loss Fire.';
  const COL = V('Cause of Loss', { value: /fire/i });
  add('GCCM-799/UIF/TC-056', PROFILE, [{ open: 'full' }, { payee: 'insured' }, { next: true }, { reserve: `match:${BLDG}` }, COL,
    { step2: { transactionType: 'Partial Payment', amount: '3.07' } }, { next: true }, { expectStep: 3 }], [V(ROOF, { required: true, editable: true })], ROOF_NOTE);
  add('GCCM-1003/UIF/TC-073', PROFILE, [{ call: ['reuseExt.openQuickOnRow', 'claim cost', 'open', BLDG] }, { payee: 'insured' }, COL,
    { step2: { transactionType: 'Partial Payment', amount: '3.11' } }, { next: true }, { expectStep: 2 }], [V(ROOF, { required: true, editable: true })], ROOF_NOTE);
};
Object.assign(module.exports, { openDocuments, documentRows, addDocument, addPropertyExposure, finishWithDocument, linkDocument, DOC_NAME });
