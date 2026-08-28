/**
 * What a finished attempt does to the schedule — the port of n8n's `Record result`.
 *
 * Pure, like `policy.ts`, and for the same reason: these rules are the ones that were
 * commented in n8n as deliberate, which means they are the ones most likely to be quietly
 * "fixed" by someone reading the code later. A test can hold them still.
 *
 * The rules, and the row of §1.4 each one is:
 *
 * - **E5** — an agent that was busy, or a bench we could not claim, **restores the subject
 *   untouched**: no try burned, no last-run stamped. Nothing was attempted, so nothing about
 *   the subject was learned. This is principle 5, and it is the rule that keeps an
 *   infrastructure outage from parking thirteen innocent apps.
 * - **E6** — `max_tries` consecutive errors parks the subject for `stuck_days`.
 * - **E7** — every other completion stamps the finish time, *including* an errored one. That
 *   is deliberate: without it an app that errors reliably starves every other app, because it
 *   would stay the stalest row forever and win the pick on every tick.
 *
 * Note what is *not* here. The verdict, tier and risk are the assay's own declaration and
 * live in its frontmatter; "last run" is the newest completed assay in the archive. This file
 * only touches scheduling state, which is why an errored assay still writes a report file
 * (status `done`) while a blocked one writes `blocked` and so never counts as a last run.
 */

import type { SchedulerConstants, SubjectSchedule } from './policy.js';

/**
 * How an attempt ended, from the scheduler's point of view.
 *
 * `verdict` covers every outcome the *subject* earned — compliant, non-compliant, and an
 * assay that ran and declared itself errored. `error` is the attempt failing to produce one.
 */
export type Outcome =
  /** The assay produced a verdict about the subject. */
  | { kind: 'verdict' }
  /** The attempt failed: the agent errored, the response would not parse, the run died. */
  | { kind: 'error'; reason: string }
  /** The agent was busy (409) — someone else's PR review had it. Costs nothing. */
  | { kind: 'agent_busy' }
  /** No bench could be claimed. Costs nothing, by principle 5. */
  | { kind: 'blocked'; reason: string };

export interface RecordInput {
  now: Date;
  constants: SchedulerConstants;
  subject: string;
  outcome: Outcome;
  schedule: SubjectSchedule | undefined;
}

export interface RecordResult {
  /** The subject's new scheduling state. */
  schedule: SubjectSchedule;
  /** Whether the global cooldown anchor moves. False for the two free outcomes. */
  stampsFinish: boolean;
  /** True when this attempt exhausted `max_tries`. */
  parked: boolean;
  /** One clause for the log, in the scheduler's own words. */
  note: string;
}

export function recordResult(input: RecordInput): RecordResult {
  const { constants, now, outcome } = input;
  const previous = input.schedule ?? { try_n: 0 };
  // The attempt number this claim was issued under. Falling back to `try_n + 1` covers a
  // result arriving for a claim that was already reclaimed — the count still has to make
  // sense, and pretending it was attempt 1 would reset the parking clock.
  const attempt = previous.claim?.try_n ?? previous.try_n + 1;

  if (outcome.kind === 'agent_busy' || outcome.kind === 'blocked') {
    return {
      // Claim released, everything else exactly as it was. `try_n` is *not* `attempt`:
      // the attempt never happened.
      schedule: { ...previous, claim: undefined },
      stampsFinish: false,
      parked: false,
      note:
        outcome.kind === 'agent_busy'
          ? 'the agent was busy, so the subject keeps its try'
          : `blocked (${outcome.reason}), so the subject keeps its try`,
    };
  }

  if (outcome.kind === 'error') {
    const parked = attempt >= constants.max_tries;
    return {
      schedule: {
        try_n: attempt,
        parked_at: parked ? now.toISOString() : previous.parked_at,
        claim: undefined,
        // Carried, never cleared here — see the verdict branch below.
        flagged_at: previous.flagged_at,
      },
      stampsFinish: true,
      parked,
      note: parked
        ? `parked after ${attempt} failed attempts`
        : `attempt ${attempt} of ${constants.max_tries} failed`,
    };
  }

  return {
    // A verdict clears the slate: the error streak is over and any park with it.
    //
    // The re-audit flag is deliberately *not* cleared, by this branch or any other. It is a
    // timestamp that stops counting once a later attempt exists (`isFlaggedForReaudit`), and
    // a finisher clearing it eagerly would eat the one case the timestamp exists for: a flag
    // set at 10:05 while a run that started at 10:00 was still going is asking for the next
    // look, and this code cannot tell those two apart. The comparison can.
    schedule: { try_n: 0, parked_at: undefined, claim: undefined, flagged_at: previous.flagged_at },
    stampsFinish: true,
    parked: false,
    note: 'assay completed',
  };
}

/** The claim written when a target is picked — n8n's `Mark in-progress`, row C1. */
export function openClaim(input: {
  now: Date;
  schedule: SubjectSchedule | undefined;
}): SubjectSchedule {
  const previous = input.schedule ?? { try_n: 0 };
  return {
    ...previous,
    // C2: the finish time is deliberately NOT stamped here. Stamping at claim time makes a
    // run that crashes look freshly audited, and the subject drops out of the backlog for a
    // week having produced nothing.
    claim: { since: input.now.toISOString(), try_n: previous.try_n + 1 },
  };
}
