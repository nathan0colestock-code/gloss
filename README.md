# Gloss

A single-user, local-first companion to a paper bullet journal.

You scan notebook spreads (images or multi-page PDFs) or paste voice-memo transcripts. Gloss uses Gemini to parse each logical page into structured entries — entities, collections, scripture references, people — and gives you a searchable, threaded index of everything you've written by hand.

Nothing stored in Gloss quotes your prose verbatim. Every entry is a pointer-summary back to the scan.

---

## Surfaces

### Capture
Upload scans (images or PDFs) or transcripts. Gloss parses each logical page into entities, collections, and references.

![Capture interface with notebook upload and volume selector](docs/screenshots/capture.png)

### Log
Calendar view of your notebook entries, organized by date. Click any day to see the pages you captured.

![April 2026 calendar showing entries per day](docs/screenshots/log.png)

### Index
Browse collections, people, topics, scripture references, books, artifacts, and references. All auto-indexed and linked from your scans.

![Index view with tabs for collections, artifacts, people, topics, scripture, books, references](docs/screenshots/index.png)

### Research Briefing
Capture → **✎ Briefing** opens `/research.html`. Type (or dictate) a topic; gloss searches your notebook + comms + black in parallel, optionally asks Gemini to weave a short narrative, and renders a print-friendly page with citations back to specific notebook spreads (e.g. "Notebook 3, page 14"). Designed for sermon prep — print it, go offline, write.

### View in Comms
People with priority ≥ 1 on their detail page show a "View in Comms" link that deep-links into the matching contact profile in the comms app. Powered by the public `/api/suite-config` endpoint.

---

## Stack

- **Server:** Node.js + Express
- **Database:** SQLite via `better-sqlite3` (WAL + FTS5)
- **AI:** Google Gemini (`gemini-2.5-pro` for parse, `gemini-2.5-flash` for probe/chat)
- **Frontend:** Single vanilla-JS file (`public/index.html`) — no framework, no build step
- **PDF rendering:** Poppler (`pdftoppm` + `pdfinfo`)

---

## Prerequisites

- Node.js 20+
- [Poppler](https://poppler.freedesktop.org/) — `pdftoppm` and `pdfinfo` must be on PATH
  - macOS: `brew install poppler`
- A [Gemini API key](https://aistudio.google.com/apikey)

---

## Setup

```bash
git clone <repo-url>
cd gloss
npm install
cp .env.example .env
# Edit .env and set GEMINI_API_KEY
npm run dev
```

The server starts on port 3747 (or `PORT` from `.env`). The `data/` directory (database, scans, uploads) is created automatically on first run.

---

## Configuration

See [`.env.example`](.env.example) for all options. Required:

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Required. Powers all parse, reexamine, and chat calls. |
| `PORT` | Optional. Defaults to `3747`. |
| `GOOGLE_OAUTH_CLIENT_JSON` | Optional. Path to OAuth client JSON for Google Docs/Drive content fetch on artifacts and references. |

---

## Comms integration (optional)

If you also run [Comms](../comms) — the iMessage + Gmail + Calendar
aggregator — Gloss can push priority people (anyone with
`priority >= 1` on their profile) to it on a 15-minute interval. Comms
uses the push to show per-person notebook context, generate AI
insights, and prep meeting briefs for calendar events whose attendees
appear in your notebook.

Enable by setting both variables in `.env`:

```
COMMS_URL=http://localhost:3748
COMMS_API_KEY=<bearer key from Comms .env>
```

A small `comms` pill appears in the sidebar when the push is
configured — green for recent success, amber for stale, red for last
error. `/api/comms/status` exposes the same snapshot as JSON.

---

## One-shot seed scripts

Run these once on a fresh database (start the server first so the DB file is created):

```bash
node seed-compass.js               # Weekly Compass values + long-range commitments
node scripts/seed_roles_volume.js  # Roles/Areas entities + Volume D page tags
node scripts/seed_compass_planning.js  # Planning hub: mission, habits, relationships
```

All three are idempotent — safe to re-run.

---

## Project layout

```
server.js          HTTP server, ingest pipeline, chat assistant, planning hub
db.js              Schema + every data function (no ORM)
ai.js              Gemini calls (parse / reexamine / voice / probe / chat)
google.js          OAuth + Google Docs/Drive text export
public/index.html  Entire frontend (one file)
seed-compass.js    One-shot seed script
scripts/           Additional one-shot utilities
data/              Created at runtime — database, scans, uploads (gitignored)
```

---

## Ingest

Drop a scan (JPEG/PNG or PDF) or paste a voice-memo transcript through the UI. The pipeline:

1. PDF pages are rendered to PNG via `pdftoppm` at 220 dpi
2. Each page is probed cheaply for headers and page numbers
3. `gemini-2.5-pro` parses each logical page into structured entries
4. Entities (people, topics, scripture, collections) are upserted and linked
5. Threading markers (`continued from / to`) are detected and applied
6. Auto-classification files pages into any matching user indexes

---

## Suite siblings

Gloss is the **personal knowledge graph** node of a five-app personal suite. The apps are independent processes that talk over HTTP with Bearer auth; each runs on [Fly.io](https://fly.io) and backs up SQLite to Cloudflare R2 via [Litestream](https://litestream.io). Gloss additionally runs a daily rclone sync of its scan images to R2.

| App | Role | How it integrates with Gloss |
|---|---|---|
| **[comms](https://github.com/nathan0colestock-code/comms)** | iMessage + Gmail + contacts hub | Gloss pushes contact profiles to Comms via `POST /api/gloss/contacts` when people are added/edited in gloss |
| **[scribe](https://github.com/nathan0colestock-code/scribe)** | Collaborative document editor | Scribe links documents to gloss collections via `GET/POST /api/gloss-links/*` |
| **[black](https://github.com/nathan0colestock-code/black)** | Personal file search (Drive, Evernote, iCloud → indexed) | Black search results can deep-link to matching gloss pages |
| **[maestro](https://github.com/nathan0colestock-code/maestro)** | Overnight orchestration (capture → worker → test → merge → deploy) | Maestro polls `GET /api/status` and can dispatch feature sets that touch Gloss |

All five apps expose a suite-standard `GET /api/status` returning `{ app, version, ok, uptime_seconds, metrics }`, protected by Bearer auth using either the app's own `API_KEY` or a shared `SUITE_API_KEY`.

Integration contracts between pairs of apps live in `docs/INTEGRATIONS/` in the primary repo for each contract.

---

## License

Private.
