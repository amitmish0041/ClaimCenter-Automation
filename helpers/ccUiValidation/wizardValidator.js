/**
 * helpers/ccUiValidation/wizardValidator.js
 * Compares the "Documents - Create Correspondence" spec (specService) against
 * the LIVE ClaimCenter Cloud "Create New Document" wizard: field visibility /
 * mandatory / defaults, typelist (dropdown) values, and the conditional
 * Recipients-tab behaviour. Nothing is generated, saved or sent — it only
 * navigates the wizard, flips the Delivery Channel dropdown, and reads state.
 *
 * Result values (same shape as the SmartCOMM template validator so reports can
 * be shared later): PASS | FAIL | REVIEW (differs, may be acceptable — needs a
 * human call) | BLOCKED (cannot be verified automatically yet / safely).
 */
'use strict';
const R = require('./uiReader');
const documentService = require('../smartComm/documentService');
const catalogService = require('../smartComm/catalogService');

const { norm, isNoneOption, row, checkTypelist, checkFieldRow, pickVisible } = require('./checks');
const { filterDocumentsSection, documentPropertiesSection } = require('./documentScreens');
const { br2Section } = require('./activityPatterns');
const { br1Section } = require('./writeScenarios');

// ── section runners ──────────────────────────────────────────────────────────
async function selectTemplateSection(page, spec, out) {
  const screen = 'Select Template';
  const snap = await R.readFields(page);
  const buttons = await R.readButtons(page);
  const grids = await R.readGrids(page);
  const headers = (grids[0] && grids[0].headers.filter(Boolean)) || [];

  for (const f of spec.uiFields.filter((x) => x.screen === screen)) {
    if (f.section === 'Search Results') {
      const found = headers.some((h) => norm(h) === norm(f.label));
      out.push(row(f.reqId || `${screen} › Results › ${f.label}`, screen, `${screen}: Search Results column "${f.label}"`,
        found ? 'PASS' : 'FAIL', 'column shown', found ? 'column shown' : `columns: ${headers.join(', ') || '(none)'}`));
    } else if (/^button$/i.test(f.fieldType)) {
      const found = buttons.some((b) => norm(b.label) === norm(f.label));
      out.push(row(f.reqId || `${screen} › ${f.label}`, screen, `${screen}: ${f.label} button`, found ? 'PASS' : 'FAIL', 'button shown', found ? 'button shown' : 'not present'));
    } else {
      out.push(checkFieldRow(f, pickVisible(snap.fields, f.label)));
    }
  }

  const tl = spec.typelists;
  const opt = (label) => (pickVisible(snap.fields, label) || {}).options || [];
  out.push(checkTypelist({ id: 'TL.DocumentType', screen, description: 'Typelist DocumentType — Select Template "Type" options', specValues: tl.DocumentType || [], liveOptions: opt('Type'), exhaustive: false, prefixMatch: true }));
  out.push(checkTypelist({ id: 'TL.LineofBusiness', screen, description: 'Typelist LineofBusiness — Select Template "Line of Business" options', specValues: tl.LineofBusiness || [], liveOptions: opt('Line of Business'), exhaustive: true }));
  out.push(checkTypelist({ id: 'TL.Section', screen, description: 'Typelist Section — Select Template "Section" options', specValues: tl.Section || [], liveOptions: opt('Section'), exhaustive: true }));
  out.push(checkTypelist({ id: 'TL.Jurisdiction', screen, description: 'Typelist Jurisdiction — Select Template "Jurisdiction" options', specValues: tl.Jurisdiction || [], liveOptions: opt('Jurisdiction'), exhaustive: true }));
}

