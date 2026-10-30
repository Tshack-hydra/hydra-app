// Calendar: day agenda (today first, load earlier days) or month grid across the person's Google calendars, with create / edit / delete.

import { gfetch, tokenValid } from './google.js';
import { h, fill, store, modal, field, toast, ymd, hhmm, parseYmd, addDays, hm, dayLabel, errMsg, spinner, isModalOpen } from './util.js';
import { jobPicker } from './jobs.js';
import { icon } from './icons.js';

const API = 'https://www.googleapis.com/calendar/v3';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAYS = 14;
const HIDDEN = 'hydra.cal.hidden';

const mondayOf = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
const writable = c => c.accessRole === 'owner' || c.accessRole === 'writer';
const calName = c => c.summaryOverride || c.summary;
const calUrl = (calId, rest = '') => `${API}/calendars/${encodeURIComponent(calId)}/events${rest}`;

let calendars = null;
let eventColors = null; // Google's event colour palette: colorId -> { background, foreground }

async function getCalendars() {
  if (calendars) return calendars;
  const d = await gfetch(`${API}/users/me/calendarList?maxResults=250`);
  calendars = (d.items || []).sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || calName(a).localeCompare(calName(b)));
  return calendars;
}

async function getColors() {
  if (eventColors) return eventColors;
  try { eventColors = (await gfetch(`${API}/colors`)).event || {}; } catch { return {}; }
  return eventColors;
}

// Same colour Google Calendar shows: the event's own colour, else its calendar's
function colorOf(e) {
  const c = e.colorId && eventColors?.[e.colorId];
  return c ? { bg: c.background, fg: c.foreground || '#fff' } : { bg: e._cal.backgroundColor, fg: e._cal.foregroundColor || '#fff' };
}

function descText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'), 'text/html');
  return doc.body.textContent.trim();
}

const VIEW = 'hydra.cal.view';
const MAX_CHIPS = 4;
const monthStartOf = d => new Date(d.getFullYear(), d.getMonth(), 1);
const monthTitle = d => d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const todayDate = () => parseYmd(ymd());

let view = store.get(VIEW, 'day') === 'month' ? 'month' : 'day';
let monthStart = monthStartOf(new Date());
let selected = ymd();
let agendaFrom = todayDate();      // Day view starts at today; the arrow above loads earlier days
let agendaTo = addDays(agendaFrom, DAYS);

// events grouped by yyyy-mm-dd for `days` days from `start`
function bucket(events, start, days) {
  const byDay = new Map();
  for (let i = 0; i < days; i++) byDay.set(ymd(addDays(start, i)), []);
  for (const e of events) {
    if (e.start.date) {
      for (let d = parseYmd(e.start.date), end = parseYmd(e.end.date); d < end; d = addDays(d, 1)) byDay.get(ymd(d))?.push(e);
    } else {
      byDay.get(ymd(new Date(e.start.dateTime)))?.push(e);
    }
  }
  const key = e => (e.start.date ? '0' : '1' + e.start.dateTime);
  for (const evs of byDay.values()) evs.sort((a, b) => key(a).localeCompare(key(b)));
  return byDay;
}

