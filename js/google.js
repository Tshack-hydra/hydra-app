// Google sign-in (OAuth implicit redirect flow — no server needed) and API helper.
// A redirect works inside an iPhone home-screen app, where pop-ups don't.

import { CONFIG } from '../config.js';
import { store, utf8ToBase64, base64url } from './util.js';

const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.send',
];
const TOKEN = 'hydra.google.token';
const USER = 'hydra.google.user';

export const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

// Call once at start-up. Returns an error string if Google sent one back.
export function handleGoogleRedirect() {
  const hash = location.hash.slice(1);
  if (!/(^|&)(access_token|error)=/.test(hash)) return null;
  const p = new URLSearchParams(hash);
  const back = sessionStorage.getItem('hydra.google.return') || '#/calendar';
  const expected = sessionStorage.getItem('hydra.google.state');
  sessionStorage.removeItem('hydra.google.state');
  history.replaceState(null, '', redirectUri() + back);
  if (p.get('error')) return `Google sign-in failed: ${p.get('error')}`;
  if (!expected || p.get('state') !== expected) return 'Google sign-in failed: state mismatch, please try again';
  store.set(TOKEN, {
    accessToken: p.get('access_token'),
    expiresAt: Date.now() + Number(p.get('expires_in') || 3600) * 1000,
  });
  return null;
}

export function signIn() {
  const state = crypto.randomUUID();
  sessionStorage.setItem('hydra.google.state', state);
  sessionStorage.setItem('hydra.google.return', location.hash.startsWith('#/') ? location.hash : '#/calendar');
  const params = new URLSearchParams({
    client_id: CONFIG.googleClientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES.join(' '),
    include_granted_scopes: 'true',
    state,
  });
  if (CONFIG.workspaceDomain) params.set('hd', CONFIG.workspaceDomain);
  const user = store.get(USER);
  if (user?.email) params.set('login_hint', user.email);
  else params.set('prompt', 'select_account');
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + params);
}

export const hasSession = () => !!store.get(TOKEN);
export const currentUser = () => store.get(USER);

// Initials used in the sheets' "who" column: set in Settings, else first + last name ("Tom Shackleton" → TS)
export const nameInitials = () => {
  const parts = (currentUser()?.name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() : '';
};
export const myInitials = () => (store.get('hydra.initials') || '').toUpperCase().trim() || nameInitials();

export function tokenValid(marginMs = 60_000) {
  const t = store.get(TOKEN);
  return !!t && t.expiresAt - Date.now() > marginMs;
}

// Google tokens last an hour. Renew on navigation (when nothing is half-typed) if it's close
// to expiring. Returns false if a redirect has started.
export function ensureFresh(minutes = 15) {
  if (hasSession() && !tokenValid(minutes * 60_000)) { signIn(); return false; }
  return true;
}

export async function gfetch(url, opts = {}) {
  if (!tokenValid()) { signIn(); throw new Error('Renewing Google sign-in…'); }
  const { accessToken } = store.get(TOKEN);
  const headers = { Authorization: 'Bearer ' + accessToken, ...opts.headers };
  let body = opts.body;
  if (body && typeof body === 'object' && !(body instanceof Blob)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...opts, headers, body });
  if (res.status === 401) { store.del(TOKEN); signIn(); throw new Error('Renewing Google sign-in…'); }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error?.message; } catch { /* not JSON */ }
    throw new Error(msg || `Google error ${res.status}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function loadUser() {
  const u = await gfetch('https://openidconnect.googleapis.com/v1/userinfo');
  store.set(USER, { email: u.email, name: u.name, picture: u.picture });
  return store.get(USER);
}

export function signOut() {
  const t = store.get(TOKEN);
  if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.accessToken), { method: 'POST' }).catch(() => {});
  store.del(TOKEN);
  store.del(USER);
}

// Send an email from the signed-in person's Gmail. attachments: [{ name, type, base64 }]
export async function sendEmail({ to, subject, text, attachments = [] }) {
  const boundary = 'hydra_' + crypto.randomUUID();
  const asciiName = n => n.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const wrap = b64 => b64.replace(/.{76}/g, '$&\r\n');
  const parts = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${utf8ToBase64(subject)}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(utf8ToBase64(text)),
  ];
  for (const a of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.type}; name="${asciiName(a.name)}"`,
      `Content-Disposition: attachment; filename="${asciiName(a.name)}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap(a.base64));
  }
  parts.push(`--${boundary}--`, '');
  const raw = base64url(btoa(parts.join('\r\n')));
  return gfetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', body: { raw } });
}
