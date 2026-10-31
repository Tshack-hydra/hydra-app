# Hydra Studio app

A phone app for the Hydra team (iPhone and Android) with five sections:

| Section | What it does | Where data lives |
|---|---|---|
| **Calendar** | Day agenda (today first, arrow loads earlier days) or month grid across your Google calendars; create, edit and delete events and tag them with a job | Google Calendar |
| **Tasks** | Every open task assigned to you (or `ALL`) across all the to-do tabs, in one list. Tick to mark done, + to add. *Everyone* shows the whole team's open tasks | Google Sheets (to-do tabs) |
| **Sheets → Project Crewing** | The crew sheet (people × dates per project) as a tidy grid, or as a month calendar. Tap a cell to book / un-book someone. Also mirrored into a shared Google calendar called *Project Crewing* | Google Sheets + Calendar |
| **Sheets** | A live view of every tab in the Hydra spreadsheet. New tabs, rows and columns show up within about 30 seconds. Anyone can edit | Google Sheets |
| **Site Visits** | Photos and notes from a site visit, saved into the job folder | Dropbox → `<job>/Venue Information/Site Visits/<date> - <title>/` |
| **Receipts** | Photo of a receipt + job number, sent to Dext, with a copy kept in Dropbox | Dext + Dropbox → `<job>/Accommodation, Travel, Food/Receipts/` |

It's a web app (PWA) that you add to the phone's home screen. There's no App Store and no server.
Everything talks straight to Google and Dropbox online, so **no computer needs to be left on**.

---

## One-time setup (about 30 minutes)

### 1. Google (sign in as Studio@hydradesign.co.uk)

1. Go to <https://console.cloud.google.com> → project picker → **New project** → name it `Hydra Studio App`.
2. **APIs & Services → Library**: enable **Google Calendar API**, **Google Sheets API** and **Gmail API**.
3. **Google Auth Platform → Branding / Audience** (called "OAuth consent screen" on older screens):
   - User type: **Internal**. Only @hydradesign.co.uk accounts can then use the app, and Google doesn't need to review it.
   - App name `Hydra Studio`, support email Studio@hydradesign.co.uk.
   - **Data access → Add scopes**: `.../auth/calendar`, `.../auth/spreadsheets`, `.../auth/gmail.send`, plus `openid`, `email`, `profile`.
4. **Clients → Create client → Web application**:
   - *Authorised JavaScript origins*: `http://localhost:8080` and, once hosted (step 5), `https://YOUR-SITE`
   - *Authorised redirect URIs*: `http://localhost:8080/` and `https://YOUR-SITE/` (the trailing `/` matters)
   - Copy the **Client ID** (ends in `.apps.googleusercontent.com`) into `googleClientId` in `config.js`.
5. Open the team spreadsheet and copy the ID from its URL
   (`docs.google.com/spreadsheets/d/`**`THIS-PART`**`/edit`) into `spreadsheetId`.
   Share the sheet with everyone at hydradesign.co.uk as **Editor**.

### 2. Dropbox

1. Go to <https://www.dropbox.com/developers/apps> → **Create app** → *Scoped access* → **Full Dropbox** → name it `Hydra Studio`.
2. **Permissions** tab: tick `files.metadata.read`, `files.content.read`, `files.content.write` → **Submit**.
3. **Settings** tab:
   - *Redirect URIs*: add `http://localhost:8080/` and `https://YOUR-SITE/`
   - *Allow public clients (Implicit Grant & PKCE)*: **Allow**
   - Copy the **App key** into `dropboxAppKey` in `config.js`.
4. Development status is fine for a team this size. You don't need to apply for production.

Each person connects **their own** Dropbox in the app (Settings → Connect Dropbox). Their account must
have the shared `Hydra Design` folder. If the folder sits somewhere else in their Dropbox, they can change the
job-folder path in Settings and press **Save & test**. The default is `/Hydra Design/Hydra | Projects`.

### 3. Dext

Every person has their own Dext "email in" address (in Dext: **Inbox → Add receipts → Email**).
Each person enters theirs in the app under **Settings → Your Dext email-in address**. Receipts are emailed
from that person's own Gmail, with the job number, supplier and amount in the subject line
(`H-01886 | Shell | £42.10`) and the full details in the email body.

### 4. Try it on this Mac

```bash
cd ~/Desktop/"Hydra App" && python3 -m http.server 8080
```

Open <http://localhost:8080> (use `localhost`, not `127.0.0.1`, because Google only accepts the exact address).

### 5. Put it online so phones can use it (GitHub Pages)

The app is hosted free on **GitHub Pages** from a public GitHub repository. Every push to the `main` branch
publishes automatically (`.github/workflows/publish.yml`, which takes about a minute). The address is
`https://<github-username>.github.io/hydra-app/`.

Add that address to the Google client (origins + redirect URIs, with the trailing `/` on redirect URIs) and to
the Dropbox redirect URIs (steps 1.4 and 2.3).

