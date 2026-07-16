import { Router } from "express";
import { getNotionClient } from "../notion/client";
import { getCalendarApi } from "../google/client";

/**
 * GET /api/sync-birthdays — pulls Google's contact birthdays into the Notion
 * Important Dates database, which feeds "Important Dates & Birthdays" in the hub.
 *
 *   ?apply=0 (default)  dry run
 *   ?apply=1            create the missing rows
 *
 * Deploys to src/routes/birthdays.ts in master-planner-sync.
 *
 * Google exposes contact birthdays as a read-only calendar,
 * addressbook#contacts@group.v.calendar.google.com. calendarList.list is 403
 * under this app's calendar.events scope, but events.list on that id works — so
 * read it directly rather than discovering it.
 *
 * One-directional by design (Google -> Notion). The reverse would mean writing
 * into someone's Contacts, which is a different blast radius than a calendar
 * entry and was not asked for.
 *
 * Dedup is by normalised name, NOT name+date: a birthday recurs every year, so
 * one row per person is the goal. Case matters here — Notion already holds
 * "Sanny's Birthday" while Google says "Sanny's birthday"; a case-sensitive
 * match would duplicate her.
 */

export const birthdaysRouter = Router();

const ALLOWED_ORIGIN = "https://romeobravos.net";
const BIRTHDAY_CAL = "addressbook#contacts@group.v.calendar.google.com";
const IMPORTANT_DATES_DB = "bc4dc23d-42a9-4e96-a09f-3f5635ec9ad2";
const BIRTHDAY_TYPE = "🎂 Birthday";

const plain = (rt: any[] | undefined): string => (rt || []).map((t: any) => t.plain_text).join("");

