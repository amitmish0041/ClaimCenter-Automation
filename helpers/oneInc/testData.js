/**
 * helpers/oneInc/testData.js
 * Declarative TEST DATA for OneInc claim profiles (user direction 2026-10-21: "identify everything needed for test data
 * and make sure it is attached to the claim creation step so preconditions are set before the cases start").
 *
 * A profile (claimPicker PROFILES / profiles/*.js) lists what its claims must carry:
 *     data: [D.vehicleExposure({ coverage: 'Medical Expense', cause: 'Medical Benefits', match: /Medical Expense/i }),
 *            D.injuryIncident({ exposure: /Medical/i }), D.reserve({ exposure: /Medical/i, amount: 1500 })]
 * Each item is { id, label, check(page) → '' | problem, build(page, claim) → note | null }:
 *   - claimCheck (prepare mode, i.e. scripts/provisionOneIncClaims.js) checks every item, builds the ones that fail,
 *     checks again and records the outcome per item on the pool entry (`data`); a claim is usable only when every item
 *     passes.
 *   - scenarioRunner checks the items once per claim per run before the first case on it, so a case never runs on a
 *     claim whose data drifted (reserve drained, contact removed…) — it is BLOCKED naming the missing item instead.
 *   - a recipe may add case-specific `needs` (same item shapes), checked before that case only.
 * An item with check = null cannot be read back from the UI; its build note at provisioning time is the record.
 * An item with build = null cannot be created by automation (manual data / a decision) — `manual` says what is needed.
 * scripts/oneIncDataRequirements.js turns all of this into the team-readable requirements sheet on V:.
 */
'use strict';
const W = require('./wizardDriver');
const { readScreen, findField } = require('./screenReader');

const F = () => require('./recipes/workerF');
const X = () => require('./reuseExt');
const E = () => require('./setupE');
const A = () => require('./setupA');
const G = () => require('./workerG');
const src = (re) => (re instanceof RegExp ? re.source : String(re));
const toRe = (v) => (v instanceof RegExp ? v : new RegExp(String(v), 'i'));

// ── Readers ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function contactsList(page) {
  await W.navigate(page, 'parties');
  await page.locator('tr[id*="LV-0-"]:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  return page.evaluate(() => [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr') && /PeopleInvolvedDetailedLV-\d+-/.test(r.innerHTML))
    .map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()));
}
// Exposure #i (0-based, Exposures list order) › read field `label` (view mode).
async function exposureField(page, i, label) {
  await A().openExposure(page, i);
  const f = findField(await readScreen(page), label);
  return f ? String(f.value || '').trim() : '';
}
async function exposureIndex(page, match) {
  const rows = await F().exposureRows(page);
  const k = rows.findIndex((r) => toRe(match).test(r.t));
  return { rows, k, i: k >= 0 ? rows[k].i : -1 };
}

