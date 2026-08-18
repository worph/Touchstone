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

export const SEVERITY_RANK: Record<Severity, number> = {
  none: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

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

export interface ReportResponse {
  meta: AssayMeta;
  html: string;
  raw: string;
}
