/**
 * helpers/e2eSteps.js — shared step switches + steps for the per-LOB E2E specs (tests/lob/*.e2e.test.js).
 *
 * The Runner's Claims tab picks which steps run and passes them in:
 *   CC_E2E_STEPS  comma list of reserve,payment,approval,recovery,close (default: all but close)
 *   CC_E2E_CLAIM  run the steps on an EXISTING claim instead of filing a new FNOL
 *
 * Each spec calls gate(testInfo) in beforeEach; it skips a test from its title, so specs keep their own titles/order.
 */
'use strict';

const IS_CLOUD = (process.env.CC_ENV || 'onprem').toLowerCase() === 'cloud';
const ALL = ['reserve', 'payment', 'approval', 'recovery', 'close'];
const DEFAULT = ['reserve', 'payment', 'approval', 'recovery'];

function steps() {
  const raw = String(process.env.CC_E2E_STEPS || '').trim();
  const list = raw ? raw.toLowerCase().split(',').map(s => s.trim()).filter(s => ALL.includes(s)) : DEFAULT;
  // An approval needs a payment to approve.
  return list.filter(s => s !== 'approval' || list.includes('payment'));
}
const on = (step) => steps().includes(step);
const existingClaim = () => String(process.env.CC_E2E_CLAIM || '').trim() || null;

// Which step a test belongs to, from its title. Order matters: "recovery reserve" is recovery, "Approve payment" approval.
function stepOf(title) {
  const t = title.toLowerCase();
  if (/fnol/.test(t)) return 'fnol';
  if (/recovery|subrogation|salvage/.test(t)) return 'recovery';
  if (/approve/.test(t)) return 'approval';
  if (/payment/.test(t)) return 'payment';
  if (/close|reopen|archive/.test(t)) return 'close';
  if (/reserve|segment/.test(t)) return 'reserve';
  return null; // activities, documents etc. always run
}

// ctx = { page, claimNumber } (read when the test starts). Cloud user switch, as the OneInc data step does: the standard
// user's reserves land "Submitted" and no payee then has a payable Reserve Line (confirmed 2026-11-02 on
// CA-PA-01-26-0748712), so reserves are made as the admin; the payment goes back to the standard user so it still
// routes to approval.
let cloudUser = 'standard';
let repaired = false;
async function gate(test, testInfo, ctx = {}) {
  const s = stepOf(testInfo.title);
  if (s === 'fnol') test.skip(!!existingClaim(), `existing claim ${existingClaim()} — FNOL not run`);
  else if (s) test.skip(!on(s), `step "${s}" not selected (CC_E2E_STEPS=${steps().join(',')})`);
  if (!IS_CLOUD || !ctx.page || !ctx.claimNumber) return;
  // Before the first money step, bring the claim to Ability to pay (else no payee has a payable Reserve Line).
  if (!repaired && ['reserve', 'payment', 'recovery'].includes(s) && on(s)) {
    repaired = true;
    await repairCloud(ctx.page, ctx.claimNumber);
  }
  const want = s === 'reserve' ? 'admin' : s === 'payment' ? 'standard' : null;
  if (!want || want === cloudUser) return;
  const B = require('./claimCenterBase');
  await (want === 'admin' ? B.loginAsAdmin(ctx.page) : B.loginToClaimCenter(ctx.page));
  await B.openExistingClaim(ctx.page, ctx.claimNumber);
  cloudUser = want;
  console.log(`Cloud: ${s} step runs as the ${want} user`);
}

// Recovery category per LOB: property/liability lines recover by subrogation, auto also by salvage.
const RECOVERY_TYPE = { BOP: 'Subrogation', CP: 'Subrogation', CA: 'Subrogation', PA: 'Subrogation', HO: 'Subrogation', WC: 'Subrogation' };

