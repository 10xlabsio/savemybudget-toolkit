// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runMigrations, fixDataDirModes, listBackups, purgeOldBackups, InsufficientDiskSpace, MIGRATIONS } = await import('../src/migrations/index.js');
const { baseline } = await import('../src/migrations/001_v1_baseline.js');

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
    for (const t of [...V1_TABLES, 'audit_log', '_migrations']) assert.ok(names.includes(t), `missing ${t}`);
    assert.equal(count(d, 'audit_log'), 0);
    assert.deepEqual((d.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: number }[]).map((r) => r.id), MIGRATIONS.map((m) => m.id));
  });

  it('running again changes nothing', () => {
    const d = new DatabaseSync(':memory:');
    runMigrations(d);
    const before = JSON.stringify(d.prepare('SELECT * FROM _migrations').all());
    runMigrations(d);
    assert.equal(JSON.stringify(d.prepare('SELECT * FROM _migrations').all()), before);
  });

  it('adds only the five new sites columns and the audit log; 1.x tables keep their shape', () => {
    const d = new DatabaseSync(':memory:');
    runMigrations(d);
    const cols = (t: string) => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols('events').includes('ts') && cols('events').includes('asn_name'));
    assert.ok(cols('verdicts').includes('analysis_id'));
    for (const c of ['verified_at', 'first_gclid_at', 'v2_started_at', 'time_zone', 'consent_gated']) assert.ok(cols('sites').includes(c), c);
    const extra = tables(d).filter((t) => ![...V1_TABLES, 'audit_log', '_migrations', 'sqlite_sequence'].includes(t));
    assert.deepEqual(extra, []);
    d.exec(`INSERT INTO sites(name, host, key, created_at) VALUES ('A', 'a.test', 'k', '2026-09-01T00:00:00.000Z')`);
    assert.equal((d.prepare('SELECT consent_gated AS c FROM sites').get() as { c: number }).c, 0);
  });

  it('adding the sites columns twice is harmless', () => {
    const d = new DatabaseSync(':memory:');
    runMigrations(d);
    d.exec('DELETE FROM _migrations WHERE id = 2');
    runMigrations(d);
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n, 2);
  });

  it('an existing 1.x file is backed up (mode 0600) before the upgrade, and keeps all its rows', () => {
    const dir = tmp();
    const path = makeV1File(dir);
    const d = new DatabaseSync(path);
    d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    runMigrations(d, { dbPath: path, dataDir: dir, stamp: () => '20261021T100000000Z', freeBytes: () => 1e12 });

    const backup = join(dir, 'backup-v1-20261021T100000000Z.sqlite');
    assert.ok(existsSync(backup));
    assert.equal(mode(backup), 0o600);
    assert.ok(!readdirSync(dir).some((f) => f.endsWith('.partial')));

    // The backup is the 1.x file: its rows, and none of the new tables.
    const b = new DatabaseSync(backup, { readOnly: true });
    assert.equal(count(b, 'events'), 5);
    assert.equal(count(b, 'sites'), 2);
    assert.ok(!tables(b).includes('audit_log'));
    assert.ok(!tables(b).includes('_migrations'));
    b.close();

    assert.equal(count(d, 'events'), 5);
    assert.equal(count(d, 'sites'), 2);
    assert.equal(count(d, 'settings'), 1);
    assert.ok(tables(d).includes('audit_log'));
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
      () => runMigrations(d, { dbPath: path, dataDir: dir, stamp: () => '20261021T100000000Z', freeBytes: () => 1024 }),
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
    assert.ok(tables(d).includes('audit_log'));
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

  it('the audit log cannot be overwritten by INSERT OR REPLACE', () => {
    const d = new DatabaseSync(':memory:');
    runMigrations(d);
    d.exec(`INSERT INTO audit_log(at, action) VALUES (1, 'x')`);
    assert.throws(() => d.exec(`INSERT OR REPLACE INTO audit_log(id, at, action) VALUES (1, 2, 'y')`), /append-only/);
    assert.equal((d.prepare('SELECT action FROM audit_log WHERE id = 1').get() as { action: string }).action, 'x');
  });

  it('the audit log takes counts only', () => {
    const d = new DatabaseSync(':memory:');
    runMigrations(d);
    const put = (counts: string) => d.prepare('INSERT INTO audit_log(at, action, counts) VALUES (1, ?, ?)').run('x', counts);
    put('{}');
    put('{"rows":12,"files":0}');
    for (const bad of ['not json', '[1,2]', '"text"', '{"ip":"203.0.113.9"}', '{"n":1.5}', '{"n":null}', '{"n":{"a":1}}']) {
      assert.throws(() => put(bad), /integers only/, bad);
    }
    assert.equal(count(d, 'audit_log'), 2);
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
    assert.ok(tables(d).includes('audit_log'));
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('backup-')), []);
  });
});

