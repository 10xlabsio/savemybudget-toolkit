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

export type EventName = 'instance_started' | 'snippet_generated' | 'first_beacon' | 'heartbeat' | 'analysis_run' | 'claim_package' | 'error';

type Scalar = string | number | boolean;
export type Props = Record<string, Scalar | Record<string, number>>;

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

type Check = (v: unknown) => boolean;
const oneOf = (...allowed: string[]): Check => (v) => typeof v === 'string' && allowed.includes(v);
const bool: Check = (v) => typeof v === 'boolean';
/** Whole number, small enough that a 10-digit identifier cannot fit. */
const count = (min = 0, max = 99_999_999): Check => (v) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const VERSION = /^v?\d{1,3}(\.\d{1,3}){0,2}(-[0-9A-Za-z.]{1,16})?$/;
const versionString: Check = (v) => typeof v === 'string' && v.length <= 32 && VERSION.test(v);
const errorClass: Check = (v) => typeof v === 'string' && /^[A-Za-z]{0,32}Error$/.test(v);
const ruleCounts: Check = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = Object.entries(v as Record<string, unknown>);
  return e.length <= 40 && e.every(([k, n]) => /^r\d{1,2}_[a-z0-9_]{1,40}$/.test(k) && count()(n));
};

const BUCKET = oneOf('0', '<1k', '1k-10k', '10k-100k', '>100k');
const SHARE = oneOf('0', '<5%', '5-20%', '>20%');
const SIZE = oneOf('<100MB', '100MB-1GB', '1-5GB', '>5GB');

/**
 * The only keys each event may carry, and the only values each key may hold.
 * Free text, identifiers, addresses and hostnames cannot pass: a key that is
 * not listed throws, and so does a value outside its enum, bucket or range.
 * A new field means a new line here, in TELEMETRY.md and in the tests.
 */
export const ALLOWED: Record<EventName, Record<string, Check>> = {
  instance_started: {
    version: versionString,
    node: versionString,
    os: oneOf('aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'),
    arch: oneOf('arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64'),
    deploy_method: oneOf('compose', 'docker', 'npm'),
    first_boot: bool,
  },
  snippet_generated: { consent_mode: oneOf('legitimate_interest', 'consent_gated') },
  first_beacon: { hours_since_install: count(-999_999, 999_999) },
  heartbeat: {
    beacons_per_day: BUCKET,
    distinct_gclids: BUCKET,
    sites: count(),
    imports_used: bool,
    store_size: SIZE,
    uptime_hours: count(),
    sdk_errors: count(),
    mcp_enabled: bool,
    mcp_calls: count(),
  },
  analysis_run: {
    rules: ruleCounts,
    flagged_share: SHARE,
    window_days: count(0, 3660),
    sources_beacon: bool,
    sources_log: bool,
    sources_csv: bool,
    via: oneOf('mcp'),
  },
  claim_package: { flagged_rows: BUCKET, exclusions: bool, via: oneOf('mcp') },
  error: { stage: oneOf('collect', 'parse', 'enrich', 'score', 'write'), error_class: errorClass },
};

/** Pure: builds the wire payload. Throws on any event, key or value outside ALLOWED. */
export function payload(event: EventName, props: Props, instance: string, version: string) {
  const spec = Object.hasOwn(ALLOWED, event) ? ALLOWED[event] : undefined;
  if (!spec) throw new Error('telemetry: unknown event');
  const clean: Record<string, Scalar | Record<string, number>> = {};
  for (const [k, v] of Object.entries(props)) {
    const check = Object.hasOwn(spec, k) ? spec[k] : undefined;
    if (!check) throw new Error(`telemetry: ${event} may not carry ${k}`);
    if (!check(v)) throw new Error(`telemetry: value for ${event}.${k} is outside its allowed set`);
    clean[k] = v as Scalar | Record<string, number>;
  }
  return {
    api_key: config.posthogKey,
    event,
    distinct_id: instance,
    properties: { ...clean, toolkit_version: version, $lib: 'smb-toolkit' },
    timestamp: new Date().toISOString(),
  };
}

let sending = false;
export function track(event: EventName, props: Props = {}) {
  if (!enabled()) return;
  try {
    const body = JSON.stringify(payload(event, props, instanceId(), config.version));
    if (sending && event === 'heartbeat') return;
    sending = true;
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
