/**
 * tests/Regression/ExternalIntake.regression.test.js — Regression Test Design V1.0 cases whose claim or file is created
 * OUTSIDE ClaimCenter: Donegal website (TC020), mobile app (TC021), Alliance Glass (TC034), FNOL XML intake (TC035,
 * TC055), Bank of America check file (TC053, TC054), website → S3 → UAC (TC081).
 *
 * The outside step (submit on the website / app, drop the file in S3) stays manual — no channel automation exists and
 * the S3 admin service only lists/downloads. Everything ClaimCenter does with the result IS automated, and every claim
 * that arrives this way gets the same key validations as a wizard claim (S.validateIntakeClaim: found by search, policy
 * verified, assigned, loss details, contacts, workplan, exposures). Batches run only with REG_ALLOW_BATCHES=1.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, B } = S;

S.hooks(test);

const manualFirst = (ti, text) => ti.annotations.push({ type: 'manual', description: text });

test('RG-TC020 [FNOL]: Website FNOL (Homeowners PC) — claim lands complete in ClaimCenter', async ({ page }, ti) => S.blockable(test, async () => {
  const [cn] = S.need(test, 'REG_WEB_CLAIM');
  manualFirst(ti, 'Steps 1–7: report the claim on the Donegal website and put its claim number in REG_WEB_CLAIM.');
  const f = await S.validateIntakeClaim(page, ti, cn, { channel: 'Website', policy: process.env.REG_WEB_POLICY });
  await R.check(page, ti, { description: 'Homeowners claim (HO prefix)', expected: 'HO-…', actual: cn, ok: /^HO/i.test(cn) || !!process.env.REG_WEB_ANY_LOB });
  await S.nav(page, 'Documents');
  const docs = (await R.gridRows(page)).filter((r) => !/^Name\s/i.test(r));
  await R.step(page, ti, `Documents uploaded with the web report: ${docs.length ? docs.slice(0, 4).join(' || ') : 'none'} (how reported: ${f.how || 'n/a'})`);
}));

test('RG-TC021 [FNOL]: Mobile app FNOL (PA legacy) — claim lands complete in ClaimCenter', async ({ page }, ti) => S.blockable(test, async () => {
  const [cn] = S.need(test, 'REG_MOBILE_CLAIM');
  manualFirst(ti, 'Steps 1–9: report the claim in the mobile app and put its claim number in REG_MOBILE_CLAIM.');
  await S.validateIntakeClaim(page, ti, cn, { channel: 'Mobile app', policy: process.env.REG_MOBILE_POLICY });
  await A_vehicleAndDriver(page, ti);
}));

// Mobile-app claims carry vehicle + driver from steps 5–6: both must exist on Loss Details / Parties.
async function A_vehicleAndDriver(page, ti) {
  await S.A.openLossDetailsGeneral(page);
  const ld = await S.bodyText(page);
  await R.check(page, ti, { description: 'Vehicle incident from the app is on Loss Details', expected: 'a vehicle row', actual: (ld.match(/\b(19|20)\d\d\s+[A-Z][a-z]+[^\n]{0,40}/) || ['no vehicle text'])[0], ok: /\b(19|20)\d\d\s+[A-Z][a-z]+/.test(ld) });
  await W.navigate(page, 'parties');
  const rows = await R.gridRows(page);
  await R.check(page, ti, { description: 'Driver contact from the app', expected: 'a Driver role', actual: rows.filter((r) => /Driver/i.test(r)).join(' | ') || 'none', ok: rows.some((r) => /Driver/i.test(r)) });
}

test('RG-TC034 [Alliance Glass]: DMEP0001 completes the alliance_exposure activity; not on non-glass claims', async ({ page }, ti) => S.blockable(test, async () => {
  const [cn] = S.need(test, 'REG_ALLIANCE_CLAIM');
  manualFirst(ti, 'Step 1: the Alliance Glass FNOL arrives from Alliance (ExtAllianceGlassClaim=true) — put its claim number in REG_ALLIANCE_CLAIM.');
  await S.validateIntakeClaim(page, ti, cn, { channel: 'Alliance Glass' });
  const { rows } = await R.hasActivity(page, /alliance/i, cn);
  const al = rows.filter((r) => /alliance/i.test(r));
  await R.check(page, ti, { description: 'DMCP0002 created the alliance_exposure activity', expected: 'an Alliance activity on the Workplan', actual: al.join(' | ') || `none (rows: ${rows.slice(0, 5).join(' || ')})`, ok: al.length > 0 });
  await R.check(page, ti, { description: 'DMEP0001 completed it at exposure postsetup', expected: 'status Completed / Complete', actual: al.join(' | ') || 'none', ok: al.length > 0 && al.every((r) => /complete/i.test(r) && !/\bOpen\b/.test(r)) });
  // Negative: an ordinary PA claim has no alliance activity.
  const other = await R.sharedClaim(page, 'PA', 'RG-TC034-NEG', { reserveActions: 0 });
  const neg = (await R.hasActivity(page, /alliance/i, other)).rows.filter((r) => /alliance/i.test(r));
  await R.check(page, ti, { description: `Negative: non-glass claim ${other} has no alliance activity`, expected: 'none', actual: neg.join(' | ') || 'none', ok: !neg.length });
}));

// FNOL XML intake (TC035 / TC055). Optional REG_FNOL_XML_S3_PREFIX proves the file is waiting before the batch.
async function fnolXmlIntake(page, ti, tag, { chunk }) {
  S.need(test, 'REG_FNOL_XML_POLICY', 'CC_ADMIN_USER', 'CC_ADMIN_PASS');
  manualFirst(ti, 'Step 1: put the FNOL XML (policy = REG_FNOL_XML_POLICY) in the S3 inbound folder — the S3 admin service cannot upload.');
  const policy = process.env.REG_FNOL_XML_POLICY;
  if (process.env.REG_FNOL_XML_S3_PREFIX) {
    const keys = await S.s3Keys(page, process.env.REG_FNOL_XML_S3_PREFIX);
    await R.check(page, ti, { description: 'FNOL XML waiting in S3', expected: `≥ 1 object under ${process.env.REG_FNOL_XML_S3_PREFIX}`, actual: keys.slice(0, 5).join(' | ') || 'empty', ok: keys.length > 0 });
  }
  await B.loginToClaimCenter(page);
  const before = (await S.searchClaims(page, { policy })).rows;
  await R.step(page, ti, await S.runBatchProcess(page, S.batchName('FNOL_INTAKE', /FNOL.*Intake/i)));
  if (chunk) await R.step(page, ti, await S.runBatchProcess(page, S.batchName('INBOUND_CHUNK', /Inbound Chunk/i)));
  const files = await S.inboundFiles(page, /fnol|xml/i).catch((e) => [`(Inbound Files not readable: ${e.message})`]);
  await R.check(page, ti, { description: 'Inbound FNOL record moved to Processed', expected: 'newest FNOL row Processed', actual: files.slice(0, 3).join(' || ') || 'no FNOL rows', ok: /processed/i.test(files[0] || '') });
  await B.loginToClaimCenter(page);
  const after = (await S.searchClaims(page, { policy })).rows;
  const fresh = after.filter((r) => !before.includes(r));
  const cn = ((fresh[0] || '').match(/[A-Z]{2,4}-[A-Z]{2}-\d{2}-\d{2}-\d{7}/) || [])[0];
  await R.check(page, ti, { description: `New claim on policy ${policy} from the XML`, expected: 'one new claim', actual: fresh.join(' | ') || 'no new claim', ok: !!cn });
  await S.validateIntakeClaim(page, ti, cn, { channel: `FNOL XML (${tag})`, policy });
  return cn;
}

test('RG-TC035 [FNOL Intake]: FNOL XML with a valid policy — batch processes the record and creates a claim', async ({ page }, ti) => S.blockable(test, async () => {
  await fnolXmlIntake(page, ti, 'TC035', { chunk: false });
}));

test('RG-TC055 [FNOL Intake]: FNOL XML upload — claim created (email to added users checked by hand)', async ({ page }, ti) => S.blockable(test, async () => {
  const cn = await fnolXmlIntake(page, ti, 'TC055', { chunk: true });
  manualFirst(ti, `Step 4 (email to the added users): confirm the mailbox received the notification for ${cn}.`);
}));

// Bank of America check-status file (TC053 final check Requested, TC054 partial check Issued).
async function boaFile(page, ti, envClaim, envCheck) {
  const [cn, checkNo] = S.need(test, envClaim, envCheck, 'CC_ADMIN_USER', 'CC_ADMIN_PASS');
  manualFirst(ti, 'Step 1: put the BOA file for this check in the S3 inbound folder. Step 6 (payee mail) by hand.');
  const status = async () => {
    await B.loginToClaimCenter(page);
    await R.makeViewable(page, cn);
    await W.navigate(page, 'checks');
    const row = (await R.gridRows(page)).find((r) => r.includes(checkNo));
    if (!row) throw new W.Blocked(`check ${checkNo} not listed on ${cn} › Financials › Checks`);
    return row;
  };
  R.setClaim(ti, cn, process.env.CC_USER);
  const before = await status();
  await R.step(page, ti, `Check ${checkNo} before the BOA file: ${before}`);
  if (process.env.REG_BOA_S3_PREFIX) {
    const keys = await S.s3Keys(page, process.env.REG_BOA_S3_PREFIX);
    await R.check(page, ti, { description: 'BOA file waiting in S3', expected: '≥ 1 object', actual: keys.slice(0, 5).join(' | ') || 'empty', ok: keys.length > 0 });
  }
  await R.step(page, ti, await S.runBatchProcess(page, S.batchName('BOA_INTAKE', /Bank of America.*Intake|BOA.*Intake/i)));
  let files = await S.inboundFiles(page, /BOA|Bank of America/i);
  await R.check(page, ti, { description: 'Administration › Utilities › Inbound Files: BOA file Loaded', expected: 'Loaded', actual: files.slice(0, 3).join(' || ') || 'no BOA rows', ok: /loaded|processed/i.test(files[0] || '') });
  await R.step(page, ti, await S.runBatchProcess(page, S.batchName('INBOUND_CHUNK', /Inbound Chunk/i)));
  files = await S.inboundFiles(page, /BOA|Bank of America/i);
  await R.check(page, ti, { description: 'After Inbound Chunk Work Queue the file is processed', expected: 'Processed / no errors', actual: files.slice(0, 3).join(' || '), ok: /processed|loaded/i.test(files[0] || '') && !/error|fail/i.test(files[0] || '') });
  const after = await status();
  await R.check(page, ti, { description: `Check ${checkNo} status updated on Financials › Checks`, expected: 'status changed by the BOA file', actual: `${before}  →  ${after}`, ok: after !== before });
}

test('RG-TC053 [BOA File Intake]: Legacy PA final check (Requested) — status updated from the BOA file', async ({ page }, ti) => S.blockable(test, async () => {
  await boaFile(page, ti, 'REG_BOA_CLAIM_PA', 'REG_BOA_CHECK_PA');
}));

test('RG-TC054 [BOA File Intake]: Legacy HO partial check (Issued) — status updated from the BOA file', async ({ page }, ti) => S.blockable(test, async () => {
  await boaFile(page, ti, 'REG_BOA_CLAIM_HO', 'REG_BOA_CHECK_HO');
}));

test('RG-TC081 [FNOL Intake]: Claim from a non-FNOL source (website → S3 XML → UAC) is complete', async ({ page }, ti) => S.blockable(test, async () => {
  const [cn] = S.need(test, 'REG_UAC_CLAIM');
  manualFirst(ti, 'Steps 1–2: create the claim on the website and let the UAC scheduler pick the XML up; put the claim in REG_UAC_CLAIM.');
  if (process.env.REG_UAC_S3_PREFIX) {
    const keys = await S.s3Keys(page, process.env.REG_UAC_S3_PREFIX);
    await R.step(page, ti, `S3 ${process.env.REG_UAC_S3_PREFIX}: ${keys.length} object(s) ${keys.slice(0, 3).join(' | ')}`);
  }
  await S.validateIntakeClaim(page, ti, cn, { channel: 'Website via UAC', policy: process.env.REG_UAC_POLICY });
}));
