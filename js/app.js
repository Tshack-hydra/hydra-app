// App start-up and routing (#/calendar, #/tasks, #/sheets, #/visits, #/receipts, #/settings).

import { CONFIG } from '../config.js';
import { h, toast, errMsg, spinner, activity, isModalOpen } from './util.js';
import * as google from './google.js';
import * as dbx from './dropbox.js';
import { renderCalendar } from './calendar.js';
import { renderSheets } from './sheets.js';
import { renderTasks } from './tasks.js';
import { renderSiteVisits } from './sitevisits.js';
import { renderReceipts } from './receipts.js';
import { renderSettings } from './settings.js';

const ROUTES = {
  calendar: { title: 'Calendar', render: renderCalendar },
  tasks: { title: 'Tasks', render: renderTasks },
  sheets: { title: 'Sheets', render: renderSheets },
  visits: { title: 'Site Visits', render: renderSiteVisits },
  receipts: { title: 'Receipts', render: renderReceipts },
  settings: { title: 'Settings', render: renderSettings },
};

const main = document.getElementById('page');
const largeTitle = document.getElementById('page-title');
const navTitle = document.getElementById('nav-title');
const navActions = document.getElementById('nav-actions');
const navPrimary = document.getElementById('nav-primary');
const navLeading = document.getElementById('nav-leading');
let ctx = null;
let lastTab = 'calendar';

// Large title collapses into the navigation bar once scrolled past (iOS behaviour)
new IntersectionObserver(([e]) => document.body.classList.toggle('scrolled', !e.isIntersecting), { rootMargin: '-52px 0px 0px 0px' })
  .observe(largeTitle);

