/** Tallies, filtering and sorting for the Overview table. Pure functions. */
import type { AssayRecord, Leg, SubjectState } from '@shared/types';
import { SEVERITY_RANK } from '@shared/types';
import type { Coverage } from '@shared/types';
import type { ShowFilter, SortKey, StateKind } from '../types';
import { displayState } from './status';

/** A verdict older than FRESH_DAYS makes a subject eligible again (ARCHITECTURE §2). */
export const FRESH_DAYS = 7;

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

function tallyLeg(into: LegTally, rec: AssayRecord | null): void {
  const s = displayState(rec);
  switch (s.kind) {
    case 'ok': into.compliant++; break;
    case 'fail': into.failing++; break;
    case 'blocked': into.blocked++; break;
    case 'running': into.running++; break;
    case 'errored': into.errored++; break;
    default: into.notRun++;
  }
}

export function tally(subjects: SubjectState[]): Tallies {
  const t: Tallies = {
    subjects: subjects.length,
    static: emptyLeg(),
    functional: emptyLeg(),
    risk: 0,
  };
  for (const s of subjects) {
    tallyLeg(t.static, s.static);
    tallyLeg(t.functional, s.functional);
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

function legsOf(s: SubjectState, leg: 'any' | Leg): (AssayRecord | null)[] {
  if (leg === 'static') return [s.static];
  if (leg === 'functional') return [s.functional];
  return [s.static, s.functional];
}

function matchesKind(s: SubjectState, leg: 'any' | Leg, kinds: StateKind[]): boolean {
  return legsOf(s, leg).some((r) => kinds.includes(displayState(r).kind));
}

export function applyShow(s: SubjectState, show: ShowFilter, leg: 'any' | Leg): boolean {
  switch (show) {
    case 'all': return true;
    case 'failing': return matchesKind(s, leg, ['fail']);
    case 'compliant': return matchesKind(s, leg, ['ok']);
    case 'blocked': return matchesKind(s, leg, ['blocked']);
    case 'running': return matchesKind(s, leg, ['running']);
    case 'not-run': return matchesKind(s, leg, ['none']);
    case 'stale': return isStale(s);
  }
}

export function search(s: SubjectState, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (s.name.toLowerCase().includes(needle)) return true;
  for (const rec of [s.static, s.functional]) {
    if (rec?.meta.subject_ref?.toLowerCase().includes(needle)) return true;
    if (rec?.meta.images?.some((i) => i.toLowerCase().includes(needle))) return true;
    if (rec?.meta.commit?.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/**
 * A subject's coverage, taking the better-covered leg.
 *
 * Two legs, and only one of them may have been checked — a static-only run leaves the
 * functional leg with none at all. Summing them would make a subject look half-checked when
 * it was fully checked at the depth it was run.
 */
export function coverageOf(s: SubjectState): Coverage | undefined {
  const legs = [s.static?.meta.coverage, s.functional?.meta.coverage].filter(Boolean) as Coverage[];
  if (legs.length === 0) return undefined;
  return legs.reduce((best, c) => (c.applicable > best.applicable ? c : best));
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
      default:
        return a.risk - b.risk;
    }
  };
  return [...rows].sort((a, b) => sign * cmp(a, b) || a.name.localeCompare(b.name));
}

/**
 * The environment banner is derived, not fetched: the alerts endpoint arrives with the
 * prober in P2, but a wall of `blocked` assays sharing one `blocked_reason` *is* the
 * condition, and hiding it until then would leave the page's most important fact
 * unexplained.
 */
export interface DerivedIncident {
  reason: string;
  count: number;
  /** Oldest still-blocked assay — how long the queue has been paused. */
  since: string | null;
}

export function deriveIncident(subjects: SubjectState[]): DerivedIncident | null {
  const byReason = new Map<string, { count: number; since: string | null }>();
  for (const s of subjects) {
    for (const rec of [s.static, s.functional]) {
      if (rec?.meta.status !== 'blocked') continue;
      const reason = rec.meta.blocked_reason ?? 'unknown';
      const entry = byReason.get(reason) ?? { count: 0, since: null };
      entry.count++;
      if (!entry.since || rec.meta.started_at < entry.since) entry.since = rec.meta.started_at;
      byReason.set(reason, entry);
    }
  }
  let top: DerivedIncident | null = null;
  for (const [reason, e] of byReason) {
    if (!top || e.count > top.count) top = { reason, count: e.count, since: e.since };
  }
  return top;
}
