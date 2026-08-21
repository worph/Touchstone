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
export interface SubjectSchedule {
  /** Consecutive errored attempts. Reset to 0 by any completion that is not an error. */
  try_n: number;
  /** Set when `try_n` reached `max_tries`. Released after `stuck_days`. */
  parked_at?: string;
  /** The open claim, if this subject holds one. */
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


export interface Reclaim {
  subject: string;
  /** `parked` when the reclaim exhausted the last try, `retry` when tries remain. */
  outcome: 'retry' | 'parked';
  try_n: number;
}

export interface TickDecision {
  action: 'audit' | 'idle';
  subject?: string;
  /** One clause, in n8n's wording, so the two systems' State lines compare by eye. */
  reason: string;
  /** How many subjects are stale or never run — the roll-up's Backlog figure. */
  backlog: number;
  /** Leases that had expired and were released this tick. */
  reclaimed: Reclaim[];
  /** Subjects whose park expired this tick and are eligible again. */
  unparked: string[];
  /** The try this attempt would be, when `action` is `audit`. */
  try_n?: number;
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
 * | `due` | last result is older than `fresh_days` |
 * | `fresh` | audited recently enough to be skipped |
 * | `parked` | too many consecutive errors; left alone until `stuck_days` pass |
 */
export type QueueState = 'running' | 'retry' | 'never' | 'due' | 'fresh' | 'parked';

export interface QueueRow {
  subject: string;
  state: QueueState;
  /** Where in the backlog this sits, 1-based. Absent when the subject is not eligible. */
  position?: number;
  /** Newest completed assay, any section. */
  last_done_at?: string;
  /** Days since `last_done_at`; absent when never run, rather than a fake infinity. */
  days?: number;
  try_n: number;
  parked_at?: string;
  claim_since?: string;
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
  constants: ScheduleConstants;
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
