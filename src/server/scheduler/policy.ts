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
  for (const subject of input.subjects) {
    const row = schedule[subject];
    if (row?.claim) continue;
    if (row?.parked_at) continue;
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
    if (daysSince(last, now) >= constants.fresh_days) eligible.push(subject);
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

  return { schedule, reclaimed, busy, unparked, eligible };
}

/**
 * Decide what this tick does.
 *
 * Pure: same input, same output, no clock and no I/O of its own. `now` is a parameter for
 * exactly that reason.
 */
export function decide(input: PolicyInput): TickDecision {
  const { constants, now } = input;
  const { schedule, reclaimed, busy, unparked, eligible } = plan(input);

  const base = {
    backlog: eligible.length,
    reclaimed,
    unparked,
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
    reason = `backlog empty — all ${input.subjects.length} app(s) audited within ${constants.fresh_days}d`;
  } else {
    action = 'audit';
    subject = eligible[0];
    const stale = daysSince(input.lastDoneAt[subject!], now);
    reason = Number.isFinite(stale)
      ? `last run ${String(input.lastDoneAt[subject!]).slice(0, 10)}, ${Math.floor(stale)}d ago`
      : 'never run';
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
  const { schedule, eligible } = plan(input);
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
    else state = daysSince(last, now) >= constants.fresh_days ? 'due' : 'fresh';

    return {
      subject,
      state,
      ...(position.has(subject) ? { position: position.get(subject)! } : {}),
      ...(last ? { last_done_at: last } : {}),
      ...(days !== undefined && Number.isFinite(days) ? { days: Math.round(days * 10) / 10 } : {}),
      try_n: row?.try_n ?? 0,
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
