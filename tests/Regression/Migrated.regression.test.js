/**
 * tests/Regression/Migrated.regression.test.js — cases ADDED beyond Regression Test Design V1.0 for the Cloud migration's
 * other half: claims MIGRATED from on-prem ClaimCenter must still read correctly and still work on cloud (RX024–RX037),
 * plus two flows no case covered on new claims (Litigation matter, reopen after close — RX038, RX039).
 *
 * Migrated claims are found on cloud, not hard-coded (helpers/regression/migratedClaims: claim-number year before 26,
 * Advanced Search per group, cached 3 days, rotating daily). Integrity cases are read-only and look at several claims;
 * operation cases write to ONE migrated claim each (cloud TEST/DEV only — regressionSteps.hooks), the smallest change
 * that proves the function: a note, Edit → Update with nothing changed, a $1.xx payment, an activity it then completes,
 * reopen → close back.
 *
 * The on-prem ↔ cloud field-by-field comparison of the same claim is the Runner's Reconciliation tab
 * (cc-migration-reconciliation); these cases check what that comparison cannot: that cloud's own screens, totals, rules
 * and actions hold on the data that came across.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const M = require('../../helpers/regression/migratedClaims');
const { R, W, B, A, E, P } = S;

S.hooks(test);

const log = (...a) => console.log(...a);
// Every check is recorded before any is asserted: a case over several claims reports all of them, then fails on the
// first that did not hold.
async function checkAll(page, ti, items) {
  let first = null;
  for (const c of items) { try { await R.check(page, ti, c); } catch (e) { first = first || e; } }
  if (first) throw first;
}
const login = (page) => B.loginToClaimCenter(page);
// Opens the first candidate whose header status matches (a cached "closed" claim another run reopened is skipped).
async function openWithStatus(page, candidates, re) {
  for (const cn of candidates) {
    const st = await M.open(page, cn).catch((e) => { log(`migrated ${cn}: ${e.message.split('\n')[0]}`); return ''; });
    if (re.test(st)) return cn;
  }
  throw new W.Blocked(`none of the migrated claims ${candidates.join(', ')} opened with status ${re}`);
}

// Actions › Reopen Claim (Reason "New information") → St: Open; then the activities the reopen created (and only those)
// are completed and Actions › Close Claim closes it back (e2eSteps' cloud close screen). A claim the close leaves open
// is named in the case's notes.
async function reopenThenClose(page, ti, cn, note) {
  const openRows = async () => (await R.workplanRows(page)).filter((r) => /\bOpen\b/.test(r));
  const before = await openRows();
  await S.action(page, /^Reopen Claim$/);
  await page.locator('textarea, input[name$="Note"]').filter({ visible: true }).first().fill(note).catch(() => {});
  await A.selectByLabel(page, 'Reason', /New information/i);
  await W.clickButton(page, 'Reopen Claim');
  await W.settle(page, 4000);
  const reopened = (await M.header(page) || {}).status || '';
  await R.check(page, ti, { description: 'Claim reopened', expected: 'St: Open', actual: reopened || (await R.pageMessages(page)).join(' | '), ok: /open/i.test(reopened) });
  // The reopen's "Reopen notification - Supervisor" activity is created a few seconds after the claim reopens, so it
  // can be missing from the first read (2026-11-15): wait for it, and complete any open "Reopen…" activity as well.
  let made = [];
  for (let t = 0; t < 4 && !made.length; t++) { await page.waitForTimeout(t ? 5000 : 0); made = (await openRows()).filter((r) => !before.includes(r)); }
  await R.step(page, ti, `Activities the reopen created: ${made.join(' || ') || 'none listed'}`);
  // The sweep reads Workplan page 1 under the current (sticky) filter; workplanRows left "All activities".
  await R.clickMenu(page, /^Workplan$/);
  await page.locator('select[name$="WorkplanFilter"]').first().selectOption({ label: 'All open activities' }).catch(() => {});
  await W.settle(page, 2500);
  await E.completeActivitiesCloud(page, { only: { test: (subject) => /^Reopen/i.test(subject) || made.some((r) => r.includes(subject)) } });
  await page.getByRole('button', { name: 'deferred Actions' }).click();
  await page.waitForTimeout(800);
  await page.getByLabel(/^Close Claim/).first().click();
  await page.waitForTimeout(2500);
  let refused = '';
  await E.submitCloseScreen(page, 'Close Claim', 'Payments Complete|Completed').catch((e) => { refused = e.message; });
  const closed = (await M.header(page) || {}).status || '';
  if (!/closed/i.test(closed)) ti.annotations.push({ type: 'manual', description: `${cn} was left OPEN after this case (close refused) — close it by hand.` });
  await R.check(page, ti, { description: 'Reopened claim closes again', expected: 'St: Closed', actual: closed + (refused ? ` — ${refused}` : ''), ok: /closed/i.test(closed) });
}

// ── Integrity (read-only) ────────────────────────────────────────────────────────────────────────────────────────
for (const [id, status, n] of [['RX024', 'open', 3], ['RX025', 'closed', 2]]) {
  test(`RG-${id} [Migrated Claims - integrity]: every claim screen loads on migrated ${status} claims`, async ({ page }, ti) => S.blockable(test, async () => {
    await login(page);
    const claims = await M.pick(page, status, n, { log });
    R.setClaim(ti, claims.join(', '), process.env.CC_USER);
    const items = [];
    for (const cn of claims) {
      const st = await M.open(page, cn);
      const h = await M.header(page);
      const screens = await M.walk(page);
      const bad = screens.filter((x) => x.error);
      await R.step(page, ti, `${cn} (${st}): ${screens.length} screens — ${screens.map((x) => x.screen).join(', ')}`);
      items.push({ description: `${cn}: header carries policy, insured, loss date, status and adjuster`, expected: 'all five filled', actual: JSON.stringify(h), ok: !!(h && h.policy && h.insured && h.lossDate && h.status && h.adjuster) });
      items.push({ description: `${cn}: every left-nav screen opens without an error`, expected: '≥ 12 screens, none with an error', actual: bad.length ? bad.map((x) => `${x.screen}: ${x.error}`).join(' || ') : `${screens.length} screens, no errors`, ok: screens.length >= 12 && !bad.length });
    }
    await checkAll(page, ti, items);
  }));
}

for (const [id, status, n] of [['RX026', 'open', 4], ['RX027', 'closed', 4]]) {
  test(`RG-${id} [Migrated Claims - integrity]: Financials summary reconciles to the Transactions ledger on migrated ${status} claims`, async ({ page }, ti) => S.blockable(test, async () => {
    await login(page);
    const claims = await M.pick(page, status, n, { log });
    R.setClaim(ti, claims.join(', '), process.env.CC_USER);
    const items = [];
    for (const cn of claims) {
      const st = await M.open(page, cn);
      const fin = await M.financialSummary(page);
      const tx = await M.transactions(page);
      await R.step(page, ti, `${cn} (${st}): ${tx.length} transactions; summary ${fin.total ? JSON.stringify(fin.total) : 'no Claim Total row'}`);
      for (const r of M.reconcile(fin, tx, { closed: /closed/i.test(st) })) items.push({ description: `${cn}: ${r.rule}`, expected: r.expected, actual: r.actual, ok: r.ok });
      if (/closed/i.test(st)) {
        // WC claims carry exposures under Loss Details, not an Exposures screen — nothing to read there.
        const ex = await W.navigate(page, 'exposures').then(() => R.gridRows(page)).catch(() => null);
        if (ex) {
          const open = ex.filter((x) => /^\d+\s/.test(x) && /\bOpen\b/.test(x));
          items.push({ description: `${cn}: closed claim has no open exposure`, expected: 'every exposure Closed', actual: open.length ? open.join(' || ') : `${ex.filter((x) => /^\d+\s/.test(x)).length} exposure(s), all closed`, ok: !open.length });
        }
      }
    }
    await checkAll(page, ti, items);
  }));
}

test('RG-RX028 [Migrated Claims - integrity]: migrated claims are found by Claim # and by Policy #', async ({ page }, ti) => S.blockable(test, async () => {
  await login(page);
  const claims = [...await M.pick(page, 'open', 1, { log }), ...await M.pick(page, 'closed', 1, { log })];
  R.setClaim(ti, claims.join(', '), process.env.CC_USER);
  const FS = require('../../helpers/financialClaimSearch');
  const items = [];
  for (const cn of claims) {
    await M.open(page, cn);
    const h = await M.header(page);
    // Advanced Search's Claim # box (financialClaimSearch.searchClaims has no claim criterion) — the box
    // openClaimViaSearch fills.
    await FS.openAdvancedSearch(page);
    await page.locator('.gw-InputWidget').filter({ hasText: /^\s*Claim #/ }).locator('input').first().fill(cn);
    await page.getByRole('button', { name: 'Search', exact: true }).last().click();
    await W.settle(page, 5000);
    const byClaim = (await R.gridRows(page)).map((t) => ({ claim: (t.match(M.CLAIM_RE) || [])[0], text: t }));
    items.push({ description: `${cn}: Advanced Search by Claim #`, expected: cn, actual: byClaim.map((r) => r.claim).filter(Boolean).join(', ') || 'no rows', ok: byClaim.some((r) => r.claim === cn) });
    const byPolicy = h && h.policy ? await FS.searchClaims(page, { policy: h.policy }) : [];
    items.push({ description: `${cn}: Advanced Search by Policy # ${h && h.policy}`, expected: `${cn} among the policy's claims`, actual: byPolicy.map((r) => r.claim).join(', ') || 'no rows', ok: byPolicy.some((r) => r.claim === cn) });
  }
  await checkAll(page, ti, items);
}));

test('RG-RX029 [Migrated Claims - integrity]: migrated open claims pass Validate Claim + Exposures (Ability to pay)', async ({ page }, ti) => S.blockable(test, async () => {
  await login(page);
  const claims = await M.pick(page, 'open', 3, { log });
  R.setClaim(ti, claims.join(', '), process.env.CC_USER);
  const items = [];
  for (const cn of claims) {
    await M.open(page, cn);
    const errs = await E.validateCloud(page);
    await R.step(page, ti, `${cn}: Validate Claim + Exposures › Ability to pay — ${errs.length} message(s)`);
    items.push({ description: `${cn}: no Ability-to-pay validation errors`, expected: 'none', actual: errs.length ? errs.map((e) => `${e.where ? e.where + ': ' : ''}${e.text}`).join(' || ').slice(0, 1200) : 'none', ok: !errs.length });
  }
  await checkAll(page, ti, items);
}));

test('RG-RX030 [Migrated Claims - integrity]: every migrated check carries a payee, amount and status', async ({ page }, ti) => S.blockable(test, async () => {
  await login(page);
  const CO = require('../../helpers/oneInc/checkOps');
  const claims = [...await M.pick(page, 'open', 3, { log }), ...await M.pick(page, 'closed', 3, { log })];
  const items = [];
  const used = [];
  for (const cn of claims) {
    await M.open(page, cn);
    const rows = await CO.checkRows(page).catch(() => []);
    if (!rows.length) continue;
    used.push(cn);
    const bad = rows.filter((r) => !r.payee || !/\$[\d,]+\.\d\d/.test(r.amount) || !r.status);
    await R.step(page, ti, `${cn}: ${rows.length} check(s) — ${[...new Set(rows.map((r) => r.status))].join(', ')}`);
    items.push({ description: `${cn}: checks have payee, amount and status`, expected: `all ${rows.length}`, actual: bad.length ? bad.map((r) => r.text).join(' || ').slice(0, 800) : `all ${rows.length} complete`, ok: !bad.length });
  }
  R.setClaim(ti, used.join(', '), process.env.CC_USER);
  if (!items.length) throw new W.Blocked(`none of ${claims.join(', ')} has a check`);
  await checkAll(page, ti, items);
}));

// ── Operations on migrated claims (write — cloud TEST/DEV) ──────────────────────────────────────────────────────────
test('RG-RX031 [Migrated Claims - operations]: a note can be added to a migrated open claim', async ({ page }, ti) => S.blockable(test, async () => {
  await login(page);
  const cn = await openWithStatus(page, await M.pick(page, 'open', 3, { log }), /open/i);
  R.setClaim(ti, cn, process.env.CC_USER);
  const text = `Regression RX031 note on migrated claim ${Date.now()}`;
  await S.action(page, /^Note$/);
  await A.selectByLabel(page, 'Topic', /^(?!<none>$).+/).catch(() => {});
  await page.locator('textarea').filter({ visible: true }).first().fill(text);
  await W.clickButton(page, 'Update');
  await W.settle(page, 2500);
  const msgs = await R.pageMessages(page);
  await S.nav(page, 'Notes');
  await W.settle(page, 2500);
  const listed = (await S.bodyText(page)).includes(text);
  await R.check(page, ti, { description: 'Note listed on the migrated claim\'s Notes', expected: text, actual: listed ? 'listed' : `not listed — ${msgs.join(' | ') || 'no message'}`, ok: listed });
}));

// Edit → Update with nothing changed: cloud's validation runs over the migrated values. A refusal means an adjuster
// cannot touch this screen on a migrated claim until they fill what on-prem never required.
const EDITS = [
  ['RX032', 'Loss Details', async (page) => A.openLossDetailsGeneral(page)],
  ['RX033', 'an open exposure', async (page) => S.openExposureMatching(page, '\\bOpen\\b')],
  ['RX034', 'the insured contact', async (page) => {
    await W.navigate(page, 'parties');
    const row = page.locator('tr:visible').filter({ hasText: /\bInsured\b/ }).first();
    if (!await row.isVisible().catch(() => false)) throw new W.Blocked('no Insured on Parties Involved');
    await row.locator('[id$="-Name"]').first().click();
    await W.settle(page, 2500);
  }],
];
for (const [id, what, openScreen] of EDITS) {
  test(`RG-${id} [Migrated Claims - operations]: ${what} saves unchanged (Edit → Update) on migrated open claims`, async ({ page }, ti) => S.blockable(test, async () => {
    await login(page);
    // Up to 6 candidates for 2 checked claims: many migrated open claims have only closed exposures.
    const claims = await M.pick(page, 'open', 6, { log });
    const items = [];
    const used = [];
    for (const cn of claims) {
      if (used.length >= 2) break;
      if (!/open/i.test(await M.open(page, cn))) continue;
      try { await openScreen(page); } catch (e) { if (e.name === 'Blocked') { await R.step(page, ti, `${cn}: ${e.message}`); continue; } throw e; }
      used.push(cn);
      const r = await S.editAndUpdate(page, async () => {}, what);
      items.push({ description: `${cn}: ${what} saved with no change`, expected: 'saved, no validation error', actual: r.saved ? `saved${r.messages.length ? ' — ' + r.messages.join(' | ') : ''}` : `refused — ${r.messages.join(' | ') || 'no message'}`, ok: r.saved });
    }
    R.setClaim(ti, used.join(', '), process.env.CC_USER);
    if (!items.length) throw new W.Blocked(`${what} not found on ${claims.join(', ')}`);
    await checkAll(page, ti, items);
  }));
}

test('RG-RX035 [Migrated Claims - operations]: an activity is created on a migrated open claim and completed', async ({ page }, ti) => S.blockable(test, async () => {
  await login(page);
  // financialRules.workplanRows reads up to 20 Workplan pages (300 activities); some migrated claims carry thousands
  // (BSS-GA-03-18-0733435: 3,456 activities, 824 open — 2026-11-15), so the case takes a claim whose whole Workplan it
  // can read, and notes the ones it passed over.
  let cn = null;
  const big = [];
  for (const c of await M.pick(page, 'open', 6, { log })) {
    if (!/open/i.test(await M.open(page, c))) continue;
    await R.clickMenu(page, /^Workplan$/);
    await page.locator('select[name$="WorkplanFilter"]').first().selectOption({ label: 'All activities' }).catch(() => {});
    await W.settle(page, 2500);
    // Pager: "Displaying 1 - 15 of 3456" + a page count in …_ListPaging-postLabel ("231").
    const total = ((await page.locator('[id$="WorkplanLV-_ListPaging"]').first().innerText().catch(() => '')).match(/Displaying.*?of \d+/) || [''])[0];
    const pages = Number(String(await page.locator('[id$="WorkplanLV-_ListPaging-postLabel"]').first().innerText().catch(() => '1')).replace(/\D/g, '')) || 1;
    if (pages > 20) { big.push(`${c}: ${total} activities`); continue; }
    cn = c;
    break;
  }
  if (big.length) ti.annotations.push({ type: 'manual', description: `Migrated claims passed over for their Workplan size: ${big.join(' || ')}` });
  if (!cn) throw new W.Blocked(`every migrated open claim tried has more than 300 activities — ${big.join(' || ')}`);
  await M.open(page, cn);
  R.setClaim(ti, cn, process.env.CC_USER);
  const subject = `Regression RX035 ${Date.now()}`;
  // Actions › New … › New Activity › General › "***Edit This Subject Line***" (the free-subject pattern).
  await W.openActionsMenu(page);
  await page.getByRole('menuitem', { name: 'General', exact: true }).first().hover();
  await page.waitForTimeout(700);
  const pat = page.getByRole('menuitem', { name: '***Edit This Subject Line***', exact: true }).first();
  if (!await pat.isVisible().catch(() => false)) { await W.closeMenus(page); throw new W.Blocked('New Activity › General has no "***Edit This Subject Line***" pattern'); }
  await pat.click();
  await page.getByRole('button', { name: 'Update', exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
  // Two "Subject" boxes on this screen (the activity's, then the optional New Note's) — fill the activity's own one.
  const subj = await page.evaluate(() => { const i = [...document.querySelectorAll('input')].find((x) => x.offsetParent && x.value === '***Edit This Subject Line***'); if (i) i.setAttribute('data-rg-subject', '1'); return !!i; });
  if (!subj) throw new W.Blocked('the new activity has no "***Edit This Subject Line***" Subject box');
  await page.locator('input[data-rg-subject="1"]').first().fill(subject);
  // Automated assignment hands it to the group supervisor (Keith Eisenhart, 2026-11-15), who alone could complete it —
  // assign it to the adjuster running the case.
  await A.selectByLabel(page, 'Assign To', /Benjamin Smith/).catch((e) => ti.annotations.push({ type: 'manual', description: e.message }));
  await W.fillRequiredEmpties(page).catch(() => {});
  await W.clickButton(page, 'Update');
  await W.settle(page, 3000);
  let refused = [];
  if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
    // Automated assignment can find no one in a migrated claim's old group — give it to the adjuster running the case.
    refused = await R.pageMessages(page);
    await A.selectByLabel(page, 'Assign To', /Benjamin Smith/).catch(() => {});
    await W.clickButton(page, 'Update');
    await W.settle(page, 3000);
    if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
      refused = [...refused, ...(await R.pageMessages(page))];
      await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    } else await R.step(page, ti, `First Update refused (${refused.join(' | ') || 'no message'}) — assigned to Benjamin Smith`);
  }
  const made = await R.hasActivity(page, new RegExp(subject), cn);
  await R.check(page, ti, { description: 'Activity on the migrated claim\'s Workplan', expected: subject, actual: made.rows.filter((r) => r.includes(subject)).join(' | ') || `not listed — ${refused.join(' | ') || 'no message'}`, ok: made.found });
  // completeActivitiesCloud reads Workplan page 1 under whatever filter is set; hasActivity left "All activities"
  // (sticky), where today's activity sorts onto a later page — put the filter back on open activities first.
  await M.open(page, cn);
  await R.clickMenu(page, /^Workplan$/);
  await page.locator('select[name$="WorkplanFilter"]').first().selectOption({ label: 'All open activities' }).catch(() => {});
  await W.settle(page, 2500);
  await E.completeActivitiesCloud(page, { only: new RegExp(subject) });
  const after = (await R.hasActivity(page, new RegExp(subject), cn)).rows.filter((r) => r.includes(subject));
  await R.check(page, ti, { description: 'Activity completed', expected: 'Complete', actual: after.join(' | ') || 'not listed', ok: after.some((r) => /\bComplete/i.test(r)) && !after.some((r) => /\bOpen\b/.test(r)) });
}));

test('RG-RX036 [Migrated Claims - operations]: a payment is made on a migrated reserve line', async ({ page }, ti) => S.blockable(test, async () => {
  process.env.ONEINC_ALLOW_FINISH = process.env.ONEINC_ALLOW_FINISH || '1';
  await login(page);
  const claims = await M.pick(page, 'open', 6, { log });
  let done = null;
  const tried = [];
  for (const cn of claims) {
    if (!/open/i.test(await M.open(page, cn))) continue;
    const fin = await M.financialSummary(page);
    const line = fin.lines.find((l) => (l.values['Remaining Reserves'] || 0) >= 5);
    if (!line) { tried.push(`${cn}: no line with $5+ remaining reserve`); continue; }
    // "(2) 3rd Party Bodily Injury Liability - CHRISTINE HARPER - Liability - Auto bodily injury" → "3rd Party Bodily Injury Liability"
    const [name, claimant] = line.label.replace(/^\(\d+\)\s*/, '').split(' - ');
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await M.open(page, cn);
    try {
      // Pay the line's own claimant by name: "claimant" resolves from parties read on new claims, which a migrated
      // claim opened by search does not carry.
      const r = await P.makePayment(page, { reserveLine: `match:${esc}`, payee: claimant || 'claimant', amount: P.uniqueAmount(1) });
      done = { cn, r, line: line.label };
      break;
    } catch (e) {
      if (e.name !== 'Blocked') throw e;
      tried.push(`${cn}: ${e.message.split('\n')[0].slice(0, 200)}`);
    }
  }
  if (tried.length) ti.annotations.push({ type: 'manual', description: `Skipped: ${tried.join(' || ')}` });
  if (!done) throw new W.Blocked(`no migrated open claim took a payment — ${tried.join(' || ').slice(0, 600)}`);
  R.setClaim(ti, done.cn, process.env.CC_USER);
  await R.step(page, ti, `Payment $${done.r.amount} to ${done.r.payee} on ${done.line} — ${done.r.finished ? 'finished' : 'not finished'} ${done.r.messages.join(' | ')}`);
  await M.open(page, done.cn);
  const tx = await M.transactions(page);
  const row = tx.find((t) => t.Type === 'Payment' && Math.abs(t.Amount - Number(done.r.amount)) < 0.001);
  await R.check(page, ti, { description: 'Payment on the migrated claim\'s Transactions', expected: `$${done.r.amount} payment (Awaiting submission / Pending approval / Submitted)`, actual: row ? `${row.Type} $${row.Amount} ${row.Status} ${row['Exposure Name'] || ''}` : 'not listed', ok: !!row && /Awaiting submission|Pending approval|Submitted|Requested|Issued/i.test(row.Status) });
}));

