import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_SETTINGS } from './config.mjs'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS targets (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  title         TEXT,
  company       TEXT,
  region        TEXT    NOT NULL DEFAULT 'UK',
  linkedin_url  TEXT,
  email         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  last_scraped_at TEXT,
  notes         TEXT,
  -- Prospect lifecycle: watching -> targeting -> contacted -> engaged -> customer | excluded
  status        TEXT    NOT NULL DEFAULT 'watching',
  -- 0 = unranked. Higher ranks are worked first by the pipeline.
  priority      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);
-- Deliberately NOT a partial index: SQLite cannot use a partial unique index
-- as the conflict target of an upsert, which the watchlist import relies on.
-- SQLite treats NULLs as distinct in unique indexes, so unset URLs are fine.
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_url_uniq ON targets(linkedin_url);
CREATE INDEX IF NOT EXISTS idx_targets_region ON targets(region);

CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY,
  target_id     INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  external_id   TEXT,
  content_text  TEXT    NOT NULL,
  reactions     INTEGER NOT NULL DEFAULT 0,
  comments      INTEGER NOT NULL DEFAULT 0,
  shares        INTEGER NOT NULL DEFAULT 0,
  velocity      REAL    NOT NULL DEFAULT 0,
  posted_at     TEXT    NOT NULL,
  url           TEXT,
  topics        TEXT    NOT NULL DEFAULT '[]',
  urgency       TEXT,
  sentiment     TEXT,
  analyzed      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_external ON posts(target_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_posted ON posts(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_target ON posts(target_id);

CREATE TABLE IF NOT EXISTS topics (
  id          INTEGER PRIMARY KEY,
  slug        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  mentions    INTEGER NOT NULL DEFAULT 0,
  regions     TEXT    NOT NULL DEFAULT '{}',
  urgency     TEXT,
  sentiment   TEXT,
  trend       TEXT,
  tags        TEXT    NOT NULL DEFAULT '[]',
  post_ids    TEXT    NOT NULL DEFAULT '[]',
  first_seen  TEXT,
  last_seen   TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_topics_mentions ON topics(mentions DESC);

CREATE TABLE IF NOT EXISTS drafts (
  id           INTEGER PRIMARY KEY,
  post_id      INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  target_id    INTEGER REFERENCES targets(id) ON DELETE SET NULL,
  source       TEXT    NOT NULL DEFAULT 'inbound',
  topic_slug   TEXT,
  detected_pain_point TEXT,
  angle        TEXT,
  peer_comment TEXT,
  inbound_post TEXT,
  visual       TEXT,
  lint         TEXT,
  status       TEXT    NOT NULL DEFAULT 'drafted',
  generator    TEXT,
  feedback     TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_post ON drafts(post_id);

CREATE TABLE IF NOT EXISTS schedules (
  id            INTEGER PRIMARY KEY,
  draft_id      INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  channel       TEXT    NOT NULL DEFAULT 'linkedin_company',
  scheduled_at  TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  published_url TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(status, scheduled_at);

CREATE TABLE IF NOT EXISTS engagements (
  id            INTEGER PRIMARY KEY,
  target_id     INTEGER REFERENCES targets(id) ON DELETE CASCADE,
  type          TEXT    NOT NULL,
  our_post_url  TEXT,
  target_post_url TEXT,
  warm          INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  detected_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engagements_at ON engagements(detected_at DESC);

CREATE TABLE IF NOT EXISTS website_updates (
  id           INTEGER PRIMARY KEY,
  topic_slug   TEXT,
  kind         TEXT    NOT NULL DEFAULT 'insight',
  title        TEXT    NOT NULL,
  summary      TEXT,
  slug         TEXT    NOT NULL,
  target_path  TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'planned',
  result       TEXT,
  applied_at   TEXT,
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_website_status ON website_updates(status);

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  kind         TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  started_at   TEXT    NOT NULL,
  finished_at  TEXT,
  duration_ms  INTEGER,
  stats        TEXT    NOT NULL DEFAULT '{}',
  log          TEXT    NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

CREATE TABLE IF NOT EXISTS campaigns (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  focus       TEXT,
  region      TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  notes       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Which target companies a campaign is working.
CREATE TABLE IF NOT EXISTS campaign_targets (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  target_id   INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (campaign_id, target_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_target ON campaign_targets(target_id);

-- OAuth tokens obtained via the Connect screen. Kept out of the settings
-- table so they are never returned by GET /api/settings.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider      TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  scope         TEXT,
  token_type    TEXT,
  expires_at    TEXT,
  author_urn    TEXT,
  obtained_at   TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- API keys entered through the UI. Values are never returned by the API.
CREATE TABLE IF NOT EXISTS secrets (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  username      TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Sessions are stored server-side so sign-out revokes for real. Only the
-- SHA-256 of the cookie token is persisted, never the token itself.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  username     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  // Additive migrations for databases created by an earlier version.
  ensureColumn(db, 'targets', 'status', "TEXT NOT NULL DEFAULT 'watching'")
  ensureColumn(db, 'targets', 'priority', 'INTEGER NOT NULL DEFAULT 0')
  // Migration: an early build shipped `idx_targets_url` as a partial index,
  // which broke the upsert used by watchlist import. Drop it if it is present.
  db.exec('DROP INDEX IF EXISTS idx_targets_url')
  return db
}

/** Adds a column if it is missing. SQLite has no `ADD COLUMN IF NOT EXISTS`. */
export function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (cols.some((c) => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}

export const nowIso = () => new Date().toISOString()

/** Parse a JSON column, falling back rather than throwing on corrupt data. */
export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const out = JSON.parse(value)
    return out === null || out === undefined ? fallback : out
  } catch {
    return fallback
  }
}

/**
 * Thin convenience layer over node:sqlite. `all`/`get` return plain objects;
 * `run` returns { changes, lastInsertRowid }.
 */
export function q(db) {
  return {
    all: (sql, ...params) => db.prepare(sql).all(...params),
    get: (sql, ...params) => db.prepare(sql).get(...params) ?? null,
    run: (sql, ...params) => db.prepare(sql).run(...params),
    exec: (sql) => db.exec(sql),
    tx(fn) {
      db.exec('BEGIN')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (err) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* already rolled back */
        }
        throw err
      }
    },
  }
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  const stored = {}
  for (const r of rows) stored[r.key] = parseJson(r.value, r.value)
  // Region list and arrays survive round-trips because we always write JSON.
  return { ...DEFAULT_SETTINGS, ...stored }
}

export function setSettings(db, patch) {
  const stmt = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (!(key in DEFAULT_SETTINGS)) continue // ignore unknown keys
    stmt.run(key, JSON.stringify(value))
  }
  return getSettings(db)
}
