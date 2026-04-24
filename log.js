// Structured logging for Gloss.
//
// Every emission goes to a 1000-entry in-memory ring buffer (used by the
// Maestro log collector via GET /api/logs/recent) and is also echoed to
// stderr as a single-line JSON record. Levels: debug | info | warn | error.
//
// Callers:
//   log('info', 'event_name', { any: 'context' })
//   const child = log.child({ trace_id: 'abc' }); child('info', 'ev', {...})
//
// This file is intentionally dependency-free so it can load before db.js.

const APP = 'gloss';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_MAX = 1000;

const ring = [];
let LEVEL_MIN = LEVELS[process.env.LOG_LEVEL] || LEVELS.debug;

function push(entry) {
  ring.push(entry);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

function emit(level, event, ctx = {}) {
  const levelNum = LEVELS[level] ?? LEVELS.info;
  if (levelNum < LEVEL_MIN) return;
  const entry = {
    ts: new Date().toISOString(),
    app: APP,
    level,
    event: String(event || 'unknown'),
    ctx: ctx && typeof ctx === 'object' ? { ...ctx } : { value: ctx }
  };
  // Hoist standard correlation fields to top level for easier querying.
  for (const k of ['trace_id', 'request_id', 'duration_ms']) {
    if (entry.ctx[k] !== undefined) {
      entry[k] = entry.ctx[k];
      delete entry.ctx[k];
    }
  }
  push(entry);
  try {
    process.stderr.write(JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort; never throw from logging.
  }
}

function log(level, event, ctx) {
  emit(level, event, ctx);
}

log.child = function child(baseCtx = {}) {
  return (level, event, ctx = {}) => emit(level, event, { ...baseCtx, ...ctx });
};

log.recent = function recent({ since, level, limit } = {}) {
  const minLevel = level && LEVELS[level] !== undefined ? LEVELS[level] : LEVELS.debug;
  let sinceMs = 0;
  if (since) {
    const d = new Date(since);
    if (!Number.isNaN(d.getTime())) sinceMs = d.getTime();
  }
  const out = [];
  for (const entry of ring) {
    if (LEVELS[entry.level] < minLevel) continue;
    if (sinceMs && new Date(entry.ts).getTime() < sinceMs) continue;
    out.push(entry);
  }
  const n = Math.min(Math.max(parseInt(limit, 10) || 200, 1), RING_MAX);
  return out.slice(-n);
};

log.size = () => ring.length;
log.clear = () => { ring.length = 0; };
log.LEVELS = LEVELS;
log.RING_MAX = RING_MAX;

// HTTP middleware: records method/path/status/duration, propagates X-Trace-Id.
log.httpMiddleware = function httpMiddleware() {
  return function (req, res, next) {
    const start = Date.now();
    const incoming = req.headers['x-trace-id'];
    const traceId = (typeof incoming === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(incoming))
      ? incoming
      : cryptoRandomId();
    req.trace_id = traceId;
    res.setHeader('X-Trace-Id', traceId);
    res.on('finish', () => {
      const duration_ms = Date.now() - start;
      const status = res.statusCode;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      emit(level, 'http', {
        method: req.method,
        path: req.path || req.url,
        status,
        duration_ms,
        trace_id: traceId
      });
    });
    next();
  };
};

// Wrap an outbound call so every invocation gets an `outbound_http` /
// `llm_call` log line with duration and status.
log.outbound = async function outbound(eventName, ctx, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    emit('info', eventName, {
      ...ctx,
      duration_ms: Date.now() - start,
      ok: true
    });
    return result;
  } catch (err) {
    emit('error', eventName, {
      ...ctx,
      duration_ms: Date.now() - start,
      ok: false,
      error: String(err && err.message || err)
    });
    throw err;
  }
};

function cryptoRandomId() {
  try {
    // Lazy-require so this module stays small and doesn't pull node built-ins
    // at import time on non-Node targets.
    return require('crypto').randomUUID();
  } catch {
    return 'tr_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

module.exports = log;
