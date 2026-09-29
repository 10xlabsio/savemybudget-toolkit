// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { readFileSync } from 'node:fs';
import { db, eventById, eventsInWindow, now } from '../db.js';
import { subnet24 } from '../enrich/index.js';
import type { AnalysisSummary, ClickEvent, RuleHit, ScoredEvent, Site, Source, Verdict } from '../types.js';

export interface RuleDef {
  id: string;
  layer: 'network' | 'browser' | 'behaviour' | 'frequency';
  kind: 'hard' | 'soft';
  weight: number;
  title: string;
  describe: string;
  needs: string; // 'any' | 'beacons' | 'beacons+logs' | 'any+targeting'
}

interface RuleCfg { kind: 'hard' | 'soft'; weight: number; [k: string]: number | string }
interface Defaults {
  score_threshold: number;
  min_layers: number;
  watch_score: number;
  hard_weight: number;
  rules: Record<string, RuleCfg>;
}

export const DEFAULTS: Defaults = JSON.parse(readFileSync(new URL('./defaults.json', import.meta.url), 'utf8'));
const cfg = (id: string) => DEFAULTS.rules[id];

export const RULES: RuleDef[] = [
  { id: 'r1_hosting_asn', layer: 'network', kind: 'hard', weight: cfg('r1_hosting_asn').weight, title: 'Datacenter / hosting network', describe: 'IP belongs to a hosting provider network (AWS, GCP, Hetzner, OVH, ...). Real customers do not browse from datacenters.', needs: 'any' },
  { id: 'r3_geo', layer: 'network', kind: 'hard', weight: cfg('r3_geo').weight, title: 'Outside targeting', describe: 'IP country is not in the countries the campaign targets. Only runs when targeting is set on the site.', needs: 'any+targeting' },
  { id: 'r4_subnet_cluster', layer: 'network', kind: 'soft', weight: cfg('r4_subnet_cluster').weight, title: 'Subnet clustering', describe: 'Five or more distinct IPs from the same /24 within 15 minutes. Dampened when the user-agent mix on the range is diverse.', needs: 'any' },
  { id: 'r6_automation', layer: 'browser', kind: 'hard', weight: cfg('r6_automation').weight, title: 'Automation markers', describe: 'The browser announces itself as automated (navigator.webdriver, headless user agent, missing plugins/fonts).', needs: 'any' },
  { id: 'r8_fp_collision', layer: 'browser', kind: 'soft', weight: cfg('r8_fp_collision').weight, title: 'Fingerprint collision', describe: 'The same browser fingerprint seen from five or more IPs within 24 hours.', needs: 'beacons' },
  { id: 'r9_no_beacon', layer: 'browser', kind: 'hard', weight: cfg('r9_no_beacon').weight, title: 'Request seen, no beacon', describe: 'A request with a click ID reached the server but the tag never sent a beacon: the visitor did not run JavaScript. Downgraded to soft when beacon volume drops sharply.', needs: 'beacons+logs' },
  { id: 'r10_zero_dwell', layer: 'behaviour', kind: 'soft', weight: cfg('r10_zero_dwell').weight, title: 'Zero-dwell bounce', describe: 'Page closed within two seconds of visible time with no interaction.', needs: 'beacons' },
  { id: 'r11_dead_session', layer: 'behaviour', kind: 'soft', weight: cfg('r11_dead_session').weight, title: 'Dead session', describe: 'Zero mouse, scroll or touch events for the whole session.', needs: 'beacons' },
  { id: 'r13_gclid_replay', layer: 'frequency', kind: 'hard', weight: cfg('r13_gclid_replay').weight, title: 'Click ID replay', describe: 'The same click ID hit the landing page two or more times, or arrived more than 24 hours after it was first seen.', needs: 'any' },
  { id: 'r14_ip_velocity', layer: 'frequency', kind: 'soft', weight: cfg('r14_ip_velocity').weight, title: 'IP velocity', describe: 'Three or more paid clicks from one IP in 15 minutes, or five or more in 24 hours. Halved when the IP shows five or more browser families (CGNAT).', needs: 'any' },
];
const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

const MIN = 60_000;
const HOUR = 3_600_000;

type Hits = Map<number, RuleHit[]>; // event id -> hits

function addHit(hits: Hits, e: ClickEvent, id: string, weightOverride?: number, kindOverride?: 'hard' | 'soft', note?: string) {
  const def = RULE_BY_ID.get(id)!;
  const list = hits.get(e.id) ?? [];
  if (list.some((h) => h.rule === id)) return;
  const hit: RuleHit = { rule: id, layer: def.layer, kind: kindOverride ?? def.kind, weight: weightOverride ?? def.weight };
  if (note) hit.note = note;
  list.push(hit);
  hits.set(e.id, list);
}

