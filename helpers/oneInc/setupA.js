/**
 * helpers/oneInc/setupA.js
 * UI setup steps for the "setup A" OneInc scenarios (claim/exposure state rules, WC indemnity / Medicare, payee roles).
 * Called from recipes with { call: ['setupA.<fn>', ...args] } → fn(page, ...args), and from profile prepare hooks
 * (fn(page, claim, out)). WRITES to automation-owned claims on the TEST tier only.
 */
'use strict';
const W = require('./wizardDriver');
const { readScreen, findField, norm } = require('./screenReader');

const TIER = (process.env.CC_TIER || 'test').toLowerCase();
function testOnly(what) {
  if (TIER !== 'test') throw new W.Blocked(`${what} writes claim data — allowed on the TEST tier only`);
}
const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
const today = () => fmt(new Date());

const editing = (page) => page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false);

// Required fields CC leaves empty on edit screens (exposure edit shows the vehicle incident's "Primary Point of
// Impact" / "Is Vehicle Drivable?" — CONFIRMED 2026-10-21): first real option for selects, "No" for Yes/No radios.
async function fillRequiredOnEdit(page) {
  const filled = await W.fillRequiredEmpties(page);
  const s = await readScreen(page);
  for (const f of s.fields.filter((x) => x.required && x.radios && !x.radios.some((r) => r.checked) && x.id)) {
    await page.locator(`[id="${f.id}"]`).getByRole('radio', { name: 'No', exact: true }).first().click().catch(() => {});
    await W.settle(page, 1000);
    filled.push(`${f.label}=No`);
  }
  return filled;
}

// Edit → fn() → Update, and prove the screen left edit mode (saves can fail silently in Cloud). Throws Blocked with
// CC's messages when the save is refused (and cancels the edit so the claim isn't left locked).
async function editAndSave(page, what, fn) {
  if (!await editing(page)) await W.clickButton(page, 'Edit');
  await fn();
  for (let i = 0; i < 2; i++) {
    await W.clickButton(page, 'Update');
    await page.waitForTimeout(1500);
    if (!await editing(page)) return;
    // Warnings-only pages need a second Update ("…Clear" link-free messages)
    const s = await readScreen(page);
    const msgs = [...s.messages, s.south].join(' / ');
    if (i === 0 && /Missing required field/i.test(msgs)) {
      // "Errors located on another page: Appraisal" — the missing fields are on another tab of the same edit screen.
      const other = /Errors located on another page:\s*([A-Za-z ]+?)\s+Click here/i.exec(s.body);
      if (other) { await page.getByText(other[1].trim(), { exact: true }).first().click().catch(() => {}); await W.settle(page, 2500); }
      if ((await fillRequiredOnEdit(page)).length) continue;
    }
    if (i === 1 || /error|must|required|invalid/i.test(msgs.replace(/warning[^/]*/gi, ''))) {
      await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
      await W.settle(page, 2000);
      throw new W.Blocked(`${what} could not be saved: ${msgs.slice(0, 400) || 'no message'}`);
    }
  }
}

// Select an option on a <select> field addressed through readScreen (label match), by exact text or regex.
async function selectByLabel(page, label, want) {
  const s = await readScreen(page);
  const f = findField(s, label);
  if (!f || f.kind !== 'select') throw new W.Blocked(`"${label}" dropdown is not on the screen`);
  const sel = page.locator(`[id="${f.id}"] select`).first();
  const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })));
  const pick = want instanceof RegExp ? opts.find((o) => want.test(o.t)) : (opts.find((o) => norm(o.t) === norm(want)) || opts.find((o) => norm(o.t).includes(norm(want))));
  if (!pick) throw new W.Blocked(`"${label}" has no option ${want} (options: ${opts.map((o) => o.t).join(', ')})`);
  await sel.selectOption(pick.v);
  await W.settle(page, 1500);
  return pick.t;
}

async function fillByLabel(page, label, value) {
  const f = findField(await readScreen(page), label);
  if (!f) throw new W.Blocked(`"${label}" field is not on the screen`);
  const sel = `[id="${f.id}"] input:not([type=hidden]), [id="${f.id}"] textarea`;
  const vis = page.locator(sel).filter({ visible: true }).first();
  // Time-only widgets ("Time Employee Began Work") keep their input hidden (gw-hidden gw-timeOnly) until the picker opens —
  // fill() timed out on every new WC claim (CONFIRMED 2026-10-27, WC-PA-01-26-0748573..77). Set it directly then.
  if (!await vis.isVisible().catch(() => false)) {
    await page.locator(sel).first().evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(value));
    await W.settle(page, 1000);
    return;
  }
  const inp = vis;
  await inp.fill(String(value));
  await inp.press('Tab').catch(() => {});
  await W.settle(page, 1000);
}