describe('backup freshness and failures', () => {
  const backups = (dir: string) => readdirSync(dir).filter((f) => f.startsWith('backup-v1-')).sort();
  const dbSize = (p: string) => statSync(p).size;

  it('upgrade, roll back to the backup, add rows, retry the same day: the new backup has the new rows', () => {
    const dir = tmp();
    const path = makeV1File(dir);
    const sameDay = () => '20261021T100000000Z';
    let d = new DatabaseSync(path);
    d.exec('PRAGMA journal_mode = WAL;');
    runMigrations(d, { dbPath: path, dataDir: dir, stamp: sameDay, freeBytes: () => 1e12 });
    d.close();
    const [first] = backups(dir);

    // The documented way back: the backup replaces the database.
    for (const f of [path, path + '-wal', path + '-shm']) rmSync(f, { force: true });
    copyFileSync(join(dir, first), path);

    d = new DatabaseSync(path);
    d.exec('PRAGMA journal_mode = WAL;');
    for (let i = 0; i < 3; i++) d.prepare(`INSERT INTO events(site_id, source, received_at, ts, ip, gclid) VALUES (1, 'beacon', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:0${i}.000Z', '198.51.100.${i}', ?)`).run(`n${i}`);
    runMigrations(d, { dbPath: path, dataDir: dir, stamp: sameDay, freeBytes: () => 1e12 });
    d.close();

    const all = backups(dir);
    assert.equal(all.length, 2, 'a second copy under a new name, the first one untouched');
    const counts = all.map((f) => { const b = new DatabaseSync(join(dir, f), { readOnly: true }); const n = count(b, 'events'); b.close(); return n; }).sort();
    assert.deepEqual(counts, [5, 8]);
    for (const f of all) assert.equal(mode(join(dir, f)), 0o600);
  });

  it('a free-space figure equal to the database size is not enough: the check leaves headroom', () => {
    const dir = tmp();
    const path = makeV1File(dir);
    const d = new DatabaseSync(path);
    assert.throws(() => runMigrations(d, { dbPath: path, dataDir: dir, freeBytes: () => dbSize(path) }), InsufficientDiskSpace);
    d.close();
  });

  it('a leftover .partial file is removed before the space check, so it cannot cost space', () => {
    const dir = tmp();
    const path = makeV1File(dir);
    writeFileSync(join(dir, 'backup-v1-20260101T000000000Z.sqlite.partial'), 'junk');
    const d = new DatabaseSync(path);
    assert.throws(() => runMigrations(d, { dbPath: path, dataDir: dir, freeBytes: () => 0 }), InsufficientDiskSpace);
    assert.deepEqual(backups(dir), []);
    d.close();
  });

  it('a full disk during a migration surfaces the original error, not a rollback error', () => {
    const d = new DatabaseSync(':memory:');
    runMigrations(d);
    const pages = (d.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    d.exec(`PRAGMA max_page_count = ${pages + 4}`);
    const big = {
      id: 3, name: 'big',
      up(x: DatabaseSync) {
        x.exec('CREATE TABLE filler (b BLOB)');
        x.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000) INSERT INTO filler SELECT zeroblob(4000) FROM n');
      },
    };
    assert.throws(
      () => runMigrations(d, { migrations: [...MIGRATIONS, big] }),
      (err: unknown) => /full/i.test((err as Error).message) && !/no transaction/i.test((err as Error).message),
    );
    assert.ok(!d.isTransaction);
    assert.ok(!tables(d).includes('filler'));
  });
});

describe('pre-upgrade copy retention', () => {
  const age = (p: string, days: number, nowMs: number) => { const t = new Date(nowMs - days * 86400e3); utimesSync(p, t, t); };

  it('lists copies and deletes only those older than the retention period', () => {
    const dir = tmp();
    const now = Date.parse('2026-12-01T00:00:00Z');
    const files = { old: 'backup-v1-20260801T000000000Z.sqlite', edge: 'backup-v1-20260901T000000000Z.sqlite', young: 'backup-v1-20261120T000000000Z.sqlite' };
    for (const f of Object.values(files)) writeFileSync(join(dir, f), 'x');
    writeFileSync(join(dir, 'backup-v1-20260701T000000000Z.sqlite.partial'), 'x');
    writeFileSync(join(dir, 'toolkit.db'), 'x');
    writeFileSync(join(dir, 'notes.sqlite'), 'x');
    age(join(dir, files.old), 120, now);
    age(join(dir, files.edge), 90, now);
    age(join(dir, files.young), 11, now);
    assert.deepEqual(listBackups(dir).map((b) => b.name), [files.old, files.edge, files.young]);

    assert.equal(purgeOldBackups(dir, 90, now), 2);
    assert.deepEqual(listBackups(dir).map((b) => b.name), [files.young]);
    for (const keep of ['toolkit.db', 'notes.sqlite', 'backup-v1-20260701T000000000Z.sqlite.partial']) assert.ok(existsSync(join(dir, keep)), keep);
  });

  it('does nothing on a missing folder', () => {
    assert.equal(purgeOldBackups(join(tmp(), 'nope'), 90), 0);
    assert.deepEqual(listBackups(join(tmp(), 'nope')), []);
  });
});

