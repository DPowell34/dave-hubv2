import { Router } from "express";
import { getNotionClient } from "../notion/client";
import { getCalendarApi } from "../google/client";
import { config } from "../config";

/**
 * GET /api/schedule-merge — two-way merge between the Master Planner
 * "Today's Schedule" table and Google Calendar.
 *
 *   ?apply=0 (default)  dry run: report what WOULD change, write nothing
 *   ?apply=1            perform the writes
 *
 * Deploys to src/routes/schedule-merge.ts in master-planner-sync.
 *
 * Why not reuse src/sync/engine.ts: that engine maps Notion *pages* (Tasks db)
 * to events via sync_state.notion_page_id. Today's Schedule is a table *block* —
 * its rows are free text with no stable page id, and the day's section is
 * regenerated from a template, so block ids churn. Instead, every event this
 * creates is tagged with extendedProperties.private.daveHubKey, so idempotency
 * lives on the Google side and survives block churn with no schema change.
 *
 * Rules:
 * - Additive only. Nothing is ever deleted, in either system. A row removed in
 *   one place is left alone in the other — deleting on someone's real calendar
 *   off a heuristic text match is not a risk worth taking.
 * - All-day events have no hour and cannot land in an hourly table: reported as
 *   skipped, never written.
 * - The table only has rows for the hours it defines (currently 06:00–20:00).
 *   Google events outside that range are reported as skipped rather than
 *   silently dropped.
 */

export const scheduleMergeRouter = Router();

const ALLOWED_ORIGIN = "https://romeobravos.net";
const TZ = "America/New_York";
const SYNC_TAG = "daveHubSchedule";

interface Item {
  hour: number;
  title: string;
  startMin: number; // minutes from midnight
  endMin: number;
  raw: string;
}

function richTextToPlain(rt: any[] | undefined): string {
  return (rt || []).map((t: any) => t.plain_text as string).join("");
}

/** Comparison key: emoji/punctuation-insensitive title + start time. */
function norm(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function keyOf(title: string, startMin: number): string {
  return `${norm(title)}@${startMin}`;
}

function toMin(h: number, m: number, ap: string | null, refPm: boolean): number {
  let hh = h;
  const isPm = ap ? ap.toLowerCase() === "pm" : refPm;
  if (isPm && hh !== 12) hh += 12;
  if (!isPm && hh === 12) hh = 0;
  return hh * 60 + m;
}

/**
 * Parses one schedule line, e.g.
 *   "6:30–7:00 AM — Walk Broly"      -> 06:30-07:00
 *   "1:00–2:30 PM — Learn: 3.2 ..."  -> 13:00-14:30  (PM applies to both ends)
 *   "8:30 PM — Bed Time"             -> 20:30, 30m default
 */
function parseLine(line: string): Item | null {
  const s = line.trim();
  if (!s) return null;

  const range = s.match(
    /^(\d{1,2}):(\d{2})\s*(AM|PM)?\s*[–—-]\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*[–—-]\s*(.+)$/i
  );
  if (range) {
    const endAp = range[6] || null;
    const startAp = range[3] || endAp;
    const endPmRef = (endAp || "").toLowerCase() === "pm";
    const startMin = toMin(+range[1], +range[2], startAp, endPmRef);
    let endMin = toMin(+range[4], +range[5], endAp, endPmRef);
    if (endMin <= startMin) endMin = startMin + 30;
    return { hour: Math.floor(startMin / 60), title: range[7].trim(), startMin, endMin, raw: s };
  }

  const single = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?\s*[–—-]\s*(.+)$/i);
  if (single) {
    const startMin = toMin(+single[1], +single[2], single[3] || null, false);
    return { hour: Math.floor(startMin / 60), title: single[4].trim(), startMin, endMin: startMin + 30, raw: s };
  }
  return null;
}

