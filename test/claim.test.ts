import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'smb-claim-'));
process.env.SMB_DATA_DIR = DATA_DIR;

const { CREDIT, TERMS_SENTENCE } = await import('../src/config.js');
const { openMemoryDb, createSite, insertEvents } = await import('../src/db.js');
const { runAnalysis, saveAnalysis } = await import('../src/rules/index.js');
const { generateFixture, fixtureExpectations } = await import('../src/rules/fixtures.js');
const { buildPackage, checkWindow, evidenceCsv, renderSummary } = await import('../src/claim/index.js');
const { readZip, writeZip, crc32 } = await import('../src/claim/zip.js');
type ScoredEvent = import('../src/types.js').ScoredEvent;
type ClickEvent = import('../src/types.js').ClickEvent;

const NOW = new Date('2026-09-29T12:00:00Z');

describe('checkWindow', () => {
  it('accepts a recent window', () => assert.deepEqual(checkWindow('2026-09-01', '2026-09-20', NOW), { ok: true }));
  it('refuses a window ending more than 60 days ago', () => {
    const r = checkWindow('2026-06-01', '2026-07-15', NOW);
    assert.equal(r.ok, false); assert.match(r.message!, /60 days/);
  });
  it('warns when the window straddles the limit', () => {
    const r = checkWindow('2026-07-01', '2026-09-20', NOW);
    assert.equal(r.ok, true); assert.match(r.warning!, /60-day/);
  });
  it('rejects garbage and inverted ranges', () => {
    assert.equal(checkWindow('nope', '2026-09-20', NOW).ok, false);
    assert.equal(checkWindow('2026-09-21', '2026-09-20', NOW).ok, false);
  });
});

function fakeScored(over: Partial<ClickEvent>): ScoredEvent {
  const event: ClickEvent = {
    id: 1, site_id: 1, source: 'beacon', upload_id: null, received_at: '2026-09-10T10:00:00.000Z', ts: '2026-09-10T10:00:00.000Z',
    ip: '203.0.113.5', ip_private: 0, asn: 16509, asn_name: 'AMAZON-02', is_hosting: 1, country: 'GB', ua: 'Mozilla/5.0 "quoted", yes', ua_family: 'chrome',
    gclid: 'g1', is_test: 0, session_id: null, fp_hash: null, dwell_ms: 100, visible: 1, interactions: 0, automation: null, url: null, referer: null, campaign: null,
    ...over,
  };
  return { event, hits: [{ rule: 'r1_hosting_asn', layer: 'network', kind: 'hard', weight: 100 }], score: 100, verdict: 'flag' };
}

describe('evidenceCsv', () => {
  it('guards against formula injection and quotes per RFC 4180', () => {
    const csv = evidenceCsv([
      fakeScored({ gclid: '=HYPERLINK("http://x")', campaign: '+SUM(1)' }),
      fakeScored({ gclid: '-1', campaign: '@cmd', asn_name: '\tTab' }),
    ]);
    const lines = csv.split('\r\n').filter(Boolean);
    assert.equal(lines[0], 'gclid,timestamp_utc,ip,asn,asn_name,country,user_agent,campaign,rules_triggered,score,verdict');
    assert.equal(lines.length, 3);
    assert.ok(lines[1].startsWith(`"'=HYPERLINK(""http://x"")",`));
    assert.ok(lines[1].includes(`"Mozilla/5.0 ""quoted"", yes"`));
    assert.ok(lines[1].includes(`,'+SUM(1),`));
    assert.ok(lines[2].startsWith(`'-1,`));
    assert.ok(lines[2].includes(`,'@cmd,`));
    assert.ok(lines[2].includes(`,'\tTab,`));
    assert.ok(lines[1].endsWith(',r1_hosting_asn,100,flag'));
  });
  it('omits watch rows unless asked', () => {
    const w = fakeScored({}); w.verdict = 'watch';
    assert.equal(evidenceCsv([w]).split('\r\n').filter(Boolean).length, 1);
    assert.equal(evidenceCsv([w], true).split('\r\n').filter(Boolean).length, 2);
  });
});

describe('zip', () => {
  it('crc32 matches the known vector', () => assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926));
  it('round-trips entries', () => {
    const z = writeZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.bin', data: Buffer.from([1, 2, 3]) }]);
    const m = readZip(z);
    assert.deepEqual([...m.keys()], ['a.txt', 'dir/b.bin']);
    assert.equal(m.get('a.txt')!.toString(), 'hello');
    assert.deepEqual([...m.get('dir/b.bin')!], [1, 2, 3]);
  });
});

