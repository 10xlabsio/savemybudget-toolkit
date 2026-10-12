// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SMB_DATA_DIR = mkdtempSync(join(tmpdir(), 'smb-rules-'));

const { openMemoryDb, createSite, insertEvents, eventsInWindow } = await import('../src/db.js');
const { runAnalysis, saveAnalysis, loadAnalysis, RULES, DEFAULTS } = await import('../src/rules/index.js');
const { isHostingAsn, isWebKitUa } = await import('../src/enrich/index.js');
const { generateFixture, fixtureExpectations } = await import('../src/rules/fixtures.js');
type Site = import('../src/types.js').Site;
type ScoredEvent = import('../src/types.js').ScoredEvent;
type ClickEvent = import('../src/types.js').ClickEvent;

const FX = { from: '2026-09-10', days: 3, seed: 7 };

describe('rules', () => {
  let site: Site;
  let scored: ScoredEvent[];
  let summary: import('../src/types.js').AnalysisSummary;
  const exp = fixtureExpectations(FX);
  const byGclid = new Map<string, ScoredEvent[]>();
  const hasRule = (s: ScoredEvent, id: string) => s.hits.some((h) => h.rule === id);
  const forGclid = (g: string) => byGclid.get(g) ?? [];

  before(() => {
    openMemoryDb();
    site = createSite({ name: 'Fixture', host: 'fixture.example', key: 'k1', consent_mode: 'legitimate_interest', target_countries: ['GB'] });
    insertEvents(generateFixture(site.id, FX));
    const r = runAnalysis(site, exp.from, exp.to);
    scored = r.scored; summary = r.summary;
    for (const s of scored) { const l = byGclid.get(s.event.gclid) ?? []; l.push(s); byGclid.set(s.event.gclid, l); }
  });

  it('exposes ten rules', () => {
    assert.equal(RULES.length, 10);
    assert.ok(RULES.every((r) => r.weight > 0 && r.title && r.describe));
  });

  it('(a) hosting ASN -> r1 hard flag', () => {
    for (const g of exp.hosting.gclids) for (const s of forGclid(g)) { assert.equal(s.verdict, 'flag'); assert.ok(hasRule(s, 'r1_hosting_asn')); }
    assert.equal(summary.rules.r1_hosting_asn, 40);
  });

  it('(b) automation markers -> r6 hard flag', () => {
    for (const g of exp.automation.gclids) for (const s of forGclid(g)) { assert.equal(s.verdict, 'flag'); assert.ok(hasRule(s, 'r6_automation')); }
  });

  it('(c) log line without beacon -> r9 hard flag, guard not tripped', () => {
    for (const g of exp.noBeacon.gclids) {
      const l = forGclid(g);
      assert.equal(l.length, 1);
      assert.equal(l[0].verdict, 'flag');
      const hit = l[0].hits.find((h) => h.rule === 'r9_no_beacon');
      assert.ok(hit && hit.kind === 'hard');
    }
    assert.ok(!summary.notes.some((n) => n.includes('downgraded')), 'no r9 downgrade note expected');
    for (const g of exp.matchedLogs.gclids) for (const s of forGclid(g)) assert.ok(!hasRule(s, 'r9_no_beacon'));
  });

  it('(d) replayed gclid -> r13 on all sightings', () => {
    const l = forGclid(exp.replay.gclid);
    assert.equal(l.length, 6);
    for (const s of l) { assert.equal(s.verdict, 'flag'); assert.ok(hasRule(s, 'r13_gclid_replay')); }
  });

  it('(e) IP burst with zero dwell -> r14 + r10 converge to flag', () => {
    for (const g of exp.velocity.gclids) {
      const s = forGclid(g)[0];
      assert.ok(hasRule(s, 'r14_ip_velocity') && hasRule(s, 'r10_zero_dwell'));
      assert.equal(s.verdict, 'flag');
      assert.ok(s.score >= 70);
    }
  });

  it('(f) fingerprint collision -> r8 soft (watch alone)', () => {
    for (const g of exp.fpCollision.gclids) {
      const s = forGclid(g)[0];
      assert.ok(hasRule(s, 'r8_fp_collision'));
      assert.equal(s.verdict, 'watch');
    }
  });

  it('(g) subnet cluster -> r4 soft, undampened', () => {
    for (const g of exp.subnet.gclids) {
      const s = forGclid(g)[0];
      const h = s.hits.find((x) => x.rule === 'r4_subnet_cluster');
      assert.ok(h && h.weight === 35 && !h.note);
      assert.notEqual(s.verdict, 'flag');
    }
  });

  it('(i) iPhones on iCloud Private Relay networks are not hosting', () => {
    for (const asn of [13335, 36183, 20940, 54113]) assert.equal(isHostingAsn(asn), false, `AS${asn}`);
    assert.equal(isHostingAsn(16509), true);
    assert.equal(exp.relayIphone.gclids.length, 12);
    for (const g of exp.relayIphone.gclids) for (const s of forGclid(g)) {
      assert.ok(!hasRule(s, 'r1_hosting_asn'), `relay gclid ${g} hit r1 (AS${s.event.asn}, is_hosting ${s.event.is_hosting})`);
      assert.notEqual(s.verdict, 'flag');
    }
    assert.ok(exp.relayIphone.gclids.flatMap(forGclid).some((s) => s.event.asn === 20940 && s.event.is_hosting === 1), 'fixture includes an AS20940 row stored as hosting');
  });

  it('(j) one iPhone model\'s shared fingerprint is not a collision under 50 IPs', () => {
    const l = exp.iphoneCollision.gclids.flatMap(forGclid);
    assert.equal(new Set(l.map((s) => s.event.ip)).size, 20);
    assert.ok(l.every((s) => isWebKitUa(s.event.ua, s.event.ua_family)));
    assert.ok(l.some((s) => s.event.ua_family === 'other-mobile'), 'fixture includes Chrome on iOS');
    for (const s of l) {
      assert.ok(!hasRule(s, 'r8_fp_collision'), `iPhone gclid ${s.event.gclid} hit r8`);
      assert.notEqual(s.verdict, 'flag');
    }
    assert.ok(l.some((s) => hasRule(s, 'r10_zero_dwell') && s.verdict === 'watch'), 'the bounces stay at watch');
  });

  it('(k) a reload burst from one visitor is not a replay or velocity', () => {
    const l = forGclid(exp.reloadBurst.gclid);
    assert.equal(l.length, 12);
    for (const s of l) {
      assert.ok(!hasRule(s, 'r13_gclid_replay') && !hasRule(s, 'r14_ip_velocity'), JSON.stringify(s.hits));
      assert.notEqual(s.verdict, 'flag');
    }
  });

  it('(h) CGNAT-looking IP does not flag', () => {
    for (const g of exp.cgnat.gclids) for (const s of forGclid(g)) {
      assert.notEqual(s.verdict, 'flag', `cgnat gclid ${g} flagged: ${JSON.stringify(s.hits)}`);
      const v = s.hits.find((x) => x.rule === 'r14_ip_velocity');
      if (v) assert.ok(v.weight <= 20 && v.note?.includes('dampened'));
    }
  });

  it('r3 fires only when the site targets countries', () => {
    for (const g of exp.geo.gclids) assert.ok(hasRule(forGclid(g)[0], 'r3_geo'));
    const noTarget = { ...site, target_countries: [] };
    const r = runAnalysis(noTarget, exp.from, exp.to);
    assert.equal(r.summary.rules.r3_geo, 0);
  });

  it('no clean visit is flagged', () => {
    const flaggedClean = exp.clean.gclids.flatMap(forGclid).filter((s) => s.verdict === 'flag');
    assert.equal(flaggedClean.length, 0, flaggedClean.map((s) => JSON.stringify(s.hits)).join('\n'));
  });

  it('summary counts add up', () => {
    const c = summary.counts;
    assert.equal(c.allow + c.watch + c.flag, c.total);
    assert.equal(c.sources.beacon + c.sources.log + c.sources.csv, c.total);
    assert.equal(summary.per_day.reduce((n, d) => n + d.total, 0), c.total);
    assert.equal(summary.top_asns[0].asn, 16509);
    assert.ok(summary.top_subnets.length > 0);
  });

  it('r9 does not run without beacons', () => {
    const logsOnly = eventsInWindow(site.id, exp.from, exp.to).filter((e) => e.source !== 'beacon');
    const r = runAnalysis(site, exp.from, exp.to, { events: logsOnly });
    assert.equal(r.summary.rules.r9_no_beacon, 0);
    assert.ok(r.summary.notes.some((n) => n.includes('did not run')));
  });

  it('r9 downgrades to soft when beacon ratio collapses vs history', () => {
    const r = runAnalysis(site, exp.from, exp.to, { history: { beaconRatioMedian: 10 } });
    const hit = r.scored.find((s) => s.event.gclid === exp.noBeacon.gclids[0])!.hits.find((h) => h.rule === 'r9_no_beacon');
    assert.ok(hit && hit.kind === 'soft' && hit.weight === 40);
    assert.ok(r.summary.notes.some((n) => n.includes('downgraded')));
  });

  describe('detection false-positive guards keep the real cases', () => {
    const T0 = Date.parse('2026-09-11T12:00:00.000Z');
    let nextId = 1_000_000;
    const ev = (over: Partial<ClickEvent> & { ip: string; gclid: string; at: number }): ClickEvent => {
      const { at, ...rest } = over;
      return {
        id: nextId++, site_id: site.id, source: 'beacon', upload_id: null, received_at: new Date(T0 + at).toISOString(), ts: new Date(T0 + at).toISOString(),
        ip_private: 0, asn: 5089, asn_name: 'Virgin Media', is_hosting: 0, country: 'GB', ua: null, ua_family: 'chrome', is_test: 0,
        session_id: null, fp_hash: 'f'.repeat(32), dwell_ms: 30_000, visible: 1, interactions: 10, automation: null,
        url: '/landing', referer: null, campaign: null, ...rest,
      };
    };
    const run = (events: ClickEvent[]) => runAnalysis(site, exp.from, exp.to, { events }).scored;
    const MIN = 60_000;

    it('r13: the same click ID from a second IP within minutes is a replay', () => {
      const r = run([ev({ ip: '81.2.69.10', gclid: 'G-two-ips', at: 0 }), ev({ ip: '81.2.69.11', gclid: 'G-two-ips', at: 2 * MIN })]);
      for (const s of r) { assert.ok(hasRule(s, 'r13_gclid_replay')); assert.equal(s.verdict, 'flag'); }
    });

    it('r13: the same click ID from a second device on one IP is a replay', () => {
      const r = run([ev({ ip: '81.2.69.12', gclid: 'G-two-devices', at: 0, fp_hash: 'a'.repeat(32) }), ev({ ip: '81.2.69.12', gclid: 'G-two-devices', at: MIN, fp_hash: 'b'.repeat(32) })]);
      for (const s of r) assert.ok(hasRule(s, 'r13_gclid_replay'));
    });

    it('r13: one IP and device counts once the hits are more than 10 minutes apart', () => {
      assert.ok(run([ev({ ip: '81.2.69.13', gclid: 'G-spread', at: 0 }), ev({ ip: '81.2.69.13', gclid: 'G-spread', at: 11 * MIN })]).every((s) => hasRule(s, 'r13_gclid_replay')));
      assert.ok(run([ev({ ip: '81.2.69.13', gclid: 'G-close', at: 0 }), ev({ ip: '81.2.69.13', gclid: 'G-close', at: 10 * MIN })]).every((s) => !hasRule(s, 'r13_gclid_replay')));
    });

    it('r14: counts distinct click IDs, not page loads', () => {
      const reloads = [0, 1, 2, 3].map((i) => ev({ ip: '81.2.69.20', gclid: 'G-one-click', at: i * MIN }));
      assert.ok(run(reloads).every((s) => !hasRule(s, 'r14_ip_velocity')));
      const clicks = [0, 1, 2].map((i) => ev({ ip: '81.2.69.21', gclid: `G-click-${i}`, at: i * MIN, fp_hash: `${i}`.repeat(32) }));
      assert.ok(run(clicks).every((s) => hasRule(s, 'r14_ip_velocity')));
    });

    it('r8: a WebKit fingerprint still collides at 50 IPs; other browsers at 5', () => {
      const safari = (n: number, fp: string) => Array.from({ length: n }, (_, i) =>
        ev({ ip: `81.2.${70 + Math.floor(i / 200)}.${(i % 200) + 1}`, gclid: `G-${fp}-${i}`, at: i * MIN, fp_hash: fp, ua_family: 'safari-mobile' }));
      assert.ok(run(safari(49, 'c'.repeat(32))).every((s) => !hasRule(s, 'r8_fp_collision')));
      assert.ok(run(safari(50, 'd'.repeat(32))).every((s) => hasRule(s, 'r8_fp_collision')));
      const chrome = Array.from({ length: 5 }, (_, i) => ev({ ip: `81.2.80.${i + 1}`, gclid: `G-chrome-${i}`, at: i * MIN, fp_hash: 'e'.repeat(32) }));
      assert.ok(run(chrome).every((s) => hasRule(s, 'r8_fp_collision')));
    });

    it('r1: a relay network is skipped even when stored as hosting', () => {
      const r = run([ev({ ip: '81.2.69.30', gclid: 'G-relay', at: 0, asn: 13335, asn_name: 'CLOUDFLARENET', is_hosting: 1 }), ev({ ip: '81.2.69.31', gclid: 'G-aws', at: 0, asn: 16509, asn_name: 'AMAZON-02', is_hosting: 1 })]);
      assert.ok(!hasRule(r.find((s) => s.event.gclid === 'G-relay')!, 'r1_hosting_asn'));
      assert.ok(hasRule(r.find((s) => s.event.gclid === 'G-aws')!, 'r1_hosting_asn'));
    });

    it('isWebKitUa: iPhone, iPad and Safari; not Chrome or Android', () => {
      assert.ok(isWebKitUa(null, 'safari') && isWebKitUa(null, 'safari-mobile'));
      assert.ok(isWebKitUa('Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1', 'other-mobile'));
      assert.ok(!isWebKitUa('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', 'chrome-mobile'));
      assert.ok(!isWebKitUa(null, null));
    });
  });

  it('shipped defaults are the documented ones', () => {
    // Defaults are product decisions (CONTRIBUTING.md): a change here needs docs/rules.md and the CHANGELOG too.
    assert.deepEqual(DEFAULTS, {
      score_threshold: 70,
      min_layers: 2,
      watch_score: 30,
      hard_weight: 100,
      rules: {
        r1_hosting_asn: { kind: 'hard', weight: 100 },
        r3_geo: { kind: 'hard', weight: 100 },
        r4_subnet_cluster: { kind: 'soft', weight: 35, min_ips: 5, window_min: 15, dampen_ua_families: 5 },
        r6_automation: { kind: 'hard', weight: 100 },
        r8_fp_collision: { kind: 'soft', weight: 40, min_ips: 5, webkit_min_ips: 50, window_hours: 24 },
        r9_no_beacon: { kind: 'hard', weight: 100, match_window_min: 30, guard_ratio_of_median: 0.5, guard_ratio_absolute: 0.2, downgraded_weight: 40 },
        r10_zero_dwell: { kind: 'soft', weight: 30, max_dwell_ms: 2000 },
        r11_dead_session: { kind: 'soft', weight: 30, min_dwell_ms: 2000 },
        r13_gclid_replay: { kind: 'hard', weight: 100, min_sightings: 2, pair_window_min: 30, min_spread_min: 10, max_age_hours: 24 },
        r14_ip_velocity: { kind: 'soft', weight: 40, short_window_min: 15, short_min: 3, long_window_hours: 24, long_min: 5, cgnat_ua_families: 5 },
      },
    });
    assert.deepEqual(Object.keys(DEFAULTS.rules), RULES.map((r) => r.id));
  });

  it('saveAnalysis / loadAnalysis round-trip', () => {
    const id = saveAnalysis(site, { summary, scored });
    const loaded = loadAnalysis(id);
    assert.ok(loaded);
    assert.equal(loaded.site_id, site.id);
    assert.equal(loaded.scored.length, scored.length);
    assert.deepEqual(loaded.summary, summary);
    const flagged = loaded.scored.filter((s) => s.verdict === 'flag').length;
    assert.equal(flagged, summary.counts.flag);
    const one = loaded.scored.find((s) => s.event.gclid === exp.replay.gclid)!;
    assert.ok(one.hits.some((h) => h.rule === 'r13_gclid_replay'));
    assert.equal(loadAnalysis(9999), null);
  });
});
