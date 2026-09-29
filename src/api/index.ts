/** JSON / form API. Mutations carry CSRF (checked in app.ts middleware). Forms use PRG. */
import { randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, join } from 'node:path';
import { Hono } from 'hono';
import { config } from '../config.js';
import { createSite, db, deleteSite, deleteSiteData, getSite, listSites, setSetting, siteStatus, updateSite } from '../db.js';
import { analyzeUpload, importUpload } from '../ingest/index.js';
import { checkWindow, buildPackage } from '../claim/index.js';
import { writeZip, type ZipEntry } from '../claim/zip.js';
import { runAnalysis, saveAnalysis, loadAnalysis } from '../rules/index.js';
import { dismissNotification, retentionDays, clearNotifications, log } from '../jobs/index.js';
import * as telemetry from '../telemetry/index.js';
import { COUNTRY_CODES, bytes, makeSiteKey, parseBufferedForm, validateHost, type AppEnv } from '../ui.js';

export const api = new Hono<AppEnv>();

const str = (v: unknown, max = 4096): string => (typeof v === 'string' ? v.slice(0, max) : '');
const jsonError = (c: { json: (o: unknown, s?: number) => Response }, message: string, status = 400) => c.json({ error: message }, status as 400);

function siteId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

type FormCtx = { req: { header(n: string): string | undefined; parseBody(o: { all: true }): Promise<Record<string, unknown>>; json(): Promise<unknown> }; get(k: 'rawBody'): Buffer | undefined };

/**
 * Body as a record. `all: true` keeps every value of a repeated field (a <select multiple> posts one
 * `target_countries` per selected option) as an array; a field sent once stays a string.
 * Multipart bodies were already read under the size cap by the UI middleware (rawBody), so parse that buffer.
 */
async function form(c: FormCtx): Promise<Record<string, unknown>> {
  const ct = (c.req.header('content-type') ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    try { const j = await c.req.json(); return j && typeof j === 'object' ? (j as Record<string, unknown>) : {}; } catch { return {}; }
  }
  const raw = c.get('rawBody');
  if (raw !== undefined && ct.includes('multipart/form-data')) {
    try { return await parseBufferedForm(raw, c.req.header('content-type')!); } catch { return {}; }
  }
  try { return await c.req.parseBody({ all: true }); } catch { return {}; }
}

/** Country codes from a form: string | string[] (repeated field), each possibly comma-separated. Upper-case ISO-3166 alpha-2 only. */
export function parseCountries(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const codes = list.flatMap((x) => String(x).split(',')).map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x) && COUNTRY_CODES.has(x));
  return [...new Set(codes)];
}

function siteFormValues(b: Record<string, unknown>) {
  const target_countries = parseCountries(b['target_countries']);
  return {
    name: str(b['name'], 60).trim(),
    host: str(b['host'], 253).trim(),
    consent_mode: str(b['consent_mode']) === 'consent_gated' ? 'consent_gated' : 'legitimate_interest',
    target_countries,
  };
}

// ---------- sites ----------

api.post('/sites', async (c) => {
  const b = await form(c);
  const v = siteFormValues(b);
  const err = validateSiteValues(v);
  if (err) return c.redirect(`/sites/new?${new URLSearchParams({ error: err, name: v.name, host: v.host, consent_mode: v.consent_mode, target_countries: v.target_countries.join(',') })}`, 303);
  const host = (validateHost(v.host) as { host: string }).host;
  const site = createSite({ name: v.name || host, host, key: makeSiteKey(host), consent_mode: v.consent_mode, target_countries: v.target_countries });
  return c.redirect(`/sites/${site.id}/install`, 303);
});

api.post('/sites/:id', async (c) => {
  const id = siteId(c.req.param('id'));
  const site = id ? getSite(id) : null;
  if (!site) return c.notFound();
  const b = await form(c);
  const v = siteFormValues(b);
  const err = validateSiteValues(v);
  if (err) return c.redirect(`/sites/${site.id}/edit?${new URLSearchParams({ error: err, name: v.name, host: v.host, consent_mode: v.consent_mode, target_countries: v.target_countries.join(',') })}`, 303);
  const host = (validateHost(v.host) as { host: string }).host;
  updateSite(site.id, { name: v.name || host, host, consent_mode: v.consent_mode, target_countries: v.target_countries });
  return c.redirect(`/sites/${site.id}`, 303);
});

function validateSiteValues(v: ReturnType<typeof siteFormValues>): string | null {
  const h = validateHost(v.host);
  if ('error' in h) return h.error;
  if (!v.name) return 'Give the site a name.';
  return null;
}

