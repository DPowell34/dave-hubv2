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
| `GET /api/today-events?date=` | **live** | Today's Agenda, event stat tiles — same source as the Planner's event list |
| `GET /api/today-schedule` | **live** | Planner hourly grid (pre-existing) |
| `GET /api/command-center` | **live** | Priorities, Important Dates, revenue counts |
| `GET /api/schedule-merge` | **live** | Two-way Notion ↔ Google merge; `?apply=1` writes, self-runs every 15 min |
| `GET /api/sync-birthdays` | **live** | Google contact birthdays → Important Dates; `?apply=1` writes, daily |
| `GET /api/daily` | **live** | Today's checklists + End of Day Review |
| `POST /api/daily` | **live** | Writes checklists, review, priorities; requires `HUB_WRITE_KEY` |
| `POST /api/important-dates` | **live** | Files hub-added dates; requires `HUB_WRITE_KEY` |
| `GET /api/categories` | **live** | The seven Browse category databases |
| `POST /api/categories` | **live** | Upserts entries from the app; requires `HUB_WRITE_KEY` |

## What may write, and why

**romeobravos.net has no auth, and CORS restrains browsers, not `curl`** — so an
unauthenticated write endpoint would let anyone write into Dave's workspace. Everything here
follows from that:

- **Reads** (`today-schedule`, `today-events`, `command-center`, `daily`, `categories`) are
  public and safe.
- **Server-initiated writes** (`schedule-merge`, `sync-birthdays`) run on timers inside the
  box. Nothing external can trigger data injection; the worst a stranger can do by hitting
  `?apply=1` is make an idempotent, additive merge run early.
- **Writes from the page** (`POST /api/categories`) require `HUB_WRITE_KEY` — see the
  bottom of this file. The key is user-supplied, per device, and never in the page.

The **Revenue counts** remain gated on the separate Notion share, not on this.

### What still cannot match, and why

Everything with a Notion counterpart now syncs both ways. These stay device-local because
**nothing in Notion corresponds to them** — they'd need new structure inventing first:

| Device state | Missing counterpart |
|---|---|
| Planner **focus** | no field on the page |
| Daily **Five Agreements** ticks | the agreements are static callouts, not per-day checkboxes |
| **TikTok saved searches** | no database |
| **Custom categories** (Settings → + Add Category) | would need a new database per category |
| App name / theme / win streak | device preference, arguably shouldn't sync |
| The **write key** itself | must stay device-local by design |

Also: **deletes never propagate.** Removing an entry, date or checklist item in the app
leaves the Notion row alone. Deleting someone's data off a title match is not a risk worth
taking; delete in Notion if you mean it.

### Browse entry matching

`/api/categories` maps the seven databases into the shape Browse already uses, normalising
each category's Notion `Status` (Want to Go/Booked/Visited, Want to Watch/Watching/Watched,
…) to the app's internal `want|prog|done`.

The client matches on **type + lowercase title** — the same key the app's own duplicate
check uses. This is load-bearing: the Notion databases were seeded from the app's 15 SEED
places, so any other key renders every default twice. Verified on a wiped device: 15 in,
15 out, zero duplicates, all adopting their Notion ids.

Nothing is deleted locally — a row absent from Notion may simply be app-only. Databases are
queried sequentially; seven at once would blow the shared ~3 req/sec Notion budget.

## The schedule merge

`server/schedule-merge.ts` → `src/routes/schedule-merge.ts`. Notion's "Today's Schedule"
table and Google Calendar each held items the other lacked, and nothing reconciled them.
This diffs both and, with `?apply=1`, creates Google events for Notion-only rows and writes
Google-only events into the table. `?apply=0` is a dry run — use it before any manual apply.

- **Idempotency is on the Google side**, via `extendedProperties.private.daveHubSchedule`
  (normalised title + start minute). Not `sync_state`: table rows are free text with no page
  id, and `syncCalendarToTask()` looks up by `google_event_id`, so a synthetic key there
  would be mistaken for a Task page.
