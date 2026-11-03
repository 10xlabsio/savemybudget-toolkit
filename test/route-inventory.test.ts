// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * The route inventory. Every route the server registers is listed here with what it needs. With Google
 * sign-in on, a request without a session to any owner route gets the sign-in redirect or a 401, never content.
 * A new route fails this test until it is added below, so nothing becomes reachable without a session by accident.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SMB_DATA_DIR = mkdtempSync(join(tmpdir(), 'toolkit-routes-'));
process.env.SMB_PUBLIC_URL = 'https://t.shop.test';
process.env.SMB_TELEMETRY = 'off';
process.env.SMB_GOOGLE_CLIENT_ID = 'toolkit-test-client.apps.googleusercontent.com';
process.env.SMB_GOOGLE_CLIENT_SECRET = 'test-client-secret-not-real';
process.env.SMB_OWNER_EMAIL = 'owner@example.com';
for (const k of ['SMB_SECRET_KEY', 'SMB_UI_URL', 'SMB_MCP_TOKEN']) delete process.env[k];

const { openMemoryDb, createSite } = await import('../src/db.js');
const { app } = await import('../src/app.js');
const { collectApp } = await import('../src/collect/index.js');
const { mcpApp } = await import('../src/mcp/index.js');
const { wellKnownApp } = await import('../src/mcp/oauth.js');
const { issueToken } = await import('../src/mcp/token.js');
const { setGoogleFetch } = await import('../src/auth/google.js');

setGoogleFetch(async (u) => { throw new Error(`no network in tests: ${u}`); });

type Need =
  | 'owner'          // the owner's session (with sign-in on); the 1.x loopback rules without it
  | 'signin'         // part of signing in: reachable without a session, 404 without a client configured
  | 'public'         // the tag, the SDK and health checks
  | 'mcp'            // its own bearer token / OAuth, never the session cookie
  | 'middleware';    // not a route: a layer every request under it passes

/** Every route, as `METHOD path` exactly as registered (mounted apps under their mount point). */
const INVENTORY: Record<string, Need> = {
  // the UI layer: Host allow-list, owner gate, form token, security headers
  'ALL /*': 'middleware',

  // public
  'GET /healthz': 'public',
  'GET /sdk/v1/smb.js': 'public',
  'GET /sdk/:build/smb.js': 'public',
  'ALL /collect/*': 'public',
  'ALL /collect/* → ALL /*': 'middleware',
  'ALL /collect/* → OPTIONS /*': 'public',
  'ALL /collect/* → POST /v1/beacon': 'public',
  'ALL /collect/* → POST /v1/sdk-error': 'public',
  'ALL /collect/* → GET /healthz': 'public',
  'ALL /v1/*': 'public',
  'ALL /v1/* → ALL /*': 'middleware',
  'ALL /v1/* → OPTIONS /*': 'public',
  'ALL /v1/* → POST /v1/beacon': 'public',
  'ALL /v1/* → POST /v1/sdk-error': 'public',
  'ALL /v1/* → GET /healthz': 'public',

  // AI assistants
  'ALL /mcp/*': 'mcp',
  'ALL /mcp/* → ALL /*': 'middleware',
  'ALL /mcp/* → OPTIONS /': 'mcp',
  'ALL /mcp/* → GET /': 'mcp',
  'ALL /mcp/* → DELETE /': 'mcp',
  'ALL /mcp/* → POST /': 'mcp',
  'ALL /mcp/* → POST /oauth/register': 'mcp',
  'ALL /mcp/* → GET /oauth/authorize': 'mcp',
  'ALL /mcp/* → POST /oauth/authorize': 'mcp',
  'ALL /mcp/* → POST /oauth/token': 'mcp',
  'ALL /mcp/* → POST /oauth/revoke': 'mcp',
  'ALL /mcp/* → OPTIONS /oauth/register': 'mcp',
  'ALL /mcp/* → OPTIONS /oauth/token': 'mcp',
  'ALL /mcp/* → OPTIONS /oauth/revoke': 'mcp',
  'ALL /.well-known/*': 'mcp',
  'ALL /.well-known/* → GET /oauth-protected-resource': 'mcp',
  'ALL /.well-known/* → OPTIONS /oauth-protected-resource': 'mcp',
  'ALL /.well-known/* → GET /oauth-protected-resource/mcp': 'mcp',
  'ALL /.well-known/* → OPTIONS /oauth-protected-resource/mcp': 'mcp',
  'ALL /.well-known/* → GET /oauth-authorization-server': 'mcp',
  'ALL /.well-known/* → OPTIONS /oauth-authorization-server': 'mcp',
  'ALL /.well-known/* → GET /oauth-authorization-server/mcp': 'mcp',
  'ALL /.well-known/* → OPTIONS /oauth-authorization-server/mcp': 'mcp',
  'ALL /.well-known/* → ALL /*': 'mcp',

  // signing in
  'GET /auth/google/signin': 'signin',
  'GET /auth/google/start': 'signin',
  'GET /auth/google/callback': 'signin',
  'POST /auth/signout': 'owner',
  'POST /auth/signout-everywhere': 'owner',

  // the UI
  'GET /templates/:file': 'owner',
  'GET /docs': 'owner',
  'GET /docs/:page': 'owner',
  'GET /TELEMETRY.md': 'owner',
  'GET /': 'owner',
  'GET /setup': 'owner',
  'GET /sites': 'owner',
  'GET /sites/new': 'owner',
  'GET /sites/:id/edit': 'owner',
  'GET /sites/:id/install': 'owner',
  'GET /sites/:id': 'owner',
  'GET /sites/:id/uploads': 'owner',
  'GET /sites/:id/analyse': 'owner',
  'GET /settings': 'owner',
  'GET /about': 'owner',
  'POST /api/sites': 'owner',
  'POST /api/sites/:id': 'owner',
  'POST /api/sites/:id/delete-data': 'owner',
  'POST /api/sites/:id/delete': 'owner',
  'GET /api/sites/:id/status': 'owner',
  'POST /api/setup/check': 'owner',
  'POST /api/settings': 'owner',
  'POST /api/mcp/enable': 'owner',
  'POST /api/mcp/rotate': 'owner',
  'POST /api/mcp/disable': 'owner',
  'POST /api/mcp/signout': 'owner',
  'POST /api/sites/:id/uploads': 'owner',
  'POST /api/sites/:id/uploads/:token/import': 'owner',
  'DELETE /api/uploads/:id': 'owner',
  'POST /api/uploads/:id/delete': 'owner',
  'POST /api/sites/:id/analyses': 'owner',
  'POST /api/analyses/:id/package': 'owner',
  'GET /api/packages/:id/download': 'owner',
  'POST /api/packages/:id/delete': 'owner',
  'POST /api/notifications/:id/dismiss': 'owner',
  'GET /api/export': 'owner',
};

