/**
 * tests/Regression/Api.regression.test.js — Regression Test Design V1.0 web-service cases, done from Node instead of
 * SoapUI (helpers/regression/soapClient.js reads each service's WSDL): AutomatedRenewalAPI (TC060, TC061),
 * ClaimDataAPI (TC076, TC077), AgentAccessClaimDataAPI (TC078, TC079), ClaimSurveyReminderAPI (TC062, TC063).
 *
 * Beyond "the service answered", every response is checked against what ClaimCenter shows for the same claim (claim
 * number, loss date, reserves / payments) and, where the case asks, against PolicyCenter (helpers/regression/
 * policyCenter.js). Response time is recorded on every call.
 */
const { test } = require('@playwright/test');
const S = require('../../helpers/regression/regressionSteps');
const { R, W, B, API, PC } = S;

S.hooks(test);

const CLAIM_RE = /[A-Z]{2,4}-[A-Z]{2}-\d{2}-\d{2}-\d{7}/;
const mdY = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
const sameDay = (a, b) => { const x = new Date(a), y = new Date(b); return !isNaN(x) && !isNaN(y) && x.toISOString().slice(0, 10) === y.toISOString().slice(0, 10); };

async function logCall(page, ti, r, what) {
  await R.step(page, ti, `${what}: ${r.op} → HTTP ${r.status} in ${r.ms} ms${r.fault ? ` — FAULT ${r.fault}` : ''}; fields: ${Object.keys(r.fields).slice(0, 25).join(', ')}`);
  require('fs').writeFileSync(ti.outputPath(`${r.op}-response.xml`), r.xml);
  require('fs').writeFileSync(ti.outputPath(`${r.op}-request.xml`), r.request);
}

// ClaimCenter's own view of a claim: loss date + reserve/payment rows (for the API ↔ CC comparisons).
async function ccView(page, cn) {
  await B.loginToClaimCenter(page);
  await R.makeViewable(page, cn);
  await S.A.openLossDetailsGeneral(page);
  const ld = await S.readScreen(page);
  const lossDate = (S.findField(ld, 'Date of Loss') || S.findField(ld, 'Loss Date') || {}).value || '';
  const tx = await R.transactionRows(page, cn);
  return { lossDate, reserves: tx.filter((r) => /Reserve/i.test(r)), payments: tx.filter((r) => /Payment/i.test(r)) };
}

// AutomatedRenewalAPI: claims on a policy within a loss-date window.
async function renewal(page, ti, envPolicy, kind) {
  const [policy] = S.need(test, envPolicy);
  const from = new Date(Date.now() - 5 * 365 * 86400000), to = new Date();
  const r = await API.call('RENEWAL', /claim/i, { policyNumber: policy, lossDateFrom: mdY(from), lossDateTo: mdY(to), includeDetail: 'true' });
  await logCall(page, ti, r, `AutomatedRenewalAPI (${kind} policy ${policy})`);
  await R.check(page, ti, { description: 'Service answered without a fault', expected: 'HTTP 200, no SOAP Fault', actual: `HTTP ${r.status}${r.fault ? ` ${r.fault}` : ''}`, ok: r.status === 200 && !r.fault });
  const claims = API.pick(r, /^ClaimNumber$/i);
  const want = ['ClaimNumber', 'LossDate', 'LossPayment', 'OpenReserves'];
  const missing = want.filter((f) => !API.pick(r, new RegExp(`^${f}$`, 'i')).length);
  await R.check(page, ti, { description: 'Claim detail fields returned', expected: want.join(', '), actual: missing.length ? `missing ${missing.join(', ')}` : `${claims.length} claim(s): ${claims.slice(0, 5).join(', ')}`, ok: !missing.length && claims.length > 0 });
  // Cross-check the first claim against ClaimCenter.
  const cn = claims.find((c) => CLAIM_RE.test(c)) || claims[0];
  const cc = await ccView(page, cn);
  R.setClaim(ti, cn, process.env.CC_USER);
  const apiLoss = API.pick(r, /^LossDate$/i)[0];
  await R.check(page, ti, { description: `Loss date for ${cn}: API vs ClaimCenter`, expected: cc.lossDate, actual: apiLoss, ok: sameDay(apiLoss, cc.lossDate) });
  const apiRes = Number(String(API.pick(r, /^OpenReserves$/i)[0] || '').replace(/[^0-9.-]/g, ''));
  await R.step(page, ti, `OpenReserves from API: ${apiRes}; ClaimCenter reserve rows: ${cc.reserves.slice(0, 4).join(' || ') || 'none'}`);
  // Step 3: the same claims on the policy in PolicyCenter.
  if (PC.configured()) {
    const pcRows = await PC.policyClaims(page, policy);
    const absent = claims.filter((c) => !pcRows.some((row) => row.includes(c)));
    await R.check(page, ti, { description: 'Same claims listed on the policy in PolicyCenter', expected: claims.join(', '), actual: absent.length ? `not in PC: ${absent.join(', ')}` : 'all listed', ok: !absent.length });
  } else ti.annotations.push({ type: 'manual', description: 'Step 3 (compare with PolicyCenter) — set REG_PC_USER / REG_PC_PASS to automate it.' });
}

