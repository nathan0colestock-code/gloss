# CLAUDE.md — Gloss

## For agents working in parallel

This repo has three load-bearing files that nearly every change touches: `server.js` (~4500 lines), `db.js` (~5700 lines), `public/index.html` (~4100 lines, one file). If two agents work at once, coordinate by **vertical slice, not by file**:

- One agent owns the feature end-to-end (db helper + endpoint + UI wiring). Don't split "agent A writes the SQL, agent B writes the UI" — the contract drifts.
- The frontend has its own scoped notes: see [public/CLAUDE.md](public/CLAUDE.md).
- The Gemini call contracts (request shape, response shape, field-by-field rules) live in [ai.js.CLAUDE.md](ai.js.CLAUDE.md). Read it before editing any prompt or the `savePageFromParse` handler.
- If you MUST touch the same file in parallel, split by region: `db.js` is loosely grouped (Pages / Entities / Links / Backlog / People / Households / Collections / Books / Artifacts / References / User indexes / Google). Stay in your region.
- Before adding a new helper, grep for an existing one — many already exist and the file is big enough that re-invention happens.

## What this is

Gloss (the repo is called `foxed` for historical reasons) is a single-user, local-first companion to a paper bullet-journal. The user scans notebook spreads (single images or multi-page PDFs) or pastes voice-memo transcripts. Gemini parses each logical page into a `pages` row, `items` rows (pointer-summaries, never verbatim), and entity/hint bundles. The server is Node + Express + `better-sqlite3` (WAL, FTS5). The UI is one vanilla-JS file: `public/index.html`. No framework, no build step. Tests live under `tests/` (node:test, real sqlite).

Invariant above all invariants: **the notebook is sovereign**. Nothing stored in Gloss may quote the user's prose verbatim — every `items.text`, `page.summary`, `link.role_summary` is a pointer-summary. `pages.raw_ocr_text` is the one place raw text lives and it must never reach the UI except via `/api/pages/:id/transcript`.

## Repo layout

```
server.js        ~4500 lines — HTTP, ingest pipeline, Google fetch, re-examine, chat assistant, planning hub
db.js            ~5700 lines — schema + every data function (no ORM); rocks/habits/chat tables
ai.js            ~1100 lines — Gemini calls (parse / reexamine / voice / probe / chatWithActions / classifier / index suggest)
google.js        ~340  lines — OAuth + Docs/Drive text export
comms.js         ~145  lines — optional push of priority people to the Comms app
public/index.html ~4100 lines — the entire frontend, one file
tests/           — node:test suite; runs with real sqlite files under data/test-*.db
seed-compass.js  — one-shot seed script for initial values rows
data/foxed.db    — SQLite (WAL)
data/scans/      — every uploaded page image / PDF-rendered PNG
data/artifacts/  — artifact file versions
data/references/ — reference files
```

Run: `npm run dev` (port 3747). `pdftoppm` and `pdfinfo` (Poppler) must be on PATH for PDF ingest.

### Environment

See [.env.example](.env.example). The only hard requirement is `GEMINI_API_KEY`. `server.js` has an inline loader (no dotenv package), so simple `KEY=VALUE` per line — no `export`, no `${…}` interpolation.

### One-shot scripts

- `node seed-compass.js` — seeds `values_versions` with the user's Weekly Compass values + the long-range goals as commitments. Idempotent (skips slugs/text that already exist). Run once on a fresh DB.
- `node scripts/seed_roles_volume.js` — seeds `entities` with `kind='role'` / `kind='area'` rows tied to the user's compass, and tags existing pages as Volume D. Idempotent. Run once after `seed-compass.js` if you want the Roles/Areas surface to have content.
- `node scripts/seed_compass_planning.js` — seeds the Planning hub: Mission (`values_versions slug='mission'`), the 12 Compass habits (tagged with role_id where obvious), and the 12 Relationships-to-Improve (people with priority=1 + default growth note). Idempotent: skips by label match and never clobbers a growth note the user has already written. Run after the two scripts above.

None are wired into `npm run dev` — run by hand. All require `data/foxed.db` to exist (starting the server once is enough).

## Feature intentions

Each surface below has a **purpose** (what the feature is for) and an **invariant** (what a future change must not break).

