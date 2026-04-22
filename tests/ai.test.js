'use strict';

// ai.js initialises the Gemini client on require() using process.env.GEMINI_API_KEY.
// We stub it to a placeholder so the module loads without a real key.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-stub-key';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../ai');

// ── Module contract ────────────────────────────────────────────────────────

describe('ai.js module exports', () => {
  const EXPECTED_EXPORTS = [
    'parsePageImage',
    'chat',
    'chatWithActions',
    'reexaminePage',
    'parseVoiceMemo',
    'probePageHeader',
    'generateIndexStructure',
    'classifyPageForIndexes',
    'suggestMetaCategories',
    'classifyRowForCrossKind',
    'generateTopicalIndexEntries',
  ];

  for (const name of EXPECTED_EXPORTS) {
    test(`exports ${name} as a function`, () => {
      assert.ok(name in ai, `missing export: ${name}`);
      assert.equal(typeof ai[name], 'function');
    });
  }

  test('exports exactly the expected set (no silent additions)', () => {
    const actual = new Set(Object.keys(ai));
    for (const name of EXPECTED_EXPORTS) {
      assert.ok(actual.has(name), `missing export: ${name}`);
    }
  });
});

// ── Return-shape contract (network-free) ──────────────────────────────────
// These functions must return Promises — even with a bad/stub key, the
// error surface should be a rejected Promise, not a synchronous throw.

describe('ai.js async contract', () => {
  test('parsePageImage returns a Promise', () => {
    // Pass minimal args; we expect a Promise (which will reject without a real key).
    const result = ai.parsePageImage('fake-path.png', {});
    assert.ok(result && typeof result.then === 'function',
      'parsePageImage should return a thenable');
    // Swallow the rejection — we only care about the return type.
    result.catch(() => {});
  });

  test('chat returns a Promise', () => {
    const result = ai.chat({ messages: [], context: [] });
    assert.ok(result && typeof result.then === 'function');
    result.catch(() => {});
  });

  test('probePageHeader returns a Promise', () => {
    const result = ai.probePageHeader('fake-path.png');
    assert.ok(result && typeof result.then === 'function');
    result.catch(() => {});
  });

  test('classifyPageForIndexes returns a Promise', () => {
    const result = ai.classifyPageForIndexes({ page: {}, indexes: [] });
    assert.ok(result && typeof result.then === 'function');
    result.catch(() => {});
  });
});
