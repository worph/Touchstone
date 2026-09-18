/**
 * The Overview's derived facts.
 *
 * `deriveBacklog` is the one that has been wrong in production: it reads the *archive*, so
 * everything it returns is history. The page pairs it with `GET /alerts`, which is the live
 * condition, and shows the banner only for the second — reading a leftover blocked record as
 * a current outage is how this page announced "Bench pool unavailable" over a healthy pool.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_ORIGIN, subjectKey } from '@shared/subject';

import type { AssayRecord, SubjectState } from '@shared/types';
import { deriveBacklog, tally } from './overview';

function rec(subject: string, section: string, over: Record<string, unknown> = {}): AssayRecord {
  return {
    meta: {
      subject,
      section,
      standard: 's',
      standard_version: 1,
      status: 'done',
      verdict: 'compliant',
      top_severity: 'none',
      risk_score: 0,
      started_at: '2026-08-20T09:00:00.000Z',
      finished_at: '2026-08-20T09:10:00.000Z',
      ...over,
    },
    path: `${DEFAULT_ORIGIN}/${subject}/x-${section}.md`,
    subject: subjectKey(DEFAULT_ORIGIN, subject),
    origin: DEFAULT_ORIGIN,
    name: subject,
    file: `x-${section}.md`,
  } as AssayRecord;
}

function subject(name: string, sections: Record<string, AssayRecord | null>): SubjectState {
  return {
    name: subjectKey(DEFAULT_ORIGIN, name),
    origin: DEFAULT_ORIGIN,
    label: name,
    sections,
    static: sections.static ?? null,
    functional: sections.functional ?? null,
    risk: 0,
    age_days: 0,
  };
}

const blocked = (subjectName: string, section: string, at: string, reason = 'bench_unavailable') =>
  rec(subjectName, section, { status: 'blocked', verdict: null, blocked_reason: reason, started_at: at });

describe('deriveBacklog', () => {
  it('is null when every section carries a verdict', () => {
    expect(deriveBacklog([subject('Ntfy', { static: rec('Ntfy', 'static') })])).toBeNull();
  });

  /** The whole point of the rewrite: the page must be able to say *who*, not just *how many*. */
  it('names the subject and section behind every blocked record', () => {
    const out = deriveBacklog([
      subject('FileBrowser', {
        static: rec('FileBrowser', 'static'),
        functional: blocked('FileBrowser', 'functional', '2026-08-20T09:34:35.111Z'),
      }),
    ]);
    expect(out).toMatchObject({ reason: 'bench_unavailable', count: 1 });
    expect(out?.items).toEqual([
      { subject: subjectKey(DEFAULT_ORIGIN, 'FileBrowser'), section: 'functional' },
    ]);
    expect(out?.since).toBe('2026-08-20T09:34:35.111Z');
  });

  it('reports the oldest record as `since`, not the newest', () => {
    const out = deriveBacklog([
      subject('A', { functional: blocked('A', 'functional', '2026-08-20T11:00:00.000Z') }),
      subject('B', { functional: blocked('B', 'functional', '2026-08-20T08:00:00.000Z') }),
    ]);
    expect(out?.count).toBe(2);
    expect(out?.since).toBe('2026-08-20T08:00:00.000Z');
  });

  /** Two outages at once: the bigger one is the story, and the smaller is still in the table. */
  it('picks the reason with the most records behind it', () => {
    const out = deriveBacklog([
      subject('A', { functional: blocked('A', 'functional', '2026-08-20T09:00:00.000Z') }),
      subject('B', { functional: blocked('B', 'functional', '2026-08-20T09:00:00.000Z') }),
      subject('C', { functional: blocked('C', 'functional', '2026-08-20T09:00:00.000Z', 'browser_unavailable') }),
    ]);
    expect(out?.reason).toBe('bench_unavailable');
    expect(out?.count).toBe(2);
  });

  /**
   * The backlog is outstanding work. A section the runner is on right now is not outstanding —
   * and the note offering "a re-assay clears it" beside a cell already reading `running` is the
   * present-tense/past-tense confusion this whole component was rewritten to end.
   */
  it('drops a section the live run is already re-assaying', () => {
    const subjects = [
      subject('FileBrowser', {
        functional: blocked('FileBrowser', 'functional', '2026-08-20T09:34:35.111Z'),
      }),
    ];
    const live = {
      subject: subjectKey(DEFAULT_ORIGIN, 'FileBrowser'),
      legs: ['static', 'functional'],
      started_at: '2026-08-20T14:21:59.503Z',
    };
    expect(deriveBacklog(subjects, live)).toBeNull();
  });

  it('keeps a section the live run is NOT covering', () => {
    const subjects = [
      subject('FileBrowser', {
        functional: blocked('FileBrowser', 'functional', '2026-08-20T09:34:35.111Z'),
      }),
    ];
    // The run skipped functional — no bench — so it is still outstanding while the run goes on.
    const live = { subject: subjectKey(DEFAULT_ORIGIN, 'FileBrowser'), legs: ['static'], started_at: '2026-08-20T14:21:59.503Z' };
    expect(deriveBacklog(subjects, live)?.count).toBe(1);
  });

  it('does not confuse two subjects with the same section', () => {
    const subjects = [
      subject('A', { functional: blocked('A', 'functional', '2026-08-20T09:00:00.000Z') }),
      subject('B', { functional: blocked('B', 'functional', '2026-08-20T09:00:00.000Z') }),
    ];
    const live = { subject: subjectKey(DEFAULT_ORIGIN, 'A'), legs: ['functional'], started_at: '2026-08-20T14:21:59.503Z' };
    const out = deriveBacklog(subjects, live);
    expect(out?.count).toBe(1);
    expect(out?.items[0]?.subject).toBe(subjectKey(DEFAULT_ORIGIN, 'B'));
  });

  /** Sections are open-ended now, so this must not know the two names it grew up with. */
  it('counts a section nobody has heard of', () => {
    const out = deriveBacklog([
      subject('A', { security: blocked('A', 'security', '2026-08-20T09:00:00.000Z', 'scanner_unavailable') }),
    ]);
    expect(out).toMatchObject({ reason: 'scanner_unavailable', count: 1 });
    expect(out?.items[0]?.section).toBe('security');
  });
});

