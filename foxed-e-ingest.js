#!/usr/bin/env node
// Ingest E PDFs + C doc 5 one at a time.
// Tolerates server crashing mid-stream — monitors DB until pages stabilize.
const { execSync, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FOXED = '/Users/nathancolestock/foxed';
const BASE = path.join(process.env.HOME, 'Desktop/notebook import');
process.chdir(FOXED);
const db = require('better-sqlite3')(path.join(FOXED, 'data/foxed.db'));

function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function md5(f) { return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'); }
function pageCount(vol) { return db.prepare('SELECT COUNT(*) n FROM pages WHERE volume=?').get(vol).n; }
function failureCount() { return db.prepare("SELECT COUNT(*) n FROM ingest_failures WHERE status='failed'").get().n; }
function pdftoppmRunning() { try { const r = execSync('pgrep -c pdftoppm', {encoding:'utf8'}).trim(); return parseInt(r) > 0; } catch(_) { return false; } }
function serverUp() { return new Promise(r => { const req = http.request({hostname:'localhost',port:3747,path:'/api/collections',method:'GET',timeout:3000}, res => r(res.statusCode < 500)); req.on('error', () => r(false)); req.on('timeout', () => { req.destroy(); r(false); }); req.end(); }); }

async function waitForIdle(vol, pagesBefore) {
  log(`  Waiting for processing to complete (vol=${vol}, baseline=${pagesBefore})...`);
  let stable = 0;
  let lastCount = pagesBefore;
  while (stable < 4) {
    await sleep(10000);
    const current = pageCount(vol);
    const rendering = pdftoppmRunning();
    if (current !== lastCount) { stable = 0; lastCount = current; log(`  ...${current} pages (${vol})`); }
    else if (!rendering) { stable++; }
    else { stable = 0; }
    if (stable >= 4 && !rendering) break;
  }
  return pageCount(vol);
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    if (await serverUp()) return true;
    log('  Server not ready, waiting...');
    await sleep(3000);
  }
  return false;
}

function postPdf(pdfPath, volume) {
  return new Promise((resolve) => {
    const boundary = '----FormBoundary' + crypto.randomUUID().replace(/-/g,'');
    const fileContent = fs.readFileSync(pdfPath);
    const basename = path.basename(pdfPath);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="scan"; filename="${basename}"\r\nContent-Type: application/pdf\r\n\r\n`),
      fileContent,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="volume"\r\n\r\n${volume}\r\n--${boundary}--\r\n`)
    ]);
    const options = {
      hostname: 'localhost', port: 3747,
      path: '/api/ingest/stream', method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      timeout: 14400000,
    };
    let pages = 0, gotDone = false, uuid = null, buf = '';
    const req = http.request(options, res => {
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buf += chunk;
        for (const line of buf.split('\n')) {
          buf = buf.slice(line.length + 1);
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'page') {
              pages++;
              if (!uuid && ev.page && ev.page.scan_path) {
                const m = ev.page.scan_path.match(/\/scans\/([0-9a-f-]{36})-/);
                if (m) uuid = m[1];
              }
              process.stdout.write('.');
            } else if (ev.type === 'done') { gotDone = true; console.log(''); }
            else if (ev.type === 'error') log(`  ERR: ${ev.error}`);
          } catch(_) {}
        }
      });
      res.on('end', () => resolve({ pages, gotDone, uuid }));
    });
    req.on('error', e => { console.log(''); resolve({ pages, gotDone, uuid, err: e.message }); });
    req.write(body);
    req.end();
  });
}

function writeSidecar(pdfPath, vol, pagesIngested, uuid) {
  const sidecar = {
    pdf_path: pdfPath, pdf_basename: path.basename(pdfPath), volume: vol,
    pdf_md5: md5(pdfPath), upload_uuid: uuid, pages_ingested: pagesIngested,
    ingested_at_utc: new Date().toISOString(), marker_version: 1,
  };
  fs.writeFileSync(pdfPath + '.ingested', JSON.stringify(sidecar, null, 2));
  log(`  Sidecar written`);
}

