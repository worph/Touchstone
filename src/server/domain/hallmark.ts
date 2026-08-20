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

import { asSubjectKey, splitSubjectKey, type SubjectKey } from '../../shared/subject.js';
import type { AssayMeta, AssayRecord, Section, SubjectState } from '../../shared/types.js';

/**
 * The two sections the Overview still draws a column for.
 *
 * Not the set of sections that exists — that comes from the archive and from the protocol
 * files, and `subjectHallmark` composes whatever it finds. This list is only what the
 * two-column table asks for by name, and it goes when the table learns to draw N.
 */
export const LEGS: readonly Section[] = ['static', 'functional'];

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
  leg: Section;
  /** Newest assay of any status — blocked and running included. */
  current: AssayRecord | null;
  /** Newest `done` assay: the last verdict actually issued. */
  hallmark: AssayRecord | null;
  /** True when a non-done assay is newer than the last verdict. */
  stale: boolean;
}

export function legState(records: readonly AssayRecord[], leg: Section): LegState {
  const forLeg = sortNewestFirst(records.filter((r) => r.meta.section === leg));
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
  legs: Record<Section, LegState>;
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
  key: string,
  records: readonly AssayRecord[],
  options: HallmarkOptions = {},
): SubjectHallmark {
  const now = options.now === undefined ? Date.now() : Number(options.now);
  // `key` is `<origin>~<name>`, so this filter separates two stores' same-named apps without
  // knowing anything about origins. That is the whole reason identity is one opaque string.
  const name = asSubjectKey(key);
  const mine = records.filter((r) => r.subject === name);

  // Whatever sections this subject actually has, plus the two the table names — so a subject
  // with no functional assay still gets an (empty) functional cell, and a subject carrying a
  // section nobody has heard of still has its risk counted.
  const ids = [...new Set([...LEGS, ...mine.map((r) => r.meta.section)])];
  const legs: Record<Section, LegState> = {};
  for (const id of ids) legs[id] = legState(mine, id);

  let risk = 0;
  let newestDone: number | null = null;
  const current: Record<Section, AssayRecord | null> = {};
  for (const id of ids) {
    const state = legs[id]!;
    current[id] = state.current;
    const done = state.hallmark;
    if (!done) continue;
    risk += Number(done.meta.risk_score) || 0;
    const t = assayTime(done.meta);
    if (newestDone === null || t > newestDone) newestDone = t;
  }

  return {
    legs,
    state: {
      name,
      // Split from the key rather than read off `mine[0]`, so a subject with no assay yet —
      // the never-run rows the Overview still has to draw — gets an origin and a label too.
      origin: splitSubjectKey(name).origin,
      label: splitSubjectKey(name).name,
      sections: current,
      static: legs.static?.current ?? null,
      functional: legs.functional?.current ?? null,
      risk,
      age_days: newestDone === null ? null : Math.max(0, Math.floor((now - newestDone) / DAY_MS)),
    },
  };
}

/** Every distinct subject in the archive, as `<origin>~<name>` keys, alphabetical. */
export function subjectNames(records: readonly AssayRecord[]): SubjectKey[] {
  return [...new Set(records.map((r) => r.subject))].sort((a, b) => a.localeCompare(b));
}

/** The Overview table: one row per subject, risk descending, label as the tiebreak. */
export function hallmarks(
  records: readonly AssayRecord[],
  options: HallmarkOptions = {},
): SubjectState[] {
  return subjectNames(records)
    .map((name) => subjectHallmark(name, records, options).state)
    .sort((a, b) => b.risk - a.risk || a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
}

/** The latest `done` assay for one section — the hallmark proper. */
export function latestDone(
  records: readonly AssayRecord[],
  subject: string,
  leg: Section,
): AssayRecord | null {
  return legState(
    records.filter((r) => r.subject === subject),
    leg,
  ).hallmark;
}
