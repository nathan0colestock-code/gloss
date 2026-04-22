const path = require('path');
const fs = require('fs');

// Load .env with override — required because the parent shell may have
// GEMINI_API_KEY set to an empty string, which Node's --env-file respects
// instead of overriding.
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
})();

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const { createDb } = require('./db');
const auth = require('./auth');
const _requestContext = require('./context');
const { parsePageImage, chat, chatWithActions, reexaminePage, parseVoiceMemo, probePageHeader,
        generateIndexStructure, classifyPageForIndexes, suggestMetaCategories,
        classifyRowForCrossKind, generateTopicalIndexEntries } = require('./ai');
const google = require('./google');
function _db() {
  const s = _requestContext.getStore();
  return s ? s.db : require('./db'); // fallback to singleton for non-request paths
}
function _scansDir() {
  const s = _requestContext.getStore();
  return s ? path.join(s.userDataDir, 'scans') : path.join(__dirname, 'data', 'scans');
}
function _artifactsDir() {
  const s = _requestContext.getStore();
  return s ? path.join(s.userDataDir, 'artifacts') : path.join(__dirname, 'data', 'artifacts');
}
function _referencesDir() {
  const s = _requestContext.getStore();
  return s ? path.join(s.userDataDir, 'references') : path.join(__dirname, 'data', 'references');
}
function _geminiKey() {
  const s = _requestContext.getStore();
  return (s && s.geminiKey) || process.env.GEMINI_API_KEY || null;
}

// ── Per-user DB connection pool ───────────────────────────────────────────────
const _dbPool = new Map();
function getUserDb(userId) {
  if (_dbPool.has(userId)) return _dbPool.get(userId);
  const dir = path.join(__dirname, 'data', 'users', userId);
  const inst = createDb(path.join(dir, 'foxed.db'));
  _dbPool.set(userId, inst);
  return inst;
}
function getUserDataDir(userId) {
  return path.join(__dirname, 'data', 'users', userId);
}

// Fetch Google Docs/Drive content for artifacts/references when their URL is
// a recognized Google URL. Errors are swallowed into fetched_error so a bad
// link (or disconnected OAuth) doesn't block the save.
async function fetchIfGoogle(kind, id, url) {
  if (!url || !google.parseGoogleUrl(url)) return null;
  const now = new Date().toISOString();
  try {
    const { content } = await google.fetchContentForUrl(url);
    const updater = kind === 'artifact' ? _db().updateArtifactContent : _db().updateReferenceContent;
    updater(id, { fetched_content: content, fetched_at: now, fetched_error: null });
    return { ok: true };
  } catch (e) {
    const updater = kind === 'artifact' ? _db().updateArtifactContent : _db().updateReferenceContent;
    updater(id, { fetched_content: null, fetched_at: now, fetched_error: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }
}

const app = express();
const PORT = process.env.PORT || 3747;

app.use(express.json({ limit: '2mb' }));

// Sessions backed by SQLite (sessions.db in data/)
const _sessionDbPath = path.join(__dirname, 'data', 'sessions.db');
fs.mkdirSync(path.dirname(_sessionDbPath), { recursive: true });
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'data') }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

// ── requireAuth middleware ────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.userId = req.session.userId;
  req.db = getUserDb(req.session.userId);
  req.userDataDir = getUserDataDir(req.session.userId);
  req.geminiKey = auth.getGeminiKey(req.session.userId);
  _requestContext.run({
    db: req.db,
    userDataDir: req.userDataDir,
    geminiKey: req.geminiKey,
    userId: req.userId,
  }, next);
}

// ── Auth endpoints (no auth required) ────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  if (process.env.ALLOW_REGISTRATION !== 'true') {
    return res.status(403).json({ error: 'Registration is not open' });
  }
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const user = auth.createUser(email, password);
    req.session.userId = user.id;
    res.status(201).json({ id: user.id, email: user.email, has_gemini_key: user.has_gemini_key });
  } catch (e) {
    if (e.code === 'EMAIL_TAKEN') return res.status(409).json({ error: 'Email already registered' });
    console.error('register error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = auth.verifyUser(email, password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  req.session.userId = user.id;
  res.json({ id: user.id, email: user.email, has_gemini_key: user.has_gemini_key });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/auth/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = auth.getUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ id: user.id, email: user.email, has_gemini_key: user.has_gemini_key });
});

app.post('/auth/api-key', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { gemini_api_key } = req.body || {};
  if (!gemini_api_key) return res.status(400).json({ error: 'gemini_api_key required' });
  auth.setGeminiKey(req.session.userId, gemini_api_key);
  res.json({ ok: true });
});

// ── Public static (HTML, fonts, icons — no auth needed) ──────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Everything below this line requires auth ──────────────────────────────────
app.use(requireAuth);

// Per-user file serving: session-scoped, path.basename prevents traversal
function serveUserFile(subdir) {
  return (req, res) => {
    const file = path.join(req.userDataDir, subdir, path.basename(req.path));
    if (!fs.existsSync(file)) return res.status(404).end();
    res.sendFile(file);
  };
}
app.use('/scans',     serveUserFile('scans'));
app.use('/artifacts', serveUserFile('artifacts'));
app.use('/references',serveUserFile('references'));

// Multer: per-user scan storage (destination computed per-request after requireAuth runs)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(req.userDataDir, 'scans');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, crypto.randomUUID() + ext);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isImage = file.mimetype.startsWith('image/');
    const isPdf = file.mimetype === 'application/pdf' ||
                  path.extname(file.originalname).toLowerCase() === '.pdf';
    if (isImage || isPdf) cb(null, true);
    else cb(new Error('Only image or PDF files are accepted'));
  },
});

// ── POST /api/ingest ────────────────────────────────────────────────────────
app.post('/api/ingest', upload.single('scan'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const isPdf = ext === '.pdf' || req.file.mimetype === 'application/pdf';
  const rawKind = (req.body && req.body.kind) ? String(req.body.kind).trim() : '';
  const userKindHint = ['book', 'artifact', 'reference', 'page'].includes(rawKind) ? rawKind : null;
  const roleIds = parseIdList(req.body?.role_ids);
  const areaIds = parseIdList(req.body?.area_ids);
  const volumeOverride = (req.body && typeof req.body.volume === 'string')
    ? req.body.volume.trim()
    : '';

  try {
    let result;
    if (isPdf) {
      result = await ingestPdf(req.file.path, { userKindHint, volumeOverride });
    } else {
      result = await ingestSingleImage(req.file.path, `/scans/${req.file.filename}`, { userKindHint, volumeOverride });
    }
    // Tag every resulting page (and any collection it was filed into) with the
    // user's role_ids / area_ids.
    applyRoleAreaTags(result.pages || [], roleIds, areaIds);
    if (isPdf) return res.json(result);
    res.json({
      kind: result.is_multi ? 'spread' : 'image',
      page_count: result.pages.length,
      items_count: result.items_count,
      backlog_count: result.backlog_count,
      pages: result.pages,
    });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: 'Ingest failed', detail: err.message });
  }
});

// POST /api/ingest/stream — same as /api/ingest but streams NDJSON so the UI
// can render each page as the Gemini worker finishes it, instead of waiting
// for the whole PDF. One JSON object per line:
//   {type:"start", page_count}
//   {type:"page",  page:{...}}   (repeated; one per logical page as it finishes)
//   {type:"done",  page_count, items_count, backlog_count}
//   {type:"error", error}
app.post('/api/ingest/stream', upload.single('scan'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const isPdf = ext === '.pdf' || req.file.mimetype === 'application/pdf';
  const rawKind = (req.body && req.body.kind) ? String(req.body.kind).trim() : '';
  const userKindHint = ['book', 'artifact', 'reference', 'page'].includes(rawKind) ? rawKind : null;
  const roleIds = parseIdList(req.body?.role_ids);
  const areaIds = parseIdList(req.body?.area_ids);
  const volumeOverride = (req.body && typeof req.body.volume === 'string')
    ? req.body.volume.trim()
    : '';

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const write = (obj) => {
    try { res.write(JSON.stringify(obj) + '\n'); } catch {}
  };

  try {
    let result;
    if (isPdf) {
      // Emit {start} once we know the page count — ingestPdf runs pdfinfo early.
      let startSent = false;
      result = await ingestPdf(req.file.path, {
        userKindHint,
        volumeOverride,
        onPageComplete: (page) => {
          if (!startSent && page.total_scans) {
            write({ type: 'start', page_count: page.total_scans });
            startSent = true;
          }
          // Tag this page now so the streamed row reflects role/area tags.
          applyRoleAreaTags([page], roleIds, areaIds);
          write({ type: 'page', page });
        },
      });
    } else {
      write({ type: 'start', page_count: 1 });
      result = await ingestSingleImage(req.file.path, `/scans/${req.file.filename}`, { userKindHint, volumeOverride });
      applyRoleAreaTags(result.pages || [], roleIds, areaIds);
      for (const p of (result.pages || [])) write({ type: 'page', page: p });
    }
    write({
      type: 'done',
      kind: isPdf ? 'pdf' : (result.is_multi ? 'spread' : 'image'),
      page_count: isPdf ? result.page_count : result.pages.length,
      items_count: result.items_count,
      backlog_count: result.backlog_count,
    });
    res.end();
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch {}
    write({ type: 'error', error: err.message || String(err) });
    res.end();
  }
});

// Parse a role_ids / area_ids form field. Accepts a JS array (parsed JSON body),
// a comma-separated string (multipart/form-data), or undefined.
function parseIdList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

// Link every ingested page (and any auto-created collection) to the given
// role / area entity ids. Safe to call with empty arrays.
function applyRoleAreaTags(pages, roleIds, areaIds) {
  const entityIds = [...(roleIds || []), ...(areaIds || [])];
  if (entityIds.length === 0) return;
  for (const pg of pages) {
    const pageId = pg.page_id || pg.id;
    if (!pageId || pg.error) continue;
    for (const eid of entityIds) {
      try { _db().linkBetween({ from_type: 'page', from_id: pageId, to_type: 'entity', to_id: eid }); }
      catch (e) { console.warn('role/area tag skip (page):', e.message); }
    }
    for (const c of (pg.collections || [])) {
      for (const eid of entityIds) {
        try { _db().linkBetween({ from_type: 'collection', from_id: c.id, to_type: 'entity', to_id: eid }); }
        catch (e) { console.warn('role/area tag skip (collection):', e.message); }
      }
    }
  }
}

// Resolve a person reference from the AI. If the label is a single word (first-name
// only), use context + recency to pick the right existing person. If ambiguous,
// stage a backlog question so the user can clarify and still return the best-guess
// person so the page is at least linked.
//
// Returns { person, backlog } — backlog is a row to insert into backlog_items when
// the match is ambiguous.
const RECENT_WINDOW_DAYS = 60;
function resolvePersonReference(rawLabel, pageId, pageSummary) {
  const label = String(rawLabel || '').trim();
  if (!label) return { person: null, backlog: null };

  // Multi-word label (e.g. "John Smith") — exact upsert, no disambiguation needed.
  if (label.includes(' ')) {
    return { person: _db().upsertPerson({ label }), backlog: null };
  }

  const candidates = _db().findPeopleByFirstName(label);
  if (candidates.length === 0) {
    // First time seeing this name — just store it and move on.
    return { person: _db().upsertPerson({ label }), backlog: null };
  }
  if (candidates.length === 1) {
    return { person: candidates[0], backlog: null };
  }

  // Multiple matches. Prefer anyone touched recently; if there's a clear winner,
  // use them. Otherwise link to the best guess and queue a clarifying question.
  const recency = _db().personRecencyMap(candidates.map(c => c.id));
  const cutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 86400000).toISOString();
  const recent = candidates
    .map(c => ({ ...c, last_seen: recency[c.id] || null }))
    .filter(c => c.last_seen && c.last_seen >= cutoff)
    .sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''));

  const bestGuess = recent[0] || candidates[0];

  // One clear recent winner (only one match in window) → don't ask.
  if (recent.length === 1) return { person: bestGuess, backlog: null };

  const options = candidates.map(c => ({ value: c.id, label: c.label }));
  options.push({ value: '__new__', label: `New person named "${label}"` });

  const backlog = {
    id: crypto.randomUUID(),
    kind: 'question',
    subject: `Who is "${label}"?`,
    proposal: pageSummary
      ? `Context: ${pageSummary.slice(0, 180)}`
      : `Pick the right person for "${label}" — multiple matches on file.`,
    context_page_id: pageId,
    answer_format: 'choice',
    answer_options: options,
  };
  return { person: bestGuess, backlog };
}

// Voice memo ingest: paste a transcript, it gets parsed like a page and filed into
// the daily_log collection for the date the user chose (default today).
app.post('/api/ingest/voice', async (req, res) => {
  const { transcript, date } = req.body || {};
  if (!transcript || !transcript.trim()) return res.status(400).json({ error: 'transcript is required' });
  const isoDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date))
    ? date
    : new Date().toISOString().slice(0, 10);
  try {
    const recentAnswered = _db().getRecentAnsweredQuestions(150);
    const knownAliases = _db().getKnownAliases();
    const notebookGlossary = _db().getGlossary();
    const parsed = await parseVoiceMemo(transcript.trim(), recentAnswered, knownAliases, notebookGlossary);
    const pageId = crypto.randomUUID();

    // Store transcript privately on the page row; scan_path gets a sentinel so the
    // pages.scan_path NOT NULL constraint is satisfied without pointing at an image.
    _db().insertPage({
      id: pageId,
      scan_path: `voice:${pageId}`,
      raw_ocr_text: transcript.trim(),
      summary: parsed.summary || null,
      source_kind: 'voice_memo',
      captured_at: `${isoDate}T12:00:00`,
    });

    const itemRows = (parsed.items || []).map(item => ({
      id: crypto.randomUUID(),
      page_id: pageId,
      kind: item.kind,
      text: item.text,
      confidence: item.confidence ?? 1.0,
    }));
    if (itemRows.length) _db().insertItems(itemRows);

    for (const entity of (parsed.entities || [])) {
      try {
        const roleSummary = (entity.role_summary || '').trim() || null;
        if (entity.kind === 'scripture' && entity.book && entity.chapter) {
          const ref = _db().upsertScriptureRef({
            canonical: entity.label, book: entity.book, chapter: entity.chapter,
            verse_start: entity.verse_start ?? null, verse_end: entity.verse_end ?? null,
          });
          _db().linkPageToScripture(pageId, ref.id, 1.0, roleSummary);
        } else if (entity.kind === 'household' && entity.label) {
          const h = _db().findHouseholdByMention(entity.label) || _db().upsertHouseholdByName(entity.label);
          if (h) _db().linkPageToHousehold(pageId, h.id, entity.confidence ?? 0.9, roleSummary);
        } else if (entity.kind === 'person' && entity.label) {
          const p = _db().upsertPerson({ label: entity.label });
          _db().linkPageToPerson(pageId, p.id, 1.0, roleSummary);
        } else if (entity.kind === 'topic' && entity.label) {
          const id = crypto.randomUUID();
          _db().upsertEntity({ id, kind: 'topic', label: entity.label });
          const t = _db().getEntityByKindLabel('topic', entity.label);
          if (t) _db().insertLink({
            id: crypto.randomUUID(),
            from_type: 'page', from_id: pageId, to_type: 'topic', to_id: t.id,
            created_by: 'foxed-voice', confidence: 0.9,
            role_summary: roleSummary,
          });
        }
      } catch (e) { console.warn('voice entity skip:', e.message); }
    }

    const backlogRows = (parsed.backlog_items || []).map(b => ({
      id: crypto.randomUUID(),
      kind: b.kind,
      subject: b.subject,
      proposal: b.proposal,
      context_page_id: pageId,
      answer_format: b.kind === 'question' ? (b.answer_format || 'short') : null,
      answer_options: b.kind === 'question' && b.answer_format === 'choice' ? b.options : null,
    }));
    if (backlogRows.length) _db().insertBacklogItems(backlogRows);

    // File into the daily_log for the date (first-class, not a collection).
    let dl = _db().findDailyLogByDate(isoDate);
    if (!dl) dl = _db().createDailyLog({ id: crypto.randomUUID(), date: isoDate });
    _db().linkPageToDailyLog(pageId, dl.id, 1.0);

    // Fire-and-forget AI index classification.
    setImmediate(() => classifyPageForIndexesInBackground(pageId));

    res.json({
      ok: true,
      page_id: pageId,
      date: isoDate,
      summary: parsed.summary,
      items_count: itemRows.length,
      backlog_count: backlogRows.length,
      daily_log: { id: dl.id, date: isoDate },
    });
  } catch (err) {
    console.error('voice ingest failed:', err);
    res.status(500).json({ error: 'Voice ingest failed', detail: err.message });
  }
});

// Build a short text block describing recent pages' collection membership,
// so Gemini can detect continuations. Used on every ingest.
function buildPriorContext(contextPages) {
  if (!contextPages || contextPages.length === 0) return '';
  const lines = contextPages.map(p => {
    const vol = p.volume ? `v.${p.volume} ` : '';
    const pg = p.page_number != null ? `p.${p.page_number}` : 'p.?';
    const collections = p.collections ? ` → ${p.collections.replace(/\|/g, ', ')}` : '';
    const summary = p.summary ? ` — ${p.summary}` : '';
    return `- ${vol}${pg}${collections}${summary}`;
  });
  return lines.join('\n');
}

// Assign a page to collections based on Gemini's collection_hints.
// Creates collections on demand, links page↔collection, queues backlog for low-confidence guesses.
function assignPageToCollections(pageId, hints) {
  const linkedCollections = [];
  const linkedDailyLogs = [];
  const backlogRows = [];

  for (const hint of (hints || [])) {
    if (!hint.label || !hint.kind) continue;
    const normalized = normalizeCollectionLabel(hint.kind, hint.label);
    if (!normalized) continue;

    // Daily logs are no longer collections — route them into the daily_logs table.
    if (hint.kind === 'daily_log') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) continue;
      let dl = _db().findDailyLogByDate(normalized);
      if (!dl) dl = _db().createDailyLog({ id: crypto.randomUUID(), date: normalized });
      _db().linkPageToDailyLog(pageId, dl.id, hint.confidence ?? 1.0);
      linkedDailyLogs.push(dl);
      if ((hint.confidence ?? 1.0) < 0.7) {
        backlogRows.push({
          id: crypto.randomUUID(), kind: 'filing',
          subject: `Confirm this page belongs to the daily log for ${normalized}`,
          proposal: `I filed this page under the ${normalized} daily log at ${Math.round((hint.confidence ?? 0) * 100)}% confidence.`,
          context_page_id: pageId,
        });
      }
      continue;
    }

    let collection = _db().findCollection(hint.kind, normalized);
    let _created = false;
    if (!collection) {
      collection = _db().createCollection({
        id: crypto.randomUUID(),
        kind: hint.kind,
        title: normalized,
      });
      _created = true;
    }
    _db().linkPageToCollection(pageId, collection.id, hint.confidence ?? 1.0);
    linkedCollections.push({ ...collection, _created });

    // Low confidence → queue for review
    if ((hint.confidence ?? 1.0) < 0.7) {
      backlogRows.push({
        id: crypto.randomUUID(),
        kind: 'filing',
        subject: `Confirm this page belongs to ${hint.kind}: "${normalized}"`,
        proposal: hint.continuation
          ? `This page appears to continue "${normalized}" but the header is absent. Confirm or reassign.`
          : `I filed this page under "${normalized}" at ${Math.round((hint.confidence ?? 0) * 100)}% confidence.`,
        context_page_id: pageId,
      });
    }
  }

  if (backlogRows.length) _db().insertBacklogItems(backlogRows);
  return { linkedCollections, linkedDailyLogs, extraBacklog: backlogRows };
}

