'use strict';

// Must be set before db.js is required — db.js opens the file on require().
const path = require('path');
const TEST_DB = path.join(__dirname, '../data/test-db.db');
process.env.TEST_DB_PATH = TEST_DB;

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');

const db = require('../db');

// ── helpers ────────────────────────────────────────────────────────────────

function uid() { return crypto.randomUUID(); }

function makePage(overrides = {}) {
  const id = uid();
  return {
    id,
    volume: 1,
    page_number: Math.floor(Math.random() * 9000) + 1,
    scan_path: `scans/${id}.png`,
    captured_at: new Date().toISOString(),
    summary: 'Test page summary',
    source_kind: 'scan',
    ...overrides,
  };
}

// ── teardown ───────────────────────────────────────────────────────────────

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch {}
  }
});

// ── Pages ──────────────────────────────────────────────────────────────────

describe('Pages', () => {
  test('insert and retrieve a page', () => {
    const p = makePage();
    db.insertPage(p);
    const got = db.getPage(p.id);
    assert.equal(got.id, p.id);
    assert.equal(got.volume, 1);
    assert.equal(got.summary, 'Test page summary');
  });

  test('getPage returns undefined for unknown id', () => {
    const got = db.getPage('nonexistent-' + uid());
    assert.equal(got, undefined);
  });

  test('updatePageSummary persists new summary', () => {
    const p = makePage({ summary: 'original' });
    db.insertPage(p);
    db.updatePageSummary(p.id, 'updated summary');
    const got = db.getPage(p.id);
    assert.equal(got.summary, 'updated summary');
  });

  test('updatePage persists volume and page_number changes', () => {
    const p = makePage();
    db.insertPage(p);
    db.updatePage(p.id, { volume: 2, page_number: 99 });
    const got = db.getPage(p.id);
    assert.equal(got.volume, 2);
    assert.equal(got.page_number, 99);
  });

  test('getRecentPages returns inserted pages', () => {
    const p = makePage();
    db.insertPage(p);
    const recents = db.getRecentPages(50);
    assert.ok(recents.some(r => r.id === p.id));
  });

  test('deletePagesByScanPath removes all pages sharing that scan_path', () => {
    const scanPath = `scans/spread-${uid()}.png`;
    const p1 = makePage({ scan_path: scanPath });
    const p2 = makePage({ scan_path: scanPath });
    db.insertPage(p1);
    db.insertPage(p2);
    db.deletePagesByScanPath(scanPath);
    assert.equal(db.getPage(p1.id), undefined);
    assert.equal(db.getPage(p2.id), undefined);
  });
});

// ── Items + FTS ────────────────────────────────────────────────────────────

describe('Items and FTS search', () => {
  test('insertItems and searchItems basic match', () => {
    const p = makePage();
    db.insertPage(p);
    const term = 'xyzuniquetermxyz' + uid().slice(0, 8);
    db.insertItems([{ id: uid(), page_id: p.id, kind: 'task', text: `pointer to ${term}`, confidence: 1.0 }]);
    const results = db.searchItems(term);
    assert.ok(results.length > 0);
    assert.ok(results.some(r => r.page_id === p.id));
  });

  test('searchItems strips FTS meta-chars without throwing', () => {
    assert.doesNotThrow(() => db.searchItems('"weird" * query OR NOT foo'));
  });

  test('searchItems returns empty array for no match', () => {
    const results = db.searchItems('zzznomatchzzzterm' + uid());
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 0);
  });
});

// ── People ─────────────────────────────────────────────────────────────────

