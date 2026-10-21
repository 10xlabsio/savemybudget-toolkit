// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runMigrations, fixDataDirModes, InsufficientDiskSpace, MIGRATIONS } = await import('../src/migrations/index.js');
const { baseline } = await import('../src/migrations/001_v1_baseline.js');

const V2_TABLES = [
  'visits', 'device_days', 'rescore_backlog', 'scorer_runs', 'ads_grants', 'ads_links', 'ads_sync_runs', 'ads_clicks',
  'campaign_daily', 'invalid_click_snapshots', 'campaign_geo_target_sets', 'campaign_geo_targets', 'geo_places',
  'ads_link_campaigns', 'tracking_health_days', 'ip_exclusion_prefs', 'ip_exclusions', 'ip_exclusion_runs',
  'blocklist_exports', 'claim_packages', 'claimed_gclids', 'labels', 'audit_log', 'email_outbox', 'owner_sessions', 'owner',
];
const V1_TABLES = ['sites', 'uploads', 'events', 'analyses', 'verdicts', 'packages', 'notifications', 'settings', 'telemetry', 'counters', 'oauth_clients', 'oauth_codes', 'oauth_tokens'];

const tmp = () => mkdtempSync(join(tmpdir(), 'smb-mig-'));
const mode = (p: string) => statSync(p).mode & 0o777;
const count = (d: DatabaseSync, t: string) => (d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
const tables = (d: DatabaseSync) => (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);

/** A database as the 1.x releases leave it: the 1.x schema, some data, no migration table. */
function makeV1File(dir: string): string {
  const path = join(dir, 'toolkit.db');
  const d = new DatabaseSync(path);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  runMigrations(d, { migrations: [baseline] });
  d.exec('DROP TABLE _migrations');
  d.exec(`INSERT INTO sites(name, host, key, created_at) VALUES ('Shop', 'shop.test', 'k1', '2026-09-01T00:00:00.000Z'), ('Blog', 'blog.test', 'k2', '2026-09-02T00:00:00.000Z')`);
  for (let i = 0; i < 5; i++) {
    d.prepare(`INSERT INTO events(site_id, source, received_at, ts, ip, gclid) VALUES (1, 'beacon', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:0${i}.000Z', '203.0.113.${i}', ?)`).run(`g${i}`);
  }
  d.exec(`INSERT INTO settings(key, value) VALUES ('x', 'y')`);
  d.close();
  return path;
}

describe('migrations', () => {
  it('a fresh database gets every migration and the new tables empty', () => {
    const d = new DatabaseSync(':memory:');
    runMigrations(d);
    const names = tables(d);
    for (const t of [...V1_TABLES, ...V2_TABLES, '_migrations']) assert.ok(names.includes(t), `missing ${t}`);
    for (const t of V2_TABLES) assert.equal(count(d, t), 0, `${t} should be empty`);
    assert.deepEqual((d.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: number }[]).map((r) => r.id), MIGRATIONS.map((m) => m.id));
  });

  it('running again changes nothing', () => {
    const d = new DatabaseSync(':memory:');
    runMigrations(d);
    const before = JSON.stringify(d.prepare('SELECT * FROM _migrations').all());
    runMigrations(d);
    assert.equal(JSON.stringify(d.prepare('SELECT * FROM _migrations').all()), before);
  });

  it('the new shapes of sites, events and verdicts are not created here: the 1.x tables are untouched', () => {
    const d = new DatabaseSync(':memory:');
    runMigrations(d);
    const cols = (t: string) => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols('events').includes('ts') && cols('events').includes('asn_name'));
    assert.ok(cols('verdicts').includes('analysis_id'));
    assert.ok(!cols('sites').includes('verified_at'));
  });

  it('an existing 1.x file is backed up (mode 0600) before the upgrade, and keeps all its rows', () => {
    const dir = tmp();
    const path = makeV1File(dir);
    const d = new DatabaseSync(path);
    d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    runMigrations(d, { dbPath: path, dataDir: dir, today: () => '2026-10-21', freeBytes: () => 1e12 });

    const backup = join(dir, 'backup-v1-2026-10-21.sqlite');
    assert.ok(existsSync(backup));
    assert.equal(mode(backup), 0o600);
    assert.ok(!readdirSync(dir).some((f) => f.endsWith('.partial')));

    // The backup is the 1.x file: its rows, and none of the new tables.
    const b = new DatabaseSync(backup, { readOnly: true });
    assert.equal(count(b, 'events'), 5);
    assert.equal(count(b, 'sites'), 2);
    assert.ok(!tables(b).includes('ads_links'));
    assert.ok(!tables(b).includes('_migrations'));
    b.close();

    assert.equal(count(d, 'events'), 5);
    assert.equal(count(d, 'sites'), 2);
    assert.equal(count(d, 'settings'), 1);
    assert.ok(tables(d).includes('ads_links'));
    d.close();
  });

  it('a fresh database in a folder takes no backup', () => {
    const dir = tmp();
    const path = join(dir, 'toolkit.db');
    const d = new DatabaseSync(path);
    runMigrations(d, { dbPath: path, dataDir: dir, freeBytes: () => 0 }); // no space needed: nothing to copy
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('backup-')), []);
    d.close();
  });

  it('refuses to start on low disk space and changes nothing', () => {
    const dir = tmp();
    const path = makeV1File(dir);
    const d = new DatabaseSync(path);
    d.exec('PRAGMA journal_mode = WAL;');
    const before = tables(d).sort();
    assert.throws(
      () => runMigrations(d, { dbPath: path, dataDir: dir, today: () => '2026-10-21', freeBytes: () => 1024 }),
      (err: unknown) => err instanceof InsufficientDiskSpace && /Nothing was changed/.test(err.message),
    );
    assert.deepEqual(tables(d).sort(), before);
    assert.ok(!tables(d).includes('_migrations'));
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('backup-')), []);
    assert.equal(count(d, 'events'), 5);
    d.close();
  });

  it('after freeing space the same file upgrades', () => {
    const dir = tmp();
    const path = makeV1File(dir);
    const d = new DatabaseSync(path);
    assert.throws(() => runMigrations(d, { dbPath: path, dataDir: dir, freeBytes: () => 0 }), InsufficientDiskSpace);
    runMigrations(d, { dbPath: path, dataDir: dir, freeBytes: () => 1e12 });
    assert.ok(tables(d).includes('claim_packages'));
    d.close();
  });

  it('one migration that fails rolls back alone and is not recorded', () => {
    const d = new DatabaseSync(':memory:');
    const bad = { id: 3, name: 'bad', up(x: DatabaseSync) { x.exec('CREATE TABLE half_done (a)'); throw new Error('boom'); } };
    assert.throws(() => runMigrations(d, { migrations: [...MIGRATIONS, bad] }), /boom/);
    assert.ok(!tables(d).includes('half_done'));
    assert.deepEqual((d.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: number }[]).map((r) => r.id), [1, 2]);
  });

  it('the audit log is append-only', () => {
    const d = new DatabaseSync(':memory:');
    runMigrations(d);
    d.exec(`INSERT INTO audit_log(at, action) VALUES (1, 'x')`);
    assert.throws(() => d.exec('UPDATE audit_log SET action = \'y\''), /append-only/);
    assert.throws(() => d.exec('DELETE FROM audit_log'), /append-only/);
  });
});

