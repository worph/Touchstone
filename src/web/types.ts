/**
 * View-model types local to the web stream. The wire contract lives in
 * `@shared/types` and is not modified here.
 */
import type { AssayRecord, Leg, Severity, SubjectState } from '@shared/types';

/** `GET /api/v1/subjects/:name` */
export interface SubjectDetail {
  subject: SubjectState;
  history: AssayRecord[];
  /**
   * Whether this app is flagged for re-audit — the scheduler's opinion, alongside the
   * hallmark rather than inside it.
   *
   * Deliberately not a field on `SubjectState`: the same reason `try_n` and the park are not
   * there either. That object is composed from assay frontmatter and is what `/public`
   * serves; a scheduling flag is neither a property of an assay nor anything an app author
   * should be reading. Absent when no scheduler is wired up, which is not the same as
   * `false` — the page then offers no control at all rather than one that cannot work.
   */
  flagged?: boolean;
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

/** Overview filter state, mirrored into the URL. */
export interface OverviewFilters {
  q: string;
  show: ShowFilter;
  leg: 'any' | Leg;
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
  | 'risk' | 'coverage' | 'name' | 'age' | 'static' | 'functional'
  | `notice:${string}`;
