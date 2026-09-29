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

  it('body over 64 KB is rejected', async () => {
    const b = getCounter('collect_invalid');
    const r = await post('/v1/beacon', base('load', 'k-collect', 'big', { ref: 'x'.repeat(70_000) }));
    assert.equal(r.status, 204);
    assert.equal(getCounter('collect_invalid'), b + 1);
  });
});
