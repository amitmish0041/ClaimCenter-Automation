/**
 * helpers/oneInc/claimCheck.js
 * "Can the OneInc suite use this claim?" — shared by the claim scout (scripts/scoutOneIncClaims.js) and the claim
 * provisioner (scripts/provisionOneIncClaims.js). Opens the claim (admin fallback for restricted claims), opens the
 * New Payment wizard, and records the payees (and which have payment contact details), the reserve lines and their
 * Available Reserves. Read-only unless `prepare` is set (TEST only): then it also fixes the blockers ClaimCenter names
 * — an unfinished Surcharging screen, an unassigned claim/exposures, a claim with no reserve.
 */
'use strict';
const W = require('./wizardDriver');
const { readScreen, findField } = require('./screenReader');
const { NO_CONTACT_DETAILS } = require('./scenarioRecipes');

// The exposure each claim profile's FNOL adds (scripts/provisionOneIncClaims.js), keyed by claim-number prefix.
const EXPOSURES = {
  PA: [{ coverageLabel: 'Collision' }],
  HO: [{ coverageLabel: ['Coverage A Dwelling', 'Coverage B Other Structures', 'Coverage D Loss of Use'] }],
};
const exposuresFor = (claim) => EXPOSURES[String(claim).split('-')[0]] || null;

// fnolHelper's add-exposure walk runs on an existing claim through completeFNOL's reuse path (CC_EXISTING_CLAIM).
async function addExposures(page, claim, exposures) {
  const prev = process.env.CC_EXISTING_CLAIM;
  process.env.CC_EXISTING_CLAIM = claim;
  try {
    await require('../fnolHelper').completeFNOL(page, { policyType: '', exposures });
  } finally {
    if (prev === undefined) delete process.env.CC_EXISTING_CLAIM; else process.env.CC_EXISTING_CLAIM = prev;
  }
  return exposures.length;
}

