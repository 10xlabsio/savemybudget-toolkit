import { Layout, Kpi, RuleChip, Csrf } from './layout.js';
import { perDayChart } from './svg.js';
import { config, TERMS_SENTENCE } from '../config.js';
import { RULES } from '../rules/index.js';
import { fmtTime, n, pct } from '../ui.js';
import type { Notification } from '../jobs/index.js';
import type { AnalysisSummary, Site } from '../types.js';

export interface PackageRow { id: number; rows: number; created_at: string; range_from: string; range_to: string; analysis_id: number }
export interface AnalysisListRow { id: number; range_from: string; range_to: string; ran_at: string; flag: number; total: number }

export interface AnalyseProps {
  nonce: string; csrf: string; sites: Site[]; site: Site; notifications: Notification[];
  from: string; to: string; today: string;
  windowMsg: { message?: string; warning?: string } | null;
  error?: string | null;
  analysis: { id: number; summary: AnalysisSummary } | null;
  analyses: AnalysisListRow[];
  packages: PackageRow[];
  justBuilt?: number | null;
}

export function AnalysePage(p: AnalyseProps) {
  const a = p.analysis;
  const s = a?.summary;
  const rulesFired = s ? RULES.map((r) => ({ r, count: s.rules[r.id] ?? 0 })).filter((x) => x.count > 0).sort((x, y) => y.count - x.count) : [];
  return (
    <Layout title={`Analyse — ${p.site.name}`} nonce={p.nonce} sites={p.sites} active={p.site} notifications={p.notifications} section="sites">
      <h1>Analyse — {p.site.name}</h1>
      <p class="sub">Run the rules over a window, look at what they marked, then build the package for the request.</p>

      {p.error ? <div class="note red"><div>{p.error}</div></div> : null}

      <div class="card">
        <form method="post" action={`/api/sites/${p.site.id}/analyses`}>
          <Csrf token={p.csrf} />
          <div class="row" style="align-items:flex-end">
            <div style="flex:1;min-width:140px"><label for="from">From</label><input type="date" id="from" name="from" value={p.from} max={p.today} required /></div>
            <div style="flex:1;min-width:140px"><label for="to">To</label><input type="date" id="to" name="to" value={p.to} max={p.today} required /></div>
            <button type="submit" class="btn pri">Run analysis</button>
          </div>
          {p.windowMsg?.message ? <p class="note red" style="margin-top:10px"><span>{p.windowMsg.message}</span></p> : null}
          {p.windowMsg?.warning ? <p class="note amber" style="margin-top:10px"><span>{p.windowMsg.warning}</span></p> : null}
          <p class="hint">Google accepts requests for clicks in roughly the last {config.claimWindowDays} days. Test clicks are always left out.</p>
        </form>
        {p.analyses.length ? (
          <p class="hint" style="margin-top:10px">Earlier runs: {p.analyses.slice(0, 8).map((x, i) => (
            <>{i ? ' · ' : ''}<a href={`/sites/${p.site.id}/analyse?analysis=${x.id}`}>{x.range_from} → {x.range_to}</a> ({x.flag}/{x.total})</>
          ))}</p>
        ) : null}
      </div>

      {a && s ? (
        <>
          <div class="card">
            <h2>Results · {s.range_from} → {s.range_to}</h2>
            <p class="hint">Ran {fmtTime(s.ran_at)}. Sources: {s.counts.sources.beacon} beacon · {s.counts.sources.log} log · {s.counts.sources.csv} csv.</p>
            <div class="grid4">
              <Kpi label="Clicks in window" value={n(s.counts.total)} />
              <Kpi label="Flagged" value={n(s.counts.flag)} meta={pct(s.counts.flag, s.counts.total)} />
              <Kpi label="Watch" value={n(s.counts.watch)} meta="some signals, not enough" />
              <Kpi label="Allow" value={n(s.counts.allow)} meta="nothing observed" />
            </div>
            <h3>Rules that fired</h3>
            {rulesFired.length === 0 ? <p class="hint">No rule fired on any click in this window.</p> : (
              <ul class="plain">
                {rulesFired.map(({ r, count }) => (
                  <li><RuleChip id={r.id} /> <b>{n(count)}</b> <span class="hint">{r.describe}</span></li>
                ))}
              </ul>
            )}
            {s.notes.length ? (
              <>
                <h3 style="margin-top:14px">Notes</h3>
                <ul class="steps">{s.notes.map((x) => <li>{x}</li>)}</ul>
              </>
            ) : null}
            <div class="grid2" style="margin-top:14px">
              <div>
                <h3>Top networks among flagged</h3>
                {s.top_asns.length === 0 ? <p class="hint">None.</p> : (
                  <table><tbody>{s.top_asns.map((x) => <tr><td>{x.asn !== null ? `AS${x.asn}` : 'unknown'} {x.asn_name ? <span class="hint">{x.asn_name}</span> : null}</td><td class="num">{x.count}</td></tr>)}</tbody></table>
                )}
              </div>
              <div>
                <h3>Top /24 ranges among flagged</h3>
                {s.top_subnets.length === 0 ? <p class="hint">None.</p> : (
                  <table><tbody>{s.top_subnets.map((x) => <tr><td class="mono">{x.subnet}</td><td class="num">{x.count}</td></tr>)}</tbody></table>
                )}
              </div>
            </div>
            <h3 style="margin-top:14px">Per day</h3>
            <div dangerouslySetInnerHTML={{ __html: perDayChart(s.per_day, { label: 'Clicks and flagged clicks per day' }) }} />
            <p class="hint">Flagged is what the rules marked. Google decides what is invalid and what, if anything, is credited.</p>
          </div>

          <div class="card">
            <h2>Build the claim package</h2>
            <p class="hint">A zip with evidence.csv, summary.md, form-answers.md and report.json. Nothing leaves your server.</p>
            <form method="post" action={`/api/analyses/${a.id}/package`}>
              <Csrf token={p.csrf} />
              <label class="inl"><input type="checkbox" name="include_watch" value="1" /> Include watch rows (weaker signals; usually leave out)</label>
              <label class="inl"><input type="checkbox" name="exclusions" value="1" checked /> Include exclusions.txt (flagged IPs, for campaign IP exclusions if you choose)</label>
              <p><button type="submit" class="btn pri" disabled={s.counts.flag === 0 && s.counts.watch === 0}>Build package</button>
                {s.counts.flag === 0 ? <span class="hint" style="margin-left:10px">Nothing flagged in this window, so there is nothing to package.</span> : null}</p>
            </form>
          </div>
        </>
      ) : (
        <div class="card empty">Pick a window and run the analysis. Results appear here.</div>
      )}

      {p.packages.length ? (
        <div class="card tight tbl">
          <h2>Packages</h2>
          {p.justBuilt ? <div class="note green"><div>Package built. <a href={`/api/packages/${p.justBuilt}/download`}>Download it →</a></div></div> : null}
          <table>
            <thead><tr><th>Built</th><th>Window</th><th class="num">Rows</th><th></th></tr></thead>
            <tbody>
              {p.packages.map((k) => (
                <tr>
                  <td>{fmtTime(k.created_at)}</td>
                  <td class="mono">{k.range_from} → {k.range_to}</td>
                  <td class="num">{n(k.rows)}</td>
                  <td style="white-space:nowrap">
                    <a class="btn sm" href={`/api/packages/${k.id}/download`}>Download</a>{' '}
                    <form method="post" action={`/api/packages/${k.id}/delete`} style="display:inline"><Csrf token={p.csrf} /><button type="submit" class="btn sm danger">Delete</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div class="card">
        <h2>Filing the request</h2>
        <p>The toolkit builds the package. You submit it through <a href={config.googleFormUrl} target="_blank" rel="noopener">Google's invalid-clicks form</a>, signed in with an account that has access to the Google Ads account.</p>
        <h3>What Google's form asks for</h3>
        <div class="tbl">
          <table>
            <thead><tr><th>Item</th><th>Where it is</th></tr></thead>
            <tbody>
              <tr><td>Customer ID</td><td>Top of Google Ads, ten digits. Not in the package — enter it yourself.</td></tr>
              <tr><td>Date range</td><td><code>summary.md</code>, first line.</td></tr>
              <tr><td>Campaigns, ad groups, keywords</td><td>Your Google Ads account. Narrow it to where the pattern showed.</td></tr>
              <tr><td>IP addresses</td><td><code>evidence.csv</code>; the top networks and /24 ranges are listed in <code>summary.md</code>.</td></tr>
              <tr><td>Devices and browsers</td><td><code>evidence.csv</code>, <code>user_agent</code> column.</td></tr>
              <tr><td>GCLIDs</td><td><code>evidence.csv</code>, <code>gclid</code> column.</td></tr>
              <tr><td>Summary of the issue</td><td><code>summary.md</code>. Keep it short; the attachment carries the detail.</td></tr>
              <tr><td>Attachment</td><td><code>evidence.csv</code>.</td></tr>
            </tbody>
          </table>
        </div>
        <p style="margin-top:12px">The form also asks four yes/no questions: whether you changed targeting, had ads approved, raised budgets or bids, or already checked invalid clicks recently. They exist so Google can rule out benign causes for a spike. Answer them accurately from your own account history; the toolkit doesn't know.</p>
        <p>Google reviews the request and decides what is invalid; it usually replies by email within days.</p>
        <h3>What weakens a request</h3>
        <ul class="steps">
          <li>A feeling that traffic is off, with no records behind it.</li>
          <li>Low conversions or poor return on their own — those aren't invalid activity.</li>
          <li>Clicks outside the {config.claimWindowDays}-day window.</li>
          <li>Clicks Google has already credited.</li>
          <li>Many unrelated patterns mixed into one request.</li>
          <li>Accusatory wording. It doesn't add evidence.</li>
        </ul>
        <p class="hint">More in <a href="/docs/filing-a-claim">Filing a claim</a>.</p>
      </div>

      <p class="hint">Want this reviewed and filed for you? The managed version at <a href={config.hostedUrl} target="_blank" rel="noopener">savemybudget.io</a> prepares and files claims on a no-win-no-fee basis — {TERMS_SENTENCE}</p>
    </Layout>
  );
}
