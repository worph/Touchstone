/**
 * The driver — the timer, the state file, and the wiring that turns `policy.decide` into
 * something that happens. Rows A1–A3, B1–B9, C1–C2 and the D7 gate.
 *
 * **It ships dry-run and that is not a placeholder.** With `scheduler.armed: false` it
 * derives the full decision, writes the tick to the event log, and dispatches nothing —
 * which is exactly what shadow mode needs: n8n keeps driving, the importer keeps refreshing
 * the archive every fifteen minutes, and the two systems' picks can be compared over ~150
 * real ticks before anything of ours is allowed to claim a subject.
 *
 * Reads that the decision needs, and where each comes from:
 *
 * | Input | Source | Why there |
 * | --- | --- | --- |
 * | subjects | `SubjectRegistry` | GitHub `Apps/`, with the built-in list as cold start |
 * | last run per subject | `ReportIndex.latest()` | *completed* assays only — a blocked run is not a run |
 * | try / park / claim | `state/schedule.json` | scheduling policy, not a property of any assay |
 * | cooldown anchor | the roll-up, then the archive | see `lastFinishedAt` below |
 * | bench | `BenchProber.leasable()` | row D7, and D8's runway rule with it |
 */

import path from 'node:path';

import { readJson, writeJsonAtomic } from '../store/state.js';
import type { ReportIndex } from '../store/index.js';
import type { SubjectRegistry } from '../store/registry.js';
import type { BenchProber } from '../services/bench.js';
import type { EventLog } from '../services/events.js';
import {
  cooldownLeftMin,
  decide,
  queue,
  stateLine,
  type SchedulerConstants,
  type SubjectSchedule,
  type TickDecision,
} from './policy.js';
import type { QueueRow, ScheduleConstants } from '../../shared/schedule.js';
import { openClaim, recordResult, type Outcome } from './record.js';

export { decide, stateLine, queue, cooldownLeftMin } from './policy.js';
export type { PolicyInput, SchedulerConstants, SubjectSchedule, TickDecision } from './policy.js';
export { recordResult, openClaim } from './record.js';
export type { Outcome, RecordResult } from './record.js';

interface ScheduleFile {
  subjects: Record<string, SubjectSchedule>;
  /**
   * The automated-mode switch, when someone has pressed it.
   *
   * `config.yaml` is hand-edited and seeded inert (`store/config.ts`), so the button cannot
   * write there without turning a file people edit into a file the app edits. Absent means
   * "no one has said otherwise" and the config value stands; present, it wins. Deleting this
   * file therefore returns the loop to whatever the config file asks for, which is the
   * behaviour you want from a state file holding a switch that dispatches work.
   */
  armed?: boolean;
  /** Set when *we* record a finish. In shadow mode it stays empty; see `lastFinishedAt`. */
  last_finished_at?: string;
  /** The most recent decision, so the UI can show what the scheduler thinks without a tick. */
  last_tick?: { at: string; state: string; decision: TickDecision };
}

export interface SchedulerOptions {
  constants: SchedulerConstants;
  /** False means decide and log; never claim, never dispatch. */
  armed: boolean;
  stateDir: string;
  index: ReportIndex;
  registry: SubjectRegistry;
  events: EventLog;
  prober?: BenchProber;
  /**
   * Called when an armed scheduler has claimed a subject. Absent until the runner lands
   * (P4), which is why an armed scheduler with no dispatcher still only claims.
   */
  dispatch?: (job: { subject: string; try_n: number }) => void | Promise<void>;
}

