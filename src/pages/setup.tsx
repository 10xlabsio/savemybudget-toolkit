import { Layout, Csrf } from './layout.js';
import { TIMEZONES } from '../ui.js';
import type { Site } from '../types.js';

export interface SetupProps {
  nonce: string; csrf: string; sites: Site[];
  publicUrl: string; tz: string; telemetryOn: boolean; telemetryEnv: boolean;
  saved?: boolean;
}

export function SetupPage(p: SetupProps) {
  const check = `(function(){var b=document.getElementById('chk'),o=document.getElementById('chkout'),u=document.getElementById('public_url');b.addEventListener('click',function(){o.textContent='Checking…';fetch('/api/setup/check?url='+encodeURIComponent(u.value),{headers:{'x-csrf':(document.cookie.match(/(?:^|; )smb_csrf=([^;]+)/)||[])[1]||''}}).then(function(r){return r.json()}).then(function(j){o.textContent=j.ok?'✓ Reachable — the collector answered at '+j.url:'✗ '+j.reason;}).catch(function(){o.textContent='✗ The check could not run.';});});})();`;
  return (
    <Layout title="Set up" nonce={p.nonce} sites={p.sites}>
      <h1>Set up your toolkit</h1>
      <p class="sub">Three things to confirm, then add your first site.</p>
      {p.saved ? <div class="note green">Saved.</div> : null}
      <form method="post" action="/api/settings">
        <Csrf token={p.csrf} />
        <input type="hidden" name="_next" value="/setup?saved=1" />
        <div class="card">
          <h2>1. Public address</h2>
          <p class="hint">The URL your tag posts to. It must be reachable from your visitors' browsers over HTTPS.</p>
          <label for="public_url">Public URL</label>
          <div class="row">
            <input type="url" id="public_url" name="public_url" value={p.publicUrl} placeholder="https://t.yourbrand.com" style="flex:1;min-width:220px" />
            <button type="button" class="btn" id="chk">Check</button>
          </div>
          <p class="hint" id="chkout">{p.publicUrl ? 'Press Check to confirm the collector answers at this address.' : 'Set SMB_PUBLIC_URL in .env, or enter it here.'}</p>
        </div>
        <div class="card">
          <h2>2. Timezone</h2>
          <p class="hint">Used for the times shown in the UI. Evidence files always use UTC.</p>
          <label for="tz">Timezone</label>
          <select id="tz" name="tz">
            {TIMEZONES.map((z) => <option value={z} selected={z === p.tz}>{z}</option>)}
          </select>
        </div>
        <div class="card">
          <h2>3. Anonymous usage counts</h2>
          <p>
            The toolkit sends anonymous usage counts — which pages get used and where installs stall — so the project can improve. It never sends IP addresses, click IDs, hostnames or any row of your data,
            and the tag on your site never contacts SaveMyBudget. Everything sent is listed in <a href="/docs/telemetry">TELEMETRY.md</a>.
          </p>
          {p.telemetryEnv ? (
            <><input type="hidden" name="telemetry_present" value="1" /><label class="inl"><input type="checkbox" name="telemetry" value="on" checked={p.telemetryOn} /> Send anonymous usage counts</label></>
          ) : (
            <p class="hint">Turned off with SMB_TELEMETRY=off in the environment.</p>
          )}
          <p class="hint">You can change this in Settings or with SMB_TELEMETRY=off.</p>
        </div>
        <div class="row">
          <button type="submit" class="btn">Save</button>
          <a class="btn pri" href="/sites/new">Add your first site →</a>
        </div>
      </form>
      <script nonce={p.nonce} dangerouslySetInnerHTML={{ __html: check }} />
    </Layout>
  );
}
