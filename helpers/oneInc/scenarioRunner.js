/**
 * helpers/oneInc/scenarioRunner.js
 * Runs ONE automated OneInc scenario (a recipe from scenarioRecipes.js) against the live ClaimCenter Cloud screens
 * and returns its result: every step executed, every check with expected vs actual, PASS / FAIL / BLOCKED, the claim
 * used, timings and the evidence files (a screenshot + screen dump per checked screen, plus one on any error).
 *
 * Status rules (as required for this suite):
 *   PASS     every check ran and passed (at least one check must have run — "the script finished" is not a pass)
 *   FAIL     a check failed, or the app errored during a mandatory step
 *   BLOCKED  a precondition / environment issue stopped the scenario before its checks could decide anything
 *            (login, claim access, missing claim data, a rule that can only be confirmed by submitting a payment)
 * A FAIL whose cause is "the expected field / option / message is not there" is flagged `missingElement`, which the
 * report presents as "may be pending development" (per user direction 2026-10-20) next to the story's Jira status.
 *
 * Never saves anything: the wizard is always cancelled at the end, and Finish is pressed only for `validate` steps
 * when ONEINC_ALLOW_FINISH=1 (never on a tier other than test/dev).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { readScreen, findField, norm } = require('./screenReader');
const W = require('./wizardDriver');
const claimPicker = require('./claimPicker');

const CHECK_KEYS = ['field', 'absent', 'header', 'button', 'message', 'text', 'require', 'fieldKind'];
// `menu` and `nav` are both a step (string: which menu / screen to open) and a check (object: what must be there).
const isCheck = (item) => CHECK_KEYS.some((k) => k in item) || ['menu', 'nav'].some((k) => item[k] && typeof item[k] === 'object');
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
const TIER = (process.env.CC_TIER || 'test').toLowerCase();
const ALLOW_FINISH = process.env.ONEINC_ALLOW_FINISH === '1' && ['test', 'dev'].includes(TIER);

// Claim-level problems: worth retrying the same scenario on the next candidate claim of the profile.
const CLAIM_LEVEL = /reserve line|Reserve Line has no|Name list is empty|wizard did not open|no reserve rows|no "(claimant|insured)" payee|permission|could not open claim|open \(positive\) remaining reserve|Available Reserves/i;

function describeItem(item) {
  const k = Object.keys(item)[0];
  const v = item[k];
  if (k === 'open') return `Open the ${v === 'quick' ? 'Quick Payment wizard (Financials › reserve row › Quick Payment)' : v === 'financials' ? 'Full Check wizard (Financials › reserve row › Create Payment)' : 'Full Check wizard (Actions › New Transaction › New Payment)'}`;
  if (k === 'payee') return `Select the ${v} as the payee`;
  if (k === 'call') return `Run ${v[0]}(${v.slice(1).map((a) => JSON.stringify(a)).join(', ')})`;
  if (k === 'joint') return `Add joint payee(s): ${v.map((p) => p.who + (p.type ? ` (${p.type})` : '')).join(', ')}`;
  if (k === 'next') return 'Click Next';
  if (k === 'reserve') return `Select a Reserve Line (${{ open: 'one with open Available Reserves', existing: 'first existing line', new: '"Expense OR First and Final" new line', zero: 'one with no remaining reserve' }[v] || v})`;
  if (k === 'select') return `Set "${v[0]}" = ${v[1]}`;
  if (k === 'fill') return `Enter "${v[0]}" = ${v[1]}`;
  if (k === 'answer') return `Answer "${v[0]}" = ${v[1]}`;
  if (k === 'step2') return `Fill the payment details (${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(', ') || 'minimum valid data'})`;
  if (k === 'menu') return `Open the ${v === 'actions' ? 'Actions' : 'Financials reserve-row'} menu`;
  if (k === 'nav') return `Navigate to ${v}`;
  if (k === 'openFirstRow') return `Open the first ${v} on the list`;
  if (k === 'click') return `Click "${v}"`;
  if (k === 'validate') return v.expect ? `Trigger validation, expecting: ${v.expect.source}` : 'Trigger validation, expecting no error';
  if (k === 'expectStep') return `Confirm the wizard reached Step ${v}`;
  if (k === 'snapshotWarning') return 'Note whether the payee contact-details warning is shown';
  return k;
}

// Newest check on Financials › Checks (highest check number) whose Gross Amount equals `amount` ("$1.37").
async function newestCheck(page, amount) {
  await W.navigate(page, 'checks').catch(() => {});
  await page.locator('tr[id*="ChecksLV-0-"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const rows = await page.evaluate(() => [...document.querySelectorAll('tr[id*="ChecksLV-"]')].map((r) => {
    const cell = (k) => ((r.querySelector(`[id$="-${k}"]`) || {}).innerText || '').trim();
    return { number: cell('CheckNumber'), amount: cell('GrossAmount'), status: cell('Status') };
  }).filter((x) => /^\d+$/.test(x.number)));
  const want = String(amount || '').replace(/[^0-9.]/g, '');
  const hits = rows.filter((x) => !want || x.amount.replace(/[^0-9.]/g, '') === want);
  return hits.sort((a, b) => Number(b.number) - Number(a.number))[0] || null;
}

async function runScenario(page, tc, recipe, ctx) {
  const started = Date.now();
  const res = {
    scenarioId: tc.scenarioId, story: tc.story, storyTitle: tc.storyTitle, sheet: tc.sheet, tcId: tc.tcId, name: tc.name,
    description: tc.description, precondition: tc.precondition, priority: tc.priority, type: tc.type,
    expected: tc.steps.map((s) => s.expected).filter(Boolean).filter((e) => !/policy is issued|creates a claim/i.test(e)).join('\n'),
    automation: 'AUTOMATED', profile: recipe.profile, notes: recipe.notes || '',
    status: 'NOT EXECUTED', reason: '', stepsExecuted: [], checks: [], evidence: [], claim: null, claimsTried: [],
    startedAt: new Date(started).toISOString(),
  };
  const shotDir = path.join(ctx.dirs.screenshots, safe(tc.scenarioId));
  const evDir = path.join(ctx.dirs.evidence, safe(tc.scenarioId));
  fs.mkdirSync(shotDir, { recursive: true });
  fs.mkdirSync(evDir, { recursive: true });
  let shotN = 0;
  const capture = async (tag, screen) => {
    shotN++;
    const base = `${String(shotN).padStart(2, '0')}-${safe(tag)}`;
    const png = path.join(shotDir, `${base}.png`);
    await page.screenshot({ path: png, fullPage: true }).catch(() => {});
    res.evidence.push(png);
    if (screen) {
      const { body, ...rest } = screen;
      const js = path.join(evDir, `${base}.json`);
      fs.writeFileSync(js, JSON.stringify(rest, null, 2));
      res.evidence.push(js);
    }
    return png;
  };

  const claims = (() => {
    try {
      const list = claimPicker.candidates(recipe.profile, ctx.maxClaims || 3);
      // Parallel workers: when the pool holds several claims of this type, worker N starts on the N-th one so two
      // browsers aren't in the same claim's payment wizard at once.
      const poolN = Math.min(claimPicker.poolClaims(recipe.profile).length, list.length);
      const w = ctx.worker || 0;
      if (poolN > 1 && w) { const head = list.slice(0, poolN); return [...head.slice(w % poolN), ...head.slice(0, w % poolN), ...list.slice(poolN)]; }
      return list;
    } catch (e) { return []; }
  })();
  if (!claims.length) {
    return finish(res, started, 'BLOCKED', `No ${recipe.profile} test claim available (set ONEINC_CLAIM_${recipe.profile})`);
  }

  for (const claim of claims) {
    res.claimsTried.push(claim);
    res.stepsExecuted = [];
    res.checks = [];
    let blockedWhy = null;
    try {
      await W.cancelWizard(page);
      ctx.log(`[OneInc] ${tc.scenarioId}: opening claim ${claim}`);
      try {
        await W.openClaim(page, claim, ctx.log);
      } catch (e) {
        if (e instanceof W.Blocked) throw e;
        throw new W.Blocked(`could not open claim ${claim}: ${e.message.split('\n')[0]}`);
      }
      res.loginUsed = page.__oneIncUser === 'admin' ? 'admin (CC_ADMIN_USER)' : 'standard (CC_USER)';
      // Parties (insured / claimants) are read once per claim; that visit to Exposures is the only extra navigation.
      if (ctx.lastClaim !== claim) {
        page.__oneIncParties = null;
        ctx.lastClaim = claim;
        await W.getParties(page);
      }
      res.claim = claim;
      await execute(page, [...recipe.steps, ...(recipe.checks || [])], res, ctx, capture);
    } catch (e) {
      if (e instanceof W.Blocked) {
        blockedWhy = e.message;
        // Evidence of WHY, taken before the wizard is cancelled (it used to be taken after, showing an empty claim).
        await capture('blocked', await readScreen(page).catch(() => null));
      } else {
        const screen = await readScreen(page).catch(() => null);
        await capture('error', screen);
        res.error = e.message.split('\n')[0];
        res.stack = String(e.stack || '').split('\n').slice(0, 8).join('\n');
        res.automationError = true;
        await W.cancelWizard(page).catch(() => {});
        return finish(res, started, 'FAIL', `Error during "${res.stepsExecuted.slice(-1)[0] || 'setup'}": ${res.error}`);
      }
    }
    await W.cancelWizard(page).catch(() => {});
    if (blockedWhy) {
      if (CLAIM_LEVEL.test(blockedWhy) && claims.indexOf(claim) < claims.length - 1) {
        ctx.log(`[OneInc] ${tc.scenarioId}: claim ${claim} not usable (${blockedWhy}) — trying the next ${recipe.profile} claim`);
        claimPicker.forget(recipe.profile, claim);
        continue;
      }
      return finish(res, started, 'BLOCKED', blockedWhy);
    }
    claimPicker.remember(recipe.profile, claim);
    return rollUp(res, started);
  }
  return finish(res, started, 'BLOCKED', 'no candidate claim could be used');
}

function finish(res, started, status, reason) {
  res.status = status;
  res.reason = reason;
  res.finishedAt = new Date().toISOString();
  res.durationMs = Date.now() - started;
  res.actual = res.checks.length ? res.checks.map((c) => `[${c.result}] ${c.description}: ${c.actual}`).join('\n') : reason;
  return res;
}

function rollUp(res, started) {
  const r = res.checks.map((c) => c.result);
  if (r.includes('FAIL')) {
    res.missingElement = res.checks.some((c) => c.result === 'FAIL' && c.missing);
    return finish(res, started, 'FAIL', res.checks.filter((c) => c.result === 'FAIL').map((c) => `${c.description} — expected ${c.expected}; actual ${c.actual}`).join(' | '));
  }
  if (r.includes('BLOCKED')) return finish(res, started, 'BLOCKED', res.checks.filter((c) => c.result === 'BLOCKED').map((c) => c.actual).join(' | '));
  if (!r.includes('PASS')) return finish(res, started, 'BLOCKED', 'no check ran');
  return finish(res, started, 'PASS', '');
}

async function execute(page, items, res, ctx, capture) {
  let screen = null;           // cached screen for consecutive checks; reset after any action
  let captured = false;
  const state = { menuItems: [], warningSeen: null };
  const current = async () => {
    if (!screen) { screen = await readScreen(page); captured = false; }
    return screen;
  };
  const record = async (row) => {
    const s = await current();
    if (!captured) { row.screenshot = await capture(`check-${res.checks.length + 1}`, s); captured = true; }
    res.checks.push(row);
    ctx.log(`[OneInc] ${res.scenarioId}:   ${row.result} — ${row.description} (actual: ${String(row.actual).slice(0, 140)})`);
  };

  for (const item of items) {
    if (isCheck(item)) {
      const s = await current();
      await evaluate(item, s, state, record);
      continue;
    }
    const label = describeItem(item);
    res.stepsExecuted.push(label);
    ctx.log(`[OneInc] ${res.scenarioId}: step — ${label}`);
    screen = null;
    const k = Object.keys(item)[0];
    const v = item[k];
    if (k === 'open') {
      await W.openPayment(page, v === 'quick' ? 'quick' : v === 'financials' ? 'financials' : 'actions', { needZeroReserve: !!item.zeroReserve, needOpenReserve: !item.zeroReserve && (!!item.needOpenReserve || v === 'quick') });
    } else if (k === 'payee') await W.selectPayee(page, v);
    else if (k === 'joint') await W.addJointPayees(page, v);
    // Generic hook for extension modules: { call: ['<module>.<fn>', ...args] } runs require('./<module>')[fn](page, ...args).
    else if (k === 'call') { const [modFn, ...args] = v; const [mod, fn] = modFn.split('.'); await require(`./${mod}`)[fn](page, ...args); }
    else if (k === 'next') await W.nextFillingServicePeriod(page);
    else if (k === 'reserve') await W.selectReserveLine(page, v);
    else if (k === 'select') await W.select(page, v[0], v[1]);
    else if (k === 'fill') await W.fill(page, v[0], await resolveValue(page, v[1]));
    else if (k === 'answer') await W.answer(page, v[0], v[1]);
    else if (k === 'step2') await W.completePaymentsStep(page, v);
    else if (k === 'click') await W.clickButton(page, v);
    else if (k === 'nav') await W.navigate(page, v);
    else if (k === 'menu') {
      state.menuItems = v === 'actions' ? await W.openActionsMenu(page) : await W.openFinancialsRowMenu(page);
      screen = await readScreen(page);
      await capture(`menu-${v}`, screen);
      captured = true;
      await W.closeMenus(page);
    } else if (k === 'openFirstRow') {
      // Cloud list rows have no <a>: a check opens from its "…LV-0-CheckNumber_button" div, a contact from its row's
      // Name cell (CONFIRMED 2026-10-21 on Checks / Parties Involved). The grid renders after the screen — wait for it.
      const row0 = page.locator('tr[id*="LV-0-"]:visible').first();
      await row0.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      const link = page.locator('[id*="LV-0-"][id$="_button"]:visible, [id*="LV-0-"] a:visible, [id*="LV-0-"] [role=link]:visible, [id*="LV-0-"][id$="-Name"]:visible').first();
      if (!await link.isVisible().catch(() => false)) throw new W.Blocked(`no ${v} on the list to open`);
      await link.click();
      await W.settle(page, 3500);
    } else if (k === 'snapshotWarning') {
      const s = await readScreen(page);
      state.warningSeen = v.test([s.messages.join(' '), s.south, s.body.slice(0, 4000)].join(' '));
    } else if (k === 'expectStep') {
      const st = await W.currentStep(page);
      if (!st || st.n !== v) {
        const s = await readScreen(page);
        throw new W.Blocked(`wizard did not reach Step ${v} (still on ${st ? `Step ${st.n}: ${st.title}` : 'an unknown screen'})${s.messages.length ? ' — CC says: ' + s.messages.slice(0, 4).join(' / ') : ''}`);
      }
    } else if (k === 'validate') {
      await validate(page, v, res, ctx, capture, record, () => { screen = null; });
    } else {
      throw new Error(`unknown recipe step "${k}"`);
    }
  }
}

// Recipe values may be dates relative to the claim: "DOL", "DOL-5", "DOL+3" (loss date from the claim header
// "DoL: MM/DD/YYYY"), "TODAY", "TODAY+5". Anything else is used as-is.
async function resolveValue(page, value) {
  const m = /^(DOL|TODAY)([+-]\d+)?$/.exec(String(value));
  if (!m) return value;
  let base = new Date();
  if (m[1] === 'DOL') {
    const dol = await page.evaluate(() => ((document.body.innerText || '').match(/DoL:\s*(\d{2}\/\d{2}\/\d{4})/) || [])[1]).catch(() => null);
    if (!dol) throw new W.Blocked('could not read the claim\'s loss date (DoL) from the header');
    base = new Date(dol);
  }
  base.setDate(base.getDate() + Number(m[2] || 0));
  return `${String(base.getMonth() + 1).padStart(2, '0')}/${String(base.getDate()).padStart(2, '0')}/${base.getFullYear()}`;
}

function row(type, description, expected, actual, result, extra = {}) {
  return { type, description, expected, actual, result, ...extra };
}

async function evaluate(item, s, state, record) {
  if (item.field) {
    const q = item.field;
    const f = findField(s, q.label);
    const want = [];
    if (q.required === true) want.push('required'); if (q.required === false) want.push('not required');
    if (q.editable) want.push('editable'); if (q.readonly) want.push('read-only');
    if (q.includes) want.push(`options include ${q.includes.join(', ')}`);
    if (q.excludes) want.push(`options exclude ${q.excludes.join(', ')}`);
    if (q.value) want.push(`value matches ${q.value}`);
    if (q.radios) want.push(`Yes/No choices`);
    const expected = `"${q.label}" visible${want.length ? ', ' + want.join(', ') : ''}`;
    if (!f) {
      if (q.unlessBlocked) return record(row('field', `"${q.label}" shown`, expected, `not on the screen — ${q.unlessBlocked}`, 'BLOCKED'));
      return record(row('field', `"${q.label}" shown`, expected, 'field is not on the screen', 'FAIL', { missing: true }));
    }
    const problems = [];
    let missing = false;
    const editable = !f.readonly && !f.disabled && ['select', 'input', 'masked', 'radio'].includes(f.kind);
    if (q.required === true && !f.required) problems.push('not marked required');
    if (q.required === false && f.required) problems.push('marked required');
    if (q.editable && !editable) problems.push('not editable');
    if (q.readonly && editable) problems.push('editable (expected read-only)');
    const opts = (f.options || (f.radios || []).map((r) => r.label)).map((o) => o.trim());
    const has = (o) => opts.some((x) => norm(x) === norm(o) || norm(x).startsWith(norm(o)));
    if (q.includes) { const miss = q.includes.filter((o) => !has(o)); if (miss.length) { problems.push(`missing option(s) ${miss.join(', ')}`); missing = true; } }
    if (q.excludes) { const extra = q.excludes.filter((o) => has(o)); if (extra.length) problems.push(`has retired option(s) ${extra.join(', ')}`); }
    if (q.radios && !q.radios.every(has)) problems.push(`choices are ${opts.join('/') || 'none'}`);
    if (q.value && !q.value.test(f.value || '')) problems.push(`value is "${f.value || ''}"`);
    const actual = `shown${f.required ? ', required' : ''}${editable ? ', editable' : ', read-only'}${f.value ? `, value "${String(f.value).slice(0, 60)}"` : ''}${opts.length ? `, options: ${opts.slice(0, 15).join(' | ')}` : ''}${problems.length ? ' — ' + problems.join('; ') : ''}`;
    return record(row('field', `"${q.label}" shown`, expected, actual, problems.length ? 'FAIL' : 'PASS', { missing }));
  }
  if (item.absent) {
    const lbl = norm(item.absent.label).replace(/[?*:]+$/, '');
    const f = s.fields.find((x) => norm(x.label).replace(/[?*:]+$/, '') === lbl);
    return record(row('absent', `"${item.absent.label}" not shown`, 'not displayed', f ? `displayed (value "${String(f.value || '').slice(0, 60)}")` : 'not displayed', f ? 'FAIL' : 'PASS'));
  }
  if (item.fieldKind) {
    const f = findField(s, item.fieldKind.label);
    const ok = f && f.kind === item.fieldKind.kind;
    return record(row('fieldKind', `"${item.fieldKind.label}" is a ${item.fieldKind.kind} entry`, item.fieldKind.kind, f ? f.kind : 'not on the screen', ok ? 'PASS' : 'FAIL', { missing: !f }));
  }
  if (item.header) {
    const present = s.headers.some((h) => norm(h) === norm(item.header.name));
    const ok = present === item.header.present;
    return record(row('header', `Column "${item.header.name}" ${item.header.present ? 'shown' : 'not shown'}`, item.header.present ? 'column shown' : 'column not shown',
      present ? 'column shown' : `not shown (columns: ${s.headers.slice(0, 20).join(', ')})`, ok ? 'PASS' : 'FAIL', { missing: !present && item.header.present }));
  }
  if (item.button) {
    const present = s.buttons.some((b) => norm(b) === norm(item.button.name));
    const ok = present === item.button.present;
    return record(row('button', `Button "${item.button.name}" ${item.button.present ? 'shown' : 'not shown'}`, item.button.present ? 'button shown' : 'button not shown',
      present ? 'button shown' : 'button not shown', ok ? 'PASS' : 'FAIL', { missing: !present && item.button.present }));
  }
  if (item.menu) {
    const m = item.menu;
    const present = state.menuItems.some((x) => (m.exact ? norm(x) === norm(m.name) : norm(x) === norm(m.name) || norm(x).startsWith(norm(m.name) + ' (')));
    const ok = present === m.present;
    const near = state.menuItems.filter((x) => /payment|check|quick|reserve/i.test(x));
    return record(row('menu', `Menu item "${m.name}" ${m.present ? 'shown' : 'not shown'}`, m.present ? 'shown' : 'not shown',
      `${present ? 'shown' : 'not shown'} (related items: ${[...new Set(near)].join(', ') || 'none'})`, ok ? 'PASS' : 'FAIL', { missing: !present && m.present }));
  }
  if (item.nav && typeof item.nav === 'object') {
    const n = item.nav;
    const want = norm(n.label);
    // Left-nav labels carry a 2-letter icon abbreviation in their text ("CPChecks/Payments") — allow it.
    const present = s.nav.some((x) => { const l = norm(x.label); return l === want || (l.endsWith(want) && l.length - want.length <= 2); });
    return record(row('nav', `Left-nav "${n.label}" ${n.present ? 'shown' : 'not shown'}`, n.present ? 'shown' : 'not shown',
      present ? 'shown' : 'not shown', present === n.present ? 'PASS' : 'FAIL', { missing: !present && n.present }));
  }
  if (item.message) {
    const text = [...s.messages, s.south].join(' / ');
    const present = item.message.re.test(text);
    return record(row('message', `Validation message ${item.message.re.source}`, item.message.present ? 'message shown' : 'message not shown',
      text.trim() ? text.slice(0, 300) : 'no message', present === item.message.present ? 'PASS' : 'FAIL', { missing: !present && item.message.present }));
  }
  if (item.text) {
    const present = item.text.re.test(s.body);
    return record(row('text', `Text ${item.text.re.source} ${item.text.present ? 'on' : 'not on'} the screen`, item.text.present ? 'present' : 'absent',
      present ? 'present' : 'absent', present === item.text.present ? 'PASS' : 'FAIL', { missing: !present && item.text.present }));
  }
  if (item.require) {
    const q = item.require;
    if (state.warningSeen === null) throw new W.Blocked('precondition gate was never captured');
    if (state.warningSeen !== q.present) throw new W.Blocked(q.reason);
    return undefined;
  }
  return undefined;
}

// Validation rules: CC fires most of them on Next from Step 2 — try that first. The test designs say "Click Finish";
// Finish is only pressed with ONEINC_ALLOW_FINISH=1, because without an error it SUBMITS the payment (to OneInc).
async function validate(page, v, res, ctx, capture, record, dirty) {
  const msgsOf = (s) => [...s.messages, s.south].join(' / ').trim();
  const before = await W.currentStep(page);
  // Already on the last step (a rule whose input is on Step 3, e.g. Payment Date): there is no Next — go to Finish.
  const onLast = before && before.n === before.of;
  // A scenario that EXPECTS an error never gets fields auto-filled on Next: the auto-fill once filled the very
  // Adjuster Number VBR.033 leaves blank, and the payment was submitted (CONFIRMED 2026-10-21).
  if (!onLast) {
    if (v.expect) await W.clickButton(page, 'Next');
    else await W.nextFillingServicePeriod(page);
  }
  dirty();
  let s = await readScreen(page);
  let st = await W.currentStep(page);
  const advanced = onLast || (st && before && st.n > before.n);
  let text = msgsOf(s);
  if (W.serverError(s)) throw new W.Blocked(`ClaimCenter server error on Next (environment, not a rule verdict): ${W.serverError(s)}`);
  const rowFor = (actual, result, extra) => record(row('validation', v.expect ? `Rule message ${v.expect.source}` : 'No validation error',
    v.expect ? 'error displayed' : 'no error', actual, result, extra));
  if (!advanced) {
    if (v.expect && v.expect.test(text)) return rowFor(`shown at Next: ${text.slice(0, 300)}`, 'PASS');
    if (!v.expect) return rowFor(`error(s) at Next: ${text.slice(0, 300) || '(wizard did not advance, no message)'}`, 'FAIL');
    // The payment WAS refused, but by a different business rule (PMS…, "not allowed", "must…", amount mismatch) — a
    // verdict on the scenario, not a missing prerequisite: FAIL, showing the rule that fired, for the BA to confirm.
    // Only "Missing required field" alone means the setup is incomplete (BLOCKED).
    if (/PMS [A-Z]{2}\d+|not allowed|must |does not match|exceeds/i.test(text)) {
      return rowFor(`payment refused, but by a different rule than expected: ${text.slice(0, 300)}`, 'FAIL',
        { note: 'Confirm with BA whether this rule satisfies the requirement' });
    }
    throw new W.Blocked(`wizard stopped on other validation before the rule could be evaluated: ${text.slice(0, 300) || 'no message'}`);
  }
  // Reached the final step with no error.
  if (!ALLOW_FINISH) {
    await capture('reached-final-step', s);
    throw new W.Blocked(v.expect
      ? 'rule did not fire on Next; the design checks it on Finish, which submits the payment — enable ONEINC_ALLOW_FINISH=1 (test/dev tier) to run it'
      : 'no error on Next; confirming "no error on Finish" means submitting the payment — enable ONEINC_ALLOW_FINISH=1 (test/dev tier) to run it');
  }
  // Step 3 has its own required Yes/No questions (the attorney/settlement one — CONFIRMED 2026-10-20 it refused
  // every Finish until answered); answer them "No" so Finish exercises the rule under test, not this one.
  await W.answerUnansweredNo(page);
  // Required Step 3 dropdowns still blank (ClaimsPay Type/Method for a vendor payee) — fill twice, since Method's
  // options depend on Type. Recorded in the result so the defect stays visible.
  for (let r = 0; r < 2; r++) {
    const filled = await W.fillRequiredEmpties(page);
    if (!filled.length) break;
    res.notes = [res.notes, `Before Finish the automation had to set required field(s) CC left blank: ${filled.join(', ')}.`].filter(Boolean).join(' ');
  }
  // A vendor payment needs an invoice number at Finish ("When ClaimsPay Payment Type is Vendor the Invoice Number is
  // required" — CONFIRMED 2026-10-20, although the field is not marked required: the GCCM-799 TC-050 finding).
  const inv = findField(await readScreen(page), 'Invoice Number/Remarks');
  if (inv && !inv.value) {
    await W.fill(page, 'Invoice Number/Remarks', `ONEINC-${Date.now()}`).catch(() => {});
    res.notes = [res.notes, 'Entered an Invoice Number/Remarks before Finish (required for vendor payments).'].filter(Boolean).join(' ');
  }
  const amountShown = (findField(s, 'Amount') || {}).value || '';
  ctx.log(`[OneInc] ${res.scenarioId}: pressing Finish on ${res.claim} (amount ${amountShown || 'n/a'}) — ONEINC_ALLOW_FINISH=1`);
  // Finish can take a while (the screen greys out while CC saves and talks to OneInc) — reading it straight away
  // reported "Finish refused: no message" while it was still processing (CONFIRMED 2026-10-21, GCCM-803 TC-036).
  // Wait up to 30s for the wizard to close or a message to appear.
  const settleAfterFinish = async () => {
    for (let t = 0; t < 30; t++) {
      if (!await W.inWizard(page)) return;
      const sc = await readScreen(page);
      if (sc.messages.length || sc.south) return;
      await page.waitForTimeout(1000);
    }
  };
  await W.clickButton(page, 'Finish');
  await settleAfterFinish();
  dirty();
  // CC may stop on a warnings-only page (e.g. "Possible duplicate payment found") that needs a second Finish.
  if (await W.inWizard(page)) {
    const again = await readScreen(page);
    const onlyWarnings = /duplicate|warning/i.test(again.messages.join(' ')) && !/: (PMS|Missing|must|not allowed)/i.test(again.messages.join(' '));
    if (onlyWarnings) {
      const notDup = page.getByRole('radio', { name: 'Not a duplicate check', exact: true }).first();
      if (await notDup.isVisible().catch(() => false)) await notDup.click().catch(() => {});
      await W.clickButton(page, 'Finish').catch(() => {});
      await settleAfterFinish();
    }
  }
  s = await readScreen(page);
  text = msgsOf(s);
  const srvErr = W.serverError(s);
  if (srvErr) throw new W.Blocked(`ClaimCenter server error on Finish (environment, not a rule verdict): ${srvErr}`);
  const stillOpen = await W.inWizard(page);
  if (v.expect) {
    if (v.expect.test(text)) return rowFor(`shown at Finish: ${text.slice(0, 300)}`, 'PASS');
    if (!stillOpen) {
      res.submittedPayment = { claim: res.claim, amount: amountShown, at: new Date().toISOString() };
      res.notes = [res.notes, `Payment SUBMITTED on TEST (rule did not stop it): claim ${res.claim}, amount ${amountShown || 'n/a'}.`].filter(Boolean).join(' ');
    }
    return rowFor(stillOpen ? `Finish refused with other message(s): ${text.slice(0, 300) || 'none'}` : `payment was SUBMITTED with no error (${amountShown || 'amount n/a'})`, 'FAIL', { missing: true, submitted: !stillOpen });
  }
  if (!stillOpen) {
    // Prove it: read the newest check on Financials › Checks for this amount (user ask 2026-10-21 — "final page with
    // check number"). A payment that does not show up there is not a PASS.
    const chk = await newestCheck(page, amountShown);
    res.submittedPayment = { claim: res.claim, amount: amountShown, checkNumber: chk ? chk.number : null, status: chk ? chk.status : null, at: new Date().toISOString() };
    if (!chk) return rowFor(`wizard closed after Finish, but no ${amountShown || ''} check is listed on Financials › Checks`, 'FAIL');
    res.notes = [res.notes, `Payment SUBMITTED on TEST: claim ${res.claim}, check ${chk.number}, ${chk.amount}, status "${chk.status}".`].filter(Boolean).join(' ');
    await capture('submitted-check', await readScreen(page));
    return rowFor(`no error — payment submitted: check ${chk.number} (${chk.amount}, ${chk.status})`, 'PASS', { submitted: true });
  }
  return rowFor(`Finish refused: ${text.slice(0, 300) || 'no message'}`, 'FAIL');
}

module.exports = { runScenario, ALLOW_FINISH, _test: { evaluate, rollUp, finish, describeItem } };
