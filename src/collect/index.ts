// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { makeRateLimiter } from '../ratelimit.js';
import { config } from '../config.js';
import { bumpCounter, db, getSiteByKey, insertEvent, updateSessionUnload, type NewEvent } from '../db.js';
import { enrichIp, parseUa, subnet24 } from '../enrich/index.js';
import type { Site } from '../types.js';

const BODY_CAP = 64 * 1024;
const RATE_LIMIT = 120; // requests per minute per client (per /64 for IPv6)
/** With SMB_TRUST_PROXY=1: requests per minute from one connecting address — the proxy itself, normally. A backstop
 *  against a client that reaches the port directly and rotates X-Forwarded-For; generous, because behind Caddy
 *  every visitor arrives on this one address. */
const CONNECTION_LIMIT = 6000;
const RATE_WINDOW_MS = 60_000;
const TS_SKEW_MS = 3600_000;

// ---------- payload validation (hand-written, mirrors schema/beacon.v1.json) ----------

export type BeaconType = 'load' | 'ping' | 'unload';

export interface BeaconPayload {
  v: 1;
  t: BeaconType;
  c: string;
  s: string;
  ts: number;
  url: string;
  ref: string;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  sdkv: string;
  fph?: string;
  auto?: { wd?: boolean; hc?: boolean; pl?: number; ln?: number; ch?: boolean; ow?: boolean; cdp?: boolean };
  beh?: { mm?: number; sc?: number; tc?: number; cl?: number; kd?: number; fi?: number; md?: number };
  dwell?: number;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown, max: number, min = 0): x is string => typeof x === 'string' && x.length >= min && x.length <= max;
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStrOrNull = (x: unknown, max: number): x is string | null => x === null || isStr(x, max);

/** Returns a cleaned payload (unknown keys dropped) or null if the shape is invalid. */
export function validateBeacon(raw: unknown): BeaconPayload | null {
  if (!isObj(raw)) return null;
  if (raw.v !== 1) return null;
  if (raw.t !== 'load' && raw.t !== 'ping' && raw.t !== 'unload') return null;
  if (!isStr(raw.c, 64, 1) || !isStr(raw.s, 64, 1)) return null;
  if (!isInt(raw.ts)) return null;
  if (!isStr(raw.url, 4096) || !isStr(raw.ref, 4096)) return null;
  if (!isStrOrNull(raw.gclid, 256) || !isStrOrNull(raw.gbraid, 256) || !isStrOrNull(raw.wbraid, 256)) return null;
  if (!isStr(raw.sdkv, 32)) return null;

  const out: BeaconPayload = {
    v: 1, t: raw.t, c: raw.c, s: raw.s, ts: raw.ts, url: raw.url, ref: raw.ref,
    gclid: raw.gclid, gbraid: raw.gbraid, wbraid: raw.wbraid, sdkv: raw.sdkv,
  };

  if (raw.fph !== undefined) {
    if (!isStr(raw.fph, 64)) return null;
    out.fph = raw.fph;
  }
  if (raw.auto !== undefined) {
    if (!isObj(raw.auto)) return null;
    const a = raw.auto;
    const auto: NonNullable<BeaconPayload['auto']> = {};
    for (const k of ['wd', 'hc', 'ch', 'ow', 'cdp'] as const) {
      if (a[k] !== undefined) { if (typeof a[k] !== 'boolean') return null; auto[k] = a[k] as boolean; }
    }
    for (const k of ['pl', 'ln'] as const) {
      if (a[k] !== undefined) { if (!isInt(a[k])) return null; auto[k] = a[k] as number; }
    }
    out.auto = auto;
  }
  if (raw.beh !== undefined) {
    if (!isObj(raw.beh)) return null;
    const b = raw.beh;
    const beh: NonNullable<BeaconPayload['beh']> = {};
    for (const k of ['mm', 'sc', 'tc', 'cl', 'kd', 'fi'] as const) {
      if (b[k] !== undefined) { if (!isInt(b[k])) return null; beh[k] = b[k] as number; }
    }
    if (b.md !== undefined) { if (!isNum(b.md)) return null; beh.md = b.md; }
    out.beh = beh;
  }
  if (raw.dwell !== undefined) {
    if (!isNum(raw.dwell)) return null;
    out.dwell = raw.dwell;
  }
  return out;
}

// ---------- helpers ----------

export function automationMarkers(auto: BeaconPayload['auto']): string[] {
  if (!auto) return [];
  const m: string[] = [];
  if (auto.wd) m.push('webdriver');
  if (auto.hc) m.push('headless-ua');
  if (auto.pl === 0) m.push('no-plugins');
  if (auto.ln === 0) m.push('no-languages');
  if (auto.ow) m.push('zero-outer-size');
  if (auto.cdp) m.push('cdp');
  return m;
}

function resolveGclid(p: BeaconPayload): string | null {
  if (p.gclid) return p.gclid;
  if (p.gbraid) return 'gbraid:' + p.gbraid;
  if (p.wbraid) return 'wbraid:' + p.wbraid;
  return null;
}

