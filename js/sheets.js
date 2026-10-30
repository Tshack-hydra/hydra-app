// Sheets: live view of every tab in the Hydra spreadsheet. Nothing about the tabs is hard-coded —
// the tab list and contents are re-read every few seconds, so new tabs/rows/columns just appear.
//
// Every tab shows as a task list:
//   bold row with only column A filled = section heading (e.g. "Alo Shanghai")
//   column A = task, column B = who (initials, "SP/TS", "ALL")
//   green fill = done (ticking a task paints the row green, like the team does by hand)
//   optional header row ("Task | Who | Done"): Done holds tick boxes and the sheet's own conditional
//   formatting paints ticked rows green (ticked or green both count as done). Columns right of the
//   header are ignored. Rows deleted or cleared in the sheet simply disappear from the app.
// Any extra columns show as small text under the task.

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

export function usedCols(rows) {
  let n = 0;
  for (const r of rows) for (let c = r.length - 1; c >= n; c--) if (r[c]?.v) { n = c + 1; break; }
  return n;
}

const HEADER_WORDS = /^(tasks?|who|done)$/i;
const text = c => (c?.v || '').trim();

// With a header row ("Task | Who | Done") the table is the columns up to the first blank header cell;
// anything to the right (like the instructions in column E) is ignored. Done is a tick box.
export function tableShape(rows) {
  const first = rows.findIndex(r => r.some(text));
  const header = first >= 0 && rows[first].some(c => HEADER_WORDS.test(text(c))) ? first : -1;
  if (header < 0) return { header, used: Math.max(usedCols(rows), 2), doneCol: -1 };
  const names = rows[header].map(c => text(c).toLowerCase());
  let width = names.findIndex(n => !n);
  if (width < 0) width = names.length;
  return { header, used: Math.max(width, 2), doneCol: names.indexOf('done') };
}

// Group rows into sections of tasks (see header comment). lastRow = last row with any content.
export function parseList(rows) {
  const { header, used, doneCol } = tableShape(rows);
  // Tick boxes read "TRUE"/"FALSE" on every row, so the Done column never counts as content
  const val = (r, c) => (c === doneCol ? '' : text(r[c]));
  const sections = [];
  let cur = { title: '', row: -1, doneCol, tasks: [] };
  sections.push(cur);
  let lastRow = header;
  rows.forEach((r, i) => {
    if (i === header) return;
    const a = val(r, 0);
    const rest = [];
    for (let c = 1; c < used; c++) if (c !== doneCol) rest.push(val(r, c));
    if (!a && !rest.some(Boolean)) return;
    lastRow = i;
    if (!a) return; // initials but no task text: nothing to show
    if (a && r[0]?.bold && !rest.some(Boolean)) {
      cur = { title: a, row: i, doneCol, tasks: [] };
      sections.push(cur);
      return;
    }
    const ticked = doneCol >= 0 && r[doneCol]?.v === 'TRUE';
    cur.tasks.push({ row: i, text: a, who: rest[0] || '', extra: rest.slice(1).filter(Boolean), doneCol, done: ticked || isGreen(r[0]?.bg) || isGreen(r[1]?.bg) });
  });
  return { used, doneCol, lastRow, sections: sections.filter(s => s.title || s.tasks.length) };
}

// An initials tag coloured like that person's chip in the sheet (CONFIG.teamColours)
export const initialsTag = w => h('span', { class: 'initials tag-' + (CONFIG.teamColours?.[w] || 'gray') }, w);

// "ALL" means everyone, so it never sits alongside individual initials
export const whoList = who => {
  const list = who.toUpperCase().split(/[\/,&+\s]+/).filter(Boolean);
  return list.includes('ALL') ? ['ALL'] : list;
};
// Same format as the sheet's multi-select Who dropdown ("TS, MR"), so typed initials become chips there
export const formatWho = who => whoList(who).join(', ');

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

