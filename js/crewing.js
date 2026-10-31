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
import { isFreelancersTab, loadFreelancers, personChips, hydraLabel, specialismOptions, addFreelancersTab } from './freelancers.js';
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
// Each project gets its own Google event colour (by its order in the sheet). Green and grey are left out (Booked and
// Pencilled) and so is purple (Hydra's own team). id = Google colorId, hex = the same colour in the app.
const PROJECT_COLOURS = [
  { id: '9', hex: '#3f51b5', fg: '#fff' },    // blueberry
  { id: '6', hex: '#f4511e', fg: '#fff' },    // tangerine
  { id: '7', hex: '#039be5', fg: '#fff' },    // peacock
  { id: '11', hex: '#d50000', fg: '#fff' },   // tomato
  { id: '5', hex: '#f6bf26', fg: '#1f1f1d' }, // banana
  { id: '4', hex: '#e67c73', fg: '#fff' },    // flamingo
];
const BOOKED_COLOUR = { hex: '#0b8043', fg: '#fff' };    // basil, Google colour 10
const PENCIL_COLOUR = { hex: '#616161', fg: '#fff' };    // graphite, Google colour 8
const TEAM_COLOUR = { hex: '#8e24aa', fg: '#fff' };      // grape, Google colour 3 (pencilled: lavender, colour 1): Hydra employees

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

// A date cell holds days since 30 Dec 1899
const fromSerial = n => addDays(new Date(1899, 11, 30), Math.round(n));
const toSerial = d => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);

// Blocks of crew under their project header. Each project: { name, row, cols: [{ col, label, dates }],
// people: [{ row, name, cells: Map(col → { note, ok }) }], slots: [row of an empty crew row], lastRow }.
// Green fill = confirmed (ok). Text without green = pencilled (held, not confirmed). Empty = not booked.
// Date headers are real dates (picked from the date drop-down) or free text like "14th Oct PREP".
export function parseCrewing(rows, today = new Date()) {
  const projects = [];
  const start = addDays(new Date(today.getFullYear(), today.getMonth(), today.getDate()), -120);
  let cur = null;
  let lastRow = -1;
  rows.forEach((r, i) => {
    if (!r.some(c => text(c))) {
      if (cur && r[0]?.dv) cur.slots.push(i); // an empty crew row with its name drop-down, ready to use
      return;
    }
    lastRow = i;
    const a = r[0];
    if (isHead(a)) {
      cur = { name: text(a), row: i, cols: [], people: [], slots: [], lastRow: i };
      let after = start;
      r.forEach((c, ci) => {
        if (ci === 0 || !text(c)) return;
        const dates = c.num != null ? [fromSerial(c.num)] : parseDates(text(c), after);
        if (dates.length) after = dates[dates.length - 1];
        cur.cols.push({ col: ci, label: text(c), dates });
      });
      projects.push(cur);
      return;
    }
    if (!cur || !text(a)) return;
    const cells = new Map();
    for (const { col } of cur.cols) {
      const ok = isGreen(r[col]?.bg);
      if (text(r[col]) || ok) cells.set(col, { note: text(r[col]), ok });
    }
    cur.people.push({ row: i, name: text(a), cells });
    cur.lastRow = i;
    cur.slots = []; // only empty rows after the last person count as spare
  });
  return { projects, lastRow };
}

// Everything the calendar shows, one entry per day:
//   kind 'project' = a day of a project (a date in its header), with its crew list
//   kind 'ok' = a person Booked on a project day (green), kind 'pencil' = Pencilled (named, not confirmed)
export function calendarItems(projects, isEmp = () => false) {
  const out = new Map();
  for (const [pi, p] of projects.entries()) for (const col of p.cols) for (const d of col.dates) {
    const date = ymd(d);
    const crew = p.people.filter(x => x.cells.has(col.col)).map(x => ({ name: x.name, ok: x.cells.get(col.col).ok }));
    const key = ['p', p.name, date].join('|').toLowerCase();
    out.set(key, { key, kind: 'project', project: p.name, person: '', date, note: '', label: col.label, crew, colour: PROJECT_COLOURS[pi % PROJECT_COLOURS.length].id });
    for (const person of p.people) {
      const cell = person.cells.get(col.col);
      if (!cell) continue;
      const k = [p.name, person.name, date].join('|').toLowerCase();
      out.set(k, { key: k, kind: cell.ok ? 'ok' : 'pencil', emp: isEmp(person.name), project: p.name, person: person.name, date, note: noteIsName(cell.note, person.name) ? '' : cell.note, label: col.label });
    }
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.project.localeCompare(b.project) || a.kind.localeCompare(b.kind) || a.person.localeCompare(b.person));
}

