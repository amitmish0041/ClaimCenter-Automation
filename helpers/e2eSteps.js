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

// ── Team logins (user list 2026-11-02; IDs = first 4 of first name + first 4 of last name, NOT yet confirmed) ──────
// Off unless CC_E2E_TEAM_LOGINS=1 and CC_TEAM_PASS is set (the shared TEST password — environment only, never a file).
// When on: the payment step runs as the LOB team's claim rep, the recovery step as the Subrogation/Recovery rep, and
// the approval step as whoever the approval activity is assigned to. Off: standard user + admin (su), as before.
const TEAMS = {
  'Claims':               { rep: ['kaylmart'] },
  'Auto Medical':         { manager: 'maryfloh', supervisor: 'julikron', rep: ['andrbish', 'devilefe'] },
  'Property':             { manager: 'krisdiet', supervisor: 'dougreid', rep: ['mikekrau', 'katidimi'] },
  'BI/GLPD':              { manager: 'samaclar', supervisor: 'jamicole', rep: ['janehann', 'megaschi'] },
  'Subrogation/Recovery': { manager: 'benjsmit', supervisor: 'angichev', rep: ['alliwagn', 'joefart'] },
  'Reinsurance':          { rep: ['chrinoon'] },
  'Workers Comp':         { manager: 'vernande', supervisor: 'lorrkier', rep: ['debbobri', 'chenhill'] },
  'Motor Vehicle':        { manager: 'seanhann', supervisor: 'mikechad', rep: ['marymeal', 'triclaug'] },
  'Auto':                 { manager: 'daryfili', supervisor: 'mallbuoh', rep: ['stepvarg', 'natastri'] },
};
const LOB_TEAM = { CA: 'Auto', PA: 'Auto', BOP: 'Property', CP: 'Property', HO: 'Property', WC: 'Workers Comp' };
const lobOfClaim = (claim) => ({ CA: 'CA', PA: 'PA', HO: 'HO', WC: 'WC', BOP: 'BOP', CPP: 'CP' })[String(claim || '').split('-')[0]] || null;
const teamLoginsOn = () => process.env.CC_E2E_TEAM_LOGINS === '1' && !!process.env.CC_TEAM_PASS;
// Real cloud TEST login IDs where the first4+last4 pattern is wrong (user, 2026-11-06): Mallory Redcay = mallbuoh,
// tomdavi = debbobri, chenrema = chenhill.
const LOGIN_ALIASES = { mallredc: 'mallbuoh', tomdavi: 'debbobri', chenrema: 'chenhill' };
const loginIdFor = (fullName) => { const [f, ...r] = String(fullName).toLowerCase().trim().split(/\s+/); const id = (f || '').replace(/[^a-z]/g, '').slice(0, 4) + r.join('').replace(/[^a-z]/g, '').slice(0, 4); return LOGIN_ALIASES[id] || id; };
function teamUserFor(step, claimNumber) {
  if (step === 'recovery') return TEAMS['Subrogation/Recovery'].rep[0];
  if (step === 'payment') { const t = TEAMS[LOB_TEAM[lobOfClaim(claimNumber)]]; return t ? t.rep[0] : null; }
  return null;
}
// The approval activity's "Assigned To" (not "Assigned By") is the approver (CONFIRMED 2026-10-22, OneInc).
async function approverFor(page) {
  const nav = page.locator('[role="menuitem"], .gw-action--inner').filter({ hasText: /^Workplan$/ }).first();
  await nav.click({ timeout: 5000 }).catch(() => nav.dispatchEvent('click'));
  await page.locator('tr[role="row"]').nth(1).waitFor({ timeout: 15000 }).catch(() => {});
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr[role="row"]')].filter(r => r.offsetParent);
    const head = rows.find(r => /\bAssigned To\b/.test(r.innerText));
    if (!head) return null;
    const cells = [...head.children].map(c => (c.innerText || '').trim());
    const subj = cells.findIndex(c => /^Subject$/.test(c)), to = cells.findIndex(c => /^Assigned To$/.test(c));
    const row = rows.find(r => r !== head && /\bOpen\b/.test(r.innerText) && /approv/i.test((r.children[subj] || {}).innerText || ''));
    return row ? ((row.children[to] || {}).innerText || '').replace(/\s+/g, ' ').trim() : null;
  });
}
async function loginTeamUser(page, username, claimNumber, why) {
  const B = require('./claimCenterBase');
  await B.loginToClaimCenter(page, { username, password: process.env.CC_TEAM_PASS });
  await B.openExistingClaim(page, claimNumber);
  console.log(`Team login: ${why} as ${username}`);
}