// Auto-populate books from parsed hints. For each hint: find an existing book
// by title+author (case-insensitive), create one if needed (resolving author to a
// topic entity so it threads with other Topic mentions), and link the page.
// Low-confidence hints also queue a backlog filing question so the user can confirm.
function assignPageToBooks(pageId, hints, parsedSummary) {
  const linkedBooks = [];
  const backlogRows = [];
  for (const hint of (hints || [])) {
    const title = (hint.title || '').trim();
    if (!title) continue;
    const authorLabel = (hint.author_label || '').trim() || null;
    const year = (hint.year || '').trim() || null;

    const existing = _db().listBooks().find(b =>
      b.title.toLowerCase() === title.toLowerCase() &&
      (b.author_entity_label || b.author_label || '').toLowerCase() === (authorLabel || '').toLowerCase()
    );

    let bookId;
    if (existing) bookId = existing.id;
    else {
      let authorEntityId = null;
      if (authorLabel) {
        const existingTopic = _db().getEntityByKindLabel('topic', authorLabel);
        if (existingTopic) authorEntityId = existingTopic.id;
        else {
          const e = _db().upsertEntity({ id: crypto.randomUUID(), kind: 'topic', label: authorLabel });
          authorEntityId = e.id;
        }
      }
      const book = _db().createBook({
        id: crypto.randomUUID(), title, author_entity_id: authorEntityId, author_label: authorLabel, year, notes: null,
      });
      bookId = book.id;
    }
    _db().linkPageToBook(pageId, bookId, parsedSummary || null, hint.confidence ?? 1.0);
    linkedBooks.push({ id: bookId, title, author_label: authorLabel });

    if ((hint.confidence ?? 1.0) < 0.7) {
      backlogRows.push({
        id: crypto.randomUUID(), kind: 'filing',
        subject: `Confirm this page is notes on book: "${title}"${authorLabel ? ' — ' + authorLabel : ''}`,
        proposal: `I filed this page as notes on "${title}" at ${Math.round((hint.confidence ?? 0) * 100)}% confidence. Confirm or reassign.`,
        context_page_id: pageId,
      });
    }
  }
  if (backlogRows.length) _db().insertBacklogItems(backlogRows);
  return { linkedBooks, extraBacklog: backlogRows };
}

function assignPageToArtifacts(pageId, hints, parsedSummary) {
  const linkedArtifacts = [];
  const backlogRows = [];
  for (const hint of (hints || [])) {
    const title = (hint.title || '').trim();
    if (!title) continue;
    const existing = _db().listArtifacts().find(a => a.title.toLowerCase() === title.toLowerCase());
    let artifactId;
    let _created = false;
    if (existing) artifactId = existing.id;
    else {
      const a = _db().createArtifact({
        id: crypto.randomUUID(), title,
        drawer: (hint.drawer || '').trim() || null,
        hanging_folder: (hint.hanging_folder || '').trim() || null,
        manila_folder: (hint.manila_folder || '').trim() || null,
        status: 'in_progress',
        external_url: null,
      });
      artifactId = a.id;
      _created = true;
    }
    _db().linkBetween({ from_type: 'page', from_id: pageId, to_type: 'artifact', to_id: artifactId });
    linkedArtifacts.push({ id: artifactId, title, _created });

    if ((hint.confidence ?? 1.0) < 0.7) {
      backlogRows.push({
        id: crypto.randomUUID(), kind: 'filing',
        subject: `Confirm this page is an artifact: "${title}"`,
        proposal: `I filed this page as artifact "${title}" at ${Math.round((hint.confidence ?? 0) * 100)}% confidence. Confirm or reassign.`,
        context_page_id: pageId,
      });
    }
  }
  if (backlogRows.length) _db().insertBacklogItems(backlogRows);
  return { linkedArtifacts, extraBacklog: backlogRows };
}

function assignPageToReferences(pageId, hints, parsedSummary, scanRelPath, userKindHint) {
  const linkedReferences = [];
  const backlogRows = [];
  // When the user declared kind=reference, treat each page as its own distinct
  // resource (Zettelkasten / note-card mode): skip title dedup and attach the
  // scan so the reference is viewable. Fall back to creating one from the page
  // summary if Gemini emitted no hints.
  const isCardMode = userKindHint === 'reference';

  const hintsToProcess = (hints || []).filter(h => (h.title || '').trim());

  if (isCardMode && hintsToProcess.length === 0) {
    const fallbackTitle = (parsedSummary || '').trim() || 'Untitled note card';
    const r = _db().createReference({
      id: crypto.randomUUID(),
      title: fallbackTitle,
      source: null,
      file_path: scanRelPath || null,
      external_url: null,
      note: null,
    });
    _db().linkBetween({ from_type: 'page', from_id: pageId, to_type: 'reference', to_id: r.id });
    linkedReferences.push({ id: r.id, title: fallbackTitle, _created: true });
    if (backlogRows.length) _db().insertBacklogItems(backlogRows);
    return { linkedReferences, extraBacklog: backlogRows };
  }

  for (const hint of hintsToProcess) {
    const title = hint.title.trim();
    let refId;
    let _created = false;
    if (isCardMode) {
      // One reference per page — never deduplicate.
      const r = _db().createReference({
        id: crypto.randomUUID(), title,
        source: (hint.source || '').trim() || null,
        file_path: scanRelPath || null,
        external_url: (hint.external_url || '').trim() || null,
        note: null,
      });
      refId = r.id;
      _created = true;
    } else {
      const existing = _db().listReferences().find(r => r.title.toLowerCase() === title.toLowerCase());
      if (existing) refId = existing.id;
      else {
        const r = _db().createReference({
          id: crypto.randomUUID(), title,
          source: (hint.source || '').trim() || null,
          file_path: null,
          external_url: (hint.external_url || '').trim() || null,
          note: null,
        });
        refId = r.id;
        _created = true;
      }
    }
    _db().linkBetween({ from_type: 'page', from_id: pageId, to_type: 'reference', to_id: refId });
    linkedReferences.push({ id: refId, title, _created });

    if ((hint.confidence ?? 1.0) < 0.7) {
      backlogRows.push({
        id: crypto.randomUUID(), kind: 'filing',
        subject: `Confirm this page annotates reference: "${title}"`,
        proposal: `I filed this page as reference "${title}" at ${Math.round((hint.confidence ?? 0) * 100)}% confidence. Confirm or reassign.`,
        context_page_id: pageId,
      });
    }
  }
  if (backlogRows.length) _db().insertBacklogItems(backlogRows);
  return { linkedReferences, extraBacklog: backlogRows };
}

function normalizeCollectionLabel(kind, label) {
  const trimmed = String(label).trim();
  if (kind === 'daily_log') {
    // Accept ISO-ish dates; otherwise pass through
    const m = trimmed.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return trimmed;
  }
  if (kind === 'monthly_log') {
    const m = trimmed.match(/(\d{4})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
    return trimmed;
  }
  // topical / index / future_log — title-case, collapse whitespace
  return trimmed.replace(/\s+/g, ' ');
}

async function ingestSingleImage(imagePath, scanRelPath, { priorContextPages, documentOutline, userKindHint, volumeOverride } = {}) {
  // Fall back to querying DB if no context was passed (single-image ingest path)
  const contextPages = priorContextPages ?? _db().getRecentPagesForContext(null, null, 5);
  const priorContext = buildPriorContext(contextPages);

  const recentAnswered = _db().getRecentAnsweredQuestions(150);
  const knownHouseholds = _db().listHouseholds().filter(h => !h.archived_at).map(h => h.name);
  const knownAliases = _db().getKnownAliases();
  const handwritingCorrections = _db().getHandwritingCorrections();
  const notebookGlossary = _db().getGlossary();
  const parsed = await parsePageImage(imagePath, priorContext, recentAnswered, documentOutline || '', userKindHint || null, knownHouseholds, knownAliases, handwritingCorrections, notebookGlossary);
  const parsedPages = Array.isArray(parsed.pages) && parsed.pages.length > 0 ? parsed.pages : [parsed];

  const pageResults = parsedPages.map((pp, idx) =>
    savePageFromParse(pp, scanRelPath, parsedPages.length > 1 ? idx : null, parsedPages.length, { volumeOverride, userKindHint })
  );

  // Fire-and-forget auto-classification against AI indexes for each new page.
  for (const pr of pageResults) {
    if (pr && pr.page_id) setImmediate(() => classifyPageForIndexesInBackground(pr.page_id));
  }

  const items_count = pageResults.reduce((s, r) => s + r.items_count, 0);
  const backlog_count = pageResults.reduce((s, r) => s + r.backlog_count, 0);

  return {
    pages: pageResults,
    is_multi: parsedPages.length > 1,
    items_count,
    backlog_count,
    scan_url: scanRelPath,
  };
}

function sourceKindForIndex(idx, total) {
  if (idx == null || total === 1) return null;
  if (total === 2) return idx === 0 ? 'spread_left' : 'spread_right';
  return `scan_part_${idx + 1}_of_${total}`;
}

// Valid item statuses (see ai.js PARSE_PROMPT "BULLET-JOURNAL GLYPH GRAMMAR").
// NULL is allowed too — means "Gemini didn't detect a glyph, treat as default."
const _VALID_ITEM_STATUS = new Set(['open', 'done', 'migrated', 'scheduled', 'cancelled', 'note']);
function _normalizeItemStatus(status, kind) {
  if (status == null) return null;
  const s = String(status).trim().toLowerCase();
  if (_VALID_ITEM_STATUS.has(s)) return s;
  return null;
}

// Resolve `page_refs` from parse output into actual page→page links.
// RULE: Page links are intra-volume. A bare "p.N" inherits fromPage.volume.
// An explicit "v.X p.N" uses the written volume. If neither is available
// (e.g. fromPage has no volume — voice memos), we skip the ref entirely —
// never cross-volume-fallback.
function resolvePageRefsForPage(fromPageId, fromVolume, pageRefs) {
  if (!Array.isArray(pageRefs) || pageRefs.length === 0) return { linked: 0, pending: 0 };
  let linked = 0, pending = 0;
  const pendingBacklog = [];
  for (const ref of pageRefs) {
    const pn = typeof ref.page_number === 'number' ? ref.page_number : parseInt(String(ref.page_number || '').trim(), 10);
    if (!Number.isFinite(pn)) continue;
    const vol = (ref.volume && String(ref.volume).trim()) || (fromVolume && String(fromVolume).trim()) || null;
    if (!vol) continue; // no volume context — can't safely link
    const role = (ref.role_summary || '').trim() || null;
    const target = _db().findPageByVolumeAndNumber(vol, pn);
    if (target && target.id && target.id !== fromPageId) {
      try {
        _db().linkBetween({
          from_type: 'page', from_id: fromPageId,
          to_type: 'page', to_id: target.id,
          role_summary: role,
        });
        linked++;
      } catch (_err) { /* dup — skip silently */ }
    } else if (!target) {
      // Defer — subject stamps the resolved (volume, page_number) tuple so
      // the retroactive resolver can match a single subject shape exactly.
      pendingBacklog.push({
        id: crypto.randomUUID(),
        kind: 'link_proposal',
        subject: `Pending page-ref: v.${vol} p.${pn}`,
        proposal: `Cross-reference to v.${vol} p.${pn}${role ? ` — ${role}` : ''}. Auto-links when that page is ingested.`,
        context_page_id: fromPageId,
      });
      pending++;
    }
  }
  if (pendingBacklog.length) _db().insertBacklogItems(pendingBacklog);
  return { linked, pending };
}

// When a new page lands, find pending `link_proposal` rows whose target
// (volume, page_number) matches this new page, and promote each into a real link.
// RULE: target volume in the subject === new page's volume. No cross-volume resolution.
function resolvePendingPageRefsTowards(newPage) {
  if (!newPage || newPage.page_number == null) return 0;
  const vol = newPage.volume || null;
  if (!vol) return 0; // no volume, nothing can target this page intra-volume
  const rows = _db().findPendingPageRefProposals(newPage.page_number, vol);
  if (!rows || rows.length === 0) return 0;
  let resolved = 0;
  for (const r of rows) {
    if (!r.context_page_id || r.context_page_id === newPage.id) continue;
    const fromPage = _db().getPage(r.context_page_id);
    if (!fromPage) continue;
    try {
      _db().linkBetween({
        from_type: 'page', from_id: fromPage.id,
        to_type: 'page', to_id: newPage.id,
        role_summary: _extractRoleFromProposal(r.proposal),
      });
      _db().updateBacklogStatus(r.id, 'answered', 'Auto-linked on page ingest.');
      resolved++;
    } catch (_err) { /* skip */ }
  }
  return resolved;
}
function _extractRoleFromProposal(proposal) {
  if (!proposal) return null;
  const m = String(proposal).match(/—\s*(.*?)\.\s+Auto-links/);
  return m ? m[1].trim() : null;
}

function savePageFromParse(parsed, scanRelPath, idx, total, { volumeOverride, userKindHint } = {}) {
  const pageId = crypto.randomUUID();
  const sourceKind = sourceKindForIndex(idx, total);

  // If the ingest form provided a volume label, it wins over AI-detected volume.
  const effectiveVolume = (volumeOverride && String(volumeOverride).trim())
    ? String(volumeOverride).trim()
    : parsed.volume;

  if (effectiveVolume && parsed.page_number) {
    const existing = _db().getPageByLocation(effectiveVolume, parsed.page_number);
    if (existing) {
      console.warn(`[ingest] duplicate: page already exists at ${effectiveVolume} p.${parsed.page_number} (id=${existing.id}). Run POST /api/admin/dedup-pages to clean up.`);
    }
  }

  _db().insertPage({
    id: pageId,
    volume: effectiveVolume,
    page_number: parsed.page_number,
    scan_path: scanRelPath,
    raw_ocr_text: parsed.raw_ocr_text,
    summary: parsed.summary,
    source_kind: sourceKind,
    continued_from: parsed.continued_from ?? null,
    continued_to: parsed.continued_to ?? null,
  });

  const itemRows = (parsed.items || []).map(item => ({
    id: crypto.randomUUID(),
    page_id: pageId,
    kind: item.kind,
    text: item.text,
    confidence: item.confidence ?? 1.0,
    status: _normalizeItemStatus(item.status, item.kind),
  }));
  if (itemRows.length) _db().insertItems(itemRows);

  for (const entity of (parsed.entities || [])) {
    const entId = crypto.randomUUID();
    _db().upsertEntity({ id: entId, kind: entity.kind, label: entity.label });
    const roleSummary = (entity.role_summary || '').trim() || null;

    if (entity.kind === 'scripture' && entity.book && entity.chapter) {
      const ref = _db().upsertScriptureRef({
        canonical: entity.label,
        book: entity.book,
        chapter: entity.chapter,
        verse_start: entity.verse_start ?? null,
        verse_end: entity.verse_end ?? null,
      });
      _db().linkPageToScripture(pageId, ref.id, 1.0, roleSummary);
    } else if (entity.kind === 'household' && entity.label) {
      const h = _db().findHouseholdByMention(entity.label) || _db().upsertHouseholdByName(entity.label);
      if (h) _db().linkPageToHousehold(pageId, h.id, entity.confidence ?? 0.9, roleSummary);
    } else if (entity.kind === 'person' && entity.label) {
      const resolved = resolvePersonReference(entity.label, pageId, parsed.summary);
      if (resolved.person) _db().linkPageToPerson(pageId, resolved.person.id, 1.0, roleSummary);
      if (resolved.backlog) _db().insertBacklogItems([resolved.backlog]);
    } else if (entity.kind === 'topic' && entity.label) {
      const topic = _db().getEntityByKindLabel('topic', entity.label);
      if (topic) {
        _db().insertLink({
          id: crypto.randomUUID(),
          from_type: 'page', from_id: pageId,
          to_type: 'topic', to_id: topic.id,
          created_by: 'foxed', confidence: 0.9,
          role_summary: roleSummary,
        });
      }
    }
  }

  const backlogRows = (parsed.backlog_items || []).map(b => ({
    id: crypto.randomUUID(),
    kind: b.kind,
    subject: b.subject,
    proposal: b.proposal,
    context_page_id: pageId,
    answer_format: b.kind === 'question' ? (b.answer_format || 'short') : null,
    answer_options: b.kind === 'question' && b.answer_format === 'choice' ? b.options : null,
  }));
  if (backlogRows.length) _db().insertBacklogItems(backlogRows);

  const { linkedCollections, linkedDailyLogs, extraBacklog } = assignPageToCollections(pageId, parsed.collection_hints);
  const { linkedBooks, extraBacklog: bookBacklog } = assignPageToBooks(pageId, parsed.book_hints, parsed.summary);
  const { linkedArtifacts, extraBacklog: artifactBacklog } = assignPageToArtifacts(pageId, parsed.artifact_hints, parsed.summary);
  const { linkedReferences, extraBacklog: referenceBacklog } = assignPageToReferences(pageId, parsed.reference_hints, parsed.summary, scanRelPath, userKindHint);

  // Threading: if the AI saw "→ p.N" / "← from p.N" markers or flagged this page
  // as a mid-thought continuation, stitch this page's collections/daily-logs with
  // any same-volume neighbors (in either order) so a thread spanning p.200→p.201
  // stays one collection instead of getting split.
  const anyContinuation = (parsed.collection_hints || []).some(h => h && h.continuation);
  _db().applyThreadingForPage(pageId, { continuation: anyContinuation });

  // Cross-kind auto-linking: for every newly-CREATED collection / artifact / reference
  // from this save, schedule a classifier pass. Fire-and-forget via setImmediate so
  // the ingest tail never awaits an AI call (invariant: savePageFromParse must not block).
  for (const c of linkedCollections) {
    if (c && c._created) scheduleCrossKindClassify('collection', c.id);
  }
  for (const a of linkedArtifacts) {
    if (a && a._created) scheduleCrossKindClassify('artifact', a.id);
  }
  for (const r of linkedReferences) {
    if (r && r._created) scheduleCrossKindClassify('reference', r.id);
  }

  // Phase 7: cross-page references. Resolve every page_refs entry into a
  // page→page link (if target exists) or a pending backlog row (if not yet ingested).
  // Also check whether this new page is the target of any prior pending proposals.
  const pageRefResolution = resolvePageRefsForPage(pageId, effectiveVolume, parsed.page_refs);
  const retroResolved = resolvePendingPageRefsTowards({ id: pageId, volume: effectiveVolume, page_number: parsed.page_number });

  const result = {
    page_id: pageId,
    id: pageId,
    summary: parsed.summary,
    volume: effectiveVolume,
    page_number: parsed.page_number,
    items_count: itemRows.length,
    backlog_count: backlogRows.length + extraBacklog.length + bookBacklog.length + artifactBacklog.length + referenceBacklog.length,
    scan_url: scanRelPath,
    source_kind: sourceKind,
    collections: linkedCollections.map(c => ({ id: c.id, kind: c.kind, title: c.title })),
    daily_logs: (linkedDailyLogs || []).map(d => ({ id: d.id, date: d.date })),
    books: linkedBooks,
    artifacts: linkedArtifacts,
    references: linkedReferences,
    items: itemRows,
    backlog_items: backlogRows,
    page_refs_linked: pageRefResolution.linked,
    page_refs_pending: pageRefResolution.pending,
    retro_page_refs_resolved: retroResolved,
  };

  return result;
}

// Tunables for PDF ingest performance. All preserve legibility:
// - DPI stays high so scan quality is not degraded.
// - Render concurrency = how many pdftoppm processes run in parallel.
// - Parse concurrency = how many Gemini calls are in flight at once.
const PDF_DPI = 220;
const PDF_RENDER_CONCURRENCY = 4;
const PDF_PARSE_CONCURRENCY = 8;

async function ingestPdf(pdfPath, { userKindHint, volumeOverride, onPageComplete } = {}) {
  const jobId = crypto.randomUUID();
  const outPrefix = path.join(_scansDir(), jobId);
  const { spawn } = require('child_process');

  // 1. Probe page count so we can split the render into parallel chunks.
  let pageCount = 0;
  try {
    const { stdout } = await execFileAsync('pdfinfo', [pdfPath]);
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    if (m) pageCount = parseInt(m[1], 10);
  } catch (err) {
    throw new Error(`pdfinfo failed: ${err.stderr || err.message}`);
  }
  if (!pageCount) throw new Error('pdfinfo reported 0 pages');
  console.log(`  [PDF] ${pageCount} pages — rendering at ${PDF_DPI} DPI with ${PDF_RENDER_CONCURRENCY}-way parallelism`);

  // State shared across the render / probe / parse pipeline.
  const rollingContext = _db().getRecentPagesForContext(null, null, 3).map(ctxPageToHint);
  const resultsByScan = new Array(pageCount + 1).fill(null);
  const probeResultsByScan = new Array(pageCount + 1).fill(null);
  const enqueuedForProbe = new Set();
  const probeQueue = [];   // { scanNum, imagePath, scanRelPath }
  const parseQueue = [];   // { scanNum, imagePath, scanRelPath } — gated on probe done
  let renderDone = false;
  let totalItems = 0, totalBacklog = 0;

  const PROBE_CONCURRENCY = 8;

  function buildOutlineSnapshot(currentScan) {
    const lines = [];
    for (let n = 1; n <= pageCount; n++) {
      const probe = probeResultsByScan[n];
      const marker = n === currentScan ? '▶ ' : '  ';
      if (!probe || !probe.pages || probe.pages.length === 0) {
        lines.push(`${marker}scan ${n}: (header unknown)`);
        continue;
      }
      for (const pg of probe.pages) {
        const pn = pg.page_number != null ? ` p.${pg.page_number}` : '';
        const hdr = pg.header || '(no header)';
        const kind = pg.kind_guess && pg.kind_guess !== 'unclear' ? ` [${pg.kind_guess}]` : '';
        const cont = pg.continuation ? ' (continuation)' : '';
        const from = pg.continued_from != null ? ` ← from p.${pg.continued_from}` : '';
        const to = pg.continued_to != null ? ` → to p.${pg.continued_to}` : '';
        lines.push(`${marker}scan ${n}${pn}: ${hdr}${kind}${cont}${from}${to}`);
      }
    }
    return lines.join('\n');
  }

  async function probeWorker() {
    while (true) {
      if (probeQueue.length === 0) {
        if (renderDone) return;
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      const job = probeQueue.shift();
      let probed = null, probeErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { probed = await probePageHeader(job.imagePath); probeErr = null; break; }
        catch (e) {
          probeErr = e;
          const is429 = /429|RESOURCE_EXHAUSTED|rate/i.test(String(e.message || e));
          if (attempt === 2 || !is429) break;
          const waitMs = (attempt + 1) * 3000 + Math.floor(Math.random() * 500);
          console.warn(`  [PDF] probe ${job.scanNum} hit rate limit (attempt ${attempt + 1}) — retrying in ${waitMs}ms`);
          await new Promise(r => setTimeout(r, waitMs));
        }
      }
      if (probeErr && !probed) console.warn(`  [PDF] probe ${job.scanNum} failed:`, probeErr.message);
      probeResultsByScan[job.scanNum] = probed || { pages: [] };
      // Probe done → eligible for full parse.
      parseQueue.push(job);
    }
  }

  async function parseWorker() {
    while (true) {
      if (parseQueue.length === 0) {
        if (renderDone && probeQueue.length === 0) return;
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      const job = parseQueue.shift();
      try {
        const priorSlice = rollingContext.slice(0, 5);
        const documentOutline = buildOutlineSnapshot(job.scanNum);
        // Up to 2 retries with linear backoff — guards against 429s now that
        // PDF_PARSE_CONCURRENCY is higher than the old 4-way ceiling.
        let result, lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            result = await ingestSingleImage(job.imagePath, job.scanRelPath, {
              priorContextPages: priorSlice,
              documentOutline,
              userKindHint,
              volumeOverride,
            });
            break;
          } catch (e) {
            lastErr = e;
            const msg = String(e.message || e);
            const is429 = /429|RESOURCE_EXHAUSTED|rate/i.test(msg);
            if (attempt === 2 || !is429) throw e;
            const waitMs = (attempt + 1) * 4000 + Math.floor(Math.random() * 1000);
            console.warn(`  [PDF] scan ${job.scanNum} hit rate limit (attempt ${attempt + 1}) — retrying in ${waitMs}ms`);
            await new Promise(r => setTimeout(r, waitMs));
          }
        }
        if (!result) throw lastErr || new Error('parse failed');
        resultsByScan[job.scanNum] = result.pages;
        totalItems += result.items_count;
        totalBacklog += result.backlog_count;
        console.log(`  [PDF] parsed scan ${job.scanNum}/${pageCount} → ${result.pages.length} logical page(s)`);
        if (typeof onPageComplete === 'function') {
          for (const pr of result.pages) {
            try { onPageComplete({ ...pr, scan_num: job.scanNum, total_scans: pageCount }); }
            catch (e) { console.warn('  [PDF] onPageComplete threw:', e.message); }
          }
        }
        for (const pr of result.pages) {
          rollingContext.unshift({
            volume: pr.volume,
            page_number: pr.page_number,
            summary: pr.summary,
            collections: (pr.collections || []).map(c => `${c.kind}:${c.title}`).join('|'),
          });
        }
        if (rollingContext.length > 20) rollingContext.length = 20;
      } catch (err) {
        console.error(`  [PDF] scan ${job.scanNum} failed:`, err.message);
        resultsByScan[job.scanNum] = [{ error: err.message, scan_url: job.scanRelPath, page_index: job.scanNum }];
        try {
          _db().recordIngestFailure({
            scan_path: job.scanRelPath,
            source: 'pdf',
            stage: 'parse',
            error: err.message || String(err),
            volume: volumeOverride || null,
          });
        } catch (e) { console.error('  [PDF] failed to record failure:', e.message); }
      }
    }
  }

  // Render: split the page range into chunks and spawn parallel pdftoppm processes.
  // As each PNG appears on disk, push it into the probe queue.
  async function renderChunk([firstPage, lastPage]) {
    const args = ['-png', '-r', String(PDF_DPI), '-f', String(firstPage), '-l', String(lastPage), pdfPath, outPrefix];
    const child = spawn('pdftoppm', args);

    const pollHandle = setInterval(() => {
      for (let n = firstPage; n <= lastPage; n++) {
        if (enqueuedForProbe.has(n)) continue;
        const filename = `${jobId}-${pdftoppmSuffix(n, pageCount)}.png`;
        const fullPath = path.join(_scansDir(), filename);
        if (!fs.existsSync(fullPath)) continue;
        // Consider the file "closed" if the next one exists OR pdftoppm has exited.
        const nextExists = n < lastPage && fs.existsSync(path.join(_scansDir(), `${jobId}-${pdftoppmSuffix(n + 1, pageCount)}.png`));
        const childDone = child.exitCode !== null;
        if (nextExists || childDone) {
          enqueuedForProbe.add(n);
          probeQueue.push({ scanNum: n, imagePath: fullPath, scanRelPath: `/scans/${filename}` });
        }
      }
    }, 200);

    await new Promise((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', code => {
        clearInterval(pollHandle);
        for (let n = firstPage; n <= lastPage; n++) {
          if (enqueuedForProbe.has(n)) continue;
          const filename = `${jobId}-${pdftoppmSuffix(n, pageCount)}.png`;
          const fullPath = path.join(_scansDir(), filename);
          if (fs.existsSync(fullPath)) {
            enqueuedForProbe.add(n);
            probeQueue.push({ scanNum: n, imagePath: fullPath, scanRelPath: `/scans/${filename}` });
          }
        }
        if (code !== 0) reject(new Error(`pdftoppm chunk ${firstPage}-${lastPage} exited ${code}: ${stderr}`));
        else resolve();
      });
    });
  }

  const chunks = [];
  const chunkSize = Math.ceil(pageCount / PDF_RENDER_CONCURRENCY);
  for (let start = 1; start <= pageCount; start += chunkSize) {
    chunks.push([start, Math.min(start + chunkSize - 1, pageCount)]);
  }

  // Kick off probe + parse pools first so they're ready as soon as pages render.
  const probeResolvers = [];
  const parseResolvers = [];
  for (let i = 0; i < PROBE_CONCURRENCY; i++) probeResolvers.push(probeWorker());
  for (let i = 0; i < PDF_PARSE_CONCURRENCY; i++) parseResolvers.push(parseWorker());

  try {
    await Promise.all(chunks.map(renderChunk));
  } finally {
    renderDone = true;
  }
  await Promise.all(probeResolvers);
  await Promise.all(parseResolvers);

  const pages = [];
  for (let n = 1; n <= pageCount; n++) {
    if (resultsByScan[n]) pages.push(...resultsByScan[n]);
  }

  try { fs.unlinkSync(pdfPath); } catch {}

  return {
    kind: 'pdf',
    page_count: pages.length,
    items_count: totalItems,
    backlog_count: totalBacklog,
    pages,
  };
}

