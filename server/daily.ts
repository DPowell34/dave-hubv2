import { Router } from "express";
import { getNotionClient } from "../notion/client";
import { config } from "../config";

/** Shared with the categories write path: reads are public, writes are not. */
export function writeKeyOk(req: any): boolean {
  const expected = process.env.HUB_WRITE_KEY || "";
  if (!expected) return false; // unset disables writes; it must never mean "open"
  const got = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (!got || got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * GET /api/daily — today's checklists and End of Day Review from Master Planner,
 * for the hub's Planner screen.
 *
 * Deploys to src/routes/daily.ts in master-planner-sync.
 *
 * READ ONLY, deliberately. The hub's checkbox state lives in localStorage on the
 * phone, so app -> Notion would need a public write endpoint, and
 * romeobravos.net has no auth — CORS restrains browsers, not curl, so anyone
 * could tick Dave's boxes or write into his planner. Notion is the source of
 * truth here until the site is authenticated.
 *
 * Three things this has to get right, all of which broke naive attempts:
 * - Scope to TODAY's section. The page also holds a blank template (inside the
 *   Daily Planner toggle) with the same headings, and it comes FIRST.
 * - "Walk Broly / Water" appears under Morning, Afternoon AND Evening, so items
 *   are only meaningful inside their section — never match on text alone.
 * - Today's Morning has 5 items where the template has 6 (no "Coffee"), so
 *   index-based mapping drifts. Match on text within the section instead.
 */

export const dailyRouter = Router();

const ALLOWED_ORIGIN = "https://romeobravos.net";
const TZ = "America/New_York";

const plain = (rt: any[] | undefined): string => (rt || []).map((t: any) => t.plain_text).join("");

async function listChildren(notion: any, blockId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
    out.push(...res.results);
    cursor = res.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

/**
 * Today's blocks in document order, flattened.
 *
 * Depth-first so a state machine can read it top to bottom the way the page
 * reads. Tables are not recursed into: the schedule table adds a request per
 * call and holds nothing this endpoint wants, and the Notion budget is shared
 * with today-schedule and command-center.
 */
async function flattenToday(notion: any, pageId: string): Promise<any[]> {
  const heading = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: TZ,
  });
  const top = await listChildren(notion, pageId);
  const idx = top.findIndex(
    (b: any) => b.type === "heading_1" && plain(b.heading_1?.rich_text).trim() === heading
  );
  if (idx === -1) return [];

  const out: any[] = [];
  const walk = async (blocks: any[]) => {
    for (const b of blocks) {
      // The Archive link closes today's section; everything after is page furniture.
      if (b.type === "child_page") return true;
      out.push(b);
      if (b.has_children && b.type !== "table") {
        const stop = await walk(await listChildren(notion, b.id));
        if (stop) return true;
      }
    }
    return false;
  };
  await walk(top.slice(idx + 1));
  return out;
}

const REVIEW_HEADINGS: Record<string, string> = {
  "three things i enjoyed doing": "enjoyed",
  "three things i did not enjoy doing": "notEnjoyed",
  "challenges": "challenges",
  "changes to make": "changes",
};

let cache: { at: number; body: any } = { at: 0, body: null };
const CACHE_MS = 5 * 60_000;

