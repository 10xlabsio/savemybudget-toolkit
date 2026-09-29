/** Builds the Hono app: public routes (collector, SDK, healthz) first; then the UI with security headers + CSRF. */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { config } from './config.js';
import { db, getCounter, getSetting, getSite, listSites, setSetting } from './db.js';
import { collectApp } from './collect/index.js';
import { api } from './api/index.js';
import { activeNotifications, retentionDays, silentThresholdHours, storeSizeMb, log } from './jobs/index.js';
import { loadAnalysis } from './rules/index.js';
import { checkWindow } from './claim/index.js';
import * as telemetry from './telemetry/index.js';
import {
  CSRF_COOKIE, CSRF_SECRET, DATA_ASSETS_DIR, DOCS_DIR, ROOT, TEMPLATES_DIR, bytes, daysAgo, multipartCapBytes, page, parseBufferedForm, publicUrl, readBodyCapped, today, tz, type AppEnv, type Ctx,
} from './ui.js';
import { SetupPage } from './pages/setup.js';
import { SiteFormPage, SitesPage, type SiteRow } from './pages/sites.js';
import { InstallPage, SDK_BUILD } from './pages/install.js';
import { OverviewPage, type OverviewProps, type Range } from './pages/overview.js';
import { UploadsPage, type UploadRow } from './pages/uploads.js';
import { AnalysePage, type AnalysisListRow, type PackageRow } from './pages/analyse.js';
import { SettingsPage } from './pages/settings.js';
import { AboutPage } from './pages/about.js';
import { DocsPage, DOC_PAGES } from './pages/docs.js';
import { markdownToHtml, markdownTitle } from './pages/markdown.js';
import type { AnalysisSummary, ScoredEvent, Site } from './types.js';

export const app = new Hono<AppEnv>();

// ---------- public: collector, SDK, healthz (no UI headers, no CSRF) ----------

const SDK_PATH = new URL('./sdk/smb.js', import.meta.url);
let sdkBytes: Buffer | null = null;
const sdk = () => (sdkBytes ??= readFileSync(SDK_PATH));

function sdkResponse(c: Ctx, cache: string) {
  return c.body(bytes(sdk()), 200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': cache,
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
  });
}
app.get('/sdk/v1/smb.js', (c) => sdkResponse(c, 'public, max-age=3600'));
app.get('/sdk/:build/smb.js', (c) => {
  if (c.req.param('build') !== SDK_BUILD.build) return c.text('Not found', 404);
  return sdkResponse(c, 'public, max-age=31536000, immutable');
});
app.get('/healthz', (c) => c.json({ ok: true, version: config.version }));
// The collector answers at /v1/beacon, /v1/sdk-error, /healthz — and the same under /collect (what the Caddyfile proxies).
app.mount('/collect', collectApp.fetch);
app.mount('/v1', collectApp.fetch, { replaceRequest: (r) => r });

// ---------- UI middleware ----------

const UI_EXEMPT_FROM_SETUP = (path: string) =>
  path === '/setup' || path.startsWith('/api/') || path.startsWith('/docs/') || path === '/about' || path === '/settings' || path.startsWith('/templates/') || path === '/sites/new' || path === '/api/sites';

