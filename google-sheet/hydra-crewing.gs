// Hydra Studio – lays out projects on the PROJECT CREWING tab and handles the booking drop-downs.
// Paste into the spreadsheet as a second file: Extensions → Apps Script → + → Script, name it "hydra-crewing".
// No set-up or permissions needed (it is called from onEdit in hydra-sections.gs, a simple trigger).
// Keep the layout in step with spawnReqs() / markReq() in js/crewing.js: the app builds the same thing.
//
//   • Type a project name in column A on an empty row (the row above it empty too) and it becomes a project:
//       – the name row turns grey and bold, with a date cell in each column to its right. Double-click one for a
//         little calendar (it works for any date, so there is nothing to run out)
//       – under it, 6 crew rows. Column A of each has a drop-down listing the FREELANCERS tab
//       – every booking box to the right has a drop-down: Pencilled or Booked
//       – two blank rows follow, then your next project can go below
//   • Hydra's own people (a company email in the FREELANCERS tab) only get Booked, never Pencilled.
//   • Choosing Pencilled or Booked puts the person's name (column A) in the box. Booked turns it green,
//     Pencilled leaves it white. Delete the box's contents to clear it.
//   • Change the name in column A and the boxes in that row follow.
//   • Rows already holding crew (they have the drop-down) are never treated as a new project.

const CREW_TAB_ = /^project\s*crewing$/i;
const FREELANCER_TAB_ = /^freelancers?$/i;
const CREW_ROWS_ = 6;
const DATE_COLS_ = 7;
const HEAD_GREY_ = '#b7b7b7';
const BOOKED_GREEN_ = '#34a853';
const COMPANY_DOMAIN_ = 'hydradesign.co.uk';
const PENCILLED_ = 'Pencilled';
const BOOKED_ = 'Booked';
const LIST_ = SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST;

// Returns true when the edit was on the PROJECT CREWING tab (so the to-do script leaves it alone)
function crewingEdit_(e) {
  const range = e.range;
  const sheet = range.getSheet();
  if (!CREW_TAB_.test(sheet.getName())) return false;
  if (range.getColumn() === 1 && range.getNumRows() === 1 && range.getNumColumns() === 1) nameEdit_(e, sheet, range);
  else if (range.getColumn() > 1) bookingEdit_(sheet, range);
  return true;
}

// ---- column A ----

function nameEdit_(e, sheet, cell) {
  const row = cell.getRow();
  const title = String(cell.getDisplayValue()).trim();
  const rule = cell.getDataValidation();
  if (rule) { renameCrew_(sheet, row, String(e.oldValue || '').trim(), title); return; } // an existing crew row: its boxes follow the new name
  if (!title || cell.getFontWeight() === 'bold') return; // clearing, or an existing heading
  const width = 1 + DATE_COLS_;
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  // must be on its own: nothing else on this row, and the row above is empty (or this is row 1)
  const rowValues = sheet.getRange(row, 1, 1, sheet.getMaxColumns()).getDisplayValues()[0];
  if (rowValues.slice(1).some(v => String(v).trim())) return;
  if (row > 1 && sheet.getRange(row - 1, 1, 1, sheet.getMaxColumns()).getDisplayValues()[0].some(v => String(v).trim())) return;
  spawnProject_(sheet, row, width);
}

// A different freelancer picked in column A: their booked boxes in that row take the new name (or empty if the name was cleared),
// and the row's drop-downs match the person (Hydra employees only get Booked)
function renameCrew_(sheet, row, oldName, newName) {
  const width = sheet.getLastColumn();
  if (width < 2) return;
  const emp = isEmployee_(sheet.getParent(), newName);
  const boxes = sheet.getRange(row, 2, 1, width - 1);
  const values = boxes.getDisplayValues()[0];
  const rules = boxes.getDataValidations()[0];
  values.forEach((v, i) => {
    const rule = rules[i];
    if (!rule || rule.getCriteriaType() !== LIST_) return; // not a booking box
    const box = sheet.getRange(row, 2 + i);
    const val = String(v).trim();
    if (oldName && val === oldName && oldName !== newName) {
      if (newName) { box.setValue(newName); box.setDataValidation(bookRule_(newName, emp)); }
      else resetBox_(box);
    } else {
      box.setDataValidation(bookRule_(val === newName ? newName : '', emp));
    }
  });
}

