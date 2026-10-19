// Local test-runner server for the Playwright suites in this repo, the
// sibling ClaimCenter-Automation repo, and the sibling cc-migration-
// reconciliation project. Serves runner/index.html and exposes:
//   GET  /api/config          - LOB / state / env / tier catalogs the UI renders from
//   GET  /api/stream          - SSE channel: live output + job/queue status
//   POST /api/run             - enqueue one or more jobs (policy / claims / reconciliation / updateValidation / pdfCompare / smartComm / jiraReport)
//   POST /api/stop            - kill the running job and clear the queue
//   POST /api/recon/upload    - save a bulk claims file (.csv/.xlsx) for a reconciliation job
//   POST /api/jiraReport/tracks       - add a custom Jira query as a new track
//   DELETE /api/jiraReport/tracks/:key - remove a custom Jira query track
//   GET  /reports/recon/*     - the reconciliation project's generated reports (static)
//   GET  /reports/pdf-compare/* - PDF Compare's generated Excel reports (static)
//   GET  /reports/jira/*      - the Jira Sprint Report's generated Excel workbook (static)
//
// Start with:  node runner/server.js   (from this project root, or anywhere)
'use strict';

const path = require('path');
const fs = require('fs');
// Anchored at this repo's root (not process.cwd()) - when this server runs
// from inside the packaged Electron app, cwd is unpredictable, but __dirname
// still resolves correctly since the file itself is still at runner/server.js
// wherever it's bundled. dotenv never overwrites an already-set process.env
// value, so anything electron-app/main.js sets before requiring this file
// (packaged settings, see "Packaged runtime" below) still wins.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const { spawn, exec } = require('child_process');
const { ENV_URLS } = require('../helpers/envConfig');

// ── Packaged runtime (electron-app) ─────────────────────────────────────────
// electron-app/main.js sets RUNNER_PACKAGED=1 and RUNNER_NODE_EXEC (its own
// process.execPath, run with ELECTRON_RUN_AS_NODE=1 - the standard way to use
// Electron's bundled Node as a drop-in replacement for a system Node install)
// before require()-ing this file in-process. Plain `node runner/server.js`
// dev use never sets these, so every job below falls through to today's bare
// npx/node - nothing changes for normal dev use.
const PACKAGED = process.env.RUNNER_PACKAGED === '1';
const BUNDLED_NODE_EXEC = process.env.RUNNER_NODE_EXEC || process.execPath;
const PACKAGED_NODE_OPTIONS = [process.env.NODE_OPTIONS, '--experimental-require-module', '--disable-warning=ExperimentalWarning']
  .filter(Boolean).join(' ');
// Suites that need a 3rd sibling repo (cc-migration-reconciliation) or a
// bundled Python runtime - deferred to a later release; see buildReconJob/
// buildUpdateValidationJob/buildPdfCompareJob's own PACKAGED guards below.
const PACKAGED_UNAVAILABLE_SUITES = ['reconciliation', 'updateValidation', 'pdfCompare'];

// ── Tab-level entitlements ───────────────────────────────────────────────────
// Gates which tabs a packaged install may use, independent of PACKAGED_UNAVAILABLE_SUITES
// above (that's "not built yet for anyone"; this is "built, but needs approval for you").
// In plain dev use (this repo, run directly) everything stays open - the entitlements
// file only ever narrows a PACKAGED build, see allowedSuitesFor() below.
const ENTITLEMENTS_URL = process.env.RUNNER_ENTITLEMENTS_URL
  || 'https://raw.githubusercontent.com/amitmish0041/ClaimCenter-Automation/main/electron-app/entitlements/entitlements.json';
// electron-app/main.js points this at app.getPath('userData') so a grant
// survives app updates/restarts even if a later fetch fails (offline, GitHub
// unreachable, etc.) - falls back to this repo's own runtime-data folder so
// plain `node runner/server.js` dev use still has somewhere to cache to.
const ENTITLEMENTS_CACHE_FILE = process.env.RUNNER_ENTITLEMENTS_CACHE
  || path.join(__dirname, '..', 'runtime-data', 'entitlements-cache.json');
const ENTITLEMENTS_POLL_MS = 15 * 60 * 1000;
let entitlementsCache = { default: ['smartComm'], grants: {} };

function loadCachedEntitlements() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ENTITLEMENTS_CACHE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') entitlementsCache = parsed;
  } catch (e) { /* no cache yet, or unreadable - keep the smartComm-only default */ }
}

async function refreshEntitlements() {
  try {
    const resp = await fetch(ENTITLEMENTS_URL, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const parsed = await resp.json();
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.default)) {
      throw new Error('Malformed entitlements.json');
    }
    entitlementsCache = parsed;
    fs.mkdirSync(path.dirname(ENTITLEMENTS_CACHE_FILE), { recursive: true });
    fs.writeFileSync(ENTITLEMENTS_CACHE_FILE, JSON.stringify(parsed, null, 2));
  } catch (e) {
    console.error('Entitlements refresh failed (keeping last-known-good copy):', e.message);
  }
}

// Not gated at all outside a packaged build - this repo's own dev/shared-server
// use predates entitlements entirely and every suite already in production use
// there shouldn't suddenly need an approval step.
function allowedSuitesFor(email) {
  if (!PACKAGED) return SUITES.slice();
  if (isAdmin(email)) return SUITES.slice(); // an admin can use every tool (they manage access, after all)
  // activeEntitlements() prefers the admin-set config on V: (live), falling back to the GitHub-sourced cache -
  // read here rather than mutating entitlementsCache, so the async GitHub refresh can't clobber an admin's grants.
  const ent = activeEntitlements();
  const key = String(email || '').trim().toLowerCase();
  const granted = (key && ent.grants && ent.grants[key]) || ent.default || ['smartComm'];
  // smartComm is always on, regardless of what the entitlements file says -
  // it's the one tool every packaged install should be able to use out of
  // the box per the original ask, so a malformed/missing entitlements file
  // can never accidentally lock out the one thing that must always work.
  // Matches the SUITES/pools casing (camelCase, see SUITES below) - confirmed live that an entitlements
  // default of lowercase 'smartcomm' never actually matched the real suite key 'smartComm' anywhere it was
  // compared against, silently defeating the entire "on by default" guarantee this function exists to give.
  return Array.from(new Set([...granted, 'smartComm']));
}

// This runner can be used by anyone, but its maintainer should always get a copy of every emailed report,
// regardless of whose address was typed into the UI's own "Report Email" field — added 2026-10-02 per user
// request. Every report sender here (nodemailer's `to`) already accepts a comma-separated address list, so
// this just appends the owner's address instead of needing a separate CC mechanism.
// `let` (not const) so an admin can change the owner/CC address from the Admin tab (see applyAdminConfig).
let ALWAYS_CC_EMAIL = 'amitmishra@donegalgroup.com';
// Identifies who is submitting/stopping a run, so this shared, single-server tool can let a second,
// different person in alongside whoever is already running something (see SUITE_MAX_PARALLEL below) and show
// everyone who currently holds a session — added 2026-10-05 per user request ("tool can only be used by
// one person at a time"). Same shape as the reportEmail checks already scattered through the job builders.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function withAlwaysCc(email) {
  const typed = String(email || '').trim();
  if (!typed) return ALWAYS_CC_EMAIL;
  if (typed.toLowerCase() === ALWAYS_CC_EMAIL.toLowerCase()) return typed;
  return `${typed},${ALWAYS_CC_EMAIL}`;
}

// ── Admin config (shared on the team drive, edited in-app by an admin) ───────
// ONE shared file on V: (RUNNER_ADMIN_CONFIG, set by electron-app/main.js) holding everything an admin can
// change without a rebuild: who's an admin, tab access (entitlements), environment URLs, the mail relay, and
// S3 settings. Read by every installed copy; written only by the Admin tab. Entirely OPTIONAL and
// backward-compatible: if the file is absent/unreadable (no V:, offline, not set up yet), NOTHING changes -
// entitlements still come from GitHub, URLs from helpers/envConfig.js, SMTP/S3 from their env defaults. Each
// field below is applied only when the admin actually set it, so a partial config never blanks a working value.
const ADMIN_CONFIG_FILE = process.env.RUNNER_ADMIN_CONFIG
  || path.join(__dirname, '..', 'runtime-data', 'admin-config.json');
const ADMIN_CONFIG_POLL_MS = 2 * 60 * 1000;
let adminConfig = {};

function applyAdminConfig() {
  if (adminConfig.ownerEmail) ALWAYS_CC_EMAIL = String(adminConfig.ownerEmail).trim();
  // Entitlements are NOT copied into entitlementsCache here - allowedSuitesFor reads them live via
  // activeEntitlements() so the async GitHub refresh (refreshEntitlements) can never overwrite an admin's grants.
  // Environment URLs: overlay only the keys the admin actually set onto helpers/envConfig.js's defaults.
  if (adminConfig.environmentUrls && typeof adminConfig.environmentUrls === 'object') {
    for (const k of Object.keys(adminConfig.environmentUrls)) {
      const v = adminConfig.environmentUrls[k];
      // Each env is an object { writeBizUrl, policyCenterUrl } - merge so a partial override keeps the other URL,
      // and a stray string never clobbers the object shape buildPolicyJob depends on.
      if (v && typeof v === 'object') ENV_URLS[k] = Object.assign({}, ENV_URLS[k], v);
    }
  }
  // SMTP + S3: set the env vars spawned jobs inherit, only when a value was provided.
  const smtp = adminConfig.smtp || {};
  if (smtp.host) process.env.EMAIL_SMTP_HOST = String(smtp.host);
  if (smtp.port) process.env.EMAIL_SMTP_PORT = String(smtp.port);
  if (smtp.from) process.env.EMAIL_FROM = String(smtp.from);
  const s3 = adminConfig.s3 || {};
  if (s3.adminUrl) process.env.SMARTCOMM_S3_ADMIN_URL = String(s3.adminUrl);
  if (s3.loginEmail) process.env.SMARTCOMM_OKTA_LOGIN_EMAIL = String(s3.loginEmail);
  if (s3.sessionOwner) process.env.SMARTCOMM_OKTA_SESSION_OWNER = String(s3.sessionOwner);
}

function loadAdminConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') { adminConfig = parsed; applyAdminConfig(); }
  } catch (e) { /* no admin-config yet, or drive unreachable - keep every current default */ }
}

function adminEmails() {
  const list = (adminConfig.adminEmails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean);
  return list.length ? list : [ALWAYS_CC_EMAIL.toLowerCase()];
}
function isAdmin(email) {
  return adminEmails().includes(String(email || '').trim().toLowerCase());
}
// Tab access comes from the admin-set config on V: when present (live, authoritative), else the GitHub-sourced
// cache - read by allowedSuitesFor on every check so no async refresh can clobber an admin's grants.
function activeEntitlements() {
  if (adminConfig.entitlements && Array.isArray(adminConfig.entitlements.default)) return adminConfig.entitlements;
  return entitlementsCache;
}

