// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/** Fixed-window-per-key request limiter, in memory. The collector and the MCP endpoint each own one. */

export type RateLimiter = (key: string, at?: number) => boolean;

/** Returns `limited(key)`: true once `key` has made `limit` requests within the last `windowMs`. */
export function makeRateLimiter(limit: number, windowMs: number): RateLimiter {
  const hits = new Map<string, number[]>();
  let lastSweep = 0;
  return function limited(key: string, at = Date.now()): boolean {
    if (at - lastSweep > windowMs) {
      for (const [k, v] of hits) {
        const kept = v.filter((t) => at - t < windowMs);
        if (kept.length) hits.set(k, kept); else hits.delete(k);
      }
      lastSweep = at;
    }
    const arr = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
    if (arr.length >= limit) { hits.set(key, arr); return true; }
    arr.push(at);
    hits.set(key, arr);
    return false;
  };
}
