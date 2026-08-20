/**
 * The MVP-0 contract. Frozen — streams A, B and C all code against this file.
 * See MVP.md § Contracts.
 */

/**
 * A **section** of the protocol — one leaf rubric, and one assay file.
 *
 * The id is the leaf protocol's own `id` (`data/protocols/<id>.md`), so the set of sections
 * is whatever the protocol directory declares. It used to be a two-value union called `Leg`
 * (`static | functional`) hard-coded here, which meant a third rubric could not exist and a
 * rename was a code change. Nothing in the server enumerates sections any more: they come
 * from the protocol files, and everything downstream carries the id it was given.
 *
 * The one rule that does not relax: **only a protocol file may define a section.** An id an
 * agent invents is recorded against the run's primary section and marked `unlisted` — it
 * never mints a new one, or a run could route a Critical into a section the gate ignores.
 */
export type Section = string;

/**
 * @deprecated The old name for {@link Section}, still used by the two-column Overview and by
 * report files written before the rename. New code says `section`.
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

export type RequirementVerdict = 'pass' | 'fail' | 'n-a' | 'unverified';

/** One requirement the agent settled and recorded while it worked. */
export interface RecordedRequirement {
  id: string;
  /**
   * The section that owns this requirement — the leaf protocol that listed the id.
   *
   * Resolved by the ledger from the canonical list, so a canonical id needs no help from the
   * agent. Only an `unlisted` id can carry a section the agent supplied, and only when that
   * section already exists.
   */
  section?: Section;
  /** The agent's own wording, kept as the evidence for the id it chose. */
  requirement?: string;
  verdict: RequirementVerdict;
  severity?: Severity;
  note?: string;
  /** The protocol does not list this id. Recorded anyway — that is how the list is corrected. */
  unlisted?: boolean;
  at: string;
  revisions?: number;
}

export interface RecordedPhase {
  phase: string;
  /** The section whose phase plan names this phase. */
  section?: Section;
  result: 'pass' | 'fail' | 'errored' | 'n-a';
  note?: string;
  at: string;
}

/**
 * How much of the checklist was actually checked — **not** whether the subject complies.
 *
 * The verdict is gated on severity: one Critical outranks fifteen passes, and no count can
 * express that. Reporting them as one number would be the mistake this type exists to avoid.
 */
export interface Coverage {
  /** pass + fail — the questions that got an answer. */
  verified: number;
  /** pass + fail + unverified — the questions that applied. */
  applicable: number;
  passed: number;
  failed: number;
  unverified: number;
  not_applicable: number;
  /** Summed from the declared items with the protocol's weights: 100·C + 10·M + 1·m. */
  risk: number;
}

/** Exactly the YAML frontmatter of a report file. */
export interface AssayMeta {
  subject: string;
  /** Which section of the protocol this assay is. `parseReportMeta` guarantees it. */
  section: Section;
  /** The pre-rename spelling of `section`, still on every file written before 2026-08-20. */
  leg?: Section;
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
  /** Present from 2026-08-19; absent on every assay imported before the runner existed. */
  coverage?: Coverage;
  requirements?: RecordedRequirement[];
  phases?: RecordedPhase[];
  /** Only when the agent's own risk_score disagreed with the sum of its items. */
  risk_score_declared?: number;
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
  /**
   * The current assay per section — every section the archive knows about, not a fixed two.
   * `static` and `functional` below are the same records under their old names, kept while
   * the Overview still draws exactly two columns.
   */
  sections: Record<Section, AssayRecord | null>;
  static: AssayRecord | null;
  functional: AssayRecord | null;
  /** Sum of every section's latest risk score. Overview sorts by this, descending. */
  risk: number;
  /** Age in days of the most recent assay of any section; null if never assayed. */
  age_days: number | null;
}

export interface ReportResponse {
  meta: AssayMeta;
  html: string;
  raw: string;
}
