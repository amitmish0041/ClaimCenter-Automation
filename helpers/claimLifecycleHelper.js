/**
 * helpers/claimLifecycleHelper.js
 * Segmentation, InitialReserves, Workplan, Close, Reopen, Archive, Exception.
 */
const { selectDropdown, fillTextField, fillDateField, clickSave,
        verifyTextVisible, verifyNoValidationErrors, elementExists } = require('./claimCenterBase');

// ── Segmentation ──────────────────────────────────────────────────────────────
async function assertSegment(page, expectedSegment) {
  const el = page.locator('[id*="Segment"], [id*="segment"]').first();
  const txt = await el.textContent();
  if (!txt?.includes(expectedSegment)) throw new Error('Expected segment "' + expectedSegment + '", got "' + txt + '"');
}

async function setSegmentManually(page, segmentValue) {
  await page.click('[id*="SegmentationTab"], a:has-text("Segmentation")').catch(() => {});
  await selectDropdown(page, '[id*="Segment"]', segmentValue);
  await clickSave(page);
}

// ── Initial Reserves ──────────────────────────────────────────────────────────
async function assertInitialReservesSet(page, { exposureLabel, expectedAmount }) {
  await page.click('[id*="FinancialsTab"], a:has-text("Financials")');
  await page.click('[id*="ReservesTab"], a:has-text("Reserves")');
  const row = page.locator('tr:has-text("' + exposureLabel + '")').first();
  const txt = await row.locator('[id*="ReserveAmount"], td').nth(2).textContent();
  const actual   = parseFloat(txt.replace(/[^0-9.]/g, ''));
  const expected = parseFloat(String(expectedAmount).replace(/[^0-9.]/g, ''));
  if (Math.abs(actual - expected) > 1) throw new Error('Reserve mismatch: expected ' + expected + ' got ' + actual);
}

// ── Workplan ──────────────────────────────────────────────────────────────────
async function openWorkplanTab(page) {
  await page.click('[id*="WorkplanTab"], a:has-text("Workplan"), a:has-text("Activities")');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function assertActivityExists(page, { activitySubject, activityType }) {
  await openWorkplanTab(page);
  const row = page.locator('tr:has-text("' + activitySubject + '")').first();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  if (activityType) {
    const cell = row.locator('td:has-text("' + activityType + '")');
    if (await cell.count() === 0) throw new Error('Activity type "' + activityType + '" not found for "' + activitySubject + '"');
  }
}

async function createManualActivity(page, { subject, type, dueDate, note }) {
  await openWorkplanTab(page);
  await page.click('button:has-text("New Activity"), [id*="NewActivity"]');
  await page.waitForSelector('[id*="Subject"]', { timeout: 15_000 });
  await fillTextField(page, '[id*="Subject"]', subject);
  if (type)    await selectDropdown(page, '[id*="ActivityType"], [id*="Type"]', type);
  if (dueDate) await fillDateField(page,  '[id*="DueDate"]',                   dueDate);
  if (note)    await fillTextField(page,  '[id*="Note"]',                       note);
  await clickSave(page);
}

async function completeActivity(page, activitySubject) {
  await openWorkplanTab(page);
  const row = page.locator('tr:has-text("' + activitySubject + '")').first();
  await row.locator('button:has-text("Complete"), a:has-text("Complete")').click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

// ── Close ─────────────────────────────────────────────────────────────────────
async function closeClaim(page, { closeReason, closingNote }) {
  await page.click('[id*="Actions"], button:has-text("Actions")');
  await page.click('a:has-text("Close Claim"), [id*="CloseClaim"]');
  await page.waitForSelector('[id*="CloseReason"]', { timeout: 15_000 });
  await selectDropdown(page, '[id*="CloseReason"]', closeReason);
  if (closingNote) await fillTextField(page, '[id*="Note"]', closingNote);
  await clickSave(page);
  await verifyNoValidationErrors(page);
}

async function assertClaimStatus(page, expectedStatus) {
  const el  = page.locator('[id*="Status"], [id*="ClaimStatus"]').first();
  const txt = await el.textContent();
  if (!txt?.includes(expectedStatus)) throw new Error('Expected status "' + expectedStatus + '", got "' + txt + '"');
}

// ── Reopen ────────────────────────────────────────────────────────────────────
async function reopenClaim(page, { reopenReason }) {
  await page.click('[id*="Actions"], button:has-text("Actions")');
  await page.click('a:has-text("Reopen"), [id*="Reopen"]');
  await page.waitForSelector('[id*="ReopenReason"]', { timeout: 15_000 });
  if (reopenReason) await fillTextField(page, '[id*="ReopenReason"]', reopenReason);
  await clickSave(page);
  await verifyNoValidationErrors(page);
}

// ── Archive ───────────────────────────────────────────────────────────────────
async function archiveClaim(page) {
  await page.click('[id*="Actions"], button:has-text("Actions")');
  await page.click('a:has-text("Archive"), [id*="Archive"]');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await verifyNoValidationErrors(page);
}

// ── Exception ─────────────────────────────────────────────────────────────────
async function assertExceptionLogged(page, { exceptionType }) {
  await page.click('[id*="ExceptionsTab"], a:has-text("Exceptions")').catch(() => {});
  await verifyTextVisible(page, exceptionType);
}

module.exports = {
  assertSegment, setSegmentManually,
  assertInitialReservesSet,
  openWorkplanTab, assertActivityExists, createManualActivity, completeActivity,
  closeClaim, assertClaimStatus,
  reopenClaim,
  archiveClaim,
  assertExceptionLogged,
};
