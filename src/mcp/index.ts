// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * MCP server at /mcp — Streamable HTTP, stateless: every POST carries one JSON-RPC message or a batch and gets
 * one JSON body back (no SSE, no session id). Mounted beside the collector, outside the UI middleware: no
 * cookies, no CSRF, no setup redirect.
 *
 * Off until a token exists (Settings → AI assistants, or SMB_MCP_TOKEN): until then every /mcp request is a
 * plain 404. With a token: Authorization: Bearer <token> on every request, 120 requests a minute per client
 * address (failed sign-ins included), bodies up to 1 MiB, batches up to 50 messages.
 */
import { Hono, type Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { config } from '../config.js';
import { bumpCounter } from '../db.js';
import { clientIp } from '../collect/index.js';
import { log } from '../jobs/index.js';
import { makeRateLimiter } from '../ratelimit.js';
import { readBodyCapped } from '../ui.js';
import { argumentError } from './schema.js';
import { mcpEnabled, tokenMatches } from './token.js';
import { TOOLS, TOOL_BY_NAME, ToolError, resolveSite, specialiseArgumentError } from './tools.js';
import { PROMPTS, PROMPT_BY_NAME } from './prompts.js';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'savemybudget-toolkit', title: 'SaveMyBudget Toolkit', version: config.version };

export const INSTRUCTIONS = `SaveMyBudget Toolkit is a self-hosted detector for invalid (fraudulent or junk) clicks on Google Ads landing pages.
Start with list_sites to get site_id values (the site's host works too). Numbers are computed on request from the clicks stored on this instance; responses carry computed_at and the sources used (tag beacons, server logs, CSV).
Verdicts: "flag" = the rules say invalid; "watch" = suspicious, worth a human look; "allow" = nothing found. Rules, weights and thresholds are public (get_rules) and the same for every install.
This instance has no Google Ads connection: there is no cost, campaign-ID or Google invalid-click data, and nothing here changes anything in Google Ads. Claims are prepared as a downloadable package (run_analysis, then build_claim_package); a person files them.
To check CRM leads: fetch leads from the CRM yourself, then call match_leads with lead_id plus any of gclid / ip + submitted_at / landing_url. Never send names, emails or phone numbers.`;

const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
const BODY_CAP = 1024 * 1024;
const MAX_BATCH = 50;

let limited = makeRateLimiter(RATE_LIMIT, RATE_WINDOW_MS);
/** For tests: a fresh limiter, optionally with another limit. */
export function resetMcpRateLimit(limit = RATE_LIMIT): void { limited = makeRateLimiter(limit, RATE_WINDOW_MS); }

type Id = string | number | null;
interface Rpc { jsonrpc?: unknown; id?: Id; method?: unknown; params?: unknown }
const result = (id: Id, r: unknown) => ({ jsonrpc: '2.0' as const, id, result: r });
const error = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0' as const, id, error: { code, message } });

function toolResult(data: unknown, isError = false) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], ...(isError ? { isError: true } : {}) };
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'access-control-max-age': '86400',
};

export const mcpApp = new Hono<{ Bindings: HttpBindings }>();

mcpApp.use('*', async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(CORS)) c.res.headers.set(k, v);
  c.res.headers.set('cache-control', 'no-store');
  c.res.headers.set('x-content-type-options', 'nosniff');
});

const notFound = (c: Context) => c.text('Not found', 404);

mcpApp.options('/', (c) => (mcpEnabled() ? c.body(null, 204) : notFound(c)));

mcpApp.on(['GET', 'DELETE'], '/', (c) => {
  if (!mcpEnabled()) return notFound(c);
  c.header('allow', 'POST');
  return c.json({ error: 'method_not_allowed', error_description: 'This server is stateless; POST JSON-RPC messages to /mcp.' }, 405);
});

mcpApp.post('/', async (c) => {
  if (!mcpEnabled()) return notFound(c);
  if (limited(clientIp(c))) {
    c.header('retry-after', String(RATE_WINDOW_MS / 1000));
    return c.json({ error: 'rate_limited', error_description: `At most ${RATE_LIMIT} requests a minute.` }, 429);
  }
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
  if (!m || !tokenMatches(m[1])) {
    bumpCounter('mcp_unauthorized');
    c.header('www-authenticate', 'Bearer realm="savemybudget-toolkit"');
    return c.json({ error: 'unauthorized' }, 401);
  }

  const raw = await readBodyCapped(c.req.raw, BODY_CAP);
  if (raw === null) return c.json(error(null, -32600, 'Request body too large (1 MiB at most).'), 413);
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return c.json(error(null, -32700, 'Parse error'), 400); }

  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as unknown[];
  if (messages.length === 0 || messages.length > MAX_BATCH) return c.json(error(null, -32600, `Invalid Request: send 1–${MAX_BATCH} messages.`), 400);

  const out: unknown[] = [];
  for (const m of messages) {
    const msg = (m && typeof m === 'object' ? m : {}) as Rpc;
    const id: Id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') { out.push(error(id, -32600, 'Invalid Request')); continue; }
    const r = await handle(msg.method, (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>, id);
    if (msg.id !== undefined && r) out.push(r);
  }
  if (!out.length) return c.body(null, 202);
  return c.json(batch ? out : out[0]);
});

mcpApp.all('*', notFound);

async function handle(method: string, params: Record<string, unknown>, id: Id): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return result(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, {
        tools: TOOLS.map((t) => ({
          name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: t.kind === 'read', destructiveHint: false, idempotentHint: t.idempotent, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments === undefined ? {} : params.arguments;
      return result(id, await callTool(name, args));
    }
    case 'prompts/list':
      return result(id, { prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })) });
    case 'prompts/get': {
      const p = PROMPT_BY_NAME.get(String(params.name ?? ''));
      if (!p) return error(id, -32602, 'Unknown prompt');
      const raw = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      const args = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)]));
      for (const a of p.arguments) if (a.required && !args[a.name]) return error(id, -32602, `Missing argument: ${a.name}`);
      bumpCounter('mcp_prompts');
      return result(id, { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.render(args) } }] });
    }
    case 'resources/list':
      return result(id, { resources: [] });
    default:
      return id === null ? null : error(id, -32601, `Method not found: ${method.slice(0, 60)}`);
  }
}

async function callTool(name: string, args: unknown) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return toolResult(`Unknown tool: ${name.slice(0, 60)}. Call tools/list.`, true);
  const invalid = argumentError(args, tool.inputSchema);
  if (invalid) return toolResult(specialiseArgumentError(name, invalid), true);
  const a = args as Record<string, unknown>;
  let site;
  if (a.site_id !== undefined) {
    site = resolveSite(a.site_id) ?? undefined;
    if (!site) return toolResult('No site matches that site_id. Call list_sites.', true);
  } else if (tool.siteScoped) {
    return toolResult('site_id is required. Call list_sites.', true);
  }
  try {
    const data = await tool.handler(a, { now: new Date(), site });
    bumpCounter('mcp_calls');
    return toolResult(data);
  } catch (e) {
    if (e instanceof ToolError) return toolResult(e.message, true);
    log(`mcp: ${name} failed`, e);
    return toolResult('Something went wrong on the toolkit; check its logs.', true);
  }
}
