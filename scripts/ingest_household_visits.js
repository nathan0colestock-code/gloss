#!/usr/bin/env node
'use strict';

// One-shot script to ingest Andy Naselli's pastoral household-visit notes
// into Gloss via the /api/ingest/voice endpoint.
//
// Usage:
//   node scripts/ingest_household_visits.js --dry-run   # preview only
//   node scripts/ingest_household_visits.js             # actually POST

const fs = require('fs');
const http = require('http');

const FILE = '/Users/nathancolestock/Downloads/Member Household Visits.txt';
const API_URL = 'http://localhost:3747/api/ingest/voice';
const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 4000; // pause between Gemini calls

// ── Date parsing ──────────────────────────────────────────────────────────────

const MONTHS = {
  january:'01', february:'02', march:'03', april:'04',
  may:'05', june:'06', july:'07', august:'08',
  september:'09', october:'10', november:'11', december:'12',
  jan:'01', feb:'02', mar:'03', apr:'04',
  jun:'06', jul:'07', aug:'08',
  sep:'09', oct:'10', nov:'11', dec:'12',
};

// Try to parse an ISO date from the START of a trimmed string.
function tryParseDate(s) {
  s = (s || '').trim();
  if (!s || s.length > 120) return null;

  // "Month Day, Year" or "Month Day Year"  (e.g. "October 24, 2025")
  let m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) return `${m[3]}-${mo}-${m[2].padStart(2,'0')}`;
  }

  // "M/D/YY" or "M/D/YYYY"  (e.g. "3/21/26")
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const yr = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }

  // "M/D" standalone (no year → assume 2025)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\s*$/);
  if (m && +m[1] <= 12 && +m[2] <= 31) {
    return `2025-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }

  // "Friday November 21" (weekday + month + day, no year → 2025)
  m = s.match(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+([A-Za-z]+)\s+(\d{1,2})/i);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) return `2025-${mo}-${m[2].padStart(2,'0')}`;
  }

  return null;
}

// Try to extract a date embedded anywhere in a sentence (e.g. "on the evening of 10/27")
function extractEmbeddedDate(s, fallbackYear = '2025') {
  // M/D/YY or M/D/YYYY embedded
  let m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) {
    const yr = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  // M/D embedded (no year)
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m && +m[1] <= 12 && +m[2] <= 31) {
    return `${fallbackYear}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  return null;
}

// ── File parsing ──────────────────────────────────────────────────────────────

const rawLines = fs.readFileSync(FILE, 'utf8').split('\n');

// Decide whether a line looks like visit content (numbered items, bullets, long text)
// so we know to stop scanning backward for context.
function isVisitContent(s) {
  if (!s) return false;
  if (/^\d+[\.\)]/.test(s)) return true;    // "1. ..." or "1) ..."
  if (/^[\*•]\s/.test(s)) return true;      // "* item" or "• item"
  if (/^-\s+\S/.test(s)) return true;       // "- item" (not a bare "-" separator)
  if (/^\[/.test(s)) return true;           // footnotes like "[1] ..."
  if (s.length > 90) return true;           // long paragraph
  return false;
}

// A family context line looks like a name, not a sentence.
// Used to filter backward-scan results so we don't pick up prose from a previous visit.
function isFamilyContextLine(s) {
  if (!s || s.length > 60) return false;
  if (isVisitContent(s)) return false;
  // Must be name-like: letters, spaces, commas, parens, plus signs, hyphens, digits
  if (!/^[A-Za-z][A-Za-z0-9\s,\-\(\)\+\.]+$/.test(s)) return false;
  // Reject anything that reads like a sentence (verb patterns, prepositions that signal prose)
  if (/\b(and I|we met|I met|visited|met with|please|pray for|for a|for the)\b/i.test(s)) return false;
  return true;
}

// Build an array of { raw, trimmed, date } for each line
const lineInfo = rawLines.map((raw, i) => ({
  raw,
  trimmed: raw.trim(),
  date: tryParseDate(raw.trim()),
  idx: i,
}));

// Collect all lines that have a date at the start
const datePosns = lineInfo.filter(li => li.date).map(li => li.idx);