describe('buildPackage', () => {
  let analysisId: number;
  let siteRef: import('../src/types.js').Site;
  const FX = { from: '2026-09-10', days: 2, seed: 3 };
  before(() => {
    openMemoryDb();
    siteRef = createSite({ name: 'Claim Site', host: 'shop.example.co.uk', key: 'k2', consent_mode: 'legitimate_interest', target_countries: [] });
    insertEvents(generateFixture(siteRef.id, FX));
    const exp = fixtureExpectations(FX);
    analysisId = saveAnalysis(siteRef, runAnalysis(siteRef, exp.from, exp.to));
  });

  it('writes a zip with five files and the credit line', () => {
    const r = buildPackage(analysisId);
    assert.ok(r.rows > 0);
    assert.ok(r.package_id > 0);
    assert.ok(r.path.startsWith(join(DATA_DIR, 'packages', 'claim-shop-example-co-uk-2026-09-10-2026-09-11-')));
    const files = readZip(readFileSync(r.path));
    assert.deepEqual([...files.keys()].sort(), ['evidence.csv', 'exclusions.txt', 'form-answers.md', 'report.json', 'summary.md']);
    const summary = files.get('summary.md')!.toString();
    assert.ok(summary.includes(CREDIT));
    assert.ok(summary.includes(TERMS_SENTENCE));
    assert.ok(summary.includes('https://savemybudget.io/?utm_source=toolkit'));
    assert.match(summary, /^# shop\.example\.co\.uk — /);
    assert.ok(summary.includes('Records with timestamps (UTC), IP addresses, user agents and click IDs are attached.'));
    assert.ok(!/\bfraud\b|\$|£/.test(summary), 'summary must not accuse or mention money');
    const csvRows = files.get('evidence.csv')!.toString().split('\r\n').filter(Boolean).length - 1;
    assert.equal(csvRows, r.rows);
    const report = JSON.parse(files.get('report.json')!.toString());
    assert.equal(report.site.host, 'shop.example.co.uk');
    assert.equal(report.events.length, r.rows);
    const form = files.get('form-answers.md')!.toString();
    assert.ok(form.includes('enter yours'));
    assert.ok(form.includes('support.google.com/google-ads/contact/click_quality'));
    const excl = files.get('exclusions.txt')!.toString().trim().split('\n');
    assert.ok(excl.length > 0 && excl.every((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)));
  });

  it('can drop exclusions and include watch rows', () => {
    const base = buildPackage(analysisId);
    const r = buildPackage(analysisId, { includeWatch: true, exclusions: false });
    assert.ok(r.rows > base.rows);
    assert.equal(readZip(readFileSync(r.path)).size, 4);
  });

  it('F3: two packages for one analysis get distinct files named by package id, and each keeps its own content', async () => {
    const a = buildPackage(analysisId);
    const b = buildPackage(analysisId, { includeWatch: true });
    assert.notEqual(a.path, b.path);
    assert.match(a.path, new RegExp(`-a${analysisId}-p${a.package_id}\\.zip$`));
    assert.match(b.path, new RegExp(`-a${analysisId}-p${b.package_id}\\.zip$`));
    const { db } = await import('../src/db.js');
    const rowA = db().prepare('SELECT path FROM packages WHERE id = ?').get(a.package_id) as { path: string };
    assert.equal(rowA.path, a.path);
    const rowsA = readZip(readFileSync(a.path)).get('evidence.csv')!.toString().split('\r\n').filter(Boolean).length - 1;
    const rowsB = readZip(readFileSync(b.path)).get('evidence.csv')!.toString().split('\r\n').filter(Boolean).length - 1;
    assert.equal(rowsA, a.rows);
    assert.equal(rowsB, b.rows);
    assert.ok(rowsB > rowsA);
  });

  it('renderSummary is usable directly', () => {
    const exp = fixtureExpectations(FX);
    const { summary, scored } = runAnalysis(siteRef, exp.from, exp.to);
    const md = renderSummary(siteRef, summary, scored);
    assert.ok(md.includes('Dominant pattern:'));
    assert.ok(md.includes('Median visible time'));
  });
});
