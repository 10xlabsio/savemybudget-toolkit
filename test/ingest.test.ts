import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

process.env.SMB_DATA_DIR = mkdtempSync(join(tmpdir(), 'smb-ingest-'));

const { openMemoryDb, createSite, db } = await import('../src/db.js');
const { analyzeUpload, importUpload, parseUploadRows } = await import('../src/ingest/index.js');

const NOW = new Date('2026-09-22T12:00:00Z');
const OPTS = { retentionDays: 90, now: NOW };
const root = new URL('../templates/', import.meta.url);
const template = readFileSync(new URL('click-log-template.csv', root));
const sampleLog = readFileSync(new URL('access-log-sample.log', root));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const gclid = (i: number) => `Cj0KCQjwTEST${String(i).padStart(4, '0')}AAAAABgd3kPq2t6R1Y9oL7mHf4Zc8eV2uQx1EALw_wcB`;

function logLines(n: number, ip = (i: number) => `203.0.113.${(i % 200) + 1}`): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const sec = String(i % 60).padStart(2, '0');
    out.push(`${ip(i)} - - [21/Sep/2026:09:14:${sec} +0000] "GET /landing?gclid=${gclid(i)} HTTP/1.1" 200 5123 "https://www.google.com/" "${UA}"`);
  }
  return out.join('\n') + '\n';
}

