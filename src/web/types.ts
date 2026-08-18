/**
 * View-model types local to the web stream. The wire contract lives in
 * `@shared/types` and is not modified here.
 */
import type { AssayRecord, Leg, Severity, SubjectState } from '@shared/types';

/** `GET /api/v1/subjects/:name` */
export interface SubjectDetail {
  subject: SubjectState;
  history: AssayRecord[];
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
  | 'running';

export type SortKey = 'risk' | 'name' | 'age' | 'static' | 'functional';
