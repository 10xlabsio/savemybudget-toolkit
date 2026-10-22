// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import type { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync, renameSync, rmSync, statSync, statfsSync, utimesSync } from 'node:fs';
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
  /** A file-name-safe timestamp for the backup name. Replaceable in tests. */
  stamp?: () => string;
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
const defaultStamp = () => new Date().toISOString().replace(/[-:.]/g, '');

/** Free space needed for a copy of `bytes`, with room for the temporary files SQLite writes alongside. */
const withHeadroom = (bytes: number) => Math.ceil(bytes * 1.25) + 8 * 1048576;

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

  const taken = hadData && opts.dbPath && pending.some((m) => m.backupFirst) ? backupBeforeUpgrade(d, opts.dbPath, opts) : null;
  // Migrations before the first one that needs the copy only create bookkeeping (the 1.x baseline on a 1.x file); they do not count as a change.
  const guardId = Math.min(...pending.filter((m) => m.backupFirst).map((m) => m.id));
  let committed = 0;

  d.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const m of pending) {
    d.exec('BEGIN IMMEDIATE');
    try {
      m.up(d);
      d.prepare('INSERT INTO _migrations(id, name, applied_at) VALUES(?, ?, ?)').run(m.id, m.name, new Date().toISOString());
      d.exec('COMMIT');
      if (m.id >= guardId) committed++;
    } catch (err) {
      // SQLite may already have rolled back (a full disk does); a failing ROLLBACK must not hide the real error.
      if (d.isTransaction) { try { d.exec('ROLLBACK'); } catch { /* the original error matters more */ } }
      // Nothing was changed, so the copy only duplicates the database; a crash-looping start must not pile them up.
      if (taken && !committed) { try { rmSync(taken, { force: true }); } catch { /* left for the retention purge */ } }
      throw err;
    }
  }
}

const BACKUP_PARTIAL_RE = /^backup-v1-.*\.sqlite\.partial$/;
/** A pre-upgrade copy made by the migrations (not its temporary `.partial`). */
export const BACKUP_RE = /^backup-v1-.*\.sqlite$/;

function safeReaddir(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }

/**
 * Free-space check, then VACUUM INTO backup-v1-<timestamp>.sqlite (mode 0600) next to the database.
 * Every upgrade attempt takes a fresh copy under a new name, so a backup never goes stale after a rollback
 * and an earlier copy is never overwritten.
 */
function backupBeforeUpgrade(d: DatabaseSync, dbPath: string, opts: MigrateOptions): string {
  const dir = opts.dataDir ?? dirname(dbPath);
  // A copy left half-written by a crash holds space we are about to need.
  for (const f of safeReaddir(dir)) if (BACKUP_PARTIAL_RE.test(f)) rmSync(join(dir, f), { force: true });
  const needed = withHeadroom(dbBytes(dbPath));
  const free = (opts.freeBytes ?? defaultFreeBytes)(dir);
  if (free < needed) throw new InsufficientDiskSpace(needed, free, dir);
  const base = `backup-v1-${(opts.stamp ?? defaultStamp)()}`;
  let final = join(dir, `${base}.sqlite`);
  for (let i = 2; existsSync(final); i++) final = join(dir, `${base}-${i}.sqlite`);
  const partial = final + '.partial';
  d.prepare('VACUUM INTO ?').run(partial);
  const fd = openSync(partial, constants.O_RDONLY);
  try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
  renameSync(partial, final); // a copy under its final name is a complete one
  return final;
}

/** Timestamps before this are a clock that was never set (or a copied-over epoch), not a real write time. */
const CLOCK_FLOOR_MS = Date.UTC(2026, 0, 1);
const FUTURE_SLACK_MS = 86400e3;

/**
 * The pre-upgrade copies in `dir`, oldest first, with when each counts as written (ms since the epoch).
 * A modification time before 2026-01-01 or more than a day ahead of `nowMs` cannot be trusted (an unsynced
 * clock): such a copy counts from now, and the file's time is set to now so the date is recorded and stays put.
 * With a clock of its own before the floor, times are reported as they are and nothing is touched.
 */
export function listBackups(dir: string, nowMs = Date.now()): { name: string; at: number }[] {
  const out: { name: string; at: number }[] = [];
  const clockOk = nowMs >= CLOCK_FLOOR_MS;
  for (const name of safeReaddir(dir)) {
    if (!BACKUP_RE.test(name)) continue;
    try {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (!st.isFile()) continue;
      let at = st.mtimeMs;
      if (clockOk && (at < CLOCK_FLOOR_MS || at > nowMs + FUTURE_SLACK_MS)) {
        at = nowMs;
        try { utimesSync(p, new Date(nowMs), new Date(nowMs)); } catch { /* counts from now again next time */ }
      }
      out.push({ name, at });
    } catch { /* gone */ }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Deletes pre-upgrade copies written at least `days` days before `nowMs`. Returns how many went. */
export function purgeOldBackups(dir: string, days: number, nowMs = Date.now()): number {
  if (nowMs < CLOCK_FLOOR_MS) return 0; // this machine's clock is not set: delete nothing
  let n = 0;
  for (const b of listBackups(dir, nowMs)) {
    if (nowMs - b.at < days * 86400e3) continue;
    try { rmSync(join(dir, b.name)); n++; } catch { /* in use or gone; next night */ }
  }
  return n;
}

/**
 * Makes the toolkit's own files in the data directory private to its user: group and other bits are cleared,
 * the owner's are kept. Only entries the toolkit creates are touched (the database and its -wal/-shm, the
 * pre-upgrade copies, uploads/ and packages/). Anything not owned by this process, on another device, reached
 * through a symlink or hard-linked from elsewhere is skipped, so a planted link cannot make us change a file
 * outside the folder.
 */
export function fixDataDirModes(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    if (lstatSync(dir).isSymbolicLink()) console.warn(`The data directory ${dir} is a symbolic link; permissions are set on its target.`);
  } catch { /* checked below */ }
  let root: string;
  try { root = realpathSync(dir); } catch (err) { console.warn(`Could not resolve ${dir}: ${(err as Error).message}`); return; }
  const rootDev = statSync(root).dev;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;

  const tighten = (p: string, isDir: boolean): boolean => {
    let fd: number | null = null;
    try {
      fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0) | (isDir ? (constants.O_DIRECTORY ?? 0) : 0));
      const st = fstatSync(fd);
      if (isDir ? !st.isDirectory() : !st.isFile()) return false;
      if (uid !== null && st.uid !== uid) return false;
      if (st.dev !== rootDev) return false;
      if (!isDir && st.nlink > 1) return false;
      const have = st.mode & 0o7777;
      const want = have & ~0o077;
      if (want !== have) fchmodSync(fd, want);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ELOOP' && code !== 'ENOTDIR') console.warn(`Could not set permissions on ${p}: ${(err as Error).message}`);
      return false;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  };
  const walk = (p: string) => {
    if (!tighten(p, true)) return;
    for (const e of safeReaddir(p)) {
      const c = join(p, e);
      let st;
      try { st = lstatSync(c); } catch { continue; }
      if (st.isDirectory()) walk(c);
      else if (st.isFile()) tighten(c, false);
    }
  };

  tighten(root, true);
  const OWN_FILE = /^(toolkit\.db(-wal|-shm)?|backup-v1-.*\.sqlite(\.partial)?)$/;
  for (const e of safeReaddir(root)) {
    const p = join(root, e);
    if (e === 'uploads' || e === 'packages') walk(p);
    else if (OWN_FILE.test(e)) tighten(p, false);
  }
}
