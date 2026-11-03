// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * The owner of this toolkit: which access mode applies, the pinned Google account, server-side sessions,
 * the session-derived form token, and the signed single-use state of a sign-in in progress.
 *
 * Modes:
 * - `open`: no Google OAuth client configured. The 1.x behaviour: the UI answers on loopback (and SMB_UI_URL)
 *   without a sign-in.
 * - `signin`: a client and the owner email are configured. Every UI request needs the owner's session.
 * - `locked`: a client is configured but something sign-in needs is missing. The UI serves only a page that
 *   says what to set. It never falls back to `open`.
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config, secretKeyBytes } from '../config.js';
import { db } from '../db.js';

export const SESSION_COOKIE = '__Host-smb_session';
export const SIGNIN_COOKIE = 'smb_signin';
export const SESSION_IDLE_MS = 7 * 86400e3;
export const SESSION_ABSOLUTE_MS = 30 * 86400e3;
export const STATE_TTL_MS = 10 * 60_000;
const TOUCH_EVERY_MS = 60_000;
const MAX_PENDING_SIGNINS = 1000;

export type AuthMode = { kind: 'open' } | { kind: 'signin' } | { kind: 'locked'; missing: string[] };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function authMode(): AuthMode {
  if (!config.googleClientId) return { kind: 'open' };
  const missing: string[] = [];
  if (!config.ownerEmail || !EMAIL_RE.test(config.ownerEmail)) missing.push('SMB_OWNER_EMAIL');
  if (!config.googleClientSecret) missing.push('SMB_GOOGLE_CLIENT_SECRET');
  return missing.length ? { kind: 'locked', missing } : { kind: 'signin' };
}

let clock = () => Date.now();
/** For tests: move time. */
export function setAuthClock(f: () => number): void { clock = f; }
export const authNow = () => clock();

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- keys

/** Used when SMB_SECRET_KEY is unset: per process, so a restart only means reloading open pages. */
const PROCESS_KEY = randomBytes(32);

/** The HMAC key for sign-in state and form tokens: derived from SMB_SECRET_KEY when set (it never leaves memory). */
function macKey(): Buffer {
  const k = secretKeyBytes();
  return k ? Buffer.from(hkdfSync('sha256', k, Buffer.alloc(0), 'savemybudget-toolkit owner sign-in v1', 32)) : PROCESS_KEY;
}
const mac = (label: string, data: string) => createHmac('sha256', macKey()).update(`${label}\n${data}`).digest('base64url');

/** Fingerprint of the secret key in use ('' when unset): a different key ends every session. */
function keyFingerprint(): string {
  const k = secretKeyBytes();
  return k ? createHmac('sha256', k).update('savemybudget-toolkit key fingerprint').digest('hex').slice(0, 32) : '';
}

// ---------------------------------------------------------------- the owner row

interface OwnerRow { email_hash: string | null; sub: string | null; pinned_at: number | null; epoch: number; key_fp: string | null }

const emailHash = (email: string) => sha256(`owner-email\n${email.trim().toLowerCase()}`);

/**
 * The owner row, brought in line with the configuration first: a different owner email or secret key clears the
 * pinned account and ends every session (the epoch moves on, and the session rows go).
 */
export function ownerRow(): OwnerRow {
  const d = db();
  d.prepare('INSERT OR IGNORE INTO owner(id, epoch) VALUES(1, 0)').run();
  const r = d.prepare('SELECT email_hash, sub, pinned_at, epoch, key_fp FROM owner WHERE id = 1').get() as unknown as OwnerRow;
  const wantEmail = config.ownerEmail ? emailHash(config.ownerEmail) : null;
  const wantKey = keyFingerprint();
  if (r.email_hash === wantEmail && (r.key_fp ?? '') === wantKey) return r;
  const emailChanged = r.email_hash !== wantEmail;
  // First run: nothing to end. Afterwards, a change ends every session.
  const fresh = r.email_hash === null && r.key_fp === null && r.sub === null;
  d.prepare('UPDATE owner SET email_hash = ?, key_fp = ?, sub = CASE WHEN ? THEN NULL ELSE sub END, pinned_at = CASE WHEN ? THEN NULL ELSE pinned_at END, epoch = epoch + ? WHERE id = 1')
    .run(wantEmail, wantKey, emailChanged ? 1 : 0, emailChanged ? 1 : 0, fresh ? 0 : 1);
  if (!fresh) d.prepare('DELETE FROM owner_sessions').run();
  return d.prepare('SELECT email_hash, sub, pinned_at, epoch, key_fp FROM owner WHERE id = 1').get() as unknown as OwnerRow;
}