function union(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

function stripMapped(ip: string): string {
  return ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

/** The TCP peer — never taken from headers. Rate limiting keys on this. */
export function socketIp(c: { env?: unknown }): string {
  const env = c.env as Partial<HttpBindings> | undefined;
  const ip = env?.incoming?.socket?.remoteAddress;
  return ip ? stripMapped(ip) : '0.0.0.0';
}

/**
 * The visitor IP to record. With SMB_TRUST_PROXY=1 the proxy in front (Caddy, nginx) APPENDS the address it
 * saw to X-Forwarded-For, so the trustworthy hop is the RIGHTMOST valid address; anything to the left of it was
 * supplied by the client and can say whatever it likes. Without a proxy, the socket address is the visitor.
 */
export function clientIp(c: { req: { header(n: string): string | undefined }; env?: unknown }): string {
  if (config.trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const hops = xff.split(',').map((h) => stripMapped(h.trim())).filter((h) => isIP(h) !== 0);
      if (hops.length) return hops[hops.length - 1];
    }
  }
  return socketIp(c);
}

/**
 * Browser-side forgery check. Browsers always send an Origin header on a cross-origin POST (fetch and
 * sendBeacon alike), so a page on evil.example cannot post a beacon that claims to come from the site: the
 * Origin says where it really came from. We accept the site's host, its www/apex twin and any subdomain
 * (ads may land on shop.example, www.shop.example or promo.shop.example), in Unicode or punycode form.
 * A missing Origin is accepted: same-origin sendBeacon with text/plain, older browsers and curl send none,
 * and a scripted attacker can set any header anyway — that case is covered in SECURITY.md, not here.
 */
export function originAllowed(site: Pick<Site, 'host'>, originHeader: string | undefined, refererHeader: string | undefined): boolean {
  const raw = originHeader ?? refererHeader;
  if (!raw) return true;
  if (raw === 'null') return false;
  let h: string;
  try { h = new URL(raw).hostname.toLowerCase(); } catch { return false; }
  const ascii = domainToASCII(h) || h;
  const siteHost = (domainToASCII(site.host) || site.host).toLowerCase();
  const apex = siteHost.replace(/^www\./, '');
  return ascii === siteHost || ascii === apex || ascii.endsWith('.' + apex);
}

// ---------- rate limit ----------

let rateLimited = makeRateLimiter(RATE_LIMIT, RATE_WINDOW_MS);
let connectionLimited = makeRateLimiter(CONNECTION_LIMIT, RATE_WINDOW_MS);

/** For tests. */
export function resetRateLimit(o: { perConnection?: number } = {}) {
  rateLimited = makeRateLimiter(RATE_LIMIT, RATE_WINDOW_MS);
  connectionLimited = makeRateLimiter(o.perConnection ?? CONNECTION_LIMIT, RATE_WINDOW_MS);
}

/** IPv6 clients are keyed by their /64: one device or home usually holds the whole range. */
export const clientKey = (ip: string) => (isIP(ip) === 6 ? subnet24(ip) : ip);

/**
 * Per visitor, not per proxy. Without SMB_TRUST_PROXY the connecting address is the visitor. With it, the
 * connecting address is the proxy, so the 120/min bucket is keyed on the hop the proxy appended (clientIp), and a
 * much larger per-connection backstop caps anyone who reaches the port directly and makes up X-Forwarded-For.
 * (Keyed only on the connection, a busy site behind Caddy shared one 120/min bucket — and a distributed click
 * burst, the thing worth recording, was dropped.)
 */
function beaconLimited(c: { req: { header(n: string): string | undefined }; env?: unknown }): boolean {
  const socket = socketIp(c);
  if (!config.trustProxy) return rateLimited(clientKey(socket));
  if (connectionLimited(socket)) return true;
  return rateLimited(clientKey(clientIp(c)));
}

// ---------- event handling ----------

interface SessionRow { id: number; automation: string | null; fp_hash: string | null }

function findSession(siteId: number, sessionId: string): SessionRow | null {
  const r = db()
    .prepare("SELECT id, automation, fp_hash FROM events WHERE site_id = ? AND session_id = ? AND source = 'beacon' ORDER BY id LIMIT 1")
    .get(siteId, sessionId) as SessionRow | undefined;
  return r ?? null;
}

function buildEvent(site: Site, p: BeaconPayload, gclid: string, ip: string, uaHeader: string | null, nowMs: number): NewEvent {
  const received = new Date(nowMs).toISOString();
  const ts = Math.abs(p.ts - nowMs) <= TS_SKEW_MS ? new Date(p.ts).toISOString() : received;
  const ua = uaHeader ? uaHeader.slice(0, 1024) : null;
  const uaInfo = parseUa(ua);
  const automation = union(uaInfo.automation, automationMarkers(p.auto));
  const en = enrichIp(ip);
  const dwell = p.t === 'unload' ? Math.round(p.dwell ?? 0) : null;
  return {
    site_id: site.id,
    source: 'beacon',
    upload_id: null,
    received_at: received,
    ts,
    ip,
    ip_private: en.ip_private,
    asn: en.asn,
    asn_name: en.asn_name,
    is_hosting: en.is_hosting,
    country: en.country,
    ua,
    ua_family: uaInfo.family,
    gclid,
    is_test: gclid.startsWith('SMBTEST') ? 1 : 0,
    session_id: p.s,
    fp_hash: p.fph ?? null,
    dwell_ms: dwell,
    visible: p.t === 'unload' ? ((p.dwell ?? 0) > 0 ? 1 : 0) : null,
    interactions: p.t === 'unload' ? interactionsOf(p) : null,
    automation: automation.length ? automation : null,
    url: p.url ? p.url.slice(0, 4096) : null,
    referer: p.ref ? p.ref.slice(0, 4096) : null,
    campaign: null,
  };
}

function interactionsOf(p: BeaconPayload): number {
  const b = p.beh;
  if (!b) return 0;
  return (b.mm ?? 0) + (b.sc ?? 0) + (b.tc ?? 0) + (b.cl ?? 0) + (b.kd ?? 0);
}

function mergeSession(row: SessionRow, p: BeaconPayload) {
  const d = db();
  if (p.fph && !row.fp_hash) {
    d.prepare("UPDATE events SET fp_hash = COALESCE(fp_hash, ?) WHERE id = ?").run(p.fph, row.id);
  }
  if (p.auto) {
    const existing: string[] = row.automation ? JSON.parse(row.automation) : [];
    const merged = union(existing, automationMarkers(p.auto));
    if (merged.length !== existing.length) {
      d.prepare('UPDATE events SET automation = ? WHERE id = ?').run(JSON.stringify(merged), row.id);
    }
  }
}

/** Process one validated beacon. Exported for tests; never throws on bad input. */
export function handleBeacon(site: Site, p: BeaconPayload, ip: string, uaHeader: string | null, nowMs = Date.now()) {
  const gclid = resolveGclid(p);
  const existing = findSession(site.id, p.s);

  if (p.t === 'load') {
    if (!gclid) { bumpCounter('collect_no_gclid'); return; }
    if (existing) { mergeSession(existing, p); return; } // duplicate load for a session: don't double-insert
    insertEvent(buildEvent(site, p, gclid, ip, uaHeader, nowMs));
    return;
  }

  if (p.t === 'ping') {
    if (existing) { mergeSession(existing, p); return; }
    if (!gclid) { bumpCounter('collect_no_gclid'); return; }
    insertEvent(buildEvent(site, p, gclid, ip, uaHeader, nowMs));
    return;
  }

  // unload
  if (existing) {
    const dwell = p.dwell ?? 0;
    updateSessionUnload(site.id, p.s, {
      dwell_ms: Math.round(dwell),
      visible: dwell > 0 ? 1 : 0,
      interactions: interactionsOf(p),
    });
    mergeSession(existing, p);
    return;
  }
  if (!gclid) { bumpCounter('collect_no_gclid'); return; }
  insertEvent(buildEvent(site, p, gclid, ip, uaHeader, nowMs));
}

// ---------- app ----------

export const collectApp = new Hono<{ Bindings: HttpBindings }>();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

collectApp.use('*', async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(CORS)) c.res.headers.set(k, v);
});