function route() {
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const key = ROUTES[name] ? name : 'calendar';
  const r = ROUTES[key];
  if (!google.ensureFresh(15)) return;
  if (ctx) { ctx.alive = false; ctx.leave.forEach(fn => fn()); }
  ctx = {
    alive: true, leave: [],
    onLeave(fn) { this.leave.push(fn); },
    // Page actions go in the navigation bar's trailing group (HIG: max ~3 items)
    actions(...els) {
      const primary = els.filter(e => e.classList.contains('tint'));
      navActions.replaceChildren(...els.filter(e => !primary.includes(e)));
      navPrimary.replaceChildren(...primary);
    },
    // Pull down from the top of the page to reload (instead of a refresh button)
    onRefresh(fn) { refreshFn = fn; },
  };
  refreshFn = null;
  if (key !== 'settings') lastTab = key;
  document.querySelectorAll('.tabbar a').forEach(a => {
    const on = a.dataset.route === lastTab;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.getElementById('settings-link').classList.toggle('hidden', key === 'settings');
  navLeading.replaceChildren(key === 'settings'
    ? h('a', { href: '#/' + lastTab, class: 'nav-icon', 'aria-label': 'Back' }, h('span', { class: 'icon', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>' }))
    : '');
  largeTitle.textContent = navTitle.textContent = r.title;
  navActions.replaceChildren();
  navPrimary.replaceChildren();
  main.replaceChildren();
  window.scrollTo(0, 0);
  try {
    r.render(main, ctx);
  } catch (e) {
    main.append(h('p', { class: 'error' }, errMsg(e)));
  }
}

function showGate(...content) {
  document.body.classList.add('gated');
  main.replaceChildren(h('div', { class: 'gate' }, h('h1', { 'aria-label': 'Hydra Studio' }, h('span', { class: 'wordmark', 'aria-hidden': 'true' }), h('small', { 'aria-hidden': 'true' }, 'Studio')), ...content));
}

async function boot() {
  const gErr = google.handleGoogleRedirect();
  if (google.isRedirecting()) { showGate(spinner('Signing in…')); return; }
  try { await dbx.handleDropboxRedirect(); } catch (e) { toast(errMsg(e), 'error'); }

  const missing = ['googleClientId', 'spreadsheetId', 'dropboxAppKey'].filter(k => !CONFIG[k]);
  if (!CONFIG.googleClientId) {
    showGate(h('p', {}, 'The app isn’t set up yet. Fill in these values in config.js (see README.md):'), h('ul', {}, missing.map(k => h('li', {}, h('code', {}, k)))));
    return;
  }

  if (!google.hasSession()) {
    showGate(
      gErr ? h('p', { class: 'error' }, gErr) : null,
      h('p', { class: 'muted' }, `Sign in with your @${CONFIG.workspaceDomain} Google account.`),
      h('button', { class: 'btn primary big', onclick: () => google.signIn() }, 'Sign in with Google'));
    return;
  }
  if (!google.ensureFresh(15)) { showGate(spinner('Signing in…')); return; }

  if (!google.currentUser()) {
    showGate(spinner('Signing in…'));
    try {
      const u = await google.loadUser();
      if (CONFIG.workspaceDomain && !u.email?.toLowerCase().endsWith('@' + CONFIG.workspaceDomain)) {
        google.signOut();
        showGate(h('p', { class: 'error' }, `${u.email} isn’t a ${CONFIG.workspaceDomain} account.`), h('button', { class: 'btn primary', onclick: () => google.signIn() }, 'Use another account'));
        return;
      }
    } catch (e) {
      showGate(h('p', { class: 'error' }, errMsg(e)), h('button', { class: 'btn primary', onclick: () => google.signIn() }, 'Try again'));
      return;
    }
  }

  document.body.classList.remove('gated');
  window.addEventListener('hashchange', route);
  route();
  // Renew the hour-long Google token as the app comes back to the front, so it never runs out mid-task
  // (silent: no Google screen while the phone is still signed in to Google). Not while a form is open.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !isModalOpen()) google.ensureFresh(15);
  });
}

// ---- pull to refresh (as in Mail, Reminders…): pull the page down from the top past the line ----
let refreshFn = null;
const ptr = h('div', { class: 'ptr', 'aria-hidden': 'true' }, activity());
document.body.append(ptr);
(() => {
  const TRIGGER = 70; // px of pull (after resistance) that starts a refresh
  let startY = null, pull = 0, busy = false;
  const show = d => {
    pull = d;
    ptr.style.setProperty('--pull', d + 'px');
    ptr.style.setProperty('--turn', Math.round(d * 4) + 'deg');
    ptr.classList.toggle('on', d > 4);
    ptr.classList.toggle('ready', d >= TRIGGER);
  };
  addEventListener('touchstart', e => {
    startY = !busy && refreshFn && !isModalOpen() && scrollY <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
  }, { passive: true });
  addEventListener('touchmove', e => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    show(dy > 0 && scrollY <= 0 ? Math.min(dy * 0.5, TRIGGER * 1.6) : 0);
  }, { passive: true });
  addEventListener('touchend', async () => {
    if (startY == null) return;
    startY = null;
    if (pull < TRIGGER) { show(0); return; }
    busy = true;
    ptr.classList.add('busy');
    show(TRIGGER);
    try { await refreshFn?.(); } catch { /* the section shows its own error */ }
    busy = false;
    ptr.classList.remove('busy');
    show(0);
  });
})();

// ---- updates: a new publish installs in the background, then we offer to switch to it ----
function showUpdateBanner(worker) {
  if (document.querySelector('.update-banner')) return;
  const banner = h('div', { class: 'update-banner', role: 'alert' },
    h('div', { class: 'row-main' }, h('b', {}, 'New version available'), h('small', {}, 'Update to get the latest changes.')),
    h('button', { class: 'link', onclick: () => banner.remove() }, 'Later'),
    h('button', { class: 'btn primary small', onclick: e => {
      e.target.disabled = true;
      updateRequested = true;
      if (worker.state === 'activated') location.reload(); // another tab already switched over
      else worker.postMessage('SKIP_WAITING');
    } }, 'Update'));
  document.body.append(banner);
}
let updateRequested = false;

async function setupUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.register('sw.js').catch(() => null);
  if (!reg) return;
  if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    // no controller yet = very first install, nothing to update from
    w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(w); });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested || reloading) return; // only reload when the person tapped Update
    reloading = true;
    location.reload();
  });
  // Look for a new version whenever the app comes back to the front, and every 30 minutes
  const check = () => reg.update().catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  setInterval(check, 30 * 60_000);
}

setupUpdates();
boot();
