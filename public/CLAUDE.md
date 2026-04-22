# CLAUDE.md — Foxed frontend (`public/`)

The entire UI lives in one file: [index.html](index.html), currently ~9700 lines. Vanilla JS, no framework, no build step, no bundler, no TypeScript. This is deliberate — see root [CLAUDE.md](../CLAUDE.md) stop-ship #10.

## Shell (Phase 6 — palette-primary, sidebar-free)

The legacy `<aside id="sidebar">` and `#chat-dock` DOM still exist, but `<body class="compact-shell">` hides them. The live shell is:

- **`#launcher`** (top-right) — five buttons: Home, Capture, Planning, Index (opens tree drawer), ⌘K (opens cmdk palette). That's the entire always-visible chrome.
- **`#tree-drawer`** — slide-in left drawer with the unified Index tree, kind-grouped (Collections / Books / Artifacts / References / People / Topics / Scripture / My Indexes). Opened via Cmd-\\ or the Index launcher button. Fed by `GET /api/index/tree`. Each row: `[▸ label] direct/total` + an inline action strip `[↑ parent · Rename · Merge · 📥 Archive · × Delete]` (plus a "Reclassify" button on AI-generated user_indexes). Clicking the **label** opens an *entity tab* (metadata editor); clicking the **count** opens a *pages tab*.
- **`#tabbar`** + tab content — the right pane is a browser-like tab strip. Tabs persist in `localStorage['foxed.tabs.v1']`. Current tab kinds:
  - `home` → `#home-tab` surface, payload from `/api/home`.
  - `pages` (ctx ∈ page|collection|day|book|index) → routed through `showPagesView`; content lives in the original per-kind detail DIVs but they're reached via the tab system, not the sidebar.
  - `entity` (ctx ∈ edit-collection|edit-book|edit-user_index|edit-artifact|edit-reference|edit-person|edit-topic|edit-scripture) → `#entity-tab` metadata editor, per-kind form.
  - `capture` / `planning` → activates the existing `#ingest` / `#planning` surface inside the tab.
- **Global hotkeys**: `Cmd-\` toggles tree drawer, `Cmd-K` opens cmdk palette (wired to `/api/index/search`), `Cmd-W` closes active tab, `Esc` closes whichever overlay is open.

Legacy `openCollection` / `openBook` / `openDailyLog` / `openCustomIndex` / `openPage` are *wrapped* by `wrapOpenFunctions` — the wrapper calls `openPagesTab({...})` instead of the raw function unless an internal `_fromTab` sentinel is set. Don't remove the wrapper; it's how the old nav still works while routing everything through tabs.

**If you add a new surface, make it a tab ctx, not a new sidebar entry.** The sidebar is dead.

Read this file before editing `index.html`. The root CLAUDE.md covers data model and backend; this file covers the UI's design system, primitives, and the conventions that keep the single-file pattern manageable.

## File layout inside `index.html`

Top-down, the file is organized as:
1. `<head>` — `:root` design tokens, `prefers-color-scheme: dark`, the entire stylesheet (~1000 lines of CSS).
2. `<body>` — sidebar nav + one `<div id="...">` per surface (each surface is hidden until `showSurface()` activates it). Modal overlays live here too: `#cmdk-overlay`, `#pick-overlay`, `#modal-overlay`, scan-viewer, capture dialog, etc.
3. `<script>` — all JS. Grouped loosely by surface (ingest → capture → pages → collections → daily logs → scripture/people/topics/books → artifacts → references → projects → values/commitments → chat). Shared utilities at top: `api()`, `escHtml`, `escAttr`, `jsArg`, `pageCite`, `showSurface`, plus the primitives below.

Grep by function name before adding a new helper. The file is big enough that re-invention is common.

## Fonts

Loaded once at `<head>` via `/fonts/foxed.css` (self-hosted in `public/fonts/`, not Google CDN). Three faces:
- **Caveat** (`--font-hand-h`) — page/surface titles, brand mark
- **Kalam** (`--font-hand`) — card titles, "hand body" text, bullet-journal rows
- **JetBrains Mono** (`--font-mono`) — labels, citations (`→ v.X p.Y`), metadata, section headers
- **Inter** (`--font-sans`) — default body text

If you need a new weight, add to `public/fonts/foxed.css`. Do NOT add `<link href="fonts.googleapis.com">` — offline-first is intentional.

## Design tokens (in `:root`)

```
--ink / --ink-2..5   text, darkest→lightest
--paper / --paper-2..3   bg, lightest→darker
--accent             rust (oklch) — links, actives, accents
--border             soft divider
--r: 4px             only radius (also 3px and 6px hard-coded)
--shadow-card        subtle elevation
```

Dark mode is auto via `prefers-color-scheme`. Both palettes are defined; if you add a new color, add both.