test('RG-RX037 [Migrated Claims - operations]: a migrated closed claim reopens, then closes again', async ({ page }, ti) => S.blockable(test, async () => {
  // Admin: the reopen sends a "Reopen notification - Supervisor" activity to the claim's supervisor, which has to be
  // completed before the claim closes again (2026-11-15, CA-GA-03-17-0708322).
  await B.loginAsAdmin(page);
  const cn = await openWithStatus(page, await M.pick(page, 'closed', 5, { log }), /closed/i);
  R.setClaim(ti, cn, process.env.CC_ADMIN_USER || 'admin');
  await reopenThenClose(page, ti, cn, 'Regression RX037 — reopen a migrated claim (closed again by the same case)');
}));

// ── New-claim flows no case covered ─────────────────────────────────────────────────────────────────────────────
test('RG-RX038 [Litigation]: a Matter (lawsuit details) is created on a claim and listed on Litigation', async ({ page }, ti) => S.blockable(test, async () => {
  const { cn } = await S.pooledClaim(page, 'PA', 'RG-RX038', { assignmentType: 'Casualty', lossCause: 'LC15' });
  R.setClaim(ti, cn, process.env.CC_USER);
  await B.openExistingClaim(page, cn);
  const caption = `Regression RX038 v. Donegal ${Date.now().toString().slice(-6)}`;
  await S.action(page, /^Matter$/);
  await A.selectByLabel(page, 'Matter Type', /^General$/);
  await W.fill(page, 'Case Caption', caption);
  for (const [label, want] of [['Court Type', /^County$/], ['Court District', /Pennsylvania/], ['Legal Specialty', /Motor vehicle/i], ['Primary Cause', /Coverage Dispute|Damages Dispute/]]) {
    await A.selectByLabel(page, label, want).catch((e) => ti.annotations.push({ type: 'manual', description: e.message }));
  }
  for (const [label, ans] of [['Has a settlement offer been extended?', 'No'], ['Is the Plaintiff representing themselves?', 'Yes']]) await W.answer(page, label, ans).catch(() => {});
  for (const label of ['Defense Attorney', 'Defense Law Firm']) await A.selectByLabel(page, label, /^(?!<none>$).+/).catch(() => {});
  // "Matter must be related to at least one exposure": Matter Related To Exposures › Add › the claim's first exposure.
  await page.locator('[id*="MatterExposureLV"]').getByRole('button', { name: 'Add', exact: true }).first().click();
  await W.settle(page, 2000);
  const ex = page.locator('select[name$="MatterExposureLV-0-Exposure"]').first();
  const exOpt = await ex.locator('option').evaluateAll((os) => (os.find((o) => o.value && !/^<none>$/i.test(o.text.trim())) || {}).value);
  if (!exOpt) throw new W.Blocked('the claim has no exposure to relate the matter to');
  await ex.selectOption(exOpt);
  await W.settle(page, 1500);
  await W.fillRequiredEmpties(page).catch(() => {});
  await W.clickButton(page, 'Update');
  await W.settle(page, 3500);
  const msgs = await R.pageMessages(page);
  if (await page.getByRole('button', { name: 'Update', exact: true }).first().isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click().catch(() => {});
    if (msgs.some((m) => /Defense (Attorney|Law Firm)/i.test(m))) throw new W.Blocked(`the claim has no contact to name as defense attorney / law firm — ${msgs.join(' | ')}`);
  }
  await B.openExistingClaim(page, cn);
  await S.nav(page, 'Litigation');
  await W.settle(page, 2500);
  const rows = await R.gridRows(page);
  await R.check(page, ti, { description: 'Matter listed on Litigation', expected: caption, actual: rows.filter((r) => r.includes(caption)).join(' | ') || `not listed — ${msgs.join(' | ') || rows.slice(0, 3).join(' | ')}`, ok: rows.some((r) => r.includes(caption)) });
}));

