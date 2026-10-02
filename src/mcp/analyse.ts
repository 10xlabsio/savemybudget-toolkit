// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * Analysis on request, for the MCP tools. Runs the same `runAnalysis` the Analyse page runs, never saves it,
 * and keeps the last few results for 60 seconds so one agent turn (summary → breakdown → offenders) scores
 * the window once. Any bulk data change (import, deletion, site edit) empties the cache via dataGeneration();
 * live beacons are covered by the TTL.
 */
import { dataGeneration } from '../db.js';
import { runAnalysis } from '../rules/index.js';
import type { AnalysisSummary, ScoredEvent, Site } from '../types.js';

export type Analysis = { summary: AnalysisSummary; scored: ScoredEvent[]; computedAt: string };

const TTL_MS = 60_000;
const MAX_ENTRIES = 8;
const cache = new Map<string, { at: number; gen: number; value: Analysis }>();
let runs = 0;

export function analyse(site: Site, from: string, to: string, nowMs = Date.now()): Analysis {
  const key = `${site.id}|${from}|${to}|${site.target_countries.join(',')}`;
  const gen = dataGeneration();
  const hit = cache.get(key);
  if (hit && hit.gen === gen && nowMs - hit.at < TTL_MS) {
    cache.delete(key); cache.set(key, hit); // most recent last
    return hit.value;
  }
  runs++;
  const r = runAnalysis(site, from, to);
  const value: Analysis = { summary: r.summary, scored: r.scored, computedAt: new Date(nowMs).toISOString() };
  cache.set(key, { at: nowMs, gen, value });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return value;
}

/** For tests. */
export function analysisRuns(): number { return runs; }
export function clearAnalysisCache(): void { cache.clear(); }
