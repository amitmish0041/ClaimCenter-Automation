/**
 * helpers/ccUiValidation/uiReader.js
 * Reads the CURRENT state of the ClaimCenter Cloud "Create New Document"
 * wizard (South panel) as plain data — label, visible, required, editable,
 * control kind, value, options — so requirements can be compared against what
 * the screen really renders. Read-only: never clicks, types or selects.
 *
 * Markup facts (CONFIRMED live 2026-09-23, cloud/test):
 *  - a form field is <div class="gw-InputWidget"> holding <div class="gw-label">
 *    and <div class="gw-value"> with a *ValueWidget div;
 *  - that value widget carries `gw-required` when mandatory (plus a
 *    `.gw-required-icon` and aria-required="true" on the control) and
 *    `gw-editable` / `gw-readonly` for edit state;
 *  - list-view cells (Recipients grid, results grids) use `td.gw-CellWidget`
 *    under a `tr`, with header labels in `td.gw-HeaderCellWidget`.
 * Only widgets on the ACTIVE tab are visible (other tabs are display:none), so
 * call this per tab; "hidden" therefore means "no visible widget with that
 * label on the active tab".
 */
'use strict';

const SCREEN_ROOT = '[id="GC_NewDocumentWorksheet-GC_NewDocumentScreen"]';

// Runs in the page. `root` selector scopes the read (defaults to the wizard).
async function readFields(page, rootSelector = SCREEN_ROOT) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return { error: `root not found: ${sel}`, fields: [] };
    const isVisible = (el) => !!(el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden');

    const describe = (valueWidget, label) => {
      const control = valueWidget.querySelector('select, input:not([type=hidden]), textarea');
      const radios = Array.from(valueWidget.querySelectorAll('[role="radio"]'));
      let kind = 'readonly-text';
      let value = (valueWidget.innerText || '').replace(/\s+/g, ' ').trim();
      let options;
      if (control && control.tagName === 'SELECT') {
        kind = 'select';
        options = Array.from(control.options).map((o) => o.text.trim());
        value = control.options[control.selectedIndex] ? control.options[control.selectedIndex].text.trim() : '';
      } else if (control && control.type === 'radio') {
        kind = 'radio';
        value = radios.map((r) => `${(r.innerText || r.getAttribute('aria-label') || '').trim()}:${r.getAttribute('aria-checked')}`).join(' ');
      } else if (radios.length) {
        kind = 'radio';
        value = radios.map((r) => `${(r.innerText || r.getAttribute('aria-label') || '').trim()}:${r.getAttribute('aria-checked')}`).join(' ');
      } else if (control) {
        kind = control.tagName === 'TEXTAREA' ? 'textarea' : 'text';
        value = control.value;
      } else if (valueWidget.querySelector('[role="button"], button')) {
        kind = 'button';
      }
      const cls = valueWidget.className || '';
      const editable = control ? (!control.disabled && !control.readOnly && !/gw-readonly/.test(cls)) : /gw-editable/.test(cls);
      return {
        label,
        kind,
        visible: isVisible(valueWidget),
        required: /gw-required/.test(cls) || (control && control.getAttribute('aria-required') === 'true') || !!valueWidget.querySelector('.gw-required-icon'),
        editable: !!editable,
        value,
        options,
        id: valueWidget.id || '',
      };
    };

    const fields = [];
    root.querySelectorAll('.gw-InputWidget').forEach((w) => {
      const labelEl = w.querySelector(':scope > .gw-label, .gw-label');
      const valueBox = w.querySelector('.gw-value');
      if (!labelEl || !valueBox) return;
      const vw = valueBox.querySelector('[class*="ValueWidget"]') || valueBox;
      const label = labelEl.textContent.replace(/\s+/g, ' ').trim();
      if (!label) return;
      fields.push(describe(vw, label));
    });
    return { fields };
  }, rootSelector);
}

// Visible buttons/links inside the wizard (action controls), by label.
async function readButtons(page, rootSelector = SCREEN_ROOT) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return [];
    const out = [];
    root.querySelectorAll('[role="button"], button').forEach((b) => {
      if (b.offsetParent === null) return;
      const label = ((b.querySelector('.gw-label') || b).getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label) return;
      out.push({ label, disabled: b.getAttribute('aria-disabled') === 'true' || !!b.disabled });
    });
    return out;
  }, rootSelector);
}