// ── Exposures ───────────────────────────────────────────────────────────────────────────────────────────────────
async function exposureCount(page) {
  await W.navigate(page, 'exposures');
  await page.locator('tr[id*="ExposuresLV-0-"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  return page.locator('[id*="ExposuresLV-"][id$="-Order_button"]:visible').count();
}
async function openExposure(page, i) {
  await W.navigate(page, 'exposures');
  const b = page.locator(`[id*="ExposuresLV-${i}-Order_button"]`).first();
  await b.waitFor({ state: 'visible', timeout: 15000 });
  await b.click();
  await W.settle(page, 3000);
}

// VBR.023: "Coverage Denied?" on EVERY exposure of the claim (so whichever reserve line a wizard picks is in that
// state). value: 'Denied in Full' | 'Denied in Part' | 'No' | '<none>'. Idempotent.
async function setExposureCoverageDenied(page, value = 'Denied in Full') {
  testOnly('setExposureCoverageDenied');
  const n = await exposureCount(page);
  if (!n) throw new W.Blocked('claim has no exposures');
  const done = [];
  for (let i = 0; i < n; i++) {
    await openExposure(page, i);
    const cur = findField(await readScreen(page), 'Coverage Denied?');
    const want = value === '<none>' ? '' : value;
    if (cur && norm(cur.value) === norm(want)) { done.push(`#${i + 1} already ${value}`); continue; }
    await editAndSave(page, `exposure #${i + 1} Coverage Denied?`, async () => {
      await selectByLabel(page, 'Coverage Denied?', value === '<none>' ? /^<none>$/ : value);
      const lit = findField(await readScreen(page), 'Litigation Status');
      if (lit && lit.kind === 'select' && !/not in litigation/i.test(lit.value)) await selectByLabel(page, 'Litigation Status', 'Not In litigation').catch(() => {});
    });
    await page.getByText('Details', { exact: true }).first().click().catch(() => {});
    await W.settle(page, 2000);
    const after = findField(await readScreen(page), 'Coverage Denied?');
    if (!after || norm(after.value) !== norm(want)) throw new W.Blocked(`exposure #${i + 1} Coverage Denied? did not stick (shows "${after ? after.value : '?'}")`);
    done.push(`#${i + 1} → ${value}`);
  }
  await W.navigate(page, 'summary').catch(() => {});
  return `Coverage Denied? on ${n} exposure(s): ${done.join(', ')}; ${done.some((d) => /→/.test(d)) ? await revalidate(page) : 'unchanged'}`;
}

// VBR.026 / VBR.002: exposure OWNER. Exposures › select all › Assign › "Find a user or group" (First/Last name) ›
// Search › the result row's Assign. The "Select from list" only offers the logged-in admin's own group ("Inactive
// Users" — whose users have NO examiner number: "Exposure owner Bill Folmar must have a valid examiner number",
// CONFIRMED 2026-10-21). who = 'Benjamin Smith' (Recovery Claims Team 2, has an examiner number) or 'Bill Folmar'.
async function assignExposuresTo(page, who = 'Benjamin Smith', group = 'Recovery Claims Team 2') {
  testOnly('assignExposuresTo');
  const [first, ...rest] = String(who).split(' ');
  const last = rest.join(' ');
  await W.navigate(page, 'exposures');
  await page.locator('tr[id*="ExposuresLV-0-"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const rows = await page.evaluate(() => [...document.querySelectorAll('[id*="ExposuresLV-"][id$="-Assignee"]')].map((e) => e.innerText.trim()));
  if (rows.length && rows.every((r) => norm(r) === norm(who))) return `exposures already owned by ${who}`;
  await page.locator('[id$="ExposuresLV-_Checkbox"]:visible').first().click();
  await page.waitForTimeout(800);
  await W.clickButton(page, 'Assign');
  const opts = ((await W.optionsOf(page, 'Select from list:')) || []).map((o) => o.t);
  const inList = opts.find((t) => norm(t).startsWith(norm(who)));
  if (inList) {
    await W.select(page, 'Select from list:', inList);
    await page.getByRole('button', { name: 'Assign', exact: true }).last().click();
  } else {
    // The search only runs with the "Find a user or group" radio selected.
    await page.locator('[id$="FromSearch_Choice_radio"]').first().click();
    await W.settle(page, 1500);
    await page.getByLabel('First name', { exact: true }).first().fill(first);
    await page.getByLabel('Last name', { exact: true }).first().fill(last);
    await page.getByRole('button', { name: 'Search', exact: true }).last().click();
    await W.settle(page, 3500);
    // One row per group membership ("Benjamin Smith Recovery Claims Team 2 …"); prefer `group` when given.
    const rowsL = page.locator('tr[id*="AssignmentUserLV-"]').filter({ hasText: last });
    const row = (group && await rowsL.filter({ hasText: group }).count()) ? rowsL.filter({ hasText: group }).first() : rowsL.first();
    if (!await row.isVisible().catch(() => false)) {
      await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
      throw new W.Blocked(`user "${who}" not found in the assignment search`);
    }
    await row.getByText('Assign', { exact: true }).first().click();
  }
  await W.settle(page, 3500);
  if (await page.getByText(/assignment\(s\) failed|does not have permission to be assigned/i).first().isVisible().catch(() => false)) {
    throw new W.Blocked(`assigning the exposures to ${who} was rejected`);
  }
  await W.navigate(page, 'exposures');
  const after = await page.evaluate(() => [...document.querySelectorAll('[id*="ExposuresLV-"][id$="-Assignee"]')].map((e) => e.innerText.trim()));
  if (!after.length || !after.every((r) => norm(r) === norm(who))) throw new W.Blocked(`exposure owner did not change to ${who} (shows ${after.join(', ')})`);
  return `exposures assigned to ${who}`;
}

// ── Claim-level denial (WC Loss Details › "Claim Denied?") ─────────────────────────────────────────────────────
async function openLossDetailsGeneral(page) {
  const sub = page.locator('[id="Claim-MenuLinks-Claim_ClaimLossDetailsGroup-ClaimLossDetailsGroup_ClaimLossDetails"]').first();
  if (!await sub.isVisible().catch(() => false)) {
    await page.locator('[id="Claim-MenuLinks-Claim_ClaimLossDetailsGroup"]').first().click();
    await W.settle(page, 2500);
  }
  if (await sub.isVisible().catch(() => false)) { await sub.click(); await W.settle(page, 3500); }
}

// VBR.024 / VBR.028: value 'Denied in Full' | 'Denied in Part' | 'No' | '<none>'.
async function setClaimDenied(page, value = 'Denied in Full') {
  testOnly('setClaimDenied');
  await openLossDetailsGeneral(page);
  const cur = findField(await readScreen(page), 'Claim Denied?');
  if (!cur) throw new W.Blocked('Loss Details has no "Claim Denied?" field');
  const want = value === '<none>' ? '' : value;
  if (norm(cur.value) === norm(want)) return `Claim Denied? already ${value}; ${await revalidate(page)}`;
  if (/claimant number already exists/i.test(await W.abilityToPay(page).catch(() => ''))) await fixClaimantNumber(page);
  await openLossDetailsGeneral(page);
  await editAndSave(page, 'Loss Details Claim Denied?', async () => {
    await selectByLabel(page, 'Claim Denied?', value === '<none>' ? /^<none>$/ : value);
    const r = findField(await readScreen(page), 'Reason for Denial');
    if (r && /^(No|<none>)$/i.test(value) === false && r.kind !== 'text' && !r.value) {
      if (r.kind === 'select') await selectByLabel(page, 'Reason for Denial', /^(?!<none>)./);
      else await fillByLabel(page, 'Reason for Denial', 'OneInc automation — denial rule test');
    }
  });
  const after = findField(await readScreen(page), 'Claim Denied?');
  if (!after || norm(after.value) !== norm(want)) throw new W.Blocked(`Claim Denied? did not stick (shows "${after ? after.value : '?'}")`);
  return `Claim Denied? → ${value}; ${await revalidate(page)}`;
}

// Claim edits can drop the claim below the "Ability to pay" validation level ("A payment cannot be created because
// the claim (or some exposures) has not passed the Ability to Pay validation level" — CONFIRMED 2026-10-21 after a
// Loss Details save). Re-run Actions › Validate Claim + Exposures › Ability to pay, as claimCheck does.
async function revalidate(page) {
  let why = await W.abilityToPay(page).catch((e) => `(could not run Ability to pay: ${e.message})`);
  if (/claimant number already exists/i.test(why)) {
    const fixed = await fixClaimantNumber(page);
    why = await W.abilityToPay(page).catch((e) => `(could not run Ability to pay: ${e.message})`);
    if (!why) return `Ability to pay passed (${fixed})`;
  }
  if (why) throw new W.Blocked(`claim does not pass Ability to pay after the setup: ${why.slice(0, 300)}`);
  return 'Ability to pay passed';
}

// ── Wizard helpers ──────────────────────────────────────────────────────────────────────────────────────────────
// Press Next until the last step, then Finish ONCE and leave the screen as CC shows it — so a WARNING (VBR.028
// "Claim denied in part…") stays on the screen for a `message` check. The core validate step presses Finish a second
// time on warnings-only pages (duplicate check), which would submit the payment and hide the warning. If no warning or
// error appears the payment IS submitted (ONEINC_ALLOW_FINISH=1 required, TEST only).
async function finishOnce(page) {
  testOnly('finishOnce');
  if (process.env.ONEINC_ALLOW_FINISH !== '1') throw new W.Blocked('pressing Finish submits the payment — enable ONEINC_ALLOW_FINISH=1 (TEST only)');
  for (let i = 0; i < 3; i++) {
    const st = await W.currentStep(page);
    if (!st || st.n >= st.of) break;
    await W.nextFillingServicePeriod(page);
    const after = await W.currentStep(page);
    if (after && after.n === st.n) {
      const s = await readScreen(page);
      // Stopped on Next: leave it on screen (the message check decides).
      if (s.messages.length || s.south) return `stopped at Next on step ${st.n}: ${[...s.messages, s.south].join(' / ').slice(0, 200)}`;
    }
  }
  await W.answerUnansweredNo(page);
  for (let r = 0; r < 2; r++) if (!(await W.fillRequiredEmpties(page)).length) break;
  const inv = findField(await readScreen(page), 'Invoice Number/Remarks');
  if (inv && !inv.value && inv.kind !== 'text') await W.fill(page, 'Invoice Number/Remarks', `ONEINC-${Date.now()}`).catch(() => {});
  await W.clickButton(page, 'Finish');
  for (let t = 0; t < 30; t++) {
    if (!await W.inWizard(page)) return 'wizard closed after Finish (payment submitted)';
    const s = await readScreen(page);
    if (s.messages.length || s.south) return `Finish answered: ${[...s.messages, s.south].join(' / ').slice(0, 200)}`;
    await page.waitForTimeout(1000);
  }
  return 'Finish: no response';
}


// "This claimant number already exists on another claim" (claimant numbers are unique across a policy's claims, and a
// later FNOL on the same policy can take ours — CONFIRMED 2026-10-21 on WC Loss Details): pick another number on the
// claim's Loss Details (WC) or exposures, trying unused-looking high numbers first.
async function fixClaimantNumber(page) {
  testOnly('fixClaimantNumber');
  await openLossDetailsGeneral(page);
  for (let attempt = 0; attempt < 8; attempt++) {
    await W.clickButton(page, 'Edit');
    const f = findField(await readScreen(page), 'Claimant Number');
    if (!f || f.kind !== 'select') { await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {}); throw new W.Blocked('Loss Details has no editable Claimant Number'); }
    const opts = (f.options || []).filter((o) => /^\d+$/.test(o) && o !== f.value);
    const pick = opts[opts.length - 1 - ((Date.now() / 1000 | 0) + attempt * 7) % Math.max(1, Math.ceil(opts.length / 2))];
    await selectByLabel(page, 'Claimant Number', new RegExp(`^${pick}$`));
    await W.clickButton(page, 'Update');
    await page.waitForTimeout(1500);
    if (!await editing(page)) return `claimant number changed to ${pick}`;
    const msgs = (await readScreen(page)).messages.join(' / ');
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    await W.settle(page, 2000);
    if (!/claimant number/i.test(msgs)) throw new W.Blocked(`Loss Details could not be saved: ${msgs.slice(0, 300)}`);
  }
  throw new W.Blocked('no free claimant number found on this policy');
}

// Step 1 payee = the INSURED, read from the claim header. Core getParties() stops the insured name at DoL/St/Adj only, so on
// a WC claim ("Ins: Devine Insulation Inc Clmt: Simon Darley DoL: …") it returns "Devine Insulation Inc Clmt: Simon Darley" and
// no payee matches (core-file bug, worked around here).
async function selectInsuredPayee(page) {
  const ins = await page.evaluate(() => {
    const m = /Ins:\s*(.+?)\s+(Clmt:|DoL:|St:|Adj:|$)/.exec((document.body.innerText || '').replace(/\s+/g, ' '));
    return m ? m[1].trim() : '';
  });
  if (!ins) throw new W.Blocked('could not read the insured from the claim header');
  const names = ((await W.optionsOf(page, 'Name')) || []).map((o) => o.t);
  const pick = names.find((n) => norm(n) === norm(ins));
  if (!pick) throw new W.Blocked(`the insured "${ins}" is not among the payee names (${names.join(', ')})`);
  await W.select(page, 'Name', pick);
  return pick;
}

// CPD.033: the claimant's address Country. where = 'Canada' (non-US address: Toronto, Ontario) or 'US' (restores the
// 1195 River Rd, Marietta, PA 17547 address claimCheck gives claimants). Parties Involved › claimant › Edit.
async function setClaimantCountry(page, where = 'Canada') {
  testOnly('setClaimantCountry');
  await W.cancelWizard(page);
  await W.navigate(page, 'parties');
  const idx = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr') && r.querySelector('[id$="-Name"]'));
    const r = rows.find((x) => /\bClaimant\b/.test(x.innerText));
    if (r) r.setAttribute('data-setupa-claimant', '1');
    return !!r;
  });
  if (!idx) throw new W.Blocked('no contact with the Claimant role on Parties Involved');
  await page.locator('tr[data-setupa-claimant="1"] [id$="-Name"]').first().click();
  await W.settle(page, 2500);
  await W.clickButton(page, 'Edit');
  const country = page.locator('select[name$="GlobalAddressInputSet-Country"]').first();
  const want = where === 'US' ? 'United States' : 'Canada';
  const cur = await country.evaluate((x) => (x.options[x.selectedIndex] || {}).text);
  if (cur === want) { await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {}); await W.settle(page, 1500); return `claimant country already ${want}`; }
  const pick = async (sel, re) => {
    const o = await sel.locator('option').evaluateAll((os) => os.map((x) => ({ v: x.value, t: x.textContent.trim() })));
    const m = o.find((x) => re.test(x.t));
    if (m) { await sel.selectOption(m.v).catch(() => {}); await W.settle(page, 1500); }
  };
  await pick(country, new RegExp(`^${want}$`));
  const fill = async (suffix, v) => {
    const el = page.locator(`input[name$="GlobalAddressInputSet-${suffix}"]`).first();
    if (await el.isVisible().catch(() => false)) { await el.fill(v); await el.press('Tab').catch(() => {}); await page.waitForTimeout(400); }
  };
  await fill('AddressLine1', where === 'US' ? '1195 River Rd' : '100 King St W');
  await fill('City', where === 'US' ? 'Marietta' : 'Toronto');
  await pick(page.locator('select[name$="GlobalAddressInputSet-State"]').first(), where === 'US' ? /^Pennsylvania$/ : /^Ontario$/);
  await fill('PostalCode', where === 'US' ? '17547' : 'M5X 1A9');
  await W.clickButton(page, 'Update');
  await page.waitForTimeout(1500);
  if (await editing(page)) {
    const s = await readScreen(page);
    const msgs = [...s.messages, s.south].join(' / ');
    if (!/error|required|invalid|must/i.test(msgs) && await editing(page)) { await W.clickButton(page, 'Update'); await page.waitForTimeout(1500); }
  }
  if (await editing(page)) {
    const msgs = [...(await readScreen(page)).messages].join(' / ');
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new W.Blocked(`claimant address (${where}) could not be saved: ${msgs.slice(0, 300)}`);
  }
  return `claimant address country → ${want}`;
}

