// Offline checks of payloadXpathService value resolution. Run with: npm run test:offline
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const px = require('../../helpers/smartComm/payloadXpathService');

const payload = (addr) => `<ccDocumentCreationRequest><claim><contacts><contacts><primaryAddress><displayName>${addr}</displayName></primaryAddress></contacts></contacts></claim></ccDocumentCreationRequest>`;
const XPATH = 'ccDocumentCreationRequest.claim.contacts.contacts.primaryAddress.displayName';

test('ClaimCenter\'s "See Policy Tab" placeholder address is no value (DIG203/210/218 WC claimant address)', () => {
  const r = px.resolveXpath(payload('See Policy Tab'), XPATH);
  assert.equal(r.value, undefined);
  assert.equal(r.placeholder, true);
});

test('a real address still resolves', () => {
  assert.equal(px.resolveXpath(payload('490 CRAIG RD, NORTH ABINGTON TOWNSHIP, PA 18414'), XPATH).value, '490 CRAIG RD, NORTH ABINGTON TOWNSHIP, PA 18414');
});
