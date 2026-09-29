// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { readFileSync } from 'node:fs';
import { Layout } from './layout.js';
import { config } from '../config.js';
import { escJson } from '../ui.js';
import type { Site } from '../types.js';

const STUB = readFileSync(new URL('../sdk/stub.js', import.meta.url), 'utf8').trim();
export const SDK_BUILD = JSON.parse(readFileSync(new URL('../sdk/smb.build.json', import.meta.url), 'utf8')) as {
  sdk_version: string; sdk_commit: string; build: string; sri: string; built_at: string;
};

export function snippetFor(site: Site, publicUrl: string): string {
  const base = publicUrl.replace(/\/+$/, '');
  return `<script>window.__smbSdkUrl='${base}/sdk/v1/smb.js';${STUB}smb('init',{c:'${site.key}',e:'${base}'});</script>`;
}

export type Platform = 'gtm' | 'shopify' | 'wordpress' | 'webflow' | 'wix' | 'squarespace' | 'custom';
export const PLATFORMS: { id: Platform; label: string; steps: string[] }[] = [
  { id: 'gtm', label: 'Google Tag Manager', steps: [
    'In Tag Manager, go to Tags → New → Custom HTML.',
    'Paste the snippet.',
    'Trigger: All Pages.',
    'Save, then Publish the container. Preview mode alone doesn\'t count.',
  ] },
  { id: 'shopify', label: 'Shopify', steps: [
    'Online Store → Themes → Edit code on the published theme.',
    'Open theme.liquid and paste the snippet just after the opening <head> tag.',
    'Save. If you publish a new theme later, add the snippet again — it applies per theme.',
  ] },
  { id: 'wordpress', label: 'WordPress (Woo)', steps: [
    'Install a header-code plugin (WPCode, "Insert Headers and Footers") and paste the snippet into the Header section.',
    'Or, in a child theme, paste it into header.php before </head>.',
    'Save and clear any page cache.',
  ] },
  { id: 'webflow', label: 'Webflow', steps: [
    'Project settings → Custom code → Head code.',
    'Paste the snippet and save.',
    'Publish the site afterwards.',
  ] },
  { id: 'wix', label: 'Wix', steps: [
    'Settings → Custom code → Add code.',
    'Paste the snippet, place it in Head, apply to all pages.',
    'Save.',
  ] },
  { id: 'squarespace', label: 'Squarespace', steps: [
    'Settings → Advanced → Code injection.',
    'Paste the snippet into Header and save.',
  ] },
  { id: 'custom', label: 'Custom code', steps: [
    'In your layout template, paste the snippet inside <head>, before any render-blocking scripts.',
    'Deploy.',
  ] },
];
const VERIFY_STEP = 'Come back to this page. It polls every five seconds and shows a green tick with the time the first visit arrived.';

export interface InstallProps {
  nonce: string; csrf: string; sites: Site[]; site: Site; publicUrl: string; hasBeacon: boolean; firstEventAt: string | null;
}

