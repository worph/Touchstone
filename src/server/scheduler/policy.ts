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
 * Two things about that queue are load-bearing here. **A request bypasses the cooldown**, so
 * pressing Audit on an idle box starts an audit rather than explaining that it will in
 * fifty-five minutes. And **a request is not gated by `armed`** — that switch stops the loop
 * helping itself, not an operator asking — which is why the decision carries a `source`.
 *
 * The bench gate is deliberately **after** that chain rather than woven into it, so the gate
 * is visibly a separate decision rather than a clause inside the pick. A request that cannot
 * run holds the head of the line and says why, which is the whole reason `waiting_on`
 * exists: "the queue is empty" and "the queue cannot move" must never render alike.
 */

import type { Leg } from '../../shared/types.js';
import type {
  QueueRow,
  QueueState,
  Reclaim,
  RequestRow,
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
  queuedTrials?: { slug: string; subject: string; queued_at: string }[];
  /**
   * The trial holding the agent right now, if one is.
   *
   * Kept out of `queuedTrials` rather than flagged inside it, because `decide` takes that
   * list's head as the thing to dispatch and a running trial must never be dispatched twice.
   * It exists for `requests()` alone: a queue view that hides the item currently being worked
   * is a queue view that appears to have lost it.
   */
  runningTrial?: { slug: string; subject: string; queued_at: string };
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
    // Three ways past the freshness window, and they are independent: the question changed,
    // the subject did, or somebody asked. **Two of the three merely add to the backlog** —
    // no jump, no bypass of the cooldown, the park or the bench gate. A rubric edit and a
    // compose change are facts about the world, and the world can wait for the rotation: the
    // loop is saturated most of the time, so in practice they say "re-judge it with the
    // spare hour rather than waiting out the week", which is exactly as much as they should
    // say. Both sort last among the eligible — by `lastDoneAt`, and they are the freshest
    // things in the list — so a never-audited app still goes first.
    //
    // The third is different and became different on 2026-09-01. A flag is not a fact about
    // the world, it is a person waiting for an answer, and it now sorts to the **front** —
    // see the comparator below. That asymmetry is the whole design: `standard_moved` and
    // `subject_changed` must go on proving they do not jump, or a rubric edit would put
    // seventy-three apps ahead of the one somebody actually pressed a button for.
    const moved = standardMoved(input, subject);
    const changed = subjectChanged(input, subject);
    if (!moved && !changed && !flagged) continue;
    eligible.push(subject);
    if (moved) restandard.add(subject);
    if (changed) rechanged.add(subject);
  }
  // Requested first, oldest ask first; everything else by staleness underneath. Two
  // comparators stacked rather than one, because they are answering different questions —
  // "who asked first" has nothing to say about an app nobody asked for, and "who is stalest"
  // has nothing to say about a queue.
  const askedAt = (subject: string): number => {
    if (!reflagged.has(subject)) return Number.NaN;
    const t = Date.parse(schedule[subject]?.flagged_at ?? '');
    // A flag whose timestamp will not parse still counts as a request — `reflagged` is the
    // authority on *whether*, this is only the authority on *when*. Sorting it to the back of
    // the requested block is the safe direction: it keeps its place in the queue.
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  eligible.sort((a, b) => {
    const ra = askedAt(a);
    const rb = askedAt(b);
    const requestedA = Number.isNaN(ra) ? 1 : 0;
    const requestedB = Number.isNaN(rb) ? 1 : 0;
    if (requestedA !== requestedB) return requestedA - requestedB;
    if (requestedA === 0 && ra !== rb) return ra - rb;
    const d = daysSince(input.lastDoneAt[b], now) - daysSince(input.lastDoneAt[a], now);
    // Only NaN falls through to the tie-break. `Infinity` is a real answer — it is what a
    // never-run subject scores against a dated one, and it must win. `Infinity - Infinity`
    // is the NaN case: two never-run subjects, where the comparator would otherwise leave
    // the order to the engine rather than to the data. Registry order settles it, so a
    // replay of the same tick picks the same app it picked before.
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

  let action: 'audit' | 'trial' | 'idle' = 'idle';
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
  const headTrial = (input.queuedTrials ?? [])[0];
  const headSubject = eligible.find((s) => reflagged.has(s));
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
  } else if (headSubject) {
    action = 'audit';
    subject = headSubject;
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
  } else {
    action = 'audit';
    subject = eligible[0];
    source = 'backlog';
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
  if (action !== 'idle' && !input.benchAvailable) {
    return {
      ...base,
      action: 'idle',
      reason: `no usable demo bench${input.benchNote ? ` — ${input.benchNote}` : ''}`,
      // The gate covers a trial as well as an audit, and deliberately: a trial that ran with
      // a dead pool would answer the static half and record `functional` blocked, and a PR
      // author reading that reasonably concludes the app is fine. One rule for both verbs.
      ...(waitingOn ? { waiting_on: waitingOn } : {}),
    };
  }

  return {
    ...base,
    action,
    subject,
    trial,
    source,
    reason,
    // Only when nothing is moving. On a tick that dispatched, the head *is* the thing that
    // started, and repeating it as "waiting" would be a lie a page would render.
    ...(action === 'idle' && waitingOn ? { waiting_on: waitingOn } : {}),
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
  const { schedule, reflagged } = plan(input);
  const rows: RequestRow[] = [];

  for (const subject of input.subjects) {
    if (!reflagged.has(subject)) continue;
    const row = schedule[subject];
    rows.push({
      kind: 'audit',
      id: subject,
      label: subject,
      requested_at: row?.flagged_at ?? '',
      position: 0,
      state: row?.claim ? 'running' : 'waiting',
    });
  }
  for (const t of input.queuedTrials ?? []) {
    rows.push({
      kind: 'trial',
      id: t.slug,
      label: t.subject,
      requested_at: t.queued_at,
      position: 0,
      state: 'waiting',
    });
  }
  if (input.runningTrial) {
    rows.push({
      kind: 'trial',
      id: input.runningTrial.slug,
      label: input.runningTrial.subject,
      requested_at: input.runningTrial.queued_at,
      position: 0,
      state: 'running',
    });
  }

  rows.sort((a, b) => {
    // Whatever is running is the head, whatever it was asked for. It is not waiting on the
    // queue; the queue is waiting on it.
    const ra = a.state === 'running' ? 0 : 1;
    const rb = b.state === 'running' ? 0 : 1;
    if (ra !== rb) return ra - rb;
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
