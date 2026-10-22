// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { randomUUID } from 'node:crypto';
import { db, getSetting, now } from '../db.js';
import { config } from '../config.js';

/**
 * Telemetry. Anonymous, bucketed, opt-out. This module has NO import path to
 * the events table by design; everything it sends is built by `payload()`,
 * a pure function with a per-event allow-list of keys whose values must be an
 * enum, a bucket, a flag or a small count. Anything else throws, and a unit
 * test feeds it identifiers to prove it.
 */

export type Bucket = '0' | '<1k' | '1k-10k' | '10k-100k' | '>100k';
export function bucket(n: number): Bucket {
  if (n <= 0) return '0';
  if (n < 1000) return '<1k';
  if (n < 10000) return '1k-10k';
  if (n < 100000) return '10k-100k';
  return '>100k';
}
export type ShareBucket = '0' | '<5%' | '5-20%' | '>20%';
export function shareBucket(share: number): ShareBucket {
  if (share <= 0) return '0';
  if (share < 0.05) return '<5%';
  if (share <= 0.2) return '5-20%';
  return '>20%';
}
export function mbBucket(mb: number): string {
  if (mb < 100) return '<100MB';
  if (mb < 1000) return '100MB-1GB';
  if (mb < 5000) return '1-5GB';
  return '>5GB';
}

export type HoursBucket = '<1h' | '1-24h' | '1-7d' | '7-30d' | '>30d';
export function hoursBucket(h: number): HoursBucket {
  if (!(h >= 1)) return '<1h';
  if (h < 24) return '1-24h';
  if (h < 168) return '1-7d';
  if (h < 720) return '7-30d';
  return '>30d';
}
/** Window length in days, capped so a very long window still reports instead of being refused. */
export function windowDaysFor(days: number): number {
  return Math.min(WINDOW_DAYS_MAX, Math.max(0, Math.round(Number.isFinite(days) ? days : 0)));
}
/** Per-rule counts as bucket labels. */
export function bucketRules(rules: Record<string, number>): Record<string, Bucket> {
  const out: Record<string, Bucket> = {};
  for (const [k, n] of Object.entries(rules)) out[k] = bucket(n);
  return out;
}
/** Node's major version only, as a small integer. */
export function nodeMajor(v: string = process.version): number {
  return Number.parseInt(v.replace(/^v/, ''), 10);
}
/** What an `instance_started` event carries. */
export function startupProps(deployMethod: string, firstBoot: boolean): Props {
  return { version: config.version, node: nodeMajor(), os: process.platform, arch: process.arch, deploy_method: deployMethod, first_boot: firstBoot };
}

const WINDOW_DAYS_MAX = 366;

export type EventName = 'instance_started' | 'snippet_generated' | 'first_beacon' | 'heartbeat' | 'analysis_run' | 'claim_package' | 'error';

type Scalar = string | number | boolean;
export type Props = Record<string, Scalar | Record<string, string>>;

export function enabled(): boolean {
  if (!config.telemetry) return false;
  const s = getSetting('telemetry');
  if (s === 'off') return false;
  return true;
}

export function instanceId(): string {
  const r = db().prepare('SELECT instance_id FROM telemetry WHERE id = 1').get() as { instance_id: string } | undefined;
  if (r) return r.instance_id;
  const id = randomUUID();
  db().prepare('INSERT INTO telemetry(id,instance_id,enabled,first_boot_at) VALUES(1,?,1,?)').run(id, now());
  return id;
}

export function firstBootAt(): string {
  instanceId();
  const r = db().prepare('SELECT first_boot_at FROM telemetry WHERE id = 1').get() as { first_boot_at: string };
  return r.first_boot_at;
}

/** A check returns the value to send (always a fresh copy of what it checked) or NO to refuse it. */
const NO: unique symbol = Symbol('refused');
type Check = (v: unknown) => unknown;
const oneOf = (...allowed: string[]): Check => (v) => (typeof v === 'string' && allowed.includes(v) ? v : NO);
const bool: Check = (v) => (typeof v === 'boolean' ? v : NO);
/** Whole number inside a realistic range, so a packed address or a 10-digit ID cannot pass as a count. */
const count = (min: number, max: number): Check => (v) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : NO);
const PLAIN_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}(-(alpha|beta|rc)\.\d{1,3})?$/;
/** Only this install's own version string goes on the wire, never a value passed in. */
const versionString: Check = (v) => (typeof v === 'string' && v === config.version && PLAIN_VERSION.test(v) ? v : NO);
/** Built-in error class names; anything else is reported as `OtherError`. */
export const ERROR_CLASSES: readonly string[] = Object.freeze([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'AggregateError', 'SqliteError', 'AbortError', 'TimeoutError', 'OtherError',
]);
/** Maps whatever was thrown to a name from the fixed list. */
export function errorClassOf(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  return ERROR_CLASSES.includes(name) ? name : 'OtherError';
}
const errorClass: Check = oneOf(...ERROR_CLASSES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BUCKETS = ['0', '<1k', '1k-10k', '10k-100k', '>100k'] as const;
const BUCKET = oneOf(...BUCKETS);
const SHARE = oneOf('0', '<5%', '5-20%', '>20%');
const SIZE = oneOf('<100MB', '100MB-1GB', '1-5GB', '>5GB');
const HOURS = oneOf('<1h', '1-24h', '1-7d', '7-30d', '>30d');

/** The detection rules the toolkit ships. `test/telemetry.test.ts` pins this list to the rules module, which this module never imports. */
export const RULE_IDS: readonly string[] = Object.freeze([
  'r1_hosting_asn', 'r3_geo', 'r4_subnet_cluster', 'r6_automation', 'r8_fp_collision',
  'r9_no_beacon', 'r10_zero_dwell', 'r11_dead_session', 'r13_gclid_replay', 'r14_ip_velocity',
]);
/** Plain object, listed rule ids only, bucket labels only. Returns a fresh object; each value is read once. */
const ruleCounts: Check = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return NO;
  const out: Record<string, string> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!RULE_IDS.includes(k)) return NO;
    const checked = BUCKET(n);
    if (checked === NO) return NO;
    out[k] = checked as string;
  }
  return out;
};

