/**
 * helpers/smartComm/documentApprovalService.js
 * The approval workflow of a SmartCOMM document whose editor shows "Request Approval" instead of "Complete Document" (DIG179, DIG52).
 * CONFIRMED live 2026-11-10 (DIG179, claim HO-PA-01-26-0748044):
 *   - Request Approval opens "New Activity in Claim": Subject "Document Approval", Description "<DIG> <template name>", Related To, Due Date,
 *     Assign To (default "Use automated assignment" - that gave the claim owner, e.g. Richard Shearer), Update / Cancel / Link Document.
 *   - Update creates the activity; the document is listed under Documents with status "Approving".
 *   - The activity shows in the claim's Workplan (All open activities, newest due date on the LAST page) with Assign / Complete / Approve / Reject.
 *     An admin who is not the assignee gets Approve disabled, so the activity is assigned to the requesting user (Assign To) and approved by them.
 */
'use strict';
const { saveDiagnostic } = require('./interactiveEditService');

const wait = (page, ms) => page.waitForTimeout(ms);

// Request Approval -> New Activity form -> Assign To (a user matching assignToRe, else the automated assignment stays) -> Update.
async function requestApproval(page, { assignToRe, log = console.log, scenarioId = 'scenario' } = {}) {
  await page.getByRole('button', { name: 'Request Approval', exact: true }).click();
  // (a native confirm "Approval needed to Complete document." comes first - installDialogAutoAccept accepts it)
  await page.getByRole('button', { name: 'Update', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  const description = (await page.locator('textarea').first().inputValue().catch(() => '')).trim();
  let assignedTo = 'automated assignment';
  if (assignToRe) {
    const sel = page.locator('select').filter({ has: page.locator('option', { hasText: assignToRe }) }).first();
    const opt = sel.locator('option').filter({ hasText: assignToRe }).first();
    if (await opt.count()) {
      const label = (await opt.innerText()).trim();
      await sel.selectOption({ label });
      assignedTo = label;
      await wait(page, 800);
    } else log(`[Approval] no Assign To option matches ${assignToRe} - keeping the automated assignment`);
  }
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await wait(page, 5000);
  log(`[Approval] approval requested for "${description}" - assigned to ${assignedTo}`);
  await saveDiagnostic(page, `${scenarioId}_approvalRequested`).catch(() => null);
  return { description, assignedTo };
}

async function openWorkplan(page) {
  await page.getByRole('menuitem', { name: 'Workplan', exact: true }).click().catch(() => page.getByText('Workplan', { exact: true }).first().click());
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await wait(page, 2000);
}

// Last page of the activities grid (newest due dates): the last button of the pager that sits next to "Displaying 1 - 15 of n".
async function lastPage(page) {
  const pager = page.locator('xpath=//*[contains(normalize-space(.),"Displaying")][not(.//*[contains(normalize-space(.),"Displaying")])]/ancestor::*[.//*[self::button or @role="button"]][1]');
  const btn = pager.locator('button, [role="button"]').last();
  if (await btn.count()) { await btn.click().catch(() => {}); await wait(page, 3000); }
}

// Finds the open "Document Approval" activity for this document (description), ticks it and presses Approve.
async function approveFromWorkplan(page, { description, log = console.log, scenarioId = 'scenario' } = {}) {
  await openWorkplan(page);
  await lastPage(page);
  const row = page.locator('table tbody tr').filter({ hasText: 'Document Approval' }).filter({ hasText: description || '' }).last();
  if (!(await row.isVisible().catch(() => false))) {
    await saveDiagnostic(page, `${scenarioId}_approvalNotInWorkplan`).catch(() => null);
    throw new Error(`APPROVAL_ACTIVITY_NOT_FOUND: no open "Document Approval" activity for "${description}" on the last Workplan page.`);
  }
  const rowText = (await row.innerText()).replace(/\s+/g, ' ').trim();
  await row.locator('input[type="checkbox"], [role="checkbox"]').first().click({ force: true });
  await wait(page, 800);
  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  if (!(await approve.isEnabled().catch(() => false))) {
    await saveDiagnostic(page, `${scenarioId}_approveDisabled`).catch(() => null);
    throw new Error(`APPROVAL_NOT_ALLOWED: the Approve button is disabled for the signed-in user on "${rowText}" - the activity must be assigned to the user who approves it.`);
  }
  await approve.click();
  await wait(page, 5000);
  await saveDiagnostic(page, `${scenarioId}_approved`).catch(() => null);
  log(`[Approval] Approve pressed on: ${rowText}`);
  return rowText;
}

module.exports = { requestApproval, approveFromWorkplan, openWorkplan };
