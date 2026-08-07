/**
 * The hallmark: the current conformance state of every subject, derived from the archive.
 *
 * ARCHITECTURE.md §4 lists `hallmark` as a view — "latest done assay per (subject, leg),
 * composed". The subtlety is what happens when the newest assay for a leg is NOT done:
 *
 *   - `blocked` and `running` are not verdicts and never become the hallmark.
 *   - A leg whose newest assay is blocked reads as **blocked**. It must not fall back to
 *     the previous `done` assay and present that verdict as if it were current — that is
 *     ARCHITECTURE.md §2.4, infra failure recorded as subject state, inverted.
 *
 * So each leg has two records, and they are not the same record:
 *   `current`  — newest assay of any status; what the status cell renders.
 *   `hallmark` — newest `done` assay; the last real verdict, and what risk and age use.
 */

import type { AssayMeta, AssayRecord, Leg, SubjectState } from '../../shared/types.js';

export const LEGS: readonly Leg[] = ['static', 'functional'];

const DAY_MS = 86_400_000;

/**
 * When an assay happened. `finished_at` when it has one, else `started_at` — a blocked or
 * running assay may have no finish time. Unparseable timestamps sort oldest.
 */
export function assayTime(meta: AssayMeta): number {
  for (const value of [meta.finished_at, meta.started_at]) {
    if (typeof value !== 'string' || value === '') continue;
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

/** Newest first. Ties break on path so the order is stable across boots. */
export function byNewest(a: AssayRecord, b: AssayRecord): number {
  const delta = assayTime(b.meta) - assayTime(a.meta);
  return delta !== 0 ? delta : b.path.localeCompare(a.path);
}

export function sortNewestFirst(records: readonly AssayRecord[]): AssayRecord[] {
  return [...records].sort(byNewest);
}

export function isDone(record: AssayRecord): boolean {
  return record.meta.status === 'done';
}

export interface LegState {
  leg: Leg;
  /** Newest assay of any status — blocked and running included. */
  current: AssayRecord | null;
  /** Newest `done` assay: the last verdict actually issued. */
  hallmark: AssayRecord | null;
  /** True when a non-done assay is newer than the last verdict. */
  stale: boolean;
}

export function legState(records: readonly AssayRecord[], leg: Leg): LegState {
  const forLeg = sortNewestFirst(records.filter((r) => r.meta.leg === leg));
  const current = forLeg[0] ?? null;
  const hallmark = forLeg.find(isDone) ?? null;
  return {
    leg,
    current,
    hallmark,
    stale: current !== null && !isDone(current) && hallmark !== null,
  };
}

export interface SubjectHallmark {
  state: SubjectState;
  legs: Record<Leg, LegState>;
}

export interface HallmarkOptions {
  /** Reference point for `age_days`. Defaults to now; tests pin it. */
  now?: Date | number;
}

/**
 * Compose one subject's row.
 *
 * `SubjectState.static` / `.functional` hold the **current** record, so a blocked leg
 * renders as blocked rather than as a stale verdict. `risk` and `age_days` are taken from
 * the last `done` assay of each leg: the findings behind a score stay open until something
 * re-assays them, and a bench outage is not a reason to drop a subject down the backlog.
 * A subject that has never completed an assay has `age_days: null` (the UI's `—`).
 */
export function subjectHallmark(
  name: string,
  records: readonly AssayRecord[],
  options: HallmarkOptions = {},
): SubjectHallmark {
  const now = options.now === undefined ? Date.now() : Number(options.now);
  const mine = records.filter((r) => r.subject === name);
  const legs = {
    static: legState(mine, 'static'),
    functional: legState(mine, 'functional'),
  } satisfies Record<Leg, LegState>;

  let risk = 0;
  let newestDone: number | null = null;
  for (const leg of LEGS) {
    const done = legs[leg].hallmark;
    if (!done) continue;
    risk += Number(done.meta.risk_score) || 0;
    const t = assayTime(done.meta);
    if (newestDone === null || t > newestDone) newestDone = t;
  }

  return {
    legs,
    state: {
      name,
      static: legs.static.current,
      functional: legs.functional.current,
      risk,
      age_days: newestDone === null ? null : Math.max(0, Math.floor((now - newestDone) / DAY_MS)),
    },
  };
}

/** Every distinct subject in the archive, alphabetical. */
export function subjectNames(records: readonly AssayRecord[]): string[] {
  return [...new Set(records.map((r) => r.subject))].sort((a, b) => a.localeCompare(b));
}

/** The Overview table: one row per subject, risk descending, name as the tiebreak. */
export function hallmarks(
  records: readonly AssayRecord[],
  options: HallmarkOptions = {},
): SubjectState[] {
  return subjectNames(records)
    .map((name) => subjectHallmark(name, records, options).state)
    .sort((a, b) => b.risk - a.risk || a.name.localeCompare(b.name));
}

/** The latest `done` assay for one leg — the hallmark proper. */
export function latestDone(
  records: readonly AssayRecord[],
  subject: string,
  leg: Leg,
): AssayRecord | null {
  return legState(
    records.filter((r) => r.subject === subject),
    leg,
  ).hallmark;
}

/**
 * The set the Findings page is computed over — one assay per (subject, leg), the current
 * one. An older assay's findings are history, not current state.
 *
 * Normally that is the latest `done` assay. A blocked or running assay that nonetheless
 * recorded findings is preferred over the older verdict, because those observations *are*
 * current: this is how a partial run's `unverified` rows reach the suspected-Critical
 * queue. A blocked assay with no findings contributes nothing and the last verdict stands.
 */
export function latestAssays(records: readonly AssayRecord[]): AssayRecord[] {
  const out: AssayRecord[] = [];
  for (const name of subjectNames(records)) {
    const { legs } = subjectHallmark(name, records);
    for (const leg of LEGS) {
      const { current, hallmark } = legs[leg];
      const partial = current && !isDone(current) && (current.meta.findings?.length ?? 0) > 0;
      const pick = partial ? current : (hallmark ?? null);
      if (pick) out.push(pick);
    }
  }
  return out;
}
