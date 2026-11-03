// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/** Owner sign-in: the open (no client), locked and sign-in modes, ID token checks, sessions, and the MCP consent page. */
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SMB_DATA_DIR = mkdtempSync(join(tmpdir(), 'toolkit-owner-'));
process.env.SMB_PUBLIC_URL = 'https://t.shop.test';
process.env.SMB_TELEMETRY = 'off';
for (const k of ['SMB_GOOGLE_CLIENT_ID', 'SMB_GOOGLE_CLIENT_SECRET', 'SMB_OWNER_EMAIL', 'SMB_SECRET_KEY', 'SMB_UI_URL', 'SMB_MCP_TOKEN']) delete process.env[k];

const H = await import('./owner-auth-helpers.js');
const { openMemoryDb, createSite, db } = await import('../src/db.js');
const { app } = await import('../src/app.js');
const { config, secretKeyBytes } = await import('../src/config.js');
const { CSRF_SECRET } = await import('../src/ui.js');
const { setGoogleFetch, verifyIdToken } = await import('../src/auth/google.js');
const { setAuthClock, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS, maskEmail, safeNext } = await import('../src/auth/owner.js');
const { hourlyTick } = await import('../src/jobs/index.js');
const { issueToken } = await import('../src/mcp/token.js');
const { resetMcpRateLimit } = await import('../src/mcp/index.js');
const { resetOAuthLimits } = await import('../src/mcp/oauth.js');

setGoogleFetch(H.fakeFetch);

const T0 = Date.parse('2026-11-02T10:00:00.000Z');
let now = T0;
setAuthClock(() => now);

const SITE_NAME = 'Quiet Lantern Shop';
const UI = 'http://localhost:8080';

