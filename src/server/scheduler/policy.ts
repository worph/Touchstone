/**
 * The decision, as a pure function — the port of n8n's `Pick next target`.
 *
 * Everything that reads the world (the roll-up, GitHub, the bench pool) happens in
 * `Scheduler`; this file only decides. That split exists for one reason: **shadow mode**.
 * Phase 1 runs this alongside the live n8n loop and diffs its pick against n8n's own
 * `- **State:**` line over ~150 real ticks, and a decision that cannot be replayed from a
 * plain input object cannot be diffed.
 *
 * The order of the branches below is load-bearing. It is n8n's order, and a divergence
 * anywhere in it turns the shadow diff from a bug detector into noise:
 *
 *   busy → forced → cooldown → backlog empty → pick the stalest
 *
 * The bench gate is deliberately **after** that chain rather than woven into it, so the
 * pick is identical to n8n's and the gate is visibly a separate decision. n8n has no such
 * gate at all (row D7, §2.3), so a tick that idles on it is the one place this policy is
 * *expected* to differ — and it says so in `reason`.
 */

import type { Leg } from '../../shared/types.js';
import type {
  QueueRow,
  QueueState,
  Reclaim,
  SubjectSchedule,
  TickDecision,
} from '../../shared/schedule.js';

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
  /** Latest *completed* assay per subject, ISO. Blocked and running runs are not completions. */
  lastDoneAt: Record<string, string | undefined>;
  schedule: Record<string, SubjectSchedule | undefined>;
  /** When any assay last finished, anywhere. The cooldown anchor. */
  lastFinishedAt?: string;
  /** A forced run bypasses freshness and cooldown, exactly as n8n's form trigger does. */
  forced?: string[];
  /**
   * Newest assay of **any status** per subject, ISO — a blocked or errored attempt counts.
   *
   * Only the standard clause below reads this. `lastDoneAt` is the freshness and ordering
   * signal and stays what it always was; this one answers a different question — *have we
   * pointed the current standard at this app at all* — and a blocked attempt answers it yes.
   * See `domain/standards.ts` for why the two cannot be one field.
   */
  lastAttemptAt?: Record<string, string | undefined>;
  /**
   * When the standard last moved — `StandardSnapshot.moved_at`.
   *
   * Absent means the question is not being asked (no revision history, or nothing recorded
   * yet), and the eligibility rule below is then a no-op.
   */
  standardMovedAt?: string;
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
  auditedVersion?: Record<string, string | undefined>;
  /** Whether a bench may be claimed right now — `BenchProber.leasable().length > 0`. */
  benchAvailable: boolean;
  /** Why not, for the reason string. Never an error object; one clause a human reads. */
  benchNote?: string;
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
function standardMoved(input: PolicyInput, subject: string): boolean {
  if (!input.standardMovedAt) return false;
  const moved = Date.parse(input.standardMovedAt);
  if (Number.isNaN(moved)) return false;
  const attempted = Date.parse(input.lastAttemptAt?.[subject] ?? '');
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
function subjectChanged(input: PolicyInput, subject: string): boolean {
  const now = input.currentVersion?.[subject];
  const then = input.auditedVersion?.[subject];
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
  row: SubjectSchedule | undefined,
): boolean {
  // The row comes from the caller rather than from `input.schedule`, because `plan()` works
  // on the copy `reclaimExpired` returned and that copy is the one the rest of the tick
  // agrees with.
  return isFlaggedForReaudit(row?.flagged_at, input.lastAttemptAt?.[subject]);
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

  for (const subject of input.subjects) {
    const row = schedule[subject];
    if (!row) continue;
    out[subject] = { ...row, claim: row.claim ? { ...row.claim } : undefined };
  }
  // A claim on a subject the registry no longer lists still has to be released, or it
  // holds single-flight shut forever.
  for (const [subject, row] of Object.entries(schedule)) {
    if (!out[subject] && row) out[subject] = { ...row, claim: row.claim ? { ...row.claim } : undefined };
  }

  for (const [subject, row] of Object.entries(out)) {
    if (!row.claim) continue;
    if (minutesSince(row.claim.since, input.now) < input.constants.lease_min) {
      // Still held. n8n reports the first one it meets; the ordering is the registry's.
      if (!busy) busy = { subject, since: row.claim.since };
      continue;
    }
    const tryN = row.claim.try_n;
    row.claim = undefined;
    if (tryN >= input.constants.max_tries) {
      row.try_n = tryN;
      row.parked_at = input.now.toISOString();
      reclaimed.push({ subject, outcome: 'parked', try_n: tryN });
    } else {
      row.try_n = tryN;
      reclaimed.push({ subject, outcome: 'retry', try_n: tryN });
    }
  }

  return { schedule: out, reclaimed, busy };
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
function plan(input: PolicyInput): {
  schedule: Record<string, SubjectSchedule>;
  reclaimed: Reclaim[];
  busy?: { subject: string; since: string };
  unparked: string[];
  eligible: string[];
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
  parked: string[];
} {
  const { constants, now } = input;
  const { schedule, reclaimed, busy } = reclaimExpired(input.schedule, input);

  // Parks that have served their time. Done before eligibility so a subject released this
  // tick can be picked this tick, which is what n8n's `daysSince(lr) >= STUCK_DAYS` does.
  const unparked: string[] = [];
  for (const [subject, row] of Object.entries(schedule)) {
    if (!row.parked_at) continue;
    if (daysSince(row.parked_at, now) < constants.stuck_days) continue;
    row.parked_at = undefined;
    row.try_n = 0;
    unparked.push(subject);
  }

  const eligible: string[] = [];
  const parked: string[] = [];
  const restandard = new Set<string>();
  const rechanged = new Set<string>();
  const reflagged = new Set<string>();
  for (const subject of input.subjects) {
    const row = schedule[subject];
    // Computed first, and for every subject rather than only for the ones the freshness
    // window would have skipped. Unlike the two clauses below it, the flag is a *stored*
    // thing an operator toggles, and the control that toggles it renders from this — so a
    // flag on a row that was already due, already retrying or already claimed still has to
    // come back as set, or the button offers to set it again.
    const flagged = flaggedForReaudit(input, subject, row);
    if (flagged) reflagged.add(subject);
    if (row?.claim) continue;
    if (row?.parked_at) {
      parked.push(subject);
      continue;
    }
    // An errored subject is retried on the next tick — no freshness wait. That is what
    // makes `MAX_TRIES` the thing that stops a loop, rather than the calendar.
    if ((row?.try_n ?? 0) > 0) {
      eligible.push(subject);
      continue;
    }
    const last = input.lastDoneAt[subject];
    if (!last) {
      eligible.push(subject);
      continue;
    }
    if (daysSince(last, now) >= constants.fresh_days) {
      eligible.push(subject);
      continue;
    }
    // Still fresh by the calendar, but judged by a rubric that has since been edited. It
    // joins the backlog and nothing else: no jump, no forced run, no bypass of the cooldown
    // or the bench gate. The loop is already saturated most of the time, so in practice this
    // says "re-judge it with the spare hour rather than waiting out the week", which is
    // exactly as much as it should say. It sorts last among the eligible — by `lastDoneAt`,
    // and it is the freshest thing in the list — so a never-audited app still goes first.
    // Three ways past the freshness window, and they are independent: the question changed,
    // the subject did, or somebody asked. All three merely add to the backlog — no jump, no
    // forced run, no bypass of the cooldown, the park or the bench gate — so a flagged app
    // that was audited yesterday sorts behind everything staler, which is the point: it is a
    // request to include it in the ordinary rotation, not to interrupt it.
    const moved = standardMoved(input, subject);
    const changed = subjectChanged(input, subject);
    if (!moved && !changed && !flagged) continue;
    eligible.push(subject);
    if (moved) restandard.add(subject);
    if (changed) rechanged.add(subject);
  }
  eligible.sort((a, b) => {
    const d = daysSince(input.lastDoneAt[b], now) - daysSince(input.lastDoneAt[a], now);
    // Only NaN falls through to the tie-break. `Infinity` is a real answer — it is what a
    // never-run subject scores against a dated one, and it must win. `Infinity - Infinity`
    // is the NaN case: two never-run subjects, where the comparator would otherwise leave
    // the order to the engine rather than to the data. Registry order settles it, so a
    // replay of the same tick picks the same app n8n picked.
    if (!Number.isNaN(d) && d !== 0) return d;
    return input.subjects.indexOf(a) - input.subjects.indexOf(b);
  });

  return { schedule, reclaimed, busy, unparked, eligible, restandard, rechanged, reflagged, parked };
}

/**
 * Decide what this tick does.
 *
 * Pure: same input, same output, no clock and no I/O of its own. `now` is a parameter for
 * exactly that reason.
 */
export function decide(input: PolicyInput): TickDecision {
  const { constants, now } = input;
  const { schedule, reclaimed, busy, unparked, eligible, restandard, rechanged, reflagged, parked } =
    plan(input);

  const base = {
    backlog: eligible.length,
    reclaimed,
    unparked,
    parked: parked.length,
  };

  let action: 'audit' | 'idle' = 'idle';
  let subject: string | undefined;
  let reason: string;

  const cooldownLeft = Math.max(
    0,
    Math.ceil(constants.cooldown_min - minutesSince(input.lastFinishedAt, now)),
  );
  const forced = (input.forced ?? []).filter(Boolean);

  if (busy) {
    reason = `audit already in progress (${busy.subject}, since ${busy.since})`;
  } else if (forced.length > 0) {
    action = 'audit';
    subject = forced[0];
    reason = 'forced (manual trigger)';
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
  } else {
    action = 'audit';
    subject = eligible[0];
    const stale = daysSince(input.lastDoneAt[subject!], now);
    reason = Number.isFinite(stale)
      ? `last run ${String(input.lastDoneAt[subject!]).slice(0, 10)}, ${Math.floor(stale)}d ago`
      : 'never run';
    // Said out loud, because this is the second place after the bench gate where the pick is
    // *expected* to differ from n8n's: n8n has no notion of the standard moving, so a shadow
    // diff on this tick is the feature working rather than a divergence to chase.
    if (restandard.has(subject!)) {
      reason += ` · standard revised ${String(input.standardMovedAt).slice(0, 10)}`;
    }
    if (rechanged.has(subject!)) reason += ' · app changed in the store';
    // Named for the same reason as the clause above: n8n has no flag, so a shadow diff on
    // this tick is somebody having asked rather than a divergence to chase.
    if (reflagged.has(subject!)) reason += ' · flagged for re-audit';
  }

  // ── the bench gate — row D7, which n8n does not have ──────────────────────────────────
  // Refusing to claim is the whole point: an assay dispatched at a bench we cannot log into
  // produces a verdict about the bench and files it against the app. Idling here consumes no
  // try and stamps no last-run, so the subject comes back untouched on the next tick.
  if (action === 'audit' && !input.benchAvailable) {
    return {
      ...base,
      action: 'idle',
      reason: `no usable demo bench${input.benchNote ? ` — ${input.benchNote}` : ''}`,
    };
  }

  return {
    ...base,
    action,
    subject,
    reason,
    try_n: action === 'audit' && subject ? (schedule[subject]?.try_n ?? 0) + 1 : undefined,
  };
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
  const { schedule, eligible, restandard, rechanged, reflagged } = plan(input);
  const position = new Map(eligible.map((subject, i) => [subject, i + 1]));

  const rows = input.subjects.map((subject): QueueRow => {
    const row = schedule[subject];
    const last = input.lastDoneAt[subject];
    const days = last ? daysSince(last, now) : undefined;

    let state: QueueState;
    if (row?.claim) state = 'running';
    else if (row?.parked_at) state = 'parked';
    else if ((row?.try_n ?? 0) > 0) state = 'retry';
    else if (!last) state = 'never';
    else if (daysSince(last, now) >= constants.fresh_days) state = 'due';
    // A restandard row carries a queue position, so calling it `fresh` would put a
    // contradiction on one line. It is due; the note says what made it due.
    // `position` is the honest test now that a flag is reported on every row it is set on:
    // a claimed or parked subject can carry one, and neither of those is due.
    else state = position.has(subject) ? 'due' : 'fresh';

    return {
      subject,
      state,
      ...(position.has(subject) ? { position: position.get(subject)! } : {}),
      ...(last ? { last_done_at: last } : {}),
      ...(days !== undefined && Number.isFinite(days) ? { days: Math.round(days * 10) / 10 } : {}),
      try_n: row?.try_n ?? 0,
      // `due` and not a state of its own: it *is* due, and the only extra thing to say is
      // why — which the Automation page appends to the note rather than to the status word.
      ...(restandard.has(subject) ? { standard_moved: true } : {}),
      ...(rechanged.has(subject) ? { subject_changed: true } : {}),
      // Reported from the *derived* set rather than from `flagged_at` being present, so a
      // flag the last attempt already answered stops showing the moment it stops counting.
      ...(reflagged.has(subject) ? { flagged: true } : {}),
      ...(row?.parked_at ? { parked_at: row.parked_at } : {}),
      ...(row?.claim ? { claim_since: row.claim.since } : {}),
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
  return decision.action === 'audit'
    ? `⏳ auditing ${decision.subject} — ${decision.reason}`
    : `⏸️ idle — ${decision.reason}`;
}

export type { Leg };
// Re-exported so every existing importer keeps its one import of the scheduler's own
// vocabulary. The definitions live in `shared/` because the automated-mode page renders
// them, and a second copy of `TickDecision` would drift from this one within a release.
export type { Reclaim, SubjectSchedule, TickDecision } from '../../shared/schedule.js';