// Cancel whatever wizard is open (recipes that submit one payment via finishOnce, then start another).
async function closeWizard(page) {
  await W.cancelWizard(page);
  await W.settle(page, 1500);
  return 'wizard closed';
}

// ── Aggregate limit (VBR.035) ────────────────────────────────────────────────────────────────────────────────────
// Policy › Aggregate Limits: removes every existing row, then (amount given) adds a Policy-level "Limit" of that amount
// counting all incurred costs. amount = null → none. Returns what was done. Idempotent for the same amount.
async function setAggregateLimit(page, amount) {
  testOnly('setAggregateLimit');
  const openList = async () => {
    const sub = page.locator('[id="Claim-MenuLinks-Claim_ClaimPolicyGroup-ClaimPolicyGroup_ClaimPolicyAggregateLimits"]').first();
    if (!await sub.isVisible().catch(() => false)) { await page.locator('[id="Claim-MenuLinks-Claim_ClaimPolicyGroup"]').first().click(); await W.settle(page, 2000); }
    await sub.click();
    await W.settle(page, 3000);
  };
  await openList();
  const rows = async () => page.evaluate(() => [...document.querySelectorAll('tr[id*="AggregateLimit"][id*="LV-"]')].filter((r) => r.offsetParent && !r.querySelector('tr')).map((r) => r.innerText.replace(/\s+/g, ' ').trim()).filter((t) => /\d/.test(t)));
  const before = await rows();
  const want = amount == null ? null : Number(amount);
  const money = (t) => Number((/\$?([\d,]+(?:\.\d+)?)/.exec(t) || [])[1]?.replace(/,/g, ''));
  if (want == null && !before.length) return 'no aggregate limit (already none)';
  if (want != null && before.length === 1 && money(before[0]) === want) return `aggregate limit already ${want}`;
  // Remove existing rows (the list is a plain editable LV: tick the select-all box, Delete).
  if (before.length) {
    await page.locator('[id$="AggregateLimitsLV-_Checkbox"]:visible, [id*="AggregateLimits"][id$="-_Checkbox"]:visible').first().click().catch(() => {});
    await W.clickButton(page, 'Delete');
    await W.settle(page, 2500);
    if ((await rows()).length) throw new W.Blocked('could not delete the existing aggregate limit(s)');
  }
  if (want == null) return 'aggregate limit removed';
  await W.clickButton(page, 'Add');
  await selectByLabel(page, 'Applies To', 'Policy');
  await selectByLabel(page, 'Aggregate Type', 'Limit');
  await fillByLabel(page, 'Amount', want.toFixed(2));
  await selectByLabel(page, 'Count Towards Limit', 'All incurred costs');
  await W.clickButton(page, 'Update');
  await page.waitForTimeout(1500);
  if (await editing(page)) {
    const msgs = [...(await readScreen(page)).messages].join(' / ');
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new W.Blocked(`aggregate limit could not be saved: ${msgs.slice(0, 300)}`);
  }
  await openList();
  const after = await rows();
  if (!after.length) throw new W.Blocked('aggregate limit did not appear in the list after saving');
  return `aggregate limit set to ${want}`;
}

