#!/usr/bin/env node
/**
 * scripts/oneIncCode.js — hands the 6-digit verification code OneInc just texted to the payee's mobile over to a running
 * OneInc case (helpers/oneInc/oneIncEmail.js acceptPayment is waiting for it; the code lasts about 2 minutes).
 *
 *   node scripts/oneIncCode.js 140944
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { CODE_FILE } = require('../helpers/oneInc/oneIncEmail');

const code = String(process.argv[2] || '').replace(/\D/g, '');
if (code.length !== 6) { console.error('usage: node scripts/oneIncCode.js <6-digit code>'); process.exit(1); }
fs.mkdirSync(path.dirname(CODE_FILE), { recursive: true });
fs.writeFileSync(CODE_FILE, code);
console.log(`[OneInc] code handed over (${CODE_FILE})`);
