import { describe, expect, it } from 'vitest';

import { DEFAULT_ORIGIN, subjectKey } from '../../shared/subject.js';
import { FIXTURE_RECORDS, makeRecord } from './fixtures.js';
import { hallmarks, latestDone, legState, sortNewestFirst, subjectHallmark } from './hallmark.js';
import { recordFor } from '../store/reports.js';

const NOW = Date.parse('2026-08-06T12:00:00Z');
const APP = subjectKey(DEFAULT_ORIGIN, 'App');

describe('leg selection', () => {
  it('takes the newest done assay as the hallmark', () => {
    const records = [
      makeRecord({ subject: 'App', leg: 'static', at: '2026-07-01T00:00:00Z' }),
      makeRecord({
        subject: 'App',
        leg: 'static',
        at: '2026-08-01T00:00:00Z',
        top_severity: 'major',
        risk_score: 10,
      }),
    ];
    expect(legState(records, 'static').hallmark?.meta.started_at).toBe('2026-08-01T00:00:00Z');
    expect(latestDone(records, APP, 'static')?.meta.verdict).toBe('non-compliant');
  });

  it('a blocked leg reads as blocked and never falls back to the older verdict', () => {
    const records = [
      makeRecord({ subject: 'App', leg: 'functional', at: '2026-07-01T00:00:00Z' }),
      makeRecord({
        subject: 'App',
        leg: 'functional',
        at: '2026-08-05T00:00:00Z',
        status: 'blocked',
        blocked_reason: 'bench_unavailable',
      }),
    ];

    const { state, legs } = subjectHallmark(APP, records, { now: NOW });

    // the displayed record is the blocked one …
    expect(state.functional?.meta.status).toBe('blocked');
    expect(state.functional?.meta.verdict).toBeNull();
    expect(state.functional?.meta.blocked_reason).toBe('bench_unavailable');
    // … and July's `compliant` is still reachable as the last verdict, just not as current
    expect(legs.functional?.hallmark?.meta.verdict).toBe('compliant');
    expect(legs.functional?.stale).toBe(true);
  });

  it('a running assay does not become the displayed verdict either', () => {
    const records = [
      makeRecord({
        subject: 'App',
        leg: 'static',
        at: '2026-07-01T00:00:00Z',
        top_severity: 'major',
        risk_score: 10,
      }),
      makeRecord({ subject: 'App', leg: 'static', at: '2026-08-06T00:00:00Z', status: 'running' }),
    ];
    const { state } = subjectHallmark(APP, records, { now: NOW });
    expect(state.static?.meta.status).toBe('running');
    expect(state.static?.meta.verdict).toBeNull();
  });

  it('keeps the verdict when the newest assay is the done one', () => {
    const records = [
      makeRecord({ subject: 'App', leg: 'static', at: '2026-07-01T00:00:00Z', status: 'blocked' }),
      makeRecord({
        subject: 'App',
        leg: 'static',
        at: '2026-08-01T00:00:00Z',
        top_severity: 'major',
        risk_score: 10,
      }),
    ];
    const { state, legs } = subjectHallmark(APP, records, { now: NOW });
    expect(state.static?.meta.status).toBe('done');
    expect(legs.static?.stale).toBe(false);
  });
});

describe('subject row', () => {
  it('sums risk over the legs and ages off the newest done assay', () => {
    const { state } = subjectHallmark(subjectKey(DEFAULT_ORIGIN, 'OpenClaw'), FIXTURE_RECORDS, { now: NOW });
    expect(state.risk).toBe(232); // static declared 232; the functional leg is blocked and scores 0
    expect(state.age_days).toBe(1); // static ran 2026-08-05, "now" is 2026-08-06
  });

  it('a subject with no completed assay has no age', () => {
    const { state } = subjectHallmark(subjectKey(DEFAULT_ORIGIN, 'Beacon'), FIXTURE_RECORDS, { now: NOW });
    expect(state.static).toBeNull();
    expect(state.functional?.meta.status).toBe('blocked');
    expect(state.age_days).toBeNull();
    expect(state.risk).toBe(0);
  });

  it('lists every subject, risk descending', () => {
    const rows = hallmarks(FIXTURE_RECORDS, { now: NOW });
    // `name` is the key; `label` is the app. The Overview renders the second and links by
    // the first, so the row test asserts on the one a person would read.
    expect(rows.map((r) => r.label)).toContain('Beacon');
    expect(rows[0]?.label).toBe('OpenClaw');
    const risks = rows.map((r) => r.risk);
    expect(risks).toEqual([...risks].sort((a, b) => b - a));
    // every functional leg that exists is blocked except Radarr's — the Overview's story
    const withFunctional = rows.filter((r) => r.functional);
    const blocked = withFunctional.filter((r) => r.functional?.meta.status === 'blocked');
    expect(blocked).toHaveLength(withFunctional.length - 1);
  });
});

