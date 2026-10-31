# Project: Hydra Studio app (internal PWA for Hydra Design)

Phone app (3× iPhone, 1× Android) with Calendar, live Google Sheets, Site Visits and Receipts.
Setup steps for Google / Dropbox / Dext / hosting are in `README.md`.

## Conventions
- Plain HTML + ES modules, **no build step, no npm** (Node isn't installed). Don't add a bundler or framework.
- DOM is built with `h(tag, attrs, ...children)` from `js/util.js`. Use `fill(el, ...)` instead of
  `el.replaceChildren(...)` whenever a child might be null/false or an array — the native one prints "null".
- One module per section (`calendar.js`, `tasks.js`, `sheets.js`, `sitevisits.js`, `receipts.js`, `settings.js`);
  each exports `renderX(root, ctx)`. Timers/listeners must be cleared via `ctx.onLeave(fn)`; check
  `ctx.alive` after awaits.
- Shared settings live in `config.js`; per-person settings in localStorage via `store` (`hydra.*` keys).
- When adding a file, also add it to the `SHELL` list in `sw.js` and to the `cp` line in
  `.github/workflows/publish.yml` (only listed files are published).

## Publishing & updates
- Public GitHub repo → GitHub Pages via `.github/workflows/publish.yml` on every push to `main`.
- The workflow replaces `__BUILD__` in `sw.js` with the short commit id; that byte change is what makes
  installed apps detect an update. Keep the placeholder. The new SW waits; `app.js` shows the
  "New version available" banner and only reloads after the person taps Update (SKIP_WAITING message).
- Service workers don't run in the Claude browser pane; test update flow with headless Chrome.

## Design: follow Apple's Human Interface Guidelines (iOS 26 / Liquid Glass)
- Colours: only the CSS tokens in `styles.css` `:root` (iOS system colours with dark + Increase
  Contrast variants). One tint (`--tint` = Hydra ink `#1f1f1d`, white in dark mode; text on it uses `--on-tint`); `--red` only for destructive actions; `--green` = done.
- Type: `rem` = Body (17pt), driven by `font: -apple-system-body` so Dynamic Type works. Large title
  34 bold, section titles 20 semibold, secondary text 15, footnotes 13. No weights lighter than Regular.
- Hit targets ≥ 44×44. Buttons are capsules with a pressed state; one prominent (`.btn.primary`) per view.
- Navigation: tab bar = top-level sections only (one-word labels, filled icons, floating glass).
  Page actions go in the nav bar via `ctx.actions(...)` as `.nav-icon` circles (max ~3).
- Lists: inset grouped `.group` with `.row`s, chevron (`icon('chevron-right','chev')`) when a row opens something.
- Sheets: `modal()` moves a form's submit button to top-trailing, adds Cancel top-leading, grabber,
  swipe-down dismiss and a discard-changes check. Give long submit labels a short `data-bar` label.
- Branding: the HYDRA wordmark (`icons/hydra-wordmark.png`) is used as a CSS mask via `.wordmark`, so it
  follows the text colour. Use it on the sign-in screen, the Settings footer, and fixed top-leading in the nav bar on every screen (`.nav-logo`; the person asked for it). Not as the nav-bar title.
- Icons: `js/icons.js` (SF-Symbols-style line icons). No emoji in UI. SF Symbols themselves aren't licensed for web.
- Respect Reduce Motion / Reduce Transparency / Increase Contrast; errors stay until tapped.

## Integrations
- No server. Google: OAuth implicit **redirect** flow (pop-ups fail in iOS home-screen apps), token lasts 1h,
  `ensureFresh()` renews on navigation. Scopes: calendar, spreadsheets, gmail.send, openid/email/profile.
- Dropbox: PKCE with refresh token, each person connects their own account. API paths are inside Dropbox,
  default `/Hydra Design/Hydra | Projects` (Mac path: `~/Dropbox/Hydra Design/Hydra | Projects`).
  `Dropbox-API-Arg` header must be ASCII-escaped (`argHeader`).
- Job folders: `H-01886 - Client x Partner | Extra`. Skip `H-00000` (template) and `Archived Projects`
  (searchable on demand). Folder names on macOS are NFD — normalise before comparing text.
- Dext has no public API: receipts are emailed via Gmail to each person's Dext email-in address.

## Sheets rules (TO DO LIST style, ≤3 columns → list view)
- Bold row with only column A = section heading; column B = initials (`SP/TS`, `ALL`); green fill = done.
- Optional header row `Task | Who | Done` (the table = columns up to the first blank header cell;
  anything to the right, e.g. instructions in column E, is ignored by the app). People remove tasks by clearing
  the text or deleting the row in Sheets. Rows with no Task text aren't shown.
- Header row: the Done column holds tick boxes and the sheet's conditional
  formatting paints ticked rows green. Ticked OR green = done. Tick-box cells read TRUE/FALSE on every row,
  so `parseList` ignores that column when finding headings/empty rows; headings have no tick box.
- Who is a multi-select chip dropdown (set in the Sheets UI — the API can't set or see that flag, so never
  re-create the B column rule via the API). Write initials as `TS, MR` (`formatWho`).
- `google-sheet/hydra-sections.gs` is the spreadsheet's Apps Script (onEdit, simple trigger): "New section" in Who
  (or a bold name with Who empty) → clean heading; initials typed on a heading → back to a task; cleared rows get
  their drop-down/tick box back; Who column width = 46px + 40px per initial in the busiest row. It lives in the
  sheet (Extensions → Apps Script), so after editing the file, paste it in again. Each section heading (except
  the first under the header) has a totally blank gap row above it (no validation); the script adds it and deletes
  it (and the cleared heading) when the heading goes. The app's New section writes the same gap (`gapReqs`).
  The instructions are one merged cell (E2:E12) so whole-row inserts/deletes don't scatter them. Keep the app's `headingReqs`
  producing the same result.
- Sheets has no table view any more: every tab is a list (extra columns show as small text).
- Initials tags use `CONFIG.teamColours` (Google's chip palette, `.tag-*` in styles.css). The Sheets API doesn't
  expose drop-down chip colours, so update that map when someone joins or a chip colour changes.
- Done tasks stay visible with a `--green-soft` row tint (no strikethrough); the toggle reads Hide Done / Show Done.
- `tasks.js` reuses `sheets.js` exports (`parseList`, `isListTab`, `guardedWrite`, `setDone`, `insertTask`) across all list tabs.
- Initials: `myInitials()` in `google.js` (Settings value, else from the Google name).
- Every write re-reads the target cell first (`guarded`) and aborts if it changed — keep that for new writes.
- Nothing about tabs is hard-coded; new tabs/columns must keep working.

## Project Crewing (tab of the Hydra sheet, `js/crewing.js`)
- Tab named `PROJECT CREWING` (matched case-insensitively). A project block = grey bold header row (project name in A, a
  date cell per column B… with Sheets' calendar picker: double-click) + crew rows (A = drop-down listing the FREELANCERS
  tab; every booking box has a drop-down **Pencilled / Booked**) + two blank rows.
  Picking either puts the person's name (col A) in the box; **Booked = green, Pencilled = white, empty = not booked.**
  The Apps Script does the name + colour (and re-validates the box with `[name, Pencilled, Booked]` so it never looks invalid).
  The app writes the same (`markReq`). Only Booked reaches the calendar.
- `google-sheet/hydra-crewing.gs` (second file of the sheet's Apps Script; `onEdit` in hydra-sections.gs calls `crewingEdit_`):
  typing a name in A on an empty row spawns the block. `spawnReqs()` in crewing.js writes the identical layout from the app
  (New project / Import) — keep the two in step. Spare crew rows (A has a drop-down, no name) are "slots" the app fills first.
- Date headers are real dates (`num` = days since 30 Dec 1899, read via effectiveValue) or legacy free text ("14th Oct PREP",
  "8th & 11th Jan' 2027"); `parseDates` resolves a missing year to the first date on/after the previous column.
- Views: Days (default) | Sheet (grid) | Calendar (`hydra.crew.view`). Calendar view is read from the Google calendar.
- Google Calendar mirror "Project Crewing": auto-created from the app, shared with the domain (writer), id stored in the
  spreadsheet's developer metadata (`hydraCrewingCalendar`). One all-day event per confirmed person/project/day with a
  deterministic id (so concurrent syncs don't duplicate) and `hydraCrew=1`; synced whenever the view opens and the bookings changed.
- `tasks.js` and the list view skip this tab. A "+ PROJECT CREWING" tab button creates an empty one.

## Freelancers & crew days
- `Freelancers` tab (`js/freelancers.js`): Name | Email | Phone | Specialisms (comma-separated tags; options in
  `CONFIG.specialisms` plus any already used). Shown by the Sheets section as a manager (add / edit / delete). Created from
  the app with Test Dummy 1–10 seed rows. Skipped by Tasks.
- Crewing "Days" view (default): per project, a row per day column; tapping a day picks freelancers (tap cycles confirmed → pencilled → off; uses a spare crew row
  or inserts one). "Sheet" is the raw grid, "Calendar" the month view.
- Import (calendar icon): `inferProjects` groups events by job number (H-12345 in title/description or `hydraJob`),
  else by identical title on ≥2 days; upcoming only; adds a block, or the missing days of a matching project.

## Testing
- Serve with `python3 -m http.server 8080` and open `http://localhost:8080` (Google only accepts `localhost`).
- Without real keys, test by mocking `window.fetch` in the browser and calling `renderX(main, ctx)` directly.
- Real Google/Dropbox/Dext behaviour can only be verified with the configured accounts — say so when handing over.
