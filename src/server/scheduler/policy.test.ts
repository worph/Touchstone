import { describe, expect, it } from 'vitest';

import { DEFAULT_TARGET } from '../../shared/target.js';
import type { LegacySubjectSchedule } from '../../shared/schedule.js';
import { migrateLines } from './index.js';
import {
  decide,
  queue,
  requests,
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

/**
 * The fixtures below are written the way they always were — one subject, one flat row, one
 * date — because that is what almost every rule in this file is about, and re-punctuating a
 * hundred literals to say `{ lines: { bench: … } }` would have buried the rules in syntax.
 *
 * This adapter is what makes that legal, and it is deliberately **`migrateLines` itself**
 * rather than a hand-rolled shim: every test in this file now exercises the upgrade path as a
 * side effect, and a fixture that means something different after the fan-out than before it
 * would fail here rather than in production.
 *
 * A test that is genuinely about two platforms passes `lines:` directly and skips all of it.
 */
type FlatInput = Omit<
  Partial<PolicyInput>,
  'schedule' | 'lastDoneAt' | 'lastAttemptAt' | 'auditedVersion' | 'standardMovedAt'
> & {
  schedule?: Record<string, LegacySubjectSchedule | undefined>;
  lastDoneAt?: Record<string, string | undefined>;
  lastAttemptAt?: Record<string, string | undefined>;
  auditedVersion?: Record<string, string | undefined>;
  standardMovedAt?: string;
  /** The old single-pool gate, still the honest way to write a one-platform test. */
  benchAvailable?: boolean;
  benchNote?: string;
};

const LINE = DEFAULT_TARGET;

/** `{Alpha: '2026-01-01'}` → `{Alpha: {bench: '2026-01-01'}}`. */
function byLine(
  flat: Record<string, string | undefined> | undefined,
): Record<string, Record<string, string | undefined>> | undefined {
  if (!flat) return undefined;
  return Object.fromEntries(Object.entries(flat).map(([k, v]) => [k, { [LINE]: v }]));
}

function input(over: FlatInput = {}): PolicyInput {
  const { schedule, lastDoneAt, lastAttemptAt, auditedVersion, standardMovedAt, benchAvailable, benchNote, ...rest } =
    over;
  return {
    now: NOW,
    constants: CONSTANTS,
    subjects: ['Alpha', 'Beta', 'Gamma'],
    sections: [{ id: 'static', line: LINE, scores: true }],
    lastDoneAt: byLine(lastDoneAt) ?? {},
    schedule: migrateLines(schedule ?? {}, [LINE]),
    ...(lastAttemptAt ? { lastAttemptAt: byLine(lastAttemptAt) } : {}),
    ...(auditedVersion ? { auditedVersion: byLine(auditedVersion) } : {}),
    ...(standardMovedAt ? { standardMovedAt: { [LINE]: standardMovedAt } } : {}),
    capabilities:
      benchAvailable === false
        ? { [LINE]: { available: false, ...(benchNote ? { note: benchNote } : {}) } }
        : { [LINE]: { available: true } },
    ...rest,
  };
}

describe('the order of the branches', () => {
  /** Single-flight beats everything, including somebody asking. Row B8. */
  it('an audit already in progress beats a request', () => {
    const d = decide(
      input({
        subjects: ['Alpha', 'Gamma'],
        schedule: {
          Alpha: { try_n: 0, claim: { since: minutesAgo(10), try_n: 1 } },
          Gamma: { try_n: 0, flagged_at: minutesAgo(1) },
        },
      }),
    );
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('already in progress (Alpha');
  });

  /**
   * The agent held by something with no claim — a trial. The claim-derived `busy` above
   * cannot see it, and before `agentBusy` existed a tick kicked the moment an audit finished
   * would dispatch straight into the running trial and learn nothing, over and over.
   */
  it('a trial holding the agent beats a request, though it holds no claim', () => {
    const d = decide(
      input({
        subjects: ['Gamma'],
        agentBusy: true,
        schedule: { Gamma: { try_n: 0, flagged_at: minutesAgo(1) } },
      }),
    );
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('busy');
  });

  it('a request beats the cooldown and the freshness window', () => {
    const d = decide(
      input({
        subjects: ['Gamma'],
        lastFinishedAt: minutesAgo(5),
        // Audited an hour ago — well inside `fresh_days` — and asked for since.
        lastDoneAt: { Gamma: minutesAgo(60) },
        lastAttemptAt: { Gamma: minutesAgo(60) },
        schedule: { Gamma: { try_n: 0, flagged_at: minutesAgo(1) } },
      }),
    );
    expect(d.action).toBe('audit');
    expect(d.subject).toBe('Gamma');
    expect(d.source).toBe('requested');
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
    // The cell, not the subject: a park belongs to a platform now.
    expect(d.unparked).toEqual([{ subject: 'Alpha', line: LINE }]);
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
    expect(d.reclaimed).toEqual([{ subject: 'Beta', line: LINE, outcome: 'retry', try_n: 1 }]);
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
    expect(d.reclaimed).toEqual([{ subject: 'Alpha', line: LINE, outcome: 'parked', try_n: 3 }]);
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
    // Written in the shape the file actually holds, **nested**, because that is the whole
    // point of this test now: the copy `reclaimExpired` takes used to be one spread plus the
    // claim, which was exactly deep enough while a row's mutable state was flat. A shallow
    // copy would share this `lines` object and the reclaim below would write straight through
    // into the caller's state file.
    const schedule: Record<string, SubjectSchedule> = {
      Alpha: { lines: { [LINE]: { try_n: 2, claim: { since: minutesAgo(500), try_n: 3 } } } },
    };
    const before = JSON.stringify(schedule);
    decide({ ...input({ subjects: ['Alpha'] }), schedule });
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
  function moved(over: FlatInput = {}): PolicyInput {
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
  function changed(over: FlatInput = {}): PolicyInput {
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
  function flagged(over: FlatInput = {}): PolicyInput {
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

  it('says so in the reason, and says it was asked for rather than merely due', () => {
    const d = decide(flagged());
    expect(d.reason).toContain('requested');
    expect(d.source).toBe('requested');
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
    expect(d.reason).toContain('requested');
  });

  /**
   * **The one asymmetry in the three clauses**, and the reason the comment in `plan()` works
   * so hard at it. A rubric edit and a compose change are facts about the world, and the world
   * can wait for the rotation — both go on proving they do not jump, two describes above.
   * A request is a person waiting for an answer, and on 2026-09-01 it started going first.
   */
  it('jumps the queue — a request outranks even a never-audited app', () => {
    const rows = queue(flagged({ subjects: ['Alpha', 'Beta'] }));
    expect(rows.map((r) => r.subject)).toEqual(['Alpha', 'Beta']);
    expect(rows[0]?.state).toBe('due');
    expect(rows[0]?.flagged).toBe(true);
    expect(rows[1]?.state).toBe('never');
  });

  /** Two requests are one line, and the line is in the order they were asked for. */
  it('orders requests by when they were asked for, not by staleness', () => {
    const rows = queue(
      flagged({
        subjects: ['Alpha', 'Beta'],
        lastDoneAt: { Alpha: daysAgo(2), Beta: daysAgo(9) },
        lastAttemptAt: { Alpha: daysAgo(2), Beta: daysAgo(9) },
        schedule: {
          Alpha: { try_n: 0, flagged_at: minutesAgo(30) },
          Beta: { try_n: 0, flagged_at: minutesAgo(5) },
        },
      }),
    );
    // Beta is seven days staler and was asked for second, so it goes second.
    expect(rows.map((r) => r.subject)).toEqual(['Alpha', 'Beta']);
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

  /**
   * **The cooldown no longer applies**, and the other two still do.
   *
   * A request that waited out fifty-five minutes behind a run that had just finished would
   * make pressing Audit on an idle box mean "in about an hour", which is the answer the queue
   * exists to stop giving. The bench gate is a different thing: it is not a pace, it is a
   * missing prerequisite, and a request that cannot run holds the line and says why.
   */
  it('is no longer subject to the cooldown', () => {
    expect(decide(flagged({ lastFinishedAt: minutesAgo(5) })).action).toBe('audit');
  });

  it('is still subject to the bench gate and the park', () => {
    const gated = decide(flagged({ benchAvailable: false }));
    expect(gated.action).toBe('idle');
    expect(gated.reason).toContain('no usable demo bench');
    // And it names what is being held up, or "waiting" and "empty" render identically.
    expect(gated.waiting_on).toBe('Alpha');
    expect(
      decide(flagged({ schedule: { Alpha: { try_n: 3, parked_at: daysAgo(1), flagged_at: FLAGGED } } }))
        .action,
    ).toBe('idle');
  });

  /**
   * Trials and audits share one line and one ordering key, because they share one agent.
   * Ordering them separately would be two queues wearing one heading.
   */
  it('takes a trial first when the trial was asked for first', () => {
    const d = decide(
      flagged({
        queuedTrials: [{ slug: 'FileBrowser@abcd1234-x', subject: 'FileBrowser', queued_at: daysAgo(2) }],
      }),
    );
    expect(d.action).toBe('trial');
    expect(d.trial).toBe('FileBrowser@abcd1234-x');
    expect(d.source).toBe('requested');
  });

  it('takes the audit first when the audit was asked for first', () => {
    const d = decide(
      flagged({
        queuedTrials: [{ slug: 'FileBrowser@abcd1234-x', subject: 'FileBrowser', queued_at: minutesAgo(1) }],
      }),
    );
    expect(d.action).toBe('audit');
    expect(d.subject).toBe('Alpha');
  });

  /** Garbage in the file must not throw a tick; it reads as "not flagged". */
  it('ignores a flag that is not a date', () => {
    const d = decide(flagged({ schedule: { Alpha: { try_n: 0, flagged_at: 'soon' } } }));
    expect(d.action).toBe('idle');
  });
});

/**
 * Two platforms, two lines.
 *
 * Every rule above is about one subject on one platform, which is what a line is. These are
 * the rules that only exist once there are two, and each of them is a thing that went wrong
 * in the design before it was written down: a second pool's outage stopping all auditing, one
 * platform's failures parking the other, and a single press being served by one line and
 * quietly dropped by the other.
 */
describe('more than one platform', () => {
  const FOSS = 'foss';

  function twoLines(over: Partial<PolicyInput> = {}): PolicyInput {
    return {
      ...input({ subjects: ['Alpha'] }),
      sections: [
        { id: 'static', line: LINE, scores: true },
        { id: 'functional', line: LINE, scores: true },
        { id: 'functional-foss', line: FOSS, scores: true },
        // A reading rides its line's run and may never anchor one — invariant 12's third
        // clause. If it could, `currency` would be due constantly and take every slot.
        { id: 'currency', line: LINE, scores: false },
      ],
      capabilities: { [LINE]: { available: true }, [FOSS]: { available: true } },
      ...over,
    };
  }

  it('audits each platform as its own run, scoped to that line', () => {
    const d = decide(twoLines());
    expect(d.action).toBe('audit');
    expect(d.line).toBe(LINE);
    // The whole line, readings included: `currency` rides the run its line is already making.
    expect(d.sections).toEqual(['static', 'functional', 'currency']);
    expect(d.sections).not.toContain('functional-foss');
  });

  /** Both cells are never-run, so the subject appears once per platform in the backlog. */
  it('counts a subject once per platform it has not been audited on', () => {
    expect(decide(twoLines()).backlog).toBe(2);
  });

  /**
   * The failure this feature would otherwise have introduced. One `benchAvailable` boolean
   * had no right answer with two pools: a FOSS outage would have stopped either all auditing
   * or none of it, depending which way it fell.
   */
  it('keeps auditing one platform while the other has no bench', () => {
    const d = decide(
      twoLines({
        capabilities: {
          [LINE]: { available: true },
          [FOSS]: { available: false, note: 'demofoss1 unreachable' },
        },
      }),
    );
    expect(d.action).toBe('audit');
    expect(d.line).toBe(LINE);
    // And it says so even though it dispatched — the only place a dead second pool is ever
    // announced, since `action` is not `idle`.
    expect(d.gated).toEqual([FOSS]);
  });

  it('names the held platform when every line is gated', () => {
    const d = decide(
      twoLines({
        capabilities: {
          [LINE]: { available: false, note: 'demostaging1 unreachable' },
          [FOSS]: { available: false, note: 'demofoss1 unreachable' },
        },
      }),
    );
    expect(d.action).toBe('idle');
    expect(d.reason).toContain(FOSS);
    expect(d.gated).toEqual([LINE, FOSS]);
  });

  /**
   * A line holds at its head rather than advancing to its second-stalest cell: refusing to
   * claim is the point, and skipping within a line would produce a verdict about half a
   * rubric. Passing over a *line* is different — they are separate queues for separate
   * hardware.
   */
  it('holds a gated line at its head instead of skipping down it', () => {
    const d = decide(
      twoLines({
        subjects: ['Alpha', 'Beta'],
        capabilities: { [LINE]: { available: false }, [FOSS]: { available: true } },
      }),
    );
    expect(d.line).toBe(FOSS);
    expect(d.subject).toBe('Alpha');
  });

  /** One press, one timestamp, counted per line — the whole of the fan-out. */
  it('serves one request on both platforms, each spending it on its own run', () => {
    const asked = daysAgo(0);
    const base = twoLines({
      schedule: { Alpha: { flagged_at: asked, lines: { [LINE]: { try_n: 0 } } } },
      // Both lines are fresh, so only the request can make either eligible.
      lastDoneAt: { Alpha: { [LINE]: daysAgo(1), [FOSS]: daysAgo(1) } },
      lastAttemptAt: { Alpha: { [LINE]: daysAgo(1), [FOSS]: daysAgo(1) } },
    });
    expect(decide(base).backlog).toBe(2);

    // The Yundera line has now answered it; the FOSS line has not, so the request stands.
    const half = decide({
      ...base,
      lastAttemptAt: { Alpha: { [LINE]: daysAgo(0), [FOSS]: daysAgo(1) } },
    });
    expect(half.action).toBe('audit');
    expect(half.line).toBe(FOSS);
    expect(half.source).toBe('requested');
  });

  /** And the queue still shows one row for it, however many lines are outstanding. */
  it('shows one request row per subject, not one per platform', () => {
    const rows = requests(
      twoLines({ schedule: { Alpha: { flagged_at: daysAgo(0), lines: { [LINE]: { try_n: 0 } } } } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lines).toEqual([LINE, FOSS]);
  });

  /** A FOSS stack that fails every app must not park them out of the Yundera rotation. */
  it('parks one platform without touching the other', () => {
    const d = decide(
      twoLines({
        schedule: {
          Alpha: {
            lines: { [FOSS]: { try_n: 3, parked_at: daysAgo(0) }, [LINE]: { try_n: 0 } },
          },
        },
      }),
    );
    expect(d.action).toBe('audit');
    expect(d.line).toBe(LINE);
    expect(d.parked).toBe(1);
  });

  /** Editing one platform's rubric must not spend agent time re-auditing the other. */
  it('re-eligibles only the line whose rubric moved', () => {
    const d = decide(
      twoLines({
        lastDoneAt: { Alpha: { [LINE]: daysAgo(1), [FOSS]: daysAgo(1) } },
        lastAttemptAt: { Alpha: { [LINE]: daysAgo(1), [FOSS]: daysAgo(1) } },
        standardMovedAt: { [FOSS]: daysAgo(0) },
      }),
    );
    expect(d.action).toBe('audit');
    expect(d.line).toBe(FOSS);
    expect(d.backlog).toBe(1);
  });

  /**
   * A protocol directory that could not be read leaves no sections, and the scope must then
   * be **absent** rather than empty — an empty one would reach the runner as "audit these
   * zero sections", which stamps a finish for a run that established nothing.
   */
  it('names no scope at all when the protocol could not be read', () => {
    const d = decide({ ...twoLines(), sections: [] });
    expect(d.action).toBe('audit');
    expect(d.sections).toBeUndefined();
  });
});

/**
 * The concurrent pick — `PolicyInput.free` present.
 *
 * Capacity is whatever is free: one run per (bench, browser) pair, in queue order, each line
 * holding at its own head. These pin the three things that make that safe — a busy pool is not
 * a broken one, a line's shortage costs only that line, and nothing starts twice.
 */
describe('several runs at once', () => {
  const FOSS = 'foss';

  function concurrent(over: Partial<PolicyInput> = {}): PolicyInput {
    return {
      ...input({ subjects: ['Alpha', 'Beta', 'Gamma'] }),
      sections: [
        { id: 'static', line: LINE, scores: true },
        { id: 'functional', line: LINE, scores: true },
        { id: 'functional@foss', line: FOSS, scores: true },
      ],
      capabilities: { [LINE]: { available: true }, [FOSS]: { available: true } },
      free: { benches: { [LINE]: 2, [FOSS]: 1 }, browsers: 3, browsersHealthy: 3 },
      ...over,
    };
  }

  const started = (d: ReturnType<typeof decide>) =>
    (d.dispatches ?? []).map((x) => `${x.subject ?? x.trial}@${x.line}`);

  it('starts one run per free pair, across both platforms', () => {
    const d = decide(concurrent());
    // Two Yundera benches, one FOSS bench, three browsers: three runs. Queue order is the
    // registry's for never-run cells, so Alpha's two lines go first.
    expect(started(d)).toEqual([`Alpha@${LINE}`, `Alpha@${FOSS}`, `Beta@${LINE}`]);
    expect(d.action).toBe('audit');
    expect(d.subject).toBe('Alpha');
    // Each run is scoped to its own line — FOSS never carries `static`.
    expect(d.dispatches?.[1]?.sections).toEqual(['functional@foss']);
  });

  /** Two benches and one browser is one run: the pair is the unit. */
  it('is bounded by browsers as much as by benches', () => {
    const d = decide(concurrent({ free: { benches: { [LINE]: 2, [FOSS]: 1 }, browsers: 1, browsersHealthy: 1 } }));
    expect(started(d)).toEqual([`Alpha@${LINE}`]);
    expect(d.held).toEqual(
      expect.arrayContaining([expect.objectContaining({ line: FOSS, why: 'full', reason: 'every browser is in use' })]),
    );
    expect(d.gated).toBeUndefined();
  });

  /**
   * A pool whose benches are all busy auditing is working. Reporting it as gated would fire the
   * bench alert every time the loop did its job.
   */
  it('reads a pool with every bench busy as full, never as gated', () => {
    const d = decide(concurrent({ free: { benches: { [LINE]: 0, [FOSS]: 1 }, browsers: 3, browsersHealthy: 3 } }));
    expect(started(d)).toEqual([`Alpha@${FOSS}`]);
    expect(d.held).toEqual([
      expect.objectContaining({ line: LINE, why: 'full' }),
      // FOSS's one bench went to Alpha, so its next cell is full too — busy, not broken.
      expect.objectContaining({ line: FOSS, why: 'full' }),
    ]);
    expect(d.gated).toBeUndefined();
  });

  it('keeps one platform running while the other has no healthy bench', () => {
    const d = decide(
      concurrent({
        capabilities: { [LINE]: { available: true }, [FOSS]: { available: false, note: 'demofoss1 unreachable' } },
        free: { benches: { [LINE]: 2, [FOSS]: 0 }, browsers: 3, browsersHealthy: 3 },
      }),
    );
    expect(started(d)).toEqual([`Alpha@${LINE}`, `Beta@${LINE}`]);
    expect(d.gated).toEqual([FOSS]);
    expect(d.held?.[0]?.reason).toContain('demofoss1 unreachable');
  });

  it('gates every line that needs a browser when no browser is healthy', () => {
    const d = decide(concurrent({ free: { benches: { [LINE]: 2, [FOSS]: 1 }, browsers: 0, browsersHealthy: 0 } }));
    expect(d.action).toBe('idle');
    expect(d.gated).toEqual([LINE, FOSS]);
    expect(d.reason).toContain('no usable browser');
  });

  /** A line whose runs need no browser is not held waiting for one. */
  it('reads what each line needs from its sections', () => {
    const d = decide(
      concurrent({
        free: { benches: { [LINE]: 2, [FOSS]: 1 }, browsers: 0, browsersHealthy: 1 },
        needs: { [LINE]: { bench: false, browser: false }, [FOSS]: { bench: true, browser: true } },
      }),
    );
    expect(started(d)).toEqual([`Alpha@${LINE}`, `Beta@${LINE}`, `Gamma@${LINE}`]);
    expect(d.held).toEqual([expect.objectContaining({ line: FOSS, why: 'full' })]);
  });

  it('serves requests first, in the order they were asked, before any backlog', () => {
    const d = decide(
      concurrent({
        schedule: migrateLines(
          {
            Gamma: { try_n: 0, flagged_at: minutesAgo(10) },
            Beta: { try_n: 0, flagged_at: minutesAgo(5) },
          },
          [LINE, FOSS],
        ),
        free: { benches: { [LINE]: 2, [FOSS]: 1 }, browsers: 2, browsersHealthy: 2 },
      }),
    );
    expect(started(d)).toEqual([`Gamma@${LINE}`, `Gamma@${FOSS}`]);
    expect(d.dispatches?.every((x) => x.source === 'requested')).toBe(true);
  });

  /** Each line waits out its own cooldown: a Yundera finish does not hold the FOSS line. */
  it('applies the cooldown per line, to the backlog only', () => {
    const d = decide(
      concurrent({
        lastFinishedAtByLine: { [LINE]: minutesAgo(5) },
        lastDoneAt: {},
      }),
    );
    expect(started(d)).toEqual([`Alpha@${FOSS}`]);
    expect(d.held).toEqual(
      expect.arrayContaining([expect.objectContaining({ line: LINE, why: 'cooldown' })]),
    );
  });

  it('never starts a cell that already holds a claim, and lets the same app run on the other line', () => {
    const schedule = migrateLines({}, [LINE, FOSS]);
    schedule.Alpha = { lines: { [LINE]: { try_n: 1, claim: { since: minutesAgo(3), try_n: 1 } } } };
    const d = decide(concurrent({ schedule, free: { benches: { [LINE]: 1, [FOSS]: 1 }, browsers: 2, browsersHealthy: 2 } }));
    expect(started(d)).toEqual([`Alpha@${FOSS}`, `Beta@${LINE}`]);
  });

  it('routes a trial to its own platform and gates it on that platform alone', () => {
    const d = decide(
      concurrent({
        subjects: [],
        capabilities: { [LINE]: { available: false }, [FOSS]: { available: true } },
        queuedTrials: [{ slug: 't1', subject: 'Ntfy', queued_at: minutesAgo(2), target: FOSS }],
      }),
    );
    expect(d.action).toBe('trial');
    expect(d.dispatches).toEqual([expect.objectContaining({ trial: 't1', line: FOSS, action: 'trial' })]);
  });

  it('holds a line at its head instead of skipping down it', () => {
    const d = decide(concurrent({ free: { benches: { [LINE]: 1, [FOSS]: 0 }, browsers: 3, browsersHealthy: 3 } }));
    // FOSS is full at Alpha; Beta@foss and Gamma@foss must not jump it.
    expect(started(d)).toEqual([`Alpha@${LINE}`]);
    expect(d.held?.map((h) => h.line).sort()).toEqual([FOSS, LINE].sort());
  });

  it('names every run it started in the state line', () => {
    expect(stateLine(decide(concurrent()))).toBe(
      `⏳ starting Alpha (${LINE}), Alpha (${FOSS}), Beta (${LINE})`,
    );
  });
});

/**
 * A request predating a platform is not a request for it. On 2026-10-02 promoting FOSS
 * resurrected 32 long-answered Yundera requests on the new line — none of them had a FOSS
 * attempt to be spent against — and they jumped a trial asked for that morning.
 */
describe('a request older than its line', () => {
  const FOSS = 'foss';

  function promoted(over: Partial<PolicyInput> = {}): PolicyInput {
    return {
      ...input({ subjects: ['Alpha'] }),
      sections: [
        { id: 'functional', line: LINE, scores: true },
        { id: 'functional@foss', line: FOSS, scores: true },
      ],
      capabilities: { [LINE]: { available: true }, [FOSS]: { available: true } },
      lastDoneAt: { Alpha: { [LINE]: daysAgo(1) } },
      lastAttemptAt: { Alpha: { [LINE]: daysAgo(1) } },
      schedule: migrateLines({ Alpha: { try_n: 0, flagged_at: daysAgo(3) } }, [LINE, FOSS]),
      lineSince: { [LINE]: new Date(0).toISOString(), [FOSS]: minutesAgo(30) },
      ...over,
    };
  }

  it('does not count on a line that did not exist when it was made', () => {
    expect(requests(promoted())).toEqual([]);
    // Still due on FOSS — never audited there — but as backlog, not as a request.
    const d = decide(promoted());
    expect(d.action).toBe('audit');
    expect(d.line).toBe(FOSS);
    expect(d.source).toBe('backlog');
  });

  it('counts on that line once it was made after the line existed', () => {
    const fresh = promoted({
      schedule: migrateLines({ Alpha: { try_n: 0, flagged_at: minutesAgo(5) } }, [LINE, FOSS]),
    });
    expect(requests(fresh).map((r) => r.lines ?? [LINE])).toEqual([[LINE, FOSS]]);
    expect(decide(fresh).source).toBe('requested');
  });

  /** The default line has always existed, so an outstanding ask for a never-audited app stands. */
  it('keeps a pending request for an app the default line has never audited', () => {
    const never = promoted({ lastDoneAt: {}, lastAttemptAt: {} });
    expect(requests(never)).toEqual([
      expect.objectContaining({ id: 'Alpha', lines: [LINE] }),
    ]);
  });

  it('changes nothing when the line has no recorded start', () => {
    expect(requests(promoted({ lineSince: undefined })).length).toBe(1);
  });
});
