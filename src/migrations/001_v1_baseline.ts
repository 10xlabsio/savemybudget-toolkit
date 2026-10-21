// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './index.js';

/**
 * The schema as shipped in 1.x. Every statement is idempotent, so it brings a fresh file to the 1.x shape and
 * leaves an existing 1.x file as it was.
 */
export const baseline: Migration = {
  id: 1,
  name: 'v1_baseline',
  up(d: DatabaseSync) {
    d.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    consent_mode TEXT NOT NULL DEFAULT 'legitimate_interest',
    target_countries TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    first_event_at TEXT,
    last_seen_at TEXT
  );
  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    format TEXT NOT NULL,
    rows_total INTEGER NOT NULL,
    rows_imported INTEGER NOT NULL,
    dropped TEXT NOT NULL DEFAULT '{}',
    range_from TEXT, range_to TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    upload_id INTEGER REFERENCES uploads(id) ON DELETE CASCADE,
    received_at TEXT NOT NULL,
    ts TEXT NOT NULL,
    ip TEXT NOT NULL,
    ip_private INTEGER NOT NULL DEFAULT 0,
    asn INTEGER, asn_name TEXT,
    is_hosting INTEGER NOT NULL DEFAULT 0,
    country TEXT,
    ua TEXT, ua_family TEXT,
    gclid TEXT NOT NULL,
    is_test INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    fp_hash TEXT,
    dwell_ms INTEGER, visible INTEGER, interactions INTEGER,
    automation TEXT,
    url TEXT, referer TEXT, campaign TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_events_site_ts ON events(site_id, ts);
  CREATE INDEX IF NOT EXISTS ix_events_site_gclid ON events(site_id, gclid);
  CREATE INDEX IF NOT EXISTS ix_events_site_ip ON events(site_id, ip, ts);
  CREATE INDEX IF NOT EXISTS ix_events_session ON events(site_id, session_id);
  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    range_from TEXT NOT NULL, range_to TEXT NOT NULL,
    ran_at TEXT NOT NULL,
    summary TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS verdicts (
    analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    score INTEGER NOT NULL,
    hits TEXT NOT NULL,
    PRIMARY KEY (analysis_id, event_id)
  );
  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    rows INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    dismissed_at TEXT,
    UNIQUE (site_id, kind, dedupe_key)
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    instance_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    first_boot_at TEXT NOT NULL,
    last_heartbeat_at TEXT,
    first_beacon_reported INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
  -- OAuth sign-in for AI assistants (src/mcp/oauth.tsx). Only SHA-256 hashes of codes, tokens and secrets.
  CREATE TABLE IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY,
    secret_hash TEXT,
    auth_method TEXT NOT NULL DEFAULT 'none',
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource TEXT,
    token_fp TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    family TEXT
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    family TEXT NOT NULL,
    token_fp TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_oauth_tokens_family ON oauth_tokens(family);
  `);
    // Columns added after a table first shipped: CREATE TABLE IF NOT EXISTS leaves an existing table as it was.
    addColumnIfMissing(d, 'oauth_codes', 'family', 'TEXT');
  },
};

function addColumnIfMissing(d: DatabaseSync, table: string, column: string, type: string) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