/**
 * The block above the table counts what the table draws.
 *
 * It counted a hard-coded pair until 2026-09-18, while the table had already learned to derive
 * its columns from the archive — so a rubric audited on a second platform got a column with no
 * tally above it, and the filter that tally offers could not be reached at all.
 */
describe('tally', () => {
  it('counts every verdict section the archive has, not a fixed pair', () => {
    const t = tally([
      subject('A', {
        static: rec('A', 'static'),
        functional: rec('A', 'functional'),
        'functional@foss': rec('A', 'functional@foss', { verdict: 'non-compliant', top_severity: 'major', target: 'foss', scores: false }),
      }),
    ]);
    expect(t.sections.map((s) => s.id)).toEqual(['static', 'functional', 'functional@foss']);
    expect(t.sections[2]?.tally).toMatchObject({ failing: 1, compliant: 0 });
  });

  /** The two named columns are always offered, so a never-audited archive still filters. */
  it('keeps static and functional even when nothing has been audited', () => {
    const t = tally([subject('A', {})]);
    expect(t.sections.map((s) => s.id)).toEqual(['static', 'functional']);
    expect(t.sections[0]?.tally.notRun).toBe(1);
    expect(t.subjects).toBe(1);
  });

  /** A reading measures; it has no verdict to tally, and a column of its own already. */
  it('leaves a reading out', () => {
    const t = tally([
      subject('A', { currency: rec('A', 'currency', { scores: false, executor: 'currency.sh', verdict: null }) }),
    ]);
    expect(t.sections.map((s) => s.id)).toEqual(['static', 'functional']);
  });
});
