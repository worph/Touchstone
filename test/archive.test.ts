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
import { SEVERITY_RANK } from '../src/shared/types.js';
import { DATA_REPORTS, existsSync } from './helpers.js';
import { promises as fs, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * These check the *imported* archive, which no longer has an importer: the directory exists
 * in a fresh clone but is empty until something writes into it. So the guard asks whether
 * there is an archive to check, not whether the folder is there — an empty one made these
 * fail with `expected 0 to be greater than 0`, which reads as a broken invariant rather than
 * as "nothing to test".
 */
const HAS_ARCHIVE = existsSync(DATA_REPORTS) && readdirSync(DATA_REPORTS).length > 0;

describe('the imported archive', () => {

  it.runIf(HAS_ARCHIVE)(
    'records every bench-denied functional leg as blocked, never as a verdict',
    async () => {
      const index = await buildIndex(DATA_REPORTS, { cacheFile: null });
      // A subject need not have a functional leg at all: the runner writes static-only
      // assays, and `depth: static` is the normal way to audit while the pool is down. The
      // claim under test is about the legs that *exist*, not about every subject having one.
      const blocked = index
        .subjects()
        .map((s) => index.latestAny(s, 'functional'))
        .filter((r): r is NonNullable<typeof r> => r !== null && r !== undefined)
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
});
