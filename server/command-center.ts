import { Router } from "express";
import { getNotionClient } from "../notion/client";
import { config } from "../config";

/**
 * GET /api/command-center — compiles Master Planner + Command Center data for
 * Dave's Hub (romeobravos.net), behind the hub's 5-minute poll.
 *
 * Lives at src/routes/command-center.ts in the master-planner-sync service and
 * is mounted from src/index.ts. Notion is reached through getNotionClient() so
 * the OAuth token stays server-side — the hub is a public page and carries no
 * secrets.
 *
 * PRIVACY — deliberate, not an oversight:
 * Lead Pipeline and Client Accounts hold Email / Mobile / Consent Record
 * (incl. IP). romeobravos.net has no authentication, so this endpoint emits
 * COUNTS ONLY. Never add a field here that names a lead or carries their
 * contact details unless the site is put behind auth first.
 */

export const commandCenterRouter = Router();

const ALLOWED_ORIGIN = "https://romeobravos.net";

/**
 * Database ids, queried via databases.query.
 *
 * NOT dataSources.query — despite notion/client.ts using it. @notionhq/client is
 * pinned to ^2.2.15 (2.3.0 installed), where `client.dataSources` is undefined;
 * that API only exists in v5+. The `(notion as any)` cast in client.ts hides the
 * type error, so those calls throw at runtime. Verified against the live token:
 * dataSources.query -> "Cannot read properties of undefined", while
 * databases.query returns all 19 Important Dates rows.
 *
 * The Revenue ids below currently return object_not_found: the OAuth integration
 * ("Master Planner") is shared with the Master Planner page tree, not with the
 * DPowellTC — Revenue Command Center tree. Share that page with the integration
 * in Notion to light them up; until then getRevenue() reports them as
 * unreadable and the hub hides the card rather than showing zeros.
 */
const DB = {
  importantDates: "bc4dc23d-42a9-4e96-a09f-3f5635ec9ad2",
  contentPipeline: "06a3feb9-d8f1-4942-880e-e07a93945c4d",
  leadPipeline: "ad597dfe-b497-4894-a7d8-8fabfcab4a5c",
  clientAccounts: "15db944d-bdcc-4fe0-9872-21a0af794144",
  caseStudies: "b77f764e-117a-479c-a667-069bda16995b",
};

const TYPE_TO_KIND: Record<string, { kind: string; recurring: boolean }> = {
  "🎂 Birthday": { kind: "birthday", recurring: true },
  "🇺🇸 Holiday": { kind: "date", recurring: true },
  "📌 Appointment": { kind: "date", recurring: false },
  "🎓 Assignment": { kind: "date", recurring: false },
  "🔔 Reminder": { kind: "date", recurring: false },
};

function richTextToPlain(rt: any[] | undefined): string {
  return (rt || []).map((t: any) => t.plain_text as string).join("");
}

async function queryAll(databaseId: string): Promise<any[]> {
  const notion = getNotionClient();
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    out.push(...res.results);
    cursor = res.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

/** null means "couldn't read it" — distinct from an empty database. */
async function tryQueryAll(databaseId: string): Promise<any[] | null> {
  try {
    return await queryAll(databaseId);
  } catch {
    return null;
  }
}

async function listChildren(notion: any, blockId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    out.push(...res.results);
    cursor = res.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

async function getImportantDates(): Promise<any[]> {
  const rows = await queryAll(DB.importantDates);
  return rows
    .map((p: any) => {
      const props = p.properties || {};
      const type = props.Type?.select?.name || "";
      const map = TYPE_TO_KIND[type] || { kind: "date", recurring: false };
      const start = props.Date?.date?.start || "";
      return {
        id: String(p.id).replace(/-/g, ""),
        name: richTextToPlain(props.Event?.title).trim(),
        date: start.slice(0, 10),
        time: start.length > 10 ? start.slice(11, 16) : "",
        kind: map.kind,
        recurring: map.recurring,
        type,
      };
    })
    .filter((d) => d.name && d.date);
}

/**
 * Today's Work/Learn/Play priorities live under an h1 on the Master Planner
 * page whose text is today's date ("Thursday, July 16, 2026"), inside a
 * column_list of callouts formatted "**Work** — ...".
 */
async function getPriorities(): Promise<any[]> {
  const pageId = config.notion.masterPlannerPageId;
  if (!pageId) return [];

  const notion = getNotionClient();
  const heading = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });

  const blocks = await listChildren(notion, pageId);
  const start = blocks.findIndex(
    (b: any) => b.type === "heading_1" && richTextToPlain(b.heading_1?.rich_text).trim() === heading
  );
  if (start === -1) return [];

  // Only the first column_list under today's heading holds Work/Learn/Play, so
  // stop at the first one that yields anything rather than walking the whole
  // day's subtree — every extra column is another API request against a ~3/sec
  // budget shared with /api/today-schedule.
  const prios: any[] = [];
  for (let i = start + 1; i < blocks.length && !prios.length; i++) {
    const b = blocks[i];
    if (b.type === "heading_1") break; // next day's section — stop
    if (b.type !== "column_list" || !b.has_children) continue;

    for (const col of await listChildren(notion, b.id)) {
      if (!col.has_children) continue;
      for (const kid of await listChildren(notion, col.id)) {
        if (kid.type !== "callout") continue;
        const text = richTextToPlain(kid.callout?.rich_text).trim();
        const m = text.match(/^(Work|Learn|Play)\s*[—–-]\s*([\s\S]+)$/i);
        if (m) prios.push({ kind: m[1], text: m[2].replace(/\s+/g, " ").trim() });
      }
    }
  }
  return prios;
}

