// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/** Row-level validation shared by the CSV and log paths (docs/inputs.md "Validation"). */
import { isIP } from 'node:net';
import { isPrivateIp } from '../enrich/index.js';
import { gclidFromPath } from './parse-log.js';

export const GCLID_RE = /^[A-Za-z0-9_-]{20,120}$/;
export const MIN_USABLE_ROWS = 20;
export const MAX_BAD_ROW_SHARE = 0.2;
export const MAX_PRIVATE_SHARE = 0.5;
export const FUTURE_SKEW_MS = 3600_000;

export const CAPS = { timestamp: 64, ip: 64, gclid: 256, ua: 1024, url: 4096, referer: 4096, campaign: 256 } as const;

export type DropReason = 'outside_window' | 'private_ip' | 'no_gclid' | 'duplicate' | 'bad_row' | 'no_gclid_line';
export type Dropped = Record<DropReason, number>;
export const emptyDropped = (): Dropped => ({ outside_window: 0, private_ip: 0, no_gclid: 0, duplicate: 0, bad_row: 0, no_gclid_line: 0 });

export interface ParsedRow {
  ts: string; // ISO UTC
  ip: string;
  gclid: string;
  ua: string | null;
  url: string | null;
  referer: string | null;
  campaign: string | null;
  line: number;
}

/** A row as extracted from the file, before validation. `tsMs` set when the format already parsed the time (logs). */
export interface RawRow {
  ts?: string;
  tsMs?: number | null;
  ip: string;
  gclid: string;
  ua: string | null;
  url: string | null;
  referer: string | null;
  campaign: string | null;
  line: number;
}

// ---------- timestamps ----------

export type TsKind = 'iso' | 'naive' | 'unix';

const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|z|[+-]\d{2}:?\d{2})$/;
const NAIVE_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?))?$/;
const UNIX_S_RE = /^\d{10}$/;
const UNIX_MS_RE = /^\d{13}$/;

