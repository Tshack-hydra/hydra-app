// Calendar: two-week agenda across the person's Google calendars, with create / edit / delete.

import { gfetch, tokenValid } from './google.js';
import { h, store, modal, field, toast, ymd, hhmm, parseYmd, addDays, hm, dayLabel, shortDate, errMsg, spinner, isModalOpen } from './util.js';
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

let weekStart = mondayOf(new Date());
let calendars = null;

async function getCalendars() {
  if (calendars) return calendars;
  const d = await gfetch(`${API}/users/me/calendarList?maxResults=250`);
  calendars = (d.items || []).sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || calName(a).localeCompare(calName(b)));
  return calendars;
}

function descText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'), 'text/html');
  return doc.body.textContent.trim();
}

export function renderCalendar(root, ctx) {
  const rangeLabel = h('span', { class: 'range-label' });
  const chips = h('div', { class: 'chips' });
  const list = h('div', { class: 'agenda' }, spinner());

  ctx.actions(h('button', { class: 'nav-icon tint', 'aria-label': 'New event', onclick: () => eventForm() }, icon('plus')));
  root.append(
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn small icon-only', 'aria-label': 'Previous two weeks', onclick: () => { weekStart = addDays(weekStart, -7); load(); } }, icon('chevron-left')),
      h('button', { class: 'btn small', onclick: () => { weekStart = mondayOf(new Date()); load(); } }, 'Today'),
      h('button', { class: 'btn small icon-only', 'aria-label': 'Next two weeks', onclick: () => { weekStart = addDays(weekStart, 7); load(); } }, icon('chevron-right')),
      rangeLabel),
    chips, list);

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

  async function load(quiet) {
    rangeLabel.textContent = `${shortDate(weekStart)} – ${shortDate(addDays(weekStart, DAYS - 1))}`;
    if (!quiet) list.replaceChildren(spinner());
    try {
      await getCalendars();
      renderChips();
      const hidden = store.get(HIDDEN, []);
      const qs = `?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${encodeURIComponent(weekStart.toISOString())}&timeMax=${encodeURIComponent(addDays(weekStart, DAYS).toISOString())}`;
      const results = await Promise.all(calendars.filter(c => !hidden.includes(c.id)).map(c =>
        gfetch(calUrl(c.id, qs))
          .then(d => (d.items || []).filter(e => e.status !== 'cancelled').map(e => ({ ...e, _cal: c })))
          .catch(() => [])));
      if (ctx.alive) renderAgenda(results.flat());
    } catch (e) {
      if (ctx.alive) list.replaceChildren(h('p', { class: 'error' }, errMsg(e)));
    }
  }

  function renderAgenda(events) {
    const byDay = new Map();
    for (let i = 0; i < DAYS; i++) byDay.set(ymd(addDays(weekStart, i)), []);
    for (const e of events) {
      if (e.start.date) {
        for (let d = parseYmd(e.start.date), end = parseYmd(e.end.date); d < end; d = addDays(d, 1)) byDay.get(ymd(d))?.push(e);
      } else {
        byDay.get(ymd(new Date(e.start.dateTime)))?.push(e);
      }
    }
    const key = e => (e.start.date ? '0' : '1' + e.start.dateTime);
    const today = ymd();
    list.replaceChildren(...[...byDay].map(([k, evs]) =>
      h('section', { class: 'day' + (k === today ? ' today' : '') + (k < today ? ' past' : '') },
        h('h3', {}, dayLabel(parseYmd(k)), k === today ? h('span', { class: 'tag tint' }, 'Today') : null),
        evs.length ? h('div', { class: 'group' }, evs.sort((a, b) => key(a).localeCompare(key(b))).map(eventRow)) : h('p', { class: 'small empty' }, 'Nothing scheduled'))));
    list.querySelector('.today')?.scrollIntoView({ block: 'start' });
  }

  function eventRow(e) {
    // iOS Calendar list style: start time, end time underneath
    const when = e.start.date ? ['All-day'] : [hm(new Date(e.start.dateTime)), h('small', {}, hm(new Date(e.end.dateTime)))];
    return h('button', { class: 'row event', style: { '--c': e._cal.backgroundColor }, onclick: () => showEvent(e) },
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
      field('Job (optional)', picker),
      field('Notes', notes),
      save);
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
