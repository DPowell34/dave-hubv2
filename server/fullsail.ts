import { Router } from "express";
import * as fs from "fs";
import * as path from "path";
import { getNotionClient } from "../notion/client";
import { getCalendarApi } from "../google/client";
import { writeKeyOk } from "./daily";

/**
 * GET /api/fullsail-clean — remove completed Full Sail coursework from Google
 * Calendar based on the current "Week Plan of Action" page's checkboxes.
 *
 *   ?apply=0 (default)  dry run
 *   ?apply=1            delete the matching calendar events (write key)
 *
 * Deploys to src/routes/fullsail.ts. Runs itself every Saturday ~05:30 ET.
 *
 * Why only the checkboxes, not the Full Sail portal: the portal
 * (online.fullsail.edu) is behind Dave's login and can only be read with the
 * Chrome extension driving his live browser — a server cron has neither. So the
 * unattended job trusts the week-plan checkboxes; the portal is synced into
 * those checkboxes interactively (Claude drives Chrome) when Dave is around.
 *
 * Per Dave's choice: completed items are marked done in Notion (the checkbox IS
 * that marker) and the matching calendar event is DELETED. Deletes go to Google
 * trash (30-day recoverable). Only events whose title contains "Full Sail" are
 * ever eligible, so nothing unrelated can be caught by a shared word like "quiz".
 */

export const fullsailRouter = Router();

const ALLOWED_ORIGIN = "https://romeobravos.net";
const TZ = "America/New_York";
const MARKER = path.join(__dirname, "..", "..", "data", "last-fullsail.txt");

const plain = (rt: any[] | undefined): string => (rt || []).map((t: any) => t.plain_text).join("");

/** Coursework tokens shared between a checkbox label and a calendar title. */
function tokens(s: string): Set<string> {
  s = (s || "").toLowerCase();
  const out = new Set<string>();
  if (/\blab\s*6\b/.test(s)) out.add("lab6");
  if (/\blab\s*7\b/.test(s)) out.add("lab7");
  if (/\bquiz\b/.test(s)) out.add("quiz");
  if (/integrative\s*5|\b3\.2\b/.test(s)) out.add("int5");
  if (/integrative\s*6|\b3\.3\b/.test(s)) out.add("int6");
  if (/discussion|\b3\.4\b/.test(s)) out.add("disc");
  if (/reading|\b3\.1\b/.test(s)) out.add("reading");
  return out;
}

async function listChildrenDeep(notion: any, id: string, acc: any[]) {
  let cursor: string | undefined;
  do {
    const r: any = await notion.blocks.children.list({ block_id: id, start_cursor: cursor, page_size: 100 });
    for (const b of r.results) {
      acc.push(b);
      if (b.has_children) await listChildrenDeep(notion, b.id, acc);
    }
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
}

/** The current module's "Week Plan of Action" page (most recently edited match). */
async function findPlanPage(notion: any): Promise<string | null> {
  try {
    const res: any = await notion.search({ query: "Week Plan of Action", page_size: 10, sort: { direction: "descending", timestamp: "last_edited_time" } });
    const hit = (res.results || []).find((r: any) => r.object === "page" &&
      /week plan of action/i.test(((r.properties?.title?.title) || (r.properties?.Name?.title) || []).map((t: any) => t.plain_text).join("")));
    return hit ? hit.id : null;
  } catch { return null; }
}

async function runClean(apply: boolean) {
  const notion = getNotionClient();
  const planId = await findPlanPage(notion);
  const report: any = { apply, planFound: !!planId, completedTokens: [], deleted: [], kept: [] };
  if (!planId) { report.note = "no Week Plan of Action page found"; return report; }

  // union of tokens across CHECKED to-dos
  const blocks: any[] = [];
  await listChildrenDeep(notion, planId, blocks);
  const doneTokens = new Set<string>();
  for (const b of blocks) {
    if (b.type === "to_do" && b.to_do?.checked) for (const t of tokens(plain(b.to_do.rich_text))) doneTokens.add(t);
  }
  report.completedTokens = [...doneTokens];
  if (!doneTokens.size) { report.note = "nothing checked off yet"; return report; }

  // upcoming Full Sail events (today .. +16 days)
  const cal = getCalendarApi();
  const now = new Date();
  const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const timeMax = new Date(now.getTime() + 16 * 864e5).toISOString();
  const ev: any = await cal.events.list({ calendarId: "primary", timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: 250 });

  for (const e of ev.data.items || []) {
    const title = e.summary || "";
    if (!/full sail/i.test(title)) continue;                 // safety: only Full Sail events
    const evTokens = tokens(title);
    const match = [...evTokens].some((t) => doneTokens.has(t));
    const when = e.start?.dateTime || e.start?.date || "";
    if (!match) { report.kept.push(`${when} ${title}`); continue; }
    if (apply) {
      try { await cal.events.delete({ calendarId: "primary", eventId: e.id }); report.deleted.push(`${when} ${title}`); }
      catch (err: any) { report.deleted.push(`FAILED ${title}: ${String(err?.message || err).slice(0, 80)}`); }
    } else {
      report.deleted.push(`WOULD DELETE ${when} ${title}`);
    }
  }
  return report;
}

fullsailRouter.get("/api/fullsail-clean", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Cache-Control", "no-store");
  const apply = req.query.apply === "1";
  if (apply && !writeKeyOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  try {
    const report = await runClean(apply);
    if (!apply) report.note = report.note || "dry run — nothing deleted. ?apply=1 (write key) to execute.";
    res.json(report);
  } catch (e: any) {
    res.status(502).json({ error: "fullsail_clean_failed", detail: String(e?.message || e).slice(0, 300) });
  }
});

// ── Saturday ~05:30 ET, once a week ──
function marker(): string | null { try { return fs.readFileSync(MARKER, "utf8").trim(); } catch { return null; } }
function setMarker(d: string) { try { fs.mkdirSync(path.dirname(MARKER), { recursive: true }); fs.writeFileSync(MARKER, d, "utf8"); } catch {} }

async function tick() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === "weekday")?.value;
  const hh = +(parts.find((p) => p.type === "hour")?.value || "0");
  const mm = +(parts.find((p) => p.type === "minute")?.value || "0");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  if (wd !== "Sat") return;
  if (hh * 60 + mm < 5 * 60 + 30) return;   // before 05:30
  if (marker() === today) return;            // already ran this Saturday
  try {
    const r = await runClean(true);
    setMarker(today);
    if (r.deleted?.length) console.log(`fullsail-clean: removed ${r.deleted.length} completed event(s)`);
  } catch (e: any) { console.log("fullsail-clean auto run failed:", String(e?.message || e)); }
}
setTimeout(() => { tick(); setInterval(tick, 30 * 60_000); }, 150_000); // check every 30 min