// pdftoppm zero-pads its page suffix to the width of the PDF's total page count.
// A 9-page PDF produces -1…-9, a 10-page PDF produces -01…-10, a 100-page PDF -001…-100.
function pdftoppmSuffix(pageNum, totalPages) {
  const width = String(totalPages).length;
  return String(pageNum).padStart(width, '0');
}

function ctxPageToHint(p) {
  return {
    volume: p.volume,
    page_number: p.page_number,
    summary: p.summary,
    collections: p.collections || '',
  };
}

// ── GET /api/search/items ───────────────────────────────────────────────────
// Legacy item-only search (kept for back-compat with any older clients). The
// new global Cmd-K search is at GET /api/search.
app.get('/api/search/items', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });

  let results;
  try {
    results = _db().searchItems(q);
  } catch {
    // Fall back to LIKE if FTS syntax is bad
    results = _db().getAllItems().filter(i => i.text.toLowerCase().includes(q.toLowerCase()));
  }
  if (!results || results.length === 0) {
    results = _db().getAllItems().filter(i => i.text.toLowerCase().includes(q.toLowerCase()));
  }

  res.json({ results: results.map(formatItem) });
});

// ── POST /api/chat ──────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });

  // Parse @mentions → concrete entities; strip only the resolved ones from the search text.
  const mentionTokens = Array.from(query.matchAll(/@([A-Za-z0-9_\-]+)/g)).map(m => m[1]);
  const resolvedMentions = [];
  const unresolvedMentions = [];
  for (const tok of mentionTokens) {
    const hit = _db().resolveMentionTarget(tok);
    if (hit) resolvedMentions.push(hit);
    else unresolvedMentions.push(tok);
  }

  // Remainder of the query (mentions stripped) drives FTS.
  const searchQuery = query.replace(/@[A-Za-z0-9_\-]+/g, '').trim();
  const qLower = searchQuery.toLowerCase();
  let contextItems = [];

  const today = new Date();
  const isoOf = (d) => d.toISOString().slice(0, 10);
  const dateScoped = [];
  if (/\btoday\b/.test(qLower))       dateScoped.push(isoOf(today));
  if (/\byesterday\b/.test(qLower))   { const d = new Date(today); d.setDate(d.getDate() - 1); dateScoped.push(isoOf(d)); }
  const explicit = qLower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (explicit) dateScoped.push(explicit[1]);

  for (const iso of dateScoped) {
    contextItems.push(..._db().getItemsCapturedOn(iso, 20));
  }

  // @mention scoping — pull every item on every page linked to each resolved entity.
  for (const m of resolvedMentions) {
    contextItems.push(..._db().getItemsLinkedToEntity(m.kind, m.id, 40));
  }

  // Unresolved mentions fall back to a LIKE match on their label (may still hit real text).
  for (const tok of unresolvedMentions) {
    const label = tok.replace(/[_-]+/g, ' ');
    const likeHits = _db().getAllItems(200).filter(i => i.text.toLowerCase().includes(label.toLowerCase()));
    contextItems.push(...likeHits.slice(0, 20));
  }

  if (searchQuery) {
    let ftsHits = [];
    try {
      ftsHits = _db().searchItems(searchQuery, 10);
    } catch {
      ftsHits = _db().getAllItems(50).filter(i => i.text.toLowerCase().includes(qLower));
    }
    if (!ftsHits || ftsHits.length === 0) {
      ftsHits = _db().getAllItems(50).filter(i => i.text.toLowerCase().includes(qLower));
    }
    contextItems.push(...ftsHits);
  }

  // Fallback: no date scope, no mentions, and no FTS hits → recent items.
  if (contextItems.length === 0 && resolvedMentions.length === 0 && unresolvedMentions.length === 0) {
    contextItems = _db().getAllItems(10);
  }

  // Dedupe by id
  const seen = new Set();
  contextItems = contextItems.filter(i => !seen.has(i.id) && seen.add(i.id)).slice(0, 15);

  // Nothing made it through scoping, FTS, or fallback — short-circuit before
  // burning a Gemini call and give the user actionable next-step guidance.
  if (contextItems.length === 0) {
    return res.json({
      response: "No matching notes yet. Try a broader word, an @person, @scripture, or YYYY-MM-DD.",
      context_items: [],
      empty: true,
    });
  }

  let response;
  try {
    response = await chat(query, contextItems, _db().getGlossary());
  } catch (err) {
    return res.status(500).json({ error: 'Chat failed', detail: err.message });
  }

  res.json({
    response,
    context_items: contextItems.map(formatItem),
  });
});

// ── Chat assistant (Phase 4.5) ──────────────────────────────────────────────
// Multi-turn sessions with memory + bounded action proposals.
// Session list / detail / create / delete:
app.get('/api/chat/sessions', (req, res) => {
  res.json({ items: _db().listChatSessions() });
});
app.post('/api/chat/sessions', (req, res) => {
  const { title, pinned_page_id } = req.body || {};
  const s = _db().createChatSession({ id: crypto.randomUUID(), title, pinned_page_id });
  res.json(s);
});
app.get('/api/chat/sessions/:id', (req, res) => {
  const s = _db().getChatSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});
app.delete('/api/chat/sessions/:id', (req, res) => {
  _db().deleteChatSession(req.params.id);
  res.json({ ok: true });
});

// Build the per-turn context: resolve @mentions + FTS hits + date scoping.
// Mirrors the legacy /api/chat path so behavior is consistent.
function _buildChatContext(query) {
  const mentionTokens = Array.from(query.matchAll(/@([A-Za-z0-9_\-]+)/g)).map(m => m[1]);
  const resolvedMentions = [];
  for (const tok of mentionTokens) {
    const hit = _db().resolveMentionTarget(tok);
    if (hit) resolvedMentions.push(hit);
  }
  const searchQuery = query.replace(/@[A-Za-z0-9_\-]+/g, '').trim();
  const qLower = searchQuery.toLowerCase();
  let contextItems = [];
  const today = new Date();
  const isoOf = (d) => d.toISOString().slice(0, 10);
  const dateScoped = [];
  if (/\btoday\b/.test(qLower)) dateScoped.push(isoOf(today));
  if (/\byesterday\b/.test(qLower)) { const d = new Date(today); d.setDate(d.getDate() - 1); dateScoped.push(isoOf(d)); }
  const explicit = qLower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (explicit) dateScoped.push(explicit[1]);
  for (const iso of dateScoped) contextItems.push(..._db().getItemsCapturedOn(iso, 20));
  for (const m of resolvedMentions) contextItems.push(..._db().getItemsLinkedToEntity(m.kind, m.id, 40));
  if (searchQuery) {
    let ftsHits = [];
    try { ftsHits = _db().searchItems(searchQuery, 10); }
    catch { ftsHits = _db().getAllItems(50).filter(i => i.text.toLowerCase().includes(qLower)); }
    if (!ftsHits || ftsHits.length === 0) ftsHits = _db().getAllItems(50).filter(i => i.text.toLowerCase().includes(qLower));
    contextItems.push(...ftsHits);
  }
  if (contextItems.length === 0) contextItems = _db().getAllItems(10);
  const seen = new Set();
  return contextItems.filter(i => !seen.has(i.id) && seen.add(i.id)).slice(0, 15);
}

// Validate an action proposal against a small per-action schema. Returns
// {ok: true} or {ok: false, error: '...'}. Hand-rolled (no Zod) per stop-ship #9.
function _validateAction(action) {
  if (!action || typeof action !== 'object') return { ok: false, error: 'action missing' };
  const { name, args } = action;
  if (typeof name !== 'string') return { ok: false, error: 'action.name must be a string' };
  if (!args || typeof args !== 'object') return { ok: false, error: 'action.args must be an object' };
  const has = (k, t) => args[k] !== undefined && args[k] !== null && (t ? typeof args[k] === t : true);
  switch (name) {
    case 'rename_entity':
      if (!has('kind', 'string') || !has('id', 'string') || !has('new_label', 'string')) return { ok: false, error: 'rename_entity needs kind, id, new_label' };
      return { ok: true };
    case 'merge_entities':
      if (!has('kind', 'string') || !has('source_id', 'string') || !has('target_id', 'string')) return { ok: false, error: 'merge_entities needs kind, source_id, target_id' };
      return { ok: true };
    case 'add_person_alias':
      if (!has('person_id', 'string') || !has('alias', 'string')) return { ok: false, error: 'add_person_alias needs person_id, alias' };
      return { ok: true };
    case 'link_page_to_collection':
      if (!has('page_id', 'string') || !has('collection_id', 'string')) return { ok: false, error: 'link_page_to_collection needs page_id, collection_id' };
      return { ok: true };
    case 'unlink':
      if (!has('link_id', 'string')) return { ok: false, error: 'unlink needs link_id' };
      return { ok: true };
    case 'refine_page':
      if (!has('page_id', 'string') || !has('hint', 'string')) return { ok: false, error: 'refine_page needs page_id, hint' };
      return { ok: true };
    case 'edit_page_summary':
      if (!has('page_id', 'string') || !has('new_summary', 'string')) return { ok: false, error: 'edit_page_summary needs page_id, new_summary' };
      return { ok: true };
    case 'set_parent':
      if (!has('kind', 'string') || !has('id', 'string')) return { ok: false, error: 'set_parent needs kind, id (parent_id may be null to clear)' };
      return { ok: true };
    case 'remember':
      if (!has('key', 'string') || !has('value', 'string')) return { ok: false, error: 'remember needs key, value' };
      return { ok: true };
    default:
      return { ok: false, error: `unknown action: ${name}` };
  }
}

