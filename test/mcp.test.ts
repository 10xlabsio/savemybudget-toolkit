// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'smb-mcp-'));
process.env.SMB_DATA_DIR = DATA_DIR;
process.env.SMB_PUBLIC_URL = 'https://t.shop.test';
process.env.SMB_TELEMETRY = 'off';
delete process.env.SMB_MCP_TOKEN;

const { openMemoryDb, createSite, insertEvents, updateSite, getSite } = await import('../src/db.js');
const { app } = await import('../src/app.js');
const { CSRF_SECRET } = await import('../src/ui.js');
const { generateFixture } = await import('../src/rules/fixtures.js');
const { canonicalIp } = await import('../src/mcp/leads.js');
const { runAnalysis } = await import('../src/rules/index.js');
const { issueToken, revokeToken, takeFlashToken, tokenSource, envTokenTooShort } = await import('../src/mcp/token.js');
const { resetMcpRateLimit } = await import('../src/mcp/index.js');
const { analysisRuns, clearAnalysisCache } = await import('../src/mcp/analyse.js');
const { argumentError } = await import('../src/mcp/schema.js');
const { subnet24 } = await import('../src/enrich/index.js');
type NewEvent = import('../src/db.js').NewEvent;

const BASE = 'http://127.0.0.1:8080';
const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const FROM = day(-10), TO = day(-8);
const FX = { from: FROM, days: 3, seed: 7 };

let TOKEN = '';
let rpcId = 0;
const responses: string[] = []; // every body, for the leak check at the end

function raw(path: string, init: RequestInit & { ip?: string } = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('host', '127.0.0.1:8080');
  return app.fetch(new Request(BASE + path, { ...init, headers }), { incoming: { socket: { remoteAddress: init.ip ?? '203.0.113.50' } } } as any) as Promise<Response>;
}

async function post(body: unknown, token: string | null = TOKEN, ip?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const r = await raw('/mcp', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body), ip });
  const text = await r.text();
  responses.push(text);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* plain-text 404 */ }
  return { status: r.status, headers: r.headers, text, json };
}

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const r = await post({ jsonrpc: '2.0', id: ++rpcId, method, params });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.id, rpcId);
  return r.json;
}

/** tools/call → { data, isError, text } */
async function call(name: string, args: Record<string, unknown> = {}) {
  const j = await rpc('tools/call', { name, arguments: args });
  const text = j.result.content[0].text as string;
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* error text */ }
  return { data, isError: !!j.result.isError, text };
}

function ev(siteId: number, over: Partial<NewEvent> & { ts: string; ip: string; gclid: string }): NewEvent {
  return {
    site_id: siteId, source: 'beacon', upload_id: null, received_at: over.ts, ip_private: 0, asn: 5089, asn_name: 'Virgin Media',
    is_hosting: 0, country: 'GB', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    ua_family: 'chrome', is_test: 0, session_id: `s_${Math.random().toString(16).slice(2)}`, fp_hash: 'f'.repeat(32),
    dwell_ms: 25_000, visible: 1, interactions: 12, automation: null, url: 'https://shop.test/landing', referer: 'https://www.google.com/', campaign: null,
    ...over,
  };
}