// Recovery reserve, then a receipt for the FULL amount: a partial receipt leaves an open recovery reserve that CC
// auto-zeros on exposure close, and DMTV0039 refuses that same-day (confirmed live on PA, see PA_Auto.e2e E2E-PA-009).
async function recovery(page, lob, amount = 500) {
  const F = require('./financialsHelper');
  const recoveryType = RECOVERY_TYPE[lob] || 'Subrogation';
  if (IS_CLOUD) return recoveryCloud(page, { recoveryType, amount });
  await F.createRecoveryReserve(page, { recoveryType, reserveAmount: amount });
  await F.createRecoveryReceipt(page, { recoveryType, receiptAmount: amount });
}

// Cloud (Jutro) path — NOT yet confirmed live. Same Actions menu the cloud payment uses ("deferred Actions"), fields by
// label. Any missing control throws with the step name so the first live run says exactly where it differs.
// Every visible empty (or claim-level) select in the screen's list views takes its first real option; repeated because
// picking one (Exposure) fills the next (Cost Type) over a server round-trip.
async function fillGridSelects(page) {
  for (let round = 0; round < 4; round++) {
    const changed = await page.evaluate(() => {
      const done = [];
      for (const sel of document.querySelectorAll('[id*="LV"] select')) {
        if (!sel.offsetParent || sel.disabled || sel.closest('#gw-south-panel')) continue;
        const cur = ((sel.options[sel.selectedIndex] || {}).text || '').trim();
        if (cur && !/^<?none>?$|Claim-level/i.test(cur)) continue;
        // Prefer exposure (1): the receipt screen lists reserve lines (1) first, so reserve and receipt share a line
        // (an open recovery reserve left behind would need zeroing at close — DMTV0039 same-day).
        const real = [...sel.options].filter(o => o.text.trim() && !/^<?none>?$|Claim-level/i.test(o.text.trim()));
        const opt = real.find(o => /^\(1\)/.test(o.text.trim())) || real[0];
        if (!opt) continue;
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        done.push(opt.text.trim());
      }
      return done;
    });
    if (!changed.length) break;
    console.log('recovery grid: set ' + changed.join(' | '));
    await page.waitForTimeout(2500);
  }
}

// CC refuses a Subrogation recovery reserve until subrogation is Open on the claim ("Subrogation must be Open on the
// claim before you can create a Subrogation Recovery Reserve", 2026-11-02). As on-prem (createRecoveryReserve), it opens
// through the workplan chain Subrogation Potential → Review Claim for Subrogation → Subrogation Referral; each activity
// opens in #gw-south-panel with its question as a <select> (e.g. name …-ExtSubroPotential = <none>/Yes/No) + Update.
const SUBRO_CHAIN = ['Subrogation Potential', 'Review Claim for Subrogation', 'Subrogation Referral'];
async function openSubrogationCloud(page) {
  const done = new Set();
  for (let pass = 0; pass < SUBRO_CHAIN.length + 1; pass++) {
    const nav = page.locator('[role="menuitem"], .gw-action--inner').filter({ hasText: /^Workplan$/ }).first();
    await nav.click({ timeout: 5000 }).catch(() => nav.dispatchEvent('click'));
    await page.waitForTimeout(3000);
    const subject = SUBRO_CHAIN.find(s => !done.has(s));
    if (!subject) break;
    const link = page.locator('tr[role="row"]').filter({ hasText: subject }).getByText(subject, { exact: true }).first();
    if (!(await link.count())) { done.add(subject); console.log(`subrogation: no "${subject}" activity`); continue; }
    await link.click();
    await page.waitForTimeout(3000);
    // Two rounds: Subro Adjuster only lists once Subro Office is chosen.
    let set = [];
    for (let round = 0; round < 2; round++) {
    set = set.concat(await page.evaluate(() => {
      const out = [];
      for (const sel of document.querySelectorAll('#gw-south-panel select')) {
        if (!sel.offsetParent || sel.disabled || !/Subro|Refer|SIU|Office|Adjuster/i.test(sel.name)) continue;
        const cur = ((sel.options[sel.selectedIndex] || {}).text || '').trim();
        if (cur && !/^<?none>?$/i.test(cur)) continue;
        const real = [...sel.options].filter(o => o.text.trim() && !/^<?none>?$/i.test(o.text.trim()));
        const opt = real.find(o => /^Yes$/i.test(o.text.trim())) || real[0];
        if (!opt) continue;
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        out.push(sel.name.replace(/^.*-/, '') + '=' + opt.text.trim());
      }
      return out;
    }));
      await page.waitForTimeout(2000);
    }
    // "SIU Recovery" is a required Yes/No radio on the Referral (2026-11-02); Yes, as the on-prem chain answers it.
    // A div[role=radio] (id …-ExtSIURecovery_0 = Yes); a DOM .click() didn't register, a real click does.
    const siuYes = page.locator('#gw-south-panel [id$="ExtSIURecovery_0"]').first();
    let siu = '';
    if (await siuYes.isVisible().catch(() => false) && (await siuYes.getAttribute('aria-checked')) !== 'true') {
      await siuYes.click();
      siu = 'Yes';
    }
    if (siu) set.push('SIU Recovery=' + siu);
    await page.waitForTimeout(1500);
    await page.locator('#gw-south-panel').getByRole('button', { name: 'Update', exact: true }).first().click();
    await page.waitForTimeout(3000);
    const refused = await page.evaluate(() => { const p = document.getElementById('gw-south-panel'); const t = p ? p.innerText : ''; return /Activity Detail/.test(t) && /Errors on current page/.test(t) ? t.split('Errors on current page:')[1].replace(/s+/g, ' ').slice(0, 200) : ''; });
    if (refused) throw new Error(`"${subject}" not updated: ${refused}`);
    console.log(`subrogation: "${subject}" → ${set.join(', ') || 'nothing to set'}`);
    done.add(subject);
  }
}