// Execute a validated action. Returns an observation string for the chat log.
async function _executeAction(action) {
  const { name, args } = action;
  switch (name) {
    case 'rename_entity': {
      const result = _db().renameOrMergeEntity(args.kind, args.id, args.new_label);
      if (result && result.merged) return `Merged "${args.new_label}" — destination kept, source rows re-pointed.`;
      return `Renamed to "${args.new_label}".`;
    }
    case 'merge_entities': {
      _db().mergeEntitiesInto(args.kind, args.source_id, args.target_id);
      return `Merged source into target.`;
    }
    case 'add_person_alias': {
      _db().addPersonAlias(args.person_id, args.alias);
      // Reexamine in background — fire-and-forget; mirror the backlog answer path.
      const matchPages = _db().findPagesMentioningAlias(args.alias).slice(0, 8);
      const person = _db().listPeople().find(p => p.id === args.person_id);
      const label = person ? person.label : args.alias;
      for (const p of matchPages) {
        reexaminePageInBackground(p.id, { kind: 'person', label });
      }
      return `Added alias "${args.alias}". Re-examining ${matchPages.length} page${matchPages.length === 1 ? '' : 's'} in the background.`;
    }
    case 'link_page_to_collection': {
      _db().linkBetween({ from_type: 'page', from_id: args.page_id, to_type: 'collection', to_id: args.collection_id });
      return `Linked page to collection.`;
    }
    case 'unlink': {
      _db().deleteLinkById(args.link_id);
      return `Removed the link.`;
    }
    case 'refine_page': {
      reexaminePageInBackground(args.page_id, { kind: 'hint', label: args.hint });
      return `Refining page in the background with the new hint.`;
    }
    case 'edit_page_summary': {
      _db().updatePageSummary(args.page_id, args.new_summary);
      return `Updated page summary.`;
    }
    case 'set_parent': {
      // Use the unified PATCH path so each kind picks up its parent semantics.
      // Topics use parent_id; collections use parent_id; people use household_id.
      const kind = args.kind;
      if (kind === 'topic')      _db().setTopicParent(args.id, args.parent_id || null);
      else if (kind === 'collection') _db().setCollectionParent(args.id, args.parent_id || null);
      else if (kind === 'person') _db().setPersonHousehold(args.id, args.parent_id || null);
      else if (kind === 'artifact') {
        const parent = args.parent_id ? _db().getArtifact(args.parent_id) : null;
        _db().updateArtifact(args.id, parent ? { drawer: parent.drawer, hanging_folder: parent.hanging_folder, manila_folder: parent.manila_folder } : {});
      }
      return `Set parent for ${kind}.`;
    }
    case 'remember': {
      _db().setChatMemory(args.key, args.value);
      return `Remembered ${args.key} = ${args.value}.`;
    }
    default:
      throw new Error(`unknown action: ${name}`);
  }
}

// Send a user message, get an assistant message back (text or action proposal).
app.post('/api/chat/sessions/:id/messages', async (req, res) => {
  const sessionId = req.params.id;
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body is required' });
  const session = _db().getChatSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const userMsg = _db().appendChatMessage({ session_id: sessionId, role: 'user', body: body.trim() });

  // Title the session from the first user message.
  if (!session.session.title) {
    const t = body.trim().slice(0, 60);
    _db().touchChatSession(sessionId, t);
  }

  const contextItems = _buildChatContext(body);
  const memory = _db().listChatMemory().slice(0, 50);
  const pinnedPage = session.session.pinned_page_id ? _db().getPage(session.session.pinned_page_id) : null;
  const history = [...session.messages, userMsg];

  let result;
  try {
    result = await chatWithActions({
      history,
      contextItems,
      notebookGlossary: _db().getGlossary(),
      memory,
      pinnedPage,
    });
  } catch (err) {
    const errMsg = _db().appendChatMessage({ session_id: sessionId, role: 'assistant', body: `(error: ${err.message || err})` });
    return res.json({ messages: [userMsg, errMsg] });
  }

  if (result.kind === 'action') {
    const validation = _validateAction(result.action);
    if (!validation.ok) {
      const errMsg = _db().appendChatMessage({
        session_id: sessionId, role: 'assistant',
        body: `I tried to propose an action but it failed validation: ${validation.error}. Could you rephrase?`
      });
      return res.json({ messages: [userMsg, errMsg] });
    }
    const proposal = JSON.stringify(result.action);
    const actionMsg = _db().appendChatMessage({
      session_id: sessionId, role: 'action',
      body: result.action.rationale || result.action.name,
      proposal_json: proposal,
      status: 'proposed',
    });
    return res.json({ messages: [userMsg, actionMsg] });
  }

  const assistantMsg = _db().appendChatMessage({ session_id: sessionId, role: 'assistant', body: result.text });
  res.json({
    messages: [userMsg, assistantMsg],
    context_items: contextItems.map(formatItem),
  });
});

// Accept / Reject a proposed action.
app.post('/api/chat/messages/:id/accept', async (req, res) => {
  const msg = _db().getChatMessage(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.role !== 'action' || msg.status !== 'proposed') {
    return res.status(400).json({ error: 'Message is not a pending action' });
  }
  let action;
  try { action = JSON.parse(msg.proposal_json); } catch { return res.status(400).json({ error: 'Invalid proposal JSON' }); }
  const validation = _validateAction(action);
  if (!validation.ok) return res.status(400).json({ error: validation.error });
  let observation;
  try {
    observation = await _executeAction(action);
    _db().setChatMessageStatus(req.params.id, 'executed');
  } catch (err) {
    _db().setChatMessageStatus(req.params.id, 'rejected');
    const errMsg = _db().appendChatMessage({
      session_id: msg.session_id, role: 'observation',
      body: `Action failed: ${err.message || err}`
    });
    return res.json({ ok: false, error: err.message, observation: errMsg });
  }
  const obsMsg = _db().appendChatMessage({
    session_id: msg.session_id, role: 'observation', body: `✅ ${observation}`
  });
  res.json({ ok: true, observation: obsMsg });
});
app.post('/api/chat/messages/:id/reject', (req, res) => {
  const msg = _db().getChatMessage(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.role !== 'action' || msg.status !== 'proposed') {
    return res.status(400).json({ error: 'Message is not a pending action' });
  }
  _db().setChatMessageStatus(req.params.id, 'rejected');
  const obsMsg = _db().appendChatMessage({
    session_id: msg.session_id, role: 'observation', body: '✖ Rejected.'
  });
  res.json({ ok: true, observation: obsMsg });
});

// Memory inspector — list / delete keys.
app.get('/api/chat/memory', (req, res) => res.json({ items: _db().listChatMemory() }));
app.delete('/api/chat/memory/:key', (req, res) => { _db().deleteChatMemory(req.params.key); res.json({ ok: true }); });

// ── GET /api/remember ───────────────────────────────────────────────────────
// One-a-day throwback: a random page from ~year/month/week ago (± 3 days).
app.get('/api/remember', (req, res) => {
  res.json(_db().getRememberFeed());
});

// ── GET /api/search ─────────────────────────────────────────────────────────
// Global Cmd-K search across pages, collections, people, scripture, topics, books.
// Each bucket limited to 5. Fires on every keystroke — keep it cheap.
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ pages: [], collections: [], people: [], scripture: [], topics: [], books: [] });
  res.json(_db().searchAll(q, 5));
});

