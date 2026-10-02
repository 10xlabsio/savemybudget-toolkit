// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * The MCP tool catalogue. Everything returned here is something the toolkit's own UI or evidence file already
 * shows: full IPs, scores, the rules that fired, `watch` rows. The rules are public, so there is nothing to hide
 * (the hosted SaveMyBudget server is deliberately more guarded). Never returned: fingerprint hashes, raw
 * user-agent strings, file-system paths.
 *
 * Handlers call the toolkit's own modules (db, rules, claim, jobs) and nothing else.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { config } from '../config.js';
import { db, getSite, listSites, siteHealth, siteStatus } from '../db.js';
import { subnet24 } from '../enrich/index.js';
import { DEFAULTS, RULES, loadAnalysis, runAnalysis, saveAnalysis } from '../rules/index.js';
import { buildPackage, checkWindow } from '../claim/index.js';
import { activeNotifications, silentThresholdHours } from '../jobs/index.js';
import * as telemetry from '../telemetry/index.js';
import type { AnalysisSummary, RuleHit, ScoredEvent, Site } from '../types.js';
import { analyse, type Analysis } from './analyse.js';
import { LEAD_FIELDS, MAX_LEADS, matchLeads, parseLead } from './leads.js';

export class ToolError extends Error {}

export interface ToolCtx { now: Date; site?: Site }

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** read: changes nothing. action: writes a record or a file under the data directory. */
  kind: 'read' | 'action';
  idempotent: boolean;
  siteScoped: boolean;
  handler(args: Record<string, unknown>, ctx: ToolCtx): unknown;
}

// ---------------------------------------------------------------- constants & small helpers

export const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0);
const bool = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
const int = (v: unknown, dflt: number) => (Number.isInteger(v) ? (v as number) : dflt);

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));
export const describeRule = (id: string) => ({ title: RULE_BY_ID.get(id)?.title ?? id });

function ruleOut(h: RuleHit) {
  return { rule: h.rule, title: RULE_BY_ID.get(h.rule)?.title ?? h.rule, layer: h.layer, kind: h.kind, weight: h.weight, ...(h.note ? { note: h.note } : {}) };
}

/** site_id as an id (number or digits) or a host; `www.` and a scheme/path are ignored; the site name as a last resort. */
export function resolveSite(raw: unknown): Site | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? getSite(raw) : null;
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (/^\d{1,9}$/.test(v)) return getSite(Number(v));
  const host0 = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  const host = domainToASCII(host0) || host0;
  const bare = (h: string) => h.replace(/^www\./, '');
  const sites = listSites();
  return sites.find((s) => s.host === host) ?? sites.find((s) => bare(s.host) === bare(host)) ?? sites.find((s) => s.name.toLowerCase() === v) ?? null;
}

export interface Window { from: string; to: string; days: number }

/** Inclusive UTC days, the same boundaries the Analyse page uses. Default: the 7 days ending today. */
export function parseWindow(args: Record<string, unknown>, now: Date, required = false): Window {
  const today = dayOf(now);
  const f = args.from, t = args.to;
  if (required && (f === undefined || t === undefined)) throw new ToolError('from and to are both required, as dates like 2026-09-01.');
  if (f !== undefined && !isDay(f)) throw new ToolError('from must be a date like 2026-09-01.');
  if (t !== undefined && !isDay(t)) throw new ToolError('to must be a date like 2026-09-01.');
  let to = (t as string | undefined) ?? (f !== undefined ? addDays(f as string, DEFAULT_WINDOW_DAYS - 1) : today);
  if (t === undefined && to > today) to = today;
  const from = (f as string | undefined) ?? addDays(to, -(DEFAULT_WINDOW_DAYS - 1));
  if (to > today) throw new ToolError(`to cannot be in the future (today is ${today}, UTC).`);
  if (from > to) throw new ToolError('from must be on or before to.');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > MAX_WINDOW_DAYS) throw new ToolError(`The window can be at most ${MAX_WINDOW_DAYS} days.`);
  return { from, to, days };
}

const siteOf = (ctx: ToolCtx): Site => { if (!ctx.site) throw new ToolError('site_id is required. Call list_sites.'); return ctx.site; };

function envelope(site: Site, a?: Analysis, w?: Window) {
  return {
    site_id: site.id,
    host: site.host,
    ...(w ? { window: { ...w, basis: 'UTC days, inclusive' } } : {}),
    ...(a ? { computed_at: a.computedAt, sources: a.summary.counts.sources } : {}),
    toolkit_version: config.version,
  };
}

