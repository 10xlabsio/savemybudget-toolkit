// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { bumpDataGeneration, db, listSites, getSetting, now, getCounter } from '../db.js';
import { config } from '../config.js';
import * as telemetry from '../telemetry/index.js';
import { mcpEnabled } from '../mcp/token.js';
import { sweepOAuth } from '../mcp/oauth.js';

// ---------- notifications ----------

export type NotificationKind = 'tag_silent' | 'never_installed' | 'first_beacon' | 'window_reminder' | 'private_ips' | 'update_available' | 'disk';

export interface Notification {
  id: number; site_id: number | null; kind: NotificationKind; payload: Record<string, unknown>; created_at: string; dismissed_at: string | null;
}

export function notify(siteId: number | null, kind: NotificationKind, dedupeKey: string, payload: Record<string, unknown> = {}) {
  db().prepare('INSERT OR IGNORE INTO notifications(site_id,kind,dedupe_key,payload,created_at) VALUES(?,?,?,?,?)')
    .run(siteId, kind, dedupeKey, JSON.stringify(payload), now());
}
export function clearNotifications(siteId: number | null, kind: NotificationKind) {
  db().prepare('DELETE FROM notifications WHERE kind = ? AND site_id IS ?').run(kind, siteId);
}
export function activeNotifications(siteId?: number | null): Notification[] {
  const rows = siteId === undefined
    ? db().prepare('SELECT * FROM notifications WHERE dismissed_at IS NULL ORDER BY created_at DESC').all()
    : db().prepare('SELECT * FROM notifications WHERE dismissed_at IS NULL AND (site_id IS ? OR site_id IS NULL) ORDER BY created_at DESC').all(siteId);
  return (rows as any[]).map(r => ({ ...r, payload: JSON.parse(r.payload) }));
}
export function dismissNotification(id: number) {
  db().prepare('UPDATE notifications SET dismissed_at = ? WHERE id = ?').run(now(), id);
}

// ---------- settings with env fallback ----------

export function retentionDays(): number {
  const s = getSetting('retention_days');
  return Math.max(60, s ? Number(s) : config.retentionDays);
}
export function silentThresholdHours(): number {
  const s = getSetting('silent_threshold_hours');
  return s ? Number(s) : 48;
}

export function storeSizeMb(): number {
  let bytes = 0;
  const walk = (p: string) => {
    for (const f of readdirSync(p, { withFileTypes: true })) {
      const fp = join(p, f.name);
      if (f.isDirectory()) walk(fp); else bytes += statSync(fp).size;
    }
  };
  try { walk(config.dataDir); } catch { /* ignore */ }
  return bytes / 1048576;
}

// ---------- staged uploads ----------

const STAGED_RE = /^[a-f0-9]{24}\.bin$/;
export const STAGED_MAX_AGE_MS = 3600e3;

/**
 * "Check file" stages the upload as data/uploads/<token>.bin + .json until it is imported. A preview that was
 * rejected or abandoned would otherwise stay forever; anything older than an hour is removed here.
 */
export function sweepStagedUploads(nowMs = Date.now(), maxAgeMs = STAGED_MAX_AGE_MS): number {
  const dir = join(config.dataDir, 'uploads');
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!STAGED_RE.test(name)) continue;
    let at: number | null = null;
    try { at = Number((JSON.parse(readFileSync(join(dir, name + '.json'), 'utf8')) as { at?: number }).at) || null; } catch { /* no meta */ }
    if (at === null) { try { at = statSync(join(dir, name)).mtimeMs; } catch { continue; } }
    if (nowMs - at > maxAgeMs) {
      for (const p of [join(dir, name), join(dir, name + '.json')]) { try { unlinkSync(p); } catch { /* gone */ } }
      removed++;
    }
  }
  return removed;
}

// ---------- hourly tick ----------

