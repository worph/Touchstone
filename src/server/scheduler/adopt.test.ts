import { describe, expect, it } from 'vitest';

import { adoptRollupSchedule, readRollupSchedule } from './adopt.js';
import type { SubjectSchedule } from './policy.js';

/** The Result cells as n8n writes them, copied from the live roll-up's legend. */
const CELLS = {
  compliant: '✅ compliant',
  nonCompliant: '⛔ non-compliant · Critical',
  errored: '⚠️ errored · try 2',
  stuck: '⚠️ errored · stuck after 3 tries',
  inProgress: '⏳ in progress · try 1 · since 2026-08-19T12:00:00Z',
  notRun: '⬜ not yet run',
};

describe('reading one row', () => {
  it('takes the try count off an errored row', () => {
    expect(readRollupSchedule({ subject: 'A', raw: CELLS.errored, lastRun: '2026-08-10' })).toEqual({
      try_n: 2,
    });
  });

  /**
   * n8n releases a stuck subject `STUCK_DAYS` after its **last run** — there is nowhere in
   * the row to record when it was parked. Measuring from the same field is what keeps the
   * release landing on the same tick in both systems.
   */
  it('parks a stuck row from its last run, not from now', () => {
    expect(readRollupSchedule({ subject: 'A', raw: CELLS.stuck, lastRun: '2026-08-10' })).toEqual({
      try_n: 3,
      parked_at: '2026-08-10T00:00:00Z',
    });
  });

  it('treats a verdict as a cleared streak', () => {
    expect(readRollupSchedule({ subject: 'A', raw: CELLS.compliant, lastRun: '2026-08-18' })).toEqual({ try_n: 0 });
    expect(readRollupSchedule({ subject: 'A', raw: CELLS.nonCompliant, lastRun: '2026-08-18' })).toEqual({ try_n: 0 });
  });

  it('reports a claim n8n holds without pretending it is ours', () => {
    const read = readRollupSchedule({ subject: 'A', raw: CELLS.inProgress, lastRun: null });
    expect(read?.theirClaimSince).toBe('2026-08-19T12:00:00Z');
    expect(read).not.toHaveProperty('claim');
  });

  it('says nothing about an empty cell', () => {
    expect(readRollupSchedule({ subject: 'A', raw: '', lastRun: null })).toBeNull();
  });
});

describe('merging into what we know', () => {
  const rows = [
    { subject: 'Stuck', raw: CELLS.stuck, lastRun: '2026-08-10' },
    { subject: 'Errored', raw: CELLS.errored, lastRun: '2026-08-12' },
    { subject: 'Fine', raw: CELLS.compliant, lastRun: '2026-08-18' },
    { subject: 'Theirs', raw: CELLS.inProgress, lastRun: null },
  ];

  it('fills in the subjects we know nothing about', () => {
    const { schedule, adopted } = adoptRollupSchedule({}, rows);
    expect(adopted.sort()).toEqual(['Errored', 'Stuck']);
    expect(schedule.Stuck).toEqual({ try_n: 3, parked_at: '2026-08-10T00:00:00Z', from_rollup: true });
    expect(schedule.Errored?.try_n).toBe(2);
  });

  /** A clean row is not state worth storing — it is the absence of state. */
  it('does not invent a row for a subject with a verdict', () => {
    expect(adoptRollupSchedule({}, rows).schedule.Fine).toBeUndefined();
  });

  it('reports n8n s own claims separately', () => {
    expect(adoptRollupSchedule({}, rows).theirClaims).toEqual(['Theirs']);
    expect(adoptRollupSchedule({}, rows).schedule.Theirs).toBeUndefined();
  });

  /**
   * The handover rule. Once Touchstone has recorded anything of its own about a subject,
   * the roll-up stops being able to overwrite it — otherwise arming the scheduler would
   * leave it fighting a page n8n has stopped updating.
   */
  it('never overrides state we recorded ourselves', () => {
    const ours: Record<string, SubjectSchedule> = {
      Stuck: { try_n: 1 },
      Errored: { try_n: 0, claim: { since: '2026-08-19T12:00:00Z', try_n: 1 } },
    };
    const { schedule, adopted } = adoptRollupSchedule(ours, rows);
    expect(adopted).toEqual([]);
    expect(schedule.Stuck).toEqual({ try_n: 1 });
    expect(schedule.Errored?.claim).toBeDefined();
  });

  it('does adopt for a subject we have only an empty row for', () => {
    const { schedule } = adoptRollupSchedule({ Stuck: { try_n: 0 } }, rows);
    expect(schedule.Stuck?.parked_at).toBe('2026-08-10T00:00:00Z');
  });

  it('leaves the caller s record alone', () => {
    const ours: Record<string, SubjectSchedule> = { Stuck: { try_n: 0 } };
    adoptRollupSchedule(ours, rows);
    expect(ours.Stuck).toEqual({ try_n: 0 });
  });
});

/**
 * The re-adoption rule, found by running it: the first import adopted `try 2` for a dozen
 * subjects, and every later import then refused to update them to `stuck` because the row
 * it had written itself looked like state worth keeping.
 */
describe('correcting an earlier adoption', () => {
  const stuckRow = [{ subject: 'A', raw: '⚠️ errored · stuck after 3 tries', lastRun: '2026-08-14' }];

  it('updates a row it adopted before', () => {
    const first = adoptRollupSchedule({}, [{ subject: 'A', raw: '⚠️ errored · try 2', lastRun: '2026-08-12' }]);
    expect(first.schedule.A).toMatchObject({ try_n: 2, from_rollup: true });

    const second = adoptRollupSchedule(first.schedule, stuckRow);
    expect(second.schedule.A?.parked_at).toBe('2026-08-14T00:00:00Z');
  });

  it('still refuses to touch a row we recorded ourselves', () => {
    const ours = { A: { try_n: 1 } };
    expect(adoptRollupSchedule(ours, stuckRow).schedule.A).toEqual({ try_n: 1 });
  });

  it('clears adopted state once the subject has a verdict again', () => {
    const first = adoptRollupSchedule({}, stuckRow);
    const second = adoptRollupSchedule(first.schedule, [
      { subject: 'A', raw: '✅ compliant', lastRun: '2026-08-19' },
    ]);
    expect(second.schedule.A).toBeUndefined();
  });
});
