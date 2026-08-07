import { describe, expect, it } from 'vitest';
import type { Finding, Severity } from '../../shared/types.js';
import {
  SEVERITY_ORDER,
  compareSeverity,
  gate,
  isFailing,
  maxSeverity,
  riskScore,
  topSeverity,
} from './severity.js';

const f = (over: Partial<Finding> = {}): Finding => ({
  rule: 'X',
  severity: 'minor',
  status: 'fail',
  ...over,
});

describe('severity ordering', () => {
  it('orders by rank, not by string', () => {
    const sorted = (['critical', 'none', 'major', 'minor'] as Severity[]).sort(compareSeverity);
    expect(sorted).toEqual([...SEVERITY_ORDER]);
    // the trap: alphabetically 'critical' sorts before 'major' and 'minor' before 'none'
    expect(sorted).not.toEqual(['critical', 'major', 'minor', 'none']);
  });

  it('takes the worst of a set, empty set is none', () => {
    expect(maxSeverity(['minor', 'critical', 'major'])).toBe('critical');
    expect(maxSeverity([])).toBe('none');
  });
});

describe('risk score', () => {
  it('is 100·Critical + 10·Major + 1·Minor over failing findings', () => {
    const findings = [
      f({ severity: 'critical' }),
      f({ severity: 'critical' }),
      f({ severity: 'major' }),
      f({ severity: 'major' }),
      f({ severity: 'major' }),
      f({ severity: 'minor' }),
      f({ severity: 'minor' }),
    ];
    expect(riskScore(findings)).toBe(232);
  });

  it('counts only fails — pass, n-a and advisory weigh nothing', () => {
    expect(
      riskScore([
        f({ severity: 'critical', status: 'pass' }),
        f({ severity: 'critical', status: 'n-a' }),
        f({ severity: 'critical', status: 'advisory' }),
        f({ severity: 'minor', status: 'fail' }),
      ]),
    ).toBe(1);
  });

  it('excludes unverified: a suspected Critical is not scored against the subject', () => {
    expect(riskScore([f({ severity: 'critical', status: 'unverified' })])).toBe(0);
    expect(topSeverity([f({ severity: 'critical', status: 'unverified' })])).toBe('none');
    expect(isFailing(f({ status: 'unverified' }))).toBe(false);
  });

  it('takes the tier from failing findings only', () => {
    expect(topSeverity([f({ severity: 'critical', status: 'pass' }), f({ severity: 'major' })])).toBe(
      'major',
    );
    expect(topSeverity([])).toBe('none');
  });
});

describe('gate precedence', () => {
  it('any Critical fail forces non-compliant at tier critical', () => {
    expect(gate([f({ severity: 'critical' }), f({ severity: 'minor' })])).toEqual({
      verdict: 'non-compliant',
      top_severity: 'critical',
      risk_score: 101,
    });
  });

  it('otherwise the worst fail sets the tier', () => {
    expect(gate([f({ severity: 'major' }), f({ severity: 'minor' })])).toEqual({
      verdict: 'non-compliant',
      top_severity: 'major',
      risk_score: 11,
    });
  });

  it('nothing failing is compliant', () => {
    expect(gate([f({ status: 'pass', severity: 'none' })])).toEqual({
      verdict: 'compliant',
      top_severity: 'none',
      risk_score: 0,
    });
    expect(gate([])).toEqual({ verdict: 'compliant', top_severity: 'none', risk_score: 0 });
  });

  it('an unverified Critical alone does not gate — it is suspected, not observed', () => {
    expect(gate([f({ severity: 'critical', status: 'unverified' })]).verdict).toBe('compliant');
  });

  it('an errored mandatory rule outranks the fail gates and can never yield compliant', () => {
    expect(gate([], { erroredMandatory: true })).toEqual({
      verdict: 'errored',
      top_severity: 'none',
      risk_score: 0,
    });
    expect(gate([f({ severity: 'major' })], { erroredMandatory: true }).verdict).toBe('errored');
  });

  it('reports the tier even when the verdict is errored, so severity is not lost', () => {
    expect(gate([f({ severity: 'critical' })], { erroredMandatory: true })).toEqual({
      verdict: 'errored',
      top_severity: 'critical',
      risk_score: 100,
    });
  });

  it('deferred outranks everything: nothing was judged', () => {
    expect(
      gate([f({ severity: 'critical' })], { deferred: true, erroredMandatory: true }).verdict,
    ).toBe('deferred');
  });
});
