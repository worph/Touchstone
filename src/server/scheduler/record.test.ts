import { describe, expect, it } from 'vitest';

import type { SchedulerConstants, SubjectSchedule } from './policy.js';
import { openClaim, recordResult } from './record.js';

const CONSTANTS: SchedulerConstants = {
  fresh_days: 7,
  stuck_days: 7,
  lease_min: 120,
  cooldown_min: 55,
  max_tries: 3,
};

const NOW = new Date('2026-08-19T12:00:00Z');

function claimed(try_n: number, previousTries = try_n - 1): SubjectSchedule {
  return { try_n: previousTries, claim: { since: '2026-08-19T11:00:00Z', try_n } };
}

function record(outcome: Parameters<typeof recordResult>[0]['outcome'], schedule?: SubjectSchedule) {
  return recordResult({ now: NOW, constants: CONSTANTS, subject: 'Alpha', outcome, schedule });
}

/**
 * Row E5, and the rule the whole project exists to enforce. On 2026-08-05 the demo pool
 * stopped accepting logins; n8n dispatched anyway, and 49 runs were filed against the apps.
 * Thirteen were parked for a fault none of them had.
 */
describe('the two outcomes that cost nothing', () => {
  it('an agent that was busy leaves the try count exactly where it was', () => {
    const r = record({ kind: 'agent_busy' }, claimed(2));
    expect(r.schedule.try_n).toBe(1);
    expect(r.schedule.claim).toBeUndefined();
    expect(r.parked).toBe(false);
  });

  it('and stamps no finish, so the cooldown does not start', () => {
    expect(record({ kind: 'agent_busy' }, claimed(2)).stampsFinish).toBe(false);
  });

  /**
   * Row E5b. The agent's session being dead is not a fact about any app, so it must not walk
   * one toward parking — the failure that cost `yundera~UptimeKuma` three audits and five days
   * in August 2026, when a misclassified *successful* audit was charged as an error three times
   * over and parked the app for a week.
   */
  it('an agent that is not logged in leaves the try count exactly where it was', () => {
    const r = record({ kind: 'agent_auth' }, claimed(2));
    expect(r.schedule.try_n).toBe(1);
    expect(r.schedule.claim).toBeUndefined();
    expect(r.parked).toBe(false);
  });

  /**
   * ...but unlike a 409 it *does* start the cooldown, and that asymmetry is deliberate. A busy
   * agent comes back in milliseconds having attempted nothing. An auth failure has already
   * spent a full agent call — twenty-six minutes, in the incident above — so leaving the anchor
   * alone would let the next tick claim the next subject at once and march the whole registry
   * through the same dead endpoint. Free, and still spaced.
   */
  it('but does stamp a finish, so a dead agent cannot be hammered once per tick', () => {
    expect(record({ kind: 'agent_auth' }, claimed(2)).stampsFinish).toBe(true);
  });

  it('a bench we could not claim behaves the same way', () => {
    const r = record({ kind: 'blocked', reason: 'bench_unavailable' }, claimed(3));
    expect(r.schedule.try_n).toBe(2);
    expect(r.stampsFinish).toBe(false);
    expect(r.parked).toBe(false);
  });

  /** Even on what would have been the last try: nothing was attempted, so nothing is spent. */
  it('never parks a subject on a free outcome', () => {
    const r = record({ kind: 'blocked', reason: 'bench_unavailable' }, claimed(3, 2));
    expect(r.parked).toBe(false);
    expect(r.schedule.parked_at).toBeUndefined();
  });
});

