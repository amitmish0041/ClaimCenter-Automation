/**
 * helpers/oneInc/signatureStatus.js — GCCM-1455 (GetPaymentStatus / Multi-Party Signature Status, added 2026-11-24).
 *
 * CONFIRMED 2026-11-24 on Cloud TEST, claim HO-PA-01-26-0748044 check 8200009199 (joint payees Insured Robert Charles +
 * Secondary Named Insured David Thomas, ClaimsPay Type Contact(s)): Additional Payment Details shows a
 * "Get Payment Signature Status" button (toolbar, after Refresh) and a read-only "Multi-Party Signature Status" list
 * (Date | Primary Contact | Secondary Contact, "No data to display") between "Workflow History" and "Payment Feedback
 * Received". Check 8200009182 on the same claim (payee 1 typed Claimant, not Insured) shows neither.
 * Clicking the button there answered "Unable to refresh the status from OneInc: Error refreshing check status: HTTP
 * operation failed invoking …/rest.php/custom/service/v4_1_custom/rest.php with statusCode: 502" and added no row.
 */
'use strict';

const W = require('./wizardDriver');
const C = require('./checkOps');
const { observe } = C;

const BTN = 'Get Payment Signature Status';

// A new joint check (insured + `second`: 'sni' = the policy's Secondary Named Insured), opened on Additional Payment
// Details. ClaimsPay Type comes out Contact(s) for person payees.
async function createJointCheckAPD(page, { second = 'sni', amount } = {}) {
  const made = await C.createFullCheck(page, { payee: 'insured', type: 'Insured', joint: [{ who: second }], amount });
  await C.openCheck(page, { amount: page.__createdCheck.amount });
  const info = await page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ');
    const cpt = (/ClaimsPay Type (.+?) CR Tracking/.exec(t) || [])[1] || '';
    const jp = (/Joint Payees (.+?) Instructions/.exec(t) || [])[1] || '';
    return { cpt, jp };
  });
  await observe(page, 'ClaimsPay Type', info.cpt || '(not shown)');
  await observe(page, 'Joint payees', info.jp.replace(/^Payee EMail Phone Type Payee Tax ID\s*/, '').slice(0, 300) || '(none)');
  await C.openAPD(page);
  await W.settle(page, 2500);
  return `${made}; opened its Additional Payment Details`;
}

// Read the APD screen: button shown, section shown / position / editable inputs / columns / rows.
async function readSection(page) {
  return page.evaluate((BTN) => {
    const vis = (e) => e && e.offsetParent;
    const lbl = (re) => [...document.querySelectorAll('div, span')].find((e) => vis(e) && re.test((e.textContent || '').trim()) && !e.children.length) || null;
    const btn = [...document.querySelectorAll('.gw-label, [role=button], button')].some((e) => vis(e) && (e.textContent || '').trim() === BTN);
    const cap = lbl(/^Multi-Party Signature Status$/);
    const wh = lbl(/^Workflow History$/);
    const pf = lbl(/^Payment Feedback Received$/);
    const before = (a, b) => !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
    let out = { button: btn, shown: !!cap, between: before(wh, cap) && before(cap, pf), inputs: 0, columns: [], rows: [] };
    if (!cap) return out;
    let box = cap;
    while (box && !box.querySelector('tr')) box = box.parentElement;
    if (!box) return out;
    out.inputs = [...box.querySelectorAll('input, select, textarea, [contenteditable=true]')].filter(vis).length;
    const leaf = [...box.querySelectorAll('tr')].filter((r) => vis(r) && !r.querySelector('tr'));
    const cells = (r) => [...r.children].map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim());
    const head = leaf.find((r) => /^Date\b/.test((r.innerText || '').trim()));
    out.columns = head ? cells(head).filter(Boolean) : [];
    out.rows = leaf.filter((r) => r !== head && /\d{2}\/\d{2}\/\d{4}/.test(r.innerText || '')).map((r) => cells(r).filter(Boolean));
    return out;
  }, BTN);
}

