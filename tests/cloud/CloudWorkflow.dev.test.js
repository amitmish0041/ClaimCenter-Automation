/**
 * tests/cloud/CloudWorkflow.dev.test.js
 *
 * DEVELOPMENT HARNESS — not part of the regression suite.
 *
 * Starts from an EXISTING claim and walks the post-FNOL flow one step at a
 * time: assignment -> exposures -> reserves -> subrogation. FNOL is skipped
 * deliberately: it already works on cloud for WC/CP/CA, takes ~2 minutes per
 * run, and re-proving it on every iteration of a downstream fix costs far more
 * than it tells us.
 *
 * Each phase is its own test so one failure does not hide the phases after it,
 * and every phase dumps what it actually found rather than asserting blind —
 * the whole point here is to LEARN the cloud DOM, not to go green.
 *
 * Run:
 *   npm run dev:cloud -- --grep "assignment"      (one phase)
 *   npm run dev:cloud                             (all phases)
 *
 * Requires a claim to work against:
 *   CC_EXISTING_CLAIM=CA-OH-85-26-0000177
 *
 * Once a phase works here, port it into the real helper and delete the
 * corresponding block from this file.
 */
const { test, expect } = require('@playwright/test');
const {
  loginToClaimCenter, openExistingClaim, IS_ON_PREM,
} = require('../../helpers/claimCenterBase');
const { assignClaim } = require('../../helpers/claimLifecycleHelper');
const { createReserve } = require('../../helpers/financialsHelper');

test.setTimeout(600_000);

const CLAIM = process.env.CC_EXISTING_CLAIM;

test.describe('Cloud post-FNOL workflow (dev harness)', () => {
  test.describe.configure({ mode: 'serial' });

  let page;

  test.beforeAll(async ({ browser }) => {
    if (!CLAIM) {
      throw new Error('CC_EXISTING_CLAIM is not set. This harness starts from an existing claim, ' +
                      'e.g. CC_EXISTING_CLAIM=CA-OH-85-26-0000177');
    }
    page = await browser.newPage();
    await loginToClaimCenter(page);
    await openExistingClaim(page, CLAIM);
    console.log('DEV HARNESS: starting from claim ' + CLAIM + ' on ' + (IS_ON_PREM ? 'ON-PREM' : 'CLOUD'));
  });

  test.afterAll(async () => { if (page) await page.close(); });

  // ── Phase 1: assignment ────────────────────────────────────────────────────
  test('phase 1 — assignment', async () => {
    const before = await claimHeader(page);
    console.log('phase 1: header before —', before);
    await assignClaim(page);
    const after = await claimHeader(page);
    console.log('phase 1: header after  —', after);
    expect(after, 'claim should not still be Pending Assignment').not.toMatch(/Pending Assignment/i);
  });

  // ── Phase 2: exposures ─────────────────────────────────────────────────────
  // The blocker as of this writing: the coverage submenu is never read.
  // page.getByRole('menuitem') returns the ROOT Actions list at every depth,
  // and item text is corrupted by the shortcut-key spans ("NoNote", "ReReserve"),
  // so matching must use aria-label and must be SCOPED to the open submenu.
  // This phase dumps the real structure so that scoping can be written from
  // fact rather than guessed.
  test('phase 2 — inspect the Actions / Choose by Coverage menu', async () => {
    await openActions(page);
    await dumpMenus(page, 'after opening Actions');

    const chooseByCoverage = page.locator('[aria-label="Choose by Coverage"]').first();
    const found = await chooseByCoverage.isVisible().catch(() => false);
    console.log('phase 2: "Choose by Coverage" found via aria-label? ' + found);

    if (found) {
      await chooseByCoverage.hover().catch(() => {});
      await page.waitForTimeout(1200);
      await dumpMenus(page, 'after HOVER on Choose by Coverage');

      await chooseByCoverage.click().catch(() => {});
      await page.waitForTimeout(1200);
      await dumpMenus(page, 'after CLICK on Choose by Coverage');
    }
  });

  // ── Phase 3: reserves ──────────────────────────────────────────────────────
  // Depends on phase 2: with no exposure there is no reserve line to edit, so
  // a failure here is only meaningful once exposures exist.
  test('phase 3 — reserve', async () => {
    const exposures = await countExposures(page);
    console.log('phase 3: claim currently has ' + exposures + ' exposure(s)');
    test.skip(exposures === 0, 'no exposures on this claim yet — reserve cannot be created (see phase 2)');

    const blocked = await createReserve(page, {
      reserveAmount: 5000, costType: 'CLPD', costCategory: 'ClaimCost',
    });
    console.log('phase 3: createReserve returned —', blocked || '(no block reason)');
  });

  // ── Phase 4: subrogation ───────────────────────────────────────────────────
  test('phase 4 — inspect subrogation entry point', async () => {
    const subroNav = page.locator('[aria-label="Subrogation"]').first();
    const viaNav = await subroNav.isVisible().catch(() => false);
    console.log('phase 4: Subrogation left-nav entry present? ' + viaNav);
    if (viaNav) {
      await subroNav.click().catch(() => {});
      await page.waitForTimeout(2000);
      const heading = await page.evaluate(() => (document.body.innerText || '').slice(0, 300)).catch(() => '');
      console.log('phase 4: landed on —', heading.replace(/\s+/g, ' ').slice(0, 200));
    }
  });
});

