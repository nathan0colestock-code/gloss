'use strict';

// Contract tests for comms.js buildContactsPayload. The receiving side
// (comms/collect.js:upsertGlossContact and comms/public/index.html) expects:
//   - recent_context:    [{ date, role_summary, collection }]
//   - linked_collections: [string]                              (titles)
// This test pins that contract with a seeded Gloss DB.

const path = require('path');
const TEST_DB = path.join(__dirname, '../data/test-comms.db');
process.env.TEST_DB_PATH = TEST_DB;

const { test, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');

const db = require('../db');
const comms = require('../comms');

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch {}
  }
});

describe('comms.buildContactsPayload', () => {
  test('skips people with priority < 1', () => {
    const noPrio = db.upsertPerson({ label: 'No Priority ' + crypto.randomUUID().slice(0, 6) });
    const payload = comms.buildContactsPayload();
    assert.ok(!payload.some(p => p.contact === noPrio.label),
      'unpromoted person should not be pushed');
  });

  test('priority ≥ 1 person produces the full payload contract', () => {
    const person = db.upsertPerson({ label: 'Push Me ' + crypto.randomUUID().slice(0, 6) });
    db.updatePerson(person.id, { priority: 2, growth_note: 'Check in monthly' });
    db.addPersonAlias(person.id, 'Pushy');

    // Seed a page and link it to the person so recent_context has data.
    const pageId = crypto.randomUUID();
    db.insertPage({
      id: pageId,
      volume: 1,
      page_number: 42,
      scan_path: `scans/${pageId}.png`,
      captured_at: '2026-04-20T12:00:00.000Z',
      summary: 'page summary',
      source_kind: 'scan',
    });
    db.linkPageToPerson(pageId, person.id, 1.0, 'mentioned in passing');

    // Seed a topical collection and link it to the person.
    const collId = crypto.randomUUID();
    const coll = db.createCollection({
      id: collId,
      kind: 'topical',
      title: 'Weekly Rhythms ' + crypto.randomUUID().slice(0, 6),
    });
    db.linkBetween({
      from_type: 'collection', from_id: coll.id,
      to_type: 'person', to_id: person.id,
    });

    const payload = comms.buildContactsPayload();
    const mine = payload.find(p => p.contact === person.label);
    assert.ok(mine, 'pushed person should appear in payload');

    // Core fields
    assert.equal(typeof mine.gloss_id, 'string');
    assert.match(mine.gloss_url, /\/#\/index\/person\//);
    assert.equal(mine.priority, 2);
    assert.equal(mine.growth_note, 'Check in monthly');
    assert.deepEqual(mine.aliases, ['Pushy']);

    // recent_context: objects, not strings
    assert.ok(Array.isArray(mine.recent_context));
    assert.ok(mine.recent_context.length >= 1);
    const ctx = mine.recent_context[0];
    assert.ok(Object.prototype.hasOwnProperty.call(ctx, 'date'),
      'recent_context entry must have a date key');
    assert.ok(Object.prototype.hasOwnProperty.call(ctx, 'role_summary'),
      'recent_context entry must have a role_summary key');
    assert.ok(Object.prototype.hasOwnProperty.call(ctx, 'collection'),
      'recent_context entry must have a collection key');
    assert.equal(typeof ctx.role_summary, 'string');

    // linked_collections: strings
    assert.ok(Array.isArray(mine.linked_collections));
    for (const c of mine.linked_collections) {
      assert.equal(typeof c, 'string',
        'linked_collections entries must be plain strings (titles)');
    }
    assert.ok(mine.linked_collections.includes(coll.title));
  });
});
