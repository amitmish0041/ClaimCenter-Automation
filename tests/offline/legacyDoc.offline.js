// Offline checks that a legacy .doc mapping doc's BA comments are used (templateRequirementService converts it to a
// .docx copy first), using a DIG39-shaped doc built here. The real round trip needs LibreOffice and is skipped
// without it; on the team's PCs Word does the conversion. Run with: npm run test:offline
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const AdmZip = require('adm-zip');
const trs = require('../../helpers/smartComm/templateRequirementService');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const run = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const commented = (id, t) => `<w:commentRangeStart w:id="${id}"/>${run(t)}<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`;

// DIG39 as the BA wrote it (2026-10-19): the claim number and the sworn person's name are commented fields.
const DIG39 = {
  paragraphs: [
    [[0, 'CA-DE-01-26-0747093']],
    ['AFFIDAVIT'],
    ['I, ', [1, 'Rachel Derliunas'], ', being first duly sworn according to law, depose and say that neither myself, nor any relatives of mine own a vehicle.'],
    ['Signed, sealed and delivered this day.'],
  ],
  comments: { 0: 'Claim Number', 1: 'To Name' },
};

// A complete .docx (LibreOffice won't open one without its content types and relationships).
function writeDocx(file, { paragraphs, comments }) {
  const body = paragraphs.map((parts) => `<w:p>${parts.map((x) => (Array.isArray(x) ? commented(x[0], x[1]) : run(x))).join('')}</w:p>`).join('');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/comments" Target="comments.xml"/></Relationships>`));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`));
  zip.addFile('word/comments.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}>${Object.entries(comments).map(([id, t]) => `<w:comment w:id="${id}" w:author="BA" w:initials="BA"><w:p>${run(t)}</w:p></w:comment>`).join('')}</w:comments>`));
  zip.writeZip(file);
}

const SOFFICE = ['/usr/bin/soffice', '/usr/local/bin/soffice', 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'].find((p) => fs.existsSync(p));

// A templates folder holding DIG39 as a legacy .doc (made by saving the .docx above as Word 97-2003).
let legacyDir = null;
function legacyDoc() {
  if (legacyDir) return legacyDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacydoc-'));
  const templatesDir = path.join(dir, 'Templates', 'ClaimCenter');
  fs.mkdirSync(templatesDir, { recursive: true });
  const src = path.join(dir, 'DIG39_Affidavit_of_No_Insurance.docx');
  writeDocx(src, DIG39);
  childProcess.execFileSync(SOFFICE, ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'doc:MS Word 97', '--outdir', templatesDir, src], { stdio: 'pipe', timeout: 120000 });
  legacyDir = dir;
  return dir;
}
const TEMPLATE = { digNumber: 'DIG39', templateMappingDoc: 'DIG39_Affidavit_of_No_Insurance.doc' };
async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
}
const statics = (reqs) => reqs.filter((r) => r.type === 'requiredText' && /^Static content/.test(r.description)).map((r) => r.expectedValue);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('a legacy .doc is read through its BA comments: sample claim number and name are not fixed wording', { skip: !SOFFICE && 'LibreOffice not installed' }, async () => {
  const dir = legacyDoc();
  const docFile = path.join(dir, 'Templates', 'ClaimCenter', TEMPLATE.templateMappingDoc);
  const before = sha(docFile);
  const r = await quietly(() => trs.getRequirements(TEMPLATE, dir));
  assert.equal(r.mode, 'comments');
  assert.equal(r.convertedFrom, docFile);
  assert.ok(r.sourceFile.endsWith('.docx') && r.sourceFile.startsWith(trs._test.DOC_CACHE_DIR), r.sourceFile);
  const fixed = statics(r.requirements).join(' | ');
  assert.ok(!/0747093/.test(fixed), `claim number is not fixed wording: ${fixed}`);
  assert.ok(!/Derliunas/.test(fixed), `the sample name is not fixed wording: ${fixed}`);
  assert.ok(/being first duly sworn/.test(fixed), `the wording around the name still is: ${fixed}`);
  assert.ok(r.requirements.some((q) => q.fieldName === 'Claim Number'), 'the claim number is a field check');
  assert.ok(r.requirements.some((q) => q.fieldName === 'To Name'), 'the name is a field check');
  assert.equal(sha(docFile), before, "the BA's .doc is left untouched");
});