Later you could point a subdomain at it, e.g. `app.hydradesign.co.uk` (repo **Settings → Pages → Custom domain**).

#### Publishing an update

```bash
cd ~/Desktop/"Hydra App" && git add -A && git commit -m "Describe the change" && git push
```

Watch it publish on the repo's **Actions** tab. Phones with the app installed show
**"New version available"** the next time the app is opened or brought to the front (or within 30 minutes
if it stays open). Tapping **Update** switches them over. **Settings → Check for Updates** checks straight
away, and Settings shows which build is running.

How it works: the workflow stamps the commit id into `sw.js`. A changed `sw.js` is what tells installed apps
there's a new version, so never remove the `__BUILD__` placeholder.

### 6. Install on phones

- **iPhone**: open the link in **Safari** → Share → **Add to Home Screen**.
- **Android**: open it in **Chrome** → ⋮ menu → **Install app** (or *Add to Home screen*).

Then open the app, sign in with Google, go to Settings, connect Dropbox, and enter your initials and Dext address.

---

## How the Sheets section reads the spreadsheet

Nothing about the tabs is built into the app. Each time it refreshes it asks Google for the current tabs
and their contents.

- Tabs with **3 columns or fewer** (like TO DO LIST) show as a **task list**:
  - a **bold** row with only column A filled = a section heading (e.g. *Alo Shanghai*)
  - column A = the task, column B = who (`TS`, `SP/TS`, `ALL`)
  - **done** = the row's **Done** tick box is ticked (the sheet then turns the row green by itself), or the row is filled green by hand. The app ticks/unticks the box; on tabs without a Done column it paints the row green instead.
  - An optional header row `Task | Who | Done` (frozen, with initials dropdowns) makes the sheet easy to edit directly.
  - **Who** allows several initials (pick more than one from the dropdown; stored as `TS, MR`).
  - **New section in the sheet:** type the name in Task and pick **New section** in Who (or make the name bold with Who empty).
    The spreadsheet's Apps Script (`google-sheet/hydra-sections.gs`, pasted into Extensions → Apps Script) turns it into a clean heading.
  - **Section by mistake:** type initials in its Who box and it turns back into a task.
  - **Removing a task:** clear its text, or delete the row in Sheets. The app follows within 30 seconds.
  - Simple instructions sit in column E. The app only reads the table columns, so they don't appear in the app.
  - *Mine* shows only tasks with your initials (or `ALL`). Your initials come from your Google name (Tom Shackleton → `TS`) unless you set them in Settings. *Hide done* hides the green ones.
  - **+ Add task** inserts a row at the end of that section. **+ New section** adds a bold heading at the bottom.
- The **Tasks** section reads every list-style tab at once and shows the open tasks for you. Tapping a task opens its tab in Sheets.
- Wider tabs show as a **table**. Tap any cell to edit it, or use **+ Add row**.
- Before every change the app re-reads that cell. If someone else has just changed or moved it,
  the app refreshes and asks you to try again, so it never overwrites the wrong row.

### Suggested layout for the team to-do tab

One tab called `TO DO`, with no more than 3 columns so it stays a list:

| A: Task | B: Who | C: Due / notes |
|---|---|---|
| **H-01886 Alo Shanghai** *(bold, only column A filled: one section per job)* | | |
| Send revised floor plan | TS | Fri 6 Nov |
| Confirm AV supplier | SP/TS | |
| Book site visit | ALL | |

- Give each person (Matt, Tom, Dan, Sam) one set of initials, e.g. `TS`, and use the same ones everywhere. Anyone whose Google name gives different initials should set theirs in Settings.
- Colour a row green when it's done. The app does this when you tick a task.
- Column C shows under the task in small text. It's free text, so dates can be written however you like.
- Claude, or anyone else, can add rows straight into the sheet. If they follow this layout, the rows appear in everyone's Tasks.

## Files

```
config.js         ← the settings you fill in
index.html        app shell
styles.css
js/app.js         start-up + navigation
js/google.js      Google sign-in, API calls, sending email
js/dropbox.js     Dropbox connect, job-folder list, uploads
js/jobs.js        searchable job-number picker
js/calendar.js / tasks.js / sheets.js / sitevisits.js / receipts.js / settings.js
sw.js, manifest.webmanifest, icons/   make it installable and open offline
```

## Good to know

- Google sign-in lasts an hour. The app renews it quietly when you change section, so you may see a quick flash.
- Photos are resized to about 2,400 px JPEG before uploading, so they upload fast on mobile data.
- Receipt history in the app only covers receipts sent from that phone. Dext and Dropbox hold the real records.

## Project Crewing sheet script
In the spreadsheet: Extensions → Apps Script. Replace the existing file's contents with `google-sheet/hydra-sections.gs`, add a
new file (+ → Script) named `hydra-crewing` and paste `google-sheet/hydra-crewing.gs` into it. Then on the PROJECT CREWING tab,
type a project name in column A of an empty row: it becomes a project with date pickers across and a freelancer drop-down per crew row.
Colour a crew cell green to confirm someone for that date.
