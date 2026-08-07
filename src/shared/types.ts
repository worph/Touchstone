/**
 * The MVP-0 contract. Frozen — streams A, B and C all code against this file.
 * See MVP.md § Contracts.
 */

export type Leg = 'static' | 'functional';

/** Ordered: comparisons rely on SEVERITY_RANK, never on string order. */
export type Severity = 'none' | 'minor' | 'major' | 'critical';

export type Verdict = 'compliant' | 'non-compliant' | 'errored' | 'deferred';

/** `blocked` means infra prevented the assay. It is never a statement about the subject. */
export type AssayStatus = 'done' | 'blocked' | 'running';

export type FindingStatus = 'pass' | 'fail' | 'n-a' | 'advisory' | 'unverified';

export const SEVERITY_RANK: Record<Severity, number> = {
  none: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

/** risk = 100·Critical + 10·Major + 1·Minor, summed over failing findings. */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  none: 0,
  minor: 1,
  major: 10,
  critical: 100,
};

export interface Finding {
  /** Stable rule code where one exists: 'D1'..'D5', 'A', 'C', 'E8', 'E9', 'G'. */
  rule: string;
  title?: string;
  /** For `unverified` this is the *suspected* severity, not an observed one. */
  severity: Severity;
  status: FindingStatus;
  note?: string;
}

/** Exactly the YAML frontmatter of a report file. */
export interface AssayMeta {
  subject: string;
  leg: Leg;
  standard: string;
  standard_version: number;
  status: AssayStatus;
  verdict: Verdict | null;
  top_severity: Severity;
  risk_score: number;
  blocked_reason?: string | null;
  subject_ref?: string;
  commit?: string;
  images?: string[];
  started_at: string;
  finished_at: string;
  findings: Finding[];
  /** Unrecognised frontmatter keys, preserved verbatim across a read/write cycle. */
  [key: string]: unknown;
}

export interface AssayRecord {
  meta: AssayMeta;
  /** Path relative to the reports root, e.g. `OpenClaw/2026-08-05T09-14-22Z-static.md`. */
  path: string;
  subject: string;
  file: string;
}

/** One row of the Overview table. */
export interface SubjectState {
  name: string;
  static: AssayRecord | null;
  functional: AssayRecord | null;
  /** Sum of the two legs' latest risk scores. Overview sorts by this, descending. */
  risk: number;
  /** Age in days of the most recent assay of either leg; null if never assayed. */
  age_days: number | null;
}

/**
 * A finding plus where it was observed. The suspected-Critical queue is unrenderable
 * without this: a bare `Finding` cannot say which subjects are suspected, which is the
 * entire point of that view.
 */
export interface LocatedFinding extends Finding {
  subject: string;
  leg: Leg;
  /** `AssayRecord.path` — opens the report the finding came from. */
  path: string;
  /** Report file within the subject's folder, for deep-linking. */
  file: string;
  /** `finished_at` of the assay that observed it. Not every producer populates it. */
  since?: string;
}

/** One row of the Findings page, grouped by rule. */
export interface RuleGroup {
  /**
   * Grouping key is the triple `(rule, title, status)` — not `rule` alone. `rule` is
   * neither unique nor always present: uncoded findings share the placeholder `—`, and
   * one code legitimately appears with different statuses (E9 unverified on many
   * subjects, passing on others). Grouping on `rule` alone collapses unrelated rows.
   */
  rule: string;
  title: string;
  severity: Severity;
  status: FindingStatus;
  subjects: string[];
  /** The underlying findings, for the expander. */
  findings?: LocatedFinding[];
  /** Sum of weights across subjects. Parenthesised in the UI when status is `unverified`. */
  risk: number;
}

export interface ReportResponse {
  meta: AssayMeta;
  html: string;
  raw: string;
}
