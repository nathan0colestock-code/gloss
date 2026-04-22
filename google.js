// Google OAuth 2.0 (Installed-app / Desktop) + Docs/Drive content fetcher.
//
// Flow:
//   1. User clicks "Connect Google" → /api/google/connect → 302 to Google consent
//   2. Google redirects to /api/google/oauth-callback?code=…
//   3. Server exchanges the code for tokens and stores refresh_token in per-user SQLite.
//   4. fetchContentForUrl(url) resolves a Docs/Drive URL to plain text, using the
//      refresh_token to mint short-lived access_tokens as needed.
//
// Credentials: set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET env vars (preferred),
// or set GOOGLE_OAUTH_CLIENT_JSON to the path of the downloaded client JSON file.

const fs = require('fs');
const path = require('path');
const _requestContext = require('./context');

function _db() {
  const s = _requestContext.getStore();
  return s ? s.db : require('./db');
}

function loadClient() {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: process.env.GOOGLE_TOKEN_URI || 'https://oauth2.googleapis.com/token',
    };
  }
  const p = process.env.GOOGLE_OAUTH_CLIENT_JSON;
  if (!p || !fs.existsSync(p)) return null;
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
  const proto = (req && req.protocol) || 'http';
  const host = (req && req.get && req.get('host')) || `localhost:${process.env.PORT || 3747}`;
  return `${proto}://${host}/api/google/oauth-callback`;
}

function buildAuthUrl(req) {
  const client = loadClient();
  if (!client) throw new Error('Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.');
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: getRedirectUri(req),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${client.auth_uri}?${params.toString()}`;
}

async function exchangeCode(code, req) {
  const client = loadClient();
  if (!client) throw new Error('Google OAuth not configured');
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
  _db().saveGoogleTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at,
    scope: data.scope,
  });
  return _db().getGoogleTokens();
}

async function getAccessToken() {
  const row = _db().getGoogleTokens();
  if (!row || !row.refresh_token) throw new Error('Google not connected — visit /api/google/connect first');
  if (row.access_token && row.expires_at && new Date(row.expires_at) > new Date()) {
    return row.access_token;
  }
  const client = loadClient();
  if (!client) throw new Error('Google OAuth not configured');
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
  _db().saveGoogleTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token || row.refresh_token,
    expires_at,
    scope: data.scope || row.scope,
  });
  return data.access_token;
}

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
    return { kind: 'binary', content: `[${mime} · ${meta.name}]`, name: meta.name, mime };
  }
  throw new Error(`Unsupported Google URL kind: ${parsed.kind}`);
}

function isConfigured() {
  return !!loadClient();
}

function status() {
  const row = _db().getGoogleTokens();
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
};
