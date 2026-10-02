/**
 * The automated-mode surface: what the driver holds, and what it is about to do.
 *
 * `GET /schedule` answered a shadow-mode question first — "what would you pick right now,
 * and why" — and its shape is still that answer plus the two things a page needs on top: the
 * order the backlog would be worked in, and whether the loop is allowed to work it.
 */

/**
 * Per-subject scheduling state — the part of n8n's wiki row that is *policy* rather than
 * verdict.
 *
 * The verdict, tier and risk live in the assay's own frontmatter (principle 3) and are read
 * from the archive. What is left is the bookkeeping n8n encodes in the row's prose: how many
 * consecutive attempts errored, whether the subject is parked, and who holds the claim.
 * Keeping it here rather than in `AssayMeta` is the deliberate divergence from the matrix
 * note on row B6: a try counter is not a property of an assay, it is a property of the
 * scheduler's opinion about a subject.
 */
/**
 * **A line** — one platform's worth of work, and the unit the scheduler actually dispatches.
 *
 * A line is named by the bench capability its sections lease from (`bench`, `bench.foss`);
 * a section that needs no bench belongs to the default line. That grouping is not arbitrary
 * and it is not "one line per section":
 *
 * - **A run is one line's scope**, so `try_n`, `parked_at` and `claim` — which are all facts
 *   about *an attempt that was dispatched* — are per line by construction.
 * - **A section belongs to exactly one line**, because the run's combined `risk_score` lands
 *   on its primary section and the hallmark sums across sections. A section appearing in two
 *   lines' runs would have the second run's score overwrite the first's, and the store's risk
 *   column would quietly lose a platform's findings.
 * - `static` therefore stays on the default line with `functional`, which is also what keeps
 *   today's run shape: one agent call for both, no throughput regression.
 *
 * With one pool configured there is exactly one line, every map below has one key, and the
 * behaviour is what it has always been.
 */
import { DEFAULT_TARGET } from './target.js';

export type LineKey = string;

/** One line's policy state — the half of a v1 `SubjectSchedule` that was about attempts. */
export interface LineSchedule {
  /** Consecutive errored attempts. Reset to 0 by any completion that is not an error. */
  try_n: number;
  /** Set when `try_n` reached `max_tries`. Released after `stuck_days`. */
  parked_at?: string;
  /** The open claim, if this line holds one. */
  claim?: { since: string; try_n: number };
  /**
   * This row was read off n8n's roll-up rather than recorded by us — see `adopt.ts`.
   *
   * It is what lets a later import correct an earlier one. Without the marker, the first
   * adoption counts as "state we hold" and blocks every subsequent adoption, so a subject
   * adopted as `try 2` from a stale page could never be updated to `stuck`. Found by
   * running it: one park adopted where the roll-up listed a dozen.
   */
  from_rollup?: true;
}

export interface SubjectSchedule {
  /** Per line. Absent for a line means nothing has been attempted on that platform yet. */
  lines?: Record<LineKey, LineSchedule>;
  /**
   * A row written before lines existed, not yet fanned out.
   *
   * It is the belt to the migration's braces. `Scheduler.load()` fans a v1 row onto every
   * line it knows about — but it can only know them by reading `data/protocols/`, and the
   * scheduler has always had to boot with that directory unreadable. When it cannot, the v1
   * body is kept here and every missing line falls back to it, so a parked subject stays
   * parked. Absence must never be the thing that unparks an app: on disk "no state" and
   * "state that predates lines" are identical, and they mean opposite things.
   *
   * Dropped on the first write in which every known line has its own entry.
   */
  legacy?: LineSchedule;
  /**
   * When somebody asked for this subject to be looked at again — the re-audit flag.
   *
   * A timestamp rather than a boolean, because it is *consumed by comparison*: the subject is
   * flagged for as long as its last attempt is older than this, so the next look clears it
   * with no second write to go wrong. A boolean would need somebody to unset it, and the
   * somebody is a run that may die halfway.
   *
   * It exists because a section can block for ever without the subject ever becoming
   * eligible again: `blocked` stamps no finish and burns no try (invariant 3), while a
   * *sibling* section that completed keeps the whole subject fresh for `fresh_days`. The
   * automatic clauses cannot cover that — a rule that made a blocked section eligible would
   * re-pick the same app every cooldown until the bench came back and starve the rest — so
   * the escape hatch is a person saying so.
   */
  flagged_at?: string;
}

