import type { Child } from 'hono/jsx';
import { config } from '../config.js';
import { siteHealth, type Health } from '../db.js';
import { silentThresholdHours, type Notification } from '../jobs/index.js';
import { RULES } from '../rules/index.js';
import type { Site } from '../types.js';
import { relTime, fmtDay, n } from '../ui.js';

export const CSS = `
:root{--bg:#f6f6f8;--panel:#fff;--ink:#1B1B2F;--muted:#5d5c72;--line:#e3e2ea;--brand:#7A9A12;--brandname:#1B1B2F;--lav:#ece9f7;--lav-ink:#4a4470;
--red:#b3261e;--red-bg:#fbeae9;--amber:#8a5a00;--amber-bg:#fff3d6;--green:#1e7b3c;--green-bg:#e3f4e8;--info:#2b4d8f;--info-bg:#e6edfb;--grey:#8b8a99;--grey-bg:#eeeef2;
--chart:#7A9A12;--chart-flag:#b3261e;--code:#f0f0f4;--focus:#2b4d8f}
@media (prefers-color-scheme:dark){:root{--bg:#141420;--panel:#1c1c2b;--ink:#ecebf3;--muted:#a8a7bb;--line:#31314a;--brand:#C8E64C;--brandname:#C9C7D9;--lav:#2b2a44;--lav-ink:#cfcbe8;
--red:#ff8a80;--red-bg:#3a1f1f;--amber:#ffcc66;--amber-bg:#3a2e12;--green:#7ed99a;--green-bg:#17301f;--info:#9dbcff;--info-bg:#1b2740;--grey:#8b8a99;--grey-bg:#262637;
--chart:#C8E64C;--chart-flag:#ff8a80;--code:#0f0f19;--focus:#9dbcff}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--info)}a:hover{text-decoration:underline}
code,pre,kbd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-all}
code{background:var(--code);padding:1px 4px;border-radius:4px}pre code{background:none;padding:0}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0 0 10px}h3{font-size:15px;margin:0 0 6px}
.sub{color:var(--muted);margin:0 0 18px}
.top{background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.top .in{max-width:1080px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.wm{text-decoration:none;font-size:17px;letter-spacing:-.01em;white-space:nowrap}.wm b{color:var(--brand);font-weight:800}.wm span{color:var(--brandname)}.wm small{color:var(--muted);font-size:12px;margin-left:5px}
.top nav{margin-left:auto;display:flex;gap:14px}.top nav a{color:var(--muted);text-decoration:none;font-size:14px}.top nav a.on,.top nav a:hover{color:var(--ink)}
.sw{position:relative}.sw summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:8px;padding:5px 10px;background:var(--bg);font-size:14px;max-width:60vw}
.sw summary::-webkit-details-marker{display:none}.sw summary::after{content:"▾";color:var(--muted);font-size:11px}
.sw summary .h{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw .menu{position:absolute;left:0;top:calc(100% + 6px);min-width:260px;max-width:90vw;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:6px;z-index:10}
.sw .menu a{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;text-decoration:none;color:var(--ink);font-size:14px}.sw .menu a:hover{background:var(--bg)}
.sw .menu a small{color:var(--muted);margin-left:auto;font-size:12px}.sw .menu hr{border:0;border-top:1px solid var(--line);margin:6px 0}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none}.dot.green{background:#2fa35a}.dot.amber{background:#e0a100}.dot.grey{background:var(--grey)}
main{max-width:1080px;margin:0 auto;padding:22px 16px 60px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
.card.tight{padding:12px 14px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.kpi .l{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.kpi .v{font-size:22px;font-weight:800;line-height:1.2;margin:4px 0 2px}.kpi .m{font-size:12px;color:var(--muted)}
.chip{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--lav);color:var(--lav-ink);margin:1px 2px 1px 0;white-space:nowrap}.chip.hard{background:var(--red-bg);color:var(--red)}
.chip.ok{background:var(--green-bg);color:var(--green)}.chip.warn{background:var(--amber-bg);color:var(--amber)}.chip.grey{background:var(--grey-bg);color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}.tbl{overflow-x:auto}
.btn{display:inline-block;border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:7px 14px;border-radius:8px;font:inherit;font-size:14px;cursor:pointer;text-decoration:none;line-height:1.3}
.btn:hover{border-color:var(--muted);text-decoration:none}.btn.pri{background:var(--ink);color:var(--bg);border-color:var(--ink)}
@media (prefers-color-scheme:dark){.btn.pri{background:var(--brand);color:#1B1B2F;border-color:var(--brand)}}
.btn.danger{color:var(--red);border-color:var(--red)}.btn.sm{padding:4px 10px;font-size:13px}.btn:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.right{margin-left:auto}
label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}label.inl{display:inline-flex;align-items:center;gap:8px;font-weight:400;margin:6px 0}
input[type=text],input[type=url],input[type=date],input[type=number],input[type=file],select,textarea{width:100%;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
input:focus,select:focus,textarea:focus,button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
select[multiple]{height:180px}.hint{font-size:13px;color:var(--muted);margin:4px 0 0}
.note{border-radius:10px;padding:12px 14px;margin-bottom:12px;font-size:14px;display:flex;gap:10px;align-items:flex-start}
.note.amber{background:var(--amber-bg);color:var(--amber)}.note.green{background:var(--green-bg);color:var(--green)}.note.grey{background:var(--grey-bg);color:var(--muted)}
.note.info{background:var(--info-bg);color:var(--info)}.note.red{background:var(--red-bg);color:var(--red)}.note a{color:inherit;font-weight:600}
.note .x{margin-left:auto;background:none;border:0;color:inherit;cursor:pointer;font-size:16px;line-height:1;padding:0 2px}.note.hide{display:none}
.pills{display:flex;gap:6px;flex-wrap:wrap}.pill{border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:6px 12px;border-radius:999px;font:inherit;font-size:14px;cursor:pointer}
.pill.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
@media (prefers-color-scheme:dark){.pill.on{background:var(--lav);color:var(--lav-ink);border-color:var(--lav)}}
.pillsel{display:none}
.empty{text-align:center;color:var(--muted);padding:40px 10px}
.steps{padding-left:22px}.steps li{margin:6px 0}
.svgchart{width:100%;height:auto;display:block}
.range a{padding:4px 10px;border-radius:999px;text-decoration:none;color:var(--muted);font-size:14px}.range a.on{background:var(--lav);color:var(--lav-ink)}
.ipcol{display:none}.showip .ipcol{display:table-cell}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
.copybox{position:relative}.copybox .btn{position:absolute;right:8px;top:8px}
.foot{color:var(--muted);font-size:13px;margin-top:30px;border-top:1px solid var(--line);padding-top:14px}
ul.plain{list-style:none;padding:0;margin:0}ul.plain li{padding:6px 0;border-bottom:1px solid var(--line)}ul.plain li:last-child{border:0}
.md h1{font-size:24px;margin:0 0 12px}.md h2{margin:24px 0 8px;font-size:18px}.md h3{margin:18px 0 6px}.md p{margin:0 0 12px}.md table{margin:0 0 14px}.md blockquote{border-left:3px solid var(--line);margin:0 0 12px;padding:2px 12px;color:var(--muted)}
@media (max-width:760px){.grid4{grid-template-columns:1fr 1fr}.grid2{grid-template-columns:1fr}main{padding:16px 16px 50px}.top .in{gap:10px}.top nav{gap:10px}
.pills{display:none}.pillsel{display:block}.card{padding:14px}th,td{padding:7px 6px}}
@media (max-width:460px){.grid4{grid-template-columns:1fr}}
`;