async function recoveryCloud(page, { recoveryType, amount }) {
  const step = async (what, fn) => { try { await fn(); } catch (e) { throw new Error(`cloud recovery — ${what}: ${e.message.split('\n')[0]}`); } };
  const save = () => page.getByRole('button', { name: /^(Save|Update|Finish)$/ }).first().click();
  const pick = async (label, value) => {
    const box = page.getByLabel(label, { exact: false }).first();
    await box.click();
    const opt = value ? page.getByRole('option', { name: value }) : page.getByRole('option').nth(1);
    await opt.first().click();
  };

  await step('open subrogation (workplan chain)', () => openSubrogationCloud(page));
  await step('open Recovery Reserve', async () => {
    await page.getByRole('button', { name: 'deferred Actions' }).click();
    await page.getByLabel(/^Recovery Reserve/).first().click();
  });
  // "Set Recovery Reserves" is a grid with one row already added (2026-11-02): Exposure (defaults to "none
  // (Claim-level)"), Cost Type, Cost Category, Recovery Reserve Category (already Subrogation), "$" amount. Its selects
  // carry no labels, so every empty one in the grid takes its first real option (Exposure: the first exposure).
  await step('fill recovery reserve', async () => {
    // The grid opens EMPTY; Add creates the row (the earlier screenshot showed it after an Add).
    if (!(await page.locator('[name*="EditableRecoveryReservesLV-0-"]').count())) {
      await page.getByRole('button', { name: 'Add', exact: true }).first().click();
      await page.waitForTimeout(3000);
    }
    await fillGridSelects(page);
    // The amount box, not the trailing Comments box (2026-11-02: 500 landed in Comments, the reserve saved at 0.00).
    await page.locator('[id*="LV-0-"] input[type="text"]:visible:not([name*="Comment" i])').last().fill(String(amount));
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await page.waitForTimeout(3000);
    const err = await page.evaluate(() => { const p = document.getElementById('gw-south-panel'); return p && /Set Recovery Reserves/.test(document.body.innerText.slice(0, 3000)) ? p.innerText.slice(0, 300) : ''; });
    if (err) throw new Error('not saved: ' + err.replace(/s+/g, ' '));
  });
  await step('recovery receipt', () => receiptCloud(page, { recoveryType, amount }));
  console.log(`Recovery (cloud): ${recoveryType} reserve + receipt $${amount}`);
}