/**
 * The only keys each event may carry, and the only values each key may hold.
 * Free text, identifiers, addresses and hostnames cannot pass: a key that is
 * not listed throws, and so does a value outside its enum, bucket or range.
 * A new field means a new line here, in TELEMETRY.md and in the tests.
 */
const SPEC: Record<EventName, Record<string, Check>> = {
  instance_started: {
    version: versionString,
    node: count(1, 99),
    os: oneOf('aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'),
    arch: oneOf('arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64'),
    deploy_method: oneOf('compose', 'docker', 'npm'),
    first_boot: bool,
  },
  snippet_generated: { consent_mode: oneOf('legitimate_interest', 'consent_gated') },
  first_beacon: { hours_since_install: HOURS },
  heartbeat: {
    beacons_per_day: BUCKET,
    distinct_gclids: BUCKET,
    sites: count(0, 1000),
    imports_used: bool,
    store_size: SIZE,
    uptime_hours: HOURS,
    sdk_errors: BUCKET,
    mcp_enabled: bool,
    mcp_calls: BUCKET,
  },
  analysis_run: {
    rules: ruleCounts,
    flagged_share: SHARE,
    window_days: count(0, WINDOW_DAYS_MAX),
    sources_beacon: bool,
    sources_log: bool,
    sources_csv: bool,
    via: oneOf('mcp'),
  },
  claim_package: { flagged_rows: BUCKET, exclusions: bool, via: oneOf('mcp') },
  error: { stage: oneOf('collect', 'parse', 'enrich', 'score', 'write'), error_class: errorClass },
};
export const ALLOWED: Readonly<Record<EventName, Readonly<Record<string, Check>>>> = Object.freeze(
  Object.fromEntries(Object.entries(SPEC).map(([e, spec]) => [e, Object.freeze(spec)])) as Record<EventName, Record<string, Check>>,
);

/** Pure: builds the wire payload. Throws on any event, key or value outside ALLOWED. */
export function payload(event: EventName, props: Props, instance: string, version: string) {
  const spec = Object.hasOwn(ALLOWED, event) ? ALLOWED[event] : undefined;
  if (!spec) throw new Error('telemetry: unknown event');
  if (typeof instance !== 'string' || !UUID.test(instance)) throw new Error('telemetry: instance id is not a UUID');
  if (versionString(version) === NO) throw new Error('telemetry: toolkit version is outside its allowed set');
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const check = Object.hasOwn(spec, k) ? spec[k] : undefined;
    if (!check) throw new Error(`telemetry: ${event} may not carry ${k}`);
    const value = check(v);
    if (value === NO) throw new Error(`telemetry: value for ${event}.${k} is outside its allowed set`);
    clean[k] = value;
  }
  return {
    api_key: config.posthogKey,
    event,
    distinct_id: instance,
    properties: { ...clean, toolkit_version: version, $lib: 'smb-toolkit', $geoip_disable: true },
    timestamp: new Date().toISOString(),
  };
}

let sending = false;
export function track(event: EventName, props: Props = {}) {
  if (!enabled()) return;
  let body: string;
  try {
    body = JSON.stringify(payload(event, props, instanceId(), config.version));
  } catch {
    return; // refused: nothing is sent, and the in-flight flag belongs to the send that set it
  }
  if (sending && event === 'heartbeat') return;
  sending = true;
  try {
    fetch(`${config.posthogHost}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    })
      .catch(() => {})
      .finally(() => { sending = false; });
  } catch {
    sending = false;
  }
}

export function markHeartbeat() {
  db().prepare('UPDATE telemetry SET last_heartbeat_at = ? WHERE id = 1').run(now());
}
export function lastHeartbeat(): string | null {
  const r = db().prepare('SELECT last_heartbeat_at FROM telemetry WHERE id = 1').get() as { last_heartbeat_at: string | null } | undefined;
  return r?.last_heartbeat_at ?? null;
}
export function firstBeaconReported(): boolean {
  const r = db().prepare('SELECT first_beacon_reported FROM telemetry WHERE id = 1').get() as { first_beacon_reported: number } | undefined;
  return !!r?.first_beacon_reported;
}
export function setFirstBeaconReported() {
  db().prepare('UPDATE telemetry SET first_beacon_reported = 1 WHERE id = 1').run();
}

// ---------- version check (separate switch, separate endpoint) ----------

export async function checkForUpdate(): Promise<string | null> {
  if (!config.updateCheck || getSetting('update_check') === 'off') return null;
  try {
    const res = await fetch('https://registry.npmjs.org/@savemybudget/toolkit/latest', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { version?: string };
    return j.version && j.version !== config.version ? j.version : null;
  } catch {
    return null;
  }
}
