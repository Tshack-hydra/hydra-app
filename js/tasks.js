// Tasks: everything assigned to you (your initials or ALL) across every task-list tab of the Hydra
// spreadsheet, so you don't have to open each tab. The sheet stays the only copy — ticking here paints
// the row green there, and rows added by anyone (or by Claude) appear on the next refresh.
//
// A tab counts as a task list when it has a "Task | Who | Done" header, or ≤ 3 columns. Done tasks stay
// in the list (tinted green) unless "Hide Done" is on.

import { CONFIG } from '../config.js';
import { tokenValid, myInitials } from './google.js';
import { icon } from './icons.js';
import { h, fill, store, modal, field, toast, errMsg, spinner, isModalOpen, hm } from './util.js';
import { fetchTabs, fetchAllGrids, isListTab, parseList, whoList, initialsTag, whoPicker, whoOptions, guardedWrite, setDone, insertTask } from './sheets.js';

export function renderTasks(root, ctx) {
  if (!CONFIG.spreadsheetId) {
    root.append(h('p', { class: 'error' }, 'No spreadsheet set — add spreadsheetId to config.js.'));
    return;
  }
  const tools = h('div', { class: 'toolbar wrap' });
  const body = h('div', { class: 'sheet-view' }, spinner());
  const status = h('div', { class: 'sync muted small' });
  root.append(tools, body, status);

  let lists = null; // [{ tab, used, sections }]
  let lastSig = '';
  let pending = false;
  let busy = false;

  const who = () => store.get('hydra.tasks.who', 'mine');
  const hideDone = () => store.get('hydra.tasks.hideDone', false);
  const me = myInitials;
  const forMe = t => whoList(t.who).some(w => w === me() || w === 'ALL');

  ctx.actions(h('button', { class: 'nav-icon tint', 'aria-label': 'New task', onclick: () => addTask() }, icon('plus')));
  ctx.onRefresh(() => refresh(true));

  async function refresh(force) {
    if (busy && !force) return;
    busy = true;
    try {
      const tabs = await fetchTabs();
      const grids = await fetchAllGrids(tabs);
      if (!ctx.alive) return;
      status.textContent = `Live · updated ${hm(new Date())}`;
      const sig = JSON.stringify([...grids]);
      lists = tabs.filter(t => grids.has(t.sheetId) && isListTab(t, grids.get(t.sheetId)))
        .map(tab => ({ tab, ...parseList(grids.get(tab.sheetId)) }));
      if (sig === lastSig && !force) return;
      lastSig = sig;
      if (isModalOpen()) { pending = true; return; }
      render();
    } catch (e) {
      if (!lists) fill(body, h('p', { class: 'error' }, errMsg(e)));
      else status.textContent = 'Offline? ' + errMsg(e);
    } finally {
      busy = false;
    }
  }

  const dialog = (title, content) => modal(title, content, { onClose: () => { if (pending) { pending = false; render(); } } });

  function render() {
    if (!lists) return;
    const mine = who() === 'mine';
    fill(tools, h('div', { class: 'seg', role: 'group', 'aria-label': 'Whose tasks' },
      h('button', { class: mine ? 'on' : '', 'aria-pressed': String(mine), onclick: () => { store.set('hydra.tasks.who', 'mine'); render(); } }, 'Mine'),
      h('button', { class: mine ? '' : 'on', 'aria-pressed': String(!mine), onclick: () => { store.set('hydra.tasks.who', 'all'); render(); } }, 'All')),
      h('button', { class: 'chip end' + (hideDone() ? '' : ' off'), 'aria-pressed': String(hideDone()), onclick: () => { store.set('hydra.tasks.hideDone', !hideDone()); render(); } }, hideDone() ? 'Show Done' : 'Hide Done'));

    if (mine && !me()) {
      fill(body, h('section', { class: 'card center' },
        h('p', {}, 'Add your initials in Settings to see the tasks assigned to you.'),
        h('a', { class: 'btn primary', href: '#/settings' }, 'Open Settings')));
      return;
    }
    if (!lists.length) {
      fill(body, h('p', { class: 'muted' }, 'No task-list tabs in the spreadsheet yet. A tab with up to 3 columns (Task, Who, Due) shows up here.'));
      return;
    }

    const show = t => (!hideDone() || !t.done) && (!mine || forMe(t));
    const groups = [];
    for (const l of lists) for (const s of l.sections) {
      const tasks = s.tasks.filter(show);
      if (tasks.length) groups.push({ l, s, tasks });
    }
    if (!groups.length) {
      fill(body, h('section', { class: 'card center' }, h('p', {}, mine ? `Nothing ${hideDone() ? 'open ' : ''}for ${me()}.` : hideDone() ? 'No open tasks.' : 'No tasks.')));
      return;
    }
    // Show the tab name only when there's more than one task list, so a single TO DO tab reads cleanly
    const many = lists.length > 1;
    fill(body, groups.map(({ l, s, tasks }) => h('section', { class: 'task-section' },
      h('h3', {}, [many ? l.tab.title : '', s.title].filter(Boolean).join(' · ') || 'Tasks', h('span', { class: 'count' }, openCount(tasks))),
      tasks.map(t => taskRow(l, t)))));
  }

  const openCount = tasks => {
    const open = tasks.filter(t => !t.done).length;
    return open ? `${open} open` : 'all done';
  };

  function taskRow(l, t) {
    return h('div', { class: 'task' + (t.done ? ' done' : '') },
      h('button', { class: 'tick', 'aria-label': t.done ? 'Mark not done' : 'Mark done', onclick: () => toggleDone(l, t) }, t.done ? '✓' : ''),
      h('button', { class: 'task-text', onclick: () => openInSheets(l.tab) },
        h('span', {}, t.text || h('i', { class: 'muted' }, '(blank)')),
        t.extra.length ? h('small', { class: 'muted' }, t.extra.join(' · ')) : null),
      h('span', { class: 'who' }, whoList(t.who).map(initialsTag)));
  }

  // Ticked tasks stay in the list (tinted green) unless Hide Done is on; tap again to untick
  // Shows at once (counts included), then saves — re-checking the row first — and refreshes quietly
  async function toggleDone(l, t) {
    const done = !t.done;
    t.done = done;
    render();
    await guardedWrite(l.tab, t.row, 0, t.text, () => setDone(l.tab, t, l.used, done));
    await refresh(true);
  }

  function openInSheets(tab) {
    store.set('hydra.sheets.active', tab.sheetId);
    location.hash = '#/sheets';
  }

  // New task: pick which list/section it goes under; it's added as the last row of that section
  function addTask() {
    if (!lists?.length) { toast('No task-list tab to add to yet', 'error'); return; }
    const targets = lists.flatMap((l, li) => l.sections.map((s, si) => ({ l, s, key: `${li}:${si}`, label: [l.tab.title, s.title].filter(Boolean).join(' › ') })));
    const lastKey = store.get('hydra.tasks.lastTarget');
    const where = h('select', {}, targets.map(t => h('option', { value: t.key, selected: t.label === lastKey }, t.label)));
    const ta = h('textarea', { rows: 3, required: true });
    const wi = whoPicker(me(), whoOptions(lists.flatMap(l => l.sections.flatMap(s => s.tasks.map(t => t.who)))));
    const btn = h('button', { class: 'btn primary block', type: 'submit', 'data-bar': 'Add' }, 'Add task');
    const m = dialog('New task', h('form', { class: 'form', onsubmit: async e => {
      e.preventDefault();
      if (!ta.value.trim()) return;
      btn.disabled = true;
      const t = targets.find(x => x.key === where.value);
      store.set('hydra.tasks.lastTarget', t.label);
      m.close();
      await insertTask(t.l.tab, t.s, t.l.used, ta.value.trim(), wi.value());
      await refresh(true);
    } }, field('Task', ta), wi.el, field('List', where), btn));
    setTimeout(() => ta.focus(), 50);
  }

  refresh(true);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible' && tokenValid(5 * 60_000)) refresh();
  }, Math.max(10, CONFIG.sheetRefreshSeconds) * 1000);
  const onVis = () => { if (document.visibilityState === 'visible' && tokenValid(5 * 60_000)) refresh(); };
  document.addEventListener('visibilitychange', onVis);
  ctx.onLeave(() => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); });
}