async function observeSection(page) {
  const s = await readSection(page);
  page.__sig = s;
  await observe(page, `${BTN} button`, s.button ? 'visible' : 'not visible');
  await observe(page, 'Multi-Party Signature Status section', !s.shown ? 'not shown'
    : `shown${s.between ? ', between Workflow History and Payment Feedback Received' : ', NOT between Workflow History and Payment Feedback Received'}; ${s.inputs ? `${s.inputs} editable input(s)` : 'read-only (no input fields)'}`);
  await observe(page, 'Multi-Party Signature Status columns', s.columns.join(' | ') || '(none)');
  await observe(page, 'Multi-Party Signature Status rows', s.rows.length ? `${s.rows.length}: ${s.rows.map((r) => r.join(' | ')).join(' ; ')}`.slice(0, 500) : '0 (No data to display)');
  return `button ${s.button ? 'visible' : 'not visible'}; section ${s.shown ? 'shown' : 'not shown'}`;
}

// Click the button `times` times; observe CC's answer and the rows added each time.
async function requestStatus(page, { times = 1, fallback = null } = {}) {
  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const start = (await readSection(page)).rows.length;
  if (!(await readSection(page)).button) throw new W.Blocked(`no "${BTN}" button on this check's Additional Payment Details`);
  // Disabled (aria-disabled) while the check is not yet accepted by OneInc — CONFIRMED 2026-11-24: new checks stuck in
  // "Requesting" during the OneInc outage had it disabled; 8200009199 (Issued) had it enabled.
  const st = await page.evaluate(() => {
    const e = document.querySelector('[id$="_tb-GetPaymentStatusButton"]');
    return e ? { disabled: e.getAttribute('aria-disabled') === 'true', tip: e.getAttribute('data-gw-tooltip') || '' } : null;
  });
  const chk = await page.evaluate(() => ((document.body.innerText || '').match(/Current Payment Status\s+(\S[^\n]*)/) || [])[1] || '');
  if (st && st.disabled && fallback) {
    // QA's own qualifying example (Insured + SNI, Contact(s), already Issued by OneInc): the call is judged there.
    await observe(page, `${BTN} button state (new check)`, `disabled (OneInc status "${chk || 'none'}") — judged on ${fallback.claim} check ${fallback.number} instead`);
    await W.openClaim(page, fallback.claim);
    await C.openCheck(page, { number: fallback.number });
    await C.openAPD(page);
    await W.settle(page, 2500);
    await observeSection(page); // the new check's readings do not survive the navigation
    return requestStatus(page, { times });
  }
  if (st && st.disabled) {
    await observe(page, `${BTN} button state`, `disabled (check's OneInc status "${chk || 'none'}")`);
    throw new W.Blocked(`"${BTN}" is disabled on this check — OneInc has not accepted the payment yet (Current Payment Status "${chk || 'none'}"; payments not reaching OneInc on TEST). Tooltip: "${st.tip}"`);
  }
  const answers = [];
  let prev = start;
  for (let i = 0; i < times; i++) {
    await page.locator(`:text-is("${BTN}"):visible`).first().click();
    let msg = '';
    for (let t = 0; t < 15 && !msg; t++) { // CC's answer shows as a page message for a few seconds
      await page.waitForTimeout(1000);
      msg = await page.evaluate(() => [...new Set([...document.querySelectorAll('.gw-message, .gw-WebMessage')].map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' | ')).catch(() => '');
    }
    await page.waitForTimeout(3000);
    const s = await readSection(page);
    answers.push(`click ${i + 1}: ${s.rows.length - prev} row(s) added${msg ? `; message "${msg.slice(0, 300)}"` : '; no message'}`);
    prev = s.rows.length;
    page.__sig = s;
  }
  const s = page.__sig;
  const added = s.rows.slice(start);
  await observe(page, 'Signature status request', answers.join(' / '));
  await observe(page, 'Signature status rows added', String(added.length));
  await observe(page, 'Signature status call', /HTTP operation failed|statusCode|Unable to refresh/i.test(answers.join(' ')) ? 'FAILED — OneInc call returned an error' : added.length || /OneInc reports/i.test(answers.join(' ')) ? 'answered' : 'no row and no message');
  if (added.length) {
    const last = added[added.length - 1];
    await observe(page, 'Newest signature row date', last[0] || '(blank)');
    await observe(page, 'Newest signature row is today', String((last[0] || '').startsWith(today)));
    await observe(page, 'Newest Primary Contact', last[1] || '(blank)');
    await observe(page, 'Newest Secondary Contact', last[2] || '(blank)');
    await observe(page, 'Signature values contain an e-mail', String(/@/.test(`${last[1]} ${last[2]}`)));
    await observe(page, 'Earlier rows kept', String(s.rows.length === start + added.length));
  }
  return answers.join(' / ');
}

module.exports = { createJointCheckAPD, readSection, observeSection, requestStatus, BTN };