// ── WC indemnity / Medicare ─────────────────────────────────────────────────────────────────────────────────────
const exposureLink = (page, name) => page.locator('[id^="Claim-MenuLinks-Claim_ClaimLossDetailsGroup-"][id$="_LossDetailsExposureDetail"]').filter({ hasText: name }).first();
// Opens a WC exposure's detail screen (Loss Details › Medical | Indemnity).
async function openWcExposure(page, name) {
  await openLossDetailsGeneral(page);
  const l = exposureLink(page, name);
  if (!await l.isVisible().catch(() => false)) throw new W.Blocked(`this claim has no "${name}" exposure under Loss Details`);
  await l.click();
  await W.settle(page, 3000);
}

// Sets fields on the WC Indemnity exposure's edit screen, e.g. { 'Disability Weekly Rate': '500.00',
// 'Reason TTD or TPD Ended': /^3/, 'Benefit Offset Code': '<none>' }. Inputs are filled, selects chosen (string or RegExp;
// '<none>' clears). Idempotent: nothing is saved when every field already shows the wanted value.
async function setIndemnityExposure(page, values) {
  testOnly('setIndemnityExposure');
  await openWcExposure(page, 'Indemnity');
  const same = (s, label, want) => {
    const f = findField(s, label);
    const strip = (x) => norm(x).replace(/[$,]/g, '');
    return f && (want instanceof RegExp ? want.test(f.value || '') : strip(f.value || '') === strip(want === '<none>' ? '' : want));
  };
  const s0 = await readScreen(page);
  if (Object.entries(values).every(([l, v]) => same(s0, l, v))) return 'Indemnity exposure already set';
  await editAndSave(page, 'Indemnity exposure', async () => {
    for (const [label, want] of Object.entries(values)) {
      const f = findField(await readScreen(page), label);
      if (!f) throw new W.Blocked(`Indemnity exposure has no "${label}" field`);
      if (f.kind === 'select') await selectByLabel(page, label, want === '<none>' ? /^<none>$/ : want);
      else await fillByLabel(page, label, want === '<none>' ? '' : want);
    }
  });
  await openWcExposure(page, 'Indemnity');
  const s1 = await readScreen(page);
  const bad = Object.entries(values).filter(([l, v]) => !same(s1, l, v)).map(([l]) => l);
  if (bad.length) throw new W.Blocked(`Indemnity exposure did not keep: ${bad.join(', ')}`);
  return `Indemnity exposure set: ${Object.entries(values).map(([l, v]) => `${l}=${v}`).join(', ')}`;
}

