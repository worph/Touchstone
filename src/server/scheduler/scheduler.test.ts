import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReportIndex } from '../store/index.js';
import type { SubjectRegistry } from '../store/registry.js';
import type { BenchProber } from '../services/bench.js';
import { EventLog } from '../services/events.js';
import { Scheduler, type SchedulerOptions } from './index.js';

const CONSTANTS = { fresh_days: 7, stuck_days: 7, lease_min: 120, cooldown_min: 55, max_tries: 3 };

let dir: string;
let events: EventLog;

/**
 * Just enough index: which sections exist, their latest completion, and their latest
 * attempt. `latestAny` answers the same record here — these fixtures hold nothing blocked,
 * and the two only diverge where a test is specifically about that.
 */
function indexOf(lastDone: Record<string, string>): ReportIndex {
  const latest = (subject: string, section: string) =>
    section === 'static' && lastDone[subject]
      ? ({ meta: { finished_at: lastDone[subject] } } as never)
      : null;
  return {
    sections: () => ['static', 'functional'],
    latest,
    latestAny: latest,
    subjects: () => Object.keys(lastDone),
  } as unknown as ReportIndex;
}

function registryOf(names: string[]): SubjectRegistry {
  return { list: () => names, isLive: true, lastFetchedAt: undefined } as unknown as SubjectRegistry;
}

function proberOf(leasable: number, rows: unknown[] = []): BenchProber {
  return {
    leasable: () => new Array(leasable).fill({ name: 'demostaging1' }),
    list: () => rows,
  } as unknown as BenchProber;
}

/** A pool that changes between ticks — an outage starting, or lifting, under a live scheduler. */
function changingPool(leasable: number, rows: unknown[] = []): BenchProber & { set: (n: number, r?: unknown[]) => void } {
  let now = { leasable, rows };
  return {
    leasable: () => new Array(now.leasable).fill({ name: 'demostaging1' }),
    list: () => now.rows,
    set: (n: number, r: unknown[] = now.rows) => {
      now = { leasable: n, rows: r };
    },
  } as unknown as BenchProber & { set: (n: number, r?: unknown[]) => void };
}