// ── Item kinds ──────────────────────────────────────────────────────────────────────────────────────────────────
const D = {
  // A vehicle-level coverage exposure added through Actions › New Exposure › Choose by Coverage › <vehicle> ›
  // <coverage> [› leaf], with Cause of Loss `cause`, claimant = insured, a new injury incident (workerF.addMedExposure,
  // CONFIRMED 2026-10-21 on DE Medical Benefits / PA Medical Expense / DE PIP › Wage Loss Benefits).
  vehicleExposure: ({ coverage, leaf = null, cause, match }) => ({
    id: `exposure:${coverage}${leaf ? '>' + leaf : ''}`,
    label: `Exposure "${coverage}${leaf ? ' › ' + leaf : ''}" with Cause of Loss "${cause}"`,
    check: async (page) => {
      const { k, i, rows } = await exposureIndex(page, match);
      if (k < 0) return `no exposure matching /${src(match)}/ (exposures: ${rows.map((r) => r.t.slice(0, 50)).join(' | ') || 'none'})`;
      const col = await exposureField(page, i, 'Cause of Loss');
      return new RegExp(cause, 'i').test(col) ? '' : `exposure /${src(match)}/ has Cause of Loss "${col || '?'}", not "${cause}"`;
    },
    build: (page) => F().addMedExposure(page, { coverage, leaf, cause, existing: toRe(match) }),
  }),

  // Cause of Loss on an existing exposure (e.g. Comprehensive → "Fire" = LC01 for VBR.037 negatives).
  causeOfLoss: ({ exposure, cause }) => ({
    id: `causeOfLoss:${src(exposure)}=${cause}`,
    label: `Exposure /${src(exposure)}/ Cause of Loss = "${cause}"`,
    check: async (page) => {
      const { k, i } = await exposureIndex(page, exposure);
      if (k < 0) return `no exposure matching /${src(exposure)}/`;
      const col = await exposureField(page, i, 'Cause of Loss');
      return new RegExp(cause, 'i').test(col) ? '' : `Cause of Loss is "${col || '?'}", not "${cause}"`;
    },
    build: async (page) => {
      const { k, i } = await exposureIndex(page, exposure);
      if (k < 0) throw new W.Blocked(`no exposure matching /${src(exposure)}/ to set Cause of Loss on`);
      await A().openExposure(page, i);
      await A().editAndSave(page, `Cause of Loss → ${cause}`, async () => { await A().selectByLabel(page, 'Cause of Loss', new RegExp(cause, 'i')); });
      return `exposure ${i + 1} Cause of Loss set to ${cause}`;
    },
  }),

  // Every exposure on the claim matches `match` (VBR.037 negatives need ONE qualifying exposure, nothing else).
  onlyExposures: ({ match, why }) => ({
    id: `onlyExposures:${src(match)}`,
    label: `Only exposures matching /${src(match)}/ (${why})`,
    check: async (page) => {
      const rows = await F().exposureRows(page);
      const bad = rows.filter((r) => !toRe(match).test(r.t));
      return !rows.length ? 'claim has no exposure' : bad.length ? `extra exposure(s): ${bad.map((r) => r.t.slice(0, 60)).join(' | ')}` : '';
    },
    build: null,
    manual: 'pick an FNOL with only that coverage (provision a new claim) — exposures cannot be deleted',
  }),

  // Injury incident on the exposure (Ability to pay / Quick Payment need it on medical exposures — setupE).
  injuryIncident: ({ exposure }) => ({
    id: `injuryIncident:${src(exposure)}`,
    label: `Injury incident on exposure /${src(exposure)}/`,
    check: null,
    build: async (page) => {
      const { k, i } = await exposureIndex(page, exposure);
      if (k < 0) throw new W.Blocked(`no exposure matching /${src(exposure)}/ for the injury incident`);
      return E().ensureInjuryIncident(page, i);
    },
  }),

  // A reserve line under exposure /exposure/ and cost type `costType` with at least `min` remaining.
  reserve: ({ exposure = /./, costType = 'Claim Cost', amount = 2500, min = 50 }) => ({
    id: `reserve:${src(exposure)}:${costType}`,
    label: `Reserve ≥ $${min} open on ${costType} under exposure /${src(exposure)}/ (built at $${amount})`,
    check: async (page) => {
      const rows = await X().reserveRows(page);
      const hit = rows.filter((r) => toRe(exposure).test(r.expo) && new RegExp(`^${costType}`, 'i').test(r.cost));
      if (!hit.length) return `no ${costType} reserve line under /${src(exposure)}/ (lines: ${rows.map((r) => `${r.expo.slice(0, 30)} ${r.cost} ${r.remaining}`).join(' | ') || 'none'})`;
      return hit.some((r) => r.remaining >= min) ? '' : `${costType} line under /${src(exposure)}/ has only $${Math.max(...hit.map((r) => r.remaining))} remaining (< $${min})`;
    },
    build: async (page, claim) => {
      const err = await X().addReserve(page, claim, { amount, costType, exposure: src(exposure) });
      if (err) throw new W.Blocked(`reserve not added: ${String(err).slice(0, 200)}`);
      return `added a $${amount} ${costType} reserve on /${src(exposure)}/`;
    },
  }),

  // An expense cost-type reserve row (Quick Payment expense cases open from it). On a vehicle exposure the New Reserve
  // screen offers only Claim Cost (CONFIRMED 2026-10-21) — worker D made these rows with a small vendor First and Final
  // payment on a new "Expense OR First and Final" line. Not automated yet.
  expenseRow: ({ costType }) => ({
    id: `expenseRow:${costType}`,
    label: `A "${costType}" reserve row (Financials)`,
    check: async (page) => {
      const rows = await X().reserveRows(page);
      return rows.some((r) => new RegExp(`^${costType}`, 'i').test(r.cost)) ? '' : `no "${costType}" row on Financials`;
    },
    build: null,
    manual: 'small First and Final payment to an Address Book vendor on a new "Expense OR First and Final" reserve line with this cost type (as worker D did on PA-PA-01-26-0748435)',
  }),

  // Address Book company on the claim with a role (setupE.ROLE_CONTACTS key, or { name, taxId, type, role }).
  roleContact: (c) => {
    const def = typeof c === 'string' ? { key: c, ...require('./setupE').ROLE_CONTACTS[c] } : c;
    return {
      id: `roleContact:${def.name}`,
      label: `Contact ${def.name} with role "${def.role}"`,
      check: async (page) => {
        const list = await contactsList(page);
        const row = list.find((t) => t.toUpperCase().includes(def.name.toUpperCase()));
        return !row ? `${def.name} is not on Parties Involved` : row.includes(def.role) ? '' : `${def.name} is on the claim without role "${def.role}"`;
      },
      build: async (page) => (def.key ? E().addRoleContact(page, def.key) : (await W.addClaimContactWithRole(page, def, def.role)) ? `added ${def.name} (${def.role})` : `${def.name} already on the claim`),
    };
  },

  // Two Lienholder/Mortgagee companies + the loan (vehicle) / mortgage (property) naming the first (AUTO_LIEN / PROP_MORT).
  lienholders: ({ kind = 'vehicle' } = {}) => ({
    id: `lienholders:${kind}`,
    label: `2 Lienholder/Mortgagee contacts + ${kind === 'property' ? 'mortgage on the property incident' : 'loan on the vehicle incident'}`,
    check: async (page) => {
      const list = await contactsList(page);
      const n = W.lienholders().slice(0, 2).filter((c) => list.some((t) => t.toUpperCase().includes(c.name.toUpperCase()) && /Lienholder/i.test(t))).length;
      return n >= 2 ? '' : `${n}/2 Lienholder/Mortgagee contacts on the claim`;
    },
    build: async (page, claim) => {
      const notes = [];
      for (const c of W.lienholders().slice(0, 2)) {
        if (await W.addClaimContactWithRole(page, c)) notes.push(`added ${c.name}`);
        await W.openClaim(page, claim);
      }
      const loan = await W.addIncidentLoan(page, W.lienholders()[0].name, { kind });
      notes.push(loan === 'existing' ? 'loan already set' : `${kind === 'property' ? 'mortgage' : 'loan'} ${loan}`);
      return notes.join('; ');
    },
  }),

  // Exposure #expo (1-based) has a transaction in "Pending approval" (VBR.032). Raised as the provisioning user, who
  // must NOT have the authority (not su) — workerG.makePendingReserve.
  pendingTransaction: ({ expo, amount = 250000 }) => ({
    id: `pending:${expo}`,
    label: `Exposure (${expo}) has a reserve change in "Pending approval"`,
    check: async (page) => G().requirePending(page, expo, true).then(() => '').catch((e) => e.message),
    build: (page) => G().makePendingReserve(page, expo, amount),
  }),

  // Surcharging left incomplete (VBR.037 positives) — New Payment must stop on it. FNOL leaves it incomplete; the
  // profile's keepSurcharging stops claimCheck from completing it.
  // Reads the Surcharging screen itself (Edit → count unanswered Yes/No questions → Cancel, nothing saved). NOT the
  // New Payment error: on the VBR.037 negatives (commercial auto, LC01-only, LC50 outside MI) the wizard opens even
  // though Surcharging is incomplete — that IS the expected result (CONFIRMED 2026-10-21, first --verify run).
  surchargingIncomplete: () => ({
    id: 'surchargingIncomplete',
    label: 'Surcharging screen left incomplete (questions unanswered)',
    check: async (page) => {
      const link = page.locator('[id="Claim-MenuLinks-Claim_ClaimSurchargingGroup"]').first();
      if (!await link.isVisible().catch(() => false)) return 'no Surcharging screen on this claim';
      await link.click();
      await W.settle(page, 3500);
      const edit = page.getByRole('button', { name: 'Edit', exact: true }).first();
      if (!await edit.isVisible().catch(() => false)) return 'Surcharging screen has no Edit button (cannot read its state)';
      await edit.click();
      await W.settle(page, 2500);
      const open = (await readScreen(page)).fields.filter((f) => f.radios && f.radios.length && !f.radios.some((r) => r.checked)).length;
      await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
      await W.settle(page, 1500);
      return open ? '' : 'every Surcharging question is answered (screen completed)';
    },
    build: null,
    manual: 'provision a new claim (FNOL leaves Surcharging incomplete) — a completed Surcharging screen cannot be reset',
  }),

  // A contact (person or company) on Parties Involved by name. build: null — claim-only person contacts are made by
  // hand / FNOL (e.g. PHILIP ADAMS on E_PA, David Thomas on the HO claims).
  contact: (name, how = 'add the contact to the claim (Parties Involved › New Contact)') => ({
    id: `contact:${name}`,
    label: `Contact "${name}" on the claim`,
    check: async (page) => ((await contactsList(page)).some((t) => t.toUpperCase().includes(name.toUpperCase())) ? '' : `${name} is not on Parties Involved`),
    build: null,
    manual: how,
  }),

  // A reserve row of cost type /cost/ (optionally under exposure /expo/) whose remaining reserve is $0 / > 0 / any —
  // what reuseExt.openQuickOnRow and the 'zero' / 'match:' reserve-line steps need.
  reserveRow: ({ cost = 'claim cost', state = 'any', expo = '' }) => ({
    id: `reserveRow:${cost}:${state}:${expo}`,
    label: `A ${state === 'zero' ? '$0 (closed) ' : state === 'open' ? 'open ' : ''}reserve row of cost type /${cost}/${expo ? ` under exposure /${expo}/` : ''}`,
    check: async (page) => {
      const rows = await X().reserveRows(page);
      const hit = rows.filter((r) => new RegExp(cost, 'i').test(r.cost) && (!expo || new RegExp(expo, 'i').test(r.expo)));
      const ok = hit.some((r) => (state === 'zero' ? !(r.remaining > 0) : state === 'open' ? r.remaining > 0 : true));
      return ok ? '' : `none (rows: ${rows.map((r) => `${r.expo.slice(0, 25)} ${r.cost} $${r.remaining}`).join(' | ') || 'none'})`;
    },
    build: null,
    manual: state === 'zero' ? 'a reserve line drained to $0 (Final Payment on it)' : /expense/i.test(cost) ? 'an expense reserve row (vendor First and Final on a new Expense line)' : 'a reserve on that exposure (Actions › Reserve)',
  }),

  // Wraps an existing profile prepare hook ('<module>.<fn>') as an item (its note is the record).
  hook: (ref, label) => ({
    id: `hook:${ref}`,
    label,
    check: null,
    build: (page, claim, out) => { const [mod, fn] = ref.split('.'); return require(`./${mod}`)[fn](page, claim, out || {}); },
  }),

  // Data that automation cannot create — listed on the requirements sheet with what unblocks it.
  manual: (id, label, manual) => ({ id: `manual:${id}`, label, check: null, build: null, manual }),
};

