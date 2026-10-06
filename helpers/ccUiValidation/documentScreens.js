/**
 * helpers/ccUiValidation/documentScreens.js
 * Read-only checks of the claim-level document screens against the spec:
 *   - Filter Documents (UIF.016–UIF.034): the spec's Link-button destination is not reachable in this
 *     environment, so its filter fields are evaluated on the claim's own Documents page, which carries
 *     the same filter block; screen-specific elements (results grid with a Select button, labels) stay BLOCKED.
 *   - Document Properties (UIF.041–UIF.047 + OOTB rows): opened from a saved document's info icon.
 */
'use strict';
const R = require('./uiReader');
const { norm, row, checkFieldRow, pickVisible } = require('./checks');

const DOCS_ROOT = '[id="ClaimDocuments-Claim_DocumentsScreen"]';
const PROPS_ROOT = '[id="DocumentDetailsPopup-DocumentDetailsScreen"]';

async function openDocumentsPage(page) {
  await page.locator('[role="menuitem"]', { hasText: /^Documents$/ }).first().click();
  await page.locator(DOCS_ROOT).waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1200);
}

async function filterDocumentsSection(page, spec, out) {
  const screen = 'Filter Documents';
  await openDocumentsPage(page);
  const snap = await R.readFields(page, DOCS_ROOT);
  const buttons = await R.readButtons(page, DOCS_ROOT);
  const proxy = 'Evaluated on the claim Documents page (same filter block) because the Filter Documents screen is unreachable — the Link button (UIF.015) is missing.';
  const filterIds = new Set(['UIF.019', 'UIF.020', 'UIF.021', 'UIF.022', 'UIF.023', 'UIF.024', 'UIF.025']);
  const buttonIds = new Set(['UIF.026', 'UIF.027']);
  const rows = spec.uiFields.filter((f) => f.screen === screen);

  for (const f of rows) {
    if (filterIds.has(f.reqId)) {
      const res = checkFieldRow(f, pickVisible(snap.fields, f.label));
      res.description = `${screen}: ${f.label} (${f.changeType}) — via claim Documents page`;
      res.reason = [res.reason, proxy].filter(Boolean).join(' | ');
      out.push(res);
    } else if (buttonIds.has(f.reqId)) {
      const found = buttons.some((b) => norm(b.label) === norm(f.label));
      out.push(row(f.reqId, screen, `${screen}: ${f.label} button (${f.changeType}) — via claim Documents page`, found ? 'PASS' : 'FAIL',
        'button shown', found ? 'button shown' : 'not present', proxy));
    }
  }
  const rest = rows.filter((f) => !filterIds.has(f.reqId) && !buttonIds.has(f.reqId));
  out.push(row('UIF.016/017/018/028–035', screen, `${screen}: screen-specific elements (${rest.map((f) => f.label).join(', ')})`, 'BLOCKED',
    'heading, "Return to Create From Template" link, and a results grid with Select / Name / Related To / Document Type / Status / Author / Uploaded',
    'not verifiable',
    'These belong to the Link-button destination (a separate Filter Documents screen). The claim Documents page has a different results grid (Document Description / Actions / Document Type / Status / Author / Document Date) and no Select button.'));
}

// Absent fields the story explicitly hides on Additional Data — Document Properties rows still say visible,
// so an absence there is a "confirm intent" item rather than a plain defect.
const HIDDEN_BY_STORY = new Set(['author', 'recipient', 'inbound', 'securitytype']);