/**
 * Aggregate counts only — see the PRIVACY note at the top of this file.
 *
 * Returns null when nothing is readable, and omits any individual database the
 * token cannot see. An unreadable database must never be reported as 0: that
 * reads as "no leads" when it means "no access", which is worse than saying
 * nothing at all.
 */
async function getRevenue(): Promise<any> {
  const countOf = async (id: string): Promise<number | null> => {
    const rows = await tryQueryAll(id);
    return rows === null ? null : rows.length;
  };

  const [content, cases, leads, clients] = await Promise.all([
    tryQueryAll(DB.contentPipeline),
    countOf(DB.caseStudies),
    countOf(DB.leadPipeline),
    countOf(DB.clientAccounts),
  ]);

  const rows: Array<{ label: string; value: string }> = [];
  let byStatus: Record<string, number> = {};

  if (content !== null) {
    for (const p of content) {
      const s = p.properties?.Status?.select?.name || "Unknown";
      byStatus[s] = (byStatus[s] || 0) + 1;
    }
    rows.push({ label: "Content queue", value: String(content.length) });
    rows.push({ label: "Scripted & dated", value: String(byStatus["Scripted"] || 0) });
    rows.push({ label: "Published", value: String(byStatus["Published"] || 0) });
  }
  if (cases !== null) rows.push({ label: "Case studies", value: String(cases) });
  if (leads !== null) rows.push({ label: "Leads in pipeline", value: String(leads) });
  if (clients !== null) rows.push({ label: "Client accounts", value: String(clients) });

  if (!rows.length) return null; // nothing shared with the integration — hub hides the card
  return { contentQueue: content === null ? null : content.length, byStatus, rows };
}

/**
 * Notion allows ~3 requests/sec per integration, and the hub asks this endpoint
 * and /api/today-schedule for the same page at the same time. Fanning out with
 * Promise.all here timed BOTH out (notionhq_client_request_timeout) and took
 * today-schedule down with it. So: match the hub's 5-minute poll so a warm cache
 * serves almost every request, and run the calls in sequence rather than at once.
 */
const CACHE_MS = 5 * 60_000;
let cache: { at: number; body: any } = { at: 0, body: null };

/**
 * Revenue lives outside the integration's share scope, so every attempt costs
 * four requests to learn nothing. Back off for an hour after a miss instead of
 * paying that on each refresh; it lights up on its own once the DPowellTC page
 * is shared with the "Master Planner" integration.
 */
const REVENUE_RETRY_MS = 60 * 60_000;
let revenueRetryAt = 0;

let inFlight: Promise<any> | null = null;

async function build(): Promise<any> {
  const importantDates = await getImportantDates().catch(() => [] as any[]);
  const priorities = await getPriorities().catch(() => [] as any[]);

  let revenue: any = null;
  if (Date.now() >= revenueRetryAt) {
    revenue = await getRevenue().catch(() => null);
    if (revenue === null) revenueRetryAt = Date.now() + REVENUE_RETRY_MS;
  }

  return { found: true, syncedAt: new Date().toISOString(), importantDates, priorities, revenue };
}

commandCenterRouter.get("/api/command-center", async (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Cache-Control", "no-store");

  if (cache.body && Date.now() - cache.at < CACHE_MS) {
    res.json(cache.body);
    return;
  }

  try {
    // Collapse concurrent misses onto one refresh — two phones opening the
    // screen together must not double the Notion traffic.
    if (!inFlight) {
      inFlight = build().finally(() => {
        inFlight = null;
      });
    }
    const body = await inFlight;

    // Don't cache a wholly empty result; let the next poll retry sooner.
    if (body.importantDates.length || body.priorities.length || body.revenue) {
      cache = { at: Date.now(), body };
    }
    res.json(body);
  } catch (err) {
    // Serve stale over erroring — the hub shows "showing last known".
    if (cache.body) {
      res.json(cache.body);
      return;
    }
    res.status(502).json({ found: false, error: "notion_unavailable" });
  }
});