/**
 * A `state/schedule.json` row as it was written before lines existed.
 *
 * Read by the migration and by nothing else. Kept as a type rather than as `unknown` so the
 * fan-out is checked by the compiler: this is the one place where mistaking "absent" for "no
 * state" silently unparks every parked app.
 */
export interface LegacySubjectSchedule {
  try_n?: number;
  parked_at?: string;
  claim?: { since: string; try_n: number };
  flagged_at?: string;
  from_rollup?: true;
  lines?: Record<LineKey, LineSchedule>;
  legacy?: LineSchedule;
}


export interface Reclaim {
  subject: string;
  /** Which line's claim was released. One subject may hold one per platform. */
  line: LineKey;
  /** `parked` when the reclaim exhausted the last try, `retry` when tries remain. */
  outcome: 'retry' | 'parked';
  try_n: number;
}

/**
 * One run a tick started. A tick now starts as many as there are free (bench, browser) pairs,
 * one per request or backlog cell, in queue order.
 */
export interface Dispatch {
  action: 'audit' | 'trial';
  /** The subject key, for an audit. */
  subject?: string;
  /** The trial slug, for a trial. */
  trial?: string;
  /** The platform this run is on, and therefore which pool its bench comes from. */
  line: LineKey;
  /** The scope, for an audit — the scheduler's answer, never a caller's. */
  sections?: string[];
  source: 'requested' | 'backlog';
  reason: string;
  /** The try this attempt would be, for an audit. */
  try_n?: number;
}

/**
 * Why one line did not start (more) work this tick.
 *
 * `full` and `gated` are the distinction the whole lease design exists to keep: a pool whose
 * benches are all busy auditing is working, a pool with no healthy bench is broken, and an
 * Automation page that rendered them alike would send somebody to fix a pool that is fine.
 */
export interface LineHold {
  line: LineKey;
  why: 'gated' | 'full' | 'cooldown';
  reason: string;
  /** The request at the head of this line, when one is waiting. */
  waiting_on?: string;
}

export interface TickDecision {
  /**
   * What the tick decided to do.
   *
   * `trial` joined `audit` and `idle` on 2026-09-01, when the request queue landed: a trial
   * and an audit are two things one agent can be asked for, and the decision about which one
   * happens next has to name both or it is not the decision.
   */
  action: 'audit' | 'trial' | 'idle';
  subject?: string;
  /** The trial slug, when `action` is `trial`. */
  trial?: string;
  /**
   * Whether this came out of the request queue or out of the derived backlog.
   *
   * Load-bearing, not decoration: `armed` gates the backlog and nothing else, so `runTick`
   * reads this to decide whether a disarmed scheduler may still dispatch. A request is
   * somebody asking; the backlog is the loop helping itself.
   */
  source?: 'requested' | 'backlog';
  /**
   * What the queue is waiting on, when something is requested and the tick idled anyway.
   *
   * The head of the queue and the reason it is not moving. Without it "waiting" and "empty"
   * render identically, which is the one thing a queue view must never do.
   */
  waiting_on?: string;
  /** One clause, in n8n's wording, so the two systems' State lines compare by eye. */
  reason: string;
  /** How many subjects are stale or never run — the roll-up's Backlog figure. */
  backlog: number;
  /**
   * Which line this tick's audit is on, and the sections that makes its scope.
   *
   * The scope is the scheduler's answer, never a caller's — see `scopeOf`. Absent when the
   * tick did not dispatch an audit.
   */
  line?: LineKey;
  sections?: string[];
  /**
   * Lines held by the bench gate right now, whatever this tick did.
   *
   * Present even on a tick that dispatched, and that is the point: with two pools the FOSS
   * line can be down while the Yundera line audits happily, and `action` would then be
   * `audit`. Reading the gate off `action === 'idle'` — which is what `benchGated()` did —
   * would make a dead second pool completely silent.
   */
  gated?: LineKey[];
  /** Leases that had expired and were released this tick. */
  reclaimed: Reclaim[];
  /** Cells whose park expired this tick and are eligible again. */
  unparked: { subject: string; line: LineKey }[];
  /**
   * How many subjects are being held out of the backlog by a park right now.
   *
   * The standing population, not `unparked`'s transition set. `backlog` counts what is
   * eligible and says nothing about what was skipped, which is how an empty backlog came to
   * be reported as "all 73 app(s) audited within 14d" over an app that had been parked for
   * three days and never audited at all.
   */
  parked?: number;
  /** The try this attempt would be, when `action` is `audit`. */
  try_n?: number;
  /**
   * **Every** run this tick started, in queue order — the top-level fields above describe the
   * first of them. Absent on a scheduler with no lease registry, which is single-flight and
   * starts at most the one the top-level fields name.
   */
  dispatches?: Dispatch[];
  /** Lines that started nothing (more) this tick, and why. Absent when none was held. */
  held?: LineHold[];
  /**
   * This is the *previous* tick's decision, handed back because a tick was already running.
   *
   * Two ticks racing could both claim, so `tick()` coalesces — but `lastTick` is written only
   * at the end of a tick, so what a coalesced caller receives describes work it had no part
   * in. Marked rather than hidden: a caller asking "did my request start" must be able to
   * tell "no" from "I cannot say".
   */
  coalesced?: true;
}