// The Opsahl section has no standalone date line — its date is embedded in the
// first sentence of content. Detect that paragraph and inject a synthetic date entry.
// "Nathan and I (Dustin) met with Tom and Sharon in their home on the evening of 10/27"
(function fixOpsahl() {
  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].trim();
    if (t.includes('Tom and Sharon') && t.includes('10/27')) {
      const date = extractEmbeddedDate(t, '2025');
      if (date && !datePosns.includes(i)) {
        // Insert this line as a date marker
        lineInfo[i].date = date;
        datePosns.push(i);
        datePosns.sort((a, b) => a - b);
      }
    }
  }
})();

// ── Build visit records ───────────────────────────────────────────────────────

const visits = [];

for (let vi = 0; vi < datePosns.length; vi++) {
  const d = datePosns[vi];
  const date = lineInfo[d].date;
  const nextD = vi + 1 < datePosns.length ? datePosns[vi + 1] : rawLines.length;

  // Scan backward from d to pick up the family context (names, members).
  // Skip separator lines (like "-", "(children)") without breaking — only stop at
  // actual visit content (numbered items, bullets, long prose).
  const prevDateEnd = vi > 0 ? datePosns[vi - 1] : 0;
  const contextLines = [];
  for (let j = d - 1; j >= Math.max(prevDateEnd, d - 30); j--) {
    const l = lineInfo[j].trimmed;
    if (!l) continue;
    if (isVisitContent(l)) break;
    if (l.length > 100) break;
    if (isFamilyContextLine(l)) contextLines.unshift(l);
    // else: separator / non-name line — skip and keep scanning backward
  }

  // Fallback: if first pass found nothing (follow-up visit where prior visit's prose
  // blocked the scan), look back past the previous date line for the family header.
  if (contextLines.length === 0 && vi > 0) {
    const prevPrevEnd = vi > 1 ? datePosns[vi - 2] : 0;
    for (let j = datePosns[vi - 1] - 1; j >= Math.max(prevPrevEnd, datePosns[vi - 1] - 25); j--) {
      const l = lineInfo[j].trimmed;
      if (!l) continue;
      if (isVisitContent(l)) break;
      if (l.length > 100) break;
      if (isFamilyContextLine(l)) contextLines.unshift(l);
    }
  }

  const contextText = contextLines.join('\n').trim();

  // Visit content: from the date line to the next date line
  const visitText = rawLines.slice(d, nextD).join('\n').trim();

  // Build transcript
  const header = contextText
    ? `Pastoral household visit — ${contextText}`
    : 'Pastoral household visit';

  const transcript = `${header}\n\n${visitText}`;

  const label = `${contextLines[0] || '?'} | ${date}`;
  visits.push({ date, transcript, label });
}

// ── Preview ───────────────────────────────────────────────────────────────────

console.log(`\nFound ${visits.length} visit records:\n`);
visits.forEach((v, i) => {
  const preview = v.transcript.replace(/\n+/g, ' ').slice(0, 110);
  console.log(`  ${String(i+1).padStart(2)}. [${v.date}] ${preview}`);
});

if (DRY_RUN) {
  console.log('\n-- Dry run, not posting. --');
  process.exit(0);
}

// ── POST to API ───────────────────────────────────────────────────────────────

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      method: 'POST',
      hostname: 'localhost',
      port: 3747,
      path: '/api/ingest/voice',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = http.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('\nIngesting...\n');
  let ok = 0, failed = 0;
  for (let i = 0; i < visits.length; i++) {
    const v = visits[i];
    process.stdout.write(`  ${String(i+1).padStart(2)}/${visits.length} [${v.date}] ${v.label.slice(0,50)}... `);
    try {
      const result = await post({ transcript: v.transcript, date: v.date });
      if (result.status === 200) {
        console.log('OK');
        ok++;
      } else {
        console.log(`FAIL ${result.status}: ${result.body.slice(0, 120)}`);
        failed++;
      }
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      failed++;
    }
    if (i < visits.length - 1) await sleep(DELAY_MS);
  }
  console.log(`\nDone. ${ok} OK, ${failed} failed.`);
})();
