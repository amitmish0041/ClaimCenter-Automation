#!/usr/bin/env node
/**
 * scripts/serveS3SessionRequests.js — runs on the session owner's PC every 2 minutes (scheduled task
 * "SmartCOMM S3 session requests"). When a teammate's Runner asked for a fresh S3 session (establishS3Session.js
 * wrote s3-session-request.json), signs in on this machine — visible browser, email + SSO, no password — and
 * removes the request. Does nothing when there's no request.
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
process.env.SMARTCOMM_OKTA_SESSION_FILE = process.env.SMARTCOMM_OKTA_SESSION_FILE
  || '\\\\dmi-win-fs1\\Public\\Amit Int\\SmartComm\\smartcomm-okta-session.json';
const REQUEST_FILE = path.join(process.env.SMARTCOMM_SHARED_RUNS_DIR || '\\\\dmi-win-fs1\\Public\\Amit Int\\SmartComm\\run-history',
  's3-session-request.json');

if (!fs.existsSync(REQUEST_FILE)) process.exit(0);
let req = '';
try { req = fs.readFileSync(REQUEST_FILE, 'utf8'); fs.unlinkSync(REQUEST_FILE); } catch (_) { process.exit(0); }
console.log(`${new Date().toISOString()} S3 session requested: ${req}`);
require('../helpers/s3Download/renewSession')
  .renewSharedSession({ log: console.log, headed: true, waitForHuman: true, timeoutMs: 300000 })
  .then((ok) => { process.exitCode = ok ? 0 : 1; })
  .catch((e) => { console.error(`[S3 session] ${e.message}`); process.exitCode = 1; });