api.post('/sites/:id/delete-data', (c) => {
  const id = siteId(c.req.param('id'));
  if (!id || !getSite(id)) return c.notFound();
  deleteSiteData(id);
  for (const k of ['first_beacon', 'tag_silent', 'private_ips', 'window_reminder'] as const) clearNotifications(id, k);
  return c.redirect('/settings?saved=1', 303);
});

api.post('/sites/:id/delete', (c) => {
  const id = siteId(c.req.param('id'));
  if (!id || !getSite(id)) return c.notFound();
  deleteSite(id);
  return c.redirect('/sites', 303);
});

api.get('/sites/:id/status', (c) => {
  const id = siteId(c.req.param('id'));
  if (!id || !getSite(id)) return c.notFound();
  return c.json(siteStatus(id));
});

// ---------- setup ----------

/** True for addresses the setup check must not probe: loopback, RFC 1918, link-local, CGNAT, 0/8, multicast, ULA, and their v4-mapped forms. */
export function isInternalAddress(addr: string): boolean {
  let a = addr.toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%'); if (zone !== -1) a = a.slice(0, zone);
  if (a.startsWith('::ffff:')) {
    const v4 = a.slice(7);
    if (isIP(v4) === 4) return isInternalAddress(v4);
    const hex = v4.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/); // URL parsing writes ::ffff:10.0.0.1 as ::ffff:a00:1
    if (hex) { const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16); return isInternalAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
  }
  if (isIP(a) === 4) {
    const [o0, o1] = a.split('.').map(Number);
    return o0 === 0 || o0 === 10 || o0 === 127 || (o0 === 169 && o1 === 254) || (o0 === 172 && o1 >= 16 && o1 <= 31) || (o0 === 192 && o1 === 168) || (o0 === 100 && o1 >= 64 && o1 <= 127) || o0 >= 224;
  }
  if (isIP(a) === 6) {
    if (a === '::1' || a === '::') return true;
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true; // not an address at all
}

/** host:port of SMB_PUBLIC_URL (environment, not the UI setting — the operator's own address is allowed to be private, e.g. a dev instance on 127.0.0.1). */
function envPublicHostPort(): string | null {
  try { return config.publicUrl ? new URL(config.publicUrl).host.toLowerCase() : null; } catch { return null; }
}

/**
 * POST (CSRF-protected) so a link cannot make this server probe things. The target host is resolved first and
 * refused when ANY of its addresses is internal, so the check cannot be pointed at the cloud metadata service or
 * another container. The response never echoes the upstream status or body: only whether the toolkit answered.
 * The operator's own SMB_PUBLIC_URL (host and port) is exempt so a dev setup on 127.0.0.1 still checks.
 */
api.post('/setup/check', async (c) => {
  const b = await form(c);
  const raw = str(b['url'], 2048).trim().replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(raw); } catch { return c.json({ ok: false, url: raw, reason: 'That is not a full URL. It should look like https://t.yourbrand.com.' }); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return c.json({ ok: false, url: raw, reason: 'The URL must start with https://.' });
  if (u.username || u.password) return c.json({ ok: false, url: raw, reason: 'The URL must not carry credentials.' });
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const target = `${u.origin}${u.pathname.replace(/\/+$/, '')}/collect/healthz`;
  const unreachable = { ok: false, url: target, reason: `${target} could not be reached from this server. Check the DNS record and the proxy.` };
  if (u.host.toLowerCase() !== envPublicHostPort()) {
    let addrs: string[];
    if (isIP(host)) addrs = [host];
    else {
      try { addrs = (await dns.lookup(host, { all: true })).map((r) => r.address); } catch { return c.json(unreachable); }
    }
    if (!addrs.length || addrs.some(isInternalAddress)) {
      return c.json({ ok: false, url: target, reason: `${host} points at a private or local address. The public URL must be the address your visitors reach from the internet.` });
    }
  }
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(6000), redirect: 'manual' });
    const j = res.ok ? ((await res.json().catch(() => null)) as { ok?: boolean; version?: string } | null) : null;
    if (!j?.ok) return c.json({ ok: false, url: target, reason: `${target} answered, but not with the toolkit's health response. The proxy must pass /collect to the toolkit and nothing else may sit on that address.`, kind: 'not_toolkit' });
    const warning = u.protocol !== 'https:' ? 'Reachable over http. Browsers will not post beacons from an https page to it — put TLS in front before installing the tag.' : undefined;
    return c.json({ ok: true, url: target, version: j.version ?? null, ...(warning ? { warning } : {}) });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return c.json({ ok: false, url: target, reason: `${target} did not answer within 6 seconds. Check DNS and that the proxy is up.`, kind: 'unreachable' });
    return c.json({ ...unreachable, kind: 'unreachable' });
  }
});

