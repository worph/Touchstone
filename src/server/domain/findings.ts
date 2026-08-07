/**
 * The cross-subject findings view (UX.md §2.3).
 *
 * Computed over the current assay per (subject, leg) only — see `latestAssays`. The row
 * that justifies the page is `cpu_shares on reserved tier 10 → 5 subjects`: one rule, one
 * fix, five apps, a fact that today exists only as a sentence inside one report.
 */

import type { AssayRecord, Finding, FindingStatus, RuleGroup, Severity } from '../../shared/types.js';
import { SEVERITY_WEIGHT } from '../../shared/types.js';
import { latestAssays } from './hallmark.js';
import { compareSeverity, maxSeverity, severityRank } from './severity.js';

/**
 * A finding plus where it was observed. A bare `Finding` cannot be acted on.
 * The canonical definition lives in the shared contract; re-exported for callers here.
 */
export type { LocatedFinding } from '../../shared/types.js';
import type { LocatedFinding } from '../../shared/types.js';

const UNCODED = new Set(['', '-', '—', 'n/a', 'none']);

/** Uncoded findings ("—" in the mock) are identified by their title instead. */
export function isCoded(rule: string | undefined): boolean {
  return !UNCODED.has((rule ?? '').trim().toLowerCase());
}

function normaliseTitle(title: string | undefined): string {
  return (title ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Statuses that carry weight. `fail` is real risk; `unverified` is *potential* risk — the
 * suspected-Critical queue — which UX.md §2.3 renders parenthesised for exactly that
 * reason. `pass`, `n-a` and `advisory` weigh nothing.
 */
function weightOf(finding: Finding): number {
  if (finding.status !== 'fail' && finding.status !== 'unverified') return 0;
  return SEVERITY_WEIGHT[finding.severity] ?? 0;
}

/** Every finding of the current assays, tagged with its subject and leg. */
export function locatedFindings(records: readonly AssayRecord[]): LocatedFinding[] {
  const out: LocatedFinding[] = [];
  for (const record of latestAssays(records)) {
    for (const finding of record.meta.findings ?? []) {
      out.push({
        ...finding,
        subject: record.subject,
        leg: record.meta.leg,
        path: record.path,
        file: record.file,
      });
    }
  }
  return out;
}

/**
 * Group key. A rule is one row per *status*, because `RuleGroup` carries a single status
 * and severity: D1 passing on nine subjects and D1 failing on two are two different facts,
 * and collapsing them would produce a row that is true of neither. Uncoded findings are
 * grouped by title, which is what makes `cpu_shares on reserved tier 10` a row of its own
 * rather than part of an "everything without a rule code" heap.
 */
function groupKey(finding: Finding): string {
  const rule = (finding.rule ?? '').trim();
  const head = isCoded(rule) ? `rule:${rule}` : `title:${normaliseTitle(finding.title).toLowerCase()}`;
  return `${head}::${finding.status}`;
}

function commonestTitle(findings: readonly LocatedFinding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) {
    const title = normaliseTitle(f.title);
    if (!title) continue;
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [title, count] of counts) {
    if (count > bestCount) {
      best = title;
      bestCount = count;
    }
  }
  return best;
}

export interface RuleGroupDetail extends RuleGroup {
  /** The findings behind the row, for the expander in UX.md §2.3. */
  findings: LocatedFinding[];
}

/**
 * `GET /findings?group=rule`. Sorted the way the backlog is worked: severity descending,
 * then risk, then subject count, then rule code — so Criticals and the suspected-Critical
 * queue sit at the top and the one-liners fall to the bottom.
 */
export function groupByRule(records: readonly AssayRecord[]): RuleGroupDetail[] {
  const groups = new Map<string, LocatedFinding[]>();
  for (const finding of locatedFindings(records)) {
    const key = groupKey(finding);
    const bucket = groups.get(key);
    if (bucket) bucket.push(finding);
    else groups.set(key, [finding]);
  }

  const rows: RuleGroupDetail[] = [];
  for (const findings of groups.values()) {
    const first = findings[0];
    if (!first) continue;
    const rule = (first.rule ?? '').trim();
    const severity: Severity = maxSeverity(findings.map((f) => f.severity));
    rows.push({
      rule: isCoded(rule) ? rule : '',
      title: commonestTitle(findings) || (isCoded(rule) ? rule : 'untitled'),
      severity,
      status: first.status,
      subjects: [...new Set(findings.map((f) => f.subject))].sort((a, b) => a.localeCompare(b)),
      risk: findings.reduce((sum, f) => sum + weightOf(f), 0),
      findings,
    });
  }

  return rows.sort(
    (a, b) =>
      compareSeverity(b.severity, a.severity) ||
      b.risk - a.risk ||
      b.subjects.length - a.subjects.length ||
      a.rule.localeCompare(b.rule) ||
      a.title.localeCompare(b.title),
  );
}

/**
 * `GET /findings?status=unverified` — the suspected-Critical queue: what to drain the
 * moment the bench pool comes back. Worst suspected severity first.
 */
export function findingsByStatus(
  records: readonly AssayRecord[],
  status: FindingStatus,
): LocatedFinding[] {
  return locatedFindings(records)
    .filter((f) => f.status === status)
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        a.subject.localeCompare(b.subject) ||
        (a.rule ?? '').localeCompare(b.rule ?? ''),
    );
}
