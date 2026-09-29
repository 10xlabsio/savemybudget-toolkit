// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
export type Source = 'beacon' | 'log' | 'csv';
export type Verdict = 'allow' | 'watch' | 'flag';

export interface Site {
  id: number;
  name: string;
  host: string;
  key: string;
  consent_mode: 'legitimate_interest' | 'consent_gated';
  target_countries: string[]; // ISO-3166 alpha-2
  created_at: string; // ISO
  first_event_at: string | null;
  last_seen_at: string | null;
}

/** One click record, whatever the source. Times are ISO UTC strings. */
export interface ClickEvent {
  id: number;
  site_id: number;
  source: Source;
  upload_id: number | null;
  received_at: string;
  ts: string;
  ip: string;
  ip_private: 0 | 1;
  asn: number | null;
  asn_name: string | null;
  is_hosting: 0 | 1;
  country: string | null;
  ua: string | null;
  ua_family: string | null;
  gclid: string;
  is_test: 0 | 1;
  session_id: string | null;
  fp_hash: string | null;
  dwell_ms: number | null;
  visible: 0 | 1 | null;
  interactions: number | null;
  automation: string[] | null; // marker names
  url: string | null;
  referer: string | null;
  campaign: string | null;
}

export interface RuleHit {
  rule: string;
  layer: 'network' | 'browser' | 'behaviour' | 'frequency';
  kind: 'hard' | 'soft';
  weight: number;
  note?: string;
}

export interface ScoredEvent {
  event: ClickEvent;
  hits: RuleHit[];
  score: number;
  verdict: Verdict;
}

export interface AnalysisSummary {
  site_id: number;
  range_from: string; // YYYY-MM-DD
  range_to: string;
  ran_at: string;
  counts: { total: number; allow: number; watch: number; flag: number; sources: Record<Source, number> };
  rules: Record<string, number>; // rule id -> events it fired on
  notes: string[]; // e.g. rule 9 downgraded
  top_asns: { asn: number | null; asn_name: string | null; count: number }[];
  top_subnets: { subnet: string; count: number }[];
  per_day: { day: string; total: number; flag: number }[];
}
