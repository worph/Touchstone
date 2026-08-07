/**
 * Regression detection: what changed between an assay and the one before it, for the same
 * (subject, leg).
 *
 * MVP-0 emits no events anywhere — ARCHITECTURE.md §4 lists `event.kind` and the Activity
 * page is out of scope. The classifier exists now because the rule it encodes is the one
 * most easily got wrong, and because the history strip in UX.md §2.2 wants the marker.
 *
 * THE RULE THAT MATTERS: `errored` and `blocked` assays are excluded from the comparison
 * entirely. An infra failure must never read as a regression (ARCHITECTURE.md §2.4). That
 * cuts both ways:
 *   - a blocked or errored assay never *produces* an event;
 *   - and it is never used as the *baseline* either — the comparison skips back to the
 *     last assay that actually issued a verdict, so a bench outage in the middle of a
 *     history does not manufacture a "regression" on the next good run.
 */

import type { AssayRecord, Finding, Severity } from '../../shared/types.js';
import { byNewest, sortNewestFirst } from './hallmark.js';
import { compareSeverity, isFailing, severityRank, topSeverity } from './severity.js';

/** ARCHITECTURE.md §4, `event.kind`. */
export type EventKind =
  | 'verdict.critical'
  | 'verdict.regression'
  | 'verdict.compliant'
  | 'verdict.changed'
  | 'assay.finished';

export interface Regression {
  kind: EventKind;
  subject: string;
  leg: AssayRecord['meta']['leg'];
  assay: AssayRecord;
  /** The assay compared against; `null` for the first comparable assay of a leg. */
  previous: AssayRecord | null;
  from: Severity | null;
  to: Severity;
  /** Rule codes of Critical fails present now and absent from `previous`. */
  new_criticals: string[];
}

/**
 * An assay is comparable when it issued a verdict about the subject: `status: done` and a
 * verdict other than `errored`. `deferred` is excluded for the same reason — nothing was
 * judged.
 */
export function isComparable(record: AssayRecord): boolean {
  const { status, verdict } = record.meta;
  return status === 'done' && verdict !== 'errored' && verdict !== 'deferred';
}

/** Identity of a finding for set comparison: the rule code, or its title when uncoded. */
export function findingKey(finding: Finding): string {
  const rule = (finding.rule ?? '').trim();
  const title = (finding.title ?? '').trim().toLowerCase();
  return rule && rule !== '—' && rule !== '-' ? `rule:${rule}` : `title:${title}`;
}

function criticalFailKeys(record: AssayRecord | null): Set<string> {
  const out = new Set<string>();
  for (const f of record?.meta.findings ?? []) {
    if (isFailing(f) && f.severity === 'critical') out.add(findingKey(f));
  }
  return out;
}

/** Signature of the failing set: changes here are `verdict.changed` when the tier holds. */
function failSignature(record: AssayRecord | null): string {
  return (record?.meta.findings ?? [])
    .filter(isFailing)
    .map((f) => `${findingKey(f)}@${f.severity}`)
    .sort()
    .join('|');
}

/** The tier, computed from the findings; `meta.top_severity` is the fallback. */
export function tierOf(record: AssayRecord): Severity {
  const findings = record.meta.findings;
  if (Array.isArray(findings) && findings.length > 0) return topSeverity(findings);
  return record.meta.top_severity ?? 'none';
}

/**
 * The assay to compare against: the newest *comparable* assay of the same (subject, leg)
 * that is strictly older than `record`. Blocked, running and errored assays are stepped
 * over rather than treated as a baseline.
 */
export function previousComparable(
  record: AssayRecord,
  history: readonly AssayRecord[],
): AssayRecord | null {
  return (
    sortNewestFirst(
      history.filter(
        (r) =>
          r.path !== record.path &&
          r.subject === record.subject &&
          r.meta.leg === record.meta.leg &&
          isComparable(r) &&
          byNewest(r, record) > 0, // strictly older
      ),
    )[0] ?? null
  );
}

/**
 * Classify one assay against its predecessor. `null` means "no event": the assay was
 * blocked, running, errored or deferred, and says nothing about the subject.
 *
 * Precedence, loudest first:
 *   1. `verdict.critical`   — a Critical fail that the previous assay did not have.
 *   2. `verdict.regression` — the tier rose.
 *   3. `verdict.compliant`  — the tier reached 0 having been above it.
 *   4. `verdict.changed`    — same tier, different failing set.
 *   5. `assay.finished`     — it ran, nothing moved.
 */
export function classify(record: AssayRecord, previous: AssayRecord | null): Regression | null {
  if (!isComparable(record)) return null;

  // A blocked/errored predecessor is not a baseline; fall back to "first comparable".
  const base = previous && isComparable(previous) ? previous : null;

  const to = tierOf(record);
  const from = base ? tierOf(base) : null;
  const before = criticalFailKeys(base);
  const newCriticals = [...criticalFailKeys(record)].filter((k) => !before.has(k)).sort();

  const common = {
    subject: record.subject,
    leg: record.meta.leg,
    assay: record,
    previous: base,
    from,
    to,
    new_criticals: newCriticals.map((k) => k.replace(/^(rule|title):/, '')),
  };

  if (newCriticals.length > 0) return { kind: 'verdict.critical', ...common };
  if (from !== null && compareSeverity(to, from) > 0) return { kind: 'verdict.regression', ...common };
  if (severityRank(to) === 0 && from !== null && severityRank(from) > 0) {
    return { kind: 'verdict.compliant', ...common };
  }
  if (base && failSignature(record) !== failSignature(base)) {
    return { kind: 'verdict.changed', ...common };
  }
  return { kind: 'assay.finished', ...common };
}

/** Convenience: classify `record` against its own history. */
export function classifyAgainstHistory(
  record: AssayRecord,
  history: readonly AssayRecord[],
): Regression | null {
  return classify(record, previousComparable(record, history));
}

/**
 * Every event a history would have produced, newest first. Non-comparable assays drop out,
 * which is what keeps a bench outage out of the feed entirely.
 */
export function classifyHistory(history: readonly AssayRecord[]): Regression[] {
  return sortNewestFirst(history)
    .map((record) => classifyAgainstHistory(record, history))
    .filter((r): r is Regression => r !== null);
}
