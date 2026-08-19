/**
 * Reading n8n's scheduling state out of its own roll-up — shadow mode's missing half.
 *
 * **The problem this exists to solve, found by running the scheduler rather than by reading
 * it.** A dry-run tick derives the pick from the archive plus our own `schedule.json`. In
 * shadow mode we never run an audit, so we never record a result, so our try counts and our
 * parks stay empty forever — while n8n's are the very thing constraining its choice. The
 * first live tick made the gap obvious: Touchstone counted a backlog of 69 where n8n counted
 * 32, because roughly thirty subjects are parked in n8n's rows and we had no way to know.
 *
 * A diff between two systems where one is missing an input is not a diff, it is noise. So
 * during the transition Touchstone reads the same state n8n keeps, out of the same place n8n
 * keeps it: the prose in the roll-up's Result column.
 *
 *   `⚠️ errored · try 2`               → two consecutive failures, still retriable
 *   `⚠️ errored · stuck after 3 tries` → parked
 *   `⏳ in progress · try 1 · since T` → claimed, and by *n8n*, not by us
 *
 * Adopted state is a fallback, never an override: anything Touchstone has recorded itself
 * wins, so arming the scheduler quietly transfers authority instead of needing a switch.
 * When the roll-up goes away with Docmost at M5, this file goes with it.
 */

import type { SubjectSchedule } from './policy.js';

export interface RollupScheduleRow {
  subject: string;
  /** The Result cell, verbatim. */
  raw: string;
  /** The Last run cell — the park clock runs from here, exactly as n8n measures it. */
  lastRun: string | null;
}

export interface AdoptedSchedule {
  try_n: number;
  parked_at?: string;
  /** n8n holds a claim on this subject. We do not adopt it; we only report it. */
  theirClaimSince?: string;
}

/** `⚠️ errored · try 2` → 2. Absent means zero, not one. */
function tryOf(raw: string): number {
  const m = /try\s*(\d+)/i.exec(raw);
  return m ? Number.parseInt(m[1]!, 10) || 0 : 0;
}

export function readRollupSchedule(row: RollupScheduleRow): AdoptedSchedule | null {
  const raw = String(row.raw ?? '');
  if (!raw) return null;

  if (raw.includes('⏳')) {
    const since = /since\s+(\S+)/i.exec(raw)?.[1];
    return { try_n: tryOf(raw), theirClaimSince: since };
  }

  const errored = raw.includes('⚠');
  if (!errored) {
    // A verdict clears the streak, which is the same thing `recordResult` does.
    return { try_n: 0 };
  }

  if (/stuck/i.test(raw)) {
    // n8n releases a stuck subject `STUCK_DAYS` after its **last run**, not after it was
    // parked — there is nowhere in the row to record a park time. Measuring from the same
    // field is what keeps the release tick identical in both systems.
    return { try_n: tryOf(raw) || 3, parked_at: row.lastRun ? `${row.lastRun}T00:00:00Z` : undefined };
  }

  return { try_n: tryOf(raw) };
}

/**
 * Merge what the roll-up says into what we know, ours winning.
 *
 * `ours` is mutated-by-copy: the result is a new record, so a caller holding the old one
 * still sees the old one.
 */
export function adoptRollupSchedule(
  ours: Record<string, SubjectSchedule>,
  rows: readonly RollupScheduleRow[],
): { schedule: Record<string, SubjectSchedule>; adopted: string[]; theirClaims: string[] } {
  const out: Record<string, SubjectSchedule> = { ...ours };
  const adopted: string[] = [];
  const theirClaims: string[] = [];

  for (const row of rows) {
    const read = readRollupSchedule(row);
    if (!read) continue;
    if (read.theirClaimSince !== undefined) {
      // An attempt n8n has in flight has not produced an outcome yet, so its `try N` is not
      // a failure count. Adopting it would credit the subject with a failure it has not had
      // and walk it toward parking early — found by a test, not by reading.
      theirClaims.push(row.subject);
      continue;
    }

    const mine = out[row.subject];
    // Ours wins the moment we have recorded anything of our own — a claim, a streak or a
    // park that *we* wrote. State we adopted earlier does not count as ours: a later import
    // has to be able to correct it, or the first adoption freezes a subject at whatever the
    // page said that day.
    const oursToKeep = mine && !mine.from_rollup && (mine.claim || mine.try_n > 0 || mine.parked_at);
    if (oursToKeep) continue;
    if (read.try_n === 0 && !read.parked_at) {
      // The row is clean now. Drop any adopted state for it rather than leaving a stale
      // streak behind — a subject n8n has since audited successfully is not still failing.
      if (mine?.from_rollup) {
        delete out[row.subject];
        adopted.push(row.subject);
      }
      continue;
    }

    out[row.subject] = { try_n: read.try_n, parked_at: read.parked_at, from_rollup: true };
    adopted.push(row.subject);
  }

  return { schedule: out, adopted, theirClaims };
}
