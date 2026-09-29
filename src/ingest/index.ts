/** Upload detection, preview and import (docs/inputs.md). */
import { gunzipSync } from 'node:zlib';
import { config } from '../config.js';
import { db, insertEvents, now, type NewEvent } from '../db.js';
import { enrichIp, parseUa } from '../enrich/index.js';
import { firstLine, mapHeaders, normalizeHeader, parseCsv, sniffDelimiter, splitHeader, REQUIRED, type Delimiter } from './parse-csv.js';
import { gclidFromPath, looksLikeLogLine, parseLogLine } from './parse-log.js';
import { emptyDropped, validateRows, type Dropped, type ParsedRow as VRow, type RawRow } from './validate.js';

export type UploadFormat = 'csv' | 'log';
export type ParsedRow = VRow;

export interface Preview {
  ok: boolean;
  format: UploadFormat | null;
  errors: { message: string; lines?: number[] }[];
  warnings: string[];
  rows_total: number;
  rows_usable: number;
  dropped: Dropped;
  range_from: string | null;
  range_to: string | null;
  distinct_ips: number;
  distinct_gclids: number;
  sample: ParsedRow[];
  mapping?: Record<string, string>;
  /** Headers of the file no canonical column claimed (CSV only). */
  unmapped_headers?: string[];
  /** Every header in the file, in order (CSV only) — what the mapping form offers. */
  headers?: string[];
  /** Required canonical columns the mapping did not cover (CSV only; non-empty means ok=false). */
  missing?: string[];
}

export interface UploadOpts { retentionDays: number; mapping?: Record<string, string>; now?: Date; maxUploadMb?: number }

const GENERIC_MSG = 'Upload a CSV with timestamp, ip and gclid columns, or an Apache/Nginx access log.';
const ADS_MSG = "This looks like a Google Ads export — it has no IP addresses or click IDs, so it can't be used as evidence. Use your web server log or the CSV template.";
const GA_MSG = "This looks like a Google Analytics export — it has no IP addresses or click IDs, so it can't be used as evidence. Use your web server log or the CSV template.";
const IIS_MSG = 'This is an IIS (W3C) log, which is not supported. Use an Apache/Nginx combined-format log or the CSV template.';
const TEMPLATE_MSG = 'This is the template. Replace the example rows with your own data.';

// ---------- decoding / sniffing ----------

interface Decoded { text: string; warnings: string[]; error?: string }

function decode(buf: Buffer, filename: string, maxBytes: number): Decoded {
  const warnings: string[] = [];
  let bytes = buf;
  if (/\.gz$/i.test(filename) || (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
    // The documented upload limit is the uncompressed size; a small .gz must not be allowed to inflate without bound.
    try {
      bytes = gunzipSync(buf, { maxOutputLength: maxBytes });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ERR_BUFFER_TOO_LARGE') return { text: '', warnings, error: `Decompressed, the file exceeds ${Math.round(maxBytes / 1048576)} MB. Split it, or raise SMB_MAX_UPLOAD_MB.` };
      return { text: '', warnings, error: 'The .gz file could not be decompressed.' };
    }
  }
  // Magic bytes first: a zip/xlsx/PDF/PNG contains NUL bytes too, and deserves its own message.
  const head = bytes.subarray(0, 64).toString('latin1').replace(/^\xEF\xBB\xBF/, '').trimStart();
  if (head.startsWith('PK')) return { text: '', warnings, error: 'Zip and Excel workbooks are not supported. Export as CSV instead.' };
  if (head.startsWith('%PDF') || head.startsWith('\x89PNG')) return { text: '', warnings, error: 'This is not a text file. ' + GENERIC_MSG };
  if (bytes.includes(0)) return { text: '', warnings, error: 'This is a binary file. ' + GENERIC_MSG };
  if (head.startsWith('{') || head.startsWith('[')) return { text: '', warnings, error: 'JSON files are not supported. ' + GENERIC_MSG };
  if (head.startsWith('<')) return { text: '', warnings, error: 'HTML/XML files are not supported. ' + GENERIC_MSG };

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = bytes.toString('latin1');
    warnings.push('The file is not valid UTF-8. It was read as Latin-1; non-ASCII characters may be wrong.');
  }
  return { text: text.replace(/^﻿/, ''), warnings };
}

function nonEmptyLines(text: string, max: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length && out.length < max) {
    let nl = text.indexOf('\n', start);
    if (nl === -1) nl = text.length;
    const line = text.slice(start, nl).replace(/\r$/, '');
    if (line.trim() !== '') out.push(line);
    start = nl + 1;
  }
  return out;
}

type Detection =
  | { format: 'log' }
  | { format: 'csv'; delim: Delimiter; headers: string[]; mapping: Record<string, string>; unmapped: string[]; missing: string[] }
  | { format: null; error: string };

