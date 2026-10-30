// Sheets: live view of every tab in the Hydra spreadsheet. Nothing about the tabs is hard-coded —
// the tab list and contents are re-read every few seconds, so new tabs/rows/columns just appear.
//
// Narrow tabs (≤ 3 columns, like TO DO LIST) show as a task list:
//   bold row with only column A filled = section heading (e.g. "Alo Shanghai")
//   column A = task, column B = who (initials, "SP/TS", "ALL")
//   green fill = done (ticking a task paints the row green, like the team does by hand)
// Wider tabs show as a scrollable table where any cell can be edited.

import { CONFIG } from '../config.js';
import { gfetch, tokenValid, myInitials } from './google.js';
import { icon } from './icons.js';
import { h, fill, store, modal, field, toast, errMsg, spinner, isModalOpen, hm } from './util.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const sid = () => CONFIG.spreadsheetId;
const GREEN = { red: 0.204, green: 0.659, blue: 0.325 };
const WHITE = { red: 1, green: 1, blue: 1 };

const quote = title => `'${title.replace(/'/g, "''")}'`;
export const colLetter = n => { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const a1 = (tab, r, c, c2 = c) => `${quote(tab.title)}!${colLetter(c)}${r + 1}${c2 !== c ? ':' + colLetter(c2) + (r + 1) : ''}`;

export const isGreen = bg => {
  if (!bg) return false;
  const r = bg.red || 0, g = bg.green || 0, b = bg.blue || 0;
  return g > 0.45 && g - r > 0.2 && g - b > 0.2;
};
const isWhite = bg => !bg || ((bg.red ?? 0) > 0.98 && (bg.green ?? 0) > 0.98 && (bg.blue ?? 0) > 0.98);
const bgCss = bg => (isWhite(bg) ? null : `rgb(${Math.round((bg.red || 0) * 255)},${Math.round((bg.green || 0) * 255)},${Math.round((bg.blue || 0) * 255)})`);
const isDark = bg => !isWhite(bg) && (0.299 * (bg.red || 0) + 0.587 * (bg.green || 0) + 0.114 * (bg.blue || 0)) < 0.55;

export function usedCols(rows) {
  let n = 0;
  for (const r of rows) for (let c = r.length - 1; c >= n; c--) if (r[c]?.v) { n = c + 1; break; }
  return n;
}

// Group rows into sections of tasks (see header comment)
export function parseList(rows) {
  const used = Math.max(usedCols(rows), 2);
  const sections = [];
  let cur = { title: '', row: -1, tasks: [] };
  sections.push(cur);
  rows.forEach((r, i) => {
    const a = (r[0]?.v || '').trim();
    const rest = r.slice(1, used).map(c => (c?.v || '').trim());
    if (!a && !rest.some(Boolean)) return;
    if (a && r[0]?.bold && !rest.some(Boolean)) {
      cur = { title: a, row: i, tasks: [] };
      sections.push(cur);
      return;
    }
    cur.tasks.push({ row: i, text: a, who: rest[0] || '', extra: rest.slice(1).filter(Boolean), done: isGreen(r[0]?.bg) || isGreen(r[1]?.bg) });
  });
  return { used, sections: sections.filter(s => s.title || s.tasks.length) };
}

export const whoList = who => who.toUpperCase().split(/[\/,&+\s]+/).filter(Boolean);

// ---- API ----
export async function fetchTabs() {
  const fields = 'sheets.properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount))';
  const d = await gfetch(`${API}${sid()}?fields=${encodeURIComponent(fields)}`);
  return (d.sheets || []).map(s => s.properties).filter(p => !p.hidden).sort((a, b) => a.index - b.index);
}

async function fetchGrid(tab) {
  const fields = `sheets(${GRID_FIELDS})`;
  const d = await gfetch(`${API}${sid()}?includeGridData=true&ranges=${encodeURIComponent(quote(tab.title))}&fields=${encodeURIComponent(fields)}`);
  return toRows(d.sheets?.[0]?.data?.[0]?.rowData);
}

const GRID_FIELDS = 'data(rowData(values(formattedValue,hyperlink,effectiveFormat(backgroundColor,textFormat(bold)))))';
function toRows(rowData) {
  const rows = (rowData || []).map(r => (r.values || []).map(c => ({
    v: c.formattedValue ?? '',
    link: c.hyperlink || null,
    bg: c.effectiveFormat?.backgroundColor || null,
    bold: !!c.effectiveFormat?.textFormat?.bold,
  })));
  while (rows.length && !rows[rows.length - 1].some(c => c.v)) rows.pop();
  return rows;
}

// Every visible tab's contents in one request: Map sheetId → rows
export async function fetchAllGrids(tabs) {
  if (!tabs.length) return new Map();
  const ranges = tabs.map(t => 'ranges=' + encodeURIComponent(quote(t.title))).join('&');
  const d = await gfetch(`${API}${sid()}?includeGridData=true&${ranges}&fields=${encodeURIComponent(`sheets(properties(sheetId),${GRID_FIELDS})`)}`);
  return new Map((d.sheets || []).map(s => [s.properties.sheetId, toRows(s.data?.[0]?.rowData)]));
}

// List or table, as the person last chose for this tab, else by width
export const isListTab = (tab, rows) => (store.get('hydra.sheets.mode.' + tab.sheetId) || (usedCols(rows || []) <= 3 ? 'list' : 'table')) === 'list';

const batch = requests => gfetch(`${API}${sid()}:batchUpdate`, { method: 'POST', body: { requests } });
const textCell = s => ({ userEnteredValue: { stringValue: s }, userEnteredFormat: { backgroundColor: WHITE, textFormat: { bold: false } } });

// Re-read one cell before writing, so we never overwrite a row that someone else has just moved
async function cellNow(tab, r, c) {
  const d = await gfetch(`${API}${sid()}/values/${encodeURIComponent(a1(tab, r, c))}`);
  return (d.values?.[0]?.[0] ?? '').trim();
}

// Runs work() only if cell (r, c) still holds `expected`. Returns false (and says so) if it changed.
export async function guardedWrite(tab, r, c, expected, work) {
  try {
    if ((await cellNow(tab, r, c)) !== (expected || '').trim()) {
      toast('Someone just changed this sheet — refreshed, please try again', 'error');
      return false;
    }
    await work();
    return true;
  } catch (e) {
    toast(errMsg(e), 'error');
    return false;
  }
}

// Paint a task row green (done) or back to white, across the tab's used columns
export const setDone = (tab, t, used, done) => batch([{
  repeatCell: {
    range: { sheetId: tab.sheetId, startRowIndex: t.row, endRowIndex: t.row + 1, startColumnIndex: 0, endColumnIndex: used },
    cell: { userEnteredFormat: { backgroundColor: done ? GREEN : WHITE } },
    fields: 'userEnteredFormat.backgroundColor',
  },
}]);

// Insert a task as a new row under the last task of section s (guarded on that anchor row)
export function insertTask(tab, s, used, text, who) {
  const last = s.tasks[s.tasks.length - 1];
  const anchorRow = last ? last.row : s.row;
  const at = anchorRow + 1;
  const work = () => batch([
    { insertDimension: { range: { sheetId: tab.sheetId, dimension: 'ROWS', startIndex: at, endIndex: at + 1 }, inheritFromBefore: at > 0 } },
    { updateCells: {
      range: { sheetId: tab.sheetId, startRowIndex: at, endRowIndex: at + 1, startColumnIndex: 0, endColumnIndex: used },
      rows: [{ values: [textCell(text), textCell(who), ...Array(used - 2).fill(0).map(() => textCell(''))] }],
      fields: 'userEnteredValue,userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold',
    } },
  ]);
  if (anchorRow < 0) return work().then(() => true, e => { toast(errMsg(e), 'error'); return false; });
  return guardedWrite(tab, anchorRow, 0, last ? last.text : s.title, work);
}

export function renderSheets(root, ctx) {
  if (!sid()) {
    root.append(h('p', { class: 'error' }, 'No spreadsheet set — add spreadsheetId to config.js.'));
    return;
  }
  const tabsEl = h('div', { class: 'sheet-tabs', role: 'tablist' });
  const tools = h('div', { class: 'toolbar wrap' });
  const body = h('div', { class: 'sheet-view' }, spinner());
  const status = h('div', { class: 'sync muted small' });
  root.append(tabsEl, tools, body, status);

  let tabs = [];
  let active = null;
  let rows = null;
  let lastSig = '';
  let pending = false;
  let busy = false;

  const prefs = () => store.get('hydra.sheets.prefs', { hideDone: false, mine: false });
  const setPref = (k, v) => { store.set('hydra.sheets.prefs', { ...prefs(), [k]: v }); render(); };
  const modeFor = tab => (isListTab(tab, rows) ? 'list' : 'table');
  const initials = myInitials;

  async function refresh(force) {
    if (busy && !force) return;
    busy = true;
    try {
      tabs = await fetchTabs();
      const want = active?.sheetId ?? store.get('hydra.sheets.active');
      active = tabs.find(t => t.sheetId === want) || tabs[0] || null;
      renderTabs();
      if (!active) { body.replaceChildren(h('p', {}, 'This spreadsheet has no visible tabs.')); return; }
      const tab = active;
      const fresh = await fetchGrid(tab);
      if (!ctx.alive || tab.sheetId !== active?.sheetId) return;
      status.textContent = `Live · updated ${hm(new Date())}`;
      const sig = tab.sheetId + JSON.stringify(fresh);
      rows = fresh;
      if (sig === lastSig && !force) return;
      lastSig = sig;
      if (isModalOpen()) { pending = true; return; }
      render();
    } catch (e) {
      if (!rows) body.replaceChildren(h('p', { class: 'error' }, errMsg(e)));
      else status.textContent = 'Offline? ' + errMsg(e);
    } finally {
      busy = false;
    }
  }

  // Shared "after a dialog closes" hook so live updates that arrived meanwhile get drawn
  const dialog = (title, content) => modal(title, content, { onClose: () => { if (pending) { pending = false; render(); } } });

  function renderTabs() {
    tabsEl.replaceChildren(...tabs.map(t => h('button', {
      class: 'sheet-tab' + (t === active ? ' active' : ''), role: 'tab',
      onclick: () => { if (t === active) return; active = t; rows = null; lastSig = ''; store.set('hydra.sheets.active', t.sheetId); renderTabs(); body.replaceChildren(spinner()); tools.replaceChildren(); refresh(true); },
    }, t.title)));
    tabsEl.querySelector('.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  function render() {
    if (!rows || !active) return;
    const mode = modeFor(active);
    const p = prefs();
    fill(tools,
      h('div', { class: 'seg' },
        h('button', { class: mode === 'list' ? 'on' : '', onclick: () => { store.set('hydra.sheets.mode.' + active.sheetId, 'list'); render(); } }, 'List'),
        h('button', { class: mode === 'table' ? 'on' : '', onclick: () => { store.set('hydra.sheets.mode.' + active.sheetId, 'table'); render(); } }, 'Table')),
      mode === 'list' && initials() ? h('button', { class: 'chip' + (p.mine ? '' : ' off'), onclick: () => setPref('mine', !p.mine) }, `Mine (${initials()})`) : null,
      mode === 'list' ? h('button', { class: 'chip' + (p.hideDone ? '' : ' off'), onclick: () => setPref('hideDone', !p.hideDone) }, 'Hide Done') : null);
    ctx.actions(
      h('button', { class: 'nav-icon', 'aria-label': 'Refresh now', onclick: () => refresh(true) }, icon('refresh')),
      h('a', { class: 'nav-icon', href: `https://docs.google.com/spreadsheets/d/${sid()}/edit#gid=${active.sheetId}`, target: '_blank', rel: 'noopener', 'aria-label': 'Open in Google Sheets' }, icon('external')));
    if (mode === 'list') renderList(p); else renderTable();
  }

  // ---------- list mode ----------
  function renderList(p) {
    const { used, sections } = parseList(rows);
    const me = initials();
    const show = t => (!p.hideDone || !t.done) && (!p.mine || !me || whoList(t.who).some(w => w === me || w === 'ALL'));
    body.replaceChildren(
      ...sections.map(s => {
        const tasks = s.tasks.filter(show);
        const open = s.tasks.filter(t => !t.done).length;
        return h('section', { class: 'task-section' },
          s.title ? h('h3', {}, s.title, h('span', { class: 'count' }, open ? `${open} open` : s.tasks.length ? 'all done' : 'no tasks')) : null,
          tasks.map(t => taskRow(t, used)),
          h('button', { class: 'add-task', onclick: () => addTask(s, used) }, icon('plus', 'add-plus'), 'Add task'));
      }),
      h('button', { class: 'btn block', onclick: addSection }, icon('plus'), 'New section'));
  }

  function taskRow(t, used) {
    return h('div', { class: 'task' + (t.done ? ' done' : '') },
      h('button', { class: 'tick', 'aria-label': t.done ? 'Mark not done' : 'Mark done', onclick: () => toggleDone(t, used) }, t.done ? '✓' : ''),
      h('button', { class: 'task-text', onclick: () => editTask(t, used) },
        h('span', {}, t.text || h('i', { class: 'muted' }, '(blank)')),
        t.extra.length ? h('small', { class: 'muted' }, t.extra.join(' · ')) : null),
      h('span', { class: 'who' }, whoList(t.who).map(w => h('span', { class: 'initials' }, w))));
  }

  async function guarded(r, c, expected, work) {
    await guardedWrite(active, r, c, expected, work);
    await refresh(true);
  }

  function toggleDone(t, used) {
    return guarded(t.row, 0, t.text, () => setDone(active, t, used, !t.done));
  }

  function taskForm({ text = '', who = '', submit, extraButtons = [] }) {
    const ta = h('textarea', { rows: 3, required: true }, text);
    const wi = h('input', { type: 'text', value: who, placeholder: 'e.g. TS or SP/TS or ALL', autocapitalize: 'characters' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Save');
    const form = h('form', { class: 'form', onsubmit: async e => {
      e.preventDefault();
      if (!ta.value.trim()) return;
      btn.disabled = true;
      await submit(ta.value.trim(), wi.value.trim().toUpperCase());
    } }, field('Task', ta), field('Who', wi), btn, h('div', { class: 'actions' }, extraButtons));
    setTimeout(() => ta.focus(), 50);
    return form;
  }

  function editTask(t, used) {
    const m = dialog('Edit task', taskForm({
      text: t.text, who: t.who,
      submit: async (text, who) => { m.close(); await guarded(t.row, 0, t.text, () => gfetch(`${API}${sid()}/values/${encodeURIComponent(a1(active, t.row, 0, 1))}?valueInputOption=RAW`, { method: 'PUT', body: { values: [[text, who]] } })); },
      extraButtons: [
        h('button', { class: 'btn', type: 'button', onclick: () => { m.close(); toggleDone(t, used); } }, t.done ? 'Mark not done' : 'Mark done'),
        h('button', { class: 'btn danger', type: 'button', onclick: () => {
          if (!confirm('Delete this row from the sheet?')) return;
          m.close();
          guarded(t.row, 0, t.text, () => batch([{ deleteDimension: { range: { sheetId: active.sheetId, dimension: 'ROWS', startIndex: t.row, endIndex: t.row + 1 } } }]));
        } }, 'Delete row'),
      ],
    }));
  }

  function addTask(s, used) {
    const m = dialog(s.title ? `Add task · ${s.title}` : 'Add task', taskForm({
      who: initials(),
      submit: async (text, who) => { m.close(); await insertTask(active, s, used, text, who); await refresh(true); },
    }));
  }

  function addSection() {
    const name = h('input', { type: 'text', required: true, placeholder: 'e.g. Dior Party Dublin' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Add section');
    const m = dialog('New section', h('form', { class: 'form', onsubmit: async e => {
      e.preventDefault();
      if (!name.value.trim()) return;
      btn.disabled = true;
      const at = rows.length + 1; // leave one blank row, like the sheet does
      const rowCount = active.gridProperties?.rowCount || 1000;
      const reqs = [];
      if (at + 1 > rowCount) reqs.push({ appendDimension: { sheetId: active.sheetId, dimension: 'ROWS', length: at + 1 - rowCount + 20 } });
      reqs.push({ updateCells: {
        range: { sheetId: active.sheetId, startRowIndex: at, endRowIndex: at + 1, startColumnIndex: 0, endColumnIndex: 1 },
        rows: [{ values: [{ userEnteredValue: { stringValue: name.value.trim() }, userEnteredFormat: { textFormat: { bold: true }, horizontalAlignment: 'CENTER', backgroundColor: WHITE } }] }],
        fields: 'userEnteredValue,userEnteredFormat(textFormat.bold,horizontalAlignment,backgroundColor)',
      } });
      try { await batch(reqs); m.close(); } catch (err) { toast(errMsg(err), 'error'); btn.disabled = false; }
      await refresh(true);
    } }, field('Section name', name), btn));
    setTimeout(() => name.focus(), 50);
  }

  // ---------- table mode ----------
  function renderTable() {
    const used = Math.max(usedCols(rows), 1);
    const table = h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', { class: 'rn' }, ''), Array.from({ length: used }, (_, c) => h('th', { class: 'cl' }, colLetter(c))))),
      h('tbody', {}, rows.map((r, i) => h('tr', {},
        h('th', { class: 'rn' }, i + 1),
        Array.from({ length: used }, (_, c) => {
          const cell = r[c] || { v: '' };
          return h('td', {
            class: (cell.bold ? 'b ' : '') + (isDark(cell.bg) ? 'dark' : ''),
            style: { background: bgCss(cell.bg) },
            onclick: () => editCell(i, c, cell),
          }, cell.link ? h('a', { href: cell.link, target: '_blank', rel: 'noopener', onclick: e => e.stopPropagation() }, cell.v || cell.link) : cell.v);
        })))));
    body.replaceChildren(h('div', { class: 'grid-wrap' }, table), h('button', { class: 'btn block', onclick: () => addRow(used) }, '+ Add row'));
  }

  function editCell(r, c, cell) {
    const ta = h('textarea', { rows: 4 }, cell.v);
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Save');
    const m = dialog(`${active.title} · ${colLetter(c)}${r + 1}`, h('form', { class: 'form', onsubmit: async e => {
      e.preventDefault();
      btn.disabled = true;
      m.close();
      await guarded(r, c, cell.v, () => gfetch(`${API}${sid()}/values/${encodeURIComponent(a1(active, r, c))}?valueInputOption=USER_ENTERED`, { method: 'PUT', body: { values: [[ta.value]] } }));
    } }, ta, h('small', { class: 'hint' }, 'Numbers, dates and formulas work like typing in Google Sheets.'), btn));
    setTimeout(() => ta.focus(), 50);
  }

  function addRow(used) {
    const headers = rows[0] || [];
    const inputs = Array.from({ length: used }, (_, c) => h('input', { type: 'text' }));
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Add row');
    const m = dialog(`Add row · ${active.title}`, h('form', { class: 'form', onsubmit: async e => {
      e.preventDefault();
      btn.disabled = true;
      try {
        await gfetch(`${API}${sid()}/values/${encodeURIComponent(quote(active.title) + '!A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
          { method: 'POST', body: { values: [inputs.map(i => i.value)] } });
        m.close();
      } catch (err) { toast(errMsg(err), 'error'); btn.disabled = false; }
      await refresh(true);
    } }, inputs.map((inp, c) => field(headers[c]?.v || `Column ${colLetter(c)}`, inp)), btn));
  }

  refresh(true);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible' && tokenValid(5 * 60_000)) refresh();
  }, Math.max(10, CONFIG.sheetRefreshSeconds) * 1000);
  const onVis = () => { if (document.visibilityState === 'visible' && tokenValid(5 * 60_000)) refresh(); };
  document.addEventListener('visibilitychange', onVis);
  ctx.onLeave(() => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); });
}