describe('People', () => {
  test('upsertPerson creates a new person', () => {
    const label = 'Test Person ' + uid().slice(0, 8);
    const person = db.upsertPerson({ label });
    assert.ok(person.id);
    assert.equal(person.label, label);
  });

  test('upsertPerson is idempotent — same label returns same row', () => {
    const label = 'Idempotent Person ' + uid().slice(0, 8);
    const a = db.upsertPerson({ label });
    const b = db.upsertPerson({ label });
    assert.equal(a.id, b.id);
  });

  test('updatePerson persists new label', () => {
    const label = 'Original ' + uid().slice(0, 8);
    const person = db.upsertPerson({ label });
    const newLabel = 'Renamed ' + uid().slice(0, 8);
    db.updatePerson(person.id, { label: newLabel });
    const people = db.listPeople();
    assert.ok(people.some(p => p.label === newLabel));
  });

  test('addPersonAlias stores alias without duplicating', () => {
    const label = 'Alias Person ' + uid().slice(0, 8);
    const person = db.upsertPerson({ label });
    db.addPersonAlias(person.id, 'nick');
    db.addPersonAlias(person.id, 'nick'); // idempotent call
    // getKnownAliases returns { canonical, aliases[] } per person
    const aliases = db.getKnownAliases();
    const entry = aliases.find(a => a.canonical === label);
    assert.ok(entry, 'person should appear in alias list after addPersonAlias');
    assert.equal(entry.aliases.filter(n => n === 'nick').length, 1);
  });

  test('deletePerson removes the row', () => {
    const label = 'Delete Me ' + uid().slice(0, 8);
    const person = db.upsertPerson({ label });
    db.deletePerson(person.id);
    const people = db.listPeople();
    assert.ok(!people.some(p => p.id === person.id));
  });

  test('linkPageToPerson creates a link retrievable via getPeopleIndex', () => {
    const p = makePage();
    db.insertPage(p);
    const label = 'Linked Person ' + uid().slice(0, 8);
    const person = db.upsertPerson({ label });
    db.linkPageToPerson(p.id, person.id, 1.0, 'mentioned in test');
    const index = db.getPeopleIndex();
    const entry = index.find(e => e.id === person.id);
    assert.ok(entry);
    assert.ok(entry.mention_count >= 1);
  });
});

// ── Scripture refs ─────────────────────────────────────────────────────────

describe('Scripture refs', () => {
  test('upsertScriptureRef creates a new ref', () => {
    const ref = db.upsertScriptureRef({ canonical: 'John 3:16', book: 'John', chapter: 3, verse_start: 16, verse_end: 16 });
    assert.ok(ref.id);
    assert.equal(ref.canonical, 'John 3:16');
  });

  test('upsertScriptureRef is idempotent', () => {
    const a = db.upsertScriptureRef({ canonical: 'Psalm 23:1', book: 'Psalm', chapter: 23, verse_start: 1, verse_end: 1 });
    const b = db.upsertScriptureRef({ canonical: 'Psalm 23:1', book: 'Psalm', chapter: 23, verse_start: 1, verse_end: 1 });
    assert.equal(a.id, b.id);
  });

  test('linkPageToScripture shows in scripture index', () => {
    const p = makePage();
    db.insertPage(p);
    const ref = db.upsertScriptureRef({ canonical: 'Genesis 1:1', book: 'Genesis', chapter: 1, verse_start: 1, verse_end: 1 });
    db.linkPageToScripture(p.id, ref.id, 1.0, 'creation account referenced');
    const index = db.getScriptureIndex();
    const entry = index.find(e => e.id === ref.id);
    assert.ok(entry);
    assert.ok(entry.mention_count >= 1);
  });
});

// ── Collections ────────────────────────────────────────────────────────────

