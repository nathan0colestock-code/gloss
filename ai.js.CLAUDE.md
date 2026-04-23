# ai.js — Gemini contracts

Single file (~1100 lines) wrapping every Gemini call. Exports twelve functions; everything else is prompt text and a JSON salvager.

```js
module.exports = {
  parsePageImage, chat, chatWithActions, reexaminePage,
  parseVoiceMemo, parseMarkdownPage, probePageHeader,
  // Phase 6 — unified index / AI-described indexes:
  generateIndexStructure, classifyPageForIndexes, suggestMetaCategories,
  // Phase 7 — cross-kind auto-linking + topical (back-of-book) index rebuild:
  classifyRowForCrossKind, generateTopicalIndexEntries,
};
```

Read this before editing a prompt — the response shapes are consumed by `savePageFromParse` (server.js:611) and `reexaminePageInBackground` (server.js:1933), and drift between prompt and handler will silently drop data.

## Models

| Model | Used for | Why |
|---|---|---|
| `gemini-2.5-pro` (`PARSE_MODEL`) | `parsePageImage`, `reexaminePage` | Accuracy over latency — the parse is the whole value proposition. |
| `gemini-2.5-flash` (`CHAT_MODEL`) | `chat`, `probePageHeader`, `parseVoiceMemo` | Cheap + fast. Chat has a 1024-token cap; probe has 512; voice uses whatever the SDK default is. |

All calls set `responseMimeType: 'application/json'`, `temperature: 0.2` (parse/reexamine/voice) or `0.3` (chat) or `0.1` (probe).

## The five functions

### `parsePageImage(imagePath, priorContext, recentAnswered, documentOutline, userKindHint, knownHouseholds, knownAliases)`

The main ingest call. Takes an image path + six context blocks (all optional with sensible defaults), returns `{pages: [PAGE_OBJECT, ...]}`.

**Always returns `{pages: [...]}`**, never a bare PAGE_OBJECT. If Gemini returns a legacy single-page shape, the normalizer at the tail of the function wraps it. Callers rely on this — don't change it.

**PAGE_OBJECT** (see `PARSE_PROMPT` lines 48–115 for the authoritative definition):

```
volume, page_number, continued_from, continued_to   // threading markers
raw_ocr_text                                        // private verbatim, stored only in pages.raw_ocr_text
summary                                             // pointer-summary, max 12 words, NO preambles
collection_hints: [{kind,label,continuation,confidence}]
book_hints:       [{title,author_label,year,confidence}]
artifact_hints:   [{title,drawer,hanging_folder,manila_folder,confidence}]
reference_hints:  [{title,source,external_url,confidence}]
items:            [{kind,text,confidence}]          // text = pointer-summary, NEVER verbatim
entities:         [{kind,label,role_summary, + scripture-only: book,chapter,verse_start,verse_end}]
backlog_items:    [{kind,subject,proposal,answer_format?,options?}]
```

Entity `kind` ∈ `person | household | scripture | topic | date`. `role_summary` is required on every entity — the indexes are worthless without it (see root CLAUDE.md → auto-indexes invariant).

Item `kind` ∈ `task | event | idea | quote | scripture_ref | prayer | prose_block | bibliographic_note`.

Backlog `kind` ∈ `question | filing | link_proposal`. For `kind=question`, `answer_format` is REQUIRED and must be `short|long|choice`. `options` is REQUIRED when `answer_format=choice`.

**Context blocks** (composed in this exact order inside `userText`):

1. `answeredBlock` — last 30 answered backlog Q/A. Durable memory of what the user already clarified.
2. `aliasesBlock` — `Baz, Baz Prince → Boaz Prince` format. Durable memory of learned nicknames. See root CLAUDE.md → Alias memory.
3. `priorBlock` — last 5 pages' summaries. Used ONLY for collection-threading detection, NEVER as an entity source (prompt enforces this).
4. `outlineBlockText` — per-scan probe summaries so this page can see neighbors' headers across the whole PDF.
5. `householdsBlock` — known household surnames, so "the Brennekes" → "Brenneke".
6. `userKindBlock` — if the user declared `kind=book|artifact|reference`, inject a directive to emit at least one matching hint.
7. `PARSE_PROMPT` — the main instruction block (JSON shape + rules).

Order matters: the durable-memory blocks come first so Gemini has them loaded before it sees the page-specific context. Don't reorder without thinking through what Gemini will attend to.

### `reexaminePage(imagePath, knownEntities, newlyConfirmed, recentAnswered, knownAliases)`

Runs after a user answers a backlog question or fires the "refine" action on a page. Returns a DIFFERENT shape than parse:

```
{
  new_entities: [ {kind,label, +scripture-only fields, confidence} ],
  revisions: {
    rename_people:  [ {from,to} ],
    replace_topics: [ {from,to} ],
    rewrite_summary: "<new summary or null>"
  }
}
```

**There is no `new_backlog_items`** in the re-examine output (the prompt explicitly forbids it). Reexamine is strictly for correcting / augmenting, not for adding more questions.

