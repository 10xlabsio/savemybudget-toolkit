// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * Owner sign-in routes and the gate in front of the UI.
 *
 *   GET  /auth/google/signin     the sign-in page (no session needed)
 *   GET  /auth/google/start      sets the pre-sign-in cookie and sends the browser to Google
 *   GET  /auth/google/callback   Google sends the browser back here
 *   POST /auth/signout           ends this session (needs the session and its form token)
 *   POST /auth/signout-everywhere ends every session
 *
 * Without a Google OAuth client configured every route here is a 404, and the UI keeps its 1.x behaviour.
 * The pages here never use the main layout: before sign-in nothing about the instance (not even site names) is shown.
 */
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { config } from '../config.js';
import { log } from '../jobs/index.js';
import { normHost, uiBase, type AppEnv } from '../ui.js';
import { GoogleSignInError, authorizationUrl, exchangeCode, verifyIdToken } from './google.js';
import {
  SESSION_COOKIE, SIGNIN_COOKIE, admitOwner, authMode, authNow, consumeSignin, createSession, endAllSessions, endSession, maskEmail,
  oidcNonce, pkceVerifier, readSession, safeNext, startSignin, type OwnerSession,
} from './owner.js';

export const CALLBACK_PATH = '/auth/google/callback';
export const redirectUri = () => `${uiBase()}${CALLBACK_PATH}`;

const PAGE_CSS = `*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f6f8;color:#1B1B2F}
main{max-width:480px;margin:56px auto;padding:0 16px}.card{background:#fff;border:1px solid #e3e2ea;border-radius:12px;padding:24px}
.brand{font-size:13px;color:#5d5c72;margin-bottom:12px}h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px}.hint{font-size:13px;color:#5d5c72}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f0f0f4;padding:1px 4px;border-radius:4px;word-break:break-all}
.err{background:#fbeae9;color:#b3261e;border-radius:8px;padding:10px 12px;margin:0 0 14px}
a.btn{display:inline-block;background:#1B1B2F;color:#f6f6f8;border-radius:8px;padding:9px 16px;text-decoration:none;margin:4px 0 14px}
@media (prefers-color-scheme:dark){body{background:#141420;color:#ecebf3}.card{background:#1c1c2b;border-color:#31314a}.brand,.hint{color:#a8a7bb}code{background:#0f0f19}
.err{background:#3a1f1f;color:#ff8a80}a.btn{background:#C8E64C;color:#1B1B2F}}`;

const PAGE_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

function Shell(p: { title: string; children: unknown }) {
  return (
    <html lang="en">
      <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="referrer" content="no-referrer" /><title>{p.title} · SaveMyBudget Toolkit</title><style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} /></head>
      <body><main><div class="card"><div class="brand">SaveMyBudget Toolkit</div>{p.children}</div></main></body>
    </html>
  );
}

async function plainPage(c: Context, node: unknown, status: 200 | 400 | 403 | 503): Promise<Response> {
  const html = '<!doctype html>\n' + String(await (node as Promise<string> | string));
  return c.html(html, status, PAGE_HEADERS);
}

const startHref = (next: string) => `/auth/google/start${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`;

function SignInPage(p: { owner: string; next: string; error?: string | null }) {
  return (
    <Shell title="Sign in">
      <h1>Sign in</h1>
      {p.error ? <div class="err">{p.error}</div> : null}
      <p>Only {maskEmail(p.owner)} can sign in to this toolkit.</p>
      <a class="btn" href={startHref(p.next)}>Sign in with Google</a>
      <p class="hint">Add this redirect URI to your OAuth client: <code>{redirectUri()}</code></p>
    </Shell>
  );
}

function LockedPage(p: { missing: string[] }) {
  return (
    <Shell title="Sign-in isn't set up">
      <h1>Sign-in isn't set up</h1>
      <p>A Google OAuth client is configured, so this toolkit only opens for its owner.</p>
      {p.missing.map((m) => <p>Set <code>{m}</code> and restart.</p>)}
      <p class="hint">Collection, the tag and scheduled jobs keep running in the meantime. Setup steps: docs/owner-sign-in.md in the toolkit's repository.</p>
    </Shell>
  );
}

function WrongAccountPage(p: { owner: string; signedInAs: string | null; next: string }) {
  return (
    <Shell title="Wrong Google account">
      <h1>Wrong Google account</h1>
      {p.signedInAs !== null ? (
        <p>This toolkit belongs to {maskEmail(p.owner)}. You signed in as {p.signedInAs}.</p>
      ) : (
        <p>This isn't the Google account this toolkit was first signed in with, although the email address matches. If the owner's Google account was replaced, see "Changing the owner" in the sign-in docs.</p>
      )}
      <a class="btn" href={startHref(p.next)}>Sign in with a different Google account</a>
    </Shell>
  );
}

// ---------------------------------------------------------------- the gate

/**
 * Decides a UI request. Returns a Response to send instead of the page (locked page, sign-in redirect, 401), or
 * the session (null in open mode). `/auth/google/*` passes without a session; nothing else does.
 */
