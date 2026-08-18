/**
 * Severity ordering.
 *
 * The tier and the risk score are no longer computed here. Per ARCHITECTURE.md principle 3
 * they come from the assay itself — the agent declares `verdict`, `severity` and
 * `risk_score` in its response, and the report's headline is rendered from those. Nothing
 * re-derives them, so all this module owns is the *order*, which comparisons need and which
 * string sorting gets wrong ('critical' < 'minor' alphabetically).
 */

import { SEVERITY_RANK, type Severity, type Verdict } from '../../shared/types.js';

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
 * Parse a severity as the agent spells it — `Critical`, `Major`, `Minor`, `none`.
 *
 * The response contract is capitalised and the frontmatter is not, so exactly one place
 * should own the mapping. Anything unrecognised is `null`, never a silent `none`: a tier
 * we could not read is a parse failure, and the caller has to say so.
 */
export function parseSeverity(value: unknown): Severity | null {
  const key = String(value ?? '').trim().toLowerCase();
  return (SEVERITY_ORDER as readonly string[]).includes(key) ? (key as Severity) : null;
}

/** True when the verdict is one a subject earned, as opposed to one infra imposed. */
export function isSubjectVerdict(verdict: Verdict | null): boolean {
  return verdict === 'compliant' || verdict === 'non-compliant';
}