/**
 * Why a subject is or is not next.
 *
 * Deliberately one closed set rather than a free-text status: the page groups by it, and a
 * label the page invents is a state nobody can act on.
 *
 * | state | meaning |
 * | --- | --- |
 * | `running` | this subject holds the claim — the reason nothing else starts |
 * | `retry` | a previous attempt errored; retried on the next tick, no freshness wait |
 * | `never` | no completed assay on file |
 * | `due` | last result is older than `fresh_days`, or the standard moved, or the app changed, or it was flagged |
 * | `fresh` | audited recently enough to be skipped |
 * | `parked` | too many consecutive errors; left alone until `stuck_days` pass |
 */
export type QueueState = 'running' | 'retry' | 'never' | 'due' | 'fresh' | 'parked';

/** One subject's state on one platform. The row above summarises these. */
export interface QueueLineRow extends Omit<QueueRow, 'subject' | 'lines'> {
  line: LineKey;
}

export interface QueueRow {
  subject: string;
  state: QueueState;
  /**
   * Per platform, when there is more than one.
   *
   * The row itself stays the summary — one line per app, because 73 apps on two platforms is
   * 146 rows and a page that lists each app twice answers "when does mine run" worse than one
   * that does not. The fields above are the most actionable cell's, except `flagged`,
   * `position` and `last_done_at`, where "any" and "newest" are the honest answers.
   */
  lines?: QueueLineRow[];
  /** Where in the backlog this sits, 1-based. Absent when the subject is not eligible. */
  position?: number;
  /** Newest completed assay, any section. */
  last_done_at?: string;
  /** Days since `last_done_at`; absent when never run, rather than a fake infinity. */
  days?: number;
  /**
   * Due because the standard moved under it rather than because a week passed.
   *
   * Not a `QueueState` of its own: the row *is* `due`, and the only extra thing to say is
   * what made it due. A seventh state word would have to be handled by every reader of this
   * type to say something the note says better.
   */
  standard_moved?: boolean;
  /**
   * Due because the app's compose changed in the store since it was last looked at.
   *
   * Independent of `standard_moved` — a row can carry both, and they mean different things:
   * the question changed, or the subject did.
   */
  subject_changed?: boolean;
  /**
   * Due because an operator flagged it for re-audit rather than because anything about the
   * world changed.
   *
   * The third qualifier alongside the two above and read the same way — the row *is* `due`,
   * and this says what made it due. It is also the only one of the three a person can clear
   * from the page, which is why it survives to the wire rather than being folded into a note
   * on the server.
   */
  flagged?: boolean;
  try_n: number;
  parked_at?: string;
  claim_since?: string;
}

/**
 * One thing somebody asked for, in the order they asked for it.
 *
 * The request queue is **derived**, not stored: an audit request is a subject whose
 * `flagged_at` is newer than its last attempt, and a trial request is a trial row that has
 * not been picked up yet. Nothing writes this list; it is composed per request from the two
 * places the answers already live, which is what keeps invariant 8 true of the half of it
 * that can be derived at all.
 *
 * The two kinds share one ordering key — when it was asked for — because they share one
 * agent. A queue that ordered them separately would be two queues wearing one heading.
 */