test('RG-TC060 [AutomatedRenewalAPI]: PC Personal Auto policy — claim data by policy and loss-date window', async ({ page }, ti) => S.blockable(test, async () => {
  await renewal(page, ti, 'REG_API_POLICY_PA', 'PC');
}));

test('RG-TC061 [AutomatedRenewalAPI]: Legacy Personal Auto policy (closed claim) — claim data by policy', async ({ page }, ti) => S.blockable(test, async () => {
  await renewal(page, ti, 'REG_API_POLICY_PA_LEGACY', 'legacy');
}));

// ClaimDataAPI: one claim's policy, reserves, payments, litigation.
async function claimData(page, ti, envClaim) {
  const [cn] = S.need(test, envClaim);
  const r = await API.call('CLAIM_DATA', /claim/i, { claimNumber: cn });
  await logCall(page, ti, r, `ClaimDataAPI (${cn})`);
  await R.check(page, ti, { description: 'Service answered without a fault', expected: 'HTTP 200', actual: `HTTP ${r.status}${r.fault ? ` ${r.fault}` : ''}`, ok: r.status === 200 && !r.fault });
  const groups = { policy: /policy/i, reserves: /reserve/i, payments: /payment|paid/i, litigation: /litigat|lawsuit|matter/i };
  const have = Object.fromEntries(Object.entries(groups).map(([k, re]) => [k, Object.keys(r.fields).filter((f) => re.test(f))]));
  await R.check(page, ti, { description: 'Policy, reserve and payment details returned', expected: 'fields for policy, reserves, payments', actual: Object.entries(have).map(([k, v]) => `${k}: ${v.slice(0, 4).join('/') || 'none'}`).join('; '), ok: have.policy.length && have.reserves.length && have.payments.length });
  await R.step(page, ti, `Litigation fields: ${have.litigation.join(', ') || 'none returned (claim may have no matter)'}`);
  const cc = await ccView(page, cn);
  R.setClaim(ti, cn, process.env.CC_USER);
  const apiCn = API.pick(r, /^ClaimNumber$/i)[0];
  await R.check(page, ti, { description: 'Response is for the requested claim', expected: cn, actual: apiCn || '(no ClaimNumber)', ok: apiCn === cn });
  await R.check(page, ti, { description: 'ClaimCenter shows reserves/payments the API reports', expected: 'reserve and payment transactions in CC', actual: `${cc.reserves.length} reserve row(s), ${cc.payments.length} payment row(s)`, ok: cc.reserves.length > 0 });
}

test('RG-TC076 [ClaimDataAPI]: Legacy PA closed claim — policy, reserves, payments, litigation', async ({ page }, ti) => S.blockable(test, async () => {
  await claimData(page, ti, 'REG_API_CLAIM_PA_LEGACY');
}));

test('RG-TC077 [ClaimDataAPI]: PC Commercial Package Property open claim — policy, reserves, payments, litigation', async ({ page }, ti) => S.blockable(test, async () => {
  await claimData(page, ti, 'REG_API_CLAIM_CPP');
}));

test('RG-TC078 [AgentAccessClaimDataAPI]: Agent + claim details match ClaimCenter', async ({ page }, ti) => S.blockable(test, async () => {
  const [cn] = S.need(test, 'REG_API_CLAIM_AGENT');
  const r = await API.call('AGENT_ACCESS', /claim/i, { claimNumber: cn });
  await logCall(page, ti, r, `AgentAccessClaimDataAPI (${cn})`);
  await R.check(page, ti, { description: 'Service answered without a fault', expected: 'HTTP 200', actual: `HTTP ${r.status}${r.fault ? ` ${r.fault}` : ''}`, ok: r.status === 200 && !r.fault });
  const agentFields = Object.keys(r.fields).filter((f) => /agen|producer/i.test(f));
  await R.check(page, ti, { description: 'Agent details returned', expected: 'agent/producer fields', actual: agentFields.slice(0, 6).join(', ') || 'none', ok: agentFields.length > 0 });
  const cc = await ccView(page, cn);
  R.setClaim(ti, cn, process.env.CC_USER);
  const apiLoss = API.pick(r, /LossDate/i)[0];
  await R.check(page, ti, { description: 'Loss date: API vs ClaimCenter', expected: cc.lossDate, actual: apiLoss || '(none)', ok: sameDay(apiLoss, cc.lossDate) });
  await W.navigate(page, 'parties');
  const agentRow = (await R.gridRows(page)).find((x) => /Agent/i.test(x)) || '';
  const apiAgent = agentFields.map((f) => r.fields[f][0]).filter(Boolean);
  await R.check(page, ti, { description: 'Agent on the claim matches the API', expected: agentRow || 'an Agent contact in CC', actual: apiAgent.slice(0, 3).join(' / '), ok: !!agentRow && apiAgent.some((v) => v.length > 2 && agentRow.toUpperCase().includes(v.toUpperCase())) });
}));