// ---------- settings ----------

api.post('/settings', async (c) => {
  const b = await form(c);
  if ('public_url' in b) {
    const u = str(b['public_url']).trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\/[^\s/]+/.test(u)) return c.redirect('/settings?error=url', 303);
    setSetting('public_url', u);
  }
  if ('tz' in b) {
    const z = str(b['tz'], 64);
    try { new Intl.DateTimeFormat('en-GB', { timeZone: z }); setSetting('tz', z); } catch { /* ignore invalid */ }
  }
  if ('retention_days' in b) {
    const d = Math.round(Number(b['retention_days']));
    if (Number.isFinite(d)) setSetting('retention_days', String(Math.min(3650, Math.max(60, d))));
  }
  if ('silent_threshold_hours' in b) {
    const h = Number(b['silent_threshold_hours']);
    if ([12, 24, 48, 72, 168].includes(h)) setSetting('silent_threshold_hours', String(h));
  }
  if (config.telemetry && b['telemetry_present'] === '1') setSetting('telemetry', b['telemetry'] === 'on' ? 'on' : 'off');
  if (config.updateCheck && b['update_check_present'] === '1') setSetting('update_check', b['update_check'] === 'on' ? 'on' : 'off');
  return c.redirect(safeNext(str(b['_next'], 200)) ?? '/settings?saved=1', 303);
});

/** A local path only: one leading slash, then a conservative character set. `//host` and `/\host` (which browsers read as scheme-relative) are refused. */
export function safeNext(next: string): string | null {
  if (!/^\/[A-Za-z0-9_\-/?=&.%]*$/.test(next)) return null;
  if (next.startsWith('//') || next.startsWith('/\\')) return null;
  return next;
}

// ---------- uploads ----------

const uploadsDir = () => { const d = join(config.dataDir, 'uploads'); mkdirSync(d, { recursive: true }); return d; };
const TOKEN_RE = /^[a-f0-9]{24}\.bin$/;

interface StagedMeta { filename: string; site_id: number; mapping: Record<string, string> | null; at: number }

function readStaged(token: string): { buf: Buffer; filename: string; site_id: number; mapping: Record<string, string> | null } | null {
  if (!TOKEN_RE.test(token)) return null;
  const p = join(uploadsDir(), token);
  const metaP = p + '.json';
  if (!existsSync(p) || !existsSync(metaP)) return null;
  const meta = JSON.parse(readFileSync(metaP, 'utf8')) as StagedMeta;
  return { buf: readFileSync(p), filename: meta.filename, site_id: meta.site_id, mapping: meta.mapping ?? null };
}
function dropStaged(token: string) {
  if (!TOKEN_RE.test(token)) return;
  for (const p of [join(uploadsDir(), token), join(uploadsDir(), token + '.json')]) { try { unlinkSync(p); } catch { /* gone */ } }
}

const CANON_FIELDS = ['timestamp', 'ip', 'gclid', 'user_agent', 'url', 'referer', 'campaign'];

/**
 * Column mapping from a body: either `mapping` as a JSON string / object, or one `mapping[<canonical>]` field per
 * column (what a plain HTML form posts). Values are header names from the file; empty ones are dropped.
 */
function mappingFrom(b: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const m = b['mapping'];
  let obj: unknown = m;
  if (typeof m === 'string' && m) { try { obj = JSON.parse(m); } catch { obj = undefined; } }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (CANON_FIELDS.includes(k) && typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 256);
  }
  for (const k of CANON_FIELDS) {
    const v = b[`mapping[${k}]`];
    const s = Array.isArray(v) ? v[v.length - 1] : v;
    if (typeof s === 'string' && s.trim()) out[k] = s.trim().slice(0, 256);
  }
  return Object.keys(out).length ? out : undefined;
}

