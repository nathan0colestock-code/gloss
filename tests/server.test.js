'use strict';

// Must be set before db.js (and therefore server.js) is required.
const path = require('path');
const TEST_DB = path.join(__dirname, '../data/test-server.db');
process.env.TEST_DB_PATH = TEST_DB;

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

const app = require('../server');
const db = require('../db');

// ── test server ─────────────────────────────────────────────────────────────

let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch {}
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

async function get(url) {
  const res = await fetch(baseUrl + url);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function post(url, data) {
  const res = await fetch(baseUrl + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function patch(url, data) {
  const res = await fetch(baseUrl + url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

function uid() { return crypto.randomUUID(); }

function seedPage(overrides = {}) {
  const id = uid();
  db.insertPage({
    id,
    volume: 1,
    page_number: Math.floor(Math.random() * 9000) + 1,
    scan_path: `scans/${id}.png`,
    captured_at: new Date().toISOString(),
    summary: 'Seeded page summary',
    source_kind: 'scan',
    ...overrides,
  });
  return id;
}

// ── Pages ──────────────────────────────────────────────────────────────────

describe('GET /api/pages/:id/detail', () => {
  test('returns 200 and page id nested under body.page', async () => {
    const id = seedPage();
    const { status, body } = await get(`/api/pages/${id}/detail`);
    assert.equal(status, 200);
    assert.equal(body.page.id, id);
  });

  test('returns 404 for unknown page', async () => {
    const { status } = await get(`/api/pages/${uid()}/detail`);
    assert.equal(status, 404);
  });
});

// ── Status endpoint ────────────────────────────────────────────────────────

describe('GET /api/status', () => {
  test('rejects without auth', async () => {
    const { status } = await get('/api/status');
    assert.equal(status, 401);
  });

  test('accepts Bearer with API_KEY', async () => {
    const prev = process.env.API_KEY;
    process.env.API_KEY = 'test-api-key-status';
    try {
      const res = await fetch(baseUrl + '/api/status', {
        headers: { 'Authorization': 'Bearer test-api-key-status' },
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.app, 'gloss');
      assert.equal(body.ok, true);
      assert.ok(typeof body.version === 'string');
      assert.ok(typeof body.uptime_seconds === 'number');
      assert.ok(body.metrics);
      for (const k of ['total_pages', 'total_people', 'total_collections', 'pending_backlog']) {
        assert.ok(k in body.metrics, `metrics.${k} missing`);
        assert.equal(typeof body.metrics[k], 'number');
      }
    } finally {
      if (prev === undefined) delete process.env.API_KEY;
      else process.env.API_KEY = prev;
    }
  });

  test('accepts Bearer with SUITE_API_KEY', async () => {
    const prev = process.env.SUITE_API_KEY;
    process.env.SUITE_API_KEY = 'test-suite-key-status';
    try {
      const res = await fetch(baseUrl + '/api/status', {
        headers: { 'Authorization': 'Bearer test-suite-key-status' },
      });
      assert.equal(res.status, 200);
    } finally {
      if (prev === undefined) delete process.env.SUITE_API_KEY;
      else process.env.SUITE_API_KEY = prev;
    }
  });

  test('rejects wrong Bearer token', async () => {
    const prev = process.env.API_KEY;
    process.env.API_KEY = 'real-key';
    try {
      const res = await fetch(baseUrl + '/api/status', {
        headers: { 'Authorization': 'Bearer wrong-key' },
      });
      assert.equal(res.status, 401);
    } finally {
      if (prev === undefined) delete process.env.API_KEY;
      else process.env.API_KEY = prev;
    }
  });
});

describe('PATCH /api/pages/:id', () => {
  test('updates page summary', async () => {
    const id = seedPage();
    const { status } = await patch(`/api/pages/${id}`, { summary: 'HTTP-updated summary' });
    assert.equal(status, 200);
    const page = db.getPage(id);
    assert.equal(page.summary, 'HTTP-updated summary');
  });
});

// ── Collections ────────────────────────────────────────────────────────────

describe('GET /api/collections', () => {
  test('returns 200 with groups shape', async () => {
    const { status, body } = await get('/api/collections');
    assert.equal(status, 200);
    assert.ok('groups' in body);
  });
});

describe('POST /api/collections', () => {
  test('creates a new collection', async () => {
    const title = 'HTTP Collection ' + uid().slice(0, 8);
    const { status, body } = await post('/api/collections', { kind: 'topical', title });
    assert.equal(status, 200);
    assert.ok(body.id);
    assert.equal(body.title, title);
  });

  test('returns 400 when title is missing', async () => {
    const { status } = await post('/api/collections', { kind: 'topical' });
    assert.equal(status, 400);
  });
});

describe('PATCH /api/collections/:id', () => {
  test('renames a collection via HTTP', async () => {
    const title = 'Before Rename ' + uid().slice(0, 8);
    const coll = db.createCollection({ id: uid(), kind: 'topical', title });
    const newTitle = 'After Rename ' + uid().slice(0, 8);
    const { status } = await patch(`/api/collections/${coll.id}`, { title: newTitle });
    assert.equal(status, 200);
    const detail = db.getCollectionDetail(coll.id);
    assert.equal(detail.collection.title, newTitle);
  });
});

// ── People ─────────────────────────────────────────────────────────────────

describe('GET /api/people', () => {
  test('returns 200 with items array', async () => {
    const { status, body } = await get('/api/people');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
  });
});

describe('PATCH /api/people/:id', () => {
  test('updates person label', async () => {
    const label = 'Old HTTP Person ' + uid().slice(0, 8);
    const person = db.upsertPerson({ label });
    const newLabel = 'New HTTP Person ' + uid().slice(0, 8);
    const { status } = await patch(`/api/people/${person.id}`, { label: newLabel });
    assert.equal(status, 200);
    const people = db.listPeople();
    assert.ok(people.some(p => p.label === newLabel));
  });
});

// ── Topics + Scripture (via /api/indexes) ──────────────────────────────────

describe('GET /api/indexes/topics', () => {
  test('returns 200 with entries array', async () => {
    const { status, body } = await get('/api/indexes/topics');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.entries));
  });
});

describe('GET /api/indexes/scripture', () => {
  test('returns 200 with entries array', async () => {
    const { status, body } = await get('/api/indexes/scripture');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.entries));
  });
});

// ── Books ──────────────────────────────────────────────────────────────────

describe('GET /api/books', () => {
  test('returns 200 with items array', async () => {
    const { status, body } = await get('/api/books');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
  });
});

describe('POST /api/books', () => {
  test('creates a book', async () => {
    const title = 'HTTP Book ' + uid().slice(0, 8);
    const { status, body } = await post('/api/books', { title, author_label: 'HTTP Author' });
    assert.equal(status, 200);
    assert.ok(body.id);
    assert.equal(body.title, title);
  });

  test('returns 400 when title is missing', async () => {
    const { status } = await post('/api/books', { author_label: 'No Title' });
    assert.equal(status, 400);
  });
});

// ── Backlog ────────────────────────────────────────────────────────────────

describe('GET /api/backlog', () => {
  test('returns 200 with items array', async () => {
    const { status, body } = await get('/api/backlog');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
  });
});

// ── Daily logs ─────────────────────────────────────────────────────────────

describe('GET /api/daily-logs', () => {
  test('returns 200 with months object', async () => {
    const { status, body } = await get('/api/daily-logs');
    assert.equal(status, 200);
    assert.ok('months' in body);
  });
});

// ── Planning hub ───────────────────────────────────────────────────────────

describe('GET /api/planning', () => {
  test('returns 200 with expected shape', async () => {
    const { status, body } = await get('/api/planning');
    assert.equal(status, 200);
    assert.ok('week_start' in body);
    assert.ok('rocks' in body);
    assert.ok('habits' in body);
    assert.ok('commitments' in body);
  });
});

describe('POST /api/rocks', () => {
  test('creates a rock for the current week', async () => {
    const title = 'HTTP Rock ' + uid().slice(0, 8);
    const { status, body } = await post('/api/rocks', { title });
    assert.equal(status, 200);
    assert.ok(body.id);
    assert.equal(body.title, title);
  });
});

describe('POST /api/habits', () => {
  test('creates a habit', async () => {
    const label = 'HTTP Habit ' + uid().slice(0, 8);
    const { status, body } = await post('/api/habits', { label });
    assert.equal(status, 200);
    assert.ok(body.id);
  });
});

// ── Commitments ────────────────────────────────────────────────────────────

describe('POST /api/commitments', () => {
  test('creates a commitment', async () => {
    const text = 'HTTP Commitment ' + uid().slice(0, 8);
    const { status, body } = await post('/api/commitments', { text });
    assert.equal(status, 200);
    assert.ok(body.id);
  });
});

// ── User indexes ───────────────────────────────────────────────────────────

describe('GET /api/user-indexes', () => {
  test('returns 200 with items array', async () => {
    const { status, body } = await get('/api/user-indexes');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
  });
});

describe('POST /api/user-indexes', () => {
  test('creates a user index', async () => {
    const title = 'HTTP Index ' + uid().slice(0, 8);
    const { status, body } = await post('/api/user-indexes', { title });
    assert.equal(status, 200);
    assert.ok(body.id);
    assert.equal(body.title, title);
  });
});

// ── Unified index tree ─────────────────────────────────────────────────────

describe('GET /api/index/tree', () => {
  test('returns 200 and an object', async () => {
    const { status, body } = await get('/api/index/tree');
    assert.equal(status, 200);
    assert.ok(typeof body === 'object');
  });
});

describe('GET /api/index/search', () => {
  test('returns 200 with results array', async () => {
    const { status, body } = await get('/api/index/search?q=test');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.results));
  });
});

