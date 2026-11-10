/**
 * helpers/regression/policyCenter.js — read-only PolicyCenter checks for the Intersuite regression cases (TC005 names,
 * TC029/TC030 claims on the policy, TC031/TC032 contact sync, TC060/TC061 API vs PC).
 *
 * Login + Policy-tab expand are the sequence Test-Automation-Portal's SFA_SFI_Workflow.submitPolicyForApproval runs
 * daily against on-prem PolicyCenter (Username/Password textboxes, Enter, then #TabBar-PolicyTab expand toggle — check
 * the search box before clicking, it is a toggle). Everything after the search is NOT live-verified yet: labels are
 * matched loosely and a missing screen raises Blocked (BLOCKED in the result), never a false FAIL.
 *
 * Credentials come from env, never hard-coded: REG_PC_USER / REG_PC_PASS. URL: REG_PC_URL, else the tier's on-prem PC.
 * Opens in its own tab of the same context and closes it afterwards, so the ClaimCenter page is left where it was.
 */
'use strict';
const { Blocked } = require('../oneInc/wizardDriver');

const PC_URLS = {
  test: 'http://test-policycenter.donegalgroup.com/pc/PolicyCenter.do',
  dev: 'http://test-policycenter.donegalgroup.com/pc/PolicyCenter.do',
};

function configured() {
  return !!(process.env.REG_PC_USER && process.env.REG_PC_PASS);
}

async function withPC(page, fn) {
  if (!configured()) throw new Blocked('PolicyCenter check — set REG_PC_USER / REG_PC_PASS (and REG_PC_URL if not the TEST on-prem PC)');
  const tier = String(process.env.CC_TIER || 'test').toLowerCase();
  const url = process.env.REG_PC_URL || PC_URLS[tier] || PC_URLS.test;
  const pc = await page.context().newPage();
  pc.setDefaultTimeout(45000);
  try {
    await pc.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => { throw new Blocked(`PolicyCenter not reachable at ${url}: ${e.message.split('\n')[0]}`); });
    const user = pc.getByRole('textbox', { name: 'Username' });
    if (await user.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)) {
      await user.fill(process.env.REG_PC_USER);
      await pc.getByRole('textbox', { name: 'Password' }).fill(process.env.REG_PC_PASS);
      await pc.getByRole('textbox', { name: 'Password' }).press('Enter');
      await pc.waitForLoadState('networkidle').catch(() => {});
      await pc.waitForTimeout(4000);
    }
    const err = await pc.locator('text=/user configuration|error occurred|invalid user/i').first().textContent({ timeout: 3000 }).catch(() => '');
    if (err) throw new Blocked(`PolicyCenter login failed: ${err.trim()}`);
    return await fn(pc);
  } finally {
    await pc.close().catch(() => {});
  }
}

const settle = (pc, ms = 2500) => pc.waitForLoadState('domcontentloaded').catch(() => {}).then(() => pc.waitForTimeout(ms));

// Policy tab › Policy # search box (expand the tab first if collapsed — a toggle, so look before clicking).
async function openPolicy(pc, policyNumber) {
  const box = pc.locator('input[name="TabBar-PolicyTab-PolicyTab_PolicyRetrievalItem"], input[name*="PolicyTab_PolicyRetrievalItem"]').first();
  if (!(await box.isVisible().catch(() => false))) {
    await pc.getByRole('menuitem', { name: 'Policy', exact: true }).click().catch(() => {});
    await pc.waitForTimeout(1200);
    if (!(await box.isVisible().catch(() => false))) await pc.locator('#TabBar-PolicyTab > .gw-action--expand-button > .gw-icon').click().catch(() => {});
  }
  if (!(await box.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false))) throw new Blocked('PolicyCenter Policy # search box not found');
  await box.fill(policyNumber);
  await box.press('Enter');
  await settle(pc, 4000);
  const body = await pc.locator('body').innerText().catch(() => '');
  if (!body.includes(policyNumber)) throw new Blocked(`PolicyCenter did not open policy ${policyNumber}`);
  return body;
}

// Left-nav item on a policy / account file (Claims, Contacts …).
async function leftNav(pc, re) {
  const item = pc.locator('[role="menuitem"], .gw-action--inner, a').filter({ hasText: re }).first();
  if (!(await item.isVisible().catch(() => false))) return false;
  await item.click().catch(() => {});
  await settle(pc);
  return true;
}

const rowsOf = (pc) => pc.evaluate(() => [...document.querySelectorAll('tr[role="row"], tr')]
  .filter((r) => r.offsetParent).map((r) => r.innerText.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 400));

// Claims listed on the policy in PolicyCenter: [{ text }] rows that look like claim numbers.
async function policyClaims(page, policyNumber) {
  return withPC(page, async (pc) => {
    await openPolicy(pc, policyNumber);
    if (!(await leftNav(pc, /^Claims$/))) throw new Blocked('policy file has no Claims item in PolicyCenter');
    return (await rowsOf(pc)).filter((t) => /[A-Z]{2,4}-[A-Z]{2}-\d{2}-\d{2}-\d{7}|\b\d{7,}\b/.test(t));
  });
}

// Names on the policy's Summary / Contacts (insured, agent, underwriter, drivers) — whatever PC shows, as text.
async function policyParties(page, policyNumber) {
  return withPC(page, async (pc) => {
    const summary = await openPolicy(pc, policyNumber);
    let contacts = '';
    if (await leftNav(pc, /^Contacts$/)) contacts = (await rowsOf(pc)).join('\n');
    return { summary, contacts };
  });
}

// Search PolicyCenter contacts by name (Search › Contacts). Returns the result rows (name + status text).
async function findContact(page, { first, last }) {
  return withPC(page, async (pc) => {
    await pc.getByRole('menuitem', { name: 'Search', exact: true }).click().catch(() => {});
    await settle(pc);
    if (!(await leftNav(pc, /^Contacts$/))) throw new Blocked('PolicyCenter Search › Contacts not found');
    const fill = async (label, v) => { const b = pc.getByRole('textbox', { name: label }).first(); if (v && await b.isVisible().catch(() => false)) await b.fill(v); };
    await fill(/Last name/i, last);
    await fill(/First name/i, first);
    await pc.getByRole('button', { name: /^Search$/ }).first().click().catch(() => {});
    await settle(pc, 3500);
    return (await rowsOf(pc)).filter((t) => t.toUpperCase().includes(String(last || first).toUpperCase()));
  });
}

module.exports = { configured, withPC, policyClaims, policyParties, findContact };
