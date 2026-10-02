// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * OAuth 2.1 sign-in for AI assistants that can't send a fixed header — custom connectors on claude.ai, Claude
 * Desktop and Claude mobile. The toolkit has no user accounts, so "signing in" means pasting the instance token
 * (Settings → AI assistants) into a page served here; the assistant then gets its own short-lived tokens.
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]    RFC 9728, points at this origin as the authorization server
 *   GET  /.well-known/oauth-authorization-server[/mcp]  RFC 8414 metadata
 *   POST /mcp/oauth/register                            RFC 7591 dynamic client registration
 *   GET  /mcp/oauth/authorize, POST                     code flow; PKCE S256 required; the page asks for the token
 *   POST /mcp/oauth/token                               authorization_code and refresh_token (single-use, rotating)
 *   POST /mcp/oauth/revoke                              RFC 7009
 *
 * Only SHA-256 hashes of codes, tokens and client secrets are stored. Access tokens live 1 h, refresh tokens 30
 * days; replaying a used refresh token ends that sign-in. Every code and token records the instance token's
 * fingerprint, so a new token, Turn off, or a changed SMB_MCP_TOKEN signs every assistant out.
 *
 * Needs the public URL (Settings, or SMB_PUBLIC_URL): the issuer and resource are built from it, never from the
 * request's Host header. Without it, or with AI assistants off, every route here is a 404.
 */
