// One-shot: re-summarize all voice memo pages using the current VOICE_PROMPT.
// Run: node scripts/refresh_voice_summaries.js
// Safe to re-run; overwrites summary in place.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Mirror server.js env loader so GEMINI_API_KEY is available before ai.js loads.
(function loadEnv() {
  const envPath = path.join(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
})();

const { updatePageSummary, getRecentAnsweredQuestions, getKnownAliases, getGlossary } = require('../db');
const { parseVoiceMemo } = require('../ai');

const rawDb = new Database(path.join(__dirname, '../data/foxed.db'), { readonly: true });

(async () => {
  const rows = rawDb.prepare(`
    SELECT id, raw_ocr_text FROM pages
    WHERE source_kind = 'voice_memo'
      AND raw_ocr_text IS NOT NULL
      AND raw_ocr_text != ''
    ORDER BY captured_at ASC
  `).all();

  rawDb.close();

  if (!rows.length) {
    console.log('No voice memos found.');
    return;
  }

  console.log(`Re-summarizing ${rows.length} voice memo(s)…`);

  const recentAnswered = getRecentAnsweredQuestions(150);
  const knownAliases   = getKnownAliases();
  const glossary       = getGlossary();

  for (const row of rows) {
    try {
      const parsed = await parseVoiceMemo(row.raw_ocr_text, recentAnswered, knownAliases, glossary);
      if (parsed.summary) {
        updatePageSummary(row.id, parsed.summary.trim());
        console.log(`✓ ${row.id.slice(0, 8)}… → ${parsed.summary.slice(0, 100)}${parsed.summary.length > 100 ? '…' : ''}`);
      } else {
        console.warn(`  ${row.id.slice(0, 8)}… no summary returned, skipping`);
      }
    } catch (e) {
      console.error(`✗ ${row.id.slice(0, 8)}… failed: ${e.message}`);
    }
  }

  console.log('Done.');
})();