/** After the ID token checks: the email must be the configured one, and the account the pinned one (pinned now if none). */
export function admitOwner(claims: { sub: string; email: string }, nowMs = authNow()): 'ok' | 'wrong_email' | 'wrong_account' {
  if (!config.ownerEmail || claims.email.trim().toLowerCase() !== config.ownerEmail.toLowerCase()) return 'wrong_email';
  const r = ownerRow();
  if (r.sub === null) {
    const pinned = db().prepare('UPDATE owner SET sub = ?, pinned_at = ? WHERE id = 1 AND sub IS NULL').run(claims.sub, nowMs);
    if (Number(pinned.changes) === 1) return 'ok';
    return ownerRow().sub === claims.sub ? 'ok' : 'wrong_account';
  }
  return safeEqual(r.sub, claims.sub) ? 'ok' : 'wrong_account';
}

/** o•••@example.com: what an unauthenticated page may say about the owner. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

// ---------------------------------------------------------------- sessions

export interface OwnerSession { idHash: string; createdAt: number; email: string; csrf: string }

const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;

/** A new session: 32 random bytes in the cookie, only their SHA-256 here. */
export function createSession(nowMs = authNow()): { id: string; maxAgeS: number } {
  const id = b64url(randomBytes(32));
  const epoch = ownerRow().epoch;
  db().prepare('INSERT INTO owner_sessions(id_hash, created_at, last_seen_at, epoch) VALUES(?,?,?,?)').run(sha256(id), nowMs, nowMs, epoch);
  return { id, maxAgeS: Math.floor(SESSION_ABSOLUTE_MS / 1000) };
}

/** The session a cookie value names, if still valid: same epoch, an account pinned, under 7 days idle and 30 days old. */
export function readSession(cookie: string | undefined, nowMs = authNow()): OwnerSession | null {
  if (!cookie || !SESSION_RE.test(cookie)) return null;
  const idHash = sha256(cookie);
  const d = db();
  const owner = ownerRow();
  const s = d.prepare('SELECT created_at, last_seen_at, epoch FROM owner_sessions WHERE id_hash = ?').get(idHash) as { created_at: number; last_seen_at: number; epoch: number } | undefined;
  if (!s) return null;
  const valid = owner.sub !== null && s.epoch === owner.epoch && nowMs - s.created_at < SESSION_ABSOLUTE_MS && nowMs - s.last_seen_at < SESSION_IDLE_MS && s.created_at <= nowMs + 60_000;
  if (!valid) { d.prepare('DELETE FROM owner_sessions WHERE id_hash = ?').run(idHash); return null; }
  if (nowMs - s.last_seen_at >= TOUCH_EVERY_MS) d.prepare('UPDATE owner_sessions SET last_seen_at = ? WHERE id_hash = ?').run(nowMs, idHash);
  return { idHash, createdAt: s.created_at, email: config.ownerEmail, csrf: csrfFor(idHash) };
}

/** Seconds the cookie may live: what is left of the 30 days. */
export const sessionMaxAgeS = (s: OwnerSession, nowMs = authNow()) => Math.max(0, Math.floor((s.createdAt + SESSION_ABSOLUTE_MS - nowMs) / 1000));

export function endSession(cookie: string | undefined): void {
  if (cookie && SESSION_RE.test(cookie)) db().prepare('DELETE FROM owner_sessions WHERE id_hash = ?').run(sha256(cookie));
}

/** Sign out everywhere: the epoch moves on, so no earlier session is valid, and their rows go. */
export function endAllSessions(): void {
  ownerRow();
  db().prepare('UPDATE owner SET epoch = epoch + 1 WHERE id = 1').run();
  db().prepare('DELETE FROM owner_sessions').run();
}

/** The form token for a session: an HMAC of its id hash, so it changes with every session and can't be guessed from the cookie name. */
export const csrfFor = (idHash: string) => mac('csrf', idHash);

// ---------------------------------------------------------------- sign-in state

