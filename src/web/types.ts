/**
 * View-model types local to the web stream. The wire contract lives in
 * `@shared/types` and is not modified here.
 */
import type { AssayRecord, Section, Severity, SubjectState } from '@shared/types';

/** `GET /api/v1/subjects/:name` */
export interface SubjectDetail {
  subject: SubjectState;
  history: AssayRecord[];
  /**
   * Whether an audit of this app has been asked for and not yet answered — the scheduler's
   * opinion, alongside the hallmark rather than inside it.
   *
   * Deliberately not a field on `SubjectState`: the same reason `try_n` and the park are not
   * there either. That object is composed from assay frontmatter and is what `/public`
   * serves; a queue position is neither a property of an assay nor anything an app author
   * should be reading — a board addressed to app authors must not publish which of their
   * apps the operator has queued. Absent when no scheduler is wired up, which is not the same
   * as `false` — the page then offers no control at all rather than one that cannot work.
   */
  queued?: boolean;
  /** Its 1-based place in the request queue, when it is in one. */
  queue_position?: number;
  /**
   * The workshop's business with this app — a proposal in flight, an open pull request.
   * Operator-only, like `queued`, and for the same reason.
   */
  workshop?: { state: string; pr?: { number: number; url: string } };
  /** Whether the workshop could take a proposal at all. Absent: not wired. */
  workshop_ready?: boolean;
}

/** What StatusCell renders. Derived, never transported. */
export type StateKind = 'ok' | 'fail' | 'blocked' | 'none' | 'running' | 'errored' | 'deferred';

export interface DisplayState {
  kind: StateKind;
  /** Only meaningful for `fail`; drives the C / M / m mark. */
  severity: Severity;
  /** Always rendered. Meaning is never carried by colour alone. */
  label: string;
  /** The glyph inside the mark. Empty where the fill itself is the signal. */
  mark: string;
  /** Secondary text — a blocked reason, an elapsed time. */
  note?: string;
  /** Longer explanation, surfaced as a title attribute. */
  hint?: string;
}

/**
 * Which column a status filter is asking about — a section id, or every section this subject
 * has. Named `leg` on the wire and in the URL because that is what the query parameter has
 * always been called; identifiers are stable, vocabulary moved (CLAUDE.md).
 *
 * It was `'static' | 'functional'` until 2026-09-18, which made a platform's own column
 * unfilterable: the summary could offer the tally and the URL could not carry the answer.
 */
export type LegFilter = 'any' | Section;

/** Overview filter state, mirrored into the URL. */
export interface OverviewFilters {
  q: string;
  show: ShowFilter;
  leg: LegFilter;
  sort: SortKey;
  dir: 'asc' | 'desc';
}

export type ShowFilter =
  | 'all'
  | 'failing'
  | 'compliant'
  | 'blocked'
  | 'not-run'
  | 'stale'
  | 'running'
  /** The store no longer offers the app. Not a state of the audit — a state of the subject. */
  | 'delisted';

/**
 * `notice:<section>` sorts by a reading column — one exists per section in the archive that
 * measures rather than judges, so the key cannot be a closed list without a code change every
 * time a scripted check is added.
 */
export type SortKey =
  | 'risk' | 'coverage' | 'name' | 'age'
  /**
   * A verdict column, by section id — `section:functional`, `section:functional@foss`.
   *
   * Open-ended for the same reason `notice:` is, and now for a second: the set of verdict
   * columns is the set of sections in the archive, which grows with a rubric's platforms as
   * well as with the protocol directory. `'static' | 'functional'` were literals here until
   * 2026-09-18, which meant a third column could be drawn but never sorted.
   */
  | `section:${string}`
  | `notice:${string}`;