export function hourlyTick(nowDate = new Date()) {
  const d = db();
  const nowIso = nowDate.toISOString();

  // Expired sign-in codes and tokens
  try { sweepOAuth(nowDate.getTime()); } catch (e) { log('oauth sweep failed', e); }

  // Retention purge
  const cutoff = new Date(nowDate.getTime() - retentionDays() * 86400e3).toISOString();
  if (Number(d.prepare('DELETE FROM events WHERE ts < ?').run(cutoff).changes) > 0) bumpDataGeneration();

  // Staged uploads nobody imported
  sweepStagedUploads(nowDate.getTime());

  const threshold = silentThresholdHours();
  for (const site of listSites()) {
    const createdH = (nowDate.getTime() - Date.parse(site.created_at)) / 3600e3;

    // never_installed: created > 48h ago, no beacon ever
    if (!site.first_event_at) {
      if (createdH > 48) notify(site.id, 'never_installed', 'once');
      continue;
    }
    clearNotifications(site.id, 'never_installed');

    // first_beacon celebration (once)
    notify(site.id, 'first_beacon', 'once', { at: site.first_event_at });

    // tag_silent
    const silentH = site.last_seen_at ? (nowDate.getTime() - Date.parse(site.last_seen_at)) / 3600e3 : Infinity;
    if (silentH > threshold) {
      // dedupe per silence episode: key on last_seen_at
      notify(site.id, 'tag_silent', site.last_seen_at ?? 'never', { hours: Math.round(silentH), threshold });
    } else {
      clearNotifications(site.id, 'tag_silent');
    }

    // private_ips: >50% of last 7 days
    const wk = new Date(nowDate.getTime() - 7 * 86400e3).toISOString();
    const r = d.prepare('SELECT COUNT(*) AS n, SUM(ip_private) AS p FROM events WHERE site_id = ? AND ts >= ?').get(site.id, wk) as { n: number; p: number | null };
    if (r.n >= 20 && (r.p ?? 0) / r.n > 0.5) notify(site.id, 'private_ips', nowIso.slice(0, 10), { share: Math.round(((r.p ?? 0) / r.n) * 100) });
    else clearNotifications(site.id, 'private_ips');

    // window_reminder: flagged clicks older than 45 days, not yet packaged; once per 30 days
    const old = new Date(nowDate.getTime() - 45 * 86400e3).toISOString();
    const flagged = d.prepare(`SELECT MIN(e.ts) AS oldest FROM verdicts v JOIN analyses a ON a.id = v.analysis_id JOIN events e ON e.id = v.event_id
      WHERE a.site_id = ? AND v.verdict = 'flag' AND e.ts < ? AND NOT EXISTS (SELECT 1 FROM packages p WHERE p.analysis_id = a.id)`).get(site.id, old) as { oldest: string | null };
    if (flagged.oldest) {
      const leaves = new Date(Date.parse(flagged.oldest) + config.claimWindowDays * 86400e3).toISOString().slice(0, 10);
      const monthKey = nowIso.slice(0, 7);
      notify(site.id, 'window_reminder', monthKey, { oldest: flagged.oldest.slice(0, 10), leaves });
    }
  }

  // disk
  const mb = storeSizeMb();
  if (mb > config.storeWarnMb) notify(null, 'disk', nowIso.slice(0, 10), { mb: Math.round(mb) });

  // first_beacon telemetry (once per instance)
  if (!telemetry.firstBeaconReported()) {
    const first = listSites().map(s => s.first_event_at).filter(Boolean).sort()[0];
    if (first) {
      const hours = Math.round((Date.parse(first) - Date.parse(telemetry.firstBootAt())) / 3600e3);
      telemetry.track('first_beacon', { hours_since_install: hours });
      telemetry.setFirstBeaconReported();
    }
  }
}

// ---------- daily ----------

export async function dailyTick(nowDate = new Date()) {
  const last = telemetry.lastHeartbeat();
  if (!last || nowDate.getTime() - Date.parse(last) >= 23 * 3600e3) {
    const d = db();
    const day = new Date(nowDate.getTime() - 86400e3).toISOString();
    const b = d.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT gclid) AS g FROM events WHERE source = 'beacon' AND received_at >= ?").get(day) as { n: number; g: number };
    const sites = d.prepare('SELECT COUNT(*) AS n FROM sites').get() as { n: number };
    const uploads = d.prepare('SELECT COUNT(*) AS n FROM uploads').get() as { n: number };
    telemetry.track('heartbeat', {
      beacons_per_day: telemetry.bucket(b.n),
      distinct_gclids: telemetry.bucket(b.g),
      sites: sites.n,
      imports_used: uploads.n > 0,
      store_size: telemetry.mbBucket(storeSizeMb()),
      uptime_hours: Math.round(process.uptime() / 3600),
      sdk_errors: getCounter('sdk_errors'),
      mcp_enabled: mcpEnabled(),
      mcp_calls: getCounter('mcp_calls'),
    });
    telemetry.markHeartbeat();
  }
  const latest = await telemetry.checkForUpdate();
  if (latest) notify(null, 'update_available', latest, { version: latest });
}

let timers: NodeJS.Timeout[] = [];
export function startJobs() {
  const jitter = Math.floor(Math.random() * 60000);
  const run = () => { try { hourlyTick(); } catch (e) { log('hourly tick failed', e); } };
  const runDaily = () => { dailyTick().catch(e => log('daily tick failed', e)); };
  timers.push(setTimeout(() => { run(); timers.push(setInterval(run, 3600e3)); }, 5000 + jitter));
  timers.push(setTimeout(() => { runDaily(); timers.push(setInterval(runDaily, 6 * 3600e3)); }, 15000 + jitter));
}
export function stopJobs() { for (const t of timers) clearTimeout(t); timers = []; }

export function log(msg: string, err?: unknown) {
  const line = `[${new Date().toISOString()}] ${msg}` + (err instanceof Error ? ` — ${err.name}` : '');
  console.log(line);
  if (err && config.logLevel === 'debug') console.log(err);
}