// ── POST /api/artifacts/:id/fetch ───────────────────────────────────────────
// Re-run the Google fetch for an artifact. 400 if no external_url.
app.post('/api/artifacts/:id/fetch', async (req, res) => {
  const a = _db().getArtifact(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (!a.external_url) return res.status(400).json({ error: 'artifact has no external_url' });
  await fetchIfGoogle('artifact', a.id, a.external_url);
  const fresh = _db().getArtifact(a.id);
  res.json({ ok: true, fetched_at: fresh.fetched_at, fetched_error: fresh.fetched_error });
});

// ── POST /api/references/:id/fetch ──────────────────────────────────────────
app.post('/api/references/:id/fetch', async (req, res) => {
  const r = _db().getReference(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (!r.external_url) return res.status(400).json({ error: 'reference has no external_url' });
  await fetchIfGoogle('reference', r.id, r.external_url);
  const fresh = _db().getReference(r.id);
  res.json({ ok: true, fetched_at: fresh.fetched_at, fetched_error: fresh.fetched_error });
});

// ── GET /api/backlog ────────────────────────────────────────────────────────
app.get('/api/backlog', (req, res) => {
  res.json({ items: _db().getPendingBacklog() });
});

// ── PATCH /api/backlog/:id ──────────────────────────────────────────────────
app.patch('/api/backlog/:id', (req, res) => {
  const { status, answer } = req.body;
  if (!['approved', 'rejected', 'answered'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved, rejected, or answered' });
  }
  if (status === 'answered' && !answer) {
    return res.status(400).json({ error: 'answer is required when status=answered' });
  }
  const row = _db().getBacklogItem(req.params.id);
  const result = _db().updateBacklogStatus(req.params.id, status, answer ?? null);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });

  if (status === 'answered' && row && answer) {
    // Learn structured knowledge from the answer (alias → canonical person, etc.)
    // then re-examine every page that mentions the alias — not just the one that
    // triggered the question. This is what turns a one-off answer into durable memory.
    try {
      const learned = learnFromAnsweredQuestion(row, answer);
      if (learned?.alias && learned?.personId) {
        // Auto-close any other pending backlog items asking about the same
        // alias OR the canonical name, so the user isn't re-answering.
        const extracted = extractPersonNameFromSubject;
        const aliasLc = learned.alias.toLowerCase();
        const canonicalLc = learned.canonical.toLowerCase();
        for (const other of _db().getPendingBacklog()) {
          if (other.id === row.id) continue;
          const name = extracted(other.subject);
          if (name && (name.toLowerCase() === aliasLc || name.toLowerCase() === canonicalLc)) {
            _db().updateBacklogStatus(other.id, 'answered', `Auto-resolved: ${learned.canonical}`);
          }
        }
        // Re-examine every page that mentions this alias so new links land.
        const pages = _db().findPagesMentioningAlias(learned.alias, { limit: 50 });
        for (const p of pages) {
          reexaminePageInBackground(p.id, {
            kind: 'hint',
            label: `"${learned.alias}" refers to ${learned.canonical}.`,
          });
        }
        res.json({ ok: true, learned, rescanned_pages: pages.length });
        return;
      }
    } catch (e) {
      console.warn('learnFromAnsweredQuestion failed:', e.message);
    }

    // Term-based learning + auto-close: if the answered subject had a quoted term
    // (e.g. 'HOS', 'Valor', 'CTK'), add it to the notebook glossary and close any
    // other pending questions about the same term.
    try {
      const entry = _db().extractGlossaryEntryFromBacklog(row.subject, answer);
      if (entry) {
        _db().upsertGlossaryTerm({ ...entry, sourceBacklogId: row.id });
        console.log(`  [glossary] learned: ${entry.term} → ${entry.meaning}`);
      }
      const answeredTerm = extractQuotedTermFromSubject(row.subject);
      if (answeredTerm) {
        let closed = 0;
        for (const other of _db().getPendingBacklog()) {
          if (other.id === row.id) continue;
          const otherTerm = extractQuotedTermFromSubject(other.subject);
          if (otherTerm && otherTerm === answeredTerm) {
            _db().updateBacklogStatus(other.id, 'answered', `Auto-resolved: same term as answered question`);
            closed++;
          }
        }
        if (closed) console.log(`  [backlog] auto-closed ${closed} duplicate(s) for term '${answeredTerm}'`);
      }
    } catch (e) {
      console.warn('term learning/auto-close failed:', e.message);
    }

    // Audit question: "Date needed: v.D p.N" — user answered with a date → file it.
    if (/^date needed:/i.test(row.subject || '') && row.context_page_id) {
      try {
        const dateMatch = answer.match(/\b(\d{4}-\d{2}-\d{2})\b/);
        if (dateMatch) {
          const isoDate = dateMatch[1];
          let dl = _db().findDailyLogByDate(isoDate);
          if (!dl) dl = _db().createDailyLog({ id: crypto.randomUUID(), date: isoDate });
          try { _db().linkPageToDailyLog(row.context_page_id, dl.id, 1.0); } catch (_) {}
          console.log(`  [audit] filed ${row.context_page_id} to daily log ${isoDate}`);
        }
      } catch (e) { console.warn('audit date filing failed:', e.message); }
      res.json({ ok: true });
      return;
    }

    // Audit question: "Collection needed: v.D p.N" — user answered with a collection name.
    if (/^collection needed:/i.test(row.subject || '') && row.context_page_id) {
      try {
        const title = answer.trim().replace(/^["'']|["'']$/g, '');
        if (title) {
          let coll = _db().findCollection('topical', title);
          if (!coll) coll = _db().createCollection({ id: crypto.randomUUID(), kind: 'topical', title });
          try { _db().linkPageToCollection(row.context_page_id, coll.id, 1.0); } catch (_) {}
          console.log(`  [audit] filed ${row.context_page_id} to collection "${title}"`);
        }
      } catch (e) { console.warn('audit collection filing failed:', e.message); }
      res.json({ ok: true });
      return;
    }

    // Fallback: re-examine just the source page (prior behavior).
    if (row.context_page_id) {
      reexaminePageInBackground(row.context_page_id, {
        kind: 'hint',
        label: `Q: ${row.subject}\nA: ${answer}`,
      });
    }
  }
  res.json({ ok: true });
});

// Extract the quoted term from a non-person subject like "Unclear abbreviation 'HOS'" → "hos".
// Returns lowercased for case-insensitive comparison, or null if no quoted term / person question.
// Mirrors the extractQuotedTerm logic in _db().insertBacklogItems.
function extractQuotedTermFromSubject(subj) {
  const s = String(subj || '').trim();
  if (/^who\s+(is|are)/i.test(s)) return null;
  const m = s.match(/['"'\u2018\u2019\u201c\u201d]([^'"'\u2018\u2019\u201c\u201d]{1,50})['"'\u2019\u201d\u201c]/);
  return m ? m[1].trim().toLowerCase() : null;
}

// Pull a name out of common person-ID question shapes. Mirrors the dedup logic
// in _db().insertBacklogItems.
function extractPersonNameFromSubject(subj) {
  const s = String(subj || '').trim().replace(/[\u201c\u201d\u2018\u2019]/g, '”');
  let m = s.match(/^who\s+(?:is|are)\s+[“”'']?([^””''?]+?)[“”'']?\??$/i);
  if (m) return m[1].trim();
  m = s.match(/^identify\s+(?:person|people|name):\s*(.+?)\??$/i);
  if (m) return m[1].trim();
  m = s.match(/^clarify\s+(?:mention\s+of|who\s+is|name|person):\s*(.+?)\??$/i);
  if (m) return m[1].trim();
  m = s.match(/^unclear\s+(?:name|person|reference)\s*[“”'']?(.+?)[“”'']?\??$/i);
  if (m) return m[1].trim();
  m = s.match(/^ambiguous\s+(?:name|person|reference):\s*(.+?)\??$/i);
  if (m) return m[1].trim();
  m = s.match(/^(?:person|name)\s+[“”'']([^””'']+)[“”'']\s+(?:is|needs)\s+/i);
  if (m) return m[1].trim();
  return null;
}

// When the user answers a person-identity backlog question, turn the free-text
// or choice answer into durable state: a real person row, a first_names alias,
// and a page→person link. Returns { alias, canonical, personId } on success.
function learnFromAnsweredQuestion(backlogRow, answer) {
  const alias = extractPersonNameFromSubject(backlogRow.subject);
  if (!alias) return null;

  const ans = String(answer || '').trim();
  if (!ans) return null;

  let canonicalLabel = null;

  // Choice: match against the stored options. "__new__" (or "New person named X")
  // means the alias itself is the canonical label.
  if (backlogRow.answer_format === 'choice' && Array.isArray(backlogRow.answer_options)) {
    const opt = backlogRow.answer_options.find(
      o => o.value === ans || o.label === ans || o.label?.toLowerCase() === ans.toLowerCase()
    );
    if (opt) {
      if (opt.value === '__new__') canonicalLabel = alias;
      else canonicalLabel = opt.label.replace(/^New person named\s+"?|"?$/gi, '').trim() || alias;
    }
  }

  // Short answer: try to extract "Firstname Lastname" from free text. Falls back
  // to using the answer verbatim if it looks like a name, else the alias.
  if (!canonicalLabel) {
    const m = ans.match(/([A-Z][\w'-]+(?:\s+[A-Z][\w'.-]+)+)/);
    if (m) canonicalLabel = m[1].trim();
    else if (/^[A-Z][\w'-]*$/.test(ans)) canonicalLabel = ans;
    else canonicalLabel = alias; // Couldn't parse — at least record the alias as a known person.
  }

  const person = _db().upsertPerson({ label: canonicalLabel });
  if (!person) return null;
  _db().addPersonAlias(person.id, alias);

  if (backlogRow.context_page_id) {
    try { _db().linkPageToPerson(backlogRow.context_page_id, person.id, 1.0); } catch (_) {}
  }

  return { alias, canonical: canonicalLabel, personId: person.id };
}

// ── GET /api/pages/:id/scan ─────────────────────────────────────────────────
app.get('/api/pages/:id/scan', (req, res) => {
  const page = _db().getPage(req.params.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const filePath = path.join(__dirname, 'data', page.scan_path.replace(/^\/scans\//, 'scans/'));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Scan file not found' });
  res.sendFile(filePath);
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function formatItem(item) {
  const isVoice = item.source_kind === 'voice_memo' || (typeof item.scan_path === 'string' && item.scan_path.startsWith('voice:'));
  const dateOnly = (item.captured_at || '').slice(0, 10);
  let citation;
  if (isVoice) {
    citation = dateOnly ? `🎙 ${dateOnly}` : '🎙';
  } else if (item.volume) {
    citation = `→ v.${item.volume} p.${item.page_number ?? '?'}`;
  } else {
    citation = `→ p.${item.page_number ?? '?'}`;
  }
  return {
    id: item.id,
    page_id: item.page_id,
    kind: item.kind,
    text: item.text,
    confidence: item.confidence,
    citation,
    scan_url: item.scan_path,
    source_kind: item.source_kind || null,
    captured_at: item.captured_at || null,
  };
}

// ── Upload helpers for artifacts and references ─────────────────────────────
function makeUploader(subdirName) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(req.userDataDir, subdirName);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + (path.extname(file.originalname) || '')),
  });
  return multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });
}
const artifactUpload = makeUploader('artifacts');
const referenceUpload = makeUploader('references');

// ── Indexes ─────────────────────────────────────────────────────────────────
app.get('/api/indexes/scripture', (req, res) => {
  res.json({ entries: _db().getScriptureIndex() });
});
app.get('/api/indexes/people', (req, res) => {
  res.json({ entries: _db().getPeopleIndex() });
});
app.get('/api/indexes/topics', (req, res) => {
  res.json({ entries: _db().getTopicsIndex() });
});
app.post('/api/indexes/topics', (req, res) => {
  const label = (req.body?.label || '').trim();
  if (!label) return res.status(400).json({ error: 'label is required' });
  try {
    const existing = _db().getEntityByKindLabel('topic', label);
    if (existing) return res.json({ id: existing.id, label: existing.label, reused: true });
    const e = _db().upsertEntity({ id: crypto.randomUUID(), kind: 'topic', label });
    res.json({ id: e.id, label: e.label });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get('/api/indexes/books', (req, res) => {
  res.json({ entries: _db().getBooksIndex() });
});

// ── Projects ────────────────────────────────────────────────────────────────
// Phase 2 — `/api/projects` is now a thin shim over `/api/collections` with
// kind='project'. Old callers see the same shape; new code should just call
// /api/collections?kind=project. Sets a Deprecation header so the UI/devtools
// flag the legacy path.
function _deprecate(res) { res.set('Deprecation', 'true'); res.set('Link', '</api/collections?kind=project>; rel="successor-version"'); }
app.get('/api/projects', (req, res) => {
  _deprecate(res);
  const grouped = _db().listCollectionsGrouped({ includeArchived: false });
  const group = grouped.find(g => g.kind === 'project');
  res.json({ items: group ? group.collections : [] });
});
app.post('/api/projects', (req, res) => {
  _deprecate(res);
  const { title, description, target_date, status } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const coll = _db().createCollection({ id: crypto.randomUUID(), kind: 'project', title, description, target_date, status });
  res.json(coll);
});
app.patch('/api/projects/:id', (req, res) => {
  _deprecate(res);
  const { title, description, target_date, status } = req.body || {};
  try {
    const c = _db().updateCollection(req.params.id, { title, description, target_date, status });
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/projects/:id', (req, res) => {
  _deprecate(res);
  try { _db().deleteCollection(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Unified indexes (Phase 3) ───────────────────────────────────────────────
// One generic surface for every index kind: people | scripture | topic | book |
// collection. Returns { items: [{kind, id, label, subtitle, count, parent_id,
// parent_label, archived_at}] }. The chat action handler also calls the
// PATCH / merge / archive routes.

app.get('/api/indexes', (req, res) => {
  const { kind, archived } = req.query || {};
  if (!kind) return res.status(400).json({ error: 'kind is required' });
  try {
    const items = _db().getUnifiedIndex(kind, { includeArchived: archived === '1' || archived === 'true' });
    res.json({ kind, items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH: rename (optionally merging on collision), archive, or set parent.
app.patch('/api/indexes/:kind/:id', (req, res) => {
  const { label, archived, parent_id } = req.body || {};
  const { kind, id } = req.params;
  try {
    let result = { id };
    if (typeof label === 'string' && label.trim()) {
      result = _db().renameOrMergeEntity(kind, id, label.trim());
    }
    if (archived !== undefined) {
      _db().setEntityArchived(kind, result.merged_into || id, !!archived);
    }
    if (parent_id !== undefined) {
      // Per-kind parent semantics. Chat actions and the UI both dispatch here.
      const norm = {
        people:'person', scriptures:'scripture', topics:'topic', books:'book', collections:'collection'
      }[kind] || kind;
      if (norm === 'topic') _db().setTopicParent(result.merged_into || id, parent_id || null);
      else if (norm === 'collection') _db().setCollectionParent(result.merged_into || id, parent_id || null);
      else if (norm === 'person') _db().setPersonHousehold(result.merged_into || id, parent_id || null);
      else return res.status(400).json({ error: `${kind} has no parent concept` });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Merge source → target (same kind).
app.post('/api/indexes/:kind/:id/merge-into', (req, res) => {
  const { target_id } = req.body || {};
  if (!target_id) return res.status(400).json({ error: 'target_id required' });
  try {
    const r = _db().mergeEntitiesInto(req.params.kind, req.params.id, target_id);
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── People ──────────────────────────────────────────────────────────────────
app.get('/api/people', (req, res) => {
  res.json({ items: _db().listPeople() });
});
app.patch('/api/people/:id', (req, res) => {
  const { priority, growth_note, label, household_id } = req.body || {};
  try {
    const r = _db().updatePerson(req.params.id, { priority, growth_note, label });
    if (household_id !== undefined) {
      _db().setPersonHousehold(req.params.id, household_id || null);
    }
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reclassify a person as a topic (moves all page links intact).
app.post('/api/people/:id/reclassify-as-topic', (req, res) => {
  try {
    const r = _db().reclassifyPersonAsTopic(req.params.id);
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Topics rename/merge ─────────────────────────────────────────────────────
app.patch('/api/topics/:id', (req, res) => {
  const { label, parent_id } = req.body || {};
  try {
    let out = {};
    if (typeof label === 'string' && label.trim()) {
      out = { ...out, ..._db().updateTopicLabel(req.params.id, label.trim()) };
    }
    if (parent_id !== undefined) {
      out = { ...out, ..._db().setTopicParent(req.params.id, parent_id || null) };
    }
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Books (bibliographic notes) ─────────────────────────────────────────────
app.get('/api/books', (req, res) => {
  const group = req.query.group;
  if (group === 'author') return res.json({ groups: _db().listBooksGroupedByAuthor() });
  res.json({ items: _db().listBooks() });
});

app.get('/api/books/:id', (req, res) => {
  const book = _db().getBook(req.params.id);
  if (!book) return res.status(404).json({ error: 'Not found' });
  res.json(book);
});

app.post('/api/books', (req, res) => {
  const { title, author_entity_id, author_label, year, notes } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  try {
    let aeid = author_entity_id || null;
    let alabel = (author_label || '').trim() || null;
    if (!aeid && alabel) {
      const existing = _db().getEntityByKindLabel('topic', alabel);
      if (existing) aeid = existing.id;
      else {
        const e = _db().upsertEntity({ id: crypto.randomUUID(), kind: 'topic', label: alabel });
        aeid = e.id;
      }
    }
    const b = _db().createBook({ id: crypto.randomUUID(), title: title.trim(), author_entity_id: aeid, author_label: alabel, year: (year || '').trim() || null, notes: notes ?? null });
    res.json(b);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/books/:id', (req, res) => {
  try {
    const r = _db().updateBook(req.params.id, req.body || {});
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/books/:id', (req, res) => {
  try {
    _db().deleteBook(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/books/:id/merge-into', (req, res) => {
  const { target_id } = req.body || {};
  if (!target_id) return res.status(400).json({ error: 'target_id is required' });
  try {
    const r = _db().mergeBookInto(req.params.id, target_id);
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/books/:id/pages', (req, res) => {
  const { page_id, role_summary } = req.body || {};
  if (!page_id) return res.status(400).json({ error: 'page_id required' });
  try {
    _db().linkPageToBook(page_id, req.params.id, role_summary || null);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/books/:id/pages/:pageId', (req, res) => {
  try {
    _db().unlinkPageFromBook(req.params.pageId, req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Values ──────────────────────────────────────────────────────────────────
app.get('/api/values', (req, res) => {
  res.json({ items: _db().currentValues() });
});
app.get('/api/values/:slug/history', (req, res) => {
  res.json({ items: _db().getValueHistory(req.params.slug) });
});
app.post('/api/values', (req, res) => {
  const { slug, title, body, category, position } = req.body || {};
  if (!slug || !title || !body) return res.status(400).json({ error: 'slug, title, body required' });
  try {
    const v = _db().createValue({ id: crypto.randomUUID(), slug, title, body, category, position });
    res.json(v);
  } catch (err) {
    res.status(400).json({ error: 'Could not create value', detail: err.message });
  }
});
app.post('/api/values/:slug/versions', (req, res) => {
  const { title, body, category, position } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title, body required' });
  const v = _db().appendValueVersion({ id: crypto.randomUUID(), slug: req.params.slug, title, body, category, position });
  res.json(v);
});

// ── Commitments ─────────────────────────────────────────────────────────────
app.get('/api/commitments', (req, res) => {
  res.json({ items: _db().listCommitments() });
});
// Unified Projects + Commitments with start/target for timeline view.
app.get('/api/commitments/timeline', (req, res) => {
  res.json({ items: _db().listCommitmentsTimeline() });
});
app.post('/api/commitments', (req, res) => {
  const { text, value_slug, start_date, target_date, due_date, parent_id, collection_id } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text is required' });
  const c = _db().createCommitment({ id: crypto.randomUUID(), text, value_slug, start_date, target_date, due_date, parent_id, collection_id });
  res.json(c);
});
app.patch('/api/commitments/:id', (req, res) => {
  const { text, value_slug, status, start_date, target_date, due_date, parent_id, collection_id } = req.body || {};
  const r = _db().updateCommitment(req.params.id, { text, value_slug, status, start_date, target_date, due_date, parent_id, collection_id });
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
app.delete('/api/commitments/:id', (req, res) => {
  const r = _db().deleteCommitment(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Planning hub (Phase 4) ──────────────────────────────────────────────────
// One round-trip endpoint that returns mission, values, roles+areas, this-week's
// rocks, active habits + last week of checks, and commitments.
app.get('/api/planning', (req, res) => {
  const weekStart = req.query.week_start;
  res.json(_db().getPlanningHub({ weekStart }));
});

// Mission — single-line statement; edits append a new value-version row.
app.put('/api/planning/mission', (req, res) => {
  const { body } = req.body || {};
  if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body is required' });
  res.json(_db().setMission(body.trim()));
});

// Rocks — weekly goals.
app.get('/api/rocks', (req, res) => {
  const ws = req.query.week_start;
  res.json({ items: _db().listRocks({ weekStart: ws, includeAll: req.query.all === '1' }) });
});
app.post('/api/rocks', (req, res) => {
  const { title, role_id, week_start, status } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  const r = _db().createRock({ id: crypto.randomUUID(), title: title.trim(), role_id, week_start, status });
  res.json(r);
});
app.patch('/api/rocks/:id', (req, res) => {
  const { title, role_id, status, completed_at } = req.body || {};
  // If transitioning to 'done', stamp completed_at unless caller passed one.
  const ts = (status === 'done' && !completed_at) ? new Date().toISOString() : completed_at;
  const r = _db().updateRock(req.params.id, { title, role_id, status, completed_at: ts });
  res.json(r);
});
app.delete('/api/rocks/:id', (req, res) => {
  _db().deleteRock(req.params.id);
  res.json({ ok: true });
});
app.post('/api/rocks/:id/links', (req, res) => {
  // Attach a collection to a rock; underlying polymorphic links handle the rest.
  const { collection_id } = req.body || {};
  if (!collection_id) return res.status(400).json({ error: 'collection_id required' });
  const id = _db().linkBetween({ from_type: 'rock', from_id: req.params.id, to_type: 'collection', to_id: collection_id });
  res.json({ link_id: id });
});

// Habits — daily yes/no scorecard.
app.get('/api/habits', (req, res) => {
  res.json({ items: _db().listHabits({ includeArchived: req.query.archived === '1' }) });
});
app.post('/api/habits', (req, res) => {
  const { label, role_id, active_from, sort_order } = req.body || {};
  if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
  const h = _db().createHabit({ id: crypto.randomUUID(), label: label.trim(), role_id, active_from, sort_order });
  res.json(h);
});
app.patch('/api/habits/:id', (req, res) => {
  const r = _db().updateHabit(req.params.id, req.body || {});
  res.json(r);
});
app.delete('/api/habits/:id', (req, res) => {
  _db().deleteHabit(req.params.id);
  res.json({ ok: true });
});
// PUT /api/habits/:id/check?date=YYYY-MM-DD — body { checked: true|false }
app.put('/api/habits/:id/check', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const checked = !!(req.body && req.body.checked);
  _db().setHabitCheck(req.params.id, date, checked);
  res.json({ ok: true, habit_id: req.params.id, date, checked });
});

// ── Artifacts ───────────────────────────────────────────────────────────────
// ── Roles & Areas (entities of kind 'role' / 'area') ────────────────────────
app.get('/api/roles', (req, res) => res.json({ items: _db().listRolesWithAreas() }));
app.get('/api/areas', (req, res) => res.json({ items: _db().listAreasWithRoles() }));
app.post('/api/roles', (req, res) => {
  const { label } = req.body || {};
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'label required' });
  try { res.json(_db().getOrCreateEntity({ kind: 'role', label })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/areas', (req, res) => {
  const { label } = req.body || {};
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'label required' });
  try { res.json(_db().getOrCreateEntity({ kind: 'area', label })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/roles/:id', (req, res) => { _db().deleteRoleOrArea(req.params.id); res.json({ ok: true }); });
app.delete('/api/areas/:id', (req, res) => { _db().deleteRoleOrArea(req.params.id); res.json({ ok: true }); });

// Patch a role or area. Body: { label?, standard?, current_focus? }
app.patch('/api/roles/:id', (req, res) => {
  const { label, standard, current_focus } = req.body || {};
  try {
    const r = _db().updateEntity(req.params.id, { label, standard, current_focus });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/areas/:id', (req, res) => {
  const { label, standard, current_focus } = req.body || {};
  try {
    const r = _db().updateEntity(req.params.id, { label, standard, current_focus });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Reorder a role or area up/down by swapping priority with its neighbor.
// For areas, body can pass { scope_id: <roleId> } to reorder within that role.
app.post('/api/roles/:id/move', (req, res) => {
  const { direction } = req.body || {};
  try { res.json(_db().moveEntityPriority(req.params.id, direction)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/areas/:id/move', (req, res) => {
  const { direction, scope_id } = req.body || {};
  try { res.json(_db().moveEntityPriority(req.params.id, direction, { scopeId: scope_id })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Attach / detach a role ↔ area relationship. Roles drive the link.
app.post('/api/roles/:id/areas', (req, res) => {
  const { area_id } = req.body || {};
  if (!area_id) return res.status(400).json({ error: 'area_id required' });
  try {
    const link_id = _db().linkRoleToArea(req.params.id, area_id);
    res.json({ ok: true, link_id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/roles/:id/areas/:areaId', (req, res) => {
  try {
    _db().unlinkRoleFromArea(req.params.id, req.params.areaId);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Create a new collection directly.
app.post('/api/collections', (req, res) => {
  const { title, kind, description } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
  const k = (kind || 'topical').trim();
  if (!ALLOWED_COLLECTION_KINDS.includes(k)) {
    return res.status(400).json({ error: `kind must be one of: ${ALLOWED_COLLECTION_KINDS.join(', ')}` });
  }
  try {
    const c = _db().createCollection({ id: crypto.randomUUID(), kind: k, title: title.trim(), description: description || null });
    res.json(c);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Link a collection to a role/area entity.
app.post('/api/collections/:id/entity-links', (req, res) => {
  const { entity_id } = req.body || {};
  if (!entity_id) return res.status(400).json({ error: 'entity_id required' });
  const link_id = _db().linkBetween({
    from_type: 'collection', from_id: req.params.id, to_type: 'entity', to_id: entity_id
  });
  res.json({ link_id });
});

// ── Google OAuth ────────────────────────────────────────────────────────────
app.get('/api/google/connect', (req, res) => {
  try { res.redirect(google.buildAuthUrl(req)); }
  catch (e) { res.status(500).send(`<pre>${String(e.message || e)}</pre>`); }
});
app.get('/api/google/oauth-callback', async (req, res) => {
  if (req.query.error) return res.status(400).send(`<pre>Google error: ${req.query.error}</pre>`);
  if (!req.query.code) return res.status(400).send('<pre>Missing code</pre>');
  try {
    await google.exchangeCode(req.query.code, req);
    res.send(`<!doctype html><meta charset=utf-8><title>Connected</title>
      <body style="font:16px system-ui;padding:2rem">
      Google connected. You can close this tab.
      <script>setTimeout(()=>{try{window.close()}catch(e){};location.href='/'},600)</script>`);
  } catch (e) {
    res.status(500).send(`<pre>${String(e.message || e)}</pre>`);
  }
});
app.get('/api/google/status', (req, res) => res.json(google.status()));
app.post('/api/google/disconnect', (req, res) => {
  _db().clearGoogleTokens();
  res.json({ ok: true });
});

app.get('/api/artifacts', (req, res) => {
  res.json({ items: _db().listArtifacts() });
});
app.post('/api/artifacts', async (req, res) => {
  const { title, drawer, hanging_folder, manila_folder, status, external_url,
          collection_ids, user_index_ids } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const a = _db().createArtifact({
    id: crypto.randomUUID(), title, drawer, hanging_folder, manila_folder, status, external_url
  });
  for (const cid of (collection_ids || [])) {
    _db().linkBetween({ from_type: 'artifact', from_id: a.id, to_type: 'collection', to_id: cid });
  }
  for (const uid of (user_index_ids || [])) {
    _db().linkBetween({ from_type: 'artifact', from_id: a.id, to_type: 'user_index', to_id: uid });
  }
  const fetch_result = await fetchIfGoogle('artifact', a.id, external_url);
  res.json({ ...a, fetch_result });
});

app.post('/api/artifacts/:id/links', (req, res) => {
  const { to_type, to_id } = req.body || {};
  if (!['collection', 'user_index'].includes(to_type) || !to_id) {
    return res.status(400).json({ error: 'to_type must be collection|user_index and to_id required' });
  }
  const linkId = _db().linkBetween({ from_type: 'artifact', from_id: req.params.id, to_type, to_id });
  res.json({ link_id: linkId });
});
// Generic link creation — Phase 6. Validates (from_type, to_type) pair against
// the set of polymorphic patterns the rest of the app already writes.
const _VALID_FROM_TYPES = new Set(['page','collection','daily_log','artifact','reference','rock']);
// 'page' is a valid to_type so pages can link to other pages via explicit cross-references
// ("→ p.172", "see v.D p.47"). Resolved inside savePageFromParse from the page_refs[] array.
const _VALID_TO_TYPES = new Set(['page','collection','daily_log','scripture','person','topic','entity','book','artifact','reference','user_index']);
app.post('/api/links', (req, res) => {
  const { from_type, from_id, to_type, to_id, role_summary } = req.body || {};
  if (!_VALID_FROM_TYPES.has(from_type)) return res.status(400).json({ error: `from_type must be one of: ${[..._VALID_FROM_TYPES].join(', ')}` });
  if (!_VALID_TO_TYPES.has(to_type)) return res.status(400).json({ error: `to_type must be one of: ${[..._VALID_TO_TYPES].join(', ')}` });
  if (!from_id || !to_id) return res.status(400).json({ error: 'from_id and to_id required' });
  const id = _db().linkBetween({ from_type, from_id, to_type, to_id, role_summary: role_summary || null });
  res.json({ link_id: id });
});
app.delete('/api/links/:id', (req, res) => {
  _db().deleteLinkById(req.params.id);
  res.json({ ok: true });
});
app.patch('/api/artifacts/:id', async (req, res) => {
  const body = req.body || {};
  if (body.archived !== undefined) {
    _db().setArtifactArchived(req.params.id, !!body.archived);
  }
  const updatable = ['title','drawer','hanging_folder','manila_folder','status','external_url']
    .some(k => body[k] !== undefined);
  if (updatable) {
    const r = _db().updateArtifact(req.params.id, body);
    if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  }
  const fetch_result = body.external_url
    ? await fetchIfGoogle('artifact', req.params.id, body.external_url)
    : null;
  // If title or description changed, the content-hash may have shifted — re-run
  // the cross-kind classifier (debounced, hash-skip still honored downstream).
  if (body.title !== undefined || body.description !== undefined) {
    scheduleCrossKindClassify('artifact', req.params.id);
  }
  res.json({ ok: true, fetch_result });
});
app.delete('/api/artifacts/:id', (req, res) => {
  try {
    _db().deleteArtifact(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/artifacts/:id/merge-into', (req, res) => {
  const { target_id } = req.body || {};
  if (!target_id) return res.status(400).json({ error: 'target_id is required' });
  try {
    const r = _db().mergeArtifactInto(req.params.id, target_id);
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/artifacts/:id/versions', artifactUpload.single('file'), (req, res) => {
  const file_path = req.file ? `/artifacts/${req.file.filename}` : null;
  const note = req.body?.note || null;
  if (!file_path && !note) return res.status(400).json({ error: 'file or note required' });
  const v = _db().addArtifactVersion({
    id: crypto.randomUUID(), artifact_id: req.params.id, file_path, note
  });
  res.json(v);
});

// ── References ──────────────────────────────────────────────────────────────
app.get('/api/references', (req, res) => {
  res.json({ items: _db().listReferences() });
});
app.post('/api/references', referenceUpload.single('file'), async (req, res) => {
  const { title, source, external_url, note, collection_ids, row_type } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const file_path = req.file ? `/references/${req.file.filename}` : null;
  if (!file_path && !external_url && !source) {
    return res.status(400).json({ error: 'file, external_url, or source (filed-at location) required' });
  }
  // Auto-derive row_type if not explicit: a file upload that's an image is a 'scan'.
  const inferredRowType = row_type
    || (req.file && /\.(jpe?g|png|gif|webp|tiff?)$/i.test(req.file.originalname) ? 'scan' : 'link');
  const r = _db().createReference({
    id: crypto.randomUUID(), title, source, file_path, external_url, note, row_type: inferredRowType,
  });
  const cids = Array.isArray(collection_ids)
    ? collection_ids
    : (typeof collection_ids === 'string' && collection_ids ? collection_ids.split(',').filter(Boolean) : []);
  for (const cid of cids) {
    _db().linkBetween({ from_type: 'reference', from_id: r.id, to_type: 'collection', to_id: cid });
  }
  const fetch_result = await fetchIfGoogle('reference', r.id, external_url);
  res.json({ ...r, fetch_result });
});
app.patch('/api/references/:id', async (req, res) => {
  const body = req.body || {};
  if (body.archived !== undefined) {
    _db().setReferenceArchived(req.params.id, !!body.archived);
  }
  if (typeof body.external_url === 'string') {
    _db().updateReferenceUrl(req.params.id, body.external_url);
  }
  if (body.row_type === 'link' || body.row_type === 'scan') {
    _db().setReferenceRowType(req.params.id, body.row_type);
  }
  const fetch_result = body.external_url
    ? await fetchIfGoogle('reference', req.params.id, body.external_url)
    : null;
  if (body.title !== undefined || body.note !== undefined || body.source !== undefined) {
    scheduleCrossKindClassify('reference', req.params.id);
  }
  res.json({ ok: true, fetch_result });
});
app.delete('/api/references/:id', (req, res) => {
  const r = _db().deleteReference(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
// Mirror the artifact pattern: accept to_type collection|user_index. Old
// callers that POST { to_id } default to to_type='collection'.
app.post('/api/references/:id/links', (req, res) => {
  const { to_id, to_type } = req.body || {};
  const tt = to_type || 'collection';
  if (!['collection','user_index'].includes(tt) || !to_id) {
    return res.status(400).json({ error: 'to_type must be collection|user_index and to_id required' });
  }
  const linkId = _db().linkBetween({ from_type: 'reference', from_id: req.params.id, to_type: tt, to_id });
  res.json({ link_id: linkId });
});

// ── Households ──────────────────────────────────────────────────────────────
// A household groups people so you can pull up every note on a family in one view.
app.get('/api/households', (req, res) => {
  const items = _db().listHouseholds();
  if (req.query.with_mentions === '1') {
    for (const h of items) h.mentions = _db().getHouseholdMentions(h.id);
  }
  res.json({ items });
});
app.get('/api/households/:id', (req, res) => {
  const detail = _db().getHouseholdDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Not found' });
  res.json(detail);
});
app.post('/api/households', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const h = _db().createHousehold({ name, notes: req.body?.notes || null });
    res.json(h);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return res.status(409).json({ error: 'Household name already exists' });
    throw e;
  }
});
app.patch('/api/households/:id', (req, res) => {
  _db().updateHousehold(req.params.id, req.body || {});
  res.json({ ok: true });
});
app.delete('/api/households/:id', (req, res) => {
  _db().deleteHousehold(req.params.id);
  res.json({ ok: true });
});
app.post('/api/households/:id/members', (req, res) => {
  const personIds = Array.isArray(req.body?.person_ids) ? req.body.person_ids
    : req.body?.person_id ? [req.body.person_id] : [];
  for (const pid of personIds) _db().setPersonHousehold(pid, req.params.id);
  res.json({ ok: true, added: personIds.length });
});
app.delete('/api/households/:id/members/:personId', (req, res) => {
  _db().setPersonHousehold(req.params.personId, null);
  res.json({ ok: true });
});

// ── Reference scans (index cards / paper thinking) ─────────────────────────
// Scans that aren't part of a notebook volume. Go through the same OCR / AI
// pipeline as notebook pages, so they're searchable (items_fts), linkable,
// and includable in user indexes. Collections are optional for references.
app.get('/api/reference-scans', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const label = (req.query.label || '').trim() || null;
  const search = (req.query.q || '').trim() || null;
  res.json(_db().listReferenceScans({ limit, offset, label, search }));
});

app.get('/api/reference-scans/labels', (req, res) => {
  res.json({ items: _db().listReferenceLabels() });
});

// Upload one or more reference scans. Accepts the same image formats as /api/ingest.
// Each scan becomes its own page (is_reference=1). AI pipeline still extracts items,
// scripture, people, topics — and links to collections if the user supplies collection_id.
app.post('/api/reference-scans', upload.array('scans', 50), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files provided' });
  const label = ((req.body && req.body.label) || '').trim() || null;
  const collectionId = ((req.body && req.body.collection_id) || '').trim() || null;
  const roleIds = parseIdList(req.body?.role_ids);
  const areaIds = parseIdList(req.body?.area_ids);

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const write = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };
  write({ type: 'start', count: req.files.length });

  let resolved = 0, failed = 0;
  for (const f of req.files) {
    try {
      const isPdf = path.extname(f.originalname).toLowerCase() === '.pdf' || f.mimetype === 'application/pdf';
      let pages;
      if (isPdf) {
        const r = await ingestPdf(f.path, { userKindHint: 'reference', volumeOverride: '' });
        pages = r.pages || [];
      } else {
        const r = await ingestSingleImage(f.path, `/scans/${f.filename}`, { userKindHint: 'reference', volumeOverride: '' });
        pages = r.pages || [];
      }
      for (const pg of pages) {
        const pageId = pg.page_id || pg.id;
        if (!pageId || pg.error) continue;
        _db().markPageAsReference(pageId, label);
        if (collectionId) {
          try { _db().linkBetween({ from_type: 'page', from_id: pageId, to_type: 'collection', to_id: collectionId }); }
          catch (e) { console.warn('ref collection link skip:', e.message); }
        }
      }
      applyRoleAreaTags(pages, roleIds, areaIds);
      resolved++;
      write({ type: 'scan', file: f.originalname, pages });
    } catch (err) {
      failed++;
      try { fs.unlinkSync(f.path); } catch {}
      write({ type: 'error', file: f.originalname, error: err.message || String(err) });
    }
  }
  write({ type: 'done', resolved, failed });
  res.end();
});

// Patch: edit reference_label on an existing page.
app.patch('/api/reference-scans/:pageId', (req, res) => {
  const pg = _db().getPage(req.params.pageId);
  if (!pg) return res.status(404).json({ error: 'Not found' });
  const { label } = req.body || {};
  _db().markPageAsReference(req.params.pageId, (label || '').trim() || null);
  res.json({ ok: true });
});

// ── Collections browser ─────────────────────────────────────────────────────
app.get('/api/collections', (req, res) => {
  res.json({ groups: _db().listCollectionsGrouped() });
});
app.get('/api/collections/duplicates', (req, res) => {
  res.json({ pairs: _db().findCollectionDuplicateCandidates() });
});
app.get('/api/collections/:id', (req, res) => {
  const detail = _db().getCollectionDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Not found' });
  res.json(detail);
});
app.post('/api/collections/:id/merge-into', (req, res) => {
  const target = (req.body && req.body.target_id) || '';
  if (!target) return res.status(400).json({ error: 'target_id required' });
  try {
    const r = _db().mergeCollectionInto(req.params.id, target);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message || 'merge failed' });
  }
});

// ── Daily logs ──────────────────────────────────────────────────────────────
app.get('/api/daily-logs', (req, res) => {
  res.json({ months: _db().listDailyLogs() });
});

app.get('/api/daily-logs/:id', (req, res) => {
  const detail = _db().getDailyLogDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Not found' });
  res.json(detail);
});

app.post('/api/daily-logs', (req, res) => {
  const date = (req.body && req.body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const dl = _db().findDailyLogByDate(date) || _db().createDailyLog({ id: crypto.randomUUID(), date });
  res.json(dl);
});

app.patch('/api/daily-logs/:id', (req, res) => {
  const dl = _db().getDailyLog(req.params.id);
  if (!dl) return res.status(404).json({ error: 'Not found' });
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(req.body, 'summary')) patch.summary = req.body.summary;
  if (req.body.archived === true) patch.archived_at = new Date().toISOString();
  if (req.body.archived === false) patch.archived_at = null;
  if (typeof req.body.date === 'string' && req.body.date.trim()) patch.date = req.body.date.trim();
  try {
    const updated = _db().updateDailyLog(req.params.id, patch);
    if (patch.summary !== undefined) scheduleCrossKindClassify('daily_log', req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Bullet-journal spine for a single month — one row per date, empty days included.
app.get('/api/logs/month/:ym', (req, res) => {
  const ym = req.params.ym;
  if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: 'ym must be YYYY-MM' });
  res.json(_db().listMonthSpine(ym));
});

// Monthly summary (one per YYYY-MM). Empty/missing = no summary yet.
app.get('/api/logs/:ym/summary', (req, res) => {
  const ym = req.params.ym;
  if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: 'ym must be YYYY-MM' });
  const row = _db().getMonthlySummary(ym);
  res.json(row || { year_month: ym, summary: null, updated_at: null });
});

// PATCH is the canonical verb; PUT kept as a shim for older clients.
const _handleMonthlySummary = (req, res) => {
  const ym = req.params.ym;
  if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: 'ym must be YYYY-MM' });
  const summary = Object.prototype.hasOwnProperty.call(req.body, 'summary') ? req.body.summary : '';
  const row = _db().setMonthlySummary(ym, summary);
  res.json(row);
};
app.patch('/api/logs/:ym/summary', _handleMonthlySummary);
app.put('/api/logs/:ym/summary', _handleMonthlySummary);

// Delete an auto-index entity (scripture / person / topic)
app.delete('/api/indexes/:kind/:id', (req, res) => {
  const { kind, id } = req.params;
  try {
    if (kind === 'scripture') _db().deleteScriptureRef(id);
    else if (kind === 'people' || kind === 'person') _db().deletePerson(id);
    else if (kind === 'topics' || kind === 'topic') _db().deleteTopicEntity(id);
    else return res.status(400).json({ error: 'unknown index kind' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function reexaminePageInBackground(pageId, newlyConfirmed) {
  try {
    const page = _db().getPage(pageId);
    if (!page) return;
    const imagePath = path.join(__dirname, 'data', page.scan_path.replace(/^\/scans\//, 'scans/'));
    if (!fs.existsSync(imagePath)) return;

    const detail = _db().getPageDetail(pageId);
    const knownEntities = {
      people: (detail?.people || []).map(p => p.label),
      scripture: (detail?.scripture || []).map(s => s.canonical || s.label),
      topics: (detail?.topics || []).map(t => t.label),
    };

    const recentAnswered = _db().getRecentAnsweredQuestions(150);
    const knownAliases = _db().getKnownAliases();
    const handwritingCorrections = _db().getHandwritingCorrections();
    const notebookGlossary = _db().getGlossary();
    const result = await reexaminePage(imagePath, knownEntities, newlyConfirmed, recentAnswered, knownAliases, handwritingCorrections, notebookGlossary, page.rotation || 0);

    // Apply revisions (rename person, replace topic, rewrite summary) BEFORE new entities —
    // so new_entities that depend on a rename see the final state.
    let appliedRevisions = 0;
    const revisions = result.revisions || {};
    for (const rn of (revisions.rename_people || [])) {
      if (!rn.from || !rn.to || rn.from === rn.to) continue;
      try {
        const person = (detail?.people || []).find(p => p.label && p.label.toLowerCase() === String(rn.from).toLowerCase());
        if (person) { _db().updatePerson(person.id, { label: rn.to }); appliedRevisions++; }
      } catch (e) { console.warn('rename_people skip:', e.message); }
    }
    for (const rt of (revisions.replace_topics || [])) {
      if (!rt.from || !rt.to || rt.from === rt.to) continue;
      try { _db().replaceTopicOnPage(pageId, rt.from, rt.to); appliedRevisions++; }
      catch (e) { console.warn('replace_topics skip:', e.message); }
    }
    if (revisions.rewrite_summary && revisions.rewrite_summary.trim() && revisions.rewrite_summary !== page.summary) {
      try { _db().updatePageSummary(pageId, revisions.rewrite_summary.trim()); appliedRevisions++; }
      catch (e) { console.warn('rewrite_summary skip:', e.message); }
    }

    let addedEntities = 0;
    for (const ent of (result.new_entities || [])) {
      if (!ent.label || (ent.confidence ?? 1) < 0.7) continue;
      try {
        if (ent.kind === 'person') {
          const p = _db().upsertPerson({ label: ent.label });
          _db().linkPageToPerson(pageId, p.id, ent.confidence ?? 0.9);
          addedEntities++;
        } else if (ent.kind === 'scripture' && ent.book && ent.chapter) {
          const ref = _db().upsertScriptureRef({
            canonical: ent.label, book: ent.book, chapter: ent.chapter,
            verse_start: ent.verse_start ?? null, verse_end: ent.verse_end ?? null,
          });
          _db().linkPageToScripture(pageId, ref.id, ent.confidence ?? 0.9);
          addedEntities++;
        } else if (ent.kind === 'topic') {
          const id = crypto.randomUUID();
          _db().upsertEntity({ id, kind: 'topic', label: ent.label });
          const t = _db().getEntityByKindLabel('topic', ent.label);
          if (t) _db().insertLink({
            id: crypto.randomUUID(),
            from_type: 'page', from_id: pageId,
            to_type: 'topic', to_id: t.id,
            created_by: 'reexamine', confidence: ent.confidence ?? 0.9,
          });
          addedEntities++;
        }
      } catch (e) { console.warn('reexamine link skip:', e.message); }
    }

    return { added_entities: addedEntities, added_backlog: 0, applied_revisions: appliedRevisions };
  } catch (err) {
    console.warn('reexamine failed:', err.message);
    return { added_entities: 0, added_backlog: 0, applied_revisions: 0 };
  }
}

// Free-form refine: user tells Foxed something it got wrong/missed; we re-examine
app.post('/api/pages/:id/refine', async (req, res) => {
  const { hint } = req.body || {};
  if (!hint || !hint.trim()) return res.status(400).json({ error: 'hint is required' });
  try {
    const result = await reexaminePageInBackground(req.params.id, { kind: 'hint', label: hint.trim() });
    res.json({
      ok: true,
      added_entities: result?.added_entities ?? 0,
      applied_revisions: result?.applied_revisions ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Attach a person / scripture / topic to a single page
app.post('/api/pages/:id/augment', async (req, res) => {
  const { kind, label } = req.body || {};
  if (!kind || !label) return res.status(400).json({ error: 'kind and label are required' });
  if (!['person', 'scripture', 'topic'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be person|scripture|topic' });
  }
  try {
    const result = _db().augmentPage(req.params.id, { kind, label });
    reexaminePageInBackground(req.params.id, { kind, label });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Ingest failures ─────────────────────────────────────────────────────────
app.get('/api/ingest-failures', (req, res) => {
  res.json({ items: _db().listIngestFailures() });
});
app.post('/api/ingest-failures/:id/retry', async (req, res) => {
  const f = _db().getIngestFailure(req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });
  const fsPath = path.join(__dirname, 'data', f.scan_path.replace(/^\/scans\//, 'scans/'));
  if (!fs.existsSync(fsPath)) return res.status(400).json({ error: 'scan file missing', path: fsPath });
  const isTransient = (msg) => /\b(429|503|RESOURCE_EXHAUSTED|rate|Deadline|UNAVAILABLE|overload)\b/i.test(String(msg));
  const volumeOverride = f.volume || undefined;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const result = await ingestSingleImage(fsPath, f.scan_path, { volumeOverride });
      _db().markIngestFailureResolved(f.id);
      return res.json({ ok: true, pages: result.pages.length, items: result.items_count, attempts: attempt + 1 });
    } catch (err) {
      lastErr = err;
      if (attempt === 3 || !isTransient(err.message)) break;
      const waitMs = 2000 * (attempt + 1) + Math.floor(Math.random() * 1000);
      console.warn(`  [retry] ${f.scan_path} attempt ${attempt + 1} transient (${err.message.slice(0, 80)}) — waiting ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  _db().recordIngestFailure({
    scan_path: f.scan_path, source: f.source, stage: 'retry', error: lastErr.message, volume: f.volume || null,
  });
  res.status(500).json({ error: lastErr.message });
});
// Retry every failed scan in sequence (with backoff). Handy for clearing after a
// Gemini outage. Streams NDJSON so the UI can show progress.
app.post('/api/ingest-failures/retry-all', async (req, res) => {
  const failures = _db().listIngestFailures();
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  const write = (obj) => res.write(JSON.stringify(obj) + '\n');
  write({ type: 'start', count: failures.length });
  const isTransient = (msg) => /\b(429|503|RESOURCE_EXHAUSTED|rate|Deadline|UNAVAILABLE|overload)\b/i.test(String(msg));
  let resolved = 0, stillFailed = 0;
  for (const f of failures) {
    const fsPath = path.join(__dirname, 'data', f.scan_path.replace(/^\/scans\//, 'scans/'));
    if (!fs.existsSync(fsPath)) { write({ type: 'skip', id: f.id, scan_path: f.scan_path, reason: 'file missing' }); stillFailed++; continue; }
    const volumeOverride = f.volume || undefined;
    let ok = false, lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const result = await ingestSingleImage(fsPath, f.scan_path, { volumeOverride });
        _db().markIngestFailureResolved(f.id);
        write({ type: 'resolved', id: f.id, scan_path: f.scan_path, pages: result.pages.length });
        ok = true; resolved++;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt === 3 || !isTransient(err.message)) break;
        const waitMs = 2000 * (attempt + 1) + Math.floor(Math.random() * 1000);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    if (!ok) { write({ type: 'failed', id: f.id, scan_path: f.scan_path, error: lastErr && lastErr.message }); stillFailed++; }
    // Gentle pacing between scans so we don't burst into 429.
    await new Promise(r => setTimeout(r, 1500));
  }
  write({ type: 'done', resolved, still_failed: stillFailed });
  res.end();
});
app.delete('/api/ingest-failures/:id', (req, res) => {
  const r = _db().deleteIngestFailure(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ── Re-parse a scan ─────────────────────────────────────────────────────────
// Deletes all pages/items/links for a given scan_path, then re-runs ingest.
app.post('/api/scans/reingest', async (req, res) => {
  const { scan_path } = req.body || {};
  if (!scan_path) return res.status(400).json({ error: 'scan_path required' });
  const fsPath = path.join(__dirname, 'data', scan_path.replace(/^\/scans\//, 'scans/'));
  if (!fs.existsSync(fsPath)) return res.status(400).json({ error: 'scan file missing', path: fsPath });
  try {
    _db().deletePagesByScanPath(scan_path);
    const result = await ingestSingleImage(fsPath, scan_path);
    res.json({ ok: true, pages: result.pages.length, items: result.items_count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Collection rename / re-summarize ────────────────────────────────────────
app.patch('/api/collections/:id', (req, res) => {
  const { title, summary, description, archived, kind, parent_id } = req.body || {};
  try {
    if (archived !== undefined) {
      // Enforce daily-log separation: daily logs cannot be archived as collections.
      const row = _db().getCollectionDetail(req.params.id);
      if (row && row.collection && row.collection.kind === 'daily_log') {
        return res.status(400).json({ error: 'Daily logs cannot be archived' });
      }
    }
    // Validate kind up front so we 400 before making any partial edits.
    if (typeof kind === 'string' && kind.trim()) {
      if (!ALLOWED_COLLECTION_KINDS.includes(kind.trim())) {
        return res.status(400).json({
          error: `kind must be one of: ${ALLOWED_COLLECTION_KINDS.join(', ')}`,
        });
      }
    }
    let out = {};
    if (typeof title === 'string' && title.trim()) {
      out = { ...out, ..._db().renameCollection(req.params.id, title.trim()) };
    }
    if (typeof summary === 'string') {
      _db().updateCollectionSummary(req.params.id, summary.trim() || null);
      out.summary = summary.trim() || null;
    }
    if (typeof description === 'string') {
      _db().updateCollection(req.params.id, { description: description.trim() || null });
      out.description = description.trim() || null;
    }
    if (archived === true) out.archived = _db().archiveCollection(req.params.id)?.archived_at || null;
    if (archived === false) { _db().unarchiveCollection(req.params.id); out.archived = null; }
    if (typeof kind === 'string' && kind.trim()) {
      const reclassified = reclassifyCollectionKind(req.params.id, kind.trim());
      out = { ...out, ...reclassified };
    }
    if (parent_id !== undefined) {
      const r = _db().setCollectionParent(req.params.id, parent_id || null);
      out.parent_id = r.parent_id;
    }
    if (title !== undefined || description !== undefined || summary !== undefined) {
      scheduleCrossKindClassify('collection', req.params.id);
    }
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reclassify a collection: move it to a different kind, or (special case) convert
// it into the new first-class daily_logs structure. Converting to daily_log requires
// the collection title to be an ISO date; all linked pages get re-pointed to the
// new daily_log row and the collection is deleted.
const ALLOWED_COLLECTION_KINDS = ['daily_log', 'topical', 'monthly_log', 'future_log', 'index', 'collection'];

// Promote a collection directly to a daily_log for a given date — skips the
// YYYY-MM-DD title gate. If a daily_log already exists for that date, merges
// pages in and drops the source collection.
app.post('/api/collections/:id/promote-to-daily-log', (req, res) => {
  const { date } = req.body || {};
  try {
    const detail = _db().getCollectionDetail(req.params.id);
    if (!detail || !detail.collection) return res.status(404).json({ error: 'Collection not found' });
    let iso = (date || '').trim();
    if (!iso) {
      const firstPage = (detail.pages || [])[0];
      iso = firstPage && firstPage.captured_at ? firstPage.captured_at.slice(0, 10) : '';
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      return res.status(400).json({ error: `date must be YYYY-MM-DD (got "${iso}")` });
    }
    const existingDl = _db().findDailyLogByDate(iso);
    if (existingDl) {
      for (const pg of detail.pages) _db().linkPageToDailyLog(pg.id, existingDl.id, 1.0);
      _db().deleteCollection(req.params.id);
      return res.json({ ok: true, daily_log_id: existingDl.id, merged_into_existing: true });
    }
    const dl = _db().createDailyLog({ id: crypto.randomUUID(), date: iso });
    for (const pg of detail.pages) _db().linkPageToDailyLog(pg.id, dl.id, 1.0);
    _db().deleteCollection(req.params.id);
    res.json({ ok: true, daily_log_id: dl.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/collections/:id', (req, res) => {
  try {
    _db().deleteCollection(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

function reclassifyCollectionKind(collectionId, nextKind) {
  const detail = _db().getCollectionDetail(collectionId);
  if (!detail || !detail.collection) throw new Error('Collection not found');
  const current = detail.collection;
  if (!ALLOWED_COLLECTION_KINDS.includes(nextKind)) {
    throw new Error(`Unknown kind: ${nextKind}. Must be one of: ${ALLOWED_COLLECTION_KINDS.join(', ')}`);
  }
  if (nextKind === 'daily_log') {
    const title = (current.title || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(title)) {
      throw new Error(`To convert to daily_log the title must be an ISO date (YYYY-MM-DD). Current title: "${title}".`);
    }
    // Reject if a daily_log for that date already exists (and it's not already this one).
    const existingDl = _db().findDailyLogByDate(title);
    if (existingDl) {
      // Move this collection's pages into the existing daily_log, then drop the collection.
      for (const pg of detail.pages) _db().linkPageToDailyLog(pg.id, existingDl.id, 1.0);
      _db().deleteCollection(collectionId);
      return { reclassified_to: 'daily_log', daily_log_id: existingDl.id, merged_into_existing: true };
    }
    const dl = _db().createDailyLog({ id: crypto.randomUUID(), date: title });
    for (const pg of detail.pages) _db().linkPageToDailyLog(pg.id, dl.id, 1.0);
    _db().deleteCollection(collectionId);
    return { reclassified_to: 'daily_log', daily_log_id: dl.id };
  }
  _db().updateCollectionKind(collectionId, nextKind);
  return { reclassified_to: nextKind };
}

// ── Raw transcript (voice memos) ────────────────────────────────────────────
app.get('/api/pages/:id/transcript', (req, res) => {
  const pg = _db().getPageTranscript(req.params.id);
  if (!pg) return res.status(404).json({ error: 'Not found' });
  res.json({
    id: pg.id,
    source_kind: pg.source_kind,
    captured_at: pg.captured_at,
    summary: pg.summary,
    is_voice: pg.source_kind === 'voice_memo' || (pg.scan_path && pg.scan_path.startsWith('voice:')),
    transcript: pg.raw_ocr_text || '',
  });
});

// ── Page detail ─────────────────────────────────────────────────────────────
app.get('/api/pages/:id/detail', (req, res) => {
  const detail = _db().getPageDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Not found' });
  res.json(detail);
});

// ── Phase 1.5: Unified page-context dispatcher ──────────────────────────────
// One endpoint replaces the five-way split between /api/pages/:id/detail,
// /api/collections/:id, /api/daily-logs/:id, /api/books/:id, and
// /api/user-indexes/:id when the caller is "show me the pages in this thing
// with one page focused." Each existing endpoint stays as-is so other callers
// (the index pages, the books list, etc.) keep working.
//
// GET /api/pages/context?ctx=<page|collection|day|book|index>&id=<id>&focus=<pageId>
//   ctx=page       — focus is the page itself; siblings come from spread+context_strip
//   ctx=collection — id is the collection id; tiles are pages in that collection
//   ctx=day        — id is the daily_log id (or YYYY-MM-DD); tiles are pages on that day
//   ctx=book       — id is the book id; tiles are pages linked to that book
//   ctx=index      — id is the user_index id; tiles are entries in that index
//
// Response shape (consistent across ctx):
//   { ctx, header: { title, subtitle, kind, id }, tiles: [{ id, summary, ... }],
//     focus: <full page detail payload, or null> }
app.get('/api/pages/context', (req, res) => {
  const ctx = String(req.query.ctx || '').toLowerCase();
  const id = String(req.query.id || '').trim();
  const focusId = String(req.query.focus || '').trim() || null;
  if (!ctx) return res.status(400).json({ error: 'ctx required' });
  try {
    let header = null;
    let tiles = [];
    let focus = null;

    if (ctx === 'page') {
      const pageId = focusId || id;
      if (!pageId) return res.status(400).json({ error: 'focus or id required for ctx=page' });
      focus = _db().getPageDetail(pageId);
      if (!focus) return res.status(404).json({ error: 'Page not found' });
      const pg = focus.page || {};
      header = {
        title: pg.title || pg.summary?.slice(0, 60) || 'page',
        subtitle: pg.volume ? `v.${pg.volume}${pg.page_number ? ' p.' + pg.page_number : ''}` : '',
        kind: 'page',
        id: pg.id,
      };
      tiles = focus.spread_pages?.length ? focus.spread_pages : [pg];
    } else if (ctx === 'collection') {
      if (!id) return res.status(400).json({ error: 'id required for ctx=collection' });
      const coll = _db().getCollectionDetail(id);
      if (!coll) return res.status(404).json({ error: 'Collection not found' });
      header = {
        title: coll.collection?.title || 'collection',
        subtitle: coll.collection?.kind || '',
        kind: 'collection',
        id: coll.collection?.id,
      };
      tiles = (coll.pages || []).map(p => ({
        ...p,
        role_summary: _db().getRoleSummaryForLink(p.id, 'collection', id) || null,
      }));
      const targetId = focusId || (tiles[0] && tiles[0].id);
      if (targetId) focus = _db().getPageDetail(targetId);
    } else if (ctx === 'day') {
      if (!id) return res.status(400).json({ error: 'id required for ctx=day' });
      // accept either the daily_log id or a YYYY-MM-DD date
      let dl = null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(id)) {
        const found = _db().findDailyLogByDate(id);
        if (found) dl = _db().getDailyLogDetail(found.id);
      } else {
        dl = _db().getDailyLogDetail(id);
      }
      if (!dl) return res.status(404).json({ error: 'Daily log not found' });
      header = {
        title: dl.daily_log?.date || 'day',
        subtitle: 'daily log',
        kind: 'day',
        id: dl.daily_log?.id,
      };
      tiles = dl.pages || [];
      const targetId = focusId || (tiles[0] && tiles[0].id);
      if (targetId) focus = _db().getPageDetail(targetId);
    } else if (ctx === 'book') {
      if (!id) return res.status(400).json({ error: 'id required for ctx=book' });
      const book = _db().getBook(id);
      if (!book) return res.status(404).json({ error: 'Book not found' });
      header = {
        title: book.title || 'book',
        subtitle: book.author_label || '',
        kind: 'book',
        id: book.id,
      };
      tiles = (book.pages || []).map(p => ({
        ...p,
        role_summary: _db().getRoleSummaryForLink(p.id, 'book', id) || null,
      }));
      const targetId = focusId || (tiles[0] && tiles[0].id);
      if (targetId) focus = _db().getPageDetail(targetId);
    } else if (ctx === 'index') {
      if (!id) return res.status(400).json({ error: 'id required for ctx=index' });
      const idx = _db().getUserIndexDetail(id);
      if (!idx) return res.status(404).json({ error: 'Index not found' });
      header = {
        title: idx.index?.title || 'index',
        subtitle: idx.index?.description || '',
        kind: 'index',
        id: idx.index?.id,
      };
      // Index entries can be pages OR items; expose pages only as tiles for now.
      // Also pull in any pages linked via the polymorphic links table
      // (classifier creates these on AI indexes).
      const entryTiles = (idx.entries || []).filter(e => e.page_id).map(e => ({
        id: e.page_id, summary: e.note || e.page_summary || '', volume: e.volume, page_number: e.page_number,
        role_summary: _db().getRoleSummaryForLink(e.page_id, 'user_index', id) || null,
      }));
      const linkedPageRows = _db().listPagesLinkedToIndex(id) || [];
      const linkedTiles = linkedPageRows.map(p => ({
        id: p.id, summary: p.summary, volume: p.volume, page_number: p.page_number,
        role_summary: _db().getRoleSummaryForLink(p.id, 'user_index', id) || null,
      }));
      const seen = new Set();
      tiles = [...entryTiles, ...linkedTiles].filter(t => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
      const targetId = focusId || (tiles[0] && tiles[0].id);
      if (targetId) focus = _db().getPageDetail(targetId);
    } else {
      return res.status(400).json({ error: `unknown ctx: ${ctx}` });
    }

    res.json({ ctx, header, tiles, focus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/pages/:id', (req, res) => {
  const { summary, volume, page_number, rotation, captured_at } = req.body || {};
  const hasSummary = typeof summary === 'string';
  const hasVolume = volume !== undefined;
  const hasPageNumber = page_number !== undefined;
  const hasRotation = rotation !== undefined;
  const hasCapturedAt = captured_at !== undefined;
  if (!hasSummary && !hasVolume && !hasPageNumber && !hasRotation && !hasCapturedAt) {
    return res.status(400).json({ error: 'summary, volume, page_number, rotation, or captured_at required' });
  }
  try {
    if (hasSummary) _db().updatePageSummary(req.params.id, summary.trim());
    if (hasVolume || hasPageNumber || hasCapturedAt) {
      _db().updatePage(req.params.id, {
        volume: hasVolume ? volume : undefined,
        page_number: hasPageNumber
          ? (page_number === null || page_number === '' ? null : page_number)
          : undefined,
        captured_at: hasCapturedAt ? captured_at : undefined,
      });
    }
    let newRotation;
    if (hasRotation) newRotation = _db().setPageRotation(req.params.id, rotation);
    res.json({ ok: true, rotation: newRotation });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/pages/:id/refile ──────────────────────────────────────────────
// One-shot helper the UI uses to fix ingest mistakes. Body:
//   { action: 'set-daily-log', date: 'YYYY-MM-DD' }   — replace daily_log link(s) with the one for <date>
//   { action: 'clear-daily-log' }                     — remove all daily_log links
//   { action: 'unlink-collection', collection_id }    — remove the (page→collection) link
//   { action: 'unlink-book', book_id }                — remove the (page→book) link
//   { action: 'unlink-user_index', user_index_id }    — remove the (page→user_index) link + any classifier link
//   { action: 'link', to_type, to_id, role_summary? } — add a (page→X) link
// Idempotent where applicable; never throws on already-absent links.
app.post('/api/pages/:id/refile', (req, res) => {
  const pageId = req.params.id;
  if (!_db().getPage(pageId)) return res.status(404).json({ error: 'page not found' });
  const body = req.body || {};
  const action = (body.action || '').trim();
  try {
    if (action === 'set-daily-log') {
      const date = String(body.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      _db().removePageLinksByType(pageId, 'daily_log');
      const dl = _db().findDailyLogByDate(date) || _db().createDailyLog({ id: crypto.randomUUID(), date });
      _db().linkBetween({ from_type: 'page', from_id: pageId, to_type: 'daily_log', to_id: dl.id });
      return res.json({ ok: true, daily_log: dl });
    }
    if (action === 'clear-daily-log') {
      _db().removePageLinksByType(pageId, 'daily_log');
      return res.json({ ok: true });
    }
    if (action === 'unlink-collection' || action === 'unlink-book') {
      const key = action === 'unlink-collection' ? 'collection_id' : 'book_id';
      const toType = action === 'unlink-collection' ? 'collection' : 'book';
      const toId = String(body[key] || '').trim();
      if (!toId) return res.status(400).json({ error: `${key} required` });
      _db().removePageLinkToTarget(pageId, toType, toId);
      return res.json({ ok: true });
    }
    if (action === 'unlink-user_index') {
      const uid = String(body.user_index_id || '').trim();
      if (!uid) return res.status(400).json({ error: 'user_index_id required' });
      _db().removePageUserIndexLink(pageId, uid);
      return res.json({ ok: true });
    }
    if (action === 'unlink-entity') {
      const toType = String(body.to_type || '').trim();
      const toId = String(body.to_id || '').trim();
      if (!toType || !toId) return res.status(400).json({ error: 'to_type and to_id required' });
      _db().removePageLinkToTarget(pageId, toType, toId);
      return res.json({ ok: true });
    }
    if (action === 'link') {
      const toType = String(body.to_type || '').trim();
      const toId = String(body.to_id || '').trim();
      if (!toType || !toId) return res.status(400).json({ error: 'to_type and to_id required' });
      const id = _db().linkBetween({ from_type: 'page', from_id: pageId, to_type: toType, to_id: toId, role_summary: body.role_summary || null });
      return res.json({ ok: true, link_id: id });
    }
    return res.status(400).json({ error: `unknown action: ${action}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/pages/:id/rotate ──────────────────────────────────────────────
// Convenience endpoint that increments rotation by ±90 (clockwise = ?dir=cw,
// counter-clockwise = ?dir=ccw). Matches how the UI rotate-buttons call it.
app.post('/api/pages/:id/rotate', (req, res) => {
  const dir = (req.query.dir || 'cw').toLowerCase();
  if (dir !== 'cw' && dir !== 'ccw') {
    return res.status(400).json({ error: 'dir must be cw or ccw' });
  }
  try {
    const rotation = _db().rotatePage(req.params.id, dir);
    res.json({ ok: true, rotation });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── User-created indexes ────────────────────────────────────────────────────
app.get('/api/user-indexes', (req, res) => {
  res.json({ items: _db().listUserIndexes() });
});
app.post('/api/user-indexes', (req, res) => {
  const { title, description, query } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  try {
    const idx = _db().createUserIndex({ id: crypto.randomUUID(), title, description, query });
    res.json(idx);
  } catch (err) {
    res.status(400).json({ error: 'Could not create', detail: err.message });
  }
});
app.patch('/api/user-indexes/:id', (req, res) => {
  const r = _db().updateUserIndex(req.params.id, req.body || {});
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
app.delete('/api/user-indexes/:id', (req, res) => {
  const r = _db().deleteUserIndex(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
app.get('/api/user-indexes/:id', (req, res) => {
  const detail = _db().getUserIndexDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Not found' });
  res.json(detail);
});
app.post('/api/user-indexes/:id/entries', (req, res) => {
  const { page_id, item_id, note } = req.body || {};
  if (!page_id && !item_id) return res.status(400).json({ error: 'page_id or item_id required' });
  const entry = _db().addIndexEntry({
    id: crypto.randomUUID(), index_id: req.params.id, page_id, item_id, note
  });
  res.json(entry);
});
app.delete('/api/user-indexes/:indexId/entries/:entryId', (req, res) => {
  const r = _db().deleteIndexEntry(req.params.entryId);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});


// =============================================================================
// Phase 6 — Unified Index endpoint family
// =============================================================================
// Every "indexable kind" — collections, books, artifacts, references, people,
// topics, scripture, user_indexes — speaks the same endpoint family:
//   GET    /api/index/tree?archived=active|all
//   POST   /api/index/:kind/:id/rename
//   POST   /api/index/:kind/:id/merge
//   POST   /api/index/:kind/:id/archive
//   POST   /api/index/:kind/:id/delete
//   POST   /api/index/:kind/:id/parent   (add parent — multi-parent is additive)
//   DELETE /api/index/:kind/:id/parent   (remove parent)
//   GET    /api/index/search?q=...        (palette search; rows + recent pages)
//
// The old per-kind rename/merge/archive endpoints stay as deprecation shims.

app.get('/api/index/tree', (req, res) => {
  try {
    const includeArchived = req.query.archived === 'all';
    const tree = _db().listIndexTree({ includeArchived });
    res.json(tree);
  } catch (err) {
    console.error('index tree failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// On-expand payload for a single index node: direct children + daily logs,
// collections, artifacts, references reached via pages linked to this node.
app.get('/api/index/:kind/:id/connections', (req, res) => {
  try {
    const r = _db().getIndexNodeConnections(req.params.kind, req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/index/:kind/:id/rename', (req, res) => {
  const { label } = req.body || {};
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'label required' });
  try {
    const r = _db().renameIndexRow(req.params.kind, req.params.id, String(label).trim());
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/index/:kind/:id/merge', (req, res) => {
  const { into_id } = req.body || {};
  if (!into_id) return res.status(400).json({ error: 'into_id required' });
  try {
    const r = _db().mergeIndexRows(req.params.kind, req.params.id, into_id);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/index/:kind/:id/archive', (req, res) => {
  const archived = !!(req.body && req.body.archived);
  try {
    const r = _db().archiveIndexRow(req.params.kind, req.params.id, archived);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/index/:kind/:id/delete', (req, res) => {
  try {
    const r = _db().deleteIndexRow(req.params.kind, req.params.id);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/index/:kind/:id/parent', (req, res) => {
  const { parent_kind, parent_id } = req.body || {};
  if (!parent_kind || !parent_id) return res.status(400).json({ error: 'parent_kind and parent_id required' });
  try {
    const r = _db().setIndexParent(req.params.kind, req.params.id, parent_kind, parent_id);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/index/:kind/:id/parent', (req, res) => {
  const parentKind = req.query.parent_kind || (req.body && req.body.parent_kind);
  const parentId = req.query.parent_id || (req.body && req.body.parent_id);
  if (!parentKind || !parentId) return res.status(400).json({ error: 'parent_kind and parent_id required' });
  try {
    _db().removeIndexParent(req.params.kind, req.params.id, parentKind, parentId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/index/:kind/:id/convert', (req, res) => {
  const { to_kind } = req.body || {};
  if (!to_kind) return res.status(400).json({ error: 'to_kind required' });
  try {
    const result = _db().convertEntityKind(req.params.kind, req.params.id, to_kind);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Lightweight palette search — ranks index rows (any kind) + recent pages +
// daily logs. Intended to back Cmd-K. No FTS wizardry; LIKE + score.
app.get('/api/index/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ results: [] });
  const like = `%${q}%`;
  const results = [];

  const tree = _db().listIndexTree({ includeArchived: false });
  for (const section of tree.kinds) {
    const walk = (rows, parentPath = []) => {
      for (const row of rows) {
        if (row._repeat) continue;
        const label = row.label || '';
        if (label.toLowerCase().includes(q)) {
          results.push({
            kind: row.kind,
            id: row.id,
            label,
            path: parentPath.join(' > '),
            section: section.label,
            score: label.toLowerCase().startsWith(q) ? 3 : 2,
            type: 'index_row',
          });
        }
        if (row.children?.length) walk(row.children, [...parentPath, label]);
      }
    };
    walk(section.active);
  }

  // Recent pages — match on summary.
  const pageRows = _db()._dbOrPrepare
    ? []
    : require('./db').__raw ? [] : [];
  try {
    const rows = _db().searchAll ? _db().searchAll(q, 15) : [];
    for (const p of (rows || [])) {
      results.push({
        kind: 'page',
        id: p.page_id || p.id,
        label: p.summary || p.title || 'page',
        path: p.volume ? `v.${p.volume} p.${p.page_number || '?'}` : '',
        section: 'Pages',
        score: 1,
        type: 'page',
      });
    }
  } catch {}

  // Daily logs: match YYYY-MM-DD.
  if (/^\d{4}-\d{2}/.test(q)) {
    try {
      const dlRows = _db().listDailyLogsFlat ? _db().listDailyLogsFlat() : [];
      for (const d of (dlRows || [])) {
        if (d.date && d.date.includes(q)) {
          results.push({ kind: 'day', id: d.id, label: d.date, path: '', section: 'Daily logs', score: 2, type: 'day' });
        }
      }
    } catch {}
  }

  results.sort((a, b) => b.score - a.score);
  res.json({ results: results.slice(0, 40) });
});

// =============================================================================
// Phase 6 — AI-described indexes
// =============================================================================

app.post('/api/user-indexes/ai', async (req, res) => {
  const { title, description } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
  if (!description || !String(description).trim()) return res.status(400).json({ error: 'description required' });
  try {
    const structure = await generateIndexStructure(description);
    const { root } = _db().createAIIndexTree({ title: String(title).trim(), description: String(description).trim(), structure });
    // Kick off a background classification sweep over all pages.
    setImmediate(() => classifyAllPagesForIndex(root.id));
    res.json({ ok: true, root });
  } catch (err) {
    console.error('ai index creation failed:', err);
    res.status(500).json({ error: 'AI index creation failed', detail: err.message });
  }
});

app.post('/api/user-indexes/ai/suggest', async (req, res) => {
  try {
    const sample = [];
    const tree = _db().listIndexTree({ includeArchived: false });
    for (const section of tree.kinds) {
      if (!['topic', 'person', 'scripture', 'collection', 'book'].includes(section.kind)) continue;
      for (const row of section.active) {
        if (row._repeat) continue;
        sample.push({ kind: row.kind, id: row.id, label: row.label });
        if (sample.length >= 80) break;
      }
      if (sample.length >= 80) break;
    }
    const { proposals } = await suggestMetaCategories(sample);
    res.json({ proposals });
  } catch (err) {
    console.error('meta-category suggestion failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Accept a meta-category proposal — creates a user_index with the supplied
// title/description, links candidate children as index_parents, and kicks off
// the classifier sweep.
app.post('/api/user-indexes/ai/accept', (req, res) => {
  const { title, description, candidate_children } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const structure = { root_description: description || '', children: [] };
    const { root } = _db().createAIIndexTree({
      title: String(title).trim(),
      description: description || '',
      structure,
    });
    for (const ch of (candidate_children || [])) {
      if (!ch || !ch.kind || !ch.id) continue;
      try { _db().setIndexParent(ch.kind, ch.id, 'user_index', root.id); } catch {}
    }
    setImmediate(() => classifyAllPagesForIndex(root.id));
    res.json({ ok: true, root });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reclassify every page against a single user_index's leaf slots.
app.post('/api/index/:id/reclassify', (req, res) => {
  const id = req.params.id;
  try {
    const row = _db().lookupIndexRow('user_index', id);
    if (!row) return res.status(404).json({ error: 'Index not found' });
    setImmediate(() => classifyAllPagesForIndex(id));
    res.json({ ok: true, scheduled: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Bootstrap: re-examine every page with a hint so Gemini surfaces missed
// people/topic entities. Best-effort, throttled.
app.post('/api/bootstrap/entities', (req, res) => {
  try {
    const ids = _db().listAllPageIds();
    setImmediate(() => bootstrapEntitiesSweep(ids));
    res.json({ ok: true, scheduled: ids.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function bootstrapEntitiesSweep(ids) {
  for (let i = 0; i < ids.length; i++) {
    try {
      await reexaminePageInBackground(ids[i], {
        kind: 'hint',
        label: 'Surface any people or topics that may have been missed earlier.',
      });
    } catch (e) {
      console.warn('bootstrap entity skip', ids[i], e.message);
    }
    // Gentle pacing — don't fire 300 Gemini calls at once.
    await new Promise(r => setTimeout(r, 400));
  }
}

// =============================================================================
// Phase 6 — Right-pane Home + classifier background
// =============================================================================

app.get('/api/home', (req, res) => {
  try {
    res.json(_db().getHomePayload());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Classify a single page against every AI-index leaf slot. Best-effort.
async function classifyPageForIndexesInBackground(pageId) {
  try {
    const leaves = _db().listAIIndexLeaves();
    if (!leaves.length) return;
    const payload = _db().getPageClassifierPayload(pageId);
    if (!payload) return;
    const candidates = leaves.map(l => ({
      id: l.id,
      label: l.label,
      description: l.description || '',
      path: l.path || l.label,
    }));
    const { matches } = await classifyPageForIndexes({
      pageSummary: payload.pageSummary,
      items: payload.items,
      candidateLeaves: candidates,
    });
    for (const m of (matches || [])) {
      if (!m.id) continue;
      const confidence = Number(m.confidence || 0);
      const roleSummary = (m.role_summary || '').trim() || null;
      if (confidence >= 0.75) {
        _db().upsertPageIndexLink({ pageId, userIndexId: m.id, confidence, roleSummary });
      } else if (confidence >= 0.50) {
        // Queue a backlog proposal the user can accept/reject.
        const leaf = leaves.find(l => l.id === m.id);
        if (leaf) {
          try {
            _db().insertBacklogItems([{
              id: require('crypto').randomUUID(),
              kind: 'filing',
              subject: `Auto-classify page ${pageId.slice(0, 8)} in "${leaf.path || leaf.label}"?`,
              proposal: roleSummary ? `Link page because: ${roleSummary}` : `Link page to ${leaf.path || leaf.label}`,
              context_page_id: pageId,
              answer_format: null,
              answer_options: null,
            }]);
          } catch {}
        }
      }
    }
    // Update last_classified_at on the AI index roots touched.
    const touchedIdxIds = new Set(matches.map(m => m.id).filter(Boolean));
    for (const idxId of touchedIdxIds) {
      try { _db().touchUserIndexClassifiedAt(idxId); } catch {}
    }
  } catch (err) {
    console.warn('classifyPageForIndexesInBackground failed:', err.message);
  }
}

// Sweep every page against the given AI index's leaves.
async function classifyAllPagesForIndex(rootUserIndexId) {
  try {
    const ids = _db().listAllPageIds();
    for (let i = 0; i < ids.length; i++) {
      await classifyPageForIndexesInBackground(ids[i]);
      await new Promise(r => setTimeout(r, 300));
    }
    try { _db().touchUserIndexClassifiedAt(rootUserIndexId); } catch {}
  } catch (err) {
    console.warn('classifyAllPagesForIndex failed:', err.message);
  }
}

// =============================================================================
// Indexing sharpen — Headings (TOC) + cross-kind auto-link + noise-filtered AI indexes
// =============================================================================

// ── Headings ────────────────────────────────────────────────────────────────
app.get('/api/headings', (req, res) => {
  try {
    const includeArchived = req.query.archived === 'all';
    res.json({ items: _db().listHeadings({ includeArchived }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/headings', (req, res) => {
  const { label, description } = req.body || {};
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'label required' });
  try {
    const r = _db().createHeading({ label: String(label).trim(), description: description || null });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Cross-kind auto-link classifier ─────────────────────────────────────────
// Debounce rapid repeat scheduling of the same (kind, id). Keeps a small
// in-memory timer map keyed by `${kind}:${id}`.
const CROSS_KIND_DEBOUNCE_MS = 30 * 1000;
const _crossKindDebounce = new Map();
function scheduleCrossKindClassify(kind, id, { force = false } = {}) {
  const key = `${kind}:${id}`;
  const existing = _crossKindDebounce.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    _crossKindDebounce.delete(key);
    classifyRowForCrossKindInBackground(kind, id, { force }).catch(err =>
      console.warn('[cross-kind] bg classify failed:', key, err.message)
    );
  }, 50);
  _crossKindDebounce.set(key, t);
}

// Cheap bag-of-words overlap for pre-filtering the candidate pool to ≤ CAP.
// Prevents sending the whole vault to Gemini when hundreds of rows exist.
function _rankCrossKindCandidates(from, candidates, cap = 40) {
  const tokens = (s) => new Set(
    String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3)
  );
  const fromTok = tokens(`${from.label} ${from.description}`);
  if (!fromTok.size) return candidates.slice(0, cap);
  const scored = candidates.map(c => {
    const ct = tokens(`${c.label} ${c.description}`);
    let overlap = 0;
    for (const t of ct) if (fromTok.has(t)) overlap++;
    return { ...c, _score: overlap };
  });
  scored.sort((a, b) => b._score - a._score);
  // If nothing overlaps, still return the first `cap` so the AI gets SOMETHING.
  const nonZero = scored.filter(s => s._score > 0);
  return (nonZero.length >= cap ? nonZero : scored).slice(0, cap).map(({ _score, ...r }) => r);
}

async function classifyRowForCrossKindInBackground(fromKind, fromId, { force = false } = {}) {
  try {
    const fromRow = _db().getCrossKindContent(fromKind, fromId);
    if (!fromRow) return { linked: 0, proposals: 0, skipped: 'not_found' };
    // Hash-skip: if nothing meaningful changed since the last sweep, no AI call.
    if (!force) {
      const hashState = _db().refreshContentHash(fromKind, fromId);
      // First-run (no prior classify) always runs. Otherwise require a hash change.
      if (!hashState.changed && fromRow.links_classified_at) {
        return { linked: 0, proposals: 0, skipped: 'unchanged' };
      }
    } else {
      _db().refreshContentHash(fromKind, fromId);
    }
    const allCandidates = _db().listCrossKindCandidates({ excludeKind: fromKind, excludeId: fromId });
    if (!allCandidates.length) {
      _db().markLinksClassified(fromKind, fromId);
      return { linked: 0, proposals: 0 };
    }
    const candidates = _rankCrossKindCandidates(fromRow, allCandidates, 40);
    const { matches } = await classifyRowForCrossKind({
      fromRow: { kind: fromKind, label: fromRow.label || '', description: fromRow.description || '' },
      candidates: candidates.map(c => ({ kind: c.kind, id: c.id, label: c.label, description: c.description })),
    });
    let linked = 0, proposals = 0;
    for (const m of (matches || [])) {
      if (!m || !m.kind || !m.id) continue;
      const confidence = Number(m.confidence || 0);
      const roleSummary = (m.role_summary || '').trim() || null;
      if (confidence >= 0.75) {
        try {
          _db().linkBetween({
            from_type: fromKind, from_id: fromId, to_type: m.kind, to_id: m.id,
            confidence, role_summary: roleSummary,
          });
          linked++;
        } catch (e) { console.warn('[cross-kind] link failed:', e.message); }
      } else if (confidence >= 0.50) {
        try {
          _db().insertBacklogItems([{
            id: crypto.randomUUID(),
            kind: 'filing',
            subject: `Auto-link ${fromKind} "${fromRow.label || fromId.slice(0,6)}" to ${m.kind} "${m.label || ''}"?`,
            proposal: roleSummary || `Proposed link at ${Math.round(confidence * 100)}% confidence.`,
            context_page_id: null,
          }]);
          proposals++;
        } catch {}
      }
    }
    _db().markLinksClassified(fromKind, fromId);
    return { linked, proposals };
  } catch (err) {
    console.warn('classifyRowForCrossKindInBackground failed:', err.message);
    return { linked: 0, proposals: 0, error: err.message };
  }
}

// Synchronous find-related: bypasses the hash-skip and debounce, returns counts.
app.post('/api/index/:kind/:id/find-related', async (req, res) => {
  const { kind, id } = req.params;
  if (!['collection', 'artifact', 'reference', 'daily_log'].includes(kind)) {
    return res.status(400).json({ error: `find-related not supported for kind: ${kind}` });
  }
  try {
    const r = await classifyRowForCrossKindInBackground(kind, id, { force: true });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── User-index noise filter: exclusions / inclusions / rebuild ──────────────
app.get('/api/user-indexes/:id/exclusions', (req, res) => {
  try {
    const auto = [];
    const user = [];
    const all = _db().listUserIndexExclusions(req.params.id);
    for (const row of all) {
      const ref = _db().lookupIndexRow(row.entity_kind, row.entity_id);
      const enriched = { ...row, label: ref ? ref.label : null };
      if (row.reason === 'auto_high_frequency') auto.push(enriched);
      else user.push(enriched);
    }
    const inclusions = _db().listUserIndexInclusions(req.params.id).map(row => ({
      ...row, label: (_db().lookupIndexRow(row.entity_kind, row.entity_id) || {}).label || null,
    }));
    res.json({ auto, user, inclusions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user-indexes/:id/exclusions', (req, res) => {
  const { entity_kind, entity_id, reason } = req.body || {};
  if (!entity_kind || !entity_id) return res.status(400).json({ error: 'entity_kind and entity_id required' });
  try {
    const r = _db().addUserIndexExclusion({
      user_index_id: req.params.id, entity_kind, entity_id, reason: reason || 'user_blocked',
    });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/user-indexes/:id/exclusions/:entryId', (req, res) => {
  try { res.json(_db().removeUserIndexExclusion(req.params.entryId)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/user-indexes/:id/inclusions', (req, res) => {
  const { entity_kind, entity_id } = req.body || {};
  if (!entity_kind || !entity_id) return res.status(400).json({ error: 'entity_kind and entity_id required' });
  try {
    const r = _db().addUserIndexInclusion({ user_index_id: req.params.id, entity_kind, entity_id });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/user-indexes/:id/inclusions/:entryId', (req, res) => {
  try { res.json(_db().removeUserIndexInclusion(req.params.entryId)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Rebuild a topical (back-of-book) user_index: sweep the vault, noise-filter,
// AI-confirm, then stamp auto-exclusions. User-blocked exclusions and forced
// inclusions are preserved.
const NOISE_FRACTION = 0.25;
app.post('/api/user-indexes/:id/rebuild', async (req, res) => {
  const id = req.params.id;
  try {
    const row = _db().lookupIndexRow('user_index', id);
    if (!row) return res.status(404).json({ error: 'Index not found' });
    const totalPages = (_db().listAllPageIds() || []).length || 1;

    // Gather candidate pool across the back-of-book kinds. Topical indexes are
    // about themes, so we sweep person + topic + scripture + collection + artifact + reference.
    const tree = _db().listIndexTree({ includeArchived: false });
    const candidates = [];
    for (const section of tree.kinds) {
      if (!['person', 'topic', 'scripture', 'collection', 'artifact', 'reference'].includes(section.kind)) continue;
      const walk = (rows) => {
        for (const r of rows) {
          if (r._repeat) continue;
          const count = Number(r.count || r.pages_count || r.direct_count || 0);
          candidates.push({ kind: r.kind, id: r.id, label: r.label, page_count: count });
          if (r.children?.length) walk(r.children);
        }
      };
      walk(section.active);
    }

    // Purge prior auto-exclusions — we recompute them. User-blocked + inclusions stay.
    _db().purgeAutoUserIndexExclusions(id);

    // Noise pre-filter: anything appearing on > NOISE_FRACTION of pages.
    const threshold = Math.max(3, Math.floor(totalPages * NOISE_FRACTION));
    const userBlockedSet = new Set(_db().listUserIndexExclusions(id)
      .filter(e => e.reason === 'user_blocked')
      .map(e => `${e.entity_kind}:${e.entity_id}`));
    const forcedSet = new Set(_db().listUserIndexInclusions(id)
      .map(e => `${e.entity_kind}:${e.entity_id}`));
    const eligible = [];
    for (const c of candidates) {
      const key = `${c.kind}:${c.id}`;
      if (userBlockedSet.has(key)) continue;
      if (forcedSet.has(key)) { eligible.push(c); continue; }
      if (c.page_count > threshold) {
        _db().addUserIndexExclusion({
          user_index_id: id, entity_kind: c.kind, entity_id: c.id,
          reason: 'auto_high_frequency',
        });
        continue;
      }
      eligible.push(c);
    }

    // AI pass to cull the context-sensitive noise. Cap payload to avoid blowing
    // the request size on vaults with thousands of candidates.
    const forAi = eligible.slice(0, 200);
    let aiEntries = [];
    let aiRejected = [];
    try {
      const resp = await generateTopicalIndexEntries({
        indexTitle: row.label,
        indexDescription: row.description || row.structure_description || '',
        candidates: forAi.map(c => ({ kind: c.kind, id: c.id, label: c.label, page_count: c.page_count })),
        totalPages,
      });
      aiEntries = resp.entries || [];
      aiRejected = resp.rejected || [];
    } catch (err) {
      console.warn('generateTopicalIndexEntries failed:', err.message);
      aiEntries = forAi.map(c => ({ kind: c.kind, id: c.id }));
    }
    // Record AI rejections as auto-exclusions.
    for (const r of aiRejected) {
      if (!r || !r.kind || !r.id) continue;
      if (userBlockedSet.has(`${r.kind}:${r.id}`)) continue;
      _db().addUserIndexExclusion({
        user_index_id: id, entity_kind: r.kind, entity_id: r.id,
        reason: 'auto_high_frequency',
      });
    }

    _db().touchUserIndexClassifiedAt(id);
    res.json({
      ok: true,
      total_candidates: candidates.length,
      auto_excluded: candidates.length - eligible.length,
      ai_rejected: aiRejected.length,
      entries: aiEntries.length,
      forced_included: forcedSet.size,
    });
  } catch (err) {
    console.error('rebuild failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Expose the re-scan cascade as its own endpoint so the UI can call it cleanly
// from a page tab. Replaces the old /api/scans/reingest delete step.
app.post('/api/pages/by-scan-path/delete', (req, res) => {
  const { scan_path } = req.body || {};
  if (!scan_path) return res.status(400).json({ error: 'scan_path required' });
  try {
    const r = _db().deletePagesByScanPathCascade(scan_path);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/dedup-pages', (req, res) => {
  try {
    const result = _db().deduplicatePages();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Foxed running at http://localhost:${PORT}`);
    try { _db().syncGlossaryFromBacklog(); } catch (e) { console.warn('[glossary] seed failed:', e.message); }
  });
}

module.exports = app;