function req(path: string, init: RequestInit & { host?: string; base?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set('host', init.host ?? 'localhost:8080');
  return app.fetch(new Request((init.base ?? UI) + path, { ...init, headers, redirect: 'manual' }), { incoming: { socket: { remoteAddress: '203.0.113.20' } } } as any) as Promise<Response>;
}
const withCookie = (cookie: string, extra: Record<string, string> = {}) => ({ headers: { cookie, ...extra } });

function signinMode() {
  config.googleClientId = H.CLIENT_ID;
  config.googleClientSecret = H.CLIENT_SECRET;
  config.ownerEmail = H.OWNER;
  config.secretKey = '';
  config.uiUrl = '';
}
function openMode() {
  config.googleClientId = '';
  config.googleClientSecret = '';
  config.ownerEmail = '';
  config.secretKey = '';
  config.uiUrl = '';
}

/** Start a sign-in like a browser: returns the state, nonce, PKCE challenge and pre-sign-in cookie. */
async function start(next?: string) {
  const r = await req(`/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  assert.equal(r.status, 302);
  const g = new URL(r.headers.get('location')!);
  assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  return {
    url: g,
    state: g.searchParams.get('state')!,
    nonce: g.searchParams.get('nonce')!,
    challenge: g.searchParams.get('code_challenge')!,
    cookie: H.cookieValue(r, 'smb_signin')!,
    setCookie: H.setCookies(r).find((c) => c.startsWith('smb_signin='))!,
  };
}
async function callback(s: { state: string; cookie: string | null }, code: string, extra = '') {
  return req(`/auth/google/callback?state=${encodeURIComponent(s.state)}&code=${encodeURIComponent(code)}${extra}`, s.cookie ? withCookie(`smb_signin=${s.cookie}`) : {});
}
/** The whole round trip, with Google answering with these claims (or this ID token). */
async function signIn(over: Record<string, unknown> = {}, opts: { idToken?: (nonce: string) => string; next?: string } = {}) {
  const s = await start(opts.next);
  const code = H.b64url(randomBytes(12));
  H.pending.set(code, { challenge: s.challenge, ...(opts.idToken ? { idToken: opts.idToken(s.nonce) } : { claims: H.goodClaims(s.nonce, now, over) }) });
  const r = await callback(s, code);
  const session = H.cookieValue(r, '__Host-smb_session');
  return { r, session, s, code };
}
async function signedIn(): Promise<string> {
  const { r, session } = await signIn();
  assert.equal(r.status, 302, await r.clone().text());
  assert.ok(session);
  return session;
}
/** The session's form token, as the page hands it out. */
async function csrfOf(session: string): Promise<string> {
  const r = await req('/settings', withCookie(`__Host-smb_session=${session}`));
  assert.equal(r.status, 200);
  return /<meta name="csrf-token" content="([^"]+)"/.exec(await r.text())![1];
}
const post = (path: string, session: string, token: string | null, extra: Record<string, string> = {}) =>
  req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `__Host-smb_session=${session}${token ? `; smb_csrf=${token}` : ''}`, origin: UI, ...extra },
    body: new URLSearchParams(token ? { _csrf: token } : {}).toString(),
  });
const isSigninRedirect = (r: Response) => r.status === 302 && new URL(r.headers.get('location')!, UI).pathname === '/auth/google/signin';

before(() => {
  openMemoryDb();
  createSite({ name: SITE_NAME, host: 'quietlantern.test', key: 'sk_quietlantern_00000001', consent_mode: 'legitimate_interest', target_countries: [] });
});
afterEach(() => { now = T0; });

// ----------------------------------------------------------------

describe('no OAuth client — the 1.x loopback mode', () => {
  beforeEach(openMode);

  it('serves the UI without sign-in, shows the banner, and keeps the 1.x flows', async () => {
    const r = await req('/sites');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Anyone who can reach this port can use the toolkit\. <a href="\/docs\/owner-sign-in">Add Google sign-in to lock it to you\.<\/a>/);
    assert.ok(html.includes(SITE_NAME));
    assert.ok(!html.includes('Signed in as'));
    // add a site with the per-process form token, as in 1.x
    const add = await req('/api/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `smb_csrf=${CSRF_SECRET}`, origin: 'http://127.0.0.1:8080' },
      body: new URLSearchParams({ _csrf: CSRF_SECRET, name: 'Second', host: 'second-shop.test' }).toString(),
      host: '127.0.0.1:8080', base: 'http://127.0.0.1:8080',
    });
    assert.equal(add.status, 303);
    const id = Number(/\/sites\/(\d+)/.exec(add.headers.get('location')!)![1]);
    for (const p of [`/sites/${id}/install`, `/sites/${id}`, `/sites/${id}/analyse`, `/sites/${id}/uploads`, '/settings', '/setup']) {
      assert.equal((await req(p)).status, 200, p);
    }
  });

  it('answers 404 on every sign-in route', async () => {
    for (const p of ['/auth/google/signin', '/auth/google/start', '/auth/google/callback?state=x&code=y']) assert.equal((await req(p)).status, 404, p);
    for (const p of ['/auth/signout', '/auth/signout-everywhere']) {
      const r = await req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `smb_csrf=${CSRF_SECRET}`, origin: UI }, body: `_csrf=${CSRF_SECRET}` });
      assert.equal(r.status, 404, p);
    }
  });

  it('the first-run page lists the sign-in settings by name only', async () => {
    config.secretKey = randomBytes(32).toString('base64');
    const html = await (await req('/setup')).text();
    assert.match(html, /0\. Sign-in and Google Ads/);
    assert.match(html, /— Google OAuth client · set <code>SMB_GOOGLE_CLIENT_ID and SMB_GOOGLE_CLIENT_SECRET<\/code>/);
    assert.match(html, /— Owner email · set <code>SMB_OWNER_EMAIL<\/code>/);
    assert.match(html, /✓ Secret key/);
    assert.ok(!html.includes(config.secretKey));
  });
});

// ----------------------------------------------------------------

describe('client set, owner email missing — locked page only', () => {
  beforeEach(() => { signinMode(); config.ownerEmail = ''; });

  it('serves only the locked page, for every UI path and method', async () => {
    for (const p of ['/', '/sites', '/settings', '/setup', '/docs/getting-started', '/auth/google/signin', '/auth/google/start', '/sites/1']) {
      const r = await req(p);
      assert.equal(r.status, 503, p);
      const html = await r.text();
      assert.match(html, /Set <code>SMB_OWNER_EMAIL<\/code> and restart\./, p);
      assert.ok(!html.includes(SITE_NAME) && !html.includes('quietlantern'), p);
    }
    const r = await req('/api/sites', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: UI }, body: 'name=x&host=x.test' });
    assert.equal(r.status, 503);
  });

  it('a missing client secret locks too, never falling back to the open mode', async () => {
    config.ownerEmail = H.OWNER;
    config.googleClientSecret = '';
    const html = await (await req('/sites')).text();
    assert.match(html, /Set <code>SMB_GOOGLE_CLIENT_SECRET<\/code> and restart\./);
  });

  it('collection, health and jobs keep running', async () => {
    assert.equal((await req('/healthz')).status, 200);
    assert.equal((await req('/collect/healthz')).status, 200);
    assert.equal((await req('/sdk/v1/smb.js')).status, 200);
    db().prepare('INSERT INTO owner_signin_states(id_hash, expires_at) VALUES(?, ?)').run('stale', 1);
    hourlyTick(new Date(T0));
    assert.equal(db().prepare("SELECT COUNT(*) AS n FROM owner_signin_states WHERE id_hash = 'stale'").get()!.n, 0);
  });
});

// ----------------------------------------------------------------

describe('sign-in checks', () => {
  beforeEach(() => { signinMode(); db().prepare('DELETE FROM owner').run(); db().prepare('DELETE FROM owner_sessions').run(); });

  it('without a session every page redirects to the sign-in page, which shows no instance data', async () => {
    const r = await req('/sites/1?range=7d');
    assert.ok(isSigninRedirect(r));
    assert.equal(new URL(r.headers.get('location')!, UI).searchParams.get('next'), '/sites/1?range=7d');
    const page = await req(r.headers.get('location')!);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Only o•••@example\.com can sign in to this toolkit\./);
    assert.match(html, /Sign in with Google/);
    assert.ok(html.includes('Add this redirect URI to your OAuth client: <code>http://localhost:8080/auth/google/callback</code>'));
    assert.ok(!html.includes(SITE_NAME) && !html.includes(H.OWNER));
  });

  it('asks Google for openid email only, the account chooser, PKCE S256, a nonce, and no offline access', async () => {
    const s = await start();
    const q = s.url.searchParams;
    assert.equal(q.get('scope'), 'openid email');
    assert.equal(q.get('prompt'), 'select_account');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('redirect_uri'), 'http://localhost:8080/auth/google/callback');
    assert.equal(q.get('client_id'), H.CLIENT_ID);
    assert.equal(q.get('access_type'), null);
    assert.ok(q.get('nonce') && q.get('state'));
    assert.match(s.setCookie, /; Path=\/auth\/google; HttpOnly; Secure; SameSite=Lax/);
    // neither the PKCE verifier nor the cookie value travels in the URL
    assert.ok(!s.url.toString().includes(s.cookie));
  });

  it('opens the sign-in on the configured address, never on the one the request named', async () => {
    const r = await req('/auth/google/signin?next=/settings', { host: '127.0.0.1:8080', base: 'http://127.0.0.1:8080' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), 'http://localhost:8080/auth/google/signin?next=/settings');
    config.uiUrl = 'https://ui.example.com';
    const s = await req('/auth/google/start', { host: 'ui.example.com', base: 'https://ui.example.com' });
    assert.equal(new URL(s.headers.get('location')!).searchParams.get('redirect_uri'), 'https://ui.example.com/auth/google/callback');
  });

  it('the owner signs in, the account is pinned, and the page opens', async () => {
    const { r, session } = await signIn({}, { next: '/settings' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/settings');
    assert.ok(session);
    assert.equal(db().prepare('SELECT sub FROM owner').get()!.sub, '110000000000000000001');
    const page = await req('/settings', withCookie(`__Host-smb_session=${session}`));
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(`Signed in as ${H.OWNER}`));
    assert.ok(html.includes('Sign out everywhere'));
    assert.ok(!html.includes('Anyone who can reach this port'));
  });

  it('accepts the email in any case', async () => {
    const { r } = await signIn({ email: 'Owner@Example.COM' });
    assert.equal(r.status, 302);
  });

  const refused = async (r: Response, session: string | null, status = 400) => {
    assert.equal(r.status, status, await r.clone().text());
    assert.equal(session, null);
    const html = await r.text();
    assert.ok(!html.includes(SITE_NAME), 'no instance data');
    return html;
  };

  it('refuses a different Google account, naming the owner only masked', async () => {
    const { r, session } = await signIn({ email: 'someone@example.net', sub: '2' });
    const html = await refused(r, session, 403);
    assert.ok(html.includes('This toolkit belongs to o•••@example.com. You signed in as someone@example.net.'));
    assert.ok(html.includes('Sign in with a different Google account'));
    assert.equal(db().prepare('SELECT sub FROM owner').get()?.sub ?? null, null, 'nothing pinned');
  });

  it('refuses email_verified false, missing, or the string "true"', async () => {
    for (const v of [false, undefined, 'true']) {
      const { r, session } = await signIn({ email_verified: v });
      await refused(r, session);
    }
  });

  it('refuses the wrong audience, issuer, an expired token, a future token and a nonce mismatch', async () => {
    const cases: Record<string, unknown>[] = [
      { aud: 'someone-else.apps.googleusercontent.com' },
      { aud: ['someone-else', H.CLIENT_ID], azp: 'someone-else' },
      { iss: 'https://accounts.example.com' },
      { exp: Math.floor(now / 1000) - 120 },
      { iat: Math.floor(now / 1000) + 3600 },
      { nonce: 'not-the-nonce' },
      { sub: '' },
    ];
    for (const over of cases) {
      const { r, session } = await signIn(over);
      await refused(r, session);
    }
  });

  it('refuses a token signed with another key, an unknown key id, or another algorithm', async () => {
    const tokens = [
      (n: string) => H.signJwt(H.goodClaims(n, now), { key: H.OTHER_KEY.privateKey }),
      (n: string) => H.signJwt(H.goodClaims(n, now), { kid: 'unknown-kid' }),
      (n: string) => H.signJwt(H.goodClaims(n, now), { alg: 'HS256' }),
      (n: string) => `${H.b64url('{"alg":"none"}')}.${H.b64url(JSON.stringify(H.goodClaims(n, now)))}.`,
    ];
    for (const t of tokens) {
      const { r, session } = await signIn({}, { idToken: t });
      await refused(r, session);
    }
  });

  it('refuses a second Google account with the owner email once the first one is pinned', async () => {
    await signedIn();
    const { r, session } = await signIn({ sub: '999' });
    const html = await refused(r, session, 403);
    assert.match(html, /isn&#39;t the Google account this toolkit was first signed in with/);
  });

  it('refuses a replayed state, a missing or foreign pre-sign-in cookie, a tampered state and an expired one', async () => {
    // replay: the same state and cookie a second time
    const first = await signIn();
    assert.equal(first.r.status, 302);
    const code2 = 'replay-code';
    H.pending.set(code2, { challenge: first.s.challenge, claims: H.goodClaims(first.s.nonce, now) });
    await refused(await callback(first.s, code2), null);

    // no cookie
    const a = await start();
    H.pending.set('c-a', { challenge: a.challenge, claims: H.goodClaims(a.nonce, now) });
    const noCookie = await callback({ state: a.state, cookie: null }, 'c-a');
    await refused(noCookie, H.cookieValue(noCookie, '__Host-smb_session'));

    // another browser's cookie
    const b = await start();
    const c = await start();
    H.pending.set('c-b', { challenge: b.challenge, claims: H.goodClaims(b.nonce, now) });
    const foreign = await callback({ state: b.state, cookie: c.cookie }, 'c-b');
    await refused(foreign, H.cookieValue(foreign, '__Host-smb_session'));

    // tampered payload
    const d = await start('/settings');
    const [v, payload, mac] = d.state.split('.');
    const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), n: '/api/export' })).toString('base64url');
    H.pending.set('c-d', { challenge: d.challenge, claims: H.goodClaims(d.nonce, now) });
    const tampered = await callback({ state: `${v}.${evil}.${mac}`, cookie: d.cookie }, 'c-d');
    await refused(tampered, H.cookieValue(tampered, '__Host-smb_session'));

    // older than 10 minutes
    const e = await start();
    now += 10 * 60_000 + 1;
    H.pending.set('c-e', { challenge: e.challenge, claims: H.goodClaims(e.nonce, now) });
    const late = await callback(e, 'c-e');
    await refused(late, H.cookieValue(late, '__Host-smb_session'));
  });

  it('refuses a code from another sign-in (PKCE mismatch)', async () => {
    const victim = await start();
    const attacker = await start();
    H.pending.set('victim-code', { challenge: victim.challenge, claims: H.goodClaims(victim.nonce, now) });
    const r = await callback(attacker, 'victim-code');
    await refused(r, H.cookieValue(r, '__Host-smb_session'));
  });

  it("renders Google's error escaped and never redirects on it", async () => {
    const s = await start();
    const r = await req(`/auth/google/callback?state=${encodeURIComponent(s.state)}&error=${encodeURIComponent('<script>alert(1)</script>')}`, withCookie(`smb_signin=${s.cookie}`));
    const html = await refused(r, H.cookieValue(r, '__Host-smb_session'));
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.equal(r.headers.get('location'), null);
  });

  it('a failed token exchange signs nobody in', async () => {
    const s = await start();
    H.pending.set('c-500', { challenge: s.challenge, status: 500 });
    const r = await callback(s, 'c-500');
    await refused(r, H.cookieValue(r, '__Host-smb_session'));
  });

  it('the return path stays on this site', () => {
    for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', '/auth/google/start', '']) assert.equal(safeNext(bad), '/', bad);
    assert.equal(safeNext('/sites/3?range=30d'), '/sites/3?range=30d');
    assert.equal(maskEmail('owner@example.com'), 'o•••@example.com');
  });
});

describe('ID token verification, unit', () => {
  it('caches Google’s keys and refetches for an unknown key id at most once a minute', async () => {
    H.calls.length = 0;
    setGoogleFetch(H.fakeFetch); // also empties the key cache
    const t = Date.parse('2026-11-02T12:00:00.000Z');
    for (let i = 0; i < 3; i++) await verifyIdToken(H.signJwt(H.goodClaims('n', t)), { clientId: H.CLIENT_ID, nonce: 'n', nowMs: t });
    assert.equal(H.calls.filter((u) => u.endsWith('/certs')).length, 1);
    await assert.rejects(verifyIdToken(H.signJwt(H.goodClaims('n', t), { kid: 'rotated' }), { clientId: H.CLIENT_ID, nonce: 'n', nowMs: t + 61_000 }), /unknown key/);
    await assert.rejects(verifyIdToken(H.signJwt(H.goodClaims('n', t), { kid: 'rotated' }), { clientId: H.CLIENT_ID, nonce: 'n', nowMs: t + 62_000 }), /unknown key/);
    assert.equal(H.calls.filter((u) => u.endsWith('/certs')).length, 2);
    await verifyIdToken(H.signJwt(H.goodClaims('n', t + 2 * 3600e3)), { clientId: H.CLIENT_ID, nonce: 'n', nowMs: t + 2 * 3600e3 });
    assert.equal(H.calls.filter((u) => u.endsWith('/certs')).length, 3, 'refetched after max-age');
  });

  it('SMB_SECRET_KEY must be base64 of exactly 32 bytes', () => {
    assert.equal(secretKeyBytes(''), null);
    assert.equal(secretKeyBytes(randomBytes(32).toString('base64'))!.length, 32);
    for (const bad of [randomBytes(16).toString('base64'), randomBytes(33).toString('base64'), 'not base64 at all!']) assert.throws(() => secretKeyBytes(bad), /exactly 32/);
  });
});

// ----------------------------------------------------------------

describe('sessions', () => {
  beforeEach(() => { signinMode(); db().prepare('DELETE FROM owner').run(); db().prepare('DELETE FROM owner_sessions').run(); });

  it('sets __Host-smb_session HttpOnly, Secure, SameSite=Lax, Path=/ over http://localhost, and stores only its hash', async () => {
    const { r, session } = await signIn();
    const c = H.setCookies(r).find((x) => x.startsWith('__Host-smb_session='))!;
    assert.match(c, /^__Host-smb_session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    assert.ok(!/Domain=/i.test(c));
    const rows = db().prepare('SELECT id_hash FROM owner_sessions').all() as { id_hash: string }[];
    assert.deepEqual(rows.map((x) => x.id_hash), [createHash('sha256').update(session!).digest('hex')]);
    assert.ok(!JSON.stringify(db().prepare('SELECT * FROM owner').all()).includes(H.OWNER), 'no email stored');
  });

  it('ends after 7 days idle', async () => {
    const s = await signedIn();
    now += SESSION_IDLE_MS - 60_000;
    assert.equal((await req('/sites', withCookie(`__Host-smb_session=${s}`))).status, 200, 'still valid; this use counts');
    now += SESSION_IDLE_MS - 60_000;
    assert.equal((await req('/sites', withCookie(`__Host-smb_session=${s}`))).status, 200);
    now += SESSION_IDLE_MS + 1;
    assert.ok(isSigninRedirect(await req('/sites', withCookie(`__Host-smb_session=${s}`))));
  });

  it('ends after 30 days however often it is used', async () => {
    const s = await signedIn();
    for (let d = 6; d < 30; d += 6) {
      now = T0 + d * 86400e3;
      assert.equal((await req('/sites', withCookie(`__Host-smb_session=${s}`))).status, 200, `day ${d}`);
    }
    now = T0 + SESSION_ABSOLUTE_MS;
    assert.ok(isSigninRedirect(await req('/sites', withCookie(`__Host-smb_session=${s}`))));
  });

  it('a new sign-in gets a new id and ends the one the browser had', async () => {
    const a = await signedIn();
    const s = await start();
    H.pending.set('again', { challenge: s.challenge, claims: H.goodClaims(s.nonce, now) });
    const r = await req(`/auth/google/callback?state=${encodeURIComponent(s.state)}&code=again`, withCookie(`smb_signin=${s.cookie}; __Host-smb_session=${a}`));
    const b = H.cookieValue(r, '__Host-smb_session');
    assert.ok(b && b !== a);
    assert.ok(isSigninRedirect(await req('/sites', withCookie(`__Host-smb_session=${a}`))));
    assert.equal((await req('/sites', withCookie(`__Host-smb_session=${b}`))).status, 200);
  });

  it('Sign out ends this session only, and needs the session form token', async () => {
    const a = await signedIn();
    const b = await signedIn();
    assert.equal((await post('/auth/signout', a, null)).status, 403, 'no form token');
    assert.equal((await post('/auth/signout', a, await csrfOf(b))).status, 403, "another session's token");
    const out = await post('/auth/signout', a, await csrfOf(a));
    assert.equal(out.status, 303);
    assert.match(H.setCookies(out).find((x) => x.startsWith('__Host-smb_session='))!, /^__Host-smb_session=; Max-Age=0; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    assert.ok(isSigninRedirect(await req('/sites', withCookie(`__Host-smb_session=${a}`))));
    assert.equal((await req('/sites', withCookie(`__Host-smb_session=${b}`))).status, 200);
  });

  it('Sign out everywhere ends every session', async () => {
    const a = await signedIn();
    const b = await signedIn();
    assert.equal((await post('/auth/signout-everywhere', a, await csrfOf(a))).status, 303);
    for (const s of [a, b]) assert.ok(isSigninRedirect(await req('/sites', withCookie(`__Host-smb_session=${s}`))));
  });

  it('changing the owner email ends every session and clears the pinned account', async () => {
    const a = await signedIn();
    config.ownerEmail = 'new-owner@example.com';
    assert.ok(isSigninRedirect(await req('/sites', withCookie(`__Host-smb_session=${a}`))));
    assert.equal(db().prepare('SELECT sub FROM owner').get()!.sub, null);
    config.ownerEmail = H.OWNER;
    assert.ok(isSigninRedirect(await req('/sites', withCookie(`__Host-smb_session=${a}`))), 'switching back does not revive it');
  });

  it('rotating the secret key ends every session', async () => {
    config.secretKey = randomBytes(32).toString('base64');
    const a = await signedIn();
    assert.equal((await req('/sites', withCookie(`__Host-smb_session=${a}`))).status, 200);
    config.secretKey = randomBytes(32).toString('base64');
    assert.ok(isSigninRedirect(await req('/sites', withCookie(`__Host-smb_session=${a}`))));
  });

  it('state-changing requests need the session form token, the matching cookie and our Origin', async () => {
    const a = await signedIn();
    const t = await csrfOf(a);
    assert.notEqual(t, CSRF_SECRET);
    const add = (token: string | null, extra: Record<string, string> = {}) => req('/api/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `__Host-smb_session=${a}${token ? `; smb_csrf=${token}` : ''}`, origin: UI, ...extra },
      body: new URLSearchParams({ ...(token ? { _csrf: token } : {}), name: 'Third', host: 'third-shop.test' }).toString(),
    });
    assert.equal((await add(CSRF_SECRET)).status, 403, 'the open-mode token does not work');
    assert.equal((await add(t, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await add(t)).status, 303);
  });

  it('the UI never accepts a bearer token, and requests without a session get no content', async () => {
    const r = await req('/settings', { headers: { authorization: `Bearer ${issueToken()}` } });
    assert.ok(isSigninRedirect(r));
    const api = await req('/api/export');
    assert.equal(api.status, 401);
    assert.equal(await api.text(), 'Sign in first.');
  });
});

// ---------------------------------------------------------------- MCP coexistence

describe('MCP consent page with an owner session', () => {
  const ORIGIN = 'https://t.shop.test';
  const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
  let TOKEN = '';
  let clientId = '';
  const raw = (path: string, init: RequestInit = {}) => req(path, { ...init, host: 't.shop.test', base: ORIGIN });

  before(async () => {
    signinMode();
    resetMcpRateLimit(1_000_000);
    resetOAuthLimits();
    TOKEN = issueToken();
  });
  beforeEach(() => { signinMode(); config.uiUrl = ORIGIN; });

  async function register() {
    const r = await raw('/mcp/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) });
    return ((await r.json()) as { client_id: string }).client_id;
  }
  const query = (id: string) => new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: REDIRECT, code_challenge: H.b64url(randomBytes(32)), code_challenge_method: 'S256', state: 'st', resource: `${ORIGIN}/mcp` });
  async function open(qs: URLSearchParams, cookie = '') {
    const r = await raw(`/mcp/oauth/authorize?${qs}`, cookie ? withCookie(cookie) : {});
    const html = await r.text();
    const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));
    return { html, fields, nonce: H.cookieValue(r, 'smb_oauth')! };
  }
  const submit = (fields: Record<string, string>, cookie: string) =>
    raw('/mcp/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ ...fields, decision: 'allow' }).toString() });

  /** Sign the owner in on the UI address, which here is the same host as the consent page. */
  async function ownerSession() {
    const r = await raw('/auth/google/start');
    const g = new URL(r.headers.get('location')!);
    const cookie = H.cookieValue(r, 'smb_signin')!;
    H.pending.set('mcp-code', { challenge: g.searchParams.get('code_challenge')!, claims: H.goodClaims(g.searchParams.get('nonce')!, now) });
    const cb = await raw(`/auth/google/callback?state=${encodeURIComponent(g.searchParams.get('state')!)}&code=mcp-code`, withCookie(`smb_signin=${cookie}`));
    return H.cookieValue(cb, '__Host-smb_session')!;
  }

  it('without a session it asks for the token and offers Google sign-in', async () => {
    clientId ||= await register();
    const p = await open(query(clientId));
    assert.match(p.html, /name="token"/);
    assert.match(p.html, /sign in with Google<\/a> as the owner/);
    assert.ok(!('via' in p.fields));
  });

  it('with the owner signed in, Connect needs no token but still needs the click', async () => {
    clientId ||= await register();
    const s = await ownerSession();
    assert.ok(s);
    const p = await open(query(clientId), `__Host-smb_session=${s}`);
    assert.ok(p.html.includes(`Signed in as ${H.OWNER}`));
    assert.ok(!/name="token"/.test(p.html));
    assert.equal(p.fields.via, 'owner');
    const ok = await submit(p.fields, `smb_oauth=${p.nonce}; __Host-smb_session=${s}`);
    assert.equal(ok.status, 302);
    assert.ok(new URL(ok.headers.get('location')!).searchParams.get('code'));

    // the session's form token is required, and the session must still be valid
    const p2 = await open(query(clientId), `__Host-smb_session=${s}`);
    assert.equal((await submit({ ...p2.fields, _csrf: 'wrong' }, `smb_oauth=${p2.nonce}; __Host-smb_session=${s}`)).status, 401);
    assert.equal((await submit(p2.fields, `smb_oauth=${p2.nonce}`)).status, 401, 'no session cookie');
    // Cancel still returns access_denied without a code
    const deny = await raw('/mcp/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `smb_oauth=${p2.nonce}; __Host-smb_session=${s}` }, body: new URLSearchParams({ ...p2.fields, decision: 'deny' }).toString() });
    assert.equal(new URL(deny.headers.get('location')!).searchParams.get('error'), 'access_denied');
  });

  it('in the open mode a session cookie means nothing to the consent page', async () => {
    clientId ||= await register();
    const s = await ownerSession();
    openMode();
    config.uiUrl = ORIGIN;
    const p = await open(query(clientId), `__Host-smb_session=${s}`);
    assert.match(p.html, /name="token"/);
    assert.ok(!p.html.includes('sign in with Google'));
    assert.equal((await submit({ ...p.fields, via: 'owner', _csrf: 'x' }, `smb_oauth=${p.nonce}; __Host-smb_session=${s}`)).status, 401);
  });

  it('/mcp never takes the session cookie', async () => {
    const s = await ownerSession();
    const call = (headers: Record<string, string>) => raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal((await call({ cookie: `__Host-smb_session=${s}` })).status, 401);
    assert.equal((await call({ cookie: `__Host-smb_session=${s}`, authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await call({ authorization: `Bearer ${TOKEN}` })).status, 200);
  });
});
