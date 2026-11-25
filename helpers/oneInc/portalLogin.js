/**
 * helpers/oneInc/portalLogin.js — signs the OneInc staging Admin Portal window in by itself (user direction 2026-11-25).
 *
 * Flow CONFIRMED 2026-11-25: login page asks Username (#UserIdentifier; the Log In button stays disabled for scripted
 * input, so the form is submitted directly) → Password page → "Your access link was sent to your email" → OneInc mails
 * "2FA Authorization Link" (sender "One Inc.") with a Proofpoint-wrapped …/IdentityProvider/2fa?… link, valid 10 min →
 * opening it lands on processonestg…/UI/Reports. Credentials come from ONEINC_PORTAL_USER / ONEINC_PORTAL_PASS (.env) and
 * are never logged; the link is read from the Outlook inbox of THIS PC (Outlook COM), so only a PC whose Outlook holds
 * the portal user's mailbox can sign in unattended — elsewhere this returns false and the caller waits for a person.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LOGIN = 'https://stgportalone.processonepayments.com/IdentityProvider/auth/login';

// Newest "2FA Authorization Link" e-mail received after `since`: its 2fa link, or '' (polls up to `waitMin`).
function twoFaLink(since, waitMin = 5) {
  const out = path.join(os.tmpdir(), `oneinc-2fa-${process.pid}.txt`);
  const ps = `
$o=New-Object -ComObject Outlook.Application; $ns=$o.GetNamespace('MAPI')
$since=[DateTime]::Parse('${new Date(since - 30e3).toISOString()}').ToLocalTime()
for($t=0;$t -lt ${Math.ceil(waitMin * 4)};$t++){
  try { $ns.SendAndReceive($false) } catch {}
  $items=$ns.GetDefaultFolder(6).Items; $items.Sort('[ReceivedTime]',$true)
  foreach($m in $items){ if($m.ReceivedTime -lt $since){break}
    if($m.Subject -like '*2FA Authorization Link*'){
      $l=@([regex]::Matches($m.HTMLBody,'href="([^"]+)"') | % { $_.Groups[1].Value } | ? { $_ -match '2fa' })
      if($l.Count){ [IO.File]::WriteAllText('${out.replace(/'/g, "''")}', $l[0]); exit } } }
  Start-Sleep 15 }`;
  const file = path.join(os.tmpdir(), `oneinc-2fa-${process.pid}.ps1`);
  fs.writeFileSync(file, ps);
  try {
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { timeout: (waitMin + 1) * 60e3 });
    const link = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : '';
    return link;
  } finally { for (const f of [file, out]) try { fs.unlinkSync(f); } catch (_) {} }
}

const submit = async (p, sel) => {
  const btn = p.locator('button[type=submit]').first();
  if (await btn.isDisabled().catch(() => true)) await p.evaluate((s) => document.querySelector(s).form.requestSubmit(), sel);
  else await btn.click();
};

// Sign `p` in. Returns true when the portal (…/UI/) is open, false when it could not (no creds / Outlook / wrong password).
async function signIn(p) {
  const user = process.env.ONEINC_PORTAL_USER;
  const pass = process.env.ONEINC_PORTAL_PASS;
  if (!user || !pass || process.platform !== 'win32') return false;
  try {
    await p.goto(LOGIN, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3000);
    if (/\/UI\//.test(p.url())) return true;
    if (await p.locator('#UserIdentifier').isVisible().catch(() => false)) {
      await p.locator('#UserIdentifier').fill('');
      await p.locator('#UserIdentifier').pressSequentially(user, { delay: 20 });
      await submit(p, '#UserIdentifier');
      await p.waitForTimeout(4000);
    }
    const pw = p.locator('input[type=password]').first();
    if (!(await pw.isVisible().catch(() => false))) return false;
    await pw.pressSequentially(pass, { delay: 20 });
    await p.getByText(/Keep me logged in/i).first().click().catch(() => {});
    const sentAt = Date.now();
    await submit(p, 'input[type=password]');
    await p.waitForTimeout(5000);
    const txt = await p.evaluate(() => document.body.innerText).catch(() => '');
    if (/Invalid username\/password/i.test(txt)) { console.log('[Portal] auto sign-in: password rejected (update ONEINC_PORTAL_PASS)'); return false; }
    if (/\/UI\//.test(p.url())) return true;
    console.log('[Portal] auto sign-in: waiting for the 2FA e-mail in Outlook');
    const link = twoFaLink(sentAt);
    if (!link) { console.log('[Portal] auto sign-in: no 2FA e-mail arrived'); return false; }
    await p.goto(link, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(8000);
    const ok = /\/UI\//.test(p.url());
    console.log(`[Portal] auto sign-in: ${ok ? 'signed in' : `not signed in (at ${p.url().replace(/\?.*/, '')})`}`);
    return ok;
  } catch (e) { console.log(`[Portal] auto sign-in failed: ${e.message.split('\n')[0]}`); return false; }
}

module.exports = { signIn, twoFaLink };
