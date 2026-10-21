// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SMB_DATA_DIR = mkdtempSync(join(tmpdir(), 'smb-telemetry-'));

const { payload, ALLOWED } = await import('../src/telemetry/index.js');
type EventName = import('../src/telemetry/index.js').EventName;

const build = (event: EventName, props: Record<string, unknown>) => payload(event, props as never, 'instance-1', '1.1.0');

const IDENTIFIERS: Record<string, unknown> = {
  customer_id_string: '1234567890',
  customer_id_number: 1234567890,
  customer_id_dashed: '123-456-7890',
  ipv4: '203.0.113.7',
  ipv6: '2001:db8::7334',
  gclid: 'Cj0KCQjw_EAIaIQobChMI-example-gclid-0123456789',
  email: 'someone@example.com',
  domain: 'shop.example.com',
  url: 'https://shop.example.com/landing?gclid=abc',
};

describe('telemetry payload allow-list', () => {
  it('passes every documented event with in-range values', () => {
    const ok: Array<[EventName, Record<string, unknown>]> = [
      ['instance_started', { version: '1.1.0', node: 'v22.5.1', os: 'linux', arch: 'x64', deploy_method: 'compose', first_boot: true }],
      ['snippet_generated', { consent_mode: 'consent_gated' }],
      ['first_beacon', { hours_since_install: 3 }],
      ['heartbeat', { beacons_per_day: '1k-10k', distinct_gclids: '<1k', sites: 2, imports_used: false, store_size: '<100MB', uptime_hours: 30, sdk_errors: 0, mcp_enabled: true, mcp_calls: 12 }],
      ['analysis_run', { rules: { r1_hosting_asn: 4, r13_gclid_replay: 0 }, flagged_share: '5-20%', window_days: 7, sources_beacon: true, sources_log: false, sources_csv: false, via: 'mcp' }],
      ['claim_package', { flagged_rows: '<1k', exclusions: true }],
      ['error', { stage: 'write', error_class: 'TypeError' }],
    ];
    for (const [event, props] of ok) {
      const p = build(event, props);
      assert.equal(p.event, event);
      assert.equal(p.properties.toolkit_version, '1.1.0');
    }
    assert.deepEqual(Object.keys(ALLOWED).sort(), ok.map(([e]) => e).sort());
  });

  for (const [name, value] of Object.entries(IDENTIFIERS)) {
    it(`throws on ${name} in any string or count field`, () => {
      assert.throws(() => build('instance_started', { version: value }), /telemetry/);
      assert.throws(() => build('snippet_generated', { consent_mode: value }), /telemetry/);
      assert.throws(() => build('heartbeat', { sites: value }), /telemetry/);
      assert.throws(() => build('heartbeat', { store_size: value }), /telemetry/);
      assert.throws(() => build('error', { stage: value }), /telemetry/);
      assert.throws(() => build('error', { error_class: value }), /telemetry/);
      assert.throws(() => build('analysis_run', { rules: { [String(value)]: 1 } }), /telemetry/);
    });

    it(`throws on ${name} under an unlisted key`, () => {
      assert.throws(() => build('heartbeat', { [name]: value }), /may not carry/);
      assert.throws(() => build('error', { message: value }), /may not carry/);
    });
  }

  it('throws on an unknown event, an unlisted key, a wrong type and a nested object where a scalar is expected', () => {
    assert.throws(() => build('nope' as EventName, {}), /unknown event/);
    assert.throws(() => build('__proto__' as EventName, {}), /unknown event/);
    assert.throws(() => build('first_beacon', { host: 'x' }), /may not carry/);
    assert.throws(() => build('heartbeat', { constructor: 1 }), /may not carry/);
    assert.throws(() => build('heartbeat', { sites: '2' }), /telemetry/);
    assert.throws(() => build('heartbeat', { sites: { a: 1 } }), /telemetry/);
    assert.throws(() => build('heartbeat', { sites: 1.5 }), /telemetry/);
    assert.throws(() => build('heartbeat', { beacons_per_day: '12345' }), /telemetry/);
    assert.throws(() => build('analysis_run', { rules: { r1_hosting_asn: 'x' } }), /telemetry/);
    assert.throws(() => build('analysis_run', { via: 'chat' }), /telemetry/);
  });

  it('keeps the module free of any import path to click data', () => {
    const src = readFileSync(new URL('../src/telemetry/index.ts', import.meta.url), 'utf8');
    const specifiers = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort();
    assert.deepEqual(specifiers, ['../config.js', '../db.js', 'node:crypto']);
    assert.doesNotMatch(src, /FROM\s+events/i);
  });
});