// Hydra employees (company email in the FREELANCERS tab): they are only ever Booked, never pencilled
const isEmpName = name => !!fl.list.find(f => norm(f.name) === norm(name))?.employee;
const firstName = n => n.split(/\s+/)[0];
// "Jamie B" / "Jamie S": first name plus last initial, so two Jamies can be told apart
const shortName = n => { const p = n.split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}` : p[0]; };
// "Jamie S" / "Rob S" just repeat the name; "0830hrs" or "1/2 day" are worth showing
const noteIsName = (note, person) => {
  const n = note.split(/\s+/)[0].toLowerCase();
  return n.length >= 2 && firstName(person).toLowerCase().startsWith(n);
};

// ---------- Google Calendar mirror ----------

const calState = { checked: false, loading: false, id: null, err: '', syncing: false, syncedSig: '', msg: '', run: null };

const calUrl = (id, rest = '') => `${CAL}/calendars/${encodeURIComponent(id)}/events${rest}`;
const hash = (s, seed = 0) => { // cyrb53
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};
// Google event ids may use a–v and 0–9 only (base 32)
const eventId = key => 'hc' + hash(key).toString(32) + hash(key, 7).toString(32);

// Google's event colours: project days take their project's colour, booked people green (basil), pencilled grey (graphite)
const EVENT_COLOUR = { ok: '10', pencil: '8' };
const TEAM_EVENT_COLOUR = { ok: '3', pencil: '1' }; // Hydra employees: purple (pencilled: lighter purple)
const FOOTER = 'Kept up to date from the PROJECT CREWING tab of the Hydra spreadsheet. Change bookings there or in the app.';

function eventFor(b) {
  const note = b.note && !noteIsName(b.note, b.person) ? b.note : '';
  const names = ok => (b.crew || []).filter(x => x.ok === ok).map(x => x.name).join(', ');
  const summary = b.kind === 'project' ? b.project
    : `${b.person} · ${b.project}${b.kind === 'pencil' ? ' (pencilled)' : ''}${note ? ` (${note})` : ''}`;
  const lines = b.kind === 'project'
    ? [`Project: ${b.project}`, `Day: ${b.label}`, `Booked: ${names(true) || 'nobody yet'}`, ...(names(false) ? [`Pencilled: ${names(false)}`] : [])]
    : [`Project: ${b.project}`, `Crew: ${b.person}`, `Status: ${b.kind === 'ok' ? 'Booked' : 'Pencilled'}`, ...(note ? [`Note: ${note}`] : []), `Day: ${b.label}`];
  return {
    summary,
    description: [...lines, '', FOOTER].join('\n'),
    colorId: b.kind === 'project' ? b.colour : (b.emp ? TEAM_EVENT_COLOUR : EVENT_COLOUR)[b.kind],
    start: { date: b.date },
    end: { date: ymd(addDays(parseYmd(b.date), 1)) },
    extendedProperties: { private: { hydraCrew: '1', hydraKind: b.kind, hydraProject: b.project, hydraPerson: b.person, hydraNote: b.note || '', ...(b.emp ? { hydraEmp: '1' } : {}) } },
  };
}

async function metaCalendarId() {
  const d = await gfetch(`${API}${sid()}/developerMetadata:search`, { method: 'POST', body: { dataFilters: [{ developerMetadataLookup: { metadataKey: META_KEY, locationType: 'SPREADSHEET' } }] } });
  return d?.matchedDeveloperMetadata?.[0]?.developerMetadata?.metadataValue || null;
}

// Make sure the Project Crewing calendar is in this person's calendar list (it's shared with the whole domain)
async function subscribe(id) {
  try { await gfetch(`${CAL}/users/me/calendarList`, { method: 'POST', body: { id } }); forgetCalendars(); } catch { /* already in the list */ }
}

// Is this calendar still there, and can this person write to it?
async function usable(id) {
  try { const c = await gfetch(`${CAL}/users/me/calendarList/${encodeURIComponent(id)}`); return ['owner', 'writer'].includes(c.accessRole); }
  catch { return false; }
}

const saveCalendarId = async (id, replace) => {
  if (replace) {
    try {
      await batch([{ updateDeveloperMetadata: { dataFilters: [{ developerMetadataLookup: { metadataKey: META_KEY, locationType: 'SPREADSHEET' } }], developerMetadata: { metadataValue: id }, fields: 'metadataValue' } }]);
      return;
    } catch { /* fall through and create it */ }
  }
  await batch([{ createDeveloperMetadata: { developerMetadata: { metadataKey: META_KEY, metadataValue: id, location: { spreadsheet: true }, visibility: 'DOCUMENT' } } }]);
};

// The calendar saved in the spreadsheet if it still works, else a calendar already called "Project Crewing"
// that this person can write to (adopted and saved), else null
async function findCalendar() {
  const saved = await metaCalendarId();
  if (saved) {
    await subscribe(saved);
    if (await usable(saved)) return saved;
  }
  const list = await gfetch(`${CAL}/users/me/calendarList?minAccessRole=writer&maxResults=250`);
  const same = (list.items || []).filter(c => (c.summaryOverride || c.summary || '').trim().toLowerCase() === CAL_NAME.toLowerCase());
  const mine = same.find(c => c.accessRole === 'owner') || same[0];
  if (mine) { await saveCalendarId(mine.id, !!saved); return mine.id; }
  return null;
}

async function createCalendar() {
  const existing = await findCalendar(); // someone else may have just made it, or one is already there
  if (existing) return { id: existing, shared: true };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cal = await gfetch(`${CAL}/calendars`, { method: 'POST', body: { summary: CAL_NAME, description: 'Who is booked on which project and when. Kept up to date from the Project Crewing tab of the Hydra spreadsheet.', timeZone: tz } });
  // Everyone in the studio can see it and the app can keep it up to date from any phone
  let shared = true;
  if (CONFIG.workspaceDomain) {
    try { await gfetch(`${CAL}/calendars/${encodeURIComponent(cal.id)}/acl?sendNotifications=false`, { method: 'POST', body: { role: 'writer', scope: { type: 'domain', value: CONFIG.workspaceDomain } } }); } catch { shared = false; }
  }
  await saveCalendarId(cal.id, !!(await metaCalendarId()));
  forgetCalendars();
  return { id: cal.id, shared };
}

// Google throttles bursts of calendar writes ("Rate Limit Exceeded"): wait a little longer each time and try again
async function withRetry(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= tries || !/rate limit|quota|too many|backend error/i.test(errMsg(e))) throw e;
      await new Promise(r => setTimeout(r, 600 * 2 ** i + Math.random() * 400));
    }
  }
}

async function pool(jobs, n = 3) {
  const queue = [...jobs];
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) await withRetry(queue.shift()); }));
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
        .catch(err => {
          if (!/already exists|identifier|duplicate|conflict/i.test(errMsg(err))) throw err;
          return gfetch(calUrl(calId, '/' + id), { method: 'PATCH', body: { ...body, status: 'confirmed' } });
        }));
    } else if (ex.summary !== body.summary || (ex.description || '') !== body.description || ex.start?.date !== body.start.date || (ex.colorId || '') !== body.colorId
      || JSON.stringify(ex.extendedProperties?.private) !== JSON.stringify(body.extendedProperties.private)) {
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

// Resolves once the calendar matches the sheet (or straight away when it already does / isn't connected)
function syncCalendar(bookings) {
  if (!calState.id) return Promise.resolve();
  if (calState.syncing) return calState.run;
  const sig = calState.id + JSON.stringify(bookings);
  if (sig === calState.syncedSig) return Promise.resolve();
  calState.syncing = true;
  setStatus('Updating Google Calendar…');
  calState.run = (async () => {
    try {
      await pushEvents(calState.id, bookings);
      calState.syncedSig = sig;
      const days = bookings.filter(b => b.kind === 'project').length, crew = bookings.length - days;
      setStatus(`Google Calendar is up to date · ${days} project day${days === 1 ? '' : 's'}, ${crew} booking${crew === 1 ? '' : 's'}`);
    } catch (e) {
      if (/not found/i.test(errMsg(e)) && !calState.refound) { calState.refound = true; calState.redo = true; calState.id = null; calState.checked = false; calState.msg = ''; } // calendar gone: look again, once
      else setStatus('Couldn’t update Google Calendar: ' + errMsg(e));
    } finally {
      calState.syncing = false;
    }
  })();
  return calState.run;
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

// ----- the project layout (the Apps Script in google-sheet/hydra-crewing.gs builds the same thing) -----
// Header row: project name in A, a date drop-down (picker) in each of the next columns. Under it a few crew rows,
// each with a drop-down in A listing the FREELANCERS tab. Green fill in a crew cell = confirmed for that date.
const CREW_ROWS = 6;
const DATE_COLS = 7;
const BLOCK_ROWS = 1 + CREW_ROWS + 2; // header, crew rows, two blank rows before the next project
const DATE_FORMAT = { type: 'DATE', pattern: 'ddd d mmm' };
const DATE_FIELDS = FMT_FIELDS + ',userEnteredFormat.numberFormat';
// Date cell: Sheets' own calendar picker (double-click or press Enter on the cell). Any date works, so it never runs out.
const dateRule = { condition: { type: 'DATE_IS_VALID' }, inputMessage: 'Double-click for a calendar', strict: false, showCustomUi: true };
// Booking cell drop-down: Pencilled (name, white) or Booked (name, green); Hydra employees only get Booked. Once chosen the cell holds the person's name,
// so the name is in the list too and the cell never shows as invalid.
const bookRule = (name, emp = false) => ({ condition: { type: 'ONE_OF_LIST', values: [...(name ? [name] : []), ...(emp ? [] : ['Pencilled']), 'Booked'].map(userEnteredValue => ({ userEnteredValue })) }, strict: false, showCustomUi: true }); // Hydra employees are only ever Booked

// Drop-down of freelancer names (null until the FREELANCERS tab exists). Names already in the sheet that aren't in the list stay valid.
const crewRule = o => {
  const t = o.tabs.find(isFreelancersTab);
  return t ? { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: `='${t.title.replace(/'/g, "''")}'!$A$2:$A` }] }, strict: false, showCustomUi: true } : null;
};
const dateCell = d => ({ userEnteredValue: { numberValue: toSerial(d) }, userEnteredFormat: { ...fmt(GREY, true, 'CENTER'), numberFormat: DATE_FORMAT } });

