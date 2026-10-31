// Freelancers: the list of freelancers Hydra books, kept in a "Freelancers" tab of the Hydra spreadsheet
// (one row each: Name | Email | Phone | Specialisms). Specialisms are tags ("Lighting, Audio") that say what
// each person can do. The Sheets section shows that tab with this screen instead of the task list, and
// Project Crewing picks people from it.

import { CONFIG } from '../config.js';
import { gfetch } from './google.js';
import { icon } from './icons.js';
import { guardedWrite, fetchAllGrids } from './sheets.js';
import { h, fill, field, toast, errMsg } from './util.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const TAB_TITLE = 'FREELANCERS';
const COLOURS = ['blue', 'green', 'orange', 'purple', 'teal', 'red', 'yellow'];

const sid = () => CONFIG.spreadsheetId;
const text = c => (c?.v || '').trim();
const batch = requests => gfetch(`${API}${sid()}:batchUpdate`, { method: 'POST', body: { requests } });
const sv = s => (s ? { stringValue: s } : {});

export const isFreelancersTab = tab => /^freelancers?$/i.test(tab.title.trim());
export const parseTags = s => [...new Set((s || '').split(/[,;/]+/).map(t => t.trim()).filter(Boolean))];
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

// Hydra's own people are the ones with a company email (@hydradesign.co.uk). They are listed with the freelancers so they can be
// booked onto jobs too, and show in purple everywhere to tell them apart.
const isEmployeeEmail = email => !!CONFIG.workspaceDomain && email.toLowerCase().endsWith('@' + CONFIG.workspaceDomain.toLowerCase());
// One purple bubble for Hydra's own people: "Hydra - Project Manager". Freelancers get a bubble per specialism.
export const hydraLabel = f => 'Hydra' + (f.tags.length ? ' - ' + f.tags.join(', ') : '');
export const personChips = f => f.employee ? [h('span', { class: 'initials tag-purple' }, hydraLabel(f))] : f.tags.map(tagChip);

// Rows → [{ row, name, email, phone, tags, employee }]: Hydra team first (sheet order), then freelancers by name
// (row = index in the sheet, for editing)
export function parseFreelancers(rows) {
  const out = [];
  rows.forEach((r, i) => {
    const name = text(r[0]);
    if (!name || (i === 0 && /^name$/i.test(name))) return;
    const email = text(r[1]);
    out.push({ row: i, name, email, phone: text(r[2]), tags: parseTags(r[3]?.v), employee: isEmployeeEmail(email) });
  });
  const team = out.filter(f => f.employee), rest = out.filter(f => !f.employee).sort(byName);
  return [...team, ...rest];
}

export async function loadFreelancers(tabs) {
  const tab = tabs.find(isFreelancersTab);
  if (!tab) return { tab: null, list: [] };
  const grids = await fetchAllGrids([tab]);
  return { tab, list: parseFreelancers(grids.get(tab.sheetId) || []) };
}

// A specialism tag, coloured the same everywhere
export const tagColour = t => COLOURS[[...t.toLowerCase()].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % COLOURS.length];
export const tagChip = t => h('span', { class: 'initials tag-' + tagColour(t) }, t);
export const specialismOptions = (list = []) => [...new Set([...(CONFIG.specialisms || []), ...list.filter(f => !f.employee).flatMap(f => f.tags)])]; // employees' job titles aren't skills

// ---------- the Freelancers tab ----------

const SEED = [
  ['Lighting'], ['Audio'], ['Video'], ['General Tech'], ['Lighting', 'Audio'],
  ['Video', 'General Tech'], ['Audio', 'General Tech'], ['Lighting', 'Video'], ['Lighting', 'Audio', 'Video'], ['General Tech'],
];