// ctx = { page, claimNumber } (read when the test starts). Cloud user switch, as the OneInc data step does: the standard
// user's reserves land "Submitted" and no payee then has a payable Reserve Line (confirmed 2026-11-02 on
// CA-PA-01-26-0748712), so reserves are made as the admin; the payment goes back to the standard user so it still
// routes to approval.
// "Cannot View Claim" (claim routed to a group the user can't see). Polls the visible page text for a few seconds —
// getByText(...).first() resolved to a hidden copy and never reported it (2026-11-03).
async function cannotView(page) {
  for (let i = 0; i < 6; i++) {
    const hit = await page.evaluate(() => /Cannot View Claim|do not have permission to view this claim/i.test(document.body.innerText.slice(0, 2000))).catch(() => false);
    if (hit) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

let cloudUser = 'standard';
let repaired = false;
let accessChecked = false;
let adminOnly = false;
async function gate(test, testInfo, ctx = {}) {
  const s = stepOf(testInfo.title);
  if (s === 'fnol') test.skip(!!existingClaim(), `existing claim ${existingClaim()} — FNOL not run`);
  else if (s) test.skip(!on(s), `step "${s}" not selected (CC_E2E_STEPS=${steps().join(',')})`);
  // Close on cloud is parked (user, 2026-11-02): closeCloud gets through drain + DMEC0002 but exposure activities can't
  // be completed by the automation yet. Shown as skipped, not failed.
  if (s === 'close' && IS_CLOUD) test.skip(true, 'close is not supported on cloud yet (exposure activities block Close Exposure)');
  if (!IS_CLOUD || !ctx.page || !ctx.claimNumber) return;
  // Existing claim the automation user can't open ("Cannot View Claim" — routed to another group): assign it to the
  // automation user as the admin, then carry on as before (2026-11-03, HO-PA-01-26-0748728).
  if (!accessChecked) {
    accessChecked = true;
    // Open it first: openExistingClaim logs "Opened" even when CC shows "Cannot View Claim".
    await require('./claimCenterBase').openExistingClaim(ctx.page, ctx.claimNumber).catch(() => {});
    if (await cannotView(ctx.page)) {
      const B = require('./claimCenterBase');
      const L = require('./claimLifecycleHelper');
      console.log(`Cloud: no permission to view ${ctx.claimNumber} — assigning it to Benjamin Smith as the admin`);
      await B.loginAsAdmin(ctx.page);
      await B.openExistingClaim(ctx.page, ctx.claimNumber);
      await L.assignClaim(ctx.page, 'Benjamin Smith').catch(e => console.log('assign failed — ' + e.message.split('\n')[0]));
      await B.loginToClaimCenter(ctx.page);
      await B.openExistingClaim(ctx.page, ctx.claimNumber);
      cloudUser = 'standard';
      // Assigning didn't always grant view (HO, 2026-11-03: still "Cannot View Claim" after assignment to Benjamin
      // Smith). Then run every step as the admin.
      if (await cannotView(ctx.page)) {
        console.log(`Cloud: still no permission on ${ctx.claimNumber} — all steps run as the admin`);
        await B.loginAsAdmin(ctx.page);
        await B.openExistingClaim(ctx.page, ctx.claimNumber);
        cloudUser = 'admin';
        adminOnly = true;
      }
    }
  }
  // Before the first money step, bring the claim to Ability to pay (else no payee has a payable Reserve Line).
  if (!repaired && ['reserve', 'payment', 'recovery'].includes(s) && on(s)) {
    repaired = true;
    await repairCloud(ctx.page, ctx.claimNumber);
  }
  if (teamLoginsOn() && on(s)) {
    let user = teamUserFor(s, ctx.claimNumber);
    if (s === 'approval') {
      const name = await approverFor(ctx.page).catch(() => null);
      user = name ? loginIdFor(name) : null;
      if (!name) console.log('Team login: no open approval activity — approval runs as the current user');
    }
    if (user && user !== cloudUser) {
      await loginTeamUser(ctx.page, user, ctx.claimNumber, `${s} step`);
      cloudUser = user;
      return;
    }
  }
  // close: its Final Payments as the admin (the standard user's would wait for an approver — on-prem the admin bypasses).
  const want = s === 'reserve' || s === 'close' ? 'admin' : s === 'payment' ? 'standard' : null;
  if (!want || want === cloudUser || adminOnly) return;
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
async function recovery(page, lob, amount = 500, { skipSubro = false } = {}) {
  const F = require('./financialsHelper');
  const recoveryType = RECOVERY_TYPE[lob] || 'Subrogation';
  if (IS_CLOUD) return recoveryCloud(page, { recoveryType, amount, skipSubro });
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

async function recoveryCloud(page, { recoveryType, amount, skipSubro = false }) {
  const step = async (what, fn) => { try { await fn(); } catch (e) { throw new Error(`cloud recovery — ${what}: ${e.message.split('\n')[0]}`); } };
  const save = () => page.getByRole('button', { name: /^(Save|Update|Finish)$/ }).first().click();
  const pick = async (label, value) => {
    const box = page.getByLabel(label, { exact: false }).first();
    await box.click();
    const opt = value ? page.getByRole('option', { name: value }) : page.getByRole('option').nth(1);
    await opt.first().click();
  };

  // skipSubro: the caller already answered the chain as the activities' assignee (they stay Open after Update, and a
  // non-assignee only gets Cancel on them — stepvarg, 2026-11-05).
  if (!skipSubro) await step('open subrogation (workplan chain)', () => openSubrogationCloud(page));
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
    const readErr = () => page.evaluate(() => { const p = document.getElementById('gw-south-panel'); return p && /Set Recovery Reserves/.test(document.body.innerText.slice(0, 3000)) ? p.innerText.replace(/\s+/g, ' ').slice(0, 400) : ''; });
    let err = await readErr();
    // Warnings only (e.g. the aggregate-limit warning on BOP, 2026-11-03): CC saves on a second Save. Errors still block.
    if (err && /Warnings?:/i.test(err) && !/Errors?( on current page| located)?:/i.test(err)) {
      console.log('recovery reserve: warning only — saving again');
      await page.getByRole('button', { name: 'Save', exact: true }).first().click();
      await page.waitForTimeout(3000);
      err = await readErr();
    }
    if (err) throw new Error('not saved: ' + err);
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
  // Warnings only (aggregate limit, BOP 2026-11-03): a second Update saves it.
  const south = await page.evaluate(() => { const p = document.getElementById('gw-south-panel'); return /Create Recovery/.test(document.body.innerText.slice(0, 3000)) && p && p.offsetParent ? p.innerText.replace(/\s+/g, ' ') : ''; });
  if (south && /Warnings?:/i.test(south) && !/Errors?( on current page| located)?:/i.test(south)) {
    console.log('recovery receipt: warning only — updating again');
    await page.getByRole('button', { name: 'Update', exact: true }).first().click();
    await page.waitForTimeout(3500);
  }
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
      if (/^(Validation Results|Clear|Click here to navigate|Information:?$|No validation errors)/.test(l)) continue;
      out.push({ where, text: l });
    }
    return out;
  });
}

async function ensureClaimDocument(page, claimNumber) {
  const K = require('./oneInc/recipes/workerK');
  const rows = await K.documentRows(page).catch(() => []);
  if (!rows.some(t => t.toLowerCase().includes(K.DOC_NAME.toLowerCase()))) {
    await K.addDocument(page).then(() => console.log('claim document added (for checks over $1,000)'))
      .catch(e => console.log('claim document not added — ' + e.message.split('\n')[0]));
  }
  await require('./claimCenterBase').openExistingClaim(page, claimNumber);
}

// Personal auto: New Payment answers "New Payment Error — Please complete the Surcharging screen" (2026-11-03,
// PA-PA-01-26-0748726) until every Surcharging question is answered. Cloud version of financialsHelper's on-prem
// ensureSurchargingComplete: Surcharging › Edit › unanswered Yes/No → No › Update. No Surcharging page = nothing to do.
async function ensureSurchargingCloud(page, claimNumber) {
  // A menu GROUP (id …Claim_ClaimSurchargingGroup) with a "…ClaimSurchargingDetails" child (2026-11-03).
  const nav = page.locator('[id="Claim-MenuLinks-Claim_ClaimSurchargingGroup"] [role="menuitem"]').first();
  if (!(await nav.count())) return;
  await nav.click({ timeout: 5000 }).catch(() => nav.dispatchEvent('click'));
  await page.waitForTimeout(2500);
  const details = page.locator('[id$="ClaimSurchargingGroup_ClaimSurchargingDetails"] [role="menuitem"]').first();
  if (await details.isVisible().catch(() => false)) { await details.click().catch(() => {}); await page.waitForTimeout(2500); }
  const edit = page.getByRole('button', { name: 'Edit', exact: true }).first();
  if (!(await edit.isVisible().catch(() => false))) { await require('./claimCenterBase').openExistingClaim(page, claimNumber); return; }
  await edit.click();
  await page.waitForTimeout(2500);
  const answered = await page.evaluate(() => {
    let n = 0;
    for (const g of document.querySelectorAll('[role="radiogroup"]')) {
      if (!g.offsetParent || g.querySelector('[role="radio"][aria-checked="true"]')) continue;
      const no = [...g.querySelectorAll('[role="radio"]')].find(r => /^No$/i.test((r.getAttribute('aria-label') || '').trim()));
      if (no) { no.click(); n++; }
    }
    return n;
  });
  // Real clicks for any group the DOM click didn't register on.
  for (const r of await page.locator('[role="radiogroup"]:visible').all()) {
    if (await r.locator('[role="radio"][aria-checked="true"]').count()) continue;
    await r.getByRole('radio', { name: 'No' }).first().click().catch(() => {});
  }
  await require('./fnolHelper').fillRequiredAcrossTabsCloud(page).catch(() => {});
  await page.getByRole('button', { name: 'Update', exact: true }).first().click();
  await page.waitForTimeout(3000);
  console.log(`Surcharging: ${answered} question(s) answered No, updated`);
  await require('./claimCenterBase').openExistingClaim(page, claimNumber);
}

async function repairCloud(page, claimNumber) {
  const B = require('./claimCenterBase');
  const A = require('./oneInc/setupA');
  const E = require('./oneInc/setupE');
  await B.openExistingClaim(page, claimNumber); // after FNOL the page isn't on the claim (no Actions button)
  let errs = await validateCloud(page);
  // Payments over $1,000 need a linked claim document (VBR.010) — put OneInc's supporting document on every claim before
  // the money steps (CP's $8,000 partial was refused at Finish without one, 2026-11-03).
  await ensureClaimDocument(page, claimNumber);
  await ensureSurchargingCloud(page, claimNumber);
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
      // The vehicle INCIDENT is the problem: Style "Boat" (reused "Automated E2E" vehicle) and no Serial Number
      // (2026-11-03, PA-PA-01-26-0748726). Swapping the exposure's vehicle didn't clear it. Vehicle_Incident menu ›
      // "Edit Incident Details..." › Style = Other, Serial Number = a VIN › OK › Update.
      await page.locator('[id$="Vehicle_Incident-Vehicle_IncidentMenuIcon"]').first().click({ force: true });
      await page.waitForTimeout(1200);
      await page.getByText('Edit Incident Details...', { exact: true }).last().click();
      await page.waitForTimeout(3500);
      // Real Playwright calls: a dispatched change event on the Style select was logged but did not stick (2026-11-03).
      const set = [];
      const style = page.getByLabel('Style', { exact: true }).first();
      if (await style.isVisible().catch(() => false)) {
        const cur = await style.evaluate(s => (s.selectedOptions[0] || {}).text || '').catch(() => '');
        if (!/^Other$/i.test(cur.trim())) { await style.selectOption({ label: 'Other' }); set.push(`Style ${cur} → Other`); await page.waitForTimeout(2500); }
      }
      for (const lbl of ['Serial Number', 'VIN']) {
        const box = page.getByLabel(lbl, { exact: true }).first();
        if (await box.isVisible().catch(() => false) && !(await box.inputValue().catch(() => 'x'))) { await box.fill('1HGCM82633A004352'); set.push(lbl); }
      }
      await page.getByRole('button', { name: 'OK', exact: true }).first().click();
      await page.waitForTimeout(3000);
      // Update validates the exposure's other tabs too — Appraisal: "Primary Point of Impact", "Is Vehicle Drivable?",
      // "Airbags Deployed?" (2026-11-03, PA-PA-01-26-0748726) — so fill required fields on every tab first.
      const fnol = require('./fnolHelper');
      await fnol.fillRequiredAcrossTabsCloud(page).catch(() => {});
      await fnol.answerCloudRadioGroups(page).catch(() => {});
      await page.getByRole('button', { name: 'Update', exact: true }).first().click();
      await page.waitForTimeout(3500);
      const missing = () => page.evaluate(() => /Errors (located|on current page)/.test(document.body.innerText) && /\bUpdate\b/.test(document.body.innerText.slice(0, 3000))
        ? [...new Set((document.body.innerText.match(/Missing required field "([^"]+)"/g) || []).map(m => m.replace(/^.*"([^"]+)"$/, '$1')))] : []);
      // Anything still missing (e.g. "Location", 2026-11-03): fill it by label on whichever tab shows it, then retry.
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = await missing();
        if (!left.length) break;
        for (const tab of ['Details', 'Rental', 'Appraisal']) {
          await page.getByRole('tab', { name: tab, exact: true }).first().click().catch(() => page.getByText(tab, { exact: true }).first().click().catch(() => {}));
          await page.waitForTimeout(1500);
          await page.evaluate((labels) => {
            for (const w of document.querySelectorAll('.gw-InputWidget')) {
              if (!w.offsetParent) continue;
              const lbl = ((w.querySelector('.gw-label') || {}).textContent || '').trim();
              if (!labels.includes(lbl)) continue;
              const sel = w.querySelector('select');
              if (sel) {
                const o = [...sel.options].find(x => x.value && !/^<?none>?$/i.test(x.text.trim()));
                if (o) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
                continue;
              }
              const inp = w.querySelector('input[type="text"], textarea');
              if (inp && !inp.value) { inp.value = 'Automated E2E'; inp.dispatchEvent(new Event('change', { bubbles: true })); }
            }
          }, left);
          await page.waitForTimeout(1500);
        }
        await page.getByRole('button', { name: 'Update', exact: true }).first().click();
        await page.waitForTimeout(3500);
      }
      const refused = (await missing()).join(', ');
      if (refused) throw new Error('exposure Update refused: missing ' + refused);
      return `vehicle incident: ${set.join(', ') || 'nothing to change'}`;
    });
  }
  for (const e of errs.filter(x => /body part/i.test(x.text))) {
    const i = expIndex(e.where);
    if (i < 0) continue;
    await tryFix(`injury incident on ${e.where}`, () => E.ensureInjuryIncident(page, i, { force: true, injured: nameOf(e.where) }));
  }
  if (errs.some(x => /primary address/i.test(x.text))) {
    // The message doesn't name the contact: fix every exposure claimant (the insured is PolicyCenter-owned and refused).
    // "Contacts" groups name nobody (WC, 2026-11-03), so also take every exposure claimant.
    const F = require('./financialsHelper');
    await F.openExposuresTabCloud(page).catch(() => {});
    const claimants = await F.getAllExposureClaimantsCloud(page).catch(() => []);
    await B.openExistingClaim(page, claimNumber);
    const names = [...new Set(errs.map(x => nameOf(x.where)).concat(claimants).map(n => String(n || '').trim()).filter(Boolean))];
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
  // Final payments are usually over $1,000, and cloud checks over $1,000 need a linked document (VBR.010) — put
  // OneInc's supporting document on the claim first; createPaymentCloud links it on step 3 when CC asks.
  if (IS_CLOUD) {
    const K = require('./oneInc/recipes/workerK');
    const rows = await K.documentRows(page).catch(() => []);
    if (!rows.some(t => t.toLowerCase().includes(K.DOC_NAME.toLowerCase()))) {
      await K.addDocument(page).then(() => console.log('close: supporting document added')).catch(e => console.log('close: add document failed — ' + e.message));
    }
    await require('./claimCenterBase').openExistingClaim(page, claimNumber);
    return closeCloud(page, claimNumber);
  }
  await L.drainAndCloseAllExposures(page, claimNumber);
  await L.closeClaim(page, { closeReason: 'Covered - Settled' });
  await L.assertClaimStatus(page, 'Closed');
}

