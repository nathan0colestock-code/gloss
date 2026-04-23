'use strict';

// Comms integration — push priority people to the Comms app as "gloss_contacts".
// Disabled unless COMMS_URL and COMMS_API_KEY are both set.
//
// Payload contract lives on the Comms side — see /api/gloss/contacts and
// upsertGlossContact in comms/collect.js. Pointer-summary invariant applies:
// never send verbatim user prose — page.summary and role_summary are already
// pointer-summaries per Gloss' invariants, so they're safe to forward.

const db = require('./db');

function commsUrl() {
  return (process.env.COMMS_URL || '').replace(/\/+$/, '');
}
function commsKey() {
  return process.env.COMMS_API_KEY || '';
}
function publicOrigin() {
  return (process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 3747}`).replace(/\/+$/, '');
}

function isEnabled() {
  return !!(commsUrl() && commsKey());
}
function disabledReason() {
  if (!commsUrl()) return 'COMMS_URL not set';
  if (!commsKey()) return 'COMMS_API_KEY not set';
  return null;
}

// Build the array of contact payloads from the current DB state.
// Only priority >= 1 people are pushed — Comms' nudge + highlight logic is
// built around priority, and pushing everyone would drown the UI.
//
// Payload shape is the contract in comms/collect.js:upsertGlossContact and
// comms/public/index.html renderContactDetail:
//   recent_context:    [{ date, role_summary, collection }]    (objects)
//   linked_collections: [string]                                 (titles)
function buildContactsPayload() {
  const origin = publicOrigin();
  const people = db.listPeople();
  const payload = [];

  for (const p of people) {
    if ((p.priority ?? 0) < 1) continue;

    const aliases = (p.first_names || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    // Per-page structured context. role_summary > person_mentions > summary;
    // date comes from the daily_log if the page was filed to one, else the
    // captured_at timestamp; collection is the first linked topical collection.
    const recent_context = [];
    const firstTopicalByPage = new Map();
    for (const c of (p.collections || [])) {
      if (c.kind && c.kind !== 'project' && c.kind !== 'monthly_log' && c.kind !== 'future_log') {
        // We don't have per-page collection membership here, so we use the
        // first topical collection as a rough caption for the person. Good
        // enough for the nudge-context display.
      }
    }
    const fallbackCollection = (p.collections || []).find(c => c && c.title)?.title || null;

    for (const pg of (p.pages || []).slice(0, 5)) {
      const mentions = Array.isArray(pg.person_mentions) ? pg.person_mentions.filter(Boolean) : [];
      const role_summary = mentions[0] || pg.summary || null;
      if (!role_summary) continue;
      const date = pg.daily_log_date || (pg.captured_at ? pg.captured_at.slice(0, 10) : null);
      recent_context.push({
        date,
        role_summary,
        collection: firstTopicalByPage.get(pg.id) || fallbackCollection,
      });
    }

    // linked_collections: Comms UI renders these as plain chips (string titles).
    const linked_collections = (p.collections || [])
      .map(c => c.title)
      .filter(Boolean);

    payload.push({
      contact: p.label,
      aliases,
      gloss_id: p.id,
      gloss_url: `${origin}/#/index/person/${p.id}`,
      mention_count: p.mention_count ?? 0,
      last_mentioned_at: p.recent_page?.captured_at || null,
      priority: p.priority ?? 0,
      growth_note: p.growth_note || null,
      recent_context,
      linked_collections,
    });
  }

  return payload;
}

// POST the payload. Returns { ok, saved, errors } from Comms, or throws.
async function pushContactsToComms(contacts) {
  if (!isEnabled()) throw new Error(`comms push disabled: ${disabledReason()}`);
  const url = `${commsUrl()}/api/gloss/contacts`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${commsKey()}`,
    },
    body: JSON.stringify({ contacts }),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`comms push failed: HTTP ${res.status} ${body?.error || text || ''}`.trim());
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Convenience: build + push in one shot. Best-effort — swallows errors into
// the return value so the interval loop never crashes the server.
async function syncContactsToComms() {
  if (!isEnabled()) return { skipped: true, reason: disabledReason() };
  const contacts = buildContactsPayload();
  if (contacts.length === 0) return { skipped: true, reason: 'no priority people' };
  try {
    const result = await pushContactsToComms(contacts);
    return { ok: true, pushed: contacts.length, result };
  } catch (e) {
    return { ok: false, pushed: contacts.length, error: e.message };
  }
}

module.exports = {
  isEnabled,
  disabledReason,
  buildContactsPayload,
  pushContactsToComms,
  syncContactsToComms,
};
