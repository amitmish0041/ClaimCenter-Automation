#!/usr/bin/env node
/**
 * scripts/establishS3Session.js  ("Establish S3 Session" in the Runner)
 * Refreshes the SHARED S3 (Okta) session with no manual steps.
 *
 * - On the owner's PC (can write the shared session file): opens a visible browser, types the owner's email,
 *   clicks Next / SSO, and saves the cookies once the admin tool loads (helpers/s3Download/renewSession.js).
 *   If Okta ever asks for a password/MFA the window stays open for up to 10 minutes so it can be finished by hand.
 * - On anyone else's PC (team app — the share is read-only for them): drops a request file in the team's
 *   run-history folder; the owner's PC picks it up within ~2 minutes (scheduled task "SmartCOMM S3 session
 *   requests" → scripts/serveS3SessionRequests.js), signs in the same way on the owner's machine, and this
 *   script waits until the shared session file is updated.
 *
 * Usage: node scripts/establishS3Session.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
process.env.SMARTCOMM_OKTA_SESSION_FILE = process.env.SMARTCOMM_OKTA_SESSION_FILE
  || '\\\\dmi-win-fs1\\Public\\Amit Int\\SmartComm\\smartcomm-okta-session.json';
const SESSION_FILE = process.env.SMARTCOMM_OKTA_SESSION_FILE;
const REQUEST_FILE = path.join(process.env.SMARTCOMM_SHARED_RUNS_DIR || '\\\\dmi-win-fs1\\Public\\Amit Int\\SmartComm\\run-history',
  's3-session-request.json');

function canWriteSessionFolder() {
  const probe = path.join(path.dirname(SESSION_FILE), `.write-probe-${process.pid}`);
  try { fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe); return true; } catch (_) { return false; }
}
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; } };

async function ownerSignIn() {
  const { renewSharedSession } = require('../helpers/s3Download/renewSession');
  return renewSharedSession({ log: console.log, headed: true, waitForHuman: true, timeoutMs: 600000 });
}

async function requestFromOwner() {
  const before = mtime(SESSION_FILE);
  fs.writeFileSync(REQUEST_FILE, JSON.stringify({ requestedBy: os.userInfo().username, host: os.hostname(), at: new Date().toISOString() }));
  console.log('Asked the session owner\'s PC to sign in to S3 (email + SSO, automatic). Waiting up to 6 minutes...');
  const deadline = Date.now() + 6 * 60000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10000));
    if (mtime(SESSION_FILE) > before) { console.log('Shared S3 session refreshed — you can run S3 jobs again.'); return true; }
  }
  console.error('The owner\'s PC did not refresh the session within 6 minutes (it may be off or signed out). Let the tool owner know.');
  return false;
}

(canWriteSessionFolder() ? ownerSignIn() : requestFromOwner())
  .then((ok) => { process.exitCode = ok ? 0 : 1; })
  .catch((e) => { console.error(`[S3 session] ${e.message}`); process.exitCode = 1; });
