/**
 * The derived views behind `ReportIndex`'s reads must answer exactly what the scans they
 * replaced answered (2026-10-27). The reference below is the old implementation, verbatim in
 * behaviour: filter the whole archive, sort newest first, take the first match.
 */

import { describe, expect, it } from 'vitest';

import type { AssayRecord } from '../../shared/types.js';
import { ReportIndex } from './index.js';

const SUBJECTS = ['yundera~Alpha', 'yundera~beta', 'yundera~Gamma', 'foss~Alpha'];
const SECTIONS = ['static', 'functional', 'functional@foss', 'currency'];
const STATUSES = ['done', 'blocked', 'running', 'done'] as const;

function record(i: number, rnd: () => number): AssayRecord {
  const subject = SUBJECTS[Math.floor(rnd() * SUBJECTS.length)]!;
  const [origin, name] = subject.split('~') as [string, string];
  const section = SECTIONS[Math.floor(rnd() * SECTIONS.length)]!;
  // Few distinct start times, so ties on `started_at` — broken by path — are common.
  const day = 1 + Math.floor(rnd() * 5);
  const started_at = rnd() < 0.05 ? undefined : `2026-10-0${day}T10:00:00.000Z`;
  return {
    path: `${origin}/${name}/r${String(i).padStart(4, '0')}-${section}.md`,
    subject,
    origin,
    name,
    file: `r${i}.md`,
    meta: {
      subject: name,
      section,
      status: STATUSES[Math.floor(rnd() * STATUSES.length)],
      ...(started_at ? { started_at } : {}),
    },
  } as unknown as AssayRecord;
}

/** Deterministic, so a failure reproduces. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
}

function byNewestFirst(a: AssayRecord, b: AssayRecord): number {
  const at = String(a.meta.started_at ?? '');
  const bt = String(b.meta.started_at ?? '');
  if (at !== bt) return bt.localeCompare(at);
  return a.path.localeCompare(b.path);
}

/** What `ReportIndex` answered before it kept derived views. */
function reference(records: AssayRecord[]) {
  const forSubject = (s: string) => records.filter((r) => r.subject === s).sort(byNewestFirst);
  return {
    all: () => [...records].sort(byNewestFirst),
    forSubject,
    subjects: () => [...new Set(records.map((r) => r.subject))].sort((a, b) => a.localeCompare(b)),
    sections: () =>
      [...new Set(records.map((r) => r.meta.section))].sort((a, b) => a.localeCompare(b)),
    latest: (s: string, sec: string) =>
      forSubject(s).find((r) => r.meta.section === sec && r.meta.status === 'done') ?? null,
    latestAny: (s: string, sec: string) => forSubject(s).find((r) => r.meta.section === sec) ?? null,
  };
}

function expectSame(index: ReportIndex, records: AssayRecord[]): void {
  const ref = reference(records);
  expect(index.all().map((r) => r.path)).toEqual(ref.all().map((r) => r.path));
  expect(index.subjects()).toEqual(ref.subjects());
  expect(index.sections()).toEqual(ref.sections());
  for (const s of [...SUBJECTS, 'yundera~Nobody']) {
    expect(index.forSubject(s).map((r) => r.path)).toEqual(ref.forSubject(s).map((r) => r.path));
    for (const sec of [...SECTIONS, 'retired']) {
      expect(index.latest(s, sec)?.path ?? null).toBe(ref.latest(s, sec)?.path ?? null);
      expect(index.latestAny(s, sec)?.path ?? null).toBe(ref.latestAny(s, sec)?.path ?? null);
    }
  }
}

describe('ReportIndex lookups', () => {
  it('answer exactly what the full scans answered', () => {
    const rnd = seeded(7);
    const records = Array.from({ length: 400 }, (_, i) => record(i, rnd));
    expectSame(new ReportIndex('/r', records), records);
  });

  it('stay right through upserts, replacements and removals', () => {
    const rnd = seeded(11);
    const records = new Map<string, AssayRecord>();
    const index = new ReportIndex('/r');
    for (let i = 0; i < 300; i++) {
      const roll = rnd();
      if (roll < 0.6 || records.size === 0) {
        const r = record(i, rnd);
        records.set(r.path, r);
        index.upsert(r);
      } else if (roll < 0.8) {
        // Replace an existing path with a record whose section and status changed — what a
        // running assay finishing looks like.
        const victim = [...records.keys()][Math.floor(rnd() * records.size)]!;
        const next = { ...record(i, rnd), path: victim };
        records.set(victim, next);
        index.upsert(next);
      } else {
        const victim = [...records.keys()][Math.floor(rnd() * records.size)]!;
        records.delete(victim);
        index.remove(victim);
      }
      // Read in between writes, so a stale view would be caught rather than rebuilt late.
      if (i % 7 === 0) expectSame(index, [...records.values()]);
    }
    expectSame(index, [...records.values()]);
  });

  it('hands out copies, so a caller sorting the result cannot reorder the index', () => {
    const rnd = seeded(3);
    const records = Array.from({ length: 50 }, (_, i) => record(i, rnd));
    const index = new ReportIndex('/r', records);
    index.all().reverse();
    index.forSubject(SUBJECTS[0]!).reverse();
    index.subjects().reverse();
    expectSame(index, records);
  });
});