export interface LayoutProps {
  title: string;
  nonce: string;
  active?: Site | null;
  sites: Site[];
  notifications?: Notification[];
  section?: 'sites' | 'settings' | 'about' | 'docs';
  children?: Child;
}

export function healthOf(s: Site | null | undefined): Health {
  return siteHealth(s ?? null, silentThresholdHours());
}

export const Dot = ({ h }: { h: Health }) => <span class={`dot ${h}`} title={h === 'green' ? 'Sending data' : h === 'amber' ? 'Silent' : 'No data yet'} />;

export function Layout(p: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>{p.title} · SaveMyBudget Toolkit</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <header class="top">
          <div class="in">
            <a class="wm" href="/sites"><b>$ave</b><span>MyBudget</span><small>Toolkit</small></a>
            <Switcher sites={p.sites} active={p.active ?? null} />
            <nav>
              <a href="/sites" class={p.section === 'sites' ? 'on' : ''}>Sites</a>
              <a href="/settings" class={p.section === 'settings' ? 'on' : ''}>Settings</a>
              <a href="/docs/getting-started" class={p.section === 'docs' ? 'on' : ''}>Docs</a>
              <a href="/about" class={p.section === 'about' ? 'on' : ''}>About</a>
            </nav>
          </div>
        </header>
        <main>
          {p.notifications && p.notifications.length ? <Notifications items={p.notifications} sites={p.sites} nonce={p.nonce} /> : null}
          {p.children}
          <div class="foot">SaveMyBudget Toolkit {config.version} · <a href="/docs/getting-started">Docs</a> · <a href="/about">About</a></div>
        </main>
      </body>
    </html>
  );
}

