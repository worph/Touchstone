/**
 * The decision, as a pure function — the port of n8n's `Pick next target`.
 *
 * Everything that reads the world (the roll-up, GitHub, the bench pool) happens in
 * `Scheduler`; this file only decides. That split exists for one reason: **shadow mode**.
 * Phase 1 runs this alongside the live n8n loop and diffs its pick against n8n's own
 * `- **State:**` line over ~150 real ticks, and a decision that cannot be replayed from a
 * plain input object cannot be diffed.
 *
 * The order of the branches below is load-bearing:
 *
 *   busy → request (trial or audit, oldest ask first) → cooldown → backlog empty → stalest
 *
 * It was n8n's order — `busy → forced → cooldown → backlog empty → stalest` — for as long as
 * the shadow diff was the validation technique, and it is not any more. On 2026-09-01 the
 * `forced` slot became the **request queue**: `forced` was one name typed into a debug route
 * that bypassed freshness and cooldown, and a request is the same thing arrived at honestly,
 * from a button, with a place in a line. Parity is a record now rather than a gate
 * (architecture §1.4), so this is a deliberate departure and row A3 says so.
 *
 * Two things about that queue are load-bearing here. **A request bypasses the cooldown** on
 * the single-flight path, so pressing Audit on an idle box starts an audit rather than
 * explaining that it will in fifty-five minutes. And **a request is not gated by `armed`** —
 * that switch stops the loop helping itself, not an operator asking — which is why the
 * decision carries a `source`.
 *
 * **On the concurrent path (production) the order is requirements §26**: everything a person
 * asked for — audits, trials, operator workshop proposals and their validation — first in,
 * first out; then the background by tier — app changed or never audited, retries, the
 * workshop's own work, stale, and last the apps only the standard moved under, as filler.
 * There is no cooldown there: each *bench* rests between any two jobs (`services/leases.ts`),
 * which reaches this file as `free.resting`.
 *
 * The bench gate is deliberately **after** that chain rather than woven into it, so the gate
 * is visibly a separate decision rather than a clause inside the pick. A request that cannot
 * run holds the head of the line and says why, which is the whole reason `waiting_on`
 * exists: "the queue is empty" and "the queue cannot move" must never render alike.
 */

import type { Leg } from '../../shared/types.js';
import { DEFAULT_TARGET } from '../../shared/target.js';
import type {
  Dispatch,
  LineHold,
  LineKey,
  LineSchedule,
  QueueRow,
  QueueState,
  QueueTier,
  Reclaim,
  RequestRow,
  SubjectSchedule,
  TickDecision,
} from '../../shared/schedule.js';

/**
 * **One unit of scheduling** — a subject on one platform.
 *
 * The pick, the backlog, the parks and the try counters are all about a cell rather than a
 * subject, because a run is one line's scope: auditing FileBrowser on Yundera says nothing
 * about whether it has been audited on the FOSS stack, and a failure on one must not park
 * the other. With one pool configured every subject has exactly one cell and this is the
 * subject-grained scheduler it has always been.
 */
export interface Cell {
  subject: string;
  line: LineKey;
}

/**
 * A cell as a `Set`/`Map` key.
 *
 * `\u0000` because a subject key is `<origin>~<name>` and a line is a capability string —
 * both may contain almost anything a person types into `config.yaml`, and a separator that
 * can appear in either would collide two cells into one and silently merge their state.
 */
export function cellKey(subject: string, line: LineKey): string {
  return `${subject}\u0000${line}`;
}

export interface SchedulerConstants {
  fresh_days: number;
  stuck_days: number;
  lease_min: number;
  cooldown_min: number;
  max_tries: number;
}

export interface PolicyInput {
  now: Date;
  constants: SchedulerConstants;
  /** The registry, in the order the roll-up renders it. */
  subjects: string[];
  /**
   * The sections the protocol declares now, and the line each belongs to.
   *
   * The second axis of the pick, and all of it the policy needs: it never reads a rubric, only
   * which platform a section is audited on and whether it scores. A section that measures
   * (`scores: false`) may **ride** a run but never anchor one — invariant 12's third clause at
   * this grain, and without it `currency`, which is due constantly and takes six seconds,
   * would anchor a run per subject per window and starve everything else.
   */
  sections: { id: string; line: LineKey; scores: boolean }[];
  /**
   * Latest *completed* assay per subject **per line**, ISO. Blocked and running runs are not
   * completions.
   *
   * Per line rather than per section, deliberately. Per section would be the finer answer and
   * would fix a known wart — a completed `static` makes a blocked `functional` read fresh —
   * but it would also make every subject permanently due during a browser outage and spend
   * the whole rotation re-running `static`. That wart has a remedy already (the request), and
   * changing eligibility semantics is not what this change is for.
   */
  lastDoneAt: Record<string, Record<LineKey, string | undefined> | undefined>;
  schedule: Record<string, SubjectSchedule | undefined>;
  /** When any assay last finished, anywhere. The cooldown anchor. */
  lastFinishedAt?: string;
  /**
   * Whether the single agent is in somebody's hands right now — `Runner.busy`.
   *
   * Read separately from the claim-derived `busy` below it, and that is not redundancy: a
   * **trial** holds the agent while holding no claim at all, because a trial has no schedule
   * row and must never touch one (`routes/trials.ts`). Before this field existed the tick
   * could not see a running trial, so a tick kicked the moment an audit finished would
   * dispatch into a busy runner, get `blocked: runner_busy` back in two milliseconds, learn
   * nothing, and go round again for as long as the trial lasted.
   */
  agentBusy?: boolean;
  /**
   * Trials waiting for the agent, oldest ask first.
   *
   * The one part of the request queue that is genuinely *stored*, because a trial has no
   * subject row and no attempt record to spend a timestamp against. See invariant 8.
   */
  queuedTrials?: QueuedTrial[];
  /**
   * The trial holding the agent right now, if one is.
   *
   * Kept out of `queuedTrials` rather than flagged inside it, because `decide` takes that
   * list's head as the thing to dispatch and a running trial must never be dispatched twice.
   * It exists for `requests()` alone: a queue view that hides the item currently being worked
   * is a queue view that appears to have lost it.
   */
  runningTrial?: { slug: string; subject: string; queued_at: string };
  /** Every trial in flight, when several can be. Supersedes `runningTrial` where present. */
  runningTrials?: QueuedTrial[];
  /**
   * What the lease registry has free right now — `services/leases.ts`.
   *
   * **Present, the tick is concurrent**: it starts one run per free (bench, browser) pair,
   * walking the queue in order, and a line stops only when its own resources run out. Absent,
   * it is the single-flight scheduler it always was — any claim anywhere idles the tick — which
   * is what a rig with no lease registry must stay, because nothing would stop two runs from
   * taking the same bench.
   *
   * Counts rather than resources so this stays a pure function of a plain object. Browsers are
   * one number because they are one pool, spent across lines in queue order.
   */
  free?: {
    benches: Record<LineKey, number>;
    browsers: number;
    /** How many browsers are healthy at all. Zero is an outage (gate); free zero is busy (wait). */
    browsersHealthy: number;
    /**
     * Healthy benches out of `benches` only because they are in their transition gap, and
     * when the first comes back. Lets a hold say *resting* rather than *in use*.
     */
    resting?: Record<LineKey, { count: number; until?: string }>;
  };
  /**
   * `scheduler.armed`. Off, the backlog's audits are still decided — the tick logs them as a
   * dry run — but they take no pair and hold no line. Absent means armed, which is what every
   * caller that predates the field was deciding for.
   */
  armed?: boolean;
  /**
   * What a run on each line needs, from its sections' `requires:`. Absent for a line means both:
   * every line today carries `functional`, and assuming less would let a run start with no
   * browser to drive.
   */
  needs?: Record<LineKey, { bench: boolean; browser: boolean }>;
  /**
   * When each line last finished an audit — its own cooldown anchor. Falls back to
   * `lastFinishedAt` for a line with no entry, which is what a state file written before lines
   * had cooldowns of their own holds.
   */
  lastFinishedAtByLine?: Record<LineKey, string | undefined>;
  /**
   * When each line started being scheduled — `Scheduler`'s `line_since`. A request older than
   * its line counts only on lines that have looked at the app before; see `flaggedForReaudit`.
   * Absent for a line, every request counts there, which is what this field's absence meant
   * before it existed.
   */
  lineSince?: Record<LineKey, string | undefined>;
  /**
   * Newest assay of **any status** per subject, ISO — a blocked or errored attempt counts.
   *
   * Only the standard clause below reads this. `lastDoneAt` is the freshness and ordering
   * signal and stays what it always was; this one answers a different question — *have we
   * pointed the current standard at this app at all* — and a blocked attempt answers it yes.
   * See `domain/standards.ts` for why the two cannot be one field.
   */
  lastAttemptAt?: Record<string, Record<LineKey, string | undefined> | undefined>;
  /**
   * When the standard last moved — `StandardSnapshot.moved_at`.
   *
   * Absent means the question is not being asked (no revision history, or nothing recorded
   * yet), and the eligibility rule below is then a no-op.
   */
  standardMovedAt?: Record<LineKey, string | undefined>;
  /**
   * The version of each subject the store offers now — a git blob sha of its compose.
   *
   * Absent for a subject means the store offered none, and the rule below then does nothing
   * for it. That is the safe direction: "we do not know" must not read as "it changed".
   */
  currentVersion?: Record<string, string | undefined>;
  /**
   * The version each subject's last **attempt** recorded, from `AssayMeta.subject_sha`.
   *
   * The same last-attempt reasoning as `lastAttemptAt`: a run that blocked every section
   * still looked at that version, and must settle the question rather than leave the subject
   * eligible for ever.
   */
  auditedVersion?: Record<string, Record<LineKey, string | undefined> | undefined>;
  /**
   * Which bench capabilities can be claimed right now, and why not when they cannot.
   *
   * Replaces the single `benchAvailable` boolean, which had exactly one right answer while
   * there was one pool and no right answer once there were two: a FOSS outage would have
   * stopped either all auditing or none of it, depending which way the boolean fell.
   *
   * A capability nothing supplies is **available** here, matching `resolveCapabilities`'
   * property 4 — `requires: ['gpu']` runs. A bench capability no pool answers is caught by
   * the runner, which records `bench_unconfigured`, not by the gate: gating it would hold a
   * line for ever over a configuration answer that no wait can change.
   */
  capabilities: Record<string, { available: boolean; note?: string }>;
  /**
   * The workshop — the lowest line in the queue (docs/auto-app-pr.md §6.1).
   *
   * `slot` is what it would author next, chosen by `services/workshop.ts`; the policy only
   * decides **whether now**: never while anything somebody asked for is queued or running, and
   * for work it picked for itself (`idle`) also never while an audit is in flight or — when the
   * backlog is being worked at all — while any of it is due. It holds one (bench, browser) pair
   * on the default line, and only what this tick's other dispatches left over.
   */
  workshop?: {
    slot?: { id: string; label: string; class: 'operator' | 'idle'; asked_at: string };
    running?: { id: string; label: string; started_at: string };
  };
}

