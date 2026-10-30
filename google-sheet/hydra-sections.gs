// Hydra Studio – keeps the to-do tabs tidy in the team spreadsheet.
// Paste into the spreadsheet: Extensions → Apps Script. No set-up or permissions needed (simple triggers).
// It only touches tabs whose first row is the "Task | Who | Done | Delete" header.
//
// The Hydra app reads a section heading as: a bold row with only column A filled.
//   • New section: type the name in Task and choose "New section" in Who
//     (or make the name bold with Who empty). The row becomes a clean bold heading.
//   • Section by mistake: type initials in its Who box. It becomes a normal task again.
//   • Delete: ticking the Delete box removes the whole row (rows below move up).

const SECTION_CHOICE = 'new section';

function onEdit(e) {
  const sheet = e.range.getSheet();
  const cols = columns_(sheet);
  if (!cols) return;
  deleteTicked_(sheet, cols, e.range);
  tidy_(sheet, cols);
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
  const cols = { who: col('who'), done: col('done'), del: col('delete') };
  cols.width = Math.max(cols.who, cols.done, cols.del, 1);
  return cols;
}

function deleteTicked_(sheet, cols, edited) {
  if (!cols.del || edited.getColumn() > cols.del || edited.getLastColumn() < cols.del) return;
  const first = Math.max(edited.getRow(), 2);
  const last = edited.getLastRow();
  if (last < first) return;
  const ticks = sheet.getRange(first, cols.del, last - first + 1, 1).getValues();
  for (let i = ticks.length - 1; i >= 0; i--) if (ticks[i][0] === true) sheet.deleteRow(first + i);
}

function tidy_(sheet, cols) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const n = lastRow - 1;
  const values = sheet.getRange(2, 1, n, cols.width).getDisplayValues();
  const weights = sheet.getRange(2, 1, n, 1).getFontWeights();
  const rules = sheet.getRange(2, 1, n, cols.width).getDataValidations();
  // An empty task row to copy the Who dropdown / tick boxes (and their look) from when turning a
  // section back into a task
  const blank = i => !values[i].some((v, c) => c + 1 !== cols.done && c + 1 !== cols.del && String(v).trim());
  const model = rules.findIndex((r, i) => blank(i) && (!cols.who || r[cols.who - 1]) && (!cols.done || r[cols.done - 1]));

  values.forEach((row, i) => {
    const name = String(row[0]).trim();
    if (!name) return;
    const r = i + 2;
    const who = cols.who ? String(row[cols.who - 1]).trim() : '';
    const picked = who.toLowerCase().split(/\s*,\s*/).includes(SECTION_CHOICE);
    const bold = weights[i][0] === 'bold';
    const whoRule = cols.who ? rules[i][cols.who - 1] : null;
    const doneRule = cols.done ? rules[i][cols.done - 1] : null;
    const doneVal = cols.done ? String(row[cols.done - 1]).trim() : '';

    if (picked || (bold && !who && (whoRule || doneRule || doneVal))) {
      makeHeading_(sheet, r, cols);
    } else if (bold && who && cols.who && !whoRule && model >= 0) {
      makeTask_(sheet, r, cols, model + 2);
    }
  });
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

function makeTask_(sheet, r, cols, modelRow) {
  const who = sheet.getRange(r, cols.who).getValue();
  sheet.getRange(r, 1).setFontWeight('normal');
  // copy the empty row's cells as they are (dropdown, tick boxes, alignment), then put the initials back
  [cols.who, cols.done, cols.del].filter(Boolean).forEach(c => sheet.getRange(modelRow, c).copyTo(sheet.getRange(r, c)));
  sheet.getRange(r, cols.who).setValue(who);
}
