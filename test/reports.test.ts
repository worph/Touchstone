/**
 * Invariant 1 of IMPLEMENTATION.md §5: round-trip.
 *
 * The folder is the archive of record, so a read/write cycle has to be lossless in both
 * directions — byte-identical in the body, value-for-value in the frontmatter, and
 * *including keys this codebase has never heard of*. The imported corpus is full of them
 * (`imported_from`, `rollup_result`, `compose_sha`), and a future producer will add more.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  parseReportMeta,
  readReport,
  renderReport,
  reportRelPathFor,
  riskScore,
  writeReport,
  ReportFormatError,
} from '../src/server/store/reports.js';
import { FIXTURE_REPORTS, fixtureFiles } from './helpers.js';

const tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-reports-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('report files', () => {
  it('round-trips every committed fixture byte-for-byte', async () => {
    const files = await fixtureFiles();
    expect(files.length).toBeGreaterThanOrEqual(10);

    const dir = await tmp();
    for (const file of files) {
      const original = await fs.readFile(file, 'utf8');
      const parsed = await readReport(file, FIXTURE_REPORTS);

      // Body is a verbatim slice of the source, not a re-render of it.
      expect(original.endsWith(parsed.body)).toBe(true);

      const rendered = renderReport(parsed.meta, parsed.body);
      const written = await writeReport(dir, parsed.meta, parsed.body);
      const reread = await readReport(written.path, dir);

      expect(reread.body).toBe(parsed.body);
      expect(reread.meta).toEqual(parsed.meta);
      // And a second render of the re-read file is stable — no drift on repeated writes.
      expect(renderReport(reread.meta, reread.body)).toBe(rendered);
    }
  });

  it('preserves frontmatter keys it knows nothing about', async () => {
    const dir = await tmp();
    const meta = {
      subject: 'Prowlarr',
      leg: 'static' as const,
      standard: 'Static Review Protocol',
      standard_version: 3,
      status: 'done' as const,
      verdict: 'non-compliant' as const,
      top_severity: 'major' as const,
      risk_score: 13,
      blocked_reason: null,
      started_at: '2026-08-06T00:00:00Z',
      finished_at: '2026-08-06T00:00:00Z',
      findings: [{ rule: 'CPU2', severity: 'minor' as const, status: 'fail' as const }],
      // Not in AssayMeta. Must survive anyway.
      invented_by_a_future_producer: { nested: ['a', 1, null], flag: true },
      rollup_result: '⚠️ errored · try 1',
    };
    const body = '\n# heading\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';

    const { path: file } = await writeReport(dir, meta, body);
    const back = await readReport(file, dir);

    expect(back.meta.invented_by_a_future_producer).toEqual(meta.invented_by_a_future_producer);
    expect(back.meta.rollup_result).toBe('⚠️ errored · try 1');
    expect(back.body).toBe(body);
  });

  it('names files <Subject>/<ISO with : replaced by ->-<leg>.md', async () => {
    const rel = reportRelPathFor({
      subject: 'OpenClaw',
      leg: 'static',
      started_at: '2026-08-05T09:14:22Z',
    } as never);
    expect(rel).toBe('OpenClaw/2026-08-05T09-14-22Z-static.md');

    // Every fixture on disk obeys the same convention.
    for (const file of await fixtureFiles()) {
      const parsed = await readReport(file, FIXTURE_REPORTS);
      expect(parsed.path).toBe(reportRelPathFor(parsed.meta));
    }
  });

  it('rejects a file with no frontmatter rather than inventing one', () => {
    expect(() => parseReportMeta('# just a heading\n')).toThrow(ReportFormatError);
  });

  it('scores risk as 100·Critical + 10·Major + 1·Minor over failing findings only', () => {
    expect(
      riskScore([
        { rule: 'A', severity: 'critical', status: 'fail' },
        { rule: 'B', severity: 'major', status: 'fail' },
        { rule: 'C', severity: 'minor', status: 'fail' },
        { rule: 'D', severity: 'critical', status: 'unverified' },
        { rule: 'E', severity: 'critical', status: 'pass' },
      ]),
    ).toBe(111);
  });

  it('is a no-op when rewriting identical content', async () => {
    const dir = await tmp();
    const file = (await fixtureFiles())[0]!;
    const parsed = await readReport(file, FIXTURE_REPORTS);
    expect((await writeReport(dir, parsed.meta, parsed.body)).written).toBe(true);
    expect((await writeReport(dir, parsed.meta, parsed.body)).written).toBe(false);
  });
});
