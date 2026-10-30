// Site visits: notes + photos saved straight into the job's Dropbox folder:
//   <job>/Venue Information/Site Visits/<date> - <title>/
//     <date> - <title> - 01.jpg …, Site Visit Notes.txt (for humans), site-visit.json (for the app)

import { CONFIG } from '../config.js';
import { h, fill, store, modal, field, toast, errMsg, spinner, ymd, parseYmd, dayLabel, safeName, compressImage } from './util.js';
import * as dbx from './dropbox.js';
import { currentUser } from './google.js';
import { jobPicker, connectDropboxPrompt } from './jobs.js';
import { icon } from './icons.js';

const visitsRoot = job => `${job.path}/${CONFIG.siteVisitSubfolder}`;
const isImage = name => /\.(jpe?g|png|heic|webp|gif)$/i.test(name);

const NOTE_FIELDS = [
  ['address', 'Venue address', 'input'],
  ['attendees', 'Who attended', 'input'],
  ['contacts', 'Venue / client contacts', 'textarea'],
  ['access', 'Access & load-in', 'textarea'],
  ['power', 'Power', 'textarea'],
  ['rigging', 'Rigging & structure', 'textarea'],
  ['dimensions', 'Dimensions & heights', 'textarea'],
  ['notes', 'General notes', 'textarea'],
];

function notesText(d) {
  const lines = [
    `SITE VISIT — ${d.title}`,
    `Job: ${d.job} - ${d.jobTitle}`,
    `Date: ${d.date}`,
    `Recorded by: ${d.by}`,
    '',
  ];
  for (const [k, label] of NOTE_FIELDS) if (d[k]) lines.push(label.toUpperCase(), d[k], '');
  if (d.photos?.length) lines.push(`PHOTOS (${d.photos.length})`, ...d.photos, '');
  return lines.join('\n');
}

// Lets a person add photos either from the camera or their library; returns { el, photos }
function photoPicker() {
  const photos = [];
  const thumbs = h('div', { class: 'thumbs' });
  const add = files => { for (const f of files) photos.push({ file: f, url: URL.createObjectURL(f), done: false }); draw(); };
  const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden', onchange: () => { add(cam.files); cam.value = ''; } });
  const lib = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hidden', onchange: () => { add(lib.files); lib.value = ''; } });
  function draw() {
    thumbs.replaceChildren(...photos.map((p, i) => h('div', { class: 'thumb' + (p.done ? ' done' : '') },
      h('img', { src: p.url, alt: '' }),
      p.done ? h('span', { class: 'badge' }, '✓') : h('button', { type: 'button', class: 'remove', 'aria-label': 'Remove photo', onclick: () => { URL.revokeObjectURL(p.url); photos.splice(i, 1); draw(); } }, '✕'))));
  }
  const el = h('div', {},
    h('div', { class: 'row2' },
      h('button', { type: 'button', class: 'btn', onclick: () => cam.click() }, icon('camera'), 'Camera'),
      h('button', { type: 'button', class: 'btn', onclick: () => lib.click() }, icon('photo'), 'Library')),
    cam, lib, thumbs);
  return { el, photos, draw };
}

async function uploadPhotos(folder, base, photos, startNo, progress) {
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (p.done) continue;
    progress(`Uploading photo ${i + 1} of ${photos.length}…`);
    const blob = await compressImage(p.file, 2400, 0.85);
    const res = await dbx.upload(`${folder}/${base} - ${String(startNo + i).padStart(2, '0')}.jpg`, blob);
    p.done = true;
    p.name = res.name;
  }
}

export function renderSiteVisits(root, ctx) {
  if (!dbx.isConnected()) { root.append(connectDropboxPrompt()); return; }
  let job = store.get('hydra.visits.lastJob');
  const newVisit = () => visitForm(job, saved => { if (saved.path === job?.path) load(); });
  ctx.actions(h('button', { class: 'nav-icon tint', 'aria-label': 'New site visit', onclick: newVisit }, icon('plus')));
  ctx.onRefresh(() => load());
  const listEl = h('div', { class: 'visit-list' });
  const picker = jobPicker({ value: job, onChange: j => { job = j; store.set('hydra.visits.lastJob', j); load(); } });

  root.append(
    h('button', { class: 'btn primary block big', onclick: newVisit }, icon('plus'), 'New Site Visit'),
    h('h3', { class: 'section-title' }, 'Past site visits'),
    picker, listEl);

  async function load() {
    if (!job) { listEl.replaceChildren(h('p', { class: 'muted' }, 'Choose a job to see its site visits.')); return; }
    listEl.replaceChildren(spinner());
    try {
      let entries = [];
      try { entries = await dbx.listFolderAll(visitsRoot(job)); } catch (e) { if (!dbx.isNotFound(e)) throw e; }
      if (!ctx.alive) return;
      const folders = entries.filter(e => e['.tag'] === 'folder').sort((a, b) => b.name.localeCompare(a.name));
      listEl.replaceChildren(...(folders.length
        ? [h('div', { class: 'group' }, folders.map(f => h('button', { class: 'row', onclick: () => showVisit(job, f) }, h('span', { class: 'row-main' }, f.name), icon('chevron-right', 'chev'))))]
        : [h('p', { class: 'muted' }, 'No site visits saved for this job yet.')]));
    } catch (e) {
      listEl.replaceChildren(h('p', { class: 'error' }, errMsg(e)));
    }
  }
  load();
}

