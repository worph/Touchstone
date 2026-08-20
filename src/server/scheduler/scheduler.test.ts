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

/** Just enough index: the scheduler only ever asks for the latest completed assay. */
function indexOf(lastDone: Record<string, string>): ReportIndex {
  return {
    latest: (subject: string, leg: string) =>
      leg === 'static' && lastDone[subject]
        ? ({ meta: { finished_at: lastDone[subject] } } as never)
        : null,
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
    expect(jobs).toEqual([{ subject: 'Alpha', depth: 'full', try_n: 1 }]);
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
    return {
      latest: (_s: string, leg: string) => (leg === 'static' ? ({ meta } as never) : null),
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
