// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { ClickEvent, Site, Source } from './types.js';

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(join(config.dataDir, 'uploads'), { recursive: true });
  mkdirSync(join(config.dataDir, 'packages'), { recursive: true });
  _db = new DatabaseSync(join(config.dataDir, 'toolkit.db'));
  _db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(_db);
  return _db;
}

/** For tests: open an in-memory database. */
export function openMemoryDb(): DatabaseSync {
  _db = new DatabaseSync(':memory:');
  _db.exec('PRAGMA foreign_keys = ON;');
  migrate(_db);
  return _db;
}

function migrate(d: DatabaseSync) {
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
  `);
}

// ---------- helpers ----------

export const now = () => new Date().toISOString();

// ---------- data generation (lets callers cache analyses) ----------

let generation = 0;
/**
 * A counter bumped on every bulk change to what an analysis reads: imports, deletions, site edits (targeting
 * changes rule 3). Single beacons don't bump it — they arrive constantly on a live site, so caches keyed on it
 * also carry a short TTL.
 */
export function dataGeneration(): number { return generation; }
export function bumpDataGeneration(): void { generation++; }

export function getSetting(key: string): string | null {
  const r = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? r.value : null;
}
export function setSetting(key: string, value: string) {
  db().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
export function bumpCounter(key: string, by = 1) {
  db().prepare('INSERT INTO counters(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value').run(key, by);
}
export function getCounter(key: string): number {
  const r = db().prepare('SELECT value FROM counters WHERE key = ?').get(key) as { value: number } | undefined;
  return r ? r.value : 0;
}

function rowToSite(r: any): Site {
  return { ...r, target_countries: JSON.parse(r.target_countries || '[]') };
}
export function listSites(): Site[] {
  return (db().prepare('SELECT * FROM sites ORDER BY name').all() as any[]).map(rowToSite);
}
export function getSite(id: number): Site | null {
  const r = db().prepare('SELECT * FROM sites WHERE id = ?').get(id);
  return r ? rowToSite(r) : null;
}
export function getSiteByKey(key: string): Site | null {
  const r = db().prepare('SELECT * FROM sites WHERE key = ?').get(key);
  return r ? rowToSite(r) : null;
}
export function createSite(s: { name: string; host: string; key: string; consent_mode: string; target_countries: string[] }): Site {
  const r = db()
    .prepare('INSERT INTO sites(name,host,key,consent_mode,target_countries,created_at) VALUES(?,?,?,?,?,?) RETURNING *')
    .get(s.name, s.host, s.key, s.consent_mode, JSON.stringify(s.target_countries), now());
  return rowToSite(r);
}
export function updateSite(id: number, s: { name: string; host: string; consent_mode: string; target_countries: string[] }) {
  db().prepare('UPDATE sites SET name=?, host=?, consent_mode=?, target_countries=? WHERE id=?')
    .run(s.name, s.host, s.consent_mode, JSON.stringify(s.target_countries), id);
  bumpDataGeneration();
}
export function deleteSiteData(id: number) {
  db().prepare('DELETE FROM events WHERE site_id = ?').run(id);
  db().prepare('DELETE FROM uploads WHERE site_id = ?').run(id);
  db().prepare('DELETE FROM analyses WHERE site_id = ?').run(id);
  db().prepare('UPDATE sites SET first_event_at = NULL, last_seen_at = NULL WHERE id = ?').run(id);
  bumpDataGeneration();
}
export function deleteSite(id: number) {
  db().prepare('DELETE FROM sites WHERE id = ?').run(id);
  bumpDataGeneration();
}

export type NewEvent = Omit<ClickEvent, 'id'>;

const insertEventStmt = () =>
  db().prepare(`INSERT INTO events(site_id,source,upload_id,received_at,ts,ip,ip_private,asn,asn_name,is_hosting,country,ua,ua_family,gclid,is_test,session_id,fp_hash,dwell_ms,visible,interactions,automation,url,referer,campaign)
    VALUES(@site_id,@source,@upload_id,@received_at,@ts,@ip,@ip_private,@asn,@asn_name,@is_hosting,@country,@ua,@ua_family,@gclid,@is_test,@session_id,@fp_hash,@dwell_ms,@visible,@interactions,@automation,@url,@referer,@campaign)`);

export function insertEvent(e: NewEvent): number {
  const r = insertEventStmt().run({ ...e, automation: e.automation ? JSON.stringify(e.automation) : null } as any);
  touchSite(e.site_id, e.received_at);
  return Number(r.lastInsertRowid);
}

export function insertEvents(events: NewEvent[]): number {
  const d = db();
  const stmt = insertEventStmt();
  d.exec('BEGIN');
  try {
    for (const e of events) stmt.run({ ...e, automation: e.automation ? JSON.stringify(e.automation) : null } as any);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  bumpDataGeneration();
  return events.length;
}

/** Beacon-only: sets first_event_at / last_seen_at. Imports don't count as the tag being live. */
export function touchSite(siteId: number, at: string) {
  db().prepare('UPDATE sites SET last_seen_at = ?, first_event_at = COALESCE(first_event_at, ?) WHERE id = ?').run(at, at, siteId);
}

function rowToEvent(r: any): ClickEvent {
  return { ...r, automation: r.automation ? JSON.parse(r.automation) : null };
}

/** Events for a site within [from, to] inclusive days (YYYY-MM-DD, UTC), excluding test gclids. */
export function eventsInWindow(siteId: number, from: string, to: string, sources?: Source[]): ClickEvent[] {
  const params: any[] = [siteId, `${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`];
  let sql = 'SELECT * FROM events WHERE site_id = ? AND ts >= ? AND ts <= ? AND is_test = 0';
  if (sources && sources.length) {
    sql += ` AND source IN (${sources.map(() => '?').join(',')})`;
    params.push(...sources);
  }
  sql += ' ORDER BY ts';
  return (db().prepare(sql).all(...params) as any[]).map(rowToEvent);
}

/** Every non-test event on a site carrying this stored click id (gclid, or `gbraid:…` / `wbraid:…`). Uses ix_events_site_gclid. */
export function eventsByClickId(siteId: number, stored: string): ClickEvent[] {
  return (db().prepare('SELECT * FROM events WHERE site_id = ? AND gclid = ? AND is_test = 0 ORDER BY ts').all(siteId, stored) as any[]).map(rowToEvent);
}

/** Non-test events on a site from one IP between two ISO instants, inclusive. Uses ix_events_site_ip. */
export function eventsByIp(siteId: number, ip: string, fromIso: string, toIso: string): ClickEvent[] {
  return (db().prepare('SELECT * FROM events WHERE site_id = ? AND ip = ? AND ts >= ? AND ts <= ? AND is_test = 0 ORDER BY ts').all(siteId, ip, fromIso, toIso) as any[]).map(rowToEvent);
}

export function eventById(id: number): ClickEvent | null {
  const r = db().prepare('SELECT * FROM events WHERE id = ?').get(id);
  return r ? rowToEvent(r) : null;
}

/** Update a beacon session's unload data. */
export function updateSessionUnload(siteId: number, sessionId: string, u: { dwell_ms: number; visible: 0 | 1; interactions: number }) {
  db().prepare('UPDATE events SET dwell_ms=?, visible=?, interactions=? WHERE site_id=? AND session_id=? AND source=\'beacon\'')
    .run(u.dwell_ms, u.visible, u.interactions, siteId, sessionId);
}

export function siteStatus(siteId: number) {
  const s = getSite(siteId);
  const cutoff = new Date(Date.now() - 24 * 3600e3).toISOString();
  const r = db().prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND source = 'beacon' AND received_at >= ?").get(siteId, cutoff) as { n: number };
  const lastTest = db().prepare("SELECT received_at FROM events WHERE site_id = ? AND is_test = 1 ORDER BY received_at DESC LIMIT 1").get(siteId) as { received_at: string } | undefined;
  return {
    status: siteHealth(s),
    last_seen_at: s?.last_seen_at ?? null,
    first_event_at: s?.first_event_at ?? null,
    beacons_24h: r.n,
    last_test_at: lastTest?.received_at ?? null,
  };
}

export type Health = 'green' | 'amber' | 'grey';
export function siteHealth(s: Site | null, thresholdHours = 48): Health {
  if (!s || !s.first_event_at || !s.last_seen_at) return 'grey';
  const ageH = (Date.now() - Date.parse(s.last_seen_at)) / 3600e3;
  return ageH <= thresholdHours ? 'green' : 'amber';
}
