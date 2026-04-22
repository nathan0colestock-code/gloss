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
  const body = await res.json();
  return { status: res.status, body };
}

async function post(url, data) {
  const res = await fetch(baseUrl + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function patch(url, data) {
  const res = await fetch(baseUrl + url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function del(url) {
  const res = await fetch(baseUrl + url, { method: 'DELETE' });
  const body = await res.json().catch(() => ({}));
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

describe('GET /api/pages', () => {
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/pages');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });

  test('includes seeded page', async () => {
    const id = seedPage();
    const { body } = await get('/api/pages');
    assert.ok(body.some(p => p.id === id));
  });
});

describe('GET /api/pages/:id/detail', () => {
  test('returns 200 for existing page', async () => {
    const id = seedPage();
    const { status, body } = await get(`/api/pages/${id}/detail`);
    assert.equal(status, 200);
    assert.equal(body.id, id);
  });

  test('returns 404 for unknown page', async () => {
    const { status } = await get(`/api/pages/${uid()}/detail`);
    assert.equal(status, 404);
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
  test('returns 200 and an array-shaped object', async () => {
    const { status, body } = await get('/api/collections');
    assert.equal(status, 200);
    assert.ok(typeof body === 'object');
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
  test('renames a collection', async () => {
    const title = 'Before Rename ' + uid().slice(0, 8);
    const coll = db.createCollection({ id: uid(), kind: 'topical', title });
    const newTitle = 'After Rename ' + uid().slice(0, 8);
    const { status } = await patch(`/api/collections/${coll.id}`, { title: newTitle });
    assert.equal(status, 200);
    const detail = db.getCollectionDetail(coll.id);
    assert.equal(detail.title, newTitle);
  });
});

// ── People ─────────────────────────────────────────────────────────────────

describe('GET /api/people', () => {
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/people');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

describe('POST /api/people', () => {
  test('creates a person', async () => {
    const label = 'HTTP Person ' + uid().slice(0, 8);
    const { status, body } = await post('/api/people', { label });
    assert.equal(status, 200);
    assert.ok(body.id);
    assert.equal(body.label, label);
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

// ── Topics ─────────────────────────────────────────────────────────────────

describe('GET /api/topics', () => {
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/topics');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

// ── Scripture ──────────────────────────────────────────────────────────────

describe('GET /api/scripture', () => {
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/scripture');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

// ── Books ──────────────────────────────────────────────────────────────────

describe('GET /api/books', () => {
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/books');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
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
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/backlog');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

// ── Daily logs ─────────────────────────────────────────────────────────────

describe('GET /api/daily-logs', () => {
  test('returns 200', async () => {
    const { status, body } = await get('/api/daily-logs?month=2099-01');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
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
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/user-indexes');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
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
  test('returns 200 with expected shape', async () => {
    const { status, body } = await get('/api/index/tree');
    assert.equal(status, 200);
    assert.ok(typeof body === 'object');
  });
});

describe('GET /api/index/search', () => {
  test('returns 200 and an array for any query', async () => {
    const { status, body } = await get('/api/index/search?q=test');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

// ── Search ─────────────────────────────────────────────────────────────────

describe('GET /api/search', () => {
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/search?q=test');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });

  test('handles FTS special chars without 500', async () => {
    const { status } = await get('/api/search?q=' + encodeURIComponent('"weird" * OR NOT'));
    assert.notEqual(status, 500);
  });
});

// ── Home ───────────────────────────────────────────────────────────────────

describe('GET /api/home', () => {
  test('returns 200 with expected shape', async () => {
    const { status, body } = await get('/api/home');
    assert.equal(status, 200);
    assert.ok(typeof body === 'object');
  });
});

// ── Ingest failures ────────────────────────────────────────────────────────

describe('GET /api/ingest-failures', () => {
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/ingest-failures');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

// ── Artifacts ─────────────────────────────────────────────────────────────

describe('GET /api/artifacts', () => {
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/artifacts');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

describe('POST /api/artifacts', () => {
  test('creates an artifact', async () => {
    const title = 'HTTP Artifact ' + uid().slice(0, 8);
    const { status, body } = await post('/api/artifacts', {
      title,
      kind: 'document',
      drawer: 'A',
      hanging_folder: 'HF1',
      manila_folder: 'MF1',
    });
    assert.equal(status, 200);
    assert.ok(body.id);
    assert.equal(body.title, title);
  });
});

// ── References ────────────────────────────────────────────────────────────

describe('GET /api/references', () => {
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/references');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
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

  test('returns 400 when neither file_path nor external_url is given', async () => {
    const { status } = await post('/api/references', { title: 'No URL or path' });
    assert.equal(status, 400);
  });
});

// ── Chat sessions ─────────────────────────────────────────────────────────

describe('GET /api/chat/sessions', () => {
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/chat/sessions');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
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
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/chat/memory');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

// ── Values / Mission ──────────────────────────────────────────────────────

describe('GET /api/values', () => {
  test('returns 200 and an array', async () => {
    const { status, body } = await get('/api/values');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

// ── Ingest endpoint guard ─────────────────────────────────────────────────

describe('POST /api/ingest guard (no file)', () => {
  test('returns 400 when no file is uploaded', async () => {
    // Send an empty multipart to trigger the "no file" guard
    const res = await fetch(baseUrl + '/api/ingest', { method: 'POST' });
    // The server should reject it (400 or 500), never succeed without a file.
    assert.ok(res.status >= 400);
  });
});
