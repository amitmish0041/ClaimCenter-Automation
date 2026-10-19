/**
 * helpers/smartComm/pdfOcrService.js
 * OCR for PDFs whose printed wording is drawn as graphics, not text (CONFIRMED 2026-10-17/19: DIG47 draws its form as
 * images, DIG2118 as 1,881 vector shapes — the text layer holds only the filled-in values, so every fixed-wording check
 * came back "not in the PDF"). Uses Windows' own PDF renderer and OCR engine through ocr/ocr-pdf.ps1 — nothing to
 * install, about 1.5 s per page. Anything that goes wrong (not Windows, no OCR language, timeout) returns null and the
 * caller keeps its result as it was: OCR can only confirm wording, never fail it.
 */
'use strict';
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'ocr', 'ocr-pdf.ps1');
const cache = new Map();

function ocrPdfText(pdfPath, { timeoutMs = 120000 } = {}) {
  if (process.platform !== 'win32' || !pdfPath) return Promise.resolve(null);
  if (cache.has(pdfPath)) return cache.get(pdfPath);
  const run = new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-PdfPath', pdfPath],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err || !String(stdout || '').trim() ? null : String(stdout)));
  });
  cache.set(pdfPath, run);
  return run;
}

// OCR reads printed text with small slips ("Room WI 96" for "W196", "Page I" for "Page 1", "FallL"), so compare
// letters/digits only, with look-alike characters folded together, and allow a little difference per word.
const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  .replace(/[0o]/g, 'o').replace(/[1il|]/g, 'l').replace(/5/g, 's').replace(/8/g, 'b').replace(/rn/g, 'm');
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length][b.length];
}

// Is `expected` (fixed wording from the mapping doc) on the page according to the OCR text? Fill-in lines ("____"),
// checkbox glyphs and punctuation are ignored. Whole phrase first; else ≥85% of its words (3+ letters) each found
// within one OCR slip.
function ocrContains(ocrText, expected) {
  const want = String(expected || '').replace(/_{2,}/g, ' ');
  const whole = fold(want);
  if (whole.length < 2) return false;
  const hay = fold(ocrText);
  if (hay.includes(whole)) return true;
  const words = (want.toLowerCase().match(/[a-z0-9]{3,}/g) || []).map(fold);
  if (!words.length) return false;
  const ocrWords = new Set((String(ocrText).toLowerCase().match(/[a-z0-9]{2,}/g) || []).map(fold));
  const hit = (w) => ocrWords.has(w) || hay.includes(w) || [...ocrWords].some((o) => Math.abs(o.length - w.length) <= 1 && editDistance(o, w) <= (w.length >= 6 ? 2 : 1));
  const found = words.filter(hit).length;
  return found / words.length >= 0.85;
}

module.exports = { ocrPdfText, ocrContains };
