'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/vault.db';
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency & performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  -- ── Users ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password    TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_login  TEXT
  );

  -- ── Document Types ─────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS document_types (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color      TEXT NOT NULL DEFAULT '#6366f1',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- ── Tags ──────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS tags (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color      TEXT NOT NULL DEFAULT '#22c55e',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- ── Correspondents (people / organisations who send or receive docs) ──
  CREATE TABLE IF NOT EXISTS correspondents (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email      TEXT,
    notes      TEXT,
    color      TEXT NOT NULL DEFAULT '#f59e0b',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- ── Documents ─────────────────────────────────────────────────────────
  -- Files stored as BLOBs inside the database (no raw files on disk)
  CREATE TABLE IF NOT EXISTS documents (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    filename          TEXT NOT NULL,
    mime_type         TEXT NOT NULL,
    file_size         INTEGER NOT NULL,
    content           BLOB NOT NULL,
    text_content      TEXT,
    notes             TEXT,
    type_id           TEXT REFERENCES document_types(id) ON DELETE SET NULL,
    correspondent_id  TEXT REFERENCES correspondents(id) ON DELETE SET NULL,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    source            TEXT NOT NULL DEFAULT 'upload' CHECK(source IN ('upload','watch','api'))
  );

  -- ── Document ↔ Tags (many-to-many) ───────────────────────────────────
  CREATE TABLE IF NOT EXISTS document_tags (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
  );

  -- ── Settings ──────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- ── Audit Log ─────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    target_id  TEXT,
    details    TEXT,
    ip         TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- ── FTS virtual table for full-text search ───────────────────────────
  CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    title, text_content, notes,
    content='documents',
    content_rowid='rowid'
  );

  -- Keep FTS in sync
  CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, text_content, notes)
    VALUES (new.rowid, new.title, new.text_content, new.notes);
  END;
  CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, text_content, notes)
    VALUES ('delete', old.rowid, old.title, old.text_content, old.notes);
  END;
  CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, text_content, notes)
    VALUES ('delete', old.rowid, old.title, old.text_content, old.notes);
    INSERT INTO documents_fts(rowid, title, text_content, notes)
    VALUES (new.rowid, new.title, new.text_content, new.notes);
  END;
`);

// Seed default settings if table is empty
const seedSettings = db.prepare(
  `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
);
const seedMany = db.transaction((pairs) => {
  for (const [k, v] of pairs) seedSettings.run(k, v);
});
seedMany([
  ['ai_enabled',              'true'],
  ['ai_model',                process.env.OPENAI_MODEL || 'gpt-5-mini'],
  ['ai_auto_tag',             'true'],
  ['ai_auto_type',            'true'],
  ['ai_auto_summary',         'true'],
  ['ai_auto_correspondent',   'true'],
  ['ai_auto_create',          'true'],
  ['watch_folder',            process.env.WATCH_FOLDER || './inbox'],
  ['watch_enabled',           'false'],
  ['max_file_mb',             '50'],
  ['allowed_types',           'application/pdf,image/jpeg,image/png,image/webp,image/gif,text/plain'],
  ['app_name',                'DocumentNeo'],
  ['registration_open',       'true'],
  ['mcp_enabled',             'false'],
]);

// ── Live migrations (idempotent) ────────────────────────────────────────────
try {
  db.exec(`ALTER TABLE documents ADD COLUMN correspondent_id TEXT REFERENCES correspondents(id) ON DELETE SET NULL`);
} catch (_) {}

