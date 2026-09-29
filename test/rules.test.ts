// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SMB_DATA_DIR = mkdtempSync(join(tmpdir(), 'smb-rules-'));

const { openMemoryDb, createSite, insertEvents, eventsInWindow } = await import('../src/db.js');
const { runAnalysis, saveAnalysis, loadAnalysis, RULES } = await import('../src/rules/index.js');
const { generateFixture, fixtureExpectations } = await import('../src/rules/fixtures.js');
type Site = import('../src/types.js').Site;
type ScoredEvent = import('../src/types.js').ScoredEvent;

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