// Medicare tab of the WC Medical exposure: "Is Claimant a Medicare Beneficiary?" Yes/No (+ the ORM answer and the
// "Cause of Loss Description" the save insists on). The claimant birthdate / SSN-or-HICN messages are only warnings.
async function setMedicareBeneficiary(page, value = 'Yes') {
  testOnly('setMedicareBeneficiary');
  await openWcExposure(page, 'Medical');
  await page.getByText('Medicare', { exact: true }).first().click();
  await W.settle(page, 2500);
  const cur = findField(await readScreen(page), 'Is Claimant a Medicare Beneficiary?');
  if (cur && norm(cur.value) === norm(value)) return `Medicare beneficiary already ${value}`;
  await W.clickButton(page, 'Edit');
  await selectByLabel(page, 'Is Claimant a Medicare Beneficiary?', value);
  const orm = findField(await readScreen(page), 'Is There ORM?');
  if (orm && value === 'Yes') await selectByLabel(page, 'Is There ORM?', 'No');
  for (let i = 0; i < 3; i++) {
    await W.clickButton(page, 'Update');
    await page.waitForTimeout(1500);
    if (!await editing(page)) break;
    const s = await readScreen(page);
    const msgs = [...s.messages, s.south].join(' / ');
    if (/Missing required field/i.test(msgs)) {
      await page.getByText('Details', { exact: true }).first().click().catch(() => {});
      await W.settle(page, 1500);
      const d = findField(await readScreen(page), 'Cause of Loss Description');
      if (d && d.kind === 'select' && !d.value.replace(/<none>/i, '')) await selectByLabel(page, 'Cause of Loss Description', /^(?!<none>).+/);
      if ((await fillRequiredOnEdit(page)).length === 0 && !d) break;
    } // else warnings only (birthdate / SSN): the next Update accepts them
  }
  if (await editing(page)) {
    const msgs = [...(await readScreen(page)).messages].join(' / ');
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    throw new W.Blocked(`Medicare beneficiary could not be saved: ${msgs.slice(0, 300)}`);
  }
  await page.getByText('Medicare', { exact: true }).first().click().catch(() => {});
  await W.settle(page, 1500);
  const after = findField(await readScreen(page), 'Is Claimant a Medicare Beneficiary?');
  if (!after || norm(after.value) !== norm(value)) throw new W.Blocked(`Medicare beneficiary did not stick (shows "${after ? after.value : '?'}")`);
  return `Medicare beneficiary → ${value}`;
}

