'use strict';

// Vector search module for Gloss.
//
// Wraps a single `vec_entries` virtual table (vec0) plus a `vec_map` lookup
// that translates between Gloss's TEXT entity ids and the INTEGER rowid
// required by sqlite-vec. Exposes:
//
//   vec.ready              — true iff the extension loaded successfully
//   vec.ensure(db)         — idempotent: load extension, create tables
//   vec.set(kind, id, vec) — upsert an embedding (vector = Float32Array|number[])
//   vec.remove(kind, id)   — delete one embedding
//   vec.search(vec, opts)  — { kind?, limit=10, excludeId? } → [{ kind, entity_id, distance }]
//   vec.count(kind?)       — row count, for tests/backfill status
//
// If sqlite-vec cannot load (arch mismatch, missing binary), every mutating
// call becomes a no-op and `search()` returns []. Callers must NOT depend on
// vector search being present — FTS remains the baseline.

let sqliteVec = null;
try {
  sqliteVec = require('sqlite-vec');
} catch (e) {
  sqliteVec = null;
}

const EMBED_DIM = 768; // text-embedding-004 output dimension
let ready = false;
let db = null;

function ensure(database) {
  db = database;
  if (!sqliteVec) return false;
  if (ready) return true;
  try {
    sqliteVec.load(db);
  } catch (e) {
    // Some runtimes disable db.loadExtension for safety; log once and degrade.
    try { process.stderr.write(JSON.stringify({
      ts: new Date().toISOString(), app: 'gloss', level: 'warn',
      event: 'vec_load_failed', ctx: { error: String(e.message || e) }
    }) + '\n'); } catch {}
    return false;
  }
  // vec0 virtual table. Cosine distance; 768-float embedding. The `entity_id`
  // metadata column is INTEGER (sqlite-vec requirement) and matches the rowid
  // of `vec_map` below.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
      entity_ref INTEGER,
      kind TEXT,
      embedding float[${EMBED_DIM}] distance_metric=cosine
    );
    CREATE TABLE IF NOT EXISTS vec_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      UNIQUE(kind, entity_id)
    );
    CREATE INDEX IF NOT EXISTS vec_map_kind_id ON vec_map(kind, entity_id);
  `);
  ready = true;
  return true;
}

function toFloat32Buffer(vec) {
  if (!vec) throw new Error('vector required');
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  if (f32.length !== EMBED_DIM) {
    throw new Error(`vector dim ${f32.length} != expected ${EMBED_DIM}`);
  }
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function getOrCreateRef(kind, entityId) {
  const existing = db.prepare('SELECT id FROM vec_map WHERE kind=? AND entity_id=?').get(kind, String(entityId));
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO vec_map(kind, entity_id) VALUES (?, ?)').run(kind, String(entityId));
  return Number(info.lastInsertRowid);
}

function set(kind, entityId, vec) {
  if (!ready) return false;
  const buf = toFloat32Buffer(vec);
  const ref = getOrCreateRef(kind, entityId);
  // Remove any prior row for this ref then insert the new one. sqlite-vec
  // doesn't support direct updates on metadata in the same call, so we
  // delete-then-insert within a transaction for correctness.
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM vec_entries WHERE rowid=?').run(BigInt(ref));
    db.prepare('INSERT INTO vec_entries(rowid, entity_ref, kind, embedding) VALUES (?, ?, ?, ?)')
      .run(BigInt(ref), BigInt(ref), kind, buf);
  });
  txn();
  return true;
}

function remove(kind, entityId) {
  if (!ready) return false;
  const row = db.prepare('SELECT id FROM vec_map WHERE kind=? AND entity_id=?').get(kind, String(entityId));
  if (!row) return false;
  db.prepare('DELETE FROM vec_entries WHERE rowid=?').run(BigInt(row.id));
  db.prepare('DELETE FROM vec_map WHERE id=?').run(row.id);
  return true;
}

function search(vec, { kind = null, limit = 10, excludeEntityId = null } = {}) {
  if (!ready) return [];
  const buf = toFloat32Buffer(vec);
  // sqlite-vec requires `MATCH` + `k=` on the query. Post-filter kind and
  // exclusion because vec0 supports a narrow set of WHERE clauses.
  const rows = db.prepare(`
    SELECT v.rowid as ref, v.entity_ref as entity_ref, v.kind as kind, v.distance as distance,
           m.entity_id as entity_id
    FROM vec_entries v
    JOIN vec_map m ON m.id = v.rowid
    WHERE v.embedding MATCH ? AND k=?
    ORDER BY v.distance
  `).all(buf, Math.max(limit * 4, limit + 5));
  const out = [];
  for (const r of rows) {
    if (kind && r.kind !== kind) continue;
    if (excludeEntityId && r.entity_id === String(excludeEntityId)) continue;
    out.push({ kind: r.kind, entity_id: r.entity_id, distance: r.distance });
    if (out.length >= limit) break;
  }
  return out;
}

function count(kind = null) {
  if (!ready) return 0;
  if (kind) {
    const r = db.prepare('SELECT COUNT(*) AS n FROM vec_map WHERE kind=?').get(kind);
    return r?.n || 0;
  }
  const r = db.prepare('SELECT COUNT(*) AS n FROM vec_map').get();
  return r?.n || 0;
}

function isReady() { return ready; }

module.exports = {
  ensure,
  set,
  remove,
  search,
  count,
  get ready() { return ready; },
  isReady,
  EMBED_DIM,
};
