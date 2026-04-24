# Gloss

Gloss turns your paper bullet journal into a searchable, linked database. Take a photo of a notebook page (or paste a voice memo transcript), and Gloss reads it with Gemini, pulls out the people, topics, scripture references, and collections you mentioned, and organises everything so you can search across months of handwritten notes in seconds.

Nothing stored in Gloss quotes your prose verbatim. Every entry is a pointer-summary back to the original scan.

Part of a five-app personal suite: [maestro](https://github.com/nathan0colestock-code/maestro) · [comms](https://github.com/nathan0colestock-code/comms) · [scribe](https://github.com/nathan0colestock-code/scribe) · [black](https://github.com/nathan0colestock-code/black)

---

## Surfaces

### Capture
Upload notebook scans (JPEG/PNG or multi-page PDF) or paste a voice-memo transcript. Gloss parses each logical page into structured entries. The 🎙️ button records audio in the browser, transcribes with Gemini, and streams entity chips (people, scripture, topics) in real time as they're confirmed.

![Capture interface with notebook upload and volume selector](docs/screenshots/capture.png)

### Log
Calendar view of all entries, organised by date. Click any day to see every page captured.

![April 2026 calendar showing entries per day](docs/screenshots/log.png)

### Index
Browse everything auto-extracted: collections, people, topics, scripture references, books, artifacts, and external references — all linked back to the originating page.

![Index view with tabs for collections, artifacts, people, topics, scripture, books, references](docs/screenshots/index.png)

### Research Briefing
Type or dictate a topic; Gloss searches your notebook, your messages ([Comms](https://github.com/nathan0colestock-code/comms)), and your file archive ([Black](https://github.com/nathan0colestock-code/black)) in parallel. Gemini weaves the results into a short narrative with citations back to specific notebook spreads (e.g. "Notebook 3, page 14"). Renders as a print-friendly page — designed for sermon prep.

### Chat
Conversational interface over your notebook. Sessions are stored with their context so you can pick up threads across days. The chat has access to your full index — entities, collections, pages — and can cross-reference Comms contact history.

### Planning hub
Mission, roles, habits, and long-range commitments tracked alongside your journal entries. Seed scripts populate a weekly Compass, roles/areas structure, and a planning hub with mission and habit tracking.

### Promote to Scribe
Any note's detail view has a **→ New Scribe version** button. Creates a [Scribe](https://github.com/nathan0colestock-code/scribe) document seeded with the page's summary and raw text. Subsequent promotions appear as `v1 · v2 · …` chips.

### View in Comms
People with `priority >= 1` show a "View in Comms" link on their detail page, deep-linking to their [Comms](https://github.com/nathan0colestock-code/comms) contact profile.

### Special dates
Birthday and anniversary tracking integrated into the people index, surfaced in weekly reviews.

---

## Stack

- Node.js + Express
- SQLite via `better-sqlite3` (WAL + FTS5 full-text search)
- Google Gemini (`gemini-2.5-pro` for parse, `gemini-2.5-flash` for probe/chat)
- Single vanilla-JS frontend (`public/index.html`) — no framework, no build step
- Poppler (`pdftoppm` + `pdfinfo`) for PDF rendering
- Deployed to [Fly.io](https://fly.io); SQLite replicated to Cloudflare R2 via [Litestream](https://litestream.io)

---

## Prerequisites

- Node.js 20+
- [Poppler](https://poppler.freedesktop.org/) — `brew install poppler` on macOS
- A [Gemini API key](https://aistudio.google.com/apikey)

---

## Setup

```bash
git clone <repo-url>
cd gloss && npm install
cp .env.example .env   # set GEMINI_API_KEY
npm run dev            # server on :3747
```

The `data/` directory (database, scans, uploads) is created on first run and gitignored.

---

## Configuration

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Required. |
| `PORT` | Optional. Defaults to `3747`. |
| `COMMS_URL` + `COMMS_API_KEY` | Optional. Enables contact push and cross-search in briefings. |
| `GOOGLE_OAUTH_CLIENT_JSON` | Optional. Path to OAuth JSON for Drive/Docs content fetch. |

---

## Comms integration (optional)

When set, Gloss pushes people with `priority >= 1` to Comms every 15 minutes. Comms uses the push to show notebook context on contact profiles and generate pre-meeting briefs.

A `comms` pill in the sidebar shows push status (green / amber / red). `/api/comms/status` exposes the same as JSON.

---

## Google Drive polling (optional)

If Google OAuth is configured, Gloss polls configured Drive folders on startup and on an interval. New Docs, Sheets, or PDFs are imported automatically. `fetched_at` and `fetched_error` are tracked per item.

---

## Ingest pipeline

1. PDF pages rendered to PNG at 220 dpi via `pdftoppm`
2. Each page probed cheaply for headers and page numbers
3. `gemini-2.5-pro` parses each logical page into structured entries
4. Entities (people, topics, scripture, collections) upserted and linked
5. Threading markers (`continued from / to`) detected and applied
6. Auto-classification into any matching user indexes

Voice captures stream entity deltas live as Gemini confirms them.

---

## One-shot seed scripts

```bash
node seed-compass.js                   # Weekly Compass values + commitments
node scripts/seed_roles_volume.js      # Roles/Areas entities + Volume page tags
node scripts/seed_compass_planning.js  # Planning hub: mission, habits, relationships
```

All idempotent — safe to re-run.

---

## Project layout

```
server.js          HTTP server, ingest, chat, planning hub, briefing, Drive polling
db.js              Schema + all data functions
ai.js              Gemini calls (parse / reexamine / voice / probe / chat / briefing)
google.js          OAuth + Google Docs/Drive text export
public/index.html  Entire frontend (one file)
data/              Created at runtime — database, scans, uploads (gitignored)
docs/INTEGRATIONS/ Integration contracts with sibling apps
```

---

## Suite siblings

Gloss is the **personal knowledge graph** node of a five-app personal suite. Independent processes, all on [Fly.io](https://fly.io), all backed up to Cloudflare R2 via [Litestream](https://litestream.io). Scan images also sync to R2 daily via rclone.

| App | What it does | How it connects to Gloss |
|---|---|---|
| **[comms](https://github.com/nathan0colestock-code/comms)** | iMessage + Gmail + contacts hub | Gloss pushes contact profiles; Comms returns timeline data for briefings |
| **[scribe](https://github.com/nathan0colestock-code/scribe)** | Collaborative document editor | "Promote to Scribe" creates docs from gloss pages; Scribe links documents back to gloss collections |
| **[black](https://github.com/nathan0colestock-code/black)** | Personal file search (Drive, Evernote, iCloud) | Black results deep-link to matching gloss pages; briefings query Black in parallel |
| **[maestro](https://github.com/nathan0colestock-code/maestro)** | Overnight code orchestration | Polls `/api/status`; dispatches feature sets; proxies voice captures via `/api/gloss/voice` |

All five apps expose `GET /api/status` → `{ app, version, ok, uptime_seconds, metrics }`, Bearer-authed.

Integration contracts live in `docs/INTEGRATIONS/` in the primary repo for each contract.

---

## License

Private.
