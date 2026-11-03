// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './index.js';

/**
 * Owner sign-in (used only when a Google OAuth client is configured).
 *
 * - `owner`: one row. The SHA-256 of the configured owner email, Google's `sub` pinned at the first sign-in, the
 *   session epoch (bumped by "Sign out everywhere") and a fingerprint of the secret key in use. A change to the
 *   email or the key clears the pin and ends every session.
 * - `owner_sessions`: only the SHA-256 of each session id; the id itself lives in the browser cookie alone.
 * - `owner_signin_states`: the single-use ids of sign-ins in progress (10 minutes).
 *
 * Instants are integer milliseconds since the epoch. No email address is stored.
 */
export const ownerAuth: Migration = {
  id: 3,
  name: 'owner_auth',
  up(d: DatabaseSync) {
    d.exec(`
    CREATE TABLE IF NOT EXISTS owner (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      email_hash TEXT,
      sub TEXT,
      pinned_at INTEGER,
      epoch INTEGER NOT NULL DEFAULT 0,
      key_fp TEXT
    );
    CREATE TABLE IF NOT EXISTS owner_sessions (
      id_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      epoch INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owner_signin_states (
      id_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    `);
  },
};
