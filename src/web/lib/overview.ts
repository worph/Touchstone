/** Tallies, filtering and sorting for the Overview table. Pure functions. */
import type { AssayRecord, Leg, Section, SubjectState } from '@shared/types';
import { SEVERITY_RANK } from '@shared/types';
import type { Coverage } from '@shared/types';
import type { DisplayState, ShowFilter, SortKey, StateKind } from '../types';
import { displayState, runningState } from './status';
import { readingRank } from './reading';

/** A verdict older than FRESH_DAYS makes a subject eligible again (ARCHITECTURE §2). */
export const FRESH_DAYS = 7;

/**
 * The audit in flight, as this table needs it.
 *
 * Overlaid rather than stored: the runner writes a report file when it has a verdict, so
 * there is no record of a run still in progress and there should not be one. Every derivation
 * below therefore takes it as an argument — the alternative is a table that shows a subject
 * exactly as it was before you asked for the audit you are waiting on.
 */
export interface LiveRun {
  subject: string;
  /** Which sections this run is actually producing. A skipped section is not among them. */
  legs: Section[];
  started_at: string;
  /** What to put in the cell's note instead of the elapsed time — `7/24`. */
  note?: string;
}

/**
 * What a leg looks like, the run in flight included.
 *
 * Everything on this page — the cells, the tallies, the filters — goes through here, so the
 * overlay cannot apply to one of them and not the others.
 */
export function legState(s: SubjectState, leg: Section, live?: LiveRun | null): DisplayState {
  if (live && live.subject === s.name && live.legs.includes(leg)) {
    return runningState(live.started_at, live.note);
  }
  return displayState(s.sections?.[leg] ?? null);
}

export interface LegTally {
  compliant: number;
  failing: number;
  blocked: number;
  running: number;
  notRun: number;
  errored: number;
}

export interface Tallies {
  subjects: number;
  static: LegTally;
  functional: LegTally;
  /** What the assays actually scored. */
  risk: number;
}

const emptyLeg = (): LegTally => ({
  compliant: 0, failing: 0, blocked: 0, running: 0, notRun: 0, errored: 0,
});

function tallyLeg(into: LegTally, s: DisplayState): void {
  switch (s.kind) {
    case 'ok': into.compliant++; break;
    case 'fail': into.failing++; break;
    case 'blocked': into.blocked++; break;
    case 'running': into.running++; break;
    case 'errored': into.errored++; break;
    default: into.notRun++;
  }
}

export function tally(subjects: SubjectState[], live?: LiveRun | null): Tallies {
  const t: Tallies = {
    subjects: subjects.length,
    static: emptyLeg(),
    functional: emptyLeg(),
    risk: 0,
  };
  for (const s of subjects) {
    tallyLeg(t.static, legState(s, 'static', live));
    tallyLeg(t.functional, legState(s, 'functional', live));
    t.risk += s.risk;
  }
  return t;
}

/** Worst-first, for sorting by a status column. */
export function stateRank(rec: AssayRecord | null): number {
  const s = displayState(rec);
  switch (s.kind) {
    case 'fail': return 10 + SEVERITY_RANK[s.severity];
    case 'errored': return 9;
    case 'running': return 4;
    case 'blocked': return 3;
    case 'deferred': return 2;
    case 'none': return 1;
    case 'ok': return 0;
  }
}

export function isStale(s: SubjectState): boolean {
  return s.age_days == null || s.age_days >= FRESH_DAYS;
}

function legsOf(leg: 'any' | Leg): Leg[] {
  if (leg === 'static') return ['static'];
  if (leg === 'functional') return ['functional'];
  return ['static', 'functional'];
}

function matchesKind(
  s: SubjectState,
  leg: 'any' | Leg,
  kinds: StateKind[],
  live?: LiveRun | null,
): boolean {
  return legsOf(leg).some((l) => kinds.includes(legState(s, l, live).kind));
}

export function applyShow(
  s: SubjectState,
  show: ShowFilter,
  leg: 'any' | Leg,
  live?: LiveRun | null,
): boolean {
  switch (show) {
    case 'all': return true;
    case 'failing': return matchesKind(s, leg, ['fail'], live);
    case 'compliant': return matchesKind(s, leg, ['ok'], live);
    case 'blocked': return matchesKind(s, leg, ['blocked'], live);
    case 'running': return matchesKind(s, leg, ['running'], live);
    case 'not-run': return matchesKind(s, leg, ['none'], live);
    case 'stale': return isStale(s);
  }
}

