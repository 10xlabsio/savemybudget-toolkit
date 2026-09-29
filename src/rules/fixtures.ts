/**
 * Deterministic synthetic click window for tests and demos.
 * `tsx src/rules/fixtures.ts` inserts one into a site named 'Fixture site' in the real DB.
 */
import type { NewEvent } from '../db.js';
import type { Source } from '../types.js';

export interface FixtureOpts { days?: number; seed?: number; from?: string }

export interface FixtureCases {
  from: string;
  to: string;
  clean: { gclids: string[]; ips: string[] };
  hosting: { gclids: string[]; ips: string[] };        // (a) r1
  automation: { gclids: string[]; ips: string[] };     // (b) r6
  noBeacon: { gclids: string[]; ips: string[] };       // (c) r9
  matchedLogs: { gclids: string[] };                   // clean log lines that match a beacon
  replay: { gclid: string; ips: string[] };            // (d) r13
  velocity: { ip: string; gclids: string[] };          // (e) r14 + r10
  fpCollision: { fp_hash: string; ips: string[]; gclids: string[] }; // (f) r8
  subnet: { subnet: string; ips: string[]; gclids: string[] };       // (g) r4
  cgnat: { ip: string; gclids: string[] };             // (h) must not flag
  geo: { gclids: string[]; ips: string[] };            // r3 (only when site targets GB)
}

// ---------- seeded PRNG (mulberry32) ----------
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GCLID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const RESIDENTIAL = [
  { asn: 5089, name: 'Virgin Media' },
  { asn: 2856, name: 'BT' },
  { asn: 12576, name: 'EE' },
  { asn: 13285, name: 'TalkTalk' },
  { asn: 5607, name: 'Sky' },
];
const UAS: Record<string, string> = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'chrome-mobile': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'safari-mobile': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  'samsung-mobile': 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
};
const UA_FAMILIES = Object.keys(UAS);
const CAMPAIGNS = ['Brand - Exact', 'Generic - Shoes', 'Competitor', null];

