// Hydra Studio – tidies section headings in the team spreadsheet.
// Paste into the spreadsheet: Extensions → Apps Script. No set-up or permissions needed (simple triggers).
//
// The Hydra app reads a section heading as: a bold row with only column A filled.
// People editing the sheet can make one either way:
//   • type the name in Task and choose "New section" in Who, or
//   • type the name in Task and make it bold (with Who left empty).
// This script then turns the row into a proper heading: bold, no Who dropdown, no Done tick box.
// It only touches tabs whose first row is the "Task | Who | Done" header.

const SECTION_CHOICE = 'new section';

function onEdit(e) {
  tidy_(e.range.getSheet());
}

function onOpen() {
  SpreadsheetApp.getActive().getSheets().forEach(tidy_);
}

function tidy_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const header = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0]
    .map(v => String(v).trim().toLowerCase());
  if (header[0] !== 'task') return;
  const whoCol = header.indexOf('who') + 1;   // 1-based, 0 = none
  const doneCol = header.indexOf('done') + 1;
  const width = Math.max(whoCol, doneCol, 2);

  const range = sheet.getRange(2, 1, lastRow - 1, width);
  const values = range.getDisplayValues();
  const weights = sheet.getRange(2, 1, lastRow - 1, 1).getFontWeights();
  const rules = range.getDataValidations();

  values.forEach((row, i) => {
    const name = String(row[0]).trim();
    if (!name) return;
    const who = whoCol ? String(row[whoCol - 1]).trim() : '';
    const picked = who.toLowerCase().split(/\s*,\s*/).includes(SECTION_CHOICE);
    const boldAlone = weights[i][0] === 'bold' && !who;
    if (!picked && !boldAlone) return;
    // Already a clean heading? (nothing after column A, no dropdown/tick box left)
    const leftovers = rules[i].slice(1).some(Boolean) || row.slice(1).some(v => String(v).trim());
    if (!picked && !leftovers) return;
    const r = i + 2;
    const rest = sheet.getRange(r, 2, 1, width - 1);
    rest.clearDataValidations();
    rest.clearContent();
    sheet.getRange(r, 1, 1, width).setBackground(null);
    sheet.getRange(r, 1).setFontWeight('bold').setHorizontalAlignment('left');
  });
}