/** "Sanny's birthday" and "Sanny's Birthday" must collapse to the same key. */
function norm(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\bbirthday\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function existingBirthdays(notion: any): Promise<Set<string>> {
  const out = new Set<string>();
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: IMPORTANT_DATES_DB,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const p of res.results) {
      const name = plain(p.properties?.Event?.title).trim();
      if (name) out.add(norm(name));
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

birthdaysRouter.get("/api/sync-birthdays", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Cache-Control", "no-store");

  const apply = req.query.apply === "1";

  try {
    const cal = getCalendarApi();
    const now = new Date();
    const from = new Date(now.getFullYear(), 0, 1);
    const to = new Date(now.getFullYear() + 1, 11, 31);

    const events: any[] = [];
    let pageToken: string | undefined;
    do {
      const r: any = await cal.events.list({
        calendarId: BIRTHDAY_CAL,
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: true,
        maxResults: 250,
        pageToken,
      });
      events.push(...(r.data.items || []));
      pageToken = r.data.nextPageToken || undefined;
    } while (pageToken);

    // Google's contacts calendar carries anniversaries and other custom dates
    // alongside birthdays (e.g. "Kim Hall's anniversary"). Only birthdays are
    // synced: filing an anniversary under 🎂 Birthday would put a false label on
    // a real date, and Important Dates has no Anniversary type to file it under.
    const byPerson = new Map<string, { name: string; date: string }>();
    const notBirthdays: string[] = [];
    for (const ev of events) {
      const name = (ev.summary || "").trim();
      const date = ev.start?.date || (ev.start?.dateTime || "").slice(0, 10);
      if (!name || !date) continue;
      if (!/\bbirthday\b/i.test(name)) {
        if (!notBirthdays.includes(name)) notBirthdays.push(`${name} — ${date}`);
        continue;
      }
      const k = norm(name);
      if (!k) continue;
      const prev = byPerson.get(k);
      if (!prev || date < prev.date) byPerson.set(k, { name, date });
    }

    const already = await existingBirthdays(notionClient());
    const missing = [...byPerson.entries()].filter(([k]) => !already.has(k)).map(([, v]) => v);

    const report: any = {
      applied: apply,
      googleBirthdays: byPerson.size,
      alreadyInNotion: byPerson.size - missing.length,
      willAdd: missing.map((m) => `${m.name} — ${m.date}`),
      skippedNotBirthdays: notBirthdays, // anniversaries etc. — add by hand if wanted
    };

    if (!apply) {
      report.note = "dry run — nothing written. Re-run with ?apply=1 to create these rows.";
      res.json(report);
      return;
    }

    const notion = notionClient();
    const added: string[] = [];
    for (const m of missing) {
      await notion.pages.create({
        parent: { database_id: IMPORTANT_DATES_DB },
        properties: {
          Event: { title: [{ text: { content: m.name } }] },
          Date: { date: { start: m.date } },
          Type: { select: { name: BIRTHDAY_TYPE } },
          Notes: { rich_text: [{ text: { content: "Synced from Google Contacts birthdays" } }] },
        },
      });
      added.push(`${m.name} — ${m.date}`);
    }
    report.added = added;
    res.json(report);
  } catch (err: any) {
    res.status(502).json({ error: "birthday_sync_failed", detail: String(err?.message || err).slice(0, 300) });
  }
});

function notionClient() {
  return getNotionClient() as any;
}

/* ═══════════════ IMPORTANT DATES WRITE ═══════════════
   Dates added in the hub ("+ Add important date") were device-only. Same
   HUB_WRITE_KEY gate as the other write paths. */

function writeKeyOk(req: any): boolean {
  const expected = process.env.HUB_WRITE_KEY || "";
  if (!expected) return false;
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

birthdaysRouter.options("/api/important-dates", (_req, res) => {
  corsWrite(res);
  res.setHeader("Access-Control-Max-Age", "600");
  res.sendStatus(204);
});

// The hub's kinds map onto the database's Type options; "time" (a daily alarm)
// has no equivalent and is reported rather than filed under a wrong type.
const KIND_TO_TYPE: Record<string, string> = {
  birthday: "🎂 Birthday",
  date: "📌 Appointment",
};

birthdaysRouter.post("/api/important-dates", async (req, res) => {
  corsWrite(res);
  if (!writeKeyOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }

  const incoming = Array.isArray(req.body?.dates) ? req.body.dates.slice(0, 50) : [];
  if (!incoming.length) { res.json({ ok: true, created: [], skipped: [] }); return; }

  try {
    const notion = notionClient();
    const already = await existingBirthdays(notion); // normalised names already present
    const created: string[] = [], skipped: string[] = [];

    for (const d of incoming) {
      const name = String(d.name || "").trim();
      const date = String(d.date || "").slice(0, 10);
      if (!name) { skipped.push("(untitled)"); continue; }
      if (d.kind === "time" || !date) { skipped.push(`${name}: daily-time entries have no Type in Notion`); continue; }
      if (already.has(norm(name))) { skipped.push(`${name}: already in Notion`); continue; }

      await notion.pages.create({
        parent: { database_id: IMPORTANT_DATES_DB },
        properties: {
          Event: { title: [{ text: { content: name.slice(0, 200) } }] },
          Date: { date: { start: date } },
          Type: { select: { name: KIND_TO_TYPE[d.kind] || "📌 Appointment" } },
          Notes: { rich_text: [{ text: { content: "Added from Dave's Hub" } }] },
        },
      });
      already.add(norm(name));
      created.push(`${name} — ${date}`);
    }
    res.json({ ok: true, created, skipped });
  } catch (err: any) {
    res.status(502).json({ error: "important_dates_write_failed", detail: String(err?.message || err).slice(0, 300) });
  }
});

/**
 * Birthdays move once a year at most — a daily pass is plenty, and it keeps this
 * off the shared Notion/Google request budget the 5-minute syncs already use.
 */
const DAILY_MS = 24 * 60 * 60_000;
setTimeout(() => {
  const run = () =>
    fetch("http://127.0.0.1:3001/api/sync-birthdays?apply=1")
      .then((r) => r.json())
      .then((r: any) => {
        if (r?.added?.length) console.log(`sync-birthdays: added ${r.added.length}`);
      })
      .catch((e) => console.log("sync-birthdays auto run failed:", String(e?.message || e)));
  run();
  setInterval(run, DAILY_MS);
}, 90_000);
