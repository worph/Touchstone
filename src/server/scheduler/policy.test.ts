import { describe, expect, it } from 'vitest';

import { decide, stateLine, type PolicyInput, type SchedulerConstants, type SubjectSchedule } from './policy.js';

/** n8n's constants as they run today. A test that changed one would be testing a fiction. */
const CONSTANTS: SchedulerConstants = {
  fresh_days: 7,
  stuck_days: 7,
  lease_min: 120,
  cooldown_min: 55,
  max_tries: 3,
};

const NOW = new Date('2026-08-19T12:00:00Z');

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

function minutesAgo(n: number): string {
  return new Date(NOW.getTime() - n * 60_000).toISOString();
}

function input(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    now: NOW,
    constants: CONSTANTS,
    subjects: ['Alpha', 'Beta', 'Gamma'],
    lastDoneAt: {},
    schedule: {},
    benchAvailable: true,
    ...over,
  };
}

describe('the order of the branches', () => {
  /**
   * n8n checks `busyApp` before it looks at the forced list, so a manual run during an audit
   * waits rather than starting a second one. Single-flight, row B8.
   */
  it('an audit already in progress beats a forced run', () => {
    const d = decide(
      input({
        forced: ['Gamma'],
        schedule: { Alpha: { try_n: 0, claim: { since: minutesAgo(10), try_n: 1 } } },
      }),
    );
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('already in progress (Alpha');
  });

  it('a forced run beats the cooldown and the freshness window', () => {
    const d = decide(
      input({
        forced: ['Gamma'],
        lastFinishedAt: minutesAgo(5),
        lastDoneAt: { Gamma: daysAgo(0) },
      }),
    );
    expect(d.action).toBe('audit');
    expect(d.subject).toBe('Gamma');
    expect(d.reason).toBe('forced (manual trigger)');
  });

  it('the cooldown blocks a pick that is otherwise due', () => {
    const d = decide(input({ lastFinishedAt: minutesAgo(30) }));
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('cooldown');
    expect(d.reason).toContain('25m left');
  });

  it('lets the pick through once the cooldown has run out', () => {
    const d = decide(input({ lastFinishedAt: minutesAgo(56) }));
    expect(d.action).toBe('audit');
  });

  it('idles when every subject is fresh', () => {
    const d = decide(
      input({ lastDoneAt: { Alpha: daysAgo(1), Beta: daysAgo(2), Gamma: daysAgo(3) } }),
    );
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('backlog empty');
    expect(d.backlog).toBe(0);
  });
});

describe('which subject', () => {
  it('picks the stalest, and a subject never run is the stalest of all', () => {
    const d = decide(input({ lastDoneAt: { Alpha: daysAgo(30), Beta: daysAgo(10) } }));
    expect(d.subject).toBe('Gamma');
    expect(d.reason).toBe('never run');
  });

  /**
   * Two never-run subjects both sit at `Infinity`, and `Infinity - Infinity` is `NaN` — a
   * comparator returning NaN leaves the order up to the engine. Registry order is the
   * tie-break so a replay of the same tick picks the same app n8n picked.
   */
  it('breaks a tie between two never-run subjects by registry order', () => {
    const d = decide(input({ lastDoneAt: { Beta: daysAgo(30) } }));
    expect(d.subject).toBe('Alpha');
  });

  it('reports how stale the pick was', () => {
    const d = decide(input({ lastDoneAt: { Alpha: daysAgo(9), Beta: daysAgo(8), Gamma: daysAgo(8) } }));
    expect(d.subject).toBe('Alpha');
    expect(d.reason).toMatch(/^last run \d{4}-\d{2}-\d{2}, 9d ago$/);
  });

  it('counts the backlog, not just the pick', () => {
    const d = decide(input({ lastDoneAt: { Alpha: daysAgo(9), Beta: daysAgo(1) } }));
    expect(d.backlog).toBe(2);
  });

  /** An errored subject is retried on the next tick — `max_tries` stops it, not the calendar. */
  it('retries an errored subject without waiting for the freshness window', () => {
    const d = decide(
      input({
        subjects: ['Alpha'],
        lastDoneAt: { Alpha: daysAgo(0) },
        schedule: { Alpha: { try_n: 1 } },
      }),
    );
    expect(d.action).toBe('audit');
    expect(d.subject).toBe('Alpha');
    expect(d.try_n).toBe(2);
  });
});

