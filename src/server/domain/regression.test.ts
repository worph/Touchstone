import { describe, expect, it } from 'vitest';
import type { Finding } from '../../shared/types.js';
import { makeRecord, type Draft } from './fixtures.js';
import { classify, classifyAgainstHistory, classifyHistory, previousComparable } from './regression.js';

const minor: Finding = { rule: 'C', title: 'cpu_shares', severity: 'minor', status: 'fail' };
const major: Finding = { rule: 'D2', title: 'root + user dir', severity: 'major', status: 'fail' };
const major2: Finding = { rule: 'D3', title: 'missing rationale', severity: 'major', status: 'fail' };
const critical: Finding = { rule: 'A', title: 'auth bypass', severity: 'critical', status: 'fail' };

const at = (day: number) => `2026-08-${String(day).padStart(2, '0')}T00:00:00Z`;

const assay = (day: number, findings: Finding[], over: Partial<Draft> = {}) =>
  makeRecord({ subject: 'App', leg: 'static', at: at(day), findings, ...over });

describe('classification', () => {
  it('calls a rising tier a regression', () => {
    const event = classify(assay(2, [major]), assay(1, [minor]));
    expect(event?.kind).toBe('verdict.regression');
    expect(event?.from).toBe('minor');
    expect(event?.to).toBe('major');
  });

  it('calls a new Critical finding a critical, outranking the regression it also is', () => {
    const event = classify(assay(2, [critical]), assay(1, [minor]));
    expect(event?.kind).toBe('verdict.critical');
    expect(event?.new_criticals).toEqual(['A']);
  });

  it('does not re-fire on a Critical that was already there', () => {
    expect(classify(assay(2, [critical]), assay(1, [critical]))?.kind).toBe('assay.finished');
    // the tier is already critical and cannot rise, so an added Minor is a change
    expect(classify(assay(2, [critical, minor]), assay(1, [critical]))?.kind).toBe(
      'verdict.changed',
    );
  });

  it('calls a tier reaching zero compliant', () => {
    expect(classify(assay(2, []), assay(1, [major]))?.kind).toBe('verdict.compliant');
  });

  it('calls a same-tier different-findings assay changed', () => {
    const event = classify(assay(2, [major2]), assay(1, [major]));
    expect(event?.kind).toBe('verdict.changed');
    expect(event?.from).toBe('major');
    expect(event?.to).toBe('major');
  });

  it('calls an unchanged assay finished', () => {
    expect(classify(assay(2, [major]), assay(1, [major]))?.kind).toBe('assay.finished');
    expect(classify(assay(2, []), assay(1, []))?.kind).toBe('assay.finished');
  });

  it('has no previous to compare on a first assay', () => {
    expect(classify(assay(1, [major]), null)?.kind).toBe('assay.finished');
    expect(classify(assay(1, [major]), null)?.from).toBeNull();
    // a subject that arrives already broken is still worth shouting about
    expect(classify(assay(1, [critical]), null)?.kind).toBe('verdict.critical');
  });
});

describe('errored and blocked are excluded from the comparison entirely', () => {
  it('emits nothing for a blocked assay', () => {
    expect(classify(assay(2, [], { status: 'blocked', blocked_reason: 'bench' }), assay(1, []))).toBeNull();
  });

  it('emits nothing for an errored assay', () => {
    expect(classify(assay(2, [], { verdict: 'errored' }), assay(1, []))).toBeNull();
  });

  it('emits nothing for a running or deferred assay', () => {
    expect(classify(assay(2, [], { status: 'running' }), assay(1, []))).toBeNull();
    expect(classify(assay(2, [], { verdict: 'deferred' }), assay(1, []))).toBeNull();
  });

  it('never uses an errored assay as the baseline', () => {
    // An errored run records no findings. Comparing against it would read as a regression
    // from `none` to `major` — an infra failure showing up as a subject defect.
    const errored = assay(2, [], { verdict: 'errored' });
    expect(classify(assay(3, [major]), errored)?.kind).toBe('assay.finished');
    expect(classify(assay(3, [major]), errored)?.previous).toBeNull();
  });

  it('never uses a blocked assay as the baseline', () => {
    const blocked = assay(2, [], { status: 'blocked', blocked_reason: 'bench unavailable' });
    expect(classify(assay(3, [major]), blocked)?.kind).toBe('assay.finished');
  });

  it('steps back over blocked and errored assays to the last real verdict', () => {
    const history = [
      assay(1, [major]),
      assay(2, [], { status: 'blocked', blocked_reason: 'bench unavailable' }),
      assay(3, [], { verdict: 'errored' }),
    ];
    const current = assay(4, [major]);
    expect(previousComparable(current, [...history, current])?.meta.started_at).toBe(at(1));
    // the outage in the middle produces neither a regression nor a recovery
    expect(classifyAgainstHistory(current, [...history, current])?.kind).toBe('assay.finished');
  });

  it('does not treat a bench outage as a recovery either', () => {
    const history = [
      assay(1, [major]),
      assay(2, [], { status: 'blocked', blocked_reason: 'bench unavailable' }),
    ];
    const recovered = assay(3, []);
    expect(classifyAgainstHistory(recovered, [...history, recovered])?.kind).toBe(
      'verdict.compliant',
    );
  });

  it('compares within a leg, never across legs', () => {
    const staticAssay = makeRecord({ subject: 'App', leg: 'static', at: at(3), findings: [major] });
    const functional = makeRecord({ subject: 'App', leg: 'functional', at: at(2), findings: [] });
    expect(previousComparable(staticAssay, [functional, staticAssay])).toBeNull();
  });
});

describe('history', () => {
  it('drops non-comparable assays from the feed and keeps it newest first', () => {
    const history = [
      assay(1, []),
      assay(2, [minor]),
      assay(3, [], { status: 'blocked', blocked_reason: 'bench unavailable' }),
      assay(4, [critical]),
    ];
    const events = classifyHistory(history);
    expect(events.map((e) => e.kind)).toEqual([
      'verdict.critical', // day 4, compared against day 2
      'verdict.regression', // day 2, compared against day 1
      'assay.finished', // day 1, first comparable
    ]);
  });
});
