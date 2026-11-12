/**
 * helpers/oneInc/oneIncEmail.js — the e-mails OneInc sends a payee (Insurance Payments <insurancepayments@oneinc.com>),
 * read from the Outlook inbox of the machine running the suite (Outlook COM via PowerShell). Test claims' contacts carry
 * the QA mailbox (contactEmails.js; amitmishra@ since 2026-11-11), so only the machine whose Outlook holds that mailbox
 * can run these steps — elsewhere they are BLOCKED.
 *
 * Samples (forwarded by Amanda Hess 2026-11-11):
 *  - "Donegal Insurance Group Issued a Digital Payment for you": "Hi <PAYEE NAME>, ... Accept Payment" — link to the
 *    OneInc payee portal (cportaluat.oneinc.com/?payload=…, Proofpoint-wrapped). Valid for 1 business day.
 *  - "Donegal Insurance Group Payment Confirmation": "Payment Amount: $1.07  Payment Method: Check".
 * The Proofpoint (urldefense.com) link is opened as is: it redirects to the OneInc page.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('./wizardDriver');
const { observe } = require('./checkOps');

const SUBJECTS = { issued: 'Issued a Digital Payment', confirmation: 'Payment Confirmation' };

// Inbox messages from OneInc received after `since` whose subject contains `subject`, newest first:
// [{ subject, received (ISO), to, payee, body (first 1500 chars), links: [href] }]. Throws Blocked without Outlook.
// The JSON goes to a UTF-8 file, not stdout: the console code page turns the e-mail's curly quotes into plain ones,
// which broke the JSON (2026-11-11).
function inbox({ subject, since }) {
  const out = path.join(os.tmpdir(), `oneinc-inbox-${process.pid}.json`);
  const ps = `
$ErrorActionPreference='Stop'
$o=New-Object -ComObject Outlook.Application; $ns=$o.GetNamespace('MAPI')
$items=$ns.GetDefaultFolder(6).Items; $items.Sort('[ReceivedTime]',$true)
$since=[DateTime]::Parse('${new Date(since).toISOString()}').ToLocalTime(); $out=@()
foreach($m in $items){ if($m.ReceivedTime -lt $since){break}
  if(($m.SenderEmailAddress -match 'oneinc') -and ($m.Subject -like '*${subject.replace(/'/g, "''")}*')){
    $b=($m.Body -replace '\\s+',' ')
    $out+=[pscustomobject]@{subject=$m.Subject; received=$m.ReceivedTime.ToUniversalTime().ToString('o'); to=$m.To;
      body=$b.Substring(0,[Math]::Min(1500,$b.Length)); links=@([regex]::Matches($m.HTMLBody,'href="([^"]+)"') | % { $_.Groups[1].Value })} } }
[IO.File]::WriteAllText('${out.replace(/'/g, "''")}', (ConvertTo-Json -Depth 3 -InputObject @($out)), (New-Object Text.UTF8Encoding $false))`;
  const file = path.join(os.tmpdir(), `oneinc-inbox-${process.pid}.ps1`);
  fs.writeFileSync(file, ps);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 180000 });
  fs.unlinkSync(file);
  if (r.status !== 0) throw new W.Blocked(`Outlook inbox not readable on this machine (${String(r.stderr || r.error || '').split('\n')[0].slice(0, 160)})`);
  const rows = JSON.parse(fs.readFileSync(out, 'utf8') || '[]');
  fs.unlinkSync(out);
  return rows.map((m) => ({ ...m, payee: ((m.body || '').match(/Hi ([^,]+),/) || [])[1] || '' }));
}

// Waits (polling every minute, up to waitMin) for the OneInc e-mail `kind` ('issued' | 'confirmation') addressed to
// `payee` (the "Hi <NAME>," line, case-insensitive; any payee when omitted) that arrived after markStart (the case's
// first step), else within the last `sinceMin` minutes. Observed "OneInc <kind> e-mail"; remembers it on the page.
async function waitEmail(page, { kind = 'issued', payee = '', waitMin = 30, sinceMin = 120 } = {}) {
  const since = page.__oneIncEmailSince || Date.now() - sinceMin * 60000;
  const want = String(payee).trim().toUpperCase();
  const end = Date.now() + waitMin * 60000;
  for (;;) {
    const hit = inbox({ subject: SUBJECTS[kind], since }).find((m) => !want || m.payee.toUpperCase().includes(want));
    if (hit) {
      page.__oneIncEmail = { ...(page.__oneIncEmail || {}), [kind]: hit };
      const link = kind === 'issued' ? (hit.links.find((l) => /cportal[a-z]*\.oneinc\.com|urldefense/i.test(l)) || '') : '';
      return observe(page, `OneInc ${kind} e-mail`, `received ${hit.received} for ${hit.payee || '?'}: "${hit.subject}"${link ? ' (Accept Payment link present)' : ''}`);
    }
    if (Date.now() > end) throw new W.Blocked(`no OneInc "${SUBJECTS[kind]}" e-mail${want ? ` for ${want}` : ''} in the inbox within ${waitMin} min of the payment — OneInc may send it later (it is valid for 1 business day once sent)`);
    await page.waitForTimeout(60000);
  }
}

// The payee portal (cportaluat.oneinc.com), CONFIRMED 2026-11-11 from a live Issued e-mail (it arrived 1 minute after the
// payment reached OneInc): 1 Identity Verification — "What is your claim number?" (#claimnumber, NEXT), then
// "How should we send your verification code to (7**) ***-0142?" TEXT ME / CALL ME — the Mobile of the payee's Payment
// Contact Details (contactEmails.js QA_MOBILE; a company payee's own phone) — "We're texting … your 6-digit verification
// code" (#verificationCode, NEXT) — 2 Payment Details "Is this information correct?" (agree checkbox, NO / YES) —
// 3 Payment Options — 4 Confirmations "Your payment is on its way … A confirmation email will be sent to <email>" FINISH.
const payeeText = async (p) => (await p.evaluate(() => document.body.innerText || '').catch(() => '')).replace(/\s+/g, ' ').trim();
const payeeShot = async (p) => {
  const shot = path.join(require('./reportService').RESULTS_DIR, 'Evidence', `oneinc-payee-portal-${Date.now()}.png`);
  await p.screenshot({ path: shot, fullPage: true }).catch(() => {});
  return shot;
};

// Opens the "Accept Payment" link of the remembered Issued e-mail in a separate browser context (kept open on the page
// for acceptPayment) and answers the claim-number question with the claim of the payment just checked on the OneInc
// portal. Observed "OneInc payee portal" = the screen it lands on.
async function openAcceptPayment(page) {
  const mail = (page.__oneIncEmail || {}).issued;
  if (!mail) throw new W.Blocked('no OneInc Issued e-mail found earlier in this case');
  const link = mail.links.find((l) => /cportal[a-z]*\.oneinc\.com|urldefense/i.test(l));
  if (!link) throw new W.Blocked('the Issued e-mail has no Accept Payment link');
  const ctx = await page.context().browser().newContext({ viewport: { width: 1400, height: 1000 } });
  const p = await ctx.newPage();
  page.__oneIncPayee = { ctx, p };
  await p.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(8000);
  const claim = (page.__oneIncPayment || {})['Claim Number'];
  if (claim && await p.locator('#claimnumber').isVisible().catch(() => false)) {
    await p.fill('#claimnumber', claim);
    await p.getByRole('button', { name: 'NEXT' }).click();
    await p.waitForTimeout(6000);
  }
  const text = await payeeText(p);
  page.__oneIncPayeePortal = { url: p.url(), text, shot: await payeeShot(p) };
  return observe(page, 'OneInc payee portal', `${new URL(p.url()).pathname}: ${text.replace(/^person /, '').slice(0, 300)}`);
}

// First step of an e-mail case: only e-mails arriving after this moment count.
async function markStart(page) { page.__oneIncEmailSince = Date.now(); return `watching the inbox for OneInc e-mails from ${new Date().toLocaleTimeString()}`; }

// ── The verification code ────────────────────────────────────────────────────────────────────────────────────────────
// OneInc texts a 6-digit code to the payee's Mobile (the claim's Payment Contact Details; ONEINC_CONTACT_MOBILE on new
// claims). Whoever holds that phone hands it over with `node scripts/oneIncCode.js <code>` (writes CODE_FILE). The code
// lasts about 2 minutes, so each text is waited on for ONEINC_CODE_WAIT_SEC (110) and re-sent up to ONEINC_CODE_TEXTS (3)
// times; a code written before the text went out is ignored.
const CODE_FILE = process.env.ONEINC_CODE_FILE || path.join(__dirname, '..', '..', 'results', 'oneInc', 'verification-code.txt');
// Names are matched whole but case-insensitively: the buttons are upper-cased by CSS only (an exact 'TEXT ME' found
// nothing, 2026-11-11).
const whole = (s) => new RegExp(`^\\s*${s}\\s*$`, 'i');
const btn = (p, name) => p.getByRole('button', { name: whole(name) }).first();
const firstVisible = async (p, text) => {
  const all = p.getByText(whole(text)); // the method cards exist twice in the DOM, one copy hidden
  for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isVisible().catch(() => false)) return all.nth(i);
  return null;
};
async function passVerification(p, masked) {
  const waitMs = (Number(process.env.ONEINC_CODE_WAIT_SEC) || 110) * 1000;
  const texts = Number(process.env.ONEINC_CODE_TEXTS) || 3;
  for (let n = 1; n <= texts; n++) {
    fs.rmSync(CODE_FILE, { force: true });
    await btn(p, 'TEXT ME').click();
    await p.waitForTimeout(3000);
    console.log(`[OneInc] verification code ${n}/${texts} texted to ${masked} — hand it over within ${Math.round(waitMs / 1000)} s: node scripts/oneIncCode.js <code>`);
    let code = '';
    for (const end = Date.now() + waitMs; Date.now() < end && !code;) {
      code = (fs.existsSync(CODE_FILE) ? fs.readFileSync(CODE_FILE, 'utf8') : '').replace(/\D/g, '');
      if (!code) await p.waitForTimeout(2000);
    }
    fs.rmSync(CODE_FILE, { force: true });
    if (code) {
      await p.fill('#verificationCode', code);
      await btn(p, 'NEXT').click();
      await p.waitForTimeout(6000);
      if (/Is this information correct/i.test(await payeeText(p))) return n;
    }
    if (n < texts) { await btn(p, 'BACK').click().catch(() => {}); await p.waitForTimeout(3000); } // back to TEXT ME / CALL ME
  }
  throw new W.Blocked(`Accept Payment: no valid verification code was handed over (${texts} text(s) to ${masked}, ${Math.round(waitMs / 1000)} s each) — the payee portal showed: ${(await payeeText(p)).slice(0, 200)} (screenshot ${await payeeShot(p)})`);
}

// Payment Options (step 3), CONFIRMED 2026-11-11: cards Bank account / Debit card / PayPal / Venmo / "View more payment
// methods" → Physical check. Bank account = Checking | Savings, #acc_number, #repeat_acc_number, #routing_num (SUBMIT
// stays disabled until valid); Physical check = "Confirm your payment method … address on file" + SUBMIT.
const METHODS = [
  { re: /direct deposit|bank|ach|eft/i, name: 'Bank account',
    pick: async (p) => {
      await (await firstVisible(p, 'Bank account')).click();
      await p.waitForTimeout(3000);
      const eft = W.DUMMY_EFT; // the test bank account the suite already uses for ClaimCenter EFT
      await p.locator('mat-radio-button', { hasText: eft.BankAccountType }).first().locator('label').first().click();
      await p.fill('#acc_number', eft.BankAccountNumber);
      await p.fill('#repeat_acc_number', eft.BankAccountNumber);
      await p.fill('#routing_num', eft.BankRoutingNumber);
      await p.locator('#routing_num').press('Tab');
      await p.waitForTimeout(3000);
    } },
  { re: /check|mail/i, name: 'Physical check',
    pick: async (p) => {
      await (await firstVisible(p, 'View more payment methods')).click();
      await p.waitForTimeout(2500);
      await (await firstVisible(p, 'Physical check')).click();
      await p.waitForTimeout(3000);
    } },
];

// Accept Payment on the OneInc payee portal (opened by openAcceptPayment) with `method`: 'Direct Deposit' (Bank account)
// or 'Check' (Physical check). TEXT ME → code → "Is this information correct?" (agree + YES) → the method → SUBMIT →
// "Your payment is on its way" → FINISH. Observed "OneInc payee acceptance" = the Confirmations screen.
async function acceptPayment(page, method = 'Check') {
  const { ctx, p } = page.__oneIncPayee || {};
  const seen = page.__oneIncPayeePortal;
  if (!p) throw new W.Blocked('Accept Payment: the payee portal was not opened earlier in this case');
  try {
    const how = METHODS.find((m) => m.re.test(method));
    if (!how) throw new W.Blocked(`Accept Payment with "${method}" is not automated (only Direct Deposit / Bank account and Check so far)`);
    if (!/verification code/i.test(seen.text)) throw new W.Blocked(`Accept Payment: the payee portal did not ask for a verification code — it showed: ${seen.text.slice(0, 200)} (screenshot ${seen.shot})`);
    const masked = (seen.text.match(/\(\d\*\*\) \*\*\*-\d{4}/) || ['the mobile on file'])[0];
    await passVerification(p, masked);
    await p.locator('mat-checkbox label').first().click(); // "I have read and agree to the Payment Authorization…"
    await btn(p, 'YES').click();
    await p.waitForTimeout(5000);
    await how.pick(p);
    for (let i = 0; i < 2 && !/on its way/i.test(await payeeText(p)); i++) { // Bank account may confirm once more
      const submit = btn(p, 'SUBMIT');
      if (!await submit.isEnabled().catch(() => false)) break;
      await submit.click();
      await p.waitForTimeout(8000);
    }
    const text = await payeeText(p);
    const shot = await payeeShot(p);
    if (!/on its way/i.test(text)) throw new W.Blocked(`Accept Payment with ${how.name}: not confirmed — the payee portal showed: ${text.replace(/^person /, '').slice(0, 300)} (screenshot ${shot})`);
    await btn(p, 'FINISH').click().catch(() => {});
    await p.waitForTimeout(3000);
    return observe(page, 'OneInc payee acceptance', `${how.name}: ${(text.match(/Your payment is on its way.*?(?= FINISH|$)/) || [text.slice(0, 200)])[0]}`);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    page.__oneIncPayee = null;
  }
}

// After the acceptance OneInc reports the chosen method back to ClaimCenter: the check goes Requested → Issued and its
// "Confirmed Payment Method" fills (Mailed Check seen within 10 minutes of a Physical check acceptance, 2026-11-11).
// Re-reads the payment on the OneInc portal and its ClaimCenter check every minute (portalChecks.oneIncCheck: observed
// "OneInc Status", "OneInc Payment Method", "Check status") until that field is filled; leaves the check open.
async function waitAccepted(page, { amount = '', waitMin = 20 } = {}) {
  const { readScreen, findField } = require('./screenReader');
  const end = Date.now() + waitMin * 60000;
  for (;;) {
    const opened = await require('./portalChecks').oneIncCheck(page, { amount });
    const method = String((findField(await readScreen(page), 'Confirmed Payment Method') || {}).value || '').trim();
    if (method) return `${opened}; Confirmed Payment Method ${method}`;
    if (Date.now() > end) throw new W.Blocked(`the ClaimCenter check shows no Confirmed Payment Method ${waitMin} min after the payee accepted (${opened})`);
    await page.waitForTimeout(60000);
  }
}

module.exports = { inbox, markStart, waitEmail, openAcceptPayment, acceptPayment, waitAccepted, CODE_FILE };