### Collections (`collections` table, kinds: `topical`, `monthly_log`, `future_log`, `index`)
Purpose: user-named threads of pages that share a subject or structure. Created on-demand from Gemini's `collection_hints` during ingest. `daily_log` is NOT a collection kind anymore — it was migrated out (see `db.js` ~line 287). Topical collections are the main way the user browses across non-adjacent pages.
Invariant: `UNIQUE(kind, title COLLATE NOCASE)`. Rename/merge happens in `renameCollection` — a clashing title merges by re-pointing every `links.to_id` from the old collection to the new one, then deleting the old row. Do not break the merge path.

### Daily logs (`daily_logs` table — first-class, NOT a collection)
Purpose: the calendar spine. One row per ISO date (`YYYY-MM-DD`), created lazily when a page or voice memo is filed to that day. `listDailyLogs` returns a full-month calendar view even for days with no entries. A page links to at most one daily_log via `links.to_type='daily_log'`; a daily_log may link outward to collections via `links.from_type='daily_log'`.
Invariant: `daily_logs.date UNIQUE`. `scan_path` for a voice memo is `voice:<pageId>` (sentinel — don't try to serve it as a file). Never reintroduce `collections.kind='daily_log'` — the migration assumes it won't come back.

### Scripture / People / Topics (auto-indexes)
Purpose: three "auto" indexes Gemini populates from page content. `scripture_refs` has canonical labels like `Nehemiah 6:1-8` + `book/chapter/verse_start/verse_end` for sort. `people` is its own table (label unique, priority, growth_note, **first_names CSV for aliases**). `topics` live in the generic `entities` table with `kind='topic'` and a self-referential `parent_id` for grouping. All three expose page-mention counts and a `role_summary` on each link explaining why that entity appears on that page.
Invariant: every page↔entity link also writes `role_summary` when available — the indexes are worthless without it. Rename/merge (`updatePerson`, `updateTopicLabel`, `updateScriptureLabel`) repoints every link then deletes the old row. After a merge the row must disappear, not linger.

### Alias memory (`people.first_names`)
Purpose: durable learning from backlog answers. When Gemini can't disambiguate a first-name reference, it queues a `backlog_items` question like `Who is "Baz"?`. When the user answers "Boaz Prince", the PATCH handler in `server.js` (1) upserts the canonical person, (2) calls `addPersonAlias` to append "Baz" to `people.first_names`, (3) links the source page, (4) auto-closes other pending backlog rows asking the same alias, (5) re-examines every page mentioning "Baz" in the background. On future ingests `getKnownAliases()` is passed to Gemini as a durable aliases block so it emits the canonical person directly — no re-asking.
Invariant: `addPersonAlias` is idempotent and never duplicates. The aliases block is *additive* to the recent-30-answered-Qs block, not a replacement. Don't remove the recent-answers block — short-answer free-text answers don't always extract cleanly, and the raw Q/A still helps Gemini.

### Page threading (`pages.continued_from` / `pages.continued_to`)
Purpose: a page that continues a thought across notebook pages carries threading markers — bottom-left corner = "continued from p.N", bottom-right corner = "continued to p.N". Gemini detects these during parse. `applyThreadingForPage` runs after collection assignment and does 4 passes: (1) inherit collections from `continued_from` page (or N-1 if the parse flagged this as a mid-thought continuation); (2) push this page's collections to `continued_to` if it exists; (3) stitch retroactively from any existing DB page that points at THIS page; (4) gap-bridging — if page N has no topical/daily-log links and both N-1 and N+1 share a topical collection, link N to it too.
Invariant: threading runs synchronously after `assignPageToCollections` in `savePageFromParse`. Don't move it earlier (collections must exist first) and don't make it async (see races section — savePageFromParse must not await). Gap-bridging is conservative — it only links if *both* neighbors share a collection; weakening that will over-group.

### Books (`books` table)
Purpose: bibliographic notes. A page ingested with user-declared `kind='book'` or detected as book-notes gets a book row auto-created (title+author match is case-insensitive). `books.author_entity_id` points at a **topic** entity so the author threads alongside other topic mentions.
Invariant: when creating a book with an author, reuse or create a `kind='topic'` entity — do NOT create a `kind='person'` person for the author. Author as topic is the convention. Merge via `mergeBookInto(sourceId, targetId)` — moves page→book links (deduping), deletes source.

### Artifacts (`artifacts` + `artifact_versions`)
Purpose: tracking filed physical material the notebook describes (sermons, SOPs, handouts). Filing location (`drawer`/`hanging_folder`/`manila_folder`) is free text. An artifact can have multiple file versions uploaded under `data/artifacts/`. An `external_url` pointing at a recognized Google Docs/Drive URL triggers content fetch via `google.js` (swallowed failures write `fetched_error`).
Invariant: an artifact can be linked to collections AND user_indexes; `linkBetween` dedupes. Archiving sets `archived_at`; list queries respect it where filtered. `deleteArtifact` cascades versions + links — use it only when the user explicitly chose delete (the index UI offers both archive and delete). Merge via `mergeArtifactInto(sourceId, targetId)` — moves both incoming (page→artifact) and outgoing (artifact→collection/index) links plus versions.

### References (`reference_materials`)
Purpose: external resources the notebook annotates (URL, article, podcast, video). Structurally like artifacts but without filing-location or versions. Same Google-fetch path on `external_url`.
Invariant: must have at least one of `file_path` or `external_url` — `POST /api/references` enforces this. Frontend currently only surfaces `linked_collections`; artifact-style `linked_indexes` is not wired for references.

### Projects / Commitments / Values
Purpose: a lightweight governance surface. **Projects collapsed into `collections` with `kind='project'`** (Phase 2 migration in `db.js` — see the one-shot `INSERT INTO collections … FROM projects` block). The `projects` table still exists and the `/api/projects` endpoints survive as deprecation shims that return the matching collections; new code should hit `/api/collections?kind=project` directly. `collections` gained `description`, `target_date`, `status` columns to absorb the project shape. `commitments` are short text pledges optionally tagged with a `value_slug` AND optionally tethered to a collection via `commitments.collection_id`. `values_versions` is **append-only** — editing a value creates a new row with `version = previous + 1`; `currentValues` joins on `MAX(version) per slug`. **Mission lives here as `slug='mission'`** (also append-only).
Invariant: never UPDATE an existing `values_versions` row; always insert a new version. `(slug, version)` is UNIQUE. History matters — don't delete old versions.

### Planning hub (`/planning`, formerly Commitments)
Purpose: one scrollable page that composes mission, values, roles & areas, weekly rocks, daily habit scorecard, and the commitments list. The sidebar entry "Commitments" is now "Planning". Backed by `GET /api/planning` which returns everything in one round-trip: `{week_start, week_days, mission, values, roles, rocks, habits, streaks, commitments}`. ISO Monday is the week anchor (`_isoMondayOf` in `db.js`).
New tables (Phase 4): `rocks(id, title, role_id, week_start, status, created_at, completed_at)` with `UNIQUE(title, week_start)`; `habits(id, label, role_id, active_from, active_to, archived_at, sort_order)`; `habit_checks(habit_id, date, checked, PRIMARY KEY(habit_id, date))`. Rocks can link to a collection via the polymorphic `links` table (`from_type='rock', to_type='collection'`) so supporting pages surface beneath them.
Invariant: rocks are scoped to a single ISO week (Mon–Sun). Habit-check streaks are computed server-side from contiguous past `checked=1` rows ending at today.

### Chat assistant (`/api/chat/sessions`, `/api/chat/messages`, `/api/chat/memory`)
Purpose: multi-turn assistant with durable memory and a bounded action catalog. The user can say things like "J— is Jake Thompson" or "merge these two topics", the assistant proposes an action card, the user clicks Accept (or Reject), and the action runs server-side. Replaces the earlier single-turn `POST /api/chat` (which still works as a shim that creates a throwaway session). Refine / Augment / edit-summary are increasingly funneled through chat actions rather than the page-detail viewer.
Action catalog (v1, in `ai.js → ASSISTANT_SYSTEM`): `rename_entity`, `merge_entities`, `add_person_alias`, `link_page_to_collection`, `unlink`, `refine_page`, `edit_page_summary`, `set_parent`, `remember`. Each has a hand-rolled JSON schema validated server-side in `_validateAction` (`server.js`).
Memory: `chat_memory(key, value)` is a tiny KV store the assistant writes via the `remember` action. Inspectable & deletable through `GET /api/chat/memory` and the dock's ⚙ button — nothing is silently remembered.
Invariant: every action goes through Accept/Reject — no auto-execute in v1. The pointer-summary stop-ship still applies; the system prompt restates it. `chatWithActions` returns either `{kind:'text', text}` or `{kind:'action', action}` — never both.

### Unified Index tree + any-to-any parents (Phase 6)

Purpose: every indexable kind — Collections, Books, Artifacts, References, People, Topics, Scripture, User Indexes — shares **one tree, one row UX, one endpoint family**. The sidebar is dead: navigation is palette-primary (Cmd-K) + on-demand tree drawer (Cmd-\\) + right-pane tabs. See [public/CLAUDE.md](public/CLAUDE.md) for the shell.

Backbone table: `index_parents(id, child_kind, child_id, parent_kind, parent_id, created_at, UNIQUE(child_kind, child_id, parent_kind, parent_id))`. DAG — multi-parent allowed, cycles forbidden (`setIndexParent` walks ancestors before insert). Legacy `collections.parent_id` and `entities.parent_id` rows were copied in at migration time; columns stay but new code reads/writes through `index_parents` only.

Endpoint family (`server.js`):
- `GET  /api/index/tree?archived=active|all` — kind-grouped tree with recursive page counts.
- `POST /api/index/:kind/:id/rename   { label }`
- `POST /api/index/:kind/:id/merge    { into_id }`
- `POST /api/index/:kind/:id/archive  { archived }`
- `POST /api/index/:kind/:id/delete`
- `POST /api/index/:kind/:id/parent   { parent_kind, parent_id }`    // additive
- `DELETE /api/index/:kind/:id/parent { parent_kind, parent_id }`
- `GET  /api/index/search?q=…`                                       // cmdk fuel

AI-described indexes live as `user_indexes` rows with `is_ai_generated=1` and a `structure_description` column. Slots are just child `user_indexes` linked via `index_parents` — structurally identical to a hand-made user_index. Endpoints: `POST /api/user-indexes/ai`, `/ai/suggest`, `/ai/accept`, `POST /api/index/:id/reclassify`, `POST /api/bootstrap/entities`. See [ai.js.CLAUDE.md](ai.js.CLAUDE.md) for the three new AI call contracts.

Auto-classification runs AFTER each save via `classifyPageForIndexesInBackground` — fire-and-forget via `setImmediate` so it never holds up ingest. Confidence ≥ 0.75 creates a link with `role_summary`; 0.50–0.75 creates a dedup'd backlog `filing` item; < 0.50 is dropped. `touchUserIndexClassifiedAt` stamps the index after each pass.

Right-pane home (`GET /api/home`) is the empty-state when no tab is open: current commitments grouped by value, active rocks with their linked collections, recent topical collections, and recent captures. Replaces the earlier broken home view.

Role-summary is the **primary caption** on every tile reached via an index context — never the page summary. The page summary is secondary. Tiles from `/api/pages/context` include a `role_summary` field when `ctx ∈ collection|book|index`.

Invariants:
- Cycle guard in `setIndexParent`. Multi-parent is allowed; cycles are not.
- `deletePagesByScanPath` now cascades `index_entries.page_id` + dangling `links` rows (re-parse fix). Any future page-delete path must do the same.
- Page counts use a recursive CTE over `index_parents ∪ links` with `SELECT DISTINCT page_id` — don't switch to a plain SUM or multi-parent pages double-count.
- The pointer-summary invariant applies to AI slot descriptions AND classifier-generated `role_summary`. The system prompts restate it; don't weaken.
- No `await` was added to `savePageFromParse` — classifier is `setImmediate`-scheduled after the synchronous save returns.

### Unified pages-context endpoint (`GET /api/pages/context`)
Purpose: Phase 1.5 dispatcher endpoint that consolidates "show me pages in context" across five entry points (page / collection / day / book / index). Query params: `ctx`, `id`, `focus`. Returns `{ctx, header, tiles, focus}`. The five existing per-kind endpoints (`/api/pages/:id/detail`, `/api/collections/:id`, `/api/daily-logs/:id`, `/api/books/:id`, `/api/user-indexes/:id`) stay as-is for other callers; this one adds a uniform shape for a future unified viewer. The matching JS entry point is `showPagesView({ctx, id, focus})` in `public/index.html`.
Future work: collapse the five detail surface blocks (`#page-detail`, `#collection-detail`, `#book-detail`, `#custom-index-detail`, plus the inline daily-log tiles) into a single scan-dominant `#pages` surface backed by this endpoint. New callers should already use `showPagesView()` so the future migration is a one-place rewire.

### User indexes (`user_indexes` + `index_entries`)
Purpose: user-curated cross-cuts. Each user_index has an optional `query` string that, when set, runs `searchItems(query)` on render AND matches collections/books by title/description LIKE. Users can also manually pin pages or items via `index_entries`.
Invariant: `user_indexes.title UNIQUE COLLATE NOCASE`. Deleting a user_index first deletes its `index_entries`. A manual entry can have `page_id` or `item_id` or both null-ish; tolerate all three.

### Refine (free-form hint → reexamine)
Purpose: the user tells Gloss something Gemini missed (e.g. "J— is Jake Thompson" or "this page is about sabbath not productivity"). `reexaminePageInBackground` re-runs Gemini over the scan with that hint + current known entities, applies rename/replace/summary revisions, and links any newly-confident entities. Triggered on two paths: explicit `/api/pages/:id/refine`, and when a backlog question is answered.
Invariant: reexamine is best-effort and must never throw to the caller — internal try/catch wraps everything. The `newlyConfirmed` argument is either `{kind:'hint', label:<string>}` (free-form) or `{kind:'person'|'scripture'|'topic', label:<string>}` (augment).

### Chat (`/api/chat`)
Purpose: single-turn Q&A over the notebook. Resolves `@mentions` to concrete entities, combines with FTS hits + date-scoped hits, dedupes by item id, caps context at 15 items, sends to Gemini flash with `CHAT_SYSTEM`. Responses cite `→ v.X p.Y`.
Invariant: the LLM must not see verbatim user prose; it sees only item.text (already pointer-summaries). `CHAT_SYSTEM` forbids quoting — don't weaken it.

### Roles / Areas (`entities` kind='role' / 'area')
Purpose: tags a collection can carry (e.g. role="Pastor", area="Family"). Linked via `links.from_type='collection' to_type='entity'`.
Invariant: Roles and Areas live in the same generic `entities` table as topics, differentiated only by `kind`. `deleteRoleOrArea` restricts `AND kind IN ('role','area')` — preserve that guard.

### Backlog / Ingest failures
Purpose: `backlog_items` captures low-confidence filings, disambiguation questions, and link proposals emitted by Gemini during parse. Answering a question fires reexamine AND (for person-identity questions) feeds the alias memory system above. `ingest_failures` records scans that failed parse so the user can retry or dismiss.
Invariant: `insertBacklogItems` dedupes on three axes: (1) identical-subject pending, (2) identical-subject *ever* answered, (3) for person-ID questions, any phrasing variant (`Who is "X"?` / `Identify person: X` / `Clarify mention of X` / `Unclear name "X"`) that names the same person. Don't weaken any of the three — AI phrasing drift across runs was the source of repeat-question complaints.

### Index row actions (UI convention)
Every auto-index row in the sidebar — topics, people, collections, books, artifacts — follows the same action-button pattern, in this order: **↑ parent/filing** (if the kind has one), **Rename**, **Merge**, **📥 Archive** (only collections + artifacts), **× Delete**. All merge dialogs use the `pickOrCreate` type-ahead modal with `allowCreate:false` so merge can only target an existing entity. Parent-setters use `pickOrCreate` with `allowCreate:true, allowClear:true`. See [public/CLAUDE.md](public/CLAUDE.md) for the full pattern and why new index surfaces must match it.

## Schema overview

Tables: `pages`, `items` (+ `items_fts` FTS5 virtual), `entities`, `links`, `backlog_items`, `collections`, `scripture_refs`, `people`, `projects`, `values_versions`, `commitments`, `artifacts`, `artifact_versions`, `reference_materials`, `user_indexes`, `index_entries`, `ingest_failures`, `google_tokens`, `books`, `daily_logs`.

**Polymorphic `links` table** — the central load-bearing structure:

```
links(id, from_type, from_id, to_type, to_id, created_by, confidence, role_summary)
```

Known `from_type` values: `page`, `collection`, `daily_log`, `artifact`, `reference`.
Known `to_type` values: `collection`, `daily_log`, `scripture`, `person`, `topic`, `entity` (roles/areas), `book`, `artifact`, `reference`, `user_index`.

Invariants the polymorphic table relies on (NOT enforced by the DB):
- `to_id` must reference a row in the table implied by `to_type`. Nothing prevents a stale link after a row is deleted. Deletes that matter (`deletePerson`, `deleteScriptureRef`, `deleteTopicEntity`, `deleteBook`, `deleteCollection`, `deletePagesByScanPath`) explicitly purge links. Anything new that deletes an entity MUST do the same.
- Entity-link `to_type` must match entity `kind`: `to_type='topic'` ↔ `entities.kind='topic'`, `to_type='role'|'area'` is NOT used — roles/areas use `to_type='entity'` and the consumer filters on `entities.kind`. Don't confuse these two conventions.
- Rename/merge paths (`renameCollection`, `updatePerson(label)`, `updateTopicLabel`, `updateScriptureLabel`, `reclassifyPersonAsTopic`) repoint `links.to_id` with bulk `UPDATE` — they do **not** dedupe, so a page that happened to link to both the source and destination ends up with two identical links. If you see duplicate-link bugs, this is where they come from.

Indexes: `idx_links_target (to_type, to_id)`, `idx_links_source (from_type, from_id)`, plus per-table indexes on `daily_logs.date`, `books.author_entity_id`, `books.title`. `backlog_items` has **no index on status or context_page_id** — add one if query volume grows.

## Ingest pipeline

The flow from "user dropped a scan" to "pages exist in the DB with entities, collections, and threading." All of this lives in `server.js` + `ai.js` + `db.js`; there is no framework abstraction between them.

**Entry points** (all feed the same core):
- `POST /api/ingest/stream` (server.js:127) — NDJSON streaming response. Single image OR PDF. What the UI uses.
- `POST /api/ingest` (server.js:83) — non-streaming JSON, same core.
- `POST /api/ingest/voice` (server.js:274) — transcript text → `parseVoiceMemo` → same `savePageFromParse` tail.

**Core pipeline** (`ingestSingleImage` / `ingestPdf` → `savePageFromParse`):

1. **Upload + routing** — `multer` writes the upload to `data/scans/<uuid>.ext`. If `.pdf`, route to `ingestPdf`; else route to `ingestSingleImage`. User can pass `kind=book|artifact|reference|page` (form field) which becomes a parser hint.
2. **PDF split** (PDFs only, `ingestPdf` at server.js:727) — `pdfinfo` reads page count, then `pdftoppm` renders pages to PNG at 220dpi. Renders run with concurrency 4, each rendered page goes into a parse queue.
3. **Probe** (PDFs only, `probePageHeader`) — a cheap `gemini-2.5-flash` call on each rendered page returns `{header, kind_guess, page_number, continued_from, continued_to}`. Probes are cached per-scan and combined into a `documentOutline` string so the full-parse pass can see what's on neighboring pages.
4. **Parse** (`parsePageImage` in ai.js) — `gemini-2.5-pro` call with the scan + `priorContext` (last 5 pages' summaries) + `recentAnswered` (last 30 backlog Q/A) + `knownHouseholds` + `knownAliases` + `documentOutline` + optional `userKindHint`. Returns `{pages: [PAGE_OBJECT, …]}` — one image can yield multiple logical pages (spread or mixed-kind splits). See [ai.js CLAUDE.md](ai.js.CLAUDE.md) for the full response contract.
5. **Save** (`savePageFromParse` for each logical page, server.js:611):
   - Insert `pages` row (with `continued_from` / `continued_to` corner markers).
   - Insert `items` rows (pointer-summaries, never verbatim).
   - For each parsed entity: upsert + link. Person names go through `resolvePersonReference` which disambiguates by recency and may queue a backlog question. Scripture canonicalizes (`book/chapter/verse_start/verse_end`). Topics use the shared `entities` table. Household mentions upsert a household.
   - Insert `backlog_items` from parse output.
   - `assignPageToCollections` / `assignPageToBooks` / `assignPageToArtifacts` / `assignPageToReferences` read the four hint arrays and create/link accordingly.
   - `applyThreadingForPage` runs **synchronously** (4 passes — see the Page threading invariant above). Don't add `await` inside this tail.
6. **Post-save tagging** (`applyRoleAreaTags`) — the ingest form can pass `role_ids` / `area_ids`; these are linked to both the new page and every newly-created collection.
7. **Stream emit** — `/api/ingest/stream` writes NDJSON events: `{type:'start',page_count}`, `{type:'page',page}`, `{type:'done',…}`, `{type:'error',…}`. The UI renders each `page` event immediately so PDFs feel live.

**Async after save**: answering a backlog question in `PATCH /api/backlog/:id` calls `reexaminePageInBackground` for the context page AND every page matching the newly-learned alias. Reexamine re-runs parse with `knownEntities` + `newlyConfirmed` + the whole alias/answered context, and applies rename/replace/summary revisions. It is best-effort — errors are swallowed.

**Tunables** (server.js:723-725): `PDF_DPI=220`, `PDF_RENDER_CONCURRENCY=4`, `PDF_PARSE_CONCURRENCY=8`. Rendering concurrency is CPU-bound (`pdftoppm` subprocess); parse concurrency is I/O-bound (Gemini calls). Raise parse concurrency if you hit API latency; lower it if you hit Gemini rate limits.

**Race invariant**: no `await` between SELECT and INSERT inside `savePageFromParse` (see Known sharp edges → Races). If you add an async step, read that section first.

## Known sharp edges

### Migrations
- All schema changes are `CREATE TABLE IF NOT EXISTS` at the top of `db.js`, followed by idempotent `ALTER TABLE ADD COLUMN` blocks. Pattern: `pragma('table_info(X)').map(c=>c.name); if (!cols.includes('Y')) db.exec('ALTER TABLE X ADD COLUMN Y')`. Use this pattern for any new column.
- **UNIQUE constraints added after the fact do NOT apply to existing DBs** (because `CREATE TABLE IF NOT EXISTS` no-ops on existing tables). `collections.UNIQUE(kind, title)`, `people.label UNIQUE`, `scripture_refs.canonical UNIQUE`, `user_indexes.title UNIQUE`, `daily_logs.date UNIQUE` — all silently absent on pre-existing tables. If you need a new uniqueness guarantee, write an explicit migration with a unique index.
- The legacy daily_log migration (db.js ~287–322) runs once on startup if any `collections.kind='daily_log'` rows remain. Do not remove it; do not add new `kind='daily_log'` collections.

### FTS5 query escaping
- `searchItems(query)` uses `items_fts MATCH ?` with whatever the caller passes. Callers MUST strip FTS meta-chars: `q.replace(/['"*]/g, ' ').trim()`. See `server.js /api/search`, `/api/chat`, and `getUserIndexDetail`. FTS5 still chokes on column-filter syntax (`foo:bar`) and bare `NOT`/`AND`/`OR` — every caller wraps the `searchItems` call in try/catch and falls back to LIKE.

### Voice memo sentinel
- `scan_path` on a voice-memo page is `voice:<pageId>`. `pages.scan_path` is NOT NULL, so this is the sentinel. The UI detects voice via `source_kind === 'voice_memo'` OR `scan_path.startsWith('voice:')`. `/api/pages/:id/scan` will 404 for voice pages — correct behavior; don't try to serve it.

### Spread de-duplication by scan_path
- One physical scan can yield multiple logical pages (a left/right spread, or two dated sections on one side). `savePageFromParse` creates a `pages` row per logical page; all share the same `scan_path`. The UI groups by `scan_path` (see `public/index.html` ~line 1807) so the spread is rendered as ONE tile with multiple captions. DO NOT change the grouping key. DO NOT rely on `pages.scan_path` being unique.
- `deletePagesByScanPath` deletes every page sharing a scan_path (used by the "re-parse scan" action) but does **not** delete `index_entries.page_id` rows — those become dangling. `TODO(intent): ask user` whether index_entries should cascade on re-parse.

### Gemini "pages" envelope
- `parsePageImage` returns `{pages: [...]}` — always an array, even for a single logical page. `ingestSingleImage` normalizes. Never pass a bare page object through the ingest pipeline.

### `updateArtifact` / `updateProject` / `updateCommitment` CAN'T CLEAR fields
- All use `COALESCE(?, col)`. Passing `''` writes empty string (COALESCE treats it as non-null). Passing actual `null` DOES clear. Frontend currently passes either the user's string or `null`, so clearing works only via `null`. If you want to clear via empty string, change the SQL.

### Races across ingest
- `upsertPerson`, `upsertScriptureRef`, `db.listBooks().find()`, `db.listArtifacts().find()`, `db.listReferences().find()` all do `SELECT` → conditional `INSERT`. Because `better-sqlite3` is synchronous and ingest workers don't await between SELECT and INSERT within a single `savePageFromParse`, cross-worker races cannot interleave inside a single page-save. But if you add an `await` anywhere inside `savePageFromParse`, races become possible (two workers both SELECT-miss, both INSERT, UNIQUE violation on the second). Don't add awaits inside `savePageFromParse`. If you must, use `INSERT ... ON CONFLICT DO NOTHING` and re-SELECT.

## Stop-ship rules

1. **Do not mock the DB in tests.** There are no tests; if you add them, use a real sqlite file under `data/test-*.db` and delete it on teardown. A mock will not catch FTS escaping bugs or migration drift.
2. **Do not break spread grouping.** The `scan_path` is the grouping key in the spread/collection/daily-log UIs. Changing `savePageFromParse` to give each logical page its own scan_path, or introducing a new "primary scan" concept, requires updating `public/index.html` line ~1807 AND `listCollectionDetail`/`listDailyLogs` callers.
3. **Do not quote the user verbatim.** Every `items.text`, `page.summary`, `role_summary` is a pointer-summary. `pages.raw_ocr_text` is the only verbatim store and only the voice-transcript endpoint surfaces it (and only to the user, not to other LLMs downstream).
4. **Never `CREATE TABLE` with a new UNIQUE constraint on an existing table name.** It will silently no-op. Use a migration that builds a unique index.
5. **Never hard-delete a page without also deleting its links.** `deletePagesByScanPath` is the reference pattern — copy it. Same for entity deletes (`deletePerson`, `deleteScriptureRef`, `deleteTopicEntity`, `deleteBook`, `deleteCollection`).
6. **Daily logs are NOT collections.** Don't route a daily_log through any collection API. The one-time migration at db.js:287 assumes the kind is extinct in `collections`.
7. **Values are append-only.** No UPDATE to `values_versions`.
8. **Don't swallow Google-fetch errors silently past `fetched_error`.** The column exists so failures stay visible in the UI — don't stop writing to it.
9. **Don't add frontend routes for endpoints the server doesn't have.** Current wiring is complete; verify in `server.js` before calling a new URL.
10. **`npm run dev` is the only way to run.** No build step, no TypeScript, no lint. Keep it that way unless explicitly asked.
11. **No per-kind detail surface.** Every "pages in context" view goes through `showPagesView({ctx,id,focus})` + the tab bar. Don't invent `#foo-detail` div #6 — extend the ctx switch in `/api/pages/context` and open a tab.
12. **No new sidebar entry.** The legacy `<aside id="sidebar">` is hidden by `body.compact-shell`. New surfaces are tab ctxs (`home|pages|entity|capture|planning|…`), not nav items.
13. **Index row actions go through `/api/index/*`.** Don't add a new per-kind rename/merge/archive endpoint. Extend the switch in the unified handler instead.

## TODO(intent) for the user

- `TODO(intent): ask user` — should `deletePagesByScanPath` (re-parse scan) also cascade-delete `index_entries.page_id` rows that reference the deleted pages? Currently they dangle.
- ~~`ai.js` / prompts say "Claude"~~ — cleaned up; all mentions in code comments now correctly reference Gemini.
- ~~rename/merge paths do not dedupe~~ — addressed in Phase 3 via `renameOrMergeEntity` which DELETEs duplicate `(from_type, from_id, to_type, to_id)` rows after the bulk UPDATE.
- ~~references missing `linked_indexes`~~ — addressed in Phase 5; `POST /api/references/:id/links` now accepts `to_type=user_index` and the GET response includes `linked_indexes`.
