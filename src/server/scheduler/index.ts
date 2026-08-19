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
import { adoptRollupSchedule, type RollupScheduleRow } from './adopt.js';
import { decide, stateLine, type SchedulerConstants, type SubjectSchedule, type TickDecision } from './policy.js';
import { openClaim, recordResult, type Outcome } from './record.js';

export { decide, stateLine } from './policy.js';
export type { PolicyInput, SchedulerConstants, SubjectSchedule, TickDecision } from './policy.js';
export { recordResult, openClaim } from './record.js';
export { adoptRollupSchedule, readRollupSchedule } from './adopt.js';
export type { RollupScheduleRow } from './adopt.js';
export type { Outcome, RecordResult } from './record.js';

interface ScheduleFile {
  subjects: Record<string, SubjectSchedule>;
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
  dispatch?: (job: { subject: string; depth: 'static' | 'full'; try_n: number }) => void;
}

export class Scheduler {
  private readonly file: string;
  private readonly opts: SchedulerOptions;
  private subjects: Record<string, SubjectSchedule> = {};
  private lastFinished?: string;
  private lastTick?: ScheduleFile['last_tick'];
  /** n8n's own cooldown anchor, handed over by the importer. See `lastFinishedAt`. */
  private externalFinish?: string;
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
  }

  get armed(): boolean {
    return this.opts.armed;
  }

  snapshot(): {
    armed: boolean;
    subjects: Record<string, SubjectSchedule>;
    last_finished_at?: string;
    last_tick?: ScheduleFile['last_tick'];
    their_claims: string[];
  } {
    return {
      armed: this.opts.armed,
      subjects: this.subjects,
      last_finished_at: this.lastFinishedAt(),
      last_tick: this.lastTick,
      their_claims: this.adoptedClaims,
    };
  }

  /**
   * Tell the scheduler when n8n last finished an audit.
   *
   * Cooldown is the one input shadow mode cannot derive for itself. The archive's
   * `finished_at` comes from the roll-up, which carries a *date* and no clock — every
   * imported assay reads as finished at midnight, so a 55-minute cooldown computed from it
   * has always already expired. The importer reads `- **Last audit finished:**` off the same
   * page it was already fetching and passes it here, which is what makes a cooldown tick
   * comparable between the two systems instead of a guaranteed divergence.
   *
   * Once Touchstone drives, its own recorded finishes take over and this stops mattering.
   */
  noteExternalFinish(iso: string | undefined): void {
    if (iso && !Number.isNaN(Date.parse(iso))) this.externalFinish = iso;
  }

  /**
   * Take n8n's try counts and parks from its roll-up — see `adopt.ts` for why this is not
   * optional. Ours always wins; this only fills in subjects we know nothing about.
   *
   * Transitional by construction: when the roll-up goes with Docmost at M5, the importer
   * stops calling this and every subject's state is one we recorded ourselves.
   */
  async adoptRollup(rows: readonly RollupScheduleRow[]): Promise<void> {
    const { schedule, adopted, theirClaims } = adoptRollupSchedule(this.subjects, rows);
    this.subjects = schedule;
    this.adoptedClaims = theirClaims;
    if (adopted.length > 0) await this.persist();
  }

  /** Subjects n8n itself is auditing right now. Reported, never adopted. */
  private adoptedClaims: string[] = [];

  private lastFinishedAt(): string | undefined {
    const ours = this.lastFinished;
    const theirs = this.externalFinish;
    if (ours && theirs) return Date.parse(ours) >= Date.parse(theirs) ? ours : theirs;
    return ours ?? theirs;
  }

  /**
   * Latest *completed* assay per subject — `blocked` and `running` are not completions.
   *
   * **`rollup_last_run` wins over `finished_at` while it is there**, and that is a
   * transitional rule with a reason. `finished_at` is the date on the report *page*;
   * `rollup_last_run` is the Last run column of the *row*, which is what n8n's own
   * eligibility reads. The two can disagree — on 2026-08-19 the roll-up listed Spliit as
   * audited on the 19th while the page it links to still carried the 12th — and while n8n
   * owns the loop, its row is the scheduling truth even where its page is behind. Reading
   * the page instead made Touchstone call Spliit stale, pick it, and diverge from n8n by
   * exactly one app.
   *
   * This is not principle 3 in reverse: the verdict, tier and risk still come from the
   * assay's own headline. Only *when it last ran* comes from the row, and only until
   * Touchstone writes the files itself at M5, after which no row exists to prefer.
   */
  private lastDoneAt(subjects: string[]): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const subject of subjects) {
      let newest: string | undefined;
      for (const leg of ['static', 'functional'] as const) {
        const rec = this.opts.index.latest(subject, leg);
        if (!rec) continue;
        const row = rec.meta.rollup_last_run;
        const at = typeof row === 'string' && row ? row : rec.meta.finished_at ? String(rec.meta.finished_at) : undefined;
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
    if (this.running) return this.lastTick?.decision ?? { action: 'idle', depth: 'full', reason: 'a tick is already running', backlog: 0, reclaimed: [], unparked: [] };
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

  private async runTick(opts: { forced?: string[]; now?: Date }): Promise<TickDecision> {
    const now = opts.now ?? new Date();
    const subjects = this.opts.registry.list();
    const leasable = this.opts.prober?.leasable() ?? [];
    const benchAvailable = this.opts.prober ? leasable.length > 0 : true;

    const decision = decide({
      now,
      constants: this.opts.constants,
      subjects,
      lastDoneAt: this.lastDoneAt(subjects),
      schedule: this.subjects,
      lastFinishedAt: this.lastFinishedAt(),
      forced: opts.forced,
      benchAvailable,
      benchNote: benchAvailable ? undefined : this.benchNote(),
    });

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
        message: this.opts.armed
          ? 'The scheduler picked the next app to audit'
          : 'The scheduler would have picked an app, but it is not armed',
        subject: decision.subject,
        detail: {
          subject: decision.subject,
          reason: decision.reason,
          backlog: decision.backlog,
          try_n: decision.try_n ?? 1,
          dry_run: !this.opts.armed,
        },
      });

      if (this.opts.armed) {
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
        this.opts.dispatch?.({ subject: decision.subject, depth: decision.depth, try_n: claim.try_n });
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
        last_finished_at: this.lastFinished,
        last_tick: this.lastTick,
      } satisfies ScheduleFile);
    } catch (err) {
      console.error('could not write schedule.json', err);
    }
  }
}