/**
 * A trial as the queue sees it.
 *
 * `background` and `asked_at` exist for the workshop's validation trials (requirements §26):
 * one validating a proposal the workshop picked for itself is the loop's own work, and one
 * validating an operator's proposal takes that proposal's place in the line rather than the
 * moment authoring finished. A trial a person started carries neither.
 */
export interface QueuedTrial {
  slug: string;
  subject: string;
  queued_at: string;
  target?: string;
  background?: boolean;
  asked_at?: string;
}

const DAY_MS = 86_400_000;

function daysSince(iso: string | undefined, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - t) / DAY_MS;
}

/**
 * Whether this subject has been looked at since the standard moved.
 *
 * The comparison is against the last **attempt**, not the last verdict, and the difference
 * is load-bearing: a section that is permanently blocked keeps its old `done` record for
 * ever, so a rule reading verdicts would find that subject eligible on every tick until
 * somebody fixed the bench — one app pinned in the backlog, re-audited every cooldown, for a
 * section it cannot run. Attempting settles it; the badge on the Store page goes on saying
 * `older`, because the verdict on display really was reached under an older revision.
 */
function standardMoved(input: PolicyInput, subject: string, line: LineKey): boolean {
  // Per line: editing `functional-foss.md` must re-eligible the FOSS line and leave the
  // Yundera rotation alone, or one platform's rubric edit spends three days of agent time
  // re-auditing the other.
  const movedAt = input.standardMovedAt?.[line];
  if (!movedAt) return false;
  const moved = Date.parse(movedAt);
  if (Number.isNaN(moved)) return false;
  const attempted = Date.parse(input.lastAttemptAt?.[subject]?.[line] ?? '');
  return Number.isNaN(attempted) || attempted < moved;
}

/**
 * Whether the app has changed since we last looked at it.
 *
 * Both sides must be present. A subject the store offers no compose for, and an assay written
 * before versions were recorded, are both **unknown** — and unknown is not a trigger. Without
 * that asymmetry every subject in the archive would become eligible the day this shipped and
 * stay eligible until audited, which is the same flood the `seed` rule avoids for rubrics.
 */
function subjectChanged(input: PolicyInput, subject: string, line: LineKey): boolean {
  // One compose, so `currentVersion` stays per subject; what is per line is *when each
  // platform last looked at it*. A compose change makes both lines eligible, and each spends
  // that eligibility on its own run.
  const now = input.currentVersion?.[subject];
  const then = input.auditedVersion?.[subject]?.[line];
  if (!now || !then) return false;
  return now !== then;
}

/**
 * Whether somebody has asked for this subject and we have not looked since.
 *
 * The third way past the freshness window, and the only one that is not about the world
 * changing: it is an operator saying "look at this one again". Read exactly as
 * `standardMoved` is read — against the last **attempt**, so the next look clears it whatever
 * that look concluded, and a subject cannot be pinned in the backlog by a flag nobody
 * remembers setting.
 *
 * That is also what makes it the right answer to a section that is permanently blocked: the
 * flag costs one audit, not one audit per cooldown for ever.
 */
export function isFlaggedForReaudit(
  flaggedAt: string | undefined,
  lastAttemptAt: string | undefined,
): boolean {
  if (!flaggedAt) return false;
  const flagged = Date.parse(flaggedAt);
  if (Number.isNaN(flagged)) return false;
  const attempted = Date.parse(lastAttemptAt ?? '');
  // `<`, and against the attempt's *start*: a flag set while a run was already in flight is
  // asking for the *next* look, not for the one that was halfway through when it was set.
  // That is also why nothing clears the field when a run finishes — a finisher cannot tell
  // whether the flag arrived before it started, and the comparison can.
  return Number.isNaN(attempted) || attempted < flagged;
}

function flaggedForReaudit(
  input: PolicyInput,
  subject: string,
  line: LineKey,
  row: SubjectSchedule | undefined,
): boolean {
  // The row comes from the caller rather than from `input.schedule`, because `plan()` works
  // on the copy `reclaimExpired` returned and that copy is the one the rest of the tick
  // agrees with.
  //
  // **One timestamp, compared per line.** That is the whole of the fan-out and it stores
  // nothing: one press counts for every line whose last attempt predates it, and each line
  // spends it on its own run. A per-line *request* would need a platform picker on every row,
  // which is `depth` wearing a new name — whether the FOSS bench is free is a fact about the
  // line, not a choice at the point of pressing.
  const attempted = input.lastAttemptAt?.[subject]?.[line];
  // **A request is for the platforms that existed when it was made.** A line with no attempt
  // has nothing to spend a flag against, so without this every request ever answered on
  // Yundera came back to life the moment a second platform started scoring — 32 of them on
  // 2026-10-02, each jumping the queue (and the cooldown) ahead of a trial asked for that
  // morning. Only when the line has never looked at this app: once it has, the attempt is the
  // comparison, as it always was.
  if (!attempted && row?.flagged_at) {
    const since = Date.parse(input.lineSince?.[line] ?? '');
    const flagged = Date.parse(row.flagged_at);
    if (!Number.isNaN(since) && !Number.isNaN(flagged) && flagged < since) return false;
  }
  return isFlaggedForReaudit(row?.flagged_at, attempted);
}

