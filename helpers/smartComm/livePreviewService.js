/**
 * helpers/smartComm/livePreviewService.js
 * Periodically screenshots a scenario's live Interactive-mode browser page to a fixed, known file the Runner
 * UI (Commercial Line Performance test/runner) polls and displays — so a person watching the Runner UI (which
 * may be a different device from the one actually running the headed Playwright browser — see that project's
 * server.js) can see what's on screen right now (which Microsoft sign-in step it's sitting on, which fields
 * are mid-edit) without needing desktop access to the machine actually running it. Purely a read-only side
 * channel: every failure here is swallowed, and nothing here can affect the real validation run.
 *
 * Per user request 2026-10-07: implemented as simple auto-refreshing screenshots (polled by the Runner UI
 * every ~1.5s), not a true live video feed (Chrome DevTools Protocol screencasting) — much less to build and
 * much less to keep working across a long run, at the cost of looking like a slideshow rather than smooth
 * video. Good enough to answer "what is it doing right now / which popup is THIS scenario's."
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PREVIEW_DIR = path.join(__dirname, '..', '..', 'results', 'smartComm', 'live-preview');

function previewPath(scenarioId) {
  // Scenario IDs are already filesystem-safe (DIG-number + LOB/state, e.g. "DIG52-AUTO-PA" — see
  // scenarioService.js) but sanitize defensively anyway, since this becomes a literal file name.
  const safe = String(scenarioId || 'scenario').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(PREVIEW_DIR, `${safe}.jpg`);
}

// `getActivePage()` lets the caller redirect which page gets screenshotted as the run moves through
// different windows — CONFIRMED live (see interactiveEditService.js's own header) the real Microsoft
// email/password/MFA fields during the sign-in wait live in a SEPARATE popup page, not the main ClaimCenter
// page (which just shows an "Authenticating..." placeholder for that whole wait) — a caller that only ever
// screenshots the main page would show a useless placeholder during exactly the moment a human most needs to
// see what's on screen. Defaults to always screenshotting `page` when no callback is given.
function startLivePreview(page, scenarioId, { intervalMs = 1500, getActivePage } = {}) {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const finalPath = previewPath(scenarioId);
  const tmpPath = `${finalPath}.tmp`;
  let stopped = false;
  let inFlight = false;

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const target = (getActivePage && getActivePage()) || page;
      if (target && !target.isClosed()) {
        // Written to a temp path then renamed — the Runner UI polls this file over HTTP on its own timer, so
        // this avoids it ever reading a half-written JPEG mid-write.
        await target.screenshot({ path: tmpPath, type: 'jpeg', quality: 45, timeout: Math.max(1000, intervalMs - 200) });
        fs.renameSync(tmpPath, finalPath);
      }
    } catch (e) {
      // Best-effort only — a page mid-navigation, a popup that just closed, etc. should never affect the
      // real validation run this is just a side-observer of.
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  tick(); // don't make the first frame wait a full interval

  return function stopLivePreview() {
    stopped = true;
    clearInterval(timer);
    try { fs.unlinkSync(finalPath); } catch (e) { /* already gone / never created */ }
    try { fs.unlinkSync(tmpPath); } catch (e) { /* already gone / never created */ }
  };
}

module.exports = { startLivePreview, PREVIEW_DIR };