test('RG-RX039 [Claim Lifecycle - reopen]: a closed claim reopens and closes again', async ({ page }, ti) => S.blockable(test, async () => {
  const { cn } = await S.fileClaim(page, 'PA', 'RG-RX039', { assignmentType: 'Casualty', lossCause: 'LC15', pool: false });
  R.setClaim(ti, cn, process.env.CC_ADMIN_USER || 'admin');
  await R.asAdmin(page, cn);
  await E.repairCloud(page, cn).catch(() => {});
  await E.close(page, cn);
  await B.openExistingClaim(page, cn);
  await R.check(page, ti, { description: 'Claim closed', expected: 'St: Closed', actual: (await M.header(page) || {}).status, ok: /closed/i.test((await M.header(page) || {}).status || '') });
  await reopenThenClose(page, ti, cn, 'Regression RX039 reopen (closed again by the same case)');
}));

// ── Money lifecycle on the NEWEST migrated open claims (2025 → 2024 → 2023, with open reserves) ─────────────────────
// Each case writes, then re-reads Financials and checks the summary still reconciles to the ledger
// (migratedClaims.reconcile) — new money must post on top of migrated money the way it does on a new claim.
const used = [];
async function recentClaim(page, opts = {}) {
  const [cn] = await M.pickRecent(page, 1, { exclude: used, log, ...opts });
  used.push(cn);
  await M.open(page, cn);
  return cn;
}
async function reconcileAfter(page, cn, items, what) {
  await M.open(page, cn);
  const st = (await M.header(page) || {}).status || '';
  const fin = await M.financialSummary(page);
  const tx = await M.transactions(page);
  for (const r of M.reconcile(fin, tx, { closed: /closed/i.test(st) })) items.push({ description: `${cn} after ${what}: ${r.rule}`, expected: r.expected, actual: r.actual, ok: r.ok });
  return { fin, tx };
}
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const today = () => new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