// WC claim: Severity "Lost Time" (+ Date Disability Began / Time Employee Began Work) is what makes CC create the
// Indemnity (Lost Wages) exposure with its own reserve (CONFIRMED 2026-10-21 on WC-PA-01-26-0748482: Medical → Medical +
// Indemnity, $4,000 reserve). Idempotent.
async function ensureLostTimeSeverity(page) {
  testOnly('ensureLostTimeSeverity');
  await openLossDetailsGeneral(page);
  const s = await readScreen(page);
  const sev = findField(s, 'Severity');
  const hasIndemnity = await exposureLink(page, 'Indemnity').isVisible().catch(() => false);
  if (sev && /lost time/i.test(sev.value) && hasIndemnity) return 'Severity already Lost Time (Indemnity exposure present)';
  const dol = await page.evaluate(() => ((document.body.innerText || '').match(/DoL:\s*(\d{2}\/\d{2}\/\d{4})/) || [])[1]);
  await editAndSave(page, 'Severity Lost Time', async () => {
    await selectByLabel(page, 'Severity', 'Lost Time');
    const d = findField(await readScreen(page), 'Date Disability Began');
    if (d && !d.value) await fillByLabel(page, 'Date Disability Began', dol);
    const t = findField(await readScreen(page), 'Time Employee Began Work');
    if (t && t.kind === 'input' && !t.value) await fillByLabel(page, 'Time Employee Began Work', '08:00 AM');
  });
  await W.settle(page, 2000);
  if (!await exposureLink(page, 'Indemnity').isVisible().catch(() => false)) throw new W.Blocked('Severity saved as Lost Time but no Indemnity exposure appeared');
  return 'Severity → Lost Time (Indemnity exposure created)';
}

