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
const { resetOAuthLimits, sweepOAuth, redirectMatches, redirectUriAllowed } = await import('../src/mcp/oauth.js');

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
/** The whole browser leg: consent page → paste token → code. */
async function signIn(clientId: string, token: string, redirect = REDIRECT) {
  const { verifier, challenge } = pkce();
  const q = Object.fromEntries(authorizeQuery(clientId, challenge, { redirect_uri: redirect }));
  const r = await raw('/mcp/oauth/authorize', form({ ...q, token, decision: 'allow' }));
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

  it('everything is a 404 while AI assistants are off', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/mcp/oauth/authorize?client_id=x']) {
      assert.equal((await raw(p)).status, 404, p);
    }
    assert.equal((await raw('/mcp/oauth/register', json({}))).status, 404);
    assert.equal((await raw('/mcp/oauth/token', form({}))).status, 404);
  });

  it('serves discovery metadata built from the public URL, and the 401 points at it', async () => {
    TOKEN = issueToken();
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
    assert.equal(redirectUriAllowed('http://127.0.0.1:3118/callback'), true);
    assert.equal(redirectUriAllowed('cursor://anysphere.cursor-mcp/oauth/callback'), true);
    assert.equal(redirectMatches(['http://localhost:3000/callback'], 'http://localhost:61234/callback'), true, 'loopback: any port');
    assert.equal(redirectMatches(['http://localhost:3000/callback'], 'http://localhost:61234/other'), false);
    assert.equal(redirectMatches(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai:444/api/mcp/auth_callback'), false);
  });

  it('the consent page names the app and where it returns, and refuses bad requests', async () => {
    const { challenge } = pkce();
    const r = await raw(`/mcp/oauth/authorize?${authorizeQuery(clientId, challenge)}`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Connect Claude\?/);
    assert.match(html, /<b>claude\.ai<\/b>/);
    assert.match(html, /type="password"/);
    assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('set-cookie'), null);
    // unknown client / wrong redirect: a page, never a redirect to an untrusted address
    assert.equal((await raw(`/mcp/oauth/authorize?${authorizeQuery('mcpc_unknownclient000', challenge)}`)).status, 400);
    const wrong = await raw(`/mcp/oauth/authorize?${authorizeQuery(clientId, challenge, { redirect_uri: 'https://evil.example/cb' })}`);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.headers.get('location'), null);
    // trusted redirect, bad request: error goes back to the app
    const noPkce = await raw(`/mcp/oauth/authorize?${authorizeQuery(clientId, 'short')}`);
    assert.equal(noPkce.status, 302);
    assert.equal(new URL(noPkce.headers.get('location')!).searchParams.get('error'), 'invalid_request');
    const badRes = await raw(`/mcp/oauth/authorize?${authorizeQuery(clientId, challenge, { resource: 'https://other.example/mcp' })}`);
    assert.equal(new URL(badRes.headers.get('location')!).searchParams.get('error'), 'invalid_target');
    // a hostile client name is text, not markup
    const evil = await register({ client_name: '<script>alert(1)</script>' });
    const page = await (await raw(`/mcp/oauth/authorize?${authorizeQuery(evil.body.client_id, challenge)}`)).text();
    assert.ok(!page.includes('<script>alert(1)</script>'));
  });

  it('a wrong token re-shows the page; Cancel returns access_denied', async () => {
    const { challenge } = pkce();
    const q = Object.fromEntries(authorizeQuery(clientId, challenge));
    const bad = await raw('/mcp/oauth/authorize', form({ ...q, token: 'smbt_wrong', decision: 'allow' }));
    assert.equal(bad.status, 401);
    assert.match(await bad.text(), /doesn&#39;t match|doesn't match/);
    const cancel = await raw('/mcp/oauth/authorize', form({ ...q, decision: 'deny' }));
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
    const reuse = await exchange({ grant_type: 'authorization_code', code: again.code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: again.verifier });
    assert.equal(reuse.body.error, 'invalid_grant', 'codes are single-use');
    const ok = await mcp(access);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as any).result.tools.length, 13);
    const stored = JSON.stringify(db().prepare('SELECT * FROM oauth_tokens').all());
    assert.ok(!stored.includes(access) && !stored.includes(refresh), 'only hashes are stored');
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
  });

  it('confidential clients authenticate; loopback redirects match any port; revoke works', async () => {
    const conf = await register({ token_endpoint_auth_method: 'client_secret_post', redirect_uris: ['http://localhost:3000/callback'] });
    assert.match(conf.body.client_secret, /^smbt_cs_/);
    const s = await signIn(conf.body.client_id, TOKEN, 'http://localhost:54321/callback');
    const noSecret = await exchange({ grant_type: 'authorization_code', code: s.code, client_id: conf.body.client_id, code_verifier: s.verifier });
    assert.equal(noSecret.status, 401);
    const s2 = await signIn(conf.body.client_id, TOKEN, 'http://localhost:54321/callback');
    const basic = Buffer.from(`${conf.body.client_id}:${conf.body.client_secret}`).toString('base64');
    const r = await raw('/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` }, body: new URLSearchParams({ grant_type: 'authorization_code', code: s2.code, code_verifier: s2.verifier, redirect_uri: 'http://localhost:54321/callback' }).toString() });
    assert.equal(r.status, 200);
    const t = await r.json() as any;
    assert.equal((await mcp(t.access_token)).status, 200);
    const rv = await raw('/mcp/oauth/revoke', form({ token: t.refresh_token, client_id: conf.body.client_id, client_secret: conf.body.client_secret }));
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

  it('wrong tokens on the sign-in page are rate limited', async () => {
    resetOAuthLimits();
    const { challenge } = pkce();
    const q = Object.fromEntries(authorizeQuery(clientId, challenge));
    for (let i = 0; i < 30; i++) assert.equal((await raw('/mcp/oauth/authorize', form({ ...q, token: 'nope', decision: 'allow' }))).status, 401);
    assert.equal((await raw('/mcp/oauth/authorize', form({ ...q, token: 'nope', decision: 'allow' }))).status, 429);
    resetOAuthLimits();
  });

  it('the hourly sweep drops expired codes, tokens and abandoned registrations', async () => {
    const before = (db().prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n;
    sweepOAuth(Date.now() + 40 * 86400e3);
    assert.equal((db().prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get() as { n: number }).n, 0);
    assert.equal((db().prepare('SELECT COUNT(*) AS n FROM oauth_codes').get() as { n: number }).n, 0);
    assert.ok((db().prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n < before);
  });
});
