// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * match_leads: CRM leads → recorded clicks on one site. The agent fetches leads from the CRM; we never see
 * names, emails or phone numbers (the schema rejects any field beyond the six below).
 *
 * Per lead, first hit wins; any one key is enough:
 *  1. click id — gclid (or gbraid / wbraid), sent or read from landing_url. gbraid/wbraid identify a campaign
 *     and day on iOS rather than one click, so they match only when every hit is one visitor (one IP).
 *  2. IP + time — a click from the lead's IP within 30 minutes of submitted_at. Clicks that started before the
 *     submission win (latest first); then utm_* agreement with landing_url; then nearest in time.
 *  3. otherwise no_match, with the reason, so the agent can say which field to add to the form.
 * Verdicts come from one analysis over the days the matched clicks fall on (± 1 day), cached.
 */
import { isIP } from 'node:net';
import { eventsByClickId, eventsByIp } from '../db.js';
import type { ClickEvent, ScoredEvent, Site } from '../types.js';
import { analyse } from './analyse.js';

export const MAX_LEADS = 200;
export const MATCH_WINDOW_MIN = 30;
const MAX_SPAN_DAYS = 90;

export const LEAD_FIELDS = ['lead_id', 'submitted_at', 'gclid', 'gbraid', 'wbraid', 'ip', 'landing_url'] as const;

export interface LeadInput {
  lead_id: string;
  submitted_at: Date | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  ip: string | null;
  landing_url: string | null;
  problems: string[]; // fields we had to ignore, and why
}

export type MatchBasis = 'click_id' | 'ip_time' | 'ambiguous' | 'none';
export type LeadVerdict = 'flag' | 'watch' | 'allow' | 'no_match';

export interface LeadResult {
  lead_id: string;
  match_basis: MatchBasis;
  event_id: number | null;
  ts: string | null;
  verdict: LeadVerdict;
  score: number | null;
  rules: { rule: string; title: string; layer: string; kind: string; weight: number }[];
  reason: string | null;
}

