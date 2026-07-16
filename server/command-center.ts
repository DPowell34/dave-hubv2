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

// Data source ids (not database ids) — this workspace is on the data-source API,
// matching notion/client.ts's dataSources.query usage.
const DS = {
  importantDates: "7f0b1542-d1c2-4e87-812a-58f31c170367",
  contentPipeline: "15938264-7756-475e-bf5c-b21fcb531f3a",
  leadPipeline: "5c2d8f56-66bc-4a13-b056-23137a41057b",
  clientAccounts: "db8c777b-62e3-42be-a4c6-7f9817c5600f",
  caseStudies: "cd57f408-f43d-470e-a2ab-14d5259d1ec9",
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

async function queryAll(dataSourceId: string): Promise<any[]> {
  const notion = getNotionClient();
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await (notion as any).dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor,
      page_size: 100,
    });
    out.push(...res.results);
    cursor = res.next_cursor ?? undefined;
  } while (cursor);
  return out;
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
  const rows = await queryAll(DS.importantDates);
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

  const prios: any[] = [];
  for (let i = start + 1; i < blocks.length; i++) {
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
    if (prios.length) break;
  }
  return prios;
}

/** Aggregate counts only — see the PRIVACY note at the top of this file. */
async function getRevenue(): Promise<any> {
  const countOf = async (id: string): Promise<number | null> => {
    try {
      return (await queryAll(id)).length;
    } catch {
      return null;
    }
  };

  const content = await queryAll(DS.contentPipeline).catch(() => [] as any[]);
  const byStatus: Record<string, number> = {};
  for (const p of content) {
    const s = p.properties?.Status?.select?.name || "Unknown";
    byStatus[s] = (byStatus[s] || 0) + 1;
  }

  const [leads, clients, cases] = await Promise.all([
    countOf(DS.leadPipeline),
    countOf(DS.clientAccounts),
    countOf(DS.caseStudies),
  ]);

  return {
    contentQueue: content.length,
    byStatus,
    rows: [
      { label: "Content queue", value: String(content.length) },
      { label: "Scripted & dated", value: String(byStatus["Scripted"] || 0) },
      { label: "Published", value: String(byStatus["Published"] || 0) },
      { label: "Case studies", value: String(cases ?? 0) },
      { label: "Leads in pipeline", value: String(leads ?? 0) },
      { label: "Client accounts", value: String(clients ?? 0) },
    ],
  };
}

const CACHE_MS = 60_000;
let cache: { at: number; body: any } = { at: 0, body: null };

commandCenterRouter.get("/api/command-center", async (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Cache-Control", "no-store");

  if (cache.body && Date.now() - cache.at < CACHE_MS) {
    res.json(cache.body);
    return;
  }

  try {
    // One slow or failing database must not take the whole payload down.
    const [importantDates, priorities, revenue] = await Promise.all([
      getImportantDates().catch(() => [] as any[]),
      getPriorities().catch(() => [] as any[]),
      getRevenue().catch(() => null),
    ]);

    const body = { found: true, syncedAt: new Date().toISOString(), importantDates, priorities, revenue };
    cache = { at: Date.now(), body };
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