describe('parking', () => {
  it('skips a parked subject until its time is served', () => {
    const d = decide(
      input({
        subjects: ['Alpha'],
        schedule: { Alpha: { try_n: 3, parked_at: daysAgo(3) } },
      }),
    );
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('backlog empty');
  });

  it('releases it after stuck_days, and it is eligible on that same tick', () => {
    const d = decide(
      input({
        subjects: ['Alpha'],
        schedule: { Alpha: { try_n: 3, parked_at: daysAgo(8) } },
      }),
    );
    expect(d.unparked).toEqual(['Alpha']);
    expect(d.action).toBe('audit');
    expect(d.subject).toBe('Alpha');
    // The park cleared the streak, so this is attempt one again rather than a fourth try.
    expect(d.try_n).toBe(1);
  });
});

describe('leases', () => {
  it('leaves a fresh claim alone and reports it as busy', () => {
    const d = decide(input({ schedule: { Beta: { try_n: 0, claim: { since: minutesAgo(119), try_n: 1 } } } }));
    expect(d.reclaimed).toEqual([]);
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('Beta');
  });

  it('reclaims one older than lease_min and lets the tick proceed', () => {
    const d = decide(
      input({
        lastDoneAt: { Alpha: daysAgo(0), Gamma: daysAgo(0) },
        schedule: { Beta: { try_n: 0, claim: { since: minutesAgo(121), try_n: 1 } } },
      }),
    );
    expect(d.reclaimed).toEqual([{ subject: 'Beta', outcome: 'retry', try_n: 1 }]);
    expect(d.action).toBe('audit');
    expect(d.subject).toBe('Beta');
  });

  /** A run that vanished did consume an attempt — unlike an agent that was merely busy. */
  it('parks a subject whose reclaim used up the last try', () => {
    const d = decide(
      input({
        subjects: ['Alpha'],
        schedule: { Alpha: { try_n: 2, claim: { since: minutesAgo(200), try_n: 3 } } },
      }),
    );
    expect(d.reclaimed).toEqual([{ subject: 'Alpha', outcome: 'parked', try_n: 3 }]);
    expect(d.action).toBe('idle');
  });

  /**
   * A claim on a subject the registry has since dropped still has to be released, or it
   * holds single-flight shut for good and every later tick reports "already in progress"
   * for an app nobody can see.
   */
  it('releases a claim held by a subject that has left the registry', () => {
    const d = decide(
      input({
        lastDoneAt: { Alpha: daysAgo(0), Beta: daysAgo(0), Gamma: daysAgo(0) },
        schedule: { Removed: { try_n: 0, claim: { since: minutesAgo(300), try_n: 1 } } },
      }),
    );
    expect(d.reclaimed.map((r) => r.subject)).toEqual(['Removed']);
  });
});

describe('the bench gate — row D7', () => {
  it('refuses to claim when no bench is leasable, and says why', () => {
    const d = decide(input({ benchAvailable: false, benchNote: 'demostaging2 unreachable' }));
    expect(d.action).toBe('idle');
    expect(d.reason).toBe('no usable demo bench — demostaging2 unreachable');
  });

  /**
   * The gate must not hide the backlog. A tick that idles for want of a bench has to keep
   * reporting how much work is waiting, or an outage looks like an empty queue.
   */
  it('still reports the backlog it declined to work on', () => {
    const d = decide(input({ benchAvailable: false }));
    expect(d.backlog).toBe(3);
  });

  it('does not gate a tick that was idle anyway', () => {
    const d = decide(
      input({
        benchAvailable: false,
        lastDoneAt: { Alpha: daysAgo(1), Beta: daysAgo(1), Gamma: daysAgo(1) },
      }),
    );
    expect(d.reason).toContain('backlog empty');
  });
});

describe('the State line', () => {
  /** Worded as n8n words it, because phase 1 is validated by diffing the two by eye. */
  it('reads like the roll-up', () => {
    expect(stateLine(decide(input({ lastDoneAt: {} })))).toBe('⏳ auditing Alpha — never run');
    expect(stateLine(decide(input({ benchAvailable: false })))).toBe('⏸️ idle — no usable demo bench');
  });
});

describe('purity', () => {
  /** The caller's state file is not the policy's scratch space. */
  it('does not mutate the schedule it was handed', () => {
    const schedule: Record<string, SubjectSchedule> = {
      Alpha: { try_n: 2, claim: { since: minutesAgo(500), try_n: 3 } },
    };
    const before = JSON.stringify(schedule);
    decide(input({ subjects: ['Alpha'], schedule }));
    expect(JSON.stringify(schedule)).toBe(before);
  });
});
