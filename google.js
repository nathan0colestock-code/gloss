// Google OAuth 2.0 (Installed-app / Desktop) + Docs/Drive content fetcher.
//
// Flow:
//   1. User clicks "Connect Google" → /api/google/connect → 302 to Google consent
//   2. Google redirects to /api/google/oauth-callback?code=…
//   3. Server exchanges the code for tokens and stores refresh_token in SQLite.
//   4. fetchContentForUrl(url) resolves a Docs/Drive URL to plain text, using the
//      refresh_token to mint short-lived access_tokens as needed.
//
// Credentials come from the JSON file at GOOGLE_OAUTH_CLIENT_JSON (env var), or,
// if unset, from the hard-coded path below. In either case, the file is the
// "installed" client JSON downloaded from the GCP console (Desktop app client).

const fs = require('fs');
const path = require('path');
const db = require('./db');

const DEFAULT_CLIENT_JSON = '/Users/nathancolestock/Downloads/client_secret_591963216284-5stv621t6i2gsosbeg1a7a5es87k94fs.apps.googleusercontent.com.json';

function loadClient() {
  const p = process.env.GOOGLE_OAUTH_CLIENT_JSON || DEFAULT_CLIENT_JSON;
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const inst = raw.installed || raw.web || null;
  if (!inst) return null;
  return {
    client_id: inst.client_id,
    client_secret: inst.client_secret,
    auth_uri: inst.auth_uri || 'https://accounts.google.com/o/oauth2/auth',
    token_uri: inst.token_uri || 'https://oauth2.googleapis.com/token',
  };
}

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
];

function getRedirectUri(req) {
  // The "installed" client accepts any http://localhost URI. Use the current host
  // so callback works whether the app is at :3747, :5173, etc.
  const proto = req && req.protocol || 'http';
  const host = (req && req.get && req.get('host')) || `localhost:${process.env.PORT || 3747}`;
  return `${proto}://${host}/api/google/oauth-callback`;
}

function buildAuthUrl(req) {
  const client = loadClient();
  if (!client) throw new Error('Google OAuth client JSON not found. Set GOOGLE_OAUTH_CLIENT_JSON env var.');
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: getRedirectUri(req),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',        // forces refresh_token on every consent
    include_granted_scopes: 'true',
  });
  return `${client.auth_uri}?${params.toString()}`;
}

async function exchangeCode(code, req) {
  const client = loadClient();
  if (!client) throw new Error('Google OAuth client JSON not found');
  const body = new URLSearchParams({
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: getRedirectUri(req),
    grant_type: 'authorization_code',
  });
  const resp = await fetch(client.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`token exchange failed: ${data.error || resp.statusText} ${data.error_description || ''}`);
  if (!data.refresh_token) throw new Error('No refresh_token returned — try disconnecting and reconnecting.');
  const expires_at = data.expires_in ? new Date(Date.now() + (data.expires_in - 30) * 1000).toISOString() : null;
  db.saveGoogleTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at,
    scope: data.scope,
  });
  return db.getGoogleTokens();
}

async function getAccessToken() {
  const row = db.getGoogleTokens();
  if (!row || !row.refresh_token) throw new Error('Google not connected — visit /api/google/connect first');
  if (row.access_token && row.expires_at && new Date(row.expires_at) > new Date()) {
    return row.access_token;
  }
  // refresh
  const client = loadClient();
  if (!client) throw new Error('Google OAuth client JSON not found');
  const body = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: row.refresh_token,
    grant_type: 'refresh_token',
  });
  const resp = await fetch(client.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`token refresh failed: ${data.error || resp.statusText}`);
  const expires_at = data.expires_in ? new Date(Date.now() + (data.expires_in - 30) * 1000).toISOString() : null;
  db.saveGoogleTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token || row.refresh_token,
    expires_at,
    scope: data.scope || row.scope,
  });
  return data.access_token;
}

// Parse a Google URL into { kind, fileId }. Supports:
//   docs.google.com/document/d/<id>/…          → kind 'doc'
//   docs.google.com/spreadsheets/d/<id>/…      → kind 'sheet'
//   docs.google.com/presentation/d/<id>/…      → kind 'slides'
//   drive.google.com/file/d/<id>/…             → kind 'drive-file'
//   drive.google.com/open?id=<id>              → kind 'drive-file'
function parseGoogleUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'docs.google.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'document' && parts[1] === 'd' && parts[2]) return { kind: 'doc', fileId: parts[2] };
      if (parts[0] === 'spreadsheets' && parts[1] === 'd' && parts[2]) return { kind: 'sheet', fileId: parts[2] };
      if (parts[0] === 'presentation' && parts[1] === 'd' && parts[2]) return { kind: 'slides', fileId: parts[2] };
    }
    if (host === 'drive.google.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'file' && parts[1] === 'd' && parts[2]) return { kind: 'drive-file', fileId: parts[2] };
      const idParam = u.searchParams.get('id');
      if (idParam) return { kind: 'drive-file', fileId: idParam };
    }
  } catch {}
  return null;
}