// Is this person one of Hydra's own (a company email in the FREELANCERS tab)?
function isEmployee_(ss, name) {
  if (!name) return false;
  const people = ss.getSheets().filter(s => FREELANCER_TAB_.test(s.getName()))[0];
  if (!people || people.getLastRow() < 2) return false;
  const rows = people.getRange(2, 1, people.getLastRow() - 1, 2).getDisplayValues();
  const hit = rows.filter(r => String(r[0]).trim().toLowerCase() === name.toLowerCase())[0];
  return !!hit && String(hit[1]).toLowerCase().trim().endsWith('@' + COMPANY_DOMAIN_);
}

function spawnProject_(sheet, row, width) {
  // room for the crew rows and the gap: push anything below down
  sheet.insertRowsAfter(row, CREW_ROWS_ + 2);
  const below = sheet.getRange(row + 1, 1, CREW_ROWS_ + 2, sheet.getMaxColumns());
  below.clear(); // inserted rows copy the row above; start them plain
  below.clearDataValidations();

  const head = sheet.getRange(row, 1, 1, width);
  head.setBackground(HEAD_GREY_).setFontWeight('bold').setHorizontalAlignment('center');

  // a date in each cell to the right of the name; double-click for the calendar
  sheet.getRange(row, 2, 1, width - 1)
    .setNumberFormat('ddd d mmm')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true).setHelpText('Double-click for a calendar').build());

  const crew = sheet.getRange(row + 1, 1, CREW_ROWS_, width);
  crew.setBackground('#ffffff').setFontWeight('normal').setHorizontalAlignment('center');
  sheet.getRange(row + 1, 1, CREW_ROWS_, 1).setHorizontalAlignment('left');
  sheet.getRange(row + 1, 2, CREW_ROWS_, width - 1).setDataValidation(bookRule_(''));

  const people = sheet.getParent().getSheets().filter(s => FREELANCER_TAB_.test(s.getName()))[0];
  if (people) {
    const rule = SpreadsheetApp.newDataValidation().requireValueInRange(people.getRange('A2:A'), true).setAllowInvalid(true).build();
    sheet.getRange(row + 1, 1, CREW_ROWS_, 1).setDataValidation(rule);
  } else {
    SpreadsheetApp.getActive().toast('Add a FREELANCERS tab (Name in column A) to get the crew drop-downs.', 'Project Crewing', 8);
  }
}

// ---- booking boxes ----

// Pencilled / Booked (Hydra employees: Booked only), plus the person's name once chosen so the box never looks invalid
function bookRule_(name, emp) {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList((name ? [name] : []).concat(emp ? [] : [PENCILLED_]).concat([BOOKED_]), true)
    .setAllowInvalid(true).build();
}

function resetBox_(box, emp) {
  box.clearContent();
  box.setBackground('#ffffff');
  box.setDataValidation(bookRule_('', emp));
}

function bookingEdit_(sheet, range) {
  if (range.getNumRows() * range.getNumColumns() > 200) return;
  const rules = range.getDataValidations();
  const values = range.getDisplayValues();
  const greens = range.getBackgrounds();
  const top = range.getRow(), left = range.getColumn();
  const names = {};
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < values[i].length; j++) {
      const rule = rules[i][j];
      if (!rule || rule.getCriteriaType() !== LIST_) continue; // not a booking box (date cells use a different rule)
      const v = String(values[i][j]).trim();
      const box = sheet.getRange(top + i, left + j);
      const picked = v.toLowerCase() === BOOKED_.toLowerCase() ? BOOKED_ : v.toLowerCase() === PENCILLED_.toLowerCase() ? PENCILLED_ : '';
      if (picked) {
        const r = top + i;
        if (!(r in names)) names[r] = String(sheet.getRange(r, 1).getDisplayValue()).trim();
        if (!names[r]) { box.clearContent(); SpreadsheetApp.getActive().toast('Pick a name in column A first.', 'Project Crewing', 5); continue; }
        box.setValue(names[r]);
        box.setBackground(picked === BOOKED_ ? BOOKED_GREEN_ : '#ffffff');
        box.setDataValidation(bookRule_(names[r], isEmployee_(sheet.getParent(), names[r])));
      } else if (!v && greens[i][j] !== '#ffffff') {
        const r = top + i;
        if (!(r in names)) names[r] = String(sheet.getRange(r, 1).getDisplayValue()).trim();
        resetBox_(box, isEmployee_(sheet.getParent(), names[r])); // cleared: back to white, ready for a new choice
      }
    }
  }
}