const GRID_FIELDS = 'data(rowData(values(formattedValue,hyperlink,effectiveFormat(backgroundColor,textFormat(bold,fontFamily)))))';
function toRows(rowData) {
  const rows = (rowData || []).map(r => (r.values || []).map(c => ({
    v: c.formattedValue ?? '',
    link: c.hyperlink || null,
    bg: c.effectiveFormat?.backgroundColor || null,
    bold: !!c.effectiveFormat?.textFormat?.bold,
    font: c.effectiveFormat?.textFormat?.fontFamily || null,
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

// Tabs that look like a to-do list (a Task header, or ≤ 3 columns) — the Tasks section gathers these
export const isListTab = (tab, rows) => tableShape(rows || []).header >= 0 || usedCols(rows || []) <= 3;

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

// Mark a task done or not. With a Done column: set the tick box (the sheet paints the row green itself)
// and, when un-ticking, clear any green painted by hand. Without one: paint the row green or white.
const cellRange = (tab, r, c) => ({ sheetId: tab.sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: c, endColumnIndex: c + 1 });
const paintRow = (tab, row, used, bg) => ({ repeatCell: {
  range: { sheetId: tab.sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: used },
  cell: { userEnteredFormat: { backgroundColor: bg } },
  fields: 'userEnteredFormat.backgroundColor',
} });
const tickReqs = (tab, row, col, on) => [
  { setDataValidation: { range: cellRange(tab, row, col), rule: { condition: { type: 'BOOLEAN' } } } },
  { updateCells: { range: cellRange(tab, row, col), rows: [{ values: [{ userEnteredValue: { boolValue: on } }] }], fields: 'userEnteredValue' } },
];
export const setDone = (tab, t, used, done) => batch(t.doneCol >= 0
  ? [...tickReqs(tab, t.row, t.doneCol, done), ...(done ? [] : [paintRow(tab, t.row, used, WHITE)])]
  : [paintRow(tab, t.row, used, done ? GREEN : WHITE)]);

// A section heading row: bold name in A, the rest of the row empty with no tick box or dropdown.
// Font copied from an existing heading so it matches the sheet.
export const headingFont = (rows, sections) => {
  const s = sections.find(x => x.row >= 0);
  return s ? rows[s.row][0]?.font || null : null;
};
const headingReqs = (tab, row, used, name, font) => [
  { setDataValidation: { range: { sheetId: tab.sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: used } } },
  { updateCells: {
    range: { sheetId: tab.sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: used },
    rows: [{ values: Array.from({ length: used }, (_, c) => ({
      userEnteredValue: c === 0 ? { stringValue: name } : {},
      userEnteredFormat: { backgroundColor: WHITE, horizontalAlignment: c === 0 ? 'LEFT' : 'CENTER', textFormat: { bold: c === 0, ...(font ? { fontFamily: font } : {}) } },
    })) }],
    fields: 'userEnteredValue,userEnteredFormat.backgroundColor,userEnteredFormat.horizontalAlignment,userEnteredFormat.textFormat.bold' + (font ? ',userEnteredFormat.textFormat.fontFamily' : ''),
  } },
];

// Insert a task as a new row under the last task of section s (guarded on that anchor row)
export function insertTask(tab, s, used, text, who) {
  const last = s.tasks[s.tasks.length - 1];
  const anchorRow = last ? last.row : s.row;
  const at = anchorRow + 1;
  const work = () => batch([
    // copy the row setup (Who drop-down, tick box) from the task above, or for an empty section from the row below
    { insertDimension: { range: { sheetId: tab.sheetId, dimension: 'ROWS', startIndex: at, endIndex: at + 1 }, inheritFromBefore: !!last } },
    { updateCells: {
      range: { sheetId: tab.sheetId, startRowIndex: at, endRowIndex: at + 1, startColumnIndex: 0, endColumnIndex: used },
      rows: [{ values: Array.from({ length: used }, (_, c) => textCell(c === 0 ? text : c === 1 ? who : '')) }],
      fields: 'userEnteredValue,userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold',
    } },
    ...(s.doneCol >= 0 ? tickReqs(tab, at, s.doneCol, false) : []),
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
  let sheetInfo = { lastRow: -1, doneCol: -1, used: 2, font: null }; // from the last list render, for New section

  const prefs = () => store.get('hydra.sheets.prefs', { hideDone: false, mine: false });
  const setPref = (k, v) => { store.set('hydra.sheets.prefs', { ...prefs(), [k]: v }); render(); };
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
    const p = prefs();
    fill(tools,
      initials() ? h('button', { class: 'chip' + (p.mine ? '' : ' off'), onclick: () => setPref('mine', !p.mine) }, `Mine (${initials()})`) : null,
      h('button', { class: 'chip end' + (p.hideDone ? '' : ' off'), 'aria-pressed': String(p.hideDone), onclick: () => setPref('hideDone', !p.hideDone) }, p.hideDone ? 'Show Done' : 'Hide Done'));
    ctx.actions(
      h('a', { class: 'nav-icon', href: `https://docs.google.com/spreadsheets/d/${sid()}/edit#gid=${active.sheetId}`, target: '_blank', rel: 'noopener', 'aria-label': 'Open in Google Sheets' }, icon('external')));
    renderList(p);
  }

  // ---------- list mode ----------
  function renderList(p) {
    const { used, sections, lastRow, doneCol } = parseList(rows);
    sheetInfo = { lastRow, doneCol, used, font: headingFont(rows, sections) };
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
      h('span', { class: 'who' }, whoList(t.who).map(initialsTag)));
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
    const wi = h('input', { type: 'text', value: who, placeholder: 'e.g. TS, or TS MR, or ALL', autocapitalize: 'characters' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Save');
    const form = h('form', { class: 'form', onsubmit: async e => {
      e.preventDefault();
      if (!ta.value.trim()) return;
      btn.disabled = true;
      await submit(ta.value.trim(), formatWho(wi.value));
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
      const at = sheetInfo.lastRow + 2; // leave one blank row, like the sheet does
      const rowCount = active.gridProperties?.rowCount || 1000;
      const reqs = [];
      if (at + 1 > rowCount) reqs.push({ appendDimension: { sheetId: active.sheetId, dimension: 'ROWS', length: at + 1 - rowCount + 20 } });
      reqs.push(...headingReqs(active, at, Math.max(sheetInfo.used, 2), name.value.trim(), sheetInfo.font));
      try { await batch(reqs); m.close(); } catch (err) { toast(errMsg(err), 'error'); btn.disabled = false; }
      await refresh(true);
    } }, field('Section name', name), btn));
    setTimeout(() => name.focus(), 50);
  }

  ctx.onRefresh(() => refresh(true));
  refresh(true);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible' && tokenValid(5 * 60_000)) refresh();
  }, Math.max(10, CONFIG.sheetRefreshSeconds) * 1000);
  const onVis = () => { if (document.visibilityState === 'visible' && tokenValid(5 * 60_000)) refresh(); };
  document.addEventListener('visibilitychange', onVis);
  ctx.onLeave(() => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); });
}