collectApp.options('*', (c) => c.body(null, 204));

collectApp.post('/v1/beacon', async (c) => {
  if (beaconLimited(c)) { bumpCounter('collect_ratelimited'); return c.body(null, 204); }
  const ip = clientIp(c);

  const len = Number(c.req.header('content-length') ?? '0');
  if (len > BODY_CAP) { bumpCounter('collect_invalid'); return c.body(null, 204); }

  let text: string;
  try {
    const buf = await c.req.arrayBuffer();
    if (buf.byteLength > BODY_CAP) { bumpCounter('collect_invalid'); return c.body(null, 204); }
    text = new TextDecoder('utf-8').decode(buf);
  } catch {
    bumpCounter('collect_invalid'); return c.body(null, 204);
  }

  let raw: unknown;
  try { raw = JSON.parse(text); } catch { bumpCounter('collect_invalid'); return c.body(null, 204); }
  const p = validateBeacon(raw);
  if (!p) { bumpCounter('collect_invalid'); return c.body(null, 204); }

  const site = getSiteByKey(p.c);
  if (!site) { bumpCounter('collect_unknown_key'); return c.body(null, 204); }
  if (!originAllowed(site, c.req.header('origin'), c.req.header('referer'))) { bumpCounter('collect_bad_origin'); return c.body(null, 204); }

  try {
    handleBeacon(site, p, ip, c.req.header('user-agent') ?? null);
  } catch {
    bumpCounter('collect_errors');
  }
  return c.body(null, 204);
});

collectApp.post('/v1/sdk-error', (c) => {
  bumpCounter('sdk_errors');
  return c.body(null, 204);
});

collectApp.get('/healthz', (c) => c.json({ ok: true, version: config.version }));