// ── Search ─────────────────────────────────────────────────────────────────

describe('GET /api/search', () => {
  test('returns 200 and expected shape', async () => {
    const { status, body } = await get('/api/search?q=test');
    assert.equal(status, 200);
    assert.ok(typeof body === 'object');
  });

  test('handles FTS special chars without 500', async () => {
    const { status } = await get('/api/search?q=' + encodeURIComponent('"weird" * OR NOT'));
    assert.notEqual(status, 500);
  });

  test('returns empty shape for blank query', async () => {
    const { status, body } = await get('/api/search?q=');
    assert.equal(status, 200);
    assert.ok('pages' in body);
  });
});

// ── Home ───────────────────────────────────────────────────────────────────

describe('GET /api/home', () => {
  test('returns 200 and an object', async () => {
    const { status, body } = await get('/api/home');
    assert.equal(status, 200);
    assert.ok(typeof body === 'object');
  });
});

// ── Ingest failures ────────────────────────────────────────────────────────

describe('GET /api/ingest-failures', () => {
  test('returns 200 with items array', async () => {
    const { status, body } = await get('/api/ingest-failures');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
  });
});

// ── Artifacts ─────────────────────────────────────────────────────────────

describe('GET /api/artifacts', () => {
  test('returns 200 with items array', async () => {
    const { status, body } = await get('/api/artifacts');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
  });
});

