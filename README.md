# dave-hubv2

Dave's Hub — the single-file mobile dashboard served at **https://romeobravos.net**.

`dave-hubv2.html` is the whole app: markup, styles, and logic in one file, no build step
and no external requests.

## How this repo relates to the live site

**This repo is a source mirror. Pushing here does not deploy.**

| | |
|---|---|
| `romeobravos.net` | nginx on EC2 (`54.88.80.208`) — serves this file as `index.html` |
| `planner.romeobravos.net` | Express service `master-planner-sync`, same box — holds the Notion + Google tokens |
| this repo | source of truth for the HTML; deployed to the box manually |

Two consequences worth knowing before you touch anything:

- The file is committed as **`dave-hubv2.html`** but nginx serves the doc root's
  **`index.html`**. Deploy by copying it into place under that name — renaming it on the
  server will take the site down.
- Before editing, check the live file is not ahead of this repo. It has been before:
  as of 2026-07-16 the repo was 575 lines behind live and was missing the entire Command
  Center screen. `curl -s https://romeobravos.net > live.html && diff live.html dave-hubv2.html`

## Data flow

The page holds **no secrets**. Every Notion call goes through the Express service, which
holds the OAuth token server-side. `Access-Control-Allow-Origin` on that service is pinned
to `https://romeobravos.net`, so the API is not reachable from localhost — local dev
exercises the offline path by design.

The Command Center polls every 5 minutes, only while the screen is open and the tab is
visible, and re-syncs on wake if the data is older than 5 minutes.

| Endpoint | Status | Feeds |
|---|---|---|
| `GET /api/today-events?date=` | **live** | Today's Agenda, event stat tiles |
| `GET /api/today-schedule` | **live** | Planner hourly schedule (pre-existing) |
| `GET /api/command-center` | **not deployed yet** | Priorities, Important Dates, revenue counts |

`/api/command-center` is written but not mounted — see below. Until it is, the cards it
feeds stay hidden and the rest of the screen works normally. Nothing errors.

## Deploying `/api/command-center`

`server/command-center.js` is a drop-in Express router. In the `master-planner-sync` service:

```js
const commandCenter = require('./command-center');
app.use(commandCenter({ notion, cache: 60 }));   // reuse the existing Notion client
```

It returns `{ importantDates, priorities, revenue }`. Responses are cached 60s server-side,
and a Notion outage serves stale rather than failing.

### Privacy constraint — read before extending

**romeobravos.net is public. There is no login.**

Lead Pipeline and Client Accounts carry `Email`, `Mobile`, and `Consent Record`
(timestamp + IP). `/api/command-center` therefore emits **aggregate counts only** — never a
lead's name or contact details. Both databases are empty today, so nothing is exposed; the
constraint exists so that stays true once the GHL → Make relay starts landing rows.

Do not add per-lead fields to that endpoint unless the site is put behind auth first.

## Known stale — not wired to anything

These Command Center cards are still hardcoded. They are Gmail/Drive data and no endpoint
exists for them, so they were left rather than faked:

- **Inbox Triage** — five fixed emails, "40 unread" is a literal
- **Recent Files** — seven fixed filenames with invented dates
- **Tasks & Projects** — eight fixed Notion hubs with invented "updated" dates

They need Gmail/Drive endpoints on the Express service before they can tell the truth.

## Local development

No build, no dependencies. It needs to be served over `http://` (not `file://`), and the
Notion API will be CORS-blocked locally — the Command Center will show
"Offline — showing last known", which is the correct degraded state.