## Reusable CSS primitives

These classes are the vocabulary. New surfaces should compose them, not invent their own boxes.

| Class | Purpose |
|---|---|
| `.scanpage` | 1.5px ink border, paper-2 bg, dot-grid `::before`, 3px-offset shadow — the "a scan sits here" look |
| `.footnote-rail` | Right-side rail with dashed left border, holds entity citations next to a scan |
| `.two-rail` | Flex wrapper for scan + footnote-rail layouts |
| `.bjrow` | Bullet-journal row: mono symbol · kalam text · mono cite on the right |
| `.card` | Standard boxed container (used on Home, Collections, etc.) |
| `.chip` / `.chip.accent` / `.chip.ghost` / `.chip.soft` | Pill badges |
| `.pill` / `.pill.ghost` / `.pill.accent` | Button style |
| `.btn-ghost` | Minimal text-only button (used for inline row actions) |
| `.idx-del` | × delete button on index rows — always the rightmost action |
| `.index-entry` / `.index-label` / `.index-count` / `.index-pages` | Expandable index row (label + count, with hidden detail panel below) |
| `.sk-lbl` / `.sk-meta` / `.sk-title` | Section label / metadata caption / big heading |
| `.pick-row` / `.pick-row.active` / `.pick-row.create` / `.pick-row.clear` | Rows inside the `pickOrCreate` overlay |

## Index row action pattern (MUST match across all indexes)

Every auto-index row — topics, people, collections, books, artifacts, references, scripture, user_indexes — uses the same action-button order in the `#tree-drawer`:

```
[↑ parent]  [Rename]  [Merge]  [📥 Archive]  [× Delete]   (+ [Reclassify] on AI user_indexes)
```

All of these call the unified `/api/index/:kind/:id/<action>` endpoint family — don't wire a new kind to its own per-kind endpoint; extend the switch in server.js `/api/index/*` handlers instead. `treeActionRename/Merge/Archive/Delete/Parent/Reclassify` in index.html are the UI dispatchers.

- **↑** is only present if the kind has a "parent" concept:
  - topics → parent topic (`openSetTopicParentDialog`)
  - people → household (`openSetHouseholdDialog`)
  - collections → parent collection (`openSetParentDialog`)
  - artifacts → filing (`openSetArtifactFilingDialog`)
  - books do NOT have a parent concept (author is structural, not an action)
- **Rename** = `prompt()` for new label → PATCH `/api/<kind>/:id`.
- **Merge** = `pickOrCreate({ allowCreate: false, allowClear: false })` over the other rows of that kind → confirm → POST `/api/<kind>/:id/merge-into` (topics/people use PATCH `{label: target}` which triggers merge-on-collision in `updatePerson`/`updateTopicLabel`).
- **📥 Archive** only for collections + artifacts (they have `archived_at`).
- **× Delete** is last. Confirms, then DELETE. For artifacts: deletes versions + links too; for everything else: purges `links` pointing at the row.

When adding a new index surface, replicate this strip. Users rely on the muscle memory.

## Preserving index state across mutations (MUST)

Any row-level action on an index surface (delete / rename / merge / archive / set-parent / set-filing / reclassify / …) that ends by calling the surface loader (`loadPeople()`, `loadCollections()`, `loadBooks()`, `loadArtifacts()`, `loadIndexes(kind)`) MUST wrap that reload in `preserveIndexState(containerId, reloadFn)`.

```js
// bad — collapses every expanded panel and scrolls to the top
await api(`/api/people/${id}`, 'PATCH', { label: next });
loadPeople();

// good — keeps expanded rows open and preserves scroll position
await api(`/api/people/${id}`, 'PATCH', { label: next });
preserveIndexState('people', loadPeople);
```

`containerId` is the surface `<div>` id (`collections`, `people`, `books`, `artifacts`, `indexes`). The helper captures which `.index-pages` panels are visible (by `id`) and the `#main` scroll position before the reload, then restores both after the DOM rebuild. Panel ids must be stable across reloads — they already are for everything under `.index-entry[data-entity-id]` because ids like `idx-people-<id>` or `cmt-row-<id>` are derived from entity IDs.

If you introduce a new surface, make sure your row-panel ids are deterministic functions of entity IDs so this helper keeps working. Don't use random/timestamp-based ids.

## `pickOrCreate` — the type-ahead modal

One function, two modes:

```js
const result = await pickOrCreate({
  title: 'Merge "X" into…',
  placeholder: 'Type to filter…',
  options: [{ id, label, sublabel? }],
  allowCreate: false,    // true = show "+ create X as new" row
  allowClear:  false,    // true = show "(clear)" row
});
// result is null (cancelled), or { action: 'pick'|'create'|'clear', item?, label? }
```

