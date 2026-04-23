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

    // Prefer topical collections for captions; the generic-kinds (project,
    // monthly/future_log) are structural and don't read well as "why is this
    // person in your notebook" labels.
    const topicalCollections = (p.collections || [])
      .filter(c => c && c.title && (!c.kind || c.kind === 'topical'));
    const fallbackCollection = topicalCollections[0]?.title || null;

    // Per-page structured context. role_summary > summary; date comes from
    // the daily_log if the page was filed to one, else the captured_at day.
    const recent_context = [];
    for (const pg of (p.pages || []).slice(0, 5)) {
      const mentions = Array.isArray(pg.person_mentions) ? pg.person_mentions.filter(Boolean) : [];
      const role_summary = mentions[0] || pg.summary || null;
      if (!role_summary) continue;
      const date = pg.daily_log_date || (pg.captured_at ? pg.captured_at.slice(0, 10) : null);
      recent_context.push({
        date,
        role_summary,
        collection: fallbackCollection,
      });
    }

    // linked_collections: Comms UI renders these as plain chips (string titles).
    // Topical-only so we don't leak project/monthly-log chrome.
    const linked_collections = topicalCollections.map(c => c.title);

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
  return postToComms('/api/gloss/contacts', { contacts });
}

// Build notes payload: one row per (page, person) mention for every priority
// person. Each note carries a stable id so Comms upsert dedups across pushes.
// Content is the role_summary (pointer summary) or page summary — never raw
// item text, per Gloss' pointer-summary invariant.
function buildNotesPayload() {
  const origin = publicOrigin();
  const people = db.listPeople();
  const notes = [];

  for (const p of people) {
    if ((p.priority ?? 0) < 1) continue;

    const topicalCollections = (p.collections || [])
      .filter(c => c && c.title && (!c.kind || c.kind === 'topical'));
    const fallbackCollection = topicalCollections[0]?.title || null;

    for (const pg of (p.pages || [])) {
      const mentions = Array.isArray(pg.person_mentions) ? pg.person_mentions.filter(Boolean) : [];
      const noteText = mentions[0] || pg.summary || null;
      if (!noteText) continue;
      const date = pg.daily_log_date || (pg.captured_at ? pg.captured_at.slice(0, 10) : null);
      if (!date) continue;

      notes.push({
        id: `page:${pg.id}:${p.id}`,
        contact: p.label,
        date,
        note: noteText,
        collection: fallbackCollection,
        gloss_url: `${origin}/#/page/${pg.id}`,
      });
    }
  }

  return notes;
}

async function pushNotesToComms(notes) {
  return postToComms('/api/gloss/notes', { notes });
}

async function postToComms(path, payload) {
  if (!isEnabled()) throw new Error(`comms push disabled: ${disabledReason()}`);
  const url = `${commsUrl()}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${commsKey()}`,
    },
    body: JSON.stringify(payload),
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

// Convenience: build + push contacts AND notes in one shot. Best-effort —
// swallows errors per-side so the interval loop never crashes the server.
async function syncContactsToComms() {
  if (!isEnabled()) return { skipped: true, reason: disabledReason() };
  const contacts = buildContactsPayload();
  const notes    = buildNotesPayload();
  if (contacts.length === 0) return { skipped: true, reason: 'no priority people' };

  const out = { ok: true, pushed: contacts.length, notes_pushed: notes.length };
  try {
    out.contacts_result = await pushContactsToComms(contacts);
  } catch (e) {
    out.ok = false;
    out.error = e.message;
  }
  if (notes.length) {
    try {
      out.notes_result = await pushNotesToComms(notes);
    } catch (e) {
      out.ok = false;
      out.notes_error = e.message;
    }
  }
  return out;
}

module.exports = {
  isEnabled,
  disabledReason,
  buildContactsPayload,
  buildNotesPayload,
  pushContactsToComms,
  pushNotesToComms,
  syncContactsToComms,
};
