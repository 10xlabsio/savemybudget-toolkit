// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * Google sign-in for the owner: the authorization URL, the code exchange and the ID token check.
 *
 * The ID token is verified here with node:crypto, not trusted because it came over TLS: RS256 signature against
 * Google's published keys (JWKS, cached for as long as Google's Cache-Control allows, refetched at most once a
 * minute when an unknown key id appears), then issuer, audience, expiry, issue time, nonce and `email_verified`.
 * The caller then compares the email and the pinned `sub`.
 *
 * Every network call goes through an injectable `fetch`, so the tests run without a network.
 */
import { createPublicKey, verify as verifySignature, type KeyObject, type JsonWebKey } from 'node:crypto';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const CLOCK_SKEW_S = 60;
const NET_TIMEOUT_MS = 10_000;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: Fetch = (input, init) => fetch(input, init);
/** For tests: replace the network. Returns the previous implementation. */
export function setGoogleFetch(f: Fetch): Fetch { const prev = fetchImpl; fetchImpl = f; jwks = emptyJwks(); return prev; }

export class GoogleSignInError extends Error {
  constructor(readonly reason: string) { super(`Google sign-in refused: ${reason}`); }
}

/** The authorization request: `openid email` only, account chooser every time, no offline access, PKCE S256. */
export function authorizationUrl(p: { clientId: string; redirectUri: string; state: string; nonce: string; codeChallenge: string }): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.search = new URLSearchParams({
    client_id: p.clientId, redirect_uri: p.redirectUri, response_type: 'code', scope: 'openid email',
    state: p.state, nonce: p.nonce, code_challenge: p.codeChallenge, code_challenge_method: 'S256', prompt: 'select_account',
  }).toString();
  return u.toString();
}

/** Trades the code for tokens at Google's token endpoint and returns the ID token. Google's error body is never surfaced. */
export async function exchangeCode(p: { code: string; codeVerifier: string; redirectUri: string; clientId: string; clientSecret: string }): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: p.code, code_verifier: p.codeVerifier, redirect_uri: p.redirectUri, client_id: p.clientId, client_secret: p.clientSecret }).toString(),
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleSignInError('token endpoint unreachable');
  }
  if (!res.ok) throw new GoogleSignInError(`token endpoint answered ${res.status}`);
  let body: unknown;
  try { body = await res.json(); } catch { throw new GoogleSignInError('token endpoint answered with something other than JSON'); }
  const idToken = (body as { id_token?: unknown } | null)?.id_token;
  if (typeof idToken !== 'string' || idToken.length > 8192) throw new GoogleSignInError('no ID token in the answer');
  return idToken;
}

// ---------------------------------------------------------------- JWKS

interface JwksCache { keys: Map<string, KeyObject>; expiresAt: number; lastFetchAt: number }
const emptyJwks = (): JwksCache => ({ keys: new Map(), expiresAt: 0, lastFetchAt: -Infinity });
let jwks = emptyJwks();

/** max-age from Cache-Control, clamped to 5 minutes – 24 hours; one hour when Google doesn't say. */
function cacheSeconds(header: string | null): number {
  const m = /(?:^|,)\s*max-age=(\d+)/i.exec(header ?? '');
  const s = m ? Number(m[1]) : 3600;
  return Math.min(Math.max(s, 300), 86400);
}

async function refreshJwks(nowMs: number): Promise<void> {
  jwks.lastFetchAt = nowMs;
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_JWKS_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
  } catch {
    throw new GoogleSignInError("Google's signing keys are unreachable");
  }
  if (!res.ok) throw new GoogleSignInError(`Google's signing keys answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as { keys?: unknown } | null;
  const keys = new Map<string, KeyObject>();
  for (const k of Array.isArray(body?.keys) ? body.keys : []) {
    const j = k as JsonWebKey & { kid?: unknown; use?: unknown; alg?: unknown };
    if (typeof j.kid !== 'string' || j.kty !== 'RSA' || (j.use !== undefined && j.use !== 'sig') || (j.alg !== undefined && j.alg !== 'RS256')) continue;
    try { keys.set(j.kid, createPublicKey({ key: { kty: 'RSA', n: j.n, e: j.e }, format: 'jwk' })); } catch { /* skip a malformed key */ }
  }
  if (keys.size === 0) throw new GoogleSignInError("Google's signing keys could not be read");
  jwks = { keys, expiresAt: nowMs + cacheSeconds(res.headers.get('cache-control')) * 1000, lastFetchAt: nowMs };
}

async function signingKey(kid: string, nowMs: number): Promise<KeyObject> {
  if (nowMs >= jwks.expiresAt) await refreshJwks(nowMs);
  let key = jwks.keys.get(kid);
  // Google rotates keys; an unknown id may be a new one. Refetch, but at most once a minute.
  if (!key && nowMs - jwks.lastFetchAt >= 60_000) { await refreshJwks(nowMs); key = jwks.keys.get(kid); }
  if (!key) throw new GoogleSignInError('signed with an unknown key');
  return key;
}

// ---------------------------------------------------------------- ID token

export interface IdClaims { sub: string; email: string }

const b64json = (part: string): Record<string, unknown> => {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new GoogleSignInError('malformed token');
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new GoogleSignInError('malformed token');
};

/** Verifies a Google ID token for this client and sign-in. Throws GoogleSignInError with the first failed check. */
export async function verifyIdToken(idToken: string, p: { clientId: string; nonce: string; nowMs: number }): Promise<IdClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new GoogleSignInError('malformed token');
  const header = b64json(parts[0]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new GoogleSignInError('unexpected signing algorithm');
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) throw new GoogleSignInError('malformed token');
  const key = await signingKey(header.kid, p.nowMs);
  const ok = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new GoogleSignInError('bad signature');

  const c = b64json(parts[1]);
  const nowS = Math.floor(p.nowMs / 1000);
  if (typeof c.iss !== 'string' || !ISSUERS.has(c.iss)) throw new GoogleSignInError('wrong issuer');
  const aud = c.aud;
  if (Array.isArray(aud) ? !(aud.includes(p.clientId) && c.azp === p.clientId) : aud !== p.clientId) throw new GoogleSignInError('wrong audience');
  if (typeof c.exp !== 'number' || c.exp + CLOCK_SKEW_S <= nowS) throw new GoogleSignInError('expired');
  if (typeof c.iat !== 'number' || c.iat - CLOCK_SKEW_S > nowS) throw new GoogleSignInError('issued in the future');
  if (c.nonce !== p.nonce) throw new GoogleSignInError('nonce mismatch');
  if (c.email_verified !== true) throw new GoogleSignInError('email not verified');
  if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw new GoogleSignInError('no subject');
  if (typeof c.email !== 'string' || !c.email.includes('@') || c.email.length > 320) throw new GoogleSignInError('no email');
  return { sub: c.sub, email: c.email };
}
