/**
 * helpers/oneInc/profiles/recurrenceToken.js — claims carrying a stored-token recurring check set (scripts/oneIncPayeePrep.js
 * slots recur-wc / recur-pa; the payee accepts the first check as Direct Deposit with the texted code). The claim is read
 * from the payee-prep ledger (<TestData>/payee-prep-<tier>.json) each time, so a re-prepared slot is picked up without an
 * edit here. Added 2026-11-12.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const fromLedger = (slot) => {
  try {
    const dir = path.dirname(require('../claimPicker').POOL_FILE);
    const l = JSON.parse(fs.readFileSync(path.join(dir, `payee-prep-${(process.env.CC_TIER || 'test').toLowerCase()}.json`), 'utf8'));
    return l.filter((e) => e.slot === slot && e.claim && e.status !== 'failed').map((e) => e.claim).slice(-1);
  } catch (_) { return []; }
};
const one = (label, lob, prefix, slot) => {
  const p = { label, lob, state: 'PA', prefix, poolOnly: true };
  Object.defineProperty(p, 'seed', { enumerable: true, get: () => fromLedger(slot) });
  return p;
};
module.exports = {
  REC_WC: one('PA workers comp claim with a Weekly recurring check set to the claimant whose first check was accepted as Direct Deposit (stored token, $1.91)', 'WC', /^WC-PA-/, 'recur-wc'),
  REC_PA: one('PA auto claim with a Weekly recurring check set to the insured whose first check was accepted as Direct Deposit (stored token, $1.92)', 'AUTO', /^PA-PA-/, 'recur-pa'),
};