describe('mcp', () => {
  let siteId = 0;
  let otherId = 0;
  const lateDay = day(-3);

  before(() => {
    openMemoryDb();
    resetMcpRateLimit(1_000_000); // the suite itself sends far more than a client would; the limit has its own test
    siteId = createSite({ name: 'Shop', host: 'www.shop.test', key: 'sk_shoptest_00000001', consent_mode: 'legitimate_interest', target_countries: ['GB'] }).id;
    otherId = createSite({ name: 'Other', host: 'other.test', key: 'sk_othertest_00000002', consent_mode: 'legitimate_interest', target_countries: [] }).id;
    insertEvents(generateFixture(siteId, FX));
    insertEvents([
      // gbraid from a single visitor; another gbraid carried by two visitors
      ev(siteId, { ts: `${lateDay}T10:00:00.000Z`, ip: '81.2.69.160', gclid: 'gbraid:ONE_VISITOR' }),
      ev(siteId, { ts: `${lateDay}T11:00:00.000Z`, ip: '81.2.69.161', gclid: 'gbraid:TWO_VISITORS' }),
      ev(siteId, { ts: `${lateDay}T11:05:00.000Z`, ip: '81.2.69.162', gclid: 'gbraid:TWO_VISITORS' }),
      // two clicks from one IP around a form fill; utm on the second
      ev(siteId, { ts: `${lateDay}T14:00:00.000Z`, ip: '198.51.100.7', gclid: 'Cj0_IPTIME_A', url: 'https://shop.test/a?utm_campaign=brand' }),
      ev(siteId, { ts: `${lateDay}T14:10:00.000Z`, ip: '198.51.100.7', gclid: 'Cj0_IPTIME_B', url: 'https://shop.test/b?utm_campaign=generic' }),
      // a datacenter click with its gclid in a landing URL
      ev(siteId, { ts: `${lateDay}T16:00:00.000Z`, ip: '34.90.1.1', gclid: 'Cj0_HOSTING_URL', is_hosting: 1, asn: 396982, asn_name: 'GOOGLE-CLOUD-PLATFORM' }),
      // IPv6 visitor
      ev(siteId, { ts: `${lateDay}T17:00:00.000Z`, ip: '2001:db8::1', gclid: 'Cj0_V6' }),
    ]);
  });

  after(() => { delete process.env.SMB_MCP_TOKEN; });

  // ---------------------------------------------------------------- exposure & auth

  it('is a plain 404 until a token exists; /healthz unaffected', async () => {
    assert.equal(tokenSource(), null);
    for (const method of ['POST', 'GET', 'OPTIONS', 'DELETE']) {
      const r = await raw('/mcp', { method, headers: { authorization: 'Bearer x' }, ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal(r.status, 404, method);
      assert.equal(r.headers.get('access-control-allow-origin'), null, 'nothing marks the route while off');
    }
    assert.equal((await raw('/healthz')).status, 200);
  });

  it('requires the bearer token once enabled', async () => {
    TOKEN = issueToken();
    assert.match(TOKEN, /^smbt_[A-Za-z0-9_-]{43}$/);
    assert.equal(tokenSource(), 'settings');
    const none = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, null);
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer realm=/);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, TOKEN + 'x')).status, 401);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'smbt_short')).status, 401);
    const ok = await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } });
    assert.equal(ok.result.serverInfo.name, 'savemybudget-toolkit');
    assert.equal(ok.result.protocolVersion, '2025-06-18');
    assert.match(ok.result.instructions, /no Google Ads connection/);
    assert.deepEqual(Object.keys(ok.result.capabilities).sort(), ['prompts', 'tools']);
  });

  it('shows the plain token once, stores only its hash', async () => {
    const t = issueToken();
    assert.equal(takeFlashToken(), t);
    assert.equal(takeFlashToken(), null);
    const { db } = await import('../src/db.js');
    const rows = db().prepare("SELECT key, value FROM settings WHERE key LIKE 'mcp%'").all() as { key: string; value: string }[];
    assert.deepEqual(rows.map((r) => r.key), ['mcp_token_sha256']);
    assert.equal(rows[0].value.length, 64);
    assert.ok(!JSON.stringify(rows).includes(t), 'plain token never written to the database');
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, TOKEN)).status, 401, 'old token stops working after rotation');
    TOKEN = t;
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
  });

  it('a stale flash is dropped', () => {
    const t = issueToken(Date.now() - 11 * 60_000);
    assert.equal(takeFlashToken(), null);
    TOKEN = t;
  });

  it('SMB_MCP_TOKEN overrides the stored token', async () => {
    process.env.SMB_MCP_TOKEN = 'env-token-0123456789-abcdefgh';
    assert.equal(tokenSource(), 'env');
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'env-token-0123456789-abcdefgh')).status, 200);
    process.env.SMB_MCP_TOKEN = 'changeme';
    assert.equal(envTokenTooShort(), true);
    assert.equal(tokenSource(), 'settings', 'a short env token is ignored');
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'changeme')).status, 401);
    delete process.env.SMB_MCP_TOKEN;
    assert.equal(tokenSource(), 'settings');
  });

  it('rate limits per client, counts each batch message, and keeps failed sign-ins in their own bucket', async () => {
    resetMcpRateLimit(3);
    for (let i = 0; i < 3; i++) assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong', '192.0.2.9')).status, 401);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong', '192.0.2.9')).status, 429, 'guessing is capped');
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, TOKEN, '192.0.2.9')).status, 200, 'the scanner did not lock out the token holder');
    const batch = Array.from({ length: 3 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    const r = await post(batch, TOKEN, '192.0.2.9');
    assert.equal(r.status, 429, 'a batch of 3 after 1 call exceeds 3 messages');
    assert.equal(r.headers.get('retry-after'), '60');
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, TOKEN, '192.0.2.10')).status, 200, 'another client is unaffected');
    for (let i = 0; i < 3; i++) await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, TOKEN, '2001:db8:5::1');
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, TOKEN, '2001:db8:5::2')).status, 429, 'IPv6 keyed by /64');
    resetMcpRateLimit(1_000_000);
  });

  it('answers GET with 405 and preflight with CORS once enabled', async () => {
    const g = await raw('/mcp', { method: 'GET' });
    assert.equal(g.status, 405);
    assert.equal(g.headers.get('allow'), 'POST');
    const o = await raw('/mcp', { method: 'OPTIONS' });
    assert.equal(o.status, 204);
    assert.match(o.headers.get('access-control-allow-headers') ?? '', /authorization/);
    assert.equal(o.headers.get('set-cookie'), null, 'no UI cookie on /mcp');
  });

  // ---------------------------------------------------------------- JSON-RPC plumbing

  it('handles parse errors, bad messages, batches and notifications', async () => {
    const bad = await post('{nope');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, -32700);
    const inv = await post({ id: 1, method: 'ping' });
    assert.equal(inv.json.error.code, -32600);
    const unk = await post({ jsonrpc: '2.0', id: 9, method: 'resources/read' });
    assert.equal(unk.json.error.code, -32601);
    const batch = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }]);
    assert.equal(batch.json.length, 2);
    assert.deepEqual(batch.json.map((x: any) => x.id), [1, 'b']);
    const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(note.status, 202);
    const nullId = await post({ jsonrpc: '2.0', id: null, method: 'nope' });
    assert.equal(nullId.json.error.code, -32601, 'id null is a request, not a notification');
    const objId = await post({ jsonrpc: '2.0', id: {}, method: 'ping' });
    assert.equal(objId.json.error.code, -32600);
    const { getCounter } = await import('../src/db.js');
    const calls = getCounter('mcp_calls');
    const silent = await post({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_sites', arguments: {} } });
    assert.equal(silent.status, 202);
    assert.equal(getCounter('mcp_calls'), calls, 'a tool call sent as a notification is not run');
    const big = await post({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1_100_000) } });
    assert.equal(big.status, 413);
  });

  it('lists 13 tools with honest annotations and 3 prompts', async () => {
    const t = (await rpc('tools/list')).result.tools;
    assert.equal(t.length, 13);
    const byName = new Map(t.map((x: any) => [x.name, x]));
    for (const name of ['list_sites', 'get_site_summary', 'get_flagged_clicks', 'get_flag_breakdown', 'get_top_offenders', 'get_ip_profile', 'match_leads', 'get_analyses', 'get_claim_window', 'get_notifications', 'get_rules']) {
      assert.equal((byName.get(name) as any).annotations.readOnlyHint, true, name);
    }
    for (const name of ['run_analysis', 'build_claim_package']) assert.equal((byName.get(name) as any).annotations.readOnlyHint, false, name);
    for (const x of t) { assert.equal(x.inputSchema.additionalProperties, false, x.name); assert.equal(x.annotations.destructiveHint, false); }
    const p = (await rpc('prompts/list')).result.prompts.map((x: any) => x.name);
    assert.deepEqual(p.sort(), ['audit_crm_leads', 'prepare_claim', 'weekly_summary']);
    const g = await rpc('prompts/get', { name: 'prepare_claim', arguments: { site_id: 'shop.test', from: FROM, to: TO } });
    assert.match(g.result.messages[0].content.text, /never files|nothing has been filed/i);
    const miss = await post({ jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'prepare_claim', arguments: { site_id: 'x' } } });
    assert.equal(miss.json.error.code, -32602);
  });

  // ---------------------------------------------------------------- validation

  it('validates arguments strictly and resolves site_id by id or host', async () => {
    assert.match((await call('get_site_summary', { site_id: siteId, extra: 1 })).text, /unsupported field \(extra\)/);
    assert.match((await call('get_flagged_clicks', { site_id: siteId, page_size: '50' })).text, /page_size must be integer/);
    assert.match((await call('get_flagged_clicks', { site_id: siteId, page_size: 500 })).text, /at most 200/);
    assert.match((await call('get_flag_breakdown', { site_id: siteId, dimension: 'city' })).text, /must be one of/);
    assert.match((await call('get_site_summary', {})).text, /site_id is required/);
    assert.match((await call('get_site_summary', { site_id: 'nope.test' })).text, /No site matches/);
    assert.match((await call('get_site_summary', { site_id: siteId, from: TO, to: FROM })).text, /on or before/);
    assert.match((await call('get_site_summary', { site_id: siteId, from: day(-100), to: day(-1) })).text, /at most 90 days/);
    assert.match((await call('get_site_summary', { site_id: siteId, to: day(2) })).text, /future/);
    assert.match((await call('get_site_summary', { site_id: siteId, from: '2026-02-30' })).text, /date like/);
    const since = await call('get_site_summary', { site_id: siteId, from: day(-20) });
    assert.deepEqual([since.data.window.from, since.data.window.to], [day(-20), day(0)], 'from alone runs to today');
    assert.match((await call('nope')).text, /Unknown tool/);
    for (const ref of [siteId, String(siteId), 'shop.test', 'https://www.shop.test/landing?x=1', 'WWW.SHOP.TEST.', 'Shop']) {
      const r = await call('get_site_summary', { site_id: ref, from: FROM, to: TO });
      assert.equal(r.isError, false, String(ref));
      assert.equal(r.data.site_id, siteId);
    }
    assert.match(argumentError(1, { type: ['integer', 'string'] }) ?? 'ok', /ok/);
    assert.match(argumentError(true, { type: ['integer', 'string'] }) ?? '', /integer or string/);
  });

  // ---------------------------------------------------------------- read tools

  it('list_sites reports tag health and 7-day counts', async () => {
    const r = await call('list_sites');
    assert.equal(r.data.sites.length, 2);
    const shop = r.data.sites.find((s: any) => s.site_id === siteId);
    assert.equal(shop.host, 'www.shop.test');
    assert.equal(shop.clicks_7d, 7, 'only the late events fall in the last 7 days');
    assert.ok(shop.flagged_7d >= 1);
    assert.ok(['green', 'amber', 'grey'].includes(shop.tag_status));
  });

  it('get_site_summary matches the Analyse page and compares with the previous window', async () => {
    const r = await call('get_site_summary', { site_id: siteId, from: FROM, to: TO });
    const ref = runAnalysis(getSite(siteId)!, FROM, TO).summary;
    assert.deepEqual(r.data.counts, { total: ref.counts.total, allow: ref.counts.allow, watch: ref.counts.watch, flag: ref.counts.flag });
    assert.deepEqual(r.data.sources, ref.counts.sources);
    assert.deepEqual(r.data.window, { from: FROM, to: TO, days: 3, basis: 'UTC days, inclusive' });
    assert.ok(r.data.rules_fired.length > 0);
    assert.ok(r.data.rules_fired.every((x: any) => x.title && x.events > 0));
    assert.equal(r.data.trend.prior_total, 0);
    assert.equal(r.data.trend.prior_window.to, day(-11));
    const t = await call('get_site_summary', { site_id: siteId, from: day(-7), to: day(-1) });
    assert.ok(t.data.trend.prior_total > 0, 'prior window holds the fixture');
    assert.equal(typeof t.data.trend.flag_rate_change_pts, 'number');
  });

  it('get_flagged_clicks pages, filters by verdict and splits iOS click ids', async () => {
    const all = await call('get_flagged_clicks', { site_id: siteId, from: FROM, to: TO, verdict: 'flag', page_size: 200 });
    const ref = runAnalysis(getSite(siteId)!, FROM, TO).scored.filter((s) => s.verdict === 'flag').length;
    assert.equal(all.data.total_rows, ref);
    const p1 = await call('get_flagged_clicks', { site_id: siteId, from: FROM, to: TO, page_size: 5 });
    assert.equal(p1.data.clicks.length, Math.min(5, ref));
    assert.equal(p1.data.has_more, ref > 5);
    const ts = p1.data.clicks.map((c: any) => c.ts);
    assert.deepEqual(ts, [...ts].sort().reverse(), 'newest first');
    const row = p1.data.clicks[0];
    for (const k of ['event_id', 'click_id', 'click_id_kind', 'ip', 'asn_name', 'score', 'verdict', 'rules', 'landing_path']) assert.ok(k in row, k);
    assert.ok(row.rules.length > 0 && row.rules[0].weight > 0);
    const w = await call('get_flagged_clicks', { site_id: siteId, from: FROM, to: TO, verdict: 'watch', page_size: 200 });
    assert.ok(w.data.clicks.every((c: any) => c.verdict === 'watch'));
    const late = await call('get_flagged_clicks', { site_id: siteId, from: lateDay, to: lateDay, verdict: 'both', page_size: 200 });
    const all2 = await call('get_flagged_clicks', { site_id: siteId, from: lateDay, to: lateDay, verdict: 'both', page_size: 200 });
    assert.deepEqual(late.data, all2.data);
  });

  it('get_flag_breakdown covers every dimension and adds up', async () => {
    const ref = runAnalysis(getSite(siteId)!, FROM, TO).summary.counts;
    for (const dimension of ['country', 'asn', 'subnet', 'ua_family', 'source', 'campaign', 'landing_path', 'hour_of_day', 'weekday']) {
      const r = await call('get_flag_breakdown', { site_id: siteId, from: FROM, to: TO, dimension });
      assert.equal(r.isError, false, dimension);
      if (r.data.groups_omitted === 0) {
        assert.equal(r.data.rows.reduce((s: number, x: any) => s + x.total, 0), ref.total, dimension);
        assert.equal(r.data.rows.reduce((s: number, x: any) => s + x.flagged, 0), ref.flag, dimension);
      }
    }
    const rule = await call('get_flag_breakdown', { site_id: siteId, from: FROM, to: TO, dimension: 'rule' });
    const hosting = rule.data.rows.find((x: any) => x.key === 'r1_hosting_asn');
    assert.equal(hosting.title, 'Datacenter / hosting network');
    assert.equal(hosting.flagged, hosting.total, 'hard rule: every hit is flagged');
  });

  it('get_top_offenders groups, thresholds and leaves private IPs out', async () => {
    const r = await call('get_top_offenders', { site_id: siteId, from: FROM, to: TO, group_by: 'ip', min_hits: 1 });
    assert.ok(r.data.rows.length > 0);
    assert.ok(r.data.rows.every((x: any) => x.flagged >= 1 && x.top_rules.length <= 3 && !/^(10\.|192\.168\.)/.test(x.key)));
    const counts = r.data.rows.map((x: any) => x.flagged);
    assert.deepEqual(counts, [...counts].sort((a: number, b: number) => b - a));
    const high = await call('get_top_offenders', { site_id: siteId, from: FROM, to: TO, min_hits: 1000 });
    assert.equal(high.data.rows.length, 0);
    const asn = await call('get_top_offenders', { site_id: siteId, from: FROM, to: TO, group_by: 'asn', min_hits: 1 });
    assert.ok(asn.data.rows.every((x: any) => /^AS\d+$/.test(x.key)));
    assert.match(asn.data.exclusions_hint, /cannot be excluded/);
  });

  it('get_ip_profile knows only IPs seen on the site', async () => {
    const r = await call('get_ip_profile', { site_id: siteId, ip: '34.90.1.1' });
    assert.equal(r.data.hits, 1);
    assert.equal(r.data.flagged, 1);
    assert.equal(r.data.is_hosting, true);
    assert.equal(r.data.rules_seen[0].rule, 'r1_hosting_asn');
    assert.equal(r.data.recent[0].click_id, 'Cj0_HOSTING_URL');
    assert.match((await call('get_ip_profile', { site_id: siteId, ip: '9.9.9.9' })).text, /not been seen/);
    assert.match((await call('get_ip_profile', { site_id: siteId, ip: 'not-an-ip' })).text, /not a valid IP/);
    assert.match((await call('get_ip_profile', { site_id: otherId, ip: '34.90.1.1' })).text, /not been seen/, 'scoped to the site');
    const v6 = await call('get_ip_profile', { site_id: siteId, ip: '2001:db8::1' });
    assert.equal(v6.data.hits, 1);
  });

  it('get_rules returns the public rule set and how scoring works', async () => {
    const r = await call('get_rules');
    assert.equal(r.data.rules.length, 10);
    const r9 = r.data.rules.find((x: any) => x.rule === 'r9_no_beacon');
    assert.equal(r9.params.match_window_min, 30);
    assert.ok(!('kind' in r9.params) && !('weight' in r9.params));
    assert.equal(r.data.scoring.score_threshold, 70);
  });

  it('get_notifications and get_claim_window', async () => {
    const n = await call('get_notifications', { site_id: siteId });
    assert.ok(Array.isArray(n.data.notifications));
    const ok = await call('get_claim_window', { site_id: siteId, from: FROM, to: TO });
    assert.equal(ok.data.ok, true);
    assert.equal(ok.data.days_left_for_first_day, 50);
    assert.equal(ok.data.earliest_filable_day, day(-59));
    const edge = await call('get_claim_window', { site_id: siteId, from: day(-59), to: day(-50) });
    assert.equal(edge.data.ok, true);
    assert.equal(edge.data.warning, undefined, 'the earliest filable day draws no warning');
    const old = await call('get_claim_window', { site_id: siteId, from: day(-80), to: day(-70) });
    assert.equal(old.data.ok, false);
    assert.equal(old.data.days_left_for_last_day, 0);
    assert.match((await call('get_claim_window', { site_id: siteId, from: FROM })).text, /arguments\.to is required/);
  });

  // ---------------------------------------------------------------- match_leads

  it('match_leads: each key works on its own', async () => {
    const at = (h: number, m = 0) => `${lateDay}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
    const r = await call('match_leads', {
      site_id: 'shop.test',
      leads: [
        { lead_id: 'gclid-only', gclid: 'Cj0_HOSTING_URL' },
        { lead_id: 'url-only', landing_url: 'https://shop.test/landing?gclid=Cj0_HOSTING_URL&utm_source=google' },
        { lead_id: 'gbraid-one', gbraid: 'ONE_VISITOR' },
        { lead_id: 'gbraid-two', gbraid: 'TWO_VISITORS' },
        { lead_id: 'ip-time', ip: '198.51.100.7', submitted_at: at(14, 12) },
        { lead_id: 'ip-time-utm', ip: '198.51.100.7', submitted_at: at(14, 5), landing_url: 'https://shop.test/a?utm_campaign=brand' },
        { lead_id: 'ip-too-late', ip: '198.51.100.7', submitted_at: at(16) },
        { lead_id: 'ip-no-time', ip: '198.51.100.7' },
        { lead_id: 'nothing' },
        { lead_id: 'unknown-gclid', gclid: 'never-seen' },
        { lead_id: 'bad-ip', ip: 'banana', submitted_at: at(14) },
      ],
    });
    assert.equal(r.isError, false, r.text);
    const by = new Map(r.data.results.map((x: any) => [x.lead_id, x]));
    const g = (k: string) => by.get(k) as any;
    assert.equal(g('gclid-only').match_basis, 'click_id');
    assert.equal(g('gclid-only').verdict, 'flag');
    assert.match(g('gclid-only').reason, /hosting/i);
    assert.equal(g('url-only').match_basis, 'click_id');
    assert.equal(g('url-only').event_id, g('gclid-only').event_id);
    assert.equal(g('gbraid-one').match_basis, 'click_id');
    assert.equal(g('gbraid-two').match_basis, 'ambiguous');
    assert.equal(g('gbraid-two').verdict, 'no_match');
    assert.match(g('gbraid-two').reason, /2 different visitors/);
    assert.equal(g('ip-time').match_basis, 'ip_time');
    assert.equal(g('ip-time').ts, at(14, 10), 'latest click before the submission wins');
    assert.equal(g('ip-time-utm').ts, at(14, 0), 'before-submission click wins over the later one');
    assert.equal(g('ip-too-late').match_basis, 'none');
    assert.match(g('ip-too-late').reason, /within 30 minutes/);
    assert.match(g('ip-no-time').reason, /no submitted_at/);
    assert.match(g('nothing').reason, /hidden gclid field/);
    assert.match(g('unknown-gclid').reason, /not seen on this site/);
    assert.match(g('bad-ip').reason, /ignored: ip is not a valid IP/);
    assert.equal(r.data.summary.checked, 11);
    assert.equal(r.data.summary.flag + r.data.summary.watch + r.data.summary.allow + r.data.summary.no_match, 11);
  });

  it('match_leads reads zone-less times as UTC and matches any IP spelling', async () => {
    const r = await call('match_leads', { site_id: siteId, leads: [
      { lead_id: 'naive', ip: '198.51.100.7', submitted_at: `${lateDay} 14:12:00` },
      { lead_id: 'mapped', ip: '::ffff:198.51.100.7', submitted_at: `${lateDay}T14:12:00Z` },
      { lead_id: 'v6-long', ip: '2001:DB8:0:0:0:0:0:1', submitted_at: `${lateDay}T17:05:00Z` },
      { lead_id: 'junk-time', ip: '198.51.100.7', submitted_at: '1' },
    ] });
    const g = (k: string) => r.data.results.find((x: any) => x.lead_id === k);
    assert.equal(g('naive').ts, `${lateDay}T14:10:00.000Z`);
    assert.equal(g('mapped').ts, `${lateDay}T14:10:00.000Z`);
    assert.equal(g('v6-long').match_basis, 'ip_time');
    assert.match(g('junk-time').reason, /not a recognised time/);
    assert.equal(canonicalIp('::ffff:c633:6407'), '198.51.100.7');
    assert.equal(canonicalIp('2001:DB8:0:0:0:0:0:1'), '2001:db8::1');
    assert.equal(canonicalIp('banana'), null);
    const p = await call('get_ip_profile', { site_id: siteId, ip: '2001:0DB8::0001' });
    assert.equal(p.data.hits, 1);
  });

  it('match_leads: utm breaks a tie between clicks before the submission', async () => {
    const r = await call('match_leads', { site_id: siteId, leads: [{ lead_id: 'x', ip: '198.51.100.7', submitted_at: `${lateDay}T14:20:00.000Z`, landing_url: 'https://shop.test/?utm_campaign=brand' }] });
    assert.equal(r.data.results[0].ts, `${lateDay}T14:00:00.000Z`);
  });

  it('match_leads refuses contact details and oversize batches', async () => {
    const pii = await call('match_leads', { site_id: siteId, leads: [{ lead_id: '1', email: 'a@b.test' }] });
    assert.equal(pii.isError, true);
    assert.match(pii.text, /Never send names, emails, phone numbers/);
    const many = await call('match_leads', { site_id: siteId, leads: Array.from({ length: 201 }, (_, i) => ({ lead_id: String(i) })) });
    assert.match(many.text, /at most 200/);
    assert.match((await call('match_leads', { site_id: siteId, leads: [{ lead_id: '  ' }] })).text, /non-empty lead_id/);
  });

  // ---------------------------------------------------------------- actions

  it('run_analysis saves once, reuses within 24 h, and refuses unclaimable windows', async () => {
    const a = await call('run_analysis', { site_id: siteId, from: FROM, to: TO });
    assert.equal(a.data.reused, false);
    assert.ok(a.data.analysis_id > 0);
    const b = await call('run_analysis', { site_id: siteId, from: FROM, to: TO });
    assert.equal(b.data.reused, true);
    assert.equal(b.data.analysis_id, a.data.analysis_id);
    assert.deepEqual(b.data.counts, a.data.counts);
    const c = await call('run_analysis', { site_id: siteId, from: FROM, to: TO, force: true });
    assert.notEqual(c.data.analysis_id, a.data.analysis_id);
    insertEvents([ev(siteId, { ts: `${FROM}T12:00:00.000Z`, ip: '34.90.9.9', gclid: 'Cj0_LATE_IMPORT', is_hosting: 1, source: 'log' })]);
    const d = await call('run_analysis', { site_id: siteId, from: FROM, to: TO });
    assert.equal(d.data.reused, false, 'new data in the window → a new analysis, not the stale one');
    assert.equal(d.data.counts.total, c.data.counts.total + 1);
    assert.match((await call('run_analysis', { site_id: siteId, from: day(-80), to: day(-70) })).text, /outside that limit/);
    assert.match((await call('run_analysis', { site_id: siteId })).text, /arguments\.from is required/);
  });

  it('build_claim_package builds the zip and get_analyses lists it', async () => {
    const a = await call('run_analysis', { site_id: siteId, from: FROM, to: TO });
    const p = await call('build_claim_package', { analysis_id: a.data.analysis_id });
    assert.equal(p.isError, false, p.text);
    assert.ok(p.data.rows > 0);
    assert.match(p.data.filename, /^claim-www-shop-test-.*\.zip$/);
    assert.equal(p.data.download_path, `/api/packages/${p.data.package_id}/download`);
    assert.ok(p.data.contents.includes('exclusions.txt'));
    assert.match(p.data.next_step, /never files/);
    const list = await call('get_analyses', { site_id: siteId });
    const row = list.data.analyses.find((x: any) => x.analysis_id === a.data.analysis_id);
    assert.equal(row.packages[0].package_id, p.data.package_id);
    assert.equal(row.packages[0].exists, true);
    const none = await call('get_analyses', { site_id: otherId });
    assert.equal(none.data.analyses.length, 0);
    assert.match((await call('build_claim_package', { analysis_id: 999999 })).text, /No saved analysis/);
  });

  // ---------------------------------------------------------------- cache, leaks

  it('scores a window once per minute and re-scores after a bulk change', async () => {
    clearAnalysisCache();
    const before = analysisRuns();
    await call('get_site_summary', { site_id: siteId, from: FROM, to: TO });
    await call('get_flag_breakdown', { site_id: siteId, from: FROM, to: TO, dimension: 'country' });
    await call('get_top_offenders', { site_id: siteId, from: FROM, to: TO });
    assert.equal(analysisRuns() - before, 2, 'window + previous window, then cache hits');
    const s = getSite(siteId)!;
    updateSite(siteId, { name: s.name, host: s.host, consent_mode: s.consent_mode, target_countries: [] });
    const r = await call('get_flag_breakdown', { site_id: siteId, from: FROM, to: TO, dimension: 'rule' });
    assert.equal(analysisRuns() - before, 3, 'site edit invalidates');
    assert.equal(r.data.rows.find((x: any) => x.key === 'r3_geo'), undefined, 'targeting removed → rule 3 no longer fires');
    updateSite(siteId, { ...s });
  });

  it('never returns fingerprints, raw user agents, file paths or the token', () => {
    const all = responses.join('\n');
    assert.ok(!all.includes('fp_hash'), 'fp_hash');
    assert.ok(!all.includes('f'.repeat(32)), 'fingerprint value');
    assert.ok(!all.includes('AppleWebKit/537.36'), 'raw user agent');
    assert.ok(!all.includes(DATA_DIR), 'data dir path');
    assert.ok(!all.includes(TOKEN), 'token');
  });

  // ---------------------------------------------------------------- helpers

  it('subnet24 expands compressed IPv6 before taking the /64', () => {
    assert.equal(subnet24('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(subnet24('2001:0db8:0000:0000:abcd::2'), '2001:db8:0:0::/64');
    assert.equal(subnet24('::ffff:203.0.113.9'), '0:0:0:0::/64');
    assert.equal(subnet24('203.0.113.9'), '203.0.113.0/24');
  });

  // ---------------------------------------------------------------- settings card

  it('Settings → AI assistants: enable shows the token once; disable turns /mcp off', async () => {
    revokeToken();
    const csrfHeaders = { 'content-type': 'application/x-www-form-urlencoded', cookie: `smb_csrf=${CSRF_SECRET}`, origin: BASE };
    const off = await raw('/settings');
    const offHtml = await off.text();
    assert.match(offHtml, /AI assistants/);
    assert.match(offHtml, /Turned off/);
    const en = await raw('/api/mcp/enable', { method: 'POST', headers: csrfHeaders, body: new URLSearchParams({ _csrf: CSRF_SECRET }).toString() });
    assert.equal(en.status, 303);
    assert.ok(!(en.headers.get('location') ?? '').includes('smbt_'), 'token never in a URL');
    assert.equal((await raw('/settings', { method: 'HEAD' })).status, 200);
    const page1 = await (await raw('/settings')).text();
    const shown = /smbt_[A-Za-z0-9_-]{43}/.exec(page1)?.[0];
    assert.ok(shown, 'token shown on the first view');
    const page2 = await (await raw('/settings')).text();
    assert.ok(!page2.includes(shown!), 'not shown again');
    assert.match(page2, /Turned on/);
    TOKEN = shown!;
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
    const noCsrf = await raw('/api/mcp/disable', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    assert.equal(noCsrf.status, 403);
    const dis = await raw('/api/mcp/disable', { method: 'POST', headers: csrfHeaders, body: new URLSearchParams({ _csrf: CSRF_SECRET }).toString() });
    assert.equal(dis.status, 303);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404);
    process.env.SMB_MCP_TOKEN = 'env-token-0123456789-abcdefgh';
    const envPage = await (await raw('/settings')).text();
    assert.match(envPage, /SMB_MCP_TOKEN/);
    assert.ok(!envPage.includes('action="/api/mcp/enable"'), 'buttons hidden when the env sets the token');
    const blocked = await raw('/api/mcp/rotate', { method: 'POST', headers: csrfHeaders, body: new URLSearchParams({ _csrf: CSRF_SECRET }).toString() });
    assert.equal(blocked.status, 303);
    assert.match(blocked.headers.get('location') ?? '', /mcp=env/);
    delete process.env.SMB_MCP_TOKEN;
    assert.ok(existsSync(DATA_DIR));
  });
});