async function checkClaim(page, claim, { prepare = false, lienholders = false, profile = null, log = console.log } = {}) {
  const out = { claim, opens: false, wizard: false, payees: [], openReserve: false, reserveLines: [], problem: '', repaired: [] };
  try {
    await W.cancelWizard(page);
    await W.openClaim(page, claim, log);
    out.opens = true;
    out.login = page.__oneIncUser === 'admin' ? 'admin' : 'standard';
    page.__oneIncParties = null;
    out.parties = await W.getParties(page);
    // AUTO_LIEN: two Address Book companies with the claim role Lienholder/Mortgagee, and a loan on the vehicle naming
    // the first (user direction 2026-10-21). Idempotent — existing contacts/loan rows are left as they are.
    // Extension profile prepare hook: PROFILES[profile].prepare = '<module>.<fn>' → fn(page, claim, out) (TEST only).
    const hook = profile && (require('./claimPicker').PROFILES[profile] || {}).prepare;
    if (prepare && hook) {
      const [mod, fn] = hook.split('.');
      const done = await require(`./${mod}`)[fn](page, claim, out);
      if (done) out.repaired.push(String(done));
      await W.openClaim(page, claim, log);
      page.__oneIncParties = null;
      out.parties = await W.getParties(page);
    }
    if (prepare && lienholders) {
      for (const c of W.lienholders().slice(0, 2)) {
        if (await W.addClaimContactWithRole(page, c)) out.repaired.push(`added ${c.name} as Lienholder/Mortgagee`);
        await W.openClaim(page, claim, log);
      }
      // HO claims carry the mortgage on the fixed-property incident; auto claims the loan on the vehicle.
      const kind = /^HO-/.test(claim) ? 'property' : 'vehicle';
      const loan = await W.addIncidentLoan(page, W.lienholders()[0].name, { kind });
      if (loan !== 'existing') out.repaired.push(`${kind === 'property' ? 'mortgage' : 'vehicle loan'} ${loan} → ${W.lienholders()[0].name}`);
      await W.openClaim(page, claim, log);
      page.__oneIncParties = null;
      out.parties = await W.getParties(page);
    }
    // Declared test data (PROFILES[profile].data, helpers/oneInc/testData.js): check each item, build what is missing,
    // check again. prepare builds; a plain check only reads. A claim is usable only when every item passes.
    const items = profile ? require('./testData').itemsFor(profile) : [];
    if (items.length) {
      out.data = await require('./testData').ensure(page, claim, items, { build: prepare, log, out });
      out.data.filter((d) => d.note).forEach((d) => out.repaired.push(`${d.label}: ${d.note}`));
      await W.openClaim(page, claim, log);
      page.__oneIncParties = null;
      out.parties = await W.getParties(page);
    }
    // prepare: first run CC's own "Ability to pay" check and fix what it names (user direction 2026-10-21).
    const fixAbility = async (why) => {
      if (/Serial number must be present|Boat type must be present|Vehicle Identification Number/i.test(why)) {
        const v = await W.repairVehicleVins(page);
        out.repaired.push(`vehicle incident VIN/Style fixed on ${v.join(', ') || '(no vehicle needed it)'}`);
        return true;
      }
      if (/primary address/i.test(why)) {
        await W.repairClaimantAddress(page);
        out.repaired.push('claimant primary address filled in');
        return true;
      }
      return false;
    };
    // Re-run it after each fix: a PASSING run is what raises the claim/exposures to the Ability-to-pay level — fixed but
    // not re-validated, the exposure's reserve line never appeared in the wizard (PL50, CONFIRMED 2026-10-21).
    const validate = async () => {
      for (let i = 0; i < 3; i++) {
        const why = await W.abilityToPay(page).catch((e) => `(could not run Ability to pay: ${e.message})`);
        out.abilityToPay = why || 'passed';
        if (!why || !await fixAbility(why)) break;
        await W.openClaim(page, claim, log);
      }
      await W.openClaim(page, claim, log);
    };
    if (prepare) await validate();
    // Then fix what "New Payment Error" names and retry (fixing one can reveal the next). Also used after a reserve
    // is added — a new exposure re-opens the Surcharging screen (CONFIRMED 2026-10-21).
    const openWizard = async () => { for (let round = 0; ; round++) {
      try {
        await W.openPayment(page, 'actions');
        break;
      } catch (e) {
        if (!prepare || round >= 4) throw e;
        if (/Surcharging/i.test(e.message)) {
          // Profiles with keepSurcharging (VBR.037 positives) must NOT have it completed — stop with the message as found.
          if (profile && (require('./claimPicker').PROFILES[profile] || {}).keepSurcharging) { out.surchargingIncomplete = true; throw e; }
          await W.repairSurcharging(page);
          out.repaired.push('Surcharging answered "No" and saved');
        } else if (/assign the claim/i.test(e.message)) {
          const done = await W.assignClaimAndExposures(page);
          out.repaired.push(`assigned ${done.join(', ') || '(nothing to assign)'}`);
        } else if (/Ability to Pay/i.test(e.message)) {
          // The reasons are in the validation panel; the one we can fix is a claimant without an address.
          const why = await W.abilityToPayErrors(page);
          if (!await fixAbility(why)) throw new Error(`${e.message.split('\n')[0]} — ${why.slice(0, 300)}`);
        } else throw e;
        await W.openClaim(page, claim, log);
      }
    } };
    await openWizard();
    out.wizard = true;
    const names = ((await W.optionsOf(page, 'Name')) || []).map((o) => o.t).filter((t) => t && !/^<none>$/i.test(t));
    for (const n of names) {
      await W.select(page, 'Name', n).catch(() => {});
      const s = await readScreen(page);
      const type = findField(s, 'Type');
      out.payees.push({ name: n, type: type ? type.value : '', contactDetails: !NO_CONTACT_DETAILS.test([s.messages.join(' '), s.body.slice(0, 5000)].join(' ')) });
    }
    // Reserve lines need a payee on Step 1 first.
    const claimant = names.find((n) => out.parties.claimants.includes(n)) || names[0];
    if (claimant) {
      const readLines = async () => {
        await W.select(page, 'Name', claimant).catch(() => {});
        await W.clickButton(page, 'Next').catch(() => {});
        return ((await W.optionsOf(page, 'Reserve Line')) || []).map((o) => o.t).filter((t) => t && !/^<none>$|expense or first and final/i.test(t));
      };
      let lines = await readLines();
      if (!lines.length && prepare) {
        await W.cancelWizard(page);
        page._currentClaimNumber = claim;
        const reserve = () => require('../financialsHelper').createReserve(page, { reserveAmount: 2500, costType: 'CLPD', costCategory: 'ClaimCost' }).catch((e) => e.message);
        let err = await reserve();
        // Provisioned AUTO/HO claims can come out of FNOL with NO exposure — the New Reserve screen's Exposure list is
        // then empty ("still open with no validation text", CONFIRMED 2026-10-21). Add the profile's exposure, retry.
        if (typeof err === 'string' && err && exposuresFor(claim)) {
          await W.cancelWizard(page).catch(() => {});
          const added = await addExposures(page, claim, exposuresFor(claim));
          if (added) {
            out.repaired.push(`added ${added} exposure(s)`);
            await W.openClaim(page, claim, log);
            await validate(); // the new exposure's incident can fail Ability to pay (VIN / Style)
            err = await reserve();
          }
        }
        if (typeof err === 'string' && err) throw new Error(`could not add a reserve: ${err}`);
        out.repaired.push('added a $2,500 reserve');
        await validate();
        await openWizard();
        lines = await readLines();
      }
      const readAvailable = async () => {
        out.reserveLines = [];
        for (const l of lines) {
          await W.select(page, 'Reserve Line', l).catch(() => {});
          const amt = await W.availableReserves(page);
          out.reserveLines.push({ line: l, available: amt });
          if (amt > 0) out.openReserve = true;
        }
      };
      await readAvailable();
      // Lines exist but every one is at $0 (closed by a Final Payment / drained by earlier runs): add a fresh Claim
      // Cost reserve too. Only "no line at all" used to trigger it, so such a claim stayed "not usable" with an EMPTY
      // problem (CONFIRMED 2026-10-21 on PA-PA-01-26-0748443). strict: an error instead of editing another reserve.
      if (lines.length && !out.openReserve && prepare) {
        await W.cancelWizard(page);
        page._currentClaimNumber = claim;
        let err = await require('../financialsHelper').createReserve(page, { reserveAmount: 2500, costType: 'Claim Cost', strict: true }).catch((e) => e.message);
        // CC offers no Cost Category for a cost type the exposure already has a line for (CONFIRMED 2026-10-21 on
        // PA-PA-01-26-0748484) — raise the existing $0 line instead. Every line is at $0 here, so editing one changes
        // nothing another case relies on; readAvailable below verifies it.
        if (typeof err === 'string' && /no Cost Category option/i.test(err)) {
          await W.openClaim(page, claim, log);
          page._currentClaimNumber = claim;
          err = await require('../financialsHelper').createReserve(page, { reserveAmount: 2500, costType: 'Claim Cost' }).catch((e) => e.message);
        }
        if (typeof err === 'string' && err) throw new Error(`every reserve line is at $0 and a Claim Cost reserve could not be added: ${err}`);
        out.repaired.push('added a $2,500 Claim Cost reserve (all lines were at $0)');
        await validate();
        await openWizard();
        lines = await readLines();
        await readAvailable();
      }
      if (!lines.length) out.problem = prepare ? 'still no reserve line after adding a reserve' : 'claim has no reserve lines';
      else if (!out.openReserve) out.problem = `no reserve line has open Available Reserves (${out.reserveLines.map((r) => `${r.line}: ${r.available}`).join('; ').slice(0, 200)})`;
    } else out.problem = 'payee Name list is empty';
  } catch (e) {
    out.problem = e.message.split('\n')[0].slice(0, 300);
  }
  await W.cancelWizard(page).catch(() => {});
  out.lienholders = out.payees.filter((p) => /lienholder/i.test(p.type)).map((p) => p.name);
  const dataMissing = (out.data || []).filter((d) => !d.ok);
  // keepSurcharging profiles never open the wizard (that IS their data); their usability is the data items alone.
  const keepSurch = profile && (require('./claimPicker').PROFILES[profile] || {}).keepSurcharging;
  // (VBR.037 negatives carry keepSurcharging too but have no Surcharging screen — their wizard opens: usable the usual way.)
  out.usable = ((keepSurch && out.surchargingIncomplete) || (out.wizard && out.payees.length > 0 && out.openReserve && (!lienholders || out.lienholders.length > 0)))
    && !dataMissing.length;
  if (keepSurch && out.surchargingIncomplete && /Surcharging/i.test(out.problem)) out.problem = '';
  if (dataMissing.length) out.problem = [out.problem, `missing test data: ${dataMissing.map((d) => `${d.label} (${d.problem})`).join('; ')}`].filter(Boolean).join(' | ').slice(0, 600);
  // Never "not usable" without a reason.
  if (!out.usable && !out.problem) {
    out.problem = !out.wizard ? 'payment wizard did not open' : !out.payees.length ? 'no payees in the wizard'
      : !out.openReserve ? 'no reserve line has open Available Reserves' : 'no Lienholder/Mortgagee payee on the claim';
  }
  out.payeeWithDetails =(out.payees.find((p) => p.contactDetails) || {}).name || null;
  return out;
}

module.exports = { checkClaim, addExposures, exposuresFor };
