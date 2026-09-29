// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { Layout, Csrf } from './layout.js';
import { fmtTime, n } from '../ui.js';
import type { Notification } from '../jobs/index.js';
import type { Site } from '../types.js';

export interface UploadRow { id: number; filename: string; format: string; rows_imported: number; rows_total: number; range_from: string | null; range_to: string | null; created_at: string }

export interface UploadsProps {
  nonce: string; csrf: string; sites: Site[]; site: Site; notifications: Notification[]; uploads: UploadRow[]; maxUploadMb: number; flash?: string | null;
}

export function UploadsPage(p: UploadsProps) {
  const js = `(function(){
var SITE=${p.site.id};
function $(id){return document.getElementById(id)}
function csrf(){return (document.cookie.match(/(?:^|; )smb_csrf=([^;]+)/)||[])[1]||''}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
var form=$('upform'),out=$('preview'),token=null,mapping=null;
form.addEventListener('submit',function(ev){ev.preventDefault();send(false)});
$('file').addEventListener('change',function(){token=null;mapping=null});
function send(remap){
  var f=$('file').files[0];if(!f&&!(remap&&token)){out.innerHTML='<p class="note amber"><span>Choose a file first.</span></p>';return}
  var fd=new FormData();if(f)fd.append('file',f);
  if(mapping){Object.keys(mapping).forEach(function(k){fd.append('mapping['+k+']',mapping[k])})}
  if(token)fd.append('token',token);
  out.innerHTML='<p class="hint">Checking the file…</p>';
  fetch('/api/sites/'+SITE+'/uploads',{method:'POST',headers:{'x-csrf':csrf()},body:fd}).then(function(r){return r.json()}).then(show).catch(function(){out.innerHTML='<p class="note red"><span>The upload could not be checked. Try again.</span></p>'});
}
function show(j){
  if(j.error){out.innerHTML='<p class="note red"><span>'+esc(j.error)+'</span></p>';return}
  token=j.token;var pv=j.preview,h='';
  pv.errors.forEach(function(e){h+='<div class="note red"><div>'+esc(e.message)+(e.lines&&e.lines.length?' <span class="hint">(line'+(e.lines.length>1?'s':'')+' '+e.lines.slice(0,20).join(', ')+(e.lines.length>20?'…':'')+')</span>':'')+'</div></div>'});
  pv.warnings.forEach(function(w){h+='<div class="note amber"><div>'+esc(w)+'</div></div>'});
  var heads=pv.headers||(pv.unmapped_headers||[]).concat(Object.keys(pv.mapping||{}).map(function(k){return pv.mapping[k]}));
  var needMap=pv.format==='csv'&&!pv.ok&&!!(pv.missing&&pv.missing.length);
  var offerMap=needMap||(pv.format==='csv'&&!pv.ok&&!!(pv.unmapped_headers&&pv.unmapped_headers.length));
  if(offerMap){
    var canon=['timestamp','ip','gclid','user_agent','url','referer','campaign'];
    h+='<form class="card tight" id="mapform"><h3>Map the columns</h3><p class="hint">Some headers were not recognised. Tell the toolkit which column of the file is which, then check again.</p>';
    canon.forEach(function(c){h+='<label for="map-'+c+'">'+c+(c==='timestamp'||c==='ip'||c==='gclid'?' (required)':'')+'</label><select id="map-'+c+'" name="mapping['+c+']" data-canon="'+c+'"><option value="">— not present —</option>';
      heads.forEach(function(hd){h+='<option value="'+esc(hd)+'"'+((pv.mapping||{})[c]===hd?' selected':'')+'>'+esc(hd)+'</option>'});h+='</select>'});
    h+='<p style="margin-top:12px"><button type="submit" class="btn pri" id="remap">Check again with this mapping</button></p></form>';
  }
  if(pv.format&&!needMap){
    h+='<div class="grid4">'+kpi('Format',pv.format==='log'?'Access log':'CSV')+kpi('Rows in file',pv.rows_total)+kpi('Usable rows',pv.rows_usable)+kpi('Date range',pv.range_from?esc(pv.range_from)+' → '+esc(pv.range_to):'—')+'</div>';
    h+='<div class="grid4">'+kpi('Distinct IPs',pv.distinct_ips)+kpi('Distinct click IDs',pv.distinct_gclids)+'</div>';
    var dr=pv.dropped||{},dk=Object.keys(dr).filter(function(k){return dr[k]>0});
    if(dk.length){h+='<div class="card tight"><h3>Dropped rows</h3><ul class="plain">';dk.forEach(function(k){h+='<li>'+esc(k.replace(/_/g,' '))+': <b>'+dr[k]+'</b></li>'});h+='</ul></div>'}
    if(pv.sample&&pv.sample.length){h+='<div class="card tight tbl"><h3>First rows</h3><table><thead><tr><th>Time</th><th>IP</th><th>Click ID</th><th>Browser</th></tr></thead><tbody>';
      pv.sample.forEach(function(r){h+='<tr><td class="mono">'+esc(r.ts)+'</td><td class="mono">'+esc(r.ip)+'</td><td class="mono">'+esc(String(r.gclid).slice(0,12))+'…</td><td class="hint">'+esc((r.ua||'').slice(0,60))+'</td></tr>'});h+='</tbody></table></div>'}
  }
  if(pv.ok&&token){h+='<p><button type="button" class="btn pri" id="import">Import '+pv.rows_usable+' rows</button></p>'}
  out.innerHTML=h;
  var mf=$('mapform');if(mf)mf.addEventListener('submit',function(ev){ev.preventDefault();mapping={};document.querySelectorAll('[data-canon]').forEach(function(s){if(s.value)mapping[s.getAttribute('data-canon')]=s.value});send(true)});
  var im=$('import');if(im)im.addEventListener('click',function(){im.disabled=true;im.textContent='Importing…';
    fetch('/api/sites/'+SITE+'/uploads/'+encodeURIComponent(token)+'/import',{method:'POST',headers:{'x-csrf':csrf(),'content-type':'application/json'},body:JSON.stringify({mapping:mapping})}).then(function(r){return r.json()}).then(function(j){
      if(j.error){out.innerHTML='<p class="note red"><span>'+esc(j.error)+'</span></p>';return}
      location.href='/sites/'+SITE+'/uploads?imported='+j.imported}).catch(function(){im.disabled=false;im.textContent='Import';})});
}
function kpi(l,v){return '<div class="kpi"><div class="l">'+l+'</div><div class="v" style="font-size:18px">'+v+'</div></div>'}
})();`;
  return (
    <Layout title={`Uploads — ${p.site.name}`} nonce={p.nonce} sites={p.sites} active={p.site} notifications={p.notifications} section="sites">
      <h1>Uploads — {p.site.name}</h1>
      <p class="sub">Add a web server access log or a click-log CSV. Rows join the beacons for the same window; what gets imported is checked first and shown before anything is written.</p>
      {p.flash ? <div class="note green"><div>{p.flash}</div></div> : null}
      <div class="card">
        <form id="upform" enctype="multipart/form-data">
          <label for="file">File (.csv, .txt, .log, .tsv, .gz — up to {p.maxUploadMb} MB)</label>
          <input type="file" id="file" name="file" accept=".csv,.txt,.log,.tsv,.gz" />
          <p class="hint"><a href="/templates/click-log-template.csv">Download template</a> · <a href="/templates/access-log-sample.log">See a sample log line</a> · <a href="/docs/inputs">What is accepted</a></p>
          <p><button type="submit" class="btn pri">Check file</button></p>
        </form>
        <div id="preview"></div>
      </div>
      <div class="card tight tbl">
        <h2>History</h2>
        {p.uploads.length === 0 ? <p class="hint">Nothing imported yet.</p> : (
          <table>
            <thead><tr><th>File</th><th>Format</th><th class="num">Rows imported</th><th>Date range</th><th>Imported</th><th></th></tr></thead>
            <tbody>
              {p.uploads.map((u) => (
                <tr>
                  <td>{u.filename}</td>
                  <td>{u.format === 'log' ? 'Access log' : 'CSV'}</td>
                  <td class="num">{n(u.rows_imported)} <span class="hint">of {n(u.rows_total)}</span></td>
                  <td class="mono">{u.range_from ?? '—'} → {u.range_to ?? '—'}</td>
                  <td>{fmtTime(u.created_at)}</td>
                  <td>
                    <form method="post" action={`/api/uploads/${u.id}/delete`} style="display:inline">
                      <Csrf token={p.csrf} />
                      <button type="submit" class="btn sm danger">Delete</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <script nonce={p.nonce} dangerouslySetInnerHTML={{ __html: js }} />
    </Layout>
  );
}