const s = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function stripMapped(ip: string): string {
  return ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

function urlParams(url: string | null): URLSearchParams | null {
  if (!url) return null;
  try { return new URL(url, 'https://lead.invalid').searchParams; } catch { return null; }
}

export function parseLead(raw: Record<string, unknown>): LeadInput {
  const problems: string[] = [];
  const landing = s(raw.landing_url, 2048);
  const q = urlParams(landing);
  let submitted: Date | null = null;
  const sub = s(raw.submitted_at, 64);
  if (sub) {
    const t = Date.parse(sub);
    if (Number.isNaN(t)) problems.push('submitted_at is not an ISO 8601 time');
    else submitted = new Date(t);
  }
  let ip = s(raw.ip, 64);
  if (ip) {
    ip = stripMapped(ip.replace(/^\[|\]$/g, ''));
    if (!isIP(ip)) { problems.push('ip is not a valid IP address'); ip = null; }
  }
  return {
    lead_id: s(raw.lead_id, 128) ?? '',
    submitted_at: submitted,
    gclid: s(raw.gclid, 256) ?? s(q?.get('gclid'), 256),
    gbraid: s(raw.gbraid, 256) ?? s(q?.get('gbraid'), 256),
    wbraid: s(raw.wbraid, 256) ?? s(q?.get('wbraid'), 256),
    ip,
    landing_url: landing,
    problems,
  };
}

type Matched = { basis: 'click_id' | 'ip_time'; event: ClickEvent };
type Unmatched = { basis: 'ambiguous' | 'none'; reason: string };

/** Earliest beacon if there is one (it carries dwell and interaction), else the earliest event. */
const representative = (hits: ClickEvent[]) => hits.find((e) => e.source === 'beacon') ?? hits[0];

export function findClick(site: Site, lead: LeadInput): Matched | Unmatched {
  // 1. click id
  const ids: [string, string | null, string][] = [
    ['gclid', lead.gclid, lead.gclid ?? ''],
    ['gbraid', lead.gbraid, `gbraid:${lead.gbraid}`],
    ['wbraid', lead.wbraid, `wbraid:${lead.wbraid}`],
  ];
  const hadClickId = ids.some(([, v]) => v);
  let ambiguous: string | null = null;
  for (const [kind, value, stored] of ids) {
    if (!value) continue;
    const hits = eventsByClickId(site.id, stored);
    if (!hits.length) continue;
    if (kind !== 'gclid') {
      const visitors = new Set(hits.map((h) => h.ip));
      if (visitors.size > 1) { ambiguous = `this ${kind} was carried by ${visitors.size} different visitors (it identifies a campaign and day, not one click)`; continue; }
    }
    return { basis: 'click_id', event: representative(hits) };
  }

  // 2. ip + time
  if (lead.ip && lead.submitted_at) {
    const t = lead.submitted_at.getTime();
    const w = MATCH_WINDOW_MIN * 60_000;
    const hits = eventsByIp(site.id, lead.ip, new Date(t - w).toISOString(), new Date(t + w).toISOString());
    if (hits.length) {
      const want = urlParams(lead.landing_url);
      const utmKeys = want ? [...want.keys()].filter((k) => k.startsWith('utm_')) : [];
      const utmScore = (e: ClickEvent) => { const p = urlParams(e.url); return utmKeys.filter((k) => p?.get(k) === want!.get(k)).length; };
      const at = (e: ClickEvent) => Date.parse(e.ts);
      const before = (e: ClickEvent) => (at(e) <= t + 60_000 ? 1 : 0);
      hits.sort((a, b) =>
        before(b) - before(a) ||
        utmScore(b) - utmScore(a) ||
        (before(a) ? at(b) - at(a) : 0) ||
        Math.abs(at(a) - t) - Math.abs(at(b) - t) ||
        at(b) - at(a) ||
        (a.source === 'beacon' ? -1 : b.source === 'beacon' ? 1 : 0));
      return { basis: 'ip_time', event: hits[0] };
    }
  }

  if (ambiguous) return { basis: 'ambiguous', reason: `${ambiguous} — send the lead's ip and submitted_at too` };
  let reason: string;
  if (!hadClickId && !lead.ip) reason = 'the lead has no click id (gclid) and no IP — add a hidden gclid field to the form';
  else if (hadClickId && !lead.ip) reason = "click id not seen on this site (older than the data kept here, or not from this site's ads)";
  else if (lead.ip && !lead.submitted_at) reason = "the lead has an IP but no submitted_at, so it can't be matched by time";
  else reason = `no click from this IP within ${MATCH_WINDOW_MIN} minutes of the submission`;
  if (lead.problems.length) reason += ` (ignored: ${lead.problems.join('; ')})`;
  return { basis: 'none', reason };
}

const DAY = 86_400_000;
const dayOf = (iso: string) => iso.slice(0, 10);
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Scores for the matched events: one analysis over their days ± 1 when that fits in 90 days, else one per day. */
function scoresFor(site: Site, events: ClickEvent[], now: Date): Map<number, ScoredEvent> {
  const out = new Map<number, ScoredEvent>();
  if (!events.length) return out;
  const today = now.toISOString().slice(0, 10);
  const clamp = (d: string) => (d > today ? today : d);
  const days = [...new Set(events.map((e) => dayOf(e.ts)))].sort();
  const from = shift(days[0], -1), to = clamp(shift(days[days.length - 1], 1));
  const windows: [string, string][] = (Date.parse(to) - Date.parse(from)) / DAY + 1 <= MAX_SPAN_DAYS
    ? [[from, to]]
    : days.map((d) => [shift(d, -1), clamp(shift(d, 1))]);
  const wanted = new Set(events.map((e) => e.id));
  for (const [f, t] of windows) {
    for (const sc of analyse(site, f, t, now.getTime()).scored) if (wanted.has(sc.event.id) && !out.has(sc.event.id)) out.set(sc.event.id, sc);
  }
  return out;
}

export function matchLeads(site: Site, leads: LeadInput[], now: Date, describe: (rule: string) => { title: string }): LeadResult[] {
  const found = leads.map((l) => findClick(site, l));
  const events = found.flatMap((f) => ('event' in f ? [f.event] : []));
  const scores = scoresFor(site, events, now);
  return leads.map((lead, i) => {
    const f = found[i];
    if (!('event' in f)) {
      return { lead_id: lead.lead_id, match_basis: f.basis, event_id: null, ts: null, verdict: 'no_match', score: null, rules: [], reason: f.reason };
    }
    const sc = scores.get(f.event.id);
    if (!sc) {
      return { lead_id: lead.lead_id, match_basis: f.basis, event_id: f.event.id, ts: f.event.ts, verdict: 'no_match', score: null, rules: [], reason: 'matched a click, but it could not be scored (outside the 90-day window)' };
    }
    const rules = sc.hits.map((h) => ({ rule: h.rule, title: describe(h.rule).title, layer: h.layer, kind: h.kind, weight: h.weight }));
    return {
      lead_id: lead.lead_id,
      match_basis: f.basis,
      event_id: f.event.id,
      ts: f.event.ts,
      verdict: sc.verdict,
      score: sc.score,
      rules,
      reason: sc.verdict === 'allow' ? null : rules.map((r) => r.title).join(', '),
    };
  });
}
