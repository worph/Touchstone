import { describe, expect, it } from 'vitest';
import type { Severity } from '../../shared/types.js';
import {
  SEVERITY_ORDER,
  compareSeverity,
  isSubjectVerdict,
  maxSeverity,
  parseSeverity,
} from './severity.js';

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

describe('parseSeverity', () => {
  it('accepts the capitalisation the agent actually emits', () => {
    expect(parseSeverity('Critical')).toBe('critical');
    expect(parseSeverity('Major')).toBe('major');
    expect(parseSeverity('Minor')).toBe('minor');
    expect(parseSeverity('none')).toBe('none');
    expect(parseSeverity(' CRITICAL ')).toBe('critical');
  });

  it('returns null rather than none for anything it cannot read', () => {
    // The distinction that matters: `none` is a tier the assay declared, `null` is a tier
    // we failed to parse. Collapsing the second into the first is how a Critical app is
    // silently promoted to compliant.
    expect(parseSeverity('needs-changes')).toBeNull();
    expect(parseSeverity('')).toBeNull();
    expect(parseSeverity(undefined)).toBeNull();
    expect(parseSeverity(null)).toBeNull();
  });
});

describe('isSubjectVerdict', () => {
  it('separates what a subject earned from what infra imposed', () => {
    expect(isSubjectVerdict('compliant')).toBe(true);
    expect(isSubjectVerdict('non-compliant')).toBe(true);
    expect(isSubjectVerdict('errored')).toBe(false);
    expect(isSubjectVerdict('deferred')).toBe(false);
    expect(isSubjectVerdict(null)).toBe(false);
  });
});
