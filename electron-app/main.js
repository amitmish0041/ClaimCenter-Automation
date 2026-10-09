// electron-app/main.js
//
// Main process: starts runner/server.js in-process (not spawned - only one
// process to manage for the server itself), opens a BrowserWindow pointed at
// it, and wires auto-update. Dev use (`npm run dev`) points straight at the
// live sibling repos so edits there show up on a restart with no rebuild;
// packaged use points at the staged copies electron-builder bundled as
// extraResources (see stage-resources.js + package.json's "build" config).
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');

const isPackaged = app.isPackaged;

// ── Resource roots ───────────────────────────────────────────────────────────
// Dev: the live repos, two levels up from this file (ClaimCenter-Automation/electron-app/ -> Playwright Projects/).
// Packaged: electron-builder's extraResources land directly under process.resourcesPath (see package.json).
const DEV_POLICY_DIR = path.join(__dirname, '..', '..', 'Commercial Line Performance test');
const DEV_CLAIMS_DIR = path.join(__dirname, '..');
const POLICY_DIR = isPackaged ? path.join(process.resourcesPath, 'policy-repo') : DEV_POLICY_DIR;
const CLAIMS_DIR_RESOURCE = isPackaged ? path.join(process.resourcesPath, 'ClaimCenter-Automation') : DEV_CLAIMS_DIR;
const BROWSERS_DIR = isPackaged ? path.join(process.resourcesPath, 'playwright-browsers') : null;

// server.js resolves CLAIMS_DIR itself as path.join(__dirname, '..', '..', 'ClaimCenter-Automation') (two
// levels up from runner/, then into a sibling folder of that name) - the packaged layout has to satisfy that
// same relative relationship, which is exactly what stage-resources.js's output does (policy-repo/ and
// ClaimCenter-Automation/ both land as direct siblings under resourcesPath). This constant exists only so a
// future layout change has one place to fix instead of re-deriving the relationship by hand.
void CLAIMS_DIR_RESOURCE;

const PORT = 3100; // fixed, not RUNNER_PORT - this is a packaged single-purpose app, not a shared dev server

// ── Per-install data dir (settings + entitlements cache survive updates) ────
const userDataDir = app.getPath('userData');
fs.mkdirSync(userDataDir, { recursive: true });

function configureEnvAndStartServer() {
  process.env.RUNNER_PORT = String(PORT);
  process.env.RUNNER_APP_VERSION = app.getVersion(); // shown in the UI so users/support know which build they're on
  if (isPackaged) {
    process.env.RUNNER_PACKAGED = '1';
    process.env.RUNNER_NODE_EXEC = process.execPath;
    process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_DIR;
    process.env.RUNNER_SETTINGS_FILE = path.join(userDataDir, 'settings.json');
    process.env.RUNNER_ENTITLEMENTS_CACHE = path.join(userDataDir, 'entitlements-cache.json');
    // Saved Azure (SmartCOMM Interactive) sign-in cookies are genuinely per-person - each QA signs into their
    // own Microsoft account - so this stays in userData (survives updates; the install dir doesn't).
    process.env.SMARTCOMM_AZURE_SESSION_FILE = path.join(userDataDir, 'smartcomm-azure-session.json');
    // S3 (Okta) sign-in is SHARED across the team, not per-person. Not everyone has S3/Okta access, and we
    // don't want anyone depending on the owner's machine being on - so the owner signs in ONCE ("Establish S3
    // Session"), which writes the cookies to a shared file on the team drive, and every installed copy just
    // READS them from there (SMARTCOMM_OKTA_SESSION_READONLY: automated runs never sign in or overwrite it -
    // see helpers/s3Download/s3AdminService.js). When the shared session lapses, only the owner re-runs that
    // one step; nobody else is blocked meanwhile beyond a clear "ask the owner to refresh" message. The path
    // is overridable with a real SMARTCOMM_OKTA_SESSION_FILE env var if a machine maps the share elsewhere.
    process.env.SMARTCOMM_OKTA_SESSION_FILE = process.env.SMARTCOMM_OKTA_SESSION_FILE
      || path.join('V:', 'Amit Int', 'SmartComm', 'smartcomm-okta-session.json');
    process.env.SMARTCOMM_OKTA_SESSION_READONLY = '1';
    process.env.SMARTCOMM_OKTA_SESSION_OWNER = 'Amit Mishra (amitmishra@donegalgroup.com)';
    // Team-wide usage log for the Stats tab - one shared file on the team drive that every installed copy
    // appends its runs to (see runner/server.js recordUsage/readUsage). Same V: dependency as the shared session.
    process.env.RUNNER_USAGE_LOG = path.join('V:', 'Amit Int', 'SmartComm', 'usage.jsonl');
    // Bundled copy of the BA/QA-maintained SmartCOMM template spreadsheet + .docx files (see
    // stage-resources.js) - works out of the box with no per-user folder to track down. server.js's own
    // settings-loading (runner-settings.json, written by the Settings tab) still overrides this afterwards
    // if a user explicitly points at a different/newer copy, since that only runs when a value was actually
    // saved there.
    const bundledSmartCommData = path.join(process.resourcesPath, 'smartcomm-data');
    if (fs.existsSync(bundledSmartCommData)) process.env.SMARTCOMM_DATA_DIR = bundledSmartCommData;
    // Donegal's internal mail relay. Not secrets (unauthenticated relay, already in ClaimCenter-Automation's
    // committed .env.example) - but that .env is never bundled, and without these every SmartCOMM report
    // silently skips emailing (reportService.js no-ops when EMAIL_SMTP_HOST is unset). Recipient (EMAIL_TO)
    // is set per run by server.js from the Report Email field, so it isn't defaulted here.
    process.env.EMAIL_SMTP_HOST ||= 'smtp.donegalgroup.com';
    process.env.EMAIL_SMTP_PORT ||= '25';
    process.env.EMAIL_FROM ||= 'automation@donegalgroup.com';
  }
  // Starting this is a side effect of requiring it (it calls app.listen() at module scope) - see
  // runner/server.js's own bottom-of-file app.listen() call.
  require(path.join(POLICY_DIR, 'runner', 'server.js'));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'ClaimCenter Runner',
    webPreferences: {
      // The page only ever talks to our own localhost Express server via fetch/EventSource, exactly like a
      // normal browser tab would - it has no need for Node/Electron API access, so none is exposed.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.loadURL(`http://127.0.0.1:${PORT}`);

  // mailto: (the "Request access" link) and any other external link open in the OS's own handler instead of
  // navigating this window or spawning a chromeless child BrowserWindow.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== `http://127.0.0.1:${PORT}`) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  return win;
}

// ── Auto-update ──────────────────────────────────────────────────────────────
// Only meaningful in a packaged build - electron-updater's GitHub provider needs a real signed/published
// release to compare against, which a dev run (`npm run dev`, unpackaged) never has.
function setupAutoUpdate(win) {
  if (!isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      title: 'Update ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'Restart now to apply it, or it will install automatically the next time you quit.',
    }).then((result) => {
      if (result.response === 0) autoUpdater.quitAndInstall();
    });
  });
  autoUpdater.on('error', (err) => {
    console.error('Auto-update check failed (continuing on current version):', err.message);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Auto-update check failed (continuing on current version):', err.message);
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // internal tool - no File/Edit/View menu bar needed
  configureEnvAndStartServer();
  const win = createWindow();
  setupAutoUpdate(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