const CLICK_ID_PARAMS = /^(gclid|gbraid|wbraid|gad_source|gad_campaignid|utm_[a-z0-9_]+|fbclid|msclkid)$/i;

/** Path + query of the landing URL, with click ids and utm_* removed (they make every row unique). */
export function landingPath(url: string | null, withQuery = true): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, 'https://landing.invalid');
    if (!withQuery) return u.pathname.slice(0, 200);
    for (const k of [...u.searchParams.keys()]) if (CLICK_ID_PARAMS.test(k)) u.searchParams.delete(k);
    const q = u.searchParams.toString();
    return (u.pathname + (q ? `?${q}` : '')).slice(0, 200);
  } catch { return null; }
}

function refererHost(ref: string | null): string | null {
  if (!ref) return null;
  try { return new URL(ref).host || null; } catch { return null; }
}

/** Stored click ids carry a `gbraid:` / `wbraid:` prefix for the iOS identifiers; report the kind separately. */
export function splitClickId(stored: string): { kind: 'gclid' | 'gbraid' | 'wbraid'; value: string } {
  if (stored.startsWith('gbraid:')) return { kind: 'gbraid', value: stored.slice(7) };
  if (stored.startsWith('wbraid:')) return { kind: 'wbraid', value: stored.slice(7) };
  return { kind: 'gclid', value: stored };
}

function clickRow(s: ScoredEvent) {
  const e = s.event;
  const id = splitClickId(e.gclid);
  return {
    event_id: e.id, ts: e.ts, source: e.source,
    click_id: id.value, click_id_kind: id.kind,
    ip: e.ip, ip_private: !!e.ip_private, asn: e.asn, asn_name: e.asn_name, is_hosting: !!e.is_hosting, country: e.country,
    ua_family: e.ua_family, session_id: e.session_id,
    dwell_ms: e.dwell_ms, visible: e.visible === null ? null : !!e.visible, interactions: e.interactions, automation: e.automation ?? [],
    landing_path: landingPath(e.url), campaign: e.campaign, referer_host: refererHost(e.referer),
    score: s.score, verdict: s.verdict, rules: s.hits.map(ruleOut),
  };
}

function rulesFired(summary: AnalysisSummary) {
  return Object.entries(summary.rules).filter(([, n]) => n > 0)
    .map(([id, n]) => { const r = RULE_BY_ID.get(id); return { rule: id, title: r?.title ?? id, layer: r?.layer ?? null, kind: r?.kind ?? null, events: n }; })
    .sort((a, b) => b.events - a.events);
}

function summaryShape(summary: AnalysisSummary) {
  const c = summary.counts;
  return {
    counts: { total: c.total, allow: c.allow, watch: c.watch, flag: c.flag },
    flag_rate: rate(c.flag, c.total),
    watch_rate: rate(c.watch, c.total),
    per_day: summary.per_day,
    rules_fired: rulesFired(summary),
    top_asns: summary.top_asns,
    top_subnets: summary.top_subnets,
    notes: summary.notes,
  };
}

const VERDICTS_DOC = '"flag" = the rules say invalid; "watch" = suspicious, worth a human look; "allow" = nothing found.';

// ---------------------------------------------------------------- schemas

