import { describe, expect, it } from 'vitest';

import type { AssayRecord, SubjectState } from '@shared/types';
import { daysSince, isReading, readingColumns, readingOf, readingRank, readingRows, readingSections } from './reading';

function rec(meta: Record<string, unknown>): AssayRecord {
  return {
    meta: {
      subject: 'App',
      section: 'currency',
      standard: 'Image Currency',
      standard_version: 1,
      status: 'done',
      verdict: null,
      top_severity: 'none',
      risk_score: 0,
      started_at: '2026-08-22T10:00:00Z',
      finished_at: '2026-08-22T10:00:06Z',
      ...meta,
    },
    path: 'yundera/App/x-currency.md',
    subject: 'yundera~App' as SubjectState['name'],
    origin: 'yundera',
    name: 'App',
    file: 'x-currency.md',
  } as AssayRecord;
}

function subject(sections: Record<string, AssayRecord | null>): SubjectState {
  return {
    name: 'yundera~App' as SubjectState['name'],
    origin: 'yundera',
    label: 'App',
    sections,
    static: sections.static ?? null,
    functional: sections.functional ?? null,
    risk: 0,
    age_days: 1,
  };
}

describe('what counts as a reading', () => {
  it('is `scores: false` and nothing else', () => {
    expect(isReading(rec({ scores: false }))).toBe(true);
    expect(isReading(rec({}))).toBe(false);
    expect(isReading(rec({ scores: true }))).toBe(false);
    expect(isReading(null)).toBe(false);
  });

  /** The column exists because the archive has one, not because anything named `currency`. */
  it('finds the reading sections in a set of rows without being told their names', () => {
    const rows = [
      subject({ static: rec({ scores: true, section: 'static' }), currency: rec({ scores: false }) }),
      subject({ licences: rec({ scores: false, section: 'licences' }) }),
    ];
    expect(readingSections(rows)).toEqual(['currency', 'licences']);
  });

  it('finds none when nothing measures', () => {
    expect(readingSections([subject({ static: rec({}) })])).toEqual([]);
  });
});

describe('the cell', () => {
  it('shows the badge the executor wrote', () => {
    const r = readingOf(subject({ currency: rec({ scores: false, badge: '2 behind · 400d', badge_state: 'bad' }) }), 'currency');
    expect(r?.badge).toBe('2 behind · 400d');
    expect(r?.state).toBe('bad');
  });

  /**
   * The failure this whole check must not have. A blocked reading means "we could not look",
   * and a cell that read `ok` for it would be worse than no check at all.
   */
  it('never reads a blocked reading as ok', () => {
    const r = readingOf(
      subject({ currency: rec({ scores: false, status: 'blocked', badge_state: 'ok' }) }),
      'currency',
    );
    expect(r?.state).toBe('unknown');
    expect(r?.badge).toBe('unknown');
    expect(r?.blocked).toBe(true);
  });

  it('falls back to unknown when the executor declared no state', () => {
    expect(readingOf(subject({ currency: rec({ scores: false, badge: 'x' }) }), 'currency')?.state).toBe('unknown');
  });

  it('is null for a section that judges, so no verdict is ever drawn as a badge', () => {
    expect(readingOf(subject({ static: rec({ section: 'static' }) }), 'static')).toBeNull();
  });
});

describe('sorting', () => {
  /**
   * `unknown` sits between `ok` and `warn`. It is not good news, and it must not outrank a
   * measurement that actually found something.
   */
  it('ranks worst last so a descending sort puts it first', () => {
    const of = (state: string) =>
      readingRank(subject({ currency: rec({ scores: false, badge_state: state }) }), 'currency');
    expect(of('ok')).toBeLessThan(of('unknown'));
    expect(of('unknown')).toBeLessThan(of('warn'));
    expect(of('warn')).toBeLessThan(of('bad'));
    expect(readingRank(subject({}), 'currency')).toBe(-1);
  });
});

describe('columns and ages', () => {
  it('uses the declared columns, keeping the since hint', () => {
    const record = rec({
      scores: false,
      columns: [{ key: 'a', label: 'A', align: 'right', kind: 'since' }],
      rows: [{ a: '2026-01-01' }],
    });
    expect(readingColumns(record)).toEqual([{ key: 'a', label: 'A', align: 'right', kind: 'since' }]);
    expect(readingRows(record)).toEqual([{ a: '2026-01-01' }]);
  });

  it('falls back to the union of row keys when none were declared', () => {
    expect(readingColumns(rec({ scores: false, rows: [{ a: 1 }, { b: 2 }] })).map((c) => c.key)).toEqual(['a', 'b']);
  });

  /**
   * The arithmetic that lets this check run only when an app is audited: the record stores
   * the absolute moment the app fell behind, and the age is computed on every render.
   */
  it('computes an age from an absolute date, and refuses anything else', () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    expect(daysSince('2025-07-18T00:00:00Z', now)).toBe(400);
    expect(daysSince('2026-08-22T00:00:00Z', now)).toBe(0);
    // A date in the future is a clock disagreement, not negative staleness.
    expect(daysSince('2026-09-01T00:00:00Z', now)).toBe(0);
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince('not a date', now)).toBeNull();
  });
});
