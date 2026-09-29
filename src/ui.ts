/** Shared UI plumbing: env type, CSRF secret, public URL, formatting helpers, static lists. */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { config } from './config.js';
import { getSetting } from './db.js';
import type { Site } from './types.js';

export type AppEnv = {
  Bindings: HttpBindings;
  Variables: { nonce: string; sites: Site[] };
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
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

/** Returns the normalised hostname or an error message. */
export function validateHost(raw: string): { host: string } | { error: string } {
  let h = (raw || '').trim().toLowerCase();
  if (!h) return { error: 'Enter the hostname your ads land on, for example shop.yourbrand.com.' };
  if (/^[a-z]+:\/\//.test(h)) return { error: 'Enter just the hostname, without http:// or https://.' };
  if (/[/?#:@\s]/.test(h)) return { error: 'Enter just the hostname — no path, port or query string.' };
  const bare = h.replace(/^www\./, '');
  if (PLACEHOLDER_HOSTS.some((p) => bare === p || bare.endsWith('.' + p))) {
    return { error: 'That looks like a placeholder. Enter the hostname your ads actually land on, for example shop.yourbrand.com.' };
  }
  if (!HOST_RE.test(h)) return { error: 'That does not look like a hostname. Use letters, digits, hyphens and dots, for example shop.yourbrand.com.' };
  return { host: h };
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
