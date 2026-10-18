// Offline checks of how a mapping doc's BA comments become requirements (templateRequirementService), using small
// Word docs built here. Run with: npm run test:offline
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const trs = require('../../helpers/smartComm/templateRequirementService');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const commented = (id, t) => `<w:commentRangeStart w:id="${id}"/>${run(t)}<w:commentRangeEnd w:id="${id}"/>`;

// One mapping doc: paragraphs are arrays of plain strings and [commentId, anchoredText] pairs.
function buildDoc(dir, dig, paragraphs, comments) {
  const body = paragraphs.map((parts) => `<w:p>${parts.map((x) => (Array.isArray(x) ? commented(x[0], x[1]) : run(x))).join('')}</w:p>`).join('');
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(`<w:document ${W}><w:body>${body}</w:body></w:document>`));
  zip.addFile('word/comments.xml', Buffer.from(`<w:comments ${W}>${Object.entries(comments).map(([id, t]) => `<w:comment w:id="${id}" w:author="BA"><w:p>${run(t)}</w:p></w:comment>`).join('')}</w:comments>`));
  const templatesDir = path.join(dir, 'Templates', 'ClaimCenter');
  fs.mkdirSync(templatesDir, { recursive: true });
  zip.writeZip(path.join(templatesDir, `${dig}_Test.docx`));
  return { digNumber: dig, templateMappingDoc: `${dig}_Test.docx` };
}

async function requirementsFor(paragraphs, comments) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapdoc-'));
  const template = buildDoc(dir, 'DIG900', paragraphs, comments);
  const log = console.log;
  console.log = () => {};
  try { return await trs.getRequirements(template, dir); } finally { console.log = log; }
}
const statics = (reqs) => reqs.filter((r) => r.type === 'requiredText' && /^Static content/.test(r.description)).map((r) => r.expectedValue);

test('commented fields are dynamic; the text around them is fixed wording', async () => {
  const { requirements, mode } = await requirementsFor(
    [['Dear ', [1, 'John Smith'], ','], ['Your policy ', [0, 'ABC123'], ' was cancelled effective today.']],
    { 0: 'Policy Number', 1: 'Claimant Name' },
  );
  assert.equal(mode, 'comments');
  assert.ok(statics(requirements).some((t) => /was cancelled effective today\./.test(t)), 'fixed wording after the field is checked');
  assert.ok(!statics(requirements).some((t) => /ABC123/.test(t)), 'the sample value itself is not fixed wording');
});

test('a comment ending mid-word takes the rest of the word (DIG74 "Policy Cancellation No|tice")', async () => {
  const { requirements } = await requirementsFor(
    [['Dear ', [1, 'John Smith'], ','], ['Please see the Policy Cancellation ', [0, 'No'], 'tice attached for your records today.']],
    { 0: 'Policy Number', 1: 'Claimant Name' },
  );
  const fixed = statics(requirements);
  assert.ok(!fixed.some((t) => /^tice\b/.test(t)), `no "tice ..." fragment: ${JSON.stringify(fixed)}`);
  assert.ok(fixed.some((t) => /^attached for your records today\./.test(t)), `wording after the word is kept: ${JSON.stringify(fixed)}`);
});

test('"User can …" editor-mechanics notes are not checked as values', async () => {
  const { requirements } = await requirementsFor(
    [['Dear ', [1, 'John Smith'], ','], ['Status: ', [0, 'Open'], ' as of today for this claim file.']],
    { 0: 'User can dynamically select the status', 1: 'Claimant Name' },
  );
  const status = requirements.find((r) => /user can dynamically select/i.test(r.fieldName || ''));
  assert.ok(status, 'the note becomes a requirement');
  assert.equal(status.enabled, false, 'but it is switched off');
  assert.match(status.disabledReason, /editor's own mechanics/);
});
