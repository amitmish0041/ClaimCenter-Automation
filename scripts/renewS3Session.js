#!/usr/bin/env node
/**
 * scripts/renewS3Session.js
 * Renews the SHARED S3 (Okta) sign-in session unattended: opens the S3 admin tool, enters the owner's corporate
 * email, clicks Next / SSO, and once the admin tool loads saves the cookies to the shared session file every
 * installed copy reads (SMARTCOMM_OKTA_SESSION_FILE, default the team-drive file below).
 *
 * CONFIRMED 2026-10-14: for the owner's account Okta signs in from the email alone (no password/MFA) on this PC,
 * so this replaces the manual establishS3Session.js whenever runs report S3_SHARED_SESSION_EXPIRED. It never
 * types a password: if Okta asks for one (or MFA), it stops and says so — then use establishS3Session.js at the
 * desk. Run only when the session has expired (owner direction: not on a timer).
 *
 * Usage: node scripts/renewS3Session.js            (exit 0 = renewed, non-zero = not renewed)
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
// The owner's shared file on the team drive (UNC, so it works without the V: mapping). Set before the store loads.
process.env.SMARTCOMM_OKTA_SESSION_FILE = process.env.SMARTCOMM_OKTA_SESSION_FILE
  || '\\\\dmi-win-fs1\\Public\\Amit Int\\SmartComm\\smartcomm-okta-session.json';
const { renewSharedSession } = require('../helpers/s3Download/renewSession');

renewSharedSession({ log: console.log, headed: process.argv.includes('--headed') })
  .then((ok) => { process.exitCode = ok ? 0 : 1; })
  .catch((e) => { console.error(`[S3 renew] ${e.message}`); process.exitCode = 1; });