describe('Collections', () => {
  test('createCollection creates a topical collection', () => {
    const title = 'Test Collection ' + uid().slice(0, 8);
    const coll = db.createCollection({ id: uid(), kind: 'topical', title });
    assert.ok(coll.id);
    assert.equal(coll.title, title);
    assert.equal(coll.kind, 'topical');
  });

  test('createCollection is idempotent by kind+title', () => {
    const title = 'Deduped Collection ' + uid().slice(0, 8);
    const a = db.createCollection({ id: uid(), kind: 'topical', title });
    const b = db.createCollection({ id: uid(), kind: 'topical', title });
    assert.equal(a.id, b.id);
  });

  test('linkPageToCollection links page to collection', () => {
    const p = makePage();
    db.insertPage(p);
    const title = 'Linked Coll ' + uid().slice(0, 8);
    const coll = db.createCollection({ id: uid(), kind: 'topical', title });
    db.linkPageToCollection(p.id, coll.id);
    const colls = db.getCollectionsForPage(p.id);
    assert.ok(colls.some(c => c.id === coll.id));
  });

  test('renameCollection changes the title', () => {
    const title = 'Pre-Rename ' + uid().slice(0, 8);
    const coll = db.createCollection({ id: uid(), kind: 'topical', title });
    const newTitle = 'Post-Rename ' + uid().slice(0, 8);
    db.renameCollection(coll.id, newTitle);
    // getCollectionDetail returns { collection, pages, ... }
    const detail = db.getCollectionDetail(coll.id);
    assert.ok(detail);
    assert.equal(detail.collection.title, newTitle);
  });

  test('archiveCollection hides from active list', () => {
    const title = 'Archive Me ' + uid().slice(0, 8);
    const coll = db.createCollection({ id: uid(), kind: 'topical', title });
    db.archiveCollection(coll.id);
    // listCollectionsGrouped only returns non-archived by default
    const groups = db.listCollectionsGrouped();
    const all = Object.values(groups).flat();
    assert.ok(!all.some(c => c.id === coll.id));
  });

  test('deleteCollection removes it', () => {
    const title = 'Delete Coll ' + uid().slice(0, 8);
    const coll = db.createCollection({ id: uid(), kind: 'topical', title });
    db.deleteCollection(coll.id);
    const detail = db.getCollectionDetail(coll.id);
    assert.ok(!detail);
  });
});

// ── polymorphic links table ────────────────────────────────────────────────

describe('Links (polymorphic)', () => {
  test('linkBetween creates a link', () => {
    const p = makePage();
    db.insertPage(p);
    const title = 'Link Target ' + uid().slice(0, 8);
    const coll = db.createCollection({ id: uid(), kind: 'topical', title });
    db.linkBetween({ from_type: 'page', from_id: p.id, to_type: 'collection', to_id: coll.id });
    const colls = db.getCollectionsForPage(p.id);
    assert.ok(colls.some(c => c.id === coll.id));
  });

  test('deleteLinkById removes the link', () => {
    const p = makePage();
    db.insertPage(p);
    const title = 'Del Link Coll ' + uid().slice(0, 8);
    const coll = db.createCollection({ id: uid(), kind: 'topical', title });
    const linkId = db.linkBetween({ from_type: 'page', from_id: p.id, to_type: 'collection', to_id: coll.id });
    db.deleteLinkById(linkId);
    const colls = db.getCollectionsForPage(p.id);
    assert.ok(!colls.some(c => c.id === coll.id));
  });
});

// ── Backlog items ──────────────────────────────────────────────────────────

describe('Backlog items', () => {
  test('insertBacklogItems and getPendingBacklog round-trip', () => {
    const p = makePage();
    db.insertPage(p);
    const subject = 'Who is "unknown-' + uid().slice(0, 8) + '"?';
    db.insertBacklogItems([{
      id: uid(),
      context_page_id: p.id,
      kind: 'question',
      subject,
      proposal: subject,
      confidence: 0.4,
    }]);
    const pending = db.getPendingBacklog();
    assert.ok(pending.some(b => b.subject === subject));
  });

  test('updateBacklogStatus marks item answered', () => {
    const p = makePage();
    db.insertPage(p);
    const id = uid();
    const subject = 'Who is "mark-answered-' + uid().slice(0, 8) + '"?';
    db.insertBacklogItems([{ id, context_page_id: p.id, kind: 'question', subject, proposal: subject, confidence: 0.3 }]);
    db.updateBacklogStatus(id, 'answered', 'Jake Thompson');
    const item = db.getBacklogItem(id);
    assert.equal(item.status, 'answered');
    assert.equal(item.answer, 'Jake Thompson');
  });

  test('insertBacklogItems dedupes on identical pending subject', () => {
    const p = makePage();
    db.insertPage(p);
    const subject = 'Who is "dedup-' + uid().slice(0, 8) + '"?';
    const item = { context_page_id: p.id, kind: 'question', subject, proposal: subject, confidence: 0.4 };
    db.insertBacklogItems([{ id: uid(), ...item }]);
    db.insertBacklogItems([{ id: uid(), ...item }]);
    const pending = db.getPendingBacklog();
    const matches = pending.filter(b => b.subject === subject);
    assert.equal(matches.length, 1);
  });
});

