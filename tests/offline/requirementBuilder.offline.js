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

test('digits glued onto a commented part of a number are not fixed wording (DIG168)', async () => {
  const { requirements } = await requirementsFor(
    [['=1', [0, '0'], '% of NADA value'], ['=(100,000-', [1, '12,500'], ')/1', [2, '00,000']], ['Modifier ', [3, '0.75'], ' (41% - 55%)']],
    { 0: 'NADA Percent', 1: 'Mileage Amount', 2: 'Mileage Base', 3: 'Damage Modifier' },
  );
  const fixed = statics(requirements);
  for (const piece of ['=1', ')/1']) assert.ok(!fixed.includes(piece), `"${piece}" is not checked: ${JSON.stringify(fixed)}`);
  assert.ok(fixed.includes('% of NADA value'), 'wording glued to a value is still checked');
  assert.ok(fixed.includes('=(100,000-'), 'longer pieces are still checked');
  assert.ok(fixed.includes('Modifier') && fixed.includes('(41% - 55%)'), 'pieces separated by a space are unchanged');
});

test('Word tabs separate side-by-side columns instead of gluing them (DIG122A "VacuumingOther", DIG75 address block)', async () => {
  const TAB = '</w:t><w:tab/><w:t xml:space="preserve">'; // a tab inside a run, as Word writes it
  const { requirements } = await requirementsFor(
    [['Dear ', [0, 'John Smith'], ','],
      [`Vacuuming${TAB}${TAB}Other: ______________`],
      [`Our mailing address is:${TAB}${TAB}${TAB}${TAB}Our overnight address is:`],
      [`RE:${TAB}Our Claim No.:`]],
    { 0: 'Claimant Name' },
  );
  const fixed = statics(requirements);
  assert.ok(fixed.includes('Vacuuming') && fixed.includes('Other: ______________'), `columns are separate checks: ${JSON.stringify(fixed)}`);
  assert.ok(fixed.includes('Our mailing address is:') && fixed.includes('Our overnight address is:'), `address columns split: ${JSON.stringify(fixed)}`);
  assert.ok(!fixed.some((t) => /VacuumingOther|is:Our/.test(t)), `nothing glued: ${JSON.stringify(fixed)}`);
});

test('free-form blanks are listed with their row label (SMART-1522, DIG220)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapdoc-'));
  const cell = (inner) => `<w:tc><w:p>${inner}</w:p></w:tc>`;
  const blank = (id) => `<w:commentRangeStart w:id="${id}"/><w:r><w:t xml:space="preserve"> </w:t></w:r><w:commentRangeEnd w:id="${id}"/>`;
  const body = `<w:p>${run('Dear ')}${commented(0, 'John Smith')}</w:p>`
    + `<w:tbl><w:tr>${cell(run('j. Working with biohazards'))}${cell('')}${cell(blank(1))}</w:tr>`
    + `<w:tr>${cell(run('COMPLETED BY:'))}${cell(blank(2))}${cell(run('SPOKE WITH:'))}${cell(blank(3))}</w:tr></w:tbl>`;
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(`<w:document ${W}><w:body>${body}</w:body></w:document>`));
  const comments = { 0: 'Claimant Name', 1: 'Free Form/Editable', 2: 'Free Form/Editable', 3: 'Free Form/Editable' };
  zip.addFile('word/comments.xml', Buffer.from(`<w:comments ${W}>${Object.entries(comments).map(([id, t]) => `<w:comment w:id="${id}" w:author="BA"><w:p>${run(t)}</w:p></w:comment>`).join('')}</w:comments>`));
  const templatesDir = path.join(dir, 'Templates', 'ClaimCenter');
  fs.mkdirSync(templatesDir, { recursive: true });
  zip.writeZip(path.join(templatesDir, 'DIG901_Test.docx'));
  const log = console.log; console.log = () => {};
  let res;
  try { res = await trs.getRequirements({ digNumber: 'DIG901', templateMappingDoc: 'DIG901_Test.docx' }, dir); } finally { console.log = log; }
  assert.deepEqual(res.freeFormFields.map((f) => f.label), ['j. Working with biohazards', 'COMPLETED BY:', 'SPOKE WITH:']);
});
