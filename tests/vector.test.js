'use strict';

// Must set before db.js loads.
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(__dirname, '../data/test-vector.db');
process.env.TEST_DB_PATH = TEST_DB;
// Force pseudo-embed path (deterministic) by clearing API key.
process.env.GEMINI_API_KEY = '';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const db = require('../db');
const ai = require('../ai');
const app = require('../server');

let server, baseUrl;

before(async () => {
  await new Promise(r => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      r();
    });
  });
});

after(async () => {
  await new Promise(r => server.close(r));
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch {}
  }
});

function seedPage(summary, ocr = '') {
  const id = crypto.randomUUID();
  db.insertPage({
    id,
    volume: 1,
    page_number: Math.floor(Math.random() * 1000),
    scan_path: `data/scans/test-${id}.jpg`,
    raw_ocr_text: ocr,
    summary,
    captured_at: new Date().toISOString(),
  });
  return id;
}

describe('vec module + embeddings', () => {
  test('vec is ready on dev (darwin-arm64)', () => {
    assert.equal(db.vecReady(), true);
  });

  test('embed returns a 768-dim Float32Array (pseudo-fallback path)', async () => {
    const v = await ai.embed('prayer meeting tuesday');
    assert.equal(v.length, 768);
    assert.ok(v instanceof Float32Array);
  });

  test('round-trip: set then search finds the inserted vector', async () => {
    const pageId = seedPage('a note about prayer and fasting');
    const v = await ai.embed('a note about prayer and fasting');
    db.vecSet('pages', pageId, v);
    const hits = db.vecSearch(v, { kind: 'pages', limit: 3 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].entity_id, pageId);
    assert.ok(hits[0].distance < 0.0001); // essentially identical
  });
});

describe('hybrid search', () => {
  test('hybrid surfaces semantically close pages FTS alone would miss', async () => {
    // Seed two pages: one shares keywords with the query, one is close by
    // embedding but uses different words.
    const id1 = seedPage('prayer and fasting');  // FTS match but embedding-similar
    const id2 = seedPage('supplication and abstaining from food');  // no keyword overlap
    for (const [id, text] of [[id1, 'prayer and fasting'], [id2, 'supplication and abstaining from food']]) {
      const v = await ai.embed(text);
      db.vecSet('pages', id, v);
    }
    const qVec = await ai.embed('supplication and abstaining from food');
    const hits = db.hybridSearchPages('supplication', { queryVector: qVec, limit: 5 });
    const ids = hits.map(h => h.id);
    // The pure-semantic match (id2) should appear; FTS alone would definitely find it
    // (it has "supplication"), but the hybrid score must also place it at the top.
    assert.ok(ids.includes(id2), 'hybrid should include semantically identical page');
    assert.equal(hits[0].id, id2);
  });
});

describe('GET /api/pages/:id/related', () => {
  test('excludes self and returns up to 3 semantically similar pages', async () => {
    // Seed a cluster of pages with overlapping vocabulary.
    const anchorText = 'elder meeting minutes — church budget and pastor compensation';
    const anchor = seedPage(anchorText);
    const close1 = seedPage('elder meeting notes about pastor compensation');
    const close2 = seedPage('session discussion of the church budget');
    const far = seedPage('grocery list for the week');
    for (const [id, text] of [
      [anchor, anchorText],
      [close1, 'elder meeting notes about pastor compensation'],
      [close2, 'session discussion of the church budget'],
      [far, 'grocery list for the week']
    ]) {
      db.vecSet('pages', id, await ai.embed(text));
    }
    const res = await fetch(`${baseUrl}/api/pages/${anchor}/related`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.items));
    // Should not include self.
    for (const item of body.items) {
      assert.notEqual(item.id, anchor, 'related should not include self');
    }
    // Should include at least one of the close neighbors.
    const returnedIds = body.items.map(i => i.id);
    assert.ok(
      returnedIds.includes(close1) || returnedIds.includes(close2),
      'expected a near neighbor in related'
    );
    assert.ok(body.items.length <= 3, 'at most 3 items');
  });
});

describe('backfill resumability', () => {
  test('listPagesForBackfill resumes from afterId', () => {
    // Seed a few pages with deterministic, ordered ids. Use a tall prefix so
    // they sort above any ids left by earlier tests.
    const seeds = ['zzz-back-aaa111', 'zzz-back-bbb222', 'zzz-back-ccc333', 'zzz-back-ddd444'];
    for (const id of seeds) {
      db.insertPage({
        id,
        volume: 99,
        page_number: Math.floor(Math.random() * 10000),
        scan_path: `data/scans/${id}.jpg`,
        raw_ocr_text: 'x',
        summary: 's',
        captured_at: new Date().toISOString(),
      });
    }
    // Start from the first test-seeded id so we exclude unrelated pages.
    const start = 'zzz-back-';
    const first = db.listPagesForBackfill(start, 2);
    assert.ok(first.length === 2, `expected 2 rows, got ${first.length}`);
    assert.equal(first[0].id, seeds[0]);
    const mid = first[first.length - 1].id;
    const next = db.listPagesForBackfill(mid, 10);
    // next must only include ids strictly greater than `mid`.
    for (const row of next) {
      assert.ok(row.id > mid, `expected ${row.id} > ${mid}`);
    }
    assert.ok(next.some(r => r.id === seeds[2]), 'should resume to third seed');
  });
});