const SITE_ARG = { site_id: { type: ['integer', 'string'], maxLength: 253, description: 'Site id from list_sites, or the site\'s host (e.g. shop.example).' } };
const WINDOW_ARGS = {
  from: { type: 'string', maxLength: 10, description: 'First day, YYYY-MM-DD (UTC). Default: 6 days before `to`.' },
  to: { type: 'string', maxLength: 10, description: 'Last day, YYYY-MM-DD (UTC), inclusive. Default: today. At most 90 days in total.' },
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const NOTIFICATION_MEANING: Record<string, string> = {
  tag_silent: 'No beacon from the tag for longer than the silent-tag threshold — the tag may have been removed or blocked.',
  never_installed: 'The site was added more than two days ago and the tag has never sent a beacon.',
  first_beacon: 'The tag sent its first beacon — the site is live.',
  window_reminder: 'Flagged clicks in this site\'s data will soon be older than Google\'s ~60-day claim window.',
  private_ips: 'Most clicks are arriving with private IP addresses — the proxy in front is probably not forwarding visitor IPs (check SMB_TRUST_PROXY).',
  update_available: 'A newer toolkit version is available.',
  disk: 'The data directory is larger than the warning threshold (SMB_STORE_WARN_MB).',
};

// ---------------------------------------------------------------- tools

export const TOOLS: ToolDef[] = [
  {
    name: 'list_sites',
    title: 'List sites',
    description: 'Every site on this toolkit instance with its tag health (green = beacons arriving; amber = silent past the threshold; grey = never installed), when the tag was last seen, beacons in the last 24 h, and clicks / flagged clicks over the last 7 days (UTC). Start here: other tools take the site_id.',
    inputSchema: obj({}),
    kind: 'read', idempotent: true, siteScoped: false,
    handler(_args, ctx) {
      const today = dayOf(ctx.now);
      const from = addDays(today, -(DEFAULT_WINDOW_DAYS - 1));
      const threshold = silentThresholdHours();
      const sites = listSites().map((s) => {
        const st = siteStatus(s.id);
        const c = analyse(s, from, today, ctx.now.getTime()).summary.counts;
        return {
          site_id: s.id, name: s.name, host: s.host, consent_mode: s.consent_mode, target_countries: s.target_countries,
          tag_status: siteHealth(s, threshold), last_seen_at: s.last_seen_at, first_event_at: s.first_event_at,
          beacons_24h: st.beacons_24h, last_test_at: st.last_test_at,
          clicks_7d: c.total, events_7d_by_source: c.sources, flagged_7d: c.flag, watch_7d: c.watch, flag_rate_7d: rate(c.flag, c.total),
        };
      });
      return { sites, window_7d: { from, to: today }, silent_threshold_hours: threshold, computed_at: ctx.now.toISOString(), toolkit_version: config.version };
    },
  },
  {
    name: 'get_site_summary',
    title: 'Site summary',
    description: `Click totals for one site over a window: total, flagged, watch and allowed clicks, flag rate, the change against the previous window of the same length, clicks per day, which rules fired how often, top networks (ASNs) and /24 ranges among flagged clicks, and notes on rules that could not run. ${VERDICTS_DOC}`,
    inputSchema: obj({ ...SITE_ARG, ...WINDOW_ARGS }, ['site_id']),
    kind: 'read', idempotent: true, siteScoped: true,
    handler(args, ctx) {
      const site = siteOf(ctx);
      const w = parseWindow(args, ctx.now);
      const a = analyse(site, w.from, w.to, ctx.now.getTime());
      const shape = summaryShape(a.summary);
      const pto = addDays(w.from, -1), pfrom = addDays(pto, -(w.days - 1));
      const p = analyse(site, pfrom, pto, ctx.now.getTime()).summary.counts;
      const trend = p.total
        ? { prior_window: { from: pfrom, to: pto }, prior_total: p.total, prior_flag: p.flag, prior_flag_rate: rate(p.flag, p.total), flag_rate_change_pts: Math.round((shape.flag_rate - rate(p.flag, p.total)) * 1000) / 10 }
        : { prior_window: { from: pfrom, to: pto }, prior_total: 0, note: 'No clicks recorded in the previous window, so there is nothing to compare with.' };
      return { ...envelope(site, a, w), ...shape, trend };
    },
  },
  {
    name: 'get_flagged_clicks',
    title: 'Flagged clicks',
    description: `Click-level rows for one site, newest first: time, click id, full IP, network, country, browser family, landing path, utm campaign, dwell and interactions, score (0–100), verdict and every rule that fired with its weight. verdict: "flag" (default), "watch" or "both". Paged: up to 200 rows per page. ${VERDICTS_DOC}`,
    inputSchema: obj({
      ...SITE_ARG, ...WINDOW_ARGS,
      verdict: { type: 'string', enum: ['flag', 'watch', 'both'], description: 'Which rows to return. Default flag.' },
      page: { type: 'integer', minimum: 1, maximum: 10_000, description: 'Page number, from 1.' },
      page_size: { type: 'integer', minimum: 1, maximum: 200, description: 'Rows per page, default 50.' },
    }, ['site_id']),
    kind: 'read', idempotent: true, siteScoped: true,
    handler(args, ctx) {
      const site = siteOf(ctx);
      const w = parseWindow(args, ctx.now);
      const a = analyse(site, w.from, w.to, ctx.now.getTime());
      const want = (args.verdict as string | undefined) ?? 'flag';
      const page = int(args.page, 1), size = int(args.page_size, 50);
      const rows = a.scored.filter((s) => (want === 'both' ? s.verdict !== 'allow' : s.verdict === want))
        .sort((x, y) => (x.event.ts < y.event.ts ? 1 : x.event.ts > y.event.ts ? -1 : y.event.id - x.event.id));
      const slice = rows.slice((page - 1) * size, page * size);
      return { ...envelope(site, a, w), verdict: want, total_rows: rows.length, page, page_size: size, has_more: page * size < rows.length, clicks: slice.map(clickRow) };
    },
  },
  {
    name: 'get_flag_breakdown',
    title: 'Flagged clicks by dimension',
    description: 'Flagged, watch and total clicks for one site grouped by one dimension: country, asn (network), subnet (/24 for IPv4, /64 for IPv6), ua_family (browser), source (tag beacon / server log / CSV), campaign (utm_campaign), landing_path, hour_of_day or weekday (both UTC), or rule (which rule fired). Top 25 groups by flagged clicks.',
    inputSchema: obj({
      ...SITE_ARG, ...WINDOW_ARGS,
      dimension: { type: 'string', enum: ['country', 'asn', 'subnet', 'ua_family', 'source', 'campaign', 'landing_path', 'hour_of_day', 'weekday', 'rule'] },
    }, ['site_id', 'dimension']),
    kind: 'read', idempotent: true, siteScoped: true,
    handler(args, ctx) {
      const site = siteOf(ctx);
      const w = parseWindow(args, ctx.now);
      const a = analyse(site, w.from, w.to, ctx.now.getTime());
      const dim = args.dimension as string;
      const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const keysOf = (s: ScoredEvent): string[] => {
        const e = s.event;
        switch (dim) {
          case 'country': return [e.country ?? '(unknown)'];
          case 'asn': return [e.asn ? `AS${e.asn}${e.asn_name ? ` ${e.asn_name}` : ''}` : '(unknown)'];
          case 'subnet': return [e.ip_private ? '(private)' : subnet24(e.ip)];
          case 'ua_family': return [e.ua_family ?? '(unknown)'];
          case 'source': return [e.source];
          case 'campaign': return [e.campaign ?? '(none)'];
          case 'landing_path': return [landingPath(e.url, false) ?? '(unknown)'];
          case 'hour_of_day': return [e.ts.slice(11, 13)];
          case 'weekday': return [WEEKDAYS[new Date(e.ts).getUTCDay()]];
          default: return s.hits.length ? s.hits.map((h) => h.rule) : ['(none)'];
        }
      };
      const groups = new Map<string, { flagged: number; watch: number; total: number }>();
      for (const s of a.scored) for (const k of keysOf(s)) {
        const g = groups.get(k) ?? { flagged: 0, watch: 0, total: 0 };
        g.total++;
        if (s.verdict === 'flag') g.flagged++; else if (s.verdict === 'watch') g.watch++;
        groups.set(k, g);
      }
      const all = [...groups].map(([key, g]) => ({ key, ...(dim === 'rule' && RULE_BY_ID.has(key) ? { title: RULE_BY_ID.get(key)!.title } : {}), ...g, flag_rate: rate(g.flagged, g.total) }))
        .sort((x, y) => y.flagged - x.flagged || y.total - x.total || (x.key < y.key ? -1 : 1));
      const c = a.summary.counts;
      return { ...envelope(site, a, w), dimension: dim, totals: { total: c.total, flagged: c.flag, watch: c.watch }, rows: all.slice(0, 25), groups_omitted: Math.max(0, all.length - 25), ...(dim === 'rule' ? { note: 'A click can fire several rules, so rows add up to more than the total.' } : {}) };
    },
  },
  {
    name: 'get_top_offenders',
    title: 'Repeat offenders',
    description: 'IPs, networks (asn) or /24 ranges (subnet) with the most flagged clicks on one site — the list to paste into Google Ads IP exclusions. Only groups with at least min_hits flagged clicks (default 3); include_watch counts watch clicks too. Top 50. Private IPs are left out.',
    inputSchema: obj({
      ...SITE_ARG, ...WINDOW_ARGS,
      group_by: { type: 'string', enum: ['ip', 'asn', 'subnet'], description: 'Default ip.' },
      min_hits: { type: 'integer', minimum: 1, maximum: 1000, description: 'Minimum flagged clicks per group. Default 3.' },
      include_watch: { type: 'boolean', description: 'Count watch clicks as well as flagged. Default false.' },
    }, ['site_id']),
    kind: 'read', idempotent: true, siteScoped: true,
    handler(args, ctx) {
      const site = siteOf(ctx);
      const w = parseWindow(args, ctx.now);
      const a = analyse(site, w.from, w.to, ctx.now.getTime());
      const by = (args.group_by as string | undefined) ?? 'ip';
      const minHits = int(args.min_hits, 3);
      const withWatch = bool(args.include_watch, false);
      type G = { hits: number; flagged: number; watch: number; first: string; last: string; countries: Map<string, number>; asn: number | null; asn_name: string | null; hosting: boolean; rules: Map<string, number> };
      const groups = new Map<string, G>();
      for (const s of a.scored) {
        const e = s.event;
        if (e.ip_private) continue;
        const key = by === 'ip' ? e.ip : by === 'subnet' ? subnet24(e.ip) : e.asn ? `AS${e.asn}` : null;
        if (!key) continue;
        const g = groups.get(key) ?? { hits: 0, flagged: 0, watch: 0, first: e.ts, last: e.ts, countries: new Map(), asn: e.asn, asn_name: e.asn_name, hosting: false, rules: new Map() };
        g.hits++;
        if (e.ts < g.first) g.first = e.ts;
        if (e.ts > g.last) g.last = e.ts;
        if (e.country) g.countries.set(e.country, (g.countries.get(e.country) ?? 0) + 1);
        if (e.is_hosting) g.hosting = true;
        if (s.verdict === 'flag') g.flagged++;
        if (s.verdict === 'watch') g.watch++;
        if (s.verdict === 'flag' || (withWatch && s.verdict === 'watch')) for (const h of s.hits) g.rules.set(h.rule, (g.rules.get(h.rule) ?? 0) + 1);
        groups.set(key, g);
      }
      const counted = (g: G) => g.flagged + (withWatch ? g.watch : 0);
      const rows = [...groups].filter(([, g]) => counted(g) >= minHits)
        .sort(([ka, x], [kb, y]) => counted(y) - counted(x) || y.hits - x.hits || (ka < kb ? -1 : 1))
        .slice(0, 50)
        .map(([key, g]) => ({
          key, hits: g.hits, flagged: g.flagged, watch: g.watch, first_seen: g.first, last_seen: g.last,
          country: [...g.countries].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
          asn: g.asn, asn_name: g.asn_name, is_hosting: g.hosting,
          top_rules: [...g.rules].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([r]) => r),
        }));
      return {
        ...envelope(site, a, w), group_by: by, min_hits: minHits, include_watch: withWatch, rows,
        exclusions_hint: by === 'ip'
          ? 'Google Ads → the campaign → Settings → IP exclusions accepts up to 500 addresses per campaign. A claim package\'s exclusions.txt holds the same list for the analysed window.'
          : 'Google Ads excludes single IPs or ranges written with a trailing * (e.g. 203.0.113.*); networks (ASNs) cannot be excluded directly.',
      };
    },
  },
  {
    name: 'get_ip_profile',
    title: 'IP history on a site',
    description: 'Everything recorded for one IP address on one site over the last 90 days: clicks, first and last seen, how many were flagged or watch, network, hosting flag, country, browser families, which rules fired, and the 10 most recent clicks. Errors if the IP was never seen on the site.',
    inputSchema: obj({ ...SITE_ARG, ip: { type: 'string', maxLength: 64 } }, ['site_id', 'ip']),
    kind: 'read', idempotent: true, siteScoped: true,
    handler(args, ctx) {
      const site = siteOf(ctx);
      let ip = String(args.ip).trim().replace(/^\[|\]$/g, '');
      if (ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
      if (!isIP(ip)) throw new ToolError('ip is not a valid IP address.');
      const today = dayOf(ctx.now);
      const sinceDay = addDays(today, -(MAX_WINDOW_DAYS - 1));
      const rows = db().prepare('SELECT id, ts FROM events WHERE site_id = ? AND ip = ? AND ts >= ? AND is_test = 0 ORDER BY ts').all(site.id, ip, `${sinceDay}T00:00:00.000Z`) as { id: number; ts: string }[];
      if (!rows.length) throw new ToolError('That IP has not been seen on this site in the last 90 days.');
      const w: Window = { from: rows[0].ts.slice(0, 10), to: rows[rows.length - 1].ts.slice(0, 10), days: 0 };
      w.days = Math.round((Date.parse(w.to) - Date.parse(w.from)) / DAY_MS) + 1;
      const a = analyse(site, w.from, w.to, ctx.now.getTime());
      const mine = a.scored.filter((s) => s.event.ip === ip);
      const count = (m: Map<string, number>, k: string | null) => { if (k) m.set(k, (m.get(k) ?? 0) + 1); };
      const families = new Map<string, number>(), rules = new Map<string, number>(), sources = new Map<string, number>();
      for (const s of mine) { count(families, s.event.ua_family); count(sources, s.event.source); for (const h of s.hits) count(rules, h.rule); }
      const last = mine[mine.length - 1]?.event ?? null;
      return {
        ...envelope(site, a, w), ip,
        hits: mine.length, first_seen: mine[0]?.event.ts ?? null, last_seen: last?.ts ?? null,
        flagged: mine.filter((s) => s.verdict === 'flag').length, watch: mine.filter((s) => s.verdict === 'watch').length,
        asn: last?.asn ?? null, asn_name: last?.asn_name ?? null, is_hosting: !!last?.is_hosting, country: last?.country ?? null, ip_private: !!last?.ip_private,
        ua_families: Object.fromEntries(families), sources: Object.fromEntries(sources),
        rules_seen: [...rules].sort((x, y) => y[1] - x[1]).map(([r, n]) => ({ rule: r, title: RULE_BY_ID.get(r)?.title ?? r, events: n })),
        recent: mine.slice(-10).reverse().map((s) => ({ event_id: s.event.id, ts: s.event.ts, click_id: splitClickId(s.event.gclid).value, landing_path: landingPath(s.event.url), verdict: s.verdict, score: s.score })),
      };
    },
  },
  {
    name: 'match_leads',
    title: 'Match CRM leads to clicks',
    description: 'Check CRM leads against the clicks recorded for one site. For each lead send lead_id plus whatever you have of: gclid (or gbraid / wbraid), ip, submitted_at (ISO 8601), landing_url. Any ONE key is enough. Matching order: click id (exact; also read from landing_url) → the lead\'s IP within 30 minutes of submitted_at → utm_* on landing_url to break ties. NEVER send names, emails, phone numbers or message text — they are rejected. Returns per lead: match_basis (click_id | ip_time | ambiguous | none), the matched click\'s event_id and time, verdict (flag | watch | allow | no_match), score, the rules that fired and a reason. Max 200 leads per call.',
    inputSchema: obj({
      ...SITE_ARG,
      leads: {
        type: 'array', maxItems: MAX_LEADS,
        items: obj({
          lead_id: { type: 'string', maxLength: 128, description: "The CRM's id for the lead (opaque here)." },
          submitted_at: { type: 'string', maxLength: 64, description: 'When the lead was created, ISO 8601.' },
          gclid: { type: 'string', maxLength: 256 },
          gbraid: { type: 'string', maxLength: 256 },
          wbraid: { type: 'string', maxLength: 256 },
          ip: { type: 'string', maxLength: 64, description: 'IP the form was submitted from, if the CRM recorded it.' },
          landing_url: { type: 'string', maxLength: 2048, description: 'First-touch / landing URL; click ids and utm_* are read from it.' },
        }, ['lead_id']),
      },
    }, ['site_id', 'leads']),
    kind: 'read', idempotent: true, siteScoped: true,
    handler(args, ctx) {
      const site = siteOf(ctx);
      const leads = (args.leads as Record<string, unknown>[]).map(parseLead);
      if (leads.some((l) => !l.lead_id)) throw new ToolError('Every lead needs a non-empty lead_id.');
      const results = matchLeads(site, leads, ctx.now, describeRule);
      const n = (v: string) => results.filter((r) => r.verdict === v).length;
      return {
        site_id: site.id, host: site.host, computed_at: ctx.now.toISOString(), toolkit_version: config.version,
        summary: { checked: results.length, flag: n('flag'), watch: n('watch'), allow: n('allow'), no_match: n('no_match') },
        results,
      };
    },
  },
  {
    name: 'get_analyses',
    title: 'Saved analyses and claim packages',
    description: 'Analyses saved on this instance (from the Analyse page or run_analysis), newest first, with their counts and the claim packages built from each. download_path is a path on the toolkit UI, which is only reachable where the UI is (usually over an SSH tunnel) — it is not a public link. Optional site_id narrows to one site. Up to 50.',
    inputSchema: obj({ site_id: SITE_ARG.site_id }),
    kind: 'read', idempotent: true, siteScoped: false,
    handler(args, ctx) {
      const site = args.site_id === undefined ? null : ctx.site ?? null;
      const rows = (site
        ? db().prepare('SELECT * FROM analyses WHERE site_id = ? ORDER BY id DESC LIMIT 50').all(site.id)
        : db().prepare('SELECT * FROM analyses ORDER BY id DESC LIMIT 50').all()) as { id: number; site_id: number; range_from: string; range_to: string; ran_at: string; summary: string }[];
      const hosts = new Map(listSites().map((s) => [s.id, s.host]));
      const pkgStmt = db().prepare('SELECT id, path, rows, created_at FROM packages WHERE analysis_id = ? ORDER BY id DESC');
      const analyses = rows.map((r) => {
        let counts: AnalysisSummary['counts'] | null = null;
        try { counts = (JSON.parse(r.summary) as AnalysisSummary).counts; } catch { /* old row */ }
        const packages = (pkgStmt.all(r.id) as { id: number; path: string; rows: number; created_at: string }[]).map((p) => ({
          package_id: p.id, rows: p.rows, created_at: p.created_at, filename: basename(p.path), download_path: `/api/packages/${p.id}/download`, exists: !!p.path && existsSync(p.path),
        }));
        return { analysis_id: r.id, site_id: r.site_id, host: hosts.get(r.site_id) ?? null, range: { from: r.range_from, to: r.range_to }, ran_at: r.ran_at, counts: counts ? { total: counts.total, allow: counts.allow, watch: counts.watch, flag: counts.flag } : null, packages };
      });
      return { analyses, computed_at: ctx.now.toISOString(), toolkit_version: config.version };
    },
  },
  {
    name: 'get_claim_window',
    title: 'Can this window still be claimed?',
    description: `Whether Google will still review clicks from a window: Google accepts invalid-click requests for roughly the last ${config.claimWindowDays} days. Returns ok, a message or warning, the earliest day that can still be filed, and how many days are left before the window's first and last days fall outside the limit.`,
    inputSchema: obj({ ...SITE_ARG, ...WINDOW_ARGS }, ['site_id', 'from', 'to']),
    kind: 'read', idempotent: true, siteScoped: true,
    handler(args, ctx) {
      const site = siteOf(ctx);
      const w = parseWindow(args, ctx.now, true);
      const r = checkWindow(w.from, w.to, ctx.now);
      const today = dayOf(ctx.now);
      const left = (day: string) => Math.max(0, config.claimWindowDays - Math.round((Date.parse(today) - Date.parse(day)) / DAY_MS));
      return {
        ...envelope(site, undefined, w), ok: r.ok, ...(r.message ? { message: r.message } : {}), ...(r.warning ? { warning: r.warning } : {}),
        claim_window_days: config.claimWindowDays, earliest_filable_day: addDays(today, -config.claimWindowDays),
        days_left_for_first_day: left(w.from), days_left_for_last_day: left(w.to),
      };
    },
  },
  {
    name: 'get_notifications',
    title: 'Notices',
    description: 'Open notices on this instance — the toolkit\'s "anything I should know?": tag silent or never installed, first beacon, flagged clicks about to leave the claim window, private IPs arriving (proxy misconfigured), a newer version, disk use. Optional site_id narrows to one site (instance-wide notices are always included).',
    inputSchema: obj({ site_id: SITE_ARG.site_id }),
    kind: 'read', idempotent: true, siteScoped: false,
    handler(args, ctx) {
      const site = args.site_id === undefined ? undefined : ctx.site;
      const items = activeNotifications(site?.id).map((n) => ({ id: n.id, site_id: n.site_id, kind: n.kind, meaning: NOTIFICATION_MEANING[n.kind] ?? null, created_at: n.created_at, details: n.payload }));
      return { notifications: items, computed_at: ctx.now.toISOString(), toolkit_version: config.version };
    },
  },
  {
    name: 'get_rules',
    title: 'Detection rules',
    description: 'The rules this toolkit scores clicks with — the same public defaults for every install: id, title, layer, hard or soft, weight, thresholds, what data each needs, and a plain-English description — plus how scores become verdicts.',
    inputSchema: obj({}),
    kind: 'read', idempotent: true, siteScoped: false,
    handler(_args, ctx) {
      const rules = RULES.map((r) => {
        const { kind: _k, weight: _w, ...params } = DEFAULTS.rules[r.id] ?? {};
        return { rule: r.id, title: r.title, layer: r.layer, kind: r.kind, weight: r.weight, needs: r.needs, describe: r.describe, params };
      });
      return {
        rules,
        scoring: {
          score_threshold: DEFAULTS.score_threshold, min_layers: DEFAULTS.min_layers, watch_score: DEFAULTS.watch_score, hard_weight: DEFAULTS.hard_weight,
          how: `Any hard rule → flag (score 100). Otherwise soft weights add up (max 100): at least ${DEFAULTS.score_threshold} across at least ${DEFAULTS.min_layers} layers → flag; any soft rule or at least ${DEFAULTS.watch_score} → watch; nothing → allow.`,
        },
        docs: '/docs/rules on the toolkit UI',
        computed_at: ctx.now.toISOString(), toolkit_version: config.version,
      };
    },
  },
  {
    name: 'run_analysis',
    title: 'Save an analysis',
    description: 'Run the rules over a window for one site and SAVE the result, the same as Analyse → Run on the toolkit UI — needed before build_claim_package. If the same window was saved in the last 24 hours that analysis is returned instead (reused: true); pass force: true to run it again (e.g. after importing more logs). Refuses windows that lie wholly outside Google\'s claim window.',
    inputSchema: obj({ ...SITE_ARG, ...WINDOW_ARGS, force: { type: 'boolean', description: 'Run again even if this window was saved in the last 24 hours.' } }, ['site_id', 'from', 'to']),
    kind: 'action', idempotent: true, siteScoped: true,
    handler(args, ctx) {
      const site = siteOf(ctx);
      const w = parseWindow(args, ctx.now, true);
      const check = checkWindow(w.from, w.to, ctx.now);
      if (!check.ok) throw new ToolError(check.message ?? 'That window cannot be analysed.');
      if (!bool(args.force, false)) {
        const since = new Date(ctx.now.getTime() - DAY_MS).toISOString();
        const prev = db().prepare('SELECT id, ran_at, summary FROM analyses WHERE site_id = ? AND range_from = ? AND range_to = ? AND ran_at >= ? ORDER BY id DESC LIMIT 1')
          .get(site.id, w.from, w.to, since) as { id: number; ran_at: string; summary: string } | undefined;
        if (prev) return { ...envelope(site, undefined, w), analysis_id: prev.id, reused: true, ran_at: prev.ran_at, ...(check.warning ? { warning: check.warning } : {}), ...summaryShape(JSON.parse(prev.summary) as AnalysisSummary) };
      }
      const result = runAnalysis(site, w.from, w.to);
      const id = saveAnalysis(site, result);
      const s = result.summary;
      telemetry.track('analysis_run', {
        rules: s.rules, flagged_share: telemetry.shareBucket(s.counts.total ? s.counts.flag / s.counts.total : 0), window_days: w.days,
        sources_beacon: s.counts.sources.beacon > 0, sources_log: s.counts.sources.log > 0, sources_csv: s.counts.sources.csv > 0, via: 'mcp',
      });
      return { ...envelope(site, undefined, w), analysis_id: id, reused: false, ran_at: s.ran_at, sources: s.counts.sources, ...(check.warning ? { warning: check.warning } : {}), ...summaryShape(s) };
    },
  },
  {
    name: 'build_claim_package',
    title: 'Build a claim package',
    description: 'Build the claim package (zip) for a saved analysis: evidence.csv, summary.md, form-answers.md, report.json and, by default, exclusions.txt. include_watch adds watch rows to the evidence. Returns the package id, row count, file name and its download path on the toolkit UI. This does NOT file anything: a person downloads the zip and submits Google\'s invalid-click form.',
    inputSchema: obj({
      analysis_id: { type: 'integer', minimum: 1, description: 'From run_analysis or get_analyses.' },
      include_watch: { type: 'boolean', description: 'Add watch rows to the evidence. Default false.' },
      exclusions: { type: 'boolean', description: 'Include exclusions.txt (IPs to exclude in Google Ads). Default true.' },
    }, ['analysis_id']),
    kind: 'action', idempotent: false, siteScoped: false,
    handler(args, ctx) {
      const a = loadAnalysis(args.analysis_id as number);
      if (!a) throw new ToolError('No saved analysis has that id. Call get_analyses, or run_analysis first.');
      const site = getSite(a.site_id);
      if (!site) throw new ToolError('That analysis belongs to a site that no longer exists.');
      const withExclusions = bool(args.exclusions, true);
      const r = buildPackage(a.id, { includeWatch: bool(args.include_watch, false), exclusions: withExclusions });
      telemetry.track('claim_package', { flagged_rows: telemetry.bucket(r.rows), exclusions: withExclusions, via: 'mcp' });
      return {
        site_id: site.id, host: site.host, analysis_id: a.id, range: { from: a.summary.range_from, to: a.summary.range_to },
        package_id: r.package_id, rows: r.rows, filename: basename(r.path), download_path: `/api/packages/${r.package_id}/download`,
        contents: ['evidence.csv', 'summary.md', 'form-answers.md', 'report.json', ...(withExclusions ? ['exclusions.txt'] : [])],
        ...(r.rows === 0 ? { warning: 'This analysis has no flagged clicks, so the evidence file is empty.' } : {}),
        next_step: 'Download the zip from the toolkit UI (Analyse page for this site, or download_path on the UI address) and submit it with Google\'s invalid-click form. The toolkit never files for you.',
        computed_at: ctx.now.toISOString(), toolkit_version: config.version,
      };
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** match_leads gets a specific message for extra lead fields: it's where contact details would leak. */
export function specialiseArgumentError(tool: string, message: string): string {
  if (tool === 'match_leads' && /^arguments\.leads\[\] contains an unsupported field/.test(message)) {
    return `Each lead may carry only: ${LEAD_FIELDS.join(', ')}. Never send names, emails, phone numbers or message text — matching never needs them.`;
  }
  return message;
}