// A whole new project block at row `at`: grey header with date drop-downs, then empty crew rows with name drop-downs
const spawnReqs = (o, at, name, days = []) => {
  const w = 1 + Math.max(DATE_COLS, days.length);
  const rule = crewRule(o);
  return [
    { updateCells: {
      range: rng(o.tab, at, 0, w),
      rows: [{ values: Array.from({ length: w }, (_, c) => c === 0 ? { userEnteredValue: val(name), userEnteredFormat: fmt(GREY, true, 'CENTER') }
        : days[c - 1] ? dateCell(days[c - 1]) : { userEnteredValue: {}, userEnteredFormat: { ...fmt(GREY, true, 'CENTER'), numberFormat: DATE_FORMAT } }) }],
      fields: DATE_FIELDS,
    } },
    { setDataValidation: { range: rng(o.tab, at, 1, w), rule: dateRule } },
    { updateCells: {
      range: rng(o.tab, at + 1, 0, w, at + 1 + CREW_ROWS),
      rows: Array.from({ length: CREW_ROWS }, () => ({ values: Array.from({ length: w }, (_, c) => ({ userEnteredValue: {}, userEnteredFormat: fmt(WHITE, false, c === 0 ? 'LEFT' : 'CENTER') })) })),
      fields: FMT_FIELDS,
    } },
    ...(rule ? [{ setDataValidation: { range: rng(o.tab, at + 1, 0, 1, at + 1 + CREW_ROWS), rule } }] : []),
    { setDataValidation: { range: rng(o.tab, at + 1, 1, w, at + 1 + CREW_ROWS), rule: bookRule() } },
  ];
};

