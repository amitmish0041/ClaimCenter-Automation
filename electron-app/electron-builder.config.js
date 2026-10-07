// electron-app/electron-builder.config.js
//
// A JS (not static JSON/package.json "build" key) config so extraResources
// can reference the SAME computed staging path stage-resources.js writes to
// (see staging-path.js) - both must always agree on where that is.
'use strict';

const path = require('path');
const STAGING = require('./scripts/staging-path.js');

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
  extraResources: [
    { from: path.join(STAGING, 'policy-repo'), to: 'policy-repo' },
    { from: path.join(STAGING, 'ClaimCenter-Automation'), to: 'ClaimCenter-Automation' },
    { from: path.join(STAGING, 'playwright-browsers'), to: 'playwright-browsers' },
  ],
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
  },
};
