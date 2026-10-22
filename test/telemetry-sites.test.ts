// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SMB_DATA_DIR = mkdtempSync(join(tmpdir(), 'smb-telemetry-sites-'));
process.env.SMB_PUBLIC_URL = 'https://t.shop.test';
process.env.SMB_UPDATE_CHECK = 'off';
delete process.env.SMB_TELEMETRY; // telemetry on
delete process.env.SMB_MCP_TOKEN;

// Every telemetry send goes through this stub; nothing leaves the machine.
const sent: Array<{ event: string; properties: Record<string, unknown>; distinct_id: string }> = [];
globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
  if (String(url).endsWith('/capture/')) sent.push(JSON.parse(init!.body!));
  return new Response('{}', { status: 200 });
}) as typeof fetch;

const { openMemoryDb, createSite, insertEvents, db } = await import('../src/db.js');
const { app } = await import('../src/app.js');
const { CSRF_SECRET } = await import('../src/ui.js');
const { generateFixture } = await import('../src/rules/fixtures.js');
const { issueToken } = await import('../src/mcp/token.js');
const { hourlyTick, dailyTick } = await import('../src/jobs/index.js');
const telemetry = await import('../src/telemetry/index.js');

const BASE = 'http://127.0.0.1:8080';
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const FROM = day(-10), TO = day(-8);
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const formBody = (o: Record<string, string>) => new URLSearchParams(o).toString();

function req(path: string, init: RequestInit & { csrf?: boolean; auth?: string } = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('host', '127.0.0.1:8080');
  if (init.csrf) { headers.set('cookie', `smb_csrf=${CSRF_SECRET}`); headers.set('x-csrf', CSRF_SECRET); headers.set('origin', BASE); }
  if (init.auth) headers.set('authorization', `Bearer ${init.auth}`);
  return app.fetch(new Request(BASE + path, { ...init, headers, redirect: 'manual' }), { incoming: { socket: { remoteAddress: '203.0.113.50' } } } as any) as Promise<Response>;
}

const lastOf = (event: string) => sent.filter((s) => s.event === event).at(-1);

describe('telemetry at every real call site', () => {
  let siteId = 0;
  let analysisId = 0;
  let token = '';

  before(() => {
    openMemoryDb();
    siteId = createSite({ name: 'Shop', host: 'www.shop.test', key: 'sk_shoptest_00000001', consent_mode: 'consent_gated', target_countries: ['GB'] }).id;
    insertEvents(generateFixture(siteId, { from: FROM, days: 3, seed: 7 }));
    token = issueToken();
  });

  it('instance_started', () => {
    telemetry.track('instance_started', telemetry.startupProps('npm', true));
    const e = lastOf('instance_started')!;
    assert.ok(e, 'sent');
    assert.equal(typeof e.properties.node, 'number');
    assert.equal(e.properties.$geoip_disable, true);
  });

  it('snippet_generated', async () => {
    assert.equal((await req(`/sites/${siteId}/install`)).status, 200);
    assert.equal(lastOf('snippet_generated')!.properties.consent_mode, 'consent_gated');
  });

  it('analysis_run and claim_package from the UI', async () => {
    const r = await req(`/api/sites/${siteId}/analyses`, { method: 'POST', csrf: true, headers: FORM, body: formBody({ _csrf: CSRF_SECRET, from: FROM, to: TO }) });
    assert.equal(r.status, 303);
    analysisId = Number(r.headers.get('location')!.match(/analysis=(\d+)/)![1]);
    const a = lastOf('analysis_run')!;
    assert.ok(a, 'sent');
    assert.equal(a.properties.window_days, 3);
    assert.ok(Object.keys(a.properties.rules as object).length > 0);
    const p = await req(`/api/analyses/${analysisId}/package`, { method: 'POST', csrf: true, headers: FORM, body: formBody({ _csrf: CSRF_SECRET, exclusions: '1' }) });
    assert.equal(p.status, 303);
    assert.ok(lastOf('claim_package'), 'sent');
  });

  it('a very long window is capped, not dropped', async () => {
    const count = sent.length;
    const r = await req(`/api/sites/${siteId}/analyses`, { method: 'POST', csrf: true, headers: FORM, body: formBody({ _csrf: CSRF_SECRET, from: day(-2000), to: TO }) });
    assert.equal(r.status, 303);
    assert.equal(sent.length, count + 1);
    assert.equal(lastOf('analysis_run')!.properties.window_days, 366);
  });

  it('analysis_run and claim_package over the AI assistant interface', async () => {
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const r = await req('/mcp', { method: 'POST', auth: token, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      const j = await r.json() as any;
      assert.equal(j.result.isError ?? false, false, j.result.content[0].text);
      return JSON.parse(j.result.content[0].text);
    };
    const run = await rpc('run_analysis', { site_id: siteId, from: FROM, to: TO, force: true });
    assert.equal(lastOf('analysis_run')!.properties.via, 'mcp');
    await rpc('build_claim_package', { analysis_id: run.analysis_id });
    assert.equal(lastOf('claim_package')!.properties.via, 'mcp');
  });

  it('first_beacon and heartbeat from the scheduled jobs', async () => {
    db().prepare('UPDATE telemetry SET first_boot_at = ?, first_beacon_reported = 0 WHERE id = 1').run(new Date(Date.now() - 400 * 86_400_000).toISOString());
    db().prepare('UPDATE sites SET first_event_at = ? WHERE id = ?').run(new Date().toISOString(), siteId);
    hourlyTick(new Date());
    assert.equal(lastOf('first_beacon')!.properties.hours_since_install, '>30d');
    await new Promise((r) => setTimeout(r, 20)); // let the previous send finish; a heartbeat never overlaps another send
    await dailyTick(new Date());
    const h = lastOf('heartbeat')!;
    assert.ok(h, 'sent');
    assert.equal(h.properties.sites, 1);
    assert.match(String(h.properties.uptime_hours), /h$|d$/);
  });

  it('error', () => {
    telemetry.track('error', { stage: 'write', error_class: new TypeError('x').name });
    assert.equal(lastOf('error')!.properties.error_class, 'TypeError');
  });

  it('every event carries a UUID id and a plain version, and nothing is sent for a refused payload', () => {
    for (const e of sent) {
      assert.match(e.distinct_id, /^[0-9a-f-]{36}$/);
      assert.match(String(e.properties.toolkit_version), /^\d+\.\d+\.\d+/);
    }
    const count = sent.length;
    telemetry.track('heartbeat', { sites: 16909060 });
    telemetry.track('heartbeat', { host: 'shop.example.com' });
    telemetry.track('analysis_run', { rules: new URL('https://shop.example.com/') as never });
    assert.equal(sent.length, count, 'no fetch for a refused payload');
  });
});
