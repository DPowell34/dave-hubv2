import { Router } from "express";
import { getNotionClient } from "../notion/client";

/**
 * GET /api/categories — the seven Browse category databases under Master
 * Planner, mapped into the shape the hub's Browse screen already uses.
 *
 * Deploys to src/routes/categories.ts in master-planner-sync.
 *
 * READ ONLY, same reason as /api/daily: the hub's entries live in localStorage
 * on the phone, so app -> Notion would need a public write endpoint and
 * romeobravos.net has no auth (CORS restrains browsers, not curl). Rows added in
 * Notion flow to the app; "+ Add Entry" in the app stays local until the site is
 * authenticated.
 *
 * Status vocabulary is per-category in both systems (Want to Go/Booked/Visited
 * vs Want to Watch/Watching/Watched...). It is normalised here to the app's
 * internal want/prog/done so the client doesn't need to know Notion's labels.
 */

export const categoriesRouter = Router();

const ALLOWED_ORIGIN = "https://romeobravos.net";

interface CatDef {
  type: string;                       // matches DEF_CATS ids in the hub
  db: string;
  status: Record<string, string>;     // Notion Status option -> want|prog|done
  extra?: string[];                   // per-category fields worth carrying
}

const CATS: CatDef[] = [
  { type: "place",    db: "112e8351-ae09-4205-a58f-a9a2307fc4a4",
    status: { "Want to Go": "want", Booked: "prog", Visited: "done" },
    extra: ["City", "Address", "Website", "Cost", "Date Night", "Kid Friendly", "Indoor", "Outdoor"] },
  { type: "movie",    db: "25c4d338-ea80-4e93-83c0-4a52325a7807",
    status: { "Want to Watch": "want", Watching: "prog", Watched: "done" },
    extra: ["Platform", "Genre"] },
  { type: "book",     db: "80d0c31a-445c-480e-85ea-aa236b260c48",
    status: { "Want to Read": "want", Reading: "prog", Finished: "done" },
    extra: ["Author", "Pages"] },
  { type: "event",    db: "4642dd13-11b8-49b1-a23b-f89eb56d84a1",
    status: { Interested: "want", "Have Tickets": "prog", Attended: "done" },
    extra: ["City", "Event Date", "Venue", "Website", "Cost"] },
  { type: "activity", db: "f34d953c-af9d-4e50-8bc5-59768f0ede90",
    status: { "Want to Try": "want", Planned: "prog", Done: "done" },
    extra: ["City", "Website", "Cost"] },
  { type: "shopping", db: "98ff9807-0bf1-4416-8d3c-b6acb6e1f37f",
    status: { Wishlist: "want", Planning: "prog", Purchased: "done" },
    extra: ["Website", "Cost"] },
  { type: "music",    db: "c3f9532e-e7ce-4f77-aebc-0bcbb008d2f5",
    status: { "Want to Hear": "want", Listening: "prog", "Loved It": "done" },
    extra: ["Platform"] },
];

const PRIORITY: Record<string, string> = { "Must Do": "must", High: "high", Someday: "someday" };

// Notion property name -> the hub's entry field
const FIELD: Record<string, string> = {
  City: "city", Address: "address", Website: "website", Cost: "cost",
  "Date Night": "dateNight", "Kid Friendly": "kidFriendly", Indoor: "indoor", Outdoor: "outdoor",
  Platform: "platform", Genre: "genre", Author: "author", Pages: "pages",
  "Event Date": "eventDate", Venue: "venue",
};

const plain = (rt: any[] | undefined): string => (rt || []).map((t: any) => t.plain_text).join("");

function readProp(p: any): any {
  if (!p) return undefined;
  switch (p.type) {
    case "title": return plain(p.title).trim();
    case "rich_text": return plain(p.rich_text).trim();
    case "select": return p.select?.name ?? "";
    case "multi_select": return (p.multi_select || []).map((o: any) => o.name);
    case "checkbox": return !!p.checkbox;
    case "number": return p.number ?? 0;
    case "url": return p.url ?? "";
    case "date": return p.date?.start ?? "";
    default: return undefined;
  }
}