const POLICY_DIR = path.join(__dirname, '..');
const CLAIMS_DIR = path.join(__dirname, '..', '..', 'ClaimCenter-Automation');
const RECON_DIR = path.join(__dirname, '..', '..', 'cc-migration-reconciliation');
const RECON_UPLOADS_DIR = path.join(RECON_DIR, 'data', 'uploads');
const RECON_REPORTS_DIR = path.join(RECON_DIR, 'reports');
const PDF_COMPARE_SCRIPT = path.join(POLICY_DIR, 'tools', 'pdf-compare', 'compare_insurance_pdfs.py');
const PDF_COMPARE_REPORTS_DIR = path.join(POLICY_DIR, 'reports', 'pdf-compare');
const JIRA_REPORT_SCRIPT = path.join(POLICY_DIR, 'scripts', 'jiraReport.js');
const JIRA_STATUS_DECK_SCRIPT = path.join(POLICY_DIR, 'scripts', 'jiraStatusDeck.js');
const JIRA_REPORTS_DIR = path.join(POLICY_DIR, 'reports', 'jira');
const CC_UI_REPORTS_DIR = path.join(CLAIMS_DIR, 'results', 'ccUi');
const S3_DOWNLOAD_SCRIPT = path.join(CLAIMS_DIR, 'scripts', 'downloadSmartCommFile.js');
const S3_DOWNLOADS_DIR = path.join(CLAIMS_DIR, 'results', 's3Downloads');
const S3_ESTABLISH_SESSION_SCRIPT = path.join(CLAIMS_DIR, 'scripts', 'establishS3Session.js');
// S3 defaults come from the helper itself (s3AdminService.js), so the Admin tab pre-fills the real values an
// admin can then tweak - no second copy to drift. Requiring it is side-effect-free (consts + functions only).
let S3_HELPER_DEFAULTS = { adminUrl: '', loginEmail: '' };
try {
  const _s3svc = require(path.join(CLAIMS_DIR, 'helpers', 's3Download', 's3AdminService'));
  S3_HELPER_DEFAULTS = { adminUrl: _s3svc.S3_ADMIN_URL || '', loginEmail: _s3svc.LOGIN_EMAIL || '' };
} catch (e) { /* helper not reachable in some dev layouts - the Admin tab just shows blank S3 then */ }
// Mirrors scripts/jiraReport.js's ALL_TRACK_KEYS/TRACK_DEFS - kept as a
// separate literal (not required in) so this server has zero dependency on
// exceljs/axios just to render the tab's chip labels.
const JIRA_TRACKS = {
  Enhancement: { label: 'Enhancement' },
  ClaimCenter: { label: 'ClaimCenter' },
  SmartComm: { label: 'SmartComm' },
  NautilusOther: { label: 'Nautilus/Other Projects' },
};
// Donegal's Jira Cloud site - not a secret (it's in .env.example). Used whenever neither Settings nor .env sets
// JIRA_SITE, so an installed copy only needs each person's own Jira email + API token (Settings tab).
const DEFAULT_JIRA_SITE = 'donegalgroup.atlassian.net';
function jiraConfigured() {
  return Boolean(process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}
// "https://donegalgroup.atlassian.net/jira/..." -> "donegalgroup.atlassian.net" - jiraReport.js builds
// "https://${JIRA_SITE}/rest/..." itself, so a pasted browser URL would otherwise break every request.
function normalizeJiraSite(site) {
  return String(site || '').trim().replace(/^https?:\/\//i, '').replace(/[\/?#].*$/, '');
}
// User-added queries (runner's "Add a new query" form) - same file
// scripts/jiraReport.js reads at fetch time, so a track added here is
// immediately usable in a run with no server restart needed.
const CUSTOM_TRACKS_FILE = path.join(POLICY_DIR, 'scripts', 'jiraTracks.custom.json');
const PORT = process.env.RUNNER_PORT || 3000;

function loadCustomTracks() {
  try {
    const list = JSON.parse(fs.readFileSync(CUSTOM_TRACKS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function saveCustomTracks(list) {
  fs.writeFileSync(CUSTOM_TRACKS_FILE, JSON.stringify(list, null, 2) + '\n');
}

// Every track key/chart-visible label the UI and jiraReport.js can currently
// select from - built-ins first, then whatever's in the custom file, read
// fresh each call so an add/remove shows up without a restart.
function getAllJiraTracks() {
  const tracks = {};
  Object.keys(JIRA_TRACKS).forEach((k) => { tracks[k] = { label: JIRA_TRACKS[k].label, custom: false }; });
  loadCustomTracks().forEach((c) => { tracks[c.key] = { label: c.label, custom: true, jql: c.jql, filterDoneRetired: Boolean(c.filterDoneRetired) }; });
  return tracks;
}

// Excel sheet names: <=31 chars, no \ / ? * [ ] : - and keeping the 3
// existing reserved sheet names free avoids a custom track silently
// colliding with the Data/Summary sheets jiraReport.js always writes.
const RESERVED_SHEET_NAMES = new Set(['Data', 'Summary - By Track-Sprint', 'Summary - By Assignee']);
function sanitizeSheetName(label) {
  return String(label).replace(/[\\/?*[\]:]/g, '-').trim().slice(0, 31) || 'Track';
}
function sanitizeTrackKey(label) {
  const key = String(label).replace(/[^A-Za-z0-9]/g, '');
  return key || 'Track' + Date.now();
}

fs.mkdirSync(RECON_UPLOADS_DIR, { recursive: true });
fs.mkdirSync(PDF_COMPARE_REPORTS_DIR, { recursive: true });
fs.mkdirSync(JIRA_REPORTS_DIR, { recursive: true });
fs.mkdirSync(CC_UI_REPORTS_DIR, { recursive: true });
fs.mkdirSync(S3_DOWNLOADS_DIR, { recursive: true });

loadCachedEntitlements();
refreshEntitlements(); // fire-and-forget on boot, don't delay server startup on a slow/offline GitHub fetch
setInterval(refreshEntitlements, ENTITLEMENTS_POLL_MS);
// Shared admin config (V:) is applied AFTER the GitHub entitlements above, so an admin's in-app changes win.
// Re-read on a timer so one admin's grant/revoke reaches everyone else without an app restart.
loadAdminConfig();
setInterval(loadAdminConfig, ADMIN_CONFIG_POLL_MS);

// ── Per-install settings (packaged build only - Settings tab in index.html) ─
// Persisted name/email/SmartCOMM data dir/credentials for a standalone install. A packaged build never
// ships either repo's .env (stage-resources.js excludes it so no secret is ever baked into the installer),
// so this is the ONLY place an installed copy gets its ClaimCenter/WriteBiz logins from. electron-app/
// main.js points RUNNER_SETTINGS_FILE at app.getPath('userData'); falls back to runtime-data/ for dev use.
const SETTINGS_FILE = process.env.RUNNER_SETTINGS_FILE
  || path.join(__dirname, '..', 'runtime-data', 'runner-settings.json');

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) { return {}; }
}

// Settings field -> the env var every spawned job inherits it as (spawn's env starts from process.env).
// `secret` fields are stored byte-for-byte (a leading/trailing space is a legal password character);
// everything else is trimmed.
const SETTINGS_ENV_FIELDS = [
  { field: 'smartCommDataDir', env: 'SMARTCOMM_DATA_DIR' },
  { field: 'ccUser', env: 'CC_USER' },
  { field: 'ccPass', env: 'CC_PASS', secret: true },
  { field: 'ccAdminUser', env: 'CC_ADMIN_USER' },
  { field: 'ccAdminPass', env: 'CC_ADMIN_PASS', secret: true },
  ...['DE', 'PA', 'MI', 'WI'].flatMap((st) => [
    { field: `wbUser${st}`, env: `WB_USER_${st}` },
    { field: `wbPass${st}`, env: `WB_PASS_${st}`, secret: true },
  ]),
  // Jira Report tab (scripts/jiraReport.js) - each person's OWN Atlassian login; site falls back to DEFAULT_JIRA_SITE.
  { field: 'jiraSite', env: 'JIRA_SITE' },
  { field: 'jiraEmail', env: 'JIRA_EMAIL' },
  { field: 'jiraApiToken', env: 'JIRA_API_TOKEN', secret: true },
];

// Whatever each var was BEFORE Settings touched it - this repo's own .env in dev use, electron-app/main.js's
// bundled SmartCOMM data path in a packaged build, or nothing. A blank Settings field restores this rather
// than deleting outright, so saving the form just to change your email can never wipe a value a dev
// machine's own .env was already providing.
const ENV_BASELINE = {};
SETTINGS_ENV_FIELDS.forEach(({ env }) => { ENV_BASELINE[env] = process.env[env]; });

function applySettingsToEnv(settings) {
  for (const { field, env } of SETTINGS_ENV_FIELDS) {
    if (settings[field]) process.env[env] = settings[field];
    else if (ENV_BASELINE[env] === undefined) delete process.env[env];
    else process.env[env] = ENV_BASELINE[env];
  }
}

// Once at boot (so a restart remembers last session's settings), again on every POST /api/settings below.
applySettingsToEnv(loadSettings());

// ── Usage tracking (team-wide, via a shared append-only log) ────────────────
// Every accepted run appends one JSON line here; the Stats tab reads + aggregates it. A packaged build points
// RUNNER_USAGE_LOG at the shared V: drive (see electron-app/main.js) so ONE file collects everyone's runs -
// no backend, no token. Append-only, one line per run, so concurrent writers from different machines don't
// corrupt each other. Best-effort on both ends: a logging failure (drive down, lock) must NEVER block a run,
// and an unreadable/missing log just reads as "no data yet".
const USAGE_LOG_FILE = process.env.RUNNER_USAGE_LOG
  || path.join(__dirname, '..', 'runtime-data', 'usage.jsonl');

function recordUsage(rec) {
  try {
    fs.mkdirSync(path.dirname(USAGE_LOG_FILE), { recursive: true });
    fs.appendFileSync(USAGE_LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  } catch (e) { /* never let usage logging break a run */ }
}

function readUsage() {
  try {
    return fs.readFileSync(USAGE_LOG_FILE, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

// ── Catalogs (single source of truth - the UI just renders these) ──────────

// LOB -> spec file, mirrors runners/run-states.ps1's $testFile switch.
const POLICY_LOB = {
  BOP:     { label: 'BOP',          file: 'Create_BOP.test.js' },
  PACKAGE: { label: 'Package (CP)', file: 'Create_Package.test.js' },
  CA:      { label: 'CA',           file: 'Create_CA.test.js' },
};
const POLICY_STATES = ['DE', 'WI', 'PA', 'MI'];
// Shown in this order regardless of which are wired up yet; the UI greys out
// any key missing from helpers/envConfig.js's ENV_URLS so a click can never
// silently run against the wrong URL (getEnvUrls() falls back to qa).
const POLICY_ENV_ORDER = ['test', 'qa', 'dev', 'training', 'perf'];

// LOB -> ClaimCenter project name (playwright.config.js) + the env var
// getNextPolicy() reads for that LOB (see helpers/claimCenterBase.js and
// tests/lob/*.e2e.test.js, all currently hardcoded to the _PA policy var).
const CLAIMS_LOB = {
  BOP:     { label: 'BOP',          project: 'E2E - BOP',                policyVar: 'POLICY_BOP_PA' },
  PACKAGE: { label: 'Package (CP)', project: 'E2E - Commercial Package', policyVar: 'POLICY_CP_PA' },
  CA:      { label: 'CA',           project: 'E2E - Commercial Auto',    policyVar: 'POLICY_CAU_PA' },
};
const CLAIMS_PLATFORMS = ['onprem', 'cloud']; // CC_ENV
const CLAIMS_TIERS = ['test', 'dev'];         // CC_TIER

// Migration-reconciliation tier options — same CC_TIER axis as the claims
// suite, but a separate constant since the two projects' tier support can
// (and currently does — see cc-migration-reconciliation's own README) drift
// independently, e.g. one tier being temporarily down on one side.
const RECON_TIERS = ['test', 'dev'];

// SmartCOMM Template Validator — cloud only (see ClaimCenter-Automation's
// helpers/smartComm/); DEV/TEST/QA are cloud instance tiers, a different
// axis from claims' onprem/cloud split above. "qa" needs CC_BASE_URL_CLOUD_QA
// set in that repo's .env before it'll hit the right instance — same
// unenforced convention the claims suite's own tiers already rely on
// (claimCenterBase.js falls back silently if a tier's URL isn't set, it
// doesn't hard-fail), not a new gap introduced here.
const SMARTCOMM_TIERS = ['dev', 'test', 'qa'];
const SMARTCOMM_CATALOG_PATH = path.join(CLAIMS_DIR, 'helpers', 'smartComm', 'catalogService.js');

// The template list lives in Claims_Documents_Index.xlsx (BA/QA-maintained),
// read fresh on every /api/config call so an edit to that spreadsheet shows
// up without restarting this server — this repo never copies its rows in.
function getSmartCommTemplates() {
  try {
    const catalogService = require(SMARTCOMM_CATALOG_PATH);
    return catalogService.loadTemplateCatalog({ refresh: true })
      .map((t) => ({ digNumber: t.digNumber, documentName: t.documentName, states: t.states, lob: t.lob, interactiveOrOnDemand: t.interactiveOrOnDemand }));
  } catch (e) {
    console.error('SmartCOMM catalog unavailable:', e.message);
    return [];
  }
}

// Data Update & Dropdown Validation — a DIFFERENT test from reconciliation:
// it opens Edit on every section, compares dropdown option lists, and
// ALWAYS clicks Update to confirm old claim data still saves cleanly. It
// WRITES to whatever claims it's pointed at. Same tier axis as reconciliation.
const UPDATE_VALIDATION_TIERS = ['test', 'dev'];

const app = express();
app.use(express.json({ limit: '15mb' })); // bulk claims-file uploads travel as base64 JSON — see /api/recon/upload

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Generated reports (HTML/XLSX/JSON/CSV) served read-only so the UI can link straight to them after a run.
app.use('/reports/recon', express.static(RECON_REPORTS_DIR));
app.use('/reports/pdf-compare', express.static(PDF_COMPARE_REPORTS_DIR));
app.use('/reports/jira', express.static(JIRA_REPORTS_DIR));
app.use('/reports/cc-ui', express.static(CC_UI_REPORTS_DIR));
app.use('/reports/s3-download', express.static(S3_DOWNLOADS_DIR));

app.get('/api/config', (req, res) => {
  res.json({
    packagedBuild: PACKAGED,
    appVersion: process.env.RUNNER_APP_VERSION || '',
    comingSoonSuites: PACKAGED ? PACKAGED_UNAVAILABLE_SUITES : [],
    settings: loadSettings(),
    policy: {
      lobs: POLICY_LOB,
      states: POLICY_STATES,
      envs: POLICY_ENV_ORDER.map((key) => ({ key, configured: Boolean(ENV_URLS[key]) })),
    },
    claims: {
      lobs: CLAIMS_LOB,
      platforms: CLAIMS_PLATFORMS,
      tiers: CLAIMS_TIERS,
    },
    reconciliation: {
      tiers: RECON_TIERS,
    },
    updateValidation: {
      tiers: UPDATE_VALIDATION_TIERS,
    },
    smartComm: {
      templates: getSmartCommTemplates(),
      tiers: SMARTCOMM_TIERS,
    },
    pdfCompare: {
      scriptFound: fs.existsSync(PDF_COMPARE_SCRIPT),
    },
    jiraReport: {
      configured: jiraConfigured(),
      defaultSite: DEFAULT_JIRA_SITE,
      tracks: getAllJiraTracks(),
    },
  });
});

// ── Per-install settings (packaged build's Settings tab) ────────────────────
app.post('/api/settings', (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: `"${email}" doesn't look like a valid email address` });
  const settings = { name, email };
  for (const { field, secret } of SETTINGS_ENV_FIELDS) {
    const raw = String(body[field] || '');
    settings[field] = secret ? raw : raw.trim();
  }
  const dataDir = settings.smartCommDataDir;
  if (dataDir && (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory())) {
    return res.status(400).json({ error: `Folder does not exist: ${dataDir}` });
  }
  settings.jiraSite = normalizeJiraSite(settings.jiraSite);
  settings.jiraEmail = settings.jiraEmail.toLowerCase();
  if (settings.jiraEmail && !EMAIL_RE.test(settings.jiraEmail)) {
    return res.status(400).json({ error: `Jira email "${settings.jiraEmail}" doesn't look like a valid email address` });
  }
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    return res.status(500).json({ error: `Failed to save settings: ${e.message}` });
  }
  const dataDirChanged = (process.env.SMARTCOMM_DATA_DIR || '') !== (dataDir || ENV_BASELINE.SMARTCOMM_DATA_DIR || '');
  applySettingsToEnv(settings);
  // catalogService.js reads SMARTCOMM_DATA_DIR into a module-level const on first require, so a changed
  // folder only reaches the in-app template list if that cached module is dropped - spawned validation
  // runs are fresh processes and pick the new value up on their own either way.
  if (dataDirChanged) delete require.cache[require.resolve(SMARTCOMM_CATALOG_PATH)];
  res.json({ ok: true, jiraReportConfigured: jiraConfigured() });
});

// ── Tab-level entitlements (packaged build only) ─────────────────────────────
// Read-only - approvals happen by editing entitlements.json on GitHub, not
// through this app. `allowed` always includes smartComm; `comingSoon` is the
// separate, always-locked-for-now list from PACKAGED_UNAVAILABLE_SUITES.
app.get('/api/entitlements', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  res.json({
    packagedBuild: PACKAGED,
    allowed: allowedSuitesFor(email),
    comingSoon: PACKAGED ? PACKAGED_UNAVAILABLE_SUITES : [],
    ownerEmail: ALWAYS_CC_EMAIL,
    admin: isAdmin(email), // UI shows the Admin tab only when this is true
  });
});

// ── Admin console (admin-only): read/write the shared admin config on V: ─────
// All tools (keys) the Admin tab can grant/revoke, with friendly labels for the UI.
const SUITE_LABELS = {
  policy: 'Policy Tests', claims: 'Claims (ClaimCenter)', smartComm: 'SmartCOMM Validator',
  jiraReport: 'Jira Sprint Report', reconciliation: 'Migration Reconciliation',
  updateValidation: 'Data Update & Dropdown Validation', pdfCompare: 'PDF Compare',
};
app.get('/api/admin', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!isAdmin(email)) return res.status(403).json({ error: 'Admin access only.' });
  res.json({
    isAdmin: true,
    configFile: ADMIN_CONFIG_FILE,
    suites: SUITES.map((k) => ({ key: k, label: SUITE_LABELS[k] || k })),
    config: {
      ownerEmail: adminConfig.ownerEmail || ALWAYS_CC_EMAIL,
      adminEmails: adminConfig.adminEmails && adminConfig.adminEmails.length ? adminConfig.adminEmails : adminEmails(),
      entitlements: adminConfig.entitlements || { default: entitlementsCache.default, grants: entitlementsCache.grants || {} },
      environmentUrls: Object.keys(ENV_URLS).reduce((o, k) => { o[k] = Object.assign({}, ENV_URLS[k]); return o; }, {}),
      smtp: adminConfig.smtp || { host: process.env.EMAIL_SMTP_HOST || 'smtp.donegalgroup.com', port: process.env.EMAIL_SMTP_PORT || '25', from: process.env.EMAIL_FROM || 'automation@donegalgroup.com' },
      s3: adminConfig.s3 || { adminUrl: process.env.SMARTCOMM_S3_ADMIN_URL || S3_HELPER_DEFAULTS.adminUrl, loginEmail: process.env.SMARTCOMM_OKTA_LOGIN_EMAIL || S3_HELPER_DEFAULTS.loginEmail, sessionOwner: process.env.SMARTCOMM_OKTA_SESSION_OWNER || 'Amit Mishra (amitmishra@donegalgroup.com)' },
    },
  });
});
app.post('/api/admin', (req, res) => {
  const body = req.body || {};
  const email = String(body.requestedBy || '').trim().toLowerCase();
  if (!isAdmin(email)) return res.status(403).json({ error: 'Admin access only.' });
  const next = body.config || {};
  const cfg = {
    ownerEmail: (next.ownerEmail && String(next.ownerEmail).trim()) || adminConfig.ownerEmail || ALWAYS_CC_EMAIL,
    adminEmails: Array.isArray(next.adminEmails) ? next.adminEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean) : adminEmails(),
    entitlements: (next.entitlements && Array.isArray(next.entitlements.default))
      ? { default: next.entitlements.default, grants: next.entitlements.grants || {} }
      : (adminConfig.entitlements || { default: entitlementsCache.default, grants: entitlementsCache.grants || {} }),
    environmentUrls: (next.environmentUrls && typeof next.environmentUrls === 'object') ? next.environmentUrls : (adminConfig.environmentUrls || {}),
    smtp: next.smtp || adminConfig.smtp || {},
    s3: next.s3 || adminConfig.s3 || {},
  };
  // Never let an admin lock themselves out - the person saving stays an admin.
  if (!cfg.adminEmails.includes(email)) cfg.adminEmails.push(email);
  try {
    fs.mkdirSync(path.dirname(ADMIN_CONFIG_FILE), { recursive: true });
    const tmp = ADMIN_CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, ADMIN_CONFIG_FILE);
  } catch (e) {
    return res.status(500).json({ error: `Could not save admin config (is the team drive reachable?): ${e.message}` });
  }
  adminConfig = cfg;
  applyAdminConfig();
  res.json({ ok: true });
});