// Put these names into the project's crew rows: spare rows first, then new rows inserted under the last person.
// cell(row) can add more requests for each row (e.g. mark them confirmed on a day).
function placeCrew(o, p, names, cell = () => []) {
  const width = Math.max(2, ...p.cols.map(x => x.col + 1));
  const rule = crewRule(o);
  const reqs = [];
  let at = p.lastRow + 1;
  names.forEach((name, i) => {
    if (i < p.slots.length) {
      reqs.push(personReq(o.tab, p.slots[i], name, width), { setDataValidation: { range: rng(o.tab, p.slots[i], 1, width, p.slots[i] + 1), rule: bookRule('', isEmpName(name)) } }, ...cell(p.slots[i]));
      return;
    }
    reqs.push({ insertDimension: { range: { sheetId: o.tab.sheetId, dimension: 'ROWS', startIndex: at, endIndex: at + 1 }, inheritFromBefore: true } },
      personReq(o.tab, at, name, width), ...(rule ? [{ setDataValidation: { range: rng(o.tab, at, 0, 1, at + 1), rule } }] : []),
      { setDataValidation: { range: rng(o.tab, at, 1, width, at + 1), rule: bookRule('', isEmpName(name)) } }, ...cell(at));
    at++;
  });
  return reqs;
}

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
  const isEmp = isEmpName;
  const all = calendarItems(data.projects, isEmp);
  const stored = store.get(VIEW, 'days');
  const view = ['sheet', 'calendar'].includes(stored) ? stored : 'days';
  const setView = v => { store.set(VIEW, v); o.redraw(); };
  const colours = new Map(data.projects.map((p, i) => [p.name, PROJECT_COLOURS[i % PROJECT_COLOURS.length]]));

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
    findCalendar().then(async id => {
      if (id) return id;
      // None yet: make the shared Project Crewing calendar straight away
      const r = await createCalendar();
      if (r.shared === false) toast('Project Crewing calendar created, but couldn’t share it with the team — share it in Google Calendar', 'error');
      return r.id;
    }).then(id => { calState.id = id; calState.syncedSig = ''; }, e => { calState.err = errMsg(e); })
      .finally(() => { calState.checked = true; calState.loading = false; if (o.ctx.alive) o.redraw(); });
  }

  const synced = fl.loaded ? syncCalendar(all) : Promise.resolve(); // before drawing, so the Calendar view waits for it (and once the team is known, so colours are right first time)
  fill(body,
    calBar(o),
    view === 'days' ? daysView(o, data, isEmp) : view === 'sheet' ? sheetView(o, data) : calendarView(o, all, colours),
    view !== 'calendar' ? h('button', { class: 'btn block', onclick: () => newProject(o, data) }, icon('plus'), 'New project') : null);
  synced.then(() => { if (calState.redo) { calState.redo = false; if (o.ctx.alive) o.redraw(); } });
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
        calState.syncedSig = '';
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
          const cell = person.cells.get(c.col);
          return h('td', {}, h('button', {
            type: 'button', class: 'crew-cell' + (cell ? (cell.ok ? ' on' : ' pencil') : ''),
            'aria-label': `${person.name}, ${c.label}: ${cell ? (cell.ok ? 'confirmed' : 'pencilled') + (cell.note ? ', ' + cell.note : '') : 'not booked'}`,
            onclick: () => editBooking(o, p, person, c),
          }, cell ? (cell.note && !noteIsName(cell.note, person.name) ? cell.note : cell.ok ? icon('check') : 'TBC') : ''));
        })))))) : h('p', { class: 'card muted' }, 'No dates yet. Add a date to start booking people.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn small', onclick: () => addPerson(o, p) }, icon('plus'), 'Person'),
      h('button', { class: 'btn small', onclick: () => addDay(o, p) }, icon('plus'), 'Date'))));
}