// Column headers + per-row cell state of every visible list view in the root.
async function readGrids(page, rootSelector = SCREEN_ROOT) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return [];
    const grids = [];
    root.querySelectorAll('table').forEach((t) => {
      if (t.offsetParent === null) return;
      const headerCells = Array.from(t.querySelectorAll('tr.gw-header-row td.gw-HeaderCellWidget, td.gw-HeaderCellWidget'));
      if (!headerCells.length) return;
      const headers = headerCells.map((h) => (h.querySelector('.gw-label') || h).textContent.replace(/\s+/g, ' ').trim());
      const rows = [];
      t.querySelectorAll('tr.gw-standard-row, tr.gw-row:not(.gw-header-row)').forEach((tr) => {
        if (tr.offsetParent === null) return;
        const cells = Array.from(tr.querySelectorAll('td.gw-CellWidget')).map((td) => {
          const vw = td.querySelector('[class*="ValueWidget"]') || td;
          const control = td.querySelector('select, input:not([type=hidden]), textarea');
          const cls = vw.className || '';
          return {
            visible: td.offsetParent !== null,
            required: /gw-required/.test(cls) || (control && control.getAttribute('aria-required') === 'true') || !!td.querySelector('.gw-required-icon'),
            editable: control ? (!control.disabled && !control.readOnly && !/gw-readonly/.test(cls)) : /gw-editable/.test(cls),
            kind: control ? (control.tagName === 'SELECT' ? 'select' : control.tagName === 'TEXTAREA' ? 'textarea' : 'text') : (td.querySelector('[role="radio"]') ? 'radio' : 'readonly-text'),
            value: control ? (control.tagName === 'SELECT' ? (control.options[control.selectedIndex] || {}).text : control.value) : (td.innerText || '').replace(/\s+/g, ' ').trim(),
            options: control && control.tagName === 'SELECT' ? Array.from(control.options).map((o) => o.text.trim()) : undefined,
          };
        });
        rows.push(cells);
      });
      grids.push({ id: t.id || '', headers, rows });
    });
    return grids;
  }, rootSelector);
}

// The Recipients tab is a list view whose controls are looked up by their
// stable id suffixes (CONFIRMED live): ...PrimaryRecipientDeliveryChannel /
// Phone / Email and ...PrimaryRecipientReturnEnvelope_Ext / CertifiedMail_Ext
// (the last two only exist in the DOM while Delivery Channel = Print).
async function readRecipientsTab(page, rootSelector = SCREEN_ROOT) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return { error: `root not found: ${sel}` };
    const vis = (e) => !!e && e.offsetParent !== null;
    const widgetOf = (el) => el.closest('[class*="ValueWidget"]') || el;
    const isRequired = (el) => {
      const w = widgetOf(el);
      const holder = el.closest('[id]');
      return /gw-required/.test(w.className || '') || /gw-required/.test((holder && holder.className) || '') ||
        el.getAttribute('aria-required') === 'true' || !!w.querySelector('.gw-required-icon');
    };
    const control = (suffix) => {
      const holder = root.querySelector(`[id$="${suffix}"]`);
      const el = holder && (/^(SELECT|INPUT)$/.test(holder.tagName) ? holder : holder.querySelector('select, input:not([type=hidden])'));
      if (!el || !vis(el)) return { present: false };
      return {
        present: true,
        required: isRequired(el),
        editable: !el.disabled && !el.readOnly && !/gw-readonly/.test(widgetOf(el).className || ''),
        value: el.tagName === 'SELECT' ? ((el.options[el.selectedIndex] || {}).text || '') : el.value,
        options: el.tagName === 'SELECT' ? Array.from(el.options).map((o) => o.text.trim()) : undefined,
      };
    };
    const radioGroup = (frag) => {
      const radios = Array.from(root.querySelectorAll(`[id*="${frag}"][role="radio"]`)).filter(vis);
      if (!radios.length) return { present: false };
      return { present: true, required: radios.some((r) => isRequired(r)), editable: true, kind: 'radio', count: radios.length };
    };
    const headers = Array.from(root.querySelectorAll('[role="columnheader"]')).filter(vis)
      .map((h) => h.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const addrIdx = Array.from(root.querySelectorAll('[role="columnheader"]')).filter(vis)
      .findIndex((h) => h.textContent.replace(/\s+/g, ' ').trim() === 'Address');
    let addressText = '';
    const firstRow = root.querySelector('tr.gw-standard-row');
    if (firstRow && addrIdx >= 0) {
      const cells = firstRow.querySelectorAll('td');
      addressText = ((cells[addrIdx] || {}).innerText || '').replace(/\s+/g, ' ').trim();
    }
    return {
      headers,
      deliveryChannel: control('PrimaryRecipientDeliveryChannel'),
      phone: control('PrimaryRecipientPhone'),
      email: control('PrimaryRecipientEmail'),
      returnEnvelope: radioGroup('PrimaryRecipientReturnEnvelope_Ext'),
      certifiedMail: radioGroup('PrimaryRecipientCertifiedMail_Ext'),
      addressText,
    };
  }, rootSelector);
}

// Column headers + body-row cell text of every visible table (role=columnheader based — works for the
// Recipients / Associated Documents list views that readGrids' gw-HeaderCellWidget lookup misses).
async function readTables(page, rootSelector = SCREEN_ROOT) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return [];
    const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
    return Array.from(root.querySelectorAll('table')).filter((t) => t.offsetParent !== null).map((t) => {
      const headers = Array.from(t.querySelectorAll('[role="columnheader"]')).map((h) => clean(h.textContent)).filter(Boolean);
      const rows = Array.from(t.querySelectorAll('tr'))
        .filter((tr) => !tr.querySelector('[role="columnheader"]') && tr.querySelector('td') && tr.offsetParent !== null)
        .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => clean(td.innerText)))
        .filter((r) => r.some(Boolean));
      return { headers, rows };
    }).filter((t) => t.headers.length);
  }, rootSelector);
}

module.exports = { SCREEN_ROOT, readFields, readButtons, readGrids, readRecipientsTab, readTables };