// ── Engine ──────────────────────────────────────────────────────────────────────────────────────────────────────
// check-only (runtime) or check → build → check (prepare). Returns [{ id, label, ok, problem, note }].
async function ensure(page, claim, items, { build = false, log = () => {}, out } = {}) {
  const res = [];
  for (const it of items || []) {
    const r = { id: it.id, label: it.label, ok: false, problem: '', note: '' };
    try {
      await W.cancelWizard(page).catch(() => {});
      await W.openClaim(page, claim);
      let problem = it.check ? await it.check(page) : (build ? 'not verifiable — built' : '');
      if (problem && build && it.build) {
        await W.openClaim(page, claim);
        r.note = String((await it.build(page, claim, out)) || '').slice(0, 300);
        log(`[TestData] ${claim}: ${it.label} — ${r.note || 'built'}`);
        await W.cancelWizard(page).catch(() => {});
        await W.openClaim(page, claim);
        problem = it.check ? await it.check(page) : '';
      } else if (problem && build && !it.build) {
        problem = `${problem} — cannot be built automatically: ${it.manual || 'manual data'}`;
      }
      r.ok = !problem;
      r.problem = problem || '';
    } catch (e) {
      r.problem = e.message.split('\n')[0].slice(0, 300);
    }
    if (!r.ok) log(`[TestData] ${claim}: MISSING ${it.label} — ${r.problem}`);
    res.push(r);
  }
  await W.cancelWizard(page).catch(() => {});
  return res;
}

