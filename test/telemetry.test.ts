// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SMB_DATA_DIR = mkdtempSync(join(tmpdir(), 'smb-telemetry-'));

const { payload, ALLOWED, RULE_IDS, ERROR_CLASSES, errorClassOf, bucket, bucketRules, hoursBucket, windowDaysFor, nodeMajor } = await import('../src/telemetry/index.js');
const { RULES } = await import('../src/rules/index.js');
const { config } = await import('../src/config.js');
type EventName = import('../src/telemetry/index.js').EventName;

const INSTANCE = '3f2b8c1e-5d4a-4e7b-9c6d-1a2b3c4d5e6f';
const build = (event: EventName, props: Record<string, unknown>) => payload(event, props as never, INSTANCE, '1.1.0');

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
      ['instance_started', { version: '1.1.0', node: 22, os: 'linux', arch: 'x64', deploy_method: 'compose', first_boot: true }],
      ['snippet_generated', { consent_mode: 'consent_gated' }],
      ['first_beacon', { hours_since_install: '1-24h' }],
      ['heartbeat', { beacons_per_day: '1k-10k', distinct_gclids: '<1k', sites: 2, imports_used: false, store_size: '<100MB', uptime_hours: '1-7d', sdk_errors: '0', mcp_enabled: true, mcp_calls: '<1k' }],
      ['analysis_run', { rules: { r1_hosting_asn: '<1k', r13_gclid_replay: '0' }, flagged_share: '5-20%', window_days: 7, sources_beacon: true, sources_log: false, sources_csv: false, via: 'mcp' }],
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
    assert.throws(() => build('analysis_run', { rules: { r1_hosting_asn: 4 } }), /telemetry/);
    assert.throws(() => build('analysis_run', { via: 'chat' }), /telemetry/);
  });

  it('keeps the module free of any import path to click data', () => {
    const src = readFileSync(new URL('../src/telemetry/index.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const specifiers = [
      ...code.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g),
      ...code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
      ...code.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g),
    ].map((m) => m[1]).sort();
    assert.deepEqual(specifiers, ['../config.js', '../db.js', 'node:crypto']);
    assert.doesNotMatch(code, /\bimport\s*\((?!\s*['"])/, 'no computed dynamic import');
    assert.doesNotMatch(code, /\brequire\s*\(/);
    assert.doesNotMatch(code, /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?!telemetry\b)\w+/i);
    for (const table of ['events', 'verdicts', 'analyses', 'packages', 'uploads', 'leads', 'ads_']) {
      assert.doesNotMatch(code, new RegExp(`\\b${table}`, 'i'), table);
    }
  });
});


describe('telemetry version and instance id', () => {
  const odd = ['1.1.0-203.0.113.7', '1.1.0-shop.example.com', '0-1234567890', '1.1.0+meta', '1.1.0\n', '1.1.1', '192.168.1', '9.9.9', ''];
  for (const v of odd) {
    it(`refuses version ${JSON.stringify(v)} in the field and as the toolkit version`, () => {
      assert.throws(() => build('instance_started', { version: v }), /telemetry/);
      assert.throws(() => payload('first_beacon', {}, INSTANCE, v), /toolkit version/);
    });
  }
  it('accepts only this install\'s own version', () => {
    assert.equal(config.version, '1.1.0');
    assert.equal(payload('first_beacon', {}, INSTANCE, config.version).properties.toolkit_version, config.version);
  });
  for (const id of ['', 'not-a-uuid', '203.0.113.7', '1234567890', 'shop.example.com', INSTANCE + 'x', INSTANCE + '\n']) {
    it(`refuses instance id ${JSON.stringify(id)}`, () => {
      assert.throws(() => payload('first_beacon', {}, id, '1.1.0'), /UUID/);
    });
  }
});

describe('telemetry frozen tables and rule list', () => {
  it('RULE_IDS equals the shipped rules, sorted', () => {
    assert.deepEqual([...RULE_IDS].sort(), RULES.map((r: { id: string }) => r.id).sort());
  });
  it('ALLOWED, each event spec, RULE_IDS and ERROR_CLASSES are frozen', () => {
    assert.ok(Object.isFrozen(ALLOWED));
    for (const [event, spec] of Object.entries(ALLOWED)) assert.ok(Object.isFrozen(spec), event);
    assert.ok(Object.isFrozen(RULE_IDS));
    assert.ok(Object.isFrozen(ERROR_CLASSES));
    assert.throws(() => { (ALLOWED as any).extra = {}; }, TypeError);
    assert.throws(() => { (ALLOWED.heartbeat as any).host = () => 'x'; }, TypeError);
    assert.throws(() => { (ALLOWED.heartbeat as any).sites = () => 'x'; }, TypeError);
    assert.throws(() => { (RULE_IDS as any).push('x'); }, TypeError);
    assert.throws(() => { (ERROR_CLASSES as any).push('x'); }, TypeError);
  });
});

describe('telemetry rule counts', () => {
  const rulesOf = (rules: unknown) => build('analysis_run', { rules });
  it('refuses keys that merely look like rule ids or encode an address', () => {
    for (const k of ['r1_203_0_113_7', 'r1_hosting_asn ', 'R1_HOSTING_ASN', '203_0_113_7', 'r99_x', 'toJSON', 'constructor']) {
      assert.throws(() => rulesOf({ [k]: '0' }), /telemetry/, k);
    }
    assert.throws(() => rulesOf(JSON.parse('{"__proto__":{"r1_hosting_asn":"0"}}')), /telemetry/);
  });
  it('refuses a URL object, a null-prototype object, an array, a Map, a class instance and primitives', () => {
    class Counts { r1_hosting_asn = '0'; }
    const nullProto = Object.assign(Object.create(null), { r1_hosting_asn: '0' });
    for (const v of [new URL('https://shop.example.com/?gclid=abc'), nullProto, ['0'], new Map([['r1_hosting_asn', '0']]), new Counts(), 'r1_hosting_asn', 7, null, undefined, () => ({})]) {
      assert.throws(() => rulesOf(v), /telemetry/);
    }
  });
  it('refuses an own toJSON and never lets a function through', () => {
    assert.throws(() => rulesOf({ r1_hosting_asn: '0', toJSON: () => ({ ip: '203.0.113.7' }) }), /telemetry/);
    assert.throws(() => rulesOf({ r1_hosting_asn: () => '0' }), /telemetry/);
  });
  it('reads a getter once and sends the value it checked', () => {
    let reads = 0;
    const rules = { get r1_hosting_asn() { reads++; return reads === 1 ? '<1k' : '203.0.113.7'; } };
    const p = rulesOf(rules);
    assert.equal(reads, 1);
    assert.deepEqual(p.properties.rules, { r1_hosting_asn: '<1k' });
    assert.doesNotMatch(JSON.stringify(p), /203\.0\.113/);
    assert.equal(reads, 1);
  });
  it('sends a copy: changing the input afterwards does not change the payload', () => {
    const rules: Record<string, string> = { r1_hosting_asn: '0' };
    const p = rulesOf(rules);
    rules.r1_hosting_asn = '203.0.113.7';
    rules.r3_geo = '>100k';
    assert.deepEqual(p.properties.rules, { r1_hosting_asn: '0' });
    assert.doesNotMatch(JSON.stringify(p), /203\.0\.113/);
  });
});

describe('a packed IPv4 address (16909060) in every field of every event', () => {
  const forms: unknown[] = [16909060, '16909060', -16909060, '-16909060', 16909060.5, '0x1020304', ' 16909060'];
  for (const [event, spec] of Object.entries(ALLOWED)) {
    for (const key of Object.keys(spec)) {
      it(`${event}.${key} refuses it`, () => {
        for (const v of forms) {
          assert.throws(() => build(event as EventName, { [key]: v }), /telemetry/, `${event}.${key} = ${String(v)}`);
        }
      });
    }
  }
  it('refuses it as a rule count', () => {
    for (const v of forms) assert.throws(() => build('analysis_run', { rules: { r1_hosting_asn: v } }), /telemetry/);
  });
});

describe('telemetry error class', () => {
  it('maps to the fixed list with an OtherError fallback', () => {
    assert.equal(errorClassOf(new TypeError('x')), 'TypeError');
    class ShopExampleComError extends Error { override name = 'ShopExampleComError'; }
    assert.equal(errorClassOf(new ShopExampleComError('x')), 'OtherError');
    const e = new Error('x'); e.name = '203.0.113.7Error';
    assert.equal(errorClassOf(e), 'OtherError');
    assert.equal(errorClassOf('boom'), 'OtherError');
    assert.equal(errorClassOf(null), 'OtherError');
  });
  it('refuses a class name outside the list', () => {
    assert.throws(() => build('error', { error_class: 'ShopExampleComError' }), /telemetry/);
    assert.throws(() => build('error', { error_class: '203.0.113.7Error' }), /telemetry/);
    assert.doesNotThrow(() => build('error', { error_class: 'OtherError' }));
  });
});

describe('telemetry helpers', () => {
  it('bucket', () => {
    assert.deepEqual([-5, 0, 1, 999, 1000, 9999, 10000, 99999, 100000, 1e9].map(bucket), ['0', '0', '<1k', '<1k', '1k-10k', '1k-10k', '10k-100k', '10k-100k', '>100k', '>100k']);
  });
  it('bucketRules turns every count into a label and keeps the keys', () => {
    assert.deepEqual(bucketRules({ r1_hosting_asn: 0, r3_geo: 12, r13_gclid_replay: 25000 }), { r1_hosting_asn: '0', r3_geo: '<1k', r13_gclid_replay: '10k-100k' });
    assert.deepEqual(bucketRules({}), {});
  });
  it('hoursBucket', () => {
    assert.deepEqual([NaN, -1, 0, 0.5, 1, 23.9, 24, 167, 168, 719, 720, 5000].map(hoursBucket), ['<1h', '<1h', '<1h', '<1h', '1-24h', '1-24h', '1-7d', '1-7d', '7-30d', '7-30d', '>30d', '>30d']);
  });
  it('windowDaysFor rounds, floors at 0 and caps at 366', () => {
    assert.deepEqual([7, 7.4, 7.6, -3, NaN, Infinity, 366, 367, 100000].map(windowDaysFor), [7, 7, 8, 0, 0, 0, 366, 366, 366]);
  });
  it('nodeMajor keeps the major version only', () => {
    assert.equal(nodeMajor('v22.3.1'), 22);
    assert.equal(nodeMajor('v18.0.0-nightly2022'), 18);
    assert.equal(nodeMajor('20.1.0'), 20);
    assert.equal(nodeMajor(), Number.parseInt(process.versions.node, 10));
  });
});