api.post('/sites/:id/uploads', async (c) => {
  const id = siteId(c.req.param('id'));
  const site = id ? getSite(id) : null;
  if (!site) return jsonError(c, 'Site not found.', 404);
  const cap = config.maxUploadMb * 1048576;
  const b = await form(c);
  const f = b['file'];
  const prev = str(b['token'], 64);
  const mapping = mappingFrom(b);
  let buf: Buffer;
  let filename: string;
  if (f instanceof File && f.size > 0) {
    if (f.size > cap) return jsonError(c, `The file is larger than ${config.maxUploadMb} MB. Split it, or raise SMB_MAX_UPLOAD_MB.`, 413);
    buf = Buffer.from(await f.arrayBuffer());
    filename = basename(f.name || 'upload').slice(0, 255);
  } else {
    // Re-check with a new column mapping: reuse the staged file rather than asking for it again.
    const staged = prev ? readStaged(prev) : null;
    if (!staged || staged.site_id !== site.id) return jsonError(c, 'Choose a file first.');
    buf = staged.buf; filename = staged.filename;
  }
  if (prev) dropStaged(prev);
  const preview = analyzeUpload(buf, filename, { retentionDays: retentionDays(), mapping });
  // Nothing to stage when the file could not even be read as a CSV or log: no import and no re-mapping can follow.
  if (preview.format === null) return c.json({ token: null, preview });
  const token = randomBytes(12).toString('hex') + '.bin';
  writeFileSync(join(uploadsDir(), token), buf);
  writeFileSync(join(uploadsDir(), token + '.json'), JSON.stringify({ filename, site_id: site.id, mapping: mapping ?? null, at: Date.now() } satisfies StagedMeta));
  return c.json({ token, preview });
});

api.post('/sites/:id/uploads/:token/import', async (c) => {
  const id = siteId(c.req.param('id'));
  const site = id ? getSite(id) : null;
  if (!site) return jsonError(c, 'Site not found.', 404);
  const token = c.req.param('token');
  const staged = readStaged(token);
  if (!staged || staged.site_id !== site.id) return jsonError(c, 'That upload is no longer staged. Check the file again.', 410);
  const b = await form(c);
  const mapping = mappingFrom(b) ?? staged.mapping ?? undefined;
  try {
    const r = importUpload(site.id, staged.buf, staged.filename, { retentionDays: retentionDays(), mapping });
    dropStaged(token);
    return c.json({ upload_id: r.upload_id, imported: r.imported });
  } catch (e) {
    const err = e as Error & { preview?: unknown };
    return c.json({ error: err.message, preview: err.preview ?? null }, 400);
  }
});

function deleteUpload(id: number): boolean {
  const r = db().prepare('DELETE FROM uploads WHERE id = ?').run(id);
  return Number(r.changes) > 0;
}
api.delete('/uploads/:id', (c) => {
  const id = siteId(c.req.param('id'));
  if (!id || !deleteUpload(id)) return c.notFound();
  return c.json({ ok: true });
});
api.post('/uploads/:id/delete', (c) => {
  const id = siteId(c.req.param('id'));
  const row = id ? (db().prepare('SELECT site_id FROM uploads WHERE id = ?').get(id) as { site_id: number } | undefined) : undefined;
  if (!id || !row) return c.notFound();
  deleteUpload(id);
  return c.redirect(`/sites/${row.site_id}/uploads`, 303);
});

// ---------- analyses ----------

api.post('/sites/:id/analyses', async (c) => {
  const id = siteId(c.req.param('id'));
  const site = id ? getSite(id) : null;
  if (!site) return c.notFound();
  const b = await form(c);
  const from = str(b['from'], 10), to = str(b['to'], 10);
  const back = (err: string) => c.redirect(`/sites/${site.id}/analyse?${new URLSearchParams({ from, to, error: err })}`, 303);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return back('Dates must be YYYY-MM-DD.');
  const w = checkWindow(from, to);
  if (!w.ok) return back(w.message ?? 'That window cannot be analysed.');
  const result = runAnalysis(site, from, to);
  const analysisId = saveAnalysis(site, result);
  const s = result.summary;
  const windowDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400e3) + 1;
  telemetry.track('analysis_run', {
    rules: s.rules,
    flagged_share: telemetry.shareBucket(s.counts.total ? s.counts.flag / s.counts.total : 0),
    window_days: windowDays,
    sources_beacon: s.counts.sources.beacon > 0,
    sources_log: s.counts.sources.log > 0,
    sources_csv: s.counts.sources.csv > 0,
  });
  return c.redirect(`/sites/${site.id}/analyse?analysis=${analysisId}`, 303);
});

