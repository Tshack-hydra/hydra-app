// Hydra Studio app settings. Fill these in once (see README.md → Setup).
// Everything here is safe to ship to the browser: none of these are secrets.

export const CONFIG = {
  // Google Cloud → APIs & Services → Credentials → OAuth 2.0 Client ID (Web application)
  googleClientId: '42372927575-ne1js254mpuor6rqravmstagebtcb4el.apps.googleusercontent.com',

  // Only accounts on this domain can sign in
  workspaceDomain: 'hydradesign.co.uk',

  // The long ID in the Google Sheet's URL: docs.google.com/spreadsheets/d/<THIS PART>/edit
  spreadsheetId: '1xUVPsC0miZgYe_9fUWMwgb2WjP4f5caU9YhM_9ga1r8',

  // How often the Sheets section re-reads the spreadsheet while it's open
  sheetRefreshSeconds: 30,

  // dropbox.com/developers/apps → your app → Settings → App key
  dropboxAppKey: '',

  // Path to the job folders INSIDE Dropbox (not the Mac path). Each person can override
  // it in Settings if the shared folder sits somewhere else in their Dropbox.
  dropboxProjectsPath: '/Hydra Design/Hydra | Projects',

  // Where things are saved inside each job folder
  siteVisitSubfolder: 'Venue Information/Site Visits',
  receiptSubfolder: 'Accommodation, Travel, Food/Receipts',

  // Default Dext "email in" address. Each person can set their own in Settings.
  dextEmail: '',

  // Colour of each person's initials tag in the app. Keep these the same as the chip colours in the
  // spreadsheet's Who drop-down — Google doesn't let apps read those colours, so they're listed here.
  // Colours: gray, red, orange, yellow, green, teal, blue, purple. Anyone not listed shows in gray.
  teamColours: { ALL: 'gray', TS: 'orange', SP: 'green', MR: 'blue', DA: 'purple' },

  // Specialism tags offered for freelancers (people can also type new ones in the app)
  specialisms: ['Lighting', 'Audio', 'Video', 'General Tech'],

  receiptCategories: [
    'Travel', 'Fuel', 'Parking', 'Accommodation', 'Food & Drink',
    'Equipment', 'Consumables', 'Equipment Hire', 'Postage & Courier', 'Other',
  ],
  currencies: ['GBP', 'EUR', 'USD', 'CHF', 'AED', 'CNY'],
};
