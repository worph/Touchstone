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
import type {
  AssayMeta,
  AssayRecord,
  Section,
  StandardState,
  SubjectState,
  SubjectVersionState,
} from '../../shared/types.js';
import type { Standards } from './standards.js';

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
  /**
   * The standard in force, per section — `domain/standards.ts`.
   *
   * Passed in rather than read, because this file is pure over records and has to stay that
   * way: the tests pin an archive and a clock, and a composer that opened the protocol
   * directory could not be one of them. Absent means the question is not being asked, and
   * every row comes back with no `standard` at all rather than with a guess.
   */
  standards?: Standards;
  /**
   * The version of each subject the store offers now — `SubjectRegistry.versions()`, keyed by
   * `<origin>~<name>`.
   *
   * Passed in for the same reason `standards` is: this file stays pure over records, and a
   * composer that reached for the registry could not be replayed from a fixture. Absent means
   * the question is not being asked and no row comes back with a `subject_version`.
   */
  versions?: Record<string, string>;
}

/**
 * How one section's last verdict relates to the standard in force.
 *
 * Reads the **`done`** record, never `current`: the badge qualifies the verdict a person is
 * looking at, and a blocked assay has no verdict to qualify. Null when there is nothing to
 * say — no verdict yet, no rubric under that name any more (a retired section must not
 * strand a row as permanently out of date), or a reading rather than a judgement.
 */
export function standardStateOf(state: LegState, standards: Standards): StandardState | null {
  const done = state.hallmark;
  if (!done) return null;
  if (done.meta.scores === false) return null;
  const want = standards[state.leg];
  if (!want) return null;
  const had = done.meta.standard_sha256;
  if (typeof had !== 'string' || had === '') return 'unknown';
  if (had !== want.sha256) return 'older';
  // A scripted section has two versions and one of them is the procedure. An operator who
  // moves a threshold in the `.sh` has changed what the reading means just as surely as an
  // edit to the prose beside it, and the assay records both hashes for this comparison.
  if (done.meta.executor && done.meta.executor_sha256 !== want.executor_sha256) return 'older';
  return 'current';
}

/**
 * How the app a subject's verdicts were reached about relates to the app on offer now.
 *
 * Reads the newest **`done`** record of any section — the verdicts on display were all
 * reached in one run against one version, so one comparison answers for the row. Null when
 * there is nothing to say, and `unknown` rather than `changed` whenever either side is
 * missing: an app the store offers no compose for, or an assay written before this was
 * recorded, is not evidence that anything moved. That asymmetry is the whole safeguard —
 * `unknown` must never make a subject eligible, or every app in the archive would go eligible
 * the day this ships and stay so until audited.
 */
export function subjectVersionOf(
  records: readonly AssayRecord[],
  offered: string | undefined,
): SubjectVersionState | null {
  const done = sortNewestFirst(records.filter(isDone))[0];
  if (!done) return null;
  // Coerced rather than type-checked, because YAML will hand back a **number** for a sha that
  // happens to be all digits — `0000…0` parses as `0` — and a stricter read would then answer
  // `unknown` for an app that had in fact changed. Vanishingly rare for a 40-hex-digit blob
  // sha, and silent in exactly the direction that hides a real difference, which is the kind
  // of edge worth one line rather than a comment saying it cannot happen.
  const raw = done.meta.subject_sha;
  const had = raw === undefined || raw === null ? '' : String(raw);
  if (had === '' || !offered) return 'unknown';
  return had === offered ? 'current' : 'changed';
}

/** Worst wins: one section judged by an older rubric qualifies the whole row. */
function rollUp(states: readonly StandardState[]): StandardState | undefined {
  if (states.length === 0) return undefined;
  if (states.includes('older')) return 'older';
  if (states.includes('unknown')) return 'unknown';
  return 'current';
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
  const standardStates: StandardState[] = [];
  for (const id of ids) {
    const state = legs[id]!;
    current[id] = state.current;
    if (options.standards) {
      const standard = standardStateOf(state, options.standards);
      if (standard) standardStates.push(standard);
    }
    const done = state.hallmark;
    if (!done) continue;
    // A section that measures rather than judges is invisible here, and both halves matter.
    // Summing its risk would re-rank the Overview by something that is not non-compliance;
    // letting it set `newestDone` would be worse — a cheap six-second reading would stamp the
    // subject as freshly *audited*, and the age column is what an operator reads to know how
    // stale a verdict is. `scores: false` is written by the executor onto the record, so this
    // needs nothing but the frontmatter it already has.
    if (done.meta.scores === false) continue;
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
      ...(rollUp(standardStates) ? { standard: rollUp(standardStates) } : {}),
      ...(options.versions
        ? (() => {
            const v = subjectVersionOf(mine, options.versions![name]);
            return v ? { subject_version: v } : {};
          })()
        : {}),
    },
  };
}

/** Every distinct subject in the archive, as `<origin>~<name>` keys, alphabetical. */
export function subjectNames(records: readonly AssayRecord[]): SubjectKey[] {
  return [...new Set(records.map((r) => r.subject))].sort((a, b) => a.localeCompare(b));
}

export interface BoardOptions extends HallmarkOptions {
  /**
   * Subjects to compose even though the archive holds nothing for them.
   *
   * The archive is the record of what has been *judged*; the registry is the list of what is
   * *tracked*. For most of this app's life those were the same question, because a page that
   * ranks by risk has nothing to say about a row with no risk. The Store page asks the other
   * one — "what is in the store, and what do we know about it" — and 52 of 72 apps having
   * never been audited is precisely the answer it exists to give, so those rows cannot come
   * from the archive.
   *
   * `subjectHallmark(key, [])` already composes a never-run row (it splits origin and label
   * off the key rather than reading them off a record), so this needs no second code path:
   * it only widens the list of names.
   *
   * Deliberately an option rather than the default. `/public` calls `hallmarks(store.all())`
   * and must keep showing the archive alone — a board addressed to app authors that lists
   * every app we have not got to yet is a backlog with somebody else's name on it.
   */
  include?: readonly string[];
}

/** The Store table: one row per subject, risk descending, label as the tiebreak. */
export function hallmarks(
  records: readonly AssayRecord[],
  options: BoardOptions = {},
): SubjectState[] {
  const names = [...new Set([...subjectNames(records), ...(options.include ?? [])])].sort((a, b) =>
    a.localeCompare(b),
  );
  return names
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
