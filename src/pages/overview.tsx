import { Layout, Kpi, RuleChip, Rel } from './layout.js';
import { perDayChart, type DayPoint } from './svg.js';
import { fmtTime, n, pct } from '../ui.js';
import type { Notification } from '../jobs/index.js';
import type { AnalysisSummary, ScoredEvent, Site } from '../types.js';

export type Range = '24h' | '7d' | '30d';

export interface OverviewProps {
  nonce: string; sites: Site[]; site: Site; notifications: Notification[];
  range: Range;
  clicks: number; sessions: number;
  analysis: { id: number; summary: AnalysisSummary; flagged: ScoredEvent[]; watch: number } | null;
  perDay: DayPoint[];
}

export function networkLabel(e: ScoredEvent['event']): string {
  if (e.ip_private) return 'Private range';
  const name = e.asn_name ?? (e.asn !== null ? `AS${e.asn}` : 'Unknown network');
  return e.is_hosting ? `Hosting: ${name}` : name;
}

export function OverviewPage(p: OverviewProps) {
  const a = p.analysis;
  const js = `(function(){var c=document.getElementById('showip');if(!c)return;c.addEventListener('change',function(){document.getElementById('flagtbl').classList.toggle('showip',c.checked)})})();`;
  const rangeLabel = p.range === '24h' ? 'last 24 hours' : p.range === '7d' ? 'last 7 days' : 'last 30 days';
  return (
    <Layout title={p.site.name} nonce={p.nonce} sites={p.sites} active={p.site} notifications={p.notifications} section="sites">
      <div class="row" style="margin-bottom:14px">
        <div>
          <h1>{p.site.name}</h1>
          <p class="sub" style="margin:0"><span class="mono">{p.site.host}</span> · last beacon <Rel iso={p.site.last_seen_at} /></p>
        </div>
        <div class="range right row" style="gap:2px">
          {(['24h', '7d', '30d'] as Range[]).map((r) => <a href={`/sites/${p.site.id}?range=${r}`} class={r === p.range ? 'on' : ''}>{r}</a>)}
        </div>
      </div>

      <div class="grid4">
        <Kpi label="Ad clicks recorded" value={n(p.clicks)} meta={rangeLabel} />
        <Kpi label="Sessions with a click ID" value={n(p.sessions)} meta="distinct click IDs" />
        {a ? (
          <Kpi label="Flagged" value={<>{n(a.summary.counts.flag)} <small style="font-size:14px;font-weight:600;color:var(--muted)">{pct(a.summary.counts.flag, a.summary.counts.total)}</small></>} meta={`analysis ${a.summary.range_from} → ${a.summary.range_to}`} />
        ) : (
          <Kpi label="Flagged" value={<a href={`/sites/${p.site.id}/analyse`} style="font-size:15px">Run an analysis</a>} meta="no analysis covers this range yet" />
        )}
        <Kpi label="Watch" value={a ? n(a.watch) : '—'} meta={a ? 'some signals, not enough to flag' : 'needs an analysis'} />
      </div>

      <div class="card">
        <div class="row" style="margin-bottom:6px"><h2>Clicks per day</h2><span class="hint right"><span class="chip">clicks</span><span class="chip hard">flagged</span></span></div>
        <div dangerouslySetInnerHTML={{ __html: perDayChart(p.perDay, { label: `Clicks per day, ${rangeLabel}` }) }} />
        {!a ? <p class="hint">The flagged overlay appears once an analysis covers this range.</p> : null}
      </div>

      <div class="card">
        <div class="row" style="margin-bottom:8px">
          <h2 style="margin:0">Flagged clicks</h2>
          {a ? <label class="inl right" style="margin:0"><input type="checkbox" id="showip" /> Show IP addresses</label> : null}
        </div>
        {!a ? (
          <p class="hint">No analysis covers this range yet. <a href={`/sites/${p.site.id}/analyse`}>Run one</a> to see which clicks the rules mark.</p>
        ) : a.flagged.length === 0 ? (
          <p class="hint">The latest analysis marked no clicks as flagged in this window. That is a normal outcome.</p>
        ) : (
          <div class="tbl">
            <table id="flagtbl">
              <thead><tr><th>Time</th><th>Source</th><th>Network</th><th class="ipcol">IP</th><th>Rules</th><th>Click ID</th></tr></thead>
              <tbody>
                {a.flagged.slice(0, 200).map((s) => (
                  <tr>
                    <td style="white-space:nowrap" title={s.event.ts}>{fmtTime(s.event.ts)}</td>
                    <td>{s.event.source}</td>
                    <td>{networkLabel(s.event)}</td>
                    <td class="ipcol mono">{s.event.ip}</td>
                    <td>{s.hits.map((h) => <RuleChip id={h.rule} kind={h.kind} />)}</td>
                    <td class="mono" title={s.event.gclid}>{s.event.gclid.slice(0, 12)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {a.flagged.length > 200 ? <p class="hint">Showing the first 200 of {n(a.flagged.length)}. The full list is in the claim package.</p> : null}
            <p class="hint">Flagged means the rules saw a pattern worth reporting. Google decides what counts as invalid and what is credited.</p>
          </div>
        )}
      </div>
      <script nonce={p.nonce} dangerouslySetInnerHTML={{ __html: js }} />
    </Layout>
  );
}
