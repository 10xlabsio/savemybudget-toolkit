// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * The bearer token that guards /mcp. One per instance.
 * - SMB_MCP_TOKEN in the environment wins; the Settings buttons are hidden then.
 * - Otherwise Settings → AI assistants creates one. Only its SHA-256 is stored; the plain token is kept in a
 *   one-shot "flash" setting just long enough for the next Settings page view to show it once.
 * No token → the endpoint answers 404, as if it didn't exist.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, getSetting, setSetting } from '../db.js';

const HASH_KEY = 'mcp_token_sha256';
const FLASH_KEY = 'mcp_token_flash';
const FLASH_MAX_AGE_MS = 10 * 60_000;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const envToken = () => (process.env.SMB_MCP_TOKEN ?? '').trim();

export type TokenSource = 'env' | 'settings' | null;

export function tokenSource(): TokenSource {
  if (envToken()) return 'env';
  return getSetting(HASH_KEY) ? 'settings' : null;
}

export const mcpEnabled = () => tokenSource() !== null;

/** Constant-time check of a presented bearer token against the env token or the stored hash. */
export function tokenMatches(presented: string): boolean {
  if (!presented) return false;
  const env = envToken();
  const want = env ? sha256(env) : (() => { const h = getSetting(HASH_KEY); return h ? Buffer.from(h, 'hex') : null; })();
  if (!want || want.length !== 32) return false;
  return timingSafeEqual(sha256(presented), want);
}

/** Create (or replace) the stored token. Returns the plain token and arms the one-time display. */
export function issueToken(nowMs = Date.now()): string {
  const token = 'smbt_' + randomBytes(32).toString('base64url');
  setSetting(HASH_KEY, sha256(token).toString('hex'));
  setSetting(FLASH_KEY, JSON.stringify({ token, at: nowMs }));
  return token;
}

export function revokeToken(): void {
  db().prepare('DELETE FROM settings WHERE key IN (?, ?)').run(HASH_KEY, FLASH_KEY);
}

/** The plain token, once: returns it if it was issued in the last 10 minutes, and forgets it either way. */
export function takeFlashToken(nowMs = Date.now()): string | null {
  const raw = getSetting(FLASH_KEY);
  if (!raw) return null;
  db().prepare('DELETE FROM settings WHERE key = ?').run(FLASH_KEY);
  try {
    const f = JSON.parse(raw) as { token?: unknown; at?: unknown };
    if (typeof f.token === 'string' && typeof f.at === 'number' && nowMs - f.at <= FLASH_MAX_AGE_MS) return f.token;
  } catch { /* corrupt: drop it */ }
  return null;
}
