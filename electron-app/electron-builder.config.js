// electron-app/electron-builder.config.js
//
// A JS (not static JSON/package.json "build" key) config so extraResources
// can reference the SAME computed staging path stage-resources.js writes to
// (see staging-path.js) - both must always agree on where that is.
'use strict';

const fs = require('fs');
const path = require('path');
const STAGING = require('./scripts/staging-path.js');

const extraResources = [
  { from: path.join(STAGING, 'policy-repo'), to: 'policy-repo' },
  { from: path.join(STAGING, 'ClaimCenter-Automation'), to: 'ClaimCenter-Automation' },
  { from: path.join(STAGING, 'playwright-browsers'), to: 'playwright-browsers' },
];
// Conditional: stage-resources.js only creates this when it actually found a source folder to copy (see its
// own warning there) - electron-builder errors outright on an extraResources.from path that doesn't exist.
const smartCommDataStaged = path.join(STAGING, 'smartcomm-data');
if (fs.existsSync(smartCommDataStaged)) {
  extraResources.push({ from: smartCommDataStaged, to: 'smartcomm-data' });
}

module.exports = {
  appId: 'com.donegalgroup.claimcenter-runner',
  productName: 'ClaimCenter Runner',
  directories: {
    output: 'dist',
  },
  files: [
    '**/*',
    '!.staging/**',
    '!scripts/**',
    '!entitlements/**',
    '!build/**',
    '!*.md',
    '!.gitignore',
    '!electron-builder.config.js',
  ],
  extraResources,
  win: {
    target: 'nsis',
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
  },
  publish: {
    provider: 'github',
    owner: 'amitmish0041',
    repo: 'ClaimCenter-Automation',
    // electron-builder defaults to releaseType:'draft', which uploads the installer into an UNPUBLISHED draft
    // release - invisible to the public API and to electron-updater, so nobody auto-updates until someone
    // clicks "Publish" in the GitHub UI. 'release' publishes it live immediately, which is what we want here
    // (to pull a bad one, mark that release a pre-release on GitHub - electron-updater stops offering it).
    releaseType: 'release',
  },
};
