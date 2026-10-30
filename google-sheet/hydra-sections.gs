// Hydra Studio – keeps the to-do tabs tidy in the team spreadsheet.
// Paste into the spreadsheet: Extensions → Apps Script. No set-up or permissions needed (simple triggers).
// It only touches tabs whose first row is the "Task | Who | Done" header.
//
// The Hydra app reads a section heading as: a bold row with only column A filled.
//   • New section: type the name in Task and choose "New section" in Who
//     (or make the name bold with Who empty). The row becomes a clean bold heading.
//   • Section by mistake: type initials in its Who box. It becomes a normal task again.
//   • Cleared rows (text deleted) get their Who emptied and their drop-down and Done box back, unticked.
//   • Every task row is 28px tall so the initials chips have room.
//   • The Who column is only as wide as the most initials in any one row.
//   • ALL means everyone, so it never sits with individual initials: picking ALL clears the others,
//     and picking someone while ALL is set replaces ALL.

const SECTION_CHOICE = 'new section';
const ROW_PX = 28; // roomy rows so the initials chips aren't cramped

function onEdit(e) {
  const sheet = e.range.getSheet();
  const cols = columns_(sheet);
  if (!cols) return;
  allOrPeople_(cols, e);
  tidy_(sheet, cols);
}

const initials_ = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const isAll_ = w => w.toUpperCase() === 'ALL';

// One Who box changed: if ALL was just picked keep only ALL; if a person was added to ALL, drop ALL
function allOrPeople_(cols, e) {
  const cell = e.range;
  if (!cols.who || cell.getNumRows() !== 1 || cell.getNumColumns() !== 1 || cell.getColumn() !== cols.who || cell.getRow() < 2) return;
  const now = initials_(cell.getDisplayValue());
  if (now.length < 2 || !now.some(isAll_)) return;
  const hadAll = initials_(e.oldValue).some(isAll_);
  cell.setValue(hadAll ? now.filter(w => !isAll_(w)).join(', ') : 'ALL');
}

function onOpen() {
  SpreadsheetApp.getActive().getSheets().forEach(sheet => {
    const cols = columns_(sheet);
    if (cols) tidy_(sheet, cols);
  });
}

// 1-based column numbers from the header row (0 = not there), or null if this isn't a to-do tab
function columns_(sheet) {
  const header = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0]
    .map(v => String(v).trim().toLowerCase());
  if (header[0] !== 'task') return null;
  const col = name => header.indexOf(name) + 1;
  const cols = { who: col('who'), done: col('done') };
  cols.width = Math.max(cols.who, cols.done, 1);
  return cols;
}

function tidy_(sheet, cols) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const n = lastRow - 1;
  const values = sheet.getRange(2, 1, n, cols.width).getDisplayValues();
  const weights = sheet.getRange(2, 1, n, 1).getFontWeights();
  const rules = sheet.getRange(2, 1, n, cols.width).getDataValidations();
  const blank = i => !values[i].some((v, c) => c + 1 !== cols.done && String(v).trim());
  const hasSetup = i => (!cols.who || rules[i][cols.who - 1]) && (!cols.done || rules[i][cols.done - 1]);
  // An empty task row to copy the Who drop-down / Done box (and their look) from
  const model = values.findIndex((_, i) => blank(i) && hasSetup(i));

  values.forEach((row, i) => {
    const r = i + 2;
    const name = String(row[0]).trim();
    const who = cols.who ? String(row[cols.who - 1]).trim() : '';
    const bold = weights[i][0] === 'bold';
    const doneVal = cols.done ? String(row[cols.done - 1]).trim() : '';

    if (!name) {
      // Text cleared: make it a normal empty row again, and empty its Who
      if (who) { sheet.getRange(r, cols.who).clearContent(); row[cols.who - 1] = ''; }
      if (blank(i) && model >= 0 && model !== i && (!hasSetup(i) || doneVal === 'TRUE' || bold)) makeTask_(sheet, r, cols, model + 2, '');
      return;
    }
    const picked = who.toLowerCase().split(/\s*,\s*/).includes(SECTION_CHOICE);
    // ALL alongside individual initials (e.g. pasted in): ALL wins
    if (!picked && cols.who && initials_(who).length > 1 && initials_(who).some(isAll_)) sheet.getRange(r, cols.who).setValue('ALL');
    const whoRule = cols.who ? rules[i][cols.who - 1] : null;
    const doneRule = cols.done ? rules[i][cols.done - 1] : null;
    if (picked || (bold && !who && (whoRule || doneRule || doneVal))) {
      makeHeading_(sheet, r, cols);
    } else if (cols.who && !whoRule && (who || !bold) && model >= 0) {
      // a section given initials, or a task row without its drop-down: give it the normal task setup
      makeTask_(sheet, r, cols, model + 2, who);
    }
  });

  sheet.setRowHeights(2, n, ROW_PX);
  fitWho_(sheet, cols);
}

function makeHeading_(sheet, r, cols) {
  [cols.who, cols.done].filter(Boolean).forEach(c => {
    const cell = sheet.getRange(r, c);
    cell.clearDataValidations();
    cell.clearContent();
  });
  sheet.getRange(r, 1, 1, cols.width).setBackground(null);
  sheet.getRange(r, 1).setFontWeight('bold').setHorizontalAlignment('left');
}

function makeTask_(sheet, r, cols, modelRow, who) {
  sheet.getRange(r, 1).setFontWeight('normal');
  const done = cols.done ? sheet.getRange(r, cols.done).getValue() : false;
  // copy the empty row's cells as they are (drop-down, tick box, alignment), then put the initials back
  [cols.who, cols.done].filter(Boolean).forEach(c => sheet.getRange(modelRow, c).copyTo(sheet.getRange(r, c)));
  if (cols.who && who) sheet.getRange(r, cols.who).setValue(who);
  if (cols.done && done === true && String(sheet.getRange(r, 1).getValue()).trim()) sheet.getRange(r, cols.done).setValue(true);
}

// Who column: just wide enough for the row with the most initials (about 40px per initials bubble)
function fitWho_(sheet, cols) {
  if (!cols.who) return;
  const lastRow = sheet.getLastRow();
  const whos = sheet.getRange(2, cols.who, lastRow - 1, 1).getDisplayValues();
  let most = 1;
  whos.forEach(([v]) => {
    const n = String(v).split(',').filter(s => s.trim() && s.trim().toLowerCase() !== SECTION_CHOICE).length;
    if (n > most) most = n;
  });
  const px = 46 + 40 * most;
  if (sheet.getColumnWidth(cols.who) !== px) sheet.setColumnWidth(cols.who, px);
}