function groupBy<K>(events: ClickEvent[], key: (e: ClickEvent) => K | null): Map<K, ClickEvent[]> {
  const m = new Map<K, ClickEvent[]>();
  for (const e of events) {
    const k = key(e);
    if (k === null || k === undefined || (k as unknown) === '') continue;
    const l = m.get(k);
    if (l) l.push(e); else m.set(k, [e]);
  }
  return m;
}

/**
 * Sliding window over a sorted group: for every window [t, t+width] anchored on an event,
 * if `distinctOf` yields >= min distinct values, every event in that window is marked.
 * Returns marked events with the max distinct ua_family count seen in a qualifying window.
 */
function slidingWindow(
  group: ClickEvent[],
  width: number,
  min: number,
  distinctOf: (e: ClickEvent) => string,
  countMode: 'distinct' | 'events' = 'distinct',
): Map<number, { e: ClickEvent; uaFamilies: number }> {
  const sorted = [...group].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const times = sorted.map((e) => Date.parse(e.ts));
  const out = new Map<number, { e: ClickEvent; uaFamilies: number }>();
  let j = 0;
  for (let i = 0; i < sorted.length; i++) {
    while (j < sorted.length && times[j] <= times[i] + width) j++;
    const win = sorted.slice(i, j);
    const n = countMode === 'distinct' ? new Set(win.map(distinctOf)).size : win.length;
    if (n < min) continue;
    const ua = new Set(win.map((e) => e.ua_family ?? 'unknown')).size;
    for (const e of win) {
      const prev = out.get(e.id);
      if (!prev || prev.uaFamilies < ua) out.set(e.id, { e, uaFamilies: ua });
    }
  }
  return out;
}

