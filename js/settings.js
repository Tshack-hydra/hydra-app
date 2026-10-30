// Per-person settings (stored on this phone only).

import { CONFIG } from '../config.js';
import { h, store, field, toast, errMsg } from './util.js';
import { currentUser, signOut, nameInitials } from './google.js';
import * as dbx from './dropbox.js';
import { dextEmail } from './receipts.js';

export const APP_VERSION = '0.3.0';

export function renderSettings(root) {
  const user = currentUser();
  const versionLine = h('p', { class: 'small muted' }, `Version ${APP_VERSION}`);

  const initials = h('input', { type: 'text', value: store.get('hydra.initials') || '', placeholder: nameInitials() || 'e.g. TS', maxlength: 4, autocapitalize: 'characters' });
  initials.addEventListener('change', () => { store.set('hydra.initials', initials.value.trim().toUpperCase()); toast('Saved'); });

  const dext = h('input', { type: 'email', value: dextEmail() || '', placeholder: 'yourname@dext.cc' });
  dext.addEventListener('change', () => { store.set('hydra.dextEmail', dext.value.trim()); toast('Saved'); });

  const path = h('input', { type: 'text', value: dbx.projectsPath() });
  const testOut = h('p', { class: 'small' });
  const test = async () => {
    dbx.setProjectsPath(path.value.trim());
    testOut.textContent = 'Checking…';
    testOut.className = 'small muted';
    try {
      const jobs = await dbx.listJobs({ force: true });
      testOut.textContent = `✓ Found ${jobs.length} job folders (latest ${jobs[0]?.number || '—'})`;
      testOut.className = 'small ok';
    } catch (e) {
      testOut.textContent = '✕ ' + errMsg(e);
      testOut.className = 'small error';
    }
  };

  root.append(
    h('section', { class: 'card' },
      h('h3', {}, 'Google'),
      user ? h('p', {}, user.picture ? h('img', { class: 'avatar', src: user.picture, alt: '' }) : null, h('b', {}, user.name), h('br'), h('small', { class: 'muted' }, user.email)) : null,
      h('button', { class: 'btn danger', onclick: () => { signOut(); location.hash = ''; location.reload(); } }, 'Sign Out')),

    h('section', { class: 'card' },
      h('h3', {}, 'You'),
      field('Your initials', initials, 'Used for Tasks and “Mine” on the To Do List, and pre-filled when you add a task. Leave blank to use your Google name.'),
      field('Your Dext email-in address', dext, 'In Dext: Inbox → Add receipts → Email. Receipts are emailed here from your Gmail.')),

    h('section', { class: 'card' },
      h('h3', {}, 'Dropbox'),
      dbx.isConnected()
        ? [
          h('p', {}, '✓ Connected', dbx.account()?.email ? ` as ${dbx.account().email}` : ''),
          field('Job folders path (inside Dropbox)', path, `Default: ${CONFIG.dropboxProjectsPath}`),
          h('div', { class: 'actions' },
            h('button', { class: 'btn primary', onclick: test }, 'Save & test'),
            h('button', { class: 'btn danger', onclick: () => { dbx.disconnect(); toast('Dropbox disconnected'); location.reload(); } }, 'Disconnect')),
          testOut,
        ]
        : [
          h('p', {}, 'Connect your Dropbox account so the app can see the job folders and save photos.'),
          CONFIG.dropboxAppKey
            ? h('button', { class: 'btn primary', onclick: () => dbx.connect() }, 'Connect Dropbox')
            : h('p', { class: 'error' }, 'dropboxAppKey is missing from config.js'),
        ]),

    h('section', { class: 'card' },
      h('h3', {}, 'App'),
      versionLine,
      h('button', { class: 'btn', onclick: async e => {
        e.target.disabled = true;
        try {
          const reg = await navigator.serviceWorker?.getRegistration();
          if (!reg) { toast('Updates work once the app is installed from its web address'); return; }
          await reg.update();
          if (reg.installing || reg.waiting) toast('Update found — tap Update when it appears');
          else toast('You’re on the latest version');
        } catch (err) { toast(errMsg(err), 'error'); }
        finally { e.target.disabled = false; }
      } }, 'Check for Updates')),

    h('footer', { class: 'brand-foot', 'aria-label': 'Hydra Studio' }, h('span', { class: 'wordmark', 'aria-hidden': 'true' }), h('p', {}, 'Studio · hydradesign.co.uk')));

  // The service worker knows which published build is running (commit id, set by the publish workflow)
  navigator.serviceWorker?.controller?.postMessage('BUILD');
  const onMsg = e => {
    if (!e.data?.build) return;
    versionLine.textContent = `Version ${APP_VERSION}` + (e.data.build === '__BUILD__' ? ' (local copy)' : ` · build ${e.data.build}`);
    navigator.serviceWorker.removeEventListener('message', onMsg);
  };
  navigator.serviceWorker?.addEventListener('message', onMsg);
}
