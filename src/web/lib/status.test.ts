/**
 * `displayFacts` — the one derivation, now that two callers share it.
 *
 * The Overview reads an `AssayRecord` out of the archive; the Trials page reads a `TrialCell`
 * off the wire. They used to be drawn by different code, and the cost was not cosmetic: the
 * trial page's third column *quotes* a hallmark, so two renderings of `blocked` were two
 * things that could disagree about what the archive had recorded. These tests pin the shared
 * behaviour and the one thing the second caller can legitimately not supply.
 */
import { describe, expect, it } from 'vitest';

import { displayFacts, type StatusFacts } from './status';

const NOW = Date.parse('2026-08-22T10:00:00Z');

/** The shape a trial cell arrives in — no `standard`, no `started_at` unless it is running. */
function cell(over: Partial<StatusFacts> = {}): StatusFacts {
  return { status: 'done', verdict: 'compliant', top_severity: 'none', risk_score: 0, ...over };
}

describe('displayFacts', () => {
  it('draws blocked with its own reason, so four conditions do not read as one', () => {
    for (const reason of [
      'bench_unavailable',
      'browser_unavailable',
      'store_unreachable',
      'store_url_unconfigured',
    ]) {
      const s = displayFacts(cell({ status: 'blocked', verdict: null, blocked_reason: reason }), NOW);
      expect(s.kind).toBe('blocked');
      // Never a failure: `blocked` is a statement about infrastructure (invariant 4).
      expect(s.severity).toBe('none');
      expect(s.mark).toBe('');
      expect(s.note).toBe(reason.replace(/_/g, ' '));
      expect(s.hint).toContain(reason.replace(/_/g, ' '));
    }
  });

  it('keeps blocked distinct from a failing verdict on mark and severity, not colour alone', () => {
    const blocked = displayFacts(cell({ status: 'blocked', verdict: null, blocked_reason: 'bench_unavailable' }), NOW);
    const failed = displayFacts(cell({ verdict: 'non-compliant', top_severity: 'critical', risk_score: 143 }), NOW);

    expect(blocked.mark).toBe('');
    expect(failed.mark).toBe('C');
    expect(blocked.label).not.toBe(failed.label);
    expect(failed.note).toBe('risk 143');
  });

  it('cites the standard when it has one and says nothing false when it does not', () => {
    const cited = displayFacts(cell({ standard: 'Static Review Protocol', standard_version: 3 }), NOW);
    expect(cited.hint).toBe('Assayed under Static Review Protocol v3 and clean.');

    // A caller that did not carry the standard must not render `undefined vundefined`.
    const bare = displayFacts(cell(), NOW);
    expect(bare.kind).toBe('ok');
    expect(bare.hint).toBe('Assayed and clean.');
    expect(bare.hint).not.toContain('undefined');
  });

  it('treats a missing cell as not-yet-run rather than as anything about the subject', () => {
    for (const absent of [null, undefined]) {
      const s = displayFacts(absent, NOW);
      expect(s.kind).toBe('none');
      expect(s.label).toBe('not yet run');
    }
  });

  it('elapses a running cell, and survives one that never recorded a start', () => {
    const running = displayFacts(
      cell({ status: 'running', verdict: null, started_at: '2026-08-22T09:38:00Z' }),
      NOW,
    );
    expect(running.kind).toBe('running');
    expect(running.note).toBe('22m');

    // `started_at` is optional on a trial cell. An unparseable stamp must not produce `NaNm`.
    const noStart = displayFacts(cell({ status: 'running', verdict: null }), NOW);
    expect(noStart.kind).toBe('running');
    expect(noStart.note).toBe('');
  });
});
