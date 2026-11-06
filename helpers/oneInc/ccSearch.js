/**
 * helpers/oneInc/ccSearch.js
 * Read-only ClaimCenter searches used to FIND existing TEST claims that already carry data the suite cannot build
 * (user direction 2026-11-06: "search for existing claims matching conditions"). Drives the Search tab's own screens:
 *   - Claims › Advanced Search (ClaimSearch-ClaimSearchScreen-ClaimSearchDV-…)
 *   - Checks/Payments (PaymentSearch-PaymentSearchScreen-PaymentSearchDV-…)
 * Criteria are given by the input/select NAME suffix (CONFIRMED 2026-11-06 on cloud TEST), e.g.
 *   searchClaims(page, { LOB: 'Workers\' Compensation', State: 'Utah', ClaimStatus: 'Open', AssignedToGroup: 'Casualty Claim Division' })
 *   searchChecks(page, { Status: 'Voided', ApprovedByGroup: 'Casualty Claim Division' })
 * Both screens refuse a search without one "required" criterion (claim/policy #, a name, a group/user, Created By, …):
 * "Please specify Claim #, Approved By Group, …". Returns [{ claim, text }] for the result rows (current page + up to
 * `pages` more).
 */
'use strict';
const W = require('./wizardDriver');

const CLAIM_RE = /\b[A-Z]{2,4}-[A-Z]{2}-\d{2}-\d{2}-\d{7}\b/;

async function openSearch(page, which) {
  await page.locator('#TabBar-SearchTab').first().click();
  await W.settle(page, 2500);
  await page.getByText(which, { exact: true }).first().click();
  await W.settle(page, 2500);
  await page.getByRole('button', { name: 'Reset', exact: true }).first().click().catch(() => {});
  await W.settle(page, 1500);
}

async function setCriteria(page, prefix, criteria) {
  for (const [suffix, value] of Object.entries(criteria)) {
    let el = page.locator(`[name^="${prefix}"][name$="-${suffix}"]`).first();
    // Date range "From"/"To": choose the date search's From/To radio (a div role=radio, …DateSearchDirectChoice_Choice_radio),
    // then fill the input inside the …StartDate / …EndDate widget (CONFIRMED 2026-11-06).
    if (/StartDate$|EndDate$/.test(suffix)) {
      await page.locator(`[id^="${prefix}"][id$="DateSearchDirectChoice_Choice_radio"]`).first().click().catch(() => {});
      await W.settle(page, 1200);
      el = page.locator(`[id^="${prefix}"][id$="-${suffix}"] input`).first();
    }
    if (!await el.isVisible().catch(() => false)) throw new W.Blocked(`search criterion "${suffix}" is not on the ${prefix} screen`);
    const tag = await el.evaluate((n) => n.tagName);
    if (tag === 'SELECT') {
      const opts = await el.evaluate((s) => [...s.options].map((o) => ({ v: o.value, t: o.text.trim() })));
      const pick = value instanceof RegExp ? opts.find((o) => value.test(o.t)) : opts.find((o) => o.t.toLowerCase() === String(value).toLowerCase());
      if (!pick) throw new W.Blocked(`"${suffix}" has no option ${value} (${opts.slice(0, 12).map((o) => o.t).join(', ')})`);
      await el.selectOption(pick.v);
    } else {
      await el.fill(String(value));
      await el.press('Tab').catch(() => {});
    }
    await W.settle(page, 1200);
  }
}

async function readResults(page, pages) {
  const out = [];
  for (let i = 0; i <= pages; i++) {
    const rows = await page.evaluate(() => [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && !r.querySelector('tr')
      && /LV-\d+(-\d+)?$/.test(r.id || '')).map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
    for (const t of rows) { const m = CLAIM_RE.exec(t); if (m) out.push({ claim: m[0], text: t }); }
    const next = page.locator('[aria-label="Next page"], [data-gw-click*="nextPage"], .gw-pagination-next').first();
    if (i === pages || !await next.isVisible().catch(() => false) || await next.isDisabled().catch(() => true)) break;
    await next.click();
    await W.settle(page, 3000);
  }
  return out;
}

async function run(page, which, prefix, criteria, { pages = 0 } = {}) {
  await openSearch(page, which);
  await setCriteria(page, prefix, criteria);
  await page.getByRole('button', { name: 'Search', exact: true }).first().click();
  await W.settle(page, 6000);
  const msg = await page.evaluate(() => [...document.querySelectorAll('.gw-message, [role=alert], .gw-WebMessage')].filter((e) => e.offsetParent).map((e) => e.innerText.trim()).join(' / '));
  if (/please specify/i.test(msg)) throw new W.Blocked(`search needs a required criterion: ${msg.slice(0, 200)}`);
  return readResults(page, pages);
}

const searchClaims = (page, criteria, opts) => run(page, 'Advanced Search', 'ClaimSearch-', criteria, opts);
const searchChecks = (page, criteria, opts) => run(page, 'Checks/Payments', 'PaymentSearch-', criteria, opts);

module.exports = { searchClaims, searchChecks, CLAIM_RE };
