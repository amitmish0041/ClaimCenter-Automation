/**
 * tests/Regression/Extended.regression.test.js — cases ADDED beyond Regression Test Design V1.0 (ids RX001…), so the
 * flows V1.0 checks on one or two LOBs are also checked on the others, and the integrations ClaimCenter depends on
 * (SmartCOMM, OneInc check/void, Contact Manager, recovery receipts) have a regression case of their own.
 *
 * Same building blocks as the V1.0 specs (helpers/regression/regressionSteps.js). Claims that get closed or written to
 * heavily are filed fresh per case; read-mostly cases use the financialRules shared-claim registry.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, B, A, E, F, P, CO } = S;

S.hooks(test);

const ROUTE = {
  HO: { assignmentType: 'First Party', lossCause: 'LC01', exposure: 'Coverage A', reserveLine: 'Dwelling|Coverage A' },
  WC: { assignmentType: '', lossCause: 'LC07', exposure: 'Medical', reserveLine: 'Medical|Workers' },
  CA: { assignmentType: 'Casualty', lossCause: 'LC15', exposure: 'Collision', reserveLine: 'Collision' },
  BOP: { assignmentType: 'Bodily Injury', lossCause: 'LC03', exposure: 'Business Liability', reserveLine: 'Liability|Bodily' },
  CP: { assignmentType: 'Bodily Injury', lossCause: 'LC03', exposure: 'Premises', reserveLine: 'Premises|Liability|Bodily' },
  PA: { assignmentType: 'Casualty', lossCause: 'LC15', exposure: 'Collision', reserveLine: 'Collision' },
  GL: { assignmentType: 'Bodily Injury', lossCause: 'LC03', exposure: 'Premises', reserveLine: 'Premises|Liability' },
};
// share = draw from / feed the claim pool; own = a claim this case uses up (closed, or asserts a brand-new activity).
const share = (page, kind, tag) => S.pooledClaim(page, kind, tag, { assignmentType: ROUTE[kind].assignmentType, lossCause: ROUTE[kind].lossCause });
const own = (page, kind, tag) => S.fileClaim(page, kind, tag, { assignmentType: ROUTE[kind].assignmentType, lossCause: ROUTE[kind].lossCause, pool: false });

// ── Financials on every LOB (V1.0 TC067 / TC073 are Personal Auto only) ───────────────────────────────────────────
const FIN = [['RX001', 'HO', 'Homeowners'], ['RX002', 'WC', "Workers' Comp"], ['RX003', 'CA', 'Commercial Auto'], ['RX004', 'BOP', 'BOP'], ['RX005', 'CP', 'Commercial Package']];
for (const [id, kind, lob] of FIN) {
  test(`RG-${id} [Financials - LOB variants]: ${lob} reserve, payment within reserves, TXV11000 above reserves`, async ({ page }, ti) => S.blockable(test, async () => {
    const r = ROUTE[kind];
    const { cn } = await share(page, kind, `RG-${id}`);
    R.setClaim(ti, cn, 'su');
    await R.asAdmin(page, cn);
    await E.repairCloud(page, cn).catch(() => {});
    const said = await F.createReserve(page, { reserveAmount: 1000, exposure: r.exposure, strict: false });
    const tx = await R.transactionRows(page, cn);
    await R.check(page, ti, { description: `${lob}: reserve $1,000 on ${r.exposure}`, expected: 'reserve row', actual: tx.filter((x) => /Reserve/i.test(x)).join(' | ') || `none ${said || ''}`, ok: tx.some((x) => /Reserve/i.test(x) && /1,000\.00/.test(x)) });
    await R.asStandard(page, cn);
    const ok = await P.makePayment(page, { reserveLine: `match:${r.reserveLine}`, amount: P.uniqueAmount(40) });
    const row = (await R.transactionRows(page, cn)).find((x) => x.includes(Number(ok.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })));
    await R.check(page, ti, { description: `${lob}: payment within reserves created`, expected: `$${ok.amount}`, actual: row || ok.messages.join(' | ') || 'not found', ok: !!row });
    await B.openExistingClaim(page, cn);
    const big = await P.makePayment(page, { reserveLine: `match:${r.reserveLine}`, amount: '1500.37' });
    await R.check(page, ti, { description: `${lob}: TXV11000 blocks a payment above available reserves`, expected: 'exceeds available reserves', actual: `${big.finished ? 'FINISHED' : 'refused'} — ${big.messages.join(' | ')}`, ok: !big.finished && big.messages.some((m) => /exceed/i.test(m)) });
  }));
}

// ── Full close on every LOB (DMEC0002, activity sweep, exposure + claim close — e2eSteps.close) ─────────────────────
const CLOSE = [['RX006', 'PA', 'Personal Auto'], ['RX007', 'HO', 'Homeowners'], ['RX008', 'WC', "Workers' Comp"], ['RX009', 'CA', 'Commercial Auto']];
for (const [id, kind, lob] of CLOSE) {
  test(`RG-${id} [Claim Lifecycle - LOB variants]: ${lob} claim drains, closes exposures and closes`, async ({ page }, ti) => S.blockable(test, async () => {
    const { cn } = await own(page, kind, `RG-${id}`);
    R.setClaim(ti, cn, 'su');
    await R.asAdmin(page, cn);
    await E.repairCloud(page, cn).catch(() => {});
    await F.createReserve(page, { reserveAmount: 600, exposure: ROUTE[kind].exposure, strict: false });
    await E.close(page, cn);
    await B.openExistingClaim(page, cn);
    const st = ((await S.bodyText(page)).match(/St:\s*(\w+)/) || [])[1] || '';
    await R.check(page, ti, { description: `${lob}: claim status`, expected: 'Closed', actual: st, ok: /Closed/i.test(st) });
    const open = (await R.hasActivity(page, /./, cn)).rows.filter((x) => /\bOpen\b/.test(x));
    await R.check(page, ti, { description: `${lob}: no open activities left`, expected: '0', actual: open.slice(0, 3).join(' || ') || '0', ok: !open.length });
    const tx = await R.transactionRows(page, cn);
    await R.step(page, ti, `Transactions after close: ${tx.slice(0, 6).join(' || ')}`);
  }));
}

// ── Medicare tab on liability BI exposures (V1.0 TC038 covers WC Medical + Auto PIP) ───────────────────────────────
const MED = [['RX010', 'CA', 'Commercial Auto'], ['RX011', 'GL', 'General Liability'], ['RX012', 'BOP', 'BOP']];
for (const [id, kind, lob] of MED) {
  test(`RG-${id} [MSP Navigator - LOB variants]: ${lob} Bodily Injury exposure — Medicare beneficiary + ICD saved`, async ({ page }, ti) => S.blockable(test, async () => {
    const N = require('../../helpers/oneInc/needsData');
    const { cn } = await S.pooledClaim(page, kind, `RG-${id}`, { poolKey: `${kind}:BI`, assignmentType: 'Bodily Injury', lossCause: 'LC03', exposures: [{ coverageLabel: ['Bodily Injury', 'Bodily Injury Liability', 'Premises/Operations', 'Business Liability'] }] });
    R.setClaim(ti, cn, process.env.CC_USER);
    const said = await N.setExposureMedicare(page, 'Bodily Injury|Liability|Premises', { beneficiary: 'Yes', icd: 'S13.4XXA' });
    await R.step(page, ti, String(said || 'Medicare set'));
    await page.getByText('Medicare', { exact: true }).first().click().catch(() => {});
    await W.settle(page, 2000);
    const s = await S.readScreen(page);
    const ben = S.findField(s, 'Is Claimant a Medicare Beneficiary?');
    await R.check(page, ti, { description: `${lob}: Medicare beneficiary saved`, expected: 'Yes', actual: ben ? JSON.stringify(ben.radios || ben.value) : 'field missing', ok: !!ben && (ben.radios ? ben.radios.some((r) => r.label === 'Yes' && r.checked) : /yes/i.test(ben.value)) });
    await R.check(page, ti, { description: `${lob}: ICD code S13.4XXA listed`, expected: 'S134XXA', actual: /S13\.?4XXA/i.test(s.body) ? 'listed' : 'not listed', ok: /S13\.?4XXA/i.test(s.body) });
  }));
}

// ── Subrogation on more LOBs (V1.0 TC058/TC059 are WI Personal Auto) ───────────────────────────────────────────────
for (const [id, kind, lob] of [['RX013', 'HO', 'Homeowners'], ['RX014', 'CA', 'Commercial Auto']]) {
  test(`RG-${id} [Subrogation - LOB variants]: ${lob} — Referred to Subro enables Subrogation (Open) and routes it`, async ({ page }, ti) => S.blockable(test, async () => {
    const { cn } = await share(page, kind, `RG-${id}`);
    R.setClaim(ti, cn, process.env.CC_USER);
    await B.openExistingClaim(page, cn);
    await A.openLossDetailsGeneral(page);
    await A.editAndSave(page, 'Referred to Subro = Yes', async () => {
      const f = (await S.readScreen(page)).fields.find((x) => /referred to subro/i.test(x.label));
      if (!f) throw new W.Blocked('no "Referred to Subro" on Loss Details');
      if (f.radios) await W.answer(page, f.label, 'Yes'); else await A.selectByLabel(page, f.label, 'Yes');
      const adj = (await S.readScreen(page)).fields.find((x) => /subro.*adjuster/i.test(x.label) && x.kind === 'select');
      if (adj) await A.selectByLabel(page, adj.label, /^(?!<none>$).+/);
    });
    await S.nav(page, /^Subrogation$/i);
    const sub = await S.bodyText(page);
    await R.check(page, ti, { description: `${lob}: Subrogation screen Open`, expected: 'Open', actual: (sub.match(/Status[^\n]{0,40}/) || ['no status'])[0], ok: /\bOpen\b/.test(sub) });
    const act = await S.activities(page, cn, /Subrogation/i);
    await R.check(page, ti, { description: `${lob}: subrogation activity routed`, expected: 'Subrogation Reassignment / Review activity', actual: act.join(' | ') || 'none', ok: act.length > 0 });
  }));
}

// ── SIU fire cause of loss on commercial property (V1.0 TC045 is PA + HO) ──────────────────────────────────────────
for (const [id, kind, lob, match] of [['RX015', 'BOP', 'BOP', 'Building|Property|Business'], ['RX016', 'CP', 'Commercial Package', 'Building|Property|Premises']]) {
  test(`RG-${id} [Special Investigations - LOB variants]: ${lob} fire cause of loss → SIU file review`, async ({ page }, ti) => S.blockable(test, async () => {
    const { cn } = await S.fileClaim(page, kind, `RG-${id}`, { assignmentType: 'First Party', lossCause: 'LC01', pool: false });
    R.setClaim(ti, cn, process.env.CC_USER);
    const before = (await S.activities(page, cn, /SIU/i)).length;
    await S.openExposureMatching(page, match);
    await A.editAndSave(page, 'cause of loss Fire', async () => { await A.selectByLabel(page, 'Cause of Loss', /Fire|LC01/i); });
    const rows = await S.activities(page, cn, /SIU/i);
    await R.check(page, ti, { description: `${lob}: SIU file review after a fire cause of loss`, expected: 'new SIU activity, SIU group', actual: rows.join(' | ') || 'none', ok: rows.length > before });
  }));
}

// ── ISO on more LOBs (V1.0 TC056 BOP, TC057 PA) ────────────────────────────────────────────────────────────────────
for (const [id, kind, lob] of [['RX017', 'HO', 'Homeowners'], ['RX018', 'WC', "Workers' Comp"], ['RX019', 'CA', 'Commercial Auto']]) {
  test(`RG-${id} [ISO - LOB variants]: ${lob} claim + exposure sent to ISO`, async ({ page }, ti) => S.blockable(test, async () => {
    const { cn } = await share(page, kind, `RG-${id}`);
    R.setClaim(ti, cn, process.env.CC_USER);
    let seen = '';
    for (let t = 0; t < 20; t++) {
      await B.openExistingClaim(page, cn);
      await A.openLossDetailsGeneral(page);
      await S.nav(page, /^ISO$/i).catch(() => {});
      const s = await S.readScreen(page);
      const st = S.findField(s, 'ISO Status') || S.findField(s, 'Status');
      seen = st ? st.value : '(no ISO status)';
      if (/sent/i.test(seen)) break;
      await page.waitForTimeout(30000);
    }
    await R.check(page, ti, { description: `${lob}: ISO status`, expected: 'SENT', actual: seen, ok: /sent/i.test(seen) });
  }));
}

// ── Integrations ───────────────────────────────────────────────────────────────────────────────────────────────────
test('RG-RX020 [SmartCOMM - integration]: Document generated from a template lands on the claim', async ({ page }, ti) => S.blockable(test, async () => {
  const D = require('../../helpers/smartComm/documentService');
  const cn = await R.sharedClaim(page, 'PA', 'RG-RX020', { reserveActions: 0 });
  R.setClaim(ti, cn, process.env.CC_USER);
  const tmpl = process.env.REG_SMARTCOMM_TEMPLATE || 'Donegal Base Template';
  const before = (await (async () => { await S.nav(page, 'Documents'); return R.gridRows(page); })()).length;
  await B.openExistingClaim(page, cn);
  await D.openCreateFromTemplate(page);
  const row = await D.selectTemplate(page, tmpl);
  if (!row) throw new W.Blocked(`template "${tmpl}" not found — set REG_SMARTCOMM_TEMPLATE`);
  await D.setPrimaryRecipient(page, {}).catch(() => {});
  await D.setDeliveryChannel(page, 'Print').catch(() => {});
  await D.generateOnDemand(page, { fileNamePrefix: `RG-RX020-${cn}` });
  await B.openExistingClaim(page, cn);
  await S.nav(page, 'Documents');
  const after = await R.gridRows(page);
  await R.check(page, ti, { description: `"${tmpl}" document on the claim's Documents`, expected: 'one more document row', actual: `${before} → ${after.length}: ${after.slice(0, 3).join(' || ')}`, ok: after.length > before });
}));

test('RG-RX021 [OneInc - integration]: Homeowners check issued then voided', async ({ page }, ti) => S.blockable(test, async () => {
  process.env.ONEINC_ALLOW_FINISH = process.env.ONEINC_ALLOW_FINISH || (['test', 'dev'].includes(B.TIER) ? '1' : '');
  const cn = await R.sharedClaim(page, 'HO', 'RG-RX021', { reserveActions: 0 });
  R.setClaim(ti, cn, process.env.CC_USER);
  page.__oneIncParties = null;
  await R.step(page, ti, await CO.createFullCheck(page, { payee: 'claimant' }));
  await CO.openNewestCheck(page);
  await CO.submitVoid(page);
  await W.navigate(page, 'checks');
  const rows = await R.gridRows(page);
  await R.check(page, ti, { description: 'Newest check is voided (or void pending)', expected: 'Voided / Pending Void', actual: rows.slice(0, 3).join(' || '), ok: rows.slice(0, 3).some((r) => /void/i.test(r)) });
}));

test('RG-RX022 [Contact Manager - integration]: New claim contact is saved to Contact Manager', async ({ page }, ti) => S.blockable(test, async () => {
  const CM = require('../../helpers/oneInc/contactManager');
  const cn = await R.sharedClaim(page, 'PA', 'RG-RX022', { reserveActions: 0 });
  R.setClaim(ti, cn, process.env.CC_USER);
  const last = `Cmsync${Date.now().toString().slice(-6)}`;
  await W.addClaimPersonContact(page, { first: 'Regression', last, role: 'Witness' });
  await R.step(page, ti, `Added contact Regression ${last} (Witness) on ${cn}`);
  const found = await CM.withCM(page, async (cm) => {
    for (let t = 0; t < 6; t++) {
      await cm.getByRole('textbox', { name: /Last name|Name/i }).first().fill(last);
      await cm.getByRole('button', { name: /^Search$/ }).first().click();
      await cm.waitForTimeout(4000);
      if (await cm.getByText(last, { exact: false }).first().isVisible().catch(() => false)) return true;
      await cm.waitForTimeout(20000);
    }
    return false;
  });
  await R.check(page, ti, { description: 'Contact found in Contact Manager', expected: `Regression ${last}`, actual: found ? 'found' : 'not found after ~2 minutes', ok: found });
}));

test('RG-RX023 [Recovery - integration]: Homeowners subrogation recovery reserve + receipt', async ({ page }, ti) => S.blockable(test, async () => {
  const { cn } = await share(page, 'HO', 'RG-RX023');
  R.setClaim(ti, cn, 'su');
  await R.asAdmin(page, cn);
  const before = await R.transactionRows(page, cn);
  await B.openExistingClaim(page, cn);
  await E.recovery(page, 'HO', 450, { skipSubro: false });
  const added = R.newRows(before, await R.transactionRows(page, cn));
  await R.check(page, ti, { description: 'Recovery reserve and receipt on the claim', expected: 'Recovery Reserve + Recovery $450.00', actual: added.join(' | ') || 'none', ok: added.some((r) => /Recovery/i.test(r) && /450\.00/.test(r)) });
}));
