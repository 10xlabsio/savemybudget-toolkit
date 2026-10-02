// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isIP } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'data');

// ---------- IP → ASN (iptoasn.com snapshot, IPv4) ----------

let starts: Uint32Array | null = null;
let ends: Uint32Array | null = null;
let asns: Uint32Array | null = null;
let countries: string[] = [];
let names: string[] = [];

function loadAsnTable() {
  if (starts) return;
  const p = join(dataDir, 'ip2asn-v4.tsv.gz');
  if (!existsSync(p)) {
    starts = new Uint32Array(0); ends = new Uint32Array(0); asns = new Uint32Array(0);
    return;
  }
  const text = gunzipSync(readFileSync(p)).toString('utf8');
  const lines = text.split('\n');
  const s: number[] = [], e: number[] = [], a: number[] = [];
  const nameIdx = new Map<string, number>();
  const cIdx = new Map<string, number>();
  const nameOf: number[] = [], cOf: number[] = [];
  for (const line of lines) {
    if (!line) continue;
    const [rs, re, ra, rc, rn] = line.split('\t');
    const asn = Number(ra);
    if (!asn) continue; // 0 = not routed
    s.push(ipv4ToInt(rs)); e.push(ipv4ToInt(re)); a.push(asn);
    let ni = nameIdx.get(rn); if (ni === undefined) { ni = names.length; names.push(rn); nameIdx.set(rn, ni); }
    let ci = cIdx.get(rc); if (ci === undefined) { ci = countries.length; countries.push(rc); cIdx.set(rc, ci); }
    nameOf.push(ni); cOf.push(ci);
  }
  starts = Uint32Array.from(s); ends = Uint32Array.from(e); asns = Uint32Array.from(a);
  nameIndex = Uint32Array.from(nameOf); countryIndex = Uint32Array.from(cOf);
}
let nameIndex: Uint32Array = new Uint32Array(0);
let countryIndex: Uint32Array = new Uint32Array(0);

export function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export interface AsnInfo { asn: number | null; asn_name: string | null; country: string | null }

export function lookupAsn(ip: string): AsnInfo {
  loadAsnTable();
  if (isIP(ip) !== 4 || !starts || starts.length === 0) return { asn: null, asn_name: null, country: null };
  const x = ipv4ToInt(ip);
  let lo = 0, hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] > x) hi = mid - 1;
    else if (ends![mid] < x) lo = mid + 1;
    else return { asn: asns![mid], asn_name: names[nameIndex[mid]], country: countries[countryIndex[mid]] === 'None' ? null : countries[countryIndex[mid]] };
  }
  return { asn: null, asn_name: null, country: null };
}

// ---------- hosting ASNs ----------

let hosting: Set<number> | null = null;
export function isHostingAsn(asn: number | null): boolean {
  if (asn === null) return false;
  if (!hosting) {
    hosting = new Set();
    const p = join(dataDir, 'hosting-asns.txt');
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const n = Number(t.split(/\s+/)[0]);
        if (n) hosting.add(n);
      }
    }
  }
  return hosting.has(asn);
}

// ---------- private / reserved ----------

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0 || a >= 224;
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fe80:') || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.') || l.startsWith('::ffff:127.');
  }
  return false;
}

/** The /24 for IPv4, the /64 for IPv6. IPv6 is expanded first, so `2001:db8::1` and `2001:db8:0:0::2` share a key. */
export function subnet24(ip: string): string {
  if (isIP(ip) === 4) return ip.split('.').slice(0, 3).join('.') + '.0/24';
  return ipv6Groups(ip).slice(0, 4).join(':') + '::/64';
}

/** Eight lower-case hex groups without leading zeros; handles `::` and an embedded IPv4 tail. */
function ipv6Groups(ip: string): string[] {
  let v = ip.toLowerCase().split('%')[0];
  if (v.includes('.')) {
    const at = v.lastIndexOf(':');
    const o = v.slice(at + 1).split('.').map(Number);
    v = v.slice(0, at + 1) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = v.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length > 1 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return groups.map((g) => (parseInt(g || '0', 16) || 0).toString(16));
}

// ---------- user agent ----------

export interface UaInfo { family: string; automation: string[] }

const BOT_UA = /HeadlessChrome|PhantomJS|Selenium|Puppeteer|Playwright|WebDriver|python-requests|python-urllib|curl\/|wget\/|Go-http-client|okhttp|Java\/|libwww|Scrapy|HttpClient|node-fetch|axios\/|aiohttp|bot\b|crawler|spider|slurp/i;

export function parseUa(ua: string | null | undefined): UaInfo {
  if (!ua) return { family: 'unknown', automation: [] };
  const automation: string[] = [];
  const m = ua.match(BOT_UA);
  if (m) automation.push(`ua:${m[0].replace(/[\/\\]/g, '').toLowerCase()}`);
  let family = 'other';
  if (/Edg\//.test(ua)) family = 'edge';
  else if (/OPR\//.test(ua)) family = 'opera';
  else if (/SamsungBrowser/.test(ua)) family = 'samsung';
  else if (/Chrome\//.test(ua)) family = 'chrome';
  else if (/Firefox\//.test(ua)) family = 'firefox';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) family = 'safari';
  else if (/MSIE|Trident/.test(ua)) family = 'ie';
  if (/Mobile|Android|iPhone|iPad/.test(ua)) family += '-mobile';
  return { family, automation };
}

/** Full enrichment for one event. */
export function enrichIp(ip: string) {
  const priv = isPrivateIp(ip);
  const a = priv ? { asn: null, asn_name: null, country: null } : lookupAsn(ip);
  return { ip_private: priv ? 1 : 0, asn: a.asn, asn_name: a.asn_name, country: a.country, is_hosting: isHostingAsn(a.asn) ? 1 : 0 } as const;
}
