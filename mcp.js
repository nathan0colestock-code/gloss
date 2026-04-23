'use strict';

// Foxed MCP server — read-only access to notebook data for AI agents.
// Run via: node mcp.js  (or `npm run mcp`)
// Connects over stdio; Claude Desktop / Claude Code manages the process lifecycle.
//
// SAFE db.js functions (read-only): getRecentPages, getPageDetail, getPage,
//   searchItems, searchAll, getItemsCapturedOn, listCollectionsGrouped,
//   getCollectionDetail, findDailyLogByDate, getDailyLogDetail, getPeopleIndex,
//   getTopicsIndex, listBooks, getBooksIndex, getScriptureIndex, listIndexTree,
//   listUserIndexes, getArtifactDetail, getReference, listArtifacts, listReferences
//
// DO NOT call any insert*, create*, update*, delete*, upsert*, link*, set*, merge*
// function from this file. The sovereignty invariant also forbids exposing raw_ocr_text.

const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const db = require('./db');

// ─── Sovereignty sanitizers ──────────────────────────────────────────────────
// These are the only defence against raw notebook prose leaking to agents.
// raw_ocr_text = verbatim; growth_note = private coaching; first_names = internal alias CSV.

function sanitizePage(page) {
  if (!page) return null;
  const { raw_ocr_text, scan_path, ...rest } = page;
  rest.has_scan = typeof scan_path === 'string'
    && !scan_path.startsWith('voice:')
    && !scan_path.startsWith('markdown:');
  return rest;
}

function sanitizePageDetail(detail) {
  if (!detail) return null;
  return {
    ...detail,
    page: sanitizePage(detail.page),
    spread_pages: (detail.spread_pages || []).map(sanitizePage),
    context_strip: (detail.context_strip || []).map(sanitizePage),
    people: (detail.people || []).map(sanitizePerson),
  };
}

function sanitizePerson(person) {
  if (!person) return null;
  const { growth_note, first_names, ...safe } = person;
  return safe;
}

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'foxed',
  version: '0.1.0',
});

// ── Resources ────────────────────────────────────────────────────────────────

server.resource(
  'foxed-pages',
  'foxed://pages',
  { description: 'List the 50 most recent notebook pages' },
  async () => {
    const pages = db.getRecentPages(50);
    return {
      contents: [{
        uri: 'foxed://pages',
        mimeType: 'application/json',
        text: JSON.stringify(pages.map(sanitizePage), null, 2),
      }],
    };
  }
);

server.resource(
  'foxed-page',
  new ResourceTemplate('foxed://pages/{id}', { list: undefined }),
  { description: 'Full detail for one notebook page by ID' },
  async (uri, { id }) => {
    const detail = db.getPageDetail(id);
    if (!detail) throw new Error(`Page not found: ${id}`);
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(sanitizePageDetail(detail), null, 2),
      }],
    };
  }
);

server.resource(
  'foxed-collections',
  'foxed://collections',
  { description: 'All collections grouped by kind (topical, monthly_log, future_log, project, index)' },
  async () => {
    const grouped = db.listCollectionsGrouped();
    return {
      contents: [{
        uri: 'foxed://collections',
        mimeType: 'application/json',
        text: JSON.stringify(grouped, null, 2),
      }],
    };
  }
);

server.resource(
  'foxed-collection',
  new ResourceTemplate('foxed://collections/{id}', { list: undefined }),
  { description: 'Pages and entities in a collection by ID' },
  async (uri, { id }) => {
    const detail = db.getCollectionDetail(id);
    if (!detail) throw new Error(`Collection not found: ${id}`);
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          ...detail,
          pages: (detail.pages || []).map(sanitizePage),
        }, null, 2),
      }],
    };
  }
);

server.resource(
  'foxed-people',
  'foxed://people',
  { description: 'All people mentioned in the notebook with mention counts' },
  async () => {
    const people = db.getPeopleIndex();
    return {
      contents: [{
        uri: 'foxed://people',
        mimeType: 'application/json',
        text: JSON.stringify(people.map(sanitizePerson), null, 2),
      }],
    };
  }
);

server.resource(
  'foxed-topics',
  'foxed://topics',
  { description: 'All topics extracted from the notebook with mention counts' },
  async () => {
    const topics = db.getTopicsIndex();
    return {
      contents: [{
        uri: 'foxed://topics',
        mimeType: 'application/json',
        text: JSON.stringify(topics, null, 2),
      }],
    };
  }
);

server.resource(
  'foxed-books',
  'foxed://books',
  { description: 'Bibliographic books noted in the notebook' },
  async () => {
    const books = db.listBooks();
    return {
      contents: [{
        uri: 'foxed://books',
        mimeType: 'application/json',
        text: JSON.stringify(books, null, 2),
      }],
    };
  }
);

server.resource(
  'foxed-scripture',
  'foxed://scripture',
  { description: 'Scripture references found in the notebook with mention counts' },
  async () => {
    const refs = db.getScriptureIndex();
    return {
      contents: [{
        uri: 'foxed://scripture',
        mimeType: 'application/json',
        text: JSON.stringify(refs, null, 2),
      }],
    };
  }
);

server.resource(
  'foxed-daily-log',
  new ResourceTemplate('foxed://daily-logs/{date}', { list: undefined }),
  { description: 'All pages captured on a given date (YYYY-MM-DD)' },
  async (uri, { date }) => {
    const row = db.findDailyLogByDate(date);
    if (!row) throw new Error(`No daily log found for date: ${date}`);
    const detail = db.getDailyLogDetail(row.id);
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          ...detail,
          pages: (detail.pages || []).map(sanitizePage),
        }, null, 2),
      }],
    };
  }
);

