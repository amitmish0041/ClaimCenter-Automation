/**
 * helpers/oneInc/screenReader.js
 * Reads whatever ClaimCenter Cloud screen is showing as plain data — every visible form field (label, value,
 * required, read-only, dropdown options, radio state), list-view column headers, buttons, menu items, the
 * validation messages, and the left-nav labels — so OneInc checks compare requirements against what the screen
 * really renders. Read-only: never clicks or types.
 *
 * Same markup facts helpers/ccUiValidation/uiReader.js relies on (CONFIRMED there 2026-09-23), re-confirmed on
 * the payment wizard 2026-10-20 (cloud/test):
 *  - a field is <div class="gw-InputWidget"> with a .gw-label and a .gw-value whose first child carries
 *    `gw-required` / `gw-readonly`;
 *  - list-view headers are td.gw-HeaderCellWidget;
 *  - Yes/No questions are role="radio" divs carrying aria-label + aria-checked;
 *  - field-level validation lands as "<Field> : <message>" text in .gw-message-type-* blocks at the top of the
 *    screen (the wizard's own message area), and some rules also write to #gw-south-panel.
 * uiReader.js is scoped to the Create-Document wizard root; this one reads the whole page because the payment
 * wizard, Financials and Parties Involved screens all have different roots.
 */
'use strict';

async function readScreen(page) {
  return page.evaluate(() => {
    const vis = (el) => !!(el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden');
    const txt = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
    const fields = [...document.querySelectorAll('.gw-InputWidget')].filter(vis).map((w) => {
      const l = w.querySelector('.gw-label');
      const v = w.querySelector('.gw-value');
      const vw = v && v.firstElementChild;
      const sel = w.querySelector('select');
      const input = w.querySelector('input:not([type=hidden]), textarea');
      const radios = [...w.querySelectorAll('[role=radio]')].map((r) => ({
        label: r.getAttribute('aria-label') || txt(r), checked: r.getAttribute('aria-checked') === 'true',
      }));
      const cls = (vw && vw.className) || '';
      return {
        id: w.id || '',
        label: txt(l),
        value: sel ? txt(sel.options[sel.selectedIndex]) : (input ? (input.type === 'password' ? (input.value ? '••••' : '') : input.value) : txt(v)),
        required: /gw-required/.test(cls) || !!w.querySelector('[aria-required="true"], .gw-required-icon'),
        readonly: /gw-readonly/.test(cls) || (!sel && !input && !radios.length),
        kind: sel ? 'select' : radios.length ? 'radio' : input ? (input.type === 'password' ? 'masked' : 'input') : 'text',
        options: sel ? [...sel.options].map((o) => txt(o)) : undefined,
        radios: radios.length ? radios : undefined,
        disabled: !!((sel && sel.disabled) || (input && input.disabled)),
      };
    });
    const headers = [...new Set([...document.querySelectorAll('td.gw-HeaderCellWidget, th')].filter(vis).map(txt).filter(Boolean))];
    const buttons = [...new Set([...document.querySelectorAll('[role=button], button')].filter(vis)
      .map((b) => (b.getAttribute('aria-label') || txt(b))).filter(Boolean))];
    const messages = [...new Set([...document.querySelectorAll('.gw-message, .gw-WebMessage, [class*="gw-message-type"]')]
      .filter(vis).map(txt).filter(Boolean))].slice(0, 40);
    const south = document.getElementById('gw-south-panel');
    const title = txt(document.querySelector('.gw-TitleBar--title, .gw-Wizard--Title, [class*="TitleBar"] [class*="title"]'));
    const nav = [...document.querySelectorAll('[id^="Claim-MenuLinks-"]')].map((e) => ({ id: e.id, label: txt(e.querySelector('.gw-label') || e) }));
    return {
      url: location.href, title, fields, headers, buttons, messages,
      south: vis(south) ? txt(south).slice(0, 2000) : '',
      nav,
      body: txt(document.body).slice(0, 20000),
    };
  });
}

const norm = (s) => String(s || '').replace(/[“”"]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Field lookup by label: exact (normalised) first, then "starts with", then "contains" — long questions wrap and
// carry a trailing "?" or asterisk, and the requirement text sometimes paraphrases them slightly.
function findField(screen, label) {
  const want = norm(label);
  const fs = screen.fields;
  return fs.find((f) => norm(f.label) === want)
    || fs.find((f) => norm(f.label).replace(/[?*:]+$/, '') === want.replace(/[?*:]+$/, ''))
    || fs.find((f) => f.label && norm(f.label).startsWith(want.replace(/[?*:]+$/, '')))
    || (want.length >= 12 ? fs.find((f) => f.label && norm(f.label).includes(want.replace(/[?*:]+$/, ''))) : null)
    || null;
}

module.exports = { readScreen, findField, norm };
