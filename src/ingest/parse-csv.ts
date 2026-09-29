// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/** RFC 4180 CSV parsing + header alias mapping. */

export type Delimiter = ',' | ';' | '\t';

export const CANONICAL = ['timestamp', 'ip', 'gclid', 'user_agent', 'url', 'referer', 'campaign'] as const;
export type Canonical = (typeof CANONICAL)[number];
export const REQUIRED: Canonical[] = ['timestamp', 'ip', 'gclid'];

const ALIASES: Record<string, Canonical> = {
  timestamp: 'timestamp', time: 'timestamp', datetime: 'timestamp', ts: 'timestamp', date: 'timestamp',
  date_time: 'timestamp', click_time: 'timestamp', clicktime: 'timestamp', event_time: 'timestamp', created_at: 'timestamp',
  ip: 'ip', client_ip: 'ip', remote_addr: 'ip', ip_address: 'ip', ipaddress: 'ip', remote_ip: 'ip', visitor_ip: 'ip', address: 'ip',
  gclid: 'gclid', click_id: 'gclid', clickid: 'gclid', google_click_id: 'gclid',
  user_agent: 'user_agent', ua: 'user_agent', useragent: 'user_agent', agent: 'user_agent', browser: 'user_agent',
  url: 'url', page: 'url', landing_page: 'url', landingpage: 'url', landing_url: 'url', page_url: 'url', request: 'url', path: 'url',
  referer: 'referer', referrer: 'referer', ref: 'referer', http_referer: 'referer',
  campaign: 'campaign', campaign_name: 'campaign', utm_campaign: 'campaign',
};

export function normalizeHeader(h: string): string {
  return h.replace(/^﻿/, '').trim().toLowerCase().replace(/[\s\-.]+/g, '_');
}

/** Map actual headers to canonical names. `manual` is canonical -> actual header (overrides aliases). */
export function mapHeaders(headers: string[], manual?: Record<string, string>): { mapping: Record<string, string>; unmapped: string[] } {
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  if (manual) {
    for (const [canon, actual] of Object.entries(manual)) {
      if (!(CANONICAL as readonly string[]).includes(canon)) continue;
      const found = headers.find((h) => h === actual || normalizeHeader(h) === normalizeHeader(actual));
      if (found !== undefined && !used.has(found)) { mapping[canon] = found; used.add(found); }
    }
  }
  for (const h of headers) {
    if (used.has(h)) continue;
    const canon = ALIASES[normalizeHeader(h)];
    if (canon && mapping[canon] === undefined) { mapping[canon] = h; used.add(h); }
  }
  const unmapped = headers.filter((h) => !used.has(h) && h.trim() !== '');
  return { mapping, unmapped };
}

export function sniffDelimiter(firstLine: string): Delimiter {
  const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === ',' || ch === ';' || ch === '\t')) counts[ch as Delimiter]++;
  }
  let best: Delimiter = ',';
  for (const d of ['\t', ';'] as Delimiter[]) if (counts[d] > counts[best]) best = d;
  return best;
}

/** Full RFC 4180 parse. Returns rows as arrays of cells; `line` is the 1-based line the record started on. */
export function parseCsv(text: string, delim: Delimiter): { cells: string[]; line: number }[] {
  const rows: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQ = false;
  let line = 1;
  let startLine = 1;
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      if (ch === '\n') line++;
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === delim) { cells.push(cell); cell = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      cells.push(cell); cell = '';
      if (!(cells.length === 1 && cells[0] === '')) rows.push({ cells, line: startLine });
      cells = []; line++; startLine = line; i++; continue;
    }
    cell += ch; i++;
  }
  cells.push(cell);
  if (!(cells.length === 1 && cells[0] === '')) rows.push({ cells, line: startLine });
  return rows;
}

/** First physical line of a text (without BOM / CR). */
export function firstLine(text: string): string {
  const t = text.replace(/^﻿/, '');
  const nl = t.indexOf('\n');
  return (nl === -1 ? t : t.slice(0, nl)).replace(/\r$/, '');
}

export function splitHeader(line: string, delim: Delimiter): string[] {
  const r = parseCsv(line, delim);
  return r.length ? r[0].cells.map((c) => c.trim()) : [];
}