// ----- Calendar view: month grid in each project's colour, tap a day to see who is booked -----
const ORDER = { project: 0, ok: 1, pencil: 2 };
function calendarView(o, all, colours) {
  const monthStartOf = d => new Date(d.getFullYear(), d.getMonth(), 1);
  if (!month) {
    const next = all.find(b => b.date >= ymd());
    month = monthStartOf(next ? parseYmd(next.date) : new Date());
    if (next && selected < ymd()) selected = next.date;
  }
  const colourOf = p => (colours.get(p) || PROJECT_COLOURS[hash(p) % PROJECT_COLOURS.length]).hex;
  // chips match Google Calendar: project days in the project's colour, booked green, pencilled grey
  const chipColour = b => b.kind === 'project' ? (colours.get(b.project) || PROJECT_COLOURS[hash(b.project) % PROJECT_COLOURS.length]) : b.emp ? TEAM_COLOUR : b.kind === 'ok' ? BOOKED_COLOUR : PENCIL_COLOUR;
  const wrap = h('div', {});
  let items = [];
  let state = calState.id ? 'loading' : 'sheet'; // loading | ready | sheet (not connected: show the sheet's own bookings) | error
  let err = '';
  let token = 0;
  const range = () => {
    const gs = addDays(month, -((month.getDay() + 6) % 7));
    const weeks = Math.ceil(((month.getDay() + 6) % 7 + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7);
    return [gs, weeks];
  };

  // The month shown is read from the Project Crewing Google calendar itself
  async function load() {
    if (!calState.id) { state = 'sheet'; draw(); return; }
    const t = ++token;
    state = 'loading'; draw();
    try {
      await calState.run; // let a sync that is under way finish first
      const [gs, weeks] = range();
      const qs = `?singleEvents=true&maxResults=2500&privateExtendedProperty=${encodeURIComponent('hydraCrew=1')}&timeMin=${encodeURIComponent(gs.toISOString())}&timeMax=${encodeURIComponent(addDays(gs, weeks * 7).toISOString())}`;
      const d = await gfetch(calUrl(calState.id, qs));
      if (t !== token) return;
      items = (d.items || []).filter(e => e.status !== 'cancelled' && e.start?.date).map(e => {
        const p = e.extendedProperties?.private || {};
        return { kind: p.hydraKind || 'ok', emp: p.hydraEmp === '1', project: p.hydraProject || e.summary || '', person: p.hydraPerson || '', date: e.start.date, note: p.hydraNote || '' };
      }).sort((a, b) => a.project.localeCompare(b.project) || a.kind.localeCompare(b.kind) || a.person.localeCompare(b.person));
      state = 'ready';
    } catch (e) {
      if (t !== token) return;
      state = 'error'; err = errMsg(e);
    }
    if (o.ctx.alive) draw();
  }

  function draw() {
    const shown = state === 'sheet' || state === 'error' ? all : items;
    const [gs, weeks] = range();
    const byDay = new Map();
    for (const b of shown) (byDay.get(b.date) || byDay.set(b.date, []).get(b.date)).push(b);
    const today = ymd();
    const mKey = ymd(month).slice(0, 7);
    const step = n => { month = new Date(month.getFullYear(), month.getMonth() + n, 1); load(); };
    const cells = Array.from({ length: weeks * 7 }, (_, i) => {
      const k = ymd(addDays(gs, i));
      const evs = (byDay.get(k) || []).slice().sort((a, b) => ORDER[a.kind] - ORDER[b.kind]); // project, then booked, then pencilled
      const few = evs.slice(0, evs.length > 4 ? 3 : 4);
      return h('button', {
        type: 'button', class: 'mday' + (k === today ? ' today' : '') + (k === selected ? ' sel' : '') + (k.slice(0, 7) !== mKey ? ' out' : ''),
        'aria-label': dayLabel(parseYmd(k)) + (evs.length ? `, ${evs.filter(b => b.kind === 'project').length} project, ${evs.filter(b => b.kind === 'ok').length} booked, ${evs.filter(b => b.kind === 'pencil').length} pencilled` : ''),
        onclick: () => { selected = k; if (k.slice(0, 7) !== mKey) { month = monthStartOf(parseYmd(k)); load(); } else draw(); },
      }, h('span', { class: 'num' }, parseYmd(k).getDate()), h('span', { class: 'chips-day' },
        few.map(b => h('span', { class: 'mchip' + (b.kind === 'project' ? ' proj' : b.kind === 'pencil' ? ' pencil' : ''), style: { '--chip-bg': chipColour(b).hex, '--chip-fg': chipColour(b).fg } }, b.kind === 'project' ? b.project : shortName(b.person))),
        evs.length > few.length ? h('span', { class: 'mmore' }, `+${evs.length - few.length} more`) : null));
    });
    const day = byDay.get(selected) || [];
    const projects = [...new Set(day.map(b => b.project))];
    const legend = [...new Set(shown.map(b => b.project))].sort();
    fill(wrap,
      state === 'error' ? h('p', { class: 'error' }, 'Couldn’t read the Google calendar, showing the sheet instead: ' + err) : null,
      legend.length ? h('div', { class: 'chips' }, legend.map(n => h('span', { class: 'chip static', style: { '--c': colourOf(n) } }, h('i', { class: 'dot' }), n)),
        h('span', { class: 'chip static', style: { '--c': TEAM_COLOUR.hex } }, h('i', { class: 'dot' }), 'Hydra team'),
        h('span', { class: 'chip static', style: { '--c': BOOKED_COLOUR.hex } }, h('i', { class: 'dot' }), 'Booked'),
        h('span', { class: 'chip static', style: { '--c': PENCIL_COLOUR.hex } }, h('i', { class: 'dot' }), 'Pencilled')) : null,
      h('div', { class: 'month-head' },
        h('h2', {}, month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })),
        h('button', { class: 'btn small icon-only', 'aria-label': 'Previous month', onclick: () => step(-1) }, icon('chevron-left')),
        h('button', { class: 'btn small icon-only', 'aria-label': 'Next month', onclick: () => step(1) }, icon('chevron-right'))),
      state === 'loading' ? h('div', { class: 'loading' }, 'Loading from Google Calendar…') : null,
      h('div', { class: 'month-grid' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => h('span', { class: 'wd', 'aria-hidden': 'true' }, d)), cells),
      h('section', { class: 'day' },
        h('h3', {}, dayLabel(parseYmd(selected)), selected === today ? h('span', { class: 'tag tint' }, 'Today') : null),
        projects.length ? projects.map(p => {
          const crew = day.filter(b => b.project === p && b.kind !== 'project').sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.person.localeCompare(b.person));
          return h('div', { class: 'crew-day-project' },
            h('p', { class: 'section-title' }, h('i', { class: 'dot', style: { '--c': colourOf(p) } }), p),
            crew.length ? h('div', { class: 'group' }, crew.map(b => h('div', { class: 'row' },
              h('span', { class: 'row-main' }, h('b', {}, b.person), b.note && !noteIsName(b.note, b.person) ? h('small', {}, b.note) : null),
              b.emp ? h('span', { class: 'tag emp' }, hydraLabel(fl.list.find(f => norm(f.name) === norm(b.person)) || { tags: [] })) : null,
              day.filter(x => x.kind !== 'project' && x.person === b.person).length > 1 ? h('span', { class: 'tag warn' }, 'Double-booked') : null,
              h('span', { class: 'tag' + (b.kind === 'ok' ? ' good' : '') }, b.kind === 'ok' ? 'Booked' : 'Pencilled'))))
              : h('p', { class: 'small empty' }, 'Nobody booked yet'));
        }) : h('p', { class: 'small empty' }, state === 'loading' ? '' : 'No projects on this day')));
  }
  load();
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
  const cell = person.cells.get(c.col);
  const emp = isEmpName(person.name);
  const status = h('select', {}, [['none', 'Not booked'], ...(emp ? [] : [['pencil', 'Pencilled']]), ['ok', 'Booked']].map(([v, l]) =>
    h('option', { value: v, selected: v === (cell ? (cell.ok ? 'ok' : 'pencil') : 'none') }, l)));
  const btn = saveBtn('Save');
  const m = o.dialog(person.name, h('form', { class: 'form', onsubmit: e => {
    e.preventDefault();
    btn.disabled = true;
    m.close();
    write(o, person.row, c.col, cellText(o.rows, person.row, c.col), () => batch(markReq(o.tab, person.row, c.col, status.value, person.name, emp)));
  } },
  h('p', { class: 'muted' }, `${p.name} · ${c.label}`),
  field('Status', status),
  btn));
}