test('RG-RX040 [Migrated Claims - lifecycle]: a reserve is raised on a migrated exposure and posts to Financials', async ({ page }, ti) => S.blockable(test, async () => {
  await B.loginAsAdmin(page);
  const cn = await recentClaim(page);
  R.setClaim(ti, cn, process.env.CC_ADMIN_USER || 'admin');
  const before = await M.financialSummary(page);
  const line = before.lines.find((l) => (l.values['Remaining Reserves'] || 0) > 0);
  if (!line) throw new W.Blocked(`${cn}: no exposure line with a remaining reserve`);
  const expName = line.label.replace(/^\(\d+\)\s*/, '').split(' - ')[0];
  const target = Math.round((line.values['Remaining Reserves'] + 100) * 100) / 100;
  await B.openExistingClaim(page, cn);
  const said = await S.F.createReserve(page, { reserveAmount: target, exposure: expName, strict: false });
  await R.step(page, ti, `${cn}: ${line.label} remaining $${line.values['Remaining Reserves']} → set to $${target}${said ? ' — ' + said : ''}`);
  const items = [];
  const { fin, tx } = await reconcileAfter(page, cn, items, 'the reserve change');
  const now = fin.lines.find((l) => l.label === line.label);
  items.unshift({ description: `${cn}: remaining reserve on ${line.label.slice(0, 70)} up by $100`, expected: `$${target}`, actual: now ? `$${now.values['Remaining Reserves']}` : 'line not found', ok: !!now && Math.abs(now.values['Remaining Reserves'] - target) < 0.01 });
  const added = tx.filter((t) => t.Type === 'Reserve' && t.Date === today());
  items.unshift({ description: `${cn}: today's $100.00 reserve transaction on the ledger`, expected: 'Reserve $100.00', actual: added.map((t) => `${t.Date} $${t.Amount} ${t.Status}`).join(' | ') || 'none today', ok: added.some((t) => Math.abs(t.Amount - 100) < 0.01) });
  await checkAll(page, ti, items);
}));

