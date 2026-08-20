import { describe, expect, it } from 'vitest';
import { FIXTURE_RECORDS, makeRecord } from './fixtures.js';
import { hallmarks, latestDone, legState, sortNewestFirst, subjectHallmark } from './hallmark.js';

const NOW = Date.parse('2026-08-06T12:00:00Z');

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
    expect(latestDone(records, 'App', 'static')?.meta.verdict).toBe('non-compliant');
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

    const { state, legs } = subjectHallmark('App', records, { now: NOW });

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
    const { state } = subjectHallmark('App', records, { now: NOW });
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
    const { state, legs } = subjectHallmark('App', records, { now: NOW });
    expect(state.static?.meta.status).toBe('done');
    expect(legs.static?.stale).toBe(false);
  });
});

describe('subject row', () => {
  it('sums risk over the legs and ages off the newest done assay', () => {
    const { state } = subjectHallmark('OpenClaw', FIXTURE_RECORDS, { now: NOW });
    expect(state.risk).toBe(232); // static declared 232; the functional leg is blocked and scores 0
    expect(state.age_days).toBe(1); // static ran 2026-08-05, "now" is 2026-08-06
  });

  it('a subject with no completed assay has no age', () => {
    const { state } = subjectHallmark('Beacon', FIXTURE_RECORDS, { now: NOW });
    expect(state.static).toBeNull();
    expect(state.functional?.meta.status).toBe('blocked');
    expect(state.age_days).toBeNull();
    expect(state.risk).toBe(0);
  });

  it('lists every subject, risk descending', () => {
    const rows = hallmarks(FIXTURE_RECORDS, { now: NOW });
    expect(rows.map((r) => r.name)).toContain('Beacon');
    expect(rows[0]?.name).toBe('OpenClaw');
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
