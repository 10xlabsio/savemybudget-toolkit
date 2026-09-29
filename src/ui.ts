/** Shared UI plumbing: env type, CSRF secret, public URL, formatting helpers, static lists. */
import { randomBytes } from 'node:crypto';
import { domainToASCII, domainToUnicode, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { config } from './config.js';
import { getSetting } from './db.js';
import type { Site } from './types.js';

export type AppEnv = {
  Bindings: HttpBindings;
  /** rawBody: a multipart body read under the upload cap by the UI middleware (see readBodyCapped). */
  Variables: { nonce: string; sites: Site[]; rawBody?: Buffer };
};
export type Ctx = Context<AppEnv>;

/** Project root (parent of src/ or dist/). */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DOCS_DIR = join(ROOT, 'docs');
export const TEMPLATES_DIR = join(ROOT, 'templates');
export const DATA_ASSETS_DIR = join(ROOT, 'data');

/** Per-process CSRF secret (spec: cookie smb_csrf, compared with _csrf field / x-csrf header). */
export const CSRF_SECRET = randomBytes(24).toString('hex');
export const CSRF_COOKIE = 'smb_csrf';

export function publicUrl(): string {
  const s = getSetting('public_url');
  return (s && s.trim()) || config.publicUrl || '';
}
export function tz(): string {
  return getSetting('tz') || config.tz || 'UTC';
}

/** Render a JSX tree as a full HTML document response. */
export async function page(c: Ctx, node: unknown, status = 200): Promise<Response> {
  const body = await (node as Promise<string> | string);
  return c.html('<!doctype html>\n' + String(body), status as 200);
}

/** Bytes a multipart request may carry: the upload cap plus 1 MiB for boundaries and other fields. */
export const multipartCapBytes = () => (config.maxUploadMb + 1) * 1048576;

/**
 * Read a request body with a hard byte cap, without trusting Content-Length (a chunked body has none).
 * Returns null once more than `cap` bytes have arrived; the stream is cancelled at that point.
 */
export async function readBodyCapped(req: Request, cap: number): Promise<Buffer | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > cap) { try { await req.body?.cancel(); } catch { /* ignore */ } return null; }
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Parse an already-buffered multipart/urlencoded body the way Hono's parseBody({ all: true }) would. */
export async function parseBufferedForm(buf: Buffer, contentType: string): Promise<Record<string, string | File | (string | File)[]>> {
  const fd = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': contentType }, body: bytes(buf) }).formData();
  const out: Record<string, string | File | (string | File)[]> = {};
  for (const [k, v] of fd.entries()) {
    const cur = out[k];
    if (cur === undefined) out[k] = v;
    else if (Array.isArray(cur)) cur.push(v);
    else out[k] = [cur, v];
  }
  return out;
}

/** Buffer → Uint8Array over its own ArrayBuffer (what Response bodies accept in strict typings). */
export function bytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(buf.byteLength));
  out.set(buf);
  return out;
}

// ---------- formatting ----------

export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} d ago`;
  return `${Math.round(d / 30)} mo ago`;
}

export function fmtTime(iso: string | null | undefined, opts: { date?: boolean; time?: boolean } = {}): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const date = opts.date ?? true, time = opts.time ?? true;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz(),
      ...(date ? { day: '2-digit', month: 'short' } : {}),
      ...(time ? { hour: '2-digit', minute: '2-digit' } : {}),
    }).format(new Date(t));
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

export function fmtDay(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return day;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(t));
}

export const n = (x: number) => x.toLocaleString('en-GB');
export const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((1000 * part) / whole) / 10}%` : '0%');
export const today = () => new Date().toISOString().slice(0, 10);
export const daysAgo = (d: number) => new Date(Date.now() - d * 86400e3).toISOString().slice(0, 10);
export const escJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// ---------- hostname / site validation ----------

const PLACEHOLDER_HOSTS = ['google.com', 'example.com', 'example.org', 'example.net', 'localhost', 'chrome.com', 'demo.com', 'test.com', 'yourbrand.com', 'yoursite.com', 'mysite.com'];
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/; // one DNS label; no nested quantifier, linear time
const TLD_RE = /^[a-z][a-z0-9-]{1,62}$/;

/** Linear-time hostname check: total length, at least two labels, each label 1–63 chars, alphabetic TLD. */
function isHostname(h: string): boolean {
  if (h.length < 1 || h.length > 253) return false;
  const labels = h.split('.');
  if (labels.length < 2) return false;
  for (let i = 0; i < labels.length - 1; i++) if (!LABEL_RE.test(labels[i])) return false;
  return TLD_RE.test(labels[labels.length - 1]);
}

