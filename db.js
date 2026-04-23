const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.TEST_DB_PATH || path.join(DATA_DIR, 'foxed.db');

fs.mkdirSync(path.join(DATA_DIR, 'scans'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    volume INTEGER,
    page_number INTEGER,
    scan_path TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    raw_ocr_text TEXT,
    summary TEXT
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES pages(id),
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    confidence REAL DEFAULT 1.0
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    text, kind,
    content='items', content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, text, kind) VALUES (new.rowid, new.text, new.kind);
  END;

  CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, text, kind) VALUES ('delete', old.rowid, old.text, old.kind);
  END;

  CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, text, kind) VALUES ('delete', old.rowid, old.text, old.kind);
    INSERT INTO items_fts(rowid, text, kind) VALUES (new.rowid, new.text, new.kind);
  END;

  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    UNIQUE(kind, label)
  );

  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    from_type TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_type TEXT NOT NULL,
    to_id TEXT NOT NULL,
    created_by TEXT DEFAULT 'foxed',
    confidence REAL DEFAULT 1.0
  );

  CREATE TABLE IF NOT EXISTS backlog_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    proposal TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    context_page_id TEXT REFERENCES pages(id),
    created_at TEXT NOT NULL,
    answer TEXT,
    answer_format TEXT,
    answer_options TEXT
  );

  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,           -- daily_log | topical | monthly_log | future_log | index
    title TEXT NOT NULL,          -- '2024-11-05' for daily_log, 'Formation' for topical, etc.
    description TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(kind, title COLLATE NOCASE)
  );

  CREATE TABLE IF NOT EXISTS scripture_refs (
    id TEXT PRIMARY KEY,
    canonical TEXT NOT NULL UNIQUE COLLATE NOCASE,
    book TEXT NOT NULL,
    chapter INTEGER NOT NULL,
    verse_start INTEGER,
    verse_end INTEGER
  );

  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL UNIQUE COLLATE NOCASE,
    priority INTEGER DEFAULT 0,
    growth_note TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    target_date TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS values_versions (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(slug, version)
  );

  CREATE TABLE IF NOT EXISTS commitments (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    value_slug TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    drawer TEXT,
    hanging_folder TEXT,
    manila_folder TEXT,
    status TEXT DEFAULT 'in_progress',
    external_url TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artifact_versions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version INTEGER NOT NULL,
    file_path TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(artifact_id, version)
  );

  CREATE TABLE IF NOT EXISTS reference_materials (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT,
    file_path TEXT,
    external_url TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_indexes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT,
    query TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS index_entries (
    id TEXT PRIMARY KEY,
    index_id TEXT NOT NULL REFERENCES user_indexes(id),
    page_id TEXT REFERENCES pages(id),
    item_id TEXT REFERENCES items(id),
    note TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_links_target ON links(to_type, to_id);
  CREATE INDEX IF NOT EXISTS idx_links_source ON links(from_type, from_id);

  CREATE TABLE IF NOT EXISTS ingest_failures (
    id TEXT PRIMARY KEY,
    scan_path TEXT NOT NULL,
    source TEXT,
    stage TEXT,
    error TEXT NOT NULL,
    status TEXT DEFAULT 'failed',
    created_at TEXT NOT NULL,
    retried_at TEXT
  );

  CREATE TABLE IF NOT EXISTS markdown_drafts (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Idempotent migration: add question-answer columns if they don't exist
{
  const cols = db.pragma('table_info(backlog_items)').map(c => c.name);
  if (!cols.includes('answer')) db.exec('ALTER TABLE backlog_items ADD COLUMN answer TEXT');
  if (!cols.includes('answer_format')) db.exec('ALTER TABLE backlog_items ADD COLUMN answer_format TEXT');
  if (!cols.includes('answer_options')) db.exec('ALTER TABLE backlog_items ADD COLUMN answer_options TEXT');
}
// Items: status for bullet-journal arrow semantics (open|done|migrated|scheduled|cancelled|note).
// Default is NULL — existing rows don't get retrofilled; new parses populate it.
{
  const cols = db.pragma('table_info(items)').map(c => c.name);
  if (!cols.includes('status')) db.exec('ALTER TABLE items ADD COLUMN status TEXT');
}
{
  const cols = db.pragma('table_info(commitments)').map(c => c.name);
  if (!cols.includes('target_date')) db.exec('ALTER TABLE commitments ADD COLUMN target_date TEXT');
  if (!cols.includes('start_date')) db.exec('ALTER TABLE commitments ADD COLUMN start_date TEXT');
  if (!cols.includes('due_date')) db.exec('ALTER TABLE commitments ADD COLUMN due_date TEXT');
}
{
  const cols = db.pragma('table_info(projects)').map(c => c.name);
  if (!cols.includes('start_date')) db.exec('ALTER TABLE projects ADD COLUMN start_date TEXT');
  if (!cols.includes('due_date')) db.exec('ALTER TABLE projects ADD COLUMN due_date TEXT');
}
{
  const cols = db.pragma('table_info(values_versions)').map(c => c.name);
  if (!cols.includes('category')) db.exec('ALTER TABLE values_versions ADD COLUMN category TEXT');
  if (!cols.includes('position')) db.exec('ALTER TABLE values_versions ADD COLUMN position INTEGER');
}
{
  const cols = db.pragma('table_info(pages)').map(c => c.name);
  if (!cols.includes('source_kind')) db.exec('ALTER TABLE pages ADD COLUMN source_kind TEXT');
  if (!cols.includes('is_reference')) {
    db.exec('ALTER TABLE pages ADD COLUMN is_reference INTEGER DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS ix_pages_is_reference ON pages(is_reference, captured_at DESC)');
  }
  if (!cols.includes('reference_label')) db.exec('ALTER TABLE pages ADD COLUMN reference_label TEXT');
  if (!cols.includes('continued_from')) db.exec('ALTER TABLE pages ADD COLUMN continued_from INTEGER');
  if (!cols.includes('continued_to'))   db.exec('ALTER TABLE pages ADD COLUMN continued_to INTEGER');
  // Rotation in degrees clockwise — 0 | 90 | 180 | 270. CSS-only rotation; the
  // underlying scan file on disk is never modified. See rotatePage() / setPageRotation().
  if (!cols.includes('rotation')) db.exec('ALTER TABLE pages ADD COLUMN rotation INTEGER DEFAULT 0');
  if (!cols.includes('deleted_at')) db.exec('ALTER TABLE pages ADD COLUMN deleted_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS ix_pages_vol_pagenum ON pages(volume, page_number)');
}
{
  const cols = db.pragma('table_info(links)').map(c => c.name);
  if (!cols.includes('role_summary')) db.exec('ALTER TABLE links ADD COLUMN role_summary TEXT');
}
{
  const cols = db.pragma('table_info(collections)').map(c => c.name);
  if (!cols.includes('summary')) db.exec('ALTER TABLE collections ADD COLUMN summary TEXT');
}
{
  const cols = db.pragma('table_info(entities)').map(c => c.name);
  if (!cols.includes('standard'))      db.exec('ALTER TABLE entities ADD COLUMN standard TEXT');
  if (!cols.includes('current_focus')) db.exec('ALTER TABLE entities ADD COLUMN current_focus TEXT');
  if (!cols.includes('priority'))      db.exec('ALTER TABLE entities ADD COLUMN priority INTEGER');
  if (!cols.includes('parent_id'))     db.exec('ALTER TABLE entities ADD COLUMN parent_id TEXT');
}
{
  const cols = db.pragma('table_info(commitments)').map(c => c.name);
  if (!cols.includes('parent_id')) db.exec('ALTER TABLE commitments ADD COLUMN parent_id TEXT');
}
{
  const cols = db.pragma('table_info(links)').map(c => c.name);
  if (!cols.includes('role')) db.exec('ALTER TABLE links ADD COLUMN role TEXT');
}
{
  const cols = db.pragma('table_info(artifacts)').map(c => c.name);
  if (!cols.includes('fetched_content')) db.exec('ALTER TABLE artifacts ADD COLUMN fetched_content TEXT');
  if (!cols.includes('fetched_at')) db.exec('ALTER TABLE artifacts ADD COLUMN fetched_at TEXT');
  if (!cols.includes('fetched_error')) db.exec('ALTER TABLE artifacts ADD COLUMN fetched_error TEXT');
  if (!cols.includes('archived_at')) db.exec('ALTER TABLE artifacts ADD COLUMN archived_at TEXT');
}
{
  const cols = db.pragma('table_info(reference_materials)').map(c => c.name);
  if (!cols.includes('fetched_content')) db.exec('ALTER TABLE reference_materials ADD COLUMN fetched_content TEXT');
  if (!cols.includes('fetched_at')) db.exec('ALTER TABLE reference_materials ADD COLUMN fetched_at TEXT');
  if (!cols.includes('fetched_error')) db.exec('ALTER TABLE reference_materials ADD COLUMN fetched_error TEXT');
  if (!cols.includes('archived_at')) db.exec('ALTER TABLE reference_materials ADD COLUMN archived_at TEXT');
  // Phase 5 — `row_type` distinguishes plain links from filed scans/clippings.
  // Default 'link'; the UI's gallery view filters to 'scan'.
  if (!cols.includes('row_type')) db.exec("ALTER TABLE reference_materials ADD COLUMN row_type TEXT DEFAULT 'link'");
}
// archived_at on people/entities/scripture_refs so the unified Index surface can
// hide-by-default without losing history. Idempotent — matches existing pattern.
{
  const cols = db.pragma('table_info(people)').map(c => c.name);
  if (!cols.includes('archived_at')) db.exec('ALTER TABLE people ADD COLUMN archived_at TEXT');
}
{
  const cols = db.pragma('table_info(entities)').map(c => c.name);
  if (!cols.includes('archived_at')) db.exec('ALTER TABLE entities ADD COLUMN archived_at TEXT');
}
{
  const cols = db.pragma('table_info(scripture_refs)').map(c => c.name);
  if (!cols.includes('archived_at')) db.exec('ALTER TABLE scripture_refs ADD COLUMN archived_at TEXT');
}
// Phase 6 — books + user_indexes archive, AI-generated indexes.
// Books didn't have archived_at. user_indexes needs it plus three columns to
// support AI-generated indexes: is_ai_generated flag, structure_description
// (the user's prompt + LLM-authored structure summary — reused as classifier
// context), and last_classified_at (timestamp of the most recent full sweep).
// books is created later in this file (line ~1077); guard so fresh DBs don't error.
{
  const booksExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='books'").get();
  if (booksExists) {
    const cols = db.pragma('table_info(books)').map(c => c.name);
    if (!cols.includes('archived_at')) db.exec('ALTER TABLE books ADD COLUMN archived_at TEXT');
  }
}
{
  const cols = db.pragma('table_info(user_indexes)').map(c => c.name);
  if (!cols.includes('archived_at'))           db.exec('ALTER TABLE user_indexes ADD COLUMN archived_at TEXT');
  if (!cols.includes('is_ai_generated'))       db.exec('ALTER TABLE user_indexes ADD COLUMN is_ai_generated INTEGER DEFAULT 0');
  if (!cols.includes('structure_description')) db.exec('ALTER TABLE user_indexes ADD COLUMN structure_description TEXT');
  if (!cols.includes('last_classified_at'))    db.exec('ALTER TABLE user_indexes ADD COLUMN last_classified_at TEXT');
}

// Phase 6 — polymorphic any-to-any, multi-parent tree.
// A child row can belong to multiple parents of any kind. Enables user-defined
// indexes to pull in collections / people / scripture / topics, and allows
// meta-category grouping without adding a parent_kind column to every table.
//
// Invariants:
// - UNIQUE(child_kind, child_id, parent_kind, parent_id) — no duplicate parent.
// - Cycle protection is enforced in setIndexParent() (walks ancestors before insert).
// - to_id/parent_id are NOT FK-enforced (polymorphic); deletions must cascade manually.
db.exec(`
  CREATE TABLE IF NOT EXISTS index_parents (
    id TEXT PRIMARY KEY,
    child_kind TEXT NOT NULL,
    child_id TEXT NOT NULL,
    parent_kind TEXT NOT NULL,
    parent_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(child_kind, child_id, parent_kind, parent_id)
  );
  CREATE INDEX IF NOT EXISTS ix_index_parents_child  ON index_parents(child_kind, child_id);
  CREATE INDEX IF NOT EXISTS ix_index_parents_parent ON index_parents(parent_kind, parent_id);
`);

// One-time migration: copy existing same-kind parent_id rows into index_parents.
// Old parent_id columns stay in place (non-destructive); new code should read
// and write via the index_parents helpers below.
// Guard on column existence so fresh DBs (where parent_id is added later via
// ALTER TABLE) don't fail — on a fresh DB there are no rows to copy anyway.
{
  const exists = db.prepare(`SELECT COUNT(*) as c FROM index_parents`).get().c;
  if (exists === 0) {
    const now = new Date().toISOString();
    const ins = db.prepare(`
      INSERT OR IGNORE INTO index_parents (id, child_kind, child_id, parent_kind, parent_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const collCols = db.pragma('table_info(collections)').map(c => c.name);
    if (collCols.includes('parent_id')) {
      const collParents = db.prepare(`SELECT id, parent_id FROM collections WHERE parent_id IS NOT NULL AND parent_id != ''`).all();
      for (const r of collParents) {
        ins.run(`ip_${r.id}_${r.parent_id}`, 'collection', r.id, 'collection', r.parent_id, now);
      }
    }
    const entityCols = db.pragma('table_info(entities)').map(c => c.name);
    if (entityCols.includes('parent_id')) {
      const topicParents = db.prepare(`SELECT id, parent_id FROM entities WHERE kind='topic' AND parent_id IS NOT NULL AND parent_id != ''`).all();
      for (const r of topicParents) {
        ins.run(`ip_${r.id}_${r.parent_id}`, 'topic', r.id, 'topic', r.parent_id, now);
      }
    }
  }
}

// Households: a group that contains people. Used to find notes on a whole family.
db.exec(`
  CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    notes TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_households_name ON households(name COLLATE NOCASE);
`);
{
  const cols = db.pragma('table_info(people)').map(c => c.name);
  if (!cols.includes('household_id')) {
    db.exec('ALTER TABLE people ADD COLUMN household_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS ix_people_household ON people(household_id)');
  }
  if (!cols.includes('first_names')) db.exec('ALTER TABLE people ADD COLUMN first_names TEXT');
}
{
  const cols = db.pragma('table_info(artifacts)').map(c => c.name);
  if (!cols.includes('notes')) db.exec('ALTER TABLE artifacts ADD COLUMN notes TEXT');
}

// Explicit UNIQUE indexes + perf indexes. `CREATE TABLE IF NOT EXISTS` no-ops
// on pre-existing DBs, so declarative UNIQUE constraints don't take effect —
// these CREATE INDEX statements back-fill them and also speed up hot queries.
// Note: ux_daily_logs_date is created after the daily_logs table below.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS ux_collections_kind_title ON collections(kind, title COLLATE NOCASE);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_scripture_canonical   ON scripture_refs(canonical COLLATE NOCASE);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_people_label          ON people(label COLLATE NOCASE);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_user_indexes_title    ON user_indexes(title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS ix_links_to                     ON links(to_type, to_id);
  CREATE INDEX IF NOT EXISTS ix_links_from                   ON links(from_type, from_id);
  CREATE INDEX IF NOT EXISTS ix_backlog_status               ON backlog_items(status);
  CREATE INDEX IF NOT EXISTS ix_backlog_context_page         ON backlog_items(context_page_id);
  CREATE INDEX IF NOT EXISTS ix_pages_volume_page            ON pages(volume, page_number);
  CREATE INDEX IF NOT EXISTS ix_index_entries_index          ON index_entries(index_id);
  CREATE INDEX IF NOT EXISTS ix_index_entries_page           ON index_entries(page_id);
`);

// =============================================================================
// Indexing sharpen — TOC vs back-of-book
// =============================================================================
// Headings group collections + artifacts into a front-of-book TOC. Multi-parent
// (one collection under many headings) and multi-level nesting (heading under
// heading) both supported — they flow through the existing index_parents DAG
// and its cycle-guard in setIndexParent().
db.exec(`
  CREATE TABLE IF NOT EXISTS headings (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    description TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_headings_label_ci ON headings(label COLLATE NOCASE);
`);
// Migration: add scope to headings so collections and artifacts have separate heading pools.
// try-catch is idempotent — SQLite throws "duplicate column name" if the column already exists.
try { db.exec(`ALTER TABLE headings ADD COLUMN scope TEXT NOT NULL DEFAULT 'collection'`); } catch {}
// Drop the old label-only unique index; the new (label, scope) composite index takes its place.
// try-catch: "no such index" on repeat runs is fine.
try { db.exec(`DROP INDEX ux_headings_label_ci`); } catch {}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_headings_label_scope_ci ON headings(label COLLATE NOCASE, scope)`);

// Exclusions / inclusions for AI-curated user_indexes. An excluded entry is
// invisible in the index listing; an included entry bypasses the noise filter.
// Exclusions carry `reason` so the UI can distinguish auto vs. user blocks.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_index_exclusions (
    id TEXT PRIMARY KEY,
    user_index_id TEXT NOT NULL REFERENCES user_indexes(id),
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_uix_excl
    ON user_index_exclusions(user_index_id, entity_kind, entity_id);

  CREATE TABLE IF NOT EXISTS user_index_inclusions (
    id TEXT PRIMARY KEY,
    user_index_id TEXT NOT NULL REFERENCES user_indexes(id),
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_uix_incl
    ON user_index_inclusions(user_index_id, entity_kind, entity_id);
`);

// content_hash + links_classified_at let the cross-kind auto-link classifier
// skip rows whose semantic body (title + description) hasn't changed since the
// last sweep. NULL links_classified_at means "never classified."
{
  const cols = db.pragma('table_info(collections)').map(c => c.name);
  if (!cols.includes('content_hash'))         db.exec('ALTER TABLE collections ADD COLUMN content_hash TEXT');
  if (!cols.includes('links_classified_at'))  db.exec('ALTER TABLE collections ADD COLUMN links_classified_at TEXT');
}
{
  const cols = db.pragma('table_info(artifacts)').map(c => c.name);
  if (!cols.includes('content_hash'))         db.exec('ALTER TABLE artifacts ADD COLUMN content_hash TEXT');
  if (!cols.includes('links_classified_at'))  db.exec('ALTER TABLE artifacts ADD COLUMN links_classified_at TEXT');
}
{
  const cols = db.pragma('table_info(reference_materials)').map(c => c.name);
  if (!cols.includes('content_hash'))         db.exec('ALTER TABLE reference_materials ADD COLUMN content_hash TEXT');
  if (!cols.includes('links_classified_at'))  db.exec('ALTER TABLE reference_materials ADD COLUMN links_classified_at TEXT');
}
// daily_logs is created later in this file; guard so fresh DBs don't error.
{
  const dlExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_logs'").get();
  if (dlExists) {
    const cols = db.pragma('table_info(daily_logs)').map(c => c.name);
    if (!cols.includes('content_hash'))         db.exec('ALTER TABLE daily_logs ADD COLUMN content_hash TEXT');
    if (!cols.includes('links_classified_at'))  db.exec('ALTER TABLE daily_logs ADD COLUMN links_classified_at TEXT');
  }
}

// Dedupe links after a merge moves (to_type,to_id) pointers. Keeps the earliest
// row per (from_type, from_id, to_type, to_id, COALESCE(role,'')).
function dedupeLinks() {
  db.exec(`
    DELETE FROM links
    WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM links
      GROUP BY from_type, from_id, to_type, to_id, COALESCE(role, '')
    )
  `);
}

// Find an existing page by (volume, page_number) — used by ingest to warn on re-upload.
function getPageByLocation(volume, page_number) {
  return db.prepare('SELECT id FROM pages WHERE volume = ? AND page_number = ? LIMIT 1').get(volume, page_number) ?? null;
}

// Merge duplicate pages that share the same (volume, page_number).
// Keeps the page with the most outgoing links; tiebreaks to oldest captured_at.
// Migrates links, items, index_entries, backlog_items then calls dedupeLinks().
// Returns { groupsFixed, pagesDeleted }.
function deduplicatePages() {
  const dupeGroups = db.prepare(`
    SELECT volume, page_number, COUNT(*) as cnt
    FROM pages
    WHERE volume IS NOT NULL AND page_number IS NOT NULL
    GROUP BY volume, page_number
    HAVING cnt > 1
  `).all();

  let groupsFixed = 0;
  let pagesDeleted = 0;

  const migrate = db.transaction((keepId, dropId) => {
    db.prepare(`UPDATE links SET from_id = ? WHERE from_id = ? AND from_type = 'page'`).run(keepId, dropId);
    db.prepare(`UPDATE items SET page_id = ? WHERE page_id = ?`).run(keepId, dropId);
    db.prepare(`DELETE FROM index_entries WHERE page_id = ?`).run(dropId);
    db.prepare(`DELETE FROM backlog_items WHERE context_page_id = ?`).run(dropId);
    db.prepare(`DELETE FROM pages WHERE id = ?`).run(dropId);
    // A page must link to at most one daily_log. If the merge produced extras, keep the earliest.
    db.prepare(`
      DELETE FROM links WHERE from_type='page' AND from_id=? AND to_type='daily_log'
      AND rowid NOT IN (
        SELECT MIN(rowid) FROM links WHERE from_type='page' AND from_id=? AND to_type='daily_log'
      )
    `).run(keepId, keepId);
  });

  for (const { volume, page_number } of dupeGroups) {
    const pages = db.prepare(`
      SELECT p.id, p.captured_at,
             (SELECT COUNT(*) FROM links WHERE from_type='page' AND from_id=p.id) AS link_count
      FROM pages p
      WHERE p.volume = ? AND p.page_number = ?
      ORDER BY link_count DESC, p.captured_at ASC
    `).all(volume, page_number);

    const [keeper, ...rest] = pages;
    for (const dup of rest) {
      migrate(keeper.id, dup.id);
      pagesDeleted++;
    }
    groupsFixed++;
  }

  if (pagesDeleted > 0) dedupeLinks();
  return { groupsFixed, pagesDeleted };
}

// --- index_parents tree helpers (Phase 6) ------------------------------------
// Any-to-any, multi-parent polymorphic tree. All mutations go through here
// so cycle protection + dedupe happen in one place.

// Preload everything listIndexTree needs in a fixed number of queries so
// _buildIndexRow doesn't issue a DB call per node. Returns a context object
// passed through the recursive tree walk.
function _loadIndexContext() {
  // All index_parents edges (one query)
  const allEdges = db.prepare(`SELECT parent_kind, parent_id, child_kind, child_id FROM index_parents`).all();

  const hasParentInSameKind = new Set(); // "kind:id" → node has a same-kind parent
  const childrenMap = new Map();         // "kind:id" → [{kind,id}]
  const parentMap   = new Map();         // "kind:id" → [{kind,id}]
  for (const e of allEdges) {
    if (e.parent_kind === e.child_kind) hasParentInSameKind.add(`${e.child_kind}:${e.child_id}`);
    const pk = `${e.parent_kind}:${e.parent_id}`;
    if (!childrenMap.has(pk)) childrenMap.set(pk, []);
    childrenMap.get(pk).push({ kind: e.child_kind, id: e.child_id });
    const ck = `${e.child_kind}:${e.child_id}`;
    if (!parentMap.has(ck)) parentMap.set(ck, []);
    parentMap.get(ck).push({ kind: e.parent_kind, id: e.parent_id });
  }

  // Row labels / metadata per kind (9 queries, one per kind, vs one per node)
  const rowMap = new Map();
  const load = (kind, rows, extra) => {
    for (const r of rows) rowMap.set(`${kind}:${r.id}`, { id: r.id, label: r.label, archived_at: r.archived_at || null, ...extra(r) });
  };

  load('heading', db.prepare(`SELECT id, label, archived_at, scope FROM headings`).all(),
    r => ({ meta: { scope: r.scope || 'collection' } }));
  load('collection', db.prepare(`SELECT id, title as label, archived_at FROM collections`).all(), () => ({}));
  load('book', db.prepare(`
    SELECT b.id, b.title as label, b.archived_at, COALESCE(e.label, b.author_label) as author
    FROM books b LEFT JOIN entities e ON e.id = b.author_entity_id
  `).all(), r => ({ meta: { author_label: r.author || null } }));
  load('artifact', db.prepare(`SELECT id, title as label, archived_at, notes FROM artifacts`).all(),
    r => ({ meta: { notes: r.notes || null } }));
  load('reference', db.prepare(`SELECT id, title as label, archived_at FROM reference_materials`).all(), () => ({}));
  load('person', db.prepare(`SELECT id, label, archived_at FROM people`).all(), () => ({}));
  load('topic', db.prepare(`SELECT id, label, archived_at FROM entities WHERE kind = 'topic'`).all(), () => ({}));
  load('scripture', db.prepare(`SELECT id, canonical as label, archived_at, book, chapter, verse_start, verse_end FROM scripture_refs`).all(),
    r => ({ meta: { book: r.book || null, chapter: r.chapter ?? null, verse_start: r.verse_start ?? null, verse_end: r.verse_end ?? null } }));
  load('user_index', db.prepare(`SELECT id, title as label, archived_at, is_ai_generated FROM user_indexes`).all(),
    r => ({ is_ai_generated: r.is_ai_generated }));

  // Direct page counts — one query (GROUP BY) instead of one COUNT per node
  const directCounts = new Map();
  for (const r of db.prepare(`
    SELECT to_type as kind, to_id as id, COUNT(DISTINCT from_id) as c
    FROM links WHERE from_type = 'page' GROUP BY to_type, to_id
  `).all()) directCounts.set(`${r.kind}:${r.id}`, r.c);

  // Total page counts (direct + inherited from all descendants) — one recursive
  // CTE for all nodes at once instead of one CTE per node.
  const totalCounts = new Map();
  for (const r of db.prepare(`
    WITH RECURSIVE tree_edges(anc_kind, anc_id, leaf_kind, leaf_id) AS (
      SELECT parent_kind, parent_id, child_kind, child_id FROM index_parents
      UNION
      SELECT t.anc_kind, t.anc_id, ip.child_kind, ip.child_id
      FROM index_parents ip JOIN tree_edges t ON t.leaf_kind = ip.parent_kind AND t.leaf_id = ip.parent_id
    ),
    all_pairs(kind, id, page_id) AS (
      SELECT to_type, to_id, from_id FROM links WHERE from_type = 'page'
      UNION
      SELECT t.anc_kind, t.anc_id, l.from_id
      FROM tree_edges t JOIN links l ON l.to_type = t.leaf_kind AND l.to_id = t.leaf_id AND l.from_type = 'page'
    )
    SELECT kind, id, COUNT(DISTINCT page_id) as c FROM all_pairs GROUP BY kind, id
  `).all()) totalCounts.set(`${r.kind}:${r.id}`, r.c);

  return { rowMap, childrenMap, parentMap, hasParentInSameKind, directCounts, totalCounts };
}

// Every index kind recognized by the tree. Extended map of the older
// _ENTITY_KIND_MAP — adds artifact, reference, user_index.
const _INDEX_KIND_TABLE = {
  heading:     { table: 'headings',             labelCol: 'label',     archiveCol: 'archived_at' },
  collection:  { table: 'collections',         labelCol: 'title',     archiveCol: 'archived_at' },
  book:        { table: 'books',               labelCol: 'title',     archiveCol: 'archived_at' },
  artifact:    { table: 'artifacts',           labelCol: 'title',     archiveCol: 'archived_at' },
  reference:   { table: 'reference_materials', labelCol: 'title',     archiveCol: 'archived_at' },
  person:      { table: 'people',              labelCol: 'label',     archiveCol: 'archived_at' },
  topic:       { table: 'entities',            labelCol: 'label',     archiveCol: 'archived_at', kindFilter: "kind='topic'" },
  scripture:   { table: 'scripture_refs',      labelCol: 'canonical', archiveCol: 'archived_at' },
  user_index:  { table: 'user_indexes',        labelCol: 'title',     archiveCol: 'archived_at' },
};
const ALL_INDEX_KINDS = Object.keys(_INDEX_KIND_TABLE);

function _indexKindSpec(kind) {
  const spec = _INDEX_KIND_TABLE[kind];
  if (!spec) throw new Error(`unknown index kind: ${kind}`);
  return spec;
}

// Resolve a (kind,id) → row with { id, label, archived_at, is_ai_generated? }.
// Returns null if the row doesn't exist (e.g. stale parent pointer).
function lookupIndexRow(kind, id) {
  const spec = _indexKindSpec(kind);
  const extra = kind === 'user_index'
    ? ', is_ai_generated, structure_description, description'
    : kind === 'heading' ? ', scope' : '';
  const where = spec.kindFilter ? `WHERE id = ? AND ${spec.kindFilter}` : 'WHERE id = ?';
  const row = db.prepare(
    `SELECT id, ${spec.labelCol} as label, ${spec.archiveCol} as archived_at${extra} FROM ${spec.table} ${where}`
  ).get(id);
  if (!row) return null;
  if (kind === 'heading') {
    row.meta = { scope: row.scope || 'collection' };
  } else if (kind === 'scripture') {
    const s = db.prepare(`SELECT book, chapter, verse_start, verse_end FROM scripture_refs WHERE id = ?`).get(id);
    if (s) row.meta = { book: s.book || null, chapter: s.chapter ?? null, verse_start: s.verse_start ?? null, verse_end: s.verse_end ?? null };
  } else if (kind === 'book') {
    const b = db.prepare(`
      SELECT b.author_label, b.author_entity_id, e.label as author_entity_label
      FROM books b LEFT JOIN entities e ON e.id = b.author_entity_id
      WHERE b.id = ?
    `).get(id);
    if (b) row.meta = { author_label: b.author_entity_label || b.author_label || null };
  } else if (kind === 'artifact') {
    const a = db.prepare(`SELECT notes FROM artifacts WHERE id = ?`).get(id);
    if (a) row.meta = { notes: a.notes || null };
  }
  return row;
}

// Does (parentKind, parentId) already appear in the ancestor chain of
// (childKind, childId)? Walks index_parents edges (not the deprecated
// parent_id columns). Used for cycle protection before INSERT.
function _isAncestor(childKind, childId, parentKind, parentId) {
  // BFS from child's parents upward
  const visited = new Set();
  const queue = [[childKind, childId]];
  while (queue.length) {
    const [k, i] = queue.shift();
    const key = `${k}:${i}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const parents = db.prepare(
      `SELECT parent_kind, parent_id FROM index_parents WHERE child_kind = ? AND child_id = ?`
    ).all(k, i);
    for (const p of parents) {
      if (p.parent_kind === parentKind && p.parent_id === parentId) return true;
      queue.push([p.parent_kind, p.parent_id]);
    }
  }
  return false;
}

// Add a parent edge (multi-parent → additive). Idempotent by UNIQUE constraint.
// Throws on cycles. Returns the edge row.
function setIndexParent(childKind, childId, parentKind, parentId) {
  _indexKindSpec(childKind);
  _indexKindSpec(parentKind);
  if (childKind === parentKind && childId === parentId) {
    throw new Error('an index row cannot be its own parent');
  }
  // Headings are TOC-only: they accept heading/collection/artifact children.
  // A heading is never a target anywhere else; and a child of a heading must
  // be one of those three kinds.
  if (parentKind === 'heading') {
    const allowed = new Set(['heading', 'collection', 'artifact']);
    if (!allowed.has(childKind)) {
      throw new Error(`headings can only group headings, collections, and artifacts (got ${childKind})`);
    }
  }
  if (_isAncestor(parentKind, parentId, childKind, childId)) {
    throw new Error('cycle: target is already a descendant');
  }
  const child  = lookupIndexRow(childKind, childId);
  const parent = lookupIndexRow(parentKind, parentId);
  if (!child)  throw new Error(`child not found: ${childKind}:${childId}`);
  if (!parent) throw new Error(`parent not found: ${parentKind}:${parentId}`);
  const id = `ip_${childKind}_${childId}_${parentKind}_${parentId}`.replace(/[^a-zA-Z0-9_]/g, '_');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO index_parents (id, child_kind, child_id, parent_kind, parent_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, childKind, childId, parentKind, parentId, now);
  return { id, child_kind: childKind, child_id: childId, parent_kind: parentKind, parent_id: parentId };
}

function removeIndexParent(childKind, childId, parentKind, parentId) {
  db.prepare(`
    DELETE FROM index_parents
    WHERE child_kind = ? AND child_id = ? AND parent_kind = ? AND parent_id = ?
  `).run(childKind, childId, parentKind, parentId);
  return { ok: true };
}

// Return all parents of a row as [{kind, id, label}].
function getIndexParents(childKind, childId) {
  const rows = db.prepare(`
    SELECT parent_kind as kind, parent_id as id
    FROM index_parents WHERE child_kind = ? AND child_id = ?
  `).all(childKind, childId);
  return rows.map(r => {
    const row = lookupIndexRow(r.kind, r.id);
    return row ? { kind: r.kind, id: r.id, label: row.label } : null;
  }).filter(Boolean);
}

// Return all direct children of a (kind,id) parent, as [{kind, id, label, archived_at}].
function getIndexChildren(parentKind, parentId) {
  const rows = db.prepare(`
    SELECT child_kind as kind, child_id as id
    FROM index_parents WHERE parent_kind = ? AND parent_id = ?
  `).all(parentKind, parentId);
  const out = [];
  for (const r of rows) {
    const row = lookupIndexRow(r.kind, r.id);
    if (row) out.push({ kind: r.kind, id: r.id, label: row.label, archived_at: row.archived_at });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// Remove every index_parents edge touching (kind, id) — either as parent or
// child. Call from every delete path (deletePerson, deleteTopicEntity, etc.)
// so the tree doesn't carry stale pointers.
function purgeIndexParentsFor(kind, id) {
  db.prepare(`DELETE FROM index_parents WHERE child_kind = ? AND child_id = ?`).run(kind, id);
  db.prepare(`DELETE FROM index_parents WHERE parent_kind = ? AND parent_id = ?`).run(kind, id);
}

// Count pages directly linked to (kind, id) via the links table.
// to_type values match each kind's convention:
//   topic → 'topic', scripture → 'scripture', person → 'person',
//   collection → 'collection', book → 'book', artifact → 'artifact',
//   reference → 'reference', user_index → 'user_index'
function _directPageCount(kind, id) {
  const toType = kind; // Every kind maps 1:1 to its to_type string.
  const row = db.prepare(`
    SELECT COUNT(DISTINCT l.from_id) as c
    FROM links l
    WHERE l.from_type = 'page' AND l.to_type = ? AND l.to_id = ?
  `).get(toType, id);
  return row.c;
}

// Recursive total page count: DISTINCT pages directly linked to this node OR
// to any descendant via index_parents. Uses a CTE so the walk runs in SQL.
function _totalPageCount(kind, id) {
  const row = db.prepare(`
    WITH RECURSIVE descendants(kind, id) AS (
      SELECT ?, ?
      UNION
      SELECT ip.child_kind, ip.child_id
      FROM index_parents ip
      JOIN descendants d ON d.kind = ip.parent_kind AND d.id = ip.parent_id
    )
    SELECT COUNT(DISTINCT l.from_id) as c
    FROM links l
    JOIN descendants d ON d.kind = l.to_type AND d.id = l.to_id
    WHERE l.from_type = 'page'
  `).get(kind, id);
  return row.c;
}

// On-expand payload for a single tree node: what else is connected to this
// entity via pages that link to it. Used by the Index view to show linked
// daily logs, collections, artifacts, and references inline when a node is
// expanded.
function getIndexNodeConnections(kind, id) {
  _indexKindSpec(kind);
  const row = lookupIndexRow(kind, id);
  if (!row) return null;

  const pageRows = db.prepare(`
    SELECT DISTINCT from_id AS page_id
    FROM links WHERE from_type='page' AND to_type=? AND to_id=?
  `).all(kind, id);
  const pageIds = pageRows.map(r => r.page_id);

  const children = getIndexChildren(kind, id);
  const base = {
    kind, id, label: row.label,
    children, pages_count: pageIds.length,
    pages: [], daily_logs: [], collections: [], artifacts: [], references: [],
  };
  if (pageIds.length === 0) return base;

  const placeholders = pageIds.map(() => '?').join(',');
  base.pages = db.prepare(`
    SELECT p.id, p.volume, p.page_number, p.scan_path, p.summary,
           p.captured_at, p.source_kind, p.rotation,
           (SELECT dl.date FROM links ll JOIN daily_logs dl ON dl.id = ll.to_id
            WHERE ll.from_type='page' AND ll.from_id=p.id AND ll.to_type='daily_log'
            AND dl.archived_at IS NULL LIMIT 1) AS daily_log_date,
           (SELECT dl.id FROM links ll JOIN daily_logs dl ON dl.id = ll.to_id
            WHERE ll.from_type='page' AND ll.from_id=p.id AND ll.to_type='daily_log'
            AND dl.archived_at IS NULL LIMIT 1) AS daily_log_id,
           (SELECT GROUP_CONCAT(c.title, ' · ')
            FROM links lc JOIN collections c ON c.id = lc.to_id
            WHERE lc.from_type='page' AND lc.from_id=p.id AND lc.to_type='collection'
            LIMIT 2) AS collection_titles,
           (SELECT a.title FROM links la JOIN artifacts a ON a.id = la.to_id
            WHERE la.from_type='page' AND la.from_id=p.id AND la.to_type='artifact'
            LIMIT 1) AS artifact_title,
           (SELECT r.title FROM links lr JOIN reference_materials r ON r.id = lr.to_id
            WHERE lr.from_type='page' AND lr.from_id=p.id AND lr.to_type='reference'
            LIMIT 1) AS reference_title
    FROM pages p
    WHERE p.id IN (${placeholders})
    ORDER BY p.volume, p.page_number, p.captured_at
  `).all(...pageIds);

  base.daily_logs = db.prepare(`
    SELECT DISTINCT dl.id, dl.date, dl.summary
    FROM links l JOIN daily_logs dl ON dl.id = l.to_id
    WHERE l.from_type='page' AND l.to_type='daily_log'
      AND l.from_id IN (${placeholders})
      AND dl.archived_at IS NULL
    ORDER BY dl.date DESC
  `).all(...pageIds);

  const collExclude = kind === 'collection' ? 'AND c.id != ?' : '';
  base.collections = db.prepare(`
    SELECT DISTINCT c.id, c.title, c.kind
    FROM links l JOIN collections c ON c.id = l.to_id
    WHERE l.from_type='page' AND l.to_type='collection'
      AND l.from_id IN (${placeholders})
      AND c.archived_at IS NULL
      ${collExclude}
    ORDER BY c.title COLLATE NOCASE
  `).all(...pageIds, ...(kind === 'collection' ? [id] : []));

  const artExclude = kind === 'artifact' ? 'AND a.id != ?' : '';
  base.artifacts = db.prepare(`
    SELECT DISTINCT a.id, a.title
    FROM links l JOIN artifacts a ON a.id = l.to_id
    WHERE l.from_type='page' AND l.to_type='artifact'
      AND l.from_id IN (${placeholders})
      AND a.archived_at IS NULL
      ${artExclude}
    ORDER BY a.title COLLATE NOCASE
  `).all(...pageIds, ...(kind === 'artifact' ? [id] : []));

  const refExclude = kind === 'reference' ? 'AND r.id != ?' : '';
  base.references = db.prepare(`
    SELECT DISTINCT r.id, r.title
    FROM links l JOIN reference_materials r ON r.id = l.to_id
    WHERE l.from_type='page' AND l.to_type='reference'
      AND l.from_id IN (${placeholders})
      AND r.archived_at IS NULL
      ${refExclude}
    ORDER BY r.title COLLATE NOCASE
  `).all(...pageIds, ...(kind === 'reference' ? [id] : []));

  return base;
}

// Unified row shape for the tree endpoint:
//   { kind, id, label, directPageCount, totalPageCount,
//     parents: [{kind,id,label}], children: [Row...], archivedAt, isAiGenerated }
// Pass ctx (from _loadIndexContext) to avoid per-node DB calls during tree builds.
function _buildIndexRow(kind, id, { seen = new Set(), ctx } = {}) {
  const nodeKey = `${kind}:${id}`;
  const row = ctx ? ctx.rowMap.get(nodeKey) : lookupIndexRow(kind, id);
  if (!row) return null;

  const direct = ctx ? (ctx.directCounts.get(nodeKey) ?? 0) : _directPageCount(kind, id);
  const total  = ctx ? (ctx.totalCounts.get(nodeKey) ?? direct) : _totalPageCount(kind, id);

  if (seen.has(nodeKey)) {
    // DAG: a node can appear under multiple parents. Render it on first visit
    // only; subsequent visits return a shallow placeholder to keep the tree
    // bounded + avoid re-walking.
    return {
      kind, id, label: row.label,
      meta: row.meta || null,
      directPageCount: direct,
      totalPageCount: total,
      parents: [], children: [],
      archivedAt: row.archived_at || null,
      isAiGenerated: !!row.is_ai_generated,
      _repeat: true,
    };
  }
  seen.add(nodeKey);

  let kids, parents;
  if (ctx) {
    kids = (ctx.childrenMap.get(nodeKey) || [])
      .map(c => { const r = ctx.rowMap.get(`${c.kind}:${c.id}`); return r ? { kind: c.kind, id: c.id, label: r.label, archived_at: r.archived_at } : null; })
      .filter(Boolean)
      .sort((a, b) => (a.label || '').localeCompare(b.label || ''));
    parents = (ctx.parentMap.get(nodeKey) || [])
      .map(p => { const r = ctx.rowMap.get(`${p.kind}:${p.id}`); return r ? { kind: p.kind, id: p.id, label: r.label } : null; })
      .filter(Boolean);
  } else {
    kids    = getIndexChildren(kind, id);
    parents = getIndexParents(kind, id);
  }

  return {
    kind, id, label: row.label,
    meta: row.meta || null,
    directPageCount: direct,
    totalPageCount: total,
    parents,
    children: kids.map(c => _buildIndexRow(c.kind, c.id, { seen, ctx })).filter(Boolean),
    archivedAt: row.archived_at || null,
    isAiGenerated: !!row.is_ai_generated,
  };
}

// Produce the full index tree grouped by kind for the left pane.
// Root rows per kind = rows with no parents in index_parents of the same kind
// (we still show rows whose only parents are in different kinds at the top
// level of their own kind, since the user expects to find every topic under
// Topics regardless of whether it also hangs off a user_index).
function listIndexTree({ includeArchived = false } = {}) {
  const ctx = _loadIndexContext();
  const kinds = [];
  const KIND_LABELS = {
    heading: 'Headings',
    collection: 'Collections', book: 'Books', artifact: 'Artifacts',
    reference: 'References', person: 'People', topic: 'Topics',
    scripture: 'Scripture', user_index: 'My Indexes',
  };
  for (const kind of ALL_INDEX_KINDS) {
    const spec = _indexKindSpec(kind);
    const whereActive   = `${spec.archiveCol} IS NULL`;
    const whereArchived = `${spec.archiveCol} IS NOT NULL`;
    const kindFilter    = spec.kindFilter ? `AND ${spec.kindFilter}` : '';
    const activeRows = db.prepare(
      `SELECT id FROM ${spec.table} WHERE ${whereActive} ${kindFilter} ORDER BY ${spec.labelCol} COLLATE NOCASE`
    ).all();
    const archivedRows = includeArchived
      ? db.prepare(`SELECT id FROM ${spec.table} WHERE ${whereArchived} ${kindFilter} ORDER BY ${spec.labelCol} COLLATE NOCASE`).all()
      : [];
    // Top-level rows: nodes with no same-kind parent (cross-kind parents are OK —
    // a topic under a user_index still appears at the top of the Topics section).
    const filterTopLevel = (rows) => rows.filter(r => !ctx.hasParentInSameKind.has(`${kind}:${r.id}`));
    const seen = new Set();
    kinds.push({
      kind,
      label: KIND_LABELS[kind] || kind,
      active:   filterTopLevel(activeRows).map(r => _buildIndexRow(kind, r.id, { seen, ctx })).filter(Boolean),
      archived: filterTopLevel(archivedRows).map(r => _buildIndexRow(kind, r.id, { seen: new Set(), ctx })).filter(Boolean),
    });
  }
  return { kinds };
}

// --- Unified entity helpers (Phase 3) ----------------------------------------
// The indexes surface (people / scripture / topics / books / collections /
// custom) all share the same operations: rename-or-merge, merge-into, archive,
// set-parent, delete. These helpers dispatch on `kind` so the chat action
// handler and the new /api/indexes route don't duplicate the per-kind logic.

// Map an index `kind` to its (table, labelColumn, toType) tuple.
const _ENTITY_KIND_MAP = {
  person:     { table: 'people',           labelCol: 'label',     toType: 'person',     supportsArchive: true,  supportsParent: false /* household via separate API */ },
  scripture:  { table: 'scripture_refs',   labelCol: 'canonical', toType: 'scripture',  supportsArchive: true,  supportsParent: false },
  topic:      { table: 'entities',         labelCol: 'label',     toType: 'topic',      supportsArchive: true,  supportsParent: true,  kindFilter: "kind='topic'" },
  book:       { table: 'books',            labelCol: 'title',     toType: 'book',       supportsArchive: false, supportsParent: false },
  collection: { table: 'collections',      labelCol: 'title',     toType: 'collection', supportsArchive: true,  supportsParent: true },
};

function _entitySpec(kind) {
  // Normalise plural aliases used in the API (people→person, topics→topic, …)
  const norm = {
    people: 'person', person: 'person',
    scripture: 'scripture', scriptures: 'scripture',
    topic: 'topic', topics: 'topic',
    book: 'book', books: 'book',
    collection: 'collection', collections: 'collection',
  }[kind];
  const spec = _ENTITY_KIND_MAP[norm];
  if (!spec) throw new Error(`unknown index kind: ${kind}`);
  return { kind: norm, ...spec };
}

// Return a uniform row shape for every supported kind:
//   { kind, id, label, subtitle, count, parent_id, parent_label, archived_at }
// Used by /api/indexes and the chat action catalog.
function getUnifiedIndex(kind, { includeArchived = false } = {}) {
  const spec = _entitySpec(kind);
  if (spec.kind === 'person') {
    const rows = db.prepare(`
      SELECT p.id, p.label,
             p.household_id,
             (SELECT h.name FROM households h WHERE h.id = p.household_id) as household_name,
             p.archived_at,
             (SELECT COUNT(*) FROM links l WHERE l.to_type='person' AND l.to_id=p.id) as count
      FROM people p
      ${includeArchived ? '' : 'WHERE p.archived_at IS NULL'}
      ORDER BY p.label COLLATE NOCASE
    `).all();
    return rows.map(r => ({
      kind: 'person', id: r.id, label: r.label, subtitle: r.household_name || null,
      count: r.count, parent_id: r.household_id || null, parent_label: r.household_name || null,
      archived_at: r.archived_at || null,
    }));
  }
  if (spec.kind === 'scripture') {
    const rows = db.prepare(`
      SELECT s.id, s.canonical, s.book, s.chapter, s.archived_at,
             (SELECT COUNT(*) FROM links l WHERE l.to_type='scripture' AND l.to_id=s.id) as count
      FROM scripture_refs s
      ${includeArchived ? '' : 'WHERE s.archived_at IS NULL'}
      ORDER BY s.book COLLATE NOCASE, s.chapter, s.verse_start
    `).all();
    return rows.map(r => ({
      kind: 'scripture', id: r.id, label: r.canonical, subtitle: r.book || null,
      count: r.count, parent_id: null, parent_label: null, archived_at: r.archived_at || null,
    }));
  }
  if (spec.kind === 'topic') {
    const rows = db.prepare(`
      SELECT e.id, e.label, e.parent_id, e.archived_at,
             (SELECT ep.label FROM entities ep WHERE ep.id = e.parent_id AND ep.kind='topic') as parent_label,
             (SELECT COUNT(*) FROM links l WHERE l.to_type='topic' AND l.to_id=e.id) as count
      FROM entities e
      WHERE e.kind = 'topic' ${includeArchived ? '' : 'AND e.archived_at IS NULL'}
      ORDER BY e.label COLLATE NOCASE
    `).all();
    return rows.map(r => ({
      kind: 'topic', id: r.id, label: r.label, subtitle: r.parent_label || null,
      count: r.count, parent_id: r.parent_id || null, parent_label: r.parent_label || null,
      archived_at: r.archived_at || null,
    }));
  }
  if (spec.kind === 'book') {
    const rows = db.prepare(`
      SELECT b.id, b.title,
             COALESCE(b.author_label, (SELECT e.label FROM entities e WHERE e.id = b.author_entity_id)) as author,
             (SELECT COUNT(*) FROM links l WHERE l.to_type='book' AND l.to_id=b.id) as count
      FROM books b
      ORDER BY b.title COLLATE NOCASE
    `).all();
    return rows.map(r => ({
      kind: 'book', id: r.id, label: r.title, subtitle: r.author || null,
      count: r.count, parent_id: null, parent_label: r.author || null, archived_at: null,
    }));
  }
  if (spec.kind === 'collection') {
    const rows = db.prepare(`
      SELECT c.id, c.title, c.kind as c_kind, c.parent_id, c.archived_at,
             (SELECT cp.title FROM collections cp WHERE cp.id = c.parent_id) as parent_label,
             (SELECT COUNT(*) FROM links l WHERE l.to_type='collection' AND l.to_id=c.id) as count
      FROM collections c
      WHERE c.kind != 'daily_log' ${includeArchived ? '' : 'AND c.archived_at IS NULL'}
      ORDER BY c.title COLLATE NOCASE
    `).all();
    return rows.map(r => ({
      kind: 'collection', id: r.id, label: r.title, subtitle: r.c_kind || null,
      count: r.count, parent_id: r.parent_id || null, parent_label: r.parent_label || null,
      archived_at: r.archived_at || null,
    }));
  }
  return [];
}

// Rename OR merge in one step. If another row of the same kind already has the
// target label, all links pointing at `id` are repointed to the existing row
// (with link-dedup) and `id` is deleted. Returns { id } or { merged_into }.
function renameOrMergeEntity(kind, id, newLabel) {
  const spec = _entitySpec(kind);
  if (!newLabel || !String(newLabel).trim()) throw new Error('label required');
  const label = String(newLabel).trim();
  if (spec.kind === 'person')     return updatePerson(id, { label });
  if (spec.kind === 'topic')      return updateTopicLabel(id, label);
  if (spec.kind === 'scripture')  return updateScriptureLabel(id, label);
  if (spec.kind === 'book')       { updateBook(id, { title: label }); return { id }; }
  if (spec.kind === 'collection') return renameCollection(id, label);
  throw new Error(`rename not supported for ${kind}`);
}

// Merge source → target of the same kind. All links repoint, source deletes.
function mergeEntitiesInto(kind, sourceId, targetId) {
  const spec = _entitySpec(kind);
  if (!sourceId || !targetId || sourceId === targetId) throw new Error('invalid merge');
  const toType = spec.toType;
  db.prepare(`UPDATE links SET to_id = ? WHERE to_type = ? AND to_id = ?`).run(targetId, toType, sourceId);
  dedupeLinks();
  // Delete the source row.
  if (spec.kind === 'topic') {
    db.prepare(`DELETE FROM entities WHERE id = ? AND kind='topic'`).run(sourceId);
  } else {
    db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(sourceId);
  }
  return { merged_into: targetId };
}

// Set archived_at on any kind that supports it. `archived` is boolean.
function setEntityArchived(kind, id, archived) {
  const spec = _entitySpec(kind);
  if (!spec.supportsArchive) throw new Error(`${kind} does not support archive`);
  const when = archived ? new Date().toISOString() : null;
  if (spec.kind === 'topic') {
    db.prepare(`UPDATE entities SET archived_at = ? WHERE id = ? AND kind='topic'`).run(when, id);
  } else {
    db.prepare(`UPDATE ${spec.table} SET archived_at = ? WHERE id = ?`).run(when, id);
  }
  return { id, archived_at: when };
}

// Escape a user-typed string for safe use in an FTS5 MATCH expression. Wraps each
// token in double-quotes so operators, punctuation, and bare colons pass through
// as literal text. Empty/blank input returns null.
function escapeFts(raw) {
  if (!raw) return null;
  const tokens = String(raw).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map(t => '"' + t.replace(/"/g, '""') + '"').join(' ');
}

// Notebook glossary — durable vocabulary the app learns from answered backlog questions.
// Each row maps a term (abbreviation, symbol, name, or phrase the user clarified) to its
// meaning. Used for backlog dedup, chat context, and (optionally) Gemini context.
db.exec(`
  CREATE TABLE IF NOT EXISTS notebook_glossary (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    meaning TEXT NOT NULL,
    kind TEXT DEFAULT 'term',
    source_backlog_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);
{
  const cols = db.pragma('table_info(notebook_glossary)').map(c => c.name);
  if (!cols.includes('kind')) db.exec(`ALTER TABLE notebook_glossary ADD COLUMN kind TEXT DEFAULT 'term'`);
}
// Unique index on term (case-insensitive). Added as a separate idempotent step because
// CREATE TABLE IF NOT EXISTS won't add the constraint to an existing table.
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_term ON notebook_glossary(term COLLATE NOCASE)`);
} catch (_) {}

// Google OAuth token storage (singleton row keyed by id=1).
db.exec(`
  CREATE TABLE IF NOT EXISTS google_tokens (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT,
    refresh_token TEXT NOT NULL,
    expires_at TEXT,
    scope TEXT,
    updated_at TEXT NOT NULL
  );
`);

// Google Drive auto-capture: pending queue of auto-discovered Docs/Sheets, and
// a key-value config table for folder IDs + the Changes API page token.
db.exec(`
  CREATE TABLE IF NOT EXISTS google_captures (
    id            TEXT PRIMARY KEY,
    drive_file_id TEXT UNIQUE NOT NULL,
    title         TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    file_url      TEXT NOT NULL,
    discovered_at TEXT NOT NULL,
    dismissed_at  TEXT,
    accepted_kind TEXT,
    accepted_id   TEXT
  );
  CREATE TABLE IF NOT EXISTS google_drive_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Books (bibliographic notes). Author references a `topic` entity so the same author
// can be browsed consistently alongside other topical threads.
db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author_entity_id TEXT REFERENCES entities(id),
    author_label TEXT,
    year TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_books_author ON books(author_entity_id);
  CREATE INDEX IF NOT EXISTS idx_books_title ON books(title COLLATE NOCASE);
`);
// archived_at migration for books (runs here so fresh DBs get the column right after table creation).
{
  const cols = db.pragma('table_info(books)').map(c => c.name);
  if (!cols.includes('archived_at')) db.exec('ALTER TABLE books ADD COLUMN archived_at TEXT');
}

// Daily logs are first-class: they are *not* a kind of collection. Pages link to a
// daily_log via links(to_type='daily_log'); a daily_log may optionally link to one or
// more collections (e.g. a topical collection) via links(from_type='daily_log').
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_logs (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL UNIQUE,        -- ISO YYYY-MM-DD
    summary TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_daily_logs_date ON daily_logs(date);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_daily_logs_date ON daily_logs(date);

  CREATE TABLE IF NOT EXISTS monthly_summaries (
    year_month TEXT PRIMARY KEY,      -- YYYY-MM
    summary TEXT,
    updated_at TEXT NOT NULL
  );
`);
// content_hash / links_classified_at for daily_logs — runs here after table creation.
{
  const cols = db.pragma('table_info(daily_logs)').map(c => c.name);
  if (!cols.includes('content_hash'))        db.exec('ALTER TABLE daily_logs ADD COLUMN content_hash TEXT');
  if (!cols.includes('links_classified_at')) db.exec('ALTER TABLE daily_logs ADD COLUMN links_classified_at TEXT');
}

// Phase 4 — Planning hub: rocks (weekly goals tied to a role) and habits with
// per-day check-marks. Both are independent tables; no polymorphic links into
// these unless the user explicitly attaches a collection (rocks↔collection
// goes through the standard `links` table).
db.exec(`
  CREATE TABLE IF NOT EXISTS rocks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    role_id TEXT,
    week_start TEXT NOT NULL,             -- ISO YYYY-MM-DD of the Monday
    status TEXT DEFAULT 'open',           -- open | done | dropped
    created_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(title, week_start)
  );
  CREATE INDEX IF NOT EXISTS idx_rocks_week ON rocks(week_start);
  CREATE TABLE IF NOT EXISTS habits (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    role_id TEXT,
    active_from TEXT,
    active_to TEXT,
    archived_at TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS habit_checks (
    habit_id TEXT NOT NULL,
    date TEXT NOT NULL,
    checked INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (habit_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_habit_checks_date ON habit_checks(date);
`);

// Phase 4.5 — chat sessions, messages, and durable memory.
// `chat_messages.role='action'` rows hold an AI-proposed mutation as JSON until
// the user accepts/rejects. `chat_memory` is a key-value store for preferences
// the assistant can lean on across sessions; the user can always inspect/delete.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    pinned_page_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id),
    role TEXT NOT NULL CHECK(role IN ('user','assistant','action','observation')),
    body TEXT,
    proposal_json TEXT,
    status TEXT DEFAULT 'final',           -- proposed | accepted | rejected | executed | final
    created_at TEXT NOT NULL,
    executed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chat_msgs_session ON chat_messages(session_id, created_at);
  CREATE TABLE IF NOT EXISTS chat_memory (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL
  );
`);

function getMonthlySummary(ym) {
  return db.prepare(`SELECT year_month, summary, updated_at FROM monthly_summaries WHERE year_month = ?`).get(ym) || null;
}

function setMonthlySummary(ym, summary) {
  db.prepare(`
    INSERT INTO monthly_summaries (year_month, summary, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(year_month) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at
  `).run(ym, summary || null);
  return getMonthlySummary(ym);
}

{
  const cols = db.pragma('table_info(collections)').map(c => c.name);
  if (!cols.includes('archived_at')) db.exec('ALTER TABLE collections ADD COLUMN archived_at TEXT');
  if (!cols.includes('parent_id')) {
    db.exec('ALTER TABLE collections ADD COLUMN parent_id TEXT REFERENCES collections(id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_collections_parent ON collections(parent_id)');
  }
  // Phase 2 — project fields on collections (kind='project')
  if (!cols.includes('target_date')) db.exec('ALTER TABLE collections ADD COLUMN target_date TEXT');
  if (!cols.includes('status'))      db.exec('ALTER TABLE collections ADD COLUMN status TEXT');
}
{
  const cols = db.pragma('table_info(commitments)').map(c => c.name);
  if (!cols.includes('collection_id')) db.exec('ALTER TABLE commitments ADD COLUMN collection_id TEXT');
}

// One-time migration: move every collection with kind='daily_log' into the new
// `daily_logs` table. Pages that linked to those collections are re-pointed at the
// new daily_log rows. The old collection rows are then deleted.
{
  const legacy = db.prepare(`SELECT id, title, summary FROM collections WHERE kind='daily_log'`).all();
  if (legacy.length > 0) {
    const insertDL = db.prepare(`
      INSERT INTO daily_logs (id, date, summary, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(date) DO UPDATE SET summary = COALESCE(excluded.summary, daily_logs.summary)
    `);
    const findDL = db.prepare(`SELECT id FROM daily_logs WHERE date = ?`);
    const repointLinks = db.prepare(`
      UPDATE OR IGNORE links SET to_type='daily_log', to_id=?
      WHERE to_type='collection' AND to_id=?
    `);
    const dropOrphanLinks = db.prepare(`DELETE FROM links WHERE to_type='collection' AND to_id=?`);
    const deleteCollection = db.prepare(`DELETE FROM collections WHERE id=?`);
    const migrate = db.transaction(() => {
      for (const c of legacy) {
        const date = (c.title || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          // skip malformed daily-log titles; leave the row in place for manual fixing
          continue;
        }
        insertDL.run(require('crypto').randomUUID(), date, c.summary || null);
        const dl = findDL.get(date);
        if (!dl) continue;
        repointLinks.run(dl.id, c.id);
        dropOrphanLinks.run(c.id);  // any duplicate page-links that couldn't be updated
        deleteCollection.run(c.id);
      }
    });
    migrate();
  }
}

// Phase 2 — one-time migration: move every `projects` row into `collections`
// with kind='project', copying title/description/target_date/status. Projects
// aren't heavily linked (no polymorphic links routinely point at `projects`),
// so this is mostly a table copy. The source `projects` table stays around
// (deprecated) so any external introspection still sees the old rows.
{
  // Only run if the `projects` table exists (it always will — created above)
  // AND there isn't already a `project`-kind collection mirroring it. Idempotent.
  const projRows = db.prepare(`SELECT id, title, description, target_date, status, created_at FROM projects`).all();
  const existingProjColl = db.prepare(`SELECT COUNT(*) as n FROM collections WHERE kind='project'`).get().n;
  if (projRows.length > 0 && existingProjColl === 0) {
    const insertColl = db.prepare(`
      INSERT OR IGNORE INTO collections (id, kind, title, description, target_date, status, created_at)
      VALUES (?, 'project', ?, ?, ?, ?, COALESCE(?, datetime('now')))
    `);
    const mig = db.transaction(() => {
      for (const p of projRows) {
        insertColl.run(p.id, p.title, p.description ?? null, p.target_date ?? null, p.status ?? null, p.created_at ?? null);
      }
    });
    mig();
  }
}

// --- Pages ---

function insertPage({ id, volume, page_number, scan_path, raw_ocr_text, summary, source_kind, captured_at, is_reference, reference_label, continued_from, continued_to }) {
  db.prepare(`
    INSERT INTO pages (id, volume, page_number, scan_path, captured_at, raw_ocr_text, summary, source_kind, is_reference, reference_label, continued_from, continued_to)
    VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?)
  `).run(id, volume ?? null, page_number ?? null, scan_path, captured_at ?? null, raw_ocr_text ?? null, summary ?? null, source_kind ?? null, is_reference ? 1 : 0, reference_label ?? null, continued_from ?? null, continued_to ?? null);
}

// Threading: given a newly-ingested page, copy collection/daily-log links
// between it and any thread-connected neighbors in the same volume.
// Connections come from three sources:
//   1. This page's continued_from marker → inherit from that page.
//   2. This page's continued_to marker → push to that page (if it exists).
//   3. Existing pages that point TO this page (their continued_to or
//      continued_from names our page_number) — stitched retroactively so
//      out-of-order PDF parses still thread.
// Also falls back to (page_number - 1) when `continuation` is true but no
// explicit marker was read — handles "p.200 runs onto p.201" naturally.
function applyThreadingForPage(pageId, { continuation } = {}) {
  const page = db.prepare('SELECT id, volume, page_number, continued_from, continued_to FROM pages WHERE id = ?').get(pageId);
  if (!page || page.volume == null || page.page_number == null) return { applied: 0 };

  const findPage = (pn) => db.prepare(
    `SELECT id FROM pages WHERE volume = ? AND page_number = ? AND id != ? ORDER BY captured_at DESC LIMIT 1`
  ).get(page.volume, pn, pageId);

  const getCollLinks = (pid) => db.prepare(
    `SELECT to_id, confidence, role_summary FROM links
     WHERE from_type='page' AND from_id = ? AND to_type='collection'`
  ).all(pid);
  const getDailyLinks = (pid) => db.prepare(
    `SELECT to_id, confidence FROM links
     WHERE from_type='page' AND from_id = ? AND to_type='daily_log'`
  ).all(pid);

  let applied = 0;
  const hasContainer = (pid) => db.prepare(
    `SELECT COUNT(*) AS n FROM links WHERE from_type='page' AND from_id=? AND to_type IN ('collection','daily_log')`
  ).get(pid).n > 0;
  const copy = (fromId, toId) => {
    // Never overwrite a container the page already has — threading only fills gaps.
    if (hasContainer(toId)) return;
    for (const cl of getCollLinks(fromId)) {
      const before = linkPageToCollection(toId, cl.to_id, Math.max(0.85, Math.min(0.95, cl.confidence || 0.9)));
      if (before) applied++;
    }
    for (const dl of getDailyLinks(fromId)) {
      const before = linkPageToDailyLog(toId, dl.to_id, Math.max(0.85, Math.min(0.95, dl.confidence || 0.9)));
      if (before) applied++;
    }
  };

  // (1) Inherit from the page we continue FROM (or the prior page_number if this
  // is a continuation without an explicit marker).
  const fromPn = page.continued_from ?? (continuation ? page.page_number - 1 : null);
  if (fromPn != null) {
    const src = findPage(fromPn);
    if (src) copy(src.id, pageId);
  }

  // (2) Push to the page we continue TO.
  if (page.continued_to != null) {
    const tgt = findPage(page.continued_to);
    if (tgt) copy(pageId, tgt.id);
  }

  // (3) Stitch pages already in DB that thread into this one.
  const inbound = db.prepare(`
    SELECT id, continued_to, continued_from FROM pages
    WHERE volume = ? AND id != ? AND (continued_to = ? OR continued_from = ?)
  `).all(page.volume, pageId, page.page_number, page.page_number);
  for (const neighbor of inbound) {
    // neighbor.continued_to = this page  → neighbor's collections flow into this.
    if (neighbor.continued_to === page.page_number) copy(neighbor.id, pageId);
    // neighbor.continued_from = this page → this page's collections flow into neighbor.
    if (neighbor.continued_from === page.page_number) copy(pageId, neighbor.id);
  }

  // (4) Gap-bridging: if this page has no topical collection AND no daily_log,
  // but both neighbors (page_number ± 1) are in the SAME topical collection X,
  // link this page to X. Conservative: only fires when both neighbors agree.
  const selfTopical = db.prepare(`
    SELECT COUNT(*) AS n FROM links
    WHERE from_type='page' AND from_id = ? AND to_type='collection'
  `).get(pageId).n;
  const selfDaily = db.prepare(`
    SELECT COUNT(*) AS n FROM links
    WHERE from_type='page' AND from_id = ? AND to_type='daily_log'
  `).get(pageId).n;
  if (selfTopical === 0 && selfDaily === 0 && page.page_number != null) {
    const prev = findPage(page.page_number - 1);
    const next = findPage(page.page_number + 1);
    if (prev && next) {
      const prevColls = new Set(getCollLinks(prev.id).map(l => l.to_id));
      const nextColls = getCollLinks(next.id).map(l => l.to_id);
      const shared = nextColls.filter(id => prevColls.has(id));
      for (const cid of shared) {
        linkPageToCollection(pageId, cid, 0.8);
        applied++;
      }
    }
  }

  return { applied };
}

function markPageAsReference(pageId, referenceLabel) {
  db.prepare(`UPDATE pages SET is_reference = 1, reference_label = ? WHERE id = ?`)
    .run(referenceLabel ?? null, pageId);
}

function listReferenceScans({ limit = 50, offset = 0, label = null, search = null } = {}) {
  const params = [];
  let where = 'WHERE p.is_reference = 1';
  if (label) { where += ' AND p.reference_label = ?'; params.push(label); }
  if (search && search.trim()) {
    where += ' AND (p.summary LIKE ? OR p.raw_ocr_text LIKE ?)';
    const term = `%${search.trim()}%`;
    params.push(term, term);
  }
  const rows = db.prepare(`
    SELECT p.id, p.scan_path, p.summary, p.captured_at, p.reference_label, p.source_kind,
           (SELECT COUNT(*) FROM items i WHERE i.page_id = p.id) AS item_count
    FROM pages p
    ${where}
    ORDER BY p.captured_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM pages p ${where}`).get(...params).n;
  return { items: rows, total, limit, offset };
}

function listReferenceLabels() {
  return db.prepare(`
    SELECT reference_label AS label, COUNT(*) AS n
    FROM pages
    WHERE is_reference = 1 AND reference_label IS NOT NULL AND reference_label != ''
    GROUP BY reference_label
    ORDER BY n DESC, label ASC
  `).all();
}

function getPage(id) {
  return db.prepare('SELECT * FROM pages WHERE id = ?').get(id);
}

function getRecentPages(limit = 10) {
  return db.prepare('SELECT * FROM pages ORDER BY captured_at DESC LIMIT ?').all(limit);
}

// --- Items ---

function insertItems(items) {
  const stmt = db.prepare(`
    INSERT INTO items (id, page_id, kind, text, confidence, status) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((rows) => {
    for (const r of rows) stmt.run(r.id, r.page_id, r.kind, r.text, r.confidence ?? 1.0, r.status || null);
  });
  insertMany(items);
}

// Find pending `link_proposal` backlog rows targeting a specific (volume, page_number).
// Volume is REQUIRED — page links are always intra-volume unless the user wrote
// an explicit volume marker, and every pending subject stamps the target volume.
// Called by the retroactive resolver when a new page lands.
function findPendingPageRefProposals(pageNumber, volume) {
  if (pageNumber == null || volume == null || String(volume).trim() === '') return [];
  const pn = typeof pageNumber === 'number' ? pageNumber : parseInt(String(pageNumber).trim(), 10);
  if (!Number.isFinite(pn)) return [];
  const volLabel = `Pending page-ref: v.${String(volume).trim()} p.${pn}`;
  return db.prepare(`
    SELECT * FROM backlog_items
    WHERE kind = 'link_proposal'
      AND status = 'pending'
      AND subject = ?
  `).all(volLabel);
}

// Find a page by (volume, page_number) for resolving cross-page references like
// "→ p.172" or "see v.D p.90". Volume is REQUIRED — page links are always within
// a single volume unless the user explicitly wrote a volume marker. A bare "p.N"
// resolver should pass fromPage.volume as the inherited volume. If volume is
// missing we never fall back cross-volume (that would misfile references to
// wildly unrelated pages that happen to share a page number).
function findPageByVolumeAndNumber(volume, pageNumber) {
  if (pageNumber == null || pageNumber === '') return null;
  if (volume == null || String(volume).trim() === '') return null;
  const pn = typeof pageNumber === 'number' ? pageNumber : parseInt(String(pageNumber).trim(), 10);
  if (!Number.isFinite(pn)) return null;
  return db.prepare(`SELECT * FROM pages WHERE volume = ? AND page_number = ? ORDER BY captured_at DESC LIMIT 1`).get(String(volume).trim(), pn) || null;
}

function searchItems(query, limit = 15) {
  const match = escapeFts(query);
  if (!match) return [];
  return db.prepare(`
    SELECT i.*, p.volume, p.page_number, p.id as page_id, p.scan_path, p.source_kind, p.captured_at
    FROM items_fts f
    JOIN items i ON i.rowid = f.rowid
    JOIN pages p ON p.id = i.page_id
    WHERE items_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(match, limit);
}

function getAllItems(limit = 50) {
  return db.prepare(`
    SELECT i.*, p.volume, p.page_number, p.scan_path, p.source_kind, p.captured_at
    FROM items i JOIN pages p ON p.id = i.page_id
    ORDER BY p.captured_at DESC LIMIT ?
  `).all(limit);
}

function getItemsCapturedOn(isoDate, limit = 50) {
  return db.prepare(`
    SELECT i.*, p.volume, p.page_number, p.scan_path, p.source_kind, p.captured_at
    FROM items i JOIN pages p ON p.id = i.page_id
    WHERE substr(p.captured_at, 1, 10) = ?
    ORDER BY p.captured_at DESC LIMIT ?
  `).all(isoDate, limit);
}

// Resolve an @mention token (case-insensitive, hyphens or spaces OK) to a
// concrete entity across people / topics / scripture. Returns the first match.
function resolveMentionTarget(token) {
  const needle = token.replace(/[_-]+/g, ' ').trim();
  if (!needle) return null;

  const person = db.prepare(`SELECT id, label FROM people WHERE label = ? COLLATE NOCASE`).get(needle)
    || db.prepare(`SELECT id, label FROM people WHERE label LIKE ? COLLATE NOCASE ORDER BY length(label) LIMIT 1`).get(needle + '%');
  if (person) return { kind: 'person', id: person.id, label: person.label };

  const topic = db.prepare(`SELECT id, label FROM entities WHERE kind='topic' AND label = ? COLLATE NOCASE`).get(needle)
    || db.prepare(`SELECT id, label FROM entities WHERE kind='topic' AND label LIKE ? COLLATE NOCASE ORDER BY length(label) LIMIT 1`).get(needle + '%');
  if (topic) return { kind: 'topic', id: topic.id, label: topic.label };

  const scripture = db.prepare(`SELECT id, canonical as label FROM scripture_refs WHERE canonical = ? COLLATE NOCASE`).get(needle)
    || db.prepare(`SELECT id, canonical as label FROM scripture_refs WHERE canonical LIKE ? COLLATE NOCASE ORDER BY length(canonical) LIMIT 1`).get(needle + '%');
  if (scripture) return { kind: 'scripture', id: scripture.id, label: scripture.label };

  return null;
}

// All items on pages that link to a given entity (person/topic/scripture).
// For persons/topics we surface the whole page's items; for scripture same.
function getItemsLinkedToEntity(kind, id, limit = 30) {
  return db.prepare(`
    SELECT DISTINCT i.*, p.volume, p.page_number, p.scan_path, p.source_kind, p.captured_at
    FROM links l
    JOIN pages p ON p.id = l.from_id AND l.from_type = 'page'
    JOIN items i ON i.page_id = p.id
    WHERE l.to_type = ? AND l.to_id = ?
    ORDER BY p.captured_at DESC
    LIMIT ?
  `).all(kind, id, limit);
}

function getPageTranscript(pageId) {
  return db.prepare(`
    SELECT id, scan_path, source_kind, captured_at, summary, raw_ocr_text
    FROM pages WHERE id = ?
  `).get(pageId);
}

// --- Entities ---

function upsertEntity({ id, kind, label }) {
  db.prepare(`
    INSERT INTO entities (id, kind, label) VALUES (?, ?, ?)
    ON CONFLICT(kind, label) DO NOTHING
  `).run(id, kind, label);
  return db.prepare(`SELECT * FROM entities WHERE kind = ? AND label = ? COLLATE NOCASE`).get(kind, label);
}

function getEntityByKindLabel(kind, label) {
  return db.prepare(`SELECT * FROM entities WHERE kind = ? AND label = ? COLLATE NOCASE`).get(kind, label);
}

// Generic helpers used by Roles + Areas (kind ∈ {'role','area'}).
function listEntitiesByKind(kind) {
  return db.prepare(`
    SELECT e.id, e.kind, e.label, e.standard, e.current_focus,
      (SELECT COUNT(*) FROM links l
         WHERE l.to_type='entity' AND l.to_id=e.id AND l.from_type='collection') as collection_count
    FROM entities e WHERE e.kind = ?
    ORDER BY e.label COLLATE NOCASE
  `).all(kind);
}

// Update an entity's label, standard, and current_focus. Uses COALESCE so
// unspecified fields are preserved. If `label` is provided and a different
// entity with the same (kind, label) exists, merge into it: move link rows,
// dedupe, and delete this row.
function updateEntity(id, { label, standard, current_focus } = {}) {
  const cur = db.prepare(`SELECT id, kind, label FROM entities WHERE id = ?`).get(id);
  if (!cur) throw new Error('entity not found');

  if (label && label.trim() && label.trim().toLowerCase() !== (cur.label || '').toLowerCase()) {
    const other = db.prepare(
      `SELECT id FROM entities WHERE kind = ? AND label = ? COLLATE NOCASE AND id != ?`
    ).get(cur.kind, label.trim(), id);
    if (other) {
      // Merge: move to_links and from_links to the surviving row, then delete this row.
      db.prepare(`UPDATE links SET to_id = ? WHERE to_type='entity' AND to_id = ?`).run(other.id, id);
      db.prepare(`UPDATE links SET from_id = ? WHERE from_type='entity' AND from_id = ?`).run(other.id, id);
      dedupeLinks();
      // Merge standard / current_focus into the survivor when survivor has none.
      db.prepare(`
        UPDATE entities SET
          standard      = COALESCE(standard, ?),
          current_focus = COALESCE(current_focus, ?)
        WHERE id = ?
      `).run(standard ?? null, current_focus ?? null, other.id);
      db.prepare(`DELETE FROM entities WHERE id = ?`).run(id);
      return { id: other.id, merged_into: other.id };
    }
  }

  db.prepare(`
    UPDATE entities SET
      label         = COALESCE(?, label),
      standard      = COALESCE(?, standard),
      current_focus = COALESCE(?, current_focus)
    WHERE id = ?
  `).run(
    (label && label.trim()) ? label.trim() : null,
    standard ?? null,
    current_focus ?? null,
    id
  );
  return { id };
}

// Link a role entity to an area entity via links(role='in_area'). Idempotent.
function linkRoleToArea(roleId, areaId) {
  const role = db.prepare(`SELECT id, kind FROM entities WHERE id = ?`).get(roleId);
  if (!role || role.kind !== 'role') throw new Error('role not found');
  const area = db.prepare(`SELECT id, kind FROM entities WHERE id = ?`).get(areaId);
  if (!area || area.kind !== 'area') throw new Error('area not found');

  const existing = db.prepare(`
    SELECT id FROM links
    WHERE from_type='entity' AND from_id=? AND to_type='entity' AND to_id=? AND role='in_area'
  `).get(roleId, areaId);
  if (existing) return existing.id;

  const id = require('crypto').randomUUID();
  db.prepare(`
    INSERT INTO links (id, from_type, from_id, to_type, to_id, role, created_by, confidence)
    VALUES (?, 'entity', ?, 'entity', ?, 'in_area', 'user', 1.0)
  `).run(id, roleId, areaId);
  return id;
}

function unlinkRoleFromArea(roleId, areaId) {
  return db.prepare(`
    DELETE FROM links
    WHERE from_type='entity' AND from_id=? AND to_type='entity' AND to_id=? AND role='in_area'
  `).run(roleId, areaId);
}

// All roles with their linked areas, ordered by priority (nulls last, then label).
// Each row: {id, kind, label, standard, current_focus, priority,
// collection_count, areas: [{id, label, standard, current_focus, priority}]}.
function listRolesWithAreas() {
  const roles = db.prepare(`
    SELECT e.id, e.kind, e.label, e.standard, e.current_focus, e.priority,
      (SELECT COUNT(*) FROM links l
         WHERE l.to_type='entity' AND l.to_id=e.id AND l.from_type='collection') as collection_count
    FROM entities e WHERE e.kind = 'role'
    ORDER BY CASE WHEN e.priority IS NULL THEN 1 ELSE 0 END, e.priority, e.label COLLATE NOCASE
  `).all();
  if (roles.length === 0) return [];
  const areasByRole = {};
  const rows = db.prepare(`
    SELECT l.from_id as role_id, e.id, e.label, e.standard, e.current_focus, e.priority
    FROM links l JOIN entities e ON e.id = l.to_id
    WHERE l.from_type='entity' AND l.to_type='entity' AND l.role='in_area' AND e.kind='area'
    ORDER BY CASE WHEN e.priority IS NULL THEN 1 ELSE 0 END, e.priority, e.label COLLATE NOCASE
  `).all();
  for (const r of rows) {
    (areasByRole[r.role_id] = areasByRole[r.role_id] || []).push({
      id: r.id, label: r.label, standard: r.standard, current_focus: r.current_focus, priority: r.priority,
    });
  }
  return roles.map(r => ({ ...r, areas: areasByRole[r.id] || [] }));
}

// Swap priority with the neighbor in the given direction. `kind` is 'role' or 'area'.
// `scopeId` is optional: for areas, only reorder within the same role (areas linked
// to that role via links 'in_area').
function moveEntityPriority(id, direction, { scopeId } = {}) {
  const dir = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
  if (!dir) throw new Error('direction must be up or down');
  const row = db.prepare(`SELECT id, kind, label, priority FROM entities WHERE id = ?`).get(id);
  if (!row) throw new Error('entity not found');

  // Siblings = entities of the same kind, optionally scoped.
  let siblings;
  if (row.kind === 'area' && scopeId) {
    siblings = db.prepare(`
      SELECT e.id, e.label, e.priority
      FROM entities e
      JOIN links l ON l.to_type='entity' AND l.to_id = e.id
      WHERE e.kind='area' AND l.from_type='entity' AND l.role='in_area' AND l.from_id = ?
      ORDER BY CASE WHEN e.priority IS NULL THEN 1 ELSE 0 END, e.priority, e.label COLLATE NOCASE
    `).all(scopeId);
  } else {
    siblings = db.prepare(`
      SELECT id, label, priority FROM entities WHERE kind = ?
      ORDER BY CASE WHEN priority IS NULL THEN 1 ELSE 0 END, priority, label COLLATE NOCASE
    `).all(row.kind);
  }
  // Back-fill priorities densely so swap is simple.
  const tx = db.transaction(() => {
    siblings.forEach((s, i) => {
      const p = i + 1;
      if (s.priority !== p) db.prepare(`UPDATE entities SET priority = ? WHERE id = ?`).run(p, s.id);
      s.priority = p;
    });
    const idx = siblings.findIndex(s => s.id === id);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= siblings.length) return;
    const a = siblings[idx], b = siblings[swapIdx];
    db.prepare(`UPDATE entities SET priority = ? WHERE id = ?`).run(b.priority, a.id);
    db.prepare(`UPDATE entities SET priority = ? WHERE id = ?`).run(a.priority, b.id);
  });
  tx();
  return { ok: true };
}

// All areas with their linked roles.
function listAreasWithRoles() {
  const areas = listEntitiesByKind('area');
  if (areas.length === 0) return [];
  const rolesByArea = {};
  const rows = db.prepare(`
    SELECT l.to_id as area_id, e.id, e.label
    FROM links l JOIN entities e ON e.id = l.from_id
    WHERE l.from_type='entity' AND l.to_type='entity' AND l.role='in_area' AND e.kind='role'
  `).all();
  for (const r of rows) {
    (rolesByArea[r.area_id] = rolesByArea[r.area_id] || []).push({ id: r.id, label: r.label });
  }
  return areas.map(a => ({ ...a, roles: rolesByArea[a.id] || [] }));
}

function getOrCreateEntity({ kind, label }) {
  const clean = String(label || '').trim();
  if (!clean) throw new Error('label is required');
  const existing = getEntityByKindLabel(kind, clean);
  if (existing) return existing;
  const id = require('crypto').randomUUID();
  upsertEntity({ id, kind, label: clean });
  return getEntityByKindLabel(kind, clean);
}

function deleteRoleOrArea(id) {
  db.prepare(`DELETE FROM links WHERE to_type='entity' AND to_id=?`).run(id);
  return db.prepare(`DELETE FROM entities WHERE id=? AND kind IN ('role','area')`).run(id);
}

// Return [{id, kind, label, link_id}] entities of given kind linked TO a collection.
function listCollectionEntities(collectionId, kind) {
  return db.prepare(`
    SELECT e.id, e.kind, e.label, l.id as link_id
    FROM links l JOIN entities e ON e.id = l.to_id
    WHERE l.from_type='collection' AND l.from_id=? AND l.to_type='entity' AND e.kind=?
    ORDER BY e.label COLLATE NOCASE
  `).all(collectionId, kind);
}

function deletePerson(id) {
  db.prepare(`DELETE FROM links WHERE to_type='person' AND to_id=?`).run(id);
  return db.prepare(`DELETE FROM people WHERE id=?`).run(id);
}
function deleteScriptureRef(id) {
  db.prepare(`DELETE FROM links WHERE to_type='scripture' AND to_id=?`).run(id);
  return db.prepare(`DELETE FROM scripture_refs WHERE id=?`).run(id);
}
function deleteTopicEntity(id) {
  db.prepare(`DELETE FROM links WHERE to_type='topic' AND to_id=?`).run(id);
  return db.prepare(`DELETE FROM entities WHERE id=? AND kind='topic'`).run(id);
}

// --- Links ---

function insertLink({ id, from_type, from_id, to_type, to_id, created_by, confidence, role_summary }) {
  db.prepare(`
    INSERT INTO links (id, from_type, from_id, to_type, to_id, created_by, confidence, role_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, from_type, from_id, to_type, to_id, created_by ?? 'foxed', confidence ?? 1.0, role_summary ?? null);
}

// --- Backlog ---

function insertBacklogItems(items) {
  const stmt = db.prepare(`
    INSERT INTO backlog_items (id, kind, subject, proposal, context_page_id, created_at, answer_format, answer_options)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)
  `);
  // Dedupe: skip if an identical-subject pending item exists, OR the same subject
  // was answered previously. For person-identity questions we also check a
  // normalized form ("just the name") so AI phrasing variants — Who is "Baz"?,
  // Identify person: Baz, Clarify mention of Baz — all collapse to one entry.
  const pendingSame = db.prepare(
    `SELECT 1 FROM backlog_items WHERE subject = ? COLLATE NOCASE AND status='pending' LIMIT 1`
  );
  const everAnswered = db.prepare(
    `SELECT 1 FROM backlog_items
     WHERE subject = ? COLLATE NOCASE AND status='answered' LIMIT 1`
  );
  // Normalized check: strip quotes/punctuation so minor phrasing variants don't slip through.
  // E.g. 'Who is "Baz"?' and "Who is 'Baz'?" normalize to the same string.
  const normalizeSubj = (s) => String(s || '').toLowerCase()
    .replace(/["""'''\u2018\u2019\u201c\u201d?!.,;:]/g, '').replace(/\s+/g, ' ').trim();
  // Extract the key quoted term from a subject like "Unclear abbreviation 'HOS'" → "HOS".
  // Returns null for person-identity subjects (handled separately) and unquoted subjects.
  const extractQuotedTerm = (subj) => {
    const s = String(subj || '').trim();
    if (/^who\s+(is|are)/i.test(s)) return null; // person question, handled by alias path
    const m = s.match(/['"'\u2018\u2019\u201c\u201d]([^'"'\u2018\u2019\u201c\u201d]{1,50})['"'\u2019\u201d\u201c]/);
    return m ? m[1].trim().toLowerCase() : null;
  };
  const allAnsweredRaw = db.prepare(
    `SELECT subject FROM backlog_items WHERE status='answered'`
  ).all();
  const normalizedAnsweredSet = new Set(allAnsweredRaw.map(r => normalizeSubj(r.subject)));
  // Term-based dedup: check the notebook_glossary table (durable) AND scan answered subjects
  // for quoted terms so "Context for 'Valor'?" is caught even if 'Valor' was answered under
  // a different subject phrasing ("Meaning of 'Valor'", "Reference to 'Valor'", etc.).
  const glossaryTerms = db.prepare(`SELECT term FROM notebook_glossary`).all()
    .map(r => r.term.toLowerCase());
  const answeredTermsSet = new Set([
    ...glossaryTerms,
    ...allAnsweredRaw.map(r => extractQuotedTerm(r.subject)).filter(Boolean),
  ]);
  const allPendingRaw = db.prepare(
    `SELECT subject FROM backlog_items WHERE status='pending'`
  ).all();
  const normalizedPendingSet = new Set(allPendingRaw.map(r => normalizeSubj(r.subject)));
  const pendingTermsSet = new Set(
    allPendingRaw.map(r => extractQuotedTerm(r.subject)).filter(Boolean)
  );
  const extractPersonName = (subj) => {
    // Extract the name from common person-ID question shapes.
    const s = String(subj || '').trim().replace(/[\u201c\u201d\u2018\u2019]/g, '”');
    let m = s.match(/^who\s+(?:is|are)\s+[“”'']?([^””''?]+?)[“”'']?\??$/i);
    if (m) return m[1].trim();
    m = s.match(/^identify\s+(?:person|people|name):\s*(.+?)\??$/i);
    if (m) return m[1].trim();
    m = s.match(/^clarify\s+(?:mention\s+of|who\s+is|name|person):\s*(.+?)\??$/i);
    if (m) return m[1].trim();
    m = s.match(/^unclear\s+(?:name|person|reference)\s*[“”'']?(.+?)[“”'']?\??$/i);
    if (m) return m[1].trim();
    m = s.match(/^ambiguous\s+(?:name|person|reference):\s*(.+?)\??$/i);
    if (m) return m[1].trim();
    m = s.match(/^(?:person|name)\s+[“”'']([^””'']+)[“”'']\s+(?:is|needs)\s+/i);
    if (m) return m[1].trim();
    return null;
  };
  const personDup = db.prepare(
    `SELECT 1 FROM backlog_items
     WHERE (subject LIKE ? COLLATE NOCASE OR subject LIKE ? COLLATE NOCASE
        OR subject LIKE ? COLLATE NOCASE OR subject LIKE ? COLLATE NOCASE)
       AND (status='pending' OR status='answered')
     LIMIT 1`
  );
  // Skip if a person with this label already exists (known canonical or alias).
  const personLabelKnown = db.prepare(
    `SELECT 1 FROM people WHERE label = ? COLLATE NOCASE LIMIT 1`
  );
  const personAliasKnown = db.prepare(
    `SELECT 1 FROM people
     WHERE (',' || LOWER(COALESCE(first_names,'')) || ',') LIKE (',%' || LOWER(?) || ',%')
     LIMIT 1`
  );
  const insertMany = db.transaction((rows) => {
    for (const r of rows) {
      const subj = String(r.subject || '').trim();
      if (!subj) continue;
      if (pendingSame.get(subj)) continue;
      if (everAnswered.get(subj)) continue;
      // Normalized fallback: catch phrasing variants that differ only in quotes/punctuation.
      const subjNorm = normalizeSubj(subj);
      if (normalizedAnsweredSet.has(subjNorm)) continue;
      if (normalizedPendingSet.has(subjNorm)) continue;
      // Term-based dedup: "Context for 'Valor'?" is a duplicate of any answered
      // question that also quoted "Valor" — regardless of how the sentence differs.
      const incomingTerm = extractQuotedTerm(subj);
      if (incomingTerm && answeredTermsSet.has(incomingTerm)) continue;
      if (incomingTerm && pendingTermsSet.has(incomingTerm)) continue;
      const name = extractPersonName(subj);
      if (name) {
        const dup = personDup.get(
          `%who is%${name}%`, `%identify person:%${name}%`,
          `%clarify mention of%${name}%`, `%unclear name%${name}%`
        );
        if (dup) continue;
        // Skip if we already know this person by label or as a stored alias.
        if (personLabelKnown.get(name)) continue;
        if (personAliasKnown.get(name)) continue;
      }
      const optionsJson = r.answer_options ? JSON.stringify(r.answer_options) : null;
      stmt.run(r.id, r.kind, r.subject, r.proposal ?? r.subject, r.context_page_id ?? null, r.answer_format ?? null, optionsJson);
    }
  });
  insertMany(items);
}

function getPendingBacklogForPage(pageId) {
  const rows = db.prepare(`
    SELECT * FROM backlog_items
    WHERE status='pending' AND context_page_id = ?
    ORDER BY created_at DESC
  `).all(pageId);
  return rows.map(r => ({ ...r, answer_options: r.answer_options ? JSON.parse(r.answer_options) : null }));
}

function getPendingBacklogForCollection(collectionId) {
  // Questions tied to any page linked to this collection
  const rows = db.prepare(`
    SELECT b.* FROM backlog_items b
    JOIN links l ON l.from_type='page' AND l.from_id=b.context_page_id
    WHERE b.status='pending' AND l.to_type='collection' AND l.to_id=?
    GROUP BY b.id
    ORDER BY b.created_at DESC
  `).all(collectionId);
  return rows.map(r => ({ ...r, answer_options: r.answer_options ? JSON.parse(r.answer_options) : null }));
}

function getRecentAnsweredQuestions(limit = 50) {
  const rows = db.prepare(`
    SELECT subject, answer FROM backlog_items
    WHERE status='answered' AND answer IS NOT NULL
    ORDER BY created_at DESC LIMIT ?
  `).all(limit);
  return rows;
}

function getPendingBacklog() {
  const rows = db.prepare(`
    SELECT b.*, p.volume, p.page_number, p.scan_path
    FROM backlog_items b
    LEFT JOIN pages p ON p.id = b.context_page_id
    WHERE b.status = 'pending'
    ORDER BY b.created_at DESC
  `).all();
  return rows.map(r => ({
    ...r,
    answer_options: r.answer_options ? JSON.parse(r.answer_options) : null,
  }));
}

function getBacklogItem(id) {
  const r = db.prepare('SELECT * FROM backlog_items WHERE id = ?').get(id);
  if (!r) return null;
  return { ...r, answer_options: r.answer_options ? JSON.parse(r.answer_options) : null };
}

function updateBacklogStatus(id, status, answer = null) {
  return db.prepare(`UPDATE backlog_items SET status = ?, answer = COALESCE(?, answer) WHERE id = ?`)
    .run(status, answer, id);
}

// --- Notebook Glossary ---

// Upsert a term → meaning pair. On conflict (same term, case-insensitive) update the meaning.
function upsertGlossaryTerm({ term, meaning, kind = 'term', sourceBacklogId = null }) {
  const t = String(term || '').trim();
  const m = String(meaning || '').trim();
  if (!t || !m) return null;
  const existing = db.prepare(`SELECT id FROM notebook_glossary WHERE term = ? COLLATE NOCASE`).get(t);
  if (existing) {
    db.prepare(`UPDATE notebook_glossary SET meaning = ?, kind = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(m, kind, existing.id);
    return existing.id;
  }
  const id = require('crypto').randomUUID();
  db.prepare(`INSERT INTO notebook_glossary (id, term, meaning, kind, source_backlog_id) VALUES (?, ?, ?, ?, ?)`)
    .run(id, t, m, kind, sourceBacklogId ?? null);
  return id;
}

// All glossary terms, ordered by term. Used to build context blocks.
function getGlossary() {
  return db.prepare(`SELECT term, meaning, kind FROM notebook_glossary ORDER BY term ASC`).all();
}

// Check if a given term (case-insensitive) is already in the glossary.
function isTermInGlossary(term) {
  return !!db.prepare(`SELECT 1 FROM notebook_glossary WHERE term = ? COLLATE NOCASE LIMIT 1`).get(term);
}

// Try to extract a (term, meaning, kind) pair from an answered backlog subject+answer.
// Returns null if the subject doesn't contain a clearly quoted term.
function extractGlossaryEntryFromBacklog(subject, answer) {
  const s = String(subject || '').trim();
  const a = String(answer || '').trim();
  // Skip person-identity questions (handled by alias system)
  if (/^who\s+(is|are)/i.test(s)) return null;
  // Skip vague one-word or UUID answers
  if (!a || a.length < 2) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(a)) return null; // UUID
  if (/^(yes|no|correct|ok|okay|right|sure|yep|nope|confirmed)$/i.test(a)) return null;
  // Extract quoted term from subject
  const m = s.match(/['"'\u2018\u2019\u201c\u201d]([^'"'\u2018\u2019\u201c\u201d]{1,60})['"'\u2019\u201d\u201c]/);
  if (!m) return null;
  const term = m[1].trim();
  if (!term) return null;
  // Classify kind based on subject wording
  let kind = 'term';
  if (/abbrev|acronym|initial/i.test(s)) kind = 'abbreviation';
  else if (/symbol|mark|notation|icon/i.test(s)) kind = 'symbol';
  else if (/handwriting|word|illegib/i.test(s)) kind = 'handwriting';
  // Clean up the answer as the meaning
  const meaning = a.replace(/^(that|it|this)\s+(is|says?|means?|stands?\s+for|refers?\s+to)\s+/i, '')
    .replace(/^["'"'\u201c\u2018]|["'"'\u201d\u2019]$/g, '').trim();
  if (!meaning) return null;
  return { term, meaning, kind };
}

// Populate/refresh the glossary from all existing answered backlog questions.
// Called at startup — idempotent, only adds new entries.
function syncGlossaryFromBacklog() {
  const rows = db.prepare(
    `SELECT id, subject, answer FROM backlog_items WHERE status='answered' AND answer IS NOT NULL`
  ).all();
  let added = 0;
  for (const row of rows) {
    const entry = extractGlossaryEntryFromBacklog(row.subject, row.answer);
    if (!entry) continue;
    if (isTermInGlossary(entry.term)) continue; // already have it
    upsertGlossaryTerm({ ...entry, sourceBacklogId: row.id });
    added++;
  }
  if (added) console.log(`[glossary] seeded ${added} term(s) from answered backlog`);
  return added;
}

// --- Collections ---

function findCollection(kind, title) {
  return db.prepare(
    `SELECT * FROM collections WHERE kind = ? AND title = ? COLLATE NOCASE`
  ).get(kind, title);
}

function createCollection({ id, kind, title, description, target_date, status }) {
  db.prepare(
    `INSERT INTO collections (id, kind, title, description, target_date, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(kind, title COLLATE NOCASE) DO NOTHING`
  ).run(id, kind, title, description ?? null, target_date ?? null, status ?? null);
  return findCollection(kind, title);
}

function linkPageToCollection(pageId, collectionId, confidence = 1.0) {
  // dedupe: skip if link already exists
  const existing = db.prepare(
    `SELECT id FROM links WHERE from_type='page' AND from_id=? AND to_type='collection' AND to_id=?`
  ).get(pageId, collectionId);
  if (existing) return existing.id;

  const id = require('crypto').randomUUID();
  db.prepare(
    `INSERT INTO links (id, from_type, from_id, to_type, to_id, created_by, confidence)
     VALUES (?, 'page', ?, 'collection', ?, 'foxed', ?)`
  ).run(id, pageId, collectionId, confidence);
  return id;
}

function getCollectionsForPage(pageId) {
  return db.prepare(`
    SELECT c.* FROM links l
    JOIN collections c ON c.id = l.to_id
    WHERE l.from_type='page' AND l.from_id=? AND l.to_type='collection'
  `).all(pageId);
}

// Recent pages near a given page number (for collection-continuity context)
function getRecentPagesForContext(volume, pageNumber, limit = 5) {
  const rows = db.prepare(`
    SELECT p.*, (
      SELECT group_concat(c.kind || ':' || c.title, '|')
      FROM links l JOIN collections c ON c.id = l.to_id
      WHERE l.from_type='page' AND l.from_id=p.id AND l.to_type='collection'
    ) as collections
    FROM pages p
    ORDER BY
      CASE WHEN ? IS NOT NULL AND p.volume = ? THEN 0 ELSE 1 END,
      CASE WHEN ? IS NOT NULL AND p.page_number IS NOT NULL
        THEN ABS(p.page_number - ?) ELSE 999 END,
      p.captured_at DESC
    LIMIT ?
  `).all(volume, volume, pageNumber, pageNumber, limit);
  return rows;
}

// --- Scripture refs ---

function upsertScriptureRef({ canonical, book, chapter, verse_start, verse_end }) {
  const existing = db.prepare('SELECT * FROM scripture_refs WHERE canonical = ? COLLATE NOCASE').get(canonical);
  if (existing) return existing;
  const id = require('crypto').randomUUID();
  db.prepare(`
    INSERT INTO scripture_refs (id, canonical, book, chapter, verse_start, verse_end)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, canonical, book, chapter, verse_start ?? null, verse_end ?? null);
  return { id, canonical, book, chapter, verse_start, verse_end };
}

function linkPageToScripture(pageId, scriptureId, confidence = 1.0, role_summary = null) {
  const existing = db.prepare(
    `SELECT id, role_summary FROM links WHERE from_type='page' AND from_id=? AND to_type='scripture' AND to_id=?`
  ).get(pageId, scriptureId);
  if (existing) {
    if (role_summary && !existing.role_summary) {
      db.prepare(`UPDATE links SET role_summary = ? WHERE id = ?`).run(role_summary, existing.id);
    }
    return existing.id;
  }
  const id = require('crypto').randomUUID();
  db.prepare(
    `INSERT INTO links (id, from_type, from_id, to_type, to_id, created_by, confidence, role_summary)
     VALUES (?, 'page', ?, 'scripture', ?, 'foxed', ?, ?)`
  ).run(id, pageId, scriptureId, confidence, role_summary);
  return id;
}

const BOOK_ORDER = {
  'Genesis':1,'Exodus':2,'Leviticus':3,'Numbers':4,'Deuteronomy':5,'Joshua':6,'Judges':7,'Ruth':8,
  '1 Samuel':9,'2 Samuel':10,'1 Kings':11,'2 Kings':12,'1 Chronicles':13,'2 Chronicles':14,
  'Ezra':15,'Nehemiah':16,'Esther':17,'Job':18,'Psalms':19,'Psalm':19,'Proverbs':20,
  'Ecclesiastes':21,'Song of Solomon':22,'Song of Songs':22,'Isaiah':23,'Jeremiah':24,
  'Lamentations':25,'Ezekiel':26,'Daniel':27,'Hosea':28,'Joel':29,'Amos':30,'Obadiah':31,
  'Jonah':32,'Micah':33,'Nahum':34,'Habakkuk':35,'Zephaniah':36,'Haggai':37,'Zechariah':38,'Malachi':39,
  'Matthew':40,'Mark':41,'Luke':42,'John':43,'Acts':44,'Romans':45,'1 Corinthians':46,'2 Corinthians':47,
  'Galatians':48,'Ephesians':49,'Philippians':50,'Colossians':51,'1 Thessalonians':52,'2 Thessalonians':53,
  '1 Timothy':54,'2 Timothy':55,'Titus':56,'Philemon':57,'Hebrews':58,'James':59,'1 Peter':60,'2 Peter':61,
  '1 John':62,'2 John':63,'3 John':64,'Jude':65,'Revelation':66
};

function getScriptureIndex() {
  const rows = db.prepare(`
    SELECT s.*, COUNT(l.id) as mention_count
    FROM scripture_refs s
    LEFT JOIN links l ON l.to_type='scripture' AND l.to_id=s.id
    GROUP BY s.id
  `).all();
  if (rows.length === 0) return [];

  // One shot: every page linked to any scripture, with daily_log_date + role_summary.
  const pageRows = db.prepare(`
    SELECT l.to_id as entity_id,
           p.id, p.volume, p.page_number, p.scan_path, p.summary, p.captured_at,
           l.role_summary,
           d.date as daily_log_date
    FROM links l
    JOIN pages p ON p.id = l.from_id
    LEFT JOIN links ld ON ld.from_type='page' AND ld.from_id=p.id AND ld.to_type='daily_log'
    LEFT JOIN daily_logs d ON d.id = ld.to_id
    WHERE l.to_type='scripture' AND l.from_type='page'
    ORDER BY p.captured_at DESC
  `).all();
  const pagesByEntity = {};
  for (const pr of pageRows) {
    const { entity_id, ...page } = pr;
    (pagesByEntity[entity_id] = pagesByEntity[entity_id] || []).push(page);
  }

  // Sibling collections/books linked to each scripture ref.
  const collRows = db.prepare(`
    SELECT l.to_id as entity_id, c.id, c.kind, c.title
    FROM links l JOIN collections c ON c.id = l.from_id
    WHERE l.from_type='collection' AND l.to_type='scripture'
  `).all();
  const bookRows = db.prepare(`
    SELECT l.to_id as entity_id, b.id, b.title, b.author_label
    FROM links l JOIN books b ON b.id = l.from_id
    WHERE l.from_type='book' AND l.to_type='scripture'
  `).all();
  const collByEntity = {}; for (const r of collRows) (collByEntity[r.entity_id] = collByEntity[r.entity_id] || []).push({ id: r.id, kind: r.kind, title: r.title });
  const bookByEntity = {}; for (const r of bookRows) (bookByEntity[r.entity_id] = bookByEntity[r.entity_id] || []).push({ id: r.id, title: r.title, author_label: r.author_label });

  const withPages = rows.map(r => {
    const enriched = pagesByEntity[r.id] || [];
    return {
      ...r,
      pages: enriched,
      recent_page: enriched[0] ?? null,
      collections: collByEntity[r.id] || [],
      books: bookByEntity[r.id] || [],
      book_order: BOOK_ORDER[r.book] ?? 999,
    };
  });
  withPages.sort((a, b) =>
    a.book_order - b.book_order ||
    a.chapter - b.chapter ||
    (a.verse_start ?? 0) - (b.verse_start ?? 0)
  );
  return withPages;
}

// --- People ---

function upsertPerson({ label }) {
  const existing = db.prepare('SELECT * FROM people WHERE label = ? COLLATE NOCASE').get(label);
  if (existing) return existing;
  const id = require('crypto').randomUUID();
  db.prepare(`
    INSERT INTO people (id, label, priority, growth_note, created_at)
    VALUES (?, ?, 0, NULL, datetime('now'))
  `).run(id, label);
  return { id, label, priority: 0, growth_note: null, household_id: null, first_names: null };
}

// Find candidate people whose label starts with `firstName` OR whose first_names
// CSV contains it. Used by the first-name disambiguation flow during ingest.
function findPeopleByFirstName(firstName) {
  const fn = String(firstName || '').trim();
  if (!fn) return [];
  const like = fn + '%';
  const pat = '%' + fn + '%';
  return db.prepare(`
    SELECT DISTINCT p.*
    FROM people p
    WHERE p.label LIKE ? COLLATE NOCASE
       OR (p.first_names IS NOT NULL AND p.first_names LIKE ? COLLATE NOCASE)
  `).all(like, pat);
}

// Return the most-recent link date for each given person id, for recency tie-breaking.
function personRecencyMap(personIds) {
  if (!personIds || !personIds.length) return {};
  const placeholders = personIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT l.to_id AS person_id, MAX(pg.captured_at) AS last_seen
    FROM links l JOIN pages pg ON pg.id = l.from_id
    WHERE l.to_type='person' AND l.from_type='page' AND l.to_id IN (${placeholders})
    GROUP BY l.to_id
  `).all(...personIds);
  const map = {};
  for (const r of rows) map[r.person_id] = r.last_seen;
  return map;
}

// ── Households ──────────────────────────────────────────────────────────────
function listHouseholds() {
  return db.prepare(`
    SELECT h.*,
      (SELECT COUNT(*) FROM people p WHERE p.household_id = h.id) AS member_count,
      (SELECT COUNT(DISTINCT l.from_id) FROM links l
         JOIN people p2 ON p2.id = l.to_id
         WHERE l.from_type='page' AND l.to_type='person' AND p2.household_id = h.id) AS page_count,
      (SELECT COUNT(*) FROM links l WHERE l.from_type='page' AND l.to_type='household' AND l.to_id = h.id) AS direct_mention_count
    FROM households h
    ORDER BY h.archived_at IS NOT NULL, h.name COLLATE NOCASE
  `).all();
}

// Direct mentions of a household — pages that mention the household as a whole
// (e.g. "Brenneke's over for dinner"), NOT pages about individual members.
function getHouseholdMentions(householdId) {
  return db.prepare(`
    SELECT pg.id, pg.volume, pg.page_number, pg.scan_path, pg.summary,
           pg.captured_at, pg.source_kind,
           l.role_summary,
           d.date as daily_log_date
    FROM links l
    JOIN pages pg ON pg.id = l.from_id
    LEFT JOIN links ld ON ld.from_type='page' AND ld.from_id=pg.id AND ld.to_type='daily_log'
    LEFT JOIN daily_logs d ON d.id = ld.to_id
    WHERE l.from_type='page' AND l.to_type='household' AND l.to_id = ?
    ORDER BY pg.captured_at DESC
  `).all(householdId);
}

// Fuzzy match a household by mention text. Accepts "Brenneke", "Brennekes",
// "Brenneke's", "Brenneke family", etc. — strips trailing possessive/plural
// and " family" then compares case-insensitively against household name.
function findHouseholdByMention(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const strip = (s) => s
    .replace(/['’]s\b/i, '')
    .replace(/\bfamily\b/i, '')
    .replace(/\bhousehold\b/i, '')
    .replace(/s\b/, '')
    .trim()
    .toLowerCase();
  const needle = strip(raw);
  const rows = db.prepare(`SELECT id, name FROM households WHERE archived_at IS NULL`).all();
  for (const h of rows) {
    const hk = strip(h.name);
    if (!hk) continue;
    if (hk === needle) return h;
    if (hk.startsWith(needle) || needle.startsWith(hk)) return h;
  }
  return null;
}

function linkPageToHousehold(pageId, householdId, confidence = 1.0, role_summary = null) {
  const existing = db.prepare(
    `SELECT id, role_summary FROM links WHERE from_type='page' AND from_id=? AND to_type='household' AND to_id=?`
  ).get(pageId, householdId);
  if (existing) {
    if (role_summary && !existing.role_summary) {
      db.prepare(`UPDATE links SET role_summary = ? WHERE id = ?`).run(role_summary, existing.id);
    }
    return existing.id;
  }
  const id = require('crypto').randomUUID();
  db.prepare(
    `INSERT INTO links (id, from_type, from_id, to_type, to_id, created_by, confidence, role_summary)
     VALUES (?, 'page', ?, 'household', ?, 'foxed', ?, ?)`
  ).run(id, pageId, householdId, confidence, role_summary);
  return id;
}

// Upsert-by-name helper for households. Used by the ingest pipeline when the
// AI emits a household entity we've never seen before.
function upsertHouseholdByName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const existing = db.prepare(`SELECT * FROM households WHERE name = ? COLLATE NOCASE`).get(trimmed);
  if (existing) return existing;
  return createHousehold({ name: trimmed, notes: null });
}

function createHousehold({ name, notes }) {
  const id = require('crypto').randomUUID();
  db.prepare(`INSERT INTO households (id, name, notes, created_at) VALUES (?, ?, ?, datetime('now'))`)
    .run(id, name, notes ?? null);
  return db.prepare('SELECT * FROM households WHERE id = ?').get(id);
}

function updateHousehold(id, { name, notes, archived }) {
  const fields = [], vals = [];
  if (name !== undefined) { fields.push('name = ?'); vals.push(name); }
  if (notes !== undefined) { fields.push('notes = ?'); vals.push(notes); }
  if (archived !== undefined) { fields.push("archived_at = ?"); vals.push(archived ? new Date().toISOString() : null); }
  if (!fields.length) return;
  vals.push(id);
  db.prepare(`UPDATE households SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

function deleteHousehold(id) {
  db.prepare(`UPDATE people SET household_id = NULL WHERE household_id = ?`).run(id);
  return db.prepare(`DELETE FROM households WHERE id = ?`).run(id);
}

function setPersonHousehold(personId, householdId) {
  db.prepare(`UPDATE people SET household_id = ? WHERE id = ?`).run(householdId ?? null, personId);
}

function getHouseholdDetail(id) {
  const h = db.prepare('SELECT * FROM households WHERE id = ?').get(id);
  if (!h) return null;
  const members = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM links l WHERE l.to_type='person' AND l.to_id=p.id AND l.from_type='page') AS mention_count
    FROM people p
    WHERE p.household_id = ?
    ORDER BY p.label COLLATE NOCASE
  `).all(id);
  const memberIds = members.map(m => m.id);
  let pages = [];
  if (memberIds.length) {
    const placeholders = memberIds.map(() => '?').join(',');
    pages = db.prepare(`
      SELECT DISTINCT pg.id, pg.volume, pg.page_number, pg.scan_path, pg.summary, pg.captured_at,
        GROUP_CONCAT(DISTINCT p.label) AS mentioned_people
      FROM links l
      JOIN pages pg ON pg.id = l.from_id
      JOIN people p ON p.id = l.to_id
      WHERE l.from_type='page' AND l.to_type='person' AND l.to_id IN (${placeholders})
      GROUP BY pg.id
      ORDER BY pg.captured_at DESC
      LIMIT 200
    `).all(...memberIds);
  }
  return { household: h, members, pages };
}

function linkPageToPerson(pageId, personId, confidence = 1.0, role_summary = null) {
  const existing = db.prepare(
    `SELECT id, role_summary FROM links WHERE from_type='page' AND from_id=? AND to_type='person' AND to_id=?`
  ).get(pageId, personId);
  if (existing) {
    if (role_summary && !existing.role_summary) {
      db.prepare(`UPDATE links SET role_summary = ? WHERE id = ?`).run(role_summary, existing.id);
    }
    return existing.id;
  }
  const id = require('crypto').randomUUID();
  db.prepare(
    `INSERT INTO links (id, from_type, from_id, to_type, to_id, created_by, confidence, role_summary)
     VALUES (?, 'page', ?, 'person', ?, 'foxed', ?, ?)`
  ).run(id, pageId, personId, confidence, role_summary);
  return id;
}

function getPeopleIndex() {
  const rows = db.prepare(`
    SELECT p.*, COUNT(l.id) as mention_count
    FROM people p
    LEFT JOIN links l ON l.to_type='person' AND l.to_id=p.id
    GROUP BY p.id
    ORDER BY p.priority DESC, p.label COLLATE NOCASE
  `).all();
  if (rows.length === 0) return [];

  // One shot: every page linked to any person, with daily_log_date + role_summary.
  const pageRows = db.prepare(`
    SELECT l.to_id as person_id,
           pg.id, pg.volume, pg.page_number, pg.scan_path, pg.summary, pg.captured_at,
           l.role_summary,
           d.date as daily_log_date
    FROM links l
    JOIN pages pg ON pg.id = l.from_id
    LEFT JOIN links ld ON ld.from_type='page' AND ld.from_id=pg.id AND ld.to_type='daily_log'
    LEFT JOIN daily_logs d ON d.id = ld.to_id
    WHERE l.to_type='person' AND l.from_type='page'
    ORDER BY pg.captured_at DESC
  `).all();

  // For rows with no role_summary we fall back to a LIKE on items. Instead of
  // running a per-(page,person) query, pull all mentioning items once per person
  // only when needed — batch by page into a map.
  const pagesByPerson = {};
  const needsItemFallback = [];
  for (const pr of pageRows) {
    const { person_id, role_summary, ...page } = pr;
    page.person_mentions = role_summary ? [role_summary] : null; // filled below if null
    (pagesByPerson[person_id] = pagesByPerson[person_id] || []).push(page);
    if (!role_summary) needsItemFallback.push({ person_id, page_id: page.id });
  }

  // Pre-fetch labels so we can LIKE-scan for mentions.
  const personLabelById = Object.fromEntries(rows.map(r => [r.id, r.label]));

  // Batch-fetch items for all pages that need fallback. Then filter in JS.
  const fallbackPageIds = [...new Set(needsItemFallback.map(f => f.page_id))];
  let itemsByPage = {};
  if (fallbackPageIds.length) {
    const placeholders = fallbackPageIds.map(() => '?').join(',');
    const itemRows = db.prepare(
      `SELECT page_id, text FROM items WHERE page_id IN (${placeholders})`
    ).all(...fallbackPageIds);
    for (const ir of itemRows) {
      (itemsByPage[ir.page_id] = itemsByPage[ir.page_id] || []).push(ir.text);
    }
  }
  for (const fb of needsItemFallback) {
    const label = personLabelById[fb.person_id];
    if (!label) continue;
    const texts = itemsByPage[fb.page_id] || [];
    const needle = label.toLowerCase();
    const hits = texts.filter(t => t.toLowerCase().includes(needle)).slice(0, 4);
    // fill in the matching page entry
    const list = pagesByPerson[fb.person_id] || [];
    for (const pg of list) {
      if (pg.id === fb.page_id && pg.person_mentions === null) {
        pg.person_mentions = hits;
        break;
      }
    }
  }

  // Sibling collections/books linked to each person.
  const collRows = db.prepare(`
    SELECT l.to_id as person_id, c.id, c.kind, c.title
    FROM links l JOIN collections c ON c.id = l.from_id
    WHERE l.from_type='collection' AND l.to_type='person'
  `).all();
  const bookRows = db.prepare(`
    SELECT l.to_id as person_id, b.id, b.title, b.author_label
    FROM links l JOIN books b ON b.id = l.from_id
    WHERE l.from_type='book' AND l.to_type='person'
  `).all();
  const collByPerson = {}; for (const r of collRows) (collByPerson[r.person_id] = collByPerson[r.person_id] || []).push({ id: r.id, kind: r.kind, title: r.title });
  const bookByPerson = {}; for (const r of bookRows) (bookByPerson[r.person_id] = bookByPerson[r.person_id] || []).push({ id: r.id, title: r.title, author_label: r.author_label });

  return rows.map(r => {
    const enriched = pagesByPerson[r.id] || [];
    return {
      ...r,
      pages: enriched,
      recent_page: enriched[0] ?? null,
      collections: collByPerson[r.id] || [],
      books: bookByPerson[r.id] || [],
    };
  });
}

function listPeople() {
  return getPeopleIndex();
}

// Append an alias (nickname / short form) to a person's first_names CSV.
// Safe to call repeatedly — no-ops if alias is already present or matches label.
function addPersonAlias(personId, alias) {
  const a = String(alias || '').trim();
  if (!a) return false;
  const p = db.prepare('SELECT label, first_names FROM people WHERE id = ?').get(personId);
  if (!p) return false;
  if (p.label && p.label.toLowerCase() === a.toLowerCase()) return false;
  const existing = (p.first_names || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (existing.some(e => e.toLowerCase() === a.toLowerCase())) return false;
  existing.push(a);
  db.prepare('UPDATE people SET first_names = ? WHERE id = ?')
    .run(existing.join(', '), personId);
  return true;
}

// Find pages whose items reference `alias` as a whole word (case-insensitive).
// Uses items.text rather than the page summary for recall — summaries drop names.
// Optional excludePageId skips the page that triggered the learning.
function findPagesMentioningAlias(alias, { excludePageId = null, limit = 100 } = {}) {
  const a = String(alias || '').trim();
  if (!a) return [];
  // Word-boundary-ish match. SQLite LIKE is case-insensitive for ASCII by default.
  // We pad with non-word chars on both sides using GLOB after LIKE filters cheaply.
  const like = `%${a}%`;
  const rows = db.prepare(`
    SELECT DISTINCT p.id, p.volume, p.page_number, p.captured_at
    FROM pages p
    JOIN items i ON i.page_id = p.id
    WHERE i.text LIKE ? COLLATE NOCASE
      ${excludePageId ? 'AND p.id != ?' : ''}
    ORDER BY p.captured_at DESC
    LIMIT ?
  `).all(...(excludePageId ? [like, excludePageId, limit] : [like, limit]));
  // Narrow to word-boundary hits (avoid matching "Baz" inside "Bazaar").
  const re = new RegExp(`\\b${a.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
  const kept = [];
  for (const r of rows) {
    const hit = db.prepare(
      `SELECT 1 FROM items WHERE page_id = ? AND text LIKE ? COLLATE NOCASE LIMIT 1`
    ).all(r.id, like);
    if (!hit.length) continue;
    // Verify word-boundary against joined text
    const joined = db.prepare(
      `SELECT GROUP_CONCAT(text, ' ') as t FROM items WHERE page_id = ?`
    ).get(r.id);
    if (joined?.t && re.test(joined.t)) kept.push(r);
  }
  return kept;
}

// All confirmed handwriting corrections — answers to backlog questions prefixed
// with "[Handwriting]:" so Gemini can apply them on every future parse.
function getHandwritingCorrections() {
  return db.prepare(`
    SELECT subject, answer FROM backlog_items
    WHERE status = 'answered'
      AND answer IS NOT NULL
      AND LOWER(subject) LIKE '[handwriting]:%'
    ORDER BY created_at ASC
  `).all();
}

// Known-alias map for AI prompts. Returns compact [{canonical, aliases:[...]}]
// for all people with at least one alias on file. Durable (not the 30-item window).
function getKnownAliases(limit = 200) {
  const rows = db.prepare(`
    SELECT label, first_names FROM people
    WHERE first_names IS NOT NULL AND TRIM(first_names) != ''
    ORDER BY label COLLATE NOCASE
    LIMIT ?
  `).all(limit);
  return rows.map(r => ({
    canonical: r.label,
    aliases: (r.first_names || '').split(',').map(s => s.trim()).filter(Boolean),
  })).filter(r => r.aliases.length);
}

function updatePerson(id, { priority, growth_note, label }) {
  if (label) {
    const existing = db.prepare(
      `SELECT id FROM people WHERE label = ? COLLATE NOCASE AND id != ?`
    ).get(label, id);
    if (existing) {
      db.prepare(`UPDATE links SET to_id = ? WHERE to_type='person' AND to_id = ?`).run(existing.id, id);
      dedupeLinks();
      db.prepare(`DELETE FROM people WHERE id = ?`).run(id);
      return { merged_into: existing.id };
    }
  }
  db.prepare(`
    UPDATE people SET
      priority = COALESCE(?, priority),
      growth_note = COALESCE(?, growth_note),
      label = COALESCE(?, label)
    WHERE id = ?
  `).run(priority ?? null, growth_note ?? null, label ?? null, id);
  return { id };
}

// Reclassify a person as a topic. Finds (or creates) a topic entity with the same
// label, rewrites all `links` rows pointing at the person to point at the topic,
// then deletes the person row. Idempotent: if a topic with that label already exists,
// links merge into it.
function reclassifyPersonAsTopic(personId) {
  const person = db.prepare(`SELECT id, label FROM people WHERE id = ?`).get(personId);
  if (!person) throw new Error('person not found');
  const label = person.label;
  let topic = db.prepare(
    `SELECT id FROM entities WHERE kind='topic' AND label = ? COLLATE NOCASE`
  ).get(label);
  if (!topic) {
    const id = require('crypto').randomUUID();
    db.prepare(`INSERT INTO entities (id, kind, label) VALUES (?, 'topic', ?)`).run(id, label);
    topic = { id };
  }
  const moved = db.prepare(
    `UPDATE links SET to_type='topic', to_id = ? WHERE to_type='person' AND to_id = ?`
  ).run(topic.id, personId);
  dedupeLinks();
  db.prepare(`DELETE FROM people WHERE id = ?`).run(personId);
  return { topic_id: topic.id, label, links_moved: moved.changes };
}

// --- Topics index (from generic entities table) ---

// Rename or merge a topic. If another topic already has `label`, moves all links
// to the existing topic and deletes this one (merge). Otherwise just relabels.
function setTopicParent(id, parentId) {
  if (parentId === id) throw new Error('topic cannot be its own parent');
  if (parentId) {
    let cursor = parentId;
    const seen = new Set();
    while (cursor) {
      if (cursor === id) throw new Error('cycle: target is already a descendant');
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const row = db.prepare(`SELECT parent_id FROM entities WHERE id = ? AND kind='topic'`).get(cursor);
      cursor = row ? row.parent_id : null;
    }
    const exists = db.prepare(`SELECT id FROM entities WHERE id = ? AND kind='topic'`).get(parentId);
    if (!exists) throw new Error('parent topic not found');
  }
  db.prepare(`UPDATE entities SET parent_id = ? WHERE id = ? AND kind='topic'`).run(parentId || null, id);
  return { id, parent_id: parentId || null };
}

function updateTopicLabel(id, label) {
  if (!label || !label.trim()) throw new Error('label required');
  const existing = db.prepare(
    `SELECT id FROM entities WHERE kind='topic' AND label = ? COLLATE NOCASE AND id != ?`
  ).get(label, id);
  if (existing) {
    db.prepare(`UPDATE links SET to_id = ? WHERE to_type='topic' AND to_id = ?`).run(existing.id, id);
    dedupeLinks();
    db.prepare(`DELETE FROM entities WHERE id = ? AND kind='topic'`).run(id);
    return { merged_into: existing.id };
  }
  db.prepare(`UPDATE entities SET label = ? WHERE id = ? AND kind='topic'`).run(label, id);
  return { id };
}

function getTopicsIndex() {
  const rows = db.prepare(`
    SELECT e.id, e.label, e.kind, e.parent_id
    FROM entities e
    WHERE e.kind = 'topic'
    ORDER BY e.label COLLATE NOCASE
  `).all();
  if (rows.length === 0) return [];

  // One shot: every page linked to any topic, with daily_log_date + role_summary.
  const pageRows = db.prepare(`
    SELECT l.to_id as topic_id,
           p.id, p.volume, p.page_number, p.scan_path, p.summary, p.captured_at,
           l.role_summary,
           d.date as daily_log_date
    FROM links l
    JOIN pages p ON p.id = l.from_id
    LEFT JOIN links ld ON ld.from_type='page' AND ld.from_id=p.id AND ld.to_type='daily_log'
    LEFT JOIN daily_logs d ON d.id = ld.to_id
    WHERE l.to_type='topic' AND l.from_type='page'
    ORDER BY p.captured_at DESC
  `).all();
  const pagesByTopic = {};
  for (const pr of pageRows) {
    const { topic_id, ...page } = pr;
    // dedupe per topic: same page can appear twice via multiple link rows
    const list = (pagesByTopic[topic_id] = pagesByTopic[topic_id] || []);
    if (!list.some(p => p.id === page.id)) list.push(page);
  }

  // Sibling collections/books linked to each topic.
  const collRows = db.prepare(`
    SELECT l.to_id as topic_id, c.id, c.kind, c.title
    FROM links l JOIN collections c ON c.id = l.from_id
    WHERE l.from_type='collection' AND l.to_type='topic'
  `).all();
  const bookRows = db.prepare(`
    SELECT l.to_id as topic_id, b.id, b.title, b.author_label
    FROM links l JOIN books b ON b.id = l.from_id
    WHERE l.from_type='book' AND l.to_type='topic'
  `).all();
  const collByTopic = {}; for (const r of collRows) (collByTopic[r.topic_id] = collByTopic[r.topic_id] || []).push({ id: r.id, kind: r.kind, title: r.title });
  const bookByTopic = {}; for (const r of bookRows) (bookByTopic[r.topic_id] = bookByTopic[r.topic_id] || []).push({ id: r.id, title: r.title, author_label: r.author_label });

  // For topics with zero direct link rows, fall back to a LIKE match on items/summary.
  // Keep the fallback per-topic (rare path) — this only runs for topics never linked.
  const fallbackTopics = rows.filter(e => !(pagesByTopic[e.id] && pagesByTopic[e.id].length));
  const fallbackStmt = db.prepare(`
    SELECT DISTINCT p.id, p.volume, p.page_number, p.scan_path, p.summary, p.captured_at,
      NULL as role_summary,
      (SELECT d.date FROM links ld JOIN daily_logs d ON d.id=ld.to_id
        WHERE ld.from_type='page' AND ld.from_id=p.id AND ld.to_type='daily_log' LIMIT 1) as daily_log_date
    FROM pages p
    JOIN items i ON i.page_id = p.id
    WHERE i.text LIKE ? OR p.summary LIKE ?
    ORDER BY p.captured_at DESC
    LIMIT 50
  `);
  for (const e of fallbackTopics) {
    const like = `%${e.label}%`;
    pagesByTopic[e.id] = fallbackStmt.all(like, like);
  }

  const parentIds = new Set(rows.filter(r => r.parent_id).map(r => r.parent_id));
  return rows.map(e => {
    const enriched = pagesByTopic[e.id] || [];
    return {
      ...e,
      mention_count: enriched.length,
      pages: enriched,
      recent_page: enriched[0] ?? null,
      collections: collByTopic[e.id] || [],
      books: bookByTopic[e.id] || [],
    };
  }).filter(e =>
    e.mention_count > 0 || e.collections.length > 0 || e.books.length > 0 || parentIds.has(e.id)
  );
}


// --- Governing values (versioned append-only) ---

function currentValues() {
  return db.prepare(`
    SELECT v.*
    FROM values_versions v
    JOIN (SELECT slug, MAX(version) as mv FROM values_versions GROUP BY slug) latest
      ON latest.slug = v.slug AND latest.mv = v.version
    ORDER BY
      CASE v.category
        WHEN 'Character' THEN 1
        WHEN 'Household' THEN 2
        WHEN 'Vocation'  THEN 3
        ELSE 9
      END,
      COALESCE(v.position, 999),
      v.title COLLATE NOCASE
  `).all();
}

function getValueHistory(slug) {
  return db.prepare(`SELECT * FROM values_versions WHERE slug = ? ORDER BY version DESC`).all(slug);
}

function createValue({ id, slug, title, body, category, position }) {
  db.prepare(`
    INSERT INTO values_versions (id, slug, title, body, version, category, position, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, datetime('now'))
  `).run(id, slug, title, body, category ?? null, position ?? null);
  return db.prepare('SELECT * FROM values_versions WHERE id = ?').get(id);
}

function appendValueVersion({ id, slug, title, body, category, position }) {
  const prev = db.prepare(`SELECT * FROM values_versions WHERE slug=? ORDER BY version DESC LIMIT 1`).get(slug);
  const next = (prev?.version ?? 0) + 1;
  db.prepare(`
    INSERT INTO values_versions (id, slug, title, body, version, category, position, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, slug, title, body, next, category ?? prev?.category ?? null, position ?? prev?.position ?? null);
  return db.prepare('SELECT * FROM values_versions WHERE id = ?').get(id);
}

// --- Commitments ---

function listCommitments() {
  return db.prepare(`SELECT * FROM commitments ORDER BY
    CASE status WHEN 'active' THEN 0 ELSE 1 END,
    CASE WHEN target_date IS NULL THEN 1 ELSE 0 END,
    target_date ASC,
    created_at DESC`).all();
}

function createCommitment({ id, text, value_slug, start_date, target_date, due_date, parent_id, collection_id }) {
  db.prepare(`
    INSERT INTO commitments (id, text, value_slug, start_date, target_date, due_date, parent_id, collection_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
  `).run(id, text, value_slug ?? null, start_date ?? null, target_date ?? null, due_date ?? null, parent_id ?? null, collection_id ?? null);
  return db.prepare('SELECT * FROM commitments WHERE id = ?').get(id);
}

function deleteCommitment(id) {
  db.prepare('UPDATE commitments SET parent_id = NULL WHERE parent_id = ?').run(id);
  db.prepare("DELETE FROM links WHERE (from_type = 'commitment' AND from_id = ?) OR (to_type = 'commitment' AND to_id = ?)").run(id, id);
  return db.prepare('DELETE FROM commitments WHERE id = ?').run(id);
}

function updateCommitment(id, { text, value_slug, status, start_date, target_date, due_date, parent_id, collection_id }) {
  // parent_id and collection_id use the sentinel '__NULL__' so callers can explicitly detach.
  const parentClause = parent_id === '__NULL__' ? null
    : parent_id === undefined ? undefined : parent_id;
  const collClause = collection_id === '__NULL__' ? null
    : collection_id === undefined ? undefined : collection_id;
  return db.prepare(`
    UPDATE commitments SET
      text = COALESCE(?, text),
      value_slug = COALESCE(?, value_slug),
      status = COALESCE(?, status),
      start_date = COALESCE(?, start_date),
      target_date = COALESCE(?, target_date),
      due_date = COALESCE(?, due_date),
      parent_id = CASE WHEN ? = 1 THEN ? ELSE parent_id END,
      collection_id = CASE WHEN ? = 1 THEN ? ELSE collection_id END
    WHERE id = ?
  `).run(
    text ?? null, value_slug ?? null, status ?? null,
    start_date ?? null, target_date ?? null, due_date ?? null,
    parentClause === undefined ? 0 : 1, parentClause ?? null,
    collClause === undefined ? 0 : 1, collClause ?? null,
    id
  );
}

// Unified list: projects + commitments, merged by start_date/target_date.
// Each row: { kind, id, title, status, start_date, target_date, due_date,
//             description, value_slug, parent_id, created_at }
function listCommitmentsTimeline() {
  const projects = db.prepare(`
    SELECT 'project' as kind, id, title, status, start_date, target_date, due_date,
           description, NULL as value_slug, NULL as parent_id, created_at
    FROM projects
  `).all();
  const commits = db.prepare(`
    SELECT 'commitment' as kind, id, text as title, status, start_date, target_date, due_date,
           NULL as description, value_slug, parent_id, created_at
    FROM commitments
  `).all();
  const statusOrder = (s) => s === 'active' ? 0 : s === 'someday' ? 1 : 2;
  return [...projects, ...commits].sort((a, b) => {
    const so = statusOrder(a.status) - statusOrder(b.status);
    if (so) return so;
    const at = a.target_date || '9999-12-31';
    const bt = b.target_date || '9999-12-31';
    if (at !== bt) return at < bt ? -1 : 1;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}

// --- Artifacts ---

function listArtifacts() {
  const artifacts = db.prepare(`SELECT * FROM artifacts ORDER BY
    COALESCE(drawer,''), COALESCE(hanging_folder,''), COALESCE(manila_folder,''),
    created_at DESC`).all();
  return artifacts.map(a => ({
    ...a,
    versions: db.prepare(`SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC`).all(a.id),
    linked_collections: listLinkedCollections('artifact', a.id),
    linked_indexes: listLinkedUserIndexes('artifact', a.id),
  }));
}

function listLinkedCollections(fromType, fromId) {
  return db.prepare(`
    SELECT c.id, c.kind, c.title, l.id as link_id
    FROM links l JOIN collections c ON c.id = l.to_id
    WHERE l.from_type = ? AND l.from_id = ? AND l.to_type = 'collection'
    ORDER BY c.title COLLATE NOCASE
  `).all(fromType, fromId);
}
function listLinkedUserIndexes(fromType, fromId) {
  return db.prepare(`
    SELECT u.id, u.title, l.id as link_id
    FROM links l JOIN user_indexes u ON u.id = l.to_id
    WHERE l.from_type = ? AND l.from_id = ? AND l.to_type = 'user_index'
    ORDER BY u.title COLLATE NOCASE
  `).all(fromType, fromId);
}

function linkBetween({ from_type, from_id, to_type, to_id, role_summary }) {
  const existing = db.prepare(`
    SELECT id FROM links WHERE from_type=? AND from_id=? AND to_type=? AND to_id=?
  `).get(from_type, from_id, to_type, to_id);
  if (existing) {
    if (role_summary) {
      db.prepare(`UPDATE links SET role_summary = ? WHERE id = ?`).run(role_summary, existing.id);
    }
    return existing.id;
  }
  const id = require('crypto').randomUUID();
  db.prepare(`
    INSERT INTO links (id, from_type, from_id, to_type, to_id, created_by, confidence, role_summary)
    VALUES (?, ?, ?, ?, ?, 'user', 1.0, ?)
  `).run(id, from_type, from_id, to_type, to_id, role_summary ?? null);
  return id;
}

function deleteLinkById(linkId) {
  return db.prepare(`DELETE FROM links WHERE id=?`).run(linkId);
}

// Remove every (page→toType) link for a page. Used by refile "set-daily-log" and friends
// to clear a category before re-linking.
function removePageLinksByType(pageId, toType) {
  return db.prepare(`DELETE FROM links WHERE from_type='page' AND from_id=? AND to_type=?`).run(pageId, toType);
}

// Remove a single (page→toType:toId) link. Idempotent.
function removePageLinkToTarget(pageId, toType, toId) {
  return db.prepare(`DELETE FROM links WHERE from_type='page' AND from_id=? AND to_type=? AND to_id=?`).run(pageId, toType, toId);
}

// Remove a (page→user_index) link in either direction (classifier writes one, UI may write the reverse).
function removePageUserIndexLink(pageId, userIndexId) {
  return db.prepare(`
    DELETE FROM links
    WHERE (from_type='page' AND from_id=? AND to_type='user_index' AND to_id=?)
       OR (from_type='user_index' AND from_id=? AND to_type='page' AND to_id=?)
  `).run(pageId, userIndexId, userIndexId, pageId);
}

function createArtifact({ id, title, drawer, hanging_folder, manila_folder, status, external_url, notes }) {
  db.prepare(`
    INSERT INTO artifacts (id, title, drawer, hanging_folder, manila_folder, status, external_url, notes, created_at)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, 'in_progress'), ?, ?, datetime('now'))
  `).run(id, title, drawer ?? null, hanging_folder ?? null, manila_folder ?? null, status ?? null, external_url ?? null, notes ?? null);
  return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
}

function updateArtifact(id, { title, drawer, hanging_folder, manila_folder, status, external_url, notes }) {
  return db.prepare(`
    UPDATE artifacts SET
      title = COALESCE(?, title),
      drawer = COALESCE(?, drawer),
      hanging_folder = COALESCE(?, hanging_folder),
      manila_folder = COALESCE(?, manila_folder),
      status = COALESCE(?, status),
      external_url = COALESCE(?, external_url),
      notes = COALESCE(?, notes)
    WHERE id = ?
  `).run(title ?? null, drawer ?? null, hanging_folder ?? null, manila_folder ?? null,
         status ?? null, external_url ?? null, notes ?? null, id);
}

function addArtifactVersion({ id, artifact_id, file_path, note }) {
  const row = db.prepare(`SELECT MAX(version) as mv FROM artifact_versions WHERE artifact_id = ?`).get(artifact_id);
  const next = (row?.mv ?? 0) + 1;
  db.prepare(`
    INSERT INTO artifact_versions (id, artifact_id, version, file_path, note, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(id, artifact_id, next, file_path ?? null, note ?? null);
  return db.prepare('SELECT * FROM artifact_versions WHERE id = ?').get(id);
}

// --- References ---

function listReferences() {
  const rows = db.prepare(`SELECT * FROM reference_materials ORDER BY created_at DESC`).all();
  return rows.map(r => ({
    ...r,
    linked_collections: listLinkedCollections('reference', r.id),
    linked_indexes: listLinkedUserIndexes('reference', r.id),
  }));
}

function createReference({ id, title, source, file_path, external_url, note, row_type }) {
  db.prepare(`
    INSERT INTO reference_materials (id, title, source, file_path, external_url, note, row_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 'link'), datetime('now'))
  `).run(id, title, source ?? null, file_path ?? null, external_url ?? null, note ?? null, row_type ?? null);
  return db.prepare('SELECT * FROM reference_materials WHERE id = ?').get(id);
}

function setReferenceRowType(id, row_type) {
  db.prepare(`UPDATE reference_materials SET row_type = ? WHERE id = ?`).run(row_type, id);
  return db.prepare('SELECT * FROM reference_materials WHERE id = ?').get(id);
}

function deleteReference(id) {
  return db.prepare(`DELETE FROM reference_materials WHERE id = ?`).run(id);
}

function updateReferenceContent(id, { fetched_content, fetched_at, fetched_error }) {
  db.prepare(`
    UPDATE reference_materials
    SET fetched_content = ?, fetched_at = ?, fetched_error = ?
    WHERE id = ?
  `).run(fetched_content ?? null, fetched_at ?? null, fetched_error ?? null, id);
  return db.prepare('SELECT * FROM reference_materials WHERE id = ?').get(id);
}

function updateArtifactContent(id, { fetched_content, fetched_at, fetched_error }) {
  db.prepare(`
    UPDATE artifacts
    SET fetched_content = ?, fetched_at = ?, fetched_error = ?
    WHERE id = ?
  `).run(fetched_content ?? null, fetched_at ?? null, fetched_error ?? null, id);
  return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
}

function updateArtifactUrl(id, external_url) {
  db.prepare(`UPDATE artifacts SET external_url = ? WHERE id = ?`).run(external_url ?? null, id);
  return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
}

function updateReferenceUrl(id, external_url) {
  db.prepare(`UPDATE reference_materials SET external_url = ? WHERE id = ?`).run(external_url ?? null, id);
  return db.prepare('SELECT * FROM reference_materials WHERE id = ?').get(id);
}

function setArtifactArchived(id, archived) {
  db.prepare(`UPDATE artifacts SET archived_at = ? WHERE id = ?`)
    .run(archived ? new Date().toISOString() : null, id);
}

function deleteArtifact(id) {
  // Cascade: versions, links pointing at the artifact, then the artifact itself.
  db.prepare(`DELETE FROM artifact_versions WHERE artifact_id = ?`).run(id);
  db.prepare(`DELETE FROM links WHERE (to_type='artifact' AND to_id = ?) OR (from_type='artifact' AND from_id = ?)`).run(id, id);
  db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
  return { id };
}

// Move every link touching `sourceId` (page→artifact and artifact→collection/index)
// to `targetId`, move versions onto the target, then delete the source artifact.
function mergeArtifactInto(sourceId, targetId) {
  if (sourceId === targetId) throw new Error('source and target must differ');
  const source = db.prepare('SELECT id FROM artifacts WHERE id = ?').get(sourceId);
  const target = db.prepare('SELECT id FROM artifacts WHERE id = ?').get(targetId);
  if (!source || !target) throw new Error('artifact not found');
  const tx = db.transaction(() => {
    // Incoming links (page→artifact): dedupe against existing target links.
    const inLinks = db.prepare(
      `SELECT id, from_type, from_id FROM links WHERE to_type='artifact' AND to_id = ?`
    ).all(sourceId);
    const hasIncoming = db.prepare(
      `SELECT 1 FROM links WHERE to_type='artifact' AND to_id = ? AND from_type=? AND from_id=?`
    );
    // Outgoing links (artifact→collection/index): dedupe against existing target outgoing.
    const outLinks = db.prepare(
      `SELECT id, to_type, to_id FROM links WHERE from_type='artifact' AND from_id = ?`
    ).all(sourceId);
    const hasOutgoing = db.prepare(
      `SELECT 1 FROM links WHERE from_type='artifact' AND from_id = ? AND to_type=? AND to_id=?`
    );
    const relinkTo = db.prepare(`UPDATE links SET to_id = ? WHERE id = ?`);
    const relinkFrom = db.prepare(`UPDATE links SET from_id = ? WHERE id = ?`);
    const drop = db.prepare(`DELETE FROM links WHERE id = ?`);
    let moved = 0;
    for (const l of inLinks) {
      if (hasIncoming.get(targetId, l.from_type, l.from_id)) drop.run(l.id);
      else { relinkTo.run(targetId, l.id); moved++; }
    }
    for (const l of outLinks) {
      if (hasOutgoing.get(targetId, l.to_type, l.to_id)) drop.run(l.id);
      else { relinkFrom.run(targetId, l.id); moved++; }
    }
    // Move versions onto the target artifact.
    db.prepare(`UPDATE artifact_versions SET artifact_id = ? WHERE artifact_id = ?`)
      .run(targetId, sourceId);
    db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(sourceId);
    return moved;
  });
  const moved = tx();
  return { ok: true, links_moved: moved, target_id: targetId };
}
function setReferenceArchived(id, archived) {
  db.prepare(`UPDATE reference_materials SET archived_at = ? WHERE id = ?`)
    .run(archived ? new Date().toISOString() : null, id);
}

// --- Google OAuth tokens ---
function saveGoogleTokens({ access_token, refresh_token, expires_at, scope }) {
  db.prepare(`
    INSERT INTO google_tokens (id, access_token, refresh_token, expires_at, scope, updated_at)
    VALUES (1, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, google_tokens.refresh_token),
      expires_at = excluded.expires_at,
      scope = excluded.scope,
      updated_at = datetime('now')
  `).run(access_token ?? null, refresh_token, expires_at ?? null, scope ?? null);
  return getGoogleTokens();
}

function getGoogleTokens() {
  return db.prepare(`SELECT * FROM google_tokens WHERE id = 1`).get();
}

function clearGoogleTokens() {
  db.prepare(`DELETE FROM google_tokens WHERE id = 1`).run();
}

// --- Google Drive auto-capture ---

function getGoogleDriveConfig(key) {
  const row = db.prepare(`SELECT value FROM google_drive_config WHERE key = ?`).get(key);
  return row ? row.value : null;
}

function setGoogleDriveConfig(key, value) {
  if (value == null) {
    db.prepare(`DELETE FROM google_drive_config WHERE key = ?`).run(key);
  } else {
    db.prepare(`INSERT INTO google_drive_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }
}

function getDrivePageToken() {
  return getGoogleDriveConfig('drive_page_token');
}

function saveDrivePageToken(token) {
  setGoogleDriveConfig('drive_page_token', token);
}

function upsertGoogleCapture({ id, drive_file_id, title, mime_type, file_url, discovered_at }) {
  db.prepare(`
    INSERT INTO google_captures (id, drive_file_id, title, mime_type, file_url, discovered_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(drive_file_id) DO UPDATE SET title = excluded.title
  `).run(id, drive_file_id, title, mime_type, file_url, discovered_at);
  return db.prepare(`SELECT * FROM google_captures WHERE drive_file_id = ?`).get(drive_file_id);
}

function listPendingGoogleCaptures() {
  return db.prepare(`
    SELECT * FROM google_captures
    WHERE dismissed_at IS NULL AND accepted_kind IS NULL
    ORDER BY discovered_at DESC
  `).all();
}

function getGoogleCapture(id) {
  return db.prepare(`SELECT * FROM google_captures WHERE id = ?`).get(id);
}

function dismissGoogleCapture(id) {
  db.prepare(`UPDATE google_captures SET dismissed_at = datetime('now') WHERE id = ?`).run(id);
}

function acceptGoogleCapture(id, { accepted_kind, accepted_id }) {
  db.prepare(`UPDATE google_captures SET accepted_kind = ?, accepted_id = ? WHERE id = ?`)
    .run(accepted_kind, accepted_id, id);
}

// --- Collections browser ---

function listCollectionsGrouped({ includeArchived = false } = {}) {
  // Daily logs are NOT collections — they live in their own table and have their own
  // surface. Exclude any stragglers with kind='daily_log' that slipped past migration.
  const archivedClause = includeArchived
    ? "WHERE c.kind != 'daily_log'"
    : "WHERE c.kind != 'daily_log' AND c.archived_at IS NULL";
  const rows = db.prepare(`
    SELECT c.id, c.kind, c.title, c.description, c.target_date, c.status,
      c.created_at, c.archived_at, c.parent_id,
      pc.title as parent_title,
      COUNT(l.id) as page_count,
      (SELECT COUNT(*) FROM collections cc WHERE cc.parent_id = c.id AND cc.archived_at IS NULL) as child_count,
      MAX(p.captured_at) as recent_captured_at,
      (SELECT p2.scan_path FROM links l2
         JOIN pages p2 ON p2.id = l2.from_id
         WHERE l2.to_type='collection' AND l2.to_id=c.id AND l2.from_type='page'
         ORDER BY p2.captured_at DESC LIMIT 1) as thumbnail_scan
    FROM collections c
    LEFT JOIN collections pc ON pc.id = c.parent_id
    LEFT JOIN links l ON l.to_type='collection' AND l.to_id=c.id AND l.from_type='page'
    LEFT JOIN pages p ON p.id = l.from_id
    ${archivedClause}
    GROUP BY c.id
    ORDER BY c.kind, recent_captured_at DESC, c.title COLLATE NOCASE
  `).all();
  for (const r of rows) {
    r.linked_roles = listCollectionEntities(r.id, 'role');
    r.linked_areas = listCollectionEntities(r.id, 'area');
  }
  const grouped = {};
  for (const r of rows) {
    (grouped[r.kind] = grouped[r.kind] || []).push(r);
  }
  return Object.entries(grouped).map(([kind, collections]) => ({ kind, collections }));
}

function getCollectionDetail(id) {
  const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  if (!collection) return null;
  const pages = db.prepare(`
    SELECT p.id, p.volume, p.page_number, p.scan_path, p.summary, p.captured_at
    FROM links l JOIN pages p ON p.id = l.from_id
    WHERE l.to_type='collection' AND l.to_id=? AND l.from_type='page'
    ORDER BY p.captured_at ASC
  `).all(id);

  // Aggregate entities across these pages (scripture + people + topics via items LIKE)
  const pageIds = pages.map(p => p.id);
  if (pageIds.length === 0) return { collection, pages: [], entities: [] };
  const placeholders = pageIds.map(() => '?').join(',');

  const scripture = db.prepare(`
    SELECT s.canonical as label, 'scripture' as kind, COUNT(*) as count,
      GROUP_CONCAT(l.from_id) as page_ids
    FROM links l JOIN scripture_refs s ON s.id = l.to_id
    WHERE l.to_type='scripture' AND l.from_type='page' AND l.from_id IN (${placeholders})
    GROUP BY s.id
    ORDER BY count DESC, s.canonical
  `).all(...pageIds);

  const people = db.prepare(`
    SELECT pe.label, 'person' as kind, COUNT(*) as count,
      GROUP_CONCAT(l.from_id) as page_ids
    FROM links l JOIN people pe ON pe.id = l.to_id
    WHERE l.to_type='person' AND l.from_type='page' AND l.from_id IN (${placeholders})
    GROUP BY pe.id
    ORDER BY count DESC, pe.label
  `).all(...pageIds);

  const enrich = (rows) => rows.map(r => ({
    ...r,
    pages: (r.page_ids || '').split(',').filter(Boolean).map(pid => pages.find(p => p.id === pid)).filter(Boolean)
  }));

  const questions = getPendingBacklogForCollection(id);

  const parent = collection.parent_id
    ? db.prepare('SELECT id, title FROM collections WHERE id = ?').get(collection.parent_id) || null
    : null;
  const children = db.prepare(`
    SELECT c.id, c.title,
      (SELECT COUNT(*) FROM links l WHERE l.to_type='collection' AND l.to_id=c.id AND l.from_type='page') as page_count
    FROM collections c
    WHERE c.parent_id = ? AND c.archived_at IS NULL
    ORDER BY c.title COLLATE NOCASE
  `).all(id);

  // Phase 6: References (sources — inputs) and Artifacts (outputs) that connect to this collection.
  // References typically link reference→collection. Artifacts can link either direction; union both.
  const references_in = db.prepare(`
    SELECT r.id, r.title, r.source, r.file_path, r.external_url, r.note, r.archived_at
    FROM links l JOIN reference_materials r ON r.id = l.from_id
    WHERE l.from_type='reference' AND l.to_type='collection' AND l.to_id = ? AND r.archived_at IS NULL
    ORDER BY r.created_at DESC
  `).all(id);

  const artifacts_out = db.prepare(`
    SELECT DISTINCT a.id, a.title, a.drawer, a.hanging_folder, a.manila_folder, a.external_url, a.status, a.archived_at
    FROM artifacts a
    WHERE a.archived_at IS NULL AND a.id IN (
      SELECT from_id FROM links WHERE from_type='artifact' AND to_type='collection' AND to_id = ?
      UNION
      SELECT to_id   FROM links WHERE to_type='artifact'   AND from_type='collection' AND from_id = ?
    )
    ORDER BY a.created_at DESC
  `).all(id, id);

  return { collection, parent, children, pages, references: references_in, artifacts: artifacts_out, entities: [...enrich(scripture), ...enrich(people)], questions };
}

function setCollectionParent(id, parentId) {
  if (parentId === id) throw new Error('collection cannot be its own parent');
  if (parentId) {
    // Walk up the parent chain to make sure we're not creating a cycle.
    let cursor = parentId;
    const seen = new Set();
    while (cursor) {
      if (cursor === id) throw new Error('cycle: target is already a descendant');
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const row = db.prepare('SELECT parent_id FROM collections WHERE id = ?').get(cursor);
      cursor = row ? row.parent_id : null;
    }
    const exists = db.prepare('SELECT id FROM collections WHERE id = ?').get(parentId);
    if (!exists) throw new Error('parent not found');
  }
  db.prepare('UPDATE collections SET parent_id = ? WHERE id = ?').run(parentId || null, id);
  return { id, parent_id: parentId || null };
}

function listDailyLogs() {
  // Full-calendar view: for every month that has *any* daily_log or *any* non-daily-log
  // collection activity, emit every day 1..N with its daily_log (if any) and any
  // collections whose pages were captured on that date.

  const dailyLogs = db.prepare(`
    SELECT id, date FROM daily_logs WHERE archived_at IS NULL
  `).all();
  const dlByDate = Object.fromEntries(dailyLogs.map(d => [d.date, d.id]));

  const collectionDays = db.prepare(`
    SELECT DISTINCT substr(p.captured_at, 1, 10) as date, c.id, c.kind, c.title
    FROM collections c
    JOIN links l ON l.to_type='collection' AND l.to_id=c.id AND l.from_type='page'
    JOIN pages p ON p.id = l.from_id
    WHERE c.archived_at IS NULL
  `).all();
  const collByDate = {};
  for (const row of collectionDays) {
    (collByDate[row.date] = collByDate[row.date] || []).push({ id: row.id, kind: row.kind, title: row.title });
  }

  const activeMonths = new Set();
  for (const d of dailyLogs) if (d.date) activeMonths.add(d.date.slice(0, 7));
  for (const row of collectionDays) if (row.date) activeMonths.add(row.date.slice(0, 7));
  if (activeMonths.size === 0) return [];

  const pageStmt = db.prepare(`
    SELECT p.id, p.volume, p.page_number, p.scan_path, p.summary, p.captured_at
    FROM links l JOIN pages p ON p.id = l.from_id
    WHERE l.to_type='daily_log' AND l.to_id=? AND l.from_type='page'
      AND p.deleted_at IS NULL
    ORDER BY p.captured_at ASC
  `);

  const months = [...activeMonths].sort().reverse();
  return months.map(month => {
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const days = [];
    for (let dom = 1; dom <= daysInMonth; dom++) {
      const date = `${month}-${String(dom).padStart(2, '0')}`;
      const dt = new Date(`${date}T00:00:00`);
      const dow = isNaN(dt) ? '' : ['sun','mon','tue','wed','thu','fri','sat'][dt.getDay()];

      const dlId = dlByDate[date];
      let pages = [], entities = null, summary = null;
      if (dlId) {
        pages = pageStmt.all(dlId);
        const pageIds = pages.map(p => p.id);
        entities = collectEntitiesForPages(pageIds);
        const override = db.prepare(`SELECT summary FROM daily_logs WHERE id = ?`).get(dlId);
        summary = (override && override.summary && override.summary.trim())
          || pages.map(p => (p.summary || '').trim()).filter(Boolean).join(' · ')
          || null;
      }
      const collections = collByDate[date] || [];

      days.push({
        date, dom, dow,
        daily_log_id: dlId || null,
        collection_id: dlId || null,  // legacy alias — callers still use this name
        has_log: !!dlId,
        summary,
        pages,
        entities,
        collections,
      });
    }
    return { month, days };
  });
}

function listMonthSpine(ym) {
  // Bullet-journal monthly-log spine: one row per date in the month, empty days included.
  // Drops the nested pages/entities payload that listDailyLogs carries — callers fetch
  // per-day detail lazily via getDailyLogDetail.
  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();

  const dlRows = db.prepare(`
    SELECT id, date, summary FROM daily_logs
    WHERE archived_at IS NULL AND substr(date, 1, 7) = ?
  `).all(ym);
  const dlByDate = Object.fromEntries(dlRows.map(r => [r.date, r]));

  const pageCounts = db.prepare(`
    SELECT l.to_id AS dl_id, COUNT(DISTINCT l.from_id) AS n
    FROM links l JOIN pages p ON p.id = l.from_id
    WHERE l.to_type='daily_log' AND l.from_type='page'
      AND l.to_id IN (SELECT id FROM daily_logs WHERE substr(date, 1, 7) = ?)
      AND p.deleted_at IS NULL
    GROUP BY l.to_id
  `).all(ym);
  const countsByDlId = Object.fromEntries(pageCounts.map(r => [r.dl_id, r.n]));

  const pageSummaries = db.prepare(`
    SELECT l.to_id AS dl_id, p.summary
    FROM links l JOIN pages p ON p.id = l.from_id
    WHERE l.to_type='daily_log' AND l.from_type='page'
      AND l.to_id IN (SELECT id FROM daily_logs WHERE substr(date, 1, 7) = ?)
      AND p.deleted_at IS NULL
      AND p.summary IS NOT NULL AND p.summary != ''
    ORDER BY p.volume, p.page_number, p.captured_at
  `).all(ym);
  const previewByDlId = {};
  for (const row of pageSummaries) {
    if (!previewByDlId[row.dl_id]) previewByDlId[row.dl_id] = [];
    if (previewByDlId[row.dl_id].length < 3) previewByDlId[row.dl_id].push(row.summary);
  }

  const days = [];
  const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for (let dom = 1; dom <= daysInMonth; dom++) {
    const date = `${ym}-${String(dom).padStart(2, '0')}`;
    const dt = new Date(`${date}T00:00:00`);
    const weekday = isNaN(dt) ? '' : weekdays[dt.getDay()];
    const dl = dlByDate[date];
    const explicit = dl ? (dl.summary || null) : null;
    const previewList = dl ? (previewByDlId[dl.id] || []) : [];
    const preview = explicit || (previewList.length ? previewList.join(' · ') : null);
    days.push({
      date,
      dom,
      weekday,
      daily_log_id: dl ? dl.id : null,
      summary: explicit,
      preview,
      preview_is_synthesized: !explicit && !!preview,
      page_count: dl ? (countsByDlId[dl.id] || 0) : 0,
    });
  }
  return { month: ym, days };
}

// --- Daily log direct helpers ---

function findDailyLogByDate(date) {
  return db.prepare(`SELECT * FROM daily_logs WHERE date = ?`).get(date);
}

function createDailyLog({ id, date, summary }) {
  db.prepare(`
    INSERT INTO daily_logs (id, date, summary, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(date) DO NOTHING
  `).run(id, date, summary ?? null);
  return findDailyLogByDate(date);
}

function getDailyLog(id) {
  return db.prepare(`SELECT * FROM daily_logs WHERE id = ?`).get(id);
}

function getDailyLogDetail(id) {
  const dl = db.prepare(`SELECT * FROM daily_logs WHERE id = ?`).get(id);
  if (!dl) return null;
  const pages = db.prepare(`
    SELECT p.id, p.volume, p.page_number, p.scan_path, p.summary, p.captured_at, p.source_kind
    FROM links l JOIN pages p ON p.id = l.from_id
    WHERE l.to_type='daily_log' AND l.to_id=? AND l.from_type='page'
      AND p.deleted_at IS NULL
    ORDER BY p.captured_at ASC
  `).all(id);
  const pageIds = pages.map(p => p.id);
  const entities = collectEntitiesForPages(pageIds);
  // Flatten entities into the aggregate shape collection-detail uses, so the UI can reuse the footnote rail.
  const mkAgg = (rows, kind) => rows.map(r => ({
    ...r, kind,
    pages: pages.filter(p => db.prepare(`SELECT 1 FROM links WHERE from_type='page' AND from_id=? AND to_type=? AND to_id=?`).get(p.id, kind, r.id)),
  }));
  const aggEntities = [...mkAgg(entities.scripture, 'scripture'), ...mkAgg(entities.people, 'person'), ...mkAgg(entities.topics, 'topic')];
  const collectionRows = db.prepare(`
    SELECT c.id, c.kind, c.title
    FROM links l JOIN collections c ON c.id = l.to_id
    WHERE l.from_type='daily_log' AND l.from_id=? AND l.to_type='collection'
  `).all(id);
  return { daily_log: dl, pages, entities: aggEntities, collections: collectionRows };
}

function updateDailyLog(id, { summary, archived_at, date }) {
  const row = db.prepare(`SELECT id, date FROM daily_logs WHERE id = ?`).get(id);
  if (!row) return null;
  if (summary !== undefined) {
    db.prepare(`UPDATE daily_logs SET summary = ? WHERE id = ?`).run(summary, id);
  }
  if (archived_at !== undefined) {
    db.prepare(`UPDATE daily_logs SET archived_at = ? WHERE id = ?`).run(archived_at, id);
  }
  if (date !== undefined && date !== null && date !== '') {
    const d = String(date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('date must be YYYY-MM-DD');
    if (d !== row.date) {
      // If the target date already exists as another daily_log, merge: re-point
      // every link, copy summary if empty, then delete the source.
      const target = db.prepare(`SELECT id, summary FROM daily_logs WHERE date = ?`).get(d);
      if (target && target.id !== id) {
        db.prepare(`UPDATE links SET to_id = ? WHERE to_type='daily_log' AND to_id = ?`).run(target.id, id);
        db.prepare(`UPDATE links SET from_id = ? WHERE from_type='daily_log' AND from_id = ?`).run(target.id, id);
        if (!target.summary) {
          const src = db.prepare(`SELECT summary FROM daily_logs WHERE id = ?`).get(id);
          if (src && src.summary) {
            db.prepare(`UPDATE daily_logs SET summary = ? WHERE id = ?`).run(src.summary, target.id);
          }
        }
        db.prepare(`DELETE FROM daily_logs WHERE id = ?`).run(id);
        return db.prepare(`SELECT * FROM daily_logs WHERE id = ?`).get(target.id);
      }
      db.prepare(`UPDATE daily_logs SET date = ? WHERE id = ?`).run(d, id);
    }
  }
  return db.prepare(`SELECT * FROM daily_logs WHERE id = ?`).get(id);
}

function linkPageToDailyLog(pageId, dailyLogId, confidence = 1.0) {
  const existing = db.prepare(
    `SELECT id FROM links WHERE from_type='page' AND from_id=? AND to_type='daily_log' AND to_id=?`
  ).get(pageId, dailyLogId);
  if (existing) return existing.id;
  const id = require('crypto').randomUUID();
  db.prepare(
    `INSERT INTO links (id, from_type, from_id, to_type, to_id, created_by, confidence)
     VALUES (?, 'page', ?, 'daily_log', ?, 'foxed', ?)`
  ).run(id, pageId, dailyLogId, confidence);
  return id;
}

function listDailyLogsFlat({ includeArchived = false } = {}) {
  const where = includeArchived ? '' : 'WHERE archived_at IS NULL';
  return db.prepare(`SELECT * FROM daily_logs ${where} ORDER BY date DESC`).all();
}

function collectEntitiesForPages(pageIds) {
  if (!pageIds || pageIds.length === 0) return { scripture: [], people: [], topics: [] };
  const placeholders = pageIds.map(() => '?').join(',');
  const scripture = db.prepare(`
    SELECT s.id, s.canonical as label, COUNT(*) as count
    FROM links l JOIN scripture_refs s ON s.id = l.to_id
    WHERE l.to_type='scripture' AND l.from_type='page' AND l.from_id IN (${placeholders})
    GROUP BY s.id ORDER BY count DESC, s.canonical
  `).all(...pageIds);
  const people = db.prepare(`
    SELECT pe.id, pe.label, COUNT(*) as count
    FROM links l JOIN people pe ON pe.id = l.to_id
    WHERE l.to_type='person' AND l.from_type='page' AND l.from_id IN (${placeholders})
    GROUP BY pe.id ORDER BY count DESC, pe.label
  `).all(...pageIds);
  const topics = db.prepare(`
    SELECT e.id, e.label, COUNT(*) as count
    FROM links l JOIN entities e ON e.id = l.to_id
    WHERE l.to_type='topic' AND l.from_type='page' AND l.from_id IN (${placeholders})
    GROUP BY e.id ORDER BY count DESC, e.label
  `).all(...pageIds);
  return { scripture, people, topics };
}

function augmentPage(pageId, { kind, label }) {
  if (kind === 'person') {
    const person = upsertPerson({ label });
    linkPageToPerson(pageId, person.id, 1.0);
    return { linked: 1, entity: { kind: 'person', id: person.id, label: person.label } };
  }
  if (kind === 'scripture') {
    const parsed = parseScriptureLabel(label);
    if (!parsed) throw new Error('Unrecognized scripture reference');
    const ref = upsertScriptureRef(parsed);
    linkPageToScripture(pageId, ref.id, 1.0);
    return { linked: 1, entity: { kind: 'scripture', id: ref.id, label: ref.canonical } };
  }
  if (kind === 'topic') {
    const normalized = String(label).trim().toLowerCase();
    const id = require('crypto').randomUUID();
    upsertEntity({ id, kind: 'topic', label: normalized });
    const ent = db.prepare(`SELECT id FROM entities WHERE kind='topic' AND label=? COLLATE NOCASE`).get(normalized);
    const existing = db.prepare(
      `SELECT id FROM links WHERE from_type='page' AND from_id=? AND to_type='topic' AND to_id=?`
    ).get(pageId, ent.id);
    if (!existing) {
      insertLink({
        id: require('crypto').randomUUID(),
        from_type: 'page', from_id: pageId,
        to_type: 'topic', to_id: ent.id,
        created_by: 'user', confidence: 1.0,
      });
    }
    return { linked: 1, entity: { kind: 'topic', id: ent.id, label: normalized } };
  }
  throw new Error(`Unsupported kind: ${kind}`);
}

function parseScriptureLabel(raw) {
  const s = String(raw).trim();
  const m = s.match(/^((?:\d\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d+)(?::(\d+)(?:-(\d+))?)?$/);
  if (!m) return null;
  const book = m[1].replace(/\s+/g, ' ').trim();
  const chapter = parseInt(m[2], 10);
  const vs = m[3] ? parseInt(m[3], 10) : null;
  const ve = m[4] ? parseInt(m[4], 10) : (vs || null);
  const canonical = vs
    ? (ve && ve !== vs ? `${book} ${chapter}:${vs}-${ve}` : `${book} ${chapter}:${vs}`)
    : `${book} ${chapter}`;
  return { canonical, book, chapter, verse_start: vs, verse_end: ve && ve !== vs ? ve : null };
}

// --- Page detail (used by the scan modal → full detail) ---

function getPageDetail(pageId) {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId);
  if (!page) return null;

  const scripture = db.prepare(`
    SELECT s.*, l.id as link_id FROM links l JOIN scripture_refs s ON s.id = l.to_id
    WHERE l.from_type='page' AND l.from_id=? AND l.to_type='scripture'
  `).all(pageId);

  const people = db.prepare(`
    SELECT pe.*, l.id as link_id FROM links l JOIN people pe ON pe.id = l.to_id
    WHERE l.from_type='page' AND l.from_id=? AND l.to_type='person'
  `).all(pageId);

  const topics = db.prepare(`
    SELECT e.*, l.id as link_id FROM links l JOIN entities e ON e.id = l.to_id
    WHERE l.from_type='page' AND l.from_id=? AND l.to_type='topic'
  `).all(pageId);

  const collections = db.prepare(`
    SELECT c.*, l.id as link_id FROM links l JOIN collections c ON c.id = l.to_id
    WHERE l.from_type='page' AND l.from_id=? AND l.to_type='collection'
  `).all(pageId);

  const daily_logs = db.prepare(`
    SELECT dl.id, dl.date FROM links l JOIN daily_logs dl ON dl.id = l.to_id
    WHERE l.from_type='page' AND l.from_id=? AND l.to_type='daily_log'
  `).all(pageId);

  const books = db.prepare(`
    SELECT b.id, b.title, b.author_label, l.id as link_id FROM links l JOIN books b ON b.id = l.to_id
    WHERE l.from_type='page' AND l.from_id=? AND l.to_type='book'
  `).all(pageId);

  const linked_user_indexes = db.prepare(`
    SELECT u.id, u.title, u.is_ai_generated FROM links l JOIN user_indexes u ON u.id = l.to_id
    WHERE ((l.from_type='page' AND l.from_id=? AND l.to_type='user_index')
        OR (l.from_type='user_index' AND l.to_type='page' AND l.to_id=? AND u.id = l.from_id))
  `).all(pageId, pageId);

  const artifacts = db.prepare(`
    SELECT a.id, a.title, a.drawer, a.hanging_folder, a.manila_folder, a.external_url, a.archived_at,
           l.id as link_id, l.role_summary
    FROM links l JOIN artifacts a ON a.id = l.to_id
    WHERE l.from_type='page' AND l.from_id=? AND l.to_type='artifact'
  `).all(pageId);

  const references = db.prepare(`
    SELECT r.id, r.title, r.source, r.file_path, r.external_url, r.archived_at,
           l.id as link_id, l.role_summary
    FROM links l JOIN reference_materials r ON r.id = l.to_id
    WHERE l.from_type='page' AND l.from_id=? AND l.to_type='reference'
  `).all(pageId);

  // Phase 7: cross-page links. "See also" = outbound references to other pages.
  // "Referenced by" = inbound links from other pages. Both fuel the page-detail rail.
  const see_also = db.prepare(`
    SELECT p.id, p.volume, p.page_number, p.scan_path, p.summary, p.captured_at, p.source_kind,
           l.id as link_id, l.role_summary
    FROM links l JOIN pages p ON p.id = l.to_id
    WHERE l.from_type='page' AND l.from_id=? AND l.to_type='page'
    ORDER BY p.captured_at ASC
  `).all(pageId);
  const referenced_by = db.prepare(`
    SELECT p.id, p.volume, p.page_number, p.scan_path, p.summary, p.captured_at, p.source_kind,
           l.id as link_id, l.role_summary
    FROM links l JOIN pages p ON p.id = l.from_id
    WHERE l.to_type='page' AND l.to_id=? AND l.from_type='page'
    ORDER BY p.captured_at ASC
  `).all(pageId);

  const items = db.prepare(`SELECT * FROM items WHERE page_id = ?`).all(pageId);
  const related_pages = getRelatedPages(pageId, 8);
  const questions = getPendingBacklogForPage(pageId);
  const siblings = getPageSiblings(pageId, collections);

  // Spread pages — all pages sharing this page's scan_path, ordered by page_number.
  // Voice memos and markdown notes use per-page sentinel scan_paths and are never
  // part of a spread, so skip the lookup for them.
  let spread_pages = [];
  if (page.scan_path && !page.scan_path.startsWith('voice:') && !page.scan_path.startsWith('markdown:')) {
    spread_pages = db.prepare(`
      SELECT id, volume, page_number, scan_path, summary, captured_at, source_kind, rotation
      FROM pages WHERE scan_path = ?
      ORDER BY COALESCE(page_number, 0) ASC, id ASC
    `).all(page.scan_path);
  }

  // Context strip — 2 chronological before + this + 2 after (sibling context)
  let context_strip = [];
  try {
    const around = db.prepare(`
      SELECT id, volume, page_number, scan_path, summary, captured_at, source_kind
      FROM pages
      WHERE captured_at IS NOT NULL
      ORDER BY captured_at ASC, COALESCE(page_number, 0) ASC
    `).all();
    const idx = around.findIndex(p => p.id === pageId);
    if (idx !== -1) {
      const start = Math.max(0, idx - 2);
      const end = Math.min(around.length, idx + 3);
      context_strip = around.slice(start, end);
    }
  } catch (_err) { context_strip = []; }

  return { page, scripture, people, topics, collections, daily_logs, books, linked_user_indexes, artifacts, references, see_also, referenced_by, items, related_pages, questions, siblings, spread_pages, context_strip };
}

// Find prev/next page relative to this one.
// Prefer ordering within the same collection (e.g. daily_log → chronological).
// Fall back to global captured_at order across all pages.
function getPageSiblings(pageId, pageCollections) {
  const primary = (pageCollections && pageCollections[0]) || null;
  if (primary) {
    const sameCollection = db.prepare(`
      SELECT p.id, p.volume, p.page_number, p.captured_at
      FROM links l JOIN pages p ON p.id = l.from_id
      WHERE l.to_type='collection' AND l.to_id=? AND l.from_type='page'
      ORDER BY p.captured_at ASC, p.page_number ASC
    `).all(primary.id);
    const idx = sameCollection.findIndex(p => p.id === pageId);
    if (idx !== -1) {
      return {
        prev: idx > 0 ? sameCollection[idx - 1] : null,
        next: idx < sameCollection.length - 1 ? sameCollection[idx + 1] : null,
        scope: primary.title || primary.kind || 'collection',
      };
    }
  }
  const all = db.prepare(`SELECT id, volume, page_number, captured_at FROM pages ORDER BY captured_at ASC, page_number ASC`).all();
  const idx = all.findIndex(p => p.id === pageId);
  return {
    prev: idx > 0 ? all[idx - 1] : null,
    next: idx !== -1 && idx < all.length - 1 ? all[idx + 1] : null,
    scope: 'all pages',
  };
}

function updatePageSummary(pageId, summary) {
  return db.prepare('UPDATE pages SET summary = ? WHERE id = ?').run(summary, pageId);
}

// Set the rotation on a page. Validates to one of {0, 90, 180, 270}.
// Returns the new rotation value or throws if invalid.
function setPageRotation(pageId, rotation) {
  const r = Number(rotation) | 0;
  const norm = ((r % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(norm)) {
    throw new Error(`rotation must be 0/90/180/270, got ${rotation}`);
  }
  db.prepare('UPDATE pages SET rotation = ? WHERE id = ?').run(norm, pageId);
  return norm;
}

// Increment the rotation by ±90 (clockwise = +90, counter-clockwise = -90).
// Returns the new rotation value, normalised to [0, 360).
function rotatePage(pageId, dir) {
  const row = db.prepare('SELECT rotation FROM pages WHERE id = ?').get(pageId);
  if (!row) throw new Error('page not found');
  const cur = Number(row.rotation) || 0;
  const delta = dir === 'ccw' ? -90 : 90;
  const next = ((cur + delta) % 360 + 360) % 360;
  db.prepare('UPDATE pages SET rotation = ? WHERE id = ?').run(next, pageId);
  return next;
}

// Replace a topic link on a specific page: unlink old topic (if linked), link new topic.
function replaceTopicOnPage(pageId, fromLabel, toLabel) {
  const fromTopic = getEntityByKindLabel('topic', fromLabel);
  if (fromTopic) {
    db.prepare(
      `DELETE FROM links WHERE from_type='page' AND from_id=? AND to_type='topic' AND to_id=?`
    ).run(pageId, fromTopic.id);
  }
  let toTopic = getEntityByKindLabel('topic', toLabel);
  if (!toTopic) {
    const id = require('crypto').randomUUID();
    upsertEntity({ id, kind: 'topic', label: toLabel });
    toTopic = getEntityByKindLabel('topic', toLabel);
  }
  if (toTopic) {
    const already = db.prepare(
      `SELECT id FROM links WHERE from_type='page' AND from_id=? AND to_type='topic' AND to_id=?`
    ).get(pageId, toTopic.id);
    if (!already) {
      db.prepare(
        `INSERT INTO links (id, from_type, from_id, to_type, to_id, created_by, confidence)
         VALUES (?, 'page', ?, 'topic', ?, 'reexamine', 0.9)`
      ).run(require('crypto').randomUUID(), pageId, toTopic.id);
    }
  }
}

function getRelatedPages(pageId, limit = 8) {
  return db.prepare(`
    SELECT p.id, p.volume, p.page_number, p.scan_path, p.summary, p.captured_at,
      COUNT(*) as shared
    FROM links l1
    JOIN links l2 ON l1.to_type = l2.to_type AND l1.to_id = l2.to_id AND l2.from_id != l1.from_id
    JOIN pages p ON p.id = l2.from_id
    WHERE l1.from_type='page' AND l1.from_id=? AND l2.from_type='page'
      AND l1.to_type IN ('scripture','person','collection')
    GROUP BY p.id
    ORDER BY shared DESC, p.captured_at DESC
    LIMIT ?
  `).all(pageId, limit);
}

// --- User-created indexes ---

function listUserIndexes() {
  return db.prepare(`
    SELECT ui.*, (
      SELECT COUNT(*) FROM index_entries ie WHERE ie.index_id = ui.id
    ) as entry_count
    FROM user_indexes ui
    ORDER BY ui.created_at DESC
  `).all();
}

function createUserIndex({ id, title, description, query }) {
  db.prepare(`
    INSERT INTO user_indexes (id, title, description, query, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(id, title, description ?? null, query ?? null);
  return db.prepare('SELECT * FROM user_indexes WHERE id = ?').get(id);
}

function updateUserIndex(id, { title, description, query }) {
  return db.prepare(`
    UPDATE user_indexes SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      query = COALESCE(?, query)
    WHERE id = ?
  `).run(title ?? null, description ?? null, query ?? null, id);
}

function deleteUserIndex(id) {
  db.prepare('DELETE FROM index_entries WHERE index_id = ?').run(id);
  return db.prepare('DELETE FROM user_indexes WHERE id = ?').run(id);
}

function getUserIndexDetail(id) {
  const index = db.prepare('SELECT * FROM user_indexes WHERE id = ?').get(id);
  if (!index) return null;

  const manualEntries = db.prepare(`
    SELECT ie.id as entry_id, ie.note, ie.created_at as pinned_at,
      p.id as page_id, p.volume, p.page_number, p.scan_path, p.summary, p.captured_at,
      i.id as item_id, i.kind as item_kind, i.text as item_text
    FROM index_entries ie
    LEFT JOIN pages p ON p.id = ie.page_id
    LEFT JOIN items i ON i.id = ie.item_id
    WHERE ie.index_id = ?
    ORDER BY ie.created_at DESC
  `).all(id);

  let queryResults = [];
  let queryCollections = [];
  let queryBooks = [];
  if (index.query && index.query.trim()) {
    try {
      queryResults = searchItems(index.query, 30);
    } catch {
      queryResults = getAllItems(30).filter(i => i.text.toLowerCase().includes(index.query.toLowerCase()));
    }
    if (!queryResults || queryResults.length === 0) {
      queryResults = getAllItems(30).filter(i => i.text.toLowerCase().includes(index.query.toLowerCase()));
    }
    const q = `%${index.query.trim()}%`;
    queryCollections = db.prepare(`
      SELECT c.id, c.kind, c.title, c.description, c.archived_at,
        COUNT(l.id) as page_count,
        MAX(p.captured_at) as recent_captured_at
      FROM collections c
      LEFT JOIN links l ON l.to_type='collection' AND l.to_id=c.id AND l.from_type='page'
      LEFT JOIN pages p ON p.id = l.from_id
      WHERE c.title LIKE ? COLLATE NOCASE OR c.description LIKE ? COLLATE NOCASE
      GROUP BY c.id
      ORDER BY c.archived_at IS NOT NULL, recent_captured_at DESC
      LIMIT 30
    `).all(q, q);
    queryBooks = db.prepare(`
      SELECT b.*, e.label as author_entity_label
      FROM books b LEFT JOIN entities e ON e.id = b.author_entity_id
      WHERE b.title LIKE ? COLLATE NOCASE OR b.author_label LIKE ? COLLATE NOCASE OR e.label LIKE ? COLLATE NOCASE
      ORDER BY b.title COLLATE NOCASE
      LIMIT 30
    `).all(q, q, q);
  }

  return { index, manualEntries, queryResults, queryCollections, queryBooks };
}

function addIndexEntry({ id, index_id, page_id, item_id, note }) {
  db.prepare(`
    INSERT INTO index_entries (id, index_id, page_id, item_id, note, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(id, index_id, page_id ?? null, item_id ?? null, note ?? null);
  return db.prepare('SELECT * FROM index_entries WHERE id = ?').get(id);
}

function deleteIndexEntry(id) {
  return db.prepare('DELETE FROM index_entries WHERE id = ?').run(id);
}

// --- Ingest failures ---

function softDeletePage(id) {
  const page = db.prepare('SELECT id FROM pages WHERE id = ?').get(id);
  if (!page) return { deleted: 0 };
  const now = new Date().toISOString();
  db.prepare('UPDATE pages SET deleted_at = ? WHERE id = ?').run(now, id);
  return { deleted: 1 };
}

function deletePagesByScanPath(scanPath) {
  const pages = db.prepare('SELECT id FROM pages WHERE scan_path = ?').all(scanPath);
  const ids = pages.map(p => p.id);
  if (ids.length === 0) return { deleted: 0 };
  const placeholders = ids.map(() => '?').join(',');
  const itemIds = db.prepare(`SELECT id FROM items WHERE page_id IN (${placeholders})`).all(...ids).map(r => r.id);
  db.prepare(`DELETE FROM items WHERE page_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM links WHERE from_type='page' AND from_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM links WHERE from_type='item' AND from_id IN (${itemIds.map(()=>'?').join(',') || "''"})`).run(...itemIds);
  db.prepare(`DELETE FROM backlog_items WHERE context_page_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM index_entries WHERE page_id IN (${placeholders})`).run(...ids);
  if (itemIds.length) db.prepare(`DELETE FROM index_entries WHERE item_id IN (${itemIds.map(()=>'?').join(',')})`).run(...itemIds);
  db.prepare(`DELETE FROM pages WHERE id IN (${placeholders})`).run(...ids);
  return { deleted: ids.length };
}

// Idempotent migration: add volume to ingest_failures
{
  const cols = db.pragma('table_info(ingest_failures)').map(c => c.name);
  if (!cols.includes('volume')) db.exec('ALTER TABLE ingest_failures ADD COLUMN volume TEXT');
}

function recordIngestFailure({ scan_path, source, stage, error, volume }) {
  const id = require('crypto').randomUUID();
  db.prepare(`
    INSERT INTO ingest_failures (id, scan_path, source, stage, error, volume, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, scan_path, source ?? null, stage ?? null, String(error).slice(0, 2000), volume ?? null);
  return id;
}

function listIngestFailures() {
  return db.prepare(
    `SELECT * FROM ingest_failures WHERE status='failed' ORDER BY created_at DESC`
  ).all();
}

function getIngestFailure(id) {
  return db.prepare('SELECT * FROM ingest_failures WHERE id = ?').get(id);
}

function markIngestFailureResolved(id) {
  return db.prepare(
    `UPDATE ingest_failures SET status='resolved', retried_at=datetime('now') WHERE id = ?`
  ).run(id);
}

function deleteIngestFailure(id) {
  return db.prepare('DELETE FROM ingest_failures WHERE id = ?').run(id);
}

// --- Collection rename ---

function updateCollectionSummary(id, summary) {
  db.prepare(`UPDATE collections SET summary = ? WHERE id = ?`).run(summary || null, id);
  return { id, summary: summary || null };
}

function renameCollection(id, title) {
  if (!title || !title.trim()) throw new Error('title required');
  const existing = db.prepare(`SELECT id, kind FROM collections WHERE id = ?`).get(id);
  if (!existing) throw new Error('collection not found');
  const dup = db.prepare(
    `SELECT id FROM collections WHERE kind = ? AND title = ? COLLATE NOCASE AND id != ?`
  ).get(existing.kind, title.trim(), id);
  if (dup) {
    db.prepare(`UPDATE links SET to_id = ? WHERE to_type='collection' AND to_id = ?`).run(dup.id, id);
    dedupeLinks();
    db.prepare(`DELETE FROM collections WHERE id = ?`).run(id);
    return { merged_into: dup.id };
  }
  db.prepare(`UPDATE collections SET title = ? WHERE id = ?`).run(title.trim(), id);
  return { id };
}

// Merge `sourceId` into `targetId`: all links retargeted, source deleted.
// Caller decides which survives. Returns { merged_into }.
function mergeCollectionInto(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) throw new Error('invalid merge');
  const src = db.prepare(`SELECT id, kind FROM collections WHERE id = ?`).get(sourceId);
  const tgt = db.prepare(`SELECT id, kind FROM collections WHERE id = ?`).get(targetId);
  if (!src || !tgt) throw new Error('collection not found');
  db.prepare(`UPDATE links SET to_id = ? WHERE to_type='collection' AND to_id = ?`).run(targetId, sourceId);
  dedupeLinks();
  db.prepare(`DELETE FROM collections WHERE id = ?`).run(sourceId);
  return { merged_into: targetId };
}

// Find pairs of collections whose titles look near-duplicate (same kind).
// Heuristic: strip common prefixes/punctuation, then require either (a) token
// Jaccard >= 0.6 or (b) one token-set is a subset of the other AND ≥2 tokens
// overlap. Returns [{ a: collection, b: collection, score }], higher score = stronger match.
function findCollectionDuplicateCandidates() {
  const rows = db.prepare(`
    SELECT id, kind, title
    FROM collections
    WHERE archived_at IS NULL AND kind != 'daily_log'
  `).all();
  const STOP = new Set(['the','a','an','of','in','on','for','to','with','and','or','my','our','your','is','are']);
  const STRIP_PREFIX = /^(sermon prep:|sermon:|cf\s+|re:|notes on|notes:|on\s+)/i;
  const normalize = (t) => {
    let s = (t || '').toLowerCase().trim();
    s = s.replace(STRIP_PREFIX, '').trim();
    s = s.replace(/[^\w\s]/g, ' ');
    const toks = s.split(/\s+/).filter(x => x && !STOP.has(x));
    return new Set(toks);
  };
  const items = rows.map(r => ({ ...r, tokens: normalize(r.title) }));
  // How common is each token across the whole corpus? Matches on rare tokens
  // ("sufficiency", "nehemiah") are far more interesting than matches on common
  // ones ("meeting", "notes", "sermon").
  const df = new Map();
  for (const it of items) for (const t of it.tokens) df.set(t, (df.get(t) || 0) + 1);
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.kind !== b.kind) continue;
      const ta = a.tokens, tb = b.tokens;
      if (ta.size === 0 || tb.size === 0) continue;
      const shared = [];
      for (const x of ta) if (tb.has(x)) shared.push(x);
      if (shared.length === 0) continue;
      const union = ta.size + tb.size - shared.length;
      const jaccard = union > 0 ? shared.length / union : 0;
      const subset = shared.length === Math.min(ta.size, tb.size);
      // A shared token with low document-frequency is a strong signal.
      const hasRareShared = shared.some(t => (df.get(t) || 0) <= 2 && t.length >= 4);
      // Accept pairs when: clear subset, high overlap, OR any rare shared token.
      if (subset || jaccard >= 0.5 || hasRareShared) {
        pairs.push({
          a: { id: a.id, kind: a.kind, title: a.title },
          b: { id: b.id, kind: b.kind, title: b.title },
          score: jaccard + (hasRareShared ? 0.2 : 0) + (subset ? 0.3 : 0),
          shared,
          reason: subset ? 'subset' : hasRareShared ? 'rare-shared' : 'overlap',
        });
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return pairs;
}

// --- Scripture rename/merge ---

function updateScriptureLabel(id, canonical) {
  if (!canonical || !canonical.trim()) throw new Error('canonical required');
  const next = canonical.trim();
  const existing = db.prepare(
    `SELECT id FROM scripture_refs WHERE canonical = ? COLLATE NOCASE AND id != ?`
  ).get(next, id);
  if (existing) {
    db.prepare(`UPDATE links SET to_id = ? WHERE to_type='scripture' AND to_id = ?`).run(existing.id, id);
    dedupeLinks();
    db.prepare(`DELETE FROM scripture_refs WHERE id = ?`).run(id);
    return { merged_into: existing.id };
  }
  db.prepare(`UPDATE scripture_refs SET canonical = ? WHERE id = ?`).run(next, id);
  return { id };
}

// --- Books (bibliographic notes) ---

function createBook({ id, title, author_entity_id, author_label, year, notes }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO books (id, title, author_entity_id, author_label, year, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, author_entity_id ?? null, author_label ?? null, year ?? null, notes ?? null, now);
  return { id, title, author_entity_id: author_entity_id ?? null, author_label: author_label ?? null, year: year ?? null, notes: notes ?? null, created_at: now };
}

function updateBook(id, { title, author_entity_id, author_label, year, notes }) {
  const cur = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
  if (!cur) throw new Error('book not found');
  db.prepare(`
    UPDATE books SET
      title = COALESCE(?, title),
      author_entity_id = CASE WHEN ? = 1 THEN ? ELSE author_entity_id END,
      author_label = CASE WHEN ? = 1 THEN ? ELSE author_label END,
      year = CASE WHEN ? = 1 THEN ? ELSE year END,
      notes = CASE WHEN ? = 1 THEN ? ELSE notes END
    WHERE id = ?
  `).run(
    title ?? null,
    author_entity_id !== undefined ? 1 : 0, author_entity_id ?? null,
    author_label !== undefined ? 1 : 0, author_label ?? null,
    year !== undefined ? 1 : 0, year ?? null,
    notes !== undefined ? 1 : 0, notes ?? null,
    id
  );
  return { id };
}

function deleteBook(id) {
  db.prepare(`DELETE FROM links WHERE to_type='book' AND to_id = ?`).run(id);
  db.prepare(`DELETE FROM books WHERE id = ?`).run(id);
  return { id };
}

// Move every page→book link from `sourceId` to `targetId`, then delete the source.
// Dedupes: if a page already links to the target book, skip re-linking.
function mergeBookInto(sourceId, targetId) {
  if (sourceId === targetId) throw new Error('source and target must differ');
  const source = db.prepare('SELECT id FROM books WHERE id = ?').get(sourceId);
  const target = db.prepare('SELECT id FROM books WHERE id = ?').get(targetId);
  if (!source || !target) throw new Error('book not found');
  const tx = db.transaction(() => {
    const links = db.prepare(
      `SELECT id, from_id, role_summary FROM links WHERE to_type='book' AND to_id = ?`
    ).all(sourceId);
    const existsOnTarget = db.prepare(
      `SELECT 1 FROM links WHERE to_type='book' AND to_id = ? AND from_type='page' AND from_id = ?`
    );
    const relink = db.prepare(`UPDATE links SET to_id = ? WHERE id = ?`);
    const drop = db.prepare(`DELETE FROM links WHERE id = ?`);
    let moved = 0;
    for (const l of links) {
      if (existsOnTarget.get(targetId, l.from_id)) drop.run(l.id);
      else { relink.run(targetId, l.id); moved++; }
    }
    db.prepare(`DELETE FROM books WHERE id = ?`).run(sourceId);
    return moved;
  });
  const moved = tx();
  return { ok: true, links_moved: moved, target_id: targetId };
}

function getBook(id) {
  const book = db.prepare(`
    SELECT b.*, e.label as author_entity_label
    FROM books b LEFT JOIN entities e ON e.id = b.author_entity_id
    WHERE b.id = ?
  `).get(id);
  if (!book) return null;
  const pages = db.prepare(`
    SELECT p.id, p.volume, p.page_number, p.scan_path, p.summary, p.captured_at, p.source_kind,
           l.role_summary
    FROM links l JOIN pages p ON p.id = l.from_id
    WHERE l.to_type='book' AND l.to_id=? AND l.from_type='page'
    ORDER BY p.captured_at DESC
  `).all(id);
  return { ...book, pages };
}

function listBooks() {
  return db.prepare(`
    SELECT b.id, b.title, b.year, b.author_entity_id, b.author_label, b.created_at,
           e.label as author_entity_label,
           (SELECT COUNT(*) FROM links l WHERE l.to_type='book' AND l.to_id = b.id AND l.from_type='page') as page_count
    FROM books b LEFT JOIN entities e ON e.id = b.author_entity_id
    ORDER BY b.title COLLATE NOCASE
  `).all();
}

// Books index: one row per book with the same "entries + pages + per-link
// role_summary" shape the people/topic/scripture indexes use, so the front-end
// can render them with the shared expandable UI.
function getBooksIndex() {
  const books = listBooks();
  if (books.length === 0) return [];
  const pageRows = db.prepare(`
    SELECT l.to_id as book_id,
           pg.id, pg.volume, pg.page_number, pg.scan_path, pg.summary,
           pg.captured_at, pg.source_kind,
           l.role_summary,
           d.date as daily_log_date
    FROM links l
    JOIN pages pg ON pg.id = l.from_id
    LEFT JOIN links ld ON ld.from_type='page' AND ld.from_id=pg.id AND ld.to_type='daily_log'
    LEFT JOIN daily_logs d ON d.id = ld.to_id
    WHERE l.to_type='book' AND l.from_type='page'
    ORDER BY pg.captured_at DESC
  `).all();
  const pagesByBook = {};
  for (const r of pageRows) {
    const { book_id, ...page } = r;
    (pagesByBook[book_id] = pagesByBook[book_id] || []).push(page);
  }
  return books.map(b => ({ ...b, pages: pagesByBook[b.id] || [], mention_count: b.page_count }));
}

function listBooksGroupedByAuthor() {
  const all = listBooks();
  const groups = new Map();
  for (const b of all) {
    const key = b.author_entity_label || b.author_label || '(unknown author)';
    if (!groups.has(key)) groups.set(key, { author_label: key, author_entity_id: b.author_entity_id, books: [] });
    groups.get(key).books.push(b);
  }
  return [...groups.values()].sort((a, b) => a.author_label.localeCompare(b.author_label, undefined, { sensitivity: 'base' }));
}

function linkPageToBook(pageId, bookId, role_summary = null, confidence = 1.0) {
  const existing = db.prepare(
    `SELECT id FROM links WHERE from_type='page' AND from_id=? AND to_type='book' AND to_id=?`
  ).get(pageId, bookId);
  if (existing) {
    if (role_summary) db.prepare(`UPDATE links SET role_summary = ? WHERE id = ?`).run(role_summary, existing.id);
    return existing.id;
  }
  const id = require('crypto').randomUUID();
  db.prepare(`
    INSERT INTO links (id, from_type, from_id, to_type, to_id, created_by, confidence, role_summary)
    VALUES (?, 'page', ?, 'book', ?, 'user', ?, ?)
  `).run(id, pageId, bookId, confidence, role_summary);
  return id;
}

function unlinkPageFromBook(pageId, bookId) {
  db.prepare(`DELETE FROM links WHERE from_type='page' AND from_id=? AND to_type='book' AND to_id=?`).run(pageId, bookId);
}

function archiveCollection(id) {
  const row = db.prepare(`SELECT kind FROM collections WHERE id = ?`).get(id);
  if (row && row.kind === 'daily_log') throw new Error('Daily logs cannot be archived');
  db.prepare(`UPDATE collections SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL`).run(id);
  return db.prepare(`SELECT * FROM collections WHERE id = ?`).get(id);
}

function unarchiveCollection(id) {
  const row = db.prepare(`SELECT kind FROM collections WHERE id = ?`).get(id);
  if (row && row.kind === 'daily_log') throw new Error('Daily logs cannot be archived');
  db.prepare(`UPDATE collections SET archived_at = NULL WHERE id = ?`).run(id);
  return db.prepare(`SELECT * FROM collections WHERE id = ?`).get(id);
}

function deleteCollection(id) {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM links WHERE to_type='collection' AND to_id=?`).run(id);
    db.prepare(`DELETE FROM links WHERE from_type='collection' AND from_id=?`).run(id);
    db.prepare(`DELETE FROM collections WHERE id=?`).run(id);
  });
  tx();
}

function updateCollectionKind(id, nextKind) {
  const row = db.prepare(`SELECT title FROM collections WHERE id=?`).get(id);
  if (!row) throw new Error('collection not found');
  const clash = db.prepare(`SELECT id FROM collections WHERE kind=? AND title=? COLLATE NOCASE AND id != ?`).get(nextKind, row.title, id);
  if (clash) throw new Error(`A ${nextKind} named "${row.title}" already exists`);
  db.prepare(`UPDATE collections SET kind=? WHERE id=?`).run(nextKind, id);
}

// Unified collection updater used by PATCH /api/collections/:id. Any field
// may be omitted; COALESCE pattern prevents clobbering. Does NOT handle
// daily_log conversion — callers should use reclassifyCollectionKind for that.
function updateCollection(id, { kind, title, description, target_date, status } = {}) {
  const row = db.prepare(`SELECT id, kind, title FROM collections WHERE id = ?`).get(id);
  if (!row) throw new Error('collection not found');
  if (kind && kind !== row.kind) {
    const clash = db.prepare(
      `SELECT id FROM collections WHERE kind=? AND title=? COLLATE NOCASE AND id != ?`
    ).get(kind, title ?? row.title, id);
    if (clash) throw new Error(`A ${kind} named "${title ?? row.title}" already exists`);
  }
  db.prepare(`
    UPDATE collections SET
      kind        = COALESCE(?, kind),
      title       = COALESCE(?, title),
      description = COALESCE(?, description),
      target_date = COALESCE(?, target_date),
      status      = COALESCE(?, status)
    WHERE id = ?
  `).run(kind ?? null, title ?? null, description ?? null, target_date ?? null, status ?? null, id);
  return db.prepare(`SELECT * FROM collections WHERE id = ?`).get(id);
}

// Update a page's volume / page_number. COALESCE pattern: unspecified fields
// stay intact. Empty-string volume clears the column; any other string/number
// is written as-is (SQLite's dynamic typing accepts both).
function updatePage(id, { volume, page_number, captured_at } = {}) {
  const row = db.prepare(`SELECT id FROM pages WHERE id = ?`).get(id);
  if (!row) throw new Error('page not found');
  const volOut = volume === undefined
    ? null
    : (volume === null || volume === '' ? '' : volume);
  // captured_at: undefined = leave; YYYY-MM-DD normalized to midday UTC; full ISO accepted as-is.
  // NOT NULL — empty/null is rejected.
  let capFlag = 0, capVal = null;
  if (captured_at !== undefined && captured_at !== null && captured_at !== '') {
    capFlag = 1;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(captured_at).trim())) capVal = `${String(captured_at).trim()}T12:00:00.000Z`;
    else capVal = String(captured_at).trim();
  }
  db.prepare(`
    UPDATE pages SET
      volume      = CASE WHEN ? = 1 THEN (CASE WHEN ? = '' THEN NULL ELSE ? END) ELSE volume END,
      page_number = COALESCE(?, page_number),
      captured_at = CASE WHEN ? = 1 THEN ? ELSE captured_at END
    WHERE id = ?
  `).run(
    volume === undefined ? 0 : 1,
    volOut === null ? '' : volOut,
    volOut === null ? null : volOut,
    page_number ?? null,
    capFlag,
    capVal,
    id
  );
  return db.prepare(`SELECT * FROM pages WHERE id = ?`).get(id);
}

// --- Remember feed ---

// Return a single random page per band (year_ago, month_ago, week_ago), ± 3 days.
// Each value is either null (no page) or { id, volume, page_number, scan_path, summary, captured_at }.
function getRememberFeed(now = new Date()) {
  function pick(offsetDays) {
    const target = new Date(now);
    target.setDate(target.getDate() - offsetDays);
    const start = new Date(target); start.setDate(start.getDate() - 3);
    const end = new Date(target); end.setDate(end.getDate() + 4); // exclusive upper bound
    const startIso = start.toISOString().slice(0, 10);
    const endIso = end.toISOString().slice(0, 10);
    return db.prepare(`
      SELECT id, volume, page_number, scan_path, summary, captured_at
      FROM pages
      WHERE substr(captured_at, 1, 10) >= ? AND substr(captured_at, 1, 10) < ?
      ORDER BY RANDOM() LIMIT 1
    `).get(startIso, endIso) || null;
  }
  return {
    year_ago: pick(365),
    month_ago: pick(30),
    week_ago: pick(7),
  };
}

// --- Global search for Cmd-K ---

// Fast multi-surface search. Each bucket is limited to 5. Uses FTS for items→pages
// and LIKE for other entities. Used on every keystroke so we keep it cheap.
function searchAll(q, limit = 5) {
  const clean = String(q || '').trim();
  if (!clean) return { pages: [], collections: [], people: [], scripture: [], topics: [], books: [] };

  // Pages via FTS (escaped). Fall back to LIKE on summary if FTS fails/empty.
  let pages = [];
  try {
    const match = escapeFts(clean);
    if (match) {
      pages = db.prepare(`
        SELECT DISTINCT p.id, p.volume, p.page_number, p.scan_path, p.summary, p.captured_at
        FROM items_fts f
        JOIN items i ON i.rowid = f.rowid
        JOIN pages p ON p.id = i.page_id
        WHERE items_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(match, limit);
    }
  } catch { pages = []; }
  if (pages.length === 0) {
    pages = db.prepare(`
      SELECT id, volume, page_number, scan_path, summary, captured_at
      FROM pages
      WHERE summary LIKE ? COLLATE NOCASE
      ORDER BY captured_at DESC LIMIT ?
    `).all(`%${clean}%`, limit);
  }

  const like = `%${clean}%`;
  const collections = db.prepare(`
    SELECT id, kind, title FROM collections
    WHERE kind != 'daily_log' AND title LIKE ? COLLATE NOCASE
    ORDER BY title COLLATE NOCASE LIMIT ?
  `).all(like, limit);
  const people = db.prepare(`
    SELECT id, label FROM people
    WHERE label LIKE ? COLLATE NOCASE
    ORDER BY label COLLATE NOCASE LIMIT ?
  `).all(like, limit);
  const scripture = db.prepare(`
    SELECT id, canonical as label FROM scripture_refs
    WHERE canonical LIKE ? COLLATE NOCASE
    ORDER BY canonical COLLATE NOCASE LIMIT ?
  `).all(like, limit);
  const topics = db.prepare(`
    SELECT id, label FROM entities
    WHERE kind='topic' AND label LIKE ? COLLATE NOCASE
    ORDER BY label COLLATE NOCASE LIMIT ?
  `).all(like, limit);
  const books = db.prepare(`
    SELECT id, title, author_label FROM books
    WHERE title LIKE ? COLLATE NOCASE OR author_label LIKE ? COLLATE NOCASE
    ORDER BY title COLLATE NOCASE LIMIT ?
  `).all(like, like, limit);

  return {
    pages: pages.map(p => ({ ...p, kind: 'page', title: p.summary || `p.${p.page_number ?? '?'}` })),
    collections: collections.map(c => ({ ...c, kind: c.kind || 'collection' })),
    people: people.map(p => ({ ...p, kind: 'person' })),
    scripture: scripture.map(s => ({ ...s, kind: 'scripture' })),
    topics: topics.map(t => ({ ...t, kind: 'topic' })),
    books: books.map(b => ({ ...b, label: b.title, kind: 'book' })),
  };
}

// Get artifact / reference by id — used by fetch-now endpoints.
function getArtifact(id) {
  return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
}
function getArtifactDetail(id) {
  const a = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
  if (!a) return null;
  return {
    ...a,
    versions: db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC').all(id),
    linked_collections: listLinkedCollections('artifact', id),
    linked_indexes: listLinkedUserIndexes('artifact', id),
  };
}
function getReference(id) {
  return db.prepare('SELECT * FROM reference_materials WHERE id = ?').get(id);
}

// Convert an artifact, reference, or collection to a different kind while
// preserving all linked pages, connections, and index-tree parents.
// Supported: artifact ↔ reference, artifact/reference → collection, collection → artifact/reference.
function convertEntityKind(fromKind, fromId, toKind) {
  const ALLOWED = {
    artifact:   ['reference', 'collection'],
    reference:  ['artifact',  'collection'],
    collection: ['artifact',  'reference'],
  };
  if (!ALLOWED[fromKind] || !ALLOWED[fromKind].includes(toKind)) {
    throw new Error(`Cannot convert ${fromKind} to ${toKind}`);
  }

  // Fetch full source row so we can copy fields.
  let src;
  if (fromKind === 'artifact')   src = getArtifact(fromId);
  else if (fromKind === 'reference') src = getReference(fromId);
  else src = db.prepare('SELECT * FROM collections WHERE id = ?').get(fromId);
  if (!src) throw new Error('Source entity not found');

  const newId = require('crypto').randomUUID();

  db.transaction(() => {
    // Create destination entity.
    if (toKind === 'artifact') {
      createArtifact({ id: newId, title: src.title, external_url: src.external_url || null, notes: src.notes || src.description || src.note || null });
      if (src.fetched_content || src.fetched_at || src.fetched_error) {
        updateArtifactContent(newId, {
          fetched_content: src.fetched_content || null,
          fetched_at:      src.fetched_at      || null,
          fetched_error:   src.fetched_error   || null,
        });
      }
    } else if (toKind === 'reference') {
      createReference({
        id: newId,
        title: src.title,
        external_url: src.external_url || null,
        note: src.note || src.description || null,
      });
      if (src.fetched_content || src.fetched_at || src.fetched_error) {
        updateReferenceContent(newId, {
          fetched_content: src.fetched_content || null,
          fetched_at:      src.fetched_at      || null,
          fetched_error:   src.fetched_error   || null,
        });
      }
    } else {
      // toKind === 'collection'
      createCollection({
        id: newId,
        kind: 'topical',
        title: src.title,
        description: src.description || src.note || null,
      });
    }

    // Repoint all links that pointed TO the old entity.
    db.prepare('UPDATE links SET to_type = ?, to_id = ? WHERE to_type = ? AND to_id = ?')
      .run(toKind, newId, fromKind, fromId);
    // Repoint all links that came FROM the old entity.
    db.prepare('UPDATE links SET from_type = ?, from_id = ? WHERE from_type = ? AND from_id = ?')
      .run(toKind, newId, fromKind, fromId);

    // Migrate index_parents (no conflict risk — new entity has none yet).
    db.prepare('UPDATE index_parents SET child_kind = ?, child_id = ? WHERE child_kind = ? AND child_id = ?')
      .run(toKind, newId, fromKind, fromId);
    db.prepare('UPDATE index_parents SET parent_kind = ?, parent_id = ? WHERE parent_kind = ? AND parent_id = ?')
      .run(toKind, newId, fromKind, fromId);

    // Delete the old entity. Cascades inside deleteIndexRow (artifact_versions, link
    // purge, index_parents purge) are all no-ops since we already migrated them above.
    deleteIndexRow(fromKind, fromId);
  })();

  return { id: newId, kind: toKind, label: src.title };
}

// ── Chat (Phase 4.5) ────────────────────────────────────────────────────────
function listChatSessions() {
  return db.prepare(`
    SELECT s.*, (
      SELECT m.body FROM chat_messages m
      WHERE m.session_id = s.id AND m.role IN ('user','assistant')
      ORDER BY m.created_at DESC LIMIT 1
    ) AS last_preview
    FROM chat_sessions s
    ORDER BY s.updated_at DESC
  `).all();
}
function getChatSession(id) {
  const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
  if (!session) return null;
  const messages = db.prepare(`
    SELECT id, role, body, proposal_json, status, created_at, executed_at
    FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC
  `).all(id);
  return { session, messages };
}
function createChatSession({ id, title, pinned_page_id }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO chat_sessions (id, title, pinned_page_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, title || null, pinned_page_id || null, now, now);
  return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
}
function touchChatSession(id, title) {
  const now = new Date().toISOString();
  if (title) {
    db.prepare(`UPDATE chat_sessions SET updated_at = ?, title = COALESCE(title, ?) WHERE id = ?`).run(now, title, id);
  } else {
    db.prepare(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`).run(now, id);
  }
}
function deleteChatSession(id) {
  db.prepare(`DELETE FROM chat_messages WHERE session_id = ?`).run(id);
  db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(id);
}
function appendChatMessage({ session_id, role, body, proposal_json, status }) {
  const id = require('crypto').randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO chat_messages (id, session_id, role, body, proposal_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, 'final'), ?)
  `).run(id, session_id, role, body || null, proposal_json || null, status || null, now);
  touchChatSession(session_id);
  return db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id);
}
function getChatMessage(id) {
  return db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id);
}
function setChatMessageStatus(id, status) {
  const executed = (status === 'executed') ? new Date().toISOString() : null;
  db.prepare(`UPDATE chat_messages SET status = ?, executed_at = COALESCE(?, executed_at) WHERE id = ?`)
    .run(status, executed, id);
  return db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id);
}
function listChatMemory() {
  return db.prepare(`SELECT key, value, updated_at FROM chat_memory ORDER BY updated_at DESC`).all();
}
function setChatMemory(key, value) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO chat_memory (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now);
}
function deleteChatMemory(key) {
  db.prepare(`DELETE FROM chat_memory WHERE key = ?`).run(key);
}

// ── Planning hub (Phase 4) ──────────────────────────────────────────────────
// `weekStartISO` is the ISO date of the Monday of the target week.
function _isoMondayOf(date) {
  const d = new Date(date);
  const day = d.getUTCDay() || 7;        // Sun = 0 → 7
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function listRocks({ weekStart, includeAll = false } = {}) {
  if (includeAll) {
    return db.prepare(`SELECT r.*, e.label as role_label FROM rocks r LEFT JOIN entities e ON e.id = r.role_id ORDER BY r.week_start DESC, r.created_at ASC`).all();
  }
  const ws = weekStart || _isoMondayOf(new Date());
  return db.prepare(`SELECT r.*, e.label as role_label FROM rocks r LEFT JOIN entities e ON e.id = r.role_id WHERE r.week_start = ? ORDER BY r.created_at ASC`).all(ws);
}
function createRock({ id, title, role_id, week_start, status }) {
  const ws = week_start || _isoMondayOf(new Date());
  db.prepare(`
    INSERT INTO rocks (id, title, role_id, week_start, status, created_at)
    VALUES (?, ?, ?, ?, COALESCE(?, 'open'), datetime('now'))
    ON CONFLICT(title, week_start) DO NOTHING
  `).run(id, title, role_id ?? null, ws, status ?? null);
  return db.prepare(`SELECT * FROM rocks WHERE title = ? AND week_start = ?`).get(title, ws);
}
function updateRock(id, { title, role_id, status, completed_at }) {
  db.prepare(`
    UPDATE rocks SET
      title = COALESCE(?, title),
      role_id = COALESCE(?, role_id),
      status = COALESCE(?, status),
      completed_at = COALESCE(?, completed_at)
    WHERE id = ?
  `).run(title ?? null, role_id ?? null, status ?? null, completed_at ?? null, id);
  return db.prepare(`SELECT * FROM rocks WHERE id = ?`).get(id);
}
function deleteRock(id) {
  db.prepare(`DELETE FROM links WHERE (from_type='rock' AND from_id=?) OR (to_type='rock' AND to_id=?)`).run(id, id);
  return db.prepare(`DELETE FROM rocks WHERE id = ?`).run(id);
}

function listHabits({ includeArchived = false } = {}) {
  // `entities` also has archived_at/sort_order/created_at, so every column
  // referenced in WHERE/ORDER BY must be table-qualified to avoid ambiguity.
  const where = includeArchived ? '' : 'WHERE h.archived_at IS NULL';
  return db.prepare(`SELECT h.*, e.label as role_label FROM habits h LEFT JOIN entities e ON e.id = h.role_id ${where} ORDER BY h.sort_order ASC, h.created_at ASC`).all();
}
function createHabit({ id, label, role_id, active_from, sort_order }) {
  db.prepare(`
    INSERT INTO habits (id, label, role_id, active_from, sort_order, created_at)
    VALUES (?, ?, ?, ?, COALESCE(?, 0), datetime('now'))
  `).run(id, label, role_id ?? null, active_from ?? null, sort_order ?? null);
  return db.prepare(`SELECT * FROM habits WHERE id = ?`).get(id);
}
function updateHabit(id, { label, role_id, active_from, active_to, sort_order, archived }) {
  db.prepare(`
    UPDATE habits SET
      label = COALESCE(?, label),
      role_id = COALESCE(?, role_id),
      active_from = COALESCE(?, active_from),
      active_to = COALESCE(?, active_to),
      sort_order = COALESCE(?, sort_order),
      archived_at = CASE WHEN ? IS NULL THEN archived_at WHEN ? = 1 THEN datetime('now') ELSE NULL END
    WHERE id = ?
  `).run(label ?? null, role_id ?? null, active_from ?? null, active_to ?? null, sort_order ?? null,
         archived === undefined ? null : (archived ? 1 : 0),
         archived ? 1 : 0, id);
  return db.prepare(`SELECT * FROM habits WHERE id = ?`).get(id);
}
function deleteHabit(id) {
  db.prepare(`DELETE FROM habit_checks WHERE habit_id = ?`).run(id);
  return db.prepare(`DELETE FROM habits WHERE id = ?`).run(id);
}
function setHabitCheck(habit_id, date, checked) {
  db.prepare(`
    INSERT INTO habit_checks (habit_id, date, checked) VALUES (?, ?, ?)
    ON CONFLICT(habit_id, date) DO UPDATE SET checked = excluded.checked
  `).run(habit_id, date, checked ? 1 : 0);
}
function getHabitChecks({ since } = {}) {
  if (since) return db.prepare(`SELECT habit_id, date, checked FROM habit_checks WHERE date >= ? ORDER BY date DESC`).all(since);
  return db.prepare(`SELECT habit_id, date, checked FROM habit_checks ORDER BY date DESC`).all();
}
function getHabitStreaks() {
  // Compute current streak per habit: consecutive days back from today where checked=1.
  const habits = db.prepare(`SELECT id FROM habits WHERE archived_at IS NULL`).all();
  const today = new Date().toISOString().slice(0, 10);
  const streaks = {};
  for (const h of habits) {
    let streak = 0;
    let cursor = new Date(today);
    while (true) {
      const iso = cursor.toISOString().slice(0, 10);
      const row = db.prepare(`SELECT checked FROM habit_checks WHERE habit_id = ? AND date = ?`).get(h.id, iso);
      if (row && row.checked) streak++;
      else break;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      if (streak > 365) break;
    }
    streaks[h.id] = streak;
  }
  return streaks;
}

// Mission lives as a value-versioned row with slug='mission' so edits are
// append-only (matches the existing values invariant). Convenience accessors.
function getCurrentMission() {
  return db.prepare(`
    SELECT v.* FROM values_versions v
    INNER JOIN (SELECT slug, MAX(version) as v FROM values_versions WHERE slug = 'mission' GROUP BY slug) m
      ON m.slug = v.slug AND m.v = v.version
    WHERE v.slug = 'mission'
  `).get();
}
function setMission(body) {
  const cur = getCurrentMission();
  const nextV = (cur ? cur.version : 0) + 1;
  const id = require('crypto').randomUUID();
  db.prepare(`
    INSERT INTO values_versions (id, slug, title, body, version, created_at)
    VALUES (?, 'mission', 'Mission', ?, ?, datetime('now'))
  `).run(id, body, nextV);
  return getCurrentMission();
}

function getPlanningHub({ weekStart } = {}) {
  const ws = weekStart || _isoMondayOf(new Date());
  // Compose the last 7 days for the habit grid (Monday → Sunday of `ws`).
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(ws); d.setUTCDate(d.getUTCDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  const habitChecks = db.prepare(`
    SELECT habit_id, date, checked FROM habit_checks
    WHERE date >= ? AND date < date(?, '+7 days')
  `).all(ws, ws);
  const checkMap = {};
  for (const c of habitChecks) {
    (checkMap[c.habit_id] = checkMap[c.habit_id] || {})[c.date] = !!c.checked;
  }
  return {
    week_start: ws,
    week_days: days,
    mission: getCurrentMission(),
    values: currentValues(),
    roles: listRolesWithAreas(),
    rocks: listRocks({ weekStart: ws }),
    habits: listHabits().map(h => ({
      ...h,
      checks: checkMap[h.id] || {},
    })),
    streaks: getHabitStreaks(),
    commitments: listCommitments(),
  };
}

// --- Indexing sharpen: headings (TOC grouping for collections + artifacts) ---
// Headings are pure organizational containers: a named label + optional
// description. They participate in the index_parents DAG as both parent and
// child, so a heading can be nested under another heading, and a collection
// or artifact can sit under multiple headings.

function createHeading({ id, label, description = null, scope = 'collection' }) {
  if (!label || !String(label).trim()) throw new Error('label required');
  const safeScope = scope === 'artifact' ? 'artifact' : 'collection';
  const rowId = id || `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT id FROM headings WHERE label = ? COLLATE NOCASE AND scope = ?`).get(label.trim(), safeScope);
  if (existing) return { id: existing.id, existed: true };
  db.prepare(`INSERT INTO headings (id, label, description, scope, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(rowId, label.trim(), description || null, safeScope, now);
  return { id: rowId, existed: false };
}

function listHeadings({ includeArchived = false } = {}) {
  const rows = db.prepare(`
    SELECT h.id, h.label, h.description, h.scope, h.archived_at,
           (SELECT COUNT(*) FROM index_parents ip
            WHERE ip.parent_kind = 'heading' AND ip.parent_id = h.id) AS child_count
    FROM headings h
    ${includeArchived ? '' : 'WHERE h.archived_at IS NULL'}
    ORDER BY h.label COLLATE NOCASE
  `).all();
  return rows;
}

function renameHeading(id, newLabel) {
  const label = String(newLabel || '').trim();
  if (!label) throw new Error('label required');
  const current = db.prepare(`SELECT id FROM headings WHERE id = ?`).get(id);
  if (!current) throw new Error('heading not found');
  const existing = db.prepare(`SELECT id FROM headings WHERE id != ? AND label = ? COLLATE NOCASE`).get(id, label);
  if (existing) {
    mergeHeadingInto(id, existing.id);
    return { id: existing.id, merged_from: id };
  }
  db.prepare(`UPDATE headings SET label = ? WHERE id = ?`).run(label, id);
  return { id };
}

function mergeHeadingInto(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) throw new Error('invalid merge');
  const tx = db.transaction(() => {
    // Move source's child-edges onto the target (dedup via UPDATE OR IGNORE).
    db.prepare(`UPDATE OR IGNORE index_parents SET parent_id = ? WHERE parent_kind = 'heading' AND parent_id = ?`)
      .run(targetId, sourceId);
    // Move source's own parent-edges onto the target.
    db.prepare(`UPDATE OR IGNORE index_parents SET child_id = ? WHERE child_kind = 'heading' AND child_id = ?`)
      .run(targetId, sourceId);
    // Self-edges can appear if source was under a heading that is now the target.
    db.prepare(`DELETE FROM index_parents WHERE child_kind = parent_kind AND child_id = parent_id`).run();
    // Drop any still-duplicate edges (source=target collisions).
    db.prepare(`DELETE FROM index_parents WHERE (child_kind, child_id, parent_kind, parent_id) IN (
      SELECT child_kind, child_id, parent_kind, parent_id FROM index_parents
      WHERE (parent_kind = 'heading' AND parent_id = ?) OR (child_kind = 'heading' AND child_id = ?)
      GROUP BY child_kind, child_id, parent_kind, parent_id HAVING COUNT(*) > 1
    )`).run(sourceId, sourceId);
    db.prepare(`DELETE FROM headings WHERE id = ?`).run(sourceId);
  });
  tx();
  return { source_id: sourceId, target_id: targetId };
}

function deleteHeading(id) {
  db.prepare(`DELETE FROM headings WHERE id = ?`).run(id);
  // Caller (deleteIndexRow) also calls purgeIndexParentsFor.
}

// --- Indexing sharpen: user_index exclusions / inclusions --------------------
// Exclusions + inclusions store noise-filter state for AI-curated user_indexes.
// Exclusions have a `reason`: 'auto_high_frequency' (AI/server filter) or
// 'user_blocked' (explicit user block).
function listUserIndexExclusions(userIndexId) {
  return db.prepare(`
    SELECT id, user_index_id, entity_kind, entity_id, reason, created_at
    FROM user_index_exclusions WHERE user_index_id = ?
    ORDER BY reason, created_at
  `).all(userIndexId);
}

function listUserIndexInclusions(userIndexId) {
  return db.prepare(`
    SELECT id, user_index_id, entity_kind, entity_id, created_at
    FROM user_index_inclusions WHERE user_index_id = ?
    ORDER BY created_at
  `).all(userIndexId);
}

function addUserIndexExclusion({ user_index_id, entity_kind, entity_id, reason = 'user_blocked' }) {
  const id = `uie_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO user_index_exclusions (id, user_index_id, entity_kind, entity_id, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, user_index_id, entity_kind, entity_id, reason, now);
  // Remove from inclusions if it was forced in.
  db.prepare(`DELETE FROM user_index_inclusions WHERE user_index_id = ? AND entity_kind = ? AND entity_id = ?`)
    .run(user_index_id, entity_kind, entity_id);
  return { id };
}

function removeUserIndexExclusion(entryId) {
  db.prepare(`DELETE FROM user_index_exclusions WHERE id = ?`).run(entryId);
  return { ok: true };
}

function addUserIndexInclusion({ user_index_id, entity_kind, entity_id }) {
  const id = `uii_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO user_index_inclusions (id, user_index_id, entity_kind, entity_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, user_index_id, entity_kind, entity_id, now);
  // Remove from exclusions if it was blocked.
  db.prepare(`DELETE FROM user_index_exclusions WHERE user_index_id = ? AND entity_kind = ? AND entity_id = ?`)
    .run(user_index_id, entity_kind, entity_id);
  return { id };
}

function removeUserIndexInclusion(entryId) {
  db.prepare(`DELETE FROM user_index_inclusions WHERE id = ?`).run(entryId);
  return { ok: true };
}

function purgeUserIndexFilters(userIndexId) {
  db.prepare(`DELETE FROM user_index_exclusions WHERE user_index_id = ?`).run(userIndexId);
  db.prepare(`DELETE FROM user_index_inclusions WHERE user_index_id = ?`).run(userIndexId);
}

function purgeAutoUserIndexExclusions(userIndexId) {
  db.prepare(`DELETE FROM user_index_exclusions WHERE user_index_id = ? AND reason = 'auto_high_frequency'`)
    .run(userIndexId);
}

// --- Indexing sharpen: content_hash for cross-kind auto-link classifier ------
// A cheap sha1 over the row's lowercased (title|label) + description. The
// classifier skips rows whose hash hasn't changed since the last sweep —
// primary cost-control lever per the plan.
const _CROSS_KIND_TABLES = {
  collection:  { table: 'collections',         labelCol: 'title',       descCol: 'description' },
  artifact:    { table: 'artifacts',           labelCol: 'title',       descCol: null },
  reference:   { table: 'reference_materials', labelCol: 'title',       descCol: 'note' },
  daily_log:   { table: 'daily_logs',          labelCol: 'date',        descCol: 'summary' },
};

function _computeContentHashSync(kind, id) {
  const spec = _CROSS_KIND_TABLES[kind];
  if (!spec) return null;
  const cols = spec.descCol
    ? `${spec.labelCol} AS label, ${spec.descCol} AS description`
    : `${spec.labelCol} AS label, NULL AS description`;
  const row = db.prepare(`SELECT ${cols} FROM ${spec.table} WHERE id = ?`).get(id);
  if (!row) return null;
  const material = `${(row.label || '').toLowerCase().trim()}\n${(row.description || '').toLowerCase().trim()}`;
  return require('crypto').createHash('sha1').update(material).digest('hex');
}

function getCrossKindContent(kind, id) {
  const spec = _CROSS_KIND_TABLES[kind];
  if (!spec) return null;
  const cols = spec.descCol
    ? `id, ${spec.labelCol} AS label, ${spec.descCol} AS description, content_hash, links_classified_at`
    : `id, ${spec.labelCol} AS label, NULL AS description, content_hash, links_classified_at`;
  return db.prepare(`SELECT ${cols} FROM ${spec.table} WHERE id = ?`).get(id) || null;
}

function refreshContentHash(kind, id) {
  const spec = _CROSS_KIND_TABLES[kind];
  if (!spec) return { changed: false, hash: null };
  const fresh = _computeContentHashSync(kind, id);
  if (fresh == null) return { changed: false, hash: null };
  const existing = db.prepare(`SELECT content_hash FROM ${spec.table} WHERE id = ?`).get(id);
  const prev = existing ? existing.content_hash : null;
  if (prev === fresh) return { changed: false, hash: fresh };
  db.prepare(`UPDATE ${spec.table} SET content_hash = ? WHERE id = ?`).run(fresh, id);
  return { changed: true, hash: fresh };
}

function markLinksClassified(kind, id) {
  const spec = _CROSS_KIND_TABLES[kind];
  if (!spec) return;
  db.prepare(`UPDATE ${spec.table} SET links_classified_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

// Candidate pool for cross-kind auto-link classifier: all active rows of the
// eligible target kinds, minus the source itself. Returns {kind,id,label,description}.
function listCrossKindCandidates({ excludeKind, excludeId }) {
  const out = [];
  for (const kind of Object.keys(_CROSS_KIND_TABLES)) {
    const spec = _CROSS_KIND_TABLES[kind];
    const cols = spec.descCol
      ? `id, ${spec.labelCol} AS label, ${spec.descCol} AS description`
      : `id, ${spec.labelCol} AS label, NULL AS description`;
    const where = spec.table === 'daily_logs'
      ? `WHERE 1=1`
      : `WHERE archived_at IS NULL`;
    const rows = db.prepare(`SELECT ${cols} FROM ${spec.table} ${where}`).all();
    for (const r of rows) {
      if (kind === excludeKind && r.id === excludeId) continue;
      out.push({ kind, id: r.id, label: r.label || '', description: r.description || '' });
    }
  }
  return out;
}

// --- Phase 6: unified rename/merge/archive/delete dispatchers ----------------
// Every index kind flows through one of these four functions so the new
// /api/index/:kind/:id/* endpoints can stay thin. Per-kind quirks (merge
// semantics, parent-column deprecation, index_entries cascade) live here.

// Dispatcher: rename a row by kind. On name collision (where the kind has a
// UNIQUE label constraint) this merges the source INTO the existing row.
// Returns { id } of the final row (source id if no merge, target id if merge).
function renameIndexRow(kind, id, newLabel) {
  if (!newLabel || !String(newLabel).trim()) throw new Error('label required');
  const label = String(newLabel).trim();
  switch (kind) {
    case 'person': return updatePerson(id, { label });
    case 'topic':  return updateTopicLabel(id, label);
    case 'scripture': return updateScriptureLabel(id, label);
    case 'collection': return renameCollection(id, label);
    case 'book': return renameBook(id, label);
    case 'artifact': return renameArtifact(id, label);
    case 'reference': return renameReference(id, label);
    case 'user_index': return renameUserIndex(id, label);
    case 'heading': return renameHeading(id, label);
    default: throw new Error(`rename not supported for kind: ${kind}`);
  }
}

// Rename a book with merge-on-collision (title+author case-insensitive).
function renameBook(id, title) {
  const current = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
  if (!current) throw new Error('book not found');
  const existing = db.prepare(
    `SELECT id FROM books WHERE id != ? AND LOWER(title) = LOWER(?) AND COALESCE(author_label,'') = COALESCE(?, '')`
  ).get(id, title, current.author_label || '');
  if (existing) {
    mergeBookInto(id, existing.id);
    return { id: existing.id, merged_from: id };
  }
  db.prepare('UPDATE books SET title = ? WHERE id = ?').run(title, id);
  return { id };
}

// Rename an artifact. Artifacts have no UNIQUE constraint on title, so this is
// a plain update — merges happen via /api/index/:kind/:id/merge only.
function renameArtifact(id, title) {
  const current = db.prepare('SELECT id FROM artifacts WHERE id = ?').get(id);
  if (!current) throw new Error('artifact not found');
  db.prepare('UPDATE artifacts SET title = ? WHERE id = ?').run(title, id);
  return { id };
}

function renameReference(id, title) {
  const current = db.prepare('SELECT id FROM reference_materials WHERE id = ?').get(id);
  if (!current) throw new Error('reference not found');
  db.prepare('UPDATE reference_materials SET title = ? WHERE id = ?').run(title, id);
  return { id };
}

// Rename a user_index with merge-on-collision (title UNIQUE COLLATE NOCASE).
function renameUserIndex(id, title) {
  const current = db.prepare('SELECT id FROM user_indexes WHERE id = ?').get(id);
  if (!current) throw new Error('user_index not found');
  const existing = db.prepare(
    `SELECT id FROM user_indexes WHERE id != ? AND LOWER(title) = LOWER(?)`
  ).get(id, title);
  if (existing) {
    mergeUserIndexInto(id, existing.id);
    return { id: existing.id, merged_from: id };
  }
  db.prepare('UPDATE user_indexes SET title = ? WHERE id = ?').run(title, id);
  return { id };
}

// Merge dispatcher. The source row's links + index_entries + index_parents
// edges are moved to the target, duplicates are dropped, then the source is
// deleted. Every path dedupes after the bulk UPDATE.
function mergeIndexRows(kind, sourceId, targetId) {
  if (sourceId === targetId) throw new Error('source and target must differ');
  switch (kind) {
    case 'person': {
      const src = db.prepare('SELECT label FROM people WHERE id = ?').get(sourceId);
      const tgt = db.prepare('SELECT label FROM people WHERE id = ?').get(targetId);
      if (!src || !tgt) throw new Error('person not found');
      // Re-using updatePerson on the target with the target's own label triggers
      // nothing, so we move links by hand then delete the source.
      db.prepare(`UPDATE links SET to_id = ? WHERE to_type='person' AND to_id = ?`).run(targetId, sourceId);
      dedupeLinks();
      _rewriteParentEdges(kind, sourceId, targetId);
      deletePerson(sourceId);
      purgeIndexParentsFor(kind, sourceId);
      return { id: targetId };
    }
    case 'scripture': {
      db.prepare(`UPDATE links SET to_id = ? WHERE to_type='scripture' AND to_id = ?`).run(targetId, sourceId);
      dedupeLinks();
      _rewriteParentEdges(kind, sourceId, targetId);
      deleteScriptureRef(sourceId);
      purgeIndexParentsFor(kind, sourceId);
      return { id: targetId };
    }
    case 'topic': {
      db.prepare(`UPDATE links SET to_id = ? WHERE to_type='topic' AND to_id = ?`).run(targetId, sourceId);
      dedupeLinks();
      _rewriteParentEdges(kind, sourceId, targetId);
      deleteTopicEntity(sourceId);
      purgeIndexParentsFor(kind, sourceId);
      return { id: targetId };
    }
    case 'collection': {
      mergeCollectionInto(sourceId, targetId);
      _rewriteParentEdges(kind, sourceId, targetId);
      purgeIndexParentsFor(kind, sourceId);
      return { id: targetId };
    }
    case 'book': {
      mergeBookInto(sourceId, targetId);
      _rewriteParentEdges(kind, sourceId, targetId);
      purgeIndexParentsFor(kind, sourceId);
      return { id: targetId };
    }
    case 'artifact': {
      mergeArtifactInto(sourceId, targetId);
      _rewriteParentEdges(kind, sourceId, targetId);
      purgeIndexParentsFor(kind, sourceId);
      return { id: targetId };
    }
    case 'reference': {
      mergeReferenceInto(sourceId, targetId);
      _rewriteParentEdges(kind, sourceId, targetId);
      purgeIndexParentsFor(kind, sourceId);
      return { id: targetId };
    }
    case 'user_index': {
      mergeUserIndexInto(sourceId, targetId);
      _rewriteParentEdges(kind, sourceId, targetId);
      purgeIndexParentsFor(kind, sourceId);
      return { id: targetId };
    }
    case 'heading': {
      mergeHeadingInto(sourceId, targetId);
      _rewriteParentEdges(kind, sourceId, targetId);
      purgeIndexParentsFor(kind, sourceId);
      return { id: targetId };
    }
    default: throw new Error(`merge not supported for kind: ${kind}`);
  }
}

// Rewrite index_parents edges that mention (kind, sourceId) so they point at
// targetId, then drop duplicates. Used during merge.
function _rewriteParentEdges(kind, sourceId, targetId) {
  // Edges where source is a CHILD.
  db.prepare(`UPDATE OR IGNORE index_parents SET child_id = ? WHERE child_kind = ? AND child_id = ?`)
    .run(targetId, kind, sourceId);
  // Edges where source is a PARENT.
  db.prepare(`UPDATE OR IGNORE index_parents SET parent_id = ? WHERE parent_kind = ? AND parent_id = ?`)
    .run(targetId, kind, sourceId);
  // Remove any edge that would now be self-referential.
  db.prepare(`DELETE FROM index_parents WHERE child_kind = parent_kind AND child_id = parent_id`).run();
}

// Move references' links onto target, delete source. Symmetric with mergeArtifactInto.
function mergeReferenceInto(sourceId, targetId) {
  if (sourceId === targetId) throw new Error('source and target must differ');
  const source = db.prepare('SELECT id FROM reference_materials WHERE id = ?').get(sourceId);
  const target = db.prepare('SELECT id FROM reference_materials WHERE id = ?').get(targetId);
  if (!source || !target) throw new Error('reference not found');
  const tx = db.transaction(() => {
    db.prepare(`UPDATE links SET to_id = ? WHERE to_type='reference' AND to_id = ?`).run(targetId, sourceId);
    db.prepare(`UPDATE links SET from_id = ? WHERE from_type='reference' AND from_id = ?`).run(targetId, sourceId);
    dedupeLinks();
    db.prepare(`DELETE FROM reference_materials WHERE id = ?`).run(sourceId);
  });
  tx();
  return { source_id: sourceId, target_id: targetId };
}

// Move user_index entries, child-parent edges, and incoming page links onto the
// target, delete the source.
function mergeUserIndexInto(sourceId, targetId) {
  if (sourceId === targetId) throw new Error('source and target must differ');
  const source = db.prepare('SELECT id FROM user_indexes WHERE id = ?').get(sourceId);
  const target = db.prepare('SELECT id FROM user_indexes WHERE id = ?').get(targetId);
  if (!source || !target) throw new Error('user_index not found');
  const tx = db.transaction(() => {
    db.prepare(`UPDATE index_entries SET index_id = ? WHERE index_id = ?`).run(targetId, sourceId);
    db.prepare(`UPDATE links SET to_id = ? WHERE to_type='user_index' AND to_id = ?`).run(targetId, sourceId);
    dedupeLinks();
    db.prepare(`DELETE FROM user_indexes WHERE id = ?`).run(sourceId);
  });
  tx();
  return { source_id: sourceId, target_id: targetId };
}

// Unified archive toggle.
function archiveIndexRow(kind, id, archived) {
  const spec = _indexKindSpec(kind);
  if (!spec.archiveCol) throw new Error(`${kind} does not support archive`);
  const when = archived ? new Date().toISOString() : null;
  const kindFilter = spec.kindFilter ? `AND ${spec.kindFilter}` : '';
  db.prepare(`UPDATE ${spec.table} SET ${spec.archiveCol} = ? WHERE id = ? ${kindFilter}`).run(when, id);
  return { id, archived_at: when };
}

// Unified delete — dispatcher that also purges index_parents.
function deleteIndexRow(kind, id) {
  switch (kind) {
    case 'person':     deletePerson(id); break;
    case 'scripture':  deleteScriptureRef(id); break;
    case 'topic':      deleteTopicEntity(id); break;
    case 'collection': deleteCollection(id); break;
    case 'book':       deleteBook(id); break;
    case 'artifact':   deleteArtifact(id); break;
    case 'reference':
      // Existing deleteReference doesn't cascade links; do it here.
      db.prepare(`DELETE FROM links WHERE (to_type='reference' AND to_id = ?) OR (from_type='reference' AND from_id = ?)`).run(id, id);
      deleteReference(id);
      break;
    case 'user_index':
      db.prepare(`DELETE FROM links WHERE to_type='user_index' AND to_id = ?`).run(id);
      purgeUserIndexFilters(id);
      deleteUserIndex(id);
      break;
    case 'heading':
      deleteHeading(id);
      break;
    default: throw new Error(`delete not supported for kind: ${kind}`);
  }
  purgeIndexParentsFor(kind, id);
  return { id };
}

// Get the links-table role_summary for a given (fromType='page', fromId, toType=kind, toId).
// Returns null if absent. Used by the pages-context endpoint to lead tiles
// with the entity's ROLE on the page, not the page's overall summary.
function getRoleSummaryForLink(pageId, toType, toId) {
  const row = db.prepare(`
    SELECT role_summary FROM links
    WHERE from_type='page' AND from_id = ? AND to_type = ? AND to_id = ?
    ORDER BY (role_summary IS NULL) ASC, id ASC
    LIMIT 1
  `).get(pageId, toType, toId);
  return row && row.role_summary ? row.role_summary : null;
}

// --- AI-generated user_indexes (Phase 6) -------------------------------------
// An AI-generated root is a user_indexes row with is_ai_generated=1. Its
// "slots" are child user_indexes rows linked via index_parents. We create the
// root + children here; the classifier links pages in via plain links.
function createAIIndexTree({ title, description, structure }) {
  // `structure` shape: { root_description, children: [{label, description, children:[...]}] }
  const now = new Date().toISOString();
  const rootId = `ui_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO user_indexes (id, title, description, query, created_at,
      is_ai_generated, structure_description)
    VALUES (?, ?, ?, NULL, ?, 1, ?)
  `).run(rootId, title, structure.root_description || description, now, structure.root_description || description);

  let seq = 0;
  function insertChildren(parentId, nodes) {
    for (const node of nodes || []) {
      const id = `ui_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 4)}`;
      db.prepare(`
        INSERT INTO user_indexes (id, title, description, query, created_at,
          is_ai_generated, structure_description)
        VALUES (?, ?, ?, NULL, ?, 1, ?)
      `).run(id, node.label, node.description || null, now, node.description || null);
      db.prepare(`
        INSERT OR IGNORE INTO index_parents (id, child_kind, child_id, parent_kind, parent_id, created_at)
        VALUES (?, 'user_index', ?, 'user_index', ?, ?)
      `).run(`ip_${id}_${parentId}`, id, parentId, now);
      if (node.children && node.children.length) insertChildren(id, node.children);
    }
  }
  insertChildren(rootId, structure.children || []);
  return { id: rootId };
}

// Return every AI-index leaf (no children) with its description, for the
// classifier's candidate list. Leaves are where pages actually get linked.
function listAIIndexLeaves() {
  const allAI = db.prepare(`
    SELECT id, title, description, structure_description
    FROM user_indexes
    WHERE is_ai_generated = 1 AND archived_at IS NULL
  `).all();
  const leaves = [];
  for (const idx of allAI) {
    const hasChildren = db.prepare(`
      SELECT 1 FROM index_parents
      WHERE parent_kind = 'user_index' AND parent_id = ? LIMIT 1
    `).get(idx.id);
    if (!hasChildren) {
      // Include the path so the classifier knows the grandparent context.
      const parents = db.prepare(`
        WITH RECURSIVE ancestors(id, label, depth) AS (
          SELECT ui.id, ui.title, 0 FROM user_indexes ui WHERE ui.id = ?
          UNION ALL
          SELECT ui.id, ui.title, a.depth + 1
          FROM ancestors a
          JOIN index_parents ip ON ip.child_kind='user_index' AND ip.child_id = a.id
          JOIN user_indexes ui ON ui.id = ip.parent_id AND ip.parent_kind='user_index'
        )
        SELECT label FROM ancestors ORDER BY depth DESC
      `).all(idx.id).map(r => r.label);
      leaves.push({
        id: idx.id,
        label: idx.title,
        description: idx.description || idx.structure_description || '',
        path: parents.join(' / '),
      });
    }
  }
  return leaves;
}

function touchUserIndexClassifiedAt(id) {
  db.prepare(`UPDATE user_indexes SET last_classified_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

// Tighter cascade for re-parse: delete pages sharing a scan_path AND purge
// every index_entries row that pointed at those pages + any dangling links.
// Builds on the existing deletePagesByScanPath semantics.
function deletePagesByScanPathCascade(scanPath) {
  const pages = db.prepare(`SELECT id FROM pages WHERE scan_path = ?`).all(scanPath);
  if (!pages.length) return { deleted: 0 };
  const ids = pages.map(p => p.id);
  const placeholders = ids.map(() => '?').join(',');
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM index_entries WHERE page_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM links WHERE (from_type='page' AND from_id IN (${placeholders})) OR (to_type='page' AND to_id IN (${placeholders}))`)
      .run(...ids, ...ids);
    db.prepare(`DELETE FROM backlog_items WHERE context_page_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM items WHERE page_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM pages WHERE id IN (${placeholders})`).run(...ids);
  });
  tx();
  return { deleted: ids.length, ids };
}

// --- Pages linked to a user_index via the polymorphic links table ------------
// Used by /api/pages/context when ctx=index so classifier-created links surface
// alongside legacy index_entries rows.
function listPagesLinkedToIndex(userIndexId) {
  return db.prepare(`
    SELECT p.id, p.volume, p.page_number, p.summary, p.scan_path, p.captured_at
    FROM links l
    JOIN pages p ON p.id = l.from_id
    WHERE l.from_type='page' AND l.to_type='user_index' AND l.to_id = ?
    ORDER BY p.captured_at DESC
  `).all(userIndexId);
}

// --- Classification helpers --------------------------------------------------
// Write (or update) a page→user_index link with role_summary. Idempotent:
// if a link already exists, updates role_summary + confidence.
function upsertPageIndexLink({ pageId, userIndexId, confidence, roleSummary }) {
  const existing = db.prepare(`
    SELECT id FROM links
    WHERE from_type='page' AND from_id = ? AND to_type='user_index' AND to_id = ?
  `).get(pageId, userIndexId);
  if (existing) {
    db.prepare(`UPDATE links SET role_summary = COALESCE(?, role_summary), confidence = ? WHERE id = ?`)
      .run(roleSummary || null, confidence ?? 0.8, existing.id);
    return { id: existing.id, reused: true };
  }
  const id = require('crypto').randomUUID();
  db.prepare(`
    INSERT INTO links (id, from_type, from_id, to_type, to_id, created_by, confidence, role_summary)
    VALUES (?, 'page', ?, 'user_index', ?, 'classifier', ?, ?)
  `).run(id, pageId, userIndexId, confidence ?? 0.8, roleSummary || null);
  return { id, reused: false };
}

// All pages — used by the "reclassify all" button and by bootstrap sweeps.
function listAllPageIds() {
  return db.prepare(`SELECT id FROM pages ORDER BY captured_at DESC`).all().map(r => r.id);
}

// Produce a compact summary + items payload for the classifier — keeps the
// pointer-summary invariant (nothing from pages.raw_ocr_text).
function getPageClassifierPayload(pageId) {
  const page = db.prepare(`SELECT id, summary FROM pages WHERE id = ?`).get(pageId);
  if (!page) return null;
  const items = db.prepare(`SELECT kind, text FROM items WHERE page_id = ? LIMIT 40`).all(pageId);
  return { pageId: page.id, pageSummary: page.summary || '', items };
}

// --- Right-pane Home tab payload ---------------------------------------------
// Commitments grouped with their values, open rocks with supporting
// collections, collections flagged for review, recent captures. One round-trip.
function getHomePayload() {
  const commitmentRows = db.prepare(`
    SELECT c.*,
      (SELECT v.title FROM values_versions v WHERE v.slug = c.value_slug ORDER BY v.version DESC LIMIT 1) as value_label,
      (SELECT col.title FROM collections col WHERE col.id = c.collection_id) as linked_collection_title,
      (SELECT col.kind  FROM collections col WHERE col.id = c.collection_id) as linked_collection_kind
    FROM commitments c
    WHERE COALESCE(c.status, 'active') = 'active'
    ORDER BY
      CASE WHEN c.target_date IS NULL THEN 1 ELSE 0 END,
      c.target_date ASC,
      c.created_at DESC
  `).all();
  const commitments = commitmentRows.map(c => ({
    id: c.id, text: c.text,
    value_slug: c.value_slug || null,
    value_label: c.value_label || null,
    linked_collection: c.collection_id
      ? { id: c.collection_id, title: c.linked_collection_title, kind: c.linked_collection_kind }
      : null,
  }));

  const ws = _isoMondayOf(new Date());
  const allRocks = listRocks({ weekStart: ws }).filter(r => r.status !== 'done');
  // Batch-load rock→collection links (one query instead of one per rock)
  const rockCollMap = new Map();
  if (allRocks.length > 0) {
    const ph = allRocks.map(() => '?').join(',');
    for (const row of db.prepare(`
      SELECT l.from_id as rock_id, c.id, c.title FROM links l
      JOIN collections c ON c.id = l.to_id
      WHERE l.from_type='rock' AND l.to_type='collection' AND l.from_id IN (${ph})
    `).all(...allRocks.map(r => r.id))) {
      if (!rockCollMap.has(row.rock_id)) rockCollMap.set(row.rock_id, { id: row.id, title: row.title });
    }
  }
  const openRocks = allRocks.map(r => ({
    id: r.id, title: r.title, status: r.status, role_label: r.role_label || null,
    linked_collection: rockCollMap.get(r.id) || null,
  }));

  const reviewCollections = db.prepare(`
    SELECT id, title, kind FROM collections
    WHERE kind='topical' AND archived_at IS NULL
    ORDER BY created_at DESC
    LIMIT 10
  `).all();

  const recentCaptures = db.prepare(`
    SELECT id, volume, page_number, scan_path, summary, captured_at, source_kind
    FROM pages
    ORDER BY captured_at DESC
    LIMIT 10
  `).all();

  return {
    commitments,
    active_rocks: openRocks,
    review_collections: reviewCollections,
    recent_captures: recentCaptures,
  };
}

module.exports = {
  insertPage, getPage, getRecentPages, applyThreadingForPage, findPageByVolumeAndNumber,
  findPendingPageRefProposals,
  removePageLinksByType, removePageLinkToTarget, removePageUserIndexLink,
  insertItems, searchItems, getAllItems, getItemsCapturedOn,
  resolveMentionTarget, getItemsLinkedToEntity, getPageTranscript,
  upsertEntity, getEntityByKindLabel,
  deletePerson, deleteScriptureRef, deleteTopicEntity,
  listEntitiesByKind, getOrCreateEntity, deleteRoleOrArea, listCollectionEntities,
  updateEntity, linkRoleToArea, unlinkRoleFromArea, listRolesWithAreas, listAreasWithRoles,
  moveEntityPriority,
  updateCollection, updatePage,
  insertLink,
  insertBacklogItems, getPendingBacklog, updateBacklogStatus, getBacklogItem,
  getRecentAnsweredQuestions,
  upsertGlossaryTerm, getGlossary, isTermInGlossary,
  extractGlossaryEntryFromBacklog, syncGlossaryFromBacklog,
  findCollection, createCollection, linkPageToCollection,
  getCollectionsForPage, getRecentPagesForContext,
  upsertScriptureRef, linkPageToScripture, getScriptureIndex,
  upsertPerson, linkPageToPerson, getPeopleIndex, listPeople, updatePerson,
  reclassifyPersonAsTopic,
  getTopicsIndex, updateTopicLabel, setTopicParent,
  createBook, updateBook, deleteBook, mergeBookInto, getBook, listBooks, listBooksGroupedByAuthor, getBooksIndex, linkPageToBook, unlinkPageFromBook,
  currentValues, getValueHistory, createValue, appendValueVersion,
  listCommitments, createCommitment, updateCommitment, deleteCommitment, listCommitmentsTimeline,
  listArtifacts, createArtifact, updateArtifact, addArtifactVersion,
  listReferences, createReference, deleteReference,
  updateReferenceContent, updateArtifactContent, updateArtifactUrl, updateReferenceUrl,
  setArtifactArchived, setReferenceArchived, setReferenceRowType,
  deleteArtifact, mergeArtifactInto,
  saveGoogleTokens, getGoogleTokens, clearGoogleTokens,
  getGoogleDriveConfig, setGoogleDriveConfig, getDrivePageToken, saveDrivePageToken,
  upsertGoogleCapture, listPendingGoogleCaptures, getGoogleCapture,
  dismissGoogleCapture, acceptGoogleCapture,
  linkBetween, deleteLinkById, listLinkedCollections, listLinkedUserIndexes,
  listCollectionsGrouped, getCollectionDetail, listDailyLogs, augmentPage,
  findDailyLogByDate, createDailyLog, getDailyLog, getDailyLogDetail,
  updateDailyLog, linkPageToDailyLog, listDailyLogsFlat, listMonthSpine,
  archiveCollection, unarchiveCollection, deleteCollection, updateCollectionKind,
  getPageDetail, getRelatedPages, updatePageSummary, replaceTopicOnPage,
  setPageRotation, rotatePage,
  listUserIndexes, createUserIndex, updateUserIndex, deleteUserIndex,
  getUserIndexDetail, addIndexEntry, deleteIndexEntry,
  recordIngestFailure, listIngestFailures, getIngestFailure,
  markIngestFailureResolved, deleteIngestFailure,
  renameCollection, mergeCollectionInto, findCollectionDuplicateCandidates,
  setCollectionParent,
  updateCollectionSummary, updateScriptureLabel, softDeletePage, deletePagesByScanPath,
  getRememberFeed, searchAll,
  getUnifiedIndex, renameOrMergeEntity, mergeEntitiesInto, setEntityArchived,
  getArtifact, getArtifactDetail, getReference,
  markPageAsReference, listReferenceScans, listReferenceLabels,
  findPeopleByFirstName, personRecencyMap,
  addPersonAlias, findPagesMentioningAlias, getKnownAliases, getHandwritingCorrections,
  listHouseholds, createHousehold, updateHousehold, deleteHousehold,
  setPersonHousehold, getHouseholdDetail,
  getHouseholdMentions, findHouseholdByMention, linkPageToHousehold, upsertHouseholdByName,
  getMonthlySummary, setMonthlySummary,
  // Phase 4.5 — chat assistant
  listChatSessions, getChatSession, createChatSession, touchChatSession, deleteChatSession,
  appendChatMessage, getChatMessage, setChatMessageStatus,
  listChatMemory, setChatMemory, deleteChatMemory,
  // Phase 4 — Planning hub
  listRocks, createRock, updateRock, deleteRock,
  listHabits, createHabit, updateHabit, deleteHabit,
  setHabitCheck, getHabitChecks, getHabitStreaks,
  getCurrentMission, setMission,
  getPlanningHub,
  // Phase 6 — any-to-any index tree + unified dispatchers
  ALL_INDEX_KINDS, lookupIndexRow,
  setIndexParent, removeIndexParent, getIndexParents, getIndexChildren,
  purgeIndexParentsFor, listIndexTree, getIndexNodeConnections,
  renameIndexRow, mergeIndexRows, archiveIndexRow, deleteIndexRow,
  renameBook, renameArtifact, renameReference, renameUserIndex,
  mergeReferenceInto, mergeUserIndexInto,
  getRoleSummaryForLink, convertEntityKind,
  createAIIndexTree, listAIIndexLeaves, touchUserIndexClassifiedAt,
  deletePagesByScanPathCascade,
  getHomePayload,
  listPagesLinkedToIndex, upsertPageIndexLink, listAllPageIds, getPageClassifierPayload,
  getPageByLocation, deduplicatePages,
  // Indexing sharpen — headings (TOC), noise filter, cross-kind auto-link
  createHeading, listHeadings, renameHeading, mergeHeadingInto, deleteHeading,
  listUserIndexExclusions, listUserIndexInclusions,
  addUserIndexExclusion, removeUserIndexExclusion,
  addUserIndexInclusion, removeUserIndexInclusion,
  purgeUserIndexFilters, purgeAutoUserIndexExclusions,
  getCrossKindContent, refreshContentHash, markLinksClassified, listCrossKindCandidates,
  // Markdown drafts
  createMarkdownDraft, listMarkdownDrafts, getMarkdownDraft, updateMarkdownDraft, deleteMarkdownDraft,
};

// ─── Markdown drafts ────────────────────────────────────────────────────────
function createMarkdownDraft({ id, content = '', date }) {
  db.prepare(`INSERT INTO markdown_drafts(id, content, date, created_at) VALUES (?, ?, ?, datetime('now'))`).run(id, content, date);
  return db.prepare('SELECT * FROM markdown_drafts WHERE id = ?').get(id);
}

function listMarkdownDrafts() {
  return db.prepare('SELECT * FROM markdown_drafts ORDER BY created_at DESC').all();
}

function getMarkdownDraft(id) {
  return db.prepare('SELECT * FROM markdown_drafts WHERE id = ?').get(id);
}

function updateMarkdownDraft(id, { content, date }) {
  const draft = db.prepare('SELECT * FROM markdown_drafts WHERE id = ?').get(id);
  if (!draft) return null;
  const newContent = content !== undefined ? content : draft.content;
  const newDate = date !== undefined ? date : draft.date;
  db.prepare('UPDATE markdown_drafts SET content = ?, date = ? WHERE id = ?').run(newContent, newDate, id);
  return db.prepare('SELECT * FROM markdown_drafts WHERE id = ?').get(id);
}

function deleteMarkdownDraft(id) {
  db.prepare('DELETE FROM markdown_drafts WHERE id = ?').run(id);
}