`newlyConfirmed` is either `{kind:'hint', label:<free-form string>}` or `{kind:'person'|'scripture'|'topic', label:<confirmed entity>}`. The prompt branches on this — free-form hints get treated as directional nudges, confirmed-entity calls get treated as ground truth.

Errors and empty responses are swallowed — the function returns the empty shape `{new_entities:[], revisions:{rename_people:[], replace_topics:[], rewrite_summary:null}}`. Reexamine must never throw to the caller.

### `parseVoiceMemo(transcript, recentAnswered, knownAliases)`

Same `items` / `entities` / `backlog_items` shape as PAGE_OBJECT but without `volume / page_number / collection_hints / book_hints / artifact_hints / reference_hints / continued_from / continued_to`. Voice memos don't have pages, scans, or headers.

### `chat(query, contextItems)`

Returns a plain string. `contextItems` are already-fetched items with `{kind, text, volume, page_number, page_id}`. The prompt mandates citations (`→ v.X p.Y`), pointer-summaries only, and capped output at 10 list items.

### `probePageHeader(imagePath)`

Cheap probe used during PDF ingest. Returns `{pages: [{page_number, header, kind_guess, continuation, continued_from, continued_to}]}`. Feeds `documentOutline` for the full parse pass. Non-fatal on failure — returns `{pages: []}` and logs a warn.

### `generateIndexStructure(description)` — AI-described indexes

User writes a paragraph ("a theology index organized by the 10 theological disciplines"). This call asks `gemini-2.5-flash` for a JSON tree capped at depth 3:

```
{
  title: "<short>",
  description: "<paragraph summarizing the index's shape>",
  children: [ { label, description, children: [...] }, ... ]
}
```

Server-side (`POST /api/user-indexes/ai`) walks the tree and creates one `user_indexes` row per node, linked via `index_parents`. The root row gets `is_ai_generated=1` and `structure_description` holds both the user's input and the model's paragraph (reused as classifier context). System prompt restates the pointer-summary invariant — slot descriptions cannot quote notebook prose. Errors throw (caller shows a UI error); unlike the classifier below, structure generation is user-facing and must surface failure.

### `classifyPageForIndexes({ pageSummary, items, candidateLeaves })` — auto-classifier

Runs in the background after every save (see server.js `classifyPageForIndexesInBackground`). `gemini-2.5-flash`, `temperature=0.1`, JSON output, ~512 token cap. Input: the page's pointer-summary + its items (pointer-summaries only — `raw_ocr_text` is NOT passed, restated in the system prompt) + a list of AI-index leaf slots with their descriptions.

Returns `[{ user_index_id, confidence, role_summary }]` where `confidence` is 0..1. Server routing:
- ≥ 0.75 → `links` row `(from='page', to='user_index')` with `role_summary`.
- 0.50 – 0.75 → `backlog_items` kind=`filing` proposing the link. Dedupe key: `(index_id, page_id)`.
- < 0.50 → dropped silently.

Must never throw — swallows everything and returns `[]`. Callers use `setImmediate(() => …)` so a slow Gemini roundtrip never blocks ingest.

### `suggestMetaCategories(indexRowSample)` — meta-category proposals

`gemini-2.5-flash`, `temperature=0.4`. Input: a sampled list of index-row labels (topics, people, scripture, collections — capped at ~80) drawn from the existing DB. Returns 3–7 proposals:

```
[ { title, description, candidate_children: [{kind, id, label}] }, ... ]
```

Rendered as acceptable cards under "My Indexes → Suggestions". Accepting one calls `POST /api/user-indexes/ai/accept` which creates the root user_index and seeds `index_parents` links to the candidate children — same backbone as `generateIndexStructure`, just pre-populated with structural children rather than newly-generated leaf slots.

Errors return `[]` — suggestions are opportunistic.

### `classifyRowForCrossKind({ fromRow, candidates })` — cross-kind auto-linker

`gemini-2.5-flash`, `temperature=0.1`, `maxOutputTokens=1024`. Takes ONE "from" row (kind ∈ `collection|artifact|reference|daily_log`) plus up to 40 candidate rows of the same kind family, returns which candidates are substantively related and at what confidence.

```
Input:
  fromRow:    { kind, label, description }
  candidates: [{ kind, id, label, description }]   // up to 40, pre-ranked by bag-of-words overlap

Output:
  { matches: [{ kind, id, confidence: 0..1, role_summary }] }
```

Consumer: `classifyRowForCrossKindInBackground` in server.js. Confidence ≥ 0.75 → insert into `links` with `role_summary`. 0.50–0.74 → dedup'd `backlog_items kind='filing'`. < 0.50 → dropped.

Triggered from three paths: (1) ingest tail — `setImmediate` for every newly-created collection/artifact/reference inside `savePageFromParse`; (2) PATCH handlers — after a content-hash change on the title/description; (3) on-demand `POST /api/index/:kind/:id/find-related`.

`role_summary` flows into `links.role_summary` and is the primary caption on cross-kind tiles — it MUST be written from the FROM row's perspective, in the AI's words, ≤18 words. System prompt restates the pointer-summary invariant. Errors return `{matches:[]}` — the call is best-effort.

