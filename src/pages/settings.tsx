import { Layout, Csrf } from './layout.js';
import { TIMEZONES, displayHost, n } from '../ui.js';
import type { Notification } from '../jobs/index.js';
import type { Site } from '../types.js';

export interface SettingsProps {
  nonce: string; csrf: string; sites: Site[]; notifications: Notification[];
  publicUrl: string; tz: string; retentionDays: number; storeMb: number; silentHours: number;
  telemetryOn: boolean; telemetryEnv: boolean; updateCheckOn: boolean; updateCheckEnv: boolean;
  bind: string; counters: { key: string; value: number; what: string }[];
  saved?: boolean;
  error?: string | null;
}

const THRESHOLDS: [number, string][] = [[12, '12 hours'], [24, '1 day'], [48, '2 days'], [72, '3 days'], [168, '7 days']];

export function SettingsPage(p: SettingsProps) {
  const js = `document.querySelectorAll('form[data-confirm]').forEach(function(f){f.addEventListener('submit',function(e){if(!confirm(f.getAttribute('data-confirm')))e.preventDefault()})});`;
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