test('RG-RX041 [Migrated Claims - lifecycle]: a new exposure is added to a migrated claim', async ({ page }, ti) => S.blockable(test, async () => {
  await login(page);
  const cn = await recentClaim(page);
  R.setClaim(ti, cn, process.env.CC_USER);
  const exposures = async () => { await M.open(page, cn); return W.navigate(page, 'exposures').then(() => R.gridRows(page)).then((r) => r.filter((x) => /^\d+\s/.test(x))).catch(() => null); };
  const before = await exposures();
  if (!before) throw new W.Blocked(`${cn} has no Exposures screen (WC-style claim)`);
  // fnolHelper's post-FNOL exposure walk (oneInc/claimCheck.addExposures). [''] = the first coverage the policy offers
  // under Choose by Coverage — migrated policies carry their own coverage lists.
  let err = '';
  await require('../../helpers/oneInc/claimCheck').addExposures(page, cn, [{ coverageLabel: [''] }]).catch((e) => { err = e.message.split('\n')[0]; });
  const after = await exposures();
  await R.check(page, ti, { description: `${cn}: one more exposure`, expected: `${before.length + 1} exposures`, actual: `${(after || []).length}: ${(after || []).slice(-1)[0] || ''}${err ? ' — ' + err : ''}`, ok: !!after && after.length === before.length + 1 });
}));

