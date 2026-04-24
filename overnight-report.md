# Gloss overnight report — 2026-04-23

Branch: `maestro/overnight-gloss-20260423`
Commits on branch (3): `305c7ee`, `78b3cff`, `394a681`
Baseline tests: 128 passing. Final tests: 155 passing (+27 new). All green.

## Shipped

- **SPEC 4 — Vector search (Task A)**
  - `vec.js` module wrapping `sqlite-vec` with a TEXT-id → INTEGER-rowid map
    (vec_map) so Gloss's UUID entity ids work with vec0's integer rowid
    requirement. Degrades to no-op when the extension can't load.
  - `ai.embed(text)` → `Float32Array(768)` via Gemini `text-embedding-004`.
    Deterministic pseudo-embedding fallback when no API key / on error so
    ingest never fails on embedding errors. `ai.embedBatch(texts, {pauseMs})`
    for the backfill script.
  - Hybrid search: `db.hybridSearchPages(q, {queryVector, limit})` merges
    FTS5 + vec_cosine_similarity, normalizing each to [0..1] and scoring
    `0.6 * semantic + 0.4 * fts`. Wired into `GET /api/search` (pages bucket)
    and `POST /api/research-briefing` (local pages source).
  - `GET /api/pages/:id/related` → top-3 semantically similar pages, excludes
    self, 200 with `{items:[]}` when vec is cold or page has no embedding.
  - Fire-and-forget `queueEmbed(kind, id, text)` helper attached to every
    page-ingest path (main image ingest, voice-text ingest, voice-audio
    ingest — both streaming and non-streaming). Embedding failures are logged
    but never block ingest.
  - `scripts/backfill-embeddings.mjs` — resumable; batch=100, 200ms pause,
    skips rows that already have a vec_map entry. Supports `--dry` and
    per-kind targeting (`pages`, `collections`, `people`, `scripture_refs`,
    `books`, `artifacts`, `topics`).
  - Dockerfile: build-time sanity check (`node -e "require('sqlite-vec').
    getLoadablePath()"`) so a missing prebuilt fails the build loudly
    instead of at first search query in prod. sqlite-vec pulls its
    linux/amd64 prebuilt via npm optionalDependencies.

- **Gloss bloat (Task B)**
  - G-B-01: consolidated the 4 duplicated
    `findHouseholdByMention||upsertHouseholdByName + linkPageToHousehold`
    blocks into a single `upsertHousehold(mention, {pageId, confidence,
    roleSummary})` helper. Exposed via `module.exports.__test.upsertHousehold`.
  - G-B-02: `listCommitmentsTimeline` now reads project rows from
    `collections` (kind='project') — the one-shot migration already copies
    them there. `seed-compass.js` already had zero projects references.
  - G-B-03: `/api/markdown-drafts/*` audit — endpoints are actively used from
    7 spots in `public/index.html` (create, list, get, PATCH, DELETE,
    commit). Kept. No deletion.
  - G-B-04: replaced bare `try { db.exec(ALTER/DROP INDEX) } catch {}` in
    `db.js` with a `safeMigrate(sql, expectedNeedles)` wrapper that only
    swallows the specific idempotency errors (`duplicate column name`,
    `no such index`) and re-raises anything else.

- **Integrations (Task C)**
  - `chatWithGemini(args)` alias over `chatWithActions`.
  - `chatWithClaude(args)` stub that delegates to Gemini (ANTHROPIC_API_KEY
    not available — see Deferred).
  - `chat_sessions.model` column + `db.setChatSessionModel` /
    `db.getChatSessionModel`. `chatWithActions` now accepts `model` and the
    `/api/chat/sessions/:id/messages` router passes `session.model` through.
  - `POST /api/chat/select-model` with whitelist validation, 400 on invalid
    model (returns `supported` list), 404 on unknown session, null reset to
    default.

- **Structured logging (Task D)**
  - `log.js` exposing `log(level, event, ctx)`, `log.child(base)`,
    `log.httpMiddleware()`, `log.outbound()`, `log.recent({since, level,
    limit})`, `log.clear()`, `log.size()`. Every entry is both pushed to a
    1000-entry ring buffer and emitted as JSON-lines on stderr. Standard
    correlation fields (`trace_id`, `request_id`, `duration_ms`) are hoisted
    from ctx to top level.
  - HTTP middleware: logs `event: 'http'` for every request with
    method/path/status/duration_ms/trace_id, echoes `X-Trace-Id` back, and
    accepts an incoming trace id matching `[A-Za-z0-9_-]{8,128}` or mints a
    UUID.
  - `GET /api/logs/recent?since=<ISO>&level=<min>&limit=<N>` bearer-gated.
  - Replaced every `console.*` call in `server.js` (57 sites) and `ai.js`
    (5 sites) with `log()`, preserving context fields as keys. `google.js`
    and `comms.js` had no `console.*` calls.

## Deferred

- **Claude-vs-Gemini dual-provider chat (G-I-01 / C-I-02)** — Maestro recs
  #11 and #12. ANTHROPIC_API_KEY not provisioned; `chatWithClaude` is a stub
  that delegates to Gemini. Full implementation (@anthropic-ai/sdk with
  prompt caching over memory block + 5-min TTL, model whitelist extension,
  router dispatch) documented in the recs.
- **Per-page "Related entries" chip in `public/index.html`** — Maestro rec
  #13. Backend is ready (`GET /api/pages/:id/related`); UI skipped per
  plan guidance ("skip the UI piece … file a Maestro recommendation" if
  adding the block safely requires rewriting page structure).
- **Full removal of the `projects` table** — Maestro rec #14. The migration
  already copies projects → collections and `listCommitmentsTimeline`
  reads from collections. The deprecated `projects` table + its
  `ensureColumn` calls remain for data-migration safety.

## Bugs fixed

- None found in-scope. The existing ensureColumn('chat_sessions', 'model',
  ...) call order bug would have been pre-existing had this work ever
  shipped — it was fixed as part of Task C.

## Tests

- Final: **155 passing, 0 failing** (baseline was 128).
- New test files:
  - `tests/log.test.js` — 9 tests (ring buffer bound, level filter,
    since filter, field hoisting, HTTP middleware trace-id, trace-id
    generation, bearer enforcement, entries endpoint, level filter on
    endpoint).
  - `tests/vector.test.js` — 6 tests (vec readiness, embed dims,
    round-trip set/search, hybrid surfaces semantic-only match, related
    endpoint excludes self + limits 3, backfill resumability).
  - `tests/household.test.js` — 5 tests (helper exposed, create,
    upsert idempotent, page link, empty-mention no-op).
  - `tests/chat-model.test.js` — 7 tests (whitelist shape, resolver
    fallback, round-trip, invalid → 400, null reset, missing session_id
    → 400, unknown session → 404).

## Questions filed

- 4 Maestro recommendations filed (IDs: 11, 12, 13, 14).

## Notes for orchestrator

- `sqlite-vec` installs its platform-specific binary via npm
  `optionalDependencies`. Dev ran + tested on darwin-arm64. Dockerfile
  includes a sanity check that will fail the build if the linux-x64
  prebuilt isn't pulled — `npm ci --omit=dev` should fetch it automatically
  for the linux/amd64 Fly runtime.
- `queueEmbed` is fire-and-forget. First deploy after merge will have no
  embeddings; run `node scripts/backfill-embeddings.mjs` once on the Fly
  machine (or against a local copy of the DB pulled via Litestream) to
  populate. The script is idempotent and resumable.
- All existing `/api/telemetry/nightly` endpoints are intact.