function parseNotionSchedule(hours: Record<string, string>): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const [, cell] of Object.entries(hours)) {
    for (const line of String(cell).split(/[\n•]/)) {
      const item = parseLine(line);
      if (!item) continue;
      const k = keyOf(item.title, item.startMin);
      // The same block spans multiple hour rows (1:00–2:30 PM fills 13 and 14).
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

/** Offset for the given date in TZ, e.g. "-04:00" — correct across DST. */
function tzOffset(dateIso: string): string {
  const d = new Date(`${dateIso}T12:00:00Z`);
  const s = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).format(d);
  const m = s.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : "-05:00";
}
function isoAt(dateIso: string, min: number): string {
  const hh = String(Math.floor(min / 60)).padStart(2, "0");
  const mm = String(min % 60).padStart(2, "0");
  return `${dateIso}T${hh}:${mm}:00${tzOffset(dateIso)}`;
}

async function listGoogle(dateIso: string): Promise<any[]> {
  const cal = getCalendarApi();
  const off = tzOffset(dateIso);
  const res: any = await cal.events.list({
    calendarId: config.google.calendarId,
    timeMin: `${dateIso}T00:00:00${off}`,
    timeMax: `${dateIso}T23:59:59${off}`,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 100,
  });
  return res.data.items || [];
}

function googleToItem(ev: any): { item: Item | null; allDay: boolean } {
  if (ev.start?.date) return { item: null, allDay: true };
  const start = new Date(ev.start.dateTime);
  const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : new Date(start.getTime() + 30 * 60000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(start);
  const h = +(parts.find((p) => p.type === "hour")?.value || "0");
  const m = +(parts.find((p) => p.type === "minute")?.value || "0");
  const startMin = h * 60 + m;
  const durMin = Math.max(15, Math.round((end.getTime() - start.getTime()) / 60000));
  return {
    item: { hour: h, title: (ev.summary || "").trim(), startMin, endMin: startMin + durMin, raw: ev.summary || "" },
    allDay: false,
  };
}

function fmt12(min: number): string {
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

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

async function findScheduleTable(notion: any, blocks: any[]): Promise<any | null> {
  let sawHeading = false;
  for (const b of blocks) {
    const type = b.type as string;
    if (type?.startsWith("heading_")) {
      if (richTextToPlain(b[type]?.rich_text).trim() === "Today's Schedule") {
        sawHeading = true;
        continue;
      }
    }
    if (sawHeading && type === "table") return b;
    if (b.has_children) {
      const found = await findScheduleTable(notion, await listChildren(notion, b.id));
      if (found) return found;
    }
  }
  return null;
}

/**
 * Today's schedule table — the one under the "Thursday, July 16, 2026" heading.
 *
 * Scoping to that heading first is essential, and matches routes/schedule.ts.
 * The page holds TWO "Today's Schedule" tables: the blank reusable one inside
 * the Daily Planner toggle, which appears FIRST, and the real one under today's
 * date heading. Searching the page from the top finds the template and writes
 * today's one-off events into the blank Dave copies for every new day.
 * (Learned the hard way — it did exactly that on 2026-07-16.)
 */
async function findTodayScheduleTable(notion: any, pageId: string): Promise<any | null> {
  const heading = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: TZ,
  });
  const top = await listChildren(notion, pageId);
  const idx = top.findIndex(
    (b: any) => b.type === "heading_1" && richTextToPlain(b.heading_1?.rich_text).trim() === heading
  );
  if (idx === -1) return null; // no section for today — write nothing rather than guess
  return findScheduleTable(notion, top.slice(idx + 1));
}

scheduleMergeRouter.get("/api/schedule-merge", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Cache-Control", "no-store");

  const apply = req.query.apply === "1";
  const dateIso =
    typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

  try {
    const notion = getNotionClient();
    const pageId = config.notion.masterPlannerPageId;
    if (!pageId) {
      res.status(500).json({ error: "NOTION_MASTER_PLANNER_PAGE_ID is not configured" });
      return;
    }

    // --- read both sides (sequential: shared ~3 req/sec Notion budget) ---
    const schedRes = await fetch(`http://127.0.0.1:${config.port}/api/today-schedule`);
    const sched: any = await schedRes.json();
    const notionItems = sched?.hours ? parseNotionSchedule(sched.hours) : [];

    const gEvents = await listGoogle(dateIso);
    const googleItems: Item[] = [];
    const allDay: string[] = [];
    const alreadyTagged = new Set<string>();
    for (const ev of gEvents) {
      const tag = ev.extendedProperties?.private?.[SYNC_TAG];
      if (tag) alreadyTagged.add(tag);
      const { item, allDay: isAllDay } = googleToItem(ev);
      if (isAllDay) { allDay.push(ev.summary || "(untitled)"); continue; }
      if (item && item.title) googleItems.push(item);
    }

    const gKeys = new Set(googleItems.map((i) => keyOf(i.title, i.startMin)));
    const nKeys = new Set(notionItems.map((i) => keyOf(i.title, i.startMin)));

    // --- diff ---
    const toGoogle = notionItems.filter(
      (i) => !gKeys.has(keyOf(i.title, i.startMin)) && !alreadyTagged.has(keyOf(i.title, i.startMin))
    );
    const toNotionAll = googleItems.filter((i) => !nKeys.has(keyOf(i.title, i.startMin)));

    // Only hours the table actually has rows for can receive a write.
    const tableHours = new Set(Object.keys(sched?.hours || {}).map(Number));
    const minH = tableHours.size ? Math.min(...tableHours) : 6;
    const maxH = tableHours.size ? Math.max(...tableHours) : 19;
    const toNotion = toNotionAll.filter((i) => i.hour >= minH && i.hour <= maxH);
    const outOfRange = toNotionAll.filter((i) => i.hour < minH || i.hour > maxH);

    const report: any = {
      date: dateIso,
      applied: apply,
      notionItems: notionItems.length,
      googleItems: googleItems.length,
      willCreateInGoogle: toGoogle.map((i) => `${fmt12(i.startMin)}–${fmt12(i.endMin)} — ${i.title}`),
      willWriteIntoNotion: toNotion.map((i) => `hour ${i.hour}: ${fmt12(i.startMin)} — ${i.title}`),
      skipped: {
        allDayEvents: allDay,
        outsideTableHours: outOfRange.map((i) => `${fmt12(i.startMin)} — ${i.title} (table covers ${minH}:00–${maxH}:59)`),
      },
    };

    if (!apply) {
      report.note = "dry run — nothing was written. Re-run with ?apply=1 to execute.";
      res.json(report);
      return;
    }

    // --- write: Notion -> Google ---
    const cal = getCalendarApi();
    const created: string[] = [];
    for (const i of toGoogle) {
      const r: any = await cal.events.insert({
        calendarId: config.google.calendarId,
        requestBody: {
          summary: i.title,
          description: "Synced from Master Planner — Today's Schedule (Dave's Hub)",
          start: { dateTime: isoAt(dateIso, i.startMin), timeZone: TZ },
          end: { dateTime: isoAt(dateIso, i.endMin), timeZone: TZ },
          extendedProperties: { private: { [SYNC_TAG]: keyOf(i.title, i.startMin) } },
        },
      });
      created.push(`${i.title} -> ${r.data.id}`);
    }

    // --- write: Google -> Notion (append to the hour's Activity cell) ---
    const updated: string[] = [];
    if (toNotion.length) {
      const table = await findTodayScheduleTable(notion, pageId);
      if (!table) {
        report.notionWriteError =
          "No table found under today's date heading — nothing written (refusing to fall back to the blank template)";
      } else {
        const rows = await listChildren(notion, table.id);
        for (const i of toNotion) {
          // Row whose first cell names this hour, e.g. "13:00 - 14:00".
          const row = rows.find((r: any) => {
            if (r.type !== "table_row") return false;
            const label = richTextToPlain(r.table_row?.cells?.[0]).trim();
            const m = label.match(/^(\d{1,2}):\d{2}/);
            return m ? +m[1] === i.hour : false;
          });
          if (!row) continue;

          const cells = row.table_row.cells;
          const existing = richTextToPlain(cells[1]).trim();
          if (norm(existing).includes(norm(i.title))) continue; // already there

          const line = `${fmt12(i.startMin)} — ${i.title}`;
          const nextText = existing ? `${existing}\n${line}` : line;
          const nextCells = [cells[0], [{ type: "text", text: { content: nextText } }]];
          await notion.blocks.update({ block_id: row.id, table_row: { cells: nextCells } });
          updated.push(`hour ${i.hour}: +${line}`);
        }
      }
    }

    report.createdInGoogle = created;
    report.writtenIntoNotion = updated;
    res.json(report);
  } catch (err: any) {
    res.status(502).json({ error: "merge_failed", detail: String(err?.message || err).slice(0, 300) });
  }
});

/**
 * Keep both sides converged without anyone opening the app.
 *
 * 15 minutes, not 5: a merge costs a Master Planner block walk plus a Google
 * list, and it shares Notion's ~3 req/sec budget with /api/today-schedule and
 * /api/command-center — fanning those out concurrently is what timed out
 * today-schedule earlier. Once converged each pass is a no-op diff, so a
 * shorter interval buys nothing.
 *
 * Self-calls over loopback rather than refactoring the handler, matching how
 * this module already reads today-schedule.
 */
const AUTO_MERGE_MS = 15 * 60_000;
setTimeout(() => {
  setInterval(() => {
    fetch(`http://127.0.0.1:${config.port}/api/schedule-merge?apply=1`)
      .then((r) => r.json())
      .then((r: any) => {
        const n = (r?.createdInGoogle?.length || 0) + (r?.writtenIntoNotion?.length || 0);
        if (n) console.log(`schedule-merge: converged ${n} item(s)`);
      })
      .catch((e) => console.log("schedule-merge auto run failed:", String(e?.message || e)));
  }, AUTO_MERGE_MS);
}, 60_000); // let the service finish starting before the first pass
