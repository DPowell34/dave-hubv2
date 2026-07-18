import { Router } from "express";
import * as fs from "fs";
import * as path from "path";
import { getNotionClient } from "../notion/client";
import { config } from "../config";
import { writeKeyOk } from "./daily";

/**
 * GET /api/rollover — daily rollover for the Master Planner page.
 *
 *   ?apply=0 (default)  dry run: report the plan, touch nothing
 *   ?apply=1            archive past days + complete today
 *
 * Deploys to src/routes/rollover.ts in master-planner-sync. Runs itself once a
 * day (hourly check against a marker file, so it also catches up after a
 * restart or downtime).
 *
 * Each day section on the page is a heading_1 like "Saturday, July 18, 2026".
 * Two jobs:
 *
 * 1. ARCHIVE past days — copy the whole section into Archive → 2026, VERIFY the
 *    copy landed (the section's own text is found under the archive), and only
 *    THEN delete the originals. Notion deletes go to trash (30-day recoverable),
 *    so even a mistake is undoable. Never deletes before the copy is confirmed.
 *
 * 2. COMPLETE today additively — a day section can arrive as a stub (priorities
 *    only). This fills in whichever of Morning/Afternoon/Evening checklists, the
 *    Today's Schedule table, and the End of Day Review are missing, without
 *    touching priorities that something else may have written. Layout is linear
 *    (single column) rather than the template's two-column styling: the app and
 *    every sync read by heading + block type, not by layout, and a reliable
 *    automated build matters more than matching the columns.
 *
 * Everything is `any`-typed on purpose — the Notion block objects don't fit the
 * SDK's strict request types cleanly, and the codebase already works this way.
 */

export const rolloverRouter = Router();

const ALLOWED_ORIGIN = "https://romeobravos.net";
const TZ = "America/New_York";
const MARKER = path.join(__dirname, "..", "..", "data", "last-rollover.txt");

const DATE_HEADING =
  /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$/;

const plain = (rt: any[] | undefined): string => (rt || []).map((t: any) => t.plain_text).join("");
const todayHeading = () =>
  new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: TZ });