// "Create Recovery" (2026-11-02): Payer select, Payer Check Number, Total Amount of Payment (masked once filled),
// "Are you reposting this recovery check…?" radio (No), Net Recovery (defaults No), then a Recoveries grid whose Add
// row is edited in a Details section BELOW the grid (reserve line, Recovery/Credit category, amount); Update saves.
// Separate from recoveryCloud so a receipt can be retried on a claim that already has today's recovery reserve
// (a second recovery reserve the same day is refused by DMTV0039).
async function receiptCloud(page, { recoveryType = 'Subrogation', amount = 500 } = {}) {
  await page.getByRole('button', { name: 'deferred Actions' }).click();
  await page.getByLabel(/^Recovery.Credit/).first().click();
  const payer = page.locator('select[name$="RecoveryDetailExtDV-Payer"]').first();
  await payer.waitFor({ state: 'visible', timeout: 15000 });
  const payerOpt = await payer.locator('option').evaluateAll(os => (os.find(o => o.value && !/^<?none>?$/i.test(o.text.trim())) || {}).value);
  await payer.selectOption(payerOpt);
  await page.waitForTimeout(1500);
  await page.locator('input[name$="RecoveryDetailExtDV-checkNumber"]').first().fill(String(Date.now()).slice(-8));
  await page.getByRole('textbox', { name: /^Total Amount of (Payment|Check)$/ }).first().fill(String(amount));
  await page.locator('.gw-InputWidget').filter({ hasText: /reposting this recovery check/i }).getByRole('radio', { name: 'No' }).first().click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await page.waitForTimeout(2500);
  // Details section selects: every empty one takes its first real option, but never "Expense recovery" for the
  // category (the on-prem receipt avoids it too) — prefer the recovery type itself. Rounds: picking the reserve line
  // fills the category list.
  for (let round = 0; round < 4; round++) {
    const set = await page.evaluate((want) => {
      const out = [];
      for (const sel of document.querySelectorAll('select')) {
        if (!sel.offsetParent || sel.disabled || sel.closest('#gw-south-panel') || /Payer$/.test(sel.name)) continue;
        const cur = ((sel.options[sel.selectedIndex] || {}).text || '').trim();
        if (cur && !/^<?none>?$/i.test(cur)) continue;
        const real = [...sel.options].filter(o => o.text.trim() && !/^<?none>?$/i.test(o.text.trim()) && !/expense recovery/i.test(o.text));
        const opt = real.find(o => o.text.trim().toLowerCase() === want.toLowerCase()) || real[0];
        if (!opt) continue;
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        out.push(sel.name.replace(/^.*-/, '') + '=' + opt.text.trim());
      }
      return out;
    }, recoveryType);
    if (!set.length) break;
    console.log('recovery receipt: set ' + set.join(' | '));
    await page.waitForTimeout(2500);
  }
  // The row's Amount (Details section); Total Amount of Payment above is masked and not a match for this exact label.
  const amt = page.getByRole('textbox', { name: 'Amount', exact: true }).first();
  await (await amt.isVisible().catch(() => false) ? amt : page.locator('input[name$="Amount"]:visible').last()).fill(String(amount));
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Update', exact: true }).first().click();
  await page.waitForTimeout(3500);
  const err = await page.evaluate(() => /Create Recovery/.test(document.body.innerText.slice(0, 3000)) ? ((document.body.innerText.split('Errors on current page:')[1] || 'still on Create Recovery').replace(/\s+/g, ' ').slice(0, 300)) : '');
  if (err) throw new Error('receipt not saved: ' + err);
  return 'saved';
}

