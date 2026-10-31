// Line icons drawn in the style of SF Symbols (SF Symbols themselves are licensed for native
// Apple-platform apps only, so they aren't embedded here).

const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  'chevron-left': '<path d="M15 5l-7 7 7 7"/>',
  'chevron-up': '<path d="M5 15l7-7 7 7"/>',
  'chevron-right': '<path d="M9 5l7 7-7 7"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="9.5" r="1.8"/><path d="M21 16l-5-5-9 9"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  location: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10l5-3v10l-5-3"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = 'icon ' + cls;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return span;
}

// Small Google Sheets mark (green sheet, folded corner, white grid) for buttons that open Google Sheets
export function sheetsLogo(cls = '') {
  const span = document.createElement('span');
  span.className = 'icon ' + cls;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<svg viewBox="0 0 24 24"><path fill="#0F9D58" d="M6.5 2h8L20 7.5V20a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/>'
    + '<path fill="#87CEAC" d="M14.5 2v5.5H20z"/>'
    + '<path fill="none" stroke="#fff" stroke-width="1.4" d="M8 11h8.5v7H8zM8 13.4h8.5M8 15.7h8.5M11.5 11v7"/></svg>';
  return span;
}