export class Scheduler {
  private readonly file: string;
  private readonly opts: SchedulerOptions;
  private subjects: Record<string, SubjectSchedule> = {};
  private lastFinished?: string;
  private lastTick?: ScheduleFile['last_tick'];
  private armedOverride?: boolean;
  private tickMs?: number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.file = path.join(opts.stateDir, 'schedule.json');
  }

  async load(): Promise<void> {
    const stored = await readJson<ScheduleFile>(this.file, { subjects: {} });
    this.subjects = stored?.subjects && typeof stored.subjects === 'object' ? stored.subjects : {};
    this.lastFinished = stored?.last_finished_at;
    this.lastTick = stored?.last_tick;
    this.armedOverride = typeof stored?.armed === 'boolean' ? stored.armed : undefined;
  }

  get armed(): boolean {
    return this.armedOverride ?? this.opts.armed;
  }

  /**
   * Start or stop the loop at runtime — the start/stop button.
   *
   * Stopping is deliberately *only* "claim nothing further". An audit already dispatched
   * runs to its end and records normally, because tearing one down mid-flight burns a try
   * (invariant 3 gives that back only for infra conditions), orphans the ledger token the
   * agent is still writing against, and leaves the claim held until `lease_min` expires. A
   * loop you can stop without corrupting the run in flight is worth the extra half hour.
   */
  async setArmed(armed: boolean, by = 'operator'): Promise<void> {
    if (this.armed === armed) return;
    this.armedOverride = armed;
    this.opts.events.log({
      level: 'info',
      code: armed ? 'SCHEDULER_ARMED' : 'SCHEDULER_DISARMED',
      message: armed
        ? 'Automated mode is on — the scheduler will claim and dispatch audits'
        : 'Automated mode is off — any audit already running will finish, and nothing new starts',
      detail: { armed, by, config_default: this.opts.armed },
    });
    await this.persist();
  }

  snapshot(): {
    armed: boolean;
    armed_default: boolean;
    armed_source: 'config' | 'override';
    subjects: Record<string, SubjectSchedule>;
    last_finished_at?: string;
    last_tick?: ScheduleFile['last_tick'];
    next_tick_at?: string;
    cooldown_left_min: number;
    constants: ScheduleConstants;
  } {
    return {
      armed: this.armed,
      armed_default: this.opts.armed,
      armed_source: this.armedOverride === undefined ? 'config' : 'override',
      subjects: this.subjects,
      last_finished_at: this.lastFinishedAt(),
      last_tick: this.lastTick,
      ...(this.nextTickAt() ? { next_tick_at: this.nextTickAt() } : {}),
      cooldown_left_min: cooldownLeftMin({
        now: new Date(),
        cooldown_min: this.opts.constants.cooldown_min,
        lastFinishedAt: this.lastFinishedAt(),
      }),
      // Named one by one rather than spread: `config.yaml`'s scheduler block carries
      // `armed` and `tick_min` too, and a spread would ship the switch inside the block of
      // numbers describing the cadence.
      constants: {
        tick_min: (this.tickMs ?? 0) / 60_000,
        fresh_days: this.opts.constants.fresh_days,
        stuck_days: this.opts.constants.stuck_days,
        lease_min: this.opts.constants.lease_min,
        cooldown_min: this.opts.constants.cooldown_min,
        max_tries: this.opts.constants.max_tries,
      },
    };
  }

  /**
   * When the timer next fires, derived from the last tick rather than from when the process
   * booted — after a restart the two differ by however long the box was down, and a
   * countdown that lies about that is worse than no countdown.
   */
  private nextTickAt(): string | undefined {
    if (!this.tickMs || !this.lastTick) return undefined;
    return new Date(Date.parse(this.lastTick.at) + this.tickMs).toISOString();
  }

  /**
   * The backlog in the order it would be worked. Reads the world exactly as a tick does and
   * decides nothing — safe to call from a route on every poll.
   */
  async previewQueue(now = new Date()): Promise<QueueRow[]> {
    return queue(this.buildInput({ now }));
  }



  /** When we last finished an audit. Ours alone now that nothing else feeds this. */
  private lastFinishedAt(): string | undefined {
    return this.lastFinished;
  }

  /**
   * Latest *completed* assay per subject — `blocked` and `running` are not completions.
   *
   * `finished_at` is the only source now. It used to prefer `rollup_last_run`, because while
   * n8n owned the loop its wiki row was the scheduling truth even where its own report page
   * was behind. That row no longer exists here: nothing reads the wiki, and the files
   * Touchstone writes carry a real timestamp rather than a date at midnight.
   *
   * Imported files from the migration still carry midnight timestamps. That is accurate to
   * day granularity, which is all `fresh_days` needs.
   */
  private lastDoneAt(subjects: string[]): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const subject of subjects) {
      let newest: string | undefined;
      // Every section, not a fixed two: a subject is as fresh as its most recently completed
      // section, whatever the protocol happens to be made of this month.
      for (const section of this.opts.index.sections()) {
        const rec = this.opts.index.latest(subject, section);
        const at = rec?.meta.finished_at ? String(rec.meta.finished_at) : undefined;
        if (at && (!newest || at > newest)) newest = at;
      }
      out[subject] = newest;
    }
    return out;
  }

  /**
   * One tick. Safe to call by hand — the timer and a hand-run tick coalesce, because two
   * ticks racing could both claim under single-flight.
   */
  async tick(opts: { forced?: string[]; now?: Date } = {}): Promise<TickDecision> {
    if (this.running) return this.lastTick?.decision ?? { action: 'idle', reason: 'a tick is already running', backlog: 0, reclaimed: [], unparked: [] };
    this.running = true;
    try {
      return await this.runTick(opts);
    } catch (err) {
      this.opts.events.log({
        level: 'error',
        code: 'TICK_FAILED',
        message: 'The scheduler could not complete a tick',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    } finally {
      this.running = false;
    }
  }

  /**
   * The world, as the policy wants it. One reader, so a tick and the queue the page renders
   * cannot disagree about who is stale.
   */
  private buildInput(opts: { forced?: string[]; now: Date }) {
    const subjects = this.opts.registry.list();
    const leasable = this.opts.prober?.leasable() ?? [];
    const benchAvailable = this.opts.prober ? leasable.length > 0 : true;
    return {
      now: opts.now,
      constants: this.opts.constants,
      subjects,
      lastDoneAt: this.lastDoneAt(subjects),
      schedule: this.subjects,
      lastFinishedAt: this.lastFinishedAt(),
      forced: opts.forced,
      benchAvailable,
      benchNote: benchAvailable ? undefined : this.benchNote(),
    };
  }

  private async runTick(opts: { forced?: string[]; now?: Date }): Promise<TickDecision> {
    const now = opts.now ?? new Date();
    const decision = decide(this.buildInput({ now, forced: opts.forced }));

    // Reclaims and unparks are state changes the decision already made; apply them whether
    // or not we are armed, because they are bookkeeping about *our own* claims. In dry-run
    // there are none to apply, which is exactly why this is safe.
    for (const r of decision.reclaimed) {
      const row = this.subjects[r.subject];
      if (row) {
        row.claim = undefined;
        row.try_n = r.try_n;
        if (r.outcome === 'parked') row.parked_at = now.toISOString();
      }
      this.opts.events.log({
        level: 'warn',
        code: 'CLAIM_RECLAIMED',
        message:
          r.outcome === 'parked'
            ? `An audit that never finished has used up its last attempt`
            : `An audit that never finished has released its subject`,
        subject: r.subject,
        detail: { subject: r.subject, try_n: r.try_n, outcome: r.outcome },
      });
    }
    for (const subject of decision.unparked) {
      const row = this.subjects[subject];
      if (row) {
        row.parked_at = undefined;
        row.try_n = 0;
      }
      this.opts.events.log({
        level: 'info',
        code: 'CLAIM_UNPARKED',
        message: 'A parked subject has served its time and is eligible again',
        subject,
        detail: { subject },
      });
    }

    if (decision.action === 'audit' && decision.subject) {
      this.opts.events.log({
        level: 'info',
        code: 'TICK_SELECTED',
        message: this.armed
          ? 'The scheduler picked the next app to audit'
          : 'The scheduler would have picked an app, but it is not armed',
        subject: decision.subject,
        detail: {
          subject: decision.subject,
          reason: decision.reason,
          backlog: decision.backlog,
          try_n: decision.try_n ?? 1,
          dry_run: !this.armed,
        },
      });

      if (this.armed) {
        this.subjects[decision.subject] = openClaim({ now, schedule: this.subjects[decision.subject] });
        const claim = this.subjects[decision.subject]!.claim!;
        this.opts.events.log({
          level: 'info',
          code: 'CLAIM_OPENED',
          message: 'The scheduler claimed an app and is starting its audit',
          subject: decision.subject,
          detail: { subject: decision.subject, try_n: claim.try_n, since: claim.since },
        });
        // No dispatcher yet is not an error: an armed scheduler with no runner claims and
        // waits, which is a legitimate state during P4's bring-up.
        //
        // Deliberately not awaited. An audit takes half an hour; a tick that waited for it
        // would hold the timer, and the claim it just wrote is what stops the next tick from
        // starting a second one. The dispatcher reports back through `record()`.
        void Promise.resolve(
          this.opts.dispatch?.({ subject: decision.subject, try_n: claim.try_n }),
        ).catch((err) => console.error('dispatch failed', err));
      }
    } else if (decision.reason.startsWith('no usable demo bench')) {
      this.opts.events.log({
        level: 'warn',
        code: 'TICK_BENCH_GATED',
        message: 'The tick found no demo bench worth claiming, so nothing was audited',
        detail: { reason: decision.reason, backlog: decision.backlog },
      });
    } else {
      this.opts.events.log({
        level: 'debug',
        code: 'TICK_IDLE',
        message: 'The tick had nothing to do',
        detail: { reason: decision.reason, backlog: decision.backlog },
      });
    }

    this.lastTick = { at: now.toISOString(), state: stateLine(decision), decision };
    await this.persist();
    return decision;
  }

  /**
   * Why no bench, in one clause. Names the hosts and what each said, because "no usable
   * demo bench" on its own sends whoever reads it to go and look the same thing up.
   */
  private benchNote(): string {
    const rows = this.opts.prober?.list() ?? [];
    if (rows.length === 0) return 'the pool has not been read';
    return rows
      .map((b) => {
        if (b.status !== 'healthy') return `${b.name} ${b.status}`;
        if (b.processing) return `${b.name} mid-cleanup`;
        if (b.remaining_min !== undefined && b.remaining_min !== null)
          return `${b.name} only ${(b.remaining_min / 60).toFixed(1)}h left`;
        return `${b.name} no countdown`;
      })
      .join(', ');
  }

  /** Apply a finished attempt — rows E1, E5–E7. */
  async record(subject: string, outcome: Outcome, now = new Date()): Promise<void> {
    const result = recordResult({
      now,
      constants: this.opts.constants,
      subject,
      outcome,
      schedule: this.subjects[subject],
    });
    this.subjects[subject] = result.schedule;
    if (result.stampsFinish) this.lastFinished = now.toISOString();
    if (result.parked) {
      this.opts.events.log({
        level: 'warn',
        code: 'CLAIM_PARKED',
        message: 'An app has failed too many times in a row and is being left alone for a while',
        subject,
        detail: {
          subject,
          try_n: result.schedule.try_n,
          until_days: this.opts.constants.stuck_days,
        },
      });
    }
    await this.persist();
  }

  start(intervalMs: number): void {
    this.tickMs = intervalMs;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error('scheduler tick failed', err));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async persist(): Promise<void> {
    try {
      await writeJsonAtomic(this.file, {
        subjects: this.subjects,
        ...(this.armedOverride === undefined ? {} : { armed: this.armedOverride }),
        last_finished_at: this.lastFinished,
        last_tick: this.lastTick,
      } satisfies ScheduleFile);
    } catch (err) {
      console.error('could not write schedule.json', err);
    }
  }
}