export function renderCalendar(root, ctx) {
  const chips = h('div', { class: 'chips' });
  const body = h('div', { class: 'cal-body' }, spinner());
  const segMonth = h('button', { type: 'button', onclick: () => setView('month') }, 'Month');
  const segDay = h('button', { type: 'button', onclick: () => setView('day') }, 'Day');
  const todayBtn = h('button', { class: 'btn small', onclick: goToday }, 'Today');

  ctx.actions(h('button', { class: 'nav-icon tint', 'aria-label': 'New event', onclick: () => eventForm() }, icon('plus')));
  root.append(
    h('div', { class: 'toolbar' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Calendar view' }, segDay, segMonth), h('span', { class: 'spacer' }), todayBtn),
    chips, body);
  syncSeg();

  function syncSeg() {
    segMonth.classList.toggle('on', view === 'month');
    segDay.classList.toggle('on', view === 'day');
    segMonth.setAttribute('aria-pressed', view === 'month');
    segDay.setAttribute('aria-pressed', view === 'day');
  }
  function setView(v) {
    if (v === view) return;
    view = v; store.set(VIEW, v); syncSeg();
    if (v === 'month') { monthStart = monthStartOf(parseYmd(selected)); }
    else { agendaFrom = todayDate(); agendaTo = addDays(agendaFrom, DAYS); }
    load();
  }
  function goToday() {
    selected = ymd();
    monthStart = monthStartOf(new Date());
    agendaFrom = todayDate(); agendaTo = addDays(agendaFrom, DAYS);
    load();
    window.scrollTo(0, 0);
  }

  function renderChips() {
    const hidden = store.get(HIDDEN, []);
    chips.replaceChildren(...calendars.map(c => h('button', {
      class: 'chip' + (hidden.includes(c.id) ? ' off' : ''),
      style: { '--c': c.backgroundColor },
      onclick: () => {
        const hd = store.get(HIDDEN, []);
        store.set(HIDDEN, hd.includes(c.id) ? hd.filter(x => x !== c.id) : [...hd, c.id]);
        load();
      },
    }, h('i', { class: 'dot' }), calName(c))));
  }

  async function fetchEvents(from, to) {
    const hidden = store.get(HIDDEN, []);
    const qs = `?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}`;
    const results = await Promise.all(calendars.filter(c => !hidden.includes(c.id)).map(c =>
      gfetch(calUrl(c.id, qs))
        .then(d => (d.items || []).filter(e => e.status !== 'cancelled').map(e => ({ ...e, _cal: c })))
        .catch(() => [])));
    return results.flat();
  }

  // keepTop: element key whose on-screen position must not move (when earlier days are prepended)
  async function load(quiet, anchorTop) {
    if (!quiet && anchorTop == null) body.replaceChildren(spinner());
    const v = view;
    try {
      await Promise.all([getCalendars(), getColors()]);
      renderChips();
      let events;
      if (v === 'month') {
        const gs = mondayOf(monthStart);
        events = await fetchEvents(gs, addDays(gs, monthWeeks() * 7));
      } else events = await fetchEvents(agendaFrom, agendaTo);
      if (!ctx.alive || v !== view) return;
      if (v === 'month') renderMonth(events); else renderAgenda(events, anchorTop);
    } catch (e) {
      if (ctx.alive) body.replaceChildren(h('p', { class: 'error' }, errMsg(e)));
    }
  }

  const monthWeeks = () => Math.ceil(((monthStart.getDay() + 6) % 7 + new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate()) / 7);

  // ---- Day view: today at the top, arrow above loads earlier days ----
  function renderAgenda(events, anchorTop) {
    const days = Math.round((agendaTo - agendaFrom) / 86400000);
    const byDay = bucket(events, agendaFrom, days);
    const today = ymd();
    const earlier = h('button', { class: 'more-days', 'aria-label': 'Show earlier days', onclick: loadEarlier }, icon('chevron-up'), h('span', {}, 'Earlier'));
    const later = h('button', { class: 'more-days', onclick: () => { agendaTo = addDays(agendaTo, 14); load(true, todayTop()); } }, 'Show more days');
    fill(body,
      earlier,
      h('div', { class: 'agenda' }, [...byDay].map(([k, evs]) =>
        h('section', { class: 'day' + (k === today ? ' today' : '') + (k < today ? ' past' : ''), 'data-day': k },
          h('h3', {}, dayLabel(parseYmd(k)), k === today ? h('span', { class: 'tag tint' }, 'Today') : null),
          evs.length ? h('div', { class: 'group' }, evs.map(eventRow)) : h('p', { class: 'small empty' }, 'Nothing scheduled')))),
      later);
    if (anchorTop != null) {
      const t = body.querySelector('.today');
      if (t) window.scrollBy(0, t.getBoundingClientRect().top - anchorTop);
    }
  }
  const todayTop = () => body.querySelector('.today')?.getBoundingClientRect().top ?? null;
  function loadEarlier() {
    agendaFrom = addDays(agendaFrom, -7);
    load(true, todayTop());
  }

  // ---- Month view: grid with a dot per calendar, tap a day to list it below ----
  function renderMonth(events) {
    const gs = mondayOf(monthStart), weeks = monthWeeks();
    const byDay = bucket(events, gs, weeks * 7);
    const today = ymd();
    const mKey = ymd(monthStart).slice(0, 7);
    const cells = [...byDay].map(([k, evs]) => {
      const shown = evs.slice(0, MAX_CHIPS - (evs.length > MAX_CHIPS ? 1 : 0));
      return h('button', {
        type: 'button', class: 'mday' + (k === today ? ' today' : '') + (k === selected ? ' sel' : '') + (k.slice(0, 7) !== mKey ? ' out' : ''),
        'aria-label': dayLabel(parseYmd(k)) + (evs.length ? `, ${evs.length} event${evs.length > 1 ? 's' : ''}` : ''),
        onclick: () => { selected = k; if (k.slice(0, 7) !== mKey) monthStart = monthStartOf(parseYmd(k)); load(true); },
      }, h('span', { class: 'num' }, parseYmd(k).getDate()), h('span', { class: 'chips-day' },
        shown.map(e => { const c = colorOf(e); return h('span', { class: 'mchip', style: { '--chip-bg': c.bg, '--chip-fg': c.fg } }, e.summary || '(No title)'); }),
        evs.length > shown.length ? h('span', { class: 'mmore' }, `+${evs.length - shown.length} more`) : null));
    });
    const evs = byDay.get(selected) || [];
    const step = n => { monthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() + n, 1); selected = ymd(monthStart.getMonth() === new Date().getMonth() && monthStart.getFullYear() === new Date().getFullYear() ? new Date() : monthStart); load(); };
    fill(body,
      h('div', { class: 'month-head' },
        h('h2', {}, monthTitle(monthStart)),
        h('button', { class: 'btn small icon-only', 'aria-label': 'Previous month', onclick: () => step(-1) }, icon('chevron-left')),
        h('button', { class: 'btn small icon-only', 'aria-label': 'Next month', onclick: () => step(1) }, icon('chevron-right'))),
      h('div', { class: 'month-grid' },
        ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => h('span', { class: 'wd', 'aria-hidden': 'true' }, d)),
        cells),
      h('section', { class: 'day' },
        h('h3', {}, dayLabel(parseYmd(selected)), selected === today ? h('span', { class: 'tag tint' }, 'Today') : null),
        evs.length ? h('div', { class: 'group' }, evs.map(eventRow)) : h('p', { class: 'small empty' }, 'Nothing scheduled')));
  }

  function eventRow(e) {
    // iOS Calendar list style: start time, end time underneath
    const when = e.start.date ? ['All-day'] : [hm(new Date(e.start.dateTime)), h('small', {}, hm(new Date(e.end.dateTime)))];
    return h('button', { class: 'row event', style: { '--c': colorOf(e).bg }, onclick: () => showEvent(e) },
      h('span', { class: 'ev-time' }, when),
      h('span', { class: 'ev-main' },
        h('b', {}, e.summary || '(No title)'),
        e.location ? h('small', {}, e.location) : null,
        h('small', {}, calName(e._cal))),
      icon('chevron-right', 'chev'));
  }

  function showEvent(e) {
    const start = e.start.date ? parseYmd(e.start.date) : new Date(e.start.dateTime);
    const end = e.end.date ? addDays(parseYmd(e.end.date), -1) : new Date(e.end.dateTime);
    const when = e.start.date
      ? (ymd(start) === ymd(end) ? dayLabel(start) : `${dayLabel(start)} – ${dayLabel(end)}`)
      : `${dayLabel(start)}, ${hm(start)}–${hm(end)}${ymd(start) !== ymd(end) ? ' (' + dayLabel(end) + ')' : ''}`;
    const canEdit = writable(e._cal);
    const m = modal(e.summary || '(No title)', [
      h('div', { class: 'group' },
        h('div', { class: 'row' }, h('span', { class: 'row-main' }, h('b', {}, when), h('small', {}, calName(e._cal)))),
        e.location ? h('a', { class: 'row', href: 'https://maps.google.com/?q=' + encodeURIComponent(e.location), target: '_blank', rel: 'noopener' }, icon('location'), h('span', { class: 'row-main' }, e.location), icon('chevron-right', 'chev')) : null,
        e.hangoutLink ? h('a', { class: 'row', href: e.hangoutLink, target: '_blank', rel: 'noopener' }, icon('video'), h('span', { class: 'row-main' }, 'Join video call'), icon('chevron-right', 'chev')) : null,
        e.attendees?.length ? h('div', { class: 'row' }, icon('person'), h('span', { class: 'row-main' }, e.attendees.map(a => a.displayName || a.email).join(', '))) : null),
      e.description ? h('div', { class: 'card pre' }, descText(e.description)) : null,
      h('div', { class: 'actions' },
        canEdit ? h('button', { class: 'btn primary', onclick: () => { m.close(); eventForm(e); } }, 'Edit') : null,
        canEdit ? h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Delete this event?')) return;
          try { await gfetch(calUrl(e._cal.id, '/' + e.id), { method: 'DELETE' }); m.close(); toast('Event deleted'); load(true); }
          catch (err) { toast(errMsg(err), 'error'); }
        } }, 'Delete') : null,
        e.htmlLink ? h('a', { class: 'btn', href: e.htmlLink, target: '_blank', rel: 'noopener' }, 'Open in Google') : null),
    ]);
  }

  function eventForm(e = null) {
    const cals = calendars.filter(writable);
    const now = new Date();
    const s0 = e ? (e.start.date ? parseYmd(e.start.date) : new Date(e.start.dateTime)) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1);
    const e0 = e ? (e.end.date ? addDays(parseYmd(e.end.date), -1) : new Date(e.end.dateTime)) : new Date(s0.getTime() + 3600_000);
    const allDay0 = !!e?.start.date;
    const jobNo = e?.extendedProperties?.private?.hydraJob;
    let job = jobNo ? { number: jobNo, title: e.extendedProperties.private.hydraJobTitle || '' } : null;

    const title = h('input', { type: 'text', value: e?.summary || '', required: true, placeholder: 'e.g. Site visit – Alo Shanghai' });
    const cal = h('select', { disabled: !!e }, cals.map(c => h('option', { value: c.id, selected: e ? c.id === e._cal.id : c.primary }, calName(c))));
    const allDay = h('input', { type: 'checkbox', switch: true, role: 'switch', checked: allDay0 });
    const sd = h('input', { type: 'date', value: ymd(s0) });
    const st = h('input', { type: 'time', value: hhmm(s0) });
    const ed = h('input', { type: 'date', value: ymd(e0) });
    const et = h('input', { type: 'time', value: hhmm(e0) });
    const loc = h('input', { type: 'text', value: e?.location || '' });
    const notes = h('textarea', { rows: 4 }, e ? descText(e.description) : '');
    let colorId = e?.colorId || '';
    const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' });
    const calOf = () => e ? e._cal : cals.find(c => c.id === cal.value);
    const drawSwatches = () => fill(swatches, [['', calOf()?.backgroundColor, 'Calendar colour'], ...Object.entries(eventColors || {}).map(([id, c]) => [id, c.background, 'Colour ' + id])].map(([id, bg, label]) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': colorId === id, 'aria-label': label, class: 'swatch' + (colorId === id ? ' on' : ''), style: { '--chip-bg': bg },
        onclick: () => { colorId = id; dirtyColor(); drawSwatches(); } })));
    const dirtyColor = () => form.dispatchEvent(new Event('input'));
    cal.addEventListener('change', drawSwatches);
    const picker = jobPicker({ value: job, onChange: j => { job = j; } });
    const syncTimes = () => { st.classList.toggle('hidden', allDay.checked); et.classList.toggle('hidden', allDay.checked); };
    allDay.addEventListener('change', syncTimes);
    sd.addEventListener('change', () => { if (ed.value < sd.value) ed.value = sd.value; });
    syncTimes();

    const save = h('button', { class: 'btn primary block', type: 'submit', 'data-bar': e ? 'Save' : 'Add' }, e ? 'Save changes' : 'Create event');
    const form = h('form', { class: 'form', onsubmit: async ev => {
      ev.preventDefault();
      if (!title.value.trim()) { title.focus(); return; }
      const body = { summary: title.value.trim(), location: loc.value.trim(), description: notes.value.trim() };
      if (allDay.checked) {
        body.start = { date: sd.value, dateTime: null, timeZone: null };
        body.end = { date: ymd(addDays(parseYmd(ed.value), 1)), dateTime: null, timeZone: null };
      } else {
        body.start = { date: null, dateTime: `${sd.value}T${st.value}:00`, timeZone: TZ };
        body.end = { date: null, dateTime: `${ed.value}T${et.value}:00`, timeZone: TZ };
      }
      if ((allDay.checked ? ed.value < sd.value : `${ed.value}T${et.value}` <= `${sd.value}T${st.value}`)) { toast('End must be after start', 'error'); return; }
      if (colorId) body.colorId = colorId; else if (e) body.colorId = null; // null = back to the calendar's colour
      if (job) {
        body.extendedProperties = { private: { hydraJob: job.number, hydraJobTitle: job.title } };
        const line = `Job: ${job.number} - ${job.title}`;
        if (!body.description.includes(job.number)) body.description = (line + '\n\n' + body.description).trim();
      }
      if (!e) { for (const k of ['start', 'end']) for (const f of Object.keys(body[k])) if (body[k][f] === null) delete body[k][f]; }
      save.disabled = true;
      try {
        if (e) await gfetch(calUrl(e._cal.id, '/' + e.id), { method: 'PATCH', body });
        else await gfetch(calUrl(cal.value), { method: 'POST', body });
        m.close();
        toast(e ? 'Event updated' : 'Event created');
        load(true);
      } catch (err) { toast(errMsg(err), 'error'); save.disabled = false; }
    } },
      field('Title', title),
      field('Calendar', cal),
      h('label', { class: 'check' }, 'All-day', allDay),
      field('Starts', h('div', { class: 'row2' }, sd, st)),
      field('Ends', h('div', { class: 'row2' }, ed, et)),
      field('Location', loc),
      field('Colour', swatches),
      field('Job (optional)', picker),
      field('Notes', notes),
      save);
    drawSwatches();
    const m = modal(e ? 'Edit event' : 'New event', form);
  }

  load();
  const refresh = () => {
    if (document.visibilityState !== 'visible' || isModalOpen()) return;
    if (tokenValid(5 * 60_000)) load(true);
  };
  const timer = setInterval(refresh, 60_000);
  document.addEventListener('visibilitychange', refresh);
  ctx.onLeave(() => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); });
}