export function InstallPage(p: InstallProps) {
  const snippet = p.publicUrl ? snippetFor(p.site, p.publicUrl) : null;
  const platformsJson = escJson(PLATFORMS.map((x) => ({ id: x.id, label: x.label, steps: [...x.steps, VERIFY_STEP] })));
  const js = `(function(){
var SITE=${escJson({ id: p.site.id, host: p.site.host, name: p.site.name })},SNIPPET=${escJson(snippet ?? '')},PLATFORMS=${platformsJson},HAS=${p.hasBeacon ? 'true' : 'false'};
var LS='smb_install_'+SITE.id;
function $(id){return document.getElementById(id)}
function csrf(){return (document.cookie.match(/(?:^|; )smb_csrf=([^;]+)/)||[])[1]||''}
var state={method:null,platform:null};
try{var s=JSON.parse(localStorage.getItem(LS)||'null');if(s&&s.method){state=s}}catch(e){}
function save(){try{localStorage.setItem(LS,JSON.stringify(state))}catch(e){}}
function render(){
  document.querySelectorAll('[data-method]').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-method')===state.method)});
  $('platform-q').style.display=state.method==='direct'?'':'none';
  document.querySelectorAll('[data-platform]').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-platform')===state.platform)});
  var sel=$('platform-select');if(sel)sel.value=state.platform||'';
  var key=state.method==='gtm'?'gtm':state.platform;
  var pf=null;for(var i=0;i<PLATFORMS.length;i++)if(PLATFORMS[i].id===key)pf=PLATFORMS[i];
  $('gtm-callout').style.display=state.method==='gtm'?'':'none';
  var ol=$('steps');ol.innerHTML='';
  if(pf){pf.steps.forEach(function(st){var li=document.createElement('li');li.textContent=st;ol.appendChild(li)});$('steps-card').style.display=''}else{$('steps-card').style.display='none'}
}
document.querySelectorAll('[data-method]').forEach(function(b){b.addEventListener('click',function(){state.method=b.getAttribute('data-method');save();render()})});
document.querySelectorAll('[data-platform]').forEach(function(b){b.addEventListener('click',function(){state.platform=b.getAttribute('data-platform');save();render()})});
var sel=$('platform-select');if(sel)sel.addEventListener('change',function(){state.platform=sel.value||null;save();render()});
function copy(text,btn){var done=function(){var o=btn.textContent;btn.textContent='Copied';setTimeout(function(){btn.textContent=o},1500)};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,function(){fallback(text);done()})}else{fallback(text);done()}}
function fallback(t){var ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy')}catch(e){}document.body.removeChild(ta)}
var cs=$('copy-snippet');if(cs)cs.addEventListener('click',function(){copy(SNIPPET,cs)});
var ci=$('copy-instr');if(ci)ci.addEventListener('click',function(){
  var key=state.method==='gtm'?'gtm':state.platform;var pf=null;for(var i=0;i<PLATFORMS.length;i++)if(PLATFORMS[i].id===key)pf=PLATFORMS[i];
  var md='# Install the SaveMyBudget tag on '+SITE.host+'\\n\\nPaste this inside <head> on every page an ad can land on:\\n\\n\`\`\`html\\n'+SNIPPET+'\\n\`\`\`\\n\\n';
  if(pf){md+='## '+pf.label+'\\n\\n';pf.steps.forEach(function(s,i){md+=(i+1)+'. '+s+'\\n'})}else{md+='Steps for your platform: see the install page in the toolkit.\\n'}
  md+='\\nChecks:\\n\\n- Auto-tagging must stay on in Google Ads.\\n- Consent banners can block the tag — the site is set to the consent mode that matches its privacy policy.\\n- The tag must be on every page an ad can land on.\\n';
  copy(md,ci)});
// verify polling
var start=Date.now(),tick=null;
function poll(){fetch('/api/sites/'+SITE.id+'/status',{headers:{'x-csrf':csrf()}}).then(function(r){return r.json()}).then(function(j){
  if(j.first_event_at){arrived(j.first_event_at);return}
  if(Date.now()-start>600000){$('still').style.display=''}
  tick=setTimeout(poll,5000)}).catch(function(){tick=setTimeout(poll,5000)})}
function arrived(at){$('waiting').style.display='none';$('still').style.display='none';var h=$('hand');if(h)h.style.display='none';$('arrived').style.display='';$('arrived-at').textContent=new Date(at).toISOString().replace('T',' ').slice(0,16)+' UTC'}
var rnd=Math.random().toString(36).slice(2,8).toUpperCase();var tl=$('testlink');if(tl){var u='https://'+SITE.host+'/?gclid=SMBTEST'+rnd;tl.href=u;tl.textContent=u}
if(HAS){arrived(${escJson(p.firstEventAt ?? '')})}else{poll()}
render();
})();`;
  return (
    <Layout title={`Install — ${p.site.name}`} nonce={p.nonce} sites={p.sites} active={p.site} section="sites">
      <h1 class="wrap">Tag &amp; install — {p.site.name}</h1>
      <p class="sub">Add the tag once; from then on every ad click is recorded on your own server.</p>

      {!p.publicUrl ? (
        <div class="note amber">The public URL is not set, so the snippet can't be generated yet. <a href="/setup">Set it on the setup page →</a></div>
      ) : null}

      <div class="card">
        <h2>Checks before you start</h2>
        <ul class="steps">
          <li>Auto-tagging must stay on in Google Ads — it adds the click ID to your landing URLs.</li>
          <li>Consent banners can block the tag — pick the consent mode that matches your privacy policy. This site is set to <b>{p.site.consent_mode === 'consent_gated' ? 'consent-gated' : 'legitimate interest'}</b> (<a href={`/sites/${p.site.id}/edit`}>change</a>).</li>
          <li>The tag must be on every page an ad can land on.</li>
        </ul>
      </div>

      <div class="card">
        <h2>How will you add the tag?</h2>
        <div class="row">
          <button type="button" class="pill" data-method="gtm">Through Google Tag Manager</button>
          <button type="button" class="pill" data-method="direct">Directly on my site</button>
        </div>
        <div id="platform-q" style="display:none;margin-top:14px">
          <h3>Which platform?</h3>
          <div class="pills">
            {PLATFORMS.filter((x) => x.id !== 'gtm').map((x) => <button type="button" class="pill" data-platform={x.id}>{x.label}</button>)}
          </div>
          <select class="pillsel" id="platform-select" aria-label="Platform">
            <option value="">Choose a platform</option>
            {PLATFORMS.filter((x) => x.id !== 'gtm').map((x) => <option value={x.id}>{x.label}</option>)}
          </select>
        </div>
      </div>

      {snippet ? (
        <div class="card">
          <h2>The snippet</h2>
          <div class="copybox">
            <pre id="snippet"><code>{snippet}</code></pre>
            <button type="button" class="btn sm" id="copy-snippet">Copy</button>
          </div>
          <p class="where"><b>Where:</b> inside <code>&lt;head&gt;</code> on every page.</p>
          <p class="hint mono brk">SDK {SDK_BUILD.sdk_version} · build {SDK_BUILD.build} · SRI {SDK_BUILD.sri}</p>
          <p class="hint">The key is public by design: it identifies the site and grants access to nothing. The tag talks only to {p.publicUrl}.</p>
        </div>
      ) : null}

      <div class="note info" id="gtm-callout" style="display:none">
        <div>The two things that fix it 9 times out of 10: the tag needs to be a Custom HTML tag with the All Pages trigger, and you need to hit Publish afterwards — Preview mode alone doesn't count.</div>
      </div>

      <div class="card" id="steps-card" style="display:none">
        <div class="row">
          <h2>Steps</h2>
          <button type="button" class="btn sm right" id="copy-instr">Copy instructions</button>
        </div>
        <ol class="steps" id="steps"></ol>
        <p class="hint">Copy instructions gives you a self-contained Markdown block — snippet plus these steps — to paste into an email or ticket.</p>
      </div>

      <div class="card">
        <h2>Verify</h2>
        <div id="waiting">
          <p>We'll confirm here the moment the first visit arrives.</p>
          <div class="note info" id="still" style="display:none">
            <div>Still nothing? Most often it's the trigger, the Publish step, or a consent banner. Send yourself a test visit: open your site with <code>?gclid=SMBTEST…</code> and come back here. Test clicks are excluded from analysis.<br />
              <a id="testlink" href={`https://${p.site.host}/?gclid=SMBTEST`} target="_blank" rel="noopener"></a></div>
          </div>
        </div>
        <div id="arrived" style="display:none">
          <p class="note green"><span>✓ First data arrived <span id="arrived-at"></span></span></p>
          <a class="btn pri" href={`/sites/${p.site.id}`}>Open overview</a>
        </div>
      </div>

      {!p.hasBeacon ? (
        <div class="card" id="hand">
          <h2>Prefer a hand?</h2>
          <p>
            The <a href="/docs/install-the-tag">install docs</a> cover the platforms above in more detail, and <a href="https://github.com/10xlabsio/savemybudget-toolkit/discussions" target="_blank" rel="noopener">GitHub Discussions</a> is where questions get answered.
          </p>
          <p>If you'd rather not run any of this yourself, the managed version at <a href={config.hostedUrl} target="_blank" rel="noopener">savemybudget.io</a> installs and monitors for you.</p>
        </div>
      ) : null}
      <script nonce={p.nonce} dangerouslySetInnerHTML={{ __html: js }} />
    </Layout>
  );
}