function minutesSince(iso: string | undefined, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - t) / 60_000;
}

/**
 * Release claims whose lease has expired, mutating a copy of the schedule.
 *
 * An audit that died mid-run must not hold its subject forever — n8n's `LEASE_MIN=120`. The
 * reclaim burns the try, because a run that vanished did consume an attempt; that is the
 * one difference from the agent-busy path, where nothing was attempted at all.
 */
function reclaimExpired(
  schedule: Record<string, SubjectSchedule | undefined>,
  input: PolicyInput,
): { schedule: Record<string, SubjectSchedule>; reclaimed: Reclaim[]; busy?: { subject: string; since: string } } {
  const out: Record<string, SubjectSchedule> = {};
  const reclaimed: Reclaim[] = [];
  let busy: { subject: string; since: string } | undefined;

  // **Deep enough to own every object it will mutate.** The copy used to be one spread plus
  // the claim, which was exactly deep enough while a row's mutable state was flat. It is not
  // any more: sharing the `lines` object would let this function's reclaim write straight
  // through into the caller's input, and `policy.test.ts`'s "does not mutate the schedule it
  // was handed" is the test that catches it.
  const copy = (row: SubjectSchedule): SubjectSchedule => ({
    ...row,
    ...(row.lines
      ? {
          lines: Object.fromEntries(
            Object.entries(row.lines).map(([line, cell]) => [
              line,
              { ...cell, claim: cell.claim ? { ...cell.claim } : undefined },
            ]),
          ),
        }
      : {}),
    ...(row.legacy ? { legacy: { ...row.legacy, claim: row.legacy.claim ? { ...row.legacy.claim } : undefined } } : {}),
  });

  for (const subject of input.subjects) {
    const row = schedule[subject];
    if (!row) continue;
    out[subject] = copy(row);
  }
  // A claim on a subject the registry no longer lists still has to be released, or it
  // holds single-flight shut forever.
  for (const [subject, row] of Object.entries(schedule)) {
    if (!out[subject] && row) out[subject] = copy(row);
  }

  for (const [subject, row] of Object.entries(out)) {
    // Every line, not only the ones the protocol still declares: a claim on a retired line
    // holds single-flight shut just as effectively as one on a live line.
    for (const [line, cell] of Object.entries(row.lines ?? {})) {
      if (!cell.claim) continue;
      if (minutesSince(cell.claim.since, input.now) < input.constants.lease_min) {
        // Still held. n8n reports the first one it meets; the ordering is the registry's.
        if (!busy) busy = { subject, since: cell.claim.since };
        continue;
      }
      const tryN = cell.claim.try_n;
      cell.claim = undefined;
      cell.try_n = tryN;
      if (tryN >= input.constants.max_tries) {
        cell.parked_at = input.now.toISOString();
        reclaimed.push({ subject, line, outcome: 'parked', try_n: tryN });
      } else {
        reclaimed.push({ subject, line, outcome: 'retry', try_n: tryN });
      }
    }
  }

  return { schedule: out, reclaimed, busy };
}

/**
 * One line's state, falling back to a v1 body that has not been fanned out yet.
 *
 * The fallback is the load-bearing half: on disk "this line has no entry" and "this row
 * predates lines" look identical and mean opposite things, and reading the second as the
 * first unparks every parked app and resets every error streak.
 */
function cellOf(row: SubjectSchedule | undefined, line: LineKey): LineSchedule | undefined {
  return row?.lines?.[line] ?? row?.legacy;
}

/**
 * Everything that happens before the pick: release expired claims, release served parks, and
 * work out who is eligible and in what order.
 *
 * Split out of `decide` so the automated-mode page can show the *queue* — the order the
 * backlog would actually be worked in — without a second, drifting copy of the eligibility
 * rules. `decide` still calls it first and behaves exactly as it did; `queue` calls it and
 * stops there. One set of rules, two readers.
 */
/**
 * The background's kinds of work, in the order they are served — requirements §26.
 *
 * Numbers rather than names so the comparator can subtract them. `workshop` (3) is never
 * returned by `tierOf` — the workshop is not a cell — but it lives in this table because the
 * walk in `decideConcurrent` slots it between `retry` and `stale`, and a second numbering
 * would be a second thing to keep in step with this one.
 */
export const TIER = { changed: 1, retry: 2, workshop: 3, stale: 4, standard: 5 } as const;
export type BacklogTier = (typeof TIER)[keyof typeof TIER];

const TIER_NAME: Record<BacklogTier, QueueTier> = {
  1: 'changed',
  2: 'retry',
  3: 'workshop',
  4: 'stale',
  5: 'standard',
};

