const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir      : './tests',
  timeout      : 120_000,
  retries      : 1,
  workers      : 2,
  reporter     : [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
    ['./reporters/tcResultReporter.js'],
  ],
  use: {
    headless         : false,
    viewport         : { width: 1440, height: 900 },
    screenshot       : 'only-on-failure',
    video            : 'retain-on-failure',
    trace            : 'on-first-retry',
    actionTimeout    : 30_000,
    navigationTimeout: 60_000,
  },
  projects: [
    { name: 'FNOL - All LOBs',    testMatch: '**/FNOL/**/*.test.js',          use: { ...devices['Desktop Chrome'] } },
    { name: 'Financials',         testMatch: '**/Financials/**/*.test.js',     use: { ...devices['Desktop Chrome'] } },
    { name: 'Approval Routing',   testMatch: '**/ApprovalRouting/**/*.test.js',use: { ...devices['Desktop Chrome'] } },
    { name: 'Claim Lifecycle',    testMatch: '**/ClaimLifecycle.test.js',      use: { ...devices['Desktop Chrome'] } },
    { name: 'Smoke - All',        testMatch: '**/*.test.js', grep: /@smoke/,   use: { ...devices['Desktop Chrome'] } },
  ],
});