app.use('*', async (c, next) => {
  const nonce = randomBytes(16).toString('base64');
  c.set('nonce', nonce);
  c.set('sites', listSites());

  // CSRF cookie: per-process secret; readable by JS (fetch header), SameSite=Strict.
  // Secure when the request itself is https, or when a trusted proxy in front terminated TLS.
  const viaHttps = c.req.url.startsWith('https:') || (config.trustProxy && (c.req.header('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase() === 'https');
  if (getCookie(c, CSRF_COOKIE) !== CSRF_SECRET) {
    setCookie(c, CSRF_COOKIE, CSRF_SECRET, { path: '/', sameSite: 'Strict', httpOnly: false, secure: viaHttps });
  }

  const method = c.req.method;
  if (method === 'POST' || method === 'DELETE' || method === 'PUT' || method === 'PATCH') {
    // Multipart bodies (uploads) are read here under a hard byte cap, before anything parses them.
    // Content-Length is not trusted: a chunked request has none, so the stream itself is counted.
    const ct = (c.req.header('content-type') ?? '').toLowerCase();
    if (ct.includes('multipart/form-data')) {
      const buf = await readBodyCapped(c.req.raw, multipartCapBytes());
      if (buf === null) return c.json({ error: `The file is larger than ${config.maxUploadMb} MB. Split it, or raise SMB_MAX_UPLOAD_MB.` }, 413);
      c.set('rawBody', buf);
    }
    const bad = await csrfProblem(c);
    if (bad) return c.text(bad, 403);
  }

  const path = c.req.path;
  if (method === 'GET' && c.get('sites').length === 0 && !UI_EXEMPT_FROM_SETUP(path)) {
    return c.redirect('/setup', 302);
  }

  await next();

  const h = c.res.headers;
  h.set('content-security-policy', `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  h.set('x-frame-options', 'DENY');
  if (!h.has('cache-control')) h.set('cache-control', 'no-store');
});

async function csrfProblem(c: Ctx): Promise<string | null> {
  const host = c.req.header('host');
  for (const hdr of ['origin', 'referer'] as const) {
    const v = c.req.header(hdr);
    if (!v || v === 'null') continue;
    let h: string;
    try { h = new URL(v).host; } catch { return `Bad ${hdr} header.`; }
    if (host && h !== host) return `Cross-site request rejected (${hdr} does not match this host).`;
  }
  const cookie = getCookie(c, CSRF_COOKIE);
  const header = c.req.header('x-csrf');
  let token = header;
  if (!token) {
    const ct = (c.req.header('content-type') ?? '').toLowerCase();
    const raw = c.get('rawBody');
    if (raw !== undefined && ct.includes('multipart/form-data')) {
      try { const t = (await parseBufferedForm(raw, c.req.header('content-type')!))['_csrf']; if (typeof t === 'string') token = t; } catch { /* unparsable */ }
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      try {
        const b = await c.req.parseBody();
        const t = b['_csrf'];
        if (typeof t === 'string') token = t;
      } catch { /* no body */ }
    }
  }
  if (!token || token !== CSRF_SECRET || cookie !== CSRF_SECRET) return 'Missing or stale form token. Reload the page and try again.';
  return null;
}

// ---------- templates & docs ----------

const TEMPLATE_FILES: Record<string, string> = { 'click-log-template.csv': 'text/csv; charset=utf-8', 'access-log-sample.log': 'text/plain; charset=utf-8' };
app.get('/templates/:file', (c) => {
  const f = c.req.param('file');
  const ct = TEMPLATE_FILES[f];
  const p = join(TEMPLATES_DIR, f);
  if (!ct || !existsSync(p)) return c.notFound();
  return c.body(bytes(readFileSync(p)), 200, { 'content-type': ct, 'content-disposition': `attachment; filename="${f}"` });
});

app.get('/docs', (c) => c.redirect('/docs/getting-started', 302));
app.get('/docs/:page', async (c) => {
  const slug = c.req.param('page').replace(/\.md$/i, '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) return c.notFound();
  const file = slug === 'telemetry' ? join(ROOT, 'TELEMETRY.md') : slug === 'security' ? join(ROOT, 'SECURITY.md') : join(DOCS_DIR, `${slug}.md`);
  if (!existsSync(file)) return c.notFound();
  const md = readFileSync(file, 'utf8');
  const title = markdownTitle(md) ?? DOC_PAGES.find((d) => d.slug === slug)?.title ?? slug;
  return page(c, DocsPage({ nonce: c.get('nonce'), sites: c.get('sites'), notifications: activeNotifications(null), slug, title, html: markdownToHtml(md) }));
});
app.get('/TELEMETRY.md', (c) => c.redirect('/docs/telemetry', 302));

// ---------- pages ----------

app.get('/', (c) => c.redirect('/sites', 302));

app.get('/setup', (c) => page(c, SetupPage({
  nonce: c.get('nonce'), csrf: CSRF_SECRET, sites: c.get('sites'),
  publicUrl: publicUrl(), tz: tz(), telemetryOn: telemetry.enabled(), telemetryEnv: config.telemetry, saved: c.req.query('saved') === '1',
})));

function siteOr404(c: Ctx): Site | null {
  const id = Number(c.req.param('id'));
  return Number.isInteger(id) && id > 0 ? getSite(id) : null;
}

/** Latest analysis for a site whose window covers [from, to]; failing that, the latest one that overlaps it. */
function coveringAnalysis(siteId: number, from: string, to: string): { id: number; summary: AnalysisSummary; scored: ScoredEvent[] } | null {
  const d = db();
  const full = d.prepare('SELECT id FROM analyses WHERE site_id = ? AND range_from <= ? AND range_to >= ? ORDER BY ran_at DESC LIMIT 1').get(siteId, from, to) as { id: number } | undefined;
  const r = full ?? (d.prepare('SELECT id FROM analyses WHERE site_id = ? AND range_from <= ? AND range_to >= ? ORDER BY ran_at DESC LIMIT 1').get(siteId, to, from) as { id: number } | undefined);
  if (!r) return null;
  return loadAnalysis(r.id);
}
function latestAnalysis(siteId: number): { id: number; summary: AnalysisSummary; scored: ScoredEvent[] } | null {
  const r = db().prepare('SELECT id FROM analyses WHERE site_id = ? ORDER BY ran_at DESC LIMIT 1').get(siteId) as { id: number } | undefined;
  return r ? loadAnalysis(r.id) : null;
}

app.get('/sites', (c) => {
  const sites = c.get('sites');
  const cutoff = new Date(Date.now() - 24 * 3600e3).toISOString();
  const b24 = db().prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND source = 'beacon' AND received_at >= ?");
  const rows: SiteRow[] = sites.map((site) => {
    const a = coveringAnalysis(site.id, daysAgo(6), today()) ?? latestAnalysis(site.id);
    let flagged7d: number | null = null;
    if (a) {
      const from = daysAgo(6);
      flagged7d = a.summary.per_day.filter((d) => d.day >= from).reduce((s, d) => s + d.flag, 0);
    }
    return { site, beacons24h: (b24.get(site.id, cutoff) as { n: number }).n, flagged7d };
  });
  return page(c, SitesPage({ nonce: c.get('nonce'), sites, rows, notifications: activeNotifications(null) }));
});

function formValuesFromQuery(c: Ctx, site?: Site | null) {
  const q = (k: string) => c.req.query(k);
  return {
    name: q('name') ?? site?.name ?? '',
    host: q('host') ?? site?.host ?? '',
    consent_mode: q('consent_mode') ?? site?.consent_mode ?? 'legitimate_interest',
    target_countries: q('target_countries') !== undefined ? (q('target_countries') ?? '').split(',').filter(Boolean) : site?.target_countries ?? [],
  };
}

app.get('/sites/new', (c) => page(c, SiteFormPage({ nonce: c.get('nonce'), csrf: CSRF_SECRET, sites: c.get('sites'), values: formValuesFromQuery(c), error: c.req.query('error') ?? null })));

app.get('/sites/:id/edit', (c) => {
  const site = siteOr404(c);
  if (!site) return c.notFound();
  return page(c, SiteFormPage({ nonce: c.get('nonce'), csrf: CSRF_SECRET, sites: c.get('sites'), site, values: formValuesFromQuery(c, site), error: c.req.query('error') ?? null }));
});

app.get('/sites/:id/install', (c) => {
  const site = siteOr404(c);
  if (!site) return c.notFound();
  const key = `snippet_generated:${site.id}`;
  if (!getSetting(key)) {
    setSetting(key, new Date().toISOString());
    telemetry.track('snippet_generated', { consent_mode: site.consent_mode });
  }
  return page(c, InstallPage({ nonce: c.get('nonce'), csrf: CSRF_SECRET, sites: c.get('sites'), site, publicUrl: publicUrl(), hasBeacon: !!site.first_event_at, firstEventAt: site.first_event_at }));
});

app.get('/sites/:id', (c) => {
  const site = siteOr404(c);
  if (!site) return c.notFound();
  const rq = c.req.query('range');
  const range: Range = rq === '24h' || rq === '30d' ? rq : '7d';
  const days = range === '24h' ? 1 : range === '7d' ? 7 : 30;
  const from = daysAgo(days - 1), to = today();
  const sinceIso = range === '24h' ? new Date(Date.now() - 24 * 3600e3).toISOString() : `${from}T00:00:00.000Z`;
  const d = db();
  const counts = d.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT gclid) AS g FROM events WHERE site_id = ? AND ts >= ? AND is_test = 0').get(site.id, sinceIso) as { n: number; g: number };
  const perDayRows = d.prepare("SELECT substr(ts,1,10) AS day, COUNT(*) AS total FROM events WHERE site_id = ? AND ts >= ? AND is_test = 0 GROUP BY day ORDER BY day").all(site.id, `${from}T00:00:00.000Z`) as { day: string; total: number }[];
  const a = coveringAnalysis(site.id, from, to);
  const flagByDay = new Map<string, number>();
  if (a) for (const p of a.summary.per_day) flagByDay.set(p.day, p.flag);
  const perDay: { day: string; total: number; flag: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = daysAgo(i);
    const r = perDayRows.find((x) => x.day === day);
    perDay.push({ day, total: r?.total ?? 0, flag: flagByDay.get(day) ?? 0 });
  }
  let analysis: OverviewProps['analysis'] = null;
  if (a) {
    // Flagged / watch for the SELECTED range: the analysis window may be wider than the range, so join its
    // verdicts to the events whose timestamp falls in the range rather than showing the whole-window totals.
    const inRange = d.prepare('SELECT v.verdict AS verdict, COUNT(*) AS n FROM verdicts v JOIN events e ON e.id = v.event_id WHERE v.analysis_id = ? AND e.ts >= ? AND e.is_test = 0 GROUP BY v.verdict')
      .all(a.id, sinceIso) as { verdict: string; n: number }[];
    const count = (v: string) => inRange.find((r) => r.verdict === v)?.n ?? 0;
    analysis = {
      id: a.id, summary: a.summary,
      flagged: a.scored.filter((s) => s.verdict === 'flag' && s.event.ts >= sinceIso).sort((x, y) => (x.event.ts < y.event.ts ? 1 : -1)),
      flaggedInRange: count('flag'), watch: count('watch'),
    };
  }
  return page(c, OverviewPage({ nonce: c.get('nonce'), sites: c.get('sites'), site, notifications: activeNotifications(site.id), range, clicks: counts.n, sessions: counts.g, analysis, perDay }));
});

app.get('/sites/:id/uploads', (c) => {
  const site = siteOr404(c);
  if (!site) return c.notFound();
  const uploads = db().prepare('SELECT id, filename, format, rows_imported, rows_total, range_from, range_to, created_at FROM uploads WHERE site_id = ? ORDER BY created_at DESC').all(site.id) as unknown as UploadRow[];
  const imported = c.req.query('imported');
  return page(c, UploadsPage({
    nonce: c.get('nonce'), csrf: CSRF_SECRET, sites: c.get('sites'), site, notifications: activeNotifications(site.id), uploads, maxUploadMb: config.maxUploadMb,
    flash: imported ? `Imported ${Number(imported).toLocaleString('en-GB')} rows. They join the beacons in the next analysis.` : null,
  }));
});

app.get('/sites/:id/analyse', (c) => {
  const site = siteOr404(c);
  if (!site) return c.notFound();
  const d = db();
  const aid = Number(c.req.query('analysis'));
  let analysis: { id: number; summary: AnalysisSummary } | null = null;
  if (Number.isInteger(aid) && aid > 0) {
    const a = loadAnalysis(aid);
    if (a && a.site_id === site.id) analysis = { id: a.id, summary: a.summary };
  } else {
    const r = d.prepare('SELECT id, summary FROM analyses WHERE site_id = ? ORDER BY ran_at DESC LIMIT 1').get(site.id) as { id: number; summary: string } | undefined;
    if (r) analysis = { id: r.id, summary: JSON.parse(r.summary) };
  }
  const from = c.req.query('from') ?? analysis?.summary.range_from ?? daysAgo(29);
  const to = c.req.query('to') ?? analysis?.summary.range_to ?? today();
  const w = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) ? checkWindow(from, to) : { ok: false, message: 'Dates must be YYYY-MM-DD.' };
  const analyses = (d.prepare('SELECT id, range_from, range_to, ran_at, summary FROM analyses WHERE site_id = ? ORDER BY ran_at DESC LIMIT 20').all(site.id) as { id: number; range_from: string; range_to: string; ran_at: string; summary: string }[])
    .map((r) => { const s = JSON.parse(r.summary) as AnalysisSummary; return { id: r.id, range_from: r.range_from, range_to: r.range_to, ran_at: r.ran_at, flag: s.counts.flag, total: s.counts.total } as AnalysisListRow; });
  const packages = d.prepare('SELECT p.id, p.rows, p.created_at, p.analysis_id, a.range_from, a.range_to FROM packages p JOIN analyses a ON a.id = p.analysis_id WHERE a.site_id = ? ORDER BY p.created_at DESC').all(site.id) as unknown as PackageRow[];
  const pk = Number(c.req.query('package'));
  return page(c, AnalysePage({
    nonce: c.get('nonce'), csrf: CSRF_SECRET, sites: c.get('sites'), site, notifications: activeNotifications(site.id),
    from, to, today: today(), windowMsg: w.ok && !w.warning ? null : { message: w.ok ? undefined : w.message, warning: w.warning },
    error: c.req.query('error') ?? null, analysis, analyses, packages, justBuilt: Number.isInteger(pk) && pk > 0 ? pk : null,
  }));
});

app.get('/settings', (c) => page(c, SettingsPage({
  nonce: c.get('nonce'), csrf: CSRF_SECRET, sites: c.get('sites'), notifications: activeNotifications(null),
  publicUrl: publicUrl(), tz: tz(), retentionDays: retentionDays(), storeMb: storeSizeMb(), silentHours: silentThresholdHours(),
  telemetryOn: telemetry.enabled(), telemetryEnv: config.telemetry, updateCheckOn: config.updateCheck && getSetting('update_check') !== 'off', updateCheckEnv: config.updateCheck,
  bind: `${config.bind}:${config.port}`,
  counters: [
    { key: 'collect_unknown_key', value: getCounter('collect_unknown_key'), what: 'Beacons that named a site key this instance does not have — usually an old snippet or a copy-paste slip.' },
    { key: 'collect_invalid', value: getCounter('collect_invalid'), what: 'Beacons that did not match the payload shape and were dropped.' },
    { key: 'collect_bad_origin', value: getCounter('collect_bad_origin'), what: 'Beacons whose browser Origin was not the site\'s host (or a subdomain of it) and were dropped. A few can come from a staging copy of the site or a proxy that rewrites the host; a steady stream means someone is posting beacons from another site. Same-origin beacons that carry no Origin header are accepted.' },
    { key: 'collect_ratelimited', value: getCounter('collect_ratelimited'), what: 'Beacons dropped because one address sent more than 120 in a minute.' },
    { key: 'sdk_errors', value: getCounter('sdk_errors'), what: 'Times the SDK reported an internal error from a visitor\'s browser.' },
  ],
  saved: c.req.query('saved') === '1',
  error: c.req.query('error') === 'url' ? 'The public URL was not saved: it must start with http:// or https:// and name a host, for example https://t.yourbrand.com.' : null,
})));

app.get('/about', (c) => {
  let asnSnapshot: string | null = null;
  try { asnSnapshot = readFileSync(join(DATA_ASSETS_DIR, 'ip2asn-v4.DATE'), 'utf8').trim(); } catch { /* absent */ }
  return page(c, AboutPage({ nonce: c.get('nonce'), sites: c.get('sites'), notifications: activeNotifications(null), asnSnapshot }));
});

app.route('/api', api);

app.notFound((c) => c.text('Not found', 404));
app.onError((err, c) => {
  log('request failed', err);
  return c.text('Something went wrong on the server. The log has the details.', 500);
});