function visitForm(initialJob, onSaved) {
  let job = initialJob;
  const picker = jobPicker({ value: job, onChange: j => { job = j; }, required: true });
  const date = h('input', { type: 'date', value: ymd() });
  const title = h('input', { type: 'text', placeholder: 'e.g. Recce – main hall', required: true });
  const inputs = Object.fromEntries(NOTE_FIELDS.map(([k, , kind]) => [k, kind === 'input' ? h('input', { type: 'text' }) : h('textarea', { rows: 3 })]));
  const pics = photoPicker();
  const progress = h('p', { class: 'muted small' });
  const save = h('button', { class: 'btn primary block', type: 'submit' }, 'Save site visit');
  let savedData = null;

  const form = h('form', { class: 'form', onsubmit: async e => {
    e.preventDefault();
    if (!job) { toast('Pick a job first', 'error'); return; }
    if (!title.value.trim()) { title.focus(); return; }
    save.disabled = true;
    const base = safeName(`${date.value} - ${title.value.trim()}`);
    const folder = `${visitsRoot(job)}/${base}`;
    try {
      await uploadPhotos(folder, base, pics.photos, 1, t => { progress.textContent = t; });
      pics.draw();
      progress.textContent = 'Saving notes…';
      const user = currentUser();
      savedData = {
        job: job.number, jobTitle: job.title, date: date.value, title: title.value.trim(),
        ...Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()])),
        by: user?.name || user?.email || '', photos: pics.photos.map(p => p.name), savedAt: new Date().toISOString(),
      };
      await dbx.upload(`${folder}/Site Visit Notes.txt`, new Blob([notesText(savedData)], { type: 'text/plain' }), { overwrite: true });
      await dbx.upload(`${folder}/site-visit.json`, new Blob([JSON.stringify(savedData, null, 2)], { type: 'application/json' }), { overwrite: true });
      m.close();
      toast('Site visit saved to Dropbox');
      onSaved(job);
    } catch (err) {
      progress.textContent = '';
      toast(errMsg(err), 'error');
      save.disabled = false;
      save.textContent = 'Try again (already-uploaded photos are kept)';
    }
  } },
    field('Job', picker),
    h('div', { class: 'row2' }, field('Date', date), field('Visit title', title)),
    field('Photos', pics.el),
    NOTE_FIELDS.map(([k, label]) => field(label, inputs[k])),
    progress, save);
  const m = modal('New site visit', form, { full: true });
}

async function showVisit(job, folder) {
  const body = h('div', {}, spinner());
  const m = modal(folder.name, body, { full: true });
  try {
    const entries = await dbx.listFolderAll(folder.path_display);
    const images = entries.filter(e => e['.tag'] === 'file' && isImage(e.name)).sort((a, b) => a.name.localeCompare(b.name));
    let data = null;
    if (entries.some(e => e.name === 'site-visit.json')) {
      try { data = JSON.parse(await dbx.downloadText(`${folder.path_display}/site-visit.json`)); } catch { /* notes missing or edited by hand */ }
    }
    const grid = h('div', { class: 'thumbs big' });
    const add = photoPicker();
    const progress = h('p', { class: 'muted small' });
    fill(body,
      data ? h('div', { class: 'card' },
        h('p', {}, h('b', {}, dayLabel(parseYmd(data.date))), data.by ? ` · ${data.by}` : ''),
        NOTE_FIELDS.filter(([k]) => data[k]).map(([k, label]) => h('div', { class: 'note' }, h('small', { class: 'field-label' }, label), h('p', { class: 'pre' }, data[k])))) : null,
      h('h3', { class: 'section-title' }, `Photos (${images.length})`),
      grid,
      h('h3', { class: 'section-title' }, 'Add more photos'),
      add.el, progress,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: async () => {
          if (!add.photos.length) { toast('Add some photos first'); return; }
          try {
            const base = safeName(folder.name);
            await uploadPhotos(folder.path_display, base, add.photos, images.length + 1, t => { progress.textContent = t; });
            m.close();
            toast('Photos added');
            showVisit(job, folder);
          } catch (err) { progress.textContent = ''; toast(errMsg(err), 'error'); }
        } }, 'Upload photos'),
        h('a', { class: 'btn', href: dbx.webLink(folder.path_display), target: '_blank', rel: 'noopener' }, 'Open in Dropbox')));
    // Load thumbnails a few at a time
    const cells = images.map(img => {
      const el = h('button', { class: 'thumb', onclick: async () => {
        try { const link = await dbx.tempLink(img.path_display); modal(img.name, h('img', { class: 'full-img', src: link, alt: img.name }), { full: true }); }
        catch (err) { toast(errMsg(err), 'error'); }
      } }, h('span', { class: 'spin' }));
      grid.append(el);
      return [img, el];
    });
    const queue = [...cells];
    const worker = async () => {
      while (queue.length) {
        const [img, el] = queue.shift();
        try { el.replaceChildren(h('img', { src: await dbx.thumbnail(img.path_display), alt: img.name })); }
        catch { el.replaceChildren(h('small', {}, img.name)); }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } catch (e) {
    body.replaceChildren(h('p', { class: 'error' }, errMsg(e)));
  }
}