describe('ingest', () => {
  before(() => { openMemoryDb(); });

  it('rejects the unedited template', () => {
    const p = analyzeUpload(template, 'click-log-template.csv', OPTS);
    assert.equal(p.ok, false);
    assert.equal(p.format, 'csv');
    assert.ok(p.errors.some((e) => e.message.startsWith('This is the template')));
  });

  it('parses the sample log (3 rows + 1 no_gclid_line) but rejects it for < 20 rows', () => {
    const p = analyzeUpload(sampleLog, 'access-log-sample.log', OPTS);
    assert.equal(p.format, 'log');
    assert.equal(p.rows_total, 4);
    assert.equal(p.rows_usable, 3);
    assert.equal(p.dropped.no_gclid_line, 1);
    assert.equal(p.distinct_ips, 2);
    assert.equal(p.distinct_gclids, 3);
    assert.equal(p.range_from, '2026-09-21');
    assert.equal(p.sample[0].ts, '2026-09-21T09:14:07.000Z');
    assert.equal(p.sample[0].referer, 'https://www.google.com/');
    assert.equal(p.ok, false);
    assert.match(p.errors[0].message, /Only 3 usable rows/);
  });

  it('accepts a generated 30-row log and imports it', () => {
    const site = createSite({ name: 'T', host: 't.example', key: 'k-ingest', consent_mode: 'legitimate_interest', target_countries: ['GB'] });
    const buf = Buffer.from(logLines(30) + '198.51.100.7 - - [21/Sep/2026:09:15:02 +0000] "GET /about HTTP/1.1" 200 3310 "-" "-"\n');
    const p = analyzeUpload(buf, 'access.log', OPTS);
    assert.equal(p.ok, true, JSON.stringify(p.errors));
    assert.equal(p.rows_usable, 30);
    assert.equal(p.dropped.no_gclid_line, 1);
    assert.equal(p.sample.length, 10);

    const r = importUpload(site.id, buf, 'access.log', OPTS);
    assert.equal(r.imported, 30);
    const n = db().prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND source = 'log' AND upload_id = ?").get(site.id, r.upload_id) as { n: number };
    assert.equal(n.n, 30);
    const ev = db().prepare('SELECT ua_family, session_id, is_test FROM events WHERE upload_id = ? LIMIT 1').get(r.upload_id) as any;
    assert.equal(ev.ua_family, 'chrome');
    assert.equal(ev.session_id, null);
    const up = db().prepare('SELECT * FROM uploads WHERE id = ?').get(r.upload_id) as any;
    assert.equal(up.format, 'log');
    assert.equal(up.rows_imported, 30);
    assert.equal(JSON.parse(up.dropped).no_gclid_line, 1);
    // imports must not mark the tag live
    const s = db().prepare('SELECT first_event_at FROM sites WHERE id = ?').get(site.id) as any;
    assert.equal(s.first_event_at, null);
  });

  it('parses a gzipped log', () => {
    const p = analyzeUpload(gzipSync(Buffer.from(logLines(25))), 'access.log.gz', OPTS);
    assert.equal(p.ok, true);
    assert.equal(p.rows_usable, 25);
  });

  it('maps CSV aliases, handles quoted cells, semicolons and naive timestamps', () => {
    const lines = ['Time;Client_IP;Click ID;UA;Landing Page;Referrer;Extra'];
    for (let i = 0; i < 25; i++) {
      lines.push(`2026-09-21 09:${String(i).padStart(2, '0')}:00;203.0.113.${i + 1};${gclid(i)};"Mozilla/5.0 (X11; Linux) ""Chrome""";https://shop.test/l?x=1;;n/a`);
    }
    const p = analyzeUpload(Buffer.from(lines.join('\r\n')), 'export.csv', OPTS);
    assert.equal(p.ok, true, JSON.stringify(p.errors));
    assert.equal(p.format, 'csv');
    assert.deepEqual(p.mapping, { timestamp: 'Time', ip: 'Client_IP', gclid: 'Click ID', user_agent: 'UA', url: 'Landing Page', referer: 'Referrer' });
    assert.deepEqual(p.unmapped_headers, ['Extra']);
    assert.equal(p.rows_usable, 25);
    assert.equal(p.sample[0].ua, 'Mozilla/5.0 (X11; Linux) "Chrome"');
    assert.equal(p.sample[0].ts, '2026-09-21T09:00:00.000Z');
    assert.ok(p.warnings.some((w) => /treated as UTC/.test(w)));
    assert.ok(p.warnings.some((w) => /semicolon/.test(w)));
  });

  it('applies a manual mapping and extracts gclid from url when the column is empty', () => {
    const lines = ['when,addr,clickref,link'];
    for (let i = 0; i < 22; i++) lines.push(`${1789981200 + i},203.0.113.${i + 1},,https://shop.test/l?gclid=${gclid(i)}`);
    const p = analyzeUpload(Buffer.from(lines.join('\n')), 'x.csv', { ...OPTS, mapping: { timestamp: 'when', ip: 'addr', gclid: 'clickref', url: 'link' } });
    assert.equal(p.ok, true, JSON.stringify(p.errors));
    assert.equal(p.rows_usable, 22);
    assert.equal(p.sample[0].gclid, gclid(0));
    assert.ok(p.warnings.some((w) => /Unix epoch/.test(w)));
  });

  it('drops and counts: outside window, private IP, no gclid, duplicates, bad rows', () => {
    const lines = ['timestamp,ip,gclid'];
    for (let i = 0; i < 24; i++) lines.push(`2026-09-21T09:00:${String(i).padStart(2, '0')}Z,203.0.113.${i + 1},${gclid(i)}`);
    lines.push(`2026-09-21T09:00:00Z,203.0.113.1,${gclid(0)}`); // duplicate
    lines.push(`2026-01-01T09:00:00Z,203.0.113.99,${gclid(99)}`); // outside window
    lines.push(`2026-09-21T09:00:00Z,10.0.0.5,${gclid(98)}`); // private
    lines.push(`2026-09-21T09:00:00Z,203.0.113.98,`); // no gclid
    lines.push(`not-a-date,203.0.113.97,${gclid(97)}`); // bad ts
    lines.push(`2026-09-21T09:00:00Z,999.1.1.1,${gclid(96)}`); // bad ip
    lines.push(`2026-09-30T09:00:00Z,203.0.113.96,${gclid(95)}`); // future
    const p = analyzeUpload(Buffer.from(lines.join('\n')), 'x.csv', OPTS);
    assert.equal(p.ok, true, JSON.stringify(p.errors));
    assert.equal(p.rows_total, 31);
    assert.equal(p.rows_usable, 24);
    assert.deepEqual(p.dropped, { outside_window: 1, private_ip: 1, no_gclid: 1, duplicate: 1, bad_row: 3, no_gclid_line: 0 });
  });

  it('rejects a private-IP majority with the proxy message', () => {
    const buf = Buffer.from(logLines(30, (i) => (i < 20 ? '10.0.0.1' : `203.0.113.${i}`)));
    const p = analyzeUpload(buf, 'access.log', OPTS);
    assert.equal(p.ok, false);
    assert.ok(p.errors.some((e) => /proxy or CDN/.test(e.message)));
  });

  it('rejects when more than 20% of rows fail row checks', () => {
    const lines = ['timestamp,ip,gclid'];
    for (let i = 0; i < 30; i++) lines.push(`2026-09-21T09:00:${String(i).padStart(2, '0')}Z,203.0.113.${i + 1},${gclid(i)}`);
    for (let i = 0; i < 10; i++) lines.push(`2026-09-21T09:00:00Z,203.0.113.${i + 1},short`);
    const p = analyzeUpload(Buffer.from(lines.join('\n')), 'x.csv', OPTS);
    assert.equal(p.ok, false);
    assert.ok(p.errors.some((e) => /failed row checks/.test(e.message) && (e.lines?.length ?? 0) === 10));
  });

  it('gives specific messages for Google Ads / GA / IIS / binary / JSON', () => {
    const ads = analyzeUpload(Buffer.from('Campaign,Clicks,Impressions,Cost\nBrand,10,100,5.00\n'), 'ads.csv', OPTS);
    assert.equal(ads.ok, false);
    assert.equal(ads.format, null);
    assert.match(ads.errors[0].message, /Google Ads export/);
    const ga = analyzeUpload(Buffer.from('Source,Sessions,Users\ngoogle,10,8\n'), 'ga.csv', OPTS);
    assert.match(ga.errors[0].message, /Google Analytics/);
    const iis = analyzeUpload(Buffer.from('#Software: Microsoft Internet Information Services\n#Fields: date time c-ip\n2026-09-21 09:00:00 1.2.3.4\n'), 'u_ex.log', OPTS);
    assert.match(iis.errors[0].message, /IIS/);
    const bin = analyzeUpload(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'x.xlsx', OPTS);
    assert.equal(bin.ok, false);
    const json = analyzeUpload(Buffer.from('[{"a":1}]'), 'x.json', OPTS);
    assert.match(json.errors[0].message, /JSON/);
    const generic = analyzeUpload(Buffer.from('hello world\n'), 'x.txt', OPTS);
    assert.match(generic.errors[0].message, /Upload a CSV with timestamp, ip and gclid columns/);
  });

  it('warns on identical timestamps, one dominant IP, identical gclids and short gclids', () => {
    const lines = ['timestamp,ip,gclid'];
    for (let i = 0; i < 25; i++) lines.push(`2026-09-21T09:00:00Z,203.0.113.1,Cj0KCQjwTEST0000AAAAABgd3k`);
    // identical ts+ip+gclid would all dedupe; vary gclid slightly for the count while keeping them short
    const lines2 = ['timestamp,ip,gclid'];
    for (let i = 0; i < 25; i++) lines2.push(`2026-09-21T09:00:00Z,203.0.113.1,Cj0KCQjwTEST${String(i).padStart(4, '0')}AAAAABg`);
    const p = analyzeUpload(Buffer.from(lines2.join('\n')), 'x.csv', OPTS);
    assert.equal(p.ok, true, JSON.stringify(p.errors));
    assert.ok(p.warnings.some((w) => /same timestamp/.test(w)));
    assert.ok(p.warnings.some((w) => /One IP/.test(w)));
    assert.ok(p.warnings.some((w) => /truncated/.test(w)));
    const p1 = analyzeUpload(Buffer.from(lines.join('\n')), 'x.csv', OPTS);
    assert.equal(p1.rows_usable, 1); // all duplicates
    assert.equal(p1.dropped.duplicate, 24);
  });

  it('transcodes Latin-1 with a warning', () => {
    const lines = ['timestamp,ip,gclid,campaign'];
    for (let i = 0; i < 21; i++) lines.push(`2026-09-21T09:00:${String(i).padStart(2, '0')}Z,203.0.113.${i + 1},${gclid(i)},Caf\xe9`);
    const p = analyzeUpload(Buffer.from(lines.join('\n'), 'latin1'), 'x.csv', OPTS);
    assert.equal(p.ok, true);
    assert.ok(p.warnings.some((w) => /Latin-1/.test(w)));
    assert.equal(p.sample[0].campaign, 'Café');
  });

  it('parseUploadRows throws on a rejected upload', () => {
    assert.throws(() => parseUploadRows(template, 'click-log-template.csv', OPTS), /template/);
  });

  it('marks SMBTEST gclids as is_test on import', () => {
    const site = createSite({ name: 'T2', host: 't2.example', key: 'k-ingest-2', consent_mode: 'legitimate_interest', target_countries: [] });
    const lines = ['timestamp,ip,gclid'];
    for (let i = 0; i < 21; i++) lines.push(`2026-09-21T09:00:${String(i).padStart(2, '0')}Z,203.0.113.${i + 1},${i === 0 ? 'SMBTEST_' + gclid(i).slice(8) : gclid(i)}`);
    const r = importUpload(site.id, Buffer.from(lines.join('\n')), 'x.csv', OPTS);
    const t = db().prepare('SELECT COUNT(*) AS n FROM events WHERE upload_id = ? AND is_test = 1').get(r.upload_id) as { n: number };
    assert.equal(t.n, 1);
  });
});
