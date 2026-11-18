/**
 * scripts/sortBcPayloadsByEvent.js
 * Pulls every BillingCenter SmartCOMM request payload from S3 (TEST: bc/outbound-files/smartcomm/input/<guid>, no
 * extension; same guid as the PDF in the processing folder) and files it by its <eventName>:
 *   V:\Amit Int\SmartComm\BillingCenter-Payloads\<eventName>\<guid>.xml   + index.csv (guid, event, account, channel, date)
 * S3 is read only. Downloads land in _incoming first and are MOVED into the event folder; a payload already filed is
 * not downloaded again, so re-runs only pick up new ones.
 *
 *   node scripts/sortBcPayloadsByEvent.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT_ROOT = process.env.BC_PAYLOAD_OUT || 'V:\\Amit Int\\SmartComm\\BillingCenter-Payloads';
const INCOMING = path.join(OUT_ROOT, '_incoming');
const PREFIX = 'bc/outbound-files/smartcomm/input';
const HEX = '0123456789abcdef';
// Two layouts: <eventName>X</eventName>, and SmartCOMM review-case files with <property name="eventName" value="X"/>.
const tag = (xml, t) => ((xml.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || xml.match(new RegExp(`name="${t}" value="([^"]*)"`)) || [])[1] || '').trim();
const safe = (s) => s.replace(/[<>:"/\\|?*]+/g, '_').trim() || '_NoEventName';

function filedGuids() {
  const s = new Set();
  for (const d of fs.existsSync(OUT_ROOT) ? fs.readdirSync(OUT_ROOT, { withFileTypes: true }) : []) {
    if (d.isDirectory() && d.name !== '_incoming') for (const f of fs.readdirSync(path.join(OUT_ROOT, d.name))) s.add(f.replace(/\.xml$/i, ''));
  }
  return s;
}

async function download() {
  const { chromium } = require('playwright');
  const { createS3SessionManager } = require('../helpers/s3Download/s3SessionManager');
  const { _api } = require('../helpers/s3Download/s3AdminService');
  const browser = await chromium.launch({ headless: false });
  const s3 = createS3SessionManager(browser);
  fs.mkdirSync(INCOMING, { recursive: true });
  const have = filedGuids();
  const meta = {};
  try {
    await s3.withPage(async (page) => {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(5000);
      // The list API returns at most 1000 keys: list by the guid's first two hex characters.
      const keys = [];
      for (const a of HEX) for (const b of HEX) {
        const items = await _api.apiList(page, `${PREFIX}/${a}${b}`).catch(() => []);
        if (items.length >= 1000) console.log(`[list] ${a}${b}: 1000+ keys, some may be missed`);
        for (const o of items) if (!/\/$/.test(o.key)) { keys.push(o.key); meta[o.key.split('/').pop()] = o.lastModified; }
      }
      console.log(`[list] ${keys.length} payloads in S3; ${have.size} already filed`);
      let n = 0;
      for (const key of keys) {
        const guid = key.split('/').pop();
        if (have.has(guid) || fs.existsSync(path.join(INCOMING, guid))) continue;
        await _api.apiDownload(page, key.replace(/^test\//, ''), INCOMING).catch((e) => console.log(`[dl] ${guid}: ${e.message.split('\n')[0]}`));
        if (++n % 100 === 0) console.log(`[dl] ${n}`);
      }
      console.log(`[dl] ${n} new`);
    });
  } finally { await s3.close(); await browser.close(); }
  return meta;
}

function file(meta) {
  const idx = path.join(OUT_ROOT, 'index.csv');
  const rows = fs.existsSync(idx) ? fs.readFileSync(idx, 'utf8').split(/\r?\n/).filter(Boolean) : ['guid,eventName,account,channel,s3LastModified'];
  for (const f of fs.readdirSync(INCOMING)) {
    const src = path.join(INCOMING, f);
    const xml = fs.readFileSync(src, 'utf8');
    const event = safe(tag(xml, 'eventName'));
    const dir = path.join(OUT_ROOT, event);
    fs.mkdirSync(dir, { recursive: true });
    const guid = f.replace(/\.xml$/i, '');
    fs.renameSync(src, path.join(dir, `${guid}.xml`));
    rows.push([guid, event, tag(xml, 'AccountNumber'), tag(xml, 'channel'), meta[guid] || ''].join(','));
  }
  fs.writeFileSync(idx, rows.join('\r\n'));
  const counts = {};
  for (const d of fs.readdirSync(OUT_ROOT, { withFileTypes: true })) if (d.isDirectory() && d.name !== '_incoming') counts[d.name] = fs.readdirSync(path.join(OUT_ROOT, d.name)).length;
  console.log(JSON.stringify(counts, null, 1));
  console.log(`total ${Object.values(counts).reduce((a, b) => a + b, 0)} payloads in ${Object.keys(counts).length} event folders -> ${OUT_ROOT}`);
}

(async () => { file(await download()); })().catch((e) => { console.error(e); process.exit(1); });