// ── Books ──────────────────────────────────────────────────────────────────

describe('Books', () => {
  test('createBook and getBook round-trip', () => {
    const id = uid();
    const title = 'Test Book ' + uid().slice(0, 8);
    db.createBook({ id, title, author_label: 'Test Author', year: '2024' });
    const book = db.getBook(id);
    assert.equal(book.title, title);
    assert.equal(book.author_label, 'Test Author');
  });

  test('listBooks includes created book', () => {
    const id = uid();
    const title = 'Listed Book ' + uid().slice(0, 8);
    db.createBook({ id, title, author_label: 'Author X' });
    const books = db.listBooks();
    assert.ok(books.some(b => b.id === id));
  });

  test('deleteBook removes the book', () => {
    const id = uid();
    const title = 'Deleted Book ' + uid().slice(0, 8);
    db.createBook({ id, title });
    db.deleteBook(id);
    assert.ok(!db.getBook(id)); // returns null when not found
  });

  test('mergeBookInto re-points page links and removes source', () => {
    const p = makePage();
    db.insertPage(p);
    const srcId = uid();
    const tgtId = uid();
    db.createBook({ id: srcId, title: 'Source Book ' + uid().slice(0, 8) });
    db.createBook({ id: tgtId, title: 'Target Book ' + uid().slice(0, 8) });
    db.linkPageToBook(p.id, srcId);
    db.mergeBookInto(srcId, tgtId);
    assert.ok(!db.getBook(srcId)); // returns null when not found
    assert.ok(db.getBook(tgtId));
  });
});

// ── Daily logs ─────────────────────────────────────────────────────────────

describe('Daily logs', () => {
  test('createDailyLog and findDailyLogByDate round-trip', () => {
    const day = Math.floor(Math.random() * 28) + 1;
    const date = `2099-03-${String(day).padStart(2, '0')}`;
    const id = uid();
    db.createDailyLog({ id, date, summary: 'test day' });
    const found = db.findDailyLogByDate(date);
    assert.ok(found);
    assert.equal(found.date, date);
    assert.equal(found.summary, 'test day');
  });

  test('createDailyLog is idempotent by date', () => {
    const date = '2099-04-01';
    db.createDailyLog({ id: uid(), date, summary: 'first' });
    // ON CONFLICT — should not throw or create a duplicate
    assert.doesNotThrow(() => db.createDailyLog({ id: uid(), date, summary: 'second' }));
    const result = db.findDailyLogByDate(date);
    assert.ok(result);
  });

  test('listDailyLogs returns an array (one entry per active month)', () => {
    const result = db.listDailyLogs();
    // Returns [] when no active months, or an array of month objects
    assert.ok(Array.isArray(result));
  });
});

// ── Topics / Entities ──────────────────────────────────────────────────────

