import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SMB_DATA_DIR = mkdtempSync(join(tmpdir(), 'smb-app-'));
process.env.SMB_PUBLIC_URL = 'https://t.shop.test';
process.env.SMB_TELEMETRY = 'off';

const { openMemoryDb, getSite, insertEvents, listSites } = await import('../src/db.js');
const { app } = await import('../src/app.js');
const { CSRF_SECRET } = await import('../src/ui.js');
const { generateFixture } = await import('../src/rules/fixtures.js');
const { SDK_BUILD } = await import('../src/pages/install.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const GCLID = 'Cj0KCQjwLIVE0001AAAAABgd3kPq2t6R1Y9oL7mHf4Zc8eV2uQx1EALw_wcB';
const BASE = 'http://127.0.0.1:8080';

function req(path: string, init: RequestInit & { csrf?: boolean; ip?: string } = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('host', '127.0.0.1:8080');
  if (init.csrf) {
    headers.set('cookie', `smb_csrf=${CSRF_SECRET}`);
    headers.set('x-csrf', CSRF_SECRET);
  }
  const r = new Request(BASE + path, { ...init, headers, redirect: 'manual' });
  return app.fetch(r, { incoming: { socket: { remoteAddress: init.ip ?? '203.0.113.10' } } } as any);
}

const formBody = (o: Record<string, string>) => new URLSearchParams(o).toString();

describe('app', () => {
  let siteId = 0;
  let analysisId = 0;

  before(() => { openMemoryDb(); });

  it('GET / redirects to /setup when there are no sites', async () => {
    const r = await req('/');
    assert.equal(r.status, 302);
    assert.equal(new URL(r.headers.get('location')!, BASE).pathname, '/setup');
    const s = await req('/setup');
    assert.equal(s.status, 200);
    assert.match(s.headers.get('content-security-policy') ?? '', /script-src 'nonce-/);
    assert.equal(s.headers.get('x-frame-options'), 'DENY');
  });

  it('POST /api/sites rejects without CSRF', async () => {
    const r = await req('/api/sites', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody({ name: 'Shop', host: 'shop.test' }) });
    assert.equal(r.status, 403);
    assert.equal(listSites().length, 0);
  });

  it('POST /api/sites rejects a placeholder host and a URL', async () => {
    for (const host of ['example.com', 'https://shop.test', 'google.com', 'localhost', 'shop.test/landing']) {
      const r = await req('/api/sites', {
        method: 'POST', csrf: true,
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `smb_csrf=${CSRF_SECRET}` },
        body: formBody({ _csrf: CSRF_SECRET, name: 'Shop', host }),
      });
      assert.equal(r.status, 303, host);
      assert.match(r.headers.get('location')!, /^\/sites\/new\?/);
    }
    assert.equal(listSites().length, 0);
  });

  it('POST /api/sites creates a site with csrf cookie + field', async () => {
    const r = await req('/api/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `smb_csrf=${CSRF_SECRET}`, origin: BASE },
      body: formBody({ _csrf: CSRF_SECRET, name: 'Shop', host: 'WWW.Shop.Test', consent_mode: 'consent_gated', target_countries: 'GB' }),
    });
    assert.equal(r.status, 303);
    const sites = listSites();
    assert.equal(sites.length, 1);
    siteId = sites[0].id;
    assert.equal(sites[0].host, 'www.shop.test');
    assert.match(sites[0].key, /^sk_shoptest_[0-9a-f]{8}$/);
    assert.deepEqual(sites[0].target_countries, ['GB']);
    assert.equal(r.headers.get('location'), `/sites/${siteId}/install`);
  });

  it('rejects a cross-origin POST even with a valid token', async () => {
    const r = await req(`/api/sites/${siteId}`, {
      method: 'POST', csrf: true,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      body: formBody({ _csrf: CSRF_SECRET, name: 'X', host: 'shop.test' }),
    });
    assert.equal(r.status, 403);
  });

  it('install page has the key and no savemybudget.io inside the snippet', async () => {
    const r = await req(`/sites/${siteId}/install`);
    assert.equal(r.status, 200);
    const html = await r.text();
    const site = getSite(siteId)!;
    assert.ok(html.includes(site.key));
    const m = html.match(/<pre id="snippet"><code>([\s\S]*?)<\/code><\/pre>/);
    assert.ok(m, 'snippet block present');
    assert.ok(!m![1].includes('savemybudget.io'));
    assert.ok(m![1].includes('t.shop.test/sdk/v1/smb.js'));
    assert.ok(html.includes(SDK_BUILD.sri));
    // switcher renders for a single-site user
    assert.ok(html.includes('class="sw"'));
    assert.ok(html.includes('Tag &amp; install — Shop'));
  });

  it('serves the SDK with CORS and 404s a wrong build id', async () => {
    const r = await req('/sdk/v1/smb.js');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^application\/javascript/);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal(r.headers.get('content-security-policy'), null);
    const t = await r.text();
    assert.ok(t.includes('use strict'));
    const b = await req(`/sdk/${SDK_BUILD.build}/smb.js`);
    assert.equal(b.status, 200);
    assert.equal(b.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const bad = await req('/sdk/deadbeef0000/smb.js');
    assert.equal(bad.status, 404);
  });

  it('healthz under / and /collect', async () => {
    for (const p of ['/healthz', '/collect/healthz']) {
      const r = await req(p);
      assert.equal(r.status, 200, p);
      assert.deepEqual((await r.json()).ok, true);
      assert.equal(r.headers.get('content-security-policy'), null);
    }
  });

  it('status shape, then a beacon bumps beacons_24h', async () => {
    const s0 = await req(`/api/sites/${siteId}/status`);
    assert.equal(s0.status, 200);
    const j0 = await s0.json();
    assert.deepEqual(Object.keys(j0).sort(), ['beacons_24h', 'first_event_at', 'last_seen_at', 'last_test_at', 'status'].sort());
    assert.equal(j0.status, 'grey');
    assert.equal(j0.beacons_24h, 0);

    const site = getSite(siteId)!;
    const body = JSON.stringify({ v: 1, t: 'load', c: site.key, s: 'sess-1', ts: Date.now(), url: 'https://www.shop.test/?gclid=' + GCLID, ref: 'https://www.google.com/', gclid: GCLID, gbraid: null, wbraid: null, sdkv: '0.2.0' });
    for (const p of ['/v1/beacon', '/collect/v1/beacon']) {
      const b = await req(p, { method: 'POST', headers: { 'content-type': 'text/plain', 'user-agent': UA, origin: 'https://www.shop.test' }, body });
      assert.equal(b.status, 204, p);
      assert.equal(b.headers.get('access-control-allow-origin'), '*');
    }
    const s1 = await req(`/api/sites/${siteId}/status`);
    const j1 = await s1.json();
    assert.equal(j1.beacons_24h, 1); // second post was a duplicate session
    assert.equal(j1.status, 'green');
    assert.ok(j1.first_event_at);
  });

  it('overview renders with KPI cards', async () => {
    const r = await req(`/sites/${siteId}?range=7d`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Ad clicks recorded'));
    assert.ok(html.includes('Run an analysis'));
    assert.ok(html.includes('<svg'));
  });

  it('analysis on a fixture redirects to the analyse page', async () => {
    const from = new Date(Date.now() - 9 * 86400e3).toISOString().slice(0, 10);
    insertEvents(generateFixture(siteId, { from, days: 3, seed: 7 }));
    const to = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
    const r = await req(`/api/sites/${siteId}/analyses`, {
      method: 'POST', csrf: true,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ _csrf: CSRF_SECRET, from, to }),
    });
    assert.equal(r.status, 303);
    const loc = r.headers.get('location')!;
    const m = loc.match(new RegExp(`^/sites/${siteId}/analyse\\?analysis=(\\d+)$`));
    assert.ok(m, loc);
    analysisId = Number(m![1]);
    const pg = await req(loc);
    assert.equal(pg.status, 200);
    const html = await pg.text();
    assert.ok(html.includes('Rules that fired'));
    assert.ok(html.includes('Datacenter / hosting network'));
    assert.ok(html.includes('Build package'));
  });

  it('refuses a window outside the claim limit', async () => {
    const r = await req(`/api/sites/${siteId}/analyses`, {
      method: 'POST', csrf: true, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ _csrf: CSRF_SECRET, from: '2020-01-01', to: '2020-01-31' }),
    });
    assert.equal(r.status, 303);
    assert.match(decodeURIComponent(r.headers.get('location')!), /error=/);
  });

  it('package build then download returns application/zip', async () => {
    const r = await req(`/api/analyses/${analysisId}/package`, {
      method: 'POST', csrf: true, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ _csrf: CSRF_SECRET, exclusions: '1' }),
    });
    assert.equal(r.status, 303);
    const m = r.headers.get('location')!.match(/package=(\d+)/);
    assert.ok(m);
    const d = await req(`/api/packages/${m![1]}/download`);
    assert.equal(d.status, 200);
    assert.equal(d.headers.get('content-type'), 'application/zip');
    const buf = Buffer.from(await d.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK');
    const pg = await req(`/sites/${siteId}/analyse?analysis=${analysisId}`);
    assert.ok((await pg.text()).includes('Download'));
  });

  it('overview shows flagged rows once an analysis covers the range', async () => {
    const r = await req(`/sites/${siteId}?range=30d`);
    const html = await r.text();
    assert.ok(html.includes('Show IP addresses'));
    assert.ok(html.includes('Hosting:'));
    assert.ok(!html.includes('Run an analysis'));
  });

  it('POST /api/notifications/:id/dismiss', async () => {
    const { notify, activeNotifications } = await import('../src/jobs/index.js');
    notify(siteId, 'first_beacon', 'once', { at: new Date().toISOString() });
    const [nt] = activeNotifications(siteId);
    assert.ok(nt);
    const page = await req(`/sites/${siteId}`);
    assert.ok((await page.text()).includes('is live. From now on every ad click is recorded'));
    const r = await req(`/api/notifications/${nt.id}/dismiss`, { method: 'POST', csrf: true });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(activeNotifications(siteId).length, 0);
  });

  it('upload preview + import through the API', async () => {
    const rows = ['timestamp,ip,gclid,user_agent'];
    const day = new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10);
    for (let i = 0; i < 25; i++) {
      rows.push(`${day}T10:${String(i).padStart(2, '0')}:00Z,198.51.100.${i + 1},Cj0KCQjwUPLOAD${String(i).padStart(4, '0')}AAAAABgd3kPq2t6R1Y9oL7mHf4Zc8eV2uQx1EALw_wcB,"${UA}"`);
    }
    const fd = new FormData();
    fd.append('file', new Blob([rows.join('\n')], { type: 'text/csv' }), 'clicks.csv');
    const r = await req(`/api/sites/${siteId}/uploads`, { method: 'POST', csrf: true, body: fd });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.token);
    assert.equal(j.preview.ok, true);
    assert.equal(j.preview.rows_usable, 25);
    const im = await req(`/api/sites/${siteId}/uploads/${j.token}/import`, { method: 'POST', csrf: true, headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(im.status, 200);
    assert.equal((await im.json()).imported, 25);
    const hist = await req(`/sites/${siteId}/uploads`);
    assert.ok((await hist.text()).includes('clicks.csv'));
    const again = await req(`/api/sites/${siteId}/uploads/${j.token}/import`, { method: 'POST', csrf: true, headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(again.status, 410);
  });

  it('settings save and export', async () => {
    const r = await req('/api/settings', {
      method: 'POST', csrf: true, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ _csrf: CSRF_SECRET, public_url: 'https://t.shop.test/', tz: 'Europe/London', retention_days: '30', silent_threshold_hours: '24' }),
    });
    assert.equal(r.status, 303);
    const { getSetting } = await import('../src/db.js');
    assert.equal(getSetting('public_url'), 'https://t.shop.test');
    assert.equal(getSetting('retention_days'), '60');
    assert.equal(getSetting('silent_threshold_hours'), '24');
    const s = await req('/settings');
    assert.ok((await s.text()).includes('Europe/London'));
    const e = await req('/api/export');
    assert.equal(e.status, 200);
    assert.equal(e.headers.get('content-type'), 'application/zip');
  });

  it('docs render markdown and rewrite .md links', async () => {
    const r = await req('/docs/install-the-tag');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('<h1'));
    assert.ok(html.includes('href="/docs/privacy"'));
    assert.ok(html.includes('<table'));
    const t = await req('/docs/telemetry');
    assert.equal(t.status, 200);
    const bad = await req('/docs/../package');
    assert.notEqual(bad.status, 200);
    const tpl = await req('/templates/click-log-template.csv');
    assert.equal(tpl.status, 200);
    assert.match(tpl.headers.get('content-disposition') ?? '', /attachment/);
  });

  it('about and sites list', async () => {
    const a = await req('/about');
    assert.equal(a.status, 200);
    const html = await a.text();
    assert.ok(html.includes(SDK_BUILD.build));
    assert.ok(html.includes('github.com/10xlabsio/savemybudget-toolkit'));
    const s = await req('/sites');
    assert.equal(s.status, 200);
    assert.ok((await s.text()).includes('www.shop.test'));
  });
});