function detect(text: string, manual?: Record<string, string>): Detection {
  const lines = nonEmptyLines(text, 200);
  if (lines.length === 0) return { format: null, error: 'The file is empty. ' + GENERIC_MSG };

  const logMatches = lines.filter(looksLikeLogLine).length;
  if (logMatches / lines.length >= 0.8) return { format: 'log' };

  const header = firstLine(text);
  if (header.startsWith('#Fields:') || lines.some((l) => l.startsWith('#Fields:'))) return { format: null, error: IIS_MSG };

  const delim = sniffDelimiter(header);
  const headers = splitHeader(header, delim);
  const { mapping, unmapped } = mapHeaders(headers, manual);
  const missing = REQUIRED.filter((k) => mapping[k] === undefined);
  if (missing.length === 0) return { format: 'csv', delim, headers, mapping, unmapped, missing };

  const norm = headers.map(normalizeHeader);
  const has = (s: string) => norm.includes(s);
  if (has('campaign') && (has('cost') || has('clicks')) && mapping.ip === undefined) return { format: null, error: ADS_MSG };
  if (has('sessions') && has('users')) return { format: null, error: GA_MSG };
  if (logMatches > 0) {
    return { format: null, error: `Only ${logMatches} of the first ${lines.length} lines look like Apache/Nginx combined-format log lines. Upload the raw access log as written by the server.` };
  }
  // A CSV whose header names we don't know (When,Addr,ClickRef): still a CSV. Report it as one, with the
  // headers, so the upload page can offer the column-mapping form; the mapping step decides what is missing.
  if (headers.length >= 2) return { format: 'csv', delim, headers, mapping, unmapped, missing };
  return { format: null, error: GENERIC_MSG };
}

// ---------- extraction ----------

function extractCsv(text: string, det: Extract<Detection, { format: 'csv' }>): { raw: RawRow[]; total: number; template: boolean; templateLines: number[] } {
  const records = parseCsv(text, det.delim);
  const idx: Record<string, number> = {};
  for (const [canon, actual] of Object.entries(det.mapping)) idx[canon] = det.headers.indexOf(actual);
  const cell = (cells: string[], canon: string): string => {
    const i = idx[canon];
    return i === undefined || i < 0 || i >= cells.length ? '' : cells[i];
  };
  const raw: RawRow[] = [];
  const templateLines: number[] = [];
  for (let r = 1; r < records.length; r++) {
    const { cells, line } = records[r];
    if (cells.every((c) => c.trim() === '')) continue;
    const gclid = cell(cells, 'gclid');
    const url = cell(cells, 'url');
    if (gclid.includes('EXAMPLE') || url.includes('example.com')) templateLines.push(line);
    raw.push({
      ts: cell(cells, 'timestamp'),
      ip: cell(cells, 'ip'),
      gclid,
      ua: cell(cells, 'user_agent') || null,
      url: url || null,
      referer: cell(cells, 'referer') || null,
      campaign: cell(cells, 'campaign') || null,
      line,
    });
  }
  return { raw, total: raw.length, template: templateLines.length > 0, templateLines };
}

function extractLog(text: string): { raw: RawRow[]; total: number; noGclidLines: number; unparsed: number } {
  const raw: RawRow[] = [];
  let total = 0, noGclidLines = 0, unparsed = 0;
  let start = 0, lineNo = 0;
  while (start < text.length) {
    let nl = text.indexOf('\n', start);
    if (nl === -1) nl = text.length;
    const line = text.slice(start, nl).replace(/\r$/, '');
    start = nl + 1;
    lineNo++;
    if (line.trim() === '') continue;
    total++;
    const p = parseLogLine(line);
    if (!p) { unparsed++; continue; }
    if (!/[?&]gclid=/i.test(p.path)) { noGclidLines++; continue; }
    raw.push({
      tsMs: p.tsMs,
      ip: p.ip,
      gclid: gclidFromPath(p.path) ?? '',
      ua: p.ua,
      url: p.path,
      referer: p.referer,
      campaign: null,
      line: lineNo,
    });
  }
  return { raw, total, noGclidLines, unparsed };
}

// ---------- preview ----------

function summarize(rows: ParsedRow[]): Pick<Preview, 'range_from' | 'range_to' | 'distinct_ips' | 'distinct_gclids' | 'sample' | 'rows_usable'> {
  let from: string | null = null, to: string | null = null;
  const ips = new Set<string>(), gclids = new Set<string>();
  for (const r of rows) {
    const d = r.ts.slice(0, 10);
    if (from === null || d < from) from = d;
    if (to === null || d > to) to = d;
    ips.add(r.ip); gclids.add(r.gclid);
  }
  return { range_from: from, range_to: to, distinct_ips: ips.size, distinct_gclids: gclids.size, sample: rows.slice(0, 10), rows_usable: rows.length };
}

function failed(format: UploadFormat | null, errors: Preview['errors'], warnings: string[] = [], extra: Partial<Preview> = {}): Preview {
  return {
    ok: false, format, errors, warnings, rows_total: 0, rows_usable: 0, dropped: emptyDropped(),
    range_from: null, range_to: null, distinct_ips: 0, distinct_gclids: 0, sample: [], ...extra,
  };
}