- **Additive only. Never deletes.** Deleting from a real calendar off a heuristic text match
  isn't worth the risk. All-day events and anything outside the table's rows (Bed Time at
  8:30 PM) are reported as skipped, not force-fitted.
- **Write to today's table, never the template.** The page has TWO "Today's Schedule"
  tables and the blank template inside the Daily Planner toggle comes *first*. Find today's
  `heading_1` and search only after it — see `findTodayScheduleTable`. Searching from the
  top writes today's one-offs into the blank Dave copies for every new day. This happened.

## The `/api/command-center` endpoint

`server/command-center.ts` is the source of record; it deploys to
`/opt/master-planner-sync/src/routes/command-center.ts` and is mounted from that service's
`src/index.ts`. It returns `{ importantDates, priorities, revenue }`.

That service is **TypeScript** — edit `src/`, build, then restart:

```bash
cd /opt/master-planner-sync
export NODE_OPTIONS=--max-old-space-size=1600   # tsc OOMs on this t3.small without it
./node_modules/.bin/tsc -p tsconfig.json        # build BEFORE restarting
systemctl restart master-planner-sync
```

Build before restarting, always: if the build fails the running service is untouched.

### Things that will bite you

- **Use `databases.query({database_id})`, not `dataSources.query`.** `src/notion/client.ts`
  calls `(notion as any).dataSources.query`, but `@notionhq/client` is pinned `^2.2.15`
  where `client.dataSources` is undefined (it's a v5+ API) — the cast hides it and it throws
  at runtime. Those are *database* ids, not the `collection://` data-source ids Notion's MCP
  returns.
- **Notion's ~3 req/sec limit is shared across the service.** Fanning out here while the hub
  also hits `today-schedule` timed out both and 500'd the pre-existing endpoint. Calls are
  sequential, cached 5 min to match the hub's poll, with concurrent misses collapsed onto one
  refresh. Keep it that way.
- **Revenue needs a Notion share.** The OAuth integration ("Master Planner") is shared with
  the Master Planner page tree only, so the DPowellTC Revenue databases return
  `object_not_found`. Share **DPowellTC — Revenue Command Center** with that integration to
  light them up; the endpoint backs off for an hour between attempts and reports `null` until
  then, so the hub hides the card. An unreadable database is never reported as `0` — that
  reads as "no leads" when it means "no access".

### Privacy constraint — read before extending

**romeobravos.net is public. There is no login.**

Lead Pipeline and Client Accounts carry `Email`, `Mobile`, and `Consent Record`
(timestamp + IP). `/api/command-center` therefore emits **aggregate counts only** — never a
lead's name or contact details. Both databases are empty today, so nothing is exposed; the
constraint exists so that stays true once the GHL → Make relay starts landing rows.

Do not add per-lead fields to that endpoint unless the site is put behind auth first. This
matters more once the Revenue page is shared with the integration — that share is what turns
those counts on.

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

## Writing from the app (`HUB_WRITE_KEY`)

Reads are public. **Writes require `HUB_WRITE_KEY`**, set in
`/opt/master-planner-sync/.env` and sent by the hub as `Authorization: Bearer …`. The key is
pasted into **Settings → Notion Write Key** and lives in that device's localStorage only —
**never in the page source**. That's the whole point: the page is public, so a baked-in
secret would protect nothing, whereas a key the user supplies is a real credential.

Invariants worth not breaking:

- **An unset key disables writes**, it does not open them. An empty env var must never mean
  "allow everyone".
- The comparison is **timing-safe**.
- The **`OPTIONS` handler is required**: a cross-origin POST carrying `Authorization` is
  preflighted, and without it the browser never sends the real request.
- Pushes fire **only from user actions**, never from `syncNotionCategories` — otherwise a
  pull immediately echoes back as a push.

`POST /api/categories` upserts by `notionId`, else case-insensitive title within the
category. **Settings → Push Pending to Notion** sends anything added before the key was set.

Rotate by editing `.env` and restarting the service; each device then re-pastes the key.
