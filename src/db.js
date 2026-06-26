import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.tokenDbPath), { recursive: true });

const db = new Database(config.tokenDbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS accelo_tokens (
  subject TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  client_secret TEXT,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_state (
  state TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_redirect_uri TEXT NOT NULL,
  client_state TEXT,
  code_challenge TEXT,
  code_challenge_method TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  subject TEXT NOT NULL,
  code_challenge TEXT,
  code_challenge_method TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_tokens (
  token TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  client_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  client_id TEXT NOT NULL,
  expires_at INTEGER
);
`);

// ---- Idempotent migrations for existing databases ----
// CREATE TABLE IF NOT EXISTS will not alter a table that already exists, so add
// the refresh-token expiry column in place when an older DB is opened.
// Note: PRAGMA is called with a literal table name (no string interpolation) to
// avoid any SQL-injection pattern in this security-sensitive path (Gate 2 LOW).
function refreshTokensHasExpiresAt() {
  const cols = db.prepare('PRAGMA table_info(refresh_tokens)').all();
  return cols.some((c) => c.name === 'expires_at');
}

if (!refreshTokensHasExpiresAt()) {
  db.exec('ALTER TABLE refresh_tokens ADD COLUMN expires_at INTEGER');
}

export default db;
