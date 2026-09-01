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

import { asSubjectKey, isSubjectKey, type SubjectKey } from '../../shared/subject.js';
import { readJson, writeJsonAtomic } from '../store/state.js';
import type { ReportIndex } from '../store/index.js';
import type { SubjectRegistry } from '../store/registry.js';
import type { BenchProber } from '../services/bench.js';
import type { EventLog } from '../services/events.js';
import {
  cooldownLeftMin,
  decide,
  isFlaggedForReaudit,
  queue,
  requests,
  stateLine,
  type PolicyInput,
  type SchedulerConstants,
  type SubjectSchedule,
  type TickDecision,
} from './policy.js';
import type { QueueRow, RequestRow, ScheduleConstants } from '../../shared/schedule.js';
import { openClaim, recordResult, type Outcome } from './record.js';

/**
 * Re-key a `state/schedule.json` written before a subject was `<origin>~<name>`.
 *
 * Load-bearing, and it must never be dropped: without it every row is orphaned on the first
 * boot after the rename. Try counters reset, parks lift, the cooldown anchor is lost and every
 * subject reads as never audited — so the first tick reports the entire store as backlog. That
 * is the same class of error as the "69 against n8n's 32" divergence in HANDOFF, and it is
 * invisible until you compare the two systems.
 *
 * Idempotent: a key that already carries the separator is left alone.
 */
function migrateKeys(
  stored: Record<string, SubjectSchedule | undefined>,
): Record<string, SubjectSchedule> {
  const out: Record<string, SubjectSchedule> = {};
  for (const [key, row] of Object.entries(stored)) {
    if (!row) continue;
    out[isSubjectKey(key) ? key : asSubjectKey(key)] = row;
  }
  return out;
}

/**
 * Was this tick stopped by the bench gate?
 *
 * The condition, never the reason string: `benchNote()` interpolates each bench's countdown,
 * so two consecutive gated ticks produce two different `reason`s and any equality check would
 * report a transition every five minutes — which is the repetition this predicate exists to
 * end. `decide()` builds the reason with this exact prefix (`policy.ts`), and `policy.test.ts`
 * pins it.
 */
function benchGated(decision: TickDecision | undefined): boolean {
  return decision?.action === 'idle' && decision.reason.startsWith('no usable demo bench');
}

export { decide, stateLine, queue, requests, cooldownLeftMin } from './policy.js';
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
  /**
   * How often the timer fires, in minutes — `config.yaml`'s `scheduler.tick_min`.
   *
   * Not one of `constants`: those five are what `policy.decide` is given, and the cadence is
   * not an input to the decision, it is how often the decision is taken. It is held here so
   * the object knows its own period before `start()` arms it — a `tick_min` control restored
   * at boot has somewhere to land, and `start()` then arms the timer at whatever the cadence
   * ended up being rather than at whatever the caller remembered.
   */
  tickMin?: number;
  /** False means decide and log; never claim, never dispatch. */
  armed: boolean;
  stateDir: string;
  index: ReportIndex;
  registry: SubjectRegistry;
  events: EventLog;
  prober?: BenchProber;
  /**
   * When the standard last moved — `readStandards().moved_at`, read fresh each tick.
   *
   * A function rather than a value because the protocol directory is a volume an operator
   * edits over SSH: a snapshot taken at boot would be exactly as wrong as the rubric held in
   * memory since boot that `runner.plan()` already re-reads to avoid. Absent, or resolving
   * to `undefined`, leaves the eligibility rule inert.
   */
  standardMovedAt?: () => Promise<string | undefined>;
  /**
   * What version of each subject the stores currently offer — `SubjectRegistry.versions()`.
   *
   * Read per tick from the registry's own cached map, so this costs no request of its own:
   * the tree fetch rides the registry refresh that already happens.
   */
  subjectVersions?: () => Record<string, string | undefined>;
  /**
   * Called when an armed scheduler has claimed a subject. Absent until the runner lands
   * (P4), which is why an armed scheduler with no dispatcher still only claims.
   */
  dispatch?: (job: { subject: SubjectKey; try_n: number }) => void | Promise<void>;
  /**
   * Whether the single agent is in somebody's hands — `() => runner.busy`.
   *
   * The scheduler's own single-flight is the claim, and a **trial** holds the agent while
   * holding no claim by design (`routes/trials.ts`: a trial says nothing about a subject's
   * schedule). So without this the tick is blind to half of what the agent does, and the
   * kick below would spin against a running trial for its whole duration.
   */
  agentBusy?: () => boolean;
  /**
   * Write the attempt record for a dispatch that threw — `Runner.recordFailedDispatch`.
   *
   * Absent, `dispatchFailed` charges a try and records nothing, which is invariant 14's
   * violation and, since the request queue, a queue head that can never be spent.
   */
  recordFailedDispatch?: (subject: SubjectKey, reason: string) => Promise<void>;
  /**
   * The trial half of the request queue: what is waiting, what is running, and how to start
   * one.
   *
   * A narrow port rather than the `TrialStore` itself, and the narrowness is the point. The
   * scheduler learns that a trial exists, was asked for at a time, and can be started — and
   * learns nothing else. In particular it never calls `record()` for one, which is what
   * preserves the actual content of the rule that a trial must not touch a subject's
   * schedule: a trial can take the agent, because there is only one; it cannot move a
   * hallmark, a try count or a park.
   */
  trials?: {
    queued: () => { slug: string; subject: string; queued_at: string }[];
    running: () => { slug: string; subject: string; queued_at: string } | undefined;
    dispatch: (slug: string) => void | Promise<void>;
    /** Mark a row failed when its dispatch threw, so it leaves the queue instead of haunting it. */
    failed?: (slug: string, reason: string) => void | Promise<void>;
  };
  /**
   * How long after a completed run to look again, in ms. 0 disables the kick entirely.
   *
   * Injectable so the tests that call `record()` directly do not start dispatching real runs
   * and leaking timers. See `kick()`.
   */
  kickMs?: number;
}

