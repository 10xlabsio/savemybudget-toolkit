// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { Layout, Csrf } from './layout.js';
import { TIMEZONES, displayHost, n } from '../ui.js';
import type { Notification } from '../jobs/index.js';
import type { Site } from '../types.js';

export interface SettingsProps {
  nonce: string; csrf: string; sites: Site[]; notifications: Notification[];
  publicUrl: string; tz: string; retentionDays: number; storeMb: number; silentHours: number;
  telemetryOn: boolean; telemetryEnv: boolean; updateCheckOn: boolean; updateCheckEnv: boolean;
  bind: string; counters: { key: string; value: number; what: string }[];
  mcp: { source: 'env' | 'settings' | null; token: string | null; publicEndpoint: string | null; localEndpoint: string; notice: string | null };
  saved?: boolean;
  error?: string | null;
}

const THRESHOLDS: [number, string][] = [[12, '12 hours'], [24, '1 day'], [48, '2 days'], [72, '3 days'], [168, '7 days']];

export function SettingsPage(p: SettingsProps) {
  const js = `document.querySelectorAll('form[data-confirm]').forEach(function(f){f.addEventListener('submit',function(e){if(!confirm(f.getAttribute('data-confirm')))e.preventDefault()})});
document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var el=document.getElementById(b.getAttribute('data-copy'));if(!el)return;var t=el.textContent||'';var done=function(){var o=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=o},1500)};
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,function(){})}})});`;
  return (
    <Layout title="Settings" nonce={p.nonce} sites={p.sites} notifications={p.notifications} section="settings">
      <h1>Settings</h1>
      <p class="sub">Instance-wide. Site details live on each site's edit page.</p>
      {p.saved ? <div class="note green"><div>Saved.</div></div> : null}
      {p.error ? <div class="note red"><div>{p.error}</div></div> : null}
      <form method="post" action="/api/settings">
        <Csrf token={p.csrf} />
        <input type="hidden" name="_next" value="/settings?saved=1" />
        <div class="card">
          <h2>Instance</h2>
          <label for="public_url">Public URL</label>
          <input type="url" id="public_url" name="public_url" value={p.publicUrl} placeholder="https://t.yourbrand.com" />
          <p class="hint">The address in the snippet. Changing it changes the snippet for every site.</p>
          <label for="tz">Timezone</label>
          <select id="tz" name="tz">{TIMEZONES.map((z) => <option value={z} selected={z === p.tz}>{z}</option>)}</select>
        </div>
        <div class="card">
          <h2>Data</h2>
          <label for="retention_days">Retention (days)</label>
          <input type="number" id="retention_days" name="retention_days" min={60} max={3650} value={String(p.retentionDays)} />
          <p class="hint">Click records older than this are removed every hour. At least 60 days, so a full claim window stays available.</p>
          <p style="margin-top:12px">Data directory: <b>{n(Math.round(p.storeMb))} MB</b>.</p>
        </div>
        <div class="card">
          <h2>Alerts</h2>
          <label for="silent_threshold_hours">Silent-tag threshold</label>
          <select id="silent_threshold_hours" name="silent_threshold_hours">
            {THRESHOLDS.map(([h, l]) => <option value={String(h)} selected={h === p.silentHours}>{l}</option>)}
          </select>
          <p class="hint">A site turns amber and gets a notice when no beacon has arrived for this long.</p>
        </div>
        <div class="card">
          <h2>Anonymous usage counts</h2>
          {p.telemetryEnv ? (
            <><input type="hidden" name="telemetry_present" value="1" /><label class="inl"><input type="checkbox" name="telemetry" value="on" checked={p.telemetryOn} /> Send anonymous usage counts</label></>
          ) : (
            <p class="hint">Turned off with SMB_TELEMETRY=off in the environment.</p>
          )}
          <p class="hint">Which pages get used and where installs stall — never IPs, click IDs, hostnames or rows. Everything is listed in <a href="/docs/telemetry">TELEMETRY.md</a>.</p>
          <h3 style="margin-top:14px">Update check</h3>
          {p.updateCheckEnv ? (
            <><input type="hidden" name="update_check_present" value="1" /><label class="inl"><input type="checkbox" name="update_check" value="on" checked={p.updateCheckOn} /> Check npm daily for a newer version</label></>
          ) : (
            <p class="hint">Turned off with SMB_UPDATE_CHECK=off in the environment.</p>
          )}
          <p class="hint">Separate from usage counts: it only asks the npm registry which version is latest.</p>
        </div>
        <p><button type="submit" class="btn pri">Save settings</button></p>
      </form>

      <McpCard {...p.mcp} csrf={p.csrf} />

      <div class="card">
        <h2>Access</h2>
        <p>The UI is bound to <code>{p.bind}</code>. With the shipped Compose file it stays on the host's loopback; reach it over an SSH tunnel. If you must expose it, put a password in front — see <a href="/docs/configuration#exposing-the-ui">Configuration → Exposing the UI</a>.</p>
      </div>

      <div class="card">
        <h2>Export and delete</h2>
        <p><a class="btn" href="/api/export">Export all data (zip)</a> <span class="hint">One CSV of click records per site plus sites.csv.</span></p>
        {p.sites.length ? (
          <div class="tbl" style="margin-top:12px">
            <table>
              <thead><tr><th>Site</th><th></th></tr></thead>
              <tbody>
                {p.sites.map((s) => (
                  <tr>
                    <td class="wrap">{s.name} <span class="hint mono">{displayHost(s.host)}</span></td>
                    <td style="white-space:nowrap">
                      <form method="post" action={`/api/sites/${s.id}/delete-data`} style="display:inline" data-confirm={`Delete all click records, uploads and analyses for ${s.name}? The site and its key stay.`}>
                        <Csrf token={p.csrf} /><button type="submit" class="btn sm">Delete site data</button>
                      </form>{' '}
                      <form method="post" action={`/api/sites/${s.id}/delete`} style="display:inline" data-confirm={`Delete ${s.name} and everything recorded for it? The tag on the site will keep posting, but nothing will be stored.`}>
                        <Csrf token={p.csrf} /><button type="submit" class="btn sm danger">Delete site</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div class="card tight">
        <h2>Counters</h2>
        <table>
          <tbody>
            {p.counters.map((c) => <tr><td class="mono">{c.key}</td><td class="num">{n(c.value)}</td><td class="hint">{c.what}</td></tr>)}
          </tbody>
        </table>
      </div>
      <script nonce={p.nonce} dangerouslySetInnerHTML={{ __html: js }} />
    </Layout>
  );
}

function McpCard(m: SettingsProps['mcp'] & { csrf: string }) {
  const endpoint = m.publicEndpoint ?? m.localEndpoint;
  const tok = m.token ?? '<your token>';
  const claudeCode = `claude mcp add --transport http savemybudget ${endpoint} --header "Authorization: Bearer ${tok}"`;
  const cursor = JSON.stringify({ mcpServers: { savemybudget: { url: endpoint, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2);
  const desktop = JSON.stringify({ mcpServers: { savemybudget: { command: 'npx', args: ['-y', 'mcp-remote', endpoint, '--header', 'Authorization:${AUTH_HEADER}'], env: { AUTH_HEADER: `Bearer ${tok}` } } } }, null, 2);
  return (
    <div class="card" id="ai-assistants">
      <h2>AI assistants</h2>
      <p>Let Claude Code, Claude Desktop, Cursor or another MCP client read this toolkit's sites, flagged clicks and rules, check CRM leads against clicks, and prepare claim packages. Nothing it does changes anything in Google Ads, and nothing is filed for you.</p>
      {m.notice ? <div class="note amber"><div>{m.notice}</div></div> : null}
      {m.source === null ? (
        <>
          <p><b>Turned off.</b> <code>/mcp</code> answers 404 until you create a token.</p>
          <form method="post" action="/api/mcp/enable"><Csrf token={m.csrf} /><button type="submit" class="btn pri">Turn on and create a token</button></form>
        </>
      ) : (
        <>
          <p><b>Turned on</b> — {m.source === 'env' ? <>token set by <code>SMB_MCP_TOKEN</code> in the environment.</> : 'token created here.'} The token gives an assistant everything this page's UI shows; keep it secret.</p>
          {m.token ? (
            <div class="note green"><div>
              <p><b>Your token — copy it now, it won't be shown again.</b></p>
              <div class="copybox"><pre><code id="mcp-token">{m.token}</code></pre><button type="button" class="btn sm" data-copy="mcp-token">Copy</button></div>
            </div></div>
          ) : null}
          {m.source === 'settings' ? (
            <div>
              <form method="post" action="/api/mcp/rotate" style="display:inline" data-confirm="Create a new token? Assistants using the old one stop working until you update them."><Csrf token={m.csrf} /><button type="submit" class="btn sm">New token</button></form>{' '}
              <form method="post" action="/api/mcp/disable" style="display:inline" data-confirm="Turn off AI assistant access? The token stops working and /mcp answers 404."><Csrf token={m.csrf} /><button type="submit" class="btn sm danger">Turn off</button></form>
            </div>
          ) : <p class="hint">To change or remove it, edit <code>SMB_MCP_TOKEN</code> and restart.</p>}
        </>
      )}
      <h3 style="margin-top:14px">Server URL</h3>
      <p><code class="brk">{endpoint}</code></p>
      <p class="hint">{m.publicEndpoint ? <>The shipped Caddyfile forwards <code>/mcp</code> on your tag subdomain. On this machine you can also use <code>{m.localEndpoint}</code>.</> : <>Set the public URL above to reach it from other machines; the shipped Caddyfile forwards <code>/mcp</code>.</>}</p>
      <h3 style="margin-top:14px">Connect</h3>
      <details class="sw"><summary>Claude Code</summary>
        <div class="copybox"><pre><code id="mcp-cc">{claudeCode}</code></pre><button type="button" class="btn sm" data-copy="mcp-cc">Copy</button></div>
      </details>
      <details class="sw"><summary>Cursor (~/.cursor/mcp.json)</summary>
        <div class="copybox"><pre><code id="mcp-cursor">{cursor}</code></pre><button type="button" class="btn sm" data-copy="mcp-cursor">Copy</button></div>
      </details>
      <details class="sw"><summary>Claude Desktop (claude_desktop_config.json, through mcp-remote)</summary>
        <div class="copybox"><pre><code id="mcp-desktop">{desktop}</code></pre><button type="button" class="btn sm" data-copy="mcp-desktop">Copy</button></div>
        <p class="hint">Needs Node.js on that computer. Custom connectors added in claude.ai can't send a fixed token on most plans, so Claude Desktop connects through this small local bridge.</p>
      </details>
      <p class="hint" style="margin-top:10px">What it can do, and every tool: <a href="/docs/ai-assistants">AI assistants</a>.</p>
    </div>
  );
}
