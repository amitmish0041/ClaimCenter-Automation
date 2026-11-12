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
// Contact Details (contactEmails.js QA_MOBILE) — 2 Payment Details, 3 Payment Options, 4 Confirmations (not seen yet).
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

// Accept Payment on the OneInc payee portal with `method` (e.g. 'Direct Deposit'). Stops at the verification code: OneInc
// texts / calls it to the payee's Mobile, which is the dummy 555 number on test claims — BLOCKED until the contacts carry
// a phone whose code this machine can read (ONEINC_CONTACT_MOBILE) or OneInc gives UAT a fixed code. Steps 2-4 unbuilt.
async function acceptPayment(page, method) {
  const { ctx } = page.__oneIncPayee || {};
  const seen = page.__oneIncPayeePortal;
  if (ctx) await ctx.close().catch(() => {});
  page.__oneIncPayee = null;
  if (seen && /verification code/i.test(seen.text)) throw new W.Blocked(`Accept Payment with "${method}": the claim number was accepted, then OneInc wants a verification code sent by text / call to the payee's mobile ${(seen.text.match(/\(\d\*\*\) \*\*\*-\d{4}/) || ['(on file)'])[0]} — a test number nobody receives (screenshot ${seen.shot})`);
  throw new W.Blocked(`Accept Payment with "${method}" is not automated yet — the payee portal showed: ${seen ? `${seen.url.slice(0, 80)} — ${seen.text.slice(0, 200)} (screenshot ${seen.shot})` : 'nothing (not opened)'}`);
}

module.exports = { inbox, markStart, waitEmail, openAcceptPayment, acceptPayment };