export function runAnalysis(
  site: Site,
  from: string,
  to: string,
  opts?: { events?: ClickEvent[]; history?: { beaconRatioMedian?: number } },
): { summary: AnalysisSummary; scored: ScoredEvent[] } {
  const events = (opts?.events ?? eventsInWindow(site.id, from, to)).filter((e) => !e.is_test);
  const hits: Hits = new Map();
  const notes: string[] = [];

  const beacons = events.filter((e) => e.source === 'beacon');
  const logs = events.filter((e) => e.source === 'log');
  const byGclid = groupBy(events, (e) => e.gclid);
  const byIp = groupBy(events, (e) => e.ip);
  const byFp = groupBy(beacons, (e) => e.fp_hash);
  const bySubnet = groupBy(events, (e) => (e.ip_private ? null : subnet24(e.ip)));
  const targeting = site.target_countries.map((c) => c.toUpperCase());

  // ---- r1, r3, r6, r10, r11 (per event) ----
  const r10 = cfg('r10_zero_dwell');
  const r11 = cfg('r11_dead_session');
  for (const e of events) {
    if (e.is_hosting) addHit(hits, e, 'r1_hosting_asn');
    if (targeting.length && e.country && !targeting.includes(e.country.toUpperCase())) addHit(hits, e, 'r3_geo');
    if (e.automation && e.automation.length) addHit(hits, e, 'r6_automation');
    if (e.source === 'beacon') {
      if (e.visible === 1 && e.dwell_ms !== null && e.dwell_ms < Number(r10.max_dwell_ms) && (e.interactions ?? 0) === 0) addHit(hits, e, 'r10_zero_dwell');
      if (e.dwell_ms !== null && e.dwell_ms >= Number(r11.min_dwell_ms) && e.interactions === 0) addHit(hits, e, 'r11_dead_session');
    }
  }

  // ---- r4 subnet cluster ----
  const r4 = cfg('r4_subnet_cluster');
  for (const group of bySubnet.values()) {
    const marked = slidingWindow(group, Number(r4.window_min) * MIN, Number(r4.min_ips), (e) => e.ip);
    for (const { e, uaFamilies } of marked.values()) {
      const damp = uaFamilies >= Number(r4.dampen_ua_families);
      addHit(hits, e, 'r4_subnet_cluster', damp ? Math.round(r4.weight / 2) : undefined, undefined,
        damp ? `dampened: ${uaFamilies} browser families on the /24 (shared network)` : undefined);
    }
  }

  // ---- r8 fingerprint collision ----
  const r8 = cfg('r8_fp_collision');
  for (const group of byFp.values()) {
    const marked = slidingWindow(group, Number(r8.window_hours) * HOUR, Number(r8.min_ips), (e) => e.ip);
    for (const { e } of marked.values()) addHit(hits, e, 'r8_fp_collision');
  }

  // ---- r9 request seen, no beacon ----
  const r9 = cfg('r9_no_beacon');
  let r9Ran = false;
  if (beacons.length && logs.length) {
    r9Ran = true;
    const beaconByGclid = groupBy(beacons, (e) => e.gclid);
    const logGclids = new Set(logs.map((e) => e.gclid));
    const ratio = beacons.length / Math.max(1, logGclids.size);
    let downgrade = false;
    const median = opts?.history?.beaconRatioMedian;
    if (median !== undefined && median > 0) {
      if (ratio < Number(r9.guard_ratio_of_median) * median) {
        downgrade = true;
        notes.push(`Rule 9 (request seen, no beacon) downgraded to soft: beacon-to-request ratio for this window is ${ratio.toFixed(2)}, under half of the site's usual ${median.toFixed(2)}. The tag may have been removed, gated by a consent change, or down for part of the window.`);
      }
    } else if (ratio < Number(r9.guard_ratio_absolute)) {
      downgrade = true;
      notes.push(`Rule 9 (request seen, no beacon) downgraded to soft: only ${ratio.toFixed(2)} beacons per logged click ID in this window, which looks like a nearly dead tag rather than visitors skipping JavaScript.`);
    }
    const w = Number(r9.match_window_min) * MIN;
    for (const e of logs) {
      const t = Date.parse(e.ts);
      const bs = beaconByGclid.get(e.gclid);
      const matched = bs?.some((b) => Math.abs(Date.parse(b.ts) - t) <= w) ?? false;
      if (!matched) {
        if (downgrade) addHit(hits, e, 'r9_no_beacon', Number(r9.downgraded_weight), 'soft', 'downgraded to soft: beacon volume low for this window (tag-health guard)');
        else addHit(hits, e, 'r9_no_beacon');
      }
    }
  }

  // ---- r13 click ID replay ----
  const r13 = cfg('r13_gclid_replay');
  const pairW = Number(r13.pair_window_min) * MIN;
  const maxAge = Number(r13.max_age_hours) * HOUR;
  for (const group of byGclid.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const first = Date.parse(sorted[0].ts);
    // sightings: a beacon+log pair (distinct sources) within pair_window is one sighting
    let sightings = 0;
    let curStart = -Infinity;
    let curSources = new Set<Source>();
    for (const e of sorted) {
      const t = Date.parse(e.ts);
      if (t - curStart <= pairW && !curSources.has(e.source)) { curSources.add(e.source); continue; }
      sightings++;
      curStart = t;
      curSources = new Set([e.source]);
    }
    const late = Date.parse(sorted[sorted.length - 1].ts) - first > maxAge;
    if (sightings >= Number(r13.min_sightings) || late) {
      const note = late && sightings < Number(r13.min_sightings) ? 'click ID seen again more than 24 h after first sighting' : `click ID seen ${sightings} times`;
      for (const e of sorted) addHit(hits, e, 'r13_gclid_replay', undefined, undefined, note);
    }
  }

  // ---- r14 IP velocity ----
  const r14 = cfg('r14_ip_velocity');
  for (const group of byIp.values()) {
    if (group[0].ip_private) continue;
    const short = slidingWindow(group, Number(r14.short_window_min) * MIN, Number(r14.short_min), (e) => String(e.id), 'events');
    const long = slidingWindow(group, Number(r14.long_window_hours) * HOUR, Number(r14.long_min), (e) => String(e.id), 'events');
    const merged = new Map<number, { e: ClickEvent; uaFamilies: number }>();
    for (const m of [short, long]) for (const [id, v] of m) { const p = merged.get(id); if (!p || p.uaFamilies < v.uaFamilies) merged.set(id, v); }
    for (const { e, uaFamilies } of merged.values()) {
      const damp = uaFamilies >= Number(r14.cgnat_ua_families);
      addHit(hits, e, 'r14_ip_velocity', damp ? Math.round(r14.weight / 2) : undefined, undefined,
        damp ? `dampened: ${uaFamilies} browser families from this IP (CGNAT / shared network)` : undefined);
    }
  }

  // ---- scoring ----
  const scored: ScoredEvent[] = events.map((event) => {
    const h = hits.get(event.id) ?? [];
    return { event, hits: h, ...scoreHits(h) };
  });

  const summary = summarize(site, from, to, scored, notes, r9Ran);
  return { summary, scored };
}

