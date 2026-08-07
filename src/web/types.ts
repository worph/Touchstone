/**
 * View-model types local to the web stream. The wire contract lives in
 * `@shared/types` and is not modified here.
 */
import type { AssayRecord, Finding, Leg, Severity, SubjectState } from '@shared/types';

/** How the data layer is currently being served. */
export type DataMode = 'api' | 'fixture';

/** `GET /api/v1/subjects/:name` */
export interface SubjectDetail {
  subject: SubjectState;
  history: AssayRecord[];
}

/**
 * `GET /api/v1/findings?status=unverified` is typed `Finding[]` in the contract,
 * but a bare `Finding` carries no subject, so the suspected-Critical queue would
 * be unrenderable. We read these fields when present and degrade without them.
 * See the note in the stream-C report.
 */
export interface UnverifiedFinding extends Finding {
  subject?: string;
  leg?: Leg;
  file?: string;
  since?: string;
  blocked_reason?: string | null;
}

/** What StatusCell and HistoryStrip render. Derived, never transported. */
export type StateKind =
  | 'ok'
  | 'fail'
  | 'blocked'
  | 'none'
  | 'running'
  | 'errored'
  | 'deferred'
  | 'unverified';

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

/** A finding as shown on subject detail, tagged with the leg it came from. */
export interface SubjectFinding extends Finding {
  leg: Leg;
  /** Index within the subject's merged finding list; used as a stable key. */
  key: string;
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
  | 'unverified'
  | 'running';

export type SortKey = 'risk' | 'name' | 'age' | 'static' | 'functional';
