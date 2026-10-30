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
  follows the text colour. Use it on the sign-in screen and Settings footer only, not as a nav-bar title (HIG).
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
  sheet (Extensions → Apps Script), so after editing the file, paste it in again. Keep the app's `headingReqs`
  producing the same result.
- Sheets has no table view any more: every tab is a list (extra columns show as small text).
- Initials tags use `CONFIG.teamColours` (Google's chip palette, `.tag-*` in styles.css). The Sheets API doesn't
  expose drop-down chip colours, so update that map when someone joins or a chip colour changes.
- Done tasks stay visible with a `--green-soft` row tint (no strikethrough); the toggle reads Hide Done / Show Done.
- `tasks.js` reuses `sheets.js` exports (`parseList`, `isListTab`, `guardedWrite`, `setDone`, `insertTask`) across all list tabs.
- Initials: `myInitials()` in `google.js` (Settings value, else from the Google name).
- Every write re-reads the target cell first (`guarded`) and aborts if it changed — keep that for new writes.
- Nothing about tabs is hard-coded; new tabs/columns must keep working.

## Testing
- Serve with `python3 -m http.server 8080` and open `http://localhost:8080` (Google only accepts `localhost`).
- Without real keys, test by mocking `window.fetch` in the browser and calling `renderX(main, ctx)` directly.
- Real Google/Dropbox/Dext behaviour can only be verified with the configured accounts — say so when handing over.