### `generateTopicalIndexEntries({ indexTitle, indexDescription, candidates, totalPages })` — back-of-book rebuild

`gemini-2.5-flash`, `temperature=0.1`, `maxOutputTokens=4096`. Given an AI user-index's scope and a pool of candidate entities (person/topic/scripture/collection/artifact/reference), partitions them into entries (belong in the index) and rejections (noise or off-scope).

```
Input:
  indexTitle, indexDescription
  candidates: [{ kind, id, label, page_count }]   // up to 200
  totalPages: <int — for noise judgment>

Output:
  {
    entries:  [{ kind, id, role_summary, why_included }],
    rejected: [{ kind, id, reason }]
  }
```

Consumer: `POST /api/user-indexes/:id/rebuild` in server.js. A server-side pre-filter already drops anything whose page-mention count exceeds `NOISE_FRACTION=0.25` of the vault; this call handles context-sensitive noise (e.g. "prayer" may be noise in a theology index but signal in a spiritual-disciplines index). Rejections get written to `user_index_exclusions` with `reason='auto_high_frequency'`. User-blocked exclusions and forced inclusions are applied outside this call.

System prompt explicitly: *"An entry is NOISE if it does not narrow the index — e.g. 'Bible' in a theology index touches every page; reject. 'Incarnation' narrows; accept. Always honor the provided indexDescription scope."* Pointer-summary restated.

`generateIndexStructure` also had its system prompt augmented with: *"Do not name slots after entities that appear on the majority of pages in the vault."* Preventive — keeps noise out of the AI-suggested structure before it ever reaches the user.

Errors return `{entries:[], rejected:[]}` — the server falls back to "accept all eligibles" so the rebuild still produces an index.

## Invariants across all prompts

1. **Never quote the user verbatim.** Every prompt states this explicitly. If you relax it in one place the whole pointer-summary invariant (root stop-ship #3) dies.
2. **`raw_ocr_text` is for `pages.raw_ocr_text` only.** The full-text OCR is stored so voice-transcript and scan-text endpoints can serve it, but it must never reach the UI as an item or summary.
3. **`responseMimeType: 'application/json'`** on every call. The salvager (below) assumes Gemini emits JSON.
4. **`temperature` stays low.** These are extraction tasks, not creative ones. Don't raise it.

## JSON salvage (`tryParseOrSalvage`)

Gemini occasionally truncates mid-output (hits `maxOutputTokens`). For the parse response specifically, `tryParseOrSalvage` walks the raw text looking for `"pages": [` and then scans object depth to extract as many complete page objects as possible before the truncation point. If salvage recovers anything, it sets `_salvaged: true` on the return value.

**Only `parsePageImage` uses the salvager.** Reexamine and voice use straight `JSON.parse` with a try/catch fallback to empty. If you change the top-level shape of the parse response away from `{pages: [...]}`, update the salvager's regex.

The parse response also strips an optional leading ` ```json ` fence and trailing ` ``` ` — Gemini sometimes ignores the "no markdown fences" instruction.

## Adding a new field to PAGE_OBJECT

1. Add it to the JSON shape block in `PARSE_PROMPT` (ai.js).
2. Add the handler branch in `savePageFromParse` (server.js:611).
3. If the field is an entity kind, update `reexaminePage`'s `known_entities` synthesis (server.js:1933) and the reexamine prompt shape.
4. If the field is a hint array, add a matching `assignPageTo<Kind>` helper.
5. Check the salvager still matches — it scans for `"pages": [` so new top-level keys are fine.

## Adding a new context block

1. Decide where in the `userText` ordering it belongs (durable memory first, page-specific last).
2. Add the `const xxxBlock = …` synthesis with the empty-string fallback (`const xxxBlock = data.length ? \`…\` : '';`).
3. Wire the caller (`server.js`): `ingestSingleImage` and `reexaminePageInBackground` both pull their own context via `db.xxx()` helpers. Keep both paths in sync or the aliases bug recurs.

## Gotchas

- **`knownAliases` comes from `db.getKnownAliases()`**, not from the caller's locals. Never hand-craft the aliases list — round-trip through the DB helper so you get the canonical shape.
- **`recentAnsweredQuestions`** is `db.getRecentAnsweredQuestions(30)` — a fixed window of 30, NOT all history. The aliases block handles durable learning for person names; this block handles everything else (symbol meanings, scripture clarifications, topic scoping). Don't collapse them — see root CLAUDE.md → Alias memory invariant.
- **`userKindHint`** is the FORM field `kind`, not the ingest-kind of the resulting page. It's a *hint* that the scan is a book/artifact/reference cover, which causes Gemini to emit the matching hint array even at lower confidence.
- **The "Claude" mystery** — comments in `ai.js` and `CHAT_SYSTEM`/`PARSE_SYSTEM` sometimes say "Claude" but the SDK is `@google/genai`. Don't trust the comment, read the `new GoogleGenAI({...})` at the top. See root CLAUDE.md → TODO(intent) for the user question about this.