// Cloud close (2026-11-02, CA-PA-01-26-0748721). The on-prem pieces of drainAndCloseAllExposures read ExtJS grids and
// silently find "no Open exposures" on cloud, so:
//  1. drain: Final Payment per reserve line until none is payable. The cloud reserve reader can report a PAID amount
//     as remaining, so "no payee has a reserve line" (nothing payable) counts as drained, not as a failure.
//  2. each exposure: Close Exposure › Note + Outcome (settled/complete-like, else first) › Close Exposure.
//  3. Actions › Close Claim › Note + Outcome "Payments Complete" › Close Claim; the header must read St: Closed.
async function closeCloud(page, claimNumber) {
  const B = require('./claimCenterBase');
  const F = require('./financialsHelper');
  const A = require('./oneInc/setupA');
  for (let round = 0; round < 6; round++) {
    let line = null;
    try { line = await F.findFirstPositiveReserveLine(page); } catch (_) {}
    if (!line || !(line.amount > 0)) break;
    try {
      await F.createPayment(page, { paymentAmount: line.amount, reserveLine: line.firstCell, transactionType: 'Final Payment', payeeHint: line.rowText });
      console.log(`close: Final Payment $${line.amount} on ${line.firstCell}`);
    } catch (e) {
      if (!/no payee on this claim has a reserve line/i.test(e.message)) throw e;
      // OneInc's cancelWizard answers the native confirm; a plain Cancel click left the wizard open and the exposure
      // reads after it found 0 exposures (2026-11-02).
      await require('./oneInc/wizardDriver').cancelWizard(page).catch(() => {});
      console.log('close: no reserve line left to pay — drained');
      break;
    }
    await B.openExistingClaim(page, claimNumber);
  }
  await B.openExistingClaim(page, claimNumber);
  await completeActivitiesCloud(page);
  await B.openExistingClaim(page, claimNumber);
  const closeScreen = async (button, outcomeRe) => {
    await page.locator('textarea[name$="Note"], textarea').first().fill('Automated E2E close').catch(() => {});
    const sel = page.locator('select[name$="Outcome"]').first();
    const opt = await sel.locator('option').evaluateAll((os, re) => {
      const real = os.filter(o => o.value && !/^<?none>?$/i.test(o.text.trim()));
      return (real.find(o => new RegExp(re, 'i').test(o.text)) || real[0] || {}).value;
    }, outcomeRe);
    if (opt) await sel.selectOption(opt);
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: button, exact: true }).first().click();
    await page.waitForTimeout(3500);
    // DMEC0002 (warning): "open reserve of $X … If you want to set this reserve to $0 please click Close Exposure
    // again" — accept it (the reserve is zeroed as part of the close).
    if (await page.getByText(/DMEC0002/).first().isVisible().catch(() => false)) {
      console.log(`close: DMEC0002 — clicking ${button} again to zero the open reserve`);
      await page.getByRole('button', { name: button, exact: true }).first().click();
      await page.waitForTimeout(3500);
    }
    // Refusals show as "Errors on current page" OR as "Errors located on another page" groups in the south panel.
    const err = await page.evaluate((b) => {
      if (!new RegExp(b).test(document.body.innerText.slice(0, 2500))) return '';
      const p = document.getElementById('gw-south-panel');
      const t = (p && p.offsetParent ? p.innerText : '') + ' ' + (document.body.innerText.split('Errors on current page:')[1] || '').slice(0, 400);
      return /Errors/.test(t) ? t.replace(/\s+/g, ' ').slice(0, 700) : '';
    }, button);
    if (err) throw new Error(`${button} refused: ${err}`);
  };
  const n = await A.exposureCount(page).catch(() => 0);
  for (let i = 0; i < n; i++) {
    await A.openExposure(page, i);
    const btn = page.getByRole('button', { name: 'Close Exposure', exact: true }).first();
    if (!(await btn.isVisible().catch(() => false))) { console.log(`close: exposure ${i + 1} has no Close Exposure (already closed?)`); continue; }
    await btn.click();
    await page.waitForTimeout(2500);
    await closeScreen('Close Exposure', 'Payments Complete|Settle|Complete|Paid');
    console.log(`close: exposure ${i + 1} closed`);
    await B.openExistingClaim(page, claimNumber);
  }
  await page.getByRole('button', { name: 'deferred Actions' }).click();
  await page.waitForTimeout(800);
  await page.getByLabel(/^Close Claim/).first().click();
  await page.waitForTimeout(2500);
  await closeScreen('Close Claim', 'Payments Complete|Completed');
  const status = await page.evaluate(() => (document.body.innerText.match(/St:\s*(\w+)/) || [])[1] || '');
  if (!/Closed/i.test(status)) throw new Error(`claim status after Close Claim is "${status}", not Closed`);
  console.log('close: claim Closed');
}