// New Freelancers tab with the header row and ten made-up freelancers (Test Dummy 1–10) to try things out
export async function addFreelancersTab() {
  const d = await batch([{ addSheet: { properties: { title: TAB_TITLE, gridProperties: { rowCount: 300, columnCount: 4, frozenRowCount: 1 } } } }]);
  const tab = d.replies[0].addSheet.properties;
  const rows = [
    ['Name', 'Email', 'Phone', 'Specialisms'],
    ...SEED.map((tags, i) => [`Test Dummy ${i + 1}`, `testdummy${i + 1}@example.com`, `07700 900${String(i + 1).padStart(3, '0')}`, tags.join(', ')]),
  ];
  const widths = [200, 250, 150, 260];
  await batch([
    ...widths.map((pixelSize, i) => ({ updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize }, fields: 'pixelSize' } })),
    { updateCells: {
      range: { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: rows.length, startColumnIndex: 0, endColumnIndex: 4 },
      rows: rows.map((r, ri) => ({ values: r.map(s => ({ userEnteredValue: sv(s), ...(ri === 0 ? { userEnteredFormat: { textFormat: { bold: true } } } : {}) })) })),
      fields: 'userEnteredValue,userEnteredFormat.textFormat.bold',
    } },
  ]);
  return tab;
}

const rowReq = (tab, row, f) => ({ updateCells: {
  range: { sheetId: tab.sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 4 },
  rows: [{ values: [f.name, f.email, f.phone, f.tags.join(', ')].map(s => ({ userEnteredValue: sv(s) })) }],
  fields: 'userEnteredValue',
} });

// Tag picker: tap the specialisms that apply; type a new one to add it to the list. Returns { el, value() }
function tagPicker(initial, options) {
  let picked = [...initial];
  let opts = [...new Set([...options, ...initial])];
  const box = h('div', { class: 'chips wrap-chips', role: 'group', 'aria-label': 'Specialisms' });
  const el = h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Specialisms'), box);
  const dirty = () => el.dispatchEvent(new Event('input', { bubbles: true }));
  const extra = h('input', { type: 'text', placeholder: 'Add another, e.g. Rigging', enterkeyhint: 'done',
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); add(); } } });
  function add() {
    const t = extra.value.trim();
    if (!t) return;
    const existing = opts.find(o => o.toLowerCase() === t.toLowerCase());
    if (!existing) opts.push(t);
    const tag = existing || t;
    if (!picked.includes(tag)) picked.push(tag);
    extra.value = '';
    draw(); dirty();
  }
  const draw = () => fill(box, opts.map(t => h('button', {
    type: 'button', class: 'chip' + (picked.includes(t) ? '' : ' off'), role: 'checkbox', 'aria-checked': String(picked.includes(t)),
    onclick: () => { picked = picked.includes(t) ? picked.filter(x => x !== t) : [...picked, t]; draw(); dirty(); },
  }, t, picked.includes(t) ? icon('check', 'tick-mark') : null)));
  draw();
  el.append(h('div', { class: 'row2' }, extra, h('button', { type: 'button', class: 'btn', onclick: add }, 'Add')));
  return { el, value: () => { add(); return opts.filter(t => picked.includes(t)); } };
}