api.post('/analyses/:id/package', async (c) => {
  const id = siteId(c.req.param('id'));
  const a = id ? loadAnalysis(id) : null;
  if (!a) return c.notFound();
  const b = await form(c);
  const includeWatch = b['include_watch'] === '1' || b['include_watch'] === true;
  const exclusions = b['exclusions'] === '1' || b['exclusions'] === true;
  const r = buildPackage(a.id, { includeWatch, exclusions });
  telemetry.track('claim_package', { flagged_rows: telemetry.bucket(r.rows), exclusions });
  return c.redirect(`/sites/${a.site_id}/analyse?analysis=${a.id}&package=${r.package_id}`, 303);
});

interface PackageRowDb { id: number; analysis_id: number; path: string; rows: number; created_at: string }
const getPackage = (id: number) => db().prepare('SELECT * FROM packages WHERE id = ?').get(id) as PackageRowDb | undefined;

api.get('/packages/:id/download', (c) => {
  const id = siteId(c.req.param('id'));
  const p = id ? getPackage(id) : undefined;
  if (!p || !existsSync(p.path)) return c.notFound();
  const body = readFileSync(p.path);
  return c.body(bytes(body), 200, {
    'content-type': 'application/zip',
    'content-length': String(body.length),
    'content-disposition': `attachment; filename="${basename(p.path)}"`,
    'cache-control': 'no-store',
  });
});

api.post('/packages/:id/delete', (c) => {
  const id = siteId(c.req.param('id'));
  const p = id ? getPackage(id) : undefined;
  if (!p) return c.notFound();
  const a = loadAnalysis(p.analysis_id);
  db().prepare('DELETE FROM packages WHERE id = ?').run(p.id);
  // Only this package's own file. Packages built before 1.0.1 shared one path per analysis; leave a file another row still points at.
  const shared = db().prepare('SELECT COUNT(*) AS n FROM packages WHERE path = ?').get(p.path) as { n: number };
  if (shared.n === 0) { try { unlinkSync(p.path); } catch { /* already gone */ } }
  return c.redirect(a ? `/sites/${a.site_id}/analyse?analysis=${a.id}` : '/sites', 303);
});

// ---------- notifications ----------

api.post('/notifications/:id/dismiss', (c) => {
  const id = siteId(c.req.param('id'));
  if (!id) return c.notFound();
  dismissNotification(id);
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('text/html') && !accept.includes('application/json')) {
    let back = '/sites';
    try { const r = c.req.header('referer'); if (r) back = new URL(r).pathname; } catch { /* keep default */ }
    return c.redirect(back, 303);
  }
  return c.json({ ok: true });
});

// ---------- export ----------

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

api.get('/export', (c) => {
  const sites = listSites();
  const entries: ZipEntry[] = [];
  const siteCols = ['id', 'name', 'host', 'key', 'consent_mode', 'target_countries', 'created_at', 'first_event_at', 'last_seen_at'];
  entries.push({ name: 'sites.csv', data: [siteCols.join(','), ...sites.map((s) => siteCols.map((k) => csvCell(k === 'target_countries' ? s.target_countries.join(';') : (s as unknown as Record<string, unknown>)[k])).join(','))].join('\r\n') + '\r\n' });
  const cols = ['id', 'source', 'upload_id', 'received_at', 'ts', 'ip', 'ip_private', 'asn', 'asn_name', 'is_hosting', 'country', 'ua', 'ua_family', 'gclid', 'is_test', 'session_id', 'fp_hash', 'dwell_ms', 'visible', 'interactions', 'automation', 'url', 'referer', 'campaign'];
  const stmt = db().prepare(`SELECT ${cols.join(',')} FROM events WHERE site_id = ? ORDER BY ts`);
  for (const s of sites) {
    const lines = [cols.join(',')];
    for (const r of stmt.all(s.id) as Record<string, unknown>[]) lines.push(cols.map((k) => csvCell(r[k])).join(','));
    const slug = s.host.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    entries.push({ name: `events-${slug}-${s.id}.csv`, data: lines.join('\r\n') + '\r\n' });
  }
  const zip = writeZip(entries);
  return c.body(bytes(zip), 200, {
    'content-type': 'application/zip',
    'content-length': String(zip.length),
    'content-disposition': `attachment; filename="smb-toolkit-export-${new Date().toISOString().slice(0, 10)}.zip"`,
    'cache-control': 'no-store',
  });
});

api.notFound((c) => c.json({ error: 'Not found.' }, 404));
api.onError((err, c) => {
  log('api error', err);
  telemetry.track('error', { stage: 'write', error_class: err.name.slice(0, 64) });
  return c.json({ error: 'Something went wrong on the server. The log has the details.' }, 500);
});