export function search(s: SubjectState, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  // The label first, because that is what somebody types. The key too, so `yundera~` narrows
  // to one store once there is more than one.
  if (s.label.toLowerCase().includes(needle)) return true;
  if (s.name.toLowerCase().includes(needle)) return true;
  for (const rec of Object.values(s.sections ?? {})) {
    if (rec?.meta.subject_ref?.toLowerCase().includes(needle)) return true;
    if (rec?.meta.images?.some((i) => i.toLowerCase().includes(needle))) return true;
    if (rec?.meta.commit?.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/**
 * A subject's coverage, summed across its sections.
 *
 * Summing is right because the partition is real: each requirement is recorded against the
 * section whose protocol listed it, so no item is counted twice. A section that was never
 * attempted simply contributes nothing, which is what makes a subject with a blocked section
 * read as partly checked rather than as fully checked or not checked at all.
 */
export function coverageOf(s: SubjectState): Coverage | undefined {
  const parts = Object.values(s.sections ?? {})
    .map((rec) => rec?.meta.coverage)
    .filter(Boolean) as Coverage[];
  if (parts.length === 0) return undefined;
  return parts.reduce((sum, c) => ({
    verified: sum.verified + c.verified,
    applicable: sum.applicable + c.applicable,
    passed: sum.passed + c.passed,
    failed: sum.failed + c.failed,
    unverified: sum.unverified + c.unverified,
    not_applicable: sum.not_applicable + c.not_applicable,
    risk: sum.risk + c.risk,
  }));
}

/**
 * Is there anything to brief anyone on?
 *
 * Not "is it non-compliant": an assay imported before the ledger existed has a verdict and no
 * recorded requirements, and a fix report built from that is a page of headings with nothing
 * under them. So the question is whether the audit wrote down something actionable — a failing
 * requirement, or a phase that did not pass.
 *
 * Every section, not a named two: a rubric added tomorrow contributes its failures here without
 * this function learning its name.
 */
export function hasFixWork(s: SubjectState): boolean {
  return Object.values(s.sections ?? {}).some(
    (rec) =>
      (rec?.meta.requirements ?? []).some((r) => r.verdict === 'fail') ||
      (rec?.meta.phases ?? []).some((p) => p.result === 'fail' || p.result === 'errored'),
  );
}

/** `-1` for "no coverage at all", so unmeasured subjects sort apart from fully-verified ones. */
function coverageRatio(s: SubjectState): number {
  const c = coverageOf(s);
  if (!c || c.applicable === 0) return -1;
  return c.verified / c.applicable;
}

export function sortSubjects(
  rows: SubjectState[],
  key: SortKey,
  dir: 'asc' | 'desc',
): SubjectState[] {
  const sign = dir === 'asc' ? 1 : -1;
  const cmp = (a: SubjectState, b: SubjectState): number => {
    switch (key) {
      case 'name':
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      case 'age': {
        // never assayed sorts as infinitely old — it is the oldest thing there is
        const av = a.age_days ?? Number.POSITIVE_INFINITY;
        const bv = b.age_days ?? Number.POSITIVE_INFINITY;
        return av - bv;
      }
      case 'static':
        return stateRank(a.static) - stateRank(b.static);
      case 'functional':
        return stateRank(a.functional) - stateRank(b.functional);
      case 'coverage': {
        // Least-checked first when ascending: the interesting end of this column is the
        // assay that could not answer, not the one that answered everything.
        const av = coverageRatio(a);
        const bv = coverageRatio(b);
        return av - bv;
      }
      case 'risk':
        return a.risk - b.risk;
      default:
        // `notice:<section>` — worst reading last when ascending, so descending (the default
        // direction on every column here) puts the app furthest behind at the top.
        if (key.startsWith('notice:')) {
          const id = key.slice('notice:'.length);
          return readingRank(a, id) - readingRank(b, id);
        }
        return a.risk - b.risk;
    }
  };
  return [...rows].sort((a, b) => sign * cmp(a, b) || a.name.localeCompare(b.name));
}

/**
 * Assays carrying no verdict because something in the environment stopped them.
 *
 * **This is the archive's view, and the archive is history.** A blocked record says "the last
 * time anybody looked, there was no bench" — it does not say the pool is down *now*, and it
 * stays true until something re-assays that section. The live condition is `GET /alerts`,
 * which is fetched, deduplicated and closes itself when the prober succeeds again.
 *
 * Conflating the two is what made the Overview announce "Bench pool unavailable — paused
 * 4h 31m" over a healthy pool, contradicting the Activity page one click away. So this
 * returns a *backlog*: who is affected and since when, in the past tense, and the page shows
 * the alert instead whenever there is a live one.
 *
 * `live` is subtracted for the same reason one layer down: a section being re-assayed *right
 * now* is not outstanding work, and telling the reader "a re-assay clears it" beside a cell
 * that already reads `◴ running` is the same tense error in miniature.
 */
export interface BlockedBacklog {
  reason: string;
  count: number;
  /** Oldest blocked assay — how long this has been outstanding. */
  since: string | null;
  /** Who is affected, so nobody has to scan the table to find out. */
  items: { subject: string; section: Section }[];
}

export function deriveBacklog(
  subjects: SubjectState[],
  live?: LiveRun | null,
): BlockedBacklog | null {
  const byReason = new Map<string, { count: number; since: string | null; items: { subject: string; section: Section }[] }>();
  for (const s of subjects) {
    for (const [section, rec] of Object.entries(s.sections ?? {})) {
      if (rec?.meta.status !== 'blocked') continue;
      // Already being answered. The cell says `running`; the note would say "re-assay it".
      if (live && live.subject === s.name && live.legs.includes(section)) continue;
      const reason = rec.meta.blocked_reason ?? 'unknown';
      const entry = byReason.get(reason) ?? { count: 0, since: null, items: [] };
      entry.count++;
      entry.items.push({ subject: s.name, section });
      if (!entry.since || rec.meta.started_at < entry.since) entry.since = rec.meta.started_at;
      byReason.set(reason, entry);
    }
  }
  let top: BlockedBacklog | null = null;
  for (const [reason, e] of byReason) {
    if (!top || e.count > top.count) top = { reason, count: e.count, since: e.since, items: e.items };
  }
  return top;
}
