/**
 * tests/Regression/IntakeFNOL.regression.test.js — Regression Test Design V1.0, card "Intake FNOL" (TC007–TC019).
 * One data-driven test per LOB: fnolHelper.completeFNOL with the case's Assignment Type and Loss Cause (opt-in
 * lossDetails.assignmentType / lossCause), then routing (the "New Claim Saved" page), claim-number format, Workplan
 * activities (financialRules.hasActivity) and, where the case names one, the initial reserve (Transactions).
 *
 * Not here (manual, see catalog): the "navigate all screens on-prem vs cloud" step — run the Migration Reconciliation
 * tab on the claim number this test writes to its result.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R } = S;

S.hooks(test);

const VERIFY_COV = { rule: 'DMCW0001 Verify Coverage', re: /verify coverage/i };
const CONTACT_INS = { rule: 'Contact Insured (DMCW0003/0005/0006)', re: /contact.*insured|initial contact/i };
const SUBRO_POT = { rule: 'DMCW0032 Subrogation Potential', re: /subrogation potential/i };
const REVIEW_30 = { rule: 'DMCW0082 Initial 30 Day Review', re: /30.?day/i };
const DIARY_12 = { rule: 'DMCW0324 12-Day Diary Supervisor', re: /12.?day/i };
const REPORT_90 = { rule: 'DMCW0325 Commercial 90-Day Report', re: /90.?day/i, optional: 'third-party CPP/GL/BOP only' };
const POLICE_FIRE = { rule: 'DMEW0050 Request Police/Fire Report', re: /police|fire report/i };
const WC_DIARY = { rule: 'DMCW0021 + DMCP0025 WC 30-day diaries', re: /30.?day|diary/i, optional: 'not when Medical Only' };

const CASES = [
  { id: 'TC007', feature: 'Intake FNOL', title: 'OH Personal Auto PC — Ohio branch routing (DMGA0060), DMIR0004 $200 Transportation Expense reserve', kind: 'PA_OH', assignmentType: 'Casualty', lossCause: 'LC15', group: /Ohio/i, activities: [], format: true, reserve: { line: /Transportation/i, amount: '$200.00', rule: 'DMIR0004' } },
  { id: 'TC008', feature: 'Intake FNOL', title: 'DE Commercial Auto — routing (DMGA0030), workplan, Silver Series/MicPak exposure', kind: 'CA_DE', assignmentType: 'Casualty', lossCause: 'LC11', group: null, activities: [VERIFY_COV, CONTACT_INS, SUBRO_POT] },
  { id: 'TC009', feature: 'Intake FNOL', title: "MI Workers Comp (legacy) — Michigan Workers' Compensation group (DMGA0100)", kind: 'WC_MI', group: /Michigan Workers/i, activities: [WC_DIARY], format: true, wcApproval: true },
  { id: 'TC010', feature: 'Intake FNOL', title: 'PA Personal Excess Liability (legacy) — BI Section / General Casualty routing', kind: 'PEL', assignmentType: 'Bodily Injury', lossCause: 'LC03', group: /BI Section|General Casualty|Bodily Injury/i, activities: [VERIFY_COV, CONTACT_INS, SUBRO_POT] },
  { id: 'TC011', feature: 'Intake FNOL', title: 'PA Inland Marine (legacy) — First Party → Property Clerical (DMGA0007)', kind: 'IM', assignmentType: 'First Party', lossCause: 'LC40', group: /Property Clerical/i, activities: [VERIFY_COV, CONTACT_INS, REVIEW_30, SUBRO_POT], format: true },
  { id: 'TC012', feature: 'Intake FNOL', title: 'General Liability — GL group (DMGA0062), Contact Insured (DMCW0006)', kind: 'GL', assignmentType: 'Bodily Injury', lossCause: 'LC03', group: /General Liability|\bGL\b/i, activities: [CONTACT_INS, { ...SUBRO_POT, optional: 'if applicable for GL' }], format: true },
  { id: 'TC013', feature: 'Intake FNOL', title: 'PA Farmowners (legacy) — First Party → Property Clerical (DMGA0007)', kind: 'FARM', assignmentType: 'First Party', lossCause: 'LC01', group: /Property Clerical|Farm/i, activities: [CONTACT_INS, REVIEW_30, VERIFY_COV], format: true },
  { id: 'TC014', feature: 'Intake FNOL', title: 'MI Boat Owners (legacy) — MI First Party → Michigan Property (DMGA0104)', kind: 'BOAT', assignmentType: 'MI_FIRST', lossCause: 'LC40', group: /Michigan Property/i, activities: [CONTACT_INS, REVIEW_30, DIARY_12, VERIFY_COV], format: true },
  { id: 'TC015', feature: 'Intake FNOL', title: 'PA Commercial Package PC — Premises/Operations, BI Section (DMGA0001) or GL', kind: 'CP', assignmentType: 'Bodily Injury', lossCause: 'LC03', group: /BI Section|Bodily Injury|General Liability|\bGL\b/i, activities: [VERIFY_COV, CONTACT_INS, SUBRO_POT, REPORT_90] },
  { id: 'TC016', feature: 'Intake FNOL', title: 'PA BOP PC — Business Liability, GL group / BI Section', kind: 'BOP', assignmentType: 'Bodily Injury', lossCause: 'LC03', group: /BI Section|Bodily Injury|General Liability|\bGL\b/i, activities: [CONTACT_INS, VERIFY_COV, SUBRO_POT, REPORT_90], format: true },
  { id: 'TC017', feature: 'Intake FNOL', title: 'PA Homeowners PC — Coverage A Dwelling, Property Clerical (DMGA0007), property + fire workplan', kind: 'HO', assignmentType: 'First Party', lossCause: 'LC01', group: /Property Clerical/i, activities: [VERIFY_COV, CONTACT_INS, REVIEW_30, DIARY_12, POLICE_FIRE] },
  { id: 'TC018', feature: 'Intake FNOL', title: 'PA Dwelling Fire PC — Coverage A Dwelling, Property Clerical (DMGA0007)', kind: 'DF', assignmentType: 'First Party', lossCause: 'LC01', group: /Property Clerical/i, activities: [VERIFY_COV, CONTACT_INS, REVIEW_30, DIARY_12] },
  { id: 'TC019', feature: 'Intake FNOL', title: 'PA Commercial Excess Liability (legacy) — BI Section (DMGA0001) or GL', kind: 'CEL', assignmentType: 'Bodily Injury', lossCause: 'LC03', group: /BI Section|Bodily Injury|General Liability|\bGL\b/i, activities: [CONTACT_INS, VERIFY_COV, SUBRO_POT] },
];

for (const c of CASES) {
  test(`RG-${c.id} [${c.feature}]: ${c.title}`, async ({ page }, ti) => S.blockable(test, async () => {
    const claim = await S.fileClaim(page, c.kind, `RG-${c.id}`, { assignmentType: c.assignmentType, lossCause: c.lossCause });
    R.setClaim(ti, claim.cn, process.env.CC_USER);
    await R.step(page, ti, `FNOL (${c.kind}, policy ${claim.policyNumber}, Assignment Type "${c.assignmentType || 'default'}", Loss Cause "${c.lossCause || 'default'}") → ${claim.cn}; New Claim Saved: group "${claim.group}", user "${claim.user}"`);

    if (c.group) await R.check(page, ti, { description: 'Claim routing (assignment rule)', expected: String(c.group), actual: claim.group || '(no Assigned Group on the saved page)', ok: c.group.test(claim.group) });
    else ti.annotations.push({ type: 'manual', description: `Routing observed: ${claim.group || '(none)'} — the TC expects CSC via DMGA0030; confirm the group name.` });

    if (c.format) {
      const f = S.claimNumberFormat(claim.cn);
      await R.check(page, ti, { description: 'Claim number format: Prefix-State-Office-YY-Sequence', expected: `e.g. WC-IA-60-${String(new Date().getFullYear()).slice(-2)}-0005719`, actual: `${claim.cn} ${f.parts ? JSON.stringify(f.parts) : '(does not parse)'}`, ok: f.ok });
    }

    if (c.activities.length) {
      const { rows } = await R.hasActivity(page, /./, claim.cn);
      await R.step(page, ti, `Workplan: ${rows.length} row(s)`);
      for (const a of c.activities) {
        const hit = rows.filter((r) => a.re.test(r));
        if (a.optional && !hit.length) { ti.annotations.push({ type: 'manual', description: `${a.rule}: not created (${a.optional}) — confirm it does not apply.` }); continue; }
        await R.check(page, ti, { description: `Workplan activity — ${a.rule}`, expected: String(a.re), actual: hit[0] || `not found (rows: ${rows.slice(0, 8).join(' || ')})`, ok: hit.length > 0 });
      }
    }

    if (c.reserve) {
      const rows = await R.transactionRows(page, claim.cn);
      const hit = rows.filter((r) => c.reserve.line.test(r) && r.includes(c.reserve.amount));
      await R.check(page, ti, { description: `${c.reserve.rule} initial reserve`, expected: `${c.reserve.amount} on ${c.reserve.line}`, actual: hit[0] || rows.filter((r) => /Reserve/i.test(r)).join(' | ') || 'no reserve rows', ok: hit.length > 0 });
    }

    if (c.wcApproval) {
      // DMAR0074: a payment that needs approval routes to the MI WC group. Reserve as the admin (the standard user has no
      // Reserve action on cloud — financialRules header), pay as the standard user, read who the approval went to.
      const { createReserve } = require('../../helpers/financialsHelper');
      const P = require('../../helpers/financialPayments');
      await R.asAdmin(page, claim.cn);
      await S.E.repairCloud(page, claim.cn).catch(() => {});
      await createReserve(page, { reserveAmount: 20000, exposure: 'Workers', strict: false });
      await R.asStandard(page, claim.cn);
      const pay = await P.makePayment(page, { amount: P.uniqueAmount(7500) });
      await R.step(page, ti, `Payment $${pay.amount} as ${process.env.CC_USER}: finished=${pay.finished} ${pay.messages.join(' | ')}`);
      const approver = await R.approverFor(page).catch(() => null);
      await R.check(page, ti, { description: 'DMAR0074 MI WC approval routing', expected: 'approval activity routed to the Michigan WC group approver', actual: approver || 'no open approval activity', ok: !!approver });
    }
    ti.annotations.push({ type: 'manual', description: `On-prem vs cloud screen comparison: run Migration Reconciliation on ${claim.cn}.` });
  }));
}
