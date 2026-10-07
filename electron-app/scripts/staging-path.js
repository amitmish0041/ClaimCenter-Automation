// electron-app/scripts/staging-path.js
//
// Single source of truth for where staged build resources live - shared by
// stage-resources.js (writes here) and electron-builder.config.js (reads
// from here via extraResources), so the two can never drift out of sync.
//
// Deliberately OUTSIDE both source repos (os.tmpdir(), not a folder under
// either repo): electron-app/ lives INSIDE ClaimCenter-Automation, so a
// staging folder anywhere under that repo is "copy a directory into its own
// subdirectory" - Node's fs.cpSync refuses this outright (ERR_FS_CP_EINVAL),
// confirmed live. tmpdir() is a stable, well-known location regardless of
// which machine or user account runs the build, and never collides with
// either repo's own git tree.
'use strict';

const os = require('os');
const path = require('path');

module.exports = path.join(os.tmpdir(), 'claimcenter-runner-staging');