// ── Jira Sprint Report: manage custom queries ───────────────────────────────
// Lets the UI add a brand-new JQL-backed track without touching code - it
// gets appended to scripts/jiraTracks.custom.json (jiraReport.js reads that
// file at fetch time, so no restart needed) and immediately shows up as a
// new chip on the tab. Built-in tracks (Enhancement/ClaimCenter/SmartComm/
// NautilusOther) live only in code and can't be added/removed here.
// Weekly blocker / dependency notes for the Sprint status deck (scripts/statusNotes.js): the Jira tab sends the
// table pasted from the QA lead's status email (as rows of cells when it was an HTML table, else plain text).
app.get('/api/jiraReport/notes', (req, res) => {
  const statusNotes = require(path.join(POLICY_DIR, 'scripts', 'statusNotes.js'));
  const d = statusNotes.load();
  res.json({ savedAt: d.savedAt, savedBy: d.savedBy || '', count: d.count || 0, notes: d.notes || {}, deckText: d.deckText || {} });
});
// SMARTCOMM: QA cards (To Do) whose BA / Dev card is Done -> list, then move the ones the user ticks to Ready for QA
// (scripts/smartPromoteQa.js). Find is read-only; Move changes Jira only for the keys sent.
app.post('/api/jiraReport/promote/find', async (req, res) => {
  if (!jiraConfigured()) return res.status(400).json({ error: 'Jira isn\'t set up yet — enter your Jira email and API token on the Settings tab.' });
  try { res.json(await require(path.join(POLICY_DIR, 'scripts', 'smartPromoteQa.js')).findCandidates()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/jiraReport/promote/move', async (req, res) => {
  if (!jiraConfigured()) return res.status(400).json({ error: 'Jira isn\'t set up yet.' });
  const keys = Array.isArray((req.body || {}).keys) ? req.body.keys.filter((k) => /^SMART-\d+$/.test(String(k))).slice(0, 500) : [];
  if (!keys.length) return res.status(400).json({ error: 'No SMART cards selected.' });
  try {
    const results = await require(path.join(POLICY_DIR, 'scripts', 'smartPromoteQa.js')).moveToReadyForQa(keys);
    console.log(`[promote] ${(req.body || {}).requestedBy || 'someone'} moved ${results.filter((r) => r.moved).length}/${keys.length} SMART QA card(s) to Ready for QA`);
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The deck's header objective + per-area "Risk & Dependencies" text (statusNotes.saveDeckText).
app.post('/api/jiraReport/deckText', (req, res) => {
  const statusNotes = require(path.join(POLICY_DIR, 'scripts', 'statusNotes.js'));
  const { objective, risks, savedBy } = req.body || {};
  const t = statusNotes.saveDeckText({ objective: String(objective || '').slice(0, 1000), risks: risks || {} }, { savedBy: String(savedBy || '').slice(0, 200) });
  res.json({ savedAt: t.savedAt });
});
app.post('/api/jiraReport/notes', (req, res) => {
  const statusNotes = require(path.join(POLICY_DIR, 'scripts', 'statusNotes.js'));
  const { rows, text, source, savedBy } = req.body || {};
  const entries = statusNotes.parse({ rows, text });
  if (!entries.length) return res.status(400).json({ error: 'No Jira keys found — paste the status table (Key / Summary / Status / Notes) from the email.' });
  const d = statusNotes.save(entries, { source: String(source || 'pasted').slice(0, 200), savedBy: String(savedBy || '').slice(0, 200) });
  res.json({ savedAt: d.savedAt, count: d.count, keys: Object.keys(d.notes) });
});

app.post('/api/jiraReport/tracks', (req, res) => {
  const label = String((req.body || {}).label || '').trim();
  const jql = String((req.body || {}).jql || '').trim();
  const filterDoneRetired = Boolean((req.body || {}).filterDoneRetired);
  if (!label) return res.status(400).json({ error: 'Label is required' });
  if (!jql) return res.status(400).json({ error: 'JQL is required' });

  const allTracks = getAllJiraTracks();
  let key = sanitizeTrackKey(label);
  if (allTracks[key]) {
    return res.status(400).json({ error: `A track already uses the key "${key}" (derived from this label) - pick a different label` });
  }
  const sheetName = sanitizeSheetName(label);
  if (RESERVED_SHEET_NAMES.has(sheetName)) {
    return res.status(400).json({ error: `"${sheetName}" is a reserved sheet name (Data/Summary sheets) - pick a different label` });
  }

  const list = loadCustomTracks();
  list.push({ key, label, sheetName, jql, filterDoneRetired });
  saveCustomTracks(list);
  res.json({ ok: true, track: { key, label, custom: true } });
});

app.delete('/api/jiraReport/tracks/:key', (req, res) => {
  const list = loadCustomTracks();
  const next = list.filter((t) => t.key !== req.params.key);
  if (next.length === list.length) {
    return res.status(404).json({ error: `No custom track "${req.params.key}" found` });
  }
  saveCustomTracks(next);
  res.json({ ok: true });
});

// ── Migration reconciliation: bulk claims-file upload ───────────────────────
// Client reads the picked file as base64 (FileReader) and posts it as JSON —
// avoids pulling in a multipart-parsing dependency for what's a small
// claims list (a few hundred rows at most). Saved under a fixed uploads
// directory inside the reconciliation project so buildReconJob can verify
// any path it's asked to run against actually lives there (Section: don't
// let the UI hand an arbitrary filesystem path to a spawned process).
app.post('/api/recon/upload', (req, res) => {
  const { filename, contentBase64 } = req.body || {};
  if (!filename || !contentBase64) {
    return res.status(400).json({ error: 'filename and contentBase64 are required' });
  }
  const ext = path.extname(String(filename)).toLowerCase();
  if (ext !== '.csv' && ext !== '.xlsx' && ext !== '.xls') {
    return res.status(400).json({ error: 'Only .csv, .xlsx or .xls claims files are supported' });
  }
  const safeName = path.basename(String(filename)).replace(/[^A-Za-z0-9._-]/g, '_');
  const savedName = `${Date.now()}-${safeName}`;
  const savedPath = path.join(RECON_UPLOADS_DIR, savedName);
  try {
    fs.writeFileSync(savedPath, Buffer.from(contentBase64, 'base64'));
  } catch (e) {
    return res.status(500).json({ error: `Failed to save upload: ${e.message}` });
  }
  res.json({ ok: true, path: savedPath, filename: savedName });
});

// ── SSE broadcast ────────────────────────────────────────────────────────────

let sseClients = [];

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of sseClients) sendEvent(res, event, data);
}

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  sseClients.push(res);
  sendEvent(res, 'hello', {
    queue: allQueued().map((j) => ({ label: j.label, requestedBy: j.requestedBy })),
    running: allRunning().map((r) => ({ id: r.id, label: r.job.label, requestedBy: r.job.requestedBy, progress: r.progress, smartComm: r.smartComm || null })),
    stats,
  });
  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

// ── Job queue ────────────────────────────────────────────────────────────────
// Each SUITE (Policy, Claims, Reconciliation, Update Validation, PDF Compare, SmartCOMM, Jira Report) gets
// its own independent queue/running pool and its own SUITE_MAX_PARALLEL slots — CONFIRMED live 2026-10-07
// (user report): a single shared pool across every suite meant 2 people running SmartCOMM validations left
// BOTH slots occupied, so a third person's totally unrelated "run my BOP test" sat queued behind them for no
// real reason — these suites don't share a browser, a target system, or any other actual resource, so there
// was never a real contention to protect against, just an accident of how the queue was modeled as one pool.
// Within EACH suite's own pool, the same two ideas as before still apply: up to SUITE_MAX_PARALLEL jobs run
// concurrently, a newly-started job waits STAGGER_MS after that SAME suite's most recently started one before
// launching (so two browser sessions for the same automation never hit login at the exact same instant —
// mirrors runners/run-states.ps1's own -MaxParallel/-StaggerSeconds defaults), and processQueue() prefers to
// hand a freed slot to a queued job from someone NOT already running that suite, so the 2 slots naturally end
// up held by 2 DIFFERENT people instead of one person's own backlog hogging both (added 2026-10-05).
const SUITE_MAX_PARALLEL = 2;
const STAGGER_MS = 60000;
const SUITES = ['policy', 'claims', 'reconciliation', 'updateValidation', 'pdfCompare', 'smartComm', 'jiraReport'];

function makePool() { return { queue: [], running: [], staggerTimer: null }; }
const pools = {};
SUITES.forEach((s) => { pools[s] = makePool(); });

// Flattened views across every suite's pool — only for reporting to the UI (the 'hello'/'queued'/'job-start'/
// 'job-end' SSE payloads all show one combined queue/running list, same shape the client already expects;
// what changed is only how CONCURRENCY is enforced server-side, not what the UI displays).
function allQueued() { return SUITES.flatMap((s) => pools[s].queue); }
function allRunning() { return SUITES.flatMap((s) => pools[s].running); }
function allIdle() { return SUITES.every((s) => pools[s].queue.length === 0 && pools[s].running.length === 0); }

let nextJobId = 1;
let stats = { passed: 0, failed: 0 };
// Per-job progress (unlike `stats` above, which is a cumulative session
// total never reset between jobs) now lives on each entry in `running`,
// since more than one job can be in flight at once. `total` starts null -
// meaning "unknown, show an indeterminate bar" - until either source below
// reports a real count:
//   - Playwright jobs (policy/claims): its own list-reporter prints
//     "Running N test(s) using M worker(s)" as the very first line; `done`
//     then increments off the same ok/x result lines TEST_LINE_RE already
//     parses for `stats`, just counted per-job instead of cumulatively.
//   - PDF Compare jobs: compare_insurance_pdfs.py prints "Found N folder(s)
//     with PDF pairs to compare" once up front (see that script's
//     scan_and_compare()); `done` then increments once per "📁 <folder>"
//     line, printed right before each folder/pair starts processing.
// Other suites (reconciliation, update-validation) have no equivalent
// upfront count in their own output, so `total` just stays null for them
// and the UI falls back to an indeterminate/animated bar.
const RUNNING_TESTS_RE = /^Running (\d+) tests? using \d+ worker/;
const PDF_TOTAL_RE = /^Found (\d+) folder/;

// ── SmartCOMM step-by-step progress ─────────────────────────────────────────
// Per user request 2026-10-07: the SmartCOMM validator's console output is a dense, scrolling technical log
// (the exact thing that buried "waiting up to 360s for YOUR sign-in" among dozens of other lines). Rather
// than building a live browser-screencast view (a separate, larger undertaking — view-only anyway, since the
// actual Azure/MFA sign-in still has to happen in the real window), this parses the SAME log lines
// ClaimCenter-Automation's helpers/smartComm/*.js already print (via their own `log()`/`console.log()` calls
// — see e.g. validationService.js's `[SmartComm] ${scenario.scenarioId}: ...` convention) into a short,
// human-readable checklist per scenario: Opening claim → Signing in → Editing fields → ... An unrecognized
// line just stays out of this panel and still shows up in the raw "Console output" panel below (toggleable,
// not removed) — this never blocks or alters anything, it's a read-only re-presentation of output already
// being printed.
//
// Deliberately covers only the highest-value milestones, not every log line — see each rule's own regex for
// exactly which real, CONFIRMED-live log strings it matches. `lane` groups steps that belong together:
// - a scenario ID (e.g. "DIG47B-AUTO-MD") for everything printed with that scenario's own `[SmartComm] <id>: `
//   prefix (the vast majority of the interesting lines - see runInteractiveGeneration's `log` convention).
// - "tpl:<DIG>" for template-level lines that happen before any scenario exists yet (requirements-derived,
//   bulk-mode per-template start/result banners).
// - "_setup" for a handful of shared ClaimCenter-login lines that are printed with NO scenario prefix at all
//   (a different helper's own console.log, not validationService.js's scoped `log`) - with 2 concurrent
//   scenarios these can't be reliably attributed to one or the other, so they're shown as one shared lane
//   rather than guessed into the wrong scenario's checklist.
function stripSmartCommPrefix(text) {
  let m = /^\[SmartComm\] BLOCKED template (\S+): (.+)$/.exec(text);
  if (m) return { lane: `tpl:${m[1]}`, rest: m[2], terminal: 'error' };
  m = /^\[SmartComm\] BLOCKED (\S+): (.+)$/.exec(text);
  if (m) return { lane: m[1], rest: m[2], terminal: 'error' };
  m = /^\[SmartComm\] ERROR (\S+): (.+)$/.exec(text);
  if (m) return { lane: m[1], rest: m[2], terminal: 'error' };
  m = /^\[SmartComm\] (\S+): (.+)$/.exec(text);
  if (m) return { lane: m[1], rest: m[2] };
  return { lane: null, rest: text };
}

const SMARTCOMM_CONTENT_RULES = [
  { re: /^derived (\d+) requirements from (.+)$/, build: (m, lane) => ({ lane, step: 'requirements', status: 'done', label: 'Loaded template requirements', detail: `${m[1]} requirement(s) from ${m[2].split(/[\\/]/).pop()}` }) },
  { re: /^claim data — (.+)$/, build: (m, lane) => ({ lane, step: 'claimData', status: 'done', label: 'Read claim data', detail: m[1].slice(0, 160) }) },
  { re: /^opening claim (\S+) \(user=([^,]+),/, build: (m, lane) => ({ lane, step: 'openClaim', status: 'start', label: 'Opening claim', detail: `${m[1]} (user=${m[2]})` }) },
  { re: /^WARNING — no test-data claim actually matches/, build: (m, lane, rest) => ({ lane, step: 'openClaim', status: 'warn', label: 'Opening claim', detail: rest.slice(0, 160) }) },
  { re: /no permission to view claim/, build: (m, lane, rest) => ({ lane, step: 'openClaim', status: 'warn', label: 'Opening claim', detail: rest.slice(0, 160) }) },
  { re: /^login as .* failed/, build: (m, lane, rest) => ({ lane, step: 'login', status: 'warn', label: 'ClaimCenter login', detail: rest.slice(0, 160) }) },
  { re: /^\[AzureSession\] Loaded (\d+) saved cookie/, build: (m, lane) => ({ lane, step: 'signin', status: 'start', label: 'Signing in (Azure)', detail: `using a saved session (${m[1]} cookies)` }) },
  { re: /^\[Interactive\] Popup closed itself almost immediately/, build: (m, lane) => ({ lane, step: 'signin', status: 'start', label: 'Signing in (Azure)', detail: 'saved session may have worked — checking…' }) },
  { re: /^\[Interactive\] Waiting up to (\d+)s for sign-in/, build: (m, lane) => ({ lane, step: 'signin', status: 'waiting', label: 'SmartCOMM interactive session validation in progress', detail: `up to ${m[1]}s` }) },
  { re: /^\[Interactive\] Still waiting for sign-in… \((\d+)s left\)/, build: (m, lane) => ({ lane, step: 'signin', status: 'waiting', label: 'SmartCOMM interactive session validation in progress', detail: `${m[1]}s left` }) },
  { re: /^interactive editor: (\d+) merge field\(s\) found \((\d+) editable, (\d+) locked\)/, build: (m, lane) => ({ lane, step: 'editFields', status: 'start', label: 'Editing fields', detail: `${m[1]} field(s) — ${m[2]} editable, ${m[3]} locked` }) },
  { re: /^field #\d+ FAILED: (.+)$/, build: (m, lane) => ({ lane, step: 'editFields', status: 'warn', label: 'Editing fields', detail: m[1].slice(0, 160) }) },
  { re: /^made (\d+) choice selection/, build: (m, lane, rest) => ({ lane, step: 'choices', status: 'done', label: 'Applied Choices-panel selections', detail: rest.slice(0, 160) }) },
  { re: /^Document Properties Identifier: (.+)$/, build: (m, lane) => ({ lane, step: 'complete', status: 'done', label: 'Document completed', detail: m[1] }) },
  { re: /^\[S3\] ".*isn't a real PDF/, build: (m, lane, rest) => ({ lane, step: 's3', status: 'warn', label: 'Fetching document from S3', detail: rest.replace(/^\[S3\] /, '').slice(0, 160) }) },
  { re: /^\[S3\] "/, build: (m, lane, rest) => ({ lane, step: 's3', status: 'start', label: 'Fetching document from S3', detail: rest.replace(/^\[S3\] /, '').slice(0, 160) }) },
  { re: /^\[S3\] downloaded /, build: (m, lane, rest) => ({ lane, step: 's3', status: 'done', label: 'Fetching document from S3', detail: rest.replace(/^\[S3\] /, '').slice(0, 160) }) },
  { re: /^(PASS|FAIL|BLOCKED|ERROR) \((\d+) passed, (\d+) failed, (\d+) blocked, (\d+) skipped\)$/, build: (m, lane) => ({ lane, step: 'validate', status: m[1] === 'PASS' ? 'done' : 'warn', label: 'Scenario finished', detail: `${m[1]} — ${m[2]} passed, ${m[3]} failed, ${m[4]} blocked, ${m[5]} skipped` }) },
];

const SMARTCOMM_GENERAL_RULES = [
  { re: /^\[Bulk\] \((\d+)\/(\d+)\) (\S+) — starting\.\.\.$/, build: (m) => ({ lane: `tpl:${m[3]}`, step: 'template', status: 'start', label: `Template ${m[3]} (${m[1]}/${m[2]})`, detail: 'starting' }) },
  { re: /^\[Bulk\] \((\d+)\/(\d+)\) (\S+): (PASS|FAIL|BLOCKED|ERROR|CRASHED)(.*)$/, build: (m) => ({ lane: `tpl:${m[3]}`, step: 'template', status: m[4] === 'PASS' ? 'done' : (m[4] === 'CRASHED' || m[4] === 'ERROR') ? 'error' : 'warn', label: `Template ${m[3]} (${m[1]}/${m[2]})`, detail: `${m[4]}${m[5]}`.slice(0, 160) }) },
  { re: /^CC Login successful/, build: (m, lane, rest) => ({ lane: '_setup', step: 'ccLogin', status: 'done', label: 'ClaimCenter login', detail: rest.slice(0, 160) }) },
  { re: /^Switched login to: (.+)$/, build: (m) => ({ lane: '_setup', step: 'ccLogin', status: 'done', label: 'ClaimCenter login', detail: `switched to ${m[1]}` }) },
  { re: /^Opened existing claim: (.+)$/, build: (m) => ({ lane: '_setup', step: 'openClaim', status: 'done', label: 'Opening claim', detail: m[1] }) },
];

function classifySmartCommLine(text) {
  const { lane, rest, terminal } = stripSmartCommPrefix(text);
  if (lane && terminal) {
    return { lane, step: 'final', status: terminal, label: terminal === 'error' ? 'Blocked / Error' : 'Final', detail: rest.slice(0, 200) };
  }
  if (lane) {
    for (const rule of SMARTCOMM_CONTENT_RULES) {
      const m = rule.re.exec(rest);
      if (m) return rule.build(m, lane, rest);
    }
    return null;
  }
  for (const rule of SMARTCOMM_GENERAL_RULES) {
    const m = rule.re.exec(text);
    if (m) return rule.build(m, null, text);
  }
  return null;
}

function buildPolicyJob(j) {
  const lob = POLICY_LOB[j.lob];
  if (!lob) throw new Error(`Unknown LOB "${j.lob}"`);
  if (!POLICY_STATES.includes(j.state)) throw new Error(`Unknown state "${j.state}"`);
  const envKey = String(j.env || '').toLowerCase();
  if (!ENV_URLS[envKey]) {
    throw new Error(
      `Env "${j.env}" isn't configured yet - add ENV_URLS.${envKey} in helpers/envConfig.js before running it.`
    );
  }
  return {
    label: `${lob.label} · ${j.state} · ${envKey.toUpperCase()}`,
    cwd: POLICY_DIR,
    cmd: 'npx',
    args: ['playwright', 'test', lob.file, '--project=chromium'],
    env: { TEST_ENV: envKey, TEST_STATE: j.state },
  };
}

function buildClaimsJob(j) {
  const lob = CLAIMS_LOB[j.lob];
  if (!lob) throw new Error(`Unknown LOB "${j.lob}"`);
  if (!CLAIMS_PLATFORMS.includes(j.platform)) throw new Error(`Unknown platform "${j.platform}"`);
  if (!CLAIMS_TIERS.includes(j.tier)) throw new Error(`Unknown tier "${j.tier}"`);
  const policyNumber = String(j.policyNumber || '').trim();
  if (!policyNumber) throw new Error('Policy number is required');

  // getNextPolicy() checks POLICY_<VAR>_<TIER> before the bare POLICY_<VAR>
  // (helpers/claimCenterBase.js) - set both so the typed-in number wins no
  // matter which tier is selected.
  const env = { CC_ENV: j.platform, CC_TIER: j.tier };
  env[lob.policyVar] = policyNumber;
  env[`${lob.policyVar}_TEST`] = policyNumber;
  env[`${lob.policyVar}_DEV`] = policyNumber;

  return {
    label: `${lob.label} · ${policyNumber} · ${j.platform}/${j.tier}`,
    cwd: CLAIMS_DIR,
    cmd: 'npx',
    args: ['playwright', 'test', '--project', lob.project, '--workers=1'],
    env,
  };
}

// SmartCOMM tool, "ClaimCenter screens" mode: launches ClaimCenter-Automation's scripts/validateCcUi.js
// (requirement workbook vs the live Create-New-Document screens) instead of the template-content Playwright
// project. Every value that reaches the shell command line is validated against a strict pattern first.
// The SmartCOMM "Claim #" override. A SmartCOMM document ID (a GUID, as the S3 download takes) passes a plain
// letters/digits/dashes check but isn't a claim — 2026-10-14, DIG238 ran with one and ERRORed only after
// searching ClaimCenter for it. Reject it up front with a message that says what it is.
function checkClaimNumber(claimNumber) {
  if (!claimNumber) return;
  // A whole or trailing part of a GUID (the S3 mode accepts partial keys like "9a-45dd-a4d0-199082294229").
  if (/-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claimNumber)) {
    throw new Error(`"${claimNumber}" is a SmartCOMM document ID, not a claim number — use it in the S3 download mode; Claim # takes a claim like PA-PA-01-26-0000209`);
  }
  if (!/^[A-Za-z0-9-]+$/.test(claimNumber)) throw new Error(`"${claimNumber}" doesn't look like a claim number`);
}

function buildCcUiJob(j) {
  const dig = String(j.templateId || 'DIG52').trim().toUpperCase();
  if (!/^DIG\d+[A-Z]*$/.test(dig)) throw new Error(`"${dig}" is not a valid template ID`);
  if (!SMARTCOMM_TIERS.includes(j.tier)) throw new Error(`Unknown tier "${j.tier}"`);
  const claimNumber = String(j.claimNumber || '').trim();
  checkClaimNumber(claimNumber);
  const reportEmail = String(j.reportEmail || '').trim();
  if (reportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reportEmail)) {
    throw new Error(`"${reportEmail}" doesn't look like a valid email address`);
  }
  const writes = Boolean(j.writes);
  if (writes && j.tier !== 'test') throw new Error('The write scenario (Business Rule 1 saves a document) is only allowed on the TEST tier');
  const br2States = String(j.br2States || '').replace(/\s+/g, '');
  if (br2States && !/^[A-Za-z]{2}(,[A-Za-z]{2})*$/.test(br2States)) throw new Error('Activity-scan states must be 2-letter codes separated by commas, e.g. MD,DE,VA');

  const reportName = `ccui_${j.tier}_${dig}_${Date.now()}`;
  const args = ['scripts/validateCcUi.js', '--template', dig, '--report-name', reportName, '--email'];
  if (claimNumber) args.push('--claim', claimNumber);
  if (writes) args.push('--writes');
  if (br2States) args.push('--br2-states', br2States);
  if (j.noBr2) args.push('--no-br2');
  const env = { CC_ENV: 'cloud', CC_TIER: j.tier };
  env.EMAIL_TO = withAlwaysCc(reportEmail);
  return {
    label: `SmartCOMM UI · ${dig} · cloud/${j.tier}` + (claimNumber ? ` · claim ${claimNumber}` : '') + (writes ? ' · +write scenario' : '') + (reportEmail ? ` · report to ${reportEmail}` : ''),
    cwd: CLAIMS_DIR,
    cmd: 'node',
    args,
    env,
    reportUrls: { kind: 'ccUi', html: `/reports/cc-ui/${reportName}.html`, json: `/reports/cc-ui/${reportName}.json` },
  };
}

// SmartCOMM tool, "Download from S3" mode: launches ClaimCenter-Automation's scripts/downloadSmartCommFile.js
// (Guidewire's S3 Integration Files admin UI — see helpers/s3Download/s3AdminService.js for the login/branch/
// matching behaviour this was built against). Always forces Planet = Test; no CC_ENV/CC_TIER involved — this
// admin tool's own "Planet" setting is a separate concept from the claims suite's onprem/cloud + tier axes.
function buildS3DownloadJob(j) {
  if (!fs.existsSync(S3_DOWNLOAD_SCRIPT)) throw new Error(`downloadSmartCommFile.js not found at ${S3_DOWNLOAD_SCRIPT}`);
  const key = String(j.key || '').trim();
  if (!key) throw new Error('A key (or part of one) is required');
  if (key.length < 4) throw new Error('Key must be at least 4 characters — a very short key could match many unrelated files');
  if (!/^[A-Za-z0-9_\-./]+$/.test(key)) throw new Error('Key may only contain letters, numbers, "-", "_", "." and "/"');
  const reportEmail = String(j.reportEmail || '').trim();
  if (reportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reportEmail)) {
    throw new Error(`"${reportEmail}" doesn't look like a valid email address`);
  }
  const dirName = `${Date.now()}`;
  const outDir = path.join(S3_DOWNLOADS_DIR, dirName);
  const args = [S3_DOWNLOAD_SCRIPT, '--key', key, '--out-dir', outDir];
  args.push('--email', withAlwaysCc(reportEmail));
  return {
    label: `SmartCOMM S3 download · key "${key}"` + (reportEmail ? ` · email to ${reportEmail}` : ''),
    cwd: CLAIMS_DIR,
    cmd: 'node',
    args,
    env: {},
    reportUrls: { kind: 's3Download', manifest: `/reports/s3-download/${dirName}/manifest.json`, dir: `/reports/s3-download/${dirName}/` },
  };
}

// SmartCOMM tool, "Establish S3 Session" mode: launches ClaimCenter-Automation's
// scripts/establishS3Session.js in a VISIBLE (headed) browser window on this machine so a human can complete
// whatever Okta actually asks for once, then saves the resulting cookies (helpers/s3Download/oktaSessionStore.js)
// for every later "Download from S3" job to reuse — CONFIRMED live 2026-10-01 that a brand-new, cookie-less
// browser now gets an immediate Okta 400 "GENERAL_NONSUCCESS" rejection instead of the silent network-trust
// sign-in that used to work. Run this once up front, and again whenever a download job's error message says
// the saved session expired.
function buildS3SessionJob() {
  if (!fs.existsSync(S3_ESTABLISH_SESSION_SCRIPT)) throw new Error(`establishS3Session.js not found at ${S3_ESTABLISH_SESSION_SCRIPT}`);
  return {
    label: 'SmartCOMM S3 · establish session',
    cwd: CLAIMS_DIR,
    cmd: 'node',
    args: [S3_ESTABLISH_SESSION_SCRIPT],
    env: {},
  };
}

// SmartCOMM tool, "Template content" mode with 2+ templates selected: runs ClaimCenter-Automation's
// scripts/bulkValidateSmartComm.js (ONE shared browser across all templates, one consolidated Excel report —
// Summary tab, a "Common Issues" cross-template pattern-analysis tab, then one tab per scenario — emailed at
// the end) instead of queuing N separate single-template jobs that would each send their own report. Picking
// just one template keeps using the existing single-template path (buildSmartCommJob's default branch below)
// unchanged.
function buildSmartCommBulkJob(j) {
  const ids = Array.isArray(j.templateIds) ? j.templateIds.map((t) => String(t || '').trim().toUpperCase()).filter(Boolean) : [];
  if (ids.length < 2) throw new Error('Bulk mode needs at least 2 templates — pick just one for a single-template run instead.');
  for (const dig of ids) {
    if (!/^DIG\d+[A-Z]*$/.test(dig)) throw new Error(`"${dig}" is not a valid template ID`);
  }
  if (!SMARTCOMM_TIERS.includes(j.tier)) throw new Error(`Unknown tier "${j.tier}"`);
  const reportEmail = String(j.reportEmail || '').trim();
  if (reportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reportEmail)) {
    throw new Error(`"${reportEmail}" doesn't look like a valid email address`);
  }
  const outPath = path.join(CLAIMS_DIR, 'results', 'smartComm', 'bulk', `ui_bulk_${Date.now()}.json`);
  const env = { CC_ENV: 'cloud', CC_TIER: j.tier };
  env.EMAIL_TO = withAlwaysCc(reportEmail);
  const interactive = Boolean(j.interactive);
  if (interactive) env.SMARTCOMM_INTERACTIVE = '1';
  // validateTemplate() (called once per template by bulkValidateSmartComm.js) reads this env var directly —
  // same clamp as the single-template path, since it becomes a shell env var either way.
  const concurrency = Math.max(1, Math.min(5, parseInt(j.concurrency, 10) || 1));
  if (concurrency > 1) env.SMARTCOMM_CONCURRENCY = String(concurrency);
  // How many of a template's own matched scenarios to actually run — NOT the same as concurrency (how many
  // run AT ONCE). scenarioService.js reads this directly, defaulting to 3 when unset; 0 here means "leave it
  // unset, use that default" rather than trusting a falsy parseInt result as a real choice.
  const maxScenarios = j.maxScenarios ? Math.max(1, Math.min(3, parseInt(j.maxScenarios, 10) || 3)) : 0;
  if (maxScenarios > 0) env.SMARTCOMM_MAX_SCENARIOS_PER_TEMPLATE = String(maxScenarios);
  return {
    label: `SmartCOMM Bulk · ${ids.length} templates (${ids.join(', ')}) · cloud/${j.tier}` +
      (reportEmail ? ` · report to ${reportEmail}` : '') + (interactive ? ' · Interactive templates enabled' : '') +
      (concurrency > 1 ? ` · ${concurrency}x concurrent scenarios` : '') +
      (maxScenarios > 0 ? ` · ${maxScenarios} scenario(s)/template` : ''),
    cwd: CLAIMS_DIR,
    cmd: 'node',
    args: ['scripts/bulkValidateSmartComm.js', ids.join(','), outPath],
    env,
  };
}

function buildSmartCommJob(j) {
  if (j.mode === 'ui') return buildCcUiJob(j);
  if (j.mode === 's3') return buildS3DownloadJob(j);
  if (j.mode === 's3-session') return buildS3SessionJob();
  if (j.mode === 'bulk') return buildSmartCommBulkJob(j);
  const dig = String(j.templateId || '').trim();
  if (!dig) throw new Error('Template is required');
  if (!SMARTCOMM_TIERS.includes(j.tier)) throw new Error(`Unknown tier "${j.tier}"`);
  const claimNumber = String(j.claimNumber || '').trim();
  checkClaimNumber(claimNumber);
  const reportEmail = String(j.reportEmail || '').trim();
  if (reportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reportEmail)) {
    throw new Error(`"${reportEmail}" doesn't look like a valid email address`);
  }

  const env = { CC_ENV: 'cloud', CC_TIER: j.tier, SMARTCOMM_TEMPLATE_ID: dig };
  // Optional manual override — validationService uses this claim directly
  // for a single scenario instead of matching the Test Data claim
  // inventory by the template's own LOB/State applicability. Handy for
  // testing a template that doesn't have a matching test-data claim yet.
  if (claimNumber) env.SMARTCOMM_CLAIM_NUMBER = claimNumber;
  // Overrides reportService's own default recipient (EMAIL_TO) so each person running a validation can get
  // their own copy too — remembered client-side (localStorage) so this is a one-time setup per browser, not
  // a per-run chore. withAlwaysCc ALSO always includes the tool's owner regardless of whose address was
  // typed in (added 2026-10-02 per request), so every report still reaches them even when someone else runs it.
  env.EMAIL_TO = withAlwaysCc(reportEmail);
  // Templates the index marks "Interactive" are BLOCKED unless this is set — that flow opens a real,
  // visible browser window and needs a person to clear an Azure SSO/MFA prompt in it, so it can't be part
  // of an unattended run by default.
  const interactive = Boolean(j.interactive);
  if (interactive) env.SMARTCOMM_INTERACTIVE = '1';
  // Runs this template's own scenarios concurrently (separate browser contexts) instead of one at a time —
  // see validateTemplate()'s own comment in ClaimCenter-Automation/helpers/smartComm/validationService.js.
  // Clamped here too (not just trusted from the client) since this becomes a shell env var.
  const concurrency = Math.max(1, Math.min(5, parseInt(j.concurrency, 10) || 1));
  if (concurrency > 1) env.SMARTCOMM_CONCURRENCY = String(concurrency);
  // How many of this template's own matched scenarios to actually run — NOT the same as concurrency (how
  // many run AT ONCE). scenarioService.js reads this directly, defaulting to 3 when unset; 0 here means
  // "leave it unset, use that default" rather than trusting a falsy parseInt result as a real choice.
  const maxScenarios = j.maxScenarios ? Math.max(1, Math.min(3, parseInt(j.maxScenarios, 10) || 3)) : 0;
  if (maxScenarios > 0) env.SMARTCOMM_MAX_SCENARIOS_PER_TEMPLATE = String(maxScenarios);

  return {
    label: `SmartCOMM · ${dig} · cloud/${j.tier}` + (claimNumber ? ` · claim ${claimNumber}` : '') + (reportEmail ? ` · report to ${reportEmail}` : '') + (interactive ? ' · Interactive templates enabled' : '') + (concurrency > 1 ? ` · ${concurrency}x concurrent scenarios` : '') + (maxScenarios > 0 ? ` · ${maxScenarios} scenario(s)` : ''),
    cwd: CLAIMS_DIR,
    cmd: 'npx',
    args: ['playwright', 'test', '--project', 'SmartCOMM Validator', '--workers=1'],
    env,
  };
}

// Migration reconciliation (cc-migration-reconciliation's own CLI — see its
// README): single mode compares one on-prem claim against one cloud claim
// (same number on both sides if the user only typed one — a real migrated
// pair often isn't available yet, see that README's environment note, so an
// asymmetric pair is the common case, not the exception); bulk mode reads
// an uploaded claims file (already saved by /api/recon/upload).
function buildReconJob(j) {
  if (PACKAGED) throw new Error('Migration Reconciliation isn\'t available in this build yet - planned for a future release.');
  if (!RECON_TIERS.includes(j.tier)) throw new Error(`Unknown tier "${j.tier}"`);
  const reportBase = `reconciliation-${j.tier}`;
  const reportUrls = {
    html: `/reports/recon/${reportBase}.html`,
    xlsx: `/reports/recon/${reportBase}.xlsx`,
    json: `/reports/recon/${reportBase}.json`,
  };

  if (j.mode === 'bulk') {
    const filePath = String(j.filePath || '').trim();
    if (!filePath) throw new Error('Uploaded claims file is required for bulk mode');
    const resolved = path.resolve(filePath);
    // Only ever run against a file we ourselves saved via /api/recon/upload
    // — never let the UI hand an arbitrary filesystem path to a spawned process.
    if (path.relative(RECON_UPLOADS_DIR, resolved).startsWith('..')) {
      throw new Error('Claims file must come from an upload');
    }
    return {
      label: `Reconciliation · bulk (${path.basename(resolved)}) · ${j.tier.toUpperCase()}`,
      cwd: RECON_DIR,
      cmd: 'npm',
      args: ['run', 'reconcile', '--', '--claims', resolved, '--tier', j.tier],
      env: {},
      reportUrls,
    };
  }

  const onprem = String(j.onpremClaim || '').trim();
  const cloud = String(j.cloudClaim || '').trim() || onprem;
  if (!onprem) throw new Error('On-prem claim number is required');

  const args = onprem === cloud
    ? ['run', 'reconcile', '--', '--claim', onprem, '--tier', j.tier]
    : ['run', 'reconcile', '--', '--onprem-claim', onprem, '--cloud-claim', cloud, '--tier', j.tier];
  const label = onprem === cloud
    ? `Reconciliation · ${onprem} · ${j.tier.toUpperCase()}`
    : `Reconciliation · ${onprem} (on-prem) / ${cloud} (cloud) · ${j.tier.toUpperCase()}`;

  return { label, cwd: RECON_DIR, cmd: 'npm', args, env: {}, reportUrls };
}

// Data Update & Dropdown Validation — same on-prem/cloud claim # + bulk
// upload shape as buildReconJob (and reuses the SAME /api/recon/upload
// endpoint/uploads dir — the claims-file format is identical, read by the
// same ClaimListReader), but runs the DIFFERENT `validate-updates` CLI,
// which WRITES to whichever claims it's pointed at.
function buildUpdateValidationJob(j) {
  if (PACKAGED) throw new Error('Data Update & Dropdown Validation isn\'t available in this build yet - planned for a future release.');
  if (!UPDATE_VALIDATION_TIERS.includes(j.tier)) throw new Error(`Unknown tier "${j.tier}"`);
  const reportBase = `update-validation-${j.tier}`;
  const reportUrls = {
    html: `/reports/recon/${reportBase}.html`,
    json: `/reports/recon/${reportBase}.json`,
  };

  if (j.mode === 'bulk') {
    const filePath = String(j.filePath || '').trim();
    if (!filePath) throw new Error('Uploaded claims file is required for bulk mode');
    const resolved = path.resolve(filePath);
    if (path.relative(RECON_UPLOADS_DIR, resolved).startsWith('..')) {
      throw new Error('Claims file must come from an upload');
    }
    return {
      label: `Update Validation · bulk (${path.basename(resolved)}) · ${j.tier.toUpperCase()}`,
      cwd: RECON_DIR,
      cmd: 'npm',
      args: ['run', 'validate-updates', '--', '--claims', resolved, '--tier', j.tier],
      env: {},
      reportUrls,
    };
  }

  const onprem = String(j.onpremClaim || '').trim();
  const cloud = String(j.cloudClaim || '').trim() || onprem;
  if (!onprem) throw new Error('On-prem claim number is required');

  const args = onprem === cloud
    ? ['run', 'validate-updates', '--', '--claim', onprem, '--tier', j.tier]
    : ['run', 'validate-updates', '--', '--onprem-claim', onprem, '--cloud-claim', cloud, '--tier', j.tier];
  const label = onprem === cloud
    ? `Update Validation · ${onprem} · ${j.tier.toUpperCase()}`
    : `Update Validation · ${onprem} (on-prem) / ${cloud} (cloud) · ${j.tier.toUpperCase()}`;

  return { label, cwd: RECON_DIR, cmd: 'npm', args, env: {}, reportUrls };
}

// PDF Compare - wraps compare_insurance_pdfs.py (from the QA Automation Suite
// desktop tool - same script, just spawned here instead of from its Tkinter
// GUI). Scans --input-dir for sub-folders of PDF pairs (or the folder itself
// with --flat), diffs each pair section-by-section using bold-header
// detection, and writes one consolidated Excel workbook. Input dir is a
// server-side path (this runner and the browser share the same machine, same
// as every other suite here) - never given to the browser, only referenced.
function buildPdfCompareJob(j) {
  if (PACKAGED) throw new Error('PDF Compare isn\'t available in this build yet - planned for a future release.');
  if (!fs.existsSync(PDF_COMPARE_SCRIPT)) {
    throw new Error(`compare_insurance_pdfs.py not found at ${PDF_COMPARE_SCRIPT}`);
  }
  const inputDir = String(j.inputDir || '').trim();
  if (!inputDir) throw new Error('Input folder is required');
  const resolvedInput = path.resolve(inputDir);
  if (!fs.existsSync(resolvedInput) || !fs.statSync(resolvedInput).isDirectory()) {
    throw new Error(`Input folder does not exist: ${resolvedInput}`);
  }

  let outName = String(j.outputName || '').trim() || 'results.xlsx';
  outName = path.basename(outName).replace(/[^A-Za-z0-9._-]/g, '_');
  if (!outName.toLowerCase().endsWith('.xlsx')) outName += '.xlsx';
  const outPath = path.join(PDF_COMPARE_REPORTS_DIR, outName);

  const args = [PDF_COMPARE_SCRIPT, '--input-dir', resolvedInput, '--output', outPath];
  if (j.flat) args.push('--flat');
  // Independent of --flat: PDF pairs can live at any depth under the input
  // folder (e.g. root/state-folder/variant-folder/*.pdf) - neither --flat
  // (depth 0) nor the default (fixed depth 1) finds those, so this walks
  // every sub-folder recursively instead. See compare_insurance_pdfs.py's
  // find_pdf_pairs_recursive() for why this needed its own mode rather than
  // changing what --flat/default already do.
  if (j.recursive) args.push('--recursive');
  const limit = parseInt(j.limit, 10);
  if (Number.isFinite(limit) && limit > 0) args.push('--limit', String(limit));

  return {
    label: `PDF Compare · ${path.basename(resolvedInput)}${j.flat ? ' (flat)' : ''}${j.recursive ? ' (recursive)' : ''}`,
    cwd: POLICY_DIR,
    cmd: 'python',
    args,
    // The script prints emoji (e.g. folder icon) - Windows' default console
    // codepage (cp1252) can't encode those and the process crashes with
    // UnicodeEncodeError unless stdout/stderr are forced to UTF-8.
    env: { PYTHONIOENCODING: 'utf-8' },
    reportUrls: { xlsx: `/reports/pdf-compare/${outName}` },
  };
}

// Jira Sprint Report — pulls the selected areas (Enhancement/ClaimCenter/
// SmartComm/Nautilus-Other, default all four) straight from Jira's REST API
// and writes an Excel workbook (scripts/jiraReport.js), then emails it to the
// address typed in the UI (default: TO_EMAIL from .env). Replaces the earlier
// Power-Query workbook approach, which kept losing loaded tables to Excel
// COM/UI flakiness under automation; this path is deterministic and
// rerunnable. Each distinct track selection writes its own output file (see
// jiraReportFileName below) so running just one track doesn't clobber - or
// get confused with - a prior full run's report.
function jiraReportFileName(tracks, allKeys) {
  const allSelected = tracks.length === allKeys.length;
  return allSelected ? 'Sprint_Pending_Work_Report.xlsx' : `Sprint_Pending_Work_Report_${tracks.join('-')}.xlsx`;
}

// Same fallback SmartCOMM's reportService uses when no address is typed in the
// UI: the owner's own inbox (TO_EMAIL from .env, else this literal).
const JIRA_DEFAULT_REPORT_EMAIL = process.env.TO_EMAIL || 'amitmishra@donegalgroup.com';

function buildJiraReportJob(j) {
  if (!fs.existsSync(JIRA_REPORT_SCRIPT)) {
    throw new Error(`jiraReport.js not found at ${JIRA_REPORT_SCRIPT}`);
  }
  if (!jiraConfigured()) {
    throw new Error('Jira isn\'t set up yet - enter your Jira email and API token on the Settings tab (Jira credentials), then Save.');
  }
  const typedEmail = String(j.reportEmail || '').trim();
  if (typedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typedEmail)) {
    throw new Error(`"${typedEmail}" doesn't look like a valid email address`);
  }
  const reportEmail = typedEmail || JIRA_DEFAULT_REPORT_EMAIL;
  // Sprint status deck (PowerPoint for management): its own fixed areas (ClaimCenter + enhancements, OneInc,
  // SmartCOMM) and defect query — the track chips don't apply. See scripts/jiraStatusDeck.js.
  if (j.reportType === 'statusDeck') {
    if (!fs.existsSync(JIRA_STATUS_DECK_SCRIPT)) throw new Error(`jiraStatusDeck.js not found at ${JIRA_STATUS_DECK_SCRIPT}`);
    const deckName = `QA_Sprint_Status_${new Date().toISOString().slice(0, 10)}.pptx`;
    return {
      label: `Jira Sprint Status deck (PowerPoint) · email to ${reportEmail}`,
      cwd: POLICY_DIR,
      cmd: 'node',
      args: [JIRA_STATUS_DECK_SCRIPT, path.join(JIRA_REPORTS_DIR, deckName)],
      env: { JIRA_REPORT_EMAIL_TO: withAlwaysCc(reportEmail), JIRA_SITE: process.env.JIRA_SITE || DEFAULT_JIRA_SITE },
      reportUrls: { kind: 'jiraReport', pptx: `/reports/jira/${deckName}` },
    };
  }
  const allTracks = getAllJiraTracks();
  const allKeys = Object.keys(allTracks);
  const requested = Array.isArray(j.tracks) && j.tracks.length > 0 ? j.tracks : allKeys;
  const invalid = requested.filter((t) => !allTracks[t]);
  if (invalid.length) throw new Error(`Unknown track(s): ${invalid.join(', ')}`);
  // Keep a stable order regardless of how the UI sent them, so the same
  // selection always maps to the same output filename.
  const tracks = allKeys.filter((t) => requested.includes(t));

  const outName = jiraReportFileName(tracks, allKeys);
  const outPath = path.join(JIRA_REPORTS_DIR, outName);
  const trackLabel = tracks.length === allKeys.length ? 'all tracks' : tracks.join(', ');
  return {
    label: `Jira Sprint Report · ${trackLabel} · email to ${reportEmail}`,
    cwd: POLICY_DIR,
    cmd: 'node',
    args: [JIRA_REPORT_SCRIPT, outPath, tracks.join(',')],
    // jiraReport.js emails the finished workbook to this address (it only
    // sends when this is set, so direct CLI runs stay email-free).
    env: { JIRA_REPORT_EMAIL_TO: withAlwaysCc(reportEmail), JIRA_SITE: process.env.JIRA_SITE || DEFAULT_JIRA_SITE },
    reportUrls: { kind: 'jiraReport', xlsx: `/reports/jira/${outName}` },
  };
}

app.post('/api/run', (req, res) => {
  const { suite, jobs, requestedBy } = req.body || {};
  const identity = String(requestedBy || '').trim().toLowerCase();
  if (!EMAIL_RE.test(identity)) {
    return res.status(400).json({ error: 'Your email is required to run anything - enter it above the Status panel (this is how teammates sharing this tool will know it\'s you).' });
  }
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return res.status(400).json({ error: 'No jobs provided' });
  }
  // Same fallback as the builder dispatch below: an unrecognized/missing `suite` is treated as 'policy' for
  // BOTH which builder runs and which pool the job lands in, so the two stay consistent with each other.
  const suiteKey = pools[suite] ? suite : 'policy';
  // Server-side backstop for the packaged build's tab-lock UI - a locked tab's panel never renders real
  // controls to submit from, but this closes the gap for anyone calling the API directly instead of clicking
  // through the UI. No-op (every suite always "allowed") outside a packaged build - see allowedSuitesFor().
  if (!allowedSuitesFor(identity).includes(suiteKey)) {
    return res.status(403).json({ error: `This tool isn't enabled for ${identity} yet - use "Request access" on its tab.` });
  }
  let built;
  try {
    built = jobs.map((j) => (
      suite === 'claims' ? buildClaimsJob(j)
        : suite === 'reconciliation' ? buildReconJob(j)
        : suite === 'updateValidation' ? buildUpdateValidationJob(j)
        : suite === 'pdfCompare' ? buildPdfCompareJob(j)
        : suite === 'smartComm' ? buildSmartCommJob(j)
        : suite === 'jiraReport' ? buildJiraReportJob(j)
        : buildPolicyJob(j)
    ));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  built.forEach((b) => { b.requestedBy = identity; b.suite = suiteKey; });

  pools[suiteKey].queue.push(...built);
  broadcast('queued', {
    added: built.map((b) => ({ label: b.label, requestedBy: b.requestedBy })),
    queue: allQueued().map((j) => ({ label: j.label, requestedBy: j.requestedBy })),
  });
  processQueue(suiteKey);
  // Team-wide usage stat (best-effort) - one record per accepted submission. mode/tier come from the raw job
  // payload when present, so per-tool breakdowns can distinguish e.g. SmartCOMM template vs S3 vs ClaimCenter-UI.
  recordUsage({
    email: identity,
    name: (loadSettings().name || ''),
    tool: suiteKey,
    mode: (jobs[0] && jobs[0].mode) || '',
    tier: (jobs[0] && (jobs[0].tier || jobs[0].env)) || '',
    jobs: built.length,
  });
  res.json({ ok: true, queued: built.length });
});

// Team-wide usage stats for the Stats tab (shown to everyone) - aggregates the shared usage log.
// ── SmartCOMM results (the Results page) — read from ClaimCenter-Automation's results store ─────────────────
// (helpers/smartComm/resultsStore.js: results/smartComm/bulk + runs). Required per request so a `git pull` of
// ClaimCenter-Automation is picked up without restarting; an older checkout without the store gets a clear 501.
function resultsStore() {
  try { return require(path.join(CLAIMS_DIR, 'helpers', 'smartComm', 'resultsStore')); } catch (e) { return null; }
}
const RESULTS_NOT_AVAILABLE = 'Results need a newer ClaimCenter-Automation (git pull in that folder).';
app.get('/api/results/runs', (req, res) => {
  const store = resultsStore();
  if (!store) return res.status(501).json({ error: RESULTS_NOT_AVAILABLE });
  try {
    res.json({ runs: store.listRuns({ limit: Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50)) }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/results/runs/:id', (req, res) => {
  const store = resultsStore();
  if (!store) return res.status(501).json({ error: RESULTS_NOT_AVAILABLE });
  try {
    const run = store.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json({ run, compare: store.compareWithPrevious(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/results/runs/:id/pdf', (req, res) => {
  const store = resultsStore();
  if (!store) return res.status(501).json({ error: RESULTS_NOT_AVAILABLE });
  const p = store.pdfPathFor(req.params.id, String(req.query.dig || ''), String(req.query.scenario || ''));
  if (!p) return res.status(404).json({ error: 'PDF not found (it may have been replaced by a later run)' });
  res.type('application/pdf').sendFile(p);
});

app.get('/api/stats', (req, res) => {
  const recs = readUsage();
  const byTool = {};
  const byUser = {};
  const usersSet = new Set();
  for (const r of recs) {
    const tool = r.tool || 'unknown';
    byTool[tool] = (byTool[tool] || 0) + 1;
    const key = (r.email || r.name || 'unknown').toLowerCase();
    usersSet.add(key);
    if (!byUser[key]) byUser[key] = { email: r.email || '', name: r.name || '', runs: 0, lastTs: '' };
    byUser[key].runs += 1;
    if (r.name && !byUser[key].name) byUser[key].name = r.name;
    if (!byUser[key].lastTs || r.ts > byUser[key].lastTs) byUser[key].lastTs = r.ts;
  }
  const toolLabels = {
    policy: 'Policy Tests', claims: 'Claims (ClaimCenter)', smartComm: 'SmartCOMM Validator',
    jiraReport: 'Jira Sprint Report', reconciliation: 'Migration Reconciliation',
    updateValidation: 'Data Update & Dropdown Validation', pdfCompare: 'PDF Compare',
  };
  res.json({
    totalRuns: recs.length,
    distinctUsers: usersSet.size,
    tools: Object.keys(byTool).sort((a, b) => byTool[b] - byTool[a]).map((k) => ({ key: k, label: toolLabels[k] || k, runs: byTool[k] })),
    users: Object.values(byUser).sort((a, b) => b.runs - a.runs),
    recent: recs.slice(-40).reverse(),
  });
});

// Scoped to the caller's own jobs by default, so one person sharing this tool can never kill a different
// person's run - only the tool's owner (ALWAYS_CC_EMAIL) gets the old "stop everything" behavior, as an
// escape hatch for clearing a stuck/abandoned job.
app.post('/api/stop', (req, res) => {
  const identity = String((req.body || {}).requestedBy || '').trim().toLowerCase();
  if (!EMAIL_RE.test(identity)) {
    return res.status(400).json({ error: 'Your email is required to stop a run.' });
  }
  const isOwner = identity === ALWAYS_CC_EMAIL.toLowerCase();
  // Owner's "stop everything" (or a normal user's "stop my own jobs") now has to sweep every suite's own
  // pool, since a person's jobs (or, for the owner, ALL jobs) can be spread across several of them at once.
  let clearedQueue = 0;
  const stoppedLabels = [];
  for (const s of SUITES) {
    const pool = pools[s];
    const before = pool.queue.length;
    pool.queue = isOwner ? [] : pool.queue.filter((j) => j.requestedBy !== identity);
    clearedQueue += before - pool.queue.length;
    if (isOwner && pool.staggerTimer) { clearTimeout(pool.staggerTimer); pool.staggerTimer = null; }
    const toStop = isOwner ? pool.running : pool.running.filter((r) => r.job.requestedBy === identity);
    stoppedLabels.push(...toStop.map((r) => r.job.label));
    toStop.forEach((r) => killTree(r.proc.pid));
  }
  stoppedLabels.forEach((label) => broadcast('stopped', { label }));
  res.json({ ok: true, clearedQueue, stoppedLabels });
});

function killTree(pid) {
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${pid} /T /F`);
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (__) {} }
  }
}

// Matches Playwright's non-TTY list-reporter lines, e.g.:
//   ok 1 [chromium] › Create_BOP.test.js:18:1 › BOP Submission (5.3m)
//   x  1 [E2E - BOP] › tests\lob\BOP.e2e.test.js:52:3 › ... (8.4m)
const TEST_LINE_RE = /^\s*(ok|x)\s+\d+\s+(.+)$/;

// spawn(..., { shell: true }) does NOT escape array args on Windows - it just
// joins them with spaces (Node emits DEP0190 warning about this), so
// '--project', 'E2E - Commercial Package' would arrive as five separate
// words and silently break the Playwright project match. Quoting any arg
// that contains whitespace keeps it intact as one argument; harmless for the
// plain flags/filenames that don't need it.
function shellQuote(arg) {
  const s = String(arg);
  return /\s/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function scheduleProcessQueue(suite, delayMs) {
  const pool = pools[suite];
  if (pool.staggerTimer) return; // already have a pending retry for THIS suite - it'll re-check everything
  pool.staggerTimer = setTimeout(() => { pool.staggerTimer = null; processQueue(suite); }, delayMs);
}

function processQueue(suite) {
  const pool = pools[suite];
  if (pool.queue.length === 0) {
    // Only announce a full, tool-wide idle reset once EVERY suite's pool is empty, not just this one -
    // matches the client's own 'queue-empty' handler, which blanket-resets its whole UI state.
    if (pool.running.length === 0 && allIdle()) broadcast('queue-empty', { stats });
    return;
  }
  if (pool.running.length >= SUITE_MAX_PARALLEL) return; // retried by this suite's own job-end handler below

  if (pool.running.length > 0) {
    const elapsed = Date.now() - Math.max(...pool.running.map((r) => r.startedAt));
    if (elapsed < STAGGER_MS) {
      scheduleProcessQueue(suite, STAGGER_MS - elapsed);
      return;
    }
  }

  // Prefer the first queued job (within THIS suite) from someone NOT already running it, so a slot that just
  // freed up goes to a different person before it goes to the already-running person's own next job in line -
  // this is what actually lets a second person in rather than being stuck behind one person's whole queue.
  // Falls back to plain FIFO (the queue's own front) when nobody else is waiting, so a lone user's jobs still
  // run back-to-back.
  const runningIdentities = new Set(pool.running.map((r) => r.job.requestedBy));
  let dequeueIdx = pool.queue.findIndex((j) => !runningIdentities.has(j.requestedBy));
  if (dequeueIdx === -1) dequeueIdx = 0;
  const job = pool.queue.splice(dequeueIdx, 1)[0];
  const id = nextJobId++;

  // Packaged build: swap bare 'npx'/'node' for Electron's own bundled Node (no system Node/npx on a clean
  // Windows machine - see "Packaged runtime" near the top of this file). Every PACKAGED job is already one of
  // these two (buildReconJob/buildUpdateValidationJob/buildPdfCompareJob, the only 'npm'/'python' builders,
  // all throw before a job ever reaches this point when PACKAGED is set - see their own guards), so the 'npm'/
  // 'python' cases below are an unreachable defensive fallback, not a real code path.
  let spawnCmd = job.cmd;
  let spawnArgs = job.args;
  if (PACKAGED) {
    if (job.cmd === 'npx') {
      // Every 'npx' job here is 'npx playwright ...' - args[0] is always the literal 'playwright'.
      // '@playwright/test/cli.js' (with the extension) isn't a path this package's own "exports" map allows -
      // confirmed live (ERR_PACKAGE_PATH_NOT_EXPORTED) - 'cli' (no extension) is the public subpath it exports.
      const playwrightCli = require.resolve('@playwright/test/cli', { paths: [job.cwd] });
      spawnCmd = BUNDLED_NODE_EXEC;
      spawnArgs = [playwrightCli, ...job.args.slice(1)];
    } else if (job.cmd === 'node') {
      spawnCmd = BUNDLED_NODE_EXEC;
      spawnArgs = job.args;
    } else {
      // Defensive only - unreachable in practice, since every PACKAGED job builder that would ever return
      // cmd:'npm'/'python' already throws before its job reaches the queue (see buildReconJob/
      // buildUpdateValidationJob/buildPdfCompareJob). This job was already removed from pool.queue above and
      // never added to pool.running, so there's nothing to clean up there - just report it and move on.
      broadcast('job-end', { id, label: job.label, requestedBy: job.requestedBy, code: 1, stats, reportUrls: null, queue: allQueued().map((q) => ({ label: q.label, requestedBy: q.requestedBy })) });
      broadcast('line', { id, label: job.label, requestedBy: job.requestedBy, stream: 'stderr', text: `"${job.cmd}" is not available in the packaged build yet` });
      processQueue(suite);
      return;
    }
  }

  const child = spawn(shellQuote(spawnCmd), spawnArgs.map(shellQuote), {
    cwd: job.cwd,
    shell: true, // resolves npx.cmd/npm.cmd on Windows in dev use; harmless no-op for an already-absolute packaged exe path
    detached: process.platform !== 'win32',
    // PACKAGED builds inherit PLAYWRIGHT_BROWSERS_PATH from process.env here (set once by electron-app/main.js
    // before requiring this file) - points Playwright at the bundled Chromium instead of trying to download one.
    // ELECTRON_RUN_AS_NODE makes BUNDLED_NODE_EXEC (Electron's own binary) behave as a plain `node <script>`
    // process instead of launching another full Electron/Chromium GUI instance - without this, every spawned
    // job here would pop a second app window instead of running headless-CLI-style as intended.
    // PACKAGED_NODE_OPTIONS: Electron 33's bundled Node is 20.18, which can't require() ESM-only packages
    // (@faker-js/faker 10 - helpers/randomData.js) without --experimental-require-module; system Node 22.12+
    // does it by default, which is why dev runs never hit it. Inherited by Playwright's worker processes too.
    env: { ...process.env, ...job.env, FORCE_COLOR: '0', ...(PACKAGED ? { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: PACKAGED_NODE_OPTIONS } : {}) },
  });
  const entry = { id, proc: child, job, startedAt: Date.now(), progress: { done: 0, total: null } };
  pool.running.push(entry);
  broadcast('job-start', {
    id, label: job.label, requestedBy: job.requestedBy,
    queue: allQueued().map((j) => ({ label: j.label, requestedBy: j.requestedBy })),
  });
  broadcast('progress', { id, label: job.label, ...entry.progress });

  const handleChunk = (stream) => (chunk) => {
    for (const rawLine of chunk.toString().split(/\r?\n/)) {
      if (rawLine === '') continue;
      broadcast('line', { id, label: job.label, requestedBy: job.requestedBy, stream, text: rawLine });

      const m = rawLine.match(TEST_LINE_RE);
      if (m && rawLine.includes('›')) {
        const status = m[1].toLowerCase() === 'ok' ? 'passed' : 'failed';
        stats[status] += 1;
        broadcast('test-result', { id, label: job.label, status, name: m[2], stats });
        entry.progress.done += 1;
        broadcast('progress', { id, label: job.label, ...entry.progress });
        continue;
      }

      const runningM = rawLine.match(RUNNING_TESTS_RE);
      if (runningM) {
        entry.progress.total = parseInt(runningM[1], 10);
        broadcast('progress', { id, label: job.label, ...entry.progress });
        continue;
      }

      const pdfTotalM = rawLine.match(PDF_TOTAL_RE);
      if (pdfTotalM) {
        entry.progress.total = parseInt(pdfTotalM[1], 10);
        broadcast('progress', { id, label: job.label, ...entry.progress });
        continue;
      }

      if (rawLine.trimStart().startsWith('📁')) {
        entry.progress.done += 1;
        broadcast('progress', { id, label: job.label, ...entry.progress });
      }

      if (job.label.startsWith('SmartCOMM')) {
        const step = classifySmartCommLine(rawLine);
        if (step) {
          if (!entry.smartComm) entry.smartComm = { lanes: {} };
          let laneState = entry.smartComm.lanes[step.lane];
          if (!laneState) { laneState = { order: [], steps: {} }; entry.smartComm.lanes[step.lane] = laneState; }
          if (!laneState.steps[step.step]) laneState.order.push(step.step);
          laneState.steps[step.step] = { status: step.status, label: step.label, detail: step.detail };
          broadcast('smartcomm-step', { id, lane: step.lane, step: step.step, status: step.status, label: step.label, detail: step.detail });
        }
      }
    }
  };
  child.stdout.on('data', handleChunk('stdout'));
  child.stderr.on('data', handleChunk('stderr'));

  child.on('close', (code) => {
    pool.running = pool.running.filter((r) => r.id !== id);
    broadcast('job-end', {
      id, label: job.label, requestedBy: job.requestedBy, code, stats, reportUrls: job.reportUrls || null,
      queue: allQueued().map((j) => ({ label: j.label, requestedBy: j.requestedBy })),
    });
    processQueue(suite);
  });

  child.on('error', (err) => {
    broadcast('line', { id, label: job.label, requestedBy: job.requestedBy, stream: 'stderr', text: `Failed to start: ${err.message}` });
  });

  // Try to fill this suite's next slot too - if SUITE_MAX_PARALLEL allows it, this recurses immediately and
  // (since pool.running now includes the job just started) hits the stagger check above, scheduling itself
  // for STAGGER_MS later instead of launching back-to-back.
  processQueue(suite);
}

// Loopback only by default (the installed desktop app has no reason to be reachable from other machines, and
// there's no auth here - see EMAIL_RE above). The shared web Runner the team opens at http://<this-pc>:3000
// sets RUNNER_HOST=0.0.0.0 to listen on the network (2026-10-14: the team's URL stopped working when the
// default became loopback). Never on in the packaged app.
const HOST = !PACKAGED && process.env.RUNNER_HOST ? process.env.RUNNER_HOST : '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Test runner UI: http://localhost:${PORT}` + (HOST === '127.0.0.1' ? ' (this PC only)' : ` (network: http://${require('os').hostname()}:${PORT})`));
  console.log(`  Policy suite dir: ${POLICY_DIR}`);
  console.log(`  Claims suite dir: ${CLAIMS_DIR}`);
  console.log(`  Reconciliation project dir: ${RECON_DIR}`);
  if (PACKAGED) console.log(`  Packaged build - bundled Node: ${BUNDLED_NODE_EXEC}`);
});

module.exports = { app };