function build(siteId: number, opts: FixtureOpts = {}): { events: NewEvent[]; cases: FixtureCases } {
  const days = opts.days ?? 3;
  const rnd = prng(opts.seed ?? 42);
  const fromDay = opts.from ?? new Date(Date.now() - 10 * 86400e3).toISOString().slice(0, 10);
  const start = Date.parse(`${fromDay}T00:00:00.000Z`);
  const toDay = new Date(start + (days - 1) * 86400e3).toISOString().slice(0, 10);
  const span = days * 86400e3;

  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const gclid = () => { let s = ''; for (let i = 0; i < 60; i++) s += GCLID_CHARS[Math.floor(rnd() * GCLID_CHARS.length)]; return s; };
  const hex = (n: number) => { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(rnd() * 16)]; return s; };
  const iso = (t: number) => new Date(Math.round(t)).toISOString();
  const usedIps = new Set<string>();
  /** Random public-looking IP, unique across the fixture so clean traffic never clusters. */
  const freshIp = () => {
    for (;;) {
      const a = pick([81, 86, 92, 176, 188, 31, 46, 82, 90, 109]);
      const ip = `${a}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`;
      if (!usedIps.has(ip)) { usedIps.add(ip); return ip; }
    }
  };

  const events: NewEvent[] = [];
  const base = (over: Partial<NewEvent> & { ts: string; ip: string; gclid: string; source: Source }): NewEvent => {
    const fam = over.ua_family ?? pick(UA_FAMILIES);
    const isp = pick(RESIDENTIAL);
    return {
      site_id: siteId,
      upload_id: null,
      received_at: over.ts,
      ip_private: 0,
      asn: isp.asn,
      asn_name: isp.name,
      is_hosting: 0,
      country: 'GB',
      ua: UAS[fam] ?? UAS.chrome,
      ua_family: fam,
      is_test: 0,
      session_id: `s_${hex(16)}`,
      fp_hash: hex(32),
      dwell_ms: null,
      visible: null,
      interactions: null,
      automation: null,
      url: '/landing',
      referer: 'https://www.google.com/',
      campaign: pick(CAMPAIGNS),
      ...over,
    };
  };
  const beaconVisit = (over: Partial<NewEvent> & { ts: string; ip: string; gclid: string }): NewEvent =>
    base({ source: 'beacon', dwell_ms: int(5_000, 120_000), interactions: int(3, 40), visible: 1, ...over });

  const cases: FixtureCases = {
    from: fromDay, to: toDay,
    clean: { gclids: [], ips: [] }, hosting: { gclids: [], ips: [] }, automation: { gclids: [], ips: [] },
    noBeacon: { gclids: [], ips: [] }, matchedLogs: { gclids: [] }, replay: { gclid: '', ips: [] },
    velocity: { ip: '', gclids: [] }, fpCollision: { fp_hash: '', ips: [], gclids: [] },
    subnet: { subnet: '', ips: [], gclids: [] }, cgnat: { ip: '', gclids: [] }, geo: { gclids: [], ips: [] },
  };

  // ---- clean visits: ~60/day, 70% also produce a matching server-log line ----
  for (let i = 0; i < 60 * days; i++) {
    const ts = start + rnd() * span;
    const ip = freshIp();
    const g = gclid();
    const e = beaconVisit({ ts: iso(ts), ip, gclid: g });
    events.push(e);
    cases.clean.gclids.push(g); cases.clean.ips.push(ip);
    if (rnd() < 0.7) {
      events.push(base({ source: 'log', ts: iso(ts - int(0, 4 * 60_000)), ip, gclid: g, ua_family: e.ua_family!, session_id: null, fp_hash: null, campaign: e.campaign }));
      cases.matchedLogs.gclids.push(g);
    }
  }

  // (a) 40 hosting clicks from AWS
  for (let i = 0; i < 40; i++) {
    const ip = freshIp(); const g = gclid();
    events.push(beaconVisit({ ts: iso(start + rnd() * span), ip, gclid: g, asn: 16509, asn_name: 'AMAZON-02', is_hosting: 1 }));
    cases.hosting.gclids.push(g); cases.hosting.ips.push(ip);
  }
  // (b) 12 automation-marked beacons
  for (let i = 0; i < 12; i++) {
    const ip = freshIp(); const g = gclid();
    events.push(beaconVisit({ ts: iso(start + rnd() * span), ip, gclid: g, automation: ['webdriver'] }));
    cases.automation.gclids.push(g); cases.automation.ips.push(ip);
  }
  // (c) 8 log lines with no beacon
  for (let i = 0; i < 8; i++) {
    const ip = freshIp(); const g = gclid();
    events.push(base({ source: 'log', ts: iso(start + rnd() * span), ip, gclid: g, session_id: null, fp_hash: null }));
    cases.noBeacon.gclids.push(g); cases.noBeacon.ips.push(ip);
  }
  // (d) one gclid replayed 6 times over 3 days
  {
    const g = gclid(); cases.replay.gclid = g;
    for (let i = 0; i < 6; i++) {
      const ip = freshIp();
      events.push(beaconVisit({ ts: iso(start + (i * span) / 6 + 3_600e3), ip, gclid: g }));
      cases.replay.ips.push(ip);
    }
  }
  // (e) one IP, 8 clicks in 10 minutes, single browser, zero dwell
  {
    const ip = freshIp(); cases.velocity.ip = ip;
    const t0 = start + 86400e3 + 10 * 3_600e3;
    for (let i = 0; i < 8; i++) {
      const g = gclid();
      events.push(beaconVisit({ ts: iso(t0 + i * 75_000), ip, gclid: g, ua_family: 'chrome', dwell_ms: int(200, 1_500), interactions: 0, visible: 1 }));
      cases.velocity.gclids.push(g);
    }
  }
  // (f) one fingerprint from 7 IPs in an hour
  {
    const fp = hex(32); cases.fpCollision.fp_hash = fp;
    const t0 = start + 14 * 3_600e3;
    for (let i = 0; i < 7; i++) {
      const ip = `192.0.2.${int(1, 254)}`;
      if (usedIps.has(ip)) { i--; continue; }
      usedIps.add(ip);
      const g = gclid();
      events.push(beaconVisit({ ts: iso(t0 + i * 8 * 60_000), ip, gclid: g, fp_hash: fp }));
      cases.fpCollision.ips.push(ip); cases.fpCollision.gclids.push(g);
    }
  }
  // (g) a /24 with 9 IPs in 5 minutes
  {
    cases.subnet.subnet = '198.51.100.0/24';
    const t0 = start + (days - 1) * 86400e3 + 9 * 3_600e3;
    const fam = pick(UA_FAMILIES);
    for (let i = 0; i < 9; i++) {
      const ip = `198.51.100.${10 + i * 7}`; usedIps.add(ip);
      const g = gclid();
      events.push(beaconVisit({ ts: iso(t0 + i * 30_000), ip, gclid: g, ua_family: fam }));
      cases.subnet.ips.push(ip); cases.subnet.gclids.push(g);
    }
  }
  // (h) CGNAT: one IP, 6 browser families, 5 clicks spread over 20 hours — real people behind a carrier NAT
  {
    const ip = '203.0.113.77'; usedIps.add(ip); cases.cgnat.ip = ip;
    const fams = ['chrome', 'safari-mobile', 'firefox', 'edge', 'chrome-mobile', 'samsung-mobile'];
    const t0 = start + 2 * 3_600e3;
    for (let i = 0; i < 5; i++) {
      const g = gclid();
      events.push(beaconVisit({ ts: iso(t0 + i * 4 * 3_600e3), ip, gclid: g, ua_family: fams[i], asn: 12576, asn_name: 'EE' }));
      cases.cgnat.gclids.push(g);
    }
    // sixth family shows up as a matching log line from the same NAT exit
    const g = gclid();
    events.push(base({ source: 'log', ts: iso(t0 + 22 * 3_600e3), ip, gclid: g, ua_family: fams[5], session_id: null, fp_hash: null }));
    events.push(beaconVisit({ ts: iso(t0 + 22 * 3_600e3 + 2_000), ip, gclid: g, ua_family: fams[5] }));
    cases.cgnat.gclids.push(g);
  }
  // r3: 6 clicks geolocated outside GB (only fires when the site targets GB)
  for (let i = 0; i < 6; i++) {
    const ip = freshIp(); const g = gclid();
    events.push(beaconVisit({ ts: iso(start + rnd() * span), ip, gclid: g, country: pick(['RU', 'VN', 'BR']), asn: 8359, asn_name: 'MTS PJSC' }));
    cases.geo.gclids.push(g); cases.geo.ips.push(ip);
  }

  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { events, cases };
}

export function generateFixture(siteId: number, opts?: FixtureOpts): NewEvent[] {
  return build(siteId, opts).events;
}

export function fixtureExpectations(opts?: FixtureOpts): FixtureCases {
  return build(0, opts).cases;
}

// ---------- script entry ----------
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
  || (process.argv[1] ?? '').endsWith('src/rules/fixtures.ts');
if (isMain) {
  const { db, insertEvents, listSites, createSite } = await import('../db.js');
  db();
  const { randomBytes } = await import('node:crypto');
  let site = listSites().find((s) => s.name === 'Fixture site');
  if (!site) {
    site = createSite({ name: 'Fixture site', host: 'fixture.example', key: randomBytes(16).toString('hex'), consent_mode: 'legitimate_interest', target_countries: ['GB'] });
    console.log(`Created site #${site.id} 'Fixture site' (key ${site.key})`);
  }
  const { events, cases } = build(site.id);
  insertEvents(events);
  console.log(`Inserted ${events.length} events into site #${site.id} for ${cases.from}..${cases.to}`);
}
