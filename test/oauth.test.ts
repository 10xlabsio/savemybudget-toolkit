// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SMB_DATA_DIR = mkdtempSync(join(tmpdir(), 'smb-oauth-'));
process.env.SMB_PUBLIC_URL = 'https://t.shop.test';
process.env.SMB_TELEMETRY = 'off';
delete process.env.SMB_MCP_TOKEN;

const { openMemoryDb, createSite, setSetting, db } = await import('../src/db.js');
const { app } = await import('../src/app.js');
const { CSRF_SECRET } = await import('../src/ui.js');
const { issueToken, revokeToken } = await import('../src/mcp/token.js');
const { resetMcpRateLimit } = await import('../src/mcp/index.js');
const { resetOAuthLimits, sweepOAuth, redirectMatches, redirectUriAllowed, cleanName, syncInstanceToken } = await import('../src/mcp/oauth.js');

const BASE = 'http://127.0.0.1:8080';
const ORIGIN = 'https://t.shop.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function raw(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('host', '127.0.0.1:8080');
  return app.fetch(new Request(BASE + path, { ...init, headers, redirect: 'manual' }), { incoming: { socket: { remoteAddress: '203.0.113.60' } } } as any) as Promise<Response>;
}
const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const json = (o: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
async function mcp(bearer: string | null, method = 'tools/list') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return raw('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) });
}
async function register(o: Record<string, unknown> = {}) {
  const r = await raw('/mcp/oauth/register', json({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...o }));
  return { status: r.status, body: await r.json() as any };
}
function authorizeQuery(clientId: string, challenge: string, over: Record<string, string> = {}) {
  return new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', scope: 'toolkit', resource: `${ORIGIN}/mcp`, ...over });
}
/** Load the consent page as a browser would: returns its hidden fields and the nonce cookie. */
async function openConsent(qs: URLSearchParams) {
  const r = await raw(`/mcp/oauth/authorize?${qs}`);
  const html = await r.text();
  const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  return { status: r.status, html, fields, cookie, headers: r.headers };
}
const submit = (fields: Record<string, string>, cookie: string, extra: Record<string, string>) =>
  raw('/mcp/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ ...fields, ...extra }).toString() });

/** The whole browser leg: consent page → paste token → code. */
async function signIn(clientId: string, token: string, redirect = REDIRECT) {
  const { verifier, challenge } = pkce();
  const page = await openConsent(authorizeQuery(clientId, challenge, { redirect_uri: redirect }));
  assert.equal(page.status, 200, page.html);
  const r = await submit(page.fields, page.cookie, { token, decision: 'allow' });
  assert.equal(r.status, 302, await r.clone().text());
  const loc = new URL(r.headers.get('location')!);
  return { code: loc.searchParams.get('code')!, verifier, loc };
}
async function exchange(o: Record<string, string>) {
  const r = await raw('/mcp/oauth/token', form(o));
  return { status: r.status, body: await r.json() as any };
}

describe('oauth sign-in', () => {
  let TOKEN = '';
  let clientId = '';

  before(() => {
    openMemoryDb();
    createSite({ name: 'Shop', host: 'shop.test', key: 'sk_shoptest_0000oauth', consent_mode: 'legitimate_interest', target_countries: [] });
    resetMcpRateLimit(1_000_000);
  });

  it('an oauth_codes table from before the family column gets the column', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const old = new DatabaseSync(':memory:');
    old.exec('CREATE TABLE oauth_clients (id TEXT PRIMARY KEY); CREATE TABLE oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT, redirect_uri TEXT, code_challenge TEXT, resource TEXT, token_fp TEXT, expires_at TEXT, used_at TEXT)');
    const { migrateForTest } = await import('../src/db.js');
    migrateForTest(old);
    assert.ok((old.prepare('PRAGMA table_info(oauth_codes)').all() as { name: string }[]).some((c) => c.name === 'family'));
  });

  it('everything is a 404 while AI assistants are off', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/mcp/oauth/authorize?client_id=x']) {
      assert.equal((await raw(p)).status, 404, p);
    }
    assert.equal((await raw('/mcp/oauth/register', json({}))).status, 404);
    assert.equal((await raw('/mcp/oauth/token', form({}))).status, 404);
  });

  it('serves discovery metadata built from the public URL, and the 401 points at it', async () => {
    TOKEN = issueToken();
    syncInstanceToken();
    const prm = await (await raw('/.well-known/oauth-protected-resource')).json() as any;
    assert.equal(prm.resource, `${ORIGIN}/mcp`);
    assert.deepEqual(prm.authorization_servers, [ORIGIN]);
    const prm2 = await (await raw('/.well-known/oauth-protected-resource/mcp')).json() as any;
    assert.deepEqual(prm2, prm);
    const as = await (await raw('/.well-known/oauth-authorization-server')).json() as any;
    assert.equal(as.issuer, ORIGIN);
    assert.equal(as.authorization_endpoint, `${ORIGIN}/mcp/oauth/authorize`);
    assert.equal(as.token_endpoint, `${ORIGIN}/mcp/oauth/token`);
    assert.equal(as.registration_endpoint, `${ORIGIN}/mcp/oauth/register`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    const r = await mcp(null);
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), `Bearer realm="savemybudget-toolkit", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
    assert.match((await mcp('smbt_at_nope')).headers.get('www-authenticate') ?? '', /error="invalid_token"/);
    assert.equal((await raw('/.well-known/acme-challenge/x')).status, 404, 'other well-known paths untouched');
    assert.equal((await raw('/.well-known/openid-configuration')).status, 404, 'not an OpenID provider');
  });

  it('without a public URL there is no sign-in, only the token', async () => {
    setSetting('public_url', '');
    const was = process.env.SMB_PUBLIC_URL;
    const { config } = await import('../src/config.js');
    const cfg = config.publicUrl;
    (config as any).publicUrl = '';
    try {
      assert.equal((await raw('/.well-known/oauth-protected-resource')).status, 404);
      assert.equal((await mcp(null)).headers.get('www-authenticate'), 'Bearer realm="savemybudget-toolkit"');
      assert.equal((await mcp(TOKEN)).status, 200);
    } finally { (config as any).publicUrl = cfg; process.env.SMB_PUBLIC_URL = was; }
  });

  it('registers clients, refusing unsafe redirect URIs', async () => {
    const ok = await register();
    assert.equal(ok.status, 201);
    assert.match(ok.body.client_id, /^mcpc_/);
    assert.equal(ok.body.client_secret, undefined);
    clientId = ok.body.client_id;
    for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'https://x.test/cb#frag', 'not a url']) {
      assert.equal((await register({ redirect_uris: [bad] })).status, 400, bad);
    }
    assert.equal((await register({ grant_types: ['client_credentials'] })).status, 400);
    assert.equal((await register({ grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'] })).status, 201, 'extra grant types are ignored');
    for (const launch of ['microsoft-edge:https://evil.example/cb', 'googlechromes://evil.example/cb', 'x-safari-https://evil.example/cb', 'intent://evil.example/#Intent;end']) {
      assert.equal(redirectUriAllowed(launch), false, launch);
    }
    assert.equal(cleanName('Cl\u202Eeduala\u200B  Code'), 'Cleduala Code', 'bidi and zero-width characters dropped');
    assert.equal(cleanName('   '), 'An AI assistant');
    const big = await raw('/mcp/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], pad: 'x'.repeat(100_000) }) });
    assert.equal(big.status, 413, 'bodies are capped');
    assert.equal(redirectUriAllowed('http://127.0.0.1:3118/callback'), true);
    assert.equal(redirectUriAllowed('cursor://anysphere.cursor-mcp/oauth/callback'), true);
    assert.equal(redirectMatches(['http://localhost:3000/callback'], 'http://localhost:61234/callback'), true, 'loopback: any port');
    assert.equal(redirectMatches(['http://localhost:3000/callback'], 'http://localhost:61234/other'), false);
    assert.equal(redirectMatches(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai:444/api/mcp/auth_callback'), false);
  });

  it('the consent page names the app and where it returns, and refuses bad requests without redirecting', async () => {
    const { challenge } = pkce();
    const r = await openConsent(authorizeQuery(clientId, challenge));
    assert.equal(r.status, 200);
    assert.match(r.html, /Connect “Claude”\?/);
    assert.match(r.html, /<b>claude\.ai<\/b>/);
    assert.ok(!r.html.includes('class="warn"'), 'no warning for claude.ai');
    assert.match(r.html, /type="password"/);
    assert.match(r.html, /<style>\*\{box-sizing/, 'CSS is not HTML-escaped');
    assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.headers.get('set-cookie') ?? '', /smb_oauth=.*Path=\/mcp\/oauth.*HttpOnly.*SameSite=Strict/i);
    // every bad request is a page — never a redirect, even to a registered address
    for (const qs of [
      authorizeQuery('mcpc_unknownclient000', challenge),
      authorizeQuery(clientId, challenge, { redirect_uri: 'https://evil.example/cb' }),
      authorizeQuery(clientId, 'short'),
      authorizeQuery(clientId, challenge, { response_type: 'token' }),
      authorizeQuery(clientId, challenge, { resource: 'https://other.example/mcp' }),
    ]) {
      const bad = await raw(`/mcp/oauth/authorize?${qs}`);
      assert.equal(bad.status, 400, qs.toString());
      assert.equal(bad.headers.get('location'), null);
    }
    const scopes = await openConsent(authorizeQuery(clientId, challenge, { scope: 'openid profile email' }));
    assert.equal(scopes.status, 200, 'unknown scopes are ignored');
    // an app that returns somewhere other than Claude or this computer gets a warning and its full address shown
    const other = await register({ client_name: 'Helper', redirect_uris: ['https://helper.example/cb', 'com.example.app:/cb'] });
    const w = await openConsent(authorizeQuery(other.body.client_id, challenge, { redirect_uri: 'https://helper.example/cb' }));
    assert.match(w.html, /class="warn">It returns to helper\.example, not to Claude/);
    const app = await openConsent(authorizeQuery(other.body.client_id, challenge, { redirect_uri: 'com.example.app:/cb' }));
    assert.match(app.html, /<code>com\.example\.app:\/cb<\/code>/);
    // a hostile client name is text, not markup
    const evil = await register({ client_name: '<script>alert(1)</script>' });
    const page = await (await raw(`/mcp/oauth/authorize?${authorizeQuery(evil.body.client_id, challenge)}`)).text();
    assert.ok(!page.includes('<script>alert(1)</script>'));
  });

  it('a wrong token re-shows the page; Cancel returns access_denied; a cross-site post is refused', async () => {
    const { challenge } = pkce();
    const page = await openConsent(authorizeQuery(clientId, challenge));
    const bad = await submit(page.fields, page.cookie, { token: 'smbt_wrong', decision: 'allow' });
    assert.equal(bad.status, 401);
    assert.match(await bad.text(), /doesn&#39;t match|doesn't match/);
    // another site auto-submitting the form has no nonce cookie: no redirect, even for Cancel
    const forged = await raw('/mcp/oauth/authorize', form({ ...page.fields, decision: 'deny' }));
    assert.equal(forged.status, 400);
    assert.equal(forged.headers.get('location'), null);
    const forgedAllow = await raw('/mcp/oauth/authorize', form({ ...page.fields, token: TOKEN, decision: 'allow' }));
    assert.equal(forgedAllow.status, 400);
    const cancel = await submit(page.fields, page.cookie, { decision: 'deny' });
    const loc = new URL(cancel.headers.get('location')!);
    assert.equal(loc.searchParams.get('error'), 'access_denied');
    assert.equal(loc.searchParams.get('state'), 'st-123');
  });

  let access = '', refresh = '';

  it('the right token gives a code; the code + PKCE verifier give tokens that work on /mcp', async () => {
    const { code, verifier, loc } = await signIn(clientId, TOKEN);
    assert.equal(`${loc.origin}${loc.pathname}`, REDIRECT);
    assert.equal(loc.searchParams.get('state'), 'st-123');
    assert.equal(loc.searchParams.get('iss'), ORIGIN);
    assert.match(code, /^smbt_code_/);
    const badVerifier = await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: pkce().verifier });
    assert.equal(badVerifier.body.error, 'invalid_grant', 'wrong verifier — and the code is now spent');
    const again = await signIn(clientId, TOKEN);
    const t = await exchange({ grant_type: 'authorization_code', code: again.code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: again.verifier, resource: `${ORIGIN}/mcp` });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.token_type, 'Bearer');
    assert.equal(t.body.expires_in, 3600);
    access = t.body.access_token; refresh = t.body.refresh_token;
    assert.match(access, /^smbt_at_/);
    const ok = await mcp(access);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as any).result.tools.length, 13);
    const stored = JSON.stringify(db().prepare('SELECT * FROM oauth_tokens').all());
    assert.ok(!stored.includes(access) && !stored.includes(refresh), 'only hashes are stored');
  });

  it('replaying a code ends the sign-in it produced', async () => {
    const s = await signIn(clientId, TOKEN);
    const t = await exchange({ grant_type: 'authorization_code', code: s.code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: s.verifier });
    assert.equal((await mcp(t.body.access_token)).status, 200);
    const reuse = await exchange({ grant_type: 'authorization_code', code: s.code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: s.verifier });
    assert.equal(reuse.body.error, 'invalid_grant', 'codes are single-use');
    assert.equal((await mcp(t.body.access_token)).status, 401, 'tokens from the first use are revoked');
    assert.equal((await exchange({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: clientId })).body.error, 'invalid_grant');
  });

  it('refresh rotates; replaying an old refresh token ends the sign-in', async () => {
    const r1 = await exchange({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    assert.equal(r1.status, 200);
    assert.equal((await mcp(access)).status, 401, 'old access token revoked on refresh');
    assert.equal((await mcp(r1.body.access_token)).status, 200);
    const replay = await exchange({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    assert.equal(replay.body.error, 'invalid_grant');
    assert.equal((await mcp(r1.body.access_token)).status, 401, 'whole family revoked after a replay');
    assert.equal((await exchange({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: clientId })).body.error, 'invalid_grant');
    assert.equal((await exchange({ grant_type: 'password', client_id: clientId })).body.error, 'unsupported_grant_type');
    assert.equal((await exchange({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'mcpc_nope_nope_nope' })).status, 401);
  });

  it('a new instance token or Turn off signs every assistant out', async () => {
    const s = await signIn(clientId, TOKEN);
    const t = await exchange({ grant_type: 'authorization_code', code: s.code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: s.verifier });
    assert.equal((await mcp(t.body.access_token)).status, 200);
    TOKEN = issueToken(); // rotation without the Settings route: the fingerprint alone must cut it off
    assert.equal((await mcp(t.body.access_token)).status, 401);
    assert.equal((await exchange({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: clientId })).body.error, 'invalid_grant');
    const s2 = await signIn(clientId, TOKEN);
    const t2 = await exchange({ grant_type: 'authorization_code', code: s2.code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: s2.verifier });
    revokeToken();
    assert.equal((await mcp(t2.body.access_token)).status, 404, 'off is off');
    TOKEN = issueToken();
    assert.equal((await mcp(t2.body.access_token)).status, 401, 'turning it back on does not revive old sign-ins');
    syncInstanceToken();
  });

  it('an environment token changed A → B → A does not revive sign-ins made under A', async () => {
    process.env.SMB_MCP_TOKEN = 'env-token-AAAAAAAAAAAAAAAAAAAAAAAA';
    syncInstanceToken();
    const s = await signIn(clientId, process.env.SMB_MCP_TOKEN);
    const t = await exchange({ grant_type: 'authorization_code', code: s.code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: s.verifier });
    assert.equal((await mcp(t.body.access_token)).status, 200);
    process.env.SMB_MCP_TOKEN = 'env-token-BBBBBBBBBBBBBBBBBBBBBBBB';
    syncInstanceToken(); // a restart
    process.env.SMB_MCP_TOKEN = 'env-token-AAAAAAAAAAAAAAAAAAAAAAAA';
    syncInstanceToken(); // and back
    assert.equal((await mcp(t.body.access_token)).status, 401);
    delete process.env.SMB_MCP_TOKEN;
    syncInstanceToken();
  });

  it('confidential clients authenticate; loopback redirects match any port; revoke works', async () => {
    const conf = await register({ token_endpoint_auth_method: 'client_secret_post', redirect_uris: ['http://localhost:3000/callback'] });
    assert.match(conf.body.client_secret, /^smbt_cs_/);
    const s = await signIn(conf.body.client_id, TOKEN, 'http://localhost:54321/callback');
    const noSecret = await exchange({ grant_type: 'authorization_code', code: s.code, client_id: conf.body.client_id, code_verifier: s.verifier });
    assert.equal(noSecret.status, 401);
    // registered for client_secret_post: Basic is refused, and a Basic failure says so in WWW-Authenticate
    const basicBad = await raw('/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${conf.body.client_id}:${conf.body.client_secret}`).toString('base64')}` }, body: 'grant_type=refresh_token&refresh_token=x' });
    assert.equal(basicBad.status, 401);
    assert.match(basicBad.headers.get('www-authenticate') ?? '', /^Basic /);
    const basicClient = await register({ token_endpoint_auth_method: 'client_secret_basic', redirect_uris: ['http://localhost:3000/callback'] });
    const s2 = await signIn(basicClient.body.client_id, TOKEN, 'http://localhost:54321/callback');
    const basic = Buffer.from(`${basicClient.body.client_id}:${basicClient.body.client_secret}`).toString('base64');
    const r = await raw('/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` }, body: new URLSearchParams({ grant_type: 'authorization_code', code: s2.code, code_verifier: s2.verifier, redirect_uri: 'http://localhost:54321/callback' }).toString() });
    assert.equal(r.status, 200);
    const t = await r.json() as any;
    assert.equal((await mcp(t.access_token)).status, 200);
    const rv = await raw('/mcp/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` }, body: new URLSearchParams({ token: t.refresh_token }).toString() });
    assert.equal(rv.status, 200);
    assert.equal((await mcp(t.access_token)).status, 401);
  });

  it('Settings lists signed-in assistants and can sign them all out', async () => {
    const s = await signIn(clientId, TOKEN);
    const t = await exchange({ grant_type: 'authorization_code', code: s.code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: s.verifier });
    await mcp(t.body.access_token);
    const html = await (await raw('/settings')).text();
    assert.match(html, /Signed-in assistants/);
    assert.match(html, /<td class="wrap">Claude<\/td>/);
    assert.match(html, /Add custom connector/);
    const out = await raw('/api/mcp/signout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `smb_csrf=${CSRF_SECRET}`, origin: BASE }, body: new URLSearchParams({ _csrf: CSRF_SECRET }).toString() });
    assert.equal(out.status, 303);
    assert.equal((await mcp(t.body.access_token)).status, 401);
    assert.equal((await mcp(TOKEN)).status, 200, 'the token itself keeps working');
  });

  it('wrong tokens on the sign-in page pause that client, right guesses included', async () => {
    resetOAuthLimits();
    const { challenge } = pkce();
    const page = await openConsent(authorizeQuery(clientId, challenge));
    for (let i = 0; i < 30; i++) assert.equal((await submit(page.fields, page.cookie, { token: 'nope', decision: 'allow' })).status, 401);
    assert.equal((await submit(page.fields, page.cookie, { token: TOKEN, decision: 'allow' })).status, 429);
    resetOAuthLimits();
  });

  it('the hourly sweep drops expired codes and tokens and abandoned registrations, but keeps apps that signed in', async () => {
    const used = (db().prepare('SELECT COUNT(*) AS n FROM oauth_clients WHERE last_used_at IS NOT NULL').get() as { n: number }).n;
    assert.ok(used > 0);
    sweepOAuth(Date.now() + 40 * 86400e3);
    assert.equal((db().prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get() as { n: number }).n, 0);
    assert.equal((db().prepare('SELECT COUNT(*) AS n FROM oauth_codes').get() as { n: number }).n, 0);
    assert.equal((db().prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n, used, 'only never-used registrations go');
    // a connector whose sign-in was swept can sign in again with the same registration
    const s = await signIn(clientId, TOKEN);
    assert.match(s.code, /^smbt_code_/);
  });
});