// State of one booking cell: 'ok' = Booked (name, green), 'pencil' = Pencilled (name, white), 'none' = empty.
// Returns requests (the cell and its drop-down).
const markReq = (tab, row, col, state, name, emp = false) => [
  { updateCells: {
    range: rng(tab, row, col),
    rows: [{ values: [{ userEnteredValue: val(state === 'none' ? '' : name), userEnteredFormat: fmt(state === 'ok' ? GREEN : WHITE, false, 'CENTER') }] }],
    fields: FMT_FIELDS,
  } },
  { setDataValidation: { range: rng(tab, row, col, col + 1, row + 1), rule: bookRule(state === 'none' ? '' : name) } },
];

function addPerson(o, p) {
  const name = h('input', { type: 'text', required: true, placeholder: 'e.g. Jamie Baker', list: 'crew-names', autocomplete: 'off' });
  const names = h('datalist', { id: 'crew-names' }, fl.list.map(f => h('option', { value: f.name })));
  const btn = saveBtn('Add person');
  const m = o.dialog(`Add person · ${p.name}`, h('form', { class: 'form', onsubmit: e => {
    e.preventDefault();
    if (!name.value.trim()) return;
    btn.disabled = true;
    m.close();
    write(o, p.lastRow, 0, cellText(o.rows, p.lastRow, 0), () => batch(placeCrew(o, p, [name.value.trim()])));
  } }, field('Name', name), names, btn));
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
    // a real date (so the sheet shows its date picker) unless there's a label like PREP to keep
    const custom = suffix.value.trim() ? [labelFor(parseYmd(date.value), lastDateOf(p)), suffix.value.trim()].join(' ') : '';
    const cell = custom ? { userEnteredValue: val(custom), userEnteredFormat: fmt(GREY, true, 'CENTER') } : dateCell(parseYmd(date.value));
    const col = Math.max(0, ...p.cols.map(c => c.col)) + 1;
    const cols = o.tab.gridProperties?.columnCount || 26;
    write(o, p.row, col, cellText(o.rows, p.row, col), () => batch([
      ...(col + 1 > cols ? [{ appendDimension: { sheetId: o.tab.sheetId, dimension: 'COLUMNS', length: col + 1 - cols + 2 } }] : []),
      { updateCells: { range: rng(o.tab, p.row, col), rows: [{ values: [cell] }], fields: DATE_FIELDS } },
      ...(custom ? [] : [{ setDataValidation: { range: rng(o.tab, p.row, col), rule: dateRule } }]),
    ]));
  } }, field('Date', date), field('Label (optional)', suffix), btn));
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
  const date = h('input', { type: 'date' });
  const btn = saveBtn('Add project');
  const m = o.dialog('New project', h('form', { class: 'form', onsubmit: e => {
    e.preventDefault();
    if (!name.value.trim()) return;
    btn.disabled = true;
    m.close();
    const at = data.lastRow < 0 ? 0 : data.lastRow + 3; // two blank rows between projects, like the sheet
    const work = () => batch([
      ...growRows(o.tab, at + BLOCK_ROWS),
      ...((o.tab.gridProperties?.columnCount || 26) < 1 + DATE_COLS ? [{ appendDimension: { sheetId: o.tab.sheetId, dimension: 'COLUMNS', length: 1 + DATE_COLS - o.tab.gridProperties.columnCount } }] : []),
      ...spawnReqs(o, at, name.value.trim(), date.value ? [parseYmd(date.value)] : []),
    ]);
    if (data.lastRow < 0) work().then(() => o.refresh(), err => toast(errMsg(err), 'error'));
    else write(o, data.lastRow, 0, cellText(o.rows, data.lastRow, 0), work);
  } }, field('Project', name), field('First date (optional)', date),
  h('small', { class: 'hint' }, 'The project is laid out like typing its name in the sheet: date drop-downs across the top and crew rows with a freelancer drop-down underneath.'), btn));
  setTimeout(() => name.focus(), 50);
}