// A migrated payee usually has no Payment Contact Details, and cloud refuses a non-vendor payment without them ("Payees
// other than vendor should have the payment contact details set up on the parties involved" — CPP-DE-01-25-0746263,
// 2026-11-15). Set them up the way an adjuster would before paying: the QA mailbox and the 555 test mobile (feedback:
// every test contact e-mail is amitmishra@donegalgroup.com). Returns what was done per name.
const PC = require('../../helpers/oneInc/paymentContact');
async function ensurePaymentContacts(page, cn, names) {
  const out = [];
  for (const name of [...new Set(names.filter(Boolean))]) {
    await M.open(page, cn);
    const r = await PC.setPaymentContact(page, { first: name }, { email: 'amitmishra@donegalgroup.com', mobile: '717-555-0142' }, `Payment Contact Details for ${name}`)
      .catch((e) => `not set: ${e.message.split('\n')[0].slice(0, 160)}`);
    out.push(`${name}: ${typeof r === 'string' ? r : JSON.stringify(r)}`.slice(0, 240));
  }
  await M.open(page, cn);
  return out;
}
async function payeeHasZip(page, cn, name) {
  await M.open(page, cn);
  await W.navigate(page, 'parties');
  await W.settle(page, 2500);
  const row = await page.evaluate((n) => [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr') && r.querySelector('[id$="-Name"]'))
    .map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()).find((t) => t.toLowerCase().includes(String(n).toLowerCase())) || '', name);
  await M.open(page, cn);
  return { ok: !row || /\b\d{5}(-\d{4})?\s*$/.test(row), row: row.replace(/\s+/g, ' ').slice(0, 120) };
}
// Migrated adjuster (user) records can be incomplete on cloud, and CC then refuses every payment on the exposures they
// own ("Exposure owner Bill Folmar must have a valid examiner number", "Exposure owner Cody Wilson is missing … First
// Name, Last Name, Email Address, and/or Phone Number" — 2026-11-15; RX046 reports these). The lifecycle cases test the
// function, so they take the exposures over first (setupA.assignExposuresTo — the adjuster's own workaround) and note
// who owned them.
async function takeOver(page, ti, cn) {
  await M.open(page, cn);
  const owners = await W.navigate(page, 'exposures').then(() => page.evaluate(() => [...new Set([...document.querySelectorAll('[id*="ExposuresLV-"][id$="-Assignee"]')].map((e) => e.innerText.trim()).filter(Boolean))])).catch(() => []);
  const done = await A.assignExposuresTo(page, 'Benjamin Smith').catch((e) => `not reassigned: ${e.message.split('\n')[0].slice(0, 160)}`);
  await R.step(page, ti, `${cn}: exposure owners ${owners.join(', ') || '?'} → ${done}`);
  await M.open(page, cn);
}
const lineClaimant = (l) => (l.label.replace(/^\(\d+\)\s*/, '').split(' - ')[1] || '').trim();