export interface RequestRow {
  kind: 'audit' | 'trial';
  /** The subject key for an audit, the slug for a trial — the address, not the label. */
  id: string;
  /** What to show a person: the bare app name. */
  label: string;
  /** The ordering key. `flagged_at` for an audit, the trial row's creation time. */
  requested_at: string;
  /** 1-based, arrival order. Position 1 is what the next unblocked tick takes. */
  position: number;
  state: 'waiting' | 'running';
  /**
   * The platforms this request has still to be served on, when there is more than one.
   *
   * One press asks for every line, and each line spends it on its own run — so a request
   * whose Yundera audit has completed while the FOSS line waits for its bench is still a
   * request, and a row that vanished at the first answer would be lying about that.
   */
  lines?: LineKey[];
  /**
   * Why this is not moving. Only ever set on the head, because only the head is blocked —
   * everything behind it is merely behind it, and saying "waiting for a bench" on all five
   * rows would suggest five problems.
   */
  waiting_on?: string;
}

/** The knobs, echoed so the page can explain a countdown without hardcoding the defaults. */
export interface ScheduleConstants {
  tick_min: number;
  fresh_days: number;
  stuck_days: number;
  lease_min: number;
  cooldown_min: number;
  max_tries: number;
}

export interface ScheduleResponse {
  /**
   * `null` when there is no scheduler at all. "Disarmed" and "not wired up" look identical
   * on a page that flattens them, and only one of the two is worth a button.
   */
  armed: boolean | null;
  /** What `config.yaml` says, which is what a fresh boot falls back to. */
  armed_default: boolean | null;
  /** Whether the live value came from the config file or from someone pressing the button. */
  armed_source: 'config' | 'override';
  /**
   * The second switch. An armed scheduler with a disabled runner claims a subject and is
   * told the runner is off — a real state, and one the page has to name before someone
   * presses start and watches nothing happen.
   */
  runner_enabled: boolean | null;
  last_tick: { at: string; state: string; decision: TickDecision } | null;
  /** When the timer is next due. Derived from the last tick, so it is honest after a restart. */
  next_tick_at: string | null;
  last_finished_at: string | null;
  /** Minutes of cooldown left before another audit may start. 0 when clear. */
  cooldown_left_min: number;
  /**
   * The same, per platform. Each line has its own cooldown since 2026-10 — a Yundera audit
   * finishing does not make the FOSS line wait. `cooldown_left_min` above is the smallest.
   */
  lines?: {
    line: LineKey;
    label: string;
    last_finished_at: string | null;
    cooldown_left_min: number;
    /** Benches of this platform nobody holds, of how many healthy ones. */
    benches?: { free: number; total: number };
  }[];
  /** Browser sidecars nobody holds, of how many healthy ones — shared by every line. */
  browsers?: { free: number; total: number };
  constants: ScheduleConstants;
  /**
   * What somebody asked for, oldest ask first — audits and trials in one line.
   *
   * Separate from `queue` below because they answer different questions. This is the work
   * the loop was *told* to do and drains whether or not the scheduler is armed; `queue` is
   * the rotation it works out for itself, which `armed` gates. Rendering them as one list is
   * how an operator comes to think a flag started something.
   */
  requests: RequestRow[];
  /** Every subject, backlog first in the order they would be worked. */
  queue: QueueRow[];
  subjects: Record<string, SubjectSchedule>;
  registry: {
    count: number;
    live: boolean;
    fetched_at: string | null;
    /**
     * One row per configured store.
     *
     * Present so a failure names the store it hit. With one store the page says nothing extra;
     * with two, "the registry is stale" is unactionable without knowing *which* registry.
     */
    origins?: {
      id: string;
      repo: string;
      ref: string;
      count: number;
      live: boolean;
      fetched_at?: string;
      error?: string;
    }[];
  };
}

/**
 * Which line a section belongs to: **its target**.
 *
 * A line *is* a platform. This used to sniff the section's capabilities for a `bench.` prefix
 * and take the first in sorted order — an arbitrary tie-break, which is what you write when
 * one string is a capability, a platform and a pool at once.
 *
 * A section with no target — `static`, and every scripted reading — belongs to the **default**
 * line, so it rides the run that platform's sections are already making rather than anchoring
 * one of its own. Its verdict does not depend on the platform, so it is audited once; auditing
 * it per target would write the same finding twice and double-count its risk.
 */
export function lineOf(section: { target?: string }): LineKey {
  return section.target ?? DEFAULT_TARGET;
}
