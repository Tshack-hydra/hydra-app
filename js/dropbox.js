// Dropbox via its web API (OAuth PKCE, no server): works without any computer being on.

import { CONFIG } from '../config.js';
import { store, base64url } from './util.js';
import { redirectUri } from './google.js';

const KEY = 'hydra.dropbox';
const JOBS = 'hydra.jobs';

export const isConnected = () => !!store.get(KEY)?.refreshToken;
export const account = () => store.get(KEY)?.account || null;
export const projectsPath = () => store.get('hydra.dropbox.path') || CONFIG.dropboxProjectsPath;
export function setProjectsPath(p) {
  store.set('hydra.dropbox.path', p.replace(/\/+$/, ''));
  store.del(JOBS);
}

const b64urlBytes = bytes => base64url(btoa(String.fromCharCode(...bytes)));

export async function connect() {
  const verifier = b64urlBytes(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64urlBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = 'dbx-' + crypto.randomUUID();
  sessionStorage.setItem('hydra.dbx.verifier', verifier);
  sessionStorage.setItem('hydra.dbx.state', state);
  sessionStorage.setItem('hydra.dbx.return', location.hash || '#/settings');
  const params = new URLSearchParams({
    client_id: CONFIG.dropboxAppKey,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    redirect_uri: redirectUri(),
    state,
  });
  location.assign('https://www.dropbox.com/oauth2/authorize?' + params);
}

// Call once at start-up; finishes the connect if Dropbox has just redirected back.
export async function handleDropboxRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.get('state')?.startsWith('dbx-')) return;
  const back = sessionStorage.getItem('hydra.dbx.return') || '#/settings';
  history.replaceState(null, '', redirectUri() + back);
  if (q.get('error')) throw new Error('Dropbox: ' + (q.get('error_description') || q.get('error')));
  if (q.get('state') !== sessionStorage.getItem('hydra.dbx.state')) throw new Error('Dropbox connect failed (state mismatch), please try again');
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({
      code: q.get('code'),
      grant_type: 'authorization_code',
      code_verifier: sessionStorage.getItem('hydra.dbx.verifier'),
      client_id: CONFIG.dropboxAppKey,
      redirect_uri: redirectUri(),
    }),
  });
  if (!res.ok) throw new Error('Dropbox connect failed: ' + (await res.text()));
  const t = await res.json();
  store.set(KEY, { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 });
  // Team (Business) accounts need a path-root header to see team folders
  const acct = await rpc('users/get_current_account', null);
  const s = store.get(KEY);
  s.account = { name: acct.name?.display_name, email: acct.email };
  const root = acct.root_info;
  if (root?.['.tag'] === 'team' && root.root_namespace_id !== root.home_namespace_id) {
    s.pathRoot = JSON.stringify({ '.tag': 'root', root: root.root_namespace_id });
  }
  store.set(KEY, s);
}

export function disconnect() {
  store.del(KEY);
  store.del(JOBS);
}

async function token() {
  const s = store.get(KEY);
  if (!s) throw new Error('Dropbox is not connected — connect it in Settings');
  if (s.expiresAt - Date.now() > 60_000) return s.accessToken;
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: CONFIG.dropboxAppKey }),
  });
  if (!res.ok) { disconnect(); throw new Error('Dropbox sign-in expired — reconnect it in Settings'); }
  const t = await res.json();
  store.set(KEY, { ...s, accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 });
  return t.access_token;
}

async function headers(extra = {}) {
  const h = { Authorization: 'Bearer ' + (await token()), ...extra };
  const pr = store.get(KEY)?.pathRoot;
  if (pr) h['Dropbox-API-Path-Root'] = pr;
  return h;
}

async function check(res) {
  if (res.ok) return res;
  let summary = '';
  const text = await res.text();
  try { summary = JSON.parse(text).error_summary; } catch { summary = text; }
  if (res.status === 401) disconnect();
  const err = new Error(summary?.includes('not_found') ? 'Folder not found in Dropbox' : `Dropbox: ${summary || res.status}`);
  err.summary = summary || '';
  throw err;
}

export const isNotFound = e => /not_found/.test(e?.summary || '');

// Dropbox-API-Arg header must be ASCII: escape everything else as \uXXXX
const argHeader = obj => JSON.stringify(obj).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

export async function rpc(endpoint, body) {
  const res = await fetch('https://api.dropboxapi.com/2/' + endpoint, {
    method: 'POST',
    headers: await headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return (await check(res)).json();
}

export async function listFolderAll(path) {
  let d = await rpc('files/list_folder', { path, limit: 2000 });
  const entries = [...d.entries];
  while (d.has_more) {
    d = await rpc('files/list_folder/continue', { cursor: d.cursor });
    entries.push(...d.entries);
  }
  return entries;
}

export async function upload(path, blob, { overwrite = false } = {}) {
  if (blob.size > 140 * 1024 * 1024) throw new Error('File too large for upload');
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: await headers({
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': argHeader({ path, mode: overwrite ? 'overwrite' : 'add', autorename: !overwrite, mute: true }),
    }),
    body: blob,
  });
  return (await check(res)).json();
}

export async function downloadText(path) {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: await headers({ 'Dropbox-API-Arg': argHeader({ path }) }),
  });
  return (await check(res)).text();
}

export async function thumbnail(path) {
  const res = await fetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', {
    method: 'POST',
    headers: await headers({ 'Dropbox-API-Arg': argHeader({ resource: { '.tag': 'path', path }, format: 'jpeg', size: 'w480h320', mode: 'fitone_bestfit' }) }),
  });
  return URL.createObjectURL(await (await check(res)).blob());
}

export async function tempLink(path) {
  return (await rpc('files/get_temporary_link', { path })).link;
}

export const webLink = path => 'https://www.dropbox.com/home' + path.split('/').map(encodeURIComponent).join('/');

// ---- job folders: "H-01886 - Virgin Atlantic Skate x Polar Black 2026" ----

function parseJob(entry, archived) {
  if (entry['.tag'] !== 'folder') return null;
  const m = entry.name.match(/^(H-\d+)\s*-\s*(.+)$/i);
  if (!m || /^H-0+$/i.test(m[1])) return null;
  return { number: m[1].toUpperCase(), title: m[2].trim(), name: entry.name, path: entry.path_display, archived };
}

const jobSort = (a, b) => Number(b.number.slice(2)) - Number(a.number.slice(2)) || a.title.localeCompare(b.title);

export async function listJobs({ force = false, archived = false } = {}) {
  const key = archived ? JOBS + '.archived' : JOBS;
  const cached = store.get(key);
  if (!force && cached && Date.now() - cached.at < 10 * 60_000) return cached.jobs;
  const base = projectsPath() + (archived ? '/Archived Projects' : '');
  const jobs = (await listFolderAll(base)).map(e => parseJob(e, archived)).filter(Boolean).sort(jobSort);
  store.set(key, { at: Date.now(), jobs });
  return jobs;
}

export const cachedJobs = () => store.get(JOBS)?.jobs || [];
