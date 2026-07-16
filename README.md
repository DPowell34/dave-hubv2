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
| `GET /api/command-center` | **live** | Priorities, Important Dates, revenue counts |

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
