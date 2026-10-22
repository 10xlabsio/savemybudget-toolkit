// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SMB_DATA_DIR = mkdtempSync(join(tmpdir(), 'toolkit-app-'));
process.env.SMB_PUBLIC_URL = 'https://t.shop.test';
process.env.SMB_TELEMETRY = 'off';

const { openMemoryDb, getSite, insertEvents, listSites } = await import('../src/db.js');
const { app } = await import('../src/app.js');
const { CSRF_SECRET } = await import('../src/ui.js');
const { config } = await import('../src/config.js');
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
    if (!headers.has('origin')) headers.set('origin', BASE);
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

  // ---------- regression tests for the 2026-09-29 review ----------

  it('F1: every selected targeting country is stored (repeated form field), on create and on edit', async () => {
    const r = await req('/api/sites', {
      method: 'POST', csrf: true, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `_csrf=${CSRF_SECRET}&name=Multi&host=multi.shop.test&target_countries=GB&target_countries=IE&target_countries=de&target_countries=zz`,
    });
    assert.equal(r.status, 303);
    const site = listSites().find((s) => s.host === 'multi.shop.test')!;
    assert.deepEqual(site.target_countries, ['GB', 'IE', 'DE']);
    const e = await req(`/api/sites/${site.id}`, {
      method: 'POST', csrf: true, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `_csrf=${CSRF_SECRET}&name=Multi&host=multi.shop.test&target_countries=GB,IE&target_countries=FR`,
    });
    assert.equal(e.status, 303);
    assert.deepEqual(getSite(site.id)!.target_countries, ['GB', 'IE', 'FR']);
    const form = await (await req(`/sites/${site.id}/edit`)).text();
    assert.ok(form.includes('value="GB" selected') && form.includes('value="IE" selected') && form.includes('value="FR" selected'));
    assert.ok(!form.includes('value="DE" selected'));
    await req(`/api/sites/${site.id}/delete`, { method: 'POST', csrf: true });
  });

  it('F5: a unicode hostname is accepted, stored as punycode and shown in unicode', async () => {
    const r = await req('/api/sites', {
      method: 'POST', csrf: true, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: CSRF_SECRET, name: 'München', host: 'München-Shop.de' }).toString(),
    });
    assert.equal(r.status, 303, r.headers.get('location') ?? '');
    const site = listSites().find((s) => s.name === 'München')!;
    assert.equal(site.host, 'xn--mnchen-shop-thb.de');
    const html = await (await req('/sites')).text();
    assert.ok(html.includes('münchen-shop.de'));
    await req(`/api/sites/${site.id}/delete`, { method: 'POST', csrf: true });
  });

  it('F6: the site name is capped at 60 characters server-side', async () => {
    const r = await req('/api/sites', {
      method: 'POST', csrf: true, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: CSRF_SECRET, name: 'N'.repeat(500), host: 'long.shop.test' }).toString(),
    });
    assert.equal(r.status, 303);
    const site = listSites().find((s) => s.host === 'long.shop.test')!;
    assert.equal(site.name.length, 60);
    await req(`/api/sites/${site.id}/delete`, { method: 'POST', csrf: true });
  });

  it('M1: the setup check is POST-only with CSRF and refuses private, loopback, link-local and CGNAT targets', async () => {
    assert.equal((await req('/api/setup/check?url=http://169.254.169.254')).status, 404);
    const noCsrf = await req('/api/setup/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://169.254.169.254' }) });
    assert.equal(noCsrf.status, 403);
    const check = async (url: string) => {
      const r = await req('/api/setup/check', { method: 'POST', csrf: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
      assert.equal(r.status, 200);
      return r.json() as Promise<{ ok: boolean; reason?: string; warning?: string }>;
    };
    for (const url of ['http://169.254.169.254/latest', 'http://127.0.0.1:9', 'http://10.1.2.3', 'http://172.20.0.1', 'http://192.168.1.1', 'http://100.64.0.1', 'http://[::1]:9', 'http://[fd00::1]', 'http://[::ffff:10.0.0.1]', 'http://0.0.0.0', 'http://localhost:9']) {
      const j = await check(url);
      assert.equal(j.ok, false, url);
      assert.match(j.reason ?? '', /private or local address/, url);
    }
    assert.match((await check('ftp://x.example')).reason ?? '', /must start with https/);
    assert.match((await check('nope')).reason ?? '', /not a full URL/);
    // the reply never echoes an upstream status code
    const j = await check('http://198.51.100.1:9');
    assert.equal(j.ok, false);
    assert.doesNotMatch(j.reason ?? '', /answered \d{3}/);
  });

  it('M1: isInternalAddress classifies addresses', async () => {
    const { isInternalAddress } = await import('../src/api/index.js');
    for (const a of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '[::1]', 'not-an-ip']) {
      assert.equal(isInternalAddress(a), true, a);
    }
    for (const a of ['8.8.8.8', '203.0.113.5', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isInternalAddress(a), false, a);
  });

  it('M3: a chunked multipart body over the cap is refused with 413 before it is parsed', async () => {
    const { config } = await import('../src/config.js');
    const was = config.maxUploadMb;
    config.maxUploadMb = 1; // cap = 2 MiB including multipart overhead
    try {
      const boundary = 'xxBOUNDARYxx';
      const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.csv"\r\nContent-Type: text/csv\r\n\r\n`;
      const chunk = Buffer.alloc(256 * 1024, 0x61);
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(ctl) { ctl.enqueue(new TextEncoder().encode(head)); },
        pull(ctl) {
          if (sent >= 12) { ctl.enqueue(new TextEncoder().encode(`\r\n--${boundary}--\r\n`)); ctl.close(); return; }
          sent++; ctl.enqueue(chunk);
        },
      });
      const headers = new Headers({ host: '127.0.0.1:8080', cookie: `smb_csrf=${CSRF_SECRET}`, 'x-csrf': CSRF_SECRET, 'content-type': `multipart/form-data; boundary=${boundary}` });
      const r = await app.fetch(new Request(`${BASE}/api/sites/${siteId}/uploads`, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit), { incoming: { socket: { remoteAddress: '203.0.113.10' } } } as any);
      assert.equal(r.status, 413);
      assert.match((await r.json()).error, /larger than 1 MB/);
      assert.ok(sent < 12, 'the stream was cancelled early');
      // a declared Content-Length over the cap is refused too
      const r2 = await req(`/api/sites/${siteId}/uploads`, { method: 'POST', csrf: true, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(50 * 1048576) }, body: '' });
      assert.equal(r2.status, 413);
    } finally { config.maxUploadMb = was; }
  });

  it('L1: _next only accepts a plain local path', async () => {
    const { safeNext } = await import('../src/api/index.js');
    assert.equal(safeNext('/setup?saved=1'), '/setup?saved=1');
    assert.equal(safeNext('/sites/3'), '/sites/3');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', '/x y', '/x<script>', '', 'setup']) assert.equal(safeNext(bad), null, bad);
    const r = await req('/api/settings', {
      method: 'POST', csrf: true, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ _csrf: CSRF_SECRET, tz: 'UTC', _next: '/\\evil.example' }),
    });
    assert.equal(r.headers.get('location'), '/settings?saved=1');
  });

  it('L2: the CSRF cookie is Secure when a trusted proxy says the request was https', async () => {
    const { config } = await import('../src/config.js');
    const plain = await req('/setup', { headers: { cookie: '' } });
    assert.doesNotMatch(plain.headers.get('set-cookie') ?? '', /Secure/);
    const was = config.trustProxy;
    config.trustProxy = true;
    try {
      const r = await req('/setup', { headers: { cookie: '', 'x-forwarded-proto': 'https' } });
      assert.match(r.headers.get('set-cookie') ?? '', /Secure/);
    } finally { config.trustProxy = was; }
    const untrusted = await req('/setup', { headers: { cookie: '', 'x-forwarded-proto': 'https' } });
    assert.doesNotMatch(untrusted.headers.get('set-cookie') ?? '', /Secure/);
  });

  it('F2: a CSV with unknown headers offers its headers, and a mapping posted as form fields makes it importable via the staged token', async () => {
    const rows = ['When,Addr,ClickRef,Agent'];
    const day = new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10);
    for (let i = 0; i < 25; i++) rows.push(`${day}T11:${String(i).padStart(2, '0')}:00Z,198.51.100.${i + 1},Cj0KCQjwMAPPED${String(i).padStart(4, '0')}AAAAABgd3kPq2t6R1Y9oL7mHf4Zc8eV2uQx1EALw_wcB,"${UA}"`);
    const fd = new FormData();
    fd.append('file', new Blob([rows.join('\n')], { type: 'text/csv' }), 'renamed.csv');
    const r = await req(`/api/sites/${siteId}/uploads`, { method: 'POST', csrf: true, body: fd });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.preview.ok, false);
    assert.equal(j.preview.format, 'csv');
    assert.deepEqual(j.preview.headers, ['When', 'Addr', 'ClickRef', 'Agent']);
    assert.deepEqual(j.preview.missing, ['timestamp', 'ip', 'gclid']);
    // re-check with the mapping and the token only — no file re-upload
    const fd2 = new FormData();
    fd2.append('token', j.token);
    fd2.append('mapping[timestamp]', 'When');
    fd2.append('mapping[ip]', 'Addr');
    fd2.append('mapping[gclid]', 'ClickRef');
    const r2 = await req(`/api/sites/${siteId}/uploads`, { method: 'POST', csrf: true, body: fd2 });
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.equal(j2.preview.ok, true, JSON.stringify(j2.preview.errors));
    assert.equal(j2.preview.rows_usable, 25);
    assert.notEqual(j2.token, j.token);
    // the mapping was stored alongside the staged file, so import needs no body
    const im = await req(`/api/sites/${siteId}/uploads/${j2.token}/import`, { method: 'POST', csrf: true, headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(im.status, 200);
    assert.equal((await im.json()).imported, 25);
    assert.ok((await (await req(`/sites/${siteId}/uploads`)).text()).includes('renamed.csv'));
  });

  it('F3: two packages of one analysis download distinct content; deleting one leaves the other downloadable', async () => {
    const build = async (body: Record<string, string>) => {
      const r = await req(`/api/analyses/${analysisId}/package`, { method: 'POST', csrf: true, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody({ _csrf: CSRF_SECRET, ...body }) });
      assert.equal(r.status, 303);
      return Number(r.headers.get('location')!.match(/package=(\d+)/)![1]);
    };
    const a = await build({ exclusions: '1' });
    const b = await build({ include_watch: '1' });
    assert.notEqual(a, b);
    const dl = async (id: number) => { const d = await req(`/api/packages/${id}/download`); return { status: d.status, buf: Buffer.from(await d.arrayBuffer()), name: d.headers.get('content-disposition') ?? '' }; };
    const da = await dl(a), db_ = await dl(b);
    assert.equal(da.status, 200); assert.equal(db_.status, 200);
    assert.ok(!da.buf.equals(db_.buf), 'packages are distinct files');
    assert.match(da.name, new RegExp(`-p${a}\\.zip`));
    assert.match(db_.name, new RegExp(`-p${b}\\.zip`));
    const del = await req(`/api/packages/${b}/delete`, { method: 'POST', csrf: true });
    assert.equal(del.status, 303);
    assert.equal((await dl(b)).status, 404);
    const after = await dl(a);
    assert.equal(after.status, 200);
    assert.ok(after.buf.equals(da.buf));
    const pg = await (await req(`/sites/${siteId}/analyse?analysis=${analysisId}`)).text();
    assert.ok(pg.includes(`/api/packages/${a}/download`));
    assert.ok(!pg.includes(`/api/packages/${b}/download`));
  });

  it('F4: overview Flagged and Watch cards follow the selected range', async () => {
    // An analysis over the last 30 days covers every range. The fixture (7–9 days old) supplies the flags; the only
    // click in the last 24 h is the single live beacon from earlier, so the 24 h Flagged card must be 0 or 1, not the window total.
    const from = new Date(Date.now() - 29 * 86400e3).toISOString().slice(0, 10);
    const run = await req(`/api/sites/${siteId}/analyses`, { method: 'POST', csrf: true, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody({ _csrf: CSRF_SECRET, from, to: new Date().toISOString().slice(0, 10) }) });
    assert.equal(run.status, 303);
    const kpi = (html: string, label: string) => { const m = html.match(new RegExp(`<div class="l">${label}</div><div class="v">([^<]*)`)); return m ? Number(m[1].trim().replace(/,/g, '')) : NaN; };
    const h24 = await (await req(`/sites/${siteId}?range=24h`)).text();
    const clicks24 = kpi(h24, 'Ad clicks recorded'), flagged24 = kpi(h24, 'Flagged'), watch24 = kpi(h24, 'Watch');
    assert.ok(clicks24 <= 1, String(clicks24));
    assert.ok(flagged24 <= clicks24, `${flagged24} <= ${clicks24}`);
    assert.ok(watch24 <= clicks24, `${watch24} <= ${clicks24}`);
    assert.ok(h24.includes('last 24 hours · analysis'));
    const h30 = await (await req(`/sites/${siteId}?range=30d`)).text();
    const clicks30 = kpi(h30, 'Ad clicks recorded'), flagged30 = kpi(h30, 'Flagged');
    assert.ok(flagged30 > 0);
    assert.ok(flagged30 > flagged24, 'the whole window has more flags than the last day');
    assert.ok(flagged30 <= clicks30, `${flagged30} <= ${clicks30}`);
  });

  it('F10: the hourly tick sweeps staged uploads older than an hour and keeps fresh ones', async () => {
    const { hourlyTick, sweepStagedUploads } = await import('../src/jobs/index.js');
    const { writeFileSync, existsSync, mkdirSync } = await import('node:fs');
    const dir = join(process.env.SMB_DATA_DIR!, 'uploads');
    mkdirSync(dir, { recursive: true });
    const old = 'a'.repeat(24) + '.bin', fresh = 'b'.repeat(24) + '.bin', noMeta = 'c'.repeat(24) + '.bin';
    writeFileSync(join(dir, old), 'x'); writeFileSync(join(dir, old + '.json'), JSON.stringify({ filename: 'x', site_id: siteId, mapping: null, at: Date.now() - 2 * 3600e3 }));
    writeFileSync(join(dir, fresh), 'x'); writeFileSync(join(dir, fresh + '.json'), JSON.stringify({ filename: 'x', site_id: siteId, mapping: null, at: Date.now() - 600e3 }));
    writeFileSync(join(dir, noMeta), 'x'); // no .json: falls back to mtime (fresh)
    writeFileSync(join(dir, 'keep.txt'), 'x'); // not a staged token
    hourlyTick();
    assert.equal(existsSync(join(dir, old)), false);
    assert.equal(existsSync(join(dir, old + '.json')), false);
    assert.equal(existsSync(join(dir, fresh)), true);
    assert.equal(existsSync(join(dir, noMeta)), true);
    assert.equal(existsSync(join(dir, 'keep.txt')), true);
    assert.equal(sweepStagedUploads(Date.now() + 2 * 3600e3), 2);
    assert.equal(existsSync(join(dir, fresh)), false);
    assert.equal(existsSync(join(dir, noMeta)), false);
  });

  it('F11/F12: settings shows the bad-URL message; setup check reports the http warning', async () => {
    const r = await req('/api/settings', {
      method: 'POST', csrf: true, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ _csrf: CSRF_SECRET, public_url: 'not-a-url' }),
    });
    assert.equal(r.headers.get('location'), '/settings?error=url');
    const html = await (await req('/settings')).text();
    assert.ok(html.includes('collect_bad_origin'));
    const err = await (await req('/settings?error=url')).text();
    assert.ok(err.includes('The public URL was not saved'));
    const setup = await (await req('/setup')).text();
    assert.ok(setup.includes("fetch('/api/setup/check',{method:'POST'"));
    assert.ok(setup.includes('j.warning'));
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
  describe('Host allow-list and CSRF hardening', () => {
    const raw = (path: string, host: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers ?? {});
      headers.set('host', host);
      return app.fetch(new Request(BASE + path, { ...init, headers, redirect: 'manual' }), { incoming: { socket: { remoteAddress: '203.0.113.10' } } } as any);
    };
    const UI_GETS = ['/', '/setup', '/sites', '/sites/new', '/settings', '/about', '/docs/getting-started', '/templates/click-log-template.csv'];
    const post = (path: string, headers: Record<string, string>, body: Record<string, string> = {}) =>
      raw(path, '127.0.0.1:8080', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `smb_csrf=${CSRF_SECRET}`, ...headers }, body: formBody({ _csrf: CSRF_SECRET, ...body }) });
    afterEach(() => { config.uiUrl = ''; });

    it('a foreign Host gets 421 on every UI route, with no cookie and no page', async () => {
      for (const host of ['evil.example', 'evil.example:8080', '127.0.0.1', '127.0.0.1:9999', 'localhost.evil.example:8080', '203.0.113.5:8080']) {
        for (const path of UI_GETS) {
          const r = await raw(path, host);
          assert.equal(r.status, 421, `${host} ${path}`);
          assert.equal(r.headers.get('set-cookie'), null, `${host} ${path}`);
          assert.ok(!(await r.text()).includes(CSRF_SECRET));
        }
        for (const path of ['/api/sites', '/api/setup/check', '/api/mcp/enable']) {
          const r = await raw(path, host, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://${host}`, cookie: `smb_csrf=${CSRF_SECRET}`, 'x-csrf': CSRF_SECRET }, body: formBody({ _csrf: CSRF_SECRET }) });
          assert.equal(r.status, 421, `${host} POST ${path}`);
          assert.equal(r.headers.get('set-cookie'), null);
        }
      }
    });

    it('a missing Host header is refused too', async () => {
      const r = await app.fetch(new Request(BASE + '/sites'), { incoming: { socket: { remoteAddress: '203.0.113.10' } } } as any);
      // The Request constructor supplies no Host header, so the UI sees none.
      assert.equal(r.status, 421);
    });

    it('the 421 body names the setting for another address and nothing more', async () => {
      const r = await raw('/about', 'evil.example');
      const t = await r.text();
      assert.match(t, /SMB_UI_URL/);
      assert.ok(!t.includes('evil.example'));
    });

    it('loopback names on the listening port are served; the public URL host alone is not', async () => {
      for (const host of ['127.0.0.1:8080', 'localhost:8080', 'LOCALHOST:8080', '[::1]:8080']) {
        const r = await raw('/about', host);
        assert.equal(r.status, 200, host);
        assert.match(r.headers.get('set-cookie') ?? '', /smb_csrf=/, host);
      }
      assert.equal((await raw('/about', 't.shop.test')).status, 421);
    });

    it('SMB_UI_URL adds exactly its own host, and default ports are implicit', async () => {
      config.uiUrl = 'https://ui.example.com';
      assert.equal((await raw('/about', 'ui.example.com')).status, 200);
      assert.equal((await raw('/about', 'ui.example.com:443')).status, 200);
      assert.equal((await raw('/about', 'ui.example.com:8443')).status, 421);
      assert.equal((await raw('/about', 't.shop.test')).status, 421);
      config.uiUrl = 'http://ui.example.com';
      assert.equal((await raw('/about', 'ui.example.com:80')).status, 200);
      config.uiUrl = 'https://ui.example.com:8443';
      assert.equal((await raw('/about', 'ui.example.com:8443')).status, 200);
      assert.equal((await raw('/about', 'ui.example.com')).status, 421);
    });

    it('changing the public URL in Settings does not change which hosts are allowed', async () => {
      const r = await req('/api/settings', { method: 'POST', csrf: true, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody({ _csrf: CSRF_SECRET, public_url: 'https://rebind.example.net' }) });
      assert.ok(r.status < 400, String(r.status));
      assert.equal((await raw('/about', 'rebind.example.net')).status, 421);
      await req('/api/settings', { method: 'POST', csrf: true, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody({ _csrf: CSRF_SECRET, public_url: 'https://t.shop.test' }) });
    });

    it('a POST from the UI address works when Origin is that address', async () => {
      config.uiUrl = 'https://ui.example.com';
      const r = await raw('/api/sites', 'ui.example.com', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://ui.example.com', cookie: `smb_csrf=${CSRF_SECRET}` }, body: formBody({ _csrf: CSRF_SECRET, name: 'Shop', host: 'proxied.shop.test' }) });
      assert.ok(r.status < 400, String(r.status));
    });

    it('the collector, SDK and health check do not depend on the UI Host list', async () => {
      assert.equal((await raw('/healthz', 'anything.example')).status, 200);
      assert.equal((await raw('/sdk/v1/smb.js', 'anything.example')).status, 200);
    });

    it('a POST from another origin fails even with the right token', async () => {
      for (const origin of ['https://evil.example', 'http://localhost:8081', 'http://127.0.0.1:8080.evil.example']) {
        const r = await post('/api/sites', { origin }, { name: 'Shop', host: 'cross.shop.test' });
        assert.equal(r.status, 403, origin);
      }
      assert.ok(!listSites().some((s) => s.host === 'cross.shop.test'));
    });

    it('a POST with a referer from another origin fails', async () => {
      const r = await post('/api/sites', { referer: 'https://evil.example/page' }, { name: 'Shop', host: 'cross2.shop.test' });
      assert.equal(r.status, 403);
    });

    it('a POST with Origin "null" fails even with the right token', async () => {
      const r = await post('/api/sites', { origin: 'null' }, { name: 'Shop', host: 'null.shop.test' });
      assert.equal(r.status, 403);
      assert.ok(!listSites().some((s) => s.host === 'null.shop.test'));
    });

    it('a POST with no Origin and no Referer fails even with the right token', async () => {
      const r = await post('/api/sites', {}, { name: 'Shop', host: 'bare.shop.test' });
      assert.equal(r.status, 403);
      assert.ok(!listSites().some((s) => s.host === 'bare.shop.test'));
    });

    it('a POST with no Origin but a same-origin Referer works', async () => {
      const r = await post('/api/sites', { referer: `${BASE}/sites/new` }, { name: 'Shop', host: 'ref.shop.test' });
      assert.ok(r.status < 400, String(r.status));
    });

    it('a same-origin form post works', async () => {
      const r = await post('/api/sites', { origin: BASE }, { name: 'Shop', host: 'same.shop.test' });
      assert.ok(r.status < 400, String(r.status));
      assert.ok(listSites().some((s) => s.host === 'same.shop.test'));
    });

    it('the cookie is HttpOnly and pages send a same-origin referrer policy', async () => {
      const r = await raw('/about', '127.0.0.1:8080');
      assert.match(r.headers.get('set-cookie') ?? '', /HttpOnly/i);
      assert.equal(r.headers.get('referrer-policy'), 'same-origin');
    });

    it('no UI page reads document.cookie, and every page carries the token in a meta tag', async () => {
      const { notify } = await import('../src/jobs/index.js');
      notify(null, 'disk', 'csrf-test-render', { mb: 1 });
      const sid = listSites()[0].id;
      const paths = ['/setup', '/sites', '/sites/new', `/sites/${sid}/edit`, `/sites/${sid}/install`, `/sites/${sid}`, `/sites/${sid}/uploads`, `/sites/${sid}/analyse`, '/settings', '/about', '/docs/getting-started'];
      for (const path of paths) {
        const r = await req(path);
        assert.equal(r.status, 200, path);
        const html = await r.text();
        assert.ok(!html.includes('document.cookie'), `${path} reads document.cookie`);
        assert.ok(html.includes(`<meta name="csrf-token" content="${CSRF_SECRET}"`), `${path} has no csrf meta`);
      }
    });

    it('a notification can be dismissed with the token the page carries', async () => {
      const { notify, activeNotifications } = await import('../src/jobs/index.js');
      notify(null, 'disk', 'csrf-test-dismiss', { mb: 2 });
      const html = await (await req('/about')).text();
      assert.match(html, /querySelector\('meta\[name=csrf-token\]'\)/);
      const token = /<meta name="csrf-token" content="([^"]+)"/.exec(html)![1];
      const id = activeNotifications(null).find((x) => x.kind === 'disk')!.id;
      const r = await raw(`/api/notifications/${id}/dismiss`, '127.0.0.1:8080', { method: 'POST', headers: { origin: BASE, cookie: `smb_csrf=${CSRF_SECRET}`, 'x-csrf': token } });
      assert.ok(r.status < 400, String(r.status));
      assert.ok(!activeNotifications(null).some((x) => x.id === id));
    });

    it('Origin must match scheme and port, not only the host', async () => {
      for (const origin of ['https://127.0.0.1:8080', 'https://localhost:8080']) {
        assert.equal((await post('/api/sites', { origin }, { name: 'Shop', host: 'scheme.shop.test' })).status, 403, origin);
      }
      config.uiUrl = 'https://ui.example.com';
      const ui = (origin: string) => raw('/api/sites', 'ui.example.com', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin, cookie: `smb_csrf=${CSRF_SECRET}` }, body: formBody({ _csrf: CSRF_SECRET, name: 'Shop', host: 'scheme2.shop.test' }) });
      assert.equal((await ui('http://ui.example.com')).status, 403);
      assert.ok((await ui('https://ui.example.com:443')).status < 400);
    });

    it('an unparsable SMB_UI_URL is ignored (loopback only)', async () => {
      config.uiUrl = 'not a url';
      assert.equal((await raw('/about', '127.0.0.1:8080')).status, 200);
      assert.equal((await raw('/about', 'ui.example.com')).status, 421);
    });

    it('forms carry the token from the server', async () => {
      const html = await (await req('/sites/new')).text();
      assert.ok(html.includes(`name="_csrf" value="${CSRF_SECRET}"`));
    });
  });
});
