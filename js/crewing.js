// Project Crewing: who is booked on which project, and when. It is one tab of the Hydra spreadsheet
// ("Project Crewing") laid out like the team's existing crew sheet, shown by the Sheets section instead
// of the task list. Two ways to look at it: Sheet (people × dates grid) or Calendar (month view).
//
// Sheet layout (blocks stacked down the tab, a blank row or more between them):
//   grey bold row   = project: project name in A, one date label per column from B ("14th Oct PREP", "8th & 11th Jan' 2027")
//   rows beneath    = crew: name in A, a filled / green cell under a date = booked (the text is the note, e.g. "0830hrs")
//
// Calendar: the bookings are also mirrored into a Google calendar called "Project Crewing", one all-day
// event per person per day. Its id is kept in the spreadsheet's developer metadata so everyone finds the same
// one. There is no server, so the mirror is updated whenever somebody opens this view and the sheet has changed.
// Event ids are derived from project|person|date, which keeps two people syncing at once from making duplicates.

import { CONFIG } from '../config.js';
import { gfetch } from './google.js';
import { forgetCalendars, getCalendars, calName, isHolidays } from './calendar.js';
import { loadFreelancers, tagChip, tagColour, specialismOptions, addFreelancersTab } from './freelancers.js';
import { icon } from './icons.js';
import { isGreen, guardedWrite } from './sheets.js';
import { h, fill, store, field, toast, errMsg, ymd, parseYmd, addDays, dayLabel } from './util.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const CAL = 'https://www.googleapis.com/calendar/v3';
const TAB_TITLE = 'PROJECT CREWING';
const CAL_NAME = 'Project Crewing';
const META_KEY = 'hydraCrewingCalendar';
const VIEW = 'hydra.crew.view';
const GREEN = { red: 0.204, green: 0.659, blue: 0.325 };
const WHITE = { red: 1, green: 1, blue: 1 };
const GREY = { red: 0.718, green: 0.718, blue: 0.718 };
// One colour per project in the calendar view (all readable with white text)
const PALETTE = ['#3f51b5', '#0b8043', '#c2185b', '#e4630a', '#039be5', '#8e24aa', '#616161', '#d50000'];

const sid = () => CONFIG.spreadsheetId;
const text = c => (c?.v || '').trim();
export const isCrewingTab = tab => /^project\s*crewing$/i.test(tab.title.trim());

// ---------- reading the tab ----------

const isGrey = bg => !!bg && Math.abs(bg.red - bg.green) < 0.04 && Math.abs(bg.green - bg.blue) < 0.04 && bg.red > 0.25 && bg.red < 0.95;
const isHead = c => !!text(c) && (c.bold || isGrey(c.bg));