export function parseTimestamp(raw: string): { ms: number; kind: TsKind } | null {
  const s = raw.trim();
  if (!s) return null;
  if (UNIX_S_RE.test(s)) return { ms: Number(s) * 1000, kind: 'unix' };
  if (UNIX_MS_RE.test(s)) return { ms: Number(s), kind: 'unix' };
  if (ISO_RE.test(s)) {
    const ms = Date.parse(s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return Number.isNaN(ms) ? null : { ms, kind: 'iso' };
  }
  const m = s.match(NAIVE_RE);
  if (m) {
    const ms = Date.parse(`${m[1]}T${m[2] ?? '00:00:00'}Z`);
    return Number.isNaN(ms) ? null : { ms, kind: 'naive' };
  }
  return null;
}

// ---------- validation ----------

export interface ValidationResult {
  rows: ParsedRow[];
  dropped: Dropped;
  warnings: string[];
  errors: { message: string; lines?: number[] }[];
  badLines: number[];
  /** rows that reached row checks (excludes no_gclid_line) */
  candidates: number;
}

export interface ValidateOpts { retentionDays: number; now?: Date; noGclidLines?: number }

const cut = (v: string | null, max: number) => (v === null ? null : v.length > max ? v.slice(0, max) : v);
const nz = (v: string | null | undefined) => { const t = (v ?? '').trim(); return t === '' || t === '-' ? null : t; };

export function validateRows(raw: RawRow[], opts: ValidateOpts): ValidationResult {
  const nowMs = (opts.now ?? new Date()).getTime();
  const oldest = nowMs - opts.retentionDays * 86_400_000;
  const dropped = emptyDropped();
  dropped.no_gclid_line = opts.noGclidLines ?? 0;
  const rows: ParsedRow[] = [];
  const badLines: number[] = [];
  const seen = new Set<string>();
  const kinds = new Set<TsKind>();
  let validIp = 0;
  let privateIp = 0;

  for (const r of raw) {
    // timestamp
    let tsMs: number | null = null;
    if (r.tsMs !== undefined) tsMs = r.tsMs;
    else {
      const tsRaw = r.ts ?? '';
      if (tsRaw.length > CAPS.timestamp) { dropped.bad_row++; badLines.push(r.line); continue; }
      const p = parseTimestamp(tsRaw);
      if (p) { tsMs = p.ms; kinds.add(p.kind); }
    }
    if (tsMs === null || tsMs > nowMs + FUTURE_SKEW_MS) { dropped.bad_row++; badLines.push(r.line); continue; }

    // ip
    const ip = r.ip.trim();
    if (ip.length > CAPS.ip || !isIP(ip)) { dropped.bad_row++; badLines.push(r.line); continue; }
    validIp++;

    // gclid (fall back to url)
    let gclid = r.gclid.trim();
    const url = nz(r.url);
    if (!gclid && url) gclid = gclidFromPath(url) ?? '';
    if (!gclid) { dropped.no_gclid++; continue; }
    if (gclid.length > CAPS.gclid || !GCLID_RE.test(gclid)) { dropped.bad_row++; badLines.push(r.line); continue; }

    if (isPrivateIp(ip)) { privateIp++; dropped.private_ip++; continue; }
    if (tsMs < oldest) { dropped.outside_window++; continue; }

    const ts = new Date(tsMs).toISOString();
    const key = `${ts}\u0000${ip}\u0000${gclid}`;
    if (seen.has(key)) { dropped.duplicate++; continue; }
    seen.add(key);

    rows.push({
      ts, ip, gclid,
      ua: cut(nz(r.ua), CAPS.ua),
      url: cut(url, CAPS.url),
      referer: cut(nz(r.referer), CAPS.referer),
      campaign: cut(nz(r.campaign), CAPS.campaign),
      line: r.line,
    });
  }

  const warnings: string[] = [];
  const errors: { message: string; lines?: number[] }[] = [];
  const candidates = raw.length;

  if (kinds.has('naive')) warnings.push('Some timestamps have no timezone (YYYY-MM-DD HH:MM:SS). They were treated as UTC.');
  if (kinds.has('unix')) warnings.push('Some timestamps are Unix epoch values. They were treated as UTC.');

  if (candidates > 0 && dropped.bad_row / candidates > MAX_BAD_ROW_SHARE) {
    errors.push({
      message: `${dropped.bad_row} of ${candidates} rows (${pct(dropped.bad_row / candidates)}) failed row checks (bad timestamp, IP or click ID). Fix the export and try again.`,
      lines: badLines.slice(0, 50),
    });
  }
  if (validIp > 0 && privateIp / validIp > MAX_PRIVATE_SHARE) {
    errors.push({
      message: `${pct(privateIp / validIp)} of rows carry private addresses (10.x, 172.16-31.x, 192.168.x). Your log is recording the proxy or CDN, not the visitor. Log the forwarded client IP (X-Forwarded-For, or CF-Connecting-IP behind Cloudflare) and export again.`,
    });
  }
  if (errors.length === 0 && rows.length < MIN_USABLE_ROWS) {
    errors.push({ message: `Only ${rows.length} usable row${rows.length === 1 ? '' : 's'} found; at least ${MIN_USABLE_ROWS} are needed for analysis.` });
  }

  warnings.push(...qualityWarnings(rows));
  return { rows, dropped, warnings, errors, badLines, candidates };
}

export function qualityWarnings(rows: ParsedRow[]): string[] {
  const w: string[] = [];
  if (rows.length < 2) return w;
  const secs = new Set(rows.map((r) => r.ts.slice(0, 19)));
  if (secs.size === 1) w.push('Every row has the same timestamp. Check that the export includes the real click time.');
  const ipCounts = new Map<string, number>();
  for (const r of rows) ipCounts.set(r.ip, (ipCounts.get(r.ip) ?? 0) + 1);
  for (const [ip, n] of ipCounts) {
    if (n / rows.length > 0.9) { w.push(`One IP (${ip}) is on ${pct(n / rows.length)} of rows. If that is your proxy or office, the IP rules will not be meaningful.`); break; }
  }
  const gclids = new Set(rows.map((r) => r.gclid));
  if (gclids.size === 1) w.push('Every row has the same click ID. Check that the export includes the real gclid per click.');
  const short = rows.filter((r) => r.gclid.length < 30).length;
  if (short / rows.length > 0.05) w.push(`${pct(short / rows.length)} of click IDs are under 30 characters and look truncated (a spreadsheet may have cut them). Export again as text.`);
  return w;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