// Per-user AI preference columns (added after initial launch)
for (const col of [
  `ALTER TABLE users ADD COLUMN pref_ai_auto_tag          TEXT NOT NULL DEFAULT 'true'`,
  `ALTER TABLE users ADD COLUMN pref_ai_auto_type         TEXT NOT NULL DEFAULT 'true'`,
  `ALTER TABLE users ADD COLUMN pref_ai_auto_summary      TEXT NOT NULL DEFAULT 'true'`,
  `ALTER TABLE users ADD COLUMN pref_ai_auto_correspondent TEXT NOT NULL DEFAULT 'true'`,
  `ALTER TABLE users ADD COLUMN pref_ai_auto_create       TEXT NOT NULL DEFAULT 'true'`,
  `ALTER TABLE users ADD COLUMN pref_ai_auto_title        TEXT NOT NULL DEFAULT 'true'`,
  `ALTER TABLE users ADD COLUMN totp_secret               TEXT`,
  `ALTER TABLE users ADD COLUMN totp_enabled              INTEGER NOT NULL DEFAULT 0`,
]) {
  try { db.exec(col); } catch (_) {}
}
try { db.exec(`ALTER TABLE users ADD COLUMN pref_ai_custom_instructions TEXT NOT NULL DEFAULT ''`); } catch (_) {}

// Per-user SMTP settings for signing notifications / reminders
for (const col of [
  `ALTER TABLE users ADD COLUMN smtp_host     TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN smtp_port     INTEGER NOT NULL DEFAULT 587`,
  `ALTER TABLE users ADD COLUMN smtp_user     TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN smtp_pass     TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN smtp_from     TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN smtp_secure   TEXT NOT NULL DEFAULT 'tls'`,
  `ALTER TABLE users ADD COLUMN smtp_enabled  TEXT NOT NULL DEFAULT 'false'`,
]) {
  try { db.exec(col); } catch (_) {}
}

// Per-envelope signing options (added after initial launch)
for (const col of [
  `ALTER TABLE sign_envelopes ADD COLUMN from_email    TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE sign_envelopes ADD COLUMN send_copy     INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE sign_envelopes ADD COLUMN email_subject TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE sign_envelopes ADD COLUMN doc_hash      TEXT`,
]) {
  try { db.exec(col); } catch (_) {}
}

// Per-entity user_id columns for full data isolation
for (const col of [
  `ALTER TABLE tags             ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE`,
  `ALTER TABLE document_types  ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE`,
  `ALTER TABLE correspondents   ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE`,
]) {
  try { db.exec(col); } catch (_) {}
}