async function listChildren(notion: any, id: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const r: any = await notion.blocks.children.list({ block_id: id, start_cursor: cursor, page_size: 100 });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** rich_text -> append-ready, dropping read-only fields; non-text items degrade to plain text. */
function rtCopy(rich: any[] | undefined): any[] {
  return (rich || []).map((i: any) => ({
    type: "text",
    text: { content: String(i?.text?.content ?? i?.plain_text ?? "").slice(0, 1900), link: i?.text?.link ?? null },
    annotations: i?.annotations || {},
  }));
}
const txt = (s: string, ann?: any): any[] => [{ type: "text", text: { content: String(s).slice(0, 1900) }, annotations: ann || {} }];

/** Is this URL a Notion S3 signed link that will expire? Those must not be copied. */
const isExpiring = (u: string) => /X-Amz-|prod-files-secure\.s3/.test(String(u || ""));

/**
 * Convert a list of block OBJECTS into an append-ready list. Each block is
 * converted itself and then recursed into — the day-section content sits at the
 * page level as siblings, so this must operate on the blocks themselves, not on
 * some parent's children. Columns are unwrapped (descendants emitted inline) so
 * nothing is lost and append depth stays shallow; tables are rebuilt as tables;
 * expiring images are noted, not copied.
 */
async function convertBlocks(notion: any, blocks: any[], acc: any[]) {
  for (const b of blocks) {
    const t = b.type as string;
    if (t === "column_list" || t === "column") { await convertBlocks(notion, await listChildren(notion, b.id), acc); continue; }
    if (t === "child_page" || t === "child_database" || t === "unsupported") continue;
    if (t === "table") {
      const rows = await listChildren(notion, b.id);
      acc.push({
        type: "table",
        table: {
          table_width: b.table?.table_width || (rows[0]?.table_row?.cells?.length ?? 1),
          has_column_header: !!b.table?.has_column_header,
          has_row_header: !!b.table?.has_row_header,
          children: rows.map((r: any) => ({ type: "table_row", table_row: { cells: (r.table_row?.cells || []).map(rtCopy) } })),
        },
      });
      continue;
    }
    if (t === "image") {
      const url = b.image?.external?.url || b.image?.file?.url || "";
      if (url && !isExpiring(url)) acc.push({ type: "image", image: { type: "external", external: { url } } });
      else acc.push({ type: "paragraph", paragraph: { rich_text: txt("[image omitted — was a temporary Notion link]") } });
      continue;
    }
    if (t === "toggle") {
      acc.push({ type: "heading_3", heading_3: { rich_text: rtCopy(b.toggle?.rich_text) } });
      if (b.has_children) await convertBlocks(notion, await listChildren(notion, b.id), acc);
      continue;
    }
    if (["heading_1", "heading_2", "heading_3", "paragraph", "to_do", "numbered_list_item", "bulleted_list_item", "callout", "quote", "divider", "code"].includes(t)) {
      const src = b[t] || {};
      const block: any = { type: t, [t]: {} };
      if (t !== "divider") block[t].rich_text = rtCopy(src.rich_text);
      if (t === "to_do") block[t].checked = !!src.checked;
      if (t === "callout" && src.icon?.type === "emoji") block[t].icon = { type: "emoji", emoji: src.icon.emoji };
      if (t === "code") block[t].language = src.language || "plain text";
      acc.push(block);
      if (b.has_children) await convertBlocks(notion, await listChildren(notion, b.id), acc);
      continue;
    }
    const anyText = plain(b[t]?.rich_text);
    if (anyText) acc.push({ type: "paragraph", paragraph: { rich_text: txt(anyText) } });
  }
}

async function appendInBatches(notion: any, parentId: string, blocks: any[]) {
  for (let i = 0; i < blocks.length; i += 100) {
    await notion.blocks.children.append({ block_id: parentId, children: blocks.slice(i, i + 100) });
  }
}

/** Resolve Archive → 2026 page id, dynamically with a known fallback. */
async function archiveYearPage(notion: any, pageId: string): Promise<string | null> {
  const KNOWN = "39397010-90f0-8112-ad36-f15396173cab";
  try {
    const archive = (await listChildren(notion, pageId)).find((b: any) => b.type === "child_page" && /archive/i.test(b.child_page?.title || ""));
    if (!archive) return KNOWN;
    const year = String(new Date().toLocaleDateString("en-US", { year: "numeric", timeZone: TZ }));
    const yearPage = (await listChildren(notion, archive.id)).find((b: any) => b.type === "child_page" && (b.child_page?.title || "").trim() === year);
    return yearPage ? yearPage.id : KNOWN;
  } catch { return KNOWN; }
}

/** Top-level day sections: each date heading and the ids beneath it until the next date heading / Archive. */
function daySections(top: any[]) {
  const out: { date: string; ids: string[]; headingId: string }[] = [];
  let cur: { date: string; ids: string[]; headingId: string } | null = null;
  for (const b of top) {
    const isDate = b.type === "heading_1" && DATE_HEADING.test(plain(b.heading_1?.rich_text).trim());
    if (isDate) { cur = { date: plain(b.heading_1.rich_text).trim(), ids: [b.id], headingId: b.id }; out.push(cur); continue; }
    if (b.type === "child_page") { cur = null; continue; } // Archive ends the day area
    if (cur) cur.ids.push(b.id);
  }
  return out;
}

// ── today's scaffold (linear; matches the blank template's content) ──
const H3 = (s: string) => ({ type: "heading_3", heading_3: { rich_text: txt(s) } });
const TODO = (s: string) => ({ type: "to_do", to_do: { rich_text: txt(s), checked: false } });
const NUM = () => ({ type: "numbered_list_item", numbered_list_item: { rich_text: [] } });
const SCHEDULE_ROWS: [string, string][] = [
  ["Time", "Activity"],
  ["06:00 - 07:00", "6:30–7:00 AM — Walk Broly"],
  ["07:00 - 08:00", "7:15–8:15 AM — Workout"],
  ["08:00 - 09:00", "8:00–8:30 AM — Breakfast\n8:00–9:00 AM — Prep for Day Trading"],
  ["09:00 - 10:00", ""], ["10:00 - 11:00", ""],
  ["11:00 - 12:00", "11:30–11:45 AM — Walk Broly"],
  ["12:00 - 13:00", ""], ["13:00 - 14:00", ""], ["14:00 - 15:00", ""], ["15:00 - 16:00", ""],
  ["16:00 - 17:00", "4:30–5:00 PM — Walk Broly"],
  ["17:00 - 18:00", "5:00–5:30 PM — Dinner"],
  ["18:00 - 19:00", ""],
  ["19:00 - 20:00", "7:30–8:00 PM — Journal Entry"],
];

function scaffold(parts: { checklists: boolean; schedule: boolean; eod: boolean }): any[] {
  const out: any[] = [];
  if (parts.checklists) {
    out.push(H3("Morning"), ...["Walk Broly / Water", "Make Bed", "Water", "Meds / Supplements", "Coffee", "Breakfast"].map(TODO));
    out.push(H3("Afternoon"), ...["Walk Broly / Water", "Lunch / Snack"].map(TODO));
    out.push(H3("Evening"), ...["Walk Broly / Water", "Dinner", "Journal Entry"].map(TODO));
  }
  if (parts.schedule) {
    out.push(H3("Today's Schedule"));
    out.push({
      type: "table",
      table: {
        table_width: 2, has_column_header: true, has_row_header: false,
        children: SCHEDULE_ROWS.map(([a, b]) => ({ type: "table_row", table_row: { cells: [txt(a), txt(b)] } })),
      },
    });
  }
  if (parts.eod) {
    out.push({ type: "heading_1", heading_1: { rich_text: txt("End of Day Review") } });
    out.push(H3("Highlight of my day"));
    out.push({ type: "callout", callout: { rich_text: [], icon: { type: "emoji", emoji: "🌱" } } });
    out.push(H3("Three things I enjoyed doing"), NUM(), NUM(), NUM());
    out.push(H3("Three things I did not enjoy doing"), NUM(), NUM(), NUM());
    out.push(H3("Challenges"), NUM(), NUM(), NUM());
    out.push(H3("Changes to Make"), NUM(), NUM(), NUM());
    out.push({ type: "callout", callout: { rich_text: txt("Notes"), icon: { type: "emoji", emoji: "💫" } } });
  }
  return out;
}

async function runRollover(apply: boolean) {
  const notion = getNotionClient();
  const pageId = config.notion.masterPlannerPageId;
  if (!pageId) throw new Error("master planner page not configured");

  const today = todayHeading();
  const top = await listChildren(notion, pageId);
  const byId = new Map<string, any>(top.map((b: any) => [b.id, b]));
  const sections = daySections(top);
  const archiveDest = await archiveYearPage(notion, pageId);

  const report: any = { today, apply, archived: [], archiveErrors: [], completed: null, note: "" };

  // 1) archive every day section that isn't today
  for (const sec of sections) {
    if (sec.date === today) continue;
    if (!apply) { report.archived.push(`${sec.date} (would archive → 2026, ${sec.ids.length} blocks)`); continue; }
    try {
      if (!archiveDest) throw new Error("Archive → 2026 page not found");
      // Label the archived day with its own date, then copy everything under it
      // (skip ids[0], the original date heading, since we relabel it here).
      const dayBlocks: any[] = [{ type: "divider", divider: {} }, { type: "heading_2", heading_2: { rich_text: txt(sec.date) } }];
      const objs = sec.ids.slice(1).map((id) => byId.get(id)).filter(Boolean);
      await convertBlocks(notion, objs, dayBlocks);
      await appendInBatches(notion, archiveDest, dayBlocks);

      // verify the copy landed before deleting anything
      const recent = await listChildren(notion, archiveDest);
      const landed = recent.some((b: any) => b.type === "heading_2" && plain(b.heading_2?.rich_text).trim() === sec.date);
      if (!landed) throw new Error("archived copy not found after append — leaving original in place");

      for (const id of sec.ids) await notion.blocks.delete({ block_id: id }); // trash, recoverable
      report.archived.push(`${sec.date} — archived → 2026 and removed from main (${sec.ids.length} blocks)`);
    } catch (e: any) {
      report.archiveErrors.push(`${sec.date}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }

  // 2) ensure today is complete
  const freshTop = apply ? await listChildren(notion, pageId) : top;
  const freshSections = daySections(freshTop);
  const todaySec = freshSections.find((s) => s.date === today);

  const idBlock = (id: string) => freshTop.find((b: any) => b.id === id);
  const hasChecklists = (sec: any) => sec.ids.some((id: string) => { const b = idBlock(id); return b && b.type?.startsWith("heading_") && /^(morning|afternoon|evening)$/i.test(plain(b[b.type]?.rich_text).trim()); });
  const hasSchedule = (sec: any) => sec.ids.some((id: string) => { const b = idBlock(id); return b && b.type?.startsWith("heading_") && /today.?s schedule/i.test(plain(b[b.type]?.rich_text).trim()); });
  const hasEod = (sec: any) => sec.ids.some((id: string) => { const b = idBlock(id); return b && b.type === "heading_1" && /end of day review/i.test(plain(b.heading_1?.rich_text).trim()); });

  if (!todaySec) {
    // No section for today — create heading + full scaffold after the blank template toggle.
    const anchor = freshTop.find((b: any) => b.type === "toggle" && /date/i.test(plain(b.toggle?.rich_text)));
    const parts = { checklists: true, schedule: true, eod: true };
    const blocks = [
      { type: "heading_1", heading_1: { rich_text: txt(today) } },
      { type: "heading_2", heading_2: { rich_text: txt("My Top Priorities for the day") } },
      ...scaffold(parts),
    ];
    report.completed = { created: true, parts: Object.keys(parts) };
    if (apply) {
      if (anchor) await notion.blocks.children.append({ block_id: pageId, after: anchor.id, children: blocks.slice(0, 100) });
      else await appendInBatches(notion, pageId, blocks);
    }
  } else {
    const parts = { checklists: !hasChecklists(todaySec), schedule: !hasSchedule(todaySec), eod: !hasEod(todaySec) };
    const missing = Object.entries(parts).filter(([, v]) => v).map(([k]) => k);
    report.completed = missing.length ? { created: false, added: missing } : { created: false, added: [], note: "already complete" };
    if (apply && missing.length) {
      const anchorId = todaySec.ids[todaySec.ids.length - 1]; // after the last block of today's section
      const blocks = scaffold(parts);
      // append in one call after the anchor (scaffold is < 100 blocks)
      await notion.blocks.children.append({ block_id: pageId, after: anchorId, children: blocks });
    }
  }

  return report;
}

// ── HTTP ──
rolloverRouter.get("/api/rollover", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Cache-Control", "no-store");
  const apply = req.query.apply === "1";
  if (apply && !writeKeyOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  try {
    const report = await runRollover(apply);
    if (!apply) report.note = "dry run — nothing changed. Re-run with ?apply=1 (write key required).";
    res.json(report);
  } catch (e: any) {
    res.status(502).json({ error: "rollover_failed", detail: String(e?.message || e).slice(0, 300) });
  }
});

// ── daily automation ──
// Hourly check against a marker; runs once per calendar day (ET), and catches up
// after downtime. The service holds the write key in its env, so the automated
// run doesn't need HTTP auth.
function markerDate(): string | null { try { return fs.readFileSync(MARKER, "utf8").trim(); } catch { return null; } }
function setMarker(d: string) { try { fs.mkdirSync(path.dirname(MARKER), { recursive: true }); fs.writeFileSync(MARKER, d, "utf8"); } catch {} }

async function autoRolloverTick() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD, stable marker
  if (markerDate() === today) return;
  try {
    const r = await runRollover(true);
    setMarker(today);
    const n = (r.archived?.length || 0);
    if (n || r.completed) console.log(`rollover: archived ${n} day(s); today ${r.completed?.created ? "created" : "checked"}`);
  } catch (e: any) {
    console.log("rollover auto run failed:", String(e?.message || e));
  }
}
setTimeout(() => { autoRolloverTick(); setInterval(autoRolloverTick, 60 * 60_000); }, 120_000);