server.resource(
  'foxed-indexes',
  'foxed://indexes',
  { description: 'Unified index tree covering all kinds (collections, books, people, topics, …)' },
  async () => {
    const tree = db.listIndexTree({ includeArchived: false });
    return {
      contents: [{
        uri: 'foxed://indexes',
        mimeType: 'application/json',
        text: JSON.stringify(tree, null, 2),
      }],
    };
  }
);

// ── Tools ────────────────────────────────────────────────────────────────────

server.tool(
  'search_notebook',
  'Full-text search over notebook items (pointer-summaries from all pages). Returns matching items with page context.',
  {
    query: z.string().min(1).describe('Search terms'),
    limit: z.number().int().min(1).max(30).default(15).optional().describe('Max results (default 15, max 30)'),
  },
  async ({ query, limit = 15 }) => {
    let results;
    try {
      results = db.searchItems(query, limit);
    } catch {
      results = [];
    }
    const safe = results.map(r => ({
      item_id: r.id,
      item_text: r.text,
      item_kind: r.kind,
      item_status: r.status,
      page_id: r.page_id,
      volume: r.volume,
      page_number: r.page_number,
      captured_at: r.captured_at,
      source_kind: r.source_kind,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] };
  }
);

server.tool(
  'search_all',
  'Broad multi-surface search across pages, collections, people, scripture, topics, and books.',
  {
    query: z.string().min(1).describe('Search terms'),
  },
  async ({ query }) => {
    const results = db.searchAll(query, 5);
    // Strip scan_path / raw_ocr_text from page hits if present
    if (results.pages) {
      results.pages = results.pages.map(p => {
        const { raw_ocr_text, scan_path, ...rest } = p;
        return rest;
      });
    }
    if (results.people) {
      results.people = results.people.map(sanitizePerson);
    }
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }
);

server.tool(
  'get_page',
  'Get full detail for a notebook page by ID (items, collections, people, topics, scripture, books).',
  {
    page_id: z.string().min(1).describe('Page UUID from a prior search or resource read'),
  },
  async ({ page_id }) => {
    const detail = db.getPageDetail(page_id);
    if (!detail) return { content: [{ type: 'text', text: JSON.stringify({ error: `Page not found: ${page_id}` }) }] };
    return { content: [{ type: 'text', text: JSON.stringify(sanitizePageDetail(detail), null, 2) }] };
  }
);

server.tool(
  'get_collection',
  'Get a collection\'s pages and entity summary.',
  {
    collection_id: z.string().min(1).describe('Collection UUID'),
  },
  async ({ collection_id }) => {
    const detail = db.getCollectionDetail(collection_id);
    if (!detail) return { content: [{ type: 'text', text: JSON.stringify({ error: `Collection not found: ${collection_id}` }) }] };
    const safe = {
      ...detail,
      pages: (detail.pages || []).map(sanitizePage),
    };
    return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] };
  }
);

server.tool(
  'get_daily_log',
  'Get all pages captured on a given date.',
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('ISO date YYYY-MM-DD'),
  },
  async ({ date }) => {
    const row = db.findDailyLogByDate(date);
    if (!row) return { content: [{ type: 'text', text: JSON.stringify({ error: `No daily log for date: ${date}` }) }] };
    const detail = db.getDailyLogDetail(row.id);
    const safe = {
      ...detail,
      pages: (detail.pages || []).map(sanitizePage),
    };
    return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] };
  }
);

server.tool(
  'list_collections',
  'List all collections grouped by kind (topical, monthly_log, future_log, project).',
  {},
  async () => {
    const grouped = db.listCollectionsGrouped();
    return { content: [{ type: 'text', text: JSON.stringify(grouped, null, 2) }] };
  }
);

server.tool(
  'list_people',
  'List all people mentioned in the notebook with mention counts.',
  {},
  async () => {
    const people = db.getPeopleIndex();
    return { content: [{ type: 'text', text: JSON.stringify(people.map(sanitizePerson), null, 2) }] };
  }
);

server.tool(
  'list_topics',
  'List all topics extracted from the notebook with mention counts and parent relationships.',
  {},
  async () => {
    const topics = db.getTopicsIndex();
    return { content: [{ type: 'text', text: JSON.stringify(topics, null, 2) }] };
  }
);

server.tool(
  'list_books',
  'List bibliographic books noted in the notebook.',
  {},
  async () => {
    const books = db.listBooks();
    return { content: [{ type: 'text', text: JSON.stringify(books, null, 2) }] };
  }
);

server.tool(
  'get_index_tree',
  'Get the full unified index tree (all kinds: collections, books, artifacts, references, people, topics, scripture, user indexes).',
  {},
  async () => {
    const tree = db.listIndexTree({ includeArchived: false });
    return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] };
  }
);

server.tool(
  'get_items_for_date',
  'Get all pointer-summary items captured on a specific date.',
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('ISO date YYYY-MM-DD'),
    limit: z.number().int().min(1).max(200).default(50).optional().describe('Max results (default 50)'),
  },
  async ({ date, limit = 50 }) => {
    const items = db.getItemsCapturedOn(date, limit);
    const safe = items.map(({ scan_path, ...rest }) => rest);
    return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] };
  }
);

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`Foxed MCP server error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