describe('Topics (entities)', () => {
  test('upsertEntity creates a topic', () => {
    const label = 'Test Topic ' + uid().slice(0, 8);
    const entity = db.upsertEntity({ id: uid(), kind: 'topic', label });
    assert.ok(entity.id);
    assert.equal(entity.kind, 'topic');
    assert.equal(entity.label, label);
  });

  test('upsertEntity is idempotent by kind+label', () => {
    const label = 'Dedup Topic ' + uid().slice(0, 8);
    const a = db.upsertEntity({ id: uid(), kind: 'topic', label });
    const b = db.upsertEntity({ id: uid(), kind: 'topic', label });
    assert.equal(a.id, b.id);
  });

  test('getEntityByKindLabel retrieves by label', () => {
    const label = 'Retrievable ' + uid().slice(0, 8);
    db.upsertEntity({ id: uid(), kind: 'topic', label });
    const found = db.getEntityByKindLabel('topic', label);
    assert.ok(found);
    assert.equal(found.label, label);
  });

  test('updateTopicLabel renames the entity', () => {
    const label = 'Old Label ' + uid().slice(0, 8);
    const entity = db.upsertEntity({ id: uid(), kind: 'topic', label });
    const newLabel = 'New Label ' + uid().slice(0, 8);
    db.updateTopicLabel(entity.id, newLabel);
    const found = db.getEntityByKindLabel('topic', newLabel);
    assert.ok(found);
    assert.equal(found.id, entity.id);
  });

  test('deleteTopicEntity removes the entity', () => {
    const label = 'To Delete ' + uid().slice(0, 8);
    const entity = db.upsertEntity({ id: uid(), kind: 'topic', label });
    db.deleteTopicEntity(entity.id);
    const found = db.getEntityByKindLabel('topic', label);
    assert.equal(found, undefined);
  });
});

// ── Values (append-only) ───────────────────────────────────────────────────

describe('Values (append-only)', () => {
  test('createValue inserts first version', () => {
    const slug = 'test-value-' + uid().slice(0, 8);
    db.createValue({ id: uid(), slug, title: 'Test Value', body: 'This is a test value body.' });
    const vals = db.currentValues();
    assert.ok(vals.some(v => v.slug === slug));
  });

  test('appendValueVersion increments version', () => {
    const slug = 'versioned-' + uid().slice(0, 8);
    db.createValue({ id: uid(), slug, title: 'Versioned', body: 'v1 body' });
    db.appendValueVersion({ id: uid(), slug, title: 'Versioned', body: 'v2 body' });
    const history = db.getValueHistory(slug);
    assert.ok(history.length >= 2);
    const versions = history.map(h => h.version);
    assert.ok(versions.includes(1));
    assert.ok(versions.includes(2));
  });
});

// ── Commitments ────────────────────────────────────────────────────────────

describe('Commitments', () => {
  test('createCommitment and listCommitments round-trip', () => {
    const id = uid();
    const text = 'Be faithful to the end ' + uid().slice(0, 8);
    db.createCommitment({ id, text });
    const list = db.listCommitments();
    assert.ok(list.some(c => c.id === id));
  });

  test('updateCommitment changes text', () => {
    const id = uid();
    db.createCommitment({ id, text: 'original commitment' });
    db.updateCommitment(id, { text: 'updated commitment' });
    const list = db.listCommitments();
    const item = list.find(c => c.id === id);
    assert.equal(item.text, 'updated commitment');
  });

  test('deleteCommitment removes it', () => {
    const id = uid();
    db.createCommitment({ id, text: 'ephemeral' });
    db.deleteCommitment(id);
    const list = db.listCommitments();
    assert.ok(!list.some(c => c.id === id));
  });
});

// ── Planning hub ───────────────────────────────────────────────────────────

describe('Planning hub — Rocks and Habits', () => {
  test('createRock and listRocks round-trip', () => {
    const id = uid();
    const week = '2099-01-06';
    db.createRock({ id, title: 'Finish sermon series', week_start: week, status: 'open' });
    const rocks = db.listRocks({ weekStart: week });
    assert.ok(rocks.some(r => r.id === id));
  });

  test('updateRock changes status', () => {
    const id = uid();
    const week = '2099-01-13';
    db.createRock({ id, title: 'Complete draft ' + uid().slice(0, 6), week_start: week, status: 'open' });
    db.updateRock(id, { status: 'done' });
    const rocks = db.listRocks({ weekStart: week });
    const rock = rocks.find(r => r.id === id);
    assert.equal(rock.status, 'done');
  });

  test('deleteRock removes it', () => {
    const id = uid();
    const week = '2099-01-20';
    const title = 'Ephemeral rock ' + uid().slice(0, 6);
    db.createRock({ id, title, week_start: week, status: 'open' });
    db.deleteRock(id);
    const rocks = db.listRocks({ weekStart: week });
    assert.ok(!rocks.some(r => r.id === id));
  });

  test('createHabit and listHabits round-trip', () => {
    const id = uid();
    db.createHabit({ id, label: 'Morning pages ' + uid().slice(0, 6), active_from: '2099-01-01', sort_order: 1 });
    const habits = db.listHabits();
    assert.ok(habits.some(h => h.id === id));
  });

  test('setHabitCheck and getHabitChecks round-trip', () => {
    const habitId = uid();
    db.createHabit({ id: habitId, label: 'Checkable habit ' + uid().slice(0, 6), active_from: '2099-01-01', sort_order: 2 });
    db.setHabitCheck(habitId, '2099-01-15', true);
    const checks = db.getHabitChecks(habitId, '2099-01-01', '2099-01-31');
    assert.ok(checks.some(c => c.date === '2099-01-15' && c.checked === 1));
  });
});