// ── Cloud "Ability to pay" validate + repair ─────────────────────────────────────────────────────────────────────
// Until a claim passes Ability to pay, no payee gets a Reserve Line in the payment wizard. The on-prem validator
// (claimLifecycleHelper.validateClaimAndExposures) reads ExtJS menus and silently skipped on cloud. Errors seen on a
// fresh cloud CA FNOL (2026-11-02, CA-PA-01-26-0748712), each with its repair:
//   (n) 1st Party Vehicle: "Serial number / Boat type must be present" — FNOL made a new "Automated E2E" vehicle
//       incident; point the exposure at the policy vehicle instead (it has a VIN and isn't a boat).
//   (n) ... Bodily Injury - NAME: "Detailed body part must not be null" — new injury incident with a body part (OneInc
//       setupE.ensureInjuryIncident, forced).
//   Contacts: "claimant's primary address must have a street, city and state" — give each exposure claimant an address
//       (OneInc setupE.changeContactAddress).
async function validateCloud(page) {
  await page.getByRole('button', { name: 'deferred Actions' }).click();
  await page.waitForTimeout(800);
  const v = page.locator('[id$="ClaimMenuActions_ClaimExposureValidation"]').first();
  await v.hover().catch(() => {});
  await page.waitForTimeout(800);
  const atp = v.locator('[role="menuitem"]').filter({ hasText: 'Ability to pay' }).first();
  await atp.click({ timeout: 3000 }).catch(() => atp.dispatchEvent('click'));
  await page.waitForTimeout(5000);
  // Groups: "Errors located on another page: <where>" followed by its messages; messages before any header are this page's.
  return page.evaluate(() => {
    const p = document.getElementById('gw-south-panel');
    const lines = p ? p.innerText.split('\n').map(s => s.trim()).filter(Boolean) : [];
    const out = [];
    let where = '';
    for (const l of lines) {
      const m = l.match(/^Errors located on another page:\s*(.+)$/);
      if (m) { where = m[1]; continue; }
      if (/^(Validation Results|Clear|Click here to navigate)/.test(l)) continue;
      out.push({ where, text: l });
    }
    return out;
  });
}

async function repairCloud(page, claimNumber) {
  const B = require('./claimCenterBase');
  const A = require('./oneInc/setupA');
  const E = require('./oneInc/setupE');
  await B.openExistingClaim(page, claimNumber); // after FNOL the page isn't on the claim (no Actions button)
  let errs = await validateCloud(page);
  if (!errs.length) { console.log('Ability to pay: claim is clean'); return; }
  console.log('Ability to pay errors:\n  ' + errs.map(e => `${e.where || 'this page'}: ${e.text}`).join('\n  '));
  const expIndex = (where) => { const m = where.match(/^\((\d+)\)/); return m ? Number(m[1]) - 1 : -1; };
  const nameOf = (where) => (where.match(/ - ([^-]+)$/) || [])[1] || '';
  const tryFix = async (what, fn) => {
    try { console.log(`repair: ${what} — ${(await fn()) || 'done'}`); }
    catch (e) { console.log(`repair: ${what} FAILED — ${e.message.split('\n')[0]}`); }
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click({ timeout: 1500 }).catch(() => {});
    await B.openExistingClaim(page, claimNumber);
  };

  // Every exposure with a vehicle error, or messages on the vehicle page itself (where === \'\').
  const vehicleWheres = [...new Set(errs.filter(e => /serial number|boat type|vehicle/i.test(e.text)).map(e => e.where))];
  for (const where of vehicleWheres) {
    const i = expIndex(where);
    if (i < 0) continue;
    await tryFix(`vehicle on ${where}`, async () => {
      await A.openExposure(page, i);
      await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
      await page.waitForTimeout(2500);
      const sel = page.getByLabel('Vehicle', { exact: true }).first();
      const opt = await sel.locator('option').evaluateAll(os => (os.find(o => /VIN/i.test(o.text) && !/Automated E2E/i.test(o.text)) || {}).text);
      if (!opt) throw new Error('no policy vehicle (with a VIN) in the Vehicle list');
      await sel.selectOption({ label: opt });
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: 'Update', exact: true }).first().click();
      await page.waitForTimeout(3000);
      return `vehicle → ${opt}`;
    });
  }
  for (const e of errs.filter(x => /body part/i.test(x.text))) {
    const i = expIndex(e.where);
    if (i < 0) continue;
    await tryFix(`injury incident on ${e.where}`, () => E.ensureInjuryIncident(page, i, { force: true, injured: nameOf(e.where) }));
  }
  if (errs.some(x => /primary address/i.test(x.text))) {
    // The message doesn't name the contact: fix every exposure claimant (the insured is PolicyCenter-owned and refused).
    const names = [...new Set(errs.map(x => nameOf(x.where)).filter(Boolean))];
    for (const n of names) await tryFix(`address of ${n}`, () => E.changeContactAddress(page, n, 'B'));
  }
  errs = await validateCloud(page);
  console.log(errs.length ? 'Ability to pay STILL failing:\n  ' + errs.map(e => `${e.where || 'this page'}: ${e.text}`).join('\n  ')
                          : 'Ability to pay: claim is clean after repair');
}