// ── Migrate UNIQUE(name) → UNIQUE(name, user_id) for per-user isolation ─────
// Needed so two users can have identically named tags/types/correspondents.
;(function migratePerUserUnique() {
  const tableSchema = (n) => (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(n) || {}).sql || '';
  const hasPerUserUnique = (n) => /UNIQUE\s*\(\s*["'`]?name["'`]?\s*,\s*["'`]?user_id["'`]?\s*\)/i.test(tableSchema(n));

  const tables = [
    {
      name: 'tags',
      tmp:  'tags_mig',
      def:  `CREATE TABLE tags_mig (
               id         TEXT PRIMARY KEY,
               name       TEXT NOT NULL COLLATE NOCASE,
               color      TEXT NOT NULL DEFAULT '#22c55e',
               user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
               UNIQUE(name, user_id))`,
      cols: 'id, name, color, user_id, created_at',
    },
    {
      name: 'document_types',
      tmp:  'document_types_mig',
      def:  `CREATE TABLE document_types_mig (
               id         TEXT PRIMARY KEY,
               name       TEXT NOT NULL COLLATE NOCASE,
               color      TEXT NOT NULL DEFAULT '#6366f1',
               user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
               UNIQUE(name, user_id))`,
      cols: 'id, name, color, user_id, created_at',
    },
    {
      name: 'correspondents',
      tmp:  'correspondents_mig',
      def:  `CREATE TABLE correspondents_mig (
               id         TEXT PRIMARY KEY,
               name       TEXT NOT NULL COLLATE NOCASE,
               email      TEXT,
               notes      TEXT,
               color      TEXT NOT NULL DEFAULT '#f59e0b',
               user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
               updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
               UNIQUE(name, user_id))`,
      cols: 'id, name, email, notes, color, user_id, created_at, updated_at',
    },
  ];

  for (const t of tables) {
    if (hasPerUserUnique(t.name)) continue;
    try {
      db.pragma('foreign_keys = OFF');
      db.exec(`DROP TABLE IF EXISTS ${t.tmp}`);
      db.exec(t.def);
      db.exec(`INSERT OR IGNORE INTO ${t.tmp} (${t.cols}) SELECT ${t.cols} FROM ${t.name}`);
      db.exec(`DROP TABLE ${t.name}`);
      db.exec(`ALTER TABLE ${t.tmp} RENAME TO ${t.name}`);
      db.pragma('foreign_keys = ON');
      console.log(`[DB] Migrated ${t.name} to per-user unique constraint.`);
    } catch (e) {
      db.pragma('foreign_keys = ON');
      console.warn(`[DB] Migration ${t.name} unique constraint:`, e.message);
    }
  }
}());
// ── MCP tables (idempotent) ─────────────────────────────────────────────────
db.exec(`
  -- API keys users create for MCP access
  CREATE TABLE IF NOT EXISTS mcp_api_keys (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    key_hash    TEXT NOT NULL UNIQUE,   -- SHA-256 of the raw key
    key_prefix  TEXT NOT NULL,          -- first 12 chars, shown in UI
    scope       TEXT NOT NULL DEFAULT 'read' CHECK(scope IN ('read','write','readwrite')),
    last_used   TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- OAuth 2.0 registered clients (AI tools register themselves)
  CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
    client_id     TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_name   TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,       -- JSON array of allowed redirect URIs
    scope         TEXT NOT NULL DEFAULT 'read',
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- Short-lived authorization codes (PKCE)
  CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
    code              TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id         TEXT NOT NULL,
    scope             TEXT NOT NULL,
    redirect_uri      TEXT NOT NULL,
    code_challenge    TEXT NOT NULL,   -- PKCE S256 challenge
    expires_at        TEXT NOT NULL,
    used              INTEGER NOT NULL DEFAULT 0
  );

  -- OAuth access tokens issued after successful auth
  CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id   TEXT NOT NULL,
    scope       TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,  -- SHA-256 of the raw token
    expires_at  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

// ── Document Signing tables (idempotent) ────────────────────────────────────
db.exec(`
  -- Envelopes: a signing request for one document
  CREATE TABLE IF NOT EXISTS sign_envelopes (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id     TEXT REFERENCES documents(id) ON DELETE SET NULL,
    title           TEXT NOT NULL,
    message         TEXT,
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK(status IN ('draft','out_for_signature','completed','voided')),
    signed_document BLOB,           -- completed signed PDF stored here
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at    TEXT
  );

  -- Signers on an envelope
  CREATE TABLE IF NOT EXISTS sign_signers (
    id          TEXT PRIMARY KEY,
    envelope_id TEXT NOT NULL REFERENCES sign_envelopes(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    order_idx   INTEGER NOT NULL DEFAULT 0,
    token       TEXT NOT NULL UNIQUE,   -- secure signing token (URL key)
    color       TEXT NOT NULL DEFAULT '#6366f1',
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','viewed','signed')),
    signed_at   TEXT,
    ip          TEXT,
    user_agent  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- Fields placed on a page of the document
  CREATE TABLE IF NOT EXISTS sign_fields (
    id          TEXT PRIMARY KEY,
    envelope_id TEXT NOT NULL REFERENCES sign_envelopes(id) ON DELETE CASCADE,
    signer_id   TEXT NOT NULL REFERENCES sign_signers(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK(type IN ('signature','initials','text','date','checkbox')),
    page        INTEGER NOT NULL DEFAULT 1,   -- 1-indexed page number
    x           REAL NOT NULL,               -- % of page width  (0-100)
    y           REAL NOT NULL,               -- % of page height (0-100)
    w           REAL NOT NULL DEFAULT 18,    -- % of page width
    h           REAL NOT NULL DEFAULT 5,     -- % of page height
    label       TEXT,
    required    INTEGER NOT NULL DEFAULT 1,
    value       TEXT,                        -- JSON after signing
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- Audit log for signing events
  CREATE TABLE IF NOT EXISTS sign_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    envelope_id TEXT NOT NULL,
    signer_id   TEXT,
    action      TEXT NOT NULL,   -- 'created','sent','viewed','signed','voided','downloaded'
    ip          TEXT,
    user_agent  TEXT,
    details     TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

module.exports = db;