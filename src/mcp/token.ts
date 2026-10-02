// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * The bearer token that guards /mcp. One per instance.
 * - SMB_MCP_TOKEN in the environment wins; the Settings buttons are hidden then.
 * - Otherwise Settings → AI assistants creates one. Only its SHA-256 is stored; the plain token is held in
 *   process memory for up to 10 minutes, just long enough for the next Settings page view to show it once.
 * - An SMB_MCP_TOKEN shorter than 24 characters is ignored (and Settings says why): /mcp is public.
 * No token → the endpoint answers 404, as if it didn't exist.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, getSetting, setSetting } from '../db.js';

const HASH_KEY = 'mcp_token_sha256';
const FLASH_MAX_AGE_MS = 10 * 60_000;
export const MIN_ENV_TOKEN_LENGTH = 24;

let flash: { token: string; at: number } | null = null;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const rawEnvToken = () => (process.env.SMB_MCP_TOKEN ?? '').trim();
const envToken = () => { const t = rawEnvToken(); return t.length >= MIN_ENV_TOKEN_LENGTH ? t : ''; };

/** Set but too short to be used — shown on the Settings page. */
export const envTokenTooShort = () => { const t = rawEnvToken(); return t.length > 0 && t.length < MIN_ENV_TOKEN_LENGTH; };

export type TokenSource = 'env' | 'settings' | null;

export function tokenSource(): TokenSource {
  if (envToken()) return 'env';
  return getSetting(HASH_KEY) ? 'settings' : null;
}

export const mcpEnabled = () => tokenSource() !== null;

/**
 * Identifies the current instance token without revealing it. Every OAuth code and token records it; when the
 * token is rotated, turned off or replaced in the environment, the fingerprint changes and every assistant
 * signed in under the old one is signed out.
 */
export function tokenFingerprint(): string | null {
  const env = envToken();
  const hash = env ? sha256(env).toString('hex') : getSetting(HASH_KEY);
  return hash ? createHash('sha256').update(`fp:${hash}`).digest('hex').slice(0, 24) : null;
}

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
  flash = { token, at: nowMs };
  return token;
}

export function revokeToken(): void {
  db().prepare('DELETE FROM settings WHERE key = ?').run(HASH_KEY);
  flash = null;
}

/** The plain token, once: returns it if it was issued in the last 10 minutes, and forgets it either way. */
export function takeFlashToken(nowMs = Date.now()): string | null {
  const f = flash;
  flash = null;
  return f && nowMs - f.at <= FLASH_MAX_AGE_MS ? f.token : null;
}