async function fetchContentForUrl(url) {
  const parsed = parseGoogleUrl(url);
  if (!parsed) throw new Error('Not a recognized Google Docs/Drive URL');
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };

  if (parsed.kind === 'doc') {
    // Docs API returns structured JSON; export endpoint gives plain text.
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${parsed.fileId}/export?mimeType=text/plain`, { headers });
    if (!resp.ok) throw new Error(`Google Docs export failed: ${resp.status} ${await resp.text()}`);
    return { kind: 'doc', content: await resp.text() };
  }
  if (parsed.kind === 'sheet') {
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${parsed.fileId}/export?mimeType=text/csv`, { headers });
    if (!resp.ok) throw new Error(`Google Sheets export failed: ${resp.status} ${await resp.text()}`);
    return { kind: 'sheet', content: await resp.text() };
  }
  if (parsed.kind === 'slides') {
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${parsed.fileId}/export?mimeType=text/plain`, { headers });
    if (!resp.ok) throw new Error(`Google Slides export failed: ${resp.status} ${await resp.text()}`);
    return { kind: 'slides', content: await resp.text() };
  }
  if (parsed.kind === 'drive-file') {
    // First fetch metadata to pick an export vs direct download.
    const metaResp = await fetch(`https://www.googleapis.com/drive/v3/files/${parsed.fileId}?fields=id,name,mimeType`, { headers });
    if (!metaResp.ok) throw new Error(`Drive metadata failed: ${metaResp.status} ${await metaResp.text()}`);
    const meta = await metaResp.json();
    const mime = meta.mimeType || '';
    if (mime === 'application/vnd.google-apps.document') {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${parsed.fileId}/export?mimeType=text/plain`, { headers });
      return { kind: 'doc', content: await r.text(), name: meta.name };
    }
    if (mime === 'application/vnd.google-apps.spreadsheet') {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${parsed.fileId}/export?mimeType=text/csv`, { headers });
      return { kind: 'sheet', content: await r.text(), name: meta.name };
    }
    if (mime === 'application/vnd.google-apps.presentation') {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${parsed.fileId}/export?mimeType=text/plain`, { headers });
      return { kind: 'slides', content: await r.text(), name: meta.name };
    }
    if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${parsed.fileId}?alt=media`, { headers });
      return { kind: 'text', content: await r.text(), name: meta.name, mime };
    }
    // Binary file — store a metadata-only marker.
    return { kind: 'binary', content: `[${mime} · ${meta.name}]`, name: meta.name, mime };
  }
  throw new Error(`Unsupported Google URL kind: ${parsed.kind}`);
}

// Returns the current start page token for the Drive Changes API. Call once to
// initialize tracking — files created before this point will not be surfaced.
async function getDriveChangesStartToken() {
  const token = await getAccessToken();
  const resp = await fetch('https://www.googleapis.com/drive/v3/changes/startPageToken', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Drive startPageToken failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.startPageToken;
}

const DRIVE_DOC_MIME = 'application/vnd.google-apps.document';
const DRIVE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const BINARY_IMAGE_MIMES = new Set(['image/jpeg','image/png','image/gif','image/webp','image/tiff','image/tif','application/pdf']);

// Poll the Drive Changes API starting from pageToken. Paginates automatically.
// Returns { files: [{id, name, mimeType, webViewLink, parents}], newPageToken }.
async function pollDriveChanges(pageToken) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };
  const files = [];
  let cursor = pageToken;
  let newPageToken = null;

  while (true) {
    const params = new URLSearchParams({
      pageToken: cursor,
      spaces: 'drive',
      includeRemoved: 'false',
      fields: 'nextPageToken,newStartPageToken,changes(changeType,removed,file(id,name,mimeType,webViewLink,parents,trashed))',
    });
    const resp = await fetch(`https://www.googleapis.com/drive/v3/changes?${params}`, { headers });
    if (!resp.ok) throw new Error(`Drive changes poll failed: ${resp.status} ${await resp.text()}`);
    const data = await resp.json();

    for (const change of (data.changes || [])) {
      if (change.changeType !== 'file') continue;
      if (change.removed) continue;
      const f = change.file;
      if (!f || f.trashed) continue;
      files.push({ id: f.id, name: f.name, mimeType: f.mimeType, webViewLink: f.webViewLink, parents: f.parents || [] });
    }

    if (data.nextPageToken) {
      cursor = data.nextPageToken;
    } else {
      newPageToken = data.newStartPageToken || cursor;
      break;
    }
  }

  return { files, newPageToken };
}

// Download a Drive file's binary content to destPath by streaming.
async function downloadDriveFile(fileId, destPath) {
  const token = await getAccessToken();
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Drive download failed: ${resp.status}`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    const stream = resp.body;
    const { Writable } = require('stream');
    // resp.body is a Web Streams ReadableStream (Node 18+ fetch); pipe via getReader.
    const reader = stream.getReader();
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) { out.end(); return; }
        out.write(Buffer.from(value), pump);
      }).catch(reject);
    }
    out.on('finish', resolve);
    out.on('error', reject);
    pump();
  });
}

function isConfigured() {
  return !!loadClient();
}

function status() {
  const row = db.getGoogleTokens();
  return {
    configured: isConfigured(),
    connected: !!(row && row.refresh_token),
    scope: row ? row.scope : null,
    updated_at: row ? row.updated_at : null,
  };
}

module.exports = {
  buildAuthUrl,
  exchangeCode,
  getAccessToken,
  fetchContentForUrl,
  parseGoogleUrl,
  isConfigured,
  status,
  getDriveChangesStartToken,
  pollDriveChanges,
  downloadDriveFile,
  BINARY_IMAGE_MIMES,
};
