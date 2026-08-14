const { defineConfig, devices } = require('@playwright/test');

const chrome = { ...devices['Desktop Chrome'] };

module.exports = defineConfig({
  testDir      : './tests',
  // 4 min -> 20 min per test. FNOL now creates every incident the wizard offers
  // (vehicle, property damage, injury + body parts), which pushed the CA flow
  // past 10 minutes on its own. At 4 minutes a sweep was killing these tests
  // mid-flight and reporting them as failures rather than as the slow-but-
  // working runs they are. The LOB e2e specs override this to 30 min in-file;
  // this value governs everything else (FNOL, ApprovalRouting, ClaimLifecycle).
  timeout      : 1_200_000,
  retries      : 0,
  workers      : 2,
  reporter     : [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
    ['./reporters/tcResultReporter.js'],
    ['./reporters/emailReporter.js'],   // sends email when EMAIL_SMTP_HOST is set
  ],
  use: {
    headless         : false,
    viewport         : { width: 1440, height: 900 },
    screenshot       : 'only-on-failure',
    video            : 'retain-on-failure',
    trace            : 'on-first-retry',
    // 30s -> 15s. A click that fails because the element is HIDDEN (rather than
    // still rendering) can never succeed, so the whole timeout is dead time -
    // one hidden City trigger on the New Exposure screen burned 30s and failed
    // the FNOL. Actions here are always preceded by an .x-mask-hidden wait, so
    // the element is already settled and 15s stays generous. Raise this back if
    // a legitimately slow action starts timing out.
    actionTimeout    : 15_000,
    navigationTimeout: 60_000,
  },
  projects: [

    // ── Regression: feature-level projects (original) ──────────────────────────
    { name: 'FNOL - All LOBs',    testMatch: '**/FNOL/**/*.test.js',           use: { ...chrome } },
    { name: 'Financials',         testMatch: '**/Financials/**/*.test.js',      use: { ...chrome } },
    { name: 'Approval Routing',   testMatch: '**/ApprovalRouting/**/*.test.js', use: { ...chrome } },
    { name: 'Claim Lifecycle',    testMatch: '**/ClaimLifecycle.test.js',       use: { ...chrome } },
    { name: 'Smoke - All',        testMatch: '**/*.test.js', grep: /@smoke/,    use: { ...chrome } },

    // ── E2E: LOB-organized, full lifecycle per LOB ─────────────────────────────
    // Each file is a serial describe: FNOL → Financials → Approval → Lifecycle.
    // Run a single LOB: npm run e2e:pa  (or e2e:ho / e2e:wc / e2e:bop / e2e:cp / e2e:ca)
    // Run all LOBs:     npm run e2e:all
    { name: 'E2E - PA Auto',            testMatch: '**/lob/PA_Auto.e2e.test.js', use: { ...chrome } },
    { name: 'E2E - Homeowners',         testMatch: '**/lob/HO.e2e.test.js',      use: { ...chrome } },
    { name: 'E2E - Workers Comp',       testMatch: '**/lob/WC.e2e.test.js',      use: { ...chrome } },
    { name: 'E2E - BOP',                testMatch: '**/lob/BOP.e2e.test.js',     use: { ...chrome } },
    { name: 'E2E - Commercial Package', testMatch: '**/lob/CP.e2e.test.js',      use: { ...chrome } },
    { name: 'E2E - Commercial Auto',    testMatch: '**/lob/CA.e2e.test.js',      use: { ...chrome } },
    { name: 'E2E - All LOBs',           testMatch: '**/lob/*.e2e.test.js',       use: { ...chrome } },

    // Development harness: post-FNOL flow from an existing claim. Not part of
    // the regression set - needs CC_EXISTING_CLAIM.
    { name: 'Dev - Cloud Workflow',     testMatch: '**/cloud/CloudWorkflow.dev.test.js', use: { ...chrome } },
  ],
});
