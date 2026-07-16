/**
 * GET /api/command-center — compiles Master Planner + Command Center for Dave's Hub.
 *
 * Drop-in Express router for the existing `master-planner-sync` service, which
 * already holds the Notion OAuth token. Mount it there so the token stays
 * server-side; romeobravos.net is a public page and must never carry a secret.
 *
 *   const commandCenter = require('./command-center');
 *   app.use(commandCenter({ notion, cache: 60 }));
 *
 * PRIVACY — deliberate, not an oversight:
 * Lead Pipeline and Client Accounts hold Email / Mobile / Consent Record (incl. IP).
 * romeobravos.net has no authentication, so this endpoint emits COUNTS ONLY.
 * Never add a field here that names a lead or carries their contact details.
 */

'use strict';

const DB = {
  masterPlanner:  'ea197010-90f0-821d-8091-81532d222f25',
  importantDates: 'bc4dc23d-42a9-4e96-a09f-3f5635ec9ad2',
  contentPipeline:'06a3feb9-d8f1-4942-880e-e07a93945c4d',
  leadPipeline:   'ad597dfe-b497-4894-a7d8-8fabfcab4a5c',
  clientAccounts: '15db944d-bdcc-4fe0-9872-21a0af794144',
  caseStudies:    'b77f764e-117a-479c-a667-069bda16995b'
};

const TYPE_TO_KIND = {
  '🎂 Birthday':    { kind: 'birthday',  recurring: true  },
  '🇺🇸 Holiday':     { kind: 'date',      recurring: true  },
  '📌 Appointment': { kind: 'date',      recurring: false },
  '🎓 Assignment':  { kind: 'date',      recurring: false },
  '🔔 Reminder':    { kind: 'date',      recurring: false }
};

const plain = (rich) => (rich || []).map((r) => r.plain_text || '').join('').trim();

async function queryAll(notion, database_id, opts = {}) {
  const out = [];
  let cursor;
  do {
    const res = await notion.databases.query({ database_id, start_cursor: cursor, page_size: 100, ...opts });
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function getImportantDates(notion) {
  const rows = await queryAll(notion, DB.importantDates, { sorts: [{ property: 'Date', direction: 'ascending' }] });
  return rows.map((p) => {
    const props = p.properties || {};
    const type = props.Type?.select?.name || '';
    const map = TYPE_TO_KIND[type] || { kind: 'date', recurring: false };
    const start = props.Date?.date?.start || '';
    return {
      id: p.id.replace(/-/g, ''),
      name: plain(props.Event?.title),
      date: start.slice(0, 10),
      time: start.length > 10 ? start.slice(11, 16) : '',
      kind: map.kind,
      recurring: map.recurring,
      type
    };
  }).filter((d) => d.name && d.date);
}

/** Today's Work/Learn/Play priorities from the Master Planner page body. */
async function getPriorities(notion) {
  const today = new Date();
  const heading = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const blocks = await notion.blocks.children.list({ block_id: DB.masterPlanner, page_size: 100 });
  let idx = blocks.results.findIndex(
    (b) => b.type === 'heading_1' && plain(b.heading_1?.rich_text) === heading
  );
  if (idx === -1) return [];

  // Walk forward to the first column_list after today's date heading; bail at the next h1.
  const prios = [];
  for (let i = idx + 1; i < blocks.results.length; i++) {
    const b = blocks.results[i];
    if (b.type === 'heading_1') break;
    if (b.type !== 'column_list') continue;

    const cols = await notion.blocks.children.list({ block_id: b.id, page_size: 50 });
    for (const col of cols.results) {
      const kids = await notion.blocks.children.list({ block_id: col.id, page_size: 50 });
      for (const k of kids.results) {
        if (k.type !== 'callout') continue;
        const text = plain(k.callout?.rich_text);
        const m = text.match(/^\*{0,2}(Work|Learn|Play)\*{0,2}\s*[—–-]\s*(.+)$/is);
        if (m) prios.push({ kind: m[1], text: m[2].replace(/\s+/g, ' ').trim() });
      }
    }
    if (prios.length) break;
  }
  return prios;
}

/** Aggregate counts only — see the PRIVACY note at the top of this file. */
async function getRevenue(notion) {
  const countOf = async (id) => {
    try { return (await queryAll(notion, id)).length; } catch { return null; }
  };
  const content = await queryAll(notion, DB.contentPipeline).catch(() => []);
  const byStatus = content.reduce((acc, p) => {
    const s = p.properties?.Status?.select?.name || 'Unknown';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  const [leads, clients, cases] = await Promise.all([
    countOf(DB.leadPipeline), countOf(DB.clientAccounts), countOf(DB.caseStudies)
  ]);

  const rows = [
    { label: 'Content queue',      value: String(content.length) },
    { label: 'Scripted & dated',   value: String(byStatus.Scripted || 0) },
    { label: 'Published',          value: String(byStatus.Published || 0) },
    { label: 'Case studies',       value: String(cases ?? 0) },
    { label: 'Leads in pipeline',  value: String(leads ?? 0) },
    { label: 'Client accounts',    value: String(clients ?? 0) }
  ];
  return { contentQueue: content.length, byStatus, rows };
}

module.exports = function commandCenter({ notion, cache = 60 } = {}) {
  const express = require('express');
  const router = express.Router();
  let hit = { at: 0, body: null };

  router.get('/api/command-center', async (req, res) => {
    if (hit.body && Date.now() - hit.at < cache * 1000) {
      res.set('Cache-Control', 'no-store');
      return res.json(hit.body);
    }
    try {
      // One slow database must not take the whole payload down.
      const [dates, priorities, revenue] = await Promise.all([
        getImportantDates(notion).catch(() => []),
        getPriorities(notion).catch(() => []),
        getRevenue(notion).catch(() => null)
      ]);
      const body = { found: true, syncedAt: new Date().toISOString(), importantDates: dates, priorities, revenue };
      hit = { at: Date.now(), body };
      res.set('Cache-Control', 'no-store');
      res.json(body);
    } catch (err) {
      // Serve stale over erroring — the client shows "showing last known".
      if (hit.body) return res.json(hit.body);
      res.status(502).json({ found: false, error: 'notion_unavailable' });
    }
  });

  return router;
};
