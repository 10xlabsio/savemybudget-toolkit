// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './index.js';

/**
 * The additive part of the 2.x schema: five new columns on `sites` and the append-only `audit_log`.
 * Each column is added only if missing, and 1.x statements name their columns, so a 1.x build still runs on the file.
 * Instants are integer milliseconds since the epoch.
 *
 * Every other 2.x table is created by the migration that ships with the code that first writes it.
 */
export const v2Tables: Migration = {
  id: 2,
  name: 'v2_tables',
  backupFirst: true,
  up(d: DatabaseSync) {
    const have = new Set((d.prepare('PRAGMA table_info(sites)').all() as { name: string }[]).map((c) => c.name));
    const add = (name: string, ddl: string) => { if (!have.has(name)) d.exec(`ALTER TABLE sites ADD COLUMN ${name} ${ddl}`); };
    add('verified_at', 'INTEGER');
    add('first_gclid_at', 'INTEGER');
    add('v2_started_at', 'INTEGER');
    add('time_zone', 'TEXT');
    add('consent_gated', 'INTEGER NOT NULL DEFAULT 0');

    d.exec(`
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
    -- INSERT OR REPLACE would otherwise overwrite a row without firing the delete trigger.
    CREATE TRIGGER IF NOT EXISTS audit_log_no_replace BEFORE INSERT ON audit_log
      WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    -- Counts only. The action is a short lowercase name and counts is a JSON object whose keys are short
    -- lowercase names and whose values are all integers, so no identifier, address or free text can land here.
    -- Text functions, GLOB and the JSON parser stop at the first NUL, so each text must also be as many bytes as
    -- characters: no NUL and nothing outside ASCII can hide bytes after a valid prefix. Counts holds no backslash,
    -- so a key cannot be spelt with JSON escapes.
    CREATE TRIGGER IF NOT EXISTS audit_log_counts_only BEFORE INSERT ON audit_log
      WHEN NOT (typeof(NEW.counts) = 'text' AND length(CAST(NEW.counts AS BLOB)) = length(NEW.counts)
                AND instr(NEW.counts, char(92)) = 0
                AND json_valid(NEW.counts) AND json_type(NEW.counts) = 'object'
                AND NOT EXISTS (SELECT 1 FROM json_each(NEW.counts)
                                WHERE type != 'integer' OR key = '' OR length(key) > 64 OR key GLOB '*[^a-z_]*'))
      BEGIN SELECT RAISE(ABORT, 'audit_log counts must be integers under lowercase a-z_ keys'); END;
    CREATE TRIGGER IF NOT EXISTS audit_log_action_name BEFORE INSERT ON audit_log
      WHEN NOT (typeof(NEW.action) = 'text' AND length(CAST(NEW.action AS BLOB)) = length(NEW.action)
                AND NEW.action != '' AND length(NEW.action) <= 64 AND NOT NEW.action GLOB '*[^a-z_]*')
      BEGIN SELECT RAISE(ABORT, 'audit_log action must be a lowercase a-z_ name'); END;
    -- Column types are not enforced by SQLite: without this, text could be stored in the time or site column.
    CREATE TRIGGER IF NOT EXISTS audit_log_numbers BEFORE INSERT ON audit_log
      WHEN NOT (typeof(NEW.at) = 'integer' AND (NEW.site_id IS NULL OR typeof(NEW.site_id) = 'integer'))
      BEGIN SELECT RAISE(ABORT, 'audit_log at and site_id must be integers'); END;
    `);
  },
};