// UIF.004: Name search must be a "Contains" search (screen used to require the exact registered name).
async function containsSearchCheck(page, templateName, out) {
  const screen = 'Select Template';
  const partial = templateName.includes(' ') ? templateName.split(' ').slice(1).join(' ') : templateName.slice(2);
  const nameField = page.getByRole('textbox', { name: 'Name' }).first();
  await nameField.fill(partial);
  await nameField.press('Tab');
  await page.locator('[id$="SearchLinksInputSet-Search"]').click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const hit = await page.getByRole('row', { name: new RegExp(templateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first()
    .waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  out.push(row('UIF.004', screen, `${screen}: Name search is a "Contains" search`,
    hit ? 'PASS' : 'FAIL', `searching the partial name "${partial}" returns "${templateName}"`,
    hit ? `partial search "${partial}" returned the template` : `partial search "${partial}" returned no matching row`));
}

async function recipientsSection(page, spec, out, { dialogs }) {
  const screen = 'Recipients';
  const fld = (label) => spec.uiFields.find((f) => f.screen === screen && norm(f.label) === norm(label));

  await page.getByRole('tab', { name: 'Recipients', exact: true }).click();
  await page.waitForTimeout(1200);
  let buttons = await R.readButtons(page);
  const has = (b, label) => b.some((x) => norm(x.label) === norm(label));

  // Additional Recipient — CONDITIONAL: only after a primary recipient exists.
  const beforeShown = has(buttons, 'Additional Recipient');
  out.push(row('REC.buttons.before', screen, 'Recipients: Set Primary Recipient / Remove shown; Additional Recipient hidden until a primary recipient is set',
    has(buttons, 'Set Primary Recipient') && has(buttons, 'Remove') && !beforeShown ? 'PASS' : 'FAIL',
    'Set Primary Recipient + Remove shown, Additional Recipient hidden',
    `shown: ${buttons.map((b) => b.label).join(', ')}`));

  await documentService.setPrimaryRecipient(page, {});
  await page.waitForTimeout(1200);
  buttons = await R.readButtons(page);
  out.push(row('REC.buttons.after', screen, 'Recipients: Additional Recipient appears once a primary recipient is set',
    has(buttons, 'Additional Recipient') ? 'PASS' : 'FAIL', 'Additional Recipient shown', `shown: ${buttons.map((b) => b.label).join(', ')}`));

  // Delivery Channel in each state.
  const states = {};
  states.none = await R.readRecipientsTab(page);
  for (const ch of ['Print', 'Email']) {
    await documentService.setDeliveryChannel(page, ch);
    await page.waitForTimeout(2200);
    states[ch] = await R.readRecipientsTab(page);
  }
  await documentService.setDeliveryChannel(page, 'Print'); // leave on Print (Email/Fax/SMS could contact real people)
  await page.waitForTimeout(1200);

  // Additional Recipient click raises a confirm popup; spec quotes the wording (note on the button row).
  const specMsgMatch = ((fld('Additional Recipient') || {}).notes || '').match(/says\s+"([^"]+)"/i);
  dialogs.length = 0;
  await page.getByRole('button', { name: 'Additional Recipient' }).click();
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape').catch(() => {});
  const liveMsg = dialogs[0];
  if (specMsgMatch) {
    const words = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
    const a = words(specMsgMatch[1]);
    const b = words(liveMsg || '');
    const diff = [...new Set([...a.filter((w) => !b.includes(w)), ...b.filter((w) => !a.includes(w))])];
    const result = !liveMsg ? 'FAIL' : norm(specMsgMatch[1]) === norm(liveMsg) ? 'PASS' : diff.length <= 2 ? 'REVIEW' : 'FAIL';
    out.push(row('REC.additionalPopup', screen, 'Recipients: Additional Recipient shows the courtesy-copy popup with the spec wording', result,
      specMsgMatch[1], liveMsg || 'no popup appeared', result === 'REVIEW' ? `wording differs: ${diff.join(', ')}` : ''));
  }

  // UIF.005 Delivery Channel dropdown + Delivery Channel typelist.
  const dcOptions = (states.none.deliveryChannel && states.none.deliveryChannel.options) || [];
  out.push(checkTypelist({ id: 'UIF.005', screen, description: 'Recipients: Delivery Channel dropdown values (UIF.005, typelist Delivery Channel)', specValues: spec.typelists['Delivery Channel'] || [], liveOptions: dcOptions, exhaustive: true }));

  // Grid columns Name / Phone / Email / Address.
  const headers = states.none.headers;
  for (const label of ['Delivery Channel', 'Name', 'Phone', 'Email', 'Address']) {
    const f = fld(label);
    if (!f) continue;
    const shown = headers.some((h) => norm(h) === norm(label));
    out.push(row(f.reqId || `${screen} › ${label}`, screen, `${screen}: ${label} column${f.changeType ? ` (${f.changeType})` : ''}`,
      shown ? 'PASS' : 'FAIL', 'column shown', shown ? 'column shown' : `columns: ${headers.join(', ')}`));
  }

  // UIF.002 Email mandatory when Delivery Channel = Email.
  const em = states.Email.email;
  out.push(row('UIF.002', screen, 'Recipients: Email is mandatory when Delivery Channel = Email (UIF.002)',
    em && em.required ? 'PASS' : 'FAIL', 'Email flagged mandatory when Delivery Channel = Email',
    em && em.present ? (em.required ? 'mandatory' : 'no mandatory marker') : 'Email field not shown',
    em && em.present && !em.required ? 'The screen shows no mandatory marker on Email for the Email channel (Print\'s conditional fields do show one). Server-side enforcement on Generate was NOT exercised — doing so with the Email channel could send a real email.' : ''));

  // UIF.006 / UIF.007 Return Envelope & Certified Mail: visible + mandatory only for Print.
  for (const [key, label, reqId] of [['returnEnvelope', 'Return Envelope', 'UIF.006'], ['certifiedMail', 'Certified Mail', 'UIF.007']]) {
    const p = states.Print[key];
    const e = states.Email[key];
    const n = states.none[key];
    const okPrint = p.present && p.required;
    const okOther = !e.present && !n.present;
    const f = fld(label);
    const problems = [];
    if (!p.present) problems.push('not shown for Print');
    else if (!p.required) problems.push('shown for Print but not marked mandatory');
    if (e.present) problems.push('still shown for Email');
    if (n.present) problems.push('shown while Delivery Channel is <none>');
    const soft = f && /^dropdown$/i.test(f.fieldType) && p.present && p.kind === 'radio' ? ['spec type is Dropdown (YesNo typelist); screen renders Yes/No radio buttons'] : [];
    out.push(row(reqId, screen, `Recipients: ${label} is visible and mandatory only when Delivery Channel = Print (${reqId})`,
      okPrint && okOther ? (soft.length ? 'REVIEW' : 'PASS') : 'FAIL',
      'Print: shown + mandatory; Email/<none>: hidden',
      `Print: ${p.present ? (p.required ? 'shown + mandatory' : 'shown, optional') : 'hidden'}; Email: ${e.present ? 'shown' : 'hidden'}; <none>: ${n.present ? 'shown' : 'hidden'}`,
      [...problems, ...soft].join(' | ')));
  }
}

async function additionalDataSection(page, spec, out, { templateDig }) {
  const screen = 'Additional Data';
  await page.getByRole('tab', { name: 'Additional Data', exact: true }).click();
  await page.waitForTimeout(1800);
  const snap = await R.readFields(page);
  const buttons = await R.readButtons(page);
  const visibleLabels = snap.fields.filter((f) => f.visible).map((f) => f.label);
  const rowsOnScreen = spec.uiFields.filter((x) => x.screen === screen);

  // Linked Documents table (UIF.035–UIF.041) reuses labels ("Name", "Status"...) that also exist as real form
  // fields — evaluate it as one group instead of matching each label individually.
  const isLinkedDocs = (f) => /^UIF\.0(3[5-9]|4[01])$/.test(f.reqId) && f.row < 70;
  const linkedRows = rowsOnScreen.filter(isLinkedDocs);

  for (const f of rowsOnScreen) {
    if (isLinkedDocs(f)) continue;
    if (/^button$/i.test(f.fieldType)) {
      const found = buttons.some((b) => norm(b.label) === norm(f.label));
      out.push(row(f.reqId || `${screen} › ${f.label}`, screen, `${screen}: ${f.label} button (${f.changeType})`, found ? 'PASS' : 'FAIL',
        'button shown', found ? 'button shown' : 'not present', found ? '' : 'Spec: navigates to the Filter Documents screen. The button is not on the Additional Data tab.'));
      continue;
    }
    if (norm(f.label) === 'lawfirm' && templateDig && !/199/.test(templateDig)) {
      const live = pickVisible(snap.fields, f.label);
      out.push(row(f.reqId, screen, `${screen}: Law Firm (New)`, live ? 'PASS' : 'REVIEW', 'shown (spec: "For DIG-199")',
        live ? 'shown' : `not shown for ${templateDig}`, live ? '' : 'The story adds Law Firm "for DIG-199"; re-run with --template DIG199 to confirm it appears for that template.'));
      continue;
    }
    if (f.label === 'Language') {
      const live = pickVisible(snap.fields, f.label);
      out.push(checkFieldRow(f, live));
      continue;
    }
    out.push(checkFieldRow(f, pickVisible(snap.fields, f.label)));
  }

  if (linkedRows.length) {
    const tableShown = visibleLabels.some((l) => norm(l) === 'linkeddocuments') ||
      (await page.getByText('Linked Documents', { exact: true }).first().isVisible().catch(() => false));
    out.push(row('UIF.035–041', screen, `${screen}: Linked Documents table (${linkedRows.length} spec rows: Name, Related To, Document Type, Status, Author, Uploaded)`,
      tableShown ? 'REVIEW' : 'FAIL', 'Linked Documents table shown',
      tableShown ? 'table heading shown (columns not individually verified)' : 'not present on the tab', tableShown ? 'Column-level verification not yet automated.' : 'No "Linked Documents" table on the Additional Data tab.'));
  }

  // Foreign-key / Related To option lists.
  const opt = (label) => (pickVisible(snap.fields, label) || {}).options || [];
  const relatedTo = opt('Related To');
  out.push(row('UIF.RelatedTo', screen, 'Additional Data: Related To lists the relatable claim entities (spec: Claim, Exposure, Contact, Matter, Service)',
    relatedTo.some((o) => norm(o) === 'claim') ? 'REVIEW' : 'FAIL', 'includes "Claim" plus the claim\'s exposures/contacts/matters/services',
    `${relatedTo.length} option(s): ${relatedTo.slice(0, 10).join(', ')}`, 'Only the "Claim" option is verified; option labels are entity names, so mapping the rest to Exposure/Contact/Matter/Service is not automated.'));
  for (const label of ['From', 'Attorney', 'Check', 'Doctor']) {
    const f = pickVisible(snap.fields, label);
    if (!f) continue;
    const entries = f.options.filter((o) => !isNoneOption(o));
    out.push(row(`UIF.list.${label}`, screen, `Additional Data: ${label} dropdown is populated from the claim`,
      entries.length ? 'PASS' : 'REVIEW', 'at least one selectable entry', `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}: ${entries.slice(0, 6).join(', ')}`,
      entries.length ? '' : 'Empty — may just mean this claim has none; try a claim with parties/checks.'));
  }

  // Typelists surfaced on this tab.
  const tl = spec.typelists;
  out.push(checkTypelist({ id: 'TL.Section.AD', screen, description: 'Typelist Section — Additional Data "Section" options', specValues: tl.Section || [], liveOptions: opt('Section'), exhaustive: true }));
  out.push(checkTypelist({ id: 'TL.DocumentType.AD', screen, description: 'Typelist DocumentType — Additional Data "Document Type" options', specValues: tl.DocumentType || [], liveOptions: opt('Document Type'), exhaustive: false, prefixMatch: true }));
  const lang = pickVisible(snap.fields, 'Language');
  out.push(lang
    ? checkTypelist({ id: 'TL.Language', screen, description: 'Typelist Language — Additional Data "Language" options', specValues: tl.Language || [], liveOptions: lang.options || [], exhaustive: true })
    : row('TL.Language', screen, 'Typelist Language — Additional Data "Language" options', 'BLOCKED', `${(tl.Language || []).length} value(s): ${(tl.Language || []).map((v) => v.label).join(', ')}`, 'Language field not shown', 'Cannot check the values — the field is missing from this tab (see the Language row above).'));
  const status = pickVisible(snap.fields, 'Status');
  out.push(row('TL.DocumentStatus', screen, 'Typelist DocumentStatus — Additional Data "Status" options', 'BLOCKED', 'values not listed in the spec (Typelists tab has no DocumentStatus rows)',
    status ? `${(status.options || []).length} option(s): ${(status.options || []).join(', ')}` : 'Status not shown', 'Spec gap — add the DocumentStatus values to the Typelists tab to enable this check.'));
}

async function createSection(page, spec, out) {
  const screen = 'Create';
  await page.getByRole('tab', { name: 'Create', exact: true }).click();
  await page.waitForTimeout(1500);
  const buttons = await R.readButtons(page);
  const snap = await R.readFields(page);
  const labels = [...buttons.map((b) => b.label), ...snap.fields.filter((f) => f.visible).map((f) => f.label)];
  const map = { 'on-demand': 'Generate', interactive: 'Interactive' };
  for (const f of spec.uiFields.filter((x) => x.screen === screen)) {
    const id = f.reqId || `${screen} › ${f.label}`;
    if (f.visible === false) {
      const shown = labels.some((l) => norm(l) === norm(f.label));
      out.push(row(id, screen, `${screen}: ${f.label} (${f.changeType})`, shown ? 'FAIL' : 'PASS', 'hidden', shown ? 'shown' : 'hidden'));
      continue;
    }
    const buttonLabel = map[f.label.toLowerCase()] || f.label;
    const b = buttons.find((x) => norm(x.label) === norm(buttonLabel));
    out.push(row(id, screen, `${screen}: ${f.label} button (${f.changeType}) — conditional on the SmartCOMM template's ${f.label} tag`,
      b && !b.disabled ? 'PASS' : 'FAIL', `"${buttonLabel}" button available`, b ? (b.disabled ? 'shown but disabled' : 'available') : 'not shown',
      'Only checks that the button is available for this template; which SmartCOMM tags the template returns is not observable from the screen.'));
  }
}

function specObservations(spec) {
  const obs = [];
  const seen = {};
  for (const f of spec.uiFields) if (f.reqId) (seen[f.reqId] = seen[f.reqId] || []).push(f);
  for (const [id, list] of Object.entries(seen)) {
    const distinct = new Set(list.map((f) => `${f.screen}|${f.label}`));
    if (distinct.size > 1) obs.push(`Requirement ID ${id} is used for more than one field: ${[...distinct].map((d) => d.replace('|', ' › ')).join(' / ')}.`);
  }
  obs.push('The Additional Data mock-up annotation reads "UIF.010: Hide Status Field", but the UI Fields tab lists UIF.010 as Inbound (hidden) and keeps Status visible and mandatory. Validated against the UI Fields tab.');
  obs.push('OOTB rows mark interactive dropdowns/buttons as Editable = false, so Editable is only asserted for New/Modified rows.');
  obs.push('Return Envelope / Certified Mail are typed "Dropdown (YesNo)" in the spec; the screen renders Yes/No radio buttons.');
  obs.push('UIF.003 says Address is read-only (Editable = false) yet its note says the user can select and change the address.');
  return obs;
}

async function runSection(name, fn, out) {
  try { return await fn(); } catch (e) {
    out.push(row(`ERR.${name}`, name, `${name}: section could not be completed`, 'BLOCKED', 'section runs', 'error', e.message.split('\n')[0]));
    return undefined;
  }
}


// Things the report should flag as "waiting on input" — decisions or information only the requirements owner /
// environment team can supply. Built from the results so it only lists what is actually outstanding.
function buildOpenItems(spec, v, observations) {
  const items = [];
  const has = (pred) => v.some(pred);
  const byId = (id) => v.find((x) => x.id === id);

  items.push({ ref: 'UIF.002', text: 'Email mandatory: enforcement on Generate was not tested. It needs the Email delivery channel with a blank address, which could send a real email — decision needed on whether to allow a guarded test.' });

  const notOffered = v.filter((x) => /^BR2\./.test(x.id) && x.actual === 'pattern not offered');
  if (notOffered.length) {
    const names = notOffered.map((x) => (x.description.match(/pattern "([^"]+)"/) || [])[1]).filter(Boolean);
    items.push({ ref: 'BR2', text: `${notOffered.length} of ${spec.activityPatterns.length} activity patterns were not offered in the New Activity menu of the claims scanned (${names.join('; ')}). Confirm whether they should exist in this environment, or provide the exact pattern names / claims that expose them.` });
  }
  if (has((x) => /^BR2\./.test(x.id) && x.result === 'FAIL')) {
    items.push({ ref: 'BR2', text: '"Create Document" button is missing on the activity patterns that do exist (GA Compliance, TN letter). Confirm whether it is delivered on the saved activity screen instead — saving the activity fails in Test with "Unable to parse value for parameter \'id\'".' });
  }
  const dupes = (observations || []).find((o) => /^Requirement ID/.test(o));
  if (dupes) items.push({ ref: 'Spec', text: `Duplicate requirement IDs in the UI Fields tab (${(observations.filter((o) => /^Requirement ID/.test(o)).map((o) => o.split(' ')[2]).join(', '))}) — please confirm the correct numbering.` });
  if (byId('TL.DocumentStatus')) items.push({ ref: 'Spec', text: 'DocumentStatus typelist values are not listed on the Typelists tab, so the Status dropdown cannot be checked.' });
  if (has((x) => x.id === 'UIF.010' || /Status/.test(x.description))) {
    items.push({ ref: 'Spec', text: 'Mock-up annotation says "UIF.010: Hide Status Field", while the UI Fields tab keeps Status visible and mandatory — confirm the intended behaviour.' });
  }
  if (has((x) => x.id === 'UIF.015' && x.result === 'FAIL')) {
    items.push({ ref: 'UIF.015–041', text: 'The Link button, the Linked Documents table and the Filter Documents screen are not in Test. Confirm deployment status; the screen-specific Filter Documents checks stay BLOCKED until then.' });
  }
  if (byId('TL.Language') && byId('TL.Language').result === 'BLOCKED') {
    items.push({ ref: 'Language', text: 'The Language field is absent on Additional Data, Filter Documents and Document Properties. Confirm whether it was intentionally removed; its typelist values (Edge Policy Holder English (US), English (US), Edge English (US)) are unchecked.' });
  }
  if (has((x) => /^UIF\.04[67]$/.test(x.id) && x.description.includes('Law Firm') && x.result === 'REVIEW') || has((x) => x.id === 'UIF.046' && x.result === 'REVIEW')) {
    items.push({ ref: 'UIF.046/047', text: 'Law Firm is unverified: it is specified "for DIG-199", which is not released in the Test SmartCOMM library. Re-run with --template DIG199 once it is.' });
  }
  if (has((x) => x.screen === 'Document Properties' && x.result === 'REVIEW' && /Author|Recipient|Inbound|Security Type/.test(x.description))) {
    items.push({ ref: 'UIF.008–011', text: 'Author, Recipient, Inbound and Security Type are hidden on Additional Data (per the story) and also missing on Document Properties, where the spec rows say visible — confirm whether they should be hidden there too.' });
  }
  if (byId('UIF.003.behaviour') && byId('UIF.003.behaviour').result !== 'PASS') {
    items.push({ ref: 'UIF.003', text: 'Address required for Print: need a claim with a contact that truly has no address on file to confirm the validation fires.' });
  }
  items.push({ ref: 'BR1', text: 'The email clause of Business Rule 1 ("a copy of each email template is saved") is untested — it also needs the Email channel.' });
  return items;
}

async function cancelWizard(page) {
  await page.locator(R.SCREEN_ROOT).getByRole('button', { name: /^Cancel/ }).first().click().catch(() => {});
  await page.locator(R.SCREEN_ROOT).waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
}

// UIF.003 (Address mandatory for Print): find a contact with no address, choose Print and try Generate. Print only
// produces a PDF — nothing is saved or mailed — and the document is discarded with the wizard.
async function addressMandatoryCheck(page, out, { template }) {
  const screen = 'Recipients';
  await documentService.openCreateFromTemplate(page);
  await documentService.selectTemplate(page, [template.searchName, template.searchNameAlt]);
  await page.getByRole('tab', { name: 'Recipients', exact: true }).click();
  await page.getByRole('button', { name: 'Set Primary Recipient' }).click();
  const menu = page.getByRole('menu').last();
  await menu.waitFor({ state: 'visible', timeout: 5000 });
  const names = (await menu.getByRole('menuitem').allInnerTexts()).map((n) => n.trim()).filter((n) => n && !/address book|1099/i.test(n));
  await page.keyboard.press('Escape').catch(() => {});
  let chosen = null;
  for (const n of names) {
    await documentService.setPrimaryRecipient(page, { explicitName: n });
    await documentService.setDeliveryChannel(page, 'Print');
    await page.waitForTimeout(1500);
    if (!(await R.readRecipientsTab(page)).addressText) { chosen = n; break; }
  }
  if (!chosen) {
    out.push(row('UIF.003.behaviour', screen, 'Recipients: Generate is blocked for a Print recipient with no address (UIF.003)', 'BLOCKED', 'validation error mentioning Address',
      'every contact on this claim has an address', `Contacts checked: ${names.join(', ')}. Use --claim with a claim that has a contact lacking an address.`));
    return;
  }
  await documentService.setMailOptions(page, { returnEnvelope: false, certifiedMail: false });
  await documentService.setAdditionalData(page, { documentType: 'Letter sent' });
  await page.getByRole('tab', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Generate' }).click();
  const banner = page.getByRole('group', { name: /^Errors/i });
  const rows = page.locator('[id*="CreatedDocuments"] tr.gw-standard-row');
  const winner = await Promise.race([
    banner.first().waitFor({ state: 'visible', timeout: 60000 }).then(() => 'error').catch(() => 'none'),
    rows.first().waitFor({ state: 'visible', timeout: 60000 }).then(() => 'rows').catch(() => 'none'),
  ]);
  const msg = winner === 'error' ? (await banner.first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim() : '';
  const result = winner === 'error' ? (/address/i.test(msg) ? 'PASS' : 'REVIEW') : winner === 'rows' ? 'REVIEW' : 'BLOCKED';
  out.push(row('UIF.003.behaviour', screen, `Recipients: Generate is blocked for a Print recipient with no address (UIF.003) — tried ${chosen}`, result,
    'validation error mentioning Address',
    winner === 'error' ? msg.slice(0, 200) : winner === 'rows' ? 'document generated without an address' : 'no error and no result within 60s',
    winner === 'rows'
      ? `Generate succeeded although the Address cell was blank in the Recipients grid. ${chosen} shows an address on saved documents, so it may be filled server-side — confirm with a contact that truly has no address on file.`
      : result === 'REVIEW' ? 'A different validation error appeared first; Address enforcement not confirmed.' : ''));
}

async function validateWizardUi(page, { spec, templateDig = 'DIG52', writes = false, br2Claims = [], log = console.log }) {
  const out = [];
  const template = catalogService.getTemplate(templateDig);
  if (!template) throw new Error(`validateWizardUi: template "${templateDig}" not found in the SmartCOMM catalog`);

  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept().catch(() => {}); });

  await documentService.openCreateFromTemplate(page);
  await page.waitForTimeout(1500);
  log('[CC-UI] wizard open — Select Template tab');
  await runSection('Select Template', () => selectTemplateSection(page, spec, out), out);
  await runSection('Select Template search', () => containsSearchCheck(page, template.searchName, out), out);
  await documentService.selectTemplate(page, [template.searchName, template.searchNameAlt]);
  log('[CC-UI] Recipients tab');
  await runSection('Recipients', () => recipientsSection(page, spec, out, { dialogs }), out);
  log('[CC-UI] Additional Data tab');
  await runSection('Additional Data', () => additionalDataSection(page, spec, out, { templateDig }), out);
  log('[CC-UI] Create tab');
  await runSection('Create', () => createSection(page, spec, out), out);
  await cancelWizard(page);

  log('[CC-UI] Address behaviour (Print, no address)');
  await runSection('Address behaviour', () => addressMandatoryCheck(page, out, { template }), out);
  await cancelWizard(page);

  let saved = null;
  if (writes) {
    log('[CC-UI] BR1 (creates one saved document on the claim)');
    saved = await runSection('Business Rules', () => br1Section(page, out, { templateDig, log }), out);
  } else {
    const br = Object.fromEntries(spec.businessRules.map((b) => [b.id, b.text]));
    out.push(row('BR1', 'Business Rules', `Business Rule 1: ${br.BR1 || ''}`, 'BLOCKED', 'one letter copy saved regardless of recipient count', 'not run',
      'Saves a document on the claim — re-run with --writes to execute it.'));
  }

  log('[CC-UI] Filter Documents (claim Documents page)');
  await runSection('Filter Documents', () => filterDocumentsSection(page, spec, out), out);
  log('[CC-UI] Document Properties');
  await runSection('Document Properties', () => documentPropertiesSection(page, spec, out,
    saved ? { marker: saved.marker, expectRecipients: [saved.primaryName, saved.additionalName] } : {}), out);
  if (br2Claims.length) {
    log(`[CC-UI] BR2 activity patterns (${br2Claims.map((c) => c.claimNumber).join(', ')})`);
    await runSection('Business Rules', () => br2Section(page, spec, out, { claims: br2Claims }), out);
  }
  const observations = specObservations(spec);
  return { validations: out, specObservations: observations, openItems: buildOpenItems(spec, out, observations) };
}

module.exports = { validateWizardUi, checkTypelist, checkFieldRow, buildOpenItems };
