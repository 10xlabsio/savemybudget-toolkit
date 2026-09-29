// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDIT, TERMS_SENTENCE, config } from '../config.js';
import { db, getSite, now } from '../db.js';
import { subnet24 } from '../enrich/index.js';
import { RULES, loadAnalysis } from '../rules/index.js';
import type { AnalysisSummary, ScoredEvent, Site } from '../types.js';
import { writeZip } from './zip.js';

const RULE_TITLE = new Map(RULES.map((r) => [r.id, r.title]));
const titleOf = (id: string) => RULE_TITLE.get(id) ?? id;

// ---------- window check ----------

export function checkWindow(from: string, to: string, now: Date = new Date()): { ok: boolean; message?: string; warning?: string } {
  const f = Date.parse(`${from}T00:00:00Z`);
  const t = Date.parse(`${to}T23:59:59Z`);
  if (Number.isNaN(f) || Number.isNaN(t)) return { ok: false, message: 'Dates must be YYYY-MM-DD.' };
  if (f > t) return { ok: false, message: 'The window ends before it starts.' };
  const limit = now.getTime() - config.claimWindowDays * 86400e3;
  if (t < limit) {
    return { ok: false, message: `Google accepts requests for clicks in roughly the last ${config.claimWindowDays} days. This window ends on ${to}, which is outside that limit.` };
  }
  if (f < limit) {
    return { ok: true, warning: `This window starts before the ${config.claimWindowDays}-day limit (${new Date(limit).toISOString().slice(0, 10)}). Google is unlikely to review the earlier clicks; consider narrowing the window.` };
  }
  return { ok: true };
}

// ---------- CSV ----------

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const EVIDENCE_COLUMNS = ['gclid', 'timestamp_utc', 'ip', 'asn', 'asn_name', 'country', 'user_agent', 'campaign', 'rules_triggered', 'score', 'verdict'] as const;

function selectRows(scored: ScoredEvent[], includeWatch: boolean): ScoredEvent[] {
  return scored.filter((s) => s.verdict === 'flag' || (includeWatch && s.verdict === 'watch'));
}