dailyRouter.get("/api/daily", async (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Cache-Control", "no-store");

  if (cache.body && Date.now() - cache.at < CACHE_MS) {
    res.json(cache.body);
    return;
  }

  try {
    const pageId = config.notion.masterPlannerPageId;
    if (!pageId) {
      res.status(500).json({ error: "NOTION_MASTER_PLANNER_PAGE_ID is not configured" });
      return;
    }
    const notion = getNotionClient();
    const blocks = await flattenToday(notion, pageId);
    if (!blocks.length) {
      res.json({ found: false, checks: null, review: null });
      return;
    }

    const checks: Record<string, { t: string; d: boolean }[]> = { morning: [], afternoon: [], evening: [] };
    const review: any = {
      highlight: "", enjoyed: ["", "", ""], notEnjoyed: ["", "", ""],
      challenges: ["", "", ""], changes: ["", "", ""], notes: "",
    };

    let part: string | null = null;   // morning | afternoon | evening
    let inReview = false;
    let field: string | null = null;  // which review list we're filling
    let wantHighlight = false;

    for (const b of blocks) {
      const type = b.type as string;

      if (type === "heading_1") {
        const h = plain(b.heading_1?.rich_text).trim().toLowerCase();
        if (h.includes("end of day review")) { inReview = true; part = null; field = null; }
        continue;
      }

      if (type?.startsWith("heading_")) {
        const h = plain(b[type]?.rich_text).trim().toLowerCase();
        if (!inReview && (h === "morning" || h === "afternoon" || h === "evening")) {
          part = h; field = null;
          continue;
        }
        if (inReview) {
          if (h.startsWith("highlight")) { wantHighlight = true; field = null; continue; }
          field = REVIEW_HEADINGS[h] ?? null;
          if (field) wantHighlight = false;
          continue;
        }
        // Any other heading (e.g. "Today's Schedule") ends the checklist run.
        part = null;
        continue;
      }

      if (type === "to_do" && part) {
        const t = plain(b.to_do?.rich_text).trim();
        if (t) checks[part].push({ t, d: !!b.to_do?.checked });
        continue;
      }

      if (inReview && type === "numbered_list_item" && field) {
        const t = plain(b.numbered_list_item?.rich_text).trim();
        const slot = review[field].findIndex((v: string) => v === "");
        if (slot !== -1) review[field][slot] = t;
        else review[field].push(t);
        continue;
      }

      if (inReview && type === "callout") {
        const t = plain(b.callout?.rich_text).replace(/^notes\s*/i, "").trim();
        if (wantHighlight) { review.highlight = t; wantHighlight = false; }
        else if (t) review.notes = t; // the 💫 Notes callout
        continue;
      }
    }

    const body = {
      found: true,
      syncedAt: new Date().toISOString(),
      checks,
      review,
    };
    cache = { at: Date.now(), body };
    res.json(body);
  } catch (err: any) {
    if (cache.body) { res.json(cache.body); return; }
    res.status(502).json({ error: "daily_unavailable", detail: String(err?.message || err).slice(0, 200) });
  }
});

/* ═══════════════ WRITE PATH ═══════════════
   Same key as POST /api/categories. Without it this is the hole we spent the
   whole build avoiding: the page is public and CORS doesn't stop curl. */

function corsWrite(res: any) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
}

dailyRouter.options("/api/daily", (_req, res) => {
  corsWrite(res);
  res.setHeader("Access-Control-Max-Age", "600");
  res.sendStatus(204);
});

const norm = (s: string) => String(s || "").trim().toLowerCase();

/**
 * Index today's blocks by role, so a write can find the exact block to touch.
 *
 * Runs the same walk and state machine as the read, deliberately: if the two
 * ever disagreed about which block is "Morning / Walk Broly", writes would land
 * in the wrong place. Note "Walk Broly / Water" exists in all three sections —
 * the key is section + text, never text alone.
 */
function indexToday(blocks: any[]) {
  const todos = new Map<string, { id: string; checked: boolean }>(); // "part|text" -> block
  const lists: Record<string, string[]> = { enjoyed: [], notEnjoyed: [], challenges: [], changes: [] };
  const callouts: Record<string, string> = {}; // highlight | notes
  const prios = new Map<string, { id: string; text: string }>();     // work|learn|play

  let part: string | null = null;
  let inReview = false;
  let field: string | null = null;
  let wantHighlight = false;

  for (const b of blocks) {
    const type = b.type as string;

    if (type === "heading_1") {
      const h = norm(plain(b.heading_1?.rich_text));
      if (h.includes("end of day review")) { inReview = true; part = null; field = null; }
      continue;
    }
    if (type?.startsWith("heading_")) {
      const h = norm(plain(b[type]?.rich_text));
      if (!inReview && (h === "morning" || h === "afternoon" || h === "evening")) { part = h; field = null; continue; }
      if (inReview) {
        if (h.startsWith("highlight")) { wantHighlight = true; field = null; continue; }
        field = REVIEW_HEADINGS[h] ?? null;
        if (field) wantHighlight = false;
        continue;
      }
      part = null;
      continue;
    }
    if (type === "to_do" && part) {
      const t = plain(b.to_do?.rich_text).trim();
      if (t) todos.set(`${part}|${norm(t)}`, { id: b.id, checked: !!b.to_do?.checked });
      continue;
    }
    if (inReview && type === "numbered_list_item" && field) { lists[field].push(b.id); continue; }
    if (inReview && type === "callout") {
      if (wantHighlight) { callouts.highlight = b.id; wantHighlight = false; }
      else if (!callouts.notes) callouts.notes = b.id;
      continue;
    }
    // Work/Learn/Play live in callouts above the review, formatted "**Work** — ..."
    if (!inReview && type === "callout") {
      const t = plain(b.callout?.rich_text).trim();
      const m = t.match(/^(Work|Learn|Play)\s*[—–-]\s*([\s\S]+)$/i);
      if (m) prios.set(m[1].toLowerCase(), { id: b.id, text: m[2].trim() });
    }
  }
  return { todos, lists, callouts, prios };
}

