/** Apache/Nginx combined + common log format parsing. */

export const LOG_LINE_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" \d{3} \S+(?: "([^"]*)" "([^"]*)")?/;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const CLF_TS_RE = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s+([+-])(\d{2})(\d{2}))?$/;

/** `dd/Mon/yyyy:HH:MM:SS ±zzzz` → epoch ms (UTC), or null. */
export function parseClfTimestamp(s: string): number | null {
  const m = s.trim().match(CLF_TS_RE);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return null;
  const utc = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  if (Number.isNaN(utc)) return null;
  let offset = 0;
  if (m[7]) {
    offset = (Number(m[8]) * 60 + Number(m[9])) * 60_000;
    if (m[7] === '-') offset = -offset;
  }
  return utc - offset;
}

export interface LogLine {
  ip: string;
  tsMs: number | null;
  method: string;
  path: string;
  referer: string | null;
  ua: string | null;
}

export function parseLogLine(line: string): LogLine | null {
  const m = line.match(LOG_LINE_RE);
  if (!m) return null;
  const dash = (v: string | undefined) => (v === undefined || v === '-' || v === '' ? null : v);
  return {
    ip: m[1],
    tsMs: parseClfTimestamp(m[2]),
    method: m[3],
    path: m[4],
    referer: dash(m[5]),
    ua: dash(m[6]),
  };
}

export function looksLikeLogLine(line: string): boolean {
  return LOG_LINE_RE.test(line);
}

/** Extract the gclid query parameter from a request path or URL. */
export function gclidFromPath(path: string): string | null {
  const q = path.indexOf('?');
  if (q === -1) return null;
  let query = path.slice(q + 1);
  const hash = query.indexOf('#');
  if (hash !== -1) query = query.slice(0, hash);
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const k = eq === -1 ? part : part.slice(0, eq);
    if (k.toLowerCase() !== 'gclid') continue;
    const v = eq === -1 ? '' : part.slice(eq + 1);
    try { return decodeURIComponent(v.replace(/\+/g, ' ')).trim(); } catch { return v.trim(); }
  }
  return null;
}