export class Scheduler {
  private readonly file: string;
  private readonly opts: SchedulerOptions;
  private subjects: Record<string, SubjectSchedule> = {};
  private lastFinished?: string;
  private lastTick?: ScheduleFile['last_tick'];
  private armedOverride?: boolean;
  /**
   * The cadence numbers someone has changed at runtime — `domain/controls.ts`.
   *
   * Held here rather than persisted here, which is the opposite of `armedOverride` and
   * deliberate: `ControlStore` owns the file every control's override lives in, and a second
   * writer for these six would put the same numbers in two files with no rule about which
   * wins. The composition root re-applies what was stored after `load()`, so a restart comes
   * back up on them.
   */
  private constantsOverride: Partial<SchedulerConstants> = {};
  private tickMs?: number;
  private timer?: ReturnType<typeof setInterval>;
  /** The one-shot look-again after a completed run. At most one is ever outstanding. */
  private kickTimer?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.file = path.join(opts.stateDir, 'schedule.json');
    if (opts.tickMin) this.tickMs = opts.tickMin * 60_000;
  }

  async load(): Promise<void> {
    const stored = await readJson<ScheduleFile>(this.file, { subjects: {} });
    this.subjects =
      stored?.subjects && typeof stored.subjects === 'object' ? migrateKeys(stored.subjects) : {};
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

  /**
   * Forget the runtime switch, back to what `config.yaml` asks for.
   *
   * The reset half of the same control. It logs only when the effective value actually
   * moves: reverting an override that already agreed with the file changes nothing anybody
   * needs to be told about, and a log that reports non-events is one nobody reads.
   */
  async clearArmed(by = 'operator'): Promise<void> {
    if (this.armedOverride === undefined) return;
    const before = this.armed;
    this.armedOverride = undefined;
    if (this.armed !== before) {
      this.opts.events.log({
        level: 'info',
        code: this.armed ? 'SCHEDULER_ARMED' : 'SCHEDULER_DISARMED',
        message: this.armed
          ? 'Automated mode is on again — config.yaml asks for it'
          : 'Automated mode is off again — config.yaml asks for it',
        detail: { armed: this.armed, by, config_default: this.opts.armed },
      });
    }
    await this.persist();
  }

  /**
   * Whether a re-audit flag is *counting* for this subject.
   *
   * The same predicate the tick uses, not a second reading of the stored field — otherwise
   * the subject page would offer "unflag" for a flag the queue had already spent, and the
   * two surfaces would disagree about the same word.
   */
  isFlagged(subject: string): boolean {
    return isFlaggedForReaudit(
      this.subjects[subject]?.flagged_at,
      this.lastAttemptAt([subject])[subject],
    );
  }

  /**
   * Flag a subject for re-audit, or take the flag off again.
   *
   * Since 2026-09-01 this **is** the request queue for audits — `POST /assays` writes it and
   * `decide()` picks from it ahead of the backlog. All it writes is still a timestamp:
   * eligibility is derived from it on every tick (`flaggedForReaudit` in `policy.ts`) and the
   * request is spent by the next *attempt*, whatever that attempt concluded. There is no
   * second write to lose, a request cannot outlive the audit it asked for, and a run killed
   * mid-flight leaves it correctly still queued rather than stuck.
   *
   * **The guard is the derived state, not the stored field**, and that is a fix rather than a
   * detail. `flagged_at` is never cleared — `record.ts` carries it through every branch on
   * purpose — so after one request and one audit the field is still set while `isFlagged()`
   * correctly reads false. Guarding on `Boolean(row.flagged_at)` therefore refused to write a
   * *new* request for any subject that had ever carried one: harmless while this only moved a
   * glyph, fatal once it is the queue, because Audit would silently do nothing on exactly the
   * apps an operator returns to. Re-requesting overwrites the timestamp, which is also what
   * gives the queue its ordering key.
   *
   * Returns whether anything moved, so the route can answer honestly rather than reporting a
   * change it did not make.
   */
  async setFlagged(subject: string, flagged: boolean, by = 'operator'): Promise<boolean> {
    const row = this.subjects[subject] ?? { try_n: 0 };
    if (this.isFlagged(subject) === flagged) return false;
    const at = new Date().toISOString();
    // Flagging releases a park, and that is the point rather than a side effect.
    //
    // `plan()` skips a parked row *before* it looks at any eligibility clause, so until now a
    // flag on a parked subject was a control that quietly did nothing — the Automation page
    // hid the button on those rows for exactly that reason, which left the one row an operator
    // most wants to act on as the one row offering nothing. A park exists to stop a reliably
    // failing app starving the backlog *automatically*; a person asking for a look is not that,
    // and outranks it. The try count goes back to zero with it, or the next single failure
    // would re-park the app immediately and the flag would have bought one attempt.
    //
    // Read off `flagged` rather than off the false→true edge: with the guard above now
    // testing the *derived* state, a subject that was parked while carrying a spent flag is a
    // reachable state, and an unpark that only fired on the edge would skip it — leaving a row
    // that reports itself queued and can never be picked, which is the one thing a queue must
    // not contain.
    const unparked = flagged && Boolean(row.parked_at);
    this.subjects[subject] = {
      ...row,
      flagged_at: flagged ? at : undefined,
      ...(unparked ? { parked_at: undefined, try_n: 0 } : {}),
    };
    this.opts.events.log({
      level: 'info',
      code: flagged ? 'SUBJECT_FLAGGED' : 'SUBJECT_UNFLAGGED',
      message: flagged
        ? unparked
          ? 'An app has been flagged for re-audit, releasing its park, and joins the backlog'
          : 'An app has been flagged for re-audit and joins the backlog'
        : 'An app is no longer flagged for re-audit',
      subject,
      detail: { subject, by, ...(flagged ? { flagged_at: at } : {}), ...(unparked ? { unparked: true } : {}) },
    });
    await this.persist();
    return true;
  }

  /**
   * Drop everything the loop remembers about one subject — its tries, its park, its flag.
   *
   * Called when its archive is deleted, and only then. A `state/schedule.json` row for a
   * subject that no longer exists is harmless (nothing enumerates it; the candidate set is
   * the registry's) but it is the kind of harmless leftover that makes a state file stop
   * being readable by a person, and the whole point of deleting a delisted app is that
   * nothing about it is left.
   *
   * Refuses while the subject holds the claim. A row deleted underneath a run in flight
   * would be re-created by `record.ts` when that run finished, so the delete would appear to
   * work and then quietly undo itself — a worse answer than saying no.
   */
  async forget(subject: string): Promise<boolean> {
    if (this.subjects[subject]?.claim) return false;
    if (!(subject in this.subjects)) return false;
    delete this.subjects[subject];
    await this.persist();
    return true;
  }

  /**
   * The five constants of `Pick next target` as they stand now — the config file's, with any
   * runtime override laid over the top.
   *
   * Every read inside the scheduler goes through this rather than `opts.constants`, so a
   * changed cooldown applies to the countdown a page is already showing and to the next
   * decision, not only to the next boot.
   */
  get constants(): SchedulerConstants {
    return { ...this.opts.constants, ...this.constantsOverride };
  }

  /** What `config.yaml` asked for, which is what a fresh boot falls back to. */
  get constantsDefault(): SchedulerConstants {
    return { ...this.opts.constants };
  }

  /**
   * Change one or more of them at runtime — `domain/controls.ts`.
   *
   * Nothing else to do: every one of the five is read afresh out of `this.constants` on each
   * tick, so the next decision is made on the new number. `tick_min` is not among them —
   * it is not a policy constant but the timer's own period, and it has `setTickMinutes`.
   */
  setConstants(patch: Partial<SchedulerConstants>): void {
    this.constantsOverride = { ...this.constantsOverride, ...patch };
  }

  /** Forget a runtime override, back to the config file's value. */
  clearConstant(key: keyof SchedulerConstants): void {
    if (!(key in this.constantsOverride)) return;
    const next = { ...this.constantsOverride };
    delete next[key];
    this.constantsOverride = next;
  }

  /** How often the loop decides, in minutes. 0 before `start()`. */
  get tickMinutes(): number {
    return (this.tickMs ?? 0) / 60_000;
  }

  /**
   * Change the cadence while it is running.
   *
   * The only control with machinery behind it: `setInterval` fires at the period it was
   * created with, so a new `tick_min` that merely updated a number would take effect at the
   * next restart while the page said otherwise. Before `start()` — a control restored at
   * boot — remembering the interval is enough, because `start()` is called with it.
   */
  setTickMinutes(minutes: number): void {
    const ms = minutes * 60_000;
    if (this.tickMs === ms) return;
    if (this.timer) {
      this.stop();
      this.start(ms);
    } else {
      this.tickMs = ms;
    }
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
        cooldown_min: this.constants.cooldown_min,
        lastFinishedAt: this.lastFinishedAt(),
      }),
      // Named one by one rather than spread: `config.yaml`'s scheduler block carries
      // `armed` and `tick_min` too, and a spread would ship the switch inside the block of
      // numbers describing the cadence.
      constants: {
        tick_min: (this.tickMs ?? 0) / 60_000,
        fresh_days: this.constants.fresh_days,
        stuck_days: this.constants.stuck_days,
        lease_min: this.constants.lease_min,
        cooldown_min: this.constants.cooldown_min,
        max_tries: this.constants.max_tries,
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
  /**
   * Every subject key the loop knows about — the registry's list.
   *
   * Exposed so the routes can resolve what somebody typed against the same set the scheduler
   * would pick from, rather than against the archive alone: an app that has never been audited
   * is in the registry and in no report, and it is exactly the one a person asks for by hand.
   */
  knownSubjects(): string[] {
    return this.opts.registry.list();
  }

  async previewQueue(now = new Date()): Promise<QueueRow[]> {
    return queue(await this.buildInput({ now }));
  }

  /**
   * What somebody asked for, oldest ask first. Same world-read as the pick, so position 1 is
   * genuinely what the next unblocked tick takes.
   */
  async previewRequests(now = new Date()): Promise<RequestRow[]> {
    return requests(await this.buildInput({ now }));
  }



  private async standardMovedAt(): Promise<string | undefined> {
    if (!this.opts.standardMovedAt) return undefined;
    try {
      return await this.opts.standardMovedAt();
    } catch (err) {
      this.opts.events.log({
        level: 'warn',
        code: 'STANDARD_UNREADABLE',
        message: 'The standard in force could not be read; scheduling by freshness alone',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
      return undefined;
    }
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
   * The version each subject's last **attempt** was judged against.
   *
   * The sibling of `lastAttemptAt`, and it reads the same record for the same reason: a run
   * that blocked still looked at that version of the app, and must settle the question.
   * Absent for every assay written before 2026-08-25, which reads as unknown, never changed.
   */
  private auditedVersion(subjects: string[]): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const subject of subjects) {
      let newest: string | undefined;
      let at = '';
      for (const section of this.opts.index.sections()) {
        const rec = this.opts.index.latestAny(subject, section);
        if (!rec) continue;
        const stamp = String(rec.meta.finished_at || rec.meta.started_at || '');
        if (stamp <= at) continue;
        at = stamp;
        // Same coercion as `subjectVersionOf` and for the same reason: an all-digit sha comes
        // back from YAML as a number, and reading it as absent would say "unknown" about an
        // app that changed.
        const raw = rec.meta.subject_sha;
        newest = raw === undefined || raw === null || raw === '' ? undefined : String(raw);
      }
      out[subject] = newest;
    }
    return out;
  }

  /**
   * A dispatcher that threw instead of reporting back.
   *
   * The claim is this object's to settle, so settling it cannot be left to the dispatcher's
   * good behaviour. Until this existed the throw reached a `console.error` and nothing else:
   * the claim stayed open, every tick for a full `lease_min` said "audit already in
   * progress", the reclaim burned a try, and three of those parked an app for `stuck_days`
   * over six hours — with no event, no alert and no row on any page saying why the loop had
   * stopped. A report the volume would not let us write did exactly that on 2026-08-26, to
   * four apps in a row, and read from the outside as "idle".
   *
   * Recorded as an `error`, not `blocked`, and the difference is the one that matters here.
   * `blocked` keeps the try and does not stamp the finish, so the subject stays the stalest
   * row and is re-picked on the next tick — a fault that persists would then re-run a
   * half-hour audit for ever and the rest of the backlog would never be reached. `error`
   * stamps the finish and burns a try, which is what `record.ts` already describes as this
   * case ("the attempt failed ... the run died") and what E7 asks for: a reliably failing app
   * must not starve the others. Three fast tries park it, the loop moves on, and the event
   * says what happened.
   */
  private dispatchFailed(subject: SubjectKey, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    this.opts.events.log({
      level: 'error',
      code: 'ASSAY_FAILED',
      message: 'An audit failed to produce a report',
      subject,
      detail: {
        subject,
        error: 'dispatch-failed',
        raw: err instanceof Error ? (err.stack ?? reason) : reason,
      },
    });
    // Charging a try implies writing an attempt record — invariant 14 — and this path charges
    // one below. Without the record `lastAttemptAt` never moves, so the subject's re-audit
    // request is never spent: it walks toward a park while sitting at the head of the queue,
    // and everything behind it waits on a run that already failed.
    //
    // Ordered before the charge and awaited inside the chain, so a subject cannot be charged
    // by a `record()` that landed while the record it implies was still being written.
    void Promise.resolve(this.opts.recordFailedDispatch?.(subject, 'dispatch_failed'))
      .catch((e) => console.error('could not record a failed dispatch attempt', e))
      .then(() =>
        // Nothing above this can be allowed to leave the claim held, so the record is a promise
        // whose own failure is logged rather than thrown into a place with no handler.
        this.record(subject, { kind: 'error', reason: `dispatch failed: ${reason}` }),
      ).catch(
      (e) => {
        console.error('could not record a failed dispatch', e);
      },
    );
  }

  /**
   * Newest assay of **any status** per subject — a blocked or errored attempt counts.
   *
   * The sibling of `lastDoneAt`, and it exists because the two answer different questions.
   * Freshness and backlog order want the last *result*; "have we pointed the current standard
   * at this app" wants the last *look*, and a run that blocked every section still looked.
   * Without that distinction a permanently blocked section would keep a subject eligible for
   * ever — see `standardMoved` in `policy.ts`.
   *
   * **`started_at`, not `finished_at`** — the moment the run picked the rubric up is the
   * moment that decides which revision judged it, and a half-hour audit can straddle an
   * edit. `yundera~Terminal` did: it started at 12:04:11 on 2026-08-24, both rubrics were
   * rewritten at 12:12:25, and it finished at 12:12:57. Reading the finish made the
   * scheduler say we had looked at it under the new standard when its own assays record the
   * old shas, so the Store page showed an `older standard` chip on a row the backlog called
   * `fresh` and nothing would re-audit it until `fresh_days` ran out. Comparing the start
   * also errs the safe way: the worst a run that straddled an edit can now do is be audited
   * once more under the standard that is actually in force.
   */
  private lastAttemptAt(subjects: string[]): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const subject of subjects) {
      let newest: string | undefined;
      for (const section of this.opts.index.sections()) {
        const rec = this.opts.index.latestAny(subject, section);
        // `finished_at` is the fallback, for an assay written before `started_at` was
        // recorded; a blocked one may carry no finish time at all.
        const at = rec ? String(rec.meta.started_at || rec.meta.finished_at || '') : '';
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
  async tick(opts: { now?: Date } = {}): Promise<TickDecision> {
    // A coalesced call gets a decision it must not read as its own. `lastTick` is written at
    // the *end* of `runTick`, so what comes back here is the decision *before* the one in
    // flight — and a caller that treated it as an answer about its own request would report a
    // run that was never considered. Hence `coalesced`, and hence `POST /assays` answering
    // from the claim it can see rather than from what a tick returned.
    if (this.running) {
      return {
        ...(this.lastTick?.decision ?? { action: 'idle', reason: 'a tick is already running', backlog: 0, reclaimed: [], unparked: [] }),
        coalesced: true,
      };
    }
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
  private async buildInput(opts: { now: Date }): Promise<PolicyInput> {
    const subjects = this.opts.registry.list();
    const leasable = this.opts.prober?.leasable() ?? [];
    const benchAvailable = this.opts.prober ? leasable.length > 0 : true;
    return {
      now: opts.now,
      constants: this.constants,
      subjects,
      lastDoneAt: this.lastDoneAt(subjects),
      lastAttemptAt: this.lastAttemptAt(subjects),
      // A protocol directory that cannot be read must not stop a tick: the standard clause
      // goes quiet and every other rule decides exactly as it did before it existed.
      standardMovedAt: await this.standardMovedAt(),
      ...(this.opts.subjectVersions
        ? { currentVersion: this.opts.subjectVersions(), auditedVersion: this.auditedVersion(subjects) }
        : {}),
      schedule: this.subjects,
      lastFinishedAt: this.lastFinishedAt(),
      agentBusy: this.opts.agentBusy?.() ?? false,
      ...(this.opts.trials
        ? {
            queuedTrials: this.opts.trials.queued(),
            ...(this.opts.trials.running() ? { runningTrial: this.opts.trials.running()! } : {}),
          }
        : {}),
      benchAvailable,
      benchNote: benchAvailable ? undefined : this.benchNote(),
    };
  }

  private async runTick(opts: { now?: Date }): Promise<TickDecision> {
    const now = opts.now ?? new Date();
    const decision = decide(await this.buildInput({ now }));

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

    // ── the bench gate, as two transitions ───────────────────────────────────────────────
    // On 2026-08-23 a dead pool put nineteen identical `TICK_BENCH_GATED` rows into the log
    // between 12:00 and 13:22 — the "one row per thing" that alerts exist to end, and the rule
    // `bench.ts` already states for its own probe: "a bench that has been down for two days is
    // one alert and one event, not one event every five minutes". The standing condition lives
    // in the `bench.unreachable` alert; the log's job is to say when it started and when it
    // lifted. Demoting the repeat to `debug` would not have done it — `GET /events` does not
    // filter debug and the Activity page opens at `all`, so the rows would still be there.
    //
    // The *ungate* had no row at all before, and that was the sharper gap: on the same day the
    // pool recovered at 13:23:01 and nothing said so, because the alert stayed open on a second
    // bench that was still broken and its resolution therefore never fired either.
    //
    // Both tested on the gate condition rather than on `reason`, which `benchNote()` rewrites
    // every tick as the countdown ticks down — string equality would never match.
    const gatedNow = benchGated(decision);
    const gatedBefore = benchGated(this.lastTick?.decision);
    if (gatedNow && !gatedBefore) {
      this.opts.events.log({
        level: 'warn',
        code: 'TICK_BENCH_GATED',
        message: 'The tick found no demo bench worth claiming, so nothing was audited',
        detail: { reason: decision.reason, backlog: decision.backlog },
      });
    } else if (!gatedNow && gatedBefore) {
      this.opts.events.log({
        level: 'info',
        code: 'TICK_BENCH_UNGATED',
        message: 'A demo bench is claimable again, so sections that need one can run',
        detail: { reason: decision.reason, backlog: decision.backlog },
      });
    }

    // Requested work runs whether or not the loop is armed, and that is what `armed` has
    // meant in practice since long before there was a queue: `POST /assays` never consulted
    // it. The switch stops the loop helping itself — it is not a lock on the agent, and an
    // operator who disarms mid-incident and then presses Audit is asking for that one audit.
    // The Automation page has to say so out loud, because "stopped" over a draining queue is
    // the kind of half-truth that sends somebody looking for a bug in the scheduler.
    const mayDispatch = this.armed || decision.source === 'requested';

    if (decision.action === 'trial' && decision.trial) {
      const slug = decision.trial;
      const queued = this.opts.trials?.queued().find((t) => t.slug === slug);
      this.opts.events.log({
        level: 'info',
        code: 'TICK_TRIAL_SELECTED',
        message: mayDispatch
          ? 'The scheduler took the next trial off the queue'
          : 'The scheduler would have started a trial, but it is not armed',
        detail: { slug, reason: decision.reason, backlog: decision.backlog, dry_run: !mayDispatch },
      });
      if (mayDispatch) {
        // No claim, and none is wanted: a trial has no schedule row and must not acquire one.
        // What stops a second dispatch is `agentBusy` — the runner's own flag, which the next
        // tick reads — rather than anything written here.
        void Promise.resolve(this.opts.trials?.dispatch(slug)).catch((err) =>
          this.trialDispatchFailed(slug, queued?.subject ?? slug, err),
        );
      }
    } else if (decision.action === 'audit' && decision.subject) {
      this.opts.events.log({
        level: 'info',
        code: 'TICK_SELECTED',
        message: mayDispatch
          ? 'The scheduler picked the next app to audit'
          : 'The scheduler would have picked an app, but it is not armed',
        subject: decision.subject,
        detail: {
          subject: decision.subject,
          reason: decision.reason,
          backlog: decision.backlog,
          try_n: decision.try_n ?? 1,
          dry_run: !mayDispatch,
        },
      });

      if (mayDispatch) {
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
        // Cast, not convert. The registry's contract is that it hands out keys and `load()`
        // migrates any bare key off disk, so anything reaching here is already one — and
        // re-normalising would quietly hide a violation of that contract rather than surface it.
        void Promise.resolve(
          this.opts.dispatch?.({ subject: decision.subject as SubjectKey, try_n: claim.try_n }),
        ).catch((err) => this.dispatchFailed(decision.subject as SubjectKey, err));
      }
    } else if (benchGated(decision)) {
      // Logged above, as a transition rather than once per tick.
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

  /**
   * A trial dispatcher that threw.
   *
   * The subject equivalent above has a claim to release and a try to charge; this one has
   * neither, by design — a trial owns no schedule row. What it does have is a row of its own
   * that will otherwise sit in the queue for ever advertising work nobody is doing, so the
   * whole job here is to make sure the trial store hears about it. The port marks the row
   * failed; if it cannot, the log is the last word.
   */
  private trialDispatchFailed(slug: string, subject: string, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    this.opts.events.log({
      level: 'error',
      code: 'TRIAL_FAILED',
      message: 'A trial failed to start',
      detail: { slug, subject, reason },
    });
    void Promise.resolve(this.opts.trials?.failed?.(slug, reason)).catch((e) =>
      console.error('could not mark a trial failed', e),
    );
  }

  /**
   * Look again, soon, because the queue may have moved.
   *
   * Without this a request that arrives while something is running waits out `tick_min` —
   * an hour, by default — after the thing in front of it finished. With it the queue drains
   * at the speed of the work rather than the speed of the timer.
   *
   * **Only when an attempt was recorded**, which is the rule that keeps it from becoming a
   * spin loop. Four `blocked` reasons return in milliseconds without touching the agent
   * (`runner_disabled`, `runner_busy`, `store_unreachable`, `no_protocol`), and `agent_busy`
   * and `agent_auth` cost no try and write no record at all — so for every one of them the
   * *next* tick would decide exactly what this one decided, immediately, for ever. An armed
   * box with the runner switched off would rewrite `events.jsonl` past its trim in seconds.
   * An attempt record is the only proof the queue actually moved, which is invariant 14 read
   * forwards.
   */
  private kick(): void {
    const ms = this.opts.kickMs ?? 1_000;
    if (!ms) return;
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      void this.tick().catch((err) => console.error('scheduler kick failed', err));
    }, ms);
    this.kickTimer.unref?.();
  }

  /** Apply a finished attempt — rows E1, E5–E7. */
  async record(subject: string, outcome: Outcome, now = new Date()): Promise<void> {
    const result = recordResult({
      now,
      constants: this.constants,
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
          until_days: this.constants.stuck_days,
        },
      });
    }
    await this.persist();
    // `verdict` and `error` are exactly the two outcomes that wrote an attempt record, and so
    // exactly the two that can have moved the queue on. See `kick()`.
    if (outcome.kind === 'verdict' || outcome.kind === 'error') this.kick();
  }

  /** Arm the timer. With no argument it runs at whatever cadence the object already holds. */
  start(intervalMs?: number): void {
    const ms = intervalMs ?? this.tickMs;
    if (!ms) return;
    this.tickMs = ms;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error('scheduler tick failed', err));
    }, ms);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = undefined;
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