// ----- Days view: one section per project, one row per day, tap a day to pick who is booked -----
function daysView(o, data, isEmp) {
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
  // crew labels: green = Booked, grey = Pencilled; purple for Hydra's own people (solid = booked, outline = pencilled)
  const who = (name, ok) => h('span', { class: 'initials crew-chip ' + (isEmp(name) ? 'emp ' : '') + (ok ? 'booked' : 'pencil'), title: (isEmp(name) ? 'Hydra · ' : '') + (ok ? 'Booked' : 'Pencilled') }, name);
  for (const p of data.projects) {
    cards.push(h('section', { class: 'crew-project' },
      h('h3', {}, p.name, h('span', { class: 'count' }, `${p.cols.length} day${p.cols.length === 1 ? '' : 's'}`)),
      p.cols.length ? h('div', { class: 'group' }, p.cols.map(c => {
        const crew = p.people.filter(x => x.cells.has(c.col)).sort((a, b) => b.cells.get(c.col).ok - a.cells.get(c.col).ok);
        return h('button', { class: 'row crew-day', onclick: () => pickCrew(o, p, c) },
          h('span', { class: 'crew-day-date' }, c.label),
          h('span', { class: 'crew-day-who' }, crew.length ? crew.map(x => who(x.name, x.cells.get(c.col).ok)) : h('span', { class: 'muted' }, 'Nobody booked')),
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

// Who is booked on this day. Tap a freelancer to cycle: not booked → pencilled → booked (green) → not booked.
// People already in the sheet but not in the freelancer list are shown too.
async function pickCrew(o, p, c) {
  try { const r = await loadFreelancers(o.tabs); fl.tab = r.tab; fl.list = r.list; } catch { /* use what we have */ }
  const was = new Map(p.people.filter(x => x.cells.has(c.col)).map(x => [norm(x.name), x.cells.get(c.col).ok ? 'ok' : 'pencil']));
  const state = new Map(was);
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
  form.append(h('p', { class: 'hint' }, 'Tap once to pencil someone in, again to book them (green in the sheet), again to remove. Hydra people are booked straight away.'), btn,
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => { m.close(); editDate(o, p, c); } }, 'Edit or remove this day')));
  const cycle = { undefined: 'pencil', pencil: 'ok', ok: undefined };
  function draw() {
    const all = [...names.values()];
    fill(tagsEl, specialismOptions(fl.list).map(t => h('button', { type: 'button', class: 'chip' + (tag === t ? '' : ' off'), 'aria-pressed': String(tag === t), onclick: () => { tag = tag === t ? '' : t; draw(); } }, t)));
    const shown = all.filter(f => (!tag || f.tags.includes(tag)) && (!q || [f.name, ...f.tags].some(x => x.toLowerCase().includes(q))));
    fill(listEl, shown.length ? h('div', { class: 'group' }, shown.map(f => {
      const k = norm(f.name), st = state.get(k);
      return h('button', {
        type: 'button', class: 'row' + (st === 'ok' ? ' confirmed' : ''), 'aria-label': `${f.name}: ${st === 'ok' ? 'confirmed' : st === 'pencil' ? 'pencilled' : 'not booked'}`,
        onclick: () => { const n = f.employee && st === undefined ? 'ok' : f.employee ? undefined : cycle[st]; if (n) state.set(k, n); else state.delete(k); form.dispatchEvent(new Event('input')); draw(); },
      }, h('span', { class: 'row-main' }, h('b', {}, f.name), f.employee || f.tags.length ? h('span', { class: 'tag-line' }, personChips(f)) : f.legacy ? h('small', {}, 'Not in the freelancer list') : null),
      st ? h('span', { class: 'tag ' + (st === 'ok' ? 'good' : '') }, st === 'ok' ? 'Booked' : 'Pencilled') : null);
    })) : h('p', { class: 'muted center-text' }, fl.list.length ? 'Nobody matches.' : 'The freelancer list is empty.'));
  }
  const m = o.dialog(`${p.name} · ${c.label}`, form);
  form.addEventListener('submit', e => {
    e.preventDefault();
    const reqs = [];
    for (const x of p.people) {
      const k = norm(x.name), now = state.get(k) || 'none', before = was.get(k) || 'none';
      if (now !== before) reqs.push(...markReq(o.tab, x.row, c.col, now, x.name, isEmpName(x.name)));
    }
    const add = [...state].filter(([k]) => !p.people.some(x => norm(x.name) === k));
    if (!reqs.length && !add.length) { m.close(); return; }
    btn.disabled = true;
    m.close();
    const byRow = [];
    reqs.push(...placeCrew(o, p, add.map(([k]) => names.get(k).name), row => { const i = byRow.length; byRow.push(row); return markReq(o.tab, row, c.col, add[i][1], names.get(add[i][0]).name, isEmpName(names.get(add[i][0]).name)); }));
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
      for (const c of chosen) {
        if (c.have) {
          const col0 = Math.max(0, ...c.have.cols.map(x => x.col)) + 1;
          needCols = Math.max(needCols, col0 + c.fresh.length);
          c.fresh.forEach((d, i) => reqs.push(
            { updateCells: { range: rng(o.tab, c.have.row, col0 + i), rows: [{ values: [dateCell(parseYmd(d))] }], fields: DATE_FIELDS } },
            { setDataValidation: { range: rng(o.tab, c.have.row, col0 + i), rule: dateRule } }));
        } else {
          needCols = Math.max(needCols, 1 + Math.max(DATE_COLS, c.days.length));
          reqs.push(...spawnReqs(o, at, c.name, c.days.map(parseYmd)));
          at += BLOCK_ROWS;
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
