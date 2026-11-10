/**
 * helpers/regression/soapClient.js — what the API regression cases (TC060–TC063, TC076–TC079) did in SoapUI, from Node.
 *
 * Nothing about the services is hard-coded: the operation and target namespace are read from the live WSDL, the
 * request is a plain SOAP 1.1 envelope with the TC's parameter names as child elements (Guidewire's WS-I services take
 * them that way), and the reply is flattened to { tag: [values] } so a test can ask "is there a ClaimNumber".
 *
 * Config per service (Runner Settings or ClaimCenter-Automation/.env):
 *   REG_API_<SERVICE>_URL   endpoint or WSDL URL     SERVICE = RENEWAL | CLAIM_DATA | AGENT_ACCESS | CLAIM_SURVEY
 *   REG_API_<SERVICE>_OP    operation name (optional — else the first operation matching the case's pattern)
 *   REG_API_USER / REG_API_PASS   HTTP Basic credentials, or REG_API_<SERVICE>_AUTH = full Authorization header value
 * Missing URL → Blocked (the case reports BLOCKED with the variable to set).
 */
'use strict';
const { Blocked } = require('../oneInc/wizardDriver');

const SERVICES = {
  RENEWAL: 'AutomatedRenewalAPI',
  CLAIM_DATA: 'ClaimDataAPI',
  AGENT_ACCESS: 'AgentAccessClaimDataAPI',
  CLAIM_SURVEY: 'ClaimSurveyReminderAPI',
};

function cfg(service) {
  const url = process.env[`REG_API_${service}_URL`];
  if (!url) throw new Blocked(`${SERVICES[service] || service}: set REG_API_${service}_URL (endpoint or WSDL URL)`);
  const endpoint = url.replace(/\?wsdl$/i, '');
  const auth = process.env[`REG_API_${service}_AUTH`]
    || (process.env.REG_API_USER ? 'Basic ' + Buffer.from(`${process.env.REG_API_USER}:${process.env.REG_API_PASS || ''}`).toString('base64') : null);
  return { endpoint, wsdl: /\?wsdl$/i.test(url) ? url : `${endpoint}?wsdl`, auth, op: process.env[`REG_API_${service}_OP`] };
}

async function http(url, opts, what) {
  let res;
  try { res = await fetch(url, opts); } catch (e) { throw new Blocked(`${what}: ${url} not reachable from this machine (${e.message})`); }
  const text = await res.text();
  return { status: res.status, text };
}

// WSDL → { ns, operations[] }
async function describe(service) {
  const c = cfg(service);
  const { status, text } = await http(c.wsdl, { headers: c.auth ? { authorization: c.auth } : {} }, `${SERVICES[service]} WSDL`);
  if (status === 401 || status === 403) throw new Blocked(`${SERVICES[service]} WSDL refused (${status}) — check REG_API_USER / REG_API_PASS`);
  if (status >= 400 || !/definitions/i.test(text)) throw new Blocked(`${SERVICES[service]} WSDL not returned (HTTP ${status})`);
  const ns = (text.match(/targetNamespace="([^"]+)"/) || [])[1];
  const operations = [...new Set([...text.matchAll(/<(?:wsdl:)?operation\s+name="([^"]+)"/g)].map((m) => m[1]))];
  return { ...c, ns, operations };
}

const xmlEsc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Flatten every leaf element: { ClaimNumber: ['PA-PA-01-26-0000001', …], … } (namespace prefixes dropped).
function flatten(xml) {
  const out = {};
  for (const m of String(xml).matchAll(/<(?:[\w-]+:)?([\w-]+)(?:\s[^>]*)?>([^<]*)<\/(?:[\w-]+:)?\1>/g)) {
    (out[m[1]] = out[m[1]] || []).push(m[2].trim());
  }
  return out;
}

// Call the operation matching `opRe` with params (object, order kept). Returns { op, status, fault, xml, fields, ms }.
async function call(service, opRe, params) {
  const d = await describe(service);
  const op = d.op || d.operations.find((o) => opRe.test(o));
  if (!op) throw new Blocked(`${SERVICES[service]} has no operation matching ${opRe} (operations: ${d.operations.join(', ')}) — set REG_API_${service}_OP`);
  const body = Object.entries(params).map(([k, v]) => `<tns:${k}>${xmlEsc(v)}</tns:${k}>`).join('');
  const envelope = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${d.ns}"><soapenv:Header/><soapenv:Body><tns:${op}>${body}</tns:${op}></soapenv:Body></soapenv:Envelope>`;
  const t0 = Date.now();
  const { status, text } = await http(d.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '""', ...(d.auth ? { authorization: d.auth } : {}) },
    body: envelope,
  }, `${SERVICES[service]}.${op}`);
  const fault = (text.match(/<(?:\w+:)?faultstring[^>]*>([\s\S]*?)<\/(?:\w+:)?faultstring>/) || [])[1] || (status >= 500 && /Fault/i.test(text) ? 'SOAP Fault' : '');
  return { op, status, fault: fault.trim(), xml: text, fields: flatten(text), ms: Date.now() - t0, request: envelope };
}

// First value of the first field whose name matches re (case-insensitive), e.g. pick(r, /^ClaimNumber$/i).
const pick = (r, re) => { const k = Object.keys(r.fields).find((x) => re.test(x)); return k ? r.fields[k] : []; };

// JSON POST for the Claim Survey payload (TC062/063 "hit the JSON via SoapUI").
async function postJson(service, json) {
  const c = cfg(service);
  const { status, text } = await http(c.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(c.auth ? { authorization: c.auth } : {}) }, body: JSON.stringify(json) }, SERVICES[service]);
  return { status, text };
}

module.exports = { SERVICES, cfg, describe, call, pick, flatten, postJson };
