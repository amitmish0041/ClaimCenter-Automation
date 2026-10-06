/**
 * helpers/ccUiValidation/activityPatterns.js
 * Business Rule 2: activity patterns carry a "Create Document" button that opens Create-from-Template with
 * the mapped template already searched ("Activity Pattern to Document" tab). Read-only: patterns are only
 * OPENED on the unsaved New Activity screen and cancelled — no activity is ever saved.
 *
 * The Actions → New ... → New Activity menu is per-claim (jurisdiction/LOB gated), so a pattern absent from
 * one claim's menu is reported BLOCKED ("not offered on the claims scanned"), not FAIL.
 */
'use strict';
const { openClaimActionsMenu } = require('../claimLifecycleHelper');
const { norm, row } = require('./checks');

const MENU_SNAPSHOT = () => Array.from(document.querySelectorAll('[role="menuitem"]'))
  .filter((e) => e.offsetParent).map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim());

async function openNewMenu(page) {
  await openClaimActionsMenu(page, 'ccUi.activityPatterns');
  const nm = page.getByRole('menuitem', { name: /^New \.\.\./ }).first();
  await nm.hover().catch(() => {});
  await nm.click().catch(() => {});
  await page.waitForTimeout(800);
}

// { category: [pattern names] } for the claim currently open.
async function scanActivityMenu(page) {
  await openNewMenu(page);
  const flat = await page.evaluate(MENU_SNAPSHOT);
  const start = flat.indexOf('New Activity');
  const end = flat.indexOf('New Exposure');
  const categories = start >= 0 ? flat.slice(start + 1, end > start ? end : undefined) : [];
  const result = {};
  for (const c of categories) {
    const before = new Set(await page.evaluate(MENU_SNAPSHOT));
    await page.getByRole('menuitem', { name: c, exact: true }).first().hover().catch(() => {});
    await page.waitForTimeout(600);
    result[c] = (await page.evaluate(MENU_SNAPSHOT)).filter((x) => !before.has(x));
  }
  await page.keyboard.press('Escape').catch(() => {});
  return result;
}

async function openPattern(page, category, name) {
  await openNewMenu(page);
  await page.getByRole('menuitem', { name: category, exact: true }).first().hover();
  await page.waitForTimeout(600);
  await page.getByRole('menuitem', { name, exact: true }).first().click();
  await page.getByRole('button', { name: /^Update$/ }).first().waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(800);
}

async function newActivityButtons(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('[role="button"], button'))
    .filter((b) => b.offsetParent).map((b) => (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
}

async function cancelNewActivity(page) {
  await page.getByRole('button', { name: /^Cancel$/ }).first().click().catch(() => {});
  await page.waitForTimeout(1000);
}

// "DIG 21 - Compliance Letter" against text on the Select Template screen.
function templateMatches(text, specTemplate) {
  const m = specTemplate.match(/^DIG\s*([0-9A-Za-z]+)\s*-\s*(.+)$/i);
  if (!m) return norm(text).includes(norm(specTemplate));
  const t = norm(text);
  return t.includes(norm(`DIG${m[1]}`)) && t.includes(norm(m[2]));
}

/**
 * claims: [{ claimNumber, open: async () => void }] — `open` navigates to the claim (with any permission fallback).
 */
async function br2Section(page, spec, out, { claims }) {
  const screen = 'Business Rules';
  const offered = {}; // norm(pattern) -> { claim, category, name }
  const scanned = [];
  for (const c of claims) {
    try {
      await c.open();
      const menu = await scanActivityMenu(page);
      scanned.push(c.claimNumber);
      for (const [category, names] of Object.entries(menu)) {
        for (const name of names) if (!offered[norm(name)]) offered[norm(name)] = { claim: c, category, name };
      }
    } catch (e) {
      out.push(row(`BR2.scan.${c.claimNumber}`, screen, `Business Rule 2: activity menu scan of ${c.claimNumber}`, 'BLOCKED', 'menu scanned', 'error', e.message.split('\n')[0]));
    }
  }

  for (const ap of spec.activityPatterns) {
    const id = `BR2.${ap.id}`;
    const description = `Business Rule 2: pattern "${ap.activityPattern}" → template "${ap.template}"`;
    const hit = offered[norm(ap.activityPattern)];
    if (!hit) {
      out.push(row(id, screen, description, 'BLOCKED', '"Create Document" button opens Create-from-Template with the template searched',
        'pattern not offered', `Not in the New Activity menu of the claim(s) scanned (${scanned.join(', ') || 'none'}). The menu is per-claim (jurisdiction/LOB), so scan a claim where it applies (--br2-claims / --br2-states), or the pattern is not deployed yet.`));
      continue;
    }
    try {
      await hit.claim.open();
      await openPattern(page, hit.category, hit.name);
      const buttons = await newActivityButtons(page);
      const create = buttons.find((b) => norm(b) === 'createdocument');
      if (!create) {
        out.push(row(id, screen, description, 'FAIL', '"Create Document" button on the activity', `buttons: ${['Update', 'Cancel', 'Link Document', 'Use Template'].filter((b) => buttons.includes(b)).join(', ') || buttons.slice(0, 8).join(', ')}`,
          `Pattern found under ${hit.category} (claim ${hit.claim.claimNumber}); the New Activity screen has no "Create Document" button. "Use Template" opens the OOTB note-template finder, not SmartCOMM Create-from-Template.`));
        await cancelNewActivity(page);
        continue;
      }
      await page.getByRole('button', { name: /^Create Document$/ }).first().click();
      await page.getByRole('tab', { name: 'Select Template', exact: true }).waitFor({ state: 'visible', timeout: 20000 });
      await page.waitForTimeout(2000);
      const text = await page.evaluate(() => {
        const root = document.querySelector('[id="GC_NewDocumentWorksheet-GC_NewDocumentScreen"]');
        return root ? root.innerText : '';
      });
      const ok = templateMatches(text, ap.template);
      out.push(row(id, screen, description, ok ? 'PASS' : 'FAIL', `Select Template already searched for "${ap.template}"`, ok ? 'template found in the search results' : 'template not found on the Select Template screen'));
      await page.getByRole('button', { name: /^Cancel/ }).first().click().catch(() => {});
    } catch (e) {
      out.push(row(id, screen, description, 'BLOCKED', '"Create Document" button opens Create-from-Template', 'error', e.message.split('\n')[0]));
      await cancelNewActivity(page).catch(() => {});
    }
  }
}

module.exports = { br2Section, scanActivityMenu, templateMatches };
