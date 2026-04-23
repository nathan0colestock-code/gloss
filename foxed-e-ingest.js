#!/usr/bin/env node
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = path.join(process.env.HOME, 'Desktop/notebook import');
const FOXED = '/Users/nathancolestock/foxed';

function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function md5(f) { return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'); }

function dbGet(sql, ...params) {
  const db = require('better-sqlite3')(path.join(FOXED, 'data/foxed.db'));
  const result = db.prepare(sql).get(...params);
  db.close();
  return result;
}

function pageCount(vol) { return dbGet('SELECT COUNT(*) n FROM pages WHERE volume=?', vol).n; }
function failureCount() { return dbGet("SELECT COUNT(*) n FROM ingest_failures WHERE status='failed'").n; }

function serverUp() {
  try {
    const r = spawnSync('/usr/bin/curl', ['-s', '--max-time', '3', 'http://localhost:3747/api/collections'], {encoding:'utf8'});
    return r.status === 0 && r.stdout.length > 10;
  } catch(_) { return false; }
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    if (serverUp()) return true;
    log('  Server not ready, waiting 3s...');
    await sleep(3000);
  }
  return false;
}

async function waitForIdle(vol, baseline) {
  log(`  Waiting for DB to stabilize (baseline=${baseline})...`);
  let stable = 0, last = baseline;
  while (stable < 4) {
    await sleep(10000);
    const current = pageCount(vol);
    if (current !== last) { stable = 0; last = current; log(`  ...${current} pages (${vol})`); }
    else stable++;
  }
  return pageCount(vol);
}

function curlIngest(pdfPath, vol) {
  const tmp = `/tmp/ingest-${vol}-${path.basename(pdfPath).replace(/ /g,'_')}.log`;
  const result = spawnSync('/usr/bin/curl', [
    '-sS', '--max-time', '14400', '-N',
    '-F', `scan=@${pdfPath}`,
    '-F', `volume=${vol}`,
    'http://localhost:3747/api/ingest/stream'
  ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  fs.writeFileSync(tmp, result.stdout + result.stderr);
  const pages = (result.stdout.match(/"type":"page"/g) || []).length;
  const done = result.stdout.includes('"type":"done"');
  const uuidMatch = result.stdout.match(/\/scans\/([0-9a-f-]{36})-/);
  return { rc: result.status, pages, done, uuid: uuidMatch ? uuidMatch[1] : null, err: result.stderr.trim() };
}

function writeSidecar(pdfPath, vol, pagesIngested, uuid) {
  fs.writeFileSync(pdfPath + '.ingested', JSON.stringify({
    pdf_path: pdfPath, pdf_basename: path.basename(pdfPath), volume: vol,
    pdf_md5: md5(pdfPath), upload_uuid: uuid || '', pages_ingested: pagesIngested,
    ingested_at_utc: new Date().toISOString(), marker_version: 1,
  }, null, 2));
  log('  Sidecar written');
}

async function ingestOne(pdfPath, vol) {
  const base = path.basename(pdfPath);
  const sidecar = pdfPath + '.ingested';
  if (fs.existsSync(sidecar)) {
    const s = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    if (s.pdf_md5 === md5(pdfPath)) { log(`SKIP ${vol}/${base}`); return; }
    fs.unlinkSync(sidecar);
  }

  if (!await waitForServer()) throw new Error('Server down');
  const before = pageCount(vol);
  log(`START ${vol}/${base} (${(fs.statSync(pdfPath).size/1024/1024).toFixed(1)}MB) — ${before} pages now`);

  const stream = curlIngest(pdfPath, vol);
  log(`  stream: rc=${stream.rc} pages=${stream.pages} done=${stream.done} ${stream.err||''}`);

  const after = await waitForIdle(vol, before);
  const added = after - before;
  log(`  Done: +${added} pages, total ${vol}=${after}, failures=${failureCount()}`);

  // Get UUID from DB if stream didn't provide it
  let uuid = stream.uuid;
  if (!uuid && added > 0) {
    const db = require('better-sqlite3')(path.join(FOXED, 'data/foxed.db'));
    const row = db.prepare('SELECT scan_path FROM pages WHERE volume=? ORDER BY rowid DESC LIMIT 1').get(vol);
    db.close();
    if (row) { const m = row.scan_path.match(/\/scans\/([0-9a-f-]{36})-/); if (m) uuid = m[1]; }
  }

  if (added > 0 || stream.done) writeSidecar(pdfPath, vol, added, uuid);
}

async function main() {
  const pdfs = [
    { vol: 'E', name: 'Scanned Document.pdf' },
    { vol: 'E', name: 'Scanned Document 2.pdf' },
    { vol: 'E', name: 'Scanned Document 3.pdf' },
    { vol: 'E', name: 'Scanned Document 4.pdf' },
    { vol: 'E', name: 'Scanned Document 5.pdf' },
  ];

  for (let i = 0; i < pdfs.length; i++) {
    const { vol, name } = pdfs[i];
    const pdfPath = path.join(BASE, vol, name);
    if (!fs.existsSync(pdfPath)) { log(`MISSING: ${vol}/${name}`); continue; }
    await ingestOne(pdfPath, vol);
    if (i < pdfs.length - 1) { log('Waiting 45s...'); await sleep(45000); }
  }

  // Retry-all pass
  log('\n=== retry-all pass ===');
  const rem = failureCount();
  log(`${rem} failures queued`);
  if (rem > 0) {
    const r = spawnSync('/usr/bin/curl', ['-sS', '--max-time', '7200', '-N', '-X', 'POST',
      'http://localhost:3747/api/ingest-failures/retry-all'], {encoding:'utf8', maxBuffer:10*1024*1024});
    const resolved = (r.stdout.match(/"type":"resolved"/g)||[]).length;
    const failed = (r.stdout.match(/"type":"failed"/g)||[]).length;
    log(`retry-all: resolved=${resolved} still_failed=${failed}`);
  }

  // Verify
  log('\n=== VERIFICATION ===');
  const db = require('better-sqlite3')(path.join(FOXED, 'data/foxed.db'));
  db.prepare('SELECT volume, COUNT(*) n FROM pages GROUP BY volume ORDER BY volume').all()
    .forEach(r => log(`  ${r.volume||'(null)'}: ${r.n}`));
  log(`  failures remaining: ${failureCount()}`);
  const x = db.prepare(`SELECT COUNT(*) n FROM links l JOIN pages pf ON pf.id=l.from_id JOIN pages pt ON pt.id=l.to_id WHERE l.from_type='page' AND l.to_type='page' AND pf.volume!=pt.volume`).get().n;
  log(`  cross-volume links: ${x} ${x===0?'(OK)':'(FIXING)'}`);
  if (x > 0) { db.prepare(`DELETE FROM links WHERE id IN (SELECT l.id FROM links l JOIN pages pf ON pf.id=l.from_id JOIN pages pt ON pt.id=l.to_id WHERE l.from_type='page' AND l.to_type='page' AND pf.volume!=pt.volume)`).run(); log('  -> deleted'); }
  db.close();
  log('=== Complete ===');
}

main().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