// ── User indexes ───────────────────────────────────────────────────────────

describe('User indexes', () => {
  test('createUserIndex and listUserIndexes round-trip', () => {
    const id = uid();
    const title = 'My Custom Index ' + uid().slice(0, 8);
    db.createUserIndex({ id, title });
    const indexes = db.listUserIndexes();
    assert.ok(indexes.some(i => i.id === id));
  });

  test('updateUserIndex changes query', () => {
    const id = uid();
    const title = 'Updatable Index ' + uid().slice(0, 8);
    db.createUserIndex({ id, title });
    db.updateUserIndex(id, { query: 'sabbath rest' });
    const indexes = db.listUserIndexes();
    const idx = indexes.find(i => i.id === id);
    assert.equal(idx.query, 'sabbath rest');
  });

  test('deleteUserIndex removes it', () => {
    const id = uid();
    db.createUserIndex({ id, title: 'Temp Index ' + uid().slice(0, 8) });
    db.deleteUserIndex(id);
    const indexes = db.listUserIndexes();
    assert.ok(!indexes.some(i => i.id === id));
  });
});

// ── Glossary ───────────────────────────────────────────────────────────────

describe('Glossary', () => {
  test('upsertGlossaryTerm and getGlossary round-trip', () => {
    const term = 'testterm' + uid().slice(0, 8);
    db.upsertGlossaryTerm({ term, meaning: 'a test definition' });
    const glossary = db.getGlossary();
    assert.ok(glossary.some(g => g.term === term));
  });

  test('isTermInGlossary returns true for known term', () => {
    const term = 'knownterm' + uid().slice(0, 8);
    db.upsertGlossaryTerm({ term, meaning: 'definition' });
    assert.ok(db.isTermInGlossary(term));
  });

  test('isTermInGlossary returns false for unknown term', () => {
    assert.ok(!db.isTermInGlossary('zzznever-stored-zzz' + uid()));
  });
});

// ── Index tree (phase 6) ───────────────────────────────────────────────────

describe('Index tree (index_parents)', () => {
  test('setIndexParent creates a parent link', () => {
    const parentId = uid();
    const childId = uid();
    db.createUserIndex({ id: parentId, title: 'Parent Index ' + uid().slice(0, 6) });
    db.createUserIndex({ id: childId, title: 'Child Index ' + uid().slice(0, 6) });
    db.setIndexParent('user_index', childId, 'user_index', parentId);
    // getIndexParents returns { kind, id, label } objects
    const parents = db.getIndexParents('user_index', childId);
    assert.ok(parents.some(p => p.id === parentId));
  });

  test('removeIndexParent removes the link', () => {
    const parentId = uid();
    const childId = uid();
    db.createUserIndex({ id: parentId, title: 'RParent ' + uid().slice(0, 6) });
    db.createUserIndex({ id: childId, title: 'RChild ' + uid().slice(0, 6) });
    db.setIndexParent('user_index', childId, 'user_index', parentId);
    db.removeIndexParent('user_index', childId, 'user_index', parentId);
    const parents = db.getIndexParents('user_index', childId);
    assert.ok(!parents.some(p => p.id === parentId));
  });
});
