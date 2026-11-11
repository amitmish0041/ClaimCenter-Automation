/**
 * tests/Regression/Mainframe.regression.test.js — Regression Test Design V1.0, Mainframe-PUOF (TC082 class code,
 * TC083 risk unit). Two-day cases: Day 1 files the claim + exposure + reserve and records it in
 * results/regression/mainframe.json; Day 2 (the case run again on a LATER date) changes the class code / risk unit on
 * that claim. Re-running on Day 1 again is a no-op that reports BLOCKED ("Day 2 not due").
 */
const { test } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, A, F } = S;

S.hooks(test);

const STORE = path.join(S.RESULTS_DIR, 'mainframe.json');
const read = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (_) { return {}; } };
const write = (o) => { fs.mkdirSync(S.RESULTS_DIR, { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(o, null, 2)); };
const today = () => new Date().toISOString().slice(0, 10);

async function dayOne(page, ti, id) {
  const claim = await S.fileClaim(page, 'PA', `RG-${id}`, { assignmentType: 'Casualty', lossCause: 'LC15', pool: false });
  await R.asAdmin(page, claim.cn);
  await S.E.repairCloud(page, claim.cn).catch(() => {});
  await F.createReserve(page, { reserveAmount: 1200, exposure: 'Collision', strict: false });
  const tx = await R.transactionRows(page, claim.cn);
  const st = read(); st[id] = { claim: claim.cn, day1: today() }; write(st);
  R.setClaim(ti, claim.cn, 'su');
  await R.check(page, ti, { description: 'Day 1: claim with exposure and reserve', expected: 'reserve on Collision', actual: tx.filter((r) => /^\d.*\$[\d,]+\.\d\d/.test(r)).join(' | ') || 'no reserve', ok: tx.some((r) => /^\d.*\$[\d,]+\.\d\d/.test(r)) }); // Reserves filter: rows carry no "Reserve" word
  test.skip(true, `BLOCKED: Day 1 done (${claim.cn}) — run this case again tomorrow or later for Day 2`);
}

async function dayTwo(page, ti, id, change) {
  const rec = read()[id];
  R.setClaim(ti, rec.claim, 'su');
  await R.asAdmin(page, rec.claim);
  const before = await R.transactionRows(page, rec.claim);
  const what = await change();
  const after = await R.transactionRows(page, rec.claim);
  await R.step(page, ti, what);
  await R.check(page, ti, { description: 'Day 2 change saved with no unintended change to reserves', expected: `transactions unchanged (${before.length} rows)`, actual: `${after.length} rows${R.newRows(before, after).length ? ` — new: ${R.newRows(before, after).join(' | ')}` : ''}`, ok: R.newRows(before, after).length === 0 });
  const st = read(); st[id] = { ...rec, day2: today() }; write(st);
  ti.annotations.push({ type: 'manual', description: `Verify the PUOF mainframe feed for ${rec.claim} picked up the change.` });
}

for (const [id, label] of [['TC082', 'Class Code'], ['TC083', 'Risk Unit']]) {
  test(`RG-${id} [Mainframe-PUOF]: ${label} change on Day 2 of a claim created on Day 1`, async ({ page }, ti) => S.blockable(test, async () => {
    const rec = read()[id];
    if (!rec || rec.day2) return dayOne(page, ti, id);
    if (rec.day1 === today()) test.skip(true, `BLOCKED: Day 2 not due — ${rec.claim} was created today; run again on a later date`);
    if (id === 'TC082') {
      return dayTwo(page, ti, id, async () => {
        await A.openLossDetailsGeneral(page);
        const cc = S.findField(await S.readScreen(page), 'Class Code');
        if (!cc) throw new W.Blocked('no Class Code on Loss Details');
        let picked = '';
        await A.editAndSave(page, 'Class Code', async () => {
          const opts = ((S.findField(await S.readScreen(page), 'Class Code') || {}).options || []).filter((o) => o && !/^<none>$/i.test(o) && o !== cc.value);
          if (!opts.length) throw new W.Blocked('no other Class Code option');
          picked = await A.selectByLabel(page, 'Class Code', opts[0]);
        });
        const now = (S.findField(await S.readScreen(page), 'Class Code') || {}).value;
        await R.check(page, ti, { description: 'Class code updated at claim level', expected: picked || 'a different class code', actual: `${cc.value} → ${now}`, ok: now && now !== cc.value });
        return `Class Code ${cc.value} → ${now}`;
      });
    }
    return dayTwo(page, ti, id, async () => {
      await S.openExposureMatching(page, 'Collision');
      let before = '', now = '';
      await A.editAndSave(page, 'exposure Vehicle / Risk Unit', async () => {
        const f = (await S.readScreen(page)).fields.find((x) => x.kind === 'select' && /vehicle|risk unit|location/i.test(x.label));
        if (!f) throw new W.Blocked('no Vehicle / Risk Unit dropdown on the exposure');
        before = f.value;
        const other = (f.options || []).find((o) => o && !/^<none>$|^New/i.test(o) && o !== f.value);
        if (!other) throw new W.Blocked('policy has only one vehicle / location — add one to the test policy');
        now = await A.selectByLabel(page, f.label, other);
      });
      await R.check(page, ti, { description: 'Risk unit updated at exposure level', expected: 'a different vehicle/location', actual: `${before} → ${now}`, ok: !!now && now !== before });
      return `Risk unit ${before} → ${now}`;
    });
  }));
}