export function scoreHits(h: RuleHit[]): { score: number; verdict: Verdict } {
  const hard = h.some((x) => x.kind === 'hard');
  const soft = h.filter((x) => x.kind === 'soft');
  const score = Math.min(100, soft.reduce((s, x) => s + x.weight, 0));
  if (hard) return { score: 100, verdict: 'flag' };
  const layers = new Set(h.map((x) => x.layer)).size;
  if (score >= DEFAULTS.score_threshold && layers >= DEFAULTS.min_layers) return { score, verdict: 'flag' };
  if (score >= DEFAULTS.watch_score || soft.length) return { score, verdict: 'watch' };
  return { score, verdict: 'allow' };
}

function summarize(site: Site, from: string, to: string, scored: ScoredEvent[], notes: string[], r9Ran: boolean): AnalysisSummary {
  const counts = { total: scored.length, allow: 0, watch: 0, flag: 0, sources: { beacon: 0, log: 0, csv: 0 } as Record<Source, number> };
  const rules: Record<string, number> = {};
  for (const r of RULES) rules[r.id] = 0;
  const asnCount = new Map<string, { asn: number | null; asn_name: string | null; count: number }>();
  const subnetCount = new Map<string, number>();
  const days = new Map<string, { total: number; flag: number }>();
  for (const s of scored) {
    counts[s.verdict]++;
    counts.sources[s.event.source] = (counts.sources[s.event.source] ?? 0) + 1;
    for (const h of s.hits) rules[h.rule] = (rules[h.rule] ?? 0) + 1;
    const day = s.event.ts.slice(0, 10);
    const d = days.get(day) ?? { total: 0, flag: 0 };
    d.total++;
    if (s.verdict === 'flag') {
      d.flag++;
      const k = String(s.event.asn ?? 'unknown');
      const a = asnCount.get(k) ?? { asn: s.event.asn, asn_name: s.event.asn_name, count: 0 };
      a.count++;
      asnCount.set(k, a);
      if (!s.event.ip_private) {
        const sn = subnet24(s.event.ip);
        subnetCount.set(sn, (subnetCount.get(sn) ?? 0) + 1);
      }
    }
    days.set(day, d);
  }
  if (!r9Ran) notes.push('Rule 9 (request seen, no beacon) did not run: it needs both beacon and server-log events for the site in this window.');
  return {
    site_id: site.id,
    range_from: from,
    range_to: to,
    ran_at: now(),
    counts,
    rules,
    notes,
    top_asns: [...asnCount.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    top_subnets: [...subnetCount].map(([subnet, count]) => ({ subnet, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    per_day: [...days].map(([day, v]) => ({ day, ...v })).sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}

export function saveAnalysis(site: Site, result: { summary: AnalysisSummary; scored: ScoredEvent[] }): number {
  const d = db();
  d.exec('BEGIN');
  try {
    const r = d.prepare('INSERT INTO analyses(site_id,range_from,range_to,ran_at,summary) VALUES(?,?,?,?,?)')
      .run(site.id, result.summary.range_from, result.summary.range_to, result.summary.ran_at, JSON.stringify(result.summary));
    const id = Number(r.lastInsertRowid);
    const ins = d.prepare('INSERT INTO verdicts(analysis_id,event_id,verdict,score,hits) VALUES(?,?,?,?,?)');
    for (const s of result.scored) ins.run(id, s.event.id, s.verdict, s.score, JSON.stringify(s.hits));
    d.exec('COMMIT');
    return id;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export function loadAnalysis(id: number): { id: number; site_id: number; summary: AnalysisSummary; scored: ScoredEvent[] } | null {
  const a = db().prepare('SELECT * FROM analyses WHERE id = ?').get(id) as { id: number; site_id: number; summary: string } | undefined;
  if (!a) return null;
  const rows = db().prepare('SELECT event_id, verdict, score, hits FROM verdicts WHERE analysis_id = ?').all(id) as
    { event_id: number; verdict: Verdict; score: number; hits: string }[];
  const scored: ScoredEvent[] = [];
  for (const r of rows) {
    const event = eventById(r.event_id);
    if (!event) continue;
    scored.push({ event, hits: JSON.parse(r.hits), score: r.score, verdict: r.verdict });
  }
  scored.sort((x, y) => Date.parse(x.event.ts) - Date.parse(y.event.ts));
  return { id: a.id, site_id: a.site_id, summary: JSON.parse(a.summary), scored };
}