const rt = (s: string) => [{ type: "text", text: { content: String(s || "").slice(0, 1900) } }];

/**
 * POST /api/daily { checks?, review?, priorities? }
 * Only writes blocks whose value actually differs, so a no-op push costs nothing
 * and repeated pushes can't thrash the page.
 */
dailyRouter.post("/api/daily", async (req, res) => {
  corsWrite(res);
  if (!writeKeyOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }

  const pageId = config.notion.masterPlannerPageId;
  if (!pageId) { res.status(500).json({ error: "master planner page not configured" }); return; }

  try {
    const notion = getNotionClient();
    const blocks = await flattenToday(notion, pageId);
    if (!blocks.length) { res.status(409).json({ error: "no_section_for_today" }); return; }
    const idx = indexToday(blocks);
    const changed: string[] = [];
    const skipped: string[] = [];

    // ── checklists ──
    const checks = req.body?.checks || {};
    for (const part of ["morning", "afternoon", "evening"]) {
      for (const item of checks[part] || []) {
        const hit = idx.todos.get(`${part}|${norm(item.t)}`);
        if (!hit) { skipped.push(`${part}/${item.t}: no matching to-do in Notion`); continue; }
        if (hit.checked === !!item.d) continue;
        await notion.blocks.update({ block_id: hit.id, to_do: { checked: !!item.d } });
        changed.push(`${part}/${item.t} -> ${item.d ? "checked" : "unchecked"}`);
      }
    }

    // ── end of day review ──
    const review = req.body?.review;
    if (review) {
      for (const f of ["highlight", "notes"] as const) {
        const id = idx.callouts[f];
        const val = String(review[f] || "").trim();
        if (!id || !val) continue;
        const cur = plain((blocks.find((b: any) => b.id === id) as any)?.callout?.rich_text).replace(/^notes\s*/i, "").trim();
        if (cur === val) continue;
        await notion.blocks.update({ block_id: id, callout: { rich_text: rt(f === "notes" ? `Notes\n${val}` : val) } });
        changed.push(`review.${f}`);
      }
      for (const f of ["enjoyed", "notEnjoyed", "challenges", "changes"]) {
        const ids = idx.lists[f] || [];
        const vals = Array.isArray(review[f]) ? review[f] : [];
        for (let i = 0; i < Math.min(ids.length, vals.length); i++) {
          const val = String(vals[i] || "").trim();
          if (!val) continue;
          const cur = plain((blocks.find((b: any) => b.id === ids[i]) as any)?.numbered_list_item?.rich_text).trim();
          if (cur === val) continue;
          await notion.blocks.update({ block_id: ids[i], numbered_list_item: { rich_text: rt(val) } });
          changed.push(`review.${f}[${i + 1}]`);
        }
        if (vals.filter((v: string) => String(v || "").trim()).length > ids.length) {
          skipped.push(`review.${f}: Notion has only ${ids.length} rows`);
        }
      }
    }

    // ── priorities ──
    const prios = req.body?.priorities || {};
    for (const k of ["work", "learn", "play"]) {
      const val = String(prios[k] || "").trim();
      const hit = idx.prios.get(k);
      if (!val || !hit || hit.text === val) continue;
      const label = k.charAt(0).toUpperCase() + k.slice(1);
      await notion.blocks.update({
        block_id: hit.id,
        callout: { rich_text: [
          { type: "text", text: { content: label }, annotations: { bold: true } },
          { type: "text", text: { content: ` — ${val}`.slice(0, 1900) } },
        ] },
      });
      changed.push(`priorities.${k}`);
    }

    cache = { at: 0, body: null }; // next read must see what we just wrote
    res.json({ ok: true, changed, skipped });
  } catch (err: any) {
    res.status(502).json({ error: "daily_write_failed", detail: String(err?.message || err).slice(0, 300) });
  }
});