const MONTH = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Real dates in a free-text column label: "30th Nov", "8th & 11th Jan' 2027", "24th-26th Oct", "30th Nov - 2nd Dec".
// Without a year, the date is the first one on or after `floor` (so "Jan" after "Dec" rolls into next year).
// Returns an array of Dates (empty when the label has no date, like "TBC").
export function parseDates(label, floor) {
  const s = label.replace(/'(\d\d)\b/g, '20$1');
  const year = +(s.match(/\b(20\d\d)\b/)?.[1] || 0);
  const out = [];
  let pend = [];
  let range = false;
  let lead = -1; // month named before its days ("Oct 14, 15")
  const resolve = (day, m) => {
    for (let y = year || floor.getFullYear(); y <= (year || floor.getFullYear() + 2); y++) {
      const d = new Date(y, m, day);
      if (d.getMonth() === m && (year || d >= floor)) return d;
    }
    return null;
  };
  const flush = m => {
    for (const p of pend) {
      const d = resolve(p.n, m);
      if (!d) continue;
      const prev = out[out.length - 1];
      if (p.range && prev && d > prev) for (let x = addDays(prev, 1); x < d; x = addDays(x, 1)) out.push(x);
      out.push(d);
    }
    pend = [];
  };
  for (const t of s.match(/\d+|[a-z]+|[-–—]/gi) || []) {
    if (/^\d+$/.test(t)) {
      const n = +t;
      if (n < 1 || n > 31) continue;
      pend.push({ n, range });
      range = false;
      if (lead >= 0) flush(lead);
    } else if (/^[-–—]$/.test(t)) range = true;
    else if (MONTH.test(t)) {
      const m = MONTHS.indexOf(t.slice(0, 3).toLowerCase());
      if (pend.length) flush(m); else lead = m;
    }
  }
  return out;
}

// Blocks of crew under their project header. Each project: { name, row, cols: [{ col, label, dates }],
// people: [{ row, name, cells: Map(col → note) }], lastRow }. A booked cell is one with text or a green fill.
export function parseCrewing(rows, today = new Date()) {
  const projects = [];
  const start = addDays(new Date(today.getFullYear(), today.getMonth(), today.getDate()), -120);
  let cur = null;
  let lastRow = -1;
  rows.forEach((r, i) => {
    if (!r.some(c => text(c))) return;
    lastRow = i;
    const a = r[0];
    if (isHead(a)) {
      cur = { name: text(a), row: i, cols: [], people: [], lastRow: i };
      let after = start;
      r.forEach((c, ci) => {
        if (ci === 0 || !text(c)) return;
        const dates = parseDates(text(c), after);
        if (dates.length) after = dates[dates.length - 1];
        cur.cols.push({ col: ci, label: text(c), dates });
      });
      projects.push(cur);
      return;
    }
    if (!cur || !text(a)) return;
    const cells = new Map();
    for (const { col } of cur.cols) if (text(r[col]) || isGreen(r[col]?.bg)) cells.set(col, text(r[col]));
    cur.people.push({ row: i, name: text(a), cells });
    cur.lastRow = i;
  });
  return { projects, lastRow };
}

// One entry per person, project and day
export function bookingsOf(projects) {
  const out = new Map();
  for (const p of projects) for (const person of p.people) for (const col of p.cols) {
    if (!person.cells.has(col.col)) continue;
    for (const d of col.dates) {
      const key = [p.name, person.name, ymd(d)].join('|').toLowerCase();
      out.set(key, { key, project: p.name, person: person.name, date: ymd(d), note: person.cells.get(col.col), label: col.label });
    }
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.project.localeCompare(b.project) || a.person.localeCompare(b.person));
}

const firstName = n => n.split(/\s+/)[0];
// "Jamie B" / "Jamie S": first name plus last initial, so two Jamies can be told apart
const shortName = n => { const p = n.split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}` : p[0]; };
// "Jamie S" / "Rob S" just repeat the name; "0830hrs" or "1/2 day" are worth showing
const noteIsName = (note, person) => {
  const n = note.split(/\s+/)[0].toLowerCase();
  return n.length >= 2 && firstName(person).toLowerCase().startsWith(n);
};

// ---------- Google Calendar mirror ----------

const calState = { checked: false, loading: false, id: null, err: '', syncing: false, syncedSig: '', msg: '' };

const calUrl = (id, rest = '') => `${CAL}/calendars/${encodeURIComponent(id)}/events${rest}`;
const hash = (s, seed = 0) => { // cyrb53
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};
// Google event ids may use a–v and 0–9 only (base 32)
const eventId = key => 'crew' + hash(key).toString(32) + hash(key, 7).toString(32);

function eventFor(b) {
  const note = b.note && !noteIsName(b.note, b.person) ? b.note : '';
  return {
    summary: `${b.person} · ${b.project}${note ? ` (${note})` : ''}`,
    description: [`Project: ${b.project}`, `Crew: ${b.person}`, ...(b.note ? [`Booking: ${b.note}`] : []), `Sheet column: ${b.label}`, '',
      'Kept up to date from the Project Crewing tab of the Hydra spreadsheet. Change bookings there or in the app.'].join('\n'),
    start: { date: b.date },
    end: { date: ymd(addDays(parseYmd(b.date), 1)) },
    extendedProperties: { private: { hydraCrew: '1' } },
  };
}

async function metaCalendarId() {
  const d = await gfetch(`${API}${sid()}/developerMetadata:search`, { method: 'POST', body: { dataFilters: [{ developerMetadataLookup: { metadataKey: META_KEY, locationType: 'SPREADSHEET' } }] } });
  return d?.matchedDeveloperMetadata?.[0]?.developerMetadata?.metadataValue || null;
}
const saveCalendarId = id => batch([{ createDeveloperMetadata: { developerMetadata: { metadataKey: META_KEY, metadataValue: id, location: { spreadsheet: true }, visibility: 'DOCUMENT' } } }]);

// Make sure the Project Crewing calendar is in this person's calendar list (it's shared with the whole domain)
async function subscribe(id) {
  try { await gfetch(`${CAL}/users/me/calendarList`, { method: 'POST', body: { id } }); forgetCalendars(); } catch { /* already in the list */ }
}

async function findCalendar() {
  const id = await metaCalendarId();
  if (id) { await subscribe(id); return id; }
  // Someone may already have made one by hand: use it rather than creating a second
  const list = await gfetch(`${CAL}/users/me/calendarList?minAccessRole=owner&maxResults=250`);
  const mine = (list.items || []).find(c => (c.summaryOverride || c.summary) === CAL_NAME);
  if (mine) { await saveCalendarId(mine.id); return mine.id; }
  return null;
}

async function createCalendar() {
  const existing = await metaCalendarId(); // someone else may have just made it
  if (existing) { await subscribe(existing); return { id: existing, shared: true }; }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cal = await gfetch(`${CAL}/calendars`, { method: 'POST', body: { summary: CAL_NAME, description: 'Who is booked on which project and when. Kept up to date from the Project Crewing tab of the Hydra spreadsheet.', timeZone: tz } });
  // Everyone in the studio can see it and the app can keep it up to date from any phone
  let shared = true;
  if (CONFIG.workspaceDomain) {
    try { await gfetch(`${CAL}/calendars/${encodeURIComponent(cal.id)}/acl?sendNotifications=false`, { method: 'POST', body: { role: 'writer', scope: { type: 'domain', value: CONFIG.workspaceDomain } } }); } catch { shared = false; }
  }
  await saveCalendarId(cal.id);
  forgetCalendars();
  return { id: cal.id, shared };
}

async function pool(jobs, n = 5) {
  const queue = [...jobs];
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) await queue.shift()(); }));
}

// Make the calendar match the sheet: add what's missing, fix what changed, remove what's gone
async function pushEvents(calId, bookings) {
  const existing = new Map();
  let page = '';
  do {
    const d = await gfetch(calUrl(calId, `?privateExtendedProperty=${encodeURIComponent('hydraCrew=1')}&maxResults=2500&singleEvents=true${page ? '&pageToken=' + page : ''}`));
    for (const e of d.items || []) existing.set(e.id, e);
    page = d.nextPageToken || '';
  } while (page);
  const want = new Map(bookings.map(b => [eventId(b.key), eventFor(b)]));
  const jobs = [];
  for (const [id, body] of want) {
    const ex = existing.get(id);
    if (!ex) {
      jobs.push(() => gfetch(calUrl(calId), { method: 'POST', body: { id, ...body } })
        // a removed booking leaves a cancelled event behind under the same id: bring it back
        .catch(() => gfetch(calUrl(calId, '/' + id), { method: 'PATCH', body: { ...body, status: 'confirmed' } })));
    } else if (ex.summary !== body.summary || (ex.description || '') !== body.description || ex.start?.date !== body.start.date) {
      jobs.push(() => gfetch(calUrl(calId, '/' + id), { method: 'PATCH', body }));
    }
  }
  for (const id of existing.keys()) if (!want.has(id)) jobs.push(() => gfetch(calUrl(calId, '/' + id), { method: 'DELETE' }).catch(() => {}));
  await pool(jobs);
  return jobs.length;
}

function setStatus(msg) {
  calState.msg = msg;
  const el = document.querySelector('.crew-status');
  if (el) el.textContent = msg;
}

async function syncCalendar(bookings) {
  if (!calState.id || calState.syncing) return;
  const sig = JSON.stringify(bookings.map(b => [b.key, b.person, b.project, b.note]));
  if (sig === calState.syncedSig) return;
  calState.syncing = true;
  setStatus('Updating Google Calendar…');
  try {
    await pushEvents(calState.id, bookings);
    calState.syncedSig = sig;
    setStatus(`Google Calendar is up to date · ${bookings.length} booking${bookings.length === 1 ? '' : 's'}`);
  } catch (e) {
    setStatus('Couldn’t update Google Calendar: ' + errMsg(e));
  } finally {
    calState.syncing = false;
  }
}

// ---------- writing the tab ----------

const batch = requests => gfetch(`${API}${sid()}:batchUpdate`, { method: 'POST', body: { requests } });
const rng = (tab, r, c1, c2 = c1 + 1, r2 = r + 1) => ({ sheetId: tab.sheetId, startRowIndex: r, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 });
const val = s => (s === '' ? {} : { stringValue: s });
const FMT_FIELDS = 'userEnteredValue,userEnteredFormat.backgroundColor,userEnteredFormat.horizontalAlignment,userEnteredFormat.textFormat.bold';
const fmt = (bg, bold, align) => ({ backgroundColor: bg, horizontalAlignment: align, textFormat: { bold } });

// Grey bold header row: project name then date labels
const headReq = (tab, row, labels) => ({ updateCells: {
  range: rng(tab, row, 0, labels.length),
  rows: [{ values: labels.map(l => ({ userEnteredValue: val(l), userEnteredFormat: fmt(GREY, true, 'CENTER') })) }],
  fields: FMT_FIELDS,
} });
// A crew row: name in A, everything else empty and white
const personReq = (tab, row, name, width) => ({ updateCells: {
  range: rng(tab, row, 0, width),
  rows: [{ values: Array.from({ length: width }, (_, c) => ({ userEnteredValue: val(c === 0 ? name : ''), userEnteredFormat: fmt(WHITE, false, c === 0 ? 'LEFT' : 'CENTER') })) }],
  fields: FMT_FIELDS,
} });
const growRows = (tab, need) => {
  const have = tab.gridProperties?.rowCount || 1000;
  return need > have ? [{ appendDimension: { sheetId: tab.sheetId, dimension: 'ROWS', length: need - have + 20 } }] : [];
};

// A new, empty PROJECT CREWING tab in the spreadsheet, set up like the team's crew sheet (wide name column, frozen)
export async function addCrewingTab() {
  const d = await batch([{ addSheet: { properties: { title: TAB_TITLE, gridProperties: { rowCount: 200, columnCount: 12, frozenColumnCount: 1 } } } }]);
  const tab = d.replies[0].addSheet.properties;
  await batch([
    { updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 230 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 12 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } },
  ]);
  return tab;
}

// ---------- the view ----------

const fl = { loaded: false, loading: false, tab: null, list: [] }; // the Freelancers tab, read once per visit
let month = null; // first of the month shown in Calendar view
let selected = ymd();

// o: { tab, rows, tools, body, ctx, redraw, refresh, dialog }
export function renderCrewing(o) {
  const { tab, rows, tools, body } = o;
  const data = parseCrewing(rows);
  const all = bookingsOf(data.projects);
  const stored = store.get(VIEW, 'days');
  const view = ['sheet', 'calendar'].includes(stored) ? stored : 'days';
  const setView = v => { store.set(VIEW, v); o.redraw(); };
  const colours = new Map(data.projects.map((p, i) => [p.name, PALETTE[i % PALETTE.length]]));

  fill(tools, h('div', { class: 'seg', role: 'group', 'aria-label': 'Crewing view' },
    [['days', 'Days'], ['sheet', 'Sheet'], ['calendar', 'Calendar']].map(([v, label]) =>
      h('button', { class: view === v ? 'on' : '', 'aria-pressed': String(view === v), onclick: () => setView(v) }, label))));
  o.ctx.actions(o.sheetLink,
    h('button', { class: 'nav-icon', 'aria-label': 'Freelancers', onclick: () => openFreelancers(o) }, icon('people')),
    h('button', { class: 'nav-icon', 'aria-label': 'Import project days from calendar', onclick: () => importFromCalendar(o, data) }, icon('calendar')));

  if (!fl.loaded && !fl.loading) {
    fl.loading = true;
    loadFreelancers(o.tabs).then(r => { fl.tab = r.tab; fl.list = r.list; }, () => {})
      .finally(() => { fl.loaded = true; fl.loading = false; if (o.ctx.alive) o.redraw(); });
  }

  if (!calState.checked && !calState.loading) {
    calState.loading = true;
    findCalendar().then(id => { calState.id = id; }, e => { calState.err = errMsg(e); })
      .finally(() => { calState.checked = true; calState.loading = false; if (o.ctx.alive) o.redraw(); });
  }

  fill(body,
    calBar(o),
    view === 'days' ? daysView(o, data) : view === 'sheet' ? sheetView(o, data) : calendarView(all, data, colours),
    view !== 'calendar' ? h('button', { class: 'btn block', onclick: () => newProject(o, data) }, icon('plus'), 'New project') : null);
  syncCalendar(all);
}

function calBar(o) {
  if (calState.id) return h('p', { class: 'crew-status muted small' }, calState.msg || 'Google Calendar “Project Crewing” is connected');
  if (!calState.checked) return null;
  return h('section', { class: 'card' },
    h('h3', {}, 'Show crewing in Google Calendar'),
    h('p', { class: 'muted' }, calState.err || 'Create a shared “Project Crewing” calendar that lists who is booked on which project, day by day. It stays up to date from this tab.'),
    h('button', { class: 'btn primary', onclick: async e => {
      e.target.disabled = true;
      try {
        const r = await createCalendar();
        calState.id = r.id;
        if (r.shared === false) toast('Calendar created, but couldn’t share it with the team — share it in Google Calendar', 'error');
        else toast('Project Crewing calendar created');
      } catch (err) { toast(errMsg(err), 'error'); }
      o.redraw();
    } }, 'Create calendar'));
}

// ----- Sheet view: one card per project, people down the side, dates across -----
function sheetView(o, data) {
  if (!data.projects.length) {
    return h('section', { class: 'card center' }, h('p', { class: 'muted' }, 'No projects yet. Add one below, or paste your crew sheet into this tab: a grey bold row with the project name and dates, then a row per person.'));
  }
  return data.projects.map(p => h('section', { class: 'crew-project' },
    h('h3', {}, p.name, h('span', { class: 'count' }, `${p.people.length} crew`)),
    p.cols.length ? h('div', { class: 'crew-scroll' }, h('table', { class: 'crew-grid' },
      h('thead', {}, h('tr', {}, h('th', { class: 'crew-corner', scope: 'col' }), p.cols.map(c => h('th', { class: 'crew-date', scope: 'col' },
        h('button', { type: 'button', onclick: () => editDate(o, p, c) }, c.label))))),
      h('tbody', {}, p.people.map(person => h('tr', {},
        h('th', { class: 'crew-person', scope: 'row' }, h('button', { type: 'button', onclick: () => editPerson(o, p, person) }, person.name)),
        p.cols.map(c => {
          const on = person.cells.has(c.col);
          const note = person.cells.get(c.col);
          return h('td', {}, h('button', {
            type: 'button', class: 'crew-cell' + (on ? ' on' : ''),
            'aria-label': `${person.name}, ${c.label}: ${on ? 'booked' + (note ? ', ' + note : '') : 'not booked'}`,
            onclick: () => editBooking(o, p, person, c),
          }, on ? (note || icon('check')) : ''));
        })))))) : h('p', { class: 'card muted' }, 'No dates yet. Add a date to start booking people.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn small', onclick: () => addPerson(o, p) }, icon('plus'), 'Person'),
      h('button', { class: 'btn small', onclick: () => addDay(o, p) }, icon('plus'), 'Date'))));
}

// ----- Calendar view: month grid in each project's colour, tap a day to see who is booked -----
function calendarView(all, data, colours) {
  const monthStartOf = d => new Date(d.getFullYear(), d.getMonth(), 1);
  if (!month) {
    const next = all.find(b => b.date >= ymd());
    month = monthStartOf(next ? parseYmd(next.date) : new Date());
    if (next && selected < ymd()) selected = next.date;
  }
  const wrap = h('div', {});
  const draw = () => {
    const gs = addDays(month, -((month.getDay() + 6) % 7));
    const weeks = Math.ceil(((month.getDay() + 6) % 7 + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7);
    const byDay = new Map();
    for (const b of all) (byDay.get(b.date) || byDay.set(b.date, []).get(b.date)).push(b);
    const today = ymd();
    const mKey = ymd(month).slice(0, 7);
    const step = n => { month = new Date(month.getFullYear(), month.getMonth() + n, 1); draw(); };
    const cells = Array.from({ length: weeks * 7 }, (_, i) => {
      const k = ymd(addDays(gs, i));
      const evs = byDay.get(k) || [];
      const shown = evs.slice(0, evs.length > 4 ? 3 : 4);
      return h('button', {
        type: 'button', class: 'mday' + (k === today ? ' today' : '') + (k === selected ? ' sel' : '') + (k.slice(0, 7) !== mKey ? ' out' : ''),
        'aria-label': dayLabel(parseYmd(k)) + (evs.length ? `, ${evs.length} booked` : ''),
        onclick: () => { selected = k; if (k.slice(0, 7) !== mKey) month = monthStartOf(parseYmd(k)); draw(); },
      }, h('span', { class: 'num' }, parseYmd(k).getDate()), h('span', { class: 'chips-day' },
        shown.map(b => h('span', { class: 'mchip', style: { '--chip-bg': colours.get(b.project) || PALETTE[0], '--chip-fg': '#fff' } }, shortName(b.person))),
        evs.length > shown.length ? h('span', { class: 'mmore' }, `+${evs.length - shown.length} more`) : null));
    });
    const day = byDay.get(selected) || [];
    const projects = [...new Set(day.map(b => b.project))];
    fill(wrap,
      h('div', { class: 'chips' }, [...colours].map(([n, c]) => h('span', { class: 'chip static', style: { '--c': c } }, h('i', { class: 'dot' }), n))),
      h('div', { class: 'month-head' },
        h('h2', {}, month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })),
        h('button', { class: 'btn small icon-only', 'aria-label': 'Previous month', onclick: () => step(-1) }, icon('chevron-left')),
        h('button', { class: 'btn small icon-only', 'aria-label': 'Next month', onclick: () => step(1) }, icon('chevron-right'))),
      h('div', { class: 'month-grid' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => h('span', { class: 'wd', 'aria-hidden': 'true' }, d)), cells),
      h('section', { class: 'day' },
        h('h3', {}, dayLabel(parseYmd(selected)), selected === today ? h('span', { class: 'tag tint' }, 'Today') : null),
        projects.length ? projects.map(p => {
          const crew = day.filter(b => b.project === p);
          return h('div', { class: 'crew-day-project' },
            h('p', { class: 'section-title' }, h('i', { class: 'dot', style: { '--c': colours.get(p) } }), p),
            h('div', { class: 'group' }, crew.map(b => h('div', { class: 'row' },
              h('span', { class: 'row-main' }, h('b', {}, b.person), b.note && !noteIsName(b.note, b.person) ? h('small', {}, b.note) : null),
              day.filter(x => x.person === b.person).length > 1 ? h('span', { class: 'tag warn' }, 'Double-booked') : null))));
        }) : h('p', { class: 'small empty' }, 'Nobody booked')));
  };
  draw();
  return wrap;
}

// ----- editing -----

const cellText = (rows, r, c) => text(rows[r]?.[c]);
const saveBtn = label => h('button', { class: 'btn primary block', type: 'submit', 'data-bar': 'Save' }, label);

// Guarded write, then re-read the sheet. work() returns the batch promise.
async function write(o, row, col, expected, work) {
  await guardedWrite(o.tab, row, col, expected, work);
  await o.refresh();
}

function editBooking(o, p, person, c) {
  const on0 = person.cells.has(c.col);
  const note = h('input', { type: 'text', value: person.cells.get(c.col) || '', placeholder: 'e.g. 0830hrs, 1/2 day' });
  const on = h('input', { type: 'checkbox', switch: true, role: 'switch', checked: on0 });
  const btn = saveBtn('Save');
  const m = o.dialog(person.name, h('form', { class: 'form', onsubmit: e => {
    e.preventDefault();
    btn.disabled = true;
    const value = on.checked ? note.value.trim() : '';
    m.close();
    write(o, person.row, c.col, cellText(o.rows, person.row, c.col), () => batch([{ updateCells: {
      range: rng(o.tab, person.row, c.col),
      rows: [{ values: [{ userEnteredValue: val(value), userEnteredFormat: fmt(on.checked ? GREEN : WHITE, false, 'CENTER') }] }],
      fields: FMT_FIELDS,
    } }]));
  } },
  h('p', { class: 'muted' }, `${p.name} · ${c.label}`),
  h('label', { class: 'check' }, 'Booked', on),
  field('Note', note),
  btn));
}

function addPerson(o, p) {
  const name = h('input', { type: 'text', required: true, placeholder: 'e.g. Jamie Baker' });
  const btn = saveBtn('Add person');
  const m = o.dialog(`Add person · ${p.name}`, h('form', { class: 'form', onsubmit: e => {
    e.preventDefault();
    if (!name.value.trim()) return;
    btn.disabled = true;
    m.close();
    const at = p.lastRow + 1;
    const width = Math.max(2, ...p.cols.map(c => c.col + 1));
    write(o, p.lastRow, 0, cellText(o.rows, p.lastRow, 0), () => batch([
      ...growRows(o.tab, at + 1),
      { insertDimension: { range: { sheetId: o.tab.sheetId, dimension: 'ROWS', startIndex: at, endIndex: at + 1 }, inheritFromBefore: true } },
      personReq(o.tab, at, name.value.trim(), width),
    ]));
  } }, field('Name', name), btn));
  setTimeout(() => name.focus(), 50);
}

function editPerson(o, p, person) {
  const name = h('input', { type: 'text', required: true, value: person.name });
  const btn = saveBtn('Save');
  const m = o.dialog('Edit person', h('form', { class: 'form', onsubmit: e => {
    e.preventDefault();
    if (!name.value.trim()) return;
    btn.disabled = true;
    m.close();
    write(o, person.row, 0, person.name, () => batch([{ updateCells: { range: rng(o.tab, person.row, 0), rows: [{ values: [{ userEnteredValue: val(name.value.trim()) }] }], fields: 'userEnteredValue' } }]));
  } }, field('Name', name), btn,
  h('div', { class: 'actions' }, h('button', { class: 'btn danger', type: 'button', onclick: () => {
    if (!confirm(`Remove ${person.name} from ${p.name}? This deletes their row in the sheet.`)) return;
    m.close();
    write(o, person.row, 0, person.name, () => batch([{ deleteDimension: { range: { sheetId: o.tab.sheetId, dimension: 'ROWS', startIndex: person.row, endIndex: person.row + 1 } } }]));
  } }, 'Remove from project'))));
}

const ORD = n => n + ([11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const floorDate = () => { const t = new Date(); return addDays(new Date(t.getFullYear(), t.getMonth(), t.getDate()), -120); };
// "14th Oct", with the year added only when the sheet's reading rules would otherwise get the year wrong
const labelFor = (d, after) => {
  const base = `${ORD(d.getDate())} ${MON[d.getMonth()]}`;
  const back = parseDates(base, after)[0];
  return back && ymd(back) === ymd(d) ? base : `${base} ${d.getFullYear()}`;
};
const lastDateOf = p => p.cols.flatMap(c => c.dates).pop() || floorDate();
const norm = s => s.trim().toLowerCase();

function addDay(o, p) {
  const last = p.cols.flatMap(c => c.dates).pop();
  const date = h('input', { type: 'date', required: true, value: last ? ymd(addDays(last, 1)) : ymd() });
  const suffix = h('input', { type: 'text', placeholder: 'e.g. PREP, Live (optional)' });
  const btn = saveBtn('Add day');
  const m = o.dialog(`Add day · ${p.name}`, h('form', { class: 'form', onsubmit: e => {
    e.preventDefault();
    if (!date.value) return;
    btn.disabled = true;
    m.close();
    const label = [labelFor(parseYmd(date.value), lastDateOf(p)), suffix.value.trim()].filter(Boolean).join(' ');
    const col = Math.max(0, ...p.cols.map(c => c.col)) + 1;
    const cols = o.tab.gridProperties?.columnCount || 26;
    write(o, p.row, col, cellText(o.rows, p.row, col), () => batch([
      ...(col + 1 > cols ? [{ appendDimension: { sheetId: o.tab.sheetId, dimension: 'COLUMNS', length: col + 1 - cols + 2 } }] : []),
      { updateCells: { range: rng(o.tab, p.row, col), rows: [{ values: [{ userEnteredValue: val(label), userEnteredFormat: fmt(GREY, true, 'CENTER') }] }], fields: FMT_FIELDS } },
    ]));
  } }, field('Date', date), field('Label', suffix), btn));
}

function editDate(o, p, c) {
  const label = h('input', { type: 'text', required: true, value: c.label });
  const btn = saveBtn('Save');
  const m = o.dialog('Edit date', h('form', { class: 'form', onsubmit: e => {
    e.preventDefault();
    if (!label.value.trim()) return;
    btn.disabled = true;
    m.close();
    write(o, p.row, c.col, c.label, () => batch([{ updateCells: { range: rng(o.tab, p.row, c.col), rows: [{ values: [{ userEnteredValue: val(label.value.trim()) }] }], fields: 'userEnteredValue' } }]));
  } }, h('p', { class: 'muted' }, p.name), field('Date', label), btn,
  h('div', { class: 'actions' }, h('button', { class: 'btn danger', type: 'button', onclick: () => {
    if (!confirm(`Remove ${c.label} and everyone booked on it?`)) return;
    m.close();
    write(o, p.row, c.col, c.label, () => batch([
      { updateCells: { range: rng(o.tab, p.row, c.col), rows: [{ values: [{ userEnteredValue: {} }] }], fields: 'userEnteredValue' } },
      ...(p.lastRow > p.row ? [{ repeatCell: { range: rng(o.tab, p.row + 1, c.col, c.col + 1, p.lastRow + 1), cell: { userEnteredFormat: { backgroundColor: WHITE } }, fields: 'userEnteredValue,userEnteredFormat.backgroundColor' } }] : []),
    ]));
  } }, 'Remove date'))));
}

function newProject(o, data) {
  const name = h('input', { type: 'text', required: true, placeholder: 'e.g. Dior Cocktail Party' });
  const date = h('input', { type: 'text', placeholder: 'e.g. 30th Nov' });
  const who = h('input', { type: 'text', placeholder: 'e.g. James Matthews' });
  const btn = saveBtn('Add project');
  const m = o.dialog('New project', h('form', { class: 'form', onsubmit: e => {
    e.preventDefault();
    if (!name.value.trim()) return;
    btn.disabled = true;
    m.close();
    const at = data.lastRow < 0 ? 0 : data.lastRow + 3; // two blank rows between projects, like the sheet
    const work = () => batch([
      ...growRows(o.tab, at + 2),
      headReq(o.tab, at, [name.value.trim(), ...(date.value.trim() ? [date.value.trim()] : [])]),
      ...(who.value.trim() ? [personReq(o.tab, at + 1, who.value.trim(), 2)] : []),
    ]);
    if (data.lastRow < 0) work().then(() => o.refresh(), err => toast(errMsg(err), 'error'));
    else write(o, data.lastRow, 0, cellText(o.rows, data.lastRow, 0), work);
  } }, field('Project', name), field('First date (optional)', date), field('First person (optional)', who), btn));
  setTimeout(() => name.focus(), 50);
}

// ----- Days view: one section per project, one row per day, tap a day to pick who is booked -----
function daysView(o, data) {
  const cards = [];
  if (fl.loaded && !fl.tab) {
    cards.push(h('section', { class: 'card' },
      h('h3', {}, 'Set up your freelancer list'),
      h('p', { class: 'muted' }, 'Add a Freelancers tab to the spreadsheet (name, email, phone and specialisms) to pick who is booked from a list. It starts with Test Dummy 1–10 to try out.'),
      h('button', { class: 'btn primary', onclick: async e => {
        e.target.disabled = true;
        try { const t = await addFreelancersTab(); fl.loaded = false; await o.switchTo(t); } catch (err) { toast(errMsg(err), 'error'); e.target.disabled = false; }
      } }, 'Create Freelancers tab')));
  }
  if (!data.projects.length) {
    cards.push(h('section', { class: 'card center' }, h('p', { class: 'muted' }, 'No projects yet. Import project days from your calendar (top right), or add a project below.')));
    return cards;
  }
  const tagOf = name => fl.list.find(f => norm(f.name) === norm(name))?.tags[0];
  const who = name => h('span', { class: 'initials tag-' + (tagOf(name) ? tagColour(tagOf(name)) : 'gray') }, name);
  for (const p of data.projects) {
    cards.push(h('section', { class: 'crew-project' },
      h('h3', {}, p.name, h('span', { class: 'count' }, `${p.cols.length} day${p.cols.length === 1 ? '' : 's'}`)),
      p.cols.length ? h('div', { class: 'group' }, p.cols.map(c => {
        const crew = p.people.filter(x => x.cells.has(c.col));
        return h('button', { class: 'row crew-day', onclick: () => pickCrew(o, p, c) },
          h('span', { class: 'crew-day-date' }, c.label),
          h('span', { class: 'crew-day-who' }, crew.length ? crew.map(x => who(x.name)) : h('span', { class: 'muted' }, 'Nobody booked')),
          icon('chevron-right', 'chev'));
      })) : h('p', { class: 'card muted' }, 'No days yet. Add a day to start booking people.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', onclick: () => addDay(o, p) }, icon('plus'), 'Add day'),
        h('button', { class: 'btn small', onclick: () => editProject(o, p) }, 'Edit project'))));
  }
  return cards;
}

function openFreelancers(o) {
  if (fl.tab) o.switchTo(fl.tab);
  else toast('Create the Freelancers tab first (see the card in Days view)', 'error');
}

// Who is booked on this day: tick freelancers from the list (people already in the sheet but not in the list are shown too)
async function pickCrew(o, p, c) {
  try { const r = await loadFreelancers(o.tabs); fl.tab = r.tab; fl.list = r.list; } catch { /* use what we have */ }
  const booked = new Set(p.people.filter(x => x.cells.has(c.col)).map(x => norm(x.name)));
  const sel = new Set(booked);
  const names = new Map(); // norm → display name
  for (const f of fl.list) names.set(norm(f.name), f);
  for (const x of p.people) if (!names.has(norm(x.name))) names.set(norm(x.name), { name: x.name, tags: [], legacy: true });
  let q = '', tag = '';
  const search = h('input', { type: 'search', placeholder: 'Search name or specialism', 'aria-label': 'Search',
    oninput: e => { q = e.target.value.trim().toLowerCase(); draw(); }, onkeydown: e => { if (e.key === 'Enter') e.preventDefault(); } });
  const tagsEl = h('div', { class: 'chips' });
  const listEl = h('div', {});
  const form = h('form', { class: 'form' }, search, tagsEl, listEl);
  const btn = saveBtn('Save');
  form.append(btn, h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => { m.close(); editDate(o, p, c); } }, 'Edit or remove this day')));
  function draw() {
    const all = [...names.values()];
    fill(tagsEl, specialismOptions(fl.list).map(t => h('button', { type: 'button', class: 'chip' + (tag === t ? '' : ' off'), 'aria-pressed': String(tag === t), onclick: () => { tag = tag === t ? '' : t; draw(); } }, t)));
    const shown = all.filter(f => (!tag || f.tags.includes(tag)) && (!q || [f.name, ...f.tags].some(x => x.toLowerCase().includes(q))));
    fill(listEl, shown.length ? h('div', { class: 'group' }, shown.map(f => h('button', {
      type: 'button', class: 'row', role: 'checkbox', 'aria-checked': String(sel.has(norm(f.name))),
      onclick: () => { const k = norm(f.name); if (sel.has(k)) sel.delete(k); else sel.add(k); form.dispatchEvent(new Event('input')); draw(); },
    }, h('span', { class: 'row-main' }, h('b', {}, f.name), f.tags.length ? h('span', { class: 'tag-line' }, f.tags.map(tagChip)) : f.legacy ? h('small', {}, 'Not in the freelancer list') : null),
    sel.has(norm(f.name)) ? icon('check', 'tick-mark') : null)))
      : h('p', { class: 'muted center-text' }, fl.list.length ? 'Nobody matches.' : 'The freelancer list is empty.'));
  }
  const m = o.dialog(`${p.name} · ${c.label}`, form);
  form.addEventListener('submit', e => {
    e.preventDefault();
    const mark = (row, on) => ({ updateCells: { range: rng(o.tab, row, c.col), rows: [{ values: [{ userEnteredValue: {}, userEnteredFormat: fmt(on ? GREEN : WHITE, false, 'CENTER') }] }], fields: FMT_FIELDS } });
    const reqs = [];
    for (const x of p.people) {
      const k = norm(x.name), has = x.cells.has(c.col);
      if (sel.has(k) && !has) reqs.push(mark(x.row, true));
      if (!sel.has(k) && has) reqs.push(mark(x.row, false));
    }
    const add = [...sel].filter(k => !p.people.some(x => norm(x.name) === k));
    if (!reqs.length && !add.length) { m.close(); return; }
    btn.disabled = true;
    m.close();
    const width = Math.max(2, ...p.cols.map(x => x.col + 1));
    let at = p.lastRow + 1;
    if (add.length) reqs.unshift(...growRows(o.tab, at + add.length));
    for (const k of add) {
      reqs.push({ insertDimension: { range: { sheetId: o.tab.sheetId, dimension: 'ROWS', startIndex: at, endIndex: at + 1 }, inheritFromBefore: true } },
        personReq(o.tab, at, names.get(k).name, width), mark(at, true));
      at++;
    }
    write(o, p.lastRow, 0, cellText(o.rows, p.lastRow, 0), () => batch(reqs));
  });
  draw();
}

function editProject(o, p) {
  const name = h('input', { type: 'text', required: true, value: p.name });
  const btn = saveBtn('Save');
  const m = o.dialog('Edit project', h('form', { class: 'form', onsubmit: e => {
    e.preventDefault();
    if (!name.value.trim()) return;
    btn.disabled = true;
    m.close();
    write(o, p.row, 0, p.name, () => batch([{ updateCells: { range: rng(o.tab, p.row, 0), rows: [{ values: [{ userEnteredValue: val(name.value.trim()) }] }], fields: 'userEnteredValue' } }]));
  } }, field('Project name', name), btn,
  h('div', { class: 'actions' }, h('button', { class: 'btn danger', type: 'button', onclick: () => {
    if (!confirm(`Delete ${p.name} and all its bookings from the sheet?`)) return;
    m.close();
    write(o, p.row, 0, p.name, () => batch([{ deleteDimension: { range: { sheetId: o.tab.sheetId, dimension: 'ROWS', startIndex: p.row, endIndex: p.lastRow + 1 } } }]));
  } }, 'Delete project'))));
}

// ----- Import: projects and their days inferred from the Google calendars -----
// Events carrying a job number (H-01886, or the job picked on the event) are grouped by job. Other events are
// grouped by identical title, and only when that title is on two or more days. Past projects are left out.
const JOB = /\bH-\d{3,6}\b/i;
function eventDays(e) {
  const out = [];
  if (e.start.date) for (let d = parseYmd(e.start.date), end = parseYmd(e.end.date); d < end; d = addDays(d, 1)) out.push(ymd(d));
  else {
    const s = new Date(e.start.dateTime), en = new Date(e.end.dateTime);
    for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d <= en && ymd(d) <= ymd(en); d = addDays(d, 1)) out.push(ymd(d));
  }
  return out;
}

export function inferProjects(events) {
  const groups = new Map();
  for (const e of events) {
    const priv = e.extendedProperties?.private || {};
    const job = (priv.hydraJob || `${e.summary || ''} ${e.description || ''}`.match(JOB)?.[0] || '').toUpperCase();
    const title = (priv.hydraJobTitle || (e.summary || '').replace(JOB, '').replace(/^[\s:–—-]+|[\s:–—-]+$/g, '')).trim();
    if (!job && !title) continue;
    const key = job || 'T:' + norm(title);
    const g = groups.get(key) || groups.set(key, { job, names: new Map(), days: new Set(), cals: new Set(), events: 0 }).get(key);
    g.names.set(title, (g.names.get(title) || 0) + (priv.hydraJobTitle ? 100 : 1));
    for (const d of eventDays(e)) g.days.add(d);
    g.cals.add(calName(e._cal));
    g.events++;
  }
  return [...groups.values()]
    .map(g => ({ job: g.job, name: [...g.names].sort((a, b) => b[1] - a[1])[0]?.[0] || g.job, days: [...g.days].sort(), cals: [...g.cals], tagged: !!g.job }))
    .filter(g => g.days.length && g.days[g.days.length - 1] >= ymd() && (g.tagged || g.days.length >= 2))
    .sort((a, b) => a.days[0].localeCompare(b.days[0]));
}

async function importFromCalendar(o, data) {
  const box = h('div', {}, h('div', { class: 'loading' }, 'Reading your calendars…'));
  const m = o.dialog('Import from calendar', box);
  try {
    const hidden = store.get('hydra.cal.hidden', []);
    const cals = (await getCalendars()).filter(c => c.id !== calState.id && !isHolidays(c) && !hidden.includes(c.id));
    const from = addDays(new Date(), -1), to = addDays(new Date(), 400);
    const qs = `?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}`;
    const events = (await Promise.all(cals.map(c => gfetch(calUrl(c.id, qs))
      .then(d => (d.items || []).filter(e => e.status !== 'cancelled').map(e => ({ ...e, _cal: c }))).catch(() => [])))).flat();
    const cands = inferProjects(events).map(g => {
      const have = data.projects.find(p => norm(p.name) === norm(g.name) || (norm(g.name).length > 3 && norm(p.name).length > 3 && (norm(g.name).includes(norm(p.name)) || norm(p.name).includes(norm(g.name)))));
      const known = new Set(have ? have.cols.flatMap(c => c.dates.map(d => ymd(d))) : []);
      return { ...g, have, fresh: g.days.filter(d => !known.has(d)) };
    });
    const sel = new Set(cands.filter(c => c.tagged && c.fresh.length).map(c => c));
    if (!cands.length) { fill(box, h('p', { class: 'muted' }, 'No upcoming project days found. Tag calendar events with a job (the Job field when you create an event) and they will show up here.')); return; }
    const btn = saveBtn('Import');
    const form = h('form', { class: 'form' });
    const draw = () => fill(form,
      h('p', { class: 'muted' }, 'Projects found on your calendars. Ticked ones are added to PROJECT CREWING with a day for each date.'),
      h('div', { class: 'group' }, cands.map(c => h('button', {
        type: 'button', class: 'row', role: 'checkbox', disabled: !c.fresh.length, 'aria-checked': String(sel.has(c)),
        onclick: () => { if (sel.has(c)) sel.delete(c); else sel.add(c); form.dispatchEvent(new Event('input')); draw(); },
      }, h('span', { class: 'row-main' }, h('b', {}, c.name),
        h('small', {}, `${c.days.length} day${c.days.length === 1 ? '' : 's'} · ${shortRange(c.days)} · ${c.cals.join(', ')}`)),
      h('span', { class: 'tag' + (c.fresh.length ? '' : ' tint') }, !c.fresh.length ? 'Up to date' : c.have ? `+${c.fresh.length} day${c.fresh.length === 1 ? '' : 's'}` : 'New'),
      sel.has(c) ? icon('check', 'tick-mark') : null))),
      btn);
    draw();
    fill(box, form);
    form.addEventListener('submit', e => {
      e.preventDefault();
      const chosen = cands.filter(c => sel.has(c) && c.fresh.length);
      if (!chosen.length) { m.close(); return; }
      btn.disabled = true;
      m.close();
      const reqs = [];
      let at = data.lastRow < 0 ? 0 : data.lastRow + 3;
      let needCols = 0;
      const labels = (days, after) => days.map(d => { const date = parseYmd(d); const l = labelFor(date, after); after = date; return l; });
      for (const c of chosen) {
        if (c.have) {
          const col0 = Math.max(0, ...c.have.cols.map(x => x.col)) + 1;
          const ls = labels(c.fresh, lastDateOf(c.have));
          needCols = Math.max(needCols, col0 + ls.length);
          ls.forEach((l, i) => reqs.push({ updateCells: { range: rng(o.tab, c.have.row, col0 + i), rows: [{ values: [{ userEnteredValue: val(l), userEnteredFormat: fmt(GREY, true, 'CENTER') }] }], fields: FMT_FIELDS } }));
        } else {
          const ls = labels(c.days, floorDate());
          needCols = Math.max(needCols, ls.length + 1);
          reqs.push(headReq(o.tab, at, [c.name, ...ls]));
          at += 3; // header, then two blank rows before the next project
        }
      }
      const cols = o.tab.gridProperties?.columnCount || 26;
      const work = () => batch([
        ...growRows(o.tab, at + 1),
        ...(needCols > cols ? [{ appendDimension: { sheetId: o.tab.sheetId, dimension: 'COLUMNS', length: needCols - cols + 2 } }] : []),
        ...reqs,
      ]);
      if (data.lastRow < 0) work().then(() => o.refresh(), err => toast(errMsg(err), 'error'));
      else write(o, data.lastRow, 0, cellText(o.rows, data.lastRow, 0), work);
    });
  } catch (err) {
    fill(box, h('p', { class: 'error' }, errMsg(err)));
  }
}

const shortRange = days => {
  const f = d => parseYmd(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return days.length > 1 ? `${f(days[0])} – ${f(days[days.length - 1])}` : f(days[0]);
};