describe('data directory permissions', () => {
  const BK = 'backup-v1-20261021T100000000Z.sqlite';

  it("tightens the toolkit's own loose folders and files", () => {
    const dir = tmp();
    mkdirSync(join(dir, 'uploads'));
    mkdirSync(join(dir, 'packages'));
    const loose: [string, number][] = [['toolkit.db', 0o644], ['toolkit.db-wal', 0o666], ['toolkit.db-shm', 0o640], [BK, 0o644], ['uploads/a.csv', 0o666], ['packages/p.zip', 0o644]];
    for (const [f, m] of loose) { writeFileSync(join(dir, f), 'x'); chmodSync(join(dir, f), m); }
    chmodSync(dir, 0o755);
    chmodSync(join(dir, 'uploads'), 0o755);
    fixDataDirModes(dir);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(join(dir, 'uploads')), 0o700);
    for (const [f] of loose) assert.equal(mode(join(dir, f)), 0o600, f);
  });

  it("clears only group and other bits: the owner's bits stay", () => {
    const dir = tmp();
    writeFileSync(join(dir, 'toolkit.db'), 'x');
    chmodSync(join(dir, 'toolkit.db'), 0o750);
    chmodSync(dir, 0o750);
    fixDataDirModes(dir);
    assert.equal(mode(join(dir, 'toolkit.db')), 0o700);
    assert.equal(mode(dir), 0o700);
    chmodSync(join(dir, 'toolkit.db'), 0o440);
    fixDataDirModes(dir);
    assert.equal(mode(join(dir, 'toolkit.db')), 0o400);
  });

  it('does not follow a symlink to a file', () => {
    const dir = tmp();
    const outside = join(tmp(), 'secret.txt');
    writeFileSync(outside, 'x');
    chmodSync(outside, 0o644);
    mkdirSync(join(dir, 'uploads'));
    symlinkSync(outside, join(dir, 'toolkit.db-wal'));
    symlinkSync(outside, join(dir, 'uploads/link.csv'));
    fixDataDirModes(dir);
    assert.equal(mode(outside), 0o644);
  });

  it('does not follow a symlink to a directory', () => {
    const dir = tmp();
    const outsideDir = join(tmp(), 'elsewhere');
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, 'f.txt'), 'x');
    chmodSync(outsideDir, 0o755);
    chmodSync(join(outsideDir, 'f.txt'), 0o644);
    symlinkSync(outsideDir, join(dir, 'packages'));
    mkdirSync(join(dir, 'uploads'));
    symlinkSync(outsideDir, join(dir, 'uploads/sub'));
    fixDataDirModes(dir);
    assert.equal(mode(outsideDir), 0o755);
    assert.equal(mode(join(outsideDir, 'f.txt')), 0o644);
  });

  it('leaves a file hard-linked from outside the folder alone', () => {
    const dir = tmp();
    const outside = join(tmp(), 'shared.txt');
    writeFileSync(outside, 'x');
    chmodSync(outside, 0o644);
    mkdirSync(join(dir, 'uploads'));
    linkSync(outside, join(dir, 'uploads/h.csv'));
    linkSync(outside, join(dir, 'toolkit.db'));
    fixDataDirModes(dir);
    assert.equal(mode(outside), 0o644);
  });

  it('leaves unrelated files in the folder alone', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'notes.txt'), 'x');
    mkdirSync(join(dir, 'other'));
    writeFileSync(join(dir, 'other/y.txt'), 'x');
    chmodSync(join(dir, 'notes.txt'), 0o644);
    chmodSync(join(dir, 'other'), 0o755);
    chmodSync(join(dir, 'other/y.txt'), 0o644);
    fixDataDirModes(dir);
    assert.equal(mode(join(dir, 'notes.txt')), 0o644);
    assert.equal(mode(join(dir, 'other')), 0o755);
    assert.equal(mode(join(dir, 'other/y.txt')), 0o644);
  });

  it('a data directory that is itself a symlink is resolved, and a warning is printed', (t) => {
    const real = tmp();
    const link = join(tmp(), 'data');
    symlinkSync(real, link);
    writeFileSync(join(real, 'toolkit.db'), 'x');
    chmodSync(join(real, 'toolkit.db'), 0o644);
    const warn = t.mock.method(console, 'warn', () => {});
    fixDataDirModes(link);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /symbolic link/);
    assert.equal(mode(join(real, 'toolkit.db')), 0o600);
  });
});