test('the converted copy is reused until the .doc changes', { skip: !SOFFICE && 'LibreOffice not installed' }, async () => {
  const dir = legacyDoc();
  const first = await quietly(() => trs.getRequirements(TEMPLATE, dir));
  let calls = 0;
  trs._test.setDocConverters([['counting', () => { calls++; return false; }]]);
  try {
    const again = await quietly(() => trs.getRequirements(TEMPLATE, dir));
    assert.equal(again.sourceFile, first.sourceFile);
    assert.equal(calls, 0, 'no second conversion');
  } finally { trs._test.setDocConverters(null); }
});

test('with no converter, a .doc still falls back to its text (heuristic-doc)', { skip: !SOFFICE && 'LibreOffice not installed' }, async () => {
  const dir = legacyDoc();
  const prev = process.env.SMARTCOMM_DOC_CONVERT;
  process.env.SMARTCOMM_DOC_CONVERT = '0';
  try {
    const r = await quietly(() => trs.getRequirements(TEMPLATE, dir));
    assert.equal(r.mode, 'heuristic-doc');
    assert.ok(r.sourceFile.endsWith('.doc'));
    assert.ok(r.requirements.length > 0);
  } finally {
    if (prev === undefined) delete process.env.SMARTCOMM_DOC_CONVERT; else process.env.SMARTCOMM_DOC_CONVERT = prev;
  }
});

test('a .docx saved next to the .doc (same name) is read instead, with no conversion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacydoc-sib-'));
  const templatesDir = path.join(dir, 'Templates', 'ClaimCenter');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, 'DIG39_Affidavit_of_No_Insurance.doc'), 'old binary file');
  writeDocx(path.join(templatesDir, 'DIG39_Affidavit_of_No_Insurance.docx'), DIG39);
  trs._test.setDocConverters([['never', () => { throw new Error('should not convert'); }]]);
  try {
    const r = await quietly(() => trs.getRequirements(TEMPLATE, dir));
    assert.equal(r.mode, 'comments');
    assert.equal(r.sourceFile, path.join(templatesDir, 'DIG39_Affidavit_of_No_Insurance.docx'));
    assert.equal(r.convertedFrom, undefined);
  } finally { trs._test.setDocConverters(null); }
});

test('a legacy .doc with no comments keeps the plain-text reading it had before', { skip: !SOFFICE && 'LibreOffice not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacydoc-plain-'));
  const templatesDir = path.join(dir, 'Templates', 'ClaimCenter');
  fs.mkdirSync(templatesDir, { recursive: true });
  const src = path.join(dir, 'DIG39_Affidavit_of_No_Insurance.docx');
  writeDocx(src, { paragraphs: DIG39.paragraphs.map((parts) => parts.map((x) => (Array.isArray(x) ? x[1] : x))), comments: {} });
  childProcess.execFileSync(SOFFICE, ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'doc:MS Word 97', '--outdir', templatesDir, src], { stdio: 'pipe', timeout: 120000 });
  const r = await quietly(() => trs.getRequirements(TEMPLATE, dir));
  assert.equal(r.mode, 'heuristic-doc');
  assert.ok(r.sourceFile.endsWith('.doc'));
});

test('a commented .doc whose text has an exposure table keeps the text reading (DIG26)', { skip: !SOFFICE && 'LibreOffice not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacydoc-exp-'));
  const templatesDir = path.join(dir, 'Templates', 'ClaimCenter');
  fs.mkdirSync(templatesDir, { recursive: true });
  const src = path.join(dir, 'DIG26_Claim_Status_Report.docx');
  writeDocx(src, {
    paragraphs: [['Claim Status Report as of ', [0, '05/12/2026']], ['Type  Reserves  Paid  Expenses  Recoveries  Net Incurred'],
      [[1, 'Bodily Injury Liability'], '  $100.00  $0.00  $0.00  $0.00  $100.00'], ['Total  $100.00  $0.00  $0.00  $0.00  $100.00']],
    comments: { 0: 'Date of Letter', 1: 'Exposure Type' },
  });
  childProcess.execFileSync(SOFFICE, ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'doc:MS Word 97', '--outdir', templatesDir, src], { stdio: 'pipe', timeout: 120000 });
  const r = await quietly(() => trs.getRequirements({ digNumber: 'DIG26', templateMappingDoc: 'DIG26_Claim_Status_Report.doc' }, dir));
  assert.equal(r.mode, 'heuristic-doc');
  assert.ok(r.requirements.some((q) => q.type === 'exposureTable') && r.requirements.some((q) => q.type === 'exposureColumnTotals'));
});