// ── helpers local to this harness ────────────────────────────────────────────

async function claimHeader(page) {
  return page.evaluate(() => {
    const t = document.body.innerText || '';
    const m = t.match(/Pol:[^\n]{0,200}/);
    return (m ? m[0] : t.slice(0, 160)).replace(/\s+/g, ' ').trim();
  }).catch(() => '(header unreadable)');
}

async function openActions(page) {
  const candidates = [
    page.locator('[aria-label="deferred Actions"]').first(),
    page.locator('.gw-action--inner[aria-haspopup="true"]').first(),
    page.locator('[id="Claim:ClaimMenuActions"]').first(),
  ];
  for (const c of candidates) {
    if (!await c.isVisible().catch(() => false)) continue;
    await c.click().catch(() => {});
    await page.waitForTimeout(1200);
    return true;
  }
  console.log('openActions: no Actions control found');
  return false;
}

// Dumps every menu-ish container currently on screen, with each entry's
// ARIA-LABEL (reliable) alongside its textContent (corrupted by shortcut-key
// spans). Seeing both side by side is what tells us which to match on and
// which container to scope to.
async function dumpMenus(page, when) {
  const dump = await page.evaluate(() => {
    const out = [];
    const containers = document.querySelectorAll(
      '[role="menu"], .gw-menu, .gw-submenu, [class*="menu"][class*="gw-"]');
    let idx = 0;
    for (const c of containers) {
      if (!c.offsetParent) continue;
      const entries = [...c.querySelectorAll('[aria-label]')]
        .filter(e => e.offsetParent)
        .slice(0, 25)
        .map(e => ({
          aria: e.getAttribute('aria-label'),
          text: (e.textContent || '').trim().slice(0, 40),
          cls : (e.className || '').toString().slice(0, 40),
        }));
      if (!entries.length) continue;
      out.push({
        container: idx++,
        containerClass: (c.className || '').toString().slice(0, 60),
        containerRole: c.getAttribute('role') || '',
        count: entries.length,
        entries,
      });
    }
    return out;
  }).catch(() => []);

  console.log('--- MENU DUMP (' + when + ') : ' + dump.length + ' visible container(s) ---');
  for (const d of dump) {
    console.log('  container#' + d.container + ' role=' + d.containerRole +
                ' class="' + d.containerClass + '" entries=' + d.count);
    for (const e of d.entries) {
      console.log('     aria="' + e.aria + '"  text="' + e.text + '"');
    }
  }
}

async function countExposures(page) {
  return page.evaluate(() => {
    const t = document.body.innerText || '';
    const m = t.match(/Exposures?\s*\((\d+)\)/i);
    if (m) return parseInt(m[1], 10);
    return document.querySelectorAll('[id*="ExposuresLV"] tr, [id*="Exposures"] [role="row"]').length;
  }).catch(() => 0);
}
