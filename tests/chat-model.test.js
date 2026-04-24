'use strict';

const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(__dirname, '../data/test-chat-model.db');
process.env.TEST_DB_PATH = TEST_DB;
process.env.GEMINI_API_KEY = '';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

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

async function post(p, body) {
  const res = await fetch(baseUrl + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

describe('POST /api/chat/select-model', () => {
  test('whitelist exposes expected Gemini variants', () => {
    assert.ok(ai.SUPPORTED_CHAT_MODELS.includes('gemini-2.5-flash'));
    assert.ok(ai.SUPPORTED_CHAT_MODELS.includes('gemini-2.5-pro'));
    assert.ok(!ai.SUPPORTED_CHAT_MODELS.includes('claude-sonnet'));
  });

  test('resolveChatModel falls back to default when unknown', () => {
    assert.equal(ai.resolveChatModel('made-up-model'), ai.DEFAULT_CHAT_MODEL);
    assert.equal(ai.resolveChatModel('gemini-2.5-pro'), 'gemini-2.5-pro');
    assert.equal(ai.resolveChatModel(null), ai.DEFAULT_CHAT_MODEL);
  });

  test('round-trip: persists selection to chat_sessions.model', async () => {
    const s = db.createChatSession({ id: 'sess-roundtrip', title: 'x' });
    assert.ok(s);
    const { status, body } = await post('/api/chat/select-model', {
      session_id: s.id, model: 'gemini-2.5-pro',
    });
    assert.equal(status, 200);
    assert.equal(body.model, 'gemini-2.5-pro');
    assert.equal(db.getChatSessionModel(s.id), 'gemini-2.5-pro');
  });

  test('invalid model → 400 with supported list', async () => {
    const s = db.createChatSession({ id: 'sess-invalid', title: 'y' });
    const { status, body } = await post('/api/chat/select-model', {
      session_id: s.id, model: 'gpt-99',
    });
    assert.equal(status, 400);
    assert.ok(Array.isArray(body.supported));
    assert.ok(body.supported.length >= 2);
  });

  test('passing null resets to default (session.model stays null)', async () => {
    const s = db.createChatSession({ id: 'sess-reset', title: 'z' });
    await post('/api/chat/select-model', { session_id: s.id, model: 'gemini-2.5-pro' });
    assert.equal(db.getChatSessionModel(s.id), 'gemini-2.5-pro');
    const { status, body } = await post('/api/chat/select-model', {
      session_id: s.id, model: null,
    });
    assert.equal(status, 200);
    assert.equal(body.model, null);
    assert.equal(db.getChatSessionModel(s.id), null);
  });

  test('missing session_id → 400', async () => {
    const { status } = await post('/api/chat/select-model', { model: 'gemini-2.5-pro' });
    assert.equal(status, 400);
  });

  test('unknown session_id → 404', async () => {
    const { status } = await post('/api/chat/select-model', {
      session_id: 'does-not-exist', model: 'gemini-2.5-pro',
    });
    assert.equal(status, 404);
  });
});
