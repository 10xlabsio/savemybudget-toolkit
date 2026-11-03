// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * A stand-in for Google in the owner sign-in tests: its own RSA keys and JWKS, a token endpoint that checks PKCE,
 * and helpers that walk the browser through start → Google → callback. No network.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export const CLIENT_ID = 'toolkit-test-client.apps.googleusercontent.com';
export const CLIENT_SECRET = 'test-client-secret-not-real';
export const OWNER = 'owner@example.com';

const keyPair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
export const GOOGLE_KEY = keyPair();
export const OTHER_KEY = keyPair();
const KID = 'test-key-1';

export const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signJwt(claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; alg?: string } = {}): string {
  const head = b64url(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? KID, typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), opts.key ?? GOOGLE_KEY.privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

/** What the next code exchange should answer with, keyed by the code. */
interface Pending { challenge: string; claims?: Record<string, unknown>; idToken?: string; status?: number }
export const pending = new Map<string, Pending>();
export const calls: string[] = [];

export const fakeFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  calls.push(input);
  if (input === 'https://www.googleapis.com/oauth2/v3/certs') {
    const jwk = GOOGLE_KEY.publicKey.export({ format: 'jwk' });
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } });
  }
  if (input === 'https://oauth2.googleapis.com/token') {
    const body = new URLSearchParams(String(init?.body ?? ''));
    const p = pending.get(body.get('code') ?? '');
    if (!p || body.get('client_id') !== CLIENT_ID || body.get('client_secret') !== CLIENT_SECRET) return new Response('{"error":"invalid_grant"}', { status: 400 });
    pending.delete(body.get('code')!);
    const verifier = body.get('code_verifier') ?? '';
    if (createHash('sha256').update(verifier).digest('base64url') !== p.challenge) return new Response('{"error":"invalid_grant","error_description":"PKCE"}', { status: 400 });
    if (p.status) return new Response('{}', { status: p.status });
    return new Response(JSON.stringify({ id_token: p.idToken ?? signJwt(p.claims!), access_token: 'unused', token_type: 'Bearer', expires_in: 3599 }), { headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected fetch to ${input}`);
};

/** The claims Google would put in a good ID token for this sign-in. */
export function goodClaims(nonce: string, nowMs: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const s = Math.floor(nowMs / 1000);
  return { iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: '110000000000000000001', email: OWNER, email_verified: true, iat: s, exp: s + 3600, nonce, ...over };
}

export function setCookies(r: Response): string[] {
  return r.headers.getSetCookie();
}
export function cookieValue(r: Response, name: string): string | null {
  for (const c of setCookies(r)) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (pair.slice(0, i) === name) return pair.slice(i + 1);
  }
  return null;
}
