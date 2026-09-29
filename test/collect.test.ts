// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SMB_DATA_DIR = mkdtempSync(join(tmpdir(), 'smb-collect-'));

const { openMemoryDb, createSite, db, getCounter } = await import('../src/db.js');
const { collectApp, resetRateLimit, validateBeacon } = await import('../src/collect/index.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const GCLID = 'Cj0KCQjwLIVE0001AAAAABgd3kPq2t6R1Y9oL7mHf4Zc8eV2uQx1EALw_wcB';

function base(t: 'load' | 'ping' | 'unload', key: string, s: string, extra: Record<string, unknown> = {}) {
  return {
    v: 1, t, c: key, s, ts: Date.now(), url: 'https://shop.test/landing?gclid=' + GCLID, ref: 'https://www.google.com/',
    gclid: GCLID, gbraid: null, wbraid: null, sdkv: '1.0.0', ...extra,
  };
}

async function post(path: string, body: unknown, ip = '203.0.113.10', headers: Record<string, string> = {}) {
  const req = new Request('http://localhost' + path, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'user-agent': UA, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return collectApp.fetch(req, { incoming: { socket: { remoteAddress: '::ffff:' + ip } } } as any);
}

const row = (siteId: number, s: string) => db().prepare('SELECT * FROM events WHERE site_id = ? AND session_id = ?').all(siteId, s) as any[];

describe('collect', () => {
  let siteId = 0;
  before(() => {
    openMemoryDb();
    siteId = createSite({ name: 'C', host: 'shop.test', key: 'k-collect', consent_mode: 'legitimate_interest', target_countries: ['GB'] }).id;
  });

  it('healthz and CORS preflight', async () => {
    const h = await collectApp.fetch(new Request('http://localhost/healthz'));
    assert.equal(h.status, 200);
    const j = await h.json() as any;
    assert.equal(j.ok, true);
    assert.equal(typeof j.version, 'string');
    const o = await collectApp.fetch(new Request('http://localhost/v1/beacon', { method: 'OPTIONS' }));
    assert.equal(o.status, 204);
    assert.equal(o.headers.get('access-control-allow-origin'), '*');
    assert.equal(o.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
    assert.equal(o.headers.get('access-control-allow-headers'), 'content-type');
  });

  it('load -> ping -> unload updates one row', async () => {
    const s = 'sess-1';
    let r = await post('/v1/beacon', base('load', 'k-collect', s, { auto: { wd: false, hc: false, pl: 3, ln: 2 } }));
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    let rows = row(siteId, s);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].gclid, GCLID);
    assert.equal(rows[0].ip, '203.0.113.10');
    assert.equal(rows[0].ua_family, 'chrome');
    assert.equal(rows[0].source, 'beacon');
    assert.equal(rows[0].fp_hash, null);
    assert.equal(rows[0].dwell_ms, null);
    assert.equal(rows[0].is_test, 0);

    r = await post('/v1/beacon', base('ping', 'k-collect', s, { fph: 'abc123', auto: { wd: true, pl: 0 } }));
    assert.equal(r.status, 204);
    rows = row(siteId, s);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fp_hash, 'abc123');
    assert.deepEqual(JSON.parse(rows[0].automation).sort(), ['no-plugins', 'webdriver']);

    r = await post('/v1/beacon', base('unload', 'k-collect', s, { dwell: 4321.6, beh: { mm: 5, sc: 2, tc: 0, cl: 1, kd: 3, fi: 1, md: 0.5 } }));
    assert.equal(r.status, 204);
    rows = row(siteId, s);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dwell_ms, 4322);
    assert.equal(rows[0].visible, 1);
    assert.equal(rows[0].interactions, 11);
    assert.equal(rows[0].fp_hash, 'abc123');

    const site = db().prepare('SELECT first_event_at, last_seen_at FROM sites WHERE id = ?').get(siteId) as any;
    assert.ok(site.first_event_at);
    assert.ok(site.last_seen_at);
  });

  it('unknown key -> 204 + counter; invalid body -> 204 + counter', async () => {
    const before1 = getCounter('collect_unknown_key');
    const r = await post('/v1/beacon', base('load', 'nope', 'sess-x'));
    assert.equal(r.status, 204);
    assert.equal(getCounter('collect_unknown_key'), before1 + 1);
    assert.equal(row(siteId, 'sess-x').length, 0);

    const before2 = getCounter('collect_invalid');
    assert.equal((await post('/v1/beacon', 'not json')).status, 204);
    assert.equal((await post('/v1/beacon', { v: 2 })).status, 204);
    assert.equal((await post('/v1/beacon', base('load', 'k-collect', 's', { t: 'weird' }))).status, 204);
    assert.equal(getCounter('collect_invalid'), before2 + 3);
  });

  it('validator drops unknown keys and enforces caps', () => {
    const ok = validateBeacon({ ...base('load', 'k', 's'), junk: 1, auto: { wd: true, junk: 2 } }) as any;
    assert.ok(ok);
    assert.equal('junk' in ok, false);
    assert.equal('junk' in ok.auto, false);
    assert.equal(validateBeacon({ ...base('load', 'k', 's'), c: 'x'.repeat(65) }), null);
    assert.equal(validateBeacon({ ...base('load', 'k', 's'), ts: 1.5 }), null);
    assert.equal(validateBeacon({ ...base('load', 'k', 's'), gclid: undefined }), null);
  });

  it('SMBTEST gclid is stored as is_test', async () => {
    await post('/v1/beacon', base('load', 'k-collect', 'sess-test', { gclid: 'SMBTEST_' + GCLID.slice(8) }));
    const rows = row(siteId, 'sess-test');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].is_test, 1);
  });

  it('load without any click id is ignored; gbraid is stored prefixed', async () => {
    const b = getCounter('collect_no_gclid');
    await post('/v1/beacon', base('load', 'k-collect', 'sess-nogclid', { gclid: null }));
    assert.equal(row(siteId, 'sess-nogclid').length, 0);
    assert.equal(getCounter('collect_no_gclid'), b + 1);
    await post('/v1/beacon', base('load', 'k-collect', 'sess-gbraid', { gclid: null, gbraid: 'ABCDEF' }));
    assert.equal(row(siteId, 'sess-gbraid')[0].gclid, 'gbraid:ABCDEF');
  });

  it('unload with no prior load inserts the session', async () => {
    await post('/v1/beacon', base('unload', 'k-collect', 'sess-lost', { dwell: 0, beh: { mm: 0, sc: 0, tc: 0, cl: 0, kd: 0 } }));
    const rows = row(siteId, 'sess-lost');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dwell_ms, 0);
    assert.equal(rows[0].visible, 0);
    assert.equal(rows[0].interactions, 0);
  });

  it('sdk-error bumps a counter', async () => {
    const b = getCounter('sdk_errors');
    const r = await post('/v1/sdk-error', 'boom');
    assert.equal(r.status, 204);
    assert.equal(getCounter('sdk_errors'), b + 1);
  });

  it('rate limits per IP at 120/min', async () => {
    resetRateLimit();
    const b = getCounter('collect_ratelimited');
    for (let i = 0; i < 120; i++) await post('/v1/beacon', base('load', 'k-collect', 'rl-' + i), '198.51.100.5');
    const r = await post('/v1/beacon', base('load', 'k-collect', 'rl-over'), '198.51.100.5');
    assert.equal(r.status, 204);
    assert.equal(getCounter('collect_ratelimited'), b + 1);
    assert.equal(row(siteId, 'rl-over').length, 0);
    // other IPs unaffected
    await post('/v1/beacon', base('load', 'k-collect', 'rl-other'), '198.51.100.6');
    assert.equal(row(siteId, 'rl-other').length, 1);
    resetRateLimit();
  });

  it('H1: with SMB_TRUST_PROXY the RIGHTMOST X-Forwarded-For hop is stored, never the client-written left part', async () => {
    const { config } = await import('../src/config.js');
    const was = config.trustProxy;
    config.trustProxy = true;
    try {
      await post('/v1/beacon', base('load', 'k-collect', 'xff-1'), '10.0.0.2', { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' });
      assert.equal(row(siteId, 'xff-1')[0].ip, '1.2.3.4');
      // v4-mapped and junk hops: junk is skipped, mapped prefix stripped
      await post('/v1/beacon', base('load', 'k-collect', 'xff-2'), '10.0.0.2', { 'x-forwarded-for': '8.8.8.8, not-an-ip, ::ffff:5.5.5.5' });
      assert.equal(row(siteId, 'xff-2')[0].ip, '5.5.5.5');
      // header with no valid address at all -> socket address
      await post('/v1/beacon', base('load', 'k-collect', 'xff-3'), '203.0.113.77', { 'x-forwarded-for': 'garbage' });
      assert.equal(row(siteId, 'xff-3')[0].ip, '203.0.113.77');
    } finally { config.trustProxy = was; }
    // without trustProxy the header is ignored entirely
    await post('/v1/beacon', base('load', 'k-collect', 'xff-4'), '203.0.113.78', { 'x-forwarded-for': '1.2.3.4' });
    assert.equal(row(siteId, 'xff-4')[0].ip, '203.0.113.78');
  });

  it('H1: the rate limit is keyed on the socket address, so a rotating X-Forwarded-For cannot reset it', async () => {
    const { config } = await import('../src/config.js');
    const was = config.trustProxy;
    config.trustProxy = true;
    resetRateLimit();
    try {
      const b = getCounter('collect_ratelimited');
      for (let i = 0; i < 120; i++) await post('/v1/beacon', base('load', 'k-collect', 'rlx-' + i), '198.51.100.9', { 'x-forwarded-for': `1.1.${i >> 8}.${i & 255}` });
      await post('/v1/beacon', base('load', 'k-collect', 'rlx-over'), '198.51.100.9', { 'x-forwarded-for': '2.2.2.2' });
      assert.equal(getCounter('collect_ratelimited'), b + 1);
      assert.equal(row(siteId, 'rlx-over').length, 0);
    } finally { config.trustProxy = was; resetRateLimit(); }
  });

  it('H2: a beacon whose Origin is another site is dropped and counted; the site host, its subdomains and no Origin are accepted', async () => {
    const b = getCounter('collect_bad_origin');
    await post('/v1/beacon', base('load', 'k-collect', 'org-evil'), '203.0.113.20', { origin: 'https://evil.example' });
    assert.equal(row(siteId, 'org-evil').length, 0);
    assert.equal(getCounter('collect_bad_origin'), b + 1);
    // Referer is consulted when there is no Origin
    await post('/v1/beacon', base('load', 'k-collect', 'ref-evil'), '203.0.113.20', { referer: 'https://evil.example/page' });
    assert.equal(row(siteId, 'ref-evil').length, 0);
    // a suffix that merely ends with the host name is not a subdomain
    await post('/v1/beacon', base('load', 'k-collect', 'org-suffix'), '203.0.113.20', { origin: 'https://notshop.test' });
    assert.equal(row(siteId, 'org-suffix').length, 0);
    await post('/v1/beacon', base('load', 'k-collect', 'org-null'), '203.0.113.20', { origin: 'null' });
    assert.equal(row(siteId, 'org-null').length, 0);
    assert.equal(getCounter('collect_bad_origin'), b + 4);
    for (const [s, origin] of [['org-exact', 'https://shop.test'], ['org-www', 'https://www.shop.test'], ['org-sub', 'https://promo.shop.test:8443']] as const) {
      await post('/v1/beacon', base('load', 'k-collect', s), '203.0.113.21', { origin });
      assert.equal(row(siteId, s).length, 1, origin);
    }
    await post('/v1/beacon', base('load', 'k-collect', 'org-none'), '203.0.113.22');
    assert.equal(row(siteId, 'org-none').length, 1);
    assert.equal(getCounter('collect_bad_origin'), b + 4);
  });

  it('H2: originAllowed handles punycode and unicode hosts alike', async () => {
    const { originAllowed } = await import('../src/collect/index.js');
    const site = { host: 'xn--mnchen-shop-thb.de' };
    assert.equal(originAllowed(site, 'https://münchen-shop.de', undefined), true);
    assert.equal(originAllowed(site, 'https://www.xn--mnchen-shop-thb.de', undefined), true);
    assert.equal(originAllowed(site, 'https://muenchen-shop.de', undefined), false);
    assert.equal(originAllowed(site, 'not a url', undefined), false);
  });

  it('body over 64 KB is rejected', async () => {
    const b = getCounter('collect_invalid');
    const r = await post('/v1/beacon', base('load', 'k-collect', 'big', { ref: 'x'.repeat(70_000) }));
    assert.equal(r.status, 204);
    assert.equal(getCounter('collect_invalid'), b + 1);
  });
});