// Items of a profile (helpers/oneInc/claimPicker PROFILES[profile].data).
const itemsFor = (profile) => ((require('./claimPicker').PROFILES[profile] || {}).data || []);

// Case-level needs DERIVED from a recipe's steps, so every case states its data precondition without hand edits:
// the expense / exposure row a Quick Payment opens from, a $0 line for 'zero' cases, the exposure a 'match:' reserve
// line names, a named payee contact. Explicit recipe.needs are added on top. Pure (offline-testable).
const ROLE_PAYEES = /^(claimant|insured|vendor|lienholder\d?|sni|@person)$/i;
function deriveNeeds(recipe) {
  const out = [];
  const seen = new Set();
  const push = (it) => { if (!seen.has(it.id)) { seen.add(it.id); out.push(it); } };
  for (const s of recipe.steps || []) {
    const k = Object.keys(s)[0];
    const v = s[k];
    if (k === 'call' && v[0] === 'reuseExt.openQuickOnRow') push(D.reserveRow({ cost: v[1] || 'expense', state: v[2] === 'zero' ? 'zero' : (v[2] === 'any' || v[2] == null) ? 'any' : 'open', expo: v[3] || '' }));
    if ((k === 'reserve' && v === 'zero') || (k === 'open' && s.zeroReserve)) push(D.reserveRow({ cost: '.', state: 'zero' }));
    if (k === 'reserve' && typeof v === 'string' && v.startsWith('match:')) push(D.reserveRow({ cost: '.', state: 'open', expo: v.slice(6) }));
    if (k === 'payee' && typeof v === 'string' && !ROLE_PAYEES.test(v)) push(D.contact(v));
  }
  return [...out, ...(recipe.needs || [])];
}