/** Returns the normalised (punycode, lower-case) hostname or an error message. */
export function validateHost(raw: string): { host: string } | { error: string } {
  let h = (raw || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return { error: 'Enter the hostname your ads land on, for example shop.yourbrand.com.' };
  if (/^[a-z]+:\/\//.test(h)) return { error: 'Enter just the hostname, without http:// or https://.' };
  if (/[/?#:@\s]/.test(h)) return { error: 'Enter just the hostname — no path, port or query string.' };
  // Internationalised names (münchen-shop.de) are stored as punycode (xn--mnchen-shop-9db.de), which is what DNS and the browser's Origin header use.
  const ascii = domainToASCII(h);
  if (ascii) h = ascii.toLowerCase();
  const bare = h.replace(/^www\./, '');
  if (PLACEHOLDER_HOSTS.some((p) => bare === p || bare.endsWith('.' + p))) {
    return { error: 'That looks like a placeholder. Enter the hostname your ads actually land on, for example shop.yourbrand.com.' };
  }
  if (!isHostname(h)) return { error: 'That does not look like a hostname. Use letters, digits, hyphens and dots, for example shop.yourbrand.com.' };
  return { host: h };
}

/** Unicode form of a stored (punycode) hostname, for display. */
export function displayHost(host: string): string {
  try { return domainToUnicode(host) || host; } catch { return host; }
}

export function makeSiteKey(host: string): string {
  const slug = host.replace(/^www\./, '').replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'site';
  return `sk_${slug}_${randomBytes(4).toString('hex')}`;
}

// ---------- static lists ----------

export const COUNTRIES: [string, string][] = [
  ['GB', 'United Kingdom'], ['US', 'United States'], ['IE', 'Ireland'], ['DE', 'Germany'], ['FR', 'France'], ['ES', 'Spain'], ['IT', 'Italy'],
  ['NL', 'Netherlands'], ['BE', 'Belgium'], ['AT', 'Austria'], ['CH', 'Switzerland'], ['PT', 'Portugal'], ['SE', 'Sweden'], ['NO', 'Norway'],
  ['DK', 'Denmark'], ['FI', 'Finland'], ['PL', 'Poland'], ['CZ', 'Czechia'], ['HU', 'Hungary'], ['RO', 'Romania'], ['BG', 'Bulgaria'], ['GR', 'Greece'],
  ['HR', 'Croatia'], ['SK', 'Slovakia'], ['SI', 'Slovenia'], ['LT', 'Lithuania'], ['LV', 'Latvia'], ['EE', 'Estonia'], ['LU', 'Luxembourg'], ['MT', 'Malta'],
  ['CY', 'Cyprus'], ['UA', 'Ukraine'], ['TR', 'Türkiye'], ['CA', 'Canada'], ['MX', 'Mexico'], ['BR', 'Brazil'], ['AR', 'Argentina'], ['CL', 'Chile'],
  ['CO', 'Colombia'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['JP', 'Japan'], ['KR', 'South Korea'], ['SG', 'Singapore'], ['HK', 'Hong Kong'],
  ['TW', 'Taiwan'], ['IN', 'India'], ['ID', 'Indonesia'], ['MY', 'Malaysia'], ['PH', 'Philippines'], ['TH', 'Thailand'], ['VN', 'Vietnam'],
  ['AE', 'United Arab Emirates'], ['SA', 'Saudi Arabia'], ['IL', 'Israel'], ['ZA', 'South Africa'], ['NG', 'Nigeria'], ['KE', 'Kenya'], ['EG', 'Egypt'], ['MA', 'Morocco'],
];
export const COUNTRY_CODES = new Set(COUNTRIES.map(([c]) => c));

export const TIMEZONES: string[] = [
  'UTC', 'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam',
  'Europe/Brussels', 'Europe/Zurich', 'Europe/Vienna', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen', 'Europe/Helsinki', 'Europe/Warsaw',
  'Europe/Prague', 'Europe/Budapest', 'Europe/Athens', 'Europe/Bucharest', 'Europe/Sofia', 'Europe/Kyiv', 'Europe/Istanbul', 'America/New_York',
  'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Sao_Paulo',
  'America/Buenos_Aires', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai',
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth', 'Pacific/Auckland', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Cairo',
];