test('RG-RX042 [Migrated Claims - lifecycle]: a payment on a migrated line goes to OneInc and its check is voided', async ({ page }, ti) => S.blockable(test, async () => {
  process.env.ONEINC_ALLOW_FINISH = process.env.ONEINC_ALLOW_FINISH || '1';
  const CO = require('../../helpers/oneInc/checkOps');
  ti.setTimeout(3_600_000); // up to 3 claims + the Financials Escalation batch + up to 10 minutes for OneInc's answer
  await login(page);
  // Up to 3 claims: a migrated payee whose address has no ZIP Code is refused at the payee step — recorded, next claim.
  const refusals = [];
  let skipped = 0;
  let done = null;
  for (let k = 0; k < 15 && !done && refusals.length - skipped < 4; k++) {
    const cn = await recentClaim(page);
    const fin = await M.financialSummary(page);
    const line = fin.lines.find((l) => (l.values['Remaining Reserves'] || 0) >= 5);
    if (!line) { refusals.push(`${cn}: no line with $5+ remaining reserve`); continue; }
    const name = line.label.replace(/^\(\d+\)\s*/, '').split(' - ')[0];
    const claimant = lineClaimant(line);
    // OneInc pays people, not companies: a check to a company payee comes back Voided by the integration within a
    // minute (THE DEHAYES GROUP on DFS-VA-02-23-0742468, 2026-11-15) — the void flow needs a person.
    if (/\b(LLC|L\.L\.C|INC|CORP|CORPORATION|COMPANY|CO|GROUP|AGENCY|LTD|LP|BANK|INSURANCE|SERVICES?)\b\.?\s*$/i.test(claimant) || /\b(LLC|INC|GROUP|AGENCY|CORP)\b/i.test(claimant)) { refusals.push(`${cn} (${claimant}): company payee — OneInc pays people`); skipped++; continue; }
    // A payee whose Parties Involved address has no ZIP is refused at the payee step (RX045) — note it, next claim.
    const zip = await payeeHasZip(page, cn, claimant);
    if (!zip.ok) { refusals.push(`${cn} (${claimant}): address without ZIP — ${zip.row}`); skipped++; continue; }
    const pcd = await ensurePaymentContacts(page, cn, [claimant]);
    await R.step(page, ti, `${cn}: Payment Contact Details — ${pcd.join(' | ')}`);
    if (pcd.some((x) => /not set|refused/i.test(x))) { refusals.push(`${cn} (${claimant}): Payment Contact Details could not be set — ${pcd.join(' | ').slice(0, 160)}`); skipped++; continue; }
    await takeOver(page, ti, cn);
    try {
      const pay = await P.makePayment(page, { reserveLine: `match:${esc(name)}`, payee: claimant || 'claimant', amount: P.uniqueAmount(1) });
      done = { cn, pay, line };
    } catch (e) {
      if (e.name !== 'Blocked') throw e;
      refusals.push(`${cn} (${claimant}): ${e.message.split('\n')[0].slice(0, 200)}`);
    }
  }
  if (refusals.length) ti.annotations.push({ type: 'manual', description: `Migrated claims that could not be paid as they came across: ${refusals.join(' || ')}` });
  if (!done) throw new W.Blocked(`no recent migrated claim took a payment — ${refusals.join(' || ').slice(0, 700)}`);
  const { cn, pay, line } = done;
  R.setClaim(ti, cn, process.env.CC_USER);
  await R.step(page, ti, `${cn}: $${pay.amount} to ${pay.payee} on ${line.label} — ${pay.messages.join(' | ') || 'finished'}`);
  await B.openExistingClaim(page, cn);
  await CO.escalateChecks(page, pay.amount).catch((e) => R.step(page, ti, `escalation: ${e.message.split('\n')[0]}`));
  // OneInc acknowledges TEST checks within minutes (Requested / Issued) — then Void is enabled.
  // A check that turns Voided / Stopped on its own was refused downstream (CA-VA-02-24-0742829's $1.47, whose payee had
  // no Payment Contact Details, came back Voided — 2026-11-15) — reported as that, not as a timeout.
  let opened = '';
  let last = '';
  for (let t = 0; t < 15 && !opened; t++) {
    await B.openExistingClaim(page, cn);
    last = ((await CO.checkRows(page).catch(() => [])).filter((r) => String(r.amount).replace(/[^0-9.]/g, '') === String(pay.amount)).pop() || {}).status || '';
    if (/void|stop/i.test(last)) break;
    if (/^(Requested|Issued)$/.test(last)) opened = await CO.openCheck(page, { status: '^(Requested|Issued)$', amount: `$${pay.amount}` }).catch(() => '');
    if (!opened) await page.waitForTimeout(60000);
  }
  await R.check(page, ti, { description: `${cn}: check $${pay.amount} sent to OneInc`, expected: 'Requested / Issued', actual: opened || (/void|stop/i.test(last) ? `came back ${last} without a user void — refused downstream` : `still "${last}" after 15 minutes`), ok: !!opened });
  // openCheck leaves the check's details (with Void) showing — void from there.
  await CO.openVoid(page);
  await CO.submitVoid(page);
  await B.openExistingClaim(page, cn);
  const after = (await CO.checkRows(page)).filter((r) => String(r.amount).replace(/[^0-9.]/g, '') === String(pay.amount));
  const items = [{ description: `${cn}: check voided`, expected: 'Pending void / Voided', actual: after.map((r) => `${r.number} ${r.status}`).join(' | '), ok: after.some((r) => /void/i.test(r.status)) }];
  await reconcileAfter(page, cn, items, 'payment + void');
  await checkAll(page, ti, items);
}));

test('RG-RX043 [Migrated Claims - lifecycle]: a recovery reserve and receipt post on a migrated claim', async ({ page }, ti) => S.blockable(test, async () => {
  await B.loginAsAdmin(page);
  const cn = await recentClaim(page);
  R.setClaim(ti, cn, process.env.CC_ADMIN_USER || 'admin');
  const before = await M.financialSummary(page);
  const was = before.total ? before.total.Recoveries || 0 : 0;
  await B.openExistingClaim(page, cn);
  const amt = 150;
  await E.recovery(page, 'PA', amt, { skipSubro: false });
  const items = [];
  const { fin, tx } = await reconcileAfter(page, cn, items, 'the recovery');
  const now = fin.total ? fin.total.Recoveries || 0 : 0;
  const rows = tx.filter((t) => t.Type === 'Recovery' && t.Date === today() && Math.abs(t.Amount - amt) < 0.01);
  // A receipt can need approval (HO-DE-01-24-0744155: "Pending approval", 2026-11-15) — then Recoveries stays put
  // until it is approved; posted, it rises by the amount.
  const pending = rows.some((t) => M.NOT_POSTED.test(String(t.Status).trim()));
  items.unshift({ description: `${cn}: $${amt} recovery on the ledger`, expected: `Recovery $${amt}.00 today`, actual: rows.map((t) => `${t.Type} $${t.Amount} ${t.Status}`).join(' | ') || 'none today', ok: rows.length > 0 });
  items.unshift({ description: `${cn}: Recoveries total`, expected: pending ? `$${was} (receipt pending approval)` : `$${was + amt}`, actual: `$${now}`, ok: Math.abs(now - (pending ? was : was + amt)) < 0.01 });
  await checkAll(page, ti, items);
}));

