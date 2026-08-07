/**
 * Severity ordering, risk score, and the verdict gates.
 *
 * ARCHITECTURE.md §4 "Verdict algebra":
 *   risk_score = 100·Critical + 10·Major + 1·Minor, summed over FAILING findings.
 *   The score ranks a backlog; the tier and the gates decide the verdict.
 *   Any Critical forces non-compliant; otherwise any fail sets the tier; an errored
 *   mandatory rule outranks both and can never yield `compliant`.
 */

import {
  SEVERITY_RANK,
  SEVERITY_WEIGHT,
  type Finding,
  type Severity,
  type Verdict,
} from '../../shared/types.js';

/** Ascending by rank. Never sort severities as strings. */
export const SEVERITY_ORDER: readonly Severity[] = ['none', 'minor', 'major', 'critical'];

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity] ?? 0;
}

/** `< 0` when `a` is less severe than `b`. Usable directly as a comparator. */
export function compareSeverity(a: Severity, b: Severity): number {
  return severityRank(a) - severityRank(b);
}

export function maxSeverity(severities: Iterable<Severity>): Severity {
  let worst: Severity = 'none';
  for (const s of severities) if (compareSeverity(s, worst) > 0) worst = s;
  return worst;
}

/**
 * Only `fail` counts against a subject.
 *
 * `unverified` is deliberately excluded: it is a *suspected* severity awaiting a bench
 * (ARCHITECTURE.md §4 "Why `unverified` is a first-class status"). Counting it would let
 * an infra gap read as a subject defect — the exact sin the model exists to avoid. The
 * Findings page surfaces it separately, with a parenthesised risk.
 */
export function isFailing(finding: Finding): boolean {
  return finding.status === 'fail';
}

export function failingFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter(isFailing);
}

/** 100·Critical + 10·Major + 1·Minor over failing findings only. */
export function riskScore(findings: readonly Finding[]): number {
  let total = 0;
  for (const f of findings) if (isFailing(f)) total += SEVERITY_WEIGHT[f.severity] ?? 0;
  return total;
}

/** The tier: the worst severity among failing findings. `none` when nothing fails. */
export function topSeverity(findings: readonly Finding[]): Severity {
  return maxSeverity(failingFindings(findings).map((f) => f.severity));
}

export interface GateOptions {
  /**
   * A mandatory rule could not be evaluated — the phase errored rather than passing or
   * failing (e.g. Prowlarr's E9). This is not expressible as a `FindingStatus`, so the
   * caller supplies it. Per ARCHITECTURE.md §4 it outranks the fail gates and can never
   * yield `compliant`; per the same section it is scoped to the leg it occurred in.
   */
  erroredMandatory?: boolean;
  /** Assay could not run at all. Yields `deferred`, and no verdict is implied. */
  deferred?: boolean;
}

export interface GateResult {
  verdict: Verdict;
  top_severity: Severity;
  risk_score: number;
}

/**
 * The gate precedence, in order:
 *   1. `deferred`          — nothing was judged.
 *   2. `erroredMandatory`  — outranks the fail gates; never `compliant`.
 *   3. any Critical fail   — `non-compliant`, tier `critical`.
 *   4. any other fail      — `non-compliant`, tier = worst failing severity.
 *   5. otherwise           — `compliant`, tier `none`.
 *
 * The tier is reported in every case, so an errored mandatory rule alongside a Critical
 * fail still surfaces `critical` — the verdict is `errored`, the severity is not lost.
 */
export function gate(findings: readonly Finding[], options: GateOptions = {}): GateResult {
  const tier = topSeverity(findings);
  const risk = riskScore(findings);

  if (options.deferred) return { verdict: 'deferred', top_severity: tier, risk_score: risk };
  if (options.erroredMandatory) return { verdict: 'errored', top_severity: tier, risk_score: risk };
  if (tier === 'none') return { verdict: 'compliant', top_severity: 'none', risk_score: risk };
  return { verdict: 'non-compliant', top_severity: tier, risk_score: risk };
}

/** True when the verdict is one a subject earned, as opposed to one infra imposed. */
export function isSubjectVerdict(verdict: Verdict | null): boolean {
  return verdict === 'compliant' || verdict === 'non-compliant';
}
