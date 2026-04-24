'use strict';

// Must run before db.js so SQLite opens a tmp DB.
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(__dirname, '../data/test-log.db');
process.env.TEST_DB_PATH = TEST_DB;

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const log = require('../log');
const app = require('../server');

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

describe('log module', () => {
  test('ring buffer is bounded at 1000 entries', () => {
    log.clear();
    for (let i = 0; i < 1500; i++) log('debug', 'stress', { i });
    assert.equal(log.size(), 1000);
    const all = log.recent({ limit: 1000 });
    assert.equal(all.length, 1000);
    // Oldest kept entry should be #500 (first 500 evicted).
    assert.equal(all[0].ctx.i, 500);
    assert.equal(all[all.length - 1].ctx.i, 1499);
  });

  test('level filter keeps only warn+error when level=warn', () => {
    log.clear();
    log('debug', 'd');
    log('info', 'i');
    log('warn', 'w');
    log('error', 'e');
    const filtered = log.recent({ level: 'warn' });
    assert.deepEqual(filtered.map(e => e.level).sort(), ['error', 'warn']);
  });

  test('since filter drops older entries', async () => {
    log.clear();
    log('info', 'before');
    await new Promise(r => setTimeout(r, 10));
    const cutoff = new Date().toISOString();
    await new Promise(r => setTimeout(r, 10));
    log('info', 'after');
    const filtered = log.recent({ since: cutoff });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].event, 'after');
  });

  test('trace_id, request_id, duration_ms are hoisted to top-level', () => {
    log.clear();
    log('info', 'x', { trace_id: 't1', request_id: 'r1', duration_ms: 42, other: 'y' });
    const [entry] = log.recent();
    assert.equal(entry.trace_id, 't1');
    assert.equal(entry.request_id, 'r1');
    assert.equal(entry.duration_ms, 42);
    assert.equal(entry.ctx.other, 'y');
    assert.ok(!('trace_id' in entry.ctx));
  });
});

describe('HTTP middleware', () => {
  test('logs every request with http event and echoes X-Trace-Id', async () => {
    log.clear();
    const res = await fetch(baseUrl + '/api/health', {
      headers: { 'X-Trace-Id': 'test-trace-abc12345' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-trace-id'), 'test-trace-abc12345');
    // Give the finish handler a tick.
    await new Promise(r => setTimeout(r, 10));
    const entries = log.recent({ limit: 50 });
    const httpEntry = entries.find(e => e.event === 'http' && e.ctx.path === '/api/health');
    assert.ok(httpEntry, 'expected http event for /api/health');
    assert.equal(httpEntry.ctx.method, 'GET');
    assert.equal(httpEntry.ctx.status, 200);
    assert.equal(httpEntry.trace_id, 'test-trace-abc12345');
    assert.equal(typeof httpEntry.duration_ms, 'number');
    assert.equal(httpEntry.level, 'info');
  });

  test('generates a trace id when header is absent', async () => {
    const res = await fetch(baseUrl + '/api/health');
    const traceId = res.headers.get('x-trace-id');
    assert.ok(traceId && traceId.length >= 8, 'expected generated trace id');
  });
});

describe('GET /api/logs/recent', () => {
  const KEY = 'test-logs-key';
  let prev;
  before(() => { prev = process.env.SUITE_API_KEY; process.env.SUITE_API_KEY = KEY; });
  after(() => {
    if (prev === undefined) delete process.env.SUITE_API_KEY;
    else process.env.SUITE_API_KEY = prev;
  });

  test('requires bearer', async () => {
    const res = await fetch(baseUrl + '/api/logs/recent');
    assert.equal(res.status, 401);
  });

  test('returns entries when authed', async () => {
    log.clear();
    log('info', 'unit_test_marker', { a: 1 });
    const res = await fetch(baseUrl + '/api/logs/recent', {
      headers: { Authorization: `Bearer ${KEY}` }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.app, 'gloss');
    assert.ok(Array.isArray(body.entries));
    const marker = body.entries.find(e => e.event === 'unit_test_marker');
    assert.ok(marker, 'expected marker event in response');
    assert.equal(marker.ctx.a, 1);
  });

  test('level filter is honored', async () => {
    log.clear();
    log('debug', 'noisy');
    log('error', 'boom');
    const res = await fetch(baseUrl + '/api/logs/recent?level=error', {
      headers: { Authorization: `Bearer ${KEY}` }
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    for (const entry of body.entries) {
      assert.ok(['error'].includes(entry.level), `unexpected level: ${entry.level}`);
    }
    assert.ok(body.entries.some(e => e.event === 'boom'));
  });
});