/**
 * The `state` sent to Google: `v1.<payload>.<mac>`, naming the flow, its time, where to go after, a hash of the
 * pre-sign-in cookie, and a random id recorded here so the state can be used once. The PKCE verifier and the
 * OIDC nonce are derived from the cookie value with the server key; neither travels in the URL.
 */
export interface SigninStart { state: string; cookie: string; codeChallenge: string; nonce: string }

export function startSignin(next: string, nowMs = authNow()): SigninStart {
  const cookie = b64url(randomBytes(32));
  const id = b64url(randomBytes(16));
  const payload = b64url(Buffer.from(JSON.stringify({ f: 'signin', i: id, t: nowMs, n: next, c: sha256(cookie).slice(0, 32) })));
  const d = db();
  // Anyone who can reach the sign-in page can start one; keep the table small however often they do.
  d.prepare('DELETE FROM owner_signin_states WHERE expires_at <= ?').run(nowMs);
  if ((d.prepare('SELECT COUNT(*) AS n FROM owner_signin_states').get() as { n: number }).n >= MAX_PENDING_SIGNINS) {
    d.prepare('DELETE FROM owner_signin_states WHERE id_hash IN (SELECT id_hash FROM owner_signin_states ORDER BY expires_at LIMIT ?)').run(MAX_PENDING_SIGNINS / 10);
  }
  d.prepare('INSERT INTO owner_signin_states(id_hash, expires_at) VALUES(?, ?)').run(sha256(id), nowMs + STATE_TTL_MS);
  return { state: `v1.${payload}.${mac('state', payload)}`, cookie, codeChallenge: b64url(createHash('sha256').update(pkceVerifier(cookie)).digest()), nonce: oidcNonce(cookie) };
}

export const pkceVerifier = (cookie: string) => mac('pkce', cookie);
export const oidcNonce = (cookie: string) => mac('nonce', cookie);

export type StateCheck = { ok: true; next: string } | { ok: false; reason: 'bad_state' | 'expired' | 'no_cookie' | 'cookie_mismatch' | 'replayed' };

/** Checks the returned state against the cookie and uses it up. Only the first valid use passes. */
export function consumeSignin(state: string, cookie: string | undefined, nowMs = authNow()): StateCheck {
  const m = /^v1\.([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$/.exec(state);
  if (!m || !safeEqual(mac('state', m[1]), m[2])) return { ok: false, reason: 'bad_state' };
  let p: { f?: unknown; i?: unknown; t?: unknown; n?: unknown; c?: unknown };
  try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'bad_state' }; }
  if (p.f !== 'signin' || typeof p.i !== 'string' || typeof p.t !== 'number' || typeof p.c !== 'string') return { ok: false, reason: 'bad_state' };
  if (nowMs - p.t > STATE_TTL_MS || p.t > nowMs + 60_000) return { ok: false, reason: 'expired' };
  if (!cookie) return { ok: false, reason: 'no_cookie' };
  if (!safeEqual(sha256(cookie).slice(0, 32), p.c)) return { ok: false, reason: 'cookie_mismatch' };
  const used = db().prepare('DELETE FROM owner_signin_states WHERE id_hash = ? AND expires_at > ? RETURNING id_hash').get(sha256(p.i), nowMs);
  if (!used) return { ok: false, reason: 'replayed' };
  return { ok: true, next: safeNext(typeof p.n === 'string' ? p.n : '/') };
}

/** A same-site path to return to after sign-in; anything else becomes `/`. */
export function safeNext(next: string | undefined | null): string {
  if (!next || next.length > 2048 || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || /[\u0000-\u001f\u007f]/.test(next)) return '/';
  try {
    const u = new URL(next, 'http://toolkit.invalid');
    if (u.origin !== 'http://toolkit.invalid' || u.pathname.startsWith('/auth/')) return '/';
    return u.pathname + u.search;
  } catch { return '/'; }
}

/** Hourly: drop expired sessions and sign-ins nobody finished. */
export function sweepOwnerAuth(nowMs = authNow()): void {
  const d = db();
  d.prepare('DELETE FROM owner_signin_states WHERE expires_at <= ?').run(nowMs);
  d.prepare('DELETE FROM owner_sessions WHERE created_at <= ? OR last_seen_at <= ?').run(nowMs - SESSION_ABSOLUTE_MS, nowMs - SESSION_IDLE_MS);
}
