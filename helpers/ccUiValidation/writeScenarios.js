/**
 * helpers/ccUiValidation/writeScenarios.js
 * STATE-CHANGING checks — only run with --writes, against the Test tier. Creates ONE saved document on the
 * chosen claim (description "CCUI-BR1-<timestamp>") to verify Business Rule 1 and the Document Properties
 * recipient ordering (UIF.045). Delivery Channel stays Print for every recipient, so nothing is mailed.
 */
'use strict';
const documentService = require('../smartComm/documentService');
const catalogService = require('../smartComm/catalogService');
const { row } = require('./checks');
const { openDocumentsPage } = require('./documentScreens');

async function setRowRadio(page, idFragment, wantYes) {
  const radios = page.locator(`[id*="${idFragment}"][role="radio"]`);
  await radios.first().waitFor({ state: 'attached', timeout: 8000 });
  await radios.nth(wantYes ? 0 : 1).click({ force: true });
}

async function br1Section(page, out, { templateDig, log = console.log }) {
  const screen = 'Business Rules';
  const marker = `CCUI-BR1-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const template = catalogService.getTemplate(templateDig);
  const desc = 'Business Rule 1: one copy of the letter is saved regardless of the number of recipients';

  await documentService.openCreateFromTemplate(page);
  await documentService.selectTemplate(page, [template.searchName, template.searchNameAlt]);
  const primary = await documentService.setPrimaryRecipient(page, {});
  await documentService.setDeliveryChannel(page, 'Print');
  await documentService.setMailOptions(page, { returnEnvelope: false, certifiedMail: false });

  // Additional recipient (a confirm dialog fires first; the page-level handler accepts it).
  await page.getByRole('button', { name: 'Additional Recipient' }).click();
  await page.waitForTimeout(1500);
  const menu = page.getByRole('menu').last();
  await menu.waitFor({ state: 'visible', timeout: 5000 });
  const items = (await menu.getByRole('menuitem').allInnerTexts()).map((s) => s.trim());
  const additional = items.find((n) => n && n !== primary.name && !/address book|1099/i.test(n));
  if (!additional) throw new Error('no second contact available on this claim to use as an additional recipient');
  await menu.getByRole('menuitem', { name: additional }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('select[id$="-0-DeliveryChannel"], [id$="-0-DeliveryChannel"] select').first().selectOption({ label: 'Print' });
  await page.waitForTimeout(2000);
  await setRowRadio(page, '-0-ReturnEnvelope_Ext', false);
  await setRowRadio(page, '-0-CertifiedMail_Ext', false);

  await documentService.setAdditionalData(page, { documentType: 'Letter sent' });
  await page.getByRole('textbox', { name: 'Document Description' }).first().fill(marker);
  await page.getByRole('textbox', { name: 'Document Description' }).first().press('Tab');

  await page.getByRole('tab', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Generate' }).click();
  const resultRows = page.locator('[id*="CreatedDocuments"] tr.gw-standard-row');
  const banner = page.getByRole('group', { name: /^Errors/i });
  const winner = await Promise.race([
    resultRows.first().waitFor({ state: 'visible', timeout: 120000 }).then(() => 'rows').catch(() => 'timeout'),
    banner.first().waitFor({ state: 'visible', timeout: 120000 }).then(() => 'error').catch(() => 'timeout'),
  ]);
  if (winner !== 'rows') {
    const msg = winner === 'error' ? (await banner.first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim() : 'no result and no error within 120s';
    out.push(row('BR1', screen, desc, 'BLOCKED', 'documents generated and saved for two recipients', 'generation did not complete', msg));
    return null;
  }
  const generated = await resultRows.count();
  log(`[CC-UI] BR1: Generate produced ${generated} result row(s) for 2 recipients`);
  await page.getByRole('button', { name: 'Save documents' }).click();
  await page.locator('[id="GC_NewDocumentWorksheet-GC_NewDocumentScreen"]').waitFor({ state: 'hidden', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);

  await openDocumentsPage(page);
  const saved = await page.getByRole('row').filter({ hasText: marker }).count();
  out.push(row('BR1', screen, desc, saved === 1 ? 'PASS' : 'FAIL', 'exactly 1 saved document for a letter sent to 2 recipients (primary + additional)',
    `${saved} saved document(s) named "${marker}"; Generate returned ${generated} result row(s)`,
    saved === 1 ? 'Created a test document on the claim named as above.' : `Created ${saved} test document(s) named "${marker}" on the claim. Note: the wizard still shows the legacy banner "A new document will be created for each additional recipient".`));
  out.push(row('BR1.email', screen, 'Business Rule 1: "if sent via email, a copy of each email template will be saved"', 'BLOCKED',
    'one saved copy per email template', 'not run', 'Needs the Email delivery channel, which could send a real email — deliberately not exercised.'));
  return { marker, primaryName: primary.name, additionalName: additional };
}

module.exports = { br1Section };
