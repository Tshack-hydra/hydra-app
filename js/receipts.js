// Receipts: photo + job number → emailed to the person's Dext "email in" address (from their own
// Gmail) and a copy saved to <job>/Accommodation, Travel, Food/Receipts/ in Dropbox.

import { CONFIG } from '../config.js';
import { h, fill, store, field, toast, errMsg, ymd, safeName, compressImage, blobToBase64, shortDate, parseYmd } from './util.js';
import { sendEmail, currentUser } from './google.js';
import * as dbx from './dropbox.js';
import { jobPicker, connectDropboxPrompt } from './jobs.js';
import { icon } from './icons.js';

const HISTORY = 'hydra.receipts';
export const dextEmail = () => store.get('hydra.dextEmail') || CONFIG.dextEmail;
const symbol = c => ({ GBP: '£', EUR: '€', USD: '$' }[c] || c + ' ');

export function renderReceipts(root) {
  if (!dbx.isConnected()) { root.append(connectDropboxPrompt()); return; }
  if (!dextEmail()) {
    root.append(h('div', { class: 'card warn' }, 'Add your Dext email-in address in ', h('a', { href: '#/settings' }, 'Settings'), ' so receipts reach Dext. Until then they are only saved to Dropbox.'));
  }

  let photo = null;
  let job = null;
  let sent = { dext: false, dropbox: false };

  const preview = h('div', { class: 'receipt-preview empty' }, h('span', {}, 'Take a photo of the receipt'));
  const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden', onchange: () => setPhoto(cam.files[0]) });
  const lib = h('input', { type: 'file', accept: 'image/*,application/pdf', class: 'hidden', onchange: () => setPhoto(lib.files[0]) });
  function setPhoto(f) {
    if (!f) return;
    photo = f;
    sent = { dext: false, dropbox: false };
    preview.classList.remove('empty');
    preview.replaceChildren(f.type === 'application/pdf' ? h('span', { class: 'row-main' }, icon('doc'), f.name) : h('img', { src: URL.createObjectURL(f), alt: 'Receipt' }));
    cam.value = ''; lib.value = '';
  }

  const picker = jobPicker({ onChange: j => { job = j; }, required: true });
  const date = h('input', { type: 'date', value: ymd() });
  const supplier = h('input', { type: 'text', placeholder: 'e.g. Shell, Premier Inn' });
  const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00' });
  const currency = h('select', {}, CONFIG.currencies.map(c => h('option', { value: c }, c)));
  const category = h('select', {}, CONFIG.receiptCategories.map(c => h('option', { value: c }, c)));
  const paid = h('select', {}, ['Company card', 'Personal (to reclaim)', 'Cash'].map(c => h('option', { value: c }, c)));
  const notes = h('textarea', { rows: 2, placeholder: 'What was it for?' });
  const status = h('div', { class: 'status-list' });
  const submit = h('button', { class: 'btn primary block big', type: 'submit' }, 'Send receipt');
  const historyEl = h('div', {});

  const form = h('form', { class: 'form', onsubmit: async e => {
    e.preventDefault();
    if (!photo) { toast('Take a photo of the receipt first', 'error'); return; }
    if (!job) { toast('Pick the job number', 'error'); return; }
    const amt = amount.value.replace(/[^\d.,-]/g, '').replace(',', '.');
    if (!amt || isNaN(Number(amt))) { toast('Enter the amount', 'error'); amount.focus(); return; }
    submit.disabled = true;
    status.replaceChildren();
    const line = (text, cls = '') => { const el = h('div', { class: cls }, text); status.append(el); return el; };

    const total = `${symbol(currency.value)}${Number(amt).toFixed(2)}`;
    const user = currentUser();
    const base = safeName(`${date.value} - ${supplier.value.trim() || 'Receipt'} - ${currency.value} ${Number(amt).toFixed(2)}`);
    try {
      const isPdf = photo.type === 'application/pdf';
      const blob = isPdf ? photo : await compressImage(photo, 2200, 0.85);
      const ext = isPdf ? 'pdf' : 'jpg';

      if (!sent.dext && dextEmail()) {
        const l = line('Sending to Dext…');
        await sendEmail({
          to: dextEmail(),
          subject: `${job.number} | ${supplier.value.trim() || 'Receipt'} | ${total}`,
          text: [
            `Job: ${job.number} - ${job.title}`,
            `Date: ${date.value}`,
            `Supplier: ${supplier.value.trim()}`,
            `Amount: ${total} (${currency.value})`,
            `Category: ${category.value}`,
            `Paid by: ${paid.value}`,
            `Submitted by: ${user?.name || ''} <${user?.email || ''}>`,
            notes.value.trim() ? `Notes: ${notes.value.trim()}` : '',
          ].filter(Boolean).join('\n'),
          attachments: [{ name: `${job.number} - ${base}.${ext}`, type: blob.type || 'image/jpeg', base64: await blobToBase64(blob) }],
        });
        sent.dext = true;
        l.textContent = '✓ Sent to Dext';
        l.className = 'ok';
      }
      if (!sent.dropbox) {
        const l = line('Saving to Dropbox…');
        await dbx.upload(`${job.path}/${CONFIG.receiptSubfolder}/${base}.${ext}`, blob);
        sent.dropbox = true;
        l.textContent = `✓ Saved to ${job.number} / ${CONFIG.receiptSubfolder}`;
        l.className = 'ok';
      }
      store.set(HISTORY, [{
        at: Date.now(), date: date.value, job: job.number, jobTitle: job.title, supplier: supplier.value.trim(), total, category: category.value, dext: sent.dext,
      }, ...store.get(HISTORY, [])].slice(0, 50));
      toast('Receipt done');
      photo = null; sent = { dext: false, dropbox: false };
      preview.classList.add('empty');
      preview.replaceChildren(h('span', {}, 'Take a photo of the receipt'));
      supplier.value = ''; amount.value = ''; notes.value = '';
      submit.textContent = 'Send receipt';
      drawHistory();
    } catch (err) {
      line('✕ ' + errMsg(err), 'error');
      submit.textContent = 'Try again';
    }
    submit.disabled = false;
  } },
    preview,
    h('div', { class: 'row2' },
      h('button', { type: 'button', class: 'btn', onclick: () => cam.click() }, icon('camera'), 'Camera'),
      h('button', { type: 'button', class: 'btn', onclick: () => lib.click() }, icon('photo'), 'Library')),
    cam, lib,
    field('Job', picker),
    h('div', { class: 'row2' }, field('Date', date), field('Supplier', supplier)),
    h('div', { class: 'row2' }, field('Amount', amount), field('Currency', currency)),
    h('div', { class: 'row2' }, field('Category', category), field('Paid with', paid)),
    field('Notes', notes),
    submit, status);

  function drawHistory() {
    const items = store.get(HISTORY, []);
    fill(historyEl,
      h('h3', { class: 'section-title' }, 'Sent from this phone'),
      items.length ? h('div', { class: 'group' }, items.slice(0, 20).map(r => h('div', { class: 'row hist' },
        h('span', { class: 'row-main' },
          h('span', {}, h('b', {}, r.job), ' ', r.supplier || r.category),
          h('small', {}, shortDate(parseYmd(r.date)) + (r.dext ? ' · Sent to Dext' : ' · Dropbox only'))),
        h('span', { class: 'amt' }, r.total))))
        : h('p', { class: 'muted small', style: { padding: '0 16px' } }, 'Nothing yet.'));
  }
  drawHistory();
  root.append(form, historyEl);
}
