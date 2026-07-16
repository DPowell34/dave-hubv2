# dave-hubv2

Dave's Hub — the single-file mobile dashboard served at **https://romeobravos.net**.

`dave-hubv2.html` is the whole app: markup, styles, and logic in one file, no build step
and no external requests.

## How this repo relates to the live site

**This repo is a source mirror. Pushing here does not deploy** — deployment is the separate
step below.

| | |
|---|---|
| `romeobravos.net` | nginx on EC2 — doc root `/var/www/romeobravo`, serves this file as `index.html` |
| `planner.romeobravos.net` | Express service `master-planner-sync`, same box — holds the Notion + Google tokens |
| this repo | source of truth for the HTML |

Two things to know before you touch anything:

- The file is committed as **`dave-hubv2.html`** but nginx serves the doc root's
  **`index.html`**. Deploy it under that name — renaming it on the server takes the site down.
- Check the live file is not ahead of this repo before editing. It has been before: as of
  2026-07-16 the repo was 575 lines behind live and was missing the entire Command Center
  screen. `curl -s https://romeobravos.net > live.html && diff live.html dave-hubv2.html`

## Deploying

The box is reachable via **AWS SSM** (no SSH needed): instance `i-0c750f471912bb58e`
in **us-east-1**. Push to `main` first, then run, backing up and gating on the checksum:

```bash
SHA=$(git show HEAD:dave-hubv2.html | sha256sum | awk '{print $1}')
aws ssm send-command --region us-east-1 --instance-ids i-0c750f471912bb58e \
  --document-name AWS-RunShellScript --parameters "{\"commands\":[
    \"set -euo pipefail\", \"cd /var/www/romeobravo\",
    \"cp -p index.html index.html.bak-\$(date +%Y%m%d-%H%M%S)\",
    \"curl -fsSL https://raw.githubusercontent.com/DPowell34/dave-hubv2/main/dave-hubv2.html -o /tmp/new.html\",
    \"[ \\\"\$(sha256sum /tmp/new.html | awk '{print \\\$1}')\\\" = \\\"$SHA\\\" ] || { echo MISMATCH; exit 1; }\",
    \"install -o www-data -g www-data -m 644 /tmp/new.html index.html\"]}"
```

Then verify what the public URL actually serves:
`curl -s https://romeobravos.net | sha256sum` — it must equal `$SHA`.

Backups accumulate in the doc root as `index.html.bak-YYYYMMDD-HHMMSS`; roll back by copying
one over `index.html`. Note `/var/www/html` is a **different site** (DPowellTC) — don't
deploy here. `nginx -t` emits a pre-existing `conflicting server name "dpowelltc.com"`
warning; it is unrelated.

## Data flow

The page holds **no secrets**. Every Notion call goes through the Express service, which
holds the OAuth token server-side. `Access-Control-Allow-Origin` on that service is pinned
to `https://romeobravos.net`, so the API is not reachable from localhost — local dev
exercises the offline path by design.

The Command Center polls every 5 minutes, only while the screen is open and the tab is
visible, and re-syncs on wake if the data is older than 5 minutes.

| Endpoint | Status | Feeds |
|---|---|---|
| `GET /api/today-events?date=` | **live** | Today's Agenda, event stat tiles — same source as the Planner Calendar, so the two always agree |
| `GET /api/today-schedule` | **live** | Planner hourly schedule (pre-existing) |
| `GET /api/command-center` | **not mounted** | Priorities, Important Dates, revenue counts |

`/api/command-center` is written but not mounted — see below. Until it is, the Priorities
and Revenue cards stay hidden, the Important Dates tile reads 0, and the rest of the screen
works normally. Nothing errors.

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