function bestTier(cells: { tier?: QueueTier }[]): QueueTier | undefined {
  const rank = (t: QueueTier): number => Object.values(TIER_NAME).indexOf(t);
  return cells
    .map((c) => c.tier)
    .filter((t): t is QueueTier => Boolean(t))
    .sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * Which tier an eligible cell belongs to. The best one it qualifies for wins.
 *
 * `changed` covers a never-audited cell as well: no verdict and a verdict about bytes the
 * store no longer offers are the two ways the board is wrong rather than old. A cell that is
 * only eligible because somebody asked lands at `stale`; it sorts as a request first anyway.
 */
function tierOf(
  input: PolicyInput,
  schedule: Record<string, SubjectSchedule>,
  cell: Cell,
  restandard: Set<string>,
): BacklogTier {
  const last = input.lastDoneAt[cell.subject]?.[cell.line];
  if (!last || subjectChanged(input, cell.subject, cell.line)) return TIER.changed;
  if ((cellOf(schedule[cell.subject], cell.line)?.try_n ?? 0) > 0) return TIER.retry;
  if (daysSince(last, input.now) >= input.constants.fresh_days) return TIER.stale;
  if (restandard.has(cellKey(cell.subject, cell.line))) return TIER.standard;
  return TIER.stale;
}

function plan(input: PolicyInput): {
  schedule: Record<string, SubjectSchedule>;
  reclaimed: Reclaim[];
  busy?: { subject: string; since: string };
  unparked: Cell[];
  eligible: Cell[];
  /** Of those, the ones that are only eligible because the standard moved under them. */
  restandard: Set<string>;
  /** Of those, the ones that are only eligible because the app itself changed. */
  rechanged: Set<string>;
  /** Of those, the ones that are only eligible because somebody flagged them. */
  reflagged: Set<string>;
  /**
   * Subjects held out of the backlog by a park, right now.
   *
   * Not a transition set like `unparked` — this is the standing population, and it exists so
   * `decide` can stop saying something untrue. The empty-backlog reason used to read *"all 73
   * app(s) audited within 14d"*, which is a claim about every subject in the registry, while
   * parked rows had been skipped a few lines above without being audited at all. On
   * 2026-08-31 that sentence was the whole of what the operator could see about an app that
   * had been parked for three days by a misclassified success, and it sent them looking for a
   * bug in the scheduling rather than in the classifier.
   */
  parked: Cell[];
  /** The lines being scheduled, in first-declared order — the comparator's tie-break. */
  lines: LineKey[];
  /** Each eligible cell's background tier, by `cellKey`. A request carries one too; it is not read. */
  tier: Map<string, BacklogTier>;
} {
  const { constants, now } = input;
  const { schedule, reclaimed, busy } = reclaimExpired(input.schedule, input);

  // The lines worth scheduling: those some *scoring* section belongs to, in first-declared
  // order. A reading rides whatever run its line is already making and may never anchor one
  // (invariant 12's third clause), so a line made only of readings is not a line at all.
  const lines: LineKey[] = [];
  for (const section of input.sections) {
    if (!section.scores) continue;
    if (!lines.includes(section.line)) lines.push(section.line);
  }
  // A rig whose protocol directory could not be read still has to schedule: fall back to the
  // one line every installation has had, rather than deciding the backlog is empty.
  if (lines.length === 0) lines.push(DEFAULT_TARGET);

  // Parks that have served their time. Done before eligibility so a cell released this tick
  // can be picked this tick, which is what n8n's `daysSince(lr) >= STUCK_DAYS` does.
  const unparked: Cell[] = [];
  for (const [subject, row] of Object.entries(schedule)) {
    for (const [line, cell] of Object.entries(row.lines ?? {})) {
      if (!cell.parked_at) continue;
      if (daysSince(cell.parked_at, now) < constants.stuck_days) continue;
      cell.parked_at = undefined;
      cell.try_n = 0;
      unparked.push({ subject, line });
    }
  }

  const eligible: Cell[] = [];
  const parked: Cell[] = [];
  const restandard = new Set<string>();
  const rechanged = new Set<string>();
  const reflagged = new Set<string>();
  for (const subject of input.subjects) {
    const row = schedule[subject];
    for (const line of lines) {
      const cell = cellOf(row, line);
      const key = cellKey(subject, line);
      // Computed first, and for every cell rather than only for the ones the freshness
      // window would have skipped. Unlike the two clauses below it, the flag is a *stored*
      // thing an operator toggles, and the control that toggles it renders from this — so a
      // flag on a row that was already due, already retrying or already claimed still has to
      // come back as set, or the button offers to set it again.
      const flagged = flaggedForReaudit(input, subject, line, row);
      if (flagged) reflagged.add(key);
      if (cell?.claim) continue;
      if (cell?.parked_at) {
        parked.push({ subject, line });
        continue;
      }
      // An errored cell is retried on the next tick — no freshness wait. That is what
      // makes `MAX_TRIES` the thing that stops a loop, rather than the calendar.
      if ((cell?.try_n ?? 0) > 0) {
        eligible.push({ subject, line });
        continue;
      }
      const last = input.lastDoneAt[subject]?.[line];
      if (!last) {
        eligible.push({ subject, line });
        continue;
      }
      if (daysSince(last, now) >= constants.fresh_days) {
        eligible.push({ subject, line });
        continue;
      }
    // Three ways past the freshness window, and they are independent: the question changed,
    // the subject did, or somebody asked. None of them is an order by itself — the order is
    // `tierOf` below, and since 2026-11-03 (requirements §26) it is not age alone. A request is
    // a person waiting and goes to the front. An app that changed in the store is the board
    // being *wrong* about bytes it no longer offers, so it jumps the rotation. A rubric edit
    // is the opposite end: the `older standard` chip already qualifies the verdict on display,
    // so a protocol change is **filler** — worked when nothing else is due, which is what keeps
    // Touchstone busy without letting one edit put seventy-three apps ahead of anything real.
      const moved = standardMoved(input, subject, line);
      const changed = subjectChanged(input, subject, line);
      if (!moved && !changed && !flagged) continue;
      eligible.push({ subject, line });
      if (moved) restandard.add(key);
      if (changed) rechanged.add(key);
    }
  }
  // Requested first, oldest ask first; then the background by tier; staleness within a tier.
  // Stacked rather than one score, because they answer different questions — "who asked
  // first" has nothing to say about an app nobody asked for, and "which kind of work is this"
  // has nothing to say about two apps of the same kind.
  const askedAt = (cell: Cell): number => {
    if (!reflagged.has(cellKey(cell.subject, cell.line))) return Number.NaN;
    const t = Date.parse(schedule[cell.subject]?.flagged_at ?? '');
    // A flag whose timestamp will not parse still counts as a request — `reflagged` is the
    // authority on *whether*, this is only the authority on *when*. Sorting it to the back of
    // the requested block is the safe direction: it keeps its place in the queue.
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const tier = new Map<string, BacklogTier>();
  for (const cell of eligible) {
    tier.set(cellKey(cell.subject, cell.line), tierOf(input, schedule, cell, restandard));
  }
  const tierAt = (c: Cell): number => tier.get(cellKey(c.subject, c.line)) ?? TIER.stale;
  eligible.sort((a, b) => {
    const ra = askedAt(a);
    const rb = askedAt(b);
    const requestedA = Number.isNaN(ra) ? 1 : 0;
    const requestedB = Number.isNaN(rb) ? 1 : 0;
    if (requestedA !== requestedB) return requestedA - requestedB;
    if (requestedA === 0 && ra !== rb) return ra - rb;
    if (requestedA === 1) {
      const t = tierAt(a) - tierAt(b);
      if (t !== 0) return t;
    }
    const d =
      daysSince(input.lastDoneAt[b.subject]?.[b.line], now) -
      daysSince(input.lastDoneAt[a.subject]?.[a.line], now);
    // Only NaN falls through to the tie-break. `Infinity` is a real answer — it is what a
    // never-run subject scores against a dated one, and it must win. `Infinity - Infinity`
    // is the NaN case: two never-run subjects, where the comparator would otherwise leave
    // the order to the engine rather than to the data. Registry order settles it, so a
    // replay of the same tick picks the same app it picked before — and line order settles
    // the two never-run cells of one subject, for the same reason.
    if (!Number.isNaN(d) && d !== 0) return d;
    const bySubject = input.subjects.indexOf(a.subject) - input.subjects.indexOf(b.subject);
    if (bySubject !== 0) return bySubject;
    return lines.indexOf(a.line) - lines.indexOf(b.line);
  });

  return { schedule, reclaimed, busy, unparked, eligible, restandard, rechanged, reflagged, parked, lines, tier };
}

/**
 * Decide what this tick does.
 *
 * Pure: same input, same output, no clock and no I/O of its own. `now` is a parameter for
 * exactly that reason.
 */
export function decide(input: PolicyInput): TickDecision {
  if (input.free) return decideConcurrent(input, input.free);
  return decideSingle(input);
}

/** The single-flight pick: one run at a time, anywhere. See `PolicyInput.free`. */
function decideSingle(input: PolicyInput): TickDecision {
  const { constants, now } = input;
  const { schedule, reclaimed, busy, unparked, eligible, restandard, rechanged, reflagged, parked } =
    plan(input);

  const base = {
    backlog: eligible.length,
    reclaimed,
    unparked,
    parked: parked.length,
  };

  let action: 'audit' | 'trial' | 'idle' = 'idle';
  /** The cell this tick would audit — subject and platform together. */
  let picked: Cell | undefined;
  let subject: string | undefined;
  let trial: string | undefined;
  let source: 'requested' | 'backlog' | undefined;
  let reason: string;

  const cooldownLeft = Math.max(
    0,
    Math.ceil(constants.cooldown_min - minutesSince(input.lastFinishedAt, now)),
  );

  // ── the head of the request queue ─────────────────────────────────────────────────────
  // Two halves, one line. A trial is stored and a subject request is derived, but they were
  // both asked for at a moment, and that moment is the only thing that orders them: one
  // agent, one queue, first come first served. Ordering them separately would be two queues
  // wearing one heading, and the operator would have no way to answer "when does mine run".
  // ── the bench gate, per line — row D7, which n8n does not have ────────────────────────
  // A line whose capability cannot be claimed **holds at its head**: it does not advance to
  // its second-stalest cell, because refusing to claim is the whole point — an assay
  // dispatched at a bench we cannot log into produces a verdict about the bench and files it
  // against the app. But lines are independent queues for independent hardware, so passing
  // over a gated line to run a different one is not skipping, and it is what turns a FOSS
  // outage from "all auditing stops" into "the FOSS line waits".
  //
  // A capability nothing supplies is available, matching `resolveCapabilities`' property 4.
  const available = (line: LineKey): boolean => input.capabilities[line]?.available ?? true;
  // Each line's head, in the global order `plan()` sorted — requested first by ask time, then
  // stalest. `Map` keeps insertion order, so the first *available* head is also the earliest.
  const headOfLine = new Map<LineKey, Cell>();
  for (const cell of eligible) if (!headOfLine.has(cell.line)) headOfLine.set(cell.line, cell);
  const heads = [...headOfLine.values()];
  const runnable = heads.filter((c) => available(c.line));
  const gatedLines = heads.filter((c) => !available(c.line)).map((c) => c.line);

  const headTrial = (input.queuedTrials ?? [])[0];
  // Two heads, and the difference is load-bearing. `headCell` is what may be *dispatched*, so
  // it comes from the lines that can run. `headAny` is what is at the front of the queue
  // whether or not its line is gated, and it is what `waiting_on` reports — without it a
  // request held by a dead bench renders exactly like an empty queue, which is the one thing
  // a queue view must never do.
  const requested = (c: Cell): boolean => reflagged.has(cellKey(c.subject, c.line));
  const headCell = runnable.find(requested);
  const headAny = heads.find(requested);
  const headSubject = headAny?.subject;
  const trialAt = headTrial ? Date.parse(headTrial.queued_at) : Number.NaN;
  const subjectAt = headSubject ? Date.parse(schedule[headSubject]?.flagged_at ?? '') : Number.NaN;
  // An unparseable timestamp loses the comparison rather than winning it by accident, on
  // either side. The consequence is a stable order, never a dropped request: both halves are
  // still in the queue, only their order relative to each other is arbitrary.
  const trialFirst =
    Boolean(headTrial) &&
    (!headSubject || Number.isNaN(subjectAt) || (!Number.isNaN(trialAt) && trialAt <= subjectAt));
  // What the queue is waiting on, for the branches that idle while somebody is in line.
  const waitingOn = headTrial || headSubject
    ? trialFirst
      ? `trial of ${headTrial!.subject}`
      : headSubject
    : undefined;

  if (busy) {
    reason = `audit already in progress (${busy.subject}, since ${busy.since})`;
  } else if (input.agentBusy) {
    // The agent is held by something holding no claim, which in practice means a trial: it
    // owns no schedule row by design, so the claim-derived `busy` above is blind to it. Same
    // answer, different evidence, and it must be its own branch or a tick kicked the instant
    // an audit finishes would dispatch straight into the running trial and learn nothing.
    reason = 'the agent is busy with a trial';
  } else if (headTrial && trialFirst) {
    action = 'trial';
    trial = headTrial.slug;
    source = 'requested';
    reason = `requested — trial of ${headTrial.subject}`;
  } else if (headCell) {
    action = 'audit';
    picked = headCell;
    subject = headCell.subject;
    source = 'requested';
    reason = 'requested — somebody asked for this app';
  } else if (input.lastFinishedAt && cooldownLeft > 0) {
    const ago = Math.round(minutesSince(input.lastFinishedAt, now));
    reason = `cooldown — last audit finished ${ago}m ago, ${cooldownLeft}m left`;
  } else if (eligible.length === 0) {
    // Two clauses when there is something to say, because "empty" and "nothing left to do" are
    // not the same statement and only one of them is ever true of a parked registry.
    const fresh = input.subjects.length - parked.length;
    reason =
      parked.length > 0
        ? `backlog empty — ${fresh} app(s) audited within ${constants.fresh_days}d, ${parked.length} parked`
        : `backlog empty — all ${input.subjects.length} app(s) audited within ${constants.fresh_days}d`;
  } else if (runnable.length === 0) {
    // Everything eligible is on a gated line. This is the D7 idle, and it now names the line
    // rather than "the demo bench": with two pools, "no usable demo bench" while the FOSS
    // line is the held one sends the operator to the wrong board.
    const notes = gatedLines.map((line) => input.capabilities[line]?.note).filter(Boolean);
    const which =
      // One pool, and it is the default one: the sentence an operator has always read, and
      // the prefix `gatedLines()` falls back to parsing. Naming the line here would be
      // "no usable bench for bench", which is worse English about the same fact.
      gatedLines.length === 1 && gatedLines[0] === DEFAULT_TARGET
        ? 'no usable demo bench'
        : `no usable bench for ${gatedLines.join(', ')}`;
    reason = which + (notes.length > 0 ? ` — ${notes.join('; ')}` : '');
  } else {
    action = 'audit';
    picked = runnable[0];
    subject = picked!.subject;
    source = 'backlog';
    const last = input.lastDoneAt[subject]?.[picked!.line];
    const stale = daysSince(last, now);
    reason = Number.isFinite(stale)
      ? `last run ${String(last).slice(0, 10)}, ${Math.floor(stale)}d ago`
      : 'never run';
    const key = cellKey(subject, picked!.line);
    // Said out loud, because this is the second place after the bench gate where the pick is
    // *expected* to differ from n8n's: n8n has no notion of the standard moving, so a shadow
    // diff on this tick is the feature working rather than a divergence to chase.
    if (restandard.has(key)) {
      reason += ` · standard revised ${String(input.standardMovedAt?.[picked!.line]).slice(0, 10)}`;
    }
    if (rechanged.has(key)) reason += ' · app changed in the store';
    // Named for the same reason as the clause above: n8n has no flag, so a shadow diff on
    // this tick is somebody having asked rather than a divergence to chase.
    if (reflagged.has(key)) reason += ' · flagged for re-audit';
  }

  // The trial half of the queue is still gated on the **default** line, because a trial has no
  // line of its own: it audits a store zip against every section the protocol declares, and the
  // one it most needs a bench for is the default platform's. A trial that ran with a dead pool
  // would answer the static half and record `functional` blocked, and a PR author reading that
  // reasonably concludes the app is fine.
  if (action === 'trial' && !available(DEFAULT_TARGET)) {
    const note = input.capabilities[DEFAULT_TARGET]?.note;
    return {
      ...base,
      action: 'idle',
      reason: `no usable demo bench${note ? ` — ${note}` : ''}`,
      ...(waitingOn ? { waiting_on: waitingOn } : {}),
      ...(gatedLines.length > 0 ? { gated: gatedLines } : {}),
    };
  }

  const scope = picked ? scopeOf(input, picked.line) : [];
  const tryN =
    action === 'audit' && picked
      ? (cellOf(schedule[picked.subject], picked.line)?.try_n ?? 0) + 1
      : undefined;
  const dispatches: Dispatch[] =
    action === 'audit' && picked
      ? [{
          action: 'audit',
          subject: picked.subject,
          line: picked.line,
          ...(scope.length > 0 ? { sections: scope } : {}),
          source: source!,
          reason,
          try_n: tryN!,
        }]
      : action === 'trial' && trial
        ? [{
            action: 'trial',
            trial,
            line: (input.queuedTrials ?? []).find((t) => t.slug === trial)?.target ?? DEFAULT_TARGET,
            source: 'requested',
            reason,
          }]
        : [];

  return {
    ...base,
    action,
    subject,
    trial,
    source,
    reason,
    dispatches,
    // **Only when there is a scope to name.** An empty array here would reach the runner as
    // "audit these zero sections" — and the case that produces one is a protocol directory
    // that could not be read, where the honest answer is the one this had before scopes
    // existed: no scope, audit everything the protocol declares.
    ...(picked
      ? {
          line: picked.line,
          ...(scopeOf(input, picked.line).length > 0
            ? { sections: scopeOf(input, picked.line) }
            : {}),
        }
      : {}),
    // Every line that is held, whatever this tick did. On a tick that dispatched the Yundera
    // line, this is the only thing that says the FOSS pool is down — and without it the
    // transition logging in `scheduler/index.ts` could never fire for a second pool.
    ...(gatedLines.length > 0 ? { gated: gatedLines } : {}),
    // Only when nothing is moving. On a tick that dispatched, the head *is* the thing that
    // started, and repeating it as "waiting" would be a lie a page would render.
    ...(action === 'idle' && waitingOn ? { waiting_on: waitingOn } : {}),
    try_n: tryN,
  };
}

/**
 * The concurrent pick: as many runs as there are free (bench, browser) pairs.
 *
 * The queue is the same one `decideSingle` reads — requests (audits and trials, oldest ask
 * first), then the backlog by staleness — and it is walked **in that order**, each candidate
 * either starting or holding its line. Two rules carry the design:
 *
 * - **A line holds at its head.** Once one of a line's candidates cannot start — no healthy
 *   bench, every bench busy, its cooldown — nothing further down that line starts this tick,
 *   which is the D7 rule (`decideSingle`'s gate) applied per line rather than per tick. Other
 *   lines go on: a dead FOSS pool, or a FOSS bench busy with a long audit, costs Yundera
 *   nothing.
 * - **Busy is not broken.** `full` waits quietly; `gated` is the pool being unusable, and is
 *   what `gated` and the transition events report. A pool doing its job must never alert.
 *
 * Browsers are one shared pool and are spent in queue order, so with one browser this is the
 * single-flight scheduler again, with the difference that the next run is whichever line's
 * head is oldest rather than whatever claim happened to be first.
 */
function decideConcurrent(input: PolicyInput, free: NonNullable<PolicyInput['free']>): TickDecision {
  const { constants } = input;
  const { schedule, reclaimed, busy, unparked, eligible, restandard, rechanged, reflagged, parked, tier } =
    plan(input);
  void busy;

  const base = {
    backlog: eligible.length,
    reclaimed,
    unparked,
    parked: parked.length,
  };

  const armed = input.armed ?? true;
  const available = (line: LineKey): boolean => input.capabilities[line]?.available ?? true;
  const needs = (line: LineKey) => input.needs?.[line] ?? { bench: true, browser: true };
  const requested = (c: Cell): boolean => reflagged.has(cellKey(c.subject, c.line));
  const tierOfCell = (c: Cell): number => tier.get(cellKey(c.subject, c.line)) ?? TIER.stale;
  const benches: Record<LineKey, number> = { ...free.benches };
  let browsers = free.browsers;
  // What a disarmed tick *would* start, spent from a copy: those dispatches are logged as a
  // dry run and never started, so they must neither take a pair nor hold a line from work
  // that will run — and without a budget of their own every due cell would be "dispatched".
  const dryBenches: Record<LineKey, number> = { ...free.benches };
  let dryBrowsers = free.browsers;

  const askedAt = (c: Cell): number => {
    const t = Date.parse(schedule[c.subject]?.flagged_at ?? '');
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const parseAt = (iso: string | undefined): number => {
    const t = Date.parse(iso ?? '');
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };

  // ── the candidates, in the order they are served — requirements §26 ───────────────────
  // **Foreground** is everything a person is waiting for, first asked first served, whatever
  // kind of work it is. **Background** is the loop's own work, by tier. One list, one walk:
  // the workshop used to be a separate block after it with holds of its own, and that is how
  // an operator's proposal came to wait behind a trial asked for an hour later.
  type Candidate =
    | { kind: 'audit'; cell: Cell; line: LineKey; at: number; requested: boolean }
    | { kind: 'trial'; slug: string; subject: string; line: LineKey; at: number; requested: boolean }
    | { kind: 'workshop'; id: string; label: string; line: LineKey; at: number; requested: boolean };
  const trialCandidates = (input.queuedTrials ?? []).map((t): Candidate => ({
    kind: 'trial',
    slug: t.slug,
    subject: t.subject,
    line: t.target ?? DEFAULT_TARGET,
    at: parseAt(t.asked_at ?? t.queued_at),
    requested: !t.background,
  }));
  const ws = input.workshop;
  const slot = ws?.slot && !ws.running ? ws.slot : undefined;
  const workshopCandidate: Candidate | undefined = slot
    ? {
        kind: 'workshop',
        id: slot.id,
        label: slot.label,
        line: DEFAULT_TARGET,
        at: parseAt(slot.asked_at),
        requested: slot.class === 'operator',
      }
    : undefined;

  const KIND_TIE: Record<Candidate['kind'], number> = { trial: 0, audit: 1, workshop: 2 };
  const asks: Candidate[] = [
    ...eligible
      .filter(requested)
      .map((cell): Candidate => ({ kind: 'audit', cell, line: cell.line, at: askedAt(cell), requested: true })),
    ...trialCandidates.filter((c) => c.requested),
    ...(workshopCandidate?.requested ? [workshopCandidate] : []),
  ];
  // Stable, so two cells of one request keep `plan()`'s line order; at the same instant a
  // trial goes first, which is the tie `decideSingle` breaks the same way.
  asks.sort((a, b) => (a.at !== b.at ? a.at - b.at : KIND_TIE[a.kind] - KIND_TIE[b.kind]));

  const backlog = eligible
    .filter((c) => !requested(c))
    .map((cell): Candidate => ({ kind: 'audit', cell, line: cell.line, at: Number.NaN, requested: false }));
  const above = backlog.filter((c) => c.kind === 'audit' && tierOfCell(c.cell) < TIER.workshop);
  const below = backlog.filter((c) => c.kind === 'audit' && tierOfCell(c.cell) > TIER.workshop);
  // The workshop's own tier: validation it already started finishes before it authors more.
  const workshopTier: Candidate[] = [
    ...trialCandidates.filter((c) => !c.requested).sort((a, b) => a.at - b.at),
    ...(workshopCandidate && !workshopCandidate.requested ? [workshopCandidate] : []),
  ];
  const candidates: Candidate[] = [...asks, ...above, ...workshopTier, ...below];

  // ── the walk ────────────────────────────────────────────────────────────────────────────
  const holds = new Map<LineKey, LineHold>();
  /** What set each line's hold, so a workshop held behind it can say what it waits for. */
  const heldBy = new Map<LineKey, string>();
  const describe = (c: Candidate): string =>
    c.kind === 'trial' ? `trial of ${c.subject}` : c.kind === 'workshop' ? `workshop — ${c.label}` : c.cell.subject;
  const hold = (c: Candidate, why: LineHold['why'], reason: string): void => {
    if (holds.has(c.line)) return;
    const waiting = c.requested ? describe(c) : undefined;
    holds.set(c.line, { line: c.line, why, reason, ...(waiting ? { waiting_on: waiting } : {}) });
    heldBy.set(c.line, describe(c));
  };
  const dispatches: Dispatch[] = [];
  let workshopHold: string | undefined;

  for (const c of candidates) {
    const want = needs(c.line);
    // A disarmed loop decides its backlog and starts none of it (`runTick`'s `mayStart`).
    const dry = c.kind === 'audit' && !c.requested && !armed;

    if (!dry && holds.has(c.line)) {
      if (c.kind === 'workshop') {
        const by = heldBy.get(c.line);
        workshopHold =
          by && by !== describe(c) ? `waits for ${by} — ${holds.get(c.line)!.reason}` : holds.get(c.line)!.reason;
      }
      continue;
    }

    const refuse = (why: LineHold['why'], reason: string): void => {
      if (dry) return;
      hold(c, why, reason);
      if (c.kind === 'workshop') workshopHold = reason;
    };

    if (!available(c.line)) {
      const note = input.capabilities[c.line]?.note;
      refuse('gated', `${gateText([c.line])}${note ? ` — ${note}` : ''}`);
      continue;
    }
    if (want.browser && free.browsersHealthy === 0) {
      refuse('gated', 'no usable browser');
      continue;
    }
    // A line no pool counts is not managed here (`resolveCapabilities` records it), so it is
    // never "full" — the same "absent means available" this file's gate has always used.
    const pool = dry ? dryBenches : benches;
    if (want.bench && c.line in pool && pool[c.line]! <= 0) {
      // **Resting is not busy.** The transition gap (`services/leases.ts`) takes a bench out
      // of the free count for `cooldown_min` after every job, and "every bench is in use"
      // would send somebody to look for a run that is not there.
      const rest = free.resting?.[c.line];
      if (rest && rest.count > 0) {
        const mins = rest.until ? Math.max(1, Math.ceil((Date.parse(rest.until) - input.now.getTime()) / 60_000)) : undefined;
        refuse('resting', `transition — a ${c.line} bench is free again${mins ? ` in ${mins}m` : ' shortly'}`);
      } else {
        refuse('full', `every ${c.line} bench is in use`);
      }
      continue;
    }
    if (want.browser && (dry ? dryBrowsers : browsers) <= 0) {
      refuse('full', 'every browser is in use');
      continue;
    }

    if (want.bench && c.line in pool) pool[c.line]! -= 1;
    if (want.browser) {
      if (dry) dryBrowsers -= 1;
      else browsers -= 1;
    }

    if (c.kind === 'trial') {
      dispatches.push({
        action: 'trial',
        trial: c.slug,
        line: c.line,
        source: c.requested ? 'requested' : 'workshop',
        reason: c.requested ? `requested — trial of ${c.subject}` : `workshop — validating ${c.subject}`,
      });
      continue;
    }
    if (c.kind === 'workshop') {
      dispatches.push({
        action: 'workshop',
        workshop: c.id,
        line: c.line,
        source: 'workshop',
        reason: `workshop — ${c.label}`,
      });
      continue;
    }
    const { subject, line } = c.cell;
    const key = cellKey(subject, line);
    let reason: string;
    if (c.requested) {
      reason = 'requested — somebody asked for this app';
    } else {
      const last = input.lastDoneAt[subject]?.[line];
      const stale = daysSince(last, input.now);
      reason = Number.isFinite(stale)
        ? `last run ${String(last).slice(0, 10)}, ${Math.floor(stale)}d ago`
        : 'never run';
      if (restandard.has(key)) {
        reason += ` · standard revised ${String(input.standardMovedAt?.[line]).slice(0, 10)}`;
      }
      if (rechanged.has(key)) reason += ' · app changed in the store';
    }
    const scope = scopeOf(input, line);
    dispatches.push({
      action: 'audit',
      subject,
      line,
      ...(scope.length > 0 ? { sections: scope } : {}),
      source: c.requested ? 'requested' : 'backlog',
      reason,
      try_n: (cellOf(schedule[subject], line)?.try_n ?? 0) + 1,
    });
  }

  const held = [...holds.values()];
  const gated = held.filter((h) => h.why === 'gated').map((h) => h.line);
  // The headline is the first dispatch that will actually start; a disarmed tick's dry
  // backlog only headlines when nothing real did.
  const first = dispatches.find((d) => armed || d.source !== 'backlog') ?? dispatches[0];
  const waitingOn = held.find((h) => h.waiting_on)?.waiting_on;

  let reason: string;
  if (first) {
    reason = first.reason;
  } else if (candidates.length === 0) {
    const fresh = input.subjects.length - parked.length;
    reason =
      parked.length > 0
        ? `backlog empty — ${fresh} app(s) audited within ${constants.fresh_days}d, ${parked.length} parked`
        : `backlog empty — all ${input.subjects.length} app(s) audited within ${constants.fresh_days}d`;
  } else if (held.length === 1) {
    reason = held[0]!.reason;
  } else {
    reason = held.map((h) => `${h.line}: ${h.reason}`).join(' · ');
  }

  return {
    ...base,
    action: first ? first.action : 'idle',
    ...(first?.subject ? { subject: first.subject } : {}),
    ...(first?.trial ? { trial: first.trial } : {}),
    ...(first?.workshop ? { workshop: first.workshop } : {}),
    ...(first ? { source: first.source, line: first.line } : {}),
    ...(first?.sections ? { sections: first.sections } : {}),
    ...(first?.try_n !== undefined ? { try_n: first.try_n } : {}),
    reason,
    dispatches,
    ...(workshopHold ? { workshop_hold: workshopHold } : {}),
    ...(held.length > 0 ? { held } : {}),
    ...(gated.length > 0 ? { gated } : {}),
    ...(!first && waitingOn ? { waiting_on: waitingOn } : {}),
  };
}

/** The gate's wording, kept as the single-flight path words it so the transition log reads alike. */
function gateText(lines: LineKey[]): string {
  return lines.length === 1 && lines[0] === DEFAULT_TARGET
    ? 'no usable demo bench'
    : `no usable bench for ${lines.join(', ')}`;
}

/**
 * What a run on this line covers: every section that belongs to it.
 *
 * Including the readings, which is how `currency` goes on riding every run of its own line
 * without ever anchoring one. **The scheduler composes this, never a caller** — that is the
 * whole difference between a scope and the `depth` parameter this repo removed: `depth` was
 * somebody at the point of pressing deciding to audit half the rubric, and a scope is the
 * line's own answer to what is due on it.
 */
function scopeOf(input: PolicyInput, line: LineKey): string[] {
  return input.sections.filter((s) => s.line === line).map((s) => s.id);
}

/**
 * The whole registry, backlog first, in the order the loop would work it.
 *
 * Pure, and derived from the same `plan()` the pick uses — so the row at position 1 is the
 * app the next unblocked tick audits, not a second guess at it. Subjects that are *not*
 * eligible are still listed, because "why is my app not being tested" is the question this
 * page exists to answer, and an app missing from the list answers nothing.
 *
 * It reports no cooldown, no bench gate and no armed state. Those decide *when* the queue
 * moves, not what is in it, and folding them in here would make an idling loop look like an
 * empty backlog.
 */
export function queue(input: PolicyInput): QueueRow[] {
  const { constants, now } = input;
  const { schedule, eligible, restandard, rechanged, reflagged, lines, tier } = plan(input);
  const position = new Map(eligible.map((cell, i) => [cellKey(cell.subject, cell.line), i + 1]));

  /** How actionable a state is. The subject's row shows the most actionable of its cells. */
  const RANK: Record<QueueState, number> = {
    running: 0, parked: 1, retry: 2, never: 3, due: 4, fresh: 5,
  };

  // **One row per subject, not one per cell.** 73 apps on two platforms is 146 cells, and an
  // Automation page listing each twice answers "when does mine run" worse than one that
  // summarises and carries the detail. The per-line breakdown rides along in `lines`.
  const rows = input.subjects.map((subject): QueueRow => {
    const row = schedule[subject];

    const cells = lines.map((line) => {
      const cell = cellOf(row, line);
      const key = cellKey(subject, line);
      const last = input.lastDoneAt[subject]?.[line];
      const days = last ? daysSince(last, now) : undefined;

      let state: QueueState;
      if (cell?.claim) state = 'running';
      else if (cell?.parked_at) state = 'parked';
      else if ((cell?.try_n ?? 0) > 0) state = 'retry';
      else if (!last) state = 'never';
      else if (daysSince(last, now) >= constants.fresh_days) state = 'due';
      // A restandard cell carries a queue position, so calling it `fresh` would put a
      // contradiction on one line. It is due; the note says what made it due.
      // `position` is the honest test now that a flag is reported on every cell it is set
      // on: a claimed or parked cell can carry one, and neither of those is due.
      else state = position.has(key) ? 'due' : 'fresh';

      return {
        line,
        state,
        ...(position.has(key) ? { position: position.get(key)! } : {}),
        ...(last ? { last_done_at: last } : {}),
        ...(days !== undefined && Number.isFinite(days) ? { days: Math.round(days * 10) / 10 } : {}),
        try_n: cell?.try_n ?? 0,
        ...(restandard.has(key) ? { standard_moved: true } : {}),
        ...(rechanged.has(key) ? { subject_changed: true } : {}),
        ...(reflagged.has(key) ? { flagged: true } : {}),
        ...(position.has(key) && !reflagged.has(key) && tier.has(key) ? { tier: TIER_NAME[tier.get(key)!] } : {}),
        ...(cell?.parked_at ? { parked_at: cell.parked_at } : {}),
        ...(cell?.claim ? { claim_since: cell.claim.since } : {}),
      };
    });

    const best = [...cells].sort((a, b) => RANK[a.state] - RANK[b.state])[0]!;
    // The subject's own figures are the most actionable cell's, except the ones where "any"
    // is the honest answer: a subject is queued if *any* line queued it, and its last result
    // is the newest anywhere. `try_n` is the worst of them — how close this app is to being
    // parked somewhere, which is what an operator scanning the column wants to know.
    const positions = cells.map((c) => c.position).filter((p): p is number => p !== undefined);
    const lastAny = cells
      .map((c) => c.last_done_at)
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1);
    const daysAny = lastAny ? daysSince(lastAny, now) : undefined;

    return {
      subject,
      state: best.state,
      lines: cells,
      ...(positions.length > 0 ? { position: Math.min(...positions) } : {}),
      ...(lastAny ? { last_done_at: lastAny } : {}),
      ...(daysAny !== undefined && Number.isFinite(daysAny)
        ? { days: Math.round(daysAny * 10) / 10 }
        : {}),
      try_n: Math.max(...cells.map((c) => c.try_n)),
      // `due` and not a state of its own: it *is* due, and the only extra thing to say is
      // why — which the Automation page appends to the note rather than to the status word.
      ...(cells.some((c) => c.standard_moved) ? { standard_moved: true } : {}),
      ...(cells.some((c) => c.subject_changed) ? { subject_changed: true } : {}),
      // Reported from the *derived* set rather than from `flagged_at` being present, so a
      // flag the last attempt already answered stops showing the moment it stops counting.
      ...(cells.some((c) => c.flagged) ? { flagged: true } : {}),
      // The best tier of any line, which is the one that sets this row's position.
      ...(bestTier(cells) ? { tier: bestTier(cells)! } : {}),
      ...(best.parked_at ? { parked_at: best.parked_at } : {}),
      ...(best.claim_since ? { claim_since: best.claim_since } : {}),
    };
  });

  // Eligible rows in queue order, then everyone else in registry order. Sorting the whole
  // list by staleness would bury the running subject somewhere in the middle.
  return rows.sort((a, b) => {
    if (a.position && b.position) return a.position - b.position;
    if (a.position) return -1;
    if (b.position) return 1;
    return 0;
  });
}

/**
 * What somebody asked for, oldest ask first — the request queue, composed.
 *
 * Pure, and derived from the same `plan()` the pick uses, so the row at position 1 is what
 * the next unblocked tick takes rather than a second guess at it. The audit half is not
 * stored anywhere: a subject is in this list exactly while its `flagged_at` is newer than its
 * last attempt, which is the same predicate `decide` picks by and the same one the button
 * reads back. The trial half is stored, because a trial has no attempt record to spend a
 * timestamp against — see invariant 8.
 *
 * `label` carries the subject **key** for an audit. Stripping it to a bare name is the wire's
 * job (`routes/schedule.ts`), for the same reason `queue()` leaves it alone: this file's
 * output is compared and tested, not rendered.
 */
export function requests(input: PolicyInput): RequestRow[] {
  const { schedule, reflagged, lines } = plan(input);
  const rows: RequestRow[] = [];

  for (const subject of input.subjects) {
    // **One row per subject, however many of its lines are outstanding.** One press is one
    // request; fanning it into a row per platform would make the position count meaningless
    // and the operator's "mine is third" wrong by a factor of the number of pools.
    const pending = lines.filter((line) => reflagged.has(cellKey(subject, line)));
    if (pending.length === 0) continue;
    const row = schedule[subject];
    rows.push({
      kind: 'audit',
      id: subject,
      label: subject,
      requested_at: row?.flagged_at ?? '',
      position: 0,
      // Running while *any* line of it holds a claim.
      state: pending.some((line) => cellOf(row, line)?.claim) ? 'running' : 'waiting',
      // Which platforms are still to go, so a half-served request reads as half-served
      // rather than disappearing when the first line answers it.
      ...(lines.length > 1 ? { lines: pending } : {}),
    });
  }
  const trialRow = (t: QueuedTrial, state: RequestRow['state']): RequestRow => ({
    kind: 'trial',
    id: t.slug,
    label: t.subject,
    requested_at: t.asked_at ?? t.queued_at,
    position: 0,
    state,
    ...(t.background ? { background: true } : {}),
  });
  for (const t of input.queuedTrials ?? []) rows.push(trialRow(t, 'waiting'));
  for (const t of input.runningTrials ?? (input.runningTrial ? [input.runningTrial] : [])) {
    rows.push(trialRow(t, 'running'));
  }
  const ws = input.workshop;
  if (ws?.running) {
    rows.push({
      kind: 'workshop',
      id: ws.running.id,
      label: ws.running.label,
      requested_at: ws.running.started_at,
      position: 0,
      state: 'running',
    });
  } else if (ws?.slot) {
    rows.push({
      kind: 'workshop',
      id: ws.slot.id,
      label: ws.slot.label,
      requested_at: ws.slot.asked_at,
      position: 0,
      state: 'waiting',
      ...(ws.slot.class === 'idle' ? { background: true } : {}),
    });
  }

  rows.sort((a, b) => {
    // Whatever is running is the head, whatever it was asked for. It is not waiting on the
    // queue; the queue is waiting on it.
    const ra = a.state === 'running' ? 0 : 1;
    const rb = b.state === 'running' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    // Foreground before background (requirements §26): a person's work, whatever kind, in
    // the order it was asked for; then what the workshop is doing for itself.
    const ba = a.background ? 1 : 0;
    const bb = b.background ? 1 : 0;
    if (ba !== bb) return ba - bb;
    const ta = Date.parse(a.requested_at);
    const tb = Date.parse(b.requested_at);
    // An unparseable ask sorts last rather than first — it keeps its place in the queue
    // without displacing a request that can prove when it was made.
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb;
  });

  return rows.map((row, i) => ({ ...row, position: i + 1 }));
}

/** Minutes of cooldown left before another audit may start. 0 once it is clear. */
export function cooldownLeftMin(input: {
  now: Date;
  cooldown_min: number;
  lastFinishedAt?: string;
}): number {
  if (!input.lastFinishedAt) return 0;
  return Math.max(0, Math.ceil(input.cooldown_min - minutesSince(input.lastFinishedAt, input.now)));
}

/** The State line, worded as n8n words it, so the two can be compared by eye. */
export function stateLine(decision: TickDecision): string {
  // Several started: name each with its platform, because two runs of one app are legitimate.
  if ((decision.dispatches?.length ?? 0) > 1) {
    const names = decision.dispatches!.map((d) => `${d.subject ?? `trial ${d.trial}`} (${d.line})`);
    return `⏳ starting ${names.join(', ')}`;
  }
  if (decision.action === 'audit') return `⏳ auditing ${decision.subject} — ${decision.reason}`;
  if (decision.action === 'trial') return `⏳ trialling ${decision.trial} — ${decision.reason}`;
  // An idle tick that has somebody in the queue says so. "idle — no usable demo bench" and
  // "idle — backlog empty" are the same seven characters of status word for two conditions an
  // operator would act on differently, and only one of them has a person waiting on it.
  const waiting = decision.waiting_on ? ` · ${decision.waiting_on} is waiting` : '';
  return `⏸️ idle — ${decision.reason}${waiting}`;
}

export type { Leg };
// Re-exported so every existing importer keeps its one import of the scheduler's own
// vocabulary. The definitions live in `shared/` because the automated-mode page renders
// them, and a second copy of `TickDecision` would drift from this one within a release.
export type { Reclaim, SubjectSchedule, TickDecision } from '../../shared/schedule.js';
