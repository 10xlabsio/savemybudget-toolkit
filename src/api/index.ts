/** JSON / form API. Mutations carry CSRF (checked in app.ts middleware). Forms use PRG. */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
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
import { COUNTRY_CODES, bytes, makeSiteKey, validateHost, type AppEnv } from '../ui.js';

export const api = new Hono<AppEnv>();

const str = (v: unknown, max = 4096): string => (typeof v === 'string' ? v.slice(0, max) : '');
const jsonError = (c: { json: (o: unknown, s?: number) => Response }, message: string, status = 400) => c.json({ error: message }, status as 400);

function siteId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function form(c: { req: { header(n: string): string | undefined; parseBody(): Promise<Record<string, unknown>>; json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  const ct = (c.req.header('content-type') ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    try { const j = await c.req.json(); return j && typeof j === 'object' ? (j as Record<string, unknown>) : {}; } catch { return {}; }
  }
  try { return await c.req.parseBody(); } catch { return {}; }
}

function siteFormValues(b: Record<string, unknown>) {
  const raw = b['target_countries'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const target_countries = [...new Set(list.map((x) => String(x).trim().toUpperCase()).filter((x) => COUNTRY_CODES.has(x)))];
  return {
    name: str(b['name'], 80).trim(),
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

api.get('/setup/check', async (c) => {
  const raw = (c.req.query('url') ?? '').trim().replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(raw); } catch { return c.json({ ok: false, url: raw, reason: 'That is not a full URL. It should look like https://t.yourbrand.com.' }); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return c.json({ ok: false, url: raw, reason: 'The URL must start with https://.' });
  const target = `${raw}/collect/healthz`;
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(6000), redirect: 'manual' });
    if (!res.ok) return c.json({ ok: false, url: target, reason: `${target} answered ${res.status}. The proxy must pass /collect to the toolkit.` });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; version?: string } | null;
    if (!j?.ok) return c.json({ ok: false, url: target, reason: `${target} answered, but not with the toolkit's health response. Something else is on that address.` });
    if (u.protocol !== 'https:') return c.json({ ok: true, url: target, warning: 'Reachable over http. Browsers will not post beacons from an https page to it — put TLS in front before installing the tag.' });
    return c.json({ ok: true, url: target, version: j.version ?? null });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    const reason = name === 'TimeoutError' || name === 'AbortError'
      ? `${target} did not answer within 6 seconds. Check DNS and that the proxy is up.`
      : `${target} could not be reached from this server. Check the DNS record and the proxy.`;
    return c.json({ ok: false, url: target, reason });
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
  const next = str(b['_next'], 200);
  return c.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/settings?saved=1', 303);
});

// ---------- uploads ----------

const uploadsDir = () => { const d = join(config.dataDir, 'uploads'); mkdirSync(d, { recursive: true }); return d; };
const TOKEN_RE = /^[a-f0-9]{24}\.bin$/;

function readStaged(token: string): { buf: Buffer; filename: string; site_id: number } | null {
  if (!TOKEN_RE.test(token)) return null;
  const p = join(uploadsDir(), token);
  const metaP = p + '.json';
  if (!existsSync(p) || !existsSync(metaP)) return null;
  const meta = JSON.parse(readFileSync(metaP, 'utf8')) as { filename: string; site_id: number };
  return { buf: readFileSync(p), filename: meta.filename, site_id: meta.site_id };
}
function dropStaged(token: string) {
  if (!TOKEN_RE.test(token)) return;
  for (const p of [join(uploadsDir(), token), join(uploadsDir(), token + '.json')]) { try { unlinkSync(p); } catch { /* gone */ } }
}

api.post('/sites/:id/uploads', async (c) => {
  const id = siteId(c.req.param('id'));
  const site = id ? getSite(id) : null;
  if (!site) return jsonError(c, 'Site not found.', 404);
  const len = Number(c.req.header('content-length') ?? '0');
  if (len > config.maxUploadMb * 1048576) return jsonError(c, `The file is larger than ${config.maxUploadMb} MB. Split it, or raise SMB_MAX_UPLOAD_MB.`, 413);
  const b = await form(c);
  const f = b['file'];
  if (!(f instanceof File)) return jsonError(c, 'Choose a file first.');
  if (f.size > config.maxUploadMb * 1048576) return jsonError(c, `The file is larger than ${config.maxUploadMb} MB. Split it, or raise SMB_MAX_UPLOAD_MB.`, 413);
  const buf = Buffer.from(await f.arrayBuffer());
  const filename = basename(f.name || 'upload').slice(0, 255);
  let mapping: Record<string, string> | undefined;
  if (typeof b['mapping'] === 'string' && b['mapping']) { try { mapping = JSON.parse(b['mapping']); } catch { mapping = undefined; } }
  const prev = str(b['token'], 64);
  if (prev) dropStaged(prev);
  const preview = analyzeUpload(buf, filename, { retentionDays: retentionDays(), mapping });
  const token = randomBytes(12).toString('hex') + '.bin';
  writeFileSync(join(uploadsDir(), token), buf);
  writeFileSync(join(uploadsDir(), token + '.json'), JSON.stringify({ filename, site_id: site.id, mapping: mapping ?? null, at: Date.now() }));
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
  let mapping: Record<string, string> | undefined;
  const m = b['mapping'];
  if (m && typeof m === 'object') mapping = m as Record<string, string>;
  else if (typeof m === 'string' && m) { try { mapping = JSON.parse(m); } catch { mapping = undefined; } }
  if (!mapping) {
    try { const meta = JSON.parse(readFileSync(join(uploadsDir(), token + '.json'), 'utf8')); if (meta.mapping) mapping = meta.mapping; } catch { /* none */ }
  }
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
  try { unlinkSync(p.path); } catch { /* already gone */ }
  db().prepare('DELETE FROM packages WHERE id = ?').run(p.id);
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

