/**
 * helpers/ccUiValidation/checks.js
 * Shared result builders and comparison helpers for the CC UI validators
 * (wizardValidator.js, documentScreens.js, activityPatterns.js).
 */
'use strict';

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const isNoneOption = (o) => !o || /^<none>$/i.test(o) || /^any$/i.test(o);

function row(id, screen, description, result, expected, actual, reason = '') {
  return { id, screen, description, result, expected, actual, reason };
}

// ── typelists ─────────────────────────────────────────────────────────────────
// exhaustive=true: the spec lists EVERY value the dropdown should carry, so live
// values outside it are flagged. DocumentType is a partial list (typecodes in
// the user story; the live list is a superset), and its spec values are codes
// ("letter_sent") while the screen shows labels ("Letter sent"), so matching
// is normalised and prefix-tolerant there.
const initials = (label) => String(label).split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]).join('').toLowerCase();

function checkTypelist({ id, screen, description, specValues, liveOptions, exhaustive, prefixMatch }) {
  const live = liveOptions.filter((o) => !isNoneOption(o));
  const mapped = [];
  // exact (normalised) match first; for code-based lists also a label that starts with the code
  // ("iso" → "ISO match report") or whose initials are the code ("fnol" → "First notice of loss").
  const matchesLive = (v, exactOnly) => {
    const exact = live.find((o) => norm(o) === norm(v));
    if (exact || exactOnly || !prefixMatch) return exact;
    const loose = live.find((o) => norm(o).startsWith(norm(v)) || initials(o) === norm(v));
    if (loose) mapped.push(`${v} → ${loose}`);
    return loose;
  };
  const wanted = specValues.filter((v) => !v.retired);
  const retired = specValues.filter((v) => v.retired);

  const missing = [];
  const labelDiffers = [];
  const used = new Set();
  for (const v of wanted) {
    const hit = matchesLive(v.label);
    if (hit) { used.add(hit); continue; }
    // "Worker's Comp" vs "Workers' Compensation": same thing, different wording.
    const close = live.find((o) => !used.has(o) && norm(o).length >= 5 && norm(v.label).length >= 5 &&
      (norm(o).startsWith(norm(v.label)) || norm(v.label).startsWith(norm(o))));
    if (close) { used.add(close); labelDiffers.push(`spec "${v.label}" vs screen "${close}"`); } else { missing.push(v.label); }
  }
  const retiredShown = retired.filter((v) => matchesLive(v.label, true)).map((v) => v.label);
  const extras = exhaustive ? live.filter((o) => !used.has(o) && !retired.some((v) => norm(v.label) === norm(o))) : [];
  const counts = {};
  live.forEach((o) => { counts[o] = (counts[o] || 0) + 1; });
  const duplicates = Object.keys(counts).filter((o) => counts[o] > 1);

  const problems = [];
  if (missing.length) problems.push(`missing from screen: ${missing.join(', ')}`);
  if (retiredShown.length) problems.push(`retired in spec but still shown: ${retiredShown.join(', ')}`);
  const soft = [];
  if (labelDiffers.length) soft.push(`wording differs: ${labelDiffers.join('; ')}`);
  if (extras.length) soft.push(`on screen but not in spec: ${extras.join(', ')}`);
  if (duplicates.length) soft.push(`duplicate option(s) shown: ${duplicates.map((o) => `${o} ×${counts[o]}`).join(', ')}`);
  const info = mapped.length ? [`spec codes matched to screen labels: ${mapped.join('; ')}`] : [];

  const expected = `${wanted.length} value(s) present${retired.length ? `; retired absent (${retired.map((v) => v.label).join(', ')})` : ''}`;
  const actual = live.length > 12 ? `${live.length} option(s) (first 12: ${live.slice(0, 12).join(', ')}…)` : `${live.length} option(s): ${live.join(', ') || '(none)'}`;
  const result = problems.length ? 'FAIL' : soft.length ? 'REVIEW' : 'PASS';
  return row(id, screen, description, result, expected, actual, [...problems, ...soft, ...info].join(' | '));
}

// ── generic field-row check (visible / mandatory / type / default) ───────────
const KIND_FOR_TYPE = {
  typelist: ['select'], dropdown: ['select'], 'foreign key': ['select'],
  text: ['text', 'textarea', 'readonly-text'], textbox: ['text', 'textarea'], 'radio button': ['radio'],
};

function checkFieldRow(specField, live) {
  const id = specField.reqId || `${specField.screen} › ${specField.label}`;
  const description = `${specField.screen}: ${specField.label}${specField.changeType ? ` (${specField.changeType})` : ''}`;
  const wantVisible = specField.visible !== false; // unspecified → expected on screen

  if (!wantVisible) {
    return live
      ? row(id, specField.screen, description, 'FAIL', 'hidden', 'visible', 'Spec says this field must be hidden, but it is shown.')
      : row(id, specField.screen, description, 'PASS', 'hidden', 'hidden');
  }
  if (!live) {
    return row(id, specField.screen, description, 'FAIL', 'visible', 'not present', 'Field is not shown on this tab.');
  }

  const exp = ['visible'];
  const act = ['visible'];
  const problems = [];
  const soft = [];
  if (typeof specField.mandatory === 'boolean') {
    exp.push(specField.mandatory ? 'mandatory' : 'optional');
    act.push(live.required ? 'mandatory' : 'optional');
    if (specField.mandatory !== live.required) problems.push(`mandatory should be ${specField.mandatory}, screen shows ${live.required}`);
  }
  // Editable is only asserted for rows the story marks New/Modified — the spec's
  // OOTB rows flag obviously interactive dropdowns/buttons as editable=false.
  if (typeof specField.editable === 'boolean' && /^(new|modified)$/i.test(specField.changeType)) {
    exp.push(specField.editable ? 'editable' : 'read-only');
    act.push(live.editable ? 'editable' : 'read-only');
    if (specField.editable !== live.editable) problems.push(`editable should be ${specField.editable}, screen shows ${live.editable}`);
  }
  const okKinds = KIND_FOR_TYPE[String(specField.fieldType || '').toLowerCase()];
  if (okKinds) {
    exp.push(`type ${specField.fieldType}`);
    act.push(`type ${live.kind}`);
    if (!okKinds.includes(live.kind)) soft.push(`spec type "${specField.fieldType}" but screen renders a ${live.kind}`);
  }
  if (specField.defaultValue) {
    exp.push(`default: ${specField.defaultValue}`);
    act.push(`value: ${live.value || '(blank)'}`);
    if (/logged on user/i.test(specField.defaultValue)) {
      if (!live.value || isNoneOption(live.value)) problems.push('no default set (spec: defaults to the logged-on user)');
      else soft.push('default is set; that it equals the logged-on user\'s name is not independently verified');
    }
  }
  const result = problems.length ? 'FAIL' : soft.length ? 'REVIEW' : 'PASS';
  return row(id, specField.screen, description, result, exp.join('; '), act.join('; '), [...problems, ...soft].join(' | '));
}

function pickVisible(fields, label) {
  return fields.find((f) => f.visible && norm(f.label) === norm(label));
}

module.exports = { norm, isNoneOption, row, initials, checkTypelist, checkFieldRow, pickVisible };