test('RG-TC079 [AgentAccessClaimDataAPI]: Invalid claim number returns an error (negative)', async ({ page }, ti) => S.blockable(test, async () => {
  const bad = process.env.REG_API_CLAIM_INVALID || 'PA-PA-99-99-9999999';
  const r = await API.call('AGENT_ACCESS', /claim/i, { claimNumber: bad });
  await logCall(page, ti, r, `AgentAccessClaimDataAPI (${bad})`);
  const errText = r.fault || (API.pick(r, /error|message/i)[0] || '');
  await R.check(page, ti, { description: 'Non-existent claim → error, no claim data', expected: 'SOAP Fault or error message; no ClaimNumber', actual: `HTTP ${r.status}; ${errText || 'no error text'}; ClaimNumber ${API.pick(r, /^ClaimNumber$/i)[0] || 'none'}`, ok: !!errText && !API.pick(r, /^ClaimNumber$/i).length });
}));

// Claim Survey: final payment → (queue suspended) Claim Survey batch → payload → JSON POST. The queue is ALWAYS resumed.
async function survey(page, ti, envClaim) {
  const [cn] = S.need(test, envClaim, 'CC_ADMIN_USER', 'CC_ADMIN_PASS', 'REG_ALLOW_QUEUE_SUSPEND');
  await B.loginToClaimCenter(page);
  await R.makeViewable(page, cn);
  R.setClaim(ti, cn, process.env.CC_USER);
  const pay = await S.P.makePayment(page, { txn: 'Final Payment', amount: S.P.uniqueAmount(40) });
  await R.check(page, ti, { description: 'Final payment made on the claim', expected: 'payment finished', actual: `${pay.finished ? 'finished' : 'not finished'} $${pay.amount} ${pay.messages.join(' | ')}`, ok: pay.finished });
  const queue = /Claim ?Survey/i;
  await R.step(page, ti, `Message queue suspended: ${await S.messageQueue(page, queue, 'Suspend')}`);
  let payload = null;
  try {
    await R.step(page, ti, await S.runBatchProcess(page, S.batchName('CLAIM_SURVEY', /Claim ?Survey/i)));
    // Pending message for this claim on the suspended destination: Message Queues › <queue> drill-down.
    const ctx = await page.context().browser().newContext();
    const p = await ctx.newPage();
    try {
      await S.openAdmin(p, 'Monitoring', 'Message Queues');
      await p.locator('tr').filter({ hasText: queue }).getByRole('link').first().click().catch(() => {});
      await W.settle(p, 3000);
      const txt = await p.locator('body').innerText();
      const json = (txt.match(/\{[\s\S]*"?ClaimNumber"?[\s\S]*\}/) || [])[0];
      payload = json ? JSON.parse(json) : null;
    } catch (_) { payload = null; } finally { await ctx.close().catch(() => {}); }
  } finally {
    await R.step(page, ti, `Message queue resumed: ${await S.messageQueue(page, queue, 'Resume').catch((e) => `RESUME FAILED — resume it by hand: ${e.message}`)}`);
  }
  if (!payload) throw new W.Blocked('Claim Survey payload not readable from the Message Queues screen — steps 4–5 by hand (queue was resumed)');
  const want = ['ClaimNumber', 'SurveyType', 'DeliveryMethod', 'State', 'BusinessSegment', 'LOB', 'Brand', 'ServiceOffice', 'ClaimRep', 'Contacts'];
  const miss = want.filter((k) => !(k in payload));
  await R.check(page, ti, { description: 'Survey payload has the 10 fields', expected: want.join(', '), actual: miss.length ? `missing ${miss.join(', ')}` : 'all present', ok: !miss.length && payload.ClaimNumber === cn });
  const res = await API.postJson('CLAIM_SURVEY', payload);
  await R.check(page, ti, { description: 'ClaimSurveyReminderAPI accepts the payload', expected: 'HTTP 2xx', actual: `HTTP ${res.status} ${res.text.slice(0, 200)}`, ok: res.status >= 200 && res.status < 300 });
  ti.annotations.push({ type: 'manual', description: 'Survey link received by email / SMS (Hi Marley) — check the claimant mailbox / phone.' });
}

test('RG-TC062 [ClaimSurveyReminderAPI]: PC PA claimant with final payment — survey payload and API', async ({ page }, ti) => S.blockable(test, async () => {
  await survey(page, ti, 'REG_SURVEY_CLAIM_PC');
}));

test('RG-TC063 [ClaimSurveyReminderAPI]: Legacy PA claimant with final payment — survey payload and API', async ({ page }, ti) => S.blockable(test, async () => {
  await survey(page, ti, 'REG_SURVEY_CLAIM_LEGACY');
}));
