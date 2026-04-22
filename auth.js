const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const APP_DB_PATH = process.env.APP_DB_PATH || path.join(__dirname, 'data', 'app.db');
fs.mkdirSync(path.dirname(APP_DB_PATH), { recursive: true });

const appDb = new Database(APP_DB_PATH);
appDb.pragma('journal_mode = WAL');
appDb.pragma('foreign_keys = ON');

appDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    gemini_api_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(email COLLATE NOCASE);
`);

const BCRYPT_ROUNDS = 12;

function createUser(email, password) {
  const existing = appDb.prepare(`SELECT id FROM users WHERE email = ? COLLATE NOCASE`).get(email.trim());
  if (existing) throw Object.assign(new Error('Email already registered'), { code: 'EMAIL_TAKEN' });
  const id = crypto.randomUUID();
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  appDb.prepare(`INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)`).run(id, email.trim().toLowerCase(), hash);
  return getUserById(id);
}

function verifyUser(email, password) {
  const row = appDb.prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`).get(email.trim());
  if (!row) return null;
  if (!bcrypt.compareSync(password, row.password_hash)) return null;
  appDb.prepare(`UPDATE users SET last_seen_at = datetime('now') WHERE id = ?`).run(row.id);
  return getUserById(row.id);
}

function getUserById(id) {
  const row = appDb.prepare(`SELECT id, email, gemini_api_key, created_at, last_seen_at FROM users WHERE id = ?`).get(id);
  if (!row) return null;
  return { ...row, has_gemini_key: !!row.gemini_api_key };
}

function setGeminiKey(userId, apiKey) {
  appDb.prepare(`UPDATE users SET gemini_api_key = ? WHERE id = ?`).run(apiKey || null, userId);
}

function getGeminiKey(userId) {
  const row = appDb.prepare(`SELECT gemini_api_key FROM users WHERE id = ?`).get(userId);
  return row ? row.gemini_api_key : null;
}

module.exports = { createUser, verifyUser, getUserById, setGeminiKey, getGeminiKey };