describe('an attempt that failed', () => {
  it('burns the try', () => {
    const r = record({ kind: 'error', reason: 'agent-error' }, claimed(1, 0));
    expect(r.schedule.try_n).toBe(1);
    expect(r.parked).toBe(false);
  });

  /**
   * Row E7, and it is deliberate. Without the stamp an app that errors reliably stays the
   * stalest row forever and wins the pick on every tick, starving everything else.
   */
  it('still stamps the finish', () => {
    expect(record({ kind: 'error', reason: 'agent-error' }, claimed(1, 0)).stampsFinish).toBe(true);
  });

  it('parks the subject on the third consecutive failure — row E6', () => {
    const r = record({ kind: 'error', reason: 'agent-error' }, claimed(3, 2));
    expect(r.parked).toBe(true);
    expect(r.schedule.parked_at).toBe(NOW.toISOString());
    expect(r.note).toContain('parked after 3');
  });

  it('does not park on the second', () => {
    expect(record({ kind: 'error', reason: 'agent-error' }, claimed(2, 1)).parked).toBe(false);
  });

  /**
   * A result can arrive for a claim the lease already reclaimed. Treating it as attempt one
   * would reset the parking clock and let a broken subject retry forever.
   */
  it('counts an attempt whose claim has already been reclaimed', () => {
    const r = record({ kind: 'error', reason: 'agent-error' }, { try_n: 2 });
    expect(r.schedule.try_n).toBe(3);
    expect(r.parked).toBe(true);
  });
});

describe('an attempt that produced a verdict', () => {
  it('clears the error streak', () => {
    const r = record({ kind: 'verdict' }, claimed(3, 2));
    expect(r.schedule.try_n).toBe(0);
    expect(r.stampsFinish).toBe(true);
  });

  it('releases a park', () => {
    const r = record({ kind: 'verdict' }, { try_n: 3, parked_at: '2026-08-01T00:00:00Z' });
    expect(r.schedule.parked_at).toBeUndefined();
    expect(r.schedule.try_n).toBe(0);
  });
});

describe('the claim — rows C1 and C2', () => {
  it('numbers the attempt one higher than the streak', () => {
    expect(openClaim({ now: NOW, schedule: { try_n: 1 } }).claim).toEqual({
      since: NOW.toISOString(),
      try_n: 2,
    });
  });

  it('starts at one for a subject that has never errored', () => {
    expect(openClaim({ now: NOW, schedule: undefined }).claim?.try_n).toBe(1);
  });

  /**
   * C2, commented as deliberate in n8n. Stamping the finish at claim time makes a run that
   * crashes look freshly audited, and the subject drops out of the backlog for a week having
   * produced nothing at all.
   */
  it('does not touch the streak or the park', () => {
    const opened = openClaim({ now: NOW, schedule: { try_n: 2, parked_at: '2026-08-01T00:00:00Z' } });
    expect(opened.try_n).toBe(2);
    expect(opened.parked_at).toBe('2026-08-01T00:00:00Z');
  });
});

/**
 * The re-audit flag is not this file's to clear.
 *
 * It is a timestamp that stops counting once a *later* attempt exists, and a finisher cannot
 * tell whether the flag arrived before or after the run it is recording — a flag set at 10:05
 * while a run that started at 10:00 was still going is asking for the next look. So every
 * branch carries it and `isFlaggedForReaudit` decides.
 */
describe('the re-audit flag', () => {
  const FLAGGED = '2026-08-19T09:00:00.000Z';
  const flagged = { try_n: 0, flagged_at: FLAGGED };

  it('survives a verdict', () => {
    const r = record({ kind: 'verdict' }, flagged);
    expect(r.schedule.flagged_at).toBe(FLAGGED);
    expect(r.schedule.try_n).toBe(0);
  });

  it('survives an error, including a dispatch that wrote no assay at all', () => {
    const r = record({ kind: 'error', reason: 'dispatch failed' }, flagged);
    expect(r.schedule.flagged_at).toBe(FLAGGED);
  });

  it('survives every outcome that costs nothing', () => {
    expect(record({ kind: 'agent_busy' }, flagged).schedule.flagged_at).toBe(FLAGGED);
    expect(record({ kind: 'agent_auth' }, flagged).schedule.flagged_at).toBe(FLAGGED);
    expect(record({ kind: 'blocked', reason: 'no bench' }, flagged).schedule.flagged_at).toBe(
      FLAGGED,
    );
  });
});
