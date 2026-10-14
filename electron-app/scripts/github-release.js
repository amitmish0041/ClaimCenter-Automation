// electron-app/scripts/github-release.js
//
// Minimal GitHub Releases calls for the release scripts (Node's built-in fetch). The token comes ONLY from the
// releaser's own GH_TOKEN environment variable at release time — never stored in the repo or the app.
'use strict';

const { publish } = require('../electron-builder.config.js');

const OWNER = publish.owner;
const REPO = publish.repo;

function token() {
  const t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!t) throw new Error('GH_TOKEN is not set — set it in this terminal first ($env:GH_TOKEN = "<your token>").');
  return t;
}

async function api(method, pathname, body, { auth = true, base = 'https://api.github.com', headers = {}, raw } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'claimcenter-runner-release',
      ...(auth ? { Authorization: `Bearer ${token()}` } : {}),
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch (_) { return text; } })() : null;
  return { status: res.status, data };
}

async function releaseByTag(tag, { auth = false } = {}) {
  const r = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`, null, { auth });
  return r.status === 200 ? r.data : null;
}

async function latestRelease() {
  const r = await api('GET', `/repos/${OWNER}/${REPO}/releases/latest`, null, { auth: false });
  return r.status === 200 ? r.data : null;
}

async function createRelease(fields) {
  const r = await api('POST', `/repos/${OWNER}/${REPO}/releases`, fields);
  if (r.status !== 201) throw new Error(`creating release ${fields.tag_name} failed (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}

// Uploads (or replaces) one asset on a release.
async function uploadAsset(release, name, buffer, contentType) {
  for (const a of release.assets || []) {
    if (a.name === name) await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${a.id}`);
  }
  const r = await api('POST', `/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, null, {
    base: 'https://uploads.github.com', headers: { 'Content-Type': contentType }, raw: buffer,
  });
  if (r.status !== 201) throw new Error(`uploading ${name} failed (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}

async function downloadAsset(release, name) {
  const a = (release.assets || []).find((x) => x.name === name);
  if (!a) return null;
  const res = await fetch(a.browser_download_url, { headers: { 'User-Agent': 'claimcenter-runner-release' } });
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
}

module.exports = { OWNER, REPO, api, releaseByTag, latestRelease, createRelease, uploadAsset, downloadAsset };
