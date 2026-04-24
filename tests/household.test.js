'use strict';

const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(__dirname, '../data/test-household.db');
process.env.TEST_DB_PATH = TEST_DB;
process.env.GEMINI_API_KEY = '';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const db = require('../db');
const { __test } = require('../server');

before(() => {});

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch {}
  }
});

function seedPage() {
  const id = crypto.randomUUID();
  db.insertPage({
    id,
    volume: 1,
    page_number: Math.floor(Math.random() * 10000),
    scan_path: `data/scans/${id}.jpg`,
    raw_ocr_text: '',
    summary: 'page',
    captured_at: new Date().toISOString(),
  });
  return id;
}

describe('upsertHousehold helper', () => {
  test('is exposed on server test hooks', () => {
    assert.ok(__test && typeof __test.upsertHousehold === 'function', 'helper must be exported via __test');
  });

  test('creates a household on first mention', () => {
    const h = __test.upsertHousehold('Smiths');
    assert.ok(h);
    assert.equal(h.name, 'Smiths');
  });

  test('returns the same household on second mention (upsert)', () => {
    const a = __test.upsertHousehold('Jones Family');
    const b = __test.upsertHousehold('Jones Family');
    assert.equal(a.id, b.id);
  });

  test('links to a page when pageId supplied', () => {
    const pageId = seedPage();
    const h = __test.upsertHousehold('Fletchers', { pageId, roleSummary: 'visit' });
    assert.ok(h);
    const mentions = db.getHouseholdMentions(h.id);
    const ids = (mentions || []).map(m => m.page_id || m.id);
    assert.ok(ids.includes(pageId), 'page should be linked to household');
  });

  test('no-ops on empty mention', () => {
    const h = __test.upsertHousehold('   ');
    assert.equal(h, null);
    const h2 = __test.upsertHousehold(null);
    assert.equal(h2, null);
  });
});
