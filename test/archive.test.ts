/**
 * The imported archive, checked against the source it came from.
 *
 * The acceptance test for P1 is the last one here: **no subject may import milder than the
 * roll-up says it is.** That is not a style preference. The previous importer derived each
 * verdict from prose it extracted, and on eight of twenty non-compliant subjects it derived
 * something milder than the report's own headline — promoting OpenClaw, TINCatan, Guacamole
 * and ClaudeCode to `compliant` while their pages said Critical. An archive that under-reads
 * its own source is worse than the wiki table it replaces, because the wiki table at least
 * said `⛔`.
 *
 * These run only after `yarn sync`; the committed fixtures are checked separately.
 */

import { describe, expect, it } from 'vitest';

import { buildIndex } from '../src/server/store/index.js';
import { loadConfig } from '../src/server/store/config.js';
import { parseRollup, type RollupRow } from '../src/server/domain/extract.js';
import { SEVERITY_RANK } from '../src/shared/types.js';
import { DATA_REPORTS, existsSync } from './helpers.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** The full archive only exists after `yarn sync`; these checks skip without it. */
const HAS_ARCHIVE = existsSync(DATA_REPORTS);

async function rollupRows(): Promise<RollupRow[]> {
  const cfg = await loadConfig();
  const raw = await fs.readFile(
    path.join(cfg.docmost.cacheDir, `${cfg.docmost.rollupSlug}.md`),
    'utf8',
  );
  return parseRollup(raw);
}

describe('the imported archive', () => {
  it.runIf(HAS_ARCHIVE)('is one subject per roll-up row, two legs each', async () => {
    const index = await buildIndex(DATA_REPORTS, { cacheFile: null });
    const rows = await rollupRows();
    expect(index.subjects()).toHaveLength(rows.length);
    // Latest per (subject, leg), not the file count. Reports accumulate — that is what
    // writing timestamped files does, and ARCHITECTURE §4 says so — so the archive grows by
    // 138 files every time n8n re-audits the store. Asserting the total was asserting that
    // the importer had only ever run once.
    expect(index.latestPerSubjectLeg({ status: 'any' })).toHaveLength(rows.length * 2);
    expect(index.size).toBeGreaterThanOrEqual(rows.length * 2);
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

      // No absolute floor: how many legs are bench-blocked is a fact about the demo pool on
      // the day, and it moves. What must hold is the shape of every one of them.
      expect(blocked.length).toBeGreaterThan(0);
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

  it.runIf(HAS_ARCHIVE)('carries no findings list — findings are prose in the body', async () => {
    const index = await buildIndex(DATA_REPORTS, { cacheFile: null });
    for (const rec of index.all()) {
      expect(rec.meta.findings, rec.path).toBeUndefined();
    }
  });

  it.runIf(HAS_ARCHIVE)('never imports a subject milder than its roll-up row', async () => {
    const index = await buildIndex(DATA_REPORTS, { cacheFile: null });
    const rows = await rollupRows();

    const understated: string[] = [];
    for (const row of rows) {
      // Only rows the roll-up actually scored can be compared; `⚠️ errored` and
      // `⬜ not yet run` assert nothing about the subject.
      if (row.kind !== 'compliant' && row.kind !== 'non-compliant') continue;

      const rec = index.latest(row.subject, 'static');
      expect(rec, `${row.subject} has no static assay`).toBeTruthy();
      const got = rec!.meta;

      if (SEVERITY_RANK[got.top_severity] < SEVERITY_RANK[row.severity]) {
        understated.push(
          `${row.subject}: roll-up ${row.severity} risk ${row.risk} → imported ${got.top_severity} risk ${got.risk_score}`,
        );
        continue;
      }
      if (row.kind === 'non-compliant' && got.verdict === 'compliant') {
        understated.push(`${row.subject}: roll-up non-compliant → imported compliant`);
      }
    }

    expect(understated).toEqual([]);
  });

  /**
   * Where the two disagree, **the report headline wins** — principle 3, and the whole point
   * of P1. This test therefore asserts the direction of the disagreement, not its absence.
   *
   * They do disagree, live: on 2026-08-19 the roll-up listed Spliit at risk 223 with a last
   * run of 08-19, while the report page that row links to still declared `risk score 112`
   * from 08-12. n8n updated the row and left the page behind. An importer that "fixed" that
   * by trusting the row would be reintroducing the exact bug P1 removed, so the archive
   * carries 112 and this test records why.
   */
  it.runIf(HAS_ARCHIVE)('takes the headline over the roll-up row where they disagree', async () => {
    const index = await buildIndex(DATA_REPORTS, { cacheFile: null });
    const rows = await rollupRows();

    const mismatched: string[] = [];
    for (const row of rows) {
      if (row.risk === null) continue;
      const got = index.latest(row.subject, 'static')?.meta;
      if (!got) continue;
      // The functional leg deliberately scores 0 and the headline lands on static, so the
      // static score is the whole subject's score and should equal the row verbatim.
      if (got.risk_score !== row.risk) {
        mismatched.push(`${row.subject}: roll-up ${row.risk} → imported ${got.risk_score}`);
      }
    }

    // Every mismatch must be a case where we took the page's own headline. That is the
    // invariant — not agreement with the row, which is n8n's to keep in step.
    const cfg = await loadConfig();
    for (const line of mismatched) {
      const subject = line.split(':')[0]!;
      const row = rows.find((r) => r.subject === subject)!;
      const got = index.latest(subject, 'static')!.meta;
      const page = await fs.readFile(path.join(cfg.docmost.cacheDir, `${row.slug}.md`), 'utf8');
      const headline = /risk score\s+(\d+)/i.exec(page)?.[1];
      expect(headline, `${line} — no headline in the page`).toBeDefined();
      expect(Number(headline), line).toBe(got.risk_score);
    }
  });
});