// Data the suite needs but automation cannot create — for the requirements sheet (scripts/oneIncDataRequirements.js).
// cases: scenario ids; unblock: what a person / decision must supply.
const MANUAL_DATA = [
  { id: 'approver-no-contact', label: 'Active TEST user (payment approver) with NO email and NO phone', cases: ['GCCM-759/CPD/TC-003', 'GCCM-1003/CPD/TC-210'], unblock: 'name such a user, or allow an admin to blank a test user\'s email/phone (CPD.002 positive)' },
  { id: 'owner-no-info', label: 'Exposure owner with no first/last name, email, phone', cases: ['GCCM-763/VBR/TC-004', 'GCCM-1003/VBR/TC-086'], unblock: 'name such a user (candidate: Austin Acheson, Inactive Users — VBR.026 may fire first) (VBR.002)' },
  { id: 'cm-address', label: 'Address Book (Contact Manager) primary-address change on a linked payee', cases: ['GCCM-803/TC/TC-044', 'GCCM-803/TC/TC-045', 'GCCM-1003/VBR/TC-189', 'GCCM-1003/VBR/TC-190'], unblock: 'someone with Contact Manager access edits/restores BAIKOW LEGAL LLC\'s address within ~45 min of the automated payment (VBR.036)' },
  { id: 'pre-2013-dol', label: 'Policy with a pre-2013 loss date', cases: [], unblock: 'a 2012 policy in TEST (none exists)' },
  { id: 'emb-coverage', label: 'Policy with Extraordinary/Extended Medical Benefits coverage', cases: ['GCCM-763/VBR/TC-045', 'GCCM-763/VBR/TC-046', 'GCCM-763/VBR/TC-047', 'GCCM-1003/VBR/TC-128', 'GCCM-1003/VBR/TC-129', 'GCCM-1003/VBR/TC-130'], unblock: 'a TEST policy carrying EMB (VBR.016)' },
  { id: 'paid-status', label: 'A prior payment in status "Paid"', cases: ['GCCM-763/VBR/TC-054', 'GCCM-763/VBR/TC-055', 'GCCM-763/VBR/TC-061', 'GCCM-763/VBR/TC-062', 'GCCM-1003/VBR/TC-137', 'GCCM-1003/VBR/TC-138', 'GCCM-1003/VBR/TC-144', 'GCCM-1003/VBR/TC-145'], unblock: 'decision: treat "Awaiting submission" as active, or wait for checks that issue (VBR.019/022)' },
  { id: 'tax-id-valid-until', label: 'Vendor with Tax ID Valid Until in the past / future', cases: [], unblock: 'Contact Manager data (VBR.034) — manual' },
  { id: 'pa-tort-codes', label: 'Display names of Cause of Loss LC03 / LC09 / LC90', cases: ['GCCM-799/UIF/TC-006', 'GCCM-1003/UIF/TC-024'], unblock: 'BA: which Cause of Loss labels are LC03/LC09/LC90' },
];

module.exports = { D, ensure, itemsFor, deriveNeeds, contactsList, MANUAL_DATA };