describe('POST /api/artifacts', () => {
  test('creates an artifact', async () => {
    const title = 'HTTP Artifact ' + uid().slice(0, 8);
    const { status, body } = await post('/api/artifacts', { title, drawer: 'A' });
    assert.equal(status, 200);
    assert.ok(body.id);
    assert.equal(body.title, title);
  });

  test('returns 400 when title is missing', async () => {
    const { status } = await post('/api/artifacts', { drawer: 'A' });
    assert.equal(status, 400);
  });
});

// ── References ────────────────────────────────────────────────────────────

describe('GET /api/references', () => {
  test('returns 200 with items array', async () => {
    const { status, body } = await get('/api/references');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
  });
});

describe('POST /api/references', () => {
  test('creates a reference with an external URL', async () => {
    const title = 'HTTP Reference ' + uid().slice(0, 8);
    const { status, body } = await post('/api/references', {
      title,
      external_url: 'https://example.com/article',
    });
    assert.equal(status, 200);
    assert.ok(body.id);
  });

  test('returns 400 when neither file nor external_url nor source is given', async () => {
    const { status } = await post('/api/references', { title: 'No URL or path' });
    assert.equal(status, 400);
  });
});

// ── Chat sessions ─────────────────────────────────────────────────────────

describe('GET /api/chat/sessions', () => {
  test('returns 200 with items array', async () => {
    const { status, body } = await get('/api/chat/sessions');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
  });
});

describe('POST /api/chat/sessions', () => {
  test('creates a chat session', async () => {
    const { status, body } = await post('/api/chat/sessions', {});
    assert.equal(status, 200);
    assert.ok(body.id);
  });
});

// ── Chat memory ───────────────────────────────────────────────────────────

describe('GET /api/chat/memory', () => {
  test('returns 200 with items array', async () => {
    const { status, body } = await get('/api/chat/memory');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
  });
});

// ── Values / Mission ──────────────────────────────────────────────────────

describe('GET /api/values', () => {
  test('returns 200 with items array', async () => {
    const { status, body } = await get('/api/values');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
  });
});

// ── Ingest endpoint guard ─────────────────────────────────────────────────

describe('POST /api/ingest guard (no file)', () => {
  test('returns non-2xx when no file is uploaded', async () => {
    const res = await fetch(baseUrl + '/api/ingest', { method: 'POST' });
    assert.ok(res.status >= 400, `expected 4xx/5xx but got ${res.status}`);
  });
});

// ── Comms push health ─────────────────────────────────────────────────────

describe('GET /api/comms/status', () => {
  test('returns enabled flag and last-outcome fields', async () => {
    const { status, body } = await get('/api/comms/status');
    assert.equal(status, 200);
    assert.equal(typeof body.enabled, 'boolean');
    // these four fields are always present (null when never run)
    assert.ok('last_attempted_at' in body);
    assert.ok('last_success_at' in body);
    assert.ok('last_error' in body);
    assert.ok('last_outcome' in body);
  });
});