describe('ordering', () => {
  it('sorts newest first across both legs', () => {
    const history = sortNewestFirst(FIXTURE_RECORDS.filter((r) => r.subject === 'OpenClaw'));
    const times = history.map((r) => Date.parse(r.meta.finished_at || r.meta.started_at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

/**
 * A section that measures rather than judges is invisible to the hallmark, and both halves
 * matter. `scores: false` is written onto the record by the executor, so this needs nothing
 * but the frontmatter the archive already carries.
 */
describe('readings do not move the hallmark', () => {
  const reading = (at: string) =>
    recordFor(
      {
        subject: 'App',
        origin: DEFAULT_ORIGIN,
        section: 'currency',
        standard: 'Image Currency',
        standard_version: 1,
        status: 'done',
        verdict: null,
        top_severity: 'none',
        risk_score: 0,
        scores: false,
        badge: '2 behind · 400d',
        started_at: at,
        finished_at: at,
      },
      `${DEFAULT_ORIGIN}/App/${at.replace(/:/g, '-')}-currency.md`,
    );

  it('does not add to the subject risk', () => {
    const records = [
      makeRecord({ subject: 'App', leg: 'static', at: '2026-08-01T00:00:00Z', top_severity: 'major', risk_score: 13 }),
      // Even a reading that *did* record a score must not be summed: the flag decides, so a
      // future scripted check cannot quietly re-rank the Overview by changing its own numbers.
      { ...reading('2026-08-06T00:00:00Z'), meta: { ...reading('2026-08-06T00:00:00Z').meta, risk_score: 999 } },
    ];
    expect(subjectHallmark(APP, records, { now: NOW }).state.risk).toBe(13);
  });

  /**
   * The trap this rule exists for. A currency reading is taken in seconds on every audit; if
   * it could set `age_days` then every app would read as freshly *audited* the moment it was
   * measured, and the age column is exactly what an operator reads to know how stale a
   * verdict is.
   */
  it('does not make the subject look freshly audited', () => {
    const records = [
      makeRecord({ subject: 'App', leg: 'static', at: '2026-07-27T12:00:00Z' }),
      reading('2026-08-06T12:00:00Z'),
    ];
    expect(subjectHallmark(APP, records, { now: NOW }).state.age_days).toBe(10);
  });

  it('still appears as a section, so the page can draw it', () => {
    const records = [reading('2026-08-06T12:00:00Z')];
    const state = subjectHallmark(APP, records, { now: NOW }).state;
    expect(state.sections.currency?.meta.badge).toBe('2 behind · 400d');
    expect(state.age_days).toBeNull();
  });
});

describe('hallmarks({ include })', () => {
  const TRACKED = subjectKey(DEFAULT_ORIGIN, 'Tracked');

  it('composes a row for a subject the archive has never heard of', () => {
    const rows = hallmarks(FIXTURE_RECORDS, { include: [TRACKED], now: NOW });
    const row = rows.find((r) => r.name === TRACKED);
    expect(row).toBeDefined();
    expect(row?.label).toBe('Tracked');
    expect(row?.origin).toBe(DEFAULT_ORIGIN);
    expect(row?.static).toBeNull();
    expect(row?.functional).toBeNull();
    expect(row?.age_days).toBeNull();
    expect(row?.risk).toBe(0);
  });

  /**
   * The overlap is the whole list, normally: every audited app is also a tracked one. If the
   * union deduplicated by identity rather than by key, the Store page would draw every app
   * twice and React would warn about the duplicate keys rather than anyone noticing the
   * counts were wrong.
   */
  it('does not duplicate a subject that is in both the archive and the registry', () => {
    const archived = hallmarks(FIXTURE_RECORDS, { now: NOW });
    const both = hallmarks(FIXTURE_RECORDS, {
      include: archived.map((r) => r.name),
      now: NOW,
    });
    expect(both.length).toBe(archived.length);
    expect(both).toEqual(archived);
  });

  it('leaves the archive-only list untouched when nothing is included', () => {
    expect(hallmarks(FIXTURE_RECORDS, { now: NOW })).toEqual(
      hallmarks(FIXTURE_RECORDS, { include: [], now: NOW }),
    );
  });

  /** A never-run row has no risk, so it must not displace anything that has one. */
  it('sorts a never-run subject below every scored one', () => {
    const rows = hallmarks(FIXTURE_RECORDS, { include: [TRACKED], now: NOW });
    const at = rows.findIndex((r) => r.name === TRACKED);
    expect(rows.slice(0, at).every((r) => r.risk >= 0)).toBe(true);
    expect(rows.filter((r) => r.risk > 0).every((r) => rows.indexOf(r) < at)).toBe(true);
  });
});
