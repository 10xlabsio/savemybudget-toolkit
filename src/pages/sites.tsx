import { Layout, Dot, healthOf, Rel, Csrf } from './layout.js';
import { COUNTRIES, displayHost } from '../ui.js';
import type { Notification } from '../jobs/index.js';
import type { Site } from '../types.js';

export interface SiteRow { site: Site; beacons24h: number; flagged7d: number | null }

export function SitesPage(p: { nonce: string; sites: Site[]; rows: SiteRow[]; notifications: Notification[] }) {
  return (
    <Layout title="Sites" nonce={p.nonce} sites={p.sites} notifications={p.notifications} section="sites">
      <div class="row" style="margin-bottom:14px">
        <h1>Sites</h1>
        <a class="btn pri right" href="/sites/new">+ Add a site</a>
      </div>
      {p.rows.length === 0 ? (
        <div class="card empty">
          <p>No sites yet. Add the site your ads land on, then install the tag.</p>
          <a class="btn pri" href="/sites/new">Add a site</a>
        </div>
      ) : (
        <div class="card tight tbl">
          <table>
            <thead>
              <tr><th>Site</th><th>Host</th><th>Health</th><th>Last beacon</th><th class="num">Beacons 24h</th><th class="num">Flagged 7d</th><th></th></tr>
            </thead>
            <tbody>
              {p.rows.map(({ site, beacons24h, flagged7d }) => (
                <tr>
                  <td class="wrap"><a href={`/sites/${site.id}`}>{site.name}</a></td>
                  <td class="mono wrap">{displayHost(site.host)}</td>
                  <td><Dot h={healthOf(site)} /> {healthLabel(site)}</td>
                  <td><Rel iso={site.last_seen_at} /></td>
                  <td class="num">{beacons24h}</td>
                  <td class="num">{flagged7d === null ? '—' : flagged7d}</td>
                  <td style="white-space:nowrap">
                    <a class="btn sm" href={`/sites/${site.id}/install`}>Install</a>{' '}
                    <a class="btn sm" href={`/sites/${site.id}`}>Overview</a>{' '}
                    <a class="btn sm" href={`/sites/${site.id}/analyse`}>Analyse</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
}

function healthLabel(s: Site): string {
  const h = healthOf(s);
  return h === 'green' ? 'Sending' : h === 'amber' ? 'Silent' : 'No data yet';
}

export interface SiteFormProps {
  nonce: string; csrf: string; sites: Site[];
  site?: Site | null;
  values: { name: string; host: string; consent_mode: string; target_countries: string[] };
  error?: string | null;
}

export function SiteFormPage(p: SiteFormProps) {
  const editing = !!p.site;
  const v = p.values;
  return (
    <Layout title={editing ? `Edit ${p.site!.name}` : 'Add a site'} nonce={p.nonce} sites={p.sites} active={p.site ?? null} section="sites">
      <h1>{editing ? 'Edit site' : 'Add a site'}</h1>
      <p class="sub">{editing ? 'The site key stays the same; the tag keeps working.' : 'One site per hostname your ads land on.'}</p>
      {p.error ? <div class="note red">{p.error}</div> : null}
      <form method="post" action={editing ? `/api/sites/${p.site!.id}` : '/api/sites'} class="card">
        <Csrf token={p.csrf} />
        <label for="name">Name</label>
        <input type="text" id="name" name="name" value={v.name} required maxlength={60} placeholder="Acme Shoes" />
        <label for="host">Hostname</label>
        <input type="text" id="host" name="host" value={displayHost(v.host)} required maxlength={253} placeholder="shop.yourbrand.com" inputmode="url" autocapitalize="off" spellcheck={false} />
        <p class="hint">Just the hostname, without https:// or a path. Accented names (münchen-shop.de) are fine; they are stored in their DNS (punycode) form.</p>
        <label for="target_countries">Targeting countries</label>
        <select id="target_countries" name="target_countries" multiple>
          {COUNTRIES.map(([code, name]) => <option value={code} selected={v.target_countries.includes(code)}>{name} ({code})</option>)}
        </select>
        <p class="hint">Only used by the geo rule: clicks from outside these countries get a mark. Leave empty to skip that rule.</p>
        <label>Consent mode</label>
        <label class="inl"><input type="radio" name="consent_mode" value="legitimate_interest" checked={v.consent_mode !== 'consent_gated'} /> Legitimate interest — collect on every page load</label>
        <label class="inl"><input type="radio" name="consent_mode" value="consent_gated" checked={v.consent_mode === 'consent_gated'} /> Consent-gated — collect after consent</label>
        <p class="hint">Pick the one that matches your privacy policy. <a href="/docs/privacy">Read the privacy notes.</a></p>
        <div class="row" style="margin-top:18px">
          <button type="submit" class="btn pri">{editing ? 'Save changes' : 'Add site'}</button>
          <a class="btn" href={editing ? `/sites/${p.site!.id}` : '/sites'}>Cancel</a>
        </div>
      </form>
    </Layout>
  );
}