// Cloud Workplan sweep: select every open activity (header checkbox) › Complete; repeat while the count drops.
// The on-prem completeAllWorkplanActivities reads ExtJS rows and does nothing on cloud, and open exposure activities
// block Close Exposure ("There are open activities related to this exposure", 2026-11-02).
async function completeActivitiesCloud(page) {
  // The bulk Complete stays disabled once the selection holds anything not completable (2026-11-02), so each open
  // activity is opened (its subject link → detail in #gw-south-panel) and completed from its own Complete button.
  const openWorkplan = async () => {
    const nav = page.locator('[role="menuitem"], .gw-action--inner').filter({ hasText: /^Workplan$/ }).first();
    await nav.click({ timeout: 5000 }).catch(() => nav.dispatchEvent('click'));
    await page.locator('tr[role="row"]').nth(1).waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return page.evaluate(() => {
      const rows = [...document.querySelectorAll('tr[role="row"]')].filter(r => r.offsetParent);
      const head = rows.find(r => /\bSubject\b/.test(r.innerText));
      if (!head) return [];
      const idx = [...head.children].findIndex(c => /^\s*Subject\s*$/.test(c.innerText || ''));
      return rows.filter(r => r !== head && /\bOpen\b/.test(r.innerText))
        .map(r => ((r.children[idx] || {}).innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    });
  };
  const skipped = new Set();
  let done = 0;
  for (let guard = 0; guard < 40; guard++) {
    const subjects = (await openWorkplan()).filter(s => !skipped.has(s));
    if (!subjects.length) break;
    const subject = subjects[0];
    // hasText matches textContent, where cells run together ("NormalOpen7 Day…") so /\bOpen\b/ matched no row and no
    // activity was ever opened (2026-11-10). Match a cell whose whole text is "Open".
    await page.locator('tr[role="row"]').filter({ has: page.locator('td', { hasText: /^\s*Open\s*$/ }) })
      .getByText(subject, { exact: true }).first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const btn = page.locator('#gw-south-panel').getByRole('button', { name: 'Complete', exact: true }).first();
    // At the default 1280x720 viewport the south panel's Complete sits below the fold, so isVisible() was false and
    // every activity was skipped (PA-PA-01-26-0749160, 2026-11-10; fine at 1600x1000). Wait for it and scroll to it.
    await btn.waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    if (!(await btn.count()) || (await btn.getAttribute('aria-disabled').catch(() => 'true')) === 'true') { skipped.add(subject); continue; }
    await btn.click({ timeout: 5000 }).catch(() => btn.dispatchEvent('click').catch(() => {}));
    await page.waitForTimeout(3000);
    // Activities with required questions ("Was contact able to be made?", "Subro Potential?") stay open with a
    // validation message: answer the required empties (wizardDriver's generic filler) and press Complete again.
    if (await btn.count().catch(() => 0)) { // still on the activity (count, not isVisible: below the fold at 1280x720)
      const W = require('./oneInc/wizardDriver');
      for (let r = 0; r < 2; r++) if (!(await W.fillRequiredEmpties(page).catch(() => [])).length) break;
      // Yes/No radio questions aren't covered by the filler. "Was contact able to be made?" → Yes; anything else → No
      // ("Create a copy of this activity?" = Yes adds a required copy due date, 2026-11-10).
      const groups = page.locator('#gw-south-panel [role="radiogroup"]');
      for (let g = 0; g < await groups.count(); g++) {
        const grp = groups.nth(g);
        if (await grp.locator('[role="radio"][aria-checked="true"], input[type="radio"]:checked').count()) continue;
        const label = await grp.evaluate((el) => {
          const id = el.getAttribute('aria-labelledby');
          return ((id && document.getElementById(id)) || {}).textContent || '';
        }).catch(() => '');
        // "Are you closing this claim?" = No re-creates the Status Update Letter (recurring); this sweep runs to close.
        const answer = /contact able to be made|closing this claim/i.test(label) ? 'Yes' : 'No';
        await grp.getByRole('radio', { name: new RegExp(`^${answer}$`, 'i') }).first().click({ timeout: 3000 }).catch(() => {});
      }
      await btn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    const still = (await openWorkplan()).includes(subject);
    if (still) skipped.add(subject); else done++;
  }
  console.log(`close: workplan — ${done} activit(ies) completed` + (skipped.size ? `; could not complete: ${[...skipped].join(', ')}` : ''));
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

module.exports = { IS_CLOUD, ALL, steps, on, existingClaim, stepOf, gate, recovery, close, pickFromInventory, receiptCloud, repairCloud, validateCloud, openSubrogationCloud, completeActivitiesCloud, TEAMS, LOB_TEAM, loginIdFor, teamUserFor, cannotView };
