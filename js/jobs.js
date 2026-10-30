// Searchable job-number picker fed from the Dropbox job folders.

import { h, fill, store, errMsg } from './util.js';
import * as dbx from './dropbox.js';

const RECENT = 'hydra.recentJobs';

export function connectDropboxPrompt() {
  return h('div', { class: 'card center' },
    h('p', {}, 'Connect Dropbox to pick jobs and save photos to the job folders.'),
    h('a', { class: 'btn primary', href: '#/settings' }, 'Go to Settings'));
}

// value: { number, title, path } or null. onChange(job|null)
export function jobPicker({ value = null, onChange, required = false }) {
  let jobs = dbx.cachedJobs();
  let archived = null;
  let selected = value;
  let loadError = '';

  const input = h('input', { type: 'search', placeholder: 'Search job number or name…', autocomplete: 'off', enterkeyhint: 'search' });
  const list = h('div', { class: 'picker-list hidden', role: 'listbox' });
  const chosen = h('div', { class: 'picker-chosen' });
  const wrap = h('div', { class: 'picker' + (required ? ' required' : '') }, chosen, input, list);

  function renderChosen() {
    chosen.replaceChildren();
    if (selected) {
      chosen.append(h('div', { class: 'job-chip' },
        h('b', {}, selected.number), h('span', {}, selected.title),
        h('button', { type: 'button', class: 'link', onclick: () => { select(null); input.focus(); } }, 'Change')));
      input.classList.add('hidden');
      list.classList.add('hidden');
    } else {
      input.classList.remove('hidden');
    }
  }

  function matches(q) {
    const all = [...jobs, ...(archived || [])];
    if (!q) {
      const recent = store.get(RECENT, []);
      const top = recent.map(p => all.find(j => j.path === p)).filter(Boolean);
      return [...top, ...jobs.filter(j => !recent.includes(j.path))];
    }
    const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); // "estee" finds "Estée"
    const words = fold(q).split(/\s+/).filter(Boolean);
    return all.filter(j => {
      const hay = fold(j.number + ' ' + j.number.replace(/^H-0*/, '') + ' ' + j.title);
      return words.every(w => hay.includes(w));
    });
  }

  function renderList() {
    const q = input.value.trim();
    const items = matches(q).slice(0, 50);
    const keep = e => e.preventDefault(); // keep focus so blur doesn't close before click
    fill(list,
      loadError ? h('div', { class: 'picker-item error' }, loadError) : null,
      !jobs.length && !loadError ? h('div', { class: 'picker-item muted' }, 'Loading jobs…') : null,
      ...items.map(j => h('button', { type: 'button', class: 'picker-item', onpointerdown: keep, onclick: () => select(j) },
        h('b', {}, j.number), h('span', {}, j.title), j.archived ? h('small', { class: 'tag' }, 'archived') : null)),
      archived ? null : h('button', { type: 'button', class: 'picker-item muted', onpointerdown: keep, onclick: loadArchived }, 'Include archived projects…'),
    );
    list.classList.remove('hidden');
  }

  async function loadArchived() {
    try {
      list.prepend(h('div', { class: 'picker-item muted' }, 'Loading archived projects…'));
      archived = await dbx.listJobs({ archived: true });
    } catch (e) { loadError = errMsg(e); }
    renderList();
  }

  function select(j) {
    selected = j;
    if (j) store.set(RECENT, [j.path, ...store.get(RECENT, []).filter(p => p !== j.path)].slice(0, 8));
    input.value = '';
    renderChosen();
    onChange?.(j);
  }

  input.addEventListener('focus', renderList);
  input.addEventListener('input', renderList);
  input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 150));

  if (dbx.isConnected()) {
    dbx.listJobs()
      .then(js => { jobs = js; if (document.activeElement === input) renderList(); })
      .catch(e => { loadError = errMsg(e); if (document.activeElement === input) renderList(); });
  } else {
    loadError = 'Connect Dropbox in Settings to load jobs';
  }

  renderChosen();
  wrap.getValue = () => selected;
  return wrap;
}
