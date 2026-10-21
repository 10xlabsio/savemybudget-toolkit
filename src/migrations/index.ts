// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import type { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { baseline } from './001_v1_baseline.js';
import { v2Tables } from './002_v2_tables.js';

/**
 * Forward-only, numbered migrations. Each one runs in its own transaction and is recorded in `_migrations`;
 * all pending ones run at boot, before the server listens. A migration is never edited once released: add a new one.
 */
export interface Migration {
  id: number;
  name: string;
  /** Take a copy of the database before running this one on a file that already holds data. */
  backupFirst?: boolean;
  up(d: DatabaseSync): void;
}

export const MIGRATIONS: Migration[] = [baseline, v2Tables];

export interface MigrateOptions {
  /** Path of the database file. Omit for an in-memory database: no backup is taken. */
  dbPath?: string;
  /** Where the backup goes. Default: the folder holding the database. */
  dataDir?: string;
  /** Free bytes on the volume holding `dir`. Replaceable in tests. */
  freeBytes?: (dir: string) => number;
  /** Today as YYYY-MM-DD, for the backup file name. Replaceable in tests. */
  today?: () => string;
  migrations?: Migration[];
}

/** Thrown before anything is changed when the volume cannot hold the pre-upgrade copy. */
export class InsufficientDiskSpace extends Error {
  constructor(readonly neededBytes: number, readonly freeBytes: number, readonly dir: string) {
    super(
      `Not enough free disk space to back up your data before upgrading: about ${mb(neededBytes)} MB needed, ${mb(freeBytes)} MB free in ${dir}. ` +
      'Nothing was changed. Free some space (or move the data directory to a larger volume) and start again, ' +
      'or go back to the 1.x image, which still works with this data.',
    );
    this.name = 'InsufficientDiskSpace';
  }
}
const mb = (n: number) => Math.ceil(n / 1048576);

const defaultFreeBytes = (dir: string) => { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); };
const defaultToday = () => new Date().toISOString().slice(0, 10);

function hasTable(d: DatabaseSync, name: string): boolean {
  return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** Size of the database file plus its write-ahead log: what a full copy needs. */
function dbBytes(dbPath: string): number {
  let n = 0;
  for (const p of [dbPath, dbPath + '-wal']) { try { n += statSync(p).size; } catch { /* absent */ } }
  return n;
}

/** Runs every pending migration. Throws (changing nothing) when a needed backup cannot fit. */
export function runMigrations(d: DatabaseSync, opts: MigrateOptions = {}): void {
  const all = opts.migrations ?? MIGRATIONS;
  const hadData = hasTable(d, 'sites'); // a file that has run any release before
  const applied = new Set<number>(
    hasTable(d, '_migrations') ? (d.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((r) => r.id) : [],
  );
  const pending = all.filter((m) => !applied.has(m.id)).sort((a, b) => a.id - b.id);
  if (!pending.length) return;

  if (hadData && opts.dbPath && pending.some((m) => m.backupFirst)) backupBeforeUpgrade(d, opts.dbPath, opts);

  d.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const m of pending) {
    d.exec('BEGIN IMMEDIATE');
    try {
      m.up(d);
      d.prepare('INSERT INTO _migrations(id, name, applied_at) VALUES(?, ?, ?)').run(m.id, m.name, new Date().toISOString());
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Free-space check, then VACUUM INTO backup-v1-<date>.sqlite (mode 0600) next to the database. */
function backupBeforeUpgrade(d: DatabaseSync, dbPath: string, opts: MigrateOptions): void {
  const dir = opts.dataDir ?? dirname(dbPath);
  const final = join(dir, `backup-v1-${(opts.today ?? defaultToday)()}.sqlite`);
  if (existsSync(final)) return; // a complete copy from an earlier start today; the data has not changed since
  const needed = dbBytes(dbPath);
  const free = (opts.freeBytes ?? defaultFreeBytes)(dir);
  if (free < needed) throw new InsufficientDiskSpace(needed, free, dir);
  const partial = final + '.partial';
  rmSync(partial, { force: true });
  d.prepare('VACUUM INTO ?').run(partial);
  chmodSync(partial, 0o600);
  renameSync(partial, final); // a copy under its final name is a complete one
}

/** Directories 0700, files 0600, everything under the data directory. Symlinks are left alone. */
export function fixDataDirModes(dir: string): void {
  const fix = (p: string, mode: number) => {
    try { chmodSync(p, mode); } catch (err) { console.warn(`Could not set permissions on ${p}: ${(err as Error).message}`); }
  };
  const walk = (p: string) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      fix(p, 0o700);
      for (const e of readdirSync(p)) walk(join(p, e));
    } else if (st.isFile()) fix(p, 0o600);
  };
  if (existsSync(dir)) walk(dir);
}
