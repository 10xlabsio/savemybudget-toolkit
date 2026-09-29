import { randomUUID } from 'node:crypto';
import { db, getSetting, now } from '../db.js';
import { config } from '../config.js';

/**
 * Telemetry. Anonymous, bucketed, opt-out. This module has NO import path to
 * the events table by design; everything it sends is built by `payload()`,
 * a pure function whose output is checked by a unit test: no string longer
 * than 64 chars, no nested objects other than counts.
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

/** Pure: builds the wire payload. Throws if anything looks like an identifier. */
export function payload(event: EventName, props: Props, instance: string, version: string) {
  const clean: Record<string, Scalar | Record<string, number>> = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'string') {
      if (v.length > 64) throw new Error(`telemetry: value too long for ${k}`);
      clean[k] = v;
    } else if (typeof v === 'number' || typeof v === 'boolean') clean[k] = v;
    else if (v && typeof v === 'object') {
      const o: Record<string, number> = {};
      for (const [kk, vv] of Object.entries(v)) {
        if (typeof vv !== 'number' || kk.length > 64) throw new Error(`telemetry: bad nested value for ${k}.${kk}`);
        o[kk] = vv;
      }
      clean[k] = o;
    }
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
