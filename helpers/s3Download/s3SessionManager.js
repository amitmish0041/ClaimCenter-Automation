/**
 * helpers/s3Download/s3SessionManager.js
 * Keeps ONE S3 Integration Files admin browser context/page alive across many scenarios — and, when the
 * caller shares a single instance across an entire bulk run (see scripts/bulkValidateSmartComm.js), across
 * many TEMPLATES too — instead of opening a brand-new context, logging in, checking Planet, and closing it
 * again for every single scenario's S3 fetch (runInteractiveGeneration in validationService.js). Added
 * 2026-10-05 per user request: even with a saved Okta session making the sign-in itself instant, every one
 * of those per-scenario context creations still re-pays page.goto(S3_ADMIN_URL)'s networkidle wait and the
 * Planet-badge poll — several seconds of pure fixed overhead, every scenario, for no reason once a session
 * is already live and valid.
 *
 * withPage() SERIALIZES access via a simple promise chain, so concurrent scenario workers
 * (SMARTCOMM_CONCURRENCY>1) never drive the one shared S3 page at the same time — only the brief S3 fetch
 * itself queues behind another worker's; each scenario's own ClaimCenter work (on its own context/page)
 * still runs fully in parallel exactly as before.
 */
'use strict';
const s3AdminService = require('./s3AdminService');

function createS3SessionManager(browser, { log = console.log } = {}) {
  let ctx = null;
  let page = null;
  let chain = Promise.resolve();

  async function ensureReady() {
    if (page && !page.isClosed()) return page;
    ctx = await browser.newContext({ acceptDownloads: true });
    page = await ctx.newPage();
    await s3AdminService.loginAndEnsureTestPlanet(page, { log });
    return page;
  }

  // Runs `fn(s3Page)` once this shared page is logged in and ready, queued behind any other in-flight call.
  // A failure inside `fn` (a crashed page, a navigation that left the tree in a bad state) tears down the
  // shared context/page so the NEXT call starts fresh instead of every later scenario inheriting the same
  // broken state — this one scenario's own fetch still fails and reports normally, same as before.
  function withPage(fn) {
    const run = chain.then(async () => {
      const p = await ensureReady();
      try {
        return await fn(p);
      } catch (err) {
        await ctx.close().catch(() => {});
        page = null;
        ctx = null;
        throw err;
      }
    });
    chain = run.catch(() => {}); // keep the chain alive for the next queued call even after a failure
    return run;
  }

  async function close() {
    if (ctx) await ctx.close().catch(() => {});
    page = null;
    ctx = null;
  }

  return { withPage, close };
}

module.exports = { createS3SessionManager };
