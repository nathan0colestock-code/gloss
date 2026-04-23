'use strict';

// Regression tests for the P0 fixes:
//   #2: extractPersonNameFromSubject must strip ASCII quotes, not just smart.
//   #3: savePageFromParse must roll back the entire page on any sub-step throw.

const path = require('path');
const TEST_DB = path.join(__dirname, '../data/test-p0-fixes.db');
process.env.TEST_DB_PATH = TEST_DB;

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const app = require('../server');
const db = require('../db');
const { extractPersonNameFromSubject, savePageFromParse } = app.__test;

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch {}
  }
});

describe('extractPersonNameFromSubject — ASCII quote handling', () => {
  test('strips ASCII double-quotes: `Who is "Baz"?` → `Baz`', () => {
    // ai.js prompt (ai.js:216) mandates the exact shape `Who is "[name]"?`
    // with ASCII double-quotes. Before the fix the quotes leaked into the
    // captured name, and addPersonAlias persisted `"Baz"` as an alias —
    // \b-bounded regex could never match it.
    assert.equal(extractPersonNameFromSubject('Who is "Baz"?'), 'Baz');
  });

  test('still handles smart quotes: `Who is \u201cBaz\u201d?` → `Baz`', () => {
    assert.equal(extractPersonNameFromSubject('Who is \u201cBaz\u201d?'), 'Baz');
  });

  test('ASCII single-quote: `Who is \'Baz\'?` → `Baz`', () => {
    assert.equal(extractPersonNameFromSubject(`Who is 'Baz'?`), 'Baz');
  });

  test('no quotes at all still works', () => {
    assert.equal(extractPersonNameFromSubject('Who is Baz?'), 'Baz');
  });
});

describe('savePageFromParse — transactional rollback', () => {
  test('throws from upsertScriptureRef roll back the entire page save', () => {
    // Monkeypatch db.upsertScriptureRef to throw so we can observe rollback.
    const originalUpsert = db.upsertScriptureRef;
    db.upsertScriptureRef = () => { throw new Error('malformed scripture ref'); };
    try {
      const parsed = {
        page_number: 99999,
        volume: 'P0_TEST_VOLUME',
        raw_ocr_text: 'test',
        summary: 'test page for transaction rollback',
        items: [{ kind: 'note', text: 'orphaned item if rollback fails' }],
        entities: [{
          kind: 'scripture',
          label: 'Rom 1:1',
          book: 'Romans',
          chapter: 1,
          verse_start: 1,
        }],
        collection_hints: [],
        book_hints: [],
        artifact_hints: [],
        reference_hints: [],
        backlog_items: [],
        page_refs: [],
      };
      assert.throws(
        () => savePageFromParse(parsed, 'scans/_test_tx.jpg', 0, 1),
        /malformed scripture ref/
      );
      // No page row should exist for the unique (volume, page_number) pair.
      const row = db.handle()
        .prepare('SELECT id FROM pages WHERE volume = ? AND page_number = ?')
        .get('P0_TEST_VOLUME', 99999);
      assert.equal(row, undefined, 'pages row must be rolled back when a sub-step throws');
    } finally {
      db.upsertScriptureRef = originalUpsert;
    }
  });
});