test('RG-RX044 [Migrated Claims - lifecycle]: an open migrated claim is drained, its exposures closed and the claim closed', async ({ page }, ti) => S.blockable(test, async () => {
  process.env.ONEINC_ALLOW_FINISH = process.env.ONEINC_ALLOW_FINISH || '1';
  await B.loginAsAdmin(page);
  ti.setTimeout(3_600_000); // drain payments, up to 9 activity sweeps, exposure + claim close
  // Small open reserves only: the drain pays them out with Final Payments (OneInc staging, TEST only).
  // A migrated payment still "Pending approval" holds the whole reserve (CPP-DE-01-25-0746263: $500 since 07/16/2025),
  // so the claim cannot be drained until someone approves or rejects it — noted, next claim (up to 4).
  let cn = null;
  let before = null;
  const held = [];
  for (let k = 0; k < 4 && !cn; k++) {
    const c = await recentClaim(page, { maxReserve: 1500 });
    const pend = (await M.transactions(page)).filter((t) => t.Type === 'Payment' && /Pending approval/i.test(t.Status));
    if (pend.length) { held.push(`${c}: ${pend.map((t) => `$${t.Amount} payment Pending approval since ${t.Date}`).join(', ')}`); continue; }
    cn = c;
    await M.open(page, cn);
    before = await M.financialSummary(page);
  }
  if (held.length) ti.annotations.push({ type: 'manual', description: `Migrated claims passed over — payments pending approval: ${held.join(' || ')}` });
  if (!cn) throw new W.Blocked(`every recent migrated claim tried holds a pending-approval payment — ${held.join(' || ')}`);
  R.setClaim(ti, cn, process.env.CC_ADMIN_USER || 'admin');
  await R.step(page, ti, `${cn} before close: ${JSON.stringify(before.total)}`);
  await R.step(page, ti, `Payment Contact Details: ${(await ensurePaymentContacts(page, cn, before.lines.filter((l) => (l.values['Remaining Reserves'] || 0) > 0).map(lineClaimant))).join(' | ') || 'no line to pay'}`);
  // Migrated claims carry overdue activities; completing one spawns "… has been escalated for this claim" notices, so
  // one sweep is not enough (PA-DE-01-25-0745522 took three passes, 2026-11-15). Sweep until nothing more completes,
  // then close; one more sweep + close if the close is refused for open activities.
  const sweep = async () => {
    for (let pass = 0; pass < 3; pass++) {
      await M.open(page, cn);
      await R.clickMenu(page, /^Workplan$/);
      await page.locator('select[name$="WorkplanFilter"]').first().selectOption({ label: 'All open activities' }).catch(() => {});
      await W.settle(page, 2500);
      await E.completeActivitiesCloud(page);
    }
  };
  await takeOver(page, ti, cn);
  await sweep();
  let err = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    err = '';
    await B.openExistingClaim(page, cn);
    await E.close(page, cn).catch((e) => { err = e.message.split('\n')[0]; });
    if (!err || !/open activities/i.test(err)) break;
    await R.step(page, ti, `Close refused for open activities — sweeping again: ${err.slice(0, 200)}`);
    await sweep();
  }
  await M.open(page, cn);
  const st = (await M.header(page) || {}).status || '';
  const items = [{ description: `${cn}: claim closed`, expected: 'St: Closed', actual: `${st}${err ? ' — ' + err : ''}`, ok: /closed/i.test(st) }];
  await reconcileAfter(page, cn, items, 'the close');
  await checkAll(page, ti, items);
}));

test('RG-RX045 [Migrated Claims - lifecycle]: payees on recent migrated claims carry a complete address (street, city, state, ZIP)', async ({ page }, ti) => S.blockable(test, async () => {
  await login(page);
  const claims = await M.pickRecent(page, 5, { log });
  R.setClaim(ti, claims.join(', '), process.env.CC_USER);
  const items = [];
  for (const cn of claims) {
    await M.open(page, cn);
    await W.navigate(page, 'parties');
    await W.settle(page, 2500);
    // Parties Involved rows: Name | Roles | … | Address (ends "<State> <ZIP>"). Payees = Claimant / Check Payee / Insured.
    const rows = await page.evaluate(() => [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr') && r.querySelector('[id$="-Name"]'))
      .map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()));
    const payees = rows.filter((t) => /\b(Claimant|Check Payee|Insured)\b/.test(t));
    const bad = payees.filter((t) => !/\b\d{5}(-\d{4})?\s*$/.test(t));
    items.push({ description: `${cn}: every claimant / payee / insured has an address ending in a ZIP`, expected: `${payees.length} of ${payees.length}`, actual: bad.length ? `missing on: ${bad.map((t) => t.slice(0, 90)).join(' || ')}` : `${payees.length} of ${payees.length}`, ok: !bad.length });
  }
  await checkAll(page, ti, items);
}));

test('RG-RX046 [Migrated Claims - lifecycle]: recent migrated claims can be paid as they came across', async ({ page }, ti) => S.blockable(test, async () => {
  process.env.ONEINC_ALLOW_FINISH = process.env.ONEINC_ALLOW_FINISH || '1';
  ti.setTimeout(3_600_000);
  await login(page);
  // A $1.xx partial payment to each claim's line claimant, with nothing changed but the Payment Contact Details cloud
  // newly requires (set the way an adjuster would). Every refusal is migrated data cloud cannot pay on: payee address
  // (no ZIP / street / city), exposure owner's user record (examiner number, name, e-mail, phone), pending approvals.
  const claims = await M.pickRecent(page, 5, { log });
  R.setClaim(ti, claims.join(', '), process.env.CC_USER);
  const items = [];
  for (const cn of claims) {
    await M.open(page, cn);
    const fin = await M.financialSummary(page);
    const line = fin.lines.find((l) => (l.values['Remaining Reserves'] || 0) >= 5);
    if (!line) { await R.step(page, ti, `${cn}: no line with $5+ remaining reserve — skipped`); continue; }
    const name = line.label.replace(/^\(\d+\)\s*/, '').split(' - ')[0];
    const claimant = lineClaimant(line);
    await ensurePaymentContacts(page, cn, [claimant]);
    let r;
    try { r = await P.makePayment(page, { reserveLine: `match:${esc(name)}`, payee: claimant || 'claimant', amount: P.uniqueAmount(1) }); } catch (e) { r = { finished: false, messages: [e.message.split('\n')[0].slice(0, 300)] }; }
    const errs = (r.messages || []).filter((m) => !/^Validation Results|Warnings?:|Loss payee\/additional insured/i.test(m));
    items.push({ description: `${cn}: $${r.amount || '1.xx'} to ${claimant || 'claimant'} on ${line.label.slice(0, 60)}`, expected: 'payment accepted', actual: r.finished ? `accepted${errs.length ? ' — ' + errs.join(' | ') : ''}` : `refused — ${errs.join(' | ') || (r.messages || []).join(' | ') || 'no message'}`, ok: !!r.finished });
  }
  if (!items.length) throw new W.Blocked(`none of ${claims.join(', ')} has a line with $5+ remaining reserve`);
  await checkAll(page, ti, items);
}));