function Switcher({ sites, active }: { sites: Site[]; active: Site | null }) {
  return (
    <details class="sw">
      <summary>
        {active ? <Dot h={healthOf(active)} /> : null}
        <span class="h">{active ? active.name : sites.length ? 'Choose a site' : 'No sites yet'}</span>
      </summary>
      <div class="menu">
        {sites.map((s) => (
          <a href={`/sites/${s.id}`}><Dot h={healthOf(s)} /> {s.name} <small>{s.host}</small></a>
        ))}
        {active ? (
          <>
            <hr />
            <a href={`/sites/${active.id}/install`}>Tag &amp; install — {active.name}</a>
          </>
        ) : null}
        <hr />
        <a href="/sites/new">+ Add a site</a>
      </div>
    </details>
  );
}

// ---------- notifications ----------

function notificationCopy(nt: Notification, site: Site | undefined): { tone: string; text: string; link?: { href: string; label: string } } {
  const p = nt.payload as Record<string, any>;
  const name = site?.name ?? 'This site';
  const sid = site?.id ?? nt.site_id;
  switch (nt.kind) {
    case 'tag_silent':
      return { tone: 'amber', text: `${name} hasn't sent data for ${n(Number(p.hours ?? 0))} hours. The usual causes: the GTM trigger, an unpublished container, a theme switch, or a consent banner.`, link: { href: `/sites/${sid}/install`, label: 'Install page' } };
    case 'never_installed':
      return { tone: 'grey', text: `${name} was added but hasn't sent any data yet. The usual causes: the GTM trigger, an unpublished container, or a consent banner.`, link: { href: `/sites/${sid}/install`, label: 'Open install instructions' } };
    case 'first_beacon':
      return { tone: 'green', text: `${name} is live. From now on every ad click is recorded and building your evidence file.` };
    case 'window_reminder':
      return { tone: 'info', text: `Google accepts invalid-click claims for roughly the last ${config.claimWindowDays} days. You have flagged clicks from ${fmtDay(String(p.oldest ?? ''))} that will leave the window on ${fmtDay(String(p.leaves ?? ''))}.`, link: { href: `/sites/${sid}/analyse`, label: 'Analyse' } };
    case 'private_ips':
      return { tone: 'amber', text: 'Most recorded addresses are private — your proxy or CDN is being recorded instead of the visitor. See the docs on proxies.', link: { href: '/docs/inputs', label: 'Inputs' } };
    case 'update_available':
      return { tone: 'info', text: `Version ${p.version ?? ''} is available.`, link: { href: '/docs/getting-started#updating', label: 'How to update' } };
    case 'disk':
      return { tone: 'amber', text: `The data directory is ${n(Number(p.mb ?? 0))} MB. Consider lowering retention in Settings.`, link: { href: '/settings', label: 'Settings' } };
    default:
      return { tone: 'grey', text: String(nt.kind) };
  }
}

export function Notifications({ items, sites, nonce }: { items: Notification[]; sites: Site[]; nonce: string }) {
  const byId = new Map(sites.map((s) => [s.id, s]));
  const js = `document.querySelectorAll('.note .x').forEach(function(b){b.addEventListener('click',function(){var id=b.getAttribute('data-id');var el=b.closest('.note');el.classList.add('hide');fetch('/api/notifications/'+id+'/dismiss',{method:'POST',headers:{'x-csrf':(document.cookie.match(/(?:^|; )smb_csrf=([^;]+)/)||[])[1]||''}}).catch(function(){});});});`;
  return (
    <div>
      {items.map((nt) => {
        const c = notificationCopy(nt, nt.site_id === null ? undefined : byId.get(nt.site_id));
        return (
          <div class={`note ${c.tone}`}>
            <div>
              {c.text} {c.link ? <a href={c.link.href}>{c.link.label} →</a> : null}
            </div>
            <button class="x" data-id={String(nt.id)} title="Dismiss" aria-label="Dismiss">×</button>
          </div>
        );
      })}
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: js }} />
    </div>
  );
}

// ---------- small components ----------

export const Kpi = ({ label, value, meta }: { label: string; value: Child; meta?: Child }) => (
  <div class="kpi">
    <div class="l">{label}</div>
    <div class="v">{value}</div>
    {meta !== undefined ? <div class="m">{meta}</div> : null}
  </div>
);

const RULE_MAP = new Map(RULES.map((r) => [r.id, r]));
export const RuleChip = ({ id, kind }: { id: string; kind?: 'hard' | 'soft' }) => {
  const r = RULE_MAP.get(id);
  const hard = (kind ?? r?.kind) === 'hard';
  return <span class={`chip${hard ? ' hard' : ''}`} title={r?.describe ?? id}>{r?.title ?? id}</span>;
};

export const Csrf = ({ token }: { token: string }) => <input type="hidden" name="_csrf" value={token} />;

export const Rel = ({ iso }: { iso: string | null | undefined }) => <span title={iso ?? ''}>{relTime(iso)}</span>;
