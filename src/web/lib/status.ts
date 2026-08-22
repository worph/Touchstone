/**
 * Deriving what to *show* from an AssayRecord.
 *
 * The one rule this file exists to enforce: `blocked` and `errored` and
 * `not yet run` are three different unknowns, and none of them is a failure.
 * Nothing outside this module decides what an assay looks like.
 */
import type { AssayMeta, AssayRecord, Severity } from '@shared/types';
import { SEVERITY_RANK } from '@shared/types';
import type { DisplayState } from '../types';

export const SEVERITY_LABEL: Record<Severity, string> = {
  none: 'none',
  minor: 'Minor',
  major: 'Major',
  critical: 'Critical',
};

/** The mark inside a severity swatch. Letters, not hues. */
export const SEVERITY_MARK: Record<Severity, string> = {
  none: '✓',
  minor: 'm',
  major: 'M',
  critical: 'C',
};

export const SEVERITY_ORDER: Severity[] = ['critical', 'major', 'minor', 'none'];

export function worse(a: Severity, b: Severity): boolean {
  return SEVERITY_RANK[a] > SEVERITY_RANK[b];
}

/** `bench_unavailable` reads badly in a sentence; `bench unavailable` does not. */
export function humaniseReason(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined;
  return reason.replace(/[_-]+/g, ' ').trim();
}

const NOT_RUN: DisplayState = {
  kind: 'none',
  severity: 'none',
  label: 'not yet run',
  mark: '',
  hint: 'No assay of this leg has ever been recorded for this subject.',
};

/**
 * A leg being audited **right now**.
 *
 * There is no record to derive this from and there should not be: the runner writes a report
 * when it has one, and a placeholder file in the archive would be a record of an assay that
 * has not happened. So the in-flight run is overlaid at render time from `/assays/current`,
 * and this is the one state in the vocabulary that is not read off a file.
 *
 * @param startedAt  when the run began, for the `· 4m` note
 * @param note       overrides the elapsed time — `7/24` says more when there is a count
 */
export function runningState(startedAt: string, note?: string, now = Date.now()): DisplayState {
  return {
    kind: 'running',
    severity: 'none',
    label: 'running',
    mark: '◴',
    note: note ?? elapsed(startedAt, now),
    hint: `Started ${startedAt}. This section is in flight; the previous hallmark still stands.`,
  };
}

/**
 * The facts a status cell is derived from.
 *
 * `displayState` used to take an `AssayRecord`, which meant only something read out of the
 * archive could be drawn in the vocabulary. A trial's cell is the same five facts arriving by
 * a different route, and it was drawn by hand as a `.tag` instead — so `blocked` on the Trials
 * page looked nothing like `blocked` on the Overview, and the "Currently" column disagreed
 * with the very hallmark it was quoting.
 *
 * The optional half is optional because a caller may not have it, not because it is decorative:
 * absent, the hint says less and nothing else changes.
 */
export type StatusFacts = Pick<AssayMeta, 'status' | 'verdict' | 'top_severity' | 'risk_score'> &
  Partial<Pick<AssayMeta, 'blocked_reason' | 'standard' | 'standard_version' | 'started_at'>>;

/**
 * @param rec  the latest assay for one section, or null if it was never assayed
 * @param now  injected so the `running · 4m` label is testable
 */
export function displayState(rec: AssayRecord | null | undefined, now = Date.now()): DisplayState {
  if (!rec) return NOT_RUN;
  return displayFacts(rec.meta, now);
}

/**
 * The same derivation, from the facts alone.
 *
 * @param m    status, verdict and severity — from a report's frontmatter or from a trial cell
 * @param now  injected so the `running · 4m` label is testable
 */
export function displayFacts(m: StatusFacts | null | undefined, now = Date.now()): DisplayState {
  if (!m) return NOT_RUN;

  if (m.status === 'running') return runningState(m.started_at ?? '', undefined, now);

  if (m.status === 'blocked') {
    const reason = humaniseReason(m.blocked_reason);
    return {
      kind: 'blocked',
      severity: 'none',
      label: 'blocked',
      mark: '',
      note: reason,
      hint:
        `Infrastructure prevented this assay${reason ? ` (${reason})` : ''}. ` +
        'It is not a statement about the subject, and it consumed no retry budget.',
    };
  }

  switch (m.verdict) {
    case 'compliant':
      return {
        kind: 'ok',
        severity: 'none',
        label: 'compliant',
        mark: '✓',
        hint: m.standard
          ? `Assayed under ${m.standard} v${m.standard_version} and clean.`
          : 'Assayed and clean.',
      };
    case 'non-compliant':
      return {
        kind: 'fail',
        severity: m.top_severity,
        label: SEVERITY_LABEL[m.top_severity],
        mark: SEVERITY_MARK[m.top_severity],
        note: m.risk_score ? `risk ${m.risk_score}` : undefined,
        hint: `Checked and failing. Top severity ${SEVERITY_LABEL[m.top_severity]}, risk ${m.risk_score}.`,
      };
    case 'errored':
      return {
        kind: 'errored',
        severity: 'none',
        label: 'errored',
        mark: '!',
        hint: 'The assay itself failed to complete. No verdict was reached about the subject.',
      };
    case 'deferred':
      return {
        kind: 'deferred',
        severity: 'none',
        label: 'deferred',
        mark: '⏸',
        hint: 'Deliberately postponed.',
      };
    default:
      return {
        kind: 'none',
        severity: 'none',
        label: 'no verdict',
        mark: '',
        hint: 'The assay completed without recording a verdict.',
      };
  }
}

function elapsed(from: string, now: number): string {
  const ms = now - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