async function documentPropertiesSection(page, spec, out, { marker, expectRecipients } = {}) {
  const screen = 'Document Properties';
  await openDocumentsPage(page);
  const info = (marker
    ? page.getByRole('row').filter({ hasText: marker }).locator('[aria-label="info"]')
    : page.locator('[aria-label="info"]')).first();
  if (!(await info.isVisible().catch(() => false))) {
    out.push(row('DOC.props', screen, 'Document Properties screen', 'BLOCKED', 'screen opened from a saved document', 'no saved document found',
      marker ? `No saved document containing "${marker}" was found.` : 'This claim has no saved document to open; run with --writes to create one.'));
    return {};
  }
  await info.click();
  await page.locator(PROPS_ROOT).waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1500);
  const snap = await R.readFields(page, PROPS_ROOT);
  const grids = await R.readGrids(page, PROPS_ROOT);
  // role=columnheader tables (Recipients) plus gw-HeaderCellWidget grids (Associated Documents) — either reader can miss one.
  const tables = [...(await R.readTables(page, PROPS_ROOT)), ...grids.map((g) => ({ headers: g.headers.filter(Boolean), rows: [] }))];
  const headingShown = async (text) => page.locator(PROPS_ROOT).getByText(text, { exact: true }).first().isVisible().catch(() => false);

  const fields = spec.uiFields.filter((f) => f.screen === screen);
  const iRec = fields.findIndex((f) => f.label === 'Recipients');
  const iAssoc = fields.findIndex((f) => f.label === 'Associated Documents');
  const main = fields.slice(0, iRec);
  const recCols = fields.slice(iRec + 1, iAssoc);
  const assocCols = fields.slice(iAssoc + 1);
  const note = 'Visibility only — the screen is view-mode, so mandatory/editable flags are not asserted here.';

  for (const f of main) {
    const live = snap.fields.find((x) => x.visible && norm(x.label) === norm(f.label));
    const id = f.reqId || `${screen} › ${f.label}`;
    const description = `${screen}: ${f.label}${f.changeType ? ` (${f.changeType})` : ''}`;
    if (live) { out.push(row(id, screen, description, 'PASS', 'shown', `shown${live.value ? `: ${String(live.value).slice(0, 40)}` : ''}`)); continue; }
    if (HIDDEN_BY_STORY.has(norm(f.label))) {
      out.push(row(id, screen, description, 'REVIEW', 'shown (spec row: visible)', 'not shown',
        `The story hides ${f.label} on Additional Data (UIF.008–UIF.011), but the Document Properties row still says visible. Confirm whether it should be hidden here too.`));
    } else if (norm(f.label) === 'lawfirm') {
      out.push(row(id, screen, description, 'REVIEW', 'shown (spec: for DIG-199)', 'not shown', 'Law Firm is added "for DIG-199"; this document is not one.'));
    } else {
      out.push(row(id, screen, description, 'FAIL', 'shown', 'not shown', note));
    }
  }

  // Prefer the tightest table (exactly the recipient columns) — outer wrapper tables repeat its rows plus unrelated ones.
  const recCandidates = tables.filter((t) => t.headers.some((h) => norm(h) === 'deliverychannel'));
  const recTable = recCandidates.sort((a, b) => a.headers.length - b.headers.length)[0];
  const recHeading = await headingShown('Recipients');
  out.push(row('UIF.045', screen, 'Document Properties: Recipients table (UIF.045)', recHeading && recTable ? 'PASS' : 'FAIL', 'Recipients heading and table shown',
    recHeading && recTable ? 'shown' : 'not shown'));
  for (const f of recCols) {
    const ok = recTable && recTable.headers.some((h) => norm(h) === norm(f.label));
    out.push(row(f.reqId || `${screen} › Recipients › ${f.label}`, screen, `${screen}: Recipients column "${f.label}"`, ok ? 'PASS' : 'FAIL', 'column shown', ok ? 'column shown' : `columns: ${recTable ? recTable.headers.join(', ') : '(no table)'}`));
  }
  if (expectRecipients && recTable) {
    const names = recTable.rows.filter((r) => /^(print|email|fax|sms|imageright)$/i.test(r[0] || '')).map((r) => r.filter(Boolean).join(' | '));
    const first = norm(names[0] || '').includes(norm(expectRecipients[0]));
    const second = expectRecipients.slice(1).every((n, i) => norm(names[i + 1] || '').includes(norm(n)));
    out.push(row('UIF.045.order', screen, 'Document Properties: Recipients table lists the primary recipient first, then additional recipients (UIF.045)',
      first && second ? 'PASS' : 'FAIL', `${expectRecipients.length} rows in order: ${expectRecipients.join(' → ')}`,
      `${names.length} row(s): ${names.map((n) => n.slice(0, 60)).join(' ⏎ ') || '(none)'}`,
      first && second ? '' : 'The saved document lists only the recipients shown here — the additional recipient is missing from Document Properties (spec UIF.045: include additional recipients, primary first).'));
  }

  const assocTable = tables.find((t) => ['name', 'actions', 'documenttype', 'status', 'author', 'uploaded'].every((k) => t.headers.some((h) => norm(h) === k)));
  const assocHeading = await headingShown('Associated Documents');
  out.push(row('DOC.assoc', screen, 'Document Properties: Associated Documents table', assocHeading && assocTable ? 'PASS' : 'FAIL', 'heading and table shown', assocHeading && assocTable ? 'shown' : 'not shown'));
  for (const f of assocCols) {
    const ok = assocTable && assocTable.headers.some((h) => norm(h) === norm(f.label));
    out.push(row(f.reqId || `${screen} › Associated › ${f.label}`, screen, `${screen}: Associated Documents column "${f.label}"`, ok ? 'PASS' : 'FAIL', 'column shown', ok ? 'column shown' : `columns: ${assocTable ? assocTable.headers.join(', ') : '(no table)'}`));
  }
  return { recipients: recTable ? recTable.rows : [] };
}

module.exports = { filterDocumentsSection, documentPropertiesSection, openDocumentsPage, DOCS_ROOT };