Use it for:
- **Merging** (`allowCreate: false, allowClear: false`) — merge only into existing entities.
- **Setting parent / household / filing** (`allowCreate: true, allowClear: true`) — user can pick, type a new one, or clear.

Keyboard: ↑/↓ navigate, Enter selects, Esc cancels, click-outside closes. The overlay is defined once in HTML (`#pick-overlay`) and reused; don't clone it per surface.

**Never** fall back to a numbered-prompt `window.prompt()` for merge/parent/filing dialogs. We already tore those out because they were user-hostile.

## Surfaces

Every surface is a `<div id="...">` inside `<main>`, hidden by default. `showSurface(name)` toggles display and fires the loader (`loadCollections()`, `loadPeople()`, etc.). New surfaces:
1. Add the `<div>` to HTML.
2. Add a nav entry under the right sidebar section (Capture / Library / Working).
3. Add `showSurface` handling + the load function.

Sidebar sections use `.rail-sec` for the small uppercase-mono headers.

## Pages-in-context viewer (the unified entry point)

Anything that means "show me pages of <thing>" — a single page, a collection's pages, a day's pages, a book's pages, a custom-index's pages — should route through `showPagesView({ctx, id, focus})`. The five existing detail surfaces (`#page-detail`, `#collection-detail`, `#book-detail`, `#custom-index-detail`, daily-log inline tiles) are scheduled to collapse into one `#pages` surface, and `showPagesView` is the entry point that won't change when that lands.

```js
showPagesView({ ctx: 'page',       focus: pageId })
showPagesView({ ctx: 'collection', id: collectionId, focus: pageId? })
showPagesView({ ctx: 'day',        id: dailyLogId,   focus: pageId? })
showPagesView({ ctx: 'book',       id: bookId,       focus: pageId? })
showPagesView({ ctx: 'index',      id: userIndexId,  focus: pageId? })
```

Backend: `GET /api/pages/context?ctx=<...>&id=<...>&focus=<...>` returns the same `{header, tiles, focus}` shape across kinds. Use it from new code; the per-kind endpoints stay alive for backwards compatibility.

## Chat dock

The chat dock (`#chat-dock`) is a session-aware assistant. Toggle with Cmd-J. UI elements:
- `#chat-toggle-btn` (with `#chat-toggle-badge` for unread count)
- Session list (☰), new session (＋), memory inspector (⚙)
- Action cards rendered as `.chat-msg.action` with Accept (`a`) / Reject (`r`) buttons

Action proposals come back from `chatWithActions` as `{kind:'action', action}`. Render the diff inline with `.chat-action-args`; never auto-execute. Memory is user-inspectable through the ⚙ button — every key/value the assistant writes is visible and deletable.

## Modals and overlays

- `#cmdk-overlay` — global Cmd-K search.
- `#pick-overlay` — the type-ahead above.
- `#modal-overlay` — generic modal host; reused for page detail, voice-memo capture, artifact detail, etc. One at a time.
- Scan viewer has its own lightweight overlay.

Only one overlay should be `.open` at a time. If you need nested picking, finish the first interaction before opening the second.

## Calling the API

Always use `api(path, method?, body?)`. It sets `Content-Type: application/json`, stringifies, parses JSON back, and throws on non-2xx with the server's `error` field surfaced as the message. Don't use raw `fetch()` unless you need a non-JSON response (scan image, file download).

## Adding a new action button

Inline, minimal HTML:
```js
`<button class="btn-ghost" onclick="event.stopPropagation();yourHandler('${escAttr(id)}', ${jsArg(label)})">Action</button>`
```

- **Always** `escAttr` for attribute-injected ids and `jsArg` for any string you're interpolating into JS.
- **Always** `event.stopPropagation()` on inline row-action clicks so you don't also trigger the row's expand handler.
- The handler goes in the appropriate script section and ends with the surface's loader (`loadPeople()`, `loadIndexes('topics')`, etc.) so the UI reflects the new state.

## What NOT to do

- Do not introduce a framework, bundler, JSX, or TypeScript.
- Do not add npm frontend deps. Frontend deps are zero today and that's the feature.
- Do not hotlink fonts — use `/fonts/` only.
- Do not write styles inline except for dynamic padding/position values. All reusable styles belong in `<style>`.
- Do not create a new file under `public/` for "just this one feature." The single-file invariant is load-bearing — it's what makes hand-editing + `/` searching tractable.
- Do not invent a new modal pattern when `pickOrCreate` + `#modal-overlay` cover the use case.
- Do not quote the user's raw notebook text in the UI. Only `items.text` (pointer-summaries) and `pages.raw_ocr_text` (transcript endpoint) exist; the UI shows the former. See root stop-ship #3.
