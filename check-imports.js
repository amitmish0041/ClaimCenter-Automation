// Sanity check: for every `const { a, b } = require('../../helpers/X')` in the
// LOB e2e specs, confirm each destructured name actually exists on that module.
// A wrong-module import (e.g. approveLatestCheck imported from financialsHelper
// instead of claimLifecycleHelper) is silently `undefined` and only surfaces as
// a "not a function" TypeError deep into a 15-minute run.
const fs   = require('fs');
const path = require('path');

const specDir = path.join(__dirname, 'tests', 'lob');
const specs = fs.readdirSync(specDir).filter(f => f.endsWith('.test.js'));

// `const {  ...names...  } = require('<spec>');`  — names block may span lines.
const IMPORT_RE = /const\s*\{([\s\S]*?)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;

let bad = 0;
for (const spec of specs) {
  const src = fs.readFileSync(path.join(specDir, spec), 'utf8');
  let m;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const [, namesBlock, request] = m;
    if (!request.startsWith('.')) continue;           // skip @playwright/test etc.
    const mod = require(path.resolve(specDir, request));
    const names = namesBlock
      .replace(/\/\/[^\n]*/g, '')                     // strip line comments
      .split(',')
      .map(s => s.trim().split(':')[0].trim())        // handle `a: b` renames
      .filter(Boolean);
    for (const n of names) {
      if (mod[n] === undefined) {
        console.log('MISSING  ' + spec + '  ->  ' + n + '  not exported by ' + request);
        bad++;
      }
    }
  }
}
console.log(bad ? bad + ' bad import(s)' : 'all LOB e2e imports resolve');
process.exit(bad ? 1 : 0);