/** The only paths that answer without the owner's session, as the security design lists them. */
const EXEMPT = [/^\/healthz$/, /^\/sdk\//, /^\/collect\//, /^\/v1\//, /^\/mcp\//, /^\/\.well-known\//, /^\/auth\/google\//];

function registered(): string[] {
  const out: string[] = [];
  const mounts: Record<string, { routes: { method: string; path: string }[] }> = { '/collect/*': collectApp, '/v1/*': collectApp, '/mcp/*': mcpApp, '/.well-known/*': wellKnownApp };
  for (const r of app.routes) {
    const key = `${r.method} ${r.path}`;
    out.push(key);
    const sub = r.method === 'ALL' ? mounts[r.path] : undefined;
    if (sub) for (const s of sub.routes) out.push(`${key} → ${s.method} ${s.path}`);
  }
  return [...new Set(out)].sort();
}

const SITE = { name: 'Inventory Test Shop', host: 'inventory-shop.test', key: 'sk_inventory_00000001' };

function req(method: string, path: string, headers: Record<string, string> = {}) {
  const h = new Headers({ host: 'localhost:8080', ...headers });
  const body = method === 'GET' || method === 'HEAD' ? undefined : 'name=x&host=x.test&_csrf=x';
  if (body) { h.set('content-type', 'application/x-www-form-urlencoded'); h.set('origin', 'http://localhost:8080'); }
  return app.fetch(new Request(`http://localhost:8080${path}`, { method, headers: h, body, redirect: 'manual' }), { incoming: { socket: { remoteAddress: '203.0.113.30' } } } as any) as Promise<Response>;
}
const concrete = (p: string) => p.replace(':id', '1').replace(':token', 'abc').replace(':file', 'click-log-template.csv').replace(':page', 'getting-started').replace(':build', 'x');

describe('route inventory', () => {
  before(() => {
    openMemoryDb();
    createSite({ ...SITE, consent_mode: 'legitimate_interest', target_countries: [] });
  });

  it('lists every registered route, and nothing that is not registered', () => {
    const have = registered();
    const listed = Object.keys(INVENTORY).sort();
    assert.deepEqual(have.filter((r) => !(r in INVENTORY)), [], 'routes missing from the inventory: add each with what it needs');
    assert.deepEqual(listed.filter((r) => !have.includes(r)), [], 'inventory entries for routes that no longer exist');
  });

  it('only the fixed list answers without the owner session', () => {
    for (const [key, need] of Object.entries(INVENTORY)) {
      if (need === 'owner' || need === 'middleware') continue;
      const path = key.split(' → ')[0].split(' ')[1];
      assert.ok(EXEMPT.some((re) => re.test(path)), `${key} is ${need} but its path is not on the exempt list`);
    }
    for (const [key, need] of Object.entries(INVENTORY)) {
      const path = key.split(' ')[1];
      if (need === 'owner') assert.ok(!EXEMPT.some((re) => re.test(path)), `${key} is an owner route under an exempt path`);
    }
  });

  it('without a session, every owner route redirects to sign-in or answers 401, never content', async () => {
    const token = issueToken();
    for (const [key, need] of Object.entries(INVENTORY)) {
      if (need !== 'owner') continue;
      const [method, path] = key.split(' ');
      for (const headers of [{}, { authorization: `Bearer ${token}` }, { cookie: '__Host-smb_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }]) {
        const r = await req(method, concrete(path), headers);
        const body = await r.text();
        if (r.status === 302) {
          assert.equal(new URL(r.headers.get('location')!, 'http://localhost:8080').pathname, '/auth/google/signin', key);
        } else {
          assert.equal(r.status, 401, `${key} answered ${r.status}`);
          assert.equal(body, 'Sign in first.', key);
        }
        assert.ok(!body.includes(SITE.name) && !body.includes(SITE.key) && !body.includes(SITE.host), `${key} leaked site data`);
      }
      if (method === 'GET') {
        const head = await req('HEAD', concrete(path));
        assert.ok(head.status === 302 || head.status === 401, `HEAD ${path} answered ${head.status}`);
      }
    }
  });

  it('the sign-in routes answer without a session', async () => {
    assert.equal((await req('GET', '/auth/google/signin')).status, 200);
    assert.match((await req('GET', '/auth/google/start')).headers.get('location') ?? '', /^https:\/\/accounts\.google\.com\//);
    assert.equal((await req('GET', '/auth/google/callback?state=x&code=y')).status, 400);
  });
});
