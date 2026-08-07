/**
 * The acceptance test for the whole model (IMPLEMENTATION.md §12).
 *
 * A group-by-rule over the latest assay per (subject, leg) has to rediscover, by query, that
 * the `*arr` family all ship `cpu_shares` on the reserved System-Background tier. Today that
 * fact exists as one sentence inside the Prowlarr report — and for qBittorrent, which has no
 * report page at all, that sentence is the *only* record anywhere that it is affected.
 *
 * If this passes, the rule vocabulary is doing its job: prose scattered across 57 pages has
 * become rows you can group. If it fails, nothing built on top of the findings table is
 * worth building yet.
 */

import { describe, expect, it } from 'vitest';

import { buildIndex, type ReportIndex } from '../src/server/store/index.js';
import { DATA_REPORTS, FIXTURE_REPORTS, existsSync } from './helpers.js';

/** The full archive only exists after `yarn run import`; those checks skip without it. */
const HAS_ARCHIVE = existsSync(DATA_REPORTS);

/** The family named in the Prowlarr and Radarr reports. */
const ARR_FAMILY = ['Lidarr', 'Prowlarr', 'Radarr', 'Sonarr', 'qBittorrent'];

/** Every subject carrying rule `code`, whatever the finding's status. */
function subjectsWithRule(index: ReportIndex, code: string): string[] {
  return [
    ...new Set(
      index
        .latestFindings()
        .filter((f) => f.finding.rule === code && f.finding.status !== 'pass')
        .map((f) => f.subject),
    ),
    // Codepoint order, not locale order — the expected list below has to be stable
    // wherever the suite runs.
  ].sort();
}

describe('cpu_shares on reserved tier 10 — rediscovered by query', () => {
  it('groups the *arr family under one rule, in the committed fixtures', async () => {
    const index = await buildIndex(FIXTURE_REPORTS, { cacheFile: null });
    const subjects = subjectsWithRule(index, 'CPU2');

    for (const app of ARR_FAMILY) expect(subjects).toContain(app);

    const group = index.groupByRule().find((g) => g.rule === 'CPU2' && g.status === 'fail')!;
    expect(group.title).toBe('cpu_shares on reserved tier 10');
    expect(group.severity).toBe('minor');
  });

  it('finds qBittorrent, which has no report page of its own', async () => {
    const index = await buildIndex(FIXTURE_REPORTS, { cacheFile: null });

    // Nothing was ever audited for it beyond the roll-up row.
    const records = index.forSubject('qBittorrent');
    expect(records).toHaveLength(2);
    for (const r of records) expect(r.meta.imported_source).toBe('docmost-rollup');

    // And yet the finding is there — carried over from the sentence in another app's
    // report, marked `unverified` because nobody looked at qBittorrent's compose.
    const finding = records
      .flatMap((r) => r.meta.findings)
      .find((f) => f.rule === 'CPU2')!;
    expect(finding).toBeDefined();
    expect(finding.status).toBe('unverified');
    expect(finding.severity).toBe('minor');
    expect(finding.note).toMatch(/Prowlarr/);
  });

  it('never lets an inferred finding masquerade as an observed one', async () => {
    const index = await buildIndex(FIXTURE_REPORTS, { cacheFile: null });
    for (const { subject, finding } of index.latestFindings()) {
      if (!/named by the .* report as sharing this defect/.test(finding.note ?? '')) continue;
      expect(finding.status, `${subject} ${finding.rule}`).toBe('unverified');
    }
  });

  it('an unverified finding contributes nothing to risk', async () => {
    const index = await buildIndex(FIXTURE_REPORTS, { cacheFile: null });
    for (const rec of index.forSubject('qBittorrent')) {
      expect(rec.meta.findings.every((f) => f.status !== 'fail')).toBe(true);
      expect(rec.meta.risk_score).toBe(0);
    }
  });

  it.runIf(HAS_ARCHIVE)(
    'holds over the whole imported archive, not just the fixtures',
    async () => {
      const index = await buildIndex(DATA_REPORTS, { cacheFile: null });
      expect(index.subjects()).toHaveLength(69);

      const subjects = subjectsWithRule(index, 'CPU2');
      for (const app of ARR_FAMILY) expect(subjects).toContain(app);

      // The corpus is wider than the sentence: four more apps state the same defect in
      // their own reports. Pinned so a regression in either direction is visible.
      expect(subjects).toEqual([
        'Duplicati',
        'FileBrowser',
        'Lidarr',
        'Nextcloud',
        'Prowlarr',
        'Radarr',
        'Sonarr',
        'WireGuardEasyHost',
        'qBittorrent',
      ]);
    },
  );
});

describe('the imported archive', () => {
  it.runIf(HAS_ARCHIVE)('is 69 subjects × 2 legs', async () => {
    const index = await buildIndex(DATA_REPORTS, { cacheFile: null });
    expect(index.size).toBe(138);
    expect(index.broken).toEqual([]);
  });

  it.runIf(HAS_ARCHIVE)(
    'records every bench-denied functional leg as blocked, never as a verdict',
    async () => {
      const index = await buildIndex(DATA_REPORTS, { cacheFile: null });
      const blocked = index
        .subjects()
        .map((s) => index.latestAny(s, 'functional')!)
        .filter((r) => r.meta.status === 'blocked');

      expect(blocked.length).toBeGreaterThan(45);
      for (const r of blocked) {
        // The distinction the product exists to make: no verdict, and a reason that is
        // about the bench rather than about the subject.
        expect(r.meta.verdict, r.subject).toBeNull();
        expect(r.meta.blocked_reason, r.subject).toBe('bench_unavailable');
        expect(r.meta.top_severity, r.subject).toBe('none');
        expect(r.meta.risk_score, r.subject).toBe(0);
      }
    },
  );

  it.runIf(HAS_ARCHIVE)(
    'surfaces the suspected-Critical E9 queue from blocked legs',
    async () => {
      const index = await buildIndex(DATA_REPORTS, { cacheFile: null });
      const e9 = index.groupByRule().find((g) => g.rule === 'E9' && g.status === 'unverified')!;
      expect(e9).toBeDefined();
      expect(e9.severity).toBe('critical');
      expect(e9.subjects).toContain('Prowlarr');
      expect(e9.subjects.length).toBeGreaterThan(5);
    },
  );
});