// Close: drain every reserve line with a Final Payment (payments aren't limited by the same-day rules VTDMPL61/DMTV0039/
// DMEC0002, zeroing is), approve each, sweep activities, close every exposure by coverage, then the claim.
async function close(page, claimNumber) {
  const L = require('./claimLifecycleHelper');
  await L.drainAndCloseAllExposures(page, claimNumber);
  await L.closeClaim(page, { closeReason: 'Covered - Settled' });
  await L.assertClaimStatus(page, 'Closed');
}

// No policy typed in the Runner (CC_E2E_POLICY_FROM_POOL=1): pick a random claim of this LOB (PA state, matching the
// POLICY_*_PA vars the specs read) from the team's claim inventory spreadsheet — the same one OneInc and SmartCOMM use
// (helpers/smartComm/testDataService) — reuse its policy and file the loss 2 days after its loss date (capped at
// yesterday), so the date is inside that policy's term. Spreadsheet unreadable → getNextPolicy's .env rotation.
const PREFIX = { PA: 'PA-PA-', HO: 'HO-PA-', WC: 'WC-PA-', CA: 'CA-PA-', BOP: 'BOP-PA-', CP: 'CPP-PA-' };
function fmt(d) { return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear(); }
function pickFromInventory(lob, records, rand = Math.random) {
  const prefix = PREFIX[lob];
  if (!prefix) return null;
  records = records || require('./smartComm/testDataService').getAllRecords();
  const rows = records.filter(r => String(r.claimNumber || '').startsWith(prefix) && r.policyNumber && !isNaN(new Date(r.lossDate)));
  if (!rows.length) return null;
  // Prefer losses from the last 12 months (old dates are in-term but can trip late-reporting rules).
  const yearAgo = Date.now() - 365 * 864e5;
  const recent = rows.filter(r => new Date(r.lossDate).getTime() >= yearAgo);
  if (recent.length) rows.splice(0, rows.length, ...recent);
  const r = rows[Math.floor(rand() * rows.length)];
  const loss = new Date(r.lossDate); loss.setDate(loss.getDate() + 2);
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  return { policy: String(r.policyNumber), lossDate: fmt(loss > yesterday ? yesterday : loss), basedOn: `${r.claimNumber} (DoL ${r.lossDate})` };
}
if (process.env.CC_E2E_POLICY_FROM_POOL === '1' && process.env.CC_E2E_LOB && process.env.CC_E2E_POLICY_VAR && !existingClaim()) {
  try {
    const p = pickFromInventory(process.env.CC_E2E_LOB);
    if (p) {
      const v = process.env.CC_E2E_POLICY_VAR;
      process.env[v] = process.env[`${v}_TEST`] = process.env[`${v}_DEV`] = p.policy;
      process.env.TEST_LOSS_DATE = p.lossDate;
      console.log(`Policy from claim inventory: ${p.policy}, loss date ${p.lossDate} (based on ${p.basedOn})`);
    } else console.log(`No ${process.env.CC_E2E_LOB} claim in the inventory — using the .env policy list`);
  } catch (e) { console.log('Claim inventory not readable (' + e.message.split('\n')[0] + ') — using the .env policy list'); }
}

module.exports = { IS_CLOUD, ALL, steps, on, existingClaim, stepOf, gate, recovery, close, pickFromInventory, receiptCloud };