async function ingestOne(pdfPath, vol) {
  const base = path.basename(pdfPath);
  const sidecar = pdfPath + '.ingested';
  if (fs.existsSync(sidecar)) {
    const s = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    if (s.pdf_md5 === md5(pdfPath)) { log(`SKIP ${vol}/${base}`); return; }
    fs.unlinkSync(sidecar);
  }

  if (!await waitForServer()) throw new Error('Server not up');
  const before = pageCount(vol);
  const failsBefore = failureCount();
  log(`START ${vol}/${base} (${(fs.statSync(pdfPath).size/1024/1024).toFixed(1)}MB) — ${before} pages now`);

  const result = await postPdf(pdfPath, vol);
  log(`  stream: pages=${result.pages} done=${result.gotDone} err=${result.err||'none'}`);

  // Whether stream succeeded or server crashed, wait for processing to fully settle
  const after = await waitForIdle(vol, before);
  const added = after - before;
  const failsAfter = failureCount();
  const newFails = failsAfter - failsBefore;
  log(`  Done: ${added} pages added, ${newFails} new failures, total ${vol}=${after}`);

  // Get UUID from newly added pages if stream didn't give us one
  let uuid = result.uuid;
  if (!uuid && added > 0) {
    const newPage = db.prepare('SELECT scan_path FROM pages WHERE volume=? ORDER BY rowid DESC LIMIT 1').get(vol);
    if (newPage && newPage.scan_path) {
      const m = newPage.scan_path.match(/\/scans\/([0-9a-f-]{36})-/);
      if (m) uuid = m[1];
    }
  }
  if (added > 0 || result.gotDone) writeSidecar(pdfPath, vol, added, uuid || '');
}

async function main() {
  const pdfs = [
    { vol: 'C', name: 'Scanned Document 5.pdf' },
    { vol: 'E', name: 'Scanned Document.pdf' },
    { vol: 'E', name: 'Scanned Document 2.pdf' },
    { vol: 'E', name: 'Scanned Document 3.pdf' },
    { vol: 'E', name: 'Scanned Document 4.pdf' },
    { vol: 'E', name: 'Scanned Document 5.pdf' },
  ];

  for (const { vol, name } of pdfs) {
    const pdfPath = path.join(BASE, vol, name);
    if (!fs.existsSync(pdfPath)) { log(`MISSING: ${vol}/${name}`); continue; }
    await ingestOne(pdfPath, vol);
    log('Waiting 45s before next PDF...');
    await sleep(45000);
  }

  // Final retry pass
  log('\n=== Final retry-all pass ===');
  const remaining = failureCount();
  log(`${remaining} failures queued`);
  if (remaining > 0) {
    await new Promise((resolve) => {
      let buf = '';
      const options = { hostname:'localhost', port:3747, path:'/api/ingest-failures/retry-all', method:'POST', timeout:7200000 };
      const req = http.request(options, res => {
        res.setEncoding('utf8');
        res.on('data', c => {
          buf += c;
          for (const line of buf.split('\n')) {
            buf = buf.slice(line.length + 1);
            if (!line.trim()) continue;
            try {
              const ev = JSON.parse(line);
              if (ev.type === 'resolved') process.stdout.write('✓');
              else if (ev.type === 'failed') process.stdout.write('✗');
              else if (ev.type === 'done') { console.log(''); log(`retry-all done: resolved=${ev.resolved} still_failed=${ev.still_failed}`); }
            } catch(_) {}
          }
        });
        res.on('end', resolve);
      });
      req.on('error', e => { log(`retry-all error: ${e.message}`); resolve(); });
      req.end();
    });
  }

  // Verify
  log('\n=== VERIFICATION ===');
  const pages = db.prepare('SELECT volume, COUNT(*) n FROM pages GROUP BY volume ORDER BY volume').all();
  pages.forEach(r => log(`  ${r.volume||'(null)'}: ${r.n} pages`));
  log(`  failures remaining: ${failureCount()}`);
  const crossVol = db.prepare(`
    SELECT COUNT(*) n FROM links l
    JOIN pages pf ON pf.id=l.from_id JOIN pages pt ON pt.id=l.to_id
    WHERE l.from_type='page' AND l.to_type='page' AND pf.volume!=pt.volume
  `).get().n;
  log(`  cross-volume page links: ${crossVol} ${crossVol===0?'(OK)':'(FIXING)'}`);
  if (crossVol > 0) {
    db.prepare(`DELETE FROM links WHERE id IN (SELECT l.id FROM links l JOIN pages pf ON pf.id=l.from_id JOIN pages pt ON pt.id=l.to_id WHERE l.from_type='page' AND l.to_type='page' AND pf.volume!=pt.volume)`).run();
    log('  Cross-volume links deleted');
  }
  log('=== Complete ===');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
