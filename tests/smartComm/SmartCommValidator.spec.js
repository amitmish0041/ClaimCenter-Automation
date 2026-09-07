/**
 * tests/smartComm/SmartCommValidator.spec.js
 * SmartCOMM Template Validator — generic, data-driven. Reads
 * SMARTCOMM_TEMPLATE_ID from the environment (set by the Runner UI's
 * SmartCOMM tab), validates every scenario that matches that template's own
 * State/LOB applicability against the available test data, and emails the
 * aggregated report.
 *
 * Adding a template or a LOB/State scenario never touches this file.
 */
const { test, expect } = require('@playwright/test');
const { validateTemplate } = require('../../helpers/smartComm/validationService');
const { sendReport } = require('../../helpers/smartComm/reportService');

test.setTimeout(1_800_000);

test.describe('SmartCOMM Template Validator', () => {
  let page;
  let templateResult;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    if (templateResult) await sendReport(templateResult);
    await page.close();
  });

  test('Validate SmartCOMM template', async () => {
    const digNumber = process.env.SMARTCOMM_TEMPLATE_ID;
    expect(digNumber, 'SMARTCOMM_TEMPLATE_ID must be set').toBeTruthy();
    const recipientEmail = process.env.SMARTCOMM_EMAIL || 'amitmishra@donegalgroup.com';
    // Runner UI's optional "Claim #" field — set only when the user typed
    // one, so this claim is used directly instead of matching
    // fixtures/smartComm/testData.js by the template's LOB/State applicability.
    const claimNumberOverride = process.env.SMARTCOMM_CLAIM_NUMBER || undefined;

    templateResult = await validateTemplate(page, { digNumber, recipientEmail, claimNumberOverride });
    console.log(`[SmartComm] Overall: ${templateResult.overall} — ${templateResult.passed} passed / ${templateResult.failed} failed / ${templateResult.blocked} blocked${templateResult.errored ? ` / ${templateResult.errored} errored` : ''}`);

    for (const s of templateResult.scenarios || []) {
      await test.step(`${s.scenarioId} [${s.status}]`, async () => {
        if (s.status === 'FAIL') {
          const failures = s.validations.filter(v => v.result === 'FAIL').map(v => v.description).join('; ');
          expect(s.status, `Content validation failed: ${failures}`).not.toBe('FAIL');
        } else if (s.status === 'ERROR') {
          expect(s.status, s.reason || 'Automation error').not.toBe('ERROR');
        }
        // BLOCKED scenarios are reported but do not fail the Playwright test
        // itself — BLOCKED means "couldn't run", not "the document is wrong".
      });
    }

    expect(templateResult.overall, templateResult.reason || '').not.toBe('ERROR');
  });
});
