#!/usr/bin/env node
// Backfill embeddings for every ingested row that's missing one.
//
// Usage:
//   node scripts/backfill-embeddings.mjs              # all kinds
//   node scripts/backfill-embeddings.mjs pages        # one kind
//   node scripts/backfill-embeddings.mjs --dry        # count what would run
//
// Batch size = 100; 200ms pause between batches. Safe to run multiple times —
// rows that already have an embedding are skipped via the vec_map lookup.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Load .env before db.js.
const fs = require('node:fs');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

const db = require(path.join(__dirname, '..', 'db.js'));
const { embed } = require(path.join(__dirname, '..', 'ai.js'));

const BATCH = 100;
const PAUSE_MS = 200;

const ALL_KINDS = ['pages', 'collections', 'people', 'scripture_refs', 'books', 'artifacts', 'topics'];

function buildText(kind, row) {
  if (kind === 'pages') {
    return [row.summary || '', row.raw_ocr_text || ''].filter(Boolean).join('\n\n').trim();
  }
  return [row.label || '', row.text || ''].filter(Boolean).join(' — ').trim();
}

// Returns true if this row already has an embedding in vec_map.
function hasEmbedding(kind, id) {
  const handle = db.handle();
  const row = handle.prepare('SELECT 1 FROM vec_map WHERE kind=? AND entity_id=?').get(kind, String(id));
  return !!row;
}

async function backfillKind(kind, { dryRun = false } = {}) {
  const handle = db.handle();
  if (!db.vecReady()) {
    console.log(`[backfill] vec not loaded — skipping ${kind}`);
    return { processed: 0, skipped: 0 };
  }
  let afterId = null;
  let processed = 0;
  let skipped = 0;
  while (true) {
    const rows = kind === 'pages'
      ? db.listPagesForBackfill(afterId, BATCH)
      : db.listEntitiesForBackfill(kind, afterId, BATCH);
    if (!rows.length) break;
    for (const row of rows) {
      if (hasEmbedding(kind, row.id)) { skipped++; continue; }
      const text = buildText(kind, row);
      if (!text) { skipped++; continue; }
      if (dryRun) {
        processed++;
      } else {
        try {
          const v = await embed(text);
          db.vecSet(kind, row.id, v);
          processed++;
        } catch (e) {
          console.error(`[backfill] ${kind}/${row.id} failed:`, e.message);
        }
      }
    }
    afterId = rows[rows.length - 1].id;
    if (rows.length < BATCH) break;
    await new Promise(r => setTimeout(r, PAUSE_MS));
  }
  console.log(`[backfill] ${kind}: processed=${processed} skipped=${skipped}`);
  return { processed, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  const kinds = args.filter(a => !a.startsWith('--'));
  const targets = kinds.length ? kinds : ALL_KINDS;
  const totals = { processed: 0, skipped: 0 };
  for (const k of targets) {
    if (!ALL_KINDS.includes(k)) { console.error(`unknown kind: ${k}`); process.exit(2); }
    const r = await backfillKind(k, { dryRun });
    totals.processed += r.processed;
    totals.skipped += r.skipped;
  }
  console.log(`[backfill] total processed=${totals.processed} skipped=${totals.skipped} (dry=${dryRun})`);
}

main().catch(e => { console.error(e); process.exit(1); });