async function queryAll(notion: any, database_id: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({ database_id, start_cursor: cursor, page_size: 100 });
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

let cache: { at: number; body: any } = { at: 0, body: null };
const CACHE_MS = 5 * 60_000;
let inFlight: Promise<any> | null = null;

async function build() {
  const notion = getNotionClient();
  const entries: any[] = [];
  const counts: Record<string, number | null> = {};

  // Sequential: seven databases at once would blow the shared ~3 req/sec budget
  // and take today-schedule down with it, which is exactly what happened before.
  for (const c of CATS) {
    let rows: any[];
    try {
      rows = await queryAll(notion, c.db);
    } catch {
      counts[c.type] = null; // unreadable — distinct from empty
      continue;
    }
    counts[c.type] = rows.length;
    for (const p of rows) {
      const props = p.properties || {};
      const title = readProp(props["Name"]);
      if (!title) continue;

      const e: any = {
        notionId: String(p.id).replace(/-/g, ""),
        type: c.type,
        title,
        category: readProp(props["Sub-type"]) || "Other",
        status: c.status[readProp(props["Status"])] || "want",
        priority: PRIORITY[readProp(props["Priority"])] || "high",
        favorite: !!readProp(props["Favorite"]),
        rating: readProp(props["Rating"]) || 0,
        tags: readProp(props["Tags"]) || [],
        notes: readProp(props["Notes"]) || "",
        addedDate: (readProp(props["Added"]) || "").slice(0, 10),
      };
      for (const name of c.extra || []) {
        const v = readProp(props[name]);
        if (v !== undefined && v !== "" && v !== false) e[FIELD[name] || name.toLowerCase()] = v;
      }
      entries.push(e);
    }
  }
  return { found: true, syncedAt: new Date().toISOString(), counts, entries };
}

categoriesRouter.get("/api/categories", async (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Cache-Control", "no-store");

  if (cache.body && Date.now() - cache.at < CACHE_MS) {
    res.json(cache.body);
    return;
  }
  try {
    if (!inFlight) inFlight = build().finally(() => { inFlight = null; });
    const body = await inFlight;
    if (body.entries.length) cache = { at: Date.now(), body };
    res.json(body);
  } catch (err: any) {
    if (cache.body) { res.json(cache.body); return; }
    res.status(502).json({ error: "categories_unavailable", detail: String(err?.message || err).slice(0, 200) });
  }
});

/* ═══════════════ WRITE PATH ═══════════════
   Reads above are public. Writes require HUB_WRITE_KEY, which Dave pastes into
   the hub's Settings once per device and which lives only in that device's
   localStorage — never in the page source. Without it this endpoint is exactly
   the hole we avoided all along: romeobravos.net has no auth and CORS restrains
   browsers, not curl, so an unauthenticated POST would let anyone write into the
   workspace.

   Timing-safe compare, and the service refuses to accept writes at all if the
   key is unset — an empty env var must never mean "allow everyone". */

function writeKeyOk(req: any): boolean {
  const expected = process.env.HUB_WRITE_KEY || "";
  if (!expected) return false; // unset => writes disabled, not open
  const got = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (!got || got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function corsWrite(res: any) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
}

// A cross-origin POST carrying Authorization is preflighted; without this the
// browser never sends the real request.
categoriesRouter.options("/api/categories", (_req, res) => {
  corsWrite(res);
  res.setHeader("Access-Control-Max-Age", "600");
  res.sendStatus(204);
});

const STATUS_TO_NOTION: Record<string, Record<string, string>> = Object.fromEntries(
  CATS.map((c) => [c.type, Object.fromEntries(Object.entries(c.status).map(([label, k]) => [k, label]))])
);
const PRIORITY_TO_NOTION: Record<string, string> = { must: "Must Do", high: "High", someday: "Someday" };

/** Only send properties that exist on that category's database. */
function buildProps(c: CatDef, e: any): any {
  const p: any = {
    Name: { title: [{ text: { content: String(e.title || "").slice(0, 200) } }] },
    Status: { select: { name: STATUS_TO_NOTION[c.type][e.status] || STATUS_TO_NOTION[c.type].want } },
    Priority: { select: { name: PRIORITY_TO_NOTION[e.priority] || "High" } },
    Favorite: { checkbox: !!e.favorite },
  };
  if (e.category) p["Sub-type"] = { select: { name: String(e.category) } };
  if (typeof e.rating === "number" && e.rating > 0) p["Rating"] = { number: e.rating };
  if (e.notes) p["Notes"] = { rich_text: [{ text: { content: String(e.notes).slice(0, 1800) } }] };
  if (Array.isArray(e.tags) && e.tags.length) p["Tags"] = { multi_select: e.tags.slice(0, 10).map((t: string) => ({ name: String(t).slice(0, 90) })) };
  if (e.addedDate) p["Added"] = { date: { start: String(e.addedDate).slice(0, 10) } };

  for (const name of c.extra || []) {
    const field = FIELD[name] || name.toLowerCase();
    const v = e[field];
    if (v === undefined || v === "" || v === null) continue;
    if (name === "Cost") p[name] = { select: { name: String(v) } };
    else if (name === "Event Date") p[name] = { date: { start: String(v).slice(0, 10) } };
    else if (name === "Website") p[name] = { url: String(v) };
    else if (name === "Pages") p[name] = { number: Number(v) || 0 };
    else if (["Date Night", "Kid Friendly", "Indoor", "Outdoor"].includes(name)) p[name] = { checkbox: !!v };
    else p[name] = { rich_text: [{ text: { content: String(v).slice(0, 1800) } }] };
  }
  return p;
}

/**
 * POST /api/categories  { entries: [ ...hub entries... ] }
 * Upsert by notionId when known, else by case-insensitive title within the
 * category — the same key the read side and the app's own duplicate check use,
 * so pushing an entry the app already matched can't fork a second row.
 */
categoriesRouter.post("/api/categories", async (req, res) => {
  corsWrite(res);
  if (!writeKeyOk(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const incoming = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (!incoming.length) {
    res.json({ ok: true, created: [], updated: [], skipped: [] });
    return;
  }

  const notion = getNotionClient();
  const created: string[] = [], updated: string[] = [], skipped: string[] = [];

  try {
    // Cache existing titles per touched database so we can match by title.
    const existing: Record<string, Map<string, string>> = {};
    for (const e of incoming.slice(0, 50)) {
      const c = CATS.find((x) => x.type === e.type);
      const title = String(e.title || "").trim();
      if (!c || !title) { skipped.push(`${e.type}/${title || "(untitled)"}: unknown category`); continue; }

      if (!existing[c.type]) {
        const m = new Map<string, string>();
        for (const p of await queryAll(notion, c.db)) {
          const t = readProp(p.properties?.["Name"]);
          if (t) m.set(String(t).trim().toLowerCase(), p.id);
        }
        existing[c.type] = m;
      }

      const pageId = e.notionId || existing[c.type].get(title.toLowerCase());
      const props = buildProps(c, e);
      if (pageId) {
        await notion.pages.update({ page_id: pageId, properties: props });
        updated.push(`${c.type}/${title}`);
      } else {
        const r: any = await notion.pages.create({ parent: { database_id: c.db }, properties: props });
        existing[c.type].set(title.toLowerCase(), r.id);
        created.push(`${c.type}/${title}`);
      }
    }
    cache = { at: 0, body: null }; // next read must reflect what we just wrote
    res.json({ ok: true, created, updated, skipped });
  } catch (err: any) {
    res.status(502).json({ error: "write_failed", detail: String(err?.message || err).slice(0, 300), created, updated });
  }
});