export function evidenceCsv(scored: ScoredEvent[], includeWatch = false): string {
  const lines = [EVIDENCE_COLUMNS.join(',')];
  for (const s of selectRows(scored, includeWatch)) {
    const e = s.event;
    lines.push([
      e.gclid, e.ts, e.ip, e.asn, e.asn_name, e.country, e.ua, e.campaign,
      s.hits.map((h) => h.rule).join(';'), s.score, s.verdict,
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------- stats helpers ----------

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtDate(d: string): string {
  const dt = new Date(`${d}T00:00:00Z`);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function ipRanking(scored: ScoredEvent[]): { ip: string; count: number }[] {
  const m = new Map<string, number>();
  for (const s of scored) if (s.verdict === 'flag' && !s.event.ip_private) m.set(s.event.ip, (m.get(s.event.ip) ?? 0) + 1);
  return [...m].map(([ip, count]) => ({ ip, count })).sort((a, b) => b.count - a.count || (a.ip < b.ip ? -1 : 1));
}

function dominantRule(summary: AnalysisSummary, scored: ScoredEvent[]): { id: string; count: number } | null {
  const m = new Map<string, number>();
  for (const s of scored) if (s.verdict === 'flag') for (const h of s.hits) m.set(h.rule, (m.get(h.rule) ?? 0) + 1);
  let best: { id: string; count: number } | null = null;
  for (const [id, count] of m) if (!best || count > best.count) best = { id, count };
  if (!best) {
    for (const [id, count] of Object.entries(summary.rules)) if (count && (!best || count > best.count)) best = { id, count };
  }
  return best;
}

// ---------- summary.md ----------

export function renderSummary(site: Site, summary: AnalysisSummary, scored: ScoredEvent[]): string {
  const flagged = scored.filter((s) => s.verdict === 'flag');
  const L: string[] = [];
  L.push(`# ${site.host} — ${fmtDate(summary.range_from)} to ${fmtDate(summary.range_to)} (UTC)`);
  L.push('');
  L.push(`Clicks recorded: ${summary.counts.total}. Flagged: ${summary.counts.flag}. Watch: ${summary.counts.watch}.`);
  L.push('');
  const dom = dominantRule(summary, scored);
  if (dom) L.push(`Dominant pattern: ${titleOf(dom.id)} (${dom.count} of the flagged clicks).`);
  const ruleLines = Object.entries(summary.rules).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (ruleLines.length) {
    L.push('');
    L.push('Rules that fired:');
    L.push('');
    for (const [id, n] of ruleLines) L.push(`- ${titleOf(id)}: ${n}`);
  }
  if (summary.top_asns.length) {
    L.push('');
    L.push('Top networks among flagged clicks:');
    L.push('');
    for (const a of summary.top_asns) L.push(`- ${a.asn !== null ? `AS${a.asn}` : 'unknown ASN'}${a.asn_name ? ` (${a.asn_name})` : ''}: ${a.count}`);
  }
  if (summary.top_subnets.length) {
    L.push('');
    L.push('Top /24 ranges among flagged clicks:');
    L.push('');
    for (const s of summary.top_subnets) L.push(`- ${s.subnet}: ${s.count}`);
  }
  const flaggedBeacons = flagged.filter((s) => s.event.source === 'beacon');
  if (flaggedBeacons.length) {
    const dwell = median(flaggedBeacons.map((s) => s.event.dwell_ms).filter((d): d is number => d !== null));
    const withInteractionData = flaggedBeacons.filter((s) => s.event.interactions !== null);
    const zero = withInteractionData.filter((s) => s.event.interactions === 0).length;
    L.push('');
    L.push('Behaviour of flagged clicks with a tag beacon:');
    L.push('');
    if (dwell !== null) L.push(`- Median visible time: ${fmtSeconds(dwell)}`);
    if (withInteractionData.length) L.push(`- Share with no page interaction: ${Math.round((100 * zero) / withInteractionData.length)}% (${zero} of ${withInteractionData.length})`);
  }
  if (summary.notes.length) {
    L.push('');
    L.push('Notes from the analysis:');
    L.push('');
    for (const n of summary.notes) L.push(`- ${n}`);
  }
  L.push('');
  L.push('Records with timestamps (UTC), IP addresses, user agents and click IDs are attached.');
  L.push('');
  L.push('_This is a draft in your voice. Edit it before submitting; keep it to what was observed._');
  L.push('');
  L.push('---');
  L.push('');
  L.push(`Prepared with SaveMyBudget Toolkit ${config.version}.`);
  L.push(`Want this reviewed and filed for you? The managed version at ${config.hostedUrl} prepares and files claims on a no-win-no-fee basis. ${TERMS_SENTENCE}`);
  L.push(CREDIT);
  L.push('');
  return L.join('\n');
}

// ---------- form-answers.md ----------

export function renderFormAnswers(site: Site, summary: AnalysisSummary, scored: ScoredEvent[]): string {
  const ips = ipRanking(scored).slice(0, 20);
  const campaigns = new Map<string, number>();
  for (const s of scored) if (s.verdict === 'flag' && s.event.campaign) campaigns.set(s.event.campaign, (campaigns.get(s.event.campaign) ?? 0) + 1);
  const campaignText = campaigns.size
    ? [...campaigns].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} (${n})`).join(', ')
    : 'Not recorded in the package — narrow it to where the pattern showed in your Google Ads account.';
  const uaFamilies = new Map<string, number>();
  for (const s of scored) if (s.verdict === 'flag') uaFamilies.set(s.event.ua_family ?? 'unknown', (uaFamilies.get(s.event.ua_family ?? 'unknown') ?? 0) + 1);
  const uaText = [...uaFamilies].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f, n]) => `${f} (${n})`).join(', ');

  const L: string[] = [];
  L.push(`# Form answers — ${site.host}, ${summary.range_from} to ${summary.range_to}`);
  L.push('');
  L.push(`Google's form: ${config.googleFormUrl}`);
  L.push('Sign in with an account that has access to the Google Ads account.');
  L.push('');
  L.push('| Item | What to enter |');
  L.push('|---|---|');
  L.push('| Customer ID | enter yours (top of Google Ads, ten digits) |');
  L.push(`| Date range | ${summary.range_from} to ${summary.range_to} (UTC) |`);
  L.push(`| Campaigns, ad groups, keywords | ${campaignText} |`);
  L.push(`| IP addresses | ${ips.length ? ips.map((i) => i.ip).join(', ') : 'none flagged'} — full list in evidence.csv |`);
  L.push(`| Devices and browsers | ${uaText || 'see evidence.csv, user_agent column'} |`);
  L.push(`| GCLIDs | evidence.csv, gclid column (${scored.filter((s) => s.verdict === 'flag').length} rows) |`);
  L.push('| Summary of the issue | paste summary.md, edited in your own words |');
  L.push('| Attachment | evidence.csv |');
  L.push('');
  L.push('## IP addresses (top 20 flagged, by click count)');
  L.push('');
  for (const i of ips) L.push(`- ${i.ip} (${i.count})`);
  if (!ips.length) L.push('- none');
  L.push('');
  L.push('## /24 ranges');
  L.push('');
  for (const s of summary.top_subnets) L.push(`- ${s.subnet} (${s.count})`);
  if (!summary.top_subnets.length) L.push('- none');
  L.push('');
  L.push('## The four yes/no questions');
  L.push('');
  L.push('Google asks whether, in this period, you:');
  L.push('');
  L.push('1. changed targeting;');
  L.push('2. had ads approved;');
  L.push('3. raised budgets or bids;');
  L.push('4. already checked invalid clicks recently.');
  L.push('');
  L.push('They exist so Google can rule out benign causes for a spike. Answer them accurately from your own account history — the toolkit does not know. Before you send, check the Invalid clicks column in Google Ads for the window and leave out anything already credited.');
  L.push('');
  return L.join('\n');
}

// ---------- exclusions.txt ----------

export function exclusionsTxt(scored: ScoredEvent[], cap = 500): string {
  return ipRanking(scored).slice(0, cap).map((i) => i.ip).join('\n') + '\n';
}

// ---------- package ----------

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

export function buildPackage(analysisId: number, opts?: { includeWatch?: boolean; exclusions?: boolean }): { path: string; rows: number; package_id: number } {
  const a = loadAnalysis(analysisId);
  if (!a) throw new Error(`analysis ${analysisId} not found`);
  const site = getSite(a.site_id);
  if (!site) throw new Error(`site ${a.site_id} not found`);
  const includeWatch = opts?.includeWatch ?? false;
  const withExclusions = opts?.exclusions ?? true;
  const { summary, scored } = a;
  const rows = selectRows(scored, includeWatch);

  const report = {
    toolkit_version: config.version,
    site: { name: site.name, host: site.host },
    summary,
    events: rows.map((s) => ({
      gclid: s.event.gclid, ts: s.event.ts, source: s.event.source, ip: s.event.ip, asn: s.event.asn, asn_name: s.event.asn_name,
      country: s.event.country, ua: s.event.ua, ua_family: s.event.ua_family, campaign: s.event.campaign,
      dwell_ms: s.event.dwell_ms, visible: s.event.visible, interactions: s.event.interactions,
      rules: s.hits.map((h) => ({ rule: h.rule, kind: h.kind, weight: h.weight, ...(h.note ? { note: h.note } : {}) })),
      score: s.score, verdict: s.verdict,
    })),
  };

  const entries = [
    { name: 'evidence.csv', data: evidenceCsv(scored, includeWatch) },
    { name: 'summary.md', data: renderSummary(site, summary, scored) },
    { name: 'form-answers.md', data: renderFormAnswers(site, summary, scored) },
    { name: 'report.json', data: JSON.stringify(report, null, 2) + '\n' },
  ];
  if (withExclusions) entries.push({ name: 'exclusions.txt', data: exclusionsTxt(scored) });

  const dir = join(config.dataDir, 'packages');
  mkdirSync(dir, { recursive: true });
  // The row comes first so its id can be part of the file name: two packages for one analysis (say, with and
  // without watch rows) must never share a path, or building the second overwrites the first and deleting one
  // orphans the other.
  const d = db();
  const r = d.prepare('INSERT INTO packages(analysis_id,path,rows,created_at) VALUES(?,?,?,?)').run(analysisId, '', rows.length, now());
  const packageId = Number(r.lastInsertRowid);
  const path = join(dir, `claim-${slug(site.host)}-${summary.range_from}-${summary.range_to}-a${analysisId}-p${packageId}.zip`);
  try {
    writeFileSync(path, writeZip(entries));
  } catch (e) {
    d.prepare('DELETE FROM packages WHERE id = ?').run(packageId);
    throw e;
  }
  d.prepare('UPDATE packages SET path = ? WHERE id = ?').run(path, packageId);
  return { path, rows: rows.length, package_id: packageId };
}
