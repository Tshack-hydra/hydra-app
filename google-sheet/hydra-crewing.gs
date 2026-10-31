// Hydra Studio – lays out projects on the PROJECT CREWING tab.
// Paste into the spreadsheet as a second file: Extensions → Apps Script → + → Script, name it "hydra-crewing".
// No set-up or permissions needed (it is called from onEdit in hydra-sections.gs, a simple trigger).
// Keep the layout in step with spawnReqs() in js/crewing.js: the app builds the same thing.
//
//   • Type a project name in column A on an empty row (the row above it empty too) and it becomes a project:
//       – the name row turns grey and bold, with a date drop-down (date picker) in each column to its right
//       – under it, 6 crew rows. Column A of each has a drop-down listing the FREELANCERS tab
//       – two blank rows follow, then your next project can go below
//   • Colour a crew cell green = that person is CONFIRMED for that date. Text without green = pencilled in.
//   • Rows already holding crew (they have the drop-down) are never treated as a new project.

const CREW_TAB_ = /^project\s*crewing$/i;
const FREELANCER_TAB_ = /^freelancers?$/i;
const CREW_ROWS_ = 6;
const DATE_COLS_ = 7;
const HEAD_GREY_ = '#b7b7b7';

function crewingEdit_(e) {
  const cell = e.range;
  const sheet = cell.getSheet();
  if (!CREW_TAB_.test(sheet.getName())) return false;
  if (cell.getNumRows() !== 1 || cell.getNumColumns() !== 1 || cell.getColumn() !== 1) return true;
  const row = cell.getRow();
  const title = String(cell.getDisplayValue()).trim();
  if (!title || cell.getDataValidation() || cell.getFontWeight() === 'bold') return true; // clearing, or an existing heading/crew row
  const width = 1 + DATE_COLS_;
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  // must be on its own: nothing else on this row, and the row above is empty (or this is row 1)
  const rowValues = sheet.getRange(row, 1, 1, sheet.getMaxColumns()).getDisplayValues()[0];
  if (rowValues.slice(1).some(v => String(v).trim())) return true;
  if (row > 1 && sheet.getRange(row - 1, 1, 1, sheet.getMaxColumns()).getDisplayValues()[0].some(v => String(v).trim())) return true;

  spawnProject_(sheet, row, width);
  return true;
}

function spawnProject_(sheet, row, width) {
  // room for the crew rows and the gap: push anything below down
  sheet.insertRowsAfter(row, CREW_ROWS_ + 2);
  const below = sheet.getRange(row + 1, 1, CREW_ROWS_ + 2, sheet.getMaxColumns());
  below.clear(); // inserted rows copy the row above; start them plain
  below.clearDataValidations();

  const head = sheet.getRange(row, 1, 1, width);
  head.setBackground(HEAD_GREY_).setFontWeight('bold').setHorizontalAlignment('center');

  const dates = sheet.getRange(row, 2, 1, width - 1);
  dates.setNumberFormat('ddd d mmm')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true).build());

  const crew = sheet.getRange(row + 1, 1, CREW_ROWS_, width);
  crew.setBackground('#ffffff').setFontWeight('normal').setHorizontalAlignment('center');
  sheet.getRange(row + 1, 1, CREW_ROWS_, 1).setHorizontalAlignment('left');

  const people = sheet.getParent().getSheets().filter(s => FREELANCER_TAB_.test(s.getName()))[0];
  if (people) {
    const rule = SpreadsheetApp.newDataValidation().requireValueInRange(people.getRange('A2:A'), true).setAllowInvalid(true).build();
    sheet.getRange(row + 1, 1, CREW_ROWS_, 1).setDataValidation(rule);
  } else {
    SpreadsheetApp.getActive().toast('Add a FREELANCERS tab (Name in column A) to get the crew drop-downs.', 'Project Crewing', 8);
  }
}
