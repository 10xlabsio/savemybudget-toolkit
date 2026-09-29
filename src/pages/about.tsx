import { Layout } from './layout.js';
import { config, CREDIT } from '../config.js';
import { RULES } from '../rules/index.js';
import { SDK_BUILD } from './install.js';
import type { Notification } from '../jobs/index.js';
import type { Site } from '../types.js';

export function AboutPage(p: { nonce: string; sites: Site[]; notifications: Notification[]; asnSnapshot: string | null }) {
  return (
    <Layout title="About" nonce={p.nonce} sites={p.sites} notifications={p.notifications} section="about">
      <h1>About</h1>
      <p class="sub">Self-hosted evidence collection for Google Ads invalid-click requests.</p>
      <div class="grid2">
        <div class="card">
          <h2>Versions</h2>
          <table><tbody>
            <tr><td>Toolkit</td><td class="mono">{config.version}</td></tr>
            <tr><td>SDK</td><td class="mono">{SDK_BUILD.sdk_version}</td></tr>
            <tr><td>SDK build</td><td class="mono">{SDK_BUILD.build}</td></tr>
            <tr><td>SDK SRI</td><td class="mono" style="word-break:break-all">{SDK_BUILD.sri}</td></tr>
            <tr><td>Node</td><td class="mono">{process.version}</td></tr>
          </tbody></table>
        </div>
        <div class="card">
          <h2>Rules</h2>
          <ul class="plain">{RULES.map((r) => <li><span class={`chip${r.kind === 'hard' ? ' hard' : ''}`}>{r.kind}</span> <a href={`/docs/rules`}>{r.title}</a></li>)}</ul>
        </div>
      </div>
      <div class="card">
        <h2>Licence and credit</h2>
        <p>Apache-2.0. {CREDIT}</p>
        <p>
          <a href="https://github.com/10xlabsio/savemybudget-toolkit" target="_blank" rel="noopener">GitHub</a> · <a href="/docs/getting-started">Docs</a> · <a href={config.hostedUrl} target="_blank" rel="noopener">savemybudget.io</a>
        </p>
      </div>
      <div class="card">
        <h2>Third-party notices</h2>
        <ul class="plain">
          <li>IP-to-ASN data: <a href="https://iptoasn.com" target="_blank" rel="noopener">iptoasn.com</a> snapshot{p.asnSnapshot ? <> — {p.asnSnapshot}</> : null} (PDDL).</li>
          <li><a href="https://hono.dev" target="_blank" rel="noopener">Hono</a> (MIT).</li>
        </ul>
      </div>
    </Layout>
  );
}
