// Small DOM + storage helpers shared by every section.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) if (sv != null) el.style.setProperty(sk.startsWith('--') ? sk : sk.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), sv);
    }
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// replaceChildren that skips null/false (the native one would print "null")
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter(c => c != null && c !== false));
}

export const store = {
  get(k, d = null) {
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

// Confirmations disappear on their own; errors stay until tapped (HIG: avoid timed UI for things you must read)
export function toast(msg, kind = '') {
  const box = document.getElementById('toasts');
  const t = h('button', { type: 'button', class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status', onclick: () => t.remove() },
    msg, kind === 'error' ? h('small', {}, 'Tap to dismiss') : null);
  box.append(t);
  if (kind !== 'error') setTimeout(() => t.remove(), 3000);
}

// iOS-style sheet: grabber, swipe down to dismiss, title in the middle.
// If the body contains a <form>, its submit button moves to the top-trailing corner (HIG: Cancel
// top-leading, Done/Save top-trailing) and closing with unsaved changes asks first.
export function modal(title, body, { onClose, full } = {}) {
  const content = h('div', { class: 'sheet-body' }, body);
  const form = content.querySelector('form');
  const submit = form?.querySelector('button[type=submit]');
  let dirty = false;
  form?.addEventListener('input', () => { dirty = true; });

  let primary = null;
  if (submit) {
    const label = () => submit.dataset.bar || (submit.textContent.length <= 14 ? submit.textContent : 'Save');
    primary = h('button', { type: 'button', class: 'bar-btn prominent', onclick: () => form.requestSubmit(submit) }, label());
    submit.classList.add('sheet-submit');
    new MutationObserver(() => { primary.disabled = submit.disabled; primary.textContent = label(); })
      .observe(submit, { attributes: true, childList: true, characterData: true, subtree: true });
  }

  const head = h('div', { class: 'sheet-head' },
    h('div', { class: 'grabber', 'aria-hidden': 'true' }),
    h('div', { class: 'sheet-bar' },
      submit ? h('button', { type: 'button', class: 'bar-btn', onclick: () => tryClose() }, 'Cancel') : h('span'),
      h('h2', {}, title),
      primary || h('button', { type: 'button', class: 'close-btn', 'aria-label': 'Close', onclick: () => tryClose() },
        h('span', { class: 'icon', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>' }))));
  const sheet = h('div', { class: 'sheet' + (full ? ' full' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, head, content);
  const backdrop = h('div', { class: 'backdrop', onclick: e => { if (e.target === backdrop) tryClose(); } }, sheet);

  // Swipe down on the header to dismiss
  let startY = null;
  head.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; startY = e.clientY; head.setPointerCapture(e.pointerId); sheet.style.transition = 'none'; });
  head.addEventListener('pointermove', e => { if (startY != null) sheet.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`; });
  const end = e => {
    if (startY == null) return;
    const dy = e.clientY - startY;
    startY = null;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 110) tryClose();
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
  const onKey = e => { if (e.key === 'Escape' && backdrop === document.querySelector('.backdrop:last-of-type')) tryClose(); };
  document.addEventListener('keydown', onKey);

  document.body.append(backdrop);
  document.body.classList.add('modal-open');
  let closed = false;
  function tryClose() {
    if (dirty && !confirm('Discard your changes?')) return;
    close();
  }
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (!document.querySelector('.backdrop')) document.body.classList.remove('modal-open');
    onClose?.();
  }
  return { close, el: sheet };
}

export const isModalOpen = () => !!document.querySelector('.backdrop');

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
}

// iOS-style activity indicator (8 spokes)
export const activity = () => h('span', { class: 'spin', 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24">${
  Array.from({ length: 8 }, (_, i) => `<line x1="12" y1="2.5" x2="12" y2="7" transform="rotate(${i * 45} 12 12)" opacity="${(0.3 + i * 0.1).toFixed(1)}"/>`).join('')}</svg>` });

export function spinner(text = 'Loading…') {
  return h('div', { class: 'loading', role: 'status' }, activity(), text);
}

export const errMsg = e => e?.message || String(e);

// ---- dates ----
const z = n => String(n).padStart(2, '0');
export const ymd = (d = new Date()) => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
export const hhmm = d => `${z(d.getHours())}:${z(d.getMinutes())}`;
export function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
export const hm = d => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const dayLabel = d => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
export const shortDate = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// Make a string safe as a Dropbox/Windows/Mac file name
export const safeName = s => s.replace(/\s*[\\/:*?"<>|]+\s*/g, ' - ').replace(/\s+/g, ' ').trim().replace(/[. -]+$/, '');

// ---- images ----
export async function compressImage(file, maxDim = 2000, quality = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Could not read that image'));
      i.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Could not compress image'))), 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

export function utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const base64url = s => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