function make(over: Partial<SchedulerOptions> = {}): Scheduler {
  return new Scheduler({
    constants: CONSTANTS,
    armed: false,
    stateDir: dir,
    index: indexOf({}),
    registry: registryOf(['Alpha', 'Beta']),
    events,
    prober: proberOf(1),
    ...over,
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-sched-'));
  events = new EventLog(dir);
});

afterEach(async () => {
  await events.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('dry-run — what shadow mode depends on', () => {
  it('decides, logs the decision, and claims nothing', async () => {
    const s = make();
    const d = await s.tick();
    await events.flush();

    expect(d.action).toBe('audit');
    expect(d.subject).toBe('Alpha');
    // The whole point: a full decision, and no claim behind it.
    expect(s.snapshot().subjects.Alpha?.claim).toBeUndefined();
    expect(events.query({ code: 'CLAIM_OPENED' })).toHaveLength(0);

    const tick = events.query({ code: 'TICK_SELECTED' })[0];
    expect(tick?.detail).toMatchObject({ subject: 'Alpha', dry_run: true, try_n: 1 });
  });

  it('says out loud that it was not armed', async () => {
    await make().tick();
    await events.flush();
    expect(events.query({ code: 'TICK_SELECTED' })[0]?.message).toContain('not armed');
  });

  it('keeps the decision so the page has something to show before the next tick', async () => {
    const s = make();
    await s.tick();
    expect(s.snapshot().last_tick?.state).toBe('⏳ auditing Alpha — never run');
  });

  it('survives a restart with its state intact', async () => {
    const first = make();
    await first.tick();

    const second = make();
    await second.load();
    expect(second.snapshot().last_tick?.decision.subject).toBe('Alpha');
  });
});

describe('armed', () => {
  it('claims the subject it picked', async () => {
    const s = make({ armed: true });
    await s.tick();
    await events.flush();

    const claim = s.snapshot().subjects.Alpha?.claim;
    expect(claim?.try_n).toBe(1);
    expect(events.query({ code: 'CLAIM_OPENED' })).toHaveLength(1);
  });

  it('hands the job to the dispatcher when there is one', async () => {
    const jobs: Parameters<NonNullable<SchedulerOptions['dispatch']>>[0][] = [];
    const s = make({ armed: true, dispatch: (job) => { jobs.push(job); } });
    await s.tick();
    expect(jobs).toEqual([{ subject: 'Alpha', try_n: 1 }]);
  });

  /** An armed scheduler with no runner yet is a legitimate state during P4's bring-up. */
  it('claims without complaint when no dispatcher is wired', async () => {
    const s = make({ armed: true });
    await expect(s.tick()).resolves.toMatchObject({ action: 'audit' });
  });

  /** Single-flight, row B8: the claim it just wrote is what stops the next tick. */
  it('does not claim a second subject while the first is held', async () => {
    const s = make({ armed: true });
    await s.tick();
    const second = await s.tick();
    expect(second.action).toBe('idle');
    expect(second.reason).toContain('already in progress');
  });
});

describe('the bench gate', () => {
  it('idles and names the hosts when nothing is leasable', async () => {
    const s = make({
      prober: proberOf(0, [
        { name: 'demostaging1', status: 'healthy', remaining_min: 30 },
        { name: 'demostaging2', status: 'unreachable' },
      ]),
    });
    const d = await s.tick();
    await events.flush();

    expect(d.action).toBe('idle');
    expect(d.reason).toContain('demostaging1 only 0.5h left');
    expect(d.reason).toContain('demostaging2 unreachable');
    expect(events.query({ code: 'TICK_BENCH_GATED' })).toHaveLength(1);
  });

  /** No prober at all is not the same as a dead pool — a test rig has neither. */
  it('does not gate when there is no prober wired', async () => {
    const s = make({ prober: undefined });
    expect((await s.tick()).action).toBe('audit');
  });

  /**
   * One row per outage, not one per tick.
   *
   * On 2026-08-23 a dead pool wrote nineteen identical warnings between 12:00 and 13:22 — the
   * repetition alerts exist to end, and the reason the recovery was invisible in the noise. The
   * standing condition lives in the `bench.unreachable` alert; the log says when it began.
   */
  it('logs a gated tick once, not on every tick it stays gated', async () => {
    const s = make({ prober: proberOf(0, [{ name: 'demostaging1', status: 'unreachable' }]) });
    await s.tick();
    await s.tick();
    await s.tick();
    await events.flush();

    expect(events.query({ code: 'TICK_BENCH_GATED' })).toHaveLength(1);
  });

  /**
   * The transition is tested on the gate *condition*, never on `reason` — `benchNote()`
   * rewrites that every tick as the countdown ticks down, so a string comparison would report
   * a fresh outage every five minutes and undo the whole point.
   */
  it('stays quiet even though the reason text changes as the countdown runs', async () => {
    const pool = changingPool(0, [{ name: 'demostaging1', status: 'healthy', remaining_min: 30 }]);
    const s = make({ prober: pool });
    const first = await s.tick();
    pool.set(0, [{ name: 'demostaging1', status: 'healthy', remaining_min: 20 }]);
    const second = await s.tick();
    await events.flush();

    expect(first.reason).not.toBe(second.reason);
    expect(events.query({ code: 'TICK_BENCH_GATED' })).toHaveLength(1);
  });

  /**
   * The moment functional work becomes possible again — which had no row at all before, and
   * was the half the operator most needed. The bench alert cannot supply it: it stays open
   * while any *other* box is broken, so its resolution never fires for a partial recovery.
   */
  it('says so once when a bench becomes claimable again', async () => {
    const pool = changingPool(0, [{ name: 'demostaging1', status: 'unreachable' }]);
    const s = make({ prober: pool });
    await s.tick();
    pool.set(1, [{ name: 'demostaging1', status: 'healthy' }]);
    await s.tick();
    await s.tick();
    await events.flush();

    expect(events.query({ code: 'TICK_BENCH_UNGATED' })).toHaveLength(1);
  });
});

describe('recording a result', () => {
  it('releases the claim and starts the cooldown', async () => {
    const s = make({ armed: true });
    await s.tick();
    await s.record('Alpha', { kind: 'verdict' });

    expect(s.snapshot().subjects.Alpha?.claim).toBeUndefined();
    expect(s.snapshot().last_finished_at).toBeTruthy();

    const next = await s.tick();
    expect(next.reason).toContain('cooldown');
  });

  it('an agent that was busy costs neither a try nor the cooldown', async () => {
    const s = make({ armed: true });
    await s.tick();
    await s.record('Alpha', { kind: 'agent_busy' });

    expect(s.snapshot().subjects.Alpha?.try_n).toBe(0);
    expect(s.snapshot().last_finished_at).toBeUndefined();
    // Straight back into the backlog, unpunished.
    expect((await s.tick()).subject).toBe('Alpha');
  });

  it('logs the park when a subject runs out of tries', async () => {
    const s = make({ armed: true });
    for (let i = 0; i < 3; i++) {
      await s.tick();
      await s.record('Alpha', { kind: 'error', reason: 'agent-error' }, new Date());
    }
    await events.flush();
    expect(events.query({ code: 'CLAIM_PARKED' })).toHaveLength(1);
  });
});

describe('freshness reads completed assays only', () => {
  it('treats a subject with a recent verdict as fresh', async () => {
    const s = make({
      index: indexOf({ Alpha: new Date().toISOString(), Beta: new Date().toISOString() }),
      registry: registryOf(['Alpha', 'Beta']),
    });
    const d = await s.tick();
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('backlog empty');
  });
});

/**
 * Freshness reads the report's own `finished_at` and nothing else.
 *
 * It used to prefer `rollup_last_run`, because while n8n owned the loop its wiki row was the
 * scheduling truth even where its own report page was behind. There is no row any more —
 * nothing here reads a wiki — so the file's own timestamp is the only answer.
 */
describe('whose date counts as the last run', () => {
  function indexWith(meta: Record<string, unknown>): ReportIndex {
    const latest = (_s: string, section: string) =>
      section === 'static' ? ({ meta } as never) : null;
    return {
      sections: () => ['static', 'functional'],
      latest,
      latestAny: latest,
      subjects: () => ['Alpha'],
    } as unknown as ReportIndex;
  }

  it('treats a recent finish as fresh', async () => {
    const s = make({
      registry: registryOf(['Alpha']),
      index: indexWith({ finished_at: new Date().toISOString() }),
    });
    expect((await s.tick()).action).toBe('idle');
  });

  it('treats an old one as stale, whatever a leftover roll-up field says', async () => {
    const s = make({
      registry: registryOf(['Alpha']),
      index: indexWith({ finished_at: '2026-08-01T00:00:00Z', rollup_last_run: '2026-12-31' }),
    });
    expect((await s.tick()).action).toBe('audit');
  });
});

/**
 * The start/stop button. What matters is not that a boolean flips — it is that the flip
 * survives a restart without anyone editing `config.yaml`, and that stopping does not reach
 * into the run in flight.
 */
describe('automated mode — the runtime switch', () => {
  it('arms a scheduler the config file shipped disarmed, and dispatches', async () => {
    const dispatched: string[] = [];
    const s = make({ dispatch: (job) => void dispatched.push(job.subject) });
    await s.load();

    expect(s.armed).toBe(false);
    await s.setArmed(true);
    expect(s.armed).toBe(true);

    await s.tick();
    expect(dispatched).toEqual(['Alpha']);
    expect(s.snapshot().subjects.Alpha?.claim).toBeDefined();
  });

  it('remembers the switch across a restart, and says the config did not set it', async () => {
    const first = make();
    await first.load();
    await first.setArmed(true);

    // A whole new instance over the same state dir — the restart.
    const second = make();
    await second.load();
    expect(second.armed).toBe(true);
    expect(second.snapshot().armed_default).toBe(false);
    expect(second.snapshot().armed_source).toBe('override');
  });

  it('falls back to the config default when nothing has been pressed', async () => {
    const s = make({ armed: true });
    await s.load();
    expect(s.armed).toBe(true);
    expect(s.snapshot().armed_source).toBe('config');
  });

  it('leaves the claim in flight alone when it stops', async () => {
    const s = make({ armed: true });
    await s.load();
    await s.tick();
    const claim = s.snapshot().subjects.Alpha?.claim;
    expect(claim).toBeDefined();

    await s.setArmed(false);
    // The audit is still running and still holds its subject: stopping means "claim nothing
    // further", never "abandon the run", or the try is burned for nothing.
    expect(s.snapshot().subjects.Alpha?.claim).toEqual(claim);
    // And the next tick claims nobody else.
    await s.tick();
    expect(s.snapshot().subjects.Beta?.claim).toBeUndefined();
  });

  it('logs who changed it and what the config would have said', async () => {
    const s = make();
    await s.load();
    await s.setArmed(true);
    await s.setArmed(false);
    await events.flush();

    expect(events.query({ code: 'SCHEDULER_ARMED' })[0]?.detail).toMatchObject({
      armed: true,
      config_default: false,
    });
    expect(events.query({ code: 'SCHEDULER_DISARMED' })).toHaveLength(1);
  });

  it('does not log a change that changes nothing', async () => {
    const s = make();
    await s.load();
    await s.setArmed(false);
    await events.flush();
    expect(events.query({ code: 'SCHEDULER_DISARMED' })).toHaveLength(0);
  });
});

describe('the queue the page renders', () => {
  it('is the pick, extended — position 1 is the subject the next tick audits', async () => {
    const s = make({
      registry: registryOf(['Alpha', 'Beta', 'Gamma']),
      index: indexOf({
        Alpha: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        Beta: new Date(Date.now() - 9 * 86_400_000).toISOString(),
        Gamma: new Date().toISOString(),
      }),
    });
    await s.load();

    const rows = await s.previewQueue();
    const decision = await s.tick();

    expect(rows[0]?.subject).toBe(decision.subject);
    expect(rows[0]?.position).toBe(1);
    expect(rows.map((r) => r.subject)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(rows.map((r) => r.state)).toEqual(['due', 'due', 'fresh']);
    // Fresh subjects are listed but hold no position: "why is my app not being tested" is
    // the question the list has to answer, and an app missing from it answers nothing.
    expect(rows[2]?.position).toBeUndefined();
  });

  it('names the running subject rather than hiding it behind the backlog', async () => {
    const s = make({ armed: true });
    await s.load();
    await s.tick();

    const rows = await s.previewQueue();
    expect(rows.find((r) => r.subject === 'Alpha')?.state).toBe('running');
    expect(rows.find((r) => r.subject === 'Alpha')?.claim_since).toBeDefined();
  });

  it('reports a parked subject as parked, with the tries it burned', async () => {
    const s = make({ armed: true });
    await s.load();
    for (let i = 0; i < 3; i++) await s.record('Alpha', { kind: 'error', reason: 'agent-error' });

    const row = (await s.previewQueue()).find((r) => r.subject === 'Alpha');
    expect(row?.state).toBe('parked');
    expect(row?.try_n).toBe(3);
    expect(row?.position).toBeUndefined();
  });
});

/**
 * `state/schedule.json` written before a subject was `<origin>~<name>`.
 *
 * This is the one part of the rename that loses real state if it is skipped, and it loses it
 * *silently*: orphaned rows do not error, they read as "never audited". Every try counter
 * resets, every park lifts, and the next tick reports the whole store as backlog — the same
 * shape as the "69 against n8n's 32" divergence in HANDOFF, and just as invisible.
 */
describe('a schedule file written before subjects were keyed', () => {
  it('re-keys bare names into the default origin, keeping their state', async () => {
    await fs.writeFile(
      path.join(dir, 'schedule.json'),
      JSON.stringify({
        subjects: {
          Alpha: { try_n: 2 },
          Beta: { try_n: 3, parked_at: '2026-08-19T00:00:00.000Z' },
        },
        last_finished_at: '2026-08-19T12:00:00.000Z',
      }),
      'utf8',
    );

    const s = make();
    await s.load();
    const rows = s.snapshot().subjects;

    expect(rows['yundera~Alpha']?.try_n).toBe(2);
    expect(rows['yundera~Beta']?.try_n).toBe(3);
    expect(rows['yundera~Beta']?.parked_at).toBe('2026-08-19T00:00:00.000Z');
    // And the bare keys are gone, so nothing can read them back by accident.
    expect(rows.Alpha).toBeUndefined();
  });

  it('leaves an already-keyed file alone', async () => {
    await fs.writeFile(
      path.join(dir, 'schedule.json'),
      JSON.stringify({ subjects: { 'acme~Alpha': { try_n: 1 } } }),
      'utf8',
    );

    const s = make();
    await s.load();

    expect(s.snapshot().subjects['acme~Alpha']?.try_n).toBe(1);
    expect(s.snapshot().subjects['yundera~acme~Alpha']).toBeUndefined();
  });
});

/**
 * A run that was in flight when the rubric changed.
 *
 * `standardMoved` asks "have we looked at this app since the standard moved", and the answer
 * has to come from when the run *picked the rubric up*, not from when it put its report down.
 * An audit takes half an hour, so it can straddle an edit — and reading the finish then made
 * the scheduler believe the app had already been judged by a revision it had never seen. The
 * archive said otherwise the whole time: the assay records the old sha, so the Store page put
 * an `older standard` chip on a row the backlog called `fresh`, and nothing would re-audit it
 * until `fresh_days` ran out. `yundera~Terminal` sat like that for two weeks.
 */
describe('a run that straddled a standard edit', () => {
  const STARTED = '2026-08-24T12:04:11.457Z';
  const MOVED = '2026-08-24T12:12:25.097Z';
  const FINISHED = '2026-08-24T12:12:57.785Z';

  /** One subject, one section, one assay that began before `MOVED` and ended after it. */
  function straddling(): ReportIndex {
    const rec = { meta: { started_at: STARTED, finished_at: FINISHED } } as never;
    const at = (_subject: string, section: string) => (section === 'static' ? rec : null);
    return {
      sections: () => ['static'],
      latest: at,
      latestAny: at,
      subjects: () => ['Alpha'],
    } as unknown as ReportIndex;
  }

  function scheduler(): Scheduler {
    return make({
      index: straddling(),
      registry: registryOf(['Alpha']),
      standardMovedAt: async () => MOVED,
    });
  }

  it('is still eligible, because the standard it was judged by is not the one in force', async () => {
    const d = await scheduler().tick();
    expect(d.action).toBe('audit');
    expect(d.subject).toBe('Alpha');
    expect(d.reason).toContain('standard revised');
  });

  it('shows the row as due rather than fresh', async () => {
    const rows = await scheduler().previewQueue();
    expect(rows[0]).toMatchObject({ subject: 'Alpha', state: 'due', standard_moved: true });
  });

  /** The ordinary case still settles: a run that began after the edit has looked. */
  it('settles once a run begins under the new standard', async () => {
    const rec = { meta: { started_at: FINISHED, finished_at: FINISHED } } as never;
    const at = (_s: string, section: string) => (section === 'static' ? rec : null);
    const d = await make({
      index: {
        sections: () => ['static'],
        latest: at,
        latestAny: at,
        subjects: () => ['Alpha'],
      } as unknown as ReportIndex,
      registry: registryOf(['Alpha']),
      standardMovedAt: async () => MOVED,
    }).tick();
    expect(d.action).toBe('idle');
    expect(d.reason).toContain('backlog empty');
  });
});

/**
 * The claim is the scheduler's, so settling it cannot depend on the dispatcher behaving.
 *
 * On 2026-08-26 a report the volume would not let the runner write threw out of `dispatch`,
 * and the claim was simply never closed: `⏸️ idle — audit already in progress` on every tick
 * for two hours, then a reclaim that burned a try, three times, then a park. Four apps in a
 * row went that way and the loop did no work for fifteen hours. The only trace was a
 * `console.error` — nothing in the event log, nothing on a page.
 */
describe('a dispatcher that throws', () => {
  function throwing(): { scheduler: Scheduler; calls: () => number } {
    let calls = 0;
    const s = make({
      armed: true,
      registry: registryOf(['Alpha']),
      dispatch: async () => {
        calls += 1;
        throw new Error("EACCES: permission denied, open '/DATA/reports/yundera/Alpha/x.md'");
      },
    });
    return { scheduler: s, calls: () => calls };
  }

  it('releases the claim instead of leaving it to expire two hours later', async () => {
    const { scheduler } = throwing();
    await scheduler.tick();
    // The dispatcher rejects on a later turn than the tick that called it.
    await new Promise((r) => setImmediate(r));
    expect(scheduler.snapshot().subjects['Alpha']?.claim).toBeUndefined();
  });

  it('says so in the log, with the error the operator has to act on', async () => {
    const { scheduler } = throwing();
    await scheduler.tick();
    await new Promise((r) => setImmediate(r));
    await events.flush();

    const failed = events.query({ code: 'ASSAY_FAILED' })[0];
    expect(failed?.subject).toBe('Alpha');
    expect(failed?.level).toBe('error');
    expect(String((failed?.detail as { raw?: string })?.raw)).toContain('EACCES');
  });

  /** E7: the finish is stamped and the try is burned, so the backlog moves on. */
  it('burns the try and stamps the finish, so one broken app cannot hold the loop', async () => {
    const { scheduler } = throwing();
    await scheduler.tick();
    await new Promise((r) => setImmediate(r));

    const snap = scheduler.snapshot();
    expect(snap.subjects['Alpha']?.try_n).toBe(1);
    expect(snap.last_finished_at).toBeTruthy();
  });

  /** And it parks, rather than re-running a half-hour audit against a fault that persists. */
  it('parks after max_tries rather than retrying for ever', async () => {
    const { scheduler, calls } = throwing();
    for (let i = 0; i < CONSTANTS.max_tries + 2; i += 1) {
      const now = new Date(Date.now() + i * (CONSTANTS.cooldown_min + 1) * 60_000);
      await scheduler.tick({ now });
      await new Promise((r) => setImmediate(r));
    }
    expect(scheduler.snapshot().subjects['Alpha']?.parked_at).toBeTruthy();
    expect(calls()).toBe(CONSTANTS.max_tries);
  });
});

/**
 * The re-audit flag, end to end: the file it lands in, the event it writes, and the fact
 * that it is the *same* predicate the tick reads.
 *
 * Real `<origin>~<name>` keys throughout, unlike the blocks above: `load()` migrates a bare
 * name into one, so a test that restarts a scheduler has to speak the language the file does.
 */
const ALPHA = 'yundera~Alpha';
const BETA = 'yundera~Beta';

describe('flagging a subject for re-audit', () => {
  /** Alpha audited yesterday — inside `fresh_days`, so the backlog would skip it. */
  function fresh(): Scheduler {
    const at = new Date(Date.now() - 86_400_000).toISOString();
    return make({
      index: indexOf({ [ALPHA]: at, [BETA]: at }),
      registry: registryOf([ALPHA, BETA]),
    });
  }

  it('puts a fresh subject into the backlog and nothing else', async () => {
    const scheduler = fresh();
    await scheduler.load();
    expect((await scheduler.previewQueue()).filter((r) => r.position !== undefined)).toHaveLength(0);

    await scheduler.setFlagged(ALPHA, true);

    const rows = await scheduler.previewQueue();
    const alpha = rows.find((r) => r.subject === ALPHA);
    expect(alpha?.position).toBe(1);
    expect(alpha?.flagged).toBe(true);
    expect(rows.find((r) => r.subject === BETA)?.position).toBeUndefined();
  });

  /**
   * A park is an automatic judgement about a failing app; a flag is a person asking. The
   * person wins, or the control is offered on the one row it cannot act on — which is how the
   * Automation page came to hide it on parked rows, leaving an operator staring at a stuck app
   * with nothing to press. `try_n` resets with the park, or the next single failure would
   * re-park immediately and the flag would have bought one attempt.
   */
  it('releases a park, because an operator asking outranks an automatic one', async () => {
    const scheduler = fresh();
    await scheduler.load();
    // Park it the way three failed attempts would.
    await scheduler.record(ALPHA, { kind: 'error', reason: 'agent-error' });
    await scheduler.record(ALPHA, { kind: 'error', reason: 'agent-error' });
    await scheduler.record(ALPHA, { kind: 'error', reason: 'agent-error' });
    expect((await scheduler.previewQueue()).find((r) => r.subject === ALPHA)?.state).toBe('parked');

    await scheduler.setFlagged(ALPHA, true);

    const alpha = (await scheduler.previewQueue()).find((r) => r.subject === ALPHA);
    expect(alpha?.state).not.toBe('parked');
    expect(alpha?.position).toBeDefined();
    expect(alpha?.try_n).toBe(0);
  });

  it('leaves try_n alone when the subject was not parked', async () => {
    const scheduler = fresh();
    await scheduler.load();
    await scheduler.record(ALPHA, { kind: 'error', reason: 'agent-error' });
    await scheduler.setFlagged(ALPHA, true);
    expect((await scheduler.previewQueue()).find((r) => r.subject === ALPHA)?.try_n).toBe(1);
  });

  it('survives a restart, because it is state rather than a request', async () => {
    const first = fresh();
    await first.load();
    await first.setFlagged(ALPHA, true);

    const second = fresh();
    await second.load();
    expect(second.isFlagged(ALPHA)).toBe(true);
  });

  it('logs who asked, both ways round', async () => {
    const scheduler = fresh();
    await scheduler.load();
    await scheduler.setFlagged(ALPHA, true, 'chat');
    await scheduler.setFlagged(ALPHA, false, 'operator');

    const flagged = events.query({ code: 'SUBJECT_FLAGGED' })[0];
    expect(flagged?.subject).toBe(ALPHA);
    expect((flagged?.detail as { by?: string })?.by).toBe('chat');
    expect(events.query({ code: 'SUBJECT_UNFLAGGED' })).toHaveLength(1);
  });

  it('reports nothing changed when the flag is already where it is asked to be', async () => {
    const scheduler = fresh();
    await scheduler.load();
    expect(await scheduler.setFlagged(ALPHA, true)).toBe(true);
    expect(await scheduler.setFlagged(ALPHA, true)).toBe(false);
    expect(events.query({ code: 'SUBJECT_FLAGGED' })).toHaveLength(1);
  });

  /**
   * `isFlagged` is what the subject page renders and the queue is what the Automation page
   * renders; they read one predicate, so the two surfaces cannot disagree about the word.
   */
  it('stops reading as flagged once an attempt has answered it', async () => {
    const scheduler = fresh();
    await scheduler.load();
    await scheduler.setFlagged(ALPHA, true);
    expect(scheduler.isFlagged(ALPHA)).toBe(true);

    // An attempt recorded *after* the flag — the audit it asked for.
    const after = make({
      index: indexOf({ [ALPHA]: new Date(Date.now() + 1000).toISOString() }),
      registry: registryOf([ALPHA, BETA]),
    });
    await after.load();
    expect(after.isFlagged(ALPHA)).toBe(false);
    expect((await after.previewQueue()).find((r) => r.subject === ALPHA)?.flagged).toBeUndefined();
  });

  it('claims the flagged subject on the next tick once armed', async () => {
    const picked: string[] = [];
    const at = new Date(Date.now() - 86_400_000).toISOString();
    const scheduler = make({
      armed: true,
      index: indexOf({ [ALPHA]: at, [BETA]: at }),
      registry: registryOf([ALPHA, BETA]),
      dispatch: (job) => {
        picked.push(job.subject);
      },
    });
    await scheduler.load();
    expect((await scheduler.tick()).action).toBe('idle');

    await scheduler.setFlagged(BETA, true);
    const d = await scheduler.tick();
    expect(d.action).toBe('audit');
    expect(d.subject).toBe(BETA);
    expect(d.reason).toContain('flagged for re-audit');
    await new Promise((r) => setImmediate(r));
    expect(picked).toEqual([BETA]);
  });
});
