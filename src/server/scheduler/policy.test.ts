import { describe, expect, it } from 'vitest';

import {
  decide,
  queue,
  stateLine,
  type PolicyInput,
  type SchedulerConstants,
  type SubjectSchedule,
} from './policy.js';

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
    expect(d.reason).toContain('all 3 app(s)');
    expect(d.backlog).toBe(0);
    expect(d.parked).toBe(0);
  });

  /**
   * The empty-backlog reason must not claim a parked subject was audited.
   *
   * It did, and the sentence cost real debugging time. On 2026-08-31 an operator read
   * *"backlog empty — all 73 app(s) audited within 14d"* over an app that had been parked for
   * three days by a misclassified success, never audited under the current standard, and
   * skipped a few lines above this branch without a word. The reason string was the only thing
   * the page could say about it, and it said the opposite of the truth.
   */
  it('does not count a parked subject as audited', () => {
    const d = decide(
      input({
        lastDoneAt: { Alpha: daysAgo(1), Beta: daysAgo(2) },
        schedule: { Gamma: { try_n: 3, parked_at: daysAgo(1) } },
      }),
    );
    expect(d.action).toBe('idle');
    expect(d.parked).toBe(1);
    expect(d.reason).toBe('backlog empty — 2 app(s) audited within 7d, 1 parked');
    expect(d.reason).not.toContain('all 3');
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


/**
 * The standard moving is the one thing besides an error that makes a *recently audited* app
 * eligible again. It is deliberately the smallest possible lever: it adds a subject to the
 * backlog and does nothing else — no priority, no forced run, no bypass of the cooldown or
 * the bench gate. In practice the loop is saturated anyway, so what it really says is
 * "re-judge it with the spare hour rather than waiting out the week".
 */
describe('when the standard moves under a subject', () => {
  const MOVED = daysAgo(1);

  /** Audited two days ago, well inside `fresh_days`; the rubric changed yesterday. */
  function moved(over: Partial<PolicyInput> = {}): PolicyInput {
    return input({
      subjects: ['Alpha'],
      lastDoneAt: { Alpha: daysAgo(2) },
      lastAttemptAt: { Alpha: daysAgo(2) },
      standardMovedAt: MOVED,
      ...over,
    });
  }

  it('makes a subject eligible that the freshness window would have skipped', () => {
    const d = decide(moved());
    expect(d.action).toBe('audit');
    expect(d.subject).toBe('Alpha');
    expect(d.backlog).toBe(1);
  });

  it('says so in the reason, because n8n has no such rule to diff against', () => {
    expect(decide(moved()).reason).toContain('standard revised 2026-08-18');
  });

  it('does nothing at all when no revision has been recorded', () => {
    const d = decide(moved({ standardMovedAt: undefined }));
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('backlog empty');
  });

  /**
   * The comparison is against the last *attempt*, not the last verdict. A section that is
   * permanently blocked keeps its old `done` record for ever, so a rule reading verdicts
   * would re-pick that subject on every tick until somebody fixed the bench.
   */
  it('is settled by an attempt, even one that produced no verdict', () => {
    const d = decide(moved({ lastAttemptAt: { Alpha: daysAgo(0) } }));
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('backlog empty');
  });

  it('does not jump the queue — a never-audited app still goes first', () => {
    const rows = queue(
      moved({
        subjects: ['Alpha', 'Beta'],
        lastDoneAt: { Alpha: daysAgo(2) },
        lastAttemptAt: { Alpha: daysAgo(2) },
      }),
    );
    expect(rows.map((r) => r.subject)).toEqual(['Beta', 'Alpha']);
    expect(rows[0]?.state).toBe('never');
  });

  /** It is due, and the note is where the reason lives — not in a seventh state word. */
  it('reads as due rather than fresh, and carries why', () => {
    const row = queue(moved()).find((r) => r.subject === 'Alpha');
    expect(row?.state).toBe('due');
    expect(row?.position).toBe(1);
    expect(row?.standard_moved).toBe(true);
  });

  it('leaves an ordinary due row unmarked', () => {
    const row = queue(
      moved({ lastDoneAt: { Alpha: daysAgo(30) }, lastAttemptAt: { Alpha: daysAgo(30) } }),
    ).find((r) => r.subject === 'Alpha');
    expect(row?.state).toBe('due');
    expect(row?.standard_moved).toBeUndefined();
  });

  it('is still subject to the cooldown and the bench gate', () => {
    expect(decide(moved({ lastFinishedAt: minutesAgo(5) })).action).toBe('idle');
    expect(decide(moved({ benchAvailable: false })).reason).toContain('no usable demo bench');
  });

  /** A park is about repeated failure, and a rubric edit is not an answer to that. */
  it('does not release a parked subject', () => {
    const d = decide(moved({ schedule: { Alpha: { try_n: 3, parked_at: daysAgo(1) } } }));
    expect(d.action).toBe('idle');
  });
});


/**
 * The second way past the freshness window: the app itself changed. Independent of the
 * standard rule and shaped identically — it adds to the backlog and does nothing else.
 *
 * The safeguard under test throughout is the asymmetry: **unknown is not a trigger**. Every
 * assay written before 2026-08-25 records no version, and if a missing sha read as "changed"
 * the whole archive would go eligible the day this shipped and stay so until audited.
 */
describe('when the app changes in the store', () => {
  /** Audited two days ago, well inside `fresh_days`, against a compose that has since moved. */
  function changed(over: Partial<PolicyInput> = {}): PolicyInput {
    return input({
      subjects: ['Alpha'],
      lastDoneAt: { Alpha: daysAgo(2) },
      lastAttemptAt: { Alpha: daysAgo(2) },
      currentVersion: { Alpha: 'sha-new' },
      auditedVersion: { Alpha: 'sha-old' },
      ...over,
    });
  }

  it('makes a subject eligible that the freshness window would have skipped', () => {
    const d = decide(changed());
    expect(d.action).toBe('audit');
    expect(d.subject).toBe('Alpha');
  });

  it('says so in the reason', () => {
    expect(decide(changed()).reason).toContain('app changed in the store');
  });

  it('does nothing when the compose is the one that was judged', () => {
    const d = decide(changed({ auditedVersion: { Alpha: 'sha-new' } }));
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('backlog empty');
  });

  it('does nothing when the assay recorded no version — unknown is not changed', () => {
    const d = decide(changed({ auditedVersion: {} }));
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('backlog empty');
  });

  it('does nothing when the store offers no compose for it', () => {
    const d = decide(changed({ currentVersion: {} }));
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('backlog empty');
  });

  it('does nothing at all when versions are not being tracked', () => {
    const d = decide(changed({ currentVersion: undefined, auditedVersion: undefined }));
    expect(d.action).toBe('idle');
  });

  it('reads as due, and the row says which of the two reasons applies', () => {
    const row = queue(changed()).find((r) => r.subject === 'Alpha');
    expect(row?.state).toBe('due');
    expect(row?.subject_changed).toBe(true);
    expect(row?.standard_moved).toBeUndefined();
  });

  /** The two are independent, and a row may legitimately carry both. */
  it('carries both marks when the standard moved as well', () => {
    const row = queue(
      changed({ standardMovedAt: daysAgo(1) }),
    ).find((r) => r.subject === 'Alpha');
    expect(row?.standard_moved).toBe(true);
    expect(row?.subject_changed).toBe(true);
    expect(row?.position).toBe(1);
  });

  it('does not jump the queue — a never-audited app still goes first', () => {
    const rows = queue(changed({ subjects: ['Alpha', 'Beta'] }));
    expect(rows.map((r) => r.subject)).toEqual(['Beta', 'Alpha']);
  });

  it('is still subject to the cooldown, the bench gate and the park', () => {
    expect(decide(changed({ lastFinishedAt: minutesAgo(5) })).action).toBe('idle');
    expect(decide(changed({ benchAvailable: false })).reason).toContain('no usable demo bench');
    expect(decide(changed({ schedule: { Alpha: { try_n: 3, parked_at: daysAgo(1) } } })).action).toBe('idle');
  });
});

/**
 * The third way past the freshness window: somebody asked.
 *
 * It exists for a case the two automatic rules cannot reach. A section recorded `blocked`
 * stamps no finish and burns no try — invariant 3 — but a *sibling* section that completed
 * sets `lastDoneAt`, so the whole subject reads fresh for `fresh_days` on the strength of the
 * half of the audit that ran. Nothing about the world has changed, so neither the standard
 * clause nor the version clause fires, and the operator has no way to say "look at it again"
 * short of taking the agent with a hand-run.
 *
 * Shaped exactly like the other two: it adds to the backlog and does nothing else.
 */
describe('when a subject is flagged for re-audit', () => {
  const FLAGGED = daysAgo(1);

  /** Audited two days ago, well inside `fresh_days`; flagged yesterday. */
  function flagged(over: Partial<PolicyInput> = {}): PolicyInput {
    return input({
      subjects: ['Alpha'],
      lastDoneAt: { Alpha: daysAgo(2) },
      lastAttemptAt: { Alpha: daysAgo(2) },
      schedule: { Alpha: { try_n: 0, flagged_at: FLAGGED } },
      ...over,
    });
  }

  it('makes a subject eligible that the freshness window would have skipped', () => {
    const d = decide(flagged());
    expect(d.action).toBe('audit');
    expect(d.subject).toBe('Alpha');
    expect(d.backlog).toBe(1);
  });

  it('says so in the reason, because n8n has no such rule to diff against', () => {
    expect(decide(flagged()).reason).toContain('flagged for re-audit');
  });

  it('does nothing to a subject nobody flagged', () => {
    const d = decide(flagged({ schedule: { Alpha: { try_n: 0 } } }));
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('backlog empty');
  });

  /**
   * The whole reason the flag is a timestamp rather than a boolean: the next attempt spends
   * it, so nothing has to remember to switch it off, and a stale flag cannot pin an app in
   * the backlog for ever.
   */
  it('is spent by the next attempt', () => {
    const d = decide(flagged({ lastAttemptAt: { Alpha: daysAgo(0) } }));
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('backlog empty');
  });

  /**
   * And spent by an attempt that concluded nothing — which is the case it was set for. One
   * flag buys one look, not one look per cooldown until the bench comes back.
   */
  it('is spent even by an attempt that produced no verdict', () => {
    const d = decide(
      flagged({ lastDoneAt: { Alpha: daysAgo(2) }, lastAttemptAt: { Alpha: minutesAgo(30) } }),
    );
    expect(d.action).toBe('idle');
  });

  /**
   * A flag set while a run was already in flight is asking for the *next* look. The
   * comparison is against the attempt's start, so a run that began before the flag does not
   * answer it — which is why nothing clears the field when a run finishes.
   */
  it('survives a run that started before it was set', () => {
    const d = decide(
      flagged({
        schedule: { Alpha: { try_n: 0, flagged_at: minutesAgo(30) } },
        lastAttemptAt: { Alpha: minutesAgo(60) },
      }),
    );
    expect(d.action).toBe('audit');
    expect(d.reason).toContain('flagged for re-audit');
  });

  it('does not jump the queue — a never-audited app still goes first', () => {
    const rows = queue(flagged({ subjects: ['Alpha', 'Beta'] }));
    expect(rows.map((r) => r.subject)).toEqual(['Beta', 'Alpha']);
    expect(rows[0]?.state).toBe('never');
  });

  /** It is due, and the note is where the reason lives — not in a seventh state word. */
  it('reads as due rather than fresh, and carries why', () => {
    const row = queue(flagged()).find((r) => r.subject === 'Alpha');
    expect(row?.state).toBe('due');
    expect(row?.position).toBe(1);
    expect(row?.flagged).toBe(true);
  });

  it('leaves an unflagged row unmarked', () => {
    const row = queue(
      flagged({
        lastDoneAt: { Alpha: daysAgo(30) },
        lastAttemptAt: { Alpha: daysAgo(30) },
        schedule: { Alpha: { try_n: 0 } },
      }),
    ).find((r) => r.subject === 'Alpha');
    expect(row?.state).toBe('due');
    expect(row?.flagged).toBeUndefined();
  });

  /**
   * Unlike `standard_moved`, the flag is reported wherever it is set — including on a row
   * that was already due for its own reasons. It is what the control renders from, and a
   * button that offers to set a flag that is already set is a button that lies.
   */
  it('is reported on a row that was already due for another reason', () => {
    const row = queue(
      flagged({ lastDoneAt: { Alpha: daysAgo(30) }, lastAttemptAt: { Alpha: daysAgo(30) } }),
    ).find((r) => r.subject === 'Alpha');
    expect(row?.state).toBe('due');
    expect(row?.flagged).toBe(true);
  });

  it('is reported on a subject that has never been audited', () => {
    const row = queue(
      flagged({ lastDoneAt: {}, lastAttemptAt: {} }),
    ).find((r) => r.subject === 'Alpha');
    expect(row?.state).toBe('never');
    expect(row?.flagged).toBe(true);
  });

  /** A row can be due for all three reasons at once, and says all three. */
  it('sits alongside the other two rather than replacing them', () => {
    const row = queue(
      flagged({
        standardMovedAt: daysAgo(1),
        currentVersion: { Alpha: 'bbb' },
        auditedVersion: { Alpha: 'aaa' },
      }),
    ).find((r) => r.subject === 'Alpha');
    expect(row?.flagged).toBe(true);
    expect(row?.standard_moved).toBe(true);
    expect(row?.subject_changed).toBe(true);
    expect(row?.position).toBe(1);
  });

  it('is still subject to the cooldown, the bench gate and the park', () => {
    expect(decide(flagged({ lastFinishedAt: minutesAgo(5) })).action).toBe('idle');
    expect(decide(flagged({ benchAvailable: false })).reason).toContain('no usable demo bench');
    expect(
      decide(flagged({ schedule: { Alpha: { try_n: 3, parked_at: daysAgo(1), flagged_at: FLAGGED } } }))
        .action,
    ).toBe('idle');
  });

  /** Garbage in the file must not throw a tick; it reads as "not flagged". */
  it('ignores a flag that is not a date', () => {
    const d = decide(flagged({ schedule: { Alpha: { try_n: 0, flagged_at: 'soon' } } }));
    expect(d.action).toBe('idle');
  });
});
