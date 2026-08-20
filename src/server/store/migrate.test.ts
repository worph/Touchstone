/**
 * The archive layout migration.
 *
 * Everything here is about a migration that has to be *safe to fail*, because it is tidying:
 * `coerceMeta` defaults a missing `origin`, so an archive left unmoved still indexes and
 * renders. What must never happen is losing a report to it.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ORIGIN } from '../../shared/subject.js';
import { buildIndex } from './index.js';
import { migrateArchiveLayout } from './migrate.js';

let dir: string;
let reports: string;

const REPORT = (subject: string, section = 'static') =>
  [
    '---',
    `subject: ${subject}`,
    `section: ${section}`,
    'standard: Static Review Protocol',
    'standard_version: 3',
    'status: done',
    'verdict: compliant',
    'top_severity: none',
    'risk_score: 0',
    'started_at: 2026-08-05T09:14:22Z',
    'finished_at: 2026-08-05T09:29:41Z',
    '---',
    '',
    `# ${subject}`,
    '',
  ].join('\n');

async function write(rel: string, body: string): Promise<void> {
  const abs = path.join(reports, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
}

async function tree(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of (await fs.readdir(d, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.push(path.relative(reports, abs).split(path.sep).join('/'));
    }
  };
  await walk(reports);
  return out.sort();
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-migrate-'));
  reports = path.join(dir, 'reports');
  await fs.mkdir(reports, { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the archive layout migration', () => {
  it('moves a legacy subject directory under the default origin', async () => {
    await write('OpenClaw/2026-08-05T09-14-22Z-static.md', REPORT('OpenClaw'));
    await write('Ntfy/2026-08-05T09-14-22Z-static.md', REPORT('Ntfy'));

    const result = await migrateArchiveLayout(reports);

    expect(result.subjects).toBe(2);
    expect(result.moved).toBe(2);
    expect(result.conflicts).toEqual([]);
    expect(await tree()).toEqual([
      `${DEFAULT_ORIGIN}/Ntfy/2026-08-05T09-14-22Z-static.md`,
      `${DEFAULT_ORIGIN}/OpenClaw/2026-08-05T09-14-22Z-static.md`,
    ]);
  });

  it('is a silent no-op on an archive that is already migrated', async () => {
    await write(`${DEFAULT_ORIGIN}/OpenClaw/2026-08-05T09-14-22Z-static.md`, REPORT('OpenClaw'));
    const before = await tree();

    const result = await migrateArchiveLayout(reports);

    // `subjects: 0` is what `logArchiveMigration` keys "say nothing" off, so a boot with a
    // migrated archive is silent rather than reporting a migration of nothing.
    expect(result.subjects).toBe(0);
    expect(result.moved).toBe(0);
    expect(await tree()).toEqual(before);
  });

  it('is idempotent — running it twice changes nothing the second time', async () => {
    await write('OpenClaw/2026-08-05T09-14-22Z-static.md', REPORT('OpenClaw'));
    await migrateArchiveLayout(reports);
    const after = await tree();

    const second = await migrateArchiveLayout(reports);
    expect(second.subjects).toBe(0);
    expect(await tree()).toEqual(after);
  });

  it('removes the source when an identical file is already at the target', async () => {
    // The state a crash halfway through leaves: some files moved, the directory still there.
    await write('OpenClaw/a-static.md', REPORT('OpenClaw'));
    await write(`${DEFAULT_ORIGIN}/OpenClaw/a-static.md`, REPORT('OpenClaw'));

    const result = await migrateArchiveLayout(reports);

    expect(result.deduped).toBe(1);
    expect(result.moved).toBe(0);
    expect(await tree()).toEqual([`${DEFAULT_ORIGIN}/OpenClaw/a-static.md`]);
  });

  it('keeps both copies when the target differs, and says so', async () => {
    await write('OpenClaw/a-static.md', REPORT('OpenClaw'));
    await write(`${DEFAULT_ORIGIN}/OpenClaw/a-static.md`, REPORT('OpenClaw').replace('risk_score: 0', 'risk_score: 42'));

    const result = await migrateArchiveLayout(reports);

    // Reports are the archive of record. Losing one to tidying is a worse outcome than an
    // untidy tree, so a divergence is reported for a human rather than resolved by guessing.
    expect(result.conflicts).toEqual(['OpenClaw/a-static.md']);
    expect(result.moved).toBe(0);
    expect(await tree()).toEqual([
      'OpenClaw/a-static.md',
      `${DEFAULT_ORIGIN}/OpenClaw/a-static.md`,
    ]);
  });

  it('leaves anything that is not a report where it is', async () => {
    await write('OpenClaw/a-static.md', REPORT('OpenClaw'));
    // What a `writeReport` that died between the temp write and the rename leaves behind.
    await write('OpenClaw/a-static.md.tmp-1234', 'half a file');

    await migrateArchiveLayout(reports);

    expect(await tree()).toEqual([
      'OpenClaw/a-static.md.tmp-1234',
      `${DEFAULT_ORIGIN}/OpenClaw/a-static.md`,
    ]);
  });

  it('does not need to have run for the archive to index correctly', async () => {
    // The claim that makes this migration cosmetic rather than load-bearing: a read-only data
    // dir, or a failure halfway, must not cost the archive. `coerceMeta` supplies the origin,
    // so an unmigrated file indexes under exactly the subject it would have after the move.
    await write('OpenClaw/2026-08-05T09-14-22Z-static.md', REPORT('OpenClaw'));

    const unmigrated = await buildIndex(reports, { cacheFile: null });
    const before = unmigrated.all()[0]!;
    expect(before.origin).toBe(DEFAULT_ORIGIN);
    expect(before.name).toBe('OpenClaw');

    await migrateArchiveLayout(reports);
    const migrated = await buildIndex(reports, { cacheFile: null });

    // Same identity either side of the move; only the path on disk changed.
    expect(migrated.all()[0]!.subject).toBe(before.subject);
    expect(migrated.all()[0]!.path).not.toBe(before.path);
  });

  it('reports a failure instead of throwing', async () => {
    // A file where the reports root should be: `readdir` fails, and the app must still boot.
    const notADir = path.join(dir, 'not-a-dir');
    await fs.writeFile(notADir, 'x', 'utf8');

    const result = await migrateArchiveLayout(notADir);

    expect(result.failed).toBeTruthy();
    expect(result.moved).toBe(0);
  });

  it('treats a missing archive as nothing to do', async () => {
    const result = await migrateArchiveLayout(path.join(dir, 'nope'));
    expect(result.failed).toBeUndefined();
    expect(result.subjects).toBe(0);
  });
});