// Payment wizard Step 2: choose the line-item category by text (regex source), e.g. '^05' (TTD), '^03' (PPD scheduled),
// '^49' (lump sum). The category select sits in the Line Items grid.
async function selectLineCategory(page, re) {
  const cat = page.locator('[id*="LineItemsLV"] select').first();
  await cat.waitFor({ state: 'visible', timeout: 10000 });
  const opts = await cat.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));
  const o = opts.find((x) => new RegExp(re).test(x.t));
  if (!o) throw new W.Blocked(`Line Items category ${re} is not offered (options: ${opts.map((x) => x.t).join(' | ')})`);
  await cat.selectOption(o.v);
  await W.settle(page, 2500);
  return o.t;
}

// Quick Payment from a SPECIFIC reserve row of Financials › Summary (core openFinancialsRowMenu only picks the first row
// with open reserve): rowRe matches the row text, e.g. /Indemnity/.
async function openQuickOnLine(page, rowRe) {
  await W.navigate(page, 'financials');
  await page.getByRole('button', { name: 'options', exact: true }).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const idx = await page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const rows = [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr')
      && [...r.querySelectorAll('[role=button]')].some((b) => (b.getAttribute('aria-label') || b.innerText || '').trim() === 'options'));
    // The leaf row ("Other USD $4,000") does not name its exposure: match any ANCESTOR row (id prefix) whose text matches.
    const all = [...document.querySelectorAll('tr[id$="-FSRow"]')];
    const stem = (r) => r.id.replace(/-FSRow$/, '');
    const i = rows.findIndex((r) => all.some((a) => (stem(r) === stem(a) || stem(r).startsWith(stem(a) + '-')) && re.test(a.innerText)));
    rows.forEach((r, k) => r.setAttribute('data-setupa-row', String(k)));
    return i;
  }, rowRe instanceof RegExp ? rowRe.source : String(rowRe));
  if (idx < 0) throw new W.Blocked(`no Financials reserve row matching ${rowRe}`);
  await page.locator(`tr[data-setupa-row="${idx}"]`).getByRole('button', { name: 'options', exact: true }).first().click();
  await W.settle(page, 1200);
  const mi = page.getByRole('menuitem', { name: /^Quick (Payment|Check)$/ }).first();
  if (!await mi.isVisible().catch(() => false)) { await W.closeMenus(page); throw new W.Blocked('row menu has no Quick Payment item'); }
  await mi.click();
  await page.getByRole('button', { name: 'Next', exact: true }).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  await W.settle(page, 2500);
  if (!await W.inWizard(page)) throw new W.Blocked(`Quick Payment did not open — ${await W.newPaymentErrorText(page) || 'no message'}`);
}

// Profile WCA_LW prepare hook: Lost Time severity (→ Indemnity exposure + reserve), Medicare beneficiary = Yes, then CC's
// own Ability to pay validation. Returns what was done.
async function prepareLostWages(page, claim, out) {
  const done = [];
  done.push(await ensureLostTimeSeverity(page));
  done.push(await setMedicareBeneficiary(page, 'Yes'));
  done.push(await revalidate(page).catch((e) => `(Ability to pay: ${e.message.slice(0, 120)})`));
  return done.join('; ');
}

module.exports = {
  setClaimantCountry, selectInsuredPayee, closeWizard, setAggregateLimit, openWcExposure, setIndemnityExposure, setMedicareBeneficiary, ensureLostTimeSeverity, selectLineCategory, openQuickOnLine, fixClaimantNumber, revalidate, prepareLostWages, finishOnce, editAndSave, fillRequired: fillRequiredOnEdit, selectByLabel, fillByLabel, exposureCount, openExposure, openLossDetailsGeneral,
  setExposureCoverageDenied, setClaimDenied, assignExposuresTo,
};