// o: { tab, rows, tools, body, ctx, refresh, dialog, sheetLink }
export function renderFreelancers(o) {
  const list = parseFreelancers(o.rows);
  const lastRow = Math.max(-1, ...list.map(f => f.row), o.rows.length ? 0 : -1);
  let q = '';
  let tag = '';

  o.ctx.actions(o.sheetLink, h('button', { class: 'nav-icon tint', 'aria-label': 'New freelancer', onclick: () => form() }, icon('plus')));
  fill(o.tools, h('span', { class: 'muted small' }, `${list.length} freelancer${list.length === 1 ? '' : 's'}`));

  const search = h('input', { type: 'search', placeholder: 'Search name or specialism', 'aria-label': 'Search freelancers', oninput: e => { q = e.target.value.trim().toLowerCase(); draw(); } });
  const tagsEl = h('div', { class: 'chips' });
  const listEl = h('div', {});
  fill(o.body, search, tagsEl, listEl,
    h('button', { class: 'btn block', onclick: () => form() }, icon('plus'), 'New freelancer'));

  function draw() {
    const all = specialismOptions(list);
    fill(tagsEl, all.map(t => h('button', { class: 'chip' + (tag === t ? '' : ' off'), 'aria-pressed': String(tag === t), onclick: () => { tag = tag === t ? '' : t; draw(); } }, t)));
    const shown = list.filter(f => (!tag || f.tags.includes(tag)) && (!q || [f.name, f.email, f.phone, ...f.tags].some(s => s.toLowerCase().includes(q))));
    fill(listEl, shown.length ? h('div', { class: 'group' }, shown.map(f => h('button', { class: 'row', onclick: () => form(f) },
      h('span', { class: 'row-main' },
        h('b', {}, f.name),
        f.email || f.phone ? h('small', {}, [f.email, f.phone].filter(Boolean).join(' · ')) : null,
        f.employee || f.tags.length ? h('span', { class: 'tag-line' }, personChips(f)) : null),
      icon('chevron-right', 'chev'))))
      : h('p', { class: 'muted center-text' }, list.length ? 'Nobody matches.' : 'No freelancers yet. Tap + to add one.'));
  }
  draw();

  async function write(row, expected, work) {
    await guardedWrite(o.tab, row, 0, expected, work);
    await o.refresh();
  }

  function form(f = null) {
    const name = h('input', { type: 'text', required: true, value: f?.name || '', placeholder: 'e.g. Alex Smith' });
    const email = h('input', { type: 'email', value: f?.email || '', placeholder: 'name@example.com', autocapitalize: 'off' });
    const phone = h('input', { type: 'tel', value: f?.phone || '', placeholder: '07… or +44…' });
    const tags = tagPicker(f?.tags || [], specialismOptions(list));
    const btn = h('button', { class: 'btn primary block', type: 'submit', 'data-bar': f ? 'Save' : 'Add' }, f ? 'Save changes' : 'Add freelancer');
    const m = o.dialog(f ? 'Edit freelancer' : 'New freelancer', h('form', { class: 'form', onsubmit: e => {
      e.preventDefault();
      if (!name.value.trim()) return;
      if (list.some(x => x !== f && x.name.toLowerCase() === name.value.trim().toLowerCase())) { toast('There is already a freelancer with that name', 'error'); return; }
      btn.disabled = true;
      const next = { name: name.value.trim(), email: email.value.trim(), phone: phone.value.trim(), tags: tags.value() };
      m.close();
      if (f) write(f.row, f.name, () => batch([rowReq(o.tab, f.row, next)]));
      else {
        const at = lastRow + 1;
        const have = o.tab.gridProperties?.rowCount || 1000;
        const go = () => batch([
          ...(at + 1 > have ? [{ appendDimension: { sheetId: o.tab.sheetId, dimension: 'ROWS', length: at + 1 - have + 50 } }] : []),
          rowReq(o.tab, at, next),
        ]);
        if (lastRow < 0) go().then(() => o.refresh(), err => toast(errMsg(err), 'error'));
        else write(lastRow, text(o.rows[lastRow]?.[0]), go);
      }
    } },
    field('Name', name), field('Email', email), field('Phone', phone), tags.el, btn,
    f ? h('div', { class: 'actions' },
      f.phone ? h('a', { class: 'btn', href: 'tel:' + f.phone.replace(/[^\d+]/g, '') }, 'Call') : null,
      f.email ? h('a', { class: 'btn', href: 'mailto:' + f.email }, 'Email') : null,
      h('button', { class: 'btn danger', type: 'button', onclick: () => {
        if (!confirm(`Delete ${f.name} from the freelancer list? Bookings already made for them stay in Project Crewing.`)) return;
        m.close();
        write(f.row, f.name, () => batch([{ deleteDimension: { range: { sheetId: o.tab.sheetId, dimension: 'ROWS', startIndex: f.row, endIndex: f.row + 1 } } }]));
      } }, 'Delete')) : null,
    f ? h('small', { class: 'hint' }, 'Renaming someone doesn’t change bookings already made under their old name.') : null));
    setTimeout(() => name.focus(), 50);
  }
}