function analyze(buf: Buffer, filename: string, opts: UploadOpts): { format: UploadFormat | null; rows: ParsedRow[]; preview: Preview } {
  const dec = decode(buf, filename, (opts.maxUploadMb ?? config.maxUploadMb) * 1048576);
  if (dec.error) return { format: null, rows: [], preview: failed(null, [{ message: dec.error }], dec.warnings) };
  const warnings = [...dec.warnings];

  const det = detect(dec.text, opts.mapping);
  if (det.format === null) return { format: null, rows: [], preview: failed(null, [{ message: det.error }], warnings) };
  if (det.format === 'csv' && det.missing.length) {
    // Not importable yet: hand back the file's headers so the user can map them by hand.
    const msg = `The CSV header is missing required column${det.missing.length > 1 ? 's' : ''}: ${det.missing.join(', ')}. Map them below or use the template.`;
    return { format: 'csv', rows: [], preview: failed('csv', [{ message: msg }], warnings, { mapping: det.mapping, unmapped_headers: det.unmapped, headers: det.headers, missing: det.missing }) };
  }

  let raw: RawRow[];
  let total: number;
  let noGclidLines = 0;
  let extra: Partial<Preview> = {};
  let hardErrors: Preview['errors'] = [];

  if (det.format === 'csv') {
    if (det.delim !== ',') warnings.push(`The file is ${det.delim === ';' ? 'semicolon' : 'tab'}-separated; it was read accordingly.`);
    const ex = extractCsv(dec.text, det);
    raw = ex.raw; total = ex.total;
    extra = { mapping: det.mapping, unmapped_headers: det.unmapped, headers: det.headers };
    if (ex.template) hardErrors.push({ message: TEMPLATE_MSG, lines: ex.templateLines });
  } else {
    const ex = extractLog(dec.text);
    raw = ex.raw; total = ex.total; noGclidLines = ex.noGclidLines;
    if (ex.unparsed > 0) warnings.push(`${ex.unparsed} line${ex.unparsed === 1 ? '' : 's'} did not match the combined/common log format and were skipped.`);
  }

  const v = validateRows(raw, { retentionDays: opts.retentionDays, now: opts.now, noGclidLines });
  const errors = [...hardErrors, ...v.errors];
  const preview: Preview = {
    ok: errors.length === 0,
    format: det.format,
    errors,
    warnings: [...warnings, ...v.warnings],
    rows_total: total,
    dropped: v.dropped,
    ...summarize(v.rows),
    ...extra,
  };
  return { format: det.format, rows: v.rows, preview };
}

// ---------- public API ----------

export function analyzeUpload(buf: Buffer, filename: string, opts: UploadOpts): Preview {
  return analyze(buf, filename, opts).preview;
}

export function parseUploadRows(buf: Buffer, filename: string, opts: UploadOpts): { format: UploadFormat; rows: ParsedRow[]; preview: Preview } {
  const r = analyze(buf, filename, opts);
  if (!r.preview.ok || r.format === null) {
    const err = new Error(r.preview.errors[0]?.message ?? 'Upload rejected.');
    (err as Error & { preview: Preview }).preview = r.preview;
    throw err;
  }
  return { format: r.format, rows: r.rows, preview: r.preview };
}

export function importUpload(siteId: number, buf: Buffer, filename: string, opts: UploadOpts): { upload_id: number; imported: number; preview: Preview } {
  const { format, rows, preview } = parseUploadRows(buf, filename, opts);
  const received = now();
  const d = db();
  const up = d.prepare(
    'INSERT INTO uploads(site_id,filename,format,rows_total,rows_imported,dropped,range_from,range_to,created_at) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id',
  ).get(siteId, filename.slice(0, 255), format, preview.rows_total, rows.length, JSON.stringify(preview.dropped), preview.range_from, preview.range_to, received) as { id: number };
  const uploadId = Number(up.id);

  const events: NewEvent[] = rows.map((r) => {
    const en = enrichIp(r.ip);
    const uaInfo = parseUa(r.ua);
    return {
      site_id: siteId,
      source: format,
      upload_id: uploadId,
      received_at: received,
      ts: r.ts,
      ip: r.ip,
      ip_private: en.ip_private,
      asn: en.asn,
      asn_name: en.asn_name,
      is_hosting: en.is_hosting,
      country: en.country,
      ua: r.ua,
      ua_family: r.ua ? uaInfo.family : null,
      gclid: r.gclid,
      is_test: r.gclid.startsWith('SMBTEST') ? 1 : 0,
      session_id: null,
      fp_hash: null,
      dwell_ms: null,
      visible: null,
      interactions: null,
      automation: uaInfo.automation.length ? uaInfo.automation : null,
      url: r.url,
      referer: r.referer,
      campaign: r.campaign,
    };
  });
  const imported = insertEvents(events);
  return { upload_id: uploadId, imported, preview };
}