import type { Context, Hono } from 'hono';
import { Hono as HonoApp } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getCookie, setCookie } from 'hono/cookie';
import { db, bumpCounter, getSetting, setSetting, now as nowIso } from '../db.js';
import { clientIp, clientKey } from '../collect/index.js';
import { makeRateLimiter } from '../ratelimit.js';
import { publicUrl, readBodyCapped } from '../ui.js';
import { mcpEnabled, tokenFingerprint, tokenMatches } from './token.js';

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 24 * 3600;
export const CODE_TTL_S = 600;
export const SCOPE = 'toolkit';
const MAX_CLIENTS = 500;
const BODY_CAP = 64 * 1024;
const NONCE_COOKIE = 'smb_oauth';
const DOCS_URL = 'https://github.com/10xlabsio/savemybudget-toolkit/blob/main/docs/ai-assistants.md';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const b64url = (buf: Buffer) => buf.toString('base64url');
const newSecret = (prefix: string) => `${prefix}_${b64url(randomBytes(32))}`;
const iso = (ms: number) => new Date(ms).toISOString();

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** https://t.example.com — from the configured public URL only. Null when unset or not a URL. */
export function oauthOrigin(): string | null {
  const u = publicUrl();
  if (!u) return null;
  try { return new URL(u).origin; } catch { return null; }
}
export const resourceUrl = (origin: string) => `${origin}/mcp`;
export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource`;
const available = () => mcpEnabled() && oauthOrigin() !== null;

export function pkceS256(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Redirect URIs we register: https anywhere, http only on loopback, native app schemes (cursor://…). */
export function redirectUriAllowed(uri: string): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'https') return true;
  if (scheme === 'http') return LOOPBACK.includes(u.hostname);
  if (['javascript', 'data', 'vbscript', 'file', 'blob', 'about', 'ftp', 'ws', 'wss'].includes(scheme)) return false;
  // Schemes that open a web page in a browser would turn the code into a redirect to any site.
  if (BROWSER_LAUNCH.has(scheme)) return false;
  return /^[a-z][a-z0-9+.-]*$/.test(scheme);
}
const BROWSER_LAUNCH = new Set(['microsoft-edge', 'microsoft-edge-holographic', 'googlechrome', 'googlechromes', 'x-safari-http', 'x-safari-https',
  'firefox', 'firefox-private', 'opera-http', 'opera-https', 'brave', 'vivaldi', 'intent', 'android-app', 'ms-browser-extension', 'x-web-search']);

/** App names come from the app: drop control and format characters (bidi overrides, zero-width) and squeeze spaces. */
export function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim() : '';
  return (s || 'An AI assistant').slice(0, 80);
}

/** Exact match, except loopback redirects match on any port (native apps pick a free port per run, RFC 8252 §7.3). */
export function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol !== 'http:' || !LOOPBACK.includes(u.hostname)) return false;
  return registered.some((r) => {
    try { const v = new URL(r); return v.protocol === 'http:' && v.hostname === u.hostname && v.pathname === u.pathname && v.search === u.search; } catch { return false; }
  });
}

function resourceOk(origin: string, resource: string | null | undefined): boolean {
  if (!resource) return true;
  const norm = (s: string) => s.replace(/\/+$/, '');
  return [resourceUrl(origin), origin].map(norm).includes(norm(resource));
}

// ---------------------------------------------------------------- token store

interface ClientRow { id: string; secret_hash: string | null; auth_method: 'none' | 'client_secret_post' | 'client_secret_basic'; name: string; redirect_uris: string[] }

function clientById(id: string): ClientRow | null {
  if (!/^mcpc_[A-Za-z0-9_-]{10,64}$/.test(id)) return null;
  const r = db().prepare('SELECT id, secret_hash, auth_method, name, redirect_uris FROM oauth_clients WHERE id = ?').get(id) as (Omit<ClientRow, 'redirect_uris'> & { redirect_uris: string }) | undefined;
  return r ? { ...r, redirect_uris: JSON.parse(r.redirect_uris) as string[] } : null;
}

function issueTokens(clientId: string, family: string, fp: string, nowMs: number) {
  const access = newSecret('smbt_at');
  const refresh = newSecret('smbt_rt');
  const ins = db().prepare('INSERT INTO oauth_tokens(token_hash, kind, client_id, family, token_fp, created_at, expires_at) VALUES(?,?,?,?,?,?,?)');
  ins.run(sha256(access), 'access', clientId, family, fp, iso(nowMs), iso(nowMs + ACCESS_TTL_S * 1000));
  ins.run(sha256(refresh), 'refresh', clientId, family, fp, iso(nowMs), iso(nowMs + REFRESH_TTL_S * 1000));
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
}

/** A bearer token issued by sign-in, still valid under the current instance token. */
export function verifyAccessToken(token: string, nowMs = Date.now()): { clientId: string; clientName: string } | null {
  if (!token.startsWith('smbt_at_') || token.length > 200) return null;
  const fp = tokenFingerprint();
  if (!fp) return null;
  const r = db().prepare(`SELECT t.client_id, t.expires_at, t.token_fp, t.last_used_at, c.name FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
    WHERE t.token_hash = ? AND t.kind = 'access' AND t.revoked_at IS NULL`).get(sha256(token)) as { client_id: string; expires_at: string; token_fp: string; last_used_at: string | null; name: string } | undefined;
  if (!r || Date.parse(r.expires_at) <= nowMs || r.token_fp !== fp) return null;
  if (!r.last_used_at || nowMs - Date.parse(r.last_used_at) > 5 * 60_000) {
    db().prepare('UPDATE oauth_tokens SET last_used_at = ? WHERE token_hash = ?').run(iso(nowMs), sha256(token));
  }
  return { clientId: r.client_id, clientName: r.name };
}

/** Assistants signed in under the current token, for the Settings page. */
export function signedInAssistants(nowMs = Date.now()): { family: string; clientName: string; since: string; lastUsedAt: string | null }[] {
  const fp = tokenFingerprint();
  if (!fp) return [];
  return (db().prepare(`SELECT t.family, c.name AS client_name, MIN(t.created_at) AS since, MAX(t.last_used_at) AS last_used_at
      FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
      WHERE t.revoked_at IS NULL AND t.expires_at > ? AND t.token_fp = ?
      GROUP BY t.family, c.name ORDER BY MAX(t.created_at) DESC`).all(iso(nowMs), fp) as { family: string; client_name: string; since: string; last_used_at: string | null }[])
    .map((r) => ({ family: r.family, clientName: r.client_name, since: r.since, lastUsedAt: r.last_used_at }));
}

/** Sign every assistant out (Settings button; also on a new token or Turn off). */
export function signOutAllAssistants(): void {
  db().prepare('DELETE FROM oauth_tokens').run();
  db().prepare('DELETE FROM oauth_codes').run();
}

const revokeFamily = (family: string) => db().prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL').run(nowIso(), family);

/**
 * Hourly: drop expired codes and tokens, and registrations that never completed a sign-in. Apps that did sign in
 * keep their registration, so a connector can sign in again after Sign out all or a new token.
 */
export function sweepOAuth(nowMs = Date.now()): void {
  const d = db();
  d.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(iso(nowMs - 86400e3));
  d.prepare('DELETE FROM oauth_tokens WHERE expires_at < ? OR revoked_at < ?').run(iso(nowMs), iso(nowMs - 86400e3));
  d.prepare('DELETE FROM oauth_clients WHERE last_used_at IS NULL AND created_at < ? AND id NOT IN (SELECT client_id FROM oauth_codes)').run(iso(nowMs - 86400e3));
}

const FP_KEY = 'mcp_token_fp_seen';
/**
 * Call at start-up and whenever the token may have changed: if the instance token isn't the one sign-ins were last
 * issued under (say SMB_MCP_TOKEN went A → B), everyone is signed out — so going back to A later can't revive them.
 */
export function syncInstanceToken(): void {
  const fp = tokenFingerprint() ?? '';
  const seen = getSetting(FP_KEY);
  if (seen !== null && seen !== fp) signOutAllAssistants();
  if (seen !== fp) setSetting(FP_KEY, fp);
}

// ---------------------------------------------------------------- discovery (mounted at /.well-known)

export const wellKnownApp = new HonoApp<{ Bindings: HttpBindings }>();

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '86400',
};
const cors = (c: Context) => { for (const [k, v] of Object.entries(CORS)) c.header(k, v); c.header('cache-control', 'no-store'); };
const off = (c: Context) => c.text('Not found', 404);

const prm = (c: Context) => {
  const origin = oauthOrigin();
  if (!origin || !mcpEnabled()) return off(c);
  cors(c);
  return c.json({ resource: resourceUrl(origin), authorization_servers: [origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'SaveMyBudget Toolkit', resource_documentation: DOCS_URL });
};
const asMeta = (c: Context) => {
  const origin = oauthOrigin();
  if (!origin || !mcpEnabled()) return off(c);
  cors(c);
  const base = `${origin}/mcp/oauth`;
  return c.json({
    issuer: origin,
    authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, revocation_endpoint: `${base}/revoke`,
    scopes_supported: [SCOPE], response_types_supported: ['code'], response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true, service_documentation: DOCS_URL,
  });
};
for (const p of ['/oauth-protected-resource', '/oauth-protected-resource/mcp']) { wellKnownApp.get(p, prm); wellKnownApp.options(p, (c) => (available() ? (cors(c), c.body(null, 204)) : off(c))); }
for (const p of ['/oauth-authorization-server', '/oauth-authorization-server/mcp']) { wellKnownApp.get(p, asMeta); wellKnownApp.options(p, (c) => (available() ? (cors(c), c.body(null, 204)) : off(c))); }
wellKnownApp.all('*', off);

// ---------------------------------------------------------------- pages

const PAGE_CSS = `*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7f9;color:#1d2433}
main{max-width:460px;margin:48px auto;padding:0 16px}.card{background:#fff;border:1px solid #e3e6ec;border-radius:10px;padding:24px}
.brand{font-size:13px;color:#5b6475;margin-bottom:12px}h1{font-size:20px;margin:0 0 12px}ul{padding-left:20px;margin:8px 0 16px}li{margin:4px 0}
label{display:block;font-weight:600;margin:16px 0 6px}input[type=password]{width:100%;padding:10px;border:1px solid #c9ced8;border-radius:6px;font:14px ui-monospace,monospace}
.hint{font-size:13px;color:#5b6475}.warn{background:#fff6e0;color:#7a4b00;border-radius:6px;padding:10px;margin:12px 0}code{font:13px ui-monospace,monospace;word-break:break-all}.err{background:#fdecec;color:#9b1c1c;border-radius:6px;padding:10px;margin:12px 0}.row{display:flex;gap:8px;margin-top:18px}
button{padding:10px 16px;border-radius:6px;border:1px solid #c9ced8;background:#fff;font:inherit;cursor:pointer}button.pri{background:#1f6f43;border-color:#1f6f43;color:#fff}
@media (prefers-color-scheme:dark){body{background:#12151b;color:#e6e9ef}.card{background:#1a1e26;border-color:#2b313d}.brand,.hint{color:#9aa3b2}
input[type=password]{background:#12151b;color:#e6e9ef;border-color:#3a4150}button{background:#1a1e26;color:#e6e9ef;border-color:#3a4150}.err{background:#3a1717;color:#f3b4b4}.warn{background:#3a2c10;color:#f3d48a}}`;

function Shell(p: { title: string; children: unknown }) {
  return (
    <html lang="en">
      <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="referrer" content="no-referrer" /><title>{p.title}</title><style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} /></head>
      <body><main><div class="card">{p.children}</div></main></body>
    </html>
  );
}

function ConsentPage(p: { host: string; clientName: string; redirect: { host: string; full: string | null; familiar: boolean }; hidden: Record<string, string>; error?: string | null }) {
  return (
    <Shell title={`Connect ${p.clientName} — SaveMyBudget Toolkit`}>
      <div class="brand">SaveMyBudget Toolkit · {p.host}</div>
      <h1>Connect “{p.clientName}”?</h1>
      <p>An app calling itself “{p.clientName}” wants to use this toolkit. After you connect, you go back to <b>{p.redirect.host}</b>{p.redirect.full ? <> (<code>{p.redirect.full}</code>)</> : null}.</p>
      {p.redirect.familiar ? null : (
        <div class="warn">It returns to {p.redirect.host}, not to Claude or this computer. Only continue if you started this connection yourself, just now, from that app.</div>
      )}
      <p>It will be able to:</p>
      <ul>
        <li>see your sites, tag health and click totals</li>
        <li>see flagged clicks, with full visitor IPs and the rules that fired</li>
        <li>match CRM leads you send it against clicks</li>
        <li>save analyses and build claim packages</li>
      </ul>
      <p class="hint">It can't change sites or settings, file claims, or touch Google Ads.</p>
      {p.error ? <div class="err">{p.error}</div> : null}
      <form method="post">
        {Object.entries(p.hidden).map(([k, v]) => <input type="hidden" name={k} value={v} />)}
        <label for="token">Toolkit token</label>
        <input type="password" id="token" name="token" autocomplete="off" required />
        <p class="hint">From Settings → AI assistants on your toolkit. Lost it? Create a new one there — that also signs out every other assistant.</p>
        <div class="row">
          <button type="submit" class="pri" name="decision" value="allow">Connect</button>
          <button type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
        </div>
      </form>
    </Shell>
  );
}

function ErrorPage(p: { message: string }) {
  return (
    <Shell title="Can't connect — SaveMyBudget Toolkit">
      <div class="brand">SaveMyBudget Toolkit</div>
      <h1>This connection request can't be used</h1>
      <p>{p.message}</p>
    </Shell>
  );
}

const PAGE_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};
async function page(c: Context, node: unknown, status: 200 | 400 | 401 | 429 = 200) {
  const html = '<!doctype html>\n' + String(await (node as Promise<string> | string));
  return c.html(html, status, PAGE_HEADERS);
}

// ---------------------------------------------------------------- endpoints (mounted on the MCP app, so under /mcp)

let registrations = makeRateLimiter(30, 3_600_000);
let wrongTokens = makeRateLimiter(30, 60_000);
/** For tests. */
export function resetOAuthLimits(): void { registrations = makeRateLimiter(30, 3_600_000); wrongTokens = makeRateLimiter(30, 60_000); }

/** Request bodies here are small; read them under a cap before parsing (JSON or form). Null = too large. */
async function cappedBody(c: Context): Promise<Record<string, unknown> | null> {
  const buf = await readBodyCapped(c.req.raw, BODY_CAP);
  if (buf === null) return null;
  const text = buf.toString('utf8');
  if ((c.req.header('content-type') ?? '').includes('application/json')) {
    try { const j = JSON.parse(text); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(text));
}
const tooLarge = (c: Context) => c.json({ error: 'invalid_request', error_description: 'Request body too large.' }, 413);

export function mountOAuth(app: Hono<{ Bindings: HttpBindings }>): void {
  const keyOf = (c: Context) => clientKey(clientIp(c as never));

  app.post('/oauth/register', async (c) => {
    if (!available()) return off(c);
    if (registrations(keyOf(c))) return c.json({ error: 'invalid_client_metadata', error_description: 'Too many registrations from this address; try again later.' }, 429);
    const body = await cappedBody(c);
    if (body === null) return tooLarge(c);
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (uris.length === 0 || uris.length > 10 || uris.some((u) => u.length > 2000 || !redirectUriAllowed(u))) {
      return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https URLs, http on localhost, or a native app scheme.' }, 400);
    }
    const method = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return c.json({ error: 'invalid_client_metadata', error_description: 'Unsupported token_endpoint_auth_method.' }, 400);
    // Keep the grant types we support and ignore the rest (some clients also list device_code and the like).
    const grants = Array.isArray(body.grant_types) ? body.grant_types.filter((g) => g === 'authorization_code' || g === 'refresh_token') : ['authorization_code'];
    if (!grants.includes('authorization_code')) return c.json({ error: 'invalid_client_metadata', error_description: 'This server supports the authorization_code grant (with refresh_token).' }, 400);
    const d = db();
    const count = (d.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n;
    if (count >= MAX_CLIENTS) {
      // Evict the oldest registrations that never signed in and aren't mid-sign-in (no code, older than an hour).
      d.prepare(`DELETE FROM oauth_clients WHERE id IN (SELECT id FROM oauth_clients WHERE last_used_at IS NULL AND created_at < ?
        AND id NOT IN (SELECT client_id FROM oauth_codes) ORDER BY created_at LIMIT 50)`).run(iso(Date.now() - 3600e3));
      if ((d.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n >= MAX_CLIENTS) return c.json({ error: 'invalid_client_metadata', error_description: 'Too many registered apps on this toolkit.' }, 429);
    }
    const name = cleanName(body.client_name);
    const id = `mcpc_${b64url(randomBytes(18))}`;
    const secret = method === 'none' ? null : newSecret('smbt_cs');
    d.prepare('INSERT INTO oauth_clients(id, secret_hash, auth_method, name, redirect_uris, created_at) VALUES(?,?,?,?,?,?)').run(id, secret ? sha256(secret) : null, method, name, JSON.stringify(uris), nowIso());
    c.header('cache-control', 'no-store');
    return c.json({
      client_id: id, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method, scope: SCOPE,
    }, 201);
  });

  type Authz = { client: ClientRow; redirectUri: string; state: string | null; challenge: string; resource: string | null };

  /** Only after the request is valid and the form came from this browser: the code, or access_denied on Cancel. */
  const redirectWith = (c: Context, origin: string, redirectUri: string, params: Record<string, string | null>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
    u.searchParams.set('iss', origin);
    return c.redirect(u.toString(), 302);
  };

  /**
   * A bad request gets a page here, never a redirect: anyone can register an app with any https return address,
   * so redirecting on errors would make this page an open redirect on the operator's own domain. Unknown scopes
   * are ignored — there is one level of access.
   */
  const validate = async (c: Context, origin: string, q: (k: string) => string | undefined): Promise<Authz | Response> => {
    const fail = (message: string) => page(c, <ErrorPage message={message} />, 400);
    const client = clientById(q('client_id') ?? '');
    if (!client) return fail("It comes from an app this toolkit doesn't recognise. Start the connection again from your AI assistant.");
    const redirectUri = q('redirect_uri') ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : '');
    if (!redirectMatches(client.redirect_uris, redirectUri)) return fail("Its return address doesn't match the app's registration. Start the connection again from your AI assistant.");
    if (q('response_type') !== 'code') return fail('The app asked for a kind of sign-in this toolkit doesn\'t offer (response_type must be code).');
    const challenge = q('code_challenge') ?? '';
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || q('code_challenge_method') !== 'S256') return fail('The app didn\'t use PKCE with S256, which this toolkit requires.');
    const resource = q('resource') ?? null;
    if (!resourceOk(origin, resource)) return fail(`The app is trying to connect to a different address. This toolkit's address is ${resourceUrl(origin)}.`);
    return { client, redirectUri, state: q('state') ?? null, challenge, resource };
  };

  const hiddenFor = (v: Authz, nonce: string) => ({
    client_id: v.client.id, redirect_uri: v.redirectUri, state: v.state ?? '', code_challenge: v.challenge, code_challenge_method: 'S256',
    response_type: 'code', resource: v.resource ?? '', nonce,
  });
  /** Where the code goes, as the operator should see it: host for https, the full address for anything else. */
  const describeRedirect = (uri: string) => {
    let u: URL | null = null;
    try { u = new URL(uri); } catch { /* registered, so parseable */ }
    const https = u?.protocol === 'https:';
    const loopback = u?.protocol === 'http:' && LOOPBACK.includes(u.hostname);
    const host = (u && (https || loopback) ? u.host : uri.split(':')[0]) || uri;
    const familiar = loopback || (https && (u!.hostname === 'claude.ai' || u!.hostname.endsWith('.claude.ai')));
    return { host, full: https ? null : uri, familiar };
  };
  /**
   * The consent form is bound to the browser that loaded it: a random nonce in the form and in a SameSite=Strict
   * cookie. A page on another site can't post it — so it can't make this toolkit redirect anywhere, even on Cancel.
   */
  const issueNonce = (c: Context, origin: string) => {
    const n = b64url(randomBytes(18));
    setCookie(c, NONCE_COOKIE, n, { path: '/mcp/oauth', httpOnly: true, sameSite: 'Strict', secure: origin.startsWith('https:'), maxAge: 1800 });
    return n;
  };

  app.get('/oauth/authorize', async (c) => {
    const origin = oauthOrigin();
    if (!origin || !mcpEnabled()) return off(c);
    const v = await validate(c, origin, (k) => c.req.query(k) || undefined);
    if (v instanceof Response) return v;
    return page(c, <ConsentPage host={new URL(origin).host} clientName={cleanName(v.client.name)} redirect={describeRedirect(v.redirectUri)} hidden={hiddenFor(v, issueNonce(c, origin))} />);
  });

  app.post('/oauth/authorize', async (c) => {
    const origin = oauthOrigin();
    if (!origin || !mcpEnabled()) return off(c);
    const form = await cappedBody(c);
    if (form === null) return tooLarge(c);
    const q = (k: string) => { const x = form[k]; return typeof x === 'string' && x !== '' ? x : undefined; };
    const v = await validate(c, origin, q);
    if (v instanceof Response) return v;
    const nonce = q('nonce') ?? '', cookie = getCookie(c, NONCE_COOKIE) ?? '';
    if (!nonce || !cookie || !safeEqual(nonce, cookie)) return page(c, <ErrorPage message="This sign-in page has expired or was opened somewhere else. Start the connection again from your AI assistant." />, 400);
    if (q('decision') !== 'allow') return redirectWith(c, origin, v.redirectUri, { error: 'access_denied', state: v.state });
    const again = (error: string, status: 401 | 429) => page(c, <ConsentPage host={new URL(origin).host} clientName={cleanName(v.client.name)} redirect={describeRedirect(v.redirectUri)} hidden={hiddenFor(v, nonce)} error={error} />, status);
    // A client that keeps getting the token wrong is paused even if its next guess is right.
    if (wrongTokens.peek(keyOf(c))) return again('Too many attempts. Wait a minute and try again.', 429);
    if (!tokenMatches(q('token') ?? '')) {
      wrongTokens(keyOf(c));
      bumpCounter('mcp_unauthorized');
      return again("That token doesn't match this toolkit. Copy it again from Settings → AI assistants, or create a new one there.", 401);
    }
    const fp = tokenFingerprint()!;
    const code = newSecret('smbt_code');
    db().prepare('INSERT INTO oauth_codes(code_hash, client_id, redirect_uri, code_challenge, resource, token_fp, expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(sha256(code), v.client.id, v.redirectUri, v.challenge, v.resource, fp, iso(Date.now() + CODE_TTL_S * 1000));
    bumpCounter('mcp_signins');
    return redirectWith(c, origin, v.redirectUri, { code, state: v.state });
  });

  const readBody = async (c: Context): Promise<Record<string, string> | null> => {
    const raw = await cappedBody(c);
    return raw === null ? null : (Object.fromEntries(Object.entries(raw).filter(([, x]) => typeof x === 'string')) as Record<string, string>);
  };

  /** Client authentication by the method the app registered with; a confidential client must use that method. */
  const authClient = (c: Context, body: Record<string, string>): ClientRow | null => {
    let id = body.client_id ?? '', secret = body.client_secret ?? '';
    const basic = /^Basic\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
    if (basic) {
      const [u, p] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      try { id = decodeURIComponent(u ?? ''); secret = decodeURIComponent(p ?? ''); } catch { return null; }
    }
    const client = clientById(id);
    if (!client) return null;
    if (client.auth_method === 'none') return client;
    if (client.auth_method === 'client_secret_basic' && !basic) return null;
    if (client.auth_method === 'client_secret_post' && basic) return null;
    if (!secret || !client.secret_hash || !safeEqual(sha256(secret), client.secret_hash)) return null;
    return client;
  };

  const tokenError = (c: Context, error: string, description: string, status: 400 | 401 = 400) => {
    c.header('cache-control', 'no-store');
    if (status === 401 && /^Basic\s/i.test(c.req.header('authorization') ?? '')) c.header('www-authenticate', 'Basic realm="savemybudget-toolkit"');
    return c.json({ error, error_description: description }, status);
  };

  app.post('/oauth/token', async (c) => {
    const origin = oauthOrigin();
    if (!origin || !mcpEnabled()) return off(c);
    c.header('cache-control', 'no-store');
    c.header('pragma', 'no-cache');
    const body = await readBody(c);
    if (body === null) return tooLarge(c);
    const client = authClient(c, body);
    if (!client) return tokenError(c, 'invalid_client', 'Unknown client or bad credentials.', 401);
    const d = db();
    const nowMs = Date.now();
    d.prepare('UPDATE oauth_clients SET last_used_at = ? WHERE id = ?').run(iso(nowMs), client.id);
    const fp = tokenFingerprint()!;

    if (body.grant_type === 'authorization_code') {
      const codeHash = sha256(body.code ?? '');
      const family = randomUUID();
      const code = d.prepare('UPDATE oauth_codes SET used_at = ?, family = ? WHERE code_hash = ? AND used_at IS NULL RETURNING client_id, redirect_uri, code_challenge, token_fp, expires_at')
        .get(iso(nowMs), family, codeHash) as { client_id: string; redirect_uri: string; code_challenge: string; token_fp: string; expires_at: string } | undefined;
      if (!code) {
        // A code used twice was probably intercepted: end whatever the first use signed in (RFC 6749 §4.1.2).
        const used = d.prepare('SELECT family FROM oauth_codes WHERE code_hash = ? AND used_at IS NOT NULL').get(codeHash) as { family: string | null } | undefined;
        if (used?.family) revokeFamily(used.family);
        return tokenError(c, 'invalid_grant', 'The code is invalid, expired or already used.');
      }
      if (code.client_id !== client.id) return tokenError(c, 'invalid_grant', 'The code is invalid, expired or already used.');
      if (Date.parse(code.expires_at) <= nowMs) return tokenError(c, 'invalid_grant', 'The code has expired.');
      if (code.token_fp !== fp) return tokenError(c, 'invalid_grant', 'The toolkit token changed since this code was issued. Connect again.');
      if (body.redirect_uri && body.redirect_uri !== code.redirect_uri) return tokenError(c, 'invalid_grant', "redirect_uri doesn't match.");
      if (!body.code_verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier) || !safeEqual(pkceS256(body.code_verifier), code.code_challenge)) return tokenError(c, 'invalid_grant', 'PKCE verification failed.');
      if (body.resource && !resourceOk(origin, body.resource)) return tokenError(c, 'invalid_target', 'Unknown resource.');
      return c.json(issueTokens(client.id, family, fp, nowMs));
    }

    if (body.grant_type === 'refresh_token') {
      const t = d.prepare("SELECT client_id, family, token_fp, expires_at, used_at, revoked_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
        .get(sha256(body.refresh_token ?? '')) as { client_id: string; family: string; token_fp: string; expires_at: string; used_at: string | null; revoked_at: string | null } | undefined;
      if (!t || t.client_id !== client.id || t.revoked_at) return tokenError(c, 'invalid_grant', 'The refresh token is invalid.');
      if (t.used_at) { revokeFamily(t.family); return tokenError(c, 'invalid_grant', 'The refresh token was already used, so this sign-in has been ended for safety. Connect again.'); }
      if (Date.parse(t.expires_at) <= nowMs) return tokenError(c, 'invalid_grant', 'The refresh token has expired. Connect again.');
      if (t.token_fp !== fp) return tokenError(c, 'invalid_grant', 'The toolkit token changed since this assistant signed in. Connect again.');
      const claimed = d.prepare('UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(iso(nowMs), sha256(body.refresh_token ?? ''));
      if (Number(claimed.changes) === 0) { revokeFamily(t.family); return tokenError(c, 'invalid_grant', 'The refresh token was already used.'); }
      d.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND kind = 'access' AND revoked_at IS NULL").run(iso(nowMs), t.family);
      return c.json(issueTokens(client.id, t.family, fp, nowMs));
    }

    return tokenError(c, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  app.post('/oauth/revoke', async (c) => {
    if (!available()) return off(c);
    const body = await readBody(c);
    if (body === null) return tooLarge(c);
    const client = authClient(c, body);
    if (!client) return tokenError(c, 'invalid_client', 'Unknown client or bad credentials.', 401);
    const r = db().prepare('SELECT family FROM oauth_tokens WHERE token_hash = ? AND client_id = ?').get(sha256(body.token ?? ''), client.id) as { family: string } | undefined;
    if (r) revokeFamily(r.family);
    return c.body(null, 200);
  });

  for (const p of ['/oauth/register', '/oauth/token', '/oauth/revoke']) app.options(p, (c) => (available() ? c.body(null, 204) : off(c)));
}