export async function ownerGate(c: Context<AppEnv>): Promise<Response | { session: OwnerSession | null }> {
  const mode = authMode();
  if (mode.kind === 'open') return { session: null };
  if (mode.kind === 'locked') return plainPage(c, <LockedPage missing={mode.missing} />, 503);
  const session = readSession(getCookie(c, SESSION_COOKIE));
  if (session || c.req.path.startsWith('/auth/google/')) return { session };
  const m = c.req.method;
  if ((m === 'GET' || m === 'HEAD') && !c.req.path.startsWith('/api/')) {
    const u = new URL(c.req.url);
    return c.redirect(`/auth/google/signin?next=${encodeURIComponent(safeNext(u.pathname + u.search))}`, 302);
  }
  return c.text('Sign in first.', 401, { 'cache-control': 'no-store' });
}

/** The owner's session for a request outside the UI (the MCP consent page), only in sign-in mode. */
export function ownerSessionOf(c: Context): OwnerSession | null {
  return authMode().kind === 'signin' ? readSession(getCookie(c, SESSION_COOKIE)) : null;
}

/** Sign-in pages are opened on the configured UI address, so the cookies and Google's redirect agree on the host. */
function canonical(c: Context): Response | null {
  const want = new URL(uiBase());
  const host = c.req.header('host') ?? '';
  if (normHost(host) === normHost(want.host)) return null;
  const u = new URL(c.req.url);
  return c.redirect(`${want.origin}${u.pathname}${u.search}`, 302);
}

const sessionCookie = (c: Context, value: string, maxAge: number) =>
  setCookie(c, SESSION_COOKIE, value, { path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge });

export function mountOwnerAuth(app: Hono<AppEnv>): void {
  const signinOnly = (c: Context) => (authMode().kind === 'signin' ? null : c.text('Not found', 404));

  app.get('/auth/google/signin', (c) => {
    const off = signinOnly(c) ?? canonical(c);
    if (off) return off;
    const next = safeNext(c.req.query('next'));
    if (readSession(getCookie(c, SESSION_COOKIE))) return c.redirect(next, 302);
    return plainPage(c, <SignInPage owner={config.ownerEmail} next={next} />, 200);
  });

  app.get('/auth/google/start', (c) => {
    const off = signinOnly(c) ?? canonical(c);
    if (off) return off;
    const s = startSignin(safeNext(c.req.query('next')));
    setCookie(c, SIGNIN_COOKIE, s.cookie, { path: '/auth/google', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600 });
    c.header('cache-control', 'no-store');
    return c.redirect(authorizationUrl({ clientId: config.googleClientId, redirectUri: redirectUri(), state: s.state, nonce: s.nonce, codeChallenge: s.codeChallenge }), 302);
  });

  app.get(CALLBACK_PATH, async (c) => {
    const off = signinOnly(c);
    if (off) return off;
    const cookie = getCookie(c, SIGNIN_COOKIE);
    deleteCookie(c, SIGNIN_COOKIE, { path: '/auth/google', secure: true });
    const check = consumeSignin(c.req.query('state') ?? '', cookie);
    if (!check.ok) {
      log(`owner sign-in refused: ${check.reason}`);
      return plainPage(c, <SignInPage owner={config.ownerEmail} next="/" error="This sign-in expired or was already used. Start again." />, 400);
    }
    const googleError = c.req.query('error');
    if (googleError !== undefined) {
      return plainPage(c, <SignInPage owner={config.ownerEmail} next={check.next} error={`Google sign-in didn't complete (${googleError.slice(0, 100)}).`} />, 400);
    }
    let claims: { sub: string; email: string };
    try {
      const idToken = await exchangeCode({ code: c.req.query('code') ?? '', codeVerifier: pkceVerifier(cookie!), redirectUri: redirectUri(), clientId: config.googleClientId, clientSecret: config.googleClientSecret });
      claims = await verifyIdToken(idToken, { clientId: config.googleClientId, nonce: oidcNonce(cookie!), nowMs: authNow() });
    } catch (err) {
      log(`owner sign-in refused: ${err instanceof GoogleSignInError ? err.reason : 'unexpected error'}`);
      return plainPage(c, <SignInPage owner={config.ownerEmail} next={check.next} error="Google's answer couldn't be verified, so you weren't signed in. Try again." />, 400);
    }
    const admitted = admitOwner(claims);
    if (admitted !== 'ok') {
      log(`owner sign-in refused: ${admitted}`);
      return plainPage(c, <WrongAccountPage owner={config.ownerEmail} signedInAs={admitted === 'wrong_email' ? claims.email : null} next={check.next} />, 403);
    }
    endSession(getCookie(c, SESSION_COOKIE)); // a new id at every sign-in
    const s = createSession();
    sessionCookie(c, s.id, s.maxAgeS);
    c.header('cache-control', 'no-store');
    return c.redirect(check.next, 302);
  });

  app.post('/auth/signout', (c) => {
    const off = signinOnly(c);
    if (off) return off;
    endSession(getCookie(c, SESSION_COOKIE));
    sessionCookie(c, '', 0);
    return c.redirect('/auth/google/signin', 303);
  });

  app.post('/auth/signout-everywhere', (c) => {
    const off = signinOnly(c);
    if (off) return off;
    endAllSessions();
    sessionCookie(c, '', 0);
    return c.redirect('/auth/google/signin', 303);
  });
}