describe('boot', () => {
  it('db() on a fresh data directory is private and fully migrated', async () => {
    const dir = join(tmp(), 'data');
    process.env.SMB_DATA_DIR = dir;
    process.env.SMB_TELEMETRY = 'off';
    const { db } = await import('../src/db.js');
    const d = db();
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(join(dir, 'uploads')), 0o700);
    assert.equal(mode(join(dir, 'toolkit.db')), 0o600);
    assert.ok(tables(d).includes('ads_links'));
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('backup-')), []);
  });
});

describe('data directory permissions', () => {
  it('tightens loose folders and files, leaves symlinks alone', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'uploads'));
    writeFileSync(join(dir, 'toolkit.db'), 'x');
    writeFileSync(join(dir, 'uploads', 'a.csv'), 'x');
    chmodSync(dir, 0o755);
    chmodSync(join(dir, 'uploads'), 0o755);
    chmodSync(join(dir, 'toolkit.db'), 0o644);
    chmodSync(join(dir, 'uploads', 'a.csv'), 0o666);
    fixDataDirModes(dir);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(join(dir, 'uploads')), 0o700);
    assert.equal(mode(join(dir, 'toolkit.db')), 0o600);
    assert.equal(mode(join(dir, 'uploads', 'a.csv')), 0o600);
  });
});
