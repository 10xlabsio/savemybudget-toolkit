// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './index.js';

/**
 * Tables for the 2.x line, created empty. Nothing from 1.x is touched, so a 1.x build still runs on the file.
 * Instants are integer milliseconds since the epoch; calendar days are YYYY-MM-DD text. Ids are integers;
 * credentials are stored sealed (BLOB), never as text.
 *
 * Not here on purpose: the new shapes of `sites`, `events` and `verdicts`. Those replace 1.x tables of the same
 * name, so they arrive in a later migration together with the conversion of the existing rows.
 */
export const v2Tables: Migration = {
  id: 2,
  name: 'v2_tables',
  backupFirst: true,
  up(d: DatabaseSync) {
    d.exec(`
    -- Scoring
    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      session_id TEXT,
      gclid TEXT,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      events INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS ix_visits_site_gclid ON visits(site_id, gclid);
    CREATE TABLE IF NOT EXISTS device_days (
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      fp TEXT NOT NULL,
      ips INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (site_id, day, fp)
    );
    CREATE TABLE IF NOT EXISTS rescore_backlog (
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      gclid TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT 'upgrade',
      PRIMARY KEY (site_id, gclid)
    );
    CREATE TABLE IF NOT EXISTS scorer_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      rule_version TEXT,
      candidates INTEGER NOT NULL DEFAULT 0,
      scored INTEGER NOT NULL DEFAULT 0,
      backlog_left INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    -- Google Ads connection. One sealed token per grant, shared by its links.
    CREATE TABLE IF NOT EXISTS ads_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_sealed BLOB NOT NULL,
      google_user_email TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ads_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      login_customer_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      grant_id INTEGER REFERENCES ads_grants(id),
      google_user_email TEXT,
      currency TEXT,
      time_zone TEXT,
      descriptive_name TEXT,
      auto_tagging INTEGER,
      click_tracking_status TEXT,
      live_since INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (site_id, customer_id)
    );
    CREATE TABLE IF NOT EXISTS ads_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL REFERENCES ads_links(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      range_from TEXT, range_to TEXT,
      rows INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS ads_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      gclid TEXT NOT NULL,
      click_date TEXT NOT NULL,
      campaign_id TEXT,
      cost_micros INTEGER,
      currency TEXT,
      raw TEXT NOT NULL DEFAULT '{}',
      UNIQUE (site_id, customer_id, gclid)
    );
    CREATE TABLE IF NOT EXISTS campaign_daily (
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      day TEXT NOT NULL,
      clicks INTEGER, cost_micros INTEGER, currency TEXT,
      PRIMARY KEY (site_id, customer_id, campaign_id, day)
    );
    CREATE TABLE IF NOT EXISTS invalid_click_snapshots (
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      day TEXT NOT NULL,
      invalid_clicks INTEGER, invalid_click_rate REAL,
      captured_at INTEGER NOT NULL,
      PRIMARY KEY (site_id, customer_id, day, captured_at)
    );
    CREATE TABLE IF NOT EXISTS campaign_geo_target_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      captured_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS campaign_geo_targets (
      set_id INTEGER NOT NULL REFERENCES campaign_geo_target_sets(id) ON DELETE CASCADE,
      place_id TEXT NOT NULL,
      negative INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (set_id, place_id, negative)
    );
    CREATE TABLE IF NOT EXISTS geo_places (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      country TEXT,
      kind TEXT
    );
    CREATE TABLE IF NOT EXISTS ads_link_campaigns (
      link_id INTEGER NOT NULL REFERENCES ads_links(id) ON DELETE CASCADE,
      campaign_id TEXT NOT NULL,
      name TEXT,
      status TEXT,
      PRIMARY KEY (link_id, campaign_id)
    );
    CREATE TABLE IF NOT EXISTS tracking_health_days (
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      day TEXT NOT NULL,
      clicks INTEGER, matched INTEGER,
      PRIMARY KEY (site_id, customer_id, day)
    );

    -- IP exclusions
    CREATE TABLE IF NOT EXISTS ip_exclusion_prefs (
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'off',
      settings TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (site_id, customer_id)
    );
    CREATE TABLE IF NOT EXISTS ip_exclusions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      criterion_resource TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      placed_by_toolkit INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (site_id, customer_id, campaign_id, ip)
    );
    CREATE TABLE IF NOT EXISTS ip_exclusion_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      added INTEGER NOT NULL DEFAULT 0,
      removed INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS blocklist_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      entries INTEGER NOT NULL DEFAULT 0,
      format TEXT NOT NULL
    );

    -- Claims
    CREATE TABLE IF NOT EXISTS claim_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      customer_id TEXT,
      window_from TEXT NOT NULL,
      window_to TEXT NOT NULL,
      gclids TEXT NOT NULL DEFAULT '[]',
      rule_version TEXT,
      exported_at INTEGER,
      filed_at INTEGER,
      already_submitted INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      credited_clicks INTEGER,
      credit_micros INTEGER,
      currency TEXT,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS claimed_gclids (
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      gclid TEXT NOT NULL,
      package_id INTEGER NOT NULL REFERENCES claim_packages(id) ON DELETE CASCADE,
      PRIMARY KEY (site_id, customer_id, gclid)
    );
    CREATE TABLE IF NOT EXISTS labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('ip', 'click')),
      target TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (site_id, kind, target)
    );

    -- Owner, mail and audit
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      action TEXT NOT NULL,
      site_id INTEGER,
      counts TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TABLE IF NOT EXISTS email_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS owner_sessions (
      id_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      epoch INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS owner (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sub TEXT NOT NULL,
      email TEXT,
      pinned_at INTEGER NOT NULL
    );
    `);
  },
};
